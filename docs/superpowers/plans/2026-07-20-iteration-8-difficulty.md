# Итерация 8 — сложность, стартовый экран, победа: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Стартовый экран с 4 уровнями сложности, баланс уровня = коэффициенты × база, победа по целевому балансу.

**Architecture:** Сложность передаётся query-параметром WS-подключения (`/ws?difficulty=hard`) — сервер строит конфиг уровня из `DefaultConfig()` и создаёт игру как раньше, лобби-состояния нет. Клиент получает новую сцену `MenuScene`; подключение происходит только после выбора. Победа — новая фаза `won`, проверяется в тике.

**Tech Stack:** Go (server), Phaser 3 + TypeScript (client), протокол — JSON/WS с ручным зеркалом `protocol.go` ↔ `protocol.ts`.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-07-20-iteration-8-difficulty-design.md` — коэффициенты и цели победы КОПИРОВАТЬ оттуда, не выдумывать.
- Денежные значения после умножения: округление до целого доллара (`math.Round`), минимум $1.
- Инвариант: на каждом уровне `StartMoney ≥ HirePrice`.
- Сетевые множители (стойки, core, шлюз) НЕ скалируются.
- `protocol.ts` — ручное зеркало `protocol.go`: менять синхронно в одном коммите.
- `?difficulty=<мусор>` и отсутствие параметра → normal, без ошибки.
- Работа в ветке `iteration-8`; мерж в main — только после плейтеста пользователя.

---

### Task 1: game.Difficulty + конфиг уровня

**Files:**
- Create: `server/internal/game/difficulty.go`
- Create: `server/internal/game/difficulty_test.go`
- Modify: `server/internal/game/config.go` (двa поля Config + значения в DefaultConfig)

**Interfaces:**
- Produces: `type Difficulty string`; константы `DiffEasy/DiffNormal/DiffHard/DiffHardcore` ("easy"/"normal"/"hard"/"hardcore"); `ParseDifficulty(s string) Difficulty`; `ApplyDifficulty(c Config, d Difficulty) Config`; `ConfigForDifficulty(d Difficulty) Config`; поля `Config.Difficulty Difficulty`, `Config.WinTarget int`.

- [ ] **Step 1: Написать падающий тест** `server/internal/game/difficulty_test.go`:

```go
package game

import "testing"

// Снапшот ключевых значений каждого уровня — числа из спеки итерации 8.
func TestConfigForDifficulty(t *testing.T) {
	cases := []struct {
		d          Difficulty
		start, pc, hire, salary, bossSalary int
		incomeMin, incomeMax, coffeePct, winTarget int
		routerT1   int
		debuff     float64
	}{
		{DiffEasy, 900, 400, 240, 200, 400, 10, 16, 50, 60000, 640, 0.95},
		{DiffNormal, 600, 500, 300, 250, 500, 9, 14, 40, 120000, 800, 0.9},
		{DiffHard, 540, 625, 375, 313, 625, 8, 13, 30, 250000, 1000, 0.88},
		{DiffHardcore, 480, 750, 450, 375, 750, 7, 11, 20, 500000, 1200, 0.85},
	}
	for _, tc := range cases {
		c := ConfigForDifficulty(tc.d)
		if c.Difficulty != tc.d || c.StartMoney != tc.start || c.PCPrice != tc.pc ||
			c.HirePrice != tc.hire || c.SalaryPerDay != tc.salary ||
			c.BossSalaryPerDay != tc.bossSalary || c.IncomeMin != tc.incomeMin ||
			c.IncomeMax != tc.incomeMax || c.CoffeeChancePct != tc.coffeePct ||
			c.WinTarget != tc.winTarget || c.RouterTiers[0].Price != tc.routerT1 ||
			c.ThirstMult != tc.debuff || c.HungerMult != tc.debuff {
			t.Errorf("%s: %+v", tc.d, c)
		}
	}
}

// Инвариант спеки: первая покупка (найм) возможна на любом уровне.
func TestStartMoneyCoversHire(t *testing.T) {
	for _, d := range []Difficulty{DiffEasy, DiffNormal, DiffHard, DiffHardcore} {
		c := ConfigForDifficulty(d)
		if c.StartMoney < c.HirePrice {
			t.Errorf("%s: StartMoney %d < HirePrice %d", d, c.StartMoney, c.HirePrice)
		}
	}
}

