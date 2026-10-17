# Отдел админов: покупка комнаты (ITGAME-101) и клиент (ITGAME-145) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Админы сидят в своей комнате «Отдел админов» — вкладка «АДМ» рядом с «СРВ», закрыта и покупается, как офис; админ закреплён за офисом, нанимается в комнате отдела. Плюс клиент админов: тултип места, отчёт дня, глушение гонки клика.

**Architecture:** Сервер: флаг `Game.AdminDept`, команда `buy_admin_dept`, `HireAdmin` без отдела отказывает. Клиент: новая сцена `adminDept` по образцу `ServerRoomScene` (колонка действий — найм по офисам), вкладка в навигации HUD по образцу офисов 2/3 (замок, цена).

**Tech Stack:** Go (server/internal/game, ws, cmd/sim), TypeScript + Phaser (client/src), QA на puppeteer (client/scripts).

**Spec:** `docs/design/gdd.md` «Админы (ITGAME-101)» + решения владельца 17.10 (в этой сессии): у админов свой отдел — комната, покупается; админ закреплён за офисом; позже там шкафы с оборудованием и верстаки.

## Global Constraints

- Отдел: **$3,000** ×PriceK (зов исполнителя, как шлюз — инфраструктура середины партии), один на компанию, `admin_dept_already`; найм без отдела — `admin_dept_locked`.
- Найм — только в комнате отдела, по офисам: кнопки колонки `btn.admin.0..2` «Админ О1 $600»; кнопки в офисе нет.
- Вкладка «АДМ» пятой в навигации (`nav.adminDept`), закрыта — замок и цена, открыта — «k/3» (нанято админов).
- Ремонт/чистка, очередь, цена и зарплата админа — без изменений (c3fa86b).
- В офисе: строка тултипа места «чинит админ» / «чистит админ», когда `office.adminSlot === i`.
- Отчёт дня: «Админы:    k ПК, m мест» под «Вирус», если за день что-то сделано.
- Ошибки `not_infected` / `not_broken` в офисе с админом — без тоста и звука (гонка с тиком админа).

## Review Focus

- Покупка отдела в долг / без денег — `not_enough_money`, отдел не открыт.
- Найм в закрытый офис из комнаты отдела — кнопка выключена с причиной, клик ничего не шлёт.
- Вкладка «АДМ» при смене партии (`itd.scenario`) и после «Продолжить» — сцена `adminDept` гасится, как `serverRoom`.
- Тултип места с админом, который чинит другое место — строки нет.
- itd.overlaps() / offscreen() в комнате отдела при трёх админах и длинных именах.

---

### Task 1: Сервер — покупка отдела (ITGAME-101)

**Files:** `server/internal/game/{config,difficulty,admin,commands,save}.go`, `admin_test.go`; `server/internal/ws/protocol.go`, `admin_test.go`; `server/cmd/sim/policy.go`; `client/src/protocol.ts`, `scenes/HUDScene.ts` (тексты ошибок), контракт; `docs/design/gdd.md`, `docs/development.md`.

**Produces:** `Config.AdminDeptPrice` (3000), `Game.AdminDept bool` (+ сейв), `CmdBuyAdminDept = "buy_admin_dept"`, `func (g *Game) BuyAdminDept() error`, `ErrAdminDeptAlready`, `ErrAdminDeptLocked`; протокол `state.adminDept`, `prices.adminDept`.

- [ ] Тесты: `TestBuyAdminDept` (−$3,000, повтор — `admin_dept_already`, без денег — `not_enough_money`, Apply), `TestHireAdminNeedsDept` (`admin_dept_locked` до покупки), масштаб цены по уровням, сейв; ws: снапшот `adminDept`/`prices.adminDept`; старые тесты админа — `adminGame` покупает отдел.
- [ ] Реализация; `delegate` покупает отдел перед первым наймом; перемер sim, цифры в GDD/development.md.
- [ ] `go vet`, `go test ./...`, `npm run gen:contract`, `npm test`; коммит `ITGAME-101`.

### Task 2: Клиент — комната отдела, вкладка, тултип, отчёт (ITGAME-145)

**Files:** Create `client/src/scenes/AdminDeptScene.ts`; Modify `client/src/main.ts`, `scenes/HUDScene.ts` (навигация, отчёт, ошибки, сброс сцены), `scenes/OfficeScene.ts` (тултип места), `debug/agentApi.ts` (`itd.state()`: `adminDept`, `admins`), фикстура `server/internal/game/fixtures/admin_dept.json`, QA-скрипт `client/scripts/qa-itgame145.mjs` + `package.json` `qa:admins`, `docs/development.md`.

- [ ] Комната закрыта: «Отдел админов закрыт», кнопка `dept.buy` «Купить отдел — $3,000» (как `office.buy`), строка о том, что даёт отдел.
- [ ] Комната открыта: «ОТДЕЛ АДМИНОВ»; три места по офисам (`dept.admin.N`): бокс 92×92, «офис N» над ним, спрайт `worker` (до своего — графика отдельно), имя и строка «чинит место 5» / «чистит место 3» / «свободен» под ним; офис не куплен — бокс затемнён, «офис не куплен»; наведение — тултип (имя, зарплата, правило, цель); ПКМ — «Уволить админа?» с компенсацией.
- [ ] Колонка действий: `btn.admin.0..2` «Админ О1\n$600» / «Админ О1 ✓», выключены с причиной (офис не куплен / не хватает $X / нанят).
- [ ] Вкладка «АДМ» (`nav.adminDept`): замок и цена, открыта — «k/3»; `highlightNav`, `switchRoom`, сброс сцены при смене партии.
- [ ] Тултип места в офисе; строка отчёта; глушение `not_infected`/`not_broken` в офисе с админом; `itd.state()`.
- [ ] Фикстура `admin_dept`: день 5, 11:00, два офиса, отдел куплен, админ офиса 1 на сломанном месте и двух заражённых, офис 2 без админа.
- [ ] QA `qa:admins`: настоящие клики — вкладка, покупка отдела, найм, строка цели меняется вживую, тултип, ПКМ-увольнение, выключенные кнопки ничего не шлют, строка отчёта, тултип места в офисе, тост гонки не показывается; overlaps/offscreen пусты на 1× и 1.4×.
- [ ] visreg: вкладка «АДМ» меняет все кадры — эталоны перезаписать осознанно, добавить кадр `admin_dept`; остальные гейты (`qa:slots/hud/buttons/party/journal/contract`) зелёные.
- [ ] Коммит `ITGAME-145`.
