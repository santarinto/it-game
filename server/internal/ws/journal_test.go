package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// Журнал партии и реплей (ITGAME-46).

// journalServer — сервер с сейвами, журналом и /api/debug/* (как newMux
// при ITGAME_DEBUG=1).
func journalServer(t *testing.T, cfg game.Config, tick time.Duration, lim journalLimits) (*Handler, *httptest.Server) {
	t.Helper()
	return journalServerWith(t, cfg, tick, lim, newTestStore(t))
}

func journalServerWith(t *testing.T, cfg game.Config, tick time.Duration, lim journalLimits, saves *store.Store) (*Handler, *httptest.Server) {
	t.Helper()
	h := &Handler{Config: cfg, TickInterval: tick, Saves: saves, Journal: true, journalLimits: lim}
	mux := http.NewServeMux()
	mux.Handle("/ws", h)
	mux.Handle("/api/debug/", http.HandlerFunc(h.ServeDebug))
	return h, newSavesServer(t, mux)
}

// tab — подключение-вкладка: читатель в фоне держит последний снапшот
// (актор пишет непрерывно — непрочитанный сокет встал бы на записи).
type tab struct {
	c      *websocket.Conn
	ctx    context.Context
	mu     sync.Mutex
	st     stateMessage
	first  stateMessage // первый снапшот соединения (resumed — только в нём)
	re     int64        // наибольший re среди снапшотов (ответ на нашу команду)
	closed chan struct{}
	id     int64
}

func dialTab(t *testing.T, srv *httptest.Server, query string) *tab {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws"+query, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c.SetReadLimit(1 << 22)
	t.Cleanup(func() { c.CloseNow() })
	tb := &tab{c: c, ctx: ctx, closed: make(chan struct{})}
	go func() {
		defer close(tb.closed)
		for {
			var raw json.RawMessage
			if wsjson.Read(ctx, c, &raw) != nil {
				return
			}
			var head struct{ Type string }
			_ = json.Unmarshal(raw, &head)
			if head.Type == "state" {
				var st stateMessage
				_ = json.Unmarshal(raw, &st)
				tb.mu.Lock()
				if tb.st.Type == "" {
					tb.first = st
				}
				tb.re = max(tb.re, st.Re)
				tb.st = st
				tb.mu.Unlock()
			}
		}
	}()
	tb.wait(t, func(s stateMessage) bool { return s.Type == "state" })
	return tb
}

func (tb *tab) state() stateMessage {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	return tb.st
}

func (tb *tab) send(t *testing.T, msg map[string]any) {
	t.Helper()
	tb.id++
	msg["id"] = tb.id
	if err := wsjson.Write(tb.ctx, tb.c, msg); err != nil {
		t.Fatalf("send %v: %v", msg, err)
	}
}

// do — команда и ожидание её снапшота (re = id): после него журнал уже
// содержит запись команды, а предыдущие команды обработаны.
func (tb *tab) do(t *testing.T, msg map[string]any) stateMessage {
	t.Helper()
	tb.send(t, msg)
	id := tb.id
	return tb.wait(t, func(stateMessage) bool {
		tb.mu.Lock()
		defer tb.mu.Unlock()
		return tb.re >= id
	})
}

