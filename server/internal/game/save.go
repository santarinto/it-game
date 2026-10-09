package game

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
)

// Сейвы сессии (ITGAME-8): игра сериализуется целиком — конфиг, с которым
// она создана, и все поля состояния. Сид входит в сейв (ITGAME-26):
// восстановление ресивит RNG по нему — роллы воспроизводимы от старта
// партии. Позицию в потоке math/rand/v2 прочитать нельзя, поэтому
// реконнект начинает последовательность роллов заново с того же сида.

// ErrBadSave — сейв повреждён или несовместим: восстановиться нельзя,
// сессия начинается заново.
var ErrBadSave = errors.New("bad_save")

// Save — сериализуемый слепок Game: конфиг плюс все поля состояния.
// Поле в день отчёта (Phase=day_report) валидно: TickInDay при этом равен
// длине дня, отчёт дошлёт ws-слой из LastReport.
type Save struct {
	Config            Config     `json:"config"`
	Seed              uint64     `json:"seed"` // сид RNG: восстанавливается при load (ITGAME-26)
	Money             int        `json:"money"`
	Offices           []Office   `json:"offices"`
	CoreLevel         int        `json:"coreLevel"`
	Gateway           bool       `json:"gateway"`
	Phase             Phase      `json:"phase"`
	Day               int        `json:"day"`
	TickInDay         int        `json:"tickInDay"`
	DayIncome         int        `json:"dayIncome"`
	DayEventMoney     int        `json:"dayEventMoney"` // деньги событий дня (ITGAME-53)
	PrevDayIncome     int        `json:"prevDayIncome"` // доход прошлого закрытого дня (ITGAME-50)
	PeakIncomePerTick int        `json:"peakIncomePerTick"`
	DayIncidents      int        `json:"dayIncidents"`
	DayLostIncome     int        `json:"dayLostIncome"`
	DayEvents         []DayEvent `json:"dayEvents"`
	ActiveEvent       *DayEvent  `json:"activeEvent"`
	EventLog          []string   `json:"eventLog"`
	DeadlineOn        bool       `json:"deadlineOn"`
	DeadlineGot       int        `json:"deadlineGot"`
	DeadlineGoal      int        `json:"deadlineGoal"`
	MarketToday       int        `json:"marketToday"`    // рынок дня, % (Сложность 2.0)
	MarketTomorrow    int        `json:"marketTomorrow"` // завтрашний ролл, виден заранее
}

// Export — слепок текущего состояния для сейва.
func (g *Game) Export() Save {
	s := Save{
		Config: cloneConfig(g.cfg), Seed: g.Seed, Money: g.Money, Offices: cloneOffices(g.Offices), CoreLevel: g.CoreLevel,
		Gateway: g.Gateway, Phase: g.Phase, Day: g.Day, TickInDay: g.TickInDay,
		DayIncome: g.DayIncome, DayEventMoney: g.DayEventMoney, PrevDayIncome: g.PrevDayIncome, PeakIncomePerTick: g.PeakIncomePerTick,
		DayIncidents: g.DayIncidents, DayLostIncome: g.DayLostIncome,
		EventLog:   slices.Clone(g.EventLog),
		DeadlineOn: g.DeadlineOn, DeadlineGot: g.DeadlineGot, DeadlineGoal: g.DeadlineGoal,
		MarketToday: g.MarketToday, MarketTomorrow: g.MarketTomorrow,
	}
	// Копии, не алиасы живой игры: debug restore пишет json.Unmarshal поверх
	// Export(), а он декодирует элементы массивов в существующий backing
	// array — офисы, журнал и конфиг (ITGAME-60), план дня (ITGAME-52).
	// Указатель в план дня дал бы полю activeEvent затереть его элемент;
	// связь восстанавливает Restore.
	s.DayEvents = slices.Clone(g.DayEvents)
	if g.ActiveEvent != nil {
		ev := *g.ActiveEvent
		s.ActiveEvent = &ev
	}
	return s
}

// cloneOffices — глубокая копия офисов: у каждого свои Employees, Servers
// и CoffeeEventTicks (ITGAME-60). Employee — только значения, ссылок нет.
func cloneOffices(offices []Office) []Office {
	out := slices.Clone(offices)
	for i := range out {
		out[i].Employees = slices.Clone(out[i].Employees)
		out[i].Servers = slices.Clone(out[i].Servers)
		out[i].CoffeeEventTicks = slices.Clone(out[i].CoffeeEventTicks)
	}
	return out
}

