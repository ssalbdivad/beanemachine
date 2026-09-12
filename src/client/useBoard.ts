import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Contact, Snapshot } from "../data/snapshot.ts"
import { hydrate } from "../data/snapshot.ts"
import {
	likelyAvailable, ownershipCut, rateAll, withMarketEdge, withUndervaluation,
	type OwnershipCut, type Ranked
} from "../engine/bscore.ts"
import type { League } from "../schema.ts"
import { resolvePeriod, windowFrom, withinDays } from "../engine/period.ts"
import { localDate } from "../data/today.ts"
import { useInjuries } from "./useInjuries.ts"
import { normalizeName } from "../data/names.ts"

export type { Ranked }

/**
 * A ranked player plus the one fact the board could not previously answer without
 * a server: can the reader actually add him.
 *
 * `true` / `false` are claims; `null` is the refusal to make one. Nothing is hidden
 * on a null — a man we cannot price is a man we have no grounds to remove.
 */
export type BoardRow = Ranked & {
	free: boolean | null
	/**
	 * What ADDING him would gain over the man he would actually displace on YOUR
	 * roster, in this league's points, over the window on screen.
	 *
	 * bscore prices every row against a generic (teams x seats)-th man — the bar for
	 * the league, not for you. It is the right unit for "who is the best available
	 * player" and it is not the unit a manager makes a move in, because he is not
	 * choosing between this man and an abstraction, he is choosing between this man
	 * and the worst man he owns who could hold that seat. Two of them can differ by
	 * a lot: a deep outfield makes a good free-agent outfielder worth nothing to you
	 * and a hole at catcher makes a mediocre one worth a great deal.
	 *
	 * Null means the question does not apply — he is already yours, nobody you own
	 * is eligible for a seat he could take, or no roster has been entered. Null is
	 * not zero and must never render as one.
	 */
	deltaMine: number | null
}

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

/**
 * Which of the four things is true about the expected-stats rows RIGHT NOW.
 *
 * Four, not three, and the fourth is the one worth naming: "nobody has asked for
 * them" is a different state from "they failed", and a panel that treated the two
 * alike would say the load failed on a board nothing had tried to load. Failure is a
 * state in this app and never an exception, so it is in this union rather than in a
 * catch block somewhere.
 */
export type ContactStatus = "unasked" | "loading" | "ready" | "failed"

/**
 * The expected-stats rows, fetched when something actually needs them.
 *
 * They are `data/contact.json` — 299,805 bytes, 48,528 gzipped at level 9, 1,505 rows
 * — and they used to be 22.42% of the snapshot, which vite.config.ts asks for in full
 * from the first byte of markup because nothing can be ranked until it lands. So every
 * reader paid for them on the cold path to render numbers that live behind a
 * drill-down, and the measurement that settles whether that was worth it is in
 * model.json: `statcast.weight` is 0, so the rows move no ranking. Proved on the
 * committed capture rather than argued — `rateAll` with the rows and without them
 * agrees on `bscore`, `points`, `addValue`, `replacement`, `slot` and the row ORDER for
 * all 1,446 rated players, and differs only in the four fields that are about the rows
 * themselves (`underlying`, `regressionGap`, `confidence`, `undervaluation`) plus the
 * two provenance lists.
 *
 * Deliberately NOT prefetched: a second request issued beside the snapshot's would put
 * the same bytes back on the same path under a different name. `ask` is called by the
 * drill-down, which is the one surface that shows these numbers.
 *
 * THE PAIR IS CHECKED. Neither file's URL is content-hashed, so a browser can hold
 * yesterday's rows beside today's board, and an xwOBA from another week is not a
 * rougher version of this week's — it is a different measurement under the same player
 * id. A `capturedAt` that does not match the snapshot's is treated exactly like a
 * failed fetch, because for the reader it is one.
 */
export const useContact = (capturedAt: string | undefined) => {
	const [contact, setContact] = useState<Contact | null>(null)
	const [status, setStatus] = useState<ContactStatus>("unasked")
	/* The capture's date, read at the moment the answer ARRIVES rather than captured in
	   `ask`'s closure. `ask` is handed to a button and must be stable, and a stable
	   callback holding the first `capturedAt` it ever saw would compare the wrong day
	   after a snapshot reload. */
	const at = useRef(capturedAt)
	at.current = capturedAt
	/* One request per page, not one per row opened: `asked` is a ref rather than state
	   because two rows expanded in the same tick would both read `status === "unasked"`
	   and fire. */
	const asked = useRef(false)
	const ask = useCallback(() => {
		if (asked.current) return
		asked.current = true
		setStatus("loading")
		fetch(`${import.meta.env.BASE_URL}contact.json`)
			.then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then((c: Contact) => {
				if (at.current !== undefined && c.capturedAt !== at.current) {
					/* Left ASKED: retrying fetches the same mismatched file. The way out of
					   this state is a reload, which is what a stale cache needs anyway. */
					setStatus("failed")
					return
				}
				setContact(c)
				setStatus("ready")
			})
			.catch(() => setStatus("failed"))
	}, [])
	return { contact, status, ask }
}

