package game

import "testing"

func TestDayTicksDerived(t *testing.T) {
	cfg := DefaultConfig()
	if got := cfg.DayTicks(); got != 54 {
		t.Errorf("DayTicks() = %d, хотим 54 ((19-10)×6)", got)
	}
}

func TestClock(t *testing.T) {
	tests := []struct {
		tick int
		want string
	}{
		{0, "10:00"},
		{1, "10:10"},
		{23, "13:50"},
		{24, "14:00"}, // начало обеда
		{29, "14:50"}, // последний тик обеда
		{30, "15:00"},
		{53, "18:50"}, // последний тик дня
		{54, "19:00"}, // конец дня (фаза отчёта)
	}
	g := New(DefaultConfig())
	for _, tt := range tests {
		g.TickInDay = tt.tick
		if got := g.Clock(); got != tt.want {
			t.Errorf("Clock() на тике %d = %q, хотим %q", tt.tick, got, tt.want)
		}
	}
}

func TestIsLunch(t *testing.T) {
	g := New(DefaultConfig())
	for tick, want := range map[int]bool{0: false, 23: false, 24: true, 29: true, 30: false, 53: false} {
		g.TickInDay = tick
		if got := g.IsLunch(); got != want {
			t.Errorf("IsLunch() на тике %d = %v, хотим %v", tick, got, want)
		}
	}
}

func TestLunchZeroIncome(t *testing.T) {
	g := New(DefaultConfig())
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = testStaff(1)
	g.TickInDay = 23
	if inc := g.IncomePerTick(); inc == 0 {
		t.Error("до обеда доход должен быть > 0")
	}
	g.TickInDay = 24
	if inc := g.IncomePerTick(); inc != 0 {
		t.Errorf("в обед доход = %d, хотим 0", inc)
	}
	g.TickInDay = 30
	if inc := g.IncomePerTick(); inc == 0 {
		t.Error("после обеда доход должен быть > 0")
	}
}
