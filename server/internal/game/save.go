package game

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"strconv"
	"strings"
)

// Сейвы сессии (ITGAME-8): игра сериализуется целиком — конфиг, с которым
// она создана, и все поля состояния. Сид входит в сейв (ITGAME-26):
// восстановление ресивит RNG по нему — роллы воспроизводимы от старта
// партии. Позицию в потоке math/rand/v2 прочитать нельзя, поэтому
// реконнект начинает последовательность роллов заново с того же сида.

// ErrBadSave — сейв повреждён или несовместим: восстановиться нельзя,
// сессия начинается заново.
var ErrBadSave = errors.New("bad_save")

// SaveFormat — версия формата сейва, её пишет Export. Сейв другого формата — старше или новее —
// не читается (ErrBadSave), миграций нет; сейв того же формата продолжается на любой сборке
// (ITGAME-169, правило владельца 18.10). Любое добавленное, убранное или изменённое поле файла
// сейва — Save и ws.sessionSave вокруг него (отчёт дня, скорость, журнал…), на любой глубине:
// ключ, тип, опции json-тега — поднимает формат; это держат TestSaveShape (слепок
// testdata/save_shape.txt) и TestSessionSaveShape в ws (ITGAME-175). Поля конфига, добавленные
// в формат 1 до правила (аудит, клики ремонта, тарифы антивируса, цены админа), Restore
// дописывает из уровня сейва.
// 1 — ITGAME-103: вирус живёт на местах, конфиг без VirusSpreadTicks и OfficeCols встал бы
// нулями и сломал волну. Сейв без поля — формат 0.
// 2 — ITGAME-135: рабочие места (Office.Workplaces) и их конфиг (PCLevels, PCWearLimit);
// решение владельца 20.10.
// 3 — ITGAME-196/203: Config.BreakdownChancePct → BreakdownChancePermille (шанс поломки в ‰),
// Config.EventBudget (бюджет случайных событий дня), Employee.RaisePct (накопленное повышение,
// %) и DayEvent.RaisePct (% повышения, брошенный при плане), Save.incomeCarry (дробный остаток
// дохода компании); Config.RaiseBoostMult убран; решение владельца 21.10.
// 4 — ITGAME-127: очки действий директора — Config.ActionPointsPerDay и Save.actionPoints
// (остаток на сегодня); решение владельца 21.10.
// 5 — ITGAME-198: «просит уйти пораньше» — Employee.AwayFrom, OverworkedUntil, RestedDay
// и Config.OverworkMult; решение владельца 24.10.
const SaveFormat = 5

