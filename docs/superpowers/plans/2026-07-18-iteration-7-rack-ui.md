# Итерация 7 (мини) — план реализации: админка, стойки, схема 24U

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Три UI-правки без изменений сервера: заметная кнопка «Админка», переименование core/серверов в термины игрока («стойка роутеров» / «серверная стойка»), схема «24U СТОЙКА» в модалках обеих стоек.

**Architecture:** Клиент — TypeScript + Phaser 3, тонкий: рисует снапшоты, шлёт команды. Схема 24U — опциональный параметр `scheme` у единого компонента модалки `showModal` (`client/src/ui/modal.ts`); при его наличии панель расширяется и слева рисуется колонка юнитов. Сцены передают scheme только для двух модалок стоек. Go-сервер и протокол не меняются.

**Tech Stack:** TypeScript, Phaser 3, Vite.

**Spec:** `docs/superpowers/specs/2026-07-13-iteration-7-rack-ui-design.md` — читать при сомнениях, она первична.

## Global Constraints

- Идентификаторы кода и протокола (`core`, `servers`, команды `upgrade_core`/`buy_server`/`upgrade_server`) НЕ переименовываются — меняются только строки UI и документация.
- Go-код не трогается вообще; серверные тесты не запускаются и не меняются.
- Палитра: фон пустого юнита `#232640`, рамка `#3a3f5c`, занятый юнит `#38b764`, акцент `#41a6f6`, панель `#14162b`.
- Схема — всегда 24 юнита, заполняется снизу вверх, юниты НЕ интерактивны (debug-рамок на них быть не должно — не вызывать `setInteractive`).
- Заполнение: офисная стойка `filled = level * 8` (эквивалент `level / 3 * 24`: ур.1 = 8U, ур.2 = 16U, ур.3 = 24U, пустая = 0U); стойка роутеров `filled = Math.round(level / 5 * 24)` (ур.1 = 5U, ур.2 = 10U, ур.3 = 14U, ур.4 = 19U, ур.5 = 24U, не куплена = 0U).
- Модалка роутера в офисе (`OfficeScene`) и модалки HUD (отчёт/банкротство) вызывают `showModal` без scheme — их вид меняться не должен (параметр опционален, их код не трогаем).
- Проверка клиента: `cd client && npm run typecheck` (тестового фреймворка на клиенте нет; спека требует typecheck + живой браузерный смоук).
- Комментарии в коде — по-русски, объясняют «почему», не «что».
- Коммиты — после каждой задачи, сообщения по-русски в стиле репо (`feat(client): …`, `docs: …`).

---

### Task 1: Заметная кнопка «Админка» в DOM-шапке

**Files:**
- Modify: `client/index.html:10-12`

**Interfaces:**
- Consumes: ничего.
- Produces: ничего для других задач — чисто CSS.

- [ ] **Step 1: Заменить стили ссылки на кнопочные**

В `client/index.html` заменить два правила `#topbar a` / `#topbar a:hover`:

```html
      #topbar { text-align: right; padding: 4px 16px; }
      #topbar a {
        display: inline-block;
        color: #41a6f6; font-family: monospace; font-size: 15px; text-decoration: none;
        background: #232640; border: 1px solid #3a3f5c; border-radius: 4px;
        padding: 4px 12px;
      }
      #topbar a:hover { background: #3b5dc9; color: #f4f4f4; }
```

Разметка (`<div id="topbar"><a href="/admin" target="_blank">Админка</a></div>`) и поведение (`/admin` в новой вкладке) не меняются. Канвас не трогается.

- [ ] **Step 2: Проверить typecheck (не сломали сборку)**

Run: `cd client && npm run typecheck`
Expected: без ошибок (HTML тайпчек не задевает — это smoke, что окружение живо).

- [ ] **Step 3: Визуальная проверка**

Run: `make dev` из корня, открыть `http://localhost:5173`.
Expected: справа сверху над канвасом — кнопка «Админка» (синий текст 15px на тёмном фоне с рамкой и скруглением); при наведении фон `#3b5dc9`, текст светлеет; клик открывает `/admin` в новой вкладке.

- [ ] **Step 4: Commit**

```bash
git add client/index.html
git commit -m "feat(client): ссылка «Админка» оформлена заметной кнопкой"
```

---

### Task 2: `modal.ts` — опциональная схема «24U СТОЙКА»

**Files:**
- Modify: `client/src/ui/modal.ts`

