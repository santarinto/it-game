// Package partylog — живые партии в PostgreSQL для аналитики (ITGAME-237/239,
// docs/design/party-analytics.md): где проигрывают, на каком дне бросают, что
// было перед концом. Актор сессии (internal/ws) шлёт записи в Writer без
// блокировки; одна горутина пишет их в базу. Игра базу не ждёт (ITGAME-190):
// полный буфер, лежащая база или упавший запрос — запись теряется и считается
// в itgame_partylog_dropped_total. Это статистика, а не учёт.
package partylog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"itdirector/internal/metrics"
)

// Kind — вид записи партии.
type Kind string

const (
	KindStart  Kind = "start"  // новая партия: новый sid или рестарт
	KindResume Kind = "resume" // подъём из сейва
	KindReset  Kind = "reset"  // сейв sid не поднялся: последняя партия sid кончилась так
	KindDay    Kind = "day"    // закрыт день
	KindChoice Kind = "choice" // выбор в событии или его игнор до вечера
	KindFinish Kind = "finish" // победа, проигрыш, «Сдаться»
	KindSeen   Kind = "seen"   // актор ушёл: разрыв, вытеснение, таймаут
	KindDebug  Kind = "debug"  // debug-мутация: партия вон из аналитики
)

// Record — одна запись. PID — токен партии в памяти актора: писатель держит
// его соответствие строке parties и адресует точно; неизвестный PID (подъём
// из сейва, потерянный старт) — «последняя партия sid» по правилам partial.
// Идентичность (Build … Client) актор шлёт в каждой записи: строка, заведённая
// не стартом, получает настоящие значения, кроме started_at.
type Record struct {
	Kind    Kind
	PID     string
	SIDHash string
	At      time.Time // время сейва, за которым запись ушла
	Expires time.Time // At + TTL сейва
	Day     int       // текущий день партии
	Money   int64     // текущий баланс

	Build, Difficulty, Scenario, Seed, Client string

	Closed *Day    // KindDay
	Choice *Choice // KindChoice

	Outcome    string // KindFinish: victory | lost | abandon
	LoseReason string // при lost
	Offline    bool   // финал пришёл в офлайн-догоне
}

// Day — закрытый день: шесть колонок и книга целиком.
type Day struct {
	Day                      int
	Offline                  bool
	Balance, Income, Payroll int64
	Staff, Offices, PCs      int
	Ledger                   json.RawMessage
}

// Choice — решение в событии; Option -1 — проигнорировано до вечера.
type Choice struct {
	Day, Tick int
	Event     string
	Option    int
}

// Pool — пул базы или ошибка, если её сейчас нет (db.Conn.Get).
type Pool func() (*pgxpool.Pool, error)

// Writer — очередь записей и горутина, что пишет их в базу по одной, по порядку.
type Writer struct {
	ch    chan Record
	pool  Pool
	logf  func(string, ...any)
	ids   map[string]int64 // PID → parties.id
	last  string           // последняя ошибка в логе: пишем только её смену
	done  chan struct{}
	query time.Duration
}

// maxIDs — потолок карты PID: живых акторов столько не бывает; переполнение —
// утечка, карта начинается заново (неизвестный PID найдёт свою строку по sid).
const maxIDs = 10000

// New запускает писателя с буфером buf записей.
func New(pool Pool, buf int, logf func(string, ...any)) *Writer {
	w := &Writer{
		ch: make(chan Record, buf), pool: pool, logf: logf,
		ids: map[string]int64{}, done: make(chan struct{}), query: 5 * time.Second,
	}
	go w.loop()
	return w
}

// Send — положить запись без блокировки; полный буфер — потеря.
func (w *Writer) Send(r Record) {
	select {
	case w.ch <- r:
	default:
		metrics.PartylogDropped.WithLabelValues("full").Inc()
	}
}

// Close — дописать очередь и остановиться. Send после Close запрещён.
func (w *Writer) Close() {
	close(w.ch)
	<-w.done
}

func (w *Writer) loop() {
	defer close(w.done)
	for r := range w.ch {
		pool, err := w.pool()
		if err != nil || pool == nil {
			metrics.PartylogDropped.WithLabelValues("no_db").Inc()
			continue
		}
		err = w.applySafe(pool, r)
		if err != nil {
			metrics.PartylogDropped.WithLabelValues("error").Inc()
			if err.Error() != w.last {
				w.logf("партии в БД: %s: %v", r.Kind, err)
			}
			w.last = err.Error()
			continue
		}
		w.last = ""
	}
}

// applySafe — одна запись под таймаутом; паника запроса — потерянная запись,
// а не упавший сервер.
func (w *Writer) applySafe(pool *pgxpool.Pool, r Record) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("паника: %v", p)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), w.query)
	defer cancel()
	return w.apply(ctx, pool, r)
}

