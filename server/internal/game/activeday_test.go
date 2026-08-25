package game

import "testing"

// activeDayGame — офис с двумя сотрудниками $10/тик, без устройств и сети.
func activeDayGame() *Game {
	g := New(DefaultConfig())
	g.Money = 10000
	g.Offices[0].PCs = 2
	g.Offices[0].Employees = testStaff(2)
	return g
}

func TestMotivateBuffsIncome(t *testing.T) {
	g := activeDayGame()
	g.TickInDay = 5
	if err := g.Motivate(0, 0); err != nil {
		t.Fatalf("Motivate: %v", err)
	}
	e := &g.Offices[0].Employees[0]
	if e.MotivatedUntil != 5+18 {
		t.Errorf("MotivatedUntil = %d, хотим %d", e.MotivatedUntil, 5+18)
	}
	// 10 × 1.25 = 12.5 → 13; второй сотрудник без баффа = 10.
	if inc := g.IncomePerTick(); inc != 23 {
		t.Errorf("доход с мотивацией = %d, хотим 23", inc)
	}
	eff := g.Effects(&g.Offices[0], e)
	found := false
	for _, ef := range eff {
		if ef.Token == EffectMotivated && ef.Percent == 25 {
			found = true
		}
	}
	if !found {
		t.Errorf("эффект motivated +25 отсутствует: %+v", eff)
	}
}

func TestMotivateCooldownRejects(t *testing.T) {
	g := activeDayGame()
	g.TickInDay = 0
	if err := g.Motivate(0, 0); err != nil {
		t.Fatalf("первая мотивация: %v", err)
	}
	if err := g.Motivate(0, 0); err != ErrMotivateCooldown {
		t.Errorf("повторная мотивация: err = %v, хотим %v", err, ErrMotivateCooldown)
	}
	// Кулдаун 36 тиков: на тике 35 отказ, на 36 — снова можно.
	g.TickInDay = 35
	if err := g.Motivate(0, 0); err != ErrMotivateCooldown {
		t.Errorf("тик 35 (кудлаун до 36): err = %v, хотим %v", err, ErrMotivateCooldown)
	}
	g.TickInDay = 36
	if err := g.Motivate(0, 0); err != nil {
		t.Errorf("тик 36: %v", err)
	}
}

func TestMotivateBuffExpires(t *testing.T) {
	g := activeDayGame()
	g.Offices[0].Cooler = true // жажда не мешает арифметике баффа
	g.TickInDay = 0
	if err := g.Motivate(0, 0); err != nil {
		t.Fatal(err)
	}
	g.TickInDay = 18 // бафф действовал, пока тик < 18
	if inc := g.IncomePerTick(); inc != 20 {
		t.Errorf("после окна баффа доход = %d, хотим 20", inc)
	}
}

func TestMotivateBadSlot(t *testing.T) {
	g := activeDayGame()
	if err := g.Motivate(0, 2); err != ErrBadSlot {
		t.Errorf("слот вне штата: err = %v, хотим %v", err, ErrBadSlot)
	}
	if err := g.Motivate(1, 0); err != ErrOfficeLocked {
		t.Errorf("закрытый офис: err = %v, хотим %v", err, ErrOfficeLocked)
	}
}

func TestBrokenPCZeroIncomeAndStats(t *testing.T) {
	g := activeDayGame()
	g.Offices[0].Employees[0].PCBroken = true
	inc, lost := g.incomeAtTickDetail(0)
	if inc != 10 || lost != 10 {
		t.Errorf("тик: доход %d/потеряно %d, хотим 10/10", inc, lost)
	}
	rep := g.Tick()
	if g.DayLostIncome != 10 {
		t.Errorf("DayLostIncome = %d, хотим 10", g.DayLostIncome)
	}
	_ = rep
	// Дотикиваем до конца дня и проверяем отчёт.
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if g.DayIncidents != 0 {
		t.Errorf("DayIncidents = %d, хотим 0 (поломка поставлена вручную)", g.DayIncidents)
	}
	if g.DayLostIncome == 0 {
		t.Error("DayLostIncome должен быть > 0 за день простоя")
	}
}

