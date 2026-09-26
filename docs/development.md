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

- `npm run build` runs `check-sprites.mjs`, so the box needs Chromium
  (`CHROME_PATH` or `/usr/bin/chromium`).
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

**Live protocol checks** — a real WebSocket client against a running server:

    cd server && go run ./cmd/server -addr :8091 &
    node scripts/live-check-saves.mjs            # saves, reconnect
    OFFLINE=1 node scripts/live-check-saves.mjs  # + offline catch-up (~70 s)
    node scripts/live-check-activeday.mjs        # active day
    node scripts/live-check-events.mjs           # random events (SEED=3 by default)
    node scripts/live-check-employees2.mjs       # employees
    node scripts/live-check-difficulty2.mjs      # difficulty rules

Each exits 0 with a final "… ОК". `live-check-difficulty2` depends on an
income roll and occasionally fails — rerun it. `scripts/live-check.mjs` is
outdated (expects old prices and targets) and fails.

**sim** (`server/cmd/sim`) plays games with the real engine, e.g.
`make sim ARGS="--diff hardcore --seed 1..50 --days 30 --policy all --out runs.csv"`.
Policies: `greedy`, `idle`, `random`. CSV:
`policy,seed,day,money,income,payroll,events,outcome`, one row per day;
the last row holds the outcome (`bankrupt | deadlock | victory | time_up |
timeout`). Reference: normal + greedy ≈ 70% bankrupt by day 30,
easy + greedy ≈ 2/3 wins.

**visreg** loads each fixture scenario (`?scenario=X&seed=1&debug=1`) and the
menu, screenshots the canvas and diffs it against
`client/scripts/visreg/shots/` (>0.5% differing pixels fails); the layout
linter (overlaps, offscreen, contrast, tiny) must not be worse than
`baseline.json`. Without `BASE_URL` it serves the build itself on :4173.
Update baselines after intended UI changes: `npm run visreg -- --update`,
then commit. Baselines depend on the machine (system `monospace` font);
kill stray Chromium processes before a run — they starve software WebGL.

## CI

`.github/workflows/ci.yml` runs on pull requests, pushes to `main` and
manual dispatch:

- **server** — `go vet`, `go test` with a Postgres 16 service container,
  sim report in the job summary (non-blocking);
- **client** — `npm ci`, typecheck, build, menu smoke test, then the Go
  server over `dist`: office smoke test and `live-check-saves`;
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

## Assets

Sprites come from a dev-time AI pipeline; the game itself is fully offline
and the finished PNGs are committed.

- **Generate:** `scripts/gen-sprites.sh [name]` — prompts from
  `scripts/sprites/prompts.txt` → PixelLab API (64×64, transparent, stable
  seed per name) → `scripts/sprites/remap.sh` (downscale + Sweetie-16
  palette) → `client/public/assets/sprites/`. Optional `SPRITES_SIZE`
  (default 64), `SPRITES_OUT`.
- **Edit:** `scripts/sprite-edit.sh <name> "<instruction>"` — Gemini
  (`GEMINI_IMAGE_MODEL`, default `gemini-2.5-flash-image`) → remap to 64 px.
- **Keys** in `.env`: `SPRITES_API_KEY` (PixelLab), `GEMINI_API_KEY`.
- **Contract:** every PNG is 64×64, transparent, Sweetie-16, with no baked-in
  checkerboard — enforced by `client/scripts/check-sprites.mjs` in
  `npm run build`; boot re-checks size and transparency.
- **Review:** silhouette readability via the local LocalMind vision model
  (`localmind_recognize` MCP), touch-ups in Aseprite.
- **Sound:** SFX from [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds)
  (CC0) in `client/public/assets/sfx/`, played by `client/src/audio.ts`.
- `client/src/pixelart.ts` generates fallback textures for any sprite
  without a PNG.
