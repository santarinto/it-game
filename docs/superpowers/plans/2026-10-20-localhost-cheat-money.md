# Localhost money cheat (`cheat.money()`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On localhost only, `cheat.money()` in the browser console adds $10 000 to the tab's live party (`cheat.money(n)` adds $n). It works without `?debug=1` and without `ITGAME_DEBUG=1`. The design is in tracker task ITGAME-194, approved by the owner on 20.10.2026.

**Architecture:** A new HTTP route, `POST /api/cheat/money {sid, amount}`, is registered in every build. It refuses with 403 any request that is not local: RemoteAddr must be loopback, Host must be localhost-like, and the request must carry no proxy headers. A local request goes to the party actor as a new debug request kind. The actor's loop turns that kind into an ordinary `kindPatch` with the absolute balance, so the snapshot push, the persist step and the replay journal reuse the existing `itd.set({money})` path untouched. On the client, a global `cheat` is installed only when `location.hostname` is local, in every build.

**Tech Stack:** Go 1.x `net/http` (server/internal/ws, cmd/server); TypeScript client (Vite, Phaser); Node 26 `node --test` running `.ts` sources directly.

## Global Constraints

- Local means **all three** conditions: RemoteAddr is a loopback IP; the `Host` hostname is `localhost`, `127.0.0.1`, `::1` or `*.localhost`; and none of the headers `X-Real-IP`, `X-Forwarded-For`, `Forwarded` is present. Otherwise the route answers `403 {"error":"not_local: …"}`.
- Why the third condition matters: prod nginx (minipc `deploy/itgame/nginx/proxy-ws-itgame.inc`) always sets `X-Real-IP` on `/api/` and `/ws`, and proxies to `127.0.0.1`. That header is the only thing that tells a prod player apart from a local tab.
- `amount` is an integer from 1 to 10 000 000, otherwise `400`. The client default is 10 000.
- The route is registered regardless of `ITGAME_DEBUG`. It must not live under `/api/debug/`, which exists only with `ITGAME_DEBUG=1`.
- The client global `cheat` is installed in dev and prod builds alike, without `?debug=1`, only on a local hostname. On other hosts `window.cheat` is `undefined`.
- Error texts and comments are in Russian, matching the surrounding code. Commits follow the house style (`feat(…): … — ITGAME-194`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Server — `POST /api/cheat/money` with the local-only gate

**Files:**
- Create: `server/internal/ws/cheat.go`
- Create: `server/internal/ws/cheat_test.go`
- Modify: `server/internal/ws/debug.go` (const block of request kinds ~line 71; `debugRequest` struct ~line 84)
- Modify: `server/internal/ws/session.go:508` (the `case req := <-debugC:` branch)
- Modify: `server/cmd/server/main.go:134-146` (`newMux`, register the route outside the `if debugRoutes` block)
- Modify: `server/cmd/server/main_test.go` (route alive without debug)

**Interfaces:**
- Produces: `func (h *Handler) ServeCheat(w http.ResponseWriter, r *http.Request)`; `func localRequest(r *http.Request) bool`; const `kindCheatMoney = "cheat_money"`; field `debugRequest.add int`; HTTP contract `POST /api/cheat/money` with body `{"sid": string, "amount": int}`. Success: `200` with the same body as `/api/debug/state` POST (`{"sid", "state": {..., "money": int}, "save": {...}}`). Errors: `{"error": string}` with 403, 400, 404 or 504.

- [ ] **Step 1: Write the failing tests** — `server/internal/ws/cheat_test.go`

```go
package ws

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
)

// Чит денег для localhost (ITGAME-194): только локальный запрос, без ITGAME_DEBUG.
func TestLocalRequest(t *testing.T) {
	req := func(remote, host string, hdr ...string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/cheat/money", nil)
		r.RemoteAddr, r.Host = remote, host
		for i := 0; i+1 < len(hdr); i += 2 {
			r.Header.Set(hdr[i], hdr[i+1])
		}
		return r
	}
	for _, tc := range []struct {
		name string
		r    *http.Request
		want bool
	}{
		{"127.0.0.1 с портом", req("127.0.0.1:5555", "127.0.0.1:15555"), true},
		{"localhost", req("127.0.0.1:5555", "localhost:15555"), true},
		{"::1", req("[::1]:5555", "[::1]:15555"), true},
		{"*.localhost без порта", req("127.0.0.1:5555", "itgame.localhost"), true},
		{"прод через nginx: X-Real-IP", req("127.0.0.1:5555", "itgame.santarinto.ru", "X-Real-IP", "203.0.113.7"), false},
		{"подделанный Host за nginx", req("127.0.0.1:5555", "localhost", "X-Real-IP", "203.0.113.7"), false},
		{"X-Forwarded-For", req("127.0.0.1:5555", "localhost", "X-Forwarded-For", "203.0.113.7"), false},
		{"Forwarded", req("127.0.0.1:5555", "localhost", "Forwarded", "for=203.0.113.7"), false},
		{"чужой Host", req("127.0.0.1:5555", "itgame.santarinto.ru"), false},
		{"не loopback", req("192.0.2.10:5555", "localhost:15555"), false},
		{"localhost.evil.com", req("127.0.0.1:5555", "localhost.evil.com"), false},
	} {
		if got := localRequest(tc.r); got != tc.want {
			t.Errorf("%s: localRequest = %v, ждали %v", tc.name, got, tc.want)
		}
	}
}

// Сервер без /api/debug/* — только /ws и чит, как newMux без ITGAME_DEBUG.
func startCheatServer(t *testing.T, cfg game.Config) string {
	t.Helper()
	h := &Handler{Config: cfg, TickInterval: time.Hour}
	mux := http.NewServeMux()
	mux.Handle("GET /ws", h)
	mux.Handle("POST /api/cheat/money", http.HandlerFunc(h.ServeCheat))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestCheatMoneyAddsToLiveParty(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.WinTarget = 100_000_000 // чит не выигрывает партию
	base := startCheatServer(t, cfg)
	sid := "cheat-sid-0001"
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(base, "http")+"/ws?sid="+sid, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	var first testMessage
	if err := wsjson.Read(context.Background(), c, &first); err != nil {
		t.Fatalf("первый снапшот: %v", err)
	}

	code, out := httpDebug(t, base, "POST", "/api/cheat/money", fmt.Sprintf(`{"sid":%q,"amount":10000}`, sid))
	if code != 200 {
		t.Fatalf("чит: %d %v", code, out)
	}
	if got := num(t, stateOf(t, out["state"])["money"]); got != cfg.StartMoney+10000 {
		t.Fatalf("баланс после чита %d, ждали %d", got, cfg.StartMoney+10000)
	}
	// второй чит прибавляет к новому балансу, а не ставит сумму
	code, out = httpDebug(t, base, "POST", "/api/cheat/money", fmt.Sprintf(`{"sid":%q,"amount":5}`, sid))
	if code != 200 || num(t, stateOf(t, out["state"])["money"]) != cfg.StartMoney+10005 {
		t.Fatalf("второй чит: %d %v", code, out)
	}
	// вкладка получила снапшот с новым балансом
	deadline := time.Now().Add(3 * time.Second)
	for {
		var m testMessage
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		err := wsjson.Read(ctx, c, &m)
		cancel()
		if err != nil {
			t.Fatalf("снапшот с балансом %d не пришёл: %v", cfg.StartMoney+10005, err)
		}
		if m.Type == "state" && m.Money == cfg.StartMoney+10005 {
			break
		}
	}
}

func TestCheatMoneyRefusals(t *testing.T) {
	base := startCheatServer(t, game.DefaultConfig())
	for _, tc := range []struct {
		body string
		code int
	}{
		{`{"sid":"cheat-sid-0002","amount":0}`, 400},
		{`{"sid":"cheat-sid-0002","amount":-5}`, 400},
		{`{"sid":"cheat-sid-0002","amount":10000001}`, 400},
		{`не json`, 400},
		{`{"sid":"cheat-sid-0002","amount":100}`, 404}, // живой партии нет
	} {
		resp, err := http.Post(base+"/api/cheat/money", "application/json", strings.NewReader(tc.body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.code {
			t.Errorf("%s: %d, ждали %d", tc.body, resp.StatusCode, tc.code)
		}
	}
	// прод за nginx: X-Real-IP — 403 раньше разбора тела
	r, _ := http.NewRequest(http.MethodPost, base+"/api/cheat/money", strings.NewReader(`{"sid":"cheat-sid-0002","amount":100}`))
	r.Header.Set("X-Real-IP", "203.0.113.7")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("с X-Real-IP: %d, ждали 403", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run the tests and confirm they fail to compile**

Run: `cd server && go test ./internal/ws -run 'TestLocalRequest|TestCheatMoney' -count=1`
Expected: build failure: `undefined: localRequest`, `h.ServeCheat undefined`.

- [ ] **Step 3: Implement** — create `server/internal/ws/cheat.go`

```go
package ws

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
)

