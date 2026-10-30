package main

import (
	"testing"

	"itdirector/internal/db"
)

func TestEvaluatePolicy_Bankruptcies(t *testing.T) {
	// Normal: greedy bot cannot have any bankruptcies
	baseNormal := db.SimSummary{
		Difficulty:       "normal",
		Policy:           "greedy",
		TotalRuns:        100,
		BankruptCount:    0,
		BankruptPct:      0.0,
		EarlyBankruptPct: 0.0,
		MedianMoney:      50000,
		MedianDays:       30,
	}

	currNormalOK := baseNormal
	comps := evaluatePolicy(currNormalOK, baseNormal)
	if comps[0].Status != statusOK {
		t.Fatalf("expected OK, got %v (%s)", comps[0].Status, comps[0].Note)
	}

	currNormalFail := baseNormal
	currNormalFail.BankruptCount = 1
	currNormalFail.BankruptPct = 1.0
	comps = evaluatePolicy(currNormalFail, baseNormal)
	if comps[0].Status != statusFail {
		t.Fatalf("expected FAIL for bankruptcies on normal, got %v", comps[0].Status)
	}

	// Hard: greedy bot bankruptcies delta thresholds
	baseHard := db.SimSummary{
		Difficulty:       "hard",
		Policy:           "greedy",
		TotalRuns:        100,
		BankruptCount:    20,
		BankruptPct:      20.0,
		EarlyBankruptPct: 5.0,
		MedianMoney:      15000,
		MedianDays:       25,
	}

	currHardWarn := baseHard
	currHardWarn.BankruptPct = 23.0
	comps = evaluatePolicy(currHardWarn, baseHard)
	if comps[0].Status != statusWarn {
		t.Fatalf("expected WARN for +3%% bankruptcies on hard, got %v", comps[0].Status)
	}

	currHardFail := baseHard
	currHardFail.BankruptPct = 26.0
	comps = evaluatePolicy(currHardFail, baseHard)
	if comps[0].Status != statusFail {
		t.Fatalf("expected FAIL for +6%% bankruptcies on hard, got %v", comps[0].Status)
	}
}

func TestEvaluatePolicy_MoneyAndDays(t *testing.T) {
	base := db.SimSummary{
		Difficulty:       "normal",
		Policy:           "idle",
		TotalRuns:        100,
		BankruptCount:    10,
		BankruptPct:      10.0,
		EarlyBankruptPct: 0.0,
		MedianMoney:      10000,
		MedianDays:       20,
	}

	// Money Nerf: -10% -> WARN, -20% -> FAIL
	currWarnMoney := base
	currWarnMoney.MedianMoney = 9000
	comps := evaluatePolicy(currWarnMoney, base)
	// index 2 is Median Money
	if comps[2].Status != statusWarn {
		t.Fatalf("expected WARN for -10%% median money, got %v", comps[2].Status)
	}

	currFailMoney := base
	currFailMoney.MedianMoney = 8000
	comps = evaluatePolicy(currFailMoney, base)
	if comps[2].Status != statusFail {
		t.Fatalf("expected FAIL for -20%% median money, got %v", comps[2].Status)
	}

	// Days Drop: -2 -> WARN, -3 -> FAIL
	currWarnDays := base
	currWarnDays.MedianDays = 18
	comps = evaluatePolicy(currWarnDays, base)
	// index 3 is Median Days
	if comps[3].Status != statusWarn {
		t.Fatalf("expected WARN for -2 median days, got %v (%s)", comps[3].Status, comps[3].Note)
	}

	currFailDays := base
	currFailDays.MedianDays = 17
	comps = evaluatePolicy(currFailDays, base)
	if comps[3].Status != statusFail {
		t.Fatalf("expected FAIL for -3 median days, got %v (%s)", comps[3].Status, comps[3].Note)
	}
}

func TestEvaluatePolicy_EasyWinRate(t *testing.T) {
	base := db.SimSummary{
		Difficulty:       "easy",
		Policy:           "greedy",
		TotalRuns:        100,
		VictoryPct:       100.0,
		BankruptCount:    0,
		BankruptPct:      0.0,
		EarlyBankruptPct: 0.0,
		MedianMoney:      80000,
		MedianDays:       30,
	}

	currFailWin := base
	currFailWin.VictoryPct = 97.0 // < 98% -> FAIL
	comps := evaluatePolicy(currFailWin, base)
	// Last item is Victory Rate
	last := comps[len(comps)-1]
	if last.Name != "Victory Rate" {
		t.Fatalf("expected last metric to be Victory Rate, got %s", last.Name)
	}
	if last.Status != statusFail {
		t.Fatalf("expected FAIL for -3%% victory rate drop on easy, got %v", last.Status)
	}
}
