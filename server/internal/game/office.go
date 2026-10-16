package game

// Office — один офис компании: свои рабочие места, роутер и начальник.
// Серверная и шлюз — общие на компанию (в Game).
type Office struct {
	Unlocked         bool
	PCs              int // первые len(Employees) заняты сотрудниками
	Employees        []Employee
	RouterTier       int    // 0 — роутера нет; 1..len(cfg.RouterTiers)
	Servers          []int  // уровни серверов офиса (1..len(cfg.ServerLevels)); порядок = порядок покупки
	Boss             string // имя начальника; "" — не нанят
	BossUnpaidToday  bool   // босс нанят после обеда: сегодня без оплаты
	Cooler           bool
	Fridge           bool
	CoffeeMachine    bool
	CoffeeEventTicks []int // тики кофе-событий текущего дня; роллятся в NextDay
}

// Ports — сколько рабочих мест офиса роутер подключает к сети.
func (o *Office) Ports(cfg Config) int {
	if o.RouterTier == 0 {
		return 0
	}
	return cfg.RouterTiers[o.RouterTier-1].Ports
}

// Connected — сколько сотрудников офиса в сети: первые N занятых мест.
func (o *Office) Connected(cfg Config) int {
	return min(o.Ports(cfg), len(o.Employees))
}

// StaffCap — потолок штата офиса: 9 мест, начальник открывает все 12.
func (o *Office) StaffCap(cfg Config) int {
	if o.Boss != "" {
		return cfg.OfficeSlots
	}
	return cfg.StaffLimit
}
