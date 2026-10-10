package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"itdirector/internal/game"
	"itdirector/internal/store"
)

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.New(t.TempDir(), 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// newSavesServer — httptest-сервер, чей cleanup дожидается хендлеров.
// httptest.Server.Close не ждёт hijack-нутые (WS) соединения: актор,
// дописывающий сейв после разрыва, гонялся с удалением t.TempDir
// («directory not empty»). Cleanup регистрируется после создания стора,
// поэтому отрабатывает раньше удаления каталога, а закрытия соединений
// (регистрируются позже) — ещё раньше и останавливают акторов.
func newSavesServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	var wg sync.WaitGroup
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wg.Add(1)
		defer wg.Done()
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		// Close ждёт запросы до hijack — все wg.Add случились до Wait.
		srv.Close()
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("хендлеры не завершились за 10с после закрытия сервера")
		}
	})
	return srv
}

// dialSaves — сервер с включёнными сейвами; query адресует sid.
func dialSaves(t *testing.T, saves *store.Store, cfg game.Config, tick time.Duration, query string) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := newSavesServer(t, &Handler{Config: cfg, TickInterval: tick, Saves: saves})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+query, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c, ctx
}

// savesTestConfig — детерминированный конфиг: $10/тик, без случайностей.
func savesTestConfig() game.Config {
	cfg := game.DefaultConfig()
	cfg.IncomeMin, cfg.IncomeMax = 10, 10
	cfg.ThirstMult, cfg.HungerMult = 1, 1
	cfg.BreakdownChancePct = 0
	cfg.EventChancePct = 0
	cfg.StarChancePct = 0
	return cfg
}

// readResume — первый state после подключения.
func readResume(t *testing.T, ctx context.Context, c *websocket.Conn) testMessage {
	t.Helper()
	var msg testMessage
	if err := wsjson.Read(ctx, c, &msg); err != nil {
		t.Fatalf("первый снапшот: %v", err)
	}
	if msg.Type != "state" {
		t.Fatalf("хотели state, получили %s", msg.Type)
	}
	return msg
}

func TestResumeSameServer(t *testing.T) {
	saves := newTestStore(t)
	c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid=resume-1234")
	first := readResume(t, ctx, c)
	if first.Resumed || first.Money != 600 || len(first.Offices[0].Employees) != 0 {
		t.Fatalf("новая игра: %+v", first)
	}
	if err := wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0}); err != nil {
		t.Fatal(err)
	}
	hired := readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1
	})
	// Реконнект: разорвали соединение, подключились с тем же sid.
	c.CloseNow()
	c2, ctx2 := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid=resume-1234")
	resumed := readResume(t, ctx2, c2)
	if !resumed.Resumed {
		t.Fatal("снапшот не помечен resumed")
	}
	if resumed.Money != hired.Money || len(resumed.Offices[0].Employees) != 1 {
		t.Fatalf("прогресс потерян: %+v", resumed)
	}
	if resumed.Day != 1 || resumed.Clock != "10:00" {
		t.Fatalf("день/время: %d/%s, хотим 1/10:00", resumed.Day, resumed.Clock)
	}
}

func TestResumeAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	saves, err := store.New(dir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid=restart-12")
	readResume(t, ctx, c)
	wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0})
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1
	})
	c.CloseNow()

	// «Рестарт юнита»: новый стор на том же каталоге, новый хендлер.
	saves2, err := store.New(dir, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	c2, ctx2 := dialSaves(t, saves2, savesTestConfig(), time.Hour, "?sid=restart-12")
	resumed := readResume(t, ctx2, c2)
	if !resumed.Resumed || resumed.Money != 300 || len(resumed.Offices[0].Employees) != 1 {
		t.Fatalf("сейв не пережил рестарт: %+v", resumed)
	}
}

