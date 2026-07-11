package game

// Game — состояние одной игры. НЕ потокобезопасен: им владеет
// ровно одна горутина (актор сессии в пакете ws).
type Game struct {
	cfg Config

	Money      int
	PCs        int // ПК в офисе; первые Employees из них заняты сотрудниками
	Employees  int
	RouterTier int // 0 — роутера нет; 1..len(cfg.RouterTiers)
	Servers    int
}

func New(cfg Config) *Game {
	return &Game{cfg: cfg, Money: cfg.StartMoney, PCs: cfg.StartPCs}
}

// Config возвращает баланс, с которым создана игра (для снапшотов протокола).
func (g *Game) Config() Config { return g.cfg }
