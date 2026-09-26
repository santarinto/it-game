package game

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"strconv"
)

// Сценарии-фикстуры (ITGAME-26): старт партии в готовом состоянии —
// «а что стало после покупки», регрессии на конкретном этапе игры.
// Файл — дельта над новой игрой: отсутствующие поля берутся от New(cfg)
// с данным сидом, присутствующие — заменяются. Config фикстурой не
// перекрашивается: сложность пришла с параметром difficulty подключения.

//go:embed fixtures/*.json
var fixtureFS embed.FS

// FixtureNames — доступные сценарии в алфавитном порядке (для
// /api/debug/fixtures и валидации ?scenario=).
func FixtureNames() []string {
	matches, _ := fs.Glob(fixtureFS, "fixtures/*.json")
	names := make([]string, 0, len(matches))
	for _, m := range matches {
		// "fixtures/soft_lock.json" → "soft_lock"
		name := m[len("fixtures/") : len(m)-len(".json")]
		names = append(names, name)
	}
	return names
}

// FixtureExists — есть ли такой сценарий.
func FixtureExists(name string) bool {
	for _, n := range FixtureNames() {
		if n == name {
			return true
		}
	}
	return false
}

// ParseSeed — сид из строки запроса (?seed=1234). Пустая строка — не
// задан (ok=false). Некорректное число — тоже не задан: тихий откат к
// случайному сиду, чтобы битый параметр не рвал подключение.
func ParseSeed(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	seed, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return seed, true
}

// NewFixture — новая партия в состоянии фикстуры name: база New(cfg, seed),
// поверх — дельта из JSON. Возвращает валидную игру (Restore проверяет
// инварианты) или ошибку «нет такого сценария / битая дельта».
func NewFixture(cfg Config, name, seedStr string) (*Game, error) {
	if !FixtureExists(name) {
		return nil, fmt.Errorf("bad_scenario %q: есть %v", name, FixtureNames())
	}
	raw, err := fixtureFS.ReadFile("fixtures/" + name + ".json")
	if err != nil {
		return nil, err
	}
	seed, ok := ParseSeed(seedStr)
	if !ok {
		seed = rand.Uint64()
	}
	base := NewSeeded(cfg, seed).Export()
	if err := json.Unmarshal(raw, &base); err != nil {
		return nil, fmt.Errorf("фикстура %s: %w", name, err)
	}
	base.Config = cfg // дельта конфиг не меняет: сложность решает difficulty=
	g, err := Restore(base)
	if err != nil {
		return nil, fmt.Errorf("фикстура %s: %w", name, err)
	}
	return g, nil
}
