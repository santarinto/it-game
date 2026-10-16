package game

import (
	"fmt"
	"math"
	"math/rand/v2"
	"strconv"
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
	RepairClicks          int  // клики починки накоплены; чинит на RepairTarget()
	// N кликов этой поломки (ITGAME-93): роллится в rollBreakdowns из
	// RepairClicksMin..RepairClicksMax, игрок видит «k/N». 0 — ПК цел (или
	// сейв до ITGAME-93: Restore дописывает LegacyRepairClicks).
	RepairNeeded int

	// Unseen Forces (итерация 10).
	SalaryAdd     int // повышение: надбавка к дневной зарплате, навсегда
	OffendedUntil int // отказ в повышении: дебафф пока тик < OffendedUntil

	// Сотрудники 2.0 (итерация 15).
	Star    bool // звезда: выработка уже умножена при найме, бейдж ★
	HireDay int  // день найма: компенсация увольнения в тот же день ниже
	XP      int  // опыт за продуктивные тики; уровень — производный (LevelFor)

	// Вирус (ITGAME-103): заражение живёт на месте, как поломка. Само не
	// проходит — ни ночью, ни офлайн; чистят VirusCleanClicks кликов.
	Infected    bool // место заражено: выработка ×VirusMult
	VirusClicks int  // клики чистки накоплены (k из «k/3»)
}

// Game — состояние одной игры. НЕ потокобезопасен: им владеет
// ровно одна горутина (актор сессии в пакете ws).
type Game struct {
	cfg Config
	rng *rand.Rand
	// pcg — источник rng: его позицию сериализуют RNGState/SetRNGState
	// (ITGAME-46, чекпоинты журнала партии). rand.Rand в v2 своего
	// состояния не держит — позиция потока целиком в PCG.
	pcg *rand.PCG
	// Seed — видимый сид RNG (ITGAME-26): генерится при создании партии,
	// хранится в сейве, задаётся через ?seed=. Детерминизм — роллы
	// событий/найма при одинаковых действиях, не тик-в-тик во времени.
	Seed uint64

	Money     int
	Offices   []Office
	CoreLevel int  // core-коммутатор: 0 — не куплен, 1..len(cfg.CoreLevels)
	Gateway   bool // шлюз в интернет: ×GatewayBonus подключённым, опекс $/день

	Phase             Phase
	Day               int // номер игрового дня, с 1
	TickInDay         int // тиков прошло в текущем дне
	DayIncome         int // доход, накопленный за текущий день (для отчёта)
	DayEventMoney     int // деньги исходов событий за день, со знаком (ITGAME-53)
	PrevDayIncome     int // доход последнего закрытого дня — база штрафа аудита (ITGAME-50)
	PeakIncomePerTick int // максимум дохода за тик за игру (для итогов банкротства)
	DayIncidents      int // поломок ПК за текущий день (для отчёта)
	DayLostIncome     int // упущено из-за поломок за текущий день (для отчёта)

	// Вирус (ITGAME-103). VirusWaveIn — тиков партии до волны: общий на
	// компанию таймер, тикает и в обед, переходит через ночь; 0 — заражённых нет.
	VirusWaveIn  int
	DayVirusPCs  int // новых заражений за текущий день (вспышки и волны)
	DayVirusLost int // упущено из-за вируса за текущий день: −30% заражённых мест

	// Подписка на антивирус (ITGAME-137): AVTier — включённый тариф (0 — нет,
	// 1..len(cfg.AntivirusTiers)); AVTierBilled — самый дорогой тариф,
	// включённый за день хоть раз: вечером списывается его цена.
	AVTier       int
	AVTierBilled int

	// Won-финал: причина проигрыша для протокола (bankrupt | time_up);
	// живёт только в терминальной фазе, в сейвы не попадает.
	LoseReason string

	// Unseen Forces (итерация 10): план дня, активное событие и рантайм
	// дедлайна. Владеет всем этим актор сессии, как и остальным стейтом.
	DayEvents    []DayEvent // события, роллящиеся в NextDay
	ActiveEvent  *DayEvent  // висит, ждёт выбора (одно одновременно)
	EventLog     []string   // итоги событий дня для отчёта
	DeadlineOn   bool       // дедлайн принят
	DeadlineGot  int        // накоплено $ с принятия
	DeadlineGoal int        // цель, $

	// Рынок (Сложность 2.0, ITGAME-9): модификатор выработки дня, %.
	// Завтрашний ролл виден заранее — решение «нанять сейчас или ждать».
	// День 1 без рынка (онбординг), дальше качели ±MarketSwingPct.
	MarketToday    int
	MarketTomorrow int

	// Бухгалтерия (ITGAME-73): книга текущего дня и LedgerDays закрытых
	// (см. ledger.go). Пишется там же, где меняется Money.
	Ledger        DayLedger
	LedgerHistory []DayLedger
}

