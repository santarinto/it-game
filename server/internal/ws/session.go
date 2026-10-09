package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// Handler держит сессии по sid: браузерное подключение (/ws) запускает
// актор-цикл, WS-мост агента (/ws/agent, ITGAME-29) цепляется к живому
// или поднимает headless-сессию. С Saves != nil игра получает сейвы:
// переподключение с тем же sid в течение TTL восстанавливает прогресс
// (мягкий деплой, ITGAME-8).
type Handler struct {
	Config       game.Config
	TickInterval time.Duration
	Saves        *store.Store // nil — stateless-режим без сейвов (старые тесты)

	// Реестр живых сессий (ITGAME-26/29): sid → актор с его каналами.
	// Регистрирует сам актор, выписывается на выходе; агентские коннекты
	// цепляются к найденной сессии без её отбирания.
	debugMu sync.Mutex
	live    map[string]*session
}

// session — живая сессия: актор плюс его каналы. Создаётся ДО запуска
// актора (ITGAME-29): читатели (вкладка, агентские мосты) начинают слать
// команды сразу, без гонки с регистрацией.
type session struct {
	debugC   chan debugRequest
	commands chan clientCommand
	hub      *connHub
}

// connHub — широковещатель сессии: снапшоты и отчёты получают ВСЕ
// соединения (вкладка браузера, агентские мосты). Записи сериализуются
// mu: актор рассылает снапшоты, агентские readLoop-ы отвечают на свои
// команды — два писателя в один сокет запрещены протоколом WS.
type connHub struct {
	mu    sync.Mutex
	conns map[*websocket.Conn]struct{}
}

func newConnHub() *connHub { return &connHub{conns: map[*websocket.Conn]struct{}{}} }

func (hb *connHub) add(c *websocket.Conn) {
	hb.mu.Lock()
	hb.conns[c] = struct{}{}
	hb.mu.Unlock()
}

func (hb *connHub) remove(c *websocket.Conn) {
	hb.mu.Lock()
	delete(hb.conns, c)
	hb.mu.Unlock()
}

func (hb *connHub) count() int {
	hb.mu.Lock()
	defer hb.mu.Unlock()
	return len(hb.conns)
}

// write — отправить сообщение всем соединениям под одним локом
// (порядок сообщений в каждом сокете един). Мёртвые отсоединяются.
func (hb *connHub) write(ctx context.Context, msg any) {
	hb.mu.Lock()
	defer hb.mu.Unlock()
	var dead []*websocket.Conn
	for c := range hb.conns {
		if wsjson.Write(ctx, c, msg) != nil {
			dead = append(dead, c)
		}
	}
	for _, c := range dead {
		delete(hb.conns, c)
	}
}

// writeTo — адресное сообщение (ответ агенту на его команду); тоже под
// mu, иначе гонка с параллельным снапшотом актора.
func (hb *connHub) writeTo(ctx context.Context, to *websocket.Conn, msg any) {
	hb.mu.Lock()
	defer hb.mu.Unlock()
	if _, live := hb.conns[to]; !live {
		return
	}
	if wsjson.Write(ctx, to, msg) != nil {
		delete(hb.conns, to)
	}
}

// closeAll — конец сессии: разорвать все соединения одной причиной.
// session_taken важнее вежливого кода — получатель не должен реконнектиться.
func (hb *connHub) closeAll(evicted bool) {
	hb.mu.Lock()
	conns := make([]*websocket.Conn, 0, len(hb.conns))
	for c := range hb.conns {
		conns = append(conns, c)
	}
	hb.conns = map[*websocket.Conn]struct{}{}
	hb.mu.Unlock()
	for _, c := range conns {
		if evicted {
			c.Close(websocket.StatusPolicyViolation, "session_taken")
		} else {
			c.Close(websocket.StatusNormalClosure, "сессия завершена")
		}
	}
}

// clientCommand — команда игрока с адресатом-офисом.
type clientCommand struct {
	Cmd    game.Command
	Office int
	Slot   int             // стойка для upgrade_server
	Speed  int             // параметр set_speed
	SID    string          // адресат abandon
	From   *websocket.Conn // источник (ITGAME-29): для адресных ответов агенту
}

// cmdSetSpeed — команда сессии, не игры: меняет темп реального времени,
// игровое состояние не трогает, поэтому живёт в ws, а не в game.
const cmdSetSpeed = game.Command("set_speed")

// cmdAbandon — «сдаться»: удалить сейв и завершить сессию.
const cmdAbandon = game.Command("abandon")

