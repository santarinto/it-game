package ws

import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// saveSummaryMessage — сводка сейва для стартового экрана (ITGAME-19):
// «День 3 · $60 · НОРМА» вместо абстрактного «день и баланс на месте».
// Отдаётся по /ws?peek=1&sid=… — тот же путь, что игра: в проде наружу
// проксируется только /ws, отдельный HTTP-маршрут до Go не дошёл бы.
type saveSummaryMessage struct {
	Type       string `json:"type"`       // всегда "save_summary"
	Exists     bool   `json:"exists"`     // сейв есть (не истёк, не битый)
	Alive      bool   `json:"alive"`      // партию можно продолжить
	Day        int    `json:"day"`        // день после офлайн-догона
	Money      int    `json:"money"`      // баланс после офлайн-догона
	Difficulty string `json:"difficulty"` // easy | normal | hard | hardcore
	Outcome    string `json:"outcome"`    // "" — жива; won | lost — финал случился офлайн
	Reason     string `json:"reason"`     // причина поражения: bankrupt | time_up | deadlock
}

// summarize — факты сейва sid без захвата сессии и без записи: офлайн
// досчитывается на копии так же, как при реконнекте (resume), поэтому меню
// показывает то, что игрок увидит после «Продолжить». Протухший или битый
// сейв Load/Restore отбрасывают — сводка говорит «сейва нет».
func (h *Handler) summarize(sid string) saveSummaryMessage {
	msg := saveSummaryMessage{Type: "save_summary"}
	if h.Saves == nil || !store.ValidSID(sid) {
		return msg
	}
	raw, ok := h.Saves.Load(sid)
	if !ok {
		return msg
	}
	var ss sessionSave
	if json.Unmarshal(raw, &ss) != nil || ss.SID != sid {
		return msg
	}
	g, err := game.Restore(ss.Game)
	if err != nil {
		return msg
	}
	g.AdvanceOffline(offlineTicks(ss.SavedAt, min(max(ss.Speed, 0), 3), h.TickInterval))
	msg.Exists = true
	msg.Day, msg.Money = g.Day, g.Money
	msg.Difficulty = string(g.Config().Difficulty)
	switch g.Phase {
	case game.PhaseWon:
		msg.Outcome = "won"
	case game.PhaseGameOver:
		msg.Outcome, msg.Reason = "lost", g.LoseReason
	default:
		msg.Alive = true
	}
	return msg
}

// servePeek — одно сообщение save_summary и нормальное закрытие. Begin не
// зовётся: живая вкладка этой партии не получает session_taken.
func (h *Handler) servePeek(ctx context.Context, c *websocket.Conn, sid string) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, h.summarize(sid)); err != nil {
		return
	}
	c.Close(websocket.StatusNormalClosure, "")
}
