package main

import (
	"math"
	"math/rand/v2"

	"itdirector/internal/game"
)

// Политики sim v1 (ITGAME-27, решение владельца — три):
//   • greedy — покупает всё доступное в разумном порядке (экономический
//     потолок сложности);
//   • idle   — ничего не делает: контроль выживаемости (сколько дней
//     живёт партия без решений);
//   • random — случайное доступное действие с шансом: разброс исходов
//     между жадным и пассивным.
//
// Админы (ITGAME-101) — две политики для цены делегирования, в --policy all
// не входят (исходы all сравнимы с прежними байт в байт). Обе кликают ремонт
// и чистку, пока в офисе меньше 4 сотрудников, и перестают, когда он вырос:
// внимание игрока делится на офисы. Совсем без кликов sim не меряет ничего —
// компания с одним ПК ломается в первый день и банкротится на второй.
//   • handsoff — выросший офис никто не чинит и не чистит;
//   • delegate — в выросший офис первым делом нанимается админ.
//
// Политика вызывается раз в игровой час; резерв зарплаты оставляем, чтобы
// политика не убивала партию покупкой в последний час дня.

// affordable — денег хватает с запасом на вечерние зарплаты.
func affordable(g *game.Game, price int) bool {
	return g.Money >= price+g.PayrollPerDay()
}

func buy(g *game.Game, cmd game.Command, office, slot int) bool {
	return g.Apply(cmd, office, slot) == nil
}

// greedyPolicy — приоритет: заполнить места → сеть под штат → быт.
func greedyPolicy(g *game.Game, _ *rand.Rand, _ int) { buildPolicy(g, math.MaxInt) }

// grownOffice — штат, с которого handsoff и delegate перестают кликать в офисе.
const grownOffice = 4

// handsoffPolicy — greedy, который не чинит и не чистит выросшие офисы.
func handsoffPolicy(g *game.Game, _ *rand.Rand, _ int) { buildPolicy(g, grownOffice) }

// delegatePolicy — handsoff, который отдаёт выросшие офисы админам: админ
// нанимается первым делом, как только хватает денег.
func delegatePolicy(g *game.Game, _ *rand.Rand, _ int) {
	cfg := g.Config()
	for i := range g.Offices {
		if o := &g.Offices[i]; o.Unlocked && o.Admin == "" && len(o.Employees) >= grownOffice && affordable(g, cfg.AdminPrice) {
			buy(g, game.CmdHireAdmin, i, 0)
		}
	}
	buildPolicy(g, grownOffice)
}

