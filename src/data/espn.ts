/**
 * WHAT ESPN SAYS, IN ONE PLACE.
 *
 * ESPN answers a web page with JSON, which makes it the opposite of Yahoo in every way that
 * matters here: no reader to install, no HTML to parse, and — the part this file exists for —
 * a pile of facts a league states plainly that this app has been treating as unknowable.
 *
 * Three of them were being got wrong at once before this file existed, and all three were the
 * same mistake: a DEFAULT standing in front of an answer.
 *
 *   - the season came from `new Date().getFullYear()`, which is right nine months a year and
 *     silently wrong in the other three;
 *   - the lineup lock was null with a `needs_review` line saying ESPN does not state it, which
 *     it does, in `rosterSettings.lineupLocktimeType`;
 *   - the trade deadline was read only out of Yahoo's "Trade End Date" row, so an ESPN league
 *     whose window had shut was still offered trades.
 *
 * ── THE RULE THIS FILE IS WRITTEN UNDER ───────────────────────────────────────────────────
 *
 * A number ESPN states is used. A number ESPN does not state is null AND SAID TO BE NULL —
 * never zero, never a large stand-in, never a plausible default dressed as a reading. Where a
 * field exists but carries a value this code does not recognise, that is also null, and the
 * unrecognised value is quoted back so whoever reads the review line can go and look at it.
 * The cost of guessing here is not an ugly screen: it is telling a manager his league allows
 * a move it does not, on a screen whose whole purpose is telling him what to do.
 *
 * Every mapping below was measured on 2026-09-18 against
 * `lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons/2026/segments/0/leaguedefaults/3?view=mSettings`
 * and the raw values are quoted beside each one. `leaguedefaults/3` is ESPN's own template
 * league, which is the right place to learn the SHAPE of the settings and the wrong place to
 * learn any particular league's VALUES — so nothing here treats a value seen there as typical.
 */

/** The host that answers. `fantasy.espn.com/apis/v3` now 302s to a login wall for the same
 *  paths, measured 2026-09-04; `lm-api-reads` answers them. */
export const ESPN_API = "https://lm-api-reads.fantasy.espn.com/apis/v3"

/** ESPN's own name for fantasy baseball, in every path it serves. */
export const ESPN_BASEBALL = "flb"

/* ── the season ───────────────────────────────────────────────────────────────────────── */

/**
 * WHICH SEASON ESPN IS IN, asked rather than assumed.
 *
 * `new Date().getFullYear()` and ESPN's own answer agree from about April to December and
 * disagree for the months that matter most to somebody setting a league up: in January,
 * February and most of March, ESPN is still serving last year's league under last year's
 * season number, and a URL built with this year's is a 404 the reader is told nothing useful
 * about. Measured 2026-09-18: `/apis/v3/games/flb` → `"currentSeasonId":2026`, beside
 * `"currentScoringPeriod":{"id":177}`.
 *
 * It is one unauthenticated request, cached for the life of the process, and it FALLS BACK to
 * the calendar year rather than failing — an import that cannot reach ESPN at all is about to
 * fail anyway with a better message than this one could give, and a reader who is simply
 * offline should not be told his league does not exist.
 */
let seasonCache: { at: number; season: number } | null = null
const SEASON_TTL = 6 * 60 * 60 * 1000

export const espnSeason = async (
	fetchImpl: typeof fetch = fetch,
	headers: Record<string, string> = {},
	now: number = Date.now()
): Promise<{ season: number; asked: boolean }> => {
	if (seasonCache && now - seasonCache.at < SEASON_TTL)
		return { season: seasonCache.season, asked: true }
	try {
		const res = await fetchImpl(`${ESPN_API}/games/${ESPN_BASEBALL}`, { headers })
		if (res.ok) {
			const data = (await res.json()) as { currentSeasonId?: unknown }
			const id = Number(data?.currentSeasonId)
			/* A sanity window rather than trust: a season id outside it means the shape changed,
			   and building URLs out of a number that is not a year is how a reader gets a 404
			   that blames his league. */
			if (Number.isInteger(id) && id >= 2000 && id <= 2100) {
				seasonCache = { at: now, season: id }
				return { season: id, asked: true }
			}
		}
	} catch {
		/* offline, blocked, or ESPN having a day — the calendar year below */
	}
	return { season: new Date(now).getFullYear(), asked: false }
}

