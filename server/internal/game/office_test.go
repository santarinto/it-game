package game

import "testing"

func TestNewGameOffices(t *testing.T) {
	g := New(DefaultConfig())
	if len(g.Offices) != 3 {
		t.Fatalf("офисов %d, хотим 3", len(g.Offices))
	}
	if !g.Offices[0].Unlocked || g.Offices[0].PCs != 1 {
		t.Errorf("офис 0 должен быть открыт с 1 ПК: %+v", g.Offices[0])
	}
	if g.Offices[1].Unlocked || g.Offices[2].Unlocked {
		t.Errorf("офисы 1-2 должны быть закрыты")
	}
	if g.Gateway {
		t.Errorf("шлюза на старте нет")
	}
}

func TestOfficeConnected(t *testing.T) {
	cfg := DefaultConfig()
	o := Office{Unlocked: true, RouterTier: 1, Employees: testStaff(6)} // 4 порта
	if c := o.Connected(cfg); c != 4 {
		t.Errorf("Connected = %d, хотим 4", c)
	}
	o.RouterTier = 0
	if c := o.Connected(cfg); c != 0 {
		t.Errorf("без роутера Connected = %d, хотим 0", c)
	}
}

func TestOfficeStaffCap(t *testing.T) {
	cfg := DefaultConfig()
	o := Office{Unlocked: true}
	if cap := o.StaffCap(cfg); cap != 9 {
		t.Errorf("без босса потолок %d, хотим 9", cap)
	}
	o.Boss = "Иван Иванов"
	if cap := o.StaffCap(cfg); cap != 12 {
		t.Errorf("с боссом потолок %d, хотим 12", cap)
	}
}

func TestIncomeAcrossOffices(t *testing.T) {
	g := New(DefaultConfig())
	g.CoreLevel = 1 // core на компанию; сервер ур.3 даёт ×2.0
	g.Offices[0] = Office{Unlocked: true, PCs: 2, RouterTier: 1, Servers: []int{3},
		Employees: []Employee{{Name: "А Б", IncomePerTick: 10}, {Name: "В Г", IncomePerTick: 12}}}
	g.Offices[1] = Office{Unlocked: true, PCs: 1,
		Employees: []Employee{{Name: "Д Е", IncomePerTick: 14}}} // без роутера: серверы не достаются
	g.TickInDay = 0
	// офис 0: (10+12)×2.0 = 44; офис 1: 14 без множителя. Итого 58.
	if inc := g.IncomePerTick(); inc != 58 {
		t.Errorf("доход по офисам = %d, хотим 58", inc)
	}
	// Шлюз: подключённым ещё ×1.2 → офис 0: round(10×2.4)+round(12×2.4)=24+29=53; офис 1: 14. Итого 67.
	g.Gateway = true
	if inc := g.IncomePerTick(); inc != 67 {
		t.Errorf("доход со шлюзом = %d, хотим 67", inc)
	}
}

func TestLockedOfficeNoIncome(t *testing.T) {
	g := New(DefaultConfig())
	g.Offices[1].Employees = testStaff(3) // закрытый офис — защита от рассинхрона
	if inc := g.IncomePerTick(); inc != 0 {
		t.Errorf("закрытый офис не должен приносить доход: %d", inc)
	}
}