// Причины проигрыша — значения поля reason протокола.
const (
	LoseBankrupt = "bankrupt" // долг за кредитным порогом / минус без кредита
	LoseTimeUp   = "time_up"  // дедлайн уровня: день X закрыт без победы
	LoseDeadlock = "deadlock" // софт-лок: штат пуст и средств на развитие нет
)

func New(cfg Config) *Game {
	return NewSeeded(cfg, rand.Uint64())
}

// NewSeeded — игра с сидом из одного числа (агентский ?seed=): второй
// параметр PCG выводится из него детерминированно (splitmix64-финализатор),
// чтобы ?seed=1234 всегда давал одну и ту же пару состояний.
func NewSeeded(cfg Config, seed uint64) *Game {
	return NewWithSeed(cfg, seed, mixSeed(seed))
}

// mixSeed — детерминированный второй параметр PCG из единственного сида.
func mixSeed(seed uint64) uint64 {
	x := seed + 0x9E3779B97F4A7C15
	x ^= x >> 30
	x *= 0xBF58476D1CE4E5B9
	x ^= x >> 27
	x *= 0x94D049BB133111EB
	x ^= x >> 31
	return x
}

// SeedString — сид для снапшотов протокола: uint64 не влезает в JSON-число
// JS без потери точности, поэтому строка (десятичная).
func (g *Game) SeedString() string { return strconv.FormatUint(g.Seed, 10) }

// NewWithSeed — игра с фиксированным сидом: детерминированные роллы для тестов.
// Видимый сид игры — s1.
func NewWithSeed(cfg Config, s1, s2 uint64) *Game {
	pcg := rand.NewPCG(s1, s2)
	g := &Game{
		cfg:   cfg,
		rng:   rand.New(pcg),
		pcg:   pcg,
		Seed:  s1,
		Money: cfg.StartMoney, Phase: PhaseRunning, Day: 1,
		Offices: make([]Office, 3),
	}
	g.Offices[0] = Office{Unlocked: true, PCs: cfg.StartPCs}
	// Рынок: сегодня онбординг без качелей, завтрашний ролл уже виден.
	g.MarketTomorrow = g.rollMarket()
	g.beginLedger()
	return g
}

// RNGState — позиция потока роллов (ITGAME-46): вместе с Export это полное
// состояние партии — чекпоинт журнала восстанавливается из них тик-в-тик.
func (g *Game) RNGState() []byte {
	b, _ := g.pcg.MarshalBinary() // PCG.MarshalBinary не падает
	return b
}

// SetRNGState — вернуть позицию потока роллов, снятую RNGState.
func (g *Game) SetRNGState(b []byte) error { return g.pcg.UnmarshalBinary(b) }

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

// marketMult — множитель рыночных качелей на выработку (Сложность 2.0).
func (g *Game) marketMult() float64 { return 1 + float64(g.MarketToday)/100 }

// rollMarket — рыночный ролл дня: шаг 5% в [−MarketSwingPct, +MarketSwingPct];
// MarketSwingPct = 0 — рынка нет, всегда 0.
func (g *Game) rollMarket() int {
	k := g.cfg.MarketSwingPct
	if k <= 0 {
		return 0
	}
	return (g.rng.IntN(2*k/5+1) - k/5) * 5
}

// staffCount — сотрудники всех открытых офисов (комбо-цель WinStaff).
func (g *Game) staffCount() int {
	n := 0
	for i := range g.Offices {
		if g.Offices[i].Unlocked {
			n += len(g.Offices[i].Employees)
		}
	}
	return n
}

