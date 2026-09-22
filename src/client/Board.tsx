import { useMemo, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { Billy } from "./Billy.tsx"
import { readView, writeView } from "./view.ts"
import { roster } from "./roster.ts"
import { useStored } from "./stores.ts"
import { deriveMoveLimit, deriveInningsMinimum } from "../import.ts"
import {
	AVAILABLE_ONLY_DEFAULT, DEFAULT_FILTERS, normalizeName, periodScoped, useBoard,
	type BoardRow, type ContactStatus, type Filters, type Ranked
} from "./useBoard.ts"
import {
	canReadPool, api, ApiError, getMode, poolIsPartial, type AvailablePool
} from "./api.ts"
import { since } from "./pool.ts"
import { taken as takenStore, takenKeys as keysOf } from "./taken.ts"
import { useEffect } from "react"
import { datesBetween, leagueWeek, type ResolvedPeriod } from "../engine/period.ts"
import { tab } from "./panels.tsx"
import { andList, statLabel } from "../data/names.ts"

const pct = (v: number) => `${Math.round(v * 100)}%`

const MISSING_LABEL: Record<string, string> = {
	plateAppearances: "no plate appearances on record, so there is no playing-time rate to project from",
	outs: "no innings on record, so there is no workload rate to project from",
	teamGamesPlayed: "his team's games played is unknown, so the per-game rate can't be computed",
	"underlying expected stats": "Statcast has no expected-stats row for him"
}

/** Rows rendered per step as the reader scrolls. */
const PAGE = 60

/**
 * The row the history entry we are standing on was opened for, or null.
 *
 * `bm` is App.tsx's own state object — `view`, `sheet`, `depth` — and `row` is one more
 * field on it rather than a second object, so that every entry in the stack still carries
 * everything App's popstate listener reads off it. See the long note on `open` in `Board`.
 */
const rowAt = (): number | null =>
	typeof history === "undefined" ?
		null
	:	((history.state as { bm?: { row?: number | null } } | null)?.bm?.row ?? null)

/**
 * Record which row is open on the history stack: a new entry for the first one opened,
 * and an amendment to it for the next.
 *
 * It REFUSES on an entry that has no `bm` of App's on it. App's listener reads `at.view`
 * the moment `bm` exists, so an entry carrying only our `row` would hand it
 * `setView(undefined)` the next time Back landed there — and an entry App wrote is the only
 * kind that exists by the time a reader can tap a row, because App writes one on mount.
 */
const markRow = (id: number, push: boolean) => {
	const prev = history.state as { bm?: { depth?: number } } | null
	if (!prev?.bm) return
	const bm = { ...prev.bm, row: id }
	try {
		/* `location.href`, so the hash App put there is preserved exactly. The drill-down is
		   not in the URL on purpose: it is a thing the reader opened over the screen he is on,
		   not a place, and the same argument App makes about the setup sheet applies — nobody
		   sends somebody "row 4 of the wire", and a reload deciding to open one would be the
		   page deciding what he is reading. */
		if (push)
			history.pushState({ ...prev, bm: { ...bm, depth: (prev.bm.depth ?? 0) + 1 } }, "", location.href)
		else history.replaceState({ ...prev, bm }, "", location.href)
	} catch {
		/* A browser that refuses pushState keeps the behaviour every browser had until now:
		   the row opens and Back leaves the screen. Nothing else depends on the entry. */
	}
}

/**
 * WHERE THE LIST STOPS, and it used not to stop at all.
 *
 * The board rendered every row it ranked. Measured at 390x844 on the fortnight, with
 * the list scrolled to its end: 1,008 `.board-row` nodes, 9,247 elements on the page
 * against 716 before any scrolling, and a document 59,395px tall — nothing ever
 * unmounted, because `PAGE` only ever grows. Scrolling that far is not a thing anybody
 * does; paying for it is.
 *
 * No windowing library, deliberately. A cap is the honest version of the same saving,
 * because the rows past it are not rows a reader was going to act on: 400 is chosen so
 * that NOTHING THE RANKING RECOMMENDS IS CUT on any horizon. Measured on the dev league
 * with default filters, counting rows whose bscore clears zero — a man who beats the
 * body already available at his own slot, and therefore the only kind of man this board
 * has any business recommending: Streaming 19 of 77, the fortnight 100 of 1,008, Stash
 * 327 of 1,446. The deepest of the three is 327, so the cap sits above all of them and
 * everything it removes projects at or behind the man you could have for nothing.
 *
 * AND IT SAYS SO, with the count of what is not drawn, because a truncated list that
 * reads as a complete one is worse than a long one. The name box filters the whole
 * ranking before the cap is applied, so a man at rank 900 is still one search away —
 * which is the sentence the note gives him, on the two horizons that draw that box.
 */
const CAP = 400

/**
 * `const WIDELY_ROSTERED = 70` used to live here — the bar Billy's pick used to
 * decide who was still gettable when the league's own wire could not be read. It
 * is gone, and deliberately not replaced by another number: 70% is the same bar in
 * a 10-team league and a 20-team one, which cannot both be right. The bar is now
 * `ownershipCut` in src/engine/bscore.ts, derived from the league's own team count
 * and roster shape, and every part of this page that asks "can he get him" asks
 * that one function.
 */

const SLOTS = ["", "C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP", "P"]


/** The three horizons, as a tablist: three questions, not three filters. */
const MODES = [
	// It used to say "this week's matchup — who wins it for you", which is what the
	// tab did: it re-ranked the same 1,400 players over a shorter horizon. The most
	// common question in the game is narrower than that and the tab now answers it —
	// which pitchers actually take the ball before the reset, what they get, and
	// against whom.
	["stream", "Streaming", "who's pitching before the reset — starts, matchups, and what they're worth"],
	/* The standing board's label is not written here and the two empty strings are never
	   read — the branch that renders this entry calls `standingBoard` instead, because the
	   name of this tab is the window it is ranking and that is the league's, not ours. */
	["board", "", ""],
	["stash", "Stash", "rest of season — who to hold, not who to start"]
] as const

/**
 * WHAT THE STANDING BOARD IS CALLED, which is whatever it is ranking over.
 *
 * "This fortnight" was a constant over a window that is no longer constant:
 * `periodScoped` in useBoard.ts now rates this horizon over the league's own scoring
 * period wherever the league stated one, and a tab reading "This fortnight" above a
 * header reading "the rest of this scoring period · Sep 19 → Sep 20" is two sentences on
 * one screen disagreeing about what the reader is looking at — the exact failure this
 * file has had to delete four times.
 *
 * The fallback keeps the old word for the league that stated nothing, because for that
 * league nothing has changed: it is still fourteen days this app picked, and the tab
 * still says so.
 */
const standingBoard = (
	period: ResolvedPeriod | null,
	/**
	 * What the rows on screen were ACTUALLY rated over, where this tab is the one on
	 * screen, and null where it is not.
	 *
	 * `periodScoped` says what the league stated; it does not say whether that window has
	 * any baseball in it. A capture older than the period it is asked about resolves to a
	 * window with no games, and `using` in useBoard.ts falls back to the fortnight rather
	 * than rank everyone at zero — at which point a tab reading "This week" would sit over
	 * a header reading "the fortnight ahead", which is the disagreement this function
	 * exists to prevent rather than a new one to introduce. So where the answer is known it
	 * wins, and where the reader is standing on another tab the league's own statement is
	 * the best available guess at what this one will show.
	 */
	over: "period" | "rest" | "fortnight" | null
): { label: string; why: string } => {
	if (over !== null && over !== "period")
		return { label: "This fortnight", why: "the standing board, 14 days out" }
	if (!periodScoped("board", period) || !period?.periodStart || !period.periodEnd)
		return { label: "This fortnight", why: "the standing board, 14 days out" }
	const days = datesBetween(period.periodStart, period.periodEnd)
	return {
		// Seven is what a manager calls a week; anything else is named by its length
		// rather than by a word that would be wrong about it.
		label: days === 7 ? "This week" : `These ${days} days`,
		why: `everyone you can add, ranked over the ${days} days your league settles this matchup on`
	}
}

/**
 * The streaming horizons, as one control.
 *
 * "Rest of period" leads because in a head-to-head league the reset IS the
 * decision — a start on Monday scores for a matchup this week's is already settled
 * without. The day counts are the same control with a nearer far edge (see
 * `withinDays`), and they stop at seven because that is where the schedule data
 * stops paying. Re-derived on the committed capture (2026-09-08) in club-games, the
 * unit a starting assignment is counted in: 56 of 70 named three days out, 60 of 130
 * at five and still 60 of 180 at seven — the numerator stops moving after three days,
 * so days five through seven add games and no extra certainty about who pitches them.
 */
const WINDOWS = [
	[null, "Rest of period"],
	[1, "Today"],
	[2, "2 days"],
	[3, "3 days"],
	[5, "5 days"],
	[7, "7 days"]
] as const

const tabId = (mode: Filters["mode"]) => `horizon-${mode}`
const PANEL_ID = "horizon-panel"

/**
 * app.css gives every control one focus treatment, but `.modes .mode` sets
 * `box-shadow:none` at a higher specificity than the shared `button:focus-visible`
 * rule, so the horizon tabs — and only they — took keyboard focus with nothing
 * drawn at all. Confirmed in the browser: computed outline `none`, box-shadow
 * `none`, border unchanged. This restores the same ring the rest of the page uses.
 * It belongs in app.css and should move there; it is here because app.css is not
 * this change's file.
 */
const MODE_FOCUS_CSS = `.modes .mode:focus-visible{
	outline:none;border-color:var(--accent);
	box-shadow:inset 0 1px 0 var(--edge), var(--ring);
}`

/**
 * The board's grid, now that it carries SEVEN columns rather than eight.
 *
 * `uscore` and `owned` used to be two of them, and they are one fact: uscore is
 * `addValue x (1 - owned)`, so it is blank in exactly the rows ownership is blank
 * in. Measured on the committed fixture, that is 500 of 1,233 rateable rows
 * (40.6%) on the fortnight and 585 of 1,433 (40.8%) rest-of-season — and, because
 * Yahoo lists the players it prices rather than the players who rank, 36 of the
 * FIRST 60 rows (60%). The board opened on seven straight rows of two dashes side
 * by side: one missing input, reported twice, in the place where scanning matters
 * most. They are one cell now — the score with the ownership that produced it
 * underneath, or the single word "unlisted".
 *
 * Every cell carries `data-col` and is placed by it. app.css places them by
 * `nth-child`, which cannot survive a column being added to one row and not the
 * other — that is on the record: auto-placement once put the confidence gauge
 * under "GP" and the games count under "confidence". Naming the column in the
 * markup makes that class of drift impossible, and it lets the head and the row
 * hold their cells in the SAME order, so app.css's swap of children 6 and 7 is
 * no longer needed by anything.
 *
 * This belongs in app.css and should move there, replacing the `nth-child` block
 * and its two media queries; it is here because app.css is not this change's
 * file. The selectors are deliberately one class deeper than app.css's so the
 * cascade cannot depend on which stylesheet React inserts first.
 */
const BOARD_GRID_CSS = `
/*
  FOUR columns, or five once a roster exists, and the cuts are the point.
  
  It carried seven: uscore, bscore, games, confidence, luck, and later Δ mine.
  Measured on the shipped capture, three of them could not be read as columns at all.
  uscore is bscore discounted by availability, on a list already filtered to players
  you can add — the same number twice, or its opposite, depending on a checkbox.
  Confidence read 100% on 41 of the first 60 rows and took four distinct values across
  all sixty. Luck is a percentile of expected-minus-actual contact that feeds no
  ranking on this screen, printed beside numbers that do.
  
  Nothing measured is lost. Confidence is in the drill-down, one tap on the row, where
  the working already lives; luck is there as the wOBA gap it is derived from, and its
  percentile comes back as a column whenever the board is ordered by it. What goes is
  the claim that either is a decision column on every visit.
  
  The name gets the width. On a phone it was ellipsised while the numbers kept full
  columns, which is a table that has decided the reader came to look at figures rather
  than at players.
*/
.board .board-head,.board .board-row{
	grid-template-columns:28px minmax(0,1fr) 88px 62px;
}
/* With a roster there is one more, and it is the one an already-good manager reads:
   what this man gains over the man he would actually displace. */
.board[data-mine] .board-head,.board[data-mine] .board-row{
	grid-template-columns:28px minmax(0,1fr) 80px 72px 58px;
}
.board[data-mine] .board-head>[data-col=mine],.board[data-mine] .board-row>[data-col=mine]{grid-column:4}
.board[data-mine] .board-head>[data-col=games],.board[data-mine] .board-row>[data-col=games]{grid-column:5}
/* Placed by NAME. app.css places the same cells by nth-child, which cannot
   survive a column being added to one row and not the other — that is on the
   record: auto-placement once put the confidence gauge under "GP" and the games
   count under "confidence". */
.board .board-head>[data-col],.board .board-row>[data-col]{grid-row:1;min-width:0}
.board .board-head>[data-col=rank],.board .board-row>[data-col=rank]{grid-column:1}
.board .board-head>[data-col=who],.board .board-row>[data-col=who]{grid-column:2}
.board .board-head>[data-col=bscore],.board .board-row>[data-col=bscore]{grid-column:3}
.board .board-head>[data-col=games],.board .board-row>[data-col=games]{grid-column:4}
/* Streaming prints projected points where the board prints what he is ahead by, and
   it is the same track. The rules that used to sit here for uscore, confidence and
   luck are gone with the columns: nothing renders a uscore or a luck cell on this
   screen any more, and conf only appears inside the drill-down, which is not a
   child of a row. A rule kept "in case" is how a deleted column comes back wearing
   somebody else's heading. */
.board .board-head>[data-col=pts],.board .board-row>[data-col=pts]{grid-column:3}

/*
  THE ORDERING'S OWN TRACK STOOD HERE — a generic [data-col=sorted] column inserted left
  of "ahead by", headed with whatever metric the reader had ordered by, in four
  written-out combinations because an inherited grid-column is how two cells end up on
  one track and this file has shipped that twice.

  It existed to enforce a rule this board genuinely needs — A BOARD MUST ALWAYS SHOW THE
  NUMBER IT IS SORTED BY — against a "Rank by" select that offered orderings no column
  drew. The select is gone, and the only orderings left are the sortable column heads:
  bscore (a column on all three horizons), points (a column on Streaming), deltaMine (a
  column once a roster exists) and name. The sortable() clamp in useBoard.ts holds the
  shared sort state to an ordering THIS horizon draws, so the rule now holds by
  construction and there is no missing column left for a generic track to stand in for.

  The rule itself is not deleted, it is enforced somewhere cheaper. Four CSS combinations
  and a nine-entry lookup table were the cost of being able to order the board by a figure
  nobody can see; not being able to do that is the better answer.
*/
/* The player's name is never cut. */
.board .board-row .who b{overflow:visible;text-overflow:clip;white-space:normal}
/*
  .us-val, .us-own and .us-none stood here — the uscore score with the
  ownership it was divided by underneath, or the word "unlisted". No row has
  rendered any of the three since the four-column pass took uscore off the board;
  checked across src/, test/ and api/, the only surviving mentions are two comments
  in test/board.mjs explaining that the cells went and one helper built to read the
  number out of the drill-down instead. The rules below them in this block already
  say why a rule kept "in case" is how a deleted column comes back wearing somebody
  else's heading, and these three were that rule.
*/
/* the unit rides the number, because the column holds two of them */
.board .board-row .g-unit{font-size:var(--fs-1);color:var(--faint);margin-left:3px}

/* app.css spaces a drill-down heading after another heading and after a note list,
   but not after a definition list — so "Statcast model" now sits flush against the
   last row of "Measured", which reads as one table with a caption in the middle of
   it. Belongs in app.css beside its siblings; here because app.css is not this
   change's file. */
.detail dl + h3{margin-top:var(--sp-3)}

/*
  ONE media block, where there were three.
  
  They existed to decide which of nine columns survived at each of three widths. With
  four there is one decision left: at 390px the board is 300px wide, which holds the
  rank, the name and one number. The games count goes rather than the value, because
  the value IS the ranking and a list sorted by a column it does not show is a list
  nobody can check.
  
  The two that went were written for the nine-column board and outlived it. A 900px
  block set a six-track template and un-hid the games count; a second 640px block
  then sent that cell to track 3, where "ahead by" already was, and both won on
  source order — so at 390px the first row read "35.2714GP", two numbers printed on
  top of each other under one heading. Every rule in them named uscore, confidence or
  luck, and no row has rendered any of the three since the four-column pass.
*/
@media(max-width:640px){
	.board .board-head,.board .board-row{
		grid-template-columns:24px minmax(0,1fr) 74px;gap:var(--sp-2);
	}
	/* "For you" takes the near column, because it is the one about HIS team, and both
	   cells are placed explicitly rather than left to inherit from the desktop rule —
	   in a four-track grid that put "for you" to the right of a number it should lead. */
	.board[data-mine] .board-head,.board[data-mine] .board-row{
		grid-template-columns:24px minmax(0,1fr) 62px 62px;gap:var(--sp-2);
	}
	.board[data-mine] .board-head>[data-col=mine],
	.board[data-mine] .board-row>[data-col=mine]{grid-column:3}
	.board[data-mine] .board-head>[data-col=bscore],
	.board[data-mine] .board-row>[data-col=bscore]{grid-column:4}
	.board .board-head>[data-col=games],.board .board-row>[data-col=games],
	.board[data-mine] .board-head>[data-col=games],.board[data-mine] .board-row>[data-col=games]{display:none}
	/* The phone's two [data-ordered] templates stood here, for the same generic track the
	   desktop block above describes at length. Nothing sets data-ordered any more. */
	/* Streaming shows what he scores; the board shows what he is ahead by. One number
	   each at this width, and it is always the one the list is ordered by. */
	.board[data-mode=stream] .board-head>[data-col=pts],
	.board[data-mode=stream] .board-row>[data-col=pts]{grid-column:3}
}
`

/**
 * The STREAMING grid, which is deliberately not the board's grid.
 *
 * The shared seven columns — uscore, bscore, games, confidence, luck — are the
 * right shape for "who is the best player in baseball right now". They are the
 * wrong shape for "which arm do I add for the next three days", and two of them
 * are worse than merely irrelevant there:
 *
 * `uscore` is `addValue x (1 - owned)`, i.e. value discounted by availability. On
 * a list that is ALREADY filtered to players he can add, that discount is applied
 * twice, and it reorders the survivors by who is rarer rather than by who is
 * better — the opposite of the question. It is also null wherever Yahoo priced
 * nobody, which on the live 2026-09-04 capture is 553 of 1,435 players, including
 * the top row of the gettable list.
 *
 * `luck` is a percentile of expected-minus-actual wOBA over 21 days. It is a buy-low
 * signal about a season, acted on by ordering the board with "who has been unluckiest"
 * — which now draws the percentile beside each name, because a list ranked by a number
 * it does not print cannot be checked. Nothing about a Saturday start turns on it.
 *
 * What goes in their place is the half of the reader's question the board never
 * answered: "expected performance". `pts` is what he is projected to actually
 * score over this window in this league's scoring — the quantity — and `bscore`
 * stays as the comparison against the next arm on the wire. Over three days those
 * two say very different things: on the live capture the best gettable starter
 * projects 33.0 points and 15.9 above replacement, and the fifth-best projects
 * 17.2 points and 0.14 above it. One number alone would have hidden that.
 *
 * Six columns, placed by NAME like the board's, for the reason BOARD_GRID_CSS
 * gives at length: app.css places by nth-child, and this view has a different
 * number of children, so every index-based rule below has to be answered
 * explicitly at every width or a heading ends up over the wrong cell.
 */
const STREAM_GRID_CSS = `
/*
  Streaming carries one more number than the board, and it is the right one.
  
  The board asks who is worth adding and answers with what he is ahead of a free man
  by. Streaming asks which arm to start on Saturday, and what answers that is what he
  actually scores in the window — a free arm you are not starting is worth nothing to
  you this week. So both are on the row here, and the list is ordered by the first.
  
  EVERY cell is placed explicitly in every combination below, and that is not
  verbosity. There are four: two horizons times whether a roster exists. A cell left
  to inherit its column from another combination auto-places, and an auto-placed cell
  lands on top of its neighbour — measured on the streaming tab with a roster, "points"
  and "for you" both rendered at x=219.
*/
.board[data-mode=stream] .board-head,.board[data-mode=stream] .board-row{
	grid-template-columns:28px minmax(0,1fr) 66px 74px 58px;
}
.board[data-mode=stream] .board-head>[data-col=pts],
.board[data-mode=stream] .board-row>[data-col=pts]{grid-column:3;display:block}
.board[data-mode=stream] .board-head>[data-col=bscore],
.board[data-mode=stream] .board-row>[data-col=bscore]{grid-column:4;display:block}
.board[data-mode=stream] .board-head>[data-col=games],
.board[data-mode=stream] .board-row>[data-col=games]{grid-column:5;display:block}
/* With a roster, "for you" joins them — it is the only number here about HIS team. */
.board[data-mine][data-mode=stream] .board-head,.board[data-mine][data-mode=stream] .board-row{
	grid-template-columns:26px minmax(0,1fr) 60px 66px 64px 52px;
}
.board[data-mine][data-mode=stream] .board-head>[data-col=pts],
.board[data-mine][data-mode=stream] .board-row>[data-col=pts]{grid-column:3}
.board[data-mine][data-mode=stream] .board-head>[data-col=bscore],
.board[data-mine][data-mode=stream] .board-row>[data-col=bscore]{grid-column:4}
.board[data-mine][data-mode=stream] .board-head>[data-col=mine],
.board[data-mine][data-mode=stream] .board-row>[data-col=mine]{grid-column:5;display:block}
.board[data-mine][data-mode=stream] .board-head>[data-col=games],
.board[data-mine][data-mode=stream] .board-row>[data-col=games]{grid-column:6}
/* Under 640px the board is 300px wide: the name and two numbers. On this tab the
   points ARE the ordering, and a list must always show the number it is sorted by. */
@media(max-width:640px){
	.board[data-mode=stream] .board-head,.board[data-mode=stream] .board-row{
		grid-template-columns:24px minmax(0,1fr) 58px 52px;gap:var(--sp-2);
	}
	.board[data-mode=stream] .board-head>[data-col=bscore],
	.board[data-mode=stream] .board-row>[data-col=bscore]{display:none}
	.board[data-mode=stream] .board-head>[data-col=games],
	.board[data-mode=stream] .board-row>[data-col=games]{grid-column:4;display:block}
	/* With a roster the second number is his own, not the league's. */
	.board[data-mine][data-mode=stream] .board-head,.board[data-mine][data-mode=stream] .board-row{
		grid-template-columns:24px minmax(0,1fr) 58px 56px;gap:var(--sp-2);
	}
	.board[data-mine][data-mode=stream] .board-head>[data-col=mine],
	.board[data-mine][data-mode=stream] .board-row>[data-col=mine]{grid-column:4;display:block}
	.board[data-mine][data-mode=stream] .board-head>[data-col=games],
	.board[data-mine][data-mode=stream] .board-row>[data-col=games]{display:none}
}
`

/**
 * The streaming strip and the two things it adds to a row.
 *
 * Belongs in app.css beside the rest of the board's styling and should move there;
 * it is here because app.css is not this change's file.
 *
 * The move marker is a left rail plus a rule under the last one you can afford,
 * rather than a colour on the text: the question is "where does my list stop",
 * which is a boundary, and a boundary is a line. The rail reuses `border-left`,
 * the same 2px the row already reserves for hover and open, so nothing shifts.
 */
const STREAM_CSS = `
.stream-strip{
	display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-3);
	margin-top:var(--sp-2);
}
.stream-strip .strip-label{
	font-family:var(--mono);font-size:var(--fs-2);letter-spacing:var(--caps);
	text-transform:uppercase;color:var(--faint);
}
/* app.css sets white-space:nowrap on every .toggle, which is right in the filter
   row where the labels are two words. In this strip the availability toggle also
   carries the tier it is using ("est. over 35% is taken"), and at 390px that one
   label ran to 411px — 21px of horizontal scroll on the whole page, on the view
   this change exists to fix. It wraps here instead; the box stays pinned to the
   first line so a two-line label does not centre its checkbox against nothing. */
.stream-strip .toggle{white-space:normal;align-items:flex-start;max-width:100%}
.stream-strip .toggle input{flex:none;margin-top:3px}
.stream-note{margin-top:var(--sp-2)}
/* The availability sentence is NOT a stream-note. That class names the coverage
   line, and test/board.mjs reads the first element matching it — a second paragraph
   sharing the class silently retargeted five assertions at the wrong sentence.
   Same margin, its own name. */
.avail-note{margin-top:var(--sp-2)}
/* his starts and who they are against, under his name. A block, so it elides on a
   phone the way the meta line above it does rather than pushing the row wide. */
.board .board-row .who .starts{
	display:block;font-size:var(--fs-2);color:var(--muted);
	overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
/* Deliberately not a <b>: test/journey.mjs reads every player name off
   \`.board-row .who b\` and test/board.mjs off \`.board-row b\`, so a second bold
   element inside the row would silently turn both into lists of interleaved
   names and start counts. */
.board .board-row .who .starts .n{
	font-family:var(--mono);font-weight:700;color:var(--accent);
}
.board .board-row .who .starts.soft .n{color:var(--muted);font-weight:600}
`

/** Arrow keys walk the tab strip, because a tablist is one tab stop rather than
 *  three. Focus moves without selecting: picking a horizon re-rates all ~1,430
 *  players (~90 ms measured), so activating on every arrow press would make
 *  crossing the strip stutter. Enter or Space chooses the one you land on. */
const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
	const tabs = [...(e.currentTarget.parentElement?.children ?? [])].filter(
		(el): el is HTMLButtonElement => el instanceof HTMLButtonElement
	)
	const i = tabs.indexOf(e.currentTarget)
	const to =
		e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % tabs.length
		: e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + tabs.length) % tabs.length
		: e.key === "Home" ? 0
		: e.key === "End" ? tabs.length - 1
		: null
	if (to === null) return
	e.preventDefault()
	tabs[to]?.focus()
}

