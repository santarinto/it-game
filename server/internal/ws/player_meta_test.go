package ws

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/db"
	"itdirector/internal/game"
)

func TestPlayerMetaWSIntegration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL или DATABASE_URL не заданы — пропуск интеграционного теста")
	}

	ctx := context.Background()
	conn := db.Open(dsn, t.Logf)
	defer conn.Close()

	d, err := conn.Get()
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := d.Migrate(ctx); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	cfg := game.DefaultConfig()
	cfg.StartMoney = 10000
	h := &Handler{
		Config:       cfg,
		TickInterval: 50 * time.Millisecond,
		DB:           conn,
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	playerID := "p_ws_test_" + time.Now().Format("20060102150405.000000")
	wsBase := "ws" + strings.TrimPrefix(srv.URL, "http")

	// 1. Peek на нового игрока: если записи в БД ещё нет, Meta опускается (nil)
	func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		c, _, err := websocket.Dial(ctx, wsBase+"/ws?peek=1&player="+playerID, nil)
		if err != nil {
			t.Fatalf("peek dial: %v", err)
		}
		defer c.CloseNow()

		var sum saveSummaryMessage
		if err := wsjson.Read(ctx, c, &sum); err != nil {
			t.Fatalf("peek read: %v", err)
		}
		if sum.Type != "save_summary" {
			t.Fatalf("expected save_summary, got %s", sum.Type)
		}
		if sum.Meta != nil {
			t.Fatalf("expected nil Meta from peek for new player without DB record, got %+v", sum.Meta)
		}
	}()

	// 2. Игровая сессия: найм сотрудника должен открыть first_hire
	func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		c, _, err := websocket.Dial(ctx, wsBase+"/ws?difficulty=normal&sid=sid_test_1&player="+playerID, nil)
		if err != nil {
			t.Fatalf("play dial: %v", err)
		}
		defer c.CloseNow()

		// Читаем initial state
		var first stateMessage
		if err := wsjson.Read(ctx, c, &first); err != nil {
			t.Fatalf("initial state read: %v", err)
		}

		// Команда найма
		hireCmd := clientMessage{Type: "hire", Office: 0}
		if err := wsjson.Write(ctx, c, hireCmd); err != nil {
			t.Fatalf("write hire: %v", err)
		}

		// Должно прийти state и achievement_unlocked
		gotAch := false
		for i := 0; i < 5; i++ {
			var raw map[string]any
			if err := wsjson.Read(ctx, c, &raw); err != nil {
				break
			}
			if raw["type"] == "achievement_unlocked" && raw["id"] == "first_hire" {
				gotAch = true
				break
			}
		}
		if !gotAch {
			t.Fatalf("expected achievement_unlocked: first_hire")
		}
	}()

	// Ждем запись в БД (асинхронная)
	time.Sleep(100 * time.Millisecond)

	// 3. Повторный Peek: в meta.achievements теперь есть first_hire
	func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		c, _, err := websocket.Dial(ctx, wsBase+"/ws?peek=1&player="+playerID, nil)
		if err != nil {
			t.Fatalf("peek 2 dial: %v", err)
		}
		defer c.CloseNow()

		var sum saveSummaryMessage
		if err := wsjson.Read(ctx, c, &sum); err != nil {
			t.Fatalf("peek 2 read: %v", err)
		}
		if sum.Meta == nil {
			t.Fatalf("expected meta in peek 2")
		}
		if _, ok := sum.Meta.Achievements["first_hire"]; !ok {
			t.Fatalf("expected first_hire in player meta achievements, got %+v", sum.Meta.Achievements)
		}
	}()

	// 4. First-run Seed через игровую сессию
	func() {
		newPlayerID := "p_ws_seed_" + time.Now().Format("20060102150405.000000")
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		c, _, err := websocket.Dial(ctx, wsBase+"/ws?difficulty=normal&sid=sid_test_seed&player="+newPlayerID, nil)
		if err != nil {
			t.Fatalf("play dial: %v", err)
		}
		defer c.CloseNow()

		// Шлём seed_meta
		seedStats := db.DefaultMetaStats()
		seedStats.TotalRuns = 10
		seedStats.TotalWins = 5
		seedCmd := clientMessage{
			Type:  "seed_meta",
			Stats: &seedStats,
			Achievements: map[string]db.AchievementState{
				"coffee_break": {ID: "coffee_break", UnlockedAt: 1730000000000},
			},
		}
		if err := wsjson.Write(ctx, c, seedCmd); err != nil {
			t.Fatalf("write seed_meta: %v", err)
		}

		time.Sleep(150 * time.Millisecond)

		// Проверяем БД
		pm, err := d.GetPlayerMeta(ctx, newPlayerID)
		if err != nil {
			t.Fatalf("GetPlayerMeta: %v", err)
		}
		if pm == nil || pm.TotalRuns != 10 || pm.TotalWins != 5 {
			t.Fatalf("expected seeded stats in DB, got %+v", pm)
		}
		if _, ok := pm.Achievements["coffee_break"]; !ok {
			t.Fatalf("expected coffee_break in seeded achievements, got %+v", pm.Achievements)
		}
	}()
}
