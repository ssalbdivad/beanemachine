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
): {
	date: string | null
	source: string | null
	/** The INSTANT ESPN stated, in epoch milliseconds, where it stated one.
	 *
	 *  A deadline is a moment and a date is a day, and a day is what the rest of this app
	 *  compares against — so on the deadline day itself the trade screens stayed up for the
	 *  hours after it had passed, offering to price deals the league would no longer take.
	 *  Carried so a caller with a clock can be exact; the date remains for the callers and
	 *  the stores that only have one. */
	at: number | null
} => {
	const raw = settings?.tradeSettings?.deadlineDate
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
		return { date: null, source: null, at: null }
	/* A plausibility window, for the same reason the season has one: a number too small is
	   seconds and a number too large is something else, and either one read as milliseconds is
	   a deadline nobody stated. 2000-01-01 to 2100-01-01. */
	if (raw < 946_684_800_000 || raw > 4_102_444_800_000)
		return {
			date: null,
			at: null,
			source: `ESPN's trade deadline was ${raw}, which is not a date this reads`
		}
	const date = ET.format(new Date(raw))
	return { date, at: raw, source: `ESPN states a trade deadline of ${date} (Eastern)` }
}

/* ── what kind of league it is ────────────────────────────────────────────────────────── */

/**
 * WHETHER THIS APP CAN PRICE THIS LEAGUE AT ALL.
 *
 * Everything downstream — the board's ranking, the Tonight card, the trade evaluator — is a
 * number of POINTS, and it is computed from a table of points per stat. A category league
 * does not have one. It has eleven categories a team wins or loses, and no point value
 * anywhere, which is a different game that happens to be played with the same players.
 *
 * The Yahoo path has always refused this: a settings page with no points table throws, and
 * the message says it may be a roto or categories league. The ESPN path could not refuse it,
 * because ESPN's category leagues DO carry a `scoringItems` array — with `points: 1.0` in
 * every entry, meaning "this category counts", not "a home run is worth one point". Measured
 * on ESPN's own H2H_CATEGORY template: six of eleven ids are ones this app's stat map can
 * name, so six of them landed in `scoring.batting`/`scoring.pitching` as 1.0 apiece and the
 * import reported a league whose scoring had been read. A board built on that table ranks a
 * single against a home run as equals and prices a strikeout the same as a save.
 *
 * So the refusal is on ESPN's own word for the format, and every value this does not KNOW to
 * be a points format is refused too. That is the direction the cost is asymmetric in: a
 * refusal tells a reader plainly that his league is not one this ranks, and the alternative
 * is a confident board he has no way of checking.
 */
const POINTS_FORMATS = new Set(["H2H_POINTS", "TOTAL_SEASON_POINTS", "POINTS"])

export const espnPointsFormat = (
	settings: Record<string, any> | null | undefined
): { ok: boolean; stated: string | null; why: string | null } => {
	const stated =
		typeof settings?.scoringSettings?.scoringType === "string" ?
			(settings.scoringSettings.scoringType as string)
		:	null
	if (stated && POINTS_FORMATS.has(stated)) return { ok: true, stated, why: null }
	if (stated === null)
		return {
			ok: false,
			stated,
			why:
				"ESPN did not say how that league scores, and this app can only rank a league " +
				"that pays points per stat."
		}
	const known = /CATEGOR/i.test(stated) || stated === "ROTO"
	return {
		ok: false,
		stated,
		why:
			known ?
				"That is a categories league — teams win or lose each category rather than " +
					"scoring points — and this app ranks by points, so it cannot price it."
			:	`ESPN calls that league's scoring ${stated}, which this app does not know how to ` +
				`price. It ranks leagues that pay points per stat.`
	}
}

/* ── the two per-period rules ─────────────────────────────────────────────────────────── */

