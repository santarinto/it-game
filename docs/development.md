# Development

Operations and testing reference. What the game is and how to run it — see
the README; game design — `docs/design/gdd.md`.

## Deploy

Production runs on a single box: nginx (TLS, static files, `/ws`) → Go
binary on `127.0.0.1:8080`, systemd unit `itgame`. `/admin` is not exposed
on the public domain: the proxy in front (outside this repo) answers
`404 {"detail":"not_exposed"}` with or without credentials (checked
2026-10-09); the Go handler itself has no auth, and `deploy-local.sh`
probes it on `127.0.0.1:8080`.

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

The start menu reads the save's facts through `/ws?peek=1&sid=…`
(ITGAME-19): the server sends one `save_summary` (`exists`, `alive`,
`day`, `money`, `difficulty`, `outcome` won/lost, `reason`) and closes
the socket. It counts missed time offline the same way a reconnect does,
but on a copy: nothing is written, no session is taken over. It rides on
`/ws` because that is the only path production nginx proxies to Go —
`/api/*` there falls through to the SPA's `index.html`. The menu shows
«ПРОДОЛЖИТЬ — День 3 · $60 · НОРМА» for a live save, «ИТОГ: …» for a
game that ended while the player was away, hides the card when the
server has no save, and asks for confirmation before a new game
overwrites a live one.

Save directory: `-saves` flag → `ITGAME_SAVES_DIR` →
`/opt/itgame/shared/saves` (if it exists) → `./saves`. `-saves off` runs
stateless. Expired saves are purged on start and on access.

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
  FIFO receipts and work as before.
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
anything. It's off by default and **not** set in production
(`bin/deploy-local.sh`, systemd unit) or in the CI production smoke step;
it's set only where local/CI tooling needs it: `make dev`/`dev-server`,
`client/scripts/lib/selfserve.mjs` (all QA scripts and `visreg` that
build and self-serve `bin/itdirector` — see the QA table below), and the CI `client`
job's "Go-сервер над dist" step (`OFFICE=1 smoke-ui` doesn't itself call
`/api/debug/*` or `/ws/agent`, but the flag is set anyway for consistency
with the other self-served runs). If you start the server by hand for
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

    {"k":"start","seq":1,"rev":1,"day":1,"tick":0,"money":600,"phase":"running","speed":1,"h":"81614dc3d1bbdadf"}
    {"k":"cmd","seq":3,"tk":3,"rev":6,"day":1,"tick":3,"money":25,"phase":"running","speed":3,"h":"13751fcfb18e068b","id":2,"type":"buy_pc"}
    {"k":"cmd","seq":5,"rev":6,"day":1,"tick":3,"money":25,"phase":"running","speed":3,"h":"13751fcfb18e068b","id":4,"type":"fire","slot":9,"err":"bad_slot"}
    {"k":"debug","seq":6,"rev":7,"day":1,"tick":23,"money":25,"phase":"running","speed":3,"h":"00149c339a48dd8b","op":"advance","ticks":20}
    {"k":"end","seq":7,"tk":2,"rev":9,"day":1,"tick":25,"money":25,"phase":"running","speed":3,"h":"d124dc5eecb4b816"}
    {"k":"resume","seq":8,"rev":10,"day":1,"tick":30,…,"h":"63f852f5e117e4eb","pre":"d124dc5eecb4b816","offline":5,"saveSpeed":3,"save":{…}}

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
  with `err` — the replayer checks the rejection reproduces. `debug` — only
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
  exactly the state at this `end`).
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
`soft_lock`, `pre_victory`, `spare_pcs`, `broken_pc`. `broken_pc`
(ITGAME-74): day 4, 11:00, three employees in office 1, all online, slot 0's
PC broken (0/3 repair clicks) — the only way to get a broken PC on demand
(breakdowns roll at random; at most one per office, so no second one appears).

