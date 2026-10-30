package game

import (
	"errors"
	"testing"
)

func TestDirectorLevelsAndActionPoints(t *testing.T) {
	cfg := DefaultConfig()
	g := NewWithSeed(cfg, 10, 20)

	// День 1: базовые 8 ОД, уровень 1, бонус опыта 0
	if g.DirectorLevel() != 1 {
		t.Fatalf("день 1: уровень %d, хотим 1", g.DirectorLevel())
	}
	if g.DirectorExpBonus() != 0 {
		t.Fatalf("день 1: бонус опыта %d, хотим 0", g.DirectorExpBonus())
	}
	if g.ActionPointsMax() != 8 {
		t.Fatalf("день 1: max ОД %d, хотим 8", g.ActionPointsMax())
	}

	// Проверка роста опыта по дням (каждые 5 дней +1 ОД, максимум +4)
	tests := []struct {
		day          int
		wantExpBonus int
		wantLevel    int
		wantMax      int
	}{
		{day: 5, wantExpBonus: 0, wantLevel: 1, wantMax: 8},
		{day: 6, wantExpBonus: 1, wantLevel: 2, wantMax: 9},
		{day: 10, wantExpBonus: 1, wantLevel: 2, wantMax: 9},
		{day: 11, wantExpBonus: 2, wantLevel: 3, wantMax: 10},
		{day: 15, wantExpBonus: 2, wantLevel: 3, wantMax: 10},
		{day: 16, wantExpBonus: 3, wantLevel: 4, wantMax: 11},
		{day: 20, wantExpBonus: 3, wantLevel: 4, wantMax: 11},
		{day: 21, wantExpBonus: 4, wantLevel: 5, wantMax: 12},
		{day: 35, wantExpBonus: 4, wantLevel: 7, wantMax: 12}, // потолок бонуса ОД 4
	}

	for _, tc := range tests {
		g.Day = tc.day
		if got := g.DirectorExpBonus(); got != tc.wantExpBonus {
			t.Errorf("день %d: DirectorExpBonus=%d, хотим %d", tc.day, got, tc.wantExpBonus)
		}
		if got := g.DirectorLevel(); got != tc.wantLevel {
			t.Errorf("день %d: DirectorLevel=%d, хотим %d", tc.day, got, tc.wantLevel)
		}
		if got := g.ActionPointsMax(); got != tc.wantMax {
			t.Errorf("день %d: ActionPointsMax=%d, хотим %d", tc.day, got, tc.wantMax)
		}
	}
}

func TestDirectorCabinetUpgrade(t *testing.T) {
	cfg := DefaultConfig()
	g := NewWithSeed(cfg, 10, 20)
	g.Money = 500
	g.ActionPoints = 8

	// Попытка апгрейда без денег
	err := g.Apply(CmdUpgradeDirector, 0, 0)
	if !errors.Is(err, ErrNotEnoughMoney) {
		t.Fatalf("апгрейд без денег: ошибка %v, хотим ErrNotEnoughMoney", err)
	}

	// Покупка Уровня 1: Эргономика и 2 монитора ($1200, +1 ОД)
	g.Money = 2000
	err = g.Apply(CmdUpgradeDirector, 0, 0)
	if err != nil {
		t.Fatalf("апгрейд 1: неожиданная ошибка: %v", err)
	}
	if g.DirectorCabinet != 1 {
		t.Fatalf("уровень кабинета %d, хотим 1", g.DirectorCabinet)
	}
	if g.Money != 800 {
		t.Fatalf("баланс после покупки %d, хотим 800", g.Money)
	}
	if g.ActionPoints != 9 {
		t.Fatalf("текущие ОД сразу после апгрейда %d, хотим 9 (бонус +1 на сегодня)", g.ActionPoints)
	}
	if g.ActionPointsMax() != 9 {
		t.Fatalf("ActionPointsMax %d, хотим 9", g.ActionPointsMax())
	}
	if g.DirectorCabinetBonus() != 1 {
		t.Fatalf("бонус кабинета %d, хотим 1", g.DirectorCabinetBonus())
	}

	// Покупка Уровня 2: Кофемашина шефа ($3500, +2 ОД)
	g.Money = 4000
	_ = g.Apply(CmdUpgradeDirector, 0, 0)
	if g.DirectorCabinet != 2 || g.ActionPointsMax() != 11 {
		t.Fatalf("кабинет %d, max %d, хотим 2 и 11", g.DirectorCabinet, g.ActionPointsMax())
	}

	// Покупка Уровня 3: Секретарь ($8000, +2 ОД)
	g.Money = 10000
	_ = g.Apply(CmdUpgradeDirector, 0, 0)
	if g.DirectorCabinet != 3 || g.ActionPointsMax() != 13 {
		t.Fatalf("кабинет %d, max %d, хотим 3 и 13", g.DirectorCabinet, g.ActionPointsMax())
	}

	// Покупка Уровня 4: Ситуационный центр ($18000, +3 ОД)
	g.Money = 20000
	_ = g.Apply(CmdUpgradeDirector, 0, 0)
	if g.DirectorCabinet != 4 || g.ActionPointsMax() != 16 {
		t.Fatalf("кабинет %d, max %d, хотим 4 и 16", g.DirectorCabinet, g.ActionPointsMax())
	}

	// Попытка апгрейда сверх максимума
	g.Money = 50000
	err = g.Apply(CmdUpgradeDirector, 0, 0)
	if !errors.Is(err, ErrDirectorCabinetMaxed) {
		t.Fatalf("апгрейд сверх максимума: ошибка %v, хотим ErrDirectorCabinetMaxed", err)
	}

	// Проверяем гибрид: если теперь день 21 (бонус опыта +4 ОД),
	// то максимум = 8 (базовый) + 4 (опыт) + 8 (кабинет) = 20 ОД!
	g.Day = 21
	if g.ActionPointsMax() != 20 {
		t.Fatalf("день 21 + 4 уровень кабинета: max %d, хотим 20", g.ActionPointsMax())
	}
}