/**
 * HOW MANY MEN A MANAGER MAY ADD IN ONE SCORING PERIOD.
 *
 * Yahoo prints "Max Acquisitions per Week" and this app reads that row. ESPN states the same
 * rule in `acquisitionSettings`, and the field to read is `matchupAcquisitionLimit` — NOT
 * `acquisitionLimit`, which is the SEASON cap and would tell a reader in April that he may
 * make forty moves before Sunday. `rosterSettings.moveLimit` is not it either: it sits in the
 * block that governs lineup locking, and what it counts was never measured in any league that
 * populated it, so it is left alone rather than guessed at.
 *
 * `-1` is ESPN's unlimited sentinel, and unlimited is null here — not a large stand-in — for
 * the same reason "No maximum" is null on the Yahoo side: a planner handed null falls back to
 * its own measured default, and a planner handed 40 believes the league said 40.
 *
 * THE UNIT IS THE HARD PART, and it is why this returns a note as well as a number.
 * `matchupLimitPerScoringPeriod` decides whether the cap is per MATCHUP or per SCORING
 * PERIOD, and in ESPN baseball a scoring period is a DAY while a matchup is usually a week.
 * A cap of 1 per day and a cap of 1 per week are the same number and a sevenfold difference
 * in what a manager may do. Measured across fifteen payloads, the flag is true exactly when
 * the season has more than one matchup period — so on a weekly league the cap is per day, and
 * the week's budget is that number times the days in the period.
 *
 * Multiplying is arithmetic on two stated facts, not a guess, and it is the number a planner
 * needs; what it cannot carry is that the days are not interchangeable — six moves in a week
 * whose cap is one a day cannot all be made on Saturday. That constraint is stated in the
 * source sentence rather than silently lost, and `days` is only supplied by a caller that
 * knows the period length from the league's own settings.
 */
export const espnMoveLimit = (
	settings: Record<string, any> | null | undefined,
	daysInPeriod: number | null
): { perPeriod: number | null; source: string | null; note: string | null } => {
	const acq = settings?.acquisitionSettings
	const raw = acq?.matchupAcquisitionLimit
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
		return { perPeriod: null, source: null, note: null }
	/*
	   A MATCHUP FIELD IN A FORMAT WITH NO MATCHUPS, which reads 0 and means nothing.
	
	   Measured 2026-09-18 across ESPN's own templates: `matchupAcquisitionLimit` is -1 — the
	   unlimited sentinel — in every head-to-head league, and 0 in every season-long one (flb
	   defaults 1, 5, 6 and 7), where the field does not apply at all. Those leagues state their
	   real cap in `acquisitionLimit`, and it is -1 there too.
	
	   Read as a cap, that 0 was a planner told the league allows NO acquisitions: `movesAllowed`
	   takes the lower of the stated cap and its own rail, so every plan came back with no
	   pickups and the note "your league allows 0 acquisitions a week". A league ESPN said was
	   unlimited, planned as forbidden — which is the worst direction for this field to be wrong
	   in, because the reader cannot tell a rule from a bug.
	
	   The discriminator is the schedule rather than the number: a league with more than one
	   matchup period has matchups, and its matchup field means what it says — including a 0,
	   which is a real and stateable rule. A league with one period or none does not, and the
	   field is ignored rather than read.
	*/
	const periods = Number(settings?.scheduleSettings?.matchupPeriodCount)
	const hasMatchups = Number.isFinite(periods) && periods > 1
	if (!hasMatchups)
		return {
			perPeriod: null,
			source: null,
			note:
				raw > 0 ?
					`ESPN states a per-matchup limit of ${raw} for a league that plays no matchups, ` +
					`so no period budget is claimed from it.`
				:	null
		}
	const perScoringPeriod = acq?.matchupLimitPerScoringPeriod === true
	if (!perScoringPeriod)
		return {
			perPeriod: raw,
			source: `ESPN states a limit of ${raw} added players per matchup`,
			note: null
		}
	if (!daysInPeriod || daysInPeriod < 1)
		return {
			perPeriod: null,
			source: null,
			/* The cap is real and its unit is a day; without the period length there is no
			   honest weekly number, and inventing one is the failure this whole file is written
			   against. Said rather than dropped, because "unlimited" is what null means to a
			   planner and this league is not unlimited. */
			note:
				`ESPN caps added players at ${raw} a day, and this does not know how long your ` +
				`scoring period runs, so no weekly budget is claimed.`
		}
	const total = raw * daysInPeriod
	return {
		perPeriod: total,
		source:
			`ESPN states a limit of ${raw} added player${raw === 1 ? "" : "s"} a day, which is ` +
			`${total} across a ${daysInPeriod}-day period`,
		note:
			raw * daysInPeriod === total && daysInPeriod > 1 ?
				`Those ${total} are ${raw} a day rather than ${total} to spend at once.`
			:	null
	}
}

