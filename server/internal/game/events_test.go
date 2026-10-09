package game

import (
	"slices"
	"strings"
	"testing"
)

// eventGame — офис с двумя сотрудниками $10/тик, события включены.
// Кулер и холодильник в офисе — дебаффы быт-устройств не мешают арифметике.
func eventGame() *Game {
	cfg := DefaultConfig()
	cfg.EventChancePct = 100
	cfg.EventSecondPct = 0
	cfg.BreakdownChancePct = 0
	g := NewWithSeed(cfg, 11, 22)
	g.Money = 10000
	g.Offices[0].PCs = 4
	g.Offices[0].Employees = testStaff(2)
	g.Offices[0].Cooler = true
	g.Offices[0].Fridge = true
	return g
}

// forceEvent — вручную ставит событие активируемым первым же тиком.
func forceEvent(g *Game, id EventID) {
	g.DayEvents = []DayEvent{{ID: id, Tick: 0}}
	switch id {
	case EventVirus, EventRaise:
		g.DayEvents[0].Office = 0
		g.DayEvents[0].Slot = 0
	}
}

func TestDay1HasNoEvents(t *testing.T) {
	g := eventGame()
	g.Tick()
	if g.ActiveEvent != nil || len(g.DayEvents) != 0 {
		t.Fatalf("день 1 должен быть без событий: %+v", g.DayEvents)
	}
}

func TestRollDayEvents(t *testing.T) {
	g := eventGame()
	g.Phase = PhaseDayReport
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if len(g.DayEvents) != 1 {
		t.Fatalf("событий за день: %d, хотим 1 (SecondPct=0)", len(g.DayEvents))
	}
	lo, hi := g.cfg.eventWindow()
	ev := g.DayEvents[0]
	if ev.Tick < lo || ev.Tick >= hi {
		t.Errorf("тик события %d вне окна [%d,%d)", ev.Tick, lo, hi)
	}
	if !slices.Contains([]EventID{EventVirus, EventDeadline, EventAudit, EventRaise, EventStar}, ev.ID) {
		t.Errorf("неизвестный тип события: %q", ev.ID)
	}
	// Второе событие и уникальность типов.
	g.cfg.EventSecondPct = 100
	g.Phase = PhaseDayReport
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if len(g.DayEvents) != 2 {
		t.Fatalf("событий за день: %d, хотим 2", len(g.DayEvents))
	}
	if g.DayEvents[0].ID == g.DayEvents[1].ID {
		t.Errorf("типы повторяются: %q", g.DayEvents[0].ID)
	}
	if g.DayEvents[0].Tick > g.DayEvents[1].Tick {
		t.Error("события не отсортированы по тику")
	}
}

func TestRollDayEventsZeroChance(t *testing.T) {
	g := eventGame()
	g.cfg.EventChancePct = 0
	g.Phase = PhaseDayReport
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if len(g.DayEvents) != 0 {
		t.Fatalf("события роллятся при нулевом шансе: %+v", g.DayEvents)
	}
}

func TestActivateEventsOneAtATime(t *testing.T) {
	g := eventGame()
	g.DayEvents = []DayEvent{
		{ID: EventAudit, Tick: 0},
		{ID: EventVirus, Tick: 0, Office: 0},
	}
	g.Tick()
	if g.ActiveEvent == nil || g.ActiveEvent.ID != EventAudit {
		t.Fatalf("активным должен быть первый по порядку: %+v", g.ActiveEvent)
	}
	// Пока первое висит, второе не активируется — даже после его тика.
	g.Tick()
	if slices.ContainsFunc(g.DayEvents, func(e DayEvent) bool { return e.ID == EventVirus && g.Offices[0].VirusUntil > 0 }) {
		t.Fatal("второе событие активировалось поверх висящего")
	}
}

