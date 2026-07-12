package game

import "math"

// Phase — фаза игры; значения совпадают с полем phase протокола.
type Phase string

const (
	PhaseRunning   = Phase("running")
	PhaseDayReport = Phase("day_report") // день кончился, ждём next_day
	PhaseGameOver  = Phase("game_over")  // банкротство, ждём restart
)

// Game — состояние одной игры. НЕ потокобезопасен: им владеет
// ровно одна горутина (актор сессии в пакете ws).
type Game struct {
	cfg Config

	Money      int
	PCs        int // ПК в офисе; первые Employees из них заняты сотрудниками
	Employees  int
	RouterTier int // 0 — роутера нет; 1..len(cfg.RouterTiers)
	Servers    int

	Phase             Phase
	Day               int // номер игрового дня, с 1
	TickInDay         int // тиков прошло в текущем дне
	DayIncome         int // доход, накопленный за текущий день (для отчёта)
	PeakIncomePerTick int // максимум дохода за тик за игру (для итогов банкротства)
}

func New(cfg Config) *Game {
	return &Game{cfg: cfg, Money: cfg.StartMoney, PCs: cfg.StartPCs, Phase: PhaseRunning, Day: 1}
}

// Config возвращает баланс, с которым создана игра (для снапшотов протокола).
func (g *Game) Config() Config { return g.cfg }

// Ports — сколько рабочих мест роутер может подключить к сети.
func (g *Game) Ports() int {
	if g.RouterTier == 0 {
		return 0
	}
	return g.cfg.RouterTiers[g.RouterTier-1].Ports
}

// Connected — сколько сотрудников сейчас в сети:
// подключаются автоматически первые N занятых мест, N = порты роутера.
func (g *Game) Connected() int {
	return min(g.Ports(), g.Employees)
}

// Multiplier — сетевой множитель выработки подключённых рабочих мест.
// Роутер сам множителя не даёт — он лишь открывает доступ к серверам;
// без роутера сеть не существует, и серверы не дают ничего.
func (g *Game) Multiplier() float64 {
	if g.RouterTier == 0 {
		return 1.0
	}
	return g.cfg.NetworkBase + g.cfg.ServerBonus*float64(g.Servers)
}

// IncomePerTick — доход за один тик при текущем состоянии.
func (g *Game) IncomePerTick() int {
	base := g.cfg.BaseIncomePerTick
	connected := g.Connected()
	perConnected := int(math.Round(float64(base) * g.Multiplier()))
	return connected*perConnected + (g.Employees-connected)*base
}

// PayrollPerDay — дневной фонд оплаты труда при текущем штате.
func (g *Game) PayrollPerDay() int { return g.Employees * g.cfg.SalaryPerDay }

// DayReport — итоги дня для сообщения протокола.
type DayReport struct {
	Day     int
	Income  int
	Payroll int
	Profit  int
	Balance int
}

// Tick — один шаг симуляции (1 секунда). Вне фазы running — no-op.
// Если этот тик закончил день, списывает ФОТ, переводит фазу
// (day_report, при балансе < 0 — game_over) и возвращает отчёт.
func (g *Game) Tick() *DayReport {
	if g.Phase != PhaseRunning {
		return nil
	}
	income := g.IncomePerTick()
	g.Money += income
	g.DayIncome += income
	g.PeakIncomePerTick = max(g.PeakIncomePerTick, income)
	g.TickInDay++
	if g.TickInDay < g.cfg.DayTicks {
		return nil
	}
	payroll := g.PayrollPerDay()
	g.Money -= payroll
	if g.Money < 0 {
		g.Phase = PhaseGameOver
	} else {
		g.Phase = PhaseDayReport
	}
	return &DayReport{Day: g.Day, Income: g.DayIncome, Payroll: payroll, Profit: g.DayIncome - payroll, Balance: g.Money}
}
