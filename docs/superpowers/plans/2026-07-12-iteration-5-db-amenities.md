# Итерация 5: PostgreSQL, админка, быт-устройства — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PostgreSQL со справочником `lib_equipment` и embed-миграциями, страница-админка с конфигом и каталогом, быт-устройства (кулер/холодильник/кофеварка) с баффами/дебаффами выработки в тултипах.

**Architecture:** Новые пакеты `internal/db` (pgxpool + миграции + запросы) и `internal/admin` (server-rendered html/template). Геймплей от БД не зависит: каталог читает только админка, баланс остаётся в `config.go`. Домен: эффекты как множитель личной выработки (на лету из тика дня + `Employee.CoffeeUntil`), доход и прогноз считаются по-тиково через общий `incomeAtTick`. Протокол ломается мягко (только добавления). Спека: `docs/superpowers/specs/2026-07-12-iteration-5-design.md`.

**Tech Stack:** Go (pgx/v5, html/template, embed), PostgreSQL, TypeScript + Phaser 3 + Vite.

## Global Constraints

- Ветка `iteration-5` от `main` (создать перед Task 1: `git checkout -b iteration-5`).
- Комментарии — по-русски; коммиты — conventional commits по-русски.
- Числа баланса ТОЛЬКО в `config.go`: кулер $400, холодильник $600, кофеварка $800; жажда ×0.9 (без кулера, с тика 12 = 2 часа работы), голоден ×0.9 (без холодильника, с тика 30 = после обеда), кофе ×1.15 на 6 тиков, шанс 40%, два события в день (первая половина [0..23], вторая [30..53]).
- Порядок: `личная_выработка × эффекты`, затем сетевой множитель подключённым, округление одно в конце на сотрудника.
- DSN — ТОЛЬКО env `DATABASE_URL`; задан → ping+миграции, ошибка = fail fast; не задан → warning, игра работает, админка показывает «БД недоступна». `.env` в `.gitignore`.
- Коды ошибок: новая `equipment_already`. Протокол зеркалится protocol.go ↔ protocol.ts.
- Тесты БД — интеграционные со `skip` без `DATABASE_URL` (CI без БД зелёный). Перед коммитами задач 4 и 5 — `go test -race ./...`.
- Деньги в UI — через `fmtMoney`.

---

### Task 1: Пакет db — pgx, миграции, lib_equipment

**Files:**
- Create: `server/internal/db/db.go`, `server/internal/db/migrations/0001_lib_equipment.sql`, `server/internal/db/migrations/0002_seed_lib_equipment.sql`
- Modify: `server/go.mod` (pgx/v5), `.gitignore` (`.env`)
- Test: `server/internal/db/db_test.go`

**Interfaces:**
- Produces: `type DB struct { Pool *pgxpool.Pool }`; `Connect(ctx context.Context, dsn string) (*DB, error)` (пул + ping); `(*DB) Migrate(ctx context.Context) error`; `(*DB) Close()`; `type Equipment struct { ID int; Name string; LocaleToken string }`; `(*DB) ListEquipment(ctx context.Context) ([]Equipment, error)`.

- [ ] **Step 1: Зависимость и .gitignore**

```bash
cd server && go get github.com/jackc/pgx/v5@latest
```

В `.gitignore` (корень репо) добавить строку `.env`.

- [ ] **Step 2: Написать интеграционный тест (skip без БД)**

Создать `server/internal/db/db_test.go`:

```go
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
```

- [ ] **Step 3: Миграции**

`server/internal/db/migrations/0001_lib_equipment.sql`:

```sql
CREATE TABLE IF NOT EXISTS lib_equipment (
    id serial PRIMARY KEY,
    name text NOT NULL,
    locale_token text NOT NULL UNIQUE
);
```

`server/internal/db/migrations/0002_seed_lib_equipment.sql`:

```sql
INSERT INTO lib_equipment (name, locale_token) VALUES
    ('Персональный компьютер', 'equipment.pc'),
    ('Роутер базовый',         'equipment.router_t1'),
    ('Роутер офисный',         'equipment.router_t2'),
    ('Роутер расширенный',     'equipment.router_t3'),
    ('Сервер',                 'equipment.server'),
    ('Шлюз в интернет',        'equipment.gateway'),
    ('Кулер с водой',          'equipment.cooler'),
    ('Холодильник',            'equipment.fridge'),
    ('Кофеварка',              'equipment.coffee_machine')
ON CONFLICT (locale_token) DO NOTHING;
```

- [ ] **Step 4: db.go**

```go
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
```

- [ ] **Step 5: Прогнать (с БД, если DATABASE_URL доступен контроллеру — иначе только сборка + skip)**

Run: `cd server && go mod tidy && go build ./... && go test ./internal/db/`
Expected: PASS (или SKIP без DATABASE_URL; с заданным DSN — полный прогон).

- [ ] **Step 6: Commit**

```bash
git add server/ .gitignore
git commit -m "feat(db): pgx, embed-миграции и справочник lib_equipment"
```

---

### Task 2: Админка end-to-end

**Files:**
- Create: `server/internal/admin/admin.go`, `server/internal/admin/page.html`
- Modify: `server/cmd/server/main.go`, `client/index.html`, `client/vite.config.ts`
- Test: `server/internal/admin/admin_test.go`

**Interfaces:**
- Consumes: `db.DB`/`db.ListEquipment` (Task 1), `game.DefaultConfig()`.
- Produces: `admin.Handler{Config game.Config, DB *db.DB}` (DB nil = «БД недоступна»), `GET /admin`; main.go читает `DATABASE_URL` (fail fast при ошибке подключения/миграций, warning если пуст); ссылка «Админка» в шапке клиента; vite-proxy `/admin` → :8080.

- [ ] **Step 1: Написать падающий тест**

Создать `server/internal/admin/admin_test.go`:

