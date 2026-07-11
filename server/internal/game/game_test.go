package game

import "testing"

func TestNewGameStart(t *testing.T) {
	g := New(DefaultConfig())
	if g.Money != 600 {
		t.Errorf("Money = %d, хотим 600", g.Money)
	}
	if g.PCs != 1 {
		t.Errorf("PCs = %d, хотим 1 (стартовый ПК)", g.PCs)
	}
	if g.Employees != 0 || g.RouterTier != 0 || g.Servers != 0 {
		t.Errorf("на старте не должно быть сотрудников, роутера и серверов: %+v", g)
	}
}

func TestBuyPC(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*Game)
		wantErr   error
		wantPCs   int
		wantMoney int
	}{
		{"успех: деньги ровно по цене", func(g *Game) { g.Money = 500 }, nil, 2, 0},
		{"не хватает денег", func(g *Game) { g.Money = 499 }, ErrNotEnoughMoney, 1, 499},
		{"офис полон", func(g *Game) { g.Money = 10000; g.PCs = 9 }, ErrNoFreeOfficeSlot, 9, 10000},
		{"офис полон и денег нет: слот проверяется первым", func(g *Game) { g.Money = 0; g.PCs = 9 }, ErrNoFreeOfficeSlot, 9, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyPC(); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.PCs != tt.wantPCs || g.Money != tt.wantMoney {
				t.Errorf("PCs=%d Money=%d, хотим PCs=%d Money=%d", g.PCs, g.Money, tt.wantPCs, tt.wantMoney)
			}
		})
	}
}

func TestBuyRouter(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*Game)
		wantErr   error
		wantTier  int
		wantMoney int
	}{
		{"тир 1 за $800", func(g *Game) { g.Money = 800 }, nil, 1, 0},
		{"апгрейд до тира 2 за $2500", func(g *Game) { g.Money = 2500; g.RouterTier = 1 }, nil, 2, 0},
		{"выше тира 2 нельзя", func(g *Game) { g.Money = 99999; g.RouterTier = 2 }, ErrRouterMaxed, 2, 99999},
		{"не хватает денег", func(g *Game) { g.Money = 799 }, ErrNotEnoughMoney, 0, 799},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyRouter(); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.RouterTier != tt.wantTier || g.Money != tt.wantMoney {
				t.Errorf("RouterTier=%d Money=%d, хотим %d и %d", g.RouterTier, g.Money, tt.wantTier, tt.wantMoney)
			}
		})
	}
}

func TestNextRouterPrice(t *testing.T) {
	g := New(DefaultConfig())
	if p := g.NextRouterPrice(); p != 800 {
		t.Errorf("без роутера цена = %d, хотим 800", p)
	}
	g.RouterTier = 1
	if p := g.NextRouterPrice(); p != 2500 {
		t.Errorf("после тира 1 цена = %d, хотим 2500", p)
	}
	g.RouterTier = 2
	if p := g.NextRouterPrice(); p != 0 {
		t.Errorf("на максимальном тире цена = %d, хотим 0", p)
	}
}

func TestBuyServer(t *testing.T) {
	tests := []struct {
		name        string
		setup       func(*Game)
		wantErr     error
		wantServers int
		wantMoney   int
	}{
		{"успех", func(g *Game) { g.Money = 2000 }, nil, 1, 0},
		{"серверная полна", func(g *Game) { g.Money = 99999; g.Servers = 3 }, ErrNoFreeRackSlot, 3, 99999},
		{"не хватает денег", func(g *Game) { g.Money = 1999 }, ErrNotEnoughMoney, 0, 1999},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyServer(); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.Servers != tt.wantServers || g.Money != tt.wantMoney {
				t.Errorf("Servers=%d Money=%d, хотим %d и %d", g.Servers, g.Money, tt.wantServers, tt.wantMoney)
			}
		})
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
		{"серверы без роутера не дают ничего", 2, 0, 3, 0, 1.0, 20},
		{"роутер тир 1: подключённые ×1.5", 2, 1, 0, 2, 1.5, 30},
		{"портов меньше, чем сотрудников", 6, 1, 0, 4, 1.5, 80}, // 4×15 + 2×10
		{"роутер + 2 сервера: ×2.5", 6, 1, 2, 4, 2.5, 120},      // 4×25 + 2×10
		{"потолок MVP: 9 сотрудников на ×3.0", 9, 2, 3, 9, 3.0, 270},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			g.PCs = tt.employees
			g.Employees = tt.employees
			g.RouterTier = tt.routerTier
			g.Servers = tt.servers
			if c := g.Connected(); c != tt.wantConnected {
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
	g.Employees = 1
	g.Tick()
	g.Tick()
	if g.Money != 20 {
		t.Errorf("после двух тиков Money = %d, хотим 20", g.Money)
	}
}

func TestApply(t *testing.T) {
	g := New(DefaultConfig())
	if err := g.Apply(CmdHire); err != nil {
		t.Fatalf("Apply(hire): %v", err)
	}
	if g.Employees != 1 {
		t.Errorf("Apply(hire) не нанял: Employees = %d", g.Employees)
	}
	if err := g.Apply(Command("dance")); err != ErrUnknownCommand {
		t.Errorf("неизвестная команда: err = %v, хотим %v", err, ErrUnknownCommand)
	}
}

func TestHire(t *testing.T) {
	tests := []struct {
		name          string
		setup         func(*Game)
		wantErr       error
		wantEmployees int
		wantMoney     int
	}{
		{"успех: есть свободный стартовый ПК", func(g *Game) { g.Money = 300 }, nil, 1, 0},
		{"нет свободного ПК", func(g *Game) { g.Money = 1000; g.Employees = 1 }, ErrNoFreePC, 1, 1000},
		{"не хватает денег", func(g *Game) { g.Money = 299 }, ErrNotEnoughMoney, 0, 299},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.Hire(); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.Employees != tt.wantEmployees || g.Money != tt.wantMoney {
				t.Errorf("Employees=%d Money=%d, хотим %d и %d", g.Employees, g.Money, tt.wantEmployees, tt.wantMoney)
			}
		})
	}
}
