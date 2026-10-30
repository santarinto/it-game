package db

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestSimBatchAndRegression(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL не задан — пропускаем интеграционный тест БД")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	d, err := Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer d.Close()

	if err := d.Migrate(ctx); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	batch1 := SimBatch{
		BatchUUID:   "test-batch-base-001",
		GitCommit:   "abc1234",
		GitBranch:   "main",
		Source:      "sim",
		Difficulty:  "normal",
		Scenario:    "",
		DaysLimit:   30,
		SeedsCount:  2,
		Policies:    []string{"greedy"},
		Params:      map[string]any{"audit_share": 0.5},
		Label:       "baseline-v1",
		IsBaseline:  true,
		CreatedAt:   time.Now().Add(-1 * time.Hour),
	}
	runs1 := []SimRun{
		{
			Policy:       "greedy",
			Seed:         1,
			Scenario:     "",
			Outcome:      "timeout",
			DaysSurvived: 30,
			FinalMoney:   50000,
			FinalIncome:  2000,
			FinalPayroll: 1200,
			FinalStaff:   10,
			FinalOffices: 1,
			FinalPCs:     10,
			EventsCount:  5,
			AuditFailed:  false,
		},
		{
			Policy:       "greedy",
			Seed:         2,
			Scenario:     "",
			Outcome:      "timeout",
			DaysSurvived: 30,
			FinalMoney:   60000,
			FinalIncome:  2200,
			FinalPayroll: 1300,
			FinalStaff:   11,
			FinalOffices: 1,
			FinalPCs:     11,
			EventsCount:  4,
			AuditFailed:  false,
		},
	}

	id1, err := d.SaveSimBatch(ctx, batch1, runs1)
	if err != nil {
		t.Fatalf("SaveSimBatch 1: %v", err)
	}
	if id1 <= 0 {
		t.Fatalf("expected id1 > 0, got %d", id1)
	}
	defer func() {
		_, _ = d.Pool.Exec(context.Background(), "DELETE FROM sim_batches WHERE id = $1", id1)
	}()

	s1, err := d.GetBatchSummary(ctx, id1, "greedy")
	if err != nil {
		t.Fatalf("GetBatchSummary: %v", err)
	}
	if s1 == nil {
		t.Fatalf("expected s1 not nil")
	}
	if s1.TotalRuns != 2 {
		t.Errorf("expected TotalRuns=2, got %d", s1.TotalRuns)
	}
	if s1.MedianMoney != 55000 {
		t.Errorf("expected MedianMoney=55000, got %d", s1.MedianMoney)
	}
	if s1.BankruptPct != 0.0 {
		t.Errorf("expected BankruptPct=0.0, got %f", s1.BankruptPct)
	}

	// Второй батч (текущий)
	batch2 := SimBatch{
		BatchUUID:   "test-batch-target-002",
		GitCommit:   "def5678",
		GitBranch:   "feature/balance",
		Source:      "sim",
		Difficulty:  "normal",
		Scenario:    "",
		DaysLimit:   30,
		SeedsCount:  2,
		Policies:    []string{"greedy"},
		Params:      map[string]any{},
		IsBaseline:  false,
		CreatedAt:   time.Now(),
	}
	runs2 := []SimRun{
		{
			Policy:       "greedy",
			Seed:         1,
			Scenario:     "",
			Outcome:      "timeout",
			DaysSurvived: 30,
			FinalMoney:   45000,
			FinalIncome:  1900,
			FinalPayroll: 1200,
			FinalStaff:   10,
			FinalOffices: 1,
			FinalPCs:     10,
			EventsCount:  5,
		},
		{
			Policy:       "greedy",
			Seed:         2,
			Scenario:     "",
			Outcome:      "timeout",
			DaysSurvived: 30,
			FinalMoney:   55000,
			FinalIncome:  2100,
			FinalPayroll: 1300,
			FinalStaff:   11,
			FinalOffices: 1,
			FinalPCs:     11,
			EventsCount:  4,
		},
	}

	id2, err := d.SaveSimBatch(ctx, batch2, runs2)
	if err != nil {
		t.Fatalf("SaveSimBatch 2: %v", err)
	}
	defer func() {
		_, _ = d.Pool.Exec(context.Background(), "DELETE FROM sim_batches WHERE id = $1", id2)
	}()

	// Проверяем FindBaselineBatchID для batch2: должен найти id1 (так как is_baseline = true)
	baseID, err := d.FindBaselineBatchID(ctx, "normal", "", 30, id2)
	if err != nil {
		t.Fatalf("FindBaselineBatchID: %v", err)
	}
	if baseID != id1 {
		t.Errorf("expected baseID=%d, got %d", id1, baseID)
	}
}
