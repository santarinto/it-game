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
	if err := g2.BuyFridge(0); err != ErrNotEnoughMoney {
		t.Errorf("холодильник без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
}

func TestApplyAmenities(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 10000
	for _, cmd := range []Command{CmdBuyCooler, CmdBuyFridge, CmdBuyCoffee} {
		if err := g.Apply(cmd, 0); err != nil {
			t.Errorf("Apply(%s): %v", cmd, err)
		}
	}
	g.Phase = PhaseDayReport
	if err := g.Apply(CmdBuyCooler, 0); err != ErrWrongPhase {
		t.Errorf("покупка в day_report: %v, хотим %v", err, ErrWrongPhase)
	}
}
