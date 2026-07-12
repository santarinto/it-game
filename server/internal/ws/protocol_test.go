package ws

import (
	"testing"

	"itdirector/internal/game"
)

func TestSnapshot(t *testing.T) {
	g := game.New(game.DefaultConfig())
	s := snapshot(g)
	if s.Type != "state" || s.Money != 600 || s.OfficeSlots != 12 || s.RackSlots != 3 {
		t.Errorf("базовые поля: %+v", s)
	}
	if len(s.Offices) != 3 {
		t.Fatalf("офисов в снапшоте %d, хотим 3", len(s.Offices))
	}
	if !s.Offices[0].Unlocked || s.Offices[0].PCs != 1 || s.Offices[0].Price != 0 || s.Offices[0].NextRouter != 800 {
		t.Errorf("офис 0: %+v", s.Offices[0])
	}
	if s.Offices[1].Unlocked || s.Offices[1].Price != 15000 || s.Offices[2].Price != 40000 {
		t.Errorf("закрытые офисы: %+v %+v", s.Offices[1], s.Offices[2])
	}
	if s.Gateway || s.Servers != 0 || s.Multiplier != 1.0 {
		t.Errorf("серверная: %+v", s)
	}
	if s.Prices.PC != 500 || s.Prices.Hire != 300 || s.Prices.Server != 2000 ||
		s.Prices.Boss != 1000 || s.Prices.Gateway != 3000 {
		t.Errorf("цены: %+v", s.Prices)
	}
	if s.Clock != "10:00" || s.IsLunch || s.StaffLimit != 9 || s.SalaryPerDay != 250 ||
		s.BossSalaryPerDay != 500 || s.TicksPerHour != 6 || s.ForecastEndOfDay != 600 ||
		s.Day != 1 || s.Phase != "running" || s.PayrollPerDay != 0 {
		t.Errorf("поля дня: %+v", s)
	}
}

func TestSnapshotOfficeDetails(t *testing.T) {
	g := game.New(game.DefaultConfig())
	g.Offices[0].PCs = 6
	g.Offices[0].RouterTier = 1
	g.Offices[0].Boss = "Босс Боссов"
	staff := make([]game.Employee, 6)
	for i := range staff {
		staff[i] = game.Employee{Name: "Тест Тестов", IncomePerTick: 10}
	}
	staff[5].UnpaidToday = true
	g.Offices[0].Employees = staff
	s := snapshot(g)
	o := s.Offices[0]
	if o.Boss != "Босс Боссов" || o.Ports != 4 || o.NextRouter != 2500 {
		t.Errorf("офис 0: %+v", o)
	}
	for i, e := range o.Employees {
		if want := i < 4; e.Connected != want {
			t.Errorf("сотрудник %d connected=%v, хотим %v", i, e.Connected, want)
		}
	}
	if !o.Employees[5].UnpaidToday {
		t.Error("unpaidToday не прокинулся в снапшот")
	}
}
