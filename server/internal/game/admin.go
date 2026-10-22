package game

import (
	"fmt"
	"slices"
)

// Админы (ITGAME-101): GDD «Админы (ITGAME-101)». Админ — свой в каждом
// офисе, как начальник: не производит, места, ПК и сети не занимает, в штат
// не входит. Каждый тик делает AdminClicksPerTick кликов ремонта и чистки по
// местам своего офиса — те же клики, что игрок мышью.

// BuyAdminDept покупает отдел админов — комнату, где сидят админы офисов
// (решение владельца 17.10: у админов свой отдел, потом там шкафы и
// верстаки). Один на компанию.
func (g *Game) BuyAdminDept() error {
	if g.AdminDept {
		return ErrAdminDeptAlready
	}
	if g.Money < g.cfg.AdminDeptPrice {
		return ErrNotEnoughMoney
	}
	g.spend(CmdBuyAdminDept, g.cfg.AdminDeptPrice)
	g.AdminDept = true
	return nil
}

// HireAdmin нанимает админа офиса: сидит в отделе, работает на свой офис.
func (g *Game) HireAdmin(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if !g.AdminDept {
		return ErrAdminDeptLocked
	}
	if o.Admin != "" {
		return ErrAdminAlready
	}
	if g.Money < g.cfg.AdminPrice {
		return ErrNotEnoughMoney
	}
	g.spend(CmdHireAdmin, g.cfg.AdminPrice)
	o.Admin = rollName(g.rng)
	o.AdminUnpaidToday = g.hiredAfterLunch()
	o.AdminHireDay = g.Day
	return nil
}

// AdminFireCompensation — компенсация увольнения админа офиса: день его
// зарплаты, в день найма — как у сотрудника на испытательном сроке.
func (g *Game) AdminFireCompensation(office int) int {
	if g.Offices[office].AdminHireDay == g.Day {
		return g.cfg.FireCompSameDay
	}
	return g.cfg.AdminSalaryPerDay
}

// FireAdmin увольняет админа офиса.
func (g *Game) FireAdmin(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if o.Admin == "" {
		return ErrNoAdmin
	}
	comp := g.AdminFireCompensation(office)
	if g.Money < comp {
		return ErrNotEnoughMoney
	}
	g.spend(CmdFireAdmin, comp)
	o.Admin, o.AdminUnpaidToday, o.AdminHireDay = "", false, 0
	return nil
}

// Цели админа — что он сейчас кликает (протокол: officeInfo.adminKind).
const (
	adminVirus  = "virus"
	adminRepair = "repair"
)

// AdminTarget — место, по которому придётся следующий клик админа офиса:
// первое заражённое место с целым ПК (вирус расползается), иначе сломанное
// (оно в офисе одно). -1, "" — кликать некуда. Наличие админа не проверяет.
// Мёртвое место (ITGAME-135) не сломано и не заражено — сюда не попадает.
func (o *Office) AdminTarget() (slot int, kind string) {
	for i := range o.Employees {
		if e := &o.Employees[i]; e.Infected && !e.PCBroken {
			return i, adminVirus
		}
	}
	for i := range o.Employees {
		if o.Employees[i].PCBroken {
			return i, adminRepair
		}
	}
	return -1, ""
}

// adminWork — clicks кликов админа по местам офиса: цель пересчитывается на
// каждый клик, лишний клик уходит следующей. Только места: журнал, таймер
// волны и карточку оседает вызывающий — прогноз гоняет это на копии мест.
// done (может быть nil) узнаёт о каждом доделанном месте: индекс и вид работы.
func (o *Office) adminWork(cfg Config, clicks int, done func(slot int, kind string)) (repaired, cleaned int) {
	for range clicks {
		i, kind := o.AdminTarget()
		finished := false
		switch kind {
		case adminVirus:
			if finished = o.Employees[i].virusClick(cfg.VirusCleanClicks); finished {
				cleaned++
			}
		case adminRepair:
			if finished = o.Employees[i].repairClick(); finished {
				repaired++
			}
		default:
			return repaired, cleaned
		}
		if finished && done != nil {
			done(i, kind)
		}
	}
	return repaired, cleaned
}

// adminTick — тик работы всех админов компании: клики, счётчики дня и
// оседание вируса в офисах, где что-то вычищено (by — строка журнала).
// Вживую каждое доделанное место — строка журнала дня в момент действия
// (ITGAME-170, решение владельца 21.10): «админ офиса 1 починил место 3»,
// «… вычистил место 2»; итог офиса «вирус: офис N вычищен админом к HH:MM»
// остаётся после них. Офлайн-догон (cleanedSilent) журнал не трогает.
func (g *Game) adminTick(by cleaner) {
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked || o.Admin == "" {
			continue
		}
		var done func(slot int, kind string)
		if by != cleanedSilent {
			done = func(slot int, kind string) { g.logEvent(adminLogLine(oi, slot, kind)) }
		}
		repaired, cleaned := o.adminWork(g.cfg, g.cfg.AdminClicksPerTick, done)
		g.DayAdminRepairs += repaired
		g.DayAdminCleaned += cleaned
		if cleaned > 0 {
			g.virusSettled(oi, by)
		}
	}
}

