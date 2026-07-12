# Итерация 4: три офиса, начальники, шлюз, неполный день — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Компания из трёх офисов (покупаются последовательно, $15k/$40k), начальник в каждом офисе открывает слоты 10–12 ($1,000 + $500/день, не производит), шлюз в интернет (×1.2 подключённым, $3,000 + $1/день опекса), зарплата за неполный день, левая панель навигации.

**Architecture:** Домен перестраивается: `Game.Offices []Office` (свои слоты/роутер/босс на офис), серверная и шлюз общие. Команды получают адресата-офис (`{"type":"hire","office":1}`), `Apply(cmd, office)`. Протокол ломается: снапшот несёт массив `offices`, мёртвые `dayTicks`/`dayProgress` удаляются. Клиент: панель навигации слева в HUD-сцене, `OfficeScene` рендерит активный офис, общий мутируемый `nav.activeOffice`. Спека: `docs/superpowers/specs/2026-07-12-iteration-4-design.md`.

**Tech Stack:** Go (math/rand/v2, coder/websocket), TypeScript + Phaser 3 + Vite.

## Global Constraints

- Ветка `iteration-4` от `main` (создать перед Task 1: `git checkout -b iteration-4`).
- Комментарии — по-русски в стиле файлов; коммиты — conventional commits по-русски.
- Числа ТОЛЬКО в `config.go` / GDD «Экономика»: офисов 3; офис 2 — $15,000, офис 3 — $40,000 (пустые, последовательно); начальник — $1,000 найм, $500/день, не производит, открывает слоты 10–12 СВОЕГО офиса; шлюз — $3,000, опекс $1/день, эффект ×1.2 только подключённым поверх серверов; неполный день — найм с 15:00 (`LunchEnd`) без зарплаты в день найма.
- Множитель подключённого: `(NetworkBase + ServerBonus×Servers) × (Gateway ? GatewayBonus : 1)`, округление на сотрудника. Подключение по-офисно (порты роутера офиса).
- Коды ошибок = значения `Err`: новые `office_locked`, `boss_already`, `offices_maxed`, `gateway_already`, `bad_office`.
- Протокол зеркалится protocol.go ↔ protocol.ts; из снапшота УДАЛЯЮТСЯ `dayTicks`, `dayProgress`, плоские `pcs/routerTier/ports/employees`; `officeSlots` (12) остаётся общим.
- Домен НЕ потокобезопасен; в сокет пишет только горутина `run`.
- Деньги в UI — через `fmtMoney`; HUD-подпись «Зарплата» → «Расходы».
- Серверные тесты `go test ./...`; перед коммитами задач 4 и 10 — `-race`. Клиент: `npm run typecheck`.

---

### Task 1: Домен — Office, доход по офисам, множитель со шлюзом

**Files:**
- Create: `server/internal/game/office.go`
- Modify: `server/internal/game/config.go`, `server/internal/game/game.go`
- Modify (миграция тестов): `game_test.go`, `day_test.go`, `clock_test.go`, `employee_test.go`
- Modify (компиляция, временно): `server/internal/ws/protocol.go`
- Test: `server/internal/game/office_test.go` (новый)

**Interfaces:**
- Produces: `type Office struct { Unlocked bool; PCs int; Employees []Employee; RouterTier int; Boss string; BossUnpaidToday bool }`; методы `(o *Office) Ports(cfg Config) int`, `(o *Office) Connected(cfg Config) int`, `(o *Office) StaffCap(cfg Config) int` (9 без босса, 12 с боссом); `Game.Offices []Office` (len 3, офис 0 открыт с 1 ПК); `Game.Gateway bool`; `(*Game).Multiplier() float64` — компания: `(NetworkBase+ServerBonus×Servers)×(Gateway?GatewayBonus:1)`; доход = Σ открытых офисов. Конфиг: `OfficePrices []int{15000,40000}`, `BossPrice 1000`, `BossSalaryPerDay 500`, `GatewayPrice 3000`, `GatewayOpexPerDay 1`, `GatewayBonus 1.2`. Поля `Game.PCs/Employees/RouterTier` УДАЛЕНЫ.
- Employee получает поле `UnpaidToday bool` (логика — в Task 3, тут только поле).

- [ ] **Step 1: Написать падающие тесты**

Создать `server/internal/game/office_test.go`:

```go
package game

import "testing"

func TestNewGameOffices(t *testing.T) {
	g := New(DefaultConfig())
	if len(g.Offices) != 3 {
		t.Fatalf("офисов %d, хотим 3", len(g.Offices))
	}
	if !g.Offices[0].Unlocked || g.Offices[0].PCs != 1 {
		t.Errorf("офис 0 должен быть открыт с 1 ПК: %+v", g.Offices[0])
	}
	if g.Offices[1].Unlocked || g.Offices[2].Unlocked {
		t.Errorf("офисы 1-2 должны быть закрыты")
	}
	if g.Gateway {
		t.Errorf("шлюза на старте нет")
	}
}

func TestOfficeConnected(t *testing.T) {
	cfg := DefaultConfig()
	o := Office{Unlocked: true, RouterTier: 1, Employees: testStaff(6)} // 4 порта
	if c := o.Connected(cfg); c != 4 {
		t.Errorf("Connected = %d, хотим 4", c)
	}
	o.RouterTier = 0
	if c := o.Connected(cfg); c != 0 {
		t.Errorf("без роутера Connected = %d, хотим 0", c)
	}
}

func TestOfficeStaffCap(t *testing.T) {
	cfg := DefaultConfig()
	o := Office{Unlocked: true}
	if cap := o.StaffCap(cfg); cap != 9 {
		t.Errorf("без босса потолок %d, хотим 9", cap)
	}
	o.Boss = "Иван Иванов"
	if cap := o.StaffCap(cfg); cap != 12 {
		t.Errorf("с боссом потолок %d, хотим 12", cap)
	}
}

func TestIncomeAcrossOffices(t *testing.T) {
	g := New(DefaultConfig())
	g.Servers = 2 // база множителя 1.0+0.5×2 = ×2.0
	g.Offices[0] = Office{Unlocked: true, PCs: 2, RouterTier: 1,
		Employees: []Employee{{Name: "А Б", IncomePerTick: 10}, {Name: "В Г", IncomePerTick: 12}}}
	g.Offices[1] = Office{Unlocked: true, PCs: 1,
		Employees: []Employee{{Name: "Д Е", IncomePerTick: 14}}} // без роутера: серверы не достаются
	g.TickInDay = 0
	// офис 0: (10+12)×2.0 = 44; офис 1: 14 без множителя. Итого 58.
	if inc := g.IncomePerTick(); inc != 58 {
		t.Errorf("доход по офисам = %d, хотим 58", inc)
	}
	// Шлюз: подключённым ещё ×1.2 → офис 0: round(10×2.4)+round(12×2.4)=24+29=53; офис 1: 14. Итого 67.
	g.Gateway = true
	if inc := g.IncomePerTick(); inc != 67 {
		t.Errorf("доход со шлюзом = %d, хотим 67", inc)
	}
}

func TestLockedOfficeNoIncome(t *testing.T) {
	g := New(DefaultConfig())
	g.Offices[1].Employees = testStaff(3) // закрытый офис — защита от рассинхрона
	if inc := g.IncomePerTick(); inc != 0 {
		t.Errorf("закрытый офис не должен приносить доход: %d", inc)
	}
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — compile errors (`g.Offices` undefined и т.д.)

- [ ] **Step 3: office.go**

```go
package game

// Office — один офис компании: свои рабочие места, роутер и начальник.
// Серверная и шлюз — общие на компанию (в Game).
type Office struct {
	Unlocked        bool
	PCs             int // первые len(Employees) заняты сотрудниками
	Employees       []Employee
	RouterTier      int    // 0 — роутера нет; 1..len(cfg.RouterTiers)
	Boss            string // имя начальника; "" — не нанят
	BossUnpaidToday bool   // босс нанят после обеда: сегодня без оплаты
}

// Ports — сколько рабочих мест офиса роутер подключает к сети.
func (o *Office) Ports(cfg Config) int {
	if o.RouterTier == 0 {
		return 0
	}
	return cfg.RouterTiers[o.RouterTier-1].Ports
}

// Connected — сколько сотрудников офиса в сети: первые N занятых мест.
func (o *Office) Connected(cfg Config) int {
	return min(o.Ports(cfg), len(o.Employees))
}

// StaffCap — потолок штата офиса: 9 мест, начальник открывает все 12.
func (o *Office) StaffCap(cfg Config) int {
	if o.Boss != "" {
		return cfg.OfficeSlots
	}
	return cfg.StaffLimit
}
```

- [ ] **Step 4: Конфиг**

В `Config` после `SalaryPerDay`:

```go
	BossPrice         int     // найм начальника
	BossSalaryPerDay  int     // зарплата начальника (не производит)
	OfficePrices      []int   // цены офисов 2 и 3 (покупаются последовательно, пустыми)
	GatewayPrice      int     // шлюз в интернет, один на компанию
	GatewayOpexPerDay int     // операционный расход шлюза, $/день
	GatewayBonus      float64 // множитель шлюза подключённым (поверх серверов)
