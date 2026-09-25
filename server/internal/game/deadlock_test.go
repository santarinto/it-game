package game

import (
	"testing"
)

// Детектор софт-лока (ITGAME-20):
// Если штат пуст (источников дохода нет) и денег не хватает
// на минимальное действие для получения дохода — наступает game_over (deadlock).
// Кредитный лимит в игре не даёт покупательной способности (команды требуют Money >= price),
// а защищает лишь от банкротства при вечернем списании ФОТ (settleDebt).
// Поэтому тупик определяется строго по g.Money < g.MinCostToEarn().

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
		t.Fatalf("ожидали IsDeadlocked() == true при money=$60, minCost=$240")
	}

	// Посреди дня симуляция не убивает игрока мгновенно
	_ = g.Tick()
	if g.Phase == PhaseGameOver {
		t.Fatalf("посреди дня тик не должен мгновенно объявлять game_over")
	}

	// Прокручиваем день до конца (closeDay)
	for g.Phase == PhaseRunning {
		g.Tick()
	}

	if g.Phase != PhaseGameOver {
		t.Fatalf("ожидали PhaseGameOver в конце дня, получили %s", g.Phase)
	}
	if g.LoseReason != LoseDeadlock {
		t.Fatalf("ожидали LoseReason == %q, получили %q", LoseDeadlock, g.LoseReason)
	}
}

func TestDeadlockHardWithCredit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.CreditLimit = 5000 // Hard: кредитный лимит 5000
	cfg.HirePrice = 240
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 60
	// Кредит не позволяет нанимать (команда Hire требует g.Money >= price),
	// поэтому игрок с $60 при цене найма $240 находится в тупике.
	if !g.IsDeadlocked() {
		t.Fatalf("ожидали тупик: кредит не даёт права нанимать в минус, Money=$60 < MinCost=$240")
	}

	for g.Phase == PhaseRunning {
		g.Tick()
	}

	if g.Phase != PhaseGameOver || g.LoseReason != LoseDeadlock {
		t.Fatalf("ожидали game_over/deadlock в конце дня на Hard, получили фазу %s причину %q", g.Phase, g.LoseReason)
	}
}

func TestDeadlockCounterexampleHasMoney(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HirePrice = 240
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 500
	if g.IsDeadlocked() {
		t.Fatalf("при деньгах $500 >= $240 тупика быть не должно")
	}

	for g.Phase == PhaseRunning {
		g.Tick()
	}

	if g.Phase == PhaseGameOver {
		t.Fatalf("игра не должна завершаться поражением, если есть деньги на развитие")
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

func TestNotDeadlockedNegativeMoney(t *testing.T) {
	cfg := DefaultConfig()
	cfg.CreditLimit = 5000
	g := NewWithSeed(cfg, 1, 2)
	g.Money = -50
	// Отрицательный баланс тупиком не является — регулируется settleDebt / банкротством
	if g.IsDeadlocked() {
		t.Fatalf("при отрицательном балансе IsDeadlocked должен возвращать false")
	}
}

func TestMinCostToEarnVariations(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HirePrice = 300
	cfg.PCPrice = 500
	cfg.OfficeSlots = 4
	cfg.OfficePrices = []int{2000, 5000}

	g := NewWithSeed(cfg, 1, 2)
	// Офис 0 имеет 1 ПК, 0 сотрудников -> свободный ПК есть, цена заработка = HirePrice (300)
	if cost := g.MinCostToEarn(); cost != 300 {
		t.Fatalf("ожидали MinCostToEarn = 300 (только найм), получили %d", cost)
	}

	// Занимаем свободный ПК
	g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{IncomePerTick: 10})
	// Теперь ПК занят, слотов 4. Для нового дохода нужен ПК + найм = 500 + 300 = 800
	g.Offices[0].Employees = nil // очищаем штат
	g.Offices[0].PCs = 0         // убираем ПК
	if cost := g.MinCostToEarn(); cost != 800 {
		t.Fatalf("ожидали MinCostToEarn = 800 (ПК + найм), получили %d", cost)
	}

	// Заполняем офис 0 до лимита (и ПК, и сотрудники)
	g.Offices[0].PCs = cfg.OfficeSlots
	for i := 0; i < cfg.OfficeSlots; i++ {
		g.Offices[0].Employees = append(g.Offices[0].Employees, Employee{IncomePerTick: 10})
	}
	// Теперь офис 0 полон, для дохода нужен новый офис + ПК + найм = 2000 + 500 + 300 = 2800
	if cost := g.MinCostToEarn(); cost != 2800 {
		t.Fatalf("ожидали MinCostToEarn = 2800 (офис 1 + ПК + найм), получили %d", cost)
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
