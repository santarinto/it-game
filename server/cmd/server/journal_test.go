package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/spriteproxy"
	"itdirector/internal/store"
	"itdirector/internal/ws"
)

// TestJournalThroughMux — ITGAME-46 на маршрутах бинаря: с ITGAME_DEBUG=1
// партия через /ws пишет журнал, GET /api/debug/journal отдаёт его, реплей
// сходится; без флага маршрута нет (честный 404 ServeMux).
func TestJournalThroughMux(t *testing.T) {
	off := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, "", false, 0, spriteproxy.Upstream{}))
	t.Cleanup(off.Close)
	if resp, err := http.Get(off.URL + "/api/debug/journal?sid=journal-mux-1"); err != nil {
		t.Fatal(err)
	} else if resp.Body.Close(); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("без ITGAME_DEBUG /api/debug/journal: %d, ожидался 404", resp.StatusCode)
	}

	saves, err := store.New(t.TempDir(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	cfg := game.DefaultConfig()
	cfg.StartMoney = 100000
	srv := httptest.NewServer(newMux(cfg, nil, saves, "", true, 0, spriteproxy.Upstream{}))
	t.Cleanup(srv.Close)

	const sid = "journal-mux-1"
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?sid="+sid+"&seed=46", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	type msg struct {
		Type string `json:"type"`
		Re   int64  `json:"re"`
	}
	cmds := []map[string]any{
		{"type": "set_speed", "speed": 0},
		{"type": "buy_pc", "office": 0},
		{"type": "hire", "office": 0},
		{"type": "hire", "office": 0},
		{"type": "set_speed", "speed": 7}, // bad_speed — отказ тоже в журнале
		{"type": "buy_router", "office": 0},
	}
	for i, m := range cmds {
		m["id"] = i + 1
		if err := wsjson.Write(ctx, c, m); err != nil {
			t.Fatal(err)
		}
		for {
			var got msg
			if err := wsjson.Read(ctx, c, &got); err != nil {
				t.Fatal(err)
			}
			if got.Re == int64(i+1) {
				break
			}
		}
	}

	resp, err := http.Get(srv.URL + "/api/debug/journal?sid=" + sid)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("journal: %d %s", resp.StatusCode, body)
	}
	res, err := ws.Replay(strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	if res.Divergence != nil {
		t.Fatalf("реплей разошёлся:\n%s", res.Divergence)
	}
	if res.Records != 1+len(cmds) || len(res.Game.Offices[0].Employees) != 2 {
		t.Fatalf("записей %d (ждали %d), сотрудников %d:\n%s", res.Records, 1+len(cmds), len(res.Game.Offices[0].Employees), body)
	}
}
