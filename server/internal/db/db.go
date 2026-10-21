// Package db — подключение к PostgreSQL, миграции и запросы.
// Геймплей от БД не зависит: справочники читает только админка.
package db

import (
	"context"
	"embed"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
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

// migrateLockKey — ключ pg_advisory_xact_lock миграций (ITGAME-228): два мигратора
// одной базы (два экземпляра на старте; тест после попытки, оборванной таймаутом,
// пока её транзакция ещё идёт в Postgres) встают в очередь, а не создают одни и те
// же таблицы разом — тогда второй CREATE падал duplicate key в pg_type (SQLSTATE
// 23505), и IF NOT EXISTS от этого не спасает.
const migrateLockKey int64 = 0x6974_6469_726d_6967 // "itdirmig"

// Migrate применяет embed-миграции по порядку имён файлов.
// Версия = имя файла; применённые хранятся в schema_migrations. Каждая миграция —
// своя транзакция под блокировкой, и применённость проверяется уже под ней.
func (d *DB) Migrate(ctx context.Context) error {
	if err := d.lockedTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY)`)
		return err
	}); err != nil {
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
		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if err := d.lockedTx(ctx, func(tx pgx.Tx) error {
			var exists bool
			if err := tx.QueryRow(ctx,
				`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, name).Scan(&exists); err != nil {
				return err
			}
			if exists {
				return nil
			}
			if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
				return fmt.Errorf("миграция %s: %w", name, err)
			}
			_, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name)
			return err
		}); err != nil {
			return err
		}
	}
	return nil
}

// lockedTx — fn в транзакции под pg_advisory_xact_lock(migrateLockKey). Блокировка
// транзакционная: снимается коммитом, откатом или обрывом соединения, в пуле не
// остаётся никогда.
func (d *DB) lockedTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // после Commit — no-op
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrateLockKey); err != nil {
		return fmt.Errorf("блокировка миграций: %w", err)
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
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
