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
	Type          string  `json:"type"` // всегда "state"
	Money         int     `json:"money"`
	PCs           int     `json:"pcs"`
	Employees     int     `json:"employees"`
	RouterTier    int     `json:"routerTier"`
	Ports         int     `json:"ports"`
	Connected     int     `json:"connected"`
	Servers       int     `json:"servers"`
	Multiplier    float64 `json:"multiplier"`
	IncomePerTick int     `json:"incomePerTick"`
	Day           int     `json:"day"`
	DayTicks      int     `json:"dayTicks"`
	DayProgress   int     `json:"dayProgress"` // тиков прошло в текущем дне
	PayrollPerDay int     `json:"payrollPerDay"`
	Phase         string  `json:"phase"` // running | day_report | game_over
	OfficeSlots   int     `json:"officeSlots"`
	RackSlots     int     `json:"rackSlots"`
	Prices        prices  `json:"prices"`
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
	return stateMessage{
		Type:          "state",
		Money:         g.Money,
		PCs:           g.PCs,
		Employees:     len(g.Employees),
		RouterTier:    g.RouterTier,
		Ports:         g.Ports(),
		Connected:     g.Connected(),
		Servers:       g.Servers,
		Multiplier:    g.Multiplier(),
		IncomePerTick: g.IncomePerTick(),
		Day:           g.Day,
		DayTicks:      cfg.DayTicks(),
		DayProgress:   g.TickInDay,
		PayrollPerDay: g.PayrollPerDay(),
		Phase:         string(g.Phase),
		OfficeSlots:   cfg.OfficeSlots,
		RackSlots:     cfg.RackSlots,
		Prices: prices{
			PC:         cfg.PCPrice,
			Hire:       cfg.HirePrice,
			Server:     cfg.ServerPrice,
			NextRouter: g.NextRouterPrice(),
		},
	}
}