```go
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
```

(Цены быт-устройств появятся в configRows в Task 3 — там же дополняется маппинг.)

- [ ] **Step 2: RED**

Run: `cd server && go test ./internal/admin/`
Expected: FAIL — пакета нет.

- [ ] **Step 3: Реализация admin.go + page.html**

`server/internal/admin/page.html`:

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>IT Director — админка</title>
<style>
  body { font-family: monospace; background: #1a1c2c; color: #f4f4f4; padding: 24px; }
  h1, h2 { color: #ffcd75; }
  table { border-collapse: collapse; margin-bottom: 24px; }
  td, th { border: 1px solid #3a3f5c; padding: 4px 12px; text-align: left; }
  th { color: #41a6f6; }
  .err { color: #b13e53; }
</style>
</head>
<body>
<h1>IT Director — админка</h1>
<h2>Конфигурация игры</h2>
<table>
  <tr><th>Параметр</th><th>Значение</th></tr>
  {{range .ConfigRows}}<tr><td>{{.Label}}</td><td>{{.Value}}</td></tr>{{end}}
</table>
<h2>Каталог оборудования (lib_equipment)</h2>
{{if .DBError}}<p class="err">БД недоступна: {{.DBError}}</p>{{else}}
<table>
  <tr><th>id</th><th>name</th><th>locale_token</th></tr>
  {{range .Equipment}}<tr><td>{{.ID}}</td><td>{{.Name}}</td><td>{{.LocaleToken}}</td></tr>{{end}}
</table>
{{end}}
</body>
</html>
```

`server/internal/admin/admin.go`:

```go
// Package admin — служебная страница: конфигурация игры и справочники БД.
package admin

import (
	_ "embed"
	"fmt"
	"html/template"
	"net/http"

	"itdirector/internal/db"
	"itdirector/internal/game"
)

//go:embed page.html
var pageHTML string

var page = template.Must(template.New("admin").Parse(pageHTML))

// Handler отдаёт страницу админки. DB может быть nil — тогда каталог
// заменяется сообщением «БД недоступна».
type Handler struct {
	Config game.Config
	DB     *db.DB
}

type row struct {
	Label string
	Value any
}

type pageData struct {
	ConfigRows []row
	Equipment  []db.Equipment
	DBError    string
}

// configRows — явный маппинг конфига с русскими подписями.
// Reflection не используем: подписи важнее автоматики.
func configRows(c game.Config) []row {
	rows := []row{
		{"Стартовые деньги", c.StartMoney},
		{"Стартовые ПК", c.StartPCs},
		{"Слотов офиса", c.OfficeSlots},
		{"Потолок штата без начальника", c.StaffLimit},
		{"Стоек серверной", c.RackSlots},
		{"Цена ПК", c.PCPrice},
		{"Цена найма", c.HirePrice},
		{"Цена сервера", c.ServerPrice},
		{"Выработка сотрудника, $/тик", fmt.Sprintf("%d–%d", c.IncomeMin, c.IncomeMax)},
		{"База множителя сети", c.NetworkBase},
		{"Бонус за сервер", c.ServerBonus},
		{"Тиков в часе", c.TicksPerHour},
		{"Рабочий день", fmt.Sprintf("%02d:00–%02d:00", c.WorkdayStart, c.WorkdayEnd)},
		{"Обед", fmt.Sprintf("%02d:00–%02d:00", c.LunchStart, c.LunchEnd)},
		{"Зарплата сотрудника", c.SalaryPerDay},
		{"Найм начальника", c.BossPrice},
		{"Зарплата начальника", c.BossSalaryPerDay},
		{"Цены офисов 2–3", fmt.Sprintf("%v", c.OfficePrices)},
		{"Шлюз: цена", c.GatewayPrice},
		{"Шлюз: опекс в день", c.GatewayOpexPerDay},
		{"Шлюз: множитель", c.GatewayBonus},
	}
	for i, t := range c.RouterTiers {
		rows = append(rows, row{fmt.Sprintf("Роутер тир %d", i+1), fmt.Sprintf("$%d, портов: %d", t.Price, t.Ports)})
	}
	return rows
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	data := pageData{ConfigRows: configRows(h.Config)}
	if h.DB == nil {
		data.DBError = "DATABASE_URL не задан"
	} else {
		items, err := h.DB.ListEquipment(r.Context())
		if err != nil {
			data.DBError = err.Error()
		} else {
			data.Equipment = items
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := page.Execute(w, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
```

(Task 3 добавит поля цен устройств быта — дополнить configRows там же тремя строками: «Кулер», «Холодильник», «Кофеварка».)

- [ ] **Step 4: main.go**

Заменить `server/cmd/server/main.go` целиком:

```go
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
```

- [ ] **Step 5: Makefile — подхват .env**

В начало `Makefile` (после .PHONY) добавить:

```make
# .env (DATABASE_URL) подхватывается автоматически; файла может не быть.
-include .env
export DATABASE_URL TEST_DATABASE_URL
```

Проверка: `make dev-server` при существующем `.env` должен логировать «БД подключена, миграции применены». (`.env` уже создан контроллером и добавлен в `.gitignore` — НЕ коммитить.)

- [ ] **Step 6: Клиент — ссылка и vite-proxy**

`client/index.html` — заменить body-часть:

```html
  <body>
    <div id="topbar"><a href="/admin" target="_blank">Админка</a></div>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
```

и в `<style>` добавить:

```css
      #topbar { text-align: right; padding: 4px 16px; }
      #topbar a { color: #5d7275; font-family: monospace; font-size: 13px; text-decoration: none; }
      #topbar a:hover { color: #41a6f6; }
```

`client/vite.config.ts` — рядом с proxy для `/ws` добавить `'/admin': 'http://localhost:8080'` (посмотреть фактическую структуру proxy в файле и повторить стиль).

- [ ] **Step 6: GREEN + ручная проверка**

Run: `cd server && go test ./internal/admin/ && go build ./...`; `cd client && npm run typecheck`.
Expected: PASS. Вручную: `DATABASE_URL=... go run ./cmd/server` → `curl -s localhost:8080/admin | grep Кулер` (после Task 1 сид уже в БД).

- [ ] **Step 7: Commit**

```bash
git add server/ client/index.html client/vite.config.ts
git commit -m "feat(admin): страница конфигурации и каталога, ссылка в шапке"
```

---

### Task 3: Домен — быт-устройства и команды покупки

**Files:**
- Modify: `server/internal/game/config.go`, `server/internal/game/office.go`, `server/internal/game/commands.go`, `server/internal/admin/admin.go` (3 строки configRows)
- Test: `server/internal/game/amenities_test.go` (новый)

**Interfaces:**
- Produces: конфиг `CoolerPrice 400, FridgePrice 600, CoffeeMachinePrice 800`; `Office.Cooler/Fridge/CoffeeMachine bool`; `ErrEquipmentAlready = Err("equipment_already")`; команды `CmdBuyCooler = Command("buy_cooler")`, `CmdBuyFridge = Command("buy_fridge")`, `CmdBuyCoffee = Command("buy_coffee")`; методы `BuyCooler/BuyFridge/BuyCoffeeMachine(office int) error`; Apply маршрутизирует.

- [ ] **Step 1: Написать падающие тесты**

Создать `server/internal/game/amenities_test.go`:

```go
package game

import "testing"

func TestBuyAmenities(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 10000
	if err := g.BuyCooler(0); err != nil {
		t.Fatalf("кулер: %v", err)
	}
	if err := g.BuyFridge(0); err != nil {
		t.Fatalf("холодильник: %v", err)
	}
	if err := g.BuyCoffeeMachine(0); err != nil {
		t.Fatalf("кофеварка: %v", err)
	}
	o := g.Offices[0]
	if !o.Cooler || !o.Fridge || !o.CoffeeMachine {
		t.Errorf("устройства не установились: %+v", o)
	}
	if g.Money != 10000-400-600-800 {
		t.Errorf("Money = %d, хотим 8200", g.Money)
	}
	if err := g.BuyCooler(0); err != ErrEquipmentAlready {
		t.Errorf("повторный кулер: %v, хотим %v", err, ErrEquipmentAlready)
	}
}

func TestBuyAmenityValidation(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 10000
	if err := g.BuyCooler(1); err != ErrOfficeLocked {
		t.Errorf("кулер в закрытый офис: %v, хотим %v", err, ErrOfficeLocked)
	}
	g2 := New(DefaultConfig())
	g2.Money = 100
	if err := g2.BuyFridge(0); err != ErrNotEnoughMoney {
		t.Errorf("холодильник без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
}

func TestApplyAmenities(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 10000
	for _, cmd := range []Command{CmdBuyCooler, CmdBuyFridge, CmdBuyCoffee} {
		if err := g.Apply(cmd, 0); err != nil {
			t.Errorf("Apply(%s): %v", cmd, err)
		}
	}
	g.Phase = PhaseDayReport
	if err := g.Apply(CmdBuyCooler, 0); err != ErrWrongPhase {
		t.Errorf("покупка в day_report: %v, хотим %v", err, ErrWrongPhase)
	}
}
```

- [ ] **Step 2: RED**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — undefined.

- [ ] **Step 3: Реализация**

`config.go` — в `Config` после `GatewayBonus`:

```go
	CoolerPrice        int // кулер: без него жажда −10% с 2 часов работы
	FridgePrice        int // холодильник: без него голод −10% после обеда
	CoffeeMachinePrice int // кофеварка: случайный бафф кофе дважды в день
```

в `DefaultConfig()`:

```go
		CoolerPrice:        400,
		FridgePrice:        600,
		CoffeeMachinePrice: 800,
```

`office.go` — в `Office` после `BossUnpaidToday`:

```go
	Cooler        bool
	Fridge        bool
	CoffeeMachine bool
```

`commands.go` — ошибка `ErrEquipmentAlready = Err("equipment_already")`, команды:

```go
	CmdBuyCooler = Command("buy_cooler")
	CmdBuyFridge = Command("buy_fridge")
	CmdBuyCoffee = Command("buy_coffee")
```

методы:

```go
// buyAmenity — общая покупка быт-устройства офиса.
func (g *Game) buyAmenity(office, price int, flag func(*Office) *bool) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	f := flag(o)
	if *f {
		return ErrEquipmentAlready
	}
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.Money -= price
	*f = true
	return nil
}

// BuyCooler ставит кулер с водой (снимает дебафф жажды).
func (g *Game) BuyCooler(office int) error {
	return g.buyAmenity(office, g.cfg.CoolerPrice, func(o *Office) *bool { return &o.Cooler })
}

// BuyFridge ставит холодильник (снимает дебафф голода).
func (g *Game) BuyFridge(office int) error {
	return g.buyAmenity(office, g.cfg.FridgePrice, func(o *Office) *bool { return &o.Fridge })
}

// BuyCoffeeMachine ставит кофеварку (случайный бафф кофе).
func (g *Game) BuyCoffeeMachine(office int) error {
	return g.buyAmenity(office, g.cfg.CoffeeMachinePrice, func(o *Office) *bool { return &o.CoffeeMachine })
}
```

в `Apply` (второй switch, рядом с офисными):

```go
	case CmdBuyCooler:
		return g.BuyCooler(office)
	case CmdBuyFridge:
		return g.BuyFridge(office)
	case CmdBuyCoffee:
		return g.BuyCoffeeMachine(office)
```

`admin.go` `configRows` — добавить после строки шлюза:

```go
		{"Кулер", c.CoolerPrice},
		{"Холодильник", c.FridgePrice},
		{"Кофеварка", c.CoffeeMachinePrice},
```

- [ ] **Step 4: GREEN**

Run: `cd server && go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "feat(game): покупка кулера, холодильника и кофеварки"
```

---

### Task 4: Домен — эффекты выработки и по-тиковый прогноз

**Files:**
- Create: `server/internal/game/effects.go`
- Modify: `server/internal/game/config.go`, `server/internal/game/game.go`, `server/internal/game/commands.go` (NextDay), `server/internal/game/office.go`
- Test: `server/internal/game/effects_test.go` (новый), правка `TestForecastEndOfDay` в `employee_test.go`

**Interfaces:**
- Consumes: устройства Task 3.
- Produces: конфиг `ThirstMult 0.9, HungerMult 0.9, CoffeeMult 1.15, CoffeeTicks 6, CoffeeChancePct 40, ThirstAfterHours 2` + методы `Config.thirstTick()`, `Config.lunchEndTick()`, `Config.clockAt(tick int) string`; `Employee.CoffeeUntil int`; `Office.CoffeeEventTicks []int`; `type Effect struct { Token string; Percent int; Until int }` (Until −1 = до конца дня); `(*Game).Effects(o *Office, e *Employee) []Effect`; `(*Game).incomeAtTick(tick int) int` (внутренний); доход и `ForecastEndOfDay` считаются через него; кофе-события роллятся в `NextDay`, срабатывают в `Tick`.

- [ ] **Step 1: Написать падающие тесты**

Создать `server/internal/game/effects_test.go`:

```go
package game

import "testing"

// amenityGame — открытый офис с одним сотрудником $10/тик, без устройств.
func amenityGame() *Game {
	g := New(DefaultConfig())
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = testStaff(1)
	return g
}

func TestThirstDebuffBoundary(t *testing.T) {
	g := amenityGame()
	g.TickInDay = 11 // 11:50 — жажды ещё нет
	if inc := g.IncomePerTick(); inc != 10 {
		t.Errorf("тик 11: доход %d, хотим 10", inc)
	}
	g.TickInDay = 12 // 12:00 — жажда −10%
	if inc := g.IncomePerTick(); inc != 9 {
		t.Errorf("тик 12: доход %d, хотим 9", inc)
	}
	g.Offices[0].Cooler = true
	if inc := g.IncomePerTick(); inc != 10 {
		t.Errorf("с кулером жажды нет: доход %d, хотим 10", inc)
	}
}

func TestHungerAndStack(t *testing.T) {
	g := amenityGame()
	g.TickInDay = 29 // 14:50 — обед, доход 0, но проверяем границу голода через эффекты
	if inc := g.IncomePerTick(); inc != 0 {
		t.Errorf("в обед доход %d, хотим 0", inc)
	}
	g.TickInDay = 30 // 15:00 — жажда + голод = ×0.81
	if inc := g.IncomePerTick(); inc != 8 { // round(10×0.81) = 8
		t.Errorf("тик 30: доход %d, хотим 8 (стак ×0.81)", inc)
	}
	g.Offices[0].Cooler = true
	g.Offices[0].Fridge = true
	if inc := g.IncomePerTick(); inc != 10 {
		t.Errorf("с устройствами дебаффов нет: %d", inc)
	}
}

func TestAmenityPerOffice(t *testing.T) {
	g := amenityGame()
	g.Offices[1] = Office{Unlocked: true, PCs: 1, Employees: testStaff(1), Cooler: true, Fridge: true}
	g.TickInDay = 30
	// офис 0 без устройств: 8; офис 1 с устройствами: 10.
	if inc := g.IncomePerTick(); inc != 18 {
		t.Errorf("доход %d, хотим 18 (8+10)", inc)
	}
}

func TestCoffeeEventsRolledAndApplied(t *testing.T) {
	g := NewWithSeed(DefaultConfig(), 7, 7)
	g.Money = 100000
	g.Offices[0].PCs = 9
	g.Offices[0].Employees = testStaff(9)
	g.Offices[0].CoffeeMachine = true
	// Проматываем день до отчёта и запускаем следующий — ролл в NextDay.
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	ticks := g.Offices[0].CoffeeEventTicks
	if len(ticks) != 2 {
		t.Fatalf("кофе-событий %d, хотим 2", len(ticks))
	}
	if ticks[0] < 0 || ticks[0] > 23 {
		t.Errorf("первое событие на тике %d, хотим [0..23]", ticks[0])
	}
	if ticks[1] < 30 || ticks[1] > 53 {
		t.Errorf("второе событие на тике %d, хотим [30..53]", ticks[1])
	}
	// Доигрываем до первого события и проверяем, что кто-то получил бафф.
	for g.TickInDay <= ticks[0] {
		g.Tick()
	}
	buffed := 0
	for _, e := range g.Offices[0].Employees {
		if e.CoffeeUntil > 0 {
			buffed++
			if e.CoffeeUntil != ticks[0]+DefaultConfig().CoffeeTicks {
				t.Errorf("CoffeeUntil = %d, хотим %d", e.CoffeeUntil, ticks[0]+6)
			}
		}
	}
	if buffed == 0 || buffed == 9 {
		t.Errorf("баффнуто %d из 9 — ожидаем частичное покрытие (шанс 40%%)", buffed)
	}
}

func TestCoffeeResetOnNextDay(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 100000
	g.Offices[0].Employees = testStaff(1)
	g.Offices[0].Employees[0].CoffeeUntil = 99
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].Employees[0].CoffeeUntil != 0 {
		t.Errorf("кофе не сброшен на next_day: %d", g.Offices[0].Employees[0].CoffeeUntil)
	}
}

func TestEffectsList(t *testing.T) {
	g := amenityGame()
	g.TickInDay = 30
	g.Offices[0].Employees[0].CoffeeUntil = 34
	eff := g.Effects(&g.Offices[0], &g.Offices[0].Employees[0])
	if len(eff) != 3 {
		t.Fatalf("эффектов %d, хотим 3 (жажда+голод+кофе): %+v", len(eff), eff)
	}
	tokens := map[string]int{}
	for _, e := range eff {
		tokens[e.Token] = e.Percent
	}
	if tokens["thirst"] != -10 || tokens["hunger"] != -10 || tokens["coffee"] != 15 {
		t.Errorf("проценты эффектов: %+v", tokens)
	}
}
```

В `employee_test.go` обновить `TestForecastEndOfDay` (прогноз теперь честно учитывает будущие дебаффы; сотрудник $10/тик, устройств нет): день = тики 0–11 по $10, 12–23 по $9 (жажда), 24–29 обед $0, 30–53 по $8 (стак ×0.81 → round 8):

```go
	// 12×10 + 12×9 + 24×8 = 420 за день без устройств.
	if f := g.ForecastEndOfDay(); f != 1000+420-250 {
		t.Errorf("прогноз с утра = %d, хотим 1170", f)
	}
	g.TickInDay = 30
	if f := g.ForecastEndOfDay(); f != 1000+24*8-250 {
		t.Errorf("прогноз после обеда = %d, хотим 942", f)
	}
	g.TickInDay = 24
	if f := g.ForecastEndOfDay(); f != 1000+24*8-250 {
		t.Errorf("прогноз в обед = %d, хотим 942", f)
	}
```

- [ ] **Step 2: RED**

Run: `cd server && go test ./internal/game/`
Expected: FAIL.

- [ ] **Step 3: Конфиг и хелперы**

`config.go` — в `Config`:

```go
	ThirstMult       float64 // дебафф жажды (нет кулера)
	HungerMult       float64 // дебафф голода (нет холодильника)
	CoffeeMult       float64 // бафф кофе
	CoffeeTicks      int     // длительность кофе, тиков
	CoffeeChancePct  int     // шанс баффа на сотрудника, %
	ThirstAfterHours int     // жажда после стольких часов работы
```

в `DefaultConfig()`:

```go
		ThirstMult:       0.9,
		HungerMult:       0.9,
		CoffeeMult:       1.15,
		CoffeeTicks:      6,
		CoffeeChancePct:  40,
		ThirstAfterHours: 2,
```

методы в конец config.go:

```go
// thirstTick — тик дня, с которого без кулера действует жажда.
func (c Config) thirstTick() int { return c.ThirstAfterHours * c.TicksPerHour }

// lunchEndTick — первый тик после обеда.
func (c Config) lunchEndTick() int { return (c.LunchEnd - c.WorkdayStart) * c.TicksPerHour }

// clockAt — игровое время «HH:MM» произвольного тика дня.
func (c Config) clockAt(tick int) string {
	minutes := tick * 60 / c.TicksPerHour
	return fmt.Sprintf("%02d:%02d", c.WorkdayStart+minutes/60, minutes%60)
}
```

(добавить `import "fmt"` в config.go; `Game.Clock()` в game.go переписать как `return g.cfg.clockAt(g.TickInDay)`; в `commands.go` `hiredAfterLunch` переиспользовать `g.cfg.lunchEndTick()`.)

- [ ] **Step 4: effects.go**

```go
package game

import "math"

// Токены эффектов — значения совпадают с полем token протокола.
const (
	EffectThirst = "thirst"
	EffectHunger = "hunger"
	EffectCoffee = "coffee"
)

// Effect — активный эффект сотрудника (для снапшота и тултипа).
type Effect struct {
	Token   string
	Percent int // −10 / +15
	Until   int // тик дня конца действия; −1 — до конца дня
}

// effectMult — множитель эффектов сотрудника офиса на данном тике.
func (g *Game) effectMult(o *Office, e *Employee, tick int) float64 {
	m := 1.0
	if !o.Cooler && tick >= g.cfg.thirstTick() {
		m *= g.cfg.ThirstMult
	}
	if !o.Fridge && tick >= g.cfg.lunchEndTick() {
		m *= g.cfg.HungerMult
	}
	if e.CoffeeUntil > tick {
		m *= g.cfg.CoffeeMult
	}
	return m
}

// pct переводит множитель эффекта в проценты для протокола: 0.9 → −10.
func pct(mult float64) int { return int(math.Round((mult - 1) * 100)) }

// Effects — активные эффекты сотрудника на текущем тике.
func (g *Game) Effects(o *Office, e *Employee) []Effect {
	tick := g.TickInDay
	var out []Effect
	if !o.Cooler && tick >= g.cfg.thirstTick() {
		out = append(out, Effect{Token: EffectThirst, Percent: pct(g.cfg.ThirstMult), Until: -1})
	}
	if !o.Fridge && tick >= g.cfg.lunchEndTick() {
		out = append(out, Effect{Token: EffectHunger, Percent: pct(g.cfg.HungerMult), Until: -1})
	}
	if e.CoffeeUntil > tick {
		out = append(out, Effect{Token: EffectCoffee, Percent: pct(g.cfg.CoffeeMult), Until: e.CoffeeUntil})
	}
	return out
}
```

- [ ] **Step 5: Доход, кофе-события, прогноз**

`office.go` — `Office` += `CoffeeEventTicks []int` (комментарий: «тики кофе-событий текущего дня; роллятся в NextDay»). `game.go` — `Employee` += `CoffeeUntil int` (комментарий: «бафф кофе действует, пока тик дня < CoffeeUntil; 0 — нет»).

`game.go` — заменить `incomePotentialPerTick` на:

```go
// incomeAtTick — доход компании за конкретный (продуктивный) тик дня:
// личная выработка × эффекты × сетевой множитель подключённым.
func (g *Game) incomeAtTick(tick int) int {
	mult := g.Multiplier()
	total := 0
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked {
			continue
		}
		connected := o.Connected(g.cfg)
		for i := range o.Employees {
			e := &o.Employees[i]
			v := float64(e.IncomePerTick) * g.effectMult(o, e, tick)
			if i < connected {
				v *= mult
			}
			total += int(math.Round(v))
		}
	}
	return total
}
```

`IncomePerTick()`: `if g.IsLunch() { return 0 }; return g.incomeAtTick(g.TickInDay)`.

`ForecastEndOfDay()` — по-тиково:

```go
// ForecastEndOfDay — баланс на конец дня. Считает по-тиково: дебаффы
// будущих тиков предсказуемы, будущий кофе не угадываем (консервативно).
func (g *Game) ForecastEndOfDay() int {
	total := g.Money
	for t := g.TickInDay; t < g.cfg.DayTicks(); t++ {
		if !g.cfg.isLunchTick(t) {
			total += g.incomeAtTick(t)
		}
	}
	return total - g.PayrollPerDay()
}
```

`Tick()` — перед начислением дохода добавить срабатывание кофе-событий:

```go
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked || !o.CoffeeMachine {
			continue
		}
		for _, et := range o.CoffeeEventTicks {
			if et == g.TickInDay {
				for i := range o.Employees {
					if g.rng.IntN(100) < g.cfg.CoffeeChancePct {
						o.Employees[i].CoffeeUntil = g.TickInDay + g.cfg.CoffeeTicks
					}
				}
			}
		}
	}
```

`commands.go` `NextDay()` — в цикл сброса добавить:

```go
			o.Employees[j].CoffeeUntil = 0
```

и после цикла сотрудников офиса — ролл событий:

```go
		if o.CoffeeMachine {
			o.CoffeeEventTicks = []int{
				g.rng.IntN(24),
				g.cfg.lunchEndTick() + g.rng.IntN(g.cfg.DayTicks()-g.cfg.lunchEndTick()),
			}
		} else {
			o.CoffeeEventTicks = nil
		}
```

- [ ] **Step 6: GREEN + race**

Run: `cd server && go test -race ./...`
Expected: PASS (включая обновлённый TestForecastEndOfDay; старые day-тесты целы: короткий день 3 тика < thirstTick=6).

- [ ] **Step 7: Commit**

```bash
git add server/
git commit -m "feat(game): эффекты жажды/голода/кофе и по-тиковый прогноз"
```

---

### Task 5: Протокол — устройства, эффекты, цены

**Files:**
- Modify: `server/internal/ws/protocol.go`
- Test: `server/internal/ws/protocol_test.go`

**Interfaces:**
- Consumes: `game.Effects/Effect`, флаги устройств, `Config.clockAt` (не экспортирован — until форматирует протокол через `game.Config`... clockAt приватный: добавить в game экспортированный `(*Game).ClockAt(tick int) string { return g.cfg.clockAt(tick) }` в этой задаче).
- Produces (JSON): `offices[] += cooler, fridge, coffeeMachine (bool)`; `employees[] += effects: [{token, percent, until}]` (until — «HH:MM» или «» для «до конца дня»); `prices += cooler, fridge, coffeeMachine`.

- [ ] **Step 1: Написать падающие тесты**

В `protocol_test.go` добавить:

```go
func TestSnapshotAmenitiesAndEffects(t *testing.T) {
	g := game.New(game.DefaultConfig())
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = []game.Employee{{Name: "Тест Тестов", IncomePerTick: 10, CoffeeUntil: 34}}
	g.Offices[0].Cooler = true
	g.TickInDay = 30 // после обеда: голод есть (холодильника нет), жажды нет (кулер)
	s := snapshot(g)
	o := s.Offices[0]
	if !o.Cooler || o.Fridge || o.CoffeeMachine {
		t.Errorf("флаги устройств: %+v", o)
	}
	eff := o.Employees[0].Effects
	if len(eff) != 2 {
		t.Fatalf("эффектов %d, хотим 2 (голод+кофе): %+v", len(eff), eff)
	}
	byToken := map[string]effectInfo{}
	for _, e := range eff {
		byToken[e.Token] = e
	}
	if byToken["hunger"].Percent != -10 || byToken["hunger"].Until != "" {
		t.Errorf("голод: %+v", byToken["hunger"])
	}
	if byToken["coffee"].Percent != 15 || byToken["coffee"].Until != "15:40" {
		t.Errorf("кофе: %+v (until тика 34 = 15:40)", byToken["coffee"])
	}
	if s.Prices.Cooler != 400 || s.Prices.Fridge != 600 || s.Prices.CoffeeMachine != 800 {
		t.Errorf("цены устройств: %+v", s.Prices)
	}
}
```

- [ ] **Step 2: RED**

Run: `cd server && go test ./internal/ws/`

- [ ] **Step 3: Реализация**

В `game.go` добавить:

```go
// ClockAt — игровое время произвольного тика (для протокола).
func (g *Game) ClockAt(tick int) string { return g.cfg.clockAt(tick) }
```

`protocol.go`:

```go
// effectInfo — активный эффект сотрудника для тултипа.
type effectInfo struct {
	Token   string `json:"token"`   // thirst | hunger | coffee
	Percent int    `json:"percent"` // −10 / +15
	Until   string `json:"until"`   // «HH:MM»; "" — до конца дня
}
```

`employeeInfo` += `Effects []effectInfo `json:"effects"``. `officeInfo` += `Cooler bool `json:"cooler"``, `Fridge bool `json:"fridge"``, `CoffeeMachine bool `json:"coffeeMachine"``. `prices` += `Cooler int `json:"cooler"``, `Fridge int `json:"fridge"``, `CoffeeMachine int `json:"coffeeMachine"``.

В `snapshot()` внутри цикла сотрудников:

```go
			var effects []effectInfo
			for _, ef := range g.Effects(o, &o.Employees[i]) {
				until := ""
				if ef.Until >= 0 {
					until = g.ClockAt(ef.Until)
				}
				effects = append(effects, effectInfo{Token: ef.Token, Percent: ef.Percent, Until: until})
			}
```

и поле `Effects: effects` в литерале `employeeInfo`; флаги офиса и цены — из конфига/офиса.

- [ ] **Step 4: GREEN + race**

Run: `cd server && go test -race ./...`

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "feat(ws): устройства, эффекты и цены быта в снапшоте"
```

---

### Task 6: Клиент — протокол

**Files:**
- Modify: `client/src/protocol.ts`

**Interfaces:**
- Produces: `EffectInfo {token: 'thirst'|'hunger'|'coffee', percent: number, until: string}`; `EmployeeInfo += effects: EffectInfo[]`; `OfficeInfo += cooler/fridge/coffeeMachine: boolean`; `prices += cooler/fridge/coffeeMachine: number`; `CommandType += 'buy_cooler'|'buy_fridge'|'buy_coffee'`.

- [ ] **Step 1: Правки protocol.ts**

```ts
export interface EffectInfo {
  token: 'thirst' | 'hunger' | 'coffee'
  percent: number
  until: string // «HH:MM»; '' — до конца дня
}
```

`EmployeeInfo` += `effects: EffectInfo[]`; `OfficeInfo` += `cooler: boolean; fridge: boolean; coffeeMachine: boolean`; в `prices` += `cooler: number; fridge: number; coffeeMachine: number`; `CommandType` += `'buy_cooler' | 'buy_fridge' | 'buy_coffee'`.

- [ ] **Step 2: Typecheck**

Run: `cd client && npm run typecheck`
Expected: чисто (новые поля аддитивны, сцены их пока не читают).

- [ ] **Step 3: Commit**

```bash
git add client/src/protocol.ts
git commit -m "feat(client): протокол быт-устройств и эффектов"
```

---

### Task 7: Клиент — спрайты, полка устройств, тултипы эффектов

**Files:**
- Modify: `client/src/pixelart.ts`, `client/src/scenes/OfficeScene.ts`

**Interfaces:**
- Consumes: типы Task 6, `nav.activeOffice`, `fmtMoney`.
- Produces: текстуры `cooler`, `fridge`, `coffee_machine`; полка устройств в офисе; строки эффектов в тултипе сотрудника.

- [ ] **Step 1: Спрайты в pixelart.ts**

Добавить в `SPRITES`:

```ts
  cooler: [
    '................',
    '.....wwwww......',
    '.....wsssw......',
    '.....wsssw......',
    '.....wsssw......',
    '.....wwwww......',
    '....wwwwwww.....',
    '....w.....w.....',
    '....w..s..w.....',
    '....w.....w.....',
    '....w.....w.....',
    '....w.....w.....',
    '....w.....w.....',
    '....wwwwwww.....',
    '.....k...k......',
    '................',
  ],
  fridge: [
    '................',
    '....wwwwwwww....',
    '....w......w....',
    '....w.....gw....',
    '....w......w....',
    '....wwwwwwww....',
    '....w......w....',
    '....w.....gw....',
    '....w......w....',
    '....w......w....',
    '....w......w....',
    '....w......w....',
    '....w......w....',
    '....wwwwwwww....',
    '.....k....k.....',
    '................',
  ],
  coffee_machine: [
    '................',
    '................',
    '................',
    '....kkkkkkkk....',
    '....kkkkkkkk....',
    '....kk.rr.kk....',
    '....kkkkkkkk....',
    '....kk......k...',
    '....kk.ww...k...',
    '....kk.ww...k...',
    '....kkkkkkkkk...',
    '....kkkkkkkkk...',
    '................',
    '................',
    '................',
    '................',
  ],
```

- [ ] **Step 2: Полка устройств в OfficeScene**

В `render()` открытого офиса (после слота босса) добавить полку — три слота внизу справа (не пересекаются с сеткой: сетка кончается y≈600, полка на y=660):

```ts
    // Полка быт-устройств: без них сотрудники ловят дебаффы.
    const amenities: { key: 'cooler' | 'fridge' | 'coffee_machine'; owned: boolean; price: number; cmd: CommandType; label: string; hint: string }[] = [
      { key: 'cooler', owned: office.cooler, price: s.prices.cooler, cmd: 'buy_cooler', label: 'кулер',
        hint: 'Без кулера: жажда −10% с 12:00' },
      { key: 'fridge', owned: office.fridge, price: s.prices.fridge, cmd: 'buy_fridge', label: 'холодильник',
        hint: 'Без холодильника: голод −10% после обеда' },
      { key: 'coffee_machine', owned: office.coffeeMachine, price: s.prices.coffeeMachine, cmd: 'buy_coffee', label: 'кофеварка',
        hint: 'Дважды в день 40% офиса: кофе +15% на час' },
    ]
    amenities.forEach((a, i) => {
      const ax = 220 + i * 130
      const ay = 660
      const box = this.add.rectangle(ax, ay, 72, 72, 0x232640, a.owned ? 1 : 0.5)
        .setStrokeStyle(2, a.owned ? 0x38b764 : 0x3a3f5c)
        .setInteractive({ useHandCursor: !a.owned })
      this.objects.push(box)
      if (a.owned) {
        const img = this.add.image(ax, ay, a.key).setScale(3).setInteractive({ useHandCursor: true })
        img.on('pointerover', () => this.showTextTooltip(`${a.label}\n${a.hint}`, ax, ay - 40))
        img.on('pointerout', () => this.hideTooltip())
        this.objects.push(img)
      } else {
        this.objects.push(this.add.text(ax, ay, `${a.label}\n${fmtMoney(a.price)}`, {
          fontFamily: 'monospace', fontSize: '10px', color: '#5d7275', align: 'center',
        }).setOrigin(0.5))
        box.on('pointerdown', () => client.send(a.cmd, nav.activeOffice))
      }
    })
```

и универсальный текстовый тултип (рядом с showTooltip):

```ts
  private showTextTooltip(text: string, x: number, y: number) {
    this.tooltipText.setText(text)
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    const tx = Math.min(x, GAME_W - this.tooltipBg.width - 8)
    this.tooltip.setPosition(tx, y).setVisible(true)
  }
```

(импортировать `CommandType` из protocol.)

- [ ] **Step 3: Эффекты в тултипе сотрудника**

В `showTooltip` (сотрудника) — после строки зарплаты добавить строки эффектов:

```ts
    const lines = [
      e.name,
      `Выработка: ${fmtMoney(e.incomePerTick * s.ticksPerHour)}/час`,
      `Зарплата:  ${fmtMoney(s.salaryPerDay)}/день${e.unpaidToday ? ' (сегодня без оплаты)' : ''}`,
    ]
    const EFFECT_NAMES: Record<string, string> = { thirst: 'жажда', hunger: 'голоден', coffee: 'выпил кофе' }
    for (const ef of e.effects) {
      const sign = ef.percent > 0 ? '+' : ''
      lines.push(`${EFFECT_NAMES[ef.token] ?? ef.token} ${sign}${ef.percent}%${ef.until ? ` (до ${ef.until})` : ''}`)
    }
    this.tooltipText.setText(lines.join('\n'))
```

(перестроить существующее тело setText на массив lines, остальное без изменений).

- [ ] **Step 4: Typecheck + ручная проверка**

Run: `cd client && npm run typecheck`
Expected: чисто. `make dev`: полка видна, покупка работает, после 12:00 у сотрудников в тултипе «жажда −10%».

- [ ] **Step 5: Commit**

```bash
git add client/src/pixelart.ts client/src/scenes/OfficeScene.ts
git commit -m "feat(client): полка быт-устройств и эффекты в тултипах"
```

---

### Task 8: live-check итерации 5

**Files:**
- Modify: `scripts/live-check.mjs`

- [ ] **Step 1: Дополнить сценарий**

В существующем сценарии внести правки:
1. В `FIELDS` ничего не добавляется (новые поля вложенные), но после проверки офисов добавить шаг покупки кулера: после `ok('найм в офис 0: ...')` вместо перехода к `hire office 1` вставить фазу `cooler`:

```js
    ws.send(JSON.stringify({ type: 'buy_cooler', office: 0 }))
    phase = 'cooler'
  } else if (phase === 'cooler' && m.type === 'state' && m.offices[0].cooler) {
    if (!('effects' in m.offices[0].employees[0])) fail('нет effects у сотрудника', m.offices[0].employees[0])
    ok('кулер куплен, effects присутствует')
    ws.send(JSON.stringify({ type: 'buy_cooler', office: 0 }))
    phase = 'cooler_dup'
  } else if (phase === 'cooler_dup' && m.type === 'error') {
    if (m.code !== 'equipment_already') fail('код повторной покупки', m.code)
    ok('повторный кулер: error equipment_already')
    ws.send(JSON.stringify({ type: 'hire', office: 1 }))
    phase = 'locked'
```

(нумерация ok-строк вырастет на 2 — итог «ПРОТОКОЛ ОК» при 9 ok; стартовые деньги $600 − найм $300 = $300 — кулер $400 НЕ по карману сразу! Исправление: покупать кулер ПОСЛЕ пары тиков — вместо мгновенной покупки дождаться `m.money >= 400`: условие фазы `cooler_wait`. Реализовать так:

```js
    phase = 'cooler_wait'
  } else if (phase === 'cooler_wait' && m.type === 'state' && m.money >= 400) {
    ws.send(JSON.stringify({ type: 'buy_cooler', office: 0 }))
    phase = 'cooler'
  } else if (phase === 'cooler' && ...
```

доход ~$10/тик → ждать ~10 сек, укладывается в таймаут.)

- [ ] **Step 2: Прогнать**

```bash
cd server && go run ./cmd/server -addr :8091 &
sleep 1
node ../scripts/live-check.mjs
pkill -f 'exe/server'; pkill -f 'cmd/server'; true
```

Expected: все ok (9), «ПРОТОКОЛ ОК» (~60 сек). Процессы убиты.

- [ ] **Step 3: Commit**

```bash
git add scripts/live-check.mjs
git commit -m "test: живая проверка протокола итерации 5"
```

---

### Task 9: README и полный прогон

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

Дополнить: быт-устройства и эффекты (кулер $400 — иначе жажда −10% с 12:00; холодильник $600 — иначе голод −10% после обеда; кофеварка $800 — дважды в день 40% офиса +15% на час); PostgreSQL: раздел «База данных» — опциональна, `DATABASE_URL` в `.env`, миграции применяются на старте, `/admin` — конфигурация и каталог `lib_equipment`.

- [ ] **Step 2: Полный прогон**

```bash
make test && make typecheck
cd server && go test -race -count=1 ./... && go vet ./... && cd ..
make build
./bin/itdirector -static client/dist -addr :8087 &
sleep 1
curl -sf http://localhost:8087/ | head -3
curl -sf http://localhost:8087/admin | grep -o 'Конфигурация игры'
kill %1 2>/dev/null; pkill -f 'bin/itdirector'; true
```

Expected: всё зелёное; /admin отвечает (без DATABASE_URL — с блоком «БД недоступна»).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README итерации 5"
```

После этого — браузерный смоук контроллера (полка, покупка, тултипы эффектов, админка с БД), финальное ревью ветки, плейтест (критерий из спеки: дебаффы мотивируют покупку устройств, кофе радует, админка показывает конфиг+каталог, make dev без DATABASE_URL работает).
