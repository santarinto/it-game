package db

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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

// Параллельные миграции на пустой схеме (ITGAME-228): без блокировки два CREATE одной
// таблицы сталкивались в pg_type (duplicate key, SQLSTATE 23505) — так упал CI на eb0b7ea,
// когда оборванная таймаутом миграция TestOpenLive ещё шла в Postgres, а следующий тест
// начал свою. Схема своя на прогон: в общей базе миграции давно применены.
func TestMigrateConcurrent(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL не задан — пропускаем интеграционный тест БД")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, err := Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("itd_migrate_%d", time.Now().UnixNano())
	if _, err := admin.Pool.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("CREATE SCHEMA: %v", err)
	}
	defer admin.Pool.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	const n = 4
	errs := make(chan error, n)
	for range n {
		go func() {
			pool, err := pgxpool.NewWithConfig(ctx, cfg)
			if err != nil {
				errs <- err
				return
			}
			defer pool.Close()
			errs <- (&DB{Pool: pool}).Migrate(ctx)
		}()
	}
	for range n {
		if err := <-errs; err != nil {
			t.Errorf("Migrate: %v", err)
		}
	}
	files, _ := migrationsFS.ReadDir("migrations")
	var applied int
	if err := admin.Pool.QueryRow(ctx, "SELECT count(*) FROM "+schema+".schema_migrations").Scan(&applied); err != nil {
		t.Fatalf("schema_migrations: %v", err)
	}
	if applied != len(files) {
		t.Errorf("в schema_migrations %d записей, миграций %d", applied, len(files))
	}
}
