// sim — headless-симулятор ядра игры (ITGAME-27): прогоны баланса без
// браузера и рук. Ядро живёт в internal/game, Phaser не нужен.
//
//	go run ./cmd/sim --diff hard --seed 1..50 --days 30 --policy greedy --out runs.csv
//
// CSV: policy,seed,day,money,income,payroll,events,outcome — по строке на
// закрытый день; outcome — running в промежуточных строках и финал в
// последней: bankrupt | time_up | deadlock — проигрыш вечером (LoseReason
// ядра), victory — победа среди дня, timeout — дни прогона кончились, партия
// жива. Один прогон закрывает вопросы «проходим ли ХАРДКОР» и «как часто
// аудит убивает до 5-го дня».
//
// Флаги ITGAME-50 (подбор штрафа аудита):
//
//	--events-text   в колонке events — имена событий через " | " вместо их числа
//	--audit-share   доля дохода прошлого дня в штрафе аудита (−1 — из конфига)
//	--audit-stats   одна строка статистики аудита в stderr после сводки
//
// Флаги ITGAME-196 (замеры случайных событий «до/после»):
//
//	--event-stats   по строке «sim events: …» на политику в stderr: поломки,
//	                вспышки, события пула за сыгранный день
//	--answer-raise  accept | decline — sim отвечает на «Просит повышения»
//	--policy expand greedy + покупка следующего офиса, когда все набраны
package main

import (
	"encoding/csv"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"slices"
	"strconv"
	"strings"

	"itdirector/internal/game"
)

type policyFunc func(g *game.Game, rng *rand.Rand, hour int)

// raiseAnswer — ответ на «Просит повышения» (--answer-raise): accept | decline.
var raiseAnswer string

// eventsText — колонка events: имена событий вместо их числа (--events-text).
var eventsText bool

// auditStats — счётчики аудита за все партии прогона (--audit-stats).
type auditStats struct {
	bankrupt int // банкротств всего
	auditDay int // банкротств в день проваленного аудита
	early    int // из них на днях ≤ 7
	failed   int // проваленных аудитов
}

func pct(a, b int) float64 {
	if b == 0 {
		return 0
	}
	return 100 * float64(a) / float64(b)
}

func main() {
	diff := flag.String("diff", "normal", "easy | normal | hard | hardcore")
	seedRange := flag.String("seed", "1..20", "сиды: N, N..M, N..M шагом 1")
	days := flag.Int("days", 30, "сколько дней на партию")
	policyFlag := flag.String("policy", "all", "greedy | idle | random | all (эти три) | handsoff | delegate | expand")
	out := flag.String("out", "", "путь CSV (пусто — stdout)")
	eventsTextFlag := flag.Bool("events-text", false, "в колонке events — имена событий через \" | \" вместо их числа")
	auditShare := flag.Float64("audit-share", -1, "доля дохода прошлого дня в штрафе аудита (перекрывает конфиг; −1 — из конфига)")
	auditStatsFlag := flag.Bool("audit-stats", false, "строка статистики аудита в stderr после сводки")
	eventStatsFlag := flag.Bool("event-stats", false, "строка статистики случайных событий в stderr на каждую политику")
	answerRaiseFlag := flag.String("answer-raise", "", "accept | decline — sim отвечает на «Просит повышения» в тик появления (пусто — не отвечает)")
	flag.Parse()
	if m := *answerRaiseFlag; m != "" && m != "accept" && m != "decline" {
		fmt.Fprintf(os.Stderr, "sim: --answer-raise %q не понят (accept | decline)\n", m)
		os.Exit(1)
	}
	raiseAnswer = *answerRaiseFlag
	eventsText = *eventsTextFlag

	seeds, err := parseSeeds(*seedRange)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sim: %v\n", err)
		os.Exit(1)
	}
	policies := map[string]policyFunc{"greedy": greedyPolicy, "idle": idlePolicy, "random": randomPolicy,
		"handsoff": handsoffPolicy, "delegate": delegatePolicy, "expand": expandPolicy}
	wanted := []string{*policyFlag}
	if *policyFlag == "all" {
		wanted = []string{"greedy", "idle", "random"}
	}

	var w *csv.Writer
	closeOut := func() {}
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "sim: %v\n", err)
			os.Exit(1)
		}
		w = csv.NewWriter(f)
		closeOut = func() { w.Flush(); f.Close() }
	} else {
		w = csv.NewWriter(os.Stdout)
	}
	defer closeOut()
	_ = w.Write([]string{"policy", "seed", "day", "money", "income", "payroll", "events", "outcome"})

	cfg := game.ConfigForDifficulty(game.ParseDifficulty(*diff))
	if *auditShare >= 0 {
		cfg.AuditFineShare = *auditShare
	}
	outcomes := map[string]int{}
	var st auditStats
	records := map[string][]dayRecord{}
	for _, name := range wanted {
		policy := policies[name]
		for _, seed := range seeds {
			outcome := runOne(w, cfg, name, policy, seed, *days, &st, records)
			outcomes[name+"/"+outcome]++
		}
	}
	w.Flush()
	fmt.Fprintf(os.Stderr, "sim: %s, сидов %d, дней %d — исходы: %s\n",
		*diff, len(seeds)*len(wanted), *days, joinCounts(outcomes))
	if *auditStatsFlag {
		fmt.Fprintf(os.Stderr, "sim audit: diff=%s policy=%s seeds=%d days=%d share=%.2f bankrupt=%d audit_day=%d of_bankrupt=%.1f%% failed_audits=%d bankrupt_of_failed=%.1f%% early=%d\n",
			*diff, *policyFlag, len(seeds), *days, cfg.AuditFineShare, st.bankrupt, st.auditDay, pct(st.auditDay, st.bankrupt), st.failed, pct(st.auditDay, st.failed), st.early)
	}
	if *eventStatsFlag {
		for _, name := range wanted {
			fmt.Fprintln(os.Stderr, eventStatsLine(*diff, name, len(seeds), *days, records[name]))
		}
	}
}

