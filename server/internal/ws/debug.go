package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"itdirector/internal/game"
	"itdirector/internal/metrics"
	"itdirector/internal/store"
)

// Сервер отладки (ITGAME-26): HTTP-маршруты /api/debug/* и журнал событий
// сессии. Регистрация в mux — за гейтом ITGAME_DEBUG=1 (см. newMux в
// server/cmd/server/main.go); без флага маршруты не зарегистрированы вовсе,
// и ServeMux отдаёт честный 404. Сами хендлеры в этом файле авторизацию не
// проверяют — гейт целиком на стороне вызывающего кода.
//
// Состоянием игры владеет актор сессии (run), поэтому HTTP-хендлер не трогает
// игру напрямую: он находит в реестре канал живого актора и шлёт запрос туда.
// Всё чтение/мутация происходят в актор-горутине — мьютексы не нужны.

// ── Журнал событий сессии ──────────────────────────────────────────────────

// eventJournal — кольцевой журнал итогов: строки отчётов дней, финалы,
// debug-действия. Живёт в акторе, персистится в сейве сессии.
type eventJournal struct {
	items []string
	cap   int
}

func newEventJournal(capacity int) *eventJournal {
	return &eventJournal{cap: capacity}
}

func (j *eventJournal) add(line string) {
	j.items = append(j.items, line)
	if len(j.items) > j.cap {
		j.items = j.items[len(j.items)-j.cap:]
	}
}

// addReport — строки отчёта дня: самой сводки плюс по строке на событие.
func (j *eventJournal) addReport(r *game.DayReport) {
	j.add(fmt.Sprintf("д%d · отчёт: доход $%d, ФОТ $%d, баланс $%d (инцидентов %d)",
		r.Day, r.Income, r.Payroll+r.GatewayOpex, r.Balance, r.Incidents))
	for _, ev := range r.Events {
		j.add(fmt.Sprintf("д%d · %s", r.Day, ev))
	}
}

func (j *eventJournal) last(n int) []string {
	if n <= 0 || n > len(j.items) {
		n = len(j.items)
	}
	out := make([]string, n)
	copy(out, j.items[len(j.items)-n:])
	return out
}

// ── Запросы к актору ───────────────────────────────────────────────────────

// Kind'ы запросов к актору сессии.
const (
	kindState      = "state"       // полный снапшот + сейв
	kindPatch      = "patch"       // точечный чит {money, day, tickInDay}
	kindCheatMoney = "cheat_money" // +деньги с localhost (ITGAME-194); актор переводит в kindPatch
	kindRestore    = "restore"     // полное состояние (itd.restore)
	kindScenario   = "scenario"    // пересоздать партию фикстурой
	kindAdvance    = "advance"     // промотка днями/тиками (движок offline)
	kindEvents     = "events"      // хвост журнала событий
	kindLedger     = "ledger"      // книга дня (ITGAME-73)
	kindFormat     = "format"      // метка формата сейва (ITGAME-154): сейв, не игра
)

// debugRequest — запрос HTTP-хендлера к актору. Reply буферизован: актор
// не ждёт читателя.
type debugRequest struct {
	kind     string
	patch    debugPatch
	add      int             // kind=cheat_money: сколько прибавить к балансу
	state    json.RawMessage // kind=restore: дельта над текущим состоянием
	scenario string          // kind=scenario
	days     int             // kind=advance
	ticks    int             // kind=advance
	n        int             // kind=events
	day      int             // kind=ledger: 0 — текущий день
	format   int             // kind=format: game.format, которым актор пишет сейв
	Reply    chan debugReply
}

// debugPatch — чит для точечного патча живой игры. nil-поля не трогаются.
type debugPatch struct {
	Money     *int `json:"money"`
	Day       *int `json:"day"`
	TickInDay *int `json:"tickInDay"`
}

// пустой патч — все поля nil.
func (p debugPatch) empty() bool {
	return p.Money == nil && p.Day == nil && p.TickInDay == nil
}

