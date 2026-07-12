package game

// NetworkState — расчёт сетевой цепочки «роутер офиса → core → сервер офиса».
// Пересчитывается чистой функцией на каждый тик/снапшот/прогноз:
// одно место истины, рассинхрон исключён.
type NetworkState struct {
	Mults      [][]float64 // итоговый сетевой множитель каждого работника
	ServerSlot [][]int     // 1-based номер сервера работника; 0 — без сервера
	CoreLinked [][]bool    // получил ли работник место в ёмкости core
	CoreUsed   int         // занято мест core по компании
}

// Network — кто к чему подключён и с каким множителем.
// Ёмкость core раздаётся «первым N»: офисы по порядку, внутри офиса —
// по порядку найма. Работник без полной цепочки работает на ×1.0;
// шлюз и бонус финального core применяются только обслуженным сервером.
func (g *Game) Network() NetworkState {
	cfg := g.cfg
	n := NetworkState{
		Mults:      make([][]float64, len(g.Offices)),
		ServerSlot: make([][]int, len(g.Offices)),
		CoreLinked: make([][]bool, len(g.Offices)),
	}
	coreLeft, coreMult := 0, 1.0
	if g.CoreLevel > 0 {
		lvl := cfg.CoreLevels[g.CoreLevel-1]
		coreLeft, coreMult = lvl.Capacity, lvl.Mult
	}
	for oi := range g.Offices {
		o := &g.Offices[oi]
		n.Mults[oi] = make([]float64, len(o.Employees))
		n.ServerSlot[oi] = make([]int, len(o.Employees))
		n.CoreLinked[oi] = make([]bool, len(o.Employees))
		for i := range n.Mults[oi] {
			n.Mults[oi][i] = 1.0
		}
		if !o.Unlocked {
			continue
		}
		viaCore := min(o.Connected(cfg), coreLeft)
		coreLeft -= viaCore
		n.CoreUsed += viaCore
		for i := 0; i < viaCore; i++ {
			n.CoreLinked[oi][i] = true
			srv := i / cfg.EmployeesPerServer
			if srv >= len(o.Servers) {
				continue // место в core есть, сервера не хватило — ×1.0
			}
			m := cfg.ServerLevels[o.Servers[srv]-1].Mult * coreMult
			if g.Gateway {
				m *= cfg.GatewayBonus
			}
			n.ServerSlot[oi][i] = srv + 1
			n.Mults[oi][i] = m
		}
	}
	return n
}