```

В `DefaultConfig()`:

```go
		BossPrice:         1000,
		BossSalaryPerDay:  500,
		OfficePrices:      []int{15000, 40000},
		GatewayPrice:      3000,
		GatewayOpexPerDay: 1,
		GatewayBonus:      1.2,
```

- [ ] **Step 5: game.go — Offices вместо плоских полей**

В `Game` заменить блок `PCs/Employees/RouterTier/Servers` на:

```go
	Offices []Office
	Servers int
	Gateway bool // шлюз в интернет: ×GatewayBonus подключённым, опекс $/день
```

`Employee` — добавить поле:

```go
	UnpaidToday bool // нанят после обеда: в ФОТ текущего дня не входит
```

`NewWithSeed` — вместо `PCs: cfg.StartPCs`:

```go
	g := &Game{
		cfg:   cfg,
		rng:   rand.New(rand.NewPCG(s1, s2)),
		Money: cfg.StartMoney, Phase: PhaseRunning, Day: 1,
		Offices: make([]Office, 3),
	}
	g.Offices[0] = Office{Unlocked: true, PCs: cfg.StartPCs}
	return g
```

УДАЛИТЬ методы `Ports()`, `Connected()` с Game (переехали в Office). Заменить `Multiplier` и доход:

```go
// Multiplier — множитель компании для подключённых рабочих мест:
// серверы дают базу, шлюз умножает её ещё раз. Применяется только
// подключённым (подключение по-офисно, см. Office.Connected).
func (g *Game) Multiplier() float64 {
	m := g.cfg.NetworkBase + g.cfg.ServerBonus*float64(g.Servers)
	if g.Gateway {
		m *= g.cfg.GatewayBonus
	}
	return m
}
```

```go
// incomePotentialPerTick — доход за продуктивный тик по всем открытым
// офисам: первые Connected() сотрудников офиса — с множителем компании.
func (g *Game) incomePotentialPerTick() int {
	mult := g.Multiplier()
	total := 0
	for oi := range g.Offices {
		o := &g.Offices[oi]
		if !o.Unlocked {
			continue
		}
		connected := o.Connected(g.cfg)
		for i, e := range o.Employees {
			if i < connected {
				total += int(math.Round(float64(e.IncomePerTick) * mult))
			} else {
				total += e.IncomePerTick
			}
		}
	}
	return total
}
```

(`PayrollPerDay`/`ForecastEndOfDay` временно: `PayrollPerDay` = Σ по открытым офисам `len(Employees)×SalaryPerDay` — полная версия с боссами/опексом в Task 3.)

```go
// PayrollPerDay — дневные расходы на людей (боссы и опекс — Task 3).
func (g *Game) PayrollPerDay() int {
	total := 0
	for i := range g.Offices {
		total += len(g.Offices[i].Employees) * g.cfg.SalaryPerDay
	}
	return total
}
```

- [ ] **Step 6: Миграция тестов домена**

Механическая замена по всем `_test.go` пакета game (хелпер `testStaff` не меняется):
- `g.PCs = N` → `g.Offices[0].PCs = N`; `g.Employees = X` → `g.Offices[0].Employees = X`; `g.RouterTier = N` → `g.Offices[0].RouterTier = N`; проверки `len(g.Employees)` → `len(g.Offices[0].Employees)`, `g.PCs` → `g.Offices[0].PCs` и т.д.
- `g.Connected()` → `g.Offices[0].Connected(DefaultConfig())` (в TestIncome — офисный Connected).
- `g.Multiplier()` в TestIncome: множитель теперь НЕ зависит от роутера (он общий), а вот подключённых без роутера ноль — кейсы таблицы обновить: `wantMultiplier` при `servers=0` = 1.0; при 2 серверах = 2.0; при 3 = 2.5 (роутер-тир на множитель не влияет; кейс «роутер без серверов множителя не даёт» остаётся с mult 1.0). Ожидаемые доходы не меняются.
- Команды (`BuyPC()` без аргумента и т.п.) в тестах пока НЕ трогать — Task 2 их переделает вместе с тестами команд; чтобы пакет компилировался, в этой задаче добавить методам текущие сигнатуры офис-независимые обёртки НЕ надо — вместо этого временно переписать тела `BuyPC/Hire/BuyRouter` на `o := &g.Offices[0]` (адресация — Task 2):

```go
// (временно, до Task 2: команды работают с офисом 0)
```
в `BuyPC`: `o := &g.Offices[0]` и далее `o.PCs`, `o.StaffCap(g.cfg)`, `cfg.OfficeSlots`; в `Hire`: `o.Employees`, `o.PCs`; в `BuyRouter`: `o.RouterTier`. `NextRouterPrice()` — тоже офис 0 временно.

- [ ] **Step 7: Временная компиляция ws**

`server/internal/ws/protocol.go` — минимально: `PCs: g.Offices[0].PCs`, `RouterTier: g.Offices[0].RouterTier`, `Ports: g.Offices[0].Ports(cfg)`, employees-цикл по `g.Offices[0].Employees`, `Connected` из `g.Offices[0].Connected(cfg)`. `go build ./...` обязан собираться; тесты ws могут падать ассертами — это чинит Task 4, зафиксировать в отчёте.

- [ ] **Step 8: Тесты зелёные**

Run: `cd server && go test ./internal/game/ && go build ./...`
Expected: game PASS, build OK.

- [ ] **Step 9: Commit**

```bash
git add server/
git commit -m "feat(game): офисы списком, доход по офисам, множитель со шлюзом"
```

---

### Task 2: Домен — команды с адресатом-офисом

**Files:**
- Modify: `server/internal/game/commands.go`
- Test: `server/internal/game/commands_test.go` (новый; переносит и адаптирует тесты команд из game_test.go), правки `game_test.go`

**Interfaces:**
- Consumes: `Office`, `StaffCap`, конфиг Task 1.
- Produces: ошибки `ErrOfficeLocked=Err("office_locked")`, `ErrBossAlready=Err("boss_already")`, `ErrOfficesMaxed=Err("offices_maxed")`, `ErrGatewayAlready=Err("gateway_already")`, `ErrBadOffice=Err("bad_office")`; команды `CmdHireBoss=Command("hire_boss")`, `CmdBuyOffice=Command("buy_office")`, `CmdBuyGateway=Command("buy_gateway")`; сигнатуры: `BuyPC(office int) error`, `Hire(office int) error`, `BuyRouter(office int) error`, `HireBoss(office int) error`, `BuyOffice(office int) error`, `BuyGateway() error`, `Apply(cmd Command, office int) error`; `NextRouterPrice(office int) int`.

- [ ] **Step 1: Написать падающие тесты**

Создать `server/internal/game/commands_test.go`:

```go
package game

import "testing"

// unlockedGame — игра с деньгами и открытым офисом 1 для тестов адресации.
func unlockedGame(money int) *Game {
	g := New(DefaultConfig())
	g.Money = money
	return g
}

func TestOfficeCommandValidation(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.BuyPC(-1); err != ErrBadOffice {
		t.Errorf("office=-1: %v, хотим %v", err, ErrBadOffice)
	}
	if err := g.BuyPC(3); err != ErrBadOffice {
		t.Errorf("office=3: %v, хотим %v", err, ErrBadOffice)
	}
	if err := g.Hire(1); err != ErrOfficeLocked {
		t.Errorf("найм в закрытый офис: %v, хотим %v", err, ErrOfficeLocked)
	}
	if err := g.BuyRouter(1); err != ErrOfficeLocked {
		t.Errorf("роутер в закрытый офис: %v, хотим %v", err, ErrOfficeLocked)
	}
}