/** "Sep 8", not "2026-09-08". An ISO date is a machine's format and this line is read
 *  on every visit; the year is the current season on every row it could appear in. */
const day = (iso: string): string => {
	const [y, m, d] = iso.split("-").map(Number)
	if (!y || !m || !d) return iso
	return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/**
 * The window the SELECTED horizon is actually ranked over.
 *
 * `snapshot.horizon` states one range — the fortnight — and every mode was quoting
 * it. So the streaming view, ranked over the next seven days, said "projected over
 * 2026-09-02 → 2026-09-16", and Billy's pick said "over the next 14 days · his team
 * plays 7 games in that stretch"; the stash view, ranked over every game left,
 * claimed the same fortnight while quoting 23 games in it. The horizon is the one
 * thing the three tabs differ by, so it is derived from the mode here.
 *
 * The week's edges now come from the LEAGUE rather than from the calendar. A rolling
 * seven days is the wrong window for a matchup league — on a Wednesday it counted 7.4
 * games a club when 4.7 remained in the matchup — so `resolvePeriod` supplies the
 * range and the phrase names the period rather than a number of days. The rest of the
 * season has no stated end date in the snapshot, so it is named rather than given the
 * fortnight's.
 *
 * AND THE DATES ARE NOW THE RATING'S OWN, which was the last lie in this function.
 * Two of the three branches read `snapshot.horizon`, a range baked in when the data is
 * captured, while `useBoard` has rebuilt both long windows from TODAY ever since it found
 * the fortnight board projecting across games that had already been played — its own
 * measurement, on `longWindows`, not restated here. Measured
 * 2026-09-12 on the dev server, empty profile: the header read "974 players · Sep 8 →
 * Sep 22" over rows rated across Sep 12 → Sep 26 — a window whose first four days were
 * in the past and which no number on the screen came out of. The rows prove which one
 * they used: fourteen of the thirty clubs have a different game count in the two windows,
 * and all four of them that reached the visible top twelve printed TODAY's — 13 not 12 for
 * Heriberto Hernández of Miami, 14 not 13 for JJ Bleday of Cincinnati, and the same for
 * Arizona and San Diego.
 *
 * So `useBoard` decides the window once and hands over its dates, and this function
 * only words them. It cannot name a window the board was not rated over, because it no
 * longer knows any dates of its own — which also fixes the streaming fallback: a
 * period that resolves to no games is rated over the fortnight, and the header used to
 * go on printing the period's dates anyway.
 *
 * The fortnight is no longer given a day count. `longWindows` builds it as today
 * through today+14 and `windowFrom` counts both edges, so it is fifteen dates of games
 * under a tab that calls itself "This fortnight" — and a phrase reading "the next 14
 * days" beside a range reading "Sep 12 → Sep 26" invites exactly the subtraction that
 * finds the extra day. Naming the shape rather than the arithmetic is true either way,
 * and moving the window's edge to make the number right would move every bscore on the
 * board.
 */
const horizonSpan = (
	over: { kind: "period" | "rest" | "fortnight"; start: string; end: string },
	period: ResolvedPeriod | null,
	/** What the league says about its own season, where it says anything: the day it stops
	 *  scoring, and which of its numbered weeks this is. Both null for a league that states
	 *  neither, and the phrasing below is then exactly what it was. */
	league?: { ends_on: string | null; week: { number: number; of: number } | null } | null
) => {
	if (over.kind === "period" && period) {
		const days = datesBetween(over.start, over.end)
		return {
			/* WHICH OF HIS LEAGUE'S OWN WEEKS, where the league numbers them and the number is
			   checkable — `leagueWeek` walks back in sevens from the last day Yahoo prints and
			   returns null unless the walk lands exactly on the period this app resolved. "Week
			   25 of 26" is what a manager calls this window; a pair of dates is what a database
			   calls it. The rest-of-season branch below has printed it since the day the league's
			   own end date arrived, and the period — the window the number is ABOUT — did not. */
			range: `${day(over.start)} → ${day(over.end)}`,
			phrase:
				// A window the reader chose by length is named by that length, not by the
				// period it was cut out of: "the rest of this scoring period" under a
				// board ranked over three days is the exact class of sentence — true of
				// something else on screen — this file keeps having to delete.
				period.kind === "days" ? `these ${days} days`
				: period.kind === "daily" ? "today"
				: period.kind === "rolling" ? "a rolling 7 days"
				/* HIS LEAGUE'S OWN NUMBER FOR THIS WINDOW, where it numbers them and the
				   number is checkable — `leagueWeek` walks back in sevens from the last day
				   Yahoo prints and returns null unless the walk lands exactly on the period
				   this app resolved. "The rest of week 25 of 26" is what a manager calls this
				   window; "the rest of this scoring period" is what a schema calls it, and it
				   is four words longer on a line that is read on every visit. */
				: league?.week ? `the rest of week ${league.week.number} of ${league.week.of}`
				: "the rest of this scoring period"
		}
	}
	if (over.kind === "rest")
		/*
		   "THE END OF THE SEASON" WAS BASEBALL'S, NOT HIS.
		
		   Yahoo states the day a league stops scoring, and this board was ranking past it —
		   holding men for games his league will not pay for. Where the league said, the date is
		   named; where it also numbers its weeks and the number is checkable, that is named too,
		   because "week 25 of 26" is what a manager calls the thing this window is.
		*/
		return {
			range:
				league?.ends_on ?
					`${day(over.start)} → ${day(league.ends_on)}${league.week ? ` · week ${league.week.number} of ${league.week.of}` : ""}`
				:	`${day(over.start)} → the end of the season`,
			phrase: league?.ends_on ? "the rest of your league's season" : "the rest of the regular season"
		}
	return { range: `${day(over.start)} → ${day(over.end)}`, phrase: "the fortnight ahead" }
}

/**
 * "Chicago White Sox" → "White Sox". The row has room for a nickname, not for a
 * city, and on a streaming row the opponent is the whole point.
 *
 * Derived from the club name the snapshot already carries rather than from a
 * table of abbreviations, because a second table of team names is a second thing
 * to fall out of date — MLB has renamed a club as recently as the Athletics
 * dropping their city, which is why the snapshot's own list has a one-word entry
 * in it. "Sox" is the only nickname ambiguous on its own (Boston and Chicago), so
 * it takes the word in front of it; everything else is unique as its last word.
 */
const nickname = (name: string | undefined): string | null => {
	if (!name) return null
	const w = name.split(" ")
	const last = w[w.length - 1]!
	return last === "Sox" && w.length > 1 ? `${w[w.length - 2]} ${last}` : last
}

/** What the schedule says a player gets out of a streaming window. */
interface Starts {
	/** Turns MLB has actually PUBLISHED — an integer, and the length of `names`. */
	published: number
	/** The engine's own count: published plus his club's unnamed games at his rate
	 *  of starting. This is the number the projection is multiplied by. */
	expected: number
	/** The lineups those published turns fall on, in schedule order. */
	names: string[]
}

/**
 * The two facts a streaming pick turns on, under the player's name.
 *
 * Both were already computed and neither reached the screen. `startOpponents`
 * moved the projection through `pitcherMatchupIndex` — so the board priced a start
 * against Colorado differently from one against Los Angeles — and then showed the
 * reader neither opponent, leaving a ranking he had to take on faith.
 *
 * Published and expected are kept visibly apart. MLB names starters about three
 * days out and then stops, so over a longer window most of a pitcher's turns are
 * the model's estimate rather than an announcement; printing "2 starts" for one
 * announced turn plus one guessed one would be exactly the kind of sentence that
 * looks read off the schedule and was not.
 */
const StartLine = ({ s }: { s: Starts }) => {
	const extra = s.expected - s.published
	if (s.published > 0)
		return (
			<span
				className="starts"
				title={`MLB has published ${s.published} of his turns in this window: ${s.names.join(", ")}.${
					extra >= 0.05 ?
						` His club has games in it with no starter named yet, worth about ${extra.toFixed(1)} more turns at his own rate of starting.`
					:	""
				}`}
			>
				<span className="n">{s.published}</span> {s.published === 1 ? "start" : "starts"} ·{" "}
				{s.names.join(", ")}
				{extra >= 0.5 && ` · ~${extra.toFixed(1)} more once MLB names the rest`}
			</span>
		)
	return (
		<span
			className="starts soft"
			title="MLB has not published any of his turns in this window. This is his own rate of starting applied to his club's unnamed games — an estimate, not an announcement."
		>
			<span className="n">~{s.expected.toFixed(1)}</span> starts · none announced yet
		</span>
	)
}

export const Board = ({
	snapshot,
	league,
	leagueKey,
	error,
	preview = false
}: {
	snapshot: Snapshot | null
	league: League | null
	/** Which league's roster to price each row against. Null is a real state — a
	 *  reader who has not entered a team gets the generic bar and no Δ MINE. */
	leagueKey: string | null
	error: string | null
	/** Whether the league behind these numbers is the shipped preset rather than the
	 *  reader's own. Every number is real and none of it is HIS, and a board that does
	 *  not say which it is on is the demo-league mistake in a new coat. */
	preview?: boolean
}) => {
	/**
	 * Your own men, so a row can be priced against the seat it would actually take.
	 *
	 * The board never mentioned your team: every bscore was measured against the
	 * (teams x seats)-th man in the league, which is the bar for the league and not
	 * the bar for you. Guarded, because `roster.of` throws on a corrupt store and a
	 * bad localStorage key must not blank the one screen that ranks anything.
	 */
	/** Re-read the roster whenever anything in this browser is written — otherwise a
	 *  team entered on Setup does not reach the Δ MINE column until a reload. */
	const rev = useStored()
	const myNames = useMemo(() => {
		if (!leagueKey || !snapshot) return null
		let held: string[]
		try {
			held = roster.of(leagueKey)
		} catch {
			return null
		}
		if (!held.length) return null
		const ids = new Set(held.map(k => Number(k.split(":")[0])))
		return new Set(
			snapshot.players.filter(p => ids.has(p.id)).map(p => normalizeName(p.name))
		)
	}, [leagueKey, snapshot, rev])
	/**
	 * WHO IS TAKEN IN THIS LEAGUE, where his own rosters have been read.
	 *
	 * The top rung of the availability ladder. Guarded the way the roster read above is:
	 * a corrupt store must not blank the one screen that ranks anything, and `taken.ts`
	 * already refuses to hand back anything that did not validate.
	 */
	const takenHere = useMemo(() => {
		if (!leagueKey) return null
		try {
			return takenStore.of(leagueKey)
		} catch {
			return null
		}
	}, [leagueKey, rev])
	const takenSet = useMemo(() => {
		const keys = keysOf(takenHere)
		return keys.size ? keys : null
	}, [takenHere])
	/**
	 * Opens on the question this reader last asked, not on a guess about a stranger.
	 * Only mode, window and moves are restored — see `view.ts` for why the filters
	 * deliberately are not.
	 */
	const [filters, setFilters] = useState<Filters>(() => ({ ...DEFAULT_FILTERS, ...readView() }))
	/**
	 * WHICH ROW'S DRILL-DOWN IS OPEN — and BACK NOW CLOSES IT WITHOUT ALSO COSTING THE TAB.
	 *
	 * Measured on the dev server under StrictMode with an empty profile, 2026-09-12:
	 * Tonight → Pickups took `history.length` from 2 to 3, and then opening a row's
	 * drill-down left it at 3. The gesture pushed nothing. So the one Back a reader presses
	 * to shut a row he opened by mistake closed the row AND undid the tab — measured
	 * landing: Tonight, hash back to `#tonight`, Pickups deselected. One press undoing two
	 * actions, and on a phone Back is the gesture people use most.
	 *
	 * THE MECHANISM IS App.tsx's, deliberately. The push happens in the GESTURE, and the
	 * listener is mounted once and only ever CLOSES. src/client/Dock.tsx records the shape
	 * that does not work — an effect keyed on the open thing that pushes on setup and pops
	 * in its cleanup — which passes against a production build and fails against the dev
	 * server, because StrictMode double-invokes effects and a cleanup that calls
	 * `history.back()` is not idempotent. Nothing in the listener below navigates, so there
	 * is no path by which it can feed itself. It was driven on the DEV server for exactly
	 * that reason: this is the one configuration the broken shape fails under.
	 *
	 * IT EXTENDS App's ENTRY rather than writing one of its own — `bm.row` alongside
	 * `bm.view`, `bm.sheet` and `bm.depth`, with `depth` incremented the way `go` does it.
	 * So Back onto a row entry restores the screen the row belongs to and closes the row, in
	 * the order the reader did them, and `go`'s own "am I standing on an entry this app
	 * pushed" test still has an answer. See `markRow` for why an entry with no `bm` on it is
	 * left alone.
	 *
	 * OPENING A SECOND ROW REPLACES rather than pushes: two rows cannot be open at once, so
	 * a push per row would make Back walk backwards through every row the reader glanced at.
	 * One entry means one Back closes whatever is open.
	 *
	 * THE INITIAL STATE IS READ OFF THE ENTRY, which is not the listener opening rows. App
	 * renders this file only for the `wire` view, so leaving Pickups and coming back
	 * REMOUNTS it: without the read, Back onto a row entry would restore the screen, find
	 * nothing open, and the next Back would be a press that changed nothing visible. It is
	 * one pure read at mount of the entry the browser is already standing on — the same
	 * thing App does with the hash.
	 *
	 * One rough edge left, and it is a no-op rather than a wrong answer: a filter that
	 * removes the open row from the board leaves the entry behind it, so the next Back
	 * closes something already invisible before the one after it moves the screen.
	 */
	const [open, setOpen] = useState<number | null>(() => rowAt())
	useEffect(() => {
		/* ONLY EVER CLOSES. `setOpen` is given a function so the listener needs no dependency
		   on `open` and can stay mounted for the life of the screen — a listener re-bound on
		   every state change is one that can be mid-swap when a gesture fires. */
		const onPop = (e: PopStateEvent) => {
			const row = (e.state as { bm?: { row?: number | null } } | null)?.bm?.row ?? null
			setOpen(cur => (cur !== null && row !== cur ? null : cur))
		}
		window.addEventListener("popstate", onPop)
		return () => window.removeEventListener("popstate", onPop)
	}, [])
	/**
	 * Open a row, or close the open one, and move the history stack with it.
	 *
	 * Closing goes BACK rather than pushing an entry whose only difference is the row being
	 * shut: closing a thing is the undo of opening it, and App.tsx measured the alternative
	 * on the setup sheet, where the extra entry made Back REOPEN what had just been closed.
	 * `back()` is called from a gesture, never from an effect's cleanup, and the state change
	 * arrives back through the listener above, which is the one place `open` is cleared.
	 */
	const toggleRow = (id: number) => {
		const standing = rowAt()
		if (open === id) {
			if (standing === id) {
				try {
					history.back()
					return
				} catch {
					/* fall through and close without the stack */
				}
			}
			setOpen(null)
			return
		}
		setOpen(id)
		markRow(id, standing === null)
	}
	/**
	 * How many rows are rendered. The board used to stop dead at 120 with a line
	 * telling you to narrow the filters, which is the page asking the reader to work
	 * around it — the ranking runs to 1,235 and the whole point is to read down it.
	 *
	 * Rendered in pages rather than all at once because a row is not cheap: 1,235 of
	 * them mount ~9,000 nodes, and paying for the ones nobody scrolls to would show
	 * up on the first paint, which is the one that matters.
	 */
	const [limit, setLimit] = useState(PAGE)
	const sentinel = useRef<HTMLDivElement | null>(null)
	const [pool, setPool] = useState<AvailablePool | null>(null)
	const [poolError, setPoolError] = useState<string | null>(null)
	// Which horizon the keyboard is on, which is not the same as which one is
	// selected — arrowing moves focus without activating. The single tab stop has
	// to follow focus: bound to selection alone, arrowing to Stash and then tabbing
	// out and back put you on the SELECTED tab instead, so Enter re-picked the
	// horizon you had already left. Null until a tab is focused, so the strip opens
	// with its stop on the selected one.
	const [focusedMode, setFocusedMode] = useState<Filters["mode"] | null>(null)
	const leagueId = league?.meta.league_id ?? null

	// the league's actual free agents — a ranking of all of MLB is only half a
	// recommendation when its top names are already rostered
	useEffect(() => {
		if (!leagueId || !canReadPool(league?.meta.platform)) return
		let live = true
		// the platform and season let an ESPN league read its own wire with no server
		api.available(leagueId, {
			platform: league?.meta.platform,
			season: league?.meta.season,
			sport: league?.meta.sport
		})
			.then(p => live && setPool(p))
			.catch((e: unknown) => live && setPoolError(e instanceof ApiError ? e.message : String(e)))
		return () => {
			live = false
		}
	}, [leagueId, league?.meta.platform, league?.meta.season])

	// A fresh Set on every render would invalidate the filter-and-sort memo in
	// useBoard on every render, including ones that changed nothing about it.
	/**
	 * Eligibility as the league's own platform states it, where the free-agent read
	 * carried it. Keyed by normalised name because platform ids are each platform's
	 * own; `useBoard` joins it onto the snapshot's players. See the note there for
	 * why an ESPN league must not be seated by Yahoo's rules.
	 */
	const poolEligibility = useMemo(
		() =>
			pool?.players.length ?
				new Map(
					pool.players
						.filter(p => p.positions.length)
						.map(p => [normalizeName(p.name), p.positions] as const)
				)
			:	null,
		[pool]
	)

	/**
	 * WHAT YOUR OWN LEAGUE PAGE PRINTS BESIDE A FREE AGENT, joined the same way.
	 *
	 * Two columns, both read off the nine pages the sweep already fetches and both
	 * thrown away until now: Yahoo's "% Ros" and Yahoo's status badge. The first
	 * replaces a number from a capture — every "rostered in 35% of leagues" sentence
	 * on this screen came from data/snapshot.json, dated, printed to a reader who read
	 * his own wire thirty seconds ago. The second is the only source in the app for a
	 * man who is day-to-day, in the minors or suspended: `fetchInjuries` keeps only
	 * `^D\d+` codes and drops 513 of 709 non-active entries.
	 *
	 * Gated on `pool.players.length` and deliberately NOT on `poolIsPartial`. Partiality
	 * invalidates "who is free" — a sweep walled at the fifth position leaves real free
	 * agents looking owned — but each ROW's own percentage and own badge are
	 * independent facts about that man and stay true on a four-position sweep.
	 */
	const poolOwnership = useMemo(
		() =>
			pool?.players.length ?
				new Map(
					pool.players
						.filter(p => typeof p.rosteredPct === "number")
						.map(p => [normalizeName(p.name), p.rosteredPct as number] as const)
				)
			:	null,
		[pool]
	)
	const poolStatus = useMemo(
		() =>
			pool?.players.length ?
				new Map(
					pool.players
						.filter(p => !!p.status)
						.map(p => [normalizeName(p.name), p.status as string] as const)
				)
			:	null,
		[pool]
	)

	/**
	 * A partial read is not this league's free-agent list, so it does not become one.
	 *
	 * Yahoo throttles by serving an empty page rather than an error, so a sweep that
	 * asked for nine positions and got one looks, in the data, exactly like a league
	 * with one position's worth of free agents. On 2026-09-09 that arrived here as 25
	 * relievers, the page said "25 players are actually free", and the streaming
	 * board filtered itself down to two rows — every recommendation in the app drawn
	 * from a ninth of the wire.
	 *
	 * Null hands the question back to the ownership estimate, which is the honest
	 * answer: an estimate misjudges who is free, while an incomplete list EXCLUDES
	 * men who are and does it invisibly, because the men it leaves out look exactly
	 * like men somebody else owns.
	 */
	const availableNames = useMemo(
		() =>
			pool && pool.players.length && !poolIsPartial(pool) ?
				new Set(pool.players.map(p => normalizeName(p.name)))
			:	null,
		[pool]
	)
	/** Positions the sweep asked for and did not get — a gap in the read, which the
	 *  page has to distinguish from a league with nobody free there. */
	const missedPositions = useMemo(
		() =>
			pool?.positionsRequested && !poolIsPartial(pool) ?
				pool.positionsRequested.filter(x => !pool.positionsRead.includes(x))
			:	[],
		[pool]
	)
	/**
	 * `mine` rather than `!!myNames`, and that is not a cosmetic swap.
	 *
	 * The "for you" column and the "for you" ORDERING have to agree about whether the
	 * number exists, and they are two different tests if this file asks one question
	 * and `useBoard` asks another: a roster of men the ranking cannot place — sixteen
	 * names with no projectable playing time between them — gives a non-empty
	 * `myNames` and a `worstMineBySlot` of null, which is a drawn column of dashes
	 * beside a heading that sorts by nothing. One boolean, computed where the seats are
	 * actually priced.
	 */
	const {
		rows, scored, slotsRanked, period, leaguePeriod, streaming, teamNames, availability, sort, desc, mine,
		injuryError,
		/* The window the rows were actually rated over. Read rather than derived here: this
		   file used to derive it from `snapshot.horizon` and printed a window four days
		   older than the one the numbers came out of — see `horizonSpan`. */
		ratedOver,
		/* The expected-stats rows are a SECOND file now and the board does not wait for
		   them — see `useContact` in useBoard.ts. Two things come back: which state that
		   file is in, and the call that asks for it. Only the drill-down asks. */
		contactStatus, askForContact,
		/* When the wire the rows were priced off was read. Null when no row carries his
		   own league's figure, in which case nothing says anything about age. */
		wireAt
	} = useBoard(
		snapshot,
		league,
		filters,
		availableNames,
		poolEligibility,
		missedPositions,
		/* What the sweep actually reached. See the note on the parameter: an unread position
		   used to put a replacement bar of 0 under every man who plays it. */
		pool && !poolIsPartial(pool) ? pool.positionsRead : null,
		myNames,
		/* Yahoo's own two columns off the reader's own league page — the roster share and
		   the status badge — which used to die in the store. See the note above. */
		poolOwnership,
		poolStatus,
		pool?.readAt ?? null,
		/* The exact answer, where a complete roster read is stored. Everything else on the
		   ladder approximates this. */
		takenSet,
		takenHere ? { teams: takenHere.teamsRead.length, at: takenHere.at } : null
	)
	/** How old the figures that came off his own league page are, in the words the pool
	 *  chip already uses. Computed once for the whole list rather than per row: every row
	 *  that carries a wire figure carries it from the same read. */
	const wireAge = useMemo(
		() => (wireAt ? since(wireAt, Date.now()).label : null),
		[wireAt]
	)

	/** What "only players I can add" is doing right now — the reader may not have
	 *  said, in which case the tab has answered for him. */
	/** What this league lets you spend in a week, where it says. Null is "it did not
	 *  say", never a default — a made-up cap is worse than no cap. */
	const budget = useMemo(() => {
		const raw = ((league?.league_rules as { raw_settings?: Record<string, string> } | undefined)
			?.raw_settings ?? {}) as Record<string, string>
		return {
			moves: deriveMoveLimit(raw).perPeriod,
			innings: deriveInningsMinimum(raw).perPeriod
		}
	}, [league])

	const availableOnly = filters.availableOnly ?? AVAILABLE_ONLY_DEFAULT[filters.mode]
	/**
	 * The availability tooltip, with the wire's own failure in it when there was one.
	 *
	 * `poolError` used to reach the screen through this control's title and became
	 * write-only when the estimate took over: the page fell back correctly and said
	 * nothing about what it had fallen back FROM. A reader running the local API and
	 * getting an estimate anyway is entitled to the reason, and "absent is reported
	 * as absent" covers a source that answered with an error just as much as one that
	 * was never asked.
	 */
	const availTitle =
		availability.basis === "pool" || availability.basis === "taken" || !poolError ?
			availability.basisText
		:	`${availability.basisText}. Your league's own free-agent list could not be read.`
	useEffect(() => {
		writeView(filters)
	}, [filters.mode, filters.days])

	const set = <K extends keyof Filters,>(k: K, v: Filters[K]) =>
		setFilters(f => ({ ...f, [k]: v }))

	// A new ranking starts at the top. Without this, changing the sort while scrolled
	// deep leaves 600 rows of a list nobody asked for still mounted.
	useEffect(() => setLimit(PAGE), [filters, snapshot, league])

	/**
	 * Grow the window when the end of the list comes into view. An observer rather
	 * than a scroll handler, so nothing runs on the frames between.
	 */
	useEffect(() => {
		const node = sentinel.current
		if (!node || typeof IntersectionObserver === "undefined") return
		const io = new IntersectionObserver(
			entries => {
				if (entries.some(e => e.isIntersecting)) setLimit(n => n + PAGE)
			},
			// start fetching a screen early, so the list feels continuous
			{ rootMargin: "600px" }
		)
		io.observe(node)
		return () => io.disconnect()
	}, [rows.length])

	if (error)
		return (
			<section className="card full">
				<h2>Player data</h2>
				{/* "the player data", as Tonight and the masthead chip both call it. This said
				    "the snapshot", which is the file's name and not a thing a reader has ever
				    seen — three names for one thing, one of them jargon. */}
				<p className="empty">Couldn&rsquo;t load the player data: {error}</p>
			</section>
		)
	if (!league)
		return (
			<section className="card full">
				<h2>The wire</h2>
				{/* "— the board ranks players in your league's scoring" stood after the dash: the
				    page telling a reader why it cannot do the thing, in front of the one gesture
				    that makes it able to. What he needs is the gesture. */}
				<p className="empty">Import or configure a league first.</p>
			</section>
		)
	if (league.meta.max_teams == null)
		return (
			<section className="card full">
				<h2>The wire</h2>
				{/* The first sentence — "a player is worth what he beats the next man up by, and
				    how deep the waiver wire runs decides who that is" — is the model explaining
				    itself to a reader who is looking at an empty board, and panels.tsx already
				    says it beside the field he has to fill in. What belongs here is where to go. */}
				<p className="empty">
					Set the team count on <b>My league</b> and the board fills in.
				</p>
			</section>
		)
	if (!snapshot)
		return (
			<section className="card full">
				<h2>The wire</h2>
				<p className="empty">Loading player data…</p>
			</section>
		)

	// An unconfigured template has a roster shape but no scoring, and a board of
	// 1,432 players all worth zero reads as working rather than as empty.
	if (scored && !scored.hitting && !scored.pitching)
		return (
			<section className="card full">
				<h2>This league has no scoring yet</h2>
				<p className="sub">
					<b>{league.meta.league_name ?? "This template"}</b> has roster slots but no
					points values, so every projection would come out at zero.
				</p>
				<p className="sub">
					Paste your league URL above to read the real values off the platform, or enter
					them under <b>Scoring</b>.
				</p>
			</section>
		)

	// Not a hook, so it belongs after the refusals above rather than among them —
	// and it needs the snapshot they have just established exists.
	const span = horizonSpan(
		ratedOver,
		period,
		league ?
			{
				ends_on: league.scoring_period?.ends_on ?? null,
				week: period ? leagueWeek(league, period) : null
			}
		:	null
	)

	/** Whether the window on screen runs past the day the league resets — the one thing
	 *  `period.basis` says that the header above the board cannot, because it is about the
	 *  points a reader would be counting for the wrong matchup. Only a window the reader
	 *  chose by length can do it; the period's own end is the period's own end. */
	const pastReset =
		ratedOver.kind === "period" && period?.periodEnd != null && ratedOver.end > period.periodEnd

	/**
	 * A row's start schedule, or null where there is nothing honest to say: off the
	 * streaming tab, or for a player the window cannot speak about — no club, a club
	 * with no games in it, or a reliever, whose published count says nothing about
	 * when he next appears.
	 */
	const startsFor = (r: Ranked): Starts | null => {
		if (!streaming || r.scheduledStarts == null || r.scheduledStarts <= 0) return null
		return {
			published: streaming.publishedStarts.get(r.player.id) ?? 0,
			expected: r.scheduledStarts,
			names: (streaming.startOpponents.get(r.player.id) ?? []).map(
				id => nickname(teamNames.get(id)) ?? `club ${id}`
			)
		}
	}


	/**
	 * Billy names the best player you can GET, not the best player. The top of a
	 * bscore board is the best man in baseball, who is rostered everywhere — true,
	 * and useless as a recommendation.
	 *
	 * Availability comes from your league's own free-agent list where that is
	 * readable, and otherwise from how widely he is rostered, which is in the
	 * snapshot and needs no server. Failing both it is the best row on the board,
	 * and the card says availability is unknown rather than implying one.
	 *
	 * The pick is REDUCED over the reader's filtered rows, never read off the front
	 * of them. It used to `find` the first available row, which made the
	 * recommendation a function of sort DIRECTION: clicking the bscore header into
	 * ascending order put the worst players on top and Billy recommended one of
	 * them — observed live as "Nick Solak, bscore -109.33, confidence 2% (10 of
	 * 434)", a man projected 109 points BEHIND the body already on waivers.
	 * Direction is a way of looking at the board, not a change of question, so the
	 * pick must be the same name ascending and descending. The reader's FILTERS do
	 * change the question and still apply — a catcher-only board still names the
	 * best catcher you can get.
	 *
	 * The metric is bscore, not whichever "Rank by" is selected. Every clause this
	 * card speaks is denominated in bscore ("N more points than the best {slot} you
	 * could add off waivers") and the badge on its right prints bscore, so crowning
	 * the uscore or luck leader would show a number that is not the largest one
	 * beside a sentence that does not explain why he is there. The chosen lens still
	 * reaches the pick through the rows it leaves standing — uscore, market edge,
	 * luck and contact each drop everyone they cannot price — so the lens narrows
	 * the candidates and bscore decides among them.
	 */
	// bscore <= 0 means the freely available body at his own slot outscores him, so
	// adding him is a net loss of points. There is no honest way to recommend that.
	const addable = rows.filter(r => r.bscore > 0)
	/**
	 * WHO IS BEST, and the answer changed the moment the reader told the app his team.
	 *
	 * This reduced on bscore alone, on the reasoning recorded above: every clause on the
	 * card is denominated in bscore, so crowning any other column's leader would print a
	 * sentence that does not explain the number beside it. That reasoning is sound and
	 * the conclusion was wrong once `deltaMine` existed, because the fix is to write the
	 * other sentence rather than to keep answering the other question. Driven at 390x844
	 * with sixteen real players typed in: the board opened 35.27 / 34.85 / 33.53 by
	 * bscore, Billy picked Grant Taylor at the top of it, and the "for you" column
	 * beside those same rows read +20.3 / +65.4 / +64.0 — the recommendation was beaten
	 * on the reader's own number by seven of the eight rows printed under it, and by
	 * Josh Bell (+66.3), who was not on the first screen at all.
	 *
	 * A NULL LOSES TO ANY NUMBER and never wins on being large. `deltaMine` is null when
	 * nobody the reader owns is eligible for a seat this man could take, which is the
	 * absence of an answer rather than a good one — so a priced row beats an unpriced one
	 * outright, and bscore decides only among rows nobody's roster can price (which is
	 * every row when no team has been entered, i.e. exactly the old behaviour).
	 *
	 * Still a REDUCE and still not `rows[0]`, for the reason the long note above gives:
	 * the pick must be the same man ascending and descending, because direction is a way
	 * of looking at the board and not a change of question.
	 */
	/*
	 * ═══ AND THEN A SEASON WAS PLAYED WITH IT, WHICH IS THE PART THAT WAS MISSING ═══
	 *
	 * Everything above is a measurement of one SCREEN, and it is still true: with sixteen
	 * players typed in, the man this card picked by bscore was beaten on the reader's own
	 * "for you" number by seven of the eight rows printed under him. That is a real
	 * defect and ranking by `deltaMine` really does fix it.
	 *
	 * What nobody had done was ask whether `deltaMine` is the better METRIC.
	 * `grep -rn deltaMine src/backtest src/auto` returned nothing: the number deciding
	 * this app's single most prominent recommendation had never appeared in a simulator
	 * arm or a stored result, while model.json calls value over replacement "the dominant
	 * component". It is in one now — `deltaMineStrategy` in src/backtest/season.ts, which
	 * ranks exactly as this reduce does, roster-relative, rebuilt every week. Over 111
	 * paired weeks with the league's own bench and two moves a week:
	 *
	 *     bscore vs delta-mine   65W-46L   +21.5/wk   95% CI [+5.9, +36.3]   p(t) 0.0053
	 *
	 * and delta-mine also finishes below `thoughtful-human`, which bscore is ahead of.
	 * Dropping the replacement subtraction drops slot scarcity out of the pick, and
	 * scarcity is most of what the metric is for: it is why a catcher who scores less is
	 * the right add. Twenty-one points a week is more than the model's entire margin over
	 * a good human.
	 *
	 * SO THE PICK GOES BACK TO BSCORE, and the screen complaint above is answered the
	 * other way round — by the pick and the board's own default ORDERING now agreeing,
	 * both being bscore, so the row Billy names is the row at the top of the list the
	 * reader is looking at. The "for you" column stays exactly where it is: it is the
	 * right answer to "what does he gain ME", which is a different question from "who
	 * should I add", and it is still the number a reader acts on once the man is chosen.
	 *
	 * Still a REDUCE and still not `rows[0]`, for the reason the long note above gives:
	 * the pick must be the same man ascending and descending, because direction is a way
	 * of looking at the board and not a change of question.
	 */
	const best = (c: BoardRow[]) => c.reduce((a, b) => (b.bscore > a.bscore ? b : a))
	/**
	 * The same three tiers, from the same place.
	 *
	 * This used to run its own rule — the league's wire if it had one, otherwise
	 * `rosteredPct < 70` — and that second clause was the only availability answer
	 * the hosted site could give. It was wrong in both directions at once: 70% is a
	 * constant where the honest bar is the league's own size, and it required a
	 * printed ownership figure, so it silently refused to recommend any of the 553
	 * players the live capture leaves unpriced. `useBoard` now answers the question
	 * once and both the card and the filter read that answer, so the pick can no
	 * longer be a man the board beneath it has filtered out.
	 */
	const tier = addable.filter(r => r.free === true)
	const picked = tier.length ? best(tier) : undefined
	const pick = picked ?? (addable.length ? best(addable) : null)
	const basis: "pool" | "ownership" | "none" =
		picked === undefined ? "none"
		: /* A roster read is exact, so it speaks in the same voice the wire does rather than
		     in the estimate's. */
			availability.basis === "pool" || availability.basis === "taken" ? "pool"
		:	"ownership"

	/**
	 * What the reader has narrowed, in his own words.
	 *
	 * "batters only" and "pitchers only" used to head this list, from the Side select
	 * that is now gone. "injured hidden" is scoped to Stash for the same reason the
	 * checkbox is — on the other two horizons the filter cannot match, so naming it
	 * there would be the page claiming a cut it did not make.
	 *
	 * It no longer opens a disclosure, because there is no disclosure: the `.more` fold
	 * held these three controls and held them badly. `open={narrowed.length > 0}` is a
	 * CONTROLLED prop, so clearing the last filter slammed the fold shut under a reader
	 * who had opened it himself — driven on the published build: open the fold, choose
	 * "batters", put Side back to "batters + pitchers", and the fold is closed with
	 * "Rank by" and "Hide injured" off screen mid-gesture.
	 */
	const narrowed = [filters.mode === "stash" && filters.hideInjured ? "injured hidden" : ""].filter(
		Boolean
	)

	/**
	 * A league that pays for one side of the ball and not the other, said on the
	 * board rather than only on My league.
	 *
	 * This is not hypothetical and it is not a broken import: Yahoo prints the two
	 * stat tables under separate headers, so a settings page copied from a league
	 * that scores batters only — or a copy that caught one table and missed the
	 * other — yields `scoring.pitching: {}`. Reproduced on the published build by
	 * pasting a Batters table with no Pitchers table: the league is created, My
	 * league says so twice ("No pitching stats scored", and "The paste carried no
	 * pitching scoring" under Needs review), and Pickups said nothing at all. The
	 * board fell from 1,009 rows to 481, the word "pitch" appeared nowhere on the
	 * screen, and SP, RP and P were still offered as chips — each answering "0
	 * players. Try a different position or a wider window", which blames the reader
	 * for a filter that could not have matched.
	 *
	 * `rateAll` has always been right about it: every pitcher comes back
	 * `rateable: false` with `unrateable` reading "this league scores nothing on the
	 * pitching side". That reason was reaching nobody, because an unrateable player
	 * is not drawn. This is that reason, lifted to where the ranking is read.
	 *
	 * Null when both sides score (the ordinary case) and when NEITHER does — the
	 * refusal card above has already returned for that one, and saying it twice in
	 * two different shapes is how a page ends up disagreeing with itself.
	 */
	const unscored: "pitching" | "batting" | null =
		!scored ? null
		: scored.hitting && !scored.pitching ? "pitching"
		: scored.pitching && !scored.hitting ? "batting"
		: null

	/**
	 * The position chips, minus any that cannot match.
	 *
	 * Read off `slotsRanked` — the slots the rateable pool actually holds — rather
	 * than off a hardcoded map of slot to side, because the map would be wrong: on
	 * the committed capture five pitching-group players carry infield or outfield
	 * eligibility, so the sides do not partition the chips cleanly. See
	 * `slotsRanked` in useBoard.ts.
	 *
	 * A chip the reader has ALREADY PICKED is kept whatever the pool says, so the
	 * way out of a narrowed board can never be taken away from him. That is reachable:
	 * pick SP, go to My league, paste a settings page with no pitching in it, come
	 * back — and without this the board would sit at zero rows with no control on
	 * screen to undo it, which is the hidden-filter defect this file already carries
	 * two comments about.
	 */
	const slotChips = SLOTS.filter(s => !s || slotsRanked.has(s) || filters.slot === s)
	/** Has the reader himself cut anything down — the test for whether an empty board
	 *  is his doing or the league's. `narrowed` alone is not it: it names only the two
	 *  filters the fold's summary lists, and a position chip or a search string empties
	 *  a board just as thoroughly. */
	/** Everything narrowing the board right now, in the reader's words, so the empty-state
	 *  message can name the actual cause rather than only the two in `narrowed`. */
	/**
	 * ...and only the ones that are ON THIS HORIZON, which they were not.
	 *
	 * The position chips and the name box are drawn on the fortnight and Stash and not
	 * on Streaming, and `rows` in useBoard.ts now reads them only where they are drawn.
	 * This sentence has to agree with that or it names a control the reader cannot see:
	 * driven before the scoping, a C chip picked on the fortnight emptied the Streaming
	 * tab completely and the note under it read "No players match the C position. Clear
	 * one of those to widen it" — an instruction to clear a chip that is not on the
	 * screen it is printed on.
	 */
	const narrowingNames = [
		...narrowed,
		filters.mode !== "stream" && filters.slot ? `the ${filters.slot} position` : "",
		filters.mode !== "stream" && filters.search.trim() ?
			`the search for "${filters.search.trim()}"`
		:	""
	].filter(Boolean)
	/** The ones that went, named in the note so their absence is stated rather than
	 *  left as a gap the reader has to notice. */
	/* The slots actually WITHHELD from the chip row — which is not the same as the slots
	   the rateable pool lacks. `slotChips` keeps whichever chip the reader already picked,
	   so that it cannot become impossible to widen a board narrowed before the league
	   changed under him; the note has to agree with the chips it is describing, or it says
	   "SP is not offered" with SP on screen and pressed. */
	const hiddenSlots = SLOTS.filter(s => s && !slotsRanked.has(s) && filters.slot !== s)
	/**
	 * How widely rostered the top of the board actually is, for the sentence that explains
	 * why the top of the board is men nobody recognises.
	 *
	 * Null unless all ten of the first ten carry a published share — see the note on the
	 * intro paragraph below. `rosteredPct` is Yahoo's own "% Ros" off the capture, the same
	 * figure Billy's card already quotes for the one man it picks ("rostered in 35% of
	 * leagues"), so the board and the card cannot disagree about it.
	 */
	return (
		<>
			{/*
			  THE SCREEN'S DESCRIPTION OF ITSELF STOOD HERE — `purpose("wire")`, "Everyone you
			  can actually get, ranked in this league's scoring, over the window you pick."

			  It is a sentence about the page rather than an instruction to the reader, and it
			  was charging 61px of a 844px phone for it at the very top of the one screen whose
			  job is ranked rows: measured at 390x844 on the dev server, the first ranked row
			  sat at y937, which is not merely off the first screen but 42px past the y895 this
			  file's own "more filters" note records as the bug it had already fixed once.
			  Deleting it is 61 of the 163px that pass bought back.

			  The sentence is not lost: `VIEWS` still carries it and My league still prints it
			  under "What each tab does", which is where a reader asking what a tab is for
			  actually is. What tells him what THIS board is showing is now the header under it,
			  which names the window in his league's own words rather than in the app's.
			*/}
			{/*
			  A toolbar, not a card.

			  This was a full card with its own heading — "What are you deciding?" — and
			  it cost 322px on a desktop and 431px on a phone, sitting between the two
			  surfaces that answer the reader's question. A card announces a subject; this
			  is a set of controls whose meaning is the thing they filter, which is
			  directly underneath. The heading is on the label of each control.
			*/}
			<section className="board-controls">
				<style href="board-mode-focus" precedence="default">{MODE_FOCUS_CSS}</style>
				<style href="board-grid" precedence="default">{BOARD_GRID_CSS}</style>
				<style href="board-stream" precedence="default">{STREAM_CSS}</style>
				<style href="board-stream-grid" precedence="default">{STREAM_GRID_CSS}</style>
				{/* The tabs are the tablist's only children, because a tablist that
				    contains anything else stops being one to a screen reader. */}
				<div className="modes" role="tablist" aria-label="What to rank for">
					{MODES.map(([id, fixedLabel, fixedWhy]) => {
					// The standing board is named by the window it ranks; the other two name
					// their own question and never move. See `standingBoard`.
					/* `leaguePeriod`, not `period`: the strip names all three horizons at once,
					   including the two the reader is not standing on, and `period` carries the
					   day-count a reader may have set on STREAMING. With a chip set it comes
					   back `kind: "days"`, which fails `periodScoped`'s matchup test, so this
					   tab read "This fortnight" over a board that would rank the league's week
					   — the narrowing does not even apply on the tab being named. */
					const { label, why } =
						id === "board" ?
							standingBoard(leaguePeriod, filters.mode === "board" ? ratedOver.kind : null)
						:	{ label: fixedLabel, why: fixedWhy }
					return (
						<button
							key={id}
							id={tabId(id)}
							type="button"
							role="tab"
							aria-selected={filters.mode === id}
							aria-controls={PANEL_ID}
							// roving tabindex: the strip is one stop and the arrows move within it,
							// and that stop sits wherever the keyboard last was
							tabIndex={(focusedMode ?? filters.mode) === id ? 0 : -1}
							onFocus={() => setFocusedMode(id)}
							onKeyDown={onTabKey}
							className={`mode${filters.mode === id ? " on" : ""}`}
							/* The explanation moves to the tooltip. As three stacked cards with a
							   line of prose each, this strip was 130px of the 1,229px climb to the
							   first ranked row — and the prose answers a question you have once,
							   above a control you use every visit. */
							title={why}
							onClick={() => setFilters(f => ({ ...f, mode: id }))}
						>
							<b>{label}</b>
						</button>
					)})}
				</div>
				{/*
				  The streaming controls, and only on the streaming tab.

				  They sit directly under the tabs, above the position chips, because they
				  are the horizon: picking "3 days" is the same kind of act as picking
				  "Streaming", and putting it below the general filters would have made the
				  most specific control the least findable one. One click from landing gets
				  here; the second click is the window.

				  Scoped to `stream` in the same expression that scopes the filters in
				  useBoard, so the controls and their effects appear and disappear together.
				*/}
				{filters.mode === "stream" && (
					<div className="stream-strip">
						<div
							className="chips"
							role="group"
							aria-label="Streaming window"
							title="How far ahead to count. The league's own scoring period is the default because the reset is what a head-to-head matchup is settled on. The short counts are where the schedule data is strongest: MLB names starters about three days ahead and then stops, so a longer window adds games without adding certainty about who pitches them."
						>
							<span className="strip-label">Window</span>
							{WINDOWS.map(([days, label]) => (
								<button
									key={label}
									type="button"
									className={`chip-btn${filters.days === days ? " on" : ""}`}
									aria-pressed={filters.days === days}
									onClick={() => set("days", days)}
								>
									{label}
								</button>
							))}
						</div>
						{/*
						  The control that makes this tab an answer, and it opens ON.

						  It was a checkbox down in the general filters called "Free agents
						  only", it read the league's live free-agent list, and that list
						  needs the local API — so on beanemachine.com it was permanently
						  disabled and the streaming list opened with Tyler Glasnow (94%
						  rostered), Blake Snell, Chris Sale (99%) and Drew Rasmussen (95%)
						  at the top. To stream a starter is to pick one up; four men nobody
						  can pick up is not a list of streamers, it is the board with a
						  filter on it.

						  It stays a visible toggle rather than becoming an invisible rule,
						  because this page has already shipped a mode-scoped filter that
						  went on filtering after its checkbox stopped rendering and emptied
						  the board with nothing on screen to undo it. Unticking it is how
						  the reader asks "and who is out there if I could have anyone".
						*/}
						<label className="toggle" data-avail={availability.basis} title={availTitle}>
							<input
								type="checkbox"
								checked={availableOnly}
								onChange={e => set("availableOnly", e.currentTarget.checked)}
							/>
							<span>
								Only players I can add
								<em className="pool-count">
									{" "}
									{availability.basis === "taken" ? "off your league's rosters"
									: availability.basis === "pool" ? `${availability.size} free`
									: availability.basis === "ownership" ? `est. over ${availability.cut!.cut}% is taken`
									:	"can't tell"}
								</em>
							</span>
						</label>
						<label
							className="toggle"
							title="Keeps only players the schedule has pitching inside this window — published turns plus the games his club has not named a starter for yet, at his own rate of starting."
						>
							<input
								type="checkbox"
								checked={filters.startersOnly}
								onChange={e => set("startersOnly", e.currentTarget.checked)}
							/>
							<span>Only players with a start</span>
						</label>
						{/* A capture older than the period it is asked about resolves to a window
						  with no games in it. The ranking already falls back to the fortnight
						  rather than rate everyone at zero, and the streaming controls fall
						  back with it — so they have to say why, or the checkbox above reads
						  as broken rather than as inapplicable. */}
						{!streaming && (
							<em className="strip-label">
								this capture holds no games in that window, so the board is ranking the
								fortnight instead and the filter is off
							</em>
						)}
					</div>
				)}
				{/* Position first and as chips, not a select: it is the filter people reach
				    for constantly, and two clicks to change a dropdown is two too many. */}
				{/* Not on the streaming list: it is already only players with a start, so
				    every row is a pitcher and these chips separate P from RP and nothing
				    else. Two rows above the answer for that is a bad trade — they live in
				    "more filters" there. */}
				{filters.mode !== "stream" && (
				<div className="chips" role="group" aria-label="Position">
					{/* `slotChips`, not SLOTS: a league that scores one side of the ball has
					    no rateable player at the other side's positions, and a chip that
					    cannot match is not a filter. See `slotChips`. */}
					{slotChips.map(s => (
						<button
							key={s || "any"}
							type="button"
							className={`chip-btn${filters.slot === s ? " on" : ""}`}
							aria-pressed={filters.slot === s}
							onClick={() => set("slot", s)}
						>
							{s || "All"}
						</button>
					))}
				</div>
				)}
				<div className="filters">
					{/* No label above it: "Search" over a box that says "Player name…" is a
					    line of type saying what the box already says, and this row sits
					    between a reader and the ranking. The accessible name is on the
					    input. */}
					{filters.mode !== "stream" && (
					<label className="ctl ctl-search">
						<input
							type="text"
							value={filters.search}
							placeholder="Player name…"
							aria-label="Search by player name"
							onChange={e => set("search", e.currentTarget.value)}
						/>
					</label>
					)}
					{/* Not `disabled` any more, and that is the whole point of this change.
					    It was disabled whenever the league's live free-agent list had not
					    arrived, which on the hosted build is always — so the one control
					    that answers "who can I actually get" was dead on the site the app
					    is published at. It now falls back to the ownership estimate, which
					    ships in the snapshot, and only goes inert where even that cannot be
					    read. The count beside it says which of the two answered.

					    Not rendered in `stream`, where the strip above already carries this
					    exact control. Both were on screen at once, bound to one piece of
					    state, and they did not agree about it: on a capture whose ownership
					    cannot locate the boundary the strip's copy read "can't tell" and was
					    operable, while this one read "unavailable" and was `disabled`. One
					    control, one screen, two words for the state and two answers to
					    whether you may change it. The strip's copy is the one scoped to the
					    question, so it is the one that survives. */}
					{filters.mode !== "stream" && (
					<label className="toggle" data-avail={availability.basis} title={availTitle}>
						<input
							type="checkbox"
							disabled={availability.basis === "none"}
							checked={availableOnly}
							onChange={e => set("availableOnly", e.currentTarget.checked)}
						/>
						<span>
							{/* Short, because this label sits in the general filter row and the
							    row has to survive a 390px phone: the longer wording measured
							    419px of horizontal scroll on the board. */}
							Only players I can add
							<em className="pool-count">
								{" "}
								{availability.basis === "taken" ? "exact"
								: availability.basis === "pool" ? `${availability.size} free`
								: availability.basis === "ownership" ? "estimated"
								:	"can't tell"}
							</em>
						</span>
					</label>
					)}
					{/*
					  HIDE INJURED, on the one horizon where it can match.

					  It lived behind "More filters" with two controls that are now deleted,
					  and it is here rather than deleted with them because on Stash it really
					  filters: driven on the published build, 1,446 rows to 1,245, and one man
					  off the visible top sixty (Braxton Ashcraft, rank 50, listed 15-day).
					  On the other two horizons it cannot match at all — `rateAll` is already
					  passed `injuryPolicy: "exclude"` there, so the fortnight went 1,008 to
					  1,008 and Streaming 77 to 77 with every rendered row byte-identical.

					  Stash is also the only horizon where the question makes sense: over the
					  rest of a season an injured man is a legitimate hold, which is why that
					  is the horizon that keeps him in the ranking in the first place.

					  Rendered and SCOPED, not one or the other — `rows` in useBoard.ts reads
					  it only in stash mode, so it cannot go on filtering a board whose
					  checkbox has stopped being drawn. That is not a hypothetical: this page
					  has shipped exactly that bug, and the comment on `startersOnly` is the
					  record of it.
					*/}
					{filters.mode === "stash" && (
					<label className="toggle">
						<input
							type="checkbox"
							checked={filters.hideInjured}
							onChange={e => set("hideInjured", e.currentTarget.checked)}
						/>
						<span>Hide injured</span>
					</label>
					)}
				</div>
				{/*
				  "MORE FILTERS" STOOD HERE and held three controls, every one of which is
				  gone. Measured at 390x844 before this pass: 25 controls above the first
				  ranked row, and that row at document y895 on an 844px screen — not one
				  ranked row on the first screen of the page whose job is ranked rows.

				  "Hide injured" could not match on two of the three horizons, because
				  `rateAll` already excludes injured men everywhere except Stash. Driven:
				  the fortnight 1,008 rows to 1,008 and Streaming 77 to 77 with every
				  rendered row byte-identical; Stash 1,446 to 1,245, and one man out of the
				  visible top sixty. So it is not deleted, it is rendered on the one horizon
				  where it filters anything — in the always-visible row above, because a
				  control worth keeping is worth reaching in one gesture.

				  "Side" duplicated the Util and P chips one row up AND disagreed with them:
				  chip Util 441 against Side=batters 440, chip P 567 against Side=pitchers
				  568, with the first sixty rows name-for-name identical both ways. See the
				  note in useBoard.ts's `rows` for the one man the pair contradicts itself
				  about. The chips survive because they name a seat and cost one tap.

				  "Rank by" offered four orderings. One was the "ahead by" column head, one
				  was the points head on the horizon that draws it, and the other two put the
				  rows in an order whose number no column showed — which is why the generic
				  `[data-col=sorted]` track had to be invented. The heads ARE the orderings
				  now, and `sortable` in useBoard.ts makes "every ordering has a visible
				  column" true by construction instead of by patching it per metric.

				  And the fold carried a defect of its own: `open={narrowed.length > 0}` is a
				  CONTROLLED prop, so clearing the last filter shut it under a reader who had
				  opened it himself, taking the other two controls off screen mid-gesture.
				  Driven on the published build: open it, choose "batters", put Side back to
				  "batters + pitchers", and it is closed with his cursor still inside it.
				*/}
			</section>

			{pick ?
				<BillysPick
					r={pick}
					horizon={span.phrase}
					basis={basis}
					streaming={filters.mode === "stream"}
					contactKnown={contactStatus === "ready"}
				/>
			:	<NoPick />}

			{/* The panel the horizon tabs control. The pick, buy-low and scarcity
			    cards below re-rank with it too, but this is the ranking itself, and
			    the sibling cards can't be wrapped without breaking the page grid. */}
			<section className="card full" id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(filters.mode)}>
				{/*
				  ONE LINE, AND IT NAMES THE WINDOW IN THE LEAGUE'S OWN WORDS.

				  `<h2>The wire</h2>` stood in front of it. The screen is called Pickups, the tab
				  is drawn selected above, this is the only card on it, and the panel takes its
				  accessible name from that tab (`aria-labelledby`), so the heading named the
				  screen to a reader already standing on it. At 390x844 the pair measured 63px
				  against the 40px the line costs by itself, and it was the last block of
				  furniture between the controls and the column heads.

				  What replaces it is the sentence this board could not previously say: WHICH
				  window these rows were ranked over. The dates were already here and a pair of
				  dates does not tell a reader it is his matchup — `period.basis` has always
				  known ("the rest of this scoring period"), and printed it on the streaming tab
				  only, where it was the fourth line of a note nobody reads. It is the heading
				  now, on every horizon, because the horizon is the one thing the three tabs
				  differ by.
				*/}
				<div className="card-head">
					<p className="sub card-head-count">
						<b className="count">{rows.length}</b> players · {span.phrase} · {span.range}
						{budget.moves !== null && (
							<>
								{" · "}
								<b className="count">{budget.moves}</b> add{budget.moves === 1 ? "" : "s"} a
								week
							</>
						)}
						{budget.innings !== null && (
							<>
								{" · "}
								<b className="count">{budget.innings}</b> IP floor
							</>
						)}
					</p>
				</div>
				{/*
				  The injured list this board is using, when it is not tonight's.
				  
				  The rows change either way — measured with MLB blocked, row two moved from
				  3B 34.55 to OF 34.51 and row three from 33.18 to 33.14 — and nothing on this
				  screen said which of the two boards a reader was looking at. Tonight has
				  always said it. An absence is stated as an absence, on every screen that
				  depends on it, and this is the screen a pickup is made from.
				*/}
				{injuryError && (
					<p className="sub warn-note">
						Couldn&rsquo;t reach MLB ({injuryError}), so who is hurt is from the player
						data rather than from today. Anyone placed on the injured list since then is
						still ranked here as if he were playing.
					</p>
				)}
				{/*
				  The league's own blind spot, on the screen where it changes the answer.
				  
				  See `unscored` for the reproduction. Every clause here is a fact the code
				  performs: the side really is left out rather than ranked at zero
				  (`rateable: false` in `rateAll`), the chips really are withheld
				  (`slotChips`), and the place named is the card that fixes it — headed
				  "Batting" and "Pitching" on that screen, and named through `tab()` because
				  a tab label typed into a string is a label that goes stale the next time
				  the three are renamed.
				*/}
				{unscored && (
					<p className="sub warn-note">
						<b>
							This league scores nothing for{" "}
							{unscored === "pitching" ? "pitchers" : "batters"}.
						</b>{" "}
						There is no points total to rank one by, so every{" "}
						{unscored === "pitching" ? "pitcher" : "batter"} is left out of the
						ranking rather than ranked at zero
						{/* Streaming is a list of pitchers by construction — `startersOnly` keeps
						    only men the schedule has starting — so a league with no pitching
						    scoring makes this one tab empty on every visit, however the reader
						    sets the window. Saying "what is ranked below is batters only" under
						    an empty list would be vacuously true and read as wrong. */}
						{unscored === "pitching" && filters.mode === "stream" ?
							<> — and this list is pitchers, so in this league it has nothing to show.</>
						:	<>
								, and what is ranked is{" "}
								{unscored === "pitching" ? "batters" : "pitchers"} only
								{filters.mode !== "stream" && hiddenSlots.length > 0 &&
									`, with ${andList(hiddenSlots)} not offered as positions`}
								.
							</>
						}{" "}
						Fill in <b>{unscored === "pitching" ? "Pitching" : "Batting"}</b> on{" "}
						<b>{tab("trade")}</b> and they come back.
					</p>
				)}
				{/* A coverage warning stood here, for a board ranked by market edge: "Yahoo
				    listed ownership for only N% of this board, so edge can rank just that
				    slice". Market edge is no longer an ordering this screen offers, so there
				    is no such board to warn above — see Filters["sort"] in useBoard.ts. The
				    number itself is untouched and still in the drill-down under every row. */}
				{/* One line, because it is read on every visit: how many, over what window.
				    Everything about HOW the ranking was built — which horizon this is, what
				    playing time leans on, what each column means — is a click below, where
				    it is available on the rare occasion anyone wants it and costs no height
				    on the many occasions nobody does. */}
				{/*
				  What the league lets you SPEND, beside how many there are to spend it on.
				  
				  The scarce resource on this screen is not the ranking, it is the weekly
				  acquisition cap: a board that ignores it invites a reader to plan five
				  adds in a league that allows two. Both figures are read off the league's
				  own settings — `deriveMoveLimit` returns null for "no maximum", which is
				  a real and common answer and is not a large number — and neither is shown
				  where the league did not state it.
				*/}
				{preview && (
					<p className="preview-note">
						{/* NOT "standard". These are league 228947's own values, copied — HR pays
						    10.4 where Yahoo's own H2H-points default pays 4 — so a reader who opens
						    his settings page to compare finds nothing that matches and concludes the
						    app is broken. The app's own "values to check" drawer has said the true
						    thing all along. */}
						{/* One status, no essay. The 25 words after it — "Every number below is real
						    and none of it is about your league yet — set yours up and they all move"
						    — explained the app to the reader; the setup that fixes it is the dock
						    under every screen, one press away, with its own instruction. */}
						<b>One real league&rsquo;s scoring, not yours.</b>
					</p>
				)}

				{/*
				  How much of this window MLB has actually named, MEASURED off the window
				  on screen rather than quoted. Coverage is a property of the capture as
				  much as of the horizon — probables reach about three days past a capture
				  and then stop — so a number written into this string would have been
				  right on the day it was written and wrong every day after. It is also
				  the honest answer to "why is my seven-day list the same length as my
				  three-day one": it is, and the extra four days are estimated.
				*/}
				{/*
				  WHICH OF THE THREE AVAILABILITY ANSWERS THIS PAGE IS GIVING — said on the
				  control that makes the claim, and printed here only where that one line
				  cannot hold it.

				  The whole complaint this note was written for was a streaming list headed by
				  four men who were already rostered, and the fix is only trustworthy if the
				  page is explicit about whether "he is free" was READ or ESTIMATED. It still
				  is: the toggle two hundred pixels above says which, in the same three
				  vocabularies — "off your league's rosters", "213 free", "est. over 35% is
				  taken", "can't tell" — and carries the full derivation as its title.

				  So on the ordinary estimate this paragraph was the same fact a second time,
				  plus an instruction to untick a checkbox that is on screen. Measured at
				  390x844 on the dev server: 75px and 23 words, immediately under the header,
				  in front of the ranking.

				  TWO STATES SURVIVE, because in both of them the line above is short of the
				  truth and the difference is an absence:
				    - `none`: the filter is ticked and NOTHING was filtered out, which the
				      reader cannot see from a list, plus the one instruction that fixes it.
				    - a read that missed positions: "C could not be read this time, so what is
				      listed at that position is short of what your league has" — a gap in the
				      read rather than an empty wire, and the one sentence in this app that
				      keeps an absence of evidence from being rendered as evidence of absence.
				*/}
				{filters.mode === "stream" && availableOnly &&
					(availability.basis === "none" || missedPositions.length > 0) && (
					<p className="sub avail-note">
						<span title={availability.basisText}>
							{availability.basisText.charAt(0).toUpperCase()}
							{availability.basisText.slice(1)}.
						</span>
						{/*
						  The remedy, and it is here because the only one on offer was the
						  wrong one.

						  Where the basis is `none` this tab is answering "which starters can
						  I stream" with a list headed by men who are rostered everywhere —
						  on the committed capture, Chris Sale and Drew Rasmussen — and the
						  one instruction under it was to UNTICK the filter, which shows more
						  of them. That is the opposite of what the reader came for. It is
						  honest about not knowing and silent about the fix.

						  The fix exists and it is one command: the wire is read on a machine
						  and carried in a file (see pool.ts), and the masthead already has
						  the door. This names it from the board, where the question is being
						  asked, under exactly the condition WireChip renders that door — a
						  Yahoo league with no server to read it live. With a server up the
						  wire is read on every load and there is nothing to ask for.
						*/}
						{availability.basis === "none" &&
							league?.meta.platform === "yahoo" &&
							getMode() !== "server" && (
								<>
									{" "}
									To rank only players you can actually add, load your league&rsquo;s
									free-agent list — <b>free agents: none carried</b> in the header
									above opens it.
								</>
							)}
					</p>
				)}
				{streaming && (
					<p className="sub stream-note">
						{/*
						  THE WINDOW'S CAVEATS, AND ONLY WHERE IT HAS ANY.

						  This printed `period.basis` unconditionally and led with it: "The rest of
						  this scoring period, through 2026-09-20." The header above now names the
						  window on every horizon, in the league's own words and in a reader's date
						  format rather than in ISO, so on the ordinary window that sentence was the
						  same fact twice — 24 words and a whole line of a 390px screen, above a
						  board, saying what the line above it had just said.

						  What `basis` carries that the header cannot is the three things that are
						  WRONG with a window, and each of them is an absence stated as an absence:
						  the edges this app had to assume because the league never said, a window
						  running past the reset (whose extra games score for the NEXT matchup, not
						  this one), and a window clipped because the capture holds no games that
						  far out. Where any of those is true the whole sentence prints; where none
						  is, the header has already said everything there was to say.
						*/}
						{period && (period.assumed || period.clipped || pastReset) &&
							`${period.basis.charAt(0).toUpperCase()}${period.basis.slice(1)}. `}
						{/*
						  "starting assignments", not "games". `streaming.games` sums `coverage.games`
						  over CLUBS, and every game has two of them — so on the rest-of-period
						  window over Sep 11-13 the capture's 45 games were printed as 90. The ratio
						  was right and the noun was not, and a reader who counts tonight's schedule
						  finds the app wrong about something he can see. Club-games is also the
						  unit the sentence actually wants: a starter is named per club per game,
						  which is exactly what is being counted.
						*/}
						MLB has named the starter in{" "}
						<b>
							{streaming.published} of {streaming.games}
						</b>{" "}
						starting assignments
						{/*
						  "N of M clubs completely" stood here and was a second way of saying the
						  first fraction: a club is fully named exactly when none of its games is
						  unnamed, so `fullyNamed < clubs` and `published < games` are the same
						  condition — they were never once observed to disagree because they cannot.
						  Measured on the dev server at 390x844, the pair cost a line of the note
						  (94px to 75px) to restate a ratio printed four words earlier.

						  The warning it gated is unchanged and now hangs off the fraction the
						  reader can see, which is the one a test can check against the sentence
						  rather than against a second count that is not on screen any more.
						*/}
						{streaming.published < streaming.games ?
							"; the rest are estimated from each pitcher's own rate of starting."
						:	"."}
					</p>
				)}
				{/* A "Moves left" box, a line of the league's per-period rules, and a "Your
				    N moves" answer all lived here. They are gone because they were a SECOND
				    recommendation: the decision card above this board names both sides of
				    every move and stops at the two a week that measured best, while this
				    said "Your 6 moves" — six, because the box was seeded from the league's
				    cap — listed six pitchers, and named a drop for none of them.

				    The row marking went with them. Highlighting "your top N" is the same
				    recommendation wearing a border, and it is what pulled the answer down
				    here in the first place. The board ranks; the card decides. */}
				{/* `data-sort` is no longer read by any rule — the 640px block it was written
				    for put the uscore column back on a phone when the board was ranked by it,
				    and neither that column nor that ordering exists. It stays on the element
				    because it is what a reader of this markup (and a test of it) uses to see
				    which ordering the rows are in, which is otherwise only inferable from an
				    arrow glyph; `grep -rn data-sort src/ test/` finds this attribute and this
				    comment and nothing else. */}
				<div
					className="board"
					data-sort={sort}
					data-mode={filters.mode}
					data-mine={mine ? "" : undefined}
					data-preview={preview ? "" : undefined}
				>
					{/* Four columns, five when a roster exists or the ordering needs one of its
					    own. It carried nine: `proj pts` and `waiver pts` went because bscore is
					    one minus the other, so the table stated the same fact three times;
					    `owned` was folded into uscore and uscore into the drill-down; confidence
					    and luck went because neither was a decision column. BOARD_GRID_CSS
					    carries the measurements. */}
					<div className="board-head">
						<span data-col="rank">#</span>
						<SortHead col="who" field="name" sort={sort} desc={desc} setFilters={setFilters}>Player</SortHead>
						{/* uscore discounts value by availability, which on a list already
						    filtered to what he can add is that discount applied twice — see
						    STREAM_GRID_CSS. What replaces it is the half of his question the
						    board never answered: what this man actually scores over the
						    window. */}
						{filters.mode === "stream" && (
							<SortHead col="pts" field="points" sort={sort} desc={desc} setFilters={setFilters} right>
								points
							</SortHead>
						)}
						{/* "ahead by", not "bscore". The coined word survives on Billy's badge and
						    in the methodology, where a reader who wants it will find it; the
						    column that carries the decision says what the number is.
						    
						    Rendered on EVERY horizon, streaming included. It was made conditional
						    when the heads were renamed, and the row's cell was not — so on the
						    streaming tab the head had three cells over four of body and every
						    heading sat over the wrong column. A head and a row that disagree about
						    how many cells they have is the exact failure named at the top of
						    BOARD_GRID_CSS. */}
						{/* A generic `sorted` heading stood here, drawn whenever the ordering had
						    no column of its own. Nothing is ordered by a number without a column
						    any more — see the note where its CSS used to be, and `sortable` in
						    useBoard.ts, which is what makes that true rather than hoped for. */}
						<SortHead col="bscore" field="bscore" sort={sort} desc={desc} setFilters={setFilters} right>
							ahead by
						</SortHead>
						{/* Δ MINE: what he gains over the man he would actually displace on YOUR
						    roster. bscore is measured against the (teams x seats)-th man in the
						    league — the right unit for "who is the best available player" and not
						    the unit a move is made in, because a manager is choosing between this
						    man and the worst man he owns who could hold that seat. A deep outfield
						    makes a good free-agent outfielder worth nothing to him; a hole at
						    catcher makes a mediocre one worth a great deal. Rendered only when a
						    roster has been entered — a column of blanks teaches nothing. */}
						{mine && (
							<SortHead col="mine" field="deltaMine" sort={sort} desc={desc} setFilters={setFilters} right>
								for you
							</SortHead>
						)}
						{/* Not "GP" any more. GP is the games a player's TEAM plays, which for a
						    starting pitcher is the wrong number by about a factor of six: on the
						    committed fixture the median starter with published turns has 3.0 of
						    them against ~14 team games on the fortnight, and 1.0 against ~6 on the
						    streaming week — the week where 12 of the top 20 rows ARE starters. The
						    cell names its own unit, GS or GP, so the two can share a column
						    without either claiming to be the other. */}
						<span
							className="r"
							data-col="games"
							title="What this player gets out of the window. For a starting pitcher whose turns MLB has published it is his own scheduled starts (GS); for everyone else it is the games his team plays (GP)."
						>
							{filters.mode === "stream" ? "starts" : "games"}
						</span>
					</div>
					{/* `Math.min(limit, CAP)`: the observer below still pages the list in so the
					    first paint stays cheap, and CAP is where the paging stops. */}
					{rows.slice(0, Math.min(limit, CAP)).map((r, i) => (
						<Row
							key={r.player.id}
							rank={i + 1}
							r={r}
							stream={filters.mode === "stream"}
							wireAge={wireAge}
							starts={startsFor(r)}
							mine={mine}
							/* the reader's budget, counted down the ranking he is actually
							   looking at — his filters have already decided who is on it */
							open={open === r.player.id}
							onToggle={() => toggleRow(r.player.id)}
							contactStatus={contactStatus}
							askForContact={askForContact}
						/>
					))}
					{/* Named the confidence floor, which no longer exists — a dead end offered to
					    a reader who has just emptied his own board. It now names the filters that
					    are actually on, read off the same `narrowed` list the fold's summary uses,
					    so it cannot drift from the controls again. */}
					{!rows.length && (
						<p className="empty">
							{/*
							  Where the league scores one side and the reader has narrowed
							  nothing, the cause is not in the controls and neither remedy below
							  is one: no position and no window brings back a player the scoring
							  cannot price. That is not a corner — the Streaming tab in a league
							  with no pitching scoring is every row a pitcher, so it is empty on
							  every visit, and "try a wider window" sends the reader round the
							  horizon chips after something that was never there.

							  His OWN narrowing still wins the sentence when he has any, because
							  then it really might be the thing to undo, and the note at the top
							  of the card has said the rest either way.
							*/}
							{/*
							  THREE CASES, and the middle one was wrong in both directions.
							  
							  `narrowing` counts a position chip and a search string as well as the
							  two in `narrowed`, so a reader in a one-sided league who had a
							  pitching chip picked before the league changed fell past the first
							  branch and got "try a different position or a wider window" — the dead
							  end this block exists to remove, in the one state where the scoring
							  really is the cause.
							  
							  And the second branch named `narrowed` alone, so a board emptied by the
							  SEARCH BOX with Side=batters set read "No players match batters only",
							  which is a confident wrong attribution where the old vague sentence was
							  at least honest. It names everything that is narrowing now, and the
							  position chip and the search are in that list.
							*/}
							{unscored && !narrowed.length ?
								<>
									Nothing left to rank. This league scores nothing for{" "}
									{unscored === "pitching" ? "pitchers" : "batters"}
									{/* `filters.mode !== "stream"` as well, for the same reason
									    `narrowingNames` carries it: the chip is not drawn on Streaming,
									    and on the horizon that does not draw it the chip is also no
									    longer read, so naming it here would be wrong twice over. */}
									{filters.mode !== "stream" && filters.slot ?
										<>
											, and the <b>{filters.slot}</b> chip can never match one
										</>
									:	", and no position and no window brings one back"}{" "}
									&mdash; the note at the top of this card says where to fill them in.
								</>
							: narrowingNames.length ?
								<>
									No players match <b>{andList(narrowingNames)}</b>. Clear one of those to
									widen it.
								</>
							:	<>No players match these filters. Try a wider window.</>
							}
						</p>
					)}
					{/*
					  ONE SENTENCE ABOUT THE NUMBER THE ROWS ARE IN, generated from the ordering
					  actually in force rather than asserted — and now BELOW the rows rather than
					  above them.

					  The app's one explanation of its own number lived in the colophon, on
					  every screen, and said "a bscore is a ranking, not a forecast". True on
					  two of the three horizons: Streaming ranks on raw projected points by
					  documented decision (`defaultSort` in useBoard.ts), so the only sentence
					  explaining the table was describing a different column from the one the
					  table was sorted by. Reading it out of `sort` is what makes that
					  impossible rather than merely unlikely.

					  WHY IT MOVED. Shut, it is still 72px at 390x844, and it was spending them
					  between the column heads and the first ranked row — the last 72px of a
					  937px climb on a screen 844px tall, so the reader who wanted a ranked row
					  scrolled past a definition to reach one. The definition is not deleted and
					  not weakened: it is the same `<details>`, the same generated sentence, and
					  `COLUMN_HELP` still carries it on the heading itself. It is at the foot of
					  the list, which is where a reader who has read the rows and wants to know
					  what the number means already is.
					*/}
					<details className="board-legend">
						<summary>
							{/* The `orderedBy` branch stood first here, for an ordering with no
							    column of its own. There are none left — see `sortable` in
							    useBoard.ts — so the three that remain are the three columns this
							    table can be ordered by, and each gets its own sentence about its
							    own bar. Never one sentence with the other's number dropped in:
							    that is the mistake `theManLeftAt` and `theWorstManYouHold` exist
							    to make impossible. */}
							{sort === "points" ?
								<>Ordered by the points he should score in this window.</>
							: sort === "deltaMine" ?
								<>
									<b>For you</b> &mdash; points more than {theWorstManYouHold()}
									{preview ?
										", in this league\u2019s scoring."
									:	", in your league\u2019s points."}
								</>
							:	<>
									{/*
									  "the best man still free at his spot" — FALSE, and measured false.
									  
									  The bar is not the best free man, it is the (teams x seats)-th best
									  eligible man: who is left once every club in the league has filled
									  that spot. Named on the shipped league, with each man's Yahoo
									  rostered-in percentage: Util Matt Olson 99%, SS Jeremy Peña 87%,
									  2B Ketel Marte 95%, RP Trevor Megill 85%, P Cal Quantrill 50%. Five
									  of the ten bars are set by a man rostered in 85-99% of leagues, and
									  he is not "still free" by any reading. src/engine/trade.ts:97 had
									  already written down that this sentence was wrong; the sentence was
									  never changed.
									  
									  And "in your league's points" was unconditional, so on a first visit
									  it sat under a banner saying the opposite: the board is running the
									  shipped preset and none of it is about his league yet. Two sentences
									  on one screen disagreeing about whose scoring this is.
									*/}
									{/*
									  NOT "the standard scoring", and the ban on that word is written
									  down twice in this repo — fourteen lines under the banner that
									  retracts it, and in panels.tsx beside the values drawer. The
									  shipped preset pays HR 10.4 where Yahoo's own head-to-head points
									  default pays 4, so a reader who opens his own settings page to
									  compare finds nothing that matches and concludes the site is
									  broken. The banner above this list already has the true words for
									  it: one real league's scoring, not yours.
									*/}
									<b>Ahead by</b> &mdash; points more than{" "}
									{theManLeftAt(null, availability.basis === "pool")}
									{preview ?
										", in one real league\u2019s scoring \u2014 not yours yet."
									:	", in your league\u2019s points."}
								</>
							}
						</summary>
						{/* The caveat is one tap rather than three lines, because on a phone three
						    lines of it is a third of the screen above the thing it describes — and
						    it is a tap rather than a tooltip because a phone has no hover, which is
						    where every other definition in this app used to live. */}
						{/* The definition of the number the board is in, which is the one a reader
						    who changed the ordering is owed. It is the same sentence the cell's own
						    tooltip carries, because a phone has no hover. */}
						{sort === "points" ?
							<>
								Projected points over the window you picked, not a promise.
							</>
						: sort === "deltaMine" ?
							<>
								Every other number here is measured against the man left at that spot once
								every team has filled it, which is the bar for the league. This one is the
								bar for you: the worst man you own who could hold the seat.{" "}
								{/*
								  WHAT THIS ORDERING IS AND IS NOT, said where the reader meets it.
								  
								  The board opens in this order as soon as a team has been entered, and
								  that is a change of DEFAULT rather than of model: nothing about how a
								  player is rated moved, and "ahead by" is still on every row with its
								  own sortable heading one tap away. It also has no backtest behind it.
								  The evidence this project holds — +61.8 points a week, 80 of 111 weeks
								  — was measured on an add list ranked by "ahead by", and no ranking by
								  this column has ever been measured at all. So the claim made here is
								  the only one that is true: it is the question the reader just
								  answered, not the ordering that is known to win.
								*/}
								&ldquo;Ahead by&rdquo; is the ordering with a season of results behind it;
								this one has not been measured. Both are on every row.
							</>
						:	<>
								It ranks players; it does not promise points. 35 means further ahead of the
								man at his spot&rsquo;s bar than 20 is &mdash; not 35 points in the bank.
								That bar is the{" "}
								{league?.meta.max_teams ?
									`${league.meta.max_teams}-team-deep`
								:	"league-deep"}{" "}
								man at the spot: not whoever is best among the men still free, which he
								usually is not, but the one left over once every club has filled it. The window is the one you
								picked above, and who counts as gettable is your league&rsquo;s own
								free-agent list where one has been read
								{availability.basis === "pool" ?
									", which it has"
								:	", and a guess from how widely each man is rostered where it has not"}
								.
							</>
						}
					</details>
				</div>
				{/* The end of the rendered window. Scrolling to it grows the list; when
				    everything is on screen it is an empty div and says nothing. */}
				<div ref={sentinel} aria-hidden />
				{/*
				  Two different sentences, because they are two different facts. One says the
				  rest is coming if you keep going; the other says the rest is not coming at
				  all, and how many men that is. A list that has stopped for good must never
				  be able to read as a list that is still loading — see CAP.
				*/}
				{rows.length > CAP ?
					<p className="sub" style={{ marginTop: 12 }}>
						{/* "are ranked below them and not drawn" was the renderer talking about
						    itself; what the reader needs is the count and the way to one of them. */}
						Showing the top <b className="count">{CAP}</b>.{" "}
						<b className="count">{rows.length - CAP}</b> more are hidden
						{filters.mode !== "stream" ?
							" — type a name above to find one."
						:	"."}
					</p>
				: limit < rows.length ?
					<p className="sub" style={{ marginTop: 12 }}>
						{limit} of {rows.length} — keep scrolling.
					</p>
				:	null}
			</section>

		</>
	)
}



