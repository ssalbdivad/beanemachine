import type { Rated } from "../engine/bscore.ts"
import type { RosterSpot } from "./roster.ts"
import { normalizeName } from "../data/yahoo-pool.ts"

/**
 * Turns a ranked board plus your actual roster into a list of moves.
 *
 * Deliberately conservative. It proposes a swap only when the add clears the drop
 * by a real margin, never touches a player above the keep floor, and caps how much
 * it will do in one run. An autonomous agent operating on someone's team should be
 * boring.
 */
export interface Move {
	kind: "add-drop"
	add: string
	addScore: number
	drop: string
	dropScore: number
	gain: number
	reason: string
}

export interface PlanOptions {
	/** Minimum bscore improvement before a swap is worth making. */
	minGain: number
	/** Never drop anyone at or above this bscore, whatever the alternative. */
	keepFloor: number
	/**
	 * Hard cap on moves per run.
	 *
	 * One is both the safe default and the measured optimum. Played across 2023-2025,
	 * bscore wins the season outright at one waiver move per week (41 of 68 weeks
	 * against season-to-date) and loses its edge entirely at three, where naive
	 * streak-chasing beats it. The model is worth using for one high-conviction move,
	 * not for churn.
	 */
	maxMoves: number
}

export const DEFAULTS: PlanOptions = { minGain: 5, keepFloor: 25, maxMoves: 1 }

export const planMoves = (
	roster: RosterSpot[],
	rated: Rated[],
	availableNames: Set<string>,
	options: PlanOptions = DEFAULTS
): { moves: Move[]; skipped: string[] } => {
	const byName = new Map(rated.map(r => [normalizeName(r.player.name), r]))
	const skipped: string[] = []

	const rostered = roster
		.filter(s => s.slot !== "IL" && s.slot !== "NA")
		.map(s => ({ spot: s, rated: byName.get(normalizeName(s.name)) }))

	for (const r of rostered)
		if (!r.rated) skipped.push(`${r.spot.name} — not on the board, so not considered`)

	const droppable = rostered
		.filter(r => r.rated && r.rated.bscore < options.keepFloor)
		.sort((a, b) => a.rated!.bscore - b.rated!.bscore)

	const addable = rated
		.filter(r => r.rateable && availableNames.has(normalizeName(r.player.name)))
		.sort((a, b) => b.bscore - a.bscore)

	const moves: Move[] = []
	const usedAdds = new Set<string>()
	for (const drop of droppable) {
		if (moves.length >= options.maxMoves) break
		const best = addable.find(
			a =>
				!usedAdds.has(a.player.id.toString()) &&
				// only swap like for like, so the roster stays legal
				a.slots.some(s => drop.rated!.slots.includes(s))
		)
		if (!best) continue
		const gain = Number((best.bscore - drop.rated!.bscore).toFixed(2))
		if (gain < options.minGain) continue
		usedAdds.add(best.player.id.toString())
		moves.push({
			kind: "add-drop",
			add: best.player.name,
			addScore: best.bscore,
			drop: drop.spot.name,
			dropScore: drop.rated!.bscore,
			gain,
			reason:
				`${best.player.name} projects ${gain} points higher over the horizon at ` +
				`${best.slot}, and ${drop.spot.name} is ${drop.rated!.bscore} — below the ` +
				`${options.keepFloor} keep floor.`
		})
	}
	return { moves, skipped }
}