func (w *Writer) apply(ctx context.Context, pool *pgxpool.Pool, r Record) error {
	switch r.Kind {
	case KindStart:
		id, err := insertParty(ctx, pool, r, false)
		if err != nil {
			return err
		}
		w.remember(r.PID, id)
		return nil
	case KindReset:
		_, err := pool.Exec(ctx, `UPDATE parties SET outcome = 'reset', ended_at = $2
			WHERE id = (SELECT id FROM parties WHERE sid_hash = $1 ORDER BY n DESC LIMIT 1)
			  AND outcome IS NULL`, r.SIDHash, r.At)
		return err
	}
	id, created, ok, err := w.resolve(ctx, pool, r)
	if err != nil || !ok {
		return err
	}
	switch r.Kind {
	case KindResume:
		if created {
			break // строка заведена этим подъёмом: sessions уже 1
		}
		if _, err := pool.Exec(ctx, `UPDATE parties SET sessions = sessions + 1 WHERE id = $1`, id); err != nil {
			return err
		}
	case KindDay:
		d := r.Closed
		if _, err := pool.Exec(ctx, `INSERT INTO party_days
			(party_id, day, closed_at, offline, balance, income, payroll, staff, offices, pcs, ledger)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			ON CONFLICT (party_id, day) DO NOTHING`,
			id, d.Day, r.At, d.Offline, d.Balance, d.Income, d.Payroll, d.Staff, d.Offices, d.PCs, d.Ledger); err != nil {
			return err
		}
	case KindChoice:
		c := r.Choice
		if _, err := pool.Exec(ctx, `INSERT INTO party_choices (party_id, day, tick, event, choice, at)
			VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
			id, c.Day, c.Tick, c.Event, c.Option, r.At); err != nil {
			return err
		}
	case KindFinish:
		if _, err := pool.Exec(ctx, `UPDATE parties
			SET outcome = $2, lose_reason = NULLIF($3, ''), ended_at = $4, ended_offline = $5
			WHERE id = $1 AND outcome IS NULL`, id, r.Outcome, r.LoseReason, r.At, r.Offline); err != nil {
			return err
		}
	case KindDebug:
		if _, err := pool.Exec(ctx, `UPDATE parties SET debug = true WHERE id = $1`, id); err != nil {
			return err
		}
	}
	// Монотонно: запоздалая запись вытесненного актора не откатывает ни
	// время, ни день с деньгами (деньги не монотонны — сравниваем время).
	if _, err := pool.Exec(ctx, `UPDATE parties SET
			day   = CASE WHEN $2 >= last_seen_at THEN $4 ELSE day END,
			money = CASE WHEN $2 >= last_seen_at THEN $5 ELSE money END,
			last_seen_at = GREATEST(last_seen_at, $2),
			expires_at   = GREATEST(expires_at, $3)
		WHERE id = $1`, id, r.At, r.Expires, r.Day, r.Money); err != nil {
		return err
	}
	if r.Kind == KindSeen || r.Kind == KindFinish {
		delete(w.ids, r.PID) // актор с этой партией больше не пишет
	}
	return nil
}

// resolve — строка parties для записи. Известный PID — его строка. Иначе
// последняя партия sid, а новая строка partial (created) — когда старт явно
// потерялся: строки нет; последняя уже с исходом; день записи меньше её дня
// (рестарт начал счёт заново). Уход актора к чужой или кончившейся партии не
// пишется: ok = false.
func (w *Writer) resolve(ctx context.Context, pool *pgxpool.Pool, r Record) (id int64, created, ok bool, err error) {
	if id, ok := w.ids[r.PID]; ok {
		return id, false, true, nil
	}
	var (
		outcome *string
		day     int
	)
	err = pool.QueryRow(ctx, `SELECT id, outcome, day FROM parties WHERE sid_hash = $1
		ORDER BY n DESC LIMIT 1`, r.SIDHash).Scan(&id, &outcome, &day)
	found := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, false, err
	}
	if r.Kind == KindSeen {
		if !found || outcome != nil || r.Day < day {
			return 0, false, false, nil
		}
		return id, false, true, nil
	}
	if !found || outcome != nil || r.Day < day {
		if id, err = insertParty(ctx, pool, r, true); err != nil {
			return 0, false, false, err
		}
		created = true
	}
	w.remember(r.PID, id)
	return id, created, true, nil
}

func (w *Writer) remember(pid string, id int64) {
	if pid == "" {
		return
	}
	if len(w.ids) >= maxIDs {
		w.ids = map[string]int64{}
	}
	w.ids[pid] = id
}

// insertParty — новая строка с n = max(n) + 1 по sid. Писатель один, гонки за n нет.
func insertParty(ctx context.Context, pool *pgxpool.Pool, r Record, partial bool) (int64, error) {
	var id int64
	err := pool.QueryRow(ctx, `INSERT INTO parties
		(sid_hash, n, partial, build, difficulty, scenario, seed, client,
		 started_at, last_seen_at, expires_at, day, money)
		VALUES ($1, (SELECT coalesce(max(n), 0) + 1 FROM parties WHERE sid_hash = $1),
		        $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)
		RETURNING id`,
		r.SIDHash, partial, r.Build, r.Difficulty, r.Scenario, r.Seed, r.Client,
		r.At, r.Expires, r.Day, r.Money).Scan(&id)
	return id, err
}
