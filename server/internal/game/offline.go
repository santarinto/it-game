package game

// Офлайн-прогресс (ITGAME-8): при восстановлении сессии пропущенные тики
// досимулируются сводной формулой — как ForecastEndOfDay, консервативно:
// без кофе-роллов, событий, поломок, волн вируса и XP; дебаффы жажды/голода
// и обед учитываются (они детерминированы тиком дня). Сломанные и
// заражённые места офиса без админа остаются такими во всех днях
// (ITGAME-136, ITGAME-103): ночь их не чинит, а роллов офлайн нет — уход из
// игры замораживает рост вируса, но не лечит. Админ (ITGAME-101) чинит и
// чистит свой офис по тикам догона тем же темпом, что вживую. Доход идёт в
// деньги с дробным остатком компании, как в Tick (ITGAME-196).

// OfflineSummary — итог офлайн-догона для отчёта «пока вас не было».
// Теги — для /api/debug/advance (ITGAME-26); offline_report собирает
// своё сообщение с теми же именами.
type OfflineSummary struct {
	Ticks    int    `json:"ticks"`    // пропущено тиков всего
	Days     int    `json:"days"`     // прошло полных дней
	Income   int    `json:"income"`   // заработано офлайн
	Payroll  int    `json:"payroll"`  // списано офлайн (ФОТ + опекс)
	Balance  int    `json:"balance"`  // итоговый баланс
	GameOver bool   `json:"gameOver"` // компания погибла офлайн
	Victory  bool   `json:"victory"`  // цель достигнута офлайн
	Reason   string `json:"reason"`   // причина финала (bankrupt | time_up | deadlock), Сложность 2.0
}

// loseOffline переводит игру и сводку офлайна в терминальное состояние поражения.
func (g *Game) loseOffline(s *OfflineSummary, reason string) {
	g.Phase = PhaseGameOver
	g.LoseReason = reason
	s.GameOver, s.Reason, s.Balance = true, reason, g.Money
}

// AdvanceOffline — досимулировать miss тиков вперёд. Меняет игру на месте;
// возвращает итог для отчёта. Вне фазы running — no-op (день ждёт игрока).
func (g *Game) AdvanceOffline(miss int) *OfflineSummary {
	s := &OfflineSummary{Balance: g.Money}
	if miss <= 0 || g.Phase != PhaseRunning {
		return s
	}
	s.Ticks = miss
	dayTicks := g.cfg.DayTicks()

	// 1. Хвост текущего дня: эффекты дня живут (кофе уже налит, поломки
	// чинят и вирус чистят только админы — ITGAME-101) — это и есть
	// консервативная оценка.
	if remain := dayTicks - g.TickInDay; miss < remain {
		inc := g.creditIncome(g.offlineIncome(g.TickInDay, g.TickInDay+miss))
		g.Money += inc
		g.DayIncome += inc
		g.Ledger.Income += inc
		g.TickInDay += miss
		s.Income, s.Balance = inc, g.Money
		if g.checkOfflineWin(s) {
			return s
		}
		return s
	}
	inc := g.creditIncome(g.offlineIncome(g.TickInDay, dayTicks))
	expenses := g.PayrollPerDay()
	g.Money += inc
	g.DayIncome += inc
	g.Ledger.Income += inc
	g.Ledger.Offline = true
	g.chargeDay(expenses, g.gatewayOpex(), g.antivirusOpex())
	g.PrevDayIncome = g.DayIncome
	s.Income, s.Payroll = inc, expenses
	s.Days++ // текущий день закрывается — для игрока это прошедший день
	miss -= dayTicks - g.TickInDay
	g.TickInDay = dayTicks
	if g.closeOfflineDay(s, expenses) {
		return s
	}

	// 2. Полные дни по шаблону: дневные сбросы (как NextDay), без событий
	// и кофе. Шаблон считается один раз — между днями офлайн ничего не
	// меняется, пока у админов есть очередь — пересобирается каждый день.
	// Рынок шаблона нейтрален (0%): роллов офлайн нет, качели не угадываем.
	tpl := g.offlineTemplate()
	tpl.MarketToday = 0
	dayExact := tpl.exactIncome(0, dayTicks, nil)
	dayExp := tpl.PayrollPerDay()
	dayOpex, dayAV := tpl.gatewayOpex(), tpl.antivirusOpex()
	for miss >= dayTicks {
		g.archiveLedger()
		g.Day++
		miss -= dayTicks
		g.TickInDay = 0
		g.beginLedger()
		g.TickInDay = dayTicks
		exact := dayExact
		// Админам есть что чинить и чистить (ITGAME-101): день считается по
		// тикам на шаблоне, его места переходят в живую игру, и шаблон
		// пересобирается. На дефолтном конфиге очередь пустеет за день
		// (15 + 12 × 3 кликов на офис против 2 × 54), с дельтой конфига —
		// за сколько выйдет.
		if tpl.adminsBusy() {
			exact = tpl.offlineIncome(0, dayTicks)
			g.adoptSeats(tpl)
			tpl = g.offlineTemplate()
			tpl.MarketToday = 0
			dayExact = tpl.exactIncome(0, dayTicks, nil)
		}
		inc := g.creditIncome(exact)
		g.Money += inc
		g.Ledger.Income += inc
		g.Ledger.Offline = true
		g.chargeDay(dayExp, dayOpex, dayAV)
		s.Income += inc
		g.PrevDayIncome = inc
		s.Payroll += dayExp
		s.Days++
		if g.closeOfflineDay(s, dayExp) {
			return s
		}
	}

	// 3. Частичный новый день: сброс дня без роллов (событий офлайн нет).
	g.archiveLedger()
	g.resetForNextDay()
	g.Day++
	g.TickInDay = 0
	g.beginLedger()
	g.TickInDay = miss
	inc = g.creditIncome(g.offlineIncome(0, miss))
	g.Money += inc
	g.DayIncome = inc
	g.Ledger.Income += inc
	s.Income += inc
	s.Balance = g.Money
	if g.checkOfflineWin(s) {
		return s
	}
	return s
}