// debugReply — ответ актора: Code — HTTP-статус, Body — JSON-payload или
// nil, Err — текст ошибки (Code >= 400).
type debugReply struct {
	Code int
	Body any
	Err  string
	Rev  uint64 // версия состояния на момент ответа (ITGAME-45), и при отказе
}

// ── Реестр живых сессий ────────────────────────────────────────────────────

// registerSession — актор заявляет свою сессию; выписывается на выходе.
func (h *Handler) registerSession(sid string, sess *session) {
	h.debugMu.Lock()
	if h.live == nil {
		h.live = map[string]*session{}
	}
	h.live[sid] = sess
	h.debugMu.Unlock()
	metrics.LiveSessions.Inc() // гейдж считает акторов: при захвате двое живут миг вместе
}

// unregisterSession — только если в реестре наша сессия: sid мог забрать
// другой актор (eviction), его запись трогать нельзя.
func (h *Handler) unregisterSession(sid string, sess *session) {
	h.debugMu.Lock()
	if h.live[sid] == sess {
		delete(h.live, sid)
	}
	h.debugMu.Unlock()
	metrics.LiveSessions.Dec()
}

// lookupSession — живая сессия по sid или nil (для агентского моста).
func (h *Handler) lookupSession(sid string) *session {
	h.debugMu.Lock()
	defer h.debugMu.Unlock()
	return h.live[sid]
}

// sendDebug — доставить запрос актору сессии. ok=false — живого актора нет.
func (h *Handler) sendDebug(sid string, req debugRequest) (debugReply, bool) {
	if !store.ValidSID(sid) {
		return debugReply{Code: http.StatusBadRequest, Err: "bad_sid"}, true
	}
	sess := h.lookupSession(sid)
	if sess == nil {
		return debugReply{Code: http.StatusNotFound,
			Err: "session_not_live (откройте страницу игры с этим sid)"}, false
	}
	req.Reply = make(chan debugReply, 1)
	ch := sess.debugC
	select {
	case ch <- req:
		select {
		case rep := <-req.Reply:
			return rep, true
		case <-time.After(10 * time.Second):
			return debugReply{Code: http.StatusGatewayTimeout, Err: "actor_timeout"}, true
		}
	case <-time.After(2 * time.Second):
		return debugReply{Code: http.StatusGatewayTimeout, Err: "actor_busy"}, true
	}
}

// ── HTTP: /api/debug/* ─────────────────────────────────────────────────────

// ServeDebug — все /api/debug/*-маршруты. Монтируется в main.go одним
// префиксом за гейтом ITGAME_DEBUG=1 (ITGAME-26).
func (h *Handler) ServeDebug(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	switch r.URL.Path {
	case "/api/debug/fixtures":
		if r.Method != http.MethodGet {
			writeDebugErr(w, http.StatusMethodNotAllowed, "метод не тот")
			return
		}
		names := game.FixtureNames()
		sort.Strings(names)
		writeDebugJSON(w, http.StatusOK, map[string]any{"fixtures": names})
	case "/api/debug/state":
		switch r.Method {
		case http.MethodGet:
			h.serveDebugStateGet(w, r)
		case http.MethodPost:
			h.serveDebugStatePost(w, r)
		default:
			writeDebugErr(w, http.StatusMethodNotAllowed, "метод не тот")
		}
	case "/api/debug/advance":
		if r.Method != http.MethodPost {
			writeDebugErr(w, http.StatusMethodNotAllowed, "метод не тот")
			return
		}
		h.serveDebugAdvance(w, r)
	case "/api/debug/drop":
		if r.Method != http.MethodPost {
			writeDebugErr(w, http.StatusMethodNotAllowed, "метод не тот")
			return
		}
		h.serveDebugDrop(w, r)
	case "/api/debug/format":
		if r.Method != http.MethodPost {
			writeDebugErr(w, http.StatusMethodNotAllowed, "метод не тот")
			return
		}
		h.serveDebugFormat(w, r)
	case "/api/debug/journal":
		if r.Method != http.MethodGet {
			writeDebugErr(w, http.StatusMethodNotAllowed, "метод не тот")
			return
		}
		h.serveJournal(w, r) // журнал партии для реплея (ITGAME-46)
	case "/api/debug/events":
		if r.Method != http.MethodGet {
			writeDebugErr(w, http.StatusMethodNotAllowed, "метод не тот")
			return
		}
		h.serveDebugEvents(w, r)
	case "/api/debug/ledger":
		if r.Method != http.MethodGet {
			writeDebugErr(w, http.StatusMethodNotAllowed, "метод не тот")
			return
		}
		h.serveDebugLedger(w, r)
	default:
		writeDebugErr(w, http.StatusNotFound, "нет такого debug-маршрута")
	}
}

