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
	if s.Money != 600 || s.PCs != 1 || s.OfficeSlots != 12 || s.RackSlots != 3 {
		t.Errorf("стартовый снапшот неверен: %+v", s)
	}
	if s.Prices.PC != 500 || s.Prices.Hire != 300 || s.Prices.Server != 2000 || s.Prices.NextRouter != 800 {
		t.Errorf("цены в снапшоте неверны: %+v", s.Prices)
	}
	if s.Multiplier != 1.0 || s.IncomePerTick != 0 {
		t.Errorf("производные поля неверны: %+v", s)
	}
	if s.Day != 1 || s.DayTicks != 54 || s.DayProgress != 0 || s.PayrollPerDay != 0 || s.Phase != "running" {
		t.Errorf("поля дня в снапшоте неверны: %+v", s)
	}
	if len(s.Employees) != 0 || s.Clock != "10:00" || s.IsLunch || s.StaffLimit != 9 ||
		s.SalaryPerDay != 250 || s.TicksPerHour != 6 || s.ForecastEndOfDay != 600 {
		t.Errorf("поля итерации 3 неверны: %+v", s)
	}
}

func TestSnapshotEmployees(t *testing.T) {
	g := game.New(game.DefaultConfig())
	g.Offices[0].PCs = 3
	g.Offices[0].Employees = []game.Employee{
		{Name: "Анна Иванова", IncomePerTick: 12},
		{Name: "Пётр Волков", IncomePerTick: 9},
	}
	g.Offices[0].RouterTier = 1 // 4 порта: оба подключены
	s := snapshot(g)
	if len(s.Employees) != 2 {
		t.Fatalf("employees в снапшоте: %d, хотим 2", len(s.Employees))
	}
	if s.Employees[0].Name != "Анна Иванова" || s.Employees[0].IncomePerTick != 12 || !s.Employees[0].Connected {
		t.Errorf("первый сотрудник: %+v", s.Employees[0])
	}
	if !s.Employees[1].Connected {
		t.Errorf("второй сотрудник должен быть в сети: %+v", s.Employees[1])
	}
}

func TestSnapshotEmployeesBeyondPorts(t *testing.T) {
	// Сотрудников больше, чем портов роутера: хвост списка вне сети.
	g := game.New(game.DefaultConfig())
	g.Offices[0].PCs = 6
	g.Offices[0].Employees = make([]game.Employee, 6)
	for i := range g.Offices[0].Employees {
		g.Offices[0].Employees[i] = game.Employee{Name: "Тест Тестов", IncomePerTick: 10}
	}
	g.Offices[0].RouterTier = 1 // 4 порта на 6 сотрудников
	s := snapshot(g)
	for i, e := range s.Employees {
		want := i < 4
		if e.Connected != want {
			t.Errorf("сотрудник %d: connected=%v, хотим %v", i, e.Connected, want)
		}
	}
}
