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
	UnpaidToday   bool // нанят после обеда: в ФОТ текущего дня не входит
}

// Game — состояние одной игры. НЕ потокобезопасен: им владеет
// ровно одна горутина (актор сессии в пакете ws).
type Game struct {
	cfg Config
	rng *rand.Rand

	Money   int
	Offices []Office
	Servers int
	Gateway bool // шлюз в интернет: ×GatewayBonus подключённым, опекс $/день

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
	g := &Game{
		cfg:   cfg,
		rng:   rand.New(rand.NewPCG(s1, s2)),
		Money: cfg.StartMoney, Phase: PhaseRunning, Day: 1,
		Offices: make([]Office, 3),
	}
	g.Offices[0] = Office{Unlocked: true, PCs: cfg.StartPCs}
	return g
}

// Config возвращает баланс, с которым создана игра (для снапшотов протокола).
func (g *Game) Config() Config { return g.cfg }

// Multiplier — множитель компании для подключённых рабочих мест:
// серверы дают базу, шлюз умножает её ещё раз. Применяется только
// подключённым (подключение по-офисно, см. Office.Connected).
func (g *Game) Multiplier() float64 {
	m := g.cfg.NetworkBase + g.cfg.ServerBonus*float64(g.Servers)
	if g.Gateway {
		m *= g.cfg.GatewayBonus
	}
	return m
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

// incomePotentialPerTick — доход за продуктивный тик по всем открытым
// офисам: первые Connected() сотрудников офиса — с множителем компании.
func (g *Game) incomePotentialPerTick() int {
	mult := g.Multiplier()
	total := 0
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked {
			continue
		}
		connected := o.Connected(g.cfg)
		for i, e := range o.Employees {
			if i < connected {
				total += int(math.Round(float64(e.IncomePerTick) * mult))
			} else {
				total += e.IncomePerTick
			}
		}
	}
	return total
}

// PayrollPerDay — полные дневные расходы: зарплаты сотрудников и боссов
// (кроме нанятых после обеда — им сегодня не платим) плюс опекс шлюза.
func (g *Game) PayrollPerDay() int {
	total := 0
	for i := range g.Offices {
		o := &g.Offices[i]
		for _, e := range o.Employees {
			if !e.UnpaidToday {
				total += g.cfg.SalaryPerDay
			}
		}
		if o.Boss != "" && !o.BossUnpaidToday {
			total += g.cfg.BossSalaryPerDay
		}
	}
	if g.Gateway {
		total += g.cfg.GatewayOpexPerDay
	}
	return total
}

// gatewayOpex — дневной опекс шлюза (0, если шлюза нет).
func (g *Game) gatewayOpex() int {
	if g.Gateway {
		return g.cfg.GatewayOpexPerDay
	}
	return 0
}

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
	Day         int
	Income      int
	Payroll     int // зарплаты людей (сотрудники + боссы)
	GatewayOpex int // операционный расход шлюза
	Profit      int
	Balance     int
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
	expenses := g.PayrollPerDay()
	opex := g.gatewayOpex()
	payroll := expenses - opex
	g.Money -= expenses
	if g.Money < 0 {
		g.Phase = PhaseGameOver
	} else {
		g.Phase = PhaseDayReport
	}
	return &DayReport{Day: g.Day, Income: g.DayIncome, Payroll: payroll,
		GatewayOpex: opex, Profit: g.DayIncome - expenses, Balance: g.Money}
}
