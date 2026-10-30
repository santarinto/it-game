package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// KnownAchievementIDs — 12 канонических достижений игры (ITGAME-10 / ITGAME-132).
var KnownAchievementIDs = map[string]bool{
	"first_hire":    true,
	"first_day":     true,
	"coffee_break":  true,
	"star_hunter":   true,
	"survivor_10":   true,
	"three_offices": true,
	"full_staff":    true,
	"core_max":      true,
	"network_36":    true,
	"millionaire":   true,
	"clean_win":     true,
	"hardcore_win":  true,
}

// DifficultyStats — статистика игрока по одной сложности (зеркало DifficultyStats в TS).
type DifficultyStats struct {
	Runs         int   `json:"runs"`
	Wins         int   `json:"wins"`
	Bankruptcies int   `json:"bankruptcies"`
	TimeUps      int   `json:"timeUps"`
	BestDay      int   `json:"bestDay"`
	BestWinDay   *int  `json:"bestWinDay"`
	BestBalance  int64 `json:"bestBalance"`
}

// MetaStats — общая статистика игрока (зеркало MetaStats в TS).
type MetaStats struct {
	TotalRuns    int                        `json:"totalRuns"`
	TotalWins    int                        `json:"totalWins"`
	TotalLosses  int                        `json:"totalLosses"`
	PeakBalance  int64                      `json:"peakBalance"`
	PeakDay      int                        `json:"peakDay"`
	ByDifficulty map[string]DifficultyStats `json:"byDifficulty"`
}

// DefaultMetaStats возвращает чистую структуру со всеми 4 сложностями.
func DefaultMetaStats() MetaStats {
	return MetaStats{
		ByDifficulty: map[string]DifficultyStats{
			"easy":     {},
			"normal":   {},
			"hard":     {},
			"hardcore": {},
		},
	}
}

// AchievementState — состояние полученного достижения (зеркало AchievementState в TS).
type AchievementState struct {
	ID         string `json:"id"`
	UnlockedAt int64  `json:"unlockedAt"` // epoch ms
}

// PlayerMeta — мета-прогресс игрока из таблицы player_meta.
type PlayerMeta struct {
	Player       string                      `json:"player"`
	CreatedAt    time.Time                   `json:"createdAt"`
	UpdatedAt    time.Time                   `json:"updatedAt"`
	TotalRuns    int                         `json:"totalRuns"`
	TotalWins    int                         `json:"totalWins"`
	TotalLosses  int                         `json:"totalLosses"`
	PeakBalance  int64                       `json:"peakBalance"`
	PeakDay      int                         `json:"peakDay"`
	Stats        MetaStats                   `json:"stats"`
	Achievements map[string]AchievementState `json:"achievements"`
}

// GetPlayerMeta читает мета-прогресс игрока по стабильному player_id.
// Если записи нет — возвращает (nil, nil).
func (d *DB) GetPlayerMeta(ctx context.Context, player string) (*PlayerMeta, error) {
	if player == "" {
		return nil, nil
	}
	var pm PlayerMeta
	var statsRaw, achsRaw []byte
	err := d.Pool.QueryRow(ctx, `
		SELECT player, created_at, updated_at, total_runs, total_wins, total_losses,
		       peak_balance, peak_day, stats, achievements
		FROM player_meta
		WHERE player = $1
	`, player).Scan(
		&pm.Player, &pm.CreatedAt, &pm.UpdatedAt, &pm.TotalRuns, &pm.TotalWins, &pm.TotalLosses,
		&pm.PeakBalance, &pm.PeakDay, &statsRaw, &achsRaw,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("player_meta get: %w", err)
	}

	pm.Stats = DefaultMetaStats()
	if len(statsRaw) > 0 && string(statsRaw) != "{}" && string(statsRaw) != "null" {
		_ = json.Unmarshal(statsRaw, &pm.Stats)
	}
	if pm.Stats.ByDifficulty == nil {
		pm.Stats.ByDifficulty = map[string]DifficultyStats{}
	}
	diffs := []string{"easy", "normal", "hard", "hardcore"}
	for _, diff := range diffs {
		if _, ok := pm.Stats.ByDifficulty[diff]; !ok {
			pm.Stats.ByDifficulty[diff] = DifficultyStats{}
		}
	}

	pm.Achievements = map[string]AchievementState{}
	if len(achsRaw) > 0 && string(achsRaw) != "{}" && string(achsRaw) != "null" {
		_ = json.Unmarshal(achsRaw, &pm.Achievements)
	}

	if pm.PeakBalance > pm.Stats.PeakBalance {
		pm.Stats.PeakBalance = pm.PeakBalance
	}
	if pm.PeakDay > pm.Stats.PeakDay {
		pm.Stats.PeakDay = pm.PeakDay
	}

	return &pm, nil
}

