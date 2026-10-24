package ws

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/partylog"
)

// Записи партий для аналитики (ITGAME-239) глазами актора: что и в каком
// порядке он шлёт. Запись в базу — internal/partylog.

type recSink struct {
	mu   sync.Mutex
	recs []partylog.Record
}

func (s *recSink) Send(r partylog.Record) {
	s.mu.Lock()
	s.recs = append(s.recs, r)
	s.mu.Unlock()
}

func (s *recSink) all() []partylog.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]partylog.Record(nil), s.recs...)
}

func (s *recSink) of(kind partylog.Kind) []partylog.Record {
	var out []partylog.Record
	for _, r := range s.all() {
		if r.Kind == kind {
			out = append(out, r)
		}
	}
	return out
}

func (s *recSink) wait(t *testing.T, what string, ok func([]partylog.Record) bool) {
	t.Helper()
	eventually(t, what, func() bool { return ok(s.all()) })
}

func hashOf(sid string) string {
	sum := sha256.Sum256([]byte(sid))
	return hex.EncodeToString(sum[:])
}

func choices(rs []partylog.Record) map[int]int {
	out := map[int]int{}
	for _, r := range rs {
		if r.Kind == partylog.KindChoice {
			out[r.Choice.Day] = r.Choice.Option
		}
	}
	return out
}

// Выбор в событии дня 2 и игнор события дня 3 до вечера; дни по порядку;
// старт с хэшем sid, а не самим sid.
func TestPartyLogChoicesAndDays(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.EventChancePct = 100 // событие каждый день со второго
	cfg.EventSecondPct = 0
	cfg.BreakdownChancePermille = 0
	cfg.SalaryPerDay = 0
	sink := &recSink{}
	srv := newSavesServer(t, &Handler{Config: cfg, TickInterval: 20 * time.Millisecond, Saves: newTestStore(t), Parties: sink})
	c, ctx := dialURL(t, srv.URL, "/ws?sid=partylog-choice-1&client=mobile")
	readResume(t, ctx, c)
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" && m.Day == 1 })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "next_day"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Day == 2 && m.ActiveEvent != nil })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "event_choice", Slot: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" && m.Day == 2 })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "next_day"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Day == 3 && m.ActiveEvent != nil })
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" && m.Day == 3 })
	sink.wait(t, "день 3 в записях", func(rs []partylog.Record) bool {
		for _, r := range rs {
			if r.Kind == partylog.KindDay && r.Closed.Day == 3 {
				return true
			}
		}
		return false
	})

	rs := sink.all()
	st := rs[0]
	if st.Kind != partylog.KindStart || st.SIDHash != hashOf("partylog-choice-1") || st.Client != "mobile" || st.Difficulty != "normal" {
		t.Fatalf("первая запись: %+v", st)
	}
	var days []int
	for _, r := range rs {
		if r.PID != st.PID {
			t.Errorf("%s под чужим pid", r.Kind)
		}
		if r.Kind == partylog.KindDay {
			days = append(days, r.Closed.Day)
			if r.Closed.Offline || len(r.Closed.Ledger) == 0 || r.Closed.Offices != 1 {
				t.Errorf("день %d: %+v", r.Closed.Day, r.Closed)
			}
		}
	}
	if len(days) != 3 || days[0] != 1 || days[1] != 2 || days[2] != 3 {
		t.Errorf("дни %v, хотим [1 2 3]", days)
	}
	if day1 := sink.of(partylog.KindDay)[0].Closed; day1.Staff != 1 {
		t.Errorf("штат дня 1: %d, хотим 1", day1.Staff)
	}
	if got := choices(rs); len(got) != 2 || got[2] != 0 || got[3] != -1 {
		t.Errorf("решения по дням %v, хотим {2:0, 3:-1}", got)
	}
}

