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

func dialAgent(t *testing.T, base, query string) (*websocket.Conn, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/ws/agent"+query, nil)
	if err != nil {
		t.Fatalf("agent dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, ctx
}

func readAgentMsg(t *testing.T, ctx context.Context, c *websocket.Conn) testMessage {
	t.Helper()
	var m testMessage
	if err := wsjson.Read(ctx, c, &m); err != nil {
		t.Fatalf("agent read: %v", err)
	}
	return m
}

// waitState — читать снапшоты, пока не выполнится условие (снапшоты и
// ответы моста interleav'ятся: порядок не фиксирован).
func waitState(t *testing.T, ctx context.Context, c *websocket.Conn, cond func(testMessage) bool) testMessage {
	t.Helper()
	for i := 0; i < 200; i++ {
		var raw json.RawMessage
		if err := wsjson.Read(ctx, c, &raw); err != nil {
			t.Fatalf("agent read: %v", err)
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &head) != nil || head.Type != "state" {
			continue
		}
		var m testMessage
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		if cond(m) {
			return m
		}
	}
	t.Fatal("подходящий снапшот не пришёл")
	return testMessage{}
}

// waitResult — агентский итог операции с экшеном action.
func waitResult(t *testing.T, ctx context.Context, c *websocket.Conn, action string) agentResultMessage {
	t.Helper()
	for i := 0; i < 200; i++ {
		var raw json.RawMessage
		if err := wsjson.Read(ctx, c, &raw); err != nil {
			t.Fatalf("agent read: %v", err)
		}
		var head struct {
			Type   string `json:"type"`
			Action string `json:"action"`
		}
		if json.Unmarshal(raw, &head) != nil || head.Type != "agent_result" || head.Action != action {
			continue
		}
		var res agentResultMessage
		if json.Unmarshal(raw, &res) == nil {
			return res
		}
	}
	t.Fatalf("agent_result %q не пришёл", action)
	return agentResultMessage{}
}

// Headless-цикл приёмки ITGAME-29: подключиться без браузера, получить
// снапшот, купить ПК, промотать день, прочитать статус.
func TestAgentHeadlessLifecycle(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.StartMoney = 2000
	cfg.WinTarget = 1_000_000
	base, _ := startDebugServer(t, cfg, time.Hour) // тики не мешают

	c, ctx := dialAgent(t, base, "?sid=agent-headless-1&seed=555")

	// 1. Снапшот при подключении — новый владелец получает стартовое состояние.
	first := readAgentMsg(t, ctx, c)
	if first.Type != "state" || first.Money != cfg.StartMoney {
		t.Fatalf("первое сообщение %+v", first)
	}

	// 2. Покупка ПК: та же команда, что у вкладки. Второй ПК дороже
	// базового (рост цены ×1.15) — проверяем факт покупки, не цену.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "buy_pc", Office: 0}); err != nil {
		t.Fatal(err)
	}
	bought := readAgentMsg(t, ctx, c)
	if bought.Type != "state" || bought.Offices[0].PCs != cfg.StartPCs+1 {
		t.Fatalf("после buy_pc %+v", bought)
	}
	if bought.Money >= cfg.StartMoney {
		t.Fatalf("buy_pc не списал деньги: %d", bought.Money)
	}

	// 3. Статус: роль owner, сид из ?seed=, версия сервера не пустая.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "status"}); err != nil {
		t.Fatal(err)
	}
	var st agentStatusMessage
	stFound := false
	for i := 0; i < 50 && !stFound; i++ {
		var raw json.RawMessage
		if err := wsjson.Read(ctx, c, &raw); err != nil {
			t.Fatal(err)
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &head) == nil && head.Type == "agent_status" {
			if json.Unmarshal(raw, &st) == nil {
				stFound = true
			}
		}
	}
	if !stFound || st.Type != "agent_status" || st.Role != "owner" {
		t.Fatalf("статус %+v", st)
	}
	if st.Seed != "555" {
		t.Fatalf("сид в статусе %q, ожидался 555", st.Seed)
	}
	if st.Version == "" {
		t.Fatal("версия сервера пуста")
	}

	// 4. Промотка дня: advance days=1 двигает день и отвечает итогом.
	// Порядок снапшот/итог не фиксирован — ждём оба.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "debug_advance", Days: 1}); err != nil {
		t.Fatal(err)
	}
	dayMsg := waitState(t, ctx, c, func(m testMessage) bool { return m.Day == 2 })
	if dayMsg.Type != "state" {
		t.Fatalf("после advance %+v", dayMsg)
	}
	if res := waitResult(t, ctx, c, "advance"); !res.OK {
		t.Fatalf("результат advance %+v", res)
	}

	// 5. Патч состояния — зеркало /api/debug/state.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "debug_patch", Money: intPtr(50000)}); err != nil {
		t.Fatal(err)
	}
	patched := waitState(t, ctx, c, func(m testMessage) bool { return m.Money == 50000 })
	_ = patched
	if res := waitResult(t, ctx, c, "patch"); !res.OK {
		t.Fatalf("результат patch %+v", res)
	}

	// 6. Битая команда — ошибка в ответе моста, сессия жива.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "debug_scenario", Scenario: "nope"}); err != nil {
		t.Fatal(err)
	}
	if res := waitResult(t, ctx, c, "scenario"); res.OK || res.Error == "" {
		t.Fatalf("неизвестный сценарий должен ошибиться: %+v", res)
	}
}