func TestVirusDebuffAndCure(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventVirus)
	g.Tick() // активация: вирус стартовал
	if g.Offices[0].VirusUntil == 0 {
		t.Fatal("вирус не стартовал при активации")
	}
	if inc := g.IncomePerTick(); inc != 14 { // 20 × 0.7 = 14
		t.Errorf("доход под вирусом = %d, хотим 14", inc)
	}
	if info := g.ActiveEventInfo(); info == nil || len(info.Options) != 2 {
		t.Fatalf("снапшот события вируса: %+v", info)
	}
	if err := g.ChooseEvent(0); err != nil {
		t.Fatalf("лечение: %v", err)
	}
	if g.Offices[0].VirusUntil != 0 {
		t.Error("антивирус не вылечил офис")
	}
	if g.Money != 10000-250+14 {
		t.Errorf("деньги после лечения = %d, хотим %d", g.Money, 10000-250+14)
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "антивирус") {
		t.Errorf("лог без лечения: %v", g.EventLog)
	}
}

func TestVirusTolerate(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventVirus)
	g.Tick()
	if err := g.ChooseEvent(1); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].VirusUntil == 0 {
		t.Error("«терпеть» не должно лечить вирус")
	}
	for g.TickInDay < g.Offices[0].VirusUntil {
		g.Tick()
	}
	if inc := g.IncomePerTick(); inc != 20 {
		t.Errorf("вирус не истёк: доход = %d, хотим 20", inc)
	}
}

func TestVirusCureWithoutMoney(t *testing.T) {
	g := eventGame()
	g.Money = 0
	forceEvent(g, EventVirus)
	g.Tick()
	if err := g.ChooseEvent(0); err != ErrNotEnoughMoney {
		t.Errorf("лечение без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
	if g.ActiveEvent == nil {
		t.Error("событие должно висеть при нехватке денег")
	}
}

func TestDeadlineFlow(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventDeadline)
	g.Tick()
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	if !g.DeadlineOn || g.DeadlineGoal <= 0 {
		t.Fatalf("дедлайн не запущен: on=%v goal=%d", g.DeadlineOn, g.DeadlineGoal)
	}
	// Дотикиваем до резолва: 2×$10/тик, цель 70% — выполняется.
	for g.TickInDay <= g.cfg.deadlineTick() {
		g.Tick()
	}
	if g.DeadlineOn {
		t.Fatal("дедлайн не зарезолвился на тике проверки")
	}
	joined := strings.Join(g.EventLog, "; ")
	if !strings.Contains(joined, "выполнен") {
		t.Errorf("успешный дедлайн не залогирован: %v", g.EventLog)
	}
}

func TestDeadlineFail(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventDeadline)
	g.Tick()
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	g.DeadlineGoal = 1 << 30 // недостижимо
	before := g.Money
	for g.TickInDay <= g.cfg.deadlineTick() {
		g.Tick()
	}
	if g.Money >= before {
		t.Errorf("провал дедлайна не оштрафовал: %d → %d", before, g.Money)
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "провален") {
		t.Errorf("провал дедлайна не залогирован: %v", g.EventLog)
	}
}

func TestDeadlineRefuseScalesWithEventK(t *testing.T) {
	fine := func(k float64) int {
		g := eventGame()
		g.cfg.EventK = k
		forceEvent(g, EventDeadline)
		g.Tick()
		before := g.Money
		if err := g.ChooseEvent(1); err != nil {
			t.Fatal(err)
		}
		return before - g.Money
	}
	easy, hardcore := fine(0.7), fine(1.5)
	if hardcore <= easy {
		t.Errorf("штраф отказа должен расти с EventK: K=0.7 → %d, K=1.5 → %d", easy, hardcore)
	}
}

func TestAuditPassAndFail(t *testing.T) {
	run := func(topConfig bool) string {
		g := eventGame()
		g.cfg.AuditFineShare = 0.2
		g.PrevDayIncome = 1000
		if topConfig {
			g.Gateway = true
			g.CoreLevel = 2
		}
		forceEvent(g, EventAudit)
		g.Tick()
		if err := g.ChooseEvent(0); err != nil {
			t.Fatal(err)
		}
		for g.TickInDay <= g.cfg.auditTick() {
			g.Tick()
		}
		return strings.Join(g.EventLog, "; ")
	}
	if log := run(true); !strings.Contains(log, "пройден") {
		t.Errorf("топ-конфиг не прошёл аудит: %q", log)
	}
	if log := run(false); !strings.Contains(log, "аудит провален (−$200)") {
		t.Errorf("без топ-конфига аудит не провален на $200: %q", log)
	}
}

