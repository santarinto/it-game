package game

import (
	"encoding/json"
	"testing"
)

// offlineTestConfig — детерминированная экономика для офлайн/сейв-тестов:
// выработка ровно $10/тик, без дебаффов быта (жажда/голод отключены),
// ни поломок, ни событий, ни звёзд. Полный день = 48 × $10 = $480.
func offlineTestConfig() Config {
	cfg := DefaultConfig()
	cfg.IncomeMin, cfg.IncomeMax = 10, 10
	cfg.ThirstMult, cfg.HungerMult = 1, 1
	cfg.BreakdownChancePct = 0
	cfg.EventChancePct = 0
	cfg.StarChancePct = 0
	return cfg
}

// hiredGame — день 1, тик 0, один сотрудник за $10/тик.
func hiredGame(t *testing.T) *Game {
	t.Helper()
	g := NewWithSeed(offlineTestConfig(), 1, 2)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestSaveRoundtrip(t *testing.T) {
	g := hiredGame(t)
	// День 1 дообеденный кусок, затем отчёт и переход в день 2.
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if g.Phase != PhaseDayReport {
		t.Fatalf("хотели день_report, получили %s", g.Phase)
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		g.Tick()
	}

	data, err := json.Marshal(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	var s Save
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	r, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if r.PrevDayIncome != 480 || r.PrevDayIncome != g.PrevDayIncome {
		t.Fatalf("PrevDayIncome после сейва: %d (было %d), хотим 480", r.PrevDayIncome, g.PrevDayIncome)
	}
	if r.Money != g.Money || r.Day != g.Day || r.TickInDay != g.TickInDay || r.Phase != g.Phase {
		t.Fatalf("поле дня/баланса разошлось: %+v vs %+v", r.Export(), g.Export())
	}
	if len(r.Offices[0].Employees) != len(g.Offices[0].Employees) {
		t.Fatal("сотрудники не перенеслись")
	}
	// Восстановленная игра живёт: следующий тик того же дохода.
	want := r.Money + r.IncomePerTick()
	r.Tick()
	if r.Money != want {
		t.Fatalf("тик после восстановления: деньги %d, хотим %d", r.Money, want)
	}
}

func TestSaveMidDayEffects(t *testing.T) {
	g := hiredGame(t)
	for i := 0; i < 5; i++ {
		g.Tick()
	}
	g.Offices[0].Employees[0].CoffeeUntil = g.TickInDay + 3 // бафф переживает сейв
	s := g.Export()
	r, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if r.Offices[0].Employees[0].CoffeeUntil != g.TickInDay+3 {
		t.Fatal("бафф кофе потерян в сейве")
	}
}

func TestRestoreRejectsGarbage(t *testing.T) {
	cases := []func(*Save){
		func(s *Save) { s.Day = 0 },
		func(s *Save) { s.Offices = nil },
		func(s *Save) { s.Phase = Phase("runs") },
		func(s *Save) { s.Phase = PhaseGameOver }, // терминальные фазы не восстанавливаем
		func(s *Save) { s.TickInDay = 9999 },
	}
	for i, mut := range cases {
		s := hiredGame(t).Export()
		mut(&s)
		if _, err := Restore(s); err == nil {
			t.Fatalf("кейс %d: мусорный сейв восстановился", i)
		}
	}
}

func TestSaveConfigSurvives(t *testing.T) {
	cfg := ConfigForDifficulty(DiffHardcore)
	g := NewWithSeed(cfg, 3, 4)
	g.MarketToday, g.MarketTomorrow = -10, 15 // рынок катится день за днём (ит. 17)
	r, err := Restore(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	got := r.Config()
	if got.WinTarget != cfg.WinTarget || got.Difficulty != DiffHardcore || got.SalaryPerDay != cfg.SalaryPerDay {
		t.Fatalf("конфиг не перенёсся: %+v", got)
	}
	if got.CreditLimit != cfg.CreditLimit || got.WinDayLimit != cfg.WinDayLimit {
		t.Fatalf("рычаги 2.0 не перенеслись: %+v", got)
	}
	if r.MarketToday != -10 || r.MarketTomorrow != 15 {
		t.Fatalf("рынок не перенёсся: сегодня %d, завтра %d", r.MarketToday, r.MarketTomorrow)
	}
}

// Сейвы до ITGAME-50: нет полей аудита в конфиге и дохода прошлого дня.
func TestRestoreFillsAuditFields(t *testing.T) {
	g := hiredGame(t)
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	s := g.Export()
	s.Config.AuditMinDay, s.Config.AuditFineShare = 0, 0
	s.PrevDayIncome = 0
	r, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	def := DefaultConfig()
	if r.Config().AuditMinDay != def.AuditMinDay || r.Config().AuditFineShare != def.AuditFineShare {
		t.Errorf("поля аудита не заполнены: day=%d share=%v", r.Config().AuditMinDay, r.Config().AuditFineShare)
	}
	if r.PrevDayIncome != 480 {
		t.Errorf("day_report: PrevDayIncome = %d, хотим 480 (доход закрытого дня)", r.PrevDayIncome)
	}

	// running: закрытого дня в сейве нет, база штрафа остаётся нулевой.
	g = hiredGame(t)
	for i := 0; i < 5; i++ {
		g.Tick()
	}
	s = g.Export()
	s.PrevDayIncome = 0
	r, err = Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if r.PrevDayIncome != 0 {
		t.Errorf("running: PrevDayIncome = %d, хотим 0", r.PrevDayIncome)
	}
}

// saveRoundtrip — сейв через JSON, как его пишет и читает ws-слой.
func saveRoundtrip(t *testing.T, g *Game) *Game {
	t.Helper()
	data, err := json.Marshal(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	var s Save
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	r, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// Висящее событие переживает сейв как элемент DayEvents, а не отдельная
// копия (ITGAME-52): выбор после реконнекта закрывает его в плане дня, и
// activateEvents не показывает его снова — второго найма звезды нет.
func TestRestoreActiveEventIsDayEvent(t *testing.T) {
	for _, id := range []EventID{EventStar, EventRaise, EventDeadline, EventVirus} {
		t.Run(string(id), func(t *testing.T) {
			g := eventGame()
			forceEvent(g, id)
			for g.ActiveEvent == nil {
				g.Tick()
			}
			r := saveRoundtrip(t, g)
			if r.ActiveEvent == nil || r.ActiveEvent != &r.DayEvents[0] {
				t.Fatalf("ActiveEvent после restore не указывает в DayEvents: %p vs %p", r.ActiveEvent, &r.DayEvents[0])
			}
			staff := len(r.Offices[0].Employees)
			if err := r.ChooseEvent(0); err != nil {
				t.Fatal(err)
			}
			if !r.DayEvents[0].Resolved {
				t.Fatal("выбор не закрыл событие в DayEvents")
			}
			hired := len(r.Offices[0].Employees)
			for i := 0; i < 5 && r.Phase == PhaseRunning; i++ {
				r.Tick()
				if r.ActiveEvent != nil {
					t.Fatalf("событие %s показано повторно на тике %d", r.ActiveEvent.ID, r.TickInDay)
				}
			}
			if id == EventStar && (hired != staff+1 || len(r.Offices[0].Employees) != hired) {
				t.Errorf("звезда: штат %d → %d → %d, хотим ровно один найм", staff, hired, len(r.Offices[0].Employees))
			}
		})
	}
}

// Аудит с открытым тостом проверяется в 18:00 и висит активным уже
// решённым до конца дня (autoResolveEvents): такой сейв пишется каждым
// тиком и обязан восстанавливаться, не штрафуя второй раз (ITGAME-52, ревью).
func TestRestoreResolvedActiveAudit(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventAudit)
	for g.TickInDay <= g.cfg.auditTick() {
		g.Tick()
	}
	if g.ActiveEvent == nil || !g.ActiveEvent.Resolved {
		t.Fatalf("хотим активный уже проверенный аудит: %+v", g.ActiveEvent)
	}
	r := saveRoundtrip(t, g)
	if r.ActiveEvent != &r.DayEvents[0] || len(r.DayEvents) != 1 {
		t.Fatalf("аудит после restore: план %+v, активное %p", r.DayEvents, r.ActiveEvent)
	}
	money := r.Money - r.IncomePerTick()
	r.Tick()
	if r.Money < money {
		t.Errorf("аудит списан повторно: %d → %d", money, r.Money)
	}
}

// Сейв старого сервера (до ITGAME-52): после реконнекта копия активного
// аудита не решена, а элемент плана чек в 18:00 уже закрыл. Решает план —
// второго штрафа нет.
func TestRestoreStaleActiveCopy(t *testing.T) {
	g := eventGame()
	g.TickInDay = g.cfg.auditTick() + 1
	s := g.Export()
	s.DayEvents = []DayEvent{{ID: EventAudit, Tick: 20, Resolved: true}}
	s.ActiveEvent = &DayEvent{ID: EventAudit, Tick: 20}
	r, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.DayEvents) != 1 || !r.DayEvents[0].Resolved || r.ActiveEvent != &r.DayEvents[0] {
		t.Fatalf("план %+v, активное %+v", r.DayEvents, r.ActiveEvent)
	}
}

// Ручной (debug) сейв, где активное событие не найдено в плане дня:
// Restore кладёт его в DayEvents, чтобы выбор было где закрыть.
func TestRestoreActiveEventMissingFromDayEvents(t *testing.T) {
	g := eventGame()
	s := g.Export()
	s.DayEvents = []DayEvent{{ID: EventAudit, Tick: 30}}
	s.ActiveEvent = &DayEvent{ID: EventStar, Tick: 22}
	r, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.DayEvents) != 2 || r.ActiveEvent == nil || r.ActiveEvent.ID != EventStar {
		t.Fatalf("план дня после restore: %+v, активное %+v", r.DayEvents, r.ActiveEvent)
	}
	if r.ActiveEvent != &r.DayEvents[0] && r.ActiveEvent != &r.DayEvents[1] {
		t.Fatal("активное событие не указывает в DayEvents")
	}
	if r.DayEvents[0].Tick > r.DayEvents[1].Tick {
		t.Errorf("план дня не отсортирован по тику: %+v", r.DayEvents)
	}
}

// Export не делит память ни с живой игрой, ни activeEvent с dayEvents
// (ITGAME-52): json.Unmarshal поверх Export() в debug restore не трогает
// живое событие и не затирает элемент плана полем activeEvent.
func TestExportDetachesEvents(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventStar)
	for g.ActiveEvent == nil {
		g.Tick()
	}
	s := g.Export()
	s.ActiveEvent.Resolved = true
	if s.DayEvents[0].Resolved {
		t.Fatal("activeEvent сейва затёр элемент dayEvents сейва")
	}
	s.DayEvents[0].Tick = 99
	if g.ActiveEvent.Resolved || g.DayEvents[0].Tick == 99 {
		t.Fatalf("правка сейва протекла в живую игру: %+v", g.DayEvents[0])
	}
}
