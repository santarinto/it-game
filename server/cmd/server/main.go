package main

import (
	"flag"
	"log"
	"net/http"
)

func main() {
	addr := flag.String("addr", ":8080", "адрес HTTP-сервера")
	flag.Parse()

	mux := http.NewServeMux() // маршруты появятся в следующих задачах
	log.Printf("IT Director: слушаю %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
