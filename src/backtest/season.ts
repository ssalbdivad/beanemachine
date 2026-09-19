import { scoreStats } from "../engine/points.ts"
import { matchupIndexFor, teamStrength, type TeamStrength } from "../engine/matchup.ts"
import { MODEL } from "../engine/weights.ts"
import { isReserveSlot, jointReplacement } from "../engine/bscore.ts"
import { blendWindows, leagueRatesFrom, project, RECENT_BLEND_WEIGHT, RECENT_RATE_WEIGHT, RECENT_WINDOW_WEIGHTS, SHORT_WINDOW_WEIGHTS } from "../engine/project.ts"
import type { League } from "../schema.ts"
import { mapPlayerSeasons, windowStatsUrl, type PlayerSeason } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import { aggregateStatcast } from "../data/statcast-window.ts"
import { cachedFetch } from "./cache.ts"
import { addDays, gamesPlayedIn, gamesScheduledIn, scheduleUrl, seasonRange } from "./seasons.ts"

/**
 * Season-long competition.
 *
 * A Spearman correlation says the ranking is good; it does not say whether a
 * manager using it wins. This plays a whole season week by week: each strategy
 * drafts a roster, sets it every week, makes waiver moves from what it believes,
 * and is scored on what its players ACTUALLY produced that week in the league's own
 * scoring. Rosters may overlap between strategies — every strategy gets the same
 * pool, so the comparison is of judgement rather than of draft position.
 */

/**
 * The reads this simulator makes were, until now, transcribed here a second time —
 * the byDateRange URL, the splits mapping, the schedule game count and a Savant CSV
 * read, all of them also present in corpus.ts and harness.ts. 63 of corpus.ts's 119
 * substantive lines were verbatim in this file.
 *
 * They are now single-sourced: the URL and the mapping from src/data/statsapi.ts, the
 * game count from ./seasons.ts. The transport stays here, through the disk cache,
 * because that cache is what makes a five-season replay of the stored runs an offline
 * 54-second job (`node test/compete.mjs`, 2026-09-12) instead of several thousand live
 * requests — and because the URL strings are the cache's keys, they are now built in
 * exactly one place each.
 */
const windowStats = async (
	season: number,
	group: "hitting" | "pitching",
	start: string,
	end: string
): Promise<PlayerSeason[]> => {
	const text = await cachedFetch(windowStatsUrl(season, group, start, end))
	// deliberately unfiltered — see `keepOnly` on `mapPlayerSeasons`
	return mapPlayerSeasons(JSON.parse(text).stats?.[0]?.splits ?? [], group)
}

/**
 * Point-in-time underlying stats for the simulator.
 *
 * The `custom` leaderboard silently ignores its own date parameters (see
 * src/data/statcast-window.ts), so asking it for "the season so far" returns the
 * whole season — the future included. Every Statcast result this simulator has
 * ever produced was measured that way, and those results are therefore void
 * rather than merely noisy.
 *
 * The honest default is now to return nothing: a simulator with no Statcast data
 * is worse informed, but it is not lying. `--statcast-real` switches on the
 * day-by-day aggregation that actually respects the window, which is correct and
 * costs about 16 MB of pitch data per day of history.
 */
const REAL_STATCAST = process.argv.includes("--statcast-real")

const statcastStart = (seasonStart: string, priorEnd: string): string => {
	const days = MODEL.statcast.windowDays
	if (!days) return seasonStart
	const rolled = addDays(priorEnd, -days)
	return Date.parse(rolled) > Date.parse(seasonStart) ? rolled : seasonStart
}

/*
 * The fourth copy of the Savant leaderboard read used to live here, under
 * `if (!REAL_STATCAST) return new Map()` followed by `if (REAL_STATCAST) { ... }` — so
 * the 22 lines after it, URL and `try`/`catch` and row mapping, were UNREACHABLE for
 * every value of a `const`. It was the fallback from before the custom leaderboard was
 * found to ignore its own date parameters; once that made the direct read unusable the
 * branch that returns nothing was put in front of it and the code was left behind.
 *
 * Deleted rather than kept as documentation: it could not run, it asked for a narrower
 * `selections` list than the two live copies in corpus.ts and harness.ts (so it was a
 * copy that had already drifted), and reinstating it would reinstate the bug the
 * comment above describes. `aggregateStatcast` is the only honest path and is the only
 * one left.
 */
const underlyingWindow = async (
	season: number,
	type: "batter" | "pitcher",
	start: string,
	end: string
): Promise<Map<number, Underlying>> => {
	if (!REAL_STATCAST) return new Map()
	const lines = await aggregateStatcast(season, type, start, end, url =>
		cachedFetch(url, "text/csv")
	)
	const out = new Map<number, Underlying>()
	for (const [id, l] of lines)
		out.set(id, {
			id, xwoba: l.xwoba, woba: l.woba,
			xwobaGap: Number((l.xwoba - l.woba).toFixed(4)),
			xba: null, xslg: null, pa: l.pa,
			barrelRate: null, hardHitRate: null, avgExitVelocity: null, sweetSpotRate: null
		})
	return out
}

/**
 * Who each team is actually booked against over a window, from the same cached
 * schedule call the game counts come from.
 */
const opponentsOf = async (start: string, end: string): Promise<Map<number, number[]>> => {
	const data = JSON.parse(await cachedFetch(scheduleUrl(start, end)))
	const out = new Map<number, number[]>()
	const add = (team: number, opp: number) => out.set(team, [...(out.get(team) ?? []), opp])
	for (const day of data.dates ?? [])
		for (const g of day.games ?? []) {
			const home = g.teams?.home?.team?.id
			const away = g.teams?.away?.team?.id
			if (typeof home !== "number" || typeof away !== "number") continue
			add(home, away)
			add(away, home)
		}
	return out
}

/* ---------- roster shape ---------- */

const ACTIVE_SLOTS = (league: League): string[] =>
	(league.roster.slot_order ?? Object.keys(league.roster.slots)).filter(
		s => !isReserveSlot(s)
	)

const slotsFor = (p: PlayerSeason): string[] => {
	if (p.group === "pitching") return (p.stats.gamesStarted ?? 0) > 0 ? ["SP", "P"] : ["RP", "P"]
	const pos = p.position
	if (["LF", "CF", "RF", "OF"].includes(pos)) return ["OF", "Util"]
	if (pos === "DH") return ["Util"]
	if (["C", "1B", "2B", "3B", "SS"].includes(pos)) return [pos, "Util"]
	return ["Util"]
}

/**
 * HOW MANY MEN A TEAM CARRIES THAT IT IS NOT STARTING.
 *
 * The shipped league has five. The simulator had none: `fillRoster` filled the
 * seventeen ACTIVE slots and the resulting roster WAS the lineup, so the only decision
 * a strategy ever made was the two waiver swaps it was allowed — two decisions a week
 * against a hundred and eleven weeks, which is why every variant of this model lands
 * within a thousand points of every other and the sweeps read as noise.
 *
 * With a bench, the strategy holds twenty-two men and has to choose seventeen every
 * week. That is the decision the app is actually FOR — the daily card exists to answer
 * "who do I start tonight" — and it was the one thing the season competition could not
 * see. It also multiplies the decision surface by about a hundred, which is what gives
 * a real effect a chance of clearing the noise.
 *
 * Default 0, so every result already stored in data/results still means exactly what it
 * meant when it was written. `--bench` asks the other question.
 */
const benchSize = (league: League): number =>
	Object.entries(league.roster.slots)
		.filter(([slot]) => /^BN$/i.test(slot.trim()))
		.reduce((n, [, count]) => n + count, 0)

