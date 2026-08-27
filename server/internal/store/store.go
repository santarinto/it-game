// Package store — сейвы сессий (ITGAME-8): память + атомарные файлы на
// диске (деплой перезапускает юнит — сейвы должны пережить рестарт).
// PostgreSQL не используется: геймплей от БД не зависит.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Store — каталог сейвов. Потокобезопасен: акторы сессий зовут Put/Load
// из своих горутин, HTTP-хендлеры — Begin при переподключении.
type Store struct {
	dir string
	ttl time.Duration

	mu      sync.Mutex
	entries map[string]*entry
}

// entry — сейв в памяти. gen — поколение владельца: растёт на Begin,
// устаревший актор не может перезаписать чужой сейв. kick закрывается,
// когда сессию забрал новый актор (дубликат вкладки), — старый закрывает
// соединение.
type entry struct {
	gen     uint64
	data    []byte
	savedAt time.Time
	kick    chan struct{}
}

// diskEnvelope — формат файла: обёртка с временем сейва для TTL-чисток
// без разбора полезной нагрузки.
type diskEnvelope struct {
	SavedAt time.Time       `json:"savedAt"`
	Data    json.RawMessage `json:"data"`
}

func New(dir string, ttl time.Duration) (*Store, error) {
	if dir == "" {
		return nil, errors.New("store: пустой каталог")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("store: %w", err)
	}
	s := &Store{dir: dir, ttl: ttl, entries: map[string]*entry{}}
	s.pruneDisk()
	return s, nil
}

// ValidSID — сеансовый ключ клиента: цифробуквенный с дефисами,
// 8–64 символа (uuid и improvised-генераторы проходят).
func ValidSID(sid string) bool {
	if len(sid) < 8 || len(sid) > 64 {
		return false
	}
	for _, r := range sid {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-':
		default:
			return false
		}
	}
	return true
}

func (s *Store) path(sid string) string { return filepath.Join(s.dir, sid+".json") }

// Load — данные сейва или false (нет / истёк / битый). Истёкший удаляется.
func (s *Store) Load(sid string) ([]byte, bool) {
	if !ValidSID(sid) {
		return nil, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.entries[sid]; ok {
		if s.expired(e) {
			s.deleteLocked(sid)
			return nil, false
		}
		return append([]byte(nil), e.data...), true
	}
	var env diskEnvelope
	raw, err := os.ReadFile(s.path(sid))
	if err != nil || json.Unmarshal(raw, &env) != nil || len(env.Data) == 0 {
		if err == nil { // битый файл — мусор
			s.removeFile(sid)
		}
		return nil, false
	}
	if time.Since(env.SavedAt) > s.ttl {
		s.removeFile(sid)
		return nil, false
	}
	s.entries[sid] = &entry{data: []byte(env.Data), savedAt: env.SavedAt}
	return append([]byte(nil), env.Data...), true
}

// Begin — заявить владение сессией. Возвращает номер поколения (для Put)
// и канал, который закроется, если сессию заберёт другой актор.
func (s *Store) Begin(sid string) (uint64, <-chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[sid]
	if !ok {
		e = &entry{}
		s.entries[sid] = e
	}
	if e.kick != nil {
		close(e.kick) // предыдущий владелец: сессию забрали
	}
	e.gen++
	kick := make(chan struct{})
	e.kick = kick
	return e.gen, kick
}

// Put — записать сейв от имени поколения gen. false — сессию уже забрал
// другой актор, писавший обязан завершиться.
func (s *Store) Put(sid string, gen uint64, data []byte, at time.Time) bool {
	if !ValidSID(sid) {
		return false
	}
	s.mu.Lock()
	e, ok := s.entries[sid]
	if !ok || e.gen != gen {
		s.mu.Unlock()
		return false
	}
	e.data = append([]byte(nil), data...)
	e.savedAt = at
	s.mu.Unlock()

	env, err := json.Marshal(diskEnvelope{SavedAt: at, Data: data})
	if err != nil {
		log.Printf("сейв %s: сериализация: %v", sid, err)
		return true // данные в памяти живы, игра продолжается
	}
	tmp := s.path(sid) + ".tmp"
	if err := os.WriteFile(tmp, env, 0o600); err != nil {
		log.Printf("сейв %s: запись: %v", sid, err)
		return true
	}
	if err := os.Rename(tmp, s.path(sid)); err != nil {
		log.Printf("сейв %s: переименование: %v", sid, err)
	}
	return true
}

// Delete — убрать сейв (abandon, терминальная фаза, истёкший TTL).
func (s *Store) Delete(sid string) {
	if !ValidSID(sid) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleteLocked(sid)
}

func (s *Store) deleteLocked(sid string) {
	if e, ok := s.entries[sid]; ok {
		if e.kick != nil {
			close(e.kick)
			e.kick = nil
		}
		delete(s.entries, sid)
	}
	s.removeFile(sid)
}

func (s *Store) removeFile(sid string) {
	if err := os.Remove(s.path(sid)); err != nil && !os.IsNotExist(err) {
		log.Printf("сейв %s: удаление: %v", sid, err)
	}
}

func (s *Store) expired(e *entry) bool { return time.Since(e.savedAt) > s.ttl }

// pruneDisk — стартовая чистка: протухшие и битые файлы со старта процесса.
func (s *Store) pruneDisk() {
	matches, _ := filepath.Glob(filepath.Join(s.dir, "*.json"))
	for _, p := range matches {
		base := strings.TrimSuffix(filepath.Base(p), ".json")
		if !ValidSID(base) {
			os.Remove(p)
			continue
		}
		raw, err := os.ReadFile(p)
		var env diskEnvelope
		if err != nil || json.Unmarshal(raw, &env) != nil || time.Since(env.SavedAt) > s.ttl {
			os.Remove(p)
		}
	}
}
