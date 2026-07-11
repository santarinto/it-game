# IT Director MVP (итерация 1) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Играбельный MVP: Go-сервер симулирует IT-компанию (ПК, найм, роутер, серверы-мультипликаторы), Phaser-клиент рисует офис и серверную в pixel style.

**Architecture:** На каждое WebSocket-подключение Go-сервер создаёт игру и одну горутину-«актор» (select по каналу команд, тикеру 1 с и ctx.Done) — мьютексов нет. Пакет `internal/game` — чистый домен без сети/JSON; `internal/ws` — протокол и сессия. Клиент без игровой логики: получил снапшот → перерисовал, кнопка → команда.

**Tech Stack:** Go 1.26, `github.com/coder/websocket`; клиент — Vite 7 + TypeScript 5 + Phaser 3.90 (`pixelArt: true`); GNU Make.

Спека: `docs/superpowers/specs/2026-07-11-it-director-mvp-design.md`. Баланс: `docs/design/gdd.md` (раздел «Экономика»).

## Global Constraints

- Go ≥ 1.26; модуль сервера называется `itdirector`, корень модуля — `server/`.
- Единственная Go-зависимость: `github.com/coder/websocket` (v1.8.x).
- Node ≥ 26; клиентские зависимости: `phaser` ^3.90, dev: `typescript` ^5, `vite` ^7. Больше ничего не добавлять (YAGNI).
- Деньги — `int`, доллары США без центов.
- Пакет `internal/game` не импортирует ничего сетевого и не содержит JSON-тегов.
- Комментарии в коде и все UI-тексты — по-русски. Коды ошибок и поля протокола — snake_case/camelCase латиницей, как в спеке.
- TDD для всего пакета `game` и `ws`: сначала падающий тест, потом код.
- Каждый коммит завершается трейлером `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Отступление от спеки (согласованное):** в итерации 1 арт — собственные кодогенерируемые 16×16 пиксель-спрайты (`client/src/pixelart.ts`); интеграция готовых CC0-паков перенесена в бэклог GDD (задача 12 фиксирует это в GDD).

## Карта файлов

```
Makefile                       — dev/test/typecheck/build
.gitignore
README.md                      — задача 12
server/
  go.mod, go.sum
  cmd/server/main.go           — флаги, маршруты /ws и статика
  internal/game/
    config.go                  — Config, RouterTier, DefaultConfig
    game.go                    — Game, New, Config(), Ports, Connected, Multiplier, IncomePerTick, Tick
    commands.go                — Err, Command, Apply, BuyPC, Hire, BuyRouter, BuyServer, NextRouterPrice
    game_test.go               — все юнит-тесты домена
  internal/ws/
    protocol.go                — clientMessage, stateMessage, prices, errorMessage, snapshot()
    session.go                 — Handler (ServeHTTP, readLoop, run)
    protocol_test.go           — тест снапшота
    session_test.go            — интеграционные тесты через httptest
client/
  package.json, tsconfig.json, vite.config.ts, index.html
  src/protocol.ts              — типы сообщений (зеркало protocol.go)
  src/net.ts                   — GameClient (connect, send, subscribe)
  src/pixelart.ts              — палитра, ASCII-спрайты, registerTextures
  src/main.ts                  — конфиг Phaser.Game
  src/scenes/BootScene.ts
  src/scenes/HUDScene.ts       — деньги, кнопки, тосты, дисконнект, переключение комнат
  src/scenes/OfficeScene.ts
  src/scenes/ServerRoomScene.ts
```

---

### Task 1: Скаффолдинг репозитория

**Files:**
- Create: `.gitignore`, `Makefile`, `server/go.mod`, `server/cmd/server/main.go`

**Interfaces:**
- Produces: Go-модуль `itdirector` (импорты вида `itdirector/internal/game`); цели `make test`, `make dev-server`.

- [ ] **Step 1: .gitignore**

```gitignore
bin/
client/node_modules/
client/dist/
```

- [ ] **Step 2: Makefile**

```makefile
.PHONY: dev dev-server dev-client test typecheck build

dev: ## сервер и клиент параллельно
	$(MAKE) -j2 dev-server dev-client

dev-server:
	cd server && go run ./cmd/server

dev-client:
	cd client && npm run dev

test:
	cd server && go test ./...

typecheck:
	cd client && npm run typecheck

build:
	cd client && npm run build
	cd server && go build -o ../bin/itdirector ./cmd/server
```

- [ ] **Step 3: Go-модуль и минимальный main**

Run: `cd server && go mod init itdirector`

`server/cmd/server/main.go`:

```go
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
```

- [ ] **Step 4: Проверка сборки**

Run: `cd server && go vet ./... && go build ./...`
Expected: без ошибок, пустой вывод.

- [ ] **Step 5: Commit**

```bash
git add .gitignore Makefile server/
git commit -m "chore: скаффолдинг — Makefile, Go-модуль itdirector, каркас main"
```

---

### Task 2: Домен — конфиг баланса и стартовое состояние

**Files:**
- Create: `server/internal/game/config.go`, `server/internal/game/game.go`
- Test: `server/internal/game/game_test.go`

**Interfaces:**
- Produces: `game.Config`, `game.RouterTier{Price, Ports int}`, `game.DefaultConfig() Config`, `game.Game` (поля `Money, PCs, Employees, RouterTier, Servers int`), `game.New(cfg Config) *Game`, `(*Game).Config() Config`.

- [ ] **Step 1: Падающий тест старта**

`server/internal/game/game_test.go`:

```go
package game

import "testing"

func TestNewGameStart(t *testing.T) {
	g := New(DefaultConfig())
	if g.Money != 600 {
		t.Errorf("Money = %d, хотим 600", g.Money)
	}
	if g.PCs != 1 {
		t.Errorf("PCs = %d, хотим 1 (стартовый ПК)", g.PCs)
	}
	if g.Employees != 0 || g.RouterTier != 0 || g.Servers != 0 {
		t.Errorf("на старте не должно быть сотрудников, роутера и серверов: %+v", g)
	}
}
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — `undefined: New`, `undefined: DefaultConfig`.

- [ ] **Step 3: Реализация**

`server/internal/game/config.go`:

```go
package game

// Config — весь баланс игры в одном месте.
// Источник истины для чисел — docs/design/gdd.md, раздел «Экономика».
type Config struct {
	StartMoney        int
	StartPCs          int
	OfficeSlots       int // слоты офиса под рабочие места
	RackSlots         int // слоты серверной под стойки
	PCPrice           int
	HirePrice         int
	ServerPrice       int
	BaseIncomePerTick int     // $ за тик с одного сотрудника без сети
	NetworkBase       float64 // множитель за сам факт подключения к сети
	ServerBonus       float64 // прибавка к множителю за каждый сервер
	RouterTiers       []RouterTier
}

// RouterTier — тир роутера: покупается последовательно, тир заменяет предыдущий.
type RouterTier struct {
	Price int
	Ports int
}

func DefaultConfig() Config {
	return Config{
		StartMoney:        600,
		StartPCs:          1,
		OfficeSlots:       9,
		RackSlots:         3,
		PCPrice:           500,
		HirePrice:         300,
		ServerPrice:       2000,
		BaseIncomePerTick: 10,
		NetworkBase:       1.5,
		ServerBonus:       0.5,
		RouterTiers: []RouterTier{
			{Price: 800, Ports: 4},
			{Price: 2500, Ports: 9},
		},
	}
}
```

