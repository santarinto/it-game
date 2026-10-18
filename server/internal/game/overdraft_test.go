package game

import (
	"strings"
	"testing"
)

// Овердрафт на уровнях без кредита (ITGAME-156): вечерний минус до расходов
// этого вечера (PayrollPerDay) — долг без процентов, глубже — банкротство.
// Порог плавает со штатом; в минусе покупки по-прежнему закрыты.

// Минус в пределах расходов дня — долг, не game over; проценты не капают,
// строка журнала про овердрафт, покупки в минусе закрыты.
func TestOverdraftWithinPayrollSurvives(t *testing.T) {
	g := NewWithSeed(d2Cfg(0, 0), 1, 2)
	g.Money = 100
	g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{IncomePerTick: 1, HireDay: 0})
	g.beginLedger()
	if runDay(g) == nil {
		t.Fatal("день не закрылся")
	}
	if g.Phase != PhaseDayReport {
		t.Fatalf("минус в пределах ФОТ: фаза %s, хотели day_report (баланс %d)", g.Phase, g.Money)
	}
	// $100 + 48 тиков × $1 − ФОТ $250 = −102, процента нет.
	if g.Money != -102 {
		t.Errorf("долг %d, хотели −102 без процента", g.Money)
	}
	if g.Ledger.Interest != 0 {
		t.Errorf("процент в книге %d, хотели 0", g.Ledger.Interest)
	}
	l, _ := g.LedgerOf(0)
	checkLedger(t, l)

	const want = "овердрафт: долг $102 из $250 (расходы дня), без процентов"
	found := false
	for _, line := range g.EventLog {
		if strings.HasSuffix(line, want) {
			found = true
		}
		if strings.Contains(line, "кредит") {
			t.Errorf("овердрафт пишет кредитную строку: %q", line)
		}
	}
	if !found {
		t.Errorf("лог дня без строки %q: %v", want, g.EventLog)
	}

	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if err := g.BuyPC(0); err != ErrNotEnoughMoney {
		t.Errorf("покупка в минусе: err = %v, хотим %v", err, ErrNotEnoughMoney)
	}
}

// Граница: ровно ФОТ дня жив, на $1 глубже — банкротство.
func TestOverdraftBoundary(t *testing.T) {
	// День в 3 тика, один сотрудник: доход $30, ФОТ $250.
	for _, c := range []struct {
		name  string
		start int
		money int
		phase Phase
	}{
		{"within", 0, -220, PhaseDayReport},
		{"at_limit", -30, -250, PhaseDayReport},
		{"beyond", -31, -251, PhaseGameOver},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg := dayTestConfig()
			cfg.EventChancePct = 0
			g := New(cfg)
			g.Money = c.start
			g.Offices[0].Employees = testStaff(1)
			for i := 0; i < 3; i++ {
				g.Tick()
			}
			if g.Phase != c.phase || g.Money != c.money {
				t.Fatalf("фаза %s баланс %d, хотели %s и %d", g.Phase, g.Money, c.phase, c.money)
			}
			if c.phase == PhaseGameOver && g.LoseReason != LoseBankrupt {
				t.Errorf("причина %q, хотели %q", g.LoseReason, LoseBankrupt)
			}
		})
	}
}

// Порог — расходы этого вечера: наём поднимает его на зарплату нанятого.
func TestOverdraftLimitFollowsStaff(t *testing.T) {
	// Один сотрудник: −60 + 48 − 250 = −262, глубже ФОТ $250 — банкротство.
	g := NewWithSeed(d2Cfg(0, 0), 1, 2)
	g.Money = -60
	g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{IncomePerTick: 1, HireDay: 0})
	g.beginLedger()
	_ = runDay(g)
	if g.Phase != PhaseGameOver || g.LoseReason != LoseBankrupt {
		t.Fatalf("один сотрудник, баланс %d: фаза %s причина %q, хотели game_over/bankrupt", g.Money, g.Phase, g.LoseReason)
	}

	// Два сотрудника: −60 + 96 − 500 = −464, внутри ФОТ $500 — овердрафт.
	g = NewWithSeed(d2Cfg(0, 0), 1, 2)
	g.Money = -60
	g.Offices[0].PCs = 2
	g.Offices[0].Employees = append(g.Offices[0].Employees,
		Employee{IncomePerTick: 1, HireDay: 0}, Employee{IncomePerTick: 1, HireDay: 0})
	g.beginLedger()
	_ = runDay(g)
	if g.Phase != PhaseDayReport || g.Money != -464 {
		t.Fatalf("два сотрудника: фаза %s баланс %d, хотели day_report и −464", g.Phase, g.Money)
	}
}

