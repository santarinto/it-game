package game

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// Подписка на антивирус (ITGAME-137): GDD «Вирус (ITGAME-103)», раздел
// «Подписка на антивирус». SOHO Edition 4 места $12, One Office 15 мест $40,
// Enterprise все $90 в день (норма), ×WageK; первые N мест компании в порядке
// core; защищённое место не заражается, заражённое не лечится; день платит по
// самому дорогому тарифу, включённому за день.

// coveredSlots — места офиса под подпиской.
func coveredSlots(g *Game, oi int) []int {
	var out []int
	for i, c := range g.AVCovered()[oi] {
		if c {
			out = append(out, i)
		}
	}
	return out
}

func TestAntivirusTiersByDifficulty(t *testing.T) {
	want := map[Difficulty][3]int{
		DiffEasy: {10, 32, 72}, DiffNormal: {12, 40, 90}, DiffHard: {15, 50, 113}, DiffHardcore: {18, 60, 135},
	}
	for d, prices := range want {
		cfg := ConfigForDifficulty(d)
		if len(cfg.AntivirusTiers) != 3 {
			t.Fatalf("%s: тарифов %d", d, len(cfg.AntivirusTiers))
		}
		for i, tier := range cfg.AntivirusTiers {
			if tier.PricePerDay != prices[i] {
				t.Errorf("%s: %s $%d, хотим $%d", d, tier.Name, tier.PricePerDay, prices[i])
			}
		}
	}
	def := DefaultConfig().AntivirusTiers
	if def[0] != (AntivirusTier{"SOHO Edition", 4, 12}) || def[1] != (AntivirusTier{"One Office", 15, 40}) || def[2] != (AntivirusTier{"Enterprise", 0, 90}) {
		t.Errorf("тарифы: %+v", def)
	}
	// ApplyDifficulty копирует слайс: базовый конфиг общий для всех сессий.
	base := DefaultConfig()
	_ = ApplyDifficulty(base, DiffHardcore)
	if base.AntivirusTiers[0].PricePerDay != 12 {
		t.Error("ApplyDifficulty переписал тарифы базового конфига")
	}
}

func TestAntivirusCoversFirstSeatsInCoreOrder(t *testing.T) {
	g := virusGame(3)
	o2 := &g.Offices[1]
	o2.Unlocked, o2.PCs, o2.Employees = true, 3, testStaff(3)
	if err := g.SetAntivirus(1); err != nil { // SOHO: 4 места
		t.Fatal(err)
	}
	if a, b := coveredSlots(g, 0), coveredSlots(g, 1); !slices.Equal(a, []int{0, 1, 2}) || !slices.Equal(b, []int{0}) {
		t.Fatalf("SOHO: офис 1 %v, офис 2 %v — хотим [0 1 2] и [0]", a, b)
	}
	// От сети не зависит: роутеров и core нет, покрытие то же.
	if g.Offices[0].RouterTier != 0 || g.CoreLevel != 0 {
		t.Fatal("тест держит компанию без сети")
	}
	// Увольнение сдвигает порядок, как у core.
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	if a, b := coveredSlots(g, 0), coveredSlots(g, 1); !slices.Equal(a, []int{0, 1}) || !slices.Equal(b, []int{0, 1}) {
		t.Fatalf("после увольнения: %v / %v — хотим [0 1] / [0 1]", a, b)
	}
	if err := g.SetAntivirus(3); err != nil { // Enterprise: все
		t.Fatal(err)
	}
	if n := g.AVCoveredCount(); n != 5 {
		t.Errorf("Enterprise покрывает %d из 5", n)
	}
}

