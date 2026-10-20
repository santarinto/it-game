package ws

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"

	"itdirector/internal/game"
	"itdirector/internal/metrics"
)

// Метрики сервера (ITGAME-189) — глобальные: тесты меряют приращения. Гейджи
// перед замером ждут тишины — хендлеры прошлых тестов дозакрываются асинхронно.

func histCount(t *testing.T, h prometheus.Histogram) uint64 {
	t.Helper()
	var m dto.Metric
	if err := h.Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetHistogram().GetSampleCount()
}

func histVecCount(t *testing.T, v *prometheus.HistogramVec, labels ...string) uint64 {
	t.Helper()
	return histCount(t, v.WithLabelValues(labels...).(prometheus.Histogram))
}

// settled — значение гейджа, не менявшееся 200 мс.
func settled(t *testing.T, g prometheus.Gauge) float64 {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	v, since := testutil.ToFloat64(g), time.Now()
	for time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
		if n := testutil.ToFloat64(g); n != v {
			v, since = n, time.Now()
		} else if time.Since(since) >= 200*time.Millisecond {
			return v
		}
	}
	t.Fatalf("гейдж не успокоился за 5с: %v", v)
	return 0
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("не дождались: %s", what)
}

func delta(c prometheus.Counter, before float64) float64 { return testutil.ToFloat64(c) - before }

// Партия от подключения до «Сдаться»: соединение и живая сессия в гейджах,
// старт по сложности, команды с исходом (неизвестная — одной меткой unknown),
// тики в гистограмме, финал abandon.
func TestMetricsPartyLifecycle(t *testing.T) {
	conn0 := settled(t, metrics.WSConnections)
	live0 := settled(t, metrics.LiveSessions)
	started := metrics.PartiesStarted.WithLabelValues("hard")
	speedOK := metrics.Commands.WithLabelValues("set_speed", "ok")
	speedBad := metrics.Commands.WithLabelValues("set_speed", "rejected")
	unknown := metrics.Commands.WithLabelValues("unknown", "rejected")
	abandonCmd := metrics.Commands.WithLabelValues("abandon", "ok")
	abandoned := metrics.PartiesFinished.WithLabelValues("abandon", "hard")
	started0, speedOK0, speedBad0 := testutil.ToFloat64(started), testutil.ToFloat64(speedOK), testutil.ToFloat64(speedBad)
	unknown0, abandonCmd0, abandoned0 := testutil.ToFloat64(unknown), testutil.ToFloat64(abandonCmd), testutil.ToFloat64(abandoned)
	ticks0 := histCount(t, metrics.TickSeconds)

	saves := newTestStore(t)
	c, ctx := dialSaves(t, saves, savesTestConfig(), 10*time.Millisecond, "?sid=metrics-life-1&difficulty=hard")
	readResume(t, ctx, c)
	eventually(t, "соединение и сессия в гейджах", func() bool {
		return testutil.ToFloat64(metrics.WSConnections) == conn0+1 && testutil.ToFloat64(metrics.LiveSessions) == live0+1
	})
	if d := delta(started, started0); d != 1 {
		t.Errorf("parties_started{hard} +%v, хотим +1", d)
	}

	if err := wsjson.Write(ctx, c, clientMessage{Type: "set_speed", Speed: 2, ID: 1}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Speed == 2 })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "set_speed", Speed: 9}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" && m.Code == "bad_speed" })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "no_such_command_xyz"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "error" && m.Code == "unknown_command" })
	if d := delta(speedOK, speedOK0); d != 1 {
		t.Errorf("commands{set_speed,ok} +%v, хотим +1", d)
	}
	if d := delta(speedBad, speedBad0); d != 1 {
		t.Errorf("commands{set_speed,rejected} +%v, хотим +1", d)
	}
	if d := delta(unknown, unknown0); d != 1 {
		t.Errorf("commands{unknown,rejected} +%v, хотим +1 (имя чужой команды в метку не идёт)", d)
	}
	eventually(t, "тики в itgame_tick_seconds", func() bool { return histCount(t, metrics.TickSeconds) > ticks0 })

	if err := wsjson.Write(ctx, c, clientMessage{Type: "abandon"}); err != nil {
		t.Fatal(err)
	}
	// Дочитать до закрытия: close-фрейм сервера ждёт ответа клиента, как браузер.
	for {
		var m testMessage
		if wsjson.Read(ctx, c, &m) != nil {
			break
		}
	}
	eventually(t, "соединение и сессия ушли из гейджей", func() bool {
		return testutil.ToFloat64(metrics.WSConnections) == conn0 && testutil.ToFloat64(metrics.LiveSessions) == live0
	})
	if d := delta(abandonCmd, abandonCmd0); d != 1 {
		t.Errorf("commands{abandon,ok} +%v, хотим +1", d)
	}
	if d := delta(abandoned, abandoned0); d != 1 {
		t.Errorf("parties_finished{abandon,hard} +%v, хотим +1", d)
	}
}

