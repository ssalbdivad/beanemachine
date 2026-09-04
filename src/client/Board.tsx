import { Fragment, useMemo, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { Billy } from "./Billy.tsx"
import { BoardPrimer, Fragment2 } from "./panels.tsx"
import {
	AVAILABLE_ONLY_DEFAULT, DEFAULT_FILTERS, normalizeName, useBoard,
	type BoardRow, type Filters, type Ranked
} from "./useBoard.ts"
import { api, ApiError, getMode, type AvailablePool } from "./api.ts"
import { useEffect } from "react"
import { datesBetween, type ResolvedPeriod } from "../engine/period.ts"
import { replacementBySlot } from "../engine/trade.ts"

const pct = (v: number) => `${Math.round(v * 100)}%`

/** Confidence as a filling lens — the same motif Billy wears. */
const Confidence = ({ value, reasons }: { value: number; reasons: string[] }) => (
	<span
		className="conf"
		data-col="conf"
		title={reasons.length ? `Confidence ${pct(value)} — ${reasons.join("; ")}` : `Confidence ${pct(value)}`}
	>
		<span className="conf-fill" style={{ width: pct(value) }} />
		<span className="conf-num">{pct(value)}</span>
	</span>
)

const MISSING_LABEL: Record<string, string> = {
	plateAppearances: "no plate appearances on record, so there is no playing-time rate to project from",
	outs: "no innings on record, so there is no workload rate to project from",
	teamGamesPlayed: "his team's games played is unknown, so the per-game rate can't be computed",
	"underlying expected stats": "Statcast has no expected-stats row for him"
}

/** Rows rendered per step as the reader scrolls. */
const PAGE = 60

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
	["board", "This fortnight", "the standing board, 14 days out"],
	["stash", "Stash", "rest of season — who to hold, not who to start"]
] as const

/**
 * The streaming horizons, as one control.
 *
 * "Rest of period" leads because in a head-to-head league the reset IS the
 * decision — a start on Monday scores for a matchup this week's is already settled
 * without. The day counts are the same control with a nearer far edge (see
 * `withinDays`), and they stop at seven because that is where the schedule data
 * stops paying: on the committed capture MLB has named the starter in 41 of 92
 * games three days out and still only 43 of 184 seven days out, so days five
 * through seven add games and no extra certainty about who pitches them.
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
.board .board-head,.board .board-row{
	grid-template-columns:30px minmax(0,1fr) 84px 66px 62px 86px 46px;
}
/* Placed by NAME. app.css places the same cells by nth-child, which cannot
   survive a column being added to one row and not the other — that is on the
   record: auto-placement once put the confidence gauge under "GP" and the games
   count under "confidence". Only grid-column is set here; a grid item is
   blockified by the container, so nothing needs a display value until a media
   query has to undo one of app.css's index-based hides. */
.board .board-head>[data-col],.board .board-row>[data-col]{grid-row:1;min-width:0}
.board .board-head>[data-col=rank],.board .board-row>[data-col=rank]{grid-column:1}
.board .board-head>[data-col=who],.board .board-row>[data-col=who]{grid-column:2}
.board .board-head>[data-col=uscore],.board .board-row>[data-col=uscore]{grid-column:3}
.board .board-head>[data-col=bscore],.board .board-row>[data-col=bscore]{grid-column:4}
.board .board-head>[data-col=games],.board .board-row>[data-col=games]{grid-column:5}
.board .board-head>[data-col=conf],.board .board-row>[data-col=conf]{grid-column:6}
.board .board-head>[data-col=luck],.board .board-row>[data-col=luck]{grid-column:7}
/* the score, then the ownership it was divided by, on one column's width */
.board .board-row .us-val{font-family:var(--mono);font-variant-numeric:tabular-nums}
.board .board-row .us-own,.board .board-row .us-none{
	display:block;font-size:var(--fs-1);color:var(--faint);font-style:normal;line-height:1.3;
}
/* the unit rides the number, because the column holds two of them */
.board .board-row .g-unit{font-size:var(--fs-1);color:var(--faint);margin-left:3px}

/* app.css spaces a drill-down heading after another heading and after a note list,
   but not after a definition list — so "Statcast model" now sits flush against the
   last row of "Measured", which reads as one table with a caption in the middle of
   it. Belongs in app.css beside its siblings; here because app.css is not this
   change's file. */
.detail dl + h3{margin-top:var(--sp-3)}

/* Under 900px luck goes: it is a percentile against everyone on the player's own
   side, the softest of the seven, and the Buy low card below the board is where
   that reading is actually acted on. The two un-hides undo app.css's nth-child
   hides, which now land on the wrong cells. */
@media(max-width:899px){
	.board .board-head,.board .board-row{
		grid-template-columns:26px minmax(0,1fr) 76px 62px 58px 86px;gap:var(--sp-2);
	}
	.board .board-head>[data-col=games],.board .board-row>[data-col=games]{display:block}
	.board .board-head>.sort-head[data-col=conf]{display:flex}
	.board .board-row>[data-col=conf]{display:block}
	.board .board-head>.sort-head[data-col=luck],.board .board-row>[data-col=luck]{display:none}
}
/* Under 640px only two numbers fit beside the name — measured at 390px the board
   is 300px wide. They used to be uscore and bscore, and uscore is the column that
   is blank on 36 of the first 60 rows: on a phone the reader got a column of
   dashes as one of his two numbers. The window count takes the slot instead. It
   is never blank (0 of 1,233 rows), it is the only number on the row that is a
   fact about the WINDOW rather than about the player, and for a starter it is now
   his own starts. Confidence and luck are one tap away in the drill-down, which
   prints both. uscore comes back only when the board is RANKED by it, because a
   board must always show the number it is sorted by. */
