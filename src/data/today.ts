/**
 * What is actually happening today, read live from MLB.
 *
 * Every projection in this app is an average over a window. That is the right unit
 * for "who is worth more", and it is the wrong unit for the question a manager
 * actually opens the app to answer at six in the evening: *is this man playing
 * tonight?* A projection cannot know that a shortstop was scratched an hour ago, or
 * that his club is off, or that the manager is resting him against a lefty. The
 * schedule can, and it is free.
 *
 * `https://statsapi.mlb.com/api/v1/schedule` answers with
 * `access-control-allow-origin: *` — measured 2026-09-10 with an explicit
 * `Origin: https://beanemachine.com` — so the deployed static site can call it
 * directly, with no server, no key and no proxy. One request covers the whole
 * league for a day: every game, its status, both probable starters, and the posted
 * batting orders once they exist.
 *
 * The one thing this file is careful about is the difference between *not playing*
 * and *not posted yet*. Lineups appear a few hours before first pitch — measured on
 * 2026-09-10, every Pre-Game and In Progress game carried nine names a side and
 * every Scheduled game carried none — so before then an absent name means nothing
 * at all. Reporting it as a benching would be the worst kind of wrong: confident,
 * actionable and false. `postedFor` is what separates the two, and every caller has
 * to consult it.
 */

/** MLB's own ids are the snapshot's ids — `data/snapshot.json` is built from the
 *  same API — so nothing has to be matched by name here. */
export interface TodayGame {
	gamePk: number
	/** ISO instant of first pitch. */
	startsAt: string
	homeTeamId: number
	awayTeamId: number
	homeAbbr: string
	awayAbbr: string
	/** MLB's own words: "Scheduled", "Pre-Game", "In Progress", "Final",
	 *  "Postponed". Kept verbatim rather than mapped, because a state this file
	 *  does not know about must not become one it does. */
	state: string
	venue: string | null
	homeProbable: number | null
	awayProbable: number | null
	/** Whether this game's batting orders have been published yet. */
	posted: boolean
}

export interface Slate {
	date: string
	games: TodayGame[]
	/** Every club with a game today. A man whose club is absent is not playing, and
	 *  that is knowable the moment the schedule loads — no waiting for a lineup. */
	playing: Set<number>
	/** Clubs whose batting order is published. Until a club is in here, silence
	 *  about one of its hitters means nothing. */
	postedFor: Set<number>
	/** Player id to his place in the order, 1-9, where the order is posted. */
	battingOrder: Map<number, number>
	/** Player id of every published probable starter today. */
	probables: Set<number>
	/** Which club each probable starter is throwing for, so an opponent can be
	 *  named without another request. */
	probableFor: Map<number, number>
}

/** The shape `hydrate=lineups,probablePitcher,team` returns, narrowed to what is
 *  read. Anything MLB adds is ignored rather than typed. */
interface RawGame {
	gamePk?: number
	gameDate?: string
	status?: { detailedState?: string }
	venue?: { name?: string }
	teams?: {
		home?: RawSide
		away?: RawSide
	}
	lineups?: {
		homePlayers?: { id?: number }[]
		awayPlayers?: { id?: number }[]
	}
}
interface RawSide {
	team?: { id?: number; abbreviation?: string; name?: string }
	probablePitcher?: { id?: number }
}

const EMPTY = (date: string): Slate => ({
	date,
	games: [],
	playing: new Set(),
	postedFor: new Set(),
	battingOrder: new Map(),
	probables: new Set(),
	probableFor: new Map()
})

/**
 * The parse, separate from the fetch, so it can be tested against a captured
 * response and so a malformed day cannot take the page down with it.
 */
