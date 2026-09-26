package game

import (
	"math"
	"testing"
)

// Итерация 14: развилка «нанять vs сеть» должна быть живой — на любом
// участке заполнения офиса окупаемости сопоставимы, и лидер меняется.
// Формулы по конфигу (без симуляции): чистый доход места = средняя
// выработка × продуктивные тики − зарплата; сеть на первую четвёрку
// даёт +первый множитель сервера всем подключённым.

// netEntryCost — вход в сеть на четвёрку: роутер т1 + core ур.1 + стойка ур.1.
func netEntryCost(c Config) int {
	return c.RouterTiers[0].Price + c.CoreLevels[0].Price + c.ServerLevels[0].Price
}

// hirePayback — окупаемость найма k-го места офиса (k = 1-based номер
// покупаемого места; уже куплено k−1).
func hirePayback(c Config, k int) float64 {
	pc := math.Ceil(float64(c.PCPrice)*math.Pow(c.PCPriceGrowth, float64(k-1))/5) * 5
	cost := pc + float64(c.HirePrice)
	netDay := avgIncome(c)*productiveTicks(c) - float64(c.SalaryPerDay)
	return cost / netDay
}

// netPayback — окупаемость сети на k уже занятых местах (множитель ур.1).
func netPayback(c Config, k int) float64 {
	gain := (c.ServerLevels[0].Mult - 1) * avgIncome(c) * productiveTicks(c) * float64(min(k, c.RouterTiers[0].Ports))
	return float64(netEntryCost(c)) / gain
}

func avgIncome(c Config) float64 {
	return float64(c.IncomeMin+c.IncomeMax) / 2
}

func productiveTicks(c Config) float64 {
	return float64(c.DayTicks() - (c.LunchEnd-c.LunchStart)*c.TicksPerHour)
}

// TestPaybackRivalry — инвариант ITGAME-5: в середине офиса (4..8 занятых)
// окупаемости найма и сети одного порядка (ratio ≤ 2.5), и обе стратегии
// хоть где-то лидируют.
func TestPaybackRivalry(t *testing.T) {
	c := DefaultConfig()
	netBetter, hireBetter := false, false
	for k := 4; k <= 8; k++ {
		hire := hirePayback(c, k+1) // найм (k+1)-го места
		net := netPayback(c, k)     // сеть на уже занятых k
		ratio := net / hire
		if ratio > 2.5 || ratio < 0.4 {
			t.Errorf("k=%d: окупаемости не сопоставимы — найм %.1fд vs сеть %.1fд (ratio %.2f)", k, hire, net, ratio)
		}
		if net < hire {
			netBetter = true
		} else {
			hireBetter = true
		}
	}
	if !netBetter || !hireBetter {
		t.Errorf("развилка мертва: сеть лучше хоть где-то=%v, найм лучше хоть где-то=%v", netBetter, hireBetter)
	}
}

// TestNextPCPriceGrows — цена ПК растёт с каждым купленным, стартовая
// не изменилась.
func TestNextPCPriceGrows(t *testing.T) {
	g := New(DefaultConfig())
	if p := g.NextPCPrice(0); p != 575 {
		t.Errorf("второй ПК = %d, хотим 575 (500×1.15)", p)
	}
	g.Offices[0].PCs = 5
	if p := g.NextPCPrice(0); p != 1010 {
		t.Errorf("шестой ПК = %d, хотим 1010", p)
	}
	// Полный офис — кнопки гасятся нулём.
	g.Offices[0].PCs = g.Config().OfficeSlots
	if p := g.NextPCPrice(0); p != 0 {
		t.Errorf("полный офис nextPC = %d, хотим 0", p)
	}
}

// TestBuyPCPaysDynamicPrice — списывается растущая цена, не базовая.
func TestBuyPCPaysDynamicPrice(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 575
	if err := g.BuyPC(0); err != nil {
		t.Fatalf("второй ПК за $575: %v", err)
	}
	if g.Money != 0 || g.Offices[0].PCs != 2 {
		t.Errorf("Money=%d PCs=%d, хотим 0 и 2", g.Money, g.Offices[0].PCs)
	}
	g.Money = 600
	if err := g.BuyPC(0); err != ErrNotEnoughMoney {
		t.Errorf("третий ПК за $660 при $600: %v, хотим %v", err, ErrNotEnoughMoney)
	}
}

// TestLateGameTargets — цели сложности растянуты под потолок экономики
// (итерация 14): даже чистый потолок не закрывает цель быстрее ~4 дней,
// плюс дни сборки билда — итоговый прогон 6+ дней (qa ITGAME-5).
func TestLateGameTargets(t *testing.T) {
	c := DefaultConfig()
	// Потолок компании: 36 мест × средняя выработка × полный множитель.
	ceiling := 36 * avgIncome(c) * productiveTicks(c) *
		c.ServerLevels[len(c.ServerLevels)-1].Mult * c.GatewayBonus * c.CoreLevels[len(c.CoreLevels)-1].Mult
	days := float64(c.WinTarget) / ceiling
	if days < 3.8 {
		t.Errorf("цель нормы %.0f закрывается за %.1f дней потолка — слишком быстро (ревью п.2.3)", float64(c.WinTarget), days)
	}
	for _, d := range []Difficulty{DiffHard, DiffHardcore} {
		if ConfigForDifficulty(d).WinTarget <= c.WinTarget {
			t.Errorf("%s: цель должна расти с уровнем", d)
		}
	}
}
