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
}

// stateMessage — полный снапшот состояния. Включает производные поля
// (доход, порты, множитель), чтобы клиент ничего не считал сам.
type stateMessage struct {
	Type             string       `json:"type"` // всегда "state"
	Money            int          `json:"money"`
	Offices          []officeInfo `json:"offices"`
	Servers          int          `json:"servers"`
	Gateway          bool         `json:"gateway"`
	Multiplier       float64      `json:"multiplier"`
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
	Phase            string       `json:"phase"` // running | day_report | game_over
	RackSlots        int          `json:"rackSlots"`
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
	Boss            string         `json:"boss"`       // "" — начальника нет
	BossUnpaidToday bool           `json:"bossUnpaidToday"`
	Cooler          bool           `json:"cooler"`
	Fridge          bool           `json:"fridge"`
	CoffeeMachine   bool           `json:"coffeeMachine"`
	Employees       []employeeInfo `json:"employees"` // порядок = порядок найма
}

// employeeInfo — сотрудник в снапшоте: всё, что нужно тултипу.
type employeeInfo struct {
	Name          string       `json:"name"`
	IncomePerTick int          `json:"incomePerTick"`
	Connected     bool         `json:"connected"`
	UnpaidToday   bool         `json:"unpaidToday"`
	Effects       []effectInfo `json:"effects"`
}

type prices struct {
	PC            int `json:"pc"`
	Hire          int `json:"hire"`
	Server        int `json:"server"`
	Boss          int `json:"boss"`
	Gateway       int `json:"gateway"`
	Cooler        int `json:"cooler"`
	Fridge        int `json:"fridge"`
	CoffeeMachine int `json:"coffeeMachine"`
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

func snapshot(g *game.Game) stateMessage {
	cfg := g.Config()
	offices := make([]officeInfo, len(g.Offices))
	for oi := range g.Offices {
		o := &g.Offices[oi]
		price := 0
		if !o.Unlocked {
			price = cfg.OfficePrices[oi-1]
		}
		connected := o.Connected(cfg)
		employees := make([]employeeInfo, len(o.Employees))
		for i, e := range o.Employees {
			var effects []effectInfo
			for _, ef := range g.Effects(o, &o.Employees[i]) {
				until := ""
				if ef.Until >= 0 {
					until = g.ClockAt(ef.Until)
				}
				effects = append(effects, effectInfo{Token: ef.Token, Percent: ef.Percent, Until: until})
			}
			employees[i] = employeeInfo{Name: e.Name, IncomePerTick: e.IncomePerTick,
				Connected: i < connected, UnpaidToday: e.UnpaidToday, Effects: effects}
		}
		offices[oi] = officeInfo{
			Unlocked: o.Unlocked, Price: price, PCs: o.PCs,
			RouterTier: o.RouterTier, Ports: o.Ports(cfg),
			NextRouter: g.NextRouterPrice(oi), Boss: o.Boss,
			BossUnpaidToday: o.BossUnpaidToday, Cooler: o.Cooler,
			Fridge: o.Fridge, CoffeeMachine: o.CoffeeMachine, Employees: employees,
		}
	}
	return stateMessage{
		Type: "state", Money: g.Money, Offices: offices,
		Servers: g.Servers, Gateway: g.Gateway,
		Multiplier: g.Multiplier(), IncomePerTick: g.IncomePerTick(),
		Day: g.Day, Clock: g.Clock(), IsLunch: g.IsLunch(),
		TicksPerHour: cfg.TicksPerHour, PayrollPerDay: g.PayrollPerDay(),
		SalaryPerDay: cfg.SalaryPerDay, BossSalaryPerDay: cfg.BossSalaryPerDay,
		ForecastEndOfDay: g.ForecastEndOfDay(), StaffLimit: cfg.StaffLimit,
		OfficeSlots: cfg.OfficeSlots, Phase: string(g.Phase), RackSlots: cfg.RackSlots,
		Prices: prices{PC: cfg.PCPrice, Hire: cfg.HirePrice, Server: cfg.ServerPrice,
			Boss: cfg.BossPrice, Gateway: cfg.GatewayPrice, Cooler: cfg.CoolerPrice,
			Fridge: cfg.FridgePrice, CoffeeMachine: cfg.CoffeeMachinePrice},
	}
}