// serveDebugStateGet — GET /api/debug/state?sid=: полный снапшот + сейв.
func (h *Handler) serveDebugStateGet(w http.ResponseWriter, r *http.Request) {
	rep, _ := h.sendDebug(r.URL.Query().Get("sid"), debugRequest{kind: kindState})
	finishDebug(w, rep)
}

// statePostBody — POST /api/debug/state: патч, рестор или фикстура.
// Валиден ровно один режим: смешивать нельзя (иначе непонятно, что важнее).
type statePostBody struct {
	SID       string          `json:"sid"`
	Money     *int            `json:"money"`
	Day       *int            `json:"day"`
	TickInDay *int            `json:"tickInDay"`
	State     json.RawMessage `json:"state"`
	Scenario  string          `json:"scenario"`
}

func (b statePostBody) mode() string {
	switch {
	case len(b.State) > 0:
		return "restore"
	case b.Scenario != "":
		return "scenario"
	case b.Money != nil || b.Day != nil || b.TickInDay != nil:
		return "patch"
	default:
		return ""
	}
}

func (h *Handler) serveDebugStatePost(w http.ResponseWriter, r *http.Request) {
	var body statePostBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeDebugErr(w, http.StatusBadRequest, "тело не JSON: "+err.Error())
		return
	}
	var req debugRequest
	switch body.mode() {
	case "restore":
		req = debugRequest{kind: kindRestore, state: body.State}
	case "scenario":
		req = debugRequest{kind: kindScenario, scenario: body.Scenario}
	case "patch":
		req = debugRequest{kind: kindPatch, patch: debugPatch{Money: body.Money, Day: body.Day, TickInDay: body.TickInDay}}
	default:
		writeDebugErr(w, http.StatusBadRequest,
			"пустой запрос: нужен state, scenario или money/day/tickInDay")
		return
	}
	rep, _ := h.sendDebug(body.SID, req)
	finishDebug(w, rep)
}

// advancePostBody — POST /api/debug/advance: {days:n} или {ticks:n}.
type advancePostBody struct {
	SID   string `json:"sid"`
	Days  int    `json:"days"`
	Ticks int    `json:"ticks"`
}

func (h *Handler) serveDebugAdvance(w http.ResponseWriter, r *http.Request) {
	var body advancePostBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeDebugErr(w, http.StatusBadRequest, "тело не JSON: "+err.Error())
		return
	}
	if body.Days == 0 && body.Ticks == 0 {
		writeDebugErr(w, http.StatusBadRequest, "нужен days>0 или ticks>0")
		return
	}
	if body.Days < 0 || body.Ticks < 0 || body.Days > 90 || body.Ticks > 10000 {
		writeDebugErr(w, http.StatusBadRequest, "проматывать можно 0–90 дней / 0–10000 тиков")
		return
	}
	rep, _ := h.sendDebug(body.SID, debugRequest{kind: kindAdvance, days: body.Days, ticks: body.Ticks})
	finishDebug(w, rep)
}

// serveDebugEvents — GET /api/debug/events?sid=&n=50.
func (h *Handler) serveDebugEvents(w http.ResponseWriter, r *http.Request) {
	n := 50
	if v := r.URL.Query().Get("n"); v != "" {
		if _, err := fmt.Sscanf(v, "%d", &n); err != nil || n < 1 || n > 500 {
			writeDebugErr(w, http.StatusBadRequest, "n — целое 1..500")
			return
		}
	}
	rep, _ := h.sendDebug(r.URL.Query().Get("sid"), debugRequest{kind: kindEvents, n: n})
	finishDebug(w, rep)
}

