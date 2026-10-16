package game

import "testing"

// Сигнал обречённой партии (ITGAME-118): на кредитных уровнях игрок в минусе
// не может ни купить, ни уволить (всё требует Money >= цена), и если доход
// штата не покрывает ФОТ и проценты, долг упирается в CreditLimit через
// BankruptInDays() дней. Эталон прогноза — офлайн-движок: та же формула дня.

// doomedGame — утро дня 8 на Hard: начальник и один слабый сотрудник
// (ФОТ $313 + $625 против ~$400 дохода), долг $2000.
func doomedGame(t *testing.T, d Difficulty) *Game {
	t.Helper()
	g := NewWithSeed(ConfigForDifficulty(d), 1, 2)
	g.Day = 8
	g.Money = -2000
	o := &g.Offices[0]
	o.PCs = 1
	o.Boss = "Ирина Соколова"
	o.Employees = []Employee{{Name: "Артём Никитин", IncomePerTick: 9, HireDay: 1}}
	g.beginLedger()
	return g
}

// clone — независимая копия через сейв: прогоняем её, живую не трогаем.
func clone(t *testing.T, g *Game) *Game {
	t.Helper()
	c, err := Restore(g.Export())
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	return c
}

func TestBankruptInDaysMatchesOfflineEngine(t *testing.T) {
	g := doomedGame(t, DiffHard)
	n := g.BankruptInDays()
	if n < 2 {
		t.Fatalf("ждали прогноз банкротства через несколько дней, получили %d", n)
	}
	dayTicks := g.cfg.DayTicks()

	alive := clone(t, g)
	alive.AdvanceOffline((n-1)*dayTicks + 1) // n-1 вечеров позади, утро дня n
	if alive.Phase == PhaseGameOver {
		t.Fatalf("за %d дней партия уже погибла (%s), прогноз %d", n-1, alive.LoseReason, n)
	}
	if got := alive.BankruptInDays(); got != 1 {
		t.Fatalf("утро последнего дня: ждали 1, получили %d", got)
	}

	dead := clone(t, g)
	dead.AdvanceOffline(n * dayTicks)
	if dead.Phase != PhaseGameOver || dead.LoseReason != LoseBankrupt {
		t.Fatalf("за %d дней ждали банкротство, получили phase=%s reason=%q", n, dead.Phase, dead.LoseReason)
	}
}

func TestBankruptInDaysStableThroughTheDay(t *testing.T) {
	g := doomedGame(t, DiffHard)
	morning := g.BankruptInDays()
	if morning < 1 {
		t.Fatalf("утром ждали сигнал, получили %d", morning)
	}
	g.AdvanceOffline(20) // до обеда и после, без событий и кофе
	if got := g.BankruptInDays(); got != morning {
		t.Fatalf("прогноз посреди дня %d, утром был %d", got, morning)
	}
}

func TestBankruptInDaysNoCreditLevel(t *testing.T) {
	g := doomedGame(t, DiffNormal)
	if got := g.BankruptInDays(); got != 0 {
		t.Fatalf("без кредита (Normal) сигнала нет, получили %d", got)
	}
}

func TestBankruptInDaysNotInDebt(t *testing.T) {
	g := doomedGame(t, DiffHard)
	g.Money = 50 // в плюсе игрок ещё может уволить или купить
	g.beginLedger()
	if got := g.BankruptInDays(); got != 0 {
		t.Fatalf("при балансе ≥ 0 сигнала нет, получили %d", got)
	}
}

func TestBankruptInDaysDebtButProfitable(t *testing.T) {
	g := doomedGame(t, DiffHard)
	o := &g.Offices[0]
	o.Boss = ""
	o.PCs = 3
	o.Employees = []Employee{
		{Name: "Артём Никитин", IncomePerTick: 14, HireDay: 1},
		{Name: "Мария Фёдорова", IncomePerTick: 14, HireDay: 1},
		{Name: "Дмитрий Смирнов", IncomePerTick: 14, HireDay: 1},
	}
	if got := g.BankruptInDays(); got != 0 {
		t.Fatalf("доход покрывает ФОТ и проценты — сигнала нет, получили %d", got)
	}
}

func TestBankruptInDaysBrokenPCsCountAsRepaired(t *testing.T) {
	g := doomedGame(t, DiffHard)
	o := &g.Offices[0]
	o.Boss = ""
	o.PCs = 3
	o.Employees = []Employee{
		{Name: "Артём Никитин", IncomePerTick: 14, HireDay: 1, PCBroken: true, RepairNeeded: 3},
		{Name: "Мария Фёдорова", IncomePerTick: 14, HireDay: 1, PCBroken: true, RepairNeeded: 3},
		{Name: "Дмитрий Смирнов", IncomePerTick: 14, HireDay: 1},
	}
	// Ремонт кликами бесплатный — это не тупик, хотя ночью ПК сами больше
	// не чинятся (ITGAME-136): прогноз обречённости считает их починенными.
	if got := g.BankruptInDays(); got != 0 {
		t.Fatalf("сломанные ПК чинятся бесплатно — сигнала нет, получили %d", got)
	}
	if !o.Employees[0].PCBroken || !o.Employees[1].PCBroken {
		t.Fatal("прогноз обречённости починил ПК в живой игре")
	}
}

func TestBankruptInDaysDeadlineComesFirst(t *testing.T) {
	g := doomedGame(t, DiffHardcore)
	full := g.BankruptInDays()
	if full < 2 {
		t.Fatalf("Hardcore: ждали прогноз в несколько дней, получили %d", full)
	}
	// Дедлайн уровня (WinDayLimit) закроет партию по time_up раньше банкротства.
	g.Day = g.cfg.WinDayLimit
	g.beginLedger()
	if got := g.BankruptInDays(); got != 0 {
		t.Fatalf("дедлайн раньше банкротства — сигнала нет, получили %d", got)
	}
}

func TestBankruptInDaysOnlyWhileRunning(t *testing.T) {
	g := doomedGame(t, DiffHard)
	if g.BankruptInDays() < 1 {
		t.Fatalf("в running ждали сигнал")
	}
	g.Phase = PhaseDayReport
	if got := g.BankruptInDays(); got != 0 {
		t.Fatalf("в отчёте дня прогноз не считаем, получили %d", got)
	}
}
