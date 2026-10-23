package main

import (
	"math/rand/v2"
	"testing"

	"itdirector/internal/game"
)

func TestEventStatsLine(t *testing.T) {
	plan := func(ids ...game.EventID) map[game.EventID]int {
		m := map[game.EventID]int{}
		for _, id := range ids {
			m[id]++
		}
		return m
	}
	tests := []struct {
		name string
		recs []dayRecord
		want string
	}{
		{"пусто", nil,
			"sim events: diff=normal policy=greedy seeds=2 days=3 played=0 breakdowns=0.000 outbreaks=0.000 infected=0.000 pool=0.000 virus=0.000 deadline=0.000 audit=0.000 raise=0.000 star=0.000 leave=0.000 second=0.0% total=0.000 max=0 ge3=0.0% capped=0.0%"},
		// Бюджет 3: в упор дошли дни 1 (2+2) и 4 (1+2), день 3 (1+1) — нет.
		{"четыре дня", []dayRecord{
			{Breakdowns: 2, Infected: 1, Outbreaks: 1, Plan: plan(game.EventVirus, game.EventRaise), Budget: 3},
			{Breakdowns: 0, Plan: plan(), Budget: 3},
			{Breakdowns: 1, Plan: plan(game.EventDeadline), Budget: 3},
			{Breakdowns: 1, Infected: 3, Plan: plan(game.EventAudit, game.EventStar), Budget: 3},
		},
			"sim events: diff=normal policy=greedy seeds=2 days=3 played=4 breakdowns=1.000 outbreaks=0.250 infected=1.000 pool=1.250 virus=0.250 deadline=0.250 audit=0.250 raise=0.250 star=0.250 leave=0.000 second=50.0% total=2.250 max=4 ge3=50.0% capped=50.0%"},
		// Бюджет 0 — бюджета нет: упираться не во что, capped 0 при любом total.
		{"без бюджета", []dayRecord{
			{Breakdowns: 5, Plan: plan(game.EventVirus)},
			{Breakdowns: 0, Plan: plan()},
		},
			"sim events: diff=normal policy=greedy seeds=2 days=3 played=2 breakdowns=2.500 outbreaks=0.000 infected=0.000 pool=0.500 virus=0.500 deadline=0.000 audit=0.000 raise=0.000 star=0.000 leave=0.000 second=0.0% total=3.000 max=6 ge3=50.0% capped=0.0%"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := eventStatsLine("normal", "greedy", 2, 3, tc.recs); got != tc.want {
				t.Errorf("got  %s\nwant %s", got, tc.want)
			}
		})
	}
}

// raiseGame — игра с двумя сотрудниками и карточкой «Просит повышения» (2%) на
// первом, поднятой тиком: так карточку создаёт сама игра.
func raiseGame(t *testing.T) *game.Game {
	t.Helper()
	cfg := game.DefaultConfig()
	cfg.EventChancePct = 0
	cfg.BreakdownChancePermille = 0
	g := game.NewWithSeed(cfg, 11, 22)
	g.Money = 10000
	g.Offices[0].PCs = 4
	for i := 0; i < 2; i++ {
		if err := g.Hire(0); err != nil {
			t.Fatal(err)
		}
	}
	g.DayEvents = []game.DayEvent{{ID: game.EventRaise, Office: 0, Slot: 0, RaisePct: 2}}
	g.Tick()
	if g.ActiveEvent == nil || g.ActiveEvent.ID != game.EventRaise {
		t.Fatalf("карточка повышения не поднялась: %+v", g.ActiveEvent)
	}
	return g
}

func TestAnswerRaise(t *testing.T) {
	t.Run("accept", func(t *testing.T) {
		g := raiseGame(t)
		e := &g.Offices[0].Employees[0]
		wantAdd := max(1, int(float64(g.Config().SalaryPerDay)*0.02+0.5))
		answerRaise(g, "accept")
		if g.ActiveEvent != nil {
			t.Error("карточка осталась после согласия")
		}
		if e.RaisePct != 2 || e.SalaryAdd != wantAdd {
			t.Errorf("согласие: RaisePct=%d SalaryAdd=%d, хотим 2 и %d", e.RaisePct, e.SalaryAdd, wantAdd)
		}
		if e.OffendedUntil != 0 {
			t.Errorf("согласие не должно обижать: OffendedUntil=%d", e.OffendedUntil)
		}
	})
	t.Run("decline", func(t *testing.T) {
		g := raiseGame(t)
		e := &g.Offices[0].Employees[0]
		answerRaise(g, "decline")
		if g.ActiveEvent != nil {
			t.Error("карточка осталась после отказа")
		}
		if e.RaisePct != 0 || e.SalaryAdd != 0 {
			t.Errorf("отказ: RaisePct=%d SalaryAdd=%d, повышения быть не должно", e.RaisePct, e.SalaryAdd)
		}
		if want := g.Config().DayTicks(); e.OffendedUntil != want {
			t.Errorf("отказ: OffendedUntil=%d, хотим %d (обида до конца дня)", e.OffendedUntil, want)
		}
	})
	t.Run("пусто", func(t *testing.T) {
		g := raiseGame(t)
		e := g.Offices[0].Employees[0]
		answerRaise(g, "")
		if g.ActiveEvent == nil || g.ActiveEvent.ID != game.EventRaise {
			t.Error("пустой режим закрыл карточку")
		}
		if got := g.Offices[0].Employees[0]; got != e {
			t.Errorf("пустой режим тронул сотрудника: %+v -> %+v", e, got)
		}
	})
	t.Run("нет карточки", func(t *testing.T) {
		g := raiseGame(t)
		answerRaise(g, "accept")
		answerRaise(g, "accept") // карточки уже нет: повторный вызов безвреден
		if e := g.Offices[0].Employees[0]; e.RaisePct != 2 {
			t.Errorf("повторный ответ без карточки изменил RaisePct: %d", e.RaisePct)
		}
	})
}