// cloneConfig — конфиг со своими слайсами (ITGAME-60): часть из них общая с
// базовым конфигом сервера (Handler.Config), и дельта поверх Export()
// переписала бы его для всех сессий.
func cloneConfig(c Config) Config {
	c.RouterTiers = slices.Clone(c.RouterTiers)
	c.ServerLevels = slices.Clone(c.ServerLevels)
	c.CoreLevels = slices.Clone(c.CoreLevels)
	c.OfficePrices = slices.Clone(c.OfficePrices)
	c.EmployeeLevelXP = slices.Clone(c.EmployeeLevelXP)
	c.EmployeeLevelBonus = slices.Clone(c.EmployeeLevelBonus)
	return c
}

// bindActiveEvent — копия плана дня и активное событие как указатель в
// неё (ITGAME-52). ChooseEvent, retargetRaiseEvents и activateEvents
// полагаются на то, что ActiveEvent — элемент DayEvents; JSON этой связи
// не хранит, и после реконнекта выбор закрывал бы отдельную копию, а
// элемент плана оставался нерешённым и всплывал снова. Элемент ищется по
// типу и тику активации (типы за день не повторяются), решённость не
// важна: аудит с открытым тостом после чека в 18:00 висит активным уже
// решённым. Состояние берётся из плана, не из копии: копия старого
// сервера могла отстать от чека, а debug-дельта правит именно план. Не
// нашёлся (ручной debug-стейт) — копия дописывается в план.
func bindActiveEvent(events []DayEvent, active *DayEvent) ([]DayEvent, *DayEvent) {
	events = slices.Clone(events)
	if active == nil {
		return events, nil
	}
	find := func() int {
		return slices.IndexFunc(events, func(ev DayEvent) bool {
			return ev.ID == active.ID && ev.Tick == active.Tick
		})
	}
	if find() < 0 {
		events = append(events, *active)
		slices.SortStableFunc(events, func(a, b DayEvent) int { return a.Tick - b.Tick })
	}
	return events, &events[find()]
}

// Restore — игра из сейва. Ошибку возвращает ErrBadSave: битые сейвы
// молча заменяются новой игрой, это не авария сервера.
func Restore(s Save) (*Game, error) {
	if s.Day < 1 || len(s.Offices) == 0 || !s.Offices[0].Unlocked {
		return nil, fmt.Errorf("%w: day=%d offices=%d", ErrBadSave, s.Day, len(s.Offices))
	}
	dayTicks := s.Config.DayTicks()
	if dayTicks <= 0 || s.TickInDay < 0 || s.TickInDay > dayTicks {
		return nil, fmt.Errorf("%w: tickInDay=%d dayTicks=%d", ErrBadSave, s.TickInDay, dayTicks)
	}
	switch s.Phase {
	case PhaseRunning:
		if s.TickInDay >= dayTicks {
			return nil, fmt.Errorf("%w: running за концом дня", ErrBadSave)
		}
	case PhaseDayReport:
		// валидно: ждём next_day
	default:
		return nil, fmt.Errorf("%w: фаза %q не восстанавливается", ErrBadSave, s.Phase)
	}
	// Сейвы до ITGAME-50: в конфиге нет полей аудита, дохода прошлого дня нет.
	def := DefaultConfig()
	if s.Config.AuditMinDay == 0 {
		s.Config.AuditMinDay = def.AuditMinDay
	}
	if s.Config.AuditFineShare == 0 {
		s.Config.AuditFineShare = def.AuditFineShare
	}
	if s.PrevDayIncome == 0 && s.Phase == PhaseDayReport {
		s.PrevDayIncome = s.DayIncome // закрытый день — он и есть «прошлый»
	}
	g := &Game{
		cfg: s.Config, Seed: s.Seed,
		Money: s.Money, Offices: s.Offices, CoreLevel: s.CoreLevel, Gateway: s.Gateway,
		Phase: s.Phase, Day: s.Day, TickInDay: s.TickInDay,
		DayIncome: s.DayIncome, DayEventMoney: s.DayEventMoney, PrevDayIncome: s.PrevDayIncome, PeakIncomePerTick: s.PeakIncomePerTick,
		DayIncidents: s.DayIncidents, DayLostIncome: s.DayLostIncome,
		EventLog:   s.EventLog,
		DeadlineOn: s.DeadlineOn, DeadlineGot: s.DeadlineGot, DeadlineGoal: s.DeadlineGoal,
		MarketToday: s.MarketToday, MarketTomorrow: s.MarketTomorrow,
	}
	g.DayEvents, g.ActiveEvent = bindActiveEvent(s.DayEvents, s.ActiveEvent)
	// RNG ресивится по сиду из сейва (ITGAME-26): та же последовательность
	// роллов, что с начала партии. Старые сейвы без сида — свежий
	// случайный, как до ITGAME-26.
	switch {
	case s.Seed != 0:
		g.rng = rand.New(rand.NewPCG(s.Seed, mixSeed(s.Seed)))
	default:
		g.rng = rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64()))
	}
	return g, nil
}
