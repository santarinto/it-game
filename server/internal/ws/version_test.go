package ws

import (
	"runtime/debug"
	"strings"
	"testing"
)

// Штамп сборки сервера (ITGAME-81): sha, вшитый линкером, бьёт vcs.revision;
// невалидный штамп игнорируется.
func TestPickVersion(t *testing.T) {
	full := "0123456789abcdef0123456789abcdef01234567"
	withRev := &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs.revision", Value: full}}}
	noRev := &debug.BuildInfo{}
	cases := []struct {
		name, stamp string
		bi          *debug.BuildInfo
		want        string
	}{
		{"штамп бьёт vcs.revision", "abc1234", withRev, "abc1234"},
		{"длинный короткий sha — как есть", "abc1234def", withRev, "abc1234def"},
		{"полный sha", full, noRev, full},
		{"без штампа — vcs.revision[:7]", "", withRev, "0123456"},
		{"без штампа и vcs — unknown", "", noRev, "unknown"},
		{"нет build info", "", nil, "unknown"},
		{"верхний регистр игнорируется", "ABC1234", withRev, "0123456"},
		{"короче 7 игнорируется", "abc12", noRev, "unknown"},
		{"длиннее 40 игнорируется", strings.Repeat("a", 41), noRev, "unknown"},
		{"мусор игнорируется", "abc1234; rm", noRev, "unknown"},
		{"dev игнорируется", "dev", noRev, "unknown"},
	}
	for _, tc := range cases {
		if got := pickVersion(tc.stamp, tc.bi); got != tc.want {
			t.Errorf("%s: pickVersion(%q) = %q, want %q", tc.name, tc.stamp, got, tc.want)
		}
	}
}

// ServerVersion (его зовут /api/version, заголовок журнала, agent_status)
// берёт штамп из buildSHA — туда его кладёт -ldflags -X.
func TestServerVersionBuildSHA(t *testing.T) {
	old := buildSHA
	t.Cleanup(func() { buildSHA = old })

	buildSHA = ""
	fallback := ServerVersion() // vcs.revision[:7] или "unknown" — как собран тестовый бинарь
	buildSHA = "abc1234"
	if got := ServerVersion(); got != "abc1234" {
		t.Fatalf("ServerVersion() со штампом = %q, want abc1234", got)
	}
	buildSHA = "ABC1234"
	if got := ServerVersion(); got != fallback {
		t.Fatalf("ServerVersion() с невалидным штампом = %q, want %q", got, fallback)
	}
}
