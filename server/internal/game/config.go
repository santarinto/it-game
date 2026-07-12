package game

// Config — весь баланс игры в одном месте.
// Источник истины для чисел — docs/design/gdd.md, раздел «Экономика».
type Config struct {
	StartMoney        int
	StartPCs          int
	OfficeSlots       int // слоты офиса под рабочие места
	RackSlots         int // слоты серверной под стойки
	PCPrice           int
	HirePrice         int
	ServerPrice       int
	BaseIncomePerTick int     // $ за тик с одного сотрудника без сети
	NetworkBase       float64 // база множителя подключённых; 1.0 — роутер сам дохода не добавляет, только открывает доступ к серверам
	ServerBonus       float64 // прибавка к множителю за каждый сервер
	DayTicks          int     // тиков в одном игровом дне
	SalaryPerDay      int     // зарплата $ с одного сотрудника, списывается в конце дня
	RouterTiers       []RouterTier
}

// RouterTier — тир роутера: покупается последовательно, тир заменяет предыдущий.
type RouterTier struct {
	Price int
	Ports int
}

func DefaultConfig() Config {
	return Config{
		StartMoney:        600,
		StartPCs:          1,
		OfficeSlots:       9,
		RackSlots:         3,
		PCPrice:           500,
		HirePrice:         300,
		ServerPrice:       2000,
		BaseIncomePerTick: 10,
		NetworkBase:       1.0,
		ServerBonus:       0.5,
		DayTicks:          60,
		SalaryPerDay:      250,
		RouterTiers: []RouterTier{
			{Price: 800, Ports: 4},
			{Price: 2500, Ports: 9},
		},
	}
}
