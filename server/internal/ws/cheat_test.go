package ws

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
)

// Чит денег для localhost (ITGAME-194): только локальный запрос, без ITGAME_DEBUG.
func TestLocalRequest(t *testing.T) {
	req := func(remote, host string, hdr ...string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/cheat/money", nil)
		r.RemoteAddr, r.Host = remote, host
		for i := 0; i+1 < len(hdr); i += 2 {
			r.Header.Set(hdr[i], hdr[i+1])
		}
		return r
	}
	for _, tc := range []struct {
		name string
		r    *http.Request
		want bool
	}{
		{"127.0.0.1 с портом", req("127.0.0.1:5555", "127.0.0.1:15555"), true},
		{"localhost", req("127.0.0.1:5555", "localhost:15555"), true},
		{"::1", req("[::1]:5555", "[::1]:15555"), true},
		{"*.localhost без порта", req("127.0.0.1:5555", "itgame.localhost"), true},
		{"прод через nginx: X-Real-IP", req("127.0.0.1:5555", "itgame.santarinto.ru", "X-Real-IP", "203.0.113.7"), false},
		{"подделанный Host за nginx", req("127.0.0.1:5555", "localhost", "X-Real-IP", "203.0.113.7"), false},
		{"X-Forwarded-For", req("127.0.0.1:5555", "localhost", "X-Forwarded-For", "203.0.113.7"), false},
		{"Forwarded", req("127.0.0.1:5555", "localhost", "Forwarded", "for=203.0.113.7"), false},
		{"чужой Host", req("127.0.0.1:5555", "itgame.santarinto.ru"), false},
		{"не loopback", req("192.0.2.10:5555", "localhost:15555"), false},
		{"localhost.evil.com", req("127.0.0.1:5555", "localhost.evil.com"), false},
		{"Origin localhost", req("127.0.0.1:5555", "localhost:15555", "Origin", "http://localhost:15555"), true},
		{"Origin 127.0.0.1", req("127.0.0.1:5555", "127.0.0.1:4421", "Origin", "http://127.0.0.1:4421"), true},
		{"Origin [::1]", req("[::1]:5555", "[::1]:15555", "Origin", "http://[::1]:15555"), true},
		{"Origin прода", req("127.0.0.1:5555", "localhost:15555", "Origin", "https://itgame.santarinto.ru"), false},
		{"Origin чужой сайт", req("127.0.0.1:5555", "localhost:15555", "Origin", "https://evil.example"), false},
		{"Origin null", req("127.0.0.1:5555", "localhost:15555", "Origin", "null"), false},
		{"Origin localhost.evil.com", req("127.0.0.1:5555", "localhost:15555", "Origin", "http://localhost.evil.com"), false},
	} {
		if got := localRequest(tc.r); got != tc.want {
			t.Errorf("%s: localRequest = %v, ждали %v", tc.name, got, tc.want)
		}
	}
}

// Сервер без /api/debug/* — только /ws и чит, как newMux без ITGAME_DEBUG.
func startCheatServer(t *testing.T, cfg game.Config) string {
	t.Helper()
	h := &Handler{Config: cfg, TickInterval: time.Hour}
	mux := http.NewServeMux()
	mux.Handle("GET /ws", h)
	mux.Handle("POST /api/cheat/money", http.HandlerFunc(h.ServeCheat))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestCheatMoneyAddsToLiveParty(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 100_000_000 // чит не выигрывает партию
	base := startCheatServer(t, cfg)
	sid := "cheat-sid-0001"
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	var first testMessage
	if err := wsjson.Read(context.Background(), c, &first); err != nil {
		t.Fatalf("первый снапшот: %v", err)
	}

	code, out := httpDebug(t, base, "POST", "/api/cheat/money", fmt.Sprintf(`{"sid":%q,"amount":10000}`, sid))
	if code != 200 {
		t.Fatalf("чит: %d %v", code, out)
	}
	if got := num(t, stateOf(t, out["state"])["money"]); got != cfg.StartMoney+10000 {
		t.Fatalf("баланс после чита %d, ждали %d", got, cfg.StartMoney+10000)
	}
	// второй чит прибавляет к новому балансу, а не ставит сумму
	code, out = httpDebug(t, base, "POST", "/api/cheat/money", fmt.Sprintf(`{"sid":%q,"amount":5}`, sid))
	if code != 200 || num(t, stateOf(t, out["state"])["money"]) != cfg.StartMoney+10005 {
		t.Fatalf("второй чит: %d %v", code, out)
	}
	// вкладка получила снапшот с новым балансом
	deadline := time.Now().Add(3 * time.Second)
	for {
		var m testMessage
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		err := wsjson.Read(ctx, c, &m)
		cancel()
		if err != nil {
			t.Fatalf("снапшот с балансом %d не пришёл: %v", cfg.StartMoney+10005, err)
		}
		if m.Type == "state" && m.Money == cfg.StartMoney+10005 {
			break
		}
	}
}

func TestCheatMoneyRefusals(t *testing.T) {
	base := startCheatServer(t, game.DefaultConfig())
	for _, tc := range []struct {
		body string
		code int
	}{
		{`{"sid":"cheat-sid-0002","amount":0}`, 400},
		{`{"sid":"cheat-sid-0002","amount":-5}`, 400},
		{`{"sid":"cheat-sid-0002","amount":10000001}`, 400},
		{`не json`, 400},
		{`{"sid":"cheat-sid-0002","amount":100}`, 404}, // живой партии нет
	} {
		resp, err := http.Post(base+"/api/cheat/money", "application/json", strings.NewReader(tc.body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.code {
			t.Errorf("%s: %d, ждали %d", tc.body, resp.StatusCode, tc.code)
		}
	}
	// прод за nginx: X-Real-IP — 403 раньше разбора тела
	r, _ := http.NewRequest(http.MethodPost, base+"/api/cheat/money", strings.NewReader(`{"sid":"cheat-sid-0002","amount":100}`))
	r.Header.Set("X-Real-IP", "203.0.113.7")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("с X-Real-IP: %d, ждали 403", resp.StatusCode)
	}
}
