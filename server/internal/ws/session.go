package ws

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
)

// Handler на каждое подключение создаёт свою игру и запускает актор-цикл.
type Handler struct {
	Config       game.Config
	TickInterval time.Duration
}

// clientCommand — команда игрока с адресатом-офисом.
type clientCommand struct {
	Cmd    game.Command
	Office int
	Slot   int // стойка для upgrade_server
	Speed  int // параметр set_speed
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
	cfg := h.Config
	if q := r.URL.Query().Get("difficulty"); q != "" {
		cfg = game.ApplyDifficulty(h.Config, game.ParseDifficulty(q))
	}

	h.run(ctx, c, commands, cfg)
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

// cmdSetSpeed — команда сессии, не игры: меняет темп реального времени,
// игровое состояние не трогает, поэтому живёт в ws, а не в game.
const cmdSetSpeed = game.Command("set_speed")

// run — актор: единственная горутина, владеющая состоянием игры.
// Всё общение с миром — через канал команд и тикер; писем в сокет
// из других горутин нет, поэтому мьютексы не нужны.
func (h *Handler) run(ctx context.Context, c *websocket.Conn, commands <-chan clientCommand, cfg game.Config) {
	g := game.New(cfg)
	speed := 1
	ticker := time.NewTicker(h.TickInterval)
	defer ticker.Stop()
	// На паузе tickC = nil: select по nil-каналу не срабатывает,
	// фаза игры и команды покупок при этом живут.
	tickC := ticker.C

	if wsjson.Write(ctx, c, snapshot(g, speed)) != nil {
		return
	}
	for {
		select {
		case cmd := <-commands:
			var out any
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
					out = snapshot(g, speed)
				}
			} else if err := g.Apply(cmd.Cmd, cmd.Office, cmd.Slot); err != nil {
				out = errorMessage{Type: "error", Code: err.Error()}
			} else {
				out = snapshot(g, speed)
			}
			if wsjson.Write(ctx, c, out) != nil {
				return
			}
		case <-tickC:
			wasRunning := g.Phase == game.PhaseRunning
			report := g.Tick()
			if wasRunning && g.Phase == game.PhaseWon {
				if wsjson.Write(ctx, c, snapshot(g, speed)) != nil {
					return
				}
				if wsjson.Write(ctx, c, victoryMessage{Type: "victory",
					Difficulty: string(g.Config().Difficulty), Day: g.Day, Balance: g.Money}) != nil {
					return
				}
				continue
			}
			// На паузе фазы (отчёт/банкротство) тик — no-op: не шлём одинаковые
			// снапшоты каждую секунду, клиент ждёт команду игрока.
			if report == nil && g.Phase != game.PhaseRunning {
				continue
			}
			if wsjson.Write(ctx, c, snapshot(g, speed)) != nil {
				return
			}
			if report != nil {
				var out any
				if g.Phase == game.PhaseGameOver {
					out = gameOverMessage{Type: "game_over", DaysSurvived: g.Day, PeakIncomePerTick: g.PeakIncomePerTick, Balance: g.Money}
				} else {
					out = dayReportMessage{Type: "day_report", Day: report.Day, Income: report.Income, Payroll: report.Payroll, GatewayOpex: report.GatewayOpex, Profit: report.Profit, Balance: report.Balance}
				}
				if wsjson.Write(ctx, c, out) != nil {
					return
				}
			}
		case <-ctx.Done():
			return
		}
	}
}
