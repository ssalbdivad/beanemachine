/**
 * MEASUREMENT ONLY — writes nothing into the repo, reads data/backtest-cache offline.
 *
 * THE QUESTION: given a real free-agent list, what is the replacement bar?
 *   A  the (teams x seats)-th man walked DOWN THE WIRE, clamped to its last man  (ships)
 *   B  the wire's BEST man — "the rosters have already run out"                  (proposed)
 *   N  the (teams x seats)-th man walked down the WHOLE POOL — the no-wire simulation,
 *      which is what every run in data/results/ is denominated in.
 *
 * src/backtest/season.ts cannot answer this, because it simulates ONE team against a
 * pool with no other rosters in it: there is no wire, which is exactly why the depth
 * walk exists there as a stand-in for the other nine teams. So this file adds the nine
 * teams. The field is simulated ONCE, independently of us, and every variant of "us"
 * then plays against the identical wire week by week — which is what makes the paired
 * weekly comparison below a paired one.
 *
 * Everything below the FIELD section is copied from src/backtest/season.ts rather than
 * imported, because the pieces it needs (windowStats, fillRoster, slotsFor, applyVorp)
 * are module-private there. `--verify` replays the copy against the real playSeason and
 * asserts week-for-week equality, so the copy is not taken on trust.
 */
import { readFileSync } from "node:fs"
import { scoreStats } from "../../engine/points.ts"
import { matchupIndexFor, teamStrength, type TeamStrength } from "../../engine/matchup.ts"
import { MODEL } from "../../engine/weights.ts"
import { isReserveSlot } from "../../engine/bscore.ts"
import {
	blendWindows, project, RECENT_BLEND_WEIGHT, RECENT_RATE_WEIGHT, RECENT_WINDOW_WEIGHTS,
	SHORT_WINDOW_WEIGHTS
} from "../../engine/project.ts"
import type { League } from "../../schema.ts"
import { mapPlayerSeasons, windowStatsUrl, type PlayerSeason } from "../../data/statsapi.ts"
import { cachedFetch } from "../../backtest/cache.ts"
import { addDays, gamesPlayedIn, scheduleUrl, seasonRange } from "../../backtest/seasons.ts"
import { playSeason, STRATEGIES } from "../../backtest/season.ts"

/** The four bars raced here. See `barTable`. */
const VARIANTS = ["nowire", "depth", "best", "own"] as const
type Variant = (typeof VARIANTS)[number]

/* ---------- copied from src/backtest/season.ts ---------- */

const windowStats = async (
	season: number, group: "hitting" | "pitching", start: string, end: string
): Promise<PlayerSeason[]> => {
	const text = await cachedFetch(windowStatsUrl(season, group, start, end))
	return mapPlayerSeasons(JSON.parse(text).stats?.[0]?.splits ?? [], group)
}

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

const ACTIVE_SLOTS = (l: League): string[] =>
	(l.roster.slot_order ?? Object.keys(l.roster.slots)).filter(s => !isReserveSlot(s))

const slotsFor = (p: PlayerSeason): string[] => {
	if (p.group === "pitching") return (p.stats.gamesStarted ?? 0) > 0 ? ["SP", "P"] : ["RP", "P"]
	const pos = p.position
	if (["LF", "CF", "RF", "OF"].includes(pos)) return ["OF", "Util"]
	if (pos === "DH") return ["Util"]
	if (["C", "1B", "2B", "3B", "SS"].includes(pos)) return [pos, "Util"]
	return ["Util"]
}

