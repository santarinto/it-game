// Package saveshape — пин структуры файла сейва (ITGAME-169, ITGAME-175): тип обходится так, как
// encoding/json называет его ключи, и сверяется со слепком в testdata пакета; расхождение при том
// же game.SaveFormat красное. Файл сейва — ws.sessionSave, внутри него game.Save; у каждого свой
// слепок рядом со своим типом (TestSaveShape в game, TestSessionSaveShape в ws), обходчик и вердикт
// одни — здесь. Импортируют только тесты: тестовые файлы одного пакета другому не видны, а game
// не может импортировать ws (ws импортирует game).
package saveshape

import (
	"encoding"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// saveGo — где живёт SaveFormat: его называют сообщения обоих слепков.
const saveGo = "server/internal/game/save.go"

// Pin — слепок одного типа файла сейва: «format N», затем ключи JSON с типами.
type Pin struct {
	Root   reflect.Type // закреплённый тип
	Pkg    string       // каталог пакета теста от корня репо (server/internal/game) — для сообщений
	File   string       // слепок от каталога пакета: testdata/save_shape.txt
	Format int          // game.SaveFormat
	// Skip — типы, закреплённые своим слепком: поле такого типа — строка «ключ тип» с именем типа,
	// внутрь обход не идёт (game.Save в sessionSave — его держит слепок game).
	Skip []reflect.Type
}

// Check — красный, когда структура разошлась со слепком при том же Format (новое поле без
// подъёма) и когда Format и слепок разных форматов (подъём без нового слепка или слепок без
// подъёма). Слепок, который правильно просто вставить, печатается в stdout.
func (p Pin) Check(t testing.TB) {
	t.Helper()
	if wd, err := os.Getwd(); err != nil || !strings.HasSuffix(filepath.ToSlash(wd), "/"+p.Pkg) {
		t.Fatalf("тест идёт не в %s (каталог %q, %v): путь слепка в сообщениях был бы неверным", p.Pkg, wd, err)
	}
	raw, err := os.ReadFile(p.File)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	fix, file := p.verdict(string(raw), p.shape(t))
	if fix == "" {
		return
	}
	if file != "" {
		// В stdout, а не в t.Fatal: go test сдвигает продолжение сообщения на 8 пробелов, а блок
		// между строками ----- вставляется в файл как есть.
		fmt.Printf("----- %s -----\n%s----- конец %s -----\n", p.path(), file, p.path())
	}
	t.Fatal(fix)
}

// path — слепок от корня репо.
func (p Pin) path() string { return p.Pkg + "/" + p.File }

var (
	jsonMarshaler = reflect.TypeFor[json.Marshaler]()
	textMarshaler = reflect.TypeFor[encoding.TextMarshaler]()
)

// opaque — тип, внутрь которого слепок не смотрит, а называет его по имени: закреплённый своим
// слепком (Skip) или со своим MarshalJSON/MarshalText — его JSON пишет метод, а не поля (time.Time).
func (p Pin) opaque(typ reflect.Type) bool {
	if slices.Contains(p.Skip, typ) {
		return true
	}
	for _, m := range []reflect.Type{jsonMarshaler, textMarshaler} {
		if typ.Implements(m) || reflect.PointerTo(typ).Implements(m) {
			return true
		}
	}
	return false
}

// shape — ключи JSON типа Root так, как их пишет encoding/json: имя из json-тега, без него — имя
// поля; неэкспортируемые и json:"-" пропущены. Строка — «путь тип[ опции тега]»: тип листа — его
// kind (Phase — string, Seed — uint64), * [] [N] map[K] — указатель, срез, массив, карта, struct —
// структура, её поля идут своими строками (путь через точку; элемент среза — «[]», значение карты
// — «{}»); opaque-тип — его имя (game.Save, time.Time), без своих строк. Отсортировано: порядок
// полей в JSON не важен.
func (p Pin) shape(t testing.TB) []string {
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
			for !p.opaque(inner) {
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
			opaque := p.opaque(inner)
			if opaque {
				typ += inner.String()
			} else {
				typ += inner.Kind().String()
			}
			line := prefix + name + " " + typ
			if opts != "" {
				line += " " + opts
			}
			lines = append(lines, line)
			if inner.Kind() == reflect.Struct && !opaque {
				walk(prefix+sub+".", inner)
			}
		}
	}
	walk("", p.Root)
	slices.Sort(lines)
	return lines
}

// verdict — сверка слепка golden (содержимое файла, "" — файла нет) со структурой shape при
// SaveFormat = Format. fix — что сделать ("" — сходится). file — новое содержимое слепка, когда
// его правильно просто вставить; "" — вставлять нечего: сначала поднять SaveFormat (слепок,
// вставленный без подъёма формата, не должен позеленеть) или восстановить из git пропавший
// слепок (созданный заново по текущей структуре, он позеленел бы без подъёма).
func (p Pin) verdict(golden string, shape []string) (fix, file string) {
	format := p.Format
	pin := func(n int) string { return fmt.Sprintf("format %d\n%s\n", n, strings.Join(shape, "\n")) }
	head, body, _ := strings.Cut(golden, "\n")
	var pinned int
	if _, err := fmt.Sscanf(head, "format %d", &pinned); err != nil || head != fmt.Sprintf("format %d", pinned) {
		// Блока для вставки нет намеренно: слепок, созданный заново по текущей структуре при том же
		// SaveFormat, позеленел бы без подъёма формата.
		return fmt.Sprintf("%s нет или в нём нет первой строки «format N»: восстанови его из git "+
			"(git checkout -- %s), заново по структуре он не создаётся — иначе новое поле "+
			"позеленело бы без подъёма SaveFormat", p.path(), p.path()), ""
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
		return fmt.Sprintf("структура %s изменилась (%s), а SaveFormat всё ещё %d. Правило владельца (ITGAME-169, "+
			"ITGAME-175): любое добавленное, убранное или изменённое поле файла сейва — game.Save и ws.sessionSave "+
			"вокруг него — поднимает формат, миграций нет. Подними SaveFormat в %s до %d и замени %s блоком выше",
			p.Root, diff, format, saveGo, format+1, p.path()), pin(format + 1)
	case pinned > format:
		return fmt.Sprintf("%s закреплён за форматом %d, а SaveFormat = %d: подними SaveFormat в %s до %d",
			p.path(), pinned, format, saveGo, pinned), ""
	default:
		return fmt.Sprintf("SaveFormat поднят до %d, а %s ещё формата %d: замени его блоком выше",
			format, p.path(), pinned), pin(format)
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
