package ws

import (
	"encoding/json"
	"runtime/debug"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// Версия сборки (ITGAME-140): штамп линкера год.мес.день.час.мин бьёт vcs.time, vcs.time
// переводится в московское время, без обоих — "" (версии нет).
func TestPickBuildVersion(t *testing.T) {
	vcs := func(v string) *debug.BuildInfo {
		return &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs.time", Value: v}}}
	}
	cases := []struct {
		name, stamp string
		bi          *debug.BuildInfo
		want        string
	}{
		{"штамп бьёт vcs.time", "2026.10.17.01.25", vcs("2020-01-01T00:00:00Z"), "2026.10.17.01.25"},
		{"vcs.time по Москве, через полночь", "", vcs("2026-10-16T22:25:41Z"), "2026.10.17.01.25"},
		{"vcs.time со своим смещением", "", vcs("2026-10-17T01:25:00+03:00"), "2026.10.17.01.25"},
		{"невалидный штамп — vcs.time", "2026.10.17", vcs("2026-10-16T22:25:00Z"), "2026.10.17.01.25"},
		{"мусор в штампе — vcs.time", "2026.10.17.01.25; rm", vcs("2026-10-16T22:25:00Z"), "2026.10.17.01.25"},
		{"битый vcs.time", "", vcs("вчера"), ""},
		{"нет vcs.time", "", &debug.BuildInfo{}, ""},
		{"нет build info", "", nil, ""},
	}
	for _, tc := range cases {
		if got := pickBuildVersion(tc.stamp, tc.bi); got != tc.want {
			t.Errorf("%s: pickBuildVersion(%q) = %q, want %q", tc.name, tc.stamp, got, tc.want)
		}
	}
}

// withBuildVersion — сервер этой версии на время теста (go test vcs не штампует: без этого "").
func withBuildVersion(t *testing.T, v string) {
	t.Helper()
	old := buildVersion
	t.Cleanup(func() { buildVersion = old })
	buildVersion = v
}

// putVersionedSave — сейв sid с $4321, написанный сборкой ver ("" — сейв до ITGAME-140).
func putVersionedSave(t *testing.T, saves *store.Store, sid, ver string) {
	t.Helper()
	g := game.NewWithSeed(savesTestConfig(), 11, 22)
	g.Money = 4321
	gen, _ := saves.Begin(sid)
	raw, _ := json.Marshal(sessionSave{SID: sid, Speed: 1, SavedAt: time.Now(), Game: g.Export(), Version: ver})
	if !saves.Put(sid, gen, raw, time.Now()) {
		t.Fatal("не удалось записать тестовый сейв")
	}
}

// putEditedSave — сейв sid с $4321 сборки ver, игру которого правит edit на уровне JSON: формат и
// поле другого типа — то, чего Save этой сборки сам не запишет.
func putEditedSave(t *testing.T, saves *store.Store, sid, ver string, edit func(g map[string]any)) {
	t.Helper()
	g := game.NewWithSeed(savesTestConfig(), 11, 22)
	g.Money = 4321
	raw, _ := json.Marshal(sessionSave{SID: sid, Speed: 1, SavedAt: time.Now(), Game: g.Export(), Version: ver})
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	edit(m["game"].(map[string]any))
	raw, _ = json.Marshal(m)
	gen, _ := saves.Begin(sid)
	if !saves.Put(sid, gen, raw, time.Now()) {
		t.Fatal("не удалось записать тестовый сейв")
	}
}

// Сейв того же формата продолжается на любой сборке (ITGAME-169, правило владельца 18.10):
// версия сборки — для людей, совместимость решает game.SaveFormat. Своя сборка, чужая, сейв без
// версии (до ITGAME-140) и сервер без версии (go run) — везде партия $4321 продолжается.
func TestSaveOfAnyBuildResumes(t *testing.T) {
	for _, tc := range []struct{ server, save string }{
		{"2026.10.17.12.00", "2026.10.17.12.00"},
		{"2026.10.18.03.00", "2026.10.16.09.30"},
		{"2026.10.18.03.00", ""},
		{"", "2026.10.16.09.30"},
		{"", ""},
	} {
		withBuildVersion(t, tc.server)
		saves := newTestStore(t)
		const sid = "any-build-1"
		putVersionedSave(t, saves, sid, tc.save)

		s := peek(t, saves, savesTestConfig(), "?peek=1&sid="+sid)
		if !s.Exists || !s.Alive || s.Incompatible || s.Money != 4321 || s.Version != tc.server {
			t.Fatalf("сервер %q, сейв %q: сводка %+v, хотим живой сейв $4321", tc.server, tc.save, s)
		}
		c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid="+sid)
		if first := readResume(t, ctx, c); !first.Resumed || first.Money != 4321 {
			t.Fatalf("сервер %q, сейв %q: resumed=%v money=%d, хотим продолжение $4321", tc.server, tc.save, first.Resumed, first.Money)
		}
	}
}

// Сейв другого формата — старше или новее — не продолжается (ITGAME-169): меню получает exists
// false и incompatible с версией писавшей сборки, подключение с тем же sid начинает новую партию,
// её первый сейв перезаписывает файл форматом и версией сервера. Сборка та же, что у сервера: тут
// отказывает формат, не версия. Новее и с полем, сменившим тип (сейв целиком не декодируется), —
// меню всё равно говорит «несовместим», а не «сейва нет».
func TestSaveOfAnotherFormatStartsNewParty(t *testing.T) {
	const cur = "2026.10.18.03.00"
	withBuildVersion(t, cur)
	for _, tc := range []struct {
		name   string
		format int
		retype bool // money строкой: так выглядит поле, сменившее тип в новом формате
	}{
		{"старше", game.SaveFormat - 1, false},
		{"новее", game.SaveFormat + 1, false},
		{"новее, поле сменило тип", game.SaveFormat + 1, true},
	} {
		saves := newTestStore(t)
		const sid = "other-format-1"
		putEditedSave(t, saves, sid, cur, func(g map[string]any) {
			g["format"] = tc.format
			if tc.retype {
				g["money"] = "4321"
			}
		})

		s := peek(t, saves, savesTestConfig(), "?peek=1&sid="+sid)
		if s.Exists || s.Alive || !s.Incompatible || s.SaveVersion != cur || s.Version != cur {
			t.Fatalf("%s: сводка %+v, хотим incompatible, saveVersion и version %q", tc.name, s, cur)
		}
		c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid="+sid)
		first := readResume(t, ctx, c)
		if first.Resumed || first.Money != 600 || first.Day != 1 {
			t.Fatalf("%s: сейв поднялся: resumed=%v money=%d day=%d", tc.name, first.Resumed, first.Money, first.Day)
		}
		data, ok := saves.Load(sid)
		if !ok {
			t.Fatalf("%s: новая партия не записала сейв", tc.name)
		}
		var ss sessionSave
		if err := json.Unmarshal(data, &ss); err != nil || ss.Game.Format != game.SaveFormat || ss.Version != cur || ss.Game.Money != 600 {
			t.Fatalf("%s: файл сейва format=%d version=%q money=%d err=%v — хотим новую партию формата %d", tc.name, ss.Game.Format, ss.Version, ss.Game.Money, err, game.SaveFormat)
		}
	}
}

// Заголовок журнала несёт версию сборки рядом с sha (для людей; реплей её не сверяет).
func TestJournalHeaderBuild(t *testing.T) {
	withBuildVersion(t, "2026.10.17.12.00")
	j := &journal{header: journalHeader{K: "header", Build: BuildVersion()}}
	raw, _ := json.Marshal(j.header)
	var h map[string]any
	if err := json.Unmarshal(raw, &h); err != nil || h["build"] != "2026.10.17.12.00" {
		t.Fatalf("заголовок журнала: %s", raw)
	}
}

// Первый снапшот говорит клиенту, почему партия новая (ITGAME-174): incompatible — только когда
// существующий сейв отвергнут из-за чужого формата. Нет сейва, битый сейв и сейв чужого sid
// остаются тихими (ITGAME-54: «Продолжить» на пропавшем сейве окна не показывает), нормальное
// продолжение — resumed без incompatible; дальше по сессии поля нет.
func TestFirstSnapshotTellsWhyPartyIsNew(t *testing.T) {
	const cur = "2026.10.18.03.00"
	withBuildVersion(t, cur)
	const sid = "why-new-1234"
	for _, tc := range []struct {
		name         string
		put          func(saves *store.Store)
		resumed, why bool
	}{
		{"нет сейва", func(*store.Store) {}, false, false},
		{"битый сейв", func(saves *store.Store) {
			gen, _ := saves.Begin(sid)
			saves.Put(sid, gen, []byte("{не json"), time.Now())
		}, false, false},
		{"сейв другого sid", func(saves *store.Store) {
			putEditedSave(t, saves, sid, cur, func(g map[string]any) { g["format"] = game.SaveFormat })
			raw, _ := saves.Load(sid)
			var m map[string]any
			_ = json.Unmarshal(raw, &m)
			m["sid"] = "someone-else-1"
			raw, _ = json.Marshal(m)
			gen, _ := saves.Begin(sid)
			saves.Put(sid, gen, raw, time.Now())
		}, false, false},
		{"формат старше", func(saves *store.Store) {
			putEditedSave(t, saves, sid, cur, func(g map[string]any) { g["format"] = game.SaveFormat - 1 })
		}, false, true},
		{"формат новее, поле сменило тип", func(saves *store.Store) {
			putEditedSave(t, saves, sid, cur, func(g map[string]any) { g["format"] = game.SaveFormat + 1; g["money"] = "4321" })
		}, false, true},
		{"нормальное продолжение", func(saves *store.Store) { putVersionedSave(t, saves, sid, cur) }, true, false},
	} {
		saves := newTestStore(t)
		tc.put(saves)
		c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid="+sid)
		first := readResume(t, ctx, c)
		if first.Resumed != tc.resumed || first.Incompatible != tc.why {
			t.Fatalf("%s: resumed=%v incompatible=%v, хотим %v/%v", tc.name, first.Resumed, first.Incompatible, tc.resumed, tc.why)
		}
		// поле только в первом снапшоте: следующий тик/команда его не несёт
		if err := wsjson.Write(ctx, c, clientMessage{Type: "set_speed", Speed: 2}); err != nil {
			t.Fatal(err)
		}
		next := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Speed == 2 })
		if next.Incompatible {
			t.Fatalf("%s: incompatible во втором снапшоте", tc.name)
		}
	}
}
