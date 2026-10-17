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
	// ReadTimeout — таймаут чтения вкладки (ITGAME-76, liveness.go): клиент
	// молчит дольше (ни сообщения, ни pong) — сервер считает его ушедшим.
	// 0 — DefaultReadTimeout.
	ReadTimeout time.Duration
	// Journal — журнал партии для реплея (ITGAME-46): включает ITGAME_DEBUG=1.
	Journal bool

	// Реестр живых сессий (ITGAME-26/29): sid → актор с его каналами.
	// Регистрирует сам актор, выписывается на выходе; агентские коннекты
	// цепляются к найденной сессии без её отбирания.
	debugMu       sync.Mutex
	live          map[string]*session
	journals      *journalStore // лениво, под debugMu (journal.go)
	journalLimits journalLimits // нули — умолчания; тесты кольца ставят малые

	// afterLoad — тестовый крючок: сейв сессии прочитан (resume), актор ещё
	// не начал партию. nil в проде. Тест вытеснения (ITGAME-46) пускает в
	// это окно команду прежнего актора.
	afterLoad func(sid string)
}

// session — живая сессия: актор плюс его каналы. Создаётся ДО запуска
// актора (ITGAME-29): читатели (вкладка, агентские мосты) начинают слать
// команды сразу, без гонки с регистрацией.
type session struct {
	debugC   chan debugRequest
	commands chan clientCommand
	hub      *connHub
	tab      *tabConn // соединение вкладки (ITGAME-76: debug-обрыв); nil — headless-сессия агента
	// owner — соединение, ради которого запущен актор (вкладка или мост агента
	// headless-сессии), ownerSrc — его источник: журнал партии (ITGAME-91)
	// даёт ему номер соединения в записи start/resume.
	owner    *websocket.Conn
	ownerSrc string
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
	hb.writeEach(ctx, func(*websocket.Conn) any { return msg })
}

// writeReply — снапшот, порождённый командой (ITGAME-45): всем один и тот же
// state (тот же rev), отправителю — с re = id его команды. Адресно, а не
// общим полем: id у вкладки и агента независимы и могут совпасть.
func (hb *connHub) writeReply(ctx context.Context, msg stateMessage, from *websocket.Conn, id int64) {
	hb.writeEach(ctx, func(c *websocket.Conn) any {
		if c == from && id != 0 {
			m := msg
			m.Re = id
			return m
		}
		return msg
	})
}

