# Итерация 2: зарплаты + цикл дня — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сломать доминацию жадного найма: зарплаты списываются в конце игрового дня, банкротство = game over; плюс отчёт дня, ребаланс через ФОТ, техдолг итерации 1 и CC0-графика.

**Architecture:** Домен `internal/game` получает машину состояний (`running → day_report → running | game_over`) и счётчики дня; сессия-актор `internal/ws` транслирует события дня в новые сообщения протокола (`day_report`, `game_over`); клиент добавляет модалку отчёта, экран банкротства и ФОТ в HUD. Спека: `docs/superpowers/specs/2026-07-12-iteration-2-design.md`.

**Tech Stack:** Go (coder/websocket, стандартный testing), TypeScript + Phaser 3 + Vite.

## Global Constraints

- Работа ведётся в ветке `iteration-2` от `main` (создать перед Task 1: `git checkout -b iteration-2`).
- Комментарии в коде — по-русски, в стиле существующих файлов; сообщения коммитов — conventional commits по-русски (`feat: …`, `fix: …`, `test: …`, `docs: …`).
- Числа баланса живут ТОЛЬКО в `server/internal/game/config.go` (`DefaultConfig`); источник истины — `docs/design/gdd.md`, раздел «Экономика»: день = 60 тиков, зарплата = $250/день/сотрудник.
- Протокол зеркалится: `server/internal/ws/protocol.go` ↔ `client/src/protocol.ts` — менять синхронно, имена JSON-полей camelCase.
- Домен `internal/game` НЕ потокобезопасен by design — им владеет актор сессии; мьютексы не добавлять.
- Серверные тесты гонять как `go test ./...` из `server/`; перед коммитом задач 3 и 4 дополнительно `go test -race ./...`. Клиент: `npm run typecheck` из `client/`.
- Деньги на клиенте — только через `fmtMoney` из `client/src/format.ts` (появляется в Task 5).

---

### Task 1: Домен — фазы, день, ФОТ, банкротство

**Files:**
- Modify: `server/internal/game/config.go`
- Modify: `server/internal/game/game.go`
- Test: `server/internal/game/day_test.go` (новый файл)

**Interfaces:**
- Consumes: существующие `Game`, `Config`, `IncomePerTick()`.
- Produces: `Config.DayTicks int`, `Config.SalaryPerDay int`; `type Phase string` с константами `PhaseRunning`/`PhaseDayReport`/`PhaseGameOver` (значения `"running"`/`"day_report"`/`"game_over"`); поля `Game.Phase Phase`, `Game.Day int` (с 1), `Game.TickInDay int`, `Game.DayIncome int`, `Game.PeakIncomePerTick int`; `(*Game).PayrollPerDay() int`; `type DayReport struct { Day, Income, Payroll, Profit, Balance int }`; `(*Game).Tick() *DayReport` (nil — день продолжается).

- [ ] **Step 1: Написать падающие тесты**

Создать `server/internal/game/day_test.go`:

```go
package game

import "testing"

// dayTestConfig — короткий день, чтобы тесты не гоняли 60 тиков.
func dayTestConfig() Config {
	cfg := DefaultConfig()
	cfg.DayTicks = 3
	cfg.SalaryPerDay = 250
	return cfg
}

func TestNewGameDayFields(t *testing.T) {
	g := New(DefaultConfig())
	if g.Phase != PhaseRunning || g.Day != 1 || g.TickInDay != 0 {
		t.Errorf("старт дня неверен: Phase=%q Day=%d TickInDay=%d", g.Phase, g.Day, g.TickInDay)
	}
}

func TestDefaultConfigDay(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.DayTicks != 60 || cfg.SalaryPerDay != 250 {
		t.Errorf("DayTicks=%d SalaryPerDay=%d, хотим 60 и 250 (GDD, «Экономика»)", cfg.DayTicks, cfg.SalaryPerDay)
	}
}

func TestPayrollPerDay(t *testing.T) {
	g := New(DefaultConfig())
	if p := g.PayrollPerDay(); p != 0 {
		t.Errorf("без сотрудников ФОТ = %d, хотим 0", p)
	}
	g.Employees = 3
	if p := g.PayrollPerDay(); p != 750 {
		t.Errorf("ФОТ = %d, хотим 750", p)
	}
}

func TestDayEndsWithReport(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 1000
	g.Employees = 1 // $10/тик без сети
	var rep *DayReport
	for i := 0; i < 3; i++ {
		if rep != nil {
			t.Fatalf("день закончился раньше времени, тик %d", i)
		}
		rep = g.Tick()
	}
	if rep == nil {
		t.Fatal("после последнего тика дня ждём отчёт")
	}
	// доход 3×10=30, ФОТ 250: 1000+30-250 = 780
	want := DayReport{Day: 1, Income: 30, Payroll: 250, Profit: -220, Balance: 780}
	if *rep != want {
		t.Errorf("отчёт = %+v, хотим %+v", *rep, want)
	}
	if g.Phase != PhaseDayReport || g.Money != 780 {
		t.Errorf("после дня: Phase=%q Money=%d, хотим day_report и 780", g.Phase, g.Money)
	}
}

func TestDayEndBankruptcy(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 0
	g.Employees = 1 // доход за день 30 < ФОТ 250
	for i := 0; i < 3; i++ {
		g.Tick()
	}
	if g.Phase != PhaseGameOver {
		t.Fatalf("Phase = %q, хотим game_over", g.Phase)
	}
	if g.Money != -220 {
		t.Errorf("Money = %d, хотим -220 (сколько не хватило)", g.Money)
	}
}

func TestDayEndExactZeroSurvives(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 220 // 220 + 30 дохода − 250 ФОТ = ровно 0
	g.Employees = 1
	for i := 0; i < 3; i++ {
		g.Tick()
	}
	if g.Phase != PhaseDayReport || g.Money != 0 {
		t.Errorf("баланс ровно 0 выживает: Phase=%q Money=%d", g.Phase, g.Money)
	}
}

func TestTickNoopOutsideRunning(t *testing.T) {
	g := New(dayTestConfig())
	g.Phase = PhaseDayReport
	g.Money = 100
	g.Employees = 1
	if rep := g.Tick(); rep != nil || g.Money != 100 || g.TickInDay != 0 {
		t.Errorf("тик вне running должен быть no-op: rep=%v Money=%d TickInDay=%d", rep, g.Money, g.TickInDay)
	}
}

func TestPeakIncomeTracked(t *testing.T) {
	g := New(dayTestConfig())
	g.PCs = 2
	g.Employees = 2
	g.Tick() // доход 20
	g.Employees = 1
	g.Tick() // доход 10 — пик не сбрасывается
	if g.PeakIncomePerTick != 20 {
		t.Errorf("PeakIncomePerTick = %d, хотим 20", g.PeakIncomePerTick)
	}
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — compile errors (`undefined: PhaseRunning`, `DayTicks` и т.д.)

- [ ] **Step 3: Реализация**

`server/internal/game/config.go` — добавить в `Config` после `BaseIncomePerTick`:

```go
	DayTicks     int // тиков в одном игровом дне
	SalaryPerDay int // зарплата $ с одного сотрудника, списывается в конце дня
