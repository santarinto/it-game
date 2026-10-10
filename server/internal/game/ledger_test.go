package game

import (
	"encoding/json"
	"testing"
)

// checkLedger — книга сведена: слагаемые = balanceEnd − balanceStart ровно.
func checkLedger(t *testing.T, l DayLedger) {
	t.Helper()
	if l.Sum() != l.BalanceEnd {
		t.Errorf("день %d: слагаемые %d ≠ balanceEnd %d (%+v)", l.Day, l.Sum(), l.BalanceEnd, l)
	}
}

// ledgerGame — eventGame с книгой, начатой после ручной правки денег/штата.
func ledgerGame() *Game {
	g := eventGame()
	g.beginLedger()
	return g
}

// Книга дня сходится с балансом и с отчётом дня (ITGAME-73) — и в дни
// событий аудита и дедлайна (деньги событий, ITGAME-53), и с покупками.
func TestLedgerBalancesWithEventsAndPurchases(t *testing.T) {
	cases := []struct {
		name   string
		id     EventID
		option int
		setup  func(g *Game)
		after  func(g *Game) // после выбора: исход дедлайна
	}{
		{name: "аудит провален", id: EventAudit, setup: func(g *Game) { g.cfg.AuditFineShare = 0.2; g.PrevDayIncome = 1000 }},
		{name: "аудит пройден", id: EventAudit, setup: func(g *Game) { g.Gateway, g.CoreLevel = true, 2 }},
		{name: "дедлайн выполнен", id: EventDeadline, option: 0},
		{name: "дедлайн провален", id: EventDeadline, option: 0, after: func(g *Game) { g.DeadlineGoal *= 20 }},
		{name: "дедлайн отклонён", id: EventDeadline, option: 1},
		{name: "антивирус", id: EventVirus, option: 0},
		{name: "звезда нанята", id: EventStar, option: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := ledgerGame()
			if tc.setup != nil {
				tc.setup(g)
			}
			forceEvent(g, tc.id)
			start := g.Money
			g.Tick()
			if g.ActiveEvent != nil && tc.id != EventAudit {
				if err := g.ChooseEvent(tc.option); err != nil {
					t.Fatal(err)
				}
			}
			if tc.after != nil {
				tc.after(g)
			}
			// покупки посреди дня: ПК и найм — мимо прибыли, но в книге
			if err := g.Apply(CmdBuyPC, 0, 0); err != nil {
				t.Fatal(err)
			}
			if err := g.Apply(CmdHire, 0, 0); err != nil {
				t.Fatal(err)
			}
			r := finishDay(t, g)
			l, ok := g.LedgerOf(0)
			if !ok {
				t.Fatal("нет книги текущего дня")
			}
			checkLedger(t, l)
			if l.BalanceStart != start || l.BalanceEnd != r.Balance || !l.Closed {
				t.Errorf("старт %d/%d, конец %d/%d, closed %v", l.BalanceStart, start, l.BalanceEnd, r.Balance, l.Closed)
			}
			if l.Income != r.Income || l.EventMoney != r.EventMoney || l.Payroll != r.Payroll ||
				l.GatewayOpex != r.GatewayOpex || l.Profit() != r.Profit {
				t.Errorf("книга %+v расходится с отчётом %+v", l, r)
			}
			if tc.id != EventStar && tc.option == 0 && tc.id != EventDeadline && l.EventMoney == 0 {
				t.Errorf("деньги события не попали в книгу: %+v", l)
			}
			if len(l.Events) == 0 && l.EventMoney != 0 {
				t.Errorf("деньги событий без строк: %+v", l)
			}
			wantBuys := 2
			if tc.id == EventStar {
				wantBuys = 3
			}
			if len(l.Purchases) != wantBuys {
				t.Errorf("покупок %d, хотим %d: %+v", len(l.Purchases), wantBuys, l.Purchases)
			}
			// next_day: день уходит в историю закрытым, новый начинается с того же баланса
			if err := g.Apply(CmdNextDay, 0, 0); err != nil {
				t.Fatal(err)
			}
			old, ok := g.LedgerOf(1)
			if !ok || !old.Closed || old.BalanceEnd != r.Balance {
				t.Fatalf("история дня 1: %v %+v", ok, old)
			}
			checkLedger(t, old)
			cur, _ := g.LedgerOf(0)
			if cur.Day != 2 || cur.BalanceStart != r.Balance || cur.Closed || cur.FromTick != 0 {
				t.Errorf("книга дня 2: %+v", cur)
			}
		})
	}
}

