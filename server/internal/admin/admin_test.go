package admin

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"itdirector/internal/game"
)

func TestAdminPageWithoutDB(t *testing.T) {
	h := &Handler{Config: game.DefaultConfig(), DB: nil}
	srv := httptest.NewServer(h)
	defer srv.Close()

	resp, err := srv.Client().Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	page := string(body)
	for _, want := range []string{"Конфигурация игры", "Зарплата сотрудника", "250", "Цена ПК", "500", "БД недоступна"} {
		if !strings.Contains(page, want) {
			t.Errorf("на странице нет %q", want)
		}
	}
}
