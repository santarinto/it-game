package game

// AdminShift — смена админа офиса (ITGAME-144).
// Shift: 1 — день (10:00–19:00), 2 — ночь 1 (19:00–02:30), 3 — ночь 2 (02:30–10:00).
type AdminShift struct {
	Shift       int
	Name        string
	UnpaidToday bool
	HireDay     int
}

// Office — один офис компании: свои рабочие места, роутер и начальник.
// Серверная и шлюз — общие на компанию (в Game).
type Office struct {
	Unlocked        bool
	PCs             int // первые len(Employees) заняты сотрудниками; Workplaces[i] — ПК стола i
	Employees       []Employee
	Workplaces      []Workplace // рабочие места (ITGAME-135): по одному на ПК, len = PCs; сотрудник i сидит за i
	RouterTier      int         // 0 — роутера нет; 1..len(cfg.RouterTiers)
	Servers         []int       // уровни серверов офиса (1..len(cfg.ServerLevels)); порядок = порядок покупки
	Boss            string      // имя начальника; "" — не нанят
	BossUnpaidToday bool        // босс нанят после обеда: сегодня без оплаты
	// Админ (ITGAME-101/144): не сотрудник — места, ПК и сети не занимает.
	// Admin, AdminUnpaidToday, AdminHireDay синхронизированы со Сменой 1 (день) для обратной совместимости.
	Admin            string
	AdminUnpaidToday bool
	AdminHireDay     int
	AdminShifts      []AdminShift
	Cooler           bool
	Fridge           bool
	CoffeeMachine    bool
	CoffeeEventTicks []int // тики кофе-событий текущего дня; роллятся в NextDay
}

// NextAdminShift возвращает номер следующей свободной смены (1..3) или 0, если все 3 заняты.
func (o *Office) NextAdminShift() int {
	for s := 1; s <= 3; s++ {
		if !o.HasAdminShift(s) {
			return s
		}
	}
	return 0
}

// HasAdminShift сообщает, нанят ли админ на смену shift (1..3).
func (o *Office) HasAdminShift(shift int) bool {
	for _, s := range o.AdminShifts {
		if s.Shift == shift {
			return true
		}
	}
	if shift == 1 && o.Admin != "" {
		return true
	}
	return false
}

// syncLegacyAdmin синхронизирует поля Admin, AdminUnpaidToday, AdminHireDay со Сменой 1.
func (o *Office) syncLegacyAdmin() {
	for _, s := range o.AdminShifts {
		if s.Shift == 1 {
			o.Admin = s.Name
			o.AdminUnpaidToday = s.UnpaidToday
			o.AdminHireDay = s.HireDay
			return
		}
	}
	o.Admin = ""
	o.AdminUnpaidToday = false
	o.AdminHireDay = 0
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
