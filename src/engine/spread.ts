import type { StatLine } from "../data/statsapi.ts"
import { roundTo, scoreStats } from "./points.ts"

/**
 * How WIDE a player's game is, measured — not a point estimate of how good he is.
 *
 * ================================================================================
 * WHY THIS FILE EXISTS, AND WHAT IT REFUSES TO DO
 * ================================================================================
 *
 * A head-to-head manager down by 40 with two days left does not want the best
 * expected line. He wants the one that might explode. A manager up by 40 wants the
 * opposite. Neither wish can be honoured by an engine that only knows a mean, and
 * until this file the engine only knew a mean: `grep -riE 'quantile|sigma|stddev|
 * variance' src/engine` returned nothing.
 *
 * So this module measures the spread. It does NOT rank on it, and the measurements
 * written below are the reason. Every number in this comment was produced by the
 * harness in `test/spread.mjs --measure`, which re-derives all of them from MLB's
 * own day-by-day record; the method is stated with each so it can be checked rather
 * than believed.
 *
 * ================================================================================
 * THE CORPUS
 * ================================================================================
 *
 * Neither figure below comes from data/snapshot.json, and that is worth saying out
 * loud because the snapshot LOOKS like it holds game logs and does not. Its
 * `recentStats` is one AGGREGATE line per pitcher over a 21-day window: 515 lines,
 * 455 of them (88.3%) covering more than one appearance, one covering 11, and zero
 * of them on the hitting side. An aggregate cannot be a distribution — averaging
 * eleven starts into a line destroys exactly the quantity this file exists to
 * measure. test/spread.mjs asserts that absence against the committed capture, so
 * the day this stops being true a test says so.
 *
 * What was used instead: MLB StatsAPI's `byDateRange` with startDate = endDate, one
 * read per calendar day per side, which returns every player's line for that day
 * alone. 2026-03-20 → 2026-09-07 (172 days, 344 reads; stopping the day BEFORE
 * data/snapshot.json's `capturedAt` of 2026-09-08, so nothing here is measured on
 * days the capture had not seen) and 2025-03-20 → 2025-10-01 (196 days, 392 reads)
 * as an independent replicate. 64,027 player-days in 2026 across 1,587 players.
 *
 * Every line is priced through `scoreStats` against league yahoo:228947's own table
 * (R 1.9, 1B 2.6, 2B 5.2, 3B 7.8, HR 10.4, RBI 1.9, SB 4.2, BB 2.6, HBP 2.6; W 8,
 * SV 8, OUT 1, H −1.3, ER −3, BB −1.3, HBP −1.3, K 3), so every point figure here is
 * in that league's points and would be different in another.
 *
 * A day-line, not an appearance-line: 0.57% of day rows (364 of 64,027) carry
 * gamesPlayed > 1 and are a doubleheader scored as one row. Left in, because a
 * doubleheader IS one day of a roster slot, and named here because it is the one
 * place "appearance" and "day" part company.
 *
 * ================================================================================
 * 1. WHAT THE THREE ANIMALS LOOK LIKE  (2026, league 228947's scoring)
 * ================================================================================
 *
 * Across-player medians of each per-player statistic. Minimum sample per player:
 * 20 days for hitters and relievers, 10 for starters.
 *
 *   cohort    players  days ea.   mean  median   p25    p75    p90     sd   sd/mean
 *   hitters     514       88      5.67   4.50   0.00   8.03  14.20   6.31    1.11
 *   SP          149       25     16.69  17.00   6.30  26.90  35.80  15.38    0.92
 *   RP          188       45      3.94   4.03   0.87   7.70  11.07   6.30    1.60
 *   swing       105       38      4.79   5.00   0.80   9.00  13.10   7.31    1.53
 *
 * ("swing" is a pitcher who both starts and relieves — below `START_SHARE` and above
 * zero starts. He is measured and reported and then NOT given his own constants
 * below, because his numbers sit between SP and RP and a fourth set of coefficients
 * fitted to 105 men would be precision this data does not have. `cohortOf` returns
 * him as RP, which is the nearer of the two and is stated rather than hidden.)
 *
 * They are obviously different animals and one model over all three would be a lie:
 * a starter's median day is nearly four times a hitter's and his p90 two and a half
 * times, while a reliever's spread is half again his own mean.
 *
 * The one that surprised: SPREAD DOES NOT SCALE WITH LEVEL FOR PITCHERS. Fitting
 * per-player sd on per-player mean, one row per player, pooled over both seasons:
 *
 *   hitters   sd ≈ 2.626 + 0.648 × mean    R² 0.734   residual rmse 0.75   n 1,052
 *   SP        sd ≈ 15.718 + 0.011 × mean   R² 0.001   residual rmse 2.63   n   311
 *   RP        sd ≈ 6.119 + 0.066 × mean    R² 0.015   residual rmse 1.11   n   400
 *
 * A hitter's spread is three-quarters just his level. An ace and a fifth starter
 * have the SAME per-start spread — about 15.7 points either way — and the slope is
 * 0.011 points of sd per point of mean, which is nothing. That is a real finding and
 * it cuts against the intuition that drove this file: the volatile arm is not a type
 * of pitcher, it is what a start IS.
 *
 * ================================================================================
 * 2. DOES SPREAD VARY ENOUGH BETWEEN EQUALS TO MOVE A DECISION?  MOSTLY NO.
 * ================================================================================
 *
 * This is the question that decides whether the file is worth anything, and the
 * answer is much weaker than the premise assumed. Three tests, all of them run.
 *
 * (a) THE RANGE IS REAL TO LOOK AT AND NOT REAL TO ACT ON. Take the 32 starters
 * projected 15–18 points per start in 2026. Their measured p90s run 26.1 to 41.9 —
 * exactly the "one man p90 14 and the other 26" that would make a lever. It is a
 * mirage. Pool those 32 pitchers' 773 start-days, deal them back out at random
 * keeping each man's start count, and recompute: 4,000 such shuffles produce a
 * between-player dispersion of p90 of 4.46 on average against the 3.93 actually
 * observed — the real players are LESS varied than chance, p 0.86. Every band tested
 * says the same:
 *
 *   cohort, level band     players   observed sd of p90   chance alone      p
 *   SP 15–18                  32           3.93              4.46          0.86
 *   SP 10–13                  23           4.68              4.79          0.57
 *   SP 20–24                  23           4.94              4.94          0.50
 *   hitters 5.0–6.5          139           1.73              2.17          1.00
 *   hitters 7.0–9.0          116           1.87              1.83          0.40
 *   RP 3.5–4.5                43           1.68              1.72          0.60
 *   RP 5.0–7.0                32           1.45              1.54          0.67
 *
 * Nothing survives. A measured p90 gap between two players at the same level is a
 * small-sample artefact, and that is why NO FUNCTION BELOW COMPARES TWO p90s.
 *
 * The same shuffle on the standard deviation does find something, and it is small:
 * observed exceeds chance in six of the seven bands, p 0.012–0.09 individually. So
 * the sd carries a signal the p90 does not, which makes sense — a quantile spends
 * its whole sample on one order statistic and an sd uses every game.
 *
 * (b) IT REPLICATES, WEAKLY, IN TWO SEASONS. Split each player's days alternately
 * (1st, 3rd, 5th … against 2nd, 4th, 6th …, so a mid-season role change lands in
 * both halves rather than defining one), residualise each half's sd on that half's
 * own mean so only "wider than his level implies" is left, and correlate:
 *
 *   cohort    2025 half-to-half r        2026 half-to-half r
 *   hitters     0.208 (p < 0.001)          0.172 (p < 0.001)
 *   SP          0.174 (p 0.049)            0.130 (p 0.135 on the F test)
 *   RP          0.144 (p 0.063)            0.124 (p 0.139 on the F test)
 *
 * Six of six cohort-seasons positive (sign test p 0.016), no single one of them
 * commanding. Spearman-Brown to a whole season: reliability 0.22–0.34. Which is
 * where `RELIABILITY_K` below comes from, and it is why a measured spread is shrunk
 * here rather than used as measured.
 *
 * Across seasons rather than within one, the same residual correlates 0.200 for
 * hitters (n 391, p < 0.001) and 0.323 for relievers (n 97, p 0.001) — and −0.228
 * for starters (n 80, p 0.042), which is NOT evidence that wide starters become
 * narrow ones. That sign is unstable: it goes to −0.172 at a 20-start minimum and
 * −0.178 at 25, −0.188 by Spearman, and turns POSITIVE (+0.226) if the level is
 * controlled as sd/mean instead of by regression. A coefficient whose sign depends
 * on the control is a coefficient with nothing in it. The honest statement is that
 * for starters there is no year-to-year spread signal here in either direction.
 *
 * (c) THE ONLY TEST THAT MATTERS COMES BACK NULL. Rank players on half A by how much
 * wider they are than their level implies; then, on the half that ranking never saw,
 * count the days that actually cleared a bar. Both seasons pooled, level held fixed
 * by splitting each cohort into six bins of half-A level and taking terciles inside
 * each bin:
 *
 *   bar: a day of 10+ points        widest third   narrowest third   difference
 *   hitters (29,582 days)              21.03%           22.02%        −0.99pp  p 0.038
 *   SP      ( 2,161 days)              65.92%           67.40%        −1.48pp  p 0.47
 *   RP      ( 5,186 days)              21.16%           16.12%        +5.04pp  p 3e-6
 *
 *   bar: a day of 20+ points
 *   hitters                             5.51%            5.58%        −0.07pp  p 0.79
 *   SP                                 45.81%           46.01%        −0.20pp  p 0.93
 *   RP                                  1.15%            0.82%        +0.33pp  p 0.23
 *
 * For hitters the wide third is WORSE at the bar, and for starters it is a coin. The
 * reliever result is the only positive one, and two things shrink it. First, it is
 * partly level: matched on half-A mean, the wide third of relievers comes out 0.42
 * points per day HIGHER in the other half (the wide man's half-A mean was measured
 * with more noise, so a level bin does not fully level him), and a point of level is
 * worth 4.48pp at this bar, so about 1.9 of the 5.04pp is level wearing a disguise.
 * Second, the whole remaining gap is worth about 1.1 points of projected level — so
 * a manager who gives up more than one point of projection to get the wider reliever
 * has paid too much. At the 20-point bar, which is what a 40-point deficit over two
 * days actually demands, there is nothing anywhere.
 *
 * It is NOT the save. A save is 8 points in this league and arrives in a lump, so
 * the obvious explanation for a wide reliever is that he is the closer. He is not:
 * the widest third of relievers averages FEWER saves-plus-holds than the narrowest
 * (14.0 against 15.0 in 2026, 15.9 against 17.1 in 2025).
 *
 * ================================================================================
 * WHAT THAT LICENSES, AND WHAT IT FORBIDS
 * ================================================================================
 *
 * Licensed: saying how wide a cohort is (section 1 is measured, large-sample and
 * not in dispute); saying how wide ONE player has been, with the error bar; saying
 * that two particular players' measured spreads differ by more than their sampling
 * error, when they do.
 *
 * Forbidden, and the module is shaped so it cannot be done by accident: reordering a
 * board by spread, comparing two p90s, or treating a measured spread as a forecast.
 * `spreadOf` returns no score and nothing here consumes a board, a bscore or a
 * ranking; `separates` is the only comparison offered and it is deliberately about
 * the MEASUREMENTS rather than about the players.
 */