// Победа — финал victory и игровой день в гистограмме.
func TestMetricsVictory(t *testing.T) {
	won := metrics.PartiesFinished.WithLabelValues("victory", "normal")
	won0, days0 := testutil.ToFloat64(won), histVecCount(t, metrics.PartyDays, "victory")
	cfg := game.DefaultConfig()
	cfg.WinTarget = 500 // старт $600 ≥ цели: победа первым же тиком
	c, ctx := dialTestServer(t, cfg, 10*time.Millisecond)
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "victory" })
	if d := delta(won, won0); d != 1 {
		t.Errorf("parties_finished{victory,normal} +%v, хотим +1", d)
	}
	if d := histVecCount(t, metrics.PartyDays, "victory") - days0; d != 1 {
		t.Errorf("party_days{victory} +%d наблюдений, хотим +1", d)
	}
}

// Банкротство — финал bankrupt; restart после него — новая партия.
func TestMetricsBankruptcyAndRestart(t *testing.T) {
	broke := metrics.PartiesFinished.WithLabelValues("bankrupt", "normal")
	started := metrics.PartiesStarted.WithLabelValues("normal")
	broke0, started0 := testutil.ToFloat64(broke), testutil.ToFloat64(started)
	cfg := game.DefaultConfig()
	cfg.StarChancePct = 0
	cfg.EventChancePct = 0
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 100
	cfg.SalaryPerDay = 100000 // как TestSessionBankruptcyAndRestart: второй вечер — банкротство
	c, ctx := dialTestServer(t, cfg, 10*time.Millisecond)
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" })
	if err := wsjson.Write(ctx, c, clientMessage{Type: "next_day"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "game_over" })
	if d := delta(broke, broke0); d != 1 {
		t.Errorf("parties_finished{bankrupt,normal} +%v, хотим +1", d)
	}
	if err := wsjson.Write(ctx, c, clientMessage{Type: "restart"}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Phase == "running" && m.Day == 1 })
	if d := delta(started, started0); d != 2 {
		t.Errorf("parties_started{normal} +%v, хотим +2 (подключение и restart)", d)
	}
}

// Вторая вкладка с тем же sid: партия поднята из сейва, первую вытеснили.
func TestMetricsResumeAndTakeover(t *testing.T) {
	resumed0 := testutil.ToFloat64(metrics.PartiesResumed)
	taken0 := testutil.ToFloat64(metrics.SessionTakeovers)
	saves := newTestStore(t)
	srv := newSavesServer(t, &Handler{Config: savesTestConfig(), TickInterval: time.Hour, Saves: saves})
	c1, ctx1 := dialURL(t, srv.URL, "/ws?sid=metrics-take-1")
	readResume(t, ctx1, c1)
	c2, ctx2 := dialURL(t, srv.URL, "/ws?sid=metrics-take-1")
	if m := readResume(t, ctx2, c2); !m.Resumed {
		t.Fatal("вторая вкладка не подняла сейв")
	}
	if d := delta(metrics.PartiesResumed, resumed0); d != 1 {
		t.Errorf("parties_resumed +%v, хотим +1", d)
	}
	eventually(t, "session_takeovers +1", func() bool {
		return delta(metrics.SessionTakeovers, taken0) == 1
	})
}

// Обрыв сети (клиент молчит) — закрытие по таймауту чтения в счётчике.
func TestMetricsReadTimeout(t *testing.T) {
	timeouts0 := testutil.ToFloat64(metrics.ReadTimeouts)
	const sid = "metrics-mute-1"
	base, h := startLivenessServer(t, newTestStore(t), 20*time.Millisecond, 200*time.Millisecond)
	c, ctx := dialURL(t, base, "/ws?sid="+sid)
	readResume(t, ctx, c)
	waitGone(t, h, sid, 3*time.Second)
	if d := delta(metrics.ReadTimeouts, timeouts0); d != 1 {
		t.Errorf("ws_read_timeouts +%v, хотим +1", d)
	}
}

// Каждая команда протокола — литерал Command("…") в game и ws, так их собирает
// и gen-contract — есть в knownCommands: иначе новая команда ушла бы в unknown.
func TestKnownCommandsCoverProtocol(t *testing.T) {
	re := regexp.MustCompile(`\bCommand\("([a-z_]+)"\)`)
	var files []string
	for _, pat := range []string{"../game/*.go", "*.go"} {
		m, err := filepath.Glob(pat)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, m...)
	}
	found := map[game.Command]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range re.FindAllStringSubmatch(string(src), -1) {
			found[game.Command(m[1])] = true
		}
	}
	for cmd := range found {
		if !knownCommands[cmd] {
			t.Errorf("команда %q не в knownCommands (internal/ws/metrics.go)", cmd)
		}
	}
	for cmd := range knownCommands {
		if !found[cmd] {
			t.Errorf("knownCommands держит %q, которой нет в исходниках", cmd)
		}
	}
}