// sessionSave — содержимое сейва сессии: игра плюс параметры сессии.
type sessionSave struct {
	SID        string          `json:"sid"`
	Speed      int             `json:"speed"`
	SavedAt    time.Time       `json:"savedAt"`
	Game       game.Save       `json:"game"`
	LastReport *game.DayReport `json:"lastReport"` // отчёт для ресенда в фазе day_report
	Scenario   string          `json:"scenario"`   // фикстура старта (ITGAME-26)
	Events     []string        `json:"events"`     // журнал событий сессии (ITGAME-26)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Vite dev server проксирует /ws с другого порта; itgame — прод за nginx.
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*", "itgame.santarinto.com"},
	})
	if err != nil {
		return
	}
	defer c.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	commands := make(chan clientCommand)
	hub := newConnHub()
	hub.add(c)
	go readLoop(ctx, cancel, c, commands)
	sess := &session{
		debugC:   make(chan debugRequest, 8),
		commands: commands,
		hub:      hub,
	}

	// Сложность применяется ТОЛЬКО при непустом query-параметре: иначе
	// кастомные тестовые конфиги (например WinTarget) затирались бы нормой.
	// При восстановлении сейва сложность игнорируется — конфиг в сейве.
	cfg := h.Config
	if q := r.URL.Query().Get("difficulty"); q != "" {
		cfg = game.ApplyDifficulty(h.Config, game.ParseDifficulty(q))
	}
	sid := r.URL.Query().Get("sid")

	// Отладочные параметры (ITGAME-26): ?seed= задаёт сид НОВОЙ партии
	// (у сейва сид свой), ?scenario= стартует её в состоянии фикстуры.
	// Действуют только когда сейва нет: переподключение к живой партии
	// параметры игнорирует, иначе прогресс терялся бы на каждом реконнекте.
	opts := sessionOpts{
		Seed:     r.URL.Query().Get("seed"),
		Scenario: r.URL.Query().Get("scenario"),
	}

	// Политика занятости (ITGAME-29): игрок всегда запускает свой актор —
	// Begin() в run() отбирает сессию у headless-актора агента, его мосты
	// закрываются с session_taken и переподключаются уже как наблюдатели.
	evicted := h.run(ctx, sess, cfg, sid, opts)
	hub.closeAll(evicted)
}

// readLoop — единственный читатель соединения: превращает входящие
// сообщения в команды для актора.
func readLoop(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn, commands chan<- clientCommand) {
	defer cancel() // разрыв соединения останавливает актор
	for {
		var msg clientMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			return
		}
		select {
		case commands <- clientCommand{Cmd: game.Command(msg.Type), Office: msg.Office, Slot: msg.Slot, Speed: msg.Speed, From: c}:
		case <-ctx.Done():
			return
		}
	}
}

// sessionOpts — отладочные параметры подключения (ITGAME-26).
type sessionOpts struct {
	Seed     string // ?seed=1234: сид новой партии; пусто — случайный
	Scenario string // ?scenario=soft_lock: фиксура старта новой партии
}

// persist — записать сейв сессии. false — сессию забрал другой актор.
func (h *Handler) persist(sid string, gen uint64, g *game.Game, speed int, last *game.DayReport, scenario string, events []string) bool {
	at := time.Now()
	data, err := json.Marshal(sessionSave{
		SID: sid, Speed: speed, SavedAt: at, Game: g.Export(), LastReport: last,
		Scenario: scenario, Events: events,
	})
	if err != nil {
		// сериализация падает только на баге — игру не рвём
		return true
	}
	return h.Saves.Put(sid, gen, data, at)
}

// offlineTicks — сколько игровых тиков прошло с момента сейва: темп
// сессии (1–3x) сжимает реальное время тика, пауза (0) замораживает мир.
func offlineTicks(savedAt time.Time, speed int, interval time.Duration) int {
	if speed <= 0 {
		return 0
	}
	perTick := interval / time.Duration(min(speed, 3))
	if perTick <= 0 {
		return 0
	}
	return int(time.Since(savedAt) / perTick)
}

