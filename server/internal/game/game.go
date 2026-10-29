package game

import (
	"cmp"
	"fmt"
	"math"
	"math/rand/v2"
	"slices"
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
	Role          string // developer | tester | support | designer | pm | lead | analyst (ITGAME-197)
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
	SalaryAdd int // повышение: надбавка к дневной зарплате, навсегда
	// RaisePct — накопленная прибавка выработки от повышений, %, навсегда
	// (ITGAME-203): множитель 1+RaisePct/100 (см. raiseMult). Отдельное поле, а не
	// правка IncomePerTick: на $7–16/тик округление съедало бы 1–3%.
	RaisePct      int
	OffendedUntil int // отказ в повышении: дебафф пока тик < OffendedUntil

	// Просит уйти пораньше (ITGAME-198).
	AwayFrom        int // отпущен домой: с этого тика дня до вечера выработка 0; 0 — на месте
	OverworkedUntil int // не отпущен: ×OverworkMult, пока тик < OverworkedUntil
	RestedDay       int // отпущен накануне: весь день с этим номером ×MotivateMult; ночь его не сбрасывает

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
	AdminDept bool // отдел админов куплен (ITGAME-101): комната, где сидят админы офисов

	// IncomeCarry — дробный остаток дохода компании, $ в [0, 1) (ITGAME-196,
	// решение владельца 21.10): доход тика складывается точно, в Money идут
	// целые доллары, дробь ждёт следующего тика. Это дробь реальных денег —
	// не сбрасывается ни вечером, ни ночью; новая партия начинает с 0.
	IncomeCarry float64

	Phase             Phase
	Day               int // номер игрового дня, с 1
	TickInDay         int // тиков прошло в текущем дне
	DayIncome         int // доход, накопленный за текущий день (для отчёта)
	DayEventMoney     int // деньги исходов событий за день, со знаком (ITGAME-53)
	PrevDayIncome     int // доход последнего закрытого дня — база штрафа аудита (ITGAME-50)
	PeakIncomePerTick int // максимум дохода за тик за игру (для итогов банкротства)
	DayIncidents      int // поломок ПК за текущий день (для отчёта и бюджета событий дня, ITGAME-196)
	DayLostIncome     int // упущено из-за поломок за текущий день (для отчёта)
	DayAdminRepairs   int // ПК, починенных админами за день (ITGAME-101)
	DayAdminCleaned   int // мест, вычищенных админами за день

	// Очки действий директора на сегодня (ITGAME-127): NextDay и офлайн-утро
	// восполняют их до cfg.ActionPointsPerDay.
	ActionPoints int

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
	// BankruptShortfall — при банкротстве: на сколько долг последнего вечера
	// вышел за порог (кредитный или овердрафта) — «На зарплаты не хватило»
	// экрана проигрыша (ITGAME-176). Как LoseReason — только в терминальной
	// фазе, в сейвы не попадает.
	BankruptShortfall int

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
	LoseBankrupt = "bankrupt" // долг глубже порога: кредитного или овердрафта (ITGAME-156)
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
		Money: cfg.StartMoney, Phase: PhaseRunning, Day: 1, ActionPoints: cfg.ActionPointsPerDay,
		Offices: make([]Office, 3),
	}
	g.Offices[0] = Office{Unlocked: true, PCs: cfg.StartPCs, Workplaces: make([]Workplace, cfg.StartPCs)}
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

// PersonalSalary — личная дневная зарплата сотрудника: ставка, которую ФОТ
// (PayrollPerDay) списывает с него за полный день (нанятого после обеда, UnpaidToday,
// сегодня не списывает); от неё считается процент повышения.
func (g *Game) PersonalSalary(e *Employee) int {
	return g.cfg.SalaryPerDay + e.SalaryAdd
}

