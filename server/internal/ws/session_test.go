package ws

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
)

// testMessage покрывает state, error, day_report и game_over —
// удобно читать любой ответ сервера одним типом.
type testMessage struct {
	Type    string `json:"type"`
	Code    string `json:"code"`
	Money   int    `json:"money"`
	Offices []struct {
		Employees []struct {
			Name            string `json:"name"`
			IncomePerTick   int    `json:"incomePerTick"`
			Salary          int    `json:"salary"`
			PCBroken        bool   `json:"pcBroken"`
			RepairClicks    int    `json:"repairClicks"`
			MotivateReadyAt string `json:"motivateReadyAt"`
		} `json:"employees"`
	} `json:"offices"`
	Day          int      `json:"day"`
	Phase        string   `json:"phase"`
	Speed        int      `json:"speed"`
	Payroll      int      `json:"payroll"`
	Balance      int      `json:"balance"`
	Incidents    int      `json:"incidents"`
	LostIncome   int      `json:"lostIncome"`
	Events       []string `json:"events"`
	DaysSurvived int      `json:"daysSurvived"`
	Difficulty   string   `json:"difficulty"`
	WinTarget    int      `json:"winTarget"`
	ActiveEvent  *struct {
		ID      string   `json:"id"`
		Title   string   `json:"title"`
		Text    string   `json:"text"`
		Options []string `json:"options"`
	} `json:"activeEvent"`
	Prices struct {
		PC     int `json:"pc"`
		Repair int `json:"repair"`
	} `json:"prices"`
}

func dialTestServer(t *testing.T, cfg game.Config, tick time.Duration) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := httptest.NewServer(&Handler{Config: cfg, TickInterval: tick})
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, ctx
}

func dialTestServerQuery(t *testing.T, cfg game.Config, tick time.Duration, query string) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := httptest.NewServer(&Handler{Config: cfg, TickInterval: tick})
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+query, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, ctx
}

// readUntil читает сообщения, пока не встретит подходящее (или упадёт по таймауту ctx).
func readUntil(t *testing.T, ctx context.Context, c *websocket.Conn, ok func(testMessage) bool) testMessage {
	t.Helper()
	for i := 0; i < 1000; i++ {
		var msg testMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			t.Fatalf("readUntil: %v", err)
		}
		if ok(msg) {
			return msg
		}
	}
	t.Fatal("readUntil: 1000 сообщений без совпадения")
	return testMessage{}
}

func TestSessionCommands(t *testing.T) {
	// Тикер на час: тики не мешают проверке команд.
	c, ctx := dialTestServer(t, game.DefaultConfig(), time.Hour)

	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatalf("первый снапшот: %v", err)
	}
	if msg.Type != "state" || msg.Money != 600 {
		t.Fatalf("первый снапшот: %+v", msg)
	}

	// Успешный найм.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "state" || len(msg.Offices) == 0 || len(msg.Offices[0].Employees) != 1 || msg.Money != 300 {
		t.Fatalf("после найма: %+v", msg)
	}

	// Сервер не по карману — ошибка с кодом.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "buy_server"}); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "error" || msg.Code != "not_enough_money" {
		t.Fatalf("хотим error/not_enough_money, получили: %+v", msg)
	}
}

func TestSessionTicks(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.BreakdownChancePct = 0 // поломка ПК не должна рвать рост денег в тесте
	c, ctx := dialTestServer(t, cfg, 10*time.Millisecond)

	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	// Ждём, пока доход от тиков превысит остаток после найма ($300).
	for msg.Money <= 300 {
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			t.Fatalf("ждали рост денег от тиков: %v (последнее: %+v)", err, msg)
		}
	}
}

func TestSessionDayCycle(t *testing.T) {
	cfg := game.DefaultConfig()
	// День = 2 тика: 1 час по 2 тика.
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 2
	c, ctx := dialTestServer(t, cfg, 5*time.Millisecond)

	// Без сотрудников ФОТ 0 — день кончается отчётом, не банкротством.
	rep := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" })
	if rep.Day != 1 || rep.Payroll != 0 || rep.Balance != 600 {
		t.Fatalf("отчёт дня 1: %+v", rep)
	}
	// Покупка в фазе отчёта отклоняется.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	errMsg := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if errMsg.Code != "wrong_phase" {
		t.Fatalf("хотим wrong_phase, получили %+v", errMsg)
	}
	// next_day запускает день 2.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "next_day"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Day == 2 && m.Phase == "running" })
}

