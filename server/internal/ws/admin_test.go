package ws

import (
	"encoding/json"
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"itdirector/internal/game"
)

// Админы в протоколе (ITGAME-101): officeInfo.admin/adminUnpaidToday/
// adminSlot/adminKind/adminFirePrice, state.adminSalaryPerDay, prices.admin,
// dayReport.adminRepairs/adminCleaned, команды hire_admin/fire_admin.

func TestSnapshotAdmin(t *testing.T) {
	g := game.New(game.DefaultConfig())
	g.Money = 100000
	if s := snapshot(g, 1, false, ""); s.Offices[0].Admin != "" || s.Offices[0].AdminSlot != -1 || s.Offices[0].AdminKind != "" {
		t.Errorf("без админа: %q слот %d цель %q, хотим \"\", -1, \"\"", s.Offices[0].Admin, s.Offices[0].AdminSlot, s.Offices[0].AdminKind)
	}
	if s := snapshot(g, 1, false, ""); s.AdminDept || s.Prices.AdminDept != 3000 {
		t.Errorf("до покупки: adminDept %v, цена %d; хотим false и 3000", s.AdminDept, s.Prices.AdminDept)
	}
	if err := g.Apply(game.CmdHire, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(game.CmdBuyAdminDept, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(game.CmdHireAdmin, 0, 0); err != nil {
		t.Fatal(err)
	}
	g.Offices[0].Employees[0].PCBroken, g.Offices[0].Employees[0].RepairNeeded = true, 9
	s := snapshot(g, 1, false, "")
	if !s.AdminDept {
		t.Error("после покупки отдела adminDept = false")
	}
	o := s.Offices[0]
	if o.Admin == "" || o.AdminSlot != 0 || o.AdminKind != "repair" || o.AdminFirePrice != 100 || o.AdminUnpaidToday {
		t.Errorf("офис с админом: %q слот %d цель %q увольнение %d unpaid %v; хотим имя, 0, repair, 100, false",
			o.Admin, o.AdminSlot, o.AdminKind, o.AdminFirePrice, o.AdminUnpaidToday)
	}
	if s.Prices.Admin != 600 || s.AdminSalaryPerDay != 300 {
		t.Errorf("цены: найм %d, зарплата %d; хотим 600 и 300", s.Prices.Admin, s.AdminSalaryPerDay)
	}
	g.Offices[0].Employees[0].Infected = true
	g.Offices[0].Employees[0].PCBroken = false
	if s := snapshot(g, 1, false, ""); s.Offices[0].AdminKind != "virus" {
		t.Errorf("заражённое место: цель %q, хотим virus", s.Offices[0].AdminKind)
	}
	raw, _ := json.Marshal(s)
	for _, key := range []string{`"admin":`, `"adminUnpaidToday":`, `"adminSlot":`, `"adminKind":`, `"adminFirePrice":`, `"adminSalaryPerDay":`, `"adminDept":`, `"adminShifts":`, `"adminNextShift":`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("в снапшоте нет %s", key)
		}
	}
	if len(o.AdminShifts) != 1 || o.AdminNextShift != 2 {
		t.Errorf("смены в снапшоте: len=%d next=%d, хотим 1 и 2", len(o.AdminShifts), o.AdminNextShift)
	}
}

func TestDayReportAdmin(t *testing.T) {
	m := dayReportMsg(&game.DayReport{Day: 4, AdminRepairs: 2, AdminCleaned: 5})
	raw, _ := json.Marshal(m)
	var got struct {
		AdminRepairs int `json:"adminRepairs"`
		AdminCleaned int `json:"adminCleaned"`
	}
	if err := json.Unmarshal(raw, &got); err != nil || got.AdminRepairs != 2 || got.AdminCleaned != 5 {
		t.Fatalf("day_report: %s", raw)
	}
}

// Партия с админами реплеится байт в байт: клики админа идут из тика, без
// роллов, и журнал их не пишет — только hire_admin/fire_admin.
func TestJournalReplayAdminParty(t *testing.T) {
	const sid = "journal-admin-1"
	_, srv := journalServer(t, game.DefaultConfig(), 3*time.Millisecond, journalLimits{})
	rng := rand.New(rand.NewPCG(101, 101))
	tb := dialTab(t, srv, "?sid="+sid+"&seed=101&scenario=virus_outbreak")
	tb.do(t, map[string]any{"type": "buy_admin_dept"})
	tb.do(t, map[string]any{"type": "hire_admin", "office": 0})
	tb.do(t, map[string]any{"type": "hire_admin", "office": 1})
	for step := range 300 {
		if step%50 == 0 {
			ensureAlive(t, srv, tb, sid)
		}
		switch rng.IntN(11) {
		case 10:
			tb.send(t, map[string]any{"type": "buy_admin_dept"}) // после партии с рестарта — покупка, иначе admin_dept_already
		case 0:
			tb.send(t, map[string]any{"type": "fire_admin", "office": rng.IntN(2)}) // повтор — no_admin
		case 1:
			tb.send(t, map[string]any{"type": "hire_admin", "office": rng.IntN(2)}) // повтор — admin_already
		default:
			randomStep(t, tb, rng)
		}
		time.Sleep(time.Duration(rng.IntN(1500)) * time.Microsecond)
	}
	tb.do(t, map[string]any{"type": "set_speed", "speed": 0})
	res, recs := replayAndCompare(t, srv, sid)
	cmds := map[string]int{}
	for _, r := range recs {
		if r.K == "cmd" {
			cmds[r.Type]++
		}
	}
	t.Logf("реплей: %d записей, %d тиков, итог день %d; hire_admin %d, fire_admin %d",
		res.Records, res.Ticks, res.Game.Day, cmds["hire_admin"], cmds["fire_admin"])
	if cmds["hire_admin"] == 0 || cmds["fire_admin"] == 0 {
		t.Errorf("в журнале нет hire_admin/fire_admin: %v", cmds)
	}
}
