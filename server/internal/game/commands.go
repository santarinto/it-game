package game

// Err — доменная ошибка. Значение строки — это код ошибки протокола,
// поэтому новые ошибки должны совпадать с кодами в спеке.
type Err string

func (e Err) Error() string { return string(e) }

const (
	ErrNotEnoughMoney   = Err("not_enough_money")
	ErrNoFreeOfficeSlot = Err("no_free_office_slot")
	ErrNoFreePC         = Err("no_free_pc")
	ErrNoFreeRackSlot   = Err("no_free_rack_slot")
	ErrRouterMaxed      = Err("router_maxed")
	ErrWrongPhase       = Err("wrong_phase")
	ErrStaffLimit       = Err("staff_limit")
	ErrOfficeLocked     = Err("office_locked")
	ErrBossAlready      = Err("boss_already")
	ErrOfficesMaxed     = Err("offices_maxed")
	ErrGatewayAlready   = Err("gateway_already")
	ErrBadOffice        = Err("bad_office")
)

// office проверяет адресата офисной команды: индекс и открытость.
func (g *Game) office(idx int) (*Office, error) {
	if idx < 0 || idx >= len(g.Offices) {
		return nil, ErrBadOffice
	}
	o := &g.Offices[idx]
	if !o.Unlocked {
		return nil, ErrOfficeLocked
	}
	return o, nil
}

// BuyPC ставит новый ПК в свободный слот офиса. Слоты сверх потолка
// штата открывает начальник офиса.
func (g *Game) BuyPC(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	// Сначала жёсткий физический потолок офиса (12 слотов), затем потолок
	// штата: у босса они совпадают, и полный офис должен выдать
	// no_free_office_slot, а не staff_limit.
	if o.PCs >= g.cfg.OfficeSlots {
		return ErrNoFreeOfficeSlot
	}
	if o.PCs >= o.StaffCap(g.cfg) {
		return ErrStaffLimit
	}
	if g.Money < g.cfg.PCPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.PCPrice
	o.PCs++
	return nil
}

// Hire сажает нового сотрудника за свободный ПК офиса: имя и выработка
// роллятся при найме и не меняются.
func (g *Game) Hire(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if len(o.Employees) >= o.StaffCap(g.cfg) {
		return ErrStaffLimit
	}
	if len(o.Employees) >= o.PCs {
		return ErrNoFreePC
	}
	if g.Money < g.cfg.HirePrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.HirePrice
	o.Employees = append(o.Employees, Employee{
		Name:          rollName(g.rng),
		IncomePerTick: g.cfg.IncomeMin + g.rng.IntN(g.cfg.IncomeMax-g.cfg.IncomeMin+1),
		UnpaidToday:   g.hiredAfterLunch(),
	})
	return nil
}

// BuyRouter покупает следующий тир роутера офиса (тир заменяет предыдущий).
func (g *Game) BuyRouter(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if o.RouterTier >= len(g.cfg.RouterTiers) {
		return ErrRouterMaxed
	}
	price := g.cfg.RouterTiers[o.RouterTier].Price
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.Money -= price
	o.RouterTier++
	return nil
}

// HireBoss нанимает начальника офиса: не производит, открывает слоты 10-12.
func (g *Game) HireBoss(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if o.Boss != "" {
		return ErrBossAlready
	}
	if g.Money < g.cfg.BossPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.BossPrice
	o.Boss = rollName(g.rng)
	o.BossUnpaidToday = g.hiredAfterLunch()
	return nil
}

// BuyOffice открывает следующий закрытый офис (строго последовательно, пустым).
func (g *Game) BuyOffice(office int) error {
	next := -1
	for i := range g.Offices {
		if !g.Offices[i].Unlocked {
			next = i
			break
		}
	}
	if next == -1 {
		return ErrOfficesMaxed
	}
	if office != next {
		return ErrBadOffice
	}
	price := g.cfg.OfficePrices[next-1]
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.Money -= price
	g.Offices[next].Unlocked = true
	return nil
}

// BuyGateway ставит шлюз в интернет (один на компанию).
func (g *Game) BuyGateway() error {
	if g.Gateway {
		return ErrGatewayAlready
	}
	if g.Money < g.cfg.GatewayPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.GatewayPrice
	g.Gateway = true
	return nil
}

// BuyServer ставит сервер в свободную стойку серверной.
func (g *Game) BuyServer() error {
	if g.Servers >= g.cfg.RackSlots {
		return ErrNoFreeRackSlot
	}
	if g.Money < g.cfg.ServerPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.ServerPrice
	g.Servers++
	return nil
}

// NextDay начинает следующий день. Работает только из фазы отчёта.
func (g *Game) NextDay() error {
	if g.Phase != PhaseDayReport {
		return ErrWrongPhase
	}
	// Сбрасываем флаги неполного дня для нанятых после обеда
	for i := range g.Offices {
		o := &g.Offices[i]
		for j := range o.Employees {
			o.Employees[j].UnpaidToday = false
		}
		o.BossUnpaidToday = false
	}
	g.Day++
	g.TickInDay = 0
	g.DayIncome = 0
	g.Phase = PhaseRunning
	return nil
}

// Restart начинает новую игру с нуля. Работает только после банкротства.
func (g *Game) Restart() error {
	if g.Phase != PhaseGameOver {
		return ErrWrongPhase
	}
	*g = *New(g.cfg)
	return nil
}

// NextRouterPrice — цена следующего тира роутера офиса; 0 на максимуме.
func (g *Game) NextRouterPrice(office int) int {
	tier := g.Offices[office].RouterTier
	if tier >= len(g.cfg.RouterTiers) {
		return 0
	}
	return g.cfg.RouterTiers[tier].Price
}

// hiredAfterLunch — найм после обеда: без зарплаты в день найма (Task 3).
func (g *Game) hiredAfterLunch() bool {
	return g.TickInDay >= (g.cfg.LunchEnd-g.cfg.WorkdayStart)*g.cfg.TicksPerHour
}

const ErrUnknownCommand = Err("unknown_command")

// Command — команда игрока. Значение совпадает с полем type
// клиентского сообщения протокола.
type Command string

const (
	CmdBuyPC      = Command("buy_pc")
	CmdHire       = Command("hire")
	CmdBuyRouter  = Command("buy_router")
	CmdBuyServer  = Command("buy_server")
	CmdHireBoss   = Command("hire_boss")
	CmdBuyOffice  = Command("buy_office")
	CmdBuyGateway = Command("buy_gateway")
	CmdNextDay    = Command("next_day")
	CmdRestart    = Command("restart")
)

// Apply выполняет команду игрока; офисные команды адресуются индексом office.
func (g *Game) Apply(cmd Command, office int) error {
	switch cmd {
	case CmdNextDay:
		return g.NextDay()
	case CmdRestart:
		return g.Restart()
	}
	if g.Phase != PhaseRunning {
		return ErrWrongPhase
	}
	switch cmd {
	case CmdBuyPC:
		return g.BuyPC(office)
	case CmdHire:
		return g.Hire(office)
	case CmdBuyRouter:
		return g.BuyRouter(office)
	case CmdHireBoss:
		return g.HireBoss(office)
	case CmdBuyOffice:
		return g.BuyOffice(office)
	case CmdBuyServer:
		return g.BuyServer()
	case CmdBuyGateway:
		return g.BuyGateway()
	default:
		return ErrUnknownCommand
	}
}
