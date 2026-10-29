package game

import (
	"math/rand/v2"
	"slices"
)

// Роли сотрудников (ITGAME-197): саппорт, программист, тестировщик, дизайнер,
// лид, ПМ, аналитик. Заглушки спрайтов подготовлены в ITGAME-243.
const (
	RoleDeveloper = "developer" // Программист
	RoleTester    = "tester"    // Тестировщик
	RoleSupport   = "support"   // Саппорт
	RoleDesigner  = "designer"  // Дизайнер
	RolePM        = "pm"        // ПМ (проджект-менеджер)
	RoleLead      = "lead"      // Лид
	RoleAnalyst   = "analyst"   // Аналитик
)

// AllRoles — полный список всех 7 ролей сотрудников компании.
var AllRoles = []string{
	RoleDeveloper,
	RoleTester,
	RoleSupport,
	RoleDesigner,
	RolePM,
	RoleLead,
	RoleAnalyst,
}

// ValidRole проверяет, входит ли строка в допустимые роли.
func ValidRole(role string) bool {
	return slices.Contains(AllRoles, role)
}

// rollRole выбирает случайную роль из пула ролей.
func rollRole(rng *rand.Rand) string {
	return AllRoles[rng.IntN(len(AllRoles))]
}

// RoleOrDefault возвращает роль сотрудника или RoleDeveloper, если роль не задана.
func (e *Employee) RoleOrDefault() string {
	if ValidRole(e.Role) {
		return e.Role
	}
	return RoleDeveloper
}