// Аудит не роллится до cfg.AuditMinDay (ITGAME-50): на старте штраф
// неподъёмен, игрок ещё не мог собрать топ-конфиг.
func TestAuditNotBeforeMinDay(t *testing.T) {
	late := 0
	for seed := uint64(1); seed <= 200; seed++ {
		cfg := DefaultConfig()
		cfg.EventChancePct = 100
		cfg.EventSecondPct = 100
		cfg.BreakdownChancePct = 0
		cfg.AuditMinDay = 5
		g := NewWithSeed(cfg, seed, seed*7+1)
		g.Offices[0].PCs = 4
		g.Offices[0].Employees = testStaff(2)
		for g.Day < 8 {
			g.Phase = PhaseDayReport
			if err := g.NextDay(); err != nil {
				t.Fatal(err)
			}
			has := slices.ContainsFunc(g.DayEvents, func(e DayEvent) bool { return e.ID == EventAudit })
			if g.Day < 5 && has {
				t.Fatalf("seed %d, день %d: аудит до дня 5", seed, g.Day)
			}
			if g.Day >= 5 && has {
				late++
			}
		}
	}
	if late == 0 {
		t.Fatal("с дня 5 аудит должен роллиться")
	}
}

func TestAuditFine(t *testing.T) {
	share := func(cfg Config) Config { cfg.AuditFineShare = 0.2; return cfg }
	cases := []struct {
		name string
		cfg  Config
		prev int
		want int
	}{
		{"normal малый доход", share(DefaultConfig()), 1000, 200},
		{"normal потолок", share(DefaultConfig()), 100000, 1200},
		{"normal нулевой доход", share(DefaultConfig()), 0, 0},
		{"hardcore малый доход", share(ConfigForDifficulty(DiffHardcore)), 1000, 300},
		{"hardcore потолок", share(ConfigForDifficulty(DiffHardcore)), 100000, 1800},
		{"easy малый доход", share(ConfigForDifficulty(DiffEasy)), 1000, 140},
		{"easy потолок", share(ConfigForDifficulty(DiffEasy)), 100000, 840},
	}
	for _, c := range cases {
		g := NewWithSeed(c.cfg, 1, 2)
		g.PrevDayIncome = c.prev
		if got := g.auditFine(); got != c.want {
			t.Errorf("%s: auditFine() = %d, хотим %d", c.name, got, c.want)
		}
	}
}

func TestAuditToastShowsComputedFine(t *testing.T) {
	g := eventGame()
	g.cfg.AuditFineShare = 0.2
	g.PrevDayIncome = 1000
	forceEvent(g, EventAudit)
	g.Tick()
	info := g.ActiveEventInfo()
	if info == nil {
		t.Fatal("аудит должен висеть")
	}
	if !strings.Contains(info.Text, "штраф $200") || strings.Contains(info.Text, "$1200") {
		t.Errorf("тост аудита: %q", info.Text)
	}
}

// Объявленный штраф входит в прогноз (после тоста и после его закрытия),
// субсидия — нет, после чека второй раз не вычитается.
func TestForecastAuditFine(t *testing.T) {
	g := eventGame()
	g.cfg.AuditFineShare = 0.2
	g.PrevDayIncome = 1000
	g.DayEvents = []DayEvent{{ID: EventAudit, Tick: 20}}
	base := func() int {
		ev, act := g.DayEvents, g.ActiveEvent
		g.DayEvents, g.ActiveEvent = nil, nil
		f := g.ForecastEndOfDay()
		g.DayEvents, g.ActiveEvent = ev, act
		return f
	}
	if got := g.ForecastEndOfDay(); got != base() {
		t.Errorf("до активации прогноз %d, хотим %d", got, base())
	}
	for g.ActiveEvent == nil {
		g.Tick()
	}
	if got := g.ForecastEndOfDay(); got != base()-200 {
		t.Errorf("после активации прогноз %d, хотим %d", got, base()-200)
	}
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	if got := g.ForecastEndOfDay(); got != base()-200 {
		t.Errorf("после закрытия тоста прогноз %d, хотим %d", got, base()-200)
	}
	g.Gateway, g.CoreLevel = true, 2
	if got := g.ForecastEndOfDay(); got != base() {
		t.Errorf("топ-конфиг: прогноз %d, хотим %d (субсидию не обещаем)", got, base())
	}
	g.Gateway, g.CoreLevel = false, 0
	for g.TickInDay <= g.cfg.auditTick() {
		g.Tick()
	}
	if got := g.ForecastEndOfDay(); got != base() {
		t.Errorf("после чека прогноз %d, хотим %d", got, base())
	}
}