func TestAntivirusBlocksOutbreakAndWave(t *testing.T) {
	// Офис целиком под подпиской — вспышка отбита, карточка про подписку.
	g := virusGame(4)
	if err := g.SetAntivirus(1); err != nil {
		t.Fatal(err)
	}
	forceEvent(g, EventVirus)
	g.Tick()
	if g.infectedCount() != 0 || g.ActiveEvent == nil || !g.ActiveEvent.Repelled {
		t.Fatalf("SOHO на 4 места: заражено %d, карточка %+v", g.infectedCount(), g.ActiveEvent)
	}
	info := g.ActiveEventInfo()
	if info.Title != "Вирус отбит" || info.Text != "Подписка SOHO Edition защитила офис 1: ни одно место не заражено." ||
		!slices.Equal(info.Options, []string{"Принять к сведению"}) {
		t.Fatalf("карточка «отбит»: %+v", info)
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "отбит подпиской SOHO Edition") {
		t.Errorf("журнал: %v", g.EventLog)
	}
	// Частичное покрытие: вспышка садится только на незащищённые места.
	g = virusGame(9)
	if err := g.SetAntivirus(1); err != nil {
		t.Fatal(err)
	}
	if k := g.seedOutbreak(0); k != 3 {
		t.Fatalf("вспышка %d мест, хотим 3", k)
	}
	for _, i := range infectedSlots(g, 0) {
		if i < 4 {
			t.Errorf("заражено защищённое место %d", i+1)
		}
	}
	// Волна мимо защищённых: у места 5 соседи 1 (защищено), 6, 9.
	g = virusGame(9)
	if err := g.SetAntivirus(1); err != nil {
		t.Fatal(err)
	}
	g.infect(&g.Offices[0].Employees[4])
	for i := 0; i < 20; i++ {
		g.VirusWaveIn = 1
		g.Tick()
	}
	for _, i := range infectedSlots(g, 0) {
		if i < 4 {
			t.Fatalf("волна заразила защищённое место %d: %v", i+1, infectedSlots(g, 0))
		}
	}
}

func TestAntivirusDoesNotCure(t *testing.T) {
	g := virusGame(4)
	g.infect(&g.Offices[0].Employees[0])
	if err := g.SetAntivirus(1); err != nil {
		t.Fatal(err)
	}
	if !g.Offices[0].Employees[0].Infected {
		t.Fatal("подписка вылечила заражённое место")
	}
	// Заражённое под подпиской заражает дальше — но только незащищённых, а их нет.
	g.VirusWaveIn = 1
	g.Tick()
	if n := g.infectedCount(); n != 1 {
		t.Errorf("заражено %d, хотим 1", n)
	}
}