func TestRollBreakdownsChanceAndCap(t *testing.T) {
	cfg := DefaultConfig()
	cfg.BreakdownChancePct = 100 // каждый тик — поломка
	g := NewWithSeed(cfg, 3, 4)
	g.Money = 100000
	g.Offices[0].PCs = 4
	g.Offices[0].Employees = testStaff(4)
	g.Tick()
	broken := 0
	for _, e := range g.Offices[0].Employees {
		if e.PCBroken {
			broken++
		}
	}
	if broken != 1 {
		t.Errorf("сломано ПК за тик: %d, хотим ровно 1 (кап на офис)", broken)
	}
	if g.DayIncidents != 1 {
		t.Errorf("DayIncidents = %d, хотим 1", g.DayIncidents)
	}
	// Второй тик: уже есть сломанный — новых нет.
	g.Tick()
	broken = 0
	for _, e := range g.Offices[0].Employees {
		if e.PCBroken {
			broken++
		}
	}
	if broken != 1 || g.DayIncidents != 1 {
		t.Errorf("кап не работает: сломано %d, инцидентов %d", broken, g.DayIncidents)
	}
}

func TestRollBreakdownsNeedsStaff(t *testing.T) {
	cfg := DefaultConfig()
	cfg.BreakdownChancePct = 100
	g := NewWithSeed(cfg, 3, 4)
	g.Offices[0].PCs = 3 // ПК есть, сотрудников нет — ломать нечего
	g.Tick()
	if g.DayIncidents != 0 {
		t.Errorf("DayIncidents = %d, хотим 0 без сотрудников", g.DayIncidents)
	}
}

func TestRepairByClicks(t *testing.T) {
	g := activeDayGame()
	e := &g.Offices[0].Employees[0]
	e.PCBroken = true
	if err := g.RepairClick(0, 1); err != ErrNotBroken {
		t.Errorf("целый ПК: err = %v, хотим %v", err, ErrNotBroken)
	}
	for i := 1; i <= 2; i++ {
		if err := g.RepairClick(0, 0); err != nil {
			t.Fatalf("клик %d: %v", i, err)
		}
		if e.PCBroken != true {
			t.Fatalf("клик %d починил раньше времени", i)
		}
	}
	if err := g.RepairClick(0, 0); err != nil {
		t.Fatal(err)
	}
	if e.PCBroken || e.RepairClicks != 0 {
		t.Errorf("после 3 кликов: PCBroken=%v RepairClicks=%d, хотим false/0", e.PCBroken, e.RepairClicks)
	}
	if inc := g.IncomePerTick(); inc != 20 {
		t.Errorf("доход после починки = %d, хотим 20", inc)
	}
}

func TestCallMaster(t *testing.T) {
	g := activeDayGame()
	g.Offices[0].Employees[0].PCBroken = true
	g.Money = 100
	if err := g.CallMaster(0, 0); err != ErrNotEnoughMoney {
		t.Errorf("без денег: err = %v, хотим %v", err, ErrNotEnoughMoney)
	}
	g.Money = 1000
	if err := g.CallMaster(0, 1); err != ErrNotBroken {
		t.Errorf("целый ПК: err = %v, хотим %v", err, ErrNotBroken)
	}
	if err := g.CallMaster(0, 0); err != nil {
		t.Fatal(err)
	}
	if g.Money != 1000-150 {
		t.Errorf("Money = %d, хотим %d", g.Money, 1000-150)
	}
	if g.Offices[0].Employees[0].PCBroken {
		t.Error("мастер не починил")
	}
}

func TestActiveDayResetOnNextDay(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 1000
	g.Offices[0].Employees = testStaff(1)
	g.Offices[0].Employees[0].PCBroken = true
	g.Offices[0].Employees[0].MotivatedUntil = 99
	g.Offices[0].Employees[0].MotivateCooldownUntil = 99
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	e := g.Offices[0].Employees[0]
	if e.PCBroken || e.MotivatedUntil != 0 || e.MotivateCooldownUntil != 0 || g.DayIncidents != 0 || g.DayLostIncome != 0 {
		t.Errorf("ресет дня не прошёл: %+v DayIncidents=%d DayLostIncome=%d",
			e, g.DayIncidents, g.DayLostIncome)
	}
}

func TestForecastAccountsBrokenPC(t *testing.T) {
	g := activeDayGame()
	g.Offices[0].Employees[0].PCBroken = true
	fc := g.ForecastEndOfDay()
	g.Offices[0].Employees[0].PCBroken = false
	if fc2 := g.ForecastEndOfDay(); fc2 <= fc {
		t.Errorf("прогноз с поломкой (%d) должен быть меньше починенного (%d)", fc, fc2)
	}
}
