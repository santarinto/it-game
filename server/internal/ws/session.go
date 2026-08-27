package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// Handler на каждое подключение создаёт свою игру и запускает актор-цикл.
// С Saves != nil игра получает сейвы: переподключение с тем же sid в
// течение TTL восстанавливает прогресс (мягкий деплой, ITGAME-8).
type Handler struct {
	Config       game.Config
	TickInterval time.Duration
	Saves        *store.Store // nil — stateless-режим без сейвов (старые тесты)
}

// clientCommand — команда игрока с адресатом-офисом.
type clientCommand struct {
	Cmd    game.Command
	Office int
	Slot   int    // стойка для upgrade_server
	Speed  int    // параметр set_speed
	SID    string // адресат abandon
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
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Vite dev server проксирует /ws с другого порта; itgame — прод за nginx.
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*", "itgame.santarinto.ru"},
	})
	if err != nil {
		return
	}
	defer c.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	commands := make(chan clientCommand)
	go readLoop(ctx, cancel, c, commands)

	// Сложность применяется ТОЛЬКО при непустом query-параметре: иначе
	// кастомные тестовые конфиги (например WinTarget) затирались бы нормой.
	// При восстановлении сейва сложность игнорируется — конфиг в сейве.
	cfg := h.Config
	if q := r.URL.Query().Get("difficulty"); q != "" {
		cfg = game.ApplyDifficulty(h.Config, game.ParseDifficulty(q))
	}
	sid := r.URL.Query().Get("sid")

	evicted := h.run(ctx, c, commands, cfg, sid)
	if evicted {
		// Сессию забрал другой актор (дубликат вкладки): старому соединению
		// причина важнее вежливого кода — клиент не должен реконнектиться.
		c.Close(websocket.StatusPolicyViolation, "session_taken")
		return
	}
	c.Close(websocket.StatusNormalClosure, "сессия завершена")
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
		case commands <- clientCommand{Cmd: game.Command(msg.Type), Office: msg.Office, Slot: msg.Slot, Speed: msg.Speed}:
		case <-ctx.Done():
			return
		}
	}
}

