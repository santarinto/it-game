package game

// CheckAchievements проверяет выполнение условий 12 канонических достижений (ITGAME-10 / ITGAME-132).
// unlocked — уже открытые ачивки (id -> true).
// isVictory — истина, если партия завершилась победой (PhaseWon).
// Возвращает слайс ID новых открытых достижений.
func CheckAchievements(g *Game, unlocked map[string]bool, isVictory bool) []string {
	if g == nil {
		return nil
	}
	var newlyUnlocked []string
	tryUnlock := func(id string, condition bool) {
		if condition && (unlocked == nil || !unlocked[id]) {
			newlyUnlocked = append(newlyUnlocked, id)
		}
	}

	staff := g.TotalEmployees()
	officeSlots := g.cfg.OfficeSlots
	if officeSlots <= 0 {
		officeSlots = 12
	}
	totalSlots := officeSlots * len(g.Offices)
	if totalSlots <= 0 {
		totalSlots = 36
	}
	hasCoffee := false
	hasStar := false
	allOfficesUnlocked := len(g.Offices) >= 3
	noAmenities := true

	for _, o := range g.Offices {
		if o.CoffeeMachine {
			hasCoffee = true
		}
		if o.Cooler || o.Fridge || o.CoffeeMachine {
			noAmenities = false
		}
		if !o.Unlocked {
			allOfficesUnlocked = false
		}
		for _, e := range o.Employees {
			if e.Star {
				hasStar = true
			}
		}
	}

	// 1. Первые кадры: штат > 0
	tryUnlock("first_hire", staff > 0)

	// 2. Первый рабочий день: день > 1
	tryUnlock("first_day", g.Day > 1)

	// 3. Кофейная пауза: кофемашина в любом офисе
	tryUnlock("coffee_break", hasCoffee)

	// 4. Охотник за звёздами: хотя бы один звёздный сотрудник
	tryUnlock("star_hunter", hasStar)

	// 5. 10 дней без банкротства: день > 10
	tryUnlock("survivor_10", g.Day > 10)

	// 6. Корпорация: все 3 офиса разблокированы
	tryUnlock("three_offices", allOfficesUnlocked)

	// 7. Полный штат: все сотрудники наняты (все слоты заняты)
	tryUnlock("full_staff", staff >= totalSlots)

	// 8. Ядро системы: Core прокачан на максимум
	tryUnlock("core_max", g.CoreLevel >= len(g.cfg.CoreLevels))

	// 9. 36/36 в сети: все сотрудники подключены к сети
	net := g.Network()
	tryUnlock("network_36", staff >= totalSlots && net.CoreUsed >= totalSlots)

	// 10. Первый миллион: баланс >= 1 000 000
	tryUnlock("millionaire", g.Money >= 1_000_000)

	// 11. Победа без аменити: кулеров, холодильников и кофе нет ни в одном офисе
	if isVictory {
		tryUnlock("clean_win", noAmenities)
	}

	// 12. Хардкорный директор: победа на сложности hardcore
	if isVictory {
		tryUnlock("hardcore_win", g.cfg.Difficulty == DiffHardcore)
	}

	return newlyUnlocked
}
