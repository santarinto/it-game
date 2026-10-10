package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/store"
)

// Таймаут чтения и debug-обрыв (ITGAME-76).

// startLivenessServer — /ws, /ws/agent и /api/debug/* на одном хендлере с
// сейвами и своим таймаутом чтения (как main.go за ITGAME_DEBUG=1).
func startLivenessServer(t *testing.T, saves *store.Store, tick, readTimeout time.Duration) (string, *Handler) {
	t.Helper()
	h := &Handler{Config: savesTestConfig(), TickInterval: tick, Saves: saves, ReadTimeout: readTimeout}
	mux := http.NewServeMux()
	mux.Handle("GET /ws", h)
	mux.Handle("GET /ws/agent", http.HandlerFunc(h.ServeAgent))
	mux.Handle("/api/debug/", http.HandlerFunc(h.ServeDebug))
	srv := newSavesServer(t, mux)
	return srv.URL, h
}

func dialURL(t *testing.T, base, path string) (*websocket.Conn, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+path, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, ctx
}

// recvLog — фоновый читатель клиента: время и тип каждого сообщения, момент
// разрыва. Читатель обязателен и сам по себе: pong на ping сервера клиент
// coder/websocket отвечает только внутри Read.
type recvLog struct {
	mu     sync.Mutex
	at     []time.Time
	rev    []uint64
	closed time.Time
	done   chan struct{}
}

func startRecv(ctx context.Context, c *websocket.Conn) *recvLog {
	l := &recvLog{done: make(chan struct{})}
	go func() {
		defer close(l.done)
		for {
			var m struct {
				Type string `json:"type"`
				Rev  uint64 `json:"rev"`
			}
			if err := wsjson.Read(ctx, c, &m); err != nil {
				l.mu.Lock()
				l.closed = time.Now()
				l.mu.Unlock()
				return
			}
			l.mu.Lock()
			l.at = append(l.at, time.Now())
			l.rev = append(l.rev, m.Rev)
			l.mu.Unlock()
		}
	}()
	return l
}

// after — сколько сообщений пришло позже t; lastRev — rev последнего state до t.
func (l *recvLog) after(t time.Time) (n int, lastRev uint64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, at := range l.at {
		if at.After(t) {
			n++
		} else if l.rev[i] > 0 {
			lastRev = l.rev[i]
		}
	}
	return n, lastRev
}

