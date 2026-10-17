package game

import (
	"fmt"
	"math"
)

// Вирус (ITGAME-103): заражение мест, которое расползается по сети компании
// и само не проходит. Источник чисел и правил — GDD «Вирус (ITGAME-103)».
// Заражение живёт на занятом месте (Employee.Infected), как поломка; ПК без
// сотрудника не болеет. Роллы — из серверного PCG: журнал партии и реплей
// воспроизводят и вспышку, и волны.

// seat — место компании: офис и индекс сотрудника в нём.
type seat struct{ office, slot int }

// virusTarget — годится ли место в цель вспышки или волны: здоровое, с
// исправным ПК (сломанный ПК выключен — не заражается и не заражает) и не под
// подпиской на антивирус (ITGAME-137).
func virusTarget(e *Employee, covered bool) bool { return !covered && !e.Infected && !e.PCBroken }

// virusNeighbors — соседи места i по сетке офиса без диагоналей: по ряду
// и по колонке, только занятые места (n — штат офиса).
func (g *Game) virusNeighbors(i, n int) []int {
	cols := g.cfg.OfficeCols
	var out []int
	if i-cols >= 0 {
		out = append(out, i-cols)
	}
	if i%cols > 0 {
		out = append(out, i-1)
	}
	if (i+1)%cols > 0 && i+1 < n {
		out = append(out, i+1)
	}
	if i+cols < n {
		out = append(out, i+cols)
	}
	return out
}

// virusReach — досягаемость места: соседи по сетке ∪ (место на порту
// роутера) все подключённые места офиса ∪ (место в core) места core всех
// офисов. Серверные стойки не влияют. Порядок — офис → место, без дублей и
// без самого места: детерминизм ролла цели.
func (g *Game) virusReach(net NetworkState, oi, i int) []seat {
	o := &g.Offices[oi]
	in := make([][]bool, len(g.Offices))
	for k := range g.Offices {
		in[k] = make([]bool, len(g.Offices[k].Employees))
	}
	for _, j := range g.virusNeighbors(i, len(o.Employees)) {
		in[oi][j] = true
	}
	if conn := o.Connected(g.cfg); i < conn {
		for j := 0; j < conn; j++ {
			in[oi][j] = true
		}
	}
	if net.CoreLinked[oi][i] {
		for k := range g.Offices {
			for j, linked := range net.CoreLinked[k] {
				if linked {
					in[k][j] = true
				}
			}
		}
	}
	in[oi][i] = false
	var out []seat
	for k := range in {
		for j, ok := range in[k] {
			if ok {
				out = append(out, seat{k, j})
			}
		}
	}
	return out
}

// infect — заразить место: клики чистки с нуля, в счётчик дня.
func (g *Game) infect(e *Employee) {
	e.Infected = true
	e.VirusClicks = 0
	g.DayVirusPCs++
}

// officeInfected — сколько мест офиса заражено.
func (g *Game) officeInfected(oi int) int {
	n := 0
	for i := range g.Offices[oi].Employees {
		if g.Offices[oi].Employees[i].Infected {
			n++
		}
	}
	return n
}

// infectedCount — сколько мест компании заражено.
func (g *Game) infectedCount() int {
	n := 0
	for oi := range g.Offices {
		n += g.officeInfected(oi)
	}
	return n
}

// OfficeInfected — заражённые места офиса (для протокола: officeInfo.virusPCs).
func (g *Game) OfficeInfected(office int) int { return g.officeInfected(office) }

// seedOutbreak — вспышка в офисе oi: ⌈штат / VirusSeedStaff⌉ случайных
// годных мест. Таймер волны заводит только первая вспышка: вторая поверх
// живой добавляет места и таймер не трогает. Возвращает число заражённых.
func (g *Game) seedOutbreak(oi int) int {
	o := &g.Offices[oi]
	cov := g.AVCovered()
	var cands []int
	for i := range o.Employees {
		if virusTarget(&o.Employees[i], cov[oi][i]) {
			cands = append(cands, i)
		}
	}
	k := min(len(cands), int(math.Ceil(float64(len(o.Employees))/float64(g.cfg.VirusSeedStaff))))
	for n := 0; n < k; n++ {
		j := n + g.rng.IntN(len(cands)-n) // частичный Фишер–Йетс: k разных мест
		cands[n], cands[j] = cands[j], cands[n]
		g.infect(&o.Employees[cands[n]])
	}
	if k > 0 && g.VirusWaveIn == 0 {
		g.VirusWaveIn = g.cfg.VirusSpreadTicks
	}
	return k
}

