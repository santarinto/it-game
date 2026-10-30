// Package ws — WebSocket-протокол и сессии игры.
package ws

import (
	"itdirector/internal/db"
	"itdirector/internal/game"
)

// effectInfo — активный эффект сотрудника для тултипа.
type effectInfo struct {
	Token   string `json:"token"`   // thirst | hunger | coffee
	Percent int    `json:"percent"` // −10 / +15
	Until   string `json:"until"`   // «HH:MM»; "" — до конца дня
}

// clientMessage — сообщение клиента: {"type": "...", "office": N}.
// office адресует офисные команды (hire, buy_pc, buy_router, hire_boss,
// buy_office); остальные его игнорируют. Агентские поля (ITGAME-29)
// читает только /ws/agent: дни/тики промотки, патч и сценарий.
type clientMessage struct {
	Type string `json:"type"`
	// ID — номер команды от клиента (ITGAME-45), необязательный: сервер
	// возвращает его как re в error и в снапшоте, порождённом этой командой,
	// — только отправителю. 0/нет — команда без квитанции (старые бандлы).
	ID     int64 `json:"id"`
	Office int   `json:"office"`
	Slot   int   `json:"slot"`  // стойка для upgrade_server; место для motivate/repair_click/…; стол для upgrade_pc/replace_pc
	Speed  int   `json:"speed"` // параметр set_speed: 0 — пауза, 1..3 — множитель темпа; у exit — скорость возврата

	// Агентский мост (ITGAME-29): типы status, debug_patch, debug_advance,
	// debug_step, debug_scenario.
	Days      int    `json:"days"`
	Ticks     int    `json:"ticks"`
	Money     *int   `json:"money"`
	Day       *int   `json:"day"`
	TickInDay *int   `json:"tickInDay"`
	Scenario  string `json:"scenario"`

	// Мета-прогресс (ITGAME-132): seed_meta / sync_meta
	Stats        *db.MetaStats                  `json:"stats,omitempty"`
	Achievements map[string]db.AchievementState `json:"achievements,omitempty"`
}

// stateCause — почему разослан снапшот (ITGAME-45): тик, команда, отладка
// (/api/debug/*, debug_* моста), первый снапшот сессии — новой (start) или
// восстановленной из сейва (resume). Зеркало STATE_CAUSES в
// client/src/protocol.ts; gen-contract сверяет по stateCause("…").
type stateCause string

const (
	causeTick   = stateCause("tick")
	causeCmd    = stateCause("cmd")
	causeDebug  = stateCause("debug")
	causeStart  = stateCause("start")
	causeResume = stateCause("resume")
)

