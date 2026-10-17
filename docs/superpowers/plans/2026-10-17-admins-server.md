# Админы — сервер (ITGAME-101 A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Админ офиса на сервере: найм/увольнение, 2 клика ремонта/чистки в тик по своему офису, прогноз, офлайн, карточка вируса, журнал, отчёт дня, протокол и политика `delegate` в `make sim`.

**Architecture:** Админ — поля `Office` (как начальник), не `Employee`. Работа — чистая функция `(*Office).adminWork` над местами офиса (без журнала, таймера и карточки); `Game.adminTick` зовёт её в `Tick` и офлайне и сам «оседает» вирус (`virusSettled`). Прогноз гоняет `adminWork` на копии мест, офлайн — на живой игре по тикам догона.

**Tech Stack:** Go (server/internal/game, server/internal/ws, server/cmd/sim), TypeScript-зеркало протокола (client/src/protocol.ts) и сгенерированный контракт.

**Spec:** `docs/design/gdd.md`, раздел «Админы (ITGAME-101)» (16c4b0e, принят владельцем 17.10). Клиент — ITGAME-145, ночная смена — ITGAME-144.

## Global Constraints

- Цена найма **$600** ×PriceK, зарплата **$300/день** ×WageK, **2 клика в тик**; компенсация увольнения — зарплата дня админа, в день найма `FireCompSameDay` ($100).
- Один админ на офис; не `Employee`: не в `staffCount`, `TotalEmployees`, `Network`, `AVCovered`, `IsDeadlocked`, `WinStaff`.
- Очередь клика: первое заражённое место с целым ПК по порядку мест, иначе сломанное место; пересчёт на каждый клик (лишний клик — следующей цели).
- Админ работает каждый тик дня, в обед тоже; на паузе и ночью тиков нет.
- Порядок в `Tick`: `rollBreakdowns` → `tickVirus` → `activateEvents` → **`adminTick`** → доход.
- Журнал: «вирус: офис N вычищен админом к HH:MM», если офис стал чистым от клика админа; от клика игрока — прежнее «вручную»; офлайн — молча.
- Карточка «Вирус в сети» в офисе с админом: в конце текста « Админ офиса вычистит сам к HH:MM.»
- Ошибки: `admin_already`, `no_admin`. Команды: `hire_admin`, `fire_admin` (офис в `office`).
- Сейв формата 1 не поднимаем; конфиг без полей админа — бэкфилл из уровня сейва, как `AntivirusTiers`.
- Нынешние политики `make sim` (greedy/idle/random, `--policy all`) — исходы и деньги байт-в-байт.

## Review Focus

- Офис, где одновременно сломанное заражённое место и другие заражённые: сначала здоровые заражённые, потом ремонт, после ремонта то же место — снова первым на чистку (`TestAdminQueueBrokenInfected`).
- Игрок и админ в одном тике: клик игрока между тиками дочистил место — админ не кликает «в пустоту», клик уходит следующей цели; журнал «вручную» (`TestAdminAndPlayerClicksAddUp`).
- Увольнение админа в день найма после обеда: компенсация $100, зарплата сегодня не начисляется (`TestFireAdminSameDayAfterLunch`).
- Офлайн, начавшийся за 1 тик до конца дня, с 12 заражёнными и поломкой N=15: всё вычищено в первом полном офлайн-дне, дальше дни целые (`TestAdminOfflineBacklogFirstFullDay`).
- Прогноз сходится с фактом вечера при выключенных поломках и событиях (`TestAdminForecastMatchesEvening`).

---

### Task 1: Найм, увольнение, зарплата, конфиг, сейв

**Files:**
- Create: `server/internal/game/admin.go`, `server/internal/game/admin_test.go`
- Modify: `server/internal/game/config.go`, `office.go`, `commands.go`, `game.go` (`PayrollPerDay`), `difficulty.go`, `save.go`, `offline.go` (`offlineTemplate`, `resetForNextDay`), `commands.go` (`NextDay`)

**Interfaces:**
- Produces: `Config.AdminPrice`, `Config.AdminSalaryPerDay`, `Config.AdminClicksPerTick` (defaults 600 / 300 / 2); `Office.Admin string` ("" — нет), `Office.AdminUnpaidToday bool`, `Office.AdminHireDay int`; `ErrAdminAlready = Err("admin_already")`, `ErrNoAdmin = Err("no_admin")`; `CmdHireAdmin = Command("hire_admin")`, `CmdFireAdmin = Command("fire_admin")`; `func (g *Game) HireAdmin(office int) error`, `func (g *Game) FireAdmin(office int) error`, `func (g *Game) AdminFireCompensation(office int) int`.

