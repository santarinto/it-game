package game

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// Вирус (ITGAME-103): GDD «Вирус (ITGAME-103)». Сетка мест 4 × 3, соседи
// без диагоналей; вспышка ⌈штат/4⌉; волна раз в 18 тиков — каждый
// заражённый заражает одно годное место из своей досягаемости; −30%
// выработки места; 3 клика чистят; само не проходит.

// virusGame — офис 1 со штатом n по $10/тик, кулер и холодильник куплены
// (без жажды и голода), поломок и событий нет: арифметика вируса в чистом виде.
func virusGame(n int) *Game {
	cfg := DefaultConfig()
	cfg.BreakdownChancePermille = 0
	cfg.EventChancePct = 0
	g := NewWithSeed(cfg, 7, 8)
	g.Money = 10000
	o := &g.Offices[0]
	o.PCs = n
	o.Employees = testStaff(n)
	o.Cooler, o.Fridge = true, true
	return g
}

// infectedSlots — индексы заражённых мест офиса.
func infectedSlots(g *Game, oi int) []int {
	var out []int
	for i := range g.Offices[oi].Employees {
		if g.Offices[oi].Employees[i].Infected {
			out = append(out, i)
		}
	}
	return out
}

// slotsOf — места офиса oi из досягаемости.
func slotsOf(reach []seat, oi int) []int {
	var out []int
	for _, s := range reach {
		if s.office == oi {
			out = append(out, s.slot)
		}
	}
	return out
}

func TestVirusNeighborsGrid(t *testing.T) {
	g := virusGame(12)
	cases := []struct {
		i, n int
		want []int
	}{
		{0, 12, []int{1, 4}},       // место 1 — угол: 2 и 5
		{5, 12, []int{1, 4, 6, 9}}, // место 6 — середина: 2, 5, 7, 10
		{3, 12, []int{2, 7}},       // место 4 — угол ряда, перехода на ряд 2 нет
		{4, 12, []int{0, 5, 8}},    // место 5 — край: 1, 6, 9
		{11, 12, []int{7, 10}},     // место 12 — нижний угол
		{5, 6, []int{1, 4}},        // штат 6: мест 7 и 10 нет — пустые не в счёт
		{3, 6, []int{2}},           // штат 6: место 4 без места 8 под ним
		{0, 1, nil},                // один сотрудник — соседей нет
	}
	for _, c := range cases {
		if got := g.virusNeighbors(c.i, c.n); !slices.Equal(got, c.want) {
			t.Errorf("соседи места %d при штате %d: %v, хотим %v", c.i+1, c.n, got, c.want)
		}
	}
}

func TestVirusFireShiftsSeat(t *testing.T) {
	g := virusGame(6)
	g.infect(&g.Offices[0].Employees[5])
	g.VirusWaveIn = g.cfg.VirusSpreadTicks
	if err := g.Fire(0, 0); err != nil {
		t.Fatal(err)
	}
	// Увольнение сдвигает следующих на место назад: заражённый с места 6 —
	// теперь на месте 5, и соседи его — соседи места 5.
	if got := infectedSlots(g, 0); !slices.Equal(got, []int{4}) {
		t.Fatalf("заражённые после увольнения: %v, хотим [4]", got)
	}
	if got := slotsOf(g.virusReach(g.Network(), 0, 4), 0); !slices.Equal(got, []int{0}) {
		t.Errorf("досягаемость места 5 при штате 5: %v, хотим [0]", got)
	}
	if g.VirusWaveIn != g.cfg.VirusSpreadTicks {
		t.Errorf("уволен здоровый — таймер волны %d, хотим %d", g.VirusWaveIn, g.cfg.VirusSpreadTicks)
	}
}

