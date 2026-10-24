package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"itdirector/internal/db"
	"itdirector/internal/game"
	"itdirector/internal/spriteproxy"
	"itdirector/internal/store"
)

// Сквозь newMux (ITGAME-239): база и сейвы есть — партия вкладки встаёт
// строкой parties под хэшем sid. Против TEST_DATABASE_URL, без неё — пропуск.
func TestPartyReachesDatabase(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL не задан — пропускаем сквозной тест партий")
	}
	conn := db.Open(dsn, log.Printf)
	t.Cleanup(conn.Close)
	saves, err := store.New(t.TempDir(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newMux(game.DefaultConfig(), conn, saves, "", false, 0, spriteproxy.Upstream{}))
	t.Cleanup(srv.Close)

	sid := fmt.Sprintf("e2e-party-%d", time.Now().UnixNano())
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?sid="+sid+"&difficulty=hard", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()

	sum := sha256.Sum256([]byte(sid))
	hash := hex.EncodeToString(sum[:])
	d, err := conn.Get()
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var difficulty, client string
		err := d.Pool.QueryRow(ctx, `SELECT difficulty, client FROM parties WHERE sid_hash = $1`, hash).Scan(&difficulty, &client)
		if err == nil {
			if difficulty != "hard" || client != "desktop" {
				t.Fatalf("строка партии: %s/%s, хотим hard/desktop", difficulty, client)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("партии нет в базе за 5 с: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	var raw int
	if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM parties WHERE sid_hash = $1`, sid).Scan(&raw); err != nil || raw != 0 {
		t.Fatalf("сырой sid в базе: %d строк (%v)", raw, err)
	}
}
