package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func scrape(t *testing.T) string {
	t.Helper()
	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics: %d", rec.Code)
	}
	return rec.Body.String()
}

// Скрейп отдаёт метрики игры и рантайма Go в текстовом формате Prometheus.
func TestHandlerExposesGameAndRuntime(t *testing.T) {
	SetBuild("abc1234", "26.10.20.12.00")
	body := scrape(t)
	for _, want := range []string{
		`itgame_build_info{sha="abc1234",version="26.10.20.12.00"} 1`,
		"# TYPE itgame_ws_connections gauge",
		"# TYPE itgame_sessions_live gauge",
		"# TYPE itgame_tick_seconds histogram",
		"# TYPE itgame_save_seconds histogram",
		"# TYPE itgame_parties_resumed_total counter",
		"# TYPE itgame_session_takeovers_total counter",
		"# TYPE itgame_ws_read_timeouts_total counter",
		"go_goroutines",
		"process_resident_memory_bytes",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("в скрейпе нет %q", want)
		}
	}
}

// Сборка одна на процесс: повторный SetBuild заменяет метки, а не копит ряды.
func TestSetBuildReplaces(t *testing.T) {
	SetBuild("old0000", "1")
	SetBuild("new1111", "2")
	body := scrape(t)
	if strings.Contains(body, `sha="old0000"`) {
		t.Fatal("старая сборка осталась в itgame_build_info")
	}
	if !strings.Contains(body, `itgame_build_info{sha="new1111",version="2"} 1`) {
		t.Fatal("новой сборки нет в itgame_build_info")
	}
}