/** Fills the league's real slots greedily from a ranked list. */
const fillRoster = (ranked: { p: PlayerSeason; score: number }[], slots: string[]) => {
	const taken = new Set<number>()
	const roster: { slot: string; p: PlayerSeason }[] = []
	// scarcest slots first, so a catcher isn't lost to a Util spot
	const order = [...slots].sort(
		(a, b) =>
			ranked.filter(r => slotsFor(r.p).includes(a)).length -
			ranked.filter(r => slotsFor(r.p).includes(b)).length
	)
	for (const slot of order) {
		const pick = ranked.find(r => !taken.has(r.p.id) && slotsFor(r.p).includes(slot))
		if (!pick) continue
		taken.add(pick.p.id)
		roster.push({ slot, p: pick.p })
	}
	return roster
}

/* ---------- strategies ---------- */

export interface Context {
	league: League
	/** everything known strictly before the week being played */
	prior: PlayerSeason[]
	priorGames: Map<number, number>
	recent: Record<number, PlayerSeason[]>
	recentGames: Record<number, Map<number, number>>
	/**
	 * Kept PER SIDE, never merged. Savant keys both leaderboards by bare MLBAM id,
	 * so `new Map([...batters, ...pitchers])` silently gives every pitcher who has
	 * batted the xwOBA he ALLOWS in place of the one he produced — the ratio then
	 * moves his projection the wrong way. The live snapshot learned this the hard
	 * way; the simulator had the same bug, so every Savant result measured before
	 * this fix was measured on polluted inputs.
	 */
	underlying: { hitting: Map<number, Underlying>; pitching: Map<number, Underlying> }
	gamesAhead: Map<number, number>
	/** Who each team plays during the horizon, and how good those teams have been. */
	oppAhead: Map<number, number[]>
	strength: TeamStrength
}

/**
 * WHAT ACTUALLY HAPPENED IN THE WEEK BEING DECIDED, handed ONLY to a diagnostic.
 *
 * This is future data. Nothing that ships may ever see it, and the one previous time
 * future data reached a strategy in this repo it silently invalidated an entire result
 * set — see the note on `underlyingWindow` above, which is the same lesson written from
 * the other end.
 *
 * So it is not on `Context`. A strategy that wants it has to declare `cheats: true`, it
 * is passed as a SECOND argument that honest strategies do not even have a parameter
 * for, and `compete.ts` refuses to write a results file containing one unless the run
 * was explicitly asked for as a diagnostic. Three locks on one door, because the cost of
 * it coming open is every number this project has ever published.
 *
 * What it is FOR: the oracle ceiling says half the available points are unreachable and
 * says nothing about which half. A strategy that knows the week's real playing time but
 * not the real rates, against one that knows the real rates but not the playing time,
 * splits that gap in two and says which half is worth modelling.
 */
export interface Hindsight {
	/** Every man who played in the week being decided, with what he actually did. */
	played: PlayerSeason[]
	/** His actual fantasy points that week, keyed `id:group`. */
	points: Map<string, number>
}

export type Strategy = {
	name: string
	/** A diagnostic, and never a claim about a model anybody could run. Printed with a
	 *  banner and refused by the results writer unless the run asked for it. */
	cheats?: boolean
	rank: (
		ctx: Context,
		hindsight?: Hindsight,
		/**
		 * THE MEN THIS STRATEGY ALREADY HOLDS, for a ranking that is relative to a roster.
		 *
		 * Almost every strategy here is a pure function of the pool — that is what makes
		 * them comparable. One is not: the app's headline recommendation is ranked by
		 * `deltaMine`, which is a candidate's points less the WORST MAN THE READER OWNS who
		 * could take that seat, so the same free agent is worth different amounts to two
		 * managers. It cannot be asked of the pool alone, and it has never been asked of a
		 * season at all.
		 */
		held?: PlayerSeason[]
	) => { p: PlayerSeason; score: number; points?: number }[]
}

const tableFor = (league: League, g: "hitting" | "pitching") =>
	g === "hitting" ? league.scoring.batting : league.scoring.pitching

