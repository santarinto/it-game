package main

// Статистика случайных событий за сыгранный день (--event-stats, ITGAME-196):
// постоянный инструмент «до/после» для баланса поломок и событий дня.
// Ничего из этого не пишется в сейв — считает только sim.

import (
	"fmt"
	"math/rand/v2"

	"itdirector/internal/game"
)

// eventKinds — порядок видов событий пула в строке статистики.
var eventKinds = []game.EventID{game.EventVirus, game.EventDeadline, game.EventAudit, game.EventRaise, game.EventStar}

// dayRecord — один сыгранный день (есть DayReport; недоигранный день победы
// не считается).
type dayRecord struct {
	Breakdowns int                  // DayReport.Incidents — поломки ПК
	Infected   int                  // DayReport.VirusPCs — заражённых ПК на конец дня
	Outbreaks  int                  // вспышки вируса, заразившие ≥1 ПК (не «отбит»)
	Plan       map[game.EventID]int // план g.DayEvents сразу после NextDay
}

func (d dayRecord) pool() int {
	n := 0
	for _, c := range d.Plan {
		n += c
	}
	return n
}

// eventStatsLine — строка «sim events: …» по записям дней одной политики:
// средние на сыгранный день (3 знака), доли в процентах (1 знак).
func eventStatsLine(diff, policy string, seeds, days int, recs []dayRecord) string {
	n := len(recs)
	var bd, inf, out, pool, second, maxTotal, ge3 int
	kind := map[game.EventID]int{}
	for _, r := range recs {
		p := r.pool()
		t := r.Breakdowns + p
		bd += r.Breakdowns
		inf += r.Infected
		out += r.Outbreaks
		pool += p
		for id, c := range r.Plan {
			kind[id] += c
		}
		if p == 2 {
			second++
		}
		maxTotal = max(maxTotal, t)
		if t >= 3 {
			ge3++
		}
	}
	per := func(a int) float64 {
		if n == 0 {
			return 0
		}
		return float64(a) / float64(n)
	}
	return fmt.Sprintf("sim events: diff=%s policy=%s seeds=%d days=%d played=%d breakdowns=%.3f outbreaks=%.3f infected=%.3f pool=%.3f virus=%.3f deadline=%.3f audit=%.3f raise=%.3f star=%.3f second=%.1f%% total=%.3f max=%d ge3=%.1f%%",
		diff, policy, seeds, days, n, per(bd), per(out), per(inf), per(pool),
		per(kind[game.EventVirus]), per(kind[game.EventDeadline]), per(kind[game.EventAudit]),
		per(kind[game.EventRaise]), per(kind[game.EventStar]),
		pct(second, n), per(bd+pool), maxTotal, pct(ge3, n))
}

// dayPlan — план событий дня по видам, снятый после NextDay.
func dayPlan(g *game.Game) map[game.EventID]int {
	m := make(map[game.EventID]int, len(g.DayEvents))
	for _, ev := range g.DayEvents {
		m[ev.ID]++
	}
	return m
}

// answerRaise — ответ sim на карточку «Просит повышения» (--answer-raise):
// accept — опция 0, decline — опция 1; пусто — sim карточку не трогает.
func answerRaise(g *game.Game, mode string) {
	if mode == "" || g.ActiveEvent == nil || g.ActiveEvent.ID != game.EventRaise {
		return
	}
	opt := 0
	if mode == "decline" {
		opt = 1
	}
	_ = g.ChooseEvent(opt)
}

// expandPolicy — greedy, который покупает следующий офис, когда все
// открытые набраны до StaffLimit (остальные политики офисы не покупают).
func expandPolicy(g *game.Game, rng *rand.Rand, hour int) {
	cfg := g.Config()
	full := true
	next := -1
	for i := range g.Offices {
		o := &g.Offices[i]
		if !o.Unlocked {
			if next < 0 {
				next = i
			}
			continue
		}
		if len(o.Employees) < cfg.StaffLimit {
			full = false
		}
	}
	if full && next > 0 && affordable(g, cfg.OfficePrices[next-1]) {
		buy(g, game.CmdBuyOffice, next, 0)
	}
	greedyPolicy(g, rng, hour)
}