// Чит денег для localhost (ITGAME-194): POST /api/cheat/money {sid, amount}
// прибавляет amount к балансу живой партии. Маршрут есть всегда, без
// ITGAME_DEBUG, но пускает только локальный запрос (localRequest): прод
// закрыт заголовком X-Real-IP, который nginx бокса ставит на /api/ и /ws.
// Деньги кладёт актор — тем же патчем, что itd.set({money}): снапшот,
// сейв и журнал реплея как у debug-патча (session.go переводит kindCheatMoney
// в kindPatch с абсолютным балансом).

const maxCheatMoney = 10_000_000

// localRequest — запрос с этой же машины напрямую, не через прокси:
// loopback-адрес, Host — localhost, 127.0.0.1, ::1 или *.localhost, и ни
// одного заголовка прокси.
func localRequest(r *http.Request) bool {
	for _, h := range []string{"X-Real-IP", "X-Forwarded-For", "Forwarded"} {
		if r.Header.Get(h) != "" {
			return false
		}
	}
	addr := r.RemoteAddr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		addr = h
	}
	if ip := net.ParseIP(addr); ip == nil || !ip.IsLoopback() {
		return false
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.Trim(host, "[]"))
	return host == "localhost" || host == "127.0.0.1" || host == "::1" || strings.HasSuffix(host, ".localhost")
}