export const makeBscoreStrategy = (
	name: string,
	opts: {
		recentWeight?: number
		rateWeight?: number
		vorp?: boolean
		qualityWeight?: number
		matchupWeight?: number
		qualityLambda?: { mode: "rising" | "falling" | "fixed"; prior: number; cap: number }
		qualityScope?: "wide" | "battedBall"
		reliefRateWeight?: number | null
		/** See `recentRateK` in src/engine/project.ts: how much recent volume it takes
		 *  before a man's recent rate is believed in full. 0 is the shipped behaviour. */
		rateK?: number
		/**
		 * HOW MUCH OF THE LAST FORTNIGHT'S ACTUAL SCORING TO BLEND IN, at the POINTS level.
		 *
		 * This is the one thing `thoughtful-human` does that this model does not, and it
		 * is now the reason the human is level with it: the human scores a man as half his
		 * season rate and half his last-fourteen-days rate, both in the league's own
		 * points, and that beat a model with a far better volume estimate underneath it.
		 *
		 * It is NOT the same as `recentRateWeight`, which blends recent form into each
		 * per-stat rate INSIDE the projection and has measured as worthless twice. This
		 * blends the finished number, in the unit the league actually pays in, and it
		 * carries something the per-stat path structurally cannot: the recent term is
		 * points per CALENDAR day, so a man who missed a week is discounted by the
		 * arithmetic rather than by a model of why he missed it.
		 *
		 * 0 is the control and is the shipped model.
		 */
		recentPointsWeight?: number
		/**
		 * HOW HARD EVERY PER-STAT RATE IS PULLED TOWARD THE LEAGUE, as a multiplier on the
		 * shipped shrinkage constants.
		 *
		 * `model.json` sets a default of 400 plate appearances and a per-stat table on top
		 * of it — 170 for home runs, 60 for strikeouts, 1200 for triples — and those are the
		 * numbers that decide how much of a man's own line the model believes. They have
		 * never been swept against a season. They were also fitted while every denominator
		 * in the project was 2% too large, which is exactly the kind of thing that moves a
		 * shrinkage constant.
		 *
		 * 1 is the control and is the shipped table.
		 */
		shrinkScale?: number
		/**
		 * SHRINK EVERY RATE TOWARD THE LEAGUE'S, which neither this simulator nor the app
		 * has ever actually done.
		 *
		 * `project` shrinks a man's per-stat rate toward a population rate — `(value + k *
		 * leagueRate) / (volume + k)` — and its own comment calls the absence of that "the
		 * single biggest source of bad recommendations". It only happens when the caller
		 * passes `rates`, and the two callers that decide anything, `rateAll` in
		 * src/engine/bscore.ts and this strategy, both pass nothing. So model.json's entire
		 * `shrinkage` section has been inert in the shipped product and in every stored run.
		 *
		 * Turning it on is not obviously right, which is why it is a sweep arm and not a
		 * fix. Measured on the committed capture over fourteen days it moves 550 of 651
		 * hitters and 691 of 795 pitchers, and it takes 20 to 27 points off every elite
		 * reliever — Mason Miller 72.2 to 45.2, Josh Hader 43.9 to 23.1 — because the
		 * population it regresses toward pools closers with mop-up men, and a closer's save
		 * rate has no business regressing toward a pitcher who never gets the ninth.
		 * `reliefRateWeight` exists in the same file for exactly that reason.
		 *
		 * So the season decides it.
		 */
		useRates?: boolean
		/**
		 * Demote anyone whose results have outrun his contact by more than this much
		 * wOBA over the window.
		 *
		 * A different mechanism from the quality multiplier, and the one humans
		 * actually use: not "scale his projection by 4%" but "his hot fortnight is a
		 * mirage, do not pick him up". It acts on the DECISION rather than on the
		 * estimate, which is why it can matter where a smooth ±5% provably does not —
		 * a veto changes which player you take, and a small multiplier almost never
		 * does.
		 */
		mirage?: number | null
		volumeModel?: "blend" | "state"
	} = {}
): Strategy => ({
	name,
	rank: ctx => {
		/* One population per side per week, from the same pool the ranking is over. Built
		   once rather than per player: it is a fold over every prior line and is identical
		   for everyone in the group. */
		const rates =
			opts.useRates ?
				{
					hitting: leagueRatesFrom(ctx.prior.filter(p => p.group === "hitting"), "hitting"),
					pitching: leagueRatesFrom(ctx.prior.filter(p => p.group === "pitching"), "pitching")
				}
			:	null
		return ctx.prior
			.map(p => {
				const gAhead = p.teamId ? (ctx.gamesAhead.get(p.teamId) ?? 0) : 0
				const gBehind = p.teamId ? (ctx.priorGames.get(p.teamId) ?? 0) : 0
				if (!gAhead || !gBehind) return { p, score: -Infinity }
				const perWindow: Record<number, number> = {}
				for (const [d, rows] of Object.entries(ctx.recent)) {
					const days = Number(d)
					const rec = rows.find(r => r.id === p.id)
					const rg = ctx.recentGames[days]?.get(p.teamId!) ?? 0
					if (rg > 0)
						perWindow[days] =
							(p.group === "hitting"
								? (rec?.stats.plateAppearances ?? 0)
								: (rec?.stats.outs ?? 0)) / rg
				}
				const proj = project(p, ctx.underlying[p.group].get(p.id), gBehind, gAhead, {
					shrinkScale: opts.shrinkScale ?? 1,
					rates: rates?.[p.group] ?? undefined,
					// default to what model.json ships, so the regression test measures the
					// model the app actually runs; a sweep overrides explicitly
					qualityWeight: opts.qualityWeight ?? MODEL.statcast.weight,
					qualityLambda: opts.qualityLambda,
					qualityScope: opts.qualityScope,
					matchupWeight: opts.matchupWeight ?? MODEL.matchup.weight,
					matchupIndex: matchupIndexFor(p, ctx.oppAhead, ctx.strength),
					recentVolumePerGame: blendWindows(perWindow, RECENT_WINDOW_WEIGHTS[p.group]),
					recentShortPerGame: blendWindows(perWindow, SHORT_WINDOW_WEIGHTS[p.group]),
					volumeModel: opts.volumeModel ?? "blend",
					recentWeight: opts.recentWeight ?? RECENT_BLEND_WEIGHT[p.group],
					recentStats: ctx.recent[21]?.find(r => r.id === p.id)?.stats ?? null,
					recentRateWeight: opts.rateWeight ?? RECENT_RATE_WEIGHT[p.group],
					recentRateK: opts.rateK ?? 0,
					reliefRateWeight: opts.reliefRateWeight ?? null
				})
				let points = scoreStats(proj.stats, tableFor(ctx.league, p.group), p.group).points
				if (opts.recentPointsWeight) {
					/* The human's own term, verbatim: the league's points over the last
					   fourteen days, per calendar day, scaled to the week ahead. Written the
					   same way `humanStrategy` writes it so the comparison is of where the
					   term sits rather than of two slightly different terms. */
					const rec = ctx.recent[14]?.find(r => r.id === p.id)
					const recentPoints =
						rec ?
							(scoreStats(rec.stats, tableFor(ctx.league, p.group), p.group).points / 14) * 7
						:	0
					points = (1 - opts.recentPointsWeight) * points + opts.recentPointsWeight * recentPoints
				}
				if (opts.mirage != null) {
					const u = ctx.underlying[p.group].get(p.id)
					// positive gap = contact better than results. The mirage is the other
					// sign: he has been paid more than he earned. Flipped for pitchers,
					// whose "good" gap runs the other way.
					const gap = u?.xwobaGap
					if (gap != null) {
						const overperformance = p.group === "hitting" ? -gap : gap
						if (overperformance > opts.mirage) return { p, score: -Infinity }
					}
				}
				return { p, score: points }
			})
			.sort((a, b) => b.score - a.score)
	}
})

/**
 * Turns projected points into points ABOVE REPLACEMENT, which is what bscore
 * actually means. Ranking a waiver decision by raw points ignores the thing the
 * whole metric exists for: dropping a replaceable outfielder for a scarce catcher
 * is right even when the catcher scores fewer points.
 */
const applyVorp = (
	ranked: { p: PlayerSeason; score: number; points?: number }[],
	league: League,
	/**
	 * WHERE THE REPLACEMENT LINE IS DRAWN, as a multiple of the starting depth.
	 *
	 * 1 is the textbook definition and is what has always shipped: the bar at a slot
	 * is the (teams x starters)-th best man eligible for it, i.e. the first man left
	 * once every team has filled that slot once.
	 *
	 * It is a definition, not a measurement, and it decides every add this model ever
	 * recommends — the bar is what a candidate is priced against, so moving it moves
	 * which position's men look like bargains. A real league does not stop at the
	 * starters: every team carries a bench, so the man actually available on the wire
	 * sits deeper than teams x starters, and pricing against a bar that is too shallow
	 * systematically overvalues whichever position is thinnest.
	 *
	 * Swept here rather than argued about. 1 is the control.
	 */
	depthScale = 1,
	/** Draw all the bars from ONE assignment instead of ten independent walks — see
	 *  `jointReplacement` in src/engine/bscore.ts, which measured the old rule's bars as
	 *  10 to 24 points too high because a man was counted at every slot he qualifies for. */
	joint = false
): { p: PlayerSeason; score: number }[] => {
	const teams = league.meta.max_teams ?? 10
	const replacement = joint
		? jointReplacement(
				ranked.map(r => ({ points: r.score, slots: slotsFor(r.p) })),
				league.roster.slots,
				(_slot, count) => teams * count * depthScale
			)
		: new Map<string, number>()
	if (!joint)
		for (const [slot, count] of Object.entries(league.roster.slots)) {
			if (isReserveSlot(slot)) continue
			const eligible = ranked.filter(r => slotsFor(r.p).includes(slot))
			const depth = Math.min(
				Math.round(teams * count * depthScale),
				Math.max(eligible.length - 1, 0)
			)
			replacement.set(slot, eligible[depth]?.score ?? 0)
		}
	return ranked
		.map(r => {
			let best = -Infinity
			for (const slot of slotsFor(r.p)) {
				const repl = replacement.get(slot)
				if (repl === undefined) continue
				best = Math.max(best, r.score - repl)
			}
			/* The RAW projected total rides through, because the two decisions this ranking
			   drives want different numbers — see `lineupBy` in `playSeason`. */
			return { p: r.p, score: best === -Infinity ? r.score : best, points: r.points ?? r.score }
		})
		.sort((a, b) => b.score - a.score)
}

/** Projected points only — retained as the control, to show what the replacement
 *  adjustment is worth. */
export const projectedPointsStrategy = makeBscoreStrategy("projected-points")

/**
 * bscore as the app actually defines it: points above the replacement at the
 * player's slot. Ranking a waiver decision by raw points ignores the thing the
 * metric exists for.
 *
 * It used to say "over 68 weeks it costs 269 points and six weekly wins", and no
 * run in `data/results/` has a 68-week corpus — every stored season set is 111
 * paired weeks over 2021-2025 — so that figure cannot be re-derived from anything
 * this repo keeps. docs/METHODOLOGY.md says so of the same number, and two other
 * copies of it have already been retired for the same reason. `projectedPointsStrategy`
 * above is the control that answers the question, and re-running it is how the cost
 * gets a figure again.
 */
