import type { StatLine, PlayerSeason } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"

/**
 * Projection. Unlike everything upstream, this layer is MODELLED — it states what
 * a player is likely to do, which no source observes. So every output carries its
 * inputs and its assumptions, and `modelled` names exactly which knobs were applied.
 */

/** Batted-ball outcomes and the run production that tracks them get the quality
 *  adjustment. Plate discipline and speed do not — they aren't batted-ball driven.
 *  The sets differ by side: for a pitcher these are the events he ALLOWS, and
 *  earnedRuns is the category most leagues weight hardest, so it must be included. */
const QUALITY_SCALED = {
	hitting: new Set(["hits", "doubles", "triples", "homeRuns", "totalBases", "rbi", "runs"]),
	pitching: new Set(["hits", "doubles", "triples", "homeRuns", "runs", "earnedRuns"])
} as const

/** Weight on expected-vs-actual, rising with batted-ball sample. Capped at 0.7 so a
 *  projection is never purely the model. */
const lambdaFor = (pa: number): number => Math.min(0.7, pa / (pa + 300))

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export interface Projection {
	/** Real games the player's team has scheduled in the window. */
	horizonGames: number
	/** Observed: plate appearances (or outs, for pitchers) per team game. */
	volumePerTeamGame: number | null
	/** Modelled: expected volume across the horizon. */
	projectedVolume: number | null
	/** Modelled: ratio applied to batted-ball outcomes, 1 = no adjustment. */
	qualityMultiplier: number
	stats: StatLine
	modelled: string[]
	missing: string[]
}

export const project = (
	player: PlayerSeason,
	underlying: Underlying | undefined,
	teamGamesPlayed: number | undefined,
	horizonGames: number
): Projection => {
	const modelled: string[] = []
	const missing: string[] = []
	const s = player.stats
	const isHitter = player.group === "hitting"

	// volume unit: plate appearances for hitters, outs recorded for pitchers
	const volume = isHitter ? s.plateAppearances : s.outs
	if (volume === undefined) missing.push(isHitter ? "plateAppearances" : "outs")
	if (teamGamesPlayed === undefined) missing.push("teamGamesPlayed")

	const volumePerTeamGame =
		volume !== undefined && teamGamesPlayed ? volume / teamGamesPlayed : null
	const projectedVolume =
		volumePerTeamGame === null ? null : volumePerTeamGame * horizonGames
	if (projectedVolume !== null)
		modelled.push(
			`volume: ${volumePerTeamGame!.toFixed(2)}/team game × ${horizonGames} games`
		)

	// quality: blend observed wOBA toward expected, then express as a ratio
	let qualityMultiplier = 1
	if (underlying?.xwoba != null && underlying.woba != null && underlying.woba > 0) {
		const pa = underlying.pa ?? volume ?? 0
		const lambda = lambdaFor(pa)
		const blended = underlying.woba + lambda * (underlying.xwoba - underlying.woba)
		// The ratio applies directly for both sides: it scales the events the player
		// produces (hitter) or allows (pitcher). A pitcher whose expected wOBA-against
		// is below his actual has been unlucky, so the ratio is <1 and his projected
		// hits and earned runs come DOWN. (An earlier version inverted this and
		// pushed unlucky pitchers' ER up — exactly backwards.)
		qualityMultiplier = clamp(blended / underlying.woba, 0.75, 1.35)
		modelled.push(
			`quality: wOBA ${underlying.woba} → ${blended.toFixed(3)} (λ=${lambda.toFixed(2)} toward xwOBA ${underlying.xwoba}) ⇒ ×${qualityMultiplier.toFixed(3)}`
		)
	} else missing.push("underlying expected stats")

	const stats: StatLine = {}
	if (projectedVolume !== null && volume) {
		for (const [key, value] of Object.entries(s)) {
			// rate stats and identifiers don't scale with volume
			if (["avg", "obp", "slg", "ops", "era", "whip", "age", "babip"].includes(key)) continue
			const perUnit = value / volume
			const scaled = QUALITY_SCALED[player.group].has(key) ? qualityMultiplier : 1
			stats[key] = Number((perUnit * projectedVolume * scaled).toFixed(3))
		}
		if (isHitter) stats.plateAppearances = Number(projectedVolume.toFixed(1))
		else stats.outs = Number(projectedVolume.toFixed(1))
	}

	return {
		horizonGames,
		volumePerTeamGame:
			volumePerTeamGame === null ? null : Number(volumePerTeamGame.toFixed(3)),
		projectedVolume:
			projectedVolume === null ? null : Number(projectedVolume.toFixed(1)),
		qualityMultiplier: Number(qualityMultiplier.toFixed(3)),
		stats,
		modelled,
		missing
	}
}

/**
 * How much to trust a projection, 0–1. Driven by real sample size, whether
 * underlying data exists at all, and health — never a flat default.
 */
export const confidenceOf = (
	player: PlayerSeason,
	underlying: Underlying | undefined,
	injury: string | undefined
): { value: number; reasons: string[] } => {
	const reasons: string[] = []
	const volume =
		player.group === "hitting" ? player.stats.plateAppearances : player.stats.battersFaced
	const sample = Math.min(1, (volume ?? 0) / 400)
	if (sample < 1) reasons.push(`limited sample (${volume ?? 0})`)
	const hasUnderlying = underlying?.xwoba != null
	if (!hasUnderlying) reasons.push("no Statcast expected stats")
	const healthy = !injury
	if (!healthy) reasons.push(injury!)
	const value = sample * (hasUnderlying ? 1 : 0.6) * (healthy ? 1 : 0.5)
	return { value: Number(value.toFixed(3)), reasons }
}
