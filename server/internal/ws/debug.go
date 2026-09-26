package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"itdirector/internal/game"
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
	kindState    = "state"    // полный снапшот + сейв
	kindPatch    = "patch"    // точечный чит {money, day, tickInDay}
	kindRestore  = "restore"  // полное состояние (itd.restore)
	kindScenario = "scenario" // пересоздать партию фикстурой
	kindAdvance  = "advance"  // промотка днями/тиками (движок offline)
	kindEvents   = "events"   // хвост журнала событий
)

// debugRequest — запрос HTTP-хендлера к актору. Reply буферизован: актор
// не ждёт читателя.
type debugRequest struct {
	kind     string
	patch    debugPatch
	state    json.RawMessage // kind=restore: дельта над текущим состоянием
	scenario string          // kind=scenario
	days     int             // kind=advance
	ticks    int             // kind=advance
	n        int             // kind=events
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
}

// unregisterSession — только если в реестре наша сессия: sid мог забрать
// другой актор (eviction), его запись трогать нельзя.
func (h *Handler) unregisterSession(sid string, sess *session) {
	h.debugMu.Lock()
	if h.live[sid] == sess {
		delete(h.live, sid)
	}
	h.debugMu.Unlock()
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
	case "/api/debug/events":
		if r.Method != http.MethodGet {
			writeDebugErr(w, http.StatusMethodNotAllowed, "метод не тот")
			return
		}
		h.serveDebugEvents(w, r)
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
// отразил чит мгновенно. Возвращает true, если сессию забрал другой актор.
func (h *Handler) applyDebug(
	ctx context.Context, hub *connHub, req debugRequest,
	sid string, gen uint64, withSaves bool,
	gp **game.Game, speed *int, last **game.DayReport,
	jr *eventJournal, scenario *string,
) bool {
	g := *gp
	push := func() {
		hub.write(ctx, snapshot(g, *speed, false, *scenario))
	}
	reply := func(rep debugReply) {
		select {
		case req.Reply <- rep:
		default:
		}
	}
	persist := func() bool {
		if !withSaves {
			return true
		}
		if g.Phase == game.PhaseGameOver || g.Phase == game.PhaseWon {
			h.Saves.Delete(sid)
			return true
		}
		return h.persist(sid, gen, g, *speed, *last, *scenario, jr.last(jr.cap))
	}

	switch req.kind {
	case kindState:
		reply(debugReply{Code: http.StatusOK, Body: stateReply{
			SID: sid, State: snapshot(g, *speed, false, *scenario), Save: g.Export(), Events: jr.last(20),
		}})

	case kindEvents:
		reply(debugReply{Code: http.StatusOK, Body: map[string]any{"sid": sid, "events": jr.last(req.n)}})

	case kindPatch:
		if err := applyDebugPatch(g, req.patch); err != "" {
			reply(debugReply{Code: http.StatusBadRequest, Err: err})
			return false
		}
		jr.add(fmt.Sprintf("debug · патч: %s", patchSummary(req.patch, g)))
		if !persist() {
			reply(debugReply{Code: http.StatusGone, Err: "session_taken"})
			return true
		}
		push()
		reply(debugReply{Code: http.StatusOK, Body: stateReply{
			SID: sid, State: snapshot(g, *speed, false, *scenario), Save: g.Export(),
		}})

	case kindScenario:
		g2, err := game.NewFixture(g.Config(), req.scenario, g.SeedString())
		if err != nil {
			reply(debugReply{Code: http.StatusBadRequest, Err: err.Error()})
			return false
		}
		g, *gp, *scenario, *last = g2, g2, req.scenario, nil
		jr.add(fmt.Sprintf("debug · сценарий %q (сид %s)", req.scenario, g.SeedString()))
		if !persist() {
			reply(debugReply{Code: http.StatusGone, Err: "session_taken"})
			return true
		}
		push()
		reply(debugReply{Code: http.StatusOK, Body: stateReply{
			SID: sid, State: snapshot(g, *speed, false, *scenario), Save: g.Export(),
		}})

	case kindRestore:
		// Дельта над ТЕКУЩИМ состоянием: отсутствующие в JSON поля
		// сохраняют значения (ручные частичные сейвы удобны).
		base := g.Export()
		if err := json.Unmarshal(req.state, &base); err != nil {
			reply(debugReply{Code: http.StatusBadRequest, Err: "state не JSON: " + err.Error()})
			return false
		}
		base.Config = g.Config() // конфиг закреплён за сессией (difficulty)
		g2, err := game.Restore(base)
		if err != nil {
			reply(debugReply{Code: http.StatusBadRequest, Err: "невалидное состояние: " + err.Error()})
			return false
		}
		g, *gp, *last = g2, g2, nil
		jr.add(fmt.Sprintf("debug · restore (день %d, $%d)", g.Day, g.Money))
		if !persist() {
			reply(debugReply{Code: http.StatusGone, Err: "session_taken"})
			return true
		}
		push()
		reply(debugReply{Code: http.StatusOK, Body: stateReply{
			SID: sid, State: snapshot(g, *speed, false, *scenario), Save: g.Export(),
		}})

	case kindAdvance:
		// Из фазы отчёта — сначала следующий день: офлайн-движок работает
		// только из running (день без игрока не промотать).
		if g.Phase == game.PhaseDayReport {
			if err := g.NextDay(); err != nil {
				reply(debugReply{Code: http.StatusConflict, Err: "next_day: " + err.Error()})
				return false
			}
		}
		miss := req.ticks
		if req.days > 0 {
			miss = req.days * g.Config().DayTicks()
		}
		sum := g.AdvanceOffline(miss)
		jr.add(fmt.Sprintf("debug · advance: %d тиков, %d дней, доход $%d, ФОТ $%d, баланс $%d",
			sum.Ticks, sum.Days, sum.Income, sum.Payroll, sum.Balance))
		if sum.GameOver {
			jr.add(fmt.Sprintf("финал офлайн-промотки: %s", sum.Reason))
		}
		if sum.Victory {
			jr.add("победа в офлайн-промотке")
		}
		if !persist() {
			reply(debugReply{Code: http.StatusGone, Err: "session_taken"})
			return true
		}
		push()
		if sum.GameOver {
			hub.write(ctx, gameOverMessage{Type: "game_over", DaysSurvived: g.Day,
				PeakIncomePerTick: g.PeakIncomePerTick, Balance: g.Money, Reason: g.LoseReason})
		} else if sum.Victory {
			hub.write(ctx, victoryMessage{Type: "victory",
				Difficulty: string(g.Config().Difficulty), Day: g.Day, Balance: g.Money})
		}
		reply(debugReply{Code: http.StatusOK, Body: map[string]any{
			"sid": sid, "advance": sum,
			"state": snapshot(g, *speed, false, *scenario),
		}})
	}
	return false
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
		g.Money = *p.Money
	}
	if p.Day != nil {
		g.Day = *p.Day
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
