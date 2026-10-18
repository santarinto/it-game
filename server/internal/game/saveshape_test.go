package game

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// saveShapeFile — слепок структуры Save (ITGAME-169): «format N», затем ключи JSON с типами.
const saveShapeFile = "testdata/save_shape.txt"

// Структура сейва закреплена (ITGAME-169, правило владельца 18.10): любое добавленное, убранное
// или изменённое поле Save — на любой глубине (Config, Office → Employee, DayEvent, DayLedger →
// LedgerEvent/LedgerPurchase): ключ, тип или опции json-тега — поднимает SaveFormat, миграций нет.
// Красный, когда структура разошлась со слепком при том же SaveFormat (новое поле без подъёма) и
// когда SaveFormat и слепок разных форматов (подъём без нового слепка или слепок без подъёма).
// Закреплён только game.Save: обёртка ws.sessionSave (sid, скорость, версия сборки, lastReport) —
// параметры сессии, правило владельца называет Save.
func TestSaveShape(t *testing.T) {
	raw, err := os.ReadFile(saveShapeFile)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	fix, file := shapeVerdict(string(raw), SaveFormat, jsonShape(t, reflect.TypeFor[Save]()))
	if fix == "" {
		return
	}
	if file != "" {
		// В stdout, а не в t.Fatal: go test сдвигает продолжение сообщения на 8 пробелов, а блок
		// между строками ----- вставляется в файл как есть.
		fmt.Printf("----- %s -----\n%s----- конец %s -----\n", saveShapeFile, file, saveShapeFile)
	}
	t.Fatal(fix)
}

// jsonShape — ключи JSON типа root так, как их пишет encoding/json: имя из json-тега, без него —
// имя поля; неэкспортируемые и json:"-" пропущены. Строка — «путь тип[ опции тега]»: тип листа —
// его kind (Phase — string, Seed — uint64), * [] [N] map[K] — указатель, срез, массив, карта,
// struct — структура, её поля идут своими строками (путь через точку; элемент среза — «[]»,
// значение карты — «{}»). Отсортировано: порядок полей в JSON не важен.
func jsonShape(t *testing.T, root reflect.Type) []string {
	t.Helper()
	var lines []string
	var walk func(prefix string, st reflect.Type)
	walk = func(prefix string, st reflect.Type) {
		for i := range st.NumField() {
			f := st.Field(i)
			if f.Anonymous {
				t.Fatalf("%s.%s: встроенное поле — обход слепка его не знает, допиши по правилам encoding/json", st, f.Name)
			}
			tag := f.Tag.Get("json")
			if !f.IsExported() || tag == "-" {
				continue
			}
			name, opts, _ := strings.Cut(tag, ",")
			if name == "" {
				name = f.Name
			}
			typ, sub, inner := "", name, f.Type
		unwrap:
			for {
				switch inner.Kind() {
				case reflect.Pointer:
					typ += "*"
				case reflect.Slice:
					typ, sub = typ+"[]", sub+"[]"
				case reflect.Array:
					typ, sub = typ+fmt.Sprintf("[%d]", inner.Len()), sub+"[]"
				case reflect.Map:
					typ, sub = typ+"map["+inner.Key().Kind().String()+"]", sub+"{}"
				default:
					break unwrap
				}
				inner = inner.Elem()
			}
			line := prefix + name + " " + typ + inner.Kind().String()
			if opts != "" {
				line += " " + opts
			}
			lines = append(lines, line)
			if inner.Kind() == reflect.Struct {
				walk(prefix+sub+".", inner)
			}
		}
	}
	walk("", root)
	slices.Sort(lines)
	return lines
}