/**
 * THE INNINGS FLOOR, WHICH AN ESPN POINTS LEAGUE DOES NOT HAVE.
 *
 * Yahoo prints "Min innings pitched per team per week" and a lot of streaming happens because
 * of it. The nearest thing in ESPN's settings is `scoringSettings.statQualificationMinimum`,
 * and it is NOT the same rule — twice over:
 *
 *   IT IS IN OUTS, NOT INNINGS. Its `statId` is 34, which this project's own stat map already
 *   names as outs recorded, re-confirmed player by player against MLB StatsAPI. The measured
 *   `limitValue: 30` is ten innings, not thirty. A floor read three times too high would have
 *   the planner streaming pitchers a reader does not need.
 *
 *   IT IS A CATEGORY-FORMAT RULE. ESPN's ROTO template states 3000 outs — a thousand innings,
 *   which is a whole season's staff — and a real H2H_POINTS league omits the field entirely.
 *   So it is a qualification threshold for a scoring window, not a per-week floor, and a
 *   points league does not carry one at all.
 *
 * The honest answer for a points league is therefore null, and null is SAID: the screens that
 * print an innings floor print nothing rather than a number nobody set. Where the field is
 * present it is converted and named as what it is, so a future caller has the measurement
 * rather than the field.
 */
export const espnInningsMinimum = (
	settings: Record<string, any> | null | undefined
): { perPeriod: number | null; source: string | null; note: string | null } => {
	const min = settings?.scoringSettings?.statQualificationMinimum
	if (!min || typeof min.limitValue !== "number") return { perPeriod: null, source: null, note: null }
	/* Only outs are convertible. Any other stat id is a qualification rule about something
	   else entirely and is named rather than turned into innings. */
	if (min.statId !== 34)
		return {
			perPeriod: null,
			source: null,
			note: `ESPN states a qualification minimum this does not recognise (stat ${min.statId}).`
		}
	const innings = min.limitValue / 3
	return {
		perPeriod: null,
		source: null,
		/* NOT returned as a per-period floor, however tempting: on ESPN's own roto template the
		   same field reads 3000 outs, which is a thousand innings and a whole season's staff.
		   Read as a weekly floor it would tell a reader he is a thousand innings short every
		   week. It is reported, in innings, for whoever wires up a category league. */
		note:
			`ESPN states a qualifying total of ${innings} innings for the whole scoring window, ` +
			`which is not a per-week floor, so none is claimed.`
	}
}

/* ── which days this league's current matchup runs over ───────────────────────────────── */

/** A date `n` days after an ISO date, in ISO. Calendar arithmetic in UTC on a date-only
 *  string, which has no hours to shift and therefore no timezone to get wrong. */
const plus = (iso: string, n: number): string =>
	new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** The Monday on or before a date. `getUTCDay` is 0 for Sunday, so Monday is 1. */
const mondayOnOrBefore = (iso: string): string => {
	const day = new Date(`${iso}T00:00:00Z`).getUTCDay()
	return plus(iso, -((day + 6) % 7))
}

