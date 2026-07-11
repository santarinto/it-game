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