func TestSessionBankruptcyAndRestart(t *testing.T) {
	cfg := game.DefaultConfig()
	// День = 1 секунда (100 тиков по 10мс): огромный запас, чтобы hire успел.
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 100
	cfg.SalaryPerDay = 100000 // гарантированное банкротство с одним сотрудником
	c, ctx := dialTestServer(t, cfg, 10*time.Millisecond)

	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	first := readUntil(t, ctx, c, func(m testMessage) bool {
		return (m.Type == "state" && len(m.Offices) > 0 && len(m.Offices[0].Employees) == 1) || m.Type == "error"
	})
	if first.Type == "error" {
		t.Fatalf("hire не успел до конца дня: %+v", first)
	}
	if e := first.Offices[0].Employees[0]; e.Name == "" || e.IncomePerTick < 9 || e.IncomePerTick > 14 {
		t.Fatalf("нанятый сотрудник в снапшоте подозрителен: %+v", e)
	}
	over := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "game_over" })
	if over.DaysSurvived != 1 || over.Balance >= 0 {
		t.Fatalf("итоги банкротства: %+v", over)
	}
	// restart возвращает стартовое состояние.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "restart"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && m.Money == 600 && len(m.Offices) > 0 && len(m.Offices[0].Employees) == 0 && m.Day == 1 && m.Phase == "running"
	})
}

func TestSessionOfficeCommand(t *testing.T) {
	cfg := game.DefaultConfig()
	c, ctx := dialTestServer(t, cfg, time.Hour)
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" })
	// Команда в закрытый офис — ошибка office_locked.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 1}); err != nil {
		t.Fatal(err)
	}
	e := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if e.Code != "office_locked" {
		t.Fatalf("хотим office_locked, получили %+v", e)
	}
}

func TestSessionSetSpeed(t *testing.T) {
	c, ctx := dialTestServer(t, game.DefaultConfig(), time.Hour)
	first := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" })
	if first.Speed != 1 {
		t.Fatalf("стартовая скорость %d, хотим 1", first.Speed)
	}
	// Смена скорости подтверждается снапшотом с новым speed.
	if err := wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 2}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Speed == 2 })
	// Скорость вне 0..3 — ошибка bad_speed.
	if err := wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 4}); err != nil {
		t.Fatal(err)
	}
	e := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if e.Code != "bad_speed" {
		t.Fatalf("хотим bad_speed, получили %+v", e)
	}
}

func TestSessionPause(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.StartMoney = 10_000    // найм и покупка на паузе не должны упираться в деньги
	cfg.BreakdownChancePct = 0 // и поломки не должны глушить доход сотрудника
	c, ctx := dialTestServer(t, cfg, 10*time.Millisecond)
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" })
	// Сотрудник, чтобы на тиках капал доход.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	// Пауза: подтверждение — снапшот со speed=0; запоминаем деньги.
	if err := wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 0}); err != nil {
		t.Fatal(err)
	}
	paused := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Speed == 0 })
	// Даём реальному времени пройти: без паузы тут накапало бы ~30 тиков.
	time.Sleep(300 * time.Millisecond)
	// Команды на паузе работают (buy_pc), а деньги от тиков не менялись:
	// ответ на покупку отличается ровно на цену ПК.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "buy_pc", Office: 0}); err != nil {
		t.Fatal(err)
	}
	after := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" || m.Type == "error" })
	if after.Type == "error" {
		t.Fatalf("покупка на паузе должна работать: %+v", after)
	}
	if want := paused.Money - 575; after.Money != want { // второй ПК дорожает ×1.15
		t.Fatalf("на паузе тикали деньги: было %d, после покупки %d, хотим %d", paused.Money, after.Money, want)
	}
	// Снятие паузы: тики снова идут, деньги растут.
	if err := wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 3}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Money > after.Money })
}

func TestDifficultyFromQuery(t *testing.T) {
	c, ctx := dialTestServerQuery(t, game.DefaultConfig(), time.Hour, "?difficulty=hardcore")
	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Difficulty != "hardcore" || msg.Money != 480 || msg.Prices.PC != 750 || msg.WinTarget != 1000000 {
		t.Fatalf("хардкор-снапшот: %+v", msg)
	}
}

func TestDifficultyGarbageIsNormal(t *testing.T) {
	c, ctx := dialTestServerQuery(t, game.DefaultConfig(), time.Hour, "?difficulty=xxx")
	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Difficulty != "normal" || msg.Money != 600 {
		t.Fatalf("мусорная сложность должна дать норму: %+v", msg)
	}
}