func TestHireBoss(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.HireBoss(0); err != nil {
		t.Fatalf("найм босса: %v", err)
	}
	if g.Offices[0].Boss == "" {
		t.Error("имя босса не роллнулось")
	}
	if g.Money != 100000-1000 {
		t.Errorf("Money = %d, хотим 99000", g.Money)
	}
	if err := g.HireBoss(0); err != ErrBossAlready {
		t.Errorf("второй босс: %v, хотим %v", err, ErrBossAlready)
	}
	g2 := unlockedGame(500)
	if err := g2.HireBoss(0); err != ErrNotEnoughMoney {
		t.Errorf("босс без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
}

func TestBossOpensSlots(t *testing.T) {
	g := unlockedGame(100000)
	g.Offices[0].PCs = 9
	g.Offices[0].Employees = testStaff(9)
	if err := g.Hire(0); err != ErrStaffLimit {
		t.Fatalf("10-й найм без босса: %v, хотим %v", err, ErrStaffLimit)
	}
	if err := g.BuyPC(0); err != ErrStaffLimit {
		t.Fatalf("10-й ПК без босса: %v, хотим %v", err, ErrStaffLimit)
	}
	if err := g.HireBoss(0); err != nil {
		t.Fatal(err)
	}
	if err := g.BuyPC(0); err != nil {
		t.Errorf("10-й ПК с боссом: %v", err)
	}
	if err := g.Hire(0); err != nil {
		t.Errorf("10-й найм с боссом: %v", err)
	}
}

func TestBuyOffice(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.BuyOffice(2); err != ErrBadOffice {
		t.Errorf("покупка офиса 3 раньше офиса 2: %v, хотим %v", err, ErrBadOffice)
	}
	if err := g.BuyOffice(0); err != ErrBadOffice {
		t.Errorf("покупка уже открытого: %v, хотим %v", err, ErrBadOffice)
	}
	if err := g.BuyOffice(1); err != nil {
		t.Fatalf("покупка офиса 2: %v", err)
	}
	if !g.Offices[1].Unlocked || g.Offices[1].PCs != 0 || g.Offices[1].RouterTier != 0 {
		t.Errorf("офис 2 должен открыться пустым: %+v", g.Offices[1])
	}
	if g.Money != 100000-15000 {
		t.Errorf("Money = %d, хотим 85000", g.Money)
	}
	if err := g.BuyOffice(2); err != nil {
		t.Fatalf("покупка офиса 3: %v", err)
	}
	if g.Money != 85000-40000 {
		t.Errorf("Money = %d, хотим 45000", g.Money)
	}
	if err := g.BuyOffice(2); err != ErrOfficesMaxed {
		t.Errorf("все куплены: %v, хотим %v", err, ErrOfficesMaxed)
	}
	g2 := unlockedGame(100)
	if err := g2.BuyOffice(1); err != ErrNotEnoughMoney {
		t.Errorf("офис без денег: %v, хотим %v", err, ErrNotEnoughMoney)
	}
}

func TestBuyGateway(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.BuyGateway(); err != nil {
		t.Fatalf("шлюз: %v", err)
	}
	if !g.Gateway || g.Money != 100000-3000 {
		t.Errorf("Gateway=%v Money=%d, хотим true и 97000", g.Gateway, g.Money)
	}
	if err := g.BuyGateway(); err != ErrGatewayAlready {
		t.Errorf("второй шлюз: %v, хотим %v", err, ErrGatewayAlready)
	}
}

func TestApplyWithOffice(t *testing.T) {
	g := unlockedGame(100000)
	if err := g.Apply(CmdHire, 0); err != nil {
		t.Fatalf("Apply(hire, 0): %v", err)
	}
	if len(g.Offices[0].Employees) != 1 {
		t.Error("Apply(hire) не нанял в офис 0")
	}
	if err := g.Apply(CmdHireBoss, 1); err != ErrOfficeLocked {
		t.Errorf("босс в закрытый офис: %v, хотим %v", err, ErrOfficeLocked)
	}
	if err := g.Apply(CmdBuyGateway, 99); err != nil {
		t.Errorf("buy_gateway игнорирует офис: %v", err)
	}
}
```

Из `game_test.go` УДАЛИТЬ старые табличные тесты команд `TestBuyPC`, `TestHire`, `TestBuyRouter`, `TestBuyServer`, `TestApply`, `TestNextRouterPrice` и добавить их адаптированные версии в `commands_test.go` (те же кейсы, вызовы с `(0)`, состояние через `g.Offices[0]`; кейс «офис полон» использует босса: `g.Offices[0].Boss = "Тест Босс"; g.Offices[0].PCs = 12` → `ErrNoFreeOfficeSlot`):

```go
func TestBuyPCTable(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*Game)
		wantErr   error
		wantPCs   int
		wantMoney int
	}{
		{"успех: деньги ровно по цене", func(g *Game) { g.Money = 500 }, nil, 2, 0},
		{"не хватает денег", func(g *Game) { g.Money = 499 }, ErrNotEnoughMoney, 1, 499},
		{"штат укомплектован без босса", func(g *Game) { g.Money = 10000; g.Offices[0].PCs = 9 }, ErrStaffLimit, 9, 10000},
		{"офис полон даже с боссом", func(g *Game) { g.Money = 10000; g.Offices[0].Boss = "Т Б"; g.Offices[0].PCs = 12 }, ErrNoFreeOfficeSlot, 12, 10000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyPC(0); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.Offices[0].PCs != tt.wantPCs || g.Money != tt.wantMoney {
				t.Errorf("PCs=%d Money=%d, хотим %d и %d", g.Offices[0].PCs, g.Money, tt.wantPCs, tt.wantMoney)
			}
		})
	}
}

func TestHireTable(t *testing.T) {
	tests := []struct {
		name          string
		setup         func(*Game)
		wantErr       error
		wantEmployees int
		wantMoney     int
	}{
		{"успех: есть свободный стартовый ПК", func(g *Game) { g.Money = 300 }, nil, 1, 0},
		{"нет свободного ПК", func(g *Game) { g.Money = 1000; g.Offices[0].Employees = testStaff(1) }, ErrNoFreePC, 1, 1000},
		{"не хватает денег", func(g *Game) { g.Money = 299 }, ErrNotEnoughMoney, 0, 299},
		{"нет ПК и денег: ПК проверяется первым", func(g *Game) { g.Money = 0; g.Offices[0].Employees = testStaff(1) }, ErrNoFreePC, 1, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.Hire(0); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if len(g.Offices[0].Employees) != tt.wantEmployees || g.Money != tt.wantMoney {
				t.Errorf("Employees=%d Money=%d, хотим %d и %d", len(g.Offices[0].Employees), g.Money, tt.wantEmployees, tt.wantMoney)
			}
		})
	}
}

func TestBuyRouterTable(t *testing.T) {
	tests := []struct {
		name      string
		setup     func(*Game)
		wantErr   error
		wantTier  int
		wantMoney int
	}{
		{"тир 1 за $800", func(g *Game) { g.Money = 800 }, nil, 1, 0},
		{"апгрейд до тира 2 за $2500", func(g *Game) { g.Money = 2500; g.Offices[0].RouterTier = 1 }, nil, 2, 0},
		{"выше тира 2 нельзя", func(g *Game) { g.Money = 99999; g.Offices[0].RouterTier = 2 }, ErrRouterMaxed, 2, 99999},
		{"не хватает денег", func(g *Game) { g.Money = 799 }, ErrNotEnoughMoney, 0, 799},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g := New(DefaultConfig())
			tt.setup(g)
			if err := g.BuyRouter(0); err != tt.wantErr {
				t.Fatalf("err = %v, хотим %v", err, tt.wantErr)
			}
			if g.Offices[0].RouterTier != tt.wantTier || g.Money != tt.wantMoney {
				t.Errorf("RouterTier=%d Money=%d, хотим %d и %d", g.Offices[0].RouterTier, g.Money, tt.wantTier, tt.wantMoney)
			}
		})
	}
}

