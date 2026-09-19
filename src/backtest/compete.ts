import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { League } from "../schema.ts"
import { COMBO_SWEEP, DEPTH_SWEEP, HEADLINE_SWEEP, MATCHUP_RETUNE, QUALITY_RETUNE, RETUNE_SWEEP, JOINT_SWEEP, ORACLE_SWEEP, RATE_SWEEP, RECENCY_SWEEP, SHRINK_SWEEP, MARGIN_SWEEP, VOLUME_SWEEP, MATCHUP_SWEEP, MIRAGE_SWEEP, playSeason, QUALITY_SWEEP, RELIEF_SWEEP, STRATEGIES, SWEEP } from "./season.ts"

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
	const strategies =
		process.argv.includes("--quality-retune") ? QUALITY_RETUNE
		: process.argv.includes("--retune") ? RETUNE_SWEEP
		: process.argv.includes("--matchup-retune") ? MATCHUP_RETUNE
		: process.argv.includes("--headline") ? HEADLINE_SWEEP
		: process.argv.includes("--combo") ? COMBO_SWEEP
		: process.argv.includes("--joint") ? JOINT_SWEEP
		: process.argv.includes("--shrink") ? SHRINK_SWEEP
		: process.argv.includes("--recency") ? RECENCY_SWEEP
		: process.argv.includes("--rate") ? RATE_SWEEP
		: process.argv.includes("--oracle-split") ? ORACLE_SWEEP
		: process.argv.includes("--depth") ? DEPTH_SWEEP
		: process.argv.includes("--volume") ? VOLUME_SWEEP
		: process.argv.includes("--quality") ? QUALITY_SWEEP
		: process.argv.includes("--matchup") ? MATCHUP_SWEEP
		: process.argv.includes("--relief") ? RELIEF_SWEEP
		: process.argv.includes("--mirage") ? MIRAGE_SWEEP
		: process.argv.includes("--margin-sweep") ? MARGIN_SWEEP
		: process.argv.includes("--sweep") ? SWEEP
		: STRATEGIES
	const { results, oracle, weeks } = await playSeason(season, league, strategies, {
		movesPerWeek,
		warmupDays: 28,
		/* Carry the league's own bench and choose a lineup from it every week. Off by
		   default: every stored run was measured without one. */
		bench: process.argv.includes("--bench"),
		/* Pick the lineup by raw projected points rather than by value over replacement —
		   see `lineupBy`. The two decisions want different numbers. */
		lineupBy: process.argv.includes("--lineup-points") ? "points" : "vorp",
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
			`  ${r.strategy.padEnd(16)} ` +
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
 * Season totals are a handful of samples; weeks are over a hundred. A model that wins on
 * aggregate but loses most individual weeks has won a coin toss, so the paired
 * week-by-week count is the number that decides anything.
 */
const ALL_BASELINES = ["season-to-date", "hot-hand", "hot-hand+vorp", "thoughtful-human", "draft-and-hold"]
// Only report baselines this run actually played. A missing opponent scores zero
// every week, which reads as a 700-point-per-week rout rather than as absence.
const BASELINES = ALL_BASELINES.filter(b => (weekly.get(b)?.length ?? 0) > 0)

/**
 * Comparing two variants by how each does against a THIRD strategy is the wrong
 * test — it can call a change good because it lost fewer weeks to a manager it
 * already beats 73% of the time. `--control=<name>` pairs every variant directly
 * against one of its own kind, week by week, which is the question actually being
 * asked: does this knob make the model better than the model without it?
 */
const control = process.argv.find(a => a.startsWith("--control="))?.slice(10)
if (control && weekly.has(control)) {
	const base = weekly.get(control)!
	console.log(`\nDIRECT vs ${control} (${base.length} weeks)`)
	for (const [name, mine] of weekly) {
		if (name === control || BASELINES.includes(name)) continue
		const wins = mine.filter((v, i) => v > (base[i] ?? Infinity)).length
		const ties = mine.filter((v, i) => v === base[i]).length
		const mean = mine.reduce((a, c, i) => a + (c - (base[i] ?? 0)), 0) / Math.max(mine.length, 1)
		console.log(
			`  ${name.padEnd(12)} ${String(wins).padStart(3)}W ` +
				`${String(mine.length - wins - ties).padStart(3)}L ${String(ties).padStart(3)}T  ` +
				`(${mean >= 0 ? "+" : ""}${mean.toFixed(1)}/wk)`
		)
	}
}
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

/**
 * Every run is written to data/results/ as machine-readable JSON.
 *
 * Measurements here cost real time — a season with point-in-time Statcast is about
 * half an hour of pitch-level fetching — and the conclusions they support get
 * revised as more seasons land. Keeping only the console output means the evidence
 * for a shipped weight lives in a terminal scrollback that no longer exists. These
 * files are the audit trail: `nub run verdict` pools them.
 */
/*
   A RUN THAT SAW THE FUTURE IS NOT A RESULT, AND MUST NOT BE FILED AS ONE.

   The diagnostics in `ORACLE_SWEEP` are handed the week they are deciding. That is the
   whole point of them — they exist to split the gap to the ceiling into the half that is
   volume and the half that is rate — and it also makes their numbers meaningless as a
   claim about any model a person could run.

   `verdict.ts` pools everything in data/results by configuration, so one such file
   sitting in that directory would eventually be averaged into a live measurement, which
   is exactly how this project lost a whole Statcast result set once already. So the
   writer refuses them, by name, unless the run says out loud that it is a diagnostic —
   and even then it writes with a `diagnostic-` prefix and stamps the field, so nothing
   pools it by accident.
*/
const cheated = [...grand.keys()].filter(n =>
	["volume-oracle", "rate-oracle", "both-oracle"].includes(n)
)
if (cheated.length) {
	console.log(
		`\n  ⚠ ${cheated.join(", ")} ${cheated.length === 1 ? "was" : "were"} handed the week ` +
			`${cheated.length === 1 ? "it" : "they"} decided. These are DIAGNOSTICS, not results:\n` +
			`    they bound what perfect knowledge of one half is worth, and nothing else.`
	)
	if (!process.argv.includes("--diagnostic")) {
		console.log(
			`  Nothing was written. Re-run with --diagnostic to file it as one.\n`
		)
		process.exit(0)
	}
}

const stamp = process.env.RESULT_STAMP ?? new Date().toISOString().replace(/[:.]/g, "-")
const label =
	seasons.join("-") +
	(process.argv.includes("--bench") ? "-bench" : "") +
	(process.argv.includes("--lineup-points") ? "-lineuppts" : "")
mkdirSync("data/results", { recursive: true })
const path = `data/results/${cheated.length ? "diagnostic-" : ""}${stamp}_${label}_moves${movesPerWeek}.json`
writeFileSync(
	path,
	JSON.stringify(
		{
			ranAt: new Date().toISOString(),
			seasons,
			movesPerWeek,
			weeks: grandWeeks,
			// exactly what produced these numbers, so a stale result is identifiable
			statcast: process.argv.includes("--statcast-real") ? "point-in-time" : "none",
			/* Present and true only on a run that saw the future. `verdict.ts` and
			   `paired.ts` both key on configuration, and this is part of it. */
			...(cheated.length ? { diagnostic: cheated } : {}),
			/* PART OF THE CONFIGURATION, not a detail. A run with the league's bench is
			   playing a different game from one without — seventeen lineup decisions a week
			   against two waiver swaps — so the two must never be pooled, and `verdict.ts`
			   keys its grouping on this. */
			bench: process.argv.includes("--bench"),
			argv: process.argv.slice(2),
			oracle: Number(grandOracle.toFixed(1)),
			totals: Object.fromEntries([...grand].map(([k, v]) => [k, Number(v.toFixed(1))])),
			byWeek: Object.fromEntries([...weekly].map(([k, v]) => [k, v]))
		},
		null,
		"\t"
	)
)
console.log(`\nwritten to ${path}`)
