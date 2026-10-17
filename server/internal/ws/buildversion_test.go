package ws

import (
	"encoding/json"
	"runtime/debug"
	"testing"
	"time"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

// Версия сборки (ITGAME-140): штамп линкера год.мес.день.час.мин бьёт vcs.time, vcs.time
// переводится в московское время, без обоих — "" (сверять не с чем).
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

// Сейв другой сборки и сейв до ITGAME-140 (решение владельца 17.10): меню получает
// incompatible с обеими версиями, подключение с тем же sid начинает новую партию, и её
// первый сейв перезаписывает файл уже с версией сервера.
func TestSaveOfAnotherBuildStartsNewParty(t *testing.T) {
	const cur = "2026.10.17.12.00"
	withBuildVersion(t, cur)
	for _, old := range []string{"2026.10.16.09.30", ""} {
		sid := "other-build-1"
		if old == "" {
			sid = "pre-140-1"
		}
		saves := newTestStore(t)
		putVersionedSave(t, saves, sid, old)

		s := peek(t, saves, savesTestConfig(), "?peek=1&sid="+sid)
		if s.Exists || s.Alive || !s.Incompatible || s.SaveVersion != old || s.Version != cur {
			t.Fatalf("сейв версии %q в меню: %+v, хотим incompatible, saveVersion %q, version %q", old, s, old, cur)
		}
		c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid="+sid)
		first := readResume(t, ctx, c)
		if first.Resumed || first.Money != 600 || first.Day != 1 {
			t.Fatalf("сейв версии %q поднялся: resumed=%v money=%d day=%d", old, first.Resumed, first.Money, first.Day)
		}
		data, ok := saves.Load(sid)
		if !ok {
			t.Fatal("новая партия не записала сейв")
		}
		var ss sessionSave
		if err := json.Unmarshal(data, &ss); err != nil || ss.Version != cur || ss.Game.Money != 600 {
			t.Fatalf("файл сейва: version=%q money=%d err=%v — хотим новую партию версии %s", ss.Version, ss.Game.Money, err, cur)
		}
	}
}

// Сейв своей сборки продолжается как раньше; сервер без версии (go run) принимает любой.
func TestSaveOfSameBuildResumes(t *testing.T) {
	for _, tc := range []struct{ server, save string }{
		{"2026.10.17.12.00", "2026.10.17.12.00"},
		{"", "2026.10.16.09.30"},
		{"", ""},
	} {
		withBuildVersion(t, tc.server)
		saves := newTestStore(t)
		const sid = "same-build-1"
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