/** For tests, which must not inherit a season another test asked for. */
export const forgetEspnSeason = (): void => {
	seasonCache = null
}

/* ── the lineup lock ──────────────────────────────────────────────────────────────────── */

/**
 * WHEN A LEAGUE'S SEATS LOCK, which decides whether the whole Tonight card is worth showing.
 *
 * `rosterSettings.lineupLocktimeType`, measured `INDIVIDUAL_GAME` on the template league,
 * beside `rosterLocktimeType: "FIRSTGAME_SCORINGPERIOD"`.
 *
 * `INDIVIDUAL_GAME` means a seat locks when THAT player's game starts, so a manager can keep
 * changing the rest of his lineup all evening — `daily` in this app's vocabulary, the kind
 * whose suggestions can still be acted on. A lock at the first game of the period means the
 * lineup is set for the week and nothing the card suggests can be done about it — `period`.
 *
 * Anything else is null and quoted. "Treat unknown as still actionable" was the safe default
 * when nothing was known; it is not a licence to map an unfamiliar value optimistically,
 * because a wrong `daily` tells a reader to make changes his league will not take.
 */
export const espnLock = (
	settings: Record<string, any> | null | undefined
): { lock: "daily" | "period" | null; stated: string | null } => {
	const stated =
		typeof settings?.rosterSettings?.lineupLocktimeType === "string" ?
			(settings.rosterSettings.lineupLocktimeType as string)
		:	null
	if (stated === "INDIVIDUAL_GAME") return { lock: "daily", stated }
	if (stated === "FIRSTGAME_SCORINGPERIOD" || stated === "FIRST_GAME_OF_PERIOD")
		return { lock: "period", stated }
	return { lock: null, stated }
}

/* ── the trade deadline ───────────────────────────────────────────────────────────────── */

/**
 * THE DATE AFTER WHICH THIS LEAGUE TAKES NO MORE TRADES.
 *
 * `tradeSettings.deadlineDate`, an epoch in MILLISECONDS — measured 1786723200000, which is
 * 2026-08-14T16:00:00Z, noon Eastern. The units are worth stating because the same number in
 * seconds is 2026-08-14 in the year 58,584, and a deadline in the far future silently turns
 * the deadline check off for everybody.
 *
 * Rendered in AMERICA/NEW_YORK rather than UTC. A deadline set for 9pm Eastern is
 * `2026-08-15T01:00:00Z`, and slicing the UTC string would move it a day forward — closing a
 * trade window a day early for every league that sets an evening deadline, which is most of
 * them. League deadlines are league-local and every ESPN league keeps its clock in Eastern.
 *
 * `-1`, `0` and a missing field all mean no deadline, and no deadline is not a deadline that
 * has passed: null here leaves the trade screens fully up.
 */
const ET = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/New_York",
	year: "numeric",
	month: "2-digit",
	day: "2-digit"
})

export const espnTradeDeadline = (
	settings: Record<string, any> | null | undefined
): { date: string | null; source: string | null } => {
	const raw = settings?.tradeSettings?.deadlineDate
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
		return { date: null, source: null }
	/* A plausibility window, for the same reason the season has one: a number too small is
	   seconds and a number too large is something else, and either one read as milliseconds is
	   a deadline nobody stated. 2000-01-01 to 2100-01-01. */
	if (raw < 946_684_800_000 || raw > 4_102_444_800_000)
		return { date: null, source: `ESPN's trade deadline was ${raw}, which is not a date this reads` }
	const date = ET.format(new Date(raw))
	return { date, source: `ESPN states a trade deadline of ${date} (Eastern)` }
}