```

и в `DefaultConfig()` после `BaseIncomePerTick: 10,`:

```go
		DayTicks:     60,
		SalaryPerDay: 250,
```

`server/internal/game/game.go` — заменить объявление `Game` и `New`, добавить типы и методы:

```go
// Phase — фаза игры; значения совпадают с полем phase протокола.
type Phase string

const (
	PhaseRunning   = Phase("running")
	PhaseDayReport = Phase("day_report") // день кончился, ждём next_day
	PhaseGameOver  = Phase("game_over")  // банкротство, ждём restart
)

// Game — состояние одной игры. НЕ потокобезопасен: им владеет
// ровно одна горутина (актор сессии в пакете ws).
type Game struct {
	cfg Config

	Money      int
	PCs        int // ПК в офисе; первые Employees из них заняты сотрудниками
	Employees  int
	RouterTier int // 0 — роутера нет; 1..len(cfg.RouterTiers)
	Servers    int

	Phase             Phase
	Day               int // номер игрового дня, с 1
	TickInDay         int // тиков прошло в текущем дне
	DayIncome         int // доход, накопленный за текущий день (для отчёта)
	PeakIncomePerTick int // максимум дохода за тик за игру (для итогов банкротства)
}

func New(cfg Config) *Game {
	return &Game{cfg: cfg, Money: cfg.StartMoney, PCs: cfg.StartPCs, Phase: PhaseRunning, Day: 1}
}

// PayrollPerDay — дневной фонд оплаты труда при текущем штате.
func (g *Game) PayrollPerDay() int { return g.Employees * g.cfg.SalaryPerDay }