export type Cohort = "hitters" | "SP" | "RP"

/**
 * The share of appearances made as starts above which a pitcher is measured as a
 * starter.
 *
 * 0.8, which is also `model.json`'s `probables.minStartShare` — and deliberately not
 * imported from it, because that constant answers a different question (when is
 * outs-per-start a usable rate) and the two are free to move apart. It is repeated
 * here with its own reason: the measurement above split pitchers this way, so the
 * fitted coefficients below belong to this rule and no other. A pitcher with some
 * starts and a share under 0.8 was measured as his own "swing" cohort (105 men, 2026,
 * median sd 7.31) and is returned here as RP, the nearer of the two he sits between.
 */
export const START_SHARE = 0.8

/**
 * Fewest appearances before a summary is returned at all.
 *
 * 10, and the reason is the p90 rather than the sd. At n = 10 the 90th percentile by
 * the interpolation below is the 9th of 10 sorted values — one game, wearing the name
 * of a quantile — and at n = 5 it is a blend of the top two. The sd survives smaller
 * samples better but is not worth reporting alone. Below this `spreadOf` returns
 * null rather than a summary nobody should read; callers that need the arithmetic on
 * a shorter run (the fixture assertions in test/spread.mjs) pass `minimum`
 * explicitly, which is a decision taken in the open.
 *
 * This is NOT the sample at which a spread becomes usable. That is `RELIABILITY_K`,
 * and it is an order of magnitude larger.
 */