export interface Filters {
	search: string
	slot: string
	/**
	 * Drop anyone the injured list names.
	 *
	 * STASH ONLY, read nowhere else, and that is not tidiness — on the other two
	 * horizons it cannot match. `injuryPolicy` below is already
	 * `filters.mode === "stash" ? "keep" : "exclude"`, so Streaming and the fortnight
	 * have removed every injured man from the ranking before this filter is reached.
	 * Driven on the published build: the fortnight went 1,008 rows to 1,008 and
	 * Streaming 77 to 77, with all sixty rendered rows byte-identical, while Stash
	 * went 1,446 to 1,245 and lost one man from the visible top sixty (Braxton
	 * Ashcraft, rank 50, listed 15-day).
	 *
	 * Scoped in `rows` the same way `startersOnly` is, and for the same reason: this
	 * page has already shipped a mode-scoped filter that went on filtering after its
	 * checkbox stopped rendering, and the board emptied with nothing on screen to
	 * undo it.
	 */
	hideInjured: boolean
	/**
	 * Keep only players the reader can actually ADD.
	 *
	 * Null is not a third state on screen — it means the reader has not touched the
	 * control, so each tab may open on the answer its own question wants. Streaming
	 * opens ON, because "which starter should I stream" is a question about the wire
	 * and a list headed by four 95%-rostered aces does not answer it; the other two
	 * open OFF, because the standing board is the standing board and Stash is about
	 * players you already hold. The moment the reader ticks or unticks it the value
	 * becomes an explicit boolean and follows him across tabs — he has said what he
	 * wants and the page stops guessing. See `AVAILABLE_ONLY_DEFAULT`.
	 *
	 * This used to be a plain `false` reading the league's live free-agent list, and
	 * that list needs the local API. On beanemachine.com it never arrives, so the
	 * checkbox was permanently disabled and the one question the tab exists for was
	 * unanswerable on the site it is hosted at.
	 */
	availableOnly: boolean | null
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
	 * Null until the reader picks one, so each view can open on the ranking its own
	 * question wants — see `defaultSort`. Same shape as `availableOnly`.
	 *
	 * FOUR VALUES, and it used to be ten. The six that went — uscore, market edge,
	 * undervaluation ("who has been unluckiest"), contact, replacement and confidence
	 * — were reachable only through a "Rank by" select above the table, and that
	 * select is gone: two of its four remaining entries were also sortable column
	 * heads, and the other two ordered the rows by a number no column drew, which is
	 * the defect `orderedCell` was built to paper over. What is left is exactly the
	 * set of sortable column HEADS, so every ordering this board can be in is an
	 * ordering by a number the reader can see and check.
	 *
	 * Each of the six is still computed and still printed in the drill-down under the
	 * row — nothing measured was thrown away, only the ability to put the table in an
	 * order whose number is nowhere on it.
	 */
	sort:
		| null
		| "bscore"
		| "points"
		/** What he gains over the man he would displace on YOUR roster — see
		 *  `BoardRow.deltaMine`. Null-sorted last, because "no man to displace" is not
		 *  a small number, it is the absence of one. */
		| "deltaMine"
		| "name"
	desc: boolean
}

export const DEFAULT_FILTERS: Filters = {
	search: "",
	slot: "",
	hideInjured: false,
	// unset, so each tab opens on the answer its own question wants — see the field
	availableOnly: null,
	mode: "board",
	// the league's own period, not a day count: the reset is what a head-to-head
	// matchup is settled on, so it is the horizon that is right unless asked otherwise
	days: null,
	// on by default, because the Streaming tab's whole question is who pitches
	// before the reset. It is a visible toggle and it is scoped to `stream` below,
	// so it can neither be left on invisibly nor strand a board it emptied.
	startersOnly: true,
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
	sort: null,
	desc: true
}

/**
 * What "only players I can add" means before the reader has said anything.
 *
 * One click — the Streaming tab — has to land on candidates rather than on aces,
 * because that click is the whole complaint: the tab, the 3-day chip, the start
 * counts and the opponents all shipped and the list still opened with Tyler
 * Glasnow (94% rostered) at the top. A control the reader must find and switch on
 * to get an answer is a control that has not answered him.
 */
/**
 * ON everywhere except Stash, because a recommendation you cannot act on is not a
 * recommendation.
 *
 * The standing board opened OFF, on the reasoning that "the standing board is the
 * standing board". Re-measured on the committed capture 2026-09-11, fortnight, ranked by
 * bscore, unfiltered: 38 of the first 50 rows are rostered in 90% or more of leagues and
 * three are under 50% — the comment said 42 and "not one". The point stands and is if
 * anything the same size: three quarters of the default screen
 * — the first thing a reader sees, on the tab this app exists for — is men he cannot
 * have. A ranking of everyone in baseball is a fine thing to be able to
 * ask for; it is the wrong thing to open on.
 *
 * Stash stays OFF because it is explicitly about players you already hold.
 */
export const AVAILABLE_ONLY_DEFAULT: Record<Filters["mode"], boolean> = {
	stream: true,
	board: true,
	stash: false
}

