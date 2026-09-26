package ws

import (
	"context"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// WS-мост отладки (ITGAME-29): GET /ws/agent?sid=… — JSON-канал поверх
// той же сессии, без браузера и Phaser. Контракт агента: console-API
// (window.itd в headless-Chromium) ИЛИ этот мост.
//
// Политика занятости (решение владельца): агент НИКОГДА не отбирает
// сессию у игрока.
//   • Живая сессия есть (вкладка браузера) — агент цепляется наблюдателем:
//     читает те же снапшоты, шлёт команды покупок и отладочные запросы.
//   • Сессии нет — агент поднимает headless-сессию и владеет ею, как
//     вкладка; сейвы работают как обычно.
//   • Игрок подключается к headless-сессии — его Begin() отбирает её:
//     мосты агента закрываются с session_taken, агент переподключается
//     уже наблюдателем.
//
// Регистрация маршрута — за гейтом ITGAME_DEBUG=1, как у /api/debug/*
// (ITGAME-26); см. newMux в server/cmd/server/main.go.

// agentStatusMessage — ответ на {"type":"status"}: чем жив агент.
type agentStatusMessage struct {
	Type     string `json:"type"` // всегда "agent_status"
	SID      string `json:"sid"`
	Role     string `json:"role"`     // owner (headless) | observer (прицепился к живой)
	Phase    string `json:"phase"`    // фаза игры сессии ("" если сессия недоступна)
	Version  string `json:"version"`  // sha сервера (vcs.revision)
	Seed     string `json:"seed"`     // сид партии
	Scenario string `json:"scenario"` // фиксура старта ("" — обычная)
	At       string `json:"at"`       // время ответа, ISO
}

// agentResultMessage — ответ на агентскую debug-команду: снапшот придёт
// всем отдельным state-сообщением, здесь только итог операции.
type agentResultMessage struct {
	Type   string `json:"type"` // всегда "agent_result"
	Action string `json:"action"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
}

// ServeAgent — HTTP-хендлер GET /ws/agent.
func (h *Handler) ServeAgent(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*", "itgame.santarinto.com"},
	})
	if err != nil {
		return
	}
	defer c.CloseNow()

	sid := r.URL.Query().Get("sid")
	if !store.ValidSID(sid) {
		c.Close(websocket.StatusPolicyViolation, "bad_sid")
		return
	}
	opts := sessionOpts{
		Seed:     r.URL.Query().Get("seed"),
		Scenario: r.URL.Query().Get("scenario"),
	}

	// Живая сессия — наблюдатель: не отбираем, не Begin-им, не сейвим.
	if sess := h.lookupSession(sid); sess != nil {
		h.observeAgent(r.Context(), c, sess, sid)
		return
	}

	// Headless: агент — владелец, ровно как вкладка браузера. Сессию и её
	// каналы создаём ДО запуска актора: readLoop агента начинает слать
	// команды/отладку сразу, без гонки с регистрацией.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	sess := &session{
		debugC:   make(chan debugRequest, 8),
		commands: make(chan clientCommand),
		hub:      newConnHub(),
	}
	sess.hub.add(c)
	go agentReadLoop(ctx, cancel, c, sess, sid, true)
	cfg := h.Config
	if q := r.URL.Query().Get("difficulty"); q != "" {
		cfg = game.ApplyDifficulty(h.Config, game.ParseDifficulty(q))
	}
	evicted := h.run(ctx, sess, cfg, sid, opts)
	sess.hub.closeAll(evicted)
}

// observeAgent — прицепиться к живой сессии: снапшоты пойдут из актора,
// команды уходят в общий канал, отладка — через debug-канал актора.
func (h *Handler) observeAgent(ctx context.Context, c *websocket.Conn, sess *session, sid string) {
	sess.hub.add(c)
	defer sess.hub.remove(c)
	// Первый снапшот сейчас, а не после следующего тика/команды:
	// на паузе или в day_report агент иначе висел бы без данных.
	if rep, ok := h.sendDebug(sid, debugRequest{kind: kindState}); ok && rep.Code == http.StatusOK {
		if sr, valid := rep.Body.(stateReply); valid {
			sess.hub.writeTo(ctx, c, sr.State)
		}
	}
	// cancel = nil: уход наблюдателя не рвёт сессию игрока.
	agentReadLoop(ctx, nil, c, sess, sid, false)
}

// agentReadLoop — читатель агентского сокета. Обычные команды игрока
// (buy_pc, hire, set_speed, next_day…) идут в общий канал актора;
// отладочные (status, debug_*) — через debug-канал. owner=true только у
// владельца headless-сессии: его уход (cancel) останавливает актора.
func agentReadLoop(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn, sess *session, sid string, owner bool) {
	if cancel != nil {
		defer cancel()
	}
	for {
		var msg clientMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			return
		}
		switch msg.Type {
		case "status":
			st := agentStatusMessage{Type: "agent_status", SID: sid,
				Role:    map[bool]string{true: "owner", false: "observer"}[owner],
				Version: serverVersion(), At: time.Now().Format(time.RFC3339)}
			if rep, ok := <-debugCall(ctx, sess, debugRequest{kind: kindState}); ok {
				if rep.Code == http.StatusOK {
					if sr, valid := rep.Body.(stateReply); valid {
						st.Phase, st.Seed, st.Scenario = sr.State.Phase, sr.State.Seed, sr.State.Scenario
					}
				}
			}
			sess.hub.writeTo(ctx, c, st)
		case "debug_patch", "debug_advance", "debug_step", "debug_scenario":
			var req debugRequest
			var action string
			switch msg.Type {
			case "debug_patch":
				req, action = debugRequest{kind: kindPatch,
					patch: debugPatch{Money: msg.Money, Day: msg.Day, TickInDay: msg.TickInDay}}, "patch"
			case "debug_advance":
				req, action = debugRequest{kind: kindAdvance, days: msg.Days, ticks: msg.Ticks}, "advance"
			case "debug_step":
				req, action = debugRequest{kind: kindAdvance, ticks: msg.Ticks}, "step"
			case "debug_scenario":
				req, action = debugRequest{kind: kindScenario, scenario: msg.Scenario}, "scenario"
			}
			res := agentResultMessage{Type: "agent_result", Action: action, OK: true}
			if rep, ok := <-debugCall(ctx, sess, req); ok && rep.Code != http.StatusOK {
				res.OK, res.Error = false, rep.Err
			}
			sess.hub.writeTo(ctx, c, res)
		default:
			// Команды игрока: тот же CommandType-протокол, что у вкладки.
			select {
			case sess.commands <- clientCommand{Cmd: game.Command(msg.Type), Office: msg.Office, Slot: msg.Slot, Speed: msg.Speed, From: c}:
			case <-ctx.Done():
				return
			}
		}
	}
}

// debugCall — запрос к актору через каналы сессии. Ответ актора приходит
// в буфер канала; закрытие = ждать больше нечего (агент отвалился).
func debugCall(ctx context.Context, sess *session, req debugRequest) <-chan debugReply {
	out := make(chan debugReply, 1)
	req.Reply = out
	go func() {
		select {
		case sess.debugC <- req: // ответит актор: reply() пишет в буфер
		case <-ctx.Done():
			close(out)
		}
	}()
	return out
}

// serverVersion — sha сервера: go build вшивает vcs.revision (Go 1.18+).
// В dev (go run) штампа нет — "unknown"; продовый бинарарь deploy-local.sh
// собирает go build — там живой sha.
func serverVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			if s.Key == "vcs.revision" && len(s.Value) >= 7 {
				return s.Value[:7]
			}
		}
	}
	return "unknown"
}
