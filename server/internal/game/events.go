package game

import (
	"fmt"
	"slices"
)

// Unseen Forces (итерация 10): дневные события. Роллятся в NextDay,
// активируются тиком в окне после обеда, висят до выбора игрока
// (или мягкого авто-резолва в конце дня). Источник чисел — GDD «События».

// EventID — тип события; значение совпадает с полем id протокола.
type EventID string

const (
	EventVirus    = EventID("virus")
	EventDeadline = EventID("deadline")
	EventAudit    = EventID("audit")
	EventRaise    = EventID("raise")
	EventStar     = EventID("star")
)

// Доли дедлайна от ожидаемого дохода окна (GDD): цель 70%, премия 35%,
// штраф 15%, отказ 5%. Скалируются EventK: штрафы жёстче, премии мягче.
const (
	deadlineGoalShare   = 0.7
	deadlineRewardShare = 0.35
	deadlineFineShare   = 0.15
	deadlineRefuseShare = 0.05
)

// starIncomeBonus — прибавка звёздного кандидата к потолку выработки.
const starIncomeBonus = 6

// DayEvent — событие дня.
type DayEvent struct {
	ID        EventID
	Tick      int  // тик активации (тост)
	Office    int  // вирус/повышение: адресат
	Slot      int  // повышение: индекс сотрудника
	Dismissed bool // тост закрыт игроком (аудит ещё ждёт своего чека)
	Resolved  bool // сыграло (выбор/авто/чек), в очереди не участвует
}

// EventInfo — активное событие для снапшота протокола.
type EventInfo struct {
	ID      string
	Title   string
	Text    string
	Options []string
}

// rollDayEvents — план событий нового дня: 0–2 штуки, окно 12:00–17:00,
// типы не повторяются. Вызывается из NextDay.
func (g *Game) rollDayEvents() {
	g.DayEvents = nil
	g.ActiveEvent = nil
	g.EventLog = nil
	g.DeadlineOn, g.DeadlineGot, g.DeadlineGoal = false, 0, 0
	lo, hi := g.cfg.eventWindow()
	if hi <= lo || g.rng.IntN(100) >= g.cfg.EventChancePct {
		return
	}
	count := 1
	if g.rng.IntN(100) < g.cfg.EventSecondPct {
		count = 2
	}
	used := make(map[EventID]bool, count)
	for ; count > 0; count-- {
		ev, ok := g.rollOneEvent(used, lo, hi)
		if !ok {
			break
		}
		used[ev.ID] = true
		g.DayEvents = append(g.DayEvents, ev)
	}
	slices.SortFunc(g.DayEvents, func(a, b DayEvent) int { return a.Tick - b.Tick })
}

// rollOneEvent — кандидат из пула доступных типов по весам
// (вирус 25, дедлайн 20, аудит 15, повышение 25, звезда 15).
func (g *Game) rollOneEvent(used map[EventID]bool, lo, hi int) (DayEvent, bool) {
	tick := lo + g.rng.IntN(hi-lo)
	type cand struct {
		id EventID
		w  int
	}
	var cands []cand
	add := func(id EventID, w int, ok bool) {
		if ok && !used[id] {
			cands = append(cands, cand{id, w})
		}
	}
	add(EventVirus, 25, g.randomStaffedOffice() >= 0)
	add(EventDeadline, 20, g.baseIncomePerTick() > 0)
	add(EventAudit, 15, true)
	add(EventRaise, 25, g.randomStaffedOffice() >= 0)
	add(EventStar, 15, g.starOffice() >= 0)
	if len(cands) == 0 {
		return DayEvent{}, false
	}
	total := 0
	for _, c := range cands {
		total += c.w
	}
	r := g.rng.IntN(total)
	for _, c := range cands {
		r -= c.w
		if r < 0 {
			return g.makeEvent(c.id, tick), true
		}
	}
	return DayEvent{}, false
}

