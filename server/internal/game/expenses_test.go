package game

import "testing"

func TestPayrollWithBossAndGateway(t *testing.T) {
	g := New(DefaultConfig())
	g.Offices[0].Employees = testStaff(2) // 2×250
	g.Offices[0].Boss = "Т Б"             // +500
	g.Gateway = true                      // +1
	if p := g.PayrollPerDay(); p != 2*250+500+1 {
		t.Errorf("расходы = %d, хотим 1001", p)
	}
}

func TestUnpaidTodaySkipped(t *testing.T) {
	g := New(DefaultConfig())
	staff := testStaff(3)
	staff[1].UnpaidToday = true
	g.Offices[0].Employees = staff
	g.Offices[0].Boss = "Т Б"
	g.Offices[0].BossUnpaidToday = true
	if p := g.PayrollPerDay(); p != 2*250 {
		t.Errorf("расходы = %d, хотим 500 (без неоплачиваемых)", p)
	}
}

func TestHiredAfterLunchBoundary(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 100000
	g.Offices[0].PCs = 3
	g.TickInDay = 29 // 14:50 — ещё обед, платим полный день
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	g.TickInDay = 30 // 15:00 — после обеда, сегодня без оплаты
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].Employees[0].UnpaidToday {
		t.Error("нанятый в 14:50 должен получить зарплату")
	}
	if !g.Offices[0].Employees[1].UnpaidToday {
		t.Error("нанятый в 15:00 не должен получить зарплату сегодня")
	}
}

func TestNextDayResetsUnpaid(t *testing.T) {
	g := New(dayTestConfig())
	g.Offices[0].Employees = testStaff(1)
	g.Offices[0].Employees[0].UnpaidToday = true
	g.Offices[0].Boss = "Т Б"
	g.Offices[0].BossUnpaidToday = true
	g.Money = 100000
	for i := 0; i < dayTestConfig().DayTicks(); i++ {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].Employees[0].UnpaidToday || g.Offices[0].BossUnpaidToday {
		t.Error("NextDay должен сбросить флаги неполного дня")
	}
}

func TestRestartResetsOfficesAndGateway(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 0
	g.Gateway = true
	g.Offices[1] = Office{Unlocked: true, PCs: 3, Employees: testStaff(3), Boss: "Т Б"}
	for i := 0; i < dayTestConfig().DayTicks(); i++ {
		g.Tick()
	}
	if g.Phase != PhaseGameOver {
		t.Fatalf("подготовка: ждали game_over, Phase=%q", g.Phase)
	}
	if err := g.Restart(); err != nil {
		t.Fatal(err)
	}
	if g.Gateway || g.Offices[1].Unlocked || len(g.Offices[1].Employees) != 0 {
		t.Errorf("Restart не сбросил офисы/шлюз: %+v", g.Offices[1])
	}
	if !g.Offices[0].Unlocked || g.Offices[0].PCs != 1 {
		t.Errorf("офис 0 после Restart: %+v", g.Offices[0])
	}
}

func TestDayReportGatewayOpex(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 100000
	g.Offices[0].Employees = testStaff(1)
	g.Gateway = true
	var rep *DayReport
	for i := 0; i < dayTestConfig().DayTicks(); i++ {
		rep = g.Tick()
	}
	if rep == nil {
		t.Fatal("нет отчёта")
	}
	if rep.Payroll != 250 || rep.GatewayOpex != 1 {
		t.Errorf("Payroll=%d GatewayOpex=%d, хотим 250 и 1", rep.Payroll, rep.GatewayOpex)
	}
	// списано и то и другое
	if rep.Balance != 100000+rep.Income-250-1 {
		t.Errorf("Balance=%d не сходится", rep.Balance)
	}
}

func TestLockedOfficeNoPayroll(t *testing.T) {
	g := New(DefaultConfig())
	g.Offices[1].Employees = testStaff(3) // закрытый офис — защита от рассинхрона
	g.Offices[1].Boss = "Т Б"
	if p := g.PayrollPerDay(); p != 0 {
		t.Errorf("закрытый офис не должен попадать в расходы: %d", p)
	}
}
