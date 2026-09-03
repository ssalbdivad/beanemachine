import { readFileSync } from "node:fs"
import { scoreStats } from "../engine/points.ts"
import { leagueRatesFrom, project } from "../engine/project.ts"
import type { League } from "../schema.ts"
import { buildCorpus, RECENT_WINDOWS, type Fold } from "./corpus.ts"
import { spearman, topNValue } from "./harness.ts"

/**
 * Scores a projection variant across the whole corpus.
 *
 * The comparison that matters is against the naive baseline — "he'll keep doing
 * what he's been doing". A model that can't beat that isn't earning its
 * complexity, and saying so is more useful than a number with no reference point.
 */
export interface Variant {
	name: string
	recentDays: number | null
	recentWeight: number
	qualityWeight: number
	shrink: boolean
	recentRateWeight?: number
	/** window used for the rate blend, if different from the volume window */
	rateDays?: number
	/**
	 * Multi-window volume blend: {days: weight}. Weights are normalised, and any
	 * remainder goes to the season-long rate. This is how "weight the most recent
	 * series harder" gets expressed and tested rather than assumed.
	 */
	windowWeights?: Record<number, number>
}

export interface Score {
	name: string
	rho: number
	top20: number
	foldsWon: number
	folds: number
	/** Paired head-to-head against the shipped configuration for this side. */
	beatsShipped: number
	meanDelta: number
}

const MIN_VOLUME = { hitting: 80, pitching: 60 }