// won — цель уровня достигнута: баланс плюс комбо (штат/сеть), если заданы.
func (g *Game) won() bool {
	if g.cfg.WinTarget <= 0 || g.Money < g.cfg.WinTarget {
		return false
	}
	if g.cfg.WinStaff > 0 && g.staffCount() < g.cfg.WinStaff {
		return false
	}
	return g.cfg.WinCore <= 0 || g.CoreLevel >= g.cfg.WinCore
}

// settleDebt — конец дня с отрицательным балансом (Сложность 2.0): долг
// растёт на CreditRate за день; за кредитным порогом — банкротство.
// Уровни без кредита (CreditLimit 0) банкротят сразу — как до итерации 17.
func (g *Game) settleDebt() bool {
	if g.Money >= 0 {
		return false
	}
	interest := int(math.Ceil(float64(-g.Money) * g.cfg.CreditRate))
	g.Money -= interest
	g.Ledger.Interest += interest
	return -g.Money > g.cfg.CreditLimit
}

// TotalEmployees — суммарное число сотрудников во всех открытых офисах.
func (g *Game) TotalEmployees() int {
	return g.staffCount()
}

// AvailableFunds — средства, доступные для покупок и найма.
// Так как ни одна команда игры не позволяет уходить в отрицательный баланс
// (все покупки и найм требуют Money >= price, а кредит в settleDebt регулирует
// лишь выживание при ночном списании ФОТ), покупательная способность равна Money.
func (g *Game) AvailableFunds() int {
	return g.Money
}

// MinCostToEarn — минимальная стоимость создания хотя бы одного источника дохода
// (найма одного сотрудника с учётом покупки ПК или офиса при необходимости).
func (g *Game) MinCostToEarn() int {
	minCost := math.MaxInt
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if o.Unlocked {
			cap := o.StaffCap(g.cfg)
			if len(o.Employees) < cap {
				if o.PCs > len(o.Employees) {
					// Свободный ПК уже есть — платим только за найм
					if g.cfg.HirePrice < minCost {
						minCost = g.cfg.HirePrice
					}
				} else if o.PCs < g.cfg.OfficeSlots {
					// ПК нет — покупка ПК + найм
					cost := g.NextPCPrice(oi) + g.cfg.HirePrice
					if cost < minCost {
						minCost = cost
					}
				}
			}
		} else {
			// Офис закрыт — разблокировка + ПК + найм
			if oi > 0 && oi-1 < len(g.cfg.OfficePrices) {
				cost := g.cfg.OfficePrices[oi-1] + g.cfg.PCPrice + g.cfg.HirePrice
				if cost < minCost {
					minCost = cost
				}
			}
		}
	}
	return minCost
}

// IsDeadlocked возвращает true, если компания оказалась в софт-локе:
// неотрицательный баланс при пустом штате (нет источников дохода),
// при этом денег не хватает даже на самое дешёвое действие для получения дохода.
// Отрицательный баланс тупиком не является — он регулируется кредитом и ведёт к
// банкротству (settleDebt).
func (g *Game) IsDeadlocked() bool {
	if g.Money < 0 || g.TotalEmployees() > 0 {
		return false
	}
	return g.Money < g.MinCostToEarn()
}

// doomHorizonDays — дальше прогноз банкротства не считаем: долг, который
// растёт так медленно, сигналом «выхода нет» не является.
const doomHorizonDays = 365

