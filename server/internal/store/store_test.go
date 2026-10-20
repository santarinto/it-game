package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"

	"itdirector/internal/metrics"
)

func newTestStore(t *testing.T, ttl time.Duration) *Store {
	t.Helper()
	s, err := New(t.TempDir(), ttl)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestPutLoadRoundtrip(t *testing.T) {
	s := newTestStore(t, time.Hour)
	gen, _ := s.Begin("sid-12345678")
	if !s.Put("sid-12345678", gen, []byte(`{"a":1}`), time.Now()) {
		t.Fatal("Put отклонён")
	}
	data, ok := s.Load("sid-12345678")
	if !ok || string(data) != `{"a":1}` {
		t.Fatalf("Load: %q %v", data, ok)
	}
}

func TestLoadSurvivesRestart(t *testing.T) {
	s := newTestStore(t, time.Hour)
	gen, _ := s.Begin("restart-1234")
	old := time.Now().Add(-time.Minute)
	s.Put("restart-1234", gen, []byte(`{"day":7}`), old)

	// «Рестарт процесса»: новый стор на том же каталоге.
	s2, err := New(s.dir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	data, ok := s2.Load("restart-1234")
	if !ok || string(data) != `{"day":7}` {
		t.Fatalf("сейв не пережил рестарт: %q %v", data, ok)
	}
	// Время сейва тоже пережило — TTL считается от него.
	s2.mu.Lock()
	at := s2.entries["restart-1234"].savedAt
	s2.mu.Unlock()
	if !at.Equal(old) {
		t.Fatalf("savedAt потерялся: %v, хотим %v", at, old)
	}
}

func TestTTLExpiry(t *testing.T) {
	s := newTestStore(t, 30*time.Millisecond)
	gen, _ := s.Begin("shortlived-1")
	s.Put("shortlived-1", gen, []byte(`{}`), time.Now())
	if _, ok := s.Load("shortlived-1"); !ok {
		t.Fatal("свежий сейв не читается")
	}
	time.Sleep(50 * time.Millisecond)
	if _, ok := s.Load("shortlived-1"); ok {
		t.Fatal("протухший сейв читается")
	}
	if _, err := os.Stat(s.path("shortlived-1")); !os.IsNotExist(err) {
		t.Fatal("файл протухшего сейва не удалён")
	}
}

func TestBeginEvictsOldOwner(t *testing.T) {
	s := newTestStore(t, time.Hour)
	gen1, kick1 := s.Begin("duel-1234567")
	s.Put("duel-1234567", gen1, []byte(`"first"`), time.Now())

	gen2, kick2 := s.Begin("duel-1234567")
	select {
	case <-kick1:
	default:
		t.Fatal("первого владельца не пнули")
	}
	if gen1 == gen2 {
		t.Fatal("поколения должны расти")
	}
	if s.Put("duel-1234567", gen1, []byte(`"stale"`), time.Now()) {
		t.Fatal("устаревшее поколение записало сейв")
	}
	if !s.Put("duel-1234567", gen2, []byte(`"fresh"`), time.Now()) {
		t.Fatal("новое поколение не записало")
	}
	data, _ := s.Load("duel-1234567")
	if string(data) != `"fresh"` {
		t.Fatalf("в сейве %q, хотим fresh", data)
	}
	select {
	case <-kick2:
		t.Fatal("кикнули действующего владельца")
	default:
	}
}

func TestDeleteKicksOwner(t *testing.T) {
	s := newTestStore(t, time.Hour)
	_, kick := s.Begin("gone-1234567")
	s.Put("gone-1234567", 1, []byte("{}"), time.Now())
	s.Delete("gone-1234567")
	select {
	case <-kick:
	default:
		t.Fatal("Delete не пнул владельца")
	}
	if _, ok := s.Load("gone-1234567"); ok {
		t.Fatal("Delete не убрал сейв")
	}
}

// Финал партии (ITGAME-51): владелец удаляет свой сейв, но сессию не
// отдаёт — пинка нет, следующий Put того же поколения проходит, а захват
// другим актором по-прежнему пинает.
func TestFinishKeepsOwnership(t *testing.T) {
	s := newTestStore(t, time.Hour)
	gen, kick := s.Begin("final-123456")
	s.Put("final-123456", gen, []byte(`{"day":3}`), time.Now())
	if !s.Finish("final-123456", gen) {
		t.Fatal("Finish владельца отклонён")
	}
	select {
	case <-kick:
		t.Fatal("Finish пнул самого владельца")
	default:
	}
	if _, ok := s.Load("final-123456"); ok {
		t.Fatal("Finish не убрал сейв из памяти")
	}
	s2, err := New(s.dir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s2.Load("final-123456"); ok {
		t.Fatal("Finish не убрал сейв с диска")
	}
	if !s.Put("final-123456", gen, []byte(`{"day":1}`), time.Now()) {
		t.Fatal("после Finish владелец потерял право писать (restart в той же сессии)")
	}
	if data, ok := s.Load("final-123456"); !ok || string(data) != `{"day":1}` {
		t.Fatalf("новый сейв после Finish: %q %v", data, ok)
	}
	s.Begin("final-123456")
	select {
	case <-kick:
	default:
		t.Fatal("захват после Finish не пнул прежнего владельца")
	}
}

// Устаревший актор, дошедший до финала после захвата, не стирает сейв
// нового владельца и не пинает его.
func TestFinishByStaleOwnerIsNoop(t *testing.T) {
	s := newTestStore(t, time.Hour)
	gen1, _ := s.Begin("stale-123456")
	s.Put("stale-123456", gen1, []byte(`{"v":1}`), time.Now())
	gen2, kick2 := s.Begin("stale-123456")
	s.Put("stale-123456", gen2, []byte(`{"v":2}`), time.Now())
	if s.Finish("stale-123456", gen1) {
		t.Fatal("Finish устаревшего поколения принят")
	}
	select {
	case <-kick2:
		t.Fatal("Finish устаревшего поколения пнул нового владельца")
	default:
	}
	if data, ok := s.Load("stale-123456"); !ok || string(data) != `{"v":2}` {
		t.Fatalf("сейв нового владельца пострадал: %q %v", data, ok)
	}
}

func TestPruneOnStart(t *testing.T) {
	dir := t.TempDir()
	// Протухший и свежий файлы руками.
	old := `{"savedAt":"2000-01-01T00:00:00Z","data":{"x":1}}`
	fresh := `{"savedAt":"2999-01-01T00:00:00Z","data":{"x":2}}`
	os.WriteFile(filepath.Join(dir, "old-1234567.json"), []byte(old), 0o600)
	os.WriteFile(filepath.Join(dir, "fresh-1234.json"), []byte(fresh), 0o600)
	os.WriteFile(filepath.Join(dir, "мусор.json"), []byte("junk"), 0o600)

	if _, err := New(dir, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "old-1234567.json")); !os.IsNotExist(err) {
		t.Fatal("протухший файл не вычищен")
	}
	if _, err := os.Stat(filepath.Join(dir, "fresh-1234.json")); err != nil {
		t.Fatal("свежий файл удалён")
	}
	if _, err := os.Stat(filepath.Join(dir, "мусор.json")); !os.IsNotExist(err) {
		t.Fatal("файл с кривым sid не вычищен")
	}
}

func TestValidSID(t *testing.T) {
	for _, ok := range []string{"abc123DE-f", "0123456789abcdef", "b456789012345678901234567890123456789012345678901234567890123x"} {
		if !ValidSID(ok) {
			t.Fatalf("%q должен быть валиден", ok)
		}
	}
	for _, bad := range []string{"", "short", "../etc/passwd", "с пробелами", "sid.json"} {
		if ValidSID(bad) {
			t.Fatalf("%q не должен быть валиден", bad)
		}
	}
}

// TestBeginWarmsFromDisk — Begin до Load (ITGAME-46): после рестарта записи
// в памяти нет, Begin сам поднимает сейв с диска, и Load под владельцем его
// отдаёт, а не «нет сейва» от пустой записи.
func TestBeginWarmsFromDisk(t *testing.T) {
	s := newTestStore(t, time.Hour)
	gen, _ := s.Begin("warm-1234")
	s.Put("warm-1234", gen, []byte(`{"day":3}`), time.Now())
	s2, err := New(s.dir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	gen2, kick := s2.Begin("warm-1234")
	data, ok := s2.Load("warm-1234")
	if !ok || string(data) != `{"day":3}` {
		t.Fatalf("Begin на холодном sid потерял сейв: %q %v", data, ok)
	}
	if !s2.Put("warm-1234", gen2, []byte(`{"day":4}`), time.Now()) {
		t.Fatal("владелец после Begin+Load не может писать")
	}
	select {
	case <-kick:
		t.Fatal("Load пнул собственного владельца")
	default:
	}
}

// TestBeginForgetsExpired — истёкший сейв в памяти Begin забывает сам: Load
// после Begin не удаляет запись нового владельца и не закрывает его kick.
func TestBeginForgetsExpired(t *testing.T) {
	s := newTestStore(t, 30*time.Millisecond)
	gen, _ := s.Begin("expire-1234")
	s.Put("expire-1234", gen, []byte(`{}`), time.Now())
	time.Sleep(50 * time.Millisecond)
	gen2, kick := s.Begin("expire-1234")
	if _, ok := s.Load("expire-1234"); ok {
		t.Fatal("истёкший сейв читается")
	}
	select {
	case <-kick:
		t.Fatal("Load истёкшего сейва пнул нового владельца")
	default:
	}
	if !s.Put("expire-1234", gen2, []byte(`{}`), time.Now()) {
		t.Fatal("новый владелец потерял запись")
	}
}

// TestRewriteKeepsOwnerAndSavedAt — Rewrite (ITGAME-154) правит данные в памяти и
// на диске, но не savedAt, не поколение и не kick владельца; сейва нет — false.
func TestRewriteKeepsOwnerAndSavedAt(t *testing.T) {
	s := newTestStore(t, time.Hour)
	const sid = "rewrite-1234"
	gen, kick := s.Begin(sid)
	old := time.Now().Add(-time.Minute)
	s.Put(sid, gen, []byte(`{"a":1}`), old)

	if !s.Rewrite(sid, []byte(`{"a":1}`), []byte(`{"a":2}`)) {
		t.Fatal("Rewrite существующего сейва отклонён")
	}
	if data, ok := s.Load(sid); !ok || string(data) != `{"a":2}` {
		t.Fatalf("память после Rewrite: %q %v", data, ok)
	}
	raw, err := os.ReadFile(s.path(sid))
	if err != nil {
		t.Fatal(err)
	}
	var env diskEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if string(env.Data) != `{"a":2}` || !env.SavedAt.Equal(old) {
		t.Fatalf("файл после Rewrite: data=%s savedAt=%v (ждали %v)", env.Data, env.SavedAt, old)
	}

	// рестарт: записи в памяти нет — Rewrite поднимает сейв с диска
	s2, err := New(s.dir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if data, ok := s2.Load(sid); !ok || string(data) != `{"a":2}` {
		t.Fatalf("после рестарта: %q %v", data, ok)
	}
	s3, err := New(s.dir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !s3.Rewrite(sid, []byte(`{"a":2}`), []byte(`{"a":3}`)) {
		t.Fatal("Rewrite без записи в памяти (с диска) отклонён")
	}
	if data, ok := s3.Load(sid); !ok || string(data) != `{"a":3}` {
		t.Fatalf("после Rewrite с диска: %q %v", data, ok)
	}

	// владелец не тронут: kick открыт, его Put проходит
	select {
	case <-kick:
		t.Fatal("Rewrite пнул владельца")
	default:
	}
	if !s.Put(sid, gen, []byte(`{"a":4}`), time.Now()) {
		t.Fatal("после Rewrite владелец потерял право писать")
	}
	if data, ok := s.Load(sid); !ok || string(data) != `{"a":4}` {
		t.Fatalf("Put после Rewrite: %q %v", data, ok)
	}

	// нет сейва — нет и файла
	if s.Rewrite("rewrite-none-1", []byte(`{}`), []byte(`{}`)) {
		t.Fatal("Rewrite без сейва вернул true")
	}
	if _, err := os.Stat(s.path("rewrite-none-1")); err == nil {
		t.Fatal("Rewrite без сейва создал файл")
	}
	if s.Rewrite("x", []byte(`{}`), []byte(`{}`)) {
		t.Fatal("Rewrite с негодным sid вернул true")
	}
	// сейв сменился после чтения (актор записал прогресс): правка по старым байтам отклоняется
	if s.Rewrite(sid, []byte(`{"a":2}`), []byte(`{"a":9}`)) {
		t.Fatal("Rewrite по устаревшим байтам затёр новый сейв")
	}
	if data, _ := s.Load(sid); string(data) != `{"a":4}` {
		t.Fatalf("после отказа Rewrite: %q, хотим {\"a\":4}", data)
	}
	if !s.Finish(sid, gen) {
		t.Fatal("Finish владельца отклонён")
	}
	if s.Rewrite(sid, []byte(`{"a":4}`), []byte(`{}`)) {
		t.Fatal("Rewrite после Finish вернул true")
	}
}

// tmpLeft — временные файлы сейвов, оставшиеся в каталоге.
func tmpLeft(t *testing.T, dir string) []string {
	t.Helper()
	m, err := filepath.Glob(filepath.Join(dir, "*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// Вытесненный актор прошёл проверку gen, но файл ещё не записал — в это время
// вкладку забрал новый актор и сохранился (ITGAME-183). Его запись не должна
// лечь на диск поверх свежего сейва: после рестарта игрок получил бы старую партию.
func TestStalePutLosesDiskToNewOwner(t *testing.T) {
	s := newTestStore(t, time.Hour)
	const sid = "takeover-123"
	gen1, _ := s.Begin(sid)
	s.Put(sid, gen1, []byte(`"v1"`), time.Now())

	s.beforeCommit = func(string) {
		s.beforeCommit = nil
		gen2, _ := s.Begin(sid)
		if !s.Put(sid, gen2, []byte(`"fresh"`), time.Now()) {
			t.Error("новый владелец не записал")
		}
	}
	if s.Put(sid, gen1, []byte(`"stale"`), time.Now()) {
		t.Error("Put вытесненного владельца принят")
	}
	if data, _ := s.Load(sid); string(data) != `"fresh"` {
		t.Fatalf("в памяти %s, хотим fresh", data)
	}
	s2, err := New(s.dir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if data, ok := s2.Load(sid); !ok || string(data) != `"fresh"` {
		t.Fatalf("после рестарта %s %v, хотим fresh", data, ok)
	}
	if left := tmpLeft(t, s.dir); len(left) > 0 {
		t.Fatalf("остались временные файлы: %v", left)
	}
}

// Сейв удалили (abandon, финал по TTL), пока Put владельца был в полёте: файл
// не должен воскреснуть и подняться после рестарта.
func TestPutRacingDeleteLeavesNoFile(t *testing.T) {
	s := newTestStore(t, time.Hour)
	const sid = "deleted-1234"
	gen, _ := s.Begin(sid)
	s.Put(sid, gen, []byte(`"v1"`), time.Now())

	s.beforeCommit = func(string) {
		s.beforeCommit = nil
		s.Delete(sid)
	}
	if s.Put(sid, gen, []byte(`"v2"`), time.Now()) {
		t.Error("Put в удалённый сейв принят")
	}
	if _, err := os.Stat(s.path(sid)); !os.IsNotExist(err) {
		t.Fatalf("удалённый сейв воскрес на диске (err=%v)", err)
	}
	if left := tmpLeft(t, s.dir); len(left) > 0 {
		t.Fatalf("остались временные файлы: %v", left)
	}
}

// Временный файл, брошенный падением процесса между записью и переименованием,
// стартовая чистка убирает: имена у записей свои, сами они не перезапишутся.
func TestPruneRemovesTmp(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"crash-1234.json.tmp", "crash-1234.json.123456.tmp"} {
		os.WriteFile(filepath.Join(dir, name), []byte(`{"savedAt":"2999-01-01T00:00:00Z","da`), 0o600)
	}
	if _, err := New(dir, time.Hour); err != nil {
		t.Fatal(err)
	}
	if left := tmpLeft(t, dir); len(left) > 0 {
		t.Fatalf("временные файлы пережили старт: %v", left)
	}
}

// histCount — число наблюдений гистограммы.
func histCount(t *testing.T, h prometheus.Histogram) uint64 {
	t.Helper()
	var m dto.Metric
	if err := h.Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetHistogram().GetSampleCount()
}

// Метрики сейвов (ITGAME-189): каждый Put в гистограмме длительности, исход —
// ok или stale (сессию забрал другой актор).
func TestPutCountsSaves(t *testing.T) {
	s := newTestStore(t, time.Hour)
	const sid = "metrics-1234"
	ok0 := testutil.ToFloat64(metrics.Saves.WithLabelValues("ok"))
	stale0 := testutil.ToFloat64(metrics.Saves.WithLabelValues("stale"))
	n0 := histCount(t, metrics.SaveSeconds)

	gen, _ := s.Begin(sid)
	s.Put(sid, gen, []byte(`{}`), time.Now())
	s.Begin(sid)
	s.Put(sid, gen, []byte(`{}`), time.Now())

	if d := testutil.ToFloat64(metrics.Saves.WithLabelValues("ok")) - ok0; d != 1 {
		t.Errorf("saves ok +%v, хотим +1", d)
	}
	if d := testutil.ToFloat64(metrics.Saves.WithLabelValues("stale")) - stale0; d != 1 {
		t.Errorf("saves stale +%v, хотим +1", d)
	}
	if d := histCount(t, metrics.SaveSeconds) - n0; d != 2 {
		t.Errorf("save_seconds +%d наблюдений, хотим +2", d)
	}
}

// Файл сейва не записался (каталог пропал) — ошибка в счётчике, данные в памяти.
func TestPutCountsWriteErrors(t *testing.T) {
	s := newTestStore(t, time.Hour)
	const sid = "metrics-err-1"
	gen, _ := s.Begin(sid)
	if err := os.RemoveAll(s.dir); err != nil {
		t.Fatal(err)
	}
	e0 := testutil.ToFloat64(metrics.SaveErrors.WithLabelValues("write"))
	if !s.Put(sid, gen, []byte(`{}`), time.Now()) {
		t.Fatal("Put без каталога отклонён — память должна принять сейв")
	}
	if d := testutil.ToFloat64(metrics.SaveErrors.WithLabelValues("write")) - e0; d != 1 {
		t.Errorf("save_errors write +%v, хотим +1", d)
	}
}