// adminLogLine — строка журнала дня о доделанном админом месте (без часов,
// их ставит logEvent); офис и место — с единицы, как в остальном журнале.
func adminLogLine(oi, slot int, kind string) string {
	verb := "починил"
	if kind == adminVirus {
		verb = "вычистил"
	}
	return fmt.Sprintf("админ офиса %d %s место %d", oi+1, verb, slot+1)
}

// hasAdmins — есть ли в компании хоть один админ.
func (g *Game) hasAdmins() bool {
	for i := range g.Offices {
		if g.Offices[i].Unlocked && g.Offices[i].Admin != "" {
			return true
		}
	}
	return false
}

// adminsBusy — есть ли админу хоть одного офиса что кликать.
func (g *Game) adminsBusy() bool {
	for i := range g.Offices {
		o := &g.Offices[i]
		if _, kind := o.AdminTarget(); o.Unlocked && o.Admin != "" && kind != "" {
			return true
		}
	}
	return false
}

// seatsCopy — копия игры со своими местами: прогноз гоняет на ней работу
// админов, не трогая живую партию. Остальное общее и только читается.
func (g *Game) seatsCopy() *Game {
	cp := *g
	cp.Offices = cloneOffices(g.Offices)
	return &cp
}

// adminsWork — тик кликов всех админов по местам копии: без журнала, таймера
// и счётчиков дня.
func (g *Game) adminsWork() {
	for i := range g.Offices {
		if o := &g.Offices[i]; o.Unlocked && o.Admin != "" {
			o.adminWork(g.cfg, g.cfg.AdminClicksPerTick, nil)
		}
	}
}

// offlineIncome — точный доход тиков [lo, hi) офлайн-догона (в деньги его
// переводит creditIncome, ITGAME-196): админы работают тем же темпом, что
// вживую (до дохода тика, как в Tick), журнал молчит. Без админов — ровно
// exactIncome без шага.
func (g *Game) offlineIncome(lo, hi int) float64 {
	return g.exactIncome(lo, hi, func() { g.adminTick(cleanedSilent) })
}

// adoptSeats — состояние мест из шаблона офлайн-дня, где поработали админы:
// поломки и заражения живой игры догоняют шаблон, таймер волны и карточка
// вируса оседают молча.
func (g *Game) adoptSeats(tpl *Game) {
	for oi := range g.Offices {
		for i := range g.Offices[oi].Employees {
			e, t := &g.Offices[oi].Employees[i], &tpl.Offices[oi].Employees[i]
			e.PCBroken, e.RepairClicks, e.RepairNeeded = t.PCBroken, t.RepairClicks, t.RepairNeeded
			e.Infected, e.VirusClicks = t.Infected, t.VirusClicks
		}
		if g.Offices[oi].Admin != "" {
			g.virusSettled(oi, cleanedSilent)
		}
	}
}

// adminDoneTicks — сколько тиков (с текущего) админу офиса чистить вирус по
// очереди: ремонт сломанного заражённого — тоже. 0 — заражённых нет, -1 —
// админа нет. Новых поломок и волн не знает, как и прогноз.
func (g *Game) adminDoneTicks(oi int) int {
	o := &g.Offices[oi]
	if o.Admin == "" || g.cfg.AdminClicksPerTick <= 0 {
		return -1
	}
	cp := Office{Employees: slices.Clone(o.Employees)}
	for n := 0; ; n++ {
		infected := false
		for i := range cp.Employees {
			infected = infected || cp.Employees[i].Infected
		}
		if !infected {
			return n
		}
		cp.adminWork(g.cfg, g.cfg.AdminClicksPerTick, nil)
	}
}

// adminCardLine — строка карточки «Вирус в сети» офиса с админом: к какому
// времени он вычистит офис по очереди (через ночь — утреннее время, как у
// VirusWaveClock). "" — админа нет или чистить нечего.
func (g *Game) adminCardLine(oi int) string {
	n := g.adminDoneTicks(oi)
	if n <= 0 {
		return ""
	}
	t := g.TickInDay + n - 1 // тик последнего клика
	for day := g.cfg.DayTicks(); t >= day; {
		t -= day
	}
	return fmt.Sprintf(" Админ офиса вычистит сам к %s.", g.ClockAt(t))
}
