package game

import "math"

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

// Ports — сколько рабочих мест роутер может подключить к сети.
func (g *Game) Ports() int {
	if g.RouterTier == 0 {
		return 0
	}
	return g.cfg.RouterTiers[g.RouterTier-1].Ports
}

// Connected — сколько сотрудников сейчас в сети:
// подключаются автоматически первые N занятых мест, N = порты роутера.
func (g *Game) Connected() int {
	return min(g.Ports(), g.Employees)
}

// Multiplier — сетевой множитель выработки подключённых рабочих мест.
// Без роутера сеть не существует, и серверы не дают ничего.
func (g *Game) Multiplier() float64 {
	if g.RouterTier == 0 {
		return 1.0
	}
	return g.cfg.NetworkBase + g.cfg.ServerBonus*float64(g.Servers)
}

// IncomePerTick — доход за один тик при текущем состоянии.
func (g *Game) IncomePerTick() int {
	base := g.cfg.BaseIncomePerTick
	connected := g.Connected()
	perConnected := int(math.Round(float64(base) * g.Multiplier()))
	return connected*perConnected + (g.Employees-connected)*base
}

// Tick — один шаг симуляции (1 секунда игрового времени).
func (g *Game) Tick() {
	g.Money += g.IncomePerTick()
}
