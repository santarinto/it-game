package ws

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// Журнал партии (ITGAME-46): при ITGAME_DEBUG=1 (Handler.Journal) актор
// сессии пишет JSONL — заголовок партии и каждый вход с позицией в игре и
// хэшем состояния после него. Движок детерминирован (PCG по сиду, в
// internal/game нет time.Now), поэтому сид + входы по тикам = вся партия:
// реплеер (replay.go, server/cmd/replay) прогоняет журнал на game.Game и
// сверяет хэши — первое расхождение и есть место, где сломался детерминизм.
//
// Формат — строка на запись, первая всегда header:
//
//	{"k":"header","v":1,"sid":…,"seed":"42","difficulty":"normal","scenario":"","cfgHash":…,"version":…,"config":{…}}
//	{"k":"start","seq":1,"rev":1,"day":1,"tick":0,"money":200,"phase":"running","speed":1,"h":…}
//	{"k":"cmd","seq":2,"tk":7,"rev":9,…,"id":3,"type":"hire","office":0,"h":…}
//	{"k":"day","seq":3,"tk":47,…,"phase":"day_report","h":…}
//	{"k":"cp","seq":4,…,"save":{…},"rng":"…","h":…}
//	{"k":"end","seq":5,"tk":3,…,"h":…}
//	{"k":"resume","seq":6,…,"pre":…,"offline":61,"save":{…},"saveSpeed":3,"h":…}
//
// tk — сколько раз актор звал g.Tick() с прошлой записи: реплей прогоняет
// эти тики перед входом записи. Темп (speed) в журнале — только поле
// снапшота: на логику он не влияет, лишь на частоту тиков, которая и так
// сведена к числу tk. Нечистые входы — явные записи: resume (pre — хэш
// сейва после Restore, до догона; offline — тики догона, посчитанные от
// wall-clock; save — сам сейв), end (разрыв/вытеснение). Вытеснение —
// гонка двух акторов: тик или команда старого между Load и Begin нового
// попадают в журнал, но не в поднятый сейв, — реплей на такой resume
// ресинхронизируется по save с предупреждением, а не падает. Чекпоинт cp —
// полное состояние (сейв + позиция PCG) в конце каждого дня и внеочередной
// раз на каждые journalSegBytes: с него реплей стартует, когда кольцо
// срезало голову.

// Лимиты журнала: на sid и число sid в памяти.
const (
	journalVersion  = 1
	journalMaxBytes = 4 << 20   // потолок одного журнала; сверху режется кольцом по чекпоинтам
	journalSegBytes = 256 << 10 // внеочередной чекпоинт, если столько записано без него
	journalMaxSIDs  = 64        // журналов в памяти; старейший закрытый вытесняется
)

// journalHeader — первая строка журнала: всё, чтобы собрать партию заново.
type journalHeader struct {
	K          string      `json:"k"` // всегда "header"
	V          int         `json:"v"`
	SID        string      `json:"sid"`
	Seed       string      `json:"seed"`
	Difficulty string      `json:"difficulty"`
	Scenario   string      `json:"scenario"` // фикстура старта; "" — обычная партия
	CfgHash    string      `json:"cfgHash"`
	Version    string      `json:"version"` // sha сервера, писавшего журнал
	Started    string      `json:"started"` // для людей; реплей не читает
	Dropped    int         `json:"dropped"` // записей срезано кольцом с головы
	Overflow   bool        `json:"overflow,omitempty"`
	Config     game.Config `json:"config"`
}