func TestBuyServerTable(t *testing.T) {
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

func TestNextRouterPricePerOffice(t *testing.T) {
	g := New(DefaultConfig())
	if p := g.NextRouterPrice(0); p != 800 {
		t.Errorf("без роутера цена = %d, хотим 800", p)
	}
	g.Offices[0].RouterTier = 2
	if p := g.NextRouterPrice(0); p != 0 {
		t.Errorf("на максимальном тире цена = %d, хотим 0", p)
	}
}

func TestApplyUnknownAndPhase(t *testing.T) {
	g := New(DefaultConfig())
	if err := g.Apply(Command("dance"), 0); err != ErrUnknownCommand {
		t.Errorf("неизвестная команда: %v, хотим %v", err, ErrUnknownCommand)
	}
	g.Phase = PhaseDayReport
	for _, cmd := range []Command{CmdBuyPC, CmdHire, CmdBuyRouter, CmdBuyServer, CmdHireBoss, CmdBuyOffice, CmdBuyGateway} {
		if err := g.Apply(cmd, 0); err != ErrWrongPhase {
			t.Errorf("Apply(%s) в day_report: %v, хотим %v", cmd, err, ErrWrongPhase)
		}
	}
}
```

(Также обновить `TestApplyPhaseGating`/`TestApplyPhaseGatingGameOver` в day_test.go: `g.Apply(cmd, 0)`, список команд как в TestApplyUnknownAndPhase.)

- [ ] **Step 2: RED**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — compile errors.

- [ ] **Step 3: Реализация commands.go**

Ошибки — добавить:

```go
	ErrOfficeLocked   = Err("office_locked")
	ErrBossAlready    = Err("boss_already")
	ErrOfficesMaxed   = Err("offices_maxed")
	ErrGatewayAlready = Err("gateway_already")
	ErrBadOffice      = Err("bad_office")
```

Команды — добавить:

```go
	CmdHireBoss   = Command("hire_boss")
	CmdBuyOffice  = Command("buy_office")
	CmdBuyGateway = Command("buy_gateway")
```

Хелпер адресации и переписанные команды:

```go
// office проверяет адресата офисной команды: индекс и открытость.
func (g *Game) office(idx int) (*Office, error) {
	if idx < 0 || idx >= len(g.Offices) {
		return nil, ErrBadOffice
	}
	o := &g.Offices[idx]
	if !o.Unlocked {
		return nil, ErrOfficeLocked
	}
	return o, nil
}

// BuyPC ставит новый ПК в свободный слот офиса. Слоты сверх потолка
// штата открывает начальник офиса.
func (g *Game) BuyPC(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if o.PCs >= o.StaffCap(g.cfg) {
		return ErrStaffLimit
	}
	if o.PCs >= g.cfg.OfficeSlots {
		return ErrNoFreeOfficeSlot
	}
	if g.Money < g.cfg.PCPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.PCPrice
	o.PCs++
	return nil
}

// Hire сажает нового сотрудника за свободный ПК офиса: имя и выработка
// роллятся при найме и не меняются.
func (g *Game) Hire(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if len(o.Employees) >= o.StaffCap(g.cfg) {
		return ErrStaffLimit
	}
	if len(o.Employees) >= o.PCs {
		return ErrNoFreePC
	}
	if g.Money < g.cfg.HirePrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.HirePrice
	o.Employees = append(o.Employees, Employee{
		Name:          rollName(g.rng),
		IncomePerTick: g.cfg.IncomeMin + g.rng.IntN(g.cfg.IncomeMax-g.cfg.IncomeMin+1),
		UnpaidToday:   g.hiredAfterLunch(),
	})
	return nil
}

// BuyRouter покупает следующий тир роутера офиса (тир заменяет предыдущий).
func (g *Game) BuyRouter(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if o.RouterTier >= len(g.cfg.RouterTiers) {
		return ErrRouterMaxed
	}
	price := g.cfg.RouterTiers[o.RouterTier].Price
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.Money -= price
	o.RouterTier++
	return nil
}

// HireBoss нанимает начальника офиса: не производит, открывает слоты 10-12.
func (g *Game) HireBoss(office int) error {
	o, err := g.office(office)
	if err != nil {
		return err
	}
	if o.Boss != "" {
		return ErrBossAlready
	}
	if g.Money < g.cfg.BossPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.BossPrice
	o.Boss = rollName(g.rng)
	o.BossUnpaidToday = g.hiredAfterLunch()
	return nil
}

// BuyOffice открывает следующий закрытый офис (строго последовательно, пустым).
func (g *Game) BuyOffice(office int) error {
	next := -1
	for i := range g.Offices {
		if !g.Offices[i].Unlocked {
			next = i
			break
		}
	}
	if next == -1 {
		return ErrOfficesMaxed
	}
	if office != next {
		return ErrBadOffice
	}
	price := g.cfg.OfficePrices[next-1]
	if g.Money < price {
		return ErrNotEnoughMoney
	}
	g.Money -= price
	g.Offices[next].Unlocked = true
	return nil
}

// BuyGateway ставит шлюз в интернет (один на компанию).
func (g *Game) BuyGateway() error {
	if g.Gateway {
		return ErrGatewayAlready
	}
	if g.Money < g.cfg.GatewayPrice {
		return ErrNotEnoughMoney
	}
	g.Money -= g.cfg.GatewayPrice
	g.Gateway = true
	return nil
}

// NextRouterPrice — цена следующего тира роутера офиса; 0 на максимуме.
func (g *Game) NextRouterPrice(office int) int {
	tier := g.Offices[office].RouterTier
	if tier >= len(g.cfg.RouterTiers) {
		return 0
	}
	return g.cfg.RouterTiers[tier].Price
}
```

`hiredAfterLunch` — заглушка в этой задаче (полная семантика в Task 3):

```go
// hiredAfterLunch — найм после обеда: без зарплаты в день найма (Task 3).
func (g *Game) hiredAfterLunch() bool {
	return g.TickInDay >= (g.cfg.LunchEnd-g.cfg.WorkdayStart)*g.cfg.TicksPerHour
}
```

`Apply`:

```go
// Apply выполняет команду игрока; офисные команды адресуются индексом office.
func (g *Game) Apply(cmd Command, office int) error {
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
		return g.BuyPC(office)
	case CmdHire:
		return g.Hire(office)
	case CmdBuyRouter:
		return g.BuyRouter(office)
	case CmdHireBoss:
		return g.HireBoss(office)
	case CmdBuyOffice:
		return g.BuyOffice(office)
	case CmdBuyServer:
		return g.BuyServer()
	case CmdBuyGateway:
		return g.BuyGateway()
	default:
		return ErrUnknownCommand
	}
}
```

Сессия (`session.go`) пока зовёт `g.Apply(cmd)` — обновить вызов временно: `g.Apply(cmd, 0)` (полный парсинг office — Task 4); `readLoop` не трогать.

- [ ] **Step 4: GREEN**

Run: `cd server && go test ./internal/game/ && go build ./...`
Expected: PASS / OK.

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "feat(game): команды с адресатом-офисом, начальник, покупка офисов и шлюза"
```

---

### Task 3: Домен — расходы дня, неполный день, отчёт с опексом

**Files:**
- Modify: `server/internal/game/game.go`, `server/internal/game/commands.go` (NextDay)
- Test: `server/internal/game/expenses_test.go` (новый), правки `day_test.go`

**Interfaces:**
- Consumes: Task 1-2.
- Produces: `(*Game).PayrollPerDay() int` — полные дневные расходы: сотрудники ($250, кроме UnpaidToday) + боссы ($500, кроме BossUnpaidToday) + опекс шлюза ($1 при Gateway); `DayReport` += поле `GatewayOpex int` (Payroll в отчёте — люди без опекса); `NextDay()` сбрасывает все Unpaid-флаги; `Tick()` списывает `Payroll + GatewayOpex`.

- [ ] **Step 1: Написать падающие тесты**

Создать `server/internal/game/expenses_test.go`:

```go
package game

import "testing"

func TestPayrollWithBossAndGateway(t *testing.T) {
	g := New(DefaultConfig())
	g.Offices[0].Employees = testStaff(2) // 2×250
	g.Offices[0].Boss = "Т Б"             // +500
	g.Gateway = true                      // +1
	if p := g.PayrollPerDay(); p != 2*250+500+1 {
		t.Errorf("расходы = %d, хотим 1001", p)
	}
}

func TestUnpaidTodaySkipped(t *testing.T) {
	g := New(DefaultConfig())
	staff := testStaff(3)
	staff[1].UnpaidToday = true
	g.Offices[0].Employees = staff
	g.Offices[0].Boss = "Т Б"
	g.Offices[0].BossUnpaidToday = true
	if p := g.PayrollPerDay(); p != 2*250 {
		t.Errorf("расходы = %d, хотим 500 (без неоплачиваемых)", p)
	}
}

func TestHiredAfterLunchBoundary(t *testing.T) {
	g := New(DefaultConfig())
	g.Money = 100000
	g.Offices[0].PCs = 3
	g.TickInDay = 29 // 14:50 — ещё обед, платим полный день
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	g.TickInDay = 30 // 15:00 — после обеда, сегодня без оплаты
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].Employees[0].UnpaidToday {
		t.Error("нанятый в 14:50 должен получить зарплату")
	}
	if !g.Offices[0].Employees[1].UnpaidToday {
		t.Error("нанятый в 15:00 не должен получить зарплату сегодня")
	}
}

func TestNextDayResetsUnpaid(t *testing.T) {
	g := New(dayTestConfig())
	g.Offices[0].Employees = testStaff(1)
	g.Offices[0].Employees[0].UnpaidToday = true
	g.Offices[0].Boss = "Т Б"
	g.Offices[0].BossUnpaidToday = true
	g.Money = 100000
	for i := 0; i < dayTestConfig().DayTicks(); i++ {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.Offices[0].Employees[0].UnpaidToday || g.Offices[0].BossUnpaidToday {
		t.Error("NextDay должен сбросить флаги неполного дня")
	}
}

func TestRestartResetsOfficesAndGateway(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 0
	g.Gateway = true
	g.Offices[1] = Office{Unlocked: true, PCs: 3, Employees: testStaff(3), Boss: "Т Б"}
	for i := 0; i < dayTestConfig().DayTicks(); i++ {
		g.Tick()
	}
	if g.Phase != PhaseGameOver {
		t.Fatalf("подготовка: ждали game_over, Phase=%q", g.Phase)
	}
	if err := g.Restart(); err != nil {
		t.Fatal(err)
	}
	if g.Gateway || g.Offices[1].Unlocked || len(g.Offices[1].Employees) != 0 {
		t.Errorf("Restart не сбросил офисы/шлюз: %+v", g.Offices[1])
	}
	if !g.Offices[0].Unlocked || g.Offices[0].PCs != 1 {
		t.Errorf("офис 0 после Restart: %+v", g.Offices[0])
	}
}

func TestDayReportGatewayOpex(t *testing.T) {
	g := New(dayTestConfig())
	g.Money = 100000
	g.Offices[0].Employees = testStaff(1)
	g.Gateway = true
	var rep *DayReport
	for i := 0; i < dayTestConfig().DayTicks(); i++ {
		rep = g.Tick()
	}
	if rep == nil {
		t.Fatal("нет отчёта")
	}
	if rep.Payroll != 250 || rep.GatewayOpex != 1 {
		t.Errorf("Payroll=%d GatewayOpex=%d, хотим 250 и 1", rep.Payroll, rep.GatewayOpex)
	}
	// списано и то и другое
	if rep.Balance != 100000+rep.Income-250-1 {
		t.Errorf("Balance=%d не сходится", rep.Balance)
	}
}
```

