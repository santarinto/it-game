package ws

import (
	"encoding/json"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"time"

	"itdirector/internal/game"
)

// Вирус в протоколе (ITGAME-103): officeInfo.virusPCs вместо virusUntil,
// state.virusWaveAt, employeeInfo.infected/virusClicks/virusNeeded,
// dayReport.virusPCs/virusLost, команда virus_click, код not_infected.

func TestSnapshotVirus(t *testing.T) {
	g, err := game.NewFixture(game.DefaultConfig(), "virus_outbreak", "1")
	if err != nil {
		t.Fatal(err)
	}
	g.Offices[0].Employees[5].VirusClicks = 2
	s := snapshot(g, 1, false, "virus_outbreak")
	if s.VirusWaveAt != "12:00" {
		t.Errorf("virusWaveAt %q, хотим 12:00", s.VirusWaveAt)
	}
	if s.Offices[0].VirusPCs != 2 || s.Offices[1].VirusPCs != 1 || s.Offices[2].VirusPCs != 0 {
		t.Errorf("virusPCs по офисам: %d/%d/%d, хотим 2/1/0", s.Offices[0].VirusPCs, s.Offices[1].VirusPCs, s.Offices[2].VirusPCs)
	}
	sick, well := s.Offices[0].Employees[5], s.Offices[0].Employees[1]
	if !sick.Infected || sick.VirusClicks != 2 || sick.VirusNeeded != 3 {
		t.Errorf("заражённое место: %+v", sick)
	}
	if well.Infected || well.VirusClicks != 0 || well.VirusNeeded != 0 {
		t.Errorf("здоровое место: %+v", well)
	}
	var virus *effectInfo
	for i, ef := range sick.Effects {
		if ef.Token == "virus" {
			virus = &sick.Effects[i]
		}
	}
	if virus == nil || virus.Percent != -30 || virus.Until != "" {
		t.Errorf("эффект «вирус −30%%» до чистки: %+v", sick.Effects)
	}
	if s.ActiveEvent == nil || s.ActiveEvent.ID != "virus" || len(s.ActiveEvent.Options) != 2 {
		t.Errorf("карточка вируса: %+v", s.ActiveEvent)
	}
	raw, _ := json.Marshal(s)
	if strings.Contains(string(raw), "virusUntil") {
		t.Error("в снапшоте остался virusUntil")
	}
	// Заражённых нет — волны нет.
	if s := snapshot(game.New(game.DefaultConfig()), 1, false, ""); s.VirusWaveAt != "" || s.Offices[0].VirusPCs != 0 {
		t.Errorf("новая партия: virusWaveAt %q, virusPCs %d", s.VirusWaveAt, s.Offices[0].VirusPCs)
	}
}

// Подписка на антивирус в протоколе (ITGAME-137): state.antivirus,
// prices.antivirusTiers, employeeInfo.avCovered, dayReport.antivirus.
func TestSnapshotAntivirus(t *testing.T) {
	g := game.NewWithSeed(game.DefaultConfig(), 1, 2)
	g.Money = 10000
	g.Offices[0].PCs = 6
	for range 6 {
		if err := g.Hire(0); err != nil {
			t.Fatal(err)
		}
	}
	s := snapshot(g, 1, false, "")
	if s.Antivirus != (antivirusInfo{}) || len(s.Prices.AntivirusTiers) != 3 ||
		s.Prices.AntivirusTiers[1] != (antivirusTierPrice{Name: "One Office", Seats: 15, Price: 40}) {
		t.Fatalf("без подписки: %+v, тарифы %+v", s.Antivirus, s.Prices.AntivirusTiers)
	}
	if err := g.SetAntivirus(3); err != nil {
		t.Fatal(err)
	}
	if err := g.SetAntivirus(1); err != nil {
		t.Fatal(err)
	}
	s = snapshot(g, 1, false, "")
	want := antivirusInfo{Tier: 1, Name: "SOHO Edition", Seats: 4, Covered: 4, BilledToday: 90}
	if s.Antivirus != want {
		t.Errorf("state.antivirus %+v, хотим %+v", s.Antivirus, want)
	}
	var covered []bool
	for _, e := range s.Offices[0].Employees {
		covered = append(covered, e.AVCovered)
	}
	if !slices.Equal(covered, []bool{true, true, true, true, false, false}) {
		t.Errorf("avCovered по местам: %v, хотим первые 4", covered)
	}
	m := dayReportMsg(&game.DayReport{Day: 2, Antivirus: 90})
	raw, _ := json.Marshal(m)
	if !strings.Contains(string(raw), `"antivirus":90`) {
		t.Errorf("day_report: %s", raw)
	}
}