// journalRecord — запись журнала. Общие поля — позиция и хэш состояния
// ПОСЛЕ входа; остальные — по виду записи (k).
type journalRecord struct {
	K     string `json:"k"` // start | cmd | debug | day | resume | cp | end
	Seq   uint64 `json:"seq"`
	TK    int    `json:"tk,omitempty"` // тиков g.Tick() с прошлой записи
	Rev   uint64 `json:"rev"`          // rev снапшота после входа (ITGAME-45)
	Day   int    `json:"day"`
	Tick  int    `json:"tick"`
	Money int    `json:"money"`
	Phase string `json:"phase"`
	Speed int    `json:"speed"`
	H     string `json:"h"` // journalHash после входа

	// cmd: команда клиента как пришла; err — отказ (состояние не менялось).
	ID     int64  `json:"id,omitempty"`
	Type   string `json:"type,omitempty"`
	Office int    `json:"office,omitempty"`
	Slot   int    `json:"slot,omitempty"`
	Arg    int    `json:"arg,omitempty"` // speed команды: set_speed, exit
	Err    string `json:"err,omitempty"`

	// debug: мутирующий запрос /api/debug/* или debug_* моста.
	Op       string          `json:"op,omitempty"` // patch | scenario | restore | advance
	Patch    *debugPatch     `json:"patch,omitempty"`
	State    json.RawMessage `json:"state,omitempty"`
	Scenario string          `json:"scenario,omitempty"` // debug scenario; у cp — текущая фикстура
	Days     int             `json:"days,omitempty"`
	Ticks    int             `json:"ticks,omitempty"`

	// resume: Pre — хэш восстановленного сейва до догона, Offline — тики
	// догона; Save/SaveSpeed/RS/Scenario — сам этот сейв: с него реплей
	// стартует (журнал начат после рестарта сервера) или ресинхронизируется
	// после вытеснения.
	Pre       string `json:"pre,omitempty"`
	Offline   int    `json:"offline,omitempty"`
	SaveSpeed int    `json:"saveSpeed,omitempty"`
	Took      bool   `json:"took,omitempty"` // прежний актор не закрыл журнал и за journalTakeoverWait — перехвачен

	// cp (и resume): полное состояние; RS — скорость возврата после exit (ITGAME-65).
	Save *game.Save `json:"save,omitempty"`
	RNG  []byte     `json:"rng,omitempty"`
	RS   int        `json:"rs,omitempty"`

	// end: Evicted — сессию забрал другой актор; Reason — read_timeout |
	// debug_drop, если вкладку закрыл сторож чтения (ITGAME-76), иначе
	// разрыв со стороны клиента. Партия до этого шла вживую — её тики уже в tk.
	Evicted bool   `json:"evicted,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// journalHash — отпечаток состояния: сейв (все поля игры), снапшот
// протокола (производные: доход, сеть, прогноз; с темпом и фикстурой, без
// rev/cause) и позиция PCG. 16 hex — с запасом для сверки одной партии.
func journalHash(g *game.Game, speed int, scenario string) string {
	h := sha256.New()
	enc := json.NewEncoder(h)
	_ = enc.Encode(g.Export())
	_ = enc.Encode(snapshot(g, speed, false, scenario))
	h.Write(g.RNGState())
	return hex.EncodeToString(h.Sum(nil)[:8])
}

func configHash(cfg game.Config) string {
	b, _ := json.Marshal(cfg)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// restorable — из этой фазы есть сейв (game.Restore): чекпоинт возможен.
func restorable(g *game.Game) bool {
	return g.Phase == game.PhaseRunning || g.Phase == game.PhaseDayReport
}

// ── Хранилище ──────────────────────────────────────────────────────────────

type journalStore struct {
	mu     sync.Mutex
	bySID  map[string]*journal
	clock  uint64
	limits journalLimits
}

type journalLimits struct{ maxBytes, segBytes, maxSIDs int }

type journalLine struct {
	b  []byte
	cp bool
}

// journal — журнал одной партии sid. owner — актор, который пишет сейчас:
// новый актор (реконнект, вытеснение) перехватывает журнал, записи старого
// после этого молча отбрасываются — как и его сейвы (store.Begin).
type journal struct {
	header  journalHeader
	recs    []journalLine
	bytes   int
	seq     uint64
	sinceCP int
	ticks   int // тиков с прошлой записи (поле tk следующей)
	owner   *journalWriter
	touched uint64
}

func (h *Handler) journalStore() *journalStore {
	h.debugMu.Lock()
	defer h.debugMu.Unlock()
	if h.journals == nil {
		lim := h.journalLimits
		if lim == (journalLimits{}) {
			lim = journalLimits{maxBytes: journalMaxBytes, segBytes: journalSegBytes, maxSIDs: journalMaxSIDs}
		}
		h.journals = &journalStore{bySID: map[string]*journal{}, limits: lim}
	}
	return h.journals
}

// put — новый журнал sid вместо прежнего; при переполнении вытесняется
// старейший закрытый (без владельца), а если все живые — просто старейший.
func (st *journalStore) put(sid string, j *journal) {
	if _, ok := st.bySID[sid]; !ok && len(st.bySID) >= st.limits.maxSIDs {
		victim, vt, closed := "", ^uint64(0), false
		for s, o := range st.bySID {
			c := o.owner == nil
			if (c && !closed) || (c == closed && o.touched < vt) {
				victim, vt, closed = s, o.touched, c
			}
		}
		delete(st.bySID, victim)
	}
	st.clock++
	j.touched = st.clock
	st.bySID[sid] = j
}

// appendLocked — дописать запись; при need — следом чекпоинт. Режет голову
// кольцом: до ближайшего чекпоинта, после которого журнал влезает в лимит.
func (st *journalStore) appendLocked(j *journal, b []byte, cp bool) {
	if j.header.Overflow || b == nil {
		return
	}
	j.recs = append(j.recs, journalLine{b: b, cp: cp})
	j.bytes += len(b) + 1
	j.sinceCP += len(b) + 1
	if cp {
		j.sinceCP = 0
	}
	st.clock++
	j.touched = st.clock
	if j.bytes <= st.limits.maxBytes {
		return
	}
	cut, prefix := -1, 0
	for i, r := range j.recs {
		if i > 0 && r.cp {
			cut = i
			if j.bytes-prefix <= st.limits.maxBytes {
				break
			}
		}
		prefix += len(r.b) + 1
	}
	if cut <= 0 {
		// Чекпоинта нет (финал партии без сейва и шквал отказов): журнал
		// растёт до двух лимитов, дальше запись останавливается с меткой.
		if j.bytes > 2*st.limits.maxBytes {
			j.header.Overflow = true
		}
		return
	}
	for _, r := range j.recs[:cut] {
		j.bytes -= len(r.b) + 1
	}
	j.header.Dropped += cut
	j.recs = append([]journalLine(nil), j.recs[cut:]...)
}

// dump — журнал целиком: header и записи, по строке.
func (st *journalStore) dump(sid string) ([]byte, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	j := st.bySID[sid]
	if j == nil {
		return nil, false
	}
	hb, _ := json.Marshal(j.header)
	out := make([]byte, 0, len(hb)+1+j.bytes)
	out = append(append(out, hb...), '\n')
	for _, r := range j.recs {
		out = append(append(out, r.b...), '\n')
	}
	return out, true
}

// ── Писатель (актор) ───────────────────────────────────────────────────────

// journalWriter — сторона актора: держит указатели на его переменные
// (игра, темп, фикстура, rev) и читает их в момент записи. nil — журнал
// выключен: все методы — no-op, точки вызова в run() без условий.
type journalWriter struct {
	st          *journalStore
	j           *journal
	g           **game.Game
	speed       *int
	resumeSpeed *int
	scenario    *string
	rv          *revClock
	done        chan struct{} // закрыт после end: следующий актор ждёт его, прежде чем писать resume
}

// journalTakeoverWait — сколько новый актор ждёт end вытесненного. Тот после
// пинка (store.Begin) выходит за одну итерацию цикла, а его последний
// сохранённый тик ложится в журнал уже после сейва — без ожидания он мог
// прийти, когда журнал перехвачен, и пропасть (сейв с тиком, журнал без).
const journalTakeoverWait = time.Second

// resumeTrace — что resume() видел до офлайн-догона: восстановленный сейв
// (PCG после Restore — с начала по сиду, сохранять нечего), темп, фикстура,
// rev и число тиков догона. nil — журнал выключен.
type resumeTrace struct {
	save     game.Save
	speed    int
	rs       int // ResumeSpeed сейва (ITGAME-65)
	scenario string
	rev      uint64
	offline  int
}

// capture — снять состояние сразу после game.Restore, до догона. Только
// копия: хэш считает openJournal уже после Begin — resume() идёт между Load
// и Begin, и окно гонки с прежним актором расширять нельзя.
func (rt *resumeTrace) capture(g *game.Game, speed, rs int, scenario string, rev uint64, offline int) {
	if rt == nil {
		return
	}
	rt.save = g.Export()
	rt.speed, rt.rs, rt.scenario, rt.rev, rt.offline = speed, rs, scenario, rev, offline
}

// preHash — хэш сейва до догона: тот же Restore, что сделал resume(), PCG с
// начала по сиду; копия сейва — Restore берёт его слайсы себе.
func (rt *resumeTrace) preHash() string {
	g, err := game.Restore(rt.save)
	if err != nil {
		return "" // resume() этот же сейв восстановил — сюда не попасть
	}
	h := journalHash(g, rt.speed, rt.scenario)
	rt.save = g.Export()
	return h
}

// openJournal — актор начал партию: новая — новый журнал (header + start),
// восстановленная — запись resume в журнал sid; если журнала нет (рестарт
// сервера, журнал вытеснен), он начинается с resume — в ней весь сейв.
func (h *Handler) openJournal(sid string, g **game.Game, speed, resumeSpeed *int, scenario *string, rv *revClock, resumed bool, rt *resumeTrace) *journalWriter {
	if !h.Journal || !store.ValidSID(sid) {
		return nil
	}
	st := h.journalStore()
	w := &journalWriter{st: st, g: g, speed: speed, resumeSpeed: resumeSpeed, scenario: scenario, rv: rv,
		done: make(chan struct{})}
	cur := *g

	st.mu.Lock()
	defer st.mu.Unlock()
	if prev := st.bySID[sid]; resumed && prev != nil && prev.owner != nil {
		// Вытеснение: Begin уже пнул прежнего актора — дождаться его end,
		// чтобы все его сохранённые входы легли в журнал до нашего resume.
		done := prev.owner.done
		st.mu.Unlock()
		select {
		case <-done:
		case <-time.After(journalTakeoverWait):
		}
		st.mu.Lock()
	}
	j := st.bySID[sid]
	if !resumed || j == nil || j.header.Overflow {
		j = &journal{header: journalHeader{
			K: "header", V: journalVersion, SID: sid, Seed: cur.SeedString(),
			Difficulty: string(cur.Config().Difficulty), Scenario: *scenario,
			CfgHash: configHash(cur.Config()), Version: serverVersion(),
			Started: time.Now().UTC().Format(time.RFC3339), Config: cur.Config(),
		}}
		st.put(sid, j)
	}
	took := j.owner != nil
	j.owner = w
	w.j = j
	if !resumed {
		w.writeLocked(journalRecord{K: "start"})
		return w
	}
	rec := journalRecord{K: "resume", Took: took}
	if rt != nil {
		rec.Pre = rt.preHash()
		s := rt.save
		rec.Offline, rec.Save = rt.offline, &s
		rec.SaveSpeed, rec.RS, rec.Scenario = rt.speed, rt.rs, rt.scenario
	}
	w.writeLocked(rec)
	return w
}

// mustJSON — запись журнала в JSON. Все её типы маршалятся; ошибка — баг:
// в лог, запись пропускается (отладочный журнал не роняет сессию).
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("журнал партии: %v", err)
		return nil
	}
	return b
}

func (w *journalWriter) nextSeq(j *journal) uint64 {
	j.seq++
	return j.seq
}

// stamp — общие поля: позиция, темп и хэш состояния ПОСЛЕ входа.
func (w *journalWriter) stamp(rec *journalRecord) {
	g := *w.g
	rec.Rev, rec.Day, rec.Tick, rec.Money = w.rv.rev, g.Day, g.TickInDay, g.Money
	rec.Phase, rec.Speed = string(g.Phase), *w.speed
	rec.H = journalHash(g, *w.speed, *w.scenario)
}

// write — дописать запись, если журнал всё ещё наш (вытесненный актор
// пишет в никуда, как и его сейвы).
func (w *journalWriter) write(rec journalRecord) {
	if w == nil {
		return
	}
	w.st.mu.Lock()
	defer w.st.mu.Unlock()
	if w.j.owner != w {
		return
	}
	w.writeLocked(rec)
}

// writeLocked — запись под st.mu; чекпоинт следом — в конце дня и
// внеочередной, если давно не было (кольцу нужно, где резать).
func (w *journalWriter) writeLocked(rec journalRecord) {
	j := w.j
	w.stamp(&rec)
	rec.Seq, rec.TK = w.nextSeq(j), j.ticks
	j.ticks = 0
	// resume несёт сейв — с неё реплей тоже может начаться (точка среза кольца)
	w.st.appendLocked(j, mustJSON(rec), rec.K == "resume" && rec.Save != nil)
	g := *w.g
	if !restorable(g) || (rec.K != "day" && j.sinceCP < w.st.limits.segBytes) {
		return
	}
	save := g.Export()
	cp := journalRecord{K: "cp", Save: &save, RNG: g.RNGState(), Scenario: *w.scenario, RS: *w.resumeSpeed}
	w.stamp(&cp)
	cp.Seq = w.nextSeq(j)
	w.st.appendLocked(j, mustJSON(cp), true)
}

// tick — актор позвал g.Tick(). mark — тик закрыл день или партию: запись
// day (веха для реплея и точка чекпоинта); иначе только счётчик tk.
func (w *journalWriter) tick(mark bool) {
	if w == nil {
		return
	}
	w.st.mu.Lock()
	defer w.st.mu.Unlock()
	if w.j.owner != w {
		return
	}
	w.j.ticks++
	if mark {
		w.writeLocked(journalRecord{K: "day"})
	}
}

// command — команда клиента после обработки; rejected — отказ (только
// отправителю, состояние не менялось), запись всё равно нужна: реплей
// сверяет, что отказ воспроизводится.
func (w *journalWriter) command(cmd clientCommand, rejected *errorMessage) {
	if w == nil {
		return
	}
	rec := journalRecord{K: "cmd", ID: cmd.ID, Type: string(cmd.Cmd), Office: cmd.Office, Slot: cmd.Slot, Arg: cmd.Speed}
	if rejected != nil {
		rec.Err = rejected.Code
	}
	w.write(rec)
}

// debug — debug-запрос после applyDebug. Пишутся только мутирующие
// (mutated — rev вырос): чтение и отказы состояние не трогают.
func (w *journalWriter) debug(req debugRequest, mutated bool) {
	if w == nil || !mutated {
		return
	}
	rec := journalRecord{K: "debug", Op: req.kind}
	switch req.kind {
	case kindPatch:
		p := req.patch
		rec.Patch = &p
	case kindRestore:
		rec.State = req.state
	case kindScenario:
		rec.Scenario = req.scenario
	case kindAdvance:
		rec.Days, rec.Ticks = req.days, req.ticks
	}
	w.write(rec)
}

// end — актор вышел: разрыв, abandon, вытеснение или таймаут сторожа (reason).
func (w *journalWriter) end(evicted bool, reason string) {
	if w == nil {
		return
	}
	defer close(w.done)
	w.st.mu.Lock()
	defer w.st.mu.Unlock()
	if w.j.owner != w {
		return
	}
	w.writeLocked(journalRecord{K: "end", Evicted: evicted, Reason: reason})
	w.j.owner = nil
}

// ── HTTP: GET /api/debug/journal?sid= ──────────────────────────────────────

func (h *Handler) serveJournal(w http.ResponseWriter, r *http.Request) {
	sid := r.URL.Query().Get("sid")
	if !store.ValidSID(sid) {
		writeDebugErr(w, http.StatusBadRequest, "bad_sid")
		return
	}
	if !h.Journal {
		writeDebugErr(w, http.StatusNotFound, "journal_off: журнал пишет только сервер с ITGAME_DEBUG=1")
		return
	}
	body, ok := h.journalStore().dump(sid)
	if !ok {
		writeDebugErr(w, http.StatusNotFound, "no_journal: партии с этим sid сервер не видел с запуска")
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="journal-`+sid+`.jsonl"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
