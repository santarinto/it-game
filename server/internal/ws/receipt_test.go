package ws

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
)

// Квитанции команд без гонки с тиком (ITGAME-45). Клиент (net.ts) раньше
// закрывал квитанции FIFO на ЛЮБОМ state: тиковый снапшот, уже летящий к
// клиенту, или снапшот чужой команды (агент-наблюдатель /ws/agent) выдавался
// за ответ на команду, а настоящий error закрывал квитанцию следующей.
// Тесты моделируют обе стратегии клиента на реальном эфире сервера: FIFO
// обязан ошибаться (иначе тест не воспроизвёл гонку), квитанция по id —
// никогда.

// wireMsg — то, что клиент читает для квитанций: тип, код, re/rev/cause.
type wireMsg struct {
	Type  string `json:"type"`
	Code  string `json:"code"`
	Re    *int64 `json:"re"`
	Rev   uint64 `json:"rev"`
	Cause string `json:"cause"`
	Speed int    `json:"speed"`
	Phase string `json:"phase"`
}

// receipt — итог квитанции так, как его увидел бы клиент.
type receipt struct {
	found bool
	ok    bool
	code  string
	rev   uint64
}

// receiptFIFO — старая модель net.ts: первый state|error после отправки.
func receiptFIFO(after []wireMsg) receipt {
	for _, m := range after {
		switch m.Type {
		case "state":
			return receipt{found: true, ok: true, rev: m.Rev}
		case "error":
			return receipt{found: true, ok: false, code: m.Code, rev: m.Rev}
		}
	}
	return receipt{}
}

// receiptByID — новая модель: ответ — сообщение с re == id.
func receiptByID(msgs []wireMsg, id int64) receipt {
	for _, m := range msgs {
		if m.Re == nil || *m.Re != id {
			continue
		}
		switch m.Type {
		case "state":
			return receipt{found: true, ok: true, rev: m.Rev}
		case "error":
			return receipt{found: true, ok: false, code: m.Code, rev: m.Rev}
		}
	}
	return receipt{}
}

// readWire — следующее сообщение эфира.
func readWire(t *testing.T, ctx context.Context, c *websocket.Conn) wireMsg {
	t.Helper()
	var m wireMsg
	if err := wsjson.Read(ctx, c, &m); err != nil {
		t.Fatalf("read: %v", err)
	}
	return m
}

// readWireUntil — читать, пока не встретится подходящее; вернуть всё прочитанное.
func readWireUntil(t *testing.T, ctx context.Context, c *websocket.Conn, ok func(wireMsg) bool) []wireMsg {
	t.Helper()
	var got []wireMsg
	for i := 0; i < 5000; i++ {
		m := readWire(t, ctx, c)
		got = append(got, m)
		if ok(m) {
			return got
		}
	}
	t.Fatal("readWireUntil: 5000 сообщений без совпадения")
	return nil
}

// longDayConfig — день на десятки тысяч тиков: частый тикер не уводит
// партию в day_report (там тиковых снапшотов нет).
func longDayConfig() game.Config {
	cfg := savesTestConfig()
	cfg.TicksPerHour = 600 // день 5400 тиков: прогноз дня в снапшоте считается потиково
	cfg.WinTarget = 1 << 40
	return cfg
}