// stateMessage — полный снапшот состояния. Включает производные поля
// (доход, порты, множитель), чтобы клиент ничего не считал сам.
type stateMessage struct {
	Type string `json:"type"` // всегда "state"
	// Версия состояния сессии (ITGAME-45): растёт на 1 с каждым разосланным
	// снапшотом, переживает resume через сейв. Копии без изменений (первый
	// снапшот наблюдателя, GET /api/debug/state) несут текущие rev и cause.
	Rev   uint64     `json:"rev"`
	Cause stateCause `json:"cause"` // tick | cmd | debug | start | resume
	// Re — id команды отправителя, породившей этот снапшот; есть только в
	// копии отправителя (остальные соединения сессии видят тот же rev без re).
	Re                int64            `json:"re,omitempty"`
	Money             int              `json:"money"`
	Offices           []officeInfo     `json:"offices"`
	Gateway           bool             `json:"gateway"`
	AdminDept         bool             `json:"adminDept"` // отдел админов куплен (ITGAME-101): без него админов не нанять
	Core              coreInfo         `json:"core"`
	IncomePerTick     int              `json:"incomePerTick"`
	Day               int              `json:"day"`
	Clock             string           `json:"clock"`   // «12:30»
	IsLunch           bool             `json:"isLunch"` // обед: доход за тик = 0
	TicksPerHour      int              `json:"ticksPerHour"`
	PayrollPerDay     int              `json:"payrollPerDay"` // полные расходы дня
	SalaryPerDay      int              `json:"salaryPerDay"`
	BossSalaryPerDay  int              `json:"bossSalaryPerDay"`
	AdminSalaryPerDay int              `json:"adminSalaryPerDay"` // зарплата админа офиса (ITGAME-101)
	ForecastEndOfDay  int              `json:"forecastEndOfDay"`
	StaffLimit        int              `json:"staffLimit"`
	PCWearLimit       int              `json:"pcWearLimit"` // поломок, которые ПК переживает; следующая — «требуется замена»; 0 — не изнашивается (ITGAME-135)
	OfficeSlots       int              `json:"officeSlots"`
	Phase             string           `json:"phase"`           // running | day_report | game_over
	Speed             int              `json:"speed"`           // темп сессии: 0 — пауза, 1..3
	Resumed           bool             `json:"resumed"`         // снапшот восстановленной сессии (ITGAME-8)
	Seed              string           `json:"seed"`            // сид RNG партии, десятичная строка (ITGAME-26)
	Scenario          string           `json:"scenario"`        // фикстура старта (ITGAME-26); "" — обычная партия
	TickInDay         int              `json:"tickInDay"`       // тик текущего дня (ITGAME-26: степпинг/отладка)
	DayIncome         int              `json:"dayIncome"`       // доход, накопленный за текущий день
	DayProfit         int              `json:"dayProfit"`       // прибыль дня с прогнозом до вечера, = «Прибыль» отчёта (ITGAME-53)
	Difficulty        string           `json:"difficulty"`      // easy | normal | hard | hardcore
	WinTarget         int              `json:"winTarget"`       // денежная часть цели, $
	WinStaff          int              `json:"winStaff"`        // комбо-цель: сотрудников (0 — нет; Сложность 2.0)
	WinCore           int              `json:"winCore"`         // комбо-цель: уровень core (0 — нет)
	WinDayLimit       int              `json:"winDayLimit"`     // дедлайн цели: дней (0 — нет)
	MarketToday       int              `json:"marketToday"`     // рынок: % выработки сегодня (0 — нет)
	MarketTomorrow    int              `json:"marketTomorrow"`  // завтрашний рынок, виден заранее
	CreditLimit       int              `json:"creditLimit"`     // кредитный порог, $ (0 — кредита нет)
	CreditRatePct     int              `json:"creditRatePct"`   // процент за день на долг
	DebtLimit         int              `json:"debtLimit"`       // порог долга, $: глубже — вечер банкротит; CreditLimit или, без кредита, расходы дня (овердрафт, ITGAME-156)
	BankruptInDays    int              `json:"bankruptInDays"`  // обречённая партия: банкротство через N закрытий дня, 0 — нет (ITGAME-118)
	VirusWaveAt       string           `json:"virusWaveAt"`     // «HH:MM», с которого видна следующая волна вируса; "" — заражённых нет (ITGAME-103)
	Antivirus         antivirusInfo    `json:"antivirus"`       // подписка на антивирус (ITGAME-137)
	ActionPoints      int              `json:"actionPoints"`    // очков действий директора осталось на сегодня (ITGAME-127)
	ActionPointsMax   int              `json:"actionPointsMax"` // запас дня: столько утром (ITGAME-127/205)
	DirectorCabinet   int              `json:"directorCabinet"` // уровень апгрейда кабинета директора (ITGAME-205)
	DirectorLevel     int              `json:"directorLevel"`   // общий уровень директора 1..10 (ITGAME-205)
	DirectorExpBonus  int              `json:"directorExpBonus"` // бонус ОД от дней выживания (ITGAME-205)
	ActiveEvent       *activeEventInfo `json:"activeEvent"`
	// Итоги событий текущего дня «HH:MM текст» (ITGAME-163) — те же строки, что
	// придут в dayReport.events, но вживую: лента HUD кладёт строку, когда событие
	// случилось, а не вечером с отчётом.
	DayLog        []string `json:"dayLog"`
	Prices        prices   `json:"prices"`
	OfflineReport bool     `json:"offlineReport,omitempty"` // первый снапшот после resume: следом идёт offline_report (ITGAME-76)
	Incompatible  bool     `json:"incompatible,omitempty"`  // первый снапшот новой партии: сейв был чужого формата и отвергнут (ITGAME-174)
}