// Норма — ровно базовый баланс (коэффициенты 1.0 не искажают числа).
func TestNormalEqualsDefault(t *testing.T) {
	base, norm := DefaultConfig(), ConfigForDifficulty(DiffNormal)
	if norm.PCPrice != base.PCPrice || norm.StartMoney != base.StartMoney ||
		norm.CoreLevels[4].Price != base.CoreLevels[4].Price {
		t.Errorf("normal != default: %+v", norm)
	}
}

func TestParseDifficulty(t *testing.T) {
	if ParseDifficulty("hardcore") != DiffHardcore || ParseDifficulty("easy") != DiffEasy {
		t.Error("известные уровни должны парситься")
	}
	if ParseDifficulty("") != DiffNormal || ParseDifficulty("мусор") != DiffNormal {
		t.Error("пустое/мусор → normal")
	}
}

// ApplyDifficulty не мутирует слайсы исходного конфига (общий Handler.Config).
func TestApplyDifficultyCopiesSlices(t *testing.T) {
	base := DefaultConfig()
	before := base.RouterTiers[0].Price
	_ = ApplyDifficulty(base, DiffHardcore)
	if base.RouterTiers[0].Price != before {
		t.Errorf("ApplyDifficulty мутировал базовый конфиг: %d", base.RouterTiers[0].Price)
	}
}
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && go test ./internal/game/ -run 'Difficulty|StartMoneyCoversHire|NormalEqualsDefault' -v`
Expected: FAIL — `undefined: ConfigForDifficulty` (ошибка компиляции).

- [ ] **Step 3: Реализация.** В `config.go` в struct Config добавить (после поля `ThirstAfterHours`):

```go
	Difficulty Difficulty // уровень сложности этой игры
	WinTarget  int        // цель победы: достигнутый баланс $
```

В `DefaultConfig()` добавить в литерал: `Difficulty: DiffNormal, WinTarget: 120000,`.

Создать `server/internal/game/difficulty.go`:

```go
package game

import "math"

// Difficulty — уровень сложности; значения совпадают с query-параметром
// difficulty WS-подключения и полем difficulty протокола.
type Difficulty string

const (
	DiffEasy     = Difficulty("easy")
	DiffNormal   = Difficulty("normal")
	DiffHard     = Difficulty("hard")
	DiffHardcore = Difficulty("hardcore")
)

// ParseDifficulty — уровень из строки; неизвестное или пустое → normal.
func ParseDifficulty(s string) Difficulty {
	switch d := Difficulty(s); d {
	case DiffEasy, DiffNormal, DiffHard, DiffHardcore:
		return d
	default:
		return DiffNormal
	}
}

// difficultySpec — коэффициенты уровня к базовому балансу.
// Числа — спека итерации 8; источник истины — docs/design/gdd.md.
type difficultySpec struct {
	PriceK     float64 // все цены покупок
	WageK      float64 // зарплаты и опекс
	StartK     float64 // стартовые деньги
	IncomeK    float64 // выработка сотрудника
	CoffeePct  int     // шанс баффа кофе (абсолютный, %)
	DebuffMult float64 // множитель жажды и голода (абсолютный)
	WinTarget  int     // цель победы, $
}

var difficulties = map[Difficulty]difficultySpec{
	DiffEasy:     {PriceK: 0.8, WageK: 0.8, StartK: 1.5, IncomeK: 1.15, CoffeePct: 50, DebuffMult: 0.95, WinTarget: 60000},
	DiffNormal:   {PriceK: 1, WageK: 1, StartK: 1, IncomeK: 1, CoffeePct: 40, DebuffMult: 0.9, WinTarget: 120000},
	DiffHard:     {PriceK: 1.25, WageK: 1.25, StartK: 0.9, IncomeK: 0.9, CoffeePct: 30, DebuffMult: 0.88, WinTarget: 250000},
	DiffHardcore: {PriceK: 1.5, WageK: 1.5, StartK: 0.8, IncomeK: 0.8, CoffeePct: 20, DebuffMult: 0.85, WinTarget: 500000},
}

// scale — денежное значение × коэффициент: округление до целого $, минимум 1.
func scale(v int, k float64) int {
	return max(1, int(math.Round(float64(v)*k)))
}

