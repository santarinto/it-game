package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// Финал партии с сейвами (ITGAME-51): банкротство и победа — в тике, в
// офлайн-догоне или debug-промоткой — удаляют сейв руками самого актора.
// Это не захват сессии: соединение живёт до «В меню» без session_taken,
// а restart в той же сессии снова пишет сейв (владение не потеряно).

// restartAfterFinale — после финала сессия жива: restart отвечает
// стартовым снапшотом, а не закрытием соединения.
func restartAfterFinale(t *testing.T, ctx context.Context, c *websocket.Conn) testMessage {
	t.Helper()
	if err := wsjson.Write(ctx, c, clientMessage{Type: "restart"}); err != nil {
		t.Fatalf("restart после финала: %v", err)
	}
	for i := 0; i < 1000; i++ {
		var msg testMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			t.Fatalf("соединение закрыто после финала (хотим живую сессию): %v", err)
		}
		if msg.Type == "state" && msg.Phase == "running" && msg.Day == 1 {
			return msg
		}
	}
	t.Fatal("restart после финала: 1000 сообщений без стартового снапшота")
	return testMessage{}
}

// mustHaveSave — сейв сессии на месте: актор по-прежнему владеет sid.
func mustHaveSave(t *testing.T, saves *store.Store, sid string) {
	t.Helper()
	if _, ok := saves.Load(sid); !ok {
		t.Fatalf("сейв %s не записан после restart: актор потерял владение сессией", sid)
	}
}

func TestBankruptcyKeepsSessionWithSaves(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	// День = 1 секунда (100 тиков по 10мс): запас, чтобы hire успел.
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 100
	cfg.SalaryPerDay = 100000 // гарантированное банкротство с одним сотрудником
	c, ctx := dialSaves(t, saves, cfg, 10*time.Millisecond, "?sid=broke-123456")

	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "game_over" })
	if _, ok := saves.Load("broke-123456"); ok {
		t.Fatal("после банкротства сейв должен удаляться")
	}

	// Без сотрудников ФОТ 0: новая партия не банкротится, сейв успевает лечь.
	restartAfterFinale(t, ctx, c)
	mustHaveSave(t, saves, "broke-123456")
}

func TestVictoryKeepsSessionWithSaves(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	cfg.WinTarget = 500 // старт $600 ≥ цели: победа первым тиком
	c, ctx := dialSaves(t, saves, cfg, 10*time.Millisecond, "?sid=winner-12345")
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "victory" })

	// restart после победы запрещён (только после поражения), поэтому
	// живость сессии проверяет set_speed: ответ снапшотом, а не закрытием.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "set_speed", Speed: 2}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Speed == 2 })
	// Команда в финальной фазе не воскрешает сейв законченной партии.
	if _, ok := saves.Load("winner-12345"); ok {
		t.Fatal("после победы команда снова записала сейв финальной партии")
	}
}

func TestOfflineFinaleKeepsSessionWithSaves(t *testing.T) {
	saves := newTestStore(t)
	// Сейв «два часа назад» с ФОТ, который офлайн-догон не вытянет.
	cfg := savesTestConfig()
	cfg.SalaryPerDay = 100000
	g := game.NewWithSeed(cfg, 11, 22)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	gen, _ := saves.Begin("away-1234567")
	raw, _ := json.Marshal(sessionSave{SID: "away-1234567", Speed: 1, SavedAt: old, Game: g.Export()})
	if !saves.Put("away-1234567", gen, raw, old) {
		t.Fatal("не удалось записать тестовый сейв")
	}

	c, ctx := dialSaves(t, saves, cfg, time.Second, "?sid=away-1234567") // 2ч = 7200 тиков
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "offline_report" })

	restartAfterFinale(t, ctx, c)
	mustHaveSave(t, saves, "away-1234567")
}

func TestDebugFinaleKeepsSessionWithSaves(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	h := &Handler{Config: cfg, TickInterval: time.Hour, Saves: saves}
	mux := http.NewServeMux()
	mux.Handle("GET /ws", h)
	mux.Handle("/api/debug/", http.HandlerFunc(h.ServeDebug))
	srv := newSavesServer(t, mux)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?sid=debug-123456", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	readResume(t, ctx, c)

	// Глубокий минус и промотка дня: финал случается в debug-ветке актора.
	if code, out := httpDebug(t, srv.URL, "POST", "/api/debug/state",
		`{"sid":"debug-123456","money":-100000}`); code != http.StatusOK {
		t.Fatalf("патч: %d %v", code, out)
	}
	if code, out := httpDebug(t, srv.URL, "POST", "/api/debug/advance",
		`{"sid":"debug-123456","days":1}`); code != http.StatusOK {
		t.Fatalf("промотка: %d %v", code, out)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Phase == "game_over" })

	restartAfterFinale(t, ctx, c)
	mustHaveSave(t, saves, "debug-123456")
}

// Настоящий захват второй вкладкой после финала по-прежнему вытесняет
// первую: правило «один sid — одно соединение» финал не отменяет.
func TestTakeoverAfterFinaleStillEvicts(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	cfg.WinTarget = 500
	c1, ctx1 := dialSaves(t, saves, cfg, 10*time.Millisecond, "?sid=again-123456")
	readUntil(t, ctx1, c1, func(m testMessage) bool { return m.Type == "victory" })

	c2, ctx2 := dialSaves(t, saves, cfg, time.Hour, "?sid=again-123456")
	readResume(t, ctx2, c2)

	for i := 0; i < 1000; i++ {
		var msg testMessage
		err := wsjson.Read(ctx1, c1, &msg)
		if err == nil {
			continue // хвост снапшотов первой партии
		}
		if !strings.Contains(err.Error(), "session_taken") {
			t.Fatalf("причина закрытия первой вкладки: %v, хотим session_taken", err)
		}
		return
	}
	t.Fatal("первая вкладка жива после захвата второй")
}