// officeInfo — офис в снапшоте: всё для отрисовки комнаты и панели.
type officeInfo struct {
	Unlocked bool `json:"unlocked"`
	Price    int  `json:"price"` // цена покупки; 0 для открытых
	PCs      int  `json:"pcs"`
	NextPC   int  `json:"nextPC"` // цена следующего ПК офиса; 0 — мест нет
	// Рабочие места (ITGAME-135): по ПК офиса, len = pcs, сотрудник i сидит за i; свободные столы
	// тоже. Не nil — у закрытого офиса [].
	Workplaces      []workplaceInfo `json:"workplaces"`
	RouterTier      int             `json:"routerTier"`
	Ports           int             `json:"ports"`
	NextRouter      int             `json:"nextRouter"` // 0 — тир максимальный
	NextPorts       int             `json:"nextPorts"`  // порты следующего тира; 0 — тир максимальный
	Servers         []serverInfo    `json:"servers"`
	ServerSlots     int             `json:"serverSlots"`
	Boss            string          `json:"boss"` // "" — начальника нет
	BossUnpaidToday bool            `json:"bossUnpaidToday"`
	// Админ офиса (ITGAME-101/144): не сотрудник — места не занимает.
	Admin            string           `json:"admin"` // "" — админа нет
	AdminUnpaidToday bool             `json:"adminUnpaidToday"`
	AdminSlot        int              `json:"adminSlot"`      // место, по которому его следующий клик; -1 — свободен или админа нет
	AdminKind        string           `json:"adminKind"`      // repair | virus | "" — что он там делает
	AdminFirePrice   int              `json:"adminFirePrice"` // компенсация увольнения; 0 — админа нет
	AdminShifts      []adminShiftInfo `json:"adminShifts"`    // нанятые смены админов (ITGAME-144)
	AdminNextShift   int              `json:"adminNextShift"` // номер следующей свободной смены (1..3); 0 — все заняты
	Cooler           bool             `json:"cooler"`
	Fridge           bool             `json:"fridge"`
	CoffeeMachine    bool             `json:"coffeeMachine"`
	VirusPCs         int              `json:"virusPCs"`  // заражённых мест офиса (ITGAME-103)
	Employees        []employeeInfo   `json:"employees"` // порядок = порядок найма
}

// adminShiftInfo — смена админа офиса в снапшоте (ITGAME-144).
type adminShiftInfo struct {
	Shift       int    `json:"shift"`
	Name        string `json:"name"`
	UnpaidToday bool   `json:"unpaidToday"`
	FirePrice   int    `json:"firePrice"`
}

// employeeInfo — сотрудник в снапшоте: всё, что нужно тултипу.
type employeeInfo struct {
	Name string `json:"name"`
	// Роль сотрудника (ITGAME-197): developer, tester, support, designer, pm, lead, analyst
	Role          string `json:"role"`
	IncomePerTick int    `json:"incomePerTick"`
	// Личная выработка с учётом активных эффектов (без сетевого множителя).
	EffectiveIncomePerTick int          `json:"effectiveIncomePerTick"`
	Connected              bool         `json:"connected"` // получил место в ёмкости core (зелёная точка)
	UnpaidToday            bool         `json:"unpaidToday"`
	Effects                []effectInfo `json:"effects"`
	NetMult                float64      `json:"netMult"`    // итоговый сетевой множитель
	ServerSlot             int          `json:"serverSlot"` // 1-based сервер работника; 0 — без сервера
	// Видимость сети (итерация 11): причина, почему место без бонусов сети.
	// '' — всё хорошо; no_router — нет роутера/порта; no_core — нет места
	// в стойке роутеров; no_server — в core есть, серверной стойки нет.
	OfflineReason string `json:"offlineReason"`
	// Активный день (итерация 9).
	PCBroken        bool   `json:"pcBroken"`        // ПК сломан: доход места 0
	RepairClicks    int    `json:"repairClicks"`    // клики починки уже сделаны (k из «k/N»)
	RepairNeeded    int    `json:"repairNeeded"`    // N кликов этой поломки, 3..15 (ITGAME-93); 0 — ПК цел
	MotivateReadyAt string `json:"motivateReadyAt"` // «HH:MM» клика возможен; "" — уже можно
	// Вирус (ITGAME-103): заражение места и чистка «k/3».
	Infected    bool `json:"infected"`
	VirusClicks int  `json:"virusClicks"` // клики чистки уже сделаны (k)
	VirusNeeded int  `json:"virusNeeded"` // кликов на чистку (3); 0 — место здорово
	AVCovered   bool `json:"avCovered"`   // место под подпиской на антивирус: не заражается (ITGAME-137)
	// Unseen Forces (итерация 10).
	Salary int `json:"salary"` // дневная зарплата этого сотрудника (с надбавками)
	// Сотрудники 2.0 (итерация 15).
	Level     int  `json:"level"`     // 0–3; производный от XP
	XP        int  `json:"xp"`        // накопленный опыт
	XPNext    int  `json:"xpNext"`    // до следующего уровня; 0 — потолок
	Star      bool `json:"star"`      // звезда: золотой бейдж, выработка ×1.5 при найме
	FirePrice int  `json:"firePrice"` // компенсация увольнения этого сотрудника
	// Накопленное повышение, %: выработка ×(1+RaisePct/100) навсегда (ITGAME-203); 0 — не повышали.
	// Отдельно от incomePerTick: прибавка живёт в множителе, а эффективная выработка тика округлена.
	RaisePct   int  `json:"raisePct"`
	HiredToday bool `json:"hiredToday"` // нанят в текущий день (компенсация ниже)
}