export const MINIMUM_APPEARANCES = 10

/**
 * sd ≈ intercept + slope × mean, per cohort. Pooled 2025 + 2026, one row per player,
 * least squares. See section 1 above for R² and residual rmse.
 *
 * The slopes are the finding: 0.648 for hitters, 0.011 for starters, 0.066 for
 * relievers. A hitter's spread is mostly his level; a pitcher's is mostly his job.
 */
export const LEVEL_FIT: Record<Cohort, { intercept: number; slope: number; r2: number }> = {
	hitters: { intercept: 2.626, slope: 0.648, r2: 0.734 },
	SP: { intercept: 15.718, slope: 0.011, r2: 0.001 },
	RP: { intercept: 6.119, slope: 0.066, r2: 0.015 }
}

/**
 * Appearances at which a measured spread is half signal and half sample.
 *
 * From the split-half correlations in section 2(b): Spearman-Brown the half-to-half
 * r up to the full sample (r_full = 2r / (1 + r)), then solve n / (n + k) = r_full at
 * the median sample the halves came from. The two seasons are averaged.
 *
 *   hitters   2025 k 194, 2026 k 226  →  210
 *   SP        2025 k  71, 2026 k  87  →   79
 *   RP        2025 k 166, 2026 k 177  →  171
 *
 * These are brutal numbers and they are the honest ones. A hitter who has played a
 * full season — call it 140 games — has a spread that is 140 / (140 + 210) = 40%
 * signal. A starter with 30 starts is at 28%. Nobody in baseball accumulates enough
 * appearances in one season for his measured spread to be mostly about him, which is
 * the single most important fact in this file and the reason `Spread.shrunkSd` exists
 * beside `Spread.sd` rather than instead of it.
 */
