package game

import "math"

// Токены эффектов — значения совпадают с полем token протокола.
const (
	EffectThirst    = "thirst"
	EffectHunger    = "hunger"
	EffectCoffee    = "coffee"
	EffectMotivated = "motivated"
	EffectOffended  = "offended" // отказ в повышении (итерация 10)
	EffectVirus     = "virus"    // заражённое место (ITGAME-103), до чистки
)

// Effect — активный эффект сотрудника (для снапшота и тултипа).
type Effect struct {
	Token   string
	Percent int // −10 / +15
	Until   int // тик дня конца действия; −1 — до конца дня
}

// effectMult — множитель эффектов сотрудника офиса на данном тике.
func (g *Game) effectMult(o *Office, e *Employee, tick int) float64 {
	m := g.dayEffectMult(o, e, tick)
	if e.Infected {
		m *= g.cfg.VirusMult
	}
	return m
}

// dayEffectMult — множитель эффектов без вируса: доход и упущенное из-за
// вируса считаются от одной базы (incomeAtTickDetail).
func (g *Game) dayEffectMult(o *Office, e *Employee, tick int) float64 {
	m := 1.0
	if !o.Cooler && tick >= g.cfg.thirstTick() {
		m *= g.cfg.ThirstMult
	}
	if !o.Fridge && tick >= g.cfg.lunchEndTick() {
		m *= g.cfg.HungerMult
	}
	if e.CoffeeUntil > tick {
		m *= g.cfg.CoffeeMult
	}
	if e.MotivatedUntil > tick {
		m *= g.cfg.MotivateMult
	}
	if e.OffendedUntil > tick {
		m *= g.cfg.RaiseOffendMult
	}
	return m
}

// pct переводит множитель эффекта в проценты для протокола: 0.9 → −10.
func pct(mult float64) int { return int(math.Round((mult - 1) * 100)) }

// EffectiveIncomePerTick — личная выработка с учётом прибавки уровня и
// активных эффектов (без сетевого множителя). Для тултипа: сервер
// считает, клиент показывает.
func (g *Game) EffectiveIncomePerTick(o *Office, e *Employee) int {
	return int(math.Round(float64(e.IncomePerTick+g.levelBonus(e)) * g.effectMult(o, e, g.TickInDay)))
}

// Effects — активные эффекты сотрудника на текущем тике.
func (g *Game) Effects(o *Office, e *Employee) []Effect {
	tick := g.TickInDay
	var out []Effect
	if !o.Cooler && tick >= g.cfg.thirstTick() {
		out = append(out, Effect{Token: EffectThirst, Percent: pct(g.cfg.ThirstMult), Until: -1})
	}
	if !o.Fridge && tick >= g.cfg.lunchEndTick() {
		out = append(out, Effect{Token: EffectHunger, Percent: pct(g.cfg.HungerMult), Until: -1})
	}
	if e.CoffeeUntil > tick {
		out = append(out, Effect{Token: EffectCoffee, Percent: pct(g.cfg.CoffeeMult), Until: e.CoffeeUntil})
	}
	if e.MotivatedUntil > tick {
		out = append(out, Effect{Token: EffectMotivated, Percent: pct(g.cfg.MotivateMult), Until: e.MotivatedUntil})
	}
	if e.OffendedUntil > tick {
		out = append(out, Effect{Token: EffectOffended, Percent: pct(g.cfg.RaiseOffendMult), Until: e.OffendedUntil})
	}
	if e.Infected {
		out = append(out, Effect{Token: EffectVirus, Percent: pct(g.cfg.VirusMult), Until: -1})
	}
	return out
}
