package game

import (
	"fmt"
	"strings"
	"testing"
)

// Админы (ITGAME-101): GDD «Админы (ITGAME-101)». Админ — свой в каждом
// офисе, как начальник: $600 найм, $300/день, не производит, в штат не
// входит; 2 клика ремонта/чистки в тик по своему офису, сначала вирус.

// deptGame — партия с купленным отделом админов: найм админа требует его.
func deptGame(money int) *Game {
	g := unlockedGame(money)
	g.AdminDept = true
	return g
}

func TestBuyAdminDept(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.HireAdmin(0); err != ErrAdminDeptLocked {
		t.Errorf("найм без отдела: %v, хотим %v", err, ErrAdminDeptLocked)
	}
	if err := unlockedGame(2999).BuyAdminDept(); err != ErrNotEnoughMoney {
		t.Errorf("отдел без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
	if err := g.Apply(CmdBuyAdminDept, 0, 0); err != nil {
		t.Fatalf("Apply(buy_admin_dept): %v", err)
	}
	if !g.AdminDept || g.Money != 100000-3000 {
		t.Errorf("после покупки: отдел %v, деньги %d; хотим true и 97000", g.AdminDept, g.Money)
	}
	if err := g.BuyAdminDept(); err != ErrAdminDeptAlready {
		t.Errorf("второй отдел: %v, хотим %v", err, ErrAdminDeptAlready)
	}
	if err := g.HireAdmin(0); err != nil {
		t.Errorf("найм после покупки отдела: %v", err)
	}
}

func TestHireAdmin(t *testing.T) {
	g := deptGame(100000)
	g.Offices[0].PCs = 2
	g.Offices[0].Employees = testStaff(2)
	staff, connected := g.TotalEmployees(), g.Network().CoreUsed
	if err := g.HireAdmin(0); err != nil {
		t.Fatalf("найм админа: %v", err)
	}
	if g.Offices[0].Admin == "" {
		t.Error("имя админа не роллнулось")
	}
	if g.Money != 100000-600 {
		t.Errorf("Money = %d, хотим 99400", g.Money)
	}
	if g.Offices[0].AdminHireDay != g.Day {
		t.Errorf("AdminHireDay = %d, хотим %d", g.Offices[0].AdminHireDay, g.Day)
	}
	if g.TotalEmployees() != staff || g.Network().CoreUsed != connected {
		t.Errorf("админ вошёл в штат/сеть: штат %d→%d, core %d→%d", staff, g.TotalEmployees(), connected, g.Network().CoreUsed)
	}
	if err := g.HireAdmin(0); err != nil {
		t.Fatalf("второй админ (смена 2): %v", err)
	}
	if err := g.HireAdmin(0); err != nil {
		t.Fatalf("третий админ (смена 3): %v", err)
	}
	if len(g.Offices[0].AdminShifts) != 3 {
		t.Errorf("число смен = %d, хотим 3", len(g.Offices[0].AdminShifts))
	}
	if err := g.HireAdmin(0); err != ErrAdminAlready {
		t.Errorf("четвёртый админ сверх лимита 3 смен: %v, хотим %v", err, ErrAdminAlready)
	}
	if err := g.HireAdmin(1); err != ErrOfficeLocked {
		t.Errorf("админ в закрытом офисе: %v, хотим %v", err, ErrOfficeLocked)
	}
	if err := deptGame(599).HireAdmin(0); err != ErrNotEnoughMoney {
		t.Errorf("админ без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
	if err := deptGame(100000).Apply(CmdHireAdmin, 0, 0); err != nil {
		t.Errorf("Apply(hire_admin): %v", err)
	}
}

func TestAdminPayroll(t *testing.T) {
	g := deptGame(100000)
	base := g.PayrollPerDay()
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if got := g.PayrollPerDay() - base; got != 300 {
		t.Errorf("зарплата админа в ФОТ = %d, хотим 300", got)
	}

	late := deptGame(100000)
	late.TickInDay = late.cfg.lunchEndTick() // 15:00
	if err := late.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if !late.Offices[0].AdminUnpaidToday || late.PayrollPerDay() != base {
		t.Errorf("нанят в 15:00: unpaid=%v ФОТ=%d, хотим true и %d", late.Offices[0].AdminUnpaidToday, late.PayrollPerDay(), base)
	}
	late.Phase = PhaseDayReport
	if err := late.NextDay(); err != nil {
		t.Fatal(err)
	}
	if late.Offices[0].AdminUnpaidToday || late.PayrollPerDay()-base != 300 {
		t.Errorf("на следующий день: unpaid=%v ФОТ+%d, хотим false и +300", late.Offices[0].AdminUnpaidToday, late.PayrollPerDay()-base)
	}
}

func TestFireAdmin(t *testing.T) {
	g := deptGame(100000)
	if err := g.FireAdmin(0); err != ErrNoAdmin {
		t.Errorf("увольнение без админа: %v, хотим %v", err, ErrNoAdmin)
	}
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	g.Day++ // нанят вчера: компенсация — день зарплаты
	if got := g.AdminFireCompensation(0); got != 300 {
		t.Errorf("компенсация = %d, хотим 300", got)
	}
	base := g.PayrollPerDay() - 300
	money := g.Money
	if err := g.Apply(CmdFireAdmin, 0, 0); err != nil {
		t.Fatalf("Apply(fire_admin): %v", err)
	}
	if g.Offices[0].Admin != "" || g.Money != money-300 || g.PayrollPerDay() != base {
		t.Errorf("после увольнения: admin=%q money %d→%d ФОТ=%d, хотим \"\", −300, %d",
			g.Offices[0].Admin, money, g.Money, g.PayrollPerDay(), base)
	}

	poor := deptGame(100000)
	if err := poor.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	poor.Day++
	poor.Money = 299
	if err := poor.FireAdmin(0); err != ErrNotEnoughMoney || poor.Offices[0].Admin == "" {
		t.Errorf("увольнение без денег: %v admin=%q, хотим %v и админ на месте", err, poor.Offices[0].Admin, ErrNotEnoughMoney)
	}
}

func TestFireAdminSameDayAfterLunch(t *testing.T) {
	g := deptGame(100000)
	g.TickInDay = g.cfg.lunchEndTick()
	base := g.PayrollPerDay()
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if got := g.AdminFireCompensation(0); got != 100 {
		t.Errorf("компенсация в день найма = %d, хотим 100", got)
	}
	money := g.Money
	if err := g.FireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if g.Money != money-100 || g.PayrollPerDay() != base || g.Offices[0].AdminUnpaidToday {
		t.Errorf("money %d→%d ФОТ=%d unpaid=%v, хотим −100, %d, false", money, g.Money, g.PayrollPerDay(), g.Offices[0].AdminUnpaidToday, base)
	}
}

func TestAdminDifficultyScaling(t *testing.T) {
	for _, c := range []struct {
		d                   Difficulty
		price, salary, dept int
	}{{DiffEasy, 480, 240, 2400}, {DiffNormal, 600, 300, 3000}, {DiffHard, 750, 375, 3750}, {DiffHardcore, 900, 450, 4500}} {
		cfg := ConfigForDifficulty(c.d)
		if cfg.AdminPrice != c.price || cfg.AdminSalaryPerDay != c.salary || cfg.AdminClicksPerTick != 2 || cfg.AdminDeptPrice != c.dept {
			t.Errorf("%s: цена %d, зарплата %d, клики %d, отдел %d; хотим %d, %d, 2, %d",
				c.d, cfg.AdminPrice, cfg.AdminSalaryPerDay, cfg.AdminClicksPerTick, cfg.AdminDeptPrice, c.price, c.salary, c.dept)
		}
	}
}

func TestAdminSaveRoundtrip(t *testing.T) {
	g := New(ConfigForDifficulty(DiffHard))
	g.Money = 100000
	g.AdminDept = true
	g.TickInDay = g.cfg.lunchEndTick()
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	s := g.Export()
	r, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if !r.AdminDept {
		t.Error("после Restore отдел админов закрыт")
	}
	if o := r.Offices[0]; o.Admin != g.Offices[0].Admin || !o.AdminUnpaidToday || o.AdminHireDay != g.Day {
		t.Errorf("после Restore: %q unpaid=%v hireDay=%d, хотим %q true %d", o.Admin, o.AdminUnpaidToday, o.AdminHireDay, g.Offices[0].Admin, g.Day)
	}

	// Сейв без полей админа в конфиге (до ITGAME-101) — цены уровня сейва.
	s.Config.AdminPrice, s.Config.AdminSalaryPerDay, s.Config.AdminClicksPerTick, s.Config.AdminDeptPrice = 0, 0, 0, 0
	r, err = Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if c := r.Config(); c.AdminPrice != 750 || c.AdminSalaryPerDay != 375 || c.AdminClicksPerTick != 2 || c.AdminDeptPrice != 3750 {
		t.Errorf("бэкфилл: %d / %d / %d / отдел %d, хотим 750 / 375 / 2 / 3750", c.AdminPrice, c.AdminSalaryPerDay, c.AdminClicksPerTick, c.AdminDeptPrice)
	}
}

// adminGame — офис 1 со штатом n по $10/тик, быт куплен, поломок и событий
// нет, админ нанят: работа админа в чистом виде.
func adminGame(t *testing.T, n int) *Game {
	t.Helper()
	cfg := DefaultConfig()
	cfg.BreakdownChancePermille = 0
	cfg.EventChancePct = 0
	g := NewWithSeed(cfg, 7, 8)
	g.Money = 100000
	g.AdminDept = true
	o := &g.Offices[0]
	o.PCs = n
	o.Employees = testStaff(n)
	o.Cooler, o.Fridge = true, true
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	return g
}

func breakSeat(e *Employee, n int) { e.PCBroken, e.RepairClicks, e.RepairNeeded = true, 0, n }

func wantTarget(t *testing.T, g *Game, oi, slot int, kind string, when string) {
	t.Helper()
	if s, k := g.Offices[oi].AdminTarget(); s != slot || k != kind {
		t.Errorf("%s: цель админа (%d, %q), хотим (%d, %q)", when, s, k, slot, kind)
	}
}

func TestAdminQueueVirusFirst(t *testing.T) {
	g := adminGame(t, 8)
	es := g.Offices[0].Employees
	es[1].Infected, es[6].Infected = true, true
	breakSeat(&es[3], 4)
	wantTarget(t, g, 0, 1, "virus", "до тика")
	g.Tick()
	if es[1].VirusClicks != 2 || es[6].VirusClicks != 0 || es[3].RepairClicks != 0 {
		t.Errorf("тик 1: клики 1=%d 6=%d ремонт=%d, хотим 2 0 0", es[1].VirusClicks, es[6].VirusClicks, es[3].RepairClicks)
	}
	g.Tick()
	wantTarget(t, g, 0, 6, "virus", "тик 2")
	g.Tick()
	wantTarget(t, g, 0, 3, "repair", "тик 3")
	if es[1].Infected || es[6].Infected {
		t.Error("тик 3: заражённые не вычищены")
	}
	g.Tick()
	g.Tick()
	wantTarget(t, g, 0, -1, "", "тик 5")
	if es[3].PCBroken {
		t.Error("тик 5: ПК не починен")
	}
}

func TestAdminTwoClicksPerTick(t *testing.T) {
	g := adminGame(t, 4)
	es := g.Offices[0].Employees
	breakSeat(&es[0], 9)
	for range 4 {
		g.Tick()
	}
	if !es[0].PCBroken || es[0].RepairClicks != 8 {
		t.Fatalf("после 4 тиков: broken=%v клики=%d, хотим true 8", es[0].PCBroken, es[0].RepairClicks)
	}
	g.Tick()
	if es[0].PCBroken {
		t.Error("N=9 не починен за 5 тиков")
	}

	g = adminGame(t, 4)
	es = g.Offices[0].Employees
	es[0].Infected, es[1].Infected, es[2].Infected = true, true, true
	for range 4 {
		g.Tick()
	}
	if !es[2].Infected {
		t.Fatal("три места вычищены быстрее 5 тиков")
	}
	g.Tick()
	if g.officeInfected(0) != 0 {
		t.Error("три места не вычищены за 5 тиков")
	}
}

func TestAdminSpareClickCarries(t *testing.T) {
	g := adminGame(t, 4)
	es := g.Offices[0].Employees
	es[0].Infected, es[0].VirusClicks = true, 2
	es[2].Infected = true
	g.Tick()
	if es[0].Infected || es[2].VirusClicks != 1 {
		t.Errorf("место 0 заражено=%v, клики места 2 = %d; хотим false и 1", es[0].Infected, es[2].VirusClicks)
	}
}

func TestAdminPreemptsRepair(t *testing.T) {
	g := adminGame(t, 8)
	es := g.Offices[0].Employees
	breakSeat(&es[0], 9)
	g.Tick()
	g.Tick()
	es[5].Infected = true
	g.Tick()
	if es[0].RepairClicks != 4 || es[5].VirusClicks != 2 {
		t.Errorf("ремонт %d, чистка %d; хотим 4 (сохранён) и 2", es[0].RepairClicks, es[5].VirusClicks)
	}
}

func TestAdminQueueBrokenInfected(t *testing.T) {
	g := adminGame(t, 8)
	es := g.Offices[0].Employees
	breakSeat(&es[0], 3)
	es[0].Infected = true
	es[4].Infected = true
	wantTarget(t, g, 0, 4, "virus", "до тика: здоровое заражённое первым")
	g.Tick()
	g.Tick() // место 4 дочищено первым кликом, второй — в ремонт
	if es[4].Infected || es[0].RepairClicks != 1 {
		t.Fatalf("тик 2: место 4 заражено=%v, ремонт=%d; хотим false и 1", es[4].Infected, es[0].RepairClicks)
	}
	g.Tick()
	if es[0].PCBroken || !es[0].Infected {
		t.Fatalf("тик 3: broken=%v infected=%v; хотим починен и всё ещё заражён", es[0].PCBroken, es[0].Infected)
	}
	wantTarget(t, g, 0, 0, "virus", "после ремонта")
	g.Tick()
	g.Tick()
	if es[0].Infected {
		t.Error("починенное место не вычищено")
	}
}

func TestAdminAndPlayerClicksAddUp(t *testing.T) {
	g := adminGame(t, 4)
	es := g.Offices[0].Employees
	breakSeat(&es[1], 5)
	for range 2 {
		if err := g.RepairClick(0, 1); err != nil {
			t.Fatal(err)
		}
	}
	g.Tick()
	if es[1].RepairClicks != 4 {
		t.Fatalf("2 клика игрока + 2 админа = %d, хотим 4", es[1].RepairClicks)
	}
	g.Tick()
	if es[1].PCBroken || g.DayAdminRepairs != 1 {
		t.Errorf("пятый клик админа: broken=%v, починок админа %d; хотим false и 1", es[1].PCBroken, g.DayAdminRepairs)
	}

	es[2].Infected = true
	g.Tick() // админ: 2 клика из 3
	if err := g.VirusClick(0, 2); err != nil {
		t.Fatal(err)
	}
	if es[2].Infected || g.DayAdminCleaned != 0 {
		t.Errorf("дочистил игрок: infected=%v, чисток админа %d; хотим false и 0", es[2].Infected, g.DayAdminCleaned)
	}
	if last := g.EventLog[len(g.EventLog)-1]; !strings.Contains(last, "вычищен вручную") {
		t.Errorf("журнал: %q, хотим «вычищен вручную»", last)
	}
	g.Tick() // целей нет: клики уходят в пустоту, ничего не ломается
	wantTarget(t, g, 0, -1, "", "чистый офис")
}

func TestAdminWorksAtLunch(t *testing.T) {
	g := adminGame(t, 4)
	g.TickInDay = g.cfg.lunchStartTick()
	breakSeat(&g.Offices[0].Employees[0], 2)
	g.Tick()
	if g.Offices[0].Employees[0].PCBroken {
		t.Error("в обед админ не чинит")
	}
}

func TestAdminOwnOfficeOnly(t *testing.T) {
	g := adminGame(t, 4)
	o1 := &g.Offices[1]
	o1.Unlocked, o1.PCs, o1.Employees = true, 2, testStaff(2)
	o1.Employees[0].Infected = true
	breakSeat(&o1.Employees[1], 3)
	g.Tick()
	if o1.Employees[0].VirusClicks != 0 || o1.Employees[1].RepairClicks != 0 {
		t.Error("админ офиса 1 кликает в офисе 2")
	}
}

func TestAdminJournal(t *testing.T) {
	g := adminGame(t, 4)
	g.TickInDay = 12 // 12:00
	g.Offices[0].Employees[0].Infected = true
	g.Tick()
	g.Tick() // третий клик — в тике 13 (12:10)
	want := "12:10 вирус: офис 1 вычищен админом к 12:10"
	if last := g.EventLog[len(g.EventLog)-1]; last != want {
		t.Errorf("журнал: %q, хотим %q", last, want)
	}

	g.Offices[0].Employees[1].Infected = true
	n := len(g.EventLog)
	if err := g.Fire(0, 1); err != nil {
		t.Fatal(err)
	}
	if len(g.EventLog) != n {
		t.Errorf("увольнение заражённого пишет в журнал: %q", g.EventLog[len(g.EventLog)-1])
	}
}

// Строка журнала дня на каждое доделанное админом место (ITGAME-170): в
// момент действия, место с единицы, итог офиса «вычищен админом» — после
// построчных; офлайн-догон журнал не трогает.
func TestAdminJournalPerSeat(t *testing.T) {
	g := adminGame(t, 4)
	g.TickInDay = 12 // 12:00
	es := g.Offices[0].Employees
	es[1].Infected, es[2].Infected = true, true
	breakSeat(&es[3], 1)
	n := len(g.EventLog)
	for range 4 {
		g.Tick()
	}
	want := []string{
		"12:10 админ офиса 1 вычистил место 2", // третий клик; лишний — месту 3
		"12:20 админ офиса 1 вычистил место 3",
		"12:20 вирус: офис 1 вычищен админом к 12:20",
		"12:30 админ офиса 1 починил место 4",
	}
	if got := g.EventLog[n:]; strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("журнал:\n%s\nхотим:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if g.DayAdminCleaned != 2 || g.DayAdminRepairs != 1 {
		t.Errorf("сводка дня: вычищено %d, починено %d; хотим 2 и 1", g.DayAdminCleaned, g.DayAdminRepairs)
	}

	off := adminGame(t, 4)
	off.TickInDay = 12
	oe := off.Offices[0].Employees
	oe[1].Infected = true
	breakSeat(&oe[3], 1)
	n = len(off.EventLog)
	off.AdvanceOffline(4)
	if oe[1].Infected || oe[3].PCBroken {
		t.Fatalf("офлайн: infected=%v broken=%v, хотим вычищено и починено", oe[1].Infected, oe[3].PCBroken)
	}
	for _, l := range off.EventLog[n:] {
		if strings.Contains(l, "админ") {
			t.Errorf("офлайн-догон пишет в журнал: %q", l)
		}
	}
}

func TestAdminClosesVirusCardAndTimer(t *testing.T) {
	g := adminGame(t, 4)
	g.Offices[0].Employees[0].Infected = true
	g.VirusWaveIn = g.cfg.VirusSpreadTicks
	g.ActiveEvent = &DayEvent{ID: EventVirus, Office: 0}
	g.Tick()
	g.Tick()
	if g.ActiveEvent != nil || g.VirusWaveIn != 0 {
		t.Errorf("после чистки админом: карточка %v, таймер %d; хотим nil и 0", g.ActiveEvent, g.VirusWaveIn)
	}
}

func TestAdminDayReportCounts(t *testing.T) {
	g := adminGame(t, 4)
	es := g.Offices[0].Employees
	breakSeat(&es[0], 3)
	es[1].Infected = true
	var rep *DayReport
	for rep == nil {
		rep = g.Tick()
	}
	if rep.AdminRepairs != 1 || rep.AdminCleaned != 1 {
		t.Errorf("отчёт: починено %d, вычищено %d; хотим 1 и 1", rep.AdminRepairs, rep.AdminCleaned)
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.DayAdminRepairs != 0 || g.DayAdminCleaned != 0 {
		t.Errorf("после NextDay: %d / %d, хотим 0 / 0", g.DayAdminRepairs, g.DayAdminCleaned)
	}
}

// vets — ветераны на потолке уровня: опыт за день не двигает выработку,
// и прогноз сверяется с вечером без поправки на уровни.
func vets(g *Game) {
	for oi := range g.Offices {
		for i := range g.Offices[oi].Employees {
			g.Offices[oi].Employees[i].XP = 576
		}
	}
}

func TestAdminForecastMatchesEvening(t *testing.T) {
	for _, admin := range []bool{true, false} {
		g := adminGame(t, 8)
		if !admin {
			if err := g.FireAdmin(0); err != nil {
				t.Fatal(err)
			}
		}
		vets(g)
		es := g.Offices[0].Employees
		breakSeat(&es[0], 9)
		es[2].Infected, es[3].Infected = true, true
		forecast := g.ForecastEndOfDay()
		runDay(g)
		if g.Money != forecast {
			t.Errorf("админ=%v: прогноз %d, вечер %d", admin, forecast, g.Money)
		}
	}
}

func TestAdminOfflineRepairsInTail(t *testing.T) {
	g := adminGame(t, 8)
	vets(g)
	g.TickInDay = 10
	breakSeat(&g.Offices[0].Employees[0], 9)
	g.Offices[0].Employees[5].Infected = true
	live, err := Restore(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	g.AdvanceOffline(20)
	for range 20 {
		live.Tick()
	}
	e := g.Offices[0].Employees
	if e[0].PCBroken || e[5].Infected {
		t.Errorf("офлайн: broken=%v infected=%v, хотим починен и вычищен", e[0].PCBroken, e[5].Infected)
	}
	if g.Money != live.Money {
		t.Errorf("офлайн %d, вживую %d", g.Money, live.Money)
	}
}

func TestAdminOfflineBacklogFirstFullDay(t *testing.T) {
	g := adminGame(t, 12)
	g.Offices[0].PCs = 12
	vets(g)
	es := g.Offices[0].Employees
	for i := range es {
		es[i].Infected = true
	}
	breakSeat(&es[0], 15)
	g.VirusWaveIn = g.cfg.VirusSpreadTicks
	dayTicks := g.cfg.DayTicks()
	g.TickInDay = dayTicks - 1
	day := g.Day
	g.AdvanceOffline(1 + 3*dayTicks)
	for i := range es {
		if es[i].Infected || es[i].PCBroken {
			t.Fatalf("место %d: infected=%v broken=%v после трёх офлайн-дней", i, es[i].Infected, es[i].PCBroken)
		}
	}
	if g.VirusWaveIn != 0 {
		t.Errorf("таймер волны %d, хотим 0: заражённых нет", g.VirusWaveIn)
	}
	inc := map[int]int{}
	for _, l := range g.LedgerHistory {
		inc[l.Day] = l.Income
	}
	if !(inc[day+1] < inc[day+2] && inc[day+2] == inc[day+3]) {
		t.Errorf("доход офлайн-дней %d/%d/%d: хотим первый меньше (админ чистит), второй = третьему",
			inc[day+1], inc[day+2], inc[day+3])
	}
}

func TestAdminVirusCardLine(t *testing.T) {
	g := adminGame(t, 4)
	g.TickInDay = 12 // 12:00
	es := g.Offices[0].Employees
	es[0].Infected, es[1].Infected, es[2].Infected = true, true, true
	g.ActiveEvent = &DayEvent{ID: EventVirus, Office: 0}
	g.Tick() // 2 клика в тике 12, остальные 7 — тики 13–16
	if text := g.ActiveEventInfo().Text; !strings.HasSuffix(text, " Админ офиса вычистит сам к 12:40.") {
		t.Errorf("карточка: %q, хотим строку «Админ офиса вычистит сам к 12:40.»", text)
	}

	g = adminGame(t, 4)
	g.TickInDay = 52 // 18:40: тики 52–53 сегодня, 0–2 завтра
	g.Offices[0].Employees[0].Infected = true
	g.Offices[0].Employees[1].Infected = true
	g.Offices[0].Employees[2].Infected = true
	g.ActiveEvent = &DayEvent{ID: EventVirus, Office: 0}
	if text := g.ActiveEventInfo().Text; !strings.HasSuffix(text, " Админ офиса вычистит сам к 10:20.") {
		t.Errorf("через ночь: %q, хотим «к 10:20»", text)
	}

	if err := g.FireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if text := g.ActiveEventInfo().Text; strings.Contains(text, "Админ") {
		t.Errorf("без админа: %q, строки про админа быть не должно", text)
	}
}

// Очередь админа дольше одного офлайн-дня (дельта конфига: чистка в 10
// кликов) дочищается в следующих днях тем же темпом — офлайн совпадает с
// живыми тиками через границы дней.
func TestAdminOfflineBacklogSeveralDays(t *testing.T) {
	g := adminGame(t, 12)
	g.cfg.VirusCleanClicks = 10
	g.Offices[0].PCs = 12
	vets(g)
	for i := range g.Offices[0].Employees {
		g.Offices[0].Employees[i].Infected = true
	}
	breakSeat(&g.Offices[0].Employees[0], 15)
	dayTicks := g.cfg.DayTicks()
	g.TickInDay = dayTicks - 1
	live, err := Restore(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	miss := 1 + 3*dayTicks + 5
	g.AdvanceOffline(miss)
	for done := 0; done < miss; done++ {
		if live.Tick() != nil {
			if err := live.NextDay(); err != nil {
				t.Fatal(err)
			}
		}
	}
	if g.Money != live.Money {
		t.Errorf("офлайн %d, вживую %d", g.Money, live.Money)
	}
	if got, want := g.officeInfected(0), live.officeInfected(0); got != want {
		t.Errorf("заражено офлайн %d, вживую %d", got, want)
	}
}

// Фикстура admin_dept (qa:admins, visreg): отдел куплен, админ офиса 1 идёт
// по очереди «место 2 → 7 → ремонт 4», офис 2 без админа.
func TestAdminDeptFixture(t *testing.T) {
	g, err := NewFixture(DefaultConfig(), "admin_dept", "1")
	if err != nil {
		t.Fatal(err)
	}
	if !g.AdminDept || g.Offices[0].Admin == "" || g.Offices[1].Admin != "" || g.Offices[2].Unlocked {
		t.Fatalf("фикстура: отдел %v, админы %q / %q, офис 3 открыт %v", g.AdminDept, g.Offices[0].Admin, g.Offices[1].Admin, g.Offices[2].Unlocked)
	}
	want := []struct {
		slot int
		kind string
	}{{1, "virus"}, {1, "virus"}, {6, "virus"}, {3, "repair"}, {3, "repair"}, {3, "repair"}, {3, "repair"}, {-1, ""}}
	for i, w := range want {
		wantTarget(t, g, 0, w.slot, w.kind, fmt.Sprintf("тик %d", i))
		g.Tick()
	}
	if s, _ := g.Offices[1].AdminTarget(); s != 2 || !g.Offices[1].Employees[2].PCBroken {
		t.Error("офис 2 без админа: сломанное место 3 должно остаться сломанным")
	}
}

func TestAdminThreeShiftsAndPayroll(t *testing.T) {
	g := deptGame(100000)
	base := g.PayrollPerDay()

	// 1-й найм: смена 1 (день)
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if got := g.PayrollPerDay() - base; got != 300 {
		t.Fatalf("смена 1 в ФОТ = %d, хотим 300", got)
	}
	if !g.Offices[0].HasAdminShift(1) || g.Offices[0].Admin == "" {
		t.Errorf("смена 1 не установлена")
	}

	// 2-й найм: смена 2 (ночь 1)
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if got := g.PayrollPerDay() - base; got != 600 {
		t.Fatalf("смены 1+2 в ФОТ = %d, хотим 600", got)
	}
	if !g.Offices[0].HasAdminShift(2) {
		t.Errorf("смена 2 не установлена")
	}

	// 3-й найм: смена 3 (ночь 2)
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if got := g.PayrollPerDay() - base; got != 900 {
		t.Fatalf("3 смены в ФОТ = %d, хотим 900", got)
	}
	if !g.Offices[0].HasAdminShift(3) {
		t.Errorf("смена 3 не установлена")
	}

	// 4-й найм: отказ
	if err := g.HireAdmin(0); err != ErrAdminAlready {
		t.Errorf("найм сверх 3 смен: %v, хотим %v", err, ErrAdminAlready)
	}

	// Увольнение смены 2 через Apply(CmdFireAdmin, office, shift)
	if err := g.Apply(CmdFireAdmin, 0, 2); err != nil {
		t.Fatalf("Apply(fire_admin 0, 2): %v", err)
	}
	if g.Offices[0].HasAdminShift(2) {
		t.Errorf("смена 2 должна быть уволена")
	}
	if got := g.PayrollPerDay() - base; got != 600 {
		t.Errorf("после увольнения смены 2 в ФОТ = %d, хотим 600", got)
	}
	if g.Offices[0].NextAdminShift() != 2 {
		t.Errorf("следующая смена для найма = %d, хотим 2", g.Offices[0].NextAdminShift())
	}

	// Найм снова занимает освободившуюся смену 2
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if !g.Offices[0].HasAdminShift(2) {
		t.Errorf("смена 2 не заполнена повторным наймом")
	}
}

func TestNightAdminWorkAndSummary(t *testing.T) {
	g := adminGame(t, 4)
	// Найм второй и третьей смен
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}

	oe := g.Offices[0].Employees
	oe[1].Infected = true
	oe[2].Infected = true
	breakSeat(&oe[3], 1)

	g.Phase = PhaseDayReport
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}

	// Проверяем, что за ночь поломка починена и заражения вычищены
	if g.Offices[0].Employees[1].Infected || g.Offices[0].Employees[2].Infected {
		t.Errorf("ночные админы не вычистили вирус: e1=%v, e2=%v", g.Offices[0].Employees[1].Infected, g.Offices[0].Employees[2].Infected)
	}
	if g.Offices[0].Employees[3].PCBroken {
		t.Errorf("ночные админы не починили ПК")
	}

	// Проверяем счётчики дня
	if g.DayAdminRepairs != 1 || g.DayAdminCleaned != 2 {
		t.Errorf("счётчики дня: repairs=%d cleaned=%d, хотим 1 и 2", g.DayAdminRepairs, g.DayAdminCleaned)
	}

	// Проверяем строку сводки в журнале в 10:00
	found := false
	want := "10:00 ночью админы починили 1 ПК, вычистили 2 мест"
	for _, l := range g.EventLog {
		if l == want {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("сводка ночной работы не найдена в журнале:\n%s\nхотим: %s", strings.Join(g.EventLog, "\n"), want)
	}
}

func TestNightAdminSingleActionSummary(t *testing.T) {
	// Только ремонт
	g := adminGame(t, 4)
	if err := g.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	breakSeat(&g.Offices[0].Employees[2], 1)
	g.Phase = PhaseDayReport
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	want := "10:00 ночью админы починили 1 ПК"
	found := false
	for _, l := range g.EventLog {
		if l == want {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("только ремонт: не найдено %q в журнале: %v", want, g.EventLog)
	}

	// Только чистка
	g2 := adminGame(t, 4)
	if err := g2.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	g2.Offices[0].Employees[1].Infected = true
	g2.Phase = PhaseDayReport
	if err := g2.NextDay(); err != nil {
		t.Fatal(err)
	}
	wantClean := "10:00 ночью админы вычистили 1 мест"
	foundClean := false
	for _, l := range g2.EventLog {
		if l == wantClean {
			foundClean = true
			break
		}
	}
	if !foundClean {
		t.Errorf("только чистка: не найдено %q в журнале: %v", wantClean, g2.EventLog)
	}

	// Ничего не требовалось делать — строки нет
	g3 := adminGame(t, 4)
	if err := g3.HireAdmin(0); err != nil {
		t.Fatal(err)
	}
	g3.Phase = PhaseDayReport
	if err := g3.NextDay(); err != nil {
		t.Fatal(err)
	}
	for _, l := range g3.EventLog {
		if strings.Contains(l, "ночью админы") {
			t.Errorf("не ожидали строки сводки, но получили: %s", l)
		}
	}
}
