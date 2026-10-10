package ws

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"sort"

	"itdirector/internal/game"
)

// Реплеер журнала партии (ITGAME-46): прогоняет журнал на game.Game теми
// же функциями, что и живой актор (game.Apply, debugMutate, game.Restore,
// AdvanceOffline), и после каждой записи сверяет journalHash. Первое
// расхождение — место, где партия перестала быть функцией сида и входов.

// ReplayResult — итог реплея. Divergence != nil — детерминизм сломан.
type ReplayResult struct {
	Header     journalHeader
	Records    int    // записей применено
	Ticks      int    // тиков прогнано
	FromSeq    uint64 // seq первой записи (> 1 — голову срезало кольцо)
	LastHash   string // хэш после последней записи
	Divergence *Divergence
	// Warnings — расхождения, которые не ломают реплей: сейв, поднятый при
	// вытеснении, разошёлся с журналом старого актора (гонка Load/Begin) —
	// реплей ресинхронизировался по сейву. Каждое — с diff.
	Warnings []string
	// Conns — соединения партии по журналу (ITGAME-91): номер conn → источник
	// (tab | bridge); старый журнал без conn — пусто.
	Conns map[int]string

	// Состояние после реплея (до расхождения, если оно есть).
	Game     *game.Game
	Speed    int
	Scenario string
}

// Divergence — первая запись, после которой состояние реплея не совпало.
type Divergence struct {
	Line   int             // строка журнала, 1-based (header — строка 1)
	Record json.RawMessage // запись как в журнале
	Reason string
	Want   string // ожидаемый хэш (из журнала)
	Got    string // хэш реплея
	// Позиция «ожидалось / получено»: каждая запись несёт day/tick/money/phase/speed.
	WantPos, GotPos string
	// Diff — поля сейва, разошедшиеся с чекпоинтом (если расхождение на cp
	// или resume с известным ожидаемым сейвом); иначе пусто.
	Diff []string
}

func (d *Divergence) String() string {
	var b bytes.Buffer
	fmt.Fprintf(&b, "расхождение на строке %d: %s\n", d.Line, d.Reason)
	fmt.Fprintf(&b, "  запись:   %s\n", d.Record)
	if d.Want != "" || d.Got != "" {
		fmt.Fprintf(&b, "  хэш:      ожидался %s, получен %s\n", d.Want, d.Got)
	}
	fmt.Fprintf(&b, "  ожидалось: %s\n  получено:  %s\n", d.WantPos, d.GotPos)
	for _, l := range d.Diff {
		fmt.Fprintf(&b, "  %s\n", l)
	}
	return b.String()
}

// replayer — состояние партии, как его видел бы актор.
type replayer struct {
	cfg      game.Config
	hdr      journalHeader
	g        *game.Game
	speed    int
	rs       int // resumeSpeed актора (ITGAME-65)
	scenario string
	open     bool // актор пишет: был start/resume, не было end
	evicted  bool // последний end — вытеснение
	warn     []string
	conns    map[int]string      // ITGAME-91: conn → src
	pairs    map[[2]int64]uint64 // (conn, id) команды → seq, где пара встретилась
}

// noteConn — соединение записи и уникальность пары (conn, id) команды
// (ITGAME-91). Повтор состояние не ломает (conn и id в хэш не входят), но
// журнал с ним снова неоднозначен — предупреждение, как у ресинка.
func (rp *replayer) noteConn(rec journalRecord) {
	if rec.Conn <= 0 {
		return // журнал до ITGAME-91 или команда без соединения
	}
	if rp.conns == nil {
		rp.conns, rp.pairs = map[int]string{}, map[[2]int64]uint64{}
	}
	if rec.Src != "" || rp.conns[rec.Conn] == "" {
		rp.conns[rec.Conn] = rec.Src
	}
	if rec.K != "cmd" || rec.ID == 0 {
		return
	}
	k := [2]int64{int64(rec.Conn), rec.ID}
	if prev, dup := rp.pairs[k]; dup {
		rp.warn = append(rp.warn, fmt.Sprintf("seq %d: пара (conn %d, id %d) повторилась — уже была в seq %d", rec.Seq, rec.Conn, rec.ID, prev))
		return
	}
	rp.pairs[k] = rec.Seq
}