const fillRoster = (ranked: { p: PlayerSeason; score: number }[], slots: string[]) => {
	const taken = new Set<number>()
	const roster: { slot: string; p: PlayerSeason }[] = []
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

interface Context {
	league: League
	prior: PlayerSeason[]
	priorGames: Map<number, number>
	recent: Record<number, PlayerSeason[]>
	recentGames: Record<number, Map<number, number>>
	underlying: { hitting: Map<number, any>; pitching: Map<number, any> }
	gamesAhead: Map<number, number>
	oppAhead: Map<number, number[]>
	strength: TeamStrength
}

const tableFor = (l: League, g: "hitting" | "pitching") =>
	g === "hitting" ? l.scoring.batting : l.scoring.pitching

/** The projected-points ranking every bscore variant here is built on. Copied from
 *  `makeBscoreStrategy` with its default (shipped) options. */
const projectedPoints = (ctx: Context): { p: PlayerSeason; score: number }[] =>
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
						(p.group === "hitting" ? (rec?.stats.plateAppearances ?? 0) : (rec?.stats.outs ?? 0)) / rg
			}
			const proj = project(p, ctx.underlying[p.group].get(p.id), gBehind, gAhead, {
				qualityWeight: MODEL.statcast.weight,
				matchupWeight: MODEL.matchup.weight,
				matchupIndex: matchupIndexFor(p, ctx.oppAhead, ctx.strength),
				recentVolumePerGame: blendWindows(perWindow, RECENT_WINDOW_WEIGHTS[p.group]),
				recentShortPerGame: blendWindows(perWindow, SHORT_WINDOW_WEIGHTS[p.group]),
				volumeModel: "blend",
				recentWeight: RECENT_BLEND_WEIGHT[p.group],
				recentStats: ctx.recent[21]?.find(r => r.id === p.id)?.stats ?? null,
				recentRateWeight: RECENT_RATE_WEIGHT[p.group],
				reliefRateWeight: null
			})
			return { p, score: scoreStats(proj.stats, tableFor(ctx.league, p.group), p.group).points }
		})
		.sort((a, b) => b.score - a.score)

const seasonToDate = (ctx: Context) =>
	ctx.prior
		.map(p => {
			const gAhead = p.teamId ? (ctx.gamesAhead.get(p.teamId) ?? 0) : 0
			const gBehind = p.teamId ? (ctx.priorGames.get(p.teamId) ?? 0) : 0
			if (!gAhead || !gBehind) return { p, score: -Infinity }
			const pts = scoreStats(p.stats, tableFor(ctx.league, p.group), p.group).points
			return { p, score: (pts / gBehind) * gAhead }
		})
		.sort((a, b) => b.score - a.score)

const hotHand = (ctx: Context) =>
	ctx.prior
		.map(p => {
			const rec = ctx.recent[14]?.find(r => r.id === p.id)
			const pts = rec ? scoreStats(rec.stats, tableFor(ctx.league, p.group), p.group).points : 0
			return { p, score: pts }
		})
		.sort((a, b) => b.score - a.score)

const human = (ctx: Context) =>
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
		.sort((a, b) => b.score - a.score)

/**
 * The replacement bar, in the three semantics under test.
 *
 * `wire` undefined is the no-wire simulation and reproduces season.ts's `applyVorp`
 * exactly (verified by --verify). Given a wire, "depth" is what src/engine/bscore.ts
 * ships and "best" is the proposal.
 */
const barTable = (
	ranked: { p: PlayerSeason; score: number }[],
	league: League,
	mode: Variant,
	wire?: Set<number>
): Map<string, number> => {
	const teams = league.meta.max_teams ?? 10
	const replacement = new Map<string, number>()
	for (const [slot, count] of Object.entries(league.roster.slots)) {
		if (isReserveSlot(slot)) continue
		const all = ranked.filter(r => slotsFor(r.p).includes(slot) && Number.isFinite(r.score))
		const onWire = mode === "nowire" || !wire ? [] : all.filter(r => wire.has(r.p.id))
		const pool = onWire.length ? onWire : all
		if (!pool.length) { replacement.set(slot, 0); continue }
		// how many men come off this pool before the bar: the whole league's seats when
		// the pool is everybody, and — the question — what it should be once the wire has
		// already had nine rosters taken out of it
		const want =
			mode === "nowire" || !onWire.length ? teams * count
			: mode === "best" ? 0
			: mode === "own" ? count
			: teams * count
		replacement.set(slot, pool[Math.min(want, Math.max(pool.length - 1, 0))]?.score ?? 0)
	}
	return replacement
}

