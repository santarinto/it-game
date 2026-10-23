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
	// Просит уйти пораньше (ITGAME-198): отпущен — место пустует до вечера,
	// не отпущен — работает через силу.
	EffectAway       = "away"
	EffectOverworked = "overworked"
	EffectRested     = "rested" // отпустили вчера: весь день ×MotivateMult, с кликом складывается
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
	if e.away(tick) {
		return 0
	}
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
	if g.rested(e) {
		m *= g.cfg.MotivateMult
	}
	if e.OffendedUntil > tick {
		m *= g.cfg.RaiseOffendMult
	}
	if e.OverworkedUntil > tick {
		m *= g.cfg.OverworkMult
	}
	return m
}

// away — сотрудник отпущен домой и на тике tick его нет (ITGAME-198).
func (e *Employee) away(tick int) bool { return e.AwayFrom > 0 && tick >= e.AwayFrom }

// rested — «отпустили вчера»: весь сегодняшний день ×MotivateMult (ITGAME-198).
// С кликом-мотивацией складывается: иначе активный игрок, который и так
// держит клик две трети дня, награды почти не видит, и отпускать не стоит
// ни в какой час (sim, 24.10).
func (g *Game) rested(e *Employee) bool { return e.RestedDay > 0 && e.RestedDay == g.Day }

// pct переводит множитель эффекта в проценты для протокола: 0.9 → −10.
func pct(mult float64) int { return int(math.Round((mult - 1) * 100)) }

// EffectiveIncomePerTick — личная выработка сотрудника стола slot с учётом
// прибавки уровня, множителя уровня ПК (ITGAME-135) и активных эффектов (без
// сетевого множителя). Для тултипа: сервер считает, клиент показывает. Место
// «требуется замена» не производит — 0.
func (g *Game) EffectiveIncomePerTick(o *Office, slot int) int {
	if o.Workplace(slot).Dead {
		return 0
	}
	e := &o.Employees[slot]
	return int(math.Round(float64(e.IncomePerTick+g.levelBonus(e)) * raiseMult(e) * g.pcMult(o, slot) * g.effectMult(o, e, g.TickInDay)))
}

// Effects — активные эффекты сотрудника на текущем тике.
func (g *Game) Effects(o *Office, e *Employee) []Effect {
	tick := g.TickInDay
	if e.away(tick) {
		// Дома (ITGAME-198): других эффектов места не показываем, выработка и так 0.
		return []Effect{{Token: EffectAway, Percent: -100, Until: -1}}
	}
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
	if g.rested(e) {
		out = append(out, Effect{Token: EffectRested, Percent: pct(g.cfg.MotivateMult), Until: -1})
	}
	if e.OffendedUntil > tick {
		out = append(out, Effect{Token: EffectOffended, Percent: pct(g.cfg.RaiseOffendMult), Until: e.OffendedUntil})
	}
	if e.OverworkedUntil > tick {
		out = append(out, Effect{Token: EffectOverworked, Percent: pct(g.cfg.OverworkMult), Until: -1})
	}
	if e.Infected {
		out = append(out, Effect{Token: EffectVirus, Percent: pct(g.cfg.VirusMult), Until: -1})
	}
	return out
}
