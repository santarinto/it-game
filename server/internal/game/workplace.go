package game

import "fmt"

// Рабочее место (ITGAME-135): GDD «Рабочее место: уровни ПК и износ». Уровень
// и износ живут на месте, а не на сотруднике: свободный стол с ПК держит свои,
// уволенный уходит без них. Сотрудник i сидит за Workplaces[i]; столы
// len(Employees)..PCs-1 свободны.

// Workplace — состояние ПК одного стола. Нулевое значение — новый ПК: ЭЛТ,
// без износа, живой.
type Workplace struct {
	Level int  // индекс в cfg.PCLevels: 0 — ЭЛТ
	Wear  int  // поломок ПК места пережито; при cfg.PCWearLimit следующая выводит ПК из строя
	Dead  bool // «требуется замена»: доход 0, клики не чинят, только replace_pc
}

// Workplace — состояние стола i; вне диапазона (в том числе i < 0) — новый ПК.
func (o *Office) Workplace(i int) Workplace {
	if i < 0 || i >= len(o.Workplaces) {
		return Workplace{}
	}
	return o.Workplaces[i]
}

// syncWorkplaces дописывает новые ПК, пока мест меньше, чем PCs или
// сотрудников: дельта debug и фикстура правят PCs, не трогая Workplaces. Не
// укорачивает.
func (o *Office) syncWorkplaces() {
	for len(o.Workplaces) < max(o.PCs, len(o.Employees)) {
		o.Workplaces = append(o.Workplaces, Workplace{})
	}
}

// workplaceRef — место стола i для записи; i должен быть < max(PCs, штат).
func (o *Office) workplaceRef(i int) *Workplace {
	o.syncWorkplaces()
	return &o.Workplaces[i]
}

// pcMult — множитель выработки уровня ПК стола i; 1, если уровня в конфиге нет.
func (g *Game) pcMult(o *Office, i int) float64 {
	lvl := o.Workplace(i).Level
	if lvl < 0 || lvl >= len(g.cfg.PCLevels) {
		return 1
	}
	return g.cfg.PCLevels[lvl].Mult
}

// NextPCLevelPrice — цена апгрейда стола до следующего уровня. 0 — стола нет,
// ПК мёртв (сначала замена) или уровень максимальный.
func (g *Game) NextPCLevelPrice(office, slot int) int {
	if office < 0 || office >= len(g.Offices) {
		return 0
	}
	o := &g.Offices[office]
	if slot < 0 || slot >= o.PCs {
		return 0
	}
	w := o.Workplace(slot)
	if w.Dead || w.Level+1 >= len(g.cfg.PCLevels) {
		return 0
	}
	return g.cfg.PCLevels[w.Level+1].Price
}

// PCReplacePrice — цена замены ПК: базовая цена ПК без роста ×1.15 — рост
// платят за новый стол в офисе, не за железо на старом.
func (g *Game) PCReplacePrice() int { return g.cfg.PCPrice }

// UpgradePC — апгрейд ПК стола slot (0..PCs-1, свободные столы тоже) на
// следующий уровень; износ сохраняется — тот же ПК, новый монитор.
func (g *Game) UpgradePC(office, slot int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if slot < 0 || slot >= o.PCs {
		return ErrBadSlot
	}
	w := o.workplaceRef(slot)
	if w.Dead {
		return ErrPCDead
	}
	if w.Level+1 >= len(g.cfg.PCLevels) {
		return ErrPCMaxLevel
	}
	price := g.cfg.PCLevels[w.Level+1].Price
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.spend(CmdUpgradePC, price)
	w.Level++
	return nil
}

// ReplacePC — замена ПК стола slot: мёртвого или изношенного (Wear > 0). Новый
// ПК — ЭЛТ без износа, уровень теряется; поломка и вирус места уходят.
func (g *Game) ReplacePC(office, slot int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if slot < 0 || slot >= o.PCs {
		return ErrBadSlot
	}
	w := o.workplaceRef(slot)
	if !w.Dead && w.Wear == 0 {
		return ErrPCFresh
	}
	price := g.PCReplacePrice()
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.spend(CmdReplacePC, price)
	*w = Workplace{}
	if slot < len(o.Employees) {
		e := &o.Employees[slot]
		infected := e.Infected
		e.PCBroken, e.RepairClicks, e.RepairNeeded = false, 0, 0
		e.Infected, e.VirusClicks = false, 0
		if infected {
			g.virusSettled(office, cleanedSilent)
		}
	}
	return nil
}

// killPC выводит ПК стола slot из строя («требуется замена», ITGAME-135):
// мёртвый ПК выключен — поломка и заражение места уходят с ним (иначе число
// заражённых не дойдёт до 0 и таймер волны пойдёт вечно). Смерть — инцидент
// дня; DayIncidents считает вызывающий.
func (g *Game) killPC(oi, slot int) {
	o := &g.Offices[oi]
	o.workplaceRef(slot).Dead = true
	if slot < len(o.Employees) {
		e := &o.Employees[slot]
		infected := e.Infected
		e.PCBroken, e.RepairClicks, e.RepairNeeded = false, 0, 0
		e.Infected, e.VirusClicks = false, 0
		if infected {
			g.virusSettled(oi, cleanedSilent)
		}
	}
	g.logEvent(fmt.Sprintf("ПК места %d (офис %d) выработал ресурс — требуется замена", slot+1, oi+1))
}
