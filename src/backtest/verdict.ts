import { readFileSync, readdirSync } from "node:fs"

/**
 * Pools every measurement in data/results/ into one verdict: `nub run verdict`
 *
 * A single season is 23 paired weeks, which settles nothing. The decisions in this
 * project are made on paired weekly counts across as many seasons as have been run,
 * and those runs arrive weeks apart — so the pooling has to be mechanical rather
 * than something reassembled by hand from old terminal output.
 *
 * Runs are matched on their configuration. Pooling a leaked-Statcast run with a
 * point-in-time one would silently average a void measurement into a live one.
 */
interface Result {
	ranAt: string
	seasons: number[]
	movesPerWeek: number
	weeks: number
	statcast: string
	totals: Record<string, number>
	byWeek: Record<string, number[]>
}

const config = process.argv.find(a => a.startsWith("--statcast="))?.slice(11)
const control = process.argv.find(a => a.startsWith("--control="))?.slice(10) ?? "qw0.00"

const files = readdirSync("data/results").filter(f => f.endsWith(".json"))
const runs: Result[] = files.map(f => JSON.parse(readFileSync(`data/results/${f}`, "utf8")))
const kept = runs.filter(r => !config || r.statcast === config)

if (!kept.length) {
	console.log("No runs in data/results matching that configuration.")
	process.exit(0)
}

/**
 * Runs are grouped by WHICH KNOB THEY SWEPT before anything is added up.
 *
 * Two sweeps over the same five seasons are not two halves of one measurement —
 * they are two separate experiments that happen to share opponents. Summing them
 * counted hot-hand and season-to-date twice and reported 222 weeks of a 111-week
 * season, which made every baseline look twice as good as it is. Totals are only
 * additive across DISJOINT seasons within a single sweep.
 */
const signature = (r: Result) => Object.keys(r.totals).sort().join("|")
const groups = new Map<string, Result[]>()
for (const r of [...kept].sort((a, b) => a.ranAt.localeCompare(b.ranAt)))
	groups.set(signature(r), [...(groups.get(signature(r)) ?? []), r])

const wanted = process.argv.find(a => a.startsWith("--sweep="))?.slice(8)
const chosen =
	[...groups.entries()].find(([sig]) => (wanted ? sig.includes(wanted) : false)) ??
	// default to the sweep with the most seasons behind it, which is the one most
	// worth believing
	[...groups.entries()].sort(
		(a, b) =>
			new Set(b[1].flatMap(r => r.seasons)).size - new Set(a[1].flatMap(r => r.seasons)).size
	)[0]

if (!chosen) {
	console.log("No runs to pool.")
	process.exit(0)
}

const [, sweepRuns] = chosen
// within one sweep, a season run twice is one season; the later run wins
const bySeason = new Map<string, Result>()
for (const r of sweepRuns) bySeason.set(`${r.seasons.join(",")}:${r.movesPerWeek}`, r)
const pooled = [...bySeason.values()]

const totals = new Map<string, number>()
const weekly = new Map<string, number[]>()
let weeks = 0
for (const r of pooled) {
	weeks += r.weeks
	for (const [k, v] of Object.entries(r.totals)) totals.set(k, (totals.get(k) ?? 0) + v)
	for (const [k, v] of Object.entries(r.byWeek)) weekly.set(k, [...(weekly.get(k) ?? []), ...v])
}

const seasons = [...new Set(pooled.flatMap(r => r.seasons))].sort()
console.log(
	`Pooled verdict — ${pooled.length} runs · seasons ${seasons.join(", ")} · ${weeks} weeks` +
		`${config ? ` · statcast ${config}` : ""}\n` +
		`strategies: ${[...totals.keys()].join(", ")}\n` +
		(groups.size > 1 ?
			`(${groups.size} distinct sweeps on disk; showing the one with the most seasons. ` +
				`--sweep=<strategy name> picks another.)\n`
		:	"") +
		"\n"
)
for (const [name, total] of [...totals].sort((a, b) => b[1] - a[1]))
	console.log(`  ${name.padEnd(18)} ${total.toFixed(0).padStart(8)} pts`)

const base = weekly.get(control)
if (!base) {
	console.log(`\n(no control "${control}" in these runs — pass --control=<name>)`)
	process.exit(0)
}

/**
 * A normal approximation to the sign test. Ties carry no information about which
 * strategy is better, so they are excluded from the count rather than split — a
 * config that changes no roster is not evidence, and counting its ties as halves
 * would manufacture some.
 */
console.log(`\nPAIRED vs ${control} — ${base.length} weeks, ties excluded`)
const rows = [...weekly]
	.filter(([n]) => n !== control)
	.map(([name, mine]) => {
		let w = 0, l = 0, t = 0, sum = 0
		for (let i = 0; i < mine.length; i++) {
			const d = mine[i]! - (base[i] ?? 0)
			sum += d
			if (d > 0) w++
			else if (d < 0) l++
			else t++
		}
		const n = w + l
		const z = n > 0 ? (w - n / 2) / Math.sqrt(n / 4) : 0
		return { name, w, l, t, mean: sum / Math.max(mine.length, 1), z, n }
	})
	.sort((a, b) => b.mean - a.mean)

for (const r of rows)
	console.log(
		`  ${r.name.padEnd(14)} ${String(r.w).padStart(3)}W ${String(r.l).padStart(3)}L ` +
			`${String(r.t).padStart(3)}T  ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(1)}/wk  ` +
			`z ${r.z >= 0 ? "+" : ""}${r.z.toFixed(2)}` +
			`${Math.abs(r.z) > 1.96 ? "  ← significant" : r.n < 60 ? "  (thin)" : ""}`
	)
