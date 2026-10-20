package game

import "math"

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
	ErrEquipmentAlready = Err("equipment_already")
	ErrBadSlot          = Err("bad_slot")
	ErrServerMaxed      = Err("server_maxed")
	ErrCoreMaxed        = Err("core_maxed")
	ErrMotivateCooldown = Err("motivate_cooldown")
	ErrNotBroken        = Err("not_broken")
	ErrNotInfected      = Err("not_infected") // virus_click по здоровому месту (ITGAME-103)
	ErrNoEvent          = Err("no_event")
	ErrBadOption        = Err("bad_option")
	ErrNeedCooler       = Err("need_cooler")
	ErrBadTier          = Err("bad_tier")           // set_antivirus: нет такого тарифа (ITGAME-137)
	ErrAntivirusAlready = Err("antivirus_already")  // set_antivirus: этот тариф уже включён
	ErrAdminAlready     = Err("admin_already")      // hire_admin: в офисе уже есть админ (ITGAME-101)
	ErrNoAdmin          = Err("no_admin")           // fire_admin: админа в офисе нет
	ErrAdminDeptAlready = Err("admin_dept_already") // buy_admin_dept: отдел уже куплен
	ErrAdminDeptLocked  = Err("admin_dept_locked")  // hire_admin: отдел админов не куплен
	ErrPCDead           = Err("pc_dead")            // ПК места «требуется замена»: клики, мастер и апгрейд — нет (ITGAME-135)
	ErrPCFresh          = Err("pc_fresh")           // replace_pc по новому ПК
	ErrPCMaxLevel       = Err("pc_max_level")       // upgrade_pc на максимальном уровне
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
// штата открывает начальник офиса. Цена растёт с каждым купленным
// ПК офиса (итерация 14) — развилка «нанять vs сеть».
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
	price := g.NextPCPrice(office)
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.spend(CmdBuyPC, price)
	o.PCs++
	o.syncWorkplaces()
	return nil
}

// NextPCPrice — цена следующего ПК офиса: базовая × рост за каждый
// купленный, округление вверх до $5. 0 на физических местах не осталось.
func (g *Game) NextPCPrice(office int) int {
	o := &g.Offices[office]
	if o.PCs >= g.cfg.OfficeSlots {
		return 0
	}
	v := float64(g.cfg.PCPrice) * math.Pow(g.cfg.PCPriceGrowth, float64(o.PCs))
	return int(math.Ceil(v/5) * 5)
}

// Hire сажает нового сотрудника за свободный ПК офиса: имя и выработка
// роллятся при найме и не меняются. Шанс StarChancePct — «звезда»:
// ролл выработки ×StarMult, суффикс « ★», золотой бейдж (итерация 15).
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
	g.spend(CmdHire, g.cfg.HirePrice)
	name := rollName(g.rng)
	income := g.cfg.IncomeMin + g.rng.IntN(g.cfg.IncomeMax-g.cfg.IncomeMin+1)
	star := g.rng.IntN(100) < g.cfg.StarChancePct
	if star {
		name += " ★"
		income = int(math.Round(float64(income) * g.cfg.StarMult))
	}
	o.Employees = append(o.Employees, Employee{
		Name:          name,
		IncomePerTick: income,
		UnpaidToday:   g.hiredAfterLunch(),
		Star:          star,
		HireDay:       g.Day,
	})
	return nil
}

// FireCompensation — компенсация увольнения этого сотрудника: в день
// найма дешевле («испытательный срок»).
func (g *Game) FireCompensation(e *Employee) int {
	if e.HireDay == g.Day {
		return g.cfg.FireCompSameDay
	}
	return g.cfg.FireCompensation
}

// Fire увольняет сотрудника: ПК остаётся в офисе (свободен для найма) со своим
// уровнем и износом (ITGAME-135): стол уволенного становится первым свободным,
// остальные сотрудники остаются за своими ПК. Сотрудник уходит с опытом и уровнем. События «повышение», адресованные
// этому офису, ретаргетятся: адресат уволен — резолв, следующий сдвигается.
func (g *Game) Fire(office, slot int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if slot < 0 || slot >= len(o.Employees) {
		return ErrBadSlot
	}
	comp := g.FireCompensation(&o.Employees[slot])
	if g.Money < comp {
		return ErrNotEnoughMoney
	}
	g.spend(CmdFire, comp)
	g.retargetRaiseEvents(office, slot)
	infected := o.Employees[slot].Infected
	o.syncWorkplaces()
	n := len(o.Employees)
	w := o.Workplaces[slot]
	copy(o.Workplaces[slot:n-1], o.Workplaces[slot+1:n])
	o.Workplaces[n-1] = w
	o.Employees = append(o.Employees[:slot], o.Employees[slot+1:]...)
	if infected { // уволенный уходит вместе с заражением (ITGAME-103)
		g.virusSettled(office, cleanedSilent)
	}
	return nil
}