func TestVirusReachChannels(t *testing.T) {
	// Без роутера — только соседи.
	g := virusGame(9)
	if got := slotsOf(g.virusReach(g.Network(), 0, 0), 0); !slices.Equal(got, []int{1, 4}) {
		t.Errorf("без роутера место 1: %v, хотим [1 4]", got)
	}
	// Роутер т1: места 1–4 — одна сеть, 5+ — только соседи.
	g.Offices[0].RouterTier = 1
	if got := slotsOf(g.virusReach(g.Network(), 0, 0), 0); !slices.Equal(got, []int{1, 2, 3, 4}) {
		t.Errorf("роутер т1, место 1: %v, хотим [1 2 3 4]", got)
	}
	if got := slotsOf(g.virusReach(g.Network(), 0, 5), 0); !slices.Equal(got, []int{1, 4, 6}) {
		t.Errorf("роутер т1, место 6 (не в сети): %v, хотим [1 4 6]", got)
	}
	// Без core офисы не связаны.
	o2 := &g.Offices[1]
	o2.Unlocked, o2.PCs, o2.RouterTier, o2.Employees = true, 4, 1, testStaff(4)
	if got := slotsOf(g.virusReach(g.Network(), 0, 0), 1); got != nil {
		t.Errorf("без core место 1 офиса 1 достаёт офис 2: %v", got)
	}
	// Core ур.1 (ёмкость 8): места 1–4 обоих офисов — одна сеть компании.
	g.CoreLevel = 1
	net := g.Network()
	if got := slotsOf(g.virusReach(net, 0, 0), 1); !slices.Equal(got, []int{0, 1, 2, 3}) {
		t.Errorf("core: место 1 офиса 1 в офисе 2 достаёт %v, хотим [0 1 2 3]", got)
	}
	if got := slotsOf(g.virusReach(net, 0, 5), 1); got != nil {
		t.Errorf("core: место 6 офиса 1 вне сети, а достаёт офис 2: %v", got)
	}
	// Серверные стойки на заражение не влияют.
	before := g.virusReach(net, 0, 0)
	g.Offices[0].Servers = []int{1, 1}
	if after := g.virusReach(g.Network(), 0, 0); !slices.Equal(before, after) {
		t.Errorf("стойки поменяли досягаемость: %v → %v", before, after)
	}
	// Ёмкость core кончилась на офисе 1: места офиса 2 до core не дошли —
	// компанию не достают и из компании недосягаемы.
	g.Offices[0].RouterTier = 2 // 9 портов, офис 1 занимает все 8 мест core
	net = g.Network()
	if got := slotsOf(g.virusReach(net, 1, 0), 0); got != nil {
		t.Errorf("место офиса 2 без core достаёт офис 1: %v", got)
	}
	if got := slotsOf(g.virusReach(net, 0, 0), 1); got != nil {
		t.Errorf("офис 1 достаёт места офиса 2 вне core: %v", got)
	}
	if got := slotsOf(g.virusReach(net, 1, 0), 1); !slices.Equal(got, []int{1, 2, 3}) {
		t.Errorf("место 1 офиса 2: в своей сети %v, хотим [1 2 3]", got)
	}
}

func TestVirusOutbreakSize(t *testing.T) {
	for _, c := range []struct{ staff, want int }{{1, 1}, {4, 1}, {5, 2}, {8, 2}, {9, 3}, {12, 3}} {
		g := virusGame(c.staff)
		if k := g.seedOutbreak(0); k != c.want || len(infectedSlots(g, 0)) != c.want {
			t.Errorf("штат %d: вспышка %d мест (заражено %v), хотим %d", c.staff, k, infectedSlots(g, 0), c.want)
		}
		if g.VirusWaveIn != g.cfg.VirusSpreadTicks || g.DayVirusPCs != c.want {
			t.Errorf("штат %d: таймер %d, новых за день %d", c.staff, g.VirusWaveIn, g.DayVirusPCs)
		}
	}
	// Только исправные: три ПК из четырёх сломаны — вспышка садится на четвёртый.
	g := virusGame(4)
	for i := 0; i < 3; i++ {
		g.Offices[0].Employees[i].PCBroken = true
	}
	if g.seedOutbreak(0); !slices.Equal(infectedSlots(g, 0), []int{3}) {
		t.Errorf("вспышка села не на исправный ПК: %v", infectedSlots(g, 0))
	}
	// Целей нет — никого, таймер стоит.
	g = virusGame(2)
	g.Offices[0].Employees[0].PCBroken = true
	g.Offices[0].Employees[1].PCBroken = true
	if k := g.seedOutbreak(0); k != 0 || g.VirusWaveIn != 0 {
		t.Errorf("все ПК сломаны: вспышка %d, таймер %d", k, g.VirusWaveIn)
	}
}

