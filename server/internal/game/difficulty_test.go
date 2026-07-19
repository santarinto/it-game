package game

import "testing"

// Снапшот ключевых значений каждого уровня — числа из спеки итерации 8.
func TestConfigForDifficulty(t *testing.T) {
	cases := []struct {
		d          Difficulty
		start, pc, hire, salary, bossSalary int
		incomeMin, incomeMax, coffeePct, winTarget int
		routerT1   int
		debuff     float64
	}{
		{DiffEasy, 900, 400, 240, 200, 400, 10, 16, 50, 60000, 640, 0.95},
		{DiffNormal, 600, 500, 300, 250, 500, 9, 14, 40, 120000, 800, 0.9},
		{DiffHard, 540, 625, 375, 313, 625, 8, 13, 30, 250000, 1000, 0.88},
		{DiffHardcore, 480, 750, 450, 375, 750, 7, 11, 20, 500000, 1200, 0.85},
	}
	for _, tc := range cases {
		c := ConfigForDifficulty(tc.d)
		if c.Difficulty != tc.d || c.StartMoney != tc.start || c.PCPrice != tc.pc ||
			c.HirePrice != tc.hire || c.SalaryPerDay != tc.salary ||
			c.BossSalaryPerDay != tc.bossSalary || c.IncomeMin != tc.incomeMin ||
			c.IncomeMax != tc.incomeMax || c.CoffeeChancePct != tc.coffeePct ||
			c.WinTarget != tc.winTarget || c.RouterTiers[0].Price != tc.routerT1 ||
			c.ThirstMult != tc.debuff || c.HungerMult != tc.debuff {
			t.Errorf("%s: %+v", tc.d, c)
		}
	}
}

// Инвариант спеки: первая покупка (найм) возможна на любом уровне.
func TestStartMoneyCoversHire(t *testing.T) {
	for _, d := range []Difficulty{DiffEasy, DiffNormal, DiffHard, DiffHardcore} {
		c := ConfigForDifficulty(d)
		if c.StartMoney < c.HirePrice {
			t.Errorf("%s: StartMoney %d < HirePrice %d", d, c.StartMoney, c.HirePrice)
		}
	}
}

// Норма — ровно базовый баланс (коэффициенты 1.0 не искажают числа).
func TestNormalEqualsDefault(t *testing.T) {
	base, norm := DefaultConfig(), ConfigForDifficulty(DiffNormal)
	if norm.PCPrice != base.PCPrice || norm.StartMoney != base.StartMoney ||
		norm.CoreLevels[4].Price != base.CoreLevels[4].Price {
		t.Errorf("normal != default: %+v", norm)
	}
}

func TestParseDifficulty(t *testing.T) {
	if ParseDifficulty("hardcore") != DiffHardcore || ParseDifficulty("easy") != DiffEasy {
		t.Error("известные уровни должны парситься")
	}
	if ParseDifficulty("") != DiffNormal || ParseDifficulty("мусор") != DiffNormal {
		t.Error("пустое/мусор → normal")
	}
}

// ApplyDifficulty не мутирует слайсы исходного конфига (общий Handler.Config).
func TestApplyDifficultyCopiesSlices(t *testing.T) {
	base := DefaultConfig()
	before := base.RouterTiers[0].Price
	_ = ApplyDifficulty(base, DiffHardcore)
	if base.RouterTiers[0].Price != before {
		t.Errorf("ApplyDifficulty мутировал базовый конфиг: %d", base.RouterTiers[0].Price)
	}
}