/**
 * What the card says when the filters leave nobody worth adding.
 *
 * bscore is projected points minus what a man you could still pick up at the same
 * slot is projected for — the (teams x seats)-th of them — so a board on which every
 * bscore is <= 0 holds no recommendation at all: only players who would cost you
 * points against the wire as it stands. The card stays
 * on screen and says so: one that silently disappears reads as a bug, and one that
 * names the least-bad option reads as advice.
 */
const NoPick = () => (
	<section className="card full pick">
		<span className="pick-bot" aria-hidden>
			<Billy />
		</span>
		<div className="pick-body">
			<h2>Billy&rsquo;s pick</h2>
			<p className="pick-name">Nobody.</p>
			<p className="pick-why">
				Every player these filters leave projects at or below the man you would have
				instead at his own slot, so each of them would cost you points. Widen the
				filters and ask again.
			</p>
		</div>
	</section>
)

/**
 * Billy's read on the top of the board. Every clause is assembled from a number
 * that is actually on the row — no adjectives the data doesn't support.
 */
const BillysPick = ({
	r,
	horizon,
	basis,
	streaming,
	contactKnown
}: {
	/** A BoardRow, not a Ranked, because the card now leads on the number the reader's
	 *  own roster produced where there is one — see `theWorstManYouHold`. */
	r: BoardRow
	horizon: string
	/** Which availability source picked him, and therefore which claim the card is
	 *  entitled to make. */
	basis: "pool" | "ownership" | "none"
	/** On the streaming view the card is a waiver-day answer, so it drops the two
	 *  clauses that describe the projection rather than the decision. */
	streaming: boolean
	/**
	 * Whether the expected-stats rows are in, which decides whether this card is
	 * entitled to quote a confidence at all. See the `worry` clause below.
	 */
	contactKnown: boolean
}) => {
	const clauses: string[] = []
	/**
	 * THE NUMBER THAT CHOSE HIM LEADS, and it is not always the same number.
	 *
	 * `best()` picks by `deltaMine` wherever a roster can price it, so on a visit where
	 * the reader has told the app his team the card is crowning a man for what he adds
	 * over the reader's own bench — and the old sentence described a different
	 * subtraction entirely. Both are stated, in the order they decided anything, each in
	 * its own words: the bar for you first because it is why he is here, the bar for the
	 * league second because it is the number the column and the methodology are in.
	 *
	 * Each sentence is built by the function that owns it (`theWorstManYouHold`,
	 * `theManLeftAt`) precisely so that neither can be relabelled into the other.
	 */
	if (r.deltaMine !== null)
		clauses.push(
			r.deltaMine > 0 ?
				`Adding him is worth ${r.deltaMine} more points over ${horizon} than ${theWorstManYouHold()}`
				// A negative one is a real state and it is not dressed as a positive: the
				// candidate list is everyone with a bscore above zero, so a man can beat the
				// league's bar while every eligible man in the reader's own dugout beats him.
			:	`Over ${horizon} he projects ${Math.abs(r.deltaMine)} points BEHIND ${theWorstManYouHold()}`
		)
	clauses.push(
		/* `basis` is already this card's argument for which claim it may make, and whose bar
		   the number subtracts is the same question one step further on: a real wire is walked
		   the reader's own seats deep, a simulated one the whole league's. */
		`Projected for ${r.bscore} more points than ${theManLeftAt(r.slot, basis === "pool")}, over ${horizon}`
	)
	// The "rostered in N% of leagues" clause used to live here. It came off the
	// "% Ros" sweep, most of which is the per-game weather line rather than a
	// roster share, so it was stating a number that is usually wrong about a
	// player it is usually wrong about. A missing clause beats a false one.
	/**
	 * Two clauses that are model detail rather than decision detail, and on the
	 * streaming card they are neither.
	 *
	 * Measured at 390px, this paragraph ran to 430px and the whole card to 661 — the
	 * largest single block above the answer on a phone. "3.1 outs recorded per team
	 * game" and "the schedule ahead of him is soft (×1.012)" are inputs to the
	 * projection, not reasons to add a man for one start: a 1.2% schedule adjustment
	 * cannot decide a pickup, and the drill-down under his row already takes the
	 * projection apart for anyone who wants it. On the board and stash views, where
	 * the card is a season read rather than a waiver-day one, they stay.
	 */
	if (!streaming) {
		if (r.projection.volumePerTeamGame !== null)
			clauses.push(
				r.player.group === "hitting" ?
					`${r.projection.volumePerTeamGame.toFixed(1)} plate appearances per team game`
				:	`${r.projection.volumePerTeamGame.toFixed(1)} outs recorded per team game`
			)
		/**
		 * "Hard" and "soft" are claims about size, so they are gated on size.
		 *
		 * This branched on `!== 1` alone, which meant any multiplier at all earned one of
		 * two strong words. Measured live on the committed capture at 390px, the first
		 * drill-down a reader opens said "the schedule ahead of him is hard (×0.997)" —
		 * three tenths of one percent, described in the same words a fifteen percent
		 * effect would get, with the strength of the claim hidden in a parenthesis the
		 * reader has to do arithmetic on.
		 *
		 * Three percent is the floor, and the measurement that sets it also says how little
		 * this clause was ever carrying. On the committed capture, rating all 1,248
		 * rateable men: the median gap between neighbouring bscores in the top hundred is
		 * 1.32% of the bscore (p25 0.54%, p75 2.71%), and the schedule multiplier itself
		 * never reaches 3.2% — the largest |1 - x| in the whole pool is 3.1%, the 90th
		 * percentile is 1.8%, and 1,226 of 1,248 rows (98.2%) sit inside 3%. So the floor
		 * keeps the clause on 22 rows, the only ones where the adjustment is more than
		 * twice the gap to the next man, and drops it everywhere it would be describing
		 * something smaller than the noise between adjacent ranks.
		 *
		 * Dropping the clause outright would also be defensible on those numbers, and the
		 * only reason it is not done is that this is the one place in the app the schedule
		 * adjustment is ever shown — `grep -n matchupMultiplier src/client/` returns this
		 * line and nothing else. Below the floor it is dropped rather than softened: the
		 * comment on the block above argues that an omitted clause beats one that has to
		 * be discounted, and this is that rule applied to magnitude instead of relevance.
		 */
		const schedule = r.projection.matchupMultiplier
		if (Math.abs(1 - schedule) >= 0.03)
			clauses.push(
				schedule > 1 ?
					`the schedule ahead of him is soft (×${schedule.toFixed(3)})`
				:	`the schedule ahead of him is hard (×${schedule.toFixed(3)})`
			)
	}
	// The same per-side choice the games column makes, in prose. "his team plays 14
	// games in that stretch" is true of a starting pitcher and useless about him:
	// on this fixture a starter's club plays a median 6.5 games for each turn he
	// actually takes, so the clause was quoting the largest number on his row and
	// the least relevant. Where MLB has published his turns, the card names those.
	if (r.scheduledStarts != null)
		clauses.push(
			`MLB has him down for ${r.scheduledStarts.toFixed(1)} starts in that stretch`
		)
	else if (r.projection.horizonGames)
		clauses.push(`his team plays ${r.projection.horizonGames} games in that stretch`)
	/**
	 * The reason not to act that only a roster can state, and it is outside the fold for
	 * the same reason every other worry is: a reason not to act that has to be opened is
	 * a reason nobody reads.
	 *
	 * Reachable whenever the best row the filters leave is behind the reader's own bench
	 * — he is ahead of the league's bar, which is what put him on the candidate list, and
	 * behind the man he would have to bench for him, which is what decides the move.
	 */
	const bench =
		r.deltaMine !== null && r.deltaMine <= 0 ?
			`He clears the league's bar and not yours: ${theWorstManYouHold()} already projects ${Math.abs(r.deltaMine)} points more over ${horizon}.`
		:	null
	/**
	 * The confidence clause is GATED on the contact file, and that gate is the one
	 * user-visible cost of taking the Statcast rows off the first paint.
	 *
	 * `confidenceOf` in src/engine/project.ts multiplies by a flat 0.6 when a player has
	 * no expected-stats row, and before this file is fetched NO player has one — so on
	 * first paint this clause would fire quoting a number that is 0.6× the truth, for a
	 * reason ("no Statcast expected stats") that is about the reader's connection rather
	 * than about the player. Measured on the committed capture: all 1,446 rated players
	 * have an xwOBA row, 518 of them clear this 0.7 threshold with the file, and NONE of
	 * them clear it without it. So ungated, the card would carry a confidence worry about
	 * every single one of those 518 men, and every one of those worries would be false.
	 *
	 * So the clause waits. An omitted clause is the house rule for a fact that is not
	 * yet known — the same rule the schedule multiplier and the rostered share already
	 * follow on this card — and nothing here says confidence is high, or says anything
	 * about it, until the file that decides it is in. The injury clause is unaffected and
	 * still wins outright, because it is the more urgent worry and needs no Statcast row
	 * to be true.
	 *
	 * What the reader sees on a board where he never opens a row is therefore a card with
	 * no confidence sentence on it; open one and the file arrives, the board re-rates, and
	 * the sentence appears where it is warranted. It never appears WRONG, which is the
	 * property being bought.
	 */
	const worry =
		/* "He's listed X" fitted "Injured 10-Day" and stopped fitting the moment this field
		   could also hold "optioned to the minors" — see src/data/injuries.ts. "MLB lists
		   him" takes both, which is the frame src/auto/plan.ts already uses for the same
		   field. */
		r.injury ? `MLB lists him ${r.injury.toLowerCase()}, so treat that number carefully.`
		: contactKnown && r.confidence.value < 0.7 ?
			`Confidence is only ${Math.round(r.confidence.value * 100)}% — ${r.confidence.reasons.join(", ")}.`
		:	null
	return (
		/*
		 * A strip, not a card.
		 *
		 * Billy's pick is a hook and it was a 449px one: a 92px robot, a heading, a
		 * serif name, an availability sentence and a four-clause paragraph of working,
		 * standing between a first-time reader and the ranked list that is the actual
		 * argument for this app. Measured on a 390px phone, nothing ranked appeared in
		 * the first screen at all.
		 *
		 * Everything that made it a hook survives — the robot, the name, the number,
		 * and whether the man is free — on one line. The working is a tap below it, and
		 * the list starts immediately under.
		 */
		<section className="card full pick pick-strip">
			<span className="pick-bot" aria-hidden>
				<Billy />
			</span>
			<div className="pick-body">
				<h2>Billy&rsquo;s pick</h2>
				<p className="pick-name">
					{r.player.name}
					<span className="pick-pos">
						{r.slot} · {r.player.team ?? "—"}
					</span>
				</p>
				{/*
				  It printed "Rostered in null% of leagues" whenever the estimate picked a
				  man Yahoo never listed — which is a live case rather than a hypothetical:
				  the ownership tier counts an unlisted player as gettable precisely because
				  the sweep never reached him, so the card's own recommendation is the row
				  most likely to have no percentage on it. An absence is stated as an
				  absence.
				*/}
				{/* A <div>, not a <p>: it holds a <details>, and details is flow content —
				    React logs "In HTML, <details> cannot be a descendant of <p>" and the
				    browser silently closes the paragraph early, which puts the fold outside
				    the element it is styled inside. */}
				<div className="pick-avail">
					{basis === "pool" ? "Free agent in your league."
					: basis === "ownership" ?
						r.rosteredPct === null ?
							"Probably free — Yahoo lists no rostered share for him, so this is an estimate."
						:	`Probably free — rostered in ${r.rosteredPct}% of leagues, below what a league this size takes.`
					:	"Best bscore on this board — availability unknown."}
					{/*
					  The working, one tap away. A WORRY is never folded: it is the reason not
					  to act, and a reason not to act that has to be opened is a reason nobody
					  reads.
					*/}
					<details className="pick-more">
						<summary>why him</summary>
						{clauses.join(" · ")}.
					</details>
					{bench && <em className="pick-worry"> {bench}</em>}
					{worry && <em className="pick-worry"> {worry}</em>}
				</div>
			</div>
			{/*
			  THE BADGE CARRIES THE NUMBER THAT CHOSE HIM, under the heading the column
			  that carries it uses.

			  It said "bscore", a word this app invented and nobody else uses, and was
			  changed to "ahead by" to match the column. That is now only half right: once
			  a roster exists the pick is made on "for you", so a badge reading "ahead by"
			  would print the league's bar beside a sentence explaining a choice made on the
			  reader's own — the same class of disagreement, one layer up. Whichever number
			  decided is the number shown, named in the words of the column it lives in.
			*/}
			{/*
			  AND THE BADGE FOLLOWS THE PICK BACK TO BSCORE.

			  The rule the note above states is the right one and is unchanged: whichever
			  number decided is the number shown, named in the words of the column it lives
			  in. What changed is which number decides. Ranking by "for you" was measured
			  over 111 paired weeks and loses to bscore by 21.5 points a week (p 0.0053) —
			  see the note on `best` — so the pick is bscore's again and so is the badge.

			  "For you" has not gone anywhere: it is the column beside every row and the
			  first line of this card's own working, because what a man gains over the
			  reader's own bench is the right answer to "what does he do for ME" and the
			  wrong answer to "who should I add".
			*/}
			<span className="pick-score">
				<b>{r.bscore}</b>
				<span>ahead by</span>
			</span>
		</section>
	)
}