// waitGone — дождаться, пока сессия выпишется из реестра (актор встал).
func waitGone(t *testing.T, h *Handler, sid string, within time.Duration) time.Time {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if h.lookupSession(sid) == nil {
			return time.Now()
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("сессия %s жива через %s", sid, within)
	return time.Time{}
}

func postDrop(t *testing.T, base, query string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Post(base+"/api/debug/drop"+query, "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("drop%s: ответ не JSON: %v", query, err)
	}
	return resp.StatusCode, out
}

// Debug-обрыв: сервер молчит в соединение, партия идёт вживую, уход замечен
// по таймауту чтения (не раньше), офлайн при возврате — от этого момента.
func TestDebugDropNoticedByReadTimeout(t *testing.T) {
	const (
		sid     = "drop-12345"
		tick    = 20 * time.Millisecond
		timeout = 300 * time.Millisecond
	)
	saves := newTestStore(t)
	base, h := startLivenessServer(t, saves, tick, 5*time.Second)
	c, ctx := dialURL(t, base, "/ws?sid="+sid)
	readResume(t, ctx, c)
	recv := startRecv(ctx, c)
	time.Sleep(5 * tick)

	code, body := postDrop(t, base, "?sid="+sid+"&timeout=300")
	if code != http.StatusOK {
		t.Fatalf("drop: %d %v", code, body)
	}
	at := time.UnixMilli(int64(num(t, body["at"])))
	if num(t, body["timeoutMs"]) != 300 || int64(num(t, body["noticeBy"])) != at.Add(timeout).UnixMilli() {
		t.Fatalf("drop: ответ %v", body)
	}
	_, revAtDrop := recv.after(at)

	noticed := waitGone(t, h, sid, 3*time.Second)
	// Не раньше таймаута и не позже таймаута + шаг сторожа (timeout/4) + запас.
	if d := noticed.Sub(at); d < timeout || d > timeout+timeout/4+250*time.Millisecond {
		t.Fatalf("сервер заметил уход через %s, хотим %s..%s", d, timeout, timeout+timeout/4+250*time.Millisecond)
	}
	// Сервер молчал: после обрыва клиенту ничего не пришло (кроме уже летевшего).
	if n, _ := recv.after(at.Add(15 * time.Millisecond)); n != 0 {
		t.Fatalf("после обрыва клиенту пришло %d сообщений", n)
	}
	// Сервер рвёт соединение сам (без close-фрейма) — клиент видит разрыв.
	select {
	case <-recv.done:
	case <-time.After(2 * time.Second):
		t.Fatal("клиентский сокет не закрыт после того, как сервер заметил уход")
	}

	// Партия шла вживую до момента «заметил»: сейв — последний тик перед ним.
	ss := loadSave(t, saves, sid)
	if ss.SavedAt.Before(at.Add(timeout-3*tick)) || ss.SavedAt.After(noticed) {
		t.Fatalf("savedAt %s: хотим последний тик перед %s (обрыв %s)",
			ss.SavedAt.Format("15:04:05.000"), noticed.Format("15:04:05.000"), at.Format("15:04:05.000"))
	}
	if live := ss.Rev - revAtDrop; live < uint64(timeout/tick)/2 {
		t.Fatalf("вживую после обрыва %d тиков (rev %d → %d), хотим ≈%d", live, revAtDrop, ss.Rev, timeout/tick)
	}

	// Возврат: офлайн-догон от savedAt (когда заметил), а не от обрыва.
	time.Sleep(200 * time.Millisecond)
	c2, ctx2 := dialURL(t, base, "/ws?sid="+sid)
	var first struct {
		Type          string `json:"type"`
		Resumed       bool   `json:"resumed"`
		OfflineReport bool   `json:"offlineReport"`
		Cause         string `json:"cause"`
	}
	if err := wsjson.Read(ctx2, c2, &first); err != nil {
		t.Fatal(err)
	}
	back := time.Now()
	if first.Type != "state" || !first.Resumed || first.Cause != "resume" || !first.OfflineReport {
		t.Fatalf("первый снапшот возврата: %+v, хотим resumed, cause resume, offlineReport", first)
	}
	var rep testMessage
	if err := wsjson.Read(ctx2, c2, &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Type != "offline_report" || rep.SavedAt != ss.SavedAt.UnixMilli() {
		t.Fatalf("offline_report: %+v, хотим savedAt %d", rep, ss.SavedAt.UnixMilli())
	}
	want := int(back.Sub(ss.SavedAt) / tick)
	if rep.Ticks < want-3 || rep.Ticks > want+1 {
		t.Fatalf("догон %d тиков, хотим ≈%d (от savedAt, а не от обрыва: было бы ≈%d)", rep.Ticks, want, int(back.Sub(at)/tick))
	}
}

// Живая вкладка на паузе молчит дольше таймаута — ping/pong держит её.
func TestReadTimeoutKeepsIdleTab(t *testing.T) {
	const sid = "idle-12345"
	saves := newTestStore(t)
	base, h := startLivenessServer(t, saves, time.Hour, 150*time.Millisecond)
	c, ctx := dialURL(t, base, "/ws?sid="+sid)
	readResume(t, ctx, c)
	recv := startRecv(ctx, c)
	time.Sleep(700 * time.Millisecond)
	if h.lookupSession(sid) == nil {
		t.Fatal("живую вкладку закрыли по таймауту чтения")
	}
	select {
	case <-recv.done:
		t.Fatal("сокет живой вкладки закрыт")
	default:
	}
}

// Настоящий обрыв: клиент перестал отвечать (pong не читает) — сервер
// замечает своим таймаутом чтения.
func TestReadTimeoutNoticesSilentPeer(t *testing.T) {
	const sid = "mute-12345"
	saves := newTestStore(t)
	base, h := startLivenessServer(t, saves, 20*time.Millisecond, 200*time.Millisecond)
	c, ctx := dialURL(t, base, "/ws?sid="+sid)
	readResume(t, ctx, c)
	start := time.Now()
	// Больше не читаем: pong-ов нет, сервер для нас молчит.
	noticed := waitGone(t, h, sid, 3*time.Second)
	if d := noticed.Sub(start); d < 200*time.Millisecond {
		t.Fatalf("заметил через %s — раньше таймаута", d)
	}
}

func TestDebugDropErrors(t *testing.T) {
	saves := newTestStore(t)
	base, _ := startLivenessServer(t, saves, time.Hour, 5*time.Second)
	c, ctx := dialURL(t, base, "/ws?sid=errs-12345")
	readResume(t, ctx, c)
	startRecv(ctx, c)

	for _, tc := range []struct {
		query string
		code  int
	}{
		{"?sid=x", http.StatusBadRequest},
		{"?sid=nobody-12345", http.StatusNotFound},
		{"?sid=errs-12345&timeout=10", http.StatusBadRequest},
		{"?sid=errs-12345&timeout=abc", http.StatusBadRequest},
	} {
		if code, body := postDrop(t, base, tc.query); code != tc.code {
			t.Errorf("drop%s: %d %v, хотим %d", tc.query, code, body, tc.code)
		}
	}
	if resp, err := http.Get(base + "/api/debug/drop?sid=errs-12345"); err != nil {
		t.Fatal(err)
	} else if resp.Body.Close(); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET drop: %d, хотим 405", resp.StatusCode)
	}
	if code, body := postDrop(t, base, "?sid=errs-12345"); code != http.StatusOK || num(t, body["timeoutMs"]) != 5000 {
		t.Fatalf("drop без timeout: %d %v, хотим 200 и таймаут хендлера 5000", code, body)
	}
	if code, _ := postDrop(t, base, "?sid=errs-12345"); code != http.StatusConflict {
		t.Errorf("второй drop: %d, хотим 409 already_dropped", code)
	}

	// Headless-сессия агента: вкладки нет — рвать нечего.
	a, actx := dialURL(t, base, "/ws/agent?sid=agent-12345")
	readAgentMsg(t, actx, a)
	if code, body := postDrop(t, base, "?sid=agent-12345"); code != http.StatusConflict || !strings.HasPrefix(body["error"].(string), "no_tab") {
		t.Errorf("drop headless: %d %v, хотим 409 no_tab", code, body)
	}
}
