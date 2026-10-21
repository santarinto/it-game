package main

import (
	"testing"

	"itdirector/internal/game"
)

func TestEventStatsLine(t *testing.T) {
	plan := func(ids ...game.EventID) map[game.EventID]int {
		m := map[game.EventID]int{}
		for _, id := range ids {
			m[id]++
		}
		return m
	}
	tests := []struct {
		name string
		recs []dayRecord
		want string
	}{
		{"пусто", nil,
			"sim events: diff=normal policy=greedy seeds=2 days=3 played=0 breakdowns=0.000 outbreaks=0.000 infected=0.000 pool=0.000 virus=0.000 deadline=0.000 audit=0.000 raise=0.000 star=0.000 second=0.0% total=0.000 max=0 ge3=0.0% capped=0.0%"},
		// Бюджет 3: в упор дошли дни 1 (2+2) и 4 (1+2), день 3 (1+1) — нет.
		{"четыре дня", []dayRecord{
			{Breakdowns: 2, Infected: 1, Outbreaks: 1, Plan: plan(game.EventVirus, game.EventRaise), Budget: 3},
			{Breakdowns: 0, Plan: plan(), Budget: 3},
			{Breakdowns: 1, Plan: plan(game.EventDeadline), Budget: 3},
			{Breakdowns: 1, Infected: 3, Plan: plan(game.EventAudit, game.EventStar), Budget: 3},
		},
			"sim events: diff=normal policy=greedy seeds=2 days=3 played=4 breakdowns=1.000 outbreaks=0.250 infected=1.000 pool=1.250 virus=0.250 deadline=0.250 audit=0.250 raise=0.250 star=0.250 second=50.0% total=2.250 max=4 ge3=50.0% capped=50.0%"},
		// Бюджет 0 — бюджета нет: упираться не во что, capped 0 при любом total.
		{"без бюджета", []dayRecord{
			{Breakdowns: 5, Plan: plan(game.EventVirus)},
			{Breakdowns: 0, Plan: plan()},
		},
			"sim events: diff=normal policy=greedy seeds=2 days=3 played=2 breakdowns=2.500 outbreaks=0.000 infected=0.000 pool=0.500 virus=0.500 deadline=0.000 audit=0.000 raise=0.000 star=0.000 second=0.0% total=3.000 max=6 ge3=50.0% capped=0.0%"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := eventStatsLine("normal", "greedy", 2, 3, tc.recs); got != tc.want {
				t.Errorf("got  %s\nwant %s", got, tc.want)
			}
		})
	}
}
