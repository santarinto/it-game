package ws

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/coder/websocket"

	"itdirector/internal/metrics"
)

// Таймаут чтения вкладки (ITGAME-76). Без него сервер узнавал об обрыве сети
// (без close-фрейма: Wi-Fi пропал, ноутбук уснул) только когда TCP сдастся на
// записи — минутами, и всё это время партия шла вживую без игрока. Теперь
// соединение вкладки (/ws) держит часы «когда последний раз слышали клиента»:
// любое сообщение или pong на наш ping. Молчит дольше ReadTimeout — сервер
// считает клиента ушедшим: рвёт соединение без close-фрейма, актор встаёт,
// последний сейв (актор пишет его каждый тик) — момент, когда сервер заметил
// уход; офлайн-догон при возврате считается от него.
//
// Ping уходит, когда клиент молчит треть таймаута: браузер отвечает pong-ом
// сам (без JS, и в фоновой вкладке), так что живая вкладка на паузе таймаут
// не ловит.

// DefaultReadTimeout — таймаут чтения по умолчанию (Handler.ReadTimeout = 0).
// main.go берёт ITGAME_READ_TIMEOUT (Go duration: 5s, 1500ms), если задан.
const DefaultReadTimeout = 30 * time.Second

// Границы таймаута для ручки POST /api/debug/drop?timeout= (мс).
const (
	minDropTimeout = 50 * time.Millisecond
	maxDropTimeout = 10 * time.Minute
)

func (h *Handler) readTimeout() time.Duration {
	if h.ReadTimeout > 0 {
		return h.ReadTimeout
	}
	return DefaultReadTimeout
}

// tabConn — соединение вкладки с часами слышимости. dropped — debug-обрыв
// (POST /api/debug/drop, ITGAME-76): сервер больше не читает и не пишет в это
// соединение (hub его не знает, readLoop выбрасывает входящее, ping не шлём)
// и замечает уход тем же таймаутом чтения, что и настоящий обрыв.
type tabConn struct {
	c *websocket.Conn

	mu      sync.Mutex
	heard   time.Time     // последний кадр клиента (сообщение или pong)
	timeout time.Duration // таймаут чтения; drop может укоротить
	dropped time.Time     // момент debug-обрыва; zero — не обрывали
	pinging bool          // ping в полёте: второй не шлём
	gone    string        // почему сторож закрыл соединение (журнал партии, ITGAME-46); "" — не он
	rewatch chan struct{} // drop сменил таймаут — сторож пересчитывает шаг
}

func newTabConn(c *websocket.Conn, timeout time.Duration) *tabConn {
	return &tabConn{c: c, heard: time.Now(), timeout: timeout, rewatch: make(chan struct{}, 1)}
}

// hear — клиент прислал кадр. После debug-обрыва не считается: сервер его
// «не слышит».
func (t *tabConn) hear() {
	t.mu.Lock()
	if t.dropped.IsZero() {
		t.heard = time.Now()
	}
	t.mu.Unlock()
}

// goneWhy — read_timeout | debug_drop, если соединение закрыл сторож; иначе
// "" (и у headless-сессии без вкладки).
func (t *tabConn) goneWhy() string {
	if t == nil {
		return ""
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.gone
}

func (t *tabConn) isDropped() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.dropped.IsZero()
}

// drop — debug-обрыв: с этого момента клиент молчит. Часы слышимости ставятся
// на «сейчас» (последнее, что сервер слышал, — до обрыва), timeout > 0 —
// свой таймаут для этого соединения. ok=false — уже оборвано.
func (t *tabConn) drop(timeout time.Duration) (at time.Time, effective time.Duration, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.dropped.IsZero() {
		return t.dropped, t.timeout, false
	}
	now := time.Now()
	t.dropped, t.heard = now, now
	if timeout > 0 {
		t.timeout = timeout
	}
	select {
	case t.rewatch <- struct{}{}:
	default:
	}
	return now, t.timeout, true
}

// watch — сторож соединения: ping при тишине, разрыв по таймауту чтения.
// Шаг проверки — четверть таймаута (25 мс..5 с): заметит уход не позже
// timeout + шаг после последнего кадра.
func (t *tabConn) watch(ctx context.Context, cancel context.CancelFunc, sid string) {
	for {
		t.mu.Lock()
		step := min(max(t.timeout/4, 25*time.Millisecond), 5*time.Second)
		t.mu.Unlock()
		timer := time.NewTimer(step)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-t.rewatch:
			timer.Stop()
			continue
		case <-timer.C:
		}
		t.mu.Lock()
		idle, timeout, dropped := time.Since(t.heard), t.timeout, !t.dropped.IsZero()
		ping := !dropped && !t.pinging && idle >= timeout/3
		if ping {
			t.pinging = true
		}
		t.mu.Unlock()
		if idle > timeout {
			why, gone := "обрыв сети", "read_timeout"
			if dropped {
				why, gone = "debug-обрыв", "debug_drop"
			}
			t.mu.Lock()
			t.gone = gone
			t.mu.Unlock()
			if !dropped {
				metrics.ReadTimeouts.Inc()
			}
			log.Printf("сессия %s: клиент молчит %s (таймаут чтения %s, %s) — соединение закрыто", sid, idle.Round(time.Millisecond), timeout, why)
			t.c.CloseNow() // без close-фрейма: пиру его всё равно не доставить
			cancel()       // актор встаёт; последний сейв — момент, когда заметили
			return
		}
		if ping {
			go func() {
				pctx, pcancel := context.WithTimeout(ctx, timeout)
				defer pcancel()
				// Ping ждёт pong, который прочитает readLoop (Read обрабатывает
				// управляющие кадры); ошибка — пусть решит таймаут выше.
				if t.c.Ping(pctx) == nil {
					t.hear()
				}
				t.mu.Lock()
				t.pinging = false
				t.mu.Unlock()
			}()
		}
	}
}
