package ws

import (
	"encoding/json"
	"strings"
	"testing"

	"itdirector/internal/game"
)

func TestSnapshot(t *testing.T) {
	g := game.New(game.DefaultConfig())
	s := snapshot(g, 1, false, "")
	if s.Type != "state" || s.Money != 600 || s.OfficeSlots != 12 || s.Speed != 1 {
		t.Errorf("базовые поля: %+v", s)
	}
	if len(s.Offices) != 3 {
		t.Fatalf("офисов в снапшоте %d, хотим 3", len(s.Offices))
	}
	if !s.Offices[0].Unlocked || s.Offices[0].PCs != 1 || s.Offices[0].Price != 0 || s.Offices[0].NextRouter != 800 {
		t.Errorf("офис 0: %+v", s.Offices[0])
	}
	if s.Offices[1].Unlocked || s.Offices[1].Price != 15000 || s.Offices[2].Price != 40000 {
		t.Errorf("закрытые офисы: %+v %+v", s.Offices[1], s.Offices[2])
	}
	if s.Gateway || s.Core.Level != 0 || s.Core.NextPrice != 800 {
		t.Errorf("серверная: %+v", s)
	}
	if s.Prices.PC != 500 || s.Prices.Hire != 300 ||
		len(s.Prices.ServerLevels) != 3 || s.Prices.ServerLevels[0].Price != 2000 || len(s.Prices.CoreLevels) != 5 ||
		s.Prices.Boss != 1000 || s.Prices.Gateway != 3000 {
		t.Errorf("цены: %+v", s.Prices)
	}
	if s.Clock != "10:00" || s.IsLunch || s.StaffLimit != 9 || s.SalaryPerDay != 250 ||
		s.BossSalaryPerDay != 500 || s.TicksPerHour != 6 || s.ForecastEndOfDay != 600 ||
		s.Day != 1 || s.Phase != "running" || s.PayrollPerDay != 0 {
		t.Errorf("поля дня: %+v", s)
	}
}

func TestSnapshotOfficeDetails(t *testing.T) {
	g := game.New(game.DefaultConfig())
	g.Offices[0].PCs = 6
	g.Offices[0].RouterTier = 1
	g.CoreLevel = 1 // core с запасом ёмкости: connected в снапшоте = получил место в core
	g.Offices[0].Boss = "Босс Боссов"
	staff := make([]game.Employee, 6)
	for i := range staff {
		staff[i] = game.Employee{Name: "Тест Тестов", IncomePerTick: 10}
	}
	staff[5].UnpaidToday = true
	g.Offices[0].Employees = staff
	s := snapshot(g, 1, false, "")
	o := s.Offices[0]
	if o.Boss != "Босс Боссов" || o.Ports != 4 || o.NextRouter != 2500 {
		t.Errorf("офис 0: %+v", o)
	}
	for i, e := range o.Employees {
		if want := i < 4; e.Connected != want {
			t.Errorf("сотрудник %d connected=%v, хотим %v", i, e.Connected, want)
		}
	}
	if !o.Employees[5].UnpaidToday {
		t.Error("unpaidToday не прокинулся в снапшот")
	}
}

