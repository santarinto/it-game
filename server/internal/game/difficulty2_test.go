package game

import (
	"strings"
	"testing"
)

// Сложность 2.0 (ITGAME-9): кредит, рынок, комбо-цель, дедлайн дней,
// вес вируса и доля дедлайна. Норма/легко ведут себя как до итерации 17.

// d2Cfg — быстрый конфиг уровня с кредитом и без помех рандома.
func d2Cfg(limit int, rate float64) Config {
	c := DefaultConfig()
	c.CreditLimit, c.CreditRate = limit, rate
	c.BreakdownChancePct = 0
	c.EventChancePct = 0
	return c
}

// runDay — прокрутить текущий день до конца (без победы: цель недостижима).
func runDay(g *Game) *DayReport {
	for i := 0; i < g.cfg.DayTicks()+1; i++ {
		if r := g.Tick(); r != nil {
			return r
		}
	}
	return nil
}

// Кредит: минус в пределах порога — не банкротство, долг под процент.
func TestCreditDebtInsteadOfGameOver(t *testing.T) {
	g := NewWithSeed(d2Cfg(5000, 0.10), 1, 2)
	g.Money = 100
	g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{IncomePerTick: 1, HireDay: 0})
	r := runDay(g)
	if r == nil {
		t.Fatal("день не закрылся")
	}
	if g.Phase != PhaseDayReport {
		t.Fatalf("долг в пороге: фаза %s, хотели day_report (баланс %d)", g.Phase, g.Money)
	}
	if g.Money >= 0 {
		t.Fatalf("ждали долг, баланс %d", g.Money)
	}
	// $100 + 48 тиков × $1 − ФОТ 250 = −102 → процент 10% (ceil) = −113.
	if g.Money != -(102 + 11) {
		t.Errorf("долг %d, хотели −113 (−102 и процент 11)", g.Money)
	}
	found := false
	for _, l := range g.EventLog {
		if strings.Contains(l, "кредит") {
			found = true
		}
	}
	if !found {
		t.Errorf("лог дня без строки кредита: %v", g.EventLog)
	}
}

// Процент капает каждый день долга, пока баланс не вылезет в плюс.
func TestCreditInterestAccrues(t *testing.T) {
	g := NewWithSeed(d2Cfg(10_000, 0.50), 1, 2)
	g.Money = -100
	g.Offices[0].Employees = nil // без штата: долг только растёт
	_ = runDay(g)                // ФОТ 0: −100 → −150
	if g.Phase != PhaseDayReport || g.Money != -150 {
		t.Fatalf("день 1 долга: фаза %s баланс %d, хотели day_report −150", g.Phase, g.Money)
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	_ = runDay(g)
	if g.Money != -225 {
		t.Fatalf("второй день долга: %d, хотели −225", g.Money)
	}
}

// За кредитным порогом — банкротство с причиной bankrupt.
func TestCreditBeyondLimitBankrupts(t *testing.T) {
	g := NewWithSeed(d2Cfg(100, 0.10), 1, 2)
	g.Money = -90
	g.Offices[0].Employees = nil
	_ = runDay(g) // −90 − процент 9 = −99 ≤ 100: ещё живы
	if g.Phase != PhaseDayReport {
		t.Fatalf("долг −99 в пороге 100 должен жить, фаза %s", g.Phase)
	}
	// Процент утащил за порог: следующий день — финал.
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	_ = runDay(g)
	if g.Phase != PhaseGameOver || g.LoseReason != LoseBankrupt {
		t.Fatalf("фаза %s причина %q, хотели game_over/bankrupt", g.Phase, g.LoseReason)
	}
}

// Норма (кредита нет): минус — мгновенное банкротство, как до итерации 17.
func TestNoCreditInstantBankrupt(t *testing.T) {
	g := NewWithSeed(d2Cfg(0, 0), 1, 2)
	g.Money = 100
	g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{IncomePerTick: 1, HireDay: 0})
	_ = runDay(g)
	if g.Phase != PhaseGameOver || g.LoseReason != LoseBankrupt {
		t.Fatalf("фаза %s причина %q: без кредита минус = банкротство", g.Phase, g.LoseReason)
	}
}