`server/internal/game/game.go`:

```go
package game

// Game — состояние одной игры. НЕ потокобезопасен: им владеет
// ровно одна горутина (актор сессии в пакете ws).
type Game struct {
	cfg Config

	Money      int
	PCs        int // ПК в офисе; первые Employees из них заняты сотрудниками
	Employees  int
	RouterTier int // 0 — роутера нет; 1..len(cfg.RouterTiers)
	Servers    int
}

func New(cfg Config) *Game {
	return &Game{cfg: cfg, Money: cfg.StartMoney, PCs: cfg.StartPCs}
}

// Config возвращает баланс, с которым создана игра (для снапшотов протокола).
func (g *Game) Config() Config { return g.cfg }
```

- [ ] **Step 4: Тест зелёный**

Run: `cd server && go test ./internal/game/`
Expected: `ok  	itdirector/internal/game`

- [ ] **Step 5: Commit**

```bash
git add server/internal/game/
git commit -m "feat(game): конфиг баланса и стартовое состояние игры"
```

---

### Task 3: Домен — покупка ПК и найм

**Files:**
- Create: `server/internal/game/commands.go`
- Modify: `server/internal/game/game_test.go` (добавить тесты)

**Interfaces:**
- Consumes: `Game`, `Config` из Task 2.
- Produces: тип `game.Err` (`Error() string`, значение — код для протокола); ошибки `ErrNotEnoughMoney`, `ErrNoFreeOfficeSlot`, `ErrNoFreePC`; методы `(*Game).BuyPC() error`, `(*Game).Hire() error`. Порядок проверок везде: сначала слот/место, потом деньги.

- [ ] **Step 1: Падающие тесты**

Добавить в `server/internal/game/game_test.go`:

```go
func TestBuyPC(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*Game)
		wantErr   error
		wantPCs   int
		wantMoney int
	}{
		{"успех: деньги ровно по цене", func(g *Game) { g.Money = 500 }, nil, 2, 0},
		{"не хватает денег", func(g *Game) { g.Money = 499 }, ErrNotEnoughMoney, 1, 499},
		{"офис полон", func(g *Game) { g.Money = 10000; g.PCs = 9 }, ErrNoFreeOfficeSlot, 9, 10000},
		{"офис полон и денег нет: слот проверяется первым", func(g *Game) { g.Money = 0; g.PCs = 9 }, ErrNoFreeOfficeSlot, 9, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyPC(); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.PCs != tt.wantPCs || g.Money != tt.wantMoney {
				t.Errorf("PCs=%d Money=%d, хотим PCs=%d Money=%d", g.PCs, g.Money, tt.wantPCs, tt.wantMoney)
			}
		})
	}
}

func TestHire(t *testing.T) {
	tests := []struct {
		name          string
		setup         func(*Game)
		wantErr       error
		wantEmployees int
		wantMoney     int
	}{
		{"успех: есть свободный стартовый ПК", func(g *Game) { g.Money = 300 }, nil, 1, 0},
		{"нет свободного ПК", func(g *Game) { g.Money = 1000; g.Employees = 1 }, ErrNoFreePC, 1, 1000},
		{"не хватает денег", func(g *Game) { g.Money = 299 }, ErrNotEnoughMoney, 0, 299},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.Hire(); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.Employees != tt.wantEmployees || g.Money != tt.wantMoney {
				t.Errorf("Employees=%d Money=%d, хотим %d и %d", g.Employees, g.Money, tt.wantEmployees, tt.wantMoney)
			}
		})
	}
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — `undefined: ErrNotEnoughMoney`, `undefined: (\*Game).BuyPC` и т.п.

- [ ] **Step 3: Реализация**

`server/internal/game/commands.go`:

```go
package game

// Err — доменная ошибка. Значение строки — это код ошибки протокола,
// поэтому новые ошибки должны совпадать с кодами в спеке.
type Err string

func (e Err) Error() string { return string(e) }

const (
	ErrNotEnoughMoney   = Err("not_enough_money")
	ErrNoFreeOfficeSlot = Err("no_free_office_slot")
	ErrNoFreePC         = Err("no_free_pc")
)

// BuyPC ставит новый ПК в свободный слот офиса.
func (g *Game) BuyPC() error {
	if g.PCs >= g.cfg.OfficeSlots {
		return ErrNoFreeOfficeSlot
	}
	if g.Money < g.cfg.PCPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.PCPrice
	g.PCs++
	return nil
}

// Hire сажает нового сотрудника за свободный ПК.
func (g *Game) Hire() error {
	if g.Employees >= g.PCs {
		return ErrNoFreePC
	}
	if g.Money < g.cfg.HirePrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.HirePrice
	g.Employees++
	return nil
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./internal/game/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/game/
git commit -m "feat(game): команды «купить ПК» и «нанять сотрудника»"
```

---

### Task 4: Домен — роутер и серверы

**Files:**
- Modify: `server/internal/game/commands.go`, `server/internal/game/game_test.go`

**Interfaces:**
- Consumes: `Game`, `Err` из Tasks 2–3.
- Produces: ошибки `ErrNoFreeRackSlot`, `ErrRouterMaxed`; методы `(*Game).BuyRouter() error` (покупает следующий тир), `(*Game).BuyServer() error`, `(*Game).NextRouterPrice() int` (0 — тиров больше нет).

- [ ] **Step 1: Падающие тесты**

Добавить в `server/internal/game/game_test.go`:

```go
func TestBuyRouter(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*Game)
		wantErr   error
		wantTier  int
		wantMoney int
	}{
		{"тир 1 за $800", func(g *Game) { g.Money = 800 }, nil, 1, 0},
		{"апгрейд до тира 2 за $2500", func(g *Game) { g.Money = 2500; g.RouterTier = 1 }, nil, 2, 0},
		{"выше тира 2 нельзя", func(g *Game) { g.Money = 99999; g.RouterTier = 2 }, ErrRouterMaxed, 2, 99999},
		{"не хватает денег", func(g *Game) { g.Money = 799 }, ErrNotEnoughMoney, 0, 799},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyRouter(); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.RouterTier != tt.wantTier || g.Money != tt.wantMoney {
				t.Errorf("RouterTier=%d Money=%d, хотим %d и %d", g.RouterTier, g.Money, tt.wantTier, tt.wantMoney)
			}
		})
	}
}

