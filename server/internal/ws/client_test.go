package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"itdirector/internal/metrics"
)

// ?client= подключения (ITGAME-162, bot — ITGAME-240): нет параметра —
// desktop, desktop, mobile и bot — как есть, прочее — unknown.
func TestParseClientKind(t *testing.T) {
	for raw, want := range map[string]clientKind{
		"":         clientDesktop,
		"desktop":  clientDesktop,
		"mobile":   clientMobile,
		"bot":      clientBot,
		"Bot":      clientUnknown,
		"tablet":   clientUnknown,
		"Mobile":   clientUnknown,
		"desktop ": clientUnknown,
		"unknown":  clientUnknown,
	} {
		if got := parseClientKind(raw); got != want {
			t.Errorf("parseClientKind(%q) = %q, хотим %q", raw, got, want)
		}
	}
}

// Строка лога: тип клиента; без параметра — пометка, чужое значение — в
// кавычках (перевод строки экранирован) и обрезано.
func TestConnectLine(t *testing.T) {
	for _, c := range []struct{ raw, want string }{
		{"", "сессия s-1: вкладка подключена, клиент desktop (без client=)"},
		{"desktop", "сессия s-1: вкладка подключена, клиент desktop"},
		{"mobile", "сессия s-1: вкладка подключена, клиент mobile"},
		{"bot", "сессия s-1: вкладка подключена, клиент bot"},
		{"tablet", `сессия s-1: вкладка подключена, клиент unknown (client="tablet")`},
		{"a\nb", `сессия s-1: вкладка подключена, клиент unknown (client="a\nb")`},
		{strings.Repeat("я", 40), `сессия s-1: вкладка подключена, клиент unknown (client="` + strings.Repeat("я", 32) + `…")`},
	} {
		if got := connectLine("s-1", c.raw); got != c.want {
			t.Errorf("connectLine(%q):\n got %s\nwant %s", c.raw, got, c.want)
		}
	}
}

// syncBuf — вывод log под мьютексом: пишут хендлеры из своих горутин.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func captureLog(t *testing.T) *syncBuf {
	t.Helper()
	buf := &syncBuf{}
	prev := log.Writer()
	log.SetOutput(buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return buf
}

// firstState — первый кадр соединения как есть (сырой JSON снапшота).
func firstState(t *testing.T, ctx context.Context, c *websocket.Conn) []byte {
	t.Helper()
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("первый снапшот: %v", err)
	}
	var m testMessage
	if err := json.Unmarshal(b, &m); err != nil || m.Type != "state" || m.Phase != "running" {
		t.Fatalf("первый кадр не state running: %s", b)
	}
	return b
}

// Подключение с каждым значением client=: игра та же (первый снапшот новой
// партии с одним сидом байт в байт), тип — в лог и в
// itgame_ws_connects_total{client}; неизвестное значение соединение не рвёт.
func TestClientKindOnConnect(t *testing.T) {
	logs := captureLog(t)
	srv := newSavesServer(t, &Handler{Config: savesTestConfig(), TickInterval: time.Hour, Saves: newTestStore(t)})
	var ref []byte
	for _, c := range []struct {
		name, query string
		kind        clientKind
		line        string
	}{
		{"none", "", clientDesktop, "клиент desktop (без client=)"},
		{"desktop", "&client=desktop", clientDesktop, "клиент desktop\n"},
		{"mobile", "&client=mobile", clientMobile, "клиент mobile\n"},
		{"bot", "&client=bot", clientBot, "клиент bot\n"},
		{"tablet", "&client=tablet", clientUnknown, `клиент unknown (client="tablet")`},
	} {
		counter := metrics.WSConnects.WithLabelValues(string(c.kind))
		before := testutil.ToFloat64(counter)
		sid := "client-kind-" + c.name
		conn, ctx := dialURL(t, srv.URL, "/ws?sid="+sid+"&seed=42"+c.query)
		snap := firstState(t, ctx, conn)
		if ref == nil {
			ref = snap
		} else if !bytes.Equal(snap, ref) {
			t.Errorf("%s: снапшот отличается от вкладки без client=:\n%s\n%s", c.name, snap, ref)
		}
		if d := delta(counter, before); d != 1 {
			t.Errorf("%s: ws_connects{client=%s} +%v, хотим +1", c.name, c.kind, d)
		}
		if want := "сессия " + sid + ": вкладка подключена, " + c.line; !strings.Contains(logs.String(), want) {
			t.Errorf("%s: в логе нет %q:\n%s", c.name, want, logs.String())
		}
		// Соединение живо и играет: команда проходит.
		if err := wsjson.Write(ctx, conn, clientMessage{Type: "set_speed", Speed: 2, ID: 1}); err != nil {
			t.Fatal(err)
		}
		readUntil(t, ctx, conn, func(m testMessage) bool { return m.Type == "state" && m.Speed == 2 })
	}
}

// Одна партия с двух типов клиентов — как две вкладки: вторая (desktop)
// забирает сессию у первой (mobile) через session_taken и поднимает её сейв.
func TestClientKindTakeover(t *testing.T) {
	saves := newTestStore(t)
	srv := newSavesServer(t, &Handler{Config: savesTestConfig(), TickInterval: time.Hour, Saves: saves})
	c1, ctx1 := dialURL(t, srv.URL, "/ws?sid=client-duel-1&client=mobile")
	readResume(t, ctx1, c1)
	wsjson.Write(ctx1, c1, clientMessage{Type: "hire", Office: 0})
	readUntil(t, ctx1, c1, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1
	})

	c2, ctx2 := dialURL(t, srv.URL, "/ws?sid=client-duel-1&client=desktop")
	if m := readResume(t, ctx2, c2); !m.Resumed || len(m.Offices[0].Employees) != 1 {
		t.Fatalf("desktop не получил партию mobile: %+v", m)
	}
	var msg testMessage
	err := wsjson.Read(ctx1, c1, &msg)
	if err == nil || !strings.Contains(err.Error(), "session_taken") {
		t.Fatalf("mobile после захвата: %v (%+v), хотим закрытие session_taken", err, msg)
	}
}