/**
 * WHO THE BAR IS, in one place, because two screens of this app disagreed about it.
 *
 * The head of the sorted column already said it correctly — "the man left at his spot
 * once every team has filled it" — with a comment above it recording that the old
 * wording had been wrong and that src/engine/trade.ts had written down the correction
 * years before the sentence was changed. The HERO CARD was missed, and went on saying
 * "more points than the best {slot} you could add off waivers", which is a different and
 * much larger claim: the best man still free is not the (teams x seats)-th man at the
 * slot, and on a measured board he usually sits far above him.
 *
 * So the phrase is a function now and there is nowhere left for a second version of it
 * to live. `bscore.ts` computes `depth = teams x seats` and takes the man AT that depth;
 * this sentence says exactly that and nothing stronger.
 */
/**
 * WHOSE BAR THIS NUMBER SUBTRACTS, and it is not the same man in the two pools.
 *
 * This sentence was written when there was one depth: the (teams x seats)-th man, i.e. the
 * best player still left once every team in the league has filled that spot. That is still
 * exactly right when the app is simulating a wire it cannot see.
 *
 * It is false on a board that HAS the reader's own free-agent list. A wire is the whole pool
 * with the other rosters already removed, so the engine walks the reader's own seats down it
 * rather than the league's (src/engine/bscore.ts, and the measurement in
 * data/results/wire-depth/) — and the man it lands on is a few places down the free-agent
 * list rather than a man every team has passed over. Saying "once every team has filled it"
 * about him is the same class of mistake `theManLeftAt` was written to prevent: two screens
 * disagreeing about whose bar the number subtracts, in the sentence a reader checks the
 * number against.
 */
