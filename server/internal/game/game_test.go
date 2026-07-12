package game

import "testing"

func TestNewGameStart(t *testing.T) {
	g := New(DefaultConfig())
	if g.Money != 600 {
		t.Errorf("Money = %d, хотим 600", g.Money)
	}
	if g.Offices[0].PCs != 1 {
		t.Errorf("PCs = %d, хотим 1 (стартовый ПК)", g.Offices[0].PCs)
	}
	if len(g.Offices[0].Employees) != 0 || g.Offices[0].RouterTier != 0 || g.Servers != 0 {
		t.Errorf("на старте не должно быть сотрудников, роутера и серверов: %+v", g)
	}
}

func TestIncome(t *testing.T) {
	tests := []struct {
		name                           string
		employees, routerTier, servers int
		wantConnected                  int
		wantMultiplier                 float64
		wantIncome                     int
	}{
		{"без роутера: базовая выработка", 2, 0, 0, 0, 1.0, 20},
		{"серверы без роутера не дают ничего", 2, 0, 3, 0, 2.5, 20},
		{"роутер без серверов множителя не даёт", 2, 1, 0, 2, 1.0, 20},
		{"портов меньше, чем сотрудников", 6, 1, 1, 4, 1.5, 80}, // 4×15 + 2×10
		{"роутер + 2 сервера: ×2.0", 6, 1, 2, 4, 2.0, 100},      // 4×20 + 2×10
		{"потолок: 9 сотрудников на ×2.5", 9, 2, 3, 9, 2.5, 225},
		{"без сотрудников дохода нет", 0, 0, 0, 0, 1.0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			g.Offices[0].PCs = tt.employees
			g.Offices[0].Employees = testStaff(tt.employees)
			g.Offices[0].RouterTier = tt.routerTier
			g.Servers = tt.servers
			if c := g.Offices[0].Connected(DefaultConfig()); c != tt.wantConnected {
				t.Errorf("Connected() = %d, хотим %d", c, tt.wantConnected)
			}
			if m := g.Multiplier(); m != tt.wantMultiplier {
				t.Errorf("Multiplier() = %v, хотим %v", m, tt.wantMultiplier)
			}
			if inc := g.IncomePerTick(); inc != tt.wantIncome {
				t.Errorf("IncomePerTick() = %d, хотим %d", inc, tt.wantIncome)
			}
		})
	}
}

func TestTickAddsIncome(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 0
	g.Offices[0].Employees = testStaff(1)
	g.Tick()
	g.Tick()
	if g.Money != 20 {
		t.Errorf("после двух тиков Money = %d, хотим 20", g.Money)
	}
}
