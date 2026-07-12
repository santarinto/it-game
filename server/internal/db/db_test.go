package db

import (
	"context"
	"os"
	"testing"
	"time"
)

// Интеграционный тест против реальной БД из TEST_DATABASE_URL —
// отдельная переменная, чтобы тесты никогда не ходили в живую базу
// сервера. Без переменной тест пропускается — CI без постгреса зелёный.
func TestMigrateAndListEquipment(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL не задан — пропускаем интеграционный тест БД")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	d, err := Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer d.Close()

	// Миграции идемпотентны: повторный прогон не должен падать.
	for i := 0; i < 2; i++ {
		if err := d.Migrate(ctx); err != nil {
			t.Fatalf("Migrate (прогон %d): %v", i+1, err)
		}
	}

	items, err := d.ListEquipment(ctx)
	if err != nil {
		t.Fatalf("ListEquipment: %v", err)
	}
	if len(items) < 9 {
		t.Errorf("в справочнике %d записей, хотим ≥9 (сид всего оборудования)", len(items))
	}
	seen := map[string]bool{}
	for _, it := range items {
		if it.Name == "" || it.LocaleToken == "" {
			t.Errorf("пустые поля в записи: %+v", it)
		}
		if seen[it.LocaleToken] {
			t.Errorf("дубль locale_token: %s", it.LocaleToken)
		}
		seen[it.LocaleToken] = true
	}
	for _, token := range []string{"equipment.pc", "equipment.router_t3", "equipment.cooler", "equipment.coffee_machine"} {
		if !seen[token] {
			t.Errorf("нет ожидаемого токена %s", token)
		}
	}
}