export const RELIABILITY_K: Record<Cohort, number> = { hitters: 210, SP: 79, RP: 171 }

/**
 * The standard error of a measured sd, as a multiple of sd / √n.
 *
 * Measured rather than assumed: 200 bootstrap resamples of each player's OWN game
 * scores, for all 1,763 qualifying player-seasons across 2025 and 2026, taking the sd
 * of the resampled sds. Median of the per-player constants:
 *
 *   hitters 0.979 (quartiles 0.832–1.156)
 *   SP      0.632 (0.555–0.713)
 *   RP      0.810 (0.713–0.931)
 *
 * A Gaussian would give 1/√2 = 0.707 for all three. Hitters are far above it — their
 * day is a mixture of a blank and a home run, and that mixture makes the sd itself
 * harder to pin down than a bell curve would. Starters are BELOW it, which is the
 * quiet surprise: a start is the most nearly normal thing in this data.
 *
 * Using the median of the per-player constants, not the mean, because the per-player
 * distribution is right-skewed and a mean would make every error bar wider than most
 * players deserve.
 */
export const SAMPLING_ERROR: Record<Cohort, number> = { hitters: 0.979, SP: 0.632, RP: 0.810 }

/**
 * The cohort medians from section 1, exported so a caller can say what NORMAL looks
 * like rather than inventing one. 2026 only — the 2025 corpus is a replicate for the
 * correlations above and mixing two seasons' medians would describe neither.
 *
 * These are the numbers a card can honestly use, because they rest on hundreds of
 * players rather than on one man's twenty-five starts.
 */
