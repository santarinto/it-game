// Package metrics — метрики сервера в формате Prometheus (ITGAME-189):
// нагрузка (соединения, живые сессии, тики, сейвы) и игра (партии, финалы,
// команды) плюс рантайм Go и процесса. Отдаёт их отдельный listener
// (-metrics-addr, cmd/server), не публичный mux; собирает Prometheus minipc.
//
// sid в метки не идёт: кардинальность и приватность игрока. Метки — только
// конечные наборы: сложность, исход финала, имя известной команды.
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Registry — свой реестр, не глобальный prometheus.DefaultRegisterer: в
// скрейп попадает ровно то, что объявлено здесь.
var Registry = prometheus.NewRegistry()

var reg = promauto.With(Registry)

// Нагрузка.
var (
	WSConnections = reg.NewGauge(prometheus.GaugeOpts{
		Name: "itgame_ws_connections",
		Help: "Открытые /ws-соединения вкладок.",
	})
	LiveSessions = reg.NewGauge(prometheus.GaugeOpts{
		Name: "itgame_sessions_live",
		Help: "Живые акторы партий (с headless-сессиями агента).",
	})
	TickSeconds = reg.NewHistogram(prometheus.HistogramOpts{
		Name:    "itgame_tick_seconds",
		Help:    "Время актора на тик: шаг игры и сейв.",
		Buckets: prometheus.ExponentialBuckets(0.00005, 4, 8), // 50 мкс … ~0.8 с
	})
	SaveSeconds = reg.NewHistogram(prometheus.HistogramOpts{
		Name:    "itgame_save_seconds",
		Help:    "Длительность записи сейва (store.Put): временный файл и переименование.",
		Buckets: prometheus.ExponentialBuckets(0.00002, 4, 8), // 20 мкс … ~0.3 с
	})
	Saves = reg.NewCounterVec(prometheus.CounterOpts{
		Name: "itgame_saves_total",
		Help: "Сейвы по исходу: ok — записан, stale — сессию забрал другой актор.",
	}, []string{"result"})
	SaveErrors = reg.NewCounterVec(prometheus.CounterOpts{
		Name: "itgame_save_errors_total",
		Help: "Ошибки файла сейва: write — временный файл, rename — замена <sid>.json. Память сейв держит.",
	}, []string{"op"})
	SessionTakeovers = reg.NewCounter(prometheus.CounterOpts{
		Name: "itgame_session_takeovers_total",
		Help: "Сессию забрала другая вкладка того же sid (session_taken).",
	})
	ReadTimeouts = reg.NewCounter(prometheus.CounterOpts{
		Name: "itgame_ws_read_timeouts_total",
		Help: "Вкладки, закрытые по таймауту чтения: обрыв сети без close-фрейма (ITGAME-76).",
	})
)

// Игра.
var (
	PartiesStarted = reg.NewCounterVec(prometheus.CounterOpts{
		Name: "itgame_parties_started_total",
		Help: "Новые партии по сложности: без сейва или restart после банкротства.",
	}, []string{"difficulty"})
	PartiesResumed = reg.NewCounter(prometheus.CounterOpts{
		Name: "itgame_parties_resumed_total",
		Help: "Партии, поднятые из сейва при подключении.",
	})
	PartiesFinished = reg.NewCounterVec(prometheus.CounterOpts{
		Name: "itgame_parties_finished_total",
		Help: "Финалы партий: bankrupt, victory, abandon («Сдаться»).",
	}, []string{"outcome", "difficulty"})
	PartyDays = reg.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "itgame_party_days",
		Help:    "Игровой день на финале партии.",
		Buckets: []float64{1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90},
	}, []string{"outcome"})
	Commands = reg.NewCounterVec(prometheus.CounterOpts{
		Name: "itgame_commands_total",
		Help: "Команды игроков: cmd — имя известной команды (иначе unknown), result — ok или rejected.",
	}, []string{"cmd", "result"})
)

var buildInfo = reg.NewGaugeVec(prometheus.GaugeOpts{
	Name: "itgame_build_info",
	Help: "Сборка сервера (как /api/version): всегда 1.",
}, []string{"sha", "version"})

// Outcomes — исходы финала, метка outcome у PartiesFinished и PartyDays.
var Outcomes = []string{"bankrupt", "victory", "abandon"}

func init() {
	Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	for _, r := range []string{"ok", "stale"} {
		Saves.WithLabelValues(r)
	}
	for _, op := range []string{"write", "rename"} {
		SaveErrors.WithLabelValues(op)
	}
}

// Preset — ряды с метками нулями с самого старта. Вектор заводит ряд только на
// первом Inc, и Prometheus получает его сразу единицей: increase() и rate() не
// видят скачка 0 → 1, и первое событие каждого набора меток после рестарта (то
// есть после каждого деплоя) пропадает с дашборда — так «Партий начато» на
// стейдже 20.10 показывало 0 при itgame_parties_started_total 1 (ITGAME-189).
// difficulties — все сложности, commands — имена команд для метки cmd (с unknown).
func Preset(difficulties, commands []string) {
	for _, d := range difficulties {
		PartiesStarted.WithLabelValues(d)
		for _, o := range Outcomes {
			PartiesFinished.WithLabelValues(o, d)
		}
	}
	for _, o := range Outcomes {
		PartyDays.WithLabelValues(o)
	}
	for _, c := range commands {
		for _, r := range []string{"ok", "rejected"} {
			Commands.WithLabelValues(c, r)
		}
	}
}

// SetBuild — сборка процесса в itgame_build_info; прежние метки снимаются.
func SetBuild(sha, version string) {
	buildInfo.Reset()
	buildInfo.WithLabelValues(sha, version).Set(1)
}

// Handler — скрейп реестра в текстовом формате Prometheus.
func Handler() http.Handler {
	return promhttp.HandlerFor(Registry, promhttp.HandlerOpts{})
}