func TestResumeOfflineProgress(t *testing.T) {
	saves := newTestStore(t)
	// Готовим сейв «два часа назад»: день 1, тик 0, один сотрудник $10/тик.
	cfg := savesTestConfig()
	g := game.NewWithSeed(cfg, 11, 22)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	gen, _ := saves.Begin("offline-1234")
	raw, _ := json.Marshal(sessionSave{SID: "offline-1234", Speed: 1, SavedAt: old, Game: g.Export()})
	if !saves.Put("offline-1234", gen, raw, old) {
		t.Fatal("не удалось записать тестовый сейв")
	}

	c, ctx := dialSaves(t, saves, cfg, time.Second, "?sid=offline-1234")
	resumed := readResume(t, ctx, c)
	if !resumed.Resumed {
		t.Fatal("сейв не восстановился")
	}
	// 2ч = 7200 тиков: день 1 (54) + 132 полных дня + 18 тиков дня 134.
	if resumed.Day != 134 || resumed.Clock != "13:00" {
		t.Fatalf("день/время после догона: %d/%s, хотим 134/13:00", resumed.Day, resumed.Clock)
	}
	// День = 480 дохода − 250 ФОТ; итог: 300 + 133×230 + 18×10.
	want := 300 + 133*(480-250) + 18*10
	if resumed.Money != want {
		t.Fatalf("баланс после догона %d, хотим %d", resumed.Money, want)
	}
	var rep testMessage
	if err := wsjson.Read(ctx, c, &rep); err != nil {
		t.Fatalf("offline_report: %v", err)
	}
	if rep.Type != "offline_report" || rep.Days != 133 {
		t.Fatalf("offline_report: %+v", rep)
	}
}

// Догон внутри дня (приёмка 10.10): offline_report приходит и с days 0 —
// окно клиент не покажет, но itd.offline() видит, что догон был.
func TestResumeOfflineInsideDaySendsReport(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	g := game.NewWithSeed(cfg, 11, 22)
	old := time.Now().Add(-20 * time.Second)
	gen, _ := saves.Begin("inday-12345")
	raw, _ := json.Marshal(sessionSave{SID: "inday-12345", Speed: 1, SavedAt: old, Game: g.Export()})
	if !saves.Put("inday-12345", gen, raw, old) {
		t.Fatal("не удалось записать тестовый сейв")
	}

	c, ctx := dialSaves(t, saves, cfg, time.Second, "?sid=inday-12345")
	if resumed := readResume(t, ctx, c); !resumed.Resumed || resumed.Day != 1 {
		t.Fatalf("после догона: %+v, хотим день 1", resumed)
	}
	var rep testMessage
	if err := wsjson.Read(ctx, c, &rep); err != nil {
		t.Fatalf("offline_report: %v", err)
	}
	// 20 с на 1× = 20 тиков из 54: день не сменился.
	if rep.Type != "offline_report" || rep.Days != 0 || rep.Ticks < 19 || rep.Ticks > 21 {
		t.Fatalf("offline_report внутри дня: %+v, хотим days 0, ticks ≈20", rep)
	}
	if rep.SavedAt != old.UnixMilli() {
		t.Fatalf("offline_report.savedAt %d, хотим время сейва %d", rep.SavedAt, old.UnixMilli())
	}
}

func TestAbandonDeletesSave(t *testing.T) {
	saves := newTestStore(t)
	c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid=gone-12345")
	readResume(t, ctx, c)
	wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0})
	readUntil(t, ctx, c, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1
	})
	if err := wsjson.Write(ctx, c, clientMessage{Type: "abandon"}); err != nil {
		t.Fatal(err)
	}
	// Сервер удаляет сейв и закрывает соединение.
	var m testMessage
	if err := wsjson.Read(ctx, c, &m); err == nil {
		t.Fatalf("после abandon соединение должно закрыться, получили %+v", m)
	}
	c2, ctx2 := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid=gone-12345")
	fresh := readResume(t, ctx2, c2)
	if fresh.Resumed || fresh.Money != 600 || len(fresh.Offices[0].Employees) != 0 {
		t.Fatalf("после abandon игра должна начинаться заново: %+v", fresh)
	}
}

func TestTakeoverClosesFirstConnection(t *testing.T) {
	saves := newTestStore(t)
	c1, ctx1 := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid=duel-12345")
	readResume(t, ctx1, c1)
	wsjson.Write(ctx1, c1, clientMessage{Type: "hire", Office: 0})
	readUntil(t, ctx1, c1, func(m testMessage) bool {
		return m.Type == "state" && len(m.Offices[0].Employees) == 1
	})

	// Вторая вкладка: тот же sid — забирает сессию.
	c2, ctx2 := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid=duel-12345")
	resumed := readResume(t, ctx2, c2)
	if !resumed.Resumed || len(resumed.Offices[0].Employees) != 1 {
		t.Fatalf("вторая вкладка не получила сессию: %+v", resumed)
	}
	// Первое соединение закрывается с session_taken.
	var msg testMessage
	err := wsjson.Read(ctx1, c1, &msg)
	if err == nil {
		t.Fatalf("первое соединение живо после takeover: %+v", msg)
	}
	if !strings.Contains(err.Error(), "session_taken") {
		t.Fatalf("причина закрытия: %v, хотим session_taken", err)
	}
}