// retargetRaiseEvents — события «просит повышения» хранят индекс
// сотрудника; увольнение сдвигает индексы. Адресат уволен — событие
// закрывается (активное — с логом, ожидающее — молча). Активное — элемент
// DayEvents (ITGAME-52), поэтому один проход сдвигает его ровно один раз.
func (g *Game) retargetRaiseEvents(office, firedSlot int) {
	for i := range g.DayEvents {
		ev := &g.DayEvents[i]
		if ev.ID != EventRaise || ev.Office != office || ev.Resolved {
			continue
		}
		if ev.Slot > firedSlot {
			ev.Slot--
			continue
		}
		if ev.Slot != firedSlot {
			continue
		}
		ev.Resolved = true
		if g.ActiveEvent == ev {
			g.logEvent("повышение: сотрудник уволен до ответа")
			g.ActiveEvent = nil
		}
	}
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
	g.spend(CmdBuyRouter, price)
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
	g.spend(CmdHireBoss, g.cfg.BossPrice)
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
	g.spend(CmdBuyOffice, price)
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
	g.spend(CmdBuyGateway, g.cfg.GatewayPrice)
	g.Gateway = true
	return nil
}

// BuyServer ставит сервер ур.1 в первую пустую стойку офиса.
func (g *Game) BuyServer(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if len(o.Servers) >= g.cfg.ServerSlotsPerOffice() {
		return ErrNoFreeRackSlot
	}
	price := g.cfg.ServerLevels[0].Price
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.spend(CmdBuyServer, price)
	o.Servers = append(o.Servers, 1)
	return nil
}

// UpgradeServer поднимает уровень сервера в стойке slot офиса.
func (g *Game) UpgradeServer(office, slot int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if slot < 0 || slot >= len(o.Servers) {
		return ErrBadSlot
	}
	if o.Servers[slot] >= len(g.cfg.ServerLevels) {
		return ErrServerMaxed
	}
	price := g.cfg.ServerLevels[o.Servers[slot]].Price
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.spend(CmdUpgradeServer, price)
	o.Servers[slot]++
	return nil
}

// UpgradeCore поднимает уровень core-коммутатора; покупка = уровень 1.
func (g *Game) UpgradeCore() error {
	if g.CoreLevel >= len(g.cfg.CoreLevels) {
		return ErrCoreMaxed
	}
	price := g.cfg.CoreLevels[g.CoreLevel].Price
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.spend(CmdUpgradeCore, price)
	g.CoreLevel++
	return nil
}

// buyAmenity — общая покупка быт-устройства офиса. needCooler — устройство
// продаётся только после кулера этого офиса (холодильник и кофеварка, ITGAME-102).
func (g *Game) buyAmenity(kind Command, office, price int, needCooler bool, flag func(*Office) *bool) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	f := flag(o)
	if *f {
		return ErrEquipmentAlready
	}
	if needCooler && !o.Cooler {
		return ErrNeedCooler
	}
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.spend(kind, price)
	*f = true
	return nil
}

// BuyCooler ставит кулер с водой (снимает дебафф жажды).
func (g *Game) BuyCooler(office int) error {
	return g.buyAmenity(CmdBuyCooler, office, g.cfg.CoolerPrice, false, func(o *Office) *bool { return &o.Cooler })
}

// BuyFridge ставит холодильник (снимает дебафф голода); только после кулера.
func (g *Game) BuyFridge(office int) error {
	return g.buyAmenity(CmdBuyFridge, office, g.cfg.FridgePrice, true, func(o *Office) *bool { return &o.Fridge })
}

// BuyCoffeeMachine ставит кофеварку (случайный бафф кофе); только после кулера.
func (g *Game) BuyCoffeeMachine(office int) error {
	return g.buyAmenity(CmdBuyCoffee, office, g.cfg.CoffeeMachinePrice, true, func(o *Office) *bool { return &o.CoffeeMachine })
}

