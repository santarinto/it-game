package ws

import (
	"context"
	"encoding/json"
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

// Один сервер на /ws и /api/debug/* — как в main.go. Возвращает base URL
// ("http://127.0.0.1:port") для HTTP и ws-адрес для Dial.
func startDebugServer(t *testing.T, cfg game.Config, tick time.Duration) (string, *Handler) {
	t.Helper()
	h := &Handler{Config: cfg, TickInterval: tick}
	mux := http.NewServeMux()
	mux.Handle("GET /ws", h)
	mux.Handle("GET /ws/agent", http.HandlerFunc(h.ServeAgent))
	mux.Handle("/api/debug/", http.HandlerFunc(h.ServeDebug))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL, h
}

func httpDebug(t *testing.T, base, method, path, body string) (int, map[string]any) {
	t.Helper()
	var resp *http.Response
	var err error
	if body == "" {
		resp, err = http.Get(base + path)
	} else {
		resp, err = http.Post(base+path, "application/json", strings.NewReader(body))
	}
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("%s %s: ответ не JSON: %v", method, path, err)
	}
	return resp.StatusCode, out
}

func stateOf(t *testing.T, v any) map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("ожидался объект state, получили %T", v)
	}
	return m
}

// num — JSON-число как int (encoding/json даёт float64).
func num(t *testing.T, v any) int {
	t.Helper()
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("ожидалось число, получили %T (%v)", v, v)
	}
	return int(f)
}

func TestDebugStateGetAndPatch(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 1_000_000                      // не мешают победы
	base, _ := startDebugServer(t, cfg, time.Hour) // тики не мешают

	sid := "debug-sid-0001"
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid+"&seed=1234", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	var first testMessage
	if err := wsjson.Read(context.Background(), c, &first); err != nil {
		t.Fatalf("первый снапшот: %v", err)
	}
	if first.Type != "state" || first.Money != cfg.StartMoney {
		t.Fatalf("первый снапшот: %+v", first)
	}

	// GET state: сид из ?seed= виден и в снапшоте, и в сейве
	code, out := httpDebug(t, base, "GET", "/api/debug/state?sid="+sid, "")
	if code != 200 {
		t.Fatalf("GET state: %d %v", code, out)
	}
	st := stateOf(t, out["state"])
	if st["seed"] != "1234" {
		t.Fatalf("seed в снапшоте: %v", st["seed"])
	}
	save := stateOf(t, out["save"])
	if num(t, save["seed"]) != 1234 {
		t.Fatalf("seed в сейве: %v", save["seed"])
	}

	// POST патч: деньги видны и в ответе, и в следующем WS-снапшоте
	code, out = httpDebug(t, base, "POST", "/api/debug/state",
		fmt.Sprintf(`{"sid":%q,"money":50000}`, sid))
	if code != 200 {
		t.Fatalf("POST patch: %d %v", code, out)
	}
	if num(t, stateOf(t, out["state"])["money"]) != 50000 {
		t.Fatalf("money после патча: %v", out["state"])
	}
	patched := readUntil(t, context.Background(), c, func(m testMessage) bool { return m.Money == 50000 })
	if patched.Type != "state" {
		t.Fatalf("WS после патча: %+v", patched)
	}

	// патч с мусором отклоняется, игру не ломает
	code, out = httpDebug(t, base, "POST", "/api/debug/state",
		fmt.Sprintf(`{"sid":%q,"tickInDay":99999}`, sid))
	if code != 400 {
		t.Fatalf("битый патч должен быть 400: %d %v", code, out)
	}
	code, out = httpDebug(t, base, "POST", "/api/debug/state", fmt.Sprintf(`{"sid":%q}`, sid))
	if code != 400 {
		t.Fatalf("пустое тело должно быть 400: %d %v", code, out)
	}
}

func TestDebugAdvanceMovesDays(t *testing.T) {
	cfg := game.DefaultConfig()
	base, _ := startDebugServer(t, cfg, time.Hour)

	sid := "debug-sid-0002"
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	var first testMessage
	if err := wsjson.Read(context.Background(), c, &first); err != nil {
		t.Fatal(err)
	}

	code, out := httpDebug(t, base, "POST", "/api/debug/advance",
		fmt.Sprintf(`{"sid":%q,"days":3}`, sid))
	if code != 200 {
		t.Fatalf("advance: %d %v", code, out)
	}
	st := stateOf(t, out["state"])
	if got := num(t, st["day"]); got != 4 { // день 1 + 3 полных дня
		t.Fatalf("день после advanceDays(3): %d, ожидался 4", got)
	}
	adv := stateOf(t, out["advance"])
	if num(t, adv["days"]) != 3 {
		t.Fatalf("advance.days: %v", adv["days"])
	}

	// журнал событий помнит промотку
	code, out = httpDebug(t, base, "GET", "/api/debug/events?sid="+sid+"&n=10", "")
	if code != 200 {
		t.Fatalf("events: %d %v", code, out)
	}
	found := false
	for _, ev := range out["events"].([]any) {
		if strings.Contains(ev.(string), "advance") {
			found = true
		}
	}
	if !found {
		t.Fatalf("в журнале нет advance: %v", out["events"])
	}
}

