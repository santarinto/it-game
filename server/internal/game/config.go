package game

import "fmt"

// Config — весь баланс игры в одном месте.
// Источник истины для чисел — docs/design/gdd.md, раздел «Экономика».
type Config struct {
	StartMoney   int
	StartPCs     int
	OfficeSlots  int // слоты офиса под рабочие места
	PCPrice      int
	HirePrice    int
	IncomeMin    int // нижняя граница выработки сотрудника, $/тик
	IncomeMax    int // верхняя граница выработки сотрудника, $/тик
	StaffLimit   int // потолок штата и ПК; слоты сверх лимита ждут начальника
	TicksPerHour int // 1 игровой час = столько тиков (секунд)
	WorkdayStart int // час начала рабочего дня
	LunchStart   int // обед: начало (доход за тики обеда = 0)
	LunchEnd     int // обед: конец
	WorkdayEnd   int // час конца дня → зарплаты → отчёт
	SalaryPerDay int // зарплата $ с одного сотрудника, списывается в конце дня
	RouterTiers  []RouterTier

	EmployeesPerServer int           // один сервер обслуживает столько работников офиса
	ServerLevels       []ServerLevel // уровни сервера; покупка = уровень 1
	CoreLevels         []CoreLevel   // уровни core-коммутатора; CoreLevel 0 — не куплен

	BossPrice         int     // найм начальника
	BossSalaryPerDay  int     // зарплата начальника (не производит)
	OfficePrices      []int   // цены офисов 2 и 3 (покупаются последовательно, пустыми)
	GatewayPrice      int     // шлюз в интернет, один на компанию
	GatewayOpexPerDay int     // операционный расход шлюза, $/день
	GatewayBonus      float64 // множитель шлюза подключённым (поверх серверов)

	CoolerPrice        int // кулер: без него жажда −10% с 2 часов работы
	FridgePrice        int // холодильник: без него голод −10% после обеда
	CoffeeMachinePrice int // кофеварка: случайный бафф кофе дважды в день

	ThirstMult       float64    // дебафф жажды (нет кулера)
	HungerMult       float64    // дебафф голода (нет холодильника)
	CoffeeMult       float64    // бафф кофе
	CoffeeTicks      int        // длительность кофе, тиков
	CoffeeChancePct  int        // шанс баффа на сотрудника, %
	ThirstAfterHours int        // жажда после стольких часов работы
	Difficulty       Difficulty // уровень сложности этой игры
	WinTarget        int        // цель победы: достигнутый баланс $

	MotivateMult          float64 // бафф «мотивирован» за клик по сотруднику
	MotivateTicks         int     // длительность мотивации, тиков
	MotivateCooldownTicks int     // персональный кулдаун мотивации, тиков
	BreakdownChancePct    int     // шанс поломки ПК за тик на офис, %
	RepairClicksNeeded    int     // кликов по столу для починки
	MasterCallPrice       int     // «вызвать мастера»: мгновенная починка

	// Unseen Forces (итерация 10): дневные события. Числа — GDD «События».
	EventChancePct  int     // шанс события в дне, %
	EventSecondPct  int     // шанс второго события в дне, %
	EventK          float64 // жёсткость от сложности: динамические штрафы ×K, премии ÷K
	VirusMult       float64 // вирус: множитель дохода офиса
	VirusTicks      int     // вирус: длительность, тиков
	VirusPrice      int     // антивирус (ApplyDifficulty уже умножает на EventK)
	AuditReward     int     // аудит: субсидия за топ-конфиг (÷EventK в ApplyDifficulty)
	AuditPenalty    int     // аудит: штраф без топ-конфига (×EventK в ApplyDifficulty)
	AuditMinCore    int     // аудит: минимальный уровень core для субсидии
	RaiseBoostMult  float64 // согласие на повышение: множитель выработки навсегда
	RaiseOffendMult float64 // отказ в повышении: множитель выработки до конца дня

	PCPriceGrowth float64 // рост цены ПК за каждый следующий в офисе (ит. 14)

	// Сложность 2.0 (итерация 17, ITGAME-9): сложность меняет решения,
	// а не только длину прогона. Числа — GDD «Сложность 2.0».
	CreditLimit        int     // кредит: долг до −X жив (0 — минус = банкротство)
	CreditRate         float64 // кредит: процент на долг за день, 0..1
	WinStaff           int     // комбо-цель: сотрудников в штате (0 — не требуется)
	WinCore            int     // комбо-цель: уровень core (0 — не требуется)
	WinDayLimit        int     // дедлайн цели: конец дня X без победы — финал (0 — нет)
	MarketSwingPct     int     // рынок: амплитуда качелей выработки, % (0 — рынка нет)
	VirusWeightK       float64 // вес «вируса» в пуле событий (хардкор — чаще)
	DeadlineGoalShare  float64 // доля цели дедлайна от ожидаемого дохода окна

	// Сотрудники 2.0 (итерация 15): увольнение, опыт/уровни, звёзды.
	// Числа — GDD «Сотрудники 2.0».
	XPPerTick          int   // XP за продуктивный тик (не обед, ПК цел)
	XPMentorPerTick    int   // XP за тик при начальнике в офисе (менторство ×1.5)
	EmployeeLevelXP    []int // пороги уровней накопленным XP; len = потолок уровня
	EmployeeLevelBonus []int // прибавка к выработке за уровень, $/тик
	StarChancePct      int   // шанс звезды при обычном найме, %
	StarMult           float64 // множитель выработки звезды (на ролл)
	FireCompensation   int   // компенсация увольнения
	FireCompSameDay    int   // компенсация увольнения в день найма («испытательный»)
}

