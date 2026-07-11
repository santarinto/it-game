package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"itdirector/internal/game"
	"itdirector/internal/ws"
)

func main() {
	addr := flag.String("addr", ":8080", "адрес HTTP-сервера")
	static := flag.String("static", "", "каталог собранного клиента (client/dist); пусто — не раздавать")
	flag.Parse()

	mux := http.NewServeMux()
	mux.Handle("GET /ws", &ws.Handler{Config: game.DefaultConfig(), TickInterval: time.Second})
	if *static != "" {
		if _, err := os.Stat(*static); err != nil {
			log.Fatalf("каталог статики: %v", err)
		}
		mux.Handle("/", http.FileServer(http.Dir(*static)))
	}

	log.Printf("IT Director: слушаю %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
