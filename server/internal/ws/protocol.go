// Package ws — WebSocket-протокол и сессии игры.
package ws

import "itdirector/internal/game"

// effectInfo — активный эффект сотрудника для тултипа.
type effectInfo struct {
	Token   string `json:"token"`   // thirst | hunger | coffee
	Percent int    `json:"percent"` // −10 / +15
	Until   string `json:"until"`   // «HH:MM»; "" — до конца дня
}

// clientMessage — сообщение клиента: {"type": "...", "office": N}.
// office адресует офисные команды (hire, buy_pc, buy_router, hire_boss,
// buy_office); остальные его игнорируют.
type clientMessage struct {
	Type   string `json:"type"`
	Office int    `json:"office"`
	Slot   int    `json:"slot"`  // стойка для upgrade_server
	Speed  int    `json:"speed"` // параметр set_speed: 0 — пауза, 1..3 — множитель темпа
}

// stateMessage — полный снапшот состояния. Включает производные поля
// (доход, порты, множитель), чтобы клиент ничего не считал сам.
type stateMessage struct {
	Type             string       `json:"type"` // всегда "state"
	Money            int          `json:"money"`
	Offices          []officeInfo `json:"offices"`
	Gateway          bool         `json:"gateway"`
	Core             coreInfo     `json:"core"`
	IncomePerTick    int          `json:"incomePerTick"`
	Day              int          `json:"day"`
	Clock            string       `json:"clock"`   // «12:30»
	IsLunch          bool         `json:"isLunch"` // обед: доход за тик = 0
	TicksPerHour     int          `json:"ticksPerHour"`
	PayrollPerDay    int          `json:"payrollPerDay"` // полные расходы дня
	SalaryPerDay     int          `json:"salaryPerDay"`
	BossSalaryPerDay int          `json:"bossSalaryPerDay"`
	ForecastEndOfDay int          `json:"forecastEndOfDay"`
	StaffLimit       int          `json:"staffLimit"`
	OfficeSlots      int          `json:"officeSlots"`
	Phase            string       `json:"phase"`      // running | day_report | game_over
	Speed            int          `json:"speed"`      // темп сессии: 0 — пауза, 1..3
	Difficulty       string       `json:"difficulty"` // easy | normal | hard | hardcore
	WinTarget        int          `json:"winTarget"`  // цель победы, $
	Prices           prices       `json:"prices"`
}

// officeInfo — офис в снапшоте: всё для отрисовки комнаты и панели.
type officeInfo struct {
	Unlocked        bool           `json:"unlocked"`
	Price           int            `json:"price"` // цена покупки; 0 для открытых
	PCs             int            `json:"pcs"`
	RouterTier      int            `json:"routerTier"`
	Ports           int            `json:"ports"`
	NextRouter      int            `json:"nextRouter"` // 0 — тир максимальный
	Servers         []serverInfo   `json:"servers"`
	ServerSlots     int            `json:"serverSlots"`
	Boss            string         `json:"boss"` // "" — начальника нет
	BossUnpaidToday bool           `json:"bossUnpaidToday"`
	Cooler          bool           `json:"cooler"`
	Fridge          bool           `json:"fridge"`
	CoffeeMachine   bool           `json:"coffeeMachine"`
	Employees       []employeeInfo `json:"employees"` // порядок = порядок найма
}

// employeeInfo — сотрудник в снапшоте: всё, что нужно тултипу.
type employeeInfo struct {
	Name          string `json:"name"`
	IncomePerTick int    `json:"incomePerTick"`
	// Личная выработка с учётом активных эффектов (без сетевого множителя).
	EffectiveIncomePerTick int          `json:"effectiveIncomePerTick"`
	Connected              bool         `json:"connected"` // получил место в ёмкости core (зелёная точка)
	UnpaidToday            bool         `json:"unpaidToday"`
	Effects                []effectInfo `json:"effects"`
	NetMult                float64      `json:"netMult"`    // итоговый сетевой множитель
	ServerSlot             int          `json:"serverSlot"` // 1-based сервер работника; 0 — без сервера
}