// serverInfo — сервер офиса в снапшоте: всё для модалки стойки.
type serverInfo struct {
	Slot       int     `json:"slot"` // 0-based индекс стойки
	Level      int     `json:"level"`
	Mult       float64 `json:"mult"`
	NextPrice  int     `json:"nextPrice"` // 0 — уровень максимальный
	Maxed      bool    `json:"maxed"`
	ServedFrom int     `json:"servedFrom"` // обслуживаемые работники офиса, 1-based
	ServedTo   int     `json:"servedTo"`
}

// coreInfo — core-коммутатор в снапшоте: всё для модалки core.
type coreInfo struct {
	Level     int     `json:"level"` // 0 — не куплен
	Capacity  int     `json:"capacity"`
	Connected int     `json:"connected"` // занято мест по компании
	Mult      float64 `json:"mult"`      // 1.1 на финальном уровне, иначе 1.0
	NextPrice int     `json:"nextPrice"` // 0 — уровень максимальный
	Maxed     bool    `json:"maxed"`
}

type serverLevelPrice struct {
	Mult  float64 `json:"mult"`
	Price int     `json:"price"`
}

type coreLevelPrice struct {
	Capacity int     `json:"capacity"`
	Price    int     `json:"price"`
	Mult     float64 `json:"mult"`
}

// antivirusInfo — подписка на антивирус (ITGAME-137).
type antivirusInfo struct {
	Tier        int    `json:"tier"`        // 0 — нет, 1..3 — индекс в prices.antivirusTiers + 1
	Name        string `json:"name"`        // "" — нет
	Seats       int    `json:"seats"`       // мест в тарифе; 0 — все
	Covered     int    `json:"covered"`     // мест под защитой сейчас
	BilledToday int    `json:"billedToday"` // спишется вечером: самый дорогой тариф дня
}

type antivirusTierPrice struct {
	Name  string `json:"name"`
	Seats int    `json:"seats"` // 0 — все места
	Price int    `json:"price"` // $/день
}

// activeEventInfo — висящее событие «Unseen Forces» (итерация 10).
type activeEventInfo struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Text    string   `json:"text"`
	Options []string `json:"options"`
}

// workplaceInfo — рабочее место (ITGAME-135): ПК стола с уровнем и износом.
type workplaceInfo struct {
	Level     int  `json:"level"`     // индекс в prices.pcLevels
	Wear      int  `json:"wear"`      // поломок пережито, из state.pcWearLimit
	Dead      bool `json:"dead"`      // «требуется замена»: доход 0, только replace_pc
	NextPrice int  `json:"nextPrice"` // апгрейд до следующего уровня; 0 — максимум или ПК мёртв
}

// pcLevelPrice — уровень ПК места: имя на подписи стола, множитель выработки, цена апгрейда до него.
type pcLevelPrice struct {
	Name  string  `json:"name"`
	Mult  float64 `json:"mult"`
	Price int     `json:"price"`
}

