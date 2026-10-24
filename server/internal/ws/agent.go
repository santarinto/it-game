package ws

import (
	"context"
	"net/http"
	"regexp"
	"runtime/debug"
	"sync"
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
	Role     string `json:"role"`         // owner (headless) | observer (прицепился к живой)
	Phase    string `json:"phase"`        // фаза игры сессии ("" если сессия недоступна)
	Version  string `json:"version"`      // sha сервера: штамп -ldflags (buildSHA), иначе vcs.revision[:7], иначе unknown
	Seed     string `json:"seed"`         // сид партии
	Scenario string `json:"scenario"`     // фиксура старта ("" — обычная)
	At       string `json:"at"`           // время ответа, ISO
	Rev      uint64 `json:"rev"`          // текущая версия состояния сессии (ITGAME-45)
	Re       int64  `json:"re,omitempty"` // id запроса status, если был
}

// agentResultMessage — ответ на агентскую debug-команду: снапшот придёт
// всем отдельным state-сообщением, здесь только итог операции.
type agentResultMessage struct {
	Type   string `json:"type"` // всегда "agent_result"
	Action string `json:"action"`
	OK     bool   `json:"ok"`
	Error  string `json:"error,omitempty"`
	// Rev — версия состояния после операции (ITGAME-45): её снапшот уже
	// разослан до этого ответа; агент ждёт state.rev ≥ Rev вместо поллинга.
	Rev uint64 `json:"rev"`
	Re  int64  `json:"re,omitempty"` // id debug-запроса, если был
}

// ServeAgent — HTTP-хендлер GET /ws/agent.
func (h *Handler) ServeAgent(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*", "itgame.santarinto.ru", "stage.itgame.santarinto.ru"},
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
		Client:   "agent", // headless-сессия моста: в аналитике партий не игрок
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
		owner:    c,
		ownerSrc: srcBridge,
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
				Version: serverVersion(), At: time.Now().Format(time.RFC3339), Re: msg.ID}
			if rep, ok := <-debugCall(ctx, sess, debugRequest{kind: kindState}); ok {
				if rep.Code == http.StatusOK {
					if sr, valid := rep.Body.(stateReply); valid {
						st.Phase, st.Seed, st.Scenario = sr.State.Phase, sr.State.Seed, sr.State.Scenario
						st.Rev = sr.State.Rev
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
			res := agentResultMessage{Type: "agent_result", Action: action, OK: true, Re: msg.ID}
			if rep, ok := <-debugCall(ctx, sess, req); ok {
				if rep.Code != http.StatusOK {
					res.OK, res.Error = false, rep.Err
				}
				res.Rev = rep.Rev
			}
			sess.hub.writeTo(ctx, c, res)
		default:
			// Команды игрока: тот же CommandType-протокол, что у вкладки.
			select {
			case sess.commands <- clientCommand{Cmd: game.Command(msg.Type), Office: msg.Office, Slot: msg.Slot, Speed: msg.Speed, From: c, ID: msg.ID, Src: srcBridge}:
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

// ServerVersion — то же для GET /api/version (ITGAME-78: штамп сборки в
// клиенте сверяет вкладку со стендом).
func ServerVersion() string { return serverVersion() }

// buildSHA — sha релиза, вшитый линкером (ITGAME-81). Релиз собирается из
// git archive (без .git) — vcs.revision там нет, и рецепт деплоя должен
// передавать короткий sha (tools/deploy передаёт его с ITGAME-98):
//
//	go build -ldflags "-X itdirector/internal/ws.buildSHA=<sha>"
//
// Пусто (make build, go run, go test) — работает vcs.revision.
var buildSHA string

// serverVersion — sha сервера: штамп линкера, иначе vcs.revision, который
// go build вшивает из чекаута (Go 1.18+), иначе "unknown" (go run, архив без
// штампа).
func serverVersion() string {
	bi, _ := debug.ReadBuildInfo()
	return pickVersion(buildSHA, bi)
}

// pickVersion — выбор версии без глобалов (тестируется напрямую).
func pickVersion(stamp string, bi *debug.BuildInfo) string {
	if isHexSHA(stamp) {
		return stamp
	}
	if bi != nil {
		for _, s := range bi.Settings {
			if s.Key == "vcs.revision" && len(s.Value) >= 7 {
				return s.Value[:7]
			}
		}
	}
	return "unknown"
}

// buildVersion — версия сборки год.мес.день.час.мин (ITGAME-140): время коммита по Москве,
// вшитое линкером рядом с buildSHA (tools/deploy, tools/dev-stand/stand.sh):
//
//	go build -ldflags "-X itdirector/internal/ws.buildVersion=2026.10.17.01.25"
//
// Время коммита, а не сборки: пересборка того же коммита (рестарт стенда) — та же версия.
// Пусто (make build, selfServe QA) — vcs.time из чекаута.
var buildVersion string

var buildVersionRe = regexp.MustCompile(`^\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}$`)

// msk — время версии: зона владельца, без перехода на летнее время (UTC+3 с 2014).
var msk = time.FixedZone("MSK", 3*60*60)

// BuildVersion — версия сборки сервера; "" — не определилась (go run, go test, архив без
// штампа). Для людей: меню, /api/version, сейв, журнал; сейвы ею не сверяются (ITGAME-169).
// Зовётся на каждый сейв (тик) — build info
// разбирается один раз; штамп читается каждый раз (тесты его подменяют).
func BuildVersion() string {
	if buildVersionRe.MatchString(buildVersion) {
		return buildVersion
	}
	return vcsBuildVersion()
}

var vcsBuildVersion = sync.OnceValue(func() string {
	bi, _ := debug.ReadBuildInfo()
	return pickBuildVersion("", bi)
})

// pickBuildVersion — выбор без глобалов (тестируется напрямую): штамп линкера, иначе
// vcs.time по Москве, иначе "".
func pickBuildVersion(stamp string, bi *debug.BuildInfo) string {
	if buildVersionRe.MatchString(stamp) {
		return stamp
	}
	if bi != nil {
		for _, s := range bi.Settings {
			if s.Key != "vcs.time" {
				continue
			}
			if t, err := time.Parse(time.RFC3339, s.Value); err == nil {
				return t.In(msk).Format("2006.01.02.15.04")
			}
		}
	}
	return ""
}

// isHexSHA — sha git: 7..40 hex в нижнем регистре. То же правило, что у
// BUILD_SHA в client/vite.config.ts: в /api/version не уходит произвольная строка.
func isHexSHA(s string) bool {
	if len(s) < 7 || len(s) > 40 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
