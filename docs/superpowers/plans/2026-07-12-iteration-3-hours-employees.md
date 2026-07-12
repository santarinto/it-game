# Итерация 3: рабочие часы + сотрудники-личности — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Рабочий день в часах (10:00–19:00 с обедом без дохода), сотрудники-сущности с именами и личной выработкой $9–14/тик, офис на 12 слотов с потолком штата 9, тултип сотрудника.

**Architecture:** Домен `internal/game`: `Employees` из `int` становится `[]Employee` с собственным RNG игры; часы/обед/прогноз считает сервер и шлёт клиенту готовые (`clock`, `isLunch`, `forecastEndOfDay`). Протокол ломающе меняется (employees — массив), зеркало `protocol.ts` синхронно. Спека: `docs/superpowers/specs/2026-07-12-iteration-3-design.md`.

**Tech Stack:** Go (math/rand/v2, coder/websocket), TypeScript + Phaser 3 + Vite.

## Global Constraints

- Ветка `iteration-3` от `main` (создать перед Task 1: `git checkout -b iteration-3`).
- Комментарии — по-русски в стиле файлов; коммиты — conventional commits по-русски.
- Числа баланса ТОЛЬКО в `server/internal/game/config.go` (`DefaultConfig`); источник истины — GDD «Экономика»: час = 6 тиков, день 10:00–19:00 (54 тика), обед 14:00–15:00 (доход 0), выработка $9–14/тик, потолок штата 9, слотов офиса 12, зарплата $250/день.
- Протокол зеркалится: `server/internal/ws/protocol.go` ↔ `client/src/protocol.ts`, camelCase.
- Домен НЕ потокобезопасен by design; в сокет пишет только горутина `run`.
- Ошибки домена = коды протокола: новая `staff_limit`.
- Сервер считает всё сам: клиент НЕ вычисляет прогноз/часы — берёт `clock`, `isLunch`, `forecastEndOfDay` из снапшота.
- Серверные тесты: `go test ./...` из `server/`; перед коммитами задач 3 и 7 — `go test -race ./...`. Клиент: `npm run typecheck` из `client/`.
- Деньги в UI — только через `fmtMoney` (`client/src/format.ts`).

---

### Task 1: Домен — часы, обед, Clock

**Files:**
- Modify: `server/internal/game/config.go`
- Modify: `server/internal/game/game.go` (Tick, IncomePerTick, новые методы)
- Modify: `server/internal/game/day_test.go` (dayTestConfig на часы)
- Modify: `server/internal/ws/protocol.go:78` (`cfg.DayTicks` → `cfg.DayTicks()`)
- Modify: `server/internal/ws/session_test.go` (конфиги коротких дней на часы)
- Test: `server/internal/game/clock_test.go` (новый файл)

**Interfaces:**
- Consumes: существующие `Game`, `Config`.
- Produces: поля `Config.TicksPerHour/WorkdayStart/LunchStart/LunchEnd/WorkdayEnd int`; метод `Config.DayTicks() int` (поле `DayTicks` УДАЛЯЕТСЯ); `Config.isLunchTick(tick int) bool`; `(*Game).Clock() string` («HH:MM»); `(*Game).IsLunch() bool`; `IncomePerTick()` возвращает 0 в обед.

- [ ] **Step 1: Написать падающие тесты**

Создать `server/internal/game/clock_test.go`:

```go
package game

import "testing"

func TestDayTicksDerived(t *testing.T) {
	cfg := DefaultConfig()
	if got := cfg.DayTicks(); got != 54 {
		t.Errorf("DayTicks() = %d, хотим 54 ((19-10)×6)", got)
	}
}

func TestClock(t *testing.T) {
	tests := []struct {
		tick int
		want string
	}{
		{0, "10:00"},
		{1, "10:10"},
		{23, "13:50"},
		{24, "14:00"}, // начало обеда
		{29, "14:50"}, // последний тик обеда
		{30, "15:00"},
		{53, "18:50"}, // последний тик дня
		{54, "19:00"}, // конец дня (фаза отчёта)
	}
	g := New(DefaultConfig())
	for _, tt := range tests {
		g.TickInDay = tt.tick
		if got := g.Clock(); got != tt.want {
			t.Errorf("Clock() на тике %d = %q, хотим %q", tt.tick, got, tt.want)
		}
	}
}

func TestIsLunch(t *testing.T) {
	g := New(DefaultConfig())
	for tick, want := range map[int]bool{0: false, 23: false, 24: true, 29: true, 30: false, 53: false} {
		g.TickInDay = tick
		if got := g.IsLunch(); got != want {
			t.Errorf("IsLunch() на тике %d = %v, хотим %v", tick, got, want)
		}
	}
}

func TestLunchZeroIncome(t *testing.T) {
	g := New(DefaultConfig())
	g.PCs = 1
	g.Employees = 1
	g.TickInDay = 23
	if inc := g.IncomePerTick(); inc == 0 {
		t.Error("до обеда доход должен быть > 0")
	}
	g.TickInDay = 24
	if inc := g.IncomePerTick(); inc != 0 {
		t.Errorf("в обед доход = %d, хотим 0", inc)
	}
	g.TickInDay = 30
	if inc := g.IncomePerTick(); inc == 0 {
		t.Error("после обеда доход должен быть > 0")
	}
}
```

(В этой задаче `Employees` ещё `int` — сущности приходят в Task 2.)

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — compile errors (`cfg.DayTicks undefined (type Config has no method DayTicks)` либо `unknown field TicksPerHour`).

- [ ] **Step 3: Реализация конфига**

`server/internal/game/config.go` — УДАЛИТЬ поле `DayTicks int` из `Config` и строку `DayTicks: 60,` из `DefaultConfig`. Добавить в `Config` после `ServerBonus`:

```go
	TicksPerHour int // 1 игровой час = столько тиков (секунд)
	WorkdayStart int // час начала рабочего дня
	LunchStart   int // обед: начало (доход за тики обеда = 0)
	LunchEnd     int // обед: конец
	WorkdayEnd   int // час конца дня → зарплаты → отчёт
```