func TestDebugScenarioSoftLock(t *testing.T) {
	cfg := game.DefaultConfig()
	base, _ := startDebugServer(t, cfg, time.Hour)

	sid := "debug-sid-0003"
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid+"&scenario=soft_lock", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	var first testMessage
	if err := wsjson.Read(context.Background(), c, &first); err != nil {
		t.Fatal(err)
	}
	if first.Type != "state" || first.Day != 40 || first.Money != 100 {
		t.Fatalf("?scenario=soft_lock не применился: %+v", first)
	}

	code, out := httpDebug(t, base, "GET", "/api/debug/state?sid="+sid, "")
	if code != 200 || num(t, stateOf(t, out["state"])["day"]) != 40 {
		t.Fatalf("state после фикстуры: %d %v", code, out)
	}

	// POST scenario: пересоздать живую сессию другой фикстурой
	code, out = httpDebug(t, base, "POST", "/api/debug/state",
		fmt.Sprintf(`{"sid":%q,"scenario":"mid_day10"}`, sid))
	if code != 200 {
		t.Fatalf("POST scenario: %d %v", code, out)
	}
	st := stateOf(t, out["state"])
	if num(t, st["day"]) != 10 {
		t.Fatalf("после сценария mid_day10 день %v", st["day"])
	}

	code, out = httpDebug(t, base, "GET", "/api/debug/fixtures", "")
	if code != 200 || len(out["fixtures"].([]any)) != 7 {
		t.Fatalf("fixtures: %d %v", code, out)
	}

	code, out = httpDebug(t, base, "POST", "/api/debug/state",
		fmt.Sprintf(`{"sid":%q,"scenario":"nope"}`, sid))
	if code != 400 {
		t.Fatalf("неизвестный сценарий: %d %v", code, out)
	}
}

func TestDebugRestoreRoundtrip(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 1_000_000
	base, _ := startDebugServer(t, cfg, time.Hour)

	sid := "debug-sid-0004"
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	var first testMessage
	if err := wsjson.Read(context.Background(), c, &first); err != nil {
		t.Fatal(err)
	}

	// snapshot().save → restore(): состояние возвращается на место
	_, out := httpDebug(t, base, "GET", "/api/debug/state?sid="+sid, "")
	saveRaw, err := json.Marshal(out["save"])
	if err != nil {
		t.Fatal(err)
	}
	httpDebug(t, base, "POST", "/api/debug/state", fmt.Sprintf(`{"sid":%q,"money":777}`, sid))
	code, out := httpDebug(t, base, "POST", "/api/debug/state",
		fmt.Sprintf(`{"sid":%q,"state":%s}`, sid, saveRaw))
	if code != 200 {
		t.Fatalf("restore: %d %v", code, out)
	}
	if num(t, stateOf(t, out["state"])["money"]) != cfg.StartMoney {
		t.Fatalf("restore не вернул баланс: %v", out["state"])
	}
}

// Невалидная дельта restore (day:0 → 400) не трогает живую игру
// (ITGAME-60): ни офис, ни сотрудника, ни конфиг сессии и сервера.
func TestDebugRestoreInvalidDeltaKeepsLiveGame(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 1_000_000
	base, h := startDebugServer(t, cfg, time.Hour)
	xp := h.Config.EmployeeLevelXP[0]

	sid := "debug-sid-0060"
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices) > 0 && len(m.Offices[0].Employees) == 1
	})

	// liveOffice — офис 0 из save живой игры (GET state отдаёт g.Export()).
	liveOffice := func() (map[string]any, map[string]any) {
		code, out := httpDebug(t, base, "GET", "/api/debug/state?sid="+sid, "")
		if code != 200 {
			t.Fatalf("GET state: %d %v", code, out)
		}
		save := stateOf(t, out["save"])
		return stateOf(t, save["offices"].([]any)[0]), save
	}
	office, _ := liveOffice()
	emps := office["Employees"].([]any)
	income := num(t, stateOf(t, emps[0])["IncomePerTick"])

	code, out := httpDebug(t, base, "POST", "/api/debug/state", fmt.Sprintf(`{"sid":%q,"state":{
		"day":0,
		"offices":[{"Boss":"Подмена","Employees":[{"IncomePerTick":987654}]}],
		"config":{"EmployeeLevelXP":[1]}}}`, sid))
	if code != 400 || !strings.Contains(fmt.Sprint(out["error"]), "невалидное состояние") {
		t.Fatalf("дельта с day:0 должна быть 400 «невалидное состояние»: %d %v", code, out)
	}

	office, save := liveOffice()
	emps = office["Employees"].([]any)
	if len(emps) != 1 || num(t, stateOf(t, emps[0])["IncomePerTick"]) != income || office["Boss"] != "" {
		t.Fatalf("отклонённая дельта изменила живой офис: %v", office)
	}
	if got := num(t, stateOf(t, save["config"])["EmployeeLevelXP"].([]any)[0]); got != xp {
		t.Fatalf("отклонённая дельта изменила конфиг сессии: EmployeeLevelXP[0]=%d, было %d", got, xp)
	}
	if h.Config.EmployeeLevelXP[0] != xp {
		t.Fatalf("отклонённая дельта изменила базовый конфиг сервера: %d, было %d", h.Config.EmployeeLevelXP[0], xp)
	}
}

