import { readFileSync } from "node:fs"
import { scoreStats } from "../engine/points.ts"
import { project } from "../engine/project.ts"
import { fetchGamesPlayedWindow, fetchUnderlyingWindow, fetchWindow, spearman, topNValue } from "./harness.ts"
import type { League } from "../schema.ts"

/** Sweeps the volume blend, the recent-window length and the Statcast weight,
 *  fetching each fold once and evaluating every parameter set in memory. */
const league: League = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const SEASON = 2026, OPENING = "2026-03-26"
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10)

const FOLDS = ["2026-05-15", "2026-06-15", "2026-07-15", "2026-08-01"]
const HORIZON = 14
const RECENT_DAYS = [14, 21, 30]
const BLEND = [0, 0.25, 0.5, 0.75, 1]
const QUALITY = [0, 0.5, 1]

for (const group of ["hitting", "pitching"] as const) {
	const minVol = group === "hitting" ? 80 : 60
	const results: Record<string, number[]> = {}
	const tops: Record<string, number[]> = {}

	for (const asOf of FOLDS) {
		const end = addDays(asOf, HORIZON)
		const [prior, priorX, actual, priorGames, futureGames] = await Promise.all([
			fetchWindow(SEASON, group, OPENING, asOf),
			fetchUnderlyingWindow(SEASON, group === "hitting" ? "batter" : "pitcher", OPENING, asOf),
			fetchWindow(SEASON, group, addDays(asOf, 1), end),
			fetchGamesPlayedWindow(OPENING, asOf),
			fetchGamesPlayedWindow(addDays(asOf, 1), end)
		])
		const recentSets = new Map<number, { rows: Map<number, any>; games: Map<number, number> }>()
		for (const days of RECENT_DAYS) {
			const start = addDays(asOf, -days)
			const [rows, games] = await Promise.all([
				fetchWindow(SEASON, group, start, asOf),
				fetchGamesPlayedWindow(start, asOf)
			])
			recentSets.set(days, { rows: new Map(rows.map(r => [r.id, r])), games })
		}

		const actualById = new Map(actual.map(p => [p.id, p]))
		const table = group === "hitting" ? league.scoring.batting : league.scoring.pitching
		const vol = (p: any) => (group === "hitting" ? (p.stats.plateAppearances ?? 0) : (p.stats.battersFaced ?? 0))

		const pairs: Record<string, [number, number][]> = {}
		for (const p of prior) {
			if (vol(p) < minVol || p.teamId === null) continue
			if (group === "hitting" ? p.position === "P" : p.position !== "P") continue
			const gAhead = futureGames.get(p.teamId) ?? 0
			const gBehind = priorGames.get(p.teamId) ?? 0
			if (!gAhead || !gBehind) continue
			const actualPoints = (() => {
				const a = actualById.get(p.id)
				return a ? scoreStats(a.stats, table, group).points : 0
			})()
			const seasonPerGame = vol(p) / gBehind
			const u = priorX.get(p.id)

			for (const days of RECENT_DAYS) {
				const set = recentSets.get(days)!
				const rec = set.rows.get(p.id)
				const rg = set.games.get(p.teamId) ?? 0
				const recPerGame = rg > 0 ? (rec ? vol(rec) : 0) / rg : null
				for (const w of BLEND) {
					for (const q of QUALITY) {
						const key = `d${days}_w${w}_q${q}`
						const base = project(p, u, gBehind, gAhead, { qualityWeight: q })
						let pts: number
						if (recPerGame === null || seasonPerGame <= 0) {
							pts = scoreStats(base.stats, table, group).points
						} else {
							const blended = (1 - w) * seasonPerGame + w * recPerGame
							const ratio = blended / seasonPerGame
							const scaled: Record<string, number> = {}
							for (const [k, v] of Object.entries(base.stats)) scaled[k] = v * ratio
							pts = scoreStats(scaled, table, group).points
						}
						;(pairs[key] ??= []).push([pts, actualPoints])
					}
				}
			}
		}
		for (const [k, v] of Object.entries(pairs)) {
			;(results[k] ??= []).push(spearman(v))
			;(tops[k] ??= []).push(topNValue(v, 20))
		}
	}

	const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
	const ranked = Object.entries(results)
		.map(([k, v]) => ({ k, rho: mean(v), top20: mean(tops[k]!) }))
		.sort((a, b) => b.rho - a.rho)
	console.log(`\n${group.toUpperCase()} — best parameter sets by mean Spearman ρ across ${FOLDS.length} folds`)
	console.log("  params                 ρ      top20 actual pts")
	for (const r of ranked.slice(0, 6))
		console.log(`  ${r.k.padEnd(20)} ${r.rho.toFixed(4)}   ${r.top20.toFixed(1)}`)
	const worst = ranked[ranked.length - 1]!
	console.log(`  ${"(worst) " + worst.k.padEnd(12)} ${worst.rho.toFixed(4)}   ${worst.top20.toFixed(1)}`)
}