func TestVirusSecondOutbreakKeepsTimer(t *testing.T) {
	g := virusGame(9)
	g.infect(&g.Offices[0].Employees[0])
	g.VirusWaveIn = 5
	if k := g.seedOutbreak(0); k == 0 {
		t.Fatal("вторая вспышка никого не заразила")
	}
	if g.VirusWaveIn != 5 {
		t.Errorf("вторая вспышка поверх живой сдвинула таймер: %d, хотим 5", g.VirusWaveIn)
	}
}

func TestVirusWaveEvery18Ticks(t *testing.T) {
	g := virusGame(9)
	g.infect(&g.Offices[0].Employees[0])
	g.VirusWaveIn = g.cfg.VirusSpreadTicks
	for i := 1; i < g.cfg.VirusSpreadTicks; i++ {
		g.Tick()
		if n := len(infectedSlots(g, 0)); n != 1 {
			t.Fatalf("тик %d: заражено %d до волны", i, n)
		}
	}
	g.Tick()
	got := infectedSlots(g, 0)
	if len(got) != 2 || !slices.Contains([]int{1, 4}, got[1]) {
		t.Fatalf("первая волна: заражены %v, хотим место 1 и одного его соседа (2 или 5)", got)
	}
	if g.VirusWaveIn != g.cfg.VirusSpreadTicks {
		t.Errorf("после волны таймер %d, хотим %d", g.VirusWaveIn, g.cfg.VirusSpreadTicks)
	}
	for i := 0; i < g.cfg.VirusSpreadTicks; i++ {
		g.Tick()
	}
	if n := len(infectedSlots(g, 0)); n < 3 || n > 4 {
		t.Errorf("вторая волна: заражено %d, хотим 3–4 (до удвоения)", n)
	}
}

func TestVirusWaveDuringLunch(t *testing.T) {
	g := virusGame(4)
	g.infect(&g.Offices[0].Employees[0])
	g.TickInDay = g.cfg.lunchStartTick()
	g.VirusWaveIn = 1
	if r := g.Tick(); r != nil || g.IncomePerTick() != 0 {
		t.Fatal("тест должен идти в обед")
	}
	if n := len(infectedSlots(g, 0)); n != 2 {
		t.Errorf("волна в обед: заражено %d, хотим 2 — волны идут и в обед", n)
	}
}

