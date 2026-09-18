/**
 * WHAT ESPN SAYS, AND WHAT THIS APP IS ALLOWED TO DO WITH IT.
 *
 * Three facts this app treated as unknowable are stated plainly by every ESPN league, and all
 * three were being answered with a default instead: the season with the calendar year, the
 * lineup lock with a `needs_review` line asserting ESPN does not state it, and the trade
 * deadline with Yahoo's row label, which an ESPN league does not have.
 *
 * The assertions below are mostly about the ways a reading can be WRONG rather than missing:
 * epoch seconds read as milliseconds, a UTC slice moving an evening deadline a day forward,
 * an unrecognised lock value mapped optimistically to the answer that keeps a screen up. Each
 * of those produces a confident sentence on a screen a manager acts on, which is the failure
 * this file exists to prevent.
 */
import {
	espnLock,
	espnSeason,
	espnTradeDeadline,
	forgetEspnSeason,
	ESPN_API
} from "../src/data/espn.ts"
import { deriveEspnPeriod, leagueTradeDeadline, deriveTradeDeadline } from "../src/import.ts"

let pass = 0,
	fail = 0
const t = (n, ok, x = "") => {
	ok ? pass++ : fail++
	console.log(`${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : "  " + x}`)
}

/* ── the lineup lock ──────────────────────────────────────────────────────────────────── */
{
	/* Measured 2026-09-18 on ESPN's own template league: `lineupLocktimeType: "INDIVIDUAL_GAME"`,
	   beside `rosterLocktimeType: "FIRSTGAME_SCORINGPERIOD"`. */
	const daily = espnLock({ rosterSettings: { lineupLocktimeType: "INDIVIDUAL_GAME" } })
	t("a seat that locks at its own game is a daily lineup", daily.lock === "daily", daily.lock)
	t("and the value ESPN stated is carried, so a review line can quote it",
		daily.stated === "INDIVIDUAL_GAME")

	t("a lock at the first game of the period is a weekly lineup",
		espnLock({ rosterSettings: { lineupLocktimeType: "FIRSTGAME_SCORINGPERIOD" } }).lock === "period")

	/* The important one. An unfamiliar value is NOT mapped to the answer that keeps the Tonight
	   card up: a wrong `daily` tells a reader to make changes his league will not take. */
	const odd = espnLock({ rosterSettings: { lineupLocktimeType: "SOMETHING_NEW" } })
	t("a lock this does not recognise is unknown, not daily", odd.lock === null, String(odd.lock))
	t("…and is quoted back rather than swallowed", odd.stated === "SOMETHING_NEW")

	t("no settings at all is unknown", espnLock(null).lock === null)
	t("and settings with no roster block is unknown", espnLock({ scheduleSettings: {} }).lock === null)
	t("a non-string lock is not a lock",
		espnLock({ rosterSettings: { lineupLocktimeType: 3 } }).stated === null)
}