**Interfaces:**
- Consumes: существующий `showModal(scene, title, lines, buttons)` и его вызовы (остаются валидными — новый параметр опционален).
- Produces (на это опирается Task 4):

```ts
export interface ModalScheme {
  filled: number // занятых юнитов
  total: number // всего юнитов (всегда 24)
}

export function showModal(
  scene: Phaser.Scene,
  title: string,
  lines: string[],
  buttons: ModalButton[],
  scheme?: ModalScheme,
): () => void
```

- [ ] **Step 1: Переписать `showModal` с поддержкой scheme**

Полное новое содержимое `client/src/ui/modal.ts`:

```ts
import Phaser from 'phaser'
import { GAME_H, GAME_W } from '../layout'
import { drawDebugFrames } from '../debug'

export interface ModalButton {
  label: string
  onClick: () => void
}

// Схема заполнения стойки: filled из total юнитов заняты.
// Заполнение снизу вверх — железо ставят с нижних юнитов.
export interface ModalScheme {
  filled: number // занятых юнитов
  total: number // всего юнитов (всегда 24)
}

const UNIT_W = 96 // ширина юнита в схеме
const UNIT_H = 10 // высота юнита
const UNIT_GAP = 2 // зазор между юнитами

// Единый шаблон модалок устройств (роутер, сервер, core): подложка,
// панель, заголовок, строки, кнопки действий. Клик по действию шлёт
// команду и закрывает модалку — новое состояние придёт снапшотом.
// Со scheme панель шире, слева — вертикальная схема «24U СТОЙКА»,
// текст и кнопки сдвинуты вправо от неё.
export function showModal(
  scene: Phaser.Scene,
  title: string,
  lines: string[],
  buttons: ModalButton[],
  scheme?: ModalScheme,
): () => void {
  const objs: Phaser.GameObjects.GameObject[] = []
  const close = () => objs.splice(0).forEach((o) => o.destroy())
  const cx = GAME_W / 2
  const cy = GAME_H / 2 - 40
  // заголовок схемы + колонка юнитов + подпись «NU занято»
  const rackH = scheme ? 24 + scheme.total * (UNIT_H + UNIT_GAP) + 22 : 0
  const panelW = scheme ? 620 : 460
  const panelH = Math.max(110 + lines.length * 26 + buttons.length * 46, rackH ? rackH + 40 : 0)
  const shift = scheme ? 90 : 0 // сдвиг текста и кнопок вправо от схемы
  // Подложка interactive: глушит клики по сцене; клик по ней закрывает.
  const overlay = scene.add.rectangle(0, 0, GAME_W, GAME_H, 0x1a1c2c, 0.75).setOrigin(0).setDepth(70).setInteractive()
  overlay.on('pointerdown', close)
  // Панель тоже interactive: topOnly-ввод Phaser не пропустит клик к подложке.
  const panel = scene.add.rectangle(cx, cy, panelW, panelH, 0x14162b).setStrokeStyle(2, 0x41a6f6).setDepth(71).setInteractive()
  const titleText = scene.add
    .text(cx + shift, cy - panelH / 2 + 26, title, { fontFamily: 'monospace', fontSize: '18px', color: '#ffcd75' })
    .setOrigin(0.5).setDepth(72)
  const closeX = scene.add
    .text(cx + panelW / 2 - 20, cy - panelH / 2 + 26, '✕', { fontFamily: 'monospace', fontSize: '16px', color: '#5d7275' })
    .setOrigin(0.5).setDepth(72).setInteractive({ useHandCursor: true })
  closeX.on('pointerdown', close)
  const body = scene.add
    .text(cx + shift, cy - panelH / 2 + 56, lines.join('\n'), {
      fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4', lineSpacing: 8, align: 'center',
    })
    .setOrigin(0.5, 0).setDepth(72)
  objs.push(overlay, panel, titleText, closeX, body)
  if (scheme) {
    const rx = cx - panelW / 2 + 78 // ось колонки юнитов
    const top = cy - rackH / 2
    objs.push(
      scene.add.text(rx, top, '24U СТОЙКА', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' })
        .setOrigin(0.5, 0).setDepth(72),
    )
    for (let u = 0; u < scheme.total; u++) {
      // u — номер юнита снизу вверх: железо ставят с нижних юнитов
      const uy = top + 24 + (scheme.total - 1 - u) * (UNIT_H + UNIT_GAP)
      if (u < scheme.filled) {
        objs.push(scene.add.rectangle(rx, uy, UNIT_W, UNIT_H, 0x38b764).setOrigin(0.5, 0).setDepth(72))
        // тёмные «диски» — декор занятой плашки
        for (let d = 0; d < 3; d++) {
          objs.push(scene.add.circle(rx - 30 + d * 10, uy + UNIT_H / 2, 2, 0x14162b).setDepth(73))
        }
      } else {
        objs.push(
          scene.add.rectangle(rx, uy, UNIT_W, UNIT_H, 0x232640).setOrigin(0.5, 0).setDepth(72)
            .setStrokeStyle(1, 0x3a3f5c),
        )
      }
    }
    objs.push(
      scene.add.text(rx, top + 24 + scheme.total * (UNIT_H + UNIT_GAP) + 6, `${scheme.filled}U занято`, {
        fontFamily: 'monospace', fontSize: '12px', color: '#41a6f6',
      }).setOrigin(0.5, 0).setDepth(72),
    )
  }
  buttons.forEach((b, i) => {
    const by = cy + panelH / 2 - 26 - (buttons.length - 1 - i) * 46
    const bg = scene.add.rectangle(cx + shift - 110, by - 17, 220, 34, 0x3b5dc9).setOrigin(0).setDepth(72)
      .setInteractive({ useHandCursor: true })
    const txt = scene.add
      .text(cx + shift, by, b.label, { fontFamily: 'monospace', fontSize: '14px', color: '#f4f4f4' })
      .setOrigin(0.5).setDepth(73)
    bg.on('pointerdown', () => {
      b.onClick()
      close()
    })
    bg.on('pointerover', () => bg.setFillStyle(0x41a6f6))
    bg.on('pointerout', () => bg.setFillStyle(0x3b5dc9))
    objs.push(bg, txt)
  })
  objs.push(...drawDebugFrames(scene, objs))
  return close
}
```