// run — актор: единственная горутина, владеющая состоянием игры.
// Всё общение с миром — через каналы готовой сессии и тикер; в сокеты
// пишет только актор (через hub — всем соединениям сессии), мьютексов
// на игровом состоянии нет. Возвращает true, если сессию забрал другой
// актор (eviction).
func (h *Handler) run(ctx context.Context, sess *session, cfg game.Config, sid string, opts sessionOpts) bool {
	commands := sess.commands
	hub := sess.hub
	// ── Старт: восстановление или новая игра ────────────────────────────
	var (
		g          *game.Game
		lastReport *game.DayReport
		offline    *game.OfflineSummary
		speed      = 1
		resumed    bool
		gen        uint64
		kick       <-chan struct{}
		journal    = newEventJournal(500)
		scenario   string // применённая фиксура (только новой партии)
	)
	withSaves := h.Saves != nil && store.ValidSID(sid)
	if withSaves {
		g, speed, lastReport, offline, resumed, scenario, journal = h.resume(sid)
		// владение сессией (+пинок старому актору)
		gen, kick = h.Saves.Begin(sid)
		if resumed {
			if g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon {
				// Офлайн привёл к финалу: сейв не нужен, доигрывают без него.
				// Finish, не Delete: своё удаление — не захват (ITGAME-51).
				h.Saves.Finish(sid, gen)
			} else if !h.persist(sid, gen, g, speed, lastReport, scenario, journal.last(journal.cap)) {
				// нас обогнали между Load и Begin
				return true
			}
		}
	}
	if g == nil {
		switch {
		case opts.Scenario != "":
			// Неизвестный сценарий — шумим в лог и стартуем обычную
			// партию: реконнект-цикл клиента хуже тихого отката.
			fg, err := game.NewFixture(cfg, opts.Scenario, opts.Seed)
			if err != nil {
				log.Printf("сессия %s: %v — стартую обычную партию", sid, err)
				g = newGame(cfg, opts.Seed)
			} else {
				g, scenario = fg, opts.Scenario
			}
		default:
			g = newGame(cfg, opts.Seed)
		}
		if withSaves && !h.persist(sid, gen, g, speed, lastReport, scenario, journal.last(journal.cap)) {
			return true
		}
	}

	ticker := time.NewTicker(h.TickInterval)
	defer ticker.Stop()
	// На паузе tickC = nil: select по nil-каналу не срабатывает,
	// фаза игры и команды покупок при этом живут.
	tickC := ticker.C
	if speed == 0 {
		tickC = nil
	} else {
		ticker.Reset(h.TickInterval / time.Duration(speed))
	}

	// Живая сессия в реестре (ITGAME-26/29): /api/debug/* и агентский
	// мост находят актор по sid и цепляются к его каналам.
	h.registerSession(sid, sess)
	defer h.unregisterSession(sid, sess)
	debugC := sess.debugC

	hub.write(ctx, snapshot(g, speed, resumed, scenario))
	// Отчёт «пока вас не было»: только когда было что симулировать
	// (прошёл день / финал). Короткий разрыв (деплой) — тихий resume.
	if resumed && offline != nil && (offline.Days > 0 || offline.GameOver || offline.Victory) {
		hub.write(ctx, offlineReportMessage{
			Type: "offline_report", Ticks: offline.Ticks, Days: offline.Days,
			Income: offline.Income, Payroll: offline.Payroll, Balance: offline.Balance,
			GameOver: offline.GameOver, Victory: offline.Victory, Reason: offline.Reason,
		})
	}
	// Разрыв в фазе отчёта дня: игрок не увидел отчёт — дошлём из сейва.
	if resumed && g.Phase == game.PhaseDayReport && lastReport != nil {
		hub.write(ctx, dayReportMsg(lastReport))
	}

	for {
		select {
		case <-kick:
			return true
		case req := <-debugC:
			if h.applyDebug(ctx, hub, req, sid, gen, withSaves,
				&g, &speed, &lastReport, journal, &scenario) {
				return true
			}
		case cmd := <-commands:
			if cmd.Cmd == cmdAbandon {
				if withSaves {
					h.Saves.Delete(sid)
				}
				return false
			}
			var out any
			mutated := false
			if cmd.Cmd == cmdSetSpeed {
				if cmd.Speed < 0 || cmd.Speed > 3 {
					out = errorMessage{Type: "error", Code: "bad_speed"}
				} else {
					speed = cmd.Speed
					// Stop/Reset не чистят буфер тикера: застрявший тик выстрелил бы
					// мгновенно после смены темпа или снятия паузы.
					ticker.Stop()
					select {
					case <-ticker.C:
					default:
					}
					if speed == 0 {
						tickC = nil
					} else {
						ticker.Reset(h.TickInterval / time.Duration(speed))
						tickC = ticker.C
					}
					out = snapshot(g, speed, false, scenario)
					mutated = true
				}
			} else if err := g.Apply(cmd.Cmd, cmd.Office, cmd.Slot); err != nil {
				out = errorMessage{Type: "error", Code: err.Error()}
			} else {
				out = snapshot(g, speed, false, scenario)
				mutated = true
			}
			// Успешная команда — точка сейва: покупки и переходы дней
			// не должны теряться даже при жёстком kill -9. Финальная партия
			// сейва не держит: после финала сессия жива до «В меню»
			// (ITGAME-51), и set_speed не должен воскресить её сейв.
			if mutated && withSaves {
				if g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon {
					h.Saves.Finish(sid, gen)
				} else if !h.persist(sid, gen, g, speed, lastReport, scenario, journal.last(journal.cap)) {
					return true
				}
			}
			// Ошибки — только отправителю (его промах, не общее событие),
			// успешные снапшоты — всем соединениям сессии.
			if _, isErr := out.(errorMessage); isErr {
				if cmd.From != nil {
					hub.writeTo(ctx, cmd.From, out)
				}
			} else {
				hub.write(ctx, out)
			}
		case <-tickC:
			wasRunning := g.Phase == game.PhaseRunning
			report := g.Tick()
			if report != nil {
				lastReport = report
				journal.addReport(report)
			}
			if wasRunning && g.Phase == game.PhaseGameOver {
				journal.add(fmt.Sprintf("д%d · партия проиграна: %s", g.Day, g.LoseReason))
			}
			// Сейв/удаление ДО записи в сокет: клиент, прочитавший сообщение,
			// может реконнектнуться быстрее, чем сейв дотянется до стора —
			// тогда рестарт забрал бы устаревшее состояние.
			if withSaves {
				if wasRunning && (g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon) {
					// финал: сейв больше не нужен; Finish, не Delete — своё
					// удаление не захват, вкладка живёт до «В меню» (ITGAME-51)
					h.Saves.Finish(sid, gen)
				} else if g.Phase != game.PhaseGameOver && g.Phase != game.PhaseWon {
					if !h.persist(sid, gen, g, speed, lastReport, scenario, journal.last(journal.cap)) {
						return true
					}
				}
			}
			if wasRunning && g.Phase == game.PhaseWon {
				journal.add(fmt.Sprintf("д%d · цель достигнута: победа", g.Day))
				hub.write(ctx, snapshot(g, speed, false, scenario))
				hub.write(ctx, victoryMessage{Type: "victory",
					Difficulty: string(g.Config().Difficulty), Day: g.Day, Balance: g.Money})
				continue
			}
			if wasRunning && g.Phase == game.PhaseGameOver {
				hub.write(ctx, snapshot(g, speed, false, scenario))
				hub.write(ctx, gameOverMessage{Type: "game_over", DaysSurvived: g.Day,
					PeakIncomePerTick: g.PeakIncomePerTick, Balance: g.Money, Reason: g.LoseReason})
				continue
			}
			// На паузе фазы (отчёт/банкротство) тик — no-op: не шлём одинаковые
			// снапшоты каждую секунду, клиент ждёт команду игрока.
			if report == nil && g.Phase != game.PhaseRunning {
				continue
			}
			hub.write(ctx, snapshot(g, speed, false, scenario))
			if report != nil {
				hub.write(ctx, dayReportMsg(report))
			}
		case <-ctx.Done():
			return false
		}
	}
}

