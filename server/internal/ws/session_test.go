package ws

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
)

// testMessage покрывает state, error, day_report и game_over —
// удобно читать любой ответ сервера одним типом.
type testMessage struct {
	Type      string `json:"type"`
	Code      string `json:"code"`
	Money     int    `json:"money"`
	Employees []struct {
		Name          string `json:"name"`
		IncomePerTick int    `json:"incomePerTick"`
	} `json:"employees"`
	Day          int    `json:"day"`
	Phase        string `json:"phase"`
	Payroll      int    `json:"payroll"`
	Balance      int    `json:"balance"`
	DaysSurvived int    `json:"daysSurvived"`
}

func dialTestServer(t *testing.T, cfg game.Config, tick time.Duration) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := httptest.NewServer(&Handler{Config: cfg, TickInterval: tick})
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, ctx
}

// readUntil читает сообщения, пока не встретит подходящее (или упадёт по таймауту ctx).
func readUntil(t *testing.T, ctx context.Context, c *websocket.Conn, ok func(testMessage) bool) testMessage {
	t.Helper()
	for {
		var msg testMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			t.Fatalf("readUntil: %v", err)
		}
		if ok(msg) {
			return msg
		}
	}
}

func TestSessionCommands(t *testing.T) {
	// Тикер на час: тики не мешают проверке команд.
	c, ctx := dialTestServer(t, game.DefaultConfig(), time.Hour)

	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatalf("первый снапшот: %v", err)
	}
	if msg.Type != "state" || msg.Money != 600 {
		t.Fatalf("первый снапшот: %+v", msg)
	}

	// Успешный найм.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire"}); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "state" || len(msg.Employees) != 1 || msg.Money != 300 {
		t.Fatalf("после найма: %+v", msg)
	}

	// Сервер не по карману — ошибка с кодом.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "buy_server"}); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "error" || msg.Code != "not_enough_money" {
		t.Fatalf("хотим error/not_enough_money, получили: %+v", msg)
	}
}

func TestSessionTicks(t *testing.T) {
	c, ctx := dialTestServer(t, game.DefaultConfig(), 10*time.Millisecond)

	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire"}); err != nil {
		t.Fatal(err)
	}
	// Ждём, пока доход от тиков превысит остаток после найма ($300).
	for msg.Money <= 300 {
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			t.Fatalf("ждали рост денег от тиков: %v (последнее: %+v)", err, msg)
		}
	}
}

func TestSessionDayCycle(t *testing.T) {
	cfg := game.DefaultConfig()
	// День = 2 тика: 1 час по 2 тика.
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 2
	c, ctx := dialTestServer(t, cfg, 5*time.Millisecond)

	// Без сотрудников ФОТ 0 — день кончается отчётом, не банкротством.
	rep := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" })
	if rep.Day != 1 || rep.Payroll != 0 || rep.Balance != 600 {
		t.Fatalf("отчёт дня 1: %+v", rep)
	}
	// Покупка в фазе отчёта отклоняется.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire"}); err != nil {
		t.Fatal(err)
	}
	errMsg := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if errMsg.Code != "wrong_phase" {
		t.Fatalf("хотим wrong_phase, получили %+v", errMsg)
	}
	// next_day запускает день 2.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "next_day"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Day == 2 && m.Phase == "running" })
}

func TestSessionBankruptcyAndRestart(t *testing.T) {
	cfg := game.DefaultConfig()
	// День = 1 секунда (100 тиков по 10мс): огромный запас, чтобы hire успел.
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 100
	cfg.SalaryPerDay = 100000 // гарантированное банкротство с одним сотрудником
	c, ctx := dialTestServer(t, cfg, 10*time.Millisecond)

	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire"}); err != nil {
		t.Fatal(err)
	}
	first := readUntil(t, ctx, c, func(m testMessage) bool {
		return (m.Type == "state" && len(m.Employees) == 1) || m.Type == "error"
	})
	if first.Type == "error" {
		t.Fatalf("hire не успел до конца дня: %+v", first)
	}
	if e := first.Employees[0]; e.Name == "" || e.IncomePerTick < 9 || e.IncomePerTick > 14 {
		t.Fatalf("нанятый сотрудник в снапшоте подозрителен: %+v", e)
	}
	over := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "game_over" })
	if over.DaysSurvived != 1 || over.Balance >= 0 {
		t.Fatalf("итоги банкротства: %+v", over)
	}
	// restart возвращает стартовое состояние.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "restart"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && m.Money == 600 && len(m.Employees) == 0 && m.Day == 1 && m.Phase == "running"
	})
}