// makeEvent — событие с адресатами по типу.
func (g *Game) makeEvent(id EventID, tick int) DayEvent {
	ev := DayEvent{ID: id, Tick: tick}
	switch id {
	case EventVirus:
		ev.Office = g.randomStaffedOffice()
	case EventRaise:
		oi := g.randomStaffedOffice()
		ev.Office = oi
		ev.Slot = g.rng.IntN(len(g.Offices[oi].Employees))
	}
	return ev
}

// randomStaffedOffice — индекс случайного открытого офиса с сотрудниками; −1.
func (g *Game) randomStaffedOffice() int {
	var staffed []int
	for oi := range g.Offices {
		if g.Offices[oi].Unlocked && len(g.Offices[oi].Employees) > 0 {
			staffed = append(staffed, oi)
		}
	}
	if len(staffed) == 0 {
		return -1
	}
	return staffed[g.rng.IntN(len(staffed))]
}

// starOffice — первый офис со свободным местом для звёздного кандидата; −1.
func (g *Game) starOffice() int {
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if o.Unlocked && len(o.Employees) < min(o.PCs, o.StaffCap(g.cfg)) {
			return oi
		}
	}
	return -1
}

// baseIncomePerTick — суммарная базовая выработка компании без эффектов
// и сети: точка отсчёта цели дедлайна (баффы помогают перевыполнить).
func (g *Game) baseIncomePerTick() int {
	total := 0
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked {
			continue
		}
		for _, e := range o.Employees {
			total += e.IncomePerTick
		}
	}
	return total
}

// activateEvents — переводит событие из плана в активные, когда тик дошёл.
// Одно одновременно: остальные ждут, пока игрок не решит висящее.
func (g *Game) activateEvents() {
	if g.ActiveEvent != nil {
		return
	}
	for i := range g.DayEvents {
		ev := &g.DayEvents[i]
		if ev.Resolved || ev.Dismissed || ev.Tick > g.TickInDay {
			continue
		}
		if !g.eventStillValid(ev) {
			ev.Resolved = true
			continue
		}
		g.ActiveEvent = ev
		if ev.ID == EventVirus {
			o := &g.Offices[ev.Office]
			o.VirusUntil = g.TickInDay + g.cfg.VirusTicks
		}
		return
	}
}

// eventStillValid — не потеряло ли событие смысл между роллом и тиком
// (сотрудников уволили нет, но место звезды могли занять; офис вируса опустел).
func (g *Game) eventStillValid(ev *DayEvent) bool {
	switch ev.ID {
	case EventVirus:
		o := &g.Offices[ev.Office]
		return o.Unlocked && len(o.Employees) > 0
	case EventRaise:
		return ev.Slot < len(g.Offices[ev.Office].Employees)
	case EventStar:
		return g.starOffice() >= 0
	default:
		return true
	}
}

// tickEvents — прогресс событий на тике: трек дедлайна и чек аудита.
// Вызывается из Tick после начисления дохода тика.
func (g *Game) tickEvents(income int) {
	if g.DeadlineOn {
		g.DeadlineGot += income
		if g.TickInDay >= g.cfg.deadlineTick() {
			g.DeadlineOn = false
			if g.DeadlineGot >= g.DeadlineGoal {
				reward := int(deadlineRewardShare * float64(g.DeadlineGoal) / g.cfg.EventK)
				g.Money += reward
				g.logEvent(fmt.Sprintf("дедлайн выполнен (+$%d)", reward))
			} else {
				fine := int(deadlineFineShare * float64(g.DeadlineGoal) * g.cfg.EventK)
				g.Money -= fine
				g.logEvent(fmt.Sprintf("дедлайн провален (−$%d)", fine))
			}
		}
	}
	for i := range g.DayEvents {
		ev := &g.DayEvents[i]
		if ev.ID != EventAudit || ev.Resolved {
			continue
		}
		// Проверка независима от тоста: аудиторы приходят в 18:00 сами.
		if g.TickInDay >= g.cfg.auditTick() {
			ev.Resolved = true
			if g.Gateway && g.CoreLevel >= g.cfg.AuditMinCore {
				g.Money += g.cfg.AuditReward
				g.logEvent(fmt.Sprintf("аудит пройден (+$%d)", g.cfg.AuditReward))
			} else {
				g.Money -= g.cfg.AuditPenalty
				g.logEvent(fmt.Sprintf("аудит провален (−$%d)", g.cfg.AuditPenalty))
			}
		}
	}
}