export const readSlate = (date: string, json: unknown): Slate => {
	const out = EMPTY(date)
	const dates = (json as { dates?: { games?: RawGame[] }[] } | null)?.dates
	if (!Array.isArray(dates)) return out

	for (const day of dates) {
		for (const g of day.games ?? []) {
			const home = g.teams?.home
			const away = g.teams?.away
			const homeId = home?.team?.id
			const awayId = away?.team?.id
			if (typeof homeId !== "number" || typeof awayId !== "number") continue

			const homeNames = g.lineups?.homePlayers ?? []
			const awayNames = g.lineups?.awayPlayers ?? []
			// A club's order is posted or it is not. Nine is what MLB publishes — but
			// this asks only for "any", because a National League game with a pitcher
			// batting, a suspended game, or a future rule change should not be read as
			// "nobody is playing".
			const posted = homeNames.length > 0 || awayNames.length > 0

			out.games.push({
				gamePk: g.gamePk ?? 0,
				startsAt: g.gameDate ?? "",
				homeTeamId: homeId,
				awayTeamId: awayId,
				homeAbbr: home?.team?.abbreviation ?? home?.team?.name ?? String(homeId),
				awayAbbr: away?.team?.abbreviation ?? away?.team?.name ?? String(awayId),
				state: g.status?.detailedState ?? "Scheduled",
				venue: g.venue?.name ?? null,
				homeProbable: home?.probablePitcher?.id ?? null,
				awayProbable: away?.probablePitcher?.id ?? null,
				posted
			})

			out.playing.add(homeId).add(awayId)
			if (homeNames.length) out.postedFor.add(homeId)
			if (awayNames.length) out.postedFor.add(awayId)
			homeNames.forEach((p, i) => p.id && out.battingOrder.set(p.id, i + 1))
			awayNames.forEach((p, i) => p.id && out.battingOrder.set(p.id, i + 1))

			for (const [side, teamId] of [
				[home, homeId],
				[away, awayId]
			] as const) {
				const id = side?.probablePitcher?.id
				if (typeof id === "number") {
					out.probables.add(id)
					out.probableFor.set(id, teamId)
				}
			}
		}
	}
	return out
}

/** Today, as the reader's own clock has it. A slate is a local-calendar thing —
 *  a game at 7pm Eastern is tonight's game to somebody in California too. */
export const localDate = (now: Date = new Date()): string =>
	`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`

export const SLATE_URL = (date: string): string =>
	`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}` +
	`&hydrate=lineups,probablePitcher,team`

/**
 * One request, no server, no key.
 *
 * Failure is a state, not an exception: the page is useful without a slate and must
 * not go blank because MLB is slow. Callers get an empty slate and can say "couldn't
 * check today's lineups" rather than silently claiming everybody is playing.
 */
export const fetchSlate = async (
	date: string = localDate(),
	signal?: AbortSignal
): Promise<{ slate: Slate; error: string | null }> => {
	try {
		const res = await fetch(SLATE_URL(date), { signal })
		if (!res.ok) return { slate: EMPTY(date), error: `MLB answered HTTP ${res.status}` }
		return { slate: readSlate(date, await res.json()), error: null }
	} catch (e) {
		return { slate: EMPTY(date), error: (e as Error).message }
	}
}

/**
 * What today says about one man, in the words a lineup decision is made in.
 *
 * The four states are deliberately not collapsed. "Off today" is certain and
 * actionable now; "not in the posted lineup" is certain and actionable now; "lineup
 * not out yet" is the honest answer for most of the day and must not be dressed up
 * as either of the others.
 */
export type TodayStatus =
	| { kind: "no-game"; text: "no game today" }
	| { kind: "waiting"; text: "lineup not posted" }
	| { kind: "starting"; order: number; text: string }
	| { kind: "benched"; text: "not in today's lineup" }
	| { kind: "pitching"; text: string }

export const statusOf = (
	playerId: number,
	teamId: number | null | undefined,
	group: "hitting" | "pitching",
	slate: Slate
): TodayStatus => {
	if (slate.probables.has(playerId)) {
		const own = slate.probableFor.get(playerId)
		const game = slate.games.find(g => g.homeTeamId === own || g.awayTeamId === own)
		const opp =
			!game ? null
			: game.homeTeamId === own ? game.awayAbbr
			: game.homeAbbr
		return { kind: "pitching", text: opp ? `starts vs ${opp}` : "starts today" }
	}
	if (typeof teamId !== "number" || !slate.playing.has(teamId))
		return { kind: "no-game", text: "no game today" }
	// A pitcher who is not today's probable is not "benched" — most pitchers are not
	// starting on most days, and a reliever is available every day. Saying nothing is
	// the truthful answer.
	if (group === "pitching") return { kind: "waiting", text: "lineup not posted" }
	const order = slate.battingOrder.get(playerId)
	if (order) return { kind: "starting", order, text: `batting ${order}` }
	if (!slate.postedFor.has(teamId)) return { kind: "waiting", text: "lineup not posted" }
	return { kind: "benched", text: "not in today's lineup" }
}
