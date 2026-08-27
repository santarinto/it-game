package game

import (
	"errors"
	"fmt"
	"math/rand/v2"
)

// Сейвы сессии (ITGAME-8): игра сериализуется целиком — конфиг, с которым
// она создана, и все поля состояния. Роллы RNG в сейв не входят: после
// восстановления игра продолжает со свежим сидом (детерминизм NewWithSeed
// нужен тестам, а не геймплею).

// ErrBadSave — сейв повреждён или несовместим: восстановиться нельзя,
// сессия начинается заново.
var ErrBadSave = errors.New("bad_save")

// Save — сериализуемый слепок Game: конфиг плюс все поля состояния.
// Поле в день отчёта (Phase=day_report) валидно: TickInDay при этом равен
// длине дня, отчёт дошлёт ws-слой из LastReport.
type Save struct {
	Config            Config    `json:"config"`
	Money             int       `json:"money"`
	Offices           []Office  `json:"offices"`
	CoreLevel         int       `json:"coreLevel"`
	Gateway           bool      `json:"gateway"`
	Phase             Phase     `json:"phase"`
	Day               int       `json:"day"`
	TickInDay         int       `json:"tickInDay"`
	DayIncome         int       `json:"dayIncome"`
	PeakIncomePerTick int       `json:"peakIncomePerTick"`
	DayIncidents      int       `json:"dayIncidents"`
	DayLostIncome     int       `json:"dayLostIncome"`
	DayEvents         []DayEvent `json:"dayEvents"`
	ActiveEvent       *DayEvent `json:"activeEvent"`
	EventLog          []string  `json:"eventLog"`
	DeadlineOn        bool      `json:"deadlineOn"`
	DeadlineGot       int       `json:"deadlineGot"`
	DeadlineGoal      int       `json:"deadlineGoal"`
	MarketToday       int       `json:"marketToday"`    // рынок дня, % (Сложность 2.0)
	MarketTomorrow    int       `json:"marketTomorrow"` // завтрашний ролл, виден заранее
}

// Export — слепок текущего состояния для сейва.
func (g *Game) Export() Save {
	return Save{
		Config: g.cfg, Money: g.Money, Offices: g.Offices, CoreLevel: g.CoreLevel,
		Gateway: g.Gateway, Phase: g.Phase, Day: g.Day, TickInDay: g.TickInDay,
		DayIncome: g.DayIncome, PeakIncomePerTick: g.PeakIncomePerTick,
		DayIncidents: g.DayIncidents, DayLostIncome: g.DayLostIncome,
		DayEvents: g.DayEvents, ActiveEvent: g.ActiveEvent, EventLog: g.EventLog,
		DeadlineOn: g.DeadlineOn, DeadlineGot: g.DeadlineGot, DeadlineGoal: g.DeadlineGoal,
		MarketToday: g.MarketToday, MarketTomorrow: g.MarketTomorrow,
	}
}

// Restore — игра из сейва. Ошибку возвращает ErrBadSave: битые сейвы
// молча заменяются новой игрой, это не авария сервера.
func Restore(s Save) (*Game, error) {
	if s.Day < 1 || len(s.Offices) == 0 || !s.Offices[0].Unlocked {
		return nil, fmt.Errorf("%w: day=%d offices=%d", ErrBadSave, s.Day, len(s.Offices))
	}
	dayTicks := s.Config.DayTicks()
	if dayTicks <= 0 || s.TickInDay < 0 || s.TickInDay > dayTicks {
		return nil, fmt.Errorf("%w: tickInDay=%d dayTicks=%d", ErrBadSave, s.TickInDay, dayTicks)
	}
	switch s.Phase {
	case PhaseRunning:
		if s.TickInDay >= dayTicks {
			return nil, fmt.Errorf("%w: running за концом дня", ErrBadSave)
		}
	case PhaseDayReport:
		// валидно: ждём next_day
	default:
		return nil, fmt.Errorf("%w: фаза %q не восстанавливается", ErrBadSave, s.Phase)
	}
	g := &Game{
		cfg: s.Config, rng: rand.New(rand.NewPCG(rand.Uint64(), rand.Uint64())),
		Money: s.Money, Offices: s.Offices, CoreLevel: s.CoreLevel, Gateway: s.Gateway,
		Phase: s.Phase, Day: s.Day, TickInDay: s.TickInDay,
		DayIncome: s.DayIncome, PeakIncomePerTick: s.PeakIncomePerTick,
		DayIncidents: s.DayIncidents, DayLostIncome: s.DayLostIncome,
		DayEvents: s.DayEvents, ActiveEvent: s.ActiveEvent, EventLog: s.EventLog,
		DeadlineOn: s.DeadlineOn, DeadlineGot: s.DeadlineGot, DeadlineGoal: s.DeadlineGoal,
		MarketToday: s.MarketToday, MarketTomorrow: s.MarketTomorrow,
	}
	return g, nil
}