/**
 * THE DAYS THE READER'S CURRENT MATCHUP ACTUALLY RUNS OVER.
 *
 * ESPN states its schedule in SCORING PERIODS, which in baseball are calendar days counted
 * from the season's first regular-season game — measured on two seasons and exact in both:
 * for 2021, `finalScoringPeriod` 186 against an opening day of 2021-04-01 lands on
 * 2021-10-03, which is the day that season ended; for 2026, period 177 was the current one on
 * 2026-09-17 against an opening day of 2026-03-25.
 *
 * What the app needed and did not have is the START of the current matchup. Without it an
 * imported ESPN league fell back to "assume Monday", and during the playoffs to a seven-day
 * window over a fortnight-long round — so every figure computed across the period, on both
 * sides of the matchup, was half the matchup he was playing.
 *
 * THE DERIVATION, and every field in it is stated by the league rather than guessed:
 *
 *   dateOf(n)      = opening day + (n - 1) days
 *   weekOneMonday  = the Monday on or before dateOf(status.firstScoringPeriod)
 *   units          = settings.scheduleSettings.matchupPeriods[status.currentMatchupPeriod]
 *   start          = weekOneMonday + (units[0] - 1) * 7, never before the league's first day
 *   end            = start + (units.length * 7) - 1, never after the league's last day
 *
 * `matchupPeriods` is what makes the playoffs come out right: a regular-season matchup lists
 * one unit and a playoff round lists two, so the span falls out of the league's own map
 * rather than out of a rule about playoffs. Checked against league 81134470's 2021 season,
 * whose matchup 23 lists units [24, 25] and runs 2021-09-20 to 2021-10-03.
 *
 * Returns null the moment any part of it is missing, because half a derivation here is a
 * window that looks authoritative and is not the reader's.
 */
export const espnMatchupDays = (
	status: Record<string, any> | null | undefined,
	sched: Record<string, any> | null | undefined,
	/** The season's first regular-season game day, ISO. Scoring period 1. */
	openingDay: string | null
): { start: string; end: string; days: number; matchup: number } | null => {
	if (!openingDay || !/^\d{4}-\d{2}-\d{2}$/.test(openingDay)) return null
	const first = Number(status?.firstScoringPeriod)
	const current = Number(status?.currentMatchupPeriod)
	const final = Number(status?.finalScoringPeriod)
	if (!Number.isInteger(first) || first < 1) return null
	if (!Number.isInteger(current) || current < 1) return null
	const units = (sched?.matchupPeriods as Record<string, unknown> | undefined)?.[String(current)]
	const list =
		Array.isArray(units) ? units.map(Number).filter(n => Number.isInteger(n) && n > 0) : []
	if (!list.length) return null

	const dateOf = (n: number): string => plus(openingDay, n - 1)
	const leagueStart = dateOf(first)
	const leagueEnd = Number.isInteger(final) && final > 0 ? dateOf(final) : null
	const weekOne = mondayOnOrBefore(leagueStart)
	let start = plus(weekOne, (Math.min(...list) - 1) * 7)
	if (start < leagueStart) start = leagueStart
	let end = plus(plus(weekOne, (Math.max(...list) - 1) * 7), 6)
	if (leagueEnd && end > leagueEnd) end = leagueEnd
	if (end < start) return null
	const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
	return { start, end, days, matchup: current }
}

/**
 * THE DAY THE SEASON STARTED, asked of the one source this app already trusts for a calendar.
 *
 * ESPN's scoring period 1 is the first day of the regular season, and MLB's own schedule is
 * where this app reads every other date it uses. Two independent confirmations that they
 * agree: 2026 opens 2026-03-25 (one game, NYY at SF) and ESPN's period 177 was current on
 * 2026-09-17, which is 176 days later; 2021 opens 2021-04-01 and ESPN's final period for that
 * season, 186, is 2021-10-03, which is the day the 2021 season ended.
 *
 * `gameType=R` matters: without it the window picks up spring training, and 2026 has ten
 * exhibition games on 2026-03-24 — the day before the opener, which would move every date in
 * the derivation by one.
 *
 * Null rather than a guess when it cannot be read, which makes the caller fall back to what it
 * did before rather than to a calendar nobody checked.
 */
export const openingDayOf = async (
	season: number,
	fetchImpl: typeof fetch = fetch
): Promise<string | null> => {
	try {
		const res = await fetchImpl(
			`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R` +
				`&startDate=${season}-03-01&endDate=${season}-04-15`
		)
		if (!res.ok) return null
		const data = (await res.json()) as { dates?: { date?: string; games?: unknown[] }[] }
		for (const day of data.dates ?? [])
			if (typeof day.date === "string" && (day.games?.length ?? 0) > 0) return day.date
		return null
	} catch {
		return null
	}
}
