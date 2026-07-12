package game

import "testing"

// unlockedGame — игра с деньгами и открытым офисом 1 для тестов адресации.
func unlockedGame(money int) *Game {
	g := New(DefaultConfig())
	g.Money = money
	return g
}

func TestOfficeCommandValidation(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.BuyPC(-1); err != ErrBadOffice {
		t.Errorf("office=-1: %v, хотим %v", err, ErrBadOffice)
	}
	if err := g.BuyPC(3); err != ErrBadOffice {
		t.Errorf("office=3: %v, хотим %v", err, ErrBadOffice)
	}
	if err := g.Hire(1); err != ErrOfficeLocked {
		t.Errorf("найм в закрытый офис: %v, хотим %v", err, ErrOfficeLocked)
	}
	if err := g.BuyRouter(1); err != ErrOfficeLocked {
		t.Errorf("роутер в закрытый офис: %v, хотим %v", err, ErrOfficeLocked)
	}
}

func TestHireBoss(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.HireBoss(0); err != nil {
		t.Fatalf("найм босса: %v", err)
	}
	if g.Offices[0].Boss == "" {
		t.Error("имя босса не роллнулось")
	}
	if g.Money != 100000-1000 {
		t.Errorf("Money = %d, хотим 99000", g.Money)
	}
	if err := g.HireBoss(0); err != ErrBossAlready {
		t.Errorf("второй босс: %v, хотим %v", err, ErrBossAlready)
	}
	g2 := unlockedGame(500)
	if err := g2.HireBoss(0); err != ErrNotEnoughMoney {
		t.Errorf("босс без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
}

func TestBossOpensSlots(t *testing.T) {
	g := unlockedGame(100000)
	g.Offices[0].PCs = 9
	g.Offices[0].Employees = testStaff(9)
	if err := g.Hire(0); err != ErrStaffLimit {
		t.Fatalf("10-й найм без босса: %v, хотим %v", err, ErrStaffLimit)
	}
	if err := g.BuyPC(0); err != ErrStaffLimit {
		t.Fatalf("10-й ПК без босса: %v, хотим %v", err, ErrStaffLimit)
	}
	if err := g.HireBoss(0); err != nil {
		t.Fatal(err)
	}
	if err := g.BuyPC(0); err != nil {
		t.Errorf("10-й ПК с боссом: %v", err)
	}
	if err := g.Hire(0); err != nil {
		t.Errorf("10-й найм с боссом: %v", err)
	}
}

func TestBuyOffice(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.BuyOffice(2); err != ErrBadOffice {
		t.Errorf("покупка офиса 3 раньше офиса 2: %v, хотим %v", err, ErrBadOffice)
	}
	if err := g.BuyOffice(0); err != ErrBadOffice {
		t.Errorf("покупка уже открытого: %v, хотим %v", err, ErrBadOffice)
	}
	if err := g.BuyOffice(1); err != nil {
		t.Fatalf("покупка офиса 2: %v", err)
	}
	if !g.Offices[1].Unlocked || g.Offices[1].PCs != 0 || g.Offices[1].RouterTier != 0 {
		t.Errorf("офис 2 должен открыться пустым: %+v", g.Offices[1])
	}
	if g.Money != 100000-15000 {
		t.Errorf("Money = %d, хотим 85000", g.Money)
	}
	if err := g.BuyOffice(2); err != nil {
		t.Fatalf("покупка офиса 3: %v", err)
	}
	if g.Money != 85000-40000 {
		t.Errorf("Money = %d, хотим 45000", g.Money)
	}
	if err := g.BuyOffice(2); err != ErrOfficesMaxed {
		t.Errorf("все куплены: %v, хотим %v", err, ErrOfficesMaxed)
	}
	g2 := unlockedGame(100)
	if err := g2.BuyOffice(1); err != ErrNotEnoughMoney {
		t.Errorf("офис без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
}

func TestBuyGateway(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.BuyGateway(); err != nil {
		t.Fatalf("шлюз: %v", err)
	}
	if !g.Gateway || g.Money != 100000-3000 {
		t.Errorf("Gateway=%v Money=%d, хотим true и 97000", g.Gateway, g.Money)
	}
	if err := g.BuyGateway(); err != ErrGatewayAlready {
		t.Errorf("второй шлюз: %v, хотим %v", err, ErrGatewayAlready)
	}
}

func TestApplyWithOffice(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.Apply(CmdHire, 0); err != nil {
		t.Fatalf("Apply(hire, 0): %v", err)
	}
	if len(g.Offices[0].Employees) != 1 {
		t.Error("Apply(hire) не нанял в офис 0")
	}
	if err := g.Apply(CmdHireBoss, 1); err != ErrOfficeLocked {
		t.Errorf("босс в закрытый офис: %v, хотим %v", err, ErrOfficeLocked)
	}
	if err := g.Apply(CmdBuyGateway, 99); err != nil {
		t.Errorf("buy_gateway игнорирует офис: %v", err)
	}
}

func TestBuyPCTable(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*Game)
		wantErr   error
		wantPCs   int
		wantMoney int
	}{
		{"успех: деньги ровно по цене", func(g *Game) { g.Money = 500 }, nil, 2, 0},
		{"не хватает денег", func(g *Game) { g.Money = 499 }, ErrNotEnoughMoney, 1, 499},
		{"штат укомплектован без босса", func(g *Game) { g.Money = 10000; g.Offices[0].PCs = 9 }, ErrStaffLimit, 9, 10000},
		{"офис полон даже с боссом", func(g *Game) { g.Money = 10000; g.Offices[0].Boss = "Т Б"; g.Offices[0].PCs = 12 }, ErrNoFreeOfficeSlot, 12, 10000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyPC(0); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.Offices[0].PCs != tt.wantPCs || g.Money != tt.wantMoney {
				t.Errorf("PCs=%d Money=%d, хотим %d и %d", g.Offices[0].PCs, g.Money, tt.wantPCs, tt.wantMoney)
			}
		})
	}
}

func TestHireTable(t *testing.T) {
	tests := []struct {
		name          string
		setup         func(*Game)
		wantErr       error
		wantEmployees int
		wantMoney     int
	}{
		{"успех: есть свободный стартовый ПК", func(g *Game) { g.Money = 300 }, nil, 1, 0},
		{"нет свободного ПК", func(g *Game) { g.Money = 1000; g.Offices[0].Employees = testStaff(1) }, ErrNoFreePC, 1, 1000},
		{"не хватает денег", func(g *Game) { g.Money = 299 }, ErrNotEnoughMoney, 0, 299},
		{"нет ПК и денег: ПК проверяется первым", func(g *Game) { g.Money = 0; g.Offices[0].Employees = testStaff(1) }, ErrNoFreePC, 1, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.Hire(0); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if len(g.Offices[0].Employees) != tt.wantEmployees || g.Money != tt.wantMoney {
				t.Errorf("Employees=%d Money=%d, хотим %d и %d", len(g.Offices[0].Employees), g.Money, tt.wantEmployees, tt.wantMoney)
			}
		})
	}
}

