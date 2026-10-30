package game

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
)

// Рабочие места (ITGAME-135): GDD «Рабочее место: уровни ПК и износ». Уровень
// и износ живут на месте (Office.Workplaces), не на сотруднике; поломка — +1 к
// износу, поломка при PCWearLimit выводит ПК из строя — «требуется замена».

// pcGame — день 1, тик 0, офис 1 со штатом n по $10/тик за n новыми ПК, $10000,
// кулер и холодильник куплены; поломок и событий нет (offlineTestConfig).
func pcGame(n int) *Game { return pcGameCfg(offlineTestConfig(), n) }

func pcGameCfg(cfg Config, n int) *Game { return pcGameSeed(cfg, n, 1) }

func pcGameSeed(cfg Config, n int, seed uint64) *Game {
	g := NewWithSeed(cfg, seed, 2)
	g.Money = 10000
	o := &g.Offices[0]
	o.PCs = n
	o.Employees = testStaff(n)
	o.Workplaces = make([]Workplace, n)
	o.Cooler, o.Fridge = true, true
	return g
}

// breakCfg — каждый тик в офисе ломается ПК, если ещё ничего не сломано;
// бюджета событий дня нет (ITGAME-196): тестам износа нужно больше поломок за день.
func breakCfg() Config {
	cfg := offlineTestConfig()
	cfg.BreakdownChancePermille = 1000
	cfg.EventBudget = 0
	return cfg
}

func TestPCLevelsByDifficulty(t *testing.T) {
	cfg := DefaultConfig()
	names := []string{"ЭЛТ", "ЖК", "2×ЖК"}
	mults := []float64{1.0, 1.1, 1.2}
	if len(cfg.PCLevels) != 3 || cfg.PCWearLimit != 8 {
		t.Fatalf("уровней %d, износ %d; хотим 3 и 8", len(cfg.PCLevels), cfg.PCWearLimit)
	}
	for i, l := range cfg.PCLevels {
		if l.Name != names[i] || l.Mult != mults[i] {
			t.Errorf("уровень %d: %+v, хотим %s ×%.1f", i, l, names[i], mults[i])
		}
	}
	prices := map[Difficulty][3]int{
		DiffNormal:   {0, 350, 600},
		DiffEasy:     {0, 280, 480},
		DiffHard:     {0, 438, 750},
		DiffHardcore: {0, 525, 900},
	}
	for d, want := range prices {
		c := ConfigForDifficulty(d)
		for i := range want {
			if c.PCLevels[i].Price != want[i] {
				t.Errorf("%s: цена уровня %d = %d, хотим %d", d, i, c.PCLevels[i].Price, want[i])
			}
		}
	}
	wear := map[Difficulty]int{DiffEasy: 8, DiffNormal: 8, DiffHard: 24, DiffHardcore: 40}
	for d, want := range wear {
		if got := ConfigForDifficulty(d).PCWearLimit; got != want {
			t.Errorf("%s: предел износа %d, хотим %d", d, got, want)
		}
	}
	c1 := ConfigForDifficulty(DiffNormal)
	c1.PCLevels[1].Price = 1
	if c2 := ConfigForDifficulty(DiffNormal); c2.PCLevels[1].Price != 350 {
		t.Errorf("правка PCLevels протекла во второй конфиг: %d", c2.PCLevels[1].Price)
	}
}

func TestPCLevelMult(t *testing.T) {
	g := pcGame(1)
	o := &g.Offices[0]
	for lvl, want := range []int{10, 11, 12} {
		o.Workplaces[0].Level = lvl
		if got := g.IncomePerTick(); got != want {
			t.Errorf("уровень %d без сети: доход %d, хотим %d", lvl, got, want)
		}
	}
	o.Workplaces[0].Level = 1
	if got := g.EffectiveIncomePerTick(o, 0); got != 11 {
		t.Errorf("тултип на уровне 1 = %d, хотим 11", got)
	}

	// Цепочка роутер + core + сервер: ×1.3, множитель ПК — до сети.
	n := pcGame(1)
	no := &n.Offices[0]
	no.RouterTier, n.CoreLevel, no.Servers = 1, 1, []int{1}
	if got := n.IncomePerTick(); got != 13 {
		t.Errorf("цепочка, ЭЛТ: %d, хотим 13", got)
	}
	no.Workplaces[0].Level = 1
	if got := n.IncomePerTick(); got != 14 {
		t.Errorf("цепочка, ЖК: %d, хотим round(10×1.1×1.3)=14", got)
	}

	// Прибавка уровня сотрудника — до множителя ПК: round((10+1)×1.1).
	x := pcGame(1)
	x.Offices[0].Employees[0].XP = 96
	x.Offices[0].Workplaces[0].Level = 1
	if got := x.IncomePerTick(); got != 12 {
		t.Errorf("уровень сотрудника 1 + ЖК: %d, хотим 12", got)
	}
}