// ConfigForDifficulty — баланс уровня поверх дефолтного.
func ConfigForDifficulty(d Difficulty) Config {
	return ApplyDifficulty(DefaultConfig(), d)
}

// ApplyDifficulty — коэффициенты уровня поверх базового конфига.
// Слайсы копируются: базовый конфиг общий для всех подключений.
func ApplyDifficulty(c Config, d Difficulty) Config {
	s := difficulties[d]
	c.Difficulty, c.WinTarget = d, s.WinTarget
	c.StartMoney = scale(c.StartMoney, s.StartK)
	c.PCPrice = scale(c.PCPrice, s.PriceK)
	c.HirePrice = scale(c.HirePrice, s.PriceK)
	c.BossPrice = scale(c.BossPrice, s.PriceK)
	c.GatewayPrice = scale(c.GatewayPrice, s.PriceK)
	c.CoolerPrice = scale(c.CoolerPrice, s.PriceK)
	c.FridgePrice = scale(c.FridgePrice, s.PriceK)
	c.CoffeeMachinePrice = scale(c.CoffeeMachinePrice, s.PriceK)
	c.RouterTiers = append([]RouterTier(nil), c.RouterTiers...)
	for i := range c.RouterTiers {
		c.RouterTiers[i].Price = scale(c.RouterTiers[i].Price, s.PriceK)
	}
	c.ServerLevels = append([]ServerLevel(nil), c.ServerLevels...)
	for i := range c.ServerLevels {
		c.ServerLevels[i].Price = scale(c.ServerLevels[i].Price, s.PriceK)
	}
	c.CoreLevels = append([]CoreLevel(nil), c.CoreLevels...)
	for i := range c.CoreLevels {
		c.CoreLevels[i].Price = scale(c.CoreLevels[i].Price, s.PriceK)
	}
	c.OfficePrices = append([]int(nil), c.OfficePrices...)
	for i := range c.OfficePrices {
		c.OfficePrices[i] = scale(c.OfficePrices[i], s.PriceK)
	}
	c.SalaryPerDay = scale(c.SalaryPerDay, s.WageK)
	c.BossSalaryPerDay = scale(c.BossSalaryPerDay, s.WageK)
	c.GatewayOpexPerDay = scale(c.GatewayOpexPerDay, s.WageK)
	c.IncomeMin = scale(c.IncomeMin, s.IncomeK)
	c.IncomeMax = scale(c.IncomeMax, s.IncomeK)
	c.CoffeeChancePct = s.CoffeePct
	c.ThirstMult, c.HungerMult = s.DebuffMult, s.DebuffMult
	return c
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./internal/game/`
Expected: `ok itdirector/internal/game` (в т.ч. все старые тесты — DefaultConfig не изменил чисел).

- [ ] **Step 5: Commit**

```bash
git add server/internal/game/difficulty.go server/internal/game/difficulty_test.go server/internal/game/config.go
git commit -m "feat(game): уровни сложности — коэффициенты поверх базового баланса"
```

---

### Task 2: Фаза won — победа по целевому балансу

**Files:**
- Modify: `server/internal/game/game.go` (константа фазы + проверка в Tick)
- Create: `server/internal/game/victory_test.go`

**Interfaces:**
- Consumes: `Config.WinTarget` (Task 1).
- Produces: `PhaseWon = Phase("won")`; `Tick()` переводит фазу в won, как только `Money >= WinTarget` (сразу после начисления дохода тика, до конца дня и списания ФОТ — победа днём засчитывается немедленно).

- [ ] **Step 1: Падающий тест** `server/internal/game/victory_test.go`:

```go
package game

import "testing"

// tickCfg — быстрый конфиг: победа достижима за несколько тиков.
func victoryCfg(target int) Config {
	c := DefaultConfig()
	c.WinTarget = target
	return c
}

func TestVictoryOnReachingTarget(t *testing.T) {
	g := NewWithSeed(victoryCfg(700), 1, 2) // старт $600, цель $700
	if err := g.Hire(0); err != nil {       // −$300: баланс $300, доход пошёл
		t.Fatal(err)
	}
	for i := 0; i < 100 && g.Phase == PhaseRunning; i++ {
		g.Tick()
	}
	if g.Phase != PhaseWon {
		t.Fatalf("ждали won, фаза %s (баланс %d)", g.Phase, g.Money)
	}
	if g.Money < 700 {
		t.Fatalf("победа при балансе %d < цели 700", g.Money)
	}
}

func TestNoVictoryBelowTarget(t *testing.T) {
	g := NewWithSeed(victoryCfg(1_000_000), 1, 2)
	g.Tick()
	if g.Phase != PhaseRunning {
		t.Fatalf("рано: фаза %s при балансе %d", g.Phase, g.Money)
	}
}

// После победы тик — no-op, а команды покупок отвергаются wrong_phase.
func TestWonPhaseFreezesGame(t *testing.T) {
	g := NewWithSeed(victoryCfg(500), 1, 2) // старт $600 ≥ цели: победа первым тиком
	g.Tick()
	if g.Phase != PhaseWon {
		t.Fatalf("ждали won, фаза %s", g.Phase)
	}
	money, day := g.Money, g.Day
	if r := g.Tick(); r != nil || g.Money != money || g.Day != day {
		t.Error("тик после победы должен быть no-op")
	}
	if err := g.Apply(CmdBuyPC, 0, 0); err != ErrWrongPhase {
		t.Errorf("покупка после победы: ждали wrong_phase, got %v", err)
	}
}
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd server && go test ./internal/game/ -run Victory -v`
Expected: FAIL — `undefined: PhaseWon`.

- [ ] **Step 3: Реализация.** В `game.go` в блок констант фаз добавить:

```go
	PhaseWon = Phase("won") // цель достигнута, игра заморожена
```

В `Tick()` сразу после трёх строк начисления (`g.Money += income; g.DayIncome += income; g.PeakIncomePerTick = ...`), ДО `g.TickInDay++`:

```go
	// Победа проверяется до конца дня: достиг цели днём — победа сразу,
	// вечерний ФОТ уже не списывается.
	if g.cfg.WinTarget > 0 && g.Money >= g.cfg.WinTarget {
		g.Phase = PhaseWon
		return nil
	}
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./internal/game/`
Expected: ok. ВНИМАНИЕ: если старые тесты (day_test, game_test) упали из-за WinTarget=120000 в DefaultConfig — значит какой-то тест доводит баланс до $120k; поправить его конфиг через `c.WinTarget = 0` НЕЛЬЗЯ выдумывать заранее — сначала посмотреть, падает ли вообще (не должен: тесты коротких сценариев).

- [ ] **Step 5: Commit**

```bash
git add server/internal/game/game.go server/internal/game/victory_test.go
git commit -m "feat(game): фаза won — победа по достижению целевого баланса"
```

---

### Task 3: WS — сложность из query, поля state, сообщение victory

**Files:**
- Modify: `server/internal/ws/session.go` (query → конфиг, run(cfg), отправка victory)
- Modify: `server/internal/ws/protocol.go` (stateMessage + victoryMessage + snapshot)
- Modify: `server/internal/ws/session_test.go` (тест victory и difficulty; в testMessage добавить поля)

**Interfaces:**
- Consumes: `game.ParseDifficulty`, `game.ApplyDifficulty` (Task 1), `game.PhaseWon` (Task 2).
- Produces: снапшот с полями `difficulty string`, `winTarget int`; сообщение `{"type":"victory","difficulty":…,"day":N,"balance":N}`; подключение `GET /ws?difficulty=<id>`.

- [ ] **Step 1: Падающий тест.** В `session_test.go` в struct `testMessage` добавить поля:

```go
	Difficulty string `json:"difficulty"`
	WinTarget  int    `json:"winTarget"`
	Prices     struct {
		PC int `json:"pc"`
	} `json:"prices"`
```

Добавить хелпер подключения с query (рядом с dialTestServer):

```go
func dialTestServerQuery(t *testing.T, cfg game.Config, tick time.Duration, query string) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := httptest.NewServer(&Handler{Config: cfg, TickInterval: tick})
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+query, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, ctx
}
```

и тесты:

```go
func TestDifficultyFromQuery(t *testing.T) {
	c, ctx := dialTestServerQuery(t, game.DefaultConfig(), time.Hour, "?difficulty=hardcore")
	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Difficulty != "hardcore" || msg.Money != 480 || msg.Prices.PC != 750 || msg.WinTarget != 500000 {
		t.Fatalf("хардкор-снапшот: %+v", msg)
	}
}

