// replay — реплеер журнала партии (ITGAME-46): прогоняет журнал на
// game.Game и сверяет хэш состояния после каждой записи. Журнал пишет
// сервер с ITGAME_DEBUG=1, отдаёт GET /api/debug/journal?sid=.
//
//	go run ./cmd/replay journal.jsonl
//	go run ./cmd/replay -url http://localhost:8080 -sid <sid>
//	curl -s 'localhost:8080/api/debug/journal?sid=<sid>' | go run ./cmd/replay -
//	go run ./cmd/replay -json journal.jsonl   # итог одним JSON — для скриптов и агентов
//
// Команда в журнале — с номером соединения в партии и источником (conn, src:
// tab | bridge, ITGAME-91); «соединения:» в итоге — их список, повтор пары
// (conn, id) — предупреждение.
//
// Код выхода: 0 — сошлось, 1 — расхождение (отчёт: строка журнала, запись,
// ожидаемый и полученный хэш и позиция, diff сейва на чекпоинте),
// 2 — журнал не читается.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"itdirector/internal/ws"
)

func main() {
	base := flag.String("url", "", "сервер с ITGAME_DEBUG=1: журнал берётся с <url>/api/debug/journal?sid=")
	sid := flag.String("sid", "", "sid партии (с -url)")
	dump := flag.Bool("dump", false, "напечатать сейв после реплея (JSON) — для сверки руками")
	asJSON := flag.Bool("json", false, "итог одним JSON-объектом {ok, records, ticks, hash, warnings, divergence, save}")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "replay [-dump|-json] <journal.jsonl | ->   |   replay [-dump|-json] -url http://host:port -sid <sid>")
		flag.PrintDefaults()
	}
	flag.Parse()

	in, name, err := open(*base, *sid, flag.Arg(0))
	if err != nil {
		fmt.Fprintln(os.Stderr, "replay:", err)
		os.Exit(2)
	}
	defer in.Close()

	res, err := ws.Replay(in)
	if err != nil {
		fmt.Fprintf(os.Stderr, "replay: %s: %v\n", name, err)
		os.Exit(2)
	}
	if *asJSON {
		os.Exit(printJSON(res))
	}
	h := res.Header
	fmt.Printf("журнал %s: sid %s, сид %s, %s, сценарий %q, сервер %s\n",
		name, h.SID, h.Seed, h.Difficulty, h.Scenario, h.Version)
	if h.Dropped > 0 || res.FromSeq > 1 {
		fmt.Printf("  кольцо срезало %d записей: реплей с чекпоинта seq %d\n", h.Dropped, res.FromSeq)
	}
	if h.Overflow {
		fmt.Println("  ВНИМАНИЕ: журнал упёрся в потолок без чекпоинта — хвост партии не записан")
	}
	if len(res.Conns) > 0 {
		fmt.Printf("  соединения: %s\n", connsLine(res.Conns))
	}
	if *dump && res.Game != nil {
		b, _ := json.MarshalIndent(res.Game.Export(), "", "  ")
		fmt.Printf("%s\n", b)
	}
	if d := res.Divergence; d != nil {
		fmt.Printf("ДЕТЕРМИНИЗМ СЛОМАН после %d записей и %d тиков\n%s", res.Records, res.Ticks, d)
		os.Exit(1)
	}
	for _, w := range res.Warnings {
		fmt.Println("  предупреждение:", w)
	}
	g := res.Game
	fmt.Printf("OK: %d записей, %d тиков; день %d, тик %d, $%d, %s; хэш %s\n",
		res.Records, res.Ticks, g.Day, g.TickInDay, g.Money, g.Phase, res.LastHash)
}

func open(base, sid, path string) (io.ReadCloser, string, error) {
	if base != "" {
		if sid == "" {
			return nil, "", fmt.Errorf("-url без -sid")
		}
		u := strings.TrimRight(base, "/") + "/api/debug/journal?sid=" + url.QueryEscape(sid)
		c := &http.Client{Timeout: 30 * time.Second}
		resp, err := c.Get(u)
		if err != nil {
			return nil, "", err
		}
		if resp.StatusCode != http.StatusOK {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			return nil, "", fmt.Errorf("%s: %s %s", u, resp.Status, strings.TrimSpace(string(b)))
		}
		return resp.Body, u, nil
	}
	switch path {
	case "":
		flag.Usage()
		os.Exit(2)
	case "-":
		return io.NopCloser(os.Stdin), "stdin", nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, "", err
	}
	return f, path, nil
}

// conns — соединения партии (ITGAME-91) для JSON: {"1":"tab","2":"bridge"}.
func conns(m map[int]string) map[string]string {
	out := make(map[string]string, len(m))
	for n, src := range m {
		out[strconv.Itoa(n)] = src
	}
	return out
}

// connsLine — «c1 tab, c2 tab, c3 bridge»: по номеру соединения.
func connsLine(m map[int]string) string {
	ns := make([]int, 0, len(m))
	for n := range m {
		ns = append(ns, n)
	}
	sort.Ints(ns)
	parts := make([]string, len(ns))
	for i, n := range ns {
		parts[i] = fmt.Sprintf("c%d %s", n, m[n])
	}
	return strings.Join(parts, ", ")
}

// printJSON — итог для машин: тот же код выхода, что у текстового режима.
func printJSON(res *ws.ReplayResult) int {
	out := map[string]any{
		"ok": res.Divergence == nil, "records": res.Records, "ticks": res.Ticks,
		"fromSeq": res.FromSeq, "hash": res.LastHash, "warnings": res.Warnings,
		"sid": res.Header.SID, "seed": res.Header.Seed, "dropped": res.Header.Dropped,
		"conns": conns(res.Conns),
	}
	if res.Warnings == nil {
		out["warnings"] = []string{}
	}
	if res.Game != nil {
		out["save"] = res.Game.Export()
		out["speed"] = res.Speed
	}
	code := 0
	if d := res.Divergence; d != nil {
		out["divergence"] = map[string]any{
			"line": d.Line, "record": d.Record, "reason": d.Reason, "want": d.Want, "got": d.Got,
			"wantPos": d.WantPos, "gotPos": d.GotPos, "diff": d.Diff,
		}
		code = 1
	}
	b, _ := json.Marshal(out)
	fmt.Printf("%s\n", b)
	return code
}