// Гонка 1: тиковый снапшот в пути, когда клиент шлёт команду. FIFO
// принимает его за успех; error, пришедший следом, сирота.
func TestReceiptTickRaceByID(t *testing.T) {
	c, ctx := dialTestServer(t, longDayConfig(), 2*time.Millisecond)
	readWire(t, ctx, c) // стартовый снапшот
	// Не читаем: тиковые снапшоты копятся в сокете — «уже в пути».
	time.Sleep(50 * time.Millisecond)
	// set_speed 9 — всегда bad_speed: отказ известен заранее.
	if err := wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 9, "id": 7}); err != nil {
		t.Fatal(err)
	}
	after := readWireUntil(t, ctx, c, func(m wireMsg) bool { return m.Type == "error" })

	if fifo := receiptFIFO(after); !fifo.ok {
		t.Fatalf("FIFO не ошибся — гонка не воспроизведена: %+v", after[:1])
	}
	got := receiptByID(after, 7)
	if !got.found || got.ok || got.code != "bad_speed" {
		t.Fatalf("квитанция id=7: %+v, хотим отказ bad_speed (эфир: %d сообщений, последнее %+v)",
			got, len(after), after[len(after)-1])
	}

	// Успешная команда: снапшот с re — её ответ, cause=cmd.
	if err := wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 2, "id": 8}); err != nil {
		t.Fatal(err)
	}
	after = readWireUntil(t, ctx, c, func(m wireMsg) bool { return m.Re != nil && *m.Re == 8 })
	last := after[len(after)-1]
	if last.Type != "state" || last.Speed != 2 || last.Cause != "cmd" {
		t.Fatalf("ответ id=8: %+v, хотим state speed 2 cause cmd", last)
	}
	for _, m := range after[:len(after)-1] {
		if m.Type == "state" && m.Cause != "tick" {
			t.Fatalf("тиковый снапшот с cause %q: %+v", m.Cause, m)
		}
	}
}

// Гонка 2: команда агента-наблюдателя рассылает снапшот всем, и FIFO
// вкладки закрывает им свою квитанцию. re адресный: вкладка его не видит,
// даже если id агента совпал с её id.
func TestReceiptObserverCommandByID(t *testing.T) {
	cfg := longDayConfig()
	base, _ := startDebugServer(t, cfg, time.Hour)

	pctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	player, _, err := websocket.Dial(pctx, "ws"+strings.TrimPrefix(base, "http")+"/ws?sid=receipt-obs-1", nil)
	if err != nil {
		t.Fatalf("player dial: %v", err)
	}
	t.Cleanup(func() { player.CloseNow() })
	readWire(t, pctx, player) // стартовый снапшот

	agent, actx := dialAgent(t, base, "?sid=receipt-obs-1")
	readWire(t, actx, agent) // снапшот при цеплянии

	// Агент нанимает с id=1 — тем же, что сейчас возьмёт вкладка.
	if err := wsjson.Write(actx, agent, map[string]any{"type": "hire", "office": 0, "id": 1}); err != nil {
		t.Fatal(err)
	}
	agentView := readWire(t, actx, agent)
	// Вкладка шлёт свою команду (отказ bad_speed) после снапшота агента.
	if err := wsjson.Write(pctx, player, map[string]any{"type": "set_speed", "speed": 9, "id": 1}); err != nil {
		t.Fatal(err)
	}
	after := readWireUntil(t, pctx, player, func(m wireMsg) bool { return m.Type == "error" })

	if fifo := receiptFIFO(after); !fifo.ok {
		t.Fatalf("FIFO вкладки не ошибся — гонка не воспроизведена: %+v", after)
	}
	if agentView.Type != "state" || agentView.Re == nil || *agentView.Re != 1 || agentView.Cause != "cmd" {
		t.Fatalf("агент: ответ на свой hire %+v, хотим state re=1 cause cmd", agentView)
	}
	if after[0].Type != "state" || after[0].Re != nil || after[0].Cause != "cmd" || after[0].Rev != agentView.Rev {
		t.Fatalf("вкладка: снапшот чужой команды %+v, хотим state без re, cause cmd, rev %d", after[0], agentView.Rev)
	}
	got := receiptByID(after, 1)
	if !got.found || got.ok || got.code != "bad_speed" {
		t.Fatalf("квитанция вкладки id=1: %+v, хотим отказ bad_speed", got)
	}
	if got.rev != agentView.Rev {
		t.Fatalf("error.rev %d, хотим текущий rev %d (отказ состояние не меняет)", got.rev, agentView.Rev)
	}
}

