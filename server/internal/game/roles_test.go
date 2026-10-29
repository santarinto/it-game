package game

import (
	"encoding/json"
	"slices"
	"testing"
)

// Роли сотрудников (ITGAME-197): саппорт, программист, тестировщик, дизайнер,
// лид, ПМ, аналитик. Роллятся при найме навсегда, сохраняются в сейве.
func TestEmployeeRolesAllValid(t *testing.T) {
	if len(AllRoles) != 7 {
		t.Fatalf("ожидалось ровно 7 ролей, получено %d: %v", len(AllRoles), AllRoles)
	}
	expected := []string{
		RoleDeveloper,
		RoleTester,
		RoleSupport,
		RoleDesigner,
		RolePM,
		RoleLead,
		RoleAnalyst,
	}
	for _, r := range expected {
		if !ValidRole(r) {
			t.Errorf("ValidRole(%q) = false, ожидали true", r)
		}
	}
	if ValidRole("unknown_role") {
		t.Errorf("ValidRole(unknown_role) = true, ожидали false")
	}
}

func TestHireAssignsRole(t *testing.T) {
	g := New(emp2Config())
	g.Money = 50000
	g.Offices[0].Boss = "Тест Начальник"
	g.Offices[0].PCs = 10
	for range 10 {
		if err := g.Hire(0); err != nil {
			t.Fatal(err)
		}
	}
	if len(g.Offices[0].Employees) != 10 {
		t.Fatalf("нанято %d сотрудников, ожидали 10", len(g.Offices[0].Employees))
	}
	rolesSeen := map[string]bool{}
	for i, e := range g.Offices[0].Employees {
		if !ValidRole(e.Role) {
			t.Errorf("сотрудник %d имеет невалидную роль %q", i, e.Role)
		}
		rolesSeen[e.Role] = true
	}
	if len(rolesSeen) < 2 {
		t.Errorf("из 10 сотрудников слишком мало уникальных ролей (%d): %v", len(rolesSeen), rolesSeen)
	}
}

func TestRoleSurvivesSaveLoad(t *testing.T) {
	g := NewSeeded(DefaultConfig(), 12345)
	g.Money = 10000
	g.Offices[0].PCs = 2
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	e := g.Offices[0].Employees[0]
	if !ValidRole(e.Role) {
		t.Fatalf("роль при найме невалидна: %q", e.Role)
	}

	exported := g.Export()
	raw, err := json.Marshal(exported)
	if err != nil {
		t.Fatal(err)
	}

	var back Save
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	restored, err := Restore(back)
	if err != nil {
		t.Fatal(err)
	}
	if len(restored.Offices[0].Employees) != 1 {
		t.Fatalf("сотрудников после восстановления %d, ожидали 1", len(restored.Offices[0].Employees))
	}
	loadedRole := restored.Offices[0].Employees[0].Role
	if loadedRole != e.Role {
		t.Fatalf("роль после Restore %q != до %q", loadedRole, e.Role)
	}
}

func TestRoleOrDefaultFallback(t *testing.T) {
	eEmpty := Employee{}
	if got := eEmpty.RoleOrDefault(); got != RoleDeveloper {
		t.Errorf("eEmpty.RoleOrDefault() = %q, ожидали %q", got, RoleDeveloper)
	}
	eInvalid := Employee{Role: "invalid"}
	if got := eInvalid.RoleOrDefault(); got != RoleDeveloper {
		t.Errorf("eInvalid.RoleOrDefault() = %q, ожидали %q", got, RoleDeveloper)
	}
	eDesigner := Employee{Role: RoleDesigner}
	if got := eDesigner.RoleOrDefault(); got != RoleDesigner {
		t.Errorf("eDesigner.RoleOrDefault() = %q, ожидали %q", got, RoleDesigner)
	}
}

func TestDeterministicRolesWithSeed(t *testing.T) {
	run := func(seed uint64) []string {
		g := NewSeeded(DefaultConfig(), seed)
		g.Money = 10000
		g.Offices[0].PCs = 5
		for range 5 {
			if err := g.Hire(0); err != nil {
				t.Fatal(err)
			}
		}
		var roles []string
		for _, e := range g.Offices[0].Employees {
			roles = append(roles, e.Role)
		}
		return roles
	}

	r1 := run(42)
	r2 := run(42)
	if !slices.Equal(r1, r2) {
		t.Fatalf("роли с одним сидом разошлись: %v vs %v", r1, r2)
	}
}
