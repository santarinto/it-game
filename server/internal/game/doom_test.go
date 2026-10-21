package game

import (
	"math"
	"testing"
)

// Сигнал обречённой партии (ITGAME-118): на любом уровне (кредит или
// овердрафт, ITGAME-156) игрок в минусе не может ни купить, ни уволить (всё
// требует Money >= цена), и если доход штата не покрывает ФОТ (и проценты на
// кредите), долг упирается в порог через BankruptInDays() дней. Эталон
// прогноза — офлайн-движок: та же формула дня.

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
	// Hard — кредит ($2000 из $5000 под процент); Normal/Easy — овердрафт до
	// расходов дня ($750 / $600), долг −$100 с утра, чтобы дожить до вечера.
	for _, c := range []struct {
		name  string
		diff  Difficulty
		money int
	}{
		{"hard", DiffHard, -2000},
		{"normal", DiffNormal, -100},
		{"easy", DiffEasy, -100},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := doomedGame(t, c.diff)
			g.Money = c.money
			g.beginLedger()
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
		})
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

func TestBankruptInDaysOverdraftBeyondLimit(t *testing.T) {
	g := doomedGame(t, DiffNormal) // долг $2000, овердрафт Normal — ФОТ $750
	if got := g.BankruptInDays(); got != 1 {
		t.Fatalf("долг глубже расходов дня уже утром — банкротство сегодня вечером: ждали 1, получили %d", got)
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
	// На Normal −$2000 уже глубже овердрафта $750, поэтому долг поменьше.
	for _, c := range []struct {
		name  string
		diff  Difficulty
		money int
	}{
		{"hard", DiffHard, -2000},
		{"normal", DiffNormal, -100},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := doomedGame(t, c.diff)
			g.Money = c.money
			g.beginLedger()
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
		})
	}
}

// brokenPair — doomedGame без начальника: три места по $14, два сломаны
// (ремонт не начат); очков действий points.
func brokenPair(t *testing.T, d Difficulty, points int) *Game {
	t.Helper()
	g := doomedGame(t, d)
	o := &g.Offices[0]
	o.Boss = ""
	o.PCs = 3
	o.syncWorkplaces()
	o.Employees = []Employee{
		{Name: "Артём Никитин", IncomePerTick: 14, HireDay: 1, PCBroken: true, RepairNeeded: 3},
		{Name: "Мария Фёдорова", IncomePerTick: 14, HireDay: 1, PCBroken: true, RepairNeeded: 3},
		{Name: "Дмитрий Смирнов", IncomePerTick: 14, HireDay: 1},
	}
	g.ActionPoints = points
	return g
}

func TestBankruptInDaysBrokenPCsRepairedWithPoints(t *testing.T) {
	g := brokenPair(t, DiffHard, 8)
	// Очков на оба ремонта хватает (ITGAME-127): прогноз считает места
	// починенными, хотя ночью ПК сами не чинятся (ITGAME-136).
	if got := g.BankruptInDays(); got != 0 {
		t.Fatalf("очков хватает на оба ремонта — сигнала нет, получили %d", got)
	}
	if o := &g.Offices[0]; !o.Employees[0].PCBroken || !o.Employees[1].PCBroken || g.ActionPoints != 8 {
		t.Fatal("прогноз обречённости починил ПК или потратил очки в живой игре")
	}
}

// Без очков сегодня два места стоят до утра: недобранный доход решает,
// переживёт ли партия сегодняшний вечер на овердрафте (ITGAME-127).
func TestBankruptInDaysNoPointsTodayKeepsPlacesBroken(t *testing.T) {
	probe := brokenPair(t, DiffNormal, 8)
	dayTicks := probe.cfg.DayTicks()
	tpl := probe.offlineTemplate()
	tpl.MarketToday = 0
	one := tpl.exactIncome(0, dayTicks, nil) // два места сломаны
	for i := range tpl.Offices[0].Employees {
		tpl.Offices[0].Employees[i].PCBroken = false
	}
	all := tpl.exactIncome(0, dayTicks, nil)
	inAll, _ := carryIncome(0, all)
	inOne, _ := carryIncome(0, one)
	if inAll <= inOne {
		t.Fatalf("доход со всеми местами %d не больше, чем с одним %d", inAll, inOne)
	}
	payroll := probe.PayrollPerDay()
	// Вечером ровно на пороге долга, если работают все три места.
	money := payroll - probe.debtLimit(payroll) - inAll
	if money >= 0 {
		t.Fatalf("баланс %d не в минусе — прогноз не запустится", money)
	}

	withPoints := brokenPair(t, DiffNormal, 8)
	withPoints.Money = money
	if got := withPoints.BankruptInDays(); got == 1 {
		t.Fatalf("с очками места чинятся сегодня — вечер переживаем, получили %d", got)
	}
	noPoints := brokenPair(t, DiffNormal, 0)
	noPoints.Money = money
	if got := noPoints.BankruptInDays(); got != 1 {
		t.Fatalf("без очков два места стоят до утра — банкротство сегодня, получили %d", got)
	}
}