- [ ] **Step 2: RED**

Run: `cd server && go test ./internal/game/`
Expected: FAIL — `GatewayOpex` undefined и т.д.

- [ ] **Step 3: Реализация**

`game.go` — заменить `PayrollPerDay` и хвост `Tick`, дополнить `DayReport`:

```go
// PayrollPerDay — полные дневные расходы: зарплаты сотрудников и боссов
// (кроме нанятых после обеда — им сегодня не платим) плюс опекс шлюза.
func (g *Game) PayrollPerDay() int {
	total := 0
	for i := range g.Offices {
		o := &g.Offices[i]
		for _, e := range o.Employees {
			if !e.UnpaidToday {
				total += g.cfg.SalaryPerDay
			}
		}
		if o.Boss != "" && !o.BossUnpaidToday {
			total += g.cfg.BossSalaryPerDay
		}
	}
	if g.Gateway {
		total += g.cfg.GatewayOpexPerDay
	}
	return total
}

// gatewayOpex — дневной опекс шлюза (0, если шлюза нет).
func (g *Game) gatewayOpex() int {
	if g.Gateway {
		return g.cfg.GatewayOpexPerDay
	}
	return 0
}
```

`DayReport`:

```go
type DayReport struct {
	Day         int
	Income      int
	Payroll     int // зарплаты людей (сотрудники + боссы)
	GatewayOpex int // операционный расход шлюза
	Profit      int
	Balance     int
}
```

Хвост `Tick()`:

```go
	expenses := g.PayrollPerDay()
	opex := g.gatewayOpex()
	payroll := expenses - opex
	g.Money -= expenses
	if g.Money < 0 {
		g.Phase = PhaseGameOver
	} else {
		g.Phase = PhaseDayReport
	}
	return &DayReport{Day: g.Day, Income: g.DayIncome, Payroll: payroll,
		GatewayOpex: opex, Profit: g.DayIncome - expenses, Balance: g.Money}
```

`commands.go` — в `NextDay()` перед `g.Phase = PhaseRunning`:

```go
	for i := range g.Offices {
		o := &g.Offices[i]
		for j := range o.Employees {
			o.Employees[j].UnpaidToday = false
		}
		o.BossUnpaidToday = false
	}
```

- [ ] **Step 4: GREEN**

Run: `cd server && go test ./internal/game/ && go build ./...`
Expected: PASS (старые day-тесты живы: без боссов/шлюза расходы = прежний ФОТ).

- [ ] **Step 5: Commit**

```bash
git add server/
git commit -m "feat(game): расходы дня с боссами и опексом, неполный день"
```

---

### Task 4: Протокол и сессия — offices-массив, адресация команд

**Files:**
- Modify: `server/internal/ws/protocol.go`, `server/internal/ws/session.go`
- Test: `server/internal/ws/protocol_test.go`, `server/internal/ws/session_test.go`

**Interfaces:**
- Consumes: домен Task 1-3.
- Produces (JSON, клиент зеркалит):
  - `clientMessage{type, office int}`; `readLoop` передаёт office в актор (канал становится `chan clientCommand{Cmd game.Command; Office int}`).
  - Снапшот: `offices: [{unlocked, price, pcs, routerTier, ports, nextRouter, boss, bossUnpaidToday, employees: [{name, incomePerTick, connected, unpaidToday}]}]` (price: цена покупки для закрытых, 0 для открытых); общие `servers`, `gateway` (bool), `multiplier`, `incomePerTick`, `clock`, `isLunch`, `ticksPerHour`, `payrollPerDay`, `salaryPerDay`, `bossSalaryPerDay`, `forecastEndOfDay`, `staffLimit`, `officeSlots`, `day`, `phase`, `money`, `rackSlots`, `prices: {pc, hire, server, boss, gateway}`. УДАЛЕНЫ: `dayTicks`, `dayProgress`, плоские `pcs/routerTier/ports/employees`, `prices.nextRouter`.
  - `day_report` += `gatewayOpex int`.

- [ ] **Step 1: Написать падающие тесты**

`protocol_test.go` — заменить целиком:

```go
package ws

import (
	"testing"

	"itdirector/internal/game"
)

func TestSnapshot(t *testing.T) {
	g := game.New(game.DefaultConfig())
	s := snapshot(g)
	if s.Type != "state" || s.Money != 600 || s.OfficeSlots != 12 || s.RackSlots != 3 {
		t.Errorf("базовые поля: %+v", s)
	}
	if len(s.Offices) != 3 {
		t.Fatalf("офисов в снапшоте %d, хотим 3", len(s.Offices))
	}
	if !s.Offices[0].Unlocked || s.Offices[0].PCs != 1 || s.Offices[0].Price != 0 || s.Offices[0].NextRouter != 800 {
		t.Errorf("офис 0: %+v", s.Offices[0])
	}
	if s.Offices[1].Unlocked || s.Offices[1].Price != 15000 || s.Offices[2].Price != 40000 {
		t.Errorf("закрытые офисы: %+v %+v", s.Offices[1], s.Offices[2])
	}
	if s.Gateway || s.Servers != 0 || s.Multiplier != 1.0 {
		t.Errorf("серверная: %+v", s)
	}
	if s.Prices.PC != 500 || s.Prices.Hire != 300 || s.Prices.Server != 2000 ||
		s.Prices.Boss != 1000 || s.Prices.Gateway != 3000 {
		t.Errorf("цены: %+v", s.Prices)
	}
	if s.Clock != "10:00" || s.IsLunch || s.StaffLimit != 9 || s.SalaryPerDay != 250 ||
		s.BossSalaryPerDay != 500 || s.TicksPerHour != 6 || s.ForecastEndOfDay != 600 ||
		s.Day != 1 || s.Phase != "running" || s.PayrollPerDay != 0 {
		t.Errorf("поля дня: %+v", s)
	}
}

func TestSnapshotOfficeDetails(t *testing.T) {
	g := game.New(game.DefaultConfig())
	g.Offices[0].PCs = 6
	g.Offices[0].RouterTier = 1
	g.Offices[0].Boss = "Босс Боссов"
	staff := make([]game.Employee, 6)
	for i := range staff {
		staff[i] = game.Employee{Name: "Тест Тестов", IncomePerTick: 10}
	}
	staff[5].UnpaidToday = true
	g.Offices[0].Employees = staff
	s := snapshot(g)
	o := s.Offices[0]
	if o.Boss != "Босс Боссов" || o.Ports != 4 || o.NextRouter != 2500 {
		t.Errorf("офис 0: %+v", o)
	}
	for i, e := range o.Employees {
		if want := i < 4; e.Connected != want {
			t.Errorf("сотрудник %d connected=%v, хотим %v", i, e.Connected, want)
		}
	}
	if !o.Employees[5].UnpaidToday {
		t.Error("unpaidToday не прокинулся в снапшот")
	}
}
```

`session_test.go`:
- `clientMessage{Type: "hire"}` → добавить поле Office в отправки: `clientMessage{Type: "hire", Office: 0}`.
- `testMessage`: поле `Employees` больше не топ-левел — заменить на `Offices []struct{ Employees []struct{ Name string `json:"name"`; IncomePerTick int `json:"incomePerTick"` } `json:"employees"` }` с тегом `json:"offices"`; проверки `len(m.Employees)` → `len(m.Offices[0].Employees)` (и охрана `len(m.Offices) > 0`).
- В `TestSessionBankruptcyAndRestart` конфиг: банкротство прежнее (SalaryPerDay 100000).
- Добавить тест адресации:

```go
func TestSessionOfficeCommand(t *testing.T) {
	cfg := game.DefaultConfig()
	c, ctx := dialTestServer(t, cfg, time.Hour)
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" })
	// Команда в закрытый офис — ошибка office_locked.
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 1}); err != nil {
		t.Fatal(err)
	}
	e := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" })
	if e.Code != "office_locked" {
		t.Fatalf("хотим office_locked, получили %+v", e)
	}
}
```

- [ ] **Step 2: RED**

Run: `cd server && go test ./internal/ws/`
Expected: FAIL — compile errors.

- [ ] **Step 3: Реализация**

`protocol.go`:

