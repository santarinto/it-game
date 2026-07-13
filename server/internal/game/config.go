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

	ThirstMult       float64 // дебафф жажды (нет кулера)
	HungerMult       float64 // дебафф голода (нет холодильника)
	CoffeeMult       float64 // бафф кофе
	CoffeeTicks      int     // длительность кофе, тиков
	CoffeeChancePct  int     // шанс баффа на сотрудника, %
	ThirstAfterHours int     // жажда после стольких часов работы
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
			{Mult: 1.2, Price: 2000},
			{Mult: 1.5, Price: 4000},
			{Mult: 2.0, Price: 8000},
		},
		CoreLevels: []CoreLevel{
			{Capacity: 8, Price: 1500, Mult: 1.0},
			{Capacity: 16, Price: 4000, Mult: 1.0},
			{Capacity: 24, Price: 10000, Mult: 1.0},
			{Capacity: 36, Price: 20000, Mult: 1.0},
			{Capacity: 36, Price: 40000, Mult: 1.1},
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

// clockAt — игровое время «HH:MM» произвольного тика дня.
func (c Config) clockAt(tick int) string {
	minutes := tick * 60 / c.TicksPerHour
	return fmt.Sprintf("%02d:%02d", c.WorkdayStart+minutes/60, minutes%60)
}