func TestPCUpgrade(t *testing.T) {
	g := pcGame(1)
	o := &g.Offices[0]
	if p := g.NextPCLevelPrice(0, 0); p != 350 {
		t.Errorf("цена до ЖК = %d, хотим 350", p)
	}
	before := g.Money
	if err := g.Apply(CmdUpgradePC, 0, 0); err != nil {
		t.Fatal(err)
	}
	if o.Workplaces[0].Level != 1 || g.Money != before-350 {
		t.Errorf("после апгрейда: уровень %d, деньги %d (было %d)", o.Workplaces[0].Level, g.Money, before)
	}
	if last := g.Ledger.Purchases[len(g.Ledger.Purchases)-1]; last.Type != "upgrade_pc" || last.Price != 350 {
		t.Errorf("книга дня: %+v", last)
	}
	if p := g.NextPCLevelPrice(0, 0); p != 600 {
		t.Errorf("цена до 2×ЖК = %d, хотим 600", p)
	}
	o.Workplaces[0].Wear = 2
	before = g.Money
	if err := g.Apply(CmdUpgradePC, 0, 0); err != nil {
		t.Fatal(err)
	}
	if o.Workplaces[0] != (Workplace{Level: 2, Wear: 2}) || g.Money != before-600 {
		t.Errorf("второй апгрейд: %+v, деньги %d (было %d); износ должен сохраниться", o.Workplaces[0], g.Money, before)
	}
	before = g.Money
	if err := g.Apply(CmdUpgradePC, 0, 0); err != ErrPCMaxLevel || g.Money != before {
		t.Errorf("третий апгрейд: %v, деньги %d → %d; хотим %v без списания", err, before, g.Money, ErrPCMaxLevel)
	}
	if p := g.NextPCLevelPrice(0, 0); p != 0 {
		t.Errorf("цена на максимуме = %d, хотим 0", p)
	}
	for _, slot := range []int{-1, 1} {
		if err := g.Apply(CmdUpgradePC, 0, slot); err != ErrBadSlot {
			t.Errorf("slot %d: %v, хотим %v", slot, err, ErrBadSlot)
		}
		if p := g.NextPCLevelPrice(0, slot); p != 0 {
			t.Errorf("цена стола %d = %d, хотим 0", slot, p)
		}
	}

	poor := pcGame(1)
	poor.Money = 349
	if err := poor.Apply(CmdUpgradePC, 0, 0); err != ErrNotEnoughMoney {
		t.Errorf("без денег: %v", err)
	}

	// Свободный стол с ПК апгрейдится: уровень живёт на месте.
	free := pcGame(1)
	free.Offices[0].PCs = 2
	free.Offices[0].syncWorkplaces()
	if err := free.Apply(CmdUpgradePC, 0, 1); err != nil || free.Offices[0].Workplaces[1].Level != 1 {
		t.Errorf("свободный стол: %v, %+v", err, free.Offices[0].Workplaces)
	}

	dead := pcGame(1)
	dead.Offices[0].Workplaces[0].Dead = true
	before = dead.Money
	if err := dead.Apply(CmdUpgradePC, 0, 0); err != ErrPCDead || dead.Money != before {
		t.Errorf("мёртвый ПК: %v", err)
	}
	if p := dead.NextPCLevelPrice(0, 0); p != 0 {
		t.Errorf("цена апгрейда мёртвого = %d, хотим 0", p)
	}
}