// delayProxy — TCP-прокси с задержкой каждого куска в обе стороны:
// искусственная задержка сокета (RTT ≈ 2·d) для ручного пункта ITGAME-45.
func delayProxy(t *testing.T, upstream string, d time.Duration) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	t.Cleanup(func() { ln.Close(); wg.Wait() })
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		type chunk struct {
			at   time.Time
			data []byte
		}
		ch := make(chan chunk, 1024)
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer dst.Close()
			for c := range ch {
				time.Sleep(time.Until(c.at.Add(d)))
				if _, err := dst.Write(c.data); err != nil {
					return
				}
			}
		}()
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				ch <- chunk{at: time.Now(), data: append([]byte(nil), buf[:n]...)}
			}
			if err != nil {
				close(ch)
				if err != io.EOF {
					src.Close()
				}
				return
			}
		}
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			cl, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", upstream)
			if err != nil {
				cl.Close()
				continue
			}
			wg.Add(2)
			go pipe(up, cl)
			go pipe(cl, up)
		}
	}()
	return ln.Addr().String()
}

// Ручной пункт ITGAME-45 автоматом: 50 команд подряд на 3× с задержкой
// сокета 40 мс в каждую сторону — ни одной ложной квитанции по id.
// Чётные — set_speed 3 (успех), нечётные — set_speed 9 (bad_speed):
// исход каждой команды известен заранее.
func TestReceiptFiftyCommandsAt3xWithLatency(t *testing.T) {
	srv := newSavesServer(t, &Handler{Config: longDayConfig(), TickInterval: 30 * time.Millisecond})
	addr := delayProxy(t, strings.TrimPrefix(srv.URL, "http://"), 40*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws://"+addr+"/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	readWire(t, ctx, c)

	const n = 50
	// Читатель — отдельная горутина: команды уходят конвейером, не дожидаясь ответов.
	inbox := make(chan wireMsg, 4096)
	go func() {
		defer close(inbox)
		for {
			var m wireMsg
			if wsjson.Read(ctx, c, &m) != nil {
				return
			}
			inbox <- m
		}
	}()
	// sentBefore[i] — сколько сообщений клиент прочитал до отправки i: FIFO
	// закрывает квитанцию первым state|error ПОСЛЕ отправки.
	var (
		mu   sync.Mutex
		seen []wireMsg
	)
	collect := func(stop func() bool, timeout time.Duration) {
		deadline := time.After(timeout)
		for !stop() {
			select {
			case m, ok := <-inbox:
				if !ok {
					return
				}
				mu.Lock()
				seen = append(seen, m)
				mu.Unlock()
			case <-deadline:
				return
			}
		}
	}
	if err := wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 3, "id": 1000}); err != nil {
		t.Fatal(err)
	}
	sentAt := make([]int, n)
	for i := 0; i < n; i++ {
		speed := 3
		if i%2 == 1 {
			speed = 9
		}
		mu.Lock()
		sentAt[i] = len(seen)
		mu.Unlock()
		if err := wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": speed, "id": i + 1}); err != nil {
			t.Fatal(err)
		}
		// Пауза между командами больше тика на 3× (10 мс): тики успевают
		// пройти между командами — FIFO обязан путаться.
		collect(func() bool { return false }, 25*time.Millisecond)
	}
	answered := func() bool {
		mu.Lock()
		defer mu.Unlock()
		got := 0
		for _, m := range seen {
			if m.Re != nil && *m.Re >= 1 && *m.Re <= n {
				got++
			}
		}
		return got >= n
	}
	collect(answered, 5*time.Second)

	mu.Lock()
	defer mu.Unlock()
	fifoWrong, prevRev := 0, uint64(0)
	for i := 0; i < n; i++ {
		wantOK := i%2 == 0
		got := receiptByID(seen, int64(i+1))
		if !got.found {
			t.Fatalf("команда %d: квитанции нет", i+1)
		}
		if got.ok != wantOK || (!wantOK && got.code != "bad_speed") {
			t.Fatalf("команда %d: ложная квитанция %+v, хотим ok=%v", i+1, got, wantOK)
		}
		count := 0
		for _, m := range seen {
			if m.Re != nil && *m.Re == int64(i+1) {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("команда %d: %d сообщений с re, хотим ровно одно", i+1, count)
		}
	}
	// FIFO на том же эфире: i-я квитанция закрывается i-м state|error после
	// отправки первой (очередь), а не своим ответом.
	queue := []int{}
	next := 0
	for idx, m := range seen {
		for next < n && sentAt[next] <= idx {
			queue = append(queue, next)
			next++
		}
		if (m.Type == "state" || m.Type == "error") && len(queue) > 0 {
			i := queue[0]
			queue = queue[1:]
			if (m.Type == "state") != (i%2 == 0) {
				fifoWrong++
			}
		}
		if m.Type == "state" {
			if m.Rev <= prevRev {
				t.Fatalf("rev не растёт: %d после %d", m.Rev, prevRev)
			}
			prevRev = m.Rev
		}
	}
	if fifoWrong == 0 {
		t.Fatalf("FIFO не ошибся ни разу на %d сообщениях — гонка не воспроизведена", len(seen))
	}
	t.Logf("эфир: %d сообщений, FIFO ошибся бы %d раз из %d, по id — 0", len(seen), fifoWrong, n)
}

