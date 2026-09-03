import { useMemo, useState } from "react"
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
const WIDELY_ROSTERED = 70

const SLOTS = ["", "C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP", "P"]

/** The three horizons, as a tablist: three questions, not three filters. */
const MODES = [
	["stream", "Streaming", "the period you can still act on — who wins you this week"],
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
	const { rated, rows, rankable, scored, edgeCoverage, period } =
		useBoard(snapshot, league, filters, availableNames)
	const set = <K extends keyof Filters,>(k: K, v: Filters[K]) =>
		setFilters(f => ({ ...f, [k]: v }))

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
					This league doesn&rsquo;t say how many teams are in it, and how deep the waiver
					wire runs depends on that — so there is no honest bscore yet. Open{" "}
					<b>League setup</b> and set the team count, and the board fills in.
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
					<b>{league.meta.league_name ?? "This template"}</b> gives you the roster shape —{" "}
					{Object.entries(league.roster.slots)
						.filter(([s]) => s !== "BN" && s !== "IL" && s !== "NA")
						.map(([s, n]) => `${n}\u00d7${s}`)
						.join(", ")}{" "}
					— but not what each stat is worth, and every projection would score exactly
					zero. Rather than rank a field of zeros, the board is waiting.
				</p>
				<p className="sub">
					Paste your league URL above to read the real values off the platform, or open
					<b> Scoring</b> and enter them. A bscore is denominated in your league&rsquo;s
					own points, so it cannot mean anything until those exist.
				</p>
			</section>
		)

	// Not a hook, so it belongs after the refusals above rather than among them —
	// and it needs the snapshot they have just established exists.
	const span = horizonSpan(snapshot, filters.mode, period)
	// Why the board is shorter than the pool. The FILTERS are the reader's own doing
	// and are named on the controls that set them; this names the cut the RANKING
	// makes on its own, which nothing else on the page would reveal.
	const rateable = rated.filter(r => r.rateable).length
	// Only the RANKING's cut. What the reader's own filters removed is already
	// visible on the controls that set them, and blaming market edge for a position
	// chip would be a sentence that is simply false.
	const cut = rateable - rankable
	const cutReason =
		filters.sort === "marketEdge" ?
			"market edge ranks only players the field has priced, and only above replacement"
		: filters.sort === "undervaluation" ? "only players above replacement can be undervalued"
		: filters.sort === "contact" ? "only players above replacement with a Statcast window"
		: "filtered"
	/**
	 * Billy picks the best player you can ACTUALLY GET, not the best player.
	 *
	 * The card used to read `rows[0]`, so on a bscore board it named Pete
	 * Crow-Armstrong — the best outfielder in the league and rostered in all of
	 * them. That is a true sentence and a useless recommendation: a pick nobody can
	 * act on is not a pick.
	 *
	 * Availability is answered by whichever source this reader actually has, and the
	 * card states WHICH, because the three are different claims:
	 *
	 * 1. The league's own free-agent list. Exact, and about YOUR league — but it
	 *    needs a publicly viewable Yahoo league and a local server, so most readers
	 *    of the hosted build never have it.
	 * 2. How widely he is rostered across leagues. Weaker and global, but it comes
	 *    off the snapshot with no server at all, which is the case this tool is in
	 *    for everybody who is not running it locally. Only values that survived
	 *    `leakedByTeam` are here — the "% Ros" sweep mostly returned the game's
	 *    weather line, and anything a whole club shared has been discarded — so an
	 *    absent figure is common and means unknown, never unowned.
	 * 3. Neither, in which case it is the top of the board and says so rather than
	 *    implying an availability nobody checked.
	 *
	 * The threshold is the same 70% the Buy low card uses, so the two cards mean the
	 * same thing by "still gettable".
	 *
	 * It searches `rows`, not the whole pool, so a reader who has filtered to
	 * catchers gets the best catcher he can get.
	 */
	const poolKnown = availableNames !== null && availableNames !== undefined
	const inPool = (r: Ranked) => availableNames!.has(normalizeName(r.player.name))
	const picked =
		poolKnown ? rows.find(inPool)
		: rows.some(r => r.rosteredPct !== null) ?
			rows.find(r => r.rosteredPct !== null && r.rosteredPct < WIDELY_ROSTERED)
		:	undefined
	const pick = picked ?? rows[0] ?? null
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

			{pick && <BillysPick r={pick} horizon={span.phrase} basis={basis} />}

			{/* The panel the horizon tabs control. The pick, buy-low and scarcity
			    cards below re-rank with it too, but this is the ranking itself, and
			    the sibling cards can't be wrapped without breaking the page grid. */}
			<section className="card full" id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(filters.mode)}>
				<h2>Recommendations</h2>
				{/* Edge is no longer the default and no longer silently falls back, so this
				    is a warning about the column you asked for rather than an announcement
				    that you were given a different one. The reason it stopped being the
				    default is the first sentence, because it is much the worse problem:
				    thin coverage makes the column incomplete, the forecast leak makes it
				    wrong. */}
				{filters.sort === "marketEdge" && (
					<p className="sub warn-note">
						Market edge divides by Yahoo&rsquo;s &ldquo;% Ros&rdquo;, and on this capture
						most of that number is the game&rsquo;s weather line rather than a roster
						share — whole clubs come back on one identical percentage, paired by the
						day&rsquo;s matchups. Captures taken from now on discard those, but this one
						predates the check, and only {Math.round(edgeCoverage * 100)}% of the board
						carries any figure at all. Treat this ranking as unreliable; bscore is the
						honest column.
					</p>
				)}
				{/* One line, because it is read on every visit: how many, over what window.
				    Everything about HOW the ranking was built — which horizon this is, what
				    playing time leans on, what each column means — is a click below, where
				    it is available on the rare occasion anyone wants it and costs no height
				    on the many occasions nobody does. */}
				<p className="sub">
					<b className="count">{rows.length}</b>
					{/* The board opens on market edge, which can only rank a player the field
					    has priced and only recommends one worth rostering — so it shows 67 of
					    1,233 and a bare count reads as a broken capture. Say what did the
					    cutting. The ranking's own cut and the reader's filters are separate
					    sentences, because blaming market edge for a position chip would
					    simply be false. */}
					{cut > 0 ?
						rows.length < rankable ?
							<> shown, of {rankable.toLocaleString()} this ranking can place from{" "}
								{rateable.toLocaleString()} — {cutReason}</>
						:	<> of {rateable.toLocaleString()} — {cutReason}</>
					:	<> players</>}{" "}
					· {span.range}
					{filters.mode === "stream" && period?.clipped &&
						", cut short by the end of the captured slate"}
				</p>
				<div className="board">
					<div className="board-head">
						<span>#</span>
						<SortHead field="name" filters={filters} setFilters={setFilters}>Player</SortHead>
						<SortHead field="marketEdge" filters={filters} setFilters={setFilters} right>edge</SortHead>
						<SortHead field="bscore" filters={filters} setFilters={setFilters} right>bscore</SortHead>
						<SortHead field="points" filters={filters} setFilters={setFilters} right>proj pts</SortHead>
						<SortHead field="replacement" filters={filters} setFilters={setFilters} right>waiver pts</SortHead>
						<span className="r" title="Games this player's team actually has scheduled in the window. Six-game weeks are worth chasing; four-game weeks are why a good hitter can be the wrong start.">GP</span>
						<SortHead field="confidence" filters={filters} setFilters={setFilters}>confidence</SortHead>
						<SortHead field="undervaluation" filters={filters} setFilters={setFilters} right>luck</SortHead>
					</div>
					{rows.slice(0, 120).map((r, i) => (
						<Row key={r.player.id} rank={i + 1} r={r} open={open === r.player.id}
							onToggle={() => setOpen(open === r.player.id ? null : r.player.id)} />
					))}
					{!rows.length && <p className="empty">No players match these filters. Try clearing the slot filter or lowering the confidence minimum.</p>}
				</div>
				<details className="legend">
					<summary>How this ranking was built</summary>
					<p className="sub">
						{filters.mode === "stash" ?
							"Ranked over every game left in the regular season, so playing time and role matter more than the last fortnight. This is the view for who to hold — the underlying contact numbers on each player are here because a long horizon is where they would matter, though this project has not yet measured that honestly (see the README)."
						: filters.mode === "stream" ?
							`Ranked over ${period ? period.basis : "a window this capture cannot state"} — using its real slate rather than half of a fortnight.`
						:	"Ranked over the next fortnight — long enough that one cold week doesn't decide it, short enough that today's role still holds."}
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
				{rows.length > 120 && (
					<p className="sub" style={{ marginTop: 12 }}>
						Showing the top 120 of {rows.length} — narrow the filters to see further down.
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
	if (r.projection.horizonGames)
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
					{basis === "pool" ?
						"The best player on this board who is a free agent in your league right now."
					: basis === "ownership" ?
						`The best player on this board still rostered in under ${WIDELY_ROSTERED}% of leagues — your own league\u2019s free-agent list isn\u2019t readable here, so this is how widely he is owned rather than whether he is free to you.`
					:	"The top of this board. Nothing here could say whether he is available, so this is not a claim that he is."}
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
	marketEdge:
		"Edge — how many points this player beats the typical player rostered in about as many leagues as he is. The default view, because the best players are already taken: this ranks who the field is wrong about, not who is best. Blank means Yahoo doesn't list him, which is not the same as nobody owning him.",
	bscore:
		"bscore — projected points over the horizon minus what the best freely available player at the same slot would score. 40 means forty more points than the next man up.",
	points: "Projected points — what this player scores over the horizon in your league's own scoring.",
	replacement:
		"Waiver points — what the next man up at this slot is projected to score. bscore is this column subtracted from the one on its left.",
	confidence:
		"How much real data stands behind the projection: playing time so far, whether Statcast has him, and whether he's healthy. Not the odds he plays well.",
	undervaluation:
		"Luck — how far his results trail the quality of his contact over the last three weeks, ranked against everyone else on his side of the ball. 90 means only 10% have been unluckier.",
	contact:
		"Contact vs results — the raw gap between expected and actual wOBA over the last three weeks. Measured over a rolling window rather than the whole season, because that is where contact and results actually diverge: gap-to-wOBA correlation is −0.61 over three weeks against −0.36 across a season."
}

/** Column header that sorts. Clicking the active column flips direction. */
const SortHead = ({
	field, filters, setFilters, right, children
}: {
	field: Filters["sort"]
	filters: Filters
	setFilters: (f: (p: Filters) => Filters) => void
	right?: boolean
	/** A plain string, because the sort state is announced by interpolating it. */
	children: string
}) => {
	const active = filters.sort === field
	return (
		<button
			type="button"
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
					`${children}, sorted ${filters.desc ? "descending" : "ascending"}, activate to reverse`
				:	`Sort by ${children}`
			}
			title={COLUMN_HELP[field]}
		>
			{children}
			<span className="arrow">{active ? (filters.desc ? "▾" : "▴") : ""}</span>
		</button>
	)
}