// DayReport — итоги дня для сообщения протокола.
type DayReport struct {
	Day     int
	Income  int
	Payroll int
	Profit  int
	Balance int
}
```

Заменить `Tick`:

```go
// Tick — один шаг симуляции (1 секунда). Вне фазы running — no-op.
// Если этот тик закончил день, списывает ФОТ, переводит фазу
// (day_report, при балансе < 0 — game_over) и возвращает отчёт.
func (g *Game) Tick() *DayReport {
	if g.Phase != PhaseRunning {
		return nil
	}
	income := g.IncomePerTick()
	g.Money += income
	g.DayIncome += income
	g.PeakIncomePerTick = max(g.PeakIncomePerTick, income)
	g.TickInDay++
	if g.TickInDay < g.cfg.DayTicks {
		return nil
	}
	payroll := g.PayrollPerDay()
	g.Money -= payroll
	if g.Money < 0 {
		g.Phase = PhaseGameOver
	} else {
		g.Phase = PhaseDayReport
	}
	return &DayReport{Day: g.Day, Income: g.DayIncome, Payroll: payroll, Profit: g.DayIncome - payroll, Balance: g.Money}
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./...`
Expected: PASS (в т.ч. старые тесты: `TestTickAddsIncome` игнорирует возвращаемое значение — это законно в Go; `New` теперь ставит `Phase`/`Day`, старым тестам это не мешает).

- [ ] **Step 5: Commit**

```bash
git add server/internal/game/
git commit -m "feat(game): цикл дня, ФОТ и банкротство в домене"
```

---

### Task 2: Домен — команды next_day/restart и фазовые ограничения

**Files:**
- Modify: `server/internal/game/commands.go`
- Test: `server/internal/game/day_test.go`

**Interfaces:**
- Consumes: `Phase`, `PhaseRunning/PhaseDayReport/PhaseGameOver`, `New`, поля дня из Task 1.
- Produces: `ErrWrongPhase = Err("wrong_phase")`; `CmdNextDay = Command("next_day")`, `CmdRestart = Command("restart")`; `(*Game).NextDay() error`, `(*Game).Restart() error`; `Apply` отклоняет команды покупки вне `running` с `ErrWrongPhase`.

- [ ] **Step 1: Написать падающие тесты**

Добавить в `server/internal/game/day_test.go`:

```go
func TestNextDay(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 1000
	g.Employees = 1
	for i := 0; i < 3; i++ {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatalf("NextDay из отчёта: %v", err)
	}
	if g.Phase != PhaseRunning || g.Day != 2 || g.TickInDay != 0 || g.DayIncome != 0 {
		t.Errorf("после NextDay: Phase=%q Day=%d TickInDay=%d DayIncome=%d", g.Phase, g.Day, g.TickInDay, g.DayIncome)
	}
}

func TestNextDayWrongPhase(t *testing.T) {
	g := New(dayTestConfig())
	if err := g.NextDay(); err != ErrWrongPhase {
		t.Errorf("NextDay из running: err = %v, хотим %v", err, ErrWrongPhase)
	}
}

func TestRestart(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 0
	g.PCs = 3
	g.Employees = 3
	for i := 0; i < 3; i++ {
		g.Tick()
	}
	if g.Phase != PhaseGameOver {
		t.Fatalf("подготовка: ждали game_over, Phase=%q", g.Phase)
	}
	if err := g.Restart(); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if g.Phase != PhaseRunning || g.Day != 1 || g.Money != 600 || g.PCs != 1 ||
		g.Employees != 0 || g.RouterTier != 0 || g.Servers != 0 ||
		g.TickInDay != 0 || g.DayIncome != 0 || g.PeakIncomePerTick != 0 {
		t.Errorf("после Restart не стартовое состояние: %+v", g)
	}
}

func TestRestartWrongPhase(t *testing.T) {
	g := New(dayTestConfig())
	if err := g.Restart(); err != ErrWrongPhase {
		t.Errorf("Restart из running: err = %v, хотим %v", err, ErrWrongPhase)
	}
}

func TestApplyPhaseGating(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 10000
	g.Phase = PhaseDayReport
	for _, cmd := range []Command{CmdBuyPC, CmdHire, CmdBuyRouter, CmdBuyServer} {
		if err := g.Apply(cmd); err != ErrWrongPhase {
			t.Errorf("Apply(%s) в day_report: err = %v, хотим %v", cmd, err, ErrWrongPhase)
		}
	}
	if err := g.Apply(CmdNextDay); err != nil {
		t.Errorf("Apply(next_day) в day_report: %v", err)
	}
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — `undefined: ErrWrongPhase`, `undefined: CmdNextDay` и т.д.

- [ ] **Step 3: Реализация**

`server/internal/game/commands.go` — добавить к константам ошибок:

```go
	ErrWrongPhase = Err("wrong_phase")
```

добавить к константам команд:

```go
	CmdNextDay = Command("next_day")
	CmdRestart = Command("restart")
```

добавить методы:

```go
// NextDay начинает следующий день. Работает только из фазы отчёта.
func (g *Game) NextDay() error {
	if g.Phase != PhaseDayReport {
		return ErrWrongPhase
	}
	g.Day++
	g.TickInDay = 0
	g.DayIncome = 0
	g.Phase = PhaseRunning
	return nil
}

// Restart начинает новую игру с нуля. Работает только после банкротства.
func (g *Game) Restart() error {
	if g.Phase != PhaseGameOver {
		return ErrWrongPhase
	}
	*g = *New(g.cfg)
	return nil
}
```

заменить `Apply`:

```go
// Apply выполняет команду игрока. Команды покупки/найма работают только
// в фазе running; next_day/restart сами проверяют свою фазу.
func (g *Game) Apply(cmd Command) error {
	switch cmd {
	case CmdNextDay:
		return g.NextDay()
	case CmdRestart:
		return g.Restart()
	}
	if g.Phase != PhaseRunning {
		return ErrWrongPhase
	}
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

(Неизвестная команда вне `running` теперь тоже даёт `wrong_phase` — это осознанно: фаза проверяется раньше.)

- [ ] **Step 4: Тесты зелёные**

Run: `cd server && go test ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/internal/game/
git commit -m "feat(game): команды next_day/restart и фазовые ограничения"
```

---

### Task 3: Протокол и сессия — day_report, game_over, новые поля снапшота

**Files:**
- Modify: `server/internal/ws/protocol.go`
- Modify: `server/internal/ws/session.go:60-89` (функция `run`)
- Test: `server/internal/ws/protocol_test.go`, `server/internal/ws/session_test.go`

**Interfaces:**
- Consumes: `game.Phase*`, `(*game.Game).Tick() *game.DayReport`, `PayrollPerDay()`, поля `Day`, `TickInDay`, `PeakIncomePerTick` из Task 1-2.
- Produces: JSON-поля снапшота `day`, `dayTicks`, `dayProgress`, `payrollPerDay`, `phase`; сообщения `{"type":"day_report", day, income, payroll, profit, balance}` и `{"type":"game_over", daysSurvived, peakIncomePerTick, balance}`. Клиент (Task 5) зеркалит эти имена.

- [ ] **Step 1: Написать падающие тесты**

В `server/internal/ws/protocol_test.go` дополнить `TestSnapshot` — после проверки производных полей добавить:

```go
	if s.Day != 1 || s.DayTicks != 60 || s.DayProgress != 0 || s.PayrollPerDay != 0 || s.Phase != "running" {
		t.Errorf("поля дня в снапшоте неверны: %+v", s)
	}
```

В `server/internal/ws/session_test.go` расширить `testMessage` и хелпер, добавить тесты:

```go
// testMessage покрывает state, error, day_report и game_over —
// удобно читать любой ответ сервера одним типом.
type testMessage struct {
	Type         string `json:"type"`
	Code         string `json:"code"`
	Money        int    `json:"money"`
	Employees    int    `json:"employees"`
	Day          int    `json:"day"`
	Phase        string `json:"phase"`
	Payroll      int    `json:"payroll"`
	Balance      int    `json:"balance"`
	DaysSurvived int    `json:"daysSurvived"`
}
```

`dialTestServer` научить принимать конфиг (и поправить два существующих вызова — они передают `game.DefaultConfig()`):

```go
func dialTestServer(t *testing.T, cfg game.Config, tick time.Duration) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := httptest.NewServer(&Handler{Config: cfg, TickInterval: tick})
	// … остальное без изменений
}
```

Добавить хелпер и тесты:

```go
// readUntil читает сообщения, пока не встретит подходящее (или упадёт по таймауту ctx).
func readUntil(t *testing.T, ctx context.Context, c *websocket.Conn, ok func(testMessage) bool) testMessage {
	t.Helper()
	for {
		var msg testMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			t.Fatalf("readUntil: %v", err)
		}
		if ok(msg) {
			return msg
		}
	}
}