// Процент по долгу при закрытии дня — отдельное слагаемое: отчёт его в
// «Прибыль» не берёт, а баланс он двигает.
func TestLedgerCreditInterest(t *testing.T) {
	cfg := DefaultConfig()
	cfg.CreditLimit, cfg.CreditRate = 1_000_000, 0.1
	cfg.BreakdownChancePct = 0
	g := NewWithSeed(cfg, 3, 4)
	g.Offices[0].PCs = 2
	g.Offices[0].Employees = []Employee{{Name: "Тест", IncomePerTick: 1}, {Name: "Тест", IncomePerTick: 1}}
	g.Money = 0
	g.beginLedger()
	r := finishDay(t, g)
	l, _ := g.LedgerOf(0)
	checkLedger(t, l)
	if l.Interest <= 0 || g.Money >= 0 {
		t.Fatalf("ожидали долг с процентом: деньги %d, книга %+v", g.Money, l)
	}
	if r.Balance != l.BalanceEnd || l.Profit() != r.Profit {
		t.Errorf("книга %+v, отчёт %+v", l, r)
	}
}

// Офлайн-движок (itd.advanceDays, догон после реконнекта): каждый день —
// своя сведённая книга, конец дня = старт следующего.
func TestLedgerOfflineDays(t *testing.T) {
	g := ledgerGame()
	g.Gateway = true
	for g.TickInDay < 10 {
		g.Tick()
	}
	if err := g.Apply(CmdBuyPC, 0, 0); err != nil {
		t.Fatal(err)
	}
	dayTicks := g.cfg.DayTicks()
	g.AdvanceOffline(3*dayTicks + 5)
	if g.Day != 4 || g.TickInDay != 15 {
		t.Fatalf("день %d тик %d", g.Day, g.TickInDay)
	}
	days := g.LedgerDayList()
	if len(days) != 4 {
		t.Fatalf("дни книги %v", days)
	}
	prevEnd := -1
	for _, d := range days {
		l, ok := g.LedgerOf(d)
		if !ok {
			t.Fatalf("нет книги дня %d", d)
		}
		checkLedger(t, l)
		if prevEnd >= 0 && l.BalanceStart != prevEnd {
			t.Errorf("день %d стартует с %d, вчера кончился на %d", d, l.BalanceStart, prevEnd)
		}
		prevEnd = l.BalanceEnd
		if d < 4 && (!l.Closed || !l.Offline || l.Payroll == 0 || l.GatewayOpex != g.cfg.GatewayOpexPerDay) {
			t.Errorf("закрытый офлайн день %d: %+v", d, l)
		}
	}
	first, _ := g.LedgerOf(1)
	if len(first.Purchases) != 1 || first.Purchases[0].Type != "buy_pc" {
		t.Errorf("покупка дня 1: %+v", first.Purchases)
	}
	if prevEnd != g.Money {
		t.Errorf("текущий день кончается на %d, баланс %d", prevEnd, g.Money)
	}
}