// buildPolicy — ход greedy; руками чинит и чистит офисы, где сотрудников
// меньше clickBelow.
func buildPolicy(g *game.Game, clickBelow int) {
	cfg := g.Config()
	for i := range g.Offices {
		o := &g.Offices[i]
		if !o.Unlocked {
			continue
		}
		// активный день: чиним сломанные ПК и чистим вирус (клики бесплатны),
		// мотивируем по кулдауну — жадная политика забирает и активный слой тоже
		clicks := len(o.Employees) < clickBelow
		for j := range o.Employees {
			if !clicks {
				_ = g.Apply(game.CmdMotivate, i, j)
				continue
			}
			if o.Employees[j].PCBroken {
				// N кликов роллится при поломке (ITGAME-93): кликаем, пока
				// не починится — клики в sim бесплатны, N на экономику не влияет
				for o.Employees[j].PCBroken {
					if g.Apply(game.CmdRepairClick, i, j) != nil {
						break
					}
				}
			}
			// вирус (ITGAME-103): чистим заражённое место — 3 клика, бесплатно,
			// как ремонт; сломанное заражённое чистится тем же кликом
			for o.Employees[j].Infected {
				if g.Apply(game.CmdVirusClick, i, j) != nil {
					break
				}
			}
			_ = g.Apply(game.CmdMotivate, i, j) // кулдаун → ошибка → мимо
		}
		// места: ПК под найм, найм под ПК
		for len(o.Employees) < o.PCs && affordable(g, cfg.HirePrice) {
			if !buy(g, game.CmdHire, i, 0) {
				break
			}
		}
		if len(o.Employees) == o.PCs && affordable(g, g.NextPCPrice(i)) && o.PCs < o.StaffCap(cfg) {
			buy(g, game.CmdBuyPC, i, 0)
		}
		// роутер: порты кончились при живых сотрудниках
		if o.Ports(cfg) <= len(o.Employees) && affordable(g, g.NextRouterPrice(i)) {
			buy(g, game.CmdBuyRouter, i, 0)
		}
		// сервер: сотрудникам не хватило стойки
		if g.CoreLevel > 0 && len(o.Servers) < cfg.ServerSlotsPerOffice() &&
			affordable(g, cfg.ServerLevels[0].Price) {
			buy(g, game.CmdBuyServer, i, 0)
		}
		// быт: кулер и холодильник снимают дебаффы, кофе — бафф;
		// холодильник и кофеварка — только после кулера (ITGAME-102)
		if !o.Cooler && affordable(g, cfg.CoolerPrice) {
			buy(g, game.CmdBuyCooler, i, 0)
		}
		if o.Cooler && !o.Fridge && affordable(g, cfg.FridgePrice) {
			buy(g, game.CmdBuyFridge, i, 0)
		}
		if o.Cooler && !o.CoffeeMachine && affordable(g, cfg.CoffeeMachinePrice) {
			buy(g, game.CmdBuyCoffee, i, 0)
		}
		// начальник открывает слоты, когда упёрлись в потолок штата
		if o.Boss == "" && o.PCs >= cfg.StaffLimit && affordable(g, cfg.BossPrice) {
			buy(g, game.CmdHireBoss, i, 0)
		}
	}
	// core: первый уровень сразу, дальше — когда ёмкость исчерпана
	// (апгрейд ради апгрейда — не экономика). Один шаг за час.
	if g.CoreLevel < len(g.Config().CoreLevels) && affordable(g, g.Config().CoreLevels[g.CoreLevel].Price) {
		net := g.Network()
		capacity := 0
		if g.CoreLevel > 0 {
			capacity = g.Config().CoreLevels[g.CoreLevel-1].Capacity
		}
		if g.CoreLevel == 0 || net.CoreUsed >= capacity {
			buy(g, game.CmdUpgradeCore, 0, 0)
		}
	}
}

// idlePolicy — контроль выживаемости: никаких действий.
func idlePolicy(g *game.Game, _ *rand.Rand, _ int) {}

// randomPolicy — с шансом 1/3 делает ОДНО случайное доступное действие:
// разброс исходов между жадным и пассивным поведением.
func randomPolicy(g *game.Game, rng *rand.Rand, _ int) {
	if rng.IntN(3) != 0 {
		return
	}
	type action struct {
		cmd    game.Command
		office int
		price  int
	}
	var doable []action
	cfg := g.Config()
	for i := range g.Offices {
		o := &g.Offices[i]
		if !o.Unlocked {
			continue
		}
		if len(o.Employees) < o.PCs {
			doable = append(doable, action{game.CmdHire, i, cfg.HirePrice})
		}
		if o.PCs < o.StaffCap(cfg) && g.NextPCPrice(i) > 0 {
			doable = append(doable, action{game.CmdBuyPC, i, g.NextPCPrice(i)})
		}
		if o.RouterTier < len(cfg.RouterTiers) {
			doable = append(doable, action{game.CmdBuyRouter, i, g.NextRouterPrice(i)})
		}
		if g.CoreLevel > 0 && len(o.Servers) < cfg.ServerSlotsPerOffice() {
			doable = append(doable, action{game.CmdBuyServer, i, cfg.ServerLevels[0].Price})
		}
		if !o.Cooler {
			doable = append(doable, action{game.CmdBuyCooler, i, cfg.CoolerPrice})
		}
		if o.Cooler && !o.Fridge {
			doable = append(doable, action{game.CmdBuyFridge, i, cfg.FridgePrice})
		}
		if o.Cooler && !o.CoffeeMachine {
			doable = append(doable, action{game.CmdBuyCoffee, i, cfg.CoffeeMachinePrice})
		}
	}
	if g.CoreLevel < len(cfg.CoreLevels) {
		doable = append(doable, action{game.CmdUpgradeCore, 0, cfg.CoreLevels[g.CoreLevel].Price})
	}
	affordableActions := doable[:0]
	for _, a := range doable {
		if affordable(g, a.price) {
			affordableActions = append(affordableActions, a)
		}
	}
	if len(affordableActions) == 0 {
		return
	}
	a := affordableActions[rng.IntN(len(affordableActions))]
	_ = g.Apply(a.cmd, a.office, 0)
}