func TestSessionDayCycle(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.DayTicks = 2
	c, ctx := dialTestServer(t, cfg, 5*time.Millisecond)

	// Без сотрудников ФОТ 0 — день кончается отчётом, не банкротством.
	rep := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" })
	if rep.Day != 1 || rep.Payroll != 0 || rep.Balance != 600 {
		t.Fatalf("отчёт дня 1: %+v", rep)
	}
	// Покупка в фазе отчёта отклоняется.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire"}); err != nil {
		t.Fatal(err)
	}
	errMsg := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if errMsg.Code != "wrong_phase" {
		t.Fatalf("хотим wrong_phase, получили %+v", errMsg)
	}
	// next_day запускает день 2.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "next_day"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Day == 2 && m.Phase == "running" })
}

func TestSessionBankruptcyAndRestart(t *testing.T) {
	cfg := game.DefaultConfig()
	// День подлиннее (250мс), чтобы hire гарантированно успел до конца дня.
	cfg.DayTicks = 50
	cfg.SalaryPerDay = 100000 // гарантированное банкротство с одним сотрудником
	c, ctx := dialTestServer(t, cfg, 5*time.Millisecond)

	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Employees == 1 })
	over := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "game_over" })
	if over.DaysSurvived != 1 || over.Balance >= 0 {
		t.Fatalf("итоги банкротства: %+v", over)
	}
	// restart возвращает стартовое состояние.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "restart"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && m.Money == 600 && m.Employees == 0 && m.Day == 1 && m.Phase == "running"
	})
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/ws/`
Expected: FAIL — compile errors (нет полей `Day`/`DayTicks`… в `stateMessage`, старая сигнатура `dialTestServer`).

- [ ] **Step 3: Реализация протокола**

`server/internal/ws/protocol.go` — в `stateMessage` после `IncomePerTick` добавить:

```go
	Day           int    `json:"day"`
	DayTicks      int    `json:"dayTicks"`
	DayProgress   int    `json:"dayProgress"` // тиков прошло в текущем дне
	PayrollPerDay int    `json:"payrollPerDay"`
	Phase         string `json:"phase"` // running | day_report | game_over
```

в `snapshot()` соответственно:

```go
		Day:           g.Day,
		DayTicks:      cfg.DayTicks,
		DayProgress:   g.TickInDay,
		PayrollPerDay: g.PayrollPerDay(),
		Phase:         string(g.Phase),
```

Добавить типы сообщений:

```go
// dayReportMessage — итоги дня; шлётся сразу после снапшота с phase=day_report.
type dayReportMessage struct {
	Type    string `json:"type"` // всегда "day_report"
	Day     int    `json:"day"`
	Income  int    `json:"income"`
	Payroll int    `json:"payroll"`
	Profit  int    `json:"profit"`
	Balance int    `json:"balance"`
}

// gameOverMessage — итоги банкротства; шлётся сразу после снапшота с phase=game_over.
type gameOverMessage struct {
	Type              string `json:"type"` // всегда "game_over"
	DaysSurvived      int    `json:"daysSurvived"`
	PeakIncomePerTick int    `json:"peakIncomePerTick"`
	Balance           int    `json:"balance"` // отрицательный: сколько не хватило
}
```

`server/internal/ws/session.go` — в `run` заменить ветку тикера:

```go
		case <-ticker.C:
			report := g.Tick()
			if wsjson.Write(ctx, c, snapshot(g)) != nil {
				return
			}
			if report != nil {
				var out any
				if g.Phase == game.PhaseGameOver {
					out = gameOverMessage{Type: "game_over", DaysSurvived: g.Day, PeakIncomePerTick: g.PeakIncomePerTick, Balance: g.Money}
				} else {
					out = dayReportMessage{Type: "day_report", Day: report.Day, Income: report.Income, Payroll: report.Payroll, Profit: report.Profit, Balance: report.Balance}
				}
				if wsjson.Write(ctx, c, out) != nil {
					return
				}
			}
```

- [ ] **Step 4: Тесты зелёные, race-детектор чистый**

Run: `cd server && go test -race ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/internal/ws/
git commit -m "feat(ws): день и банкротство в протоколе и сессии"
```

---

### Task 4: Серверный техдолг — GET /ws и пробелы тестов итерации 1

**Files:**
- Modify: `server/cmd/server/main.go:20`
- Test: `server/internal/game/game_test.go`

**Interfaces:**
- Consumes: существующий код; ничего нового не производит.

- [ ] **Step 1: Дописать недостающие тесты (сразу зелёные — это закрытие пробелов покрытия)**

В `server/internal/game/game_test.go`:

в таблицу `TestHire` добавить кейс:

```go
		{"нет ПК и денег одновременно: ПК проверяется первым", func(g *Game) { g.Money = 0; g.Employees = 1 }, ErrNoFreePC, 1, 0},
```

в таблицу `TestIncome` добавить кейс:

```go
		{"без сотрудников дохода нет", 0, 0, 0, 0, 1.0, 0},
```

в конец `TestApply` добавить проверку остальных веток switch:

```go
	g2 := New(DefaultConfig())
	g2.Money = 10000
	for _, tc := range []struct {
		cmd   Command
		check func() bool
	}{
		{CmdBuyPC, func() bool { return g2.PCs == 2 }},
		{CmdBuyRouter, func() bool { return g2.RouterTier == 1 }},
		{CmdBuyServer, func() bool { return g2.Servers == 1 }},
	} {
		if err := g2.Apply(tc.cmd); err != nil || !tc.check() {
			t.Errorf("Apply(%s): err=%v, состояние не изменилось", tc.cmd, err)
		}
	}
```

- [ ] **Step 2: Ограничить маршрут методом**

`server/cmd/server/main.go` — заменить строку 20:

```go
	mux.Handle("GET /ws", &ws.Handler{Config: game.DefaultConfig(), TickInterval: time.Second})
