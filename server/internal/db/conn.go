package db

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Паузы между фоновыми попытками: от retryMin, удваиваясь, до retryMax.
const (
	retryMin = 5 * time.Second
	retryMax = time.Minute
)

// attemptTimeout — на одну попытку (подключение и миграции). Переменная ради
// TestOpenLive: на перегруженном раннере CI миграции не укладывались в 10 с
// (ITGAME-228), а тест проверяет синхронность первой попытки, не её скорость.
var attemptTimeout = 10 * time.Second

var errClosed = errors.New("подключение закрыто")

// Conn — база сервера, которая может подняться позже него (ITGAME-190).
// Геймплей от БД не зависит, поэтому недоступная на старте база сервер не
// роняет: Open возвращается сразу, Get отдаёт последнюю ошибку, а в фоне идут
// повторные попытки, пока база не подключится и не примет миграции. После
// этого Conn больше не дёргает базу: пул pgx сам переподключается к запросам.
type Conn struct {
	mu   sync.RWMutex
	db   *DB
	err  error
	stop context.CancelFunc
	done chan struct{}
}

// Open подключается к dsn и применяет миграции. Первая попытка синхронная —
// при живой базе каталог готов к первому запросу, как раньше. Неразбираемый
// dsn — ошибка конфигурации: повтором не лечится, фона нет.
func Open(dsn string, logf func(format string, args ...any)) *Conn {
	if _, err := pgxpool.ParseConfig(dsn); err != nil {
		err = fmt.Errorf("DATABASE_URL: %w", err)
		logf("ВНИМАНИЕ: %v — игра работает, админка без каталога; без повторов", err)
		c := &Conn{err: err, stop: func() {}, done: make(chan struct{})}
		close(c.done)
		return c
	}
	return open(func(ctx context.Context) (*DB, error) { return dial(ctx, dsn) }, retryMin, retryMax, logf)
}

// dial — одна попытка: подключиться и применить миграции. Ошибка миграции
// тоже не фатальна: игре схема не нужна, а в логе и на /admin она видна.
func dial(ctx context.Context, dsn string) (*DB, error) {
	d, err := Connect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := d.Migrate(ctx); err != nil {
		d.Close()
		return nil, fmt.Errorf("миграции: %w", err)
	}
	return d, nil
}

func open(dial func(context.Context) (*DB, error), wait, maxWait time.Duration, logf func(string, ...any)) *Conn {
	ctx, stop := context.WithCancel(context.Background())
	c := &Conn{stop: stop, done: make(chan struct{})}
	err := c.try(ctx, dial)
	if err == nil {
		logf("БД подключена, миграции применены")
		close(c.done)
		return c
	}
	logf("ВНИМАНИЕ: БД недоступна: %v — игра работает, админка без каталога; повторяю в фоне (пауза %s, растёт до %s)", err, wait, maxWait)
	go c.retry(ctx, dial, wait, maxWait, err, logf)
	return c
}

// retry повторяет попытки до успеха или Close. В лог идёт только смена
// ошибки, а не каждая попытка: лежащая час база — это не шестьдесят строк.
func (c *Conn) retry(ctx context.Context, dial func(context.Context) (*DB, error), wait, maxWait time.Duration, last error, logf func(string, ...any)) {
	defer close(c.done)
	for n := 2; ; n++ {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		err := c.try(ctx, dial)
		if err == nil {
			logf("БД подключена с попытки %d, миграции применены", n)
			return
		}
		if ctx.Err() != nil {
			return
		}
		if err.Error() != last.Error() {
			logf("БД всё ещё недоступна: %v", err)
		}
		last = err
		wait = min(wait*2, maxWait)
	}
}

func (c *Conn) try(ctx context.Context, dial func(context.Context) (*DB, error)) error {
	actx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()
	d, err := dial(actx)
	c.mu.Lock()
	c.db, c.err = d, err
	c.mu.Unlock()
	return err
}

// Get — подключённая база или последняя ошибка подключения (тогда *DB nil).
func (c *Conn) Get() (*DB, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.db, c.err
}

// Close останавливает фоновые попытки и закрывает пул.
func (c *Conn) Close() {
	c.stop()
	<-c.done
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db != nil {
		c.db.Close()
	}
	c.db, c.err = nil, errClosed
}
