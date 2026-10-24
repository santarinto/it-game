package partylog

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"itdirector/internal/db"
	"itdirector/internal/metrics"
)

// Интеграционные тесты против TEST_DATABASE_URL (как internal/db): без
// переменной — пропуск. Каждый тест пишет под своим sid_hash, базу не чистит.

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL не задан — пропускаем интеграционный тест партий")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	t.Cleanup(d.Close)
	if err := d.Migrate(ctx); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return d.Pool
}

func newWriter(pool *pgxpool.Pool) *Writer {
	return New(func() (*pgxpool.Pool, error) { return pool, nil }, 64, func(string, ...any) {})
}

func sidHash(t *testing.T) string {
	return fmt.Sprintf("%s-%d", t.Name(), time.Now().UnixNano())
}

var t0 = time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)

func rec(kind Kind, pid, sid string, at time.Duration, day int, money int64) Record {
	return Record{
		Kind: kind, PID: pid, SIDHash: sid, At: t0.Add(at), Expires: t0.Add(at + 24*time.Hour),
		Day: day, Money: money, Build: "b1", Difficulty: "normal", Seed: "42", Client: "desktop",
	}
}

func dayRec(pid, sid string, at time.Duration, day, staff int) Record {
	r := rec(KindDay, pid, sid, at, day, 100)
	r.Closed = &Day{Day: day, Balance: 100, Income: 50, Payroll: 20, Staff: staff, Offices: 1, PCs: 2, Ledger: []byte(`{"day":1}`)}
	return r
}

type partyRow struct {
	n                 int
	partial           bool
	outcome, reason   *string
	day               int
	money             int64
	sessions          int
	debug, offline    bool
	startedAt, seenAt time.Time
}

