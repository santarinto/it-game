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
	if len(g.Offices[0].Employees) != 0 || g.Offices[0].RouterTier != 0 || len(g.Offices[0].Servers) != 0 {
		t.Errorf("на старте не должно быть сотрудников, роутера и серверов: %+v", g)
	}
}

// TestIncome — доход через полную цепочку «роутер → core → сервер» (см. Network).
func TestIncome(t *testing.T) {
	tests := []struct {
		name       string
		employees  int
		routerTier int
		servers    []int // уровни серверов офиса; порядок покупки
		coreLevel  int
		wantIncome int
	}{
		{"без роутера: базовая выработка", 2, 0, nil, 0, 20},
		{"серверы и core без роутера не дают ничего", 2, 0, []int{3}, 1, 20},
		{"роутер и core без серверов множителя не даёт", 2, 1, nil, 1, 20},
		{"роутер и серверы без core не дают ничего", 2, 1, []int{1}, 0, 20},
		{"портов меньше, чем сотрудников", 6, 1, []int{1}, 1, 72},                 // 4×(10×1.3) + 2×10
		{"роутер + сервер ур.3: ×2.2", 6, 1, []int{3}, 1, 108},                    // 4×(10×2.2) + 2×10
		{"потолок: 9 сотрудников на серверах ур.3", 9, 2, []int{3, 3, 3}, 2, 198}, // 9×(10×2.2)
		{"без сотрудников дохода нет", 0, 0, nil, 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			g.Offices[0].PCs = tt.employees
			g.Offices[0].Employees = testStaff(tt.employees)
			g.Offices[0].RouterTier = tt.routerTier
			g.Offices[0].Servers = tt.servers
			g.CoreLevel = tt.coreLevel
			if inc := g.IncomePerTick(); inc != tt.wantIncome {
				t.Errorf("IncomePerTick() = %d, хотим %d", inc, tt.wantIncome)
			}
		})
	}
}

func TestTickAddsIncome(t *testing.T) {
	cfg := DefaultConfig()
	cfg.BreakdownChancePct = 0 // доход теста не должен зависеть от роллов поломок
	g := New(cfg)
	g.Money = 0
	g.Offices[0].Employees = testStaff(1)
	g.Tick()
	g.Tick()
	if g.Money != 20 {
		t.Errorf("после двух тиков Money = %d, хотим 20", g.Money)
	}
}