**«Админка» link** (ITGAME-22): shown over the canvas only to the owner —
always under `?debug=1`, otherwise gated by `localStorage.itd.admin` (set
once via `?admin=1`, cleared via `?admin=0`; the `admin` query param is
stripped immediately after reading, so a shared link with the flag doesn't
linger in the URL). Cosmetic only: `/admin` is not exposed on the public
domain regardless (see [Deploy](#deploy)).

**Build stamp and «устарело, обнови»** (ITGAME-78): the same `#topbar` shows
the tab's own build sha (`#build`, = `itd.version.sha`) left of «Админка».
`client/src/buildstamp.ts` compares it with the build the stand would serve on
reload — the sha in `<meta name="build">` of a fresh `GET /` — and, if that is
missing, with the server binary's sha (`GET /api/version` → `{sha}`, public,
`no-store`; `vcs.revision` of `go build`, `unknown` under `go run`). On a
mismatch a red «устарело, обнови» button (`#stale`, click reloads,
`#topbar[data-stale]`) appears. Checks run on load, after a socket reconnect
(a stand restart drops WS), on returning to the tab and once a minute while it
is visible. `await itd.stale()` runs a fresh check and answers `{client,
server, dist, stale, at}`; `stale: null` means there is nothing to compare
(vite dev serves no meta and hot-reloads anyway; a build without git reads
`dev`, see [Deploy](#deploy) — on production nginx `/api/*` also falls
through to the SPA). `itd.screen().meta.stale` carries the last result.

`itd.help()` prints the full command reference in the console. Worth
documenting separately:

- **`itd.nodes()` / `itd.ids()`** — every object of the live scenes
  (`{scene, type, id, text, x, y, w, h, cx, cy, visible, alpha, interactive,
  depth, active}`) / just the stable interactive ids (`btn.*`, `nav.*`, `office.*`,
  `room.*`, `menu.*`, `modal.*`). `active` (ITGAME-38) is a
  `setData('active', …)` flag scenes set on toggle-like objects (speed
  buttons, nav tabs, the debug toggle, checkboxes, zoom) — distinct from
  Phaser's own `GameObject.active` — `null` for anything that isn't a
  toggle. `x`/`y` is the object's position by its origin (top-left for HUD
  plates, centre for texts and some modal buttons), so for a real click use
  `cx`/`cy` — the centre of the world bounds (acceptance 10.10).
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
  one call: `{meta, n, items}`. `meta` is `sha`, `tab` (sid prefix), the
  server's `day`/`clock`/`t`/`bal`/`speed`/`phase`/`staff`/`pay`, what the HUD
  actually draws (`hudClock`, `hudBal`), `blocker` (`safe` or scene `@depth`)
  and `title` (the topmost `markTitle()` object: modal and report backdrops,
  the event card, the disconnect screen). Each item is a string
  `'safe|label|x|y|flags'` (25 items of a day report fit in ~1000 characters
  of a tool answer): the label is the texts inside the bounds (≤ 22 chars,
  `-` for icons), `x`/`y` the bounds centre in CSS px of the window (from the
  canvas' `getBoundingClientRect`, so zoom, «по окну» and `#topbar` are
  included), or in a screenshot frame `frame` px wide. Flags: `A` — active
  toggle, `X` — covered (`hit()` not ok), `D` — disabled: `markDisabled()`,
  set by the HUD buy/hire buttons (`btn.pc`, `btn.hire`, `btn.boss`,
  `btn.gateway`) when money/seats/PCs are missing, also `nodes().disabled`.
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
  the one that took the click), `wins` is who gets `pointerdown`.
  `zones(a, b)` walks a 1 px grid over the union of both bounds and returns
  `aUnderB`/`bUnderA` rectangles — where the point is in A's hit area but B
  takes the click, and vice versa — plus `area` in px² (`a`, `aUnderB`, `b`,
  `bUnderA`). Example: on `broken_pc`, `itd.zones('office:repair:0',
  'office:worker:0').area.bUnderA === area.b` — the worker is covered whole.
