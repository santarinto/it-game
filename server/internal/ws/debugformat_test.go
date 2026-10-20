package ws

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// onlyFormatChanged — after отличается от before только game.format (ITGAME-154): тот же набор
// ключей, каждый верхний ключ кроме game и каждый ключ game кроме format побайтно равны (это
// пин version, savedAt, денег и uint64-сида), format == want.
func onlyFormatChanged(t *testing.T, before, after []byte, want int) {
	t.Helper()
	var b, a map[string]json.RawMessage
	if err := json.Unmarshal(before, &b); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(after, &a); err != nil {
		t.Fatal(err)
	}
	if len(a) != len(b) {
		t.Fatalf("набор верхних ключей изменился: было %d, стало %d", len(b), len(a))
	}
	for k, v := range b {
		if k == "game" {
			continue
		}
		if !bytes.Equal(a[k], v) {
			t.Errorf("верхний ключ %q изменился: %s → %s", k, v, a[k])
		}
	}
	var bg, ag map[string]json.RawMessage
	if err := json.Unmarshal(b["game"], &bg); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(a["game"], &ag); err != nil {
		t.Fatal(err)
	}
	if len(ag) != len(bg) {
		t.Fatalf("набор ключей game изменился: было %d, стало %d", len(bg), len(ag))
	}
	for k, v := range bg {
		if k == "format" {
			continue
		}
		if !bytes.Equal(ag[k], v) {
			t.Errorf("game.%s изменился: %s → %s", k, v, ag[k])
		}
	}
	if string(ag["format"]) != fmt.Sprint(want) {
		t.Errorf("game.format = %s, хотим %d", ag["format"], want)
	}
}

// storedFormat — game.format сейва sid в сторе (fatal, если сейва нет).
func storedFormat(t *testing.T, saves *store.Store, sid string) int {
	t.Helper()
	raw, ok := saves.Load(sid)
	if !ok {
		t.Fatalf("сейва %s нет в сторе", sid)
	}
	var head saveHead
	if err := json.Unmarshal(raw, &head); err != nil {
		t.Fatal(err)
	}
	return head.Game.Format
}

// storedMoney — деньги сейва sid в сторе.
func storedMoney(t *testing.T, saves *store.Store, sid string) int {
	t.Helper()
	raw, ok := saves.Load(sid)
	if !ok {
		t.Fatalf("сейва %s нет в сторе", sid)
	}
	var ss sessionSave
	if err := json.Unmarshal(raw, &ss); err != nil {
		t.Fatal(err)
	}
	return ss.Game.Money
}

