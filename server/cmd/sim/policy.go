package main

import (
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
// не входят (исходы all сравнимы с прежними байт в байт). Совсем без кликов
// sim не меряет ничего — на Норме компания с одним ПК ломается в первый день
// и дальше живёт без дохода: вечер в овердрафте, на следующий долг глубже
// расходов дня — банкротство, чаще всего на 3-й день (ITGAME-156; без
// овердрафта было на 2-й). На Лёгком реже — 88 партий из 300, на 3–4-й день:
// стартовых денег хватает на второго сотрудника. На Сложном и Кошмаре кредит
// под проценты тянет до банкротства на 10–16-й день.
//   • handsoff — кликает ремонт и чистку, пока в офисе меньше 4 сотрудников,
//     выросший офис никто не чинит и не чистит: цена отсутствия игрока;
//   • delegate — кликает, пока у офиса нет админа; в выросший офис нанимает
//     его, как только хватает денег (перед первым — отдел админов), и больше
//     там не кликает: цена делегирования.
//
// Рабочие места (ITGAME-135): жадные политики заменяют ПК «требуется замена»
// до найма и раз в час апгрейдят одно место, random знает обе команды.
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
func greedyPolicy(g *game.Game, _ *rand.Rand, _ int) {
	buildPolicy(g, func(*game.Office) bool { return true })
}

// grownOffice — штат, с которого handsoff бросает офис, а delegate нанимает админа.
const grownOffice = 4

// handsoffPolicy — greedy, который не чинит и не чистит выросшие офисы.
func handsoffPolicy(g *game.Game, _ *rand.Rand, _ int) {
	buildPolicy(g, func(o *game.Office) bool { return len(o.Employees) < grownOffice })
}

// delegatePolicy — greedy, который отдаёт выросшие офисы админам: админ
// нанимается первым делом, как только хватает денег; до него игрок кликает сам.
func delegatePolicy(g *game.Game, _ *rand.Rand, _ int) {
	cfg := g.Config()
	for i := range g.Offices {
		o := &g.Offices[i]
		if !o.Unlocked || o.Admin != "" || len(o.Employees) < grownOffice {
			continue
		}
		// Админы сидят в своём отделе: комната покупается раз, перед первым.
		if !g.AdminDept && affordable(g, cfg.AdminDeptPrice) {
			buy(g, game.CmdBuyAdminDept, 0, 0)
		}
		if g.AdminDept && affordable(g, cfg.AdminPrice) {
			buy(g, game.CmdHireAdmin, i, 0)
		}
	}
	buildPolicy(g, func(o *game.Office) bool { return o.Admin == "" })
}

// buildPolicy — ход greedy; руками чинит и чистит офисы, где clicks(o).
func buildPolicy(g *game.Game, clicks func(o *game.Office) bool) {
	cfg := g.Config()
	// рабочие места (ITGAME-135): ПК «требуется замена» — заменить до всего остального, на любые
	// деньги, что хватает на цену: мёртвое место платит зарплату впустую, а замена окупается за
	// день-два (резерв зарплаты тут не нужен — это не расширение, а возврат дохода).
	for i := range g.Offices {
		o := &g.Offices[i]
		for j := range o.Employees {
			if o.Unlocked && o.Workplace(j).Dead && g.Money >= g.PCReplacePrice() {
				buy(g, game.CmdReplacePC, i, j)
			}
		}
	}
	// wanted — хоть одна покупка расширения, которой не хватило денег в этот час: апгрейд ПК
	// ей не конкурент (он забрал бы деньги, копящиеся на сервер или core).
	wanted := false
	afford := func(price int) bool {
		ok := affordable(g, price)
		wanted = wanted || !ok
		return ok
	}
	for i := range g.Offices {
		o := &g.Offices[i]
		if !o.Unlocked {
			continue
		}
		// активный день: чиним сломанные ПК и чистим вирус (начать — очко
		// действий, ITGAME-127; кончились — отказ, break), мотивируем по
		// кулдауну — жадная политика забирает и активный слой тоже
		byHand := clicks(o)
		for j := range o.Employees {
			if !byHand {
				_ = g.Apply(game.CmdMotivate, i, j)
				continue
			}
			if o.Employees[j].PCBroken {
				// N кликов роллится при поломке (ITGAME-93): кликаем, пока
				// не починится — клики после первого бесплатны, N на экономику не влияет
				for o.Employees[j].PCBroken {
					if g.Apply(game.CmdRepairClick, i, j) != nil {
						break
					}
				}
			}
			// вирус (ITGAME-103): чистим заражённое место — 3 клика, начать — очко,
			// как ремонт; сломанное заражённое чистится тем же кликом
			for o.Employees[j].Infected {
				if g.Apply(game.CmdVirusClick, i, j) != nil {
					break
				}
			}
			_ = g.Apply(game.CmdMotivate, i, j) // кулдаун → ошибка → мимо
		}
		// места: ПК под найм, найм под ПК
		for len(o.Employees) < o.PCs && afford(cfg.HirePrice) {
			if !buy(g, game.CmdHire, i, 0) {
				break
			}
		}
		if len(o.Employees) == o.PCs && o.PCs < o.StaffCap(cfg) && afford(g.NextPCPrice(i)) {
			buy(g, game.CmdBuyPC, i, 0)
		}
		// роутер: порты кончились при живых сотрудниках
		if o.Ports(cfg) <= len(o.Employees) && o.RouterTier < len(cfg.RouterTiers) && afford(g.NextRouterPrice(i)) {
			buy(g, game.CmdBuyRouter, i, 0)
		}
		// сервер: сотрудникам не хватило стойки
		if g.CoreLevel > 0 && len(o.Servers) < cfg.ServerSlotsPerOffice() &&
			afford(cfg.ServerLevels[0].Price) {
			buy(g, game.CmdBuyServer, i, 0)
		}
		// быт: кулер и холодильник снимают дебаффы, кофе — бафф;
		// холодильник и кофеварка — только после кулера (ITGAME-102)
		if !o.Cooler && afford(cfg.CoolerPrice) {
			buy(g, game.CmdBuyCooler, i, 0)
		}
		if o.Cooler && !o.Fridge && afford(cfg.FridgePrice) {
			buy(g, game.CmdBuyFridge, i, 0)
		}
		if o.Cooler && !o.CoffeeMachine && afford(cfg.CoffeeMachinePrice) {
			buy(g, game.CmdBuyCoffee, i, 0)
		}
		// начальник открывает слоты, когда упёрлись в потолок штата
		if o.Boss == "" && o.PCs >= cfg.StaffLimit && afford(cfg.BossPrice) {
			buy(g, game.CmdHireBoss, i, 0)
		}
	}
	// core: первый уровень сразу, дальше — когда ёмкость исчерпана
	// (апгрейд ради апгрейда — не экономика). Один шаг за час.
	if g.CoreLevel < len(g.Config().CoreLevels) {
		net := g.Network()
		capacity := 0
		if g.CoreLevel > 0 {
			capacity = g.Config().CoreLevels[g.CoreLevel-1].Capacity
		}
		if (g.CoreLevel == 0 || net.CoreUsed >= capacity) && afford(g.Config().CoreLevels[g.CoreLevel].Price) {
			buy(g, game.CmdUpgradeCore, 0, 0)
		}
	}
	if !wanted {
		upgradeOnePC(g)
	}
}

// upgradeOnePC — один апгрейд ПК за час (ITGAME-135): занятое живое место с
// самым низким уровнем (при равенстве — первый офис, первое место). Место на
// пределе износа пропускается: следующая поломка убьёт и апгрейд. Зовётся, только
// когда расширению денег хватило на всё, что оно хотело в этот час.
func upgradeOnePC(g *game.Game) {
	cfg := g.Config()
	bestOffice, bestSlot, bestLevel := -1, -1, 0
	for i := range g.Offices {
		o := &g.Offices[i]
		if !o.Unlocked {
			continue
		}
		for j := range o.Employees {
			w := o.Workplace(j)
			if w.Dead || g.NextPCLevelPrice(i, j) == 0 || (cfg.PCWearLimit > 0 && w.Wear >= cfg.PCWearLimit) {
				continue
			}
			if bestOffice < 0 || w.Level < bestLevel {
				bestOffice, bestSlot, bestLevel = i, j, w.Level
			}
		}
	}
	// с запасом на замену: апгрейд на последние деньги оставил бы компанию без $500 на мёртвый ПК
	if bestOffice >= 0 && affordable(g, g.NextPCLevelPrice(bestOffice, bestSlot)+g.PCReplacePrice()) {
		buy(g, game.CmdUpgradePC, bestOffice, bestSlot)
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
		slot   int // стол для upgrade_pc/replace_pc, остальным команды не нужен
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
			doable = append(doable, action{game.CmdHire, i, 0, cfg.HirePrice})
		}
		if o.PCs < o.StaffCap(cfg) && g.NextPCPrice(i) > 0 {
			doable = append(doable, action{game.CmdBuyPC, i, 0, g.NextPCPrice(i)})
		}
		if o.RouterTier < len(cfg.RouterTiers) {
			doable = append(doable, action{game.CmdBuyRouter, i, 0, g.NextRouterPrice(i)})
		}
		if g.CoreLevel > 0 && len(o.Servers) < cfg.ServerSlotsPerOffice() {
			doable = append(doable, action{game.CmdBuyServer, i, 0, cfg.ServerLevels[0].Price})
		}
		if !o.Cooler {
			doable = append(doable, action{game.CmdBuyCooler, i, 0, cfg.CoolerPrice})
		}
		if o.Cooler && !o.Fridge {
			doable = append(doable, action{game.CmdBuyFridge, i, 0, cfg.FridgePrice})
		}
		if o.Cooler && !o.CoffeeMachine {
			doable = append(doable, action{game.CmdBuyCoffee, i, 0, cfg.CoffeeMachinePrice})
		}
		// рабочие места (ITGAME-135): по одному действию каждого вида на офис
		replaced, upgraded := false, false
		for j := range o.Employees {
			if !replaced && o.Workplace(j).Dead {
				doable = append(doable, action{game.CmdReplacePC, i, j, g.PCReplacePrice()})
				replaced = true
			}
			if !upgraded && g.NextPCLevelPrice(i, j) > 0 {
				doable = append(doable, action{game.CmdUpgradePC, i, j, g.NextPCLevelPrice(i, j)})
				upgraded = true
			}
		}
	}
	if g.CoreLevel < len(cfg.CoreLevels) {
		doable = append(doable, action{game.CmdUpgradeCore, 0, 0, cfg.CoreLevels[g.CoreLevel].Price})
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
	_ = g.Apply(a.cmd, a.office, a.slot)
}
