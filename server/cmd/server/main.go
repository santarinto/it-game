package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"itdirector/internal/admin"
	"itdirector/internal/db"
	"itdirector/internal/game"
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

	mux := http.NewServeMux()
	wsHandler := &ws.Handler{Config: cfg, TickInterval: time.Second, Saves: saves}
	mux.Handle("GET /ws", wsHandler)
	// /api/debug/* без гейта до прода: dev-сервер локальный (решение
	// владельца, ITGAME-26). Перед релизом закрыть админ-токеном/env-флагом.
	mux.Handle("/api/debug/", http.HandlerFunc(wsHandler.ServeDebug))
	mux.Handle("GET /admin", &admin.Handler{Config: cfg, DB: database})
	if *static != "" {
		if _, err := os.Stat(*static); err != nil {
			log.Fatalf("каталог статики: %v", err)
		}
		mux.Handle("/", http.FileServer(http.Dir(*static)))
	}

	log.Printf("IT Director: слушаю %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