// serverInfo — сервер офиса в снапшоте: всё для модалки стойки.
type serverInfo struct {
	Slot       int     `json:"slot"` // 0-based индекс стойки
	Level      int     `json:"level"`
	Mult       float64 `json:"mult"`
	NextPrice  int     `json:"nextPrice"` // 0 — уровень максимальный
	Maxed      bool    `json:"maxed"`
	ServedFrom int     `json:"servedFrom"` // обслуживаемые работники офиса, 1-based
	ServedTo   int     `json:"servedTo"`
}

// coreInfo — core-коммутатор в снапшоте: всё для модалки core.
type coreInfo struct {
	Level     int     `json:"level"` // 0 — не куплен
	Capacity  int     `json:"capacity"`
	Connected int     `json:"connected"` // занято мест по компании
	Mult      float64 `json:"mult"`      // 1.1 на финальном уровне, иначе 1.0
	NextPrice int     `json:"nextPrice"` // 0 — уровень максимальный
	Maxed     bool    `json:"maxed"`
}

type serverLevelPrice struct {
	Mult  float64 `json:"mult"`
	Price int     `json:"price"`
}

type coreLevelPrice struct {
	Capacity int     `json:"capacity"`
	Price    int     `json:"price"`
	Mult     float64 `json:"mult"`
}

type prices struct {
	PC            int                `json:"pc"`
	Hire          int                `json:"hire"`
	Boss          int                `json:"boss"`
	Gateway       int                `json:"gateway"`
	Cooler        int                `json:"cooler"`
	Fridge        int                `json:"fridge"`
	CoffeeMachine int                `json:"coffeeMachine"`
	ServerLevels  []serverLevelPrice `json:"serverLevels"`
	CoreLevels    []coreLevelPrice   `json:"coreLevels"`
}

type errorMessage struct {
	Type string `json:"type"` // всегда "error"
	Code string `json:"code"`
}

// dayReportMessage — итоги дня; шлётся сразу после снапшота с phase=day_report.
type dayReportMessage struct {
	Type        string `json:"type"` // всегда "day_report"
	Day         int    `json:"day"`
	Income      int    `json:"income"`
	Payroll     int    `json:"payroll"`
	GatewayOpex int    `json:"gatewayOpex"`
	Profit      int    `json:"profit"`
	Balance     int    `json:"balance"`
}

// gameOverMessage — итоги банкротства; шлётся сразу после снапшота с phase=game_over.
type gameOverMessage struct {
	Type              string `json:"type"` // всегда "game_over"
	DaysSurvived      int    `json:"daysSurvived"`
	PeakIncomePerTick int    `json:"peakIncomePerTick"`
	Balance           int    `json:"balance"` // отрицательный: сколько не хватило
}

// victoryMessage — итоги победы; шлётся сразу после снапшота с phase=won.
type victoryMessage struct {
	Type       string `json:"type"` // всегда "victory"
	Difficulty string `json:"difficulty"`
	Day        int    `json:"day"`
	Balance    int    `json:"balance"`
}