const theManLeftAt = (slot: string | null, onWire = false): string =>
	onWire ?
		`the best man still free at ${slot ?? "his spot"} once your own seats there are filled`
	:	`the man left at ${slot ?? "his spot"} once every team has filled it`

/**
 * WHO YOUR OWN BAR IS — the second sentence, written out here so that it can never be
 * the first one with a different number dropped into it.
 *
 * `theManLeftAt` above exists because two screens disagreed about whose bar bscore
 * subtracts. This is the same hazard one step further on: the board now opens ordered
 * by `deltaMine` when a roster exists, and the cheap way to ship that would have been
 * to leave the bscore sentence in place and put the new figure in front of it. That
 * sentence would have been false about the new number in the direction that matters —
 * the league's bar is the (teams x seats)-th man at the spot, usually a man rostered
 * everywhere, while this bar is the worst man in the reader's OWN dugout, and the two
 * are routinely tens of points apart.
 *
 * NO SLOT IS NAMED, deliberately. `useBoard` takes the minimum over every seat he is
 * eligible for — a manager benches his worst eligible man, not his worst man — so the
 * man displaced need not be at the slot printed on the row, and naming one would be a
 * claim the arithmetic does not make.
 */
const theWorstManYouHold = (): string => "the worst man you hold who could take one of his spots"