в `DefaultConfig()` вместо `DayTicks: 60,`:

```go
		TicksPerHour: 6,
		WorkdayStart: 10,
		LunchStart:   14,
		LunchEnd:     15,
		WorkdayEnd:   19,
```

и методы в конец файла:

```go
// DayTicks — длина дня в тиках; выводится из рабочих часов.
func (c Config) DayTicks() int { return (c.WorkdayEnd - c.WorkdayStart) * c.TicksPerHour }

// isLunchTick — попадает ли тик дня в обеденный час.
func (c Config) isLunchTick(tick int) bool {
	hour := c.WorkdayStart + tick/c.TicksPerHour
	return hour >= c.LunchStart && hour < c.LunchEnd
}
```

- [ ] **Step 4: Реализация в game.go**

Добавить импорт `"fmt"`. В `IncomePerTick` первой строкой:

```go
	if g.IsLunch() {
		return 0
	}
```

В `Tick()` заменить `if g.TickInDay < g.cfg.DayTicks {` на `if g.TickInDay < g.cfg.DayTicks() {`.

Добавить методы (после `Multiplier`):

```go
// Clock — текущее игровое время «HH:MM»: WorkdayStart плюс 10 минут за тик.
func (g *Game) Clock() string {
	minutes := g.TickInDay * 60 / g.cfg.TicksPerHour
	return fmt.Sprintf("%02d:%02d", g.cfg.WorkdayStart+minutes/60, minutes%60)
}

// IsLunch — идёт ли сейчас обед (в обед доход за тик равен нулю).
func (g *Game) IsLunch() bool { return g.cfg.isLunchTick(g.TickInDay) }
```

- [ ] **Step 5: Мигрировать конфиги тестов с DayTicks на часы**

`server/internal/game/day_test.go` — заменить `dayTestConfig`:

```go
// dayTestConfig — короткий день: 1 час по 3 тика, обед за пределами дня.
func dayTestConfig() Config {
	cfg := DefaultConfig()
	cfg.WorkdayStart = 10
	cfg.WorkdayEnd = 11
	cfg.TicksPerHour = 3
	cfg.SalaryPerDay = 250
	return cfg
}
```

`server/internal/game/day_test.go` — в `TestDefaultConfigDay` заменить проверку:

```go
	if cfg.DayTicks() != 54 || cfg.SalaryPerDay != 250 {
		t.Errorf("DayTicks()=%d SalaryPerDay=%d, хотим 54 и 250 (GDD, «Экономика»)", cfg.DayTicks(), cfg.SalaryPerDay)
	}
```

`server/internal/ws/session_test.go` — в `TestSessionDayCycle` заменить `cfg.DayTicks = 2` на:

```go
	// День = 2 тика: 1 час по 2 тика.
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 2
```

в `TestSessionBankruptcyAndRestart` заменить `cfg.DayTicks = 100` на:

```go
	// День = 1 секунда (100 тиков по 10мс): огромный запас, чтобы hire успел.
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 100
```

`server/internal/ws/protocol.go:78` — `DayTicks: cfg.DayTicks,` → `DayTicks: cfg.DayTicks(),`.
`server/internal/ws/protocol_test.go` — в `TestSnapshot` ожидание `s.DayTicks != 60` заменить на `s.DayTicks != 54`.

- [ ] **Step 6: Тесты зелёные**

Run: `cd server && go test ./...`
Expected: PASS (старые day-тесты работают: короткий день 3 тика без обеда сохраняет всю арифметику).

- [ ] **Step 7: Commit**

```bash
git add server/
git commit -m "feat(game): рабочие часы, обед без дохода и Clock"
```

---

### Task 2: Домен — сотрудники-сущности, имена, staff_limit, прогноз

**Files:**
- Create: `server/internal/game/names.go`
- Modify: `server/internal/game/config.go`
- Modify: `server/internal/game/game.go`
- Modify: `server/internal/game/commands.go`
- Test: `server/internal/game/employee_test.go` (новый), правки `game_test.go`, `day_test.go`

**Interfaces:**
- Consumes: часы/обед из Task 1 (`DayTicks()`, `IsLunch()`).
- Produces: `type Employee struct { Name string; IncomePerTick int }`; `Game.Employees []Employee`; `NewWithSeed(cfg Config, s1, s2 uint64) *Game`; `ErrStaffLimit = Err("staff_limit")`; конфиг `IncomeMin=9, IncomeMax=14, StaffLimit=9, OfficeSlots=12` (поле `BaseIncomePerTick` УДАЛЯЕТСЯ); `(*Game).ForecastEndOfDay() int`; `rollName(rng *rand.Rand) string`.

- [ ] **Step 1: Написать падающие тесты**

Создать `server/internal/game/employee_test.go`:

