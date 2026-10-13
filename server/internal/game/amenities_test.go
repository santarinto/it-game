package game

import "testing"

func TestBuyAmenities(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 10000
	if err := g.BuyCooler(0); err != nil {
		t.Fatalf("кулер: %v", err)
	}
	if err := g.BuyFridge(0); err != nil {
		t.Fatalf("холодильник: %v", err)
	}
	if err := g.BuyCoffeeMachine(0); err != nil {
		t.Fatalf("кофеварка: %v", err)
	}
	o := g.Offices[0]
	if !o.Cooler || !o.Fridge || !o.CoffeeMachine {
		t.Errorf("устройства не установились: %+v", o)
	}
	if g.Money != 10000-400-600-800 {
		t.Errorf("Money = %d, хотим 8200", g.Money)
	}
	if err := g.BuyCooler(0); err != ErrEquipmentAlready {
		t.Errorf("повторный кулер: %v, хотим %v", err, ErrEquipmentAlready)
	}
}

func TestBuyAmenityValidation(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 10000
	if err := g.BuyCooler(1); err != ErrOfficeLocked {
		t.Errorf("кулер в закрытый офис: %v, хотим %v", err, ErrOfficeLocked)
	}
	g2 := New(DefaultConfig())
	g2.Money = 100
	g2.Offices[0].Cooler = true
	if err := g2.BuyFridge(0); err != ErrNotEnoughMoney {
		t.Errorf("холодильник без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
}

// ITGAME-102: холодильник и кофеварка — только после кулера этого офиса;
// отказ раньше проверки денег и ничего не списывает.
func TestFridgeAndCoffeeNeedCooler(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 10000
	if err := g.BuyFridge(0); err != ErrNeedCooler {
		t.Errorf("холодильник без кулера: %v, хотим %v", err, ErrNeedCooler)
	}
	if err := g.BuyCoffeeMachine(0); err != ErrNeedCooler {
		t.Errorf("кофеварка без кулера: %v, хотим %v", err, ErrNeedCooler)
	}
	if g.Money != 10000 || g.Offices[0].Fridge || g.Offices[0].CoffeeMachine {
		t.Errorf("отказ что-то купил: Money=%d %+v", g.Money, g.Offices[0])
	}
	g.Money = 100
	if err := g.BuyFridge(0); err != ErrNeedCooler {
		t.Errorf("холодильник без кулера и без денег: %v, хотим %v", err, ErrNeedCooler)
	}
	g.Money = 10000
	if err := g.BuyCooler(0); err != nil {
		t.Fatalf("кулер: %v", err)
	}
	if err := g.BuyFridge(0); err != nil {
		t.Errorf("холодильник после кулера: %v", err)
	}
	if err := g.BuyCoffeeMachine(0); err != nil {
		t.Errorf("кофеварка после кулера: %v", err)
	}
	// кулер — по офису: кулер офиса 0 не открывает быт офиса 1
	g.Offices[1].Unlocked = true
	if err := g.BuyFridge(1); err != ErrNeedCooler {
		t.Errorf("холодильник в офисе без своего кулера: %v, хотим %v", err, ErrNeedCooler)
	}
}

func TestApplyAmenities(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 10000
	for _, cmd := range []Command{CmdBuyCooler, CmdBuyFridge, CmdBuyCoffee} {
		if err := g.Apply(cmd, 0, 0); err != nil {
			t.Errorf("Apply(%s): %v", cmd, err)
		}
	}
	g.Phase = PhaseDayReport
	if err := g.Apply(CmdBuyCooler, 0, 0); err != ErrWrongPhase {
		t.Errorf("покупка в day_report: %v, хотим %v", err, ErrWrongPhase)
	}
}
