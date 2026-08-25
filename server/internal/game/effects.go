package game

import "math"

// Токены эффектов — значения совпадают с полем token протокола.
const (
	EffectThirst    = "thirst"
	EffectHunger    = "hunger"
	EffectCoffee    = "coffee"
	EffectMotivated = "motivated"
)

// Effect — активный эффект сотрудника (для снапшота и тултипа).
type Effect struct {
	Token   string
	Percent int // −10 / +15
	Until   int // тик дня конца действия; −1 — до конца дня
}

// effectMult — множитель эффектов сотрудника офиса на данном тике.
func (g *Game) effectMult(o *Office, e *Employee, tick int) float64 {
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
	return m
}

// pct переводит множитель эффекта в проценты для протокола: 0.9 → −10.
func pct(mult float64) int { return int(math.Round((mult - 1) * 100)) }

// EffectiveIncomePerTick — личная выработка с учётом активных эффектов
// (без сетевого множителя). Для тултипа: сервер считает, клиент показывает.
func (g *Game) EffectiveIncomePerTick(o *Office, e *Employee) int {
	return int(math.Round(float64(e.IncomePerTick) * g.effectMult(o, e, g.TickInDay)))
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
	return out
}
