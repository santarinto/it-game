package game

// Подписка на антивирус (ITGAME-137): одна на компанию, действует до отмены.
// Защищает первые Seats мест компании в порядке core (офисы 1 → 2 → 3, внутри
// офиса по найму), от сети не зависит; защищённое место не заражается ни
// вспышкой, ни волной, уже заражённое не лечит. Оплата — опекс: вечером с ФОТ
// по самому дорогому тарифу, включённому за день. GDD «Вирус (ITGAME-103)».

// antivirusTier — тариф t (1-based); t вне диапазона — nil.
func (g *Game) antivirusTier(t int) *AntivirusTier {
	if t < 1 || t > len(g.cfg.AntivirusTiers) {
		return nil
	}
	return &g.cfg.AntivirusTiers[t-1]
}

// antivirusPrice — цена тарифа t в день; 0 — без подписки.
func (g *Game) antivirusPrice(t int) int {
	if tier := g.antivirusTier(t); tier != nil {
		return tier.PricePerDay
	}
	return 0
}

// antivirusOpex — подписка, которую спишет вечер: самый дорогой тариф дня.
func (g *Game) antivirusOpex() int { return g.antivirusPrice(g.AVTierBilled) }

// AntivirusOpex — то же для протокола (state.antivirus.billedToday).
func (g *Game) AntivirusOpex() int { return g.antivirusOpex() }

// tierSeats — сколько мест защищает тариф t при штате staff (Seats 0 — все).
func (g *Game) tierSeats(t, staff int) int {
	tier := g.antivirusTier(t)
	if tier == nil {
		return 0
	}
	if tier.Seats == 0 {
		return staff
	}
	return min(tier.Seats, staff)
}

// AVCovered — какие места под подпиской: первые N занятых мест компании,
// офисы по порядку, внутри офиса по найму; увольнение сдвигает порядок.
func (g *Game) AVCovered() [][]bool {
	left := g.tierSeats(g.AVTier, g.staffCount())
	out := make([][]bool, len(g.Offices))
	for oi := range g.Offices {
		o := &g.Offices[oi]
		out[oi] = make([]bool, len(o.Employees))
		if !o.Unlocked {
			continue
		}
		for i := range o.Employees {
			if left == 0 {
				break
			}
			out[oi][i] = true
			left--
		}
	}
	return out
}

// AVCoveredCount — сколько мест под подпиской сейчас.
func (g *Game) AVCoveredCount() int { return g.tierSeats(g.AVTier, g.staffCount()) }

// SetAntivirus — подключить, сменить или отключить (tier 0) подписку.
// Повышение тарифа — покупка: при балансе меньше его цены дня отказ
// not_enough_money (в минусе покупки закрыты); понижение и отключение —
// всегда. День уже платит по самому дорогому тарифу, включённому сегодня.
func (g *Game) SetAntivirus(tier int) error {
	if tier < 0 || tier > len(g.cfg.AntivirusTiers) {
		return ErrBadTier
	}
	if tier == g.AVTier {
		return ErrAntivirusAlready
	}
	if tier > g.AVTier && g.Money < g.antivirusPrice(tier) {
		return ErrNotEnoughMoney
	}
	g.AVTier = tier
	g.AVTierBilled = max(g.AVTierBilled, tier)
	return nil
}

// fullCoverTier — самый дешёвый тариф, покрывающий весь текущий штат; 0 —
// текущий тариф уже покрывает (карточке вируса предлагать нечего).
func (g *Game) fullCoverTier() int {
	staff := g.staffCount()
	for t := 1; t <= len(g.cfg.AntivirusTiers); t++ {
		if g.tierSeats(t, staff) >= staff {
			if t <= g.AVTier {
				return 0
			}
			return t
		}
	}
	return 0
}

// AntivirusName — название включённого тарифа; "" — подписки нет.
func (g *Game) AntivirusName() string {
	if tier := g.antivirusTier(g.AVTier); tier != nil {
		return tier.Name
	}
	return ""
}