/**
 * What the row says out loud. Read as markup it is nine unlabelled numbers run
 * together — "1Pete Crow-ArmstrongOFChicago Cubs—52.74132.2579.51100%1427.8" —
 * which is the column headings doing all the work for sighted readers and none
 * for anyone else. Every clause here names a number that is already on the row;
 * nothing is added, and a value that is missing says it is missing.
 */
const rowLabel = (rank: number, r: Ranked) =>
	[
		`${rank}. ${r.player.name}, ${r.slot}, ${r.player.team ?? "no team"}`,
		`bscore ${r.bscore}`,
		`${r.points} projected points against ${r.replacement} for a replacement`,
		r.marketEdge === null ?
			"no market price"
		:	`market edge ${r.marketEdge > 0 ? "+" : ""}${r.marketEdge}`,
		`confidence ${pct(r.confidence.value)}`,
		r.projection.horizonGames ?
			`${r.projection.horizonGames} games scheduled`
		:	"no scheduled games on record",
		...(r.injury ? [`listed ${r.injury.toLowerCase()}`] : [])
	].join(", ")

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
			<span className="rank">{rank}</span>
			<span className="who">
				<b>{r.player.name}</b>
				<span className="meta">
					<span className="code">{r.slot}</span>
					{r.player.team ?? "—"}
					{r.injury && <em className="hurt">{r.injury}</em>}
				</span>
			</span>
			<span
				className={`r edge${(r.marketEdge ?? 0) > 0 ? " up" : ""}`}
				title={
					r.marketEdge === null ?
						"Yahoo doesn't list this player, so there is no market price to compare against. Unknown, not unowned."
					:	`Rostered in ${r.rosteredPct}% of leagues. Projected for ${r.marketEdge > 0 ? "" : ""}${r.marketEdge} points versus the typical player owned about that widely.`
				}
			>
				{r.marketEdge === null ? "—" : r.marketEdge > 0 ? `+${r.marketEdge}` : r.marketEdge}
			</span>
			<span className="r bscore">{r.bscore}</span>
			<span className="r dim">{r.points}</span>
			<span className="r dim">{r.replacement}</span>
			<Confidence value={r.confidence.value} reasons={r.confidence.reasons} />
			<span className="r games" title={`${r.projection.horizonGames} games scheduled in this window`}>
				{r.projection.horizonGames || "—"}
			</span>
			<span
				className={`r gap${(r.undervaluation ?? 0) >= 70 ? " up" : ""}`}
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

/** Every number's provenance: what was observed, what was modelled, what's missing. */
const Detail = ({ r }: { r: Ranked }) => {
	const top = Object.entries(r.projected.breakdown).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
	return (
		<div className="detail" id={detailId(r)} role="region" aria-label={`Where ${r.player.name}'s numbers come from`}>
			<div className="detail-col">
				<h3>Projected points by category</h3>
				<dl>
					{top.map(([code, value]) => (
						<div className="pair" key={code}>
							<dt>{code}</dt>
							<dd className={value < 0 ? "neg" : ""}>{value}</dd>
						</div>
					))}
				</dl>
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
			</div>
			<div className="detail-col">
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
				<h3>Our model</h3>
				{r.projection.modelled.length ?
					<ul className="notes">{r.projection.modelled.map(m => <li key={m}>{m}</li>)}</ul>
				:	<p className="empty">Nothing modelled — no projection was possible.</p>}
				{(r.projection.missing.length > 0 || r.projected.unscoreable.length > 0) && (
					<>
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
		</div>
	)
}