// rev/cause (ITGAME-45): start → cmd → debug; отказ rev не двигает; копии
// (GET /api/debug/state, снапшот наблюдателя, agent_status) несут текущий rev.
func TestStateRevAndCause(t *testing.T) {
	base, _ := startDebugServer(t, longDayConfig(), time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/ws?sid=rev-cause-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })

	first := readWire(t, ctx, c)
	if first.Type != "state" || first.Rev != 1 || first.Cause != "start" || first.Re != nil {
		t.Fatalf("старт: %+v, хотим rev 1 cause start без re", first)
	}
	// Команда без id — как старый бандл: снапшот без re, rev растёт.
	wsjson.Write(ctx, c, map[string]any{"type": "hire", "office": 0})
	noID := readWire(t, ctx, c)
	if noID.Type != "state" || noID.Rev != 2 || noID.Cause != "cmd" || noID.Re != nil {
		t.Fatalf("команда без id: %+v, хотим rev 2 cause cmd без re", noID)
	}
	// Отказ: rev текущий, не растёт.
	wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 9, "id": 5})
	if e := readWire(t, ctx, c); e.Type != "error" || e.Rev != 2 || e.Re == nil || *e.Re != 5 {
		t.Fatalf("отказ: %+v, хотим error rev 2 re 5", e)
	}
	// Чит через HTTP: рассылка с cause debug, в ответе тот же rev.
	code, body := httpDebug(t, base, http.MethodPost, "/api/debug/state", `{"sid":"rev-cause-1","money":12345}`)
	if code != http.StatusOK {
		t.Fatalf("patch: %d %v", code, body)
	}
	if rev := num(t, stateOf(t, body["state"])["rev"]); rev != 3 {
		t.Fatalf("patch: state.rev %d, хотим 3", rev)
	}
	pushed := readWire(t, ctx, c)
	if pushed.Type != "state" || pushed.Rev != 3 || pushed.Cause != "debug" {
		t.Fatalf("пуш отладки: %+v, хотим rev 3 cause debug", pushed)
	}
	// GET — копия: rev и cause текущие, без новой версии.
	_, body = httpDebug(t, base, http.MethodGet, "/api/debug/state?sid=rev-cause-1", "")
	st := stateOf(t, body["state"])
	if num(t, st["rev"]) != 3 || st["cause"] != "debug" {
		t.Fatalf("GET state: rev %v cause %v, хотим 3/debug", st["rev"], st["cause"])
	}
	// Промотка: ответ advance несёт state.rev новой версии.
	code, body = httpDebug(t, base, http.MethodPost, "/api/debug/advance", `{"sid":"rev-cause-1","ticks":3}`)
	if code != http.StatusOK || num(t, stateOf(t, body["state"])["rev"]) != 4 {
		t.Fatalf("advance: %d %v, хотим state.rev 4", code, body["state"])
	}
	if m := readWire(t, ctx, c); m.Rev != 4 || m.Cause != "debug" {
		t.Fatalf("пуш advance: %+v", m)
	}

	// Наблюдатель: первый снапшот — копия текущей версии.
	agent, actx := dialAgent(t, base, "?sid=rev-cause-1")
	if m := readWire(t, actx, agent); m.Type != "state" || m.Rev != 4 {
		t.Fatalf("снапшот наблюдателя: %+v, хотим rev 4", m)
	}
	// agent_status и agent_result: rev и re запроса.
	wsjson.Write(actx, agent, map[string]any{"type": "status", "id": 11})
	var status agentStatusMessage
	readAgentJSON(t, actx, agent, "agent_status", &status)
	if status.Rev != 4 || status.Re != 11 {
		t.Fatalf("agent_status: rev %d re %d, хотим 4/11", status.Rev, status.Re)
	}
	wsjson.Write(actx, agent, map[string]any{"type": "debug_patch", "money": 777, "id": 12})
	var res agentResultMessage
	readAgentJSON(t, actx, agent, "agent_result", &res)
	if !res.OK || res.Rev != 5 || res.Re != 12 {
		t.Fatalf("agent_result: %+v, хотим ok rev 5 re 12", res)
	}
	wsjson.Write(actx, agent, map[string]any{"type": "debug_scenario", "scenario": "nope", "id": 13})
	readAgentJSON(t, actx, agent, "agent_result", &res)
	if res.OK || res.Rev != 5 || res.Re != 13 {
		t.Fatalf("agent_result отказа: %+v, хотим !ok rev 5 re 13", res)
	}

	// Команда после отладки: ответ по re, как у вкладки.
	wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 1, "id": 6})
	readWireUntil(t, ctx, c, func(m wireMsg) bool { return m.Re != nil && *m.Re == 6 })
}