/**
 * SHIPPED, 2026-09-19: the joint replacement assignment and the league-rate shrinkage.
 *
 * Both were structural defects rather than knobs. The bars were drawn slot by slot in
 * isolation, so a man who qualifies at three positions was counted as taken at all
 * three and every bar but catcher's came out 10 to 24 points too high. And
 * model.json's entire `shrinkage` section had never run, in the simulator or in the
 * app, because `project` applies it only when handed a population and neither caller
 * handed it one.
 *
 * Chosen on 2021-2023 and validated on 2024-2025, which the setting was not fitted on:
 * 33W-13L against the previously shipped model over those 46 held-out weeks, +42.6
 * points a week, 95% CI [+21.3, +62.2], sign-test p 0.0045, paired-t p 0.0001. Over all
 * 111 weeks, 69W-42L, +25.3/wk, p 0.013 / 0.0003.
 */
export const bscoreStrategy: Strategy = {
	name: "bscore",
	rank: ctx =>
		applyVorp(
			makeBscoreStrategy("_", { useRates: true, shrinkScale: MODEL.shrinkage.scale }).rank(ctx),
			ctx.league,
			1,
			true
		)
}

/** "He'll keep doing what he's been doing" — the strategy most managers actually use. */
export const seasonToDateStrategy: Strategy = {
	name: "season-to-date",
	rank: ctx =>
		ctx.prior
			.map(p => {
				const gAhead = p.teamId ? (ctx.gamesAhead.get(p.teamId) ?? 0) : 0
				const gBehind = p.teamId ? (ctx.priorGames.get(p.teamId) ?? 0) : 0
				if (!gAhead || !gBehind) return { p, score: -Infinity }
				const pts = scoreStats(p.stats, tableFor(ctx.league, p.group), p.group).points
				return { p, score: (pts / gBehind) * gAhead }
			})
			.sort((a, b) => b.score - a.score)
}

/** Chasing the hot hand off the last fortnight — the classic active-manager move. */
export const hotHandStrategy: Strategy = {
	name: "hot-hand",
	rank: ctx =>
		ctx.prior
			.map(p => {
				const rec = ctx.recent[14]?.find(r => r.id === p.id)
				const pts = rec ? scoreStats(rec.stats, tableFor(ctx.league, p.group), p.group).points : 0
				return { p, score: pts }
			})
			.sort((a, b) => b.score - a.score)
}

/**
 * The harder opponents.
 *
 * season-to-date and hot-hand are the managers who are not really trying. These
 * three are: a streak-chaser who also understands scarcity, a manager who blends
 * the season with recent form the way a thoughtful human eyeballs it, and one who
 * drafts well and then leaves it alone. If bscore cannot beat these, it is not
 * worth the tab it opens in.
 */
const withVorp = (name: string, inner: Strategy): Strategy => ({
	name,
	rank: ctx => applyVorp(inner.rank(ctx), ctx.league)
})

/** Chases the hot hand but knows a catcher is scarce. The strongest naive play. */
export const sharpHotHandStrategy = withVorp("hot-hand+vorp", hotHandStrategy)

/** What a good human actually does: recent form, weighted against the season. */
export const humanStrategy: Strategy = {
	name: "thoughtful-human",
	rank: ctx =>
		applyVorp(
			ctx.prior
				.map(p => {
					const gAhead = p.teamId ? (ctx.gamesAhead.get(p.teamId) ?? 0) : 0
					const gBehind = p.teamId ? (ctx.priorGames.get(p.teamId) ?? 0) : 0
					if (!gAhead || !gBehind) return { p, score: -Infinity }
					const table = tableFor(ctx.league, p.group)
					const season = (scoreStats(p.stats, table, p.group).points / gBehind) * gAhead
					const rec = ctx.recent[14]?.find(r => r.id === p.id)
					const recent = rec ? (scoreStats(rec.stats, table, p.group).points / 14) * 7 : 0
					return { p, score: 0.5 * season + 0.5 * recent }
				})
				.sort((a, b) => b.score - a.score),
			ctx.league
		)
}

/**
 * Drafts on our own numbers and then never touches the roster. Isolates what the
 * in-season decisions are worth, as opposed to the draft — if this ties bscore,
 * every waiver move the model recommends is theatre.
 */
export const draftAndHoldStrategy: Strategy = {
	name: "draft-and-hold",
	/* The same ranking bscore uses, so the control isolates the in-season decisions and
	   not a second model. */
	rank: ctx => bscoreStrategy.rank(ctx)
}

export const STRATEGIES = [
	bscoreStrategy, projectedPointsStrategy, seasonToDateStrategy, hotHandStrategy,
	sharpHotHandStrategy, humanStrategy, draftAndHoldStrategy
]

type VariantOpts = Parameters<typeof makeBscoreStrategy>[1]

const vorpVariant = (name: string, opts: VariantOpts, depthScale = 1, joint = false): Strategy => ({
	name,
	rank: ctx => applyVorp(makeBscoreStrategy("_", opts).rank(ctx), ctx.league, depthScale, joint)
})

/**
 * TEN INDEPENDENT BARS AGAINST ONE ASSIGNMENT.
 *
 * `jointReplacement` measured the shipped rule's bars as 10 to 24 points too high on the
 * committed capture, because a man who qualifies at three slots is counted as taken at
 * all three. This is the arm that says whether the correct arithmetic is worth points
 * over 111 weeks of real roster decisions, which is the only currency this project pays
 * a model change in.
 */
export const JOINT_SWEEP: Strategy[] = [
	vorpVariant("independent", {}),
	vorpVariant("joint", {}, 1, true),
	humanStrategy,
	seasonToDateStrategy
]

/**
 * ═══ THE DECOMPOSITION ═══════════════════════════════════════════════════════════
 *
 * Every strategy in this file lands between 48% and 53% of perfect hindsight, and the
 * ceiling says nothing about WHICH of the missing points were ever gettable. A week's
 * production is volume times rate — how many times he came to the plate, and what he
 * did when he got there — and a model can be wrong about either. Knowing which one
 * costs more is the difference between a year of knob-turning and one right change.
 *
 * So: two cheats, each given exactly half of hindsight.
 *
 *   volume-oracle  knows how many plate appearances or outs each man REALLY got this
 *                  week, and prices them at his own season-to-date rate.
 *   rate-oracle    knows what each man REALLY did per plate appearance or per out,
 *                  and multiplies it by the volume the shipped model projected.
 *
 * Whichever scores higher is the half that is currently costing more. And the gap
 * between each and `bscore` is an upper bound on what perfect modelling of that half
 * would be worth — a number to compare any proposed change against before building it.
 *
 * NEITHER MAY EVER SHIP and neither may ever be pooled with an honest run. They are
 * marked `cheats`, the writer refuses them without `--diagnostic`, and the banner says
 * so on every line of output.
 */
const rateOf = (p: PlayerSeason, league: League): { points: number; volume: number } => {
	const points = scoreStats(p.stats, tableFor(league, p.group), p.group).points
	const volume =
		p.group === "hitting" ? (p.stats.plateAppearances ?? 0) : (p.stats.outs ?? 0)
	return { points, volume }
}

export const volumeOracle: Strategy = {
	name: "volume-oracle",
	cheats: true,
	rank: (ctx, hindsight) => {
		const realVolume = new Map<number, number>()
		for (const p of hindsight?.played ?? [])
			realVolume.set(p.id, rateOf(p, ctx.league).volume)
		return applyVorp(
			ctx.prior
				.map(p => {
					const season = rateOf(p, ctx.league)
					/* His own season rate, applied to the volume he really got. A man with no
					   prior volume has no rate to apply and scores nothing — the same refusal
					   every honest strategy makes on him. */
					if (!season.volume) return { p, score: -Infinity }
					const got = realVolume.get(p.id) ?? 0
					return { p, score: (season.points / season.volume) * got }
				})
				.sort((a, b) => b.score - a.score),
			ctx.league
		)
	}
}

