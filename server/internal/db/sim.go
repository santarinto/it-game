package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// SimBatch — запись батча симуляций в sim_batches (ITGAME-126).
type SimBatch struct {
	ID          int64
	BatchUUID   string
	GitCommit   string
	GitBranch   string
	CreatedAt   time.Time
	Source      string
	Difficulty  string
	Scenario    string
	DaysLimit   int
	SeedsCount  int
	Policies    []string
	Params      map[string]any
	Label       string
	IsBaseline  bool
}

// SimRun — запись одного симулированного прогона (сид × политика) в sim_runs.
type SimRun struct {
	ID           int64
	BatchID      int64
	Policy       string
	Seed         int64
	Scenario     string
	Outcome      string
	DaysSurvived int
	FinalMoney   int64
	FinalIncome  int64
	FinalPayroll int64
	FinalStaff   int
	FinalOffices int
	FinalPCs     int
	EventsCount  int
	AuditFailed  bool
}

// SimSummary — агрегированная сводка батча из view sim_batch_summaries.
type SimSummary struct {
	BatchID          int64
	BatchUUID        string
	GitCommit        string
	GitBranch        string
	CreatedAt        time.Time
	Difficulty       string
	Scenario         string
	DaysLimit        int
	Label            string
	IsBaseline       bool
	Policy           string
	TotalRuns        int
	VictoryCount     int
	BankruptCount    int
	TimeoutCount     int
	DeadlockCount    int
	VictoryPct       float64
	BankruptPct      float64
	EarlyBankruptPct float64
	MedianMoney      int64
	P25Money         int64
	P75Money         int64
	MedianDays       int
	AvgIncome        int64
	AvgPayroll       int64
	AvgStaff         float64
}