// ServeCheat — POST /api/cheat/money. Отказы — {error} как у /api/debug/*.
func (h *Handler) ServeCheat(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if !localRequest(r) {
		writeDebugErr(w, http.StatusForbidden, "not_local: читы только с localhost")
		return
	}
	var body struct {
		SID    string `json:"sid"`
		Amount int    `json:"amount"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeDebugErr(w, http.StatusBadRequest, "тело не JSON: "+err.Error())
		return
	}
	if body.Amount < 1 || body.Amount > maxCheatMoney {
		writeDebugErr(w, http.StatusBadRequest, "amount — целое 1..10000000")
		return
	}
	rep, _ := h.sendDebug(body.SID, debugRequest{kind: kindCheatMoney, add: body.Amount})
	finishDebug(w, rep)
}
```

Then in `server/internal/ws/debug.go`, add to the kinds const block after `kindPatch`:

```go
	kindCheatMoney = "cheat_money" // +деньги с localhost (ITGAME-194); актор переводит в kindPatch
```

And in the `debugRequest` struct, after `patch debugPatch`:

```go
	add      int             // kind=cheat_money: сколько прибавить к балансу
```

And in `server/internal/ws/session.go`, at the start of `case req := <-debugC:` (before `rev := rv.rev`):

```go
		case req := <-debugC:
			if req.kind == kindCheatMoney {
				// чит (ITGAME-194) — патч с абсолютным балансом: журнал и реплей
				// видят обычный debug-патч, и прибавка считается здесь, в акторе
				money := g.Money + req.add
				req = debugRequest{kind: kindPatch, patch: debugPatch{Money: &money}, Reply: req.Reply}
			}
			rev := rv.rev
```

Run `gofmt -w server/internal/ws/cheat.go server/internal/ws/debug.go server/internal/ws/session.go` (the const block realigns).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd server && go test ./internal/ws -run 'TestLocalRequest|TestCheatMoney' -count=1 -v 2>&1 | tail -15`
Expected: `--- PASS` for `TestLocalRequest`, `TestCheatMoneyAddsToLiveParty`, `TestCheatMoneyRefusals`; `ok itdirector/internal/ws`.

- [ ] **Step 5: Register the route in `newMux` with a test that it lives without debug**

In `server/cmd/server/main.go`, right after `mux.Handle("GET /ws", wsHandler)` (outside `if debugRoutes {`):

```go
	// Чит денег (ITGAME-194): без гейта ITGAME_DEBUG — хендлер сам пускает
	// только запрос с localhost.
	mux.Handle("POST /api/cheat/money", http.HandlerFunc(wsHandler.ServeCheat))
```

Add to `server/cmd/server/main_test.go`:

```go
// Чит денег (ITGAME-194) зарегистрирован и без ITGAME_DEBUG: на запрос без
// живой партии отвечает своим JSON 404, а не 404 ServeMux «page not found».
func TestCheatRouteWithoutDebug(t *testing.T) {
	srv := httptest.NewServer(newMux(game.DefaultConfig(), nil, nil, "", false, 0, spriteproxy.Upstream{}))
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/api/cheat/money", "application/json", strings.NewReader(`{"sid":"cheat-route-01","amount":100}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("ответ не JSON — маршрута нет: %v", err)
	}
	if resp.StatusCode != http.StatusNotFound || !strings.Contains(out["error"], "session_not_live") {
		t.Fatalf("ждали 404 session_not_live, получили %d %v", resp.StatusCode, out)
	}
}
```

(main_test.go already imports `encoding/json`, `net/http`, `net/http/httptest`, `strings`, `game` and `spriteproxy`, so no import changes are needed.)

Run: `cd server && go test ./cmd/server -run TestCheatRouteWithoutDebug -count=1`
Expected: `ok`. Then run the whole suite: `cd server && go vet ./... && go test ./... 2>&1 | grep -v '^ok\|no test files'`. Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add server/internal/ws/cheat.go server/internal/ws/cheat_test.go server/internal/ws/debug.go server/internal/ws/session.go server/cmd/server/main.go server/cmd/server/main_test.go
git commit -m "feat(server): POST /api/cheat/money adds money to the live party, registered without ITGAME_DEBUG and open only to a local request (loopback RemoteAddr, localhost Host, no X-Real-IP/X-Forwarded-For/Forwarded — prod nginx always sets X-Real-IP); the actor turns it into the itd.set money patch, so snapshot, save and journal are unchanged — ITGAME-194"
```

---

### Task 2: Client — global `cheat` on localhost, docs and a live check

**Files:**
- Create: `client/src/debug/localhost.ts` (pure, no imports — node-testable)
- Create: `client/src/debug/cheat.ts`
- Create: `client/scripts/lib/localhost.test.mjs`
- Modify: `client/src/main.ts:73-74` (install next to `installAgentApi`)
- Modify: `docs/development.md` (a «Cheats (localhost)» paragraph next to the debug API section)

**Interfaces:**
- Consumes: `POST /api/cheat/money {sid, amount}` from Task 1; `client.liveSid(): string | null` from `client/src/net.ts:1022`.
- Produces: `isLocalHostname(hostname: string): boolean`; `installCheats(): void`; `window.cheat.money(amount?: number): Promise<number>` resolving to the new balance.

- [ ] **Step 1: Write the failing test** — `client/scripts/lib/localhost.test.mjs`

```js
// Чит для localhost (ITGAME-194): window.cheat ставится только на локальном хосте.
// src/debug/localhost.ts без импортов — Node берёт его как есть.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLocalHostname } from '../../src/debug/localhost.ts'

test('isLocalHostname: localhost, 127.0.0.1, [::1], *.localhost — да', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', '::1', 'itgame.localhost', 'LOCALHOST']) {
    assert.equal(isLocalHostname(h), true, h)
  }
})

test('isLocalHostname: прод, стейдж и похожие имена — нет', () => {
  for (const h of ['itgame.santarinto.ru', 'stage.itgame.santarinto.ru', 'localhost.evil.com', '127.0.0.2', '10.8.1.5', '']) {
    assert.equal(isLocalHostname(h), false, h)
  }
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd client && node --test scripts/lib/localhost.test.mjs`
Expected: FAIL with `Cannot find module '…/src/debug/localhost.ts'`.

- [ ] **Step 3: Implement**

`client/src/debug/localhost.ts`:

```ts
// Локальный ли хост страницы (ITGAME-194): чит денег ставится только тут. Та же
// граница, что у сервера (localRequest в server/internal/ws/cheat.go); сервер всё
// равно проверяет сам — это лишь не показывать cheat там, где он откажет.
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}
```

`client/src/debug/cheat.ts`:

```ts
// Чит денег для localhost (ITGAME-194): в консоли cheat.money() — +$10 000 живой
// партии вкладки, cheat.money(50000) — +$50 000. Без ?debug=1 и без ITGAME_DEBUG,
// в любой сборке, но только на localhost: сервер (POST /api/cheat/money) пускает
// лишь локальный запрос. Снапшот с новым балансом приходит по /ws сам.
import { client } from '../net'
import { isLocalHostname } from './localhost'

const DEFAULT_AMOUNT = 10_000

async function money(amount: number = DEFAULT_AMOUNT): Promise<number> {
  if (!Number.isInteger(amount) || amount < 1 || amount > 10_000_000) {
    throw new Error('cheat.money: сумма — целое 1..10000000')
  }
  const sid = client.liveSid()
  if (sid === null) throw new Error('cheat.money: вкладка не в партии — сначала начните или продолжите игру')
  const res = await fetch('/api/cheat/money', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sid, amount }),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; state?: { money: number } }
  if (!res.ok || !data.state) throw new Error(`cheat.money: ${data.error ?? `HTTP ${res.status}`}`)
  console.info(`cheat: +$${amount.toLocaleString('ru-RU')} → $${data.state.money.toLocaleString('ru-RU')}`)
  return data.state.money
}

export function installCheats(): void {
  if (!isLocalHostname(location.hostname)) return
  ;(window as unknown as { cheat: { money: typeof money } }).cheat = { money }
}
```

In `client/src/main.ts`, after `installAgentApi(game)` (line 74):

```ts

// Чит денег в консоли (ITGAME-194): cheat.money() — только на localhost, без ?debug=1.
installCheats()
```

and add the import next to the agentApi one: `import { installCheats } from './debug/cheat'`.

- [ ] **Step 4: Run tests, typecheck and build**

Run: `cd client && node --test scripts/lib/localhost.test.mjs && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)' && npm run typecheck && npm run build 2>&1 | grep -E 'built in|FAIL'`
Expected: both new tests pass; `ℹ fail 0`; typecheck silent; `✓ built in …`.

- [ ] **Step 5: Live check without debug**

Build the binary from the worktree and serve `client/dist` on a scratch port with **no** `ITGAME_DEBUG` and **no** `DATABASE_URL`:

```bash
cd server && go build -o /tmp/itd-cheat ./cmd/server && env -u ITGAME_DEBUG -u DATABASE_URL /tmp/itd-cheat -addr 127.0.0.1:4421 -static ../client/dist -saves $(mktemp -d)
```

In a browser, open `http://127.0.0.1:4421/` (no `?debug=1`) and start a party. In the console, `await cheat.money()` should print `cheat: +$10 000 → $…` and the HUD balance should grow by 10 000. Then `await cheat.money(50000)` should add 50 000. Check `window.itd` is `undefined` (no debug). Also from a shell, `curl -s -X POST -H 'X-Real-IP: 1.2.3.4' -d '{"sid":"x","amount":1}' 127.0.0.1:4421/api/cheat/money` should answer `{"error":"not_local: читы только с localhost"}`. Stop the server afterwards.

- [ ] **Step 6: Docs** — in `docs/development.md`, next to the debug API (`itd`) section, add:

```markdown
### Cheats (localhost)

ITGAME-194. On `localhost`, `127.0.0.1`, `[::1]` or `*.localhost` the page
installs a global `cheat` in every build, without `?debug=1`:
`await cheat.money()` adds $10 000 to the tab's live party, and
`cheat.money(50000)` adds $50 000. The call resolves to the new balance and
logs it. It goes to `POST /api/cheat/money {sid, amount}` (amount 1..10 000 000).
That route is registered without `ITGAME_DEBUG`, but it accepts only a local
request: a loopback RemoteAddr, a localhost `Host`, and no `X-Real-IP` /
`X-Forwarded-For` / `Forwarded` header. Everything else gets
`403 not_local`. Prod nginx always sets `X-Real-IP`, so players there cannot
reach it. The actor applies the cheat as the same money patch `itd.set` uses,
so with `ITGAME_DEBUG` the replay journal records it as a debug patch.
```

- [ ] **Step 7: Commit**

```bash
git add client/src/debug/localhost.ts client/src/debug/cheat.ts client/scripts/lib/localhost.test.mjs client/src/main.ts docs/development.md
git commit -m "feat(client): cheat.money() in the console on localhost — +\$10 000 (or the given amount) to the tab's live party in every build without ?debug=1, installed only on localhost/127.0.0.1/[::1]/*.localhost; development.md «Cheats (localhost)» — ITGAME-194"
```