// TestSnapshotOfflineReason — причина отсутствия сети по звеньям цепочки
// (итерация 11): роутер → core → стойка.
func TestSnapshotOfflineReason(t *testing.T) {
	g := game.New(game.DefaultConfig())
	g.CoreLevel = 2 // 16 мест; core раздаёт офисам по порядку
	g.Offices[0].PCs = 9
	g.Offices[0].RouterTier = 2 // 9 портов: все 9 мест О1 в core
	g.Offices[1].Unlocked = true
	g.Offices[1].PCs = 9
	g.Offices[1].RouterTier = 2 // 9 портов, но core осталось 16−9=7
	staff := func(n int) []game.Employee {
		s := make([]game.Employee, n)
		for i := range s {
			s[i] = game.Employee{Name: "Тест Тестов", IncomePerTick: 10}
		}
		return s
	}
	g.Offices[0].Employees = staff(9)
	g.Offices[1].Employees = staff(9)
	s := snapshot(g, 1, false, "")
	// Стоек нет нигде: место в core без стойки — no_server.
	if r := s.Offices[0].Employees[0].OfflineReason; r != "no_server" {
		t.Errorf("в core без стойки: reason=%q, хотим no_server", r)
	}
	// О2 получил 7 мест core: 0-6 no_server, 7-8 за ёмкостью — no_core.
	if r := s.Offices[1].Employees[6].OfflineReason; r != "no_server" {
		t.Errorf("О2 сотр.7 в core: reason=%q, хотим no_server", r)
	}
	if r := s.Offices[1].Employees[7].OfflineReason; r != "no_core" {
		t.Errorf("О2 сотр.8 за core: reason=%q, хотим no_core", r)
	}
	if s.Offices[0].NextPorts != 12 {
		t.Errorf("nextPorts офиса 0 = %d, хотим 12 (тир 3)", s.Offices[0].NextPorts)
	}
	// Роутера нет: сотрудник офиса без роутера — no_router.
	g2 := game.New(game.DefaultConfig())
	g2.Offices[0].PCs = 1
	g2.Offices[0].Employees = []game.Employee{{Name: "Тест Тестов", IncomePerTick: 10}}
	s2 := snapshot(g2, 1, false, "")
	if r := s2.Offices[0].Employees[0].OfflineReason; r != "no_router" {
		t.Errorf("без роутера offlineReason = %q, хотим no_router", r)
	}
}

func TestSnapshotAmenitiesAndEffects(t *testing.T) {
	g := game.New(game.DefaultConfig())
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = []game.Employee{{Name: "Тест Тестов", IncomePerTick: 10, CoffeeUntil: 34}}
	g.Offices[0].Cooler = true
	g.TickInDay = 30 // после обеда: голод есть (холодильника нет), жажды нет (кулер)
	s := snapshot(g, 1, false, "")
	o := s.Offices[0]
	if !o.Cooler || o.Fridge || o.CoffeeMachine {
		t.Errorf("флаги устройств: %+v", o)
	}
	eff := o.Employees[0].Effects
	if len(eff) != 2 {
		t.Fatalf("эффектов %d, хотим 2 (голод+кофе): %+v", len(eff), eff)
	}
	byToken := map[string]effectInfo{}
	for _, e := range eff {
		byToken[e.Token] = e
	}
	if byToken["hunger"].Percent != -10 || byToken["hunger"].Until != "" {
		t.Errorf("голод: %+v", byToken["hunger"])
	}
	if byToken["coffee"].Percent != 15 || byToken["coffee"].Until != "15:40" {
		t.Errorf("кофе: %+v (until тика 34 = 15:40)", byToken["coffee"])
	}
	if s.Prices.Cooler != 400 || s.Prices.Fridge != 600 || s.Prices.CoffeeMachine != 800 {
		t.Errorf("цены устройств: %+v", s.Prices)
	}
}

func TestSnapshotEffectsNeverNull(t *testing.T) {
	// Регрессия: nil-срез эффектов маршалился в JSON null и ронял клиент.
	g := game.New(game.DefaultConfig())
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = []game.Employee{{Name: "Тест Тестов", IncomePerTick: 10}}
	// Тик 0: ни одного эффекта — самый опасный случай.
	raw, err := json.Marshal(snapshot(g, 1, false, ""))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"effects":null`) {
		t.Error("effects без эффектов должен быть [], а не null")
	}
	if !strings.Contains(string(raw), `"effects":[]`) {
		t.Error("в снапшоте нет пустого массива effects")
	}
}

func TestSnapshotServersNeverNull(t *testing.T) {
	// Регрессия И5: nil-срез маршалится в JSON null и ронял клиент.
	g := game.New(game.DefaultConfig())
	raw, err := json.Marshal(snapshot(g, 1, false, ""))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"servers":null`) {
		t.Error("servers без серверов должен быть [], а не null")
	}
	if !strings.Contains(string(raw), `"servers":[]`) {
		t.Error("в снапшоте нет пустого массива servers")
	}
	if !strings.Contains(string(raw), `"core":{`) {
		t.Error("в снапшоте нет объекта core")
	}
}