func TestNextRouterPrice(t *testing.T) {
	g := New(DefaultConfig())
	if p := g.NextRouterPrice(); p != 800 {
		t.Errorf("без роутера цена = %d, хотим 800", p)
	}
	g.RouterTier = 1
	if p := g.NextRouterPrice(); p != 2500 {
		t.Errorf("после тира 1 цена = %d, хотим 2500", p)
	}
	g.RouterTier = 2
	if p := g.NextRouterPrice(); p != 0 {
		t.Errorf("на максимальном тире цена = %d, хотим 0", p)
	}
}

func TestBuyServer(t *testing.T) {
	tests := []struct {
		name        string
		setup       func(*Game)
		wantErr     error
		wantServers int
		wantMoney   int
	}{
		{"успех", func(g *Game) { g.Money = 2000 }, nil, 1, 0},
		{"серверная полна", func(g *Game) { g.Money = 99999; g.Servers = 3 }, ErrNoFreeRackSlot, 3, 99999},
		{"не хватает денег", func(g *Game) { g.Money = 1999 }, ErrNotEnoughMoney, 0, 1999},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyServer(); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.Servers != tt.wantServers || g.Money != tt.wantMoney {
				t.Errorf("Servers=%d Money=%d, хотим %d и %d", g.Servers, g.Money, tt.wantServers, tt.wantMoney)
			}
		})
	}
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — `undefined: ErrRouterMaxed` и т.п.

- [ ] **Step 3: Реализация**

Добавить в `server/internal/game/commands.go`:

```go
const (
	ErrNoFreeRackSlot = Err("no_free_rack_slot")
	ErrRouterMaxed    = Err("router_maxed")
)

// BuyRouter покупает следующий тир роутера (тир заменяет предыдущий).
// Слот роутера специальный: он один, отдельный от рабочих мест.
func (g *Game) BuyRouter() error {
	if g.RouterTier >= len(g.cfg.RouterTiers) {
		return ErrRouterMaxed
	}
	price := g.cfg.RouterTiers[g.RouterTier].Price
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.Money -= price
	g.RouterTier++
	return nil
}

// BuyServer ставит сервер в свободную стойку серверной.
func (g *Game) BuyServer() error {
	if g.Servers >= g.cfg.RackSlots {
		return ErrNoFreeRackSlot
	}
	if g.Money < g.cfg.ServerPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.ServerPrice
	g.Servers++
	return nil
}

// NextRouterPrice — цена следующего тира роутера; 0, если тир максимальный.
func (g *Game) NextRouterPrice() int {
	if g.RouterTier >= len(g.cfg.RouterTiers) {
		return 0
	}
	return g.cfg.RouterTiers[g.RouterTier].Price
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./internal/game/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/game/
git commit -m "feat(game): роутер по тирам и покупка серверов"
```

---

### Task 5: Домен — сеть, множитель, доход, тик

**Files:**
- Modify: `server/internal/game/game.go`, `server/internal/game/game_test.go`

**Interfaces:**
- Consumes: `Game` из Tasks 2–4.
- Produces: `(*Game).Ports() int`, `(*Game).Connected() int` (min(порты, сотрудники)), `(*Game).Multiplier() float64` (1.0 без роутера, иначе 1.5 + 0.5×серверы), `(*Game).IncomePerTick() int`, `(*Game).Tick()`.

- [ ] **Step 1: Падающие тесты**

Добавить в `server/internal/game/game_test.go`:

```go
func TestIncome(t *testing.T) {
	tests := []struct {
		name                        string
		employees, routerTier, servers int
		wantConnected               int
		wantMultiplier              float64
		wantIncome                  int
	}{
		{"без роутера: базовая выработка", 2, 0, 0, 0, 1.0, 20},
		{"серверы без роутера не дают ничего", 2, 0, 3, 0, 1.0, 20},
		{"роутер тир 1: подключённые ×1.5", 2, 1, 0, 2, 1.5, 30},
		{"портов меньше, чем сотрудников", 6, 1, 0, 4, 1.5, 80}, // 4×15 + 2×10
		{"роутер + 2 сервера: ×2.5", 6, 1, 2, 4, 2.5, 120},      // 4×25 + 2×10
		{"потолок MVP: 9 сотрудников на ×3.0", 9, 2, 3, 9, 3.0, 270},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			g.PCs = tt.employees
			g.Employees = tt.employees
			g.RouterTier = tt.routerTier
			g.Servers = tt.servers
			if c := g.Connected(); c != tt.wantConnected {
				t.Errorf("Connected() = %d, хотим %d", c, tt.wantConnected)
			}
			if m := g.Multiplier(); m != tt.wantMultiplier {
				t.Errorf("Multiplier() = %v, хотим %v", m, tt.wantMultiplier)
			}
			if inc := g.IncomePerTick(); inc != tt.wantIncome {
				t.Errorf("IncomePerTick() = %d, хотим %d", inc, tt.wantIncome)
			}
		})
	}
}

func TestTickAddsIncome(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 0
	g.Employees = 1
	g.Tick()
	g.Tick()
	if g.Money != 20 {
		t.Errorf("после двух тиков Money = %d, хотим 20", g.Money)
	}
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — `undefined: (\*Game).Connected` и т.п.

- [ ] **Step 3: Реализация**

Добавить в `server/internal/game/game.go` (импорт `"math"`):

```go
// Ports — сколько рабочих мест роутер может подключить к сети.
func (g *Game) Ports() int {
	if g.RouterTier == 0 {
		return 0
	}
	return g.cfg.RouterTiers[g.RouterTier-1].Ports
}

// Connected — сколько сотрудников сейчас в сети:
// подключаются автоматически первые N занятых мест, N = порты роутера.
func (g *Game) Connected() int {
	return min(g.Ports(), g.Employees)
}

// Multiplier — сетевой множитель выработки подключённых рабочих мест.
// Без роутера сеть не существует, и серверы не дают ничего.
func (g *Game) Multiplier() float64 {
	if g.RouterTier == 0 {
		return 1.0
	}
	return g.cfg.NetworkBase + g.cfg.ServerBonus*float64(g.Servers)
}

// IncomePerTick — доход за один тик при текущем состоянии.
func (g *Game) IncomePerTick() int {
	base := g.cfg.BaseIncomePerTick
	connected := g.Connected()
	perConnected := int(math.Round(float64(base) * g.Multiplier()))
	return connected*perConnected + (g.Employees-connected)*base
}

