package game

import "testing"

// богатая игра: деньги не мешают, офис 0 с роутером т3 (12 портов).
func netGame() *Game {
	g := NewWithSeed(DefaultConfig(), 1, 2)
	g.Money = 1_000_000
	g.Offices[0].RouterTier = 3
	return g
}

func staff(n int) []Employee {
	s := make([]Employee, n)
	for i := range s {
		s[i] = Employee{Name: "Тест Тестов", IncomePerTick: 10}
	}
	return s
}

func TestNetworkNoCore(t *testing.T) {
	g := netGame()
	g.Offices[0].Employees = staff(4)
	g.Offices[0].Servers = []int{3}
	n := g.Network()
	// Без core серверы недостижимы: все на ×1.0, мест core занято 0.
	for i, m := range n.Mults[0] {
		if m != 1.0 || n.ServerSlot[0][i] != 0 || n.CoreLinked[0][i] {
			t.Fatalf("работник %d без core: mult=%v slot=%d linked=%v", i, m, n.ServerSlot[0][i], n.CoreLinked[0][i])
		}
	}
	if n.CoreUsed != 0 {
		t.Fatalf("CoreUsed=%d, хотим 0", n.CoreUsed)
	}
}

func TestNetworkServersByFours(t *testing.T) {
	g := netGame()
	g.Offices[0].Employees = staff(10)
	g.Offices[0].Servers = []int{1, 3} // ур.1 ×1.2 и ур.3 ×2.0
	g.CoreLevel = 2                    // 16 мест — хватает всем десяти
	n := g.Network()
	want := []struct {
		mult float64
		slot int
	}{
		{1.2, 1}, {1.2, 1}, {1.2, 1}, {1.2, 1}, // сервер 1
		{2.0, 2}, {2.0, 2}, {2.0, 2}, {2.0, 2}, // сервер 2
		{1.0, 0}, {1.0, 0}, // до core дошли, серверов не хватило
	}
	for i, w := range want {
		if n.Mults[0][i] != w.mult || n.ServerSlot[0][i] != w.slot || !n.CoreLinked[0][i] {
			t.Fatalf("работник %d: mult=%v slot=%d linked=%v, хотим %+v",
				i, n.Mults[0][i], n.ServerSlot[0][i], n.CoreLinked[0][i], w)
		}
	}
	if n.CoreUsed != 10 {
		t.Fatalf("CoreUsed=%d, хотим 10", n.CoreUsed)
	}
}

func TestNetworkCoreCapacityFirstN(t *testing.T) {
	g := netGame()
	g.Offices[0].Employees = staff(6)
	g.Offices[1].Unlocked = true
	g.Offices[1].RouterTier = 3
	g.Offices[1].Employees = staff(6)
	g.CoreLevel = 1 // 8 мест на компанию
	n := g.Network()
	// Первые N по порядку офисов: офис 0 забирает 6, офису 1 остаётся 2.
	for i := 0; i < 6; i++ {
		if !n.CoreLinked[0][i] {
			t.Fatalf("офис 0 работник %d должен быть в core", i)
		}
	}
	for i, want := range []bool{true, true, false, false, false, false} {
		if n.CoreLinked[1][i] != want {
			t.Fatalf("офис 1 работник %d: linked=%v, хотим %v", i, n.CoreLinked[1][i], want)
		}
	}
	if n.CoreUsed != 8 {
		t.Fatalf("CoreUsed=%d, хотим 8", n.CoreUsed)
	}
}

func TestNetworkGatewayOnlyServed(t *testing.T) {
	g := netGame()
	g.Offices[0].Employees = staff(5)
	g.Offices[0].Servers = []int{1} // обслуживает первых четверых
	g.CoreLevel = 1
	g.Gateway = true
	n := g.Network()
	if want := 1.2 * 1.2; n.Mults[0][0] != want { // сервер ×1.2 × шлюз ×1.2
		t.Fatalf("с сервером и шлюзом: %v, хотим %v", n.Mults[0][0], want)
	}
	// Пятый в core, но без сервера — шлюз его НЕ баффает.
	if n.Mults[0][4] != 1.0 {
		t.Fatalf("без сервера шлюз не действует: %v", n.Mults[0][4])
	}
}

func TestNetworkCoreFinalMult(t *testing.T) {
	g := netGame()
	g.Offices[0].Employees = staff(4)
	g.Offices[0].Servers = []int{2} // ×1.5
	g.CoreLevel = 5                 // финальный: ×1.1 обслуженным
	n := g.Network()
	// want считаем из тех же float64-значений конфига, что и Network():
	// компилируемая константа 1.5*1.1 округляется иначе, чем произведение
	// двух уже округлённых float64-переменных (двойное округление IEEE-754).
	cfg := g.Config()
	if want := cfg.ServerLevels[1].Mult * cfg.CoreLevels[4].Mult; n.Mults[0][0] != want {
		t.Fatalf("core ур.5: %v, хотим %v", n.Mults[0][0], want)
	}
}

func TestNetworkLockedOfficeIgnored(t *testing.T) {
	g := netGame()
	g.Offices[0].Employees = staff(2)
	g.Offices[0].Servers = []int{1}
	// Закрытый офис с роутером не ест ёмкость core (защита от рассинхрона).
	g.Offices[1].RouterTier = 3
	g.Offices[1].Employees = staff(3)
	g.CoreLevel = 1
	n := g.Network()
	if n.CoreUsed != 2 {
		t.Fatalf("CoreUsed=%d, хотим 2 (закрытый офис не считается)", n.CoreUsed)
	}
	for i := range n.Mults[1] {
		if n.Mults[1][i] != 1.0 || n.CoreLinked[1][i] {
			t.Fatalf("работник закрытого офиса подключён: %v", n.CoreLinked[1])
		}
	}
}
