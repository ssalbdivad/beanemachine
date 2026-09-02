import { useEffect, useMemo, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { hydrate } from "../data/snapshot.ts"
import { rateAll, withMarketEdge, withUndervaluation, type Ranked } from "../engine/bscore.ts"
import type { League } from "../schema.ts"

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
	/** Only pitchers with two or more scheduled starts in the horizon. */
	twoStartOnly: boolean
	availableOnly: boolean
	minConfidence: number
	/**
	 * Which question the board is answering. The three differ only in horizon, but
	 * that changes the answer completely: a two-start pitcher wins a week and a
	 * 22-year-old with a rising role wins a September, and neither shows up in the
	 * other's ranking.
	 */
	mode: "stream" | "board" | "stash"
	sort:
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
	twoStartOnly: false,
	availableOnly: false,
	minConfidence: 0,
	// The default answers "who is the field wrong about", not "who is best" — the
	// best players are already rostered, so a bare bscore ranking opens on names
	// nobody reading this can actually add.
	mode: "board",
	sort: "marketEdge",
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
	const rated = useMemo(() => {
		if (!snapshot || !league) return []
		// Replacement depth is teams × slots. Without a real team count there is no
		// honest bscore, so this refuses rather than assuming a league size.
		if (league.meta.max_teams == null) return []
		const h = hydrate(snapshot)
		// Rest-of-season counts can be empty in the off-season, and a horizon of zero
		// games would rank everyone at zero. Fall back rather than invent a number.
		const horizon =
			filters.mode === "stream" && h.gamesWeek.size ?
				{ games: h.gamesWeek, opponents: h.opponentsWeek }
			: filters.mode === "stash" && h.gamesRemaining.size ?
				{ games: h.gamesRemaining, opponents: h.opponentsByTeam }
			:	{ games: h.gamesByTeam, opponents: h.opponentsByTeam }
		// Probables only exist about a week out, so the stash horizon has none — and an
		// absent count must fall back to the team-games estimate, not project zero.
		const probableStarts =
			filters.mode === "stream" ? h.probableStartsWeek
			: filters.mode === "stash" ? undefined
			: h.probableStarts
		const opposingStarters =
			filters.mode === "stream" ? h.opposingStartersWeek
			: filters.mode === "stash" ? undefined
			: h.opposingStarters
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
				opposingStarters,
				// over the rest of a season an injured man is a legitimate hold; over the
				// next week he is simply unavailable
				injuryPolicy: filters.mode === "stash" ? "keep" : "exclude",
				teams: league.meta.max_teams
				})
			),
			h.ownership
		)
	}, [snapshot, league, filters.mode])

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
	const edgeUsable = edgeCoverage >= 0.35

	const rows = useMemo(() => {
		const q = filters.search.trim().toLowerCase()
		const out = rated.filter(r => {
			// a player with no projectable volume has no bscore to rank
			if (!r.rateable) return false
			// "most undervalued" asks who is due for positive regression among players
			// worth rostering. Unrestricted it just finds the unluckiest replacement-level
			// player in baseball, which answers nobody's question.
			if (filters.sort === "undervaluation" && r.bscore <= 0) return false
			// Same guard for market edge: a replacement-level body nobody rosters beats
			// the par for his ownership by definition, and recommending him is noise.
			if (filters.sort === "marketEdge" && edgeUsable && (r.marketEdge === null || r.bscore <= 0))
				return false
			// Contact quality only means something for someone worth rostering, and only
			// where a rolling Statcast window actually exists for him.
			if (filters.sort === "contact" && (r.regressionGap === null || r.bscore <= 0)) return false
			if (q && !r.player.name.toLowerCase().includes(q)) return false
			if (filters.group !== "all" && r.player.group !== filters.group) return false
			if (filters.slot && !r.slots.includes(filters.slot)) return false
			if (filters.hideInjured && r.injury) return false
			if (filters.twoStartOnly && (r.scheduledStarts ?? 0) < 2) return false
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
				case "marketEdge":
					return edgeUsable ? (r.marketEdge ?? -Infinity) : r.bscore
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
	}, [rated, filters, availableNames, edgeUsable])

	return { rated, rows, scored, edgeUsable, edgeCoverage }
}
