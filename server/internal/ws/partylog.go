package ws

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"itdirector/internal/game"
	"itdirector/internal/partylog"
)

// PartySink — куда актор шлёт записи партии для аналитики (ITGAME-239):
// partylog.Writer в проде, срез в тестах. Send не блокирует.
type PartySink interface {
	Send(partylog.Record)
}

// partyTrack — партия актора глазами аналитики (docs/design/party-analytics.md).
// Методы зовутся после успешного сейва — как записи журнала: вытесненный
// актор, чей сейв не прошёл, ничего не пишет. Нулевой sink — всё no-op
// (нет базы, нет сейвов: партию нечем адресовать).
type partyTrack struct {
	sink       PartySink
	sidHash    string
	client     string
	ttl        time.Duration
	pid        string    // токен партии в памяти; новый на старте и подъёме
	scenario   string    // фикстура старта нынешней партии
	lastClosed int       // последний записанный закрытый день
	ended      bool      // финал записан
	saved      time.Time // последний успешный сейв актора
}

func newPartyTrack(h *Handler, sid, client string, withSaves bool) *partyTrack {
	pt := &partyTrack{client: client}
	if h.Parties == nil || !withSaves {
		return pt
	}
	sum := sha256.Sum256([]byte(sid))
	pt.sink, pt.sidHash, pt.ttl = h.Parties, hex.EncodeToString(sum[:]), h.Saves.TTL()
	return pt
}

func newPID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// touch — сейв прошёл: от него считаются last_seen_at и expires_at.
func (pt *partyTrack) touch() { pt.saved = time.Now() }

func (pt *partyTrack) record(kind partylog.Kind, g *game.Game) partylog.Record {
	at := pt.saved
	if at.IsZero() {
		at = time.Now()
	}
	return partylog.Record{
		Kind: kind, PID: pt.pid, SIDHash: pt.sidHash, At: at, Expires: at.Add(pt.ttl),
		Day: g.Day, Money: int64(g.Money),
		Build: BuildVersion(), Difficulty: difficultyLabel(g), Scenario: pt.scenario,
		Seed: g.SeedString(), Client: pt.client,
	}
}

// start — новая партия: свежий sid или рестарт. Закрытые дни фикстуры —
// не дни этой партии: счёт с них.
func (pt *partyTrack) start(g *game.Game, scenario string) {
	if pt.sink == nil {
		return
	}
	pt.pid, pt.scenario, pt.ended = newPID(), scenario, false
	pt.lastClosed = maxClosedDay(g)
	pt.touch()
	pt.sink.Send(pt.record(partylog.KindStart, g))
}

// resumed — партия поднята из сейва; preClosed — последний закрытый день
// сейва до офлайн-догона: дни после него закрыл догон.
func (pt *partyTrack) resumed(g *game.Game, scenario string, preClosed int) {
	if pt.sink == nil {
		return
	}
	pt.pid, pt.scenario, pt.ended, pt.lastClosed = newPID(), scenario, false, preClosed
	pt.touch()
	pt.sink.Send(pt.record(partylog.KindResume, g))
	pt.observe(g, true)
}

// reset — сейв sid был, но не поднялся (чужой формат, битый, Restore упал).
func (pt *partyTrack) reset() {
	if pt.sink == nil {
		return
	}
	now := time.Now()
	pt.sink.Send(partylog.Record{Kind: partylog.KindReset, SIDHash: pt.sidHash, At: now, Expires: now})
}

// observe — после события актора: закрытые дни выше записанного и финал.
// Один путь для живого вечера, офлайн-догона и debug-промотки.
func (pt *partyTrack) observe(g *game.Game, offline bool) {
	if pt.sink == nil || pt.pid == "" {
		return
	}
	if newest := newestClosedDay(g); newest > pt.lastClosed {
		pt.writeDays(g)
	}
	switch g.Phase {
	case game.PhaseWon:
		pt.finish(g, "victory", "", offline)
	case game.PhaseGameOver:
		pt.finish(g, "lost", g.LoseReason, offline)
	default:
		pt.ended = false // debug-откат из финала: следующий финал — новый
	}
}