// serveDebugLedger — GET /api/debug/ledger?sid=&day=N: книга дня (ITGAME-73);
// без day — текущий.
func (h *Handler) serveDebugLedger(w http.ResponseWriter, r *http.Request) {
	day := 0
	if v := r.URL.Query().Get("day"); v != "" {
		if _, err := fmt.Sscanf(v, "%d", &day); err != nil || day < 1 {
			writeDebugErr(w, http.StatusBadRequest, "day — целое ≥ 1 (без day — текущий день)")
			return
		}
	}
	rep, _ := h.sendDebug(r.URL.Query().Get("sid"), debugRequest{kind: kindLedger, day: day})
	finishDebug(w, rep)
}

// ledgerReply — книга дня и сверка: Sum слагаемых против BalanceEnd.
// Поля книги — на верхнем уровне (встраивание), как их отдаёт itd.ledger().
type ledgerReply struct {
	game.DayLedger
	PurchasesTotal int   `json:"purchasesTotal"`
	Profit         int   `json:"profit"`   // = day_report.profit закрытого дня: доход + события − ФОТ − опекс
	Delta          int   `json:"delta"`    // balanceEnd − balanceStart
	Balanced       bool  `json:"balanced"` // слагаемые сходятся с delta ровно
	History        []int `json:"history"`  // дни, по которым есть книга (itd.ledger(day))
}

func newLedgerReply(l game.DayLedger, days []int) ledgerReply {
	if l.Events == nil {
		l.Events = []game.LedgerEvent{}
	}
	if l.Purchases == nil {
		l.Purchases = []game.LedgerPurchase{}
	}
	return ledgerReply{
		DayLedger: l, PurchasesTotal: l.PurchasesTotal(), Profit: l.Profit(),
		Delta: l.BalanceEnd - l.BalanceStart, Balanced: l.Sum() == l.BalanceEnd, History: days,
	}
}

// dropReply — ответ POST /api/debug/drop: когда сервер замолчал и когда заметит.
type dropReply struct {
	SID       string `json:"sid"`
	At        int64  `json:"at"`        // epoch ms: сервер перестал читать и писать в соединение вкладки
	TimeoutMs int64  `json:"timeoutMs"` // таймаут чтения этого соединения
	NoticeBy  int64  `json:"noticeBy"`  // at + timeoutMs: не раньше — сервер заметит уход (плюс шаг сторожа ≤ timeout/4)
}

// serveDebugDrop — POST /api/debug/drop?sid=&timeout=мс (ITGAME-76, itd.away
// mode 'net'): обрыв сети без close-фрейма. Соединение вкладки остаётся
// открытым, но сервер больше в него не пишет (hub его забыл) и не читает
// (readLoop выбрасывает входящее, ping не шлём) — уход он замечает своим
// таймаутом чтения, тем же путём, что и настоящий обрыв, а партия до этого
// идёт вживую. timeout (50..600000 мс) укорачивает таймаут этого соединения
// для QA; без него — Handler.ReadTimeout. Мосты агента не трогает.
func (h *Handler) serveDebugDrop(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sid := q.Get("sid")
	if !store.ValidSID(sid) {
		writeDebugErr(w, http.StatusBadRequest, "bad_sid")
		return
	}
	var timeout time.Duration
	if v := q.Get("timeout"); v != "" {
		var ms int64
		if _, err := fmt.Sscanf(v, "%d", &ms); err != nil ||
			time.Duration(ms)*time.Millisecond < minDropTimeout || time.Duration(ms)*time.Millisecond > maxDropTimeout {
			writeDebugErr(w, http.StatusBadRequest, "timeout — мс, целое 50..600000")
			return
		}
		timeout = time.Duration(ms) * time.Millisecond
	}
	sess := h.lookupSession(sid)
	if sess == nil {
		writeDebugErr(w, http.StatusNotFound, "session_not_live (откройте страницу игры с этим sid)")
		return
	}
	if sess.tab == nil {
		writeDebugErr(w, http.StatusConflict, "no_tab: headless-сессия агента, рвать нечего")
		return
	}
	at, eff, ok := sess.tab.drop(timeout)
	if !ok {
		writeDebugErr(w, http.StatusConflict, "already_dropped")
		return
	}
	sess.hub.remove(sess.tab.c) // ни снапшотов, ни ответов: сервер молчит
	log.Printf("сессия %s: debug-обрыв, таймаут чтения %s", sid, eff)
	writeDebugJSON(w, http.StatusOK, dropReply{
		SID: sid, At: at.UnixMilli(), TimeoutMs: eff.Milliseconds(), NoticeBy: at.Add(eff).UnixMilli(),
	})
}