func TestDebugSessionNotLive(t *testing.T) {
	base, _ := startDebugServer(t, game.DefaultConfig(), time.Hour)
	code, out := httpDebug(t, base, "GET", "/api/debug/state?sid=never-exist-1", "")
	if code != 404 {
		t.Fatalf("нет сессии: %d %v", code, out)
	}
	if !strings.Contains(out["error"].(string), "session_not_live") {
		t.Fatalf("текст ошибки: %v", out["error"])
	}
	code, _ = httpDebug(t, base, "GET", "/api/debug/what?sid=x", "")
	if code != 404 {
		t.Fatalf("нет маршрута: %d", code)
	}
}

func TestDebugSeedSameHiresAcrossSessions(t *testing.T) {
	// Приёмка ITGAME-26: два подключения с ?seed= дают одинаковые роллы найма.
	cfg := game.DefaultConfig()
	cfg.WinTarget = 1_000_000
	base, _ := startDebugServer(t, cfg, time.Hour)

	hire := func(sid string) (names []string, incomes []int) {
		c, _, err := websocket.Dial(context.Background(),
			"ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid+"&seed=777&scenario=mid_day10", nil)
		if err != nil {
			t.Fatalf("dial %s: %v", sid, err)
		}
		defer c.CloseNow()
		var snap testMessage
		if err := wsjson.Read(context.Background(), c, &snap); err != nil {
			t.Fatal(err)
		}
		// пауза сразу: реальное время не должно вмешаться в порядок роллов
		if err := wsjson.Write(context.Background(), c, clientMessage{Type: "set_speed", Speed: 0}); err != nil {
			t.Fatal(err)
		}
		readUntil(t, context.Background(), c, func(m testMessage) bool { return m.Speed == 0 })
		// увольняем одного (компенсация) и нанимаем нового: ролл имени и выработки
		if err := wsjson.Write(context.Background(), c, clientMessage{Type: "fire", Office: 0, Slot: 0}); err != nil {
			t.Fatal(err)
		}
		readUntil(t, context.Background(), c, func(m testMessage) bool { return len(m.Offices[0].Employees) == 4 })
		if err := wsjson.Write(context.Background(), c, clientMessage{Type: "hire", Office: 0}); err != nil {
			t.Fatal(err)
		}
		hired := readUntil(t, context.Background(), c, func(m testMessage) bool { return len(m.Offices[0].Employees) == 5 })
		for _, e := range hired.Offices[0].Employees[4:] {
			names = append(names, e.Name)
			incomes = append(incomes, e.IncomePerTick)
		}
		return
	}

	n1, i1 := hire("debug-sid-0005")
	n2, i2 := hire("debug-sid-0006")
	if len(n1) == 0 {
		t.Fatal("найм не произошёл")
	}
	for i := range n1 {
		if n1[i] != n2[i] || i1[i] != i2[i] {
			t.Fatalf("роллы найма разошлись между сессиями: (%v,%v) vs (%v,%v)", n1, i1, n2, i2)
		}
	}
}

// Висящее событие, пришедшее через restore (как после реконнекта), после
// выбора не всплывает снова (ITGAME-52). Повышение остаётся валидным, пока
// адресат на месте, поэтому без фикса тот же тост поднимался следующим тиком.
func TestRestoredActiveEventChosenOnce(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 1_000_000
	cfg.EventChancePct = 0
	cfg.BreakdownChancePct = 0
	cfg.SalaryPerDay = 0
	base, _ := startDebugServer(t, cfg, 20*time.Millisecond)

	sid := "debug-sid-0052"
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1
	})

	code, out := httpDebug(t, base, "POST", "/api/debug/state", fmt.Sprintf(`{"sid":%q,"state":{
		"dayEvents":[{"ID":"raise","Tick":0,"Office":0,"Slot":0}],
		"activeEvent":{"ID":"raise","Tick":0,"Office":0,"Slot":0}}}`, sid))
	if code != 200 {
		t.Fatalf("restore: %d %v", code, out)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && m.ActiveEvent != nil && m.ActiveEvent.ID == "raise"
	})
	if err := wsjson.Write(ctx, c, clientMessage{Type: "event_choice", Slot: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.ActiveEvent == nil })
	// Несколько тиков: activateEvents не должен поднять то же повышение.
	for i := 0; i < 10; i++ {
		m := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" })
		if m.ActiveEvent != nil {
			t.Fatalf("повышение всплыло снова (%s): %+v", m.Clock, m.ActiveEvent)
		}
	}
}
