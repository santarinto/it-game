package ws

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
)

// Источник команды в журнале партии (ITGAME-91): id команды — счётчик
// страницы (перезагрузка начинает с 1, мост агента шлёт свои), поэтому в
// журнале id1 встречался дважды. Запись несёт номер соединения в партии
// (conn) и источник (src: tab | bridge) — пара (conn, id) уникальна.

// journalAgentServer — journalServer плюс мост агента /ws/agent.
func journalAgentServer(t *testing.T, cfg game.Config) (*Handler, *httptest.Server) {
	t.Helper()
	h := &Handler{Config: cfg, TickInterval: time.Hour, Saves: newTestStore(t), Journal: true}
	mux := http.NewServeMux()
	mux.Handle("/ws", h)
	mux.Handle("/ws/agent", http.HandlerFunc(h.ServeAgent))
	mux.Handle("/api/debug/", http.HandlerFunc(h.ServeDebug))
	return h, newSavesServer(t, mux)
}

func TestJournalCommandConnAndSource(t *testing.T) {
	const sid = "journal-conn-1"
	cfg := game.DefaultConfig()
	cfg.StartMoney = 100000
	h, srv := journalAgentServer(t, cfg)

	// вкладка: id1, id2
	tab1 := dialTab(t, srv, "?sid="+sid+"&seed=91")
	tab1.do(t, map[string]any{"type": "buy_pc", "office": 0})
	tab1.do(t, map[string]any{"type": "set_speed", "speed": 0})
	tab1.close(t, h, sid)

	// «F5»: то же sid, счётчик страницы снова с 1
	tab2 := dialTab(t, srv, "?sid="+sid)
	tab2.do(t, map[string]any{"type": "buy_pc", "office": 0})

	// мост агента наблюдателем — свой id1
	agent, ctx := dialAgent(t, srv.URL, "?sid="+sid)
	if err := wsjson.Write(ctx, agent, clientMessage{Type: "buy_pc", Office: 0, ID: 1}); err != nil {
		t.Fatal(err)
	}
	for re := int64(0); re != 1; {
		var m struct {
			Type string `json:"type"`
			Re   int64  `json:"re"`
		}
		if err := wsjson.Read(ctx, agent, &m); err != nil {
			t.Fatalf("agent read: %v", err)
		}
		if m.Type == "state" {
			re = m.Re
		}
	}
	tab2.do(t, map[string]any{"type": "hire", "office": 0})

	res, recs := replayAndCompare(t, srv, sid)
	if len(res.Warnings) != 0 {
		t.Fatalf("предупреждения: %v", res.Warnings)
	}
	type key struct {
		conn int
		id   int64
	}
	seen := map[key]uint64{}
	var cmds []string
	for _, r := range recs {
		switch r.K {
		case "start", "resume":
			cmds = append(cmds, r.K+" c"+strconv.Itoa(r.Conn)+" "+r.Src)
		case "cmd":
			k := key{r.Conn, r.ID}
			if prev, dup := seen[k]; dup {
				t.Fatalf("пара (conn %d, id %d) повторилась: seq %d и %d", r.Conn, r.ID, prev, r.Seq)
			}
			seen[k] = r.Seq
			cmds = append(cmds, r.Type+" c"+strconv.Itoa(r.Conn)+" "+r.Src+" id"+strconv.FormatInt(r.ID, 10))
		}
	}
	want := []string{
		"start c1 tab", "buy_pc c1 tab id1", "set_speed c1 tab id2",
		"resume c2 tab", "buy_pc c2 tab id1", "buy_pc c3 bridge id1", "hire c2 tab id2",
	}
	if strings.Join(cmds, "; ") != strings.Join(want, "; ") {
		t.Fatalf("журнал:\n  %s\nожидалось:\n  %s", strings.Join(cmds, "; "), strings.Join(want, "; "))
	}
	if got := res.Conns; len(got) != 3 || got[1] != "tab" || got[2] != "tab" || got[3] != "bridge" {
		t.Fatalf("реплей: соединения %v", got)
	}
}

// Реплей ловит повтор пары (conn, id) предупреждением: состояние от conn не
// зависит (хэш тот же), но журнал с повтором — снова неоднозначный.
func TestReplayWarnsOnDuplicateConnID(t *testing.T) {
	const sid = "journal-conn-dup"
	cfg := game.DefaultConfig()
	cfg.StartMoney = 100000
	_, srv := journalAgentServer(t, cfg)
	tb := dialTab(t, srv, "?sid="+sid+"&seed=5")
	tb.do(t, map[string]any{"type": "buy_pc", "office": 0})
	tb.do(t, map[string]any{"type": "buy_pc", "office": 0})
	raw := fetchJournal(t, srv, sid)
	// второй buy_pc — тот же id, что у первого
	fixed := bytes.Replace(raw, []byte(`"id":2,"type":"buy_pc"`), []byte(`"id":1,"type":"buy_pc"`), 1)
	if bytes.Equal(fixed, raw) {
		t.Fatalf("не нашёл вторую команду в журнале:\n%s", raw)
	}
	res, err := Replay(bytes.NewReader(fixed))
	if err != nil {
		t.Fatal(err)
	}
	if res.Divergence != nil {
		t.Fatalf("conn/id не входят в хэш, а реплей разошёлся: %s", res.Divergence)
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "(conn 1, id 1)") {
		t.Fatalf("предупреждения: %v", res.Warnings)
	}
}