func TestVictoryDeletesSave(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	cfg.WinTarget = 500 // старт $600 ≥ цели: победа первым тиком
	c, ctx := dialSaves(t, saves, cfg, 10*time.Millisecond, "?sid=won-123456")
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "victory" })
	c.CloseNow()

	c2, ctx2 := dialSaves(t, saves, cfg, time.Hour, "?sid=won-123456")
	fresh := readResume(t, ctx2, c2)
	if fresh.Resumed || fresh.Money != 600 {
		t.Fatalf("после победы сейв должен удаляться: %+v", fresh)
	}
}

func TestResumeResendsDayReport(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	// День из 4 тиков: 1 час по 4 тика.
	cfg.WorkdayEnd = cfg.WorkdayStart + 1
	cfg.TicksPerHour = 4
	c, ctx := dialSaves(t, saves, cfg, 10*time.Millisecond, "?sid=report-1234")
	readResume(t, ctx, c)
	wsjson.Write(ctx, c, clientMessage{Type: "hire", Office: 0})
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && len(m.Offices[0].Employees) == 1 })
	rep := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "day_report" })
	if rep.Day != 1 {
		t.Fatalf("отчёт дня 1: %+v", rep)
	}
	c.CloseNow()

	c2, ctx2 := dialSaves(t, saves, cfg, time.Hour, "?sid=report-1234")
	resumed := readResume(t, ctx2, c2)
	if !resumed.Resumed || resumed.Phase != "day_report" {
		t.Fatalf("хотели resumed в day_report: %+v", resumed)
	}
	again := readUntil(t, ctx2, c2, func(m testMessage) bool { return m.Type == "day_report" })
	if again.Day != 1 || again.Balance != rep.Balance {
		t.Fatalf("отчёт не переслан: %+v vs %+v", again, rep)
	}
	// next_day продолжает игру.
	wsjson.Write(ctx2, c2, clientMessage{Type: "next_day"})
	readUntil(t, ctx2, c2, func(m testMessage) bool {
		return m.Type == "state" && m.Day == 2 && m.Phase == "running"
	})
}

// loadSave — сейв sid из стора как sessionSave (ITGAME-65).
func loadSave(t *testing.T, saves *store.Store, sid string) sessionSave {
	t.Helper()
	raw, ok := saves.Load(sid)
	if !ok {
		t.Fatalf("сейва %s нет", sid)
	}
	var ss sessionSave
	if err := json.Unmarshal(raw, &ss); err != nil {
		t.Fatal(err)
	}
	return ss
}

// Явный выход (ITGAME-65): партия замирает, сейв хранит speed 0 и скорость
// возврата; «Продолжить» возвращает её без догона, следующий persist обнуляет.
func TestExitSavesPauseAndResumeSpeed(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	c, ctx := dialSaves(t, saves, cfg, time.Hour, "?sid=exit-123456")
	readResume(t, ctx, c)
	if err := wsjson.Write(ctx, c, clientMessage{Type: "set_speed", Speed: 3}); err != nil {
		t.Fatal(err)
	}
	before := readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Speed == 3 })

	if err := wsjson.Write(ctx, c, clientMessage{Type: "exit", Speed: 3}); err != nil {
		t.Fatal(err)
	}
	// Актор сохраняет до ответа: к этому снапшоту сейв уже на диске.
	readUntil(t, ctx, c, func(m testMessage) bool { return m.Type == "state" && m.Speed == 0 })
	ss := loadSave(t, saves, "exit-123456")
	if ss.Speed != 0 || ss.ResumeSpeed != 3 {
		t.Fatalf("сейв после exit: speed %d resumeSpeed %d, хотим 0/3", ss.Speed, ss.ResumeSpeed)
	}
	c.CloseNow()

	c2, ctx2 := dialSaves(t, saves, cfg, time.Hour, "?sid=exit-123456")
	resumed := readResume(t, ctx2, c2)
	if !resumed.Resumed || resumed.Speed != 3 {
		t.Fatalf("«Продолжить»: resumed %v speed %d, хотим true/3", resumed.Resumed, resumed.Speed)
	}
	if resumed.Day != before.Day || resumed.Clock != before.Clock || resumed.Money != before.Money {
		t.Fatalf("партия сдвинулась: день %d %s $%d, было день %d %s $%d",
			resumed.Day, resumed.Clock, resumed.Money, before.Day, before.Clock, before.Money)
	}
	// persist в run() идёт до первого снапшота: ResumeSpeed уже съеден.
	ss = loadSave(t, saves, "exit-123456")
	if ss.Speed != 3 || ss.ResumeSpeed != 0 {
		t.Fatalf("сейв после «Продолжить»: speed %d resumeSpeed %d, хотим 3/0", ss.Speed, ss.ResumeSpeed)
	}
}