// closeOfflineDay — закрытие дня офлайн: как closeDay, но без лога
// (отчёт «пока вас не было» показывает числа, не строки). true — финал.
// payroll — расходы, списанные этим вечером (порог овердрафта, ITGAME-156).
// Победа проверяется раньше дедлайна — как в Tick: цель, достигнутая
// в последний день, сильнее таймера.
func (g *Game) closeOfflineDay(s *OfflineSummary, payroll int) bool {
	if g.settleDebt(payroll) {
		g.loseOffline(s, LoseBankrupt)
		return true
	}
	if g.checkOfflineWin(s) {
		return true
	}
	if g.cfg.WinDayLimit > 0 && g.Day >= g.cfg.WinDayLimit {
		g.loseOffline(s, LoseTimeUp)
		return true
	}
	if g.IsDeadlocked() {
		g.loseOffline(s, LoseDeadlock)
		return true
	}
	s.Balance = g.Money
	return false
}

// exactIncome — точный доход за тики [lo, hi) по текущему состоянию (обед =
// 0). Общая сумма по тикам для офлайн-движка и прогноза банкротства:
// офлайн-догон переводит её в деньги с остатком компании (creditIncome,
// ITGAME-196), прогноз банкротства (ITGAME-222) гоняет остаток на своей копии
// (carryIncome); прогноз конца дня (ForecastEndOfDay) ведёт свой цикл. step — действие
// перед доходом каждого тика (работа админов офлайн-догона), nil — без него.
func (g *Game) exactIncome(lo, hi int, step func()) float64 {
	total := 0.0
	for t := lo; t < hi; t++ {
		if step != nil {
			step()
		}
		exact, _, _ := g.incomeAtTickDetail(t)
		total += exact
	}
	return total
}

// offlineTemplate — копия игры с дневными сбросами: точка отсчёта дохода
// полного офлайн-дня (все оплачиваются, баффов нет). Сломанные ПК остаются
// сломанными, заражённые — заражёнными: ночь их не чинит (ITGAME-136,
// ITGAME-103); в офисе с админом их дочищает AdvanceOffline (ITGAME-101).
func (g *Game) offlineTemplate() *Game {
	tpl := &Game{
		cfg: g.cfg, Money: g.Money, Offices: append([]Office(nil), g.Offices...),
		CoreLevel: g.CoreLevel, Gateway: g.Gateway, Phase: PhaseRunning,
		Day: g.Day + 1,
		// Полный день платит за тариф, включённый сейчас (ITGAME-137).
		AVTier: g.AVTier, AVTierBilled: g.AVTier,
	}
	for i := range tpl.Offices {
		o := &tpl.Offices[i]
		// Свой массив сотрудников (и мест, ITGAME-135): сбросы ниже не должны
		// писать в живую игру.
		o.Employees = append([]Employee(nil), o.Employees...)
		o.Workplaces = append([]Workplace(nil), o.Workplaces...)
		for j := range o.Employees {
			o.Employees[j].UnpaidToday = false
			o.Employees[j].CoffeeUntil = 0
			o.Employees[j].MotivatedUntil = 0
			o.Employees[j].OffendedUntil = 0
		}
		o.BossUnpaidToday = false
		o.AdminUnpaidToday = false
	}
	return tpl
}

// resetForNextDay — дневные сбросы NextDay без роллов кофе и событий.
// Поломки и вирус не трогает, как и NextDay (ITGAME-136, ITGAME-103).
func (g *Game) resetForNextDay() {
	for i := range g.Offices {
		o := &g.Offices[i]
		for j := range o.Employees {
			o.Employees[j].UnpaidToday = false
			o.Employees[j].CoffeeUntil = 0
			o.Employees[j].MotivatedUntil = 0
			o.Employees[j].MotivateCooldownUntil = 0
			o.Employees[j].OffendedUntil = 0
		}
		o.BossUnpaidToday = false
		o.AdminUnpaidToday = false
		o.CoffeeEventTicks = nil
	}
	g.DayIncome = 0
	g.DayEventMoney = 0
	g.DayIncidents = 0
	g.DayLostIncome = 0
	g.DayVirusPCs = 0
	g.DayVirusLost = 0
	g.DayAdminRepairs = 0
	g.DayAdminCleaned = 0
	g.AVTierBilled = g.AVTier
	g.DayEvents = nil
	g.ActiveEvent = nil
	g.EventLog = nil
	g.DeadlineOn, g.DeadlineGot, g.DeadlineGoal = false, 0, 0
	// Рынок сдвигается как в NextDay: сегодня — вчерашний «завтра».
	g.MarketToday, g.MarketTomorrow = g.MarketTomorrow, g.rollMarket()
}

// checkOfflineWin — победа офлайн (комбо-цель учитывается целиком);
// true, если игра закончилась.
func (g *Game) checkOfflineWin(s *OfflineSummary) bool {
	if g.won() {
		g.Phase = PhaseWon
		s.Victory, s.Balance = true, g.Money
		return true
	}
	s.Balance = g.Money
	return false
}