```

- [ ] **Step 3: Тесты зелёные**

Run: `cd server && go test -race ./... && go vet ./...`
Expected: PASS, vet чистый

- [ ] **Step 4: Commit**

```bash
git add server/
git commit -m "test(game): пробелы покрытия итерации 1; GET /ws"
```

---

### Task 5: Клиент — протокол, сеть, формат денег

**Files:**
- Modify: `client/src/protocol.ts`
- Modify: `client/src/net.ts`
- Create: `client/src/format.ts`

**Interfaces:**
- Consumes: JSON-имена из Task 3 (`day`, `dayTicks`, `dayProgress`, `payrollPerDay`, `phase`, `day_report`, `game_over`, `daysSurvived`, `peakIncomePerTick`).
- Produces: типы `DayReportMessage`, `GameOverMessage`; `StateMessage` с полями дня; `CommandType` += `'next_day' | 'restart'`; `Listener` с опциональными `onDayReport?`, `onGameOver?`; `fmtMoney(n: number): string` → `$12,500` / `-$220`.

- [ ] **Step 1: Обновить `client/src/protocol.ts`**

В `StateMessage` после `incomePerTick: number` добавить:

```ts
  day: number
  dayTicks: number
  dayProgress: number
  payrollPerDay: number
  phase: 'running' | 'day_report' | 'game_over'
```

После `ErrorMessage` добавить:

```ts
export interface DayReportMessage {
  type: 'day_report'
  day: number
  income: number
  payroll: number
  profit: number
  balance: number
}

export interface GameOverMessage {
  type: 'game_over'
  daysSurvived: number
  peakIncomePerTick: number
  balance: number
}
```

Заменить объединения:

```ts
export type ServerMessage = StateMessage | ErrorMessage | DayReportMessage | GameOverMessage

export type CommandType = 'buy_pc' | 'hire' | 'buy_router' | 'buy_server' | 'next_day' | 'restart'
```

- [ ] **Step 2: Создать `client/src/format.ts`**

```ts
// Деньги в UI — только через fmtMoney, чтобы формат был единым.
export function fmtMoney(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US')
}
```

- [ ] **Step 3: Обновить `client/src/net.ts`**

Импорт и интерфейс:

```ts
import type { CommandType, DayReportMessage, GameOverMessage, ServerMessage, StateMessage } from './protocol'

export interface Listener {
  onState(s: StateMessage): void
  onError(code: string): void
  onDisconnect(): void
  // Только HUD показывает отчёты и банкротство — для остальных сцен опциональны.
  onDayReport?(r: DayReportMessage): void
  onGameOver?(o: GameOverMessage): void
}
```

В `connect()` заменить диспетчеризацию `onmessage` и обработчики закрытия:

```ts
      if (msg.type === 'state') {
        this.latest = msg
        this.listeners.forEach((l) => l.onState(msg))
      } else if (msg.type === 'error') {
        this.listeners.forEach((l) => l.onError(msg.code))
      } else if (msg.type === 'day_report') {
        this.listeners.forEach((l) => l.onDayReport?.(msg))
      } else {
        this.listeners.forEach((l) => l.onGameOver?.(msg))
      }
    }
    // onerror и onclose могут прийти оба — дисконнект сообщаем один раз.
    let disconnected = false
    const fireDisconnect = () => {
      if (disconnected) return
      disconnected = true
      this.listeners.forEach((l) => l.onDisconnect())
    }
    this.ws.onclose = fireDisconnect
    this.ws.onerror = fireDisconnect
```

- [ ] **Step 4: Typecheck**

Run: `cd client && npm run typecheck`
Expected: без ошибок

- [ ] **Step 5: Commit**

```bash
git add client/src/protocol.ts client/src/net.ts client/src/format.ts
git commit -m "feat(client): протокол дня, onerror и формат денег"
```

---

### Task 6: HUD — день, ФОТ, прогноз банкротства, форматирование

**Files:**
- Modify: `client/src/scenes/HUDScene.ts`

**Interfaces:**
- Consumes: `StateMessage` с полями дня (Task 5), `fmtMoney` (Task 5).
- Produces: приватные `payrollText`, `dayText` в HUD; `ERROR_TEXTS['wrong_phase']`. Ничего внешнего.

- [ ] **Step 1: Реализация**

В `ERROR_TEXTS` добавить:

```ts
  wrong_phase: 'Сейчас нельзя — дождитесь начала дня',
```

Импортировать формат: `import { fmtMoney } from '../format'`.

Добавить поля класса:

```ts
  private payrollText!: Phaser.GameObjects.Text
  private dayText!: Phaser.GameObjects.Text
```

В `create()` после создания `netText` добавить:

```ts
    this.payrollText = this.add.text(180, 44, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#5d7275',
    })
    this.dayText = this.add
      .text(944, 70, '', { fontFamily: 'monospace', fontSize: '13px', color: '#5d7275' })
      .setOrigin(1, 0)
```

Заменить `refresh()`:

```ts
  private refresh(s: StateMessage) {
    this.moneyText.setText(fmtMoney(s.money))
    this.incomeText.setText(`+${fmtMoney(s.incomePerTick)}/сек`)
    // Прогноз баланса на конец дня: если уйдём в минус — подсветить ФОТ.
    const forecast = s.money + s.incomePerTick * (s.dayTicks - s.dayProgress) - s.payrollPerDay
    this.payrollText.setText(`ФОТ ${fmtMoney(s.payrollPerDay)}/день`)
    this.payrollText.setColor(forecast < 0 ? '#b13e53' : '#5d7275')
    this.dayText.setText(`День ${s.day} · ${s.dayProgress}/${s.dayTicks}`)
    this.netText.setText(`Сотрудники: ${s.employees} · в сети ${s.connected} · ×${s.multiplier.toFixed(1)}`)
    this.pcBtn.setLabel(`Купить ПК  ${fmtMoney(s.prices.pc)}`)
    this.hireBtn.setLabel(`Нанять  ${fmtMoney(s.prices.hire)}`)
    this.routerBtn.setLabel(s.prices.nextRouter > 0 ? `Роутер  ${fmtMoney(s.prices.nextRouter)}` : 'Роутер MAX')
    this.serverBtn.setLabel(`Сервер  ${fmtMoney(s.prices.server)}`)
  }