export const scoreVariants = (
	folds: Fold[],
	league: League,
	variants: Variant[]
): { byGroup: Record<string, Score[]>; naive: Record<string, Score> } => {
	const byGroup: Record<string, Score[]> = {}
	const naiveOut: Record<string, Score> = {}

	for (const group of ["hitting", "pitching"] as const) {
		const table = group === "hitting" ? league.scoring.batting : league.scoring.pitching
		const vol = (p: any) =>
			group === "hitting" ? (p.stats.plateAppearances ?? 0) : (p.stats.battersFaced ?? 0)
		const perVariantRho: Record<string, number[]> = {}
		const perVariantTop: Record<string, number[]> = {}
		const naiveRho: number[] = []
		const naiveTop: number[] = []

		for (const fold of folds.filter(f => f.group === group)) {
			const actualById = new Map(fold.actual.map(p => [p.id, p]))
			const rates = leagueRatesFrom(fold.prior, group)
			const recentIndex: Record<number, Map<number, any>> = {}
			for (const d of RECENT_WINDOWS)
				recentIndex[d] = new Map((fold.recent[d] ?? []).map(r => [r.id, r]))

			const pairs: Record<string, [number, number][]> = {}
			const naivePairs: [number, number][] = []

			for (const p of fold.prior) {
				if (vol(p) < MIN_VOLUME[group] || p.teamId === null) continue
				if (group === "hitting" ? p.position === "P" : p.position !== "P") continue
				const gAhead = fold.futureGames.get(p.teamId) ?? 0
				const gBehind = fold.priorGames.get(p.teamId) ?? 0
				if (!gAhead || !gBehind) continue

				const truth = actualById.get(p.id)
				const actualPoints = truth ? scoreStats(truth.stats, table, group).points : 0
				const u = fold.underlying.get(p.id)

				naivePairs.push([
					(scoreStats(p.stats, table, group).points / gBehind) * gAhead,
					actualPoints
				])

				for (const v of variants) {
					let recentPerGame: number | null = null
					let effectiveWeight = v.recentWeight
					if (v.windowWeights) {
						// combine several windows into one per-team-game estimate
						let acc = 0, wsum = 0
						for (const [dStr, w] of Object.entries(v.windowWeights)) {
							const d = Number(dStr)
							const rec = recentIndex[d]?.get(p.id)
							const rg = fold.recentGames[d]?.get(p.teamId) ?? 0
							if (rg <= 0) continue
							acc += w * ((rec ? vol(rec) : 0) / rg)
							wsum += w
						}
						if (wsum > 0) {
							recentPerGame = acc / wsum
							effectiveWeight = v.recentWeight
						}
					} else if (v.recentDays !== null) {
						const rec = recentIndex[v.recentDays]?.get(p.id)
						const rg = fold.recentGames[v.recentDays]?.get(p.teamId) ?? 0
						if (rg > 0) recentPerGame = (rec ? vol(rec) : 0) / rg
					}
					const rateRec =
						v.recentRateWeight ?
							recentIndex[v.rateDays ?? v.recentDays ?? 14]?.get(p.id)
						:	null
					const proj = project(p, u, gBehind, gAhead, {
						qualityWeight: v.qualityWeight,
						recentVolumePerGame: recentPerGame,
						recentWeight: effectiveWeight,
						recentStats: rateRec?.stats ?? null,
						recentRateWeight: v.recentRateWeight ?? 0,
						...(v.shrink ? { rates } : {})
					})
					;(pairs[v.name] ??= []).push([
						scoreStats(proj.stats, table, group).points,
						actualPoints
					])
				}
			}

			if (naivePairs.length < 20) continue
			naiveRho.push(spearman(naivePairs))
			naiveTop.push(topNValue(naivePairs, 20))
			for (const v of variants) {
				;(perVariantRho[v.name] ??= []).push(spearman(pairs[v.name]!))
				;(perVariantTop[v.name] ??= []).push(topNValue(pairs[v.name]!, 20))
			}
		}

		const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1)
		naiveOut[group] = {
			name: "naive", rho: mean(naiveRho), top20: mean(naiveTop),
			foldsWon: 0, folds: naiveRho.length, beatsShipped: 0, meanDelta: 0
		}
		// paired comparison: a mean difference of 0.001 across 50 noisy folds is not
		// evidence of anything, so report how often each variant actually wins
		const shippedName = group === "hitting" ? "SHIPPED_hit_d7_w0.75" : "SHIPPED_pit_d21_w0.75"
		const shipped = perVariantRho[shippedName] ?? []
		byGroup[group] = variants
			.map(v => {
				const rhos = perVariantRho[v.name] ?? []
				return {
					name: v.name,
					rho: mean(rhos),
					top20: mean(perVariantTop[v.name] ?? []),
					foldsWon: rhos.filter((r, i) => r > naiveRho[i]!).length,
					folds: rhos.length,
					beatsShipped: rhos.filter((r, i) => r > (shipped[i] ?? Infinity)).length,
					meanDelta: mean(rhos.map((r, i) => r - (shipped[i] ?? r)))
				}
			})
			.sort((a, b) => b.rho - a.rho)
	}
	return { byGroup, naive: naiveOut }
}