- [ ] **Step 1: Write failing tests** in `admin_test.go`: `TestHireAdmin` (−$600, имя роллится, `admin_already` на втором, `not_enough_money`, `office_locked`, в `TotalEmployees` и `Network` не входит), `TestAdminPayroll` (+$300 в `PayrollPerDay`; нанят с 15:00 — `AdminUnpaidToday`, сегодня 0, после `NextDay` — 300), `TestFireAdmin` (`no_admin`; компенсация 300, в день найма 100 → `TestFireAdminSameDayAfterLunch`; после увольнения ФОТ без админа), `TestAdminDifficultyScaling` (hard/hardcore/easy: цена ×PriceK, зарплата ×WageK через `ConfigForDifficulty`), `TestAdminSaveRoundtrip` (Export/Restore хранит Admin/AdminUnpaidToday/AdminHireDay; `Config.AdminPrice == 0` в сейве → бэкфилл уровня).
- [ ] **Step 2: Run** `cd server && go test ./internal/game -run Admin` — FAIL (нет символов).
- [ ] **Step 3: Implement.** Найм — по образцу `HireBoss` (`spend(CmdHireAdmin, …)`, `rollName`, `hiredAfterLunch`); увольнение — `spend(CmdFireAdmin, comp)`; `PayrollPerDay` прибавляет зарплату, как у начальника; сбросы `AdminUnpaidToday` там же, где `BossUnpaidToday` (`NextDay`, `offlineTemplate`, `resetForNextDay`); `Apply` — два `case`.
- [ ] **Step 4: Run** `go test ./internal/game` — PASS.
- [ ] **Step 5: Commit** (одним коммитом с задачами 2–6 — см. «Коммит»).

### Task 2: Работа админа в тике, журнал, отчёт дня

**Files:**
- Modify: `admin.go`, `virus.go` (`virusSettled`, `cleanPC`), `commands.go` (`Fire`, `RepairClick`), `game.go` (`Tick`, `DayReport`), `save.go`, `commands.go`/`offline.go` (сброс дневных счётчиков рядом с `DayIncidents`)
- Test: `admin_test.go`

**Interfaces:**
- Consumes: Task 1.
- Produces: `func (o *Office) adminWork(cfg Config, clicks int) (repaired, cleaned int)` — только места; `func (o *Office) AdminTarget() (slot int, kind string)` — `-1, ""` / `slot, "virus"` / `slot, "repair"`; `func (g *Game) adminTick(by cleaner)`; `type cleaner int` с `cleanedSilent`, `cleanedByHand`, `cleanedByAdmin`; `virusSettled(oi int, by cleaner)`; `Game.DayAdminRepairs`, `Game.DayAdminCleaned` (+ поля `Save`); `DayReport.AdminRepairs`, `DayReport.AdminCleaned`.

