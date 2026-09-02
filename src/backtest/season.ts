import { scoreStats } from "../engine/points.ts"
import { matchupIndexFor, teamStrength, type TeamStrength } from "../engine/matchup.ts"
import { MODEL } from "../engine/weights.ts"
import { blendWindows, project, RECENT_BLEND_WEIGHT, RECENT_RATE_WEIGHT, RECENT_WINDOW_WEIGHTS } from "../engine/project.ts"
import type { League } from "../schema.ts"
import type { PlayerSeason, StatLine } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import { aggregateStatcast } from "../data/statcast-window.ts"
import { cachedFetch } from "./cache.ts"
import { addDays, seasonRange } from "./seasons.ts"
import { num, parseCsv } from "../data/csv.ts"

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

const SAPI = "https://statsapi.mlb.com/api/v1"
const SAVANT = "https://baseballsavant.mlb.com/leaderboard/custom"

const asNum = (v: unknown): number | null => {
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
	return Number.isFinite(n) ? n : null
}

const windowStats = async (
	season: number,
	group: "hitting" | "pitching",
	start: string,
	end: string
): Promise<PlayerSeason[]> => {
	const text = await cachedFetch(
		`${SAPI}/stats?stats=byDateRange&group=${group}&season=${season}&sportId=1` +
			`&playerPool=All&limit=3000&startDate=${start}&endDate=${end}`
	)
	return (JSON.parse(text).stats?.[0]?.splits ?? [])
		.map((s: any): PlayerSeason => {
			const stat: Record<string, number> = {}
			for (const [k, v] of Object.entries(s.stat ?? {})) {
				const n = asNum(v)
				if (n !== null) stat[k] = n
			}
			return {
				id: s.player?.id, name: s.player?.fullName ?? "",
				team: s.team?.name ?? null, teamId: s.team?.id ?? null,
				position: s.position?.abbreviation ?? "", group, stats: stat
			}
		})
		.filter((p: PlayerSeason) => typeof p.id === "number")
}

const gamesPlayed = async (start: string, end: string): Promise<Map<number, number>> => {
	const data = JSON.parse(
		await cachedFetch(`${SAPI}/schedule?sportId=1&startDate=${start}&endDate=${end}&gameType=R`)
	)
	const counts = new Map<number, number>()
	for (const day of data.dates ?? [])
		for (const g of day.games ?? []) {
			if (g.status?.abstractGameState && g.status.abstractGameState !== "Final") continue
			for (const side of ["home", "away"] as const) {
				const id = g.teams?.[side]?.team?.id
				if (typeof id === "number") counts.set(id, (counts.get(id) ?? 0) + 1)
			}
		}
	return counts
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

const underlyingWindow = async (
	season: number,
	type: "batter" | "pitcher",
	start: string,
	end: string
): Promise<Map<number, Underlying>> => {
	if (!REAL_STATCAST) return new Map()
	if (REAL_STATCAST) {
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
	const url =
		`${SAVANT}?year=${season}&type=${type}&filter=&min=1` +
		`&selections=pa%2Cwoba%2Cxwoba&chart=false&x=pa&y=pa&r=no&chartType=beeswarm` +
		`&start_dt=${start}&end_dt=${end}&csv=true`
	const out = new Map<number, Underlying>()
	try {
		for (const row of parseCsv(await cachedFetch(url, "text/csv"))) {
			const id = num(row.player_id)
			if (id === null) continue
			const xwoba = num(row.xwoba), woba = num(row.woba)
			out.set(id, {
				id, xwoba, woba,
				xwobaGap: xwoba !== null && woba !== null ? Number((xwoba - woba).toFixed(4)) : null,
				xba: null, xslg: null, pa: num(row.pa),
				barrelRate: null, hardHitRate: null, avgExitVelocity: null, sweetSpotRate: null
			})
		}
	} catch {
		/* a missing Savant window degrades the projection, it doesn't stop the season */
	}
	return out
}

/**
 * Who each team is actually booked against over a window, from the same cached
 * schedule call the game counts come from.
 */
const opponentsOf = async (start: string, end: string): Promise<Map<number, number[]>> => {
	const data = JSON.parse(
		await cachedFetch(`${SAPI}/schedule?sportId=1&startDate=${start}&endDate=${end}&gameType=R`)
	)
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
		s => s !== "BN" && s !== "IL" && s !== "NA"
	)

const slotsFor = (p: PlayerSeason): string[] => {
	if (p.group === "pitching") return (p.stats.gamesStarted ?? 0) > 0 ? ["SP", "P"] : ["RP", "P"]
	const pos = p.position
	if (["LF", "CF", "RF", "OF"].includes(pos)) return ["OF", "Util"]
	if (pos === "DH") return ["Util"]
	if (["C", "1B", "2B", "3B", "SS"].includes(pos)) return [pos, "Util"]
	return ["Util"]
}

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

export type Strategy = {
	name: string
	rank: (ctx: Context) => { p: PlayerSeason; score: number }[]
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
	} = {}
): Strategy => ({
	name,
	rank: ctx =>
		ctx.prior
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
					// default to what model.json ships, so the regression test measures the
					// model the app actually runs; a sweep overrides explicitly
					qualityWeight: opts.qualityWeight ?? MODEL.statcast.weight,
					qualityLambda: opts.qualityLambda,
					qualityScope: opts.qualityScope,
					matchupWeight: opts.matchupWeight ?? MODEL.matchup.weight,
					matchupIndex: matchupIndexFor(p, ctx.oppAhead, ctx.strength),
					recentVolumePerGame: blendWindows(perWindow, RECENT_WINDOW_WEIGHTS[p.group]),
					recentWeight: opts.recentWeight ?? RECENT_BLEND_WEIGHT[p.group],
					recentStats: ctx.recent[21]?.find(r => r.id === p.id)?.stats ?? null,
					recentRateWeight: opts.rateWeight ?? RECENT_RATE_WEIGHT[p.group],
					reliefRateWeight: opts.reliefRateWeight ?? null
				})
				const points = scoreStats(proj.stats, tableFor(ctx.league, p.group), p.group).points
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
})

