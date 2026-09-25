package main

import (
	"itdirector/internal/game"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	srv := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, writeStatic(t)))
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
	srv := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, writeStatic(t)))
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
