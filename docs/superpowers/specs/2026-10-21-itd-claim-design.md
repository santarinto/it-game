# `itd.claim` — the agent's tab is visibly taken, foreign presses are counted

Tracker: ITGAME-151. Design approved by the owner on 21.10.2026. Related: ITGAME-152 (`itd.ask`, blocked by
this task), ITGAME-153 (`itd.tap`, synthetic clicks), ITGAME-164 (brief v14 queue).

## Problem

In the 17.10 wave the human pressed inside the browser agent's tab three times (54 pointer events in one block,
then play in the sandbox after the hand-check) and once looked at their own tab instead of the agent's. That cost
about 35 agent calls and a full re-run. The manual isolation from brief v13 (set `document.title` by hand, open an
`itd.trace` window per item, compare the `down` count with the agent's own clicks) works, but costs 2 actions per
item and the human does not see it at the moment of the click. The 17.10 acceptance of 101/145 again spent about 6
stop/start calls counting foreign input.

## Goal

One call per run puts a visible bar on the agent's tab and counts every press in it, split into the agent's own,
the human's allowed («нажми сам») and foreign ones. A «нажми сам» item is scored by the machine: which object
Phaser gave the human's press to. The state survives F5.

## Decisions taken with the owner

- **The agent's own real clicks are declared, not guessed.** Claude in Chrome clicks through CDP, so its events
  carry `isTrusted: true`, like a human's. Before its own real click the agent calls `itd.claim.mine()`; the next
  press within the window is `own`. Heuristics (no `mousemove` before `down`) were rejected as unreliable.
- **«нажми сам» has a target.** `itd.claim.allow(what, {target})` names the object id; the claim records `got`
  (who Phaser handed the press to) and reports `hit`.
- **The frozen brief v13 is not edited.** The rewritten isolation rule goes into the ITGAME-164 queue for v14.

## API

All members live on `window.itd`, so they exist only where `itd` is installed (dev build, `?debug=1`,
`localStorage itd.debug = '1'`).

```ts
interface ClaimApi {
  (label: string): ClaimState | ClaimRefusal
  mine(n?: number, ms?: number): { ok: true; pending: number; ms: number } | ClaimRefusal
  allow(what: string, opts?: { target?: string }): ClaimState | ClaimRefusal
  deny(): ClaimAllowResult | ClaimRefusal
  state(): ClaimState | { ok: true; active: false }
  stop(): ClaimState | ClaimRefusal
}
```

- `itd.claim(label)` — `label` is a non-empty string of at most 40 characters, otherwise `{ok: false, code:
  'bad_label'}`. It shows the bar and sets the tab title to `▶ АГЕНТ — смотри, не кликай`. While a claim is
  active a second call keeps every counter and only replaces the label; fresh counters need `stop()` first.
- `itd.claim.mine(n = 1, ms = 20000)` — the next `n` trusted presses within `ms` milliseconds are the agent's
  (`own`). A new call replaces the pending budget. `n` is an integer 1..20, `ms` an integer 100..120000, otherwise
  `bad_args`. 20 s covers the 7–9 s between agent calls with room for a batch.
- `itd.claim.allow(what, {target?})` — turns the bar green with `▶ ТВОЙ ХОД: <what> — только это`; presses now
  count as `allowed`. `what` is a non-empty string (≤ 80 characters); `target` is an object id in either form
  (`btn.hire` or `btn:hire`) and is normalized to the safe form with `:`. A new `allow` while one is open closes the
  previous window first (its result is dropped from the return value but kept in `presses`).
- `itd.claim.deny()` — closes the allow window, turns the bar yellow again and returns the window's verdict:
  `{what, target, presses: ClaimPress[], hit}`, where `presses` are the allowed presses of this window and `hit` is
  `true` if `target` is in the `got` of any of them, `false` if not, `null` without a target. Without an open window:
  `{ok: false, code: 'no_allow'}`.
- `itd.claim.state()` — the current state, or `{active: false}` without a claim.
- `itd.claim.stop()` — removes the bar and the listeners, deletes the sessionStorage record, sets the title to
  `вкладка свободна` and returns the final state (`active: false` in it).

Every method except `claim(label)` and `state()` refuses with `{ok: false, code: 'no_claim'}` when no claim is
active.

```ts
interface ClaimState {
  ok: true
  active: boolean
  label: string
  sha: string            // itd.version.sha of the tab
  sec: number            // seconds since claim()
  downs: number          // trusted presses: own + allowed + foreign
  own: number
  allowed: number
  foreign: number
  synthetic: number      // isTrusted === false (dispatchEvent, future itd.tap), not in downs
  onCanvas: number       // trusted presses whose target was the game canvas
  reloads: number        // page loads the claim survived
  mine: { pending: number; leftMs: number } | null
  allow: { what: string; target: string | null; since: number; from: number; hit: boolean | null } | null
                         // since — seconds since claim(); from — presses with n > from belong to this window
  presses: ClaimPress[]  // the last 50 trusted presses, oldest first
}

interface ClaimPress {
  n: number              // press number since claim(), shared by own, allowed and foreign
  t: number              // seconds since claim(), one decimal
  kind: 'own' | 'allowed' | 'foreign'
  button: number
  onCanvas: boolean
  wins: string | null    // Phaser hit-test winner in the trace label form (safe id or type)
  got: string[]          // objects Phaser handed the press to, same labels as itd.trace
}
```

## The bar

- A `div#itd-claim` with `data-mode` = `claim` | `allow` | `foreign`, `position: fixed; top: 0; left: 0; right: 0; height: 40px; z-index: 100000;
  pointer-events: none`, bold 20px monospace, centered. It does not enter the layout, so `#app`, the canvas rect and
  `uiscale` stay unchanged.
- Yellow `#f5c542` (claim), green `#51cf66` (allow), red `#ff6b6b` for 600 ms on a foreign press, then back to the
  current color.
- Text: `▶ АГЕНТ работает в этой вкладке (<label>, <sha>) — не кликай`; in allow mode
  `▶ ТВОЙ ХОД: <what> — только это`.
- It covers the debug `#topbar` (build stamp, «устарело, обнови», «Админка»), as in the probe the owner saw. Those
  stay clickable under the bar because it takes no pointer events.

## Counting presses

- Listeners on `window`, capture phase: `pointerdown`, `mousedown`. A touch is counted by its `pointerdown`; the
  compatibility `mousedown` that follows a touch (`sourceCapabilities.firesTouchEvents`) is ignored.
- `isTrusted === false` → `synthetic += 1`, nothing else.
- Events of one physical press arrive as a group (pointerdown → mousedown). Events within 50 ms of the group's
  first one join it; the group is one press. Synthetic events are grouped the same way, separately.
- The press is classified on its first event, in this order:
  1. a `mine` budget is pending and not expired → `own`, budget − 1;
  2. an allow window is open → `allowed`;
  3. otherwise → `foreign`, the bar flashes red.
- `onCanvas` is `event.target === game.canvas`.
- `wins` and `got` are armed on the group's first event: the same probe as `itd.trace` — the hit-test at the event
  point, then one-shot `GAMEOBJECT_POINTER_DOWN` listeners on the hit objects, removed by `setTimeout(0)` after
  Phaser has handled the `mousedown`/`touchstart` that the browser dispatches in the same task (Phaser 3.90 in this
  build listens to mouse and touch events, not pointer events).
  A press off the canvas keeps `wins: null, got: []`.
- After each press the record is written to sessionStorage.

## Surviving F5

- sessionStorage key `itd.claim` holds `{label, sha, at, counters, mine, allow, presses}`; it goes through the
  `sessionStore` wrapper of `client/src/storage.ts`.
- The active claim writes the record again on `pagehide`, so `itd.reset()` (which clears every `itd.*` key) followed
  by a reload keeps the claim.
- `installAgentApi` restores an existing record immediately (before Phaser `READY`): the bar, the title, the
  listeners; `reloads += 1`, `sha` becomes the reloaded tab's. `sec` keeps counting from the original `at`; an expired `mine` budget is dropped.
- Presses between the page start and the restore are not counted; the record says so only through `reloads`.

## Code layout

- `client/src/debug/claimCore.ts` — pure logic without Phaser or DOM: the state type, `addPress` (classification), grouping by the
  50 ms window, `mine` expiry, `allow`/`deny` verdict, target normalization, the 50-press cap, serialize/parse of
  the record. Unit-tested from `client/scripts/lib/claim.test.mjs` (Node runs the `.ts` directly, so no enums or
  parameter properties).
- `client/src/debug/claim.ts` — the DOM part: the bar, the title, the listeners, sessionStorage, the Phaser probe;
  builds `ClaimApi` as `Object.assign(call, {mine, allow, deny, state, stop})`, like `sandbox.ts`.
- `client/src/debug/trace.ts` — the `got` probe (hit-test plus one-shot `GAMEOBJECT_POINTER_DOWN/UP` listeners,
  flushed on the next event or `setTimeout(0)`) moves into a small shared helper used by both trace and claim;
  trace behaviour does not change (`qa:trace` stays green).
- `client/src/debug/agentApi.ts` — `readonly claim: ClaimApi` in `ItdApi` with JSDoc and `@example` lines; the
  member in the `api` literal; restore call in `installAgentApi`; help lines for `claim`, `claim.mine`,
  `claim.allow`, `claim.deny`, `claim.state`, `claim.stop`.
- `client/src/debug/contract.gen.ts` — regenerated by `npm run gen:contract`.

## Tests

- **Unit** (`npm test`): classification order (own before allowed before foreign), `mine` budget decrements and
  expires, grouping joins pointerdown+mousedown and separates presses 60 ms apart, synthetic events do not count,
  `deny` verdict with and without target, target normalization `a.b` → `a:b`, the 50-press cap, record round trip.
- **`qa:claim`** (`client/scripts/qa-itgame151.mjs`, puppeteer on its own `selfServe` server :4198, like `qa:trace`):
  1. `claim('qa')` → bar present, `pointer-events: none`, title set, the canvas rect equal to the one before.
  2. `page.mouse.click` on the canvas without `mine` → `foreign: 1`, `downs: 1` (one click is one press), the bar
     is red right after the click.
  3. `mine()` then a click → `own: 1`, `foreign` unchanged.
  4. `mine(1, 200)`, wait 400 ms, click → `foreign` grows.
  5. `dispatchEvent(new MouseEvent('mousedown'))` → `synthetic: 1`, `downs` unchanged.
  6. `allow('нажми «Нормально»', {target: 'menu.diff.normal'})`, click that button → `allowed: 1`, `deny().hit ===
     true`, its press has `got` containing `menu:diff:normal`; a second window with a click on the `#build` stamp under
     the bar → `hit === false`, `onCanvas: false` (clicks pass through the bar).
  7. Reload → bar back, counters kept, `reloads: 1`.
  8. `itd.reset()` + reload → bar back, `reloads: 2`.
  9. `stop()` → bar gone, title `вкладка свободна`, sessionStorage `itd.claim` absent, `state().active === false`.
  10. No `pageerror` during the run.
- **`qa:contract`**: `claim` is in the contract and on `window.itd`; add a check that `ClaimApi.call` takes one
  parameter and `claim.mine/allow/deny/state/stop` are functions (as A11 does for trace and sandbox).
- `npm run build` (contract check, `tsc`), `npm test`, `qa:trace`, `qa:facade`.

## Documentation and the agent's rules

- `docs/development.md`, section «Debug API (`window.itd`)»: a bullet on `itd.claim` next to `itd.sandbox(label)`.
- `.claude/skills/generate-qa-promt-for-it-game/SKILL.md`, «Добивка человеком»: the isolation goes through
  `itd.claim` (one call per run, `mine()` before each own real click, `allow(…, {target})` for «нажми сам», `stop()`
  instead of «вкладка свободна» by hand); the trace-window recipe stays only as a fallback for a tab without the
  new build.
- `.claude/skills/generate-retro-promt-for-it-game/SKILL.md`: the `itd.claim` row moves from «в плане ITGAME-151» to
  «есть с <date>».
- ITGAME-164: a queue item for brief v14 — section 8 «Твою вкладку видит и человек» rewritten on `itd.claim`.

## Out of scope

- `itd.ask` (ITGAME-152) and `itd.tap` (ITGAME-153).
- Another tab of the same address does not see the bar; the claim lives in one tab's sessionStorage.
- Keyboard and wheel input are not counted (the retro counted presses only).