```go
package game

import (
	"strings"
	"testing"
)

// testStaff — n сотрудников с выработкой ровно $10/тик:
// сохраняет арифметику старых тестов, писавших Employees = n.
func testStaff(n int) []Employee {
	s := make([]Employee, n)
	for i := range s {
		s[i] = Employee{Name: "Тест Тестов", IncomePerTick: 10}
	}
	return s
}

func TestHireRollsEmployee(t *testing.T) {
	g := NewWithSeed(DefaultConfig(), 1, 2)
	g.Money = 10000
	g.PCs = 9
	for i := 0; i < 9; i++ {
		if err := g.Hire(); err != nil {
			t.Fatalf("найм %d: %v", i+1, err)
		}
	}
	for i, e := range g.Employees {
		if e.IncomePerTick < 9 || e.IncomePerTick > 14 {
			t.Errorf("сотрудник %d: выработка %d вне [9..14]", i, e.IncomePerTick)
		}
		if !strings.Contains(e.Name, " ") || len(e.Name) < 5 {
			t.Errorf("сотрудник %d: подозрительное имя %q", i, e.Name)
		}
	}
}

func TestHireDeterministicWithSeed(t *testing.T) {
	roll := func() []Employee {
		g := NewWithSeed(DefaultConfig(), 42, 42)
		g.Money = 10000
		g.PCs = 3
		for i := 0; i < 3; i++ {
			if err := g.Hire(); err != nil {
				t.Fatal(err)
			}
		}
		return g.Employees
	}
	a, b := roll(), roll()
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("один сид — разные роллы: %+v vs %+v", a[i], b[i])
		}
	}
}

func TestIncomeSumsPersonalRates(t *testing.T) {
	g := New(DefaultConfig())
	g.PCs = 3
	g.Employees = []Employee{
		{Name: "А Б", IncomePerTick: 9},
		{Name: "В Г", IncomePerTick: 14},
		{Name: "Д Е", IncomePerTick: 11},
	}
	// Без сети: сумма личных выработок.
	if inc := g.IncomePerTick(); inc != 34 {
		t.Errorf("доход без сети = %d, хотим 34", inc)
	}
	// Роутер (4 порта) + 2 сервера: множитель ×2.0 всем троим.
	g.RouterTier = 1
	g.Servers = 2
	if inc := g.IncomePerTick(); inc != 68 {
		t.Errorf("доход с сетью ×2.0 = %d, хотим 68", inc)
	}
}

func TestStaffLimit(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 100000
	g.PCs = 9
	g.Employees = testStaff(9)
	if err := g.Hire(); err != ErrStaffLimit {
		t.Errorf("найм 10-го: err = %v, хотим %v", err, ErrStaffLimit)
	}
	if err := g.BuyPC(); err != ErrStaffLimit {
		t.Errorf("10-й ПК: err = %v, хотим %v", err, ErrStaffLimit)
	}
}

func TestForecastEndOfDay(t *testing.T) {
	cfg := DefaultConfig()
	g := New(cfg)
	g.Money = 1000
	g.PCs = 1
	g.Employees = []Employee{{Name: "А Б", IncomePerTick: 10}}
	g.TickInDay = 0
	// 48 продуктивных тиков × $10 − ФОТ $250 = +$230 к балансу.
	if f := g.ForecastEndOfDay(); f != 1230 {
		t.Errorf("прогноз с утра = %d, хотим 1230", f)
	}
	// С тика 30 (после обеда) осталось 24 продуктивных тика.
	g.TickInDay = 30
	if f := g.ForecastEndOfDay(); f != 1000+240-250 {
		t.Errorf("прогноз после обеда = %d, хотим 990", f)
	}
	// Во время обеда прогноз не считает обеденные тики доходными.
	g.TickInDay = 24
	if f := g.ForecastEndOfDay(); f != 1000+240-250 {
		t.Errorf("прогноз в обед = %d, хотим 990", f)
	}
}

func TestRestartClearsStaff(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 0
	g.PCs = 3
	g.Employees = testStaff(3)
	for i := 0; i < dayTestConfig().DayTicks(); i++ {
		g.Tick()
	}
	if g.Phase != PhaseGameOver {
		t.Fatalf("подготовка: ждали game_over, Phase=%q", g.Phase)
	}
	if err := g.Restart(); err != nil {
		t.Fatal(err)
	}
	if len(g.Employees) != 0 {
		t.Errorf("после Restart сотрудников %d, хотим 0", len(g.Employees))
	}
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — compile errors (`NewWithSeed` undefined, `[]Employee` vs `int` и т.д.)

- [ ] **Step 3: Генератор имён**

Создать `server/internal/game/names.go`:

```go
package game

import "math/rand/v2"

// Списки для генератора имён сотрудников. Повторы допустимы (MVP).
// Фамилии — на -ов/-ев/-ин: женская форма получается добавлением «а».
var maleNames = []string{
	"Александр", "Дмитрий", "Максим", "Сергей", "Андрей", "Алексей",
	"Артём", "Илья", "Кирилл", "Михаил", "Никита", "Матвей",
	"Роман", "Егор", "Иван", "Денис",
}

var femaleNames = []string{
	"Анна", "Мария", "Елена", "Дарья", "Алина", "Ирина",
	"Екатерина", "Наталья", "Ольга", "Полина", "Софья", "Татьяна",
	"Вера", "Ксения", "Юлия", "Светлана",
}

var surnames = []string{
	"Иванов", "Смирнов", "Кузнецов", "Попов", "Васильев", "Петров",
	"Соколов", "Михайлов", "Новиков", "Фёдоров", "Морозов", "Волков",
	"Алексеев", "Лебедев", "Семёнов", "Егоров", "Павлов", "Козлов",
	"Степанов", "Николаев", "Орлов", "Андреев", "Макаров", "Никитин",
}

// rollName — случайные «Имя Фамилия» с согласованием пола.
func rollName(rng *rand.Rand) string {
	surname := surnames[rng.IntN(len(surnames))]
	if rng.IntN(2) == 0 {
		return maleNames[rng.IntN(len(maleNames))] + " " + surname
	}
	return femaleNames[rng.IntN(len(femaleNames))] + " " + surname + "а"
}
```

- [ ] **Step 4: Конфиг**

`server/internal/game/config.go` — УДАЛИТЬ поле `BaseIncomePerTick int` (и его строку в `DefaultConfig`). Добавить в `Config`:

```go
	IncomeMin  int // нижняя граница выработки сотрудника, $/тик
	IncomeMax  int // верхняя граница выработки сотрудника, $/тик
	StaffLimit int // потолок штата и ПК; слоты сверх лимита ждут начальника
```

В `DefaultConfig()`: `OfficeSlots: 9,` → `OfficeSlots: 12,` и добавить:

```go
		IncomeMin:  9,
		IncomeMax:  14,
		StaffLimit: 9,