func posOf(day, tick, money int, phase string, speed int) string {
	return fmt.Sprintf("day=%d tick=%d money=%d phase=%s speed=%d", day, tick, money, phase, speed)
}

func (rp *replayer) pos() string {
	return posOf(rp.g.Day, rp.g.TickInDay, rp.g.Money, string(rp.g.Phase), rp.speed)
}

func (rp *replayer) hash() string { return journalHash(rp.g, rp.speed, rp.scenario) }

// Replay — прогнать журнал из r. Ошибка — журнал не читается (формат,
// пустой, не та версия); расхождение — в ReplayResult.Divergence.
func Replay(r io.Reader) (*ReplayResult, error) {
	br := bufio.NewReaderSize(r, 1<<20)
	line := 0
	next := func() ([]byte, error) {
		for {
			b, err := br.ReadBytes('\n')
			b = bytes.TrimSpace(b)
			if len(b) > 0 {
				line++
				return b, nil
			}
			if err != nil {
				return nil, err
			}
			line++
		}
	}

	hb, err := next()
	if err != nil {
		return nil, fmt.Errorf("пустой журнал: %w", err)
	}
	res := &ReplayResult{}
	if err := json.Unmarshal(hb, &res.Header); err != nil || res.Header.K != "header" {
		return nil, fmt.Errorf("строка 1: нет заголовка журнала (k=header)")
	}
	if res.Header.V != journalVersion {
		return nil, fmt.Errorf("журнал v%d, реплеер понимает v%d", res.Header.V, journalVersion)
	}
	if h := configHash(res.Header.Config); h != res.Header.CfgHash {
		return nil, fmt.Errorf("cfgHash заголовка %s, конфиг в нём даёт %s — журнал правили руками?", res.Header.CfgHash, h)
	}
	rp := &replayer{cfg: res.Header.Config, hdr: res.Header}

	var lastSeq uint64
	for {
		raw, err := next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		var rec journalRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			return nil, fmt.Errorf("строка %d: %w", line, err)
		}
		if rp.g == nil {
			if rec.K != "start" && rec.K != "cp" && rec.K != "resume" {
				return nil, fmt.Errorf("строка %d: журнал начинается с %q — нужен start, cp или resume", line, rec.K)
			}
			res.FromSeq = rec.Seq
		} else if rec.Seq != lastSeq+1 {
			return nil, fmt.Errorf("строка %d: seq %d после %d — журнал склеен или порезан не по чекпоинту", line, rec.Seq, lastSeq)
		}
		lastSeq = rec.Seq
		if rp.g != nil {
			for range rec.TK {
				rp.g.Tick()
			}
			res.Ticks += rec.TK
		}
		div := rp.apply(rec)
		// end вытесненного актора не сверяется: его последний тик или
		// команда могли уже лечь в память, а сейв — не пройти (Put чужого
		// поколения), и в журнал такой вход не попал.
		if div == nil && !(rec.K == "end" && rec.Evicted) {
			if got := rp.hash(); got != rec.H {
				div = &Divergence{Reason: "хэш состояния после записи " + rec.K, Want: rec.H, Got: got}
			}
		}
		if div != nil {
			div.Line, div.Record = line, raw
			if div.WantPos == "" {
				div.WantPos = posOf(rec.Day, rec.Tick, rec.Money, rec.Phase, rec.Speed)
			}
			if div.GotPos == "" && rp.g != nil {
				div.GotPos = rp.pos()
			}
			if rec.Save != nil && rp.g != nil && div.Diff == nil {
				div.Diff = saveDiff(*rec.Save, rp.g.Export())
			}
			res.Divergence = div
			break
		}
		rp.noteConn(rec)
		res.Records++
		res.LastHash = rp.hash()
	}
	if rp.g == nil && res.Divergence == nil {
		return nil, errors.New("в журнале нет ни одной записи")
	}
	res.Game, res.Speed, res.Scenario, res.Warnings, res.Conns = rp.g, rp.speed, rp.scenario, rp.warn, rp.conns
	return res, nil
}