func TestDifficultyGarbageIsNormal(t *testing.T) {
	c, ctx := dialTestServerQuery(t, game.DefaultConfig(), time.Hour, "?difficulty=xxx")
	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatal(err)
	}
	if msg.Difficulty != "normal" || msg.Money != 600 {
		t.Fatalf("мусорная сложность должна дать норму: %+v", msg)
	}
}

func TestVictoryMessage(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 500 // старт $600 ≥ цели: победа первым же тиком
	c, ctx := dialTestServer(t, cfg, 10*time.Millisecond)
	won := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "victory" })
	if won.Day != 1 || won.Balance < 500 || won.Difficulty != "normal" {
		t.Fatalf("victory: %+v", won)
	}
	// После победы соединение живо, покупки отвергаются wrong_phase.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "buy_pc"}); err != nil {
		t.Fatal(err)
	}
	errMsg := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if errMsg.Code != "wrong_phase" {
		t.Fatalf("покупка после победы: %+v", errMsg)
	}
}
```

- [ ] **Step 2: Убедиться, что падает**

Run: `cd server && go test ./internal/ws/ -run 'Difficulty|Victory' -v`
Expected: FAIL — в снапшоте нет поля difficulty (`msg.Difficulty == ""`), victory не приходит.

- [ ] **Step 3: Реализация.** В `protocol.go`:

в `stateMessage` после поля `Speed`:

```go
	Difficulty string `json:"difficulty"` // easy | normal | hard | hardcore
	WinTarget  int    `json:"winTarget"`  // цель победы, $