// Tick — один шаг симуляции (1 секунда игрового времени).
func (g *Game) Tick() {
	g.Money += g.IncomePerTick()
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./internal/game/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/game/
git commit -m "feat(game): сеть, множитель серверов, доход и тик симуляции"
```

---

### Task 6: Домен — диспетчер команд Apply

**Files:**
- Modify: `server/internal/game/commands.go`, `server/internal/game/game_test.go`

**Interfaces:**
- Consumes: все методы-команды из Tasks 3–4.
- Produces: тип `game.Command` (string), константы `CmdBuyPC = "buy_pc"`, `CmdHire = "hire"`, `CmdBuyRouter = "buy_router"`, `CmdBuyServer = "buy_server"`; ошибка `ErrUnknownCommand = "unknown_command"`; метод `(*Game).Apply(cmd Command) error`. Значения констант — это ровно поле `type` клиентского сообщения: ws-слой делает `game.Command(msg.Type)`.

- [ ] **Step 1: Падающий тест**

Добавить в `server/internal/game/game_test.go`:

```go
func TestApply(t *testing.T) {
	g := New(DefaultConfig())
	if err := g.Apply(CmdHire); err != nil {
		t.Fatalf("Apply(hire): %v", err)
	}
	if g.Employees != 1 {
		t.Errorf("Apply(hire) не нанял: Employees = %d", g.Employees)
	}
	if err := g.Apply(Command("dance")); err != ErrUnknownCommand {
		t.Errorf("неизвестная команда: err = %v, хотим %v", err, ErrUnknownCommand)
	}
}
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — `undefined: CmdHire`.

- [ ] **Step 3: Реализация**

Добавить в `server/internal/game/commands.go`:

```go
const ErrUnknownCommand = Err("unknown_command")

// Command — команда игрока. Значение совпадает с полем type
// клиентского сообщения протокола.
type Command string

const (
	CmdBuyPC     = Command("buy_pc")
	CmdHire      = Command("hire")
	CmdBuyRouter = Command("buy_router")
	CmdBuyServer = Command("buy_server")
)

// Apply выполняет команду игрока.
func (g *Game) Apply(cmd Command) error {
	switch cmd {
	case CmdBuyPC:
		return g.BuyPC()
	case CmdHire:
		return g.Hire()
	case CmdBuyRouter:
		return g.BuyRouter()
	case CmdBuyServer:
		return g.BuyServer()
	default:
		return ErrUnknownCommand
	}
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./internal/game/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/game/
git commit -m "feat(game): диспетчер команд Apply с кодом unknown_command"
```

---

### Task 7: WS — протокол и снапшот

**Files:**
- Create: `server/internal/ws/protocol.go`
- Test: `server/internal/ws/protocol_test.go`

**Interfaces:**
- Consumes: `game.Game` и его методы из Tasks 2–6.
- Produces (внутри пакета ws): `clientMessage{Type string}`, `stateMessage` (все поля ниже), `prices`, `errorMessage{Type, Code string}`, `snapshot(g *game.Game) stateMessage`. JSON-поля — camelCase, как в клиентском `src/protocol.ts` (Task 9).

- [ ] **Step 1: Падающий тест**

`server/internal/ws/protocol_test.go`:

```go
package ws

import (
	"testing"

	"itdirector/internal/game"
)

func TestSnapshot(t *testing.T) {
	g := game.New(game.DefaultConfig())
	s := snapshot(g)
	if s.Type != "state" {
		t.Errorf("Type = %q, хотим state", s.Type)
	}
	if s.Money != 600 || s.PCs != 1 || s.OfficeSlots != 9 || s.RackSlots != 3 {
		t.Errorf("стартовый снапшот неверен: %+v", s)
	}
	if s.Prices.PC != 500 || s.Prices.Hire != 300 || s.Prices.Server != 2000 || s.Prices.NextRouter != 800 {
		t.Errorf("цены в снапшоте неверны: %+v", s.Prices)
	}
	if s.Multiplier != 1.0 || s.IncomePerTick != 0 {
		t.Errorf("производные поля неверны: %+v", s)
	}
}
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && go test ./internal/ws/`
Expected: FAIL — `undefined: snapshot`.

- [ ] **Step 3: Реализация**

`server/internal/ws/protocol.go`:

```go
// Package ws — WebSocket-протокол и сессии игры.
package ws

import "itdirector/internal/game"

// clientMessage — любое сообщение клиента: {"type": "buy_pc" | ...}.
type clientMessage struct {
	Type string `json:"type"`
}

// stateMessage — полный снапшот состояния. Включает производные поля
// (доход, порты, множитель), чтобы клиент ничего не считал сам.
type stateMessage struct {
	Type          string  `json:"type"` // всегда "state"
	Money         int     `json:"money"`
	PCs           int     `json:"pcs"`
	Employees     int     `json:"employees"`
	RouterTier    int     `json:"routerTier"`
	Ports         int     `json:"ports"`
	Connected     int     `json:"connected"`
	Servers       int     `json:"servers"`
	Multiplier    float64 `json:"multiplier"`
	IncomePerTick int     `json:"incomePerTick"`
	OfficeSlots   int     `json:"officeSlots"`
	RackSlots     int     `json:"rackSlots"`
	Prices        prices  `json:"prices"`
}

type prices struct {
	PC         int `json:"pc"`
	Hire       int `json:"hire"`
	Server     int `json:"server"`
	NextRouter int `json:"nextRouter"` // 0 — роутер уже максимального тира
}

type errorMessage struct {
	Type string `json:"type"` // всегда "error"
	Code string `json:"code"`
}

func snapshot(g *game.Game) stateMessage {
	cfg := g.Config()
	return stateMessage{
		Type:          "state",
		Money:         g.Money,
		PCs:           g.PCs,
		Employees:     g.Employees,
		RouterTier:    g.RouterTier,
		Ports:         g.Ports(),
		Connected:     g.Connected(),
		Servers:       g.Servers,
		Multiplier:    g.Multiplier(),
		IncomePerTick: g.IncomePerTick(),
		OfficeSlots:   cfg.OfficeSlots,
		RackSlots:     cfg.RackSlots,
		Prices: prices{
			PC:         cfg.PCPrice,
			Hire:       cfg.HirePrice,
			Server:     cfg.ServerPrice,
			NextRouter: g.NextRouterPrice(),
		},
	}
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./internal/ws/`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add server/internal/ws/
git commit -m "feat(ws): протокол сообщений и снапшот состояния"
```

---

### Task 8: WS — сессия-актор и маршруты сервера

**Files:**
- Create: `server/internal/ws/session.go`
- Modify: `server/cmd/server/main.go`
- Test: `server/internal/ws/session_test.go`

**Interfaces:**
- Consumes: `game.New`, `game.Command`, `(*Game).Apply/Tick`; `snapshot`, `clientMessage`, `errorMessage` из Task 7.
- Produces: `ws.Handler{Config game.Config; TickInterval time.Duration}` — `http.Handler`; маршрут `GET /ws` в main; флаг `-static` для раздачи собранного клиента.

- [ ] **Step 1: Зависимость**

Run: `cd server && go get github.com/coder/websocket@latest`
Expected: строки `go: added github.com/coder/websocket v1.8.x` в выводе.

- [ ] **Step 2: Падающие интеграционные тесты**

`server/internal/ws/session_test.go`:

```go
package ws

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
)