Заметки для исполнителя:

- Юниты схемы НЕ получают `setInteractive` — `drawDebugFrames` рамит только интерактивные объекты, так что debug-рамок на схеме не будет (требование спеки).
- Без scheme всё поведение прежнее с одним отличием: `closeX` теперь позиционируется от `panelW` (`cx + panelW / 2 - 20`); при `panelW = 460` это тот же `cx + 210`, что и раньше — регрессии нет.
- Геометрия: `rackH = 24 + 24 × 12 + 22 = 334`, панель со scheme `panelH ≥ 374` — при `GAME_H = 720` и `cy = 320` панель занимает ~133..507 по вертикали, под HUD (96px) помещается.

- [ ] **Step 2: Проверить typecheck**

Run: `cd client && npm run typecheck`
Expected: без ошибок (все существующие вызовы `showModal` без scheme валидны — параметр опционален).

- [ ] **Step 3: Визуальная проверка регрессии старых модалок**

Run: `make dev`, открыть клиент, кликнуть по роутеру в офисе.
Expected: модалка роутера выглядит как раньше (панель 460px, без схемы, текст по центру).

- [ ] **Step 4: Commit**

```bash
git add client/src/ui/modal.ts
git commit -m "feat(client): опциональная схема «24U СТОЙКА» в компоненте модалки"
```

---

### Task 3: Переименования в термины игрока (только строки UI)

**Files:**
- Modify: `client/src/scenes/ServerRoomScene.ts:44,107,121,136,147,155`
- Modify: `client/src/scenes/HUDScene.ts:27-28`

**Interfaces:**
- Consumes: ничего нового.
- Produces: ничего для других задач — только строковые литералы. Идентификаторы (`core`, `upgrade_core`, `buy_server`, `upgrade_server`, поля снапшота) НЕ трогать.

- [ ] **Step 1: ServerRoomScene — подпись слота core**

Строка 44, `'core'` → `'стойка роутеров'`:

```ts
      this.add.text(cx, cy - 60, 'стойка роутеров', { fontFamily: 'monospace', fontSize: '12px', color: '#5d7275' }).setOrigin(0.5),
```

- [ ] **Step 2: ServerRoomScene — строка статуса**

Строка 107, `` `core ${s.core.connected}/${s.core.capacity} · серверов ${totalServers}…` `` →

```ts
        `роутеры ${s.core.connected}/${s.core.capacity} · стоек ${totalServers}${s.gateway ? ' · интернет' : ''}`, {
```

- [ ] **Step 3: ServerRoomScene — заголовок занятой офисной стойки**

Строка 136, `` `Сервер ${sl + 1} — офис ${oi + 1}` `` →

