package ws

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// putSave — сейв sid в стор «как будто записан at».
func putSave(t *testing.T, saves *store.Store, sid string, g *game.Game, speed int, at time.Time) {
	t.Helper()
	gen, _ := saves.Begin(sid)
	raw, _ := json.Marshal(sessionSave{SID: sid, Speed: speed, SavedAt: at, Game: g.Export()})
	if !saves.Put(sid, gen, raw, at) {
		t.Fatal("не удалось записать тестовый сейв")
	}
}

// peek — одно save_summary и закрытие соединения сервером.
func peek(t *testing.T, saves *store.Store, cfg game.Config, query string) saveSummaryMessage {
	t.Helper()
	c, ctx := dialSaves(t, saves, cfg, time.Second, query)
	var msg saveSummaryMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatalf("save_summary: %v", err)
	}
	if msg.Type != "save_summary" {
		t.Fatalf("хотели save_summary, получили %+v", msg)
	}
	var extra map[string]any
	err := wsjson.Read(ctx, c, &extra)
	if err == nil {
		t.Fatalf("после сводки соединение должно закрыться, получили %+v", extra)
	}
	if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("закрытие: %v, хотим normal closure", err)
	}
	return msg
}

func TestPeekLiveSave(t *testing.T) {
	saves := newTestStore(t)
	cfg := game.ApplyDifficulty(savesTestConfig(), game.DiffHard)
	g := game.NewWithSeed(cfg, 11, 22)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	putSave(t, saves, "peek-live-1", g, 1, time.Now())

	s := peek(t, saves, savesTestConfig(), "?peek=1&sid=peek-live-1")
	if !s.Exists || !s.Alive || s.Outcome != "" {
		t.Fatalf("живой сейв: %+v", s)
	}
	if s.Day != 1 || s.Money != g.Money || s.Difficulty != "hard" {
		t.Fatalf("факты сейва: %+v, хотим день 1, $%d, hard", s, g.Money)
	}
}

// Peek досчитывает офлайн так же, как реконнект, — факты меню совпадают с
// тем, что игрок увидит после «Продолжить», — но сейв не трогает.
func TestPeekCountsOfflineWithoutWriting(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	g := game.NewWithSeed(cfg, 11, 22)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	putSave(t, saves, "peek-offl-1", g, 1, old)
	before, _ := saves.Load("peek-offl-1")

	s := peek(t, saves, cfg, "?peek=1&sid=peek-offl-1")
	// Как TestResumeOfflineProgress: 2ч = день 134, 300 + 133×230 + 18×10.
	want := 300 + 133*(480-250) + 18*10
	if !s.Alive || s.Day != 134 || s.Money != want {
		t.Fatalf("офлайн в сводке: %+v, хотим день 134, $%d", s, want)
	}
	after, ok := saves.Load("peek-offl-1")
	if !ok || string(after) != string(before) {
		t.Fatal("peek переписал сейв")
	}

	// И реконнект после peek видит те же факты.
	c, ctx := dialSaves(t, saves, cfg, time.Second, "?sid=peek-offl-1")
	resumed := readResume(t, ctx, c)
	if resumed.Day != s.Day || resumed.Money != s.Money {
		t.Fatalf("реконнект: день %d $%d, сводка: день %d $%d", resumed.Day, resumed.Money, s.Day, s.Money)
	}
}

// Партия, погибшая офлайн, — не «продолжить»: сводка говорит, чем кончилось.
func TestPeekDeadOffline(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	cfg.IncomeMin, cfg.IncomeMax = 0, 0 // дохода нет — ФОТ съест баланс
	g := game.NewWithSeed(cfg, 11, 22)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	putSave(t, saves, "peek-dead-1", g, 1, time.Now().Add(-2*time.Hour))

	s := peek(t, saves, cfg, "?peek=1&sid=peek-dead-1")
	if !s.Exists || s.Alive || s.Outcome != "lost" || s.Reason != game.LoseBankrupt {
		t.Fatalf("банкротство офлайн: %+v", s)
	}
}

func TestPeekWonOffline(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	cfg.WinTarget = 1000
	g := game.NewWithSeed(cfg, 11, 22)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	putSave(t, saves, "peek-won-12", g, 1, time.Now().Add(-2*time.Hour))

	s := peek(t, saves, cfg, "?peek=1&sid=peek-won-12")
	if !s.Exists || s.Alive || s.Outcome != "won" {
		t.Fatalf("победа офлайн: %+v", s)
	}
}

func TestPeekMissingSave(t *testing.T) {
	saves := newTestStore(t)
	for _, q := range []string{"?peek=1&sid=peek-none-1", "?peek=1&sid=bad", "?peek=1"} {
		if s := peek(t, saves, savesTestConfig(), q); s.Exists || s.Alive {
			t.Fatalf("%s: сейва нет, сводка %+v", q, s)
		}
	}
}

// Без стора (-saves off) сейвов нет вовсе — и peek честно это говорит.
func TestPeekStateless(t *testing.T) {
	c, ctx := dialTestServerQuery(t, savesTestConfig(), time.Second, "?peek=1&sid=peek-none-1")
	var s saveSummaryMessage
	if err := wsjson.Read(ctx, c, &s); err != nil {
		t.Fatal(err)
	}
	if s.Type != "save_summary" || s.Exists {
		t.Fatalf("stateless: %+v", s)
	}
}

// Peek не захватывает сессию: живая вкладка не получает session_taken.
func TestPeekDoesNotTakeOver(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	c, ctx := dialSaves(t, saves, cfg, time.Hour, "?sid=peek-duel-1")
	readResume(t, ctx, c)
	wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0})
	hired := readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1
	})

	s := peek(t, saves, cfg, "?peek=1&sid=peek-duel-1")
	if !s.Alive || s.Money != hired.Money {
		t.Fatalf("сводка живой сессии: %+v, хотим $%d", s, hired.Money)
	}
	// Вкладка жива: команда проходит.
	wsjson.Write(ctx, c, map[string]any{"type": "set_speed", "speed": 2})
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Speed == 2 })
}