```

- [ ] **Step 2: Typecheck и ручная проверка**

Run: `cd client && npm run typecheck`
Expected: без ошибок.
Run: `make dev`, открыть http://localhost:5173 — в HUD видны `ФОТ $0/день` и `День 1 · N/60`, счётчик тикает; после найма ФОТ становится `$250/день`; деньги с разделителями.

- [ ] **Step 3: Commit**

```bash
git add client/src/scenes/HUDScene.ts
git commit -m "feat(client): ФОТ, день и прогноз банкротства в HUD"
```

---

### Task 7: Клиент — панель отчёта дня и галка «пропускать отчёты»

**Files:**
- Modify: `client/src/scenes/HUDScene.ts`

**Interfaces:**
- Consumes: `DayReportMessage`, `onDayReport` (Task 5), `fmtMoney`.
- Produces: приватные методы HUD `showReport`/`closeReport`; ключ localStorage `skipReports` (`'1'` — пропускать).

- [ ] **Step 1: Реализация**

Импорт типов: `import type { DayReportMessage, GameOverMessage, StateMessage } from '../protocol'`.

Поля класса:

```ts
  private reportUI: Phaser.GameObjects.GameObject[] = []
  private skipReports = localStorage.getItem('skipReports') === '1'
```

В `create()` дополнить подписку:

```ts
    const unsub = client.subscribe({
      onState: (s) => this.refresh(s),
      onError: (code) => this.toast(ERROR_TEXTS[code] ?? code),
      onDisconnect: () => this.showDisconnect(),
      onDayReport: (r) => this.onDayReport(r),
    })