func TestBankruptInDaysAdminOfficeIgnoresPoints(t *testing.T) {
	a := brokenPair(t, DiffHard, 0)
	b := brokenPair(t, DiffHard, 8)
	for _, g := range []*Game{a, b} {
		g.Offices[0].Admin = "Пётр Админов"
	}
	if ga, gb := a.BankruptInDays(), b.BankruptInDays(); ga != gb {
		t.Fatalf("в офисе с админом очки ни при чём: без очков %d, с очками %d", ga, gb)
	}
}

func TestDoomRepairQueueOrder(t *testing.T) {
	g := doomedGame(t, DiffHard)
	o := &g.Offices[0]
	o.Boss = ""
	o.PCs = 4
	o.syncWorkplaces()
	o.Employees = []Employee{
		{Name: "А", IncomePerTick: 10, HireDay: 1, PCBroken: true, RepairNeeded: 3},
		{Name: "Б", IncomePerTick: 14, HireDay: 1, Infected: true},
		{Name: "В", IncomePerTick: 14, HireDay: 1, PCBroken: true, RepairNeeded: 3, Infected: true},
		{Name: "Г", IncomePerTick: 20, HireDay: 1, PCBroken: true, RepairNeeded: 3, RepairClicks: 2},
	}
	tpl := g.offlineTemplate()
	q := tpl.doomRepairQueue()
	type item struct {
		slot  int
		virus bool
	}
	var got []item
	for _, f := range q {
		got = append(got, item{f.slot, f.virus})
	}
	// Ремонт возвращает всю выработку места, чистка — долю вируса (1 − VirusMult):
	// В-ремонт 14, А-ремонт 10, Б-чистка 4.2, В-чистка 4.2 (порядок мест при равенстве).
	// Г начат — бесплатен: в очереди его нет, на шаблоне он уже цел.
	want := []item{{2, false}, {0, false}, {1, true}, {2, true}}
	if len(got) != len(want) {
		t.Fatalf("очередь %v, хотим %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("очередь %v, хотим %v", got, want)
		}
	}
	if tpl.Offices[0].Employees[3].PCBroken {
		t.Error("начатый ремонт должен считаться сделанным на шаблоне")
	}
	rest, n := tpl.doomRepair(q, 3)
	if n != 3 || len(rest) != 1 || tpl.Offices[0].Employees[1].Infected || !tpl.Offices[0].Employees[2].Infected {
		t.Fatalf("3 очка: починено %d, хвост %d, Б заражён %v, В заражён %v",
			n, len(rest), tpl.Offices[0].Employees[1].Infected, tpl.Offices[0].Employees[2].Infected)
	}
	if !g.Offices[0].Employees[0].PCBroken {
		t.Error("очередь прогноза тронула живую игру")
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

// doomUnpaidHireGame — Normal, день 8, 15:30: начальник ($500), оплаченный
// сотрудник ($250) и нанятый после обеда (сегодня без зарплаты). Расходы
// сегодняшнего вечера $750, шаблона — $1000 (ITGAME-156).
func doomUnpaidHireGame(t *testing.T, income int) *Game {
	t.Helper()
	g := doomedGame(t, DiffNormal)
	g.TickInDay = 33 // 15:30, обед позади
	o := &g.Offices[0]
	o.PCs = 3
	o.Boss = "Ирина Соколова"
	o.Employees = []Employee{
		{Name: "Артём Никитин", IncomePerTick: income, HireDay: 1},
		{Name: "Мария Фёдорова", IncomePerTick: income, HireDay: 8, UnpaidToday: true},
	}
	g.beginLedger()
	return g
}

// Овердрафт плавает с ФОТ вечера: сегодня порог и списание — живой
// PayrollPerDay (нанятый после обеда не оплачен), дальше — шаблонный
// (оплачен). Тест держит именно это переключение: с шаблонным ФОТ уже
// сегодня прогноз расходится с офлайн-движком и по стартовому списанию, и по
// сегодняшнему порогу.
func TestBankruptInDaysTonightUsesLivePayroll(t *testing.T) {
	dayTicks := DefaultConfig().DayTicks()
	// Выработка, при которой чистая прибыль шаблона чуть ниже нуля: долг
	// тает медленно, и N чувствителен к $250 разницы в ФОТ.
	income := 0
	for p := 1; p <= 40; p++ {
		tpl := doomUnpaidHireGame(t, p).offlineTemplate()
		tpl.MarketToday = 0
		if int(math.Round(tpl.exactIncome(0, dayTicks, nil)))-tpl.PayrollPerDay() >= 0 {
			break
		}
		income = p
	}
	if income == 0 {
		t.Fatal("не нашли выработку с чистой прибылью шаблона ниже нуля")
	}
	probe := doomUnpaidHireGame(t, income)
	if tpl := probe.offlineTemplate(); probe.PayrollPerDay() != 750 || tpl.PayrollPerDay() != 1000 {
		t.Fatalf("ФОТ сегодня %d (хотим 750), шаблона %d (хотим 1000)", probe.PayrollPerDay(), tpl.PayrollPerDay())
	}

	for _, c := range []struct {
		name    string
		tonight int // баланс после сегодняшнего списания
		wantOne bool
	}{
		// −700 в пределах сегодняшних $750: жив, дальше шаблонный порог $1000.
		{"alive_tonight", -700, false},
		// −900 глубже сегодняшних $750, но в пределах шаблонных $1000: банкротство
		// сегодня — порог живой, не шаблонный.
		{"dead_tonight", -900, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			g := doomUnpaidHireGame(t, income)
			tpl := g.offlineTemplate()
			tpl.MarketToday = 0
			tail, _ := carryIncome(g.IncomeCarry, tpl.exactIncome(g.TickInDay, dayTicks, nil))
			g.Money = c.tonight - tail + g.PayrollPerDay()
			g.beginLedger()
			n := g.BankruptInDays()
			if n < 1 || (n == 1) != c.wantOne {
				t.Fatalf("прогноз %d, хотим %s", n, map[bool]string{true: "1", false: "≥ 2"}[c.wantOne])
			}

			// Эталон — офлайн-движок: n вечеров погибают, n−1 нет.
			remain := dayTicks - g.TickInDay
			dead := clone(t, g)
			dead.AdvanceOffline(remain + (n-1)*dayTicks)
			if dead.Phase != PhaseGameOver || dead.LoseReason != LoseBankrupt {
				t.Fatalf("за %d вечеров ждали банкротство, получили phase=%s reason=%q money=%d", n, dead.Phase, dead.LoseReason, dead.Money)
			}
			if n > 1 {
				alive := clone(t, g)
				alive.AdvanceOffline(remain + (n-2)*dayTicks)
				if alive.Phase == PhaseGameOver {
					t.Fatalf("за %d вечеров партия уже погибла (%s), прогноз %d", n-1, alive.LoseReason, n)
				}
			}
		})
	}
}

// bankruptDayByEngine — эталон: на какой вечер офлайн-движок реально
// банкротит копию (0 — не банкротит за doomHorizonDays).
func bankruptDayByEngine(t *testing.T, g *Game) int {
	t.Helper()
	dayTicks := g.cfg.DayTicks()
	c := clone(t, g)
	for d := 1; d <= doomHorizonDays; d++ {
		if d == 1 {
			c.AdvanceOffline(dayTicks - c.TickInDay)
		} else {
			c.AdvanceOffline(dayTicks)
		}
		if c.Phase == PhaseGameOver && c.LoseReason == LoseBankrupt {
			return d
		}
	}
	return 0
}

// Прогноз считает доход точной суммой с остатком компании, как зачисляет
// офлайн-движок (ITGAME-222): округление каждого тика теряет до $0.5 за тик,
// и на медленно тающем долге день банкротства уезжает. Сетка выработок и
// долгов с ненулевым остатком — прогноз обязан совпасть с движком везде.
func TestBankruptInDaysExactIncomeMatchesEngine(t *testing.T) {
	for _, carry := range []float64{0, 0.8} {
		for income := 5; income <= 12; income++ {
			for money := -740; money < 0; money += 37 {
				g := doomedGame(t, DiffNormal)
				g.Offices[0].Employees[0].IncomePerTick = income
				g.Offices[0].Boss = ""
				g.Money, g.IncomeCarry = money, carry
				g.beginLedger()
				got := g.BankruptInDays()
				want := bankruptDayByEngine(t, g)
				if got != want {
					t.Errorf("выработка %d, долг %d, остаток %v: прогноз %d, движок %d", income, money, carry, got, want)
				}
			}
		}
	}
}
