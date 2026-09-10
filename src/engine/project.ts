import type { StatLine, PlayerSeason } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import { roundTo } from "./points.ts"
import { MODEL, type ModelWeights, windowsFor } from "./weights.ts"

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
	wide: {
		hitting: new Set(["hits", "doubles", "triples", "homeRuns", "totalBases", "rbi", "runs"]),
		pitching: new Set(["hits", "doubles", "triples", "homeRuns", "runs", "earnedRuns"])
	},
	/** Run production dropped: a hitter's runs and RBI are mostly a fact about the
	 *  eight men around him, so scaling them by HIS contact quality imports lineup
	 *  noise into a batted-ball signal. A pitcher's earned runs stay — those are his. */
	battedBall: {
		hitting: new Set(["hits", "doubles", "triples", "homeRuns", "totalBases"]),
		pitching: new Set(["hits", "doubles", "triples", "homeRuns", "earnedRuns"])
	}
} as const

/**
 * Weight on expected-vs-actual.
 *
 * The mode is a real modelling question, not a tuning detail:
 *   `rising`  trusts xwOBA more as batted-ball sample grows;
 *   `falling` trusts it more in SMALL samples — which is what the stabilisation
 *             work actually argues, since xwOBA stabilises in a few dozen batted
 *             balls while wOBA needs hundreds of plate appearances;
 *   `fixed`   ignores sample entirely.
 * Capped so a projection is never purely the model.
 */
const lambdaFor = (pa: number, cfg = MODEL.statcast.lambda): number => {
	const { mode, prior, cap } = cfg
	if (mode === "fixed") return cap
	const raw = mode === "rising" ? pa / (pa + prior) : prior / (pa + prior)
	return Math.min(cap, raw)
}

/**
 * Shrinkage constants: roughly the volume at which a stat is half signal, half
 * noise. A hitter with 90 PA and four homers has not shown you a 40-homer pace,
 * and projecting his raw rate forward is how you end up recommending a hot streak.
 * Values follow the published stabilisation work (Carleton / Tango); anything not
 * listed falls back to DEFAULT_K, which is deliberately heavy because an unlisted
 * stat is one we have no stabilisation evidence for.
 */
/** Rate stats and identifiers: they do not scale with playing time, so they are
 *  skipped rather than multiplied. A Set, because this is tested once per stat per
 *  player per board — an array literal here allocated and scanned 43,000 times. */
const NOT_VOLUME_SCALED = new Set(["avg", "obp", "slg", "ops", "era", "whip", "age", "babip"])

