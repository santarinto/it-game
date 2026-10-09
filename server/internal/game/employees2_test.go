package game

// Сотрудники 2.0 (итерация 15): увольнение, опыт/уровни, звёзды,
// менторство. Числа — GDD «Сотрудники 2.0» и спека итерации.

import (
	"strings"
	"testing"
)

// emp2Config — день без случайностей: поломки выключены, события дня 1
// не роллятся (New их не роллит), кофе нет.
func emp2Config() Config {
	cfg := DefaultConfig()
	cfg.BreakdownChancePct = 0
	return cfg
}

func TestFireFreesPC(t *testing.T) {
	g := New(emp2Config())
	g.Money = 10000
	g.Offices[0].PCs = 1
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	// Найм вторым — no_free_pc: ПК один.
	if err := g.Hire(0); err != ErrNoFreePC {
		t.Fatalf("второй найм: err = %v, хотим %v", err, ErrNoFreePC)
	}
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	if len(g.Offices[0].Employees) != 0 {
		t.Fatalf("после увольнения сотрудников %d, хотим 0", len(g.Offices[0].Employees))
	}
	if g.Offices[0].PCs != 1 {
		t.Fatalf("ПК должен остаться: %d, хотим 1", g.Offices[0].PCs)
	}
	// ПК освободился: найм работает без buy_pc.
	if err := g.Hire(0); err != nil {
		t.Fatalf("найм после увольнения: %v", err)
	}
}

