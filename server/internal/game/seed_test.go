package game

import "testing"

// Сид (ITGAME-26): одинаковый сид + одинаковые действия = одинаковые
// роллы; сид виден в игре и переживает сейв/загрузку.

func TestSeedDeterministicHire(t *testing.T) {
	cfg := DefaultConfig()
	run := func() (names []string, incomes []int) {
		g := NewSeeded(cfg, 20260909)
		if err := g.Hire(0); err != nil {
			t.Fatalf("hire: %v", err)
		}
		for _, e := range g.Offices[0].Employees {
			names = append(names, e.Name)
			incomes = append(incomes, e.IncomePerTick)
		}
		return
	}
	n1, i1 := run()
	n2, i2 := run()
	for i := range n1 {
		if n1[i] != n2[i] || i1[i] != i2[i] {
			t.Fatalf("роллы найма разошлись: %v/%v vs %v/%v", n1, i1, n2, i2)
		}
	}
}

func TestSeedDifferentSeedsDiffer(t *testing.T) {
	cfg := DefaultConfig()
	a, b := NewSeeded(cfg, 1), NewSeeded(cfg, 2)
	if a.SeedString() == b.SeedString() {
		t.Fatal("сид должен отличаться")
	}
	same := true
	for i := range 8 { // завтрашний рынок + имена при найме
		_ = i
		if a.rollMarket() != b.rollMarket() {
			same = false
			break
		}
	}
	if same {
		t.Log("предупреждение: разные сиды дали одинаковые роллы рынка (маловероятно, но возможно)")
	}
}

func TestSeedSurvivesSaveLoad(t *testing.T) {
	cfg := DefaultConfig()
	g := NewSeeded(cfg, 777)
	if err := g.Hire(0); err != nil {
		t.Fatalf("hire: %v", err)
	}
	loaded, err := Restore(g.Export())
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if loaded.Seed != 777 {
		t.Fatalf("сид не пережил сейв: %d", loaded.Seed)
	}
	// Ресив по сиду: следующий ролл после load равен первому роллу fresh-игры
	// с тем же сидом — последовательность воспроизводится с начала.
	fresh := NewSeeded(cfg, 777)
	if loaded.rng.IntN(1<<30) != fresh.rng.IntN(1<<30) {
		t.Fatal("после load роллы должны воспроизводиться с того же сида")
	}
}

func TestParseSeed(t *testing.T) {
	if _, ok := ParseSeed(""); ok {
		t.Fatal("пустой сид — не задан")
	}
	if s, ok := ParseSeed("1234"); !ok || s != 1234 {
		t.Fatalf("1234: %d %v", s, ok)
	}
	if _, ok := ParseSeed("abc"); ok {
		t.Fatal("мусор — не задан")
	}
	if _, ok := ParseSeed("-1"); ok {
		t.Fatal("отрицательный — не задан")
	}
}

func TestFixturesAllValid(t *testing.T) {
	names := FixtureNames()
	want := map[string]bool{
		"fresh": false, "broke_day3": false, "mid_day10": false,
		"full_office": false, "soft_lock": false, "pre_victory": false,
	}
	if len(names) != len(want) {
		t.Fatalf("фикстур %d, ожидалось %d: %v", len(names), len(want), names)
	}
	for _, n := range names {
		if _, ok := want[n]; !ok {
			t.Fatalf("неожиданная фикстура %q", n)
		}
		want[n] = true
		g, err := NewFixture(DefaultConfig(), n, "42")
		if err != nil {
			t.Fatalf("фикстура %s: %v", n, err)
		}
		if g.Seed != 42 {
			t.Fatalf("фикстура %s: сид %d, ожидался заданный 42", n, g.Seed)
		}
		// фикстура обязана переживать сейв/рестор: это же состояние
		// уйдёт в store при первом persist
		if _, err := Restore(g.Export()); err != nil {
			t.Fatalf("фикстура %s не переживает сейв: %v", n, err)
		}
	}
	for n, seen := range want {
		if !seen {
			t.Fatalf("фикстура %s не найдена", n)
		}
	}
}

func TestFixtureScenarioStates(t *testing.T) {
	cfg := DefaultConfig()

	g, err := NewFixture(cfg, "soft_lock", "")
	if err != nil {
		t.Fatal(err)
	}
	if g.Money != 100 || g.Day != 40 || len(g.Offices[0].Employees) != 0 {
		t.Fatalf("soft_lock: money=%d day=%d staff=%d", g.Money, g.Day, len(g.Offices[0].Employees))
	}
	// тупик: найм невозможен (не хватает $300), расходов нет — день закрывается без изменений
	if err := g.Hire(0); err != ErrNotEnoughMoney {
		t.Fatalf("soft_lock: найм должен быть невозможен, получили %v", err)
	}

	g, err = NewFixture(cfg, "pre_victory", "")
	if err != nil {
		t.Fatal(err)
	}
	// 4 продуктивных тика до победы
	for i := 0; i < 10 && g.Phase == PhaseRunning; i++ {
		g.Tick()
	}
	if g.Phase != PhaseWon {
		t.Fatalf("pre_victory: фаза %s, ожидалась won", g.Phase)
	}

	g, err = NewFixture(cfg, "broke_day3", "")
	if err != nil {
		t.Fatal(err)
	}
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if g.Phase != PhaseGameOver || g.LoseReason != LoseBankrupt {
		t.Fatalf("broke_day3: фаза %s (%s), ожидалось банкротство", g.Phase, g.LoseReason)
	}

	g, err = NewFixture(cfg, "full_office", "")
	if err != nil {
		t.Fatal(err)
	}
	o := g.Offices[0]
	if len(o.Employees) != 12 || o.PCs != 12 || g.CoreLevel != 5 || !g.Gateway {
		t.Fatalf("full_office: staff=%d pcs=%d core=%d gw=%v", len(o.Employees), o.PCs, g.CoreLevel, g.Gateway)
	}
	if g.Phase != PhaseRunning || g.TickInDay != 20 {
		t.Fatalf("full_office: phase=%s tick=%d", g.Phase, g.TickInDay)
	}

	g, err = NewFixture(cfg, "mid_day10", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Offices[0].Employees) != 5 || g.Offices[0].Boss == "" {
		t.Fatal("mid_day10: штат/начальник не на месте")
	}
}

func TestNewFixtureUnknown(t *testing.T) {
	if _, err := NewFixture(DefaultConfig(), "nope", ""); err == nil {
		t.Fatal("неизвестный сценарий должен давать ошибку")
	}
}
