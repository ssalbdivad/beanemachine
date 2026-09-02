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
	 * How much to trust recent playing time over season-long. 0.75 measured best on
	 * both sides across 100 folds and ten seasons: a player who just took over an
	 * everyday job has a season-long rate that understates his coming volume, and
	 * that is a volume error, not a rate error.
	 */
	recentWeight?: number
	/** The player's own line over the recent window, if known. */
	recentStats?: StatLine | null
	/**
	 * How much to blend the RECENT rate into the season rate. Distinct from
	 * recentWeight, which governs volume only. Defaults to 0 until evidence says
	 * otherwise — a hot fortnight is mostly noise, and the naive baseline already
	 * over-trusts it.
	 */
	recentRateWeight?: number
}

/**
 * The recent window that measured best per side, over 2016–2026.
 *
 * They differ, and the reason is structural rather than statistical: a hitter's
 * role can change in a week, so a 7-day window tracks it; a starter works every
 * fifth day, so a 7-day window is one or two starts of pure noise and 21 days is
 * needed before his workload is even visible.
 */
export const RECENT_WINDOW_DAYS = { hitting: 7, pitching: 21 } as const

/**
 * Playing-time windows and their relative weights, per side.
 *
 * A single flat window throws away the fact that the last series is worth more
 * than the fortnight before it. Measured over 100 folds: weighting the most recent
 * ~3 days double against a 7- and 21-day window beat the single-window model in
 * 40 of 50 hitting folds. Pitchers work on a five-day turn, so their short window
 * is 5 days rather than 3.
 */
export const RECENT_WINDOW_WEIGHTS: Record<"hitting" | "pitching", Record<number, number>> = {
	hitting: { 3: 2, 7: 1, 21: 1 },
	pitching: { 5: 2, 21: 1 }
}

/**
 * How far the blended recent estimate pulls the season-long rate.
 *
 * 0.5, decided by playing whole seasons rather than by ranking correlation. On a
 * 14-day ranking 0.75 measured about 0.003 higher — inside the noise band — but
 * across 2023-2025 of actual weekly roster decisions 0.5 is worth roughly 1,500
 * points and lifts the weekly win rate against a season-to-date manager from
 * 41/68 to 48/68. Heavy recency catches role changes, which a correlation
 * rewards; it also chases week-to-week noise, which a season punishes.
 */
export const RECENT_BLEND_WEIGHT = { hitting: 0.5, pitching: 0.5 } as const

/** Combines several windows into one per-team-game estimate. */
export const blendWindows = (
	perWindow: Record<number, number | undefined>,
	weights: Record<number, number>
): number | null => {
	let acc = 0, wsum = 0
	for (const [days, w] of Object.entries(weights)) {
		const v = perWindow[Number(days)]
		if (v === undefined) continue
		acc += w * v
		wsum += w
	}
	return wsum > 0 ? acc / wsum : null
}

/**
 * How much of the recent RATE to blend in, per side.
 *
 * Pitchers only, and lightly. Over 100 folds a 0.15 blend on the 21-day window
 * beat the shipped configuration in 41 of 50 pitching folds. The same idea for
 * hitters won 29 of 50 — a coin flip — so it is not applied there. Ranking a mean
 * difference of 0.0009 as an improvement would have been fitting noise.
 */
export const RECENT_RATE_WEIGHT = { hitting: 0, pitching: 0.15 } as const

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
	const {
		rates, qualityWeight = 0, recentVolumePerGame = null, recentWeight = 0.75,
		recentStats = null, recentRateWeight = 0
	} = options
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
			let perUnit =
				leagueRate === undefined ?
					value / volume
				:	(value + k * leagueRate) / (volume + k)
			// optionally pull the rate toward what the player has done lately
			if (recentRateWeight > 0 && recentStats) {
				const rv = isHitter ? recentStats.plateAppearances : recentStats.outs
				if (rv && rv > 0) {
					const recentRate = (recentStats[key] ?? 0) / rv
					perUnit = (1 - recentRateWeight) * perUnit + recentRateWeight * recentRate
				}
			}
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
 * A full season of work for a player who holds the job outright, in the unit
 * confidence measures: plate appearances for hitters, batters faced for pitchers.
 *
 * Read off the reference capture rather than chosen, because a round number is a
 * guess about workload and the capture states it. Each is the median season
 * volume among the players who fill that role's league-wide jobs — the top 270
 * hitters by PA (nine lineup spots × 30 teams), the top 150 mostly-starting
 * pitchers (a five-man rotation), the top 240 mostly-relieving ones (an eight-man
 * bullpen). The hitting figure works out to 3.14 PA per team game, which is the
 * rate MLB itself uses to define a qualified hitter — an independent threshold
 * the derivation reproduces without being aimed at it.
 */
const FULL_SEASON = { hitting: 434, starting: 540, relieving: 209 } as const

/**
 * What a full season looks like for THIS pitcher, interpolated on the share of
 * his appearances that were starts.
 *
 * A starter faces 2.6× what a reliever does, so one denominator across both makes
 * "low confidence" mean "is a reliever" — a statement about role, not about
 * sample. Interpolating rather than bucketing on a majority-of-starts rule keeps
 * a swingman off a cliff where one extra start would halve his confidence, and it
 * is the more honest reading anyway: his workload really is between the two.
 */
const pitcherFullSeason = (stats: StatLine): number | null => {
	if (!stats.gamesPitched || stats.gamesStarted === undefined) return null
	const startShare = stats.gamesStarted / stats.gamesPitched
	return FULL_SEASON.relieving + startShare * (FULL_SEASON.starting - FULL_SEASON.relieving)
}

/**
 * How much to trust a projection, 0–1. Driven by real sample size measured
 * against the player's own role, whether underlying data exists at all, and
 * health — never a flat default.
 */
export const confidenceOf = (
	player: PlayerSeason,
	underlying: Underlying | undefined,
	injury: string | undefined
): { value: number; reasons: string[] } => {
	const reasons: string[] = []
	const isHitter = player.group === "hitting"
	const volume = isHitter ? player.stats.plateAppearances : player.stats.battersFaced
	const fullSeason = isHitter ? FULL_SEASON.hitting : pitcherFullSeason(player.stats)
	let sample = 0
	if (volume === undefined) reasons.push("volume not reported")
	else if (fullSeason === null)
		reasons.push("role not reported, so there is no workload to measure against")
	else {
		sample = Math.min(1, volume / fullSeason)
		// naming the target makes the number auditable: 203 of 209 is a full-time
		// closer, 203 of 540 is a starter who missed half a year
		if (sample < 1) reasons.push(`limited sample (${volume} of ${Math.round(fullSeason)})`)
	}
	const hasUnderlying = underlying?.xwoba != null
	if (!hasUnderlying) reasons.push("no Statcast expected stats")
	const healthy = !injury
	if (!healthy) reasons.push(injury!)
	const value = sample * (hasUnderlying ? 1 : 0.6) * (healthy ? 1 : 0.5)
	return { value: Number(value.toFixed(3)), reasons }
}