// TestActiveDayProtocol — активный день: мотивация, поломки и починка
// через команды протокола, новые поля в снапшоте и отчёте дня.
func TestActiveDayProtocol(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.BreakdownChancePct = 100 // поломка первым же тиком
	cfg.StartMoney = 10_000
	c, ctx := dialTestServer(t, cfg, time.Hour)

	var first testMessage
	if err := wsjson.Read(ctx, c, &first); err != nil {
		t.Fatal(err)
	}
	if first.Prices.Repair != 150 {
		t.Fatalf("prices.repair = %d, хотим 150", first.Prices.Repair)
	}

	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1
	})

	// Мотивация: бафф применён, кулдаун виден в снапшоте.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "motivate", Office: 0, Slot: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && m.Offices[0].Employees[0].MotivateReadyAt != ""
	})
	if err := wsjson.Write(ctx, c, clientMessage{Type: "motivate", Office: 0, Slot: 0}); err != nil {
		t.Fatal(err)
	}
	e := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if e.Code != "motivate_cooldown" {
		t.Fatalf("хотим motivate_cooldown, получили %+v", e)
	}

	// Поломку не ждём: тикер на час, это тест протокола, не симуляции.
	// По целому ПК вызов мастера законно отклоняется not_broken;
	// починку кликами покрывает TestActiveDayBrokenSnapshot.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "call_master", Office: 0, Slot: 0}); err != nil {
		t.Fatal(err)
	}
	e = readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if e.Code != "not_broken" {
		t.Fatalf("хотим not_broken, получили %+v", e)
	}
}

// TestActiveDayBrokenSnapshot — поломка тиком видна в снапшоте, чинится
// кликами; отчёт дня несёт инциденты и упущенный доход.
func TestActiveDayBrokenSnapshot(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.BreakdownChancePct = 100
	cfg.StartMoney = 100_000 // никуда не банкротимся
	// День из 100 тиков по 20мс (~2с): hire гарантированно успевает
	// до конца дня (гонка короткого дня), отчёт приходит быстро.
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 100
	cfg.SalaryPerDay = 0
	c, ctx := dialTestServer(t, cfg, 20*time.Millisecond)

	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	// Ждём снапшот со сломанным ПК и чиним тремя кликами.
	broken := readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1 && m.Offices[0].Employees[0].PCBroken
	})
	if broken.Offices[0].Employees[0].RepairClicks != 0 {
		t.Fatalf("RepairClicks при поломке = %d, хотим 0", broken.Offices[0].Employees[0].RepairClicks)
	}
	for i := 0; i < 3; i++ {
		if err := wsjson.Write(ctx, c, clientMessage{Type: "repair_click", Office: 0, Slot: 0}); err != nil {
			t.Fatal(err)
		}
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1 && !m.Offices[0].Employees[0].PCBroken
	})
	// Отчёт дня несёт статистику инцидентов.
	rep := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" })
	if rep.Incidents < 1 {
		t.Fatalf("отчёт без инцидентов: %+v", rep)
	}
}

// TestEventsProtocol — события «Unseen Forces»: activeEvent в снапшоте,
// event_choice, no_event после решения, events в отчёте дня.
func TestEventsProtocol(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.EventChancePct = 100 // день 2 гарантированно с событием
	cfg.EventSecondPct = 0
	cfg.BreakdownChancePct = 0
	cfg.SalaryPerDay = 0 // не банкротимся за два дня
	c, ctx := dialTestServer(t, cfg, 20*time.Millisecond)

	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1
	})
	// День 1 без событий: дожидаемся отчёта и переходим в день 2.
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "next_day"}); err != nil {
		t.Fatal(err)
	}
	// Событие дня 2: любая опция 0 валидна для любого типа.
	ev := readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && m.Day == 2 && m.ActiveEvent != nil
	})
	if len(ev.ActiveEvent.Options) == 0 || ev.ActiveEvent.Title == "" {
		t.Fatalf("событие без опций: %+v", ev.ActiveEvent)
	}
	if err := wsjson.Write(ctx, c, clientMessage{Type: "event_choice", Slot: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && m.ActiveEvent == nil
	})
	// Повторный выбор без события — no_event; плохой индекс не проверяем:
	// событие уже закрыто, проверка bad_option в юнит-тестах.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "event_choice", Slot: 0}); err != nil {
		t.Fatal(err)
	}
	e := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if e.Code != "no_event" {
		t.Fatalf("хотим no_event, получили %+v", e)
	}
	// Отчёт дня 2 несёт events-массив (может быть пустым после выбора,
	// но не null).
	rep := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" && m.Day == 2 })
	if rep.Events == nil {
		t.Fatal("events в отчёте дня = null, клиент ждёт массив")
	}
}

func TestVictoryMessage(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 500 // старт $600 ≥ цели: победа первым же тиком
	c, ctx := dialTestServer(t, cfg, 10*time.Millisecond)
	won := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "victory" })
	if won.Day != 1 || won.Balance < 500 || won.Difficulty != "normal" {
		t.Fatalf("victory: %+v", won)
	}
	// После победы соединение живо, покупки отвергаются wrong_phase.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "buy_pc"}); err != nil {
		t.Fatal(err)
	}
	errMsg := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if errMsg.Code != "wrong_phase" {
		t.Fatalf("покупка после победы: %+v", errMsg)
	}
}
