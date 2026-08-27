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
	r, err := Restore(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	got := r.Config()
	if got.WinTarget != cfg.WinTarget || got.Difficulty != DiffHardcore || got.SalaryPerDay != cfg.SalaryPerDay {
		t.Fatalf("конфиг не перенёсся: %+v", got)
	}
}
