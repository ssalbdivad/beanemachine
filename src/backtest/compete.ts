import { readFileSync } from "node:fs"
import type { League } from "../schema.ts"
import { playSeason, STRATEGIES, SWEEP } from "./season.ts"

/**
 * Season-long head-to-head: `nub run compete`
 *
 * Each strategy drafts from the same pool, sets a legal roster every week, makes
 * waiver moves on what it believes at the time, and is scored on what its players
 * actually produced. Rosters may overlap — every strategy sees the same players, so
 * what is being compared is judgement, not draft position.
 *
 * The opponents are the two strategies real managers actually run: "he'll keep doing
 * what he's been doing" (season-to-date rate) and chasing the hot hand off the last
 * fortnight. Beating those is what it means to be useful to a human.
 */
const league: League = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const seasons = (process.argv.find(a => a.startsWith("--seasons="))?.slice(10) ?? "2025")
	.split(",")
	.map(Number)
const movesPerWeek = Number(process.argv.find(a => a.startsWith("--moves="))?.slice(8) ?? 2)

console.log(`Season competition · ${league.meta.league_name} scoring · ${movesPerWeek} waiver moves/week\n`)

const grand = new Map<string, number>()
const weekly = new Map<string, number[]>()
let grandOracle = 0
let grandWeeks = 0

for (const season of seasons) {
	const strategies = process.argv.includes("--sweep") ? SWEEP : STRATEGIES
	const { results, oracle, weeks } = await playSeason(season, league, strategies, {
		movesPerWeek,
		warmupDays: 28,
		swapMargin: Number(process.argv.find(a => a.startsWith("--margin="))?.slice(9) ?? 0)
	})
	const best = Math.max(...results.map(r => r.total))
	console.log(`${season} — ${weeks.length} weeks`)
	for (const r of [...results].sort((a, b) => b.total - a.total)) {
		grand.set(r.strategy, (grand.get(r.strategy) ?? 0) + r.total)
		weekly.set(r.strategy, [...(weekly.get(r.strategy) ?? []), ...r.byWeek])
		const share = ((r.total / oracle) * 100).toFixed(1)
		const gap = r.total === best ? "" : ` (${(r.total - best).toFixed(1)})`
		console.log(
			`  ${r.strategy === best.toString() ? "" : ""}${r.strategy.padEnd(16)} ` +
				`${r.total.toFixed(0).padStart(7)} pts  ${share.padStart(5)}% of perfect  ` +
				`${String(r.moves).padStart(3)} moves${gap}`
		)
	}
	console.log(`  ${"perfect hindsight".padEnd(16)} ${oracle.toFixed(0).padStart(7)} pts  (ceiling)\n`)
	grandOracle += oracle
	grandWeeks += weeks.length
}

if (seasons.length > 1) {
	console.log(`ALL SEASONS — ${grandWeeks} weeks`)
	const ranked = [...grand.entries()].sort((a, b) => b[1] - a[1])
	const winner = ranked[0]![1]
	for (const [name, total] of ranked)
		console.log(
			`  ${name.padEnd(16)} ${total.toFixed(0).padStart(8)} pts  ` +
				`${((total / grandOracle) * 100).toFixed(1).padStart(5)}% of perfect  ` +
				`${total === winner ? "← winner" : `(${(total - winner).toFixed(0)})`}`
		)
	console.log(`  ${"perfect hindsight".padEnd(16)} ${grandOracle.toFixed(0).padStart(8)} pts`)
}

/**
 * Season totals are three samples; weeks are sixty-eight. A model that wins on
 * aggregate but loses most individual weeks has won a coin toss, so the paired
 * week-by-week count is the number that decides anything.
 */
const BASELINES = ["season-to-date", "hot-hand"]
const contenders = [...weekly.keys()].filter(k => !BASELINES.includes(k))
console.log(`\nPAIRED WEEKLY HEAD-TO-HEAD (${weekly.get(contenders[0]!)?.length ?? 0} weeks)`)
for (const name of contenders) {
	const mine = weekly.get(name) ?? []
	const line = BASELINES.map(b => {
		const theirs = weekly.get(b) ?? []
		const wins = mine.filter((v, i) => v > (theirs[i] ?? Infinity)).length
		const mean = mine.reduce((a, c, i) => a + (c - (theirs[i] ?? 0)), 0) / Math.max(mine.length, 1)
		return `vs ${b} ${String(wins).padStart(2)}/${mine.length} (${mean >= 0 ? "+" : ""}${mean.toFixed(1)}/wk)`
	}).join("   ")
	console.log(`  ${name.padEnd(17)} ${line}`)
}