// testMessage покрывает и state, и error — удобно читать любой ответ.
type testMessage struct {
	Type      string `json:"type"`
	Code      string `json:"code"`
	Money     int    `json:"money"`
	Employees int    `json:"employees"`
}

func dialTestServer(t *testing.T, tick time.Duration) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := httptest.NewServer(&Handler{Config: game.DefaultConfig(), TickInterval: tick})
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, ctx
}

func TestSessionCommands(t *testing.T) {
	// Тикер на час: тики не мешают проверке команд.
	c, ctx := dialTestServer(t, time.Hour)

	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatalf("первый снапшот: %v", err)
	}
	if msg.Type != "state" || msg.Money != 600 {
		t.Fatalf("первый снапшот: %+v", msg)
	}

	// Успешный найм.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire"}); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "state" || msg.Employees != 1 || msg.Money != 300 {
		t.Fatalf("после найма: %+v", msg)
	}

	// Сервер не по карману — ошибка с кодом.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "buy_server"}); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Type != "error" || msg.Code != "not_enough_money" {
		t.Fatalf("хотим error/not_enough_money, получили: %+v", msg)
	}
}

func TestSessionTicks(t *testing.T) {
	c, ctx := dialTestServer(t, 10*time.Millisecond)

	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire"}); err != nil {
		t.Fatal(err)
	}
	// Ждём, пока доход от тиков превысит остаток после найма ($300).
	for msg.Money <= 300 {
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			t.Fatalf("ждали рост денег от тиков: %v (последнее: %+v)", err, msg)
		}
	}
}
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/ws/`
Expected: FAIL — `undefined: Handler`.

- [ ] **Step 4: Реализация сессии**

`server/internal/ws/session.go`:

```go
package ws

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
)

// Handler на каждое подключение создаёт свою игру и запускает актор-цикл.
type Handler struct {
	Config       game.Config
	TickInterval time.Duration
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Vite dev server проксирует /ws с другого порта.
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*"},
	})
	if err != nil {
		return
	}
	defer c.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	commands := make(chan game.Command)
	go readLoop(ctx, cancel, c, commands)

	h.run(ctx, c, commands)
	c.Close(websocket.StatusNormalClosure, "игра окончена")
}

// readLoop — единственный читатель соединения: превращает входящие
// сообщения в команды для актора.
func readLoop(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn, commands chan<- game.Command) {
	defer cancel() // разрыв соединения останавливает актор
	for {
		var msg clientMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			return
		}
		select {
		case commands <- game.Command(msg.Type):
		case <-ctx.Done():
			return
		}
	}
}

// run — актор: единственная горутина, владеющая состоянием игры.
// Всё общение с миром — через канал команд и тикер; писем в сокет
// из других горутин нет, поэтому мьютексы не нужны.
func (h *Handler) run(ctx context.Context, c *websocket.Conn, commands <-chan game.Command) {
	g := game.New(h.Config)
	ticker := time.NewTicker(h.TickInterval)
	defer ticker.Stop()

	if wsjson.Write(ctx, c, snapshot(g)) != nil {
		return
	}
	for {
		select {
		case cmd := <-commands:
			var out any
			if err := g.Apply(cmd); err != nil {
				out = errorMessage{Type: "error", Code: err.Error()}
			} else {
				out = snapshot(g)
			}
			if wsjson.Write(ctx, c, out) != nil {
				return
			}
		case <-ticker.C:
			g.Tick()
			if wsjson.Write(ctx, c, snapshot(g)) != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}
```

- [ ] **Step 5: Маршруты в main**

Заменить `server/cmd/server/main.go` целиком:

```go
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
	mux.Handle("/ws", &ws.Handler{Config: game.DefaultConfig(), TickInterval: time.Second})
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

- [ ] **Step 6: Все тесты зелёные**

Run: `cd server && go vet ./... && go test ./...`
Expected: `ok` для `internal/game` и `internal/ws`.

- [ ] **Step 7: Commit**

```bash
git add server/
git commit -m "feat(ws): сессия-актор с тикером и маршрут /ws"
```

---

### Task 9: Клиент — скаффолдинг, сеть, HUD с живыми деньгами

**Files:**
- Create: `client/package.json`, `client/tsconfig.json`, `client/vite.config.ts`, `client/index.html`, `client/src/protocol.ts`, `client/src/net.ts`, `client/src/main.ts`, `client/src/scenes/BootScene.ts`, `client/src/scenes/HUDScene.ts`

**Interfaces:**
- Consumes: WS-протокол из Tasks 7–8 (`/ws`, camelCase-поля).
- Produces: типы `StateMessage`, `ErrorMessage`, `ServerMessage`, `CommandType` (`src/protocol.ts`); синглтон `client: GameClient` с `connect()`, `send(cmd: CommandType)`, `subscribe(l: Listener): () => void`, `latest: StateMessage | null`; `Listener = { onState(s): void; onError(code: string): void; onDisconnect(): void }`. Ключи сцен: `'boot'`, `'hud'` (позже `'office'`, `'serverRoom'`).

- [ ] **Step 1: Конфиги проекта**

`client/package.json`:

```json
{
  "name": "it-director-client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "phaser": "^3.90.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^7.0.0"
  }
}
```

`client/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"],
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`client/vite.config.ts`:

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      // dev: WebSocket идёт через Vite на Go-сервер
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
```

`client/index.html`:

```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>IT Director</title>
    <style>
      html, body { margin: 0; background: #1a1c2c; }
      #app { display: flex; justify-content: center; padding-top: 8px; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Установка зависимостей**

Run: `cd client && npm install`
Expected: `added N packages`, без ошибок.

- [ ] **Step 3: Типы протокола и сетевой клиент**

`client/src/protocol.ts`:

```ts
// Зеркало server/internal/ws/protocol.go — менять синхронно.

export interface StateMessage {
  type: 'state'
  money: number
  pcs: number
  employees: number
  routerTier: number
  ports: number
  connected: number
  servers: number
  multiplier: number
  incomePerTick: number
  officeSlots: number
  rackSlots: number
  prices: { pc: number; hire: number; server: number; nextRouter: number }
}

export interface ErrorMessage {
  type: 'error'
  code: string
}

export type ServerMessage = StateMessage | ErrorMessage

export type CommandType = 'buy_pc' | 'hire' | 'buy_router' | 'buy_server'
```

`client/src/net.ts`:

```ts
import type { CommandType, ServerMessage, StateMessage } from './protocol'

export interface Listener {
  onState(s: StateMessage): void
  onError(code: string): void
  onDisconnect(): void
}

// GameClient — единственная точка общения с сервером.
// Сцены подписываются и получают снапшоты; игровой логики здесь нет.
export class GameClient {
  latest: StateMessage | null = null
  private ws!: WebSocket
  private listeners: Listener[] = []

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as ServerMessage
      if (msg.type === 'state') {
        this.latest = msg
        this.listeners.forEach((l) => l.onState(msg))
      } else {
        this.listeners.forEach((l) => l.onError(msg.code))
      }
    }
    this.ws.onclose = () => this.listeners.forEach((l) => l.onDisconnect())
  }

  send(cmd: CommandType): void {
    this.ws.send(JSON.stringify({ type: cmd }))
  }

  // Возвращает функцию отписки — сцены зовут её на shutdown.
  subscribe(l: Listener): () => void {
    this.listeners.push(l)
    if (this.latest) l.onState(this.latest)
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l)
    }
  }
}