// BankruptInDays — через сколько закрытий дня обречённая партия обанкротится
// (ITGAME-118); 0 — не обречена. Обречена: уровень с кредитом, партия идёт,
// баланс в минусе (ни покупки, ни увольнения: всё требует Money >= цена) и
// доход штата не покрывает ФОТ и проценты до CreditLimit. Доход — по шаблону
// офлайн-движка, но с целыми и чистыми ПК: ремонт и чистка кликами бесплатны,
// сломанный ПК — не тупик, хотя ночью он сам больше не чинится (ITGAME-136),
// заражённое место — тоже, хотя вирус сам не проходит (ITGAME-103). Без баффов и
// событий, рынок нейтрален. Сегодня — остаток дня от текущего тика,
// поэтому прогноз не скачет в течение дня. Дедлайн уровня раньше банкротства
// закроет партию по time_up — тогда 0: предупреждать о банкротстве незачем.
func (g *Game) BankruptInDays() int {
	if g.cfg.CreditLimit <= 0 || g.Phase != PhaseRunning || g.Money >= 0 {
		return 0
	}
	tpl := g.offlineTemplate()
	tpl.MarketToday = 0
	for i := range tpl.Offices {
		for j := range tpl.Offices[i].Employees { // своя копия шаблона, живую игру не трогает
			tpl.Offices[i].Employees[j].PCBroken = false
			tpl.Offices[i].Employees[j].Infected = false
		}
	}
	dayTicks := g.cfg.DayTicks()
	net := tpl.sumIncome(0, dayTicks) - tpl.PayrollPerDay()
	money := g.Money + tpl.sumIncome(g.TickInDay, dayTicks) - g.PayrollPerDay()
	for d := 1; d <= doomHorizonDays; d++ {
		if g.cfg.WinDayLimit > 0 && g.Day+d-1 > g.cfg.WinDayLimit {
			return 0
		}
		if money >= 0 {
			return 0
		}
		money -= int(math.Ceil(float64(-money) * g.cfg.CreditRate))
		if -money > g.cfg.CreditLimit {
			return d
		}
		money += net
	}
	return 0
}

// closeDay — конец дня после списания ФОТ: кредит или банкротство,
// затем дедлайн уровня (время вышло без победы), затем тупик. Переводит фазу.
func (g *Game) closeDay() {
	g.Phase = PhaseDayReport
	if g.settleDebt() {
		g.Phase = PhaseGameOver
		g.LoseReason = LoseBankrupt
	} else if g.Money < 0 {
		g.logEvent(fmt.Sprintf("кредит: долг $%d под %d%%/день", -g.Money, int(g.cfg.CreditRate*100)))
	}
	if g.Phase == PhaseDayReport && g.cfg.WinDayLimit > 0 && g.Day >= g.cfg.WinDayLimit {
		g.Phase = PhaseGameOver
		g.LoseReason = LoseTimeUp
	}
	if g.Phase == PhaseDayReport && g.IsDeadlocked() {
		g.Phase = PhaseGameOver
		g.LoseReason = LoseDeadlock
	}
}

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
	total, _, _ := g.incomeAtTickDetail(tick)
	return total
}

// incomeAtTickDetail — доход тика, упущенное из-за сломанных ПК (сколько
// заработал бы сотрудник сломанного места без поломки) и упущенное из-за
// вируса (−30% заражённых мест с исправным ПК; у сломанного заражённого
// упущенное целиком — в поломке).
func (g *Game) incomeAtTickDetail(tick int) (total, lost, virusLost int) {
	if g.cfg.isLunchTick(tick) {
		return 0, 0, 0
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
			clean := float64(e.IncomePerTick+g.levelBonus(e)) * g.dayEffectMult(o, e, tick)
			v := int(math.Round(clean * net.Mults[oi][i]))
			healthy := v
			if e.Infected {
				v = int(math.Round(clean * g.cfg.VirusMult * net.Mults[oi][i]))
			}
			if e.PCBroken {
				lost += v
				continue
			}
			virusLost += healthy - v
			total += v
		}
	}
	// Рынок (Сложность 2.0): качели выработки всего дня, один множитель
	// на компанию; округляем сумму, а не каждое место.
	if m := g.marketMult(); m != 1 {
		total = int(math.Round(float64(total) * m))
		lost = int(math.Round(float64(lost) * m))
		virusLost = int(math.Round(float64(virusLost) * m))
	}
	return total, lost, virusLost
}

// PayrollPerDay — полные дневные расходы: зарплаты сотрудников и боссов
// (кроме нанятых после обеда — им сегодня не платим) плюс опекс шлюза и
// подписка на антивирус по самому дорогому тарифу дня (ITGAME-137).
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
	return total + g.antivirusOpex()
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
// Объявленный штраф аудита вычитается, субсидия — нет.
func (g *Game) ForecastEndOfDay() int {
	total := g.Money
	for t := g.TickInDay; t < g.cfg.DayTicks(); t++ {
		if !g.cfg.isLunchTick(t) {
			total += g.incomeAtTick(t)
		}
	}
	return total - g.PayrollPerDay() - g.pendingAuditFine()
}