// UpsertPlayerMeta сохраняет или обновляет мета-прогресс игрока целиком.
func (d *DB) UpsertPlayerMeta(ctx context.Context, pm *PlayerMeta) error {
	if pm == nil || pm.Player == "" {
		return errors.New("upsert player_meta: empty player")
	}
	statsJSON, err := json.Marshal(pm.Stats)
	if err != nil {
		return fmt.Errorf("marshal stats: %w", err)
	}
	achsJSON, err := json.Marshal(pm.Achievements)
	if err != nil {
		return fmt.Errorf("marshal achievements: %w", err)
	}

	_, err = d.Pool.Exec(ctx, `
		INSERT INTO player_meta (
			player, created_at, updated_at, total_runs, total_wins, total_losses,
			peak_balance, peak_day, stats, achievements
		)
		VALUES ($1, now(), now(), $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (player) DO UPDATE SET
			updated_at   = now(),
			total_runs   = EXCLUDED.total_runs,
			total_wins   = EXCLUDED.total_wins,
			total_losses = EXCLUDED.total_losses,
			peak_balance = EXCLUDED.peak_balance,
			peak_day     = EXCLUDED.peak_day,
			stats        = EXCLUDED.stats,
			achievements = EXCLUDED.achievements
	`, pm.Player, pm.TotalRuns, pm.TotalWins, pm.TotalLosses, pm.PeakBalance, pm.PeakDay, statsJSON, achsJSON)
	if err != nil {
		return fmt.Errorf("player_meta upsert: %w", err)
	}
	return nil
}

// SeedPlayerMetaIfMissing выполняет мягкую первичную миграцию данных игрока (First-Run Seed).
// Если в базе уже есть строка для player, метод возвращает существующую запись без изменений.
// Если строки нет, клиентские ачивки фильтруются по 12 известным ключам и сохраняются.
func (d *DB) SeedPlayerMetaIfMissing(ctx context.Context, player string, seedStats MetaStats, seedAchs map[string]AchievementState) (*PlayerMeta, error) {
	if player == "" {
		return nil, errors.New("seed player_meta: empty player")
	}

	existing, err := d.GetPlayerMeta(ctx, player)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil
	}

	// Валидация и фильтрация входящих ачивок
	validAchs := map[string]AchievementState{}
	for id, st := range seedAchs {
		if KnownAchievementIDs[id] {
			at := st.UnlockedAt
			if at <= 0 {
				at = time.Now().UnixMilli()
			}
			validAchs[id] = AchievementState{ID: id, UnlockedAt: at}
		}
	}

	// Построение MetaStats
	stats := DefaultMetaStats()
	for diff, ds := range seedStats.ByDifficulty {
		if _, ok := stats.ByDifficulty[diff]; ok {
			stats.ByDifficulty[diff] = ds
		}
	}
	stats.TotalRuns = seedStats.TotalRuns
	stats.TotalWins = seedStats.TotalWins
	stats.TotalLosses = seedStats.TotalLosses
	stats.PeakBalance = seedStats.PeakBalance
	stats.PeakDay = seedStats.PeakDay

	pm := &PlayerMeta{
		Player:       player,
		TotalRuns:    stats.TotalRuns,
		TotalWins:    stats.TotalWins,
		TotalLosses:  stats.TotalLosses,
		PeakBalance:  stats.PeakBalance,
		PeakDay:      stats.PeakDay,
		Stats:        stats,
		Achievements: validAchs,
	}

	statsJSON, err := json.Marshal(pm.Stats)
	if err != nil {
		return nil, fmt.Errorf("marshal stats: %w", err)
	}
	achsJSON, err := json.Marshal(pm.Achievements)
	if err != nil {
		return nil, fmt.Errorf("marshal achs: %w", err)
	}

	_, err = d.Pool.Exec(ctx, `
		INSERT INTO player_meta (
			player, total_runs, total_wins, total_losses, peak_balance, peak_day, stats, achievements
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8
		) ON CONFLICT (player) DO NOTHING
	`, pm.Player, pm.TotalRuns, pm.TotalWins, pm.TotalLosses, pm.PeakBalance, pm.PeakDay, statsJSON, achsJSON)
	if err != nil {
		return nil, fmt.Errorf("seed player_meta insert: %w", err)
	}
	return d.GetPlayerMeta(ctx, player)
}