func parties(t *testing.T, pool *pgxpool.Pool, sid string) []partyRow {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT n, partial, outcome, lose_reason, day, money,
		sessions, debug, ended_offline, started_at, last_seen_at FROM parties WHERE sid_hash = $1 ORDER BY n`, sid)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []partyRow
	for rows.Next() {
		var p partyRow
		if err := rows.Scan(&p.n, &p.partial, &p.outcome, &p.reason, &p.day, &p.money,
			&p.sessions, &p.debug, &p.offline, &p.startedAt, &p.seenAt); err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	return out
}

func count(t *testing.T, pool *pgxpool.Pool, q, sid string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), q, sid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func str(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

// Партия целиком: старт, день, выбор, проигрыш; рестарт в том же sid — n=2.
func TestPartyLifecycleAndRestart(t *testing.T) {
	pool := testPool(t)
	sid := sidHash(t)
	w := newWriter(pool)
	w.Send(rec(KindStart, "p1", sid, 0, 1, 600))
	w.Send(dayRec("p1", sid, time.Minute, 1, 3))
	ch := rec(KindChoice, "p1", sid, 2*time.Minute, 2, 90)
	ch.Choice = &Choice{Day: 2, Tick: 7, Event: "raise", Option: 1}
	w.Send(ch)
	fin := rec(KindFinish, "p1", sid, 3*time.Minute, 2, -500)
	fin.Outcome, fin.LoseReason = "lost", "bankrupt"
	w.Send(fin)
	w.Send(rec(KindStart, "p2", sid, 4*time.Minute, 1, 600))
	w.Close()

	ps := parties(t, pool, sid)
	if len(ps) != 2 {
		t.Fatalf("партий %d, хотим 2 (рестарт — новая)", len(ps))
	}
	p1, p2 := ps[0], ps[1]
	if p1.n != 1 || str(p1.outcome) != "lost" || str(p1.reason) != "bankrupt" || p1.day != 2 || p1.money != -500 || p1.partial {
		t.Errorf("первая партия: %+v", p1)
	}
	if p2.n != 2 || p2.outcome != nil || p2.day != 1 || p2.partial {
		t.Errorf("вторая партия: %+v", p2)
	}
	if n := count(t, pool, `SELECT count(*) FROM party_days d JOIN parties p ON p.id = d.party_id WHERE p.sid_hash = $1`, sid); n != 1 {
		t.Errorf("дней %d, хотим 1", n)
	}
	if n := count(t, pool, `SELECT count(*) FROM party_choices c JOIN parties p ON p.id = c.party_id
		WHERE p.sid_hash = $1 AND c.event = 'raise' AND c.choice = 1`, sid); n != 1 {
		t.Errorf("выборов raise/1: %d, хотим 1", n)
	}
}

// Старт потерян: день заводит partial-строку; день меньше дня последней
// партии (рестарт) — ещё одну, а не ложится в старую.
func TestLostStartMakesPartial(t *testing.T) {
	pool := testPool(t)
	sid := sidHash(t)
	w := newWriter(pool)
	w.Send(dayRec("lost-1", sid, 0, 5, 2))
	w.Send(dayRec("lost-2", sid, time.Minute, 1, 1))
	w.Close()
	ps := parties(t, pool, sid)
	if len(ps) != 2 || !ps[0].partial || !ps[1].partial || ps[0].day != 5 || ps[1].day != 1 {
		t.Fatalf("хотим две partial-партии (день 5, затем день 1): %+v", ps)
	}
}

// Запоздалая запись вытесненного актора: время, день и деньги не откатываются;
// повторный финал не переписывает исход.
func TestStaleWritesDoNotRollBack(t *testing.T) {
	pool := testPool(t)
	sid := sidHash(t)
	w := newWriter(pool)
	w.Send(rec(KindStart, "old", sid, 0, 1, 600))
	w.Send(rec(KindResume, "new", sid, 10*time.Minute, 4, 900)) // новая вкладка подняла сейв
	fin := rec(KindFinish, "new", sid, 11*time.Minute, 4, 1000)
	fin.Outcome = "victory"
	w.Send(fin)
	stale := rec(KindFinish, "old", sid, 5*time.Minute, 3, 0) // старая дописала финал своего сейва
	stale.Outcome, stale.LoseReason = "lost", "bankrupt"
	w.Send(stale)
	w.Send(rec(KindSeen, "old", sid, 4*time.Minute, 3, 700))
	w.Close()
	ps := parties(t, pool, sid)
	if len(ps) != 1 {
		t.Fatalf("партий %d, хотим 1 (подъём — та же партия): %+v", len(ps), ps)
	}
	p := ps[0]
	if p.sessions != 2 {
		t.Errorf("sessions %d, хотим 2", p.sessions)
	}
	if str(p.outcome) != "victory" || p.reason != nil {
		t.Errorf("исход %s/%s, хотим victory без причины: повторный финал переписал", str(p.outcome), str(p.reason))
	}
	if p.day != 4 || p.money != 1000 || !p.seenAt.Equal(t0.Add(11*time.Minute)) {
		t.Errorf("день %d, деньги %d, last_seen %s: запоздалые записи откатили", p.day, p.money, p.seenAt)
	}
}

// Первая запись дня остаётся: догон, перебирая книгу, не затирает штат онлайн-дня.
func TestDayFirstWriteWins(t *testing.T) {
	pool := testPool(t)
	sid := sidHash(t)
	w := newWriter(pool)
	w.Send(rec(KindStart, "p", sid, 0, 1, 600))
	w.Send(dayRec("p", sid, time.Minute, 1, 3))
	w.Send(dayRec("p", sid, 2*time.Minute, 1, 9))
	w.Close()
	if n := count(t, pool, `SELECT d.staff FROM party_days d JOIN parties p ON p.id = d.party_id WHERE p.sid_hash = $1`, sid); n != 3 {
		t.Errorf("штат дня %d, хотим 3 (первая запись)", n)
	}
}

// Сброс сейва закрывает последнюю партию reset; уход к кончившейся партии не
// пишется; подъём после неё — новая partial-строка с одной сессией.
func TestResetAndAfterEnd(t *testing.T) {
	pool := testPool(t)
	sid := sidHash(t)
	w := newWriter(pool)
	w.Send(rec(KindStart, "p", sid, 0, 3, 600))
	w.Send(Record{Kind: KindReset, SIDHash: sid, At: t0.Add(time.Minute)})
	w.Send(rec(KindSeen, "ghost", sid, 2*time.Minute, 3, 1))
	w.Send(rec(KindResume, "next", sid, 3*time.Minute, 3, 50))
	w.Close()
	ps := parties(t, pool, sid)
	if len(ps) != 2 {
		t.Fatalf("партий %d, хотим 2: %+v", len(ps), ps)
	}
	if str(ps[0].outcome) != "reset" || ps[0].money != 600 {
		t.Errorf("первая: исход %s, деньги %d — хотим reset и нетронутые $600", str(ps[0].outcome), ps[0].money)
	}
	if !ps[1].partial || ps[1].sessions != 1 {
		t.Errorf("вторая: %+v — хотим partial с одной сессией", ps[1])
	}
}

// Debug-мутация помечает партию; финал офлайн-догона — ended_offline.
func TestDebugAndOfflineFinish(t *testing.T) {
	pool := testPool(t)
	sid := sidHash(t)
	w := newWriter(pool)
	w.Send(rec(KindStart, "p", sid, 0, 1, 600))
	w.Send(rec(KindDebug, "p", sid, time.Minute, 1, 5000))
	fin := rec(KindFinish, "p", sid, 2*time.Minute, 9, -1)
	fin.Outcome, fin.LoseReason, fin.Offline = "lost", "time_up", true
	w.Send(fin)
	w.Close()
	p := parties(t, pool, sid)[0]
	if !p.debug || !p.offline || str(p.reason) != "time_up" {
		t.Errorf("%+v — хотим debug, ended_offline, time_up", p)
	}
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM party_status WHERE sid_hash = $1`, sid).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "lost" {
		t.Errorf("status %q, хотим lost", status)
	}
}

