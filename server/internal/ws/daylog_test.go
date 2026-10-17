package ws

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"testing"

	"itdirector/internal/game"
)

// Журнал дня в снапшоте (ITGAME-163): state.dayLog — итоги событий текущего
// дня «HH:MM текст», те же строки, что придут в dayReport.events, но вживую:
// лента HUD кладёт их, когда событие случилось, а не вечером с отчётом.

func TestSnapshotDayLog(t *testing.T) {
	// Новая партия: журнала нет — пустой массив, не null.
	s := snapshot(game.New(game.DefaultConfig()), 1, false, "")
	if s.DayLog == nil || len(s.DayLog) != 0 {
		t.Errorf("новая партия: dayLog %#v, хотим пустой массив", s.DayLog)
	}
	raw, _ := json.Marshal(s)
	if !strings.Contains(string(raw), `"dayLog":[]`) {
		t.Errorf("в JSON нет \"dayLog\":[] — клиент ждёт массив")
	}

	g, err := game.NewFixture(game.DefaultConfig(), "virus_outbreak", "1")
	if err != nil {
		t.Fatal(err)
	}
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	s = snapshot(g, 1, false, "virus_outbreak")
	if !slices.Equal(s.DayLog, g.EventLog) || len(s.DayLog) == 0 {
		t.Fatalf("dayLog %v, хотим журнал дня %v", s.DayLog, g.EventLog)
	}
	last := s.DayLog[len(s.DayLog)-1]
	if !regexp.MustCompile(`^\d\d:\d\d вирус в офисе 1: чистим вручную$`).MatchString(last) {
		t.Errorf("строка журнала %q, хотим «HH:MM вирус в офисе 1: чистим вручную»", last)
	}
	// Снапшот — копия: журнал партии дальше растёт, разосланный снапшот нет.
	n := len(s.DayLog)
	g.EventLog = append(g.EventLog, "13:00 лишнее")
	g.EventLog[0] = "00:00 переписано"
	if len(s.DayLog) != n || s.DayLog[0] == "00:00 переписано" {
		t.Errorf("dayLog делит память с журналом партии: %v", s.DayLog)
	}
}
