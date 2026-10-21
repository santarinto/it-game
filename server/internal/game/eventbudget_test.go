package game

import (
	"bytes"
	"encoding/json"
	"slices"
	"testing"
)

// Бюджет случайных событий дня (ITGAME-196): поломки ПК и события пула тратят
// один лимит cfg.EventBudget на день; потрачено = DayIncidents + len(DayEvents).
// План пула занимает место утром, поломка — когда случилась; волна вируса —
// не новое событие и не тратит. 0 — бюджета нет. GDD «Активный день».

// budgetGame — офисы 1..offices открыты, в каждом n сотрудников по $10/тик за
// n ПК; поломка каждый тик (1000‰), ПК не изнашиваются, событий пула нет.
func budgetGame(budget, offices, n int) *Game {
	cfg := DefaultConfig()
	cfg.BreakdownChancePermille = 1000
	cfg.PCWearLimit = 0
	cfg.EventChancePct = 0
	cfg.EventBudget = budget
	g := NewWithSeed(cfg, 5, 6)
	g.Money = 100000
	for oi := 0; oi < offices; oi++ {
		o := &g.Offices[oi]
		o.Unlocked = true
		o.PCs = n
		o.Workplaces = make([]Workplace, n)
		o.Employees = testStaff(n)
		o.Cooler, o.Fridge = true, true
	}
	return g
}

// repairAll — тест чинит все сломанные ПК: следующим тиком офис снова роллит.
func repairAll(g *Game) {
	for oi := range g.Offices {
		for i := range g.Offices[oi].Employees {
			e := &g.Offices[oi].Employees[i]
			e.PCBroken, e.RepairClicks, e.RepairNeeded = false, 0, 0
		}
	}
}

// playDayRepairing — тики до конца дня, после каждого — repairAll.
func playDayRepairing(g *Game) {
	for g.Phase == PhaseRunning {
		g.Tick()
		repairAll(g)
	}
}

func TestEventBudgetByDifficulty(t *testing.T) {
	if b := DefaultConfig().EventBudget; b != 3 {
		t.Errorf("DefaultConfig: бюджет %d, хотим 3 (как normal)", b)
	}
	want := map[Difficulty]int{DiffEasy: 2, DiffNormal: 3, DiffHard: 3, DiffHardcore: 4}
	for d, w := range want {
		if b := ConfigForDifficulty(d).EventBudget; b != w {
			t.Errorf("%s: бюджет %d, хотим %d", d, b, w)
		}
	}
}

// Поломка каждый тик, бюджет N: за день ровно N поломок, назавтра — снова N.
func TestEventBudgetCapsBreakdowns(t *testing.T) {
	for _, budget := range []int{1, 2, 3} {
		g := budgetGame(budget, 1, 4)
		playDayRepairing(g)
		if g.DayIncidents != budget {
			t.Errorf("бюджет %d, день 1: поломок %d, хотим ровно %d", budget, g.DayIncidents, budget)
		}
		if err := g.NextDay(); err != nil {
			t.Fatal(err)
		}
		playDayRepairing(g)
		if g.DayIncidents != budget {
			t.Errorf("бюджет %d, день 2: поломок %d, хотим снова %d", budget, g.DayIncidents, budget)
		}
	}
}

