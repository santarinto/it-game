package game

import (
	"math"
	"slices"
	"strings"
	"testing"
)

// «Просит уйти пораньше» (ITGAME-198): карточка на сотрудника 0 офиса 0
// eventGame (двое по $10/тик, кулер и холодильник есть).

func leaveCard(t *testing.T) *Game {
	t.Helper()
	g := eventGame()
	forceEvent(g, EventLeave)
	g.Tick()
	if g.ActiveEvent == nil || g.ActiveEvent.ID != EventLeave {
		t.Fatalf("карточка не активна: %+v", g.ActiveEvent)
	}
	return g
}

func effectTokens(g *Game, slot int) []string {
	var out []string
	for _, ef := range g.Effects(&g.Offices[0], &g.Offices[0].Employees[slot]) {
		out = append(out, ef.Token)
	}
	return out
}

// Пока директор молчит, сотрудник не отпущен: −50% сразу, а не после ответа —
// иначе молчание выгоднее обоих ответов.
func TestLeaveCardOverworksUntilAnswered(t *testing.T) {
	g := leaveCard(t)
	if got := g.Offices[0].Employees[0].OverworkedUntil; got != g.cfg.DayTicks() {
		t.Errorf("OverworkedUntil = %d, хотим конец дня %d", got, g.cfg.DayTicks())
	}
	if inc := g.IncomePerTick(); inc != 15 { // 10×0.5 + 10
		t.Errorf("доход тика = %d, хотим 15", inc)
	}
	if toks := effectTokens(g, 0); !slices.Contains(toks, EffectOverworked) {
		t.Errorf("нет эффекта overworked: %v", toks)
	}
	info := g.ActiveEventInfo()
	if info.Title != "Просит уйти пораньше" || !slices.Equal(info.Options, []string{"Отпустить", "Не отпускать"}) {
		t.Errorf("карточка: %+v", info)
	}
	if !strings.Contains(info.Text, "+25%") || !strings.Contains(info.Text, "−50%") {
		t.Errorf("карточка не называет +25%% и −50%%: %q", info.Text)
	}
}

func TestLeaveRelease(t *testing.T) {
	g := leaveCard(t)
	day := g.Day
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	e := &g.Offices[0].Employees[0]
	if e.AwayFrom == 0 || e.OverworkedUntil != 0 || e.RestedDay != day+1 {
		t.Fatalf("после «Отпустить»: AwayFrom=%d OverworkedUntil=%d RestedDay=%d", e.AwayFrom, e.OverworkedUntil, e.RestedDay)
	}
	if inc := g.IncomePerTick(); inc != 10 {
		t.Errorf("доход тика = %d, хотим 10 (место пустует)", inc)
	}
	if toks := effectTokens(g, 0); !slices.Equal(toks, []string{EffectAway}) {
		t.Errorf("эффекты отпущенного = %v, хотим только away", toks)
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "отпущен домой") {
		t.Errorf("журнал: %v", g.EventLog)
	}
	// Дома опыт не копится.
	xp := e.XP
	for range 10 {
		g.Tick()
	}
	if e.XP != xp {
		t.Errorf("опыт отпущенного вырос: %d → %d", xp, e.XP)
	}
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if e.AwayFrom != 0 {
		t.Error("утром отпущенный не вернулся")
	}
	base := g.baseOutput(&g.Offices[0], 0)
	if got, want := g.EffectiveIncomePerTick(&g.Offices[0], 0), int(math.Round(base*g.cfg.MotivateMult)); got != want {
		t.Errorf("выработка отдохнувшего = %d, хотим %d", got, want)
	}
	var rested *Effect
	for _, ef := range g.Effects(&g.Offices[0], e) {
		if ef.Token == EffectRested {
			rested = &ef
		}
	}
	if rested == nil || rested.Until != -1 || rested.Percent != 25 {
		t.Errorf("эффект rested не виден или не +25%% до конца дня: %+v", rested)
	}
	// Клик-мотивация с отдыхом складывается: ×1.25×1.25.
	if err := g.Motivate(0, 0); err != nil {
		t.Fatal(err)
	}
	if got, want := g.EffectiveIncomePerTick(&g.Offices[0], 0), int(math.Round(base*g.cfg.MotivateMult*g.cfg.MotivateMult)); got != want {
		t.Errorf("клик поверх отдыха: %d, хотим %d", got, want)
	}
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if toks := effectTokens(g, 0); slices.Contains(toks, EffectRested) {
		t.Errorf("послезавтра отдых остался: %v", toks)
	}
}