// Банкротство — финал lost/bankrupt; рестарт — новая партия без фикстуры
// прошлой; «Сдаться» — финал abandon; ухода после финала нет.
func TestPartyLogBankruptcyRestartAbandon(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.StarChancePct = 0
	cfg.EventChancePct = 0
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 100
	cfg.SalaryPerDay = 100000 // как TestMetricsBankruptcyAndRestart: второй вечер — банкротство
	sink := &recSink{}
	srv := newSavesServer(t, &Handler{Config: cfg, TickInterval: 10 * time.Millisecond, Saves: newTestStore(t), Parties: sink})
	c, ctx := dialURL(t, srv.URL, "/ws?sid=partylog-broke-1&scenario=fresh")
	readResume(t, ctx, c)
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "next_day"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "game_over" })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "restart"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Phase == "running" && m.Day == 1 })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "abandon"}); err != nil {
		t.Fatal(err)
	}
	for {
		var m testMessage
		if wsjson.Read(ctx, c, &m) != nil {
			break
		}
	}
	sink.wait(t, "два финала", func(rs []partylog.Record) bool {
		n := 0
		for _, r := range rs {
			if r.Kind == partylog.KindFinish {
				n++
			}
		}
		return n == 2
	})
	time.Sleep(50 * time.Millisecond) // уход актора, если бы он был, — следом за финалом

	starts, fins := sink.of(partylog.KindStart), sink.of(partylog.KindFinish)
	if len(starts) != 2 || starts[0].PID == starts[1].PID {
		t.Fatalf("старты: %+v — хотим два с разными pid", starts)
	}
	if starts[0].Scenario != "fresh" || starts[1].Scenario != "" {
		t.Errorf("фикстуры стартов %q, %q — хотим fresh и пусто после рестарта", starts[0].Scenario, starts[1].Scenario)
	}
	if fins[0].PID != starts[0].PID || fins[0].Outcome != "lost" || fins[0].LoseReason != "bankrupt" || fins[0].Offline {
		t.Errorf("первый финал: %+v", fins[0])
	}
	if fins[1].PID != starts[1].PID || fins[1].Outcome != "abandon" {
		t.Errorf("второй финал: %+v", fins[1])
	}
	if seen := sink.of(partylog.KindSeen); len(seen) != 0 {
		t.Errorf("уход после финала записан: %+v", seen)
	}
}

// Уход вкладки — seen; подъём из сейва — resume под новым pid; сейв, что не
// поднялся, — reset.
func TestPartyLogResumeLeaveReset(t *testing.T) {
	saves := newTestStore(t)
	sink := &recSink{}
	srv := newSavesServer(t, &Handler{Config: savesTestConfig(), TickInterval: time.Hour, Saves: saves, Parties: sink})
	c1, ctx1 := dialURL(t, srv.URL, "/ws?sid=partylog-resume-1")
	readResume(t, ctx1, c1)
	c1.CloseNow()
	sink.wait(t, "уход первой вкладки", func(rs []partylog.Record) bool { return len(sink.of(partylog.KindSeen)) == 1 })
	c2, ctx2 := dialURL(t, srv.URL, "/ws?sid=partylog-resume-1")
	if m := readResume(t, ctx2, c2); !m.Resumed {
		t.Fatal("сейв не поднялся")
	}
	sink.wait(t, "подъём", func(rs []partylog.Record) bool { return len(sink.of(partylog.KindResume)) == 1 })
	start, seen, res := sink.of(partylog.KindStart)[0], sink.of(partylog.KindSeen)[0], sink.of(partylog.KindResume)[0]
	if seen.PID != start.PID || res.PID == start.PID || res.SIDHash != start.SIDHash {
		t.Errorf("pid: старт %s, уход %s, подъём %s — уход тем же, подъём новым", start.PID, seen.PID, res.PID)
	}
	if !res.Expires.After(res.At) {
		t.Errorf("expires %s не позже at %s", res.Expires, res.At)
	}

	gen, _ := saves.Begin("partylog-reset-1")
	if !saves.Put("partylog-reset-1", gen, []byte(`{"sid":"partylog-reset-1","game":`), time.Now()) {
		t.Fatal("битый сейв не лёг")
	}
	c3, ctx3 := dialURL(t, srv.URL, "/ws?sid=partylog-reset-1")
	readResume(t, ctx3, c3)
	sink.wait(t, "reset и новый старт", func(rs []partylog.Record) bool {
		return len(sink.of(partylog.KindReset)) == 1 && len(sink.of(partylog.KindStart)) == 2
	})
	if r := sink.of(partylog.KindReset)[0]; r.SIDHash != hashOf("partylog-reset-1") {
		t.Errorf("reset не того sid: %+v", r)
	}
}

// Офлайн-догон: дни после последнего закрытого дня сейва, с меткой offline.
func TestPartyTrackOfflineDays(t *testing.T) {
	g := game.NewSeeded(savesTestConfig(), 1)
	g.AdvanceOffline(3 * g.Config().DayTicks())
	if maxClosedDay(g) < 3 {
		t.Fatalf("догон закрыл %d дней, хотим ≥3", maxClosedDay(g))
	}
	sink := &recSink{}
	pt := &partyTrack{sink: sink, sidHash: "h", ttl: time.Hour}
	pt.resumed(g, "", 1) // сейв знал день 1 закрытым
	var days []int
	for _, r := range sink.of(partylog.KindDay) {
		days = append(days, r.Closed.Day)
		if !r.Closed.Offline {
			t.Errorf("день %d без метки offline", r.Closed.Day)
		}
	}
	if len(days) == 0 || days[0] != 2 {
		t.Errorf("дни %v — хотим со второго", days)
	}
	if rs := sink.all(); rs[0].Kind != partylog.KindResume {
		t.Errorf("первая запись %s, хотим resume", rs[0].Kind)
	}
}
