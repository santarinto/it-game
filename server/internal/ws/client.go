package ws

import (
	"fmt"
	"log"

	"itdirector/internal/metrics"
)

// Тип клиента вкладки (ITGAME-162, эпик мобилки ITGAME-225): вкладка называет
// себя параметром подключения /ws?client=desktop|mobile — рядом с sid и
// difficulty: рукопожатие /ws целиком в query, отдельного hello в протоколе
// нет. Тип знают только лог подключения и метрика itgame_ws_connects_total
// {client}: протокол, снапшот и частота тиков у типов общие, а одна партия
// (sid) с двух типов — как две вкладки: второй сокет забирает сессию
// (session_taken). Мост агента (/ws/agent) и peek меню параметр не читают.
type clientKind string

const (
	clientDesktop = clientKind("desktop")
	clientMobile  = clientKind("mobile")
	// clientUnknown — значение не из протокола. Соединение не рвём и играем как
	// обычно (от типа игра не зависит), но и в desktop не записываем: метрика
	// не врёт, и чужой или сломанный клиент виден. Метка — конечный набор, не
	// сырой текст: сырое значение уходит в лог.
	clientUnknown = clientKind("unknown")
)

// clientKinds — все значения метки client (ряды нулями с init, см. metrics.go).
var clientKinds = []clientKind{clientDesktop, clientMobile, clientUnknown}

// parseClientKind — ?client= подключения. Пусто (параметра нет: вкладки до
// ITGAME-162, скрипты, load-bots) — desktop; desktop и mobile — как есть
// (регистр важен: Mobile — unknown); прочее — unknown.
func parseClientKind(raw string) clientKind {
	switch clientKind(raw) {
	case "", clientDesktop:
		return clientDesktop
	case clientMobile:
		return clientMobile
	default:
		return clientUnknown
	}
}

// clientRawMax — сколько рун сырого client= попадает в лог: query длиной до
// лимита заголовков строку лога раздувать не должен.
const clientRawMax = 32

// connectLine — строка лога о подключении вкладки: тип клиента и, если тип
// не назван явно, что пришло на самом деле — без параметра (старый бандл) или
// чужое значение (%q: перевод строки из query лог не порвёт).
func connectLine(sid, raw string) string {
	k := parseClientKind(raw)
	note := ""
	switch {
	case raw == "":
		note = " (без client=)"
	case k == clientUnknown:
		if r := []rune(raw); len(r) > clientRawMax {
			raw = string(r[:clientRawMax]) + "…"
		}
		note = fmt.Sprintf(" (client=%q)", raw)
	}
	return fmt.Sprintf("сессия %s: вкладка подключена, клиент %s%s", sid, k, note)
}

// countConnect — подключение вкладки /ws: тип клиента в лог и в
// itgame_ws_connects_total{client}.
func countConnect(sid, raw string) {
	metrics.WSConnects.WithLabelValues(string(parseClientKind(raw))).Inc()
	log.Print(connectLine(sid, raw))
}