// autoResolveEvents — мягкий резолв висящих к концу дня: без новых
// эффектов, только строчка в лог (дебаффы либо истекли, либо не начаты).
func (g *Game) autoResolveEvents() {
	ev := g.ActiveEvent
	if ev == nil {
		return
	}
	switch ev.ID {
	case EventVirus:
		g.logEvent("вирус: дотерпели до конца дня")
	case EventDeadline:
		g.logEvent("дедлайн проигнорирован")
	case EventRaise:
		g.logEvent("просьба о повышении проигнорирована")
	case EventStar:
		g.logEvent("звёздный кандидат ушёл")
	case EventAudit:
		// Чек либо уже прошёл в tickEvents, либо догонит тост прямо
		// на тике проверки — просто закрываем.
		ev.Dismissed = true
	}
	ev.Resolved = true
	g.ActiveEvent = nil
}

// deadlineGoalFor — цель дедлайна от текущего момента: 70% базовой
// выработки за продуктивные тики до 17:00.
func (g *Game) deadlineGoalFor() int {
	n := 0
	for t := g.TickInDay; t < g.cfg.deadlineTick(); t++ {
		if !g.cfg.isLunchTick(t) {
			n++
		}
	}
	return int(deadlineGoalShare * float64(g.baseIncomePerTick()) * float64(n))
}

// ChooseEvent — выбор опции активного события; option — её индекс.
func (g *Game) ChooseEvent(option int) error {
	ev := g.ActiveEvent
	if ev == nil {
		return ErrNoEvent
	}
	switch ev.ID {
	case EventVirus:
		if option == 0 {
			if g.Money < g.cfg.VirusPrice {
				return ErrNotEnoughMoney
			}
			g.Money -= g.cfg.VirusPrice
			g.Offices[ev.Office].VirusUntil = 0
			g.logEvent(fmt.Sprintf("вирус: куплен антивирус (−$%d)", g.cfg.VirusPrice))
		} else if option == 1 {
			g.logEvent(fmt.Sprintf("вирус: −%d%% до %s", virusDebuffPct(g.cfg.VirusMult), g.ClockAt(g.Offices[ev.Office].VirusUntil)))
		} else {
			return ErrBadOption
		}
	case EventDeadline:
		switch option {
		case 0:
			g.DeadlineOn = true
			g.DeadlineGot = 0
			g.DeadlineGoal = g.deadlineGoalFor()
			g.logEvent(fmt.Sprintf("дедлайн принят: цель $%d", g.DeadlineGoal))
		case 1:
			fine := int(deadlineRefuseShare * float64(g.deadlineGoalFor()) * g.cfg.EventK)
			g.Money -= fine
			g.logEvent(fmt.Sprintf("дедлайн отклонён (−$%d)", fine))
		default:
			return ErrBadOption
		}
	case EventAudit:
		if option != 0 {
			return ErrBadOption
		}
		// Тост закрыт, но проверка в 18:00 всё равно придёт сама.
		ev.Dismissed = true
		g.ActiveEvent = nil
		return nil
	case EventRaise:
		e := &g.Offices[ev.Office].Employees[ev.Slot]
		switch option {
		case 0:
			e.SalaryAdd += g.cfg.SalaryPerDay / 2
			e.IncomePerTick = int(float64(e.IncomePerTick)*g.cfg.RaiseBoostMult + 0.5)
			g.logEvent(fmt.Sprintf("%s: повышение (+$%d/день)", e.Name, g.cfg.SalaryPerDay/2))
		case 1:
			e.OffendedUntil = g.cfg.DayTicks()
			g.logEvent(fmt.Sprintf("%s: обижен отказом", e.Name))
		default:
			return ErrBadOption
		}
	case EventStar:
		switch option {
		case 0:
			oi := g.starOffice()
			if oi < 0 {
				return ErrNoFreePC
			}
			price := g.cfg.HirePrice * 2
			if g.Money < price {
				return ErrNotEnoughMoney
			}
			g.Money -= price
			o := &g.Offices[oi]
			o.Employees = append(o.Employees, Employee{
				Name:          rollName(g.rng) + " ★",
				IncomePerTick: g.cfg.IncomeMax + starIncomeBonus,
				SalaryAdd:     g.cfg.SalaryPerDay,
				UnpaidToday:   g.hiredAfterLunch(),
			})
			g.logEvent(fmt.Sprintf("звёздный кандидат нанят (−$%d)", price))
		case 1:
			g.logEvent("звёздный кандидат упущен")
		default:
			return ErrBadOption
		}
	default:
		return ErrBadOption
	}
	ev.Resolved = true
	g.ActiveEvent = nil
	return nil
}