// Сценарий задачи на фикстуре fresh: hire → hire (no_free_pc) → день →
// buy_pc → hire (not_enough_money) → день. Книги дней 1 и 2 сведены.
func TestLedgerTaskScenario(t *testing.T) {
	g, err := NewFixture(DefaultConfig(), "fresh", "1")
	if err != nil {
		t.Fatal(err)
	}
	if g.Apply(CmdHire, 0, 0) != nil || g.Apply(CmdHire, 0, 0) != ErrNoFreePC {
		t.Fatal("первый найм принят, второй — no_free_pc")
	}
	g.AdvanceOffline(g.cfg.DayTicks())
	// выработка роллится сидом: денег ровно на ПК и не на найм — правкой
	// (она же проверяет Adjust в закрытом дне)
	g.AdjustMoney(g.NextPCPrice(0) + 100)
	if g.Apply(CmdBuyPC, 0, 0) != nil {
		t.Fatalf("buy_pc: деньги %d, книга %+v", g.Money, g.LedgerHistory)
	}
	if err := g.Apply(CmdHire, 0, 0); err != ErrNotEnoughMoney {
		t.Fatalf("hire без денег: %v (деньги %d)", err, g.Money)
	}
	g.AdvanceOffline(g.cfg.DayTicks())
	for _, d := range []int{1, 2, 3} {
		l, ok := g.LedgerOf(d)
		if !ok {
			t.Fatalf("нет книги дня %d: %v", d, g.LedgerDayList())
		}
		checkLedger(t, l)
	}
	d1, _ := g.LedgerOf(1)
	if d1.BalanceStart != g.cfg.StartMoney || len(d1.Purchases) != 1 || d1.Purchases[0] != (LedgerPurchase{Type: "hire", Price: g.cfg.HirePrice, Clock: g.ClockAt(0)}) {
		t.Errorf("день 1: %+v", d1)
	}
	d2, _ := g.LedgerOf(2)
	if len(d2.Purchases) != 1 || d2.Purchases[0].Type != "buy_pc" || d2.Payroll != g.cfg.SalaryPerDay || d2.Adjust == 0 {
		t.Errorf("день 2: %+v", d2)
	}
}

// Сейв: книга и история переживают JSON, история обрезана до LedgerDays;
// дельта, сменившая деньги, сводится через Adjust; старый сейв без книги —
// новая книга с текущего тика.
func TestLedgerSave(t *testing.T) {
	g := ledgerGame()
	for range 10 {
		g.AdvanceOffline(g.cfg.DayTicks())
	}
	for g.TickInDay < 5 {
		g.Tick()
	}
	if err := g.Apply(CmdHire, 0, 0); err != nil {
		t.Fatal(err)
	}
	if len(g.LedgerHistory) != LedgerDays {
		t.Fatalf("история %d дней, потолок %d", len(g.LedgerHistory), LedgerDays)
	}
	raw, err := json.Marshal(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	var s Save
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	g2, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := g.LedgerOf(0)
	b, _ := g2.LedgerOf(0)
	if a.Sum() != b.Sum() || len(b.Purchases) != 1 || b.Adjust != 0 || len(g2.LedgerHistory) != LedgerDays {
		t.Fatalf("книга после сейва: %+v (было %+v)", b, a)
	}
	// дельта денег (debug restore) — правка
	s.Money += 777
	g3, _ := Restore(s)
	c, _ := g3.LedgerOf(0)
	checkLedger(t, c)
	if c.Adjust != 777 {
		t.Errorf("adjust %d, хотим 777", c.Adjust)
	}
	// старый сейв без книги
	s.Ledger, s.LedgerHistory = nil, nil
	g4, _ := Restore(s)
	d, _ := g4.LedgerOf(0)
	checkLedger(t, d)
	if d.FromTick != s.TickInDay || d.BalanceStart != s.Money || d.Day != s.Day {
		t.Errorf("книга старого сейва: %+v", d)
	}
}

// debug-правка баланса и номера дня; потолок строк покупок.
func TestLedgerAdjustAndCap(t *testing.T) {
	g := ledgerGame()
	g.AdjustMoney(50000)
	g.Day = 5
	g.RelabelLedger()
	l, _ := g.LedgerOf(5)
	checkLedger(t, l)
	if l.Adjust != 50000-10000 {
		t.Errorf("adjust %d", l.Adjust)
	}
	g.Offices[0].Employees = append(g.Offices[0].Employees, testStaff(3)...)
	g.Offices[0].Employees[0].PCBroken = true
	for range ledgerItemsCap + 8 {
		g.Offices[0].Employees[0].PCBroken = true
		if err := g.Apply(CmdCallMaster, 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	l, _ = g.LedgerOf(0)
	checkLedger(t, l)
	last := l.Purchases[len(l.Purchases)-1]
	if len(l.Purchases) != ledgerItemsCap || last.N != 9 || last.Price != 9*g.cfg.MasterCallPrice {
		t.Errorf("потолок строк: %d строк, последняя %+v", len(l.Purchases), last)
	}
	if l.PurchasesTotal() != (ledgerItemsCap+8)*g.cfg.MasterCallPrice {
		t.Errorf("сумма покупок %d", l.PurchasesTotal())
	}
}