// UnlockPlayerAchievements атомарно добавляет новые открытые достижения игроку.
func (d *DB) UnlockPlayerAchievements(ctx context.Context, player string, newAchs []AchievementState, day int, money int64, diff string) (*PlayerMeta, error) {
	if player == "" || len(newAchs) == 0 {
		return d.GetPlayerMeta(ctx, player)
	}

	pm, err := d.GetPlayerMeta(ctx, player)
	if err != nil {
		return nil, err
	}
	if pm == nil {
		pm = &PlayerMeta{
			Player:       player,
			Stats:        DefaultMetaStats(),
			Achievements: map[string]AchievementState{},
		}
	}

	changed := false
	for _, ach := range newAchs {
		if !KnownAchievementIDs[ach.ID] {
			continue
		}
		if _, exists := pm.Achievements[ach.ID]; !exists {
			at := ach.UnlockedAt
			if at <= 0 {
				at = time.Now().UnixMilli()
			}
			pm.Achievements[ach.ID] = AchievementState{ID: ach.ID, UnlockedAt: at}
			changed = true
		}
	}

	if int64(money) > pm.PeakBalance {
		pm.PeakBalance = int64(money)
		pm.Stats.PeakBalance = pm.PeakBalance
		changed = true
	}
	if day > pm.PeakDay {
		pm.PeakDay = day
		pm.Stats.PeakDay = pm.PeakDay
		changed = true
	}
	if diff != "" {
		if ds, ok := pm.Stats.ByDifficulty[diff]; ok {
			if day > ds.BestDay {
				ds.BestDay = day
				pm.Stats.ByDifficulty[diff] = ds
				changed = true
			}
		}
	}

	if changed {
		if err := d.UpsertPlayerMeta(ctx, pm); err != nil {
			return nil, err
		}
	}
	return pm, nil
}

// RecordPlayerFinish фиксирует завершение партии (победа или поражение) в player_meta.
func (d *DB) RecordPlayerFinish(ctx context.Context, player, diff, outcome, reason string, day int, balance int64) (*PlayerMeta, error) {
	if player == "" {
		return nil, nil
	}
	pm, err := d.GetPlayerMeta(ctx, player)
	if err != nil {
		return nil, err
	}
	if pm == nil {
		pm = &PlayerMeta{
			Player:       player,
			Stats:        DefaultMetaStats(),
			Achievements: map[string]AchievementState{},
		}
	}

	pm.TotalRuns++
	pm.Stats.TotalRuns++

	isWin := outcome == "victory" || outcome == "won"
	if isWin {
		pm.TotalWins++
		pm.Stats.TotalWins++
	} else {
		pm.TotalLosses++
		pm.Stats.TotalLosses++
	}

	if balance > pm.PeakBalance {
		pm.PeakBalance = balance
	}
	if day > pm.PeakDay {
		pm.PeakDay = day
	}
	pm.Stats.PeakBalance = pm.PeakBalance
	pm.Stats.PeakDay = pm.PeakDay

	ds, ok := pm.Stats.ByDifficulty[diff]
	if !ok {
		ds = DifficultyStats{}
	}
	ds.Runs++
	if isWin {
		ds.Wins++
		if ds.BestWinDay == nil || day < *ds.BestWinDay {
			best := day
			ds.BestWinDay = &best
		}
		if balance > ds.BestBalance {
			ds.BestBalance = balance
		}
	} else {
		if reason == "time_up" {
			ds.TimeUps++
		} else if reason == "bankrupt" {
			ds.Bankruptcies++
		}
	}
	if day > ds.BestDay {
		ds.BestDay = day
	}
	pm.Stats.ByDifficulty[diff] = ds

	if err := d.UpsertPlayerMeta(ctx, pm); err != nil {
		return nil, err
	}
	return pm, nil
}
