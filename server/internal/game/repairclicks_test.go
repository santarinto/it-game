package game

import (
	"encoding/json"
	"testing"
)

// ITGAME-93: число кликов починки N роллится при поломке равномерно из
// RepairClicksMin..RepairClicksMax (3..15) серверным PCG, хранится у
// сотрудника (сейв, снапшот) и чинит ровно на N-й клик.

// breakOnce — игра с одним сотрудником и поломкой на первом же тике.
func breakOnce(t *testing.T, s1, s2 uint64) *Game {
	t.Helper()
	cfg := DefaultConfig()
	cfg.BreakdownChancePct = 100
	cfg.EventChancePct = 0
	g := NewWithSeed(cfg, s1, s2)
	g.Offices[0].PCs = 1
	g.Offices[0].Employees = testStaff(1)
	g.Tick()
	if !g.Offices[0].Employees[0].PCBroken {
		t.Fatalf("сид %d/%d: поломки на первом тике нет", s1, s2)
	}
	return g
}

func TestRepairNeededRolledInRange(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.RepairClicksMin != 3 || cfg.RepairClicksMax != 15 {
		t.Fatalf("диапазон кликов %d..%d, хотим 3..15", cfg.RepairClicksMin, cfg.RepairClicksMax)
	}
	seen := map[int]bool{}
	for s := uint64(1); s <= 400; s++ {
		g := breakOnce(t, s, s*7+1)
		n := g.Offices[0].Employees[0].RepairNeeded
		if n < 3 || n > 15 {
			t.Fatalf("сид %d: RepairNeeded=%d вне 3..15", s, n)
		}
		seen[n] = true
	}
	// Равномерно: за 400 поломок встречается каждое значение 3..15.
	if len(seen) != 13 {
		t.Fatalf("за 400 поломок выпало %d разных N из 13: %v", len(seen), seen)
	}
}

func TestRepairNeededDeterministicBySeed(t *testing.T) {
	for s := uint64(1); s <= 20; s++ {
		a := breakOnce(t, s, 99).Offices[0].Employees[0].RepairNeeded
		b := breakOnce(t, s, 99).Offices[0].Employees[0].RepairNeeded
		if a != b {
			t.Fatalf("сид %d: N=%d и N=%d при одинаковых действиях", s, a, b)
		}
	}
}

func TestRepairClicksExactlyN(t *testing.T) {
	g := breakOnce(t, 5, 6)
	e := &g.Offices[0].Employees[0]
	n := e.RepairNeeded
	for k := 1; k < n; k++ {
		if err := g.RepairClick(0, 0); err != nil {
			t.Fatalf("клик %d/%d: %v", k, n, err)
		}
		if !e.PCBroken || e.RepairClicks != k || e.RepairNeeded != n {
			t.Fatalf("после клика %d/%d: broken=%v clicks=%d needed=%d", k, n, e.PCBroken, e.RepairClicks, e.RepairNeeded)
		}
	}
	if err := g.RepairClick(0, 0); err != nil {
		t.Fatal(err)
	}
	if e.PCBroken || e.RepairClicks != 0 || e.RepairNeeded != 0 {
		t.Fatalf("после %d кликов: broken=%v clicks=%d needed=%d, хотим false/0/0", n, e.PCBroken, e.RepairClicks, e.RepairNeeded)
	}
}

func TestCallMasterClearsRepairNeeded(t *testing.T) {
	g := breakOnce(t, 5, 6)
	g.Money = 10000
	if err := g.CallMaster(0, 0); err != nil {
		t.Fatal(err)
	}
	if e := g.Offices[0].Employees[0]; e.PCBroken || e.RepairNeeded != 0 {
		t.Fatalf("после мастера: broken=%v needed=%d", e.PCBroken, e.RepairNeeded)
	}
}

// Сейв до ITGAME-93: сломанный ПК без RepairNeeded чинится за 3 клика, как
// раньше, а Restore дописывает N=3 явно (снапшот и следующий сейв его несут).
func TestRestoreOldSaveRepairNeededDefaults3(t *testing.T) {
	g := breakOnce(t, 5, 6)
	raw, err := json.Marshal(g.Export())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	emp := m["offices"].([]any)[0].(map[string]any)["Employees"].([]any)[0].(map[string]any)
	delete(emp, "RepairNeeded")
	cfg := m["config"].(map[string]any)
	delete(cfg, "RepairClicksMin")
	delete(cfg, "RepairClicksMax")
	cfg["RepairClicksNeeded"] = 3 // поле старого конфига — молча игнорируется
	raw, _ = json.Marshal(m)
	var s Save
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	g2, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	e := &g2.Offices[0].Employees[0]
	if e.RepairNeeded != 3 {
		t.Fatalf("старый сейв: RepairNeeded=%d, хотим 3", e.RepairNeeded)
	}
	if c := g2.Config(); c.RepairClicksMin != 3 || c.RepairClicksMax != 15 {
		t.Fatalf("старый конфиг: диапазон %d..%d, хотим 3..15", c.RepairClicksMin, c.RepairClicksMax)
	}
	for k := 0; k < 3; k++ {
		if err := g2.RepairClick(0, 0); err != nil {
			t.Fatal(err)
		}
	}
	if e.PCBroken {
		t.Fatal("старый сейв: после 3 кликов ПК сломан")
	}
}

// Сейв с N переживает круг Export → JSON → Restore без изменений.
func TestSaveKeepsRepairNeeded(t *testing.T) {
	g := breakOnce(t, 11, 12)
	want := g.Offices[0].Employees[0].RepairNeeded
	raw, _ := json.Marshal(g.Export())
	var s Save
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	g2, err := Restore(s)
	if err != nil {
		t.Fatal(err)
	}
	if got := g2.Offices[0].Employees[0].RepairNeeded; got != want {
		t.Fatalf("после сейва N=%d, было %d", got, want)
	}
}

// Ручная поломка (тесты, debug-дельта без поля) — тоже 3 клика.
func TestRepairTargetLegacyZero(t *testing.T) {
	e := Employee{PCBroken: true}
	if e.RepairTarget() != 3 {
		t.Fatalf("RepairTarget без N = %d, хотим 3", e.RepairTarget())
	}
	e.RepairNeeded = 12
	if e.RepairTarget() != 12 {
		t.Fatalf("RepairTarget = %d, хотим 12", e.RepairTarget())
	}
}
