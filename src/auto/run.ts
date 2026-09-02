import { readFileSync } from "node:fs"
import { hydrate, type Snapshot } from "../data/snapshot.ts"
import { fetchAvailable, normalizeName } from "../data/yahoo-pool.ts"
import { rateAll, withUndervaluation } from "../engine/bscore.ts"
import type { League } from "../schema.ts"
import { DEFAULTS, planMoves } from "./plan.ts"
import { readRoster } from "./roster.ts"
import { hasSession, login, openSession } from "./session.ts"

/**
 * Autonomous mode: let Billy look after the team.
 *
 * SAFETY, because this reasons about real and hard-to-reverse actions on a real
 * account — a dropped player can be claimed by someone else within seconds:
 *   · dry run is the DEFAULT and changes nothing;
 *   · at most `--max-moves` per run (default 1);
 *   · nobody at or above `--keep-floor` is ever proposed for a drop;
 *   · a swap needs to clear `--min-gain` projected points to be worth making;
 *   · every proposal is printed with the numbers behind it.
 *
 * Credentials are never handled by this code. You log into Yahoo by hand once and
 * Playwright reuses the resulting cookies from a gitignored file.
 */
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1]
const flag = (name: string) => process.argv.includes(`--${name}`)

if (flag("login")) {
	await login()
	process.exit(0)
}

const league: League = JSON.parse(readFileSync("scoring.json", "utf8")).leagues[
	arg("league") ?? "yahoo:228947"
]
const leagueId = league.meta.league_id!
const teamId = arg("team") ?? league.meta.team_id ?? "1"
const options = {
	minGain: Number(arg("min-gain") ?? DEFAULTS.minGain),
	keepFloor: Number(arg("keep-floor") ?? DEFAULTS.keepFloor),
	maxMoves: Number(arg("max-moves") ?? DEFAULTS.maxMoves)
}

console.log(`Billy is looking at ${league.meta.team_name ?? teamId} in ${league.meta.league_name}`)
console.log(
	`mode: dry run (nothing is changed) · min gain ${options.minGain} · ` +
		`keep floor ${options.keepFloor} · max ${options.maxMoves} move(s)\n`
)

const snapshot: Snapshot = JSON.parse(readFileSync("data/snapshot.json", "utf8"))
const h = hydrate(snapshot)
const rated = withUndervaluation(
	rateAll({
		league,
		players: h.players,
		underlying: h.underlying,
		injuries: h.injuries,
		teamGamesPlayed: h.teamGamesPlayed,
		gamesByTeam: h.gamesByTeam,
		recentVolumeByWindow: h.recentVolumeByWindow,
		recentStats: h.recentStats,
		teams: league.meta.max_teams!
	})
)

const pool = await fetchAvailable(leagueId)
const availableNames = new Set(pool.players.map(p => normalizeName(p.name)))
console.log(`free agents readable: ${pool.players.length}`)

if (!hasSession()) {
	console.log("\nNo saved Yahoo session. Run with --login to sign in once by hand.")
	console.log("Until then Billy can rank players but can't see your roster.")
	process.exit(1)
}

const context = await openSession(!flag("headed"))
const roster = await readRoster(context, leagueId, teamId)
await context.close()
console.log(`roster read: ${roster.length} spots`)

const { moves, skipped } = planMoves(roster, rated, availableNames, options)
for (const s of skipped) console.log(`  skipped: ${s}`)

if (!moves.length) {
	console.log("\nNo move clears the bar. Billy is standing pat.")
	process.exit(0)
}

console.log(`\nBILLY WOULD MAKE ${moves.length} MOVE${moves.length > 1 ? "S" : ""}:`)
for (const m of moves) {
	console.log(`  ADD  ${m.add}   (bscore ${m.addScore})`)
	console.log(`  DROP ${m.drop}  (bscore ${m.dropScore})`)
	console.log(`  net  +${m.gain} projected points`)
	console.log(`  why  ${m.reason}\n`)
}
console.log("This is a dry run — nothing was changed on your team.")