// SaveSimBatch сохраняет батч и все его прогоны в одной транзакции.
func (d *DB) SaveSimBatch(ctx context.Context, batch SimBatch, runs []SimRun) (int64, error) {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	paramsJSON, err := json.Marshal(batch.Params)
	if err != nil {
		paramsJSON = []byte("{}")
	}

	var batchID int64
	err = tx.QueryRow(ctx, `
		INSERT INTO sim_batches
			(batch_uuid, git_commit, git_branch, created_at, source, difficulty,
			 scenario, days_limit, seeds_count, policies, params, label, is_baseline)
		VALUES
			($1, $2, $3, COALESCE(NULLIF($4, '0001-01-01T00:00:00Z'::timestamptz), now()),
			 $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING id
	`, batch.BatchUUID, batch.GitCommit, batch.GitBranch, batch.CreatedAt,
		batch.Source, batch.Difficulty, batch.Scenario, batch.DaysLimit, batch.SeedsCount,
		batch.Policies, paramsJSON, batch.Label, batch.IsBaseline).Scan(&batchID)
	if err != nil {
		return 0, fmt.Errorf("insert sim_batch: %w", err)
	}

	if len(runs) > 0 {
		rows := make([][]any, 0, len(runs))
		for _, r := range runs {
			rows = append(rows, []any{
				batchID, r.Policy, r.Seed, r.Scenario, r.Outcome,
				r.DaysSurvived, r.FinalMoney, r.FinalIncome, r.FinalPayroll,
				r.FinalStaff, r.FinalOffices, r.FinalPCs, r.EventsCount, r.AuditFailed,
			})
		}
		_, err = tx.CopyFrom(ctx, pgx.Identifier{"sim_runs"},
			[]string{
				"batch_id", "policy", "seed", "scenario", "outcome",
				"days_survived", "final_money", "final_income", "final_payroll",
				"final_staff", "final_offices", "final_pcs", "events_count", "audit_failed",
			},
			pgx.CopyFromRows(rows),
		)
		if err != nil {
			return 0, fmt.Errorf("copy sim_runs: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit tx: %w", err)
	}
	return batchID, nil
}

// FindBaselineBatchID ищет подходящий эталонный батч по алгоритму раздела 4.1 docs/design/sim-runs-regression.md:
// 1. Свежайший с is_baseline = true.
// 2. Либо последний с git_branch = 'main'.
// 3. Либо любой предыдущий с теми же (difficulty, scenario, days_limit).
func (d *DB) FindBaselineBatchID(ctx context.Context, difficulty, scenario string, daysLimit int, excludeBatchID int64) (int64, error) {
	// 1. Явный baseline
	var id int64
	err := d.Pool.QueryRow(ctx, `
		SELECT id FROM sim_batches
		WHERE difficulty = $1 AND scenario = $2 AND days_limit = $3 AND is_baseline = true AND id <> $4
		ORDER BY created_at DESC, id DESC LIMIT 1
	`, difficulty, scenario, daysLimit, excludeBatchID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}

	// 2. Предыдущий коммит в main
	err = d.Pool.QueryRow(ctx, `
		SELECT id FROM sim_batches
		WHERE difficulty = $1 AND scenario = $2 AND days_limit = $3 AND git_branch = 'main' AND id <> $4
		ORDER BY created_at DESC, id DESC LIMIT 1
	`, difficulty, scenario, daysLimit, excludeBatchID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}

	// 3. Предшествующий батч с теми же параметрами
	err = d.Pool.QueryRow(ctx, `
		SELECT id FROM sim_batches
		WHERE difficulty = $1 AND scenario = $2 AND days_limit = $3 AND id <> $4
		ORDER BY created_at DESC, id DESC LIMIT 1
	`, difficulty, scenario, daysLimit, excludeBatchID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil // эталон не найден
	}
	return 0, err
}

// GetBatchSummary возвращает агрегированную сводку для батча и политики из sim_batch_summaries.
func (d *DB) GetBatchSummary(ctx context.Context, batchID int64, policy string) (*SimSummary, error) {
	row := d.Pool.QueryRow(ctx, `
		SELECT
			batch_id, batch_uuid, git_commit, git_branch, created_at,
			difficulty, scenario, days_limit, label, is_baseline, policy,
			total_runs, victory_count, bankrupt_count, timeout_count, deadlock_count,
			victory_pct, bankrupt_pct, early_bankrupt_pct,
			median_money, p25_money, p75_money, median_days,
			avg_income, avg_payroll, avg_staff
		FROM sim_batch_summaries
		WHERE batch_id = $1 AND policy = $2
	`, batchID, policy)

	var s SimSummary
	err := row.Scan(
		&s.BatchID, &s.BatchUUID, &s.GitCommit, &s.GitBranch, &s.CreatedAt,
		&s.Difficulty, &s.Scenario, &s.DaysLimit, &s.Label, &s.IsBaseline, &s.Policy,
		&s.TotalRuns, &s.VictoryCount, &s.BankruptCount, &s.TimeoutCount, &s.DeadlockCount,
		&s.VictoryPct, &s.BankruptPct, &s.EarlyBankruptPct,
		&s.MedianMoney, &s.P25Money, &s.P75Money, &s.MedianDays,
		&s.AvgIncome, &s.AvgPayroll, &s.AvgStaff,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("scan sim_batch_summary: %w", err)
	}
	return &s, nil
}

// GetBatchSummaries возвращает сводки для всех политик батча.
func (d *DB) GetBatchSummaries(ctx context.Context, batchID int64) ([]SimSummary, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT
			batch_id, batch_uuid, git_commit, git_branch, created_at,
			difficulty, scenario, days_limit, label, is_baseline, policy,
			total_runs, victory_count, bankrupt_count, timeout_count, deadlock_count,
			victory_pct, bankrupt_pct, early_bankrupt_pct,
			median_money, p25_money, p75_money, median_days,
			avg_income, avg_payroll, avg_staff
		FROM sim_batch_summaries
		WHERE batch_id = $1
		ORDER BY policy
	`, batchID)
	if err != nil {
		return nil, fmt.Errorf("query sim_batch_summaries: %w", err)
	}
	defer rows.Close()

	var list []SimSummary
	for rows.Next() {
		var s SimSummary
		err := rows.Scan(
			&s.BatchID, &s.BatchUUID, &s.GitCommit, &s.GitBranch, &s.CreatedAt,
			&s.Difficulty, &s.Scenario, &s.DaysLimit, &s.Label, &s.IsBaseline, &s.Policy,
			&s.TotalRuns, &s.VictoryCount, &s.BankruptCount, &s.TimeoutCount, &s.DeadlockCount,
			&s.VictoryPct, &s.BankruptPct, &s.EarlyBankruptPct,
			&s.MedianMoney, &s.P25Money, &s.P75Money, &s.MedianDays,
			&s.AvgIncome, &s.AvgPayroll, &s.AvgStaff,
		)
		if err != nil {
			return nil, fmt.Errorf("scan sim_batch_summary row: %w", err)
		}
		list = append(list, s)
	}
	return list, rows.Err()
}

// SetBatchBaseline выставляет или сбрасывает флаг is_baseline для батча.
func (d *DB) SetBatchBaseline(ctx context.Context, batchID int64, isBaseline bool) error {
	_, err := d.Pool.Exec(ctx, `UPDATE sim_batches SET is_baseline = $1 WHERE id = $2`, isBaseline, batchID)
	return err
}