```

- [ ] **Step 5: Game — срез сотрудников и RNG**

`server/internal/game/game.go` — импорт `"math/rand/v2"`. В структуре `Game`:
- добавить поле `rng *rand.Rand` сразу после `cfg Config`;
- `Employees int` → `Employees []Employee`;
- комментарий поля `PCs` оставить.

Добавить перед `Game`:

```go
// Employee — сотрудник: имя и личная выработка, роллятся при найме навсегда.
type Employee struct {
	Name          string
	IncomePerTick int
}
```

Заменить конструкторы:

```go
func New(cfg Config) *Game {
	return NewWithSeed(cfg, rand.Uint64(), rand.Uint64())
}

// NewWithSeed — игра с фиксированным сидом: детерминированные роллы для тестов.
func NewWithSeed(cfg Config, s1, s2 uint64) *Game {
	return &Game{
		cfg:   cfg,
		rng:   rand.New(rand.NewPCG(s1, s2)),
		Money: cfg.StartMoney, PCs: cfg.StartPCs, Phase: PhaseRunning, Day: 1,
	}
}
```

Заменить методы, зависевшие от счётчика:

```go
func (g *Game) Connected() int {
	return min(g.Ports(), len(g.Employees))
}
```

```go
// IncomePerTick — доход за один тик; во время обеда — 0.
func (g *Game) IncomePerTick() int {
	if g.IsLunch() {
		return 0
	}
	return g.incomePotentialPerTick()
}

// incomePotentialPerTick — доход за продуктивный (не обеденный) тик:
// сумма личных выработок, первые Connected() — с сетевым множителем.
func (g *Game) incomePotentialPerTick() int {
	connected := g.Connected()
	mult := g.Multiplier()
	total := 0
	for i, e := range g.Employees {
		if i < connected {
			total += int(math.Round(float64(e.IncomePerTick) * mult))
		} else {
			total += e.IncomePerTick
		}
	}
	return total
}
```

```go
func (g *Game) PayrollPerDay() int { return len(g.Employees) * g.cfg.SalaryPerDay }
```

Добавить прогноз (после `PayrollPerDay`):

```go
// ForecastEndOfDay — баланс на конец дня: деньги + доход за оставшиеся
// продуктивные тики − ФОТ. Считает сервер: клиентская формула не знает про обед.
func (g *Game) ForecastEndOfDay() int {
	productive := 0
	for t := g.TickInDay; t < g.cfg.DayTicks(); t++ {
		if !g.cfg.isLunchTick(t) {
			productive++
		}
	}
	return g.Money + g.incomePotentialPerTick()*productive - g.PayrollPerDay()
}
```

- [ ] **Step 6: Команды — staff_limit и ролл при найме**

`server/internal/game/commands.go` — добавить к ошибкам:

```go
	ErrStaffLimit = Err("staff_limit")