func (tb *tab) wait(t *testing.T, ok func(stateMessage) bool) stateMessage {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if s := tb.state(); ok(s) {
			return s
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("не дождались состояния; последнее: day=%d tick=%d phase=%s speed=%d", tb.st.Day, tb.st.TickInDay, tb.st.Phase, tb.st.Speed)
	return stateMessage{}
}

// close — вкладка ушла; ждём, пока актор выпишется (его end уже в журнале).
func (tb *tab) close(t *testing.T, h *Handler, sid string) {
	t.Helper()
	tb.c.Close(websocket.StatusNormalClosure, "")
	waitActorGone(t, h, sid)
}

func waitActorGone(t *testing.T, h *Handler, sid string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for h.lookupSession(sid) != nil {
		if time.Now().After(deadline) {
			t.Fatal("актор не выписался")
		}
		time.Sleep(time.Millisecond)
	}
}

// randomStep — один случайный ход игрока: команды всех видов, в том числе
// заведомо отказные (bad_speed, чужой слот), темп 0..3.
func randomStep(t *testing.T, tb *tab, rng *rand.Rand) {
	s := tb.state()
	switch {
	case s.Phase == string(game.PhaseDayReport):
		tb.send(t, map[string]any{"type": "next_day"})
		return
	case s.Phase == string(game.PhaseGameOver):
		tb.send(t, map[string]any{"type": "restart"})
		return
	case s.ActiveEvent != nil && rng.IntN(3) == 0:
		tb.send(t, map[string]any{"type": "event_choice", "slot": rng.IntN(3)})
		return
	case s.Speed == 0 && rng.IntN(2) == 0:
		tb.send(t, map[string]any{"type": "set_speed", "speed": 1 + rng.IntN(3)})
		return
	}
	office := 0
	if rng.IntN(5) == 0 {
		office = 1
	}
	slot := rng.IntN(6)
	cmds := []map[string]any{
		{"type": "hire", "office": office},
		{"type": "hire", "office": 0},
		{"type": "buy_pc", "office": office},
		{"type": "buy_pc", "office": 0},
		{"type": "motivate", "office": 0, "slot": slot},
		{"type": "motivate", "office": 0, "slot": slot},
		{"type": "repair_click", "office": 0, "slot": slot},
		{"type": "call_master", "office": 0, "slot": slot},
		{"type": "buy_router", "office": office},
		{"type": "buy_server", "office": 0},
		{"type": "upgrade_server", "office": 0, "slot": 0},
		{"type": "buy_cooler", "office": 0},
		{"type": "buy_coffee", "office": 0},
		{"type": "fire", "office": 0, "slot": slot},
		{"type": "set_antivirus", "slot": rng.IntN(5)}, // 4 — bad_tier, повтор — antivirus_already (ITGAME-137)
		{"type": "set_speed", "speed": rng.IntN(5)},    // 4 — bad_speed
		{"type": "set_speed", "speed": 3},
	}
	tb.send(t, cmds[rng.IntN(len(cmds))])
}

func playRandom(t *testing.T, tb *tab, rng *rand.Rand, steps int) {
	t.Helper()
	for range steps {
		randomStep(t, tb, rng)
		time.Sleep(time.Duration(rng.IntN(1500)) * time.Microsecond)
	}
}

// ensureAlive — партия идёт и не умрёт в ближайший день: случайная игра
// легко банкротится, а сейва финала нет — реконнект начал бы новую партию.
func ensureAlive(t *testing.T, srv *httptest.Server, tb *tab, sid string) {
	t.Helper()
	// Сначала деньги, потом фаза — по серверу, не по снапшоту вкладки: тот
	// мог отстать от банкротства, которое уже случилось.
	debugPost(t, srv, "/api/debug/state", `{"sid":"`+sid+`","money":50000}`)
	if _, st := liveState(t, srv, sid); st.Phase == string(game.PhaseGameOver) {
		tb.do(t, map[string]any{"type": "restart"})
		debugPost(t, srv, "/api/debug/state", `{"sid":"`+sid+`","money":50000}`)
	}
}

func debugPost(t *testing.T, srv *httptest.Server, path, body string) {
	t.Helper()
	resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST %s %s: %d %s", path, body, resp.StatusCode, b)
	}
}

func fetchJournal(t *testing.T, srv *httptest.Server, sid string) []byte {
	t.Helper()
	resp, err := http.Get(srv.URL + "/api/debug/journal?sid=" + sid)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("journal: %d %s", resp.StatusCode, b)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/x-ndjson") {
		t.Errorf("Content-Type %q", ct)
	}
	return b
}