// shapeVerdict — сверка слепка golden (содержимое файла, "" — файла нет) со структурой shape при
// SaveFormat = format. fix — что сделать ("" — сходится). file — новое содержимое слепка, когда
// его правильно просто вставить; "" — сначала поднять SaveFormat: слепок, вставленный без
// подъёма формата, не должен позеленеть.
func shapeVerdict(golden string, format int, shape []string) (fix, file string) {
	pin := func(n int) string { return fmt.Sprintf("format %d\n%s\n", n, strings.Join(shape, "\n")) }
	head, body, _ := strings.Cut(golden, "\n")
	var pinned int
	if _, err := fmt.Sscanf(head, "format %d", &pinned); err != nil || head != fmt.Sprintf("format %d", pinned) {
		return fmt.Sprintf("%s нет или в нём нет первой строки «format N»: положи в него блок выше", saveShapeFile), pin(format)
	}
	var keys []string
	if b := strings.TrimRight(body, "\n"); b != "" {
		keys = strings.Split(b, "\n")
	}
	diff := shapeDiff(keys, shape)
	switch {
	case pinned == format && diff == "":
		return "", ""
	case pinned == format:
		return fmt.Sprintf("структура Save изменилась (%s), а SaveFormat всё ещё %d. Правило владельца (ITGAME-169): "+
			"любое добавленное, убранное или изменённое поле Save поднимает формат, миграций нет. "+
			"Подними SaveFormat в save.go до %d и замени %s блоком выше", diff, format, format+1, saveShapeFile), pin(format + 1)
	case pinned > format:
		return fmt.Sprintf("%s закреплён за форматом %d, а SaveFormat = %d: подними SaveFormat в save.go до %d",
			saveShapeFile, pinned, format, pinned), ""
	default:
		return fmt.Sprintf("SaveFormat поднят до %d, а %s ещё формата %d: замени его блоком выше",
			format, saveShapeFile, pinned), pin(format)
	}
}

// shapeDiff — «+строка» новых и «-строка» пропавших через запятую; "" — наборы совпали.
func shapeDiff(pinned, cur []string) string {
	var d []string
	for _, l := range cur {
		if !slices.Contains(pinned, l) {
			d = append(d, "+"+l)
		}
	}
	for _, l := range pinned {
		if !slices.Contains(cur, l) {
			d = append(d, "-"+l)
		}
	}
	return strings.Join(d, ", ")
}

// Обход слепка по правилам encoding/json: тег и имя поля, json:"-", неэкспортируемые, опции тега,
// указатель, срез, карта, именованный тип — его kind.
func TestSaveShapeWalk(t *testing.T) {
	type leaf struct {
		A      int
		hidden int
	}
	type probe struct {
		Plain string
		Count int             `json:"count"`
		Skip  int             `json:"-"`
		Opt   *leaf           `json:"opt,omitempty"`
		List  []leaf          `json:"list"`
		Index map[string]leaf `json:"index"`
		Kind  Phase
		inner int
	}
	got := jsonShape(t, reflect.TypeFor[probe]())
	want := []string{
		"Kind string",
		"Plain string",
		"count int",
		"index map[string]struct",
		"index{}.A int",
		"list []struct",
		"list[].A int",
		"opt *struct omitempty",
		"opt.A int",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("слепок probe:\n%s\nхотим:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// Вердикт слепка: новое поле без подъёма формата красное и печатает слепок следующего формата;
// он же, вставленный без подъёма, остаётся красным и ничего не печатает; подъём перепинивается.
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
		{"поле добавлено без подъёма", pinned(1, "a int"), 1, false, pinned(2, "a int", "b string"), "Подними SaveFormat в save.go до 2"},
		{"слепок вставлен без подъёма", pinned(2, "a int", "b string"), 1, false, "", "подними SaveFormat в save.go до 2"},
		{"подъём со сменой структуры", pinned(1, "a int"), 2, false, pinned(2, "a int", "b string"), "SaveFormat поднят до 2"},
		{"подъём без смены структуры", pinned(1, "a int", "b string"), 2, false, pinned(2, "a int", "b string"), "SaveFormat поднят до 2"},
		{"слепка нет", "", 1, false, pinned(1, "a int", "b string"), "нет первой строки"},
	} {
		fix, file := shapeVerdict(tc.golden, tc.format, shape)
		if (fix == "") != tc.ok || file != tc.file || !strings.Contains(fix, tc.hint) {
			t.Errorf("%s: fix %q, file %q; хотим ok=%v, file %q, fix с %q", tc.name, fix, file, tc.ok, tc.file, tc.hint)
		}
	}
}