// writeDays — закрытые дни выше записанного, по возрастанию.
func (pt *partyTrack) writeDays(g *game.Game) {
	for _, l := range closedLedgers(g) {
		if l.Day <= pt.lastClosed {
			continue
		}
		pt.lastClosed = l.Day
		raw, err := json.Marshal(l)
		if err != nil {
			continue
		}
		staff, offices, pcs := headcount(g)
		r := pt.record(partylog.KindDay, g)
		r.Closed = &partylog.Day{
			Day: l.Day, Offline: l.Offline, Balance: int64(l.BalanceEnd), Income: int64(l.Income),
			Payroll: int64(l.Payroll), Staff: staff, Offices: offices, PCs: pcs, Ledger: raw,
		}
		pt.sink.Send(r)
	}
}

// finish — исход партии, один раз.
func (pt *partyTrack) finish(g *game.Game, outcome, reason string, offline bool) {
	if pt.sink == nil || pt.ended || pt.pid == "" {
		return
	}
	pt.ended = true
	r := pt.record(partylog.KindFinish, g) // время — последнего сейва: финал вытесненного актора не новее партии
	r.Outcome, r.LoseReason, r.Offline = outcome, reason, offline
	pt.sink.Send(r)
}

// choice — решение игрока в событии; option -1 — проигнорировано до вечера.
func (pt *partyTrack) choice(g *game.Game, ev game.DayEvent, day, option int) {
	if pt.sink == nil || pt.pid == "" {
		return
	}
	r := pt.record(partylog.KindChoice, g)
	r.Choice = &partylog.Choice{Day: day, Tick: ev.Tick, Event: string(ev.ID), Option: option}
	pt.sink.Send(r)
}

// debug — debug-мутация состояния: партия вон из аналитики.
func (pt *partyTrack) debug(g *game.Game) {
	if pt.sink == nil || pt.pid == "" {
		return
	}
	pt.touch()
	pt.sink.Send(pt.record(partylog.KindDebug, g))
}

// leave — актор ушёл. После финала не пишется: запись ушла бы к партии,
// которую в той же сессии уже начала другая вкладка.
func (pt *partyTrack) leave(g *game.Game) {
	if pt.sink == nil || pt.pid == "" || pt.ended || g == nil {
		return
	}
	pt.sink.Send(pt.record(partylog.KindSeen, g))
}

// pending — активное событие с выбором до тика: если вечер его погасит,
// это игнор. Аудит выбора не предлагает.
func (pt *partyTrack) pending(g *game.Game) *game.DayEvent {
	if pt.sink == nil || g.ActiveEvent == nil || g.ActiveEvent.Resolved || g.ActiveEvent.ID == game.EventAudit {
		return nil
	}
	ev := *g.ActiveEvent
	return &ev
}

// closedLedgers — закрытые книги дней по возрастанию: история и нынешний
// день, если вечер уже прошёл (до NextDay он ещё в g.Ledger).
func closedLedgers(g *game.Game) []game.DayLedger {
	out := make([]game.DayLedger, 0, len(g.LedgerHistory)+1)
	for _, l := range g.LedgerHistory {
		if l.Closed {
			out = append(out, l)
		}
	}
	if g.Ledger.Closed {
		if l, ok := g.LedgerOf(g.Ledger.Day); ok {
			out = append(out, l)
		}
	}
	return out
}

// newestClosedDay — последний закрытый день без копий книг: observe зовётся
// на каждом тике, а новый день закрывается раз в 54.
func newestClosedDay(g *game.Game) int {
	if g.Ledger.Closed {
		return g.Ledger.Day
	}
	if n := len(g.LedgerHistory); n > 0 {
		return g.LedgerHistory[n-1].Day
	}
	return 0
}

func maxClosedDay(g *game.Game) int {
	day := 0
	for _, l := range closedLedgers(g) {
		day = max(day, l.Day)
	}
	return day
}

// headcount — штат, открытые офисы и ПК на момент записи.
func headcount(g *game.Game) (staff, offices, pcs int) {
	for _, o := range g.Offices {
		if !o.Unlocked {
			continue
		}
		offices++
		staff += len(o.Employees)
		pcs += o.PCs
	}
	return staff, offices, pcs
}