// apply — вход записи; nil — применён (хэш сверит вызывающий).
func (rp *replayer) apply(rec journalRecord) *Divergence {
	switch rec.K {
	case "start":
		// Как newGame / game.NewFixture в run(): сид и фикстура из заголовка.
		seed, ok := game.ParseSeed(rp.hdr.Seed)
		if !ok {
			return &Divergence{Reason: "start: сид заголовка не число: " + rp.hdr.Seed}
		}
		rp.g, rp.speed, rp.rs, rp.scenario = game.NewSeeded(rp.cfg, seed), 1, 0, rp.hdr.Scenario
		rp.open, rp.evicted = true, false
		if rp.hdr.Scenario != "" {
			g, err := game.NewFixture(rp.cfg, rp.hdr.Scenario, rp.hdr.Seed)
			if err != nil {
				return &Divergence{Reason: "start: " + err.Error()}
			}
			rp.g = g
		}

	case "cp":
		if rec.Save == nil {
			return &Divergence{Reason: "cp без save"}
		}
		if rp.g != nil {
			return nil // контрольная точка: сверка хэша, при расхождении — diff сейва
		}
		g, err := game.Restore(*rec.Save)
		if err != nil {
			return &Divergence{Reason: "cp: " + err.Error()}
		}
		if err := g.SetRNGState(rec.RNG); err != nil {
			return &Divergence{Reason: "cp: позиция PCG: " + err.Error()}
		}
		rp.g, rp.speed, rp.rs, rp.scenario = g, rec.Speed, rec.RS, rec.Scenario
		rp.open, rp.evicted = true, false

	case "cmd":
		var code string
		switch game.Command(rec.Type) {
		case cmdAbandon:
			// сессия кончается, состояние не трогается
		case cmdSetSpeed:
			if rec.Arg < 0 || rec.Arg > 3 {
				code = "bad_speed"
			} else {
				rp.speed, rp.rs = rec.Arg, 0
			}
		case cmdExit:
			rp.speed, rp.rs = 0, min(max(rec.Arg, 0), 3)
		default:
			if err := rp.g.Apply(game.Command(rec.Type), rec.Office, rec.Slot); err != nil {
				code = err.Error()
			}
		}
		if code != rec.Err {
			return &Divergence{Reason: fmt.Sprintf("команда %s (%s): в журнале отказ %q, в реплее %q", rec.Type, cmdWho(rec), rec.Err, code)}
		}

	case "debug":
		req := debugRequest{kind: rec.Op, state: rec.State, scenario: rec.Scenario, days: rec.Days, ticks: rec.Ticks}
		if rec.Patch != nil {
			req.patch = *rec.Patch
		}
		g, _, code, msg := debugMutate(rp.g, req)
		if code != 0 {
			return &Divergence{Reason: fmt.Sprintf("debug %s: живой актор принял, реплей отказал: %s", rec.Op, msg)}
		}
		rp.g = g
		if rec.Op == kindScenario {
			rp.scenario = rec.Scenario
		}

	case "resume":
		if div := rp.resume(rec); div != nil {
			return div
		}

	case "end":
		rp.open, rp.evicted = false, rec.Evicted

	case "day":
		// веха: только сверка хэша
	default:
		return &Divergence{Reason: "неизвестный вид записи " + rec.K}
	}
	return nil
}

// cmdWho — «c2 tab id3»: кто прислал команду (ITGAME-91); без conn — «id3».
func cmdWho(rec journalRecord) string {
	if rec.Conn <= 0 {
		return fmt.Sprintf("id%d", rec.ID)
	}
	return fmt.Sprintf("c%d %s id%d", rec.Conn, rec.Src, rec.ID)
}

