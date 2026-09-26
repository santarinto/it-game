# Development

Operations and testing reference. What the game is and how to run it — see
the README; game design — `docs/design/gdd.md`.

## Deploy

Production runs on a single box: nginx (TLS, static files, `/ws`, `/admin`
behind basic auth) → Go binary on `127.0.0.1:8080`, systemd unit `itgame`.

A deploy is triggered by an HMAC-signed webhook (`bin/trigger-deploy.sh`).
The box builds an atomic release with `bin/deploy-local.sh`:
`releases/<id>` → swap the `current` symlink → `systemctl restart itgame`.
A failed build leaves the running release untouched.

- **GitHub Actions** — the `deploy` job runs on pushes to `main` after the
  `server` and `client` jobs pass, deploys the tested SHA and smoke-tests
  production. It is enabled by the `DEPLOY_HOOK_SECRET` repository secret;
  without it the job skips with a warning. A SHA that `main` has already
  moved past is not deployed. "Run workflow" on `main` deploys manually.
- **Manually:** `DEPLOY_HOOK_SECRET=… bin/trigger-deploy.sh <sha>`.

Notes:

- `npm run build` runs `check-sprites.mjs`, which decodes PNGs with pngjs —
  no Chromium needed for the box to build (Chromium is only for
  `smoke-ui`/`qa:*`/`visreg`, see [Tests](#tests)).
- Releases are built from `git archive` (no `.git`), so the build stamp
  (`<meta name="build">`, `itd.version`) reads `dev` instead of a SHA.
- A deploy drops live WebSocket connections; saves live in `shared/saves`,
  and clients reconnect and resume.
- nginx must not SPA-fallback `/assets/`, or a missing asset returns
  `index.html` with 200:

  ```nginx
  location /assets/ {
      try_files $uri =404;
  }
  ```

- Sourcemaps are built as `hidden` (`dist/assets/*.map`, not referenced
  from the bundle). The Go server serves them only when
  `ITGAME_SOURCEMAP_TOKEN` is set: `/assets/app.js.map?token=…`.

## Sessions and saves

A session is keyed by the client's `sid` (localStorage, `/ws?sid=`). The
server saves after every command and tick — in memory plus an atomically
written `<sid>.json`. On reconnect with the same `sid` within the TTL
(default 24 h, `-save-ttl`):

- the game resumes; a short drop (e.g. a deploy) continues silently;
- missed time is simulated offline with a summary formula (no coffee rolls,
  events, breakdowns or XP; lunch and amenity debuffs apply; session speed
  applies, pause freezes). A day or more away produces a "while you were
  away" report; bankruptcy or victory can happen offline;
- game endings and `abandon` delete the save; another tab with the same
  `sid` takes the session over and the old one is closed with
  `session_taken`.

Save directory: `-saves` flag → `ITGAME_SAVES_DIR` →
`/opt/itgame/shared/saves` (if it exists) → `./saves`. `-saves off` runs
stateless. Expired saves are purged on start and on access.

## Agent bridge `/ws/agent`

`ws://host/ws/agent?sid=…[&seed=][&scenario=][&difficulty=]` drives a
session without a browser. It speaks the client protocol plus:
`{"type":"status"}` → `agent_status` (role, phase, server version, seed);
`debug_patch` / `debug_advance` / `debug_step` / `debug_scenario` →
`agent_result` (mirrors `/api/debug/*`). The agent never takes a live
session: it attaches as an observer, or runs a headless one if none exists;
a player connecting takes the headless session over. Neither the bridge
nor `/api/debug/*` is gated yet.

Its browser-side counterpart is the `window.itd` facade — see
[Debug API](#debug-api-windowitd).

## Debug API (`window.itd`)

Client-only tooling, cosmetic for players and unknown to the server — two
independent gates:

- **`?debug=1`** (query string, shareable, survives reload — `debug.enabled`
  in `client/src/debug.ts`). Sole effect: a red frame around every
  interactive sprite (click-zone bounds). While set, the HUD shows a
  `dbg on/off` toggle (`btn.debug`); turning it off strips `?debug=1` from
  the URL via `history.replaceState` (ITGAME-22 — no unexplained "debug"
  wording shown to ordinary players otherwise).
- **`window.itd`** itself (`installAgentApi`, `client/src/debug/agentApi.ts`)
  — present in dev builds unconditionally; in a prod build only behind
  `?debug=1` or `localStorage['itd.debug'] === '1'`. This is separate from
  `window.__itd`, which `main.ts` always sets to the raw `Phaser.Game`
  instance regardless of build or flags — QA scripts poll
  `window.__itd.scene.isActive(...)` to detect that the app booted, then use
  `window.itd.*` for everything else.

**«Админка» link** (ITGAME-22): shown over the canvas only to the owner —
always under `?debug=1`, otherwise gated by `localStorage.itd.admin` (set
once via `?admin=1`, cleared via `?admin=0`; the `admin` query param is
stripped immediately after reading, so a shared link with the flag doesn't
linger in the URL). Cosmetic only: `/admin` on production is behind nginx
basic auth regardless.

`itd.help()` prints the full command reference in the console. Worth
documenting separately:

- **`itd.nodes()` / `itd.ids()`** — every object of the live scenes
  (`{scene, type, id, text, x, y, w, h, visible, alpha, interactive, depth,
  active}`) / just the stable interactive ids (`btn.*`, `nav.*`, `office.*`,
  `room.*`, `menu.*`, `modal.*`). `active` (ITGAME-38) is a
  `setData('active', …)` flag scenes set on toggle-like objects (speed
  buttons, nav tabs, the debug toggle, checkboxes, zoom) — distinct from
  Phaser's own `GameObject.active` — `null` for anything that isn't a
  toggle.
- **`itd.overlaps()`** — the layout linter; each finding carries a `kind`
  (ITGAME-38): `text` (two same-depth texts), `occlusion` (text under an
  opaque plate), or `interactive` (an interactive container/sprite/checkbox
  partly covered by another interactive or by text — full containment
  doesn't count).
- **`itd.log(n)`** — the ring buffer (200 entries, survives a console
  clear) of state/day/phase/speed/scene transitions, server errors and page
  errors, plus, since ITGAME-38, every `playSfx` call and HUD toast
  (`{type:'sound', key, name, volume, scene, ok}` /
  `{type:'toast', text, where, ms, bg, scene}`), routed through
  `client/src/uibus.ts`.
- **`itd.trace(action, windowMs)`** (ITGAME-37) is a *live* subscription,
  not a slice of `log()`/`net()`: it wires up listeners before `action` runs
  and keeps them for `windowMs` ms (0..10000, default 1000) after `action`
  finishes, so it never misses an event that happens between two
  `itd.*()` reads. Reports the keys the scene received (DOM or `itd.key()`,
  with the handling scene), the commands sent to the server in send order,
  non-state server replies (`error`, `day_report`, …), phase/speed/day/scene
  transitions, and the toasts/sounds that fired — enough to assert on a
  real player action end-to-end without polling `state()`/`net()` by hand.
- **`itd.contract()`** (ITGAME-39) returns the facade's API as data — every
  `window.itd` method/property (name, params, return type), every
  referenced type (`AgentNode`, `CmdReceipt`, `AgentServer`, …), the
  `ServerErrorCode`/`CommandType` enums, and a `version.hash` (12 hex
  chars) — quote this in acceptance reports instead of paraphrasing
  `itd.help()`. Generated by `client/scripts/gen-contract.mjs` from the
  `ItdApi` interface (`client/src/debug/agentApi.ts`) via the TypeScript
  compiler API into the committed `client/src/debug/contract.gen.ts` —
  `npm run gen:contract` to regenerate, `npm run check:contract` to verify
  without writing. `npm run build` runs the check first: it fails if
  `ItdApi` and `contract.gen.ts` disagree (a `satisfies` type over
  `contract.gen.ts` also catches this at `tsc` time — an added or removed
  facade member is a type error, not just a stale-file warning), and it
  cross-checks `SERVER_ERROR_CODES`/`COMMAND_TYPES` (`client/src/protocol.ts`)
  against the Go source (`../server/internal/**/*.go`), naming any
  mismatched code or command and the file it came from. Every `ItdApi`
  member needs a JSDoc comment (an `@example` tag is recommended) — the
  generator refuses to run without one.

## Tests

    make test         # Go (DB tests need TEST_DATABASE_URL, otherwise SKIP)
    make typecheck    # client type check
    make smoke-ui     # built client in headless Chromium: menu starts, clean console
    make sim ARGS=…   # headless balance runs
    cd client && npm run visreg   # screenshot and layout regressions

Chromium is used by `npm run build`, `smoke-ui` and `visreg`; scripts look
for `CHROME_PATH`, then `/usr/bin/chromium`, `/usr/bin/chromium-browser`,
`/usr/bin/google-chrome-stable`.

**Smoke test.** `npm run smoke-ui -- <url>` checks any URL; `OFFICE=1` also
starts a game and checks the office scene (needs a live server). Boot
enforces the sprite contract, so a broken asset fails the smoke test.
Screenshots: `client/smoke-*.png` (gitignored).

**QA scripts** (`client/scripts/qa-*.mjs`, `visreg.mjs`) drive a built
client with headless Chromium via the `window.itd`/`window.__itd` facade
(see [Debug API](#debug-api-windowitd)):

| Command | Checks | Port (`QA_PORT`/…) |
|---|---|---|
| `npm run qa:meta` | stats/achievements modals | :4173, `vite preview` — needs a Go server already on :8080 |
| `npm run qa:buttons` | HUD buy-button enabled/tooltip/alpha states | :4173, `vite preview` — same |
| `npm run qa:tabs` | multi-tab session takeover (ITGAME-35) | :4179, self-serve + temp saves dir |
| `npm run qa:hud` | HUD layout column, toast stack, no overlaps (ITGAME-16) | :4174, self-serve |
| `npm run qa:facade` | `window.itd` `active`/`log()`/`overlaps()` kind (ITGAME-38) | :4175, self-serve |
| `npm run qa:slots` | office/server-room slot rendering — lunch, boss, gateway | :4177, self-serve |
| `npm run qa:trace` | `itd.trace()` live window (ITGAME-37) | :4176, self-serve |
| `npm run qa:contract` | `itd.contract()` shape/hash (ITGAME-39) | :4178, self-serve |
| `npm run smoke-ui` | menu boots, clean console; `OFFICE=1` + live WS → office scene | :4173, `vite preview` |
| `npm run visreg` | screenshot diff + layout linter per fixture scenario | :4173, self-serve, `VISREG_PORT` overrides |

`qa:hud`/`qa:facade`/`qa:slots`/`qa:trace`/`qa:contract`/`qa:tabs`/`visreg`
share `client/scripts/lib/selfserve.mjs`: it builds/runs `bin/itdirector`
over `client/dist`, refuses to start when its port is already taken by
another process, and verifies after boot that the server actually answers
with the local `client/dist` build (not someone else's) — a busy port fails
loudly instead of running the suite against the wrong server. `qa:tabs`
additionally self-serves with a temporary saves directory, since its
session-takeover scenario needs a real saves store (`-saves off` won't do).
`qa:meta`/`qa:buttons`/`smoke-ui` instead self-serve a plain `vite preview`
over `dist` on :4173, which proxies `/ws`/`/admin`/`/api` to
`localhost:8080` (`vite.config.ts`) — so `qa:meta`/`qa:buttons` need a Go
server already running there for their gameplay checks to pass; `QA_BASE`/
`BASE_URL` points any script at an already-running server instead.

**Live protocol checks** — a real WebSocket client against a running server:

    cd server && go run ./cmd/server -addr :8091 &
    node scripts/live-check-saves.mjs            # saves, reconnect
    OFFLINE=1 node scripts/live-check-saves.mjs  # + offline catch-up (~70 s)
    node scripts/live-check-activeday.mjs        # active day
    node scripts/live-check-events.mjs           # random events (SEED=3 by default)
    node scripts/live-check-employees2.mjs       # employees
    node scripts/live-check-difficulty2.mjs      # difficulty rules (SEED=3 by default)

Each exits 0 with a final "… ОК". `live-check-events` and
`live-check-difficulty2` pin a seed (`SEED=…` overrides), so runs are
reproducible. `scripts/live-check.mjs` is outdated (expects old prices and
targets) and fails.

**sim** (`server/cmd/sim`) plays games with the real engine, e.g.
`make sim ARGS="--diff hardcore --seed 1..50 --days 30 --policy all --out runs.csv"`.
Policies: `greedy`, `idle`, `random`. CSV:
`policy,seed,day,money,income,payroll,events,outcome`, one row per day;
the last row holds the outcome (`bankrupt | deadlock | victory | time_up |
timeout`). Reference: normal + greedy ≈ 70% bankrupt by day 30,
easy + greedy ≈ 2/3 wins.

**visreg** loads each fixture scenario (`?scenario=X&seed=1&debug=1`) and the
menu, screenshots the canvas and diffs it against
`client/scripts/visreg/shots/` (>0.5% differing pixels fails), and runs the
layout linter (`itd.overlaps()` — see [Debug API](#debug-api-windowitd) —
plus offscreen/contrast/tiny), which must not be worse than
`baseline.json`. Update baselines after intended UI changes: `npm run
visreg -- --update`, then commit.

Baselines are machine-dependent (system `monospace` font, GPU rasterizer):
the committed baseline was last regenerated **2026-09-26** on a Claude Code
cloud-session container (headless Chromium 1194, SwiftShader software GL)
— expect diffs when running visreg on a different machine or GPU driver.
Kill stray Chromium processes before a run — they starve software WebGL.
In CI, visreg is a report, not a gate (see [CI](#ci)).

## CI

`.github/workflows/ci.yml` runs on pull requests, pushes to `main` and
manual dispatch:

- **server** — `go vet`, `go test` with a Postgres 16 service container,
  sim report in the job summary (non-blocking);
- **client** — `npm ci`, typecheck, build, menu smoke test, then the Go
  server over `dist`: office smoke test, `live-check-saves` and
  `live-check-difficulty2`;
- **visreg** — report only; on mismatch it uploads screenshots taken on the
  runner (`visreg-ci-shots`) that can be adopted as baselines before
  making the job blocking;
- **deploy** — see [Deploy](#deploy).

## Claude Code cloud sessions

`.claude/hooks/session-start.sh` (runs only when `CLAUDE_CODE_REMOTE=true`)
prepares a fresh container: Go modules, `npm ci`, `CHROME_PATH`, and a
local PostgreSQL with role `itd` and databases `itdirector` /
`itdirector_test`; it exports `DATABASE_URL` and `TEST_DATABASE_URL`.

## Database

PostgreSQL is optional: gameplay and saves don't use it. It backs the
`/admin` page (current balance config and the `lib_equipment` catalog).

Put `DATABASE_URL=postgres://user:pass@localhost:5432/itdirector` into
`.env` in the repo root (gitignored); the `Makefile` loads it and exports
`DATABASE_URL` / `TEST_DATABASE_URL`. With `DATABASE_URL` set, the server
connects on start and applies migrations from
`server/internal/db/migrations` (tracked in `schema_migrations`); a
connection or migration error is fatal. Without it, the server starts
normally and `/admin` shows a database-unavailable notice instead of the
catalog.

## Rendering

The world stays 1280×720 (`GAME_W`/`GAME_H`, `layout.ts`) and every
`itd`/debug coordinate (bounds, click, overlaps) is still in those world
units — only the canvas is bigger. `client/src/render.ts` renders at 2×
(`RENDER_SCALE`): the canvas is `GAME_W*RENDER_SCALE × GAME_H*RENDER_SCALE`,
and each scene's camera (`HIRES_CAMERA`, passed as `super({ key, cameras })`
so a scene restart keeps it) uses `zoom: RENDER_SCALE, roundPixels: true,
scrollX: -GAME_W*(RENDER_SCALE-1)/2, scrollY: -GAME_H*(RENDER_SCALE-1)/2` —
the only combination that both zooms in and keeps `camera.worldView` at
`(0,0,1280,720)` (`CameraManager.fromJSON` always resets `roundPixels` to
`false` unless the scene config sets it explicitly). HD sprites are in use
today: `desk_pc`/`desk_pc_off`/`desk_pc_broken`, `desk_empty` and
`worker`/`worker_1..3` are 128px `hd32` art (see the sprite manifest below)
drawn at ×0.5 into 64-world-px slots — `spriteScale()` computes that factor
from the texture's real width against `SPRITE_TARGET` (`pixelart.ts`), so at
2× render one texture texel lands on exactly one canvas pixel. Also for
crisp text under CSS zoom.

Every `Text` object needs its own `resolution` (Phaser defaults it to 1
regardless of camera zoom), so `installHiResText()` patches
`GameObjectFactory.prototype.text` (the only place the codebase creates
text) to inject `resolution: RENDER_SCALE` before any scene runs.
`uiscale.ts`'s "zoom" stays CSS px per world px; `setCssZoom(game, z)`
divides by `RENDER_SCALE` before calling `game.scale.setZoom` (the canvas
is already `RENDER_SCALE` bigger) and toggles
`canvas.style.imageRendering`: `pixelated` normally, `auto` (bilinear) once
the effective downscale (`cssZoom * devicePixelRatio / RENDER_SCALE`) drops
below 1, since nearest sampling then tears text strokes. `?rs=1` disables
all of this for A/B comparisons and low-end machines (canvas back to 1:1
with the world).

Caveat for future code: a camera-relative object (e.g. a future
`setScrollFactor(0)` HUD element) will drift, because the camera now has a
non-zero scroll purely to recentre the zoom — it no longer maps world
`(0,0)` to camera-local `(0,0)`.

## Assets

Sprites come from a dev-time AI pipeline; the game itself is fully offline
and the finished PNGs are committed.

- **Generate:** `scripts/gen-sprites.sh` — PixelLab API v2, fields checked
  against `/v2/openapi.json`. `--balance` (free) → `--dry-run [--engine
  pixen|pixflux|bitforge] [--hd] <key>` prints the request without calling
  the API → a real run writes raw PNG/JSON and the remapped PNG to
  `OUT_DIR` (a fresh `mktemp -d` by default, never `client/public`) →
  review the PNGs → `--install <key> <file>` re-checks the file against the
  manifest contract and only then copies it to
  `client/public/assets/sprites/<key>.png`. Size/palette come from the
  manifest per key (unchanged for the 14 current 64px keys); `--hd`, or a
  key the manifest doesn't have yet, defaults to 128px/`hd32`/isometric and
  reads `scripts/sprites/prompts-hd.txt`. Per-engine size caps are enforced
  before the request (`pixen` ≤768, multiple of 4, area ≤512×512;
  `pixflux` ≤400; `bitforge` ≤200). `--lock-palette` (on by default for
  pixflux/bitforge, unavailable for pixen — warns instead of failing)
  builds a 1px-tall PNG strip from the key's manifest palette and sends it
  as `color_image` to force that palette; `--no-lock-palette` disables it.
  Other pass-through flags: `--view`, `--outline`, `--shading`
  (pixflux/bitforge only), `--detail`, `--direction`, `--negative`,
  `--guidance` (pixflux/bitforge only), `--seed`, `--style-strength`
  (bitforge, integer 0..100, default 40). `MAX_GENERATIONS` (default 20)
  hard-stops real generation calls per session. `SPRITES_API_KEY` is only
  required for a real call or `--balance`.
- **Remap:** `client/scripts/sprite-remap.mjs` (pngjs — no ImageMagick, it
  isn't installed in the container): alpha-threshold → nearest-palette
  quantize (redmean) → optional despeckle → bbox → center/bottom-place on
  a `size`×`size` canvas, or an exact top-left `--place X,Y` (optionally
  mirrored first with `--flip-x`) — the two flags used to align two HD
  sprites onto the same slot point, see the HD pipeline below. No
  resampling, except an exact integer `--downscale-nearest` factor. Shares
  its contract check with `check-sprites.mjs` via
  `client/scripts/lib/sprite-check.mjs`.
- **Edit:** `scripts/sprite-edit.sh <name> "<instruction>"` — Gemini
  (`GEMINI_IMAGE_MODEL`, default `gemini-2.5-flash-image`) → remap;
  overwrites the tracked PNG only if the result passes the contract.
- **Keys** in `.env`: `SPRITES_API_KEY` (PixelLab), `GEMINI_API_KEY`.
- **Contract:** transparent PNGs in the key's palette, no baked-in
  checkerboard — see the sprite manifest below; boot re-checks sizes.
- **Review:** silhouette readability via the local LocalMind vision model
  (`localmind_recognize` MCP), touch-ups in Aseprite.
- **Sound:** SFX from [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds)
  (CC0) in `client/public/assets/sfx/`, played by `client/src/audio.ts`.
  Every `playSfx` call and HUD toast reaches `itd.log()` via
  `client/src/uibus.ts` — see [Debug API](#debug-api-windowitd).
- `client/src/pixelart.ts` generates fallback textures for any sprite
  without a PNG.

### HD sprite pipeline

`scripts/sprites/hd-src/` holds the raw generations (`desk_pc.raw.png`,
`worker.raw.png`) plus `desk_empty.png`, a hand-edited source (not a
generation — see below). `scripts/sprites/build-hd.sh` deterministically
rebuilds every HD asset from those sources with no network and no AI: it
calls `sprite-remap.mjs` (`--flip-x`/`--place` bake the worker's mirror and
its manual chair-to-chair alignment onto `desk_pc` into the PNG) and
`client/scripts/sprite-recolor.mjs` — a one-line CLI, hex→hex replacement
inside an optional `--region`, used for the monitor-screen states
(`desk_pc`/`_off`/`_broken`) and the worker's shirt-color levels
(`worker_1..3`). Run `scripts/sprites/build-hd.sh` (no args), then
`cd client && node scripts/check-sprites.mjs`.

What actually produced usable art (prompts and detail in
`scripts/sprites/prompts-hd.txt`): pixflux, `--hd` (`--size 128 --palette
hd32 --lock-palette`), outline "single color black outline", shading
"medium shading", detail "medium detail", for `desk_pc`; the same engine/
palette/outline/shading/detail for `worker`, but `--size 80 --direction
north-west` — it faced right, so `build-hd.sh` mirrors it with `--flip-x`.
`desk_empty` was never generated: pixflux with the anchor seed draws a
computer and chair even with "no computer, no chair" in the prompt
(negations in prompt text are ignored by the model), and `--negative`
(`negative_description`) twice came back as a 502
upstream error that still charged a generation with no image produced.
`desk_empty.png` is instead a deterministic pixel edit of `desk_pc.raw.png`
(monitor/keyboard/mouse/chair erased, the desk surface/edge/right-cabinet
pixels they covered restored from the desk's isometric geometry), remapped
like any other HD source. Other gotchas: bitforge's `style_image` must be
exactly the output's size or the API returns 500, and a style_image crop of
the desk made bitforge draw a desk into the `worker` despite "no desk" in
the prompt — the reference drags its composition along. Check the credit balance
with `scripts/gen-sprites.sh --balance` before and after a batch of
generations.

### Sprite manifest

`client/src/assets/sprites.json` is the single source of truth for AI
sprites: `BootScene` loads its keys, `check-sprites.mjs` checks them, scenes
scale by them. `client/src/assets/manifest.ts` adds types, `AI_SPRITES`,
`SWEETIE16` and `spriteKey()`. Per key:

- `size`, `frames` — the PNG is exactly `size·frames × size` (frames side by
  side; `frames > 1` is registered as a spritesheet).
- `palette` — `sweetie16` (the remaining 64px art) or `hd32` (Sweetie-16 plus
  16 in-between shades) — no longer reserved, it's what the HD desk/worker
  keys below actually use.
- `class` — target on-screen size from `SPRITE_TARGET` in
  `client/src/pixelart.ts`; `addSprite()` scales from frame 0.
- `includesDesk` — the sprite draws its own desk. `false` (today's HD
  `worker`, 128px): the slot draws `desk_pc`/`desk_pc_off`/`desk_pc_broken`
  underneath and the worker on top at the same point (`OfficeScene.ts`'s
  `SLOT_LAYOUT_HD`, sized from the HD sprites' opaque-pixel bbox). `true` is
  legacy: an old 64px `worker.png` with the desk baked into the same PNG —
  an occupied slot then shows only it, no `desk_pc` underneath
  (`SLOT_LAYOUT_LEGACY`, sized for that fuller 64×64 frame instead).
- `fallback` — texture to use if this one is missing (`boss` → `worker`,
  `gateway` → `router`); `aliases` maps alternate names the same way.
  `desk_pc_off`/`desk_pc_broken` fall back to `desk_pc`, `worker_1..3` to
  `worker`.
- `maxSpecks`, `maxWhitePct`, `note` — per-key thresholds with the reason.

State keys for the desk/worker slot: `desk_pc` (screen lit — an occupied
workspace, and also what lunch shows), `desk_pc_off` (a PC bought but no
employee assigned yet), `desk_pc_broken` (a breakdown), and `worker_1..3`
for employee level 1..3 (`worker` itself is level 0) — see
[Assets](#assets) above for how the states/levels are produced.

A new key ships only together with its PNG and vice versa: a key without a
file 404s at boot and fails `smoke-ui`.

`check-sprites.mjs` (part of `npm run build`) decodes PNGs with pngjs, no
browser needed. It fails on: key ⇄ file mismatch, dangling
`aliases`/`fallback`, `hd32` not a superset of `sweetie16` or over 32
colors, wrong size, colors outside the key's palette, <5% transparency,
semi-transparent pixels, too much `#f4f4f4`, and noise — 8-connected
opaque components of area ≤ `4·(size/64)²` beyond `maxSpecks` (default 0).
`desk_empty` is no longer an exception (it's a pixel edit of `desk_pc`, not
a generation with baked-in checkerboard); only `office_floor_tile` (4)
still carries one today — its count is recorded, the art is left for
regeneration.

`npm run qa:slots` (see [Tests](#tests)) checks slot rendering on
`full_office`: each occupied desk draws `worker`/`worker_N` (by employee
level) over exactly one `desk_pc`/`desk_pc_broken` at the same point, `boss`
and `gateway` textures land in their slots, lunch turns a slot into a single
`desk_pc` with no employee plus the «обед» label, a breakdown shows
`desk_pc_broken`, and real mouse clicks on a broken PC's repair zone send
`repair_click`, not `motivate`.
