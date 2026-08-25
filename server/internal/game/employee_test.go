package game

import (
	"strings"
	"testing"
)

// testStaff — n сотрудников с выработкой ровно $10/тик:
// сохраняет арифметику старых тестов, писавших Employees = n.
func testStaff(n int) []Employee {
	s := make([]Employee, n)
	for i := range s {
		s[i] = Employee{Name: "Тест Тестов", IncomePerTick: 10}
	}
	return s
}

func TestHireRollsEmployee(t *testing.T) {
	g := NewWithSeed(DefaultConfig(), 1, 2)
	g.Money = 10000
	g.Offices[0].PCs = 9
	for i := 0; i < 9; i++ {
		if err := g.Hire(0); err != nil {
			t.Fatalf("найм %d: %v", i+1, err)
		}
	}
	for i, e := range g.Offices[0].Employees {
		if e.IncomePerTick < 9 || e.IncomePerTick > 14 {
			t.Errorf("сотрудник %d: выработка %d вне [9..14]", i, e.IncomePerTick)
		}
		if !strings.Contains(e.Name, " ") || len(e.Name) < 5 {
			t.Errorf("сотрудник %d: подозрительное имя %q", i, e.Name)
		}
	}
}

func TestHireDeterministicWithSeed(t *testing.T) {
	roll := func() []Employee {
		g := NewWithSeed(DefaultConfig(), 42, 42)
		g.Money = 10000
		g.Offices[0].PCs = 3
		for i := 0; i < 3; i++ {
			if err := g.Hire(0); err != nil {
				t.Fatal(err)
			}
		}
		return g.Offices[0].Employees
	}
	a, b := roll(), roll()
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("один сид — разные роллы: %+v vs %+v", a[i], b[i])
		}
	}
}

func TestIncomeSumsPersonalRates(t *testing.T) {
	g := New(DefaultConfig())
	g.Offices[0].PCs = 3
	g.Offices[0].Employees = []Employee{
		{Name: "А Б", IncomePerTick: 9},
		{Name: "В Г", IncomePerTick: 14},
		{Name: "Д Е", IncomePerTick: 11},
	}
	// Без сети: сумма личных выработок.
	if inc := g.IncomePerTick(); inc != 34 {
		t.Errorf("доход без сети = %d, хотим 34", inc)
	}
	// Роутер (4 порта) + core + сервер ур.3: множитель ×2.2 всем троим.
	g.Offices[0].RouterTier = 1
	g.Offices[0].Servers = []int{3}
	g.CoreLevel = 1
	if inc := g.IncomePerTick(); inc != 75 {
		t.Errorf("доход с сетью ×2.2 = %d, хотим 75", inc)
	}
}

func TestStaffLimit(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 100000
	g.Offices[0].PCs = 9
	g.Offices[0].Employees = testStaff(9)
	if err := g.Hire(0); err != ErrStaffLimit {
		t.Errorf("найм 10-го: err = %v, хотим %v", err, ErrStaffLimit)
	}
	if err := g.BuyPC(0); err != ErrStaffLimit {
		t.Errorf("10-й ПК: err = %v, хотим %v", err, ErrStaffLimit)
	}
}

func TestForecastEndOfDay(t *testing.T) {
	cfg := DefaultConfig()
	g := New(cfg)
	g.Money = 1000
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = []Employee{{Name: "А Б", IncomePerTick: 10}}
	g.TickInDay = 0
	// 12×10 + 12×9 + 24×8 = 420 за день без устройств.
	if f := g.ForecastEndOfDay(); f != 1000+420-250 {
		t.Errorf("прогноз с утра = %d, хотим 1170", f)
	}
	g.TickInDay = 30
	if f := g.ForecastEndOfDay(); f != 1000+24*8-250 {
		t.Errorf("прогноз после обеда = %d, хотим 942", f)
	}
	g.TickInDay = 24
	if f := g.ForecastEndOfDay(); f != 1000+24*8-250 {
		t.Errorf("прогноз в обед = %d, хотим 942", f)
	}
}

func TestRestartClearsStaff(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 0
	g.Offices[0].PCs = 3
	g.Offices[0].Employees = testStaff(3)
	for i := 0; i < dayTestConfig().DayTicks(); i++ {
		g.Tick()
	}
	if g.Phase != PhaseGameOver {
		t.Fatalf("подготовка: ждали game_over, Phase=%q", g.Phase)
	}
	if err := g.Restart(); err != nil {
		t.Fatal(err)
	}
	if len(g.Offices[0].Employees) != 0 {
		t.Errorf("после Restart сотрудников %d, хотим 0", len(g.Offices[0].Employees))
	}
}