@media(max-width:640px){
	.board .board-head,.board .board-row{
		grid-template-columns:24px minmax(0,1fr) 56px 62px;gap:var(--sp-2);
	}
	.board .board-head>.sort-head[data-col=conf],.board .board-row>[data-col=conf]{display:none}
	.board:not([data-sort=uscore]) .board-head>.sort-head[data-col=uscore],
	.board:not([data-sort=uscore]) .board-row>[data-col=uscore]{display:none}
	.board:not([data-sort=uscore]) .board-head>[data-col=games],
	.board:not([data-sort=uscore]) .board-row>[data-col=games]{grid-column:3}
	.board[data-sort=uscore] .board-head>[data-col=games],
	.board[data-sort=uscore] .board-row>[data-col=games]{display:none}
}`

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
 * `luck` is a percentile of expected-minus-actual wOBA over 21 days. It is a
 * buy-low signal about a season, and the Buy low card below the board is where it
 * is acted on. Nothing about a Saturday start turns on it.
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
.board[data-mode=stream] .board-head,.board[data-mode=stream] .board-row{
	grid-template-columns:30px minmax(0,1fr) 58px 66px 62px 86px;
}
.board[data-mode=stream] .board-head>[data-col=pts],
.board[data-mode=stream] .board-row>[data-col=pts]{grid-column:3;display:block}
.board[data-mode=stream] .board-head>[data-col=bscore],
.board[data-mode=stream] .board-row>[data-col=bscore]{grid-column:4;display:block}
.board[data-mode=stream] .board-head>[data-col=games],
.board[data-mode=stream] .board-row>[data-col=games]{grid-column:5;display:block}
.board[data-mode=stream] .board-head>[data-col=conf]{grid-column:6;display:flex}
.board[data-mode=stream] .board-row>[data-col=conf]{grid-column:6;display:block}
/* Under 900px the projected total goes and the comparison stays: bscore is the one
   that answers "is this add worth making at all". */
@media(max-width:899px){
	.board[data-mode=stream] .board-head,.board[data-mode=stream] .board-row{
		grid-template-columns:26px minmax(0,1fr) 62px 58px 86px;gap:var(--sp-2);
	}
	.board[data-mode=stream] .board-head>[data-col=pts],
	.board[data-mode=stream] .board-row>[data-col=pts]{display:none}
	.board[data-mode=stream] .board-head>[data-col=bscore],
	.board[data-mode=stream] .board-row>[data-col=bscore]{grid-column:3}
	.board[data-mode=stream] .board-head>[data-col=games],
	.board[data-mode=stream] .board-row>[data-col=games]{grid-column:4}
	.board[data-mode=stream] .board-head>[data-col=conf]{grid-column:5;display:flex}
	.board[data-mode=stream] .board-row>[data-col=conf]{grid-column:5;display:block}
}
/* Under 640px, two numbers beside the name: what he is worth over the window, and
   how many turns he gets in it. Confidence survives in the drill-down, which
   prints it, and the start line under his name keeps the opponents. */
@media(max-width:640px){
	.board[data-mode=stream] .board-head,.board[data-mode=stream] .board-row{
		grid-template-columns:24px minmax(0,1fr) 58px 58px;gap:var(--sp-2);
	}
	.board[data-mode=stream] .board-head>[data-col=conf],
	.board[data-mode=stream] .board-row>[data-col=conf]{display:none}
	.board[data-mode=stream] .board-head>[data-col=bscore],
	.board[data-mode=stream] .board-row>[data-col=bscore]{grid-column:3}
	.board[data-mode=stream] .board-head>[data-col=games],
	.board[data-mode=stream] .board-row>[data-col=games]{grid-column:4}
}
/* His rostered share, on the meta line beside slot and club rather than in a
   column of its own. It is the estimate's own input and it varies row to row, so a
   reader can audit the claim — but it is a property of the player, not a ranked
   quantity, and giving it a column would cost the width the pts column now uses. */
.board .board-row .who .own{color:var(--faint)}
.board .board-row .who .own.free{color:var(--accent)}
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
.stream-strip .moves{flex-direction:row;align-items:center;gap:var(--sp-2)}
/* app.css sets white-space:nowrap on every .toggle, which is right in the filter
   row where the labels are two words. In this strip the availability toggle also
   carries the tier it is using ("est. over 35% is taken"), and at 390px that one
   label ran to 411px — 21px of horizontal scroll on the whole page, on the view
   this change exists to fix. It wraps here instead; the box stays pinned to the
   first line so a two-line label does not centre its checkbox against nothing. */
.stream-strip .toggle{white-space:normal;align-items:flex-start;max-width:100%}
.stream-strip .toggle input{flex:none;margin-top:3px}
.stream-strip .moves input{width:56px}
.stream-note{margin-top:var(--sp-2)}
/* The availability sentence is NOT a stream-note. That class names the coverage
   line, and test/board.mjs reads the first element matching it — a second paragraph
   sharing the class silently retargeted five assertions at the wrong sentence.
   Same margin, its own name. */
.avail-note{margin-top:var(--sp-2)}
.moves-answer b{color:var(--ink)}
/* the reader's own budget, drawn as a boundary rather than a highlight */
.board .board-row[data-pick]{border-left-color:var(--accent);background:var(--accent-soft)}
.board .board-row[data-pick] .rank{color:var(--accent);font-weight:700}
.board .board-row[data-pick=last]{border-bottom:2px solid var(--accent)}
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
 */
const horizonSpan = (
	snapshot: Snapshot,
	mode: Filters["mode"],
	period: ResolvedPeriod | null
) => {
	const { start, end } = snapshot.horizon
	if (mode === "stream" && period) {
		const days = datesBetween(period.start, period.end)
		return {
			range: `${period.start} → ${period.end}`,
			phrase:
				// A window the reader chose by length is named by that length, not by the
				// period it was cut out of: "the rest of this scoring period" under a
				// board ranked over three days is the exact class of sentence — true of
				// something else on screen — this file keeps having to delete.
				period.kind === "days" ? `these ${days} days`
				: period.kind === "daily" ? "today"
				: period.kind === "rolling" ? "a rolling 7 days"
				: "the rest of this scoring period"
		}
	}
	if (mode === "stash")
		return {
			range: `${start} → the end of the regular season`,
			phrase: "the rest of the regular season"
		}
	const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000)
	return { range: `${start} → ${end}`, phrase: `the next ${days} days` }
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
	error
}: {
	snapshot: Snapshot | null
	league: League | null
	error: string | null
}) => {
	const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
	const [open, setOpen] = useState<number | null>(null)
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
		if (!leagueId || league?.meta.platform !== "yahoo") return
		let live = true
		api.available(leagueId)
			.then(p => live && setPool(p))
			.catch((e: unknown) => live && setPoolError(e instanceof ApiError ? e.message : String(e)))
		return () => {
			live = false
		}
	}, [leagueId, league?.meta.platform])

	// A fresh Set on every render would invalidate the filter-and-sort memo in
	// useBoard on every render, including ones that changed nothing about it.
	const availableNames = useMemo(
		() => (pool && pool.players.length ? new Set(pool.players.map(p => normalizeName(p.name))) : null),
		[pool]
	)
	const { rated, rows, scored, edgeCoverage, period, streaming, teamNames, availability, sort } =
		useBoard(snapshot, league, filters, availableNames)
	/** What "only players I can add" is doing right now — the reader may not have
	 *  said, in which case the tab has answered for him. */
	const availableOnly = filters.availableOnly ?? AVAILABLE_ONLY_DEFAULT[filters.mode]
	/**
	 * The move budget, scoped to the tab whose strip carries the input.
	 *
	 * Left global it marked the top rows of the fortnight and stash boards too,
	 * with no control on screen to clear it — the same shape as the mode-scoped
	 * filter that once went on filtering a view whose checkbox had stopped
	 * rendering. "Two moves buys you these two" is a claim about a scoring period;
	 * it means nothing over the rest of a season.
	 */
	const moves = filters.mode === "stream" ? filters.moves : 0
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
		availability.basis === "pool" || !poolError ?
			availability.basisText
		:	`${availability.basisText}. Your league's own free-agent list could not be read: ${poolError}`
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
				<p className="empty">Couldn't load the snapshot: {error}</p>
			</section>
		)
	if (!league)
		return (
			<section className="card full">
				<h2>Recommendations</h2>
				<p className="empty">Import or configure a league first — the board ranks players in your league's scoring.</p>
			</section>
		)
	if (league.meta.max_teams == null)
		return (
			<section className="card full">
				<h2>Recommendations</h2>
				<p className="empty">
					A player is worth what he beats the next man up by, and how deep the waiver
					wire runs decides who that is. Set the team count in <b>League setup</b> and
					the board fills in.
				</p>
			</section>
		)
	if (!snapshot)
		return (
			<section className="card full">
				<h2>Recommendations</h2>
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
	const span = horizonSpan(snapshot, filters.mode, period)

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
		picked === undefined ? "none" : availability.basis === "pool" ? "pool" : "ownership"

	const narrowed = [
		filters.group === "hitting" ? "batters only"
		: filters.group === "pitching" ? "pitchers only"
		: "",
		filters.minConfidence > 0 ? `confidence ${pct(filters.minConfidence)}+` : "",
		filters.hideInjured ? "injured hidden" : ""
	].filter(Boolean)

	return (
		<>
			{/* Moved here from App so it can see the mode: it describes bscore, and the
			    streaming list is ordered by projected points, so above that list it was
			    pointing at the wrong column. `.full` because `.grid` is two columns. */}
			<div className="full">
				<BoardPrimer mode={filters.mode} />
			</div>
			<section className="card full board-controls">
				<h2>What are you deciding?</h2>
				<style href="board-mode-focus" precedence="default">{MODE_FOCUS_CSS}</style>
				<style href="board-grid" precedence="default">{BOARD_GRID_CSS}</style>
				<style href="board-stream" precedence="default">{STREAM_CSS}</style>
				<style href="board-stream-grid" precedence="default">{STREAM_GRID_CSS}</style>
				{/* The tabs are the tablist's only children, because a tablist that
				    contains anything else stops being one to a screen reader. */}
				<div className="modes" role="tablist" aria-label="What to rank for">
					{MODES.map(([id, label, why]) => (
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
							onClick={() => setFilters(f => ({ ...f, mode: id }))}
						>
							<b>{label}</b>
							<span>{why}</span>
						</button>
					))}
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
									{availability.basis === "pool" ? `${availability.size} free`
									: availability.basis === "ownership" ? `est. over ${availability.cut!.cut}% is taken`
									:	"can't tell"}
								</em>
							</span>
						</label>
						<label
							className="toggle"
							title="Keeps only players the schedule has pitching inside this window — published turns plus the games his club has not named a starter for yet, at his own rate of starting. It is the same count the ranking is built on."
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
						{/* The reader's own budget. Nothing in any source this app reads carries
						    his transaction count, waiver position, FAAB or weekly add limit, so
						    the number is typed rather than guessed — see `Filters.moves`. What
						    the board contributes is the part he cannot do: which N of the
						    ranking those moves should buy, after his filters. */}
						<label className="ctl moves">
							<span>Moves left</span>
							<input
								type="number"
								min={0}
								max={26}
								step={1}
								value={filters.moves}
								onChange={e =>
									set("moves", Math.max(0, Math.min(26, Math.floor(Number(e.currentTarget.value) || 0))))
								}
							/>
						</label>
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
					{SLOTS.map(s => (
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
					{filters.mode !== "stream" && (
					<label className="ctl">
						<span>Search</span>
						<input
							type="text"
							value={filters.search}
							placeholder="Player name…"
							onChange={e => set("search", e.currentTarget.value)}
						/>
					</label>
					)}
					{/* One question, one ranking. The streaming list is ordered by what a man
					    projects over the window you picked, which is the only ordering that
					    answers "who should I add"; the other five are board questions and are
					    a click away under "more filters". */}
					{filters.mode !== "stream" && (
					<label className="ctl">
						<span>Rank by</span>
						<select
							data-ctl="sort"
							value={sort}
							onChange={e => set("sort", e.currentTarget.value as Filters["sort"])}
						>
							<option value="bscore">bscore (value over replacement)</option>
							<option value="uscore">uscore (value you can actually get)</option>
							<option value="points">projected points</option>
							<option value="marketEdge">market edge (what the field is wrong about)</option>
							<option value="undervaluation">most undervalued (above replacement)</option>
							<option value="contact">best contact vs results (last 21 days)</option>
						</select>
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
								{availability.basis === "pool" ? `${availability.size} free`
								: availability.basis === "ownership" ? "estimated"
								:	"can't tell"}
							</em>
						</span>
					</label>
					)}
				</div>
				{/* The four controls above are the ones reached for constantly. These three
				    are not, and permanently on screen they were part of what pushed the
				    first ranked row to y=1187 — below the fold on a 1200px screen.
				    The summary names any of them that is ON, because the page has already
				    learned once that a filter you cannot see must not be one you cannot
				    escape: a mode-scoped filter went on filtering a view whose checkbox had
				    stopped rendering, and the board emptied with nothing on screen to undo. */}
				<details className="more" open={narrowed.length > 0}>
					<summary>
						More filters
						{narrowed.length > 0 && <em> · {narrowed.join(", ")}</em>}
					</summary>
					<div className="filters">
						<label className="ctl">
							<span>Side</span>
							<select
								data-ctl="group"
								value={filters.group}
								onChange={e => set("group", e.currentTarget.value as Filters["group"])}
							>
								<option value="all">batters + pitchers</option>
								<option value="hitting">batters</option>
								<option value="pitching">pitchers</option>
							</select>
						</label>
						<label className="ctl">
							<span>Min confidence</span>
							<select
								data-ctl="confidence"
								value={String(filters.minConfidence)}
								onChange={e => set("minConfidence", Number(e.currentTarget.value))}
							>
								<option value="0">any</option>
								<option value="0.4">40%+</option>
								<option value="0.7">70%+</option>
							</select>
						</label>
						<label className="toggle">
							<input
								type="checkbox"
								checked={filters.hideInjured}
								onChange={e => set("hideInjured", e.currentTarget.checked)}
							/>
							<span>Hide injured</span>
						</label>
					</div>
				</details>
			</section>

			{pick ?
				<BillysPick
					r={pick}
					horizon={span.phrase}
					basis={basis}
					streaming={filters.mode === "stream"}
				/>
			:	<NoPick />}

			{/* The panel the horizon tabs control. The pick, buy-low and scarcity
			    cards below re-rank with it too, but this is the ranking itself, and
			    the sibling cards can't be wrapped without breaking the page grid. */}
			<section className="card full" id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(filters.mode)}>
				<h2>Recommendations</h2>
				{filters.sort === "marketEdge" && edgeCoverage < 0.35 && (
					<p className="sub warn-note">
						Yahoo listed ownership for only {Math.round(edgeCoverage * 100)}% of this
						board, so edge can rank just that slice. bscore ranks everyone.
					</p>
				)}
				{/* One line, because it is read on every visit: how many, over what window.
				    Everything about HOW the ranking was built — which horizon this is, what
				    playing time leans on, what each column means — is a click below, where
				    it is available on the rare occasion anyone wants it and costs no height
				    on the many occasions nobody does. */}
				<p className="sub">
					<b className="count">{rows.length}</b> players · {span.range}
				</p>
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
				  Which of the three availability answers this page is giving, said once
				  where the reader can see it rather than implied by a list. The whole
				  complaint was a streaming list headed by four men who were already
				  rostered; the fix is only trustworthy if the page is explicit about
				  whether "he is free" was READ or ESTIMATED.
				*/}
				{filters.mode === "stream" && availableOnly && (
					<p className="sub avail-note">
						<b>
							{availability.basis === "pool" ? "Free agents in your league."
							: availability.basis === "ownership" ? "Probably-free players."
							:	"Every starter in the window."}
						</b>{" "}
						{/*
						  The OPERATIVE fact, with the derivation behind it rather than in front.
						  The full sentence — "a 10-team league with 27 seats holds 270 players,
						  and the 270th most widely rostered player in this capture is rostered
						  in 35% of leagues, so above 35% is treated as taken" — is how the
						  number was arrived at, and it measured 109px on a 390px screen sitting
						  directly under a card that had already said "probably free, rostered in
						  13% of leagues". The same estimate, twice, in front of the answer.
						  It is the audit trail for a number the reader is asked to trust, so it
						  is not deleted: it is the title of the line that summarises it.
						*/}
						<span title={availability.basisText}>
							{availability.basis === "ownership" && availability.cut ?
								<>Estimated: above {availability.cut.cut}% rostered is treated as taken.</>
							:	<>
									{availability.basisText.charAt(0).toUpperCase()}
									{availability.basisText.slice(1)}.
								</>
							}
						</span>
						{availability.basis !== "pool" &&
							" Untick “Only players I can add” to see the whole field."}
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
						{period && `${period.basis.charAt(0).toUpperCase()}${period.basis.slice(1)}. `}
						MLB has named the starter in{" "}
						<b>
							{streaming.published} of {streaming.games}
						</b>{" "}
						games in it, {streaming.fullyNamed} of {streaming.clubs} clubs completely.
						{streaming.fullyNamed < streaming.clubs &&
							" The rest are estimated from each pitcher's own rate of starting, and every row says which of the two it is showing."}
						{/* Only when NOT ONE club is fully named — the point at which a longer
						    window has stopped buying certainty and is only buying games. Said
						    here rather than as a permanent caption, because on a three-day
						    window it is not true and a warning that is always on is furniture. */}
						{streaming.fullyNamed === 0 &&
							" A shorter window is where this data is strongest: MLB names starters about three days ahead and then stops."}
					</p>
				)}
				{/*
				  "I have 2 picks remaining" as an ANSWER rather than as a decoration.

				  This said "the first 2 rows are marked, down to the rule" — a sentence
				  about a rail, describing the drawing rather than the decision. The rail
				  is still there and is still the right shape for "where does my list
				  stop", but a reader who came to find out which two men to add should
				  not have to read a rule off a table to learn their names. So the page
				  says them.

				  Only where the moves control itself is, for the same reason the start
				  filter is: a marker that outlives the tab that set it is a claim about
				  a window nobody is looking at.
				*/}
				{moves > 0 && rows.length > 0 && (
					<p className="sub stream-note moves-answer">
						<b>
							{moves === 1 ? "Your move" : `Your ${moves} moves`}
							{moves < rows.length ? "" : " — the whole list"}:
						</b>{" "}
						{rows.slice(0, moves).map((r, i) => {
							const s = startsFor(r)
							return (
								<Fragment key={r.player.id}>
									{i > 0 && "; "}
									<b>{r.player.name}</b>
									{s && s.published > 0 ?
										` — ${s.published} ${s.published === 1 ? "start" : "starts"} vs ${s.names.join(" and ")}`
									: s ?
										` — about ${s.expected.toFixed(1)} starts, none announced yet`
									:	""}
									{`, ${r.points.toFixed(1)} pts`}
								</Fragment>
							)
						})}
						.{" "}
						{/* The claim is only as strong as its source, and it is never
						    stronger than "probably" without the league's own wire.

						    It is also never stronger than the LIST it describes. This read
						    `availability.basis` alone, which says what the page COULD find
						    out about the wire — not whether the rows above were actually
						    filtered by it. With the pool loaded and "Only players I can add"
						    unticked, the sentence named Parker Messick and Chris Sale, both
						    printed "not listed" two lines below, and told the reader they
						    were "Free in your league, read off its own list". Both are
						    rostered; the wire had been read and had excluded them. That is
						    an estimate dressed as a read, and worse — a read quoted about
						    men the read ruled out. So the provenance clause is now gated on
						    the filter that earns it, and when the filter is off the sentence
						    says what the list actually is. */}
						<em>
							{!availableOnly ?
								"Best of the whole field — “Only players I can add” is off, so these are not filtered by whether you can get them."
							: availability.basis === "pool" ?
								"Free in your league, read off its own list."
							: availability.basis === "ownership" ?
								// the arithmetic is stated in full one line above; repeating it
								// here made the answer twice as long as the answer
								`Estimated as gettable: rostered in ${availability.cut!.cut}% of leagues or fewer.`
							:	"Availability unknown, so this is the best of the whole pool rather than of the wire."}
						</em>
					</p>
				)}
				{/* `data-sort` is read by the 640px rule in BOARD_GRID_CSS, which puts the
				    uscore column back on a phone when the board is ranked by it. */}
				<div className="board" data-sort={filters.sort} data-mode={filters.mode}>
					{/* Seven columns, each answering a different question. `proj pts` and
					    `waiver pts` used to sit here too, but bscore is one minus the other,
					    so the table stated the same fact three times; the arithmetic is in
					    the drill-down where it belongs. `owned` was an eighth until it was
					    folded into uscore, whose denominator it is — BOARD_GRID_CSS carries
					    the count of rows on which the two went blank together. */}
					<div className="board-head">
						<span data-col="rank">#</span>
						<SortHead col="who" field="name" filters={filters} setFilters={setFilters}>Player</SortHead>
						{/* uscore discounts value by availability, which on a list already
						    filtered to what he can add is that discount applied twice — see
						    STREAM_GRID_CSS. What replaces it is the half of his question the
						    board never answered: what this man actually scores over the
						    window. */}
						{filters.mode === "stream" ?
							<SortHead col="pts" field="points" filters={filters} setFilters={setFilters} right>pts</SortHead>
						:	<SortHead col="uscore" field="uscore" filters={filters} setFilters={setFilters} right>uscore</SortHead>}
						<SortHead col="bscore" field="bscore" filters={filters} setFilters={setFilters} right>bscore</SortHead>
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
							title="What this player gets out of the window. For a starting pitcher whose turns MLB has published it is his own scheduled starts (GS); for everyone else it is the games his team plays (GP). Six-game weeks are worth chasing; four-game weeks are why a good hitter can be the wrong start."
						>
							{filters.mode === "stream" ? "starts" : "games"}
						</span>
						<SortHead col="conf" field="confidence" filters={filters} setFilters={setFilters}>confidence</SortHead>
						{/* The number is a percentile, and nothing said so: 88 read as a quantity of
						    luck rather than as "unluckier than 88% of his side". The denominator
						    belongs in the heading, read once, rather than on 1,235 rows. */}
						{/* Luck is a 21-day expected-minus-actual percentile — a buy-low
						    reading about a season, acted on in the Buy low card. Nothing
						    about which arm to start on Saturday turns on it, so it is not on
						    the streaming grid. */}
						{filters.mode !== "stream" && (
							<SortHead col="luck" field="undervaluation" filters={filters} setFilters={setFilters} right unit="/100">
								luck
							</SortHead>
						)}
					</div>
					{rows.slice(0, limit).map((r, i) => (
						<Row
							key={r.player.id}
							rank={i + 1}
							r={r}
							stream={filters.mode === "stream"}
							starts={startsFor(r)}
							/* the reader's budget, counted down the ranking he is actually
							   looking at — his filters have already decided who is on it */
							moves={moves}
							open={open === r.player.id}
							onToggle={() => setOpen(open === r.player.id ? null : r.player.id)}
						/>
					))}
					{!rows.length && <p className="empty">No players match these filters. Try clearing the slot filter or lowering the confidence minimum.</p>}
				</div>
				<details className="legend">
					<summary>How this ranking was built</summary>
					<p className="sub">
						{filters.mode === "stash" ?
							"Every game left in the regular season, so playing time and role matter more than a hot fortnight. This is the view for who to hold rather than who to start."
						: filters.mode === "stream" ?
							`${period ? period.basis.charAt(0).toUpperCase() + period.basis.slice(1) : "A window this capture cannot state"}, counted off the real schedule.`
						:	"The next fortnight — long enough that one cold week doesn't decide it, short enough that today's role still holds."}
						{" "}Playing time leans on recent form: the last{" "}
						{(snapshot.recentWindow?.hitting ?? [3, 7, 21]).join("/")} days for batters
						and {(snapshot.recentWindow?.pitching ?? [5, 21]).join("/")} for pitchers,
						weighting the most recent window double. Every number is denominated in{" "}
						{league.meta.league_name ?? "this league"}&rsquo;s own scoring.
					</p>
					<dl>
						{(
							[
								["bscore", COLUMN_HELP.bscore],
								["proj pts", COLUMN_HELP.points],
								["waiver pts", COLUMN_HELP.replacement],
								["uscore", COLUMN_HELP.uscore],
								// The games column reads in two units and nothing else on the page
								// explains why. It has no entry in COLUMN_HELP because that map is
								// keyed by sort field and this column cannot be sorted on.
								[
									"games",
									"GS is a starting pitcher's own scheduled starts, from MLB's published probables — the number his projection is actually built on. GP is the games his team plays, which is the right question for a hitter and the wrong one for a starter by roughly a factor of six. A pitcher shows GP when no probables reach this window."
								],
								["confidence", COLUMN_HELP.confidence],
								["edge", COLUMN_HELP.marketEdge],
								["luck", COLUMN_HELP.undervaluation]
							] as const
						).map(([term, text]) => (
							<Fragment2 key={term} term={term}>
								{text}
							</Fragment2>
						))}
					</dl>
				</details>
				{/* The end of the rendered window. Scrolling to it grows the list; when
				    everything is on screen it is an empty div and says nothing. */}
				<div ref={sentinel} aria-hidden />
				{limit < rows.length && (
					<p className="sub" style={{ marginTop: 12 }}>
						{limit} of {rows.length} — keep scrolling.
					</p>
				)}
			</section>

			{/*
			  Supporting analysis sits AFTER the ranking it supports. Both answer
			  "where should I spend attention", which is a second question — putting
			  them above the board pushed the actual recommendations below the fold.

			  And neither is on the Streaming tab at all. Buy low ranks a 21-day
			  expected-minus-actual gap against ownership: a signal about a season,
			  and on this fixture its picks are hitters, who cannot be streamed for a
			  start. "Where it hurts to wait" is a draft and roster-construction
			  reading — the shape of the drop-off at each slot, which does not change
			  between now and Sunday. Two full-width cards that cannot help a reader
			  choose an arm for the weekend are two cards of scrolling between him and
			  the one that can.
			*/}
			{filters.mode !== "stream" && (
				<>
					<BuyLow rows={rows} />
					<Scarcity pool={rated} league={league} />
				</>
			)}
		</>
	)
}

/**
 * Positional scarcity — the shape of the drop-off, per slot.
 *
 * Replacement level is already the denominator of every bscore, but it is invisible
 * as a single number on one row. Seen side by side it answers the question people
 * actually ask while building a team: where does it hurt to wait? A slot where the
 * starter and the waiver-wire body are close is one you can punt; a slot where the
 * cliff is steep is one you pay for early.
 */
const Scarcity = ({ pool, league }: { pool: Ranked[]; league: League }) => {
	// The whole rated pool, not the board's filtered rows. A waiver bar is the
	// (teams × slots)-th best man eligible there, so handing this the 67 rows the
	// default market-edge sort leaves would clamp that depth to the size of the
	// filtered set and report its worst row as the bar. Scarcity is a fact about
	// the league's pool; it does not move when you type in the search box.
	const teams = league.meta.max_teams
	if (teams == null) return null
	// slot_order lists every roster SPOT, so a 3-outfielder league names OF three
	// times. Scarcity is a property of the slot, not of each seat in it.
	const accepts = league.roster.slot_accepts
	const active = [
		...new Set(
			(league.roster.slot_order ?? Object.keys(league.roster.slots)).filter(
				s => s !== "BN" && s !== "IL" && s !== "NA"
			)
		)
	]
		// Catch-all spots are filled by whoever is spare, so their card was always a
		// duplicate of a real slot's: on the fortnight Util printed C's number under C's
		// name (+36 Drake Baldwin) and P printed RP's (+21 Ian Seymour). Util is also
		// the least scarce spot in the league by construction — its bar is 111.06
		// against OF's 91.69, because every hitter is eligible there — so it is the one
		// slot nothing is ever waiting on. Leagues that never stated slot_accepts keep
		// every slot rather than lose the panel.
		.filter(s => !Array.isArray(accepts?.[s]) || accepts[s].length === 1)
	// The bar at each card's OWN slot. `Rated.replacement` cannot answer this: it
	// reports the bar where a player was worth MOST, so `best.points - best.replacement`
	// is literally `best.bscore` — the old number — and a slot that is nobody's best
	// is missing from it entirely. SP is that slot here, which is why the card
	// labelled SP was showing a P-priced figure. `replacementBySlot` is the same
	// arithmetic rateAll uses, and test/trade.mjs pins the two against each other.
	const bars = replacementBySlot(league, pool, teams)
	const cards = active
		.map(slot => {
			// An unknown bar is not a bar of zero: a slot nobody in the pool is eligible
			// for is left out of the map, and a cliff cannot be measured against nothing.
			const bar = bars.get(slot)
			if (bar === undefined) return null
			const eligible = pool.filter(r => r.rateable && r.slots.includes(slot))
			if (eligible.length < 3) return null
			// By POINTS, not bscore, now that the bar is per-slot: max points is max
			// cliff, and picking by bscore names the man who is best somewhere ELSE —
			// on Streaming the 1B card read "Jake Bauers", an outfielder, over Rafael
			// Devers. A reduce rather than `pool[0]`, which was whichever row the
			// board's CURRENT sort happened to put first: sorting by name turned this
			// card into "+-29 · A.J. Minter", the alphabetically first reliever, his
			// negative bscore printed with a plus in front of it.
			const best = eligible.reduce((a, b) => (b.points > a.points ? b : a))
			return { slot, cliff: best.points - bar, best }
		})
		.filter((x): x is NonNullable<typeof x> => x !== null)
		.sort((a, b) => b.cliff - a.cliff)

	if (cards.length < 2) return null
	const widest = cards[0]!.cliff || 1
	return (
		<section className="card full">
			<h2>Where it hurts to wait</h2>
			<p className="sub">
				How far the best player you can still get at each slot sits above the next man
				up there. A short bar is a slot you can punt; a long one is a slot worth paying
				for, because waiting costs you the whole gap.
			</p>
			<div className="scarcity">
				{cards.map(c => (
					<div className="scar" key={c.slot}>
						<b>{c.slot}</b>
						<div className="bar" aria-hidden="true">
							<i style={{ width: `${Math.max(3, (c.cliff / widest) * 100)}%` }} />
						</div>
						<span className="val">+{c.cliff.toFixed(0)}</span>
						<span className="who" title={`${c.best.player.name} is the best ${c.slot} in the player pool by projected points`}>
							{c.best.player.name}
						</span>
					</div>
				))}
			</div>
		</section>
	)
}

/**
 * Buy low: the two new signals, which are only interesting together.
 *
 * A big expected-minus-actual gap on its own finds unlucky players who everyone
 * already owns. A low ownership on its own finds players nobody wants for good
 * reason. The intersection — hitting the ball better than his line says AND still
 * cheap — is the one case where the field is demonstrably behind the data, and it
 * is the reason to read Statcast at all.
 *
 * Scored as the product of two normalised terms rather than a sum, so a player has
 * to clear both bars: being free does not compensate for making weak contact.
 */
const BuyLow = ({ rows }: { rows: Ranked[] }) => {
	const picks = rows
		.filter(
			r =>
				r.regressionGap !== null &&
				r.rosteredPct !== null &&
				r.rosteredPct < 70 &&
				r.bscore > 0 &&
				(r.player.group === "hitting" ? r.regressionGap : -r.regressionGap) > 0.035
		)
		.map(r => {
			const gap = (r.player.group === "hitting" ? 1 : -1) * r.regressionGap!
			return { r, gap, score: gap * (100 - r.rosteredPct!) }
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)

	if (!picks.length) return null
	return (
		<section className="card full buylow">
			<h2>Buy low</h2>
			<p className="sub">
				Hitting the ball harder than their results show over the last three weeks, and
				still cheap. Both conditions, not either — an unlucky player everyone already
				owns is not an opportunity.
			</p>
			<div className="buylow-grid">
				{picks.map(({ r, gap }) => (
					<article key={r.player.id} className="buylow-card">
						<b>{r.player.name}</b>
						<span className="pos">
							{r.player.team ?? "FA"} · {r.slot}
						</span>
						<dl>
							<div className="pair">
								<dt>expected − actual</dt>
								<dd className="good">+{gap.toFixed(3)}</dd>
							</div>
							<div className="pair">
								<dt>rostered</dt>
								<dd>{r.rosteredPct}%</dd>
							</div>
							<div className="pair">
								<dt>bscore</dt>
								<dd>{r.bscore}</dd>
							</div>
						</dl>
						<p className="tiny-note">
							{r.player.group === "hitting" ?
								`His contact over the last three weeks was worth ${gap.toFixed(3)} more wOBA than he was paid for, and ${100 - r.rosteredPct!}% of leagues still have him free.`
							:	`He has been hit softer than his line suggests by ${gap.toFixed(3)} wOBA, with ${100 - r.rosteredPct!}% of leagues not rostering him.`}
						</p>
					</article>
				))}
			</div>
		</section>
	)
}

/**
 * What the card says when the filters leave nobody worth adding.
 *
 * bscore is projected points minus what the best freely available player at the
 * same slot is projected for, so a board on which every bscore is <= 0 holds no
 * recommendation at all — only players who would cost you points. The card stays
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
				Every player these filters leave projects at or below the best man you could
				already add for free at his own slot, so each of them would cost you points.
				Widen the filters and ask again.
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
	streaming
}: {
	r: Ranked
	horizon: string
	/** Which availability source picked him, and therefore which claim the card is
	 *  entitled to make. */
	basis: "pool" | "ownership" | "none"
	/** On the streaming view the card is a waiver-day answer, so it drops the two
	 *  clauses that describe the projection rather than the decision. */
	streaming: boolean
}) => {
	const clauses: string[] = []
	clauses.push(
		`Projected for ${r.bscore} more points than the best ${r.slot} you could add off waivers, over ${horizon}`
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
		if (r.projection.matchupMultiplier !== 1)
			clauses.push(
				r.projection.matchupMultiplier > 1 ?
					`the schedule ahead of him is soft (×${r.projection.matchupMultiplier.toFixed(3)})`
				:	`the schedule ahead of him is hard (×${r.projection.matchupMultiplier.toFixed(3)})`
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
	const worry =
		r.injury ? `He's listed ${r.injury.toLowerCase()}, so treat that number carefully.`
		: r.confidence.value < 0.7 ?
			`Confidence is only ${Math.round(r.confidence.value * 100)}% — ${r.confidence.reasons.join(", ")}.`
		:	null
	return (
		<section className="card full pick">
			<span className="pick-bot" aria-hidden>
				<Billy />
			</span>
			<div className="pick-body">
				<h2>Billy&rsquo;s pick</h2>
				<p className="pick-name">{r.player.name}</p>
				{/*
				  It printed "Rostered in null% of leagues" whenever the estimate picked
				  a man Yahoo never listed — which is now a live case rather than a
				  hypothetical: the ownership tier counts an unlisted player as gettable
				  precisely because the sweep never reached him, so the card's own
				  recommendation is the row most likely to have no percentage on it. An
				  absence is stated as an absence.
				*/}
				<p className="pick-avail">
					{basis === "pool" ? "Free agent in your league."
					: basis === "ownership" ?
						r.rosteredPct === null ?
							"Probably free — Yahoo lists no rostered share for him, so this is an estimate."
						:	`Probably free — rostered in ${r.rosteredPct}% of leagues, below what a league this size takes.`
					:	"Best bscore on this board — availability unknown."}
				</p>
				<p className="pick-why">
					{clauses.join(" · ")}.
					{worry && <em> {worry}</em>}
				</p>
			</div>
			<span className="pick-score">
				<b>{r.bscore}</b>
				<span>bscore</span>
			</span>
		</section>
	)
}

const COLUMN_HELP: Record<NonNullable<Filters["sort"]>, string> = {
	name: "Sort by player name.",
	uscore:
		"uscore — underrated score, in the same points as bscore. What he adds, times the share of leagues where he is still free: bscore \u00d7 (1 \u2212 owned). bscore asks who is best; uscore asks who is the best you can actually get. The ownership it divides by is printed under it; \u201cunlisted\u201d means Yahoo prices no ownership for him — unknown, not unowned, so there is no uscore either.",
	bscore:
		"bscore — beanescore. Projected points over the horizon minus what the best freely available player at the same slot would score. 40 means forty more points than the next man up.",
	marketEdge:
		"Edge — how many points he beats the typical player rostered about as widely as he is. Like uscore but a subtraction rather than a ratio, so it stays in league points and is less swayed by the barely-owned.",
	points: "Projected points — what he scores over the horizon in your league's own scoring.",
	replacement: "Waiver points — what the next man up at his slot is projected to score.",
	confidence:
		"How much real data stands behind the projection: playing time so far, whether Statcast has him, and whether he's healthy. Not the odds he plays well.",
	undervaluation:
		"Luck — how far his results trail the quality of his contact over the last three weeks, ranked against everyone on his side of the ball. 90 means only 10% have been unluckier.",
	contact:
		"Contact vs results — the gap between expected and actual wOBA over the last three weeks, where contact and results actually diverge."
}


const SortHead = ({
	col, field, filters, setFilters, right, unit, children
}: {
	/** Which board column this heading is, echoed onto the cell as `data-col`.
	 *  The grid places by that name rather than by child index — see
	 *  BOARD_GRID_CSS for why an index is not survivable here. */
	col: string
	field: NonNullable<Filters["sort"]>
	filters: Filters
	setFilters: (f: (p: Filters) => Filters) => void
	right?: boolean
	/**
	 * A denominator shown quietly beside the label — "/100" on a percentile column.
	 * Separate from `children` so the spoken name can say "out of 100" in words
	 * while the heading stays two glyphs wide.
	 */
	unit?: string
	/** A plain string, because the sort state is announced by interpolating it. */
	children: string
}) => {
	const active = filters.sort === field
	return (
		<button
			type="button"
			data-col={col}
			className={`sort-head${right ? " r" : ""}${active ? " active" : ""}`}
			onClick={() =>
				setFilters(f =>
					f.sort === field ?
						{ ...f, desc: !f.desc }
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
					`${children}${unit ? ` out of ${unit.replace("/", "")}` : ""}, sorted ${filters.desc ? "descending" : "ascending"}, activate to reverse`
				:	`Sort by ${children}${unit ? ` out of ${unit.replace("/", "")}` : ""}`
			}
			title={COLUMN_HELP[field]}
		>
			{children}
			{unit && <span className="of">{unit}</span>}
			<span className="arrow">{active ? (filters.desc ? "▾" : "▴") : ""}</span>
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
	moves: number,
	stream: boolean
) =>
	[
		`${rank}. ${r.player.name}, ${r.slot}, ${r.player.team ?? "no team"}`,
		// The move marker is drawn as a rail and a rule, which a screen reader gets
		// nothing from, so the boundary is spoken on the rows it falls on.
		...(moves > 0 && rank <= moves ?
			[rank === moves ? `within your ${moves} moves, and the last one` : `within your ${moves} moves`]
		:	[]),
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
		 * instead of drawn — and this file has shipped that defect before.
		 */
		...(stream ?
			[
				r.rosteredPct === null ?
					"not on Yahoo's rostered list, so counted as gettable by estimate"
				:	`rostered in ${r.rosteredPct} percent of leagues`,
				`${r.points} projected points over this window`
			]
			// one clause for the merged column, because it is one fact. Spoken as two it
			// said "ownership unlisted, so no uscore ... ownership unlisted" on the 500
			// rows Yahoo does not price — the same absence read out twice.
		: r.uscore === null ? ["ownership unlisted, so no uscore"]
		: [`uscore ${r.uscore}, rostered in ${r.rosteredPct} percent of leagues`]),
		`bscore ${r.bscore}`,
		...(stream ?
			[`against ${r.replacement} for the next arm on the wire`]
		:	[`${r.points} projected points against ${r.replacement} for a replacement`]),
		`confidence ${pct(r.confidence.value)}`,
		// the same choice the games column makes, spoken: his own starts where they
		// exist, his team's games where they don't, and never one labelled the other
		r.scheduledStarts != null ?
			`${r.scheduledStarts.toFixed(1)} scheduled starts`
		: r.projection.horizonGames ?
			`${r.projection.horizonGames} team games scheduled`
		:	"no scheduled games on record",
		...(r.injury ? [`listed ${r.injury.toLowerCase()}`] : [])
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
	moves,
	open,
	onToggle
}: {
	rank: number
	r: BoardRow
	/** On the Streaming tab, where the row answers a different question and
	 *  therefore carries different columns — see STREAM_GRID_CSS. */
	stream: boolean
	/** His schedule in this window, on the streaming tab. Null everywhere else. */
	starts: Starts | null
	/** How many moves the reader said he has left. The first `moves` rows carry the
	 *  marker; the last of them carries the rule the list stops at. */
	moves: number
	open: boolean
	onToggle: () => void
}) => (
	<>
		<button
			className={`board-row${open ? " open" : ""}`}
			onClick={onToggle}
			type="button"
			aria-expanded={open}
			aria-controls={detailId(r)}
			data-pick={moves > 0 && rank <= moves ? (rank === moves ? "last" : "yes") : undefined}
			aria-label={rowLabel(rank, r, starts, moves, stream)}
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
								:	`Rostered in ${r.rosteredPct}% of Yahoo leagues.`
							}
						>
							{" · "}
							{r.rosteredPct === null ? "not listed" : `${r.rosteredPct}% owned`}
						</span>
					)}
					{r.injury && <em className="hurt">{r.injury}</em>}
				</span>
				{starts && <StartLine s={starts} />}
			</span>
			{/* uscore and its own denominator, in one column. Ownership had a column of
			    its own and went blank on precisely the rows uscore did, so the board
			    printed one absence twice — 500 of 1,233 rows, and 36 of the first 60.
			    Where Yahoo priced him the cell shows both numbers; where it didn't it
			    says so once, in a word rather than a dash. */}
			{stream ?
				<span
					className="r pts"
					data-col="pts"
					title={`Projected for ${r.points} points over this window in your league's own scoring — the quantity. bscore beside it is the same number minus what the next arm on the wire would score.`}
				>
					{r.points.toFixed(1)}
				</span>
			:	<span
				className={`r uscore${(r.uscore ?? 0) >= 10 ? " up" : ""}`}
				data-col="uscore"
				title={
					r.uscore === null ?
						"Yahoo lists no ownership for him, so there is nothing to divide by — unknown, not unowned."
					:	`${r.addValue} points above the next man up, and ${100 - r.rosteredPct!}% of leagues still have him free.`
				}
			>
				{r.uscore === null ?
					<em className="us-none">unlisted</em>
				:	<>
						<b className="us-val">{r.uscore}</b>
						<span className="us-own">{r.rosteredPct}% owned</span>
					</>
				}
			</span>}
			<span className="r bscore" data-col="bscore">{r.bscore}</span>
			<Window r={r} />
			<Confidence value={r.confidence.value} reasons={r.confidence.reasons} />
			{!stream && <span
				className={`r gap${(r.undervaluation ?? 0) >= 70 ? " up" : ""}`}
				data-col="luck"
				title={
					r.undervaluation === null ?
						"No Statcast data, so no luck reading."
					:	`Unluckier than ${r.undervaluation}% of ${r.player.group === "hitting" ? "batters" : "pitchers"} — his results trail the quality of his contact by this much.`
				}
			>
				{r.undervaluation === null ? "—" : r.undervaluation}
			</span>}
		</button>
		{open && <Detail r={r} />}
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
const Detail = ({ r }: { r: Ranked }) => {
	const top = Object.entries(r.projected.breakdown).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
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
					<div className="pair">
						<dt>confidence</dt>
						<dd title={r.confidence.reasons.join("; ")}>{pct(r.confidence.value)}</dd>
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
				{r.confidence.reasons.length > 0 && (
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
				{(r.projection.missing.length > 0 || r.projected.unscoreable.length > 0) && (
					<>
						{/* Promoted out of last place. What the model could not read is the
						    product's own promise — absent is reported as absent — and it was
						    sitting at the bottom of the rightmost column, below the Statcast
						    tables, where a reader who scrolled no further would never see it. */}
						<h3>Missing</h3>
						<ul className="notes warn">
							{r.projection.missing.map(m => <li key={m}>{MISSING_LABEL[m] ?? m}</li>)}
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

				<h3>Statcast model</h3>
				<p className="tiny-note">
					Expected stats are MLB&rsquo;s model of what this contact usually produces —
					not something that happened.
				</p>
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
					:	<p className="empty">No Statcast row for this player.</p>}
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
							<dt>{code}</dt>
							<dd className={value < 0 ? "neg" : ""}>{value}</dd>
						</div>
					))}
				</dl>
			</div>
		</div>
	)
}
