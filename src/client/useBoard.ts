import { useEffect, useMemo, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { hydrate } from "../data/snapshot.ts"
import { rateAll, withMarketEdge, withUndervaluation, type Ranked } from "../engine/bscore.ts"
import type { League } from "../schema.ts"
import { resolvePeriod, windowFrom, withinDays } from "../engine/period.ts"

export type { Ranked }

/**
 * The ranking engine is pure, so it runs here in the browser against a snapshot of
 * observed data. That means the board recomputes instantly when the league's
 * scoring changes — the same player really is worth a different amount in a
 * different league, and you can watch that happen.
 */


/**
 * index.html starts this fetch while the page is still being parsed — see the
 * `prefetch-snapshot` plugin in vite.config.ts — and parks the promise here.
 * Waiting for React to mount before asking for a 2.1 MB file put 310 ms of dead
 * time on the cold critical path, all of it behind the bundle's own download and
 * parse (measured on the production build).
 *
 * If that script did not run — an index.html this build did not produce — the
 * fetch happens here instead. What is NOT done is inventing a snapshot: a
 * missing one still surfaces as the error it is.
 */
const snapshotRequest = (): Promise<Snapshot> =>
	(globalThis as { __snapshot?: Promise<Snapshot> }).__snapshot ??
	fetch(`${import.meta.env.BASE_URL}snapshot.json`).then(r =>
		r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
	)

export const useSnapshot = () => {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		let live = true
		snapshotRequest()
			.then(v => live && setSnapshot(v))
			.catch(e => live && setError(String(e.message ?? e)))
		return () => {
			live = false
		}
	}, [])
	return { snapshot, error }
}

export interface Filters {
	search: string
	slot: string
	group: "all" | "hitting" | "pitching"
	hideInjured: boolean
	availableOnly: boolean
	minConfidence: number
	/**
	 * Which question the board is answering. The three differ only in horizon, but
	 * that changes the answer completely: a two-start pitcher wins a week and a
	 * 22-year-old with a rising role wins a September, and neither shows up in the
	 * other's ranking.
	 */
	mode: "stream" | "board" | "stash"
	/**
	 * How long a streaming window to rank, in days. Null is the league's own
	 * scoring period, which is the right answer most of the time and therefore the
	 * default — see `withinDays` for why this is one control with the period rather
	 * than a second one. Read only in `stream` mode: on the other two tabs the
	 * question is not "how long", so a day count left behind here cannot leak into
	 * a horizon that never offered it.
	 */
	days: number | null
	/**
	 * Streaming only: keep only players the schedule actually has pitching inside
	 * the window. A streaming list with hitters and relievers in it is not a
	 * streaming list — on the committed capture over the rest of the period, 3 of
	 * the top 10 rows were hitters, who cannot be streamed for a start at all.
	 */
	startersOnly: boolean
	/**
	 * How many roster moves the reader has left this period. Zero marks nothing.
	 *
	 * This is an INPUT rather than a model output because nothing the app reads
	 * knows it. No source in the snapshot carries a transaction count, a waiver
	 * position, a FAAB balance or a weekly add limit, and those are the four things
	 * that decide it; a league can also cap games started per period, which caps
	 * adds for a completely different reason. Guessing a number here would be the
	 * exact failure this project refuses — a figure that looks read off the league
	 * and was not. So the reader types the one fact he has and the board does the
	 * arithmetic he does not: which N of the ranking those moves should buy.
	 */
	moves: number
	sort:
		| "uscore"
		| "marketEdge"
		| "bscore"
		| "points"
		| "undervaluation"
		| "contact"
		| "replacement"
		| "confidence"
		| "name"
	desc: boolean
}

export const DEFAULT_FILTERS: Filters = {
	search: "",
	slot: "",
	group: "all",
	hideInjured: false,
	availableOnly: false,
	minConfidence: 0,
	mode: "board",
	// the league's own period, not a day count: the reset is what a head-to-head
	// matchup is settled on, so it is the horizon that is right unless asked otherwise
	days: null,
	// on by default, because the Streaming tab's whole question is who pitches
	// before the reset. It is a visible toggle and it is scoped to `stream` below,
	// so it can neither be left on invisibly nor strand a board it emptied.
	startersOnly: true,
	moves: 0,
	/**
	 * bscore, because the field's price is not currently readable.
	 *
	 * This opened on market edge for a long time, on the reasoning that the best
	 * players are already rostered so a bare bscore ranking names people you cannot
	 * add. That reasoning is still right. The input is not: "% Ros" is swept off
	 * Yahoo's player pages, and most of what comes back is the per-game weather
	 * line out of the forecast tooltip rather than anybody's roster share — on the
	 * committed capture 20 of 30 clubs have 93-100% of their players on one
	 * identical percentage, paired exactly by that day's matchups. `leakedByTeam`
	 * in data/yahoo-pool.ts now discards those at capture time, so a future sweep
	 * is clean; the shipped snapshot predates it.
	 *
	 * Ranking by a number drawn from the precipitation forecast is worse than
	 * ranking by one that is merely incomplete, so the default is the honest
	 * column. Market edge stays selectable — a reader who picks it has asked for
	 * exactly what it can price.
	 */
	sort: "bscore",
	desc: true
}