/**
 * What each view ranks by until the reader says otherwise.
 *
 * Streaming ranks by POINTS, not bscore, and it is the only view that does.
 *
 * bscore is points minus a man you could still pick up AT THE SAME SLOT, which
 * is the right question for a roster you hold all season: a catcher who beats
 * catchers is worth more than an outfielder who ties outfielders. A streamer is not
 * asking that. He is filling ONE seat for a few days, and comparing a reliever's
 * surplus over relievers against a starter's surplus over starters answers no
 * question he has.
 *
 * Measured on the shipped capture: within a slot the two rank IDENTICALLY — implied
 * replacement across the eight P rows was 14.68 to 14.77, a spread of 0.09 — so the
 * only reordering bscore performs here is lifting the lone RP over every starter, by
 * exactly the 3.5-point gap between the RP and P bars. That put Kyle Leahy, a
 * reliever with 0.6 expected starts and none announced, above Kumar Rocker and his
 * named start against the Rays, on a tab that asks which STARTERS to stream.
 *
 * The honest size of the win: top-2 by points beat top-2 by bscore by +0.0, +0.2,
 * +1.7, +2.7 and +2.7 points across the five windows — mean about 1.5 on 27-to-55
 * point totals, one capture, n=5. That is suggestive and nothing more, and it is not
 * why this changed. It changed because ranking a reliever first on a starters list
 * is wrong regardless of which number wins by a point and a half.
 *
 * bscore stays on the row, so the disagreement is visible rather than buried.
 *
 * AND THE OTHER TWO NOW OPEN ON THE READER'S OWN NUMBER, once he has given the app a
 * team.
 *
 * The board did not care that he had told it his roster. Driven on the dev server at
 * 390x844 — sixteen real players typed into "Who's on your team?", then "That's my
 * team" — the fortnight board still opened ordered 35.27 / 34.85 / 33.53 by bscore and
 * Billy still picked Grant Taylor, while the "for you" column beside those same rows
 * read +20.3 / +65.4 / +64.0. Seven of the eight rows under the recommendation beat
 * the recommendation on the one number that is about HIS team, and the man who
 * actually topped it — Josh Bell, +66.3 — was nowhere near the top of the screen. The
 * reader answers a question about his roster and the ranking ignores the answer.
 *
 * WHAT THIS IS AND IS NOT. It changes a DEFAULT, not the model. bscore is unchanged,
 * it is still computed for every row, it still has its own column on every horizon
 * and its own sortable head one tap away, and Billy's card still prints it. Nothing
 * is hidden and no number is lost.
 *
 * AND IT IS NOT MEASURED TO BE BETTER, which has to be said here because the evidence
 * this project holds belongs to the other ordering.
 * data/results/moves2_2021-2022-2023-2024-2025_moves2.json backtests a bscore-RANKED
 * add list: +61.8 points a week over season-to-date, 80 of 111 weeks, t 6.60. Nothing
 * has ever backtested a deltaMine-ranked board, and this comment is not to be read as
 * claiming one would do better. The argument is narrower and it is about the question
 * rather than the answer: the reader has just said which men he holds, and "what does
 * he add over the man I would bench for him" is the question he asked. The app must
 * never imply the re-rank is measured to win — see the sentence under the heads,
 * which says whose bar each number is and claims nothing about which predicts better.
 *
 * Without a roster there is no deltaMine to rank by and the default is bscore, exactly
 * as before.
 */
export const defaultSort = (
	mode: Filters["mode"],
	/** Whether the board can price a row against the reader's own men — the same test
	 *  that decides whether the "for you" column is drawn at all, so the ordering and
	 *  the column can never disagree about whether the number exists. */
	mine: boolean
): NonNullable<Filters["sort"]> =>
	mode === "stream" ? "points"
	: mine ? "deltaMine"
	: "bscore"

/** The join key, lifted to src/data/names.ts because this file and
 *  src/data/yahoo-pool.ts each carried a verbatim copy of it — and `Decide.tsx` crosses
 *  both inside one render. Re-exported here so every importer of this module is
 *  unchanged. */
export { normalizeName }

/**
 * Whose eligibility rules the board seats a player by.
 *
 * The snapshot's map is swept off YAHOO's player pages, so it is that platform's
 * ruling on who can fill what. For a Yahoo league that is the league's own truth.
 * For an ESPN league it is a different platform's, and the two genuinely differ:
 * ESPN grants 2B/SS and 1B/3B seats Yahoo has no equivalent for, and each site sets
 * its own games-played threshold before a position is granted at all. Seating a man
 * by the wrong site's rules puts him in a slot his league would refuse.
 *
 * `own` is eligibility in the LEAGUE's own terms, keyed by normalised name because
 * platform ids are each platform's own. It OVERLAYS rather than replaces: it covers
 * only the players that read returned, and everyone else keeps the snapshot's
 * answer, which is better than none. An empty list never overwrites a real one —
 * absent is not the same as "eligible nowhere".
 */
export const overlayEligibility = (
	snapshotEligibility: Record<string, string[]> | undefined,
	own: Map<string, string[]> | null | undefined,
	players: { id: number; name: string }[] | undefined
): Map<number, string[]> => {
	// built straight off the record rather than through `hydrate`, which re-parses a
	// 2.1 MB snapshot to hand back this one field
	const out = new Map<number, string[]>(
		Object.entries(snapshotEligibility ?? {}).map(([k, v]) => [Number(k), v])
	)
	if (!own?.size) return out
	for (const p of players ?? []) {
		const theirs = own.get(normalizeName(p.name))
		if (theirs?.length) out.set(p.id, theirs)
	}
	return out
}

