import type { League } from "../schema.ts"
import type { PlayerSeason } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import { scoreStats, tableFor, type PointsResult } from "./points.ts"
import { confidenceOf, project, type Projection } from "./project.ts"

/**
 * The bscore: a player's projected points over the horizon, minus what a freely
 * available replacement at the same roster slot would produce, in THIS league's
 * scoring. Points above replacement is the honest unit — it is denominated in the
 * league's own currency, so a bscore of 40 literally means "forty more points than
 * the next man up".
 */

/** StatsAPI reports one primary position; a league's real multi-position
 *  eligibility is not exposed by any source we read, so it is never assumed. */
export const slotsFor = (player: PlayerSeason): string[] => {
	const p = player.position
	if (player.group === "pitching")
		return (player.stats.gamesStarted ?? 0) > 0 ? ["SP", "P"] : ["RP", "P"]
	if (["LF", "CF", "RF", "OF"].includes(p)) return ["OF", "Util"]
	if (p === "DH") return ["Util"]
	if (["C", "1B", "2B", "3B", "SS"].includes(p)) return [p, "Util"]
	return ["Util"]
}

export interface Rated {
	player: PlayerSeason
	underlying: Underlying | undefined
	injury: string | undefined
	slots: string[]
	projection: Projection
	projected: PointsResult
	season: PointsResult
	/** Projected points over the horizon. */
	points: number
	/** Points above the replacement-level player at this slot. */
	bscore: number
	/** The slot where the player is most valuable. */
	slot: string
	replacement: number
	confidence: { value: number; reasons: string[] }
	/** False when no projection was possible — such a player is reported, never
	 *  silently ranked at zero alongside real ones. */
	rateable: boolean
	/** est_woba − woba: positive means results trail contact quality. */
	regressionGap: number | null
}

export interface RateOptions {
	league: League
	players: PlayerSeason[]
	underlying: { hitting: Map<number, Underlying>; pitching: Map<number, Underlying> }
	injuries: Map<number, string>
	teamGamesPlayed: Map<number, number>
	gamesByTeam: Map<number, number>
	/** Teams in the league — sets how deep the replacement level sits. Required:
	 *  defaulting it would silently move every replacement level and therefore
	 *  every bscore, which is exactly the kind of quiet assumption this app exists
	 *  to refuse. */
	teams: number
}

export const rateAll = (o: RateOptions): Rated[] => {
	const slotCounts = o.league.roster.slots

	const rated: Rated[] = o.players.map(player => {
		const underlying = o.underlying[player.group].get(player.id)
		const injury = o.injuries.get(player.id)
		const horizonGames = player.teamId ? (o.gamesByTeam.get(player.teamId) ?? 0) : 0
		const projection = project(
			player,
			underlying,
			player.teamId ? o.teamGamesPlayed.get(player.teamId) : undefined,
			horizonGames
		)
		const table = tableFor(o.league, player.group)
		return {
			player,
			underlying,
			injury,
			slots: slotsFor(player),
			projection,
			projected: scoreStats(projection.stats, table, player.group),
			season: scoreStats(player.stats, table, player.group),
			points: 0,
			bscore: 0,
			slot: "",
			replacement: 0,
			confidence: confidenceOf(player, underlying, injury),
			rateable: projection.projectedVolume !== null && projection.projectedVolume > 0,
			regressionGap: underlying?.xwobaGap ?? null
		}
	})

	for (const r of rated) r.points = r.projected.points

	/**
	 * Replacement level per slot: the (teams × slots)-th best projected player who
	 * is eligible there. That is literally the best player still on waivers once
	 * every team has filled the slot — so the depth follows the league's own roster
	 * configuration rather than a rule of thumb.
	 */
	const replacementBySlot = new Map<string, number>()
	for (const [slot, count] of Object.entries(slotCounts)) {
		if (slot === "BN" || slot === "IL" || slot === "NA") continue
		const eligible = rated
			.filter(r => r.rateable && r.slots.includes(slot))
			.sort((a, b) => b.points - a.points)
		const depth = Math.min(o.teams * count, Math.max(eligible.length - 1, 0))
		replacementBySlot.set(slot, eligible[depth]?.points ?? 0)
	}

	for (const r of rated) {
		let best = { slot: r.slots[0] ?? "Util", value: -Infinity, replacement: 0 }
		for (const slot of r.slots) {
			const replacement = replacementBySlot.get(slot)
			if (replacement === undefined) continue
			const value = r.points - replacement
			if (value > best.value) best = { slot, value, replacement }
		}
		r.slot = best.slot
		r.replacement = Number(best.replacement.toFixed(2))
		r.bscore = Number((best.value === -Infinity ? 0 : best.value).toFixed(2))
	}

	return rated.sort((a, b) => b.bscore - a.bscore)
}

/** Percentile of the regression gap within the rated pool — the undervaluation
 *  signal, expressed relative to the players actually being compared. */
export const withUndervaluation = (rated: Rated[]) => {
	// Percentile WITHIN a side. For a batter a positive est_woba − woba means his
	// results trail his contact; for a pitcher it means the opposite. Ranking both
	// in one pool, as an earlier version did, produced a number with no meaning.
	const gapsBySide = {
		hitting: [] as number[],
		pitching: [] as number[]
	}
	for (const r of rated)
		if (r.regressionGap !== null && r.rateable) gapsBySide[r.player.group].push(r.regressionGap)
	for (const key of ["hitting", "pitching"] as const) gapsBySide[key].sort((a, b) => a - b)

	return rated.map(r => {
		if (r.regressionGap === null || !r.rateable) return { ...r, undervaluation: null }
		// a pitcher benefits when his expected is BELOW his actual, so the sign flips
		const gap = r.player.group === "hitting" ? r.regressionGap : -r.regressionGap
		const pool = gapsBySide[r.player.group].map(g =>
			r.player.group === "hitting" ? g : -g
		)
		const below = pool.filter(g => g < gap).length
		return {
			...r,
			undervaluation: Number(((below / Math.max(pool.length, 1)) * 100).toFixed(1))
		}
	})
}