// resume — восстановить игру из сейва (если есть и валиден). Невалидный
// или терминальный сейв удаляется — сессия начнётся заново.
func (h *Handler) resume(sid string) (g *game.Game, speed int, last *game.DayReport, offline *game.OfflineSummary, ok bool, scenario string, journal *eventJournal) {
	journal = newEventJournal(500) // даже без сейва журнал валиден
	raw, found := h.Saves.Load(sid)
	if !found {
		return nil, 1, nil, nil, false, "", journal
	}
	var ss sessionSave
	if json.Unmarshal(raw, &ss) != nil || ss.SID != sid {
		h.Saves.Delete(sid)
		return nil, 1, nil, nil, false, "", journal
	}
	g, err := game.Restore(ss.Game)
	if err != nil {
		h.Saves.Delete(sid)
		return nil, 1, nil, nil, false, "", journal
	}
	speed = min(max(ss.Speed, 0), 3)
	offline = g.AdvanceOffline(offlineTicks(ss.SavedAt, speed, h.TickInterval))
	if offline != nil && offline.Ticks > 0 {
		journal.add(fmt.Sprintf("офлайн-догон: %d тиков, %d дней, баланс $%d",
			offline.Ticks, offline.Days, offline.Balance))
	}
	for _, ev := range ss.Events {
		journal.add(ev)
	}
	return g, speed, ss.LastReport, offline, true, ss.Scenario, journal
}

// newGame — новая партия: ?seed= задаёт сид, иначе случайный. Битая строка
// сида тихо игнорируется (game.ParseSeed), чтобы не рвать подключение.
func newGame(cfg game.Config, seedStr string) *game.Game {
	if seed, ok := game.ParseSeed(seedStr); ok {
		return game.NewSeeded(cfg, seed)
	}
	return game.New(cfg)
}

func dayReportMsg(r *game.DayReport) dayReportMessage {
	// Не nil: nil-срез маршалится в JSON null, а клиент ждёт массив.
	events := r.Events
	if events == nil {
		events = []string{}
	}
	return dayReportMessage{Type: "day_report", Day: r.Day, Income: r.Income, Payroll: r.Payroll,
		GatewayOpex: r.GatewayOpex, Profit: r.Profit, Balance: r.Balance,
		Incidents: r.Incidents, LostIncome: r.LostIncome, Events: events}
}