export const useBoard = (
	snapshot: Snapshot | null,
	league: League | null,
	filters: Filters,
	availableNames?: Set<string> | null,
	/** Eligibility as the LEAGUE's own platform states it, by normalised name, where
	 *  the free-agent read carried it. Overlays the snapshot's Yahoo-derived map. */
	poolEligibility?: Map<string, string[]> | null,
	/** Positions the free-agent sweep asked for and did not get. Named on the page,
	 *  because "no free catcher" and "the catcher page did not answer" are different
	 *  facts and only one of them is about the league. */
	missedPositions: string[] = [],
	/** Your own men, by normalised name, so a row can be priced against the seat it
	 *  would actually take rather than against the league's generic bar. Empty or
	 *  absent means no roster has been entered and the column stays blank. */
	myNames?: Set<string> | null
) => {
	/**
	 * The injured list, brought up to date from MLB rather than read off a capture.
	 *
	 * The board excludes injured men from the ranking and marks them where it keeps
	 * them, and it was doing both against a file that is right on the day it is built
	 * and wrong every day after. The expensive direction is the one that ranks a man
	 * who went on the list yesterday as a free agent worth adding — a recommendation
	 * the reader's own league page contradicts before he has finished reading it.
	 *
	 * Null means "use the capture as it stands", which is the honest fallback: the
	 * board is useful without the overlay and must not empty because MLB is slow.
	 * The request is shared with the Today screen — see `useInjuries`.
	 */
	const captured = useMemo(() => (snapshot ? hydrate(snapshot).injuries : null), [snapshot])
	/*
	 * `error` is taken as well as `merged`, and that is the whole of this change.
	 *
	 * This destructured only `merged`, so the board used the live injured list when the
	 * request succeeded and the capture's when it did not, and said nothing either way.
	 * Measured by aborting every statsapi.mlb.com request and re-walking the screen: row
	 * two went from "Sam Antonacci 3B 34.55" to "Sam Antonacci OF 34.51" and row three
	 * from 33.18 to 33.14, with no sentence anywhere distinguishing the two boards. On
	 * the live feed at the time of that walk, 12 players' availability turned on whether
	 * this request answered — six newly injured who are active in the capture, six
	 * activated since who are injured in it.
	 *
	 * Tonight has said this correctly all along ("couldn't reach MLB … tonight's lineups
	 * and injured list are from the capture, 2d ago"). An absence is stated as an
	 * absence, on every screen that depends on it.
	 */
	const { merged: liveInjuries, error: injuryError } = useInjuries(captured, snapshot?.capturedAt)
	/**
	 * The expected-stats rows, and the button that asks for them.
	 *
	 * Held here rather than in Board.tsx because `rated` below is what has to be
	 * recomputed when they arrive — the drill-down reads them off the row it was given,
	 * not out of a second copy.
	 */
	const { contact, status: contactStatus, ask: askForContact } = useContact(snapshot?.capturedAt)
	const injuries = liveInjuries ?? captured ?? new Map<number, string>()
	// The reader's today, not the capture's. A snapshot is a set of games; which of
	// them are still ahead of you is a question only the clock can answer.
	const period = useMemo(() => {
		if (!snapshot || !league) return null
		const slate = snapshot.slate ?? []
		const seasonEnd = slate.reduce((a, g) => (g.date > a ? g.date : a), snapshot.horizon.end)
		const p = resolvePeriod(league, localDate(), seasonEnd)
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

	/**
	 * Whose eligibility rules the board seats a player by.
	 *
	 * The snapshot's map is swept off YAHOO's player pages, so it is that platform's
	 * ruling on who can fill what. For a Yahoo league that is the league's own truth.
	 * For an ESPN league it is a different platform's, and the two genuinely differ —
	 * ESPN grants 2B/SS and 1B/3B seats Yahoo has no equivalent for, and each site
	 * sets its own games-played threshold before a position is granted at all. Seating
	 * a man by the wrong site's rules puts him in a slot his league would not accept.
	 *
	 * The free-agent read carries eligibility in the LEAGUE's own terms, so where it
	 * exists it wins, joined by name because platform ids are each platform's own. It
	 * covers only the players that read returned, which is why it is an overlay rather
	 * than a replacement: everyone else keeps the snapshot's answer, which is better
	 * than none.
	 */
	const leagueEligibility = useMemo(
		() =>
			overlayEligibility(
				snapshot?.eligibility,
				league?.meta.platform === "espn" ? poolEligibility : null,
				snapshot?.players
			),
		[snapshot, league?.meta.platform, poolEligibility]
	)

	/**
	 * The two long horizons, measured from TODAY rather than from the capture.
	 *
	 * `hydrate` precomputes `gamesByTeam` and `gamesRemaining` over `snapshot.horizon`,
	 * which is the fortnight that started the day the snapshot was TAKEN. A capture is
	 * only refreshed when the site deploys, so by the time anyone reads it that window
	 * has a past in it: on the committed capture, taken 2026-09-04 and read on
	 * 2026-09-08, the fortnight board was counting 57 games that had already been
	 * played — 44% of its own window — and projecting every player across them.
	 *
	 * The slate itself runs to the end of the season, so the window can simply be
	 * rebuilt at read time. Only the WINDOW moves; the stats behind it are still as
	 * old as the capture, which is what the "player data · Nh ago" chip already says.
	 */
	const longWindows = useMemo(() => {
		if (!snapshot) return null
		const slate = snapshot.slate ?? []
		// the reader's own day, not UTC's — see the note in src/client/Decide.tsx
		const today = localDate()
		const seasonEnd = slate.reduce((a, g) => (g.date > a ? g.date : a), snapshot.horizon.end)
		const days = (d: string, n: number) =>
			new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10)
		return {
			fortnight: windowFrom(slate, today, days(today, 14)),
			rest: windowFrom(slate, today, seasonEnd)
		}
	}, [snapshot])

	const availability = useMemo(() => {
		if (availableNames && availableNames.size > 0)
			return {
				basis: "pool" as const,
				exact: true,
				cut: null as OwnershipCut | null,
				size: availableNames.size,
				/**
				 * ...and which positions it never reached, because that is the difference
				 * between "nobody is free at catcher" and "we did not look".
				 *
				 * Yahoo's sweep is nine separate page reads and it throttles by serving an
				 * empty one. On 2026-09-09 eight came back and the catcher page did not —
				 * a good read by any measure, so it is used — but a reader filtering to
				 * catcher was then told "Nobody", about a position the list had never
				 * seen. An absence of evidence rendered as evidence of absence is the one
				 * mistake this whole app is built to avoid.
				 */
				basisText:
					`read off your league's own free-agent list: ${availableNames.size} players are actually free` +
					(missedPositions.length ?
						`. ${missedPositions.join(", ")} could not be read this time, so nobody is listed at ${missedPositions.length === 1 ? "that position" : "those positions"} — that is a gap in the read, not an empty wire`
					:	"")
			}
		// the same map `hydrate` builds, without re-hydrating a 2.1 MB snapshot to
		// read one field of it
		const owned = new Map(
			Object.entries(snapshot?.ownership ?? {}).map(([k, v]) => [Number(k), v])
		)
		const cut = league ? ownershipCut(league, owned) : null
		if (cut?.usable)
			return { basis: "ownership" as const, exact: false, cut, size: null, basisText: cut.basis }
		return {
			basis: "none" as const,
			exact: false,
			cut,
			size: null,
			basisText:
				cut?.basis ??
				"nothing this page can read says who is on the wire in your league, so nobody is filtered out for it"
		}
	}, [availableNames, league, snapshot, missedPositions])

	/**
	 * Who the reader can actually get, as one test, drawn from whichever rung of the
	 * availability ladder this page has reached.
	 *
	 * The ladder already decides which rows to SHOW. Until now it had no say in what
	 * those rows were measured AGAINST, so a board filtered to men you can add priced
	 * every one of them against a bar set by men you cannot — and on a catcher-only
	 * board that made the card say "Nobody" about a list it had just ranked. Same
	 * answer, now used for both halves of the question.
	 *
	 * Undefined on the bottom rung, which is the honest thing: where nothing is known
	 * about the wire, the whole-pool simulation is still the best bar available.
	 */
	const gettable = useMemo(() => {
		if (availability.basis === "pool" && availableNames)
			return (r: { player: { name: string } }) => availableNames.has(normalizeName(r.player.name))
		const cut = availability.cut
		if (availability.basis === "ownership" && cut?.usable) {
			const owned = new Map(
				Object.entries(snapshot?.ownership ?? {}).map(([k, v]) => [Number(k), Number(v)])
			)
			return (r: { player: { id: number } }) => {
				const pct = owned.get(r.player.id)
				return pct === undefined || pct <= cut.cut
			}
		}
		return undefined
	}, [availability, availableNames, snapshot])

	const rated = useMemo(() => {
		if (!snapshot || !league) return []
		// Replacement depth is teams × slots. Without a real team count there is no
		// honest bscore, so this refuses rather than assuming a league size.
		if (league.meta.max_teams == null) return []
		const h = hydrate(snapshot, contact ?? undefined)
		// A period can legitimately resolve to nothing — a stale snapshot asked about a
		// week that starts after its last captured game — and zero games would rank
		// everyone at zero. Fall back to the fortnight rather than invent a number.
		const usingWeek = filters.mode === "stream" && !!week && week.games.size > 0
		const usingRest = filters.mode === "stash" && !!longWindows && longWindows.rest.games.size > 0
		const long = longWindows?.fortnight
		const horizon =
			usingWeek ? { games: week!.games, opponents: week!.opponents }
			: usingRest ? { games: longWindows!.rest.games, opponents: longWindows!.rest.opponents }
			: long ? { games: long.games, opponents: long.opponents }
			: { games: h.gamesByTeam, opponents: h.opponentsByTeam }
		// Probables reach about a week out, so the rest of a season has none — and an
		// absent count must fall back to the team-games estimate, not project zero.
		const probableStarts =
			usingWeek ? week!.probableStarts
			: usingRest ? undefined
			: (long?.probableStarts ?? h.probableStarts)
		const probableCoverage =
			usingWeek ? week!.coverage : usingRest ? undefined : (long?.coverage ?? h.probableCoverage)
		const opposingStarters =
			usingWeek ? week!.opposingStarters
			: usingRest ? undefined
			: (long?.opposingStarters ?? h.opposingStarters)
		// which lineup each announced starter actually faces — only meaningful where
		// probables exist, so the rest-of-season view has none by construction
		const startOpponents =
			usingWeek ? week!.startOpponents : usingRest ? undefined : h.startOpponents
		return withMarketEdge(
			withUndervaluation(
				rateAll({
				league,
				available: gettable,
				players: h.players,
				underlying: h.underlying,
				injuries,
				teamGamesPlayed: h.teamGamesPlayed,
				gamesByTeam: horizon.games,
				opponentsByTeam: horizon.opponents,
				recentVolumeByWindow: h.recentVolumeByWindow,
				recentStats: h.recentStats,
				ownership: h.ownership,
				eligibility: leagueEligibility,
				probableStarts,
				probableCoverage,
				opposingStarters,
				/*
				 * DERIVED ELEVEN LINES ABOVE AND THEN NOT PASSED — for every horizon on this
				 * screen, since this is the client's only `rateAll`. `rateAll` accepts it and
				 * hands it to `pitcherMatchupIndex`, which with `undefined` falls back to the
				 * club's season average, so the board priced a start against Colorado exactly
				 * like a start against Los Angeles. Board.tsx's own comment claimed the
				 * opposite. Decide.tsx passes it, so Tonight was never affected.
				 *
				 * Measured on data/snapshot.json against the dev league: of 795 pitchers, 357
				 * bscores move, the largest by 0.59 (Sean Manaea -28.84 → -29.43), and the
				 * ranking first differs at row 37. Small because only 60 pitchers in this
				 * capture have an announced opponent — and it grows with every probable MLB
				 * publishes, which is exactly the window the streaming tab is about.
				 */
				startOpponents,
				// over the rest of a season an injured man is a legitimate hold; over the
				// next week he is simply unavailable
				injuryPolicy: filters.mode === "stash" ? "keep" : "exclude",
				teams: league.meta.max_teams
				})
			),
			h.ownership
		)
		/* `contact` is in here, so the board RE-RATES when the expected-stats rows land.
		   Measured in node on the committed capture: the whole
		   rateAll + withUndervaluation + withMarketEdge pass over 1,446 rated players is a
		   median 45.8 ms (37.8–56.7 over seven runs), once, after a reader has deliberately
		   opened a row. The alternative was to derive the four affected fields for the one
		   open row inside Board.tsx, which is faster and is the wrong trade: it would give
		   this app two places that compute `confidence`, and a row and a drill-down
		   disagreeing about a number is the worst failure this page can produce. Nothing
		   re-orders — the proof above is that the ranking is byte-identical either way — so
		   what the reader sees change is only the numbers that were waiting on the file. */
	}, [snapshot, league, filters.mode, week, longWindows, gettable, injuries, contact])

	/**
	 * Can the reader actually add this man — and how sure is the answer.
	 *
	 * Three tiers, the SAME three Billy's pick already speaks, because two
	 * vocabularies for one fact is how a page ends up disagreeing with itself:
	 *
	 *   "pool"      the league's own free-agent list is loaded. Exact. It wins
	 *               outright wherever it exists, and the UI is entitled to say
	 *               "free in your league" rather than "probably free".
	 *   "ownership" no wire, but this capture's rostered shares can locate the
	 *               boundary. An ESTIMATE, calibrated to the league's own size —
	 *               see `ownershipCut`. Labelled as an estimate everywhere it shows.
	 *   "none"      neither. Nothing is claimed and nothing is hidden.
	 *
	 * The middle tier is the point of this whole block. The wire needs the local
	 * API; the hosted build has none; so on beanemachine.com the top tier can never
	 * fire and the bottom one used to be the only thing left. The snapshot already
	 * ships ownership, so the estimate costs no request and works on the static
	 * site.
	 */
	/**
	 * Where each player sits in the value ranking, so an UNLISTED player can be
	 * judged on whether he is good enough to be rostered. See `likelyAvailable`:
	 * the sweep reaches ~200 deep per position, so a man both inside a league's
	 * rostered depth AND absent from the sweep means the read has a hole, and the
	 * honest answer about him is that we do not know.
	 */
	const valueRank = useMemo(() => {
		const order = [...rated].sort((a, b) => b.points - a.points)
		return new Map(order.map((r, i) => [r.player.id, i]))
	}, [rated])


	/**
	 * The ranking with that answer attached to every row.
	 *
	 * Separate from `rated` on purpose: re-rating 1,433 players costs ~90 ms and
	 * depends on the horizon, while availability depends on the league's free-agent
	 * list arriving. Folding them together would re-rate the whole pool the moment
	 * the wire responded.
	 */
	/**
	 * The worst man you own who could hold each seat, in projected points.
	 *
	 * One pass over the roster rather than a lineup solve per row: `planSwaps` does
	 * the exact version and costs a simulation each time, which is right for the two
	 * moves the Today card recommends and wrong for a thousand rows. What this asks
	 * is the cheap, honest question a manager asks while scanning — "who would come
	 * off for him" — and it answers it with the lowest-projecting of your men who is
	 * eligible for a seat this man could take.
	 */
	const worstMineBySlot = useMemo(() => {
		if (!myNames?.size) return null
		const worst = new Map<string, number>()
		for (const r of rated) {
			if (!r.rateable || !myNames.has(normalizeName(r.player.name))) continue
			for (const slot of r.slots) {
				const held = worst.get(slot)
				if (held === undefined || r.points < held) worst.set(slot, r.points)
			}
		}
		return worst.size ? worst : null
	}, [rated, myNames])

	const board: BoardRow[] = useMemo(
		() =>
			rated.map(r => ({
				...r,
				deltaMine:
					!worstMineBySlot || !r.rateable || myNames?.has(normalizeName(r.player.name)) ?
						null
					:	(() => {
							// The seat he would take is the one where he displaces the least —
							// a manager benches his worst eligible man, not his worst man.
							const floors = r.slots
								.map(slot => worstMineBySlot.get(slot))
								.filter((v): v is number => v !== undefined)
							if (!floors.length) return null
							return Math.round((r.points - Math.min(...floors)) * 10) / 10
						})(),
				free:
					availability.basis === "pool" ?
						availableNames!.has(normalizeName(r.player.name))
					: availability.basis === "ownership" ?
						likelyAvailable(r.rosteredPct, availability.cut!, {
							rank: valueRank.get(r.player.id) ?? Number.MAX_SAFE_INTEGER,
							depth: availability.cut!.depth
						})
					:	null
			})),
		[rated, availability, availableNames, valueRank, worstMineBySlot, myNames]
	)

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
	 * Which position chips can ever return a row, read off the ranking itself.
	 *
	 * A league that scores one side of the ball only — a real and reachable state,
	 * since a Yahoo settings paste with a Batters table and no Pitchers table
	 * produces exactly it — leaves every pitcher unrateable, with `unrateable`
	 * saying so. The board was still offering SP, RP and P, and each of them
	 * answered "0 players. Try a different position or a wider window", which is a
	 * filter that cannot match dressed up as a filter the reader chose badly.
	 * Measured on the published build with such a paste: the board fell from 1,009
	 * rows to 481 and the word "pitch" appeared nowhere on the screen.
	 *
	 * DERIVED, not a hardcoded slot-to-side table, because the two would drift and
	 * the crossover is real: on the committed capture five pitching-group players
	 * carry infield or outfield eligibility (see `slotsFor`), so "SP, RP and P are
	 * the pitching chips" is true and "2B is a batting chip" is not quite. Taking
	 * the set off the rateable pool asks the only question that matters — is there
	 * a row this chip could show — and it answers it in the ranking's own terms.
	 *
	 * The reader's OWN filters are deliberately not applied: a chip empty because
	 * he ticked "only players I can add" is a chip he can un-empty, and hiding it
	 * would be the hidden-filter defect this file already carries two comments
	 * about. Only a slot no rateable player holds at all is withheld.
	 */
	const slotsRanked = useMemo(() => {
		const out = new Set<string>()
		for (const r of rated) if (r.rateable) for (const slot of r.slots) out.add(slot)
		return out
	}, [rated])

	/*
	 * `edgeCoverage` stood here: the share of the rateable pool Yahoo had priced, so a
	 * board ranked by market edge could warn that "ownership was listed for only N% of
	 * this board, so edge can rank just that slice". Market edge is no longer an
	 * ordering this screen offers — see `Filters["sort"]` — so there is no board for
	 * that warning to stand above, and its one reader in Board.tsx went with it.
	 * `marketEdge` itself is untouched: `withMarketEdge` still computes it and the
	 * drill-down under every row still prints it.
	 */

	/**
	 * THE ORDERING, RESOLVED — and clamped to an ordering this horizon can DRAW.
	 *
	 * `filters.sort` is one piece of state shared by three horizons, and the horizons
	 * do not carry the same columns: "points" has a column on Streaming and none on
	 * the other two, and "for you" exists only once a roster has been entered. So a
	 * reader who tapped the points head on Streaming and then went back to the
	 * fortnight left the board ordered by a number with no column on it — a table
	 * ordered by an invisible figure, which is the one thing this app is not for.
	 *
	 * That used to be answered by DRAWING the missing column: a generic
	 * `[data-col=sorted]` track, headed with the metric's short name, added by
	 * `orderedCell` in Board.tsx whenever the ordering had no column of its own. It
	 * existed because the "Rank by" select offered six orderings and four of them were
	 * printed nowhere on the table. The select is gone, the only orderings left are the
	 * sortable column heads, and so the honest fix is the cheaper one: an ordering this
	 * horizon cannot show falls back to the horizon's own default rather than conjuring
	 * a column for it. Same precedent as `days` and `startersOnly` — a control is read
	 * only where it renders, so it can neither be left on invisibly nor strand a board
	 * it reordered.
	 *
	 * Every ordering reachable from here therefore has a visible column, BY
	 * CONSTRUCTION rather than by inspection: `bscore` has a column on all three
	 * horizons, `points` only where the points column is drawn, `deltaMine` only where
	 * the "for you" column is drawn, and `name` orders the column the names are
	 * already in.
	 */
	const sortable = (s: NonNullable<Filters["sort"]>): boolean =>
		s === "bscore" || s === "name" ||
		(s === "points" && filters.mode === "stream") ||
		(s === "deltaMine" && worstMineBySlot !== null)
	const chosen = filters.sort && sortable(filters.sort) ? filters.sort : null
	const sort: NonNullable<Filters["sort"]> =
		chosen ?? defaultSort(filters.mode, worstMineBySlot !== null)
	/**
	 * ...AND THE DIRECTION IS CLAMPED WITH IT, because half a clamp is its own defect.
	 *
	 * `desc` is one piece of state shared by the three horizons just as `sort` is, and
	 * the two travel together: pressing the points heading on Streaming a second time
	 * sets `sort: "points", desc: false`, and the fortnight then fell back to "ahead by"
	 * — correctly — while keeping the direction, so the board opened ASCENDING and the
	 * reader's first screen was the thousand men projected furthest BEHIND the wire.
	 * Driven before this line existed: head "ahead by ▴", row one Grant Taylor replaced
	 * by a body at roughly minus a hundred.
	 *
	 * A direction is a way of looking at a particular column. Where the column the
	 * reader chose does not exist here, neither does the direction he chose it in, so
	 * this horizon opens the way it would have opened: descending, except on Player,
	 * where ascending is alphabetical and that is what a name column means.
	 */
	const desc = chosen ? filters.desc : sort !== "name"

	/*
	 * `rankable` stood here — how many players the RANKING could place before the
	 * reader's own filters, so a short board could say "market edge dropped the rest"
	 * without blaming a position chip for it. All four of its clauses tested an
	 * ordering that no longer exists (undervaluation, market edge, uscore, contact),
	 * which left it counting `r.rateable`; and nothing has read it since the "How this
	 * ranking was built" disclosure was deleted. `grep -rn rankable src/ test/`
	 * returned its definition and its own name in this hook's return value, and
	 * nothing else.
	 */

	/**
	 * What a streaming decision needs on the page beside the ranking: who each
	 * announced starter faces, and how much of this window MLB has actually named.
	 *
	 * The coverage is MEASURED off the window on screen rather than quoted from a
	 * table, because it is a property of the capture as much as of the horizon — and
	 * this comment is the proof of that, having gone stale twice while the code it
	 * describes stayed right.
	 *
	 * Probables reach about three days past a capture and then stop. Re-derived on the
	 * committed snapshot (captured 2026-09-08, horizon 2026-09-08 → 2026-09-22), in the
	 * CLUB-GAME units this code counts in — one starting assignment per club per game:
	 *
	 *    1 day   28 of  30 named   28 of 30 clubs complete
	 *    3 days  56 of  70 named   20 of 30 clubs complete
	 *    5 days  60 of 130 named    0 of 30 clubs complete
	 *    7 days  60 of 180 named    0 of 30 clubs complete
	 *   14 days  60 of 354 named    0 of 30 clubs complete
	 *
	 * The absolute count stops moving after three days: every probable this capture will
	 * ever have is already in it, and a longer window only adds unnamed games. That is
	 * the shape the horizon cap is for, and it is why a number baked into a string would
	 * have been right on the day it was written and wrong every day after.
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
		// null means "the reader hasn't said", so the tab answers for him
		const availableOnly = filters.availableOnly ?? AVAILABLE_ONLY_DEFAULT[filters.mode]
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
		/*
		 * THE NAME BOX AND THE POSITION CHIPS ARE READ WHERE THEY ARE DRAWN, which
		 * until now they were not, and the gap was a live defect rather than an
		 * untidiness.
		 *
		 * Board.tsx renders both on the fortnight and on Stash and neither on
		 * Streaming — a streaming list is already only men with a start, so every row
		 * is a pitcher and the chips would separate P from RP and nothing else. They
		 * went on FILTERING there all the same, off one shared piece of state. Driven
		 * on the published build: type "Grant" on the fortnight (4 rows), switch to
		 * Streaming, and the tab shows 1 row with no search box anywhere on it; pick the
		 * C chip on the fortnight (83 rows), switch to Streaming, and the tab is empty
		 * with "No players match the C position. Clear one of those to widen it." —
		 * naming a control that is not on the screen it is printed on.
		 *
		 * `startersOnly` one line above won this exact argument already and the comment
		 * on it says why at length. Same treatment, and the fix is the same shape: a
		 * control is read only on the horizons that draw it, so it can neither be left
		 * on invisibly nor strand a board it emptied.
		 */
		const narrowing = filters.mode !== "stream"
		const out = board.filter(r => {
			// a player with no projectable volume has no bscore to rank
			if (!r.rateable) return false
			/*
			 * FOUR ORDERING GUARDS stood here and all four are gone with the orderings
			 * they guarded. "most undervalued" dropped anyone at or below replacement,
			 * because unrestricted it finds the unluckiest replacement-level body in
			 * baseball; market edge dropped the unpriced and the sub-replacement for the
			 * same reason; uscore dropped the unpriced; contact dropped anyone with no
			 * rolling Statcast window. None of the four is a reachable ordering any more
			 * — see `Filters["sort"]` — so each guard was a branch on a value this hook
			 * can no longer be handed. The numbers themselves are untouched and still in
			 * the drill-down under every row.
			 *
			 * What this means for the COUNT in the card head is the point of recording it:
			 * the board's row count no longer moves when the ordering changes, so the
			 * count beside "The wire" is now a property of the reader's filters alone.
			 */
			if (startersOnly && !(r.scheduledStarts != null && r.scheduledStarts > 0)) return false
			if (narrowing && q && !r.player.name.toLowerCase().includes(q)) return false
			/*
			 * `filters.group` stood here — the "Side" select's batters / pitchers / both.
			 * It is gone because it DISAGREED with the position chips one row above it
			 * while appearing to duplicate them. Driven on the published build, fortnight,
			 * default filters: the Util chip returns 441 rows and Side=batters 440, the P
			 * chip 567 and Side=pitchers 568, with the first sixty rows name-for-name
			 * identical in both pairs. The one man each pair differs by is the same man —
			 * José Fermin, snapshot id 820862, a PITCHER whom Yahoo's eligibility sweep
			 * joined by name to the hitter José Fermín, so the board seats him at
			 * 2B/3B/OF/Util while `player.group` still says "pitching". The chip asks what
			 * seats he can fill and the select asked which side of the ball he is on, and
			 * on him the two answers contradict each other. One of the pair had to go, and
			 * it is the one that cost two taps to change and named no seat.
			 */
			if (narrowing && filters.slot && !r.slots.includes(filters.slot)) return false
			// STASH ONLY — see `Filters.hideInjured`. The other two horizons have already
			// excluded every injured man in `rateAll` (`injuryPolicy`), so there the
			// checkbox could not match: driven on the published build it moved the
			// fortnight 1,008 → 1,008 and Streaming 77 → 77 with every rendered row
			// byte-identical, against Stash's 1,446 → 1,245. Scoped here rather than
			// merely unrendered, because this page has already shipped a filter that went
			// on filtering after its checkbox stopped being drawn.
			if (filters.mode === "stash" && filters.hideInjured && r.injury) return false
			/**
			 * Only players he can get.
			 *
			 * `r.free === false` rather than `!r.free`: false is a claim that he is
			 * taken, null is the absence of one, and hiding a man on an absence is the
			 * failure this app is built to refuse. Where the league's real wire is
			 * loaded nothing is null; where only the estimate is, null cannot occur
			 * either, because an unlisted player is counted available (see
			 * `likelyAvailable`). Null therefore reaches here only in the "none" tier,
			 * where the filter is correctly inert on every row.
			 */
			if (availableOnly && r.free === false) return false
			return true
		})
		const key = (r: (typeof out)[number]) => {
			switch (sort) {
				case "points": return r.points
				// -Infinity, not 0: "nobody you own could be displaced by him" is the
				// absence of an answer, and sorting it beside a genuine zero would put men
				// the column cannot price in among men it prices at nothing.
				case "deltaMine": return r.deltaMine ?? -Infinity
				case "name": return r.player.name
				/*
				 * SIX CASES went with the six orderings: replacement, confidence,
				 * undervaluation, uscore, marketEdge and contact. The last of them carried
				 * the one piece of arithmetic worth naming on the way out — a pitcher
				 * benefits when his expected wOBA is BELOW his actual, so the contact
				 * ordering flipped sign by side. That rule now lives only where it is still
				 * used, in the `regressionGap` sentence in the drill-down.
				 */
				default: return r.bscore
			}
		}
		out.sort((a, b) => {
			const x = key(a), y = key(b)
			const cmp = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number)
			return desc ? -cmp : cmp
		})
		return out
	}, [board, filters, streaming, sort, desc])

	// `sort` is returned resolved, so the Rank-by control shows what the view is
	/*
	 * `sort` is returned RESOLVED — and clamped, which is new. It used to be
	 * `filters.sort ?? SORT_DEFAULT[mode]`, returned so the Rank-by select could show
	 * what the view was actually ranked by rather than an empty box. The select is
	 * gone; what reads it now is every sortable heading, which has to mark the column
	 * the rows are really in. See the note above `sortable`.
	 *
	 * `mine` is the test for whether the reader's own roster can price a row at all —
	 * returned rather than recomputed in Board.tsx, so the column that is DRAWN and the
	 * ordering that is OFFERED cannot disagree about whether the number exists.
	 */
	return {
		rated: board, rows, scored, slotsRanked, period, streaming,
		mine: worstMineBySlot !== null,
		teamNames, availability, sort, desc, injuryError,
		/* Both halves, because the drill-down needs to say which state it is in AND be
		   able to leave it. `contactStatus` is the sentence; `askForContact` is what the
		   open row calls on mount. */
		contactStatus, askForContact
	}
}

/*
 * `realInnings` stood here: baseball's 85.2 means eighty-five and two THIRDS, so read as
 * a decimal it is short by up to 0.8 per pitcher. Correct, non-obvious, and dead — its
 * only caller was `inningsFor` on the board, which was itself unreachable, and the one
 * place that still adds innings up (`seatedInnings` in src/auto/plan.ts) sums `outs` and
 * divides by three, so the notation never reaches it. The trap it guarded cannot be hit
 * from anywhere the code now goes; if a raw `inningsPitched` ever comes back, git has it.
 */