```go
// clientMessage — сообщение клиента: {"type": "...", "office": N}.
// office адресует офисные команды (hire, buy_pc, buy_router, hire_boss,
// buy_office); остальные его игнорируют.
type clientMessage struct {
	Type   string `json:"type"`
	Office int    `json:"office"`
}
```

Типы снапшота:

```go
// officeInfo — офис в снапшоте: всё для отрисовки комнаты и панели.
type officeInfo struct {
	Unlocked        bool           `json:"unlocked"`
	Price           int            `json:"price"` // цена покупки; 0 для открытых
	PCs             int            `json:"pcs"`
	RouterTier      int            `json:"routerTier"`
	Ports           int            `json:"ports"`
	NextRouter      int            `json:"nextRouter"` // 0 — тир максимальный
	Boss            string         `json:"boss"`       // "" — начальника нет
	BossUnpaidToday bool           `json:"bossUnpaidToday"`
	Employees       []employeeInfo `json:"employees"` // порядок = порядок найма
}
```

`employeeInfo` — добавить `UnpaidToday bool `json:"unpaidToday"``.

`stateMessage` — заменить целиком:

```go
type stateMessage struct {
	Type             string       `json:"type"` // всегда "state"
	Money            int          `json:"money"`
	Offices          []officeInfo `json:"offices"`
	Servers          int          `json:"servers"`
	Gateway          bool         `json:"gateway"`
	Multiplier       float64      `json:"multiplier"`
	IncomePerTick    int          `json:"incomePerTick"`
	Day              int          `json:"day"`
	Clock            string       `json:"clock"`   // «12:30»
	IsLunch          bool         `json:"isLunch"` // обед: доход за тик = 0
	TicksPerHour     int          `json:"ticksPerHour"`
	PayrollPerDay    int          `json:"payrollPerDay"` // полные расходы дня
	SalaryPerDay     int          `json:"salaryPerDay"`
	BossSalaryPerDay int          `json:"bossSalaryPerDay"`
	ForecastEndOfDay int          `json:"forecastEndOfDay"`
	StaffLimit       int          `json:"staffLimit"`
	OfficeSlots      int          `json:"officeSlots"`
	Phase            string       `json:"phase"` // running | day_report | game_over
	RackSlots        int          `json:"rackSlots"`
	Prices           prices       `json:"prices"`
}

type prices struct {
	PC      int `json:"pc"`
	Hire    int `json:"hire"`
	Server  int `json:"server"`
	Boss    int `json:"boss"`
	Gateway int `json:"gateway"`
}
```

`snapshot()`:

```go
func snapshot(g *game.Game) stateMessage {
	cfg := g.Config()
	offices := make([]officeInfo, len(g.Offices))
	for oi := range g.Offices {
		o := &g.Offices[oi]
		price := 0
		if !o.Unlocked {
			price = cfg.OfficePrices[oi-1]
		}
		connected := o.Connected(cfg)
		employees := make([]employeeInfo, len(o.Employees))
		for i, e := range o.Employees {
			employees[i] = employeeInfo{Name: e.Name, IncomePerTick: e.IncomePerTick,
				Connected: i < connected, UnpaidToday: e.UnpaidToday}
		}
		offices[oi] = officeInfo{
			Unlocked: o.Unlocked, Price: price, PCs: o.PCs,
			RouterTier: o.RouterTier, Ports: o.Ports(cfg),
			NextRouter: g.NextRouterPrice(oi), Boss: o.Boss,
			BossUnpaidToday: o.BossUnpaidToday, Employees: employees,
		}
	}
	return stateMessage{
		Type: "state", Money: g.Money, Offices: offices,
		Servers: g.Servers, Gateway: g.Gateway,
		Multiplier: g.Multiplier(), IncomePerTick: g.IncomePerTick(),
		Day: g.Day, Clock: g.Clock(), IsLunch: g.IsLunch(),
		TicksPerHour: cfg.TicksPerHour, PayrollPerDay: g.PayrollPerDay(),
		SalaryPerDay: cfg.SalaryPerDay, BossSalaryPerDay: cfg.BossSalaryPerDay,
		ForecastEndOfDay: g.ForecastEndOfDay(), StaffLimit: cfg.StaffLimit,
		OfficeSlots: cfg.OfficeSlots, Phase: string(g.Phase), RackSlots: cfg.RackSlots,
		Prices: prices{PC: cfg.PCPrice, Hire: cfg.HirePrice, Server: cfg.ServerPrice,
			Boss: cfg.BossPrice, Gateway: cfg.GatewayPrice},
	}
}
```

`dayReportMessage` += `GatewayOpex int `json:"gatewayOpex"``; заполнение из `report.GatewayOpex`.

`session.go` — канал команд с офисом:

```go
// clientCommand — команда игрока с адресатом-офисом.
type clientCommand struct {
	Cmd    game.Command
	Office int
}
```

`commands := make(chan clientCommand)`; в `readLoop`: `commands <- clientCommand{Cmd: game.Command(msg.Type), Office: msg.Office}`; в `run`: `if err := g.Apply(cmd.Cmd, cmd.Office); err != nil { ... }`.

- [ ] **Step 4: GREEN + race**

Run: `cd server && go test -race ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/ws/
git commit -m "feat(ws): снапшот с офисами, адресация команд, опекс в отчёте"
```

---

### Task 5: Клиент — протокол, сеть, activeOffice

**Files:**
- Modify: `client/src/protocol.ts`, `client/src/net.ts`
- Create: `client/src/rooms.ts`

**Interfaces:**
- Produces: `OfficeInfo {unlocked, price, pcs, routerTier, ports, nextRouter, boss, bossUnpaidToday, employees: EmployeeInfo[]}`; `EmployeeInfo` += `unpaidToday: boolean`; `StateMessage` по Task 4 (включая `gateway: boolean`, `bossSalaryPerDay`, `prices: {pc,hire,server,boss,gateway}`); `DayReportMessage` += `gatewayOpex: number`; `CommandType` += `'hire_boss' | 'buy_office' | 'buy_gateway'`; `client.send(cmd: CommandType, office = 0)` шлёт `{type, office}`; `rooms.ts`: `export const nav = { activeOffice: 0 }`.

- [ ] **Step 1: protocol.ts — заменить StateMessage-блок**

```ts
export interface EmployeeInfo {
  name: string
  incomePerTick: number
  connected: boolean
  unpaidToday: boolean
}

export interface OfficeInfo {
  unlocked: boolean
  price: number
  pcs: number
  routerTier: number
  ports: number
  nextRouter: number
  boss: string
  bossUnpaidToday: boolean
  employees: EmployeeInfo[]
}

export interface StateMessage {
  type: 'state'
  money: number
  offices: OfficeInfo[]
  servers: number
  gateway: boolean
  multiplier: number
  incomePerTick: number
  day: number
  clock: string
  isLunch: boolean
  ticksPerHour: number
  payrollPerDay: number
  salaryPerDay: number
  bossSalaryPerDay: number
  forecastEndOfDay: number
  staffLimit: number
  officeSlots: number
  phase: 'running' | 'day_report' | 'game_over'
  rackSlots: number
  prices: { pc: number; hire: number; server: number; boss: number; gateway: number }
}
```

`DayReportMessage` += `gatewayOpex: number`. `CommandType`:

```ts
export type CommandType =
  | 'buy_pc' | 'hire' | 'buy_router' | 'hire_boss' | 'buy_office'
  | 'buy_server' | 'buy_gateway' | 'next_day' | 'restart'
```

- [ ] **Step 2: net.ts — send с офисом**

```ts
  send(cmd: CommandType, office = 0): void {
    // Соединение ещё не открыто или уже потеряно — команду безопасно игнорируем,
    // сервер всё равно источник истины.
    if (this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: cmd, office }))
  }
```

- [ ] **Step 3: rooms.ts**

```ts
// Активный офис — общий для HUD (куда шлём команды) и сцены офиса
// (что рисуем). Мутируемый синглтон, менять только из панели навигации.
export const nav = { activeOffice: 0 }
```

- [ ] **Step 4: Typecheck (переходное состояние)**

Run: `cd client && npm run typecheck`
Expected: ошибки ТОЛЬКО в `HUDScene.ts`/`OfficeScene.ts`/`ServerRoomScene.ts` (Task 6-8); список в отчёт.

- [ ] **Step 5: Commit**

```bash
git add client/src/protocol.ts client/src/net.ts client/src/rooms.ts
git commit -m "feat(client): протокол офисов и адресация команд"
```

---

### Task 6: HUD — кнопки итерации 4, «Расходы», панель навигации

**Files:**
- Modify: `client/src/scenes/HUDScene.ts`, `client/src/layout.ts`