```

Методы:

```ts
  private onDayReport(r: DayReportMessage) {
    if (this.skipReports) {
      client.send('next_day')
      this.toast(`День ${r.day}: прибыль ${fmtMoney(r.profit)} · баланс ${fmtMoney(r.balance)}`)
      return
    }
    this.showReport(r)
  }

  private showReport(r: DayReportMessage) {
    this.closeReport()
    const body = [
      `Доход:    ${fmtMoney(r.income)}`,
      `ФОТ:     -${fmtMoney(r.payroll)}`,
      `Прибыль:  ${fmtMoney(r.profit)}`,
      `Баланс:   ${fmtMoney(r.balance)}`,
    ].join('\n')
    // Подложка interactive: глушит клики по кнопкам HUD под модалкой.
    const overlay = this.add.rectangle(0, 0, 960, 640, 0x1a1c2c, 0.75).setOrigin(0).setDepth(50).setInteractive()
    const panel = this.add.rectangle(480, 300, 440, 320, 0x14162b).setStrokeStyle(2, 0x41a6f6).setDepth(51)
    const title = this.add
      .text(480, 180, `День ${r.day} завершён`, { fontFamily: 'monospace', fontSize: '22px', color: '#ffcd75' })
      .setOrigin(0.5).setDepth(51)
    const bodyText = this.add
      .text(480, 280, body, { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8 })
      .setOrigin(0.5).setDepth(51)
    const checkbox = this.add
      .text(480, 366, this.checkboxLabel(), { fontFamily: 'monospace', fontSize: '14px', color: '#5d7275' })
      .setOrigin(0.5).setDepth(51).setInteractive({ useHandCursor: true })
    checkbox.on('pointerdown', () => {
      this.skipReports = !this.skipReports
      localStorage.setItem('skipReports', this.skipReports ? '1' : '0')
      checkbox.setText(this.checkboxLabel())
    })
    const btnBg = this.add
      .rectangle(380, 400, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(51)
      .setInteractive({ useHandCursor: true })
    const btnText = this.add
      .text(480, 417, 'Следующий день →', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(52)
    btnBg.on('pointerdown', () => {
      client.send('next_day')
      this.closeReport()
    })
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.reportUI = [overlay, panel, title, bodyText, checkbox, btnBg, btnText]
  }

  private checkboxLabel(): string {
    return `[${this.skipReports ? 'x' : ' '}] пропускать отчёты`
  }

  private closeReport() {
    this.reportUI.forEach((o) => o.destroy())
    this.reportUI = []
  }
```

В начало `refresh()` добавить страховку (сервер — источник истины; если фаза уже running, модалке нечего висеть):

```ts
    if (s.phase === 'running') this.closeReport()
```

- [ ] **Step 2: Typecheck и ручная проверка**

Run: `cd client && npm run typecheck`
Expected: без ошибок.
Run: `make dev` — дождаться конца дня (60 сек): игра встаёт, модалка с цифрами; «Следующий день →» продолжает; галка включена → следующий отчёт проскакивает тостом; после перезагрузки страницы галка помнится.

- [ ] **Step 3: Commit**

```bash
git add client/src/scenes/HUDScene.ts
git commit -m "feat(client): панель отчёта дня с галкой пропуска"
```

---

### Task 8: Клиент — экран банкротства и рестарт

**Files:**
- Modify: `client/src/scenes/HUDScene.ts`

**Interfaces:**
- Consumes: `GameOverMessage`, `onGameOver` (Task 5), команда `restart`.
- Produces: приватные `showGameOver`/`closeGameOver` в HUD.

- [ ] **Step 1: Реализация**

Поле класса:

```ts
  private gameOverUI: Phaser.GameObjects.GameObject[] = []
```

Дополнить подписку в `create()`:

```ts
      onGameOver: (o) => this.showGameOver(o),
```

Методы:

```ts
  private showGameOver(o: GameOverMessage) {
    this.closeReport()
    this.closeGameOver()
    const overlay = this.add.rectangle(0, 0, 960, 640, 0x1a1c2c, 0.9).setOrigin(0).setDepth(60).setInteractive()
    const title = this.add
      .text(480, 220, 'БАНКРОТСТВО', { fontFamily: 'monospace', fontSize: '32px', color: '#b13e53' })
      .setOrigin(0.5).setDepth(61)
    const body = this.add
      .text(480, 300, [
        `Прожито дней: ${o.daysSurvived}`,
        `Пик дохода: ${fmtMoney(o.peakIncomePerTick)}/сек`,
        `На зарплаты не хватило: ${fmtMoney(-o.balance)}`,
      ].join('\n'), { fontFamily: 'monospace', fontSize: '16px', color: '#f4f4f4', lineSpacing: 8, align: 'center' })
      .setOrigin(0.5).setDepth(61)
    const btnBg = this.add
      .rectangle(380, 380, 200, 34, 0x3b5dc9).setOrigin(0, 0).setDepth(61)
      .setInteractive({ useHandCursor: true })
    const btnText = this.add
      .text(480, 397, 'Начать заново', { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(62)
    btnBg.on('pointerdown', () => client.send('restart'))
    btnBg.on('pointerover', () => btnBg.setFillStyle(0x41a6f6))
    btnBg.on('pointerout', () => btnBg.setFillStyle(0x3b5dc9))
    this.gameOverUI = [overlay, title, body, btnBg, btnText]
  }

  private closeGameOver() {
    this.gameOverUI.forEach((o) => o.destroy())
    this.gameOverUI = []
  }
```

В страховку в начале `refresh()` добавить закрытие game over (сервер после restart шлёт снапшот с `phase: 'running'` — комнаты перерисуются сами, они рисуют всё из снапшота):

```ts
    if (s.phase === 'running') {
      this.closeReport()
      this.closeGameOver()
    }
```

- [ ] **Step 2: Typecheck и ручная проверка**

Run: `cd client && npm run typecheck`
Expected: без ошибок.
Run: `make dev` — нанять 2 сотрудников сразу и ничего не покупать до конца дня НЕ выйдет (доход покроет ФОТ), поэтому проверка: временно в `server/internal/game/config.go` поставить `SalaryPerDay: 100000`, `make dev`, нанять → конец дня → экран «БАНКРОТСТВО», «Начать заново» → стартовое состояние ($600, 1 ПК, офис пустой). Вернуть `SalaryPerDay: 250` перед коммитом (`git diff` — чисто).

- [ ] **Step 3: Commit**

```bash
git add client/src/scenes/HUDScene.ts
git commit -m "feat(client): экран банкротства и рестарт"
```

---

### Task 9: Клиентский техдолг — спам-клики переключателя, guard текстур

**Files:**
- Modify: `client/src/scenes/HUDScene.ts:88-94` (метод `switchRoom`)
- Modify: `client/src/pixelart.ts` (начало `registerTextures`)

**Interfaces:**
- Consumes: существующий код; ничего нового не производит.

- [ ] **Step 1: Защита от спам-кликов**

В `HUDScene` добавить поле:

```ts
  private switching = false
```

и заменить `switchRoom()`:

```ts
  private switchRoom() {
    // Двойной клик до завершения stop/launch дублирует сцену — гасим дребезг.
    if (this.switching) return
    this.switching = true
    this.time.delayedCall(250, () => (this.switching = false))
    const next = this.room === 'office' ? 'serverRoom' : 'office'
    this.scene.stop(this.room)
    this.scene.launch(next)
    this.room = next
    this.switchBtn.setLabel(this.room === 'office' ? 'В серверную →' : '← В офис')
  }
```

- [ ] **Step 2: Guard повторной регистрации текстур**

В `client/src/pixelart.ts` первой строкой тела `registerTextures` добавить:

```ts
  if (scene.textures.exists('worker')) return // повторный Boot — текстуры уже есть
```

(имя параметра сцены взять из фактической сигнатуры функции).

- [ ] **Step 3: Typecheck и проверка**

Run: `cd client && npm run typecheck`
Expected: без ошибок. В `make dev` быстрый двойной клик по «В серверную →» не ломает сцену и не дублирует объекты.

- [ ] **Step 4: Commit**

```bash
git add client/src/scenes/HUDScene.ts client/src/pixelart.ts
git commit -m "fix(client): дребезг переключателя комнат и повторный Boot"
```

---

### Task 10: Живая проверка протокола против реального сервера

**Files:**
- Create: `scripts/live-check.mjs`

**Interfaces:**
- Consumes: весь серверный протокол (Task 3). Требует Node ≥ 22 (глобальный `WebSocket`).

- [ ] **Step 1: Написать скрипт проверки**

Создать `scripts/live-check.mjs`:

```js
// Живая проверка протокола итерации 2 против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем node scripts/live-check.mjs
// Ждёт настоящий конец дня (~60 сек) — это осознанно: проверяем прод-тайминги.
const FIELDS = [
  'money', 'pcs', 'employees', 'routerTier', 'ports', 'connected', 'servers',
  'multiplier', 'incomePerTick', 'officeSlots', 'rackSlots', 'prices',
  'day', 'dayTicks', 'dayProgress', 'payrollPerDay', 'phase',
]
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

const ws = new WebSocket('ws://localhost:8091/ws')
const timeout = setTimeout(() => fail('таймаут 90с', null), 90_000)
let phase = 'start'

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (phase === 'start' && m.type === 'state') {
    const missing = FIELDS.filter((f) => !(f in m))
    if (missing.length) fail('нет полей снапшота', missing)
    ok(`снапшот: все ${FIELDS.length} полей на месте`)
    if (m.phase !== 'running' || m.day !== 1) fail('стартовая фаза/день', m)
    ok('старт: phase=running, day=1')
    ws.send(JSON.stringify({ type: 'hire' }))
    phase = 'hired'
  } else if (phase === 'hired' && m.type === 'state' && m.employees === 1) {
    if (m.payrollPerDay !== 250) fail('ФОТ после найма', m.payrollPerDay)
    ok('найм: payrollPerDay=250')
    ws.send(JSON.stringify({ type: 'next_day' })) // вне фазы отчёта — ждём ошибку
    phase = 'wrong_phase'
  } else if (phase === 'wrong_phase' && m.type === 'error') {
    if (m.code !== 'wrong_phase') fail('код ошибки next_day в running', m.code)
    ok('next_day в running: error wrong_phase')
    phase = 'wait_report'
    console.log('… ждём конца дня (~60 сек)')
  } else if (phase === 'wait_report' && m.type === 'day_report') {
    if (m.day !== 1 || m.payroll !== 250) fail('отчёт дня', m)
    ok(`отчёт дня 1: income=${m.income} payroll=${m.payroll} balance=${m.balance}`)
    ws.send(JSON.stringify({ type: 'next_day' }))
    phase = 'day2'
  } else if (phase === 'day2' && m.type === 'state' && m.day === 2 && m.phase === 'running') {
    ok('next_day: день 2 запущен')
    clearTimeout(timeout)
    console.log('ПРОТОКОЛ ОК')
    process.exit(0)
  }
}
ws.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)
```

- [ ] **Step 2: Прогнать проверку**

```bash
cd server && go run ./cmd/server -addr :8091 &
sleep 1
node ../scripts/live-check.mjs
kill %1
```

Expected: `ok 1 … ok 6`, в конце `ПРОТОКОЛ ОК` (прогон ~65 сек).

- [ ] **Step 3: Commit**

```bash
git add scripts/live-check.mjs
git commit -m "test: живая проверка протокола итерации 2"
```

---

### Task 11: Графика — CC0-пак вместо кодогенерённых спрайтов

⚠️ **Чекпоинт пользователя внутри задачи** — интеграция ТОЛЬКО после его выбора.

**Files:**
- Create: `client/public/assets/*.png` (6 спрайтов), `client/public/assets/LICENSE.md`
- Modify: `client/src/scenes/BootScene.ts`
- Delete: `client/src/pixelart.ts`
- Modify: `README.md` (кредиты)

**Interfaces:**
- Consumes: ключи текстур, на которые завязаны сцены: `desk_empty`, `desk_pc`, `worker`, `router`, `rack_empty`, `rack_server` (16×16, масштаб задают сцены).
- Produces: те же ключи из PNG-файлов — сцены не меняются.

- [ ] **Step 1: Скачать кандидатов**

С https://kenney.nl (лицензия CC0) скачать во временный каталог 2-3 пака-кандидата с интерьерной/офисной пиксельной графикой 16×16 — начать с «Roguelike/RPG Pack» и «Tiny Town»; смотреть тайлы: стол, компьютер/монитор, человек, устройство-«роутер», серверная стойка (подойдёт шкаф/ящик с огоньками).

- [ ] **Step 2: ЧЕКПОИНТ — показать пользователю**

Вырезать по 6 тайлов-кандидатов из каждого пака (ImageMagick: `magick input.png -crop 16x16+X+Y out.png`), собрать увеличенную сравнительную картинку (`magick montage -scale 400% …`), показать пользователю и спросить: какой пак берём, или остаёмся на кодогене (фолбэк из спеки — тогда задача закрывается без изменений кода, графика уезжает в итерацию 3). **Не продолжать без ответа.**

- [ ] **Step 3: Интегрировать выбранный пак**

Положить 6 тайлов как `client/public/assets/<ключ>.png` (имена = ключи текстур). Создать `client/public/assets/LICENSE.md` с названием пака, ссылкой и текстом «CC0». Заменить `client/src/scenes/BootScene.ts`:

```ts
import Phaser from 'phaser'

const TEXTURE_KEYS = ['desk_empty', 'desk_pc', 'worker', 'router', 'rack_empty', 'rack_server'] as const

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  preload() {
    for (const key of TEXTURE_KEYS) this.load.image(key, `assets/${key}.png`)
  }

  create() {
    this.scene.start('office')
    this.scene.launch('hud') // HUD живёт поверх комнат
  }
}
```

Удалить `client/src/pixelart.ts` (guard из Task 9 уезжает вместе с ним). В `README.md` добавить раздел «Ассеты» с кредитом пака.

- [ ] **Step 4: Проверка**

Run: `cd client && npm run typecheck`
Expected: без ошибок.
Run: `make dev` — офис и серверная рисуются новыми спрайтами, все 6 состояний видны (пустой стол / стол с ПК / сотрудник / роутер / пустая стойка / стойка с сервером).

- [ ] **Step 5: Commit**

```bash
git add client/ README.md
git rm client/src/pixelart.ts 2>/dev/null; git add -A client/src
git commit -m "feat(client): CC0-спрайты вместо кодогенерённых"
```

---

### Task 12: README, прод-сборка, финальная проверка

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: всё выше.

- [ ] **Step 1: Обновить README**

В описание геймплея добавить 3-4 строки: игровой день (60 сек), зарплаты в конце дня, отчёт (пропускается галкой), банкротство = game over с рестартом.

- [ ] **Step 2: Полный прогон**

```bash
make test && make typecheck
cd server && go test -race ./... && go vet ./... && cd ..
make build
./bin/itdirector -static client/dist &
sleep 1
curl -sf http://localhost:8080/ | head -3        # статика отдаётся
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:8080/assets/worker.png  # 200 (если Task 11 не в фолбэке)
kill %1
```

Expected: всё зелёное, статика и ассеты отдаются.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README итерации 2"
```

После этого — плейтест пользователя (критерий готовности из спеки: ≥1 осмысленное решение «инфраструктура вместо найма», ≥1 момент риска банкротства) и `superpowers:finishing-a-development-branch`.