// tickVirus — таймер волны: тикает тиками партии (в обед тоже), на нуле
// каждое заражённое место с исправным ПК заражает одно случайное годное
// место из своей досягаемости. Источники — снимок до волны (до удвоения за
// волну), цели проверяются вживую: два источника одно место не делят.
// Вызывается только из Tick: прогноз и офлайн-догон волн не знают.
func (g *Game) tickVirus() {
	if g.VirusWaveIn <= 0 {
		return
	}
	g.VirusWaveIn--
	if g.VirusWaveIn > 0 {
		return
	}
	var sources []seat
	for oi := range g.Offices {
		for i := range g.Offices[oi].Employees {
			if e := &g.Offices[oi].Employees[i]; e.Infected && !e.PCBroken {
				sources = append(sources, seat{oi, i})
			}
		}
	}
	net, cov := g.Network(), g.AVCovered()
	for _, s := range sources {
		var targets []seat
		for _, t := range g.virusReach(net, s.office, s.slot) {
			if virusTarget(&g.Offices[t.office].Employees[t.slot], cov[t.office][t.slot]) {
				targets = append(targets, t)
			}
		}
		if len(targets) == 0 {
			continue
		}
		t := targets[g.rng.IntN(len(targets))]
		g.infect(&g.Offices[t.office].Employees[t.slot])
	}
	if g.infectedCount() > 0 {
		g.VirusWaveIn = g.cfg.VirusSpreadTicks
	}
}

// cleaner — кто снял вирус с места: от него зависит строка журнала.
type cleaner int

const (
	cleanedSilent  cleaner = iota // увольнение заражённого, офлайн-догон: журнал молчит
	cleanedByHand                 // клик игрока
	cleanedByAdmin                // клик админа офиса (ITGAME-101)
)

// virusSettled — после чистки или увольнения заражённого: заражённых по
// компании нет — таймер волны стоит; офис висящей карточки вируса чист —
// карточка закрывается сама. Офис, ставший чистым от клика игрока или
// админа, пишет строку в журнал дня.
func (g *Game) virusSettled(oi int, by cleaner) {
	if g.infectedCount() == 0 {
		g.VirusWaveIn = 0
	}
	if g.officeInfected(oi) > 0 {
		return
	}
	switch by {
	case cleanedByHand:
		g.logEvent(fmt.Sprintf("вирус: офис %d вычищен вручную к %s", oi+1, g.Clock()))
	case cleanedByAdmin:
		g.logEvent(fmt.Sprintf("вирус: офис %d вычищен админом к %s", oi+1, g.Clock()))
	}
	if ev := g.ActiveEvent; ev != nil && ev.ID == EventVirus && ev.Office == oi && !ev.Repelled {
		ev.Resolved = true
		g.ActiveEvent = nil
	}
}

// virusClick — один клик чистки по месту: на cleanClicks-й место чисто
// (true). Только место: таймер, карточку и журнал оседает virusSettled.
// Один клик на всех, кто чистит: игрок, админ (ITGAME-101), потом ИБ (ITGAME-100).
func (e *Employee) virusClick(cleanClicks int) bool {
	e.VirusClicks++
	if e.VirusClicks < cleanClicks {
		return false
	}
	e.Infected = false
	e.VirusClicks = 0
	return true
}

// VirusClick — один клик чистки заражённого места: на VirusCleanClicks-й
// место чисто. Как ремонт, работает и на паузе.
func (g *Game) VirusClick(office, slot int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if slot < 0 || slot >= len(o.Employees) {
		return ErrBadSlot
	}
	e := &o.Employees[slot]
	if !e.Infected {
		return ErrNotInfected
	}
	if e.virusClick(g.cfg.VirusCleanClicks) {
		g.virusSettled(office, cleanedByHand)
	}
	return nil
}

// VirusWaveClock — «HH:MM», с которого видна следующая волна; "" — заражённых
// нет. Переход через ночь — время утра следующего дня.
func (g *Game) VirusWaveClock() string {
	if g.VirusWaveIn <= 0 {
		return ""
	}
	t := g.TickInDay + g.VirusWaveIn
	for day := g.cfg.DayTicks(); t > day; {
		t -= day
	}
	return g.ClockAt(t)
}

// logVirusEvening — строка журнала дня в конце дня: вирус сам не уходит.
func (g *Game) logVirusEvening() {
	if n := g.infectedCount(); n > 0 {
		g.logEvent(fmt.Sprintf("вирус: к вечеру заражено %d ПК — само не пройдёт", n))
	}
}