```

Заменить `BuyPC` и `Hire`:

```go
// BuyPC ставит новый ПК в свободный слот офиса. Слоты сверх потолка
// штата закрыты до начальника (итерация 4).
func (g *Game) BuyPC() error {
	if g.PCs >= g.cfg.StaffLimit {
		return ErrStaffLimit
	}
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

// Hire сажает нового сотрудника за свободный ПК: имя и выработка
// роллятся при найме и не меняются.
func (g *Game) Hire() error {
	if len(g.Employees) >= g.cfg.StaffLimit {
		return ErrStaffLimit
	}
	if len(g.Employees) >= g.PCs {
		return ErrNoFreePC
	}
	if g.Money < g.cfg.HirePrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.HirePrice
	g.Employees = append(g.Employees, Employee{
		Name:          rollName(g.rng),
		IncomePerTick: g.cfg.IncomeMin + g.rng.IntN(g.cfg.IncomeMax-g.cfg.IncomeMin+1),
	})
	return nil
}
```

- [ ] **Step 7: Мигрировать существующие тесты**

Во всех тестах `internal/game` заменить присваивания-счётчики на срез (хелпер `testStaff` уже в employee_test.go):

- `game_test.go`: `g.Employees = tt.employees` (TestIncome) → `g.Employees = testStaff(tt.employees)`; `g.Employees = 1` → `g.Employees = testStaff(1)`; проверки `g.Employees != N` → `len(g.Employees) != N`; кейс TestBuyPC «офис полон» (`g.PCs = 9`, ждал `ErrNoFreeOfficeSlot`) теперь ждёт `ErrStaffLimit` (потолок 9 при 12 слотах), кейс «офис полон и денег нет» — тоже `ErrStaffLimit`; в TestHire кейс «нет свободного ПК» ставит `g.Employees = testStaff(1)`; TestNewGameStart: `g.Employees != 0` → `len(g.Employees) != 0`.
- `day_test.go`: все `g.Employees = N` → `g.Employees = testStaff(N)`; в `TestRestart` проверка `g.Employees != 0` → `len(g.Employees) != 0`; `TestPeakIncomeTracked` управляет штатом через `g.Employees = testStaff(2)` / `testStaff(1)`.
- `TestDayEndsWithReport`/`TestDayEndBankruptcy`/`TestDayEndExactZeroSurvives` используют `testStaff(1)` — арифметика ($10/тик) сохраняется.
- `clock_test.go` (из Task 1): в `TestLunchZeroIncome` заменить `g.Employees = 1` → `g.Employees = testStaff(1)`.

- [ ] **Step 8: Тесты зелёные**

Run: `cd server && go test ./internal/game/`
Expected: PASS.

Пакет ws на этом этапе ломается — это норма, его переделывает Task 3. Чтобы коммит собирался, внести в `server/internal/ws/protocol.go` ТОЛЬКО минимальную правку компиляции: `Employees: len(g.Employees),` (числовые поля снапшота пока остаются). После неё `go build ./...` обязан собираться; `go test ./internal/ws/` может падать ассертами (`TestSnapshot` ждёт OfficeSlots 9, стало 12) — зафиксировать это в отчёте как ожидаемое до Task 3, `session_test.go` не трогать.

- [ ] **Step 9: Commit**

```bash
git add server/
git commit -m "feat(game): сотрудники-сущности с именами, staff_limit и прогноз дня"
```

---

### Task 3: Протокол — массив employees, clock/isLunch/forecast

**Files:**
- Modify: `server/internal/ws/protocol.go`
- Modify: `server/internal/ws/protocol_test.go`
- Modify: `server/internal/ws/session_test.go`
- Test: там же

**Interfaces:**
- Consumes: `Game.Employees []Employee`, `Clock()`, `IsLunch()`, `ForecastEndOfDay()`, конфиг Task 1-2.
- Produces: снапшот: `employees: [{name, incomePerTick, connected}]` (числовые `employees`/`connected` УДАЛЕНЫ), новые поля `clock`, `isLunch`, `forecastEndOfDay`, `salaryPerDay`, `staffLimit`, `ticksPerHour`. Клиент (Task 4) зеркалит имена.

- [ ] **Step 1: Написать падающие тесты**

`server/internal/ws/protocol_test.go` — заменить `TestSnapshot` целиком:

```go
func TestSnapshot(t *testing.T) {
	g := game.New(game.DefaultConfig())
	s := snapshot(g)
	if s.Type != "state" {
		t.Errorf("Type = %q, хотим state", s.Type)
	}
	if s.Money != 600 || s.PCs != 1 || s.OfficeSlots != 12 || s.RackSlots != 3 {
		t.Errorf("стартовый снапшот неверен: %+v", s)
	}
	if s.Prices.PC != 500 || s.Prices.Hire != 300 || s.Prices.Server != 2000 || s.Prices.NextRouter != 800 {
		t.Errorf("цены в снапшоте неверны: %+v", s.Prices)
	}
	if s.Multiplier != 1.0 || s.IncomePerTick != 0 {
		t.Errorf("производные поля неверны: %+v", s)
	}
	if s.Day != 1 || s.DayTicks != 54 || s.DayProgress != 0 || s.PayrollPerDay != 0 || s.Phase != "running" {
		t.Errorf("поля дня в снапшоте неверны: %+v", s)
	}
	if len(s.Employees) != 0 || s.Clock != "10:00" || s.IsLunch || s.StaffLimit != 9 ||
		s.SalaryPerDay != 250 || s.TicksPerHour != 6 || s.ForecastEndOfDay != 600 {
		t.Errorf("поля итерации 3 неверны: %+v", s)
	}
}

func TestSnapshotEmployees(t *testing.T) {
	g := game.New(game.DefaultConfig())
	g.PCs = 3
	g.Employees = []game.Employee{
		{Name: "Анна Иванова", IncomePerTick: 12},
		{Name: "Пётр Волков", IncomePerTick: 9},
	}
	g.RouterTier = 1 // 4 порта: оба подключены
	s := snapshot(g)
	if len(s.Employees) != 2 {
		t.Fatalf("employees в снапшоте: %d, хотим 2", len(s.Employees))
	}
	if s.Employees[0].Name != "Анна Иванова" || s.Employees[0].IncomePerTick != 12 || !s.Employees[0].Connected {
		t.Errorf("первый сотрудник: %+v", s.Employees[0])
	}
	if !s.Employees[1].Connected {
		t.Errorf("второй сотрудник должен быть в сети: %+v", s.Employees[1])
	}
}
```

`server/internal/ws/session_test.go` — в `testMessage` заменить `Employees int` на:

```go
	Employees []struct {
		Name          string `json:"name"`
		IncomePerTick int    `json:"incomePerTick"`
	} `json:"employees"`
```

и все проверки `m.Employees == 1` → `len(m.Employees) == 1`, `m.Employees != 1` → `len(m.Employees) != 1`, `m.Employees == 0` → `len(m.Employees) == 0`. В `TestSessionBankruptcyAndRestart` после подтверждения найма добавить:

```go
	if e := first.Employees[0]; e.Name == "" || e.IncomePerTick < 9 || e.IncomePerTick > 14 {
		t.Fatalf("нанятый сотрудник в снапшоте подозрителен: %+v", e)
	}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/ws/`
Expected: FAIL — compile errors (нет `s.Employees` как среза, нет `Clock` и т.д.)

- [ ] **Step 3: Реализация**

`server/internal/ws/protocol.go` — в `stateMessage` заменить строки `Employees int` и `Connected int` на поле-срез, добавить новые поля (итог полей между `RouterTier` и `OfficeSlots`):

```go
	RouterTier       int            `json:"routerTier"`
	Ports            int            `json:"ports"`
	Servers          int            `json:"servers"`
	Multiplier       float64        `json:"multiplier"`
	IncomePerTick    int            `json:"incomePerTick"`
	Employees        []employeeInfo `json:"employees"` // порядок = порядок найма
	Day              int            `json:"day"`
	DayTicks         int            `json:"dayTicks"`
	DayProgress      int            `json:"dayProgress"` // тиков прошло в текущем дне
	Clock            string         `json:"clock"`   // «12:30»
	IsLunch          bool           `json:"isLunch"` // обед: доход за тик = 0
	TicksPerHour     int            `json:"ticksPerHour"`
	PayrollPerDay    int            `json:"payrollPerDay"`
	SalaryPerDay     int            `json:"salaryPerDay"`
	ForecastEndOfDay int            `json:"forecastEndOfDay"` // прогноз баланса на конец дня
	StaffLimit       int            `json:"staffLimit"`
	Phase            string         `json:"phase"` // running | day_report | game_over
```

Добавить тип:

```go
// employeeInfo — сотрудник в снапшоте: всё, что нужно тултипу.
type employeeInfo struct {
	Name          string `json:"name"`
	IncomePerTick int    `json:"incomePerTick"`
	Connected     bool   `json:"connected"`
}
```

В `snapshot()` заменить `Employees: g.Employees,` и удалить `Connected: g.Connected(),`, добавив:

```go
	employees := make([]employeeInfo, len(g.Employees))
	for i, e := range g.Employees {
		employees[i] = employeeInfo{Name: e.Name, IncomePerTick: e.IncomePerTick, Connected: i < g.Connected()}
	}
```

и в литерале `stateMessage`:

```go
		Employees:        employees,
		Clock:            g.Clock(),
		IsLunch:          g.IsLunch(),
		TicksPerHour:     cfg.TicksPerHour,
		SalaryPerDay:     cfg.SalaryPerDay,
		ForecastEndOfDay: g.ForecastEndOfDay(),
		StaffLimit:       cfg.StaffLimit,
```

(временные правки компиляции из Task 2 Step 8 при этом убрать).

- [ ] **Step 4: Тесты зелёные, race чистый**

Run: `cd server && go test -race ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/internal/ws/
git commit -m "feat(ws): массив сотрудников, часы и прогноз в снапшоте"
```

---

### Task 4: Клиент — протокол, сеть (техдолг), формат

**Files:**
- Modify: `client/src/protocol.ts`
- Modify: `client/src/net.ts`

**Interfaces:**
- Consumes: JSON-имена из Task 3.
- Produces: `EmployeeInfo {name, incomePerTick, connected}`; `StateMessage.employees: EmployeeInfo[]` (числовые `employees`/`connected` удалены), `clock/isLunch/ticksPerHour/salaryPerDay/forecastEndOfDay/staffLimit`; net.ts — явный матчинг `game_over` + console.error на неизвестный тип (техдолг ревью итерации 2).

- [ ] **Step 1: protocol.ts**

Заменить `StateMessage` целиком:

```ts
export interface EmployeeInfo {
  name: string
  incomePerTick: number
  connected: boolean
}

export interface StateMessage {
  type: 'state'
  money: number
  pcs: number
  routerTier: number
  ports: number
  servers: number
  multiplier: number
  incomePerTick: number
  employees: EmployeeInfo[]
  day: number
  dayTicks: number
  dayProgress: number
  clock: string
  isLunch: boolean
  ticksPerHour: number
  payrollPerDay: number
  salaryPerDay: number
  forecastEndOfDay: number
  staffLimit: number
  phase: 'running' | 'day_report' | 'game_over'
  officeSlots: number
  rackSlots: number
  prices: { pc: number; hire: number; server: number; nextRouter: number }
}
```

- [ ] **Step 2: net.ts — техдолг диспатча**

Заменить хвост диспатча в `onmessage`:

```ts
      } else if (msg.type === 'day_report') {
        this.listeners.forEach((l) => l.onDayReport?.(msg))
      } else if (msg.type === 'game_over') {
        this.listeners.forEach((l) => l.onGameOver?.(msg))
      } else {
        console.error('неизвестный тип сообщения от сервера', msg)
      }