/** Names vary by accent, punctuation and suffix between Yahoo and MLB. */
export const normalizeName = (n: string): string =>
	n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
		.replace(/[.'\u2019]/g, "").replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "")
		.replace(/\s+/g, " ").trim()

export const useBoard = (
	snapshot: Snapshot | null,
	league: League | null,
	filters: Filters,
	availableNames?: Set<string> | null
) => {
	// The reader's today, not the capture's. A snapshot is a set of games; which of
	// them are still ahead of you is a question only the clock can answer.
	const period = useMemo(() => {
		if (!snapshot || !league) return null
		const slate = snapshot.slate ?? []
		const seasonEnd = slate.reduce((a, g) => (g.date > a ? g.date : a), snapshot.horizon.end)
		const p = resolvePeriod(league, new Date().toISOString().slice(0, 10), seasonEnd)
		// A day count is a STREAMING control. Applying it on the other two tabs would
		// silently retitle their horizons — "This fortnight" ranked over three days —
		// so it is read here and nowhere else, and leaving the tab restores the period.
		return filters.mode === "stream" && filters.days !== null ?
				withinDays(p, filters.days, seasonEnd)
			:	p
	}, [snapshot, league, filters.mode, filters.days])

	/**
	 * The window itself, lifted out of `rated` because the ROW needs it too.
	 *
	 * Who each announced starter faces was computed here and thrown away: it reached
	 * `rateAll`, moved the projection through `pitcherMatchupIndex`, and never reached
	 * the screen — so the board priced a start against the Rockies differently from a
	 * start against the Dodgers and showed the reader neither opponent. Same object,
	 * same dates, one computation: the number the row prints cannot drift from the
	 * number the ranking used, because there is only one.
	 */
	const week = useMemo(() => {
		if (!snapshot || !period) return null
		return windowFrom(snapshot.slate ?? [], period.start, period.end)
	}, [snapshot, period])

	const rated = useMemo(() => {
		if (!snapshot || !league) return []
		// Replacement depth is teams × slots. Without a real team count there is no
		// honest bscore, so this refuses rather than assuming a league size.
		if (league.meta.max_teams == null) return []
		const h = hydrate(snapshot)
		// A period can legitimately resolve to nothing — a stale snapshot asked about a
		// week that starts after its last captured game — and zero games would rank
		// everyone at zero. Fall back to the fortnight rather than invent a number.
		const usingWeek = filters.mode === "stream" && !!week && week.games.size > 0
		const usingRest = filters.mode === "stash" && h.gamesRemaining.size > 0
		const horizon =
			usingWeek ? { games: week!.games, opponents: week!.opponents }
			: usingRest ? { games: h.gamesRemaining, opponents: h.opponentsRemaining }
			: { games: h.gamesByTeam, opponents: h.opponentsByTeam }
		// Probables reach about a week out, so the rest of a season has none — and an
		// absent count must fall back to the team-games estimate, not project zero.
		const probableStarts =
			usingWeek ? week!.probableStarts : usingRest ? undefined : h.probableStarts
		const probableCoverage =
			usingWeek ? week!.coverage : usingRest ? undefined : h.probableCoverage
		const opposingStarters =
			usingWeek ? week!.opposingStarters : usingRest ? undefined : h.opposingStarters
		// which lineup each announced starter actually faces — only meaningful where
		// probables exist, so the rest-of-season view has none by construction
		const startOpponents =
			usingWeek ? week!.startOpponents : usingRest ? undefined : h.startOpponents
		return withMarketEdge(
			withUndervaluation(
				rateAll({
				league,
				players: h.players,
				underlying: h.underlying,
				injuries: h.injuries,
				teamGamesPlayed: h.teamGamesPlayed,
				gamesByTeam: horizon.games,
				opponentsByTeam: horizon.opponents,
				recentVolumeByWindow: h.recentVolumeByWindow,
				recentStats: h.recentStats,
				ownership: h.ownership,
				eligibility: h.eligibility,
				probableStarts,
				probableCoverage,
				opposingStarters,
				// over the rest of a season an injured man is a legitimate hold; over the
				// next week he is simply unavailable
				injuryPolicy: filters.mode === "stash" ? "keep" : "exclude",
				teams: league.meta.max_teams
				})
			),
			h.ownership
		)
	}, [snapshot, league, filters.mode, week])

	/** Which sides this league actually scores — an unconfigured template scores
	 *  neither, and the board must say so rather than rank a field of zeros. */
	const scored = useMemo(
		() =>
			!league ?
				null
			:	{
					hitting: Object.values(league.scoring.batting).some(v => v !== 0),
					pitching: Object.values(league.scoring.pitching).some(v => v !== 0)
				},
		[league]
	)

	/**
	 * Is there enough market data for market edge to be the DEFAULT ranking?
	 *
	 * Ownership is read from Yahoo's public pages, and how much comes back depends
	 * on who is asking: a local run reads ~845 players, the CI runner that builds
	 * the published snapshot gets throttled down to ~229. Ranking by edge silently
	 * drops everyone unpriced, so on a thin capture the board went from 1,400 rows
	 * to a handful — a broken page that looked like a short list.
	 *
	 * The default therefore has to survive its optional input going missing. Below
	 * the threshold the board falls back to bscore and SAYS it did; edge stays
	 * available as an explicit choice, because a user who picks it has asked for
	 * exactly the subset it can rank.
	 */
	const edgeCoverage = useMemo(() => {
		const rateable = rated.filter(r => r.rateable)
		if (!rateable.length) return 0
		return rateable.filter(r => r.marketEdge !== null).length / rateable.length
	}, [rated])

	/**
	 * How many players the RANKING itself can place, before the reader's filters.
	 *
	 * Market edge can only rank someone the field has priced, and only recommends
	 * someone worth rostering — so the board opens on 67 of 1,433 and a bare count
	 * reads as a broken capture. The board says what did the cutting, and to say it
	 * truthfully it needs the ranking's cut separated from the reader's own: with
	 * a position chip on, "market edge dropped the rest" would be a lie about why
	 * the list is short.
	 */
	const rankable = useMemo(
		() =>
			rated.filter(r => {
				if (!r.rateable) return false
				if (filters.sort === "undervaluation" && r.bscore <= 0) return false
				if (filters.sort === "marketEdge" && (r.marketEdge === null || r.bscore <= 0))
					return false
				if (filters.sort === "uscore" && r.uscore === null) return false
				if (filters.sort === "contact" && (r.regressionGap === null || r.bscore <= 0)) return false
				return true
			}).length,
		[rated, filters.sort]
	)

	/**
	 * What a streaming decision needs on the page beside the ranking: who each
	 * announced starter faces, and how much of this window MLB has actually named.
	 *
	 * The coverage is MEASURED off the window on screen rather than quoted from a
	 * table, because it is a property of the capture as much as of the horizon.
	 * Probables reach roughly three days past a capture and then stop: on the
	 * committed snapshot (captured 2026-09-02), read on 2026-09-04, MLB has named the
	 * starter in 15 of 32 games one day out, 41 of 92 three days out, and still 43 of
	 * 184 seven days out. A number baked into a string would have been right on the
	 * day it was written and wrong every day after, which is the failure mode this
	 * whole board exists to avoid.
	 *
	 * Null off the Streaming tab, so nothing can print a streaming fact under a
	 * horizon that did not produce one.
	 */
	const streaming = useMemo(() => {
		/**
		 * Null where there is nothing honest to say, which is two cases: off the
		 * Streaming tab, and a window with no games in it at all. The second is a
		 * capture older than the period it is being asked about — the rating below
		 * already falls back to the fortnight rather than rank everyone at zero, and
		 * this returning null makes the rest of the tab fall back with it, instead of
		 * printing "0 of 0 games" and filtering on a count from a window nobody is
		 * being shown.
		 */
		if (filters.mode !== "stream" || !week || week.games.size === 0) return null
		let published = 0
		let games = 0
		let fullyNamed = 0
		for (const c of week.coverage.values()) {
			published += c.published
			games += c.games
			if (c.published === c.games) fullyNamed++
		}
		return {
			/** Opponent club ids per announced start, in schedule order. */
			startOpponents: week.startOpponents,
			/** Starts MLB has actually PUBLISHED for him — an integer, and the length
			 *  of his opponent list. Distinct from `Rated.scheduledStarts`, which adds
			 *  an estimate for his club's not-yet-named games. */
			publishedStarts: week.probableStarts,
			clubs: week.coverage.size,
			fullyNamed,
			published,
			games
		}
	}, [filters.mode, week])

	/** Club id → the club's name, for turning an opponent id on a row into something
	 *  a reader recognises. Built off the players the snapshot already carries, so
	 *  there is no second table of team names to fall out of date. */
	const teamNames = useMemo(() => {
		const m = new Map<number, string>()
		for (const p of snapshot?.players ?? []) if (p.teamId && p.team) m.set(p.teamId, p.team)
		return m
	}, [snapshot])

	const rows = useMemo(() => {
		const q = filters.search.trim().toLowerCase()
		/**
		 * "Has a start in this window" — the filter that makes a streaming view a
		 * streaming view rather than the same board over a shorter horizon.
		 *
		 * `scheduledStarts` is the engine's own count and the number the projection is
		 * already multiplied by: published turns plus his club's unnamed games times
		 * his rate of starting (METHODOLOGY 3.5.0). Greater than zero therefore means
		 * "the schedule has him pitching in this window" on exactly the arithmetic the
		 * ranking used — not a second definition invented for the filter. A null is a
		 * man the window cannot speak about (no club, or a club with no games in it)
		 * and a reliever with no published appearance, and neither is a start.
		 *
		 * Gated on `streaming` rather than on the checkbox alone, so it cannot outlive
		 * the window it is about: this page has already shipped a mode-scoped filter
		 * that went on filtering after its checkbox stopped rendering, and the board
		 * emptied with nothing on screen to undo it. `streaming` is null off the tab
		 * AND on a capture too old to cover the period, which is exactly the case where
		 * the counts it would filter on come from a different window than the one the
		 * board is ranking.
		 */
		const startersOnly = streaming !== null && filters.startersOnly
		const out = rated.filter(r => {
			// a player with no projectable volume has no bscore to rank
			if (!r.rateable) return false
			// "most undervalued" asks who is due for positive regression among players
			// worth rostering. Unrestricted it just finds the unluckiest replacement-level
			// player in baseball, which answers nobody's question.
			if (filters.sort === "undervaluation" && r.bscore <= 0) return false
			// Same guard for market edge: a replacement-level body nobody rosters beats
			// the par for his ownership by definition, and recommending him is noise.
			// No longer gated on coverage: edge is no longer the default, so picking it
			// is an explicit request for the subset it can price, and quietly handing
			// back a bscore ranking under the "market edge" label is now the confusing
			// behaviour rather than the safe one.
			if (filters.sort === "marketEdge" && (r.marketEdge === null || r.bscore <= 0))
				return false
			// No bscore floor here, unlike the other comparative sorts. Those two can be
			// gamed by a replacement-level body — a tiny denominator or a par he beats by
			// definition — but uscore is `addValue × (1 − owned)`, which is bounded by
			// bscore and floors at zero, so a player nobody should add simply sorts to the
			// bottom instead of needing to be excluded. The old floor cut the board to 44
			// rows, which read as a broken capture.
			if (filters.sort === "uscore" && r.uscore === null) return false
			// Contact quality only means something for someone worth rostering, and only
			// where a rolling Statcast window actually exists for him.
			if (filters.sort === "contact" && (r.regressionGap === null || r.bscore <= 0)) return false
			if (startersOnly && !(r.scheduledStarts != null && r.scheduledStarts > 0)) return false
			if (q && !r.player.name.toLowerCase().includes(q)) return false
			if (filters.group !== "all" && r.player.group !== filters.group) return false
			if (filters.slot && !r.slots.includes(filters.slot)) return false
			if (filters.hideInjured && r.injury) return false
			if (filters.availableOnly && availableNames && !availableNames.has(normalizeName(r.player.name)))
				return false
			if (r.confidence.value < filters.minConfidence) return false
			return true
		})
		const key = (r: (typeof out)[number]) => {
			switch (filters.sort) {
				case "points": return r.points
				case "replacement": return r.replacement
				case "confidence": return r.confidence.value
				case "undervaluation": return r.undervaluation ?? -1
				case "uscore": return r.uscore ?? -Infinity
				case "marketEdge": return r.marketEdge ?? -Infinity
				case "contact":
					// a pitcher benefits when his expected is BELOW his actual, so it flips
					return (
						(r.player.group === "hitting" ? 1 : -1) * (r.regressionGap ?? -Infinity)
					)
				case "name": return r.player.name
				default: return r.bscore
			}
		}
		out.sort((a, b) => {
			const x = key(a), y = key(b)
			const cmp = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number)
			return filters.desc ? -cmp : cmp
		})
		return out
	}, [rated, filters, availableNames, streaming])

	return { rated, rows, rankable, scored, edgeCoverage, period, streaming, teamNames }
}
