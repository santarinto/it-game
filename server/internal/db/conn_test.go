package db

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// lazyDB — настоящий *DB без соединения: пул pgx не подключается, пока его
// не спросят, поэтому Close работает и без живой базы.
func lazyDB(t *testing.T) *DB {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://itd:itd@127.0.0.1:1/itdirector")
	if err != nil {
		t.Fatal(err)
	}
	return &DB{Pool: pool}
}

func nopLog(string, ...any) {}

// ITGAME-190: база лежит на старте — Conn отдаёт ошибку сразу, а в фоне
// повторяет попытку, пока база не поднимется; дальше не дёргает. Успех ждёт
// release, чтобы проверка «сразу после старта» не гонялась с фоном.
func TestOpenRetriesUntilUp(t *testing.T) {
	up := lazyDB(t)
	release := make(chan struct{})
	var calls atomic.Int32
	dial := func(ctx context.Context) (*DB, error) {
		if calls.Add(1) <= 2 {
			return nil, errors.New("база лежит")
		}
		select {
		case <-release:
			return up, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	c := open(dial, time.Millisecond, 4*time.Millisecond, nopLog)
	t.Cleanup(c.Close)

	if d, err := c.Get(); d != nil || err == nil || !strings.Contains(err.Error(), "база лежит") {
		t.Fatalf("сразу после старта: Get() = %v, %v; ожидалась ошибка «база лежит»", d, err)
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if d, err := c.Get(); err == nil {
			if d != up {
				t.Fatalf("Get() вернул не тот *DB")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("за 2 с не переподключился, попыток %d", calls.Load())
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	if n := calls.Load(); n != 3 {
		t.Fatalf("попыток %d, ожидалось 3 (две неудачи и успех, дальше тишина)", n)
	}
}

// Close прерывает паузу между попытками: при паузе в час он не ждёт её конца,
// и после него dial не зовётся.
func TestCloseInterruptsPause(t *testing.T) {
	var calls atomic.Int32
	dial := func(context.Context) (*DB, error) {
		calls.Add(1)
		return nil, errors.New("база лежит")
	}
	c := open(dial, time.Hour, time.Hour, nopLog)
	closeWithin(t, c, time.Second)
	if n := calls.Load(); n != 1 {
		t.Fatalf("попыток %d, ожидалась одна синхронная", n)
	}
}

// Close прерывает и попытку в полёте: dial получает отменённый контекст, а
// Get после Close отвечает errClosed, а не ошибкой отмены.
func TestCloseInterruptsAttempt(t *testing.T) {
	var calls atomic.Int32
	inFlight := make(chan struct{})
	dial := func(ctx context.Context) (*DB, error) {
		if calls.Add(1) == 1 {
			return nil, errors.New("база лежит")
		}
		close(inFlight)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	c := open(dial, time.Millisecond, time.Millisecond, nopLog)
	<-inFlight
	closeWithin(t, c, time.Second)
	if _, err := c.Get(); !errors.Is(err, errClosed) {
		t.Fatalf("Get() после Close: %v, ожидалась errClosed", err)
	}
}

func closeWithin(t *testing.T, c *Conn, limit time.Duration) {
	t.Helper()
	closed := make(chan struct{})
	go func() { c.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(limit):
		t.Fatalf("Close не вернулся за %s", limit)
	}
}

// Неразбираемый DATABASE_URL — ошибка конфигурации, повтором не лечится:
// Open отвечает ею сразу и в фоне не крутится.
func TestOpenBadDSN(t *testing.T) {
	c := Open("postgres://itd:itd@127.0.0.1:notaport/itdirector", nopLog)
	defer c.Close()
	if d, err := c.Get(); d != nil || err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("Get() = %v, %v; ожидалась ошибка разбора DATABASE_URL", d, err)
	}
	select {
	case <-c.done:
	default:
		t.Fatal("фоновые попытки запущены — разбор DSN повтором не лечится")
	}
}

// Open с недоступной базой возвращается сразу, без паники и без выхода.
func TestOpenUnreachable(t *testing.T) {
	start := time.Now()
	c := Open("postgres://itd:itd@127.0.0.1:1/itdirector?connect_timeout=2", nopLog)
	defer c.Close()
	if time.Since(start) > 5*time.Second {
		t.Fatalf("Open ждал %s", time.Since(start))
	}
	if d, err := c.Get(); d != nil || err == nil {
		t.Fatalf("Get() = %v, %v; ожидалась ошибка подключения", d, err)
	}
}

// Живая база (TEST_DATABASE_URL): Open подключается и мигрирует синхронно —
// каталог доступен сразу, без ожидания фона.
func TestOpenLive(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL не задан — пропускаем интеграционный тест БД")
	}
	defer func(was time.Duration) { attemptTimeout = was }(attemptTimeout)
	attemptTimeout = time.Minute
	c := Open(dsn, nopLog)
	defer c.Close()
	d, err := c.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if items, err := d.ListEquipment(ctx); err != nil || len(items) == 0 {
		t.Fatalf("ListEquipment: %d записей, %v", len(items), err)
	}
}
