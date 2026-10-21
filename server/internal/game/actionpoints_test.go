package game

import (
	"errors"
	"testing"
)

// Очки действий директора (ITGAME-127): ActionPointsPerDay (8) на день, утром
// снова полные, остаток не копится. Начать ремонт или чистку места — 1 очко,
// дальше клики бесплатны; начатое (игроком, админом или вчера) — бесплатно.
// Мотивация, мастер, замена ПК и админы очков не стоят.

// pointsGame — день 1, тик 0: место 0 сломано (N=5), место 1 заражено,
// место 2 целое; поломок и событий нет, денег с запасом.
func pointsGame(t *testing.T) *Game {
	t.Helper()
	cfg := DefaultConfig()
	cfg.BreakdownChancePermille = 0
	cfg.EventChancePct = 0
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 100000
	o := &g.Offices[0]
	o.PCs = 3
	o.syncWorkplaces()
	o.Employees = testStaff(3)
	o.Employees[0].PCBroken = true
	o.Employees[0].RepairNeeded = 5
	o.Employees[1].Infected = true
	return g
}

func TestActionPointsPoolIsEightOnEveryDifficulty(t *testing.T) {
	for _, d := range []Difficulty{DiffEasy, DiffNormal, DiffHard, DiffHardcore} {
		cfg := ConfigForDifficulty(d)
		if cfg.ActionPointsPerDay != 8 {
			t.Errorf("%s: ActionPointsPerDay = %d, хотим 8", d, cfg.ActionPointsPerDay)
		}
		if g := NewWithSeed(cfg, 1, 2); g.ActionPoints != 8 {
			t.Errorf("%s: новая партия с %d очками, хотим 8", d, g.ActionPoints)
		}
	}
}

func TestRepairStartCostsOnePointClicksFree(t *testing.T) {
	g := pointsGame(t)
	e := &g.Offices[0].Employees[0]
	for i := 0; i < 5; i++ {
		if err := g.RepairClick(0, 0); err != nil {
			t.Fatalf("клик %d: %v", i+1, err)
		}
		if g.ActionPoints != 7 {
			t.Fatalf("после клика %d очков %d, хотим 7: платит только первый", i+1, g.ActionPoints)
		}
	}
	if e.PCBroken {
		t.Fatal("5 кликов из 5 — ПК должен быть цел")
	}
}

func TestRepairStartedIsFree(t *testing.T) {
	g := pointsGame(t)
	g.Offices[0].Employees[0].RepairClicks = 2 // начал админ или игрок вчера
	if err := g.RepairClick(0, 0); err != nil {
		t.Fatal(err)
	}
	if g.ActionPoints != 8 {
		t.Fatalf("начатый ремонт взял очко: осталось %d", g.ActionPoints)
	}
}

func TestRepairWithoutPointsRefused(t *testing.T) {
	g := pointsGame(t)
	g.ActionPoints = 0
	e := &g.Offices[0].Employees[0]
	if err := g.RepairClick(0, 0); !errors.Is(err, ErrNoActionPoints) {
		t.Fatalf("без очков: ошибка %v, хотим no_action_points", err)
	}
	if e.RepairClicks != 0 || !e.PCBroken || g.ActionPoints != 0 {
		t.Fatalf("отказ изменил место: clicks=%d broken=%v очков=%d", e.RepairClicks, e.PCBroken, g.ActionPoints)
	}
	e.RepairClicks = 1 // начатый — и без очков
	if err := g.RepairClick(0, 0); err != nil {
		t.Fatalf("начатый ремонт без очков: %v", err)
	}
}

func TestVirusStartCostsOnePointClicksFree(t *testing.T) {
	g := pointsGame(t)
	e := &g.Offices[0].Employees[1]
	for i := 0; i < g.cfg.VirusCleanClicks; i++ {
		if err := g.VirusClick(0, 1); err != nil {
			t.Fatalf("клик %d: %v", i+1, err)
		}
		if g.ActionPoints != 7 {
			t.Fatalf("после клика %d очков %d, хотим 7", i+1, g.ActionPoints)
		}
	}
	if e.Infected {
		t.Fatal("место должно быть вычищено")
	}
	g.ActionPoints = 0
	e.Infected = true
	if err := g.VirusClick(0, 1); !errors.Is(err, ErrNoActionPoints) {
		t.Fatalf("без очков: ошибка %v, хотим no_action_points", err)
	}
	if e.VirusClicks != 0 {
		t.Fatalf("отказ сделал клик: virusClicks=%d", e.VirusClicks)
	}
}

