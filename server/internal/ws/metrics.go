package ws

import (
	"itdirector/internal/game"
	"itdirector/internal/metrics"
)

// knownCommands — команды протокола для метки cmd в itgame_commands_total
// (ITGAME-189): Cmd* игры и команды сессии. Имя от клиента в метку идёт только
// отсюда — иначе мусорные type раздували бы ряды (вне фазы running Apply
// отвечает wrong_phase раньше, чем узнаёт команду). Сверку с исходниками
// держит TestKnownCommandsCoverProtocol.
var knownCommands = map[game.Command]bool{
	game.CmdBuyPC: true, game.CmdHire: true, game.CmdBuyRouter: true, game.CmdBuyServer: true,
	game.CmdUpgradeServer: true, game.CmdUpgradeCore: true, game.CmdHireBoss: true,
	game.CmdBuyOffice: true, game.CmdBuyGateway: true, game.CmdNextDay: true, game.CmdRestart: true,
	game.CmdBuyCooler: true, game.CmdBuyFridge: true, game.CmdBuyCoffee: true, game.CmdMotivate: true,
	game.CmdRepairClick: true, game.CmdCallMaster: true, game.CmdEventChoice: true, game.CmdFire: true,
	game.CmdVirusClick: true, game.CmdSetAntivirus: true, game.CmdHireAdmin: true,
	game.CmdFireAdmin: true, game.CmdBuyAdminDept: true, game.CmdUpgradePC: true, game.CmdReplacePC: true,
	game.CmdUpgradeDirector: true,
	cmdSetSpeed: true, cmdAbandon: true, cmdExit: true,
}

// Ряды с метками — нулями до первого события (см. metrics.Preset).
func init() {
	cmds := []string{"unknown"}
	for c := range knownCommands {
		cmds = append(cmds, string(c))
	}
	metrics.Preset([]string{
		string(game.DiffEasy), string(game.DiffNormal), string(game.DiffHard), string(game.DiffHardcore),
	}, cmds)
	for _, k := range clientKinds {
		metrics.WSConnects.WithLabelValues(string(k))
	}
}

// countCommand — команда игрока в itgame_commands_total.
func countCommand(cmd game.Command, rejected *errorMessage) {
	name, result := "unknown", "ok"
	if knownCommands[cmd] {
		name = string(cmd)
	}
	if rejected != nil {
		result = "rejected"
	}
	metrics.Commands.WithLabelValues(name, result).Inc()
}

// difficultyLabel — сложность партии меткой: конечный набор, мусор — normal.
func difficultyLabel(g *game.Game) string {
	return string(game.ParseDifficulty(string(g.Config().Difficulty)))
}

// partyMetrics — счёт партий актора: старт и финал. Финал засчитывается один
// раз — на переходе в него тиком, командой, офлайн-догоном или debug-промоткой;
// ended — нынешний финал уже в счёте.
type partyMetrics struct{ ended bool }

func (p *partyMetrics) started(g *game.Game) {
	metrics.PartiesStarted.WithLabelValues(difficultyLabel(g)).Inc()
}

// settle — сверка после события актора: партия в финале — засчитать его
// (один раз), снова идёт (restart, debug-откат) — следующий финал новый.
func (p *partyMetrics) settle(g *game.Game) {
	switch g.Phase {
	case game.PhaseGameOver:
		p.finish(g, "bankrupt")
	case game.PhaseWon:
		p.finish(g, "victory")
	default:
		p.ended = false
	}
}

func (p *partyMetrics) finish(g *game.Game, outcome string) {
	if p.ended {
		return
	}
	p.ended = true
	metrics.PartiesFinished.WithLabelValues(outcome, difficultyLabel(g)).Inc()
	metrics.PartyDays.WithLabelValues(outcome).Observe(float64(g.Day))
}
