package game

import (
	"errors"
	"math"
	"reflect"
	"testing"
)

// Дробный остаток компании (ITGAME-196, решение владельца 21.10): доход тика
// складывается точно, в деньги идут целые доллары, дробь переходит на
// следующий тик. Числа: день 54 тика, продуктивных 48; hiredGame — один
// сотрудник $10/тик без быта, поломок и событий, рынка на нормале нет.

// carryGame — hiredGame с повышением pct% у единственного сотрудника; опыт
// не копится — прибавка уровня на второй день не мешает арифметике.
func carryGame(t *testing.T, pct int) *Game {
	t.Helper()
	g := hiredGame(t)
	g.cfg.XPPerTick = 0
	g.Offices[0].Employees[0].RaisePct = pct
	return g
}

// creditedTicks — прокрутить n продуктивных тиков (через ночь — NextDay) и
// вернуть зачисленный за них доход.
func creditedTicks(t *testing.T, g *Game, n int) int {
	t.Helper()
	got := 0
	for n > 0 {
		if g.Phase == PhaseDayReport {
			if err := g.NextDay(); err != nil {
				t.Fatal(err)
			}
		}
		if g.Phase != PhaseRunning {
			t.Fatalf("фаза %s, партия не идёт", g.Phase)
		}
		if !g.cfg.isLunchTick(g.TickInDay) {
			n--
		}
		before := g.DayIncome
		g.Tick()
		got += g.DayIncome - before
	}
	return got
}

// +2% у сотрудника $10/тик — это $10.2 за тик: за 50 тиков $510, а не $500
// (раньше округление на сотрудника съедало прибавку целиком).
func TestIncomeCarryRaiseTwoPercent(t *testing.T) {
	g := carryGame(t, 2)
	if got := creditedTicks(t, g, 50); got != 510 {
		t.Errorf("за 50 тиков по $10.2 зачислено $%d, хотим $510", got)
	}
}

// Зачислено — целая часть точной суммы: отстаёт от неё меньше чем на $1.
func TestIncomeCarryWithinDollar(t *testing.T) {
	for _, pct := range []int{1, 2, 3} {
		for _, n := range []int{1, 7, 48, 50, 97} {
			g := carryGame(t, pct)
			exact := float64(n) * 10 * (1 + float64(pct)/100)
			got := creditedTicks(t, g, n)
			if d := exact - float64(got); d < -1e-9 || d >= 1 {
				t.Errorf("+%d%%, %d тиков: зачислено $%d, точно $%.2f", pct, n, got, exact)
			}
		}
	}
}

// Отказ в повышении −5% виден в деньгах: $9.5 за тик — $456 за день, не $480.
func TestIncomeCarryOffendedFivePercent(t *testing.T) {
	g := hiredGame(t)
	g.Offices[0].Employees[0].OffendedUntil = g.cfg.DayTicks()
	if got := creditedTicks(t, g, 48); got != 456 {
		t.Errorf("день с обидой: зачислено $%d, хотим $456 (48 × $9.5)", got)
	}
}

// Остаток всегда в [0, 1), и ничего не теряется: зачисленное плюс остаток —
// точная сумма всех тиков. Пёстрый штат: разная выработка, повышения,
// уровень ПК, обида, рынок дня.
func TestIncomeCarryInvariant(t *testing.T) {
	g := hiredGame(t)
	g.Money = 100000
	g.Offices[0].PCs = 4
	g.Offices[0].Employees = []Employee{
		{Name: "А", IncomePerTick: 7, RaisePct: 3},
		{Name: "Б", IncomePerTick: 11, RaisePct: 1},
		{Name: "В", IncomePerTick: 13, OffendedUntil: 30},
		{Name: "Г", IncomePerTick: 9, RaisePct: 2},
	}
	g.Offices[0].syncWorkplaces()
	g.Offices[0].Workplaces[1].Level = 1
	g.MarketToday = 5
	exact, credited := 0.0, 0
	for day := 0; day < 3; day++ {
		if day > 0 {
			if err := g.NextDay(); err != nil {
				t.Fatal(err)
			}
		}
		for g.Phase == PhaseRunning {
			x, _, _ := g.incomeAtTickDetail(g.TickInDay)
			exact += float64(x)
			before := g.DayIncome
			g.Tick()
			credited += g.DayIncome - before
			if c := g.IncomeCarry; c < 0 || c >= 1 {
				t.Fatalf("день %d тик %d: остаток %v вне [0, 1)", g.Day, g.TickInDay, c)
			}
		}
	}
	if d := float64(credited) + g.IncomeCarry - exact; math.Abs(d) > 1e-6 {
		t.Errorf("зачислено $%d + остаток %.6f ≠ точная сумма %.6f", credited, g.IncomeCarry, exact)
	}
	if exact == math.Trunc(exact) {
		t.Fatalf("точная сумма %.2f целая — тест ничего не проверяет", exact)
	}
}

