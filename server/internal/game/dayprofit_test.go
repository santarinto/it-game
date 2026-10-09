package game

import "testing"

// finishDay — тикает до конца дня и возвращает отчёт.
func finishDay(t *testing.T, g *Game) *DayReport {
	t.Helper()
	for g.Phase == PhaseRunning {
		if r := g.Tick(); r != nil {
			return r
		}
	}
	t.Fatalf("день закончился без отчёта: фаза %s", g.Phase)
	return nil
}

// «Прибыль» дня — с деньгами событий (решение владельца, ITGAME-53):
// исходы дедлайна и аудита, отказ от дедлайна, антивирус входят в отчёт,
// и в дни событий без покупок прибыль сходится с изменением баланса. Найм
// звезды — покупка, как обычный найм: в прибыль не входит.
func TestReportProfitIncludesEventMoney(t *testing.T) {
	cases := []struct {
		name    string
		id      EventID
		option  int
		setup   func(g *Game)
		event   func(g *Game) int // ожидаемые деньги событий дня
		buyCost func(g *Game) int // покупка по событию, мимо прибыли
	}{
		{name: "аудит провален", id: EventAudit, option: 0,
			setup: func(g *Game) { g.cfg.AuditFineShare = 0.2; g.PrevDayIncome = 1000 },
			event: func(g *Game) int { return -g.auditFine() }},
		{name: "аудит пройден", id: EventAudit, option: 0,
			setup: func(g *Game) { g.Gateway, g.CoreLevel = true, 2 },
			event: func(g *Game) int { return g.cfg.AuditReward }},
		{name: "дедлайн отклонён", id: EventDeadline, option: 1,
			event: nil},
		{name: "антивирус", id: EventVirus, option: 0,
			event: func(g *Game) int { return -g.cfg.VirusPrice }},
		{name: "звезда нанята", id: EventStar, option: 0,
			event:   func(g *Game) int { return 0 },
			buyCost: func(g *Game) int { return 2 * g.cfg.HirePrice }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := eventGame()
			if tc.setup != nil {
				tc.setup(g)
			}
			forceEvent(g, tc.id)
			start := g.Money
			g.Tick()
			want := 0
			if tc.event != nil {
				want = tc.event(g)
			}
			before := g.Money
			if err := g.ChooseEvent(tc.option); err != nil {
				t.Fatal(err)
			}
			if tc.event == nil { // отказ: штраф зависит от цели на момент выбора
				want = g.Money - before
				if want >= 0 {
					t.Fatalf("отказ от дедлайна без штрафа: %d", want)
				}
			}
			r := finishDay(t, g)
			if r.EventMoney != want {
				t.Errorf("деньги событий в отчёте %d, хотим %d", r.EventMoney, want)
			}
			if r.Profit != r.Income-r.Payroll-r.GatewayOpex+r.EventMoney {
				t.Errorf("прибыль %d ≠ доход %d − ФОТ %d − опекс %d + события %d",
					r.Profit, r.Income, r.Payroll, r.GatewayOpex, r.EventMoney)
			}
			buy := 0
			if tc.buyCost != nil {
				buy = tc.buyCost(g)
			}
			if r.Balance != start+r.Profit-buy {
				t.Errorf("баланс %d ≠ старт %d + прибыль %d − покупки %d", r.Balance, start, r.Profit, buy)
			}
		})
	}
}

// Исход дедлайна в 17:00 — тоже деньги события.
func TestReportProfitIncludesDeadlineOutcome(t *testing.T) {
	for _, fail := range []bool{false, true} {
		g := eventGame()
		forceEvent(g, EventDeadline)
		start := g.Money
		g.Tick()
		if err := g.ChooseEvent(0); err != nil {
			t.Fatal(err)
		}
		if fail {
			g.DeadlineGoal = 1 << 30
		}
		r := finishDay(t, g)
		if r.EventMoney == 0 || (r.EventMoney < 0) != fail {
			t.Errorf("fail=%v: деньги событий %d", fail, r.EventMoney)
		}
		if r.Balance != start+r.Profit {
			t.Errorf("fail=%v: баланс %d ≠ старт %d + прибыль %d", fail, r.Balance, start, r.Profit)
		}
	}
}

// «+X/день» в HUD — DayProfit: объявленный штраф аудита виден с тоста, а
// в 18:00, когда его списывают, линия не скачет (ITGAME-53). К концу дня
// она равна «Прибыли» отчёта.
func TestDayProfitFlatThroughAuditCheck(t *testing.T) {
	g := eventGame()
	g.cfg.AuditFineShare = 0.2
	g.PrevDayIncome = 1000
	g.DayEvents = []DayEvent{{ID: EventAudit, Tick: 20}}
	for g.ActiveEvent == nil {
		g.Tick()
	}
	for g.TickInDay < g.cfg.auditTick() {
		g.Tick()
	}
	before := g.DayProfit()
	money := g.Money
	g.Tick() // тик проверки: штраф списан
	if g.Money >= money+g.IncomePerTick() {
		t.Fatal("штраф аудита не списан на тике проверки")
	}
	if got := g.DayProfit(); got != before {
		t.Errorf("линия скачет в 18:00: %d → %d", before, got)
	}
	for g.TickInDay < g.cfg.DayTicks()-1 {
		g.Tick()
	}
	last := g.DayProfit()
	r := finishDay(t, g)
	if r.Profit != last {
		t.Errorf("линия перед концом дня %d, «Прибыль» отчёта %d", last, r.Profit)
	}
	if g.DayProfit() != r.Profit {
		t.Errorf("в фазе отчёта линия %d, «Прибыль» %d", g.DayProfit(), r.Profit)
	}
}

// Деньги событий — дневной счётчик: переживают сейв, обнуляются новым днём.
func TestDayEventMoneySaveAndReset(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventVirus)
	g.Tick()
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	if g.DayEventMoney != -g.cfg.VirusPrice {
		t.Fatalf("антивирус: DayEventMoney %d", g.DayEventMoney)
	}
	if r := saveRoundtrip(t, g); r.DayEventMoney != g.DayEventMoney {
		t.Errorf("после сейва DayEventMoney %d, хотим %d", r.DayEventMoney, g.DayEventMoney)
	}
	finishDay(t, g)
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.DayEventMoney != 0 {
		t.Errorf("новый день: DayEventMoney %d", g.DayEventMoney)
	}
}