```

- [ ] **Step 3: Typecheck (упадёт на сценах — это ожидаемо)**

Run: `cd client && npm run typecheck`
Expected: ошибки ТОЛЬКО в `HUDScene.ts`/`OfficeScene.ts` (используют старые `s.employees`/`s.connected` как числа) — они чинятся в Task 5-6. Если ошибки где-то ещё — чинить здесь. Зафиксировать список ошибок в отчёте.

- [ ] **Step 4: Commit**

```bash
git add client/src/protocol.ts client/src/net.ts
git commit -m "feat(client): протокол итерации 3 и жёсткий матчинг сообщений"
```

---

### Task 5: HUD — часы, обед, серверный прогноз, staff_limit

**Files:**
- Modify: `client/src/scenes/HUDScene.ts`

**Interfaces:**
- Consumes: `StateMessage` из Task 4.
- Produces: HUD без локальной формулы прогноза. Ничего внешнего.

- [ ] **Step 1: Реализация**

В `ERROR_TEXTS` добавить:

```ts
  staff_limit: 'Нужен начальник — офис уже занят',
```

Заменить `refresh()` (метод целиком):

```ts
  private refresh(s: StateMessage) {
    if (s.phase === 'running') {
      this.closeReport()
      this.closeGameOver()
    }
    const connected = s.employees.filter((e) => e.connected).length
    this.moneyText.setText(fmtMoney(s.money))
    this.incomeText.setText(`+${fmtMoney(s.incomePerTick)}/сек`)
    this.payrollText.setText(`Зарплата ${fmtMoney(s.payrollPerDay)}/день`)
    // Прогноз считает сервер: клиент не знает про обеденные тики.
    this.payrollText.setColor(s.forecastEndOfDay < 0 ? '#b13e53' : '#5d7275')
    this.dayText.setText(`День ${s.day} · ${s.clock}${s.isLunch ? ' · обед' : ''}`)
    this.netText.setText(`Сотрудники: ${s.employees.length} · в сети ${connected} · ×${s.multiplier.toFixed(1)}`)
    this.pcBtn.setLabel(`Купить ПК  ${fmtMoney(s.prices.pc)}`)
    this.hireBtn.setLabel(`Нанять  ${fmtMoney(s.prices.hire)}`)
    this.routerBtn.setLabel(s.prices.nextRouter > 0 ? `Роутер  ${fmtMoney(s.prices.nextRouter)}` : 'Роутер MAX')
    this.serverBtn.setLabel(`Сервер  ${fmtMoney(s.prices.server)}`)
  }
```

- [ ] **Step 2: Typecheck**

Run: `cd client && npm run typecheck`
Expected: остались ошибки только в `OfficeScene.ts` (Task 6). Если HUD чист — ок.

- [ ] **Step 3: Commit**

```bash
git add client/src/scenes/HUDScene.ts
git commit -m "feat(client): часы и обед в HUD, прогноз с сервера"
```

---

### Task 6: Офис — 12 слотов, закрытые места, обед, тултип

**Files:**
- Modify: `client/src/scenes/OfficeScene.ts`

**Interfaces:**
- Consumes: `StateMessage.employees/staffLimit/isLunch/ticksPerHour/salaryPerDay`, `fmtMoney`.
- Produces: тултип сотрудника (внутренний для сцены). Ничего внешнего.

- [ ] **Step 1: Реализация**

Заменить `client/src/scenes/OfficeScene.ts` целиком:

```ts
import Phaser from 'phaser'
import { fmtMoney } from '../format'
import { GAME_H, GAME_W, HUD_H } from '../layout'
import { client } from '../net'
import type { EmployeeInfo, StateMessage } from '../protocol'