func TestPCWearPerBreakdown(t *testing.T) {
	g := pcGameCfg(breakCfg(), 1)
	o := &g.Offices[0]
	e := &o.Employees[0]
	g.Tick()
	if !e.PCBroken || o.Workplaces[0].Wear != 1 || g.DayIncidents != 1 {
		t.Fatalf("первая поломка: broken=%v wear=%d incidents=%d", e.PCBroken, o.Workplaces[0].Wear, g.DayIncidents)
	}
	for i := 0; i < 20 && e.PCBroken; i++ { // клики
		if err := g.RepairClick(0, 0); err != nil {
			t.Fatal(err)
		}
	}
	if e.PCBroken || o.Workplaces[0].Wear != 1 {
		t.Fatalf("после кликов: broken=%v wear=%d, хотим целый ПК и износ 1", e.PCBroken, o.Workplaces[0].Wear)
	}
	g.Tick()
	if !e.PCBroken || o.Workplaces[0].Wear != 2 {
		t.Fatalf("вторая поломка: broken=%v wear=%d", e.PCBroken, o.Workplaces[0].Wear)
	}
	if err := g.CallMaster(0, 0); err != nil || o.Workplaces[0].Wear != 2 {
		t.Fatalf("мастер: %v, износ %d, хотим 2", err, o.Workplaces[0].Wear)
	}
	g.AdminDept, o.Admin = true, "Админ"
	g.Tick()
	if !e.PCBroken || o.Workplaces[0].Wear != 3 {
		t.Fatalf("третья поломка: broken=%v wear=%d", e.PCBroken, o.Workplaces[0].Wear)
	}
	for i := 0; i < 20 && e.PCBroken; i++ { // админ
		g.Tick()
	}
	if e.PCBroken || o.Workplaces[0].Wear != 3 || o.Workplaces[0].Dead {
		t.Errorf("после админа: broken=%v %+v, хотим целый живой ПК с износом 3", e.PCBroken, o.Workplaces[0])
	}
}

func TestPCDiesAtWearLimit(t *testing.T) {
	g := pcGameCfg(breakCfg(), 1)
	o := &g.Offices[0]
	o.Workplaces[0].Wear = g.cfg.PCWearLimit
	g.Tick()
	e := &o.Employees[0]
	if !o.Workplaces[0].Dead || e.PCBroken || e.RepairNeeded != 0 || g.DayIncidents != 1 {
		t.Fatalf("после смерти: %+v broken=%v need=%d incidents=%d", o.Workplaces[0], e.PCBroken, e.RepairNeeded, g.DayIncidents)
	}
	if last := g.EventLog[len(g.EventLog)-1]; !strings.HasSuffix(last, "ПК места 1 (офис 1) выработал ресурс — требуется замена") {
		t.Errorf("строка журнала: %q", last)
	}
	if inc := g.IncomePerTick(); inc != 0 {
		t.Errorf("доход мёртвого места %d, хотим 0", inc)
	}
	if g.DayLostIncome == 0 {
		t.Errorf("упущенное не растёт: DayLostIncome=0")
	}
	// Единственное место мертво — на втором тике нет ни одного ролла.
	before := g.RNGState()
	g.Tick()
	if !bytes.Equal(before, g.RNGState()) {
		t.Errorf("второй тик потратил RNG")
	}
	if !o.Workplaces[0].Dead || g.DayIncidents != 1 {
		t.Errorf("мёртвое место сломалось снова: %+v incidents=%d", o.Workplaces[0], g.DayIncidents)
	}
}

