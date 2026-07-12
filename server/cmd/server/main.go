package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"itdirector/internal/admin"
	"itdirector/internal/db"
	"itdirector/internal/game"
	"itdirector/internal/ws"
)

func main() {
	addr := flag.String("addr", ":8080", "адрес HTTP-сервера")
	static := flag.String("static", "", "каталог собранного клиента (client/dist); пусто — не раздавать")
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
	mux := http.NewServeMux()
	mux.Handle("GET /ws", &ws.Handler{Config: cfg, TickInterval: time.Second})
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