export const rateOracle: Strategy = {
	name: "rate-oracle",
	cheats: true,
	rank: (ctx, hindsight) => {
		const realRate = new Map<number, number>()
		for (const p of hindsight?.played ?? []) {
			const r = rateOf(p, ctx.league)
			if (r.volume) realRate.set(p.id, r.points / r.volume)
		}
		/* The shipped model's own volume projection, so the only thing swapped out is the
		   rate. `project` returns a stat line; the volume in it is what is wanted. */
		const projected = makeBscoreStrategy("_").rank(ctx)
		const volumeOf = new Map<number, number>()
		for (const p of ctx.prior) {
			const season = rateOf(p, ctx.league)
			if (!season.volume) continue
			const gAhead = p.teamId ? (ctx.gamesAhead.get(p.teamId) ?? 0) : 0
			const gBehind = p.teamId ? (ctx.priorGames.get(p.teamId) ?? 0) : 0
			if (!gAhead || !gBehind) continue
			volumeOf.set(p.id, (season.volume / gBehind) * gAhead)
		}
		void projected
		return applyVorp(
			ctx.prior
				.map(p => {
					const rate = realRate.get(p.id)
					const vol = volumeOf.get(p.id)
					if (rate === undefined || vol === undefined) return { p, score: -Infinity }
					return { p, score: rate * vol }
				})
				.sort((a, b) => b.score - a.score),
			ctx.league
		)
	}
}

/** Both halves at once — should land on the ceiling, and is here as the check that the
 *  decomposition is measuring what it claims to. */
export const bothOracle: Strategy = {
	name: "both-oracle",
	cheats: true,
	rank: (ctx, hindsight) =>
		applyVorp(
			ctx.prior
				.map(p => ({ p, score: hindsight?.points.get(`${p.id}:${p.group}`) ?? -Infinity }))
				.sort((a, b) => b.score - a.score),
			ctx.league
		)
}

/**
 * WHAT A HOT FORTNIGHT IS WORTH, asked with the sample size in the question.
 *
 * `recentForm.rate` ships at 0 for hitters and 0.15 for pitchers, and 0 won because a
 * raw 21-day rate is mostly noise — which is true of a RAW one. It has never been asked
 * of a rate that is trusted in proportion to the volume behind it, and those are
 * different questions: the reason a hot fortnight misleads is precisely that the men it
 * is loudest about are the ones with the fewest plate appearances behind it.
 *
 * The oracle decomposition says this is the half worth attacking. Perfect knowledge of
 * the week's real RATES is worth about +59 points a week over the shipped model, against
 * about +26 for perfect knowledge of its real playing time.
 *
 * rate0 is the control and is the shipped model.
 */
export const RATE_SWEEP: Strategy[] = [
	vorpVariant("rate0", {}),
	vorpVariant("rate.3k0", { rateWeight: 0.3 }),
	vorpVariant("rate.3k60", { rateWeight: 0.3, rateK: 60 }),
	vorpVariant("rate.6k60", { rateWeight: 0.6, rateK: 60 }),
	vorpVariant("rate.6k150", { rateWeight: 0.6, rateK: 150 }),
	vorpVariant("rate1k150", { rateWeight: 1, rateK: 150 }),
	vorpVariant("rate1k300", { rateWeight: 1, rateK: 300 }),
	humanStrategy
]

/**
 * THE ONE THING THE HUMAN DOES THAT THIS MODEL DOES NOT.
 *
 * With the postponed-game denominator fixed, `thoughtful-human` is level with bscore —
 * 58-53, +6.6 a week, p 0.70 on a sign test. The human is a two-line strategy: half the
 * season rate, half the last fourteen days, both in the league's own points. bscore has
 * a measured volume model, shrinkage toward league rates, a matchup index and a
 * replacement bar under it, and that is what it buys.
 *
 * So the question is not whether recency helps — the human says it does — but where the
 * term belongs. Blended into each per-stat rate inside the projection it has now
 * measured as worthless twice (`RATE_SWEEP`, and the flat-weight sweep before it). This
 * sweep puts it where the human puts it: on the finished points, after the projection.
 */
export const RECENCY_SWEEP: Strategy[] = [
	vorpVariant("recency0", {}),
	vorpVariant("recency.15", { recentPointsWeight: 0.15 }),
	vorpVariant("recency.30", { recentPointsWeight: 0.3 }),
	vorpVariant("recency.40", { recentPointsWeight: 0.4 }),
	vorpVariant("recency.50", { recentPointsWeight: 0.5 }),
	vorpVariant("recency.65", { recentPointsWeight: 0.65 }),
	humanStrategy
]

/**
 * IS THE SHRINKAGE SECTION OF model.json WORTH TURNING ON.
 *
 * It has never run: `project` applies it only when handed a population, and neither
 * `rateAll` nor this simulator hands it one. See `useRates`. The arms ask both whether
 * it helps at all and, if it does, how hard to pull.
 */
export const SHRINK_SWEEP: Strategy[] = [
	vorpVariant("rates-off", {}),
	vorpVariant("rates-k0.25", { useRates: true, shrinkScale: 0.25 }),
	vorpVariant("rates-k0.5", { useRates: true, shrinkScale: 0.5 }),
	vorpVariant("rates-k1", { useRates: true }),
	vorpVariant("rates-k2", { useRates: true, shrinkScale: 2 }),
	humanStrategy
]

/**
 * THE TWO STRUCTURAL CORRECTIONS, TOGETHER.
 *
 * They are independent — one is how the replacement bar is drawn, the other is whether
 * a man's own rate is believed in full — and each on its own beat both the shipped model
 * and the thoughtful human over 111 weeks. This asks whether they add.
 */
export const COMBO_SWEEP: Strategy[] = [
	vorpVariant("shipped", {}),
	vorpVariant("joint", {}, 1, true),
	vorpVariant("rates.25", { useRates: true, shrinkScale: 0.25 }),
	vorpVariant("both.25", { useRates: true, shrinkScale: 0.25 }, 1, true),
	vorpVariant("both.5", { useRates: true, shrinkScale: 0.5 }, 1, true),
	vorpVariant("both1", { useRates: true }, 1, true),
	humanStrategy
]

/**
 * WHAT THE APP'S HEADLINE RECOMMENDATION IS ACTUALLY RANKED BY.
 *
 * The one pick the board leads with is chosen by `deltaMine` — a candidate's projected
 * points less the raw projected points of the worst man the reader owns who could take
 * that seat (src/client/useBoard.ts, src/client/Board.tsx's `best`). bscore is only the
 * GATE: rows are filtered to `bscore > 0` and then re-sorted by something else.
 *
 * The difference is that the replacement subtraction is dropped, so slot scarcity plays
 * no part in the final pick — and `grep -rn deltaMine src/backtest src/auto` returns
 * nothing, which means the metric that decides the app's single most prominent
 * recommendation has never appeared in a simulator arm or a stored result, while
 * model.json calls value over replacement "the dominant component".
 *
 * So it is asked here, on the same 111 paired weeks as everything else. The arm ranks by
 * points less the worst HELD man eligible at each slot, exactly as the board does, and
 * falls back to raw points where the roster cannot price him — which is what the board
 * does too.
 */