export const client = new GameClient()
```

- [ ] **Step 4: Сцены Boot и HUD, точка входа**

`client/src/scenes/BootScene.ts`:

```ts
import Phaser from 'phaser'

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  create() {
    // Комнаты появятся в задачах 10–11; пока стартуем только HUD.
    this.scene.start('hud')
  }
}
```

`client/src/scenes/HUDScene.ts`:

```ts
import Phaser from 'phaser'
import { client } from '../net'
import type { StateMessage } from '../protocol'

const ERROR_TEXTS: Record<string, string> = {
  not_enough_money: 'Не хватает денег',
  no_free_office_slot: 'В офисе нет свободных мест',
  no_free_pc: 'Нет свободного ПК — купите ПК',
  no_free_rack_slot: 'В серверной нет свободных стоек',
  router_maxed: 'Роутер уже максимального тира',
  unknown_command: 'Неизвестная команда',
}

interface Button {
  setLabel(s: string): void
}

export class HUDScene extends Phaser.Scene {
  private moneyText!: Phaser.GameObjects.Text
  private incomeText!: Phaser.GameObjects.Text
  private netText!: Phaser.GameObjects.Text
  private pcBtn!: Button
  private hireBtn!: Button
  private routerBtn!: Button
  private serverBtn!: Button

  constructor() {
    super('hud')
  }

  create() {
    // Верхняя панель.
    this.add.rectangle(0, 0, 960, 96, 0x14162b).setOrigin(0)
    this.moneyText = this.add.text(16, 10, '$…', {
      fontFamily: 'monospace', fontSize: '26px', color: '#ffcd75',
    })
    this.incomeText = this.add.text(16, 44, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#38b764',
    })
    this.netText = this.add.text(16, 66, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#41a6f6',
    })

    this.pcBtn = this.makeButton(300, 10, () => client.send('buy_pc'))
    this.hireBtn = this.makeButton(300, 52, () => client.send('hire'))
    this.routerBtn = this.makeButton(520, 10, () => client.send('buy_router'))
    this.serverBtn = this.makeButton(520, 52, () => client.send('buy_server'))

    const unsub = client.subscribe({
      onState: (s) => this.refresh(s),
      onError: (code) => this.toast(ERROR_TEXTS[code] ?? code),
      onDisconnect: () => {}, // экран дисконнекта — задача 12
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  private refresh(s: StateMessage) {
    this.moneyText.setText(`$${s.money}`)
    this.incomeText.setText(`+$${s.incomePerTick}/сек`)
    this.netText.setText(`Сотрудники: ${s.employees} · в сети ${s.connected} · ×${s.multiplier.toFixed(1)}`)
    this.pcBtn.setLabel(`Купить ПК  $${s.prices.pc}`)
    this.hireBtn.setLabel(`Нанять  $${s.prices.hire}`)
    this.routerBtn.setLabel(s.prices.nextRouter > 0 ? `Роутер  $${s.prices.nextRouter}` : 'Роутер MAX')
    this.serverBtn.setLabel(`Сервер  $${s.prices.server}`)
  }

  private makeButton(x: number, y: number, onClick: () => void): Button {
    const bg = this.add
      .rectangle(x, y, 200, 34, 0x3b5dc9)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: true })
    const txt = this.add
      .text(x + 100, y + 17, '…', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5)
    bg.on('pointerdown', onClick)
    bg.on('pointerover', () => bg.setFillStyle(0x41a6f6))
    bg.on('pointerout', () => bg.setFillStyle(0x3b5dc9))
    return { setLabel: (s: string) => txt.setText(s) }
  }

  private toast(text: string) {
    const t = this.add
      .text(480, 600, text, {
        fontFamily: 'monospace', fontSize: '18px', color: '#f4f4f4',
        backgroundColor: '#b13e53', padding: { x: 12, y: 6 },
      })
      .setOrigin(0.5)
    this.tweens.add({ targets: t, alpha: 0, y: 560, duration: 1500, onComplete: () => t.destroy() })
  }
}
```

`client/src/main.ts`:

```ts
import Phaser from 'phaser'
import { client } from './net'
import { BootScene } from './scenes/BootScene'
import { HUDScene } from './scenes/HUDScene'

client.connect()

new Phaser.Game({
  type: Phaser.AUTO,
  width: 960,
  height: 640,
  parent: 'app',
  pixelArt: true, // чёткие пиксели без сглаживания
  backgroundColor: '#1a1c2c',
  scene: [BootScene, HUDScene],
})
```

- [ ] **Step 5: Проверка типов**

Run: `cd client && npm run typecheck`
Expected: без ошибок, пустой вывод.

- [ ] **Step 6: Ручная проверка end-to-end**

Run: `make dev` (в фоне), открыть http://localhost:5173
Expected: панель HUD; после «Нанять» деньги падают до $300 и дальше растут на $10/сек; «Сервер» показывает тост «Не хватает денег». Остановить `make dev`.

- [ ] **Step 7: Commit**

```bash
git add client/ 
git commit -m "feat(client): каркас Vite+Phaser, сетевой клиент и HUD с живыми деньгами"
```

---

### Task 10: Клиент — пиксель-арт и сцена офиса

**Files:**
- Create: `client/src/pixelart.ts`, `client/src/scenes/OfficeScene.ts`
- Modify: `client/src/scenes/BootScene.ts`, `client/src/main.ts`

**Interfaces:**
- Consumes: `client.subscribe`, `StateMessage` из Task 9.
- Produces: `registerTextures(scene: Phaser.Scene): void` — регистрирует текстуры `desk_empty`, `desk_pc`, `worker`, `router`, `rack_empty`, `rack_server` (16×16); сцена с ключом `'office'`.

- [ ] **Step 1: Кодогенерируемые спрайты**

`client/src/pixelart.ts`:

```ts
import Phaser from 'phaser'

// Палитра в духе Sweetie-16. Точка — прозрачный пиксель.
const PALETTE: Record<string, string> = {
  k: '#1a1c2c', // чёрный
  w: '#f4f4f4', // белый
  g: '#5d7275', // серый металл
  b: '#3b5dc9', // синий (одежда)
  s: '#41a6f6', // голубой (экраны)
  d: '#8b5e3c', // дерево
  y: '#ffcd75', // кожа/жёлтый
  r: '#b13e53', // красный
  e: '#38b764', // зелёный (диоды)
}