// persist — записать сейв сессии. false — сессию забрал другой актор.
func (h *Handler) persist(sid string, gen uint64, g *game.Game, speed int, last *game.DayReport) bool {
	at := time.Now()
	data, err := json.Marshal(sessionSave{
		SID: sid, Speed: speed, SavedAt: at, Game: g.Export(), LastReport: last,
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
// Всё общение с миром — через канал команд и тикер; писем в сокет
// из других горутин нет, поэтому мьютексы не нужны.
// Возвращает true, если сессию забрал другой актор (eviction).
func (h *Handler) run(ctx context.Context, c *websocket.Conn, commands <-chan clientCommand, cfg game.Config, sid string) bool {
	// ── Старт: восстановление или новая игра ────────────────────────────
	var (
		g          *game.Game
		lastReport *game.DayReport
		offline    *game.OfflineSummary
		speed      = 1
		resumed    bool
		gen        uint64
		kick       <-chan struct{}
	)
	withSaves := h.Saves != nil && store.ValidSID(sid)
	if withSaves {
		g, speed, lastReport, offline, resumed = h.resume(sid)
		// владение сессией (+пинок старому актору)
		gen, kick = h.Saves.Begin(sid)
		if resumed {
			if g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon {
				// Офлайн привёл к финалу: сейв не нужен, доигрывают без него.
				h.Saves.Delete(sid)
			} else if !h.persist(sid, gen, g, speed, lastReport) {
				// нас обогнали между Load и Begin
				return true
			}
		}
	}
	if g == nil {
		g = game.New(cfg)
		if withSaves && !h.persist(sid, gen, g, speed, nil) {
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

	if wsjson.Write(ctx, c, snapshot(g, speed, resumed)) != nil {
		return false
	}
	// Отчёт «пока вас не было»: только когда было что симулировать
	// (прошёл день / финал). Короткий разрыв (деплой) — тихий resume.
	if resumed && offline != nil && (offline.Days > 0 || offline.GameOver || offline.Victory) {
		if wsjson.Write(ctx, c, offlineReportMessage{
			Type: "offline_report", Ticks: offline.Ticks, Days: offline.Days,
			Income: offline.Income, Payroll: offline.Payroll, Balance: offline.Balance,
			GameOver: offline.GameOver, Victory: offline.Victory,
		}) != nil {
			return false
		}
	}
	// Разрыв в фазе отчёта дня: игрок не увидел отчёт — дошлём из сейва.
	if resumed && g.Phase == game.PhaseDayReport && lastReport != nil {
		if wsjson.Write(ctx, c, dayReportMsg(lastReport)) != nil {
			return false
		}
	}

	for {
		select {
		case <-kick:
			return true
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
					out = snapshot(g, speed, false)
					mutated = true
				}
			} else if err := g.Apply(cmd.Cmd, cmd.Office, cmd.Slot); err != nil {
				out = errorMessage{Type: "error", Code: err.Error()}
			} else {
				out = snapshot(g, speed, false)
				mutated = true
			}
			// Успешная команда — точка сейва: покупки и переходы дней
			// не должны теряться даже при жёстком kill -9.
			if mutated && withSaves && !h.persist(sid, gen, g, speed, lastReport) {
				return true
			}
			if wsjson.Write(ctx, c, out) != nil {
				return false
			}
		case <-tickC:
			wasRunning := g.Phase == game.PhaseRunning
			report := g.Tick()
			if report != nil {
				lastReport = report
			}
			// Сейв/удаление ДО записи в сокет: клиент, прочитавший сообщение,
			// может реконнектнуться быстрее, чем сейв дотянется до стора —
			// тогда рестарт забрал бы устаревшее состояние.
			if withSaves {
				if g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon {
					// финал: сейв больше не нужен
					h.Saves.Delete(sid)
				} else if !h.persist(sid, gen, g, speed, lastReport) {
					return true
				}
			}
			if wasRunning && g.Phase == game.PhaseWon {
				if wsjson.Write(ctx, c, snapshot(g, speed, false)) != nil {
					return false
				}
				if wsjson.Write(ctx, c, victoryMessage{Type: "victory",
					Difficulty: string(g.Config().Difficulty), Day: g.Day, Balance: g.Money}) != nil {
					return false
				}
				continue
			}
			// На паузе фазы (отчёт/банкротство) тик — no-op: не шлём одинаковые
			// снапшоты каждую секунду, клиент ждёт команду игрока.
			if report == nil && g.Phase != game.PhaseRunning {
				continue
			}
			if wsjson.Write(ctx, c, snapshot(g, speed, false)) != nil {
				return false
			}
			if report != nil {
				var out any
				if g.Phase == game.PhaseGameOver {
					out = gameOverMessage{Type: "game_over", DaysSurvived: g.Day, PeakIncomePerTick: g.PeakIncomePerTick, Balance: g.Money}
				} else {
					out = dayReportMsg(report)
				}
				if wsjson.Write(ctx, c, out) != nil {
					return false
				}
			}
		case <-ctx.Done():
			return false
		}
	}
}

// resume — восстановить игру из сейва (если есть и валиден). Невалидный
// или терминальный сейв удаляется — сессия начнётся заново.
func (h *Handler) resume(sid string) (g *game.Game, speed int, last *game.DayReport, offline *game.OfflineSummary, ok bool) {
	raw, found := h.Saves.Load(sid)
	if !found {
		return nil, 1, nil, nil, false
	}
	var ss sessionSave
	if json.Unmarshal(raw, &ss) != nil || ss.SID != sid {
		h.Saves.Delete(sid)
		return nil, 1, nil, nil, false
	}
	g, err := game.Restore(ss.Game)
	if err != nil {
		h.Saves.Delete(sid)
		return nil, 1, nil, nil, false
	}
	speed = min(max(ss.Speed, 0), 3)
	offline = g.AdvanceOffline(offlineTicks(ss.SavedAt, speed, h.TickInterval))
	return g, speed, ss.LastReport, offline, true
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
