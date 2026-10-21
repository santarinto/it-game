# Development

Operations and testing reference. What the game is and how to run it — see
the README; game design — `docs/design/gdd.md`.

## Deploy

Two instances run on one box (the game box `90.156.129.221` since 18.10,
MINIPC-256 / ITGAME-128 — Arch, 1 core, 869 MB RAM + 2 GB swap; the first
box ci-cd-srv died on 16.10), each behind nginx (TLS, static files, and a proxy to Go for
`/ws`, `/api/` and `/admin`) → Go binary: production on `127.0.0.1:8080`, systemd unit `itgame`, root
`/opt/itgame`, `https://itgame.santarinto.ru`; stage on `127.0.0.1:8081`,
unit `itgame-stage`, root `/opt/itgame-stage`,
`https://stage.itgame.santarinto.ru`. The box has docker but no Go or Node
toolchain. nginx, TLS and the box itself are the minipc repo's
(`deploy/itgame/`: vhosts, one Let's Encrypt certificate for both names,
certbot renewal, port 80 → ACME + 301 to https). `/admin` sits behind nginx
basic auth (`401` without credentials, checked 2026-10-18); the Go handler
itself has no auth.

A push to `main` deploys (since 08.10, MINIPC-206). The repo lives on
Forgejo (`git.lan.santarinto.com`; `make push` — it first deploys `main` to
the local stand with `git push stand main`, stops if that build fails, see
[Local stand](#local-stand-15555), then pushes the current branch to
`origin`), and every push to any
branch runs `.forgejo/workflows/ci.yaml`: the `test-server` and
`test-client` jobs (see [CI](#ci)), then — on `main` or a manual dispatch
only, and only when both are green — the `deploy` job on the host runner
`minipc-deploy`. The game box cannot reach `git.lan` (the home perimeter
admits no public inbound), so the job fetches the whole `main` and ships it
as a git bundle: per target, `ssh deploy-itgame-stage-feed < bundle` (the
forced command `deploy-feed-bundle` fetches `+refs/heads/main` from it into
the checkout's `refs/remotes/origin/main` — the bundle must carry the named
ref `main` and the full history) and then `ssh deploy-itgame-stage <mode>
<sha40>`; then the same for `deploy-itgame-feed` / `deploy-itgame` (`mode`
is `deploy` on a push). The loader's own `git fetch` fails as a WARNING and
its checks run against the fed refs; it only needs the sha to be reachable
from `origin/main`, so a bundle whose `main` ran ahead of the shipped sha
(a later push) is fine. The test jobs check out the sha the deploy ships —
the dispatch's `ref`, else the pushed commit — by `git fetch --depth 1
origin <sha>`, the deploy job checks it out of the full `main` it bundles
(ITGAME-105; before it the tests cloned the branch head by name, and a
quick second push could ship an untested commit). Stage goes first, fed and
deployed before production is fed; on a deploy a failed stage stops the job
before production. The job has `timeout-minutes: 40`: a full deploy is about
5 minutes per target on this box.

Runs are serialized per ref (`concurrency: ci-<ref>`, ITGAME-105). On
`main` `cancel-in-progress` is false: a second push waits for the first run,
deploy included, the runs finish in push order, and production ends on the
last push that passed its tests. On other branches a new push cancels the
older run. Without a `concurrency` block Forgejo (its v16 docs; the box runs
16.0.5) cancels the older push run on every branch, `main` included, so a
push could cut a deploy between stage and production — that is what `main`
had until ITGAME-105. Each ssh target
is a forced command of the platform loader (`deploy-project itgame-stage`,
`deploy-project itgame`) on the box, outside this repo: it fetches and
checks out the SHA and runs `tools/deploy` from that SHA's own tree, so
every commit ships its own recipe. `DEPLOY_ENABLED` in `ci.yaml` is the
latch: `"0"` makes the job report a skip and finish green with both targets
untouched. It was `"1"` from e3ea574 (08.10), `"0"` from 16.10 (the old
game-box stopped answering: ssh `10.8.1.33:49222` timed out in runs 15–18,
the last good deploy there is 5e741bd of 13.10) and `"1"` again since 18.10
on the new box (ITGAME-128).

`tools/deploy <deploy|rollback> <sha40> [--dry-run]` (contract v1) picks the
target by the checkout's basename (`itgame` or `itgame-stage`) and builds
`$ROOT/releases/<YYYYMMDD-HHMMSS>-<sha7>` from `git archive <sha>`: the
client in a throwaway `node:22` container with the whole release mounted
(`npm ci && npm run build`; `gen-contract --check` needs the sibling
`server/`), the server in `golang:1.26` (`go build -trimpath`), both with
bind-mounted caches under `/opt/itgame/cache`. Then it swaps the `current`
symlink atomically (`rename(2)`), restarts the unit and waits for HTTP 200
(30 tries, about 30 s when the vhost answers; each try has curl's 5 s
timeout, so a hung vhost takes longer) from the public vhost,
`https://itgame.santarinto.ru` or
`https://stage.itgame.santarinto.ru` (the raw port proves nothing: Go
answers 404 on `/` there — nginx owns the static — and 426 on `/ws`). It
keeps the last `KEEP=3` releases and never prunes `current`.

- **Failure before the swap** (archive, either build): `current` is not
  touched, the target keeps running its old release, the half-built one is
  removed (not when the server build leaves no `bin/itdirector`: that exit
  skips the cleanup and the release directory stays).
- **Failure after the swap** (no 200 in the health check): the target
  already runs the NEW release and the job fails loudly — roll back, don't
  redeploy blindly. If stage was green and production failed (either way),
  stage runs the new release and production the old or the broken new one
  until the next deploy or rollback.
- **Rollback:** «Run workflow» on `ci.yaml` in Forgejo Actions with
  `mode=rollback` and `ref=<sha40>` (required: an empty `ref` fails the job)
  of a commit whose release is still on the targets (each keeps its own last
  three; check on the box with
  `ls /opt/itgame/releases /opt/itgame-stage/releases | grep <sha7>`). It
  rolls back stage, then production, and production is rolled back even when
  stage fails (stage no longer holds that release); the job is red if either
  failed. Rollback never builds: it points `current` at the release whose
  directory name ends in that sha7 and restarts. The test jobs skip their
  steps on a rollback and pass, so a red branch head does not block it
  (ITGAME-105). «Run workflow» with `mode=deploy` (the default; an empty
  `ref` is the branch head) tests and deploys that sha by hand; dispatched
  from a non-main branch it ships it to stage and then production.
- **`--dry-run`** checks the mechanism only (docker, the SHA in the
  checkout, a writable `releases/`, the unit, curl; for `rollback`, that the
  release exists) and changes no release.
- **Logs:** every run appends to `$ROOT/shared/deploy.log` on the box. The
  CI jobs and `tools/deploy` report start/finish through
  `tools/ci-notify.sh` (Vector `http://10.8.1.12:9880` → ClickHouse
  `logs.entries`, project `itgame`); without `OBS_TOKEN` (a Forgejo secret;
  a manual run on the box reads `$ROOT/shared/obs.env`) it is a silent no-op
  and never fails a job. On the new box `tools/deploy` is always that no-op:
  `10.8.1.12` is not reachable from it, so there is no `shared/obs.env`
  there and the pipeline events come from the CI jobs on the runners
  (minipc `deploy/itgame/README.md`).

**Retired chain (until 08.10, its files removed in ITGAME-181):** an HMAC
POST to the on-box `/api/deploy` hook, a GitHub Actions `deploy` job, and on
the box the wrapper `/usr/local/bin/itgame-deploy` running a production-only
deploy script. `tools/deploy` is its port: same release layout, atomic swap
and `KEEP=3`.

Notes:

- `npm run build` runs `check-sprites.mjs`, which decodes PNGs with pngjs —
  no Chromium needed for the box to build (Chromium is only for
  `smoke-ui`/`qa:*`/`visreg`, see [Tests](#tests)).
- Releases are built from `git archive` (no `.git`, so neither `git rev-parse`
  nor Go's `vcs.revision`), so the recipe has to stamp the SHA itself
  (ITGAME-81): the client built with `BUILD_SHA=<short sha>`
  (`<meta name="build">`, `itd.version`), the server with `-ldflags "-X
  itdirector/internal/ws.buildSHA=<short sha>"` (`GET /api/version`, the
  journal header, `agent_status`). Vite takes `BUILD_SHA` only as lower-case
  hex of 7–40 characters — anything else is ignored with a warning — then
  falls back to `git rev-parse`, then `dev`; the server falls back to
  `vcs.revision`, then `unknown`. `make build` and the QA self-serve build
  from a checkout and need neither. `tools/deploy` passes both as the short
  sha (ITGAME-98); releases built before that read `dev` / `unknown`. Check a release:
  `curl -s https://<host>/ | grep -o '<meta name="build"[^>]*'`.
- The **build version** (ITGAME-140) is stamped the same way: `BUILD_VERSION`
  for the client (`itd.version.version`, the menu's «версия …») and `-X
  itdirector/internal/ws.buildVersion` for the server (`/api/version` →
  `version`, the session save, the journal header's `build`). It is the
  commit time in Moscow time, `год.мес.день.час.мин`
  (`TZ=MSK-3 git log -1 --format=%cd --date=format-local:%Y.%m.%d.%H.%M <sha>`;
  `MSK-3` is a POSIX zone, UTC+3 with no tzdata) — the commit's, not the
  build's, so rebuilding the same commit shows the same version. It is for
  people (the menu corner, `/api/version`, the journal header,
  `save_summary.version`) and refuses no save since ITGAME-169: the save format
  decides (see [Sessions and saves](#sessions-and-saves)). `tools/deploy`
  computes it from `$CHECKOUT` before the build; unstamped, Vite falls back to
  the same `git log`, then `dev`, and the server to `vcs.time` converted to
  Moscow time, then `""` (`go run`, `go test`: no version).
- Production nginx proxies `location /ws`, `location /api/` and
  `location = /admin` (behind basic auth) to the Go server (`127.0.0.1:8080`
  prod, `:8081` stage), and `= /metrics` to `9181` / `9182`; everything else is
  static files. The three proxied locations include `proxy-ws-itgame.inc`,
  which sets `Host $host` and `X-Real-IP $remote_addr` (plus the Upgrade
  headers and hour-long timeouts). `X-Real-IP` is what keeps the localhost
  cheat shut on prod (see [Cheats (localhost)](#cheats-localhost)). The
  source of truth is the minipc repo's `deploy/itgame/nginx/https.conf`
  (and `proxy-ws-itgame.inc` next to it); this repo holds no nginx config.
  Go already sends `Cache-Control: no-store` on `/api/version`; if `/api/` is
  not proxied, `/api/version` is missing and `itd.stale()` compares the tab
  with the `<meta name="build">` of a fresh `/` only, and `server` stays `null`
  (an unstamped server answers `unknown`, which counts as `null` too).
- A deploy drops live WebSocket connections; saves live in `shared/saves`,
  and clients reconnect and resume.
- PostgreSQL runs on the box since 20.10 (minipc MINIPC-276, ITGAME-168):
  see [Database](#database). The release itself needs nothing for it — the
  server applies migrations on start.
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

A session is keyed by the client's `sid`, sent as `/ws?sid=`. The client
reads the tab's `sessionStorage` `itd.sid` first (the tab mirror,
ITGAME-30), then the shared `localStorage` `itd.sid` (never under
`itd.sandbox`), both through `client/src/storage.ts` (ITGAME-80, see
**Blocked storage** below). Starting a party (`connect`) writes the mirror
always and the shared key only for a sid that came from it or was freshly
generated. The server saves after every command and tick — in memory plus
an atomically written `<sid>.json`: each save goes to its own temp file
outside the store lock and is renamed into place under it, together with the
owner (`gen`) check and the memory write, so an evicted actor never lands its
save over the new owner's and a save racing a delete never brings the file
back (ITGAME-183); startup removes temp files a crash left behind. On
reconnect with the same `sid` within
the TTL (default 24 h, `-save-ttl`):

- the game resumes; a short drop (e.g. a deploy) continues silently;
- missed time is simulated offline with a summary formula (no coffee rolls,
  events, breakdowns, virus waves or XP; lunch and amenity debuffs apply,
  broken and infected seats stay so; session speed
  applies, pause freezes). A day or more away produces a "while you were
  away" report; bankruptcy or victory can happen offline. While that window
  is open the HUD pauses the party (`set_speed 0`) and «Продолжить →»
  restores the pre-window speed unless another `set_speed` happened
  meanwhile — the `speedSeq` rule of the exit dialog (owner decision 10.10;
  `qa:party` O3b/O3c);
- an explicit exit («Сохранить и выйти») sends the session command `exit {speed: N}` right before the
  client closes the socket (readLoop hands every frame to the actor before it reads the next, so it is
  saved first). The actor pauses (speed 0, ticker off) and saves `speed: 0` plus `resumeSpeed: N`: the
  speed before the exit dialog, or before an open day report; 0 means the player had paused. Missed
  time is therefore zero for both the reconnect and the menu peek. `resume()` restores
  `speed = resumeSpeed` and the next save clears it; `set_speed` clears it too; `exit` clamps N to 0..3
  and never answers `bad_speed`. While «Выйти в меню?» is open the HUD keeps the game paused
  (`set_speed 0`, saved like any pause, so a tab closed with the dialog open resumes paused).
  «Отмена», Esc, ✕ and a backdrop click restore the previous speed unless another `set_speed` happened
  meanwhile (the `speedSeq` rule of the day-report pause). Closing the tab, a network drop and bfcache
  (`GameClient.suspend`) are not an explicit exit: offline catch-up applies as before (ITGAME-65);
- the HUD goes to the menu only after `exit` actually left (`client.send` → true). With the socket not
  open (reconnecting, `itd.away`) «Сохранить и выйти» opens «Нет связи — сохранение не дойдёт»
  (ITGAME-85, owner decision 10.10): «Подождать» shows «Ждём связь…» while the reconnect timer keeps
  running, and the first snapshot of the new socket sends `exit {speed: N}` (N as above, computed at
  the click) and goes to the menu exactly like the normal path; «Выйти без сохранения» goes to the menu
  as before — the server keeps the party running and «Продолжить» shows the catch-up. ✕, a backdrop
  click or Esc in either window go back to the game (and restore the dialog's pause like «Отмена»).
  The dialog's own pause is sent only with an open socket;
- «Сдаться (удалить сейв)» asks first (ITGAME-86): «Удалить партию навсегда?» with «Удалить» (red) /
  «Отмена» (default, focus frame); Enter, Space, Esc, ✕ and the backdrop are «Отмена» — back to the
  game, same sid, the save untouched. `itd.cmd('abandon')` skips the question (see Debug API);
- a player command that could not leave because the socket is not open (`send()` → false; the
  `onNotConnected` listener) plays the `error` sound on every click and shows one toast «Нет связи —
  действие не отправлено» per outage — the next snapshot re-arms it (ITGAME-90). Buy buttons keep
  their money/slot disabled states; the connection is not one of them;
- game endings and `abandon` delete the save; another tab with the same
  `sid` takes the session over and the old one is closed with
  `session_taken`. Locally the ending clears the tab's `sessionStorage`, and
  the shared `localStorage` `itd.sid`/`itd.diff` only when that key holds
  this party's own sid — an agent tab with an explicit sid, or a tab whose
  shared key a neighbour already overwrote, leaves the other save's
  «Continue» alone; likewise only a non-tab (`local`/`generated`) party
  writes `itd.diff` (acceptance 10.10);
- if the server has no save for the `sid` (expired, deleted, never existed),
  «Continue» still connects and the server starts a **new** game under the
  same `sid`. The first snapshot of every `/ws` connection carries `resumed`
  (`true` only for a restored save), so the client resets its party state
  (active office → office 0, `client/src/party.ts`) when that first snapshot
  says `resumed: false` — otherwise the new game would open on the office the
  previous game in the tab left open, possibly a locked one (ITGAME-54). The
  rule applies to `/ws` only: `/ws/agent` observers (`observeAgent` in
  `server/internal/ws/agent.go`) get `resumed: false` in their first snapshot
  even for a live game, so a client must not treat it as «new game» there;
- a save of another `game.format` (ITGAME-169) is not continued, but it is no
  longer silent for a live tab (ITGAME-174): when `resume()` rejects an
  existing save of this `sid` because of `incompatibleSave(format)` — not a
  missing, broken or foreign-`sid` save — the first snapshot of the new party
  carries `incompatible: true` (omitted otherwise, never in later snapshots).
  The client (`HUDScene.showIncompatibleNotice`, after `resetForNewGame`) raises
  a one-button window «Сейв несовместим с новой версией — начата новая
  партия» (`modal.incompatible.ok`; Enter/Space/Esc/✕ close it too) and does
  not touch the party's speed. The «Continue» on a missing save (ITGAME-54)
  stays silent;
- **read timeout** (ITGAME-76, `server/internal/ws/liveness.go`): a `/ws` tab
  connection keeps a «last heard» clock — any message or a pong to the
  server's ping (sent when the client is silent for a third of the timeout;
  the browser answers pings itself, also in a background tab, so a paused
  idle tab never trips it). Silent longer than the read timeout — the server
  treats the client as gone: closes the connection without a close frame, the
  actor stops, and since it saves every tick, the last save is the moment the
  server noticed; the offline catch-up on return counts from it. Before this a
  network drop (no close frame) was noticed only when TCP gave up on a write —
  minutes of the party running live without the player. A closed tab is
  noticed at once (close frame). Default 30 s, `ITGAME_READ_TIMEOUT` (Go
  duration: `5s`, `1500ms`) on the server; the debug drop below can shorten it
  per connection. The first snapshot after a resume carries
  `offlineReport: true` when an `offline_report` follows it, so a client can
  wait for that report by fact rather than by a timer. Owner decision 10.10:
  the 30 s default stays in production for every player — a real network drop
  (a sleeping phone included) stops the party within ~30–40 s and the return
  gets the offline catch-up;
- **an early return takes the session over** (owner decision 10.10): when a
  tab reconnects before the server noticed it gone (a network blip shorter
  than the read timeout, `itd.away` `net` shorter than its `timeout`), the new
  connection's `Begin()` evicts the old actor, and every `/ws/agent` observer
  bridge of that party is closed with `session_taken` and reconnects as an
  observer of the new actor — the same as for any reconnect or a second tab.

**Blocked storage** (ITGAME-80). Every `itd.*` key the game keeps — sid, difficulty, the report pause, hints,
stats/achievements, the `itd.debug` gate, `itd.sandbox`, `itd.reset()` — goes through `client/src/storage.ts`:
`localStore`/`sessionStore` with `get`/`set`/`remove`/`clearPrefix`, which never throw. Reads go to the real
store every time (other tabs, `itd.sandbox` and QA scripts write it directly); only a call the browser refuses —
with site data blocked Chrome throws `SecurityError` on the `window.localStorage` getter itself, a full store
throws on `setItem` — leaves the key in the tab's memory, and that entry wins over the real store until a later
write or remove of the key succeeds. With storage fully blocked the menu loads and a party plays; «Продолжить»
works within the tab (after «Сохранить и выйти»), but a reload forgets the sid: no «Продолжить», the party stays
on the server until its TTL. `uiscale.ts`, `main.ts` (`itd.admin`) and `debug/telemetry.ts` keep their own
try/catch fallbacks.

The start menu reads the save's facts through `/ws?peek=1&sid=…`
(ITGAME-19): the server sends one `save_summary` (`exists`, `alive`,
`day`, `money`, `difficulty`, `outcome` won/lost, `reason`) and closes
the socket. It counts missed time offline the same way a reconnect does,
but on a copy: nothing is written, no session is taken over. It rides on
`/ws` because it needs no `/api/` route; production nginx proxies both to Go (see
[Deploy](#deploy)). The menu shows
«ПРОДОЛЖИТЬ — День 3 · $60 · НОРМА» for a live save, «ИТОГ: …» for a
game that ended while the player was away, hides the card when the
server has no save, and asks for confirmation before a new game
overwrites a live one.

Save directory: `-saves` flag → `ITGAME_SAVES_DIR` →
`/opt/itgame/shared/saves` (if it exists) → `./saves`. `-saves off` runs
stateless. Expired saves are purged on start and on access.

**Save format** (ITGAME-103; the rule since ITGAME-169, owner decision 18.10):
`Save.Format` (`format` in the JSON) is `game.SaveFormat`, written by `Export`,
and it alone decides whether a save continues. A save of the same format
continues on any build — a deploy (`git push stand main`, a green `main`) or a
restart keeps every party; a save of another format, **older or newer**, does
not, and there is no migration. **Any added, removed or changed field of the
save file** — `Save` at any depth (`Config`, `Office` → `Employee`, `DayEvent`,
`DayLedger` → `LedgerEvent`, `LedgerPurchase`) and the session wrapper around
it, `ws.sessionSave` (`sid`, `speed`, `resumeSpeed`, `savedAt`, `lastReport` →
`game.DayReport`, `scenario`, `events`, `rev`, `version`; ITGAME-175 — a renamed
wrapper field reads back as zero, a retyped one fails `json.Unmarshal` in
`resume` and the party restarts without the card): a key, its type or its json
tag options — **bumps `SaveFormat`**. Two pins hold it with one walker and one
verdict (`server/internal/saveshape`, imported by tests only — `game` cannot
import `ws`, and a test file of one package is invisible to another):
`TestSaveShape` (`server/internal/game/saveshape_test.go`) holds `Save` against
`server/internal/game/testdata/save_shape.txt`, `TestSessionSaveShape`
(`server/internal/ws/saveshape_test.go`) holds `sessionSave` against
`server/internal/ws/testdata/session_save_shape.txt`, where `game` is a single
line `game game.Save` left to the first pin. Each walks its type the way
`encoding/json` names keys (`format N`, then one `key type` per line; a type
with its own `MarshalJSON`/`MarshalText` is named, not walked: `savedAt
time.Time`; a method on `*T` only does not make a type opaque —
`encoding/json` calls it only where the value is addressable, slice elements
and anything behind a pointer (`offices[]`, `lastReport`), and writes the
fields elsewhere, so the pin walks the fields everywhere: at worst one bump
too many, never a missed field). Outside both pins is the store's envelope
(`store.diskEnvelope`: `savedAt` and `data`, which holds `sessionSave`): its
two keys are frozen — a bump cannot help there (the format is read inside
`data`), a renamed key makes every save unreadable and `Load` drops it. Also
frozen, though inside the pins, is `sid`: the menu reads it with `version`
and `game.format` from a save of any format (`saveHead`, `ws/peek.go`), and
a renamed `sid` turns every old save into «no save» instead of the
incompatible card even with the bump (renaming `version` or `game.format`
along with `saveHead` still ends at the card). A changed structure with the
same `SaveFormat` is red and prints the new file with `format N+1`: bump
`SaveFormat` to N+1 and replace the file with it (pasted without the bump it
stays red); the other pin then goes red with «SaveFormat поднят до N+1» and
prints its own file — a bump re-pins both. A golden that is missing or
garbled is restored from git, never recreated (a fresh one would go green
without the bump). The pins see structure only — keys, kinds, tag options: a
changed meaning or unit of an existing field, an enum value added or removed
(`Phase`, `EventID`, `Difficulty` are plain strings to them), what a custom
`MarshalJSON` writes, a self-referential type (the walk would not end) are
invisible to them and still need a manual `SaveFormat` bump by the rule. A
game-rule change that reads still-valid stored values differently is not a
format change: old saves load and play on under the new rule, no bump
(ITGAME-156: `CreditLimit == 0` now means an overdraft down to one day's
payroll instead of instant bankruptcy, `SaveFormat` unchanged). A bump is
for a save that would decode wrongly or hold values the new code cannot
honour. Config fields added to format 1 before the rule (audit, repair
clicks, antivirus tiers, admin prices) are filled by `Restore` from the
save's difficulty. Format 1 is the virus on seats — a save from before it
has no `format`; format 2 is the workplaces (ITGAME-135, owner 20.10); format 3 is the event
budget and the exact income (ITGAME-196/203, owner 21.10): the breakdown chance
in permille (`BreakdownChancePermille`), `EventBudget`, the raise percent
(`Employee.RaisePct`, `DayEvent.RaisePct`, `RaiseBoostMult` removed) and the
company's `incomeCarry`; format 4 is the director's action points (ITGAME-127,
owner 21.10): `Config.ActionPointsPerDay` (8) and `Save.actionPoints`
(validated into [0, `ActionPointsPerDay`]).

A save of another format behaves like a broken one, except that the menu says
why (and, since ITGAME-174, the live tab too: see the ITGAME-174 bullet in the
`/ws` resume list — the first snapshot carries `incompatible: true`): the peek reads the sid, the version and `game.format` before the rest (a
newer save whose changed field no longer decodes still gets the card) and
answers `exists: false, incompatible: true, saveVersion, version`; the menu
shows a card without a click or focus — «СЕЙВ НЕСОВМЕСТИМ» and the owner's line
«Сохранение от прошлой версии игры — продолжить его нельзя.» (ITGAME-149, owner
18.10: no version and no format on the card — the build version is in the menu
corner «версия X», `/api/version` and `itd.version`; the line is 517 px at 14 px
against the card's 480, so it goes on two lines broken after the dash and the
card is 88 px tall instead of 64) — with «начните новую партию:»
over the levels; a level starts a new party with no «Начать заново?» (the save
is not alive) under a new sid, as any new party from the menu, and the old file
lives out its TTL. A `/ws` connect with that sid (an agent tab's explicit sid)
starts a new party under it (its first snapshot carries `incompatible: true`,
ITGAME-174) and its first save overwrites the file.
`game.Restore` refuses any other format with `ErrBadSave` too, so fixtures,
`itd.restore` and `make replay` (journal checkpoints are built over `Export` and
carry the format) take a save or a journal of any build of the same format; a
journal of another format no longer replays.

To see the card without a restart (ITGAME-154): `POST /api/debug/format`
`{sid, format?}` (`ITGAME_DEBUG` only) marks the save of `sid` with another
`game.format` — by default `SaveFormat + 1`, `0` is the oldest, the server's
own format → `400 same_format`, below 0 → `400 bad_format`. It keeps `version`,
every other value and `savedAt`; the answer is `{sid, was, format, live}`.
`live: false` — nobody holds the sid, the store is rewritten, memory and file
(`store.Rewrite`: no `Begin`, so the owner's generation and kick are kept; a
hand-edited file stays invisible on a live server because `Load` serves memory
first). `live: true` — the actor of a live party (owner, 20.10: «порча до
переподключения») writes every save with the mark until it exits; the game,
`rev`, the snapshot stream and the party journal are untouched (the replay never
sees it). «В меню» then shows the card, and a reconnect goes through `resume` →
another format → a new party under the same sid, silent in the tab today
(ITGAME-174). A finished party → `404 no_save`, a server without saves →
`409 no_saves`; a save that changed while the route was editing it (a tab
connected and wrote) → `409 busy`, retry; the errors are free text, not
protocol codes. Client:
`itd.staleSave({sid})` (without `{sid}` — only in a party or a sandbox, else `owner_sid`).

**Build version** (ITGAME-140): the session save (`sessionSave.version`, next to
`game`) records the server's build version (see [Deploy](#deploy)) for people:
the peek sends `version` always (`""` without one) and `saveVersion` with an
incompatible save, the journal header carries `build`. Nothing compares it. From
ITGAME-140 to ITGAME-169 (17.10–18.10) a save of another build did not continue,
so every deploy started every party anew; the owner moved the rule to the
format.

## Command ids, `rev` and `cause`

The server broadcasts a `state` to every connection of a session on every
tick and after any connection's successful command — the `/ws/agent`
observer's included; `error` goes to the sender only. So «the first state
after I sent» is not the answer to my command: a tick snapshot already on
the wire, or the snapshot of an agent's command, used to close a tab's
receipt with `ok:true`, and the `error` that followed closed the *next*
command's receipt (ITGAME-45; invisible on localhost, real at 3× with
50–100 ms RTT). The protocol now correlates:

- **`id`** — optional number in any client command (`clientMessage.id`). The
  server echoes it as **`re`** in the `error` and in the `state` that command
  produced — and only in the sender's copy: other connections get the same
  state (same `rev`) without `re`, so a tab's and an agent's ids may collide
  harmlessly. A command without `id` gets no `re` — old bundles keep their
  FIFO receipts and work as before. The id is unique per connection only: the
  party journal pairs it with the connection's number in the party (`conn`,
  `src: tab | bridge`, ITGAME-91, see [Party journal and replay](#party-journal-and-replay)).
- **`rev`** — the session's state version: +1 on every broadcast snapshot,
  starting at 1. It is saved with the session (`sessionSave.rev`, bumped
  *before* the save, so the save holds the rev of the snapshot about to go
  out) and survives resume: the first snapshot after a reconnect is strictly
  above anything clients saw. A new party under the same sid (no save,
  `abandon`, «Продолжить» on an expired save) starts at 1 again. An `error`
  carries the current `rev` (a rejection changes nothing). Copies that change
  nothing — the observer's first snapshot, `GET /api/debug/state`,
  `agent_status` — carry the current `rev` and `cause` without bumping.
- **`cause`** — why the state went out: `tick`, `cmd`, `debug` (`/api/debug/*`
  and the bridge's `debug_*`), `start` (first snapshot of a new party) or
  `resume` (first snapshot restored from a save). The list is mirrored in
  `STATE_CAUSES` (`client/src/protocol.ts`) and checked against the Go
  `stateCause("…")` constants by `gen-contract`.

`GameClient` (`client/src/net.ts`) stamps every outgoing command with an id
(page-lifetime counter, never reused across sockets) and closes
`sendWithReceipt` receipts by `re` — `{ok, code?, id, rev}`; ticks and
foreign snapshots don't touch them. A server without `rev` (an old binary
in dev) falls back to FIFO. `client.waitState(pred)` / `client.waitRev(n)`
resolve on the first matching snapshot without polling — the building block
for «wait until `state.rev ≥ N`». Over the agent bridge, waiting is reading
the stream: every debug operation's `agent_result` carries the `rev` of the
snapshot it already broadcast.

The «50 commands at 3× over a delayed socket» check is automated:
`TestReceiptFiftyCommandsAt3xWithLatency` (`server/internal/ws/receipt_test.go`)
runs 50 pipelined `set_speed` commands (alternating success / `bad_speed`)
at 3× through a TCP proxy delaying every chunk 40 ms each way and asserts
that every receipt by id matches, while the FIFO model on the same wire is
wrong about half the time. The same file reproduces both races (tick in
flight; observer command) and was red before the fix; in the real client
`qa:trace` step 13 does the same with a blocked main thread.

## Agent bridge `/ws/agent`

`ws://host/ws/agent?sid=…[&seed=][&scenario=][&difficulty=]` drives a
session without a browser. It speaks the client protocol plus:
`{"type":"status"}` → `agent_status` (role, phase, server version, seed,
current `rev`);
`debug_patch` / `debug_advance` / `debug_step` / `debug_scenario` →
`agent_result` (mirrors `/api/debug/*`; `rev` — the version after the
operation, its snapshot already sent). An `id` in any of these comes back as
`re` (see [Command ids, `rev` and `cause`](#command-ids-rev-and-cause)); the
`state` in every `/api/debug/*` reply carries `rev`/`cause` too. The agent never takes a live
session: it attaches as an observer, or runs a headless one if none exists;
a player connecting takes the headless session over.

**Server-side gate: `ITGAME_DEBUG=1`.** Both the bridge (`GET /ws/agent`)
and the HTTP debug API (`/api/debug/*`) are registered in `newMux`
(`server/cmd/server/main.go`) only when this env var is `1`; `main`
reads it once and passes it into `newMux` as an explicit parameter (not
read from env inside `newMux`, so tests can control it directly). Without
it, `ServeMux` itself has no route for either path, so requests get a
plain 404 — the handlers never run and never get a chance to check
anything. The one deliberate exception is `POST /api/cheat/money`, registered
without the flag and admitting only a local request (see
[Cheats (localhost)](#cheats-localhost)). The flag is off by default and **not** set in production (the box's
`itgame` unit; `tools/deploy` only restarts it and sets no env), and the
Forgejo CI starts no server (see [CI](#ci)); it's set only where local
tooling needs it: `make dev`/`dev-server` and
`client/scripts/lib/selfserve.mjs` (all QA scripts and `visreg` that
build and self-serve `bin/itdirector` — see the QA table below). If you
start the server by hand for
`qa:meta` (which proxies through `vite preview` to a Go server
you run separately) or for `OFFICE=1 npm run smoke-ui` against a manual
server, set it yourself: `ITGAME_DEBUG=1 go run ./cmd/server`.

Its browser-side counterpart is the `window.itd` facade — see
[Debug API](#debug-api-windowitd); that one is a *client*-side, separate
gate (`?debug=1`/dev build) and doesn't require `ITGAME_DEBUG` by itself —
only the `/api/debug/*` calls some of its methods make (`set`, `step`,
`advanceDays`, `scenario`, …) need the server flag to succeed.

## Party journal and replay

A bug from a live party is reproduced without a browser: under
`ITGAME_DEBUG=1` (`Handler.Journal`, set by `newMux` together with the debug
routes; never on production) the session actor records the party as JSONL,
and `server/cmd/replay` re-runs it on `game.Game` and checks a state hash
after every record (ITGAME-46). The engine is deterministic — PCG by seed,
no `time.Now` in `internal/game` — so seed + inputs by tick *is* the party;
the first record whose hash differs is where determinism broke.

    await itd.journal({tail: 20})                                      # in the tab: the last records as lines (see Debug API)
    curl -s 'localhost:8080/api/debug/journal?sid=<sid>' > party.jsonl   # sid: itd.server().sid
    make replay ARGS=party.jsonl                                       # or ARGS="-url http://localhost:8080 -sid <sid>"
    make replay ARGS="-json party.jsonl"                               # one JSON object: ok, records, ticks, warnings, divergence, save

`GET /api/debug/journal?sid=` (`application/x-ndjson`) works while the party
is live and after it (until the server restarts or the journal is evicted):
404 `journal_off` without the flag, 404 `no_journal` for a sid the server has
not seen. Exit codes: 0 — replay matches, 1 — divergence, 2 — unreadable
journal.

**Format** (`server/internal/ws/journal.go`). Line 1 is the header —
`{k:"header", v:1, sid, seed, difficulty, scenario, cfgHash, version, config,
dropped}` (the full config, so custom test configs replay too). Then one line
per record; every record carries `seq`, `tk`, `rev` (ITGAME-45), `day`,
`tick`, `money`, `phase`, `speed` and `h` — the position and hash *after* the
input:

    {"k":"start","seq":1,"rev":1,"day":1,"tick":0,"money":600,"phase":"running","speed":1,"h":"81614dc3d1bbdadf","conn":1,"src":"tab"}
    {"k":"cmd","seq":3,"tk":3,"rev":6,"day":1,"tick":3,"money":25,"phase":"running","speed":3,"h":"13751fcfb18e068b","id":2,"type":"buy_pc","conn":1,"src":"tab"}
    {"k":"cmd","seq":5,"rev":6,"day":1,"tick":3,"money":25,"phase":"running","speed":3,"h":"13751fcfb18e068b","id":4,"type":"fire","slot":9,"err":"bad_slot","conn":1,"src":"tab"}
    {"k":"debug","seq":6,"rev":7,"day":1,"tick":23,"money":25,"phase":"running","speed":3,"h":"00149c339a48dd8b","op":"advance","ticks":20}
    {"k":"end","seq":7,"tk":2,"rev":9,"day":1,"tick":25,"money":25,"phase":"running","speed":3,"h":"d124dc5eecb4b816"}
    {"k":"resume","seq":8,"rev":10,"day":1,"tick":30,…,"h":"63f852f5e117e4eb","conn":2,"src":"tab","pre":"d124dc5eecb4b816","offline":5,"saveSpeed":3,"save":{…}}
    {"k":"cmd","seq":9,"rev":11,…,"id":1,"type":"hire","conn":2,"src":"tab"}
    {"k":"cmd","seq":10,"rev":12,…,"id":1,"type":"buy_pc","conn":3,"src":"bridge"}

(a real journal: `pre` of the `resume` equals `h` of the `end` before it —
the save the server loaded is exactly the state the replay reached; 5
offline ticks then move it to tick 30.)

- `tk` — how many times the actor called `g.Tick()` since the previous
  record; the replayer runs those ticks before applying the record. Speed is
  only a snapshot field: it changes how often ticks fire, never what a tick
  does (`internal/game` has no notion of it), and the tick count already
  captures the frequency — a replay knows nothing about time and still
  matches a party played at 1–3×.
- `cmd` — every client command as received (`id`, `type`, `office`, `slot`,
  `arg` = the command's speed for `set_speed`/`exit`), rejections included
  with `err` — the replayer checks the rejection reproduces.
- `conn`/`src` (ITGAME-91) — who sent it. The command `id` is not unique in a
  party: the tab's counter lives in the page (`nextCmdId`, `net.ts` — a socket
  reconnect keeps counting, a page reload under the same sid starts at 1 again)
  and the agent bridge sends its own ids, so `id1` used to appear twice. `conn`
  is the connection's number in the party — 1, 2, … in order of appearance; the
  actor's own connection (the tab, or the bridge that runs a headless session)
  gets its number in `start`/`resume`, others (a bridge observer) on their first
  command; the counter survives `resume` (same party, same journal) and starts
  over with a new party. `src` is `tab` (`/ws`) or `bridge` (`/ws/agent`). The
  pair (`conn`, `id`) is unique within a party. Neither enters the hash: the
  replayer only lists the connections (`соединения: c1 tab, c2 tab, c3 bridge`,
  `-json` → `conns`), names `cN src idN` in a command divergence and warns on a
  repeated pair (`TestJournalCommandConnAndSource`, `TestReplayWarnsOnDuplicateConnID`). `debug` — only
  mutating `/api/debug/*` / bridge `debug_*` requests (`patch`, `scenario`,
  `restore` with the raw delta, `advance`); the replayer applies them through
  the same `debugMutate` as the actor.
- `day` — a tick closed the day or the party (a milestone to localise a
  divergence). `cp` — checkpoint: the full save plus the PCG position
  (`Game.RNGState()`), written after every day report and after every 256 KiB
  without one.
- Impure inputs are explicit: `resume` — `pre` is the hash of the save the
  server loaded (after `game.Restore`, i.e. PCG re-seeded from the start, as
  `save.go` does), `offline` the catch-up ticks the server computed from the
  wall clock, `save` the save itself; `end` — the actor left (`evicted` when
  another actor took the session; `reason: read_timeout | debug_drop` when
  the read watchdog closed the tab, ITGAME-76 — the party ran live until
  then, its ticks are in `tk`, and the save the next `resume` loads is
  exactly the state at this `end`; neither — the client closed the
  connection: tab closed, F5, `itd.away` `close`, `abandon`; `itd.journal()`
  prints these as `end evicted | read_timeout | debug_drop | disconnect`).
- `h` = sha256 (first 8 bytes) over `Export()` JSON (the day ledger and its
  history, ITGAME-73, included — `itd.set({money})` lands in `adjust` through
  the same `debugMutate` in the replay), the protocol snapshot
  without `rev`/`cause` (derived fields: income, network, forecast) and the
  PCG state.

**Size.** One journal is capped at 4 MiB: over the cap the head is cut at the
earliest checkpoint that brings it under the cap, and the replay starts from
that checkpoint (`header.dropped` counts the cut records, `seq` keeps
numbering). A ring rather than rotation, because the interesting part of a
bug report is the end of the party; checkpoints make the ring replayable.
Without a checkpoint to cut at (a finale has no save, so no checkpoints, and
someone hammers rejected clicks) the journal grows to 8 MiB and then stops
with `header.overflow`. At most 64 journals live in memory (the oldest closed
one is evicted first); they are not persisted, saves don't depend on them.

**Divergence report**: the line and the record, expected/actual hash,
expected/actual `day/tick/money/phase/speed`, and on a checkpoint or `resume`
a field-by-field diff of the save.

**Takeover** (a second tab or a reconnect before the server noticed the old
socket died) is exact too. The new actor calls `store.Begin` *before* reading
the save (`run()`; `Begin` warms a cold sid from disk and forgets an expired
save itself, `resume()` drops a bad save with `Finish(gen)`, not `Delete`,
which would kick the new owner): after `Begin` the old actor's `Put` fails, so
the save it loads holds everything the old actor saved and acknowledged, and
nothing else. The old actor journals ticks, commands and debug requests only
after its save went through, and the new actor waits (up to 1 s) for the old
one's `end` before writing its `resume`. Until ITGAME-46 `Load` came first:
the old actor's ticks and commands in the `Load`→`Begin` window were saved,
sent to the old tab as accepted and lost in the new party
(`TestTakeoverKeepsAckedCommand`: a `hire` the old tab got `re` for, absent
after the takeover). If the journal still disagrees with the loaded save after
a takeover (`took`: the old actor did not close the journal within 1 s), the
replayer resyncs from the record's `save` with a warning and the diff; the
tests require zero warnings. A mismatch on a normal reconnect is always a
divergence.

Tests: `TestJournalReplayRandomParty` (`server/internal/ws/journal_test.go`)
plays a random party on the real config — events, breakdowns, coffee, stars,
rejected commands, debug patch/advance/restore, a reconnect with offline
catch-up, a takeover, exit → «Продолжить» — then fetches
`/api/debug/journal`, replays it and compares the final save and snapshot
byte for byte with `GET /api/debug/state`; siblings cover the ring
(`TestJournalRingTrimsAtCheckpoint`), the divergence report, `?seed=0` across
a reconnect and the gate; `TestJournalThroughMux` (`cmd/server`) does it on
the binary's routes. `npm run qa:journal` does it from a real browser tab.

## Debug API (`window.itd`)

Client-only tooling, cosmetic for players and unknown to the server — two
independent gates:

- **`?debug=1`** (query string, shareable, survives reload — `debug.enabled`
  in `client/src/debug.ts`). Effects: a red frame around every
  interactive object (click-zone bounds), drawn right above its object — the
  object's (root container's) depth + 0.5, below the next integer layer — so a window opened over it (event card
  panel 40, day report dim 50, «Пока вас не было» dim 55, finale 60, modal backdrop 70) covers or dims the frames of
  covered objects together with the objects, while the window's own buttons stay brightly framed (frames of another
  scene stay bright: the HUD scene renders above the office one, so HUD frames stay bright over an office window); no
  redraw on open/close (ITGAME-84). A HUD window keeps its frames in its own object list, so they go with it: the
  event card frames `btn.event.i` at 41.5 and rebuilds them with the card on every snapshot, «Пока вас не было»
  frames `btn.offline.continue`/`btn.offline.menu` at 56.5 and its dim at 55.5 (ITGAME-97). Each frame carries
  `data.debugFrame` = the framed object (QA pairs them via `window.__itd`). The flag also installs `window.itd` in a
  prod build and shows the `#topbar` («Админка», build stamp — see below). While set, the HUD shows a
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

`itd.click(id)` answers `ok:true` only when the handler actually acted; if
its guard swallowed the click (HUD `switchRoom` debounce, 250 ms of game
time) it answers `ok:false` with `code: 'debounced'` — retry after a pause
(ITGAME-58).

`itd.scenario(name)` recreates the game on the server and also resets the
client's party state (active office → office 0), so the screen does not stay
on «Office 2 closed» after a fixture (ITGAME-55). It also closes the HUD
overlays of the previous party (day report, event card, offline report,
finale, exit dialog) and drops the report pause bookkeeping
(`itd.speedBeforeReport`), without touching the session speed: from an open
report the new party stays paused — call `itd.resume()` (ITGAME-64). Debug
calls go to the sid of the live socket, so `scenario()` also works on the
finale screen and puts that sid back into the tab mirror.

Without a party of its own — the main menu before the first party or after
«В меню»/«Сдаться», or a tab whose session another tab took over
(`itd.server().liveSid` is `null`) — `itd.set()`, `step()`, `advanceDays()`
(and `play()`'s `{days}` steps), `ledger()`, `scenario()`, `snapshot()` and
`restore()` reject at once, with no request, with `not_in_party: …` and the
hint to pick a difficulty first: `itd.click('menu.diff.normal')`, then
`await itd.wait(s => s.connected)` — the server registers the session before
the first snapshot (ITGAME-131). With a live save the menu asks «Начать заново?»
first (`itd.click('modal.btn.confirm')`), or `itd.click('menu.continue')`
resumes it; a tab whose session was taken has no menu to click, the message
says to reload the page (F5). Before, the call went out under the
stored sid and the server answered `404 session_not_live (откройте страницу
игры с этим sid)` with the page open. The check is `partySid()` in
`agentApi.ts`, the only source of `debugFetch`'s sid (`step` calls it before
its `set_speed`); a click on a difficulty sets `liveSid` synchronously, so an
opening socket, a day report, the finale, a reconnect and `itd.away` are never
refused. The server's `session_not_live` stays for a foreign or dead sid, and
the tab can still meet it while its socket is opening or reconnecting.
`itd.journal()` is not gated: the journal lives on the server and outlives the
session. Without `sid` it reads the tab's own sid, which survives «Сохранить и
выйти»/«Выйти без сохранения» (the journal reads from the menu then) but not
«Сдаться» or a finale followed by «В меню» — `clearSession()` wipes the sid, the
default one is a fresh one and answers `no_journal`; take `itd.server().sid`
before leaving and pass it: `itd.journal({sid})`. `itd.away()` keeps its own
`not_connected`. `itd.staleSave()` is not gated either.

`itd.restore(save)` is a delta over the live party and does not reset it; if
the active office is locked in the restored state, the tab moves to office 0
(ITGAME-63).

Both `itd.scenario()` and `itd.restore()` close the office and server-room
windows (router, fire dialog, rack, core): they were built from the previous
state, and a click in one sent a command for that office/slot into the new
party (ITGAME-69). The scenes open them through `partyModals()`
(`client/src/ui/modal.ts`), which listens to `onPartyReplaced`
(`client/src/party.ts`) — fired by `resetForNewGame()` and by `restore()`;
`restore()` still leaves the HUD overlays alone (`onPartyReset` is not fired).

Fixtures (`server/internal/game/fixtures/*.json`, `?scenario=X` or
`itd.scenario(X)`): `fresh`, `broke_day3`, `mid_day10`, `full_office`,
`soft_lock`, `pre_victory`, `spare_pcs`, `broken_pc`, `doomed_debt`,
`virus_outbreak`, `admin_dept`, `worn_pcs`. `broken_pc`
(ITGAME-74): day 4, 11:00, three employees in office 1, all online, slot 0's
PC broken (0/3 repair clicks: the fixture pins `RepairNeeded: 3`) — the only
way to get a broken PC on demand (breakdowns roll at random; at most one per
office, so no second one appears). `doomed_debt` (ITGAME-118): morning of
day 8, $2000 of debt, a boss and one weak employee — doomed on every level:
on Hard/Hardcore the debt runs into the credit limit in a few days
(`state.bankruptInDays` > 0, the «До банкротства N дней» plate), on
Easy/Normal it is already deeper than the overdraft ($750 on Normal — one
day's expenses), so N = 1 and the party is bankrupt this evening
(ITGAME-156); `itd.set({money: -100})` gives an overdraft party that lasts
a couple of days (two on Normal, three on Easy). `virus_outbreak`
(ITGAME-103): day 4, 11:00, office 1 with 9 employees on a tier-1 router
(seats 1–4 on the router, 5–9 neighbours only), office 2 with 4, core level 1
(both offices' seats 1–4 in core); seats 1 and 6 of office 1 and seat 2 of
office 2 infected (0/3), the «Вирус в сети» card open, the wave at 12:00
(`virusWaveIn` 6) — one wave shows all three channels and an office-to-office
jump. `worn_pcs` (ITGAME-135): day 6, 11:00, $5000, office 1 with 6 PCs and 5
employees on a tier-2 router; seat 0 is «ЖК» and seat 1 «2×ЖК», both at the
wear limit, seat 2 is a dead PC («требуется замена», «ЭЛТ»), seats 3 and 4 are
worn «ЭЛТ», desk 5 is a free «ЭЛТ» without wear — every live seat is at the
limit, so the first breakdown of the office kills a PC (keep it paused).

**Doomed party** (ITGAME-118): `Game.BankruptInDays()` is the number of day
closes until bankruptcy, 0 when the party is not doomed, sent as
`state.bankruptInDays`. Doomed means phase `running`, money below zero
(nothing can be bought or fired) and income that does not cover payroll (and
interest, on a credit level) before the debt limit — on every level since
ITGAME-156: tonight's limit from today's `PayrollPerDay()`, later evenings
from the template's. Income comes from the
offline engine's day template where the forecast repairs as the best player
with action points (ITGAME-127, «Action points» below): today as many of the
most valuable fixes as `ActionPoints` are left, then `ActionPointsPerDay` a
morning, so a broken PC is not a free dead end even though the night no longer
fixes it (ITGAME-136); `BankruptInDays` repairs its own copy of the template, while
the offline catch-up keeps broken PCs broken (except in an office with an
admin, ITGAME-101) —, no buffs, no events, neutral
market; the income is summed exactly with the company carry, like the offline
engine (ITGAME-222); today counts from
the current tick, so N does not drift during the day. A level deadline
(`WinDayLimit`) that comes first gives 0: the party ends by `time_up`. The
HUD shows the plate once per day while N > 0 (ids `hud.doom`,
`hud.doom.surrender` → the «Удалить партию навсегда?» confirmation with the
party paused, `hud.doom.close`).

**Debt limit and overdraft** (ITGAME-156): an evening that ends below zero is
a debt; it bankrupts (`reason: bankrupt`) only when the debt is deeper than
the debt limit, `debtLimit(payroll)` in `game.go`: `CreditLimit` on a credit
level (Hard/Hardcore, with `CreditRate` interest), otherwise the overdraft —
`payroll`, the expenses that very evening charged (staff, bosses and admins
paid today, gateway opex, the billed antivirus tier). No interest there
(`CreditRate` 0), no day count. The live tick (`closeDay(expenses)`) and the
offline catch-up (`closeOfflineDay(s, payroll)`: the day's tail passes the
live `PayrollPerDay()`, full days the template's `dayExp` — the live game in
that loop keeps `UnpaidToday` and would understate it) hand `settleDebt` what
they charged. A day that starts at ≥ 0 cannot bankrupt on Easy/Normal that
evening (the charge equals the limit) unless an event fine deepens it.
`state.debtLimit` = `Game.DebtLimit()`; `state.creditLimit` stays the config
value (0 on Easy/Normal); `itd.state()` carries both (ITGAME-177). The HUD's
`hud.debt` reads «Долг -$X из -$Y · R%/день» on credit and «Овердрафт -$X
(мин. лимит -$Y)» on overdraft (the owner's wording, ITGAME-178) and sits in
the second row right after «Расходы $Y/день» (`hud.payroll`) — the overdraft
limit is that same number; the evening journal line (report and `hud.log`)
«кредит: долг $X под R%/день» / «овердрафт: долг $X из $Y (расходы дня), без
процентов». The limit is derived, not stored: no `Config`/`Save` field,
`SaveFormat` unchanged, a save from before ITGAME-156 continues under the
new rule.

**Repair clicks k/N** (ITGAME-93): a breakdown rolls its own N — uniform
`RepairClicksMin..RepairClicksMax` (3..15) from the server's seeded PCG, right
after the breakdown roll, so the party journal and `make replay` reproduce it.
N lives on the employee (`Employee.RepairNeeded` in the save,
`repairNeeded` in the snapshot, 0 while the PC works) and the office label
reads «✖ чинить k/N»; the N-th `repair_click` repairs and `call_master`
clears it. The night does not: since ITGAME-136 a breakdown, with its k and
N, survives `next_day`, the offline catch-up (`resetForNextDay`, the day
template) and the forecast, until it is clicked away, the master comes or the
office's admin gets to it (ITGAME-101: then the forecast and the catch-up
repair it on his schedule, see «Admins») —
`make sim`'s `random` policy never repairs, so its parties no longer live 30
days (normal 300×30: 39 timeouts → 0; they end bankrupt, 90, or in deadlock,
210). Saves from before ITGAME-93 (a broken PC without
`RepairNeeded`, a config with the old `RepairClicksNeeded`) restore as N = 3
and the 3..15 range. `make sim` models clicks as free (greedy clicks until
repaired), so N does not move its economics — what it changes is the player's
choice between clicking 3..15 times (≈ 9 on average, was 3) and the $150
master.

**Workplaces** (ITGAME-135, design in the GDD «Рабочее место: уровни ПК и
износ»): the PC level and wear live on the desk, not on the employee —
`game.Workplace{Level, Wear, Dead}`, `Office.Workplaces` one per PC (employee i
sits at desk i; `BuyPC` appends a zero one, `Restore` pads or cuts to `PCs` and
rejects a bad level, negative wear or a dead seat whose employee is broken or
infected). `Fire` rotates the workplaces so every remaining employee keeps their
PC and the fired desk becomes the first free one; `Hire` sits at desk
`len(Employees)` even if it is dead (`MinCostToEarn` then adds the replacement).
`Config.PCLevels` («ЭЛТ» ×1.0 / «ЖК» ×1.1 $350 / «2×ЖК» ×1.2 $600, ×PriceK, level 0
free) multiplies the personal output before the day effects and the network;
`Config.PCWearLimit` (8, Hard 24, Hardcore 40 via `difficultySpec.WearLimit`; 0 —
PCs never die) is the breakdowns a PC survives: wear is counted in
`rollBreakdowns` at the breakdown, and a breakdown on a seat at the limit kills
the PC without any new roll (same PCG draws as before while nobody is dead). A
dead seat earns 0 (counted in `lost`), gets no XP, is out of the breakdown,
virus and admin pools, is not the office's one broken PC, its infection goes
with it, and night, offline catch-up, forecast and `BankruptInDays` keep it
dead. Commands `upgrade_pc` / `replace_pc` (slot = desk, free desks allowed;
`Config.PCPrice` for the replacement, no ×1.15 growth; the level is lost) and
codes `pc_max_level` / `pc_dead` / `pc_fresh`. Protocol: `officeInfo.workplaces`
(`level`, `wear`, `dead`, `nextPrice`, one per PC), `prices.pcLevels` /
`pcReplace`, `state.pcWearLimit`; `employeeInfo.effectiveIncomePerTick` includes
the PC multiplier; `itd.state().deadPCs`. The office draws the level label
`office.pc.i` on every desk with a live PC (it opens the workplace window
«Рабочее место N — офис M» with `modal.pc.upgrade` / `modal.pc.replace`); a dead
seat is a grey `desk_pc_broken` with «✖ замена» (`office.dead.i`) and the button
«заменить $500» (`office.replace.i`). `make sim`: the greedy family replaces a
dead PC before anything else and upgrades one seat an hour only when no
expansion was left unaffordable; `random` knows both commands. The visreg
baselines (`fresh`, `mid_day10`, `full_office`, `spare_pcs`, `broken_pc`, …)
drift by the new desk labels — re-recording them is the owner's call.

**Virus on seats** (ITGAME-103, design in the GDD «Вирус (ITGAME-103)»): the
infection lives on the occupied seat like a breakdown — `Employee.Infected`
and `VirusClicks` (k of `VirusCleanClicks` = 3), sent as `employeeInfo.infected`,
`virusClicks`, `virusNeeded` (3 while infected, else 0), with the effect
`virus` −30% (`VirusMult` 0.7, `until` empty). An outbreak (`seedOutbreak`, when
the `virus` event activates) infects ⌈staff / `VirusSeedStaff`⌉ random seats of
its office that are healthy with a whole PC; none — the card is «Вирус отбит»
(`DayEvent.Repelled`, one option). `Game.VirusWaveIn` is one company timer in
party ticks: the first outbreak sets `VirusSpreadTicks` (18), a second one on a
live infection leaves it; `tickVirus` runs in `Tick` after `rollBreakdowns` and
before `activateEvents`, so the first wave comes exactly 18 ticks after the
outbreak, at lunch too and across the night. At 0 every infected seat with a
whole PC (a snapshot taken before the wave) infects one random eligible seat
of its reach — grid neighbours by row and column (`Config.OfficeCols` 4,
mirrored by `GRID.cols` in `OfficeScene.ts`, `TestOfficeColsMirrorsClientGrid`
compares them) ∪ the office's router seats if the seat is on a port ∪ every
core seat of the company if the seat is in core (`NetworkState.CoreLinked`);
targets are checked live, so two sources never share one. Rolls come from the
server PCG — the journal and `make replay` reproduce them. `virus_click`
(office, slot; `bad_office`, `office_locked`, `bad_slot`, `not_infected`) counts
k through `Employee.virusClick` — the one cleaning click the admins (ITGAME-101)
make too and security (ITGAME-100) will: the third one cleans the seat, and
`virusSettled` settles the rest — no infected seats left in the company stops
the timer, a clean office closes its open card and logs «вычищен вручную к
HH:MM» (an admin's click — «вычищен админом»). Firing an infected employee takes the infection
along (timer and card the same, no log line). Breakdowns and the virus are
independent: a broken seat is neither target nor source, repair and the master
leave the virus. Nothing cleans it by itself — `next_day`, `resetForNextDay`
and the offline day template keep it, the forecast and the offline catch-up
count infected seats at −30% and roll no waves (the timer stands still while
away) — except in an office with an admin, whom the forecast and the
catch-up let clean on his schedule (ITGAME-101, «Admins»); `BankruptInDays` cleans its own copy of the template, like it repairs
broken PCs — within the action points a day (ITGAME-127), not for free. `state.virusWaveAt` is the
clock from which the next wave is visible («HH:MM», tomorrow's morning across
the night, empty with no infected seats), `officeInfo.virusPCs` the infected
seats of an office (replaces `virusUntil`), `dayReport.virusPCs`/`virusLost`
the day's new infections and the income they cost (a broken infected seat's
loss stays in `lostIncome`); the day log gets «вирус в офисе N: k ПК», «вирус в
офисе N отбит», «…: чистим вручную» and at the evening «к вечеру заражено k ПК —
само не пройдёт». The card «Вирус в сети» has one option «Чистить вручную»
until the subscription (ITGAME-137). `make sim`'s greedy policy cleans every
infected seat on its hourly turn, like it repairs.

The client (ITGAME-138): an infected seat shows «☣ вирус k/3» (`office.virus.N`,
11px lime `#a7f070`) where «✖ чинить k/N» stands, inside the seat's one zone (see
below), and the zone blinks lime; the office plate reads «☣ вирус: k из n мест ·
волна в HH:MM» (an open event card covers it, as it covered the old plate);
every office tab carries «☣ k» right under it (`hud.virus.office0..2`, hidden at
0 — inside the tab «О1» and «9/12» leave no room), with no toast on a wave
(owner 16.10); the day report has «Вирус:     +k ПК за день (−$X)» under «Поломки» when
the day had new infections or lost income — «+k за день» are the day's new infections,
while the journal's «к вечеру заражено m ПК» counts every infected seat at 19:00,
yesterday's included (ITGAME-146); the first outbreak raises the one-time
hint `virus`, which like `master`/`softlock` is not held back by the coach. The
tooltip reads «ЗАРАЖЁН — выработка −30%; кликайте по месту: k/3» and «вирус −30%»
among the effects, motivation «после чистки»; a broken infected seat says «ЗАРАЖЁН
— после ремонта вирус останется». `itd.state()` gives `virusPCs` (company total)
and `virusWaveAt`; `itd.step`/`itd.advanceDays` go through the offline engine, so
they roll no wave and the timer stands still — to see a wave, set `virusWaveIn: 1`
with `itd.restore` and let live ticks run (`qa:hud` V2, `qa:journal` J3b). The
desk stays `desk_pc`: the infected desk sprite is ITGAME-134.

**Action points** (ITGAME-127, design in `docs/superpowers/specs/2026-10-21-action-points-design.md`):
the director has `Config.ActionPointsPerDay` = 8 points a day (`Game.ActionPoints`),
refilled to full on `NextDay` and on each offline morning. Starting a repair or a
virus cleanup of a place costs 1 (`startAction`; no points → the refusal
`no_action_points`, client toast); work already started (`RepairClicks`/`VirusClicks`
> 0) continues free, and motivation, the master, a PC replacement and admins
cost nothing. The snapshot carries `state.actionPoints` and `actionPointsMax`; the
HUD shows «Очки: k/8» in the money row (`hud.points`, red at 0), idle place labels
read «✖ чинить · 1 очко» / «☣ вирус · 1 очко» until the first click, tooltips say
«начать ремонт — 1 очко действий» / «начать чистку — 1 очко действий». The
bankruptcy forecast (`doomRepairQueue`) repairs as the best player with points:
repair is worth the place's output (× `VirusMult` on an infected place), a
cleanup output × (1 − `VirusMult`); admin offices and started work are free; today
`g.ActionPoints`, then the pool each morning. `SaveFormat` 4. In `itd`:
`snapshot().state.actionPoints`; a QA run sets the points through the restore/delta
path (`save.actionPoints`) within [0, 8] — outside the range the save is refused.

**Antivirus subscription** (ITGAME-137): `Config.AntivirusTiers` — SOHO Edition 4
seats $12, One Office 15 seats $40, Enterprise all seats (Seats 0) $90 a day,
ordered by price and scaled ×WageK in `ApplyDifficulty` (easy $10/$32/$72, hard
$15/$50/$113, hardcore $18/$60/$135). One subscription per company: `Game.AVTier`
(0 — none, 1..3) and `AVTierBilled`, the most expensive tier switched on that day
— the evening charges its price; `next_day`, `resetForNextDay` and the offline day
template start a day at `AVTier`. `AVCovered()` gives the first N occupied seats
of the company in core order (offices 1 → 2 → 3, by hire), whatever the network;
firing shifts it. A covered seat is never a target of an outbreak or a wave
(`virusTarget`), an already infected one is not cured and still spreads to
uncovered seats. `set_antivirus` (tier in `slot`, 0 switches it off): `bad_tier`,
`antivirus_already`; going up costs nothing at once but refuses
`not_enough_money` while money is below the new tier's day price (no purchases
in debt), going down or off always works. The price is part of `PayrollPerDay` —
so of the forecast, `dayProfit`, `BankruptInDays` and the offline catch-up — and
of the evening `chargeDay`: `DayLedger.antivirus`, `dayReport.antivirus`, not part
of «События». The virus card offers «Подписка <tier> $X/день» as option 1 — the
cheapest tier covering the whole staff, when the current one does not — which
connects it (`not_enough_money` keeps the card); an outbreak whose office is fully
covered gives «Вирус отбит: подписка <tier> защитила офис N» (`DayEvent.AVTier`
remembers the tier) and the log line «вирус в офисе N отбит подпиской <tier>».
Saves of format 1 without tiers in the config restore with the tiers of their
difficulty — the format stays 1. Protocol: `state.antivirus {tier, name, seats,
covered, billedToday}`, `prices.antivirusTiers [{name, seats, price}]`,
`employeeInfo.avCovered`. Client: `btn.antivirus` under «Шлюз» in the server room
(x 1142, y 506) opens «Антивирус» — the current tier and covered seats, «защитит
k из n» per tier, today's charge, buttons `modal.av.1..3` and `modal.av.off`; the
current tier («✓»), an upgrade without the money and «Отключить» without a
subscription are disabled (`ModalButton.disabled`: grey, `D` in `itd.screen()`, a
click sends nothing and keeps the window). A covered seat draws a blue shield under
the network dot; the tooltip says «антивирус: <tier>», «антивирус: место вне тарифа
<tier>» or «без антивируса»; the day report «Антивирус: -$X» under «Интернет»;
`itd.state().antivirusTier`. `make sim` policies never subscribe.

**Admins** (ITGAME-101, design in the GDD «Админы (ITGAME-101)»): admins sit in
their own department — `Game.AdminDept`, bought once by `buy_admin_dept`
(`Config.AdminDeptPrice` $3,000 ×PriceK; `admin_dept_already`,
`not_enough_money`), `state.adminDept`, `prices.adminDept`; without it
`hire_admin` answers `admin_dept_locked`. Each admin is bound to an office like
the boss, fields of `Office`, not an `Employee` — `Admin` (name, "" — none),
`AdminUnpaidToday`, `AdminHireDay`; no seat, PC, port, core capacity or
subscription, outside `staffCount`/`TotalEmployees`, `WinStaff` and
`IsDeadlocked`. `hire_admin` / `fire_admin` (office; `admin_already`,
`no_admin`, `not_enough_money`, `office_locked`): `Config.AdminPrice` $600
×PriceK, `AdminSalaryPerDay` $300 ×WageK in `PayrollPerDay` (hired from 15:00 —
unpaid today, reset with the boss's flag), fired for a day's salary or
`FireCompSameDay` on the hire day (`AdminFireCompensation`). Every tick, lunch
included, `adminTick` runs in `Tick` after `activateEvents` and before the
income: `Office.adminWork` makes `AdminClicksPerTick` (2) clicks with the same
`repairClick` / `virusClick` as the player's, the target recomputed per click by
`Office.AdminTarget` — the first infected seat with a whole PC, else the broken
one — so a spare click goes on, a new infection preempts a repair (its clicks
stay), and a broken infected seat is repaired first and cleaned next. The work
touches seats only; `adminTick` adds `DayAdminRepairs` / `DayAdminCleaned` and
calls `virusSettled(oi, cleanedByAdmin)`. No rolls — the journal records
`hire_admin`/`fire_admin` only and replays byte for byte (`ws`
`TestJournalReplayAdminParty`). The forecast runs `adminsWork` on
`seatsCopy()` tick by tick, so `forecastEndOfDay`/`dayProfit` see a seat whole
from the tick the admin gets to it; the offline catch-up runs the admins in
the tail and the partial day (`offlineIncome`, log silent) and, when a backlog
is left for the first full day, counts that day tick by tick on the template and
`adoptSeats` it into the live game, day after day while a backlog is left (on
the default config it is gone within a day: 15 + 12 × 3 clicks against 2 × 54;
a config delta can stretch it). The catch-up's admin work logs nothing —
a card closed by an admin while away has no «вычищен админом» line, and
`itd.step` / `itd.advanceDays` go through this engine, so to see the line
in QA let live ticks run. The virus card adds « Админ офиса вычистит
сам к HH:MM.» (`adminCardLine`: the tick of the admin's last click by his
queue, across the night — tomorrow's morning). Protocol: `officeInfo.admin`,
`adminUnpaidToday`, `adminSlot` (−1 — idle or none) and `adminKind`
(`repair` | `virus` | ""), `adminFirePrice`; `state.adminSalaryPerDay`,
`prices.admin`; `dayReport.adminRepairs`/`adminCleaned`. A config without the
admin fields restores with its difficulty's. The client is ITGAME-145 (see the
department room below). `make sim` (300 × 30): `--policy all` stays
greedy/idle/random, byte for byte; `handsoff` clicks only offices under 4 staff
(with no clicks at all a one-PC company breaks on day 1 and earns nothing after:
on normal one evening in overdraft and bankruptcy the next, most often on day 3;
on hard credit carries it to day 10–15) — the price of being away;
`delegate` clicks an office until it has an admin and hires one into every
office that grows to 4 as soon as the money allows (the department first) — the
price of delegating: normal greedy median $156,872, handsoff $35,968, delegate
$144,801 (no bankruptcies); hard $28,657 / $1,247 / $18,035 (median money on
the last row of each party; re-measured 21.10 after ITGAME-196/203 — on 20.10
with ITGAME-135 workplaces normal was $156,385 / $36,917 / $144,342 with 3
bankrupt of 300 each, hard $29,190 / $1,186 / $18,862; before workplaces normal
$135,061 / $38,218 / $125,018 and hard $35,994 / $1,196 / $27,794).

The department room (ITGAME-145, `AdminDeptScene`, scene key `adminDept`): the
fifth nav tab «АДМ» (`nav.adminDept`) under «СРВ» — while not bought a lock
(`hud.lock.adminDept`) and the price, green when affordable, like a closed
office; bought — «k/3», admins hired. A closed room reads «Отдел админов
закрыт» with `dept.buy` «Купить отдел — $X» (sends `buy_admin_dept`, the server
refuses without money) and one line on what it gives. An open room has three
seats in a row by office (x 330/560/790, y 300, boxes 92×92): «офис N» above;
inside the admin figure `dept.admin.N` (the `worker` sprite until its own) or
«нет админа», a locked office's box dimmed with «офис не куплен» under it; under
the figure the name (`dept.name.N`) and the target line `dept.status.N` —
«чинит место 5» (red), «чистит место 3» (lime) or «свободен» (grey), from
`adminSlot`/`adminKind`. Hover — a tooltip (name, «Админ офиса N: чинит и
чистит его места сам», «2 клика в тик, сначала вирус, потом поломка» — the 2
is a client mirror `ADMIN_CLICKS`, the salary, «Сейчас: …» with k/N, the fire
price); a left click does nothing, a right click opens «Уволить админа?» with
the compensation and sends `fire_admin`. The room's action column (from y 170)
holds `btn.admin.0..2` «Админ ОN / $600»: hired — «Админ ОN ✓» disabled with
«Нанят: <name>», a locked office or no money — disabled with «Офис N не куплен»
/ «не хватает $X»; hidden while the room is closed. The lower half of the room
is left empty for the cabinets and workbenches to come. Elsewhere: the office
seat tooltip adds «чинит админ» / «чистит админ» on the seat the admin clicks
next; the day report says under «Вирус» what the admins did, in verbs
(`adminsReportLines` in `format.ts`, ITGAME-159): «Админы:    починили k ПК,»
and, under the value column, «           вычистили m мест» — on one line the
pair is 42–44 characters of 16-px Departure Mono (10.18 px each) against 38
inside the 440-px panel's 24-px pads; only the non-zero part when the other is
zero («Админы:    починили 1 ПК»), no line when both are; the seat plural is
`seatsLabel` (also the antivirus window's); `not_infected` / `not_broken`
from a command while the active office has an admin raise no toast and no sound
— the player's finishing click there regularly loses the race to the admin's
tick; `itd.state()` gives `adminDept` and `admins` (count). Fixture
`admin_dept`: day 5, 11:00, $8,000, the department bought, office 1 (8 staff,
router t2, core 1) with an admin whose queue runs seat 2 → 7 → repair 4 and
then he is free, office 2 (4 staff) without an admin and a broken seat 3,
office 3 closed.

**One click zone per workstation** (ITGAME-92): every occupied desk has a
single interactive zone `office.slot.N` — the union of the worker frame and
the desk (64×64), plus the «✖ чинить k/N» label while the PC is broken
(the width is the union of the «N/N» bounds, so it does not jump between «9/12»
and «10/12», and of the idle label «✖ чинить · 1 очко» of ITGAME-127, which is
the widest — ≈123px of text, so the zone stays the same after the first click) or the «☣ вирус k/3» label while the
seat is infected (82×81, measured on «3/3»). A seat has one state at a time —
broken > infected > healthy (ITGAME-138): a broken infected seat shows the
breakdown, and after the repair the virus label is back. Left click picks the
action by state: broken PC → `repair_click`, infected → `virus_click`,
otherwise → `motivate`; right click («Уволить сотрудника?») and the tooltip are
the same in every state. While broken the zone itself blinks red, while
infected lime (it is the click target); a healthy desk's zone is
transparent. The worker sprite (`office.worker.N`) and the labels
(`office.repair.N` only while broken, `office.virus.N` only while infected) are plain images without input: their
ids stay for `itd.nodes()` (texture, position) and `itd.click`/`itd.hover`,
which forward to the zone — the same as a real click at that point. So
`itd.stack`/`itd.hit` at any of them answer `wins: office.slot.N`
(`itd.hit('office.worker.0').ok` is `false` by design: the zone takes the
click), and `itd.screen()` lists only `office.slot.N`.

**Tooltip vs windows** (ITGAME-89): opening any office window (router, fire
dialog) hides the worker tooltip and forgets the hovered slot; while a window
is open (an interactive object above the tooltip's depth 40 — the modal
backdrop, depth 70) the office shows no tooltip, neither from a new snapshot
nor from `itd.hover`. A hidden tooltip keeps its last text — only its
container is hidden — so once shown it stays in `itd.text()`, with
`visible: false` (world visibility, ITGAME-87; `qa:facade` K1); filter on
`visible` to skip it.

**«Админка» link** (ITGAME-22): shown over the canvas only to the owner —
always under `?debug=1`, otherwise gated by `localStorage.itd.admin` (set
once via `?admin=1`, cleared via `?admin=0`; the `admin` query param is
stripped immediately after reading, so a shared link with the flag doesn't
linger in the URL). Cosmetic only: `/admin` is not exposed on the public
domain regardless (see [Deploy](#deploy)).

**Build stamp and «устарело, обнови»** (ITGAME-78): the same `#topbar` shows
the tab's own build sha (`#build`, = `itd.version.sha`; its title also carries
the build version, `itd.version.version`, ITGAME-140) left of «Админка».
`client/src/buildstamp.ts` compares it with the build the stand would serve on
reload — the sha in `<meta name="build">` of a fresh `GET /` — and, if that is
missing, with the server binary's sha (`GET /api/version` → `{sha}`, public,
`no-store`; the SHA a stamped build links into `ws.buildSHA` (ITGAME-81),
else `vcs.revision` of `go build`, `unknown` under `go run` or an unstamped
archive build). On a
mismatch a red «устарело, обнови» button (`#stale`, click reloads,
`#topbar[data-stale]`) appears. Checks run on load, after a socket reconnect
(a stand restart drops WS), on returning to the tab and once a minute while it
is visible. `await itd.stale()` runs a fresh check and answers `{client,
server, dist, stale, at, shown}`; `shown` (ITGAME-88) — whether the badge is
actually on screen after this check (a hidden badge stays in the DOM as
`display: none`, 0×0 — don't judge it by its presence; `false` also where there
is no `#topbar`); `stale: null` means there is nothing to compare
(vite dev serves no meta and hot-reloads anyway; a build with neither
`BUILD_SHA` nor git reads `dev`; so does a release built before
`tools/deploy` stamped, ITGAME-98, see [Deploy](#deploy) — there `stale`
stays `null` and the badge never shows). A stamped release (ITGAME-81) is
checked against the served `<meta name="build">`; `server` comes from
`/api/version` and is `null` where nginx does not proxy it (see
[Deploy](#deploy)).
`itd.screen().meta.stale` carries the
last result.

`itd.help()` prints the full command reference in the console. Worth
documenting separately:

- **`itd.nodes()` / `itd.ids()`** — every object of the live scenes
  (`{scene, type, id, text, x, y, w, h, cx, cy, visible, alpha, interactive,
  depth, active, disabled, fill}`) / just the stable interactive ids (`btn.*`, `nav.*`, `office.*`,
  `room.*`, `menu.*`, `modal.*`). `active` (ITGAME-38) is a
  `setData('active', …)` flag scenes set on toggle-like objects (speed
  buttons, nav tabs, the debug toggle, checkboxes, zoom) — distinct from
  Phaser's own `GameObject.active` — `null` for anything that isn't a
  toggle. `x`/`y` is the object's position by its origin (top-left for HUD
  plates, centre for texts and some modal buttons), so for a real click use
  `cx`/`cy` — the centre of the world bounds (acceptance 10.10). `visible` is
  world visibility (ITGAME-87): a hidden container makes all its children
  `false` — the office tooltip's text kept `visible: true` with its content after
  the pointer left, because only the container is hidden; `hit()`/`stack()`
  answer `узел невидим` for such a child, `screen()` skips it. `fill` (ITGAME-88)
  is a filled shape's colour as `#rrggbb` (Rectangle, Triangle, Arc/circle,
  Ellipse, Polygon — Phaser `Shape` with `isFilled`; the menu's focus marker is a
  Triangle), `null` for everything else (Text, Image, Container; a Graphics keeps
  its colour in the command buffer and is not read).
- **`itd.state().menuReady`** — the menu is active, its `saveSettled` (ITGAME-19)
  and, since ITGAME-88, no SceneManager operation on `menu` is queued:
  `itd.sandbox()`/`sandbox.restore()` call `scene.restart()`, which runs on the
  next loop step, so the old menu (with the old save summary) answered ready and
  then rebuilt — a plate's `cy` moved 351 → 309 when the «Продолжить» card
  («загружаю сводку…») appeared and went. There is no entrance tween: once
  `menuReady` is true the plates don't move (`qa:facade` K4). QA scripts wait
  for it through `waitMenuReady()` in `client/scripts/lib/menu.mjs`
  (ITGAME-133), not for `menu.diff.normal` in `ids()`: with a saved sid the
  plates are drawn while the save summary is still in flight, and a difficulty
  click then opens «Начать заново?» instead of starting the party (ITGAME-130).
  Pages without `?debug=1` (`smoke-ui` with `OFFICE=1`, `qa:facade` L6) have no
  `window.itd` and wait for `scene.isActive('menu')`; they run without a sid.
- **`itd.hit(id)` / `itd.blocker()`** (acceptance 10.10) — `itd.click()`
  bypasses the hit test, so it can't tell a covered button from a live one.
  `hit(id)` runs the real Phaser hit test at the object's `cx`/`cy` — the
  same code as `itd.stack()` below (hit areas, `renderList` order,
  `topOnly`/`globalTopOnly`; until 10.10 it was an emulation by bounds and
  depth) — and answers `{ok, at, top}`: `top` is who would take a real click
  (e.g. the day report's dimmer, depth 50, over `btn.menu`), `null` when no
  hit area covers the point; `depth` of an object inside a container is the
  root container's. `blocker()` is the topmost visible interactive covering
  the whole 1280×720 canvas (report dimmer, modal backdrop) or `null`.
  Both carry `safe` and `title` — the window title a scene stored on that
  backdrop with `markTitle()` (ITGAME-72).
- **`itd.screen({frame?, free?, scene?})`** (ITGAME-72) — the screen map in
  one call: `{ok: true, meta, n, items}`. `meta` is `sha`, `tab` (sid prefix), the
  server's `day`/`clock`/`t`/`bal`/`speed`/`phase`/`staff`/`pay`, what the HUD
  actually draws (`hudClock`, `hudBal`), `blocker` (`safe` or scene `@depth`)
  and `title` (the topmost `markTitle()` object: modal and report backdrops,
  the event card, the disconnect screen). Each item is a string
  `'safe|label|x|y|flags'` (25 items of a day report fit in ~1000 characters
  of a tool answer): the label is the texts whose bounds lie wholly inside
  the element's bounds (±2 px; ≤ 22 chars, `-` for icons) — a neighbour whose
  centre merely falls on the edge is not part of it (the exit window's ✕ used
  to stick to `btn.event.1` under it, ITGAME-113), `x`/`y` the bounds centre in CSS px of the window (from the
  canvas' `getBoundingClientRect`, so zoom, «по окну» and `#topbar` are
  included), or in a screenshot frame `frame` px wide. `frame` is that width
  in px, a number ≥ 100: anything else (1, 0, `NaN`, a string) →
  `{ok: false, code: 'bad_frame', error}` instead of coordinates for a 1-px
  frame (ITGAME-148: an agent passed the wrong unit). Flags: `A` — active
  toggle, `X` — covered (`hit()` not ok), `D` — disabled: `markDisabled()`,
  set by the room action buttons (`btn.pc`, `btn.hire`, `btn.boss` in the
  office, `btn.gateway` in the server room — see [Rendering](#rendering))
  when money/seats/PCs are missing, also `nodes().disabled`.
  `free: true` keeps only items without `X`.
- **`itd.stack(id | gx, gy)` / `itd.zones(a, b)`** (ITGAME-74) — the real
  Phaser hit test (`hit()` and the `X` flag of `screen()` use it too): the same
  `InputManager.hitTest` over each scene's input list (hit areas in the
  object's local space, camera, container visibility), ordered by
  `InputPlugin.sortGameObjects` (the camera's `renderList` of the last frame),
  scenes top-down with `globalTopOnly`/`topOnly` — just without emitting events.
  `stack()` takes an id/safe id (its `cx`/`cy`) or world `gx, gy` and answers
  `{ok, at, stack, wins}`: `stack` lists every interactive under the point top
  to bottom as `'safe scene dN Type WxH'` (a trailing `!` — its scene is below
  the one that took the click), `wins` is who gets `pointerdown` — an object here, while `itd.trace().pointer[].wins` is a label string since ITGAME-179.
  An object added in this frame is seen from the next one (ITGAME-113):
  `setInteractive()` queues it in the input plugin's `_pendingInsertion`, the
  scene's `preUpdate` moves it into the hit-test list on the next loop step,
  and Phaser handles a mousedown synchronously in its DOM handler against that
  same list — a real click in the same instant misses it too and goes to
  whatever is under it, so `stack()` deliberately doesn't read the queue. To
  see a fresh object at once, await a frame (`requestAnimationFrame`); in a
  hidden tab `stack()` warms the loop itself.
  `zones(a, b)` walks a 1 px grid over the union of both bounds and returns
  `aUnderB`/`bUnderA` rectangles — where the point is in A's hit area but B
  takes the click, and vice versa — plus `area` in px² (`a`, `aUnderB`, `b`,
  `bUnderA`). Example: on `broken_pc`, `itd.zones('office:slot:0',
  'office:master:0')` has empty `aUnderB`/`bUnderA` — the master button sits
  outside the workstation zone. (Since ITGAME-92 `office.worker.N`/`office.repair.N`
  have no hit area — the old example `zones('office:repair:0',
  'office:worker:0')` answers zero areas.)
- **`itd.offline()`** — the page's last offline catch-up `{ticks, days,
  shown, at, droppedAt, leftAt, liveTicks, open, paused, seq, awayId}` or `null` (`open` —
  the window is on screen now, `paused` — session speed is 0 now). It is the
  *last* catch-up of the page, not «the current one»: after an away without a
  catch-up it still returns the previous one. Compare by key (ITGAME-87): `seq`
  numbers the page's catch-ups (1, 2, … as `offline_report`s arrive), `awayId` is
  the `itd.away` during which it arrived (`null` — F5, a reconnect,
  «Продолжить»). The key is assigned in the facade from the wire tap (the
  `offline_report` frame is seen just before `net.ts` stores `lastOffline`), so
  `net.ts` is unchanged.
  `droppedAt` is `offline_report.savedAt`, the last save before the drop (the
  actor saves every tick, so it is when the server noticed); `leftAt` is the
  tab's own `pagehide` (`sessionStorage` `itd.leftAt` with the speed then);
  `liveTicks` = ticks the party ran live between the two, 0 when the save
  precedes the leave. The server now sends `offline_report` whenever the
  catch-up advanced any tick (or hit a finale); the HUD shows «Пока вас не
  было» only for `days > 0` or a finale (`offlineShown()` in `net.ts`), so a
  short in-day gap stays silent for the player but is visible here. A save
  paused or sitting in a day report catches up nothing — no message, `null`.
- **`await itd.away(sec, {mode, timeout})`** (ITGAME-76) — the tab «goes
  away» for `sec` (0..600) seconds without leaving the page and comes back to
  the same party (same sid — a sandbox's or the owner's; no example.com, no
  new tab without the sessionStorage sid, no lost first click after
  navigation). `mode: 'close'` (default) — like a closed tab: a close frame
  without `exit`, the server knows at once. `mode: 'net'` — like a network
  drop: `POST /api/debug/drop?sid=&timeout=` (`ITGAME_DEBUG`) makes the server
  stop reading and writing that tab connection with no close frame (the hub
  forgets it, `readLoop` throws incoming frames away, no pings); the server
  notices by its own read timeout — the same path as a real drop — and until
  then the party runs live: exactly what agent attempt F tripped on (2x from
  tick 45 reached the day report live). `timeout` (ms, 50..600000) shortens
  the read timeout of that connection only, for QA; without it the server's
  (`ITGAME_READ_TIMEOUT`, 30 s). For the whole away the tab neither hears nor
  speaks: incoming frames of that socket are dropped, commands answer
  `not_connected`, `server().socket` is `reconnecting`, no reconnects of its
  own. After `sec` it opens a new socket and waits for its first snapshot
  (`cause: 'resume'`, via `client.waitState`) and, if it says
  `offlineReport`, the report itself. Answer `{ok, mode, sid, leftAt, back,
  resumed, rev, drop, offline}`: `leftAt` — when the tab went away (also
  written as `itd.leftAt` like `pagehide`, so `offline().liveTicks` works),
  `back` — the first snapshot of the new socket, `drop` — the drop answer
  `{at, timeoutMs, noticeBy}` (`noticeBy = at + timeoutMs`, the server notices
  not before it and at most a quarter of the timeout after), `offline` —
  the catch-up *of this away* (`offline.awayId === awayId`, ITGAME-87;
  `droppedAt` = when the server noticed) or `null` when there was no catch-up
  (the server had not noticed before the return, or the party was paused);
  `awayId` numbers the page's aways (1, 2, …). Until ITGAME-87 the match was by
  `at >= leftAt` inside `away` only, and `itd.offline()` after an away without a
  catch-up silently showed the previous one. Codes: `bad_sec`, `bad_mode`,
  `already_away`, `not_connected`, `finished` (no save after a finale — the
  return would start a new party), `drop_failed` (no `ITGAME_DEBUG`, headless
  agent session: `409 no_tab`), `interrupted` (the tab went to the menu or a
  new party meanwhile), `no_return`, `not_resumed`. Example, 2x: `away(4,
  {mode:'net', timeout:1500})` → `drop.at` +1.5 s `offline.droppedAt`,
  `liveTicks` 3, `ticks` 5; `away(3)` → `droppedAt` ≈ `leftAt`, `liveTicks`
  0, `ticks` 6.
- **`itd.errors()`** — page errors, kept in the tab's `sessionStorage`
  (`itd.errors`, last 100) so they survive a reload/navigation; `load` is the
  page-load number in this tab (`itd.loads`). `itd.injectError(msg)` throws
  an «itd.injectError: …» page error on purpose, to test the journal when
  the game has none; such entries carry `injected: true`.
- **`itd.sandbox(label)`** (ITGAME-77) — the agent's own party in this tab in
  one call, with the owner's keys guarded. From the menu (in a party:
  `code: 'in_party'`) it records the owner's shared `localStorage`
  `itd.sid`/`itd.diff`/`itd.onboard` (ITGAME-21: a sandbox party that finishes
  the HUD onboarding chain must not hide the coach from the owner) and the
  tab's `sessionStorage` `itd.sid`/`itd.sid.auto`
  in `sessionStorage` `itd.sandbox` (survives a reload), sets the explicit tab
  sid `a-<label>-<ms>` and restarts the menu → `{ok, sid, owner: {sid, diff}}`.
  While the record exists `net.ts` never falls back to the shared key: a new
  party (`prepareNewGame`) and the sid after a finale or «Сдаться»
  (`sessionId()`) are fresh sandbox sids, and `hasSavedSession()` looks at the
  tab only — before, «Сдаться» dropped the tab sid and the next «НОРМА»
  overwrote the owner's key. `itd.sandbox.fakeOwner()` writes a foreign shared
  key (`fake-owner-<ms>`, a different difficulty) through the game — the
  browser agent's `javascript_tool` can't write `localStorage` — so the
  `clearSession()` guard can be measured. `itd.sandbox.restore()` (menu only)
  answers `{sidSame, diffSame, fake, restored, kept, removed}`: `sidSame`/
  `diffSame` — the shared key is still what it was at entry (or the fake);
  our fake or an erased value is put back, a foreign value (the owner played
  in another tab meanwhile) is left alone and listed in `kept`; the tab keys
  return to their entry values and `itd.sandbox` is removed.
- **`itd.claim(label)`** (ITGAME-151) — the browser agent's tab is visibly
  taken. A 40 px `div#itd-claim` (`position: fixed`, `pointer-events: none`, so
  neither the layout nor clicks change; it covers the debug `#topbar`) reads
  «▶ АГЕНТ работает в этой вкладке (label, sha) — не кликай», and the tab title
  becomes «▶ АГЕНТ — смотри, не кликай». Every real press (window capture
  `pointerdown`/`mousedown` with `isTrusted`; events within 50 ms are one
  press) is counted: `own` after `itd.claim.mine(n = 1, ms = 20000)` — the
  agent's own CDP clicks are `isTrusted` too, so it declares them; `allowed`
  while `itd.claim.allow(what, {target})` is open (green bar «▶ ТВОЙ ХОД: …»);
  otherwise `foreign`, and the bar flashes red for 600 ms. `dispatchEvent`
  presses only raise `synthetic`. Each press keeps `wins` and `got` as in
  `itd.trace`; `itd.claim.deny()` closes the allow window → `{what, target,
  presses, hit}`, `hit` meaning the target got an allowed press. The record
  lives in `sessionStorage` `itd.claim` and is rewritten on `pagehide`, so it
  survives F5 and `itd.reset()` (`reloads`); `installAgentApi` restores it
  before Phaser `READY`. `itd.claim.stop()` returns the final count, removes
  the bar and sets the title «вкладка свободна». `hit` is `null` when the
  window has no `target`. Without the debug `#topbar` (no `?debug=1` /
  `itd.admin`, e.g. a DEV build or `itd.debug=1`) the 40 px bar covers the top
  ~32 px of the canvas. Chrome's «Duplicate tab» copies `sessionStorage`, so a
  duplicated agent tab gets the bar too. Pure logic:
  `client/src/debug/claimCore.ts` (`npm test`); the bar: `claim.ts`.
- **`itd.cmd('abandon')`** goes the «Сдаться» button's way
  (`HUDScene.abandonParty`: delete the save, back to the menu). A bare
  `abandon` frame let the client reconnect, and the server started a new
  party under the same sid (retro 10.10). It skips the «Удалить партию
  навсегда?» confirmation (ITGAME-86): an agent's command is a deliberate
  indirect action, not a stray click; to test the dialog click `btn.menu` →
  `modal.btn.1` → `modal.btn.0` («Удалить») / `modal.btn.1` («Отмена»).
- **`safe` ids** — `ids()`/`nodes()` also carry `safe`, the id with `:`
  instead of dots (game ids have no colons, so it is reversible):
  the browser agent's tool blocks `a.b.c` strings as JWTs. `click`, `hover`
  and `hit` accept either form.
- **`itd.overlaps()`** — the layout linter; each finding carries a `kind`
  (ITGAME-38): `text` (two same-depth texts), `occlusion` (text under an
  opaque plate), or `interactive` (an interactive container/sprite/checkbox
  partly covered by another interactive or by text — full containment
  doesn't count). A modal dim is never an occluder or an interactive party
  (ITGAME-87): every full-canvas dim is created through `markDim(obj, title)`
  (`agentApi.ts`; `markTitle` + data key `dim`) — the day report, «ТУПИК» /
  «ВРЕМЯ ВЫШЛО» / «БАНКРОТСТВО», «ПОБЕДА!», «Пока вас не было», the disconnect
  screen, `showModal` (`ui/modal.ts`) and the menu's modal frame. Before, the
  alpha decided: the finale's 0.9 dim passed the `fillAlpha ≥ 0.9` occluder rule
  and gave ~22 `occlusion` entries, the report's 0.75 gave 0. What a dim blocks
  from clicks is `itd.hit()`/`itd.stack()`'s business. A new dim must use
  `markDim`. A pair across a visible dim — one object drawn under it, the other
  above it — is not a finding either (ITGAME-141): a tall day report's panel
  covers `hud.log` and its `btn.next_day` stands over it, which is the modal
  doing its job; pairs on the same side are linted as before. Every finding also carries `ratio` (intersection area over
  the area of the smaller box of the pair; for `occlusion`, over the text's
  area) and `threshold` it was compared against.
  `itd.overlaps({ minAreaRatio })` (0..1) replaces the default thresholds
  (`text`/`interactive` 0, `occlusion` 0.25 plus the old >50%-on-each-axis
  rule); `0` is the strict mode, a value outside 0..1 throws `RangeError`.
- **`itd.offscreen()`** — objects sticking out of the 1280×720 world (world
  px); since ITGAME-61 also one `{scene:'page', type:'canvas', id:null}`
  entry when the canvas itself does not fit the visible window area
  (`bounds`/`out` in CSS px) — a UI scale too big for the window; `out.right`
  also counts `#app`'s own horizontal overflow (it scrolls by itself). «по
  окну» sizes from `documentElement.clientWidth` (not `innerWidth`, which
  includes a vertical scrollbar), and `body` is a flex column so `#topbar` +
  `#app` never exceed the viewport height (acceptance 10.10: the old
  `#app { min-height: 100vh }` plus the topbar scrolled the page, the
  scrollbar ate 14 px and «по окну» overflowed by 6). At the QA
  viewport 1920×1080 with 1×/1.4× it is absent, so visreg/qa counts are
  unchanged.
- **`itd.contrast()` / `itd.tiny()`** — walk nested containers too (ITGAME-116):
  Phaser 3.90 removes a container's children from `scene.children.list`, so
  the tooltip text (`room.tooltip.text`) used to be invisible to both. Effective
  visibility is the whole parent chain, effective alpha the product along it;
  the background under a text is looked up in one flat render order where a
  container's children follow the container (so `room.tooltip.bg` is found).
  Since ITGAME-117 `itd.overlaps()` (text-text, occlusion) uses the same flat
  render order: texts and covering rectangles inside containers count, the
  layer of a child is its top-level container's `depth`, "above" means later
  in render order, hidden/translucent ancestors hide/dim their children;
  `itd.offscreen()` checks a container as one box (its bounds union its children).
- **`itd.log(n)`** — the ring buffer (200 entries, survives a console
  clear) of state/day/phase/speed/scene transitions, server errors and page
  errors, plus, since ITGAME-38, every `playSfx` call and HUD toast
  (`{type:'sound', key, name, volume, scene, ok}` /
  `{type:'toast', text, where, ms, bg, scene, icon?}` — `icon` is the sprite
  key drawn left of the text: on an achievement toast since ITGAME-83 the
  achievement's own `ach_*` when it is one, `icon_trophy` when several unlock
  at once; the emoji prefix in `text` is gone), routed through
  `client/src/uibus.ts`; since ITGAME-48 also one boot entry for the fonts,
  `{type:'font', ok, ms, faces, font, reason?}` — `ok:false` (load error or
  the 4 s timeout) means the whole session renders with plain `monospace`.
- **`itd.step()` / `itd.advanceDays(n)`** (ITGAME-56) fast-forward through
  `/api/debug/advance` with the *offline* engine (`AdvanceOffline`, the same
  summary formula as the «while you were away» catch-up): no coffee rolls,
  events, breakdowns or XP, and a day boundary closes without a day report
  and without `next_day`'s rolls — neither `day_report` nor `offline_report`
  reaches the client. If the game sits in `day_report`, the server first runs
  a normal `next_day`. `step` pauses first (`set_speed 0`, left at 0) and takes
  either milliseconds (`itd.step(2000)` = 2 ticks, up to 10 ticks — the old
  form) or ticks (`itd.step({ticks: 60})`, 1..10000, the server's limit);
  `advanceDays(n)` moves n whole days (1..90) and sends no `set_speed` itself.
  From an open day report the HUD sees the `running` snapshot, closes the
  report and restores the pre-report speed (nobody else sent `set_speed`, so
  its `speedSeq` rule holds), exactly as the «next day» button does — the
  party then runs live; call `itd.pause()` *before* `advanceDays` if you need
  it paused (its `set_speed 0` bumps `speedSeq`, so the HUD restores nothing;
  `step` is not affected for the same reason: its own `set_speed 0` bumps it). The
  summary comes back in `.advance` (`{ticks, days, income, payroll, balance,
  gameOver, victory, reason?}`) and lands as one «debug · advance» line in
  `itd.snapshot().events`; `itd.log()` only sees the snapshot transitions
  (`day`, `phase`, `speed` — `step`'s own pause shows up there on a running
  game) plus `game_over`/`victory` on a finale. Outside the `running` phase
  (e.g. `game_over`) the server answers 200 with `advance.ticks` 0 and nothing
  moves. For a real day report, stop a tick short and let the last tick run
  live (`qa:facade` D1).
- **`itd.journal({tail?, sid?})`** (ITGAME-46) — the tail of the party
  journal (see [Party journal and replay](#party-journal-and-replay)) from
  the tab, for an agent without files: `{sid, seed, difficulty, scenario,
  version, total, dropped, overflow, kinds, lines, records, url}`. `tail`
  (1..500, default 20) last records as `lines` — `#seq k what | dN tN $M
  phase Nx revR +tk`, e.g. `#14 cmd buy_pc c2 id1 ok | d1 t39 $8708 running 3x
  rev23 +2` — and as `records` with `save`/`state`/`rng` stripped (`hasSave`,
  `hasState` flags); `kinds`/`total` count the whole journal. A `cmd` carries
  the command `id`, the same as in `itd.trace().sent` and the `itd.cmd()`
  receipt, plus `conn`/`src` (ITGAME-91): `c2` is the party's connection 2, `c3
  bridge` a command of the agent bridge; compare commands by the pair (conn,
  id), not by id. `start`/`resume` print their connection (`#13 resume c2
  offline 8t`), `end` prints why the actor left: `evicted` (another actor took
  the session), `read_timeout` (the read watchdog: the tab was silent longer
  than `ITGAME_READ_TIMEOUT`), `debug_drop` (the watchdog after
  `/api/debug/drop`, `itd.away` `net`) or `disconnect` (the client closed the
  connection). `+tk` — ticks since the previous record. `sid` reads another party (default: the tab's, like the debug
  calls). `url` is the full JSONL for `make replay ARGS="-url <origin> -sid
  <sid>"`. Without `ITGAME_DEBUG` it rejects with `journal_off`.
- **`await itd.staleSave({format?, sid?})`** (ITGAME-154) — the wrapper over
  `POST /api/debug/format` (see [Sessions and saves](#sessions-and-saves)):
  `format` defaults to one above the server's (`{format: 0}` — older), `sid` to
  the live party's (`liveSid`) or a sandbox sid (`a-…`), so it works in a party
  (`live: true`: «В меню» → the card, F5 or `itd.away` → a new party with no
  word, ITGAME-174) and from a sandbox menu (`live: false`: reload the menu to
  see the card). Outside a party and a sandbox the default sid is the owner's
  shared key and the mark cannot be undone (`same_format`): without an explicit
  `{sid}` the client refuses with `owner_sid`. Rejections carry the code in the
  text (`owner_sid`, `bad_sid`, `bad_format`, `same_format`, `no_save`,
  `no_saves`, `busy` — the save changed under the route, retry,
  `session_taken` — the party was taken over); a bare `HTTP 404` is a server
  without `ITGAME_DEBUG=1`.
- **`itd.play(steps)` / `itd.ledger(day?)`** (ITGAME-73) — a party and its
  books from the console. `play` runs steps in order — `{cmd, office?, extra?}`
  (an `itd.cmd` with its receipt) or `{days: n}` (an `itd.advanceDays`) — and
  returns one line per step: `cmd | ok/FAIL code | dN tN | before>after
  balance | staff a>b | pay N | phase`. No timers: a step waits for its own
  receipt (by command id) and then for the snapshot with `rev ≥` the
  receipt's `rev` (for `days`, the advance reply's `rev`); «before» is the
  tab's last snapshot when the step starts. A `FAIL` does not stop the party;
  a missing snapshot after 5 s shows as `(нет rev≥N)` in the verdict. Pause
  first (`{cmd:'set_speed', extra:{speed:0}}`) or live ticks move the money
  between steps. `ledger(day?)` reads `GET /api/debug/ledger?sid=&day=N` —
  the server's book of a day: `balanceStart + income + eventMoney −
  purchasesTotal − payroll − gatewayOpex − antivirus − interest + adjust =
  balanceEnd`, exactly (`balanced`; `antivirus` — the subscription, ITGAME-137). The book is written where `Money` changes
  (`server/internal/game/ledger.go`): tick income, event money (same as
  `DayEventMoney`, ITGAME-53 — `profit` equals the day report's «Прибыль»),
  every purchase through `spend()` (the star hire from an event counts as a
  purchase, `event_choice`), payroll and gateway opex at the evening, credit
  interest (not part of «Прибыль»), and debug edits (`itd.set({money})`,
  a `restore` delta) as `adjust`. The offline engine (`advanceDays`, the
  reconnect catch-up) writes a closed book per day (`offline: true`). No
  `day` — the current day (`balanceEnd` is the live balance, `payroll` is 0
  until the evening); otherwise one of `history`: the current day plus the
  last 7 closed ones. The books live in `Game` and in the save
  (`ledger`/`ledgerHistory`) so a tab reload keeps yesterday; the save stays
  small — 7 days, at most 32 purchase lines a day (the rest folds into a
  «…» line with `n`). A fixture starts a fresh book; a save from before
  ITGAME-73 starts one at its tick (`fromTick`).
- **`itd.trace(action, windowMs)`** (ITGAME-37) is a *live* subscription,
  not a slice of `log()`/`net()`: it wires up listeners before `action` runs
  and keeps them for `windowMs` ms (0..10000, default 1000) after `action`
  finishes, so it never misses an event that happens between two
  `itd.*()` reads. Reports the keys the scene received (DOM or `itd.key()`,
  with the scenes that have a listener, and `acted` — the scenes that
  actually handled it; `[]` means the handler's guard dropped it), the commands sent to the server in send order,
  non-state server replies (`error`, `day_report`, …), phase/speed/day/scene
  transitions, and the toasts/sounds that fired — enough to assert on a
  real player action end-to-end without polling `state()`/`net()` by hand.
  Since ITGAME-45 `sent` entries carry the command `id`, `states` lists the
  window's snapshots as `{t, rev, cause, re?}` (the answer to a command is
  the state whose `re` is its id), and an `error` in `recv` has `info.re`/`rev`.
  Since ITGAME-179 every `sent` entry carries `src`: `'itd'` — the command left
  synchronously inside an `itd.*` call (`cmd`, `click`, `key`, `pause`,
  `resume`, `speed`, `step`; `play` through `cmd`) — a counter in `trace.ts`
  (`inItdCall()`) that the wire tap reads, since `client.send` → `logWire` →
  `tapWire` run in one call stack; `'ui'` — anything else: a real click or key,
  the HUD reacting to a snapshot (also after an `await` inside
  `itd.scenario()`/`advanceDays()`, and a send the handler defers — a tween, a
  `delayedCall` — after `itd.click()`/`itd.key()` returned). The `set_speed` of `itd.pause()` and of the
  ⏸ button are no longer alike.
  Since ITGAME-88 `pointer` lists the real `mousedown`/`mouseup` events of the
  window (what Phaser listens to; a capture listener on `window` runs before
  Phaser's canvas handler): `{t, type: down|up, button, x, y, onCanvas, wins,
  stack, got}` — `x`/`y` in world 1280×720 (the same `ScaleManager.transformX/Y`
  → `camera.getWorldPoint` path as Phaser), `wins` — the hit-test winner at that
  moment as a label in the same form as `got` (safe id, or the type of an object
  without one; `null` — no hit area under the point; the full line is
  `stack[0]`), `stack` — every interactive under the point (the same `stackAt`
  as `itd.stack()`), `got` — the objects
  Phaser actually dispatched `pointerdown`/`up` to (safe id or type; taken from
  the objects' own `GAMEOBJECT_POINTER_DOWN`/`UP`, listeners set in the capture
  handler — the scene-level `GAMEOBJECT_DOWN` is skipped by Phaser 3.90 for an
  object that removed itself in its handler, ITGAME-112). A button that closes
  its own window on `pointerdown` (✕ of «Выйти в меню?», `btn.offline.continue`)
  is in `got` of the `down` entry and, being already removed, not in the `up`
  one (`got` there lists whoever the hit test found at release). So «the
  command didn't go out» splits into: no entry (the click never reached the
  page), `got: []` (it reached the hit test, nothing there), `got` with the
  target (the handler itself decided not to send). `itd.click()` emits on the
  object directly and never shows up in `pointer`.
  Since ITGAME-148 the `up` entry also has `gone`: the objects that got this
  press's `down` and are no longer a Phaser input candidate at release —
  destroyed, `input` removed or disabled, hidden themselves or through a parent
  container, their scene not running (the conditions of
  `InputManager.inputCandidate`). So the empty `up` of a button that leaves on
  `pointerdown` — `menu.diff.*` (the menu hides it under «Начать заново?» or
  switches the scene), «Сохранить и выйти», `btn.next_day`, ✕ — reads «accepted,
  target left», not «never arrived». A target dragged away is not `gone`;
  `down` entries carry `gone: []`; `summary()` prints `gone [...]` when it is
  not empty. The pending `down`s are kept per mouse button (a left down, a
  right down and a left up keep the left press's `gone`); a window opened in the
  middle of a press never saw its `down`, so that `up` has `gone: []`.
  **Open window** (ITGAME-88): `itd.trace` is a function with methods (like
  `itd.sandbox`). `itd.trace.start({maxMs?})` → `{ok, id, t0, maxMs, open}` sets
  the listeners at once; the real click comes from another tool call;
  `itd.trace.stop(id?)` (no id — the last opened) → the same `TraceResult` plus
  `id`, `windowMs` = the window's length, `actionMs` 0. `itd.trace.peek(id?)`
  (ITGAME-160) reads the window without closing it: a copy of the `TraceResult`
  so far — `t1` now, `windowMs` from `t0` (a cut window as it closed); the
  window stays open, its `maxMs` timer runs on, the copy is the caller's
  (`structuredClone`), and unlike `stop()` it does not step the loop, so a scene
  change in the very last step may show only in `stop()`; `no_trace` as
  `stop()`. An item that keeps one window over the human's clicks reads its
  count mid-way without `stop` → `start`, which lost `pointer` (acceptance
  17.10). A forgotten window closes
  itself after `maxMs` (default 120000, 1..600000) with `cut: true` and waits for
  `stop()`; at most 8 windows (`too_many`), `bad_max`, `no_trace`. The fixed
  window of `trace(action, ms)` raced a click delivered by a separate tool call
  (acceptance 10.10). Example:

      const {id} = itd.trace.start()            // tool call 1
      // tool call 2: a real click on btn.pc (screen() x/y)
      const tr = itd.trace.stop(id)              // tool call 3
      tr.pointer[0].wins                         // 'btn:pc'
      tr.pointer[0].got                          // ['btn:pc']
      tr.sent.map(e => e.type)                   // ['buy_pc']
      tr.sent.map(e => e.type + ' ' + e.src)     // ['buy_pc ui']
      itd.trace.summary(tr).lines                // ['t812 ptr down 640,360 canvas wins btn:pc got [btn:pc]', …]

  **Summary** (ITGAME-179): `itd.trace.summary(id?)` reads an open (or cut)
  window without closing it, `itd.trace.summary(tr)` any `TraceResult` →
  `{ok, id?, cut?, error?, lines}`; no window or not a `TraceResult` —
  `{ok: false, code: 'no_trace', lines: []}`. One line per entry of every
  array, sorted by `t` (on a tie: ptr, key, sent, recv, state, trans, toast,
  sound):

      t812 ptr down 640,360 canvas wins btn:pc got [btn:pc]
      t815 sent buy_pc o0 id7 ui
      t841 state rev12 cmd re7
      t842 sound select ok
      t900 sent buy_pc o0 id8 itd
      t930 recv error not_enough_money re8 rev12
      t931 toast "Не хватает денег"
      t950 key ONE itd unhandled
      t990 trans speed 0→1

  `ptr` adds `b2` for a right button and says `page` instead of `canvas` off
  the canvas; `key` — `dom|itd`, `repeat`, `handled [scenes]` or `unhandled`,
  `acted [scene:action]`; `sent` — `o<office>`, the command's own fields as
  `k=v`, `id<id>`, `src`; `recv` — the code, `re<id>`, `rev<N>`, other fields
  `k=v`; `trans` — `from→to`, `-` for null. The format is pinned by qa:trace 16.
- **`itd.cmd()` receipts** (ITGAME-45) are matched by command id, not FIFO:
  `{ok, code?, id, rev}` — `rev` is the answering snapshot's version (for a
  server rejection, the current one). `itd.server()` adds `rev`/`cause` of the
  last snapshot (wait for a version with `itd.wait((s, srv) => srv.rev >= N)`),
  and `itd.net()` adds `rev` plus `info.id` on outgoing commands,
  `rev`/`cause`/`re` on states and `re`/`rev` on errors. `lastEventId` stays
  the page's message counter — not a version.
- **`itd.contract()`** (ITGAME-39) returns the facade's API as data — every
  `window.itd` method/property (name, params, return type), every
  referenced type (`AgentNode`, `CmdReceipt`, `AgentServer`, …), the
  `ServerErrorCode`/`CommandType` enums, and a `version.hash` (12 hex
  chars) — quote this in acceptance reports instead of paraphrasing
  `itd.help()`. Generated by `client/scripts/gen-contract.mjs` from the
  `ItdApi` interface (`client/src/debug/agentApi.ts`) via the TypeScript
  compiler API into the committed `client/src/debug/contract.gen.ts` (since
  ITGAME-88 an object type with a call signature carries `call` —
  `TraceApi.call`, `SandboxApi.call` — and a function-valued property like
  `trace`/`sandbox` keeps its `examples`) —
  `npm run gen:contract` to regenerate, `npm run check:contract` to verify
  without writing. `npm run build` runs the check first: it fails if
  `ItdApi` and `contract.gen.ts` disagree (a `satisfies` type over
  `contract.gen.ts` also catches this at `tsc` time — an added or removed
  facade member is a type error, not just a stale-file warning), and it
  cross-checks `SERVER_ERROR_CODES`/`COMMAND_TYPES`/`STATE_CAUSES` (`client/src/protocol.ts`)
  against the Go source (`../server/internal/**/*.go`), naming any
  mismatched code or command and the file it came from. Every `ItdApi`
  member needs a JSDoc comment (an `@example` tag is recommended) — the
  generator refuses to run without one.

### Cheats (localhost)

ITGAME-194. On `localhost`, `127.0.0.1`, `[::1]` or `*.localhost` the page
installs a global `cheat` in every build, without `?debug=1`:
`await cheat.money()` adds $10 000 to the tab's live party, and
`cheat.money(50000)` adds $50 000. The call resolves to the new balance and
logs it. It goes to `POST /api/cheat/money {sid, amount}` (amount 1..10 000 000).
That route is registered without `ITGAME_DEBUG`, but it accepts only a local
request: a loopback RemoteAddr, a localhost `Host`, no `X-Real-IP` /
`X-Forwarded-For` / `Forwarded` header, and, if the request carries an
`Origin`, a local `Origin` host too (a browser always sends `Origin` on a
cross-site POST, so a foreign page open in the developer's browser cannot post
to localhost, and a browser request from a prod page is refused even if nginx
stopped setting `X-Real-IP`; a plain `curl` has no `Origin` and passes).
Everything else gets `403 not_local`. Prod nginx always sets `X-Real-IP`, so
players there cannot reach it. «Local» means the server machine's own
loopback: an SSH tunnel to the box (`ssh -L 8080:127.0.0.1:8080 …`) would
reach prod parties — accepted, it takes SSH access to the box. The actor applies the cheat as the same money patch `itd.set` uses,
so with `ITGAME_DEBUG` the replay journal records it as a debug patch.

## Tests

    make test         # Go (DB tests need TEST_DATABASE_URL, otherwise SKIP)
    make typecheck    # client type check
    make smoke-ui     # built client in headless Chromium: menu starts, clean console
    make sim ARGS=…   # headless balance runs
    make replay ARGS=party.jsonl   # replay a party journal (see Party journal and replay)
    cd client && npm run visreg   # screenshot and layout regressions

**Browser.** `smoke-ui`, the `qa:*` scripts and `visreg` run a pinned
Chrome for Testing (`npm run build` needs no browser). Install it once:

    cd client && npm run browser:install

The version lives in one place — `CHROME_BUILD` in
`client/scripts/lib/chrome.mjs` (the Chrome revision of the locked
`puppeteer-core`; bump both together, then regenerate the visreg baselines).
It is downloaded with `@puppeteer/browsers` into
`$XDG_CACHE_HOME/it-game/browsers` (`~/.cache/…`, outside the repo, shared
by all worktrees; `CHROME_CACHE_DIR` overrides). `chromePath()` in the same
file picks the browser: `CHROME_PATH` if set (taken as is, no version
check), else the pinned build, else the system `/usr/bin/chromium`,
`/usr/bin/chromium-browser`, `/usr/bin/google-chrome-stable` with a warning
— the run works, but visreg pixels may not match the baselines.

Self-served QA (`selfServe()` in `client/scripts/lib/selfserve.mjs`, used by
`visreg` and the `qa:*` scripts without `QA_BASE`) rebuilds `bin/itdirector`
on every run, so the Go toolchain must be in `PATH`.

**Smoke test.** `npm run smoke-ui -- <url>` checks any URL; `OFFICE=1` also
starts a game and checks the office scene (needs a live server). Boot
enforces the sprite contract, so a broken asset fails the smoke test.
Screenshots: `client/smoke-*.png` (gitignored).

**QA scripts** (`client/scripts/qa-*.mjs`, `visreg.mjs`) drive a built
client with headless Chromium via the `window.itd`/`window.__itd` facade
(see [Debug API](#debug-api-windowitd)):

| Command | Checks | Port (`QA_PORT`/…) |
|---|---|---|
| `npm test` | `node --test` over `client/scripts/lib/*.test.mjs`: the sprite contract core (pixel and `render: smooth` profiles, no `node:*` imports) and `sprite-smooth` (fractional-step area resampling, alpha-weighted colour, centre/bottom placement, chroma key, `chroma: 'auto'` by corners with a noise-derived tolerance, background zeroing), `emoji-check` (what counts as an emoji), `format` (the day report's «Админы» lines — both parts, one, none — and the `seatsLabel` plural, ITGAME-159) and `daylog` (the HUD feed over `src/eventlog.ts`, type-only imports so no Phaser: `parseLogLine` splits the server's «HH:MM», `takeDayLog` puts only the new tail of a growing day log into the feed and starts over on another day or after a shorter log, `newDayLine` gives «Утро, день N» at the day's start hour, ITGAME-163), `minipc-stub` (roles, routes, answer shapes and status machine of the real minipc, refusals leave the state alone, ITGAME-157/182; plus the client lib against it: the wrapped revision catalog, `committed` without a hash not sent), `minipc-client` (credential auto-load from temp files — the itgame-go token never taken, a file token never to `http://`, errors and `describeSource` name files and variables, no values —, the real shapes, `clipUtf8`, ITGAME-182) `selfserve` (`serverEnv`: no coordinator token, no inherited `DATABASE_URL`, ITGAME-182) and `sprite-job-core` (the class from the graphics.md table checked against the manifest, a mixed class needs `render`; the profile's parts for `pixel`/`smooth`, its sha256, over 4000 characters refused; every spec violation at once — a brief in bytes, fixture, scene, ids, extra fields; the job body and its print form; `createJob` against the stub: accepted, keys `open`, 422 with the field, 403 for the itgame-go token, ITGAME-182) — no browser, no game server | — |
| `npm run check:emoji` | no emoji in `client/src` — strings, comments, the manifest (ITGAME-83): a `\p{Extended_Pictographic}` character or U+FE0F, except the glyphs our own fonts carry (`FONT_PICTOGRAPHS` in `client/scripts/lib/emoji-check.mjs`, the cmap of both woff2 by `fc-query`); an icon is a sprite next to a Text (`attachIcon`), a text symbol is a glyph of our fonts; last step of `npm run build` | — |
| `npm run qa:meta` | stats/achievements modals; ITGAME-83 icons: the menu buttons (16) and modal titles (24) — `icon_trophy`, `icon_chart`, `icon_warning` on «Начать заново?» / «Партия в другой вкладке»; each achievement card's own `ach_*` (16) left of its title, dimmed while locked (alpha 0.6 and a grayscale `ColorMatrix` in `preFX`), `icon_lock` (12) left of every «Заблокировано», no emoji in the modal | :4173, `vite preview` — needs a Go server already on :8080 |
| `npm run qa:buttons` | buy-button enabled/tooltip/alpha states (ITGAME-17); R1–R7 the room action column (ITGAME-94): `btn.pc`/`hire`/`boss` in the `office` scene at x 1142, 128×44, y 384/438/492, no overlap with any office object; the `room.tooltip` sits left of the column; a real mouse click at the `screen()` point buys a PC; under the router window `hit()` fails, `X`, no tooltip; in a locked office the column is hidden and `itd.click` answers `code: 'hidden'`; `btn.gateway` in `serverRoom` at x 1142 y 452; AV1–AV8 the antivirus (ITGAME-137): `btn.antivirus` in `serverRoom` at x 1142 y 506 128×44, a real click opens «Антивирус» with three tiers and «Отключить» disabled (`D`, a click sends nothing), a real click on SOHO Edition sends `set_antivirus` slot 1 (button «Антивирус / SOHO Edition», first seats covered, billed $12), at $10 the current tier and the upgrades are `D` and «Отключить» sends slot 0 with the day still billed $12, a shield per covered seat in the office, the day report line «Антивирус: -$12» | :4180, self-serve |
| `npm run qa:tabs` | multi-tab session takeover (ITGAME-35); T0 the `Storage.prototype` probe; T1–T2 storage fully blocked (ITGAME-80): «Сохранить и выйти» → «Продолжить» resumes the same sid from tab memory, after a reload no «Продолжить» and a new sid | :4179, self-serve + temp saves dir |
| `npm run qa:hud` | HUD layout column (left block right ≤ 832 since ITGAME-94, right column left ≥ 848), toast stack, no overlaps (ITGAME-16); goal/day bars G1–G3/D1–D3, tab locks L1–L3, event log E1–E3, onboarding coach O1–O6 (ITGAME-21); `virus_outbreak` V1 «☣ 2»/«☣ 1» under the office tabs, none under О3, V2 a live wave (`virusWaveIn` 1 by `itd.restore`, speed 3) grows the badges to the company total with no wave toast, V3 the day report line «Вирус:     +k ПК за день (−$X)» (ITGAME-138, ITGAME-146), V4 the `hud.log` strip after that report: one time per line, «к вечеру заражено m ПК» with the server's own time, the day summary last (ITGAME-150), no line twice; V5 the strip live (ITGAME-163): «HH:MM вирус в офисе 1: 2 ПК» from `state.dayLog` before any report, «чистим вручную» right after `event_choice`; V6 after `next_day` «10:00 Утро, день N+1» right below the day summary | :4174, self-serve |
| `npm run qa:doom` | the doomed-party plate (ITGAME-118) and the overdraft (ITGAME-156): D1 Hard + `doomed_debt` — `bankruptInDays` > 0, `hud.doom` «До банкротства N …» with «Сдаться» and ✕, `hud.debt` «Долг -$2,000 из -$5,000 · 10%/день», `itd.state().debtLimit` = `creditLimit` = 5000; D2 a real click on ✕ hides it for the rest of the day; D3 next morning it is back with N − 1; D4 a real click on «Сдаться» → «Удалить партию навсегда?» paused, «Отмена» back with the speed; D5 no overlaps/offscreen; D6 `fresh` — no plate; D7 Normal + `doomed_debt` — `creditLimit` 0, `debtLimit` 750 = `payrollPerDay` in the snapshot and in `itd.state()` (ITGAME-177), N = 1, «Овердрафт -$2,000 (мин. лимит -$750)» in the «Расходы» row right of `hud.payroll`, right edge ≤ 832; D8 at −$100 N ≥ 2 and the line follows; D9 a live evening from $400 at tick 53 — `day_report`, «19:00 овердрафт: долг $X из $750 (расходы дня), без процентов» in `hud.log` and the report, `interest` 0, the book balanced | :4188, self-serve, saves off |
| `npm run qa:facade` | `window.itd` `active`/`log()`/`overlaps()` kind (ITGAME-38); HUD `+X/день` = the day's profit on `mid_day10` (ITGAME-49); `itd.step({ticks})` advances > 10 ticks per call (ITGAME-56); UI-scale ids/cycle and a stored 2× → «по окну»; canvas-vs-window `offscreen()` entry (ITGAME-61); a throwing `localStorage` for `itd.uiScale` neither breaks the load nor the zoom choice (ITGAME-67); ⏸ on pause is an amber block, speed(1) restores it (ITGAME-62); `itd.screen()` on the day report — title, blocker, `X`/`free`/`frame`, `D` on a buy button without money (ITGAME-72), S2c a `frame` that is not a number ≥ 100 → `bad_frame`, a map carries `ok: true` (ITGAME-148), the office's `btn:pc` under the report dim is `X` and `hit()` fails (S2b, ITGAME-94); build stamp and «устарело, обнови» on a faked stand `index.html`, `itd.stale()` (ITGAME-78); `itd.sandbox()`: the owner's shared key survives «Сдаться» and a second party, `fakeOwner()`, `restore()` puts back / keeps (ITGAME-77); `itd.stack()` under the day report: the dimmer wins over `btn.menu`, same as `hit().top` (ITGAME-74); `hit()` and the `X` flag follow the real hit area — a 1×1 hitArea on `btn.next_day` makes it covered (owner 10.10); S4 the exit window's ✕ over the event card stays out of `btn:event:1`'s `screen()` label, H3 a rectangle added in this frame: `stack()` and a same-instant canvas mousedown both miss it, after one `requestAnimationFrame` both get it (the trace's `wins` read as a label since ITGAME-179) (ITGAME-113); `itd.play()` on `fresh` (seed 7): hire → hire `FAIL no_free_pc` → day → buy_pc → hire `FAIL not_enough_money` → day with the balances 600>300>599>24>323 (exact income, ITGAME-196), `itd.ledger()` books balanced, `adjust` after `itd.set` (ITGAME-73); K1 the office tooltip's text in its hidden container is `visible: false`, K2 «ТУПИК» and the day report give 0 overlaps entries from the dim (22 with the `dim` mark removed) (ITGAME-87); K3 `nodes().fill`, K4 `menuReady` false right after `sandbox.restore()` and the plate still for 1.5 s after it, `stale().shown` false/true/false (ITGAME-88); L1–L3 and L6 storage fully blocked — both getters and `Storage.prototype` throw `SecurityError` (ITGAME-80): the menu loads without «Продолжить», a party starts, the `hire` receipt is ok, «Первые кадры» toasts once, the report pause keeps 3× in tab memory; without `?debug=1` (no `window.itd`) no pageerror and the `2` key starts a party (the «Продолжить» round trip needs saves on disk — it is in `qa:tabs` T1–T2) | :4175, self-serve |
| `npm run qa:slots` | office/server-room slot rendering — lunch, boss, gateway, router, amenities, racks; `broken_pc`: one zone `office.slot.0` covers the worker and the «✖ чинить k/N» label, real clicks repair 0/3 → 1/3 → 2/3 → repaired (the idle label «✖ чинить · 1 очко», `actionPoints` −1 on the first click only, ITGAME-127), then the same zone motivates; right click and tooltip shared (ITGAME-75/92/93); `virus_outbreak` (ITGAME-138): a real click on «Чистить вручную» closes the card, «☣ вирус · 1 очко» on seats 1 and 6 only, the plate «☣ вирус: 2 из 9 мест · волна в 12:00», tab badges «☣ 2»/«☣ 1», the zone covers the worker and the label, exactly two lime-blinking zones and no red one, `itd.stack` wins `office.slot.0` at the label and the worker, no overlaps, the tooltip «ЗАРАЖЁН … 0/3», «вирус -30%», «мотивация: после чистки», right click opens the fire dialog and sends nothing, real clicks send `virus_click` 1/3 → 2/3 → clean (zone back to 64×64, plate «1 из 9», badge «☣ 1»), then the zone motivates; a broken infected seat (by `itd.restore`) shows «✖ чинить · 1 очко» in a red zone, the tooltip «после ремонта вирус останется», clicks send `repair_click`, and after the repair «☣ вирус · 1 очко» is back; the tooltip hides when the router/fire window opens and stays hidden after a snapshot and `itd.hover` (ITGAME-89); 3в with `?debug=1` frames: under the router window, the HUD exit dialog and the day report no frame of a covered object lies above the dim, every frame sits at its object's depth + 0.5, the window's own buttons are framed above it, also after a snapshot (ITGAME-84); EV1–EV4 the event card: `btn.event.0`/`btn.event.1` framed once each at 41.5 with the frames in `eventUI`, still once after a snapshot rebuilds the card, under the exit dialog's dim 70 together with the header, none left after the event is cleared; OF1–OF4 «Пока вас не было»: the final `btn.offline.menu`, then the ordinary report over it — `btn.offline.continue` framed once at 56.5 and the dim at 55.5 (frames in `offlineUI`, the final window's frames gone), header frames under 55 also after a snapshot, «Продолжить →» leaves no `btn.offline.*` frame or id (ITGAME-97); shelf (`spare_pcs`, no amenities): without a cooler `office.amenity.fridge`/`coffee_machine` are disabled, no hand cursor, «нужен кулер», hover shows «Сначала купите кулер» and real clicks send nothing; a real click on the cooler sends `buy_cooler`, then both cells open and real clicks send `buy_fridge`, `buy_coffee` with no server error (ITGAME-102) | :4177, self-serve |
| `npm run qa:sprite-try` | `itd.sprite.try/reset/list` (ITGAME-119): a clean swap re-points live objects and reports `sha256`; an off-palette PNG is applied and named in `problems`; a sleeping scene's key; fallback keys stay independent; `unknown_key`/`bad_src`/`bad_size`/`not_tried`; no `crypto.subtle` → `sha256: null`; `reset()` restores the original pixels after two tries; `assets()`/`assetSet()` mark the key `tried`; `{filter: 'linear'}` sets LINEAR on the GL texture, the default stays NEAREST, `bad_filter`, `reset()` brings back NEAREST; the menu `icon_trophy` (ITGAME-83) keeps 16×16 under a 64px try, loads LINEAR as a `render: smooth` key, `try` defaults to linear for it and `assets()` reports it `smooth` with no off-palette colours | :4187, self-serve |
| `npm run qa:sprite-pull` | `itd.sprite.pull/watch/unwatch` (ITGAME-157) against the minipc stub through `/api/debug/sprite/*`: P1 `pull(cooler, 1)` puts the revision — the texture's RGBA equals the PNG's, the receipt clean with `source: 'pull'`, `taskId`, `rev`, minipc's `sha256`; P2 `list()` carries them, `assets()` says `tried`; P3 an off-palette revision is applied and named; P4 `bad_size`; P5 `unknown_key`, `not_found`, `bad_rev`, `bad_task`; P6 `reset()` brings the original pixels back; W1 `watch` — the manifest's keys, `not_in_manifest` in `skipped`, a first receipt per key; W2 a new revision arrives by polling in ≤ 4 s; W3 `unwatch` returns it in `updates` and the next revision does not arrive; W4 `not_watching`; no pageerror | :4194, self-serve + the stub |
| `npm run qa:sprite-pipeline` | `qa:sprite` and `sprite:take` against the stub (ITGAME-157), key `cooler`, `take` into a temporary git copy of the manifest and sprites; J1 `sprite:job` on the first key of the real ITGAME-134 spec in a temporary copy → a stub job with that key `open`, `ctx`, the desk class, the profile's «Задание» part, the crop's size in the record next to the spec, the sources printed; J2 a second run on that spec refused naming the `taskId`, no second job (ITGAME-182); R0 without `ITGAME_MINIPC_TOKEN`, or with the coordinator's token in its place → refused before the server, nothing posted (ITGAME-182); R1 an off-palette revision → `returned` with «вне палитры» and a crop; R2 a clean one → `accepted`, the report carries its sha256; T1 a forged report sha → refused, PNG untouched; T2 a revision added after `accepted` → taking the old one refused (`draft`; the final pointer stays, as in minipc), untouched; T2b `check:sprites` fails (a dangling `fallback`) → the PNG, the manifest and the provenance rolled back; T3 the third revision accepted and taken — the PNG, the provenance (origin, profile), the note keeps its reason with the minipc tail; T4 `--committed` before the commit refused; T4b a fourth revision after the commit → `--committed 3` refused, the status untouched; T4c the fourth taken, the note has one minipc tail; T5 `--committed 4` → `committed` with the `HEAD` hash | qa:sprite on :4196, self-serve + the stub |
| `npm run qa:trace` | `itd.trace()` live window (ITGAME-37); receipts by command id — `id`/`rev` in `cmd()`, `trace().sent`/`states`, `net()`, and no false receipt with a tick or an observer's (`/ws/agent`) snapshot in flight (ITGAME-45); `itd.trace.start()` → a real `page.mouse.click` on `btn.pc` → `stop(id)`: `pointer` down/up with world x/y = cx/cy, `wins` `'btn:pc'`, `got` [btn:pc], `sent` buy_pc; a click on `#build` — `onCanvas` false; `no_trace`, `cut` by `maxMs`, `bad_max`, two windows, `itd.click()` leaves `pointer` empty (ITGAME-88); `got` of a button that removes itself on `pointerdown` — a real click on the ✕ of «Выйти в меню?» gives `modal:close` on down and nothing on up, same for a self-removing probe rectangle (ITGAME-112); `gone` on the up (ITGAME-148): ✕ `[modal:close]`, a self-removing probe `[probe:gone]`, a self-hiding one `[probe:hide]`, the keeping probe and `btn:menu` `[]`, down entries `[]`, `summary()` prints `gone [...]`; 15b `itd.trace.peek()` (ITGAME-160): `no_trace` without a window, the copy grows between two clicks and a mutation of it does not leak, the window stays in `start().open`, `stop(id)` returns the same id, `peek` after `stop` → `no_trace`, `peek` on a `maxMs`-cut window → `cut: true` with the final `windowMs`; `src` — `itd` from `pause()`/`key()`/`click()` (4, 10b, 10c, 15), `ui` from a DOM Enter and a real click (10, 14); 16 `itd.trace.summary(id)` on an open window equals `summary(tr)` after `stop`, sorted by `t`, one line of each kind pinned by its pattern, `no_trace` with `lines: []` without a window or for a non-`TraceResult` (ITGAME-179) | :4176, self-serve |
| `npm run qa:contract` | `itd.contract()` shape/hash (ITGAME-39); A11 the 10.10-b fields: `TraceApi.call` + `start`/`stop`, `pointer`, `fill`, `shown`, `seq`/`awayId`, journal `conn`/`src`, `end` spelled out (ITGAME-87/88/91); A12–A15 debug calls outside a party (ITGAME-131): from the menu `set`/`step`/`advanceDays`/`ledger`/`scenario`/`snapshot`/`restore` reject `not_in_party` with no `/api/debug/*` request (`play` `{days}` → `FAIL not_in_party`), `itd.journal()` is not gated, after `menu.diff.normal` `snapshot()`/`scenario()` go through under `liveSid`, after «Сохранить и выйти» they refuse again and the left party's journal still reads; A16 the 20.10 trace contract (ITGAME-179/148/160): `TracePointer.wins` `string | null`, `sent` as `TraceSent[]` with `src` documented, `TraceApi.summary` → `TraceSummary.lines`, `TracePointer.gone`, `screen` → the `bad_frame` union, `ScreenMap.ok`, `TraceApi.peek` | :4178, self-serve |
| `npm run qa:party` | two parties in one tab: fresh party after leaving in a locked office / fast exit opens office 0, nav works, buy not `office_locked`; «Continue» keeps sid/day/money (ITGAME-47); expired save on «Continue» and `itd.scenario()` from Office 2 land in office 0, and the «Сейв несовместим…» window does not appear for the missing save (E5, ITGAME-54/55/174); overlays/report pause after `itd.scenario()` incl. from the finale, `itd.restore()` locking the active office (ITGAME-64/63); explicit exit freezes the party: the exit dialog pauses, Отмена/Esc/✕ restore the speed, «Сохранить и выйти» → «Продолжить» keeps tick/day/money and the speed, also from an open day report (ITGAME-65); on the victory screen (storage sid cleared) `itd.server().sid`/`liveSid` stay the live party's sid (ITGAME-68); office/server-room windows (router, fire dialog via a real right click on `broken_pc`, core, rack) close on `itd.scenario()`/`itd.restore()`, a click where «Уволить» was sends nothing (ITGAME-69); A1–A7 `itd.away` (ITGAME-76): `close` — while away the socket is `reconnecting`, commands `not_connected`, the server session is gone at once, the return resumes the same sid with `droppedAt` ≈ `leftAt`; `net` with `timeout: 1500` — the server session lives (200) until its read timeout and is gone (404) after, `droppedAt − drop.at` ≈ 1.5 s, `liveTicks` ≈ 3 at 2x, catch-up from `droppedAt`; `net` shorter than the timeout — no catch-up, ticks ran live; the owner key untouched; inside `itd.sandbox` the return lands in the sandbox party; N1–N6 with the socket dropped (`itd.away` net) and real mouse clicks: «Купить ПК» twice — one «Нет связи» toast, `error` sound each, no `buy_pc` (ITGAME-90); «Сохранить и выйти» → «Нет связи — сохранение не дойдёт», no `exit`, Esc back; «Подождать» → «Ждём связь…» → after the return `exit {speed:2}` and the menu, «Продолжить» 3 s later on the same day/clock; «Подождать» → ✕ sends nothing; «Выйти без сохранения» → menu, the party ran on; open socket unchanged (ITGAME-85); D1–D3 «Сдаться» → «Удалить партию навсегда?»: Enter/«Отмена» keep the sid and the save, «Удалить» sends `abandon`, 404 (ITGAME-86); A8 the catch-up key: `awayId` 1, 2, 3, `offline.awayId === awayId`, `seq` grows, after an away without a catch-up `itd.offline()` is the previous one (its `awayId`, same `seq`) (ITGAME-87) | :4181, self-serve + temp saves dir |
| `npm run qa:report-pause` | the day report pauses the party (speed 0, time and balance stand still); Enter/Space/`btn.next_day`/`itd.cmd('next_day')` restore the pre-report speed; F5 with the report open keeps `itd.speedBeforeReport`, «Продолжить» reopens it paused and closing restores 3×; an outside `itd.speed(0)` over the report survives; `itd.set({tickInDay})` refused in `day_report`; `skipReports` changes the day without a modal or a stuck 0 (ITGAME-18, self-serve since ITGAME-70); R1–R2 a long journal (ITGAME-141, `eventLog` by `itd.restore`, viewport 1920×1080): lines wider than the panel wrap with a hanging indent `  ` under «·» and glue back to the server's lines, 30 two-line events give «· … раньше: ещё k» on top with the evening line kept, the text stays ≥ 16 px inside the panel frame, the panel inside 16..704, `itd.overlaps()`/`offscreen()` empty; Z0 with no staff the report reads «Зарплата:  $0», no minus (ITGAME-147); R3–R4 the `hud.log` strip after the report (ITGAME-150): a server journal line goes in with its own «HH:MM» and no arrival clock before it, the day summary last; the report the server re-sends after an early reconnect in `day_report` (`itd.away` `net` 1 s, timeout 5 s) arrives a second time and puts no line into the strip (counted on `logLine` calls — the strip keeps 5 lines, so a 5-line report repeated gives the same tail) | :4182, self-serve + temp saves dir |
| `npm run qa:journal` | the journal of a live browser party (HUD clicks, `itd.cmd`, a rejection, `itd.set`/`itd.step`, F5 → «Продолжить» with offline catch-up) from `/api/debug/journal` replays with `cmd/replay -json` without divergence or warnings, and the replayed save equals the live one; `itd.journal({tail, sid})` gives the same journal from the tab — tail lines, kinds/total, ids, saves stripped (ITGAME-46); a `/ws/agent` command with its own id 1 after the F5: `conn`/`src` on every command, `start c1`, `resume c2`, the bridge on its own conn, ids repeat but (conn, id) pairs don't, replay `conns`; lines `end disconnect`, `c3 bridge id1` (ITGAME-91); J3b/J6b `itd.restore` infects seat 1 of two with the wave in 2 ticks, a live wave infects seat 2, six `virus_click` clean both and a seventh is `not_infected` — all in the journal and the replay (ITGAME-138) | :4186, self-serve + temp saves dir |
| `npm run qa:admins` | the admin department (ITGAME-145), real mouse clicks at `itd.screen()` points: D1 the «АДМ» tab with its lock and $3,000, the closed room «Отдел админов закрыт» with `dept.buy` and no hire column; D2 `dept.buy` at $600 — sent, refused, still closed; D3 bought — `buy_admin_dept`, −$3,000, three seats, the tab «0/3» without a lock; D4 `btn.admin.0` enabled «Админ О1 / $600», О2/О3 disabled with «Офис 2 не куплен»; D5 a click on a disabled button sends nothing; D6 `hire_admin 0`, «Админ О1 ✓», the admin seated, «свободен», «1/3»; D7 `admin_dept` with live ticks — the target line goes «чистит место 2» → «чистит место 7» → «чинит место 4» → «свободен»; D8 the admin's tooltip, D8b it survives a snapshot under the cursor and does not stick once the cursor left in one move (no `pointerout` reaches the re-created sprite — the bounds check `OfficeScene` has since ITGAME-89); D9 a right click — «Уволить админа?» with «Компенсация: $300», the confirm sends `fire_admin 0`, the seat is empty; D10 the office seat tooltip «чистит админ» on the admin's target and not on a clean seat; D11 `not_infected` in an office with an admin raises no toast, `not_broken` in an office without one does; D12 the day report's admin lines (ITGAME-159), once the admin is free so both parts are there: «Админы:    починили k ПК,» and «           вычистили m мест» under the value column, k and m the day's counts from the save, a Russian plural, each line ≤ 392 px by the report Text's own `measureText`, the body inside the panel with ≥ 16 px margins, no `hud` overlaps/offscreen; D13 three admins with long names — overlaps/offscreen empty at both zooms; no pageerror | :4192, self-serve |
| `npm run qa:pc` | workplaces (ITGAME-135) on `worn_pcs`, paused, real mouse clicks at `itd.screen()` points: W1 level labels `office.pc.i` «ЖК»/«2×ЖК»/«ЭЛТ», none on the dead desk, `deadPCs` 1; W2 the dead seat — «✖ замена», «заменить $500», a grey-tinted `desk_pc_broken`, one grey flashing zone; W3 the worn label orange; W4 the tooltip «ПК: ЭЛТ ×1.0 · износ k/N — следующая поломка: замена», kept over the label; W5–W6 the label opens «Рабочее место 4 — офис 1», «Апгрейд до ЖК $350» sends `upgrade_pc`, the label and income follow; W7 a free desk upgrades, no replace button at wear 0; W8 a disabled upgrade sends nothing; W9 a right click on the label fires; W10 `pc_fresh`, `pc_max_level`, `pc_dead` refusals; W11 a left click on the dead seat opens the window, no repair or motivate; W12 «заменить $500» sends `replace_pc`, the desk is back to ЭЛТ and earns; W13 a dead seat at lunch has no «обед», no overlaps; W14 overlaps/offscreen empty at both zooms; no pageerror | :4193, self-serve |
| `npm run qa:claim` | `itd.claim` (ITGAME-151) in the menu, real mouse clicks: 1 the bar — fixed, `pointer-events: none`, 40 px, label and sha, busy title, canvas rect unchanged; 2 a click on empty canvas without `mine` → `foreign` 1, one press per click, red flash then back; 3 `mine()` → the click is `own`; 4 an expired `mine(1, 200)` → `foreign`; 5 `dispatchEvent` → `synthetic` only; 6a `allow(…, {target: 'menu.diff.normal'})` and a click on it → `deny().hit` true, `got` has the target; 6b `elementFromPoint` at `#build` is `#build` (the click passes through the bar), a click on it → `hit` false, `onCanvas` false, `no_allow` without a window; 7 `bad_label`/`bad_args`; 7b `claim('other')` relabels and keeps every count; 8a F5 keeps the bar and the count, `reloads` 1; 8b `itd.reset()` + F5 keeps it, `reloads` 2; 9 `stop()` → bar gone, «вкладка свободна», key gone, second `stop()`, `mine()`, `allow('x')`, `deny()` → `no_claim`; no pageerror | :4198, self-serve |
| `npm run qa:version` | the build version and save compatibility (ITGAME-140, ITGAME-169): V1 `/api/version` → `version` год.мес.день.час.мин = `itd.version.version` = the menu's «версия X» (`menu.version`, inside the field); V2 a party → «Сохранить и выйти»: the save file carries the server's version and `game.format`, the menu shows «ПРОДОЛЖИТЬ»; V3 the server restarted on the same saves dir with the file's version set to 2000.01.01.00.00 (a deploy of a new build of the same format): «ПРОДОЛЖИТЬ» with $4,321 and no `menu.stale`, «Продолжить» resumes the party with $4321 and its save carries the server's version again; V4 a save without `version` (before ITGAME-140) — «ПРОДОЛЖИТЬ» too; V5/V6 `game.format` one below / one above the server's, set by the route without a restart (V5 `itd.staleSave` from the menu, V6 a raw `POST /api/debug/format`): `{sid, was, format, live: false}`, only `game.format` changed and `savedAt` kept (ITGAME-154); then no `menu.continue`, the card `menu.stale` «СЕЙВ НЕСОВМЕСТИМ», «начните новую партию:», overlaps/offscreen empty; the card's line is the owner's sentence (two lines joined by a space), no menu text but `menu.version` matches a build version, «от версии», «от старой версии», «, игра » or «формат», the title and the line inside `menu.stale` (≥ 16 px left and right, ≥ 8 px top and bottom), the title above the line, «начните новую партию:» below the card, the corner still «версия X» (ITGAME-149); V7 a real mouse click on «НОРМА» from the card: no «Начать заново?», a new sid, day 1, its save carries the server's version and format, the old file untouched; V8 a live party marked (`live: true`, the file at once FORMAT+1 with the server's version) — `itd.away(1)` answers `not_resumed`, a new party day 1 under the same sid, the file back to the server's format, no menu card; in the game the window (ITGAME-174, owner 21.10) — button `modal.incompatible.ok`, the exact sentence «Сейв несовместим с новой версией — начата новая партия» (title + line joined by a space), inside the frame, overlaps/offscreen empty; a real mouse click on «ОК» closes it, the party is the new one (day 1, same sid), the speed untouched; V9 a live mark then «Сохранить и выйти» → the card; V10 no pageerror | :4189, self-serve on its own saves dir (restarted for V3/V4 only — the build version is set by a file edit; the format by the route) |
| `npm run smoke-ui` | menu boots, clean console; `OFFICE=1` + live WS → office scene | :4173, `vite preview` |
| `npm run visreg` | screenshot diff + layout linter per fixture scenario | :4173, self-serve, `VISREG_PORT` overrides |

`qa:buttons`/`qa:hud`/`qa:facade`/`qa:slots`/`qa:sprite-try`/`qa:sprite-pull`/`qa:sprite`/`qa:trace`/`qa:contract`/`qa:tabs`/
`qa:party`/`qa:report-pause`/`qa:journal`/`qa:version`/`qa:pc`/`qa:admins`/`qa:claim`/`visreg` share `client/scripts/lib/selfserve.mjs`: it rebuilds `bin/itdirector` on every
run (`go build` into a temp file, then an atomic rename — a no-op relink takes
under 1 s, so QA never runs against a binary older than `server/`) and runs it
over `client/dist`, refuses WHATWG bad ports (e.g. 4190, 6000 — fetch and
Chromium won't connect) before spawning, refuses to start when its port is already taken by
another process, and verifies after boot that the server actually answers
with the local `client/dist` build (not someone else's) — a busy port fails
loudly instead of running the suite against the wrong server. It also sets
`ITGAME_DEBUG=1` on the spawned `bin/itdirector` (see [Agent bridge](
#agent-bridge-wsagent)), since `itd.set()`/`itd.step()`/`itd.advanceDays()`/… — used by
`qa:buttons`, `qa:hud`, `qa:trace`, `qa:facade`, `qa:slots`, `qa:sprite-try`, `qa:party`, `qa:report-pause`, `qa:contract` — need `/api/debug/*`
registered (and the party journal recorded, `qa:journal`). `qa:tabs`/`qa:party`/`qa:report-pause`/`qa:journal` additionally self-serves with a temporary saves
directory, since their session-takeover/«Continue»/F5 scenarios need a real saves store
(`-saves off` won't do).
`qa:meta`/`smoke-ui` instead self-serve a plain `vite preview` over `dist`
on :4173, which proxies `/ws`/`/admin`/`/api` to `localhost:8080`
(`vite.config.ts`) — so `qa:meta` needs a Go server already running there
for its gameplay checks to pass; `QA_BASE`/`BASE_URL` points any script at
an already-running server instead.

**Live protocol checks** — a real WebSocket client against a running server:

    cd server && go run ./cmd/server -addr :8091 &
    node scripts/live-check-saves.mjs            # saves, reconnect, rev/cause across resume
    OFFLINE=1 node scripts/live-check-saves.mjs  # + offline catch-up (~70 s)
    node scripts/live-check-activeday.mjs        # active day
    node scripts/live-check-events.mjs           # random events (SEED=3 by default)
    node scripts/live-check-employees2.mjs       # employees
    node scripts/live-check-difficulty2.mjs      # difficulty rules (SEED=3 by default)

Each exits 0 with a final "… ОК". `live-check-events` and
`live-check-difficulty2` pin a seed (`SEED=…` overrides), so runs are
reproducible; they and `live-check-saves` take `PORT=…` for a server not on :8091.
`live-check-events` passes on *any* event on days 2–4 — the seed only makes
the run reproducible (seed 3 gives «Дедлайн от бизнеса» on day 2, ~36 s). The
event name is a soft expectation: `EXPECT=<substring>` (default `Дедлайн`)
prints a `note — ждали …` line when the title differs, without failing;
`EXPECT=` disables it. To re-pick a seed, run
`make sim ARGS="--diff normal --seed 1..50 --days 4 --policy greedy --events-text"`
and confirm live.

**sim** (`server/cmd/sim`) plays games with the real engine, e.g.
`make sim ARGS="--diff hardcore --seed 1..50 --days 30 --policy all --out runs.csv"`.
Policies: `greedy`, `idle`, `random` (`--policy all`), plus `handsoff` and
`delegate` for the price of admins (see «Admins»), and `expand` (greedy that
also buys the next office once every unlocked office is full; not part of
`--policy all`). CSV:
`policy,seed,day,money,income,payroll,events,outcome`, one row per day;
the last row holds the outcome (`bankrupt | deadlock | victory | time_up |
timeout`). `--events-text` writes the event names joined by `" | "` into
the `events` column instead of their count, `--audit-share <f>` overrides
the audit fine share (`AuditFineShare`; `-1` keeps the config value) and
`--audit-stats` prints one extra stderr line with the bankruptcies on a
failed-audit day versus all bankruptcies and failed audits.
`--event-stats` (ITGAME-196) prints one `sim events: …` stderr line per
policy run, after the summary: averages per played day (a day with a
`DayReport`; the unfinished victory day is not counted) of `breakdowns`
(PC breakdowns), `outbreaks` (virus activations that infected a PC),
`infected` (new PC infections during the day, outbreaks plus waves), `pool` and its kinds `virus`,
`deadline`, `audit`, `raise`, `star` (the day plan right after `NextDay`),
`total` (breakdowns + pool), plus `second` (share of days with two pool
events), `max` (largest daily total), `ge3` (share of days with total
≥ 3) and `capped` (share of days whose total reached the run's daily
random-event budget `EventBudget`; always 0% with no budget).
`--answer-raise accept|decline` makes the sim answer every «Просит
повышения» card the tick it appears (default: it does not answer). None of
this touches the CSV or the save. Reference (300 seeds × 30 days, greedy,
re-measured 21.10 after ITGAME-196/203: breakdown 1.5%/tick, daily event
budget, random 1–3% raise, exact income): easy 300/300 wins (median
$60,175), normal 300 `timeout` (median $156,872), hard 300 `timeout`
(median $28,657), hardcore 6/300 bankrupt (the other 294 `time_up`, $640).
Events per played day, `total`: 1.16 / 1.47 / 1.61 / 1.85 (easy / normal /
hard / hardcore), breakdowns 0.60 / 0.72 / 0.71 / 0.75, virus in the plan
0.129 / 0.230 / 0.323 / 0.471 (once per 7.8 / 4.3 / 3.1 / 2.1 days).
Before (ITGAME-135 workplaces, 20.10, no budget, breakdown 2%): normal
3/300 bankrupt (median $156,385; $135,061 before that), easy $60,164, hard
$29,190 ($35,994 before — the cost of the replacement expense on a thin
margin, accepted), hardcore 12/300 bankrupt ($678). The ITGAME-196 before →
after 50-seed table (events per day, `max`, `ge3`, medians, «always accept
the raise») is in the GDD, «Активный день». The random counts below stay
as history; normal random with workplaces: bankrupt 90, deadlock 210,
unchanged.
ITGAME-156 (overdraft on Easy/Normal, 18.10, `--policy all`): normal random
bankrupt 90 → 90 and deadlock 210 → 210 — the counts stay, but every one of
the 90 bankruptcies moves exactly one day later (day 2–5 → day 3–6: the
random policy earns $0 once broke, so one evening of overdraft never becomes
a recovery); easy random bankrupt 196 → 196, deadlock 72 → 72, timeout 32 →
32; greedy and idle unchanged (greedy/idle never end an evening below zero).
`handsoff` / `delegate` (ITGAME-173, re-measured 19.10): normal handsoff
bankrupt 19 → 0, median $37,680 → $38,218 — its 19 parties dip into
overdraft for one evening and climb out; normal delegate, hard and easy
byte-identical.

**visreg** loads each fixture scenario (`?scenario=X&seed=1&debug=1`) — so the `?debug=1` red frames are part of the shots — and the
menu, screenshots the canvas and diffs it against
`client/scripts/visreg/shots/` (>0.5% differing pixels fails), and runs the
layout linter (`itd.overlaps()` — see [Debug API](#debug-api-windowitd) —
plus offscreen/contrast/tiny), which must not be worse than
`baseline.json`. Update baselines after intended UI changes: `npm run
visreg -- --update`, then commit.

Baselines depend on the browser build and the rasterizer, no longer on the
system font: the game draws all text with its own fonts (ITGAME-48) —
Departure Mono 1.500 plus ITD Symbols, an 8-glyph OFL subset of Unifont for
⌂⏸▶☣✓✕✖✗ (files and licenses in `client/public/assets/fonts`, the stack is
`FONT` in `client/src/render.ts`, `BootScene` waits for both before the
menu). No emoji are drawn since ITGAME-83: icons are sprites next to a Text
(`client/src/ui/iconText.ts`), `npm run check:emoji` keeps `client/src` free of
them. The committed baseline (11 scenarios, `broken_pc`, since ITGAME-138
`virus_outbreak` and since ITGAME-145 `admin_dept` included — the last one is a
shot of the department room: `ROOM` in `visreg.mjs` clicks its tab after
the load) was regenerated **2026-10-17** for ITGAME-145: the fifth nav tab
«АДМ» changes every party shot, and its 8px grey price/«k/3» line adds one
`tiny` and on some scenarios one `contrast` — the same as the closed «О2»/«О3»
tabs already in the baseline, accepted to keep the tabs alike; the menu shot
took the version line drift it carried since ITGAME-140 (before that:
**2026-10-12** for ITGAME-21) on the pinned Chrome for Testing 152.0.7977.54
(headless, SwiftShader software GL, Arch Linux, Noto Color Emoji); two
consecutive runs without `--update` gave 0 differing pixels on every scenario.
The layout-linter counts in `baseline.json` did not change with the font.
Another machine may still differ by GPU rasterizer.
Kill stray Chromium processes before a run — they starve software WebGL.
The Forgejo CI does not run visreg (see [CI](#ci)); run it locally after a
UI change.

## CI

`.forgejo/workflows/ci.yaml` (Forgejo Actions) runs on every push to any
branch and on «Run workflow» (inputs `mode`, `ref` — see [Deploy](#deploy)):

- **test-server** — runner `minipc-test`, container `golang:1.26` with a
  `postgres:18` service and `TEST_DATABASE_URL` set, so the DB tests run
  instead of skipping: `cd server && go test ./...`;
- **test-client** — runner `minipc-test`, container `node:22`:
  `cd client && npm ci && npm run build` (the build runs
  `gen-contract --check`, `tsc --noEmit`, `vite build` and `check-sprites`);
- **deploy** — after both, on `main` or a dispatch only, on the host runner
  `minipc-deploy`: stage, then production (see [Deploy](#deploy)).

Each job checks out the sha being deployed — the dispatch's `ref`, else the
pushed commit — with `git fetch --depth 1 origin <sha>` and the job token
(no `actions/checkout`); on `mode=rollback` the test jobs skip their steps.
Runs are serialized per ref: queued on `main`, the older run cancelled on
other branches (see [Deploy](#deploy)). Each job reports start/finish through
`tools/ci-notify.sh`. Not in CI: `go vet`, the sim report, and everything
that needs a browser or a running server — `smoke-ui` (menu and
`OFFICE=1`), the `qa:*` suites, `live-check-*`, `visreg`. Run what your
change touches locally (see [Tests](#tests)) before pushing to `main`: a
green push there goes straight to stage and production (the pushed sha, which a quick second push can make differ from the one tested).

## Claude Code cloud sessions

`.claude/hooks/session-start.sh` (runs only when `CLAUDE_CODE_REMOTE=true`)
prepares a fresh container: Go modules, `npm ci`, `npm run browser:install`
(falling back to the image's Playwright Chromium via `CHROME_PATH`), and a
local PostgreSQL with role `itd` and databases `itdirector` /
`itdirector_test`; it exports `DATABASE_URL` and `TEST_DATABASE_URL`.

## Metrics

ITGAME-189. The server exposes Prometheus metrics on a **separate
listener**: `-metrics-addr` (default from `ITGAME_METRICS_ADDR`), e.g.
`127.0.0.1:9181`; empty — no listener (the default: the local stand and the
tests run without it). It serves only `GET /metrics`; the public mux has no
such route (404), so the nginx vhost cannot leak it by accident. A listener
error is logged and never stops the game.

```bash
go run ./cmd/server -metrics-addr 127.0.0.1:9181 &
curl -s 127.0.0.1:9181/metrics | grep '^itgame_'
```

**Delivery.** The game box is not in the minipc VPN mesh, so the Vector push
of the minipc Grafana stack (`10.8.1.12:9880`) is unreachable from it.
Prometheus on minipc pulls instead, the way it already scrapes the box's
node_exporter (job `itgame-node`, `:9100`, ufw open only to `38.180.192.251`
— the egress of the usa hub). The scrape job, the nginx location or ufw rule
for prod and stage, the env var in the units and the Grafana dashboard are
the minipc side (`deploy/prometheus/`, `deploy/itgame/` in their repo).

Live since 20.10.2026 (MINIPC-310): `ITGAME_METRICS_ADDR` is
`127.0.0.1:9181` on prod and `:9182` on stage. nginx on the box exposes it as
`location = /metrics` on the 443 vhosts, allowing only `38.180.192.251`;
everyone else gets 403. The Prometheus job is `itgame-app` (https, label
`env=prod|stage`). The Grafana dashboard is «IT-директор — сервер игры»
(uid `itgame-app`, datasource `prom-hub`), viewable without login at
`https://minipc.lan.santarinto.com/grafana/d/itgame-app`. To check panels
from the shell, query through the Grafana datasource proxy, for example
`…/grafana/api/datasources/proxy/uid/prom-hub/api/v1/query?query=up{job="itgame-app"}`.
If you rename a series or a label, tell minipc: the dashboard queries them
by name.

**What is exported** (`server/internal/metrics`). No `sid` in labels —
cardinality and the player's privacy; labels are finite sets only.

| Metric | Type | Meaning |
|---|---|---|
| `itgame_build_info{sha,version}` | gauge | always 1, the binary as `/api/version` reports it |
| `itgame_ws_connections` | gauge | open `/ws` tab connections |
| `itgame_sessions_live` | gauge | live party actors (agent headless sessions included) |
| `itgame_tick_seconds` | histogram | actor time per tick: the game step and the save |
| `itgame_save_seconds` | histogram | `store.Put`: temp file plus rename |
| `itgame_saves_total{result}` | counter | `ok`, or `stale` — another actor took the session |
| `itgame_save_errors_total{op}` | counter | `write` (temp file) or `rename`; memory keeps the save |
| `itgame_session_takeovers_total` | counter | a second tab took the sid (`session_taken`) |
| `itgame_ws_read_timeouts_total` | counter | tabs closed by the read timeout (ITGAME-76) |
| `itgame_parties_started_total{difficulty}` | counter | new parties, `restart` after a bankruptcy included |
| `itgame_parties_resumed_total` | counter | parties restored from a save on connect |
| `itgame_parties_finished_total{outcome,difficulty}` | counter | `bankrupt`, `victory` or `abandon`, counted once per finale |
| `itgame_party_days{outcome}` | histogram | the game day at the finale |
| `itgame_commands_total{cmd,result}` | counter | player commands, `ok` or `rejected`; a name outside the protocol is `unknown` |

Plus the standard `go_*` and `process_*` series. The `cmd` label takes a
name only from `knownCommands` (`server/internal/ws/metrics.go`): outside
the running phase `game.Apply` answers `wrong_phase` before it looks at the
command, so a raw client `type` would otherwise become a series.
`TestKnownCommandsCoverProtocol` fails when a new `Command("…")` is missing
from that set.

Labelled series exist at zero from the start. The metrics package `init` sets
up `saves`/`save_errors` itself. The `ws` package `init` calls
`metrics.Preset`, which creates every difficulty × outcome, the outcomes of
`party_days`, and every `knownCommands` name plus `unknown` × `ok|rejected`.
Without this, a vector creates a series only on its first `Inc`, so
Prometheus sees it born at 1. `increase()`/`rate()` then see no 0 → 1 step,
and the first event of each label set after every restart (every deploy)
vanishes from the dashboard. On stage on 20.10 «Партий начато» showed 0 with
`itgame_parties_started_total{difficulty="normal"} 1`.
`TestMetricsPresetSeries` checks the scrape before any event. A new
difficulty must be added to the list in `ws/metrics.go` `init`.

### Load test

ITGAME-193. `client/scripts/load-bots.mjs` plays parties over `/ws`. Each bot
has its own sid (`loadbot-<run>-<i>-<gen>`), difficulties rotate, and the
speed is 3. On each snapshot a bot sends at most one command:

- `next_day` on the day report;
- an event option, moving to the next option when the server answers
  `not_enough_money`;
- virus and repair clicks;
- `replace_pc` for a dead PC;
- PCs and hires within `staffLimit`;
- `restart` after a bankruptcy, and a fresh sid after a win.

No snapshots arrive during the day report pause. A command sent just before
the day ended gets `wrong_phase`, and without a watchdog the bot would stay
silent from then on. So once a second the bot decides on its last snapshot
if it has heard nothing for 1.5 s. Steps are `bots:seconds`. Every 10 s the
script prints one summary line: live bots, snapshots/s, commands/s,
rejections by `command:code`, reconnects, restarts, wins. A host that is not
stage or localhost needs `--allow-prod`.

```bash
cd client && node scripts/load-bots.mjs --base wss://stage.itgame.santarinto.ru --steps 10:120,25:120,50:300
```

Watch the result on the `itgame-app` dashboard, or query it through the
Grafana proxy (see [Metrics](#metrics)). Prod and stage share the
single-core box `90.156.129.221`, so also watch prod's tick and the box CPU.

Numbers on stage, 20.10.2026, build 46eeab2, steady-state samples per step:

| Bots | Ticks/s | Tick p95 / p99, ms | Save p95, ms | Stage CPU | Stage RSS | Box CPU | Box MemAvailable |
|---|---|---|---|---|---|---|---|
| 0 | 0 | — | — | 0% | 17 MB | 0.2% | 530 MB |
| 10 | 30 | 2.3–2.5 / 3.1 | 1.2 | 3% | 21 MB | 2–3% | 525 MB |
| 25 | 75 | 1.9–2.0 / 3.0 | 1.2 | 7% | 22 MB | 6–7% | 521 MB |
| 50 | 150 | 2.0–2.8 / 3.0–6.5 | 1.2–2.2 | 12–16% | 25–26 MB | 13–19% | 513–520 MB |

At 50 bots the box sent about 0.86 MB/s (≈17 KB/s per party at speed 3).
There were about 168 saves/s, one per tick plus commands, with no save errors,
no `stale` saves, no read timeouts and no reconnects. Goroutines: 158, about
three per session. Prod stayed idle and unaffected. That is roughly 0.3% of
one core per party at speed 3, so the box holds 50 parties with a wide
margin. CPU puts the ceiling somewhere in the hundreds of parties, not
measured. At that scale the save rate is the first thing to watch: every tick
writes a file.

## Database

PostgreSQL is optional: gameplay and saves don't use it. It backs the
`/admin` page (current balance config and the `lib_equipment` catalog).

Put `DATABASE_URL=postgres://user:pass@localhost:5432/itdirector` into
`.env` in the repo root (gitignored); the `Makefile` loads it and exports
`DATABASE_URL` / `TEST_DATABASE_URL`. With `DATABASE_URL` set, the server
connects on start and applies migrations from
`server/internal/db/migrations` (tracked in `schema_migrations`). Neither a
connection nor a migration error stops the game (ITGAME-190, `db.Open`): the
server logs «ВНИМАНИЕ: БД недоступна: …», starts as usual, and retries in the
background — 5 s, doubling up to a minute, logging only when the error
changes — until the database connects and takes the migrations («БД
подключена с попытки N»); until then `/admin` shows «БД недоступна: <error>»
instead of the catalog. A `DATABASE_URL` that does not parse is a config
error: logged once, shown on `/admin`, never retried. Once connected the
server no longer watches the database: a later outage shows up as the same
notice on `/admin`, and pgx reconnects by itself on the next query. Without `DATABASE_URL` the server
starts normally and `/admin` shows «БД недоступна: DATABASE_URL не задан».

**On the game box** (since 20.10, minipc MINIPC-276; ITGAME-168): PostgreSQL
18 on localhost only, one database and role per instance — `itgame` for
production, `itgame_stage` for stage, neither can connect to the other's.
`DATABASE_URL` reaches the units through `EnvironmentFile` —
`/etc/itgame/prod.env` and `/etc/itgame/stage.env` (root 0600, outside git;
the units are minipc's, `deploy/itgame/systemd/`). The units carry
`Wants=postgresql.service`, not `Requires=`, so a running game survives the
database going away, and since ITGAME-190 a restart or deploy while
PostgreSQL is down starts the game too — only `/admin` waits for the
database (before it, a connection error at start was fatal and kept the
server in its `Restart=on-failure` loop). Backups: the provider's
external backup of the box, no `pg_dump` of our own (owner decision).
Checked 20.10: both instances log «БД подключена, миграции применены» with
the two tables (`lib_equipment`, `schema_migrations`); on an empty
PostgreSQL 18.6 the current `main` applies both migrations, seeds the nine
catalog rows and `/admin` lists them.

## Local stand (`:15555`)

A permanent local copy of the game for the owner, browser agents and
`itd.sprite.try`, independent of whether `make dev` or a QA script's
self-serve port is up (ITGAME-123). It is the systemd user unit
`itgame-dev.service` on `127.0.0.1:15555` with `ITGAME_DEBUG=1`, so
`http://localhost:15555/?debug=1` gives `window.itd`.

    make stand-init       # once: bare repo, deploy hook, remote «stand», first deploy
    git push stand main   # deploy: exactly the pushed commit, no WIP
    make stand            # by hand: build the WORKING tree, WIP included

**Deploy by push** (ITGAME-139): the stand is what the owner plays, so it
changes only when `main` is pushed to the local remote `stand` — a bare repo
`~/.local/share/itgame-dev/repo.git` whose `pre-receive` hook
(`tools/dev-stand/pre-receive`, installed by `make stand-init`) lays the
pushed tree out into `~/.local/share/itgame-dev/src` (its own index, no `.git`;
the working clone takes no part, so a dirty tree ships nothing) and runs that
tree's own `tools/dev-stand/stand.sh deploy` — changes to the deploy script
ship with the code. The build is stamped like `tools/deploy` does it:
`BUILD_SHA` for the client, `-ldflags -X itdirector/internal/ws.buildSHA` for
the server, and the build version (`BUILD_VERSION`, `-X ws.buildVersion`,
ITGAME-140) read with `git log` while `stand.sh` still runs in the hook's bare
repo (an empty one is announced: the menu and `/api/version` then show none); `npm ci` runs only when `client/package-lock.json` changed
(`node_modules` lives in `src` between deploys). It is `pre-`, not
`post-receive`: a failed build rejects the push, so the stand's `main` is
always what really runs. Other branches are accepted and ignored («не main,
стенд не трогаю»); deleting `main` is refused (`receive.denyDeletes`). One
deploy at a time (`flock` on `deploy.lock`). Pushing to Forgejo is separate;
to deploy on every `git push`, add the stand as a second push URL of `origin`.

Both paths put the binary, `client/dist` and the saves into
`~/.local/share/itgame-dev/{bin,dist,saves}`, install
`tools/dev-stand/itgame-dev.service` into `~/.config/systemd/user`, enable
and restart it, then fail unless `:15555` serves the `<meta name="build">`
just built; if it does not come up, the previous binary and `dist`
(`bin/itdirector.prev`, `dist.prev`) are put back and restarted. The stand
runs a copy: QA scripts and visreg rebuild `client/dist` all the time and the
stand does not change until the next deploy. A deploy keeps the database, the
save files and the parties: a party continues on the new build unless the
deploy changed `game.SaveFormat` — then the menu shows «СЕЙВ НЕСОВМЕСТИМ»
instead of «Продолжить» (ITGAME-169, owner decision 18.10, see
[Sessions and saves](#sessions-and-saves); from ITGAME-140 every deploy did
that). A commit that bumps the format ends the stand's party when it is
deployed.
A browser agent's acceptance pins the stand's sha: do not push to `stand`
while one runs.

The database is `itdirector_dev` on the host's PostgreSQL, reached over the
unix socket with peer auth (`postgres:///itdirector_dev?host=/run/postgresql`,
no password). An optional `~/.config/itgame-dev/env` (`KEY=VALUE` lines,
mode 600) overrides the unit's environment, for example a `DATABASE_URL` with a
password; since 20.10 it carries `ITGAME_MINIPC_URL` and `ITGAME_MINIPC_TOKEN`,
so the stand's `/api/debug/sprite/*` read the real minipc (see [Sprite
pipeline (minipc)](#sprite-pipeline-minipc)). The unit restarts on failure; PostgreSQL coming up after it at boot
needs no restart — the server picks the database up in the background (see
[Database](#database)). Logs: `journalctl --user -u itgame-dev`.

Agents read the same database through the MCP server `itd-db` (DBHub,
`@bytebase/dbhub`, local scope of this project): config
`~/.config/itgame-dev/dbhub.toml`, one tool `execute_sql`, read-only
(`select`/`with`/`explain`/`show` per statement, inside `BEGIN READ ONLY`),
500 rows max. It connects over TCP `127.0.0.1:5432` because DBHub ignores a
socket path in the DSN.

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
today: `desk_pc`/`desk_pc_off`/`desk_pc_broken`, `desk_empty`,
`worker`/`worker_1..3`, `boss`/`boss_lunch`, `rack_server`/`rack_empty`,
`router`, `gateway`, and `cooler`/`fridge`/`coffee_machine` are all 128px
`hd32` art (see the sprite manifest below) drawn at ×0.5 into 64-world-px
slots —
`spriteScale()` computes that factor from the texture's real width against
`SPRITE_TARGET` (`pixelart.ts`), so at 2× render one texture texel lands on
exactly one canvas pixel. Also for
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

**HUD and room actions (ITGAME-94).** The HUD header (`HUDScene`, 1280×96)
holds only global controls: money and the pace rows on the left
(`hud.money`/`income`/`payroll`/`net`/`dayProfit`/`debt`/`points`, laid out up to
x 832 — `PANEL_LEFT_MAX`), goal/day/market on the right, «масштаб»
`btn.zoom`, `btn.debug` (debug only), `btn.menu` ⌂ and `btn.speed.0..3`; the
left column is the room nav. Room-specific actions live in the room scene,
built by `client/src/ui/actionButton.ts` (`ActionBar`): a column at the
right edge of the room, x 1142..1270 (`ACTION_COL_X`, buttons 128×44, two-line
label «action / price», gap 10) — out of reach of the HUD toasts (≤ 924 px
centred, right edge ≤ 1102), the event card (x 400..880) and the desks (the
right desk column with its «мастер» button ends at x 1124). The room's
devices sit on the same column centre (`ACTION_COL_CX` = 1206): office —
router, boss, then `btn.pc` (y 384), `btn.hire` (438), `btn.boss` (492);
server room — the gateway slot and `btn.gateway` (y 452) under it. The
buttons are created once in the scene's `create()` (renders only update
label and state), keep the ITGAME-17 machinery (dimmed when disabled, the
reason in `room.tooltip.text` left of the button, shake + `error` sound on a
refused click, `markDisabled` → `D`), and send to `nav.activeOffice`; in a
locked office the column is hidden (`itd.click` → `code: 'hidden'`). The
«нет связи» toast/sound (ITGAME-90) still comes from the HUD: `client.send`
calls `onNotConnected` on every listener. The HUD hides room tooltips when it
opens a window (`hideActionTooltips()`); the office/server-room windows hide
them too and suppress them while open (ITGAME-89). The goal row is a progress
bar (ITGAME-21): `hud.goal.bar` (x 884..1264, the text sits on it) with
`hud.goal.fill` = money / `winTarget`, combo marks `hud.goal.staff`/`core`
(green when met) and the day-limit tick `hud.goal.deadline`, each shown only
when the difficulty sets it. The day row is a bar too: `hud.day.bar`/`fill`
(x 884..1264, 10:00 → 19:00 from `client/src/workday.ts`, which mirrors
`config.go`; `ticksPerHour` comes from the snapshot), the lunch band
`hud.day.lunch` (14–15) and the 17:00/18:00 marks `hud.day.mark17`/`mark18`;
`hud.day` is left-aligned at x 888, its text unchanged. Locked office tabs
carry a shape-drawn lock `hud.lock.office1`/`office2` (body + shackle arc, no
emoji); the tab that can be bought now (offices go in order, money ≥ price)
turns green (fill `0x2a6b3f`, green lock, white price) — distinct from the
active-tab stroke owned by `highlightNav()`. The bottom strip `hud.log`
(`hud.log.bg`, x 540..1270, y 620..714, both rooms) keeps the 5 latest lines
with the game clock: toasts, the day's server journal lines live — `state.dayLog`
carries the event outcomes of the current day as «HH:MM текст» (the same lines
`day_report.events` gets), and each goes in with its own «HH:MM» as soon as a
snapshot brings it (ITGAME-163; before, they came only with the evening report and
the clock ran back, «18:40 Кулер» → «10:50 вирус…»); the evening report then adds
only the journal lines the strip has not seen and the day summary last (a report
the server re-sends after a reconnect in `day_report` adds nothing — ITGAME-150);
«10:00 Утро, день N» when a snapshot of the same party brings a later day (the
clock of the day's start, one line after an offline gap of several days);
«Событие: …» and snapshot diffs from `client/src/eventlog.ts` (hire/fire, PC,
router, boss, breakdown/repair, racks, amenities, gateway, core) — per snapshot
the order is the new-day line, the diffs, then the journal lines, so a card's
«Событие: …» precedes its outcome. A reload shows the day's journal so far
(the strip starts empty and takes `dayLog` from the start); with
`skipReports` the journal lines still go in, the summary stays a toast. Bottom toasts
anchor at y 614 above it and the server-room summary line sits at y 604.
The onboarding chain (`client/src/onboarding.ts`): a coach plate `hud.coach`
(`hud.coach.bg`, x 884..1130, y 104..150) with a frame `hud.coach.target` on
the target in office 0 (`btn.hire`, `btn.pc`, the router slot), steps by state
predicate — hire, second PC, router (a party starts with 1 PC) — done steps
are skipped and completion is stored as `itd.onboard = 'done'` through the
safe storage (`client/src/storage.ts`); hints other than `master`/`virus`/`softlock`
are held back while a step shows, so a QA suite that wants the plate off must
set `itd.onboard = 'done'` itself — none does today (qa-itgame37/38 pre-set only
`itd.hint:<id>` keys; qa-itgame38 removes `itd.onboard` before its sandbox case
and sets it in the sandbox tab to prove `restore()`), and suites running several
cases in one browser see the coach or not depending on case order.

The UI-scale cycle is 1×, 1.4× (default) and «по окну» (fit the window); 2×
was dropped in ITGAME-61 — the canvas outgrew a laptop window and `#app`
scrolled sideways — and a stored `itd.uiScale = '2'` is read as «по окну» and
rewritten once.

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
  manifest per key (unchanged for the 3 remaining 64px keys —
  `office_floor_tile`, `icon_money`, `icon_network`); `--hd`, or a key the
  manifest doesn't have yet, defaults to 128px/`hd32`/isometric and reads
  `scripts/sprites/prompts-hd.txt`. Per-engine size caps are enforced
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
  `--smooth` (ITGAME-83) is the separate path for `render: 'smooth'` keys and
  refuses any other key and every pixel-path flag: an optional chroma key
  (`--chroma ff00ff`, `--chroma-tol 48`) for a diffusion output without alpha;
  `--chroma auto` takes the background from four corner patches inset 4 px
  (a generator's light seam runs along the frame edge, that 4 px frame is
  cut too) with a tolerance of twice the corners' noise, at least 12 (a fixed
  48 ate grok's near-black contour 42–53 away from its dark background), skips
  keying when the corners are already transparent, and refuses on a busy
  corner or corners of different colours. The input is
  PNG or JPEG, told apart by signature (`jpeg-js`);
  bbox by `--alpha`, a square around it centred on X and sitting on the
  bottom `--margin` (default 4), then area resampling with fractional edges
  and alpha-weighted colour (`client/scripts/lib/sprite-smooth.mjs`, covered
  by `node --test`) — no palette, no alpha threshold, the half-tones stay.
  `icon_trophy.png` is `node client/scripts/sprite-remap.mjs <generation.png>
  client/public/assets/sprites/icon_trophy.png --key icon_trophy --smooth`.
  `icon_chart.png` and the rest of the ITGAME-83 set (`icon_warning`,
  `icon_lock`, the 12 `ach_*` achievement icons) are the same with their key
  and `--chroma auto`; each key's `note` in `sprites.json` carries its command.
- **Edit:** `scripts/sprite-edit.sh <name> "<instruction>"` — Gemini
  (`GEMINI_IMAGE_MODEL`, default `gemini-2.5-flash-image`) → remap;
  overwrites the tracked PNG only if the result passes the contract.
- **Keys** in `.env`: `SPRITES_API_KEY` (PixelLab), `GEMINI_API_KEY`.
- **Contract:** transparent PNGs in the key's palette, no baked-in
  checkerboard — see the sprite manifest below; boot re-checks sizes.
- **Review:** eyeball each PNG for silhouette readability at game scale,
  touch-ups in Aseprite.
- **Sound:** SFX from [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds)
  (CC0) in `client/public/assets/sfx/`, played by `client/src/audio.ts`.
  Every `playSfx` call and HUD toast reaches `itd.log()` via
  `client/src/uibus.ts` — see [Debug API](#debug-api-windowitd).
- `client/src/pixelart.ts` generates fallback textures for any sprite
  without a PNG.

### HD sprite pipeline

`scripts/sprites/hd-src/` holds the raw generations (`desk_pc.raw.png`,
`worker.raw.png`, `boss.raw.png`, `boss_lunch.raw.png`, `rack_server.raw.png`,
`router.raw.png`, `gateway.raw.png`, `cooler.raw.png`, `fridge.raw.png`,
`coffee_machine.raw.png`) plus `desk_empty.png` and `rack_empty.png`,
hand-edited sources (not generations — see below).
`scripts/sprites/build-hd.sh` deterministically rebuilds every HD asset
from those sources with no network and no AI: it calls `sprite-remap.mjs`
(`--flip-x`/`--place` bake the worker's mirror and its manual
chair-to-chair alignment onto `desk_pc` into the PNG, `--bottom-margin`
lines up `boss`/`boss_lunch`'s feet) and `client/scripts/sprite-recolor.mjs`
— a one-line CLI, hex→hex replacement inside an optional `--region`, used
for the monitor-screen states (`desk_pc`/`_off`/`_broken`) and the
worker's shirt-color levels (`worker_1..3`). Run
`scripts/sprites/build-hd.sh` (no args), then
`cd client && node scripts/check-sprites.mjs`.

What actually produced usable art (prompts and detail in
`scripts/sprites/prompts-hd.txt`): pixflux, `--hd` (`--size 128 --palette
hd32 --lock-palette`), outline "single color black outline", shading
"medium shading", detail "medium detail", for `desk_pc`; the same engine/
palette/outline/shading/detail for `worker`, but `--size 80 --direction
north-west` — it faced right, so `build-hd.sh` mirrors it with `--flip-x`.
`boss` and `boss_lunch` used the same outline/shading/detail too, but
`--size 96` and one shared `--seed 4099860094` (`cksum` of the key name
`boss`) for both prompts, so the two poses (working with a laptop, on
lunch with coffee and a sandwich) render as the same character; both went
through `--background` (see below) rather than the synchronous endpoint.
`build-hd.sh` then remaps each raw PNG onto the 128×128 canvas with the
same `--bottom-margin` for both, so their feet land on the same canvas row
and the figure doesn't jump when `OfficeScene.ts` switches the slot
between the two on lunch.

`rack_server`, `router`, `gateway`, `cooler`, `fridge` and `coffee_machine`
are the HD replacement for the last 64px `sweetie16` art (server room and
the office amenity shelf/network slot): same pixflux `--background` engine/
outline/shading/detail/`--lock-palette` as `boss`. Their generation canvas
is sized to the item's on-screen footprint rather than a fixed number
(`rack_server` 128px, the rest 96px), and unlike keys the manifest already
had at 128px/`hd32`, `--size`/`--palette` had to be passed explicitly on
the CLI — at generation time the manifest still listed these keys as
64px/`sweetie16`, and without an explicit override `gen-sprites.sh` would
have read that (and `isometric=false`) instead of `--hd`'s defaults.
`fridge` needed a second generation: the first attempt (default seed, no
"large tall" in the prompt) drew a refrigerator with a 26×48 bbox on the
96px canvas, half `cooler`'s height — redone with "large tall … full
height" in the prompt and an explicit seed (`scripts/sprites/prompts-hd.txt`
carries it as the key's third field). Sprites are drawn with a centered
origin, so `build-hd.sh` picks each `--bottom-margin` to center the item
in its box — `rack_server` 8, `router` 24, `gateway` 27 (the source bboxes
differ: 72×111, 72×79, 80×73) — while `cooler`/`fridge`/
`coffee_machine` all share one margin (22) so the three sit on a common
"floor line" on the amenity shelf regardless of their own height (84/83/78).
`rack_empty` — like `desk_empty` above — is never generated: pixflux
ignores "empty"/"no servers" negations in the prompt the same way it
ignores `desk_empty`'s. It's a pixel edit of `rack_server.raw.png` (same
silhouette/alpha, the front bay's servers erased to a dark cavity with rack
rails) remapped with the *same* `--bottom-margin` as `rack_server`, so the
occupied and empty rack line up pixel-for-pixel when `ServerRoomScene.ts`
swaps one texture for the other in the same slot.

Long pixflux generations occasionally trip a gateway timeout: the
synchronous `create-image-pixflux` call periodically comes back as a 502
upstream error from PixelLab's gateway — while still charging the
generation, with no image produced — regardless of `--negative`/
`negative_description`; it's the gateway's timeout on a slow generation,
not the presence of `negative_description` (the `desk_empty` attempts
below happened to use `--negative` and hit 502 twice, which looked like
the flag was the cause, but `boss`/`boss_lunch`, generated later with no
`--negative` at all, hit the same 502 on the synchronous endpoint before
switching to `--background`). `scripts/gen-sprites.sh --background` sends
the same request body to the async twin
(`create-image-pixflux-background`) and polls `GET
/v2/background-jobs/{id}` instead, which isn't subject to that request
timeout. The `background_job_id` from the 202 response is written to
`$OUT_DIR/<key>.job_id` immediately, before polling starts, so a dropped
poll doesn't waste the paid generation — resume it with
`scripts/gen-sprites.sh --fetch-job <job_id> <key>`.

`desk_empty` was never generated: pixflux with the anchor seed draws a
computer and chair even with "no computer, no chair" in the prompt
(negations in prompt text are ignored by the model), and `--negative`
(`negative_description`) twice came back as the 502 described above, with
no image produced despite the charge. `desk_empty.png` is instead a
deterministic pixel edit of `desk_pc.raw.png` (monitor/keyboard/mouse/chair
erased, the desk surface/edge/right-cabinet pixels they covered restored
from the desk's isometric geometry), remapped like any other HD source.
Other gotchas: bitforge's `style_image` must be exactly the output's size
or the API returns 500, and a style_image crop of the desk made bitforge
draw a desk into the `worker` despite "no desk" in the prompt — the
reference drags its composition along. Check the credit balance with
`scripts/gen-sprites.sh --balance` before and after a batch of
generations.

### Sprite manifest

`client/src/assets/sprites.json` is the single source of truth for AI
sprites: `BootScene` loads its keys, `check-sprites.mjs` checks them, scenes
scale by them. `client/src/assets/manifest.ts` adds types, `AI_SPRITES`,
`SWEETIE16` and `spriteKey()`. Per key:

- `size`, `frames` — the PNG is exactly `size·frames × size` (frames side by
  side; `frames > 1` is registered as a spritesheet).
- `palette` — `sweetie16` (the remaining 64px art: `office_floor_tile` and
  the `icon_money`/`icon_network` icons) or `hd32` (Sweetie-16 plus 16
  in-between shades) — every other key, desk/worker/boss/rack/router/
  gateway/amenity alike, is 128px `hd32` today.
- `class` — target on-screen size from `SPRITE_TARGET` in
  `client/src/pixelart.ts`; `addSprite()` scales from frame 0. `amenity`
  (cooler/fridge/coffee_machine) is 64, not 48: at 48 a 128px `hd32` frame
  would scale ×0.375, a non-integer texel at 2× render — 64 gives ×0.5,
  same as every other HD key, and the item's actual on-screen size comes
  from its opaque-pixel bbox inside the 128×128 canvas instead.
- `includesDesk` — the sprite draws its own desk. `false` (today's HD
  `worker`, 128px): the slot draws `desk_pc`/`desk_pc_off`/`desk_pc_broken`
  underneath and the worker on top at the same point (`OfficeScene.ts`'s
  `SLOT_LAYOUT_HD`, sized from the HD sprites' opaque-pixel bbox). `true` is
  legacy: an old 64px `worker.png` with the desk baked into the same PNG —
  an occupied slot then shows only it, no `desk_pc` underneath
  (`SLOT_LAYOUT_LEGACY`, sized for that fuller 64×64 frame instead).
- `fallback` — texture to use if this one is missing (`boss` → `worker`,
  `boss_lunch` → `boss` → `worker`, `gateway` → `router`); `aliases` maps
  alternate names the same way. `desk_pc_off`/`desk_pc_broken` fall back to
  `desk_pc`, `worker_1..3` to `worker`.
- `maxSpecks`, `maxWhitePct`, `note` — per-key thresholds with the reason.
- `seenIn` — where the key is visible, for `qa:sprite` (ITGAME-157): see
  [Sprite pipeline (minipc)](#sprite-pipeline-minipc).
- `render` — `pixel` (default) or `smooth` (ITGAME-83). A `smooth` key is a
  detailed source drawn smaller than it is (`icon_trophy`: 64 → 16 on the
  menu): `BootScene` gives that one texture a LINEAR filter while the rest of
  the game stays NEAREST, `check-sprites` drops the palette and the
  semi-transparency rules for it (size, transparency, `#f4f4f4` and noise
  still apply), `itd.sprite.try` defaults to `filter: 'linear'` for it and
  `itd.assets()` reports `render: 'smooth'` with an empty `offPalette`.
  LINEAR has no mipmaps here: keep the shrink at 2× or below (64 → 32 canvas
  px for a 16px icon at `RENDER_SCALE = 2`).

State keys for the desk/worker slot: `desk_pc` (screen lit — an occupied
workspace, and also what lunch shows), `desk_pc_off` (a PC bought but no
employee assigned yet), `desk_pc_broken` (a breakdown), and `worker_1..3`
for employee level 1..3 (`worker` itself is level 0) — see
[Assets](#assets) above for how the states/levels are produced. The boss
slot has its own pair of state keys the same way: `boss` (at work, laptop
in hand) and `boss_lunch` (on lunch, coffee and a sandwich) — same
character, same seed, `OfficeScene.ts` swaps between them on `s.isLunch`.

A new key ships only together with its PNG and vice versa: a key without a
file 404s at boot and fails `smoke-ui`.

`check-sprites.mjs` (part of `npm run build`) decodes PNGs with pngjs, no
browser needed. It fails on: key ⇄ file mismatch, dangling
`aliases`/`fallback`, `hd32` not a superset of `sweetie16` or over 32
colors, wrong size, colors outside the key's palette, <5% transparency,
semi-transparent pixels (the last two not for `render: smooth`), too much `#f4f4f4`, and noise — 8-connected
opaque components of area ≤ `4·(size/64)²` beyond `maxSpecks` (default 0).
`desk_empty` is no longer an exception (it's a pixel edit of `desk_pc`, not
a generation with baked-in checkerboard); only `office_floor_tile` (4)
still carries one today — its count is recorded, the art is left for
regeneration.

`npm run qa:slots` (see [Tests](#tests)) checks slot rendering on
`full_office`: each occupied desk draws `worker`/`worker_N` (by employee
level) over exactly one `desk_pc`/`desk_pc_broken` at the same point, `boss`,
`gateway`, `router` and the `cooler`/`fridge`/`coffee_machine` amenity shelf
textures land in their slots, lunch turns a slot into a single `desk_pc`
with no employee plus the «обед» label and switches the boss slot to
`boss_lunch`, on `broken_pc` a breakdown shows `desk_pc_broken` and the
workstation zone `office.slot.0` covers the whole visible breakdown — the
worker frame and the «✖ чинить k/N» label above it, and the blinking
highlight is that zone itself (ITGAME-75/92): `itd.stack` wins it (and no
other office zone is under the point) at the label, the gap, the worker's
top strip and corners, `itd.zones` keeps it clear of the master button, a real
hover shows the employee tooltip with «0/3», real mouse clicks there send
exactly one `repair_click` (not `motivate`, not nothing) and step the label
1/3 → 2/3, right click opens the fire dialog, the third click repairs and the
same zone (now 64×64) sends `motivate`; the tooltip-under-window case hovers
worker 1 and opens the router window via `itd.click` (no `pointerout`) and the
fire dialog via a real right click — no tooltip at once, after a snapshot or
after `itd.hover` (ITGAME-89); the server
room's occupied racks and core draw `rack_server` with no layout-linter
findings (`itd.overlaps()`/`itd.offscreen()`), and — on `mid_day10`, whose
one unlocked office has fewer servers than rack slots — empty racks draw
`rack_empty`, the first empty one carries the "place a server here" tint,
and closed offices' racks render `rack_empty` dimmed with no tint. On
`spare_pcs` (more PCs than hires, added for this exact gap), it also checks
the desk-only states full offices never exercise: a bought PC with no
employee draws `desk_pc_off`, and a slot with no PC at all draws
`desk_empty`.

### Icon next to text

`attachIcon(text, key, { px, gap })` (`client/src/ui/iconText.ts`, ITGAME-83)
puts a sprite left of a `Text` instead of an emoji inside it. The room comes
from the text's own left `padding`, so a text background (a toast) stretches
over the icon and a centred text stays centred as a pair. The icon copies the
text's x/y/alpha/visible/depth on every `prerender` and is destroyed with it:
toast stacking and fade-out, a hidden menu and a closing modal need no extra
code. Without a background the icon sits below the text in display order, so
`itd.overlaps` does not take it for a plate over the text. A multi-line block
cannot hold a sprite mid-text: `HUDScene.bodyWithTrophy` gives the achievement
line its own `Text` under the block, the pair centred where the old block was.
Sizes in use: 16 px next to 12–15 px text, 24 px next to an 18–20 px title or
toast.

### Trying a sprite in the tab

`itd.sprite.try(key, dataUrl)` (`?debug=1` only, ITGAME-119) replaces the
texture of a manifest key with a PNG given as a `data:image/png;base64,…` URL
and re-points every live object of every scene. Nothing is written to the
repo, `dist`, a save or browser storage; a reload drops the swap.

The receipt runs the same contract as `npm run check:sprites`
(`client/scripts/lib/sprite-check-core.mjs`): a violation (off-palette colour,
semi-transparent pixels, noise) is **applied and named** in `problems`, so a
broken edit is visible on the scene. Only three things refuse: a key missing
from `sprites.json` (`unknown_key`), a source that is not a decodable PNG data
URL (`bad_src`), a PNG that is not `size·frames × size` (`bad_size`) — a
wrong size would move the layout and make every other finding false — and an
unknown `filter` (`bad_filter`).

The third argument `{ filter: 'linear' }` samples only this texture
bilinearly; the default `'nearest'` is what the whole game uses. `pixelArt:
true` does not store NEAREST in the texture (`source.scaleMode` stays `0`) —
the WebGL renderer picks NEAREST because `antialias` is `false`, so check the
filter on `source[0].glTexture.minFilter`, not on `scaleMode`. `'linear'` is
for a detailed source larger than its slot: there are no mipmaps, so it is
clean up to a 2× shrink and grainy past it. The receipt and `list()` carry
`filter`; `reset()` brings the original back with its own filter.

`itd.sprite.list()` names what is swapped, `itd.sprite.reset(key?)` restores
the original source. While a key is swapped, `itd.assets()` reports
`source: 'tried'` and `itd.assetSet()` `active: 'tried'`: do not record a
visreg baseline in that state. `sha256` is `null` when the page is not a
secure context (`crypto.subtle` is absent on `http://<lan-ip>`).

The pipeline this is the first step of: `docs/design/sprite-pipeline.md`.

### Sprite pipeline (minipc)

Steps 4–5 of `docs/design/sprite-pipeline.md` (ITGAME-157 against a stub,
ITGAME-182 docked to the real minipc): a sprite goes from a minipc job to the
tab, through the acceptance run, into the repo. minipc owns
jobs, revisions and per-key statuses (`open → draft → final → returned |
accepted → committed`); the game side reads them and gives verdicts.

**Environment.** `ITGAME_MINIPC_URL` — the API base (`…/api/itgame`, ends
before `/jobs`); `ITGAME_MINIPC_TOKEN` — the Go server's token (role
`itgame-go`, read only); `ITGAME_MINIPC_CLI_TOKEN` — the coordinator's token
(role `itgame-cli`: creates jobs, bootstrap revisions, `final`, verdicts) for
`qa:sprite` and `sprite:take`. Token values never go into the repo, the
tracker, commit messages, fixtures or logs; refer to them by variable name.

Where they live (owner's decision 20.10, ITGAME-182), both files mode 600:
`~/.config/itgame-dev/env` — the stand's `EnvironmentFile`
(`itgame-dev.service`), holds `ITGAME_MINIPC_URL` and `ITGAME_MINIPC_TOKEN`;
`~/.config/itgame-dev/minipc-cli.env` — `ITGAME_MINIPC_CLI_TOKEN` only. A
self-served server never gets the itgame-cli token in its environment (the Go
server does not read that variable anyway).

**Auto-load** (`client/scripts/lib/minipc-client.mjs`, `minipcFromEnv`): when
`ITGAME_MINIPC_CLI_TOKEN` is not in the environment, `qa:sprite` and
`sprite:take` read it from `minipc-cli.env`; when `ITGAME_MINIPC_URL` is not,
they read **only that key** from `~/.config/itgame-dev/env` — the itgame-go
token there is the server's and is never taken. The environment wins over the
files. Lines are `KEY=VALUE` (blank lines and `#` comments skipped, `export `
and surrounding quotes allowed); a missing file, a missing or empty variable
is an error naming the file and the variable, never a value. The token from
the owner's file goes only to an `https://` address: an `http://` base (a
stub, a foreign port) with a file-sourced token is refused before the file is
read — a stub run sets both variables in the environment. Both scripts start
by printing where the address and the token came from (`minipc: адрес — …,
токен координатора — …`: `окружение` or the file path, never a value).
`ITGAME_MINIPC_CLI_ENV_FILE` / `ITGAME_DEV_ENV_FILE` override the two paths;
the stub harness (`qa:sprite-pipeline`) points them at a path that does not
exist, so no hole in its environment can load the owner's token.

`qa:sprite` self-serves a Go server, which reads minipc with its own token:
`ITGAME_MINIPC_TOKEN` must come from the caller's environment, and only that
line of the stand's file — not the whole file, which may also carry the
stand's `DATABASE_URL`:

    export ITGAME_MINIPC_TOKEN="$(sed -n 's/^ITGAME_MINIPC_TOKEN=//p' ~/.config/itgame-dev/env)"

The run refuses without it or when it equals the coordinator's token.
`selfServe` (`client/scripts/lib/selfserve.mjs`, `serverEnv`) strips
`ITGAME_MINIPC_CLI_TOKEN` from the environment of every self-served server,
and an inherited `DATABASE_URL` too (a QA server would otherwise run its
migrations on whatever database the shell points at — `make` exports `.env`);
a script that needs a database passes it as `selfServe({ env: { DATABASE_URL }
})`. No QA script does today.

**Go routes** (`server/internal/spriteproxy`, registered only with
`ITGAME_DEBUG=1`; without the URL or the token they answer `503
minipc_not_configured`): `GET /api/debug/sprite/{taskId}` — the job as minipc
returns it (keys, statuses, `latest`/`final` pointers; `itd.sprite.watch` needs
it for the key list, minipc has no all-keys revision list);
`GET /api/debug/sprite/{taskId}/{key}?rev=N` — the PNG of revision N;
`GET /api/debug/sprite/{taskId}/{key}/latest` — the newest revision, `ETag`
passed through, `If-None-Match` → `304`. The PNG routes recompute sha256 of
the bytes and answer `502 sha_mismatch` when it differs from minipc's
`X-Sprite-Sha256`; they pass `X-Sprite-Rev`/`X-Sprite-Sha256` on. Arguments
are checked before minipc is asked: `bad_task` (not a number), `bad_key`
(not `[a-z0-9_]+`), `bad_rev` (not ≥ 1). minipc's answers map to `not_found`
(404 with minipc's JSON `{error}`), `minipc_auth` (401/403 — the server's
token; a 403 carries minipc's `detail`), `minipc_unreachable`, `minipc_error`
(also a 404 that is not JSON: minipc's framework page for a path outside its
routes — `ITGAME_MINIPC_URL` without `/api/itgame` — which as `not_found` would
make `watch` read «no revisions yet» and stay silent), `too_large` (over
8 MB). Every refusal is `{code, error}`.

**In the tab** (`client/src/debug/spriteTry.ts`): `itd.sprite.pull(taskId,
key, rev)` puts a frozen revision in place the way `try` does — same receipt
and contract, plus `source: 'pull'`, `taskId`, `rev` and minipc's `sha256`;
`itd.sprite.watch(taskId)` puts the latest revision of every job key that the
manifest has (others go to `skipped`, a key without a revision answers
`not_found`) and polls them once a second with `If-None-Match`;
`itd.sprite.unwatch()` stops it and returns the receipts that came after the
first round (`updates`) with the poll and error counts. `list()` carries
`source`, `taskId`, `rev`. A route refusal reaches the receipt as its `code`;
a 404 that is not JSON is `debug_off` (a server without `ITGAME_DEBUG=1`).

**`seenIn`** in `sprites.json` — where a key is visible, steps `{fixture,
scene, open?}`: a server fixture, the Phaser scene holding the key's objects,
and an optional id that `itd.click` opens after the load (a window, a tab).
`check:sprites` checks the fixture and the scene exist and refuses other
fields. Today: `icon_trophy`, `icon_chart` (`fresh`, `menu`), `cooler`
(`full_office`, `office`). A key gets its `seenIn` before its job — the place
in the scene comes first.

**New job.** `npm run sprite:job -- --spec scripts/sprites/minipc/jobs/<about>.json
[--dry-run] [--out <dir>] [--allow-dirty]` (`client/scripts/sprite-job.mjs`,
core in `client/scripts/lib/sprite-job-core.mjs`, ITGAME-182) creates a minipc
job from a spec checked into the repo: `{about, class, render?, common?, items:
[{key, brief, context: {text?, bg?, crop: {fixture, scene, open?, ids,
textures?, pad?, scale?}}}]}`. The class (`screenPx`, `sourcePx`, `palette`,
`colors`) comes from the class table of `docs/design/graphics.md`, checked
against every manifest sprite of that class (size and palette); `render` is the
class's (`pixel`/`smooth`), a mixed class needs it in the spec. The profile is a
snapshot of `graphics.md` for the class — `pixel`: the hard rules (§1),
palettes, render and sizes, the class row; `smooth`: render and sizes, the class
row and the pilot's decisions (§3), like rehearsal job 3 — then the file
contract with the palette hex and `common` under «Задание <about>», at most
4000 characters (letter 4123; minipc's source allows 20000 bytes, we keep the
letter), `version` `graphics@<last commit of graphics.md>`, `sha256` of the
text. Everything minipc would refuse is checked first, all at once: `about`,
keys, a brief over 500 **bytes**, `bg`, the crop's fixture and scene (the same
lists as `seenIn`). Each key's context crop is taken from an own self-served
server (`QA_PORT`, default 4197, `client/dist` built) through the same step as
the acceptance run (`client/scripts/lib/scene-step.mjs`, `openStep`): the
fixture, a «Обычная» party on its own sid, paused, `open` clicked, the red
`?debug=1` frames switched off with `btn.debug`, zoom `scale` (`1.4`); the
place is the union of the `ids` nodes (`itd.nodes()`) and the scene's images
whose texture key matches `textures` and crosses that union, plus `pad` (24)
world px. A key missing from `sprites.json` is a warning, not a refusal — the
job may come before the game side. `--dry-run` sends nothing and needs no
token: it prints the body with each crop as its size and sha256 and writes the
crops, `payload.json` and `profile.txt` to `<out>` (default
`client/.qa/sprite-job/<about>/`, gitignored). A real run refuses when
`graphics.md` or `sprites.json` have uncommitted changes (the profile would not
match its `version`; `--allow-dirty` is for stub runs and adds `+dirty`),
prints where the address and token came from, `POST /jobs` with the
coordinator's token (`createJob`), checks every key is `open` and writes
`<spec>.task.json` next to the spec — `taskId`, the profile's version and
sha256, the spec's sha256, the keys, the crops' sizes and sha256 — for the
later `qa:sprite`/`sprite:take`. With that record present a second run refuses:
one job per spec. First job: `scripts/sprites/minipc/jobs/ITGAME-134.json` →
task 4 (the spec, «Порядок», step 5).

**Acceptance run.** `npm run qa:sprite -- --task <id> [--key <k>] [--dry]
[--out <dir>]` (self-serve on :4195, `client/dist` built beforehand): for every
job key in `final` it walks each `seenIn` step at zoom 1× and 1.4×, takes the
linters (`contrast`, `tiny`, `overlaps`, `offscreen`) on the original texture,
`pull`s the final revision, takes them again and saves a crop of the place
(the key's objects plus 32 px). A finding counts as new by its string fields
(scene, kind, the pair), not by its numbers, and counts toward the verdict
only inside the key's place (same scene, crossing the key's world bounds
+4 px): the swap keeps every object's display size, and `contrast()`/`tiny()`
see neither textures nor positions, so whatever shows up elsewhere (a toast, a
plate) is noise of the frame — kept in the report as `noise`, never a
`returned`, which minipc cannot take back. Today the verdict therefore rests
mostly on the contract. Verdict: `accepted` when the contract is clean and
nothing is new in the place, otherwise `returned` with the reason and the
first crop as `cropPng`. The reason is clipped to 1000 bytes of UTF-8 —
minipc's limit is bytes, a Russian reason of 900 characters would be ~1800
and refused with 422. `--dry` posts nothing. The report goes to
`client/.qa/sprite/<task>/report.json` with the crops (gitignored); a run
merges into it by key, so `--key A` keeps an earlier verdict for B. Exit 1
means no verdict could be given — minipc or the server refused, the key is not
in the manifest, has no `seenIn` or is not drawn where `seenIn` says: our side,
nothing is posted.

**Into the repo.** `npm run sprite:take -- --task <id> --key <k> --rev <N>`
checks three matches at once — the file's sha256 equals the report's, the
revision is the key's current final, the key is `accepted` — and refuses
naming every mismatch with the files untouched. Then it writes
`client/public/assets/sprites/<key>.png`, sets the `minipc: задание …` tail of
the key's `note` in `sprites.json` and keeps the reason before it (a text edit,
the file's hand formatting stays), writes the
provenance to `scripts/sprites/minipc/<key>.json` (job, `about`, revision,
sha256, `origin` — seed and prompt or the edited revision —, the profile's
version and sha256, the run's time and commit), runs `check:sprites` (a
failure rolls all three files back), then `npm run build` and `visreg`
(`--no-visreg` skips them; a visreg diff where the key is visible is expected
— update the baselines knowingly; exit 2 names whether the build or visreg
failed). After the commit, `npm run sprite:take -- --task <id> --key <k> --rev
<N> --committed` checks that `HEAD` holds that PNG with the revision's sha256
and that minipc still has the key `accepted` with this revision as its final
(a newer revision since the take refuses), then posts `committed` with the
`HEAD` hash. minipc takes any non-empty reason for `committed` and the status
is terminal, so the client lib refuses to send a `committed` whose reason is
not a 7–40 hex hash. No key
of the pipeline has derived states yet (`sprite-recolor`), so take builds none.

**Stub.** `client/scripts/lib/minipc-stub.mjs` serves the same routes, token
roles, status machine and answer shapes as minipc from memory: `node
client/scripts/lib/minipc-stub.mjs [--port 4199]` prints the three variables
to export; `jobBody(keys)` gives a job body the real minipc would accept.

**Real minipc vs the stub's first guess** (checked live 20.10, ITGAME-182; the
stub and the readers now follow the real one, the readers still take the old
forms):

- `GET /jobs/{taskId}` — `{taskId, about, profile, class, created_at, items:
  [{key, brief, ctx: {text, bg}, status, status_at, revisions, latest: {rev,
  sha256} | null, final: … | null}]}`: `ctx`, not `context` (the POST body
  keeps `context`; its `cropPng` is stored and never returned), `created_at`
  instead of `createdAt`, plus `status_at` and `revisions` (a count). `POST
  /jobs` answers 201 with the same shape.
- `GET /jobs` — `{items: [{taskId, about, created_at, keys}]}`, `keys` a count;
  the stub returned an array of full jobs.
- `GET /jobs/{taskId}` lists the keys in alphabetical order; the `POST /jobs`
  answer keeps the body's order (seen on job 4).
- `POST /jobs` checks the body: `about` `[A-Za-z0-9.-]` up to 32 bytes,
  `profile.sha256` 64 hex, `class` with integers `screenPx`/`sourcePx`, 1–64
  unique 6-hex colours, keys `[a-z0-9][a-z0-9_-]*` unique, `brief` up to 500
  bytes, `context.cropPng` strict base64 of a PNG ≤ 2 MiB — each a 422 with the
  field.
- `GET …/revisions` — wrapped: `{taskId, key, items: [{rev, sha256, origin,
  size, created_at}]}`; the stub's bare array made `sprite:take` read it with
  `.find` — against minipc the provenance would have lost `origin` silently.
  A key without revisions answers 404 («has no revisions yet»), not `[]`.
- `POST …/revisions` → 201 `{taskId, key, rev, sha256, origin}`; `origin`
  defaults to `{kind: edited, from: null}` (a bootstrap revision has no
  `from`); `generated` needs `X-Sprite-Seed` and `X-Sprite-Prompt`; only the
  PNG signature is checked. Header values are bytes: a non-ASCII prompt does
  not fit `X-Sprite-Prompt` as is.
- `POST …/final` → `{key, status, final_rev}`; an unknown revision is 404, a
  key without revisions 409; a pick is allowed from `draft` or `final` only
  (`returned`/`accepted` need a new revision first).
- A new revision returns the key to `draft` but keeps the `final` pointer (the
  stub cleared it): a refusal of `sprite:take` after a newer revision rests on
  the status, not on the pointer.
- `POST …/status` → `{key, status}`; `returned` needs a reason, `accepted`
  does not, `committed` needs any non-empty reason (no hash check — the stub
  had one); reason ≤ 1000 bytes; `cropPng` only on `returned`, strict base64
  of a PNG ≤ 2 MiB; a body that is not JSON is 400.
- Refusals are `{error, field?}` (422 with `field` for a bad body), 401
  `{error: "unauthorized"}`, 403 `{error: "forbidden", detail: "the itgame-cli
  token is required for this handle"}`, 404 texts like «task N not found»,
  «key 'k' not found in the job», «revision N of 'k' not found». A path
  outside the routes (`taskId`/`rev` not a number, a key with capitals, a
  wrong base) is an HTML page 404.

Against the real one (20.10): `itd.sprite.pull`/`watch` on job 1 through a
self-served server with the itgame-go token, `qa:sprite` → `accepted` and
`sprite:take`'s three matches on rehearsal job 3 (the spec, «Порядок», step 5).