if (import.meta.filename === process.argv[1]) {
	const league: League = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
	const horizon = Number(process.argv.find(a => a.startsWith("--horizon="))?.slice(10) ?? 14)
	const from = Number(process.argv.find(a => a.startsWith("--from="))?.slice(7) ?? 2016)
	const to = Number(process.argv.find(a => a.startsWith("--to="))?.slice(5) ?? 2026)
	const perSeason = Number(process.argv.find(a => a.startsWith("--folds="))?.slice(8) ?? 5)

	const seasons = Array.from({ length: to - from + 1 }, (_, i) => from + i)
	console.log(`Building corpus · seasons ${from}–${to} · ${horizon}d horizon · ${perSeason} folds/season`)
	const folds = await buildCorpus(seasons, horizon, perSeason, m => console.log(m))
	console.log(`\n${folds.length} folds built\n`)

	// shipped configuration per side, plus the rate-blend hypothesis
	const variants: Variant[] = [
		{ name: "SHIPPED_hit_d7_w0.75", recentDays: 7, recentWeight: 0.75, qualityWeight: 0, shrink: false },
		{ name: "SHIPPED_pit_d21_w0.75", recentDays: 21, recentWeight: 0.75, qualityWeight: 0, shrink: false }
	]
	for (const d of [7, 14, 21, 30])
		for (const rw of [0.15, 0.3, 0.5])
			for (const rd of [14, 30])
				variants.push({
					name: `d${d}_rate${rw}@${rd}`,
					recentDays: d, recentWeight: 0.75, qualityWeight: 0, shrink: false,
					recentRateWeight: rw, rateDays: rd
				})
	for (const rw of [0.1, 0.15, 0.2, 0.25])
		variants.push({
			name: `d21_rate${rw}@21`, recentDays: 21, recentWeight: 0.75,
			qualityWeight: 0, shrink: false, recentRateWeight: rw, rateDays: 21
		})
	for (const rw of [0.1, 0.15, 0.2])
		variants.push({
			name: `d7_rate${rw}@7`, recentDays: 7, recentWeight: 0.75,
			qualityWeight: 0, shrink: false, recentRateWeight: rw, rateDays: 7
		})
	// SHIPPED configuration, plus the next questions worth asking
	const COMBOS: [string, Record<number, number>][] = [
		["SHIPPED_hit", { 3: 2, 7: 1, 21: 1 }],
		["SHIPPED_pit", { 5: 2, 21: 1 }],
		["hit_3x3", { 3: 3, 7: 1, 21: 1 }],
		["hit_3x2_10_30", { 3: 2, 10: 1, 30: 1 }],
		["hit_3_5_7_21", { 3: 2, 5: 1, 7: 1, 21: 1 }],
		["pit_5x2_14_30", { 5: 2, 14: 1, 30: 1 }],
		["pit_5x3_21", { 5: 3, 21: 1 }],
		["pit_7x2_21", { 7: 2, 21: 1 }],
		["s3+w14", { 3: 1, 14: 1 }],
		["s3x2+w14", { 3: 2, 14: 1 }],
		["s3+w7+w21", { 3: 1, 7: 1, 21: 1 }],
		["s3x2+w7+w21", { 3: 2, 7: 1, 21: 1 }],
		["s5+w14", { 5: 1, 14: 1 }],
		["s5x2+w21", { 5: 2, 21: 1 }],
		["decay_t7", { 3: 0.65, 7: 0.37, 14: 0.14, 21: 0.05, 30: 0.01 }],
		["decay_t14", { 3: 0.81, 7: 0.61, 14: 0.37, 21: 0.22, 30: 0.12 }],
		["decay_t21", { 3: 0.87, 7: 0.72, 14: 0.51, 21: 0.37, 30: 0.24 }],
		["flat_all", { 3: 1, 7: 1, 14: 1, 21: 1, 30: 1 }]
	]
	for (const [cname, ww] of COMBOS)
		for (const w of [0.6, 0.75, 0.9])
			variants.push({
				name: `${cname}_w${w}`, recentDays: null, recentWeight: w,
				qualityWeight: 0, shrink: false, windowWeights: ww
			})

	const { byGroup, naive } = scoreVariants(folds, league, variants)
	for (const group of ["hitting", "pitching"] as const) {
		const n = naive[group]!
		console.log(`${group.toUpperCase()} — ${n.folds} folds`)
		console.log(`  ${"naive baseline".padEnd(22)} ρ ${n.rho.toFixed(4)}   top20 ${n.top20.toFixed(1)}`)
		for (const s of byGroup[group]!.slice(0, 6))
			console.log(
				`  ${s.name.padEnd(22)} ρ ${s.rho.toFixed(4)}  vs naive ${s.foldsWon}/${s.folds}` +
					`  vs SHIPPED ${String(s.beatsShipped).padStart(2)}/${s.folds}` +
					`  Δρ ${(s.meanDelta >= 0 ? "+" : "") + s.meanDelta.toFixed(4)}`
			)
		console.log()
	}
}