// Деньги событий и прибыль дня доходят до клиента (ITGAME-53): eventMoney
// в отчёте, dayProfit в снапшоте — то же число, что считает игра.
func TestProtocolDayProfitAndEventMoney(t *testing.T) {
	data, err := json.Marshal(dayReportMsg(&game.DayReport{EventMoney: -150, Profit: 10}))
	if err != nil {
		t.Fatal(err)
	}
	var rep map[string]any
	if err := json.Unmarshal(data, &rep); err != nil {
		t.Fatal(err)
	}
	if rep["eventMoney"] != float64(-150) {
		t.Errorf("day_report.eventMoney = %v, хотим -150", rep["eventMoney"])
	}
	g := game.New(game.DefaultConfig())
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	g.Tick()
	if got, want := snapshot(g, 1, false, "").DayProfit, g.DayProfit(); got != want {
		t.Errorf("state.dayProfit = %d, хотим %d", got, want)
	}
}

// Прогноз обречённой партии (ITGAME-118) едет в снапшоте полем bankruptInDays:
// фикстура doomed_debt на Hard обречена, на Normal долг $2000 глубже
// овердрафта $750 — банкротство сегодня вечером, N = 1 (ITGAME-156).
func TestProtocolBankruptInDays(t *testing.T) {
	g, err := game.NewFixture(game.ConfigForDifficulty(game.DiffHard), "doomed_debt", "1")
	if err != nil {
		t.Fatal(err)
	}
	st := snapshot(g, 1, false, "doomed_debt")
	if st.BankruptInDays < 1 || st.BankruptInDays != g.BankruptInDays() {
		t.Fatalf("state.bankruptInDays = %d, игра считает %d", st.BankruptInDays, g.BankruptInDays())
	}
	data, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if raw["bankruptInDays"] != float64(st.BankruptInDays) {
		t.Errorf("JSON bankruptInDays = %v, хотим %d", raw["bankruptInDays"], st.BankruptInDays)
	}
	normal, err := game.NewFixture(game.ConfigForDifficulty(game.DiffNormal), "doomed_debt", "1")
	if err != nil {
		t.Fatal(err)
	}
	if got := snapshot(normal, 1, false, "doomed_debt").BankruptInDays; got != 1 {
		t.Errorf("Normal: bankruptInDays = %d, хотим 1", got)
	}
}

// Порог долга (ITGAME-156) едет в снапшоте полем debtLimit: на кредите —
// creditLimit, без кредита — расходы дня (овердрафт); creditLimit остаётся
// значением конфига.
func TestProtocolDebtLimit(t *testing.T) {
	for _, c := range []struct {
		diff   game.Difficulty
		credit int
		debt   int
	}{
		{game.DiffHard, 5000, 5000},
		{game.DiffNormal, 0, 750},
	} {
		t.Run(string(c.diff), func(t *testing.T) {
			g, err := game.NewFixture(game.ConfigForDifficulty(c.diff), "doomed_debt", "1")
			if err != nil {
				t.Fatal(err)
			}
			st := snapshot(g, 1, false, "doomed_debt")
			if st.CreditLimit != c.credit || st.DebtLimit != c.debt || st.DebtLimit != g.DebtLimit() {
				t.Fatalf("creditLimit %d debtLimit %d (игра %d), хотим %d и %d",
					st.CreditLimit, st.DebtLimit, g.DebtLimit(), c.credit, c.debt)
			}
			data, err := json.Marshal(st)
			if err != nil {
				t.Fatal(err)
			}
			var raw map[string]any
			if err := json.Unmarshal(data, &raw); err != nil {
				t.Fatal(err)
			}
			if raw["debtLimit"] != float64(c.debt) {
				t.Errorf("JSON debtLimit = %v, хотим %d", raw["debtLimit"], c.debt)
			}
		})
	}
}