// Спрайты 16×16: 16 строк по 16 символов из PALETTE.
const SPRITES: Record<string, string[]> = {
  desk_empty: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '..dddddddddddd..',
    '..dddddddddddd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '................',
  ],
  desk_pc: [
    '................',
    '................',
    '....kkkkkkkk....',
    '....kssssssk....',
    '....kssssssk....',
    '....kssswssk....',
    '....kkkkkkkk....',
    '.......kk.......',
    '......kkkk......',
    '..dddddddddddd..',
    '..dddddddddddd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '..dd........dd..',
    '................',
  ],
  worker: [
    '................',
    '.....yyyyy......',
    '....yyyyyyy.....',
    '....yykykyy.....',
    '....yyyyyyy.....',
    '.....yyyy.......',
    '....bbbbbb......',
    '...bbbbbbbb.....',
    '...b.bbbb.b.....',
    '...y.bbbb.y.....',
    '.....bbbb.......',
    '.....b..b.......',
    '.....b..b.......',
    '.....k..k.......',
    '................',
    '................',
  ],
  router: [
    '................',
    '................',
    '................',
    '......k..k......',
    '......k..k......',
    '......k..k......',
    '...kkkkkkkkkk...',
    '...kwkkkkkkek...',
    '...kkkkkkkkkk...',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  rack_empty: [
    '...gggggggggg...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...g........g...',
    '...gggggggggg...',
    '................',
  ],
  rack_server: [
    '...gggggggggg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...gke....wkg...',
    '...gkkkkkkkkg...',
    '...g........g...',
    '...g........g...',
    '...gggggggggg...',
    '................',
  ],
}

// registerTextures рисует все спрайты в canvas-текстуры Phaser.
// Вызывать один раз в BootScene до старта комнат.
export function registerTextures(scene: Phaser.Scene): void {
  for (const [key, rows] of Object.entries(SPRITES)) {
    const canvas = scene.textures.createCanvas(key, 16, 16)
    if (!canvas) continue // текстура уже зарегистрирована
    const ctx = canvas.context
    rows.forEach((row, y) => {
      ;[...row].forEach((ch, x) => {
        const color = PALETTE[ch]
        if (color) {
          ctx.fillStyle = color
          ctx.fillRect(x, y, 1, 1)
        }
      })
    })
    canvas.refresh()
  }
}
```

- [ ] **Step 2: Сцена офиса**

`client/src/scenes/OfficeScene.ts`:

```ts
import Phaser from 'phaser'
import { client } from '../net'
import type { StateMessage } from '../protocol'

const SCALE = 4 // 16px спрайт → 64px на экране
const GRID = { cols: 3, startX: 220, startY: 200, stepX: 220, stepY: 160 }

export class OfficeScene extends Phaser.Scene {
  private objects: Phaser.GameObjects.GameObject[] = []

  constructor() {
    super('office')
  }