- [ ] **Step 1: Write failing tests:** `TestAdminQueueVirusFirst` (заражённые 2 и 7 + сломанное 4: клики идут в 2, потом 7, потом 4), `TestAdminTwoClicksPerTick` (поломка N=9 чинится за 5 тиков, три заражённых — за 5), `TestAdminSpareClickCarries` (место с `VirusClicks=2`: один клик дочищает, второй — следующему), `TestAdminPreemptsRepair` (вспышка посреди ремонта: клики ремонта остаются, админ на вирусе), `TestAdminQueueBrokenInfected`, `TestAdminAndPlayerClicksAddUp`, `TestAdminWorksAtLunch`, `TestAdminOwnOfficeOnly`, `TestAdminJournal` («вычищен админом к HH:MM»; клик игрока — «вручную»; увольнение заражённого — без строки), `TestAdminClosesVirusCardAndTimer` (офис чист → карточка закрыта, заражённых нет → `VirusWaveIn == 0`), `TestAdminDayReportCounts` (`AdminRepairs`/`AdminCleaned` за день, ноль после `NextDay`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `adminWork` — цикл по `clicks`: цель по `AdminTarget`, нет цели — выход; ремонт и чистка — те же счётчики, что у `RepairClick`/`VirusClick` (вынести общие `repairStep(e) bool` и `virusStep(cfg, e) bool` — «готово»). `adminTick` в `Tick` после `activateEvents`; для каждого офиса с вычищенным местом — `virusSettled(oi, by)`. `cleanPC` получает `by cleaner`; `VirusClick` → `cleanedByHand`, `Fire` → `cleanedSilent`.
- [ ] **Step 4: Run** `go test ./internal/game` — PASS (старые тесты вируса тоже: текст «вручную» не меняется).

### Task 3: Прогноз, офлайн, карточка вируса

**Files:**
- Modify: `admin.go`, `game.go` (`ForecastEndOfDay`), `offline.go` (`AdvanceOffline`), `events.go` (`ActiveEventInfo`)
- Test: `admin_test.go`

**Interfaces:**
- Consumes: Task 2.
- Produces: `func (g *Game) seatsCopy() *Game` — копия игры со своими `Offices[i].Employees`; `func (g *Game) offlineIncome(lo, hi int) int` — по тику `adminTick(cleanedSilent)` + `incomeAtTick`; `func (g *Game) adminsBusy() bool`; `func (g *Game) adminDoneTicks(oi int) int` — тиков до чистоты офиса по очереди (0 — уже чист, `-1` — нет админа).

- [ ] **Step 1: Write failing tests:** `TestAdminForecastMatchesEvening`, `TestAdminForecastNoAdminUnchanged` (без админа — старое число), `TestAdminOfflineRepairsInTail`, `TestAdminOfflineBacklogFirstFullDay`, `TestAdminOfflineNoAdminUnchanged` (существующие офлайн-тесты остаются зелёными), `TestAdminVirusCardLine` (время — тик последнего клика админа: вспышка из трёх мест в тике 12 (12:00), админ кликает в тиках 12–16 → « Админ офиса вычистит сам к 12:40.»; без админа строки нет; переход через 19:00 — утреннее время, как `VirusWaveClock`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Прогноз: при `hasAdmin` цикл идёт по `seatsCopy()`, на каждом тике сначала `adminWork` по офисам копии, потом доход (обед — без дохода, работа идёт). Офлайн: хвост и частичный день — `offlineIncome` на живой игре; полные дни — если `tpl.adminsBusy()`, первый день считается `tpl.offlineIncome(0, dayTicks)`, места шаблона переносятся в живую игру (`PCBroken`, `RepairClicks`, `RepairNeeded`, `Infected`, `VirusClicks`), `virusSettled(oi, cleanedSilent)` по офисам админов, шаблон пересобирается (за день очередь всегда пуста: максимум 15 + 12×3 = 51 клик < 108).
- [ ] **Step 4: Run** `go test ./internal/game` — PASS.

### Task 4: Протокол, ws, зеркало клиента

**Files:**
- Modify: `server/internal/ws/protocol.go`, `server/internal/ws/session.go` (`dayReportMsg`), `client/src/protocol.ts`, ошибки клиента (`not_infected` рядом — `admin_already`, `no_admin`), `client/src/debug/contract.gen.ts` (генерация)
- Create: `server/internal/ws/admin_test.go`

**Interfaces:**
- Produces (JSON): `officeInfo.admin` (string), `officeInfo.adminUnpaidToday`, `officeInfo.adminSlot` (int, −1 — свободен/нет), `officeInfo.adminKind` (`"repair"|"virus"|""`), `officeInfo.adminFirePrice`; `state.adminSalaryPerDay`; `prices.admin`; `dayReport.adminRepairs`, `dayReport.adminCleaned`; команды `hire_admin`, `fire_admin`.

- [ ] **Step 1: Write failing tests** `server/internal/ws/admin_test.go`: снапшот с админом (поля выше, цель меняется после тика), `day_report` со счётчиками, журнал партии с `hire_admin`, работой админа и `fire_admin` реплеится байт-в-байт (по образцу `ws/virus_test.go`).
- [ ] **Step 2: Run** `go test ./internal/ws -run Admin` — FAIL.
- [ ] **Step 3: Implement** поля и маппинг; `protocol.ts` — те же поля, команды в списке команд, коды ошибок и их тексты; `cd client && npm run gen:contract`.
- [ ] **Step 4: Run** `cd server && go test ./...`, `cd client && npm run check:contract && npm test` — PASS.

### Task 5: `make sim` — политики `handsoff` и `delegate`

**Files:**
- Modify: `server/cmd/sim/policy.go`, `server/cmd/sim/main.go`

**Interfaces:**
- Produces: `handsoffPolicy` — greedy без кликов ремонта и чистки (мотивация остаётся); `delegatePolicy` — `handsoff` + `hire_admin` в офис с ≥ 4 сотрудниками, когда `affordable(g, AdminPrice)`. `--policy all` по-прежнему greedy/idle/random.

- [ ] **Step 1:** снять базу до правок: `make sim ARGS="--seed 1..300 --days 30 --policy all"` и то же с `--diff hard` → scratchpad.
- [ ] **Step 2: Implement** политики; `greedyPolicy` разбить так, чтобы клики ремонта/чистки были флагом, а не копией функции.
- [ ] **Step 3: Run** те же команды — вывод `all` совпадает с базой байт-в-байт; `--policy handsoff` и `--policy delegate` на normal/hard — цифры в коммит и development.md.

### Task 6: Документация и гейты

**Files:**
- Modify: `docs/development.md` (раздел про вирус/поломки — админ; сейв; `make sim` политики), `docs/superpowers/plans/2026-10-17-admins-server.md` (галочки)

- [ ] **Step 1:** `cd server && go vet ./... && go test ./...`; `make build`; `cd client && npm test && npm run qa:contract && npm run qa:slots && npm run qa:hud && npm run qa:buttons && npm run qa:party && npm run qa:journal`; visreg — эталоны не тронуты.
- [ ] **Step 2: Коммит** `feat(game): admins … — ITGAME-101 A (server)` со всеми задачами, в теле — цифры sim и прогоны гейтов.