```ts
    showModal(this, `Серверная стойка ${sl + 1} — офис ${oi + 1}`, lines, buttons)
```

Заголовок ПУСТОЙ стойки (строка 121, `` `Стойка ${sl + 1} — офис ${oi + 1}` ``) и текст «Сервер ур.1 даёт ×… четырём работникам офиса.» — БЕЗ изменений (спека: речь о сервере, который встанет в стойку).

- [ ] **Step 4: ServerRoomScene — модалка core**

Строки 147 и 155:

```ts
      : ['Стойка роутеров пуста — роутеры офисов', 'не достают до серверов.']
```

```ts
    showModal(this, 'Серверная стойка роутеров', lines, buttons)
```

- [ ] **Step 5: HUDScene — тексты ошибок**

Строки 27–28 (формулировки про стойки, не про core/сервер):

```ts
  server_maxed: 'Серверная стойка уже максимального уровня',
  core_maxed: 'Стойка роутеров уже максимального уровня',
```

- [ ] **Step 6: Проверить typecheck**

Run: `cd client && npm run typecheck`
Expected: без ошибок.

- [ ] **Step 7: Проверить, что идентификаторы не задеты**

Run: `cd client && grep -n "upgrade_core\|buy_server\|upgrade_server\|s\.core\." src/scenes/ServerRoomScene.ts | head`
Expected: команды и поля снапшота на месте, без переименований.

- [ ] **Step 8: Commit**

```bash
git add client/src/scenes/ServerRoomScene.ts client/src/scenes/HUDScene.ts
git commit -m "feat(client): термины игрока — стойка роутеров и серверная стойка"
```

---

### Task 4: Передача scheme в модалки обеих стоек

**Files:**
- Modify: `client/src/scenes/ServerRoomScene.ts` (методы `openServerModal`, `openCoreModal`)

**Interfaces:**
- Consumes: `showModal(scene, title, lines, buttons, scheme?)` из Task 2, заголовки из Task 3.
- Produces: ничего — конечный потребитель.

- [ ] **Step 1: openServerModal — scheme для пустой и занятой стойки**

Метод целиком после правки (заголовки уже из Task 3):

```ts
  private openServerModal(s: StateMessage, oi: number, sl: number) {
    const srv = s.offices[oi].servers[sl]
    if (!srv) {
      // buy_server ставит в первую пустую стойку; пустые стойки неотличимы,
      // поэтому неважно, по которой из них кликнули.
      const lvl1 = s.prices.serverLevels[0]
      showModal(this, `Стойка ${sl + 1} — офис ${oi + 1}`, [
        'Пустая стойка.',
        `Сервер ур.1 даёт ×${lvl1.mult.toFixed(1)}`,
        'четырём работникам офиса.',
      ], [{ label: `Купить ${fmtMoney(lvl1.price)}`, onClick: () => client.send('buy_server', oi) }],
      { filled: 0, total: 24 })
      return
    }
    const lines = [
      `Уровень ${srv.level} · множитель ×${srv.mult.toFixed(1)}`,
      `Обслуживает работников ${srv.servedFrom}–${srv.servedTo}`,
    ]
    if (srv.maxed) lines.push('Уровень максимальный')
    const buttons = srv.maxed
      ? []
      : [{ label: `Апгрейд ${fmtMoney(srv.nextPrice)}`, onClick: () => client.send('upgrade_server', oi, { slot: sl }) }]
    // level/3 от 24U: ур.1 = 8U, ур.2 = 16U, ур.3 = 24U
    showModal(this, `Серверная стойка ${sl + 1} — офис ${oi + 1}`, lines, buttons,
      { filled: srv.level * 8, total: 24 })
  }
```

- [ ] **Step 2: openCoreModal — scheme стойки роутеров**

Последняя строка метода:

```ts
    // level/5 от 24U: ур.1 = 5U, ур.2 = 10U, ур.3 = 14U, ур.4 = 19U, ур.5 = 24U
    showModal(this, 'Серверная стойка роутеров', lines, buttons,
      { filled: Math.round(c.level / 5 * 24), total: 24 })
```

- [ ] **Step 3: Проверить typecheck**

Run: `cd client && npm run typecheck`
Expected: без ошибок.

- [ ] **Step 4: Быстрая визуальная проверка**

Run: `make dev`, в серверной (значок «СРВ») кликнуть по пустой офисной стойке и по стойке роутеров.
Expected: обе модалки шире обычной, слева колонка «24U СТОЙКА» из 24 серых юнитов, снизу «0U занято»; текст и кнопка сдвинуты вправо. Модалка роутера в офисе — без схемы.

