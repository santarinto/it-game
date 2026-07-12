package game

// Config — весь баланс игры в одном месте.
// Источник истины для чисел — docs/design/gdd.md, раздел «Экономика».
type Config struct {
	StartMoney   int
	StartPCs     int
	OfficeSlots  int // слоты офиса под рабочие места
	RackSlots    int // слоты серверной под стойки
	PCPrice      int
	HirePrice    int
	ServerPrice  int
	IncomeMin    int     // нижняя граница выработки сотрудника, $/тик
	IncomeMax    int     // верхняя граница выработки сотрудника, $/тик
	StaffLimit   int     // потолок штата и ПК; слоты сверх лимита ждут начальника
	NetworkBase  float64 // база множителя подключённых; 1.0 — роутер сам дохода не добавляет, только открывает доступ к серверам
	ServerBonus  float64 // прибавка к множителю за каждый сервер
	TicksPerHour int     // 1 игровой час = столько тиков (секунд)
	WorkdayStart int     // час начала рабочего дня
	LunchStart   int     // обед: начало (доход за тики обеда = 0)
	LunchEnd     int     // обед: конец
	WorkdayEnd   int     // час конца дня → зарплаты → отчёт
	SalaryPerDay int     // зарплата $ с одного сотрудника, списывается в конце дня
	RouterTiers  []RouterTier
}

// RouterTier — тир роутера: покупается последовательно, тир заменяет предыдущий.
type RouterTier struct {
	Price int
	Ports int
}

func DefaultConfig() Config {
	return Config{
		StartMoney:   600,
		StartPCs:     1,
		OfficeSlots:  12,
		RackSlots:    3,
		PCPrice:      500,
		HirePrice:    300,
		ServerPrice:  2000,
		IncomeMin:    9,
		IncomeMax:    14,
		StaffLimit:   9,
		NetworkBase:  1.0,
		ServerBonus:  0.5,
		TicksPerHour: 6,
		WorkdayStart: 10,
		LunchStart:   14,
		LunchEnd:     15,
		WorkdayEnd:   19,
		SalaryPerDay: 250,
		RouterTiers: []RouterTier{
			{Price: 800, Ports: 4},
			{Price: 2500, Ports: 9},
		},
	}
}

// DayTicks — длина дня в тиках; выводится из рабочих часов.
func (c Config) DayTicks() int { return (c.WorkdayEnd - c.WorkdayStart) * c.TicksPerHour }

// isLunchTick — попадает ли тик дня в обеденный час.
func (c Config) isLunchTick(tick int) bool {
	hour := c.WorkdayStart + tick/c.TicksPerHour
	return hour >= c.LunchStart && hour < c.LunchEnd
}