**Interfaces:**
- Consumes: Task 5 (`nav`, новые типы).
- Produces: `layout.ts` += `export const NAV_W = 64` (ширина панели). Панель навигации живёт в HUDScene (постоянна поверх комнат): значки Офис 1/2/3 + Серверная в колонке x=0..NAV_W, y от HUD_H вниз; клик по офису: `nav.activeOffice = i`, стоп текущей комнаты, launch/restart `office`; клик по серверной: launch `serverRoom`; активная комната подсвечена; закрытый офис показывает цену. Кнопка «В серверную» удалена. HUD-кнопки: ПК/Нанять (x=420), Роутер/Начальник (x=640), Сервер/Шлюз (x=860) — офисные шлют `nav.activeOffice`.

- [ ] **Step 1: layout.ts**

```ts
export const NAV_W = 64 // левая панель навигации: офисы и серверная
```

- [ ] **Step 2: HUDScene — кнопки и refresh**

Импорт: `import { nav } from '../rooms'`; `import { GAME_H, GAME_W, HUD_H, NAV_W } from '../layout'`.

В `ERROR_TEXTS` добавить/заменить:

```ts
  staff_limit: 'Наймите начальника — он откроет ещё 3 места',
  office_locked: 'Этот офис ещё не куплен',
  boss_already: 'Начальник уже нанят',
  offices_maxed: 'Все офисы уже куплены',
  gateway_already: 'Шлюз уже установлен',
  bad_office: 'Нет такого офиса',
```

В `create()` — заменить блок кнопок (switchBtn удаляется вместе с полем `room`, методом `switchRoom` и полем `switching`):

```ts
    this.pcBtn = this.makeButton(420, 10, () => client.send('buy_pc', nav.activeOffice))
    this.hireBtn = this.makeButton(420, 52, () => client.send('hire', nav.activeOffice))
    this.routerBtn = this.makeButton(640, 10, () => client.send('buy_router', nav.activeOffice))
    this.bossBtn = this.makeButton(640, 52, () => client.send('hire_boss', nav.activeOffice))
    this.serverBtn = this.makeButton(860, 10, () => client.send('buy_server'))
    this.gatewayBtn = this.makeButton(860, 52, () => client.send('buy_gateway'))
    this.createNavPanel()
```

Поля: `bossBtn!: Button`, `gatewayBtn!: Button`, `navItems: { bg: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text; sub: Phaser.GameObjects.Text }[] = []`, `currentRoom: 'office' | 'serverRoom' = 'office'`, `switching = false`.

Панель:

```ts
  // Панель навигации: значки офисов и серверной в колонке слева.
  private createNavPanel() {
    this.add.rectangle(0, HUD_H, NAV_W, GAME_H - HUD_H, 0x14162b).setOrigin(0)
    const rooms: { key: 'office' | 'serverRoom'; office: number; label: string }[] = [
      { key: 'office', office: 0, label: 'О1' },
      { key: 'office', office: 1, label: 'О2' },
      { key: 'office', office: 2, label: 'О3' },
      { key: 'serverRoom', office: -1, label: 'СРВ' },
    ]
    rooms.forEach((r, idx) => {
      const y = HUD_H + 24 + idx * 76
      const bg = this.add.rectangle(8, y, NAV_W - 16, 48, 0x232640)
        .setOrigin(0).setStrokeStyle(2, 0x3a3f5c).setInteractive({ useHandCursor: true })
      const label = this.add
        .text(NAV_W / 2, y + 18, r.label, { fontFamily: 'monospace', fontSize: '13px', color: '#f4f4f4' })
        .setOrigin(0.5)
      const sub = this.add
        .text(NAV_W / 2, y + 36, '', { fontFamily: 'monospace', fontSize: '8px', color: '#5d7275' })
        .setOrigin(0.5)
      bg.on('pointerdown', () => this.switchRoom(r.key, r.office))
      this.navItems.push({ bg, label, sub })
    })
  }

  private switchRoom(key: 'office' | 'serverRoom', office: number) {
    // Дребезг: два быстрых клика до завершения stop/launch дублируют сцену.
    if (this.switching) return
    this.switching = true
    this.time.delayedCall(250, () => (this.switching = false))
    if (office >= 0) nav.activeOffice = office
    this.scene.stop(this.currentRoom)
    if (key === this.currentRoom && key === 'office') {
      this.scene.launch('office') // рестарт сцены офиса на новый activeOffice
    } else {
      this.scene.launch(key)
    }
    this.currentRoom = key
    this.highlightNav()
  }

  private highlightNav() {
    this.navItems.forEach((item, idx) => {
      const active = this.currentRoom === 'serverRoom' ? idx === 3 : idx === nav.activeOffice
      item.bg.setStrokeStyle(2, active ? 0x41a6f6 : 0x3a3f5c)
    })
  }
```

В `refresh(s)` — обновление подписей панели и кнопок (заменить строки роутера и добавить новые):

```ts
    const active = s.offices[nav.activeOffice]
    this.routerBtn.setLabel(active.nextRouter > 0 ? `Роутер  ${fmtMoney(active.nextRouter)}` : 'Роутер MAX')
    this.bossBtn.setLabel(active.boss === '' ? `Начальник  ${fmtMoney(s.prices.boss)}` : 'Начальник ✓')
    this.serverBtn.setLabel(`Сервер  ${fmtMoney(s.prices.server)}`)
    this.gatewayBtn.setLabel(s.gateway ? 'Шлюз ✓' : `Шлюз  ${fmtMoney(s.prices.gateway)}`)
    this.navItems.forEach((item, idx) => {
      if (idx === 3) return
      const o = s.offices[idx]
      item.sub.setText(o.unlocked ? `${o.employees.length}/${s.officeSlots}` : fmtMoney(o.price))
    })
    this.highlightNav()
```

Подпись расходов: `this.payrollText.setText(`Расходы ${fmtMoney(s.payrollPerDay)}/день`)`. Счётчики: `const employees = s.offices.flatMap((o) => o.employees)`; `Сотрудники: ${employees.length} · в сети ${employees.filter((e) => e.connected).length} · ×${s.multiplier.toFixed(1)}`.

В `showReport(r)` в body добавить строку опекса (после «Зарплата»):

```ts
      ...(r.gatewayOpex > 0 ? [`Интернет: -${fmtMoney(r.gatewayOpex)}`] : []),
```

- [ ] **Step 3: Typecheck**

Run: `cd client && npm run typecheck`
Expected: остаются ошибки только в OfficeScene/ServerRoomScene (Task 7-8).

- [ ] **Step 4: Commit**

```bash
git add client/src/scenes/HUDScene.ts client/src/layout.ts
git commit -m "feat(client): панель навигации, кнопки начальника и шлюза, расходы"
```

---

### Task 7: OfficeScene — активный офис, босс, покупка офиса

**Files:**
- Modify: `client/src/scenes/OfficeScene.ts`

**Interfaces:**
- Consumes: `nav.activeOffice`, `OfficeInfo`, `fmtMoney`, `NAV_W`.
- Produces: рендер `s.offices[nav.activeOffice]`; закрытый офис — оверлей «Купить офис — $N» с кнопкой (`client.send('buy_office', nav.activeOffice)`); слот босса (пустой/занятый, тултип босса); слоты сверх `staffCap` (босса нет → 9) — «наймите начальника»; unpaidToday в тултипе сотрудника; обед-сдвиг и анти-залипание сохраняются.

- [ ] **Step 1: Реализация**

Изменения относительно текущего файла (остальное сохранить как есть):

1. Импорты: `import { nav } from '../rooms'`; `OfficeInfo` в типы; `NAV_W` из layout (пол офиса: `this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, ...)`).
2. `GRID.startX` = 260 (сдвиг из-за панели), остальное без изменений.
3. `render(s: StateMessage)`: первой строкой `const office = s.offices[nav.activeOffice]`; заголовок ``ОФИС ${nav.activeOffice + 1}``.
4. Закрытый офис:

```ts
    if (!office.unlocked) {
      this.objects.push(
        this.add.text(GAME_W / 2, 300, `Офис ${nav.activeOffice + 1} закрыт`, {
          fontFamily: 'monospace', fontSize: '24px', color: '#5d7275',
        }).setOrigin(0.5),
      )
      const canBuy = office.price > 0
      const btn = this.add.rectangle(GAME_W / 2 - 130, 360, 260, 40, 0x3b5dc9)
        .setOrigin(0, 0).setInteractive({ useHandCursor: true })
      const txt = this.add.text(GAME_W / 2, 380, canBuy ? `Купить офис — ${fmtMoney(office.price)}` : 'Сначала купите предыдущий', {
        fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4',
      }).setOrigin(0.5)
      btn.on('pointerdown', () => client.send('buy_office', nav.activeOffice))
      this.objects.push(btn, txt)
      return
    }
```

(«Сначала купите предыдущий»: закрытый офис с `price>0` — всегда покупаемый следующий? Нет: снапшот даёт price обоим закрытым. Кнопку показывать всегда, сервер ответит `bad_office` тостом, но подпись выбирать: `nav.activeOffice > 0 && !s.offices[nav.activeOffice - 1].unlocked` → «Сначала купите предыдущий», и тогда кнопку НЕ делать интерактивной.)