func TestLeaveKeep(t *testing.T) {
	g := leaveCard(t)
	if err := g.ChooseEvent(1); err != nil {
		t.Fatal(err)
	}
	e := g.Offices[0].Employees[0]
	if e.OverworkedUntil != g.cfg.DayTicks() || e.AwayFrom != 0 || e.RestedDay != 0 {
		t.Fatalf("после «Не отпускать»: %+v", e)
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "не отпущен, до конца дня работает через силу (−50%)") {
		t.Errorf("журнал: %v", g.EventLog)
	}
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].Employees[0].OverworkedUntil != 0 {
		t.Error("ночь не сняла «через силу»")
	}
}

func TestLeaveIgnoredUntilEvening(t *testing.T) {
	g := leaveCard(t)
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "просьба уйти пораньше без ответа, работал через силу") {
		t.Errorf("авторезолв не залогирован: %v", g.EventLog)
	}
	if g.ActiveEvent != nil {
		t.Error("карточка висит после конца дня")
	}
}

func TestLeaveFiredBeforeAnswer(t *testing.T) {
	g := leaveCard(t)
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	if g.ActiveEvent != nil {
		t.Fatal("карточка уволенного висит")
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "просьба уйти пораньше: сотрудник уволен до ответа") {
		t.Errorf("журнал: %v", g.EventLog)
	}
}

// Карточка на второго сотрудника: увольнение первого сдвигает её адресата.
func TestLeaveRetargetsOnFire(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventLeave)
	g.DayEvents[0].Slot = 1
	g.Tick()
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	if g.ActiveEvent == nil || g.ActiveEvent.Slot != 0 {
		t.Fatalf("адресат не сдвинулся: %+v", g.ActiveEvent)
	}
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].Employees[0].AwayFrom == 0 {
		t.Error("отпущен не тот сотрудник")
	}
}

func TestLeaveSurvivesSave(t *testing.T) {
	g := leaveCard(t)
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	want := g.Offices[0].Employees[0]
	r := saveRoundtrip(t, g)
	got := r.Offices[0].Employees[0]
	if got.AwayFrom != want.AwayFrom || got.RestedDay != want.RestedDay {
		t.Errorf("после restore: AwayFrom %d/%d, RestedDay %d/%d", got.AwayFrom, want.AwayFrom, got.RestedDay, want.RestedDay)
	}
	if r.cfg.OverworkMult != 0.5 {
		t.Errorf("OverworkMult после restore = %v", r.cfg.OverworkMult)
	}
}

// Офлайн-догон считает день мотивации «отпустили вчера» ровно один раз: и
// когда это полный офлайн-день, и когда это недоигранный хвост.
func TestLeaveMotivationOffline(t *testing.T) {
	day := DefaultConfig().DayTicks()
	for _, tc := range []struct {
		name string
		miss int // от тика 1 дня с карточкой
		want int // лишний доход за день мотивации: 10 × 25% × продуктивные тики
	}{
		{"полные дни", 3*day - 1, 10 * 48 / 4},
		{"хвост дня", day - 1 + 12, 10 * 12 / 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := leaveCard(t)
			if err := a.ChooseEvent(0); err != nil {
				t.Fatal(err)
			}
			b := leaveCard(t)
			if err := b.ChooseEvent(0); err != nil {
				t.Fatal(err)
			}
			b.Offices[0].Employees[0].RestedDay = 0
			sa, sb := a.AdvanceOffline(tc.miss), b.AdvanceOffline(tc.miss)
			if d := sa.Income - sb.Income; d < tc.want-1 || d > tc.want+1 {
				t.Errorf("доход мотивации офлайн = %d, хотим %d (±1 остатка)", d, tc.want)
			}
		})
	}
}