// Save — сериализуемый слепок Game: конфиг плюс все поля состояния.
// Поле в день отчёта (Phase=day_report) валидно: TickInDay при этом равен
// длине дня, отчёт дошлёт ws-слой из LastReport.
type Save struct {
	Format            int        `json:"format"` // SaveFormat; 0 — сейв до ITGAME-103
	Config            Config     `json:"config"`
	Seed              uint64     `json:"seed"` // сид RNG: восстанавливается при load (ITGAME-26)
	Money             int        `json:"money"`
	IncomeCarry       float64    `json:"incomeCarry"` // дробный остаток дохода, $ в [0, 1) (ITGAME-196)
	Offices           []Office   `json:"offices"`
	CoreLevel         int        `json:"coreLevel"`
	Gateway           bool       `json:"gateway"`
	AdminDept         bool       `json:"adminDept"` // отдел админов куплен (ITGAME-101)
	Phase             Phase      `json:"phase"`
	Day               int        `json:"day"`
	TickInDay         int        `json:"tickInDay"`
	DayIncome         int        `json:"dayIncome"`
	DayEventMoney     int        `json:"dayEventMoney"` // деньги событий дня (ITGAME-53)
	PrevDayIncome     int        `json:"prevDayIncome"` // доход прошлого закрытого дня (ITGAME-50)
	PeakIncomePerTick int        `json:"peakIncomePerTick"`
	DayIncidents      int        `json:"dayIncidents"`
	DayLostIncome     int        `json:"dayLostIncome"`
	VirusWaveIn       int        `json:"virusWaveIn"`     // тиков до волны вируса, 0 — заражённых нет (ITGAME-103)
	AVTier            int        `json:"avTier"`          // подписка на антивирус: 0 — нет, 1..N — тариф (ITGAME-137)
	AVTierBilled      int        `json:"avTierBilled"`    // самый дорогой тариф, включённый за день: его цена — вечером
	DayVirusPCs       int        `json:"dayVirusPCs"`     // новых заражений за день
	DayVirusLost      int        `json:"dayVirusLost"`    // упущено из-за вируса за день
	DayAdminRepairs   int        `json:"dayAdminRepairs"` // ПК, починенных админами за день (ITGAME-101)
	DayAdminCleaned   int        `json:"dayAdminCleaned"` // мест, вычищенных админами за день
	ActionPoints      int        `json:"actionPoints"`    // очков действий осталось на сегодня (ITGAME-127)
	DayEvents         []DayEvent `json:"dayEvents"`
	ActiveEvent       *DayEvent  `json:"activeEvent"`
	EventLog          []string   `json:"eventLog"`
	DeadlineOn        bool       `json:"deadlineOn"`
	DeadlineGot       int        `json:"deadlineGot"`
	DeadlineGoal      int        `json:"deadlineGoal"`
	MarketToday       int        `json:"marketToday"`    // рынок дня, % (Сложность 2.0)
	MarketTomorrow    int        `json:"marketTomorrow"` // завтрашний ролл, виден заранее
	// Бухгалтерия (ITGAME-73): текущий день и не больше LedgerDays закрытых.
	// Нет в сейве (старый сейв) — книга начинается с текущего тика.
	Ledger        *DayLedger  `json:"ledger,omitempty"`
	LedgerHistory []DayLedger `json:"ledgerHistory,omitempty"`
}

// UnmarshalJSON читает сид и числом (так он лежит в файлах), и строкой (так его
// отдаёт debug-ответ, ITGAME-191: JS-число выше 2^53 теряет точность). Нет поля seed (дельта itd.restore) — сид не меняется.
func (s *Save) UnmarshalJSON(b []byte) error {
	type plain Save
	aux := struct {
		*plain
		Seed json.RawMessage `json:"seed"`
	}{plain: (*plain)(s)}
	if err := json.Unmarshal(b, &aux); err != nil {
		return err
	}
	if t := strings.Trim(string(aux.Seed), `"`); aux.Seed != nil && t != "null" {
		v, err := strconv.ParseUint(t, 10, 64)
		if err != nil {
			return fmt.Errorf("seed: %s не uint64", aux.Seed)
		}
		s.Seed = v
	}
	return nil
}