// Превью и прогнозы читают остаток, но не пишут его: сколько их ни зови,
// сейв до и после один и тот же.
func TestIncomePreviewsKeepCarry(t *testing.T) {
	g := carryGame(t, 3)
	creditedTicks(t, g, 7) // 7 × $10.3 = $72.1: остаток 0.1
	if g.IncomeCarry <= 0 {
		t.Fatalf("остаток %v, хотим дробь — тест ничего не проверяет", g.IncomeCarry)
	}
	g.Money = -50 // прогноз банкротства считается только в минусе
	before := g.Export()
	for range 3 {
		g.IncomePerTick()
		g.incomeAtTick(g.TickInDay)
		g.ForecastEndOfDay()
		g.DayProfit()
		g.BankruptInDays()
		g.EffectiveIncomePerTick(&g.Offices[0], 0)
		g.baseIncomePerTick()
		g.deadlineGoalFor()
	}
	if after := g.Export(); !reflect.DeepEqual(before, after) {
		t.Errorf("превью поменяли игру: остаток %v → %v", before.IncomeCarry, after.IncomeCarry)
	}
}

// Прогноз конца дня считает тем же остатком, что и зачисление: вечер
// сходится с прогнозом до доллара и при дробной выработке.
func TestForecastEndOfDayCountsCarry(t *testing.T) {
	g := carryGame(t, 2)
	creditedTicks(t, g, 5)
	forecast := g.ForecastEndOfDay()
	finishDay(t, g)
	if g.Money != forecast {
		t.Errorf("прогноз %d, вечер %d", forecast, g.Money)
	}
}

// Остаток в сейве: восстановленная партия зачисляет то же, что и живая.
func TestIncomeCarrySurvivesSave(t *testing.T) {
	g := carryGame(t, 3)
	creditedTicks(t, g, 7)
	r := saveRoundtrip(t, g)
	if r.IncomeCarry != g.IncomeCarry {
		t.Fatalf("остаток после restore %v, хотим %v", r.IncomeCarry, g.IncomeCarry)
	}
	for i := range 30 {
		g.Tick()
		r.Tick()
		if r.Money != g.Money || r.IncomeCarry != g.IncomeCarry {
			t.Fatalf("тик %d: восстановленная $%d/%v, живая $%d/%v", i, r.Money, r.IncomeCarry, g.Money, g.IncomeCarry)
		}
	}
}

// Остаток вне [0, 1) — испорченный сейв: это дробь реальных денег.
func TestRestoreRejectsBadIncomeCarry(t *testing.T) {
	for _, c := range []float64{-0.1, 1, 2.5, math.NaN(), math.Inf(1)} {
		s := hiredGame(t).Export()
		s.IncomeCarry = c
		if _, err := Restore(s); !errors.Is(err, ErrBadSave) {
			t.Errorf("остаток %v: Restore = %v, хотим ErrBadSave", c, err)
		}
	}
}

// Офлайн-догон зачисляет с тем же остатком: хвост дня — как живые тики,
// полные дни — целая часть точной суммы.
func TestAdvanceOfflineUsesCarry(t *testing.T) {
	g := carryGame(t, 2)
	creditedTicks(t, g, 3) // остаток 0.6
	live := saveRoundtrip(t, g)
	g.AdvanceOffline(20)
	for range 20 {
		live.Tick()
	}
	if g.Money != live.Money || math.Abs(g.IncomeCarry-live.IncomeCarry) > 1e-9 {
		t.Errorf("офлайн $%d/%v, вживую $%d/%v", g.Money, g.IncomeCarry, live.Money, live.IncomeCarry)
	}

	g = carryGame(t, 2)
	s := g.AdvanceOffline(3*g.cfg.DayTicks() + 10)
	// 3 дня по 48 тиков и 10 утренних: 154 × $10.2 = $1570.8.
	if s.Income != 1570 {
		t.Errorf("офлайн за 154 тика по $10.2: $%d, хотим $1570", s.Income)
	}
	if math.Abs(g.IncomeCarry-0.8) > 1e-6 {
		t.Errorf("остаток после офлайна %v, хотим 0.8", g.IncomeCarry)
	}
}
