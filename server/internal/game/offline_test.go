package game

import "testing"

// Числа тестов: день = 54 тика, обед 14:00–15:00 = тики 24..29 (6 нулевых),
// продуктивных 48. Сотрудник $10/тик → полный день $480.

func TestAdvanceOfflineInsideDay(t *testing.T) {
	g := hiredGame(t)
	g.Tick() // $10 за первый тик, тик 1
	s := g.AdvanceOffline(10)
	if g.Day != 1 || g.TickInDay != 11 {
		t.Fatalf("день/тик: %d/%d, хотим 1/11", g.Day, g.TickInDay)
	}
	if s.Income != 100 || s.Days != 0 || s.GameOver || s.Victory {
		t.Fatalf("итог: %+v", s)
	}
	if g.Money != 600-300+10+100 {
		t.Fatalf("баланс %d, хотим 410", g.Money)
	}
}

func TestAdvanceOfflineLunchIsFree(t *testing.T) {
	g := hiredGame(t)
	g.AdvanceOffline(30) // 10:00 → 15:00: обеденные тики 24..29 без дохода
	if s := g.DayIncome; s != 24*10 {
		t.Fatalf("доход за 30 тиков с обедом = %d, хотим 240", s)
	}
}

func TestAdvanceOfflineFinishDayAndPartial(t *testing.T) {
	cfg := offlineTestConfig()
	cfg.SalaryPerDay = 200
	g := NewWithSeed(cfg, 1, 2)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	s := g.AdvanceOffline(cfg.DayTicks() + 5)
	// День 1 закрыт: 480 − 200 ФОТ; день 2: утро, 5 тиков × $10.
	if g.Day != 2 || g.TickInDay != 5 || g.Phase != PhaseRunning {
		t.Fatalf("день/тик/фаза: %d/%d/%s", g.Day, g.TickInDay, g.Phase)
	}
	if s.Days != 1 || s.Income != 480+50 || s.Payroll != 200 {
		t.Fatalf("итог: %+v", s)
	}
	if g.Money != 600-300+480-200+50 {
		t.Fatalf("баланс %d, хотим 630", g.Money)
	}
}

func TestAdvanceOfflineExactDayBoundary(t *testing.T) {
	g := hiredGame(t) // ФОТ 250: 480−250 = +230 за день
	s := g.AdvanceOffline(g.Config().DayTicks())
	if g.Day != 2 || g.TickInDay != 0 || g.Phase != PhaseRunning {
		t.Fatalf("ровно день: день/тик %d/%d, фаза %s", g.Day, g.TickInDay, g.Phase)
	}
	if s.Days != 1 || s.Payroll != 250 {
		t.Fatalf("итог: %+v", s)
	}
	if g.DayIncome != 0 {
		t.Fatalf("новый день начинается с нулевого дохода, есть %d", g.DayIncome)
	}
}

func TestAdvanceOfflineManyDays(t *testing.T) {
	g := hiredGame(t)
	days := 100
	s := g.AdvanceOffline(days * 54)
	if s.Days != days {
		t.Fatalf("прошло дней %d, хотим %d", s.Days, days)
	}
	if g.Money != 300+days*(480-250) {
		t.Fatalf("баланс %d, хотим %d", g.Money, 300+days*(480-250))
	}
}

func TestAdvanceOfflineBankruptcy(t *testing.T) {
	cfg := offlineTestConfig()
	cfg.SalaryPerDay = 600 // день: 480 дохода − 600 ФОТ = −120
	g := NewWithSeed(cfg, 1, 2)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	// 300 стартовых после найма: день 1 → 180, день 2 → 60, день 3 → −60 —
	// овердрафт до ФОТ $600 (ITGAME-156), партия жива.
	alive := clone(t, g)
	if s := alive.AdvanceOffline(3 * 54); s.GameOver || alive.Phase != PhaseRunning {
		t.Fatalf("−$60 в пределах ФОТ $600 — овердрафт, не банкротство: %+v, фаза %s", s, alive.Phase)
	}
	if alive.Day != 4 || alive.Money != -60 {
		t.Fatalf("после трёх дней: день %d баланс %d, хотим 4 и −60", alive.Day, alive.Money)
	}

	s := g.AdvanceOffline(10 * 54)
	if !s.GameOver || s.Reason != LoseBankrupt || g.Phase != PhaseGameOver || g.Money >= 0 {
		t.Fatalf("банкротство офлайн не поймано: %+v, фаза %s, баланс %d", s, g.Phase, g.Money)
	}
	// 180, 60, −60, −180, −300, −420, −540, −660: день 8 глубже ФОТ.
	if g.Day != 8 || g.Money != -660 {
		t.Fatalf("банкротство на дне %d с балансом %d, хотим 8 и −660", g.Day, g.Money)
	}
}

func TestAdvanceOfflineVictory(t *testing.T) {
	cfg := offlineTestConfig()
	cfg.WinTarget = 900 // 300 после найма + 230/день: цель на дне 3
	g := NewWithSeed(cfg, 1, 2)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	s := g.AdvanceOffline(3 * 54)
	if !s.Victory || g.Phase != PhaseWon {
		t.Fatalf("победа офлайн не поймана: %+v, фаза %s", s, g.Phase)
	}
	if g.Day != 3 || g.Money < cfg.WinTarget {
		t.Fatalf("победа на дне %d с балансом %d, хотим день 3 ≥ %d", g.Day, g.Money, cfg.WinTarget)
	}
}

