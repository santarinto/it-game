package game

import "testing"

// tickCfg — быстрый конфиг: победа достижима за несколько тиков.
func victoryCfg(target int) Config {
	c := DefaultConfig()
	c.WinTarget = target
	return c
}

func TestVictoryOnReachingTarget(t *testing.T) {
	g := NewWithSeed(victoryCfg(700), 1, 2) // старт $600, цель $700
	if err := g.Hire(0); err != nil {       // −$300: баланс $300, доход пошёл
		t.Fatal(err)
	}
	for i := 0; i < 100 && g.Phase == PhaseRunning; i++ {
		g.Tick()
	}
	if g.Phase != PhaseWon {
		t.Fatalf("ждали won, фаза %s (баланс %d)", g.Phase, g.Money)
	}
	if g.Money < 700 {
		t.Fatalf("победа при балансе %d < цели 700", g.Money)
	}
}

func TestNoVictoryBelowTarget(t *testing.T) {
	g := NewWithSeed(victoryCfg(1_000_000), 1, 2)
	g.Tick()
	if g.Phase != PhaseRunning {
		t.Fatalf("рано: фаза %s при балансе %d", g.Phase, g.Money)
	}
}

// После победы тик — no-op, а команды покупок отвергаются wrong_phase.
func TestWonPhaseFreezesGame(t *testing.T) {
	g := NewWithSeed(victoryCfg(500), 1, 2) // старт $600 ≥ цели: победа первым тиком
	g.Tick()
	if g.Phase != PhaseWon {
		t.Fatalf("ждали won, фаза %s", g.Phase)
	}
	money, day := g.Money, g.Day
	if r := g.Tick(); r != nil || g.Money != money || g.Day != day {
		t.Error("тик после победы должен быть no-op")
	}
	if err := g.Apply(CmdBuyPC, 0, 0); err != ErrWrongPhase {
		t.Errorf("покупка после победы: ждали wrong_phase, got %v", err)
	}
}
