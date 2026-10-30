package db

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestPlayerMeta(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL или DATABASE_URL не заданы — пропуск интеграционного теста")
	}

	ctx := context.Background()
	conn := Open(dsn, t.Logf)
	defer conn.Close()

	d, err := conn.Get()
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := d.Migrate(ctx); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	playerID := "p_test_" + time.Now().Format("20060102150405.000000")

	// 1. GetPlayerMeta на несуществующего игрока -> nil
	meta, err := d.GetPlayerMeta(ctx, playerID)
	if err != nil {
		t.Fatalf("GetPlayerMeta: %v", err)
	}
	if meta != nil {
		t.Fatalf("expected nil for non-existent player, got %+v", meta)
	}

	// 2. First-Run Seed
	seedStats := DefaultMetaStats()
	seedStats.TotalRuns = 5
	seedStats.TotalWins = 2
	seedStats.TotalLosses = 3
	seedStats.PeakBalance = 15000
	seedStats.PeakDay = 12
	seedAchs := map[string]AchievementState{
		"first_hire":   {ID: "first_hire", UnlockedAt: 1730000000000},
		"coffee_break": {ID: "coffee_break", UnlockedAt: 1730000005000},
		"fake_ach":     {ID: "fake_ach", UnlockedAt: 1730000010000}, // должна отфильтроваться
	}

	seeded, err := d.SeedPlayerMetaIfMissing(ctx, playerID, seedStats, seedAchs)
	if err != nil {
		t.Fatalf("SeedPlayerMetaIfMissing: %v", err)
	}
	if seeded == nil {
		t.Fatal("expected seeded player_meta, got nil")
	}
	if seeded.TotalRuns != 5 || seeded.TotalWins != 2 || seeded.TotalLosses != 3 {
		t.Fatalf("unexpected stats: %+v", seeded)
	}
	if len(seeded.Achievements) != 2 {
		t.Fatalf("expected exactly 2 valid achievements, got %d: %+v", len(seeded.Achievements), seeded.Achievements)
	}
	if _, ok := seeded.Achievements["fake_ach"]; ok {
		t.Fatalf("fake_ach should have been filtered out")
	}

	// 3. Повторный Seed не должен перетирать
	seedAgain, err := d.SeedPlayerMetaIfMissing(ctx, playerID, DefaultMetaStats(), nil)
	if err != nil {
		t.Fatalf("SeedPlayerMetaIfMissing 2: %v", err)
	}
	if seedAgain.TotalRuns != 5 {
		t.Fatalf("seed overwrote existing data: runs=%d", seedAgain.TotalRuns)
	}

	// 4. UnlockPlayerAchievements
	newAchs := []AchievementState{
		{ID: "survivor_10", UnlockedAt: 1730000020000},
	}
	unlocked, err := d.UnlockPlayerAchievements(ctx, playerID, newAchs, 15, 25000, "normal")
	if err != nil {
		t.Fatalf("UnlockPlayerAchievements: %v", err)
	}
	if len(unlocked.Achievements) != 3 {
		t.Fatalf("expected 3 achievements, got %d", len(unlocked.Achievements))
	}
	if unlocked.PeakBalance != 25000 || unlocked.PeakDay != 15 {
		t.Fatalf("expected updated peak balance and day, got %d / %d", unlocked.PeakBalance, unlocked.PeakDay)
	}

	// 5. RecordPlayerFinish (Победа)
	afterWin, err := d.RecordPlayerFinish(ctx, playerID, "normal", "victory", "", 18, 50000)
	if err != nil {
		t.Fatalf("RecordPlayerFinish win: %v", err)
	}
	if afterWin.TotalRuns != 6 || afterWin.TotalWins != 3 || afterWin.TotalLosses != 3 {
		t.Fatalf("expected 6 runs, 3 wins, got %+v", afterWin)
	}
	if afterWin.PeakBalance != 50000 || afterWin.PeakDay != 18 {
		t.Fatalf("expected peak balance 50000, got %d", afterWin.PeakBalance)
	}
	norm := afterWin.Stats.ByDifficulty["normal"]
	if norm.Wins != 1 || norm.Runs != 1 || norm.BestBalance != 50000 {
		t.Fatalf("expected normal diff stats updated, got %+v", norm)
	}

	// 6. RecordPlayerFinish (Поражение)
	afterLoss, err := d.RecordPlayerFinish(ctx, playerID, "hard", "lost", "bankrupt", 7, 0)
	if err != nil {
		t.Fatalf("RecordPlayerFinish loss: %v", err)
	}
	if afterLoss.TotalRuns != 7 || afterLoss.TotalWins != 3 || afterLoss.TotalLosses != 4 {
		t.Fatalf("expected 7 runs, 4 losses, got %+v", afterLoss)
	}
	hard := afterLoss.Stats.ByDifficulty["hard"]
	if hard.Runs != 1 || hard.Bankruptcies != 1 {
		t.Fatalf("expected hard bankruptcies = 1, got %+v", hard)
	}
}
