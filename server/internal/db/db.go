// Package db — подключение к PostgreSQL, миграции и запросы.
// Геймплей от БД не зависит: справочники читает только админка.
package db

import (
	"context"
	"embed"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// DB — пул соединений и запросы приложения.
type DB struct {
	Pool *pgxpool.Pool
}

// Connect открывает пул и проверяет соединение.
func Connect(ctx context.Context, dsn string) (*DB, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("пул: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &DB{Pool: pool}, nil
}

func (d *DB) Close() { d.Pool.Close() }

// Migrate применяет embed-миграции по порядку имён файлов.
// Версия = имя файла; применённые хранятся в schema_migrations.
func (d *DB) Migrate(ctx context.Context) error {
	if _, err := d.Pool.Exec(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY)`); err != nil {
		return fmt.Errorf("schema_migrations: %w", err)
	}
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		var exists bool
		if err := d.Pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, name).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := d.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("миграция %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

// Equipment — запись справочника оборудования.
type Equipment struct {
	ID          int
	Name        string
	LocaleToken string
}

// ListEquipment возвращает каталог оборудования по порядку id.
func (d *DB) ListEquipment(ctx context.Context) ([]Equipment, error) {
	rows, err := d.Pool.Query(ctx,
		`SELECT id, name, locale_token FROM lib_equipment ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Equipment
	for rows.Next() {
		var e Equipment
		if err := rows.Scan(&e.ID, &e.Name, &e.LocaleToken); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
