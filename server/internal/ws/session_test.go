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

// testMessage покрывает и state, и error — удобно читать любой ответ.
type testMessage struct {
	Type      string `json:"type"`
	Code      string `json:"code"`
	Money     int    `json:"money"`
	Employees int    `json:"employees"`
}

func dialTestServer(t *testing.T, tick time.Duration) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := httptest.NewServer(&Handler{Config: game.DefaultConfig(), TickInterval: tick})
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

func TestSessionCommands(t *testing.T) {
	// Тикер на час: тики не мешают проверке команд.
	c, ctx := dialTestServer(t, time.Hour)

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
	if msg.Type != "state" || msg.Employees != 1 || msg.Money != 300 {
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
	c, ctx := dialTestServer(t, 10*time.Millisecond)

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