type prices struct {
	PC             int                  `json:"pc"`
	Hire           int                  `json:"hire"`
	Boss           int                  `json:"boss"`
	Admin          int                  `json:"admin"`     // найм админа офиса (ITGAME-101)
	AdminDept      int                  `json:"adminDept"` // покупка отдела админов
	Gateway        int                  `json:"gateway"`
	Cooler         int                  `json:"cooler"`
	Fridge         int                  `json:"fridge"`
	CoffeeMachine  int                  `json:"coffeeMachine"`
	Repair         int                  `json:"repair"`    // «вызвать мастера» для сломанного ПК
	PCLevels       []pcLevelPrice       `json:"pcLevels"`  // уровни ПК места (ITGAME-135)
	PCReplace      int                  `json:"pcReplace"` // замена ПК: цена базового ПК без роста
	ServerLevels   []serverLevelPrice   `json:"serverLevels"`
	CoreLevels               []coreLevelPrice             `json:"coreLevels"`
	AntivirusTiers           []antivirusTierPrice         `json:"antivirusTiers"` // тарифы подписки по возрастанию цены (ITGAME-137)
	DirectorCabinetNextPrice int                          `json:"directorCabinetNextPrice"` // цена следующего апгрейда кабинета; 0 — замаксен (ITGAME-205)
	DirectorCabinetLevels   []directorCabinetLevelPrice  `json:"directorCabinetLevels"`   // уровни улучшений кабинета (ITGAME-205)
}

// directorCabinetLevelPrice — ступень апгрейда кабинета директора в снапшоте цен (ITGAME-205).
type directorCabinetLevelPrice struct {
	Name  string `json:"name"`
	Bonus int    `json:"bonus"`
	Price int    `json:"price"`
}

// errorMessage — отказ команды; только отправителю. Re — id команды
// (ITGAME-45), Rev — версия состояния, при которой сервер отказал (отказ
// её не меняет).
type errorMessage struct {
	Type string `json:"type"` // всегда "error"
	Code string `json:"code"`
	Re   int64  `json:"re,omitempty"`
	Rev  uint64 `json:"rev"`
}

// dayReportMessage — итоги дня; шлётся сразу после снапшота с phase=day_report.
type dayReportMessage struct {
	Type         string   `json:"type"` // всегда "day_report"
	Day          int      `json:"day"`
	Income       int      `json:"income"`
	Payroll      int      `json:"payroll"`
	GatewayOpex  int      `json:"gatewayOpex"`
	Antivirus    int      `json:"antivirus"`  // подписка на антивирус за день (ITGAME-137)
	EventMoney   int      `json:"eventMoney"` // деньги исходов событий дня, со знаком (ITGAME-53)
	Profit       int      `json:"profit"`
	Balance      int      `json:"balance"`
	Incidents    int      `json:"incidents"`    // поломок ПК за день
	LostIncome   int      `json:"lostIncome"`   // упущено из-за поломок, $
	VirusPCs     int      `json:"virusPCs"`     // новых заражений за день (ITGAME-103)
	VirusLost    int      `json:"virusLost"`    // упущено из-за вируса, $
	AdminRepairs int      `json:"adminRepairs"` // ПК, починенных админами за день (ITGAME-101)
	AdminCleaned int      `json:"adminCleaned"` // мест, вычищенных админами за день
	Events       []string `json:"events"`       // события дня: по строке на итог
}

// gameOverMessage — итоги проигрыша; шлётся сразу после снапшота с phase=game_over.
type gameOverMessage struct {
	Type              string `json:"type"` // всегда "game_over"
	DaysSurvived      int    `json:"daysSurvived"`
	PeakIncomePerTick int    `json:"peakIncomePerTick"`
	Balance           int    `json:"balance"`   // отрицательный у банкротства: весь долг на момент банкротства
	Shortfall         int    `json:"shortfall"` // банкротство: долг сверх порога последнего вечера (кредитного или овердрафта), ITGAME-176; иначе 0
	Reason            string `json:"reason"`    // bankrupt | time_up | deadlock
}

// victoryMessage — итоги победы; шлётся сразу после снапшота с phase=won.
type victoryMessage struct {
	Type       string `json:"type"` // всегда "victory"
	Difficulty string `json:"difficulty"`
	Day        int    `json:"day"`
	Balance    int    `json:"balance"`
}

