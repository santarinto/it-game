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
)

// BuyPC ставит новый ПК в свободный слот офиса.
func (g *Game) BuyPC() error {
	if g.PCs >= g.cfg.OfficeSlots {
		return ErrNoFreeOfficeSlot
	}
	if g.Money < g.cfg.PCPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.PCPrice
	g.PCs++
	return nil
}

// Hire сажает нового сотрудника за свободный ПК.
func (g *Game) Hire() error {
	if g.Employees >= g.PCs {
		return ErrNoFreePC
	}
	if g.Money < g.cfg.HirePrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.HirePrice
	g.Employees++
	return nil
}

// BuyRouter покупает следующий тир роутера (тир заменяет предыдущий).
// Слот роутера специальный: он один, отдельный от рабочих мест.
func (g *Game) BuyRouter() error {
	if g.RouterTier >= len(g.cfg.RouterTiers) {
		return ErrRouterMaxed
	}
	price := g.cfg.RouterTiers[g.RouterTier].Price
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.Money -= price
	g.RouterTier++
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

// NextRouterPrice — цена следующего тира роутера; 0, если тир максимальный.
func (g *Game) NextRouterPrice() int {
	if g.RouterTier >= len(g.cfg.RouterTiers) {
		return 0
	}
	return g.cfg.RouterTiers[g.RouterTier].Price
}

const ErrUnknownCommand = Err("unknown_command")

// Command — команда игрока. Значение совпадает с полем type
// клиентского сообщения протокола.
type Command string

const (
	CmdBuyPC     = Command("buy_pc")
	CmdHire      = Command("hire")
	CmdBuyRouter = Command("buy_router")
	CmdBuyServer = Command("buy_server")
)

// Apply выполняет команду игрока.
func (g *Game) Apply(cmd Command) error {
	switch cmd {
	case CmdBuyPC:
		return g.BuyPC()
	case CmdHire:
		return g.Hire()
	case CmdBuyRouter:
		return g.BuyRouter()
	case CmdBuyServer:
		return g.BuyServer()
	default:
		return ErrUnknownCommand
	}
}