// Брошенная: без исхода, сейв истёк.
func TestDroppedView(t *testing.T) {
	pool := testPool(t)
	sid := sidHash(t)
	w := newWriter(pool)
	w.Send(rec(KindStart, "p", sid, 0, 4, 600))
	w.Close()
	// expires_at записи — от t0, его отношение к now() не задано: ставим явно.
	if _, err := pool.Exec(context.Background(), `UPDATE parties SET expires_at = now() - interval '1 minute' WHERE sid_hash = $1`, sid); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM party_status WHERE sid_hash = $1`, sid).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "dropped" {
		t.Errorf("status %q, хотим dropped", status)
	}
}

// Базы нет: запись теряется в счётчике no_db, Send не блокирует.
func TestNoDatabaseDrops(t *testing.T) {
	noDB := metrics.PartylogDropped.WithLabelValues("no_db")
	before := testutil.ToFloat64(noDB)
	w := New(func() (*pgxpool.Pool, error) { return nil, errors.New("нет базы") }, 4, func(string, ...any) {})
	for i := 0; i < 3; i++ {
		w.Send(rec(KindStart, "p", "nodb", 0, 1, 1))
	}
	w.Close()
	if d := testutil.ToFloat64(noDB) - before; d != 3 {
		t.Errorf("no_db +%v, хотим +3", d)
	}
}

// Полный буфер: Send не ждёт, лишнее — в счётчик full.
func TestFullBufferDrops(t *testing.T) {
	full := metrics.PartylogDropped.WithLabelValues("full")
	before := testutil.ToFloat64(full)
	release := make(chan struct{})
	w := New(func() (*pgxpool.Pool, error) { <-release; return nil, errors.New("нет базы") }, 1, func(string, ...any) {})
	for i := 0; i < 5; i++ {
		w.Send(rec(KindStart, "p", "full", 0, 1, 1)) // одна в работе, одна в буфере, три — мимо
	}
	if d := testutil.ToFloat64(full) - before; d < 3 {
		t.Errorf("full +%v, хотим ≥3", d)
	}
	close(release)
	w.Close()
}
