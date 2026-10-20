package main

import (
	"encoding/json"
	"io"
	"itdirector/internal/game"
	"itdirector/internal/ws"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Статика и sourcemaps (ITGAME-28): честные 404 на отсутствующие ассеты,
// .map только за ITGAME_SOURCEMAP_TOKEN.

func writeStatic(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	assets := filepath.Join(dir, "assets")
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, "app.js"), []byte("bundle"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, "app.js.map"), []byte(`{"version":3}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestStaticHonest404(t *testing.T) {
	srv := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, writeStatic(t), false, 0))
	t.Cleanup(srv.Close)

	// существующий ассет — отдаётся
	resp, err := http.Get(srv.URL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("app.js: %d", resp.StatusCode)
	}

	// отсутствующий ассет — честный 404, не HTML-фолбэк: агент отличает
	// битую ссылку от рабочей (nginx бокса сейчас отдаёт index.html —
	// фикс в docs/development.md, раздел Deploy).
	resp, _ = http.Get(srv.URL + "/assets/nope-xyz.png")
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("отсутствующий ассет: %d, ожидался 404", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct == "text/html" {
		t.Fatal("404 не должен быть HTML-фолбэком")
	}
}

func TestSourcemapGate(t *testing.T) {
	srv := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, writeStatic(t), false, 0))
	t.Cleanup(srv.Close)
	get := func(url string) *http.Response {
		resp, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}

	// токен не задан — карты выключены совсем
	if resp := get(srv.URL + "/assets/app.js.map"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("без ITGAME_SOURCEMAP_TOKEN карта должна быть 404, получила %d", resp.StatusCode)
	}

	// токен задан, запрос без него — 404
	t.Setenv("ITGAME_SOURCEMAP_TOKEN", "sekret")
	if resp := get(srv.URL + "/assets/app.js.map"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("без ?token= карта должна быть 404, получила %d", resp.StatusCode)
	}

	// токен совпал — карта отдаётся
	if resp := get(srv.URL + "/assets/app.js.map?token=sekret"); resp.StatusCode != http.StatusOK {
		t.Fatalf("с верным токеном карта должна отдаться, получила %d", resp.StatusCode)
	}

	// мусорный токен — 404
	if resp := get(srv.URL + "/assets/app.js.map?token=nope"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("с чужим токеном карта должна быть 404, получила %d", resp.StatusCode)
	}

	// обычный ассет токена не требует
	if resp := get(srv.URL + "/assets/app.js"); resp.StatusCode != http.StatusOK {
		t.Fatalf("app.js не должен требовать токен: %d", resp.StatusCode)
	}
}

// TestDebugRoutesGate — ITGAME_DEBUG=1 включает /ws/agent и /api/debug/*,
// без флага (значение false) ServeMux их не регистрирует, и запрос падает
// на честный 404 самого мультиплексора, а не на отказ внутри хендлера.
func TestDebugRoutesGate(t *testing.T) {
	srvOff := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, "", false, 0))
	t.Cleanup(srvOff.Close)

	if resp, err := http.Get(srvOff.URL + "/api/debug/fixtures"); err != nil {
		t.Fatal(err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("без ITGAME_DEBUG /api/debug/fixtures: %d, ожидался 404", resp.StatusCode)
		}
	}

	// Debug-обрыв (ITGAME-76) — под тем же гейтом: без флага рвать нельзя.
	if resp, err := http.Post(srvOff.URL+"/api/debug/drop?sid=gate-12345", "application/json", nil); err != nil {
		t.Fatal(err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("без ITGAME_DEBUG /api/debug/drop: %d, ожидался 404", resp.StatusCode)
		}
	}

	// /ws/agent без флага не зарегистрирован вовсе — обычный GET (без
	// апгрейда до WS) на незарегистрированный путь тоже даёт 404.
	if resp, err := http.Get(srvOff.URL + "/ws/agent"); err != nil {
		t.Fatal(err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("без ITGAME_DEBUG /ws/agent: %d, ожидался 404", resp.StatusCode)
		}
	}

	srvOn := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, "", true, 0))
	t.Cleanup(srvOn.Close)

	if resp, err := http.Get(srvOn.URL + "/api/debug/fixtures"); err != nil {
		t.Fatal(err)
	} else {
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			t.Fatalf("с ITGAME_DEBUG=1 /api/debug/fixtures не должен быть 404")
		}
	}
}

// GET /api/version (ITGAME-78): sha сервера без гейта ITGAME_DEBUG, JSON, no-store.
func TestVersionEndpoint(t *testing.T) {
	srv := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, "", false, 0))
	t.Cleanup(srv.Close)
	resp, err := http.Get(srv.URL + "/api/version")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/api/version: %d", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control: %q", cc)
	}
	var body struct {
		SHA string `json:"sha"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.SHA == "" {
		t.Fatal("sha пустой — ожидался sha бинаря или unknown")
	}
	if want := ws.ServerVersion(); body.SHA != want {
		t.Fatalf("/api/version sha %q, want ws.ServerVersion() %q", body.SHA, want)
	}
}

// Метрики (ITGAME-189) — на своём mux для отдельного listener'а: /metrics
// отдаёт сборку бинаря; основной mux (публичный за nginx) маршрута не знает.
func TestMetricsMux(t *testing.T) {
	srv := httptest.NewServer(newMetricsMux())
	t.Cleanup(srv.Close)
	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/metrics: %d", resp.StatusCode)
	}
	if want := `itgame_build_info{sha="` + ws.ServerVersion() + `"`; !strings.Contains(string(body), want) {
		t.Fatalf("в /metrics нет %s", want)
	}

	pub := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, "", false, 0))
	t.Cleanup(pub.Close)
	if resp, err := http.Get(pub.URL + "/metrics"); err != nil {
		t.Fatal(err)
	} else if resp.Body.Close(); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("основной mux /metrics: %d, ожидался 404", resp.StatusCode)
	}
}
