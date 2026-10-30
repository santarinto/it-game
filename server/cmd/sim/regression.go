package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strings"
	"time"

	"itdirector/internal/db"
)

type metricStatus string

const (
	statusOK   metricStatus = "OK"
	statusWarn metricStatus = "WARN"
	statusFail metricStatus = "FAIL"
)

type metricComparison struct {
	Name     string
	Baseline string
	Current  string
	Delta    string
	Status   metricStatus
	Note     string
}

// checkRegressions сравнивает батч с эталоном и выводит структурированный отчёт.
// Возвращает true, если зафиксирована хотя бы одна регрессия (FAIL).
func checkRegressions(ctx context.Context, database *db.DB, batchID int64, batch db.SimBatch, wantedPolicies []string) (bool, error) {
	summaries, err := database.GetBatchSummaries(ctx, batchID)
	if err != nil {
		return false, fmt.Errorf("получение сводки батча: %w", err)
	}

	summaryByPolicy := make(map[string]db.SimSummary, len(summaries))
	for _, s := range summaries {
		summaryByPolicy[s.Policy] = s
	}

	baseID, err := database.FindBaselineBatchID(ctx, batch.Difficulty, batch.Scenario, batch.DaysLimit, batchID)
	if err != nil {
		return false, fmt.Errorf("поиск эталонного батча: %w", err)
	}

	fmt.Printf("\n=== SIM REGRESSION REPORT ===\n")
	fmt.Printf("Batch: %s (commit: %s, branch: %s)\n", batch.BatchUUID, batch.GitCommit, batch.GitBranch)
	fmt.Printf("Difficulty: %s | Scenario: %q | Days: %d | Seeds: %d\n",
		batch.Difficulty, batch.Scenario, batch.DaysLimit, batch.SeedsCount)

	if baseID <= 0 {
		fmt.Printf("Note: Базовый эталон не найден в БД. Текущий батч сохранён как исходный ориентир.\n")
		fmt.Printf("Status: OK (нет базы для сравнения)\n\n")
		return false, nil
	}

	baseSummaries, err := database.GetBatchSummaries(ctx, baseID)
	if err != nil {
		return false, fmt.Errorf("получение сводки эталона: %w", err)
	}
	baseByPolicy := make(map[string]db.SimSummary, len(baseSummaries))
	for _, s := range baseSummaries {
		baseByPolicy[s.Policy] = s
	}

	baseCommit := "unknown"
	if len(baseSummaries) > 0 {
		baseCommit = baseSummaries[0].GitCommit
		if baseSummaries[0].IsBaseline {
			baseCommit += " [baseline]"
		}
	}
	fmt.Printf("Baseline Batch ID: %d (commit: %s)\n", baseID, baseCommit)

	totalFails := 0
	totalWarns := 0

	for _, policy := range wantedPolicies {
		curr, ok := summaryByPolicy[policy]
		if !ok {
			continue
		}
		base, hasBase := baseByPolicy[policy]

		fmt.Printf("\nPolicy: %s\n", policy)
		if !hasBase {
			fmt.Printf("  (в базовом батче %d политика %s отсутствует — пропускаем сравнение)\n", baseID, policy)
			continue
		}

		comps := evaluatePolicy(curr, base)
		printComparisonTable(comps)

		for _, c := range comps {
			if c.Status == statusFail {
				totalFails++
			} else if c.Status == statusWarn {
				totalWarns++
			}
		}
	}

	fmt.Println()
	if totalFails > 0 {
		fmt.Printf("Verdict: %d REGRESSION(S) DETECTED! (warnings: %d)\n\n", totalFails, totalWarns)
		return true, nil
	}
	if totalWarns > 0 {
		fmt.Printf("Verdict: OK (with %d warning(s))\n\n", totalWarns)
		return false, nil
	}
	fmt.Printf("Verdict: ALL CHECKS PASSED (OK)\n\n")
	return false, nil
}

