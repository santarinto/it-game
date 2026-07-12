package game

import (
	"fmt"
	"math"
	"math/rand/v2"
)

// Phase — фаза игры; значения совпадают с полем phase протокола.
type Phase string

const (
	PhaseRunning   = Phase("running")
	PhaseDayReport = Phase("day_report") // день кончился, ждём next_day
	PhaseGameOver  = Phase("game_over")  // банкротство, ждём restart
)

// Employee — сотрудник: имя и личная выработка, роллятся при найме навсегда.
type Employee struct {
	Name          string
	IncomePerTick int
}

// Game — состояние одной игры. НЕ потокобезопасен: им владеет
// ровно одна горутина (актор сессии в пакете ws).
type Game struct {
	cfg Config
	rng *rand.Rand

	Money      int
	PCs        int // ПК в офисе; первые Employees из них заняты сотрудниками
	Employees  []Employee
	RouterTier int // 0 — роутера нет; 1..len(cfg.RouterTiers)
	Servers    int

	Phase             Phase
	Day               int // номер игрового дня, с 1
	TickInDay         int // тиков прошло в текущем дне
	DayIncome         int // доход, накопленный за текущий день (для отчёта)
	PeakIncomePerTick int // максимум дохода за тик за игру (для итогов банкротства)
}

func New(cfg Config) *Game {
	return NewWithSeed(cfg, rand.Uint64(), rand.Uint64())
}

// NewWithSeed — игра с фиксированным сидом: детерминированные роллы для тестов.
func NewWithSeed(cfg Config, s1, s2 uint64) *Game {
	return &Game{
		cfg:   cfg,
		rng:   rand.New(rand.NewPCG(s1, s2)),
		Money: cfg.StartMoney, PCs: cfg.StartPCs, Phase: PhaseRunning, Day: 1,
	}
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
	return min(g.Ports(), len(g.Employees))
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

// Clock — текущее игровое время «HH:MM»: WorkdayStart плюс 10 минут за тик.
func (g *Game) Clock() string {
	minutes := g.TickInDay * 60 / g.cfg.TicksPerHour
	return fmt.Sprintf("%02d:%02d", g.cfg.WorkdayStart+minutes/60, minutes%60)
}

// IsLunch — идёт ли сейчас обед (в обед доход за тик равен нулю).
func (g *Game) IsLunch() bool { return g.cfg.isLunchTick(g.TickInDay) }

// IncomePerTick — доход за один тик; во время обеда — 0.
func (g *Game) IncomePerTick() int {
	if g.IsLunch() {
		return 0
	}
	return g.incomePotentialPerTick()
}

// incomePotentialPerTick — доход за продуктивный (не обеденный) тик:
// сумма личных выработок, первые Connected() — с сетевым множителем.
func (g *Game) incomePotentialPerTick() int {
	connected := g.Connected()
	mult := g.Multiplier()
	total := 0
	for i, e := range g.Employees {
		if i < connected {
			total += int(math.Round(float64(e.IncomePerTick) * mult))
		} else {
			total += e.IncomePerTick
		}
	}
	return total
}

// PayrollPerDay — дневной фонд оплаты труда при текущем штате.
func (g *Game) PayrollPerDay() int { return len(g.Employees) * g.cfg.SalaryPerDay }

// ForecastEndOfDay — баланс на конец дня: деньги + доход за оставшиеся
// продуктивные тики − ФОТ. Считает сервер: клиентская формула не знает про обед.
func (g *Game) ForecastEndOfDay() int {
	productive := 0
	for t := g.TickInDay; t < g.cfg.DayTicks(); t++ {
		if !g.cfg.isLunchTick(t) {
			productive++
		}
	}
	return g.Money + g.incomePotentialPerTick()*productive - g.PayrollPerDay()
}

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
	if g.TickInDay < g.cfg.DayTicks() {
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