// Офлайн-догон: порог вечера — то, что вечер списал. Полные дни платит
// шаблон (нанятый после обеда в нём оплачен), а у живой игры в цикле дней
// UnpaidToday не сбрасывается — порог, взятый у неё, был бы $250 и убил бы
// партию на дне 2.
func TestOverdraftOfflineChargedPayroll(t *testing.T) {
	cfg := offlineTestConfig()
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 400
	o := &g.Offices[0]
	o.PCs = 2
	o.Employees = []Employee{
		{Name: "Тест", IncomePerTick: 0},
		{Name: "Тест", IncomePerTick: 0, UnpaidToday: true}, // нанят после обеда
	}
	g.beginLedger()

	// День 1 списывает $250 (второй сегодня без зарплаты) → 150; день 2 по
	// шаблону — $500 → −350, внутри порога $500.
	s := g.AdvanceOffline(2 * cfg.DayTicks())
	if s.GameOver || g.Phase != PhaseRunning {
		t.Fatalf("−$350 внутри ФОТ $500 — овердрафт: %+v, фаза %s", s, g.Phase)
	}
	if g.Day != 3 || g.Money != -350 || s.Payroll != 750 {
		t.Fatalf("день %d баланс %d списано %d, хотим 3, −350 и 750", g.Day, g.Money, s.Payroll)
	}

	// День 3 — ещё $500 → −850, глубже порога $500.
	s2 := g.AdvanceOffline(cfg.DayTicks())
	if !s2.GameOver || s2.Reason != LoseBankrupt || g.Day != 3 {
		t.Fatalf("−$850 глубже ФОТ $500: %+v, день %d", s2, g.Day)
	}
}

// debtLimitGame — партия уровня d: начальник, админ, шлюз, антивирус тарифа 1
// и три сотрудника, третий нанят после обеда (сегодня без зарплаты).
func debtLimitGame(d Difficulty) *Game {
	g := NewWithSeed(ConfigForDifficulty(d), 1, 2)
	o := &g.Offices[0]
	o.PCs = 3
	o.Boss = "Ирина Соколова"
	o.Admin = "Пётр Смирнов"
	o.Employees = []Employee{
		{Name: "Артём Никитин", IncomePerTick: 9},
		{Name: "Мария Фёдорова", IncomePerTick: 9},
		{Name: "Дмитрий Смирнов", IncomePerTick: 9, UnpaidToday: true},
	}
	g.Gateway = true
	g.AVTier, g.AVTierBilled = 1, 1
	return g
}

// DebtLimit: овердрафт — расходы сегодняшнего вечера (плавают со штатом),
// кредит — порог уровня.
func TestDebtLimitByLevel(t *testing.T) {
	g := debtLimitGame(DiffNormal)
	// 2 × $250 (третий сегодня без зарплаты) + начальник $500 + админ $300 +
	// шлюз $1 + антивирус SOHO $12.
	if got := g.DebtLimit(); got != 1313 || got != g.PayrollPerDay() {
		t.Errorf("Normal: порог %d (расходы дня %d), хотим 1313", got, g.PayrollPerDay())
	}
	g.Offices[0].Employees[2].UnpaidToday = false
	if got := g.DebtLimit(); got != 1563 {
		t.Errorf("Normal, третий оплачен: порог %d, хотим 1563", got)
	}

	e := debtLimitGame(DiffEasy)
	if got := e.DebtLimit(); got <= 0 || got != e.PayrollPerDay() {
		t.Errorf("Easy: порог %d, хотим расходы дня %d (> 0)", got, e.PayrollPerDay())
	}

	if got := debtLimitGame(DiffHard).DebtLimit(); got != 5000 {
		t.Errorf("Hard: порог %d, хотим кредитный 5000", got)
	}
	if got := debtLimitGame(DiffHardcore).DebtLimit(); got != 10000 {
		t.Errorf("Hardcore: порог %d, хотим кредитный 10000", got)
	}
}
