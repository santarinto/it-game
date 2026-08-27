package game

import (
	"math"
	"math/rand/v2"
)

// Phase — фаза игры; значения совпадают с полем phase протокола.
type Phase string

const (
	PhaseRunning   = Phase("running")
	PhaseDayReport = Phase("day_report") // день кончился, ждём next_day
	PhaseGameOver  = Phase("game_over")  // банкротство, ждём restart
	PhaseWon       = Phase("won")        // цель достигнута, игра заморожена
)

// Employee — сотрудник: имя и личная выработка, роллятся при найме навсегда.
type Employee struct {
	Name          string
	IncomePerTick int
	UnpaidToday   bool // нанят после обеда: в ФОТ текущего дня не входит
	CoffeeUntil   int  // бафф кофе действует, пока тик дня < CoffeeUntil; 0 — нет
	// Активный день (итерация 9): мотивация кликом и поломки ПК.
	MotivatedUntil        int  // бафф «мотивирован», пока тик < MotivatedUntil; 0 — нет
	MotivateCooldownUntil int  // повторная мотивация возможна с этого тика дня
	PCBroken              bool // ПК сломан: доход места 0 до починки
	RepairClicks          int  // клики починки накоплены; чинит на RepairClicksNeeded

	// Unseen Forces (итерация 10).
	SalaryAdd     int // повышение: надбавка к дневной зарплате, навсегда
	OffendedUntil int // отказ в повышении: дебафф пока тик < OffendedUntil

	// Сотрудники 2.0 (итерация 15).
	Star    bool // звезда: выработка уже умножена при найме, бейдж ★
	HireDay int  // день найма: компенсация увольнения в тот же день ниже
	XP      int  // опыт за продуктивные тики; уровень — производный (LevelFor)
}

// Game — состояние одной игры. НЕ потокобезопасен: им владеет
// ровно одна горутина (актор сессии в пакете ws).
type Game struct {
	cfg Config
	rng *rand.Rand

	Money     int
	Offices   []Office
	CoreLevel int  // core-коммутатор: 0 — не куплен, 1..len(cfg.CoreLevels)
	Gateway   bool // шлюз в интернет: ×GatewayBonus подключённым, опекс $/день

	Phase             Phase
	Day               int // номер игрового дня, с 1
	TickInDay         int // тиков прошло в текущем дне
	DayIncome         int // доход, накопленный за текущий день (для отчёта)
	PeakIncomePerTick int // максимум дохода за тик за игру (для итогов банкротства)
	DayIncidents      int // поломок ПК за текущий день (для отчёта)
	DayLostIncome     int // упущено из-за поломок за текущий день (для отчёта)

	// Unseen Forces (итерация 10): план дня, активное событие и рантайм
	// дедлайна. Владеет всем этим актор сессии, как и остальным стейтом.
	DayEvents    []DayEvent // события, роллящиеся в NextDay
	ActiveEvent  *DayEvent  // висит, ждёт выбора (одно одновременно)
	EventLog     []string   // итоги событий дня для отчёта
	DeadlineOn   bool       // дедлайн принят
	DeadlineGot  int        // накоплено $ с принятия
	DeadlineGoal int        // цель, $
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

// Clock — текущее игровое время «HH:MM»: WorkdayStart плюс 10 минут за тик.
func (g *Game) Clock() string { return g.cfg.clockAt(g.TickInDay) }

// ClockAt — игровое время произвольного тика (для протокола).
func (g *Game) ClockAt(tick int) string { return g.cfg.clockAt(tick) }

// LevelFor — уровень сотрудника по накопленному XP (производный, не хранится).
func (g *Game) LevelFor(e *Employee) int {
	level := 0
	for i, need := range g.cfg.EmployeeLevelXP {
		if e.XP >= need {
			level = i + 1
		}
	}
	return level
}

// levelBonus — прибавка к выработке за уровень сотрудника, $/тик.
func (g *Game) levelBonus(e *Employee) int {
	if lvl := g.LevelFor(e); lvl > 0 {
		return g.cfg.EmployeeLevelBonus[lvl-1]
	}
	return 0
}

// XPNext — XP до следующего уровня; 0 на потолке.
func (g *Game) XPNext(e *Employee) int {
	for _, need := range g.cfg.EmployeeLevelXP {
		if e.XP < need {
			return need
		}
	}
	return 0
}

// accrueXP — опыт за тик: каждому сотруднику с целым ПК (не в обед —
// вызывается только из Tick на продуктивном тике). Начальник в офисе
// менторствует: ×1.5. На потолке уровней опыт не копится.
func (g *Game) accrueXP() {
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked {
			continue
		}
		rate := g.cfg.XPPerTick
		if o.Boss != "" {
			rate = g.cfg.XPMentorPerTick
		}
		for i := range o.Employees {
			e := &o.Employees[i]
			if e.PCBroken || g.XPNext(e) == 0 {
				continue
			}
			e.XP += rate
		}
	}
}

// IsLunch — идёт ли сейчас обед (в обед доход за тик равен нулю).
func (g *Game) IsLunch() bool { return g.cfg.isLunchTick(g.TickInDay) }

