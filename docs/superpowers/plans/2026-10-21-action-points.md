# Action Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The director gets 8 action points a day; starting a repair or a virus cleanup of a place costs 1 point, and the bankruptcy forecast accounts for the points as the best player would (ITGAME-127).

**Architecture:** Points live on `game.Game` (`ActionPoints`) with the pool in `Config.ActionPointsPerDay`; `RepairClick`/`VirusClick` charge through one helper `startAction`. The forecast builds a repair queue on its template copy and fixes it point by point, day by day. The snapshot carries the counter to the client, which shows it in the HUD and on the place labels.

**Tech Stack:** Go 1.x (`server/internal/game`, `server/internal/ws`), TypeScript + Phaser 3 (`client/src`).

**Spec:** `docs/superpowers/specs/2026-10-21-action-points-design.md`

## Global Constraints

- Pool: `ActionPointsPerDay = 8` on every difficulty; refilled to the pool on `NextDay` and on each offline morning; no carry-over.
- A point starts an action; `RepairClicks > 0` / `VirusClicks > 0` means started — continuing is free.
- Motivation, the master ($150), PC replacement ($500) and the admins cost no points.
- Refusal code: `no_action_points`.
- `SaveFormat` 3 → 4; no migrations (owner's 18.10 rule).
- Comments and user-facing strings in Russian, like the surrounding code. Commit subjects in English, `type(scope): … — ITGAME-127`, trailer exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (the lead session's model, not the implementer's own).
- Commit straight to `main` (project practice); never `git push`, never `make push`.
- `make smoke-ui` proxies to `:8080`; run smoke against your own server, never against the stand `:15555`.

---

### Task 1: Points on the server — charge, refill, save

**Files:**
- Modify: `server/internal/game/config.go` (field after `MasterCallPrice`, default in `DefaultConfig`)
- Modify: `server/internal/game/game.go` (field in `Game` after `DayAdminCleaned`; `NewWithSeed`)
- Modify: `server/internal/game/commands.go` (error code; `startAction`; `RepairClick`; `NextDay`)
- Modify: `server/internal/game/virus.go` (`VirusClick`)
- Modify: `server/internal/game/offline.go` (`resetForNextDay`)
- Modify: `server/internal/game/save.go` (`SaveFormat`, `Save`, `Export`, `Restore`)
- Modify: `server/internal/game/testdata/save_shape.txt`, `server/internal/ws/testdata/session_save_shape.txt` (regenerated)
- Modify: `server/internal/game/pc_test.go:503-505` (pinned format 3 → 4)
- Modify: `server/cmd/sim/policy.go:106-125` (comments only)
- Modify: `docs/design/gdd.md` (new bullet after «Инциденты-поломки»)
- Create: `server/internal/game/actionpoints_test.go`

**Interfaces:**
- Produces: `Config.ActionPointsPerDay int`; `Game.ActionPoints int`; `ErrNoActionPoints` (`"no_action_points"`); `func (g *Game) startAction(started bool) error`; `const actionPointCost = 1`; `Save.ActionPoints` (`json:"actionPoints"`).

- [ ] **Step 0: Sim baseline (before any change)**

```bash
cd /home/santarinto/projects/my/it-game/server
S=/tmp/claude-1000/-home-santarinto-projects-my-it-game/51c38720-b329-4200-ac87-e32a78b9cbaa/scratchpad
go run ./cmd/sim --diff normal --seed 1..50 --days 30 --policy all > $S/sim-before-normal.txt
go run ./cmd/sim --diff hard --seed 1..50 --days 30 --policy all > $S/sim-before-hard.txt
```

- [ ] **Step 1: Write the failing tests** — create `server/internal/game/actionpoints_test.go`:

```go
package game

import (
	"errors"
	"testing"
)

// Очки действий директора (ITGAME-127): ActionPointsPerDay (8) на день, утром
// снова полные, остаток не копится. Начать ремонт или чистку места — 1 очко,
// дальше клики бесплатны; начатое (игроком, админом или вчера) — бесплатно.
// Мотивация, мастер, замена ПК и админы очков не стоят.

// pointsGame — день 1, тик 0: место 0 сломано (N=5), место 1 заражено,
// место 2 целое; поломок и событий нет, денег с запасом.
func pointsGame(t *testing.T) *Game {
	t.Helper()
	cfg := DefaultConfig()
	cfg.BreakdownChancePermille = 0
	cfg.EventChancePct = 0
	g := NewWithSeed(cfg, 1, 2)
	g.Money = 100000
	o := &g.Offices[0]
	o.PCs = 3
	o.syncWorkplaces()
	o.Employees = testStaff(3)
	o.Employees[0].PCBroken = true
	o.Employees[0].RepairNeeded = 5
	o.Employees[1].Infected = true
	return g
}

func TestActionPointsPoolIsEightOnEveryDifficulty(t *testing.T) {
	for _, d := range []Difficulty{DiffEasy, DiffNormal, DiffHard, DiffHardcore} {
		cfg := ConfigForDifficulty(d)
		if cfg.ActionPointsPerDay != 8 {
			t.Errorf("%s: ActionPointsPerDay = %d, хотим 8", d, cfg.ActionPointsPerDay)
		}
		if g := NewWithSeed(cfg, 1, 2); g.ActionPoints != 8 {
			t.Errorf("%s: новая партия с %d очками, хотим 8", d, g.ActionPoints)
		}
	}
}

func TestRepairStartCostsOnePointClicksFree(t *testing.T) {
	g := pointsGame(t)
	e := &g.Offices[0].Employees[0]
	for i := 0; i < 5; i++ {
		if err := g.RepairClick(0, 0); err != nil {
			t.Fatalf("клик %d: %v", i+1, err)
		}
		if g.ActionPoints != 7 {
			t.Fatalf("после клика %d очков %d, хотим 7: платит только первый", i+1, g.ActionPoints)
		}
	}
	if e.PCBroken {
		t.Fatal("5 кликов из 5 — ПК должен быть цел")
	}
}

func TestRepairStartedIsFree(t *testing.T) {
	g := pointsGame(t)
	g.Offices[0].Employees[0].RepairClicks = 2 // начал админ или игрок вчера
	if err := g.RepairClick(0, 0); err != nil {
		t.Fatal(err)
	}
	if g.ActionPoints != 8 {
		t.Fatalf("начатый ремонт взял очко: осталось %d", g.ActionPoints)
	}
}

func TestRepairWithoutPointsRefused(t *testing.T) {
	g := pointsGame(t)
	g.ActionPoints = 0
	e := &g.Offices[0].Employees[0]
	if err := g.RepairClick(0, 0); !errors.Is(err, ErrNoActionPoints) {
		t.Fatalf("без очков: ошибка %v, хотим no_action_points", err)
	}
	if e.RepairClicks != 0 || !e.PCBroken || g.ActionPoints != 0 {
		t.Fatalf("отказ изменил место: clicks=%d broken=%v очков=%d", e.RepairClicks, e.PCBroken, g.ActionPoints)
	}
	e.RepairClicks = 1 // начатый — и без очков
	if err := g.RepairClick(0, 0); err != nil {
		t.Fatalf("начатый ремонт без очков: %v", err)
	}
}

func TestVirusStartCostsOnePointClicksFree(t *testing.T) {
	g := pointsGame(t)
	e := &g.Offices[0].Employees[1]
	for i := 0; i < g.cfg.VirusCleanClicks; i++ {
		if err := g.VirusClick(0, 1); err != nil {
			t.Fatalf("клик %d: %v", i+1, err)
		}
		if g.ActionPoints != 7 {
			t.Fatalf("после клика %d очков %d, хотим 7", i+1, g.ActionPoints)
		}
	}
	if e.Infected {
		t.Fatal("место должно быть вычищено")
	}
	g.ActionPoints = 0
	e.Infected = true
	if err := g.VirusClick(0, 1); !errors.Is(err, ErrNoActionPoints) {
		t.Fatalf("без очков: ошибка %v, хотим no_action_points", err)
	}
	if e.VirusClicks != 0 {
		t.Fatalf("отказ сделал клик: virusClicks=%d", e.VirusClicks)
	}
}

func TestBrokenInfectedPlaceCostsTwo(t *testing.T) {
	g := pointsGame(t)
	e := &g.Offices[0].Employees[0]
	e.Infected = true
	for e.PCBroken {
		if err := g.RepairClick(0, 0); err != nil {
			t.Fatal(err)
		}
	}
	for e.Infected {
		if err := g.VirusClick(0, 0); err != nil {
			t.Fatal(err)
		}
	}
	if g.ActionPoints != 6 {
		t.Fatalf("ремонт + чистка одного места: очков %d, хотим 6", g.ActionPoints)
	}
}

func TestMotivateMasterReplaceCostNoPoints(t *testing.T) {
	g := pointsGame(t)
	if err := g.Motivate(0, 2); err != nil {
		t.Fatalf("мотивация: %v", err)
	}
	if err := g.CallMaster(0, 0); err != nil {
		t.Fatalf("мастер: %v", err)
	}
	g.Offices[0].Workplaces[2].Wear = 1
	if err := g.ReplacePC(0, 2); err != nil {
		t.Fatalf("замена: %v", err)
	}
	if g.ActionPoints != 8 {
		t.Fatalf("мотивация, мастер и замена взяли очки: осталось %d", g.ActionPoints)
	}
}

func TestNextDayRefillsWithoutCarry(t *testing.T) {
	g := pointsGame(t)
	g.ActionPoints = 3
	for g.Phase == PhaseRunning {
		g.Tick()
	}
	if err := g.NextDay(); err != nil {
		t.Fatal(err)
	}
	if g.ActionPoints != 8 {
		t.Fatalf("утро: очков %d, хотим 8", g.ActionPoints)
	}
}

func TestOfflineMorningRefills(t *testing.T) {
	g := pointsGame(t)
	g.ActionPoints = 0
	g.AdvanceOffline(g.cfg.DayTicks() + 1) // вечер позади, утро дня 2
	if g.Phase != PhaseRunning || g.Day != 2 {
		t.Fatalf("ждали утро дня 2, получили день %d фаза %s", g.Day, g.Phase)
	}
	if g.ActionPoints != 8 {
		t.Fatalf("офлайн-утро: очков %d, хотим 8", g.ActionPoints)
	}
}

func TestActionPointsSaveRoundtrip(t *testing.T) {
	g := pointsGame(t)
	g.ActionPoints = 5
	back, err := Restore(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	if back.ActionPoints != 5 {
		t.Fatalf("после restore очков %d, хотим 5", back.ActionPoints)
	}
	for _, bad := range []int{-1, 9} {
		s := g.Export()
		s.ActionPoints = bad
		if _, err := Restore(s); !errors.Is(err, ErrBadSave) {
			t.Errorf("actionPoints=%d: restore %v, хотим bad_save", bad, err)
		}
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd server && go test ./internal/game -run 'ActionPoints|RepairStart|RepairWithout|VirusStart|BrokenInfected|MotivateMaster|NextDayRefills|OfflineMorning' 2>&1 | head -20`
Expected: build failure — `g.ActionPoints undefined`, `cfg.ActionPointsPerDay undefined`, `ErrNoActionPoints undefined`.

- [ ] **Step 3: Config field** — in `server/internal/game/config.go`, after the line `MasterCallPrice int // «вызвать мастера»: мгновенная починка`:

```go
	// Очки действий директора (ITGAME-127): столько на день, утром снова
	// столько же, остаток не копится. Начать ремонт или чистку места — очко.
	ActionPointsPerDay int
```

and in `DefaultConfig()`, after `MasterCallPrice:         150,`:

```go
		ActionPointsPerDay:      8,
```

(`gofmt` re-aligns the block; `ApplyDifficulty` does not touch the field.)

- [ ] **Step 4: Game field and start value** — in `server/internal/game/game.go`, in `type Game struct` after `DayAdminCleaned   int // мест, вычищенных админами за день`:

```go

	// Очки действий директора на сегодня (ITGAME-127): NextDay и офлайн-утро
	// восполняют их до cfg.ActionPointsPerDay.
	ActionPoints int
```

In `NewWithSeed`, the struct literal line `Money: cfg.StartMoney, Phase: PhaseRunning, Day: 1,` becomes:

```go
		Money: cfg.StartMoney, Phase: PhaseRunning, Day: 1, ActionPoints: cfg.ActionPointsPerDay,
```

- [ ] **Step 5: Error code and charge** — in `server/internal/game/commands.go`, after `ErrPCMaxLevel       = Err("pc_max_level")       // upgrade_pc на максимальном уровне`:

```go
	ErrNoActionPoints   = Err("no_action_points")   // начать ремонт или чистку места — очков действий нет (ITGAME-127)
```

Directly above `// RepairClick — один клик починки сломанного ПК`:

```go
// actionPointCost — столько очков действий стоит начать ремонт или чистку
// места (ITGAME-127); клики после начала бесплатны.
const actionPointCost = 1

// startAction — плата за начало действия: started — действие уже начато
// (игроком, админом или вчера), тогда бесплатно; иначе списывает
// actionPointCost или отказывает ErrNoActionPoints, ничего не меняя.
func (g *Game) startAction(started bool) error {
	if started {
		return nil
	}
	if g.ActionPoints < actionPointCost {
		return ErrNoActionPoints
	}
	g.ActionPoints -= actionPointCost
	return nil
}

```

In `RepairClick`, replace

```go
	if !e.PCBroken {
		return ErrNotBroken
	}
	e.repairClick()
	return nil
```

with

```go
	if !e.PCBroken {
		return ErrNotBroken
	}
	if err := g.startAction(e.RepairClicks > 0); err != nil {
		return err
	}
	e.repairClick()
	return nil
```

and update its doc comment's last line to: `// (N — RepairTarget(), роллится при поломке, ITGAME-93). Первый клик стоит очко действий (ITGAME-127).`

In `NextDay`, after `g.DayAdminCleaned = 0`:

```go
	g.ActionPoints = g.cfg.ActionPointsPerDay // утро: очки снова полные (ITGAME-127)
```

- [ ] **Step 6: Virus charge** — in `server/internal/game/virus.go`, `VirusClick`, replace

```go
	if !e.Infected {
		return ErrNotInfected
	}
	if e.virusClick(g.cfg.VirusCleanClicks) {
```

with

```go
	if !e.Infected {
		return ErrNotInfected
	}
	if err := g.startAction(e.VirusClicks > 0); err != nil {
		return err
	}
	if e.virusClick(g.cfg.VirusCleanClicks) {
```

and extend its doc comment with a line `// Первый клик стоит очко действий (ITGAME-127).`

- [ ] **Step 7: Offline morning** — in `server/internal/game/offline.go`, `resetForNextDay`, after `g.DayAdminCleaned = 0`:

```go
	g.ActionPoints = g.cfg.ActionPointsPerDay // утро и офлайн: очки снова полные (ITGAME-127)
```

- [ ] **Step 8: Save** — in `server/internal/game/save.go`:

1. `const SaveFormat = 3` → `const SaveFormat = 4`, and above it, after the «3 — ITGAME-196/203 …» paragraph of the comment, add:

```go
// 4 — ITGAME-127: очки действий директора — Config.ActionPointsPerDay и Save.actionPoints
// (остаток на сегодня); решение владельца 21.10.
```

2. In `type Save struct`, after `DayAdminCleaned   int        `json:"dayAdminCleaned"` // мест, вычищенных админами за день`:

```go
	ActionPoints      int        `json:"actionPoints"`    // очков действий осталось на сегодня (ITGAME-127)
```

3. In `Export`, the line `DayAdminRepairs: g.DayAdminRepairs, DayAdminCleaned: g.DayAdminCleaned,` becomes:

```go
		DayAdminRepairs: g.DayAdminRepairs, DayAdminCleaned: g.DayAdminCleaned, ActionPoints: g.ActionPoints,
```

4. In `Restore`, after the `incomeCarry` check (`if !(s.IncomeCarry >= 0 && s.IncomeCarry < 1) { … }`):

```go
	// Очки действий (ITGAME-127): от нуля до запаса дня — больше утро не даёт.
	if s.ActionPoints < 0 || s.ActionPoints > s.Config.ActionPointsPerDay {
		return nil, fmt.Errorf("%w: actionPoints=%d вне [0, %d]", ErrBadSave, s.ActionPoints, s.Config.ActionPointsPerDay)
	}
```

and in the `g := &Game{…}` literal the line `DayAdminRepairs: s.DayAdminRepairs, DayAdminCleaned: s.DayAdminCleaned,` becomes:

```go
		DayAdminRepairs: s.DayAdminRepairs, DayAdminCleaned: s.DayAdminCleaned, ActionPoints: s.ActionPoints,
```

5. In `server/internal/game/pc_test.go` (`TestPCSaveRoundtrip`):

```go
	if s.Format != 4 || SaveFormat != 4 {
		t.Errorf("формат %d / %d, хотим 4", s.Format, SaveFormat)
	}
```

- [ ] **Step 9: Regenerate both save-shape pins**

Run: `cd server && go test ./internal/game -run TestSaveShape ; go test ./internal/ws -run TestSessionSaveShape`
Expected: both FAIL and print a block between `----- <path> -----` and `----- конец <path> -----`. Paste each block verbatim into `server/internal/game/testdata/save_shape.txt` and `server/internal/ws/testdata/session_save_shape.txt` (the game pin gains `actionPoints int` and `config.ActionPointsPerDay int`, both start with `format 4`). Re-run both: PASS.

- [ ] **Step 10: Run the new tests**

Run: `cd server && go test ./internal/game -run 'ActionPoints|RepairStart|RepairWithout|VirusStart|BrokenInfected|MotivateMaster|NextDayRefills|OfflineMorning' -v 2>&1 | tail -25`
Expected: all PASS.

- [ ] **Step 11: Whole server suite**

Run: `cd server && go test ./... 2>&1 | tail -30`
Expected: PASS. A test that now fails with `no_action_points` starts more than 8 repairs/cleanups in one day and is not about points: give its game points explicitly right after it is built — `g.ActionPoints = 99 // тест не про очки действий (ITGAME-127)` — and, if it restores through a save, raise `cfg.ActionPointsPerDay` to match instead. Any other failure is a real regression: stop and investigate.

- [ ] **Step 12: Sim comments** — in `server/cmd/sim/policy.go`, the comment block

```go
		// активный день: чиним сломанные ПК и чистим вирус (клики бесплатны),
		// мотивируем по кулдауну — жадная политика забирает и активный слой тоже
```

becomes

```go
		// активный день: чиним сломанные ПК и чистим вирус (начать — очко
		// действий, ITGAME-127; кончились — отказ, break), мотивируем по
		// кулдауну — жадная политика забирает и активный слой тоже
```

and in the two inner comments replace «клики в sim бесплатны» with «клики после первого бесплатны» and «3 клика, бесплатно, как ремонт» with «3 клика, начать — очко, как ремонт».

- [ ] **Step 13: GDD** — in `docs/design/gdd.md`, after the «Инциденты-поломки» bullet (the one ending in the «требуется замена» sentence) add a bullet:

```markdown
- **Очки действий директора** (ITGAME-127, решение владельца 21.10). **8 очков на день**, утром
  снова 8, остаток не копится; на всех сложностях одинаково. **Начать ремонт** сломанного места —
  1 очко, **начать чистку** заражённого — 1 очко; клики после начала бесплатны, начатое (игроком,
  админом или вчера) продолжается без очков. Сломанное и заражённое место — 2 очка. Мотивация,
  мастер ($150), замена ПК ($500) и админы очков не стоят. Очков нет — отказ `no_action_points`:
  остаются мастер и админ. В шапке — «Очки: k/8»; прогноз банкротства (ITGAME-118) чинит места за
  очки, как лучший игрок. Рост запаса — ITGAME-205.
```

Also in the «Инциденты-поломки» bullet change «**3–15 кликов по столу** (бесплатно;» to «**3–15 кликов по столу** (начать — очко действий, дальше бесплатно;».

- [ ] **Step 14: Commit**

```bash
cd /home/santarinto/projects/my/it-game
gofmt -l server/ ; go -C server vet ./internal/game ./cmd/sim
git add server/internal/game server/internal/ws/testdata/session_save_shape.txt server/cmd/sim/policy.go docs/design/gdd.md
git commit -m "feat(game): action points — 8 a day refilled each morning, starting a repair or a virus cleanup costs one (no_action_points), started work continues free, motivation/master/replace/admins free; SaveFormat 4 — ITGAME-127"
```

(with the `Co-Authored-By` trailer as in Global Constraints; `gofmt -l` must print nothing.)

---

### Task 2: Bankruptcy forecast repairs with points

**Files:**
- Modify: `server/internal/game/game.go` (`baseOutput`, `doomFix`, `doomRepairQueue`, `doomRepair`, `BankruptInDays` and its doc comment, `incomeAtTickDetail` uses `baseOutput`)
- Modify: `server/internal/game/doom_test.go`

**Interfaces:**
- Consumes: `Game.ActionPoints`, `Config.ActionPointsPerDay`, `actionPointCost` (Task 1).
- Produces: `func (g *Game) baseOutput(o *Office, i int) float64`; `type doomFix struct{ office, slot int; virus bool; value float64 }`; `func (g *Game) doomRepairQueue() []doomFix`; `func (g *Game) doomRepair(q []doomFix, points int) ([]doomFix, int)`.

- [ ] **Step 1: Write the failing tests** — in `server/internal/game/doom_test.go`, replace `TestBankruptInDaysBrokenPCsCountAsRepaired` entirely with:

```go
// brokenPair — doomedGame без начальника: три места по $14, два сломаны
// (ремонт не начат); очков действий points.
func brokenPair(t *testing.T, d Difficulty, points int) *Game {
	t.Helper()
	g := doomedGame(t, d)
	o := &g.Offices[0]
	o.Boss = ""
	o.PCs = 3
	o.syncWorkplaces()
	o.Employees = []Employee{
		{Name: "Артём Никитин", IncomePerTick: 14, HireDay: 1, PCBroken: true, RepairNeeded: 3},
		{Name: "Мария Фёдорова", IncomePerTick: 14, HireDay: 1, PCBroken: true, RepairNeeded: 3},
		{Name: "Дмитрий Смирнов", IncomePerTick: 14, HireDay: 1},
	}
	g.ActionPoints = points
	return g
}

func TestBankruptInDaysBrokenPCsRepairedWithPoints(t *testing.T) {
	g := brokenPair(t, DiffHard, 8)
	// Очков на оба ремонта хватает (ITGAME-127): прогноз считает места
	// починенными, хотя ночью ПК сами не чинятся (ITGAME-136).
	if got := g.BankruptInDays(); got != 0 {
		t.Fatalf("очков хватает на оба ремонта — сигнала нет, получили %d", got)
	}
	if o := &g.Offices[0]; !o.Employees[0].PCBroken || !o.Employees[1].PCBroken || g.ActionPoints != 8 {
		t.Fatal("прогноз обречённости починил ПК или потратил очки в живой игре")
	}
}

// Без очков сегодня два места стоят до утра: недобранный доход решает,
// переживёт ли партия сегодняшний вечер на овердрафте (ITGAME-127).
func TestBankruptInDaysNoPointsTodayKeepsPlacesBroken(t *testing.T) {
	probe := brokenPair(t, DiffNormal, 8)
	dayTicks := probe.cfg.DayTicks()
	tpl := probe.offlineTemplate()
	tpl.MarketToday = 0
	one := tpl.exactIncome(0, dayTicks, nil) // два места сломаны
	for i := range tpl.Offices[0].Employees {
		tpl.Offices[0].Employees[i].PCBroken = false
	}
	all := tpl.exactIncome(0, dayTicks, nil)
	inAll, _ := carryIncome(0, all)
	inOne, _ := carryIncome(0, one)
	if inAll <= inOne {
		t.Fatalf("доход со всеми местами %d не больше, чем с одним %d", inAll, inOne)
	}
	payroll := probe.PayrollPerDay()
	// Вечером ровно на пороге долга, если работают все три места.
	money := payroll - probe.debtLimit(payroll) - inAll
	if money >= 0 {
		t.Fatalf("баланс %d не в минусе — прогноз не запустится", money)
	}

	withPoints := brokenPair(t, DiffNormal, 8)
	withPoints.Money = money
	if got := withPoints.BankruptInDays(); got == 1 {
		t.Fatalf("с очками места чинятся сегодня — вечер переживаем, получили %d", got)
	}
	noPoints := brokenPair(t, DiffNormal, 0)
	noPoints.Money = money
	if got := noPoints.BankruptInDays(); got != 1 {
		t.Fatalf("без очков два места стоят до утра — банкротство сегодня, получили %d", got)
	}
}

func TestBankruptInDaysAdminOfficeIgnoresPoints(t *testing.T) {
	a := brokenPair(t, DiffHard, 0)
	b := brokenPair(t, DiffHard, 8)
	for _, g := range []*Game{a, b} {
		g.Offices[0].Admin = "Пётр Админов"
	}
	if ga, gb := a.BankruptInDays(), b.BankruptInDays(); ga != gb {
		t.Fatalf("в офисе с админом очки ни при чём: без очков %d, с очками %d", ga, gb)
	}
}

func TestDoomRepairQueueOrder(t *testing.T) {
	g := doomedGame(t, DiffHard)
	o := &g.Offices[0]
	o.Boss = ""
	o.PCs = 4
	o.syncWorkplaces()
	o.Employees = []Employee{
		{Name: "А", IncomePerTick: 10, HireDay: 1, PCBroken: true, RepairNeeded: 3},
		{Name: "Б", IncomePerTick: 14, HireDay: 1, Infected: true},
		{Name: "В", IncomePerTick: 14, HireDay: 1, PCBroken: true, RepairNeeded: 3, Infected: true},
		{Name: "Г", IncomePerTick: 20, HireDay: 1, PCBroken: true, RepairNeeded: 3, RepairClicks: 2},
	}
	tpl := g.offlineTemplate()
	q := tpl.doomRepairQueue()
	type item struct {
		slot  int
		virus bool
	}
	var got []item
	for _, f := range q {
		got = append(got, item{f.slot, f.virus})
	}
	// Ремонт возвращает всю выработку места, чистка — долю вируса (1 − VirusMult):
	// В-ремонт 14, А-ремонт 10, Б-чистка 4.2, В-чистка 4.2 (порядок мест при равенстве).
	// Г начат — бесплатен: в очереди его нет, на шаблоне он уже цел.
	want := []item{{2, false}, {0, false}, {1, true}, {2, true}}
	if len(got) != len(want) {
		t.Fatalf("очередь %v, хотим %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("очередь %v, хотим %v", got, want)
		}
	}
	if tpl.Offices[0].Employees[3].PCBroken {
		t.Error("начатый ремонт должен считаться сделанным на шаблоне")
	}
	rest, n := tpl.doomRepair(q, 3)
	if n != 3 || len(rest) != 1 || tpl.Offices[0].Employees[1].Infected || !tpl.Offices[0].Employees[2].Infected {
		t.Fatalf("3 очка: починено %d, хвост %d, Б заражён %v, В заражён %v",
			n, len(rest), tpl.Offices[0].Employees[1].Infected, tpl.Offices[0].Employees[2].Infected)
	}
	if !g.Offices[0].Employees[0].PCBroken {
		t.Error("очередь прогноза тронула живую игру")
	}
}
```

- [ ] **Step 2: Run to see failures**

Run: `cd server && go test ./internal/game -run 'BankruptInDays|DoomRepair' 2>&1 | head -20`
Expected: build failure — `tpl.doomRepairQueue undefined`, `tpl.doomRepair undefined`.

- [ ] **Step 3: Extract `baseOutput`** — in `server/internal/game/game.go`, `incomeAtTickDetail`, the line

```go
			clean := float64(e.IncomePerTick+g.levelBonus(e)) * raiseMult(e) * g.pcMult(o, i) * g.dayEffectMult(o, e, tick)
```

becomes

```go
			clean := g.baseOutput(o, i) * g.dayEffectMult(o, e, tick)
```

and add after `incomeAtTickDetail`:

```go
// baseOutput — личная выработка места i до эффектов дня и сети: доход и
// прибавка уровня, × накопленное повышение, × уровень ПК (ITGAME-135).
func (g *Game) baseOutput(o *Office, i int) float64 {
	e := &o.Employees[i]
	return float64(e.IncomePerTick+g.levelBonus(e)) * raiseMult(e) * g.pcMult(o, i)
}
```

- [ ] **Step 4: Queue and repair helpers** — in `server/internal/game/game.go`, after `const doomHorizonDays = 365`:

```go

// doomFix — пункт очереди ремонта прогноза банкротства (ITGAME-127): место и
// что на нём начать — ремонт или чистку; каждый пункт стоит очко действий.
// value — что пункт возвращает: ремонт — всю личную выработку места, чистка —
// долю, которую забирает вирус.
type doomFix struct {
	office, slot int
	virus        bool
	value        float64
}

// doomRepairQueue — на шаблоне прогноза снимает бесплатное и возвращает
// платную очередь. Бесплатно всё в офисах с админом (он чинит и чистит сам,
// ITGAME-101) и начатое — клики уже есть (игроком, админом или вчера). Платное
// идёт по value по убыванию; при равенстве — офис, место, ремонт раньше
// чистки: так чинил бы лучший игрок.
func (g *Game) doomRepairQueue() []doomFix {
	var q []doomFix
	for oi := range g.Offices {
		o := &g.Offices[oi]
		for i := range o.Employees {
			e := &o.Employees[i]
			free := o.Admin != ""
			if e.PCBroken {
				if free || e.RepairClicks > 0 {
					e.PCBroken = false
				} else {
					q = append(q, doomFix{oi, i, false, g.baseOutput(o, i)})
				}
			}
			if e.Infected {
				if free || e.VirusClicks > 0 {
					e.Infected = false
				} else {
					q = append(q, doomFix{oi, i, true, g.baseOutput(o, i) * (1 - g.cfg.VirusMult)})
				}
			}
		}
	}
	slices.SortStableFunc(q, func(a, b doomFix) int { return cmp.Compare(b.value, a.value) })
	return q
}

// doomRepair — чинит на шаблоне столько первых пунктов очереди, на сколько
// хватает points очков; возвращает хвост и число починенных.
func (g *Game) doomRepair(q []doomFix, points int) ([]doomFix, int) {
	n := min(max(points, 0)/actionPointCost, len(q))
	for _, f := range q[:n] {
		e := &g.Offices[f.office].Employees[f.slot]
		if f.virus {
			e.Infected = false
		} else {
			e.PCBroken = false
		}
	}
	return q[n:], n
}
```

Add `"cmp"` and `"slices"` to the `import (…)` block of `game.go` if they are not there yet.

- [ ] **Step 5: Rewrite `BankruptInDays`** — replace the body from `tpl := g.offlineTemplate()` through the closing `return 0` of the function with:

```go
	tpl := g.offlineTemplate() // своя копия шаблона, живую игру не трогает
	tpl.MarketToday = 0
	// Сегодня — на оставшиеся очки, каждое утро — ещё запас дня (ITGAME-127).
	queue, _ := tpl.doomRepair(tpl.doomRepairQueue(), g.ActionPoints)
	dayTicks := g.cfg.DayTicks()
	tplPayroll := tpl.PayrollPerDay()
	payroll := g.PayrollPerDay() // сегодняшний вечер: без нанятых после обеда
	// Доход зачисляется как в офлайн-движке: точная сумма с остатком компании
	// (ITGAME-222); остаток гоняем на своей копии, живой не трогаем.
	carry := g.IncomeCarry
	inc, carry := carryIncome(carry, tpl.exactIncome(g.TickInDay, dayTicks, nil))
	money := g.Money + inc - payroll
	dayExact, stale := 0.0, true
	for d := 1; d <= doomHorizonDays; d++ {
		if g.cfg.WinDayLimit > 0 && g.Day+d-1 > g.cfg.WinDayLimit {
			return 0
		}
		if money >= 0 {
			return 0
		}
		money -= int(math.Ceil(float64(-money) * g.cfg.CreditRate))
		if -money > g.debtLimit(payroll) {
			return d
		}
		// Утро: очки снова полные — чиним следующие пункты; доход дня
		// пересчитываем, только когда шаблон изменился.
		var fixed int
		if queue, fixed = tpl.doomRepair(queue, g.cfg.ActionPointsPerDay); fixed > 0 || stale {
			dayExact, stale = tpl.exactIncome(0, dayTicks, nil), false
		}
		inc, carry = carryIncome(carry, dayExact)
		money += inc - tplPayroll
		payroll = tplPayroll
	}
	return 0
```

In the doc comment of `BankruptInDays`, replace the sentence fragment

```
// ITGAME-222), но с целыми и чистыми ПК: ремонт и чистка кликами бесплатны,
// сломанный ПК — не тупик, хотя ночью он сам больше не чинится (ITGAME-136),
// заражённое место — тоже, хотя вирус сам не проходит (ITGAME-103). ПК «требуется
```

with

```
// ITGAME-222). Сломанные и заражённые места чинит лучший игрок (ITGAME-127):
// в офисах с админом и начатое — сразу, остальное — за очки действий: сегодня
// столько самых выгодных пунктов, сколько осталось очков, каждое утро ещё
// ActionPointsPerDay (doomRepairQueue). Мастера нет — баланс в минусе. Ночью ПК
// сам не чинится (ITGAME-136), вирус сам не проходит (ITGAME-103). ПК «требуется
```

- [ ] **Step 6: Run the forecast tests**

Run: `cd server && go test ./internal/game -run 'BankruptInDays|DoomRepair' -v 2>&1 | tail -30`
Expected: all PASS, including the untouched `TestBankruptInDaysMatchesOfflineEngine` and `TestBankruptInDaysTonightUsesLivePayroll`.

- [ ] **Step 7: Whole server suite and commit**

```bash
cd /home/santarinto/projects/my/it-game
go -C server test ./... 2>&1 | tail -15
gofmt -l server/
git add server/internal/game/game.go server/internal/game/doom_test.go
git commit -m "feat(game): the bankruptcy forecast repairs as the best player with action points — today as many top-value fixes as points are left, then a pool a morning; admin offices and started work free — ITGAME-127"
```

---

### Task 3: Points in the snapshot

**Files:**
- Modify: `server/internal/ws/protocol.go` (`stateMessage` fields; `snapshot`)
- Modify: `server/internal/ws/protocol_test.go` (new test)
- Modify: `client/src/protocol.ts` (`StateMessage`)

**Interfaces:**
- Consumes: `Game.ActionPoints`, `Config.ActionPointsPerDay` (Task 1); `g.Config()` or the `cfg` local already used in `snapshot`.
- Produces: JSON `state.actionPoints: number`, `state.actionPointsMax: number`; TS `StateMessage.actionPoints`, `StateMessage.actionPointsMax`.

- [ ] **Step 1: Failing test** — append to `server/internal/ws/protocol_test.go`:

```go
// Очки действий директора (ITGAME-127) едут в снапшоте: остаток на сегодня
// и запас дня — клиент рисует «Очки: k/N» в шапке.
func TestProtocolActionPoints(t *testing.T) {
	g := game.NewWithSeed(game.DefaultConfig(), 1, 2)
	g.ActionPoints = 5
	data, err := json.Marshal(snapshot(g, 1, false, ""))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if raw["actionPoints"] != float64(5) || raw["actionPointsMax"] != float64(8) {
		t.Fatalf("actionPoints=%v actionPointsMax=%v, хотим 5 и 8", raw["actionPoints"], raw["actionPointsMax"])
	}
}
```

Run: `cd server && go test ./internal/ws -run TestProtocolActionPoints`
Expected: FAIL — `actionPoints=<nil>`.

- [ ] **Step 2: Fields** — in `server/internal/ws/protocol.go`, `stateMessage`, after the `BankruptInDays` field:

```go
	ActionPoints      int              `json:"actionPoints"`    // очков действий директора осталось на сегодня (ITGAME-127)
	ActionPointsMax   int              `json:"actionPointsMax"` // запас дня: столько утром
```

and in `snapshot`, the line `BankruptInDays: g.BankruptInDays(), VirusWaveAt: g.VirusWaveClock(), Antivirus: av,` becomes:

```go
		BankruptInDays: g.BankruptInDays(), VirusWaveAt: g.VirusWaveClock(), Antivirus: av,
		ActionPoints: g.ActionPoints, ActionPointsMax: cfg.ActionPointsPerDay,
```

(`cfg` is the local the literal already reads `cfg.TicksPerHour` from.)

- [ ] **Step 3: Client type** — in `client/src/protocol.ts`, `StateMessage`, after the `bankruptInDays` line:

```ts
  actionPoints: number // очков действий директора осталось на сегодня (ITGAME-127)
  actionPointsMax: number // запас дня: столько утром
```

- [ ] **Step 4: Run and commit**

```bash
cd /home/santarinto/projects/my/it-game
go -C server test ./internal/ws 2>&1 | tail -5
(cd client && npx tsc --noEmit)
git add server/internal/ws/protocol.go server/internal/ws/protocol_test.go client/src/protocol.ts
git commit -m "feat(ws): the snapshot carries actionPoints and actionPointsMax — ITGAME-127"
```

Expected: `ok`, no tsc errors.

---

### Task 4: Points in the client — HUD line, place labels, tooltip, toast, itd doc

**Files:**
- Modify: `client/src/scenes/HUDScene.ts` (error map ~line 75; field ~line 108; creation ~line 258; `layoutPanel` ~line 830; refresh ~line 900)
- Modify: `client/src/scenes/OfficeScene.ts` (labels ~lines 436-455; tooltip ~lines 767-773)
- Modify: `client/src/debug/agentApi.ts` (doc line before «Рабочие места (ITGAME-135)»)
- Modify: `client/src/debug/contract.gen.ts` (regenerated)
- Modify: `client/scripts/qa-itgame16.mjs:56` (`LEFT_IDS`)

**Interfaces:**
- Consumes: `StateMessage.actionPoints`, `StateMessage.actionPointsMax` (Task 3); refusal `no_action_points` (Task 1).
- Produces: HUD text object id `hud.points`.

- [ ] **Step 1: Toast** — in `client/src/scenes/HUDScene.ts`, in the error-text map after `pc_max_level: 'Рабочее место уже максимального уровня',`:

```ts
  no_action_points: 'Очки действий кончились — мастер или админ; утром очки восполнятся',
```

- [ ] **Step 2: HUD text** — next to `private moneyText!: Phaser.GameObjects.Text`:

```ts
  private pointsText!: Phaser.GameObjects.Text
```

After the `this.moneyText = tag(…, 'hud.money')` statement:

```ts
    // Очки действий директора (ITGAME-127): в ряду денег, справа от суммы.
    this.pointsText = tag(this.add.text(200, 14, '', {
      fontFamily: FONT, fontSize: '15px', color: '#f4f4f4',
    }), 'hud.points')
```

In `layoutPanel()`, the first line becomes:

```ts
    layoutColumn(4, [[this.moneyText, this.pointsText], [this.incomeText, this.payrollText, this.debtText], [this.netText], [this.dayProfitText]], 0, HUD_H)
    layoutRow(16, 16, [this.moneyText, this.pointsText], PANEL_LEFT_MAX)
    // Мелкая строка очков — по низу крупной суммы, а не по верху ряда.
    this.pointsText.setY(this.moneyText.y + this.moneyText.height - this.pointsText.height)
```

In the state refresh, after `this.moneyText.setColor(s.money < 0 ? '#b13e53' : '#ffcd75')`:

```ts
    this.pointsText.setText(`Очки: ${s.actionPoints}/${s.actionPointsMax}`)
    this.pointsText.setColor(s.actionPoints > 0 ? '#f4f4f4' : '#b13e53')
```

- [ ] **Step 3: Place labels** — in `client/src/scenes/OfficeScene.ts`, replace

```ts
        repairBounds = repairLabel.getBounds()
        repairLabel.setText(`✖ чинить ${e.repairClicks}/${need}`)
```

with

```ts
        // Не начатый ремонт стоит очко действий (ITGAME-127): метка называет цену,
        // после первого клика — «k/N». Зона — объединение bounds обеих меток.
        const repairIdle = '✖ чинить · 1 очко'
        repairBounds = repairLabel.getBounds()
        repairLabel.setText(repairIdle)
        repairBounds = Phaser.Geom.Rectangle.Union(repairBounds, repairLabel.getBounds())
        repairLabel.setText(e.repairClicks > 0 ? `✖ чинить ${e.repairClicks}/${need}` : repairIdle)
```

and replace

```ts
        repairBounds = virusLabel.getBounds()
        virusLabel.setText(`☣ вирус ${e.virusClicks}/${need}`)
```

with

```ts
        const virusIdle = '☣ вирус · 1 очко'
        repairBounds = virusLabel.getBounds()
        virusLabel.setText(virusIdle)
        repairBounds = Phaser.Geom.Rectangle.Union(repairBounds, virusLabel.getBounds())
        virusLabel.setText(e.virusClicks > 0 ? `☣ вирус ${e.virusClicks}/${need}` : virusIdle)
```

(If `Phaser` is not imported in `OfficeScene.ts`, it is — the file already uses `Phaser.GameObjects.Text`.)

- [ ] **Step 4: Tooltip** — in the tooltip builder, replace

```ts
    if (e.pcBroken) {
      lines.push(`ПК СЛОМАН — доход 0; кликайте по месту: ${e.repairClicks}/${e.repairNeeded > 0 ? e.repairNeeded : 3}`)
    }
```

with

```ts
    if (e.pcBroken) {
      lines.push(`ПК СЛОМАН — доход 0; кликайте по месту: ${e.repairClicks}/${e.repairNeeded > 0 ? e.repairNeeded : 3}`)
      // Первый клик стоит очко действий (ITGAME-127).
      if (e.repairClicks === 0) lines.push('начать ремонт — 1 очко действий')
    }
```

and after the `if (e.infected) { lines.push(…) }` block add:

```ts
    if (e.infected && !e.pcBroken && e.virusClicks === 0) lines.push('начать чистку — 1 очко действий')
```

- [ ] **Step 5: itd doc line** — in `client/src/debug/agentApi.ts`, insert before the line that starts with 39 spaces and `Рабочие места (ITGAME-135): itd.cmd('upgrade_pc'`:

```
                                       Очки действий (ITGAME-127): state.actionPoints / state.actionPointsMax (8 на день, утром снова полные); начать ремонт (repair_click при repairClicks 0) или чистку (virus_click при virusClicks 0) — 1 очко, дальше клики бесплатны, без очков — no_action_points; мотивация, мастер, замена ПК и админы очков не стоят; в шапке — hud.points
```

(same 39-space indent as its neighbours.)

- [ ] **Step 6: qa:hud overlap list** — in `client/scripts/qa-itgame16.mjs:56`:

```js
const LEFT_IDS = ['hud.money', 'hud.points', 'hud.income', 'hud.payroll', 'hud.net', 'hud.dayProfit', 'hud.debt']
```

- [ ] **Step 7: Regenerate the contract and build**

```bash
cd /home/santarinto/projects/my/it-game/client
npm run gen:contract
npm run build 2>&1 | tail -15
```

Expected: build passes (`gen-contract.mjs --check` clean, tsc clean, vite build, sprite/emoji checks OK).

- [ ] **Step 8: Commit**

```bash
cd /home/santarinto/projects/my/it-game
git add client/src/scenes/HUDScene.ts client/src/scenes/OfficeScene.ts client/src/debug/agentApi.ts client/src/debug/contract.gen.ts client/scripts/qa-itgame16.mjs
git commit -m "feat(client): «Очки: k/8» in the HUD money row, red at 0; place labels «✖ чинить · 1 очко» / «☣ вирус · 1 очко» until the first click, tooltip line, no_action_points toast; itd doc — ITGAME-127"
```

---

### Task 5: Verification, sim comparison, hand-off

**Files:** none changed unless a check fails.

- [ ] **Step 1: Server and client gates**

```bash
cd /home/santarinto/projects/my/it-game
make test 2>&1 | tail -10
make typecheck 2>&1 | tail -5
```

Expected: PASS, no type errors.

- [ ] **Step 2: Smoke on an own server** — `make build`, then start `ITGAME_DEBUG=1 ./bin/itdirector -static client/dist -addr :18127 -saves off` in the background, run `cd client && OFFICE=1 npm run smoke-ui -- http://127.0.0.1:18127/`, then stop the server. Never point it at `:15555` and never use bare `make smoke-ui` (it proxies to `:8080`).
Expected: the menu starts, the office scene opens, console clean.

- [ ] **Step 3: QA scripts that click repair** — `cd client && npm run qa:hud && npm run qa:slots && npm run qa:pc && npm run qa:admins && npm run qa:journal`. Without `QA_BASE` each script builds and starts its own server on its own port (`QA_PORT` defaults 4174/4177/…), so nothing touches the stand. A failure on `no_action_points` means the script starts more than 8 repairs/cleanups in one day: give the party points through the debug delta the script already uses for its setup (`actionPoints` within `[0, 8]`) or split the clicks across a `next_day`; any other failure is a regression — stop and investigate.

- [ ] **Step 4: Sim after**

```bash
cd /home/santarinto/projects/my/it-game/server
S=/tmp/claude-1000/-home-santarinto-projects-my-it-game/51c38720-b329-4200-ac87-e32a78b9cbaa/scratchpad
go run ./cmd/sim --diff normal --seed 1..50 --days 30 --policy all > $S/sim-after-normal.txt
go run ./cmd/sim --diff hard --seed 1..50 --days 30 --policy all > $S/sim-after-hard.txt
diff $S/sim-before-normal.txt $S/sim-after-normal.txt | head -40
diff $S/sim-before-hard.txt $S/sim-after-hard.txt | head -40
```

Summarise per policy: wins, bankruptcies, mean final money — before vs after. Information for the owner, not a gate.

- [ ] **Step 5: Tracker hand-off** — log the sim summary on ITGAME-127 and move it to `qa` with acceptance steps:

```
task.where(code=ITGAME-127) | log("[impl · <model-id>] <commits>; sim normal/hard before→after: <numbers>", model: <model-id>)
task.where(code=ITGAME-127) | set(status: qa, qa: "<steps below>", model: <model-id>)
```

QA steps (stand http://localhost:15555/?debug=1 after the owner deploys): 1) new party — header shows «Очки: 8/8» right of the money; 2) break a PC (`itd.cmd` or wait) — label «✖ чинить · 1 очко», tooltip «начать ремонт — 1 очко действий»; first click → «Очки: 7/8», label «✖ чинить 1/N», further clicks keep 7; 3) same for a virus place (`☣ вирус · 1 очко`); 4) motivation and «мастер» leave the counter; 5) spend to 0 — counter red, a fresh broken place refuses with the toast «Очки действий кончились — мастер или админ; утром очки восполнятся», a started repair still clicks; 6) next day → «Очки: 8/8»; 7) `itd.overlaps()` empty on the header and on a broken place label.
