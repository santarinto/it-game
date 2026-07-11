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

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Vite dev server проксирует /ws с другого порта.
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*"},
	})
	if err != nil {
		return
	}
	defer c.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	commands := make(chan game.Command)
	go readLoop(ctx, cancel, c, commands)

	h.run(ctx, c, commands)
	c.Close(websocket.StatusNormalClosure, "сессия завершена")
}

// readLoop — единственный читатель соединения: превращает входящие
// сообщения в команды для актора.
func readLoop(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn, commands chan<- game.Command) {
	defer cancel() // разрыв соединения останавливает актор
	for {
		var msg clientMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			return
		}
		select {
		case commands <- game.Command(msg.Type):
		case <-ctx.Done():
			return
		}
	}
}

// run — актор: единственная горутина, владеющая состоянием игры.
// Всё общение с миром — через канал команд и тикер; писем в сокет
// из других горутин нет, поэтому мьютексы не нужны.
func (h *Handler) run(ctx context.Context, c *websocket.Conn, commands <-chan game.Command) {
	g := game.New(h.Config)
	ticker := time.NewTicker(h.TickInterval)
	defer ticker.Stop()

	if wsjson.Write(ctx, c, snapshot(g)) != nil {
		return
	}
	for {
		select {
		case cmd := <-commands:
			var out any
			if err := g.Apply(cmd); err != nil {
				out = errorMessage{Type: "error", Code: err.Error()}
			} else {
				out = snapshot(g)
			}
			if wsjson.Write(ctx, c, out) != nil {
				return
			}
		case <-ticker.C:
			report := g.Tick()
			if wsjson.Write(ctx, c, snapshot(g)) != nil {
				return
			}
			if report != nil {
				var out any
				if g.Phase == game.PhaseGameOver {
					out = gameOverMessage{Type: "game_over", DaysSurvived: g.Day, PeakIncomePerTick: g.PeakIncomePerTick, Balance: g.Money}
				} else {
					out = dayReportMessage{Type: "day_report", Day: report.Day, Income: report.Income, Payroll: report.Payroll, Profit: report.Profit, Balance: report.Balance}
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
