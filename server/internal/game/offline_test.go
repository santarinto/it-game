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
	s := g.AdvanceOffline(10 * 54)
	if !s.GameOver || g.Phase != PhaseGameOver || g.Money >= 0 {
		t.Fatalf("банкротство офлайн не поймано: %+v, фаза %s, баланс %d", s, g.Phase, g.Money)
	}
	// 300 стартовых после найма: день 1 → 180, день 2 → 60, день 3 → −60.
	if g.Day != 3 {
		t.Fatalf("банкротство на дне %d, хотим 3", g.Day)
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
// консервативно теряет на жажде и голоде: 48 тиков → $420 вместо $480.
func TestAdvanceOfflineAmenityDebuffs(t *testing.T) {
	cfg := offlineTestConfig()
	cfg.ThirstMult, cfg.HungerMult = 0.9, 0.9 // как в дефолте
	g := NewWithSeed(cfg, 1, 2)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	s := g.AdvanceOffline(g.Config().DayTicks()) // закрыть только текущий день
	if s.Income != 420 {
		t.Fatalf("день без быта: доход %d, хотим 420 (дебаффы учтены)", s.Income)
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

func TestAdvanceOfflineBrokenPCFailsTodayFixedTomorrow(t *testing.T) {
	g := hiredGame(t)
	g.Offices[0].Employees[0].PCBroken = true // сломан в текущий день
	dayTicks := g.Config().DayTicks()
	s := g.AdvanceOffline(2*dayTicks + 6)
	// Сегодня 0 (ПК сломан), полный день 480, завтра 6 тиков × 10.
	if s.Income != 0+480+60 {
		t.Fatalf("доход офлайн %d, хотим 540 (поломка не чинится днём, чинится ночью)", s.Income)
	}
	if g.Offices[0].Employees[0].PCBroken {
		t.Fatal("новый день должен начинаться с целым ПК")
	}
	if g.TickInDay != 6 {
		t.Fatalf("тик %d, хотим 6", g.TickInDay)
	}
}