// raiseMult — множитель выработки от накопленных повышений (ITGAME-203).
func raiseMult(e *Employee) float64 {
	return 1 + float64(e.RaisePct)/100
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
			if e.PCBroken || o.Workplace(i).Dead || e.away(g.TickInDay) || g.XPNext(e) == 0 { // «требуется замена» (ITGAME-135) не производит; отпущенный домой (ITGAME-198) — тоже
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

// debtLimit — порог долга вечера, глубже которого банкротство (ITGAME-156):
// кредитный порог уровня (сложно, хардкор), а без кредита (легко, норма) —
// овердрафт в payroll, расходы этого вечера: зарплаты, шлюз, подписка.
// Не поле Config: правило выводится из CreditLimit == 0, структура сейва
// та же (SaveFormat не растёт).
func (g *Game) debtLimit(payroll int) int {
	if g.cfg.CreditLimit > 0 {
		return g.cfg.CreditLimit
	}
	return payroll
}

// DebtLimit — порог долга сегодняшнего вечера для снапшота (state.debtLimit):
// PayrollPerDay — то, что вечер спишет, а в отчёте дня — уже списал.
func (g *Game) DebtLimit() int { return g.debtLimit(g.PayrollPerDay()) }

// settleDebt — конец дня с отрицательным балансом: долг растёт на CreditRate
// за день (без кредита ставка 0 — процента нет); минус глубже
// debtLimit(payroll) — банкротство, и то, что вышло за порог, ложится в
// BankruptShortfall. payroll — расходы, списанные этим вечером:
// живой тик и офлайн передают своё (шаблон офлайна платит и за нанятых
// после обеда, живая игра в цикле офлайн-дней — нет).
func (g *Game) settleDebt(payroll int) bool {
	if g.Money >= 0 {
		return false
	}
	interest := int(math.Ceil(float64(-g.Money) * g.cfg.CreditRate))
	g.Money -= interest
	g.Ledger.Interest += interest
	over := -g.Money - g.debtLimit(payroll)
	if over <= 0 {
		return false
	}
	g.BankruptShortfall = over
	return true
}

// TotalEmployees — суммарное число сотрудников во всех открытых офисах.
func (g *Game) TotalEmployees() int {
	return g.staffCount()
}

// AvailableFunds — средства, доступные для покупок и найма.
// Так как ни одна команда игры не позволяет уходить в отрицательный баланс
// (все покупки и найм требуют Money >= price, а кредит или овердрафт в
// settleDebt регулирует лишь выживание при ночном списании ФОТ),
// покупательная способность равна Money.
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
					// Свободный ПК уже есть — платим только за найм. Найм садит за первый
					// свободный стол, даже «требуется замена» (ITGAME-135): тогда плюс замена.
					cost := g.cfg.HirePrice
					if o.Workplace(len(o.Employees)).Dead {
						cost += g.PCReplacePrice()
					}
					if cost < minCost {
						minCost = cost
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
// Отрицательный баланс тупиком не является — он регулируется кредитом или
// овердрафтом и ведёт к банкротству (settleDebt).
func (g *Game) IsDeadlocked() bool {
	if g.Money < 0 || g.TotalEmployees() > 0 {
		return false
	}
	return g.Money < g.MinCostToEarn()
}

// doomHorizonDays — дальше прогноз банкротства не считаем: долг, который
// растёт так медленно, сигналом «выхода нет» не является.
const doomHorizonDays = 365

// doomFix — пункт очереди ремонта прогноза банкротства (ITGAME-127): место и
// что на нём начать — ремонт или чистку; каждый пункт стоит очко действий.
// value — что пункт возвращает: ремонт — личную выработку места (у заражённого
// места — только baseOutput × VirusMult: долю вируса вернёт чистка), чистка —
// долю, которую забирает вирус; вместе они дают всю выработку.
type doomFix struct {
	office, slot int
	virus        bool
	value        float64
}

// doomRepairQueue — на шаблоне прогноза снимает бесплатное и возвращает
// платную очередь. Бесплатно всё в офисах с админом (он чинит и чистит сам,
// ITGAME-101) и начатое — клики уже есть (игроком, админом или вчера). Платное
// идёт по value по убыванию; при равенстве — офис, место, ремонт раньше
// чистки: так чинил бы лучший игрок.
// Допущения ранжирования: value не знает множителя сети (место вне сети
// ранжируется по личной выработке), а на сломанном заражённом месте ремонт
// обгоняет чистку, пока VirusMult ≥ 0.5 (сейчас 0.7 на всех уровнях).
//
// ВНИМАНИЕ: метод ИЗМЕНЯЕТ получателя (снимает бесплатное: PCBroken/Infected),
// хоть и читается как геттер. Звать только на шаблоне прогноза
// (offlineTemplate), никогда на живой игре.
func (g *Game) doomRepairQueue() []doomFix {
	var q []doomFix
	for oi := range g.Offices {
		o := &g.Offices[oi]
		for i := range o.Employees {
			e := &o.Employees[i]
			free := o.Admin != ""
			if e.PCBroken {
				if free || e.RepairClicks > 0 {
					e.PCBroken = false
				} else {
					v := g.baseOutput(o, i)
					if e.Infected {
						v *= g.cfg.VirusMult // остальное вернёт чистка
					}
					q = append(q, doomFix{oi, i, false, v})
				}
			}
			if e.Infected {
				if free || e.VirusClicks > 0 {
					e.Infected = false
				} else {
					q = append(q, doomFix{oi, i, true, g.baseOutput(o, i) * (1 - g.cfg.VirusMult)})
				}
			}
		}
	}
	slices.SortStableFunc(q, func(a, b doomFix) int { return cmp.Compare(b.value, a.value) })
	return q
}

// doomRepair — чинит на шаблоне столько первых пунктов очереди, на сколько
// хватает points очков; возвращает хвост и число починенных.
func (g *Game) doomRepair(q []doomFix, points int) ([]doomFix, int) {
	n := min(max(points, 0)/actionPointCost, len(q))
	for _, f := range q[:n] {
		e := &g.Offices[f.office].Employees[f.slot]
		if f.virus {
			e.Infected = false
		} else {
			e.PCBroken = false
		}
	}
	return q[n:], n
}

// BankruptInDays — через сколько закрытий дня обречённая партия обанкротится
// (ITGAME-118); 0 — не обречена. Обречена: партия идёт, баланс в минусе (ни
// покупки, ни увольнения: всё требует Money >= цена) и доход штата не
// покрывает расходы (и проценты на кредитном уровне) до порога долга —
// CreditLimit или, без кредита, расходы вечера (овердрафт, ITGAME-156:
// сегодня PayrollPerDay живой игры, дальше — шаблона). Доход — по шаблону
// офлайн-движка и в деньги так же, как он (точная сумма с остатком компании,
// ITGAME-222). Сломанные и заражённые места чинит лучший игрок (ITGAME-127):
// в офисах с админом и начатое — сразу, остальное — за очки действий: сегодня
// столько самых выгодных пунктов, сколько осталось очков, каждое утро ещё
// ActionPointsPerDay (doomRepairQueue). Мастера нет — баланс в минусе. Ночью ПК
// сам не чинится (ITGAME-136), вирус сам не проходит (ITGAME-103). ПК «требуется
// замена» (ITGAME-135) — нет: замена стоит денег, шаблон держит его мёртвым. Без баффов и
// событий, рынок нейтрален. Сегодня — остаток дня от текущего тика,
// поэтому прогноз не скачет в течение дня. Дедлайн уровня раньше банкротства
// закроет партию по time_up — тогда 0: предупреждать о банкротстве незачем.
func (g *Game) BankruptInDays() int {
	if g.Phase != PhaseRunning || g.Money >= 0 {
		return 0
	}
	tpl := g.offlineTemplate() // своя копия шаблона, живую игру не трогает
	tpl.MarketToday = 0
	// Сегодня — на оставшиеся очки, каждое утро — ещё запас дня (ITGAME-127).
	queue, _ := tpl.doomRepair(tpl.doomRepairQueue(), g.ActionPoints)
	dayTicks := g.cfg.DayTicks()
	tplPayroll := tpl.PayrollPerDay()
	payroll := g.PayrollPerDay() // сегодняшний вечер: без нанятых после обеда
	// Доход зачисляется как в офлайн-движке: точная сумма с остатком компании
	// (ITGAME-222); остаток гоняем на своей копии, живой не трогаем.
	carry := g.IncomeCarry
	inc, carry := carryIncome(carry, tpl.exactIncome(g.TickInDay, dayTicks, nil))
	money := g.Money + inc - payroll
	dayExact, stale := 0.0, true
	for d := 1; d <= doomHorizonDays; d++ {
		if g.cfg.WinDayLimit > 0 && g.Day+d-1 > g.cfg.WinDayLimit {
			return 0
		}
		if money >= 0 {
			return 0
		}
		money -= int(math.Ceil(float64(-money) * g.cfg.CreditRate))
		if -money > g.debtLimit(payroll) {
			return d
		}
		// Утро: очки снова полные — чиним следующие пункты; доход дня
		// пересчитываем, только когда шаблон изменился.
		var fixed int
		if queue, fixed = tpl.doomRepair(queue, g.cfg.ActionPointsPerDay); fixed > 0 || stale {
			dayExact, stale = tpl.exactIncome(0, dayTicks, nil), false
		}
		inc, carry = carryIncome(carry, dayExact)
		money += inc - tplPayroll
		payroll = tplPayroll
	}
	return 0
}

// closeDay — конец дня после списания ФОТ: долг (кредит или овердрафт) или
// банкротство, затем дедлайн уровня (время вышло без победы), затем тупик.
// Переводит фазу. payroll — расходы, списанные этим вечером.
func (g *Game) closeDay(payroll int) {
	g.Phase = PhaseDayReport
	if g.settleDebt(payroll) {
		g.Phase = PhaseGameOver
		g.LoseReason = LoseBankrupt
	} else if g.Money < 0 && g.cfg.CreditLimit > 0 {
		g.logEvent(fmt.Sprintf("кредит: долг $%d под %d%%/день", -g.Money, int(g.cfg.CreditRate*100)))
	} else if g.Money < 0 {
		g.logEvent(fmt.Sprintf("овердрафт: долг $%d из $%d (расходы дня), без процентов", -g.Money, payroll))
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

// incomeAtTick — доход компании за конкретный (продуктивный) тик дня для
// превью и прогнозов: точная сумма тика, округлённая до доллара. Остатка
// компании не читает и не пишет — его двигает только зачисление (creditIncome).
func (g *Game) incomeAtTick(tick int) int {
	exact, _, _ := g.incomeAtTickDetail(tick)
	return int(math.Round(exact))
}

// incomeAtTickDetail — точный (дробный) доход тика: личная выработка ×
// эффекты × сетевой множитель из цепочки «роутер → core → сервер» (см.
// Network), сложенные без округления (ITGAME-196); плюс упущенное из-за
// сломанных ПК (сколько заработал бы сотрудник сломанного места без поломки)
// и из-за вируса (−30% заражённых мест с исправным ПК; у сломанного
// заражённого упущенное целиком — в поломке). Упущенное — статистика отчёта,
// а не деньги: оно, как раньше, округляется на место. Чистая — игру не меняет.
func (g *Game) incomeAtTickDetail(tick int) (exact float64, lost, virusLost int) {
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
			// Прибавка уровня и множитель уровня ПК (ITGAME-135) входят в личную
			// выработку до эффектов и сети: тенюра и железо масштабируются
			// инфраструктурой (итерация 15).
			clean := g.baseOutput(o, i) * g.dayEffectMult(o, e, tick)
			x := clean * net.Mults[oi][i]
			v := int(math.Round(x))
			healthy := v
			if e.Infected {
				x = clean * g.cfg.VirusMult * net.Mults[oi][i]
				v = int(math.Round(x))
			}
			if e.PCBroken || o.Workplace(i).Dead { // «требуется замена» (ITGAME-135) — как сломанный
				lost += v
				continue
			}
			virusLost += healthy - v
			exact += x
		}
	}
	// Рынок (Сложность 2.0): качели выработки всего дня, один множитель
	// на компанию — на сумму, а не на каждое место.
	if m := g.marketMult(); m != 1 {
		exact *= m
		lost = int(math.Round(float64(lost) * m))
		virusLost = int(math.Round(float64(virusLost) * m))
	}
	return exact, lost, virusLost
}

// baseOutput — личная выработка места i до эффектов дня и сети: доход и
// прибавка уровня, × накопленное повышение, × уровень ПК (ITGAME-135).
func (g *Game) baseOutput(o *Office, i int) float64 {
	e := &o.Employees[i]
	return float64(e.IncomePerTick+g.levelBonus(e)) * raiseMult(e) * g.pcMult(o, i)
}

// incomeEps — допуск целой части: точная сумма — произведение десятичных
// множителей во float64, и ровный доллар может прийти как 6.999…; без
// допуска он зачислился бы долларом меньше, а остаток — почти единицей.
const incomeEps = 1e-9

// carryIncome — зачисление точного дохода с дробным остатком компании
// (ITGAME-196): в деньги — целые доллары суммы с остатком, дробь — новый
// остаток в [0, 1). Чистая: Tick и офлайн-догон пишут остаток в игру
// (creditIncome), прогноз конца дня гоняет его на своей копии.
func carryIncome(carry, exact float64) (credited int, rest float64) {
	exact += carry
	credited = int(math.Floor(exact + incomeEps))
	return credited, max(exact-float64(credited), 0)
}

// creditIncome — точный доход в целые доллары с остатком компании. Зовут
// только места, где доход становится деньгами: Tick и AdvanceOffline.
func (g *Game) creditIncome(exact float64) int {
	credited, rest := carryIncome(g.IncomeCarry, exact)
	g.IncomeCarry = rest
	return credited
}

// PayrollPerDay — полные дневные расходы: зарплаты сотрудников, боссов и админов
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
				total += g.PersonalSalary(&e)
			}
		}
		if o.Boss != "" && !o.BossUnpaidToday {
			total += g.cfg.BossSalaryPerDay
		}
		if o.Admin != "" && !o.AdminUnpaidToday {
			total += g.cfg.AdminSalaryPerDay
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
// Админы (ITGAME-101) чинят и чистят по очереди на копии мест — место
// считается целым с того тика, к которому до него дойдёт админ; новых
// поломок и волн прогноз не знает. Объявленный штраф аудита вычитается,
// субсидия — нет. Доход тиков зачисляется, как в Tick, — с остатком компании
// (ITGAME-196), но на своей копии остатка: игру прогноз не меняет, а вечер
// без случайностей сходится с ним до доллара.
func (g *Game) ForecastEndOfDay() int {
	total, carry := g.Money, g.IncomeCarry
	sim, admins := g, g.hasAdmins()
	if admins {
		sim = g.seatsCopy()
	}
	for t := g.TickInDay; t < g.cfg.DayTicks(); t++ {
		if admins {
			sim.adminsWork()
		}
		if !g.cfg.isLunchTick(t) {
			exact, _, _ := sim.incomeAtTickDetail(t)
			var inc int
			inc, carry = carryIncome(carry, exact)
			total += inc
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

// DayReport — итоги дня для сообщения протокола. Лежит и в файле сейва (ws.sessionSave.lastReport,
// ключи — имена полей): добавленное, убранное или изменённое поле поднимает SaveFormat, это держит
// TestSessionSaveShape в ws (ITGAME-175).
type DayReport struct {
	Day         int
	Income      int
	Payroll     int // зарплаты людей (сотрудники, боссы и админы)
	GatewayOpex int // операционный расход шлюза
	Antivirus   int // подписка на антивирус за день (ITGAME-137)
	EventMoney  int // деньги исходов событий дня, со знаком (ITGAME-53)
	Profit      int // доход + деньги событий − ФОТ − опекс − подписка
	Balance     int
	Incidents   int // поломок ПК за день
	LostIncome  int // упущено из-за поломок, $
	VirusPCs    int // новых заражений за день (ITGAME-103)
	VirusLost   int // упущено из-за вируса, $
	// Админы (ITGAME-101): сколько ПК починили и мест вычистили за день.
	AdminRepairs int
	AdminCleaned int
	Events       []string // события дня: по строке на итог
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
	// Админы после событий: вспышка этого тика получает первые клики сразу.
	g.adminTick(cleanedByAdmin)
	// Доход тика — точная сумма: в деньги целые доллары, дробь — в остаток
	// компании (ITGAME-196). Пик — темп тика, как в HUD (IncomePerTick), а не
	// зачисленное: оно с остатком гуляет на доллар.
	exact, lost, virusLost := g.incomeAtTickDetail(g.TickInDay)
	income := g.creditIncome(exact)
	if !g.cfg.isLunchTick(g.TickInDay) {
		g.accrueXP()
	}
	g.Money += income
	g.DayIncome += income
	g.Ledger.Income += income
	g.DayLostIncome += lost
	g.DayVirusLost += virusLost
	g.tickEvents(income)
	g.PeakIncomePerTick = max(g.PeakIncomePerTick, int(math.Round(exact)))
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
	g.closeDay(expenses)
	return &DayReport{Day: g.Day, Income: g.DayIncome, Payroll: payroll,
		GatewayOpex: opex, Antivirus: av, EventMoney: g.DayEventMoney,
		Profit: g.DayIncome + g.DayEventMoney - expenses, Balance: g.Money,
		Incidents: g.DayIncidents, LostIncome: g.DayLostIncome,
		VirusPCs: g.DayVirusPCs, VirusLost: g.DayVirusLost,
		AdminRepairs: g.DayAdminRepairs, AdminCleaned: g.DayAdminCleaned, Events: g.EventLog}
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
// Износ (ITGAME-135): поломка — +1 к износу места, как бы её ни починили;
// поломка места с износом PCWearLimit ПК не ломает, а выводит из строя —
// без нового ролла, та же поломка из того же PCG. Мёртвое место в пул не
// входит и «одну поломку на офис» не держит. Бюджет дня выбран (ITGAME-196) —
// роллов до конца дня нет: проверка до ролла, без вызова RNG, поэтому день,
// не дошедший до бюджета, тратит тот же поток роллов, что без бюджета.
func (g *Game) rollBreakdowns() {
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked || len(o.Employees) == 0 {
			continue
		}
		broken := false
		var alive []int // занятые места с живым ПК: «требуется замена» не ломается снова и кап не держит (ITGAME-135)
		for i := range o.Employees {
			if o.Employees[i].PCBroken {
				broken = true
			}
			if !o.Workplace(i).Dead {
				alive = append(alive, i)
			}
		}
		if broken || len(alive) == 0 {
			continue
		}
		if g.randomBudgetLeft() <= 0 {
			return
		}
		if g.rng.IntN(1000) >= g.cfg.BreakdownChancePermille {
			continue
		}
		slot := alive[g.rng.IntN(len(alive))]
		g.DayIncidents++
		if w := o.workplaceRef(slot); g.cfg.PCWearLimit > 0 && w.Wear >= g.cfg.PCWearLimit {
			g.killPC(oi, slot) // без ролла N: та же поломка, тот же PCG
			continue
		}
		o.workplaceRef(slot).Wear++
		o.Employees[slot].PCBroken = true
		o.Employees[slot].RepairClicks = 0
		o.Employees[slot].RepairNeeded = g.rollRepairNeeded()
	}
}