// liveState — GET /api/debug/state: сейв и снапшот живой партии сырыми байтами.
func liveState(t *testing.T, srv *httptest.Server, sid string) (save json.RawMessage, state stateMessage) {
	t.Helper()
	resp, err := http.Get(srv.URL + "/api/debug/state?sid=" + sid)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Save  json.RawMessage `json:"save"`
		State stateMessage    `json:"state"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Save, body.State
}

// replayAndCompare — реплей журнала живой партии сходится, и итог побайтно
// равен живому: сейв и снапшот протокола (без rev/cause — это не игра).
func replayAndCompare(t *testing.T, srv *httptest.Server, sid string) (*ReplayResult, []journalRecord) {
	t.Helper()
	raw := fetchJournal(t, srv, sid)
	res, err := Replay(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if res.Divergence != nil {
		t.Fatalf("реплей разошёлся с живой партией:\n%s", res.Divergence)
	}
	liveSave, liveSt := liveState(t, srv, sid)
	gotSave, _ := json.Marshal(res.Game.Export())
	if !bytes.Equal(liveSave, gotSave) {
		t.Fatalf("сейв реплея не равен живому:\nживой  %s\nреплей %s", liveSave, gotSave)
	}
	liveSt.Rev, liveSt.Cause, liveSt.Re = 0, "", 0
	a, _ := json.Marshal(liveSt)
	b, _ := json.Marshal(snapshot(res.Game, res.Speed, false, res.Scenario))
	if !bytes.Equal(a, b) {
		t.Fatalf("снапшот реплея не равен живому:\nживой  %s\nреплей %s", a, b)
	}
	var recs []journalRecord
	for _, l := range bytes.Split(bytes.TrimSpace(raw), []byte("\n"))[1:] {
		var r journalRecord
		if err := json.Unmarshal(l, &r); err != nil {
			t.Fatal(err)
		}
		recs = append(recs, r)
	}
	return res, recs
}

// TestJournalReplayRandomParty — приёмка ITGAME-46: случайная партия на
// настоящем конфиге (события, поломки, кофе, звёзды) с командами, отказами,
// debug-патчами, офлайн-догоном, вытеснением и выходом в меню → журнал из
// /api/debug/journal → реплей → финал совпадает побайтно.
func TestJournalReplayRandomParty(t *testing.T) {
	const sid = "journal-party-1"
	h, srv := journalServer(t, game.DefaultConfig(), 3*time.Millisecond, journalLimits{})
	rng := rand.New(rand.NewPCG(46, 46))

	tb := dialTab(t, srv, "?sid="+sid+"&seed=777")
	debugPost(t, srv, "/api/debug/state", `{"sid":"`+sid+`","money":3000}`)
	playRandom(t, tb, rng, 150)
	debugPost(t, srv, "/api/debug/state", `{"sid":"`+sid+`","money":5000}`)
	playRandom(t, tb, rng, 60)
	ensureAlive(t, srv, tb, sid)
	debugPost(t, srv, "/api/debug/advance", `{"sid":"`+sid+`","ticks":25}`)
	debugPost(t, srv, "/api/debug/state", `{"sid":"`+sid+`","state":{"money":4321}}`)
	playRandom(t, tb, rng, 60)

	// Разрыв на ходу: сейв на скорости 3, за 60 мс офлайн набегает ~60 тиков.
	ensureAlive(t, srv, tb, sid)
	tb.do(t, map[string]any{"type": "set_speed", "speed": 3})
	tb.close(t, h, sid)
	time.Sleep(60 * time.Millisecond)

	tb = dialTab(t, srv, "?sid="+sid)
	if f := tb.first; !f.Resumed {
		t.Fatalf("реконнект не поднял сейв: первый снапшот day=%d tick=%d phase=%s rev=%d cause=%s", f.Day, f.TickInDay, f.Phase, f.Rev, f.Cause)
	}
	playRandom(t, tb, rng, 100)

	// Вытеснение: вторая вкладка с тем же sid забирает живую сессию.
	ensureAlive(t, srv, tb, sid)
	tb2 := dialTab(t, srv, "?sid="+sid)
	select {
	case <-tb.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("первая вкладка не закрыта после вытеснения")
	}
	playRandom(t, tb2, rng, 80)

	// Выход в меню (сейв на паузе, догона нет) и «Продолжить» на 2x.
	ensureAlive(t, srv, tb2, sid)
	tb2.do(t, map[string]any{"type": "exit", "speed": 2})
	tb2.close(t, h, sid)
	tb = dialTab(t, srv, "?sid="+sid)
	if s := tb.first; !s.Resumed || s.Speed != 2 {
		t.Fatalf("«Продолжить» после exit: resumed=%v speed=%d", s.Resumed, s.Speed)
	}
	playRandom(t, tb, rng, 60)

	tb.do(t, map[string]any{"type": "set_speed", "speed": 0})

	res, recs := replayAndCompare(t, srv, sid)

	kinds := map[string]int{}
	var offline, took, rejected, debugOps int
	for _, r := range recs {
		kinds[r.K]++
		if r.K == "resume" {
			offline += r.Offline
			if r.Took {
				took++
			}
		}
		// Вытеснение видно одним из двух способов — гонка актора-старожила
		// с новым: end{evicted} старого, если он успел выйти раньше, чем
		// новый открыл журнал, иначе resume{took} нового.
		if r.K == "end" && r.Evicted {
			took++
		}
		if r.Err != "" {
			rejected++
		}
		if r.K == "debug" {
			debugOps++
		}
	}
	t.Logf("реплей: %d записей, %d тиков, итог день %d $%d; записи %v; офлайн %d тиков, отказов %d",
		res.Records, res.Ticks, res.Game.Day, res.Game.Money, kinds, offline, rejected)
	// Книга дня (ITGAME-73) — в сейве, значит в хэше и в побайтной сверке
	// выше; здесь — что партия её действительно наполнила: покупки и
	// debug-правки баланса (patch money → Adjust через тот же debugMutate).
	save := res.Game.Export()
	books := append([]game.DayLedger{}, save.LedgerHistory...)
	if save.Ledger != nil {
		books = append(books, *save.Ledger)
	}
	var purchases, adjusts int
	for _, l := range books {
		purchases += len(l.Purchases)
		if l.Adjust != 0 {
			adjusts++
		}
	}
	if purchases == 0 || adjusts == 0 {
		t.Errorf("книга дня пуста: покупок %d, дней с adjust %d (книг %d)", purchases, adjusts, len(books))
	}
	for _, w := range res.Warnings {
		t.Logf("предупреждение реплея: %s", w)
	}
	if len(res.Warnings) != 0 {
		t.Errorf("реплей ресинхронизировался по сейву (%d): вытеснение потеряло вход", len(res.Warnings))
	}
	if kinds["resume"] != 3 || took != 1 || offline == 0 {
		t.Errorf("resume=%d (ждали 3), вытеснений=%d (ждали 1), offline=%d (ждали > 0)", kinds["resume"], took, offline)
	}
	if kinds["start"] != 1 || kinds["end"] < 1 || kinds["day"] == 0 || kinds["cp"] == 0 || debugOps < 8 || rejected == 0 {
		t.Errorf("не все виды записей: %v, debug=%d, отказов=%d", kinds, debugOps, rejected)
	}
}

// TestJournalSeedZeroSurvivesResume — партия с ?seed=0 воспроизводима после
// реконнекта. До ITGAME-46 Restore считал сид 0 «сейвом без сида» и брал
// случайный PCG: реплей ловил это на записи resume (pre).
func TestJournalSeedZeroSurvivesResume(t *testing.T) {
	const sid = "journal-seed-zero"
	cfg := game.DefaultConfig()
	cfg.BreakdownChancePermille = 1000 // ролл на каждом тике: PCG должен совпасть
	h, srv := journalServer(t, cfg, 3*time.Millisecond, journalLimits{})
	rng := rand.New(rand.NewPCG(0, 0))
	tb := dialTab(t, srv, "?sid="+sid+"&seed=0")
	if tb.state().Seed != "0" {
		t.Fatalf("сид %q", tb.state().Seed)
	}
	playRandom(t, tb, rng, 40)
	tb.close(t, h, sid)
	tb = dialTab(t, srv, "?sid="+sid)
	playRandom(t, tb, rng, 40)
	tb.do(t, map[string]any{"type": "set_speed", "speed": 0})
	replayAndCompare(t, srv, sid)
}

// TestJournalStartsAtResumeAfterRestart — рестарт сервера (журналы только в
// памяти): журнал партии начинается с resume, в которой весь сейв, и реплей
// с неё сходится.
func TestJournalStartsAtResumeAfterRestart(t *testing.T) {
	const sid = "journal-restart-1"
	saves := newTestStore(t)
	h1, srv1 := journalServerWith(t, game.DefaultConfig(), 3*time.Millisecond, journalLimits{}, saves)
	rng := rand.New(rand.NewPCG(8, 8))
	tb := dialTab(t, srv1, "?sid="+sid+"&seed=8")
	ensureAlive(t, srv1, tb, sid)
	playRandom(t, tb, rng, 40)
	ensureAlive(t, srv1, tb, sid)
	tb.close(t, h1, sid)

	_, srv2 := journalServerWith(t, game.DefaultConfig(), 3*time.Millisecond, journalLimits{}, saves)
	tb = dialTab(t, srv2, "?sid="+sid)
	playRandom(t, tb, rng, 40)
	tb.do(t, map[string]any{"type": "set_speed", "speed": 0})
	res, recs := replayAndCompare(t, srv2, sid)
	if recs[0].K != "resume" || recs[0].Save == nil || res.FromSeq != 1 {
		t.Fatalf("журнал после рестарта начат с %q (save=%v), from seq %d", recs[0].K, recs[0].Save != nil, res.FromSeq)
	}
}

// TestTakeoverKeepsAckedCommand — вытеснение не теряет команду, которую
// прежний актор уже подтвердил своей вкладке (ITGAME-46). Крючок afterLoad
// держит новый актор между чтением сейва и стартом партии; в это окно
// старая вкладка шлёт hire. Пока Begin шёл после Load, старый актор успевал
// сохранить и подтвердить найм, а новый поднимал сейв без него: игрок видел
// «нанят», а сотрудник исчезал. Теперь команда либо в новой партии, либо не
// подтверждена; реплей вытеснения сходится без ресинка по сейву.
func TestTakeoverKeepsAckedCommand(t *testing.T) {
	const sid = "journal-takeover-1"
	cfg := game.DefaultConfig()
	cfg.StartMoney = 100000
	h, srv := journalServer(t, cfg, time.Hour, journalLimits{}) // без тиков: окно — только команда
	old := dialTab(t, srv, "?sid="+sid+"&seed=11")
	old.do(t, map[string]any{"type": "buy_pc", "office": 0})

	var acked bool
	h.afterLoad = func(string) {
		h.afterLoad = nil
		old.id++
		id := old.id
		_ = wsjson.Write(old.ctx, old.c, map[string]any{"type": "hire", "office": 0, "id": id}) // горутина актора: без t.Fatal
		deadline := time.Now().Add(300 * time.Millisecond)
		for time.Now().Before(deadline) {
			old.mu.Lock()
			acked = old.re >= id
			old.mu.Unlock()
			if acked {
				return
			}
			select {
			case <-old.closed:
				return
			case <-time.After(time.Millisecond):
			}
		}
	}
	tb := dialTab(t, srv, "?sid="+sid)
	staff := len(tb.first.Offices[0].Employees)
	t.Logf("старая вкладка получила подтверждение найма: %v; сотрудников в новой партии: %d", acked, staff)
	if acked && staff != 1 {
		t.Fatalf("найм подтверждён старой вкладке, но в поднятой партии сотрудников %d", staff)
	}
	tb.do(t, map[string]any{"type": "set_speed", "speed": 0})
	res, _ := replayAndCompare(t, srv, sid)
	if len(res.Warnings) != 0 {
		t.Fatalf("реплей вытеснения с ресинком: %v", res.Warnings)
	}
}

// TestJournalEndOnDebugDrop — обрыв сети без close-фрейма (POST
// /api/debug/drop, ITGAME-76): партия идёт, пока сторож не заметит, его
// таймаут — запись end{reason: debug_drop}; реконнект и реплей сходятся
// без предупреждений: сейв, который поднял сервер, — ровно конец журнала.
func TestJournalEndOnDebugDrop(t *testing.T) {
	const sid = "journal-drop-1"
	h, srv := journalServer(t, game.DefaultConfig(), 3*time.Millisecond, journalLimits{})
	rng := rand.New(rand.NewPCG(76, 76))
	tb := dialTab(t, srv, "?sid="+sid+"&seed=76")
	ensureAlive(t, srv, tb, sid)
	playRandom(t, tb, rng, 30)
	ensureAlive(t, srv, tb, sid)
	tb.do(t, map[string]any{"type": "set_speed", "speed": 2})
	debugPost(t, srv, "/api/debug/drop?sid="+sid+"&timeout=100", "")
	waitActorGone(t, h, sid)
	tb = dialTab(t, srv, "?sid="+sid)
	tb.do(t, map[string]any{"type": "set_speed", "speed": 0})
	res, recs := replayAndCompare(t, srv, sid)
	var end *journalRecord
	for i := range recs {
		if recs[i].K == "end" {
			end = &recs[i]
		}
	}
	if end == nil || end.Reason != "debug_drop" || end.Evicted || end.TK == 0 {
		t.Fatalf("end после debug-обрыва: %+v", end)
	}
	if len(res.Warnings) != 0 {
		t.Fatalf("предупреждения: %v", res.Warnings)
	}
}

// TestJournalRingTrimsAtCheckpoint — кольцо: журнал держится в лимите,
// голова срезана до чекпоинта, и реплей с него всё равно сходится.
func TestJournalRingTrimsAtCheckpoint(t *testing.T) {
	const sid = "journal-ring-1"
	lim := journalLimits{maxBytes: 96 << 10, segBytes: 16 << 10, maxSIDs: 4}
	_, srv := journalServer(t, game.DefaultConfig(), 2*time.Millisecond, lim)
	rng := rand.New(rand.NewPCG(7, 7))
	tb := dialTab(t, srv, "?sid="+sid+"&seed=99")
	debugPost(t, srv, "/api/debug/state", `{"sid":"`+sid+`","money":100000}`)
	deadline := time.Now().Add(20 * time.Second)
	for {
		playRandom(t, tb, rng, 50)
		raw := fetchJournal(t, srv, sid)
		var hdr journalHeader
		_ = json.Unmarshal(raw[:bytes.IndexByte(raw, '\n')], &hdr)
		if hdr.Dropped > 0 {
			if len(raw) > lim.maxBytes+4<<10 {
				t.Fatalf("журнал %d байт при лимите %d", len(raw), lim.maxBytes)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("кольцо так и не срезало голову")
		}
	}
	tb.do(t, map[string]any{"type": "set_speed", "speed": 0})
	res, recs := replayAndCompare(t, srv, sid)
	if res.FromSeq <= 1 || recs[0].K != "cp" {
		t.Fatalf("реплей не с чекпоинта: from seq %d, первая запись %q", res.FromSeq, recs[0].K)
	}
}

// TestJournalReplayFindsDivergence — подменённый вход реплей ловит на той же
// строке: хэш, позиция «ожидалось/получено», а на чекпоинте — diff сейва.
func TestJournalReplayFindsDivergence(t *testing.T) {
	const sid = "journal-diverge"
	cfg := game.DefaultConfig()
	cfg.StartMoney = 100000
	_, srv := journalServer(t, cfg, 3*time.Millisecond, journalLimits{})
	tb := dialTab(t, srv, "?sid="+sid+"&seed=5")
	for range 3 {
		tb.send(t, map[string]any{"type": "buy_pc", "office": 0})
		tb.send(t, map[string]any{"type": "hire", "office": 0})
	}
	tb.do(t, map[string]any{"type": "set_speed", "speed": 0})
	raw := fetchJournal(t, srv, sid)

	lines := bytes.Split(bytes.TrimSpace(raw), []byte("\n"))
	at := -1
	for i, l := range lines {
		if bytes.Contains(l, []byte(`"type":"hire"`)) {
			lines[i] = bytes.Replace(l, []byte(`"type":"hire"`), []byte(`"type":"buy_pc"`), 1)
			at = i + 1
			break
		}
	}
	if at < 0 {
		t.Fatalf("в журнале нет hire:\n%s", raw)
	}
	res, err := Replay(bytes.NewReader(bytes.Join(lines, []byte("\n"))))
	if err != nil {
		t.Fatal(err)
	}
	d := res.Divergence
	if d == nil || d.Line != at || d.Want == d.Got || !strings.Contains(d.WantPos, "money=") {
		t.Fatalf("ждали расхождение на строке %d, получили %+v", at, d)
	}
	t.Logf("отчёт:\n%s", d)

	// Расхождение на чекпоинте показывает поля сейва.
	cp := journalRecord{K: "cp", Seq: 2, Save: &game.Save{}, H: "x"}
	g := game.NewSeeded(cfg, 5)
	*cp.Save = g.Export()
	cp.Save.Money++
	hdr := lines[0]
	start := lines[1]
	cpb, _ := json.Marshal(cp)
	res, err = Replay(bytes.NewReader(bytes.Join([][]byte{hdr, start, cpb}, []byte("\n"))))
	if err != nil {
		t.Fatal(err)
	}
	if res.Divergence == nil || len(res.Divergence.Diff) == 0 || !strings.Contains(res.Divergence.Diff[0], "save.money") {
		t.Fatalf("diff сейва на чекпоинте: %+v", res.Divergence)
	}
}

// TestJournalEndpointGate — журнал только при Journal (ITGAME_DEBUG=1) и
// только для партий, которые сервер видел.
func TestJournalEndpointGate(t *testing.T) {
	h := &Handler{Config: game.DefaultConfig(), TickInterval: time.Hour}
	srv := httptest.NewServer(http.HandlerFunc(h.ServeDebug))
	defer srv.Close()
	get := func(q string) int {
		resp, err := http.Get(srv.URL + "/api/debug/journal" + q)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if c := get("?sid=bad"); c != http.StatusBadRequest {
		t.Errorf("плохой sid: %d", c)
	}
	if c := get("?sid=journal-off-1"); c != http.StatusNotFound {
		t.Errorf("журнал выключен: %d", c)
	}
	h.Journal = true
	if c := get("?sid=journal-none-1"); c != http.StatusNotFound {
		t.Errorf("неизвестный sid: %d", c)
	}
}
