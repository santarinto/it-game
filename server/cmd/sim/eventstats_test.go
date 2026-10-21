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
			"sim events: diff=normal policy=greedy seeds=2 days=3 played=0 breakdowns=0.000 outbreaks=0.000 infected=0.000 pool=0.000 virus=0.000 deadline=0.000 audit=0.000 raise=0.000 star=0.000 second=0.0% total=0.000 max=0 ge3=0.0%"},
		{"четыре дня", []dayRecord{
			{Breakdowns: 2, Infected: 1, Outbreaks: 1, Plan: plan(game.EventVirus, game.EventRaise)},
			{Breakdowns: 0, Plan: plan()},
			{Breakdowns: 1, Plan: plan(game.EventDeadline)},
			{Breakdowns: 1, Infected: 3, Plan: plan(game.EventAudit, game.EventStar)},
		},
			"sim events: diff=normal policy=greedy seeds=2 days=3 played=4 breakdowns=1.000 outbreaks=0.250 infected=1.000 pool=1.250 virus=0.250 deadline=0.250 audit=0.250 raise=0.250 star=0.250 second=50.0% total=2.250 max=4 ge3=50.0%"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := eventStatsLine("normal", "greedy", 2, 3, tc.recs); got != tc.want {
				t.Errorf("got  %s\nwant %s", got, tc.want)
			}
		})
	}
}