- **`itd.offline()`** — the page's last offline catch-up `{ticks, days,
  shown, at, droppedAt, leftAt, liveTicks, open, paused}` or `null` (`open` —
  the window is on screen now, `paused` — session speed is 0 now).
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
  `itd.offline()` after the return (`droppedAt` = when the server noticed) or
  `null` when there was no catch-up (the server had not noticed before the
  return, or the party was paused). Codes: `bad_sec`, `bad_mode`,
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
  `itd.sid`/`itd.diff` and the tab's `sessionStorage` `itd.sid`/`itd.sid.auto`
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
- **`itd.cmd('abandon')`** goes the «Сдаться» button's way
  (`HUDScene.abandonParty`: delete the save, back to the menu). A bare
  `abandon` frame let the client reconnect, and the server started a new
  party under the same sid (retro 10.10).
- **`safe` ids** — `ids()`/`nodes()` also carry `safe`, the id with `:`
  instead of dots (game ids have no colons, so it is reversible):
  the browser agent's tool blocks `a.b.c` strings as JWTs. `click`, `hover`
  and `hit` accept either form.
- **`itd.overlaps()`** — the layout linter; each finding carries a `kind`
  (ITGAME-38): `text` (two same-depth texts), `occlusion` (text under an
  opaque plate), or `interactive` (an interactive container/sprite/checkbox
  partly covered by another interactive or by text — full containment
  doesn't count). Every finding also carries `ratio` (intersection area over
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
- **`itd.log(n)`** — the ring buffer (200 entries, survives a console
  clear) of state/day/phase/speed/scene transitions, server errors and page
  errors, plus, since ITGAME-38, every `playSfx` call and HUD toast
  (`{type:'sound', key, name, volume, scene, ok}` /
  `{type:'toast', text, where, ms, bg, scene}`), routed through
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
  purchasesTotal − payroll − gatewayOpex − interest + adjust = balanceEnd`,
  exactly (`balanced`). The book is written where `Money` changes
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
  compiler API into the committed `client/src/debug/contract.gen.ts` —
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
| `npm run qa:meta` | stats/achievements modals | :4173, `vite preview` — needs a Go server already on :8080 |
| `npm run qa:buttons` | HUD buy-button enabled/tooltip/alpha states (ITGAME-17) | :4180, self-serve |
| `npm run qa:tabs` | multi-tab session takeover (ITGAME-35) | :4179, self-serve + temp saves dir |
| `npm run qa:hud` | HUD layout column, toast stack, no overlaps (ITGAME-16) | :4174, self-serve |
| `npm run qa:facade` | `window.itd` `active`/`log()`/`overlaps()` kind (ITGAME-38); HUD `+X/день` = the day's profit on `mid_day10` (ITGAME-49); `itd.step({ticks})` advances > 10 ticks per call (ITGAME-56); UI-scale ids/cycle and a stored 2× → «по окну»; canvas-vs-window `offscreen()` entry (ITGAME-61); a throwing `localStorage` for `itd.uiScale` neither breaks the load nor the zoom choice (ITGAME-67); ⏸ on pause is an amber block, speed(1) restores it (ITGAME-62); `itd.screen()` on the day report — title, blocker, `X`/`free`/`frame`, `D` on a buy button without money (ITGAME-72); build stamp and «устарело, обнови» on a faked stand `index.html`, `itd.stale()` (ITGAME-78); `itd.sandbox()`: the owner's shared key survives «Сдаться» and a second party, `fakeOwner()`, `restore()` puts back / keeps (ITGAME-77); `itd.stack()` under the day report: the dimmer wins over `btn.menu`, same as `hit().top` (ITGAME-74); `hit()` and the `X` flag follow the real hit area — a 1×1 hitArea on `btn.next_day` makes it covered (owner 10.10); `itd.play()` on `fresh` (seed 7): hire → hire `FAIL no_free_pc` → day → buy_pc → hire `FAIL not_enough_money` → day with the balances 600>300>614>39>353, `itd.ledger()` books balanced, `adjust` after `itd.set` (ITGAME-73) | :4175, self-serve |
| `npm run qa:slots` | office/server-room slot rendering — lunch, boss, gateway, router, amenities, racks; `broken_pc`: the repair zone covers the worker and the «✖ чинить» label, real clicks repair (ITGAME-75) | :4177, self-serve |
| `npm run qa:trace` | `itd.trace()` live window (ITGAME-37); receipts by command id — `id`/`rev` in `cmd()`, `trace().sent`/`states`, `net()`, and no false receipt with a tick or an observer's (`/ws/agent`) snapshot in flight (ITGAME-45) | :4176, self-serve |
| `npm run qa:contract` | `itd.contract()` shape/hash (ITGAME-39) | :4178, self-serve |
| `npm run qa:party` | two parties in one tab: fresh party after leaving in a locked office / fast exit opens office 0, nav works, buy not `office_locked`; «Continue» keeps sid/day/money (ITGAME-47); expired save on «Continue» and `itd.scenario()` from Office 2 land in office 0 (ITGAME-54/55); overlays/report pause after `itd.scenario()` incl. from the finale, `itd.restore()` locking the active office (ITGAME-64/63); explicit exit freezes the party: the exit dialog pauses, Отмена/Esc/✕ restore the speed, «Сохранить и выйти» → «Продолжить» keeps tick/day/money and the speed, also from an open day report (ITGAME-65); on the victory screen (storage sid cleared) `itd.server().sid`/`liveSid` stay the live party's sid (ITGAME-68); office/server-room windows (router, fire dialog via a real right click on `broken_pc`, core, rack) close on `itd.scenario()`/`itd.restore()`, a click where «Уволить» was sends nothing (ITGAME-69); A1–A7 `itd.away` (ITGAME-76): `close` — while away the socket is `reconnecting`, commands `not_connected`, the server session is gone at once, the return resumes the same sid with `droppedAt` ≈ `leftAt`; `net` with `timeout: 1500` — the server session lives (200) until its read timeout and is gone (404) after, `droppedAt − drop.at` ≈ 1.5 s, `liveTicks` ≈ 3 at 2x, catch-up from `droppedAt`; `net` shorter than the timeout — no catch-up, ticks ran live; the owner key untouched; inside `itd.sandbox` the return lands in the sandbox party | :4181, self-serve + temp saves dir |
| `npm run qa:report-pause` | the day report pauses the party (speed 0, time and balance stand still); Enter/Space/`btn.next_day`/`itd.cmd('next_day')` restore the pre-report speed; F5 with the report open keeps `itd.speedBeforeReport`, «Продолжить» reopens it paused and closing restores 3×; an outside `itd.speed(0)` over the report survives; `itd.set({tickInDay})` refused in `day_report`; `skipReports` changes the day without a modal or a stuck 0 (ITGAME-18, self-serve since ITGAME-70) | :4182, self-serve + temp saves dir |
| `npm run qa:journal` | the journal of a live browser party (HUD clicks, `itd.cmd`, a rejection, `itd.set`/`itd.step`, F5 → «Продолжить» with offline catch-up) from `/api/debug/journal` replays with `cmd/replay -json` without divergence or warnings, and the replayed save equals the live one (ITGAME-46) | :4186, self-serve + temp saves dir |
| `npm run smoke-ui` | menu boots, clean console; `OFFICE=1` + live WS → office scene | :4173, `vite preview` |
| `npm run visreg` | screenshot diff + layout linter per fixture scenario | :4173, self-serve, `VISREG_PORT` overrides |

