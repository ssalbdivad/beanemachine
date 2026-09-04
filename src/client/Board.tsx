import { useMemo, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { Billy } from "./Billy.tsx"
import { Fragment2 } from "./panels.tsx"
import { DEFAULT_FILTERS, normalizeName, useBoard, type Filters, type Ranked } from "./useBoard.ts"
import { api, ApiError, type AvailablePool } from "./api.ts"
import { useEffect } from "react"
import type { ResolvedPeriod } from "../engine/period.ts"
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

/**
 * Above this share of leagues, a player is not a recommendation — he is a fact.
 *
 * The same bar the Buy low card uses, so the two cards mean the same thing by
 * "still gettable" rather than each picking its own number.
 */
/** Rows rendered per step as the reader scrolls. */
const PAGE = 60

const WIDELY_ROSTERED = 70

const SLOTS = ["", "C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP", "P"]

/** The three horizons, as a tablist: three questions, not three filters. */
const MODES = [
	["stream", "Streaming", "this week's matchup — who wins it for you"],
	["board", "This fortnight", "the standing board, 14 days out"],
	["stash", "Stash", "rest of season — who to hold, not who to start"]
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
	if (mode === "stream" && period)
		return {
			range: `${period.start} → ${period.end}`,
			phrase:
				period.kind === "daily" ? "today"
				: period.kind === "rolling" ? "a rolling 7 days"
				: "the rest of this scoring period"
		}
	if (mode === "stash")
		return {
			range: `${start} → the end of the regular season`,
			phrase: "the rest of the regular season"
		}
	const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000)
	return { range: `${start} → ${end}`, phrase: `the next ${days} days` }
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
	const { rated, rows, scored, edgeCoverage, period } =
		useBoard(snapshot, league, filters, availableNames)
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
	const poolKnown = availableNames !== null && availableNames !== undefined
	// bscore <= 0 means the freely available body at his own slot outscores him, so
	// adding him is a net loss of points. There is no honest way to recommend that.
	const addable = rows.filter(r => r.bscore > 0)
	const best = (c: Ranked[]) => c.reduce((a, b) => (b.bscore > a.bscore ? b : a))
	const tier =
		poolKnown ? addable.filter(r => availableNames!.has(normalizeName(r.player.name)))
		: rows.some(r => r.rosteredPct !== null) ?
			addable.filter(r => r.rosteredPct !== null && r.rosteredPct < WIDELY_ROSTERED)
		:	[]
	const picked = tier.length ? best(tier) : undefined
	const pick = picked ?? (addable.length ? best(addable) : null)
	const basis: "pool" | "ownership" | "none" =
		picked === undefined ? "none"
		: poolKnown ? "pool"
		: "ownership"

	const narrowed = [
		filters.group === "hitting" ? "batters only"
		: filters.group === "pitching" ? "pitchers only"
		: "",
		filters.minConfidence > 0 ? `confidence ${pct(filters.minConfidence)}+` : "",
		filters.hideInjured ? "injured hidden" : ""
	].filter(Boolean)

	return (
		<>
			<section className="card full board-controls">
				<h2>What are you deciding?</h2>
				<style href="board-mode-focus" precedence="default">{MODE_FOCUS_CSS}</style>
				<style href="board-grid" precedence="default">{BOARD_GRID_CSS}</style>
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
				{/* Position first and as chips, not a select: it is the filter people reach
				    for constantly, and two clicks to change a dropdown is two too many. */}
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
				<div className="filters">
					<label className="ctl">
						<span>Search</span>
						<input
							type="text"
							value={filters.search}
							placeholder="Player name…"
							onChange={e => set("search", e.currentTarget.value)}
						/>
					</label>
					<label className="ctl">
						<span>Rank by</span>
						<select
							data-ctl="sort"
							value={filters.sort}
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
					<label className="toggle" title={pool?.note ?? poolError ?? "Reading your league's free agents…"}>
						<input
							type="checkbox"
							disabled={!availableNames}
							checked={filters.availableOnly}
							onChange={e => set("availableOnly", e.currentTarget.checked)}
						/>
						<span>
							Free agents only
							{pool && pool.players.length > 0 && (
								<em className="pool-count"> {pool.players.length}</em>
							)}
							{pool && pool.players.length === 0 && (
								<em className="pool-count"> unavailable</em>
							)}
							{!pool && !poolError && <em className="pool-count"> …</em>}
						</span>
					</label>
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

			{pick ? <BillysPick r={pick} horizon={span.phrase} basis={basis} /> : <NoPick />}

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
				{/* `data-sort` is read by the 640px rule in BOARD_GRID_CSS, which puts the
				    uscore column back on a phone when the board is ranked by it. */}
				<div className="board" data-sort={filters.sort}>
					{/* Seven columns, each answering a different question. `proj pts` and
					    `waiver pts` used to sit here too, but bscore is one minus the other,
					    so the table stated the same fact three times; the arithmetic is in
					    the drill-down where it belongs. `owned` was an eighth until it was
					    folded into uscore, whose denominator it is — BOARD_GRID_CSS carries
					    the count of rows on which the two went blank together. */}
					<div className="board-head">
						<span data-col="rank">#</span>
						<SortHead col="who" field="name" filters={filters} setFilters={setFilters}>Player</SortHead>
						<SortHead col="uscore" field="uscore" filters={filters} setFilters={setFilters} right>uscore</SortHead>
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
							games
						</span>
						<SortHead col="conf" field="confidence" filters={filters} setFilters={setFilters}>confidence</SortHead>
						{/* The number is a percentile, and nothing said so: 88 read as a quantity of
						    luck rather than as "unluckier than 88% of his side". The denominator
						    belongs in the heading, read once, rather than on 1,235 rows. */}
						<SortHead col="luck" field="undervaluation" filters={filters} setFilters={setFilters} right unit="/100">
							luck
						</SortHead>
					</div>
					{rows.slice(0, limit).map((r, i) => (
						<Row key={r.player.id} rank={i + 1} r={r} open={open === r.player.id}
							onToggle={() => setOpen(open === r.player.id ? null : r.player.id)} />
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

			{/* Supporting analysis sits AFTER the ranking it supports. Both answer
			    "where should I spend attention", which is a second question — putting
			    them above the board pushed the actual recommendations below the fold. */}
			<BuyLow rows={rows} />
			<Scarcity pool={rated} league={league} />
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
	basis
}: {
	r: Ranked
	horizon: string
	/** Which availability source picked him, and therefore which claim the card is
	 *  entitled to make. */
	basis: "pool" | "ownership" | "none"
}) => {
	const clauses: string[] = []
	clauses.push(
		`Projected for ${r.bscore} more points than the best ${r.slot} you could add off waivers, over ${horizon}`
	)
	// The "rostered in N% of leagues" clause used to live here. It came off the
	// "% Ros" sweep, most of which is the per-game weather line rather than a
	// roster share, so it was stating a number that is usually wrong about a
	// player it is usually wrong about. A missing clause beats a false one.
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
				<p className="pick-avail">
					{basis === "pool" ? "Free agent in your league."
					: basis === "ownership" ? `Rostered in ${r.rosteredPct}% of leagues.`
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

const COLUMN_HELP: Record<Filters["sort"], string> = {
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
	field: Filters["sort"]
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
const rowLabel = (rank: number, r: Ranked) =>
	[
		`${rank}. ${r.player.name}, ${r.slot}, ${r.player.team ?? "no team"}`,
		// one clause for the merged column, because it is one fact. Spoken as two it
		// said "ownership unlisted, so no uscore ... ownership unlisted" on the 500
		// rows Yahoo does not price — the same absence read out twice.
		r.uscore === null ?
			"ownership unlisted, so no uscore"
		:	`uscore ${r.uscore}, rostered in ${r.rosteredPct} percent of leagues`,
		`bscore ${r.bscore}`,
		`${r.points} projected points against ${r.replacement} for a replacement`,
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

const Row = ({ rank, r, open, onToggle }: { rank: number; r: Ranked; open: boolean; onToggle: () => void }) => (
	<>
		<button
			className={`board-row${open ? " open" : ""}`}
			onClick={onToggle}
			type="button"
			aria-expanded={open}
			aria-controls={detailId(r)}
			aria-label={rowLabel(rank, r)}
		>
			<span className="rank" data-col="rank">{rank}</span>
			<span className="who" data-col="who">
				<b>{r.player.name}</b>
				<span className="meta">
					<span className="code">{r.slot}</span>
					{r.player.team ?? "—"}
					{r.injury && <em className="hurt">{r.injury}</em>}
				</span>
			</span>
			{/* uscore and its own denominator, in one column. Ownership had a column of
			    its own and went blank on precisely the rows uscore did, so the board
			    printed one absence twice — 500 of 1,233 rows, and 36 of the first 60.
			    Where Yahoo priced him the cell shows both numbers; where it didn't it
			    says so once, in a word rather than a dash. */}
			<span
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
			</span>
			<span className="r bscore" data-col="bscore">{r.bscore}</span>
			<Window r={r} />
			<Confidence value={r.confidence.value} reasons={r.confidence.reasons} />
			<span
				className={`r gap${(r.undervaluation ?? 0) >= 70 ? " up" : ""}`}
				data-col="luck"
				title={
					r.undervaluation === null ?
						"No Statcast data, so no luck reading."
					:	`Unluckier than ${r.undervaluation}% of ${r.player.group === "hitting" ? "batters" : "pitchers"} — his results trail the quality of his contact by this much.`
				}
			>
				{r.undervaluation === null ? "—" : r.undervaluation}
			</span>
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