const SCALE = 4 // 16px спрайт → 64px на экране
const GRID = { cols: 4, startX: 200, startY: 220, stepX: 270, stepY: 170 }
const LUNCH_SHIFT = 24 // на обеде сотрудник отходит от стола

export class OfficeScene extends Phaser.Scene {
  private objects: Phaser.GameObjects.GameObject[] = []
  private tooltip!: Phaser.GameObjects.Container
  private tooltipText!: Phaser.GameObjects.Text
  private tooltipBg!: Phaser.GameObjects.Rectangle
  // Слот под курсором: перерисовка идёт каждую секунду, и без этого
  // тултип гас бы на каждом снапшоте.
  private hoveredSlot = -1

  constructor() {
    super('office')
  }

  create() {
    // сцены перезапускаются при переключении комнат — сбрасываем ссылки прошлого цикла
    this.objects = []
    this.add.rectangle(0, HUD_H, GAME_W, GAME_H - HUD_H, 0x2b2f4a).setOrigin(0) // пол офиса
    this.add.text(GAME_W / 2, HUD_H + 20, 'ОФИС', {
      fontFamily: 'monospace', fontSize: '16px', color: '#5d7275',
    }).setOrigin(0.5)

    // Один переиспользуемый тултип поверх всего; наполняется при наведении.
    this.tooltipText = this.add.text(10, 8, '', {
      fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4', lineSpacing: 6,
    })
    this.tooltipBg = this.add.rectangle(0, 0, 10, 10, 0x14162b, 0.95).setOrigin(0).setStrokeStyle(1, 0x41a6f6)
    this.tooltip = this.add.container(0, 0, [this.tooltipBg, this.tooltipText]).setDepth(40).setVisible(false)

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
    this.hideTooltip() // спрайты пересоздаются — старая цель тултипа мертва
    this.objects.forEach((o) => o.destroy())
    this.objects = []

    // Специальный слот роутера: рабочее место сюда не поставить.
    const rx = GAME_W - 130
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

    // Рабочие места: первые pcs слотов — с ПК, дальше сотрудники из массива;
    // слоты за потолком штата закрыты до начальника.
    for (let i = 0; i < s.officeSlots; i++) {
      const x = GRID.startX + (i % GRID.cols) * GRID.stepX
      const y = GRID.startY + Math.floor(i / GRID.cols) * GRID.stepY
      if (i >= s.staffLimit) {
        this.objects.push(
          this.add.rectangle(x, y, 80, 64, 0x232640, 0.5).setStrokeStyle(2, 0x3a3f5c),
          this.add.text(x, y, 'нужен\nначальник', {
            fontFamily: 'monospace', fontSize: '10px', color: '#5d7275', align: 'center',
          }).setOrigin(0.5),
        )
        continue
      }
      this.objects.push(this.add.image(x, y, i < s.pcs ? 'desk_pc' : 'desk_empty').setScale(SCALE))
      const e = s.employees[i]
      if (e) {
        // На обеде сотрудник отходит от стола.
        const wx = s.isLunch ? x - 52 + LUNCH_SHIFT : x - 52
        const wy = s.isLunch ? y - 6 + LUNCH_SHIFT : y - 6
        const worker = this.add.image(wx, wy, 'worker').setScale(SCALE).setInteractive({ useHandCursor: true })
        worker.on('pointerover', () => {
          this.hoveredSlot = i
          this.showTooltip(e, s, wx, wy)
        })
        worker.on('pointerout', () => {
          this.hoveredSlot = -1
          this.hideTooltip()
        })
        this.objects.push(worker)
        // Спрайт пересоздан, а курсор не двигался — восстанавливаем тултип.
        if (this.hoveredSlot === i) this.showTooltip(e, s, wx, wy)
        if (e.connected) {
          this.objects.push(this.add.circle(x + 30, y - 30, 4, 0x38b764))
        }
      }
    }
  }

  private showTooltip(e: EmployeeInfo, s: StateMessage, x: number, y: number) {
    this.tooltipText.setText([
      e.name,
      `Выработка: ${fmtMoney(e.incomePerTick * s.ticksPerHour)}/час`,
      `Зарплата:  ${fmtMoney(s.salaryPerDay)}/день`,
    ].join('\n'))
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    // Не выпускаем тултип за правый край поля.
    const tx = Math.min(x + 40, GAME_W - this.tooltipBg.width - 8)
    this.tooltip.setPosition(tx, y - 20).setVisible(true)
  }

  private hideTooltip() {
    this.tooltip.setVisible(false)
  }
}
```

- [ ] **Step 2: Typecheck и ручная проверка**

Run: `cd client && npm run typecheck`
Expected: без ошибок (весь клиент чист).
Run: `make dev` — офис: 12 слотов в 4 колонки, последние 3 серые «нужен начальник»; наведение на сотрудника показывает тултип с именем/выработкой/зарплатой; в 14:00 сотрудники отходят от столов, HUD показывает «· обед», доход +$0/сек.

- [ ] **Step 3: Commit**

```bash
git add client/src/scenes/OfficeScene.ts
git commit -m "feat(client): офис 12 слотов, обед и тултип сотрудника"
```

---

### Task 7: Серверный техдолг — Apply-гейтинг из game_over, лимит readUntil

**Files:**
- Modify: `server/internal/game/day_test.go`
- Modify: `server/internal/ws/session_test.go:203-214` (функция `readUntil`)

**Interfaces:**
- Consumes: существующий код; ничего нового не производит.

- [ ] **Step 1: Тест гейтинга из game_over (сразу зелёный — закрытие пробела)**

В `server/internal/game/day_test.go` добавить:

```go
func TestApplyPhaseGatingGameOver(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 10000
	g.Phase = PhaseGameOver
	for _, cmd := range []Command{CmdBuyPC, CmdHire, CmdBuyRouter, CmdBuyServer, CmdNextDay} {
		if err := g.Apply(cmd); err != ErrWrongPhase {
			t.Errorf("Apply(%s) в game_over: err = %v, хотим %v", cmd, err, ErrWrongPhase)
		}
	}
	if err := g.Apply(CmdRestart); err != nil {
		t.Errorf("Apply(restart) в game_over: %v", err)
	}
}
```

- [ ] **Step 2: Лимит итераций readUntil**

В `server/internal/ws/session_test.go` заменить тело цикла `readUntil`:

```go
	for i := 0; i < 1000; i++ {
		var msg testMessage
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			t.Fatalf("readUntil: %v", err)
		}
		if ok(msg) {
			return msg
		}
	}
	t.Fatal("readUntil: 1000 сообщений без совпадения")
	return testMessage{}
