package ws

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// Чит денег для localhost (ITGAME-194): POST /api/cheat/money {sid, amount}
// прибавляет amount к балансу живой партии. Маршрут есть всегда, без
// ITGAME_DEBUG, но пускает только локальный запрос (localRequest): прод
// закрыт заголовком X-Real-IP, который nginx бокса ставит на /api/ и /ws.
// Деньги кладёт актор — тем же патчем, что itd.set({money}): снапшот,
// сейв и журнал реплея как у debug-патча (session.go переводит kindCheatMoney
// в kindPatch с абсолютным балансом).

const maxCheatMoney = 10_000_000

// localHost — имя хоста (без порта и скобок IPv6) локальное: localhost,
// 127.0.0.1, ::1 или *.localhost. Одно правило и для Host, и для Origin.
func localHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.Trim(host, "[]"))
	return host == "localhost" || host == "127.0.0.1" || host == "::1" || strings.HasSuffix(host, ".localhost")
}

// localRequest — запрос с этой же машины напрямую, не через прокси:
// loopback-адрес, Host — localhost, 127.0.0.1, ::1 или *.localhost, и ни
// одного заголовка прокси. Второй рубеж — Origin: браузер всегда шлёт его на
// кросс-сайтовом POST, так что страница чужого сайта, открытая у разработчика,
// не достучится до localhost, а запрос из браузера со страницы прода
// (Origin https://itgame.santarinto.ru) отказан, даже если nginx однажды
// перестанет ставить X-Real-IP. Origin есть — его хост тоже должен быть
// локальным; нечитаемый или «null» — не локальный. Origin нет (curl) — как было.
func localRequest(r *http.Request) bool {
	for _, h := range []string{"X-Real-IP", "X-Forwarded-For", "Forwarded"} {
		if r.Header.Get(h) != "" {
			return false
		}
	}
	addr := r.RemoteAddr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		addr = h
	}
	if ip := net.ParseIP(addr); ip == nil || !ip.IsLoopback() {
		return false
	}
	if !localHost(r.Host) {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.Hostname() == "" || !localHost(u.Hostname()) {
			return false
		}
	}
	return true
}

// ServeCheat — POST /api/cheat/money. Отказы — {error} как у /api/debug/*.
func (h *Handler) ServeCheat(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if !localRequest(r) {
		writeDebugErr(w, http.StatusForbidden, "not_local: читы только с localhost")
		return
	}
	var body struct {
		SID    string `json:"sid"`
		Amount int    `json:"amount"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeDebugErr(w, http.StatusBadRequest, "тело не JSON: "+err.Error())
		return
	}
	if body.Amount < 1 || body.Amount > maxCheatMoney {
		writeDebugErr(w, http.StatusBadRequest, "amount — целое 1..10000000")
		return
	}
	rep, _ := h.sendDebug(body.SID, debugRequest{kind: kindCheatMoney, add: body.Amount})
	finishDebug(w, rep)
}