// readAgentJSON — читать эфир агента до сообщения типа typ и разобрать его в out.
func readAgentJSON(t *testing.T, ctx context.Context, c *websocket.Conn, typ string, out any) {
	t.Helper()
	for i := 0; i < 200; i++ {
		var raw json.RawMessage
		if err := wsjson.Read(ctx, c, &raw); err != nil {
			t.Fatalf("agent read: %v", err)
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &head) == nil && head.Type == typ {
			if err := json.Unmarshal(raw, out); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatalf("%s не пришёл", typ)
}

// Тиковые снапшоты: cause tick, rev +1 на каждый.
func TestStateRevTicks(t *testing.T) {
	c, ctx := dialTestServer(t, longDayConfig(), 5*time.Millisecond)
	prev := readWire(t, ctx, c)
	for i := 0; i < 5; i++ {
		m := readWire(t, ctx, c)
		if m.Type != "state" || m.Cause != "tick" || m.Rev != prev.Rev+1 {
			t.Fatalf("тик %d: %+v после rev %d", i, m, prev.Rev)
		}
		prev = m
	}
}

// rev переживает resume через сейв: первый снапшот нового соединения —
// cause resume и rev выше всего, что видело прошлое (в т.ч. тиков после сейва).
func TestStateRevSurvivesResume(t *testing.T) {
	saves := newTestStore(t)
	cfg := longDayConfig()
	c, ctx := dialSaves(t, saves, cfg, 5*time.Millisecond, "?sid=rev-resume-1")
	var last wireMsg
	for i := 0; i < 6; i++ {
		last = readWire(t, ctx, c)
	}
	wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 0, "id": 1})
	got := readWireUntil(t, ctx, c, func(m wireMsg) bool { return m.Re != nil && *m.Re == 1 })
	last = got[len(got)-1]
	c.CloseNow()

	c2, ctx2 := dialSaves(t, saves, cfg, 5*time.Millisecond, "?sid=rev-resume-1")
	first := readWire(t, ctx2, c2)
	if first.Type != "state" || first.Cause != "resume" || first.Rev != last.Rev+1 {
		t.Fatalf("resume: %+v, хотим cause resume rev %d", first, last.Rev+1)
	}
	if s := loadSave(t, saves, "rev-resume-1"); s.Rev != first.Rev {
		t.Fatalf("сейв rev %d, хотим %d (rev снапшота, разосланного после сейва)", s.Rev, first.Rev)
	}
}