func TestAuditChecksEvenWithoutChoice(t *testing.T) {
	g := eventGame()
	g.Gateway = true
	g.CoreLevel = 2
	forceEvent(g, EventAudit)
	g.Tick()
	if g.ActiveEvent == nil {
		t.Fatal("аудит должен висеть")
	}
	for g.Phase == PhaseRunning {
		g.Tick() // до конца дня без выбора
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "аудит") {
		t.Errorf("чек аудита не прошёл без выбора: %v", g.EventLog)
	}
}

func TestRaiseAccept(t *testing.T) {
	g := eventGame()
	before := g.Offices[0].Employees[0].IncomePerTick
	forceEvent(g, EventRaise)
	g.Tick()
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	e := g.Offices[0].Employees[0]
	if e.SalaryAdd != g.cfg.SalaryPerDay/2 {
		t.Errorf("надбавка = %d, хотим %d", e.SalaryAdd, g.cfg.SalaryPerDay/2)
	}
	if e.IncomePerTick <= before {
		t.Errorf("выработка не выросла: %d → %d", before, e.IncomePerTick)
	}
	if p := g.PayrollPerDay(); p != 2*g.cfg.SalaryPerDay+g.cfg.SalaryPerDay/2 {
		t.Errorf("ФОТ с надбавкой = %d", p)
	}
}

func TestRaiseRefuseOffends(t *testing.T) {
	g := eventGame()
	g.Offices[0].Cooler = true // жажда не мешает арифметике
	forceEvent(g, EventRaise)
	g.Tick()
	if err := g.ChooseEvent(1); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].Employees[0].OffendedUntil != g.cfg.DayTicks() {
		t.Error("обида не выставлена до конца дня")
	}
	if inc := g.IncomePerTick(); inc != 19 { // 10×0.85 + 10 = 18.5 → 9+10
		t.Errorf("доход с обидой = %d, хотим 18 или 19", inc)
	}
	found := false
	for _, ef := range g.Effects(&g.Offices[0], &g.Offices[0].Employees[0]) {
		if ef.Token == EffectOffended {
			found = true
		}
	}
	if !found {
		t.Error("эффект offended не виден в списке эффектов")
	}
}

func TestStarHire(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventStar)
	g.Tick()
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	if n := len(g.Offices[0].Employees); n != 3 {
		t.Fatalf("звезда не нанята: сотрудников %d", n)
	}
	star := g.Offices[0].Employees[2]
	if !strings.Contains(star.Name, "★") || star.IncomePerTick != g.cfg.IncomeMax+starIncomeBonus {
		t.Errorf("звезда без отличий: %+v", star)
	}
	if star.SalaryAdd != g.cfg.SalaryPerDay {
		t.Errorf("зарплата звезды не ×2: надбавка %d", star.SalaryAdd)
	}
	if g.Money != 10000+20-g.cfg.HirePrice*2 { // +20: доход тика активации
		t.Errorf("найм звезды не оплачен: %d", g.Money)
	}
}

func TestStarNoSeatStays(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventStar)
	g.Tick()                                                                 // активировалось, пока место было
	g.Offices[0].Employees = append(g.Offices[0].Employees, testStaff(2)...) // места заняли
	if err := g.ChooseEvent(0); err != ErrNoFreePC {
		t.Errorf("найм без места: %v, хотим %v", err, ErrNoFreePC)
	}
	if g.ActiveEvent == nil {
		t.Error("событие должно висеть, пока нет места")
	}
}

