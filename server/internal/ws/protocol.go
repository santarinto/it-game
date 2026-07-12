// Package ws — WebSocket-протокол и сессии игры.
package ws

import "itdirector/internal/game"

// clientMessage — любое сообщение клиента: {"type": "buy_pc" | ...}.
type clientMessage struct {
	Type string `json:"type"`
}

// stateMessage — полный снапшот состояния. Включает производные поля
// (доход, порты, множитель), чтобы клиент ничего не считал сам.
type stateMessage struct {
	Type             string         `json:"type"` // всегда "state"
	Money            int            `json:"money"`
	PCs              int            `json:"pcs"`
	RouterTier       int            `json:"routerTier"`
	Ports            int            `json:"ports"`
	Servers          int            `json:"servers"`
	Multiplier       float64        `json:"multiplier"`
	IncomePerTick    int            `json:"incomePerTick"`
	Employees        []employeeInfo `json:"employees"` // порядок = порядок найма
	Day              int            `json:"day"`
	DayTicks         int            `json:"dayTicks"`
	DayProgress      int            `json:"dayProgress"` // тиков прошло в текущем дне
	Clock            string         `json:"clock"`       // «12:30»
	IsLunch          bool           `json:"isLunch"`     // обед: доход за тик = 0
	TicksPerHour     int            `json:"ticksPerHour"`
	PayrollPerDay    int            `json:"payrollPerDay"`
	SalaryPerDay     int            `json:"salaryPerDay"`
	ForecastEndOfDay int            `json:"forecastEndOfDay"` // прогноз баланса на конец дня
	StaffLimit       int            `json:"staffLimit"`
	Phase            string         `json:"phase"` // running | day_report | game_over
	OfficeSlots      int            `json:"officeSlots"`
	RackSlots        int            `json:"rackSlots"`
	Prices           prices         `json:"prices"`
}

// employeeInfo — сотрудник в снапшоте: всё, что нужно тултипу.
type employeeInfo struct {
	Name          string `json:"name"`
	IncomePerTick int    `json:"incomePerTick"`
	Connected     bool   `json:"connected"`
}

type prices struct {
	PC         int `json:"pc"`
	Hire       int `json:"hire"`
	Server     int `json:"server"`
	NextRouter int `json:"nextRouter"` // 0 — роутер уже максимального тира
}

type errorMessage struct {
	Type string `json:"type"` // всегда "error"
	Code string `json:"code"`
}

// dayReportMessage — итоги дня; шлётся сразу после снапшота с phase=day_report.
type dayReportMessage struct {
	Type    string `json:"type"` // всегда "day_report"
	Day     int    `json:"day"`
	Income  int    `json:"income"`
	Payroll int    `json:"payroll"`
	Profit  int    `json:"profit"`
	Balance int    `json:"balance"`
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
	connected := g.Connected()
	employees := make([]employeeInfo, len(g.Employees))
	for i, e := range g.Employees {
		employees[i] = employeeInfo{Name: e.Name, IncomePerTick: e.IncomePerTick, Connected: i < connected}
	}
	return stateMessage{
		Type:             "state",
		Money:            g.Money,
		PCs:              g.PCs,
		RouterTier:       g.RouterTier,
		Ports:            g.Ports(),
		Servers:          g.Servers,
		Multiplier:       g.Multiplier(),
		IncomePerTick:    g.IncomePerTick(),
		Employees:        employees,
		Clock:            g.Clock(),
		IsLunch:          g.IsLunch(),
		TicksPerHour:     cfg.TicksPerHour,
		SalaryPerDay:     cfg.SalaryPerDay,
		ForecastEndOfDay: g.ForecastEndOfDay(),
		StaffLimit:       cfg.StaffLimit,
		Day:              g.Day,
		DayTicks:         cfg.DayTicks(),
		DayProgress:      g.TickInDay,
		PayrollPerDay:    g.PayrollPerDay(),
		Phase:            string(g.Phase),
		OfficeSlots:      cfg.OfficeSlots,
		RackSlots:        cfg.RackSlots,
		Prices: prices{
			PC:         cfg.PCPrice,
			Hire:       cfg.HirePrice,
			Server:     cfg.ServerPrice,
			NextRouter: g.NextRouterPrice(),
		},
	}
}
