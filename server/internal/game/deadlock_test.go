package game

import (
	"testing"
)

// Детектор софт-лока (ITGAME-20):
// Если штат пуст (источников дохода нет) и доступных средств (с учётом кредита)
// не хватает на минимальное действие для получения дохода — наступает game_over (deadlock).

func TestDeadlockTriggerNormal(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HirePrice = 240
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 60
	// 0 сотрудников, 1 ПК в офисе 0. Мин. стоимость заработка — найм ($240).
	if g.TotalEmployees() != 0 {
		t.Fatalf("штат не пуст: %d", g.TotalEmployees())
	}
	if !g.IsDeadlocked() {
		t.Fatalf("ожидали IsDeadlocked() == true при money=$60, minCost=$240, limit=$0")
	}

	// Тик симуляции должен перевести в game_over с LoseDeadlock
	report := g.Tick()
	if report != nil {
		t.Errorf("ожидали nil report при тупике, получили %+v", report)
	}
	if g.Phase != PhaseGameOver {
		t.Fatalf("ожидали PhaseGameOver, получили %s", g.Phase)
	}
	if g.LoseReason != LoseDeadlock {
		t.Fatalf("ожидали LoseReason == %q, получили %q", LoseDeadlock, g.LoseReason)
	}
}

func TestDeadlockCounterexampleHardWithCredit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.CreditLimit = 5000 // Hard: доступен кредитный лимит
	cfg.HirePrice = 240
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 60
	// Доступные средства = 60 + 5000 = 5060 >= 240 -> тупика нет
	if g.IsDeadlocked() {
		t.Fatalf("при доступном кредите тупика быть не должно (AvailableFunds=%d, MinCost=%d)",
			g.AvailableFunds(), g.MinCostToEarn())
	}
	// Тик не переводит в game_over
	_ = g.Tick()
	if g.Phase == PhaseGameOver {
		t.Fatalf("игра не должна завершаться поражением при доступном кредите")
	}
}

func TestDeadlockHardSmallCredit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.CreditLimit = 100
	cfg.HirePrice = 240
	g := NewWithSeed(cfg, 1, 2)
	// Деньги $50 + лимит $100 = $150 < $240 (цена найма)
	g.Money = 50
	if !g.IsDeadlocked() {
		t.Fatalf("ожидали тупик: деньги+кредит ($150) меньше цены найма ($240)")
	}
	g.Tick()
	if g.Phase != PhaseGameOver || g.LoseReason != LoseDeadlock {
		t.Fatalf("ожидали game_over/deadlock, получили фазу %s причину %q", g.Phase, g.LoseReason)
	}
}

func TestNotDeadlockedWithStaff(t *testing.T) {
	cfg := DefaultConfig()
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 0
	// 1 сотрудник
	g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{IncomePerTick: 10, HireDay: 1})
	if g.IsDeadlocked() {
		t.Fatalf("при наличии сотрудников тупика быть не должно")
	}
}

func TestDeadlockOffline(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HirePrice = 300
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 50
	summary := g.AdvanceOffline(100)
	if !summary.GameOver || summary.Reason != LoseDeadlock {
		t.Fatalf("ожидали офлайн GameOver с причиной deadlock, получили gameOver=%v, reason=%q",
			summary.GameOver, summary.Reason)
	}
}