// Export — слепок текущего состояния для сейва.
func (g *Game) Export() Save {
	s := Save{
		Format: SaveFormat, Config: cloneConfig(g.cfg), Seed: g.Seed, Money: g.Money, IncomeCarry: g.IncomeCarry,
		Offices: cloneOffices(g.Offices), CoreLevel: g.CoreLevel,
		Gateway: g.Gateway, AdminDept: g.AdminDept, Phase: g.Phase, Day: g.Day, TickInDay: g.TickInDay,
		DayIncome: g.DayIncome, DayEventMoney: g.DayEventMoney, PrevDayIncome: g.PrevDayIncome, PeakIncomePerTick: g.PeakIncomePerTick,
		DayIncidents: g.DayIncidents, DayLostIncome: g.DayLostIncome,
		VirusWaveIn: g.VirusWaveIn, DayVirusPCs: g.DayVirusPCs, DayVirusLost: g.DayVirusLost,
		DayAdminRepairs: g.DayAdminRepairs, DayAdminCleaned: g.DayAdminCleaned, ActionPoints: g.ActionPoints,
		AVTier: g.AVTier, AVTierBilled: g.AVTierBilled,
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
	cur := g.Ledger.clone()
	s.Ledger = &cur
	for _, l := range g.LedgerHistory {
		s.LedgerHistory = append(s.LedgerHistory, l.clone())
	}
	if g.ActiveEvent != nil {
		ev := *g.ActiveEvent
		s.ActiveEvent = &ev
	}
	return s
}

// cloneOffices — глубокая копия офисов: у каждого свои Employees, Servers
// и CoffeeEventTicks (ITGAME-60). Employee и Workplace — только значения, ссылок нет.
func cloneOffices(offices []Office) []Office {
	out := slices.Clone(offices)
	for i := range out {
		out[i].Employees = slices.Clone(out[i].Employees)
		out[i].Workplaces = slices.Clone(out[i].Workplaces)
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
	c.PCLevels = slices.Clone(c.PCLevels)
	c.OfficePrices = slices.Clone(c.OfficePrices)
	c.EmployeeLevelXP = slices.Clone(c.EmployeeLevelXP)
	c.EmployeeLevelBonus = slices.Clone(c.EmployeeLevelBonus)
	c.AntivirusTiers = slices.Clone(c.AntivirusTiers)
	return c
}

// bindActiveEvent — копия плана дня и активное событие как указатель в
// неё (ITGAME-52). ChooseEvent, retargetSlotEvents и activateEvents
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
	if s.Format != SaveFormat {
		return nil, fmt.Errorf("%w: формат %d, сервер читает только %d — миграций нет", ErrBadSave, s.Format, SaveFormat)
	}
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
	// Сейвы до ITGAME-93: фиксированные 3 клика (RepairClicksNeeded в
	// конфиге игнорируется), у сломанного ПК нет своего N — он чинится за
	// те же 3, что обещала метка «0/3» до реконнекта.
	if s.Config.RepairClicksMin == 0 {
		s.Config.RepairClicksMin = def.RepairClicksMin
	}
	if s.Config.RepairClicksMax == 0 {
		s.Config.RepairClicksMax = def.RepairClicksMax
	}
	// Сейвы формата 1 до ITGAME-137: тарифов в конфиге нет — берём тарифы
	// уровня сейва, формат не поднимаем (партия на стенде переживает деплой).
	if len(s.Config.AntivirusTiers) == 0 {
		s.Config.AntivirusTiers = ApplyDifficulty(def, ParseDifficulty(string(s.Config.Difficulty))).AntivirusTiers
	}
	// Конфиг до ITGAME-101: полей админа нет — цены уровня сейва.
	if s.Config.AdminPrice == 0 || s.Config.AdminSalaryPerDay == 0 || s.Config.AdminClicksPerTick == 0 || s.Config.AdminDeptPrice == 0 {
		lvl := ApplyDifficulty(def, ParseDifficulty(string(s.Config.Difficulty)))
		s.Config.AdminPrice, s.Config.AdminSalaryPerDay, s.Config.AdminClicksPerTick, s.Config.AdminDeptPrice =
			lvl.AdminPrice, lvl.AdminSalaryPerDay, lvl.AdminClicksPerTick, lvl.AdminDeptPrice
	}
	if s.AVTier < 0 || s.AVTier > len(s.Config.AntivirusTiers) || s.AVTierBilled < 0 || s.AVTierBilled > len(s.Config.AntivirusTiers) {
		return nil, fmt.Errorf("%w: avTier=%d avTierBilled=%d", ErrBadSave, s.AVTier, s.AVTierBilled)
	}
	// Остаток дохода — дробь реальных денег (ITGAME-196): вне [0, 1) (и NaN) его
	// не бывает, такой сейв правлен руками или дельтой.
	if !(s.IncomeCarry >= 0 && s.IncomeCarry < 1) {
		return nil, fmt.Errorf("%w: incomeCarry=%v вне [0, 1)", ErrBadSave, s.IncomeCarry)
	}
	// Очки действий (ITGAME-127): от нуля до запаса дня — больше утро не даёт.
	if s.ActionPoints < 0 || s.ActionPoints > s.Config.ActionPointsPerDay {
		return nil, fmt.Errorf("%w: actionPoints=%d вне [0, %d]", ErrBadSave, s.ActionPoints, s.Config.ActionPointsPerDay)
	}
	for oi := range s.Offices {
		for ei := range s.Offices[oi].Employees {
			if e := &s.Offices[oi].Employees[ei]; e.PCBroken && e.RepairNeeded <= 0 {
				e.RepairNeeded = LegacyRepairClicks
			}
		}
		// Рабочие места (ITGAME-135): по одному на ПК. Дельта debug и фикстура правят PCs без
		// мест — недостающие дописываются новыми (ЭЛТ, без износа), лишние отрезаются.
		o := &s.Offices[oi]
		if o.PCs < 0 {
			return nil, fmt.Errorf("%w: офис %d: pcs=%d", ErrBadSave, oi, o.PCs)
		}
		o.syncWorkplaces()
		if len(o.Workplaces) > o.PCs {
			o.Workplaces = o.Workplaces[:o.PCs]
		}
		for i, w := range o.Workplaces {
			if w.Level < 0 || w.Level >= len(s.Config.PCLevels) || w.Wear < 0 {
				return nil, fmt.Errorf("%w: офис %d, место %d: level=%d wear=%d", ErrBadSave, oi, i, w.Level, w.Wear)
			}
			if e := o.Employees; w.Dead && i < len(e) && (e[i].PCBroken || e[i].Infected) {
				return nil, fmt.Errorf("%w: офис %d, место %d: мёртвое место не бывает сломанным или заражённым", ErrBadSave, oi, i)
			}
		}
	}
	if s.PrevDayIncome == 0 && s.Phase == PhaseDayReport {
		s.PrevDayIncome = s.DayIncome // закрытый день — он и есть «прошлый»
	}
	g := &Game{
		cfg: s.Config, Seed: s.Seed,
		Money: s.Money, IncomeCarry: s.IncomeCarry, Offices: s.Offices, CoreLevel: s.CoreLevel, Gateway: s.Gateway, AdminDept: s.AdminDept,
		Phase: s.Phase, Day: s.Day, TickInDay: s.TickInDay,
		DayIncome: s.DayIncome, DayEventMoney: s.DayEventMoney, PrevDayIncome: s.PrevDayIncome, PeakIncomePerTick: s.PeakIncomePerTick,
		DayIncidents: s.DayIncidents, DayLostIncome: s.DayLostIncome,
		VirusWaveIn: s.VirusWaveIn, DayVirusPCs: s.DayVirusPCs, DayVirusLost: s.DayVirusLost,
		DayAdminRepairs: s.DayAdminRepairs, DayAdminCleaned: s.DayAdminCleaned, ActionPoints: s.ActionPoints,
		AVTier: s.AVTier, AVTierBilled: s.AVTierBilled,
		EventLog:   s.EventLog,
		DeadlineOn: s.DeadlineOn, DeadlineGot: s.DeadlineGot, DeadlineGoal: s.DeadlineGoal,
		MarketToday: s.MarketToday, MarketTomorrow: s.MarketTomorrow,
	}
	g.DayEvents, g.ActiveEvent = bindActiveEvent(s.DayEvents, s.ActiveEvent)
	g.restoreLedger(s.Ledger, s.LedgerHistory)
	// RNG ресивится по сиду из сейва (ITGAME-26): та же последовательность
	// роллов, что с начала партии. Сид 0 — тоже сид (?seed=0): ветка «нет
	// сида — свежий случайный» для сейвов до ITGAME-26 делала партию с
	// ?seed=0 невоспроизводимой с первого реконнекта (найдено реплеем,
	// ITGAME-46), а сейвов старше TTL (24 ч) давно нет.
	g.pcg = rand.NewPCG(s.Seed, mixSeed(s.Seed))
	g.rng = rand.New(g.pcg)
	return g, nil
}