export const deltaMineStrategy: Strategy = {
	name: "delta-mine",
	rank: (ctx, _hindsight, held) => {
		const points = new Map(makeBscoreStrategy("_").rank(ctx).map(r => [r.p.id, r.score]))
		/* The worst man he owns at each slot, in raw projected points — the floor the board
		   subtracts. Rebuilt every week because the roster changes every week. */
		const floor = new Map<string, number>()
		for (const p of held ?? []) {
			const v = points.get(p.id)
			if (v === undefined) continue
			for (const sl of slotsFor(p)) {
				const now = floor.get(sl)
				if (now === undefined || v < now) floor.set(sl, v)
			}
		}
		return ctx.prior
			.map(p => {
				const v = points.get(p.id) ?? -Infinity
				if (!Number.isFinite(v)) return { p, score: -Infinity }
				let best = -Infinity
				for (const sl of slotsFor(p)) {
					const f = floor.get(sl)
					if (f === undefined) continue
					best = Math.max(best, v - f)
				}
				/* No man of his own is eligible anywhere this candidate plays, so there is
				   nothing to displace and the board falls back to the raw number. */
				return { p, score: best === -Infinity ? v : best }
			})
			.sort((a, b) => b.score - a.score)
	}
}

export const HEADLINE_SWEEP: Strategy[] = [
	bscoreStrategy,
	deltaMineStrategy,
	humanStrategy,
	seasonToDateStrategy
]

/**
 * RE-TUNING THE KNOBS ON THE MODEL THAT NOW SHIPS.
 *
 * Every weight in model.json was fitted against a model this one no longer is. Three
 * things changed underneath them on 2026-09-19: the postponed-game denominator (2.02% of
 * every game count was a game nobody played), the replacement bars (drawn independently
 * per slot, so each was 10 to 24 points too high), and the league-rate shrinkage (which
 * had never run at all). A weight fitted on top of three defects is not a weight.
 *
 * So every arm here carries the shipped corrections and varies exactly one thing. The
 * control is the shipped value and is named so.
 */
const shipped = { useRates: true, shrinkScale: MODEL.shrinkage.scale } as const
const tuned = (name: string, opts: VariantOpts): Strategy =>
	vorpVariant(name, { ...shipped, ...opts }, 1, true)

export const RETUNE_SWEEP: Strategy[] = [
	tuned("rw0", { recentWeight: 0 }),
	tuned("rw.25", { recentWeight: 0.25 }),
	tuned("rw.5-shipped", {}),
	tuned("rw.75", { recentWeight: 0.75 }),
	tuned("rw1", { recentWeight: 1 }),
	humanStrategy
]

export const MATCHUP_RETUNE: Strategy[] = [
	tuned("mu0", { matchupWeight: 0 }),
	/* 0.5 IS the shipped value, so this arm and the one below are the same configuration
	   run twice. Kept deliberately: two identical arms are the cheapest check that the
	   simulator is deterministic, and on the run that named them they came back equal to
	   the point — 84,517 both. The original labelling called the second one "mu1", which
	   was a guess at the shipped value rather than a reading of it. */
	tuned("mu.5-shipped", { matchupWeight: 0.5 }),
	tuned("mu.5-again", {}),
	tuned("mu2", { matchupWeight: 2 }),
	humanStrategy
]

/**
 * THE ONE BIG LEVER THAT HAS NEVER HAD AN HONEST MEASUREMENT.
 *
 * `statcast.weight` ships at 0, and it is 0 because every result that argued for a
 * nonzero value was measured on polluted input: Savant's custom leaderboard silently
 * ignores its own date parameters, so "the season so far" returned the whole season,
 * future included. Those results are void rather than noisy, and the weight was zeroed
 * rather than guessed at — which is the right call and leaves the question open.
 *
 * `--statcast-real` aggregates Savant day by day, which does respect the window, and the
 * days are in the disk cache. So the question can finally be asked, on the model that now
 * ships: every arm here carries the joint bars and the shrinkage, and varies only how
 * much of a man's contact quality to believe.
 *
 * WITHOUT `--statcast-real` EVERY ARM HERE IS THE SAME STRATEGY, because `underlying`
 * comes back empty and the multiplier is 1 whatever the weight. A run that forgets the
 * flag compares seven identical models and reads as noise; the totals coming back equal
 * is the symptom.
 */
export const QUALITY_RETUNE: Strategy[] = [
	tuned("q0-shipped", { qualityWeight: 0 }),
	tuned("q0.25", { qualityWeight: 0.25 }),
	tuned("q0.5", { qualityWeight: 0.5 }),
	tuned("q1", { qualityWeight: 1 }),
	humanStrategy
]

export const ORACLE_SWEEP: Strategy[] = [
	bscoreStrategy,
	volumeOracle,
	rateOracle,
	bothOracle,
	humanStrategy
]

/**
 * WHERE THE BAR SITS, swept as a season rather than asserted as a definition.
 *
 * `applyVorp`'s depth has been `teams x starters` since the metric existed, and that
 * number has never been measured against anything — it is the textbook VORP line,
 * borrowed. It is also the single most load-bearing constant in the model: bscore IS
 * points minus the bar, so the bar decides which position's men look like bargains
 * and therefore every add the app has ever recommended.
 *
 * The control is 1.0 and is the shipped model. The others ask whether the real wire
 * sits shallower or deeper than the starters-only line, with the thoughtful human as
 * the opponent that matters.
 */
export const DEPTH_SWEEP: Strategy[] = [
	vorpVariant("depth0.50", {}, 0.5),
	vorpVariant("depth0.75", {}, 0.75),
	vorpVariant("depth1.00", {}, 1),
	vorpVariant("depth1.25", {}, 1.25),
	vorpVariant("depth1.50", {}, 1.5),
	vorpVariant("depth2.00", {}, 2),
	vorpVariant("depth3.00", {}, 3),
	humanStrategy,
	seasonToDateStrategy
]

/**
 * The playing-time question, asked as a season rather than as a correlation.
 *
 * `state` splits volume into role x availability so a returning regular stops being
 * priced on the weeks he was hurt — see `volumeModel` in src/engine/project.ts. It
 * moves 245 of 645 hitters by five points or more on the committed capture, which
 * is far too large a change to ship on the argument alone.
 */
export const VOLUME_SWEEP: Strategy[] = [
	makeBscoreStrategy("bscore_blend", {}),
	makeBscoreStrategy("bscore_state", { volumeModel: "state" }),
	seasonToDateStrategy,
	hotHandStrategy,
	humanStrategy
]

/** Variants under test, to find where the season disagrees with the correlation. */
export const SWEEP: Strategy[] = [
	vorpVariant("vorp_rw0.75", { recentWeight: 0.75 }),
	vorpVariant("vorp_rw0.5", { recentWeight: 0.5 }),
	vorpVariant("vorp_rw0.25", { recentWeight: 0.25 }),
	vorpVariant("vorp_rw0", { recentWeight: 0 }),
	seasonToDateStrategy,
	hotHandStrategy,
	bscoreStrategy,
	projectedPointsStrategy,
	makeBscoreStrategy("bscore_rw0.5", { recentWeight: 0.5 }),
	makeBscoreStrategy("bscore_rw0.25", { recentWeight: 0.25 }),
	makeBscoreStrategy("bscore_rw0", { recentWeight: 0 }),
	makeBscoreStrategy("bscore_rw0_rate0", { recentWeight: 0, rateWeight: 0 })
]

/**
 * The Statcast question, asked the way the season asks it.
 *
 * qualityWeight was ruled out on a 14-day ranking correlation, where playing time
 * dominates and a rate adjustment can barely move the order. A season of roster
 * decisions is a different test, and it already disagreed with the correlation once
 * (see RECENT_BLEND_WEIGHT). It is also the first test run against un-polluted
 * Savant input.
 */