// Наблюдатель не отбирает сессию: игрок жив, агент читает те же снапшоты
// и шлёт команды; уход агента сессию не рвёт.
func TestAgentObserverNextToPlayer(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 1_000_000
	base, _ := startDebugServer(t, cfg, time.Hour)

	playerCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	player, _, err := websocket.Dial(playerCtx, "ws"+strings.TrimPrefix(base, "http")+"/ws?sid=agent-observe-1", nil)
	if err != nil {
		t.Fatalf("player dial: %v", err)
	}
	t.Cleanup(func() { player.CloseNow() })
	readAgentMsg(t, playerCtx, player) // стартовый снапшот игрока

	agent, ctx := dialAgent(t, base, "?sid=agent-observe-1")
	// агент при цеплянии получает текущий снапшот
	snap := readAgentMsg(t, ctx, agent)
	if snap.Type != "state" || snap.Money != cfg.StartMoney {
		t.Fatalf("снапшот наблюдателя %+v", snap)
	}

	// команда агента меняет игру — снапшот видят ОБА
	if err := wsjson.Write(ctx, agent, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	agentView := readAgentMsg(t, ctx, agent)
	playerView := readAgentMsg(t, playerCtx, player)
	if agentView.Type != "state" || playerView.Type != "state" {
		t.Fatalf("снапшоты после найма: агент %+v, игрок %+v", agentView, playerView)
	}
	if len(agentView.Offices[0].Employees) != 1 || len(playerView.Offices[0].Employees) != 1 {
		t.Fatalf("найм не дошёл: агент %d сотр., игрок %d",
			len(agentView.Offices[0].Employees), len(playerView.Offices[0].Employees))
	}

	// статус наблюдателя
	if err := wsjson.Write(ctx, agent, clientMessage{Type: "status"}); err != nil {
		t.Fatal(err)
	}
	var st agentStatusMessage
	stFound := false
	for i := 0; i < 50 && !stFound; i++ {
		var raw json.RawMessage
		if err := wsjson.Read(ctx, agent, &raw); err != nil {
			t.Fatal(err)
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &head) == nil && head.Type == "agent_status" {
			if json.Unmarshal(raw, &st) == nil {
				stFound = true
			}
		}
	}
	if !stFound || st.Role != "observer" {
		t.Fatalf("роль %q, ожидался observer", st.Role)
	}

	// уход агента не рвёт сессию игрока
	agent.CloseNow()
	time.Sleep(100 * time.Millisecond)
	if err := wsjson.Write(playerCtx, player, clientMessage{Type: "set_speed", Speed: 0}); err != nil {
		t.Fatalf("сессия игрока умерла с агентом: %v", err)
	}
	still := readAgentMsg(t, playerCtx, player)
	if still.Type != "state" || still.Speed != 0 {
		t.Fatalf("после ухода агента %+v", still)
	}
}

// Игрок подключается к headless-сессии агента — забирает её (Begin),
// мост агента закрывается с session_taken.
func TestPlayerTakesOverHeadless(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 1_000_000
	base := startSavesAgentServer(t, cfg)

	agent, ctx := dialAgent(t, base, "?sid=agent-takeover-1")
	readAgentMsg(t, ctx, agent) // стартовый снапшот

	playerCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	player, _, err := websocket.Dial(playerCtx, "ws"+strings.TrimPrefix(base, "http")+"/ws?sid=agent-takeover-1", nil)
	if err != nil {
		t.Fatalf("player dial: %v", err)
	}
	t.Cleanup(func() { player.CloseNow() })

	// агент получает разрыв с причиной session_taken
	var drain map[string]any
	err = wsjson.Read(ctx, agent, &drain)
	if err == nil {
		t.Fatal("соединение агента должно было закрыться")
	}
	if !strings.Contains(err.Error(), "session_taken") {
		t.Fatalf("причина закрытия агента: %v (ожидался session_taken)", err)
	}

	// игрок жив и владеет сессией
	if err := wsjson.Write(playerCtx, player, clientMessage{Type: "set_speed", Speed: 1}); err != nil {
		t.Fatal(err)
	}
	pmsg := readAgentMsg(t, playerCtx, player)
	if pmsg.Type != "state" {
		t.Fatalf("игрок после takeover: %+v", pmsg)
	}
}

// Игрок уходит — наблюдатель закрывается вместе с сессией (актор умер),
// переподключение поднимает headless и продолжает партию из сейва.
func TestAgentSurvivesPlayerDisconnectWithSaves(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 1_000_000
	base := startSavesAgentServer(t, cfg)

	sid := "agent-survive-1"
	playerCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	player, _, err := websocket.Dial(playerCtx, "ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid, nil)
	if err != nil {
		t.Fatalf("player dial: %v", err)
	}
	readAgentMsg(t, playerCtx, player)
	if err := wsjson.Write(playerCtx, player, clientMessage{Type: "buy_pc", Office: 0}); err != nil {
		t.Fatal(err)
	}
	readAgentMsg(t, playerCtx, player) // ПК куплен и засейвлен

	agent, ctx := dialAgent(t, base, "?sid="+sid)
	readAgentMsg(t, ctx, agent) // снапшот наблюдателя

	// игрок уходит — актор умирает, мост наблюдателя закрывается
	player.Close(websocket.StatusNormalClosure, "ушёл")
	var drain map[string]any
	if err := wsjson.Read(ctx, agent, &drain); err == nil {
		t.Fatal("мост наблюдателя должен закрыться вместе с сессией игрока")
	}

	// переподключение — headless: партия продолжена (ПК на месте)
	agent2, ctx2 := dialAgent(t, base, "?sid="+sid)
	resumed := readAgentMsg(t, ctx2, agent2)
	if resumed.Type != "state" || resumed.Offices[0].PCs != 2 {
		t.Fatalf("после реконнекта headless: %+v (ожидались 2 ПК)", resumed)
	}
}

func intPtr(v int) *int { return &v }

// startSavesAgentServer — как startAgentServer, но с файловым стором
// сейвов (headless-реконнект продолжает партию).
func startSavesAgentServer(t *testing.T, cfg game.Config) string {
	t.Helper()
	dir := t.TempDir()
	saves, err := store.New(dir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{Config: cfg, TickInterval: time.Hour, Saves: saves}
	mux := http.NewServeMux()
	mux.Handle("GET /ws", h)
	mux.Handle("GET /ws/agent", http.HandlerFunc(h.ServeAgent))
	mux.Handle("/api/debug/", http.HandlerFunc(h.ServeDebug))
	return newSavesServer(t, mux).URL
}
