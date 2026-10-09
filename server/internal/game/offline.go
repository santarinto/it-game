package game

// Офлайн-прогресс (ITGAME-8): при восстановлении сессии пропущенные тики
// досимулируются сводной формулой — как ForecastEndOfDay, консервативно:
// без кофе-роллов, событий, поломок и XP; дебаффы жажды/голода и обед
// учитываются (они детерминированы тиком дня). Сломанные за день ПК
// чинятся ночим ИТ-шником — с полного дня работает как NextDay.

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
	// не чиним до ночи) — это и есть консервативная оценка.
	if remain := dayTicks - g.TickInDay; miss < remain {
		inc := g.sumIncome(g.TickInDay, g.TickInDay+miss)
		g.Money += inc
		g.DayIncome += inc
		g.TickInDay += miss
		s.Income, s.Balance = inc, g.Money
		if g.checkOfflineWin(s) {
			return s
		}
		return s
	}
	inc := g.sumIncome(g.TickInDay, dayTicks)
	expenses := g.PayrollPerDay()
	g.Money += inc - expenses
	g.DayIncome += inc
	g.PrevDayIncome = g.DayIncome
	s.Income, s.Payroll = inc, expenses
	s.Days++ // текущий день закрывается — для игрока это прошедший день
	miss -= dayTicks - g.TickInDay
	g.TickInDay = dayTicks
	if g.closeOfflineDay(s) {
		return s
	}

	// 2. Полные дни по шаблону: дневные сбросы (как NextDay), без событий
	// и кофе. Шаблон считается один раз — между днями офлайн ничего не меняется.
	// Рынок шаблона нейтрален (0%): роллов офлайн нет, качели не угадываем.
	tpl := g.offlineTemplate()
	tpl.MarketToday = 0
	dayInc := tpl.sumIncome(0, dayTicks)
	dayExp := tpl.PayrollPerDay()
	for miss >= dayTicks {
		g.Day++
		miss -= dayTicks
		g.Money += dayInc - dayExp
		s.Income += dayInc
		g.PrevDayIncome = dayInc
		s.Payroll += dayExp
		s.Days++
		if g.closeOfflineDay(s) {
			return s
		}
	}

	// 3. Частичный новый день: сброс дня без роллов (событий офлайн нет).
	g.resetForNextDay()
	g.Day++
	g.TickInDay = miss
	inc = g.sumIncome(0, miss)
	g.Money += inc
	g.DayIncome = inc
	s.Income += inc
	s.Balance = g.Money
	if g.checkOfflineWin(s) {
		return s
	}
	return s
}

// closeOfflineDay — закрытие дня офлайн: как closeDay, но без лога
// (отчёт «пока вас не было» показывает числа, не строки). true — финал.
// Победа проверяется раньше дедлайна — как в Tick: цель, достигнутая
// в последний день, сильнее таймера.
func (g *Game) closeOfflineDay(s *OfflineSummary) bool {
	if g.settleDebt() {
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

// sumIncome — доход за тики [lo, hi) по текущему состоянию (обед = 0).
func (g *Game) sumIncome(lo, hi int) int {
	total := 0
	for t := lo; t < hi; t++ {
		total += g.incomeAtTick(t)
	}
	return total
}

// offlineTemplate — копия игры с дневными сбросами: точка отсчёта дохода
// полного офлайн-дня (все оплачиваются, ПК целы, баффов нет).
func (g *Game) offlineTemplate() *Game {
	tpl := &Game{
		cfg: g.cfg, Money: g.Money, Offices: append([]Office(nil), g.Offices...),
		CoreLevel: g.CoreLevel, Gateway: g.Gateway, Phase: PhaseRunning,
		Day: g.Day + 1,
	}
	for i := range tpl.Offices {
		o := &tpl.Offices[i]
		for j := range o.Employees {
			o.Employees[j].UnpaidToday = false
			o.Employees[j].CoffeeUntil = 0
			o.Employees[j].MotivatedUntil = 0
			o.Employees[j].PCBroken = false
			o.Employees[j].OffendedUntil = 0
		}
		o.BossUnpaidToday = false
		o.VirusUntil = 0
	}
	return tpl
}

// resetForNextDay — дневные сбросы NextDay без роллов кофе и событий.
func (g *Game) resetForNextDay() {
	for i := range g.Offices {
		o := &g.Offices[i]
		for j := range o.Employees {
			o.Employees[j].UnpaidToday = false
			o.Employees[j].CoffeeUntil = 0
			o.Employees[j].MotivatedUntil = 0
			o.Employees[j].MotivateCooldownUntil = 0
			o.Employees[j].PCBroken = false
			o.Employees[j].RepairClicks = 0
			o.Employees[j].OffendedUntil = 0
		}
		o.BossUnpaidToday = false
		o.VirusUntil = 0
		o.CoffeeEventTicks = nil
	}
	g.DayIncome = 0
	g.DayEventMoney = 0
	g.DayIncidents = 0
	g.DayLostIncome = 0
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
