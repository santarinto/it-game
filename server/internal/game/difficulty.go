package game

import "math"

// Difficulty — уровень сложности; значения совпадают с query-параметром
// difficulty WS-подключения и полем difficulty протокола.
type Difficulty string

const (
	DiffEasy     = Difficulty("easy")
	DiffNormal   = Difficulty("normal")
	DiffHard     = Difficulty("hard")
	DiffHardcore = Difficulty("hardcore")
)

// ParseDifficulty — уровень из строки; неизвестное или пустое → normal.
func ParseDifficulty(s string) Difficulty {
	switch d := Difficulty(s); d {
	case DiffEasy, DiffNormal, DiffHard, DiffHardcore:
		return d
	default:
		return DiffNormal
	}
}

// difficultySpec — коэффициенты уровня к базовому балансу.
// Числа — спека итерации 8; источник истины — docs/design/gdd.md.
type difficultySpec struct {
	PriceK     float64 // все цены покупок
	WageK      float64 // зарплаты и опекс
	StartK     float64 // стартовые деньги
	IncomeK    float64 // выработка сотрудника
	CoffeePct  int     // шанс баффа кофе (абсолютный, %)
	DebuffMult float64 // множитель жажды и голода (абсолютный)
	WinTarget  int     // цель победы, $
	EventPct   int     // шанс события в дне, % (итерация 10)
	Event2Pct  int     // шанс второго события, %
	EventK     float64 // жёсткость событий: штрафы ×K, премии ÷K
}

var difficulties = map[Difficulty]difficultySpec{
	DiffEasy:     {PriceK: 0.8, WageK: 0.8, StartK: 1.5, IncomeK: 1.15, CoffeePct: 50, DebuffMult: 0.95, WinTarget: 60000, EventPct: 60, Event2Pct: 25, EventK: 0.7},
	DiffNormal:   {PriceK: 1, WageK: 1, StartK: 1, IncomeK: 1, CoffeePct: 40, DebuffMult: 0.9, WinTarget: 250000, EventPct: 75, Event2Pct: 30, EventK: 1},
	DiffHard:     {PriceK: 1.25, WageK: 1.25, StartK: 0.9, IncomeK: 0.9, CoffeePct: 30, DebuffMult: 0.88, WinTarget: 500000, EventPct: 85, Event2Pct: 35, EventK: 1.25},
	DiffHardcore: {PriceK: 1.5, WageK: 1.5, StartK: 0.8, IncomeK: 0.8, CoffeePct: 20, DebuffMult: 0.85, WinTarget: 1000000, EventPct: 95, Event2Pct: 45, EventK: 1.5},
}

// scale — денежное значение × коэффициент: округление до целого $, минимум 1.
func scale(v int, k float64) int {
	return max(1, int(math.Round(float64(v)*k)))
}

// ConfigForDifficulty — баланс уровня поверх дефолтного.
func ConfigForDifficulty(d Difficulty) Config {
	return ApplyDifficulty(DefaultConfig(), d)
}

// ApplyDifficulty — коэффициенты уровня поверх базового конфига.
// Слайсы копируются: базовый конфиг общий для всех подключений.
func ApplyDifficulty(c Config, d Difficulty) Config {
	s := difficulties[d]
	c.Difficulty, c.WinTarget = d, s.WinTarget
	c.StartMoney = scale(c.StartMoney, s.StartK)
	c.PCPrice = scale(c.PCPrice, s.PriceK)
	c.HirePrice = scale(c.HirePrice, s.PriceK)
	c.BossPrice = scale(c.BossPrice, s.PriceK)
	c.GatewayPrice = scale(c.GatewayPrice, s.PriceK)
	c.CoolerPrice = scale(c.CoolerPrice, s.PriceK)
	c.FridgePrice = scale(c.FridgePrice, s.PriceK)
	c.CoffeeMachinePrice = scale(c.CoffeeMachinePrice, s.PriceK)
	c.RouterTiers = append([]RouterTier(nil), c.RouterTiers...)
	for i := range c.RouterTiers {
		c.RouterTiers[i].Price = scale(c.RouterTiers[i].Price, s.PriceK)
	}
	c.ServerLevels = append([]ServerLevel(nil), c.ServerLevels...)
	for i := range c.ServerLevels {
		c.ServerLevels[i].Price = scale(c.ServerLevels[i].Price, s.PriceK)
	}
	c.CoreLevels = append([]CoreLevel(nil), c.CoreLevels...)
	for i := range c.CoreLevels {
		c.CoreLevels[i].Price = scale(c.CoreLevels[i].Price, s.PriceK)
	}
	c.OfficePrices = append([]int(nil), c.OfficePrices...)
	for i := range c.OfficePrices {
		c.OfficePrices[i] = scale(c.OfficePrices[i], s.PriceK)
	}
	c.SalaryPerDay = scale(c.SalaryPerDay, s.WageK)
	c.BossSalaryPerDay = scale(c.BossSalaryPerDay, s.WageK)
	c.GatewayOpexPerDay = scale(c.GatewayOpexPerDay, s.WageK)
	c.IncomeMin = scale(c.IncomeMin, s.IncomeK)
	c.IncomeMax = scale(c.IncomeMax, s.IncomeK)
	c.CoffeeChancePct = s.CoffeePct
	c.ThirstMult, c.HungerMult = s.DebuffMult, s.DebuffMult
	// Unseen Forces: частота и жёсткость событий. Абсолютные цены/штрафы
	// скалируем здесь (VirusPrice ×K, AuditPenalty ×K, AuditReward ÷K);
	// динамические доли дедлайна умножаются на EventK в рантайме.
	c.EventChancePct, c.EventSecondPct, c.EventK = s.EventPct, s.Event2Pct, s.EventK
	c.VirusPrice = scale(c.VirusPrice, s.EventK)
	c.AuditPenalty = scale(c.AuditPenalty, s.EventK)
	c.AuditReward = scale(c.AuditReward, 1/s.EventK)
	return c
}