export const COHORT_SHAPE: Record<Cohort | "swing", {
	players: number; appearances: number
	mean: number; median: number; p25: number; p75: number; p90: number; sd: number
}> = {
	hitters: { players: 514, appearances: 88, mean: 5.67, median: 4.5, p25: 0, p75: 8.03, p90: 14.2, sd: 6.31 },
	SP: { players: 149, appearances: 25, mean: 16.69, median: 17, p25: 6.3, p75: 26.9, p90: 35.8, sd: 15.38 },
	RP: { players: 188, appearances: 45, mean: 3.94, median: 4.03, p25: 0.87, p75: 7.7, p90: 11.07, sd: 6.3 },
	swing: { players: 105, appearances: 38, mean: 4.79, median: 5, p25: 0.8, p75: 9, p90: 13.1, sd: 7.31 }
}

export interface Spread {
	cohort: Cohort
	/** How many game lines this was measured on. Everything else is only as good. */
	appearances: number
	mean: number
	median: number
	p25: number
	p75: number
	p90: number
	sd: number
	/**
	 * sd ÷ mean. Null, never a number, when the mean is at or below zero — which a
	 * relief pitcher's really can be in this league (H −1.3, ER −3, BB −1.3 against
	 * OUT 1 and K 3 is a losing table for a man having a bad month), and dividing by
	 * it would produce a ratio whose sign flips on a rounding error.
	 */
	relative: number | null
	/** What `LEVEL_FIT` says a player of this cohort at this mean usually spreads. */
	expected: number
	/**
	 * `appearances / (appearances + RELIABILITY_K[cohort])` — the share of the gap
	 * between measured and expected that the split-half test says is about the player.
	 * Read it as a discount, and read section 2(b) before trusting it at all.
	 */
	reliability: number
	/**
	 * The measured sd pulled back toward `expected` by `reliability`. This, not `sd`,
	 * is the number to use anywhere a comparison is being made — and section 2(c) says
	 * the comparison should not be steering a ranking even so.
	 */
	shrunkSd: number
	/** One standard error of `sd`, from `SAMPLING_ERROR`. An error bar, not a range. */
	error: number
}

/**
 * The 90th percentile the way R's default (type 7) and numpy's default compute it:
 * linear interpolation between the two order statistics that straddle (n − 1) × p.
 *
 * Stated because there are nine of these and they disagree by a point or more on the
 * sample sizes here — a starter with 25 starts has his p90 land between his 3rd and
 * 4th best, and the seven definitions that apply a continuity correction put it in a
 * different place. Every figure in the comment above uses this one, so any assertion
 * that re-derives them has to use it too.
 */
const quantile = (sorted: readonly number[], p: number): number => {
	const h = (sorted.length - 1) * p
	const lo = Math.floor(h)
	const hi = Math.ceil(h)
	// `!` rather than `?? 0`, and the difference is not cosmetic: both indices are in
	// range for any non-empty array and 0 <= p <= 1, and the only caller has already
	// refused anything shorter than two. A `?? 0` here would invent a zero-point game
	// out of an index bug and quietly drag every quantile down instead of throwing.
	return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!)
}

/** Sample standard deviation, n − 1. Needs two points; one point has no spread. */
const stdev = (xs: readonly number[], mean: number): number => {
	if (xs.length < 2) return 0
	let ss = 0
	for (const x of xs) ss += (x - mean) ** 2
	return Math.sqrt(ss / (xs.length - 1))
}

/**
 * Which animal a set of game lines belongs to.
 *
 * Summed across the lines rather than counted line by line, because a doubleheader
 * arrives as one row with gamesPlayed 2, and a pitcher who started both would read as
 * one start out of one appearance either way — but a man who started one and relieved
 * in the other would not. 0.57% of rows, and this is the only place the difference
 * could bite.
 */