// runOne — одна партия: политика решает каждый час, дни закрываются
// честными тиками ядра. Возвращает финал партии.
func runOne(w *csv.Writer, cfg game.Config, name string, policy policyFunc, seed, days int, st *auditStats, records map[string][]dayRecord) string {
	g := game.NewSeeded(cfg, uint64(seed))
	rng := rand.New(rand.NewPCG(uint64(seed), 0xC0FFEE)) // свой поток — политика не расходует игровые роллы
	outcome := "running"
	plan := dayPlan(g)
	var outbreaks int
	var seen *game.DayEvent // последнее активное событие: смена указателя = новая активация
	for g.Day <= days && outcome == "running" {
		// игровой день по тикам; политика думает раз в час
		for g.Phase == game.PhaseRunning {
			if g.TickInDay%cfg.TicksPerHour == 0 {
				policy(g, rng, g.TickInDay/cfg.TicksPerHour)
			}
			report := g.Tick()
			if ev := g.ActiveEvent; ev != nil && ev != seen {
				seen = ev
				if ev.ID == game.EventVirus && !ev.Repelled {
					outbreaks++
				}
			}
			if report == nil {
				answerRaise(g, raiseAnswer)
			}
			if report != nil {
				outcome = dayOutcome(g, report)
				failed := slices.ContainsFunc(report.Events, func(e string) bool {
					return strings.Contains(e, "аудит провален")
				})
				if failed {
					st.failed++
				}
				if outcome == string(game.LoseBankrupt) {
					st.bankrupt++
					if failed {
						st.auditDay++
						if report.Day <= 7 {
							st.early++
						}
					}
				}
				writeRow(w, name, seed, report, outcome)
				records[name] = append(records[name], dayRecord{Breakdowns: report.Incidents,
					Infected: report.VirusPCs, Outbreaks: outbreaks, Plan: plan, Budget: cfg.EventBudget})
				break
			}
			if g.Phase == game.PhaseWon {
				// победа среди дня: отчёта не будет, фиксируем как есть
				outcome = "victory"
				writeSummary(w, name, seed, g, outcome)
				break
			}
		}
		if outcome != "running" {
			break
		}
		if err := g.NextDay(); err != nil {
			break
		}
		plan, outbreaks, seen = dayPlan(g), 0, nil
	}
	if outcome == "running" {
		outcome = "timeout" // дни кончились, партия жива
		writeSummary(w, name, seed, g, outcome)
	}
	return outcome
}

func dayOutcome(g *game.Game, r *game.DayReport) string {
	switch {
	case g.Phase == game.PhaseGameOver:
		return string(g.LoseReason) // bankrupt | time_up | deadlock
	default:
		return "running"
	}
}

func writeRow(w *csv.Writer, name string, seed int, r *game.DayReport, outcome string) {
	events := strconv.Itoa(len(r.Events))
	if eventsText {
		events = strings.Join(r.Events, " | ")
	}
	_ = w.Write([]string{name, strconv.Itoa(seed), strconv.Itoa(r.Day),
		strconv.Itoa(r.Balance), strconv.Itoa(r.Income),
		strconv.Itoa(r.Payroll + r.GatewayOpex), events, outcome})
}

// writeSummary — финал среди дня (победа/таймаут дней): отчёта дня нет,
// пишем текущее состояние.
func writeSummary(w *csv.Writer, name string, seed int, g *game.Game, outcome string) {
	_ = w.Write([]string{name, strconv.Itoa(seed), strconv.Itoa(g.Day),
		strconv.Itoa(g.Money), strconv.Itoa(g.DayIncome),
		strconv.Itoa(g.PayrollPerDay()), "0", outcome})
}

// parseSeeds — "5", "1..50".
func parseSeeds(s string) ([]int, error) {
	if lo, hi, ok := strings.Cut(s, ".."); ok {
		a, err1 := strconv.Atoi(lo)
		b, err2 := strconv.Atoi(hi)
		if err1 != nil || err2 != nil || a < 1 || b < a || b-a > 10_000 {
			return nil, fmt.Errorf("диапазон %q не понят (N..M, до 10000 сидов)", s)
		}
		seeds := make([]int, 0, b-a+1)
		for i := a; i <= b; i++ {
			seeds = append(seeds, i)
		}
		return seeds, nil
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < 1 {
		return nil, fmt.Errorf("сид %q не понят", s)
	}
	return []int{v}, nil
}

func joinCounts(m map[string]int) string {
	parts := make([]string, 0, len(m))
	for k, v := range m {
		parts = append(parts, fmt.Sprintf("%s=%d", k, v))
	}
	// стабильный порядок
	sortStrings(parts)
	return strings.Join(parts, " ")
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