// formatPostBody — тело POST /api/debug/format.
type formatPostBody struct {
	SID    string `json:"sid"`
	Format *int   `json:"format"` // game.format сейва; не задан — на 1 новее формата сервера
}

// formatReply — ответ POST /api/debug/format.
type formatReply struct {
	SID    string `json:"sid"`
	Was    int    `json:"was"`    // game.format, который нёс сейв до метки
	Format int    `json:"format"` // game.format после метки
	Live   bool   `json:"live"`   // true — метку держит актор живой партии; false — сейв переписан в сторе
}

// serveDebugFormat — POST /api/debug/format {sid, format?} (ITGAME-154): сейв sid другого
// формата без перезапуска стенда — карточка «СЕЙВ НЕСОВМЕСТИМ» и новая партия на подключении
// (ITGAME-169). Версию сборки и остальное не трогает. Живую партию помечает её актор (он пишет
// сейв каждым тиком и командой): метка живёт до его выхода, переподключение вкладки начнёт
// новую партию (владелец 20.10, «порча до переподключения» — так воспроизводится ITGAME-174).
// Без актора — правка стора: Load отдаёт память раньше диска, правка файла на живом сервере
// не видна.
func (h *Handler) serveDebugFormat(w http.ResponseWriter, r *http.Request) {
	var body formatPostBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var ute *json.UnmarshalTypeError
		if errors.As(err, &ute) && ute.Field == "format" {
			// JSON, но format не целое (1.5, 1e30): не «тело не JSON»
			writeDebugErr(w, http.StatusBadRequest, "bad_format: format — целое ≥ 0")
			return
		}
		writeDebugErr(w, http.StatusBadRequest, "тело не JSON: "+err.Error())
		return
	}
	if h.Saves == nil {
		writeDebugErr(w, http.StatusConflict, "no_saves: сервер без хранилища сейвов")
		return
	}
	sid := body.SID
	if !store.ValidSID(sid) {
		writeDebugErr(w, http.StatusBadRequest, "bad_sid")
		return
	}
	format := game.SaveFormat + 1
	if body.Format != nil {
		format = *body.Format
	}
	if format < 0 {
		writeDebugErr(w, http.StatusBadRequest, "bad_format: format — целое ≥ 0")
		return
	}
	if format == game.SaveFormat {
		writeDebugErr(w, http.StatusBadRequest,
			fmt.Sprintf("same_format: %d — формат самого сервера, сейв не станет несовместимым", format))
		return
	}
	rep, live := h.sendDebug(sid, debugRequest{kind: kindFormat, format: format})
	if live {
		finishDebug(w, rep)
		return
	}
	noSave := func() {
		writeDebugErr(w, http.StatusNotFound, "no_save: у "+sid+" нет сейва (ни живой партии, ни файла этой сборки)")
	}
	raw, ok := h.Saves.Load(sid)
	if !ok {
		noSave()
		return
	}
	out, was, ok := withSaveFormat(raw, sid, format)
	if !ok {
		noSave()
		return
	}
	if !h.Saves.Rewrite(sid, raw, out) {
		if _, still := h.Saves.Load(sid); still {
			// сейв сменился после чтения — вкладка подключилась и пишет прогресс
			writeDebugErr(w, http.StatusConflict, "busy: сейв "+sid+" изменился во время правки — повторите")
			return
		}
		noSave()
		return
	}
	log.Printf("сессия %s: debug-метка формата %d (был %d), в сторе", sid, format, was)
	writeDebugJSON(w, http.StatusOK, formatReply{SID: sid, Was: was, Format: format, Live: false})
}

