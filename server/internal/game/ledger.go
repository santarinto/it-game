package game

import "slices"

// Бухгалтерия дня (ITGAME-73): из чего сложилась дневная разница баланса.
// Каждое движение денег пишется в книгу текущего дня там же, где меняется
// Money: доход тика, деньги событий, покупки (spend), ФОТ и опекс вечером,
// процент по долгу, debug-правка баланса. Поэтому сумма слагаемых сходится
// с balanceEnd − balanceStart ровно, а не «примерно, как прогноз».
//
// История: текущий день плюс LedgerDays последних закрытых. Живёт в Game и
// в сейве (иначе перезагрузка вкладки стирала бы вчерашний день — ровно тот,
// который сверяют после промотки), но с потолком: и дней, и строк покупок.

// LedgerDays — сколько закрытых дней книга хранит (и сейв).
const LedgerDays = 7

// ledgerItemsCap — потолок строк покупок и событий одного дня; сверх него
// всё сливается в последнюю строку (N — сколько покупок в ней).
const ledgerItemsCap = 32

// LedgerPurchase — одна покупка дня.
type LedgerPurchase struct {
	Type  string `json:"type"`        // команда протокола: buy_pc, hire, fire, call_master, …; event_choice — звезда события
	Price int    `json:"price"`       // списано, $
	Clock string `json:"clock"`       // «HH:MM» игрового дня
	N     int    `json:"n,omitempty"` // >1 — сводная строка сверх потолка (type «…»)
}

// LedgerEvent — деньги исхода события (со знаком), как в DayEventMoney.
type LedgerEvent struct {
	What  string `json:"what"`
	Money int    `json:"money"`
	Clock string `json:"clock"`
}

// DayLedger — книга одного дня. Инвариант:
// BalanceStart + Income + EventMoney − Σpurchases − Payroll − GatewayOpex −
// Interest + Adjust = BalanceEnd.
type DayLedger struct {
	Day          int              `json:"day"`
	FromTick     int              `json:"fromTick"` // книга начата с этого тика: 0 — с утра; >0 — фикстура/старый сейв посреди дня
	BalanceStart int              `json:"balanceStart"`
	Income       int              `json:"income"`     // доход тиков
	EventMoney   int              `json:"eventMoney"` // деньги исходов событий, со знаком (= DayEventMoney, ITGAME-53)
	Events       []LedgerEvent    `json:"events"`
	Purchases    []LedgerPurchase `json:"purchases"`
	Payroll      int              `json:"payroll"`     // зарплаты людей вечером; у открытого дня 0
	GatewayOpex  int              `json:"gatewayOpex"` // опекс шлюза вечером
	Interest     int              `json:"interest"`    // процент по долгу при закрытии дня (кредит)
	Adjust       int              `json:"adjust"`      // debug-правка баланса (itd.set, restore); в игре 0
	BalanceEnd   int              `json:"balanceEnd"`  // у текущего дня — живой баланс
	Closed       bool             `json:"closed"`      // вечер прошёл: ФОТ списан
	Offline      bool             `json:"offline"`     // день закрыт офлайн-движком (догон, itd.advanceDays)
}

// PurchasesTotal — сумма покупок дня.
func (l DayLedger) PurchasesTotal() int {
	total := 0
	for _, p := range l.Purchases {
		total += p.Price
	}
	return total
}

// Sum — баланс, собранный из слагаемых; равен BalanceEnd.
func (l DayLedger) Sum() int {
	return l.BalanceStart + l.Income + l.EventMoney - l.PurchasesTotal() -
		l.Payroll - l.GatewayOpex - l.Interest + l.Adjust
}

// Profit — «Прибыль» отчёта дня (доход + события − ФОТ − опекс): покупки и
// процент в неё не входят — как в day_report.profit.
func (l DayLedger) Profit() int {
	return l.Income + l.EventMoney - l.Payroll - l.GatewayOpex
}