  create() {
    this.add.rectangle(0, 96, 960, 544, 0x2b2f4a).setOrigin(0) // пол офиса
    this.add.text(480, 116, 'ОФИС', {
      fontFamily: 'monospace', fontSize: '16px', color: '#5d7275',
    }).setOrigin(0.5)

    const unsub = client.subscribe({
      onState: (s) => this.render(s),
      onError: () => {},
      onDisconnect: () => {},
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  // Полная перерисовка на каждый снапшот: объектов мало, зато нет
  // рассинхрона между стейтом и картинкой.
  private render(s: StateMessage) {
    this.objects.forEach((o) => o.destroy())
    this.objects = []

    // Специальный слот роутера: рабочее место сюда не поставить.
    const rx = 856
    const ry = 170
    this.objects.push(
      this.add.rectangle(rx, ry, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(rx, ry - 56, 'сеть', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (s.routerTier > 0) {
      this.objects.push(
        this.add.image(rx, ry, 'router').setScale(SCALE),
        this.add.text(rx, ry + 52, `роутер т${s.routerTier} · ${s.ports} порт.`, {
          fontFamily: 'monospace', fontSize: '11px', color: '#41a6f6',
        }).setOrigin(0.5),
      )
    } else {
      this.objects.push(
        this.add.text(rx, ry, 'нет\nроутера', {
          fontFamily: 'monospace', fontSize: '11px', color: '#5d7275', align: 'center',
        }).setOrigin(0.5),
      )
    }

    // Рабочие места: первые pcs слотов — с ПК, первые employees — с людьми,
    // первые connected — с зелёным индикатором сети.
    for (let i = 0; i < s.officeSlots; i++) {
      const x = GRID.startX + (i % GRID.cols) * GRID.stepX
      const y = GRID.startY + Math.floor(i / GRID.cols) * GRID.stepY
      this.objects.push(this.add.image(x, y, i < s.pcs ? 'desk_pc' : 'desk_empty').setScale(SCALE))
      if (i < s.employees) {
        this.objects.push(this.add.image(x - 52, y - 6, 'worker').setScale(SCALE))
        if (i < s.connected) {
          this.objects.push(this.add.circle(x + 30, y - 30, 4, 0x38b764))
        }
      }
    }
  }
}
```

- [ ] **Step 3: Подключить сцену**

`client/src/scenes/BootScene.ts`, метод `create()` — заменить на:

```ts
  create() {
    registerTextures(this)
    this.scene.start('office')
    this.scene.launch('hud') // HUD живёт поверх комнат
  }
```

и добавить импорт: `import { registerTextures } from '../pixelart'`.

`client/src/main.ts` — добавить импорт `import { OfficeScene } from './scenes/OfficeScene'` и включить сцену: `scene: [BootScene, OfficeScene, HUDScene]`.

- [ ] **Step 4: Проверка типов**

Run: `cd client && npm run typecheck`
Expected: без ошибок.

- [ ] **Step 5: Ручная проверка**

Run: `make dev`, открыть http://localhost:5173
Expected: комната офиса с одним столом с ПК; «Нанять» — появляется работник; «Купить ПК» — появляется второй стол; пустой слот роутера с подписью «нет роутера»; после покупки роутера у первых занятых мест — зелёные точки. Остановить.

- [ ] **Step 6: Commit**

```bash
git add client/
git commit -m "feat(client): пиксель-спрайты и сцена офиса"
```

---

### Task 11: Клиент — серверная и переключение комнат

**Files:**
- Create: `client/src/scenes/ServerRoomScene.ts`
- Modify: `client/src/main.ts`, `client/src/scenes/HUDScene.ts`

**Interfaces:**
- Consumes: текстуры `rack_empty`, `rack_server` из Task 10; `client.subscribe`.
- Produces: сцена с ключом `'serverRoom'`; в HUD — кнопка-переключатель комнат (поле `room: 'office' | 'serverRoom'`).

- [ ] **Step 1: Сцена серверной**

`client/src/scenes/ServerRoomScene.ts`:

```ts
import Phaser from 'phaser'
import { client } from '../net'
import type { StateMessage } from '../protocol'

const SCALE = 6 // стойки крупнее столов

export class ServerRoomScene extends Phaser.Scene {
  private objects: Phaser.GameObjects.GameObject[] = []

  constructor() {
    super('serverRoom')
  }

  create() {
    this.add.rectangle(0, 96, 960, 544, 0x1f2233).setOrigin(0) // сумрак серверной
    this.add.text(480, 116, 'СЕРВЕРНАЯ', {
      fontFamily: 'monospace', fontSize: '16px', color: '#5d7275',
    }).setOrigin(0.5)

    const unsub = client.subscribe({
      onState: (s) => this.render(s),
      onError: () => {},
      onDisconnect: () => {},
    })
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)
  }

  private render(s: StateMessage) {
    this.objects.forEach((o) => o.destroy())
    this.objects = []

    for (let i = 0; i < s.rackSlots; i++) {
      const x = 300 + i * 180
      const y = 360
      this.objects.push(this.add.image(x, y, i < s.servers ? 'rack_server' : 'rack_empty').setScale(SCALE))
    }

    const note = s.routerTier === 0 && s.servers > 0 ? ' — без роутера серверы не работают!' : ''
    this.objects.push(
      this.add.text(480, 560, `Серверов: ${s.servers} · множитель сети ×${s.multiplier.toFixed(1)}${note}`, {
        fontFamily: 'monospace', fontSize: '15px', color: s.routerTier === 0 && s.servers > 0 ? '#b13e53' : '#41a6f6',
      }).setOrigin(0.5),
    )
  }
}
```

- [ ] **Step 2: Переключатель комнат в HUD**

В `client/src/scenes/HUDScene.ts`:

Добавить поля:

```ts
  private room: 'office' | 'serverRoom' = 'office'
  private switchBtn!: Button
```

В `create()` после создания четырёх кнопок добавить:

```ts
    this.switchBtn = this.makeButton(740, 31, () => this.switchRoom())
    this.switchBtn.setLabel('В серверную →')
```

Добавить метод:

```ts
  private switchRoom() {
    const next = this.room === 'office' ? 'serverRoom' : 'office'
    this.scene.stop(this.room)
    this.scene.launch(next)
    this.room = next
    this.switchBtn.setLabel(this.room === 'office' ? 'В серверную →' : '← В офис')
  }
```

- [ ] **Step 3: Регистрация сцены**

`client/src/main.ts` — импорт `import { ServerRoomScene } from './scenes/ServerRoomScene'`, массив сцен: `scene: [BootScene, OfficeScene, ServerRoomScene, HUDScene]`.

- [ ] **Step 4: Проверка типов**

Run: `cd client && npm run typecheck`
Expected: без ошибок.

- [ ] **Step 5: Ручная проверка**

Run: `make dev`, открыть http://localhost:5173
Expected: кнопка «В серверную →» переключает комнату (HUD остаётся); в серверной 3 пустых стойки; после покупки сервера стойка заполняется, у сервера без роутера — красное предупреждение; «← В офис» возвращает. Остановить.

- [ ] **Step 6: Commit**

```bash
git add client/
git commit -m "feat(client): серверная и переключение комнат"
```

---

### Task 12: Полировка — дисконнект, README, прод-раздача, GDD

**Files:**
- Modify: `client/src/scenes/HUDScene.ts`, `docs/design/gdd.md`
- Create: `README.md`

**Interfaces:**
- Consumes: `onDisconnect` колбэк из Task 9; флаг `-static` из Task 8.

- [ ] **Step 1: Экран дисконнекта**

В `client/src/scenes/HUDScene.ts` заменить `onDisconnect: () => {}` на `onDisconnect: () => this.showDisconnect()` и добавить метод:

```ts
  private showDisconnect() {
    this.add.rectangle(0, 0, 960, 640, 0x1a1c2c, 0.85).setOrigin(0).setDepth(100)
    this.add
      .text(480, 300, 'Соединение потеряно', {
        fontFamily: 'monospace', fontSize: '28px', color: '#b13e53',
      })
      .setOrigin(0.5)
      .setDepth(101)
    this.add
      .text(480, 344, 'Игра не сохраняется — обновите страницу, чтобы начать заново', {
        fontFamily: 'monospace', fontSize: '15px', color: '#f4f4f4',
      })
      .setOrigin(0.5)
      .setDepth(101)
  }
```

Run: `cd client && npm run typecheck` — без ошибок.
Ручная проверка: `make dev`, открыть игру, убить go-процесс (Ctrl+C) → оверлей «Соединение потеряно».

- [ ] **Step 2: Прод-сборка работает**

Run: `make build && ./bin/itdirector -static client/dist` и открыть http://localhost:8080
Expected: игра работает без Vite (статика и /ws с одного порта). Остановить.

- [ ] **Step 3: README.md**

```markdown
# IT Director Web Game

Форк старой web-игры Intel «IT Manager 3: Unseen Forces» в pixel style.
Кликер про развитие IT-компании: офис, серверная, ПК, сотрудники, роутер
и серверы-мультипликаторы.

## Стек

- Сервер: Go — на каждое WebSocket-подключение своя игра и горутина-актор
  (тик 1 с). Без сохранений: разрыв соединения = новая игра.
- Клиент: Phaser 3 + TypeScript + Vite, кодогенерируемый пиксель-арт.

## Запуск (dev)

    make dev        # Go-сервер :8080 + Vite :5173 (открыть http://localhost:5173)

## Прод-сборка

    make build
    ./bin/itdirector -static client/dist   # всё на http://localhost:8080

## Тесты

    make test        # Go: домен и WebSocket-слой
    make typecheck   # клиент: проверка типов

## Документация

- Геймдизайн (живой): docs/design/gdd.md
- Спека итерации 1: docs/superpowers/specs/2026-07-11-it-director-mvp-design.md
```

- [ ] **Step 4: Обновить GDD**

В `docs/design/gdd.md`:
1. В «Бэклог идей» добавить строку: `- Заменить кодогенерируемые спрайты на готовый CC0-пак (Kenney/itch.io) или свой арт.`
2. Провести плейтест (сыграть от старта до 9 сотрудников на ×3.0) и записать наблюдения в раздел «Плейтест» вместо строки «_Записей пока нет._» (что скучно, где провис темпа, какие числа крутить).

- [ ] **Step 5: Финальная проверка**

Run: `make test && make typecheck && (cd server && go vet ./...)`
Expected: всё зелёное.

- [ ] **Step 6: Commit**

```bash
git add README.md client/ docs/
git commit -m "feat: экран дисконнекта, README и плейтест-заметки итерации 1"
```

---

## Порядок и зависимости

Задачи 1→8 строго последовательны (сервер), 9→12 последовательны (клиент) и требуют завершённой задачи 8. Распараллеливать нечего: каждая задача строится на интерфейсах предыдущей.