```

- [ ] **Step 3: Тесты зелёные с race**

Run: `cd server && go test -race ./...`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/
git commit -m "test: гейтинг Apply из game_over и лимит readUntil"
```

---

### Task 8: Живая проверка протокола

**Files:**
- Modify: `scripts/live-check.mjs`

**Interfaces:**
- Consumes: весь протокол итерации 3. Node ≥ 22.

- [ ] **Step 1: Обновить скрипт**

Заменить `scripts/live-check.mjs` целиком:

```js
// Живая проверка протокола итерации 3 против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем node scripts/live-check.mjs
// Ждёт настоящий конец дня (~54 сек) — осознанно: проверяем прод-тайминги.
const FIELDS = [
  'money', 'pcs', 'routerTier', 'ports', 'servers', 'multiplier', 'incomePerTick',
  'employees', 'day', 'dayTicks', 'dayProgress', 'clock', 'isLunch', 'ticksPerHour',
  'payrollPerDay', 'salaryPerDay', 'forecastEndOfDay', 'staffLimit',
  'phase', 'officeSlots', 'rackSlots', 'prices',
]
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

const ws = new WebSocket('ws://localhost:8091/ws')
const timeout = setTimeout(() => fail('таймаут 90с', { phase }), 90_000)
ws.onclose = () => fail('соединение закрылось до конца проверки', { phase })
let phase = 'start'

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (phase === 'start' && m.type === 'state') {
    const missing = FIELDS.filter((f) => !(f in m))
    if (missing.length) fail('нет полей снапшота', missing)
    ok(`снапшот: все ${FIELDS.length} полей на месте`)
    if (m.phase !== 'running' || m.day !== 1 || m.clock !== '10:00' || m.dayTicks !== 54) {
      fail('старт: фаза/день/часы', m)
    }
    ok('старт: running, день 1, 10:00, день 54 тика')
    ws.send(JSON.stringify({ type: 'hire' }))
    phase = 'hired'
  } else if (phase === 'hired' && m.type === 'state' && m.employees.length === 1) {
    const e = m.employees[0]
    if (m.payrollPerDay !== 250 || !e.name || e.incomePerTick < 9 || e.incomePerTick > 14) {
      fail('нанятый сотрудник', { payroll: m.payrollPerDay, e })
    }
    ok(`найм: ${e.name}, $${e.incomePerTick}/тик, зарплата 250`)
    ws.send(JSON.stringify({ type: 'next_day' })) // вне фазы отчёта — ждём ошибку
    phase = 'wrong_phase'
  } else if (phase === 'wrong_phase' && m.type === 'error') {
    if (m.code !== 'wrong_phase') fail('код ошибки next_day в running', m.code)
    ok('next_day в running: error wrong_phase')
    phase = 'wait_lunch'
    console.log('… ждём обеда (~24 сек) и конца дня (~54 сек)')
  } else if (phase === 'wait_lunch' && m.type === 'state' && m.isLunch) {
    if (m.incomePerTick !== 0) fail('в обед доход за тик не 0', m.incomePerTick)
    ok(`обед в ${m.clock}: доход 0`)
    phase = 'wait_report'
  } else if (phase === 'wait_report' && m.type === 'day_report') {
    if (m.day !== 1 || m.payroll !== 250) fail('отчёт дня', m)
    ok(`отчёт дня 1: income=${m.income} payroll=${m.payroll} balance=${m.balance}`)
    ws.send(JSON.stringify({ type: 'next_day' }))
    phase = 'day2'
  } else if (phase === 'day2' && m.type === 'state' && m.day === 2 && m.phase === 'running') {
    ok('next_day: день 2 запущен, время ' + m.clock)
    clearTimeout(timeout)
    console.log('ПРОТОКОЛ ОК')
    process.exit(0)
  }
}
ws.onerror = () => fail('WebSocket error — сервер запущен на :8091?', null)
```

- [ ] **Step 2: Прогнать**

```bash
cd server && go run ./cmd/server -addr :8091 &
sleep 1
node ../scripts/live-check.mjs
kill %1 2>/dev/null; pkill -f 'exe/server' 2>/dev/null; true
```

Expected: `ok 1 … ok 7`, `ПРОТОКОЛ ОК` (~60 сек). Не оставлять процессов.

- [ ] **Step 3: Commit**

```bash
git add scripts/live-check.mjs
git commit -m "test: живая проверка протокола итерации 3"
```

---

### Task 9: README, полный прогон

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

Обновить блок про игровой день: день идёт 10:00–19:00 (54 сек, 1 час = 6 сек) с обедом 14:00–15:00 без заработка; у сотрудников имена и личная выработка $9–14/тик (тултип по наведению); офис 12 слотов, но штат больше 9 — только с начальником (итерация 4).

- [ ] **Step 2: Полный прогон**

```bash
make test && make typecheck
cd server && go test -race -count=1 ./... && go vet ./... && cd ..
make build
./bin/itdirector -static client/dist -addr :8087 &
sleep 1
curl -sf http://localhost:8087/ | head -3
kill %1
```

Expected: всё зелёное, статика отдаётся, процессов не осталось.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README итерации 3"
```

После этого — браузерный смоук контроллера (тултип, обед, закрытые слоты), финальное ревью ветки и плейтест пользователя (критерий из спеки: часы читаются, тултипы работают, найм-лотерея ощущается).