// DayProfit — прибыль дня, как «Прибыль» отчёта, с прогнозом до вечера:
// доход с утра + деньги событий + остаток дохода − ФОТ − объявленный штраф
// аудита (ITGAME-53). Покупки число не двигают сами по себе — только
// через будущий доход и ФОТ. Штраф аудита виден с тоста, а в 18:00
// переходит из прогноза в деньги событий, и линия не скачет.
func (g *Game) DayProfit() int {
	return g.DayIncome + g.DayEventMoney + g.ForecastEndOfDay() - g.Money
}

// DayReport — итоги дня для сообщения протокола.
type DayReport struct {
	Day         int
	Income      int
	Payroll     int // зарплаты людей (сотрудники + боссы)
	GatewayOpex int // операционный расход шлюза
	Antivirus   int // подписка на антивирус за день (ITGAME-137)
	EventMoney  int // деньги исходов событий дня, со знаком (ITGAME-53)
	Profit      int // доход + деньги событий − ФОТ − опекс − подписка
	Balance     int
	Incidents   int      // поломок ПК за день
	LostIncome  int      // упущено из-за поломок, $
	VirusPCs    int      // новых заражений за день (ITGAME-103)
	VirusLost   int      // упущено из-за вируса, $
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
	// Волна до активации событий: вспышка этого тика заводит таймер с
	// полного интервала, и первая волна приходит ровно через VirusSpreadTicks.
	g.tickVirus()
	g.activateEvents()
	income, lost, virusLost := g.incomeAtTickDetail(g.TickInDay)
	if !g.cfg.isLunchTick(g.TickInDay) {
		g.accrueXP()
	}
	g.Money += income
	g.DayIncome += income
	g.Ledger.Income += income
	g.DayLostIncome += lost
	g.DayVirusLost += virusLost
	g.tickEvents(income)
	g.PeakIncomePerTick = max(g.PeakIncomePerTick, income)
	// Победа проверяется до конца дня: достиг цели днём — победа сразу,
	// вечерний ФОТ уже не списывается.
	if g.won() {
		g.Phase = PhaseWon
		return nil
	}
	g.TickInDay++
	if g.TickInDay < g.cfg.DayTicks() {
		return nil
	}
	g.PrevDayIncome = g.DayIncome
	g.autoResolveEvents()
	g.logVirusEvening()
	expenses := g.PayrollPerDay()
	opex, av := g.gatewayOpex(), g.antivirusOpex()
	payroll := expenses - opex - av
	g.chargeDay(expenses, opex, av)
	g.closeDay()
	return &DayReport{Day: g.Day, Income: g.DayIncome, Payroll: payroll,
		GatewayOpex: opex, Antivirus: av, EventMoney: g.DayEventMoney,
		Profit: g.DayIncome + g.DayEventMoney - expenses, Balance: g.Money,
		Incidents: g.DayIncidents, LostIncome: g.DayLostIncome,
		VirusPCs: g.DayVirusPCs, VirusLost: g.DayVirusLost, Events: g.EventLog}
}

// LegacyRepairClicks — N поломки без своего N: сейв до ITGAME-93, ручная
// поломка тестом или debug-дельтой. Прежнее фиксированное число кликов.
const LegacyRepairClicks = 3

// RepairTarget — сколько кликов чинит этот ПК (N из «k/N»).
func (e *Employee) RepairTarget() int {
	if e.RepairNeeded > 0 {
		return e.RepairNeeded
	}
	return LegacyRepairClicks
}

// rollRepairNeeded — N кликов новой поломки, равномерно из
// RepairClicksMin..RepairClicksMax (ITGAME-93). Ролл из того же PCG, что и
// сама поломка: журнал партии и реплей (ITGAME-46) воспроизводят его.
func (g *Game) rollRepairNeeded() int {
	lo, hi := g.cfg.RepairClicksMin, g.cfg.RepairClicksMax
	if lo <= 0 {
		lo = LegacyRepairClicks
	}
	if hi < lo {
		return lo
	}
	return lo + g.rng.IntN(hi-lo+1)
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
		o.Employees[slot].RepairNeeded = g.rollRepairNeeded()
		g.DayIncidents++
	}
}