const DEFAULT_K = MODEL.shrinkage.default
const SHRINK_K: Record<string, number> = MODEL.shrinkage.perStat

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
	 * How much to trust recent playing time over season-long.
	 *
	 * Defaults to `recentForm.blend` for the player's own side, which is what every
	 * caller in the app and the simulator passes. It used to default to a separate
	 * `recentForm.volumeWeight: 0.75` knob, and that number had been RETRACTED —
	 * model.json's own `blend` note records 0.75 losing 22.6 points a week over 111
	 * paired weeks. No caller could reach it (all three that supply
	 * `recentVolumePerGame` also supply this weight), so model.json carried a knob
	 * that steered nothing while claiming to steer the recommendation. The knob is
	 * gone and the default is now the shipped value.
	 */
	recentWeight?: number
	/**
	 * How a hitter's playing time is estimated. "blend" is the shipped model;
	 * "state" is the candidate.
	 *
	 * "blend" mixes his season rate with his recent rate. Both terms count team games
	 * he was NOT AVAILABLE FOR — a man who missed six weeks is charged for those
	 * weeks in the season term and, until they age out, in the 21-day term too. The
	 * result is that a returning regular is priced as a part-timer for about a month
	 * after he is back and playing every day.
	 *
	 * The codebase has already found and fixed this exact shape once, for pitchers:
	 * "his starts accrue only over the part of the season he was actually in a
	 * rotation; his club's games count the whole of it. So every pitcher who missed
	 * time reads as a man who rarely starts." That fix has never been applied to
	 * hitters, and this is it.
	 *
	 * "state" splits the estimate into the two independent things it confuses:
	 *   ROLE — plate appearances per game he actually PLAYED. Immune to missed time,
	 *   and it is what "leadoff regular" versus "short side of a platoon" means.
	 *   AVAILABILITY — whether he is in the lineup NOW. A state, not a rate, so it is
	 *   read off the SHORT windows; the fortnight before an activation says nothing
	 *   about tonight.
	 * Volume is their product, capped at his own role because a man cannot bat more
	 * often than he bats when he plays.
	 *
	 * Hitters only. Pitchers already reach their volume through `projectedStarts`,
	 * which had this corrected separately and for the same reason.
	 *
	 * MEASURED, AND IT LOSES. Default stays "blend". Over 111 weeks and five seasons
	 * of actual weekly roster decisions:
	 *
	 *     blend  77,464 pts   vs season-to-date 72/111   vs a thoughtful human 45/111
	 *     state  77,375 pts   vs season-to-date 65/111   vs a thoughtful human 48/111
	 *
	 * and narrowing it to fire in one direction only — the version below, which is
	 * strictly more targeted and leaves 81 more hitters untouched — measured WORSE
	 * again at 77,131 and 65/111. Two variants, both behind.
	 *
	 * The argument for it was good and the case that motivated it was vivid: on the
	 * committed capture the board rated Juan Soto, .944 OPS and freshly back, below a
	 * replacement outfielder purely on the weeks he had missed. The likeliest reading
	 * of the result is that the premise was wrong rather than the arithmetic — a man
	 * back from six weeks out really is eased in, with rest days and a ramp, so
	 * discounting him is not the error it looks like. The vivid case was mine, and it
	 * did not survive contact with five seasons.
	 *
	 * Kept, off, and tested, so that the next person to notice Juan Soto finds this
	 * comment and the two runs in data/results/ instead of writing it again.
	 */
	volumeModel?: "blend" | "state"
	/**
	 * His volume per team game over the SHORT windows only — the last series, not the
	 * last three weeks.
	 *
	 * The state model needs this separately because `recentVolumePerGame` arrives
	 * pre-blended across 3, 7 and 21 days, and the 21-day term is precisely the one
	 * that still contains the absence. Availability is a state; it is read off the
	 * shortest evidence there is.
	 */
	recentShortPerGame?: number | null
	/** The player's own line over the recent window, if known. */
	recentStats?: StatLine | null
	/**
	 * How much to blend the RECENT rate into the season rate. Distinct from
	 * recentWeight, which governs volume only. Defaults to 0 until evidence says
	 * otherwise — a hot fortnight is mostly noise, and the naive baseline already
	 * over-trusts it.
	 */
	recentRateWeight?: number
	/**
	 * Recent-rate weight for a pitcher who mostly relieves.
	 *
	 * A reliever's fantasy value is almost entirely a ROLE — whether he is getting
	 * the ninth inning — and a role changes overnight. Season-long shrinkage treats
	 * a pitcher who has just been handed the job as the middle reliever he was in
	 * April, because saves shrink toward the league rate with a heavy constant. Null
	 * falls back to the shared pitching weight rather than inventing a separate one.
	 */
	reliefRateWeight?: number | null
	/** Overrides for the Statcast formulation, so a sweep can ask the season which
	 *  shape of the adjustment works rather than only how much of one to apply. */
	qualityLambda?: ModelWeights["statcast"]["lambda"]
	qualityScope?: ModelWeights["statcast"]["scope"]
	/**
	 * Strength of the opponents on this player's actual schedule for the horizon,
	 * as a ratio to league average, where >1 means an easier week. Null when the
	 * schedule or the opponent lines were not available — never assumed to be 1.
	 */
	matchupIndex?: number | null
	matchupWeight?: number
	/**
	 * Times this pitcher is actually scheduled to start in the horizon, from MLB's
	 * published probables. Null when unknown — which is different from zero, and is
	 * why an absent value falls back to the team-games estimate rather than
	 * projecting him at nothing.
	 */
	projectedStarts?: number | null
}

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
	hitting: windowsFor("hitting"),
	pitching: windowsFor("pitching")
}