const applyBars = (
	ranked: { p: PlayerSeason; score: number }[],
	league: League,
	mode: Variant,
	wire?: Set<number>
): { p: PlayerSeason; score: number }[] => {
	const replacement = barTable(ranked, league, mode, wire)
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

const RECENT = [3, 5, 7, 14, 21]

/** "bscore" is what src/backtest/season.ts does; "points" is what src/auto/plan.ts does. */
const LINEUP = process.argv.find(a => a.startsWith("--lineup="))?.slice(9) ?? "bscore"

/** Every week of a season, with the reads the simulator makes, from the disk cache. */
const weeksOf = async (season: number, warmupDays: number) => {
	const range = await seasonRange(season)
	const weeks: { start: string; end: string }[] = []
	let cursor = addDays(range.start, warmupDays)
	while (Date.parse(addDays(cursor, 7)) <= Date.parse(range.end)) {
		weeks.push({ start: cursor, end: addDays(cursor, 6) })
		cursor = addDays(cursor, 7)
	}
	return { range, weeks }
}

const weekContext = async (season: number, league: League, range: { start: string; end: string }, week: { start: string; end: string }) => {
	const priorEnd = addDays(week.start, -1)
	const [hitPrior, pitPrior, priorGames, gamesAhead] = await Promise.all([
		windowStats(season, "hitting", range.start, priorEnd),
		windowStats(season, "pitching", range.start, priorEnd),
		gamesPlayedIn(range.start, priorEnd),
		gamesPlayedIn(week.start, week.end)
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
	const prior = [
		...hitPrior.filter(p => p.position !== "P" && (p.stats.plateAppearances ?? 0) > 0),
		...pitPrior.filter(p => p.position === "P" && (p.stats.battersFaced ?? 0) > 0)
	]
	const [oppAhead, strength] = [await opponentsOf(week.start, week.end), teamStrength(prior)]
	const [hitActual, pitActual] = await Promise.all([
		windowStats(season, "hitting", week.start, week.end),
		windowStats(season, "pitching", week.start, week.end)
	])
	const actual = new Map<string, number>()
	for (const p of [...hitActual, ...pitActual])
		actual.set(`${p.id}:${p.group}`, scoreStats(p.stats, tableFor(league, p.group), p.group).points)
	const ctx: Context = {
		league, prior, priorGames, recent, recentGames,
		underlying: { hitting: new Map(), pitching: new Map() },
		gamesAhead, oppAhead, strength
	}
	return { ctx, actual }
}

/* ---------- the field: nine other teams, so that a wire exists ---------- */

/**
 * WHO THE OTHER NINE ARE, and why it has to be a mix.
 *
 * The wire is whatever the field did not take, so the field's taste decides what a
 * free-agent list looks like. Nine copies of one strategy would leave a wire shaped
 * like that strategy's blind spot — nine season-to-date managers leave every
 * newly-promoted regular sitting there — and a bar drawn off it would be measuring the
 * blind spot rather than the semantics. So the field is the three opponents this
 * project already argues are what real managers run (season.ts: "the managers who are
 * not really trying" plus "what a good human actually does"), three teams each.
 */
const FIELDS: Record<string, string[]> = {
	// the default: three of each opponent season.ts already argues is what humans run
	mixed: [
		"season-to-date", "season-to-date", "season-to-date",
		"hot-hand", "hot-hand", "hot-hand",
		"human", "human", "human"
	],
	// robustness: a field that values players the way WE do, which is the hardest case
	// for any bar — the wire is then exactly what our own ranking rejected
	sharp: Array.from({ length: 9 }, () => "projected"),
	stale: Array.from({ length: 9 }, () => "season-to-date"),
	hot: Array.from({ length: 9 }, () => "hot-hand")
}
const FIELD: string[] =
	FIELDS[process.argv.find(a => a.startsWith("--field="))?.slice(8) ?? "mixed"]!

const rankFor = (name: string, ctx: Context, league: League) =>
	name === "season-to-date" ? seasonToDate(ctx)
	: name === "hot-hand" ? applyBars(hotHand(ctx), league, "nowire")
	: name === "projected" ? applyBars(projectedPoints(ctx), league, "nowire")
	: applyBars(human(ctx), league, "nowire")

export interface VariantResult {
	name: string
	byWeek: number[]
	moves: number
	/** The bar each week at each slot, kept so the semantics can be described rather
	 *  than only scored. */
	bars: Record<string, number[]>
	/** Wire size each week, to say how thin the list the bar is drawn from actually is. */
	wireSize: number[]
	/** The roster each week, so two semantics can be asked how often they differ at all. */
	held: string[]
}

/**
 * One season of a ten-team league.
 *
 * Seats: the league's real 18 active + 5 bench (23). The four IL seats are left out
 * because this simulator has no injuries — counting them would deplete the wire by 40
 * players who, here, are simply healthy men nobody can use.
 */
const playLeagueSeason = async (
	season: number,
	league: League,
	opts: { movesPerWeek: number; warmupDays: number; sameDraft?: boolean }
) => {
	const { range, weeks } = await weeksOf(season, opts.warmupDays)
	const active = ACTIVE_SLOTS(league)
	const bench = league.roster.slots["BN"] ?? 0
	const seats = active.length + bench
	/**
	 * HOW DEEP THE FIELD HOLDS, which is the one assumption a depth question cannot be
	 * indifferent to. Default 23 — the league's own 18 active + 5 bench, with the four IL
	 * seats left out because this simulator has no injuries. `--field-seats` moves it so
	 * the answer can be asked at 18 (no bench at all) and at 27 (every seat the league
	 * has), which brackets what a real Yahoo wire has had taken out of it.
	 */
	const fieldSeats = Number(process.argv.find(a => a.startsWith("--field-seats="))?.slice(14) ?? seats)

	const impliedDepth: Record<string, number[]> = {}
	const fieldRosters: PlayerSeason[][] = FIELD.map(() => [])
	const ours: Record<Variant, PlayerSeason[]> = { nowire: [], depth: [], best: [], own: [] }
	const out: Record<Variant, VariantResult> = Object.fromEntries(
		VARIANTS.map(v => [v, { name: v, byWeek: [], moves: 0, bars: {}, wireSize: [], held: [] }])
	) as any

	for (const week of weeks) {
		const { ctx, actual } = await weekContext(season, league, range, week)
		const rankings = new Map<string, { p: PlayerSeason; score: number }[]>()
		for (const name of new Set(FIELD)) rankings.set(name, rankFor(name, ctx, league))
		const base = projectedPoints(ctx)

		/* ---- the field moves first, and never sees us: identical for every variant ---- */
		const takenByField = new Set<number>()
		for (const r of fieldRosters) for (const p of r) takenByField.add(p.id)
		fieldRosters.forEach((held, i) => {
			const ranked = rankings.get(FIELD[i]!)!
			if (!held.length) return // drafted below, after every team's turn is known
			const rank = new Map(ranked.map((r, j) => [r.p.id, j]))
			const mine = new Set(held.map(p => p.id))
			const worst = [...held].sort((a, b) => (rank.get(b.id) ?? 1e9) - (rank.get(a.id) ?? 1e9))
			let made = 0
			for (const outP of worst) {
				if (made >= opts.movesPerWeek) break
				const pick = ranked.find(r => !mine.has(r.p.id) && !takenByField.has(r.p.id))
				if (!pick) continue
				if ((rank.get(pick.p.id) ?? 1e9) >= (rank.get(outP.id) ?? 1e9)) continue
				const legal = [...held.filter(p => p.id !== outP.id), pick.p]
				if (fillRoster(legal.map(p => ({ p, score: 0 })), active).length < active.length) continue
				held.splice(held.findIndex(p => p.id === outP.id), 1, pick.p)
				mine.delete(outP.id)
				mine.add(pick.p.id)
				takenByField.delete(outP.id)
				takenByField.add(pick.p.id)
				made++
			}
		})

		// opening draft: snake order over the field, each team by its own ranking
		if (!fieldRosters[0]!.length) {
			const gone = new Set<number>()
			for (let round = 0; round < fieldSeats; round++) {
				const order = round % 2 === 0 ? [...FIELD.keys()] : [...FIELD.keys()].reverse()
				for (const i of order) {
					const ranked = rankings.get(FIELD[i]!)!
					const held = fieldRosters[i]!
					/**
					 * THE FIELD HAS TO FIELD A LEGAL LINEUP, and an earlier version of this
					 * file let it draft the best man available with no such constraint. That
					 * is not a detail: with nine teams free to ignore the catcher seat, good
					 * catchers stayed on the wire, and "the wire's best man" at C came out
					 * ABOVE the tenth-best catcher in baseball — which is the no-wire
					 * simulation's own answer. The whole question here is how far the field
					 * depletes each slot, so a field that does not have to fill its slots
					 * answers it wrongly by construction.
					 *
					 * The rule is the one our own variants already use: while the first 18
					 * are being taken, every man added must leave a roster that can still
					 * seat everybody. The five bench picks after that are unconstrained.
					 */
					const pick = ranked.find(r => {
						if (!Number.isFinite(r.score) || gone.has(r.p.id)) return false
						const legal = [...held, r.p]
						return legal.length > active.length ||
							fillRoster(legal.map(p => ({ p, score: 0 })), active).length === legal.length
					})
					if (!pick) continue
					gone.add(pick.p.id)
					held.push(pick.p)
				}
			}
			for (const id of gone) takenByField.add(id)
		}

		/* ---- the wire: everything the field does not hold ---- */
		const wire = new Set<number>()
		for (const r of base) if (Number.isFinite(r.score) && !takenByField.has(r.p.id)) wire.add(r.p.id)

		const drafted: Record<string, number[]> = {}
		for (const v of VARIANTS) {
			const held = ours[v]!
			// our own men are not on our own wire
			const mine = new Set(held.map(p => p.id))
			const myWire = new Set([...wire].filter(id => !mine.has(id)))
			const ranked = applyBars(base, league, v, myWire)
			const rank = new Map(ranked.map((r, j) => [r.p.id, j]))
			if (!held.length && opts.sameDraft && drafted["first"]) {
				// every variant starts from the SAME roster, so that what is being compared
				// is the in-season decision alone and not who each one drafted
				const want = new Set(drafted["first"]!)
				for (const r of base) if (want.has(r.p.id)) held.push(r.p)
				mine.clear()
				for (const p of held) mine.add(p.id)
			} else if (!held.length) {
				for (const r of ranked) {
					if (held.length >= seats) break
					if (!Number.isFinite(r.score) && r.score === -Infinity) continue
					if (!myWire.has(r.p.id)) continue
					const legal = [...held, r.p]
					if (legal.length <= active.length &&
						fillRoster(legal.map(p => ({ p, score: 0 })), active).length < legal.length) continue
					held.push(r.p)
				}
				for (const p of held) mine.add(p.id)
				drafted["first"] ??= held.map(p => p.id)
			} else {
				const worst = [...held].sort((a, b) => (rank.get(b.id) ?? 1e9) - (rank.get(a.id) ?? 1e9))
				let made = 0
				for (const outP of worst) {
					if (made >= opts.movesPerWeek) break
					const pick = ranked.find(r => myWire.has(r.p.id) && !mine.has(r.p.id))
					if (!pick) continue
					if ((rank.get(pick.p.id) ?? 1e9) >= (rank.get(outP.id) ?? 1e9)) continue
					const legal = [...held.filter(p => p.id !== outP.id), pick.p]
					if (fillRoster(legal.map(p => ({ p, score: 0 })), active).length < active.length) continue
					held.splice(held.findIndex(p => p.id === outP.id), 1, pick.p)
					mine.delete(outP.id)
					mine.add(pick.p.id)
					made++
				}
				out[v]!.moves += made
			}
			/**
			 * Lineup: the best legal 18 of the men held.
			 *
			 * BY WHICH RANKING is itself a fork, and the app and the simulator disagree.
			 * src/backtest/season.ts fills the lineup from the bar-adjusted ranking, so a bar
			 * change moves the lineup as well as the moves. src/auto/plan.ts does NOT — its
			 * docblock says so outright: "Ranked on projected POINTS rather than bscore,
			 * because the replacement subtraction exists to compare a player against the
			 * waiver wire — a question that is already settled for men you own."
			 *
			 * So `--lineup=points` runs the app's rule, and is the configuration that isolates
			 * what the bar is actually FOR: the add/drop decision alone.
			 */
			const heldRanked =
				LINEUP === "points" ?
					base.filter(r => mine.has(r.p.id))
				:	ranked.filter(r => mine.has(r.p.id))
			const lineup = fillRoster(heldRanked, active)
			const scored = lineup.reduce((s, r) => s + (actual.get(`${r.p.id}:${r.p.group}`) ?? 0), 0)
			out[v]!.byWeek.push(Number(scored.toFixed(1)))
			out[v]!.held.push(held.map(p => p.id).sort((a, b) => a - b).join(","))
			out[v]!.wireSize.push(myWire.size)
			// record the bars themselves
			for (const [slot, bar] of barTable(base, league, v, myWire))
				(out[v]!.bars[slot] ??= []).push(Number(bar.toFixed(2)))
			/**
			 * HOW DEEP DOWN THE WIRE THE NO-WIRE BAR ACTUALLY LANDS.
			 *
			 * The whole argument is about double-counting: the (teams x seats)-th man of the
			 * WHOLE POOL is a simulation of a wire that has already had the other rosters
			 * taken out of it, so walking (teams x seats) again down a real wire walks the
			 * same depletion twice. This measures it rather than asserting it — for each slot
			 * and week, how many men on the wire out-project the bar the no-wire simulation
			 * sets. If the answer is near `count` rather than near `teams x count`, the
			 * double-count is the size of the league.
			 */
			if (v === "nowire")
				for (const [slot, bar] of barTable(base, league, "nowire")) {
					const above = base.filter(
						r => slotsFor(r.p).includes(slot) && myWire.has(r.p.id) && r.score > bar
					).length
					;(impliedDepth[slot] ??= []).push(above)
				}
		}
	}
	return { out, weeks: weeks.map(w => w.start), impliedDepth }
}

/* ---------- is the copy faithful? ---------- */

const verify = async (season: number, league: League) => {
	// season.ts's own bscore strategy, through its own playSeason
	const real = await playSeason(season, league, [STRATEGIES[0]!], { movesPerWeek: 1, warmupDays: 28 })
	// the same thing out of the copied helpers: no field, no wire, direct swaps
	const { range, weeks } = await weeksOf(season, 28)
	const slots = ACTIVE_SLOTS(league)
	let roster: { slot: string; p: PlayerSeason }[] | null = null
	const byWeek: number[] = []
	for (const week of weeks) {
		const { ctx, actual } = await weekContext(season, league, range, week)
		const ranked = applyBars(projectedPoints(ctx), league, "nowire")
		if (!roster) roster = fillRoster(ranked, slots)
		else {
			const rank = new Map(ranked.map((r, i) => [r.p.id, i]))
			const heldIds = new Set(roster.map(h => h.p.id))
			const worst = [...roster].sort((a, b) => (rank.get(b.p.id) ?? 1e9) - (rank.get(a.p.id) ?? 1e9))
			let made = 0
			for (const out of worst) {
				if (made >= 1) break
				const replacement = ranked.find(r => !heldIds.has(r.p.id) && slotsFor(r.p).includes(out.slot))
				if (!replacement) continue
				if ((rank.get(replacement.p.id) ?? 1e9) >= (rank.get(out.p.id) ?? 1e9)) continue
				heldIds.delete(out.p.id)
				heldIds.add(replacement.p.id)
				out.p = replacement.p
				made++
			}
		}
		byWeek.push(Number(roster.reduce((s, r) => s + (actual.get(`${r.p.id}:${r.p.group}`) ?? 0), 0).toFixed(1)))
	}
	const theirs = real.results[0]!.byWeek
	const same = theirs.length === byWeek.length && theirs.every((v, i) => Math.abs(v - byWeek[i]!) < 1e-6)
	console.log(
		`VERIFY ${season}: copied helpers reproduce src/backtest/season.ts week for week: ${same ? "yes" : "NO"}` +
			(same ? ` (${byWeek.length} weeks, total ${byWeek.reduce((a, b) => a + b, 0).toFixed(1)})` : "")
	)
	if (!same) {
		console.log("  theirs:", theirs.slice(0, 8).join(" "))
		console.log("  mine:  ", byWeek.slice(0, 8).join(" "))
	}
	return same
}

/* ---------- run ---------- */

const league: League = JSON.parse(readFileSync("scoring.json", "utf8")).leagues["yahoo:228947"]
const seasons = (process.argv.find(a => a.startsWith("--seasons="))?.slice(10) ?? "2025")
	.split(",").map(Number)
const movesPerWeek = Number(process.argv.find(a => a.startsWith("--moves="))?.slice(8) ?? 1)

if (process.argv.includes("--verify")) {
	for (const s of seasons) await verify(s, league)
	process.exit(0)
}

const pooled: Record<Variant, number[]> = { nowire: [], depth: [], best: [], own: [] }
const moves: Record<Variant, number> = { nowire: 0, depth: 0, best: 0, own: 0 }
const perSeason: { season: number; byWeek: Record<Variant, number[]> }[] = []
const heldBy: Record<Variant, string[]>[] = []
const implied: Record<string, number[]> = {}
const barRows: { season: number; slot: string; v: Variant; mean: number }[] = []
const wireSizes: number[] = []

for (const season of seasons) {
	const { out, weeks, impliedDepth } = await playLeagueSeason(season, league, {
		movesPerWeek, warmupDays: 28, sameDraft: process.argv.includes("--same-draft")
	})
	perSeason.push({ season, byWeek: Object.fromEntries(VARIANTS.map(v => [v, out[v]!.byWeek])) as any })
	heldBy.push(Object.fromEntries(VARIANTS.map(v => [v, out[v]!.held])) as any)
	console.log(`\n${season} — ${weeks.length} weeks, ${movesPerWeek} move(s)/week`)
	for (const v of VARIANTS) {
		pooled[v].push(...out[v]!.byWeek)
		moves[v] += out[v]!.moves
		const total = out[v]!.byWeek.reduce((a, b) => a + b, 0)
		console.log(`  ${v.padEnd(7)} ${total.toFixed(0).padStart(7)} pts  ${String(out[v]!.moves).padStart(3)} moves`)
		for (const [slot, vals] of Object.entries(out[v]!.bars))
			barRows.push({ season, slot, v, mean: vals.reduce((a, b) => a + b, 0) / vals.length })
	}
	wireSizes.push(...out.depth!.wireSize)
	for (const [slot, vals] of Object.entries(impliedDepth)) (implied[slot] ??= []).push(...vals)
}

const erf = (x: number) => {
	const t = 1 / (1 + 0.3275911 * Math.abs(x))
	const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
	return x >= 0 ? y : -y
}
const signTest = (mine: number[], theirs: number[]) => {
	let w = 0, l = 0, t = 0, sum = 0
	mine.forEach((v, i) => {
		const d = v - (theirs[i] ?? 0)
		sum += d
		if (Math.abs(d) < 1e-9) t++
		else if (d > 0) w++
		else l++
	})
	const n = w + l
	const z = n ? (w - n / 2) / Math.sqrt(n * 0.25) : 0
	const p = n ? 1 - erf(Math.abs(z) / Math.SQRT2) : 1
	return { w, l, t, n, z, p, mean: sum / Math.max(mine.length, 1) }
}

console.log(`\nPOOLED — ${pooled.depth.length} weeks, seasons ${seasons.join(", ")}`)
for (const v of VARIANTS)
	console.log(`  ${v.padEnd(7)} ${pooled[v].reduce((a, b) => a + b, 0).toFixed(0).padStart(8)} pts  ${moves[v]} moves`)
console.log(`  wire size: mean ${(wireSizes.reduce((a, b) => a + b, 0) / wireSizes.length).toFixed(0)} men, min ${Math.min(...wireSizes)}, max ${Math.max(...wireSizes)}`)

const pairs: [Variant, Variant][] = [
	["best", "depth"], ["own", "depth"], ["best", "own"], ["best", "nowire"],
	["depth", "nowire"], ["own", "nowire"]
]
console.log(`\nPAIRED WEEKLY SIGN TEST (ties excluded)`)
for (const [a, b] of pairs) {
	const r = signTest(pooled[a], pooled[b])
	console.log(
		`  ${a} vs ${b}: ${r.w}W ${r.l}L ${r.t}T  ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(1)}/wk  ` +
			`z ${r.z >= 0 ? "+" : ""}${r.z.toFixed(2)}  p ${r.p.toFixed(3)}`
	)
}

console.log(`\nPER-SEASON TOTALS (points) — the honest unit when a difference is set at the draft`)
console.log("  season  " + VARIANTS.map(v => v.padStart(9)).join(""))
for (const s2 of perSeason)
	console.log(
		`  ${s2.season}   ` +
			VARIANTS.map(v => s2.byWeek[v].reduce((a, b) => a + b, 0).toFixed(0).padStart(9)).join("")
	)
console.log(`\nPER-SEASON, best vs depth (the question) — paired weeks`)
for (const s2 of perSeason) {
	const r = signTest(s2.byWeek.best, s2.byWeek.depth)
	console.log(`  ${s2.season}  ${r.w}W ${r.l}L ${r.t}T  ${(r.mean >= 0 ? "+" : "") + r.mean.toFixed(1)}/wk`)
}
/**
 * Five seasons, counted as five. A difference set at the draft persists for every week
 * of that season, so 111 weekly comparisons are not 111 independent tests of it — the
 * season total is. Two-sided exact binomial on five paired seasons: 5-0 is p = 0.063,
 * and nothing smaller reaches 0.05 at all.
 */
const seasonSign = (a: Variant, b: Variant) => {
	const wins = perSeason.filter(
		s2 => s2.byWeek[a].reduce((x, y) => x + y, 0) > s2.byWeek[b].reduce((x, y) => x + y, 0)
	).length
	const n = perSeason.length
	const choose = (nn: number, k: number) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (nn - i)) / (i + 1); return r }
	// two-sided exact binomial: 2 x the smaller tail, capped at 1
	let lo = 0, hi = 0
	for (let k = 0; k <= n; k++) {
		if (k <= wins) lo += choose(n, k) / 2 ** n
		if (k >= wins) hi += choose(n, k) / 2 ** n
	}
	return { wins, n, p: Math.min(1, 2 * Math.min(lo, hi)) }
}
console.log(`\nSEASON-LEVEL SIGN TEST (${perSeason.length} seasons, exact binomial)`)
for (const [a, b] of pairs) {
	const r = seasonSign(a, b)
	console.log(`  ${a} vs ${b}: ${r.wins}/${r.n} seasons  p ${r.p.toFixed(3)}`)
}

console.log(`\nHOW OFTEN THE SEMANTICS EVEN DISAGREE (weeks where the rosters differ)`)
for (const [a, b] of [["best", "depth"], ["own", "depth"], ["best", "own"], ["depth", "nowire"]] as [Variant, Variant][]) {
	let diff = 0, n = 0
	for (const season of heldBy)
		season[a].forEach((h, i) => { n++; if (h !== season[b][i]) diff++ })
	console.log(`  ${a} vs ${b}: ${diff}/${n} weeks hold a different roster`)
}

console.log(`\nWHERE THE NO-WIRE BAR LANDS ON THE REAL WIRE (men on the wire who out-project it)`)
console.log("  slot   league seats (teams x count)   own seats (count)   measured median   mean")
for (const [slot, vals] of Object.entries(implied)) {
	const sorted = [...vals].sort((a, b) => a - b)
	const count = league.roster.slots[slot]!
	console.log(
		`  ${slot.padEnd(6)} ${String((league.meta.max_teams ?? 10) * count).padStart(12)} ` +
			`${String(count).padStart(22)} ${String(sorted[Math.floor(sorted.length / 2)]).padStart(17)} ` +
			`${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1).padStart(7)}`
	)
}

// mean bar per slot, pooled over seasons — the description of what the semantics do
console.log(`\nMEAN REPLACEMENT BAR BY SLOT (projected points per week)`)
const slots = [...new Set(barRows.map(r => r.slot))]
console.log("  slot      nowire      depth       best        own")
for (const slot of slots) {
	const m = (v: Variant) => {
		const rows = barRows.filter(r => r.slot === slot && r.v === v)
		return rows.reduce((a, c) => a + c.mean, 0) / rows.length
	}
	console.log(`  ${slot.padEnd(6)} ${m("nowire").toFixed(2).padStart(9)} ${m("depth").toFixed(2).padStart(10)} ${m("best").toFixed(2).padStart(10)} ${m("own").toFixed(2).padStart(10)}`)
}