func TestDirectorMorningReset(t *testing.T) {
	cfg := DefaultConfig()
	g := NewWithSeed(cfg, 10, 20)
	g.Day = 6 // +1 ОД от опыта
	g.DirectorCabinet = 1 // +1 ОД от кабинета
	// Max = 8 + 1 + 1 = 10
	if g.ActionPointsMax() != 10 {
		t.Fatalf("max %d, хотим 10", g.ActionPointsMax())
	}

	// Потратили все очки до нуля
	g.ActionPoints = 0
	g.Phase = PhaseDayReport

	// Смена дня
	err := g.NextDay()
	if err != nil {
		t.Fatalf("NextDay error: %v", err)
	}
	if g.ActionPoints != 10 {
		t.Fatalf("утро: ActionPoints %d, хотим 10 (ActionPointsMax)", g.ActionPoints)
	}
}

func TestDirectorSaveRoundtrip(t *testing.T) {
	cfg := DefaultConfig()
	g := NewWithSeed(cfg, 10, 20)
	g.Day = 11
	g.DirectorCabinet = 2
	g.ActionPoints = 7

	s := g.Export()
	if s.DirectorCabinet != 2 {
		t.Fatalf("export DirectorCabinet=%d, хотим 2", s.DirectorCabinet)
	}

	back, err := Restore(s)
	if err != nil {
		t.Fatalf("restore error: %v", err)
	}
	if back.DirectorCabinet != 2 {
		t.Fatalf("restored DirectorCabinet=%d, хотим 2", back.DirectorCabinet)
	}
	if back.ActionPointsMax() != g.ActionPointsMax() {
		t.Fatalf("restored ActionPointsMax=%d, хотим %d", back.ActionPointsMax(), g.ActionPointsMax())
	}
}

func TestDirectorUpgradeLedger(t *testing.T) {
	cfg := DefaultConfig()
	g := NewWithSeed(cfg, 10, 20)
	g.Money = 5000

	if err := g.Apply(CmdUpgradeDirector, 0, 0); err != nil {
		t.Fatalf("Apply(CmdUpgradeDirector): %v", err)
	}

	found := false
	for _, p := range g.Ledger.Purchases {
		if p.Type == string(CmdUpgradeDirector) && p.Price == 1200 {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("покупка апгрейда директора не записана в книгу покупок: %+v", g.Ledger.Purchases)
	}
}

func TestDirectorSaveValidation(t *testing.T) {
	cfg := DefaultConfig()
	g := NewWithSeed(cfg, 10, 20)
	s := g.Export()

	s.DirectorCabinet = -1
	if _, err := Restore(s); !errors.Is(err, ErrBadSave) {
		t.Errorf("Restore с DirectorCabinet=-1: err=%v, ждали ErrBadSave", err)
	}

	s.DirectorCabinet = len(cfg.DirectorCabinetLevels) + 1
	if _, err := Restore(s); !errors.Is(err, ErrBadSave) {
		t.Errorf("Restore с DirectorCabinet=%d: err=%v, ждали ErrBadSave", s.DirectorCabinet, err)
	}
}
