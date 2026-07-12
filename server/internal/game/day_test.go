package game

import "testing"

// dayTestConfig — короткий день: 1 час по 3 тика, обед за пределами дня.
func dayTestConfig() Config {
	cfg := DefaultConfig()
	cfg.WorkdayStart = 10
	cfg.WorkdayEnd = 11
	cfg.TicksPerHour = 3
	cfg.SalaryPerDay = 250
	return cfg
}

func TestNewGameDayFields(t *testing.T) {
	g := New(DefaultConfig())
	if g.Phase != PhaseRunning || g.Day != 1 || g.TickInDay != 0 {
		t.Errorf("старт дня неверен: Phase=%q Day=%d TickInDay=%d", g.Phase, g.Day, g.TickInDay)
	}
}

func TestDefaultConfigDay(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.DayTicks() != 54 || cfg.SalaryPerDay != 250 {
		t.Errorf("DayTicks()=%d SalaryPerDay=%d, хотим 54 и 250 (GDD, «Экономика»)", cfg.DayTicks(), cfg.SalaryPerDay)
	}
}

func TestPayrollPerDay(t *testing.T) {
	g := New(DefaultConfig())
	if p := g.PayrollPerDay(); p != 0 {
		t.Errorf("без сотрудников ФОТ = %d, хотим 0", p)
	}
	g.Offices[0].Employees = testStaff(3)
	if p := g.PayrollPerDay(); p != 750 {
		t.Errorf("ФОТ = %d, хотим 750", p)
	}
}

func TestDayEndsWithReport(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 1000
	g.Offices[0].Employees = testStaff(1) // $10/тик без сети
	var rep *DayReport
	for i := 0; i < 3; i++ {
		if rep != nil {
			t.Fatalf("день закончился раньше времени, тик %d", i)
		}
		rep = g.Tick()
	}
	if rep == nil {
		t.Fatal("после последнего тика дня ждём отчёт")
	}
	// доход 3×10=30, ФОТ 250: 1000+30-250 = 780
	want := DayReport{Day: 1, Income: 30, Payroll: 250, Profit: -220, Balance: 780}
	if *rep != want {
		t.Errorf("отчёт = %+v, хотим %+v", *rep, want)
	}
	if g.Phase != PhaseDayReport || g.Money != 780 {
		t.Errorf("после дня: Phase=%q Money=%d, хотим day_report и 780", g.Phase, g.Money)
	}
}

func TestDayEndBankruptcy(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 0
	g.Offices[0].Employees = testStaff(1) // доход за день 30 < ФОТ 250
	for i := 0; i < 3; i++ {
		g.Tick()
	}
	if g.Phase != PhaseGameOver {
		t.Fatalf("Phase = %q, хотим game_over", g.Phase)
	}
	if g.Money != -220 {
		t.Errorf("Money = %d, хотим -220 (сколько не хватило)", g.Money)
	}
}

func TestDayEndExactZeroSurvives(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 220 // 220 + 30 дохода − 250 ФОТ = ровно 0
	g.Offices[0].Employees = testStaff(1)
	for i := 0; i < 3; i++ {
		g.Tick()
	}
	if g.Phase != PhaseDayReport || g.Money != 0 {
		t.Errorf("баланс ровно 0 выживает: Phase=%q Money=%d", g.Phase, g.Money)
	}
}

func TestTickNoopOutsideRunning(t *testing.T) {
	g := New(dayTestConfig())
	g.Phase = PhaseDayReport
	g.Money = 100
	g.Offices[0].Employees = testStaff(1)
	if rep := g.Tick(); rep != nil || g.Money != 100 || g.TickInDay != 0 {
		t.Errorf("тик вне running должен быть no-op: rep=%v Money=%d TickInDay=%d", rep, g.Money, g.TickInDay)
	}
}

func TestPeakIncomeTracked(t *testing.T) {
	g := New(dayTestConfig())
	g.Offices[0].PCs = 2
	g.Offices[0].Employees = testStaff(2)
	g.Tick() // доход 20
	g.Offices[0].Employees = testStaff(1)
	g.Tick() // доход 10 — пик не сбрасывается
	if g.PeakIncomePerTick != 20 {
		t.Errorf("PeakIncomePerTick = %d, хотим 20", g.PeakIncomePerTick)
	}
}

func TestNextDay(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 1000
	g.Offices[0].Employees = testStaff(1)
	for i := 0; i < 3; i++ {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatalf("NextDay из отчёта: %v", err)
	}
	if g.Phase != PhaseRunning || g.Day != 2 || g.TickInDay != 0 || g.DayIncome != 0 {
		t.Errorf("после NextDay: Phase=%q Day=%d TickInDay=%d DayIncome=%d", g.Phase, g.Day, g.TickInDay, g.DayIncome)
	}
}

func TestNextDayWrongPhase(t *testing.T) {
	g := New(dayTestConfig())
	if err := g.NextDay(); err != ErrWrongPhase {
		t.Errorf("NextDay из running: err = %v, хотим %v", err, ErrWrongPhase)
	}
}

func TestRestart(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 0
	g.Offices[0].PCs = 3
	g.Offices[0].Employees = testStaff(3)
	for i := 0; i < 3; i++ {
		g.Tick()
	}
	if g.Phase != PhaseGameOver {
		t.Fatalf("подготовка: ждали game_over, Phase=%q", g.Phase)
	}
	if err := g.Restart(); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if g.Phase != PhaseRunning || g.Day != 1 || g.Money != 600 || g.Offices[0].PCs != 1 ||
		len(g.Offices[0].Employees) != 0 || g.Offices[0].RouterTier != 0 || g.Servers != 0 ||
		g.TickInDay != 0 || g.DayIncome != 0 || g.PeakIncomePerTick != 0 {
		t.Errorf("после Restart не стартовое состояние: %+v", g)
	}
}

func TestRestartWrongPhase(t *testing.T) {
	g := New(dayTestConfig())
	if err := g.Restart(); err != ErrWrongPhase {
		t.Errorf("Restart из running: err = %v, хотим %v", err, ErrWrongPhase)
	}
}

func TestApplyPhaseGating(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 10000
	g.Phase = PhaseDayReport
	for _, cmd := range []Command{CmdBuyPC, CmdHire, CmdBuyRouter, CmdBuyServer, CmdHireBoss, CmdBuyOffice, CmdBuyGateway} {
		if err := g.Apply(cmd, 0); err != ErrWrongPhase {
			t.Errorf("Apply(%s) в day_report: err = %v, хотим %v", cmd, err, ErrWrongPhase)
		}
	}
	if err := g.Apply(CmdNextDay, 0); err != nil {
		t.Errorf("Apply(next_day) в day_report: %v", err)
	}
}

func TestApplyPhaseGatingGameOver(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 10000
	g.Phase = PhaseGameOver
	for _, cmd := range []Command{CmdBuyPC, CmdHire, CmdBuyRouter, CmdBuyServer, CmdHireBoss, CmdBuyOffice, CmdBuyGateway, CmdNextDay} {
		if err := g.Apply(cmd, 0); err != ErrWrongPhase {
			t.Errorf("Apply(%s) в game_over: err = %v, хотим %v", cmd, err, ErrWrongPhase)
		}
	}
	if err := g.Apply(CmdRestart, 0); err != nil {
		t.Errorf("Apply(restart) в game_over: %v", err)
	}
}