func TestBrokenInfectedPlaceCostsTwo(t *testing.T) {
	g := pointsGame(t)
	e := &g.Offices[0].Employees[0]
	e.Infected = true
	for e.PCBroken {
		if err := g.RepairClick(0, 0); err != nil {
			t.Fatal(err)
		}
	}
	for e.Infected {
		if err := g.VirusClick(0, 0); err != nil {
			t.Fatal(err)
		}
	}
	if g.ActionPoints != 6 {
		t.Fatalf("ремонт + чистка одного места: очков %d, хотим 6", g.ActionPoints)
	}
}

func TestMotivateMasterReplaceCostNoPoints(t *testing.T) {
	g := pointsGame(t)
	if err := g.Motivate(0, 2); err != nil {
		t.Fatalf("мотивация: %v", err)
	}
	if err := g.CallMaster(0, 0); err != nil {
		t.Fatalf("мастер: %v", err)
	}
	g.Offices[0].Workplaces[2].Wear = 1
	if err := g.ReplacePC(0, 2); err != nil {
		t.Fatalf("замена: %v", err)
	}
	if g.ActionPoints != 8 {
		t.Fatalf("мотивация, мастер и замена взяли очки: осталось %d", g.ActionPoints)
	}
}

func TestNextDayRefillsWithoutCarry(t *testing.T) {
	g := pointsGame(t)
	g.ActionPoints = 3
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.ActionPoints != 8 {
		t.Fatalf("утро: очков %d, хотим 8", g.ActionPoints)
	}
}

func TestOfflineMorningRefills(t *testing.T) {
	g := pointsGame(t)
	g.ActionPoints = 0
	g.AdvanceOffline(g.cfg.DayTicks() + 1) // вечер позади, утро дня 2
	if g.Phase != PhaseRunning || g.Day != 2 {
		t.Fatalf("ждали утро дня 2, получили день %d фаза %s", g.Day, g.Phase)
	}
	if g.ActionPoints != 8 {
		t.Fatalf("офлайн-утро: очков %d, хотим 8", g.ActionPoints)
	}
}

func TestActionPointsSaveRoundtrip(t *testing.T) {
	g := pointsGame(t)
	g.ActionPoints = 5
	back, err := Restore(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	if back.ActionPoints != 5 {
		t.Fatalf("после restore очков %d, хотим 5", back.ActionPoints)
	}
	for _, bad := range []int{-1, 9} {
		s := g.Export()
		s.ActionPoints = bad
		if _, err := Restore(s); !errors.Is(err, ErrBadSave) {
			t.Errorf("actionPoints=%d: restore %v, хотим bad_save", bad, err)
		}
	}
}

// Админ очков не тратит: чинит и чистит бесплатно при нуле очков у директора
// (ITGAME-101 + ITGAME-127).
func TestAdminSpendsNoActionPoints(t *testing.T) {
	g := adminGame(t, 4)
	es := g.Offices[0].Employees
	breakSeat(&es[0], 4)
	es[1].Infected = true
	g.ActionPoints = 0
	for range 10 {
		g.Tick()
	}
	if es[0].PCBroken || es[1].Infected {
		t.Fatalf("админ не справился: broken=%v infected=%v; хотим починено и вычищено", es[0].PCBroken, es[1].Infected)
	}
	if g.DayAdminRepairs != 1 || g.DayAdminCleaned != 1 {
		t.Errorf("починок админа %d, чисток %d; хотим 1 и 1", g.DayAdminRepairs, g.DayAdminCleaned)
	}
	if g.ActionPoints != 0 {
		t.Errorf("очков действий %d, хотим 0: админ их не тратит", g.ActionPoints)
	}
}