/**
 * What each sortable heading means, one entry per ordering the board can be in.
 *
 * TEN ENTRIES became four, and one of the six that went had already outlived its
 * control: `uscore` was still written down here for an ordering the Rank-by select had
 * stopped offering, so this table was documenting a state the app could not reach. The
 * other five — market edge, waiver points, confidence, luck and contact — went with
 * that select.
 *
 * Every number they described is still computed and still printed in the drill-down
 * one tap under the row, with the reasons beside it. What is gone is the ability to put
 * the whole table in an order whose number appears nowhere on it.
 */
const COLUMN_HELP: Record<NonNullable<Filters["sort"]>, string> = {
	name: "Sort by player name.",
	deltaMine:
		"For you \u2014 what adding him gains over the worst man you hold who could take one of his spots, over this window. bscore prices every row against the (teams \u00d7 seats)-th man in the league, which is the bar for the league; this is the bar for you. A deep outfield makes a good free-agent outfielder worth nothing to you, and a hole at catcher makes a mediocre one worth a great deal. Blank where nobody you own is eligible for a seat he could take, or where he is already yours.",
	bscore:
		"bscore — beanescore. Projected points over the horizon minus what a man you could still pick up at the same slot would score — the (teams × seats)-th of them, which is who is left once every team has filled that slot. 40 means forty more points than that man.",
	points: "Projected points — what he scores over the horizon in your league's own scoring."
}