// Motivate — активный день: клик по сотруднику даёт бафф «мотивирован»
// с персональным кулдауном. slot — индекс сотрудника в офисе.
func (g *Game) Motivate(office, slot int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if slot < 0 || slot >= len(o.Employees) {
		return ErrBadSlot
	}
	e := &o.Employees[slot]
	if g.TickInDay < e.MotivateCooldownUntil {
		return ErrMotivateCooldown
	}
	e.MotivatedUntil = g.TickInDay + g.cfg.MotivateTicks
	e.MotivateCooldownUntil = g.TickInDay + g.cfg.MotivateCooldownTicks
	return nil
}

// RepairClick — один клик починки сломанного ПК: чинит на N-й клик
// (N — RepairTarget(), роллится при поломке, ITGAME-93).
func (g *Game) RepairClick(office, slot int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if slot < 0 || slot >= len(o.Employees) {
		return ErrBadSlot
	}
	if o.Workplace(slot).Dead {
		return ErrPCDead
	}
	e := &o.Employees[slot]
	if !e.PCBroken {
		return ErrNotBroken
	}
	e.repairClick()
	return nil
}

// repairClick — один клик починки по месту: на RepairTarget()-й ПК цел
// (true). Один клик на всех, кто чинит: игрок и админ (ITGAME-101).
func (e *Employee) repairClick() bool {
	e.RepairClicks++
	if e.RepairClicks < e.RepairTarget() {
		return false
	}
	e.PCBroken = false
	e.RepairClicks = 0
	e.RepairNeeded = 0
	return true
}

// CallMaster — «вызвать мастера»: мгновенная починка за деньги.
func (g *Game) CallMaster(office, slot int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if slot < 0 || slot >= len(o.Employees) {
		return ErrBadSlot
	}
	if o.Workplace(slot).Dead {
		return ErrPCDead
	}
	e := &o.Employees[slot]
	if !e.PCBroken {
		return ErrNotBroken
	}
	if g.Money < g.cfg.MasterCallPrice {
		return ErrNotEnoughMoney
	}
	g.spend(CmdCallMaster, g.cfg.MasterCallPrice)
	e.PCBroken = false
	e.RepairClicks = 0
	e.RepairNeeded = 0
	return nil
}

// NextDay начинает следующий день. Работает только из фазы отчёта.
func (g *Game) NextDay() error {
	if g.Phase != PhaseDayReport {
		return ErrWrongPhase
	}
	// Сбрасываем флаги неполного дня для нанятых после обеда и баффы дня.
	// Поломка ночь переживает (ITGAME-136): ПК ждёт кликов или мастера.
	// Вирус и таймер его волны — тоже (ITGAME-103): само не проходит.
	// Подписка новый день начинает со своего тарифа (ITGAME-137).
	for i := range g.Offices {
		o := &g.Offices[i]
		for j := range o.Employees {
			o.Employees[j].UnpaidToday = false
			o.Employees[j].CoffeeUntil = 0
			o.Employees[j].MotivatedUntil = 0
			o.Employees[j].MotivateCooldownUntil = 0
			o.Employees[j].OffendedUntil = 0
		}
		o.BossUnpaidToday = false
		o.AdminUnpaidToday = false
		// Роллим кофе-события следующего дня: одно до обеда, одно после.
		if o.CoffeeMachine {
			o.CoffeeEventTicks = []int{
				g.rng.IntN(24),
				g.cfg.lunchEndTick() + g.rng.IntN(g.cfg.DayTicks()-g.cfg.lunchEndTick()),
			}
		} else {
			o.CoffeeEventTicks = nil
		}
	}
	g.archiveLedger()
	g.Day++
	g.TickInDay = 0
	g.DayIncome = 0
	g.DayEventMoney = 0
	g.DayIncidents = 0
	g.DayLostIncome = 0
	g.DayVirusPCs = 0
	g.DayVirusLost = 0
	g.DayAdminRepairs = 0
	g.DayAdminCleaned = 0
	g.AVTierBilled = g.AVTier
	// Рынок: вчерашний «завтра» становится сегодня, роллится новый завтра —
	// тренд всегда виден на день вперёд (Сложность 2.0).
	g.MarketToday, g.MarketTomorrow = g.MarketTomorrow, g.rollMarket()
	g.rollDayEvents()
	g.Phase = PhaseRunning
	g.beginLedger()
	return nil
}