5. Слот босса — рядом со слотом роутера (роутер `rx = GAME_W - 130, ry = 170`; босс ниже):

```ts
    const bx = GAME_W - 130
    const by = 320
    this.objects.push(
      this.add.rectangle(bx, by, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(bx, by - 56, 'начальник', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (office.boss !== '') {
      const bossImg = this.add.image(bx, by, 'worker').setScale(5).setInteractive({ useHandCursor: true })
      bossImg.on('pointerover', () => this.showBossTooltip(office, s, bx, by))
      bossImg.on('pointerout', () => this.hideTooltip())
      this.objects.push(bossImg)
    } else {
      this.objects.push(this.add.text(bx, by, 'нет', { fontFamily: 'monospace', fontSize: '11px', color: '#5d7275' }).setOrigin(0.5))
    }
```

и метод:

```ts
  private showBossTooltip(o: OfficeInfo, s: StateMessage, x: number, y: number) {
    this.tooltipText.setText([
      o.boss,
      'Начальник — открывает места 10–12',
      `Зарплата:  ${fmtMoney(s.bossSalaryPerDay)}/день${o.bossUnpaidToday ? ' (сегодня без оплаты)' : ''}`,
    ].join('\n'))
    this.tooltipBg.setSize(this.tooltipText.width + 20, this.tooltipText.height + 16)
    this.tooltip.setPosition(Math.min(x + 40, GAME_W - this.tooltipBg.width - 8), y - 20).setVisible(true)
  }
```

6. Слоты и сотрудники — вместо `s.staffLimit` использовать потолок офиса: `const cap = office.boss !== '' ? s.officeSlots : s.staffLimit`; данные из `office.pcs`/`office.employees[i]`; текст закрытого слота «наймите\nначальника».
7. Тултип сотрудника — добавить строку при `e.unpaidToday`:

```ts
      `Зарплата:  ${fmtMoney(s.salaryPerDay)}/день${e.unpaidToday ? ' (сегодня без оплаты)' : ''}`,
```

- [ ] **Step 2: Typecheck**

Run: `cd client && npm run typecheck`
Expected: остаются ошибки только в ServerRoomScene (Task 8).

- [ ] **Step 3: Commit**

```bash
git add client/src/scenes/OfficeScene.ts
git commit -m "feat(client): сцена активного офиса, босс, покупка офиса"
```

---

### Task 8: ServerRoomScene — шлюз

**Files:**
- Modify: `client/src/scenes/ServerRoomScene.ts`

**Interfaces:**
- Consumes: `StateMessage.gateway`, `NAV_W`.

- [ ] **Step 1: Реализация**

1. Пол: `this.add.rectangle(NAV_W, HUD_H, GAME_W - NAV_W, GAME_H - HUD_H, 0x1f2233)` (импорт NAV_W).
2. После стоек — слот шлюза:

```ts
    const gx = GAME_W - 160
    const gy = 300
    this.objects.push(
      this.add.rectangle(gx, gy, 84, 84, 0x232640).setStrokeStyle(2, 0x5d7275),
      this.add.text(gx, gy - 56, 'шлюз', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
    )
    if (s.gateway) {
      this.objects.push(
        this.add.image(gx, gy, 'router').setScale(4),
        this.add.text(gx, gy + 52, 'интернет ×1.2', { fontFamily: 'monospace', fontSize: '11px', color: '#38b764' }).setOrigin(0.5),
      )
    } else {
      this.objects.push(this.add.text(gx, gy, 'нет', { fontFamily: 'monospace', fontSize: '11px', color: '#5d7275' }).setOrigin(0.5))
    }
```

3. Строку статуса дополнить шлюзом: ``Серверов: ${s.servers} · множитель ×${s.multiplier.toFixed(1)}${s.gateway ? ' · интернет' : ''}${note}`` (примечание про «без роутера серверы не работают» удалить — с тремя офисами оно вводит в заблуждение; статус цвета оставить `#41a6f6`).

- [ ] **Step 2: Typecheck — весь клиент чист**

Run: `cd client && npm run typecheck`
Expected: без ошибок.

- [ ] **Step 3: Commit**

```bash
git add client/src/scenes/ServerRoomScene.ts
git commit -m "feat(client): шлюз в серверной"
```

---

### Task 9: Обновление live-check

**Files:**
- Modify: `scripts/live-check.mjs`

- [ ] **Step 1: Заменить сценарий**

Заменить целиком:

```js
// Живая проверка протокола итерации 4 против реального сервера.
// Запуск: go run ./cmd/server -addr :8091 (из server/), затем node scripts/live-check.mjs
const FIELDS = [
  'money', 'offices', 'servers', 'gateway', 'multiplier', 'incomePerTick',
  'day', 'clock', 'isLunch', 'ticksPerHour', 'payrollPerDay', 'salaryPerDay',
  'bossSalaryPerDay', 'forecastEndOfDay', 'staffLimit', 'officeSlots',
  'phase', 'rackSlots', 'prices',
]
let step = 0
const ok = (name) => console.log(`ok ${++step} — ${name}`)
const fail = (name, got) => {
  console.error(`FAIL — ${name}:`, got)
  process.exit(1)
}

const ws = new WebSocket('ws://localhost:8091/ws')
let phase = 'start'
const timeout = setTimeout(() => fail('таймаут 90с', { phase }), 90_000)
ws.onclose = () => fail('соединение закрылось до конца проверки', { phase })

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (phase === 'start' && m.type === 'state') {
    const missing = FIELDS.filter((f) => !(f in m))
    if (missing.length) fail('нет полей снапшота', missing)
    ok(`снапшот: все ${FIELDS.length} полей на месте`)
    if (m.offices.length !== 3 || !m.offices[0].unlocked || m.offices[1].unlocked ||
        m.offices[1].price !== 15000 || m.offices[2].price !== 40000) {
      fail('офисы на старте', m.offices)
    }
    ok('офисы: 1 открыт, 2-3 закрыты с ценами')
    ws.send(JSON.stringify({ type: 'hire', office: 0 }))
    phase = 'hired'
  } else if (phase === 'hired' && m.type === 'state' && m.offices[0].employees.length === 1) {
    const e = m.offices[0].employees[0]
    if (!e.name || e.incomePerTick < 9 || e.incomePerTick > 14 || e.unpaidToday) {
      fail('нанятый сотрудник (утро — должен быть оплачиваемым)', e)
    }
    ok(`найм в офис 0: ${e.name}, $${e.incomePerTick}/тик`)
    ws.send(JSON.stringify({ type: 'hire', office: 1 })) // закрытый офис
    phase = 'locked'
  } else if (phase === 'locked' && m.type === 'error') {
    if (m.code !== 'office_locked') fail('код ошибки найма в закрытый офис', m.code)
    ok('найм в закрытый офис: error office_locked')
    ws.send(JSON.stringify({ type: 'buy_gateway', office: 0 }))
    phase = 'gateway'
  } else if (phase === 'gateway' && m.type === 'error') {
    if (m.code !== 'not_enough_money') fail('шлюз должен быть не по карману на старте', m.code)
    ok('шлюз без денег: error not_enough_money')
    phase = 'wait_report'
    console.log('… ждём конца дня (~54 сек)')
  } else if (phase === 'wait_report' && m.type === 'day_report') {
    if (m.day !== 1 || m.payroll !== 250 || m.gatewayOpex !== 0) fail('отчёт дня', m)
    ok(`отчёт дня 1: income=${m.income} payroll=${m.payroll} opex=${m.gatewayOpex}`)
    ws.send(JSON.stringify({ type: 'next_day', office: 0 }))
    phase = 'day2'
  } else if (phase === 'day2' && m.type === 'state' && m.day === 2 && m.phase === 'running') {
    ok('день 2 запущен, время ' + m.clock)
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
pkill -f 'exe/server'; pkill -f 'cmd/server'; true
```

Expected: `ok 1 … ok 6`, `ПРОТОКОЛ ОК` (~55 сек). Убить все процессы (включая дочерний go-build).

- [ ] **Step 3: Commit**

```bash
git add scripts/live-check.mjs
git commit -m "test: живая проверка протокола итерации 4"
```

---

### Task 10: Серверный race-прогон и README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

Дополнить блок геймплея: три офиса (второй $15k, третий $40k, пустые), у каждого свой роутер и начальник ($1,000 + $500/день — открывает места 10–12), шлюз в интернет ($3,000 + $1/день, ×1.2 подключённым), навигация по значкам слева, нанятый после 15:00 в день найма зарплату не получает.

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

Expected: всё зелёное, процессов не осталось.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README итерации 4"
```

После этого — браузерный смоук контроллера (панель, покупка офиса, босс, шлюз, «без оплаты»), финальное ревью ветки, плейтест пользователя (критерий из спеки: офис 2 — большое решение, начальник — расчёт, шлюз заметен, середина не проседает).