func evaluatePolicy(curr, base db.SimSummary) []metricComparison {
	var comps []metricComparison

	// 1. Bankruptcies
	bDelta := curr.BankruptPct - base.BankruptPct
	bStatus := statusOK
	bNote := ""
	if curr.Difficulty == "normal" && (curr.Policy == "greedy" || curr.Policy == "delegate" || curr.Policy == "expand") {
		if curr.BankruptPct > 0 {
			bStatus = statusFail
			bNote = fmt.Sprintf("bankruptcies on normal (%.1f%%)", curr.BankruptPct)
		}
	} else if curr.Difficulty == "hard" && curr.Policy == "greedy" {
		if bDelta > 5.0 {
			bStatus = statusFail
			bNote = "growth > 5%"
		} else if bDelta > 2.0 {
			bStatus = statusWarn
			bNote = "growth > 2%"
		}
	} else {
		if bDelta > 10.0 {
			bStatus = statusFail
			bNote = "growth > 10%"
		} else if bDelta > 5.0 {
			bStatus = statusWarn
			bNote = "growth > 5%"
		}
	}
	comps = append(comps, metricComparison{
		Name:     "Bankruptcies",
		Baseline: fmt.Sprintf("%.1f%% (%d/%d)", base.BankruptPct, base.BankruptCount, base.TotalRuns),
		Current:  fmt.Sprintf("%.1f%% (%d/%d)", curr.BankruptPct, curr.BankruptCount, curr.TotalRuns),
		Delta:    formatDeltaPct(bDelta),
		Status:   bStatus,
		Note:     bNote,
	})

	// 2. Early Bankrupt (<= 7 days)
	ebDelta := curr.EarlyBankruptPct - base.EarlyBankruptPct
	ebStatus := statusOK
	ebNote := ""
	if ebDelta > 3.0 {
		ebStatus = statusFail
		ebNote = "early death growth > 3%"
	} else if ebDelta > 1.5 {
		ebStatus = statusWarn
		ebNote = "early death growth > 1.5%"
	}
	comps = append(comps, metricComparison{
		Name:     "Early Bankrupt (≤7d)",
		Baseline: fmt.Sprintf("%.1f%%", base.EarlyBankruptPct),
		Current:  fmt.Sprintf("%.1f%%", curr.EarlyBankruptPct),
		Delta:    formatDeltaPct(ebDelta),
		Status:   ebStatus,
		Note:     ebNote,
	})

	// 3. Median Money
	baseDenom := math.Abs(float64(base.MedianMoney))
	if baseDenom < 1 {
		baseDenom = 1
	}
	mRatio := float64(curr.MedianMoney-base.MedianMoney) / baseDenom
	mDeltaPct := mRatio * 100
	mStatus := statusOK
	mNote := ""
	if mDeltaPct < -15.0 {
		mStatus = statusFail
		mNote = "Economy Nerf > 15%"
	} else if mDeltaPct < -7.0 {
		mStatus = statusWarn
		mNote = "Economy Nerf > 7%"
	} else if mDeltaPct > 35.0 {
		mStatus = statusWarn
		mNote = "Economy Inflation > 35%"
	}
	comps = append(comps, metricComparison{
		Name:     "Median Money",
		Baseline: fmt.Sprintf("$%d", base.MedianMoney),
		Current:  fmt.Sprintf("$%d", curr.MedianMoney),
		Delta:    formatDeltaPct(mDeltaPct),
		Status:   mStatus,
		Note:     mNote,
	})

	// 4. Median Days
	dDelta := curr.MedianDays - base.MedianDays
	dStatus := statusOK
	dNote := ""
	if curr.Policy == "random" {
		if dDelta < -1 {
			dStatus = statusFail
			dNote = "chaos survival dropped > 1d"
		} else if dDelta < 0 {
			dStatus = statusWarn
			dNote = "chaos survival dropped"
		}
	} else if curr.Scenario != "" && curr.Policy == "idle" {
		if dDelta < -1 {
			dStatus = statusFail
			dNote = "fixture idle death accelerated > 1d"
		} else if dDelta < 0 {
			dStatus = statusWarn
			dNote = "fixture idle death accelerated"
		}
	} else {
		if dDelta < -2 {
			dStatus = statusFail
			dNote = "median days dropped > 2d"
		} else if dDelta < -1 {
			dStatus = statusWarn
			dNote = "median days dropped > 1d"
		}
	}
	comps = append(comps, metricComparison{
		Name:     "Median Days",
		Baseline: fmt.Sprintf("%d", base.MedianDays),
		Current:  fmt.Sprintf("%d", curr.MedianDays),
		Delta:    fmt.Sprintf("%+d", dDelta),
		Status:   dStatus,
		Note:     dNote,
	})

	// 5. Easy Victory Rate for greedy
	if curr.Difficulty == "easy" && curr.Policy == "greedy" {
		vStatus := statusOK
		vNote := ""
		if curr.VictoryPct < 98.0 {
			vStatus = statusFail
			vNote = "easy win rate < 98%"
		} else if curr.VictoryPct < 100.0 {
			vStatus = statusWarn
			vNote = "easy win rate < 100%"
		}
		comps = append(comps, metricComparison{
			Name:     "Victory Rate",
			Baseline: fmt.Sprintf("%.1f%%", base.VictoryPct),
			Current:  fmt.Sprintf("%.1f%%", curr.VictoryPct),
			Delta:    formatDeltaPct(curr.VictoryPct - base.VictoryPct),
			Status:   vStatus,
			Note:     vNote,
		})
	}

	return comps
}

func formatDeltaPct(d float64) string {
	if d > 0 {
		return fmt.Sprintf("+%.1f%%", d)
	}
	return fmt.Sprintf("%.1f%%", d)
}

func printComparisonTable(comps []metricComparison) {
	fmt.Printf("  %-22s %-16s %-16s %-12s %-6s %s\n", "Metric", "Baseline", "Current", "Delta", "Status", "Note")
	fmt.Printf("  ----------------------------------------------------------------------------------------\n")
	for _, c := range comps {
		note := c.Note
		if note != "" {
			note = "[" + note + "]"
		}
		fmt.Printf("  %-22s %-16s %-16s %-12s %-6s %s\n", c.Name, c.Baseline, c.Current, c.Delta, c.Status, note)
	}
}

func gitMeta() (commit, branch string) {
	commit = "dev"
	branch = "main"

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if out, err := exec.CommandContext(ctx, "git", "rev-parse", "--short", "HEAD").Output(); err == nil {
		if c := strings.TrimSpace(string(out)); c != "" {
			commit = c
		}
	} else if envCommit := os.Getenv("GIT_COMMIT"); envCommit != "" {
		commit = envCommit
	}

	if out, err := exec.CommandContext(ctx, "git", "rev-parse", "--abbrev-ref", "HEAD").Output(); err == nil {
		if b := strings.TrimSpace(string(out)); b != "" {
			branch = b
		}
	} else if envBranch := os.Getenv("GIT_BRANCH"); envBranch != "" {
		branch = envBranch
	}

	return commit, branch
}