/**
 * Turns projected points into points ABOVE REPLACEMENT, which is what bscore
 * actually means. Ranking a waiver decision by raw points ignores the thing the
 * whole metric exists for: dropping a replaceable outfielder for a scarce catcher
 * is right even when the catcher scores fewer points.
 */
const applyVorp = (
	ranked: { p: PlayerSeason; score: number }[],
	league: League
): { p: PlayerSeason; score: number }[] => {
	const teams = league.meta.max_teams ?? 10
	const replacement = new Map<string, number>()
	for (const [slot, count] of Object.entries(league.roster.slots)) {
		if (slot === "BN" || slot === "IL" || slot === "NA") continue
		const eligible = ranked.filter(r => slotsFor(r.p).includes(slot))
		const depth = Math.min(teams * count, Math.max(eligible.length - 1, 0))
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
			return { p: r.p, score: best === -Infinity ? r.score : best }
		})
		.sort((a, b) => b.score - a.score)
}

/** Projected points only — retained as the control, to show what the replacement
 *  adjustment is worth. */
export const projectedPointsStrategy = makeBscoreStrategy("projected-points")

/**
 * bscore as the app actually defines it: points above the replacement at the
 * player's slot. Ranking a waiver decision by raw points ignores the thing the
 * metric exists for, and over 68 weeks it costs 269 points and six weekly wins.
 */
export const bscoreStrategy: Strategy = {
	name: "bscore",
	rank: ctx => applyVorp(makeBscoreStrategy("_").rank(ctx), ctx.league)
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
	rank: ctx => applyVorp(makeBscoreStrategy("_").rank(ctx), ctx.league)
}

export const STRATEGIES = [
	bscoreStrategy, projectedPointsStrategy, seasonToDateStrategy, hotHandStrategy,
	sharpHotHandStrategy, humanStrategy, draftAndHoldStrategy
]

type VariantOpts = Parameters<typeof makeBscoreStrategy>[1]

const vorpVariant = (name: string, opts: VariantOpts): Strategy => ({
	name,
	rank: ctx => applyVorp(makeBscoreStrategy("_", opts).rank(ctx), ctx.league)
})

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
	options: { movesPerWeek: number; warmupDays: number; swapMargin?: number } = {
		movesPerWeek: 2,
		warmupDays: 28
	}
): Promise<{ results: SeasonResult[]; oracle: number; weeks: string[] }> => {
	const range = await seasonRange(season)
	const weeks: { start: string; end: string }[] = []
	let cursor = addDays(range.start, options.warmupDays)
	while (Date.parse(addDays(cursor, 7)) <= Date.parse(range.end)) {
		weeks.push({ start: cursor, end: addDays(cursor, 6) })
		cursor = addDays(cursor, 7)
	}

	const slots = ACTIVE_SLOTS(league)
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
			gamesPlayed(range.start, priorEnd),
			gamesPlayed(week.start, week.end),
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
				gamesPlayed(s, priorEnd)
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
			const ranked = strategy.rank(ctx)
			const held = rosters.get(strategy.name)
			if (!held) {
				rosters.set(strategy.name, fillRoster(ranked, slots))
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
					const replacement = ranked.find(
						r => !heldIds.has(r.p.id) && slotsFor(r.p).includes(out.slot)
					)
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
			const scored = roster.reduce(
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