- [ ] **Step 5: Commit**

```bash
git add client/src/scenes/ServerRoomScene.ts
git commit -m "feat(client): схема 24U в модалках офисной стойки и стойки роутеров"
```

---

### Task 5: Документация — термины в GDD и README

**Files:**
- Modify: `docs/design/gdd.md` (раздел «Серверная», строки ~57-83)
- Modify: `README.md` (абзац про серверную, строки ~47-59)

**Interfaces:**
- Consumes: терминологию из спеки: «стойка роутеров (core)», «серверная стойка»; технический термин core остаётся в скобках как имя поля протокола.
- Produces: ничего.

- [ ] **Step 1: GDD — ввести термины в разделе «Серверная»**

В `docs/design/gdd.md`:

1. Пункт «**Сервер офиса, без стека**» переименовать в «**Серверная стойка (сервер офиса), без стека**» — остальной текст пункта не менять.
2. Пункт «**Core-коммутатор** — единственное устройство…» начать так: «**Стойка роутеров (core-коммутатор)** — в интерфейсе игрока называется „стойка роутеров“; технически это core, единственное устройство между офисными роутерами и серверами, общее на компанию.» — дальше текст пункта без изменений.

Упоминания `core` в остальном GDD (топология, формулы, таблица цен) НЕ переписывать — это технический термин протокола, он остаётся.

- [ ] **Step 2: README — термины игрока**

В `README.md` в абзаце «Серверная перестроена…» после слов «**core-коммутатор**, общий на компанию» добавить уточнение в скобках: «(в интерфейсе игрока — „стойка роутеров“; офисные серверы в интерфейсе называются „серверными стойками“)». Остальной текст абзаца не менять.

- [ ] **Step 3: Commit**

```bash
git add docs/design/gdd.md README.md
git commit -m "docs: термины «стойка роутеров (core)» и «серверная стойка» в GDD и README"
```

---

### Task 6: Живой браузерный смоук со скриншотами

**Files:**
- Временная правка (НЕ коммитить): `server/internal/game/config.go:69` — `StartMoney: 600` → `StartMoney: 999999`, чтобы докупиться до высоких уровней без гринда. После смоука откатить: `git checkout -- server/internal/game/config.go`.

**Interfaces:**
- Consumes: всё из Task 1–4.
- Produces: скриншоты в scratchpad для плейтеста пользователя.

- [ ] **Step 1: Поднять окружение с деньгами**

```bash
sed -i 's/StartMoney:   600/StartMoney:   999999/' server/internal/game/config.go
make dev
```

Открыть `http://localhost:5173` (Playwright).

- [ ] **Step 2: Скриншот кнопки «Админка»**

Expected: кнопка справа сверху, стиль из Task 1; клик открывает `/admin` в новой вкладке.

- [ ] **Step 3: Офисная стойка — уровни 0/1/3**

В серверной кликнуть по пустой стойке офиса 1 → скриншот (24 серых юнита, «0U занято»). Купить сервер, открыть модалку → скриншот (8 зелёных юнитов снизу, «8U занято», заголовок «Серверная стойка 1 — офис 1»). Дважды апгрейдить до ур.3 → скриншот (24 зелёных, «24U занято», кнопки апгрейда нет).

- [ ] **Step 4: Стойка роутеров — уровни 0/1/4/5**

Кликнуть по слоту «стойка роутеров» до покупки → скриншот («Серверная стойка роутеров», «Стойка роутеров пуста — роутеры офисов не достают до серверов.», 0U). Купить (ур.1) → 5U. Апгрейдить до ур.4 → 19U. До ур.5 → 24U, «Уровень максимальный». Скриншот на каждом из четырёх уровней.

- [ ] **Step 5: Проверить строку статуса и отсутствие регрессий**

Expected: внизу серверной `роутеры X/Y · стоек K · интернет`; модалка роутера в офисе — без схемы; при `?debug=1` на юнитах схемы красных рамок НЕТ (рамки только на интерактивных объектах модалки: подложка, панель, ✕, кнопки).

- [ ] **Step 6: Откатить временную правку и финальный typecheck**

```bash
git checkout -- server/internal/game/config.go
cd client && npm run typecheck
git status --short   # рабочее дерево чистое (кроме .idea/)
```

Expected: typecheck без ошибок, незакоммиченных правок нет. Скриншоты показать пользователю — мерж в main только после его плейтеста (правило рабочего цикла).