func TestBuyRouterTable(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*Game)
		wantErr   error
		wantTier  int
		wantMoney int
	}{
		{"тир 1 за $800", func(g *Game) { g.Money = 800 }, nil, 1, 0},
		{"апгрейд до тира 2 за $2500", func(g *Game) { g.Money = 2500; g.Offices[0].RouterTier = 1 }, nil, 2, 0},
		{"выше тира 2 нельзя", func(g *Game) { g.Money = 99999; g.Offices[0].RouterTier = 2 }, ErrRouterMaxed, 2, 99999},
		{"не хватает денег", func(g *Game) { g.Money = 799 }, ErrNotEnoughMoney, 0, 799},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyRouter(0); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.Offices[0].RouterTier != tt.wantTier || g.Money != tt.wantMoney {
				t.Errorf("RouterTier=%d Money=%d, хотим %d и %d", g.Offices[0].RouterTier, g.Money, tt.wantTier, tt.wantMoney)
			}
		})
	}
}

func TestBuyServerTable(t *testing.T) {
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

func TestNextRouterPricePerOffice(t *testing.T) {
	g := New(DefaultConfig())
	if p := g.NextRouterPrice(0); p != 800 {
		t.Errorf("без роутера цена = %d, хотим 800", p)
	}
	g.Offices[0].RouterTier = 2
	if p := g.NextRouterPrice(0); p != 0 {
		t.Errorf("на максимальном тире цена = %d, хотим 0", p)
	}
}

func TestApplyUnknownAndPhase(t *testing.T) {
	g := New(DefaultConfig())
	if err := g.Apply(Command("dance"), 0); err != ErrUnknownCommand {
		t.Errorf("неизвестная команда: %v, хотим %v", err, ErrUnknownCommand)
	}
	g.Phase = PhaseDayReport
	for _, cmd := range []Command{CmdBuyPC, CmdHire, CmdBuyRouter, CmdBuyServer, CmdHireBoss, CmdBuyOffice, CmdBuyGateway} {
		if err := g.Apply(cmd, 0); err != ErrWrongPhase {
			t.Errorf("Apply(%s) в day_report: %v, хотим %v", cmd, err, ErrWrongPhase)
		}
	}
}