/*
 * `SORTED_COL`, `OrderedCell` and `orderedCell` stood here — about sixty lines of
 * generic-column machinery, and the comment above them opened with the rule they
 * existed to keep: A BOARD MUST ALWAYS SHOW THE NUMBER IT IS SORTED BY.
 *
 * THE RULE IS NOT BEING DROPPED. It was a real defect, recorded in that comment and
 * worth restating: ranked by "most undervalued" the board reordered itself by a
 * percentile printed nowhere, under a caption that still read "Ahead by — points more
 * than the best man still free at his spot", describing a different number entirely. A
 * table ordered by an invisible figure and captioned with the name of another one is
 * asking to be taken on trust, which is the one thing this app is not for.
 *
 * What the machinery was FOR was an ordering with no column, and there are none left.
 * The "Rank by" select offered four, two of which had no column on the horizon that
 * offered them; it is deleted, and the only way to reorder this table now is to press
 * a column heading. Four headings exist — Player, points (Streaming), ahead by, for you
 * (once a roster is entered) — and `sortable` in useBoard.ts holds the shared sort
 * state to one this horizon actually draws, so an ordering with no column cannot be
 * reached even across a tab switch, which was the one remaining way in.
 *
 * So the proof is structural rather than per-metric, which is the point: before, the
 * rule held because a lookup table had an entry for every ordering, and the way it
 * broke was somebody adding a tenth ordering without a tenth entry. Now the set of
 * orderings IS the set of drawn columns, and there is no table to forget to update.
 *
 * Every quantity the nine entries could draw — uscore, market edge, luck, contact,
 * confidence, waiver points — is still computed by the engine and still printed in the
 * drill-down under the row it belongs to, where the reasons behind it are printed with
 * it. What is gone is ordering a thousand rows by one of them.
 */

const SortHead = ({
	col, field, sort, desc, setFilters, right, children
}: {
	/** Which board column this heading is, echoed onto the cell as `data-col`.
	 *  The grid places by that name rather than by child index — see
	 *  BOARD_GRID_CSS for why an index is not survivable here. */
	col: string
	field: NonNullable<Filters["sort"]>
	/**
	 * THE ORDERING THE ROWS ARE ACTUALLY IN, handed down rather than recomputed here.
	 *
	 * This used to take the whole `filters` object and work the answer out itself, as
	 * `filters.sort ?? SORT_DEFAULT[filters.mode]`, and that was already once the source
	 * of a real defect: `filters.sort` is null until a reader presses a heading, so on a
	 * first visit the rows descended 35.27 / 34.85 / 33.53 by "ahead by" with NO heading
	 * marked — no arrow for a sighted reader, and "Sort by ahead by" instead of "sorted
	 * descending" for a screen reader — and the first press on the ordering column pinned
	 * it rather than reversing it, because the handler compared against the same raw
	 * value.
	 *
	 * Recomputing it is no longer even possible to get right from here: the default now
	 * depends on whether the reader's roster can price a row, and `useBoard` is the only
	 * place that knows, and it CLAMPS the answer to an ordering this horizon can draw.
	 * Two copies of that rule would be two chances to mark the wrong column. One copy,
	 * passed in.
	 */
	sort: NonNullable<Filters["sort"]>
	desc: boolean
	setFilters: (f: (p: Filters) => Filters) => void
	right?: boolean
	/* A `unit` prop stood here — a denominator shown quietly beside the label, "/100" on a
	   percentile column, separate from `children` so the spoken name could say "out of 100"
	   in words while the heading stayed two glyphs wide. The only column that ever carried
	   one was the generic ordering track, headed "luck /100"; nothing passes it now. A prop
	   kept "in case" is how a deleted column comes back wearing somebody else's heading. */
	/** A plain string, because the sort state is announced by interpolating it. */
	children: string
}) => {
	const active = sort === field
	return (
		<button
			type="button"
			data-col={col}
			className={`sort-head${right ? " r" : ""}${active ? " active" : ""}`}
			// Pressing the column the rows are already in reverses it; pressing any other
			// takes it, descending — except Player, where ascending is alphabetical order
			// and that is what a reader pressing a name column means.
			onClick={() =>
				setFilters(f =>
					active ?
						{ ...f, sort: field, desc: !f.desc }
					:	{ ...f, sort: field, desc: field !== "name" }
				)
			}
			// The arrow glyph is the only thing that says which column the board is
			// sorted by, and a screen reader gets nothing from "▾". aria-sort would be
			// the right tool, but it is only valid on a columnheader inside a table
			// and the board is a list of buttons, not a grid — so the state goes in
			// the name instead. The title stays as the column's description.
			aria-label={
				active ?
					`${children}, sorted ${desc ? "descending" : "ascending"}, activate to reverse`
				:	`Sort by ${children}`
			}
			title={COLUMN_HELP[field]}
		>
			{children}
			<span className="arrow">{active ? (desc ? "▾" : "▴") : ""}</span>
		</button>
	)
}

/**
 * What the row says out loud. Read as markup it is a run of unlabelled numbers —
 * "1Pete Crow-ArmstrongOFChicago Cubs—52.74100%1427.8" — which is the column
 * headings doing all the work for sighted readers and none for anyone else. Every
 * clause here names a number that is already on the row; nothing is added, and a
 * value that is missing says it is missing.
 */
const rowLabel = (
	rank: number,
	r: BoardRow,
	starts: Starts | null,
	stream: boolean,
	mine: boolean
) =>
	[
		`${rank}. ${r.player.name}, ${r.slot}, ${r.player.team ?? "no team"}`,
		// The move marker is drawn as a rail and a rule, which a screen reader gets
		// nothing from, so the boundary is spoken on the rows it falls on.
		// The two facts a streaming pick turns on, spoken with the same separation
		// the row draws: what MLB announced, and what the model added to it.
		...(starts ?
			[
				starts.published > 0 ?
					`${starts.published} published ${starts.published === 1 ? "start" : "starts"}, against ${starts.names.join(" and ")}` +
						(starts.expected - starts.published >= 0.5 ?
							`, and about ${(starts.expected - starts.published).toFixed(1)} more once MLB names the rest`
						:	"")
				:	`no published starts, about ${starts.expected.toFixed(1)} expected from his own rate`
			]
		:	[]),
		/*
		 * The streaming row and the board row carry different columns, so they
		 * announce different things. A label naming uscore on a view that does not
		 * show uscore is the same defect as a heading over the wrong cell, spoken
		 * instead of drawn — and this file has shipped that defect twice.
		 *
		 * The second time was measured, not reasoned about: on the default fortnight
		 * view the drawn columns are "# / PLAYER / AHEAD BY / GAMES" and row one spoke
		 * "uscore 22.9, rostered in 35 percent of leagues, bscore 35.27, ... confidence
		 * 100%" — a metric with no cell, and a different word for the one number there
		 * actually was. Two clauses went with the columns they named, and the one that
		 * stayed now uses the heading's own words. The numbers they carried are all in
		 * the drill-down, which this row's button opens and which speaks them there.
		 */
		...(stream ?
			[
				r.rosteredPct === null ?
					"not on Yahoo's rostered list, so counted as gettable by estimate"
				:	`rostered in ${r.rosteredPct} percent of leagues`,
				`${r.points} projected points over this window`
			]
		:	[]),
		`ahead by ${r.bscore}`,
		...(stream ?
			[`against ${r.replacement} for the next arm on the wire`]
		:	[`${r.points} projected points against ${r.replacement} for a replacement`]),
		// The one cell a sighted reader gets and this label did not give, on the only
		// screen that draws it: what he gains over the man he would actually displace.
		...(mine && !stream ?
			[
				r.deltaMine === null ?
					"nobody of yours he could displace, so nothing for you"
				:	`for you, ${r.deltaMine > 0 ? `plus ${r.deltaMine}` : r.deltaMine}`
			]
		:	[]),
		// the same choice the games column makes, spoken: his own starts where they
		// exist, his team's games where they don't, and never one labelled the other
		r.scheduledStarts != null ?
			`${r.scheduledStarts.toFixed(1)} scheduled starts`
		: r.projection.horizonGames ?
			`${r.projection.horizonGames} team games scheduled`
		:	"no scheduled games on record",
		/* Same reason as the `worry` string above: this clause joins a comma list, so it
		   reads "14 team games scheduled, MLB lists him optioned to the minors". */
		...(r.injury ? [`MLB lists him ${r.injury.toLowerCase()}`] : []),
		/* Only where MLB said nothing, so the two flags never read as two conditions. */
		...(!r.injury && r.yahooStatus ? [`your league lists him ${r.yahooStatus}`] : [])
	].join(", ")