// Рынок: день 1 без качелей, дальше шаг 5% в ±амплитуде; завтрашний
// ролл становится сегодняшним (тренд на день вперёд).
func TestMarketRollBounds(t *testing.T) {
	for _, swing := range []int{10, 15} {
		c := d2Cfg(0, 0)
		c.MarketSwingPct = swing
		g := NewWithSeed(c, 7, 9)
		if g.MarketToday != 0 {
			t.Errorf("день 1 без рынка, рынок %d%%", g.MarketToday)
		}
		seen := map[int]bool{}
		for day := 1; day <= 60; day++ {
			_ = runDay(g)
			tomorrow := g.MarketTomorrow
			if err := g.NextDay(); err != nil {
				t.Fatal(err)
			}
			if g.MarketToday != tomorrow {
				t.Fatalf("день %d: «завтра» %d не стало «сегодня» %d", g.Day, tomorrow, g.MarketToday)
			}
			if g.MarketToday%5 != 0 || g.MarketToday < -swing || g.MarketToday > swing {
				t.Fatalf("рынок %d%% вне сетки ±%d", g.MarketToday, swing)
			}
			seen[g.MarketToday] = true
		}
		if !seen[0] || len(seen) < 3 {
			t.Errorf("swing %d: качели не живут, видели %v", swing, seen)
		}
	}
}

// Рынок режет/даёт выработку: множитель применяется к доходу тика.
func TestMarketScalesIncome(t *testing.T) {
	g := NewWithSeed(d2Cfg(0, 0), 1, 2)
	g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{IncomePerTick: 10, HireDay: 0})
	g.TickInDay = 1
	g.MarketToday = 10
	if got := g.IncomePerTick(); got != 11 {
		t.Errorf("рынок +10%%: доход %d, хотели 11", got)
	}
	g.MarketToday = -50 // за пределами сетки, но множитель математический
	if got := g.IncomePerTick(); got != 5 {
		t.Errorf("рынок −50%%: доход %d, хотели 5", got)
	}
}

// Комбо-цель: денег хватает, но штат/сеть малы — победы нет; докупка
// недостающей части тут же даёт победу на следующем тике.
func TestComboVictoryNeedsStaffAndCore(t *testing.T) {
	c := d2Cfg(0, 0)
	c.WinTarget, c.WinStaff, c.WinCore = 500, 2, 1
	g := NewWithSeed(c, 1, 2)
	g.Money = 1000 // деньги уже выше цели
	if g.Tick(); g.Phase == PhaseWon {
		t.Fatal("без штата победы быть не должно")
	}
	g.Offices[0].Employees = append(g.Offices[0].Employees,
		Employee{IncomePerTick: 10, HireDay: 0}, Employee{IncomePerTick: 10, HireDay: 0})
	if g.Tick(); g.Phase == PhaseWon {
		t.Fatal("без core победы быть не должно")
	}
	g.CoreLevel = 1
	g.Tick()
	if g.Phase != PhaseWon {
		t.Fatalf("комбо собрано, фаза %s, хотели won", g.Phase)
	}
}

