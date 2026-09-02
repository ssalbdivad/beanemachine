import { num, parseCsv } from "../data/csv.ts"
import type { PlayerSeason } from "../data/statsapi.ts"
import { aggregateStatcast } from "../data/statcast-window.ts"
import { cachedFetch } from "./cache.ts"
import { addDays, seasonRange } from "./seasons.ts"

/**
 * Is xwOBA predictive at all? — `nub run xwoba`
 *
 * A separate question from "does an xwOBA multiplier improve a roster decision",
 * and the two have different answers. This asks the direct one: standing at the
 * start of a week, which of a hitter's prior numbers best ranks what he is about
 * to do — his actual wOBA, his expected wOBA, or a blend? Spearman throughout,
 * because a recommendation is an ordering.
 */
const SAPI = "https://statsapi.mlb.com/api/v1"
const SAVANT = "https://baseballsavant.mlb.com/leaderboard/custom"

const spearman = (pairs: [number, number][]): number => {
	if (pairs.length < 3) return NaN
	const rank = (vals: number[]) => {
		const idx = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
		const r = new Array<number>(vals.length)
		for (let i = 0; i < idx.length; ) {
			let j = i
			while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++
			const avg = (i + j) / 2 + 1
			for (let k = i; k <= j; k++) r[idx[k]![1]] = avg
			i = j + 1
		}
		return r
	}
	const rx = rank(pairs.map(p => p[0])), ry = rank(pairs.map(p => p[1]))
	const n = pairs.length
	const mx = rx.reduce((a, c) => a + c, 0) / n, my = ry.reduce((a, c) => a + c, 0) / n
	let sxy = 0, sxx = 0, syy = 0
	for (let i = 0; i < n; i++) {
		const a = rx[i]! - mx, b = ry[i]! - my
		sxy += a * b; sxx += a * a; syy += b * b
	}
	return sxy / Math.sqrt(sxx * syy)
}

const lines = async (season: number, start: string, end: string): Promise<PlayerSeason[]> => {
	const text = await cachedFetch(
		`${SAPI}/stats?stats=byDateRange&group=hitting&season=${season}&sportId=1` +
			`&playerPool=All&limit=3000&startDate=${start}&endDate=${end}`
	)
	return (JSON.parse(text).stats?.[0]?.splits ?? []).map((s: any) => {
		const stat: Record<string, number> = {}
		for (const [k, v] of Object.entries(s.stat ?? {})) {
			const n = Number(v)
			if (Number.isFinite(n)) stat[k] = n
		}
		return { id: s.player?.id, name: s.player?.fullName ?? "", team: null, teamId: null,
			position: s.position?.abbreviation ?? "", group: "hitting" as const, stats: stat }
	})
}

/**
 * Point-in-time contact numbers, aggregated a day at a time from pitch-level data.
 *
 * The leaderboard route below is kept only to reproduce the broken measurement:
 * it ignores its own date parameters, so it answers every window with the whole
 * season. `--real` is the one that tells the truth.
 */
const REAL = process.argv.includes("--real")

const savantReal = async (season: number, start: string, end: string) => {
	const lines = await aggregateStatcast(season, "batter", start, end, url =>
		cachedFetch(url, "text/csv")
	)
	return new Map([...lines].map(([id, l]) => [id, { pa: l.pa, woba: l.woba, xwoba: l.xwoba }]))
}

const savantLeaderboard = async (season: number, start: string, end: string) => {
	const url =
		`${SAVANT}?year=${season}&type=batter&filter=&min=1` +
		`&selections=pa%2Cwoba%2Cxwoba&chart=false&x=pa&y=pa&r=no&chartType=beeswarm` +
		`&start_dt=${start}&end_dt=${end}&csv=true`
	const out = new Map<number, { pa: number; woba: number; xwoba: number }>()
	for (const row of parseCsv(await cachedFetch(url, "text/csv"))) {
		const id = num(row.player_id), pa = num(row.pa), w = num(row.woba), x = num(row.xwoba)
		if (id !== null && pa !== null && w !== null && x !== null) out.set(id, { pa, woba: w, xwoba: x })
	}
	return out
}

const savant = (season: number, start: string, end: string) =>
	REAL ? savantReal(season, start, end) : savantLeaderboard(season, start, end)

/** Linear weights, same formula the matchup module uses. */
const wobaish = (s: Record<string, number>): number | null => {
	const pa = s.plateAppearances ?? 0
	if (pa <= 0) return null
	const hr = s.homeRuns ?? 0, tr = s.triples ?? 0, db = s.doubles ?? 0
	const singles = (s.hits ?? 0) - db - tr - hr
	return (0.69 * (s.baseOnBalls ?? 0) + 0.72 * (s.hitByPitch ?? 0) +
		0.89 * singles + 1.27 * db + 1.62 * tr + 2.1 * hr) / pa
}

