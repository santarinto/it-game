# Action points — the director's working day limits hand repair

Tracker: ITGAME-127. Design approved by the owner on 21.10.2026. Related: ITGAME-118 (bankruptcy forecast),
ITGAME-101 (admins), ITGAME-103 (virus), ITGAME-135 (wear, PC replacement), ITGAME-174 (incompatible save window),
ITGAME-205 (growing the pool — blocked by this task, out of scope here).

## Problem

Hand repair is free and unlimited: `RepairClick` counts clicks up to `RepairTarget()` (3..15) and nothing else, and
`VirusClick` is the same for infected places. The master ($150) and the admins compete with a free option, and a
broken PC is never a real loss while the player is at the screen. The owner (16.10): the player gets personal action
points, «like a manager's working time», 8 by default.

## Decisions taken with the owner

- **8 points per day, refilled in the morning**, not carried over. The same on every difficulty for now.
- **A point starts an action; the clicks after it are free.** Starting the repair of a place costs 1 point, starting
  to clean a place from the virus costs 1 point. A broken *and* infected place costs 2 — two actions.
- **Motivation stays free** (owner, brainstorm 21.10 — the 21.10 tracker note had it at 1 point; superseded).
- **A click on a place stays the action**: no confirmation, no card. The cost is shown on the place label.
- **Out of points — the master and the admins remain.** The master ($150), replacing a PC ($500) and the admins cost
  no points.
- **The bankruptcy forecast plays as the best player**: today it fixes as many of the most valuable places as the
  points left allow, then up to 8 more each day; offices with an admin are fixed as before.
- Growing the pool (levels, the director's office upgrades) is ITGAME-205, not this task.

## Rules (server, `internal/game`)

- `Config.ActionPointsPerDay int` = 8 in the base config; `ApplyDifficulty` does not touch it.
- `Game.ActionPoints int`: `NewWithSeed` sets it to `cfg.ActionPointsPerDay`; `NextDay` and the offline
  `resetForNextDay` refill it to `cfg.ActionPointsPerDay` (no carry-over, no cap above it).
- `RepairClick`: after the existing checks (bad slot, dead PC, not broken), if `e.RepairClicks == 0` the click
  starts the repair: `ActionPoints < 1` → `ErrNoActionPoints` (`no_action_points`), nothing changes; otherwise
  `ActionPoints--` and the click proceeds. `RepairClicks > 0` — a repair already started (by the player, by an admin,
  or yesterday: a breakdown survives the night) — continues for free.
- `VirusClick`: the same on `e.VirusClicks == 0`.
- `Motivate`, `CallMaster`, `ReplacePC`, admin work (`adminWork`) — unchanged, no points.
- Commands keep working on pause, as now.

## Save and protocol

- `SaveFormat` 3 → 4: `Config.ActionPointsPerDay` and `Save.ActionPoints` (`actionPoints`) are new fields of the
  save file. Update `testdata/save_shape.txt` (TestSaveShape); the format comment gets a line «4 — ITGAME-127».
  Parties of format 3 hit the ITGAME-174 «save incompatible» window, by the owner's 18.10 rule.
- Snapshot (`ws/protocol.go`): `actionPoints` and `actionPointsMax` (= `cfg.ActionPointsPerDay`), mirrored in
  `client/src/protocol.ts`. `contract.gen.ts` is generated from `ItdApi`, not from the protocol; the build runs
  `gen-contract.mjs --check`, and if it reports drift — `npm run gen:contract`.

## Client

- HUD header, left block: «Очки: 6/8» in the money row, right of the sum (a fifth row would not fit `HUD_H`);
  red (`#b13e53`) at 0.
- Place label in `OfficeScene`: a broken place whose repair is not started reads «✖ чинить · 1 очко»; once started —
  «✖ чинить k/N» as now. An infected place — the same with its own verb. The place tooltip gets «начать ремонт —
  1 очко действий» (and the virus line likewise) while the action is not started.
- Error toast `no_action_points`: «Очки действий кончились — мастер или админ; утром очки восполнятся» (no
  number: ITGAME-205 will grow the pool).
- The click routing (`repair_click` / `virus_click` / `motivate` by state) does not change.

## Bankruptcy forecast (`BankruptInDays`, ITGAME-118)

Today the template clears `PCBroken` and `Infected` everywhere. New rule:

1. In offices with an admin every broken/infected place counts as fixed, as now (the admin works for free).
2. Elsewhere build a queue of items `(place, kind)`, `kind` ∈ {repair, virus}. An item already started
   (`RepairClicks > 0` / `VirusClicks > 0`) costs nothing and counts as fixed today. The rest are ordered by what
   the fix returns, descending: a repair — the place's personal output (the `clean` term of `incomeAtTickDetail`:
   income + level bonus, × raise, × PC level; on an infected place a repair returns only output × `VirusMult`, the
   rest is the cleanup's), a cleanup — the share the virus takes, output × (1 − `VirusMult`).
   Ties keep office, slot, repair before virus.
3. Today: the first `g.ActionPoints` items are fixed for the rest of today. Each next morning another
   `cfg.ActionPointsPerDay` items are fixed. While the queue is not empty the day's income is computed from a
   template with the remaining items still broken/infected; once it is empty the income is the constant `dayExact`
   as now.
4. Money is negative whenever the forecast runs, so the master is never assumed.

The doc comment of `BankruptInDays` is rewritten to say this instead of «ремонт и чистка кликами бесплатны».

## Sim

`cmd/sim/policy.go` already `break`s on a refused click, so the greedy policy simply stops repairing when points run
out; its comment «клики бесплатны» is corrected. Run `make sim` on the same seeds before and after and report how
the points move win rate and bankruptcies — information for the owner, not a gate.

## Tests

- `internal/game`: a repair start takes a point; continuing clicks are free; a repair started by an admin or the day
  before is free; zero points → `no_action_points` and the place is unchanged; the same for virus; a broken+infected
  place takes 2; motivation, master and replacement take none; `NextDay` and the offline day refill to 8 without
  carry-over.
- Forecast: with points enough nothing changes against today's numbers; with more broken places than points the
  forecast is worse (fewer days or doomed where it was not); an office with an admin is unaffected by points.
- Save: `TestSaveShape` with the new slice; a round trip keeps `ActionPoints`.
- `ws`: the snapshot carries `actionPoints` / `actionPointsMax`.
- Gates: `make test`, `make typecheck`, `make smoke-ui` (on its own server, not the stand).

## Delivery

The result is visible (HUD line, labels, toast), so the task goes to `qa` with acceptance steps for the browser
agent on the stand.