// expandGame — офис 1 с n сотрудниками, офисы 2 и 3 закрыты, денег money.
func expandGame(t *testing.T, n, money int) *game.Game {
	t.Helper()
	cfg := game.DefaultConfig()
	cfg.EventChancePct = 0
	cfg.BreakdownChancePermille = 0
	g := game.NewWithSeed(cfg, 3, 4)
	g.Money = 1000000
	g.Offices[0].PCs = cfg.StaffLimit
	for i := 0; i < n; i++ {
		if err := g.Hire(0); err != nil {
			t.Fatal(err)
		}
	}
	g.Money = money
	return g
}

func TestExpandPolicy(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	t.Run("штат полон и денег хватает", func(t *testing.T) {
		g := expandGame(t, game.DefaultConfig().StaffLimit, 100000)
		expandPolicy(g, rng, 9)
		if !g.Offices[1].Unlocked {
			t.Error("все открытые офисы полны, денег хватает, а второй офис не куплен")
		}
		if g.Offices[2].Unlocked {
			t.Error("за один вызов куплен и третий офис")
		}
	})
	t.Run("в офисе есть свободное место", func(t *testing.T) {
		g := expandGame(t, game.DefaultConfig().StaffLimit-1, 100000)
		expandPolicy(g, rng, 9)
		if g.Offices[1].Unlocked {
			t.Error("офис куплен, хотя в первом не добран штат")
		}
	})
	t.Run("денег не хватает", func(t *testing.T) {
		cfg := game.DefaultConfig()
		g := expandGame(t, cfg.StaffLimit, 0)
		g.Money = cfg.OfficePrices[0] // цена есть, резерва под зарплаты нет
		expandPolicy(g, rng, 9)
		if g.Offices[1].Unlocked {
			t.Error("офис куплен без резерва на вечерние зарплаты")
		}
	})
}

// leaveGame — день 2, карточка «Просит уйти пораньше» на сотрудника 0
// активна с тика tick (ITGAME-198).
func leaveGame(t *testing.T, tick int) *game.Game {
	t.Helper()
	g := raiseGame(t)
	g.ActiveEvent.Resolved = true
	g.ActiveEvent = nil
	for g.TickInDay < tick {
		g.Tick()
	}
	g.DayEvents = append(g.DayEvents, game.DayEvent{ID: game.EventLeave, Tick: tick, Office: 0, Slot: 0})
	g.Tick()
	if g.ActiveEvent == nil || g.ActiveEvent.ID != game.EventLeave {
		t.Fatalf("карточка «уйти пораньше» не поднялась: %+v", g.ActiveEvent)
	}
	return g
}

func TestAnswerLeave(t *testing.T) {
	cfg := game.DefaultConfig()
	at := func(hour int) int { return (hour - cfg.WorkdayStart) * cfg.TicksPerHour }
	for _, tc := range []struct {
		mode    string
		tick    int
		away    bool
		pending bool
	}{
		{"release", at(12), true, false},
		{"keep", at(17), false, false},
		{"by-hour", at(12), false, false},
		{"by-hour", at(leaveFromHour), true, false},
		{"", at(12), false, true},
	} {
		g := leaveGame(t, tc.tick)
		answerLeave(g, tc.mode)
		e := g.Offices[0].Employees[0]
		if got := e.AwayFrom > 0; got != tc.away {
			t.Errorf("%q в %s: отпущен=%v, хотим %v", tc.mode, g.Clock(), got, tc.away)
		}
		if got := g.ActiveEvent != nil; got != tc.pending {
			t.Errorf("%q: карточка висит=%v, хотим %v", tc.mode, got, tc.pending)
		}
	}
}