func TestAntivirusBillingMostExpensiveOfDay(t *testing.T) {
	g := virusGame(2)
	payroll := g.PayrollPerDay()
	if err := g.SetAntivirus(2); err != nil { // One Office утром
		t.Fatal(err)
	}
	if err := g.SetAntivirus(0); err != nil { // отключил днём
		t.Fatal(err)
	}
	if got := g.PayrollPerDay() - payroll; got != 40 {
		t.Fatalf("подключил-отключил: расход дня +%d, хотим +40", got)
	}
	r := finishDay(t, g)
	if r.Antivirus != 40 || r.Payroll != payroll || r.Profit != r.Income+r.EventMoney-r.Payroll-r.Antivirus {
		t.Fatalf("отчёт: %+v", r)
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.AVTierBilled != 0 || g.PayrollPerDay() != payroll {
		t.Errorf("новый день без подписки: billed %d, расход %d", g.AVTierBilled, g.PayrollPerDay())
	}
	// Понижение днём: день платит по старшему, следующий — по новому.
	if err := g.SetAntivirus(3); err != nil {
		t.Fatal(err)
	}
	if err := g.SetAntivirus(1); err != nil {
		t.Fatal(err)
	}
	if r := finishDay(t, g); r.Antivirus != 90 {
		t.Errorf("Enterprise → SOHO днём: списано %d, хотим 90", r.Antivirus)
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if r := finishDay(t, g); r.Antivirus != 12 {
		t.Errorf("следующий день на SOHO: %d, хотим 12", r.Antivirus)
	}
}

func TestSetAntivirusErrors(t *testing.T) {
	g := virusGame(2)
	for _, c := range []struct {
		tier int
		want error
	}{{-1, ErrBadTier}, {4, ErrBadTier}, {0, ErrAntivirusAlready}} {
		if err := g.Apply(CmdSetAntivirus, 0, c.tier); err != c.want {
			t.Errorf("set_antivirus %d: %v, хотим %v", c.tier, err, c.want)
		}
	}
	if err := g.Apply(CmdSetAntivirus, 0, 1); err != nil {
		t.Fatal(err)
	}
	if err := g.Apply(CmdSetAntivirus, 0, 1); err != ErrAntivirusAlready {
		t.Errorf("повтор тарифа: %v", err)
	}
	g.Money = 39 // One Office $40 не по карману
	if err := g.SetAntivirus(2); err != ErrNotEnoughMoney || g.AVTier != 1 {
		t.Errorf("повышение без денег: %v, тариф %d", err, g.AVTier)
	}
	g.Money = -500 // в минусе: повышать нельзя, отключать — можно
	if err := g.SetAntivirus(3); err != ErrNotEnoughMoney {
		t.Errorf("в минусе повышение: %v", err)
	}
	if err := g.SetAntivirus(0); err != nil || g.AVTier != 0 || g.AVTierBilled != 1 {
		t.Errorf("отключение в минусе: %v, тариф %d, billed %d", err, g.AVTier, g.AVTierBilled)
	}
	// Подписка — не покупка: деньги сразу не списываются.
	if g.Money != -500 {
		t.Errorf("баланс %d, подписка списывается только вечером", g.Money)
	}
}

func TestAntivirusLedgerAndDayProfit(t *testing.T) {
	g := ledgerGame()
	if err := g.SetAntivirus(2); err != nil {
		t.Fatal(err)
	}
	for g.TickInDay < 10 {
		g.Tick()
	}
	r := finishDay(t, g)
	l, ok := g.LedgerOf(0)
	if !ok {
		t.Fatal("нет книги")
	}
	checkLedger(t, l)
	if l.Antivirus != 40 || l.Payroll != r.Payroll || l.Profit() != r.Profit {
		t.Errorf("книга: antivirus %d payroll %d profit %d, отчёт %+v", l.Antivirus, l.Payroll, l.Profit(), r)
	}
	if g.DayProfit() != r.Profit {
		t.Errorf("линия дня в отчёте %d, «Прибыль» %d", g.DayProfit(), r.Profit)
	}
}

func TestAntivirusOfflineEveryDay(t *testing.T) {
	cfg := offlineTestConfig()
	g := NewWithSeed(cfg, 1, 2)
	o := &g.Offices[0]
	o.PCs, o.Employees = 1, testStaff(1)
	g.Money = 10000
	g.beginLedger() // книга дня — с баланса после правки
	if err := g.SetAntivirus(1); err != nil {
		t.Fatal(err)
	}
	s := g.AdvanceOffline(3*cfg.DayTicks() + 1)
	if want := 3 * (250 + 12); s.Payroll != want {
		t.Errorf("офлайн 3 дня: списано %d, хотим %d", s.Payroll, want)
	}
	books := g.LedgerHistory
	if len(books) < 3 {
		t.Fatalf("книг %d", len(books))
	}
	for _, l := range books[len(books)-3:] {
		checkLedger(t, l)
		if l.Antivirus != 12 {
			t.Errorf("день %d: antivirus %d", l.Day, l.Antivirus)
		}
	}
	if g.AVTier != 1 || g.AVTierBilled != 1 {
		t.Errorf("после офлайна тариф %d/%d", g.AVTier, g.AVTierBilled)
	}
}

func TestBankruptInDaysCountsAntivirus(t *testing.T) {
	g := doomedGame(t, DiffHard)
	o := &g.Offices[0]
	o.Boss = ""
	o.PCs = 3
	g.Money = -100
	o.Employees = []Employee{
		{Name: "Артём Никитин", IncomePerTick: 7, HireDay: 1},
		{Name: "Мария Фёдорова", IncomePerTick: 7, HireDay: 1},
		{Name: "Дмитрий Смирнов", IncomePerTick: 7, HireDay: 1},
	}
	before := g.BankruptInDays()
	g.AVTier, g.AVTierBilled = 3, 3 // Enterprise $113/день на Hard
	after := g.BankruptInDays()
	if after == 0 || (before != 0 && after >= before) {
		t.Fatalf("подписка не приблизила банкротство: без неё %d, с ней %d", before, after)
	}
}

func TestVirusCardOffersSubscription(t *testing.T) {
	g := virusGame(4)
	g.Money = 10000
	forceEvent(g, EventVirus)
	g.Tick()
	if err := g.ChooseEvent(1); err != nil {
		t.Fatal(err)
	}
	if g.AVTier != 1 || g.ActiveEvent != nil || len(infectedSlots(g, 0)) != 1 {
		t.Fatalf("опция «Подписка»: тариф %d, карточка %v, заражено %v — подписка не лечит", g.AVTier, g.ActiveEvent, infectedSlots(g, 0))
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "подписка SOHO Edition ($12/день)") {
		t.Errorf("журнал: %v", g.EventLog)
	}
	// Штат больше тарифа — карточка предлагает самый дешёвый, покрывающий всех.
	g = virusGame(9)
	if err := g.SetAntivirus(1); err != nil {
		t.Fatal(err)
	}
	forceEvent(g, EventVirus)
	g.Tick()
	if info := g.ActiveEventInfo(); len(info.Options) != 2 || info.Options[1] != "Подписка One Office $40/день" {
		t.Fatalf("апгрейд: %+v", info.Options)
	}
	g.Money = 10 // не хватает — карточка висит
	if err := g.ChooseEvent(1); err != ErrNotEnoughMoney || g.ActiveEvent == nil {
		t.Errorf("без денег: %v, карточка %v", err, g.ActiveEvent)
	}
	// Текущий тариф покрывает всех — опции нет. Заражение вошло до подписки,
	// поэтому вспышка не отбита: в офисе есть заражённое место.
	g = virusGame(9)
	g.infect(&g.Offices[0].Employees[8])
	if err := g.SetAntivirus(2); err != nil {
		t.Fatal(err)
	}
	forceEvent(g, EventVirus)
	g.Tick()
	if g.ActiveEvent == nil || g.ActiveEvent.Repelled {
		t.Fatalf("карточка: %+v", g.ActiveEvent)
	}
	if info := g.ActiveEventInfo(); len(info.Options) != 1 {
		t.Errorf("тариф покрывает всех — опций %v, хотим одну", info.Options)
	}
	if err := g.ChooseEvent(1); err != ErrBadOption {
		t.Errorf("опция 1 без предложения: %v", err)
	}
}

func TestAntivirusSaveRoundtrip(t *testing.T) {
	g := virusGame(2)
	if err := g.SetAntivirus(3); err != nil {
		t.Fatal(err)
	}
	if err := g.SetAntivirus(1); err != nil {
		t.Fatal(err)
	}
	r := saveRoundtrip(t, g)
	if r.AVTier != 1 || r.AVTierBilled != 3 {
		t.Fatalf("после сейва тариф %d/%d, хотим 1/3", r.AVTier, r.AVTierBilled)
	}
	// Сейв формата 1 без тарифов в конфиге: тарифы уровня сейва, формат не поднят.
	cfg := ConfigForDifficulty(DiffHard)
	h := NewWithSeed(cfg, 1, 2)
	raw, _ := json.Marshal(h.Export())
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	delete(m["config"].(map[string]any), "AntivirusTiers")
	raw, _ = json.Marshal(m)
	var s Save
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	r, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if tiers := r.Config().AntivirusTiers; len(tiers) != 3 || tiers[2].PricePerDay != 113 {
		t.Errorf("тарифы старого сейва Hard: %+v", tiers)
	}
	// Тариф за пределами конфига — битый сейв.
	bad := g.Export()
	bad.AVTier = 9
	if _, err := Restore(bad); err == nil {
		t.Error("avTier 9 восстановился")
	}
}
