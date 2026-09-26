package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"
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