/**
 * How much of this window the player actually gets — the honest number per side.
 *
 * The column was "GP", the games his TEAM plays, and for a starting pitcher that
 * is not the quantity anyone is deciding on. `scheduledStarts` is the engine's own
 * count of his turns, built as `published(him) + unpublished(his club) x (his GS /
 * his club's GP)`, and it is what the projection is already multiplied by — so the
 * board was ranking on one number and displaying another.
 *
 * Measured on the committed fixture: 154 of 661 rateable pitchers have a start
 * count on the fortnight, and for them the team's games run a median 6.5x their
 * own starts (Skubal 14 team games, 2.8 starts). On the streaming week it is 6.0x,
 * and that is the view where it bites — 12 of the top 20 rows there are starters.
 *
 * A null is NOT a zero and is not dressed as one: MLB publishes probables about a
 * week out, so the rest-of-season view has none at all (0 of 361 starters), and a
 * reliever never gets one because a published count says nothing about when he
 * next appears. Those fall back to team games, and the unit on the cell says which
 * of the two you are reading.
 */
const Window = ({ r }: { r: Ranked }) => {
	const starts = r.scheduledStarts
	if (starts != null)
		return (
			<span
				className="r games"
				data-col="games"
				title={`MLB's published probables give him ${starts} starts in this window, against the ${r.projection.horizonGames} games his team plays. The projection is built on the starts, so that is what this column shows.`}
			>
				{starts.toFixed(1)}
				<span className="g-unit">GS</span>
			</span>
		)
	return (
		<span
			className="r games"
			data-col="games"
			title={
				r.player.group === "pitching" ?
					`${r.projection.horizonGames} games for his team in this window. MLB has not published turns that reach it, so there is no start count to show and his workload is projected off his own rate of appearing.`
				:	`${r.projection.horizonGames} games scheduled for his team in this window.`
			}
		>
			{r.projection.horizonGames || "—"}
			<span className="g-unit">GP</span>
		</span>
	)
}

const detailId = (r: Ranked) => `player-detail-${r.player.id}`

const Row = ({
	rank,
	r,
	stream,
	starts,
	mine,
	open,
	onToggle,
	contactStatus,
	askForContact,
	wireAge
}: {
	rank: number
	r: BoardRow
	/** Whether a roster has been entered, so the Δ MINE cell exists at all. The head
	 *  and the row must agree about the column count or the named grid placement
	 *  silently leaves one of them a track short. */
	mine: boolean
	/** On the Streaming tab, where the row answers a different question and
	 *  therefore carries different columns — see STREAM_GRID_CSS. */
	stream: boolean
	/** How old the reader's own wire read is, where a row's figure came off it. */
	wireAge: string | null
	/** His schedule in this window, on the streaming tab. Null everywhere else. */
	starts: Starts | null
	open: boolean
	onToggle: () => void
	/** Which state the expected-stats file is in, passed down rather than read again,
	 *  so the row and its drill-down cannot disagree about whether those rows exist. */
	contactStatus: ContactStatus
	/** Asked for by the drill-down when it opens — see `Detail`. */
	askForContact: () => void
}) => (
	<>
		<button
			className={`board-row${open ? " open" : ""}`}
			onClick={onToggle}
			type="button"
			aria-expanded={open}
			aria-controls={detailId(r)}
			aria-label={rowLabel(rank, r, starts, stream, mine)}
		>
			<span className="rank" data-col="rank">{rank}</span>
			<span className="who" data-col="who">
				<b>{r.player.name}</b>
				<span className="meta">
					<span className="code">{r.slot}</span>
					{r.player.team ?? "—"}
					{/*
					  How widely he is rostered, on the streaming tab only, and beside the
					  club rather than in a column.

					  The list above it is filtered to men he can add, so a per-row "free"
					  badge would be furniture — every row would carry it. What is NOT
					  uniform is the STRENGTH of that claim, and this is the number the
					  claim was made from: 13% is a read, "not listed" is the absence of
					  one. Blake Snell tops the gettable list on the live capture and is
					  unlisted, having pitched five games all year; a reader who can see
					  that can check him in ten seconds, and one who cannot has been asked
					  to trust an estimate on faith.
					*/}
					{stream && (
						<span
							className={`own${r.free === true ? " free" : ""}`}
							title={
								r.rosteredPct === null ?
									"Yahoo listed no rostered share for him. He is counted as gettable because the sweep reads about 200 deep per position and never reached him — an estimate, and the one place it is weakest."
								: r.fromWire && wireAge ?
									/* It says WHEN, and it does not say "in your league": "% Ros" is
									   Yahoo's share across every league it runs, and reading it off his
									   own page makes it current rather than local. */
									`Rostered in ${r.rosteredPct}% of Yahoo leagues, read ${wireAge}.`
								:	`Rostered in ${r.rosteredPct}% of Yahoo leagues.`
							}
						>
							{" · "}
							{r.rosteredPct === null ? "not listed" : `${r.rosteredPct}% owned`}
						</span>
					)}
					{/* MLB first where both spoke: it says "10-Day IL" where Yahoo says "IL", and
					    the longer answer is the more useful one. Yahoo's badge is the only source
					    for the day-to-day, the minors and the suspended, none of which MLB's feed
					    keeps. */}
					{r.injury ?
						<em className="hurt">{r.injury}</em>
					: r.yahooStatus ?
						<em className="hurt">{r.yahooStatus}</em>
					:	null}
				</span>
				{starts && <StartLine s={starts} />}
			</span>
			{/* uscore and its own denominator, in one column. Ownership had a column of
			    its own and went blank on precisely the rows uscore did, so the board
			    printed one absence twice — 500 of 1,233 rows, and 36 of the first 60.
			    Where Yahoo priced him the cell shows both numbers; where it didn't it
			    says so once, in a word rather than a dash. */}
			{/* On the streaming list the useful quantity is what he actually scores in
			    the window; on the board it is what he is ahead by, which is the next
			    cell. uscore — that same number discounted by how widely he is already
			    rostered — was the third column here and could not be read as one: on a
			    list already filtered to players you can add, the discount is applied
			    twice. It survives as an ordering ("value you can actually get") and in
			    the drill-down. */}
			{stream && (
				<span
					className="r pts"
					data-col="pts"
					title={`Projected for ${r.points} points over this window in your league's own scoring.`}
				>
					{r.points.toFixed(1)}
				</span>
			)}
			<span className="r bscore" data-col="bscore">{r.bscore}</span>
			{mine && (
				<span
					className={`r gap${(r.deltaMine ?? 0) > 0 ? " up" : ""}`}
					data-col="mine"
					title={
						r.deltaMine === null ?
							"Nobody you own is eligible for a seat he could take, or he is already yours — so there is no man for him to displace and no number to state."
						:	`Adding him and benching your worst eligible man is worth this much over the window, in your league's points. bscore beside it is the same subtraction against the league's generic replacement instead of against your roster.`
					}
				>
					{r.deltaMine === null ? "—" : r.deltaMine > 0 ? `+${r.deltaMine}` : r.deltaMine}
				</span>
			)}
			<Window r={r} />
		</button>
		{open && <Detail r={r} contactStatus={contactStatus} askForContact={askForContact} />}
	</>
)

/**
 * Every number's provenance: what was observed, what was modelled, what's missing.
 *
 * Ordered by what the reader came for, which it was not. The first column used to
 * be the per-stat points breakdown — eight lines of "K 75.58, OUT 54, W 14.94" —
 * so the advanced reader who opened a row to ask WHY he is ranked here met a
 * ledger before an answer, and on a phone, where the four columns stack, had to
 * scroll past all of it to reach anything explanatory.
 *
 * The order now is: what the ranking is (the arithmetic and how far to trust it),
 * how it was built and what could not be read, what was measured underneath, and
 * the per-category ledger last. Nothing is dropped — the ledger is the same eight
 * rows it always was, just no longer first.
 */
const Detail = ({
	r,
	contactStatus,
	askForContact
}: {
	r: Ranked
	contactStatus: ContactStatus
	askForContact: () => void
}) => {
	const top = Object.entries(r.projected.breakdown).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
	/**
	 * OPENING A ROW IS WHAT ASKS FOR THE EXPECTED-STATS FILE.
	 *
	 * This panel is the only surface in the app that renders those rows, and they are
	 * 299,805 bytes (48,528 gzipped) that used to ride inside the snapshot — which
	 * vite.config.ts requests in full before the first ranked row can paint, because the
	 * ranking cannot start without it. So every reader paid for them on the cold path to
	 * fill in a panel most readers never open. They are `data/contact.json` now and this
	 * effect is the request.
	 *
	 * Idempotent in `useContact`, not here: every open row mounts one of these, and a
	 * guard in this component would still fire twice for two rows opened in one tick.
	 *
	 * There is no cleanup and deliberately so. Closing the row does not cancel the
	 * fetch — the bytes are on their way, the board is better with them, and a reader who
	 * opened one row will open another.
	 */
	useEffect(askForContact, [askForContact])
	return (
		<div className="detail" id={detailId(r)} role="region" aria-label={`Where ${r.player.name}'s numbers come from`}>
			<div className="detail-col">
				<h3>What he is worth</h3>
				{/* The arithmetic behind the two ranked columns. It used to be spread across
				    four cells of every row — projected points, waiver points, bscore and
				    edge — which stated one subtraction three times in the place where
				    scanning matters most. */}
				<dl>
					<div className="pair"><dt>projected points</dt><dd>{r.points}</dd></div>
					<div className="pair"><dt>waiver points</dt><dd>{r.replacement}</dd></div>
					<div className="pair"><dt>bscore</dt><dd>{r.bscore}</dd></div>
					{/* Confidence is the first thing dropped from the row below 640px, so the
					    drill-down has to carry it or a phone reader loses it entirely. */}
					{/*
					  WITHHELD until the expected-stats file is in, rather than printed at 0.6×.
					  `confidenceOf` in src/engine/project.ts multiplies by a flat 0.6 when a
					  player has no expected-stats row, and until `data/contact.json` lands no
					  player has one. Measured on the committed capture: ALL 1,446 rated men have
					  an xwOBA row, so this number would be 0.6× the truth on every row in the
					  app, and wrong in a direction nobody could detect from the screen. A dash
					  that says why beats that. The panel at the foot of the third column carries
					  the state in a sentence.
					*/}
					<div className="pair">
						<dt>confidence</dt>
						{contactStatus === "ready" ?
							<dd title={r.confidence.reasons.join("; ")}>{pct(r.confidence.value)}</dd>
						: contactStatus === "failed" ?
							<dd title="Part of this number is how much of him Statcast has measured, and those numbers didn't load.">
								—
							</dd>
						:	<dd title="Part of this number is how much of him Statcast has measured, and those numbers are still loading.">
								—
							</dd>
						}
					</div>
					<div className="pair">
						<dt>rostered</dt>
						<dd>{r.rosteredPct === null ? "unlisted" : `${r.rosteredPct}%`}</dd>
					</div>
					<div className="pair"><dt>uscore</dt><dd>{r.uscore ?? "—"}</dd></div>
					<div className="pair">
						<dt>market edge</dt>
						<dd>{r.marketEdge === null ? "—" : r.marketEdge > 0 ? `+${r.marketEdge}` : r.marketEdge}</dd>
					</div>
				</dl>
				{/* Gated with the number they explain. One of these reasons is "no Statcast
				    expected stats", which before the file lands is a statement about the
				    download and not about the player. */}
				{contactStatus === "ready" && r.confidence.reasons.length > 0 && (
					<ul className="notes">
						{r.confidence.reasons.map(w => <li key={w}>{w}</li>)}
					</ul>
				)}
			</div>
			<div className="detail-col">
				<h3>Our model</h3>
				{r.projection.modelled.length ?
					<ul className="notes">{r.projection.modelled.map(m => <li key={m}>{m}</li>)}</ul>
				:	<p className="empty">Nothing modelled — no projection was possible.</p>}
				{/* Counted AFTER the same filter the list applies, or a player whose only
				    missing input is the not-yet-fetched Statcast row gets a "Missing"
				    heading over an empty list. */}
				{(r.projection.missing.filter(
					m => contactStatus === "ready" || m !== "underlying expected stats"
				).length > 0 ||
					r.projected.unscoreable.length > 0) && (
					<>
						{/* Promoted out of last place. What the model could not read is the
						    product's own promise — absent is reported as absent — and it was
						    sitting at the bottom of the rightmost column, below the Statcast
						    tables, where a reader who scrolled no further would never see it. */}
						<h3>Missing</h3>
						<ul className="notes warn">
							{/*
							  "underlying expected stats" is dropped from this list while the contact
							  file is not in, because MISSING_LABEL turns it into "Statcast has no
							  expected-stats row for him" — a claim about the player that would be
							  false for 1,408 of the 1,446 rated men in the capture. Not hidden: the
							  Statcast panel in the next column says, in the same breath, whether
							  those numbers are loading or failed to load. Once they are in, the
							  entry is back and means what it says.
							*/}
							{r.projection.missing
								.filter(m => contactStatus === "ready" || m !== "underlying expected stats")
								.map(m => <li key={m}>{MISSING_LABEL[m] ?? m}</li>)}
							{r.projected.unscoreable.length > 0 && (
								<li>league scores {r.projected.unscoreable.join(", ")} — not in any source we read</li>
							)}
						</ul>
					</>
				)}
			</div>
			<div className="detail-col">
				<h3>Measured</h3>
				<dl>
					<div className="pair"><dt>season points</dt><dd>{r.season.points}</dd></div>
					<div className="pair">
						<dt>{r.player.group === "hitting" ? "PA / team game" : "outs / team game"}</dt>
						<dd>{r.projection.volumePerTeamGame ?? "—"}</dd>
					</div>
					<div className="pair"><dt>team games in window</dt><dd>{r.projection.horizonGames}</dd></div>
					{/* The number the games column actually shows for a starter, named so the
					    drill-down and the row cannot disagree about which of the two it is. */}
					{r.scheduledStarts != null && (
						<div className="pair"><dt>his starts in window</dt><dd>{r.scheduledStarts}</dd></div>
					)}
					{r.underlying?.woba != null && (
						<div className="pair"><dt>wOBA</dt><dd>{r.underlying.woba}</dd></div>
					)}
					{r.underlying?.barrelRate != null && (
						<div className="pair"><dt>barrel %</dt><dd>{r.underlying.barrelRate}</dd></div>
					)}
					{r.underlying?.avgExitVelocity != null && (
						<div className="pair"><dt>exit velo</dt><dd>{r.underlying.avgExitVelocity}</dd></div>
					)}
				</dl>

				{/*
				  THE PANEL THAT OWNS THE SECOND FILE'S STATE.
				  
				  Everything below — and wOBA, barrel % and exit velo in the list above — comes
				  out of `data/contact.json`, which is fetched when this row is opened and not
				  before. Three states, all of them said out loud, because a panel that drew
				  nothing would read as "Statcast has never measured him", which is a claim
				  about the player rather than about a download.
				  
				  Failure is a state here, never an exception: the fetch's catch sets it, and
				  what the reader gets is a sentence, not zeros and not an empty table.
				*/}
				<h3>Statcast model</h3>
				<p className="tiny-note">
					Expected stats are MLB&rsquo;s model of what this contact usually produces —
					not something that happened.
				</p>
				{/* Two clauses went from the sentence below: "they steer no ranking" and "the
				    ordering you are looking at is the same either way" — the app reassuring a
				    reader about its own internals. What survives is the absence and the way out
				    of it, which is what he can act on. The claim behind the deleted clauses is
				    true and is made where it is checkable: `statcast.weight` is 0 in model.json,
				    and the note on `useContact` in useBoard.ts carries the proof. */}
				{contactStatus === "failed" && (
					<p className="empty warn">
						Couldn&rsquo;t load the contact numbers &mdash; nothing else on this row
						waits on them. Reloading the page tries again.
					</p>
				)}
				{(contactStatus === "loading" || contactStatus === "unasked") && (
					<p className="empty">Loading the contact numbers&hellip;</p>
				)}
				<dl>
					{r.underlying?.xwoba != null ?
						<>
							<div className="pair">
								<dt>xwOBA {r.underlying.window === "rolling" ? "(21d)" : "(season)"}</dt>
								<dd>{r.underlying.xwoba}</dd>
							</div>
							{r.regressionGap != null && (
								<div className="pair">
									<dt>expected − actual</dt>
									<dd className={r.regressionGap > 0 ? "" : "neg"}>
										{r.regressionGap > 0 ? `+${r.regressionGap}` : r.regressionGap}
									</dd>
								</div>
							)}
							{r.underlying.pa != null && (
								<div className="pair"><dt>PA in that window</dt><dd>{r.underlying.pa}</dd></div>
							)}
							{r.underlying.xba != null && (
								<div className="pair"><dt>xBA (season)</dt><dd>{r.underlying.xba}</dd></div>
							)}
							{r.underlying.xslg != null && (
								<div className="pair"><dt>xSLG (season)</dt><dd>{r.underlying.xslg}</dd></div>
							)}
							{r.underlying.hardHitRate != null && (
								<div className="pair"><dt>hard-hit % (season)</dt><dd>{r.underlying.hardHitRate}</dd></div>
							)}
							{r.underlying.sweetSpotRate != null && (
								<div className="pair"><dt>sweet-spot % (season)</dt><dd>{r.underlying.sweetSpotRate}</dd></div>
							)}
						</>
					: contactStatus === "ready" ?
						<p className="empty">No Statcast row for this player.</p>
						/* The state is printed above this <dl>, once, rather than repeated here:
						   "still loading" and "Statcast never measured him" are different facts
						   and only the second one is about the player. */
					:	null}
				</dl>
				{r.regressionGap != null && Math.abs(r.regressionGap) > 0.03 && (
					<p className="tiny-note">
						{r.player.group === "hitting" ?
							r.regressionGap > 0 ?
								`His contact over the last three weeks has been worth ${r.regressionGap} more wOBA than he got paid for.`
							:	`He has been getting ${Math.abs(r.regressionGap)} more wOBA than his contact earned.`
						: r.regressionGap > 0 ?
							`He has allowed ${r.regressionGap} more expected wOBA than his line shows — the results flatter him.`
						:	`He has been hit ${Math.abs(r.regressionGap)} wOBA softer on paper than in reality — the results have punished him.`}
					</p>
				)}
			</div>
			<div className="detail-col">
				<h3>Projected points by category</h3>
				{/* Last, not first. It is the ledger behind "projected points", which the
				    first column states in one line — useful to audit, not the answer to
				    the question that opened the row. */}
				<dl>
					{top.map(([code, value]) => (
						<div className="pair" key={code}>
							{/* Through the same label map the recap uses, or the same pitcher reads
							    "Outs" on one screen and "OUT" on the other. See `statLabel`. */}
							<dt>{statLabel(code)}</dt>
							<dd className={value < 0 ? "neg" : ""}>{value}</dd>
						</div>
					))}
				</dl>
			</div>
		</div>
	)
}