// offlineReportMessage — «пока вас не было» (ITGAME-8): итог офлайн-догона
// после восстановления сессии. GameOver/Victory — финал случился офлайн,
// обычные экраны финала не придут отдельными сообщениями.
type offlineReportMessage struct {
	Type     string `json:"type"` // всегда "offline_report"
	Ticks    int    `json:"ticks"`
	Days     int    `json:"days"`
	Income   int    `json:"income"`
	Payroll  int    `json:"payroll"`
	Balance  int    `json:"balance"`
	GameOver bool   `json:"gameOver"`
	Victory  bool   `json:"victory"`
	Reason   string `json:"reason"` // причина финала: bankrupt | time_up | deadlock
	// Последний сейв перед уходом, epoch ms: сейв пишется каждый тик, так что
	// это момент, когда сервер заметил обрыв (до него партия шла вживую).
	SavedAt int64 `json:"savedAt"`
}

func snapshot(g *game.Game, speed int, resumed bool, scenario string) stateMessage {
	cfg := g.Config()
	net := g.Network()
	cov := g.AVCovered()
	offices := make([]officeInfo, len(g.Offices))
	for oi := range g.Offices {
		o := &g.Offices[oi]
		price := 0
		if !o.Unlocked {
			price = cfg.OfficePrices[oi-1]
		}
		employees := make([]employeeInfo, len(o.Employees))
		for i, e := range o.Employees {
			// Не nil: nil-срез маршалится в JSON null, а клиент ждёт массив.
			effects := make([]effectInfo, 0, 4)
			for _, ef := range g.Effects(o, &o.Employees[i]) {
				until := ""
				if ef.Until >= 0 {
					until = g.ClockAt(ef.Until)
				}
				effects = append(effects, effectInfo{Token: ef.Token, Percent: ef.Percent, Until: until})
			}
			readyAt := ""
			if e.MotivateCooldownUntil > g.TickInDay {
				readyAt = g.ClockAt(e.MotivateCooldownUntil)
			}
			// Причина отсутствия сети: сверяется с логикой Network() —
			// ports режут первых, потом ёмкость core, стойки обслуживают четвёрками.
			reason := ""
			ports := o.Ports(cfg)
			switch {
			case i >= ports:
				reason = "no_router"
			case !net.CoreLinked[oi][i]:
				reason = "no_core"
			case net.ServerSlot[oi][i] == 0:
				reason = "no_server"
			}
			repairNeeded := 0
			if e.PCBroken {
				repairNeeded = o.Employees[i].RepairTarget()
			}
			virusNeeded := 0
			if e.Infected {
				virusNeeded = cfg.VirusCleanClicks
			}
			employees[i] = employeeInfo{Name: e.Name, Role: e.Role, IncomePerTick: e.IncomePerTick,
				EffectiveIncomePerTick: g.EffectiveIncomePerTick(o, i),
				Connected:              net.CoreLinked[oi][i], UnpaidToday: e.UnpaidToday, Effects: effects,
				NetMult: net.Mults[oi][i], ServerSlot: net.ServerSlot[oi][i],
				PCBroken: e.PCBroken, RepairClicks: e.RepairClicks, RepairNeeded: repairNeeded, MotivateReadyAt: readyAt,
				Salary: g.PersonalSalary(&e), OfflineReason: reason,
				Level: g.LevelFor(&o.Employees[i]), XP: e.XP, XPNext: g.XPNext(&o.Employees[i]),
				Star: e.Star, RaisePct: e.RaisePct, FirePrice: g.FireCompensation(&o.Employees[i]), HiredToday: e.HireDay == g.Day,
				Infected: e.Infected, VirusClicks: e.VirusClicks, VirusNeeded: virusNeeded, AVCovered: cov[oi][i]}
		}
		// Не nil: nil-срез маршалится в JSON null, а клиент ждёт массив.
		servers := make([]serverInfo, 0, len(o.Servers))
		for si, lvl := range o.Servers {
			next, maxed := 0, true
			if lvl < len(cfg.ServerLevels) {
				next, maxed = cfg.ServerLevels[lvl].Price, false
			}
			servers = append(servers, serverInfo{
				Slot: si, Level: lvl, Mult: cfg.ServerLevels[lvl-1].Mult,
				NextPrice: next, Maxed: maxed,
				ServedFrom: si*cfg.EmployeesPerServer + 1,
				ServedTo:   (si + 1) * cfg.EmployeesPerServer,
			})
		}
		adminSlot, adminKind, adminFire := -1, "", 0
		if o.Admin != "" {
			adminSlot, adminKind = o.AdminTarget()
			adminFire = g.AdminFireCompensation(oi)
		}
		var adminShifts []adminShiftInfo
		for _, s := range o.AdminShifts {
			adminShifts = append(adminShifts, adminShiftInfo{
				Shift:       s.Shift,
				Name:        s.Name,
				UnpaidToday: s.UnpaidToday,
				FirePrice:   g.AdminShiftFireCompensation(oi, s.Shift),
			})
		}
		if len(adminShifts) == 0 && o.Admin != "" {
			adminShifts = []adminShiftInfo{{
				Shift:       1,
				Name:        o.Admin,
				UnpaidToday: o.AdminUnpaidToday,
				FirePrice:   adminFire,
			}}
		}
		if adminShifts == nil {
			adminShifts = []adminShiftInfo{}
		}
		nextAdminShift := o.NextAdminShift()
		workplaces := make([]workplaceInfo, 0, o.PCs)
		for i := 0; i < o.PCs; i++ {
			w := o.Workplace(i)
			workplaces = append(workplaces, workplaceInfo{Level: w.Level, Wear: w.Wear, Dead: w.Dead, NextPrice: g.NextPCLevelPrice(oi, i)})
		}
		offices[oi] = officeInfo{
			Unlocked: o.Unlocked, Price: price, PCs: o.PCs, NextPC: g.NextPCPrice(oi), Workplaces: workplaces,
			RouterTier: o.RouterTier, Ports: o.Ports(cfg),
			NextRouter: g.NextRouterPrice(oi), NextPorts: g.NextRouterPorts(oi),
			Servers: servers, ServerSlots: cfg.ServerSlotsPerOffice(),
			Boss: o.Boss, BossUnpaidToday: o.BossUnpaidToday,
			Admin: o.Admin, AdminUnpaidToday: o.AdminUnpaidToday, AdminSlot: adminSlot, AdminKind: adminKind,
			AdminFirePrice: adminFire, AdminShifts: adminShifts, AdminNextShift: nextAdminShift,
			Cooler: o.Cooler,
			Fridge: o.Fridge, CoffeeMachine: o.CoffeeMachine, Employees: employees,
			VirusPCs: g.OfficeInfected(oi),
		}
	}
	core := coreInfo{Level: g.CoreLevel, Connected: net.CoreUsed, Mult: 1.0}
	if g.CoreLevel > 0 {
		lvl := cfg.CoreLevels[g.CoreLevel-1]
		core.Capacity, core.Mult = lvl.Capacity, lvl.Mult
	}
	if g.CoreLevel < len(cfg.CoreLevels) {
		core.NextPrice = cfg.CoreLevels[g.CoreLevel].Price
	} else {
		core.Maxed = true
	}
	serverLevels := make([]serverLevelPrice, 0, len(cfg.ServerLevels))
	for _, l := range cfg.ServerLevels {
		serverLevels = append(serverLevels, serverLevelPrice{Mult: l.Mult, Price: l.Price})
	}
	coreLevels := make([]coreLevelPrice, 0, len(cfg.CoreLevels))
	for _, l := range cfg.CoreLevels {
		coreLevels = append(coreLevels, coreLevelPrice{Capacity: l.Capacity, Price: l.Price, Mult: l.Mult})
	}
	avTiers := make([]antivirusTierPrice, 0, len(cfg.AntivirusTiers))
	for _, t := range cfg.AntivirusTiers {
		avTiers = append(avTiers, antivirusTierPrice{Name: t.Name, Seats: t.Seats, Price: t.PricePerDay})
	}
	pcLevels := make([]pcLevelPrice, 0, len(cfg.PCLevels))
	for _, l := range cfg.PCLevels {
		pcLevels = append(pcLevels, pcLevelPrice{Name: l.Name, Mult: l.Mult, Price: l.Price})
	}
	av := antivirusInfo{Tier: g.AVTier, Name: g.AntivirusName(), Covered: g.AVCoveredCount(), BilledToday: g.AntivirusOpex()}
	if g.AVTier > 0 {
		av.Seats = cfg.AntivirusTiers[g.AVTier-1].Seats
	}
	var active *activeEventInfo
	if info := g.ActiveEventInfo(); info != nil {
		options := info.Options
		if options == nil {
			options = []string{}
		}
		active = &activeEventInfo{ID: info.ID, Title: info.Title, Text: info.Text, Options: options}
	}
	var directorLevels []directorCabinetLevelPrice
	for _, lvl := range cfg.DirectorCabinetLevels {
		directorLevels = append(directorLevels, directorCabinetLevelPrice{
			Name: lvl.Name, Bonus: lvl.Bonus, Price: lvl.Price,
		})
	}
	directorNextPrice := 0
	if g.DirectorCabinet < len(cfg.DirectorCabinetLevels) {
		directorNextPrice = cfg.DirectorCabinetLevels[g.DirectorCabinet].Price
	}
	return stateMessage{
		Type: "state", Money: g.Money, Offices: offices,
		Gateway: g.Gateway, AdminDept: g.AdminDept, Core: core, IncomePerTick: g.IncomePerTick(),
		Day: g.Day, Clock: g.Clock(), IsLunch: g.IsLunch(),
		TicksPerHour: cfg.TicksPerHour, PayrollPerDay: g.PayrollPerDay(),
		SalaryPerDay: cfg.SalaryPerDay, BossSalaryPerDay: cfg.BossSalaryPerDay, AdminSalaryPerDay: cfg.AdminSalaryPerDay,
		ForecastEndOfDay: g.ForecastEndOfDay(), StaffLimit: cfg.StaffLimit, PCWearLimit: cfg.PCWearLimit,
		OfficeSlots: cfg.OfficeSlots, Phase: string(g.Phase), Speed: speed,
		Resumed: resumed, Difficulty: string(cfg.Difficulty), WinTarget: cfg.WinTarget,
		WinStaff: cfg.WinStaff, WinCore: cfg.WinCore, WinDayLimit: cfg.WinDayLimit,
		MarketToday: g.MarketToday, MarketTomorrow: g.MarketTomorrow,
		CreditLimit: cfg.CreditLimit, CreditRatePct: int(cfg.CreditRate * 100), DebtLimit: g.DebtLimit(),
		BankruptInDays: g.BankruptInDays(), VirusWaveAt: g.VirusWaveClock(), Antivirus: av,
		ActionPoints: g.ActionPoints, ActionPointsMax: g.ActionPointsMax(),
		DirectorCabinet: g.DirectorCabinet, DirectorLevel: g.DirectorLevel(), DirectorExpBonus: g.DirectorExpBonus(),
		ActiveEvent: active, Seed: g.SeedString(), Scenario: scenario,
		// Копия, не nil: журнал партии растёт дальше, а снапшот уходит в сокет позже.
		DayLog:    append(make([]string, 0, len(g.EventLog)), g.EventLog...),
		TickInDay: g.TickInDay, DayIncome: g.DayIncome, DayProfit: g.DayProfit(),
		Prices: prices{PC: cfg.PCPrice, Hire: cfg.HirePrice,
			Boss: cfg.BossPrice, Admin: cfg.AdminPrice, AdminDept: cfg.AdminDeptPrice, Gateway: cfg.GatewayPrice, Cooler: cfg.CoolerPrice,
			Fridge: cfg.FridgePrice, CoffeeMachine: cfg.CoffeeMachinePrice, Repair: cfg.MasterCallPrice, PCLevels: pcLevels, PCReplace: g.PCReplacePrice(),
			ServerLevels: serverLevels, CoreLevels: coreLevels, AntivirusTiers: avTiers,
			DirectorCabinetNextPrice: directorNextPrice, DirectorCabinetLevels: directorLevels},
	}
}

// playerMetaPayload — слепок мета-статистики и ачивок игрока (ITGAME-132).
type playerMetaPayload struct {
	Stats        db.MetaStats                  `json:"stats"`
	Achievements map[string]db.AchievementState `json:"achievements"`
}

// metaMessage — сообщение клиенту со слепком мета-статистики (ITGAME-132).
type metaMessage struct {
	Type string            `json:"type"` // "meta"
	Meta playerMetaPayload `json:"meta"`
}

// achievementUnlockedMessage — уведомление об открытом достижении (ITGAME-132).
type achievementUnlockedMessage struct {
	Type       string `json:"type"` // "achievement_unlocked"
	ID         string `json:"id"`
	UnlockedAt int64  `json:"unlockedAt"` // epoch ms
}