// resume — как persist → Load → game.Restore → AdvanceOffline: JSON-круг
// сейва, PCG с начала по сиду (save.go), догон и возврат темпа после exit.
// Сейв, поднятый сервером, обязан совпасть с состоянием реплея к разрыву;
// при вытеснении (старый актор не закрыл журнал или закрыл его как
// evicted) расхождение — гонка двух акторов, реплей берёт сейв из записи.
func (rp *replayer) resume(rec journalRecord) *Divergence {
	fromSave := func() *Divergence {
		if rec.Save == nil {
			return &Divergence{Reason: "resume без save: продолжить не с чего"}
		}
		g, err := game.Restore(*rec.Save)
		if err != nil {
			return &Divergence{Reason: "resume: сейв записи не восстанавливается: " + err.Error()}
		}
		rp.g, rp.speed, rp.rs, rp.scenario = g, rec.SaveSpeed, rec.RS, rec.Scenario
		return nil
	}
	switch {
	case rp.g == nil:
		// журнал начат с этой записи (рестарт сервера, срез кольца)
		if div := fromSave(); div != nil {
			return div
		}
	default:
		data, _ := json.Marshal(rp.g.Export())
		var s game.Save
		if err := json.Unmarshal(data, &s); err != nil {
			return &Divergence{Reason: "resume: " + err.Error()}
		}
		g, err := game.Restore(s)
		if err != nil {
			return &Divergence{Reason: "resume: сейв не восстанавливается: " + err.Error()}
		}
		rp.g = g
		if got := rp.hash(); rec.Pre != "" && got != rec.Pre {
			var diff []string
			if rec.Save != nil {
				diff = saveDiff(*rec.Save, rp.g.Export())
			}
			if !(rec.Took || rp.open || rp.evicted) || rec.Save == nil {
				return &Divergence{Reason: "resume: сейв, поднятый сервером, не равен состоянию к моменту разрыва (потерян вход или тик? RNG не с сида?)",
					Want: rec.Pre, Got: got, Diff: diff,
					WantPos: "сейв сервера: " + savePos(rec),
					GotPos:  "реплей к разрыву: " + rp.pos()}
			}
			w := fmt.Sprintf("seq %d: вытеснение — сейв, поднятый новым актором, не равен журналу старого: "+
				"входы старого между Load и Begin нового в сейв не попали (реплей %s, сейв %s); ресинк по сейву",
				rec.Seq, rp.pos(), savePos(rec))
			for _, d := range diff {
				w += "\n    " + d
			}
			rp.warn = append(rp.warn, w)
			if div := fromSave(); div != nil {
				return div
			}
		}
	}
	if got := rp.hash(); rec.Pre != "" && got != rec.Pre {
		return &Divergence{Reason: "resume: сейв записи после Restore даёт не тот хэш (Restore не идемпотентен?)",
			Want: rec.Pre, Got: got}
	}
	rp.g.AdvanceOffline(rec.Offline)
	if rs := min(rp.rs, 3); rp.speed == 0 && rs > 0 {
		rp.speed = rs
	}
	rp.rs = 0
	rp.open, rp.evicted = true, false
	return nil
}

func savePos(rec journalRecord) string {
	if rec.Save == nil {
		return "?"
	}
	s := rec.Save
	return posOf(s.Day, s.TickInDay, s.Money, string(s.Phase), rec.SaveSpeed)
}

// saveDiff — поля сейва, которые разошлись: путь и оба значения. Сравнение
// по JSON-дереву, чтобы видеть ровно то, что лежит в сейве.
func saveDiff(want, got game.Save) []string {
	var a, b any
	wb, _ := json.Marshal(want)
	gb, _ := json.Marshal(got)
	_ = json.Unmarshal(wb, &a)
	_ = json.Unmarshal(gb, &b)
	var out []string
	jsonDiff("save", a, b, &out)
	const limit = 40
	if len(out) > limit {
		out = append(out[:limit], fmt.Sprintf("… и ещё %d", len(out)-limit))
	}
	return out
}

func jsonDiff(path string, a, b any, out *[]string) {
	switch av := a.(type) {
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok {
			break
		}
		keys := make([]string, 0, len(av)+len(bv))
		for k := range av {
			keys = append(keys, k)
		}
		for k := range bv {
			if _, dup := av[k]; !dup {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			jsonDiff(path+"."+k, av[k], bv[k], out)
		}
		return
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			break
		}
		for i := range av {
			jsonDiff(fmt.Sprintf("%s[%d]", path, i), av[i], bv[i], out)
		}
		return
	}
	if !reflect.DeepEqual(a, b) {
		aj, _ := json.Marshal(a)
		bj, _ := json.Marshal(b)
		*out = append(*out, fmt.Sprintf("%s: ожидалось %s, получено %s", path, aj, bj))
	}
}
