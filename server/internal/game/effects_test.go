package game

import "testing"

// amenityGame — открытый офис с одним сотрудником $10/тик, без устройств.
func amenityGame() *Game {
	g := New(DefaultConfig())
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = testStaff(1)
	return g
}

func TestThirstDebuffBoundary(t *testing.T) {
	g := amenityGame()
	g.TickInDay = 11 // 11:50 — жажды ещё нет
	if inc := g.IncomePerTick(); inc != 10 {
		t.Errorf("тик 11: доход %d, хотим 10", inc)
	}
	g.TickInDay = 12 // 12:00 — жажда −10%
	if inc := g.IncomePerTick(); inc != 9 {
		t.Errorf("тик 12: доход %d, хотим 9", inc)
	}
	g.Offices[0].Cooler = true
	if inc := g.IncomePerTick(); inc != 10 {
		t.Errorf("с кулером жажды нет: доход %d, хотим 10", inc)
	}
}

func TestHungerAndStack(t *testing.T) {
	g := amenityGame()
	g.TickInDay = 29 // 14:50 — обед, доход 0, но проверяем границу голода через эффекты
	if inc := g.IncomePerTick(); inc != 0 {
		t.Errorf("в обед доход %d, хотим 0", inc)
	}
	g.TickInDay = 30                        // 15:00 — жажда + голод = ×0.81
	if inc := g.IncomePerTick(); inc != 8 { // round(10×0.81) = 8
		t.Errorf("тик 30: доход %d, хотим 8 (стак ×0.81)", inc)
	}
	g.Offices[0].Cooler = true
	g.Offices[0].Fridge = true
	if inc := g.IncomePerTick(); inc != 10 {
		t.Errorf("с устройствами дебаффов нет: %d", inc)
	}
}

func TestAmenityPerOffice(t *testing.T) {
	g := amenityGame()
	g.Offices[1] = Office{Unlocked: true, PCs: 1, Employees: testStaff(1), Cooler: true, Fridge: true}
	g.TickInDay = 30
	// офис 0 без устройств: 8; офис 1 с устройствами: 10.
	if inc := g.IncomePerTick(); inc != 18 {
		t.Errorf("доход %d, хотим 18 (8+10)", inc)
	}
}

func TestCoffeeEventsRolledAndApplied(t *testing.T) {
	g := NewWithSeed(DefaultConfig(), 7, 7)
	g.Money = 100000
	g.Offices[0].PCs = 9
	g.Offices[0].Employees = testStaff(9)
	g.Offices[0].CoffeeMachine = true
	// Проматываем день до отчёта и запускаем следующий — ролл в NextDay.
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	ticks := g.Offices[0].CoffeeEventTicks
	if len(ticks) != 2 {
		t.Fatalf("кофе-событий %d, хотим 2", len(ticks))
	}
	if ticks[0] < 0 || ticks[0] > 23 {
		t.Errorf("первое событие на тике %d, хотим [0..23]", ticks[0])
	}
	if ticks[1] < 30 || ticks[1] > 53 {
		t.Errorf("второе событие на тике %d, хотим [30..53]", ticks[1])
	}
	// Доигрываем до первого события и проверяем, что кто-то получил бафф.
	for g.TickInDay <= ticks[0] {
		g.Tick()
	}
	buffed := 0
	for _, e := range g.Offices[0].Employees {
		if e.CoffeeUntil > 0 {
			buffed++
			if e.CoffeeUntil != ticks[0]+DefaultConfig().CoffeeTicks {
				t.Errorf("CoffeeUntil = %d, хотим %d", e.CoffeeUntil, ticks[0]+6)
			}
		}
	}
	if buffed == 0 || buffed == 9 {
		t.Errorf("баффнуто %d из 9 — ожидаем частичное покрытие (шанс 40%%)", buffed)
	}
}

func TestCoffeeResetOnNextDay(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 100000
	g.Offices[0].Employees = testStaff(1)
	g.Offices[0].Employees[0].CoffeeUntil = 99
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].Employees[0].CoffeeUntil != 0 {
		t.Errorf("кофе не сброшен на next_day: %d", g.Offices[0].Employees[0].CoffeeUntil)
	}
}

func TestEffectsList(t *testing.T) {
	g := amenityGame()
	g.TickInDay = 30
	g.Offices[0].Employees[0].CoffeeUntil = 34
	eff := g.Effects(&g.Offices[0], &g.Offices[0].Employees[0])
	if len(eff) != 3 {
		t.Fatalf("эффектов %d, хотим 3 (жажда+голод+кофе): %+v", len(eff), eff)
	}
	tokens := map[string]int{}
	for _, e := range eff {
		tokens[e.Token] = e.Percent
	}
	if tokens["thirst"] != -10 || tokens["hunger"] != -10 || tokens["coffee"] != 15 {
		t.Errorf("проценты эффектов: %+v", tokens)
	}
}