// Restart начинает новую игру с нуля. Работает только после банкротства.
// Сид сохраняется: рестарт воспроизводим для отладки (?seed= даёт те же роллы).
func (g *Game) Restart() error {
	if g.Phase != PhaseGameOver {
		return ErrWrongPhase
	}
	*g = *NewSeeded(g.cfg, g.Seed)
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

// NextRouterPorts — порты следующего тира роутера офиса; 0 на максимуме.
// Для превью «+N в сеть» перед покупкой (итерация 11).
func (g *Game) NextRouterPorts(office int) int {
	tier := g.Offices[office].RouterTier
	if tier >= len(g.cfg.RouterTiers) {
		return 0
	}
	return g.cfg.RouterTiers[tier].Ports
}

// hiredAfterLunch — найм после обеда: без зарплаты в день найма (Task 3).
func (g *Game) hiredAfterLunch() bool {
	return g.TickInDay >= g.cfg.lunchEndTick()
}

const ErrUnknownCommand = Err("unknown_command")

// Command — команда игрока. Значение совпадает с полем type
// клиентского сообщения протокола.
type Command string

const (
	CmdBuyPC         = Command("buy_pc")
	CmdHire          = Command("hire")
	CmdBuyRouter     = Command("buy_router")
	CmdBuyServer     = Command("buy_server")
	CmdUpgradeServer = Command("upgrade_server")
	CmdUpgradeCore   = Command("upgrade_core")
	CmdHireBoss      = Command("hire_boss")
	CmdBuyOffice     = Command("buy_office")
	CmdBuyGateway    = Command("buy_gateway")
	CmdNextDay       = Command("next_day")
	CmdRestart       = Command("restart")
	CmdBuyCooler     = Command("buy_cooler")
	CmdBuyFridge     = Command("buy_fridge")
	CmdBuyCoffee     = Command("buy_coffee")
	CmdMotivate      = Command("motivate")
	CmdRepairClick   = Command("repair_click")
	CmdCallMaster    = Command("call_master")
	CmdEventChoice   = Command("event_choice")
	CmdFire          = Command("fire")
	CmdVirusClick    = Command("virus_click")    // клик чистки заражённого места (ITGAME-103)
	CmdSetAntivirus  = Command("set_antivirus")  // подписка на антивирус: тариф в slot, 0 — отключить (ITGAME-137)
	CmdHireAdmin     = Command("hire_admin")     // найм админа офиса (ITGAME-101)
	CmdFireAdmin     = Command("fire_admin")     // увольнение админа офиса
	CmdBuyAdminDept  = Command("buy_admin_dept") // покупка отдела админов — комнаты, где они сидят
	CmdUpgradePC     = Command("upgrade_pc")     // апгрейд ПК стола slot (ITGAME-135)
	CmdReplacePC     = Command("replace_pc")     // замена ПК стола slot: мёртвого или изношенного
)

// Apply выполняет команду игрока; офисные команды адресуются индексом office,
// slot дополнительно адресует стойку сервера (upgrade_server) или стол (upgrade_pc, replace_pc).
func (g *Game) Apply(cmd Command, office, slot int) error {
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
	case CmdBuyAdminDept:
		return g.BuyAdminDept()
	case CmdHireAdmin:
		return g.HireAdmin(office)
	case CmdFireAdmin:
		return g.FireAdmin(office)
	case CmdBuyOffice:
		return g.BuyOffice(office)
	case CmdBuyServer:
		return g.BuyServer(office)
	case CmdUpgradeServer:
		return g.UpgradeServer(office, slot)
	case CmdUpgradeCore:
		return g.UpgradeCore()
	case CmdBuyGateway:
		return g.BuyGateway()
	case CmdBuyCooler:
		return g.BuyCooler(office)
	case CmdBuyFridge:
		return g.BuyFridge(office)
	case CmdBuyCoffee:
		return g.BuyCoffeeMachine(office)
	case CmdMotivate:
		return g.Motivate(office, slot)
	case CmdRepairClick:
		return g.RepairClick(office, slot)
	case CmdCallMaster:
		return g.CallMaster(office, slot)
	case CmdVirusClick:
		return g.VirusClick(office, slot)
	case CmdSetAntivirus:
		return g.SetAntivirus(slot)
	case CmdFire:
		return g.Fire(office, slot)
	case CmdUpgradePC:
		return g.UpgradePC(office, slot)
	case CmdReplacePC:
		return g.ReplacePC(office, slot)
	case CmdEventChoice:
		// slot — индекс опции активного события (см. спеку итерации 10).
		return g.ChooseEvent(slot)
	default:
		return ErrUnknownCommand
	}
}