func TestDayReportVirus(t *testing.T) {
	m := dayReportMsg(&game.DayReport{Day: 4, VirusPCs: 3, VirusLost: 120})
	raw, _ := json.Marshal(m)
	var got struct {
		VirusPCs  int `json:"virusPCs"`
		VirusLost int `json:"virusLost"`
	}
	if err := json.Unmarshal(raw, &got); err != nil || got.VirusPCs != 3 || got.VirusLost != 120 {
		t.Fatalf("day_report: %s", raw)
	}
}

// Сейв до ITGAME-103 (формат 0) не читается (решение владельца 16.10, без миграции): меню
// показывает карточку «несовместим», подключение с тем же sid начинает новую партию, и её первый
// сейв перезаписывает старый файл.
func TestSaveBeforeVirusStartsNewParty(t *testing.T) {
	const sid = "pre-virus-1"
	saves := newTestStore(t)
	g := game.NewWithSeed(savesTestConfig(), 11, 22)
	g.Money = 4321
	old := g.Export()
	old.Format = 0
	gen, _ := saves.Begin(sid)
	raw, _ := json.Marshal(sessionSave{SID: sid, Speed: 1, SavedAt: time.Now(), Game: old})
	// Без saves.Finish: он удаляет сейв, и тест проверял бы пустой стор (ITGAME-140).
	if !saves.Put(sid, gen, raw, time.Now()) {
		t.Fatal("не удалось записать тестовый сейв")
	}

	if s := peek(t, saves, savesTestConfig(), "?peek=1&sid="+sid); s.Exists || s.Alive || !s.Incompatible {
		t.Fatalf("сейв до ITGAME-103 в меню: %+v, хотим incompatible", s)
	}
	c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid="+sid)
	first := readResume(t, ctx, c)
	if first.Resumed || first.Money != 600 || first.Day != 1 {
		t.Fatalf("старый сейв поднялся: resumed=%v money=%d day=%d", first.Resumed, first.Money, first.Day)
	}
	data, ok := saves.Load(sid)
	if !ok {
		t.Fatal("новая партия не записала сейв")
	}
	var ss sessionSave
	if err := json.Unmarshal(data, &ss); err != nil || ss.Game.Format != game.SaveFormat || ss.Game.Money != 600 {
		t.Fatalf("файл сейва: format=%d money=%d err=%v — хотим новую партию формата %d", ss.Game.Format, ss.Game.Money, err, game.SaveFormat)
	}
}

// Партия с вирусом реплеится без расхождения (ITGAME-46): вспышка, волны
// серверным PCG и virus_click по заражённым местам — журнал воспроизводит всё.
func TestJournalReplayVirusParty(t *testing.T) {
	const sid = "journal-virus-1"
	_, srv := journalServer(t, game.DefaultConfig(), 3*time.Millisecond, journalLimits{})
	rng := rand.New(rand.NewPCG(103, 103))
	tb := dialTab(t, srv, "?sid="+sid+"&seed=103&scenario=virus_outbreak")
	clicks, waves := 0, 0
	for step := range 300 {
		if step%50 == 0 { // случайные покупки банкротят, а рестарт — партия без вируса
			ensureAlive(t, srv, tb, sid)
		}
		s := tb.state()
		if s.Phase != string(game.PhaseRunning) {
			randomStep(t, tb, rng)
			continue
		}
		var targets [][2]int
		for oi, o := range s.Offices {
			for i, e := range o.Employees {
				if e.Infected {
					targets = append(targets, [2]int{oi, i})
				}
			}
		}
		switch {
		case len(targets) > 0 && rng.IntN(4) == 0:
			tg := targets[rng.IntN(len(targets))]
			tb.send(t, map[string]any{"type": "virus_click", "office": tg[0], "slot": tg[1]})
			clicks++
		case rng.IntN(6) == 0:
			tb.send(t, map[string]any{"type": "virus_click", "office": 0, "slot": rng.IntN(9)}) // часто not_infected
		default:
			randomStep(t, tb, rng)
		}
		time.Sleep(time.Duration(rng.IntN(1500)) * time.Microsecond)
		if s.VirusWaveAt != "" && tb.state().VirusWaveAt != s.VirusWaveAt {
			waves++
		}
	}
	tb.do(t, map[string]any{"type": "set_speed", "speed": 0})
	res, recs := replayAndCompare(t, srv, sid)
	cmds := map[string]int{}
	for _, r := range recs {
		if r.K == "cmd" {
			cmds[r.Type]++
		}
	}
	t.Logf("реплей: %d записей, %d тиков, итог день %d; virus_click отправлено %d, в журнале %d; смен волны %d",
		res.Records, res.Ticks, res.Game.Day, clicks, cmds["virus_click"], waves)
	if cmds["virus_click"] == 0 || clicks == 0 {
		t.Errorf("в журнале нет virus_click: %v", cmds)
	}
	if res.Game.Day < 4 || waves == 0 {
		t.Errorf("партия ушла с фикстуры (день %d) или волн не было (%d)", res.Game.Day, waves)
	}
}