func snapshot(g *game.Game, speed int) stateMessage {
	cfg := g.Config()
	net := g.Network()
	offices := make([]officeInfo, len(g.Offices))
	for oi := range g.Offices {
		o := &g.Offices[oi]
		price := 0
		if !o.Unlocked {
			price = cfg.OfficePrices[oi-1]
		}
		employees := make([]employeeInfo, len(o.Employees))
		for i, e := range o.Employees {
			// Не nil: nil-срез маршалится в JSON null, а клиент ждёт массив.
			effects := make([]effectInfo, 0, 3)
			for _, ef := range g.Effects(o, &o.Employees[i]) {
				until := ""
				if ef.Until >= 0 {
					until = g.ClockAt(ef.Until)
				}
				effects = append(effects, effectInfo{Token: ef.Token, Percent: ef.Percent, Until: until})
			}
			employees[i] = employeeInfo{Name: e.Name, IncomePerTick: e.IncomePerTick,
				EffectiveIncomePerTick: g.EffectiveIncomePerTick(o, &o.Employees[i]),
				Connected:              net.CoreLinked[oi][i], UnpaidToday: e.UnpaidToday, Effects: effects,
				NetMult: net.Mults[oi][i], ServerSlot: net.ServerSlot[oi][i]}
		}
		// Не nil: nil-срез маршалится в JSON null, а клиент ждёт массив.
		servers := make([]serverInfo, 0, len(o.Servers))
		for si, lvl := range o.Servers {
			next, maxed := 0, true
			if lvl < len(cfg.ServerLevels) {
				next, maxed = cfg.ServerLevels[lvl].Price, false
			}
			servers = append(servers, serverInfo{
				Slot: si, Level: lvl, Mult: cfg.ServerLevels[lvl-1].Mult,
				NextPrice: next, Maxed: maxed,
				ServedFrom: si*cfg.EmployeesPerServer + 1,
				ServedTo:   (si + 1) * cfg.EmployeesPerServer,
			})
		}
		offices[oi] = officeInfo{
			Unlocked: o.Unlocked, Price: price, PCs: o.PCs,
			RouterTier: o.RouterTier, Ports: o.Ports(cfg),
			NextRouter: g.NextRouterPrice(oi), Servers: servers, ServerSlots: cfg.ServerSlotsPerOffice(),
			Boss: o.Boss, BossUnpaidToday: o.BossUnpaidToday, Cooler: o.Cooler,
			Fridge: o.Fridge, CoffeeMachine: o.CoffeeMachine, Employees: employees,
		}
	}
	core := coreInfo{Level: g.CoreLevel, Connected: net.CoreUsed, Mult: 1.0}
	if g.CoreLevel > 0 {
		lvl := cfg.CoreLevels[g.CoreLevel-1]
		core.Capacity, core.Mult = lvl.Capacity, lvl.Mult
	}
	if g.CoreLevel < len(cfg.CoreLevels) {
		core.NextPrice = cfg.CoreLevels[g.CoreLevel].Price
	} else {
		core.Maxed = true
	}
	serverLevels := make([]serverLevelPrice, 0, len(cfg.ServerLevels))
	for _, l := range cfg.ServerLevels {
		serverLevels = append(serverLevels, serverLevelPrice{Mult: l.Mult, Price: l.Price})
	}
	coreLevels := make([]coreLevelPrice, 0, len(cfg.CoreLevels))
	for _, l := range cfg.CoreLevels {
		coreLevels = append(coreLevels, coreLevelPrice{Capacity: l.Capacity, Price: l.Price, Mult: l.Mult})
	}
	return stateMessage{
		Type: "state", Money: g.Money, Offices: offices,
		Gateway: g.Gateway, Core: core, IncomePerTick: g.IncomePerTick(),
		Day: g.Day, Clock: g.Clock(), IsLunch: g.IsLunch(),
		TicksPerHour: cfg.TicksPerHour, PayrollPerDay: g.PayrollPerDay(),
		SalaryPerDay: cfg.SalaryPerDay, BossSalaryPerDay: cfg.BossSalaryPerDay,
		ForecastEndOfDay: g.ForecastEndOfDay(), StaffLimit: cfg.StaffLimit,
		OfficeSlots: cfg.OfficeSlots, Phase: string(g.Phase), Speed: speed,
		Difficulty: string(cfg.Difficulty), WinTarget: cfg.WinTarget,
		Prices: prices{PC: cfg.PCPrice, Hire: cfg.HirePrice,
			Boss: cfg.BossPrice, Gateway: cfg.GatewayPrice, Cooler: cfg.CoolerPrice,
			Fridge: cfg.FridgePrice, CoffeeMachine: cfg.CoffeeMachinePrice,
			ServerLevels: serverLevels, CoreLevels: coreLevels},
	}
}