/* ── the lock reaches the league ──────────────────────────────────────────────────────── */
{
	const full = deriveEspnPeriod({
		scheduleSettings: { matchupPeriodLength: 1, matchupPeriods: { 1: [1], 2: [2], 21: [21] } },
		rosterSettings: { lineupLocktimeType: "INDIVIDUAL_GAME" }
	})
	t("an imported ESPN league carries the lock its settings stated",
		full.period.lineup_lock === "daily", String(full.period.lineup_lock))
	t("and says nothing about it needing review",
		!full.needsReview.some(r => /lineup lock/i.test(r)), JSON.stringify(full.needsReview))

	/*
	   THE HALF THAT USED TO BE THROWN AWAY.
	
	   The lock and the period live in different blocks of ESPN's settings and fail
	   independently. When this read the lock beside the period, a league whose
	   `scheduleSettings` could not be read returned null for BOTH — a fact ESPN stated
	   perfectly well, discarded because a different fact was missing.
	*/
	const noSchedule = deriveEspnPeriod({
		rosterSettings: { lineupLocktimeType: "FIRSTGAME_SCORINGPERIOD" }
	})
	t("a league with no readable schedule still carries the lock ESPN stated",
		noSchedule.period.lineup_lock === "period", String(noSchedule.period.lineup_lock))
	/* The sentence is checked by what it TELLS HIM, not by a field name — the same rewrite the
	   assertion in test/leagues.mjs forced, for the same reason: this string is printed. */
	t("…and still says the period could not be read",
		noSchedule.needsReview.some(r => /nothing about this league's schedule/.test(r)),
		noSchedule.needsReview.join(" | "))

	const silent = deriveEspnPeriod({ scheduleSettings: { matchupPeriodLength: 1, matchupPeriods: { 1: [1], 21: [21] } } })
	t("a league that states no lock is left unknown and says so",
		silent.period.lineup_lock === null &&
			silent.needsReview.some(r => /still actionable/.test(r)),
		JSON.stringify(silent.needsReview))
}

/* ── the trade deadline ───────────────────────────────────────────────────────────────── */
{
	/* Measured: 1786723200000 → 2026-08-14T16:00:00Z, noon Eastern. */
	const real = espnTradeDeadline({ tradeSettings: { deadlineDate: 1786723200000 } })
	t("ESPN's epoch deadline is read as a date", real.date === "2026-08-14", String(real.date))
	t("and quotes itself in words a screen can print",
		/2026-08-14/.test(real.source ?? "") && !/deadlineDate/.test(real.source ?? ""),
		String(real.source))

	/*
	   UNITS AND TIMEZONE, the two ways this is wrong without looking wrong.
	
	   A 9pm Eastern deadline is 01:00Z the NEXT day. Slicing the UTC string would close the
	   trade window a day early for every league that sets an evening deadline, which is most of
	   them. 2026-08-15T01:00:00Z is 2026-08-14 in New York, and that is the day the league means.
	*/
	const evening = espnTradeDeadline({ tradeSettings: { deadlineDate: Date.parse("2026-08-15T01:00:00Z") } })
	t("an evening deadline is the day the league is in, not the day UTC is in",
		evening.date === "2026-08-14", String(evening.date))

	/* The same number in SECONDS is a date in the year 58,584 — a deadline in the far future
	   silently turns the check off for everybody, so it is refused rather than read. */
	const seconds = espnTradeDeadline({ tradeSettings: { deadlineDate: 1786723200 } })
	t("an epoch in seconds is refused rather than read as the year 58,584",
		seconds.date === null, String(seconds.date))
	t("…and says what it saw", /1786723200/.test(seconds.source ?? ""))

	t("-1 is no deadline, not a date", espnTradeDeadline({ tradeSettings: { deadlineDate: -1 } }).date === null)
	t("0 is no deadline", espnTradeDeadline({ tradeSettings: { deadlineDate: 0 } }).date === null)
	t("a missing block is no deadline", espnTradeDeadline({}).date === null)
	t("and no deadline quotes nothing, because there is nothing to quote",
		espnTradeDeadline({}).source === null)
}

/* ── one deadline, whichever platform the league came from ────────────────────────────── */
{
	const espnLeague = {
		meta: { platform: "espn" },
		league_rules: { raw_settings: { tradeSettings: { deadlineDate: 1786723200000 } } }
	}
	t("an ESPN league's deadline is found through the league",
		leagueTradeDeadline(espnLeague).date === "2026-08-14",
		String(leagueTradeDeadline(espnLeague).date))

	const yahooLeague = {
		meta: { platform: "yahoo" },
		league_rules: { raw_settings: { "Trade End Date": "August 6, 2026" } }
	}
	t("and a Yahoo league's is still read off its printed row",
		leagueTradeDeadline(yahooLeague).date === deriveTradeDeadline(yahooLeague.league_rules.raw_settings).date)
	t("…which is 2026-08-06, the date this project's own league shut on",
		leagueTradeDeadline(yahooLeague).date === "2026-08-06")

	/*
	   THE BUG THIS DISPATCH EXISTS FOR: ESPN's nested settings handed to the ROW reader looks up
	   a key that is not there and answers "no deadline stated", which reads on screen as a trade
	   window that is still open.
	*/
	t("ESPN's settings read as Yahoo rows would have said nothing at all",
		deriveTradeDeadline(espnLeague.league_rules.raw_settings).date === null)

	t("a league with no rules at all is no deadline", leagueTradeDeadline({ league_rules: {} }).date === null)
	t("and neither is nothing", leagueTradeDeadline(null).date === null)
}

/* ── the season ───────────────────────────────────────────────────────────────────────── */
{
	const answer = body => async url => ({
		ok: true,
		json: async () => body,
		url
	})
	forgetEspnSeason()
	let asked = []
	const spy = async url => {
		asked.push(url)
		return { ok: true, json: async () => ({ currentSeasonId: 2026 }) }
	}
	/* January 2027, when the calendar year and ESPN disagree — the months somebody actually
	   sets a league up in. */
	const jan = Date.parse("2027-01-15T12:00:00Z")
	const got = await espnSeason(spy, {}, jan)
	t("ESPN's own season beats the calendar year", got.season === 2026, String(got.season))
	t("and it says it asked", got.asked === true)
	t("it asked the games endpoint, not a league's", asked[0] === `${ESPN_API}/games/flb`, asked[0])

	const again = await espnSeason(spy, {}, jan + 60_000)
	t("a second caller inside the window asks nobody", asked.length === 1 && again.season === 2026,
		String(asked.length))
	const later = await espnSeason(spy, {}, jan + 7 * 60 * 60 * 1000)
	t("and seven hours later it asks again", asked.length === 2 && later.season === 2026)

	forgetEspnSeason()
	const offline = await espnSeason(async () => {
		throw new Error("getaddrinfo ENOTFOUND")
	}, {}, jan)
	t("offline falls back to the calendar year rather than failing the import",
		offline.season === 2027, String(offline.season))
	t("…and says it did not ask", offline.asked === false)

	forgetEspnSeason()
	const refused = await espnSeason(async () => ({ ok: false, status: 503, json: async () => ({}) }), {}, jan)
	t("a 503 falls back the same way", refused.season === 2027 && refused.asked === false)

	/* A season id that is not a year means the shape changed, and building URLs out of it is a
	   404 that reads to the reader as "your league is gone". */
	forgetEspnSeason()
	const nonsense = await espnSeason(answer({ currentSeasonId: "the 2026 season" }), {}, jan)
	t("a season that is not a year is refused, not formatted into a URL",
		nonsense.season === 2027 && nonsense.asked === false, String(nonsense.season))
	forgetEspnSeason()
	const zero = await espnSeason(answer({ currentSeasonId: 0 }), {}, jan)
	t("and neither is zero", zero.season === 2027)
	forgetEspnSeason()
	const empty = await espnSeason(answer({}), {}, jan)
	t("an answer with no season in it falls back", empty.season === 2027)
	forgetEspnSeason()
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail ? 1 : 0)
