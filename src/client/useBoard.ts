import { useEffect, useMemo, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { hydrate } from "../data/snapshot.ts"
import { rateAll, withUndervaluation } from "../engine/bscore.ts"
import type { League } from "../schema.ts"

/**
 * The ranking engine is pure, so it runs here in the browser against a snapshot of
 * observed data. That means the board recomputes instantly when the league's
 * scoring changes — the same player really is worth a different amount in a
 * different league, and you can watch that happen.
 */
export type Rated = ReturnType<typeof withUndervaluation>[number]

export const useSnapshot = () => {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		fetch(`${import.meta.env.BASE_URL}snapshot.json`)
			.then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then(setSnapshot)
			.catch(e => setError(String(e.message ?? e)))
	}, [])
	return { snapshot, error }
}

export interface Filters {
	search: string
	slot: string
	group: "all" | "hitting" | "pitching"
	hideInjured: boolean
	minConfidence: number
	sort: "bscore" | "points" | "undervaluation" | "replacement" | "confidence" | "name"
	desc: boolean
}

export const DEFAULT_FILTERS: Filters = {
	search: "",
	slot: "",
	group: "all",
	hideInjured: false,
	minConfidence: 0,
	sort: "bscore",
	desc: true
}

export const useBoard = (snapshot: Snapshot | null, league: League | null, filters: Filters) => {
	const rated = useMemo(() => {
		if (!snapshot || !league) return []
		// Replacement depth is teams × slots. Without a real team count there is no
		// honest bscore, so this refuses rather than assuming a league size.
		if (league.meta.max_teams == null) return []
		const h = hydrate(snapshot)
		return withUndervaluation(
			rateAll({
				league,
				players: h.players,
				underlying: h.underlying,
				injuries: h.injuries,
				teamGamesPlayed: h.teamGamesPlayed,
				gamesByTeam: h.gamesByTeam,
				recentVolumePerGame: h.recentVolumePerGame,
				recentStats: h.recentStats,
				teams: league.meta.max_teams
			})
		)
	}, [snapshot, league])

	const rows = useMemo(() => {
		const q = filters.search.trim().toLowerCase()
		const out = rated.filter(r => {
			// a player with no projectable volume has no bscore to rank
			if (!r.rateable) return false
			if (q && !r.player.name.toLowerCase().includes(q)) return false
			if (filters.group !== "all" && r.player.group !== filters.group) return false
			if (filters.slot && !r.slots.includes(filters.slot)) return false
			if (filters.hideInjured && r.injury) return false
			if (r.confidence.value < filters.minConfidence) return false
			return true
		})
		const key = (r: (typeof out)[number]) => {
			switch (filters.sort) {
				case "points": return r.points
				case "replacement": return r.replacement
				case "confidence": return r.confidence.value
				case "undervaluation": return r.undervaluation ?? -1
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
	}, [rated, filters])

	return { rated, rows }
}