// TestDebugFormatMarksStoredSave — сейв, который никто не держит (ITGAME-154): маршрут переписывает
// стор (память и файл), меняя только game.format; меню говорит «несовместим» с версией сейва,
// подключение начинает новую партию и пишет сейв формата сервера.
func TestDebugFormatMarksStoredSave(t *testing.T) {
	const cur = "2026.10.18.03.00"
	const sid = "format-stored-1"
	for _, tc := range []struct {
		name      string
		edited    bool // сейв новее с полем другого типа, которое эта сборка не разберёт
		body      string
		was, want int
	}{
		{"новее по умолчанию", false, `{"sid":"` + sid + `"}`, game.SaveFormat, game.SaveFormat + 1},
		{"старше", false, fmt.Sprintf(`{"sid":%q,"format":%d}`, sid, game.SaveFormat-1), game.SaveFormat, game.SaveFormat - 1},
		{"новее с полем другого типа → старше", true, fmt.Sprintf(`{"sid":%q,"format":%d}`, sid, game.SaveFormat-1), game.SaveFormat + 1, game.SaveFormat - 1},
	} {
		withBuildVersion(t, cur)
		dir := t.TempDir()
		saves, err := store.New(dir, 24*time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		if tc.edited {
			putEditedSave(t, saves, sid, cur, func(g map[string]any) {
				g["format"] = game.SaveFormat + 1
				g["money"] = "4321"
			})
		} else {
			putVersionedSave(t, saves, sid, cur)
		}
		before, _ := saves.Load(sid)
		_, srv := journalServerWith(t, savesTestConfig(), time.Hour, journalLimits{}, saves)

		code, out := httpDebug(t, srv.URL, "POST", "/api/debug/format", tc.body)
		if code != 200 {
			t.Fatalf("%s: %d %v", tc.name, code, out)
		}
		if out["sid"] != sid || num(t, out["was"]) != tc.was || num(t, out["format"]) != tc.want || out["live"] != false {
			t.Fatalf("%s: ответ %v, хотим was=%d format=%d live=false", tc.name, out, tc.was, tc.want)
		}
		after, _ := saves.Load(sid)
		onlyFormatChanged(t, before, after, tc.want)
		// файл переписан: новый стор на том же каталоге читает правленое
		again, err := store.New(dir, 24*time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		if disk, ok := again.Load(sid); !ok || !bytes.Equal(disk, after) {
			t.Fatalf("%s: файл не совпал с памятью: %q %v", tc.name, disk, ok)
		}

		s := peek(t, saves, savesTestConfig(), "?peek=1&sid="+sid)
		if s.Exists || !s.Incompatible || s.SaveVersion != cur {
			t.Fatalf("%s: сводка %+v, хотим incompatible с версией %q", tc.name, s, cur)
		}
		c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid="+sid)
		first := readResume(t, ctx, c)
		if first.Resumed || first.Money != 600 || first.Day != 1 {
			t.Fatalf("%s: сейв поднялся: resumed=%v money=%d day=%d", tc.name, first.Resumed, first.Money, first.Day)
		}
		if got := storedFormat(t, saves, sid); got != game.SaveFormat {
			t.Fatalf("%s: новая партия записала формат %d, хотим %d", tc.name, got, game.SaveFormat)
		}
	}
}

// TestDebugFormatMarksLiveSession — воспроизведение ITGAME-174: живую партию помечает её актор,
// метка переживает команды, игра, rev и журнал партии не тронуты, а переподключение начинает новую
// партию молча (владелец 20.10: «порча до переподключения»).
func TestDebugFormatMarksLiveSession(t *testing.T) {
	const sid = "format-live-1"
	saves := newTestStore(t)
	h, srv := journalServerWith(t, savesTestConfig(), time.Hour, journalLimits{}, saves)
	tb := dialTab(t, srv, "?sid="+sid)
	debugPost(t, srv, "/api/debug/state", `{"sid":"`+sid+`","money":4321}`)
	tb.wait(t, func(s stateMessage) bool { return s.Money == 4321 })
	_, st0 := liveState(t, srv, sid)

	code, out := httpDebug(t, srv.URL, "POST", "/api/debug/format", `{"sid":"`+sid+`"}`)
	if code != 200 || out["live"] != true || num(t, out["was"]) != game.SaveFormat || num(t, out["format"]) != game.SaveFormat+1 {
		t.Fatalf("метка живой партии: %d %v", code, out)
	}
	if got := storedFormat(t, saves, sid); got != game.SaveFormat+1 {
		t.Fatalf("в сторе формат %d, хотим %d сразу", got, game.SaveFormat+1)
	}
	if got := storedMoney(t, saves, sid); got != 4321 {
		t.Fatalf("деньги в сейве %d, хотим 4321", got)
	}

	// игра не тронута: rev тот же, Export несёт формат сервера
	save, st1 := liveState(t, srv, sid)
	if st1.Rev != st0.Rev {
		t.Fatalf("метка подняла rev: %d → %d", st0.Rev, st1.Rev)
	}
	var liveGame game.Save
	if err := json.Unmarshal(save, &liveGame); err != nil || liveGame.Format != game.SaveFormat || liveGame.Money != 4321 {
		t.Fatalf("живая игра: format=%d money=%d err=%v", liveGame.Format, liveGame.Money, err)
	}

	// метка липнет: успешная команда пишет сейв, формат остаётся
	tb.do(t, map[string]any{"type": "set_speed", "speed": 2})
	if got := storedFormat(t, saves, sid); got != game.SaveFormat+1 {
		t.Fatalf("после команды формат %d, хотим %d", got, game.SaveFormat+1)
	}

	// вторая метка видит первую как was
	code, out = httpDebug(t, srv.URL, "POST", "/api/debug/format",
		fmt.Sprintf(`{"sid":%q,"format":%d}`, sid, game.SaveFormat-1))
	if code != 200 || out["live"] != true || num(t, out["was"]) != game.SaveFormat+1 || num(t, out["format"]) != game.SaveFormat-1 {
		t.Fatalf("вторая метка: %d %v", code, out)
	}
	if got := storedFormat(t, saves, sid); got != game.SaveFormat-1 {
		t.Fatalf("после второй метки формат %d, хотим %d", got, game.SaveFormat-1)
	}

	// меню видит это, пока вкладка подключена
	if s := peek(t, saves, savesTestConfig(), "?peek=1&sid="+sid); !s.Incompatible {
		t.Fatalf("меню не видит метку: %+v", s)
	}
	// в журнал партии метка не попала: реплей сходится
	replayAndCompare(t, srv, sid)

	// переподключение: сейв чужого формата → новая партия под тем же sid
	tb.close(t, h, sid)
	tb2 := dialTab(t, srv, "?sid="+sid)
	tb2.mu.Lock()
	first := tb2.first
	tb2.mu.Unlock()
	if first.Resumed || first.Money != 600 || first.Day != 1 {
		t.Fatalf("переподключение: resumed=%v money=%d day=%d, хотим новую партию", first.Resumed, first.Money, first.Day)
	}
	if got := storedFormat(t, saves, sid); got != game.SaveFormat {
		t.Fatalf("новая партия записала формат %d, хотим %d", got, game.SaveFormat)
	}
}

// TestDebugFormatRefusals — отказы маршрута (ITGAME-154): текст свободный, не протокольные коды.
func TestDebugFormatRefusals(t *testing.T) {
	base, _ := startDebugServer(t, game.DefaultConfig(), time.Hour)
	code, out := httpDebug(t, base, "POST", "/api/debug/format", `{"sid":"no-saves-1234"}`)
	if msg, _ := out["error"].(string); code != 409 || !strings.HasPrefix(msg, "no_saves") {
		t.Fatalf("сервер без сейвов: %d %v", code, out)
	}

	saves := newTestStore(t)
	_, srv := journalServerWith(t, savesTestConfig(), time.Hour, journalLimits{}, saves)
	for _, tc := range []struct {
		name, body, prefix string
		code               int
	}{
		{"негодный sid", `{"sid":"x"}`, "bad_sid", 400},
		{"формат сервера", fmt.Sprintf(`{"sid":"refuse-1234","format":%d}`, game.SaveFormat), "same_format", 400},
		{"не целый формат", `{"sid":"refuse-1234","format":1.5}`, "bad_format", 400},
		{"огромный формат", `{"sid":"refuse-1234","format":1e30}`, "bad_format", 400},
		{"отрицательный формат", `{"sid":"refuse-1234","format":-1}`, "bad_format", 400},
		{"нет сейва", `{"sid":"refuse-1234"}`, "no_save", 404},
		{"не JSON", `не json`, "тело не JSON", 400},
	} {
		code, out := httpDebug(t, srv.URL, "POST", "/api/debug/format", tc.body)
		if msg, _ := out["error"].(string); code != tc.code || !strings.HasPrefix(msg, tc.prefix) {
			t.Errorf("%s: %d %v, хотим %d %q…", tc.name, code, out, tc.code, tc.prefix)
		}
	}
	if code, _ := httpDebug(t, srv.URL, "GET", "/api/debug/format", ""); code != 405 {
		t.Errorf("GET: %d, хотим 405", code)
	}
}
