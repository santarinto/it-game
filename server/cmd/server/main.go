package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"itdirector/internal/admin"
	"itdirector/internal/db"
	"itdirector/internal/game"
	"itdirector/internal/metrics"
	"itdirector/internal/store"
	"itdirector/internal/ws"
)

// resolveSavesDir — каталог сейвов сессий (ITGAME-8): флаг бьёт env, env —
// умолчания. На боксе деплоя сейвы живут в shared/ (переживают смену
// релиза и рестарт юнита), локально — в ./saves у корня репо.
// "off" выключает сейвы (stateless-режим как до итерации 16).
func resolveSavesDir(flagVal string) string {
	switch {
	case flagVal == "off":
		return ""
	case flagVal != "":
		return flagVal
	case os.Getenv("ITGAME_SAVES_DIR") != "":
		return os.Getenv("ITGAME_SAVES_DIR")
	}
	const boxSaves = "/opt/itgame/shared/saves"
	if fi, err := os.Stat(boxSaves); err == nil && fi.IsDir() {
		return boxSaves
	}
	return filepath.Join("saves")
}

func main() {
	addr := flag.String("addr", ":8080", "адрес HTTP-сервера")
	static := flag.String("static", "", "каталог собранного клиента (client/dist); пусто — не раздавать")
	savesDir := flag.String("saves", "", "каталог сейвов сессий; пусто — ITGAME_SAVES_DIR, потом /opt/itgame/shared/saves (если есть), иначе ./saves; off — выключить")
	saveTTL := flag.Duration("save-ttl", 24*time.Hour, "сколько часов сейв сессии ждёт игрока")
	metricsAddr := flag.String("metrics-addr", os.Getenv("ITGAME_METRICS_ADDR"), "адрес отдельного listener'а /metrics (Prometheus); пусто — ITGAME_METRICS_ADDR, нет и его — метрики не отдаются")
	flag.Parse()

	// БД опциональна: геймплей от неё не зависит, каталог читает админка.
	var database *db.DB
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		d, err := db.Connect(ctx, dsn)
		if err != nil {
			log.Fatalf("БД: %v", err)
		}
		if err := d.Migrate(ctx); err != nil {
			log.Fatalf("миграции: %v", err)
		}
		cancel()
		database = d
		defer d.Close()
		log.Printf("БД подключена, миграции применены")
	} else {
		log.Printf("ВНИМАНИЕ: DATABASE_URL не задан — игра работает, админка без каталога")
	}

	debugRoutes := os.Getenv("ITGAME_DEBUG") == "1"
	if debugRoutes {
		log.Printf("ITGAME_DEBUG=1: отладочные маршруты /ws/agent и /api/debug/* включены, журнал партий пишется")
	}

	cfg := game.DefaultConfig()

	// Сейвы сессий: файловый стор, TTL ограничивает и память, и диск.
	var saves *store.Store
	if dir := resolveSavesDir(*savesDir); dir != "" {
		s, err := store.New(dir, *saveTTL)
		if err != nil {
			log.Fatalf("сейвы: %v", err)
		}
		saves = s
		log.Printf("сейвы сессий: %s (TTL %s)", dir, *saveTTL)
	} else {
		log.Printf("сейвы отключены (-saves off): разрыв соединения = новая игра")
	}

	// Таймаут чтения вкладки (ITGAME-76): клиент молчит дольше — сервер
	// считает его ушедшим (обрыв сети без close-фрейма). Go duration: 5s, 1500ms.
	readTimeout := ws.DefaultReadTimeout
	if v := os.Getenv("ITGAME_READ_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			readTimeout = d
		} else {
			log.Printf("ITGAME_READ_TIMEOUT=%q не Go duration > 0 — беру %s", v, readTimeout)
		}
	}
	log.Printf("таймаут чтения вкладки: %s", readTimeout)

	// Метрики (ITGAME-189) — свой listener, не публичный mux: наружу их выводит
	// nginx бокса только для скрейпа Prometheus minipc. Ошибка listener'а
	// игру не роняет.
	if *metricsAddr != "" {
		go func() {
			log.Printf("метрики: слушаю %s/metrics", *metricsAddr)
			log.Printf("метрики: %v", http.ListenAndServe(*metricsAddr, newMetricsMux()))
		}()
	}

	mux := newMux(cfg, database, saves, *static, debugRoutes, readTimeout)
	log.Printf("IT Director: слушаю %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

// newMetricsMux — listener метрик (ITGAME-189): только GET /metrics, сборка
// бинаря в itgame_build_info.
func newMetricsMux() *http.ServeMux {
	metrics.SetBuild(ws.ServerVersion(), ws.BuildVersion())
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", metrics.Handler())
	return mux
}

// newMux — маршруты сервера одним местом (тестируется без запуска main).
// staticDir пуст — статику не раздаём (dev: её раздаёт Vite).
// debugRoutes — гейт отладочных маршрутов (ITGAME_DEBUG=1 в main): выключен
// по умолчанию, флаг передаётся явно параметром (а не читается из env здесь),
// чтобы тесты управляли им напрямую, без глобального состояния.
func newMux(cfg game.Config, database *db.DB, saves *store.Store, staticDir string, debugRoutes bool, readTimeout time.Duration) *http.ServeMux {
	mux := http.NewServeMux()
	// Журнал партии для реплея (ITGAME-46) — под тем же гейтом, что и
	// /api/debug/*: на проде у игроков не пишется.
	wsHandler := &ws.Handler{Config: cfg, TickInterval: time.Second, Saves: saves, ReadTimeout: readTimeout, Journal: debugRoutes}
	mux.Handle("GET /ws", wsHandler)
	if debugRoutes {
		// WS-мост агента (ITGAME-29) и HTTP debug-API (ITGAME-26): только
		// при ITGAME_DEBUG=1. Без флага маршруты не регистрируются вовсе —
		// значит честный 404 у ServeMux, а не отказ внутри хендлера.
		mux.Handle("GET /ws/agent", http.HandlerFunc(wsHandler.ServeAgent))
		mux.Handle("/api/debug/", http.HandlerFunc(wsHandler.ServeDebug))
	}
	mux.Handle("GET /admin", &admin.Handler{Config: cfg, DB: database})
	// Штамп сборки (ITGAME-78): sha бинаря сервера для itd.stale() и метки
	// «устарело» у владельца; version — версия сборки год.мес.день.час.мин для людей
	// (ITGAME-140; сейвы сверяются по формату, ITGAME-169), "" — без версии. Без гейта: sha
	// открытого репо — не секрет.
	mux.Handle("GET /api/version", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]string{"sha": ws.ServerVersion(), "version": ws.BuildVersion()})
	}))
	if staticDir != "" {
		files := http.FileServer(http.Dir(staticDir))
		// Sourcemaps (ITGAME-28): бандл собирается с sourcemap:'hidden' —
		// карты лежат рядом с ассетами, но наружу не отдаются. Гейт —
		// ITGAME_SOURCEMAP_TOKEN: пустой токен = карты выключены совсем,
		// иначе нужен ?token=. Ассеты без .map раздаются как раньше,
		// отсутствующие — честный 404 FileServer'а (без SPA-фолбэка).
		mux.Handle("/assets/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, ".map") {
				tok := os.Getenv("ITGAME_SOURCEMAP_TOKEN")
				if tok == "" || r.URL.Query().Get("token") != tok {
					http.NotFound(w, r)
					return
				}
			}
			files.ServeHTTP(w, r)
		}))
		mux.Handle("/", files)
	}
	return mux
}
