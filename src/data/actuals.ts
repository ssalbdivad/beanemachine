import { KEPT_STATS } from "../engine/points.ts"
import type { StatLine } from "./statsapi.ts"

/**
 * WHAT ACTUALLY HAPPENED, for one day, for every man in baseball.
 *
 * Everything else in this app is a projection: an average over a window, blended,
 * volume-scaled, and honest about being an estimate. This file is the other kind of
 * number — the one the league already paid out. It exists because the app could not
 * answer the question a manager asks every single morning, which is not "who should I
 * pick up" but "what happened, and was that the right call?"
 *
 * MLB's own `byDateRange` read answers it: one request per side of the ball returns
 * every player who appeared on a given date, with the counting stats a league scores.
 * Measured 2026-09-11 against a live response for 2026-09-11: 353 hitting splits in
 * 386 KB and 133 pitching splits in 211 KB, uncompressed. It sends
 * `access-control-allow-origin: *`, so the deployed static site can ask it directly
 * and no backend has to exist for a recap to be real.
 *
 * THE ABSENCE IS THE POINT. A man who did not appear has no split at all, and that is
 * a different fact from a man who appeared and scored nothing — 0 points with a game
 * played is a bad night, 0 points with no game is a seat you should not have used. The
 * map below therefore holds only men who PLAYED, and every caller is expected to treat
 * a missing key as "did not play" rather than as zero. Collapsing the two would invent
 * the most useful sentence on the screen out of nothing.
 */

/** One man's real line for the day, keyed the way a roster keys him. */
export interface ActualLine {
	/** `id:group`, matching `rosterKey` in src/client/roster.ts — a two-way player has
	 *  two lines and only a roster knows which of them you hold. */
	key: string
	id: number
	name: string
	team: string | null
	teamId: number | null
	group: "hitting" | "pitching"
	/** Filtered to the fields anything here can score or read, same as a capture. */
	stats: StatLine
}

export interface Actuals {
	date: string
	/** Only men who appeared. A missing key means he did not play — never zero. */
	lines: Map<string, ActualLine>
}

/**
 * One day by default, a RANGE when asked — and the range is what makes the second caller
 * cheap.
 *
 * `byDateRange` accumulates strictly inside the window, so "every inning my pitchers have
 * already thrown in this scoring period" is ONE request per side of the ball rather than one
 * per day: a seven-day period costs two reads, not fourteen. The recap wants a single day and
 * passes one date; the innings floor wants the period so far and passes two.
 */
export const ACTUALS_URL = (
	season: number,
	group: "hitting" | "pitching",
	start: string,
	end: string = start
): string =>
	`https://statsapi.mlb.com/api/v1/stats?stats=byDateRange&group=${group}` +
	`&season=${season}&sportId=1&playerPool=All&limit=3000` +
	`&startDate=${start}&endDate=${end}`

const asNumber = (v: unknown): number | null => {
	if (typeof v === "number") return Number.isFinite(v) ? v : null
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v)
		return Number.isFinite(n) ? n : null
	}
	return null
}

/**
 * The parse, separated from the request so it can be tested without one.
 *
 * Tolerant in exactly one direction: a response with no `stats`, no `splits`, or a
 * split with no player id contributes nothing and does not throw. A day with no
 * baseball on it is a real day and returns an empty map.
 */
export const readActuals = (
	group: "hitting" | "pitching",
	json: unknown
): ActualLine[] => {
	const splits = (json as any)?.stats?.[0]?.splits
	if (!Array.isArray(splits)) return []
	const out: ActualLine[] = []
	for (const s of splits) {
		const id = s?.player?.id
		if (typeof id !== "number") continue
		const stats: StatLine = {}
		for (const [k, v] of Object.entries(s?.stat ?? {})) {
			if (!KEPT_STATS.has(k)) continue
			const n = asNumber(v)
			if (n !== null) stats[k] = n
		}
		out.push({
			key: `${id}:${group}`,
			id,
			name: s?.player?.fullName ?? "",
			team: s?.team?.name ?? null,
			teamId: s?.team?.id ?? null,
			group,
			stats
		})
	}
	return out
}

/**
 * Longer than the slate's five seconds, and for the opposite reason.
 *
 * `SLATE_TIMEOUT_MS` in today.ts is short because the slate decorates a board that
 * already works — five seconds spent learning that a shortstop is off tonight is five
 * seconds wasted. Here the request IS the screen: there is no recap without it, and a
 * reader who opened "How it went" has asked for exactly this and nothing else. The
 * payload is also two orders larger than the slate's, and the two reads together were
 * 597 KB uncompressed on 2026-09-11, so a slow phone needs room that the slate does
 * not. Still bounded, because a hang is the one failure a try/catch cannot see.
 */
const TIMEOUT_MS = 12_000

/**
 * Both sides of the ball, in parallel, failure as a state.
 *
 * A partial answer is worth having and is reported as partial: if pitching comes back
 * and hitting does not, the hitters are missing and `error` says so, rather than the
 * whole screen going blank over half a day. What must never happen is a missing side
 * being read as a roster full of men who did not play.
 */
export const fetchActuals = async (
	season: number,
	date: string,
	signal?: AbortSignal,
	timeoutMs: number = TIMEOUT_MS,
	/** Inclusive end of the window. Defaults to `date`, which is one day. */
	end: string = date,
	/** Which sides of the ball to ask for. The innings floor needs only pitchers, and
	 *  asking for hitters too would double a request for a number nothing reads. */
	groups: ("hitting" | "pitching")[] = ["hitting", "pitching"]
): Promise<{ actuals: Actuals; error: string | null }> => {
	const deadline = AbortSignal.timeout(timeoutMs)
	const abort = signal ? AbortSignal.any([signal, deadline]) : deadline
	const one = async (group: "hitting" | "pitching"): Promise<ActualLine[]> => {
		const res = await fetch(ACTUALS_URL(season, group, date, end), { signal: abort })
		if (!res.ok) throw new Error(`MLB answered HTTP ${res.status} for ${group}`)
		return readActuals(group, await res.json())
	}
	const both = await Promise.allSettled(groups.map(one))
	const lines = new Map<string, ActualLine>()
	for (const r of both)
		if (r.status === "fulfilled") for (const line of r.value) lines.set(line.key, line)
	const failed = both.filter(r => r.status === "rejected") as PromiseRejectedResult[]
	return {
		actuals: { date, lines },
		error:
			!failed.length ? null
			: deadline.aborted ? `MLB did not answer within ${timeoutMs / 1000}s`
			: failed.map(f => (f.reason as Error).message).join("; ")
	}
}