// IncomePerTick — доход за один тик; во время обеда — 0.
func (g *Game) IncomePerTick() int {
	if g.IsLunch() {
		return 0
	}
	return g.incomeAtTick(g.TickInDay)
}

// incomeAtTick — доход компании за конкретный (продуктивный) тик дня:
// личная выработка × эффекты × сетевой множитель из цепочки
// «роутер → core → сервер» (см. Network).
func (g *Game) incomeAtTick(tick int) int {
	total, _ := g.incomeAtTickDetail(tick)
	return total
}

// incomeAtTickDetail — доход тика и упущенное из-за сломанных ПК:
// сколько заработал бы сотрудник сломанного места без поломки.
func (g *Game) incomeAtTickDetail(tick int) (total, lost int) {
	if g.cfg.isLunchTick(tick) {
		return 0, 0
	}
	net := g.Network()
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked {
			continue
		}
		for i := range o.Employees {
			e := &o.Employees[i]
			// Прибавка уровня входит в личную выработку до эффектов и сети:
			// тенюра масштабируется инфраструктурой (итерация 15).
			v := int(math.Round(float64(e.IncomePerTick+g.levelBonus(e)) * g.effectMult(o, e, tick) * net.Mults[oi][i]))
			if e.PCBroken {
				lost += v
				continue
			}
			total += v
		}
	}
	return total, lost
}

// PayrollPerDay — полные дневные расходы: зарплаты сотрудников и боссов
// (кроме нанятых после обеда — им сегодня не платим) плюс опекс шлюза.
func (g *Game) PayrollPerDay() int {
	total := 0
	for i := range g.Offices {
		o := &g.Offices[i]
		if !o.Unlocked {
			continue // защита от рассинхрона, симметрично доходу
		}
		for _, e := range o.Employees {
			if !e.UnpaidToday {
				total += g.cfg.SalaryPerDay + e.SalaryAdd
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

// ForecastEndOfDay — баланс на конец дня. Считает по-тиково: дебаффы
// будущих тиков предсказуемы, будущий кофе не угадываем (консервативно).
func (g *Game) ForecastEndOfDay() int {
	total := g.Money
	for t := g.TickInDay; t < g.cfg.DayTicks(); t++ {
		if !g.cfg.isLunchTick(t) {
			total += g.incomeAtTick(t)
		}
	}
	return total - g.PayrollPerDay()
}

// DayReport — итоги дня для сообщения протокола.
type DayReport struct {
	Day         int
	Income      int
	Payroll     int // зарплаты людей (сотрудники + боссы)
	GatewayOpex int // операционный расход шлюза
	Profit      int
	Balance     int
	Incidents   int      // поломок ПК за день
	LostIncome  int      // упущено из-за поломок, $
	Events      []string // события дня: по строке на итог
}

// Tick — один шаг симуляции (1 секунда). Вне фазы running — no-op.
// Если этот тик закончил день, списывает ФОТ, переводит фазу
// (day_report, при балансе < 0 — game_over) и возвращает отчёт.
func (g *Game) Tick() *DayReport {
	if g.Phase != PhaseRunning {
		return nil
	}
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked || !o.CoffeeMachine {
			continue
		}
		for _, et := range o.CoffeeEventTicks {
			if et == g.TickInDay {
				for i := range o.Employees {
					if g.rng.IntN(100) < g.cfg.CoffeeChancePct {
						o.Employees[i].CoffeeUntil = g.TickInDay + g.cfg.CoffeeTicks
					}
				}
			}
		}
	}
	g.rollBreakdowns()
	g.activateEvents()
	income, lost := g.incomeAtTickDetail(g.TickInDay)
	if !g.cfg.isLunchTick(g.TickInDay) {
		g.accrueXP()
	}
	g.Money += income
	g.DayIncome += income
	g.DayLostIncome += lost
	g.tickEvents(income)
	g.PeakIncomePerTick = max(g.PeakIncomePerTick, income)
	// Победа проверяется до конца дня: достиг цели днём — победа сразу,
	// вечерний ФОТ уже не списывается.
	if g.cfg.WinTarget > 0 && g.Money >= g.cfg.WinTarget {
		g.Phase = PhaseWon
		return nil
	}
	g.TickInDay++
	if g.TickInDay < g.cfg.DayTicks() {
		return nil
	}
	g.autoResolveEvents()
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
		GatewayOpex: opex, Profit: g.DayIncome - expenses, Balance: g.Money,
		Incidents: g.DayIncidents, LostIncome: g.DayLostIncome, Events: g.EventLog}
}

// rollBreakdowns — инциденты дня: с шансом за тик на офис ломается ПК
// случайного занятого слота. Максимум один сломанный ПК на офис
// одновременно — иначе ранняя игра карается, а поздняя тонет в ремонте.
func (g *Game) rollBreakdowns() {
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked || len(o.Employees) == 0 {
			continue
		}
		broken := false
		for i := range o.Employees {
			if o.Employees[i].PCBroken {
				broken = true
				break
			}
		}
		if broken || g.rng.IntN(100) >= g.cfg.BreakdownChancePct {
			continue
		}
		slot := g.rng.IntN(len(o.Employees))
		o.Employees[slot].PCBroken = true
		o.Employees[slot].RepairClicks = 0
		g.DayIncidents++
	}
}