func (hb *connHub) writeEach(ctx context.Context, msgFor func(*websocket.Conn) any) {
	hb.mu.Lock()
	defer hb.mu.Unlock()
	var dead []*websocket.Conn
	for c := range hb.conns {
		if wsjson.Write(ctx, c, msgFor(c)) != nil {
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
	Speed  int             // параметр set_speed; у exit — скорость возврата
	SID    string          // адресат abandon
	From   *websocket.Conn // источник (ITGAME-29): для адресных ответов агенту
	ID     int64           // id команды от клиента (ITGAME-45): re в ответе; 0 — без id
	Src    string          // откуда пришла (ITGAME-91, журнал партии): srcTab | srcBridge
}

// Источник команды в журнале партии (ITGAME-91): id — счётчик страницы
// вкладки или свой у моста агента, сам по себе в партии не уникален.
const (
	srcTab    = "tab"    // /ws — вкладка браузера
	srcBridge = "bridge" // /ws/agent — мост агента (наблюдатель или headless)
)

// revClock — версия состояния сессии (ITGAME-45). bump — ДО сейва: в сейв
// попадает rev снапшота, который за ним разошлётся, и resume продолжит
// строго выше всего, что видели клиенты.
type revClock struct {
	rev   uint64
	cause stateCause
}

func (v *revClock) bump(cause stateCause) {
	v.rev++
	v.cause = cause
}

// stamp — проставить снапшоту текущие rev и cause.
func (v *revClock) stamp(s stateMessage) stateMessage {
	s.Rev, s.Cause = v.rev, v.cause
	return s
}

// cmdSetSpeed — команда сессии, не игры: меняет темп реального времени,
// игровое состояние не трогает, поэтому живёт в ws, а не в game.
const cmdSetSpeed = game.Command("set_speed")

// cmdAbandon — «сдаться»: удалить сейв и завершить сессию.
const cmdAbandon = game.Command("abandon")

// cmdExit — явный выход в меню (ITGAME-65): партия замирает (speed 0, сейв без
// офлайн-догона), Speed команды — скорость, на которой её вернёт «Продолжить».
const cmdExit = game.Command("exit")

// sessionSave — содержимое сейва сессии: игра плюс параметры сессии.
type sessionSave struct {
	SID   string `json:"sid"`
	Speed int    `json:"speed"`
	// ResumeSpeed — явный выход (ITGAME-65): скорость для «Продолжить»; сам сейв на паузе.
	ResumeSpeed int             `json:"resumeSpeed,omitempty"`
	SavedAt     time.Time       `json:"savedAt"`
	Game        game.Save       `json:"game"`
	LastReport  *game.DayReport `json:"lastReport"`    // отчёт для ресенда в фазе day_report
	Scenario    string          `json:"scenario"`      // фикстура старта (ITGAME-26)
	Events      []string        `json:"events"`        // журнал событий сессии (ITGAME-26)
	Rev         uint64          `json:"rev,omitempty"` // версия состояния (ITGAME-45); 0 — сейв до неё
	// Version — версия сборки, писавшей сейв (ITGAME-140); "" — сейв до неё или сервер без версии.
	Version string `json:"version,omitempty"`
}

// staleSave — сейв написан другой сборкой (ITGAME-140, решение владельца 17.10): сверяется
// версия сборки, а не формат сейва, так что любой деплой (git push stand main, зелёный main)
// начинает партии заново. Сервер без версии (go run, go test) не сверяет.
func staleSave(ss sessionSave) bool {
	cur := BuildVersion()
	return cur != "" && ss.Version != cur
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

	// Сводка сейва для меню (ITGAME-19): без актора и без захвата сессии.
	if r.URL.Query().Get("peek") == "1" {
		h.servePeek(r.Context(), c, r.URL.Query().Get("sid"))
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	commands := make(chan clientCommand)
	hub := newConnHub()
	hub.add(c)
	tab := newTabConn(c, h.readTimeout())
	go readLoop(ctx, cancel, c, commands, tab)
	sess := &session{
		debugC:   make(chan debugRequest, 8),
		commands: commands,
		hub:      hub,
		tab:      tab,
		owner:    c,
		ownerSrc: srcTab,
	}

	// Сложность применяется ТОЛЬКО при непустом query-параметре: иначе
	// кастомные тестовые конфиги (например WinTarget) затирались бы нормой.
	// При восстановлении сейва сложность игнорируется — конфиг в сейве.
	cfg := h.Config
	if q := r.URL.Query().Get("difficulty"); q != "" {
		cfg = game.ApplyDifficulty(h.Config, game.ParseDifficulty(q))
	}
	sid := r.URL.Query().Get("sid")
	// Сторож таймаута чтения (ITGAME-76): молчание дольше ReadTimeout — уход.
	go tab.watch(ctx, cancel, sid)

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
// сообщения в команды для актора. Он же читает pong-и сторожа (liveness.go):
// Read обрабатывает управляющие кадры. После debug-обрыва (ITGAME-76)
// входящее выбрасывается: сервер клиента «не слышит».
func readLoop(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn, commands chan<- clientCommand, tab *tabConn) {
	defer cancel() // разрыв соединения останавливает актор
	for {
		var msg clientMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			return
		}
		if tab.isDropped() {
			continue
		}
		tab.hear()
		select {
		case commands <- clientCommand{Cmd: game.Command(msg.Type), Office: msg.Office, Slot: msg.Slot, Speed: msg.Speed, From: c, ID: msg.ID, Src: srcTab}:
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
func (h *Handler) persist(sid string, gen uint64, g *game.Game, speed, resumeSpeed int, last *game.DayReport, scenario string, events []string, rev uint64) bool {
	at := time.Now()
	data, err := json.Marshal(sessionSave{
		SID: sid, Speed: speed, ResumeSpeed: resumeSpeed, SavedAt: at, Game: g.Export(), LastReport: last,
		Scenario: scenario, Events: events, Rev: rev, Version: BuildVersion(),
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
func (h *Handler) run(ctx context.Context, sess *session, cfg game.Config, sid string, opts sessionOpts) (evicted bool) {
	commands := sess.commands
	hub := sess.hub
	// ── Старт: восстановление или новая игра ────────────────────────────
	var (
		g           *game.Game
		lastReport  *game.DayReport
		offline     *game.OfflineSummary
		speed       = 1
		resumed     bool
		gen         uint64
		kick        <-chan struct{}
		journal     = newEventJournal(500)
		scenario    string        // применённая фиксура (только новой партии)
		resumeSpeed int           // скорость возврата после exit; 0 — нет
		savedAt     time.Time     // время последнего сейва — для offline_report.savedAt
		rv          = &revClock{} // версия состояния (ITGAME-45)
	)
	withSaves := h.Saves != nil && store.ValidSID(sid)
	var rt *resumeTrace // журнал партии (ITGAME-46): сейв до офлайн-догона
	if h.Journal {
		rt = &resumeTrace{}
	}
	if withSaves {
		// Владение — ДО чтения сейва (ITGAME-46): Begin пинает прежнего
		// актора, его следующий Put не пройдёт, и Load ниже отдаёт последнее,
		// что он сохранил и успел подтвердить. Раньше Load шёл первым, и
		// тики/команды прежнего актора в окне Load→Begin сохранялись, уходили
		// его вкладке — и пропадали в поднятой партии.
		gen, kick = h.Saves.Begin(sid)
		g, speed, lastReport, offline, resumed, scenario, journal, savedAt, rv.rev = h.resume(sid, gen, rt)
		if h.afterLoad != nil {
			h.afterLoad(sid)
		}
	}
	// Первый снапшот сессии: start — новая партия, resume — из сейва.
	if resumed {
		rv.bump(causeResume)
	} else {
		rv.bump(causeStart)
	}
	if withSaves {
		if resumed {
			if g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon {
				// Офлайн привёл к финалу: сейв не нужен, доигрывают без него.
				// Finish, не Delete: своё удаление — не захват (ITGAME-51).
				h.Saves.Finish(sid, gen)
			} else if !h.persist(sid, gen, g, speed, 0, lastReport, scenario, journal.last(journal.cap), rv.rev) {
				// сессию уже забрал следующий актор
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
		if withSaves && !h.persist(sid, gen, g, speed, 0, lastReport, scenario, journal.last(journal.cap), rv.rev) {
			return true
		}
	}

	jn := h.openJournal(sid, &g, &speed, &resumeSpeed, &scenario, rv, resumed, rt, sess.owner, sess.ownerSrc)
	defer func() { jn.end(evicted, sess.tab.goneWhy()) }()

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
	// setTempo — темп актора: 0 глушит тикер (tickC = nil), 1..3 — интервал/темп.
	// Stop/Reset не чистят буфер тикера: застрявший тик выстрелил бы мгновенно
	// после смены темпа или снятия паузы.
	setTempo := func(n int) {
		speed = n
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
	}

	// Живая сессия в реестре (ITGAME-26/29): /api/debug/* и агентский
	// мост находят актор по sid и цепляются к его каналам.
	h.registerSession(sid, sess)
	defer h.unregisterSession(sid, sess)
	debugC := sess.debugC

	// Отчёт «пока вас не было»: всегда, когда догон что-то промотал. Окно
	// клиент показывает только при смене дня или финале — короткий разрыв
	// (деплой) остаётся тихим для игрока, но отладка видит, что догон был
	// (приёмка ITGAME-65, 10.10: «часы ушли, окна нет» выводилось косвенно).
	sendOffline := resumed && offline != nil && (offline.Ticks > 0 || offline.GameOver || offline.Victory)
	first := rv.stamp(snapshot(g, speed, resumed, scenario))
	first.OfflineReport = sendOffline // ITGAME-76: клиент знает, ждать ли offline_report следом
	hub.write(ctx, first)
	if sendOffline {
		hub.write(ctx, offlineReportMessage{
			Type: "offline_report", Ticks: offline.Ticks, Days: offline.Days,
			Income: offline.Income, Payroll: offline.Payroll, Balance: offline.Balance,
			GameOver: offline.GameOver, Victory: offline.Victory, Reason: offline.Reason,
			SavedAt: savedAt.UnixMilli(),
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
			rev := rv.rev
			if h.applyDebug(ctx, hub, req, sid, gen, withSaves,
				&g, &speed, resumeSpeed, &lastReport, journal, &scenario, rv) {
				return true // сейв не прошёл — мутации в партии нет, в журнал не пишем
			}
			jn.debug(req, rv.rev != rev) // мутация = новая версия состояния
		case cmd := <-commands:
			if cmd.Cmd == cmdAbandon {
				jn.command(cmd, nil)
				if withSaves {
					h.Saves.Delete(sid)
				}
				return false
			}
			var rejected *errorMessage
			if cmd.Cmd == cmdSetSpeed {
				if cmd.Speed < 0 || cmd.Speed > 3 {
					rejected = &errorMessage{Type: "error", Code: "bad_speed"}
				} else {
					setTempo(cmd.Speed)
					resumeSpeed = 0 // явный выбор игрока главнее возврата после exit
				}
			} else if cmd.Cmd == cmdExit {
				// Всегда замирает и никогда не отвечает bad_speed: выход случается всегда.
				setTempo(0)
				resumeSpeed = min(max(cmd.Speed, 0), 3)
				journal.add(fmt.Sprintf("д%d · выход в меню: пауза, «Продолжить» на %dx", g.Day, resumeSpeed))
			} else if err := g.Apply(cmd.Cmd, cmd.Office, cmd.Slot); err != nil {
				rejected = &errorMessage{Type: "error", Code: err.Error()}
			}
			// Ошибки — только отправителю (его промах, не общее событие),
			// состояние не меняют: rev текущий.
			if rejected != nil {
				jn.command(cmd, rejected)
				rejected.Re, rejected.Rev = cmd.ID, rv.rev
				if cmd.From != nil {
					hub.writeTo(ctx, cmd.From, *rejected)
				}
				continue
			}
			rv.bump(causeCmd)
			// Успешная команда — точка сейва: покупки и переходы дней
			// не должны теряться даже при жёстком kill -9. Финальная партия
			// сейва не держит: после финала сессия жива до «В меню»
			// (ITGAME-51), и set_speed не должен воскресить её сейв.
			if withSaves {
				if g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon {
					h.Saves.Finish(sid, gen)
				} else if !h.persist(sid, gen, g, speed, resumeSpeed, lastReport, scenario, journal.last(journal.cap), rv.rev) {
					return true
				}
			}
			// В журнал — после сейва, как и тик: команда вытесненного актора,
			// чей сейв не прошёл, не подтверждена и в партии не живёт.
			jn.command(cmd, nil)
			// Успешный снапшот — всем соединениям сессии, отправителю — с re.
			hub.writeReply(ctx, rv.stamp(snapshot(g, speed, false, scenario)), cmd.From, cmd.ID)
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
			// Снапшот уйдёт (ниже): финал, отчёт дня или идущий день. На паузе
			// фазы тик — no-op без снапшота и без новой версии.
			finished := wasRunning && (g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon)
			if finished || report != nil || g.Phase == game.PhaseRunning {
				rv.bump(causeTick)
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
					if !h.persist(sid, gen, g, speed, resumeSpeed, lastReport, scenario, journal.last(journal.cap), rv.rev) {
						return true
					}
				}
			}
			// В журнал — после сейва: тик вытесненного актора, чей сейв не
			// прошёл, никто не увидит, и реплею он не нужен (ITGAME-46).
			jn.tick(finished || report != nil)
			if wasRunning && g.Phase == game.PhaseWon {
				journal.add(fmt.Sprintf("д%d · цель достигнута: победа", g.Day))
				hub.write(ctx, rv.stamp(snapshot(g, speed, false, scenario)))
				hub.write(ctx, victoryMessage{Type: "victory",
					Difficulty: string(g.Config().Difficulty), Day: g.Day, Balance: g.Money})
				continue
			}
			if wasRunning && g.Phase == game.PhaseGameOver {
				hub.write(ctx, rv.stamp(snapshot(g, speed, false, scenario)))
				hub.write(ctx, gameOverMessage{Type: "game_over", DaysSurvived: g.Day,
					PeakIncomePerTick: g.PeakIncomePerTick, Balance: g.Money, Reason: g.LoseReason})
				continue
			}
			// На паузе фазы (отчёт/банкротство) тик — no-op: не шлём одинаковые
			// снапшоты каждую секунду, клиент ждёт команду игрока.
			if report == nil && g.Phase != game.PhaseRunning {
				continue
			}
			hub.write(ctx, rv.stamp(snapshot(g, speed, false, scenario)))
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
func (h *Handler) resume(sid string, gen uint64, rt *resumeTrace) (g *game.Game, speed int, last *game.DayReport, offline *game.OfflineSummary, ok bool, scenario string, journal *eventJournal, savedAt time.Time, rev uint64) {
	journal = newEventJournal(500) // даже без сейва журнал валиден
	raw, found := h.Saves.Load(sid)
	if !found {
		return nil, 1, nil, nil, false, "", journal, time.Time{}, 0
	}
	var ss sessionSave
	// Сейв другой сборки — как битый (ITGAME-140): новая партия под тем же sid, её первый
	// сейв перезапишет файл; меню об этом уже сказало (save_summary.incompatible).
	if json.Unmarshal(raw, &ss) != nil || ss.SID != sid || staleSave(ss) {
		h.Saves.Finish(sid, gen) // не Delete: тот закрыл бы kick — наш же (владеем с Begin)
		return nil, 1, nil, nil, false, "", journal, time.Time{}, 0
	}
	g, err := game.Restore(ss.Game)
	if err != nil {
		h.Saves.Finish(sid, gen)
		return nil, 1, nil, nil, false, "", journal, time.Time{}, 0
	}
	speed = min(max(ss.Speed, 0), 3)
	miss := offlineTicks(ss.SavedAt, speed, h.TickInterval)
	rt.capture(g, speed, ss.ResumeSpeed, ss.Scenario, ss.Rev, miss) // журнал: сейв до догона (ITGAME-46)
	offline = g.AdvanceOffline(miss)
	// Явный выход (ITGAME-65): сейв на паузе — догон выше нулевой, а партия
	// продолжается на скорости до выхода; следующий persist обнулит ResumeSpeed.
	if rs := min(ss.ResumeSpeed, 3); speed == 0 && rs > 0 {
		speed = rs
	}
	if offline != nil && offline.Ticks > 0 {
		journal.add(fmt.Sprintf("офлайн-догон: %d тиков, %d дней, баланс $%d",
			offline.Ticks, offline.Days, offline.Balance))
	}
	for _, ev := range ss.Events {
		journal.add(ev)
	}
	return g, speed, ss.LastReport, offline, true, ss.Scenario, journal, ss.SavedAt, ss.Rev
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
		GatewayOpex: r.GatewayOpex, Antivirus: r.Antivirus, EventMoney: r.EventMoney, Profit: r.Profit, Balance: r.Balance,
		Incidents: r.Incidents, LostIncome: r.LostIncome, VirusPCs: r.VirusPCs, VirusLost: r.VirusLost, Events: events}
}