export const cohortOf = (lines: readonly StatLine[], group: "hitting" | "pitching"): Cohort => {
	if (group === "hitting") return "hitters"
	let played = 0
	let started = 0
	for (const line of lines) {
		played += line.gamesPlayed ?? 0
		started += line.gamesStarted ?? 0
	}
	return played > 0 && started / played >= START_SHARE ? "SP" : "RP"
}

/**
 * A player's measured spread, in one league's points.
 *
 * Pure: the same lines and the same table give the same answer, and nothing is read
 * from a snapshot, a clock or a board. That is deliberate — the corpus this was
 * measured on is 736 live reads that no test may make, so the module has to be
 * checkable against whatever lines a caller can actually produce.
 *
 * Returns null below `minimum` rather than a summary, because the alternative is a
 * p90 that is one game with a statistician's name on it.
 */
export const spreadOf = (
	lines: readonly StatLine[],
	table: Record<string, number>,
	group: "hitting" | "pitching",
	options: { cohort?: Cohort; minimum?: number } = {}
): Spread | null => {
	const minimum = options.minimum ?? MINIMUM_APPEARANCES
	if (lines.length < minimum || lines.length < 2) return null
	const cohort = options.cohort ?? cohortOf(lines, group)

	const points = lines.map(line => scoreStats(line, table, group).points).sort((a, b) => a - b)
	const mean = points.reduce((a, b) => a + b, 0) / points.length
	const sd = stdev(points, mean)
	const expected = LEVEL_FIT[cohort].intercept + LEVEL_FIT[cohort].slope * mean
	const reliability = points.length / (points.length + RELIABILITY_K[cohort])

	return {
		cohort,
		appearances: points.length,
		mean: roundTo(mean, 2),
		median: roundTo(quantile(points, 0.5), 2),
		p25: roundTo(quantile(points, 0.25), 2),
		p75: roundTo(quantile(points, 0.75), 2),
		p90: roundTo(quantile(points, 0.9), 2),
		sd: roundTo(sd, 2),
		relative: mean > 0 ? roundTo(sd / mean, 3) : null,
		expected: roundTo(expected, 2),
		reliability: roundTo(reliability, 3),
		shrunkSd: roundTo(expected + (sd - expected) * reliability, 2),
		error: roundTo((SAMPLING_ERROR[cohort] * sd) / Math.sqrt(points.length), 2)
	}
}

/**
 * Whether two measured spreads differ by more than the noise in measuring them.
 *
 * Two standard errors on the difference, which for independent measurements is
 * √(errorA² + errorB²) — 1.96 of them, so "separates" means a two-sided 5% test.
 *
 * IT IS ABOUT THE MEASUREMENTS, NOT ABOUT THE PLAYERS, and that distinction is the
 * whole reason it is a separate function rather than a `>` on two `sd` fields.
 * Answering true says the two numbers are further apart than sampling alone
 * explains; it does not say the gap will be there next month, because the split-half
 * reliability in section 2(b) is 0.22–0.34 and the out-of-sample test in 2(c) came
 * back null at every bar that matters. A caller that reads a true here as permission
 * to prefer one player over another has made a claim this file's own measurements
 * do not support.
 *
 * Worked, on the 2026 starters projected 15–18 points a start, so the shape of the
 * answer is on the record: Jared Jones (sd 17.23 over 17 starts) against Brandon
 * Young (sd 11.52 over 24) does NOT separate — a 5.71 gap against a 5.94 threshold,
 * and their p90s, 41.88 and 26.11, are the pair that makes the idea look like a
 * lever in the first place. The band's true extremes do: Gage Jump (sd 20.93, 19)
 * against Zac Thornton (sd 11.26, 12), a 9.67 gap against 7.17. So the test is not
 * vacuous — it is just far stricter than eyeballing two p90s, which is the point.
 *
 * There is no p90 equivalent and there will not be one. Section 2(a) shuffled the
 * days between same-level players 4,000 times and the observed dispersion of p90 was
 * no larger than chance in any of seven bands (p 0.40–1.00).
 */
export const separates = (a: Spread, b: Spread): boolean =>
	Math.abs(a.sd - b.sd) > 1.96 * Math.sqrt(a.error ** 2 + b.error ** 2)