const MIN_PRIOR = Number(process.argv.find(a => a.startsWith("--min="))?.slice(6) ?? 150)
const FUTURE_DAYS = Number(process.argv.find(a => a.startsWith("--future="))?.slice(9) ?? 7)
const MIN_FUTURE = Math.max(10, Math.round(FUTURE_DAYS * 2.2))
/**
 * Season-to-date gaps are small and stable; a gap over the last three weeks is
 * large and is what "he's been unlucky lately, buy low" actually refers to. They
 * are different quantities and deserve separate tests.
 */
const PRIOR_DAYS = Number(process.argv.find(a => a.startsWith("--prior-days="))?.slice(13) ?? 0)
const seasons = (process.argv.find(a => a.startsWith("--seasons="))?.slice(10) ?? "2023,2024,2025")
	.split(",").map(Number)

const buckets: Record<string, [number, number][]> = {
	woba: [], xwoba: [], "blend .5": [], "blend .3": [], "blend .7": []
}
let weeks = 0

for (const season of seasons) {
	const range = await seasonRange(season)
	let cursor = addDays(range.start, 28)
	while (Date.parse(addDays(cursor, FUTURE_DAYS)) <= Date.parse(range.end)) {
		const priorEnd = addDays(cursor, -1)
		const [prior, future] = await Promise.all([
			savant(season, PRIOR_DAYS > 0 ? addDays(priorEnd, -PRIOR_DAYS) : range.start, priorEnd),
			lines(season, cursor, addDays(cursor, FUTURE_DAYS - 1))
		])
		const per: Record<string, [number, number][]> = {
			woba: [], xwoba: [], "blend .5": [], "blend .3": [], "blend .7": []
		}
		for (const f of future) {
			if ((f.stats.plateAppearances ?? 0) < MIN_FUTURE) continue
			const p = prior.get(f.id)
			if (!p || p.pa < MIN_PRIOR) continue
			const actual = wobaish(f.stats)
			if (actual === null) continue
			per.woba!.push([p.woba, actual])
			per.xwoba!.push([p.xwoba, actual])
			for (const w of [0.3, 0.5, 0.7])
				per[`blend .${String(w).slice(2)}`]!.push([p.woba + w * (p.xwoba - p.woba), actual])
		}
		if ((per.woba?.length ?? 0) >= 40) {
			weeks++
			for (const k of Object.keys(buckets)) buckets[k]!.push(...per[k]!)
		}
		cursor = addDays(cursor, FUTURE_DAYS)
	}
}

console.log(
	`Predicting the NEXT ${FUTURE_DAYS} DAYS of production from prior-season contact numbers\n` +
		`${seasons.join(", ")} · ${weeks} weeks · ${buckets.woba!.length} player-weeks · ` +
		`prior ${PRIOR_DAYS > 0 ? `last ${PRIOR_DAYS}d` : "season to date"} · ` +
		`${REAL ? "POINT-IN-TIME pitch data" : "LEAKED leaderboard (dates ignored)"} · ` +
		`min ${MIN_PRIOR} prior PA, ${MIN_FUTURE} future PA\n`
)
/**
 * The question a head-to-head cannot answer.
 *
 * wOBA and xwOBA share most of their signal, so racing them just measures the
 * shared part twice. What matters for a recommendation is whether the GAP
 * (xwOBA − wOBA) tells you anything wOBA did not — that is the whole regression
 * story: of two hitters with the same results, does the one whose contact was
 * better outperform from here? Spearman partial correlation answers it directly.
 */
const partial = (): { rho: number; gf: number; gw: number; wf: number } => {
	const pairs = buckets.woba!
	const gap = buckets.xwoba!.map((x, i) => x[0] - pairs[i]![0])
	const fut = pairs.map(p => p[1])
	const wob = pairs.map(p => p[0])
	const gf = spearman(gap.map((g, i) => [g, fut[i]!]))
	const gw = spearman(gap.map((g, i) => [g, wob[i]!]))
	const wf = spearman(wob.map((w, i) => [w, fut[i]!]))
	return { rho: (gf - gw * wf) / Math.sqrt((1 - gw * gw) * (1 - wf * wf)), gf, gw, wf }
}

const scored = Object.entries(buckets)
	.map(([k, v]) => [k, spearman(v)] as const)
	.sort((a, b) => b[1] - a[1])
for (const [name, rho] of scored)
	console.log(`  ${name.padEnd(10)} rho ${rho.toFixed(4)}${name === scored[0]![0] ? "  ← best" : ""}`)

const pc = partial()
const n = buckets.woba!.length
// Fisher z on the partial, 2 controls
const se = 1 / Math.sqrt(n - 3 - 1)
const z = 0.5 * Math.log((1 + pc.rho) / (1 - pc.rho)) / se
console.log(
	`\n  INCREMENTAL: does the xwOBA gap add anything to wOBA?\n` +
		`    partial rho ${pc.rho >= 0 ? "+" : ""}${pc.rho.toFixed(4)}  (z ${z.toFixed(2)}, n ${n})\n` +
		`    raw: gap~future ${pc.gf.toFixed(4)} · gap~wOBA ${pc.gw.toFixed(4)} · wOBA~future ${pc.wf.toFixed(4)}`
)
