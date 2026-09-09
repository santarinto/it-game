// sim — headless-симулятор ядра игры (ITGAME-27): прогоны баланса без
// браузера и рук. Ядро живёт в internal/game, Phaser не нужен.
//
//	go run ./cmd/sim --diff hard --seed 1..50 --days 30 --policy greedy --out runs.csv
//
// CSV: policy,seed,day,money,income,payroll,events,outcome — по строке на
// закрытый день; outcome — running в промежуточных строках и финал
// (bankrupt | victory | time_up) в последней. Один прогон закрывает
// вопросы «проходим ли ХАРДКОР» и «как часто аудит убивает до 5-го дня».
package main

import (
	"encoding/csv"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"

	"itdirector/internal/game"
)

type policyFunc func(g *game.Game, rng *rand.Rand, hour int)

func main() {
	diff := flag.String("diff", "normal", "easy | normal | hard | hardcore")
	seedRange := flag.String("seed", "1..20", "сиды: N, N..M, N..M шагом 1")
	days := flag.Int("days", 30, "сколько дней на партию")
	policyFlag := flag.String("policy", "all", "greedy | idle | random | all")
	out := flag.String("out", "", "путь CSV (пусто — stdout)")
	flag.Parse()

	seeds, err := parseSeeds(*seedRange)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sim: %v\n", err)
		os.Exit(1)
	}
	policies := map[string]policyFunc{"greedy": greedyPolicy, "idle": idlePolicy, "random": randomPolicy}
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
	outcomes := map[string]int{}
	for _, name := range wanted {
		policy := policies[name]
		for _, seed := range seeds {
			outcome := runOne(w, cfg, name, policy, seed, *days)
			outcomes[name+"/"+outcome]++
		}
	}
	w.Flush()
	fmt.Fprintf(os.Stderr, "sim: %s, сидов %d, дней %d — исходы: %s\n",
		*diff, len(seeds)*len(wanted), *days, joinCounts(outcomes))
}

// runOne — одна партия: политика решает каждый час, дни закрываются
// честными тиками ядра. Возвращает финал партии.
func runOne(w *csv.Writer, cfg game.Config, name string, policy policyFunc, seed, days int) string {
	g := game.NewSeeded(cfg, uint64(seed))
	rng := rand.New(rand.NewPCG(uint64(seed), 0xC0FFEE)) // свой поток — политика не расходует игровые роллы
	outcome := "running"
	for g.Day <= days && outcome == "running" {
		// игровой день по тикам; политика думает раз в час
		for g.Phase == game.PhaseRunning {
			if g.TickInDay%cfg.TicksPerHour == 0 {
				policy(g, rng, g.TickInDay/cfg.TicksPerHour)
			}
			report := g.Tick()
			if report != nil {
				outcome = dayOutcome(g, report)
				writeRow(w, name, seed, report, outcome)
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
		return string(g.LoseReason) // bankrupt | time_up
	default:
		return "running"
	}
}

func writeRow(w *csv.Writer, name string, seed int, r *game.DayReport, outcome string) {
	_ = w.Write([]string{name, strconv.Itoa(seed), strconv.Itoa(r.Day),
		strconv.Itoa(r.Balance), strconv.Itoa(r.Income),
		strconv.Itoa(r.Payroll + r.GatewayOpex), strconv.Itoa(len(r.Events)), outcome})
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