// withSaveFormat — сейв raw с game.format = format (ITGAME-154), остальное — те же значения (ключи по алфавиту, <>& экранируются):
// json.RawMessage, не map[string]any (uint64-сид стал бы float64) и не sessionSave (сейв новее
// может не лечь в него). was — прежний формат; ok=false — не сейв этого sid (не JSON, чужой
// sid, нет game).
func withSaveFormat(raw []byte, sid string, format int) (out []byte, was int, ok bool) {
	var head saveHead
	if json.Unmarshal(raw, &head) != nil || head.SID != sid {
		return nil, 0, false
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(raw, &top) != nil || len(top["game"]) == 0 {
		return nil, 0, false
	}
	var gm map[string]json.RawMessage
	if json.Unmarshal(top["game"], &gm) != nil || gm == nil {
		return nil, 0, false
	}
	gm["format"] = json.RawMessage(strconv.Itoa(format))
	gb, err := json.Marshal(gm)
	if err != nil {
		return nil, 0, false
	}
	top["game"] = gb
	out, err = json.Marshal(top)
	if err != nil {
		return nil, 0, false
	}
	return out, head.Game.Format, true
}

func writeDebugErr(w http.ResponseWriter, code int, msg string) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeDebugJSON(w http.ResponseWriter, code int, body any) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func finishDebug(w http.ResponseWriter, rep debugReply) {
	if rep.Code >= 400 {
		writeDebugErr(w, rep.Code, rep.Err)
		return
	}
	writeDebugJSON(w, rep.Code, rep.Body)
}

// ── Актор-сторона: применение запросов ─────────────────────────────────────

// advanceReply — тело ответа advance: сводка промотки и свежий снапшот.
type advanceReply struct {
	SID     string               `json:"sid"`
	Advance *game.OfflineSummary `json:"advance"`
	State   stateMessage         `json:"state"`
}

// stateReply — тело ответа GET state и всех мутаций: свежий снапшот.
type stateReply struct {
	SID    string       `json:"sid"`
	State  stateMessage `json:"state"`
	Save   game.Save    `json:"save"`
	Events []string     `json:"events,omitempty"`
}

// applyDebug — обработка debug-запроса в актор-горутине. Меняет игру через
// указатели (restore/фикстура заменяют её целиком), персистит сейв и
// проталкивает снапшот всем соединениям сессии (ITGAME-29), чтобы UI
// отразил чит мгновенно (метка формата сейва пишется без новой версии и без push). Возвращает true, если сессию забрал другой актор.
func (h *Handler) applyDebug(
	ctx context.Context, hub *connHub, req debugRequest,
	sid string, gen uint64, withSaves bool,
	gp **game.Game, speed *int, resumeSpeed int, last **game.DayReport,
	jr *eventJournal, scenario *string, rv *revClock, saveFormat *int,
) bool {
	g := *gp
	// snap — снапшот с текущими rev/cause: и для рассылки, и для HTTP-ответа
	// (агент ждёт state.rev ≥ N, ITGAME-45).
	snap := func() stateMessage {
		return rv.stamp(snapshot(g, *speed, false, *scenario))
	}
	push := func() {
		hub.write(ctx, snap())
	}
	reply := func(rep debugReply) {
		rep.Rev = rv.rev
		select {
		case req.Reply <- rep:
		default:
		}
	}
	// persist — только в мутирующих ветках, перед push(): новая версия
	// состояния (cause debug) рождается здесь, до сейва — как у тика/команды.
	persist := func() bool {
		rv.bump(causeDebug)
		if !withSaves {
			return true
		}
		if g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon {
			// Finish, не Delete: своё удаление — не захват (ITGAME-51).
			h.Saves.Finish(sid, gen)
			return true
		}
		return h.persist(sid, gen, g, *speed, resumeSpeed, *last, *scenario, jr.last(jr.cap), rv.rev, *saveFormat)
	}

	switch req.kind {
	case kindState:
		reply(debugReply{Code: http.StatusOK, Body: stateReply{
			SID: sid, State: snap(), Save: g.Export(), Events: jr.last(20),
		}})
		return false

	case kindEvents:
		reply(debugReply{Code: http.StatusOK, Body: map[string]any{"sid": sid, "events": jr.last(req.n)}})
		return false

	case kindLedger:
		l, ok := g.LedgerOf(req.day)
		if !ok {
			reply(debugReply{Code: http.StatusNotFound,
				Err: fmt.Sprintf("нет книги дня %d: есть %v", req.day, g.LedgerDayList())})
			return false
		}
		reply(debugReply{Code: http.StatusOK, Body: newLedgerReply(l, g.LedgerDayList())})
		return false

	case kindFormat:
		// Метка формата (ITGAME-154): меняется сейв, не игра — ни rev, ни снапшота, ни записи в
		// журнал партии (jn.debug пишет только мутации; реплей её не знает). Этот актор пишет сейв
		// форматом req.format каждым persist до выхода; следующий (переподключение) увидит чужой
		// формат в resume.
		if !withSaves {
			reply(debugReply{Code: http.StatusConflict, Err: "no_saves: сервер без хранилища сейвов"})
			return false
		}
		if g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon {
			reply(debugReply{Code: http.StatusNotFound, Err: "no_save: партия окончена, сейва нет"})
			return false
		}
		was := *saveFormat
		*saveFormat = req.format
		jr.add(fmt.Sprintf("debug · формат сейва %d (сервер %d) — до переподключения", req.format, game.SaveFormat))
		if !h.persist(sid, gen, g, *speed, resumeSpeed, *last, *scenario, jr.last(jr.cap), rv.rev, *saveFormat) {
			reply(debugReply{Code: http.StatusGone, Err: "session_taken"})
			return true
		}
		reply(debugReply{Code: http.StatusOK, Body: formatReply{SID: sid, Was: was, Format: req.format, Live: true}})
		return false
	}

	g2, sum, code, msg := debugMutate(g, req)
	if code != 0 {
		reply(debugReply{Code: code, Err: msg})
		return false
	}
	if g2 != g {
		// scenario/restore заменяют партию целиком: отчёт дня старой не дошлём
		g, *gp, *last = g2, g2, nil
	}
	switch req.kind {
	case kindPatch:
		jr.add(fmt.Sprintf("debug · патч: %s", patchSummary(req.patch, g)))
	case kindScenario:
		*scenario = req.scenario
		jr.add(fmt.Sprintf("debug · сценарий %q (сид %s)", req.scenario, g.SeedString()))
	case kindRestore:
		jr.add(fmt.Sprintf("debug · restore (день %d, $%d)", g.Day, g.Money))
	case kindAdvance:
		jr.add(fmt.Sprintf("debug · advance: %d тиков, %d дней, доход $%d, ФОТ $%d, баланс $%d",
			sum.Ticks, sum.Days, sum.Income, sum.Payroll, sum.Balance))
		if sum.GameOver {
			jr.add(fmt.Sprintf("финал офлайн-промотки: %s", sum.Reason))
		}
		if sum.Victory {
			jr.add("победа в офлайн-промотке")
		}
	}
	if !persist() {
		reply(debugReply{Code: http.StatusGone, Err: "session_taken"})
		return true
	}
	push()
	if req.kind == kindAdvance {
		if sum.GameOver {
			hub.write(ctx, gameOverMessage{Type: "game_over", DaysSurvived: g.Day,
				PeakIncomePerTick: g.PeakIncomePerTick, Balance: g.Money, Shortfall: g.BankruptShortfall, Reason: g.LoseReason})
		} else if sum.Victory {
			hub.write(ctx, victoryMessage{Type: "victory",
				Difficulty: string(g.Config().Difficulty), Day: g.Day, Balance: g.Money})
		}
		reply(debugReply{Code: http.StatusOK, Body: advanceReply{SID: sid, Advance: sum, State: snap()}})
		return false
	}
	reply(debugReply{Code: http.StatusOK, Body: stateReply{
		SID: sid, State: snap(), Save: g.Export(),
	}})
	return false
}

// debugMutate — мутирующая часть debug-запроса (patch, scenario, restore,
// advance): одна для актора и реплеера журнала (ITGAME-46), чтобы реплей
// не расходился с живой сессией по построению. Возвращает игру после
// запроса (та же или новая — scenario/restore заменяют её целиком), сводку
// advance и при отказе HTTP-код с текстом; отказ игру не меняет.
func debugMutate(g *game.Game, req debugRequest) (*game.Game, *game.OfflineSummary, int, string) {
	switch req.kind {
	case kindPatch:
		if err := applyDebugPatch(g, req.patch); err != "" {
			return g, nil, http.StatusBadRequest, err
		}
		return g, nil, 0, ""

	case kindScenario:
		g2, err := game.NewFixture(g.Config(), req.scenario, g.SeedString())
		if err != nil {
			return g, nil, http.StatusBadRequest, err.Error()
		}
		return g2, nil, 0, ""

	case kindRestore:
		// Дельта над ТЕКУЩИМ состоянием: отсутствующие в JSON поля
		// сохраняют значения (ручные частичные сейвы удобны).
		base := g.Export()
		if err := json.Unmarshal(req.state, &base); err != nil {
			return g, nil, http.StatusBadRequest, "state не JSON: " + err.Error()
		}
		base.Config = g.Config() // конфиг закреплён за сессией (difficulty)
		g2, err := game.Restore(base)
		if err != nil {
			return g, nil, http.StatusBadRequest, "невалидное состояние: " + err.Error()
		}
		return g2, nil, 0, ""

	case kindAdvance:
		// Из фазы отчёта — сначала следующий день: офлайн-движок работает
		// только из running (день без игрока не промотать).
		if g.Phase == game.PhaseDayReport {
			if err := g.NextDay(); err != nil {
				return g, nil, http.StatusConflict, "next_day: " + err.Error()
			}
		}
		miss := req.ticks
		if req.days > 0 {
			miss = req.days * g.Config().DayTicks()
		}
		return g, g.AdvanceOffline(miss), 0, ""
	}
	return g, nil, http.StatusBadRequest, "неизвестный debug-запрос " + req.kind
}

// applyDebugPatch — точечный чит с валидацией инвариантов дня.
func applyDebugPatch(g *game.Game, p debugPatch) string {
	dayTicks := g.Config().DayTicks()
	if p.Day != nil && *p.Day < 1 {
		return "day >= 1"
	}
	if p.TickInDay != nil {
		if g.Phase == game.PhaseDayReport {
			return "tickInDay недоступен в фазе day_report"
		}
		t := *p.TickInDay
		if t < 0 || t > dayTicks || (g.Phase == game.PhaseRunning && t >= dayTicks) {
			return fmt.Sprintf("tickInDay — целое 0..%d (в running строго меньше)", dayTicks)
		}
	}
	if p.Money != nil {
		g.AdjustMoney(*p.Money) // разница — в Adjust книги дня (ITGAME-73)
	}
	if p.Day != nil {
		g.Day = *p.Day
		g.RelabelLedger()
	}
	if p.TickInDay != nil {
		g.TickInDay = *p.TickInDay
	}
	return ""
}

// patchSummary — строка для журнала: что поменяли.
func patchSummary(p debugPatch, g *game.Game) string {
	parts := []string{}
	if p.Money != nil {
		parts = append(parts, fmt.Sprintf("money=%d", *p.Money))
	}
	if p.Day != nil {
		parts = append(parts, fmt.Sprintf("day=%d", *p.Day))
	}
	if p.TickInDay != nil {
		parts = append(parts, fmt.Sprintf("tickInDay=%d", *p.TickInDay))
	}
	return fmt.Sprintf("д%d · %s", g.Day, strings.Join(parts, ", "))
}
