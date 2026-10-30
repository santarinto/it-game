package game

import (
	"slices"
	"testing"
)

func TestCheckAchievements(t *testing.T) {
	cfg := DefaultConfig()
	g := New(cfg)

	unlocked := map[string]bool{}

	// Чистый старт: никаких ачивок
	newAchs := CheckAchievements(g, unlocked, false)
	if len(newAchs) > 0 {
		t.Fatalf("expected 0 achievements on fresh start, got %v", newAchs)
	}

	// 1. first_hire
	g.Money = 10000
	_ = g.Apply(CmdHire, 0, 0)
	newAchs = CheckAchievements(g, unlocked, false)
	if !slices.Contains(newAchs, "first_hire") {
		t.Fatalf("expected first_hire, got %v", newAchs)
	}
	if slices.Contains(newAchs, "full_staff") || slices.Contains(newAchs, "network_36") {
		t.Fatalf("full_staff / network_36 should not unlock on start with 1 hire, got %v", newAchs)
	}
	unlocked["first_hire"] = true

	// 2. first_day
	g.Day = 2
	newAchs = CheckAchievements(g, unlocked, false)
	if !slices.Contains(newAchs, "first_day") {
		t.Fatalf("expected first_day, got %v", newAchs)
	}
	unlocked["first_day"] = true

	// 3. coffee_break
	g.Offices[0].CoffeeMachine = true
	newAchs = CheckAchievements(g, unlocked, false)
	if !slices.Contains(newAchs, "coffee_break") {
		t.Fatalf("expected coffee_break, got %v", newAchs)
	}
	unlocked["coffee_break"] = true

	// 4. star_hunter
	g.Offices[0].Employees[0].Star = true
	newAchs = CheckAchievements(g, unlocked, false)
	if !slices.Contains(newAchs, "star_hunter") {
		t.Fatalf("expected star_hunter, got %v", newAchs)
	}
	unlocked["star_hunter"] = true

	// 5. survivor_10
	g.Day = 11
	newAchs = CheckAchievements(g, unlocked, false)
	if !slices.Contains(newAchs, "survivor_10") {
		t.Fatalf("expected survivor_10, got %v", newAchs)
	}
	unlocked["survivor_10"] = true

	// 6. three_offices
	g.Offices[1].Unlocked = true
	g.Offices[2].Unlocked = true
	newAchs = CheckAchievements(g, unlocked, false)
	if !slices.Contains(newAchs, "three_offices") {
		t.Fatalf("expected three_offices, got %v", newAchs)
	}
	unlocked["three_offices"] = true

	// 7. full_staff и 9. network_36
	for i := 0; i < 3; i++ {
		g.Offices[i].Workplaces = make([]Workplace, 12)
		for j := 0; j < 12; j++ {
			g.Offices[i].Workplaces[j].Level = 1
		}
		g.Offices[i].PCs = 12
		g.Offices[i].Employees = make([]Employee, 12)
		for j := 0; j < 12; j++ {
			g.Offices[i].Employees[j] = Employee{Name: "Dev", Role: "developer"}
		}
		g.Offices[i].RouterTier = len(g.Config().RouterTiers)
	}
	// Core tier with enough ports for 36
	g.CoreLevel = len(g.Config().CoreLevels)
	newAchs = CheckAchievements(g, unlocked, false)
	if !slices.Contains(newAchs, "full_staff") {
		t.Fatalf("expected full_staff, got %v", newAchs)
	}
	if !slices.Contains(newAchs, "network_36") {
		t.Fatalf("expected network_36, got %v", newAchs)
	}
	unlocked["full_staff"] = true
	unlocked["network_36"] = true

	// 8. core_max
	g.CoreLevel = len(g.Config().CoreLevels)
	newAchs = CheckAchievements(g, unlocked, false)
	if !slices.Contains(newAchs, "core_max") {
		t.Fatalf("expected core_max, got %v", newAchs)
	}
	unlocked["core_max"] = true

	// 10. millionaire
	g.Money = 1_000_000
	newAchs = CheckAchievements(g, unlocked, false)
	if !slices.Contains(newAchs, "millionaire") {
		t.Fatalf("expected millionaire, got %v", newAchs)
	}
	unlocked["millionaire"] = true

	// 11. clean_win (сейчас есть coffeeMachine -> false; уберём кофе -> true)
	newAchs = CheckAchievements(g, unlocked, true)
	if slices.Contains(newAchs, "clean_win") {
		t.Fatalf("clean_win should fail when coffeeMachine is present")
	}
	g.Offices[0].CoffeeMachine = false
	newAchs = CheckAchievements(g, unlocked, true)
	if !slices.Contains(newAchs, "clean_win") {
		t.Fatalf("expected clean_win without amenities, got %v", newAchs)
	}
	unlocked["clean_win"] = true

	// 12. hardcore_win
	g.cfg.Difficulty = DiffHardcore
	newAchs = CheckAchievements(g, unlocked, true)
	if !slices.Contains(newAchs, "hardcore_win") {
		t.Fatalf("expected hardcore_win on hardcore, got %v", newAchs)
	}
}