func TestPCDeadSeatOutOfBreakdownPool(t *testing.T) {
	for seed := uint64(1); seed <= 30; seed++ {
		g := pcGameSeed(breakCfg(), 3, seed)
		o := &g.Offices[0]
		o.Workplaces[0].Dead = true
		g.Tick()
		if !o.Workplaces[0].Dead || o.Employees[0].PCBroken {
			t.Fatalf("сид %d: мёртвое место сломалось или ожило", seed)
		}
		n := 0
		for i := 1; i < 3; i++ {
			if o.Employees[i].PCBroken {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("сид %d: сломано %d живых мест, хотим ровно 1 (мёртвое кап не держит)", seed, n)
		}
	}
}

func TestPCDeadSeatOutOfVirusAndAdmin(t *testing.T) {
	for seed := uint64(1); seed <= 30; seed++ {
		g := pcGameSeed(offlineTestConfig(), 4, seed)
		o := &g.Offices[0]
		o.Workplaces[0].Dead = true
		if k := g.seedOutbreak(0); k != 1 || o.Employees[0].Infected {
			t.Fatalf("сид %d: вспышка k=%d, мёртвое место заражено=%v", seed, k, o.Employees[0].Infected)
		}
	}

	g := pcGame(4)
	o := &g.Offices[0]
	o.Workplaces[0].Dead = true
	o.RouterTier, g.CoreLevel = 1, 1
	for i := 1; i < 4; i++ {
		g.infect(&o.Employees[i])
	}
	g.VirusWaveIn = 1
	g.tickVirus()
	if o.Employees[0].Infected {
		t.Errorf("волна заразила мёртвое место")
	}

	a := pcGame(4)
	a.AdminDept = true
	ao := &a.Offices[0]
	ao.Admin = "Админ"
	ao.Workplaces[0].Dead = true
	if slot, kind := ao.AdminTarget(); slot != -1 || kind != "" {
		t.Errorf("админ нашёл цель %d %q на мёртвом месте", slot, kind)
	}
	a.adminTick(cleanedByAdmin)
	if !ao.Workplaces[0].Dead {
		t.Errorf("админ оживил мёртвое место")
	}
	a.accrueXP()
	if ao.Employees[0].XP != 0 || ao.Employees[1].XP == 0 {
		t.Errorf("опыт: мёртвое %d, живое %d — хотим 0 и >0", ao.Employees[0].XP, ao.Employees[1].XP)
	}
}

func TestPCDeathTakesInfection(t *testing.T) {
	g := pcGameCfg(breakCfg(), 1)
	o := &g.Offices[0]
	o.Workplaces[0].Wear = g.cfg.PCWearLimit
	g.infect(&o.Employees[0])
	g.VirusWaveIn = 18
	g.Tick()
	e := &o.Employees[0]
	if !o.Workplaces[0].Dead || e.Infected || e.VirusClicks != 0 || g.VirusWaveIn != 0 {
		t.Errorf("смерть заражённого: %+v infected=%v clicks=%d wave=%d", o.Workplaces[0], e.Infected, e.VirusClicks, g.VirusWaveIn)
	}
}

func TestPCRepairOnDeadSeat(t *testing.T) {
	g := pcGame(1)
	g.Offices[0].Workplaces[0].Dead = true
	before := g.Money
	if err := g.RepairClick(0, 0); err != ErrPCDead {
		t.Errorf("repair_click: %v, хотим %v", err, ErrPCDead)
	}
	if err := g.CallMaster(0, 0); err != ErrPCDead {
		t.Errorf("call_master: %v, хотим %v", err, ErrPCDead)
	}
	if g.Money != before {
		t.Errorf("деньги %d → %d", before, g.Money)
	}
}

func TestPCReplace(t *testing.T) {
	g := pcGame(1)
	o := &g.Offices[0]
	o.Workplaces[0] = Workplace{Level: 2, Wear: 3, Dead: true}
	before := g.Money
	if err := g.Apply(CmdReplacePC, 0, 0); err != nil {
		t.Fatal(err)
	}
	if o.Workplaces[0] != (Workplace{}) || g.Money != before-500 {
		t.Errorf("замена мёртвого: %+v, деньги %d → %d", o.Workplaces[0], before, g.Money)
	}
	if last := g.Ledger.Purchases[len(g.Ledger.Purchases)-1]; last.Type != "replace_pc" || last.Price != 500 {
		t.Errorf("книга дня: %+v", last)
	}
	if inc := g.IncomePerTick(); inc != 10 {
		t.Errorf("доход после замены %d, хотим 10", inc)
	}

	// Изношенный живой, сломанный и заражённый ПК: замена ставит целый и чистый.
	w := pcGame(1)
	wo := &w.Offices[0]
	wo.Workplaces[0] = Workplace{Level: 2, Wear: 2}
	wo.Employees[0].PCBroken, wo.Employees[0].RepairNeeded = true, 5
	w.infect(&wo.Employees[0])
	w.VirusWaveIn = 18
	if err := w.ReplacePC(0, 0); err != nil {
		t.Fatal(err)
	}
	if e := wo.Employees[0]; wo.Workplaces[0] != (Workplace{}) || e.PCBroken || e.RepairNeeded != 0 || e.Infected || w.VirusWaveIn != 0 {
		t.Errorf("после замены: %+v %+v wave=%d", wo.Workplaces[0], e, w.VirusWaveIn)
	}

	fresh := pcGame(1)
	if err := fresh.ReplacePC(0, 0); err != ErrPCFresh {
		t.Errorf("новый ПК: %v, хотим %v", err, ErrPCFresh)
	}
	poor := pcGame(1)
	poor.Offices[0].Workplaces[0].Wear = 1
	poor.Money = 499
	if err := poor.ReplacePC(0, 0); err != ErrNotEnoughMoney {
		t.Errorf("без денег: %v", err)
	}
	for _, slot := range []int{-1, 1} {
		if err := g.ReplacePC(0, slot); err != ErrBadSlot {
			t.Errorf("slot %d: %v, хотим %v", slot, err, ErrBadSlot)
		}
	}
	free := pcGame(1)
	free.Offices[0].PCs = 2
	free.Offices[0].syncWorkplaces()
	free.Offices[0].Workplaces[1].Dead = true
	if err := free.ReplacePC(0, 1); err != nil || free.Offices[0].Workplaces[1] != (Workplace{}) {
		t.Errorf("свободный мёртвый стол: %v %+v", err, free.Offices[0].Workplaces)
	}
	if hard := NewWithSeed(ConfigForDifficulty(DiffHard), 1, 2); hard.PCReplacePrice() != 625 {
		t.Errorf("цена замены на сложном %d, хотим 625", hard.PCReplacePrice())
	}
}

func TestPCFireKeepsDesks(t *testing.T) {
	g := pcGame(3)
	o := &g.Offices[0]
	o.PCs = 4
	o.Employees[0].Name, o.Employees[1].Name, o.Employees[2].Name = "A", "B", "C"
	o.Workplaces = []Workplace{{Level: 1, Wear: 1}, {Wear: 3, Dead: true}, {Level: 2}, {}}
	if err := g.Fire(0, 1); err != nil {
		t.Fatal(err)
	}
	if len(o.Employees) != 2 || o.Employees[0].Name != "A" || o.Employees[1].Name != "C" {
		t.Fatalf("штат после увольнения: %+v", o.Employees)
	}
	want := []Workplace{{Level: 1, Wear: 1}, {Level: 2}, {Wear: 3, Dead: true}, {}}
	if !slices.Equal(o.Workplaces, want) {
		t.Fatalf("места после увольнения: %+v, хотим %+v", o.Workplaces, want)
	}
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	if len(o.Employees) != 3 || !o.Workplace(2).Dead {
		t.Errorf("новый сотрудник должен сесть за первый свободный стол (мёртвый): %d, %+v", len(o.Employees), o.Workplaces)
	}
	// Увольнение последнего порядок не меняет.
	snap := slices.Clone(o.Workplaces)
	if err := g.Fire(0, 2); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(o.Workplaces, snap) {
		t.Errorf("увольнение последнего сдвинуло места: %+v → %+v", snap, o.Workplaces)
	}
}

func TestPCDeadFreeDeskDeadlock(t *testing.T) {
	g := NewWithSeed(offlineTestConfig(), 1, 2)
	g.Offices[0].Workplaces = []Workplace{{Dead: true}}
	g.Money = 600
	if c := g.MinCostToEarn(); c != 800 || !g.IsDeadlocked() {
		t.Errorf("мёртвый свободный стол: цена %d, тупик %v; хотим 800 и тупик", c, g.IsDeadlocked())
	}
	g.Offices[0].Workplaces[0].Dead = false
	if c := g.MinCostToEarn(); c != 300 || g.IsDeadlocked() {
		t.Errorf("живой стол: цена %d, тупик %v; хотим 300 и не тупик", c, g.IsDeadlocked())
	}
}

func TestPCDeadOffline(t *testing.T) {
	g := pcGame(2)
	g.Offices[0].Workplaces[1].Dead = true
	g.Money = 600
	if got, want := g.ForecastEndOfDay(), 600+48*10-2*250; got != want {
		t.Errorf("прогноз %d, хотим %d (платит одно место)", got, want)
	}
	s := g.AdvanceOffline(54 + 6)
	if s.Income != 540 {
		t.Errorf("офлайн-доход %d, хотим 540 (48×$10 дня 1 + 6×$10 дня 2, одно место)", s.Income)
	}
	if !g.Offices[0].Workplaces[1].Dead {
		t.Errorf("офлайн оживил мёртвое место")
	}
}

func TestPCDeadBankruptInDays(t *testing.T) {
	mk := func() *Game {
		g := NewWithSeed(DefaultConfig(), 1, 2)
		o := &g.Offices[0]
		o.Employees = []Employee{{Name: "Тест Тестов", IncomePerTick: 12}}
		o.Workplaces = make([]Workplace, 1)
		o.Cooler, o.Fridge = true, true
		g.Money = -100
		return g
	}
	g := mk()
	g.Offices[0].Workplaces[0].Dead = true
	if d := g.BankruptInDays(); d <= 0 {
		t.Errorf("мёртвый ПК: банкротство через %d дн., хотим > 0", d)
	}
	if !g.Offices[0].Workplaces[0].Dead {
		t.Errorf("прогноз оживил мёртвое место")
	}
	b := mk()
	b.Offices[0].Employees[0].PCBroken, b.Offices[0].Employees[0].RepairNeeded = true, 3
	if d := b.BankruptInDays(); d != 0 {
		t.Errorf("сломанный (не мёртвый) ПК: %d, хотим 0 — шаблон его чинит", d)
	}
}

func TestPCBuyPCAddsWorkplace(t *testing.T) {
	g := NewWithSeed(DefaultConfig(), 1, 2)
	g.Money = 10000
	o := &g.Offices[0]
	if len(o.Workplaces) != g.cfg.StartPCs {
		t.Fatalf("мест %d, хотим %d", len(o.Workplaces), g.cfg.StartPCs)
	}
	if err := g.BuyPC(0); err != nil {
		t.Fatal(err)
	}
	if len(o.Workplaces) != o.PCs || o.Workplaces[o.PCs-1] != (Workplace{}) {
		t.Errorf("после покупки: PCs %d, места %+v", o.PCs, o.Workplaces)
	}
}

func TestPCSaveRoundtrip(t *testing.T) {
	g := hiredGame(t)
	g.Offices[0].Workplaces[0] = Workplace{Level: 1, Wear: 2}
	s := g.Export()
	if s.Format != SaveFormat || SaveFormat != 8 {
		t.Errorf("формат %d / %d, хотим 8", s.Format, SaveFormat)
	}
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var back Save
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	r, err := Restore(back)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.Offices[0].Workplaces; !slices.Equal(got, []Workplace{{Level: 1, Wear: 2}}) {
		t.Errorf("места после реплея сейва: %+v", got)
	}
	if c := r.Config(); len(c.PCLevels) != 3 || c.PCLevels[1].Name != "ЖК" || c.PCWearLimit != 8 {
		t.Errorf("конфиг после сейва: %+v / %d", c.PCLevels, c.PCWearLimit)
	}
}

func TestPCRestoreNormalizes(t *testing.T) {
	s := NewWithSeed(DefaultConfig(), 1, 2).Export()
	s.Offices[0].PCs = 4 // дельта debug и фикстура правят PCs без мест
	g, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if got := g.Offices[0].Workplaces; len(got) != 4 || got[3] != (Workplace{}) {
		t.Errorf("добавление: %+v", got)
	}
	s = NewWithSeed(DefaultConfig(), 1, 2).Export()
	s.Offices[0].PCs = 0
	if g, err = Restore(s); err != nil || len(g.Offices[0].Workplaces) != 0 {
		t.Errorf("отрезание: %v %+v", err, g.Offices[0].Workplaces)
	}
}

func TestPCRestoreRejects(t *testing.T) {
	cases := map[string]func(s *Save){
		"level 3":          func(s *Save) { s.Offices[0].Workplaces[0].Level = 3 },
		"level -1":         func(s *Save) { s.Offices[0].Workplaces[0].Level = -1 },
		"wear -1":          func(s *Save) { s.Offices[0].Workplaces[0].Wear = -1 },
		"мёртвое сломано":  func(s *Save) { s.Offices[0].Workplaces[0].Dead = true; s.Offices[0].Employees[0].PCBroken = true },
		"мёртвое заражено": func(s *Save) { s.Offices[0].Workplaces[0].Dead = true; s.Offices[0].Employees[0].Infected = true },
		"format 1":         func(s *Save) { s.Format = 1 },
	}
	for name, mut := range cases {
		s := hiredGame(t).Export()
		mut(&s)
		if _, err := Restore(s); !errors.Is(err, ErrBadSave) {
			t.Errorf("%s: %v, хотим ErrBadSave", name, err)
		}
	}
}

func TestPCDeathDeterministic(t *testing.T) {
	run := func() ([]byte, int) {
		cfg := breakCfg()
		cfg.WinTarget = 0 // $1M на счету — это победа на первом же тике, а нужны 6 дней игры
		g := pcGameSeed(cfg, 3, 7)
		g.Money = 1_000_000
		replaced := 0
		for day := 0; day < 6; day++ {
			for g.Phase == PhaseRunning {
				g.Tick()
				for i := range g.Offices[0].Employees {
					if g.Offices[0].Employees[i].PCBroken {
						_ = g.CallMaster(0, i)
					}
					if g.Offices[0].Workplace(i).Dead && g.ReplacePC(0, i) == nil {
						replaced++
					}
				}
			}
			if g.Phase == PhaseDayReport {
				if err := g.NextDay(); err != nil {
					t.Fatal(err)
				}
			}
		}
		b, err := json.Marshal(g.Export())
		if err != nil {
			t.Fatal(err)
		}
		return b, replaced
	}
	a, n := run()
	b, _ := run()
	if !bytes.Equal(a, b) {
		t.Errorf("два прогона одного сида разошлись")
	}
	if n == 0 {
		t.Errorf("за 6 дней ни одной замены — смерть не случилась")
	}
}

func TestPCWearLimitZeroNeverKills(t *testing.T) {
	cfg := breakCfg()
	cfg.PCWearLimit = 0
	g := pcGameCfg(cfg, 1)
	g.Offices[0].Workplaces[0].Wear = 10
	g.Tick()
	if w := g.Offices[0].Workplaces[0]; w.Dead || !g.Offices[0].Employees[0].PCBroken || w.Wear != 11 {
		t.Errorf("PCWearLimit 0: %+v broken=%v, хотим поломку без смерти", w, g.Offices[0].Employees[0].PCBroken)
	}
}

func TestPCFixtureWornPCs(t *testing.T) {
	g, err := NewFixture(DefaultConfig(), "worn_pcs", "42")
	if err != nil {
		t.Fatal(err)
	}
	o := &g.Offices[0]
	if o.PCs != 6 || len(o.Employees) != 5 || len(o.Workplaces) != 6 || !o.Workplaces[2].Dead {
		t.Fatalf("worn_pcs: PCs=%d штат=%d места=%+v", o.PCs, len(o.Employees), o.Workplaces)
	}
	for i, e := range o.Employees {
		if e.PCBroken || e.Infected {
			t.Errorf("worn_pcs: место %d сломано или заражено", i)
		}
	}
	cfg := DefaultConfig()
	cfg.BreakdownChancePermille = 1000
	g, err = NewFixture(cfg, "worn_pcs", "42")
	if err != nil {
		t.Fatal(err)
	}
	g.Tick()
	o = &g.Offices[0]
	dead := 0
	for i := range o.Employees {
		if o.Workplace(i).Dead {
			dead++
		}
	}
	logged := false
	for _, l := range g.EventLog {
		logged = logged || strings.Contains(l, "выработал ресурс")
	}
	if dead != 2 || !o.Workplaces[2].Dead || !logged {
		t.Errorf("после тика: мёртвых %d (хотим 2: старое и одно новое), журнал %v", dead, logged)
	}
}