// Дедлайн дней: конец дня X без победы — финал time_up; победа в самый
// последний день всё равно сильнее таймера.
func TestDayLimitTimeUp(t *testing.T) {
	c := d2Cfg(0, 0)
	c.WinTarget = 1_000_000 // недостижимо
	c.WinDayLimit = 2
	g := NewWithSeed(c, 1, 2)
	_ = runDay(g)
	if g.Phase != PhaseDayReport {
		t.Fatalf("день 1 из 2: фаза %s, хотели day_report", g.Phase)
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	_ = runDay(g)
	if g.Phase != PhaseGameOver || g.LoseReason != LoseTimeUp {
		t.Fatalf("фаза %s причина %q, хотели game_over/time_up", g.Phase, g.LoseReason)
	}
}

func TestDayLimitVictoryOnLastDayWins(t *testing.T) {
	c := d2Cfg(0, 0)
	c.WinTarget = 600 // старт 600: победа первым же тиком последнего дня
	c.WinDayLimit = 1
	g := NewWithSeed(c, 1, 2)
	g.Tick()
	if g.Phase != PhaseWon {
		t.Fatalf("победа в дедлайн-день: фаза %s, хотели won", g.Phase)
	}
}

// Спека уровня: кредит/комбо/дедлайн/рынок растут с трудностью,
// норма и легко — без них (как до итерации 17).
func TestDifficulty2Levers(t *testing.T) {
	easy, norm := ConfigForDifficulty(DiffEasy), ConfigForDifficulty(DiffNormal)
	for i, c := range []Config{easy, norm} {
		if c.CreditLimit != 0 || c.WinStaff != 0 || c.WinCore != 0 || c.WinDayLimit != 0 || c.MarketSwingPct != 0 {
			t.Errorf("уровень %d без рычагов 2.0: %+v", i, c)
		}
	}
	hard, hardcore := ConfigForDifficulty(DiffHard), ConfigForDifficulty(DiffHardcore)
	if hard.CreditLimit != 5000 || hard.CreditRate != 0.10 || hard.WinStaff != 24 || hard.WinCore != 3 || hard.MarketSwingPct != 10 {
		t.Errorf("сложно: рычаги 2.0 не по спеке: %+v", hard)
	}
	if hardcore.CreditLimit != 10000 || hardcore.CreditRate != 0.15 || hardcore.WinDayLimit != 30 || hardcore.MarketSwingPct != 15 {
		t.Errorf("хардкор: рычаги 2.0 не по спеке: %+v", hardcore)
	}
	// Вес вируса и доля дедлайна монотонно растут с уровнем.
	if !(easy.VirusWeightK < norm.VirusWeightK && norm.VirusWeightK < hard.VirusWeightK && hard.VirusWeightK < hardcore.VirusWeightK) {
		t.Error("вес вируса должен расти с уровнем")
	}
	if !(easy.DeadlineGoalShare < norm.DeadlineGoalShare && norm.DeadlineGoalShare < hard.DeadlineGoalShare && hard.DeadlineGoalShare < hardcore.DeadlineGoalShare) {
		t.Error("доля дедлайна должна расти с уровнем")
	}
}

// Дедлайн-событие: цель = доля уровня × базовая выработка окна × рынок дня.
func TestDeadlineGoalScalesWithShareAndMarket(t *testing.T) {
	mk := func(share float64, market int) int {
		c := d2Cfg(0, 0)
		c.DeadlineGoalShare = share
		g := NewWithSeed(c, 1, 2)
		g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{IncomePerTick: 10, HireDay: 0})
		g.MarketToday = market
		g.TickInDay = 12 // 12:00 — окно до 17:00
		return g.deadlineGoalFor()
	}
	base := mk(0.7, 0)
	if got := mk(0.85, 0); got <= base {
		t.Errorf("доля 0.85: цель %d должна быть жирнее базовой %d", got, base)
	}
	if got := mk(0.7, -10); got >= base {
		t.Errorf("рынок −10%%: цель %d должна быть ниже базовой %d", got, base)
	}
}

// Офлайн: долг в пороге живёт, проценты капают, за порогом — финал.
func TestOfflineCreditAndDayLimit(t *testing.T) {
	c := d2Cfg(5000, 0.10)
	c.WinDayLimit = 3
	g := NewWithSeed(c, 1, 2)
	g.Money = -100
	g.Offices[0].Employees = nil
	s := g.AdvanceOffline(g.cfg.DayTicks() * 3)
	if !s.GameOver {
		t.Fatalf("дедлайн прошёл офлайн: %+v", s)
	}
	if s.Reason != LoseTimeUp && s.Reason != LoseBankrupt {
		t.Errorf("причина офлайн-финала %q", s.Reason)
	}
	if g.Phase != PhaseGameOver {
		t.Errorf("фаза %s, хотели game_over", g.Phase)
	}
}