// RouterTier — тир роутера: покупается последовательно, тир заменяет предыдущий.
type RouterTier struct {
	Price int
	Ports int
}

// ServerLevel — уровень офисного сервера: множитель четвёрке работников.
type ServerLevel struct {
	Mult  float64
	Price int
}

// CoreLevel — уровень core: ёмкость подключённых мест по компании.
// Mult > 1.0 только у финального уровня (бонус всем обслуженным серверами).
type CoreLevel struct {
	Capacity int
	Price    int
	Mult     float64
}

func DefaultConfig() Config {
	return Config{
		StartMoney:   600,
		StartPCs:     1,
		OfficeSlots:  12,
		PCPrice:      500,
		HirePrice:    300,
		IncomeMin:    9,
		IncomeMax:    14,
		StaffLimit:   9,
		TicksPerHour: 6,
		WorkdayStart: 10,
		LunchStart:   14,
		LunchEnd:     15,
		WorkdayEnd:   19,
		SalaryPerDay: 250,
		RouterTiers: []RouterTier{
			{Price: 800, Ports: 4},
			{Price: 2500, Ports: 9},
			{Price: 6000, Ports: 12}, // покрывает офис с начальником (слоты 10-12)
		},
		EmployeesPerServer: 4,
		ServerLevels: []ServerLevel{
			{Mult: 1.3, Price: 2000},
			{Mult: 1.6, Price: 4800}, // апгрейды дороже новой стойки (ит. 14)
			{Mult: 2.2, Price: 9600},
		},
		CoreLevels: []CoreLevel{
			{Capacity: 8, Price: 800, Mult: 1.0}, // дешёвый вход в сеть (ит. 14)
			{Capacity: 16, Price: 4000, Mult: 1.0},
			{Capacity: 24, Price: 10000, Mult: 1.0},
			{Capacity: 36, Price: 20000, Mult: 1.0},
			{Capacity: 36, Price: 30000, Mult: 1.15},
		},
		BossPrice:          1000,
		BossSalaryPerDay:   500,
		OfficePrices:       []int{15000, 40000},
		GatewayPrice:       3000,
		GatewayOpexPerDay:  1,
		GatewayBonus:       1.2,
		CoolerPrice:        400,
		FridgePrice:        600,
		CoffeeMachinePrice: 800,

		ThirstMult:       0.9,
		HungerMult:       0.9,
		CoffeeMult:       1.15,
		CoffeeTicks:      6,
		CoffeeChancePct:  40,
		ThirstAfterHours: 2,
		Difficulty:       DiffNormal,
		WinTarget:        250000,

		MotivateMult:          1.25,
		MotivateTicks:         18,
		MotivateCooldownTicks: 36,
		BreakdownChancePct:    2,
		RepairClicksNeeded:    3,
		MasterCallPrice:       150,

		EventChancePct:  75,
		EventSecondPct:  30,
		EventK:          1,
		VirusMult:       0.7,
		VirusTicks:      18,
		VirusPrice:      250,
		AuditReward:     2000,
		AuditPenalty:    1200,
		AuditMinCore:    2,
		RaiseBoostMult:  1.15,
		RaiseOffendMult: 0.85,

		PCPriceGrowth: 1.15,

		VirusWeightK:      1,
		DeadlineGoalShare: 0.7,

		XPPerTick:          2,
		XPMentorPerTick:    3,
		EmployeeLevelXP:    []int{96, 288, 576},
		EmployeeLevelBonus: []int{1, 2, 2},
		StarChancePct:      5,
		StarMult:           1.5,
		FireCompensation:   250,
		FireCompSameDay:    100,
	}
}

// DayTicks — длина дня в тиках; выводится из рабочих часов.
func (c Config) DayTicks() int { return (c.WorkdayEnd - c.WorkdayStart) * c.TicksPerHour }

// ServerSlotsPerOffice — стоек на офис: ровно столько, чтобы серверы
// покрыли все слоты офиса (12/4 = 3; четвёртая стойка обслуживала бы
// работников, которых не бывает).
func (c Config) ServerSlotsPerOffice() int { return c.OfficeSlots / c.EmployeesPerServer }

// isLunchTick — попадает ли тик дня в обеденный час.
func (c Config) isLunchTick(tick int) bool {
	hour := c.WorkdayStart + tick/c.TicksPerHour
	return hour >= c.LunchStart && hour < c.LunchEnd
}

// thirstTick — тик дня, с которого без кулера действует жажда.
func (c Config) thirstTick() int { return c.ThirstAfterHours * c.TicksPerHour }

// lunchEndTick — первый тик после обеда.
func (c Config) lunchEndTick() int { return (c.LunchEnd - c.WorkdayStart) * c.TicksPerHour }

// lunchStartTick — первый тик обеда.
func (c Config) lunchStartTick() int { return (c.LunchStart - c.WorkdayStart) * c.TicksPerHour }

// clockAt — игровое время «HH:MM» произвольного тика дня.
func (c Config) clockAt(tick int) string {
	minutes := tick * 60 / c.TicksPerHour
	return fmt.Sprintf("%02d:%02d", c.WorkdayStart+minutes/60, minutes%60)
}

// deadlineTick — тик дедлайна «заработать к 17:00».
func (c Config) deadlineTick() int { return c.DayTicks() - 2*c.TicksPerHour }

// auditTick — тик проверки аудита «в 18:00».
func (c Config) auditTick() int { return c.DayTicks() - c.TicksPerHour }

// eventWindow — окно активации событий [lo, hi): после обеда, не позже
// чем за 2 часа до конца дня (у дедлайна остаётся время).
func (c Config) eventWindow() (lo, hi int) {
	return 2 * c.TicksPerHour, c.DayTicks() - 2*c.TicksPerHour
}