func (l DayLedger) clone() DayLedger {
	l.Events = slices.Clone(l.Events)
	l.Purchases = slices.Clone(l.Purchases)
	return l
}

// beginLedger — новая книга с текущего момента.
func (g *Game) beginLedger() {
	g.Ledger = DayLedger{Day: g.Day, FromTick: g.TickInDay, BalanceStart: g.Money}
}

// archiveLedger — текущая книга уходит в историю (перед сменой дня).
func (g *Game) archiveLedger() {
	l := g.Ledger
	l.BalanceEnd = g.Money
	g.LedgerHistory = append(g.LedgerHistory, l)
	if n := len(g.LedgerHistory); n > LedgerDays {
		g.LedgerHistory = slices.Clone(g.LedgerHistory[n-LedgerDays:])
	}
}

// spend — списание покупки: деньги и строка книги.
func (g *Game) spend(kind Command, price int) {
	g.Money -= price
	if price == 0 {
		return
	}
	ps := g.Ledger.Purchases
	if len(ps) >= ledgerItemsCap {
		last := &ps[len(ps)-1]
		if last.N == 0 {
			last.N = 1
		}
		last.Type, last.Price, last.Clock, last.N = "…", last.Price+price, g.Clock(), last.N+1
		return
	}
	g.Ledger.Purchases = append(ps, LedgerPurchase{Type: string(kind), Price: price, Clock: g.Clock()})
}

// chargeDay — вечернее списание ФОТ и опекса (живой тик и офлайн).
func (g *Game) chargeDay(expenses, opex int) {
	g.Money -= expenses
	g.Ledger.Payroll += expenses - opex
	g.Ledger.GatewayOpex += opex
	g.Ledger.Closed = true
}

// AdjustMoney — debug-правка баланса (itd.set): разница уходит в Adjust,
// и книга дня остаётся сведённой.
func (g *Game) AdjustMoney(money int) {
	g.Ledger.Adjust += money - g.Money
	g.Money = money
}

// RelabelLedger — debug-правка номера дня: книга текущего дня следует за ним.
func (g *Game) RelabelLedger() { g.Ledger.Day = g.Day }

// LedgerOf — книга дня: day 0 — текущий; иначе текущий или из истории.
// У текущего BalanceEnd — живой баланс.
func (g *Game) LedgerOf(day int) (DayLedger, bool) {
	if day == 0 || day == g.Ledger.Day {
		l := g.Ledger.clone()
		l.BalanceEnd = g.Money
		return l, true
	}
	for i := len(g.LedgerHistory) - 1; i >= 0; i-- {
		if g.LedgerHistory[i].Day == day {
			return g.LedgerHistory[i].clone(), true
		}
	}
	return DayLedger{}, false
}

// LedgerDayList — дни, по которым есть книга: история, затем текущий.
func (g *Game) LedgerDayList() []int {
	out := make([]int, 0, len(g.LedgerHistory)+1)
	for _, l := range g.LedgerHistory {
		out = append(out, l.Day)
	}
	return append(out, g.Ledger.Day)
}

// restoreLedger — книга из сейва. Нет книги или она другого дня (старый
// сейв, фикстура, debug-дельта сменила день) — новая с текущего тика.
// Дельта, сменившая баланс, сводится через Adjust: инвариант держится.
func (g *Game) restoreLedger(cur *DayLedger, hist []DayLedger) {
	g.LedgerHistory = nil
	for _, l := range hist {
		g.LedgerHistory = append(g.LedgerHistory, l.clone())
	}
	if n := len(g.LedgerHistory); n > LedgerDays {
		g.LedgerHistory = g.LedgerHistory[n-LedgerDays:]
	}
	if cur == nil || cur.Day != g.Day {
		g.beginLedger()
		return
	}
	g.Ledger = cur.clone()
	g.Ledger.BalanceEnd = 0
	g.Ledger.Adjust += g.Money - g.Ledger.Sum()
}
