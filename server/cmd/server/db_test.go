package main

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestMainProcess — не тест, а точка входа дочернего процесса для тестов
// main(): под ITGAME_TEST_MAIN=1 запускает настоящий main() с флагами из
// ITGAME_TEST_MAIN_ARGS. Без переменной пропускается.
func TestMainProcess(t *testing.T) {
	if os.Getenv("ITGAME_TEST_MAIN") != "1" {
		t.Skip("точка входа дочернего процесса")
	}
	os.Args = append([]string{os.Args[0]}, strings.Fields(os.Getenv("ITGAME_TEST_MAIN_ARGS"))...)
	main()
}

// TestStartsWithDatabaseDown — ITGAME-190: DATABASE_URL задан, а PostgreSQL
// не отвечает (рестарт юнита при лежащей базе). Сервер не падает: игра
// отвечает, /admin вместо каталога пишет «БД недоступна». До фикса main()
// выходил по log.Fatalf, и systemd крутил его в Restart=on-failure.
func TestStartsWithDatabaseDown(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()

	// -test.timeout: ребёнок не переживёт родителя, даже если тот упадёт мимо stop.
	cmd := exec.Command(os.Args[0], "-test.run=^TestMainProcess$", "-test.timeout=1m")
	cmd.Env = append(os.Environ(),
		"ITGAME_TEST_MAIN=1",
		"ITGAME_TEST_MAIN_ARGS=-addr "+addr+" -saves off",
		// Порт 1 закрыт: ping отказывает сразу, без ожидания таймаута.
		"DATABASE_URL=postgres://itd:itd@127.0.0.1:1/itdirector?connect_timeout=2",
		"ITGAME_METRICS_ADDR=",
		"ITGAME_DEBUG=",
	)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	var waitErr error
	go func() { waitErr = cmd.Wait(); close(exited) }()
	var once sync.Once
	stop := func() string {
		once.Do(func() {
			cmd.Process.Kill()
			<-exited
		})
		return out.String()
	}
	t.Cleanup(func() { stop() })

	base := "http://" + addr
	deadline := time.Now().Add(10 * time.Second)
	for {
		select {
		case <-exited:
			t.Fatalf("сервер вышел при недоступной БД: %v\n%s", waitErr, out.String())
		default:
		}
		if resp, err := http.Get(base + "/api/version"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("сервер не ответил на /api/version за 10 с\n%s", stop())
		}
		time.Sleep(50 * time.Millisecond)
	}

	resp, err := http.Get(base + "/admin")
	if err != nil {
		t.Fatalf("/admin: %v\n%s", err, stop())
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "БД недоступна") {
		t.Fatalf("/admin: %d, ожидалась страница с «БД недоступна»\n%s\n--- лог сервера:\n%s", resp.StatusCode, body, stop())
	}
}