`qa:buttons`/`qa:hud`/`qa:facade`/`qa:slots`/`qa:trace`/`qa:contract`/`qa:tabs`/
`qa:party`/`qa:report-pause`/`qa:journal`/`visreg` share `client/scripts/lib/selfserve.mjs`: it rebuilds `bin/itdirector` on every
run (`go build` into a temp file, then an atomic rename — a no-op relink takes
under 1 s, so QA never runs against a binary older than `server/`) and runs it
over `client/dist`, refuses WHATWG bad ports (e.g. 4190, 6000 — fetch and
Chromium won't connect) before spawning, refuses to start when its port is already taken by
another process, and verifies after boot that the server actually answers
with the local `client/dist` build (not someone else's) — a busy port fails
loudly instead of running the suite against the wrong server. It also sets
`ITGAME_DEBUG=1` on the spawned `bin/itdirector` (see [Agent bridge](
#agent-bridge-wsagent)), since `itd.set()`/`itd.step()`/`itd.advanceDays()`/… — used by
`qa:buttons`, `qa:hud`, `qa:trace`, `qa:facade`, `qa:slots`, `qa:party`, `qa:report-pause` — need `/api/debug/*`
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
Policies: `greedy`, `idle`, `random`. CSV:
`policy,seed,day,money,income,payroll,events,outcome`, one row per day;
the last row holds the outcome (`bankrupt | deadlock | victory | time_up |
timeout`). `--events-text` writes the event names joined by `" | "` into
the `events` column instead of their count, `--audit-share <f>` overrides
the audit fine share (`AuditFineShare`; `-1` keeps the config value) and
`--audit-stats` prints one extra stderr line with the bankruptcies on a
failed-audit day versus all bankruptcies and failed audits. Reference
(300 seeds × 30 days, greedy): normal 0/300 bankrupt, easy 300/300 wins,
hard 0/300 bankrupt, hardcore 19/300 bankrupt.

**visreg** loads each fixture scenario (`?scenario=X&seed=1&debug=1`) and the
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
menu). Emoji (achievement icons, 🏆📊🔒⚠️) still come from the system emoji
font. The committed baseline (9 scenarios, `broken_pc` included) was
regenerated **2026-10-10** on the pinned Chrome for Testing 152.0.7977.54
(headless, SwiftShader software GL, Arch Linux, Noto Color Emoji); two
consecutive runs without `--update` gave 0 differing pixels on every scenario.
The layout-linter counts in `baseline.json` did not change with the font.
Another machine may still differ by GPU rasterizer or emoji font.
Kill stray Chromium processes before a run — they starve software WebGL.
In CI, visreg is a report, not a gate (see [CI](#ci)).

## CI

`.github/workflows/ci.yml` runs on pull requests, pushes to `main` and
manual dispatch:

- **server** — `go vet`, `go test` with a Postgres 16 service container,
  sim report in the job summary (non-blocking);
- **client** — `npm ci`, `npm run browser:install` (the pinned Chrome for
  Testing, cached by `actions/cache` keyed on `client/scripts/lib/chrome.mjs`
  — not the runner's own Chrome), typecheck, build, menu smoke test, then the Go
  server over `dist` (with `ITGAME_DEBUG=1`, matching local self-serve —
  see [Agent bridge](#agent-bridge-wsagent)): office smoke test,
  `live-check-saves` and `live-check-difficulty2`;
- **visreg** — on the same pinned Chrome; report only; on mismatch it uploads
  screenshots taken on the runner (`visreg-ci-shots`) that can be adopted as baselines before
  making the job blocking;
- **deploy** — see [Deploy](#deploy).

## Claude Code cloud sessions

`.claude/hooks/session-start.sh` (runs only when `CLAUDE_CODE_REMOTE=true`)
prepares a fresh container: Go modules, `npm ci`, `npm run browser:install`
(falling back to the image's Playwright Chromium via `CHROME_PATH`), and a
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
semi-transparent pixels, too much `#f4f4f4`, and noise — 8-connected
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
repair zone `office.repair.0` covers the whole visible breakdown — the worker
frame and the «✖ чинить N/3» label above it, and the blinking highlight is
that zone itself (ITGAME-75): `itd.stack` wins it
at the label, the gap, the worker's top strip and corners, `itd.zones` says
the worker is covered whole, real mouse clicks there send exactly one
`repair_click` (not `motivate`, not nothing), right click opens the fire
dialog, three clicks repair and the worker takes clicks again; the server
room's occupied racks and core draw `rack_server` with no layout-linter
findings (`itd.overlaps()`/`itd.offscreen()`), and — on `mid_day10`, whose
one unlocked office has fewer servers than rack slots — empty racks draw
`rack_empty`, the first empty one carries the "place a server here" tint,
and closed offices' racks render `rack_empty` dimmed with no tint. On
`spare_pcs` (more PCs than hires, added for this exact gap), it also checks
the desk-only states full offices never exercise: a bought PC with no
employee draws `desk_pc_off`, and a slot with no PC at all draws
`desk_empty`.