func TestFireCompensation(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 10000
	g.Offices[0].PCs = 2
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	if want := g.Config().HirePrice + g.Config().FireCompSameDay; g.Money != 10000-want {
		t.Errorf("увольнение в день найма: Money = %d, хотим %d (найм $300 + компенсация $100)", g.Money, 10000-want)
	}
	// На следующий день компенсация полная. Выработку ставим руками —
	// ролл найма не должен влиять на арифметику теста.
	g.Offices[0].Employees = testStaff(1)
	for i := 0; i < dayTestConfig().DayTicks(); i++ {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	if want := g.Config().FireCompensation; g.Money != 10000-300-100-250-want+30 {
		// 10000 − найм300 − комп100 − ФОТ250 (конец дня 1) + доход30 − компensation
		t.Errorf("увольнение на следующий день: Money = %d, расчёт с компенсацией $%d", g.Money, want)
	}
}

func TestFireValidation(t *testing.T) {
	g := New(emp2Config())
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = testStaff(1)
	g.Money = 50 // меньше компенсации $250
	if err := g.Fire(0, 0); err != ErrNotEnoughMoney {
		t.Errorf("увольнение без денег: err = %v, хотим %v", err, ErrNotEnoughMoney)
	}
	if len(g.Offices[0].Employees) != 1 {
		t.Error("без денег сотрудник должен остаться")
	}
	g.Money = 10000
	if err := g.Fire(0, 5); err != ErrBadSlot {
		t.Errorf("увольнение вне штата: err = %v, хотим %v", err, ErrBadSlot)
	}
	if err := g.Apply(CmdFire, 1, 0); err != ErrOfficeLocked {
		t.Errorf("увольнение в закрытом офисе: err = %v, хотим %v", err, ErrOfficeLocked)
	}
}

func TestFireLosesProgress(t *testing.T) {
	g := New(emp2Config())
	g.Money = 10000
	g.Offices[0].PCs = 1
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	g.Offices[0].Employees[0].XP = 288 // уровень 2
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	e := g.Offices[0].Employees[0]
	if e.XP != 0 || e.HireDay != g.Day {
		t.Errorf("новый сотрудник должен быть с нуля: XP=%d HireDay=%d", e.XP, e.HireDay)
	}
}

func TestFireRetargetsRaiseEvents(t *testing.T) {
	// Активное событие повышения адресовано слоту 1; увольняем слот 2 —
	// индекс сдвигается, событие остаётся адресованным тому же человеку.
	g := New(emp2Config())
	g.Money = 10000
	g.Offices[0].PCs = 3
	g.Offices[0].Employees = testStaff(3)
	g.DayEvents = []DayEvent{{ID: EventRaise, Office: 0, Slot: 1}}
	g.ActiveEvent = &g.DayEvents[0]
	if err := g.Fire(0, 2); err != nil {
		t.Fatal(err)
	}
	if g.ActiveEvent == nil || g.ActiveEvent.Slot != 1 || g.ActiveEvent.Resolved {
		t.Fatalf("после увольнения слота 2 событие должно жить со слотом 1: %+v", g.ActiveEvent)
	}
	// Увольнение самого адресата резолвит активное событие.
	if err := g.Fire(0, 1); err != nil {
		t.Fatal(err)
	}
	if g.ActiveEvent != nil {
		t.Fatalf("увольнение адресата должно закрыть событие: %+v", g.ActiveEvent)
	}
	if !g.DayEvents[0].Resolved {
		t.Error("событие должно быть помечено resolved")
	}
	// Ожидающее (не активное) событие с адресатом-уволенным тоже закрывается.
	g.DayEvents = []DayEvent{{ID: EventRaise, Office: 0, Slot: 0}}
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	if !g.DayEvents[0].Resolved {
		t.Error("ожидающее событие повышения должно закрыться")
	}
}

func TestXPPerProductiveTick(t *testing.T) {
	cfg := emp2Config()
	g := New(cfg)
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = testStaff(1)
	g.Tick()
	if xp := g.Offices[0].Employees[0].XP; xp != cfg.XPPerTick {
		t.Errorf("XP за тик = %d, хотим %d", xp, cfg.XPPerTick)
	}
	// Обед: ни дохода, ни опыта.
	g.TickInDay = cfg.lunchStartTick()
	g.Tick()
	if got := g.Offices[0].Employees[0].XP; got != cfg.XPPerTick {
		t.Errorf("XP в обед = %d, хотим без изменений %d", got, cfg.XPPerTick)
	}
	// Сломанный ПК: работает — нет, опыта нет.
	g.Offices[0].Employees[0].PCBroken = true
	g.TickInDay = cfg.lunchEndTick()
	g.Tick()
	if got := g.Offices[0].Employees[0].XP; got != cfg.XPPerTick {
		t.Errorf("XP на сломанном ПК = %d, хотим без изменений %d", got, cfg.XPPerTick)
	}
}

func TestXPMentor(t *testing.T) {
	cfg := emp2Config()
	g := New(cfg)
	g.Money = 10000
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = testStaff(1)
	g.Tick()
	if xp := g.Offices[0].Employees[0].XP; xp != cfg.XPPerTick {
		t.Fatalf("без босса XP = %d, хотим %d", xp, cfg.XPPerTick)
	}
	g.Offices[0].Employees[0].XP = 0
	g.Offices[0].Boss = "Босс Боссов"
	g.Tick()
	if xp := g.Offices[0].Employees[0].XP; xp != cfg.XPMentorPerTick {
		t.Errorf("с боссом XP = %d, хотим %d (менторство ×1.5)", xp, cfg.XPMentorPerTick)
	}
}

func TestXPCap(t *testing.T) {
	cfg := emp2Config()
	g := New(cfg)
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = []Employee{{Name: "А Б", IncomePerTick: 10, XP: cfg.EmployeeLevelXP[2]}}
	g.Tick()
	if xp := g.Offices[0].Employees[0].XP; xp != cfg.EmployeeLevelXP[2] {
		t.Errorf("XP на потолке = %d, хотим замороженные %d", xp, cfg.EmployeeLevelXP[2])
	}
	if n := g.XPNext(&g.Offices[0].Employees[0]); n != 0 {
		t.Errorf("XPNext на потолке = %d, хотим 0", n)
	}
}

func TestLevelBonusIncome(t *testing.T) {
	cfg := emp2Config()
	g := New(cfg)
	g.Offices[0].PCs = 1
	// Уровень 1: (10+1)×1.0 = 11; уровень 2 без сети: 12.
	for _, tc := range []struct {
		xp   int
		want int
	}{
		{xp: 0, want: 10},
		{xp: cfg.EmployeeLevelXP[0], want: 11},
		{xp: cfg.EmployeeLevelXP[1], want: 12},
		{xp: cfg.EmployeeLevelXP[2], want: 12},
	} {
		g.Offices[0].Employees = []Employee{{Name: "А Б", IncomePerTick: 10, XP: tc.xp}}
		if inc := g.IncomePerTick(); inc != tc.want {
			t.Errorf("XP=%d: доход = %d, хотим %d", tc.xp, inc, tc.want)
		}
	}
	// Прибавка уровня до сетевого множителя: сервер ×2.2 → (10+1)×2.2 = 24.
	g.Offices[0].RouterTier = 1
	g.Offices[0].Servers = []int{3}
	g.CoreLevel = 1
	g.Offices[0].Employees = []Employee{{Name: "А Б", IncomePerTick: 10, XP: cfg.EmployeeLevelXP[0]}}
	if inc := g.IncomePerTick(); inc != 24 {
		t.Errorf("уровень 1 с сетью ×2.2: доход = %d, хотим 24", inc)
	}
}

func TestLevelProgression(t *testing.T) {
	cfg := emp2Config()
	// 48 продуктивных тиков × 2 XP = 96 за день: уровень 1 к концу дня 1,
	// уровень 2 к концу дня 3, уровень 3 к концу дня 6 (GDD).
	g := New(cfg)
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = testStaff(1)
	g.Money = 100000
	for day := 1; day <= 6; day++ {
		for i := 0; i < cfg.DayTicks(); i++ {
			g.Tick()
		}
		if err := g.NextDay(); err != nil {
			t.Fatal(err)
		}
	}
	e := g.Offices[0].Employees[0]
	wantXP := 6 * 48 * cfg.XPPerTick
	if e.XP != wantXP {
		t.Errorf("XP за 6 дней = %d, хотим %d", e.XP, wantXP)
	}
	if lvl := g.LevelFor(&e); lvl != 3 {
		t.Errorf("уровень после 6 дней = %d, хотим 3", lvl)
	}
	// С боссом уровень 3 за 4 дня: 4 × 48 × 3 = 576.
	g2 := New(cfg)
	g2.Offices[0].PCs = 1
	g2.Offices[0].Employees = testStaff(1)
	g2.Offices[0].Boss = "Босс Боссов"
	g2.Money = 100000
	for day := 1; day <= 4; day++ {
		for i := 0; i < cfg.DayTicks(); i++ {
			g2.Tick()
		}
		if err := g2.NextDay(); err != nil {
			t.Fatal(err)
		}
	}
	if lvl := g2.LevelFor(&g2.Offices[0].Employees[0]); lvl != 3 {
		t.Errorf("с боссом уровень после 4 дней = %d, хотим 3", lvl)
	}
}

func TestStarRollBoundaries(t *testing.T) {
	// Границы шанса детерминированы: 100% — все звёзды, 0% — никаких.
	cfg := emp2Config()
	cfg.StarChancePct = 100
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 100000
	g.Offices[0].PCs = 5
	for i := 0; i < 5; i++ {
		if err := g.Hire(0); err != nil {
			t.Fatal(err)
		}
	}
	for i, e := range g.Offices[0].Employees {
		if !e.Star || !strings.Contains(e.Name, "★") {
			t.Errorf("сотрудник %d при 100%%: Star=%v имя %q", i, e.Star, e.Name)
		}
		if e.IncomePerTick < int(float64(cfg.IncomeMin)*cfg.StarMult) {
			t.Errorf("звезда %d: выработка %d ниже минимальной для ×1.5", i, e.IncomePerTick)
		}
	}
	cfg.StarChancePct = 0
	g = NewWithSeed(cfg, 1, 2)
	g.Money = 100000
	g.Offices[0].PCs = 5
	for i := 0; i < 5; i++ {
		if err := g.Hire(0); err != nil {
			t.Fatal(err)
		}
	}
	for i, e := range g.Offices[0].Employees {
		if e.Star {
			t.Errorf("сотрудник %d при 0%% — звезда", i)
		}
	}
}

func TestStarChanceSeededRNG(t *testing.T) {
	// Статистика на seeded rng: 2000 роллов найма/увольнения в день найма,
	// доля звёзд в допуске 5%±2.25 (ловит ошибку в границе или кратность).
	cfg := emp2Config()
	g := NewWithSeed(cfg, 20260827, 42)
	g.Money = 10_000_000
	g.Offices[0].PCs = 1
	stars := 0
	const rolls = 2000
	for i := 0; i < rolls; i++ {
		if err := g.Hire(0); err != nil {
			t.Fatalf("ролл %d: %v", i, err)
		}
		if g.Offices[0].Employees[0].Star {
			stars++
		}
		if err := g.Fire(0, 0); err != nil {
			t.Fatalf("увольнение %d: %v", i, err)
		}
	}
	if stars < 55 || stars > 145 {
		t.Errorf("звёзд %d из %d (%.1f%%), хотим 5%%±2.25", stars, rolls, 100*float64(stars)/rolls)
	}
}

func TestStarDeterministicWithSeed(t *testing.T) {
	cfg := emp2Config()
	roll := func() []Employee {
		g := NewWithSeed(cfg, 7, 7)
		g.Money = 100000
		g.Offices[0].PCs = 4
		for i := 0; i < 4; i++ {
			if err := g.Hire(0); err != nil {
				t.Fatal(err)
			}
		}
		return g.Offices[0].Employees
	}
	a, b := roll(), roll()
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("один сид — разные сотрудники: %+v vs %+v", a[i], b[i])
		}
	}
}