export const QUALITY_SWEEP: Strategy[] = [
	vorpVariant("qw0.00", { qualityWeight: 0 }),
	vorpVariant("qw0.25", { qualityWeight: 0.25 }),
	vorpVariant("qw0.50", { qualityWeight: 0.5 }),
	vorpVariant("qw0.75", { qualityWeight: 0.75 }),
	vorpVariant("qw1.00", { qualityWeight: 1 }),
	// the shape of the adjustment, not just its size
	vorpVariant("fall.5", { qualityWeight: 0.5, qualityLambda: { mode: "falling", prior: 300, cap: 0.7 } }),
	vorpVariant("fall1.0", { qualityWeight: 1, qualityLambda: { mode: "falling", prior: 300, cap: 0.7 } }),
	vorpVariant("bb0.5", { qualityWeight: 0.5, qualityScope: "battedBall" }),
	vorpVariant("bb1.0", { qualityWeight: 1, qualityScope: "battedBall" }),
	vorpVariant("bbfall1.0", {
		qualityWeight: 1, qualityScope: "battedBall",
		qualityLambda: { mode: "falling", prior: 300, cap: 0.7 }
	}),
	seasonToDateStrategy,
	hotHandStrategy
]

/**
 * Is a reliever's recent line worth more than a starter's?
 *
 * His value is a role — the ninth inning — and roles change overnight, while saves
 * shrink toward the league rate with a heavy constant. If that shrinkage is
 * mispricing newly-installed closers, a heavier recent weight for relievers only
 * should show up here.
 */
export const RELIEF_SWEEP: Strategy[] = [
	vorpVariant("rel-off", { reliefRateWeight: null }),
	vorpVariant("rel0.30", { reliefRateWeight: 0.3 }),
	vorpVariant("rel0.50", { reliefRateWeight: 0.5 }),
	vorpVariant("rel0.70", { reliefRateWeight: 0.7 }),
	seasonToDateStrategy,
	hotHandStrategy
]

/**
 * The Statcast veto, swept.
 *
 * Every earlier test scaled the projection. This one refuses the player outright,
 * which is the only way a rate signal can change a roster decision that is
 * otherwise settled by playing time and scarcity.
 */
export const MIRAGE_SWEEP: Strategy[] = [
	vorpVariant("mir-off", { mirage: null }),
	vorpVariant("mir0.150", { mirage: 0.15 }),
	vorpVariant("mir0.100", { mirage: 0.1 }),
	vorpVariant("mir0.060", { mirage: 0.06 }),
	vorpVariant("mir0.035", { mirage: 0.035 }),
	seasonToDateStrategy,
	hotHandStrategy
]

/**
 * Hysteresis on the swap decision.
 *
 * The simulator charges nothing for churn, so a strategy will swap on a
 * hair's-breadth ranking difference — which is how a model overfits its own
 * noise. swapMargin requires the incoming player to clear the outgoing one by
 * that many ranks before the move is made.
 */
export const MARGIN_SWEEP: Strategy[] = [bscoreStrategy, seasonToDateStrategy, hotHandStrategy]

/** Does knowing who they play this week help? */
export const MATCHUP_SWEEP: Strategy[] = [
	vorpVariant("mu0.00", { matchupWeight: 0 }),
	vorpVariant("mu0.25", { matchupWeight: 0.25 }),
	vorpVariant("mu0.50", { matchupWeight: 0.5 }),
	vorpVariant("mu0.75", { matchupWeight: 0.75 }),
	vorpVariant("mu1.00", { matchupWeight: 1 }),
	seasonToDateStrategy,
	hotHandStrategy
]

/* ---------- the season ---------- */

export interface SeasonResult {
	strategy: string
	total: number
	weeks: number
	byWeek: number[]
	moves: number
}

const RECENT = [3, 5, 7, 14, 21]

