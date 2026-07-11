package ws

import (
	"testing"

	"itdirector/internal/game"
)

func TestSnapshot(t *testing.T) {
	g := game.New(game.DefaultConfig())
	s := snapshot(g)
	if s.Type != "state" {
		t.Errorf("Type = %q, хотим state", s.Type)
	}
	if s.Money != 600 || s.PCs != 1 || s.OfficeSlots != 9 || s.RackSlots != 3 {
		t.Errorf("стартовый снапшот неверен: %+v", s)
	}
	if s.Prices.PC != 500 || s.Prices.Hire != 300 || s.Prices.Server != 2000 || s.Prices.NextRouter != 800 {
		t.Errorf("цены в снапшоте неверны: %+v", s.Prices)
	}
	if s.Multiplier != 1.0 || s.IncomePerTick != 0 {
		t.Errorf("производные поля неверны: %+v", s)
	}
	if s.Day != 1 || s.DayTicks != 60 || s.DayProgress != 0 || s.PayrollPerDay != 0 || s.Phase != "running" {
		t.Errorf("поля дня в снапшоте неверны: %+v", s)
	}
}