func TestVirusTimerSurvivesNight(t *testing.T) {
	g := virusGame(4)
	g.infect(&g.Offices[0].Employees[0])
	g.Offices[0].Employees[0].VirusClicks = 2
	g.TickInDay = g.cfg.DayTicks() - 5
	g.VirusWaveIn = g.cfg.VirusSpreadTicks
	r := finishDay(t, g)
	if g.VirusWaveIn != g.cfg.VirusSpreadTicks-5 {
		t.Fatalf("к вечеру таймер %d, хотим %d", g.VirusWaveIn, g.cfg.VirusSpreadTicks-5)
	}
	if !strings.Contains(strings.Join(r.Events, "; "), "к вечеру заражено 1 ПК") {
		t.Errorf("журнал дня без вечерней строки вируса: %v", r.Events)
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	e := g.Offices[0].Employees[0]
	if !e.Infected || e.VirusClicks != 2 || g.VirusWaveIn != g.cfg.VirusSpreadTicks-5 {
		t.Fatalf("ночь: infected=%v clicks=%d таймер %d — вирус и таймер обязаны пережить ночь",
			e.Infected, e.VirusClicks, g.VirusWaveIn)
	}
	if g.DayVirusPCs != 0 || g.DayVirusLost != 0 {
		t.Errorf("новый день: счётчики вируса %d/%d, хотим 0/0", g.DayVirusPCs, g.DayVirusLost)
	}
	if g.VirusWaveClock() != g.ClockAt(g.cfg.VirusSpreadTicks-5) {
		t.Errorf("волна в %q, хотим %q", g.VirusWaveClock(), g.ClockAt(g.cfg.VirusSpreadTicks-5))
	}
	for i := 0; i < g.cfg.VirusSpreadTicks-5; i++ {
		g.Tick()
	}
	if n := len(infectedSlots(g, 0)); n != 2 {
		t.Errorf("волна после ночи: заражено %d, хотим 2", n)
	}
}

func TestVirusWaveClock(t *testing.T) {
	g := virusGame(4)
	if g.VirusWaveClock() != "" {
		t.Fatalf("без заражённых волна в %q", g.VirusWaveClock())
	}
	g.TickInDay, g.VirusWaveIn = 6, 6 // 11:00, волна видна с 12:00
	if got := g.VirusWaveClock(); got != "12:00" {
		t.Errorf("волна в %q, хотим 12:00", got)
	}
	g.TickInDay, g.VirusWaveIn = 50, 18 // 18:20: 40 минут до 19:00, остальные 2:20 — с 10:00 завтра
	if got := g.VirusWaveClock(); got != "12:20" {
		t.Errorf("волна через ночь в %q, хотим 12:20", got)
	}
}

func TestVirusStopsWhenClean(t *testing.T) {
	g := virusGame(4)
	g.infect(&g.Offices[0].Employees[0])
	g.VirusWaveIn = 3
	for k := 0; k < g.cfg.VirusCleanClicks; k++ {
		if err := g.VirusClick(0, 0); err != nil {
			t.Fatal(err)
		}
	}
	if g.VirusWaveIn != 0 || g.VirusWaveClock() != "" {
		t.Fatalf("всё вычищено, а таймер %d", g.VirusWaveIn)
	}
	for i := 0; i < 2*g.cfg.VirusSpreadTicks; i++ {
		g.Tick()
	}
	if n := len(infectedSlots(g, 0)); n != 0 {
		t.Errorf("вычищенный вирус вернулся: %d", n)
	}
}

func TestVirusBrokenSeatNeitherTargetNorSource(t *testing.T) {
	// Сломанное место не цель: единственный сосед сломан — волне некуда.
	g := virusGame(2)
	g.infect(&g.Offices[0].Employees[0])
	g.Offices[0].Employees[1].PCBroken = true
	g.VirusWaveIn = 1
	g.Tick()
	if g.Offices[0].Employees[1].Infected {
		t.Error("волна заразила сломанный ПК")
	}
	// Сломанное заражённое не источник.
	g = virusGame(2)
	g.infect(&g.Offices[0].Employees[0])
	g.Offices[0].Employees[0].PCBroken = true
	g.Offices[0].Employees[0].RepairNeeded = 3
	g.VirusWaveIn = 1
	g.Tick()
	if g.Offices[0].Employees[1].Infected {
		t.Error("сломанный заражённый ПК заразил соседа")
	}
	// Ремонт вирус не снимает.
	for k := 0; k < 3; k++ {
		if err := g.RepairClick(0, 0); err != nil {
			t.Fatal(err)
		}
	}
	if e := g.Offices[0].Employees[0]; e.PCBroken || !e.Infected {
		t.Errorf("после ремонта: broken=%v infected=%v, хотим false/true", e.PCBroken, e.Infected)
	}
	// Поломка вирус не трогает: rollBreakdowns флаг заражения не снимает.
	g = virusGame(1)
	g.cfg.BreakdownChancePermille = 1000
	g.infect(&g.Offices[0].Employees[0])
	g.rollBreakdowns()
	if e := g.Offices[0].Employees[0]; !e.PCBroken || !e.Infected {
		t.Errorf("поломка заражённого: broken=%v infected=%v, хотим true/true", e.PCBroken, e.Infected)
	}
}

func TestVirusTwoSourcesDoNotShareTarget(t *testing.T) {
	g := virusGame(3) // места 1-2-3 в ряд: у 1 и 3 одна цель — место 2
	g.infect(&g.Offices[0].Employees[0])
	g.infect(&g.Offices[0].Employees[2])
	g.VirusWaveIn = 1
	g.Tick()
	if got := infectedSlots(g, 0); !slices.Equal(got, []int{0, 1, 2}) {
		t.Errorf("заражены %v, хотим все три", got)
	}
	if g.DayVirusPCs != 3 {
		t.Errorf("новых за день %d, хотим 3 (2 руками + 1 волной)", g.DayVirusPCs)
	}
}

func TestVirusIncomeAndLost(t *testing.T) {
	g := virusGame(2)
	g.infect(&g.Offices[0].Employees[0])
	if inc := g.IncomePerTick(); inc != 7+10 {
		t.Errorf("доход тика %d, хотим 17 (заражённое место −30%%)", inc)
	}
	if inc, lost, vlost := g.incomeAtTickDetail(0); inc != 17 || lost != 0 || vlost != 3 {
		t.Errorf("тик: доход %v, поломки %d, вирус %d — хотим 17/0/3", inc, lost, vlost)
	}
	o := &g.Offices[0]
	if got := g.EffectiveIncomePerTick(o, 0); got != 7 {
		t.Errorf("тултип: выработка %d, хотим 7", got)
	}
	effects := g.Effects(o, &o.Employees[0])
	if !slices.Contains(effects, Effect{Token: EffectVirus, Percent: -30, Until: -1}) {
		t.Errorf("эффекта «вирус −30%%» нет: %+v", effects)
	}
	// Сломанное заражённое — упущенное целиком в поломке.
	o.Employees[0].PCBroken = true
	if inc, lost, vlost := g.incomeAtTickDetail(0); inc != 10 || lost != 7 || vlost != 0 {
		t.Errorf("сломанное заражённое: доход %v, поломки %d, вирус %d — хотим 10/7/0", inc, lost, vlost)
	}
	o.Employees[0].PCBroken = false
	r := finishDay(t, g)
	if r.VirusPCs != 1 || r.VirusLost != 48*3 {
		t.Errorf("отчёт: вирус %d ПК (−$%d), хотим 1 ПК (−$%d)", r.VirusPCs, r.VirusLost, 48*3)
	}
	// Опыт идёт: заражённое место работает.
	if o.Employees[0].XP != o.Employees[1].XP {
		t.Errorf("опыт заражённого %d, здорового %d — вирус опыт не режет", o.Employees[0].XP, o.Employees[1].XP)
	}
}

func TestVirusClick(t *testing.T) {
	g := virusGame(2)
	g.infect(&g.Offices[0].Employees[0])
	g.VirusWaveIn = 9
	for _, c := range []struct {
		office, slot int
		want         error
	}{{0, 1, ErrNotInfected}, {0, 2, ErrBadSlot}, {0, -1, ErrBadSlot}, {1, 0, ErrOfficeLocked}, {5, 0, ErrBadOffice}} {
		if err := g.Apply(CmdVirusClick, c.office, c.slot); err != c.want {
			t.Errorf("virus_click %d/%d: %v, хотим %v", c.office, c.slot, err, c.want)
		}
	}
	for k := 1; k < g.cfg.VirusCleanClicks; k++ {
		if err := g.Apply(CmdVirusClick, 0, 0); err != nil {
			t.Fatal(err)
		}
		if e := g.Offices[0].Employees[0]; !e.Infected || e.VirusClicks != k {
			t.Fatalf("клик %d: infected=%v clicks=%d", k, e.Infected, e.VirusClicks)
		}
	}
	if err := g.Apply(CmdVirusClick, 0, 0); err != nil {
		t.Fatal(err)
	}
	if e := g.Offices[0].Employees[0]; e.Infected || e.VirusClicks != 0 {
		t.Errorf("после %d кликов: infected=%v clicks=%d", g.cfg.VirusCleanClicks, e.Infected, e.VirusClicks)
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "офис 1 вычищен вручную к") {
		t.Errorf("журнал без чистки: %v", g.EventLog)
	}
}

func TestVirusCardFlow(t *testing.T) {
	g := virusGame(4)
	forceEvent(g, EventVirus)
	g.Tick()
	if g.ActiveEvent == nil || g.ActiveEvent.ID != EventVirus {
		t.Fatalf("карточка вируса не висит: %+v", g.ActiveEvent)
	}
	// Вспышка тика активации заводит таймер с полного интервала.
	if n := len(infectedSlots(g, 0)); n != 1 || g.VirusWaveIn != g.cfg.VirusSpreadTicks {
		t.Fatalf("вспышка: заражено %d, таймер %d", n, g.VirusWaveIn)
	}
	info := g.ActiveEventInfo()
	if info.Title != "Вирус в сети" || !slices.Equal(info.Options, []string{"Чистить вручную", "Подписка SOHO Edition $12/день"}) ||
		!strings.Contains(info.Text, "заражено 1 ПК") || !strings.Contains(info.Text, "3 клика") {
		t.Fatalf("карточка: %+v", info)
	}
	if err := g.ChooseEvent(2); err != ErrBadOption {
		t.Errorf("опция 2: %v, хотим %v", err, ErrBadOption)
	}
	// Всё вычищено до ответа — карточка закрывается сама.
	slot := infectedSlots(g, 0)[0]
	for k := 0; k < g.cfg.VirusCleanClicks; k++ {
		if err := g.VirusClick(0, slot); err != nil {
			t.Fatal(err)
		}
	}
	if g.ActiveEvent != nil || !g.DayEvents[0].Resolved {
		t.Fatal("офис вычищен, а карточка висит")
	}

	// «Чистить вручную» закрывает карточку, вирус остаётся.
	g = virusGame(4)
	forceEvent(g, EventVirus)
	g.Tick()
	if err := g.ChooseEvent(0); err != nil {
		t.Fatal(err)
	}
	if g.ActiveEvent != nil || len(infectedSlots(g, 0)) != 1 {
		t.Fatalf("«Чистить вручную»: карточка %v, заражено %v", g.ActiveEvent, infectedSlots(g, 0))
	}
	joined := strings.Join(g.EventLog, "; ")
	if !strings.Contains(joined, "вирус в офисе 1: 1 ПК") || !strings.Contains(joined, "чистим вручную") {
		t.Errorf("журнал: %v", g.EventLog)
	}
}

func TestVirusCardRepelled(t *testing.T) {
	g := virusGame(2)
	g.Offices[0].Employees[0].PCBroken = true
	g.Offices[0].Employees[1].PCBroken = true
	forceEvent(g, EventVirus)
	g.Tick()
	if g.ActiveEvent == nil || !g.ActiveEvent.Repelled || g.infectedCount() != 0 || g.VirusWaveIn != 0 {
		t.Fatalf("целей нет: карточка %+v, заражено %d, таймер %d", g.ActiveEvent, g.infectedCount(), g.VirusWaveIn)
	}
	if info := g.ActiveEventInfo(); info.Title != "Вирус отбит" || !slices.Equal(info.Options, []string{"Принять к сведению"}) {
		t.Fatalf("карточка «отбит»: %+v", info)
	}
	if err := g.ChooseEvent(0); err != nil || g.ActiveEvent != nil {
		t.Fatalf("«Принять к сведению»: %v, карточка %v", err, g.ActiveEvent)
	}
	if !strings.Contains(strings.Join(g.EventLog, "; "), "вирус в офисе 1 отбит") {
		t.Errorf("журнал: %v", g.EventLog)
	}
}

func TestVirusFireLastInfected(t *testing.T) {
	g := virusGame(4)
	forceEvent(g, EventVirus)
	g.Tick()
	slot := infectedSlots(g, 0)[0]
	if err := g.Fire(0, slot); err != nil {
		t.Fatal(err)
	}
	if g.infectedCount() != 0 || g.VirusWaveIn != 0 {
		t.Errorf("уволен последний заражённый: заражено %d, таймер %d", g.infectedCount(), g.VirusWaveIn)
	}
	if g.ActiveEvent != nil {
		t.Error("в офисе вспышки не осталось заражённых, а карточка висит")
	}
	if strings.Contains(strings.Join(g.EventLog, "; "), "вычищен") {
		t.Errorf("увольнение записано как чистка: %v", g.EventLog)
	}
}

func TestVirusOfflineKeepsInfectionNoWaves(t *testing.T) {
	cfg := offlineTestConfig()
	g := NewWithSeed(cfg, 1, 2)
	o := &g.Offices[0]
	o.PCs, o.Employees = 2, testStaff(2)
	g.infect(&o.Employees[0])
	o.Employees[0].VirusClicks = 1
	g.VirusWaveIn = 5
	s := g.AdvanceOffline(2*cfg.DayTicks() + 6)
	// $7 + $10 за продуктивный тик: два полных дня по 48 и утро нового — 6.
	if want := (48 + 48 + 6) * 17; s.Income != want {
		t.Errorf("офлайн-доход %d, хотим %d — заражённое место −30%% во всех днях", s.Income, want)
	}
	if e := o.Employees[0]; !e.Infected || e.VirusClicks != 1 || o.Employees[1].Infected {
		t.Errorf("после офлайна: место 1 infected=%v clicks=%d, место 2 infected=%v", e.Infected, e.VirusClicks, o.Employees[1].Infected)
	}
	if g.VirusWaveIn != 5 {
		t.Errorf("офлайн тронул таймер волны: %d, хотим 5 — волн офлайн нет", g.VirusWaveIn)
	}
}

func TestForecastKeepsInfection(t *testing.T) {
	g := virusGame(2)
	g.infect(&g.Offices[0].Employees[0])
	g.VirusWaveIn = 1 // живая игра заразит соседа следующим тиком
	// Прогноз держит заражённое место заражённым до вечера и волн не предсказывает.
	if got, want := g.ForecastEndOfDay(), g.Money+48*17-g.PayrollPerDay(); got != want {
		t.Errorf("прогноз %d, хотим %d", got, want)
	}
}

func TestBankruptInDaysInfectedCountAsCleaned(t *testing.T) {
	g := doomedGame(t, DiffHard)
	o := &g.Offices[0]
	o.Boss = ""
	o.PCs = 3
	g.Money = -100
	o.Employees = []Employee{
		{Name: "Артём Никитин", IncomePerTick: 9, HireDay: 1, Infected: true},
		{Name: "Мария Фёдорова", IncomePerTick: 9, HireDay: 1, Infected: true},
		{Name: "Дмитрий Смирнов", IncomePerTick: 9, HireDay: 1, Infected: true},
	}
	// Заражённым штат ФОТ не тянет — без чистки это был бы долг навсегда.
	tpl := g.offlineTemplate()
	if inc := int(math.Round(tpl.exactIncome(0, g.cfg.DayTicks(), nil))); inc >= g.PayrollPerDay() {
		t.Fatalf("тест не держит развилку: доход заражённого штата %d ≥ ФОТ %d", inc, g.PayrollPerDay())
	}
	// Чистка — три бесплатных клика, не тупик (как ремонт, ITGAME-136).
	if got := g.BankruptInDays(); got != 0 {
		t.Fatalf("заражённые места чистятся бесплатно — сигнала нет, получили %d", got)
	}
	for i := range o.Employees {
		if !o.Employees[i].Infected {
			t.Fatal("прогноз обречённости вычистил вирус в живой игре")
		}
	}
}

func TestVirusSaveRoundtrip(t *testing.T) {
	g := virusGame(4)
	forceEvent(g, EventVirus)
	g.Tick()
	g.Offices[0].Employees[infectedSlots(g, 0)[0]].VirusClicks = 2
	g.DayVirusLost = 40
	r := saveRoundtrip(t, g)
	if !slices.Equal(infectedSlots(r, 0), infectedSlots(g, 0)) || r.VirusWaveIn != g.VirusWaveIn ||
		r.DayVirusPCs != g.DayVirusPCs || r.DayVirusLost != 40 {
		t.Fatalf("после сейва: заражены %v (было %v), таймер %d/%d, счётчики %d/%d",
			infectedSlots(r, 0), infectedSlots(g, 0), r.VirusWaveIn, g.VirusWaveIn, r.DayVirusPCs, r.DayVirusLost)
	}
	if e := r.Offices[0].Employees[infectedSlots(r, 0)[0]]; e.VirusClicks != 2 {
		t.Errorf("клики чистки после сейва %d, хотим 2", e.VirusClicks)
	}
	if r.ActiveEvent == nil || r.ActiveEvent.ID != EventVirus {
		t.Error("карточка вируса не пережила сейв")
	}
}

// Сейв до ITGAME-103 не читается: без поля format (или с format 0) —
// ErrBadSave, без миграции (решение владельца 16.10).
func TestRestoreRejectsSaveBeforeVirus(t *testing.T) {
	s := virusGame(2).Export()
	if s.Format != SaveFormat {
		t.Fatalf("Export пишет формат %d, хотим %d", s.Format, SaveFormat)
	}
	raw, _ := json.Marshal(s)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	delete(m, "format")
	raw, _ = json.Marshal(m)
	var old Save
	if err := json.Unmarshal(raw, &old); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(old); !errors.Is(err, ErrBadSave) {
		t.Fatalf("сейв без format: %v, хотим %v", err, ErrBadSave)
	}
}

// Сейв новее сервера тоже не читается (ITGAME-169): формат решает в обе стороны, миграций нет.
func TestRestoreRejectsNewerFormat(t *testing.T) {
	s := virusGame(2).Export()
	s.Format = SaveFormat + 1
	if _, err := Restore(s); !errors.Is(err, ErrBadSave) {
		t.Fatalf("сейв формата %d: %v, хотим %v", s.Format, err, ErrBadSave)
	}
}

// Одинаковый сид — одинаковые цели вспышки и волн (реплей ITGAME-46).
func TestVirusDeterministicBySeed(t *testing.T) {
	run := func() [][]int {
		g := virusGame(12)
		g.Offices[0].RouterTier = 1
		forceEvent(g, EventVirus)
		var out [][]int
		for i := 0; i < 3*g.cfg.VirusSpreadTicks+1; i++ {
			g.Tick()
			if i%g.cfg.VirusSpreadTicks == 0 {
				out = append(out, infectedSlots(g, 0))
			}
		}
		return out
	}
	a, b := run(), run()
	if !slices.EqualFunc(a, b, slices.Equal[[]int]) {
		t.Fatalf("один сид — разные заражения:\n%v\n%v", a, b)
	}
	if len(a[len(a)-1]) <= len(a[0]) {
		t.Errorf("за три волны вирус не вырос: %v", a)
	}
}

// Сетка мест сервера и клиента — одна: соседи вируса считаются по
// Config.OfficeCols, а рисует места GRID.cols в OfficeScene.ts.
func TestOfficeColsMirrorsClientGrid(t *testing.T) {
	src, err := os.ReadFile("../../../client/src/scenes/OfficeScene.ts")
	if err != nil {
		t.Skipf("клиента рядом нет: %v", err)
	}
	m := regexp.MustCompile(`const GRID = \{ cols: (\d+),`).FindSubmatch(src)
	if m == nil {
		t.Fatal("OfficeScene.ts: не нашёл «const GRID = { cols: N,» — сверка сетки сломана")
	}
	if cols, _ := strconv.Atoi(string(m[1])); cols != DefaultConfig().OfficeCols {
		t.Fatalf("GRID.cols клиента %d, Config.OfficeCols %d — сетки разъехались", cols, DefaultConfig().OfficeCols)
	}
}

func TestVirusOutbreakFixture(t *testing.T) {
	cfg := DefaultConfig()
	cfg.BreakdownChancePermille = 0 // поломка источника до волны сменила бы счёт
	g, err := NewFixture(cfg, "virus_outbreak", "1")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(infectedSlots(g, 0), []int{0, 5}) || !slices.Equal(infectedSlots(g, 1), []int{1}) {
		t.Fatalf("заражены %v / %v, хотим [0 5] / [1]", infectedSlots(g, 0), infectedSlots(g, 1))
	}
	if g.ActiveEvent == nil || g.ActiveEvent.ID != EventVirus || g.ActiveEvent != &g.DayEvents[0] {
		t.Fatalf("карточка вируса: %+v", g.ActiveEvent)
	}
	if g.Clock() != "11:00" || g.VirusWaveClock() != "12:00" {
		t.Fatalf("время %s, волна %s — хотим 11:00 и 12:00", g.Clock(), g.VirusWaveClock())
	}
	// Все три канала за одну волну: место 6 офиса 1 — только соседи,
	// место 1 офиса 1 и место 2 офиса 2 — через core в оба офиса.
	net := g.Network()
	if got := slotsOf(g.virusReach(net, 0, 5), 0); !slices.Equal(got, []int{1, 4, 6}) {
		t.Errorf("место 6: %v, хотим соседей [1 4 6]", got)
	}
	if got := slotsOf(g.virusReach(net, 0, 5), 1); got != nil {
		t.Errorf("место 6 вне сети достаёт офис 2: %v", got)
	}
	if got := slotsOf(g.virusReach(net, 1, 1), 0); !slices.Equal(got, []int{0, 1, 2, 3}) {
		t.Errorf("место 2 офиса 2 через core: %v, хотим [0 1 2 3]", got)
	}
	for g.Clock() != "12:00" {
		g.Tick()
	}
	if n := g.infectedCount(); n != 6 {
		t.Errorf("после волны заражено %d, хотим 6 (каждый из трёх — ещё одно место)", n)
	}
}
