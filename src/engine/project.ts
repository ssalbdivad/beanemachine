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

/**
 * Shrinkage constants: roughly the volume at which a stat is half signal, half
 * noise. A hitter with 90 PA and four homers has not shown you a 40-homer pace,
 * and projecting his raw rate forward is how you end up recommending a hot streak.
 * Values follow the published stabilisation work (Carleton / Tango); anything not
 * listed falls back to DEFAULT_K, which is deliberately heavy because an unlisted
 * stat is one we have no stabilisation evidence for.
 */
const DEFAULT_K = 400
const SHRINK_K: Record<string, number> = {
	// hitting, in plate appearances
	homeRuns: 170, baseOnBalls: 120, strikeOuts: 60, hits: 290, doubles: 700,
	triples: 1200, hitByPitch: 240, stolenBases: 350, caughtStealing: 500,
	runs: 300, rbi: 300, totalBases: 320, sacFlies: 600, groundIntoDoublePlay: 500,
	intentionalWalks: 600, atBats: 50, sacBunts: 600,
	// pitching, in batters faced
	earnedRuns: 400, wins: 500, saves: 400, holds: 400, blownSaves: 600,
	losses: 500, completeGames: 900, shutouts: 900, wildPitches: 500, balks: 900,
	homeRunsAllowed: 300
}

/** Population rate per volume unit, pooled across the players being compared. */
export interface LeagueRates {
	perUnit: Record<string, number>
}

export const leagueRatesFrom = (
	players: { group: string; stats: StatLine }[],
	group: "hitting" | "pitching"
): LeagueRates => {
	const unit = group === "hitting" ? "plateAppearances" : "battersFaced"
	const totals: Record<string, number> = {}
	let volume = 0
	for (const p of players) {
		if (p.group !== group) continue
		const v = p.stats[unit] ?? 0
		if (v <= 0) continue
		volume += v
		for (const [k, val] of Object.entries(p.stats)) totals[k] = (totals[k] ?? 0) + val
	}
	const perUnit: Record<string, number> = {}
	if (volume > 0) for (const [k, v] of Object.entries(totals)) perUnit[k] = v / volume
	return { perUnit }
}

export interface ProjectOptions {
	rates?: LeagueRates
	/**
	 * Weight on the Statcast expected-stats adjustment.
	 *
	 * Defaults to 0, because a leak-free backtest over four folds said so. At a
	 * 14-day horizon the xwOBA blend was consistently neutral-to-slightly-negative
	 * against a naive baseline, and every parameter sweep ranked qualityWeight 0
	 * first. The mechanism is still exposed and the numbers are still shown in the
	 * UI — but it does not silently move a recommendation on evidence it failed.
	 */
	qualityWeight?: number
	/** Volume per team game over the recent window, if known. */
	recentVolumePerGame?: number | null
	/**
	 * How much to trust recent playing time over season-long. 0.75 measured best
	 * on both sides: a player who just took over an everyday job has a season-long
	 * rate that understates his coming volume, and that is a volume error.
	 */
	recentWeight?: number
}

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
	horizonGames: number,
	options: ProjectOptions = {}
): Projection => {
	const { rates, qualityWeight = 0, recentVolumePerGame = null, recentWeight = 0.75 } = options
	const modelled: string[] = []
	const missing: string[] = []
	const s = player.stats
	const isHitter = player.group === "hitting"

	// volume unit: plate appearances for hitters, outs recorded for pitchers
	const volume = isHitter ? s.plateAppearances : s.outs
	if (volume === undefined) missing.push(isHitter ? "plateAppearances" : "outs")
	if (teamGamesPlayed === undefined) missing.push("teamGamesPlayed")

	const seasonPerTeamGame =
		volume !== undefined && teamGamesPlayed ? volume / teamGamesPlayed : null
	// Blend season-long and recent playing time. Backtested: this is the single
	// largest improvement available, worth ~20% relative Spearman over naive.
	const volumePerTeamGame =
		seasonPerTeamGame === null ? null
		: recentVolumePerGame === null ?
			seasonPerTeamGame
		:	(1 - recentWeight) * seasonPerTeamGame + recentWeight * recentVolumePerGame
	const projectedVolume =
		volumePerTeamGame === null ? null : volumePerTeamGame * horizonGames
	if (projectedVolume !== null) {
		if (recentVolumePerGame !== null && seasonPerTeamGame !== null)
			modelled.push(
				`playing time: ${seasonPerTeamGame.toFixed(2)}/game season, ` +
					`${recentVolumePerGame.toFixed(2)}/game recent → ` +
					`${volumePerTeamGame!.toFixed(2)} (${Math.round(recentWeight * 100)}% recent) × ${horizonGames} games`
			)
		else
			modelled.push(`volume: ${volumePerTeamGame!.toFixed(2)}/team game × ${horizonGames} games`)
	}

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
		const full = blended / underlying.woba
		qualityMultiplier = clamp(1 + qualityWeight * (full - 1), 0.75, 1.35)
		if (qualityWeight > 0)
			modelled.push(
				`quality: wOBA ${underlying.woba} → ${blended.toFixed(3)} (λ=${lambda.toFixed(2)} toward xwOBA ${underlying.xwoba}) ⇒ ×${qualityMultiplier.toFixed(3)}`
			)
		else
			modelled.push(
				`Statcast adjustment evaluated and NOT applied — it did not beat a naive ` +
					`baseline in backtest, so xwOBA ${underlying.xwoba} is shown but not used`
			)
	} else missing.push("underlying expected stats")

	const stats: StatLine = {}
	if (projectedVolume !== null && volume) {
		for (const [key, value] of Object.entries(s)) {
			// rate stats and identifiers don't scale with volume
			if (["avg", "obp", "slg", "ops", "era", "whip", "age", "babip"].includes(key)) continue
			// Shrink the observed rate toward the population rate in proportion to how
			// little volume backs it. Without this a 90-PA hot streak projects forward
			// at face value, which is the single biggest source of bad recommendations.
			const leagueRate = rates?.perUnit[key]
			const k = SHRINK_K[key] ?? DEFAULT_K
			const perUnit =
				leagueRate === undefined ?
					value / volume
				:	(value + k * leagueRate) / (volume + k)
			const scaled = QUALITY_SCALED[player.group].has(key) ? qualityMultiplier : 1
			stats[key] = Number((perUnit * projectedVolume * scaled).toFixed(3))
		}
		if (rates) modelled.push(`shrunk toward league rates by stat-specific sample weight`)
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