func TestChooseEventErrors(t *testing.T) {
	g := eventGame()
	if err := g.ChooseEvent(0); err != ErrNoEvent {
		t.Errorf("выбор без события: %v, хотим %v", err, ErrNoEvent)
	}
	forceEvent(g, EventAudit)
	g.Tick()
	if err := g.ChooseEvent(5); err != ErrBadOption {
		t.Errorf("несуществующая опция: %v, хотим %v", err, ErrBadOption)
	}
}

func TestAutoResolveOnDayEnd(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventStar)
	g.Tick()
	if g.ActiveEvent == nil {
		t.Fatal("событие должно висеть")
	}
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	joined := strings.Join(g.EventLog, "; ")
	if !strings.Contains(joined, "ушёл") {
		t.Errorf("авторезолв не залогирован: %v", g.EventLog)
	}
	if g.ActiveEvent != nil {
		t.Error("событие висит после конца дня")
	}
}

func TestNextDayResetsEventState(t *testing.T) {
	g := eventGame()
	forceEvent(g, EventVirus)
	g.Tick()
	g.Offices[0].Employees[0].OffendedUntil = g.cfg.DayTicks()
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].VirusUntil != 0 || g.Offices[0].Employees[0].OffendedUntil != 0 {
		t.Error("ночной ресет не очистил вирус и обиду")
	}
	if g.DeadlineOn || g.ActiveEvent != nil || g.EventLog != nil {
		t.Error("ночной ресет не очистил состояние событий")
	}
}

func TestActiveEventInfoAllTypes(t *testing.T) {
	g := eventGame()
	for _, id := range []EventID{EventVirus, EventDeadline, EventAudit, EventRaise, EventStar} {
		forceEvent(g, id)
		g.Tick()
		info := g.ActiveEventInfo()
		if info == nil || info.ID != string(id) || info.Title == "" || info.Text == "" || len(info.Options) == 0 {
			t.Fatalf("снапшот события %q кривой: %+v", id, info)
		}
		g.ActiveEvent.Resolved = true
		g.ActiveEvent = nil
	}
}

// Аудит, стоящий в очереди за чужим неотвеченным тостом, чек в 18:00 всё
// равно возьмёт — прогноз обязан его учесть (ITGAME-50, ревью).
func TestForecastAuditFineBehindOtherToast(t *testing.T) {
	g := eventGame()
	g.cfg.AuditFineShare = 0.2
	g.PrevDayIncome = 1000
	g.DayEvents = []DayEvent{
		{ID: EventRaise, Tick: 20, Office: 0, Slot: 0},
		{ID: EventAudit, Tick: 22},
	}
	base := func() int {
		ev, act := g.DayEvents, g.ActiveEvent
		g.DayEvents, g.ActiveEvent = nil, nil
		f := g.ForecastEndOfDay()
		g.DayEvents, g.ActiveEvent = ev, act
		return f
	}
	for g.ActiveEvent == nil {
		g.Tick()
	}
	if g.ActiveEvent.ID != EventRaise {
		t.Fatalf("первым должен висеть тост повышения, а висит %s", g.ActiveEvent.ID)
	}
	if got := g.ForecastEndOfDay(); got != base() {
		t.Errorf("аудит ещё не наступил: прогноз %d, хотим %d", got, base())
	}
	for g.TickInDay < 23 {
		g.Tick()
	}
	if g.ActiveEvent == nil || g.ActiveEvent.ID != EventRaise {
		t.Fatal("тост повышения должен висеть, аудит — в очереди")
	}
	if got := g.ForecastEndOfDay(); got != base()-200 {
		t.Errorf("аудит за чужим тостом: прогноз %d, хотим %d", got, base()-200)
	}
}

// Правило владельца (ITGAME-50) и подобранное sim значение: аудит с дня 5,
// штраф — 15% дохода прошлого дня.
func TestAuditDefaults(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.AuditMinDay != 5 {
		t.Errorf("AuditMinDay = %d, хотим 5", cfg.AuditMinDay)
	}
	if cfg.AuditFineShare != 0.15 {
		t.Errorf("AuditFineShare = %v, хотим 0.15", cfg.AuditFineShare)
	}
}