```

после `gameOverMessage`:

```go
// victoryMessage — итоги победы; шлётся сразу после снапшота с phase=won.
type victoryMessage struct {
	Type       string `json:"type"` // всегда "victory"
	Difficulty string `json:"difficulty"`
	Day        int    `json:"day"`
	Balance    int    `json:"balance"`
}
```

в `snapshot()` в возвращаемый литерал добавить: `Difficulty: string(cfg.Difficulty), WinTarget: cfg.WinTarget,`.

В `session.go` — ServeHTTP передаёт конфиг уровня в run:

```go
	cfg := game.ApplyDifficulty(h.Config, game.ParseDifficulty(r.URL.Query().Get("difficulty")))
	...
	h.run(ctx, c, commands, cfg)
```

сигнатура актора: `func (h *Handler) run(ctx context.Context, c *websocket.Conn, commands <-chan clientCommand, cfg game.Config)`, внутри `g := game.New(cfg)` (вместо `h.Config`).

ВАЖНО: `ApplyDifficulty(h.Config, DiffNormal)` теперь применяется и к тестовым конфигам — коэффициенты нормы 1.0 чисел не меняют, но `WinTarget` перепишется на 120000 из spec. Чтобы кастомный `cfg.WinTarget` тестов (TestVictoryMessage) выживал, в ServeHTTP применять сложность ТОЛЬКО при непустом параметре:

```go
	cfg := h.Config
	if q := r.URL.Query().Get("difficulty"); q != "" {
		cfg = game.ApplyDifficulty(h.Config, game.ParseDifficulty(q))
	}
```

Тик-ветка `run` — вставить обработку победы (фаза меняется ровно один раз):

```go
		case <-tickC:
			wasRunning := g.Phase == game.PhaseRunning
			report := g.Tick()
			if wasRunning && g.Phase == game.PhaseWon {
				if wsjson.Write(ctx, c, snapshot(g, speed)) != nil {
					return
				}
				if wsjson.Write(ctx, c, victoryMessage{Type: "victory",
					Difficulty: string(g.Config().Difficulty), Day: g.Day, Balance: g.Money}) != nil {
					return
				}
				continue
			}
			// дальше существующий код: if report == nil && g.Phase != game.PhaseRunning { continue } …
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./...` (из server/)
Expected: ok все пакеты, включая старые тесты ws (подключение без query → конфиг Handler как раньше).

- [ ] **Step 5: Commit**

```bash
git add server/internal/ws/session.go server/internal/ws/protocol.go server/internal/ws/session_test.go
git commit -m "feat(ws): сложность из query-параметра, поля difficulty/winTarget, сообщение victory"
```

---

### Task 4: Клиент — зеркало протокола и GameClient

**Files:**
- Modify: `client/src/protocol.ts`
- Modify: `client/src/net.ts`

**Interfaces:**
- Consumes: серверный протокол Task 3.
- Produces: `type DifficultyId = 'easy' | 'normal' | 'hard' | 'hardcore'`; `StateMessage.difficulty/winTarget`; `VictoryMessage`; `client.connect(difficulty: DifficultyId)`; `client.disconnect()`; `Listener.onVictory?`.

- [ ] **Step 1: protocol.ts.** Добавить после `EffectInfo`:

```ts
export type DifficultyId = 'easy' | 'normal' | 'hard' | 'hardcore'
```

В `StateMessage`: `phase: 'running' | 'day_report' | 'game_over' | 'won'` (заменить union) и после `speed`:

```ts
  difficulty: DifficultyId
  winTarget: number // цель победы, $