// Сейв после exit лежит давно: офлайн-догона нет (speed 0 — пауза), партия
// продолжается на ResumeSpeed.
func TestResumeAfterExitSkipsOffline(t *testing.T) {
	saves := newTestStore(t)
	cfg := savesTestConfig()
	g := game.NewWithSeed(cfg, 11, 22)
	if err := g.Hire(0); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	gen, _ := saves.Begin("exitoff-1234")
	raw, _ := json.Marshal(sessionSave{SID: "exitoff-1234", Speed: 0, ResumeSpeed: 2, SavedAt: old, Game: g.Export()})
	if !saves.Put("exitoff-1234", gen, raw, old) {
		t.Fatal("не удалось записать тестовый сейв")
	}

	c, ctx := dialSaves(t, saves, cfg, time.Second, "?sid=exitoff-1234")
	first := readResume(t, ctx, c)
	// Если бы догон шёл со скоростью ResumeSpeed, 2ч на 2× дали бы день ≈ 267.
	if !first.Resumed || first.Day != 1 || first.Clock != "10:00" || first.Money != g.Money || first.Speed != 2 {
		t.Fatalf("после «Продолжить»: %+v, хотим день 1 10:00 $%d speed 2", first, g.Money)
	}
	// offline_report пишется сразу за первым снапшотом, до любого тика.
	var next testMessage
	if err := wsjson.Read(ctx, c, &next); err != nil {
		t.Fatal(err)
	}
	if next.Type != "state" {
		t.Fatalf("после первого снапшота ждали state (тик), получили %s", next.Type)
	}
	if ss := loadSave(t, saves, "exitoff-1234"); ss.ResumeSpeed != 0 {
		t.Fatalf("ResumeSpeed не обнулился: %d", ss.ResumeSpeed)
	}
}

// exit зажимает скорость в 0..3 и не отвечает bad_speed; set_speed
// возврат снимает: явный выбор игрока главнее.
func TestExitClampsAndSetSpeedClears(t *testing.T) {
	saves := newTestStore(t)
	c, ctx := dialSaves(t, saves, savesTestConfig(), time.Hour, "?sid=exitclamp-12")
	readResume(t, ctx, c)
	// Любой error за время теста — провал: readUntil их пропускает, ловим вручную.
	step := func(msg clientMessage, wantSpeed int) sessionSave {
		t.Helper()
		if err := wsjson.Write(ctx, c, msg); err != nil {
			t.Fatal(err)
		}
		readUntil(t, ctx, c, func(m testMessage) bool {
			if m.Type == "error" {
				t.Fatalf("%s %d: error %s", msg.Type, msg.Speed, m.Code)
			}
			return m.Type == "state" && m.Speed == wantSpeed
		})
		return loadSave(t, saves, "exitclamp-12")
	}
	if ss := step(clientMessage{Type: "exit", Speed: 9}, 0); ss.Speed != 0 || ss.ResumeSpeed != 3 {
		t.Fatalf("exit 9: speed %d resumeSpeed %d, хотим 0/3", ss.Speed, ss.ResumeSpeed)
	}
	if ss := step(clientMessage{Type: "set_speed", Speed: 1}, 1); ss.Speed != 1 || ss.ResumeSpeed != 0 {
		t.Fatalf("set_speed 1: speed %d resumeSpeed %d, хотим 1/0", ss.Speed, ss.ResumeSpeed)
	}
	if ss := step(clientMessage{Type: "exit", Speed: -1}, 0); ss.Speed != 0 || ss.ResumeSpeed != 0 {
		t.Fatalf("exit -1: speed %d resumeSpeed %d, хотим 0/0", ss.Speed, ss.ResumeSpeed)
	}
}