func TestStarIncomeIsRollTimesMult(t *testing.T) {
	// При 100% звёзд выработка = round(ролл × 1.5): прямое сравнение
	// с допустимым множеством значений.
	cfg := emp2Config()
	cfg.StarChancePct = 100
	g := New(cfg)
	g.Money = 100000
	g.Offices[0].PCs = 1
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	e := g.Offices[0].Employees[0]
	possible := map[int]bool{}
	for x := cfg.IncomeMin; x <= cfg.IncomeMax; x++ {
		possible[int(float64(x)*cfg.StarMult+0.5)] = true
	}
	if !possible[e.IncomePerTick] {
		t.Errorf("выработка звезды %d не является round(ролл×1.5) из [%d..%d]", e.IncomePerTick, cfg.IncomeMin, cfg.IncomeMax)
	}
}

// Активное событие — элемент DayEvents: увольнение сотрудника ниже
// адресата сдвигает его индекс ровно на один (ITGAME-52).
func TestFireShiftsActiveRaiseOnce(t *testing.T) {
	g := New(emp2Config())
	g.Money = 10000
	g.Offices[0].PCs = 3
	g.Offices[0].Employees = testStaff(3)
	g.DayEvents = []DayEvent{{ID: EventRaise, Office: 0, Slot: 2}}
	g.ActiveEvent = &g.DayEvents[0]
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	if g.ActiveEvent == nil || g.ActiveEvent.Slot != 1 {
		t.Fatalf("адресат со слота 2 после увольнения слота 0 — слот 1, а событие: %+v", g.ActiveEvent)
	}
}