func (g *Game) logEvent(s string) {
	g.EventLog = append(g.EventLog, g.Clock()+" "+s)
}

func virusDebuffPct(mult float64) int {
	return int((1 - mult) * 100)
}

// ActiveEventInfo — активное событие для снапшота протокола.
func (g *Game) ActiveEventInfo() *EventInfo {
	ev := g.ActiveEvent
	if ev == nil {
		return nil
	}
	switch ev.ID {
	case EventVirus:
		until := g.ClockAt(g.Offices[ev.Office].VirusUntil)
		return &EventInfo{ID: string(ev.ID), Title: "Вирус в сети",
			Text: fmt.Sprintf("Офис %d: доход офиса −%d%% до %s.",
				ev.Office+1, virusDebuffPct(g.cfg.VirusMult), until),
			Options: []string{
				fmt.Sprintf("Купить антивирус $%d", g.cfg.VirusPrice),
				"Терпеть",
			}}
	case EventDeadline:
		goal := g.deadlineGoalFor()
		reward := int(deadlineRewardShare * float64(goal) / g.cfg.EventK)
		fine := int(deadlineFineShare * float64(goal) * g.cfg.EventK)
		refuse := int(deadlineRefuseShare * float64(goal) * g.cfg.EventK)
		return &EventInfo{ID: string(ev.ID), Title: "Дедлайн от бизнеса",
			Text: fmt.Sprintf("Заработать $%d до %s — премия $%d, провал — штраф $%d.",
				goal, g.ClockAt(g.cfg.deadlineTick()), reward, fine),
			Options: []string{"Взяться", fmt.Sprintf("Отказаться (−$%d)", refuse)}}
	case EventAudit:
		return &EventInfo{ID: string(ev.ID), Title: "Аудит безопасности",
			Text: fmt.Sprintf("В %s аудиторы проверят сеть: шлюз и core ур.%d+ — субсидия $%d, иначе штраф $%d.",
				g.ClockAt(g.cfg.auditTick()), g.cfg.AuditMinCore, g.cfg.AuditReward, g.cfg.AuditPenalty),
			Options: []string{"Принять к сведению"}}
	case EventRaise:
		e := &g.Offices[ev.Office].Employees[ev.Slot]
		return &EventInfo{ID: string(ev.ID), Title: "Просит повышения",
			Text: fmt.Sprintf("%s просит повышение: +$%d/день к зарплате и +%d%% выработки навсегда. Отказ обидит до конца дня.",
				e.Name, g.cfg.SalaryPerDay/2, int((g.cfg.RaiseBoostMult-1)*100)),
			Options: []string{
				fmt.Sprintf("Согласиться (+$%d/день)", g.cfg.SalaryPerDay/2),
				"Отказать",
			}}
	case EventStar:
		return &EventInfo{ID: string(ev.ID), Title: "Звёздный кандидат",
			Text: fmt.Sprintf("Сильный специалист ищет работу: выработка $%d/тик, зарплата ×2. Найм — $%d.",
				g.cfg.IncomeMax+starIncomeBonus, g.cfg.HirePrice*2),
			Options: []string{
				fmt.Sprintf("Нанять $%d", g.cfg.HirePrice*2),
				"Пропустить",
			}}
	}
	return nil
}