/**
 * The windows that speak to whether a man is playing TONIGHT.
 *
 * The full set above answers "how much has he been playing lately", which is a rate
 * and wants three weeks of evidence. Availability is a state — activated, benched,
 * demoted, hurt — and a state is read off the newest evidence, because the whole
 * point is that it changed. The 21-day window is excluded rather than
 * down-weighted: a man activated eight days ago has an accurate 3- and 7-day
 * record and a 21-day record that is mostly a description of the injured list.
 */
export const SHORT_WINDOW_WEIGHTS: Record<"hitting" | "pitching", Record<number, number>> = {
	hitting: { 3: 2, 7: 1 },
	pitching: { 5: 1 }
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
export const RECENT_BLEND_WEIGHT = MODEL.recentForm.blend

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
export const RECENT_RATE_WEIGHT = MODEL.recentForm.rate

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
	/** Modelled: schedule-strength ratio, 1 = a league-average week of opponents. */
	matchupMultiplier: number
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
		rates,
		qualityWeight = MODEL.statcast.weight,
		recentVolumePerGame = null,
		recentWeight = MODEL.recentForm.blend[player.group],
		recentStats = null,
		recentRateWeight = 0,
		qualityLambda = MODEL.statcast.lambda,
		qualityScope = MODEL.statcast.scope,
		matchupIndex = null,
		matchupWeight = MODEL.matchup.weight,
		projectedStarts = null,
		reliefRateWeight = null,
		volumeModel = "blend",
		recentShortPerGame = null
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
	/**
	 * ROLE x AVAILABILITY, for hitters, when the state model is asked for.
	 *
	 * `role` needs his own games played; without it there is nothing to divide by and
	 * this falls through to the blend rather than guessing. `available` is capped at
	 * 1: a short window can read above his own role (three games batting leadoff in a
	 * high-scoring series), and that is noise, not a man playing more than every day.
	 */
	const gamesPlayed = s.gamesPlayed
	const role =
		isHitter && volume !== undefined && gamesPlayed ? volume / gamesPlayed : null
	/**
	 * ...and it fires in ONE direction only, for a reason the first version got wrong.
	 *
	 * Applied to everybody this moved 245 of 645 hitters by five points or more and
	 * measured WORSE — 77,375 against the blend's 77,464 over 111 weeks, and 65/111
	 * against a season-to-date manager where the blend takes 72. It was not the
	 * targeted correction it was described as. Jonathan Aranda, who had played 136 of
	 * 141 team games, lost 17 points for two quiet days, and there are far more
	 * Arandas than there are men coming off the injured list.
	 *
	 * The case this exists for is asymmetric: an absence that is OVER shows up as a
	 * short window running AHEAD of the season rate. A short window running behind it
	 * is not a returning player, it is a rest day or a slump, and the blend already
	 * handles that — with three weeks of evidence instead of three days. So the state
	 * model may only raise a man toward his own role, never cut him.
	 */
	const stateVolume =
		role !== null &&
		recentShortPerGame !== null &&
		seasonPerTeamGame !== null &&
		recentShortPerGame > seasonPerTeamGame ?
			role * Math.min(1, recentShortPerGame / role)
		:	null
	const volumePerTeamGame =
		volumeModel === "state" && stateVolume !== null ? stateVolume
		: seasonPerTeamGame === null ? null
		: recentVolumePerGame === null ?
			seasonPerTeamGame
		:	(1 - recentWeight) * seasonPerTeamGame + recentWeight * recentVolumePerGame
	/**
	 * A starter's volume comes from his STARTS, not from his team's games, whenever
	 * the starts are actually known. Outs-per-team-game averages a two-start week
	 * and a one-start week into the same projection, and those weeks are worth about
	 * double one another.
	 */
	/**
	 * ...but only where his outs ARE start-outs.
	 *
	 * `s.outs` counts every out he recorded, relief appearances included;
	 * `s.gamesStarted` counts starts only. For a swingman the ratio is a
	 * numerator and a denominator over different populations, and it is inflated
	 * by exactly the relief work it does not divide by. Measured: a reliever with
	 * 63 appearances and one spot start projected 192 outs — 64 innings — for a
	 * single scheduled start, and ranked first on the streaming board at five
	 * times second place. The drill-down printed the impossible number verbatim.
	 *
	 * Below the share bar he falls back to the team-games estimate, which is the
	 * honest answer for a pitcher whose appearances are not starts, and `missing`
	 * says why rather than a number being invented.
	 */
	const startShare = s.gamesPitched ? (s.gamesStarted ?? 0) / s.gamesPitched : 0
	/** The same ratio the rate blend reads, which defaults to 1 rather than 0 where
	 *  appearances are not reported — a hitter, or a pitcher with no games logged,
	 *  must not fall into the mostly-relieving branch. */
	const startShareOrOne = s.gamesPitched ? (s.gamesStarted ?? 0) / s.gamesPitched : 1
	const startsBased =
		!isHitter &&
		projectedStarts !== null &&
		MODEL.probables.use &&
		(s.gamesStarted ?? 0) > 0 &&
		s.outs !== undefined &&
		startShare >= MODEL.probables.minStartShare ?
			(s.outs / s.gamesStarted!) * projectedStarts
		:	null
	// every other precondition passed and only the share bar refused it
	if (
		startsBased === null &&
		!isHitter &&
		projectedStarts !== null &&
		MODEL.probables.use &&
		(s.gamesStarted ?? 0) > 0 &&
		s.outs !== undefined
	)
		missing.push(
			`outs recorded in starts — he relieves too (${s.gamesStarted} of ${s.gamesPitched} ` +
				`appearances were starts), so his season outs divided by his starts is not a ` +
				`per-start rate`
		)
	const projectedVolume =
		startsBased !== null ? startsBased
		: volumePerTeamGame === null ? null
		: volumePerTeamGame * horizonGames
	if (startsBased !== null)
		modelled.push(
			`starts: ${projectedStarts} scheduled × ${(s.outs! / s.gamesStarted!).toFixed(1)} outs per start ` +
				`= ${startsBased.toFixed(1)} outs (from MLB's published probables, not from team games)`
		)
	if (projectedVolume !== null && startsBased === null) {
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
		const lambda = lambdaFor(pa, qualityLambda)
		const blended = underlying.woba + lambda * (underlying.xwoba - underlying.woba)
		// The ratio applies directly for both sides: it scales the events the player
		// produces (hitter) or allows (pitcher). A pitcher whose expected wOBA-against
		// is below his actual has been unlucky, so the ratio is <1 and his projected
		// hits and earned runs come DOWN. (An earlier version inverted this and
		// pushed unlucky pitchers' ER up — exactly backwards.)
		const full = blended / underlying.woba
		qualityMultiplier = clamp(
			1 + qualityWeight * (full - 1),
			MODEL.statcast.clamp.min,
			MODEL.statcast.clamp.max
		)
		if (qualityWeight > 0)
			modelled.push(
				`quality: wOBA ${underlying.woba} → ${blended.toFixed(3)} (λ=${lambda.toFixed(2)} toward xwOBA ${underlying.xwoba}) ⇒ ×${qualityMultiplier.toFixed(3)}`
			)
		else
			// METHODOLOGY 7.1 and model.json's `statcast.why` both record the finished
			// verdict; this string was left saying the re-measurement had not landed
			// yet, months after it did. A drill-down that contradicts the methodology
			// is the same defect as a number that contradicts its source.
			/*
			 * Eighty words became fourteen.
			 *
			 * The retraction is real history and it belongs in METHODOLOGY 7.1, which
			 * holds it in full — the leaked-data result, the re-measurement over 111
			 * paired weeks, the rho 0.102 against 0.058. What it does not belong in is
			 * the drill-down of every row of a ranked table, told to somebody deciding
			 * whether to start a shortstop tonight. The fact he can act on is the whole
			 * of the first clause: the number is shown and it is not used.
			 */
			modelled.push(
				`Statcast weight is 0: xwOBA ${underlying.xwoba} is shown, not applied ` +
					`(METHODOLOGY 7.1)`
			)
	} else missing.push("underlying expected stats")

	/**
	 * Schedule strength: an OBSERVED input turned into a modelled scale. Who a team
	 * plays is a fact; how much that should move a projection is not — so it is
	 * weighted, clamped, and named in `modelled`. A null index means the fact was
	 * unavailable and nothing is applied, which is different from an index of 1
	 * meaning it was available and neutral.
	 */
	let matchupMultiplier = 1
	if (matchupIndex === null) {
		// only a gap if we would have used it — an unused input is not a hole
		if (matchupWeight > 0) missing.push("opponent schedule strength")
	} else if (matchupWeight > 0) {
		matchupMultiplier = clamp(
			1 + matchupWeight * (matchupIndex - 1),
			MODEL.matchup.clamp.min,
			MODEL.matchup.clamp.max
		)
		modelled.push(
			`matchups: opponents this week rate ${matchupIndex.toFixed(3)} vs league ` +
				`⇒ ×${matchupMultiplier.toFixed(3)}`
		)
	}

	const stats: StatLine = {}
	if (projectedVolume !== null && volume) {
		/**
		 * Everything constant across one player's line, hoisted out of the loop.
		 *
		 * This loop is the hot spot of the whole board: ~30 stats x 1,433 players on
		 * every horizon switch, and a CPU profile put 46% of `rateAll` inside
		 * `project` with the two heaviest lines being the loop header itself and the
		 * store below it. Every one of these five values was being recomputed per
		 * stat — including an eight-element array literal allocated and linearly
		 * searched 43,000 times a board, and a two-level lookup into QUALITY_SCALED.
		 * None of them depends on `key`, so none of them belongs in here. Pure
		 * motion: the arithmetic is untouched and the A/B in METHODOLOGY 13 diffs
		 * every rated row of all three horizons, ties included.
		 */
		for (const [key, value] of Object.entries(s)) {
			// rate stats and identifiers don't scale with volume
			if (NOT_VOLUME_SCALED.has(key)) continue
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
			// a mostly-relieving pitcher can be given a different weight than a starter
			const startShare =
				!isHitter && s.gamesPitched ? (s.gamesStarted ?? 0) / s.gamesPitched : 1
			const rateWeight =
				!isHitter && reliefRateWeight !== null && startShare < 0.5 ?
					reliefRateWeight
				:	recentRateWeight
			if (rateWeight > 0 && recentStats) {
				const rv = isHitter ? recentStats.plateAppearances : recentStats.outs
				if (rv && rv > 0) {
					const recentRate = (recentStats[key] ?? 0) / rv
					perUnit = (1 - rateWeight) * perUnit + rateWeight * recentRate
				}
			}
			const scaled =
				QUALITY_SCALED[qualityScope][player.group].has(key) ?
					qualityMultiplier * matchupMultiplier
				:	1
			stats[key] = roundTo(perUnit * projectedVolume * scaled, 3)
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
		matchupMultiplier: Number(matchupMultiplier.toFixed(3)),
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
