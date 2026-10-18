package saveshape

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// Обход слепка по правилам encoding/json: тег и имя поля, json:"-", неэкспортируемые, опции тега,
// указатель, срез, карта, именованный тип — его kind; тип из Skip и тип со своим MarshalJSON —
// имя типа без своих строк.
func TestSaveShapeWalk(t *testing.T) {
	type phase string
	type leaf struct {
		A      int
		hidden int
	}
	type pinned struct{ B int }
	type probe struct {
		Plain  string
		Count  int             `json:"count"`
		Skip   int             `json:"-"`
		Opt    *leaf           `json:"opt,omitempty"`
		List   []leaf          `json:"list"`
		Index  map[string]leaf `json:"index"`
		Kind   phase
		At     time.Time `json:"at"`
		Other  pinned    `json:"other"`
		Others []*pinned `json:"others"`
		inner  int
	}
	got := Pin{Root: reflect.TypeFor[probe](), Skip: []reflect.Type{reflect.TypeFor[pinned]()}}.shape(t)
	want := []string{
		"Kind string",
		"Plain string",
		"at time.Time",
		"count int",
		"index map[string]struct",
		"index{}.A int",
		"list []struct",
		"list[].A int",
		"opt *struct omitempty",
		"opt.A int",
		"other saveshape.pinned",
		"others []*saveshape.pinned",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("слепок probe:\n%s\nхотим:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// Вердикт слепка: новое поле без подъёма формата красное и печатает слепок следующего формата;
// он же, вставленный без подъёма, остаётся красным и ничего не печатает; подъём перепинивается;
// пропавший или испорченный слепок не печатается заново — его восстанавливают из git.
func TestSaveShapeVerdict(t *testing.T) {
	pinned := func(n int, lines ...string) string {
		return fmt.Sprintf("format %d\n%s\n", n, strings.Join(lines, "\n"))
	}
	shape := []string{"a int", "b string"}
	for _, tc := range []struct {
		name, golden string
		format       int
		ok           bool   // fix == ""
		file         string // что предложено вставить
		hint         string // кусок fix
	}{
		{"сходится", pinned(1, "a int", "b string"), 1, true, "", ""},
		{"поле добавлено без подъёма", pinned(1, "a int"), 1, false, pinned(2, "a int", "b string"),
			"Подними SaveFormat в server/internal/game/save.go до 2 и замени server/internal/x/testdata/x.txt"},
		{"слепок вставлен без подъёма", pinned(2, "a int", "b string"), 1, false, "", "подними SaveFormat в server/internal/game/save.go до 2"},
		{"подъём со сменой структуры", pinned(1, "a int"), 2, false, pinned(2, "a int", "b string"), "SaveFormat поднят до 2"},
		{"подъём без смены структуры", pinned(1, "a int", "b string"), 2, false, pinned(2, "a int", "b string"), "SaveFormat поднят до 2"},
		{"слепка нет", "", 1, false, "", "восстанови его из git (git checkout -- server/internal/x/testdata/x.txt)"},
		{"слепок испорчен", "format x\na int\n", 1, false, "", "восстанови его из git"},
	} {
		p := Pin{Root: reflect.TypeFor[struct{}](), Pkg: "server/internal/x", File: "testdata/x.txt", Format: tc.format}
		fix, file := p.verdict(tc.golden, shape)
		if (fix == "") != tc.ok || file != tc.file || !strings.Contains(fix, tc.hint) {
			t.Errorf("%s: fix %q, file %q; хотим ok=%v, file %q, fix с %q", tc.name, fix, file, tc.ok, tc.file, tc.hint)
		}
	}
}