```

После `GameOverMessage`:

```ts
export interface VictoryMessage {
  type: 'victory'
  difficulty: DifficultyId
  day: number
  balance: number
}
```

`ServerMessage` дополнить: `| VictoryMessage`.

- [ ] **Step 2: net.ts.** Импорт: добавить `DifficultyId`, `VictoryMessage` в type-импорт. В `Listener`:

```ts
  onVictory?(v: VictoryMessage): void
```

`connect` принимает сложность, соединение можно закрывать намеренно (возврат в меню — не «потеря соединения»):

```ts
  private intentionalClose = false

  connect(difficulty: DifficultyId): void {
    this.latest = null
    this.intentionalClose = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/ws?difficulty=${difficulty}`)
    ...
  }

  // Намеренный разрыв (возврат в меню): onDisconnect не дёргаем.
  disconnect(): void {
    this.intentionalClose = true
    this.ws.close()
    this.latest = null
  }
```

в `fireDisconnect` первой строкой: `if (this.intentionalClose) return`. В onmessage добавить ветку перед финальным else:

```ts
      } else if (msg.type === 'victory') {
        this.listeners.forEach((l) => l.onVictory?.(msg))
```

- [ ] **Step 3: Проверка типов**

Run: `make typecheck`
Expected: FAIL в `main.ts` — `client.connect()` теперь требует аргумент. Это ожидаемо: флоу чинит Task 5. Если других ошибок нет — порядок.

- [ ] **Step 4: Commit**

```bash
git add client/src/protocol.ts client/src/net.ts
git commit -m "feat(client): зеркало протокола — difficulty, winTarget, victory, connect(difficulty)"
```

---

### Task 5: MenuScene и флоу запуска

**Files:**
- Create: `client/src/scenes/MenuScene.ts`
- Modify: `client/src/main.ts`
- Modify: `client/src/scenes/BootScene.ts`

**Interfaces:**
- Consumes: `client.connect(difficulty)` (Task 4).
- Produces: сцена с ключом `'menu'`; игровые сцены стартуют ТОЛЬКО из меню; HUD может вернуться в меню через `this.scene.start('menu')` (Task 6).

- [ ] **Step 1: MenuScene.** Создать `client/src/scenes/MenuScene.ts`:

```ts
import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'
import { client } from '../net'
import type { DifficultyId } from '../protocol'

const CX = GAME_W / 2

// Описания уровней — цифры из спеки итерации 8 (сервер — источник истины,
// тут только витрина для выбора).
const LEVELS: { id: DifficultyId; label: string; desc: string; goal: string; color: number }[] = [
  { id: 'easy', label: 'ЛЕГКО', desc: 'цены и зарплаты −20% · старт $900 · выработка +15%', goal: 'Цель: $60,000', color: 0x38b764 },
  { id: 'normal', label: 'НОРМА', desc: 'базовый баланс', goal: 'Цель: $120,000', color: 0x41a6f6 },
  { id: 'hard', label: 'СЛОЖНО', desc: 'цены и зарплаты +25% · старт $540 · выработка −10%', goal: 'Цель: $250,000', color: 0xffcd75 },
  { id: 'hardcore', label: 'ХАРДКОР', desc: 'цены и зарплаты +50% · старт $480 · выработка −20%', goal: 'Цель: $500,000', color: 0xb13e53 },
]

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('menu')
  }

  create() {
    this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c).setOrigin(0)
    this.add
      .text(CX, 90, 'IT DIRECTOR', { fontFamily: 'monospace', fontSize: '42px', color: '#ffcd75' })
      .setOrigin(0.5)
    this.add
      .text(CX, 140, 'Выберите сложность', { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4' })
      .setOrigin(0.5)

    LEVELS.forEach((lvl, i) => {
      const y = 200 + i * 96
      const bg = this.add.rectangle(CX - 260, y, 520, 80, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true })
      this.add.text(CX - 240, y + 14, lvl.label, {
        fontFamily: 'monospace', fontSize: '20px',
        color: '#' + lvl.color.toString(16).padStart(6, '0'),
      })
      this.add.text(CX - 240, y + 44, lvl.desc, { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
      this.add.text(CX + 240, y + 14, lvl.goal, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' }).setOrigin(1, 0)
      bg.on('pointerover', () => bg.setStrokeStyle(2, lvl.color))
      bg.on('pointerout', () => bg.setStrokeStyle(2, 0x3a3f5c))
      bg.on('pointerdown', () => this.startGame(lvl.id))
    })
  }

  private startGame(d: DifficultyId) {
    client.connect(d)
    this.scene.start('office') // start глушит menu
    this.scene.launch('hud')
  }
}
```

- [ ] **Step 2: Флоу.** `BootScene.ts` — после регистрации текстур уходить в меню (заменить две строки start/launch):

```ts
    registerTextures(this)
    this.scene.start('menu')
```

`main.ts` — убрать строку `client.connect()` (и неиспользуемый импорт `client`), добавить импорт и сцену:

```ts
import { MenuScene } from './scenes/MenuScene'
...
  scene: [BootScene, MenuScene, OfficeScene, ServerRoomScene, HUDScene],
```

- [ ] **Step 3: Проверка**

Run: `make typecheck`
Expected: PASS (ошибка `connect()` из Task 4 ушла).

Run: `make dev` (фоном, вручную) и открыть http://localhost:5173 — меню с 4 уровнями; клик по «ХАРДКОР» → офис, баланс $480. Быстрая ручная проверка, не автотест.

- [ ] **Step 4: Commit**

```bash
git add client/src/scenes/MenuScene.ts client/src/scenes/BootScene.ts client/src/main.ts
git commit -m "feat(client): стартовый экран выбора сложности"
```

---

### Task 6: HUD — цель, экран победы, «В меню»

**Files:**
- Modify: `client/src/scenes/HUDScene.ts`

**Interfaces:**
- Consumes: `Listener.onVictory`, `client.disconnect()` (Task 4), сцена `'menu'` (Task 5), `StateMessage.winTarget`.
- Produces: строка цели в HUD; оверлей победы; кнопки «В меню» на победе и банкротстве.

- [ ] **Step 1: Строка цели.** Поле класса (рядом с dayText): `private goalText!: Phaser.GameObjects.Text`. В `create()` после создания dayText:

```ts
    this.goalText = this.add
      .text(GAME_W - 16, 52, '', { fontFamily: 'monospace', fontSize: '13px', color: '#ffcd75' })
      .setOrigin(1, 0)
```

В `refresh()` рядом с dayText.setText: `this.goalText.setText(`Цель: ${fmtMoney(s.winTarget)}`)`.

- [ ] **Step 2: Победа.** Импорт типа: добавить `VictoryMessage` в type-импорт из '../protocol'. Поле `private victoryUI: Phaser.GameObjects.GameObject[] = []`. В подписке `client.subscribe({...})` добавить `onVictory: (v) => this.showVictory(v),`. Методы (рядом с showGameOver):

```ts
  private static DIFF_LABELS: Record<string, string> = {
    easy: 'Легко', normal: 'Норма', hard: 'Сложно', hardcore: 'Хардкор',
  }

  private showVictory(v: VictoryMessage) {
    this.closeReport()
    this.closeVictory()
    const overlay = this.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive()
    const title = this.add
      .text(CX, 220, 'ПОБЕДА!', { fontFamily: 'monospace', fontSize: '32px', color: '#38b764' })
      .setOrigin(0.5).setDepth(61)
    const body = this.add
      .text(CX, 300, [
        `Сложность: ${HUDScene.DIFF_LABELS[v.difficulty] ?? v.difficulty}`,
        `Дней прошло: ${v.day}`,
        `Баланс: ${fmtMoney(v.balance)}`,
      ].join('\n'), { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = this.add
      .rectangle(CX - 100, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
      .setInteractive({ useHandCursor: true })
    const btnText = this.add
      .text(CX, 397, 'В меню', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(62)
    btnBg.on('pointerdown', () => this.returnToMenu())
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.victoryUI = [overlay, title, body, btnBg, btnText]
    this.victoryUI.push(...drawDebugFrames(this, this.victoryUI))
  }

  private closeVictory() {
    this.victoryUI.forEach((o) => o.destroy())
    this.victoryUI = []
  }

  // Возврат в меню: намеренный разрыв WS (новая игра = новое подключение).
  private returnToMenu() {
    client.disconnect()
    this.scene.stop('office')
    this.scene.stop('serverRoom')
    this.scene.start('menu') // start глушит hud
  }
```

- [ ] **Step 3: Банкротство → меню.** В `showGameOver` заменить текст кнопки и обработчик:

```ts
      .text(CX, 397, 'В меню', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
```

и `btnBg.on('pointerdown', () => this.returnToMenu())` (вместо `client.send('restart')`).

- [ ] **Step 4: Проверка**

Run: `make typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/scenes/HUDScene.ts
git commit -m "feat(client): цель в HUD, экран победы, возврат в меню с банкротства"
```

---

### Task 7: live-check, документация, смоук

**Files:**
- Modify: `scripts/live-check.mjs` (поля difficulty/winTarget + прогон с query)
- Modify: `README.md` (абзац про сложность и победу)
- Modify: `docs/design/gdd.md` (раздел «Сложность и победа» с таблицами из спеки)

**Interfaces:**
- Consumes: всё выше.

- [ ] **Step 1: live-check.** В массив `FIELDS` добавить `'difficulty', 'winTarget'`. Подключение сделать с уровнем: `const ws = new WebSocket('ws://localhost:8091/ws?difficulty=hardcore')`. В первую ветку (`phase === 'start'`) после проверки полей добавить:

```js
    if (m.difficulty !== 'hardcore' || m.money !== 480 || m.prices.pc !== 750 || m.winTarget !== 500000) {
      fail('хардкор из query', { difficulty: m.difficulty, money: m.money, pc: m.prices.pc, winTarget: m.winTarget })
    }
    ok('хардкор: старт $480, ПК $750, цель $500,000')
```

ВНИМАНИЕ: дальше по сценарию скрипт проверяет числа нормы — перевести их на хардкор (×1.5 к ценам, ×1.5 к зарплатам, ×0.8 к выработке): офисы `15000/40000 → 22500/60000`, core L1 `1500 → 2250`, диапазон найма `9..14 → 7..11`, ожидание кулера `money >= 400 → >= 600` (кулер $600), payroll отчёта дня 1 c одним сотрудником `250 → 375`.

- [ ] **Step 2: Живой прогон**

Run: `cd server && go run ./cmd/server -addr :8091 &` затем `node scripts/live-check.mjs`; убить сервер после.
Expected: `ПРОТОКОЛ ОК`, exit 0.

- [ ] **Step 3: Документация.** README — после абзаца про итерацию 6 добавить абзац: «С итерации 8 игра начинается со стартового экрана выбора сложности (Легко/Норма/Сложно/Хардкор): уровень скалирует цены, зарплаты, стартовый капитал, выработку и шансы баффов (коэффициенты — docs/design/gdd.md), а победа — накопить целевой баланс уровня ($60k/$120k/$250k/$500k); банкротство и победа возвращают в меню». В `docs/design/gdd.md` добавить раздел «Сложность и победа» с двумя таблицами из спеки (коэффициенты + цели) — скопировать из `docs/superpowers/specs/2026-07-20-iteration-8-difficulty-design.md`.

- [ ] **Step 4: Полный прогон**

Run: `make test && make typecheck`
Expected: всё зелёное.

- [ ] **Step 5: Commit**

```bash
git add scripts/live-check.mjs README.md docs/design/gdd.md
git commit -m "docs+check: сложность в live-check, README и GDD"
```

---

### После всех тасков

Браузерный смоук (playwright): открыть http://localhost:5173 → меню видно, 4 уровня; выбрать Хардкор → HUD показывает $480 и «Цель: $500,000», цены в кнопках ×1.5; вернуться (перезагрузка) → выбрать Легко → $900, «Цель: $60,000». Затем финальное ревью и плейтест пользователя — гейт мержа `iteration-8` → main.