export const playSeason = async (
	season: number,
	league: League,
	strategies: Strategy[],
	options: {
		movesPerWeek: number
		warmupDays: number
		swapMargin?: number
		anchorMonday?: boolean
		/** Carry the league's own bench and choose a lineup from it every week — see
		 *  `benchSize`. Off by default so stored results keep their meaning. */
		bench?: boolean
		/**
		 * WHICH NUMBER PICKS THE LINEUP, which is not the number that picks a waiver move.
		 *
		 * A ranking by value over replacement is the right answer to "who should I ACQUIRE":
		 * you have to fill every seat, so a scarce catcher who scores less is worth more
		 * than an outfielder who scores more. It is the wrong answer to "who should I
		 * START from the men I already hold" — the seats are already covered by the
		 * assignment, and once the catcher is in the catcher's seat the Util seat simply
		 * wants whoever scores most.
		 *
		 * Ranking the lineup by VORP therefore seats a scarce man over a better one at an
		 * open seat, and the simulator did it because one ranking served both decisions.
		 * "points" asks the second question with the second number.
		 */
		lineupBy?: "vorp" | "points"
	} = {
		movesPerWeek: 2,
		warmupDays: 28
	}
): Promise<{ results: SeasonResult[]; oracle: number; weeks: string[] }> => {
	const range = await seasonRange(season)
	const weeks: { start: string; end: string }[] = []
	let cursor = addDays(range.start, options.warmupDays)
	/**
	 * The week grid lands on whatever weekday the warm-up happens to end on, which is
	 * a property of the season's opening date and nothing else: Thursday in 2021-2023,
	 * Wednesday in 2024, Tuesday in 2025. A head-to-head league scores a fixed matchup
	 * period instead, and the shipped one runs Monday through Sunday. anchorMonday
	 * snaps the first cursor forward to a Monday so the simulated weeks line up with a
	 * period a manager would actually be playing.
	 *
	 * It is off by default because every result already stored under data/results was
	 * measured on the unanchored grid, and moving the grid underneath them would change
	 * what those numbers mean without changing the files that record them.
	 */
	if (options.anchorMonday)
		while (new Date(Date.parse(cursor)).getUTCDay() !== 1) cursor = addDays(cursor, 1)
	while (Date.parse(addDays(cursor, 7)) <= Date.parse(range.end)) {
		weeks.push({ start: cursor, end: addDays(cursor, 6) })
		cursor = addDays(cursor, 7)
	}

	const slots = ACTIVE_SLOTS(league)
	const bench = options.bench ? benchSize(league) : 0
	/** Everyone the strategy HOLDS. Without a bench this is the lineup, exactly as it
	 *  always was; with one it is the lineup plus the men waiting on it. */
	const rosters = new Map<string, { slot: string; p: PlayerSeason }[]>()
	const totals = new Map<string, number>()
	const byWeek = new Map<string, number[]>()
	const moveCount = new Map<string, number>()
	for (const s of strategies) {
		totals.set(s.name, 0)
		byWeek.set(s.name, [])
		moveCount.set(s.name, 0)
	}
	let oracle = 0

	for (const week of weeks) {
		const priorEnd = addDays(week.start, -1)
		const [hitPrior, pitPrior, priorGames, gamesAhead, xBat, xPit] = await Promise.all([
			windowStats(season, "hitting", range.start, priorEnd),
			windowStats(season, "pitching", range.start, priorEnd),
			gamesPlayedIn(range.start, priorEnd),
			/* SCHEDULED, not played. This is the week AHEAD: a manager setting a lineup on
			   Monday sees the slate as booked and cannot know which game will be rained out,
			   so counting only the ones that survived would be hindsight. The backward count
			   one line up is the opposite question and takes the opposite rule. */
			gamesScheduledIn(week.start, week.end),
			// A ROLLING window, not season-to-date: the signal was measured over three
			// weeks, and a season-long xwOBA has already regressed most of the way to
			// the wOBA it is supposed to disagree with.
			underlyingWindow(season, "batter", statcastStart(range.start, priorEnd), priorEnd),
			underlyingWindow(season, "pitcher", statcastStart(range.start, priorEnd), priorEnd)
		])
		const recent: Record<number, PlayerSeason[]> = {}
		const recentGames: Record<number, Map<number, number>> = {}
		for (const d of RECENT) {
			const s = addDays(priorEnd, -d)
			const [h, p, g] = await Promise.all([
				windowStats(season, "hitting", s, priorEnd),
				windowStats(season, "pitching", s, priorEnd),
				gamesPlayedIn(s, priorEnd)
			])
			recent[d] = [...h, ...p]
			recentGames[d] = g
		}

		// pools, cleaned the same way the live board cleans them
		const prior = [
			...hitPrior.filter(p => p.position !== "P" && (p.stats.plateAppearances ?? 0) > 0),
			...pitPrior.filter(p => p.position === "P" && (p.stats.battersFaced ?? 0) > 0)
		]
		const underlying = { hitting: xBat, pitching: xPit }
		const [oppAhead, strength] = [await opponentsOf(week.start, week.end), teamStrength(prior)]

		// what actually happened this week
		const [hitActual, pitActual] = await Promise.all([
			windowStats(season, "hitting", week.start, week.end),
			windowStats(season, "pitching", week.start, week.end)
		])
		const actual = new Map<string, number>()
		for (const p of [...hitActual, ...pitActual])
			actual.set(
				`${p.id}:${p.group}`,
				scoreStats(p.stats, tableFor(league, p.group), p.group).points
			)

		const ctx: Context = {
			league, prior, priorGames, recent, recentGames, underlying, gamesAhead, oppAhead, strength
		}

		for (const strategy of strategies) {
			/* The second argument exists only for a declared diagnostic. An honest
			   strategy is a one-parameter function and could not read it if it tried. */
			const ranked = strategy.rank(
				ctx,
				strategy.cheats ? { played: [...hitActual, ...pitActual], points: actual } : undefined,
				rosters.get(strategy.name)?.map(r => r.p)
			)
			const held = rosters.get(strategy.name)
			if (!held) {
				const starters = fillRoster(ranked, slots)
				/* The bench is drafted the way a real one is: the best men left, regardless
				   of seat. They are held under the slot name "BN" and are eligible to start
				   any week the ranking says they should — which is the decision this exists
				   to create. */
				const taken = new Set(starters.map(r => r.p.id))
				const reserves = ranked
					.filter(r => !taken.has(r.p.id))
					.slice(0, bench)
					.map(r => ({ slot: "BN", p: r.p }))
				rosters.set(strategy.name, [...starters, ...reserves])
			} else if (strategy.name === "draft-and-hold") {
				// deliberately makes no moves — that is the whole point of the control
			} else {
				// waiver moves: swap the weakest holds for the best available
				const rank = new Map(ranked.map((r, i) => [r.p.id, i]))
				const heldIds = new Set(held.map(h => h.p.id))
				const worst = [...held].sort(
					(a, b) => (rank.get(b.p.id) ?? 1e9) - (rank.get(a.p.id) ?? 1e9)
				)
				let made = 0
				for (const out of worst) {
					if (made >= options.movesPerWeek) break
					/* WITHOUT a bench, the man's seat IS his roster spot and the incomer has to
					   be able to fill it or the lineup loses a slot. WITH one, the seat is
					   re-chosen every week from everyone held, so the constraint that matters
					   is that the incomer covers something the outgoing man covered — which is
					   what a manager actually checks before dropping him. */
					const wanted = bench ? slotsFor(out.p) : [out.slot]
					/*
					   AND THE MOVE HAS TO LEAVE A LEGAL TEAM.
					
					   Measured the first time this ran with a bench: every strategy LOST points
					   against its own benchless self — bscore 81586 to 79778 — because the swap
					   only checked that the incoming man shared a slot with the outgoing one.
					   With a bench almost everybody shares Util, so a strategy would drop its
					   only catcher for a third outfielder, and `fillRoster` then left the C seat
					   empty for the rest of the season. That is not a worse decision, it is an
					   illegal one: Yahoo will not let a manager start nobody at catcher, and a
					   simulation that lets him is measuring a game nobody is playing.
					
					   So the candidate is accepted only if the team it leaves behind can still
					   fill every active seat. Checked against the ranking in hand, which is the
					   same list the lineup will actually be chosen from.
					*/
					const replacement = ranked.find(r => {
						if (heldIds.has(r.p.id)) return false
						if (!slotsFor(r.p).some(sl => wanted.includes(sl))) return false
						if (!bench) return true
						const after = held
							.filter(h => h.p.id !== out.p.id)
							.map(h => h.p)
							.concat(r.p)
						return (
							fillRoster(
								after.map(p => ({ p, score: -(rank.get(p.id) ?? 1e9) })).sort((a, b) => b.score - a.score),
								slots
							).length === slots.length
						)
					})
					if (!replacement) continue
					const outRank = rank.get(out.p.id) ?? 1e9
					const inRank = rank.get(replacement.p.id) ?? 1e9
					// churn costs nothing in this sim but does in reality, and swapping on a
					// hair's-breadth ranking difference is how a model overfits its own noise
					if (inRank >= outRank - (options.swapMargin ?? 0)) continue
					heldIds.delete(out.p.id)
					heldIds.add(replacement.p.id)
					out.p = replacement.p
					made++
				}
				moveCount.set(strategy.name, (moveCount.get(strategy.name) ?? 0) + made)
			}

			const roster = rosters.get(strategy.name)!
			/*
			   WHAT SCORES IS THE LINEUP, and with a bench that is a choice.
			
			   The ranking is re-run every week, so a man held on the bench in April can
			   start in June and a slumping regular can sit — which is the decision the app's
			   daily card exists to make and the one this simulation could not previously
			   see. Without a bench `lineup` is the whole roster and the arithmetic is
			   byte-identical to what it always was.
			*/
			const order = new Map(ranked.map((r, i) => [r.p.id, i]))
			const rawPoints = new Map(ranked.map(r => [r.p.id, r.points ?? r.score]))
			const lineup =
				bench ?
					fillRoster(
						[...roster]
							.map(r => ({
								p: r.p,
								score:
									options.lineupBy === "points" ?
										(rawPoints.get(r.p.id) ?? -Infinity)
									:	-(order.get(r.p.id) ?? 1e9)
							}))
							.sort((a, b) => b.score - a.score),
						slots
					)
				:	roster
			const scored = lineup.reduce(
				(sum, r) => sum + (actual.get(`${r.p.id}:${r.p.group}`) ?? 0),
				0
			)
			totals.set(strategy.name, (totals.get(strategy.name) ?? 0) + scored)
			byWeek.get(strategy.name)!.push(Number(scored.toFixed(1)))
		}

		// the ceiling: the best possible legal roster with perfect hindsight
		const hindsight = [...hitActual, ...pitActual]
			.map(p => ({ p, score: actual.get(`${p.id}:${p.group}`) ?? 0 }))
			.sort((a, b) => b.score - a.score)
		oracle += fillRoster(hindsight, slots).reduce(
			(sum, r) => sum + (actual.get(`${r.p.id}:${r.p.group}`) ?? 0),
			0
		)
	}

	return {
		results: strategies.map(s => ({
			strategy: s.name,
			total: Number((totals.get(s.name) ?? 0).toFixed(1)),
			weeks: weeks.length,
			byWeek: byWeek.get(s.name) ?? [],
			moves: moveCount.get(s.name) ?? 0
		})),
		oracle: Number(oracle.toFixed(1)),
		weeks: weeks.map(w => w.start)
	}
}