// TestAdvanceOfflineAmenityDebuffs — без кулера и холодильника офлайн-день
// консервативно теряет на жажде и голоде: 12×10 + 12×9 + 24×8.1 = $422.4 —
// $422 вместо $480 (доход точный, ITGAME-196).
func TestAdvanceOfflineAmenityDebuffs(t *testing.T) {
	cfg := offlineTestConfig()
	cfg.ThirstMult, cfg.HungerMult = 0.9, 0.9 // как в дефолте
	g := NewWithSeed(cfg, 1, 2)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	s := g.AdvanceOffline(g.Config().DayTicks()) // закрыть только текущий день
	if s.Income != 422 {
		t.Fatalf("день без быта: доход %d, хотим 422 (дебаффы учтены)", s.Income)
	}
}

func TestAdvanceOfflineNoopOutsideRunning(t *testing.T) {
	g := hiredGame(t)
	for g.Phase == PhaseRunning {
		g.Tick()
	} // day_report
	s := g.AdvanceOffline(1000)
	if g.Day != 1 || g.TickInDay != g.Config().DayTicks() || s.Ticks != 0 {
		t.Fatalf("отчёт дня должен ждать игрока: %+v, день/тик %d/%d", s, g.Day, g.TickInDay)
	}
	if s.Income != 0 || s.Payroll != 0 {
		t.Fatalf("офлайн в фазе отчёта не должен двигать деньги: %+v", s)
	}
}

func TestAdvanceOfflineZero(t *testing.T) {
	g := hiredGame(t)
	before := g.Money
	s := g.AdvanceOffline(0)
	if g.Money != before || s.Ticks != 0 {
		t.Fatalf("нулевой офлайн изменил игру: %+v", s)
	}
}

// Поломка переживает ночь и офлайн (ITGAME-136): сломанное место молчит
// во всех днях догона, прогресс починки не теряется.
func TestAdvanceOfflineBrokenPCStaysBroken(t *testing.T) {
	g := hiredGame(t)
	g.Money = 10000
	g.Offices[0].PCs = 2
	g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{Name: "Мария Фёдорова", IncomePerTick: 10, HireDay: 1})
	broken := &g.Offices[0].Employees[0]
	broken.PCBroken, broken.RepairNeeded, broken.RepairClicks = true, 5, 2
	dayTicks := g.Config().DayTicks()
	s := g.AdvanceOffline(2*dayTicks + 6)
	// Работает только целый: сегодня 480, полный день 480, завтра 6 тиков × 10.
	if s.Income != 480+480+60 {
		t.Fatalf("доход офлайн %d, хотим 1020 (сломанный ПК молчит все дни)", s.Income)
	}
	if e := g.Offices[0].Employees[0]; !e.PCBroken || e.RepairNeeded != 5 || e.RepairClicks != 2 {
		t.Fatalf("после офлайна: broken=%v clicks=%d needed=%d, хотим true/2/5", e.PCBroken, e.RepairClicks, e.RepairNeeded)
	}
	if g.TickInDay != 6 {
		t.Fatalf("тик %d, хотим 6", g.TickInDay)
	}
}

// PrevDayIncome при офлайн-доигрывании: закрытый хвост дня, затем полные
// дни по шаблону перезаписывают его (ITGAME-50).
func TestAdvanceOfflineKeepsPrevDayIncome(t *testing.T) {
	g := hiredGame(t)
	g.DayIncome = 1000 // «утренний» доход
	g.AdvanceOffline(g.Config().DayTicks() + 5)
	if g.Day != 2 || g.PrevDayIncome != 1480 {
		t.Errorf("хвост дня: день %d, PrevDayIncome %d, хотим 2 и 1480", g.Day, g.PrevDayIncome)
	}

	g = hiredGame(t)
	g.DayIncome = 1000
	g.AdvanceOffline(2*g.Config().DayTicks() + 5)
	if g.Day != 3 || g.PrevDayIncome != 480 {
		t.Errorf("полный день: день %d, PrevDayIncome %d, хотим 3 и 480", g.Day, g.PrevDayIncome)
	}
}

// ITGAME-66: шаблон офлайна сбрасывает дневные поля только у своей копии
// сотрудников — живая игра их не теряет (раньше Employees был общим массивом).
func TestOfflineTemplateDoesNotTouchLiveEmployees(t *testing.T) {
	g := hiredGame(t)
	live := &g.Offices[0].Employees[0]
	live.UnpaidToday, live.CoffeeUntil, live.MotivatedUntil = true, 7, 8
	live.PCBroken, live.OffendedUntil = true, 9
	tpl := g.offlineTemplate()
	if e := tpl.Offices[0].Employees[0]; e.UnpaidToday || e.CoffeeUntil != 0 ||
		e.MotivatedUntil != 0 || e.OffendedUntil != 0 {
		t.Fatalf("шаблон не сбросил дневные поля: %+v", e)
	}
	// Поломка — не дневное поле: ночь её не чинит (ITGAME-136).
	if !tpl.Offices[0].Employees[0].PCBroken {
		t.Fatal("шаблон починил ПК, а поломка переживает ночь")
	}
	if !live.UnpaidToday || live.CoffeeUntil != 7 || live.MotivatedUntil != 8 ||
		!live.PCBroken || live.OffendedUntil != 9 {
		t.Fatalf("шаблон переписал живого сотрудника: %+v", *live)
	}
}
