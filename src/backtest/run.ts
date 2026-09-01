import { readFileSync } from "node:fs"
import { scoreStats } from "../engine/points.ts"
import { leagueRatesFrom, project } from "../engine/project.ts"
import {
	fetchGamesPlayedWindow, fetchUnderlyingWindow, fetchWindow,
	rmse, spearman, topNValue
} from "./harness.ts"
import type { League } from "../schema.ts"

/**
 * Stand at `asOf`, project the next `horizon` days using only prior information,
 * then score against what actually happened. Compared against a naive baseline —
 * if the model can't beat "he'll keep doing what he's been doing", it isn't earning
 * its complexity.
 */
const league: League = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const SEASON = 2026
const OPENING = "2026-03-26"

const addDays = (d: string, n: number) =>
	new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10)

export interface FoldResult {
	asOf: string
	group: "hitting" | "pitching"
	n: number
	variants: Record<string, { rho: number; rmse: number; top20: number }>
	actualTop20: number
}

export const runFold = async (
	asOf: string,
	horizonDays: number,
	group: "hitting" | "pitching",
	minVolume: number
): Promise<FoldResult> => {
	const end = addDays(asOf, horizonDays)
	const recentStart = addDays(asOf, -21)
	const [prior, priorX, actual, priorGames, futureGames, recent, recentGames] =
		await Promise.all([
			fetchWindow(SEASON, group, OPENING, asOf),
			fetchUnderlyingWindow(SEASON, group === "hitting" ? "batter" : "pitcher", OPENING, asOf),
			fetchWindow(SEASON, group, addDays(asOf, 1), end),
			fetchGamesPlayedWindow(OPENING, asOf),
			fetchGamesPlayedWindow(addDays(asOf, 1), end),
			fetchWindow(SEASON, group, recentStart, asOf),
			fetchGamesPlayedWindow(recentStart, asOf)
		])
	const recentById = new Map(recent.map(p => [p.id, p]))

	const actualById = new Map(actual.map(p => [p.id, p]))
	const table = group === "hitting" ? league.scoring.batting : league.scoring.pitching
	const volumeOf = (p: (typeof prior)[number]) =>
		group === "hitting" ? (p.stats.plateAppearances ?? 0) : (p.stats.battersFaced ?? 0)

	// three variants, so the contribution of each idea is isolated
	const variants: Record<string, [number, number][]> = {
		naive: [], quality: [], shrink: [], recentVol: [], recentVolQ: []
	}
	const rates = leagueRatesFrom(prior, group)

	for (const p of prior) {
		if (volumeOf(p) < minVolume) continue
		if (p.teamId === null) continue
		if (group === "hitting" && p.position === "P") continue
		if (group === "pitching" && p.position !== "P") continue
		const gamesAhead = futureGames.get(p.teamId) ?? 0
		const gamesBehind = priorGames.get(p.teamId) ?? 0
		if (!gamesAhead || !gamesBehind) continue

		const truth = actualById.get(p.id)
		const actualPoints = truth ? scoreStats(truth.stats, table, group).points : 0

		const u = priorX.get(p.id)
		const score = (o: Parameters<typeof project>[4]) =>
			scoreStats(project(p, u, gamesBehind, gamesAhead, o).stats, table, group).points
		variants.quality!.push([score({ qualityWeight: 1 }), actualPoints])
		variants.shrink!.push([score({ rates, qualityWeight: 0 }), actualPoints])
		// Rate from the long sample, PLAYING TIME from the recent one. A player who
		// just took over an everyday job has a season-long rate that understates his
		// coming volume by half, and that is a volume error, not a rate error.
		const rec = recentById.get(p.id)
		const recVolume =
			group === "hitting" ? (rec?.stats.plateAppearances ?? 0) : (rec?.stats.battersFaced ?? 0)
		const recGames = p.teamId ? (recentGames.get(p.teamId) ?? 0) : 0
		const recPerGame = recGames > 0 ? recVolume / recGames : null
		const seasonPerGame = volumeOf(p) / gamesBehind

		const withRecentVolume = (qw: number) => {
			const proj = project(p, u, gamesBehind, gamesAhead, { qualityWeight: qw })
			if (recPerGame === null || seasonPerGame <= 0) return scoreStats(proj.stats, table, group).points
			// rescale the whole projected line by how the recent role differs
			const ratio = recPerGame / seasonPerGame
			const rescaled: Record<string, number> = {}
			for (const [k, v] of Object.entries(proj.stats)) rescaled[k] = v * ratio
			return scoreStats(rescaled, table, group).points
		}
		variants.recentVol!.push([withRecentVolume(0), actualPoints])
		variants.recentVolQ!.push([withRecentVolume(1), actualPoints])

		// baseline: keep doing what you've been doing, scaled to games ahead
		const seasonPoints = scoreStats(p.stats, table, group).points
		variants.naive!.push([(seasonPoints / gamesBehind) * gamesAhead, actualPoints])
	}

	const stat = (pairs: [number, number][]) => ({
		rho: Number(spearman(pairs).toFixed(4)),
		rmse: Number(rmse(pairs).toFixed(2)),
		top20: Number(topNValue(pairs, 20).toFixed(1))
	})
	const perfect = variants.naive!.map(([, a]) => [a, a] as [number, number])

	return {
		asOf, group, n: variants.naive!.length,
		variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, stat(v)])),
		actualTop20: Number(topNValue(perfect, 20).toFixed(1))
	}
}

if (import.meta.filename === process.argv[1]) {
	const folds = ["2026-05-15", "2026-06-15", "2026-07-15", "2026-08-01"]
	const horizon = Number(process.argv.find(a => a.startsWith("--horizon="))?.slice(10) ?? 14)
	console.log(`Backtest · ${horizon}-day horizon · league: ${league.meta.league_name}\n`)
	for (const group of ["hitting", "pitching"] as const) {
		const minVol = group === "hitting" ? 80 : 60
		console.log(`${group.toUpperCase()}  (min ${minVol} ${group === "hitting" ? "PA" : "BF"} prior)`)
		const names = ["naive", "quality", "shrink", "recentVol", "recentVolQ"]
		console.log("  as-of         n   " + names.map(n => n.padStart(11)).join("") + "     (Spearman ρ)")
		const acc: Record<string, number[]> = Object.fromEntries(names.map(n => [n, []]))
		for (const asOf of folds) {
			const r = await runFold(asOf, horizon, group, minVol)
			for (const n of names) acc[n]!.push(r.variants[n]!.rho)
			const best = names.reduce((a, b) => (r.variants[b]!.rho > r.variants[a]!.rho ? b : a))
			console.log(
				`  ${r.asOf} ${String(r.n).padStart(5)}   ` +
				names.map(n => (r.variants[n]!.rho.toFixed(3) + (n === best ? "*" : " ")).padStart(11)).join("")
			)
		}
		const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
		console.log(
			"  MEAN            " + names.map(n => mean(acc[n]!).toFixed(3).padStart(11)).join("")
		)
		console.log()
	}
}