// Бюджет 0 — как до бюджета: поломка каждый тик, план пула до двух событий.
func TestEventBudgetZeroIsUnlimited(t *testing.T) {
	g := budgetGame(0, 1, 4)
	g.cfg.EventChancePct, g.cfg.EventSecondPct = 100, 100
	playDayRepairing(g)
	if want := g.cfg.DayTicks(); g.DayIncidents != want {
		t.Errorf("бюджет 0: поломок за день %d, хотим %d — по одной каждый тик", g.DayIncidents, want)
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if len(g.DayEvents) != 2 {
		t.Errorf("бюджет 0: в плане %d событий, хотим 2", len(g.DayEvents))
	}
}

// Бюджет кончился посреди тика: офисы после него не роллят и PCG не трогают —
// поток тот же, что у игры, где этих офисов нет вовсе.
func TestEventBudgetSkipsRollsWithoutRNG(t *testing.T) {
	capped := budgetGame(2, 3, 1)
	plain := budgetGame(0, 2, 1)
	capped.Tick()
	plain.Tick()
	if capped.DayIncidents != 2 || plain.DayIncidents != 2 {
		t.Fatalf("поломок за тик: с бюджетом %d, без %d; хотим 2 и 2", capped.DayIncidents, plain.DayIncidents)
	}
	if capped.Offices[2].Employees[0].PCBroken {
		t.Error("офис 3 сломался сверх бюджета")
	}
	if !bytes.Equal(capped.RNGState(), plain.RNGState()) {
		t.Error("офис 3 после исчерпания бюджета тронул PCG: пропуск ролла должен быть без вызова RNG")
	}
}

// План пула занимает место в бюджете с утра: при бюджете 3 и двух событиях в
// плане поломка за день одна.
func TestEventBudgetPoolReservesRoom(t *testing.T) {
	g := budgetGame(3, 1, 4)
	g.cfg.EventChancePct, g.cfg.EventSecondPct = 100, 100
	playDayRepairing(g) // день 1 без событий: весь бюджет на поломки
	if g.DayIncidents != 3 {
		t.Fatalf("день 1: поломок %d, хотим 3", g.DayIncidents)
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if len(g.DayEvents) != 2 {
		t.Fatalf("день 2: в плане %d событий, хотим 2", len(g.DayEvents))
	}
	playDayRepairing(g)
	if g.DayIncidents != 1 {
		t.Errorf("день 2: поломок %d, хотим 1 (3 − 2 события плана)", g.DayIncidents)
	}
}

// Бюджет меньше плана: событий не больше остатка, и обрезка без лишних роллов.
// Бюджет 1 при втором событии 100% — тот же план и та же позиция PCG, что без
// бюджета при втором событии 0%: ролл второго состоялся, событие одно.
func TestEventBudgetClipsPlan(t *testing.T) {
	mk := func(budget, second int) *Game {
		g := budgetGame(budget, 1, 4)
		g.cfg.BreakdownChancePermille = 0
		g.cfg.EventChancePct, g.cfg.EventSecondPct = 100, second
		for g.Phase == PhaseRunning {
			g.Tick()
		}
		if err := g.NextDay(); err != nil {
			t.Fatal(err)
		}
		return g
	}
	clipped, one := mk(1, 100), mk(0, 0)
	if len(clipped.DayEvents) != 1 || !slices.Equal(clipped.DayEvents, one.DayEvents) {
		t.Errorf("бюджет 1: план %+v, хотим одно событие как %+v", clipped.DayEvents, one.DayEvents)
	}
	if !bytes.Equal(clipped.RNGState(), one.RNGState()) {
		t.Error("обрезка плана сдвинула PCG: лишний или пропущенный ролл")
	}
	if two := mk(0, 100); len(two.DayEvents) != 2 {
		t.Errorf("бюджет 0: в плане %d событий, хотим 2", len(two.DayEvents))
	}
}

// Бюджет, до которого день не дошёл, поток роллов не трогает: партия с ним
// байт-в-байт (Export без самого бюджета и позиция PCG) равна партии без
// бюджета. Бюджет — максимум потраченного за день без бюджета плюс один.
func TestEventBudgetUnreachedKeepsStream(t *testing.T) {
	const days = 6
	run := func(budget int) (save, rng []byte, maxSpent int) {
		cfg := DefaultConfig()
		cfg.BreakdownChancePermille = 60
		cfg.EventChancePct, cfg.EventSecondPct = 100, 50
		cfg.EventBudget = budget
		g := NewWithSeed(cfg, 21, 22)
		g.Money = 100000
		for oi := 0; oi < 2; oi++ {
			o := &g.Offices[oi]
			o.Unlocked, o.PCs = true, 6
			o.Workplaces = make([]Workplace, 6)
			o.Employees = testStaff(5) // место под звезду есть: в пуле все типы
			o.Cooler, o.Fridge = true, true
		}
		for day := 1; day <= days; day++ {
			for g.Phase == PhaseRunning {
				g.Tick()
				for oi := range g.Offices {
					for i := range g.Offices[oi].Employees {
						if g.Offices[oi].Employees[i].PCBroken {
							_ = g.CallMaster(oi, i)
						}
					}
				}
			}
			maxSpent = max(maxSpent, g.DayIncidents+len(g.DayEvents))
			if day < days {
				if err := g.NextDay(); err != nil {
					t.Fatal(err)
				}
			}
		}
		s := g.Export()
		s.Config.EventBudget = 0
		b, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		return b, g.RNGState(), maxSpent
	}
	free, freeRNG, maxSpent := run(0)
	if maxSpent < 3 {
		t.Fatalf("без бюджета за %d дней потрачено максимум %d в день — тесту нечего проверять", days, maxSpent)
	}
	capped, cappedRNG, _ := run(maxSpent + 1)
	if !bytes.Equal(free, capped) {
		t.Errorf("бюджет %d не достигнут, а партия разошлась с партией без бюджета", maxSpent+1)
	}
	if !bytes.Equal(freeRNG, cappedRNG) {
		t.Errorf("бюджет %d не достигнут, а позиция PCG разошлась", maxSpent+1)
	}
}

// Бюджет и потраченное переживают сейв: конфиг пишется целиком, потрачено —
// из DayIncidents и плана дня, своего счётчика нет.
func TestEventBudgetSurvivesSave(t *testing.T) {
	g := budgetGame(2, 1, 4)
	for g.DayIncidents < 2 {
		g.Tick()
		repairAll(g)
	}
	data, err := json.Marshal(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	var s Save
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	r, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if b := r.Config().EventBudget; b != 2 || r.DayIncidents != 2 {
		t.Fatalf("после Restore: бюджет %d, поломок %d; хотим 2 и 2", b, r.DayIncidents)
	}
	playDayRepairing(r)
	if r.DayIncidents != 2 {
		t.Errorf("после Restore поломок за день %d, хотим 2: бюджет уже выбран", r.DayIncidents)
	}
}

// Волна вируса бюджет не тратит: при бюджете 1 после волны поломка ещё
// случается, следующая — уже нет.
func TestEventBudgetVirusWaveFree(t *testing.T) {
	g := virusGame(4)
	g.cfg.EventBudget = 1
	g.cfg.BreakdownChancePermille = 1000
	// Сломанный ПК места 4 держит кап «одна поломка на офис»: в тик волны
	// офис не роллит, и поломка не встаёт на пути вируса.
	g.Offices[0].Employees[3].PCBroken = true
	g.infect(&g.Offices[0].Employees[0])
	g.VirusWaveIn = 1
	g.Tick()
	if got := infectedSlots(g, 0); len(got) != 2 || g.DayIncidents != 0 {
		t.Fatalf("тик волны: заражены %v, поломок %d; хотим два места и 0", got, g.DayIncidents)
	}
	repairAll(g)
	g.Tick()
	if g.DayIncidents != 1 {
		t.Errorf("тик 2: поломок %d, хотим 1 — волна бюджет не тратит", g.DayIncidents)
	}
	repairAll(g)
	g.Tick()
	if g.DayIncidents != 1 {
		t.Errorf("тик 3: поломок %d, хотим 1 — бюджет выбран", g.DayIncidents)
	}
}

// ПК, доживший до износа, умирает по броску поломки и тратит бюджет дня как
// обычная поломка: счёт идёт до ветки износа в rollBreakdowns (ITGAME-196, 223).
func TestEventBudgetSpentByWearDeath(t *testing.T) {
	g := budgetGame(3, 1, 4)
	g.cfg.PCWearLimit = 2
	g.Offices[0].Workplaces[1].Wear = g.cfg.PCWearLimit
	// Живое место одно — бросок точно попадает в него.
	for _, s := range []int{0, 2, 3} {
		g.Offices[0].Workplaces[s].Dead = true
	}
	left := g.randomBudgetLeft()
	g.Tick()
	if !g.Offices[0].Workplace(1).Dead {
		t.Fatal("ПК на пределе износа не умер после броска поломки")
	}
	if g.Offices[0].Employees[1].PCBroken {
		t.Error("умерший ПК числится сломанным, а не «требуется замена»")
	}
	if g.DayIncidents != 1 {
		t.Errorf("смерть от износа: поломок %d, хотим 1", g.DayIncidents)
	}
	if got := g.randomBudgetLeft(); got != left-1 {
		t.Errorf("остаток бюджета %d, хотим %d: смерть от износа тратит единицу", got, left-1)
	}
}
