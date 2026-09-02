import { useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { Billy } from "./Billy.tsx"
import { Fragment2 } from "./panels.tsx"
import { DEFAULT_FILTERS, normalizeName, useBoard, type Filters, type Ranked } from "./useBoard.ts"
import { api, ApiError, type AvailablePool } from "./api.ts"
import { useEffect } from "react"

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

const SLOTS = ["", "C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP", "P"]

/** How old the capture is. A projection built on last week's numbers is wrong in a
 *  way nothing else in the UI would reveal, so the age is always stated. */
const freshness = (capturedAt: string, now: number) => {
	const hours = (now - Date.parse(capturedAt)) / 3_600_000
	if (!Number.isFinite(hours)) return { label: "unknown age", stale: true }
	if (hours < 1) return { label: "just now", stale: false }
	if (hours < 36) return { label: `${Math.round(hours)}h ago`, stale: false }
	const days = Math.round(hours / 24)
	return { label: `${days}d ago`, stale: true }
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

	const availableNames =
		pool && pool.players.length ? new Set(pool.players.map(p => normalizeName(p.name))) : null
	const { rows, scored, edgeUsable, edgeCoverage } = useBoard(snapshot, league, filters, availableNames)
	const age = snapshot ? freshness(snapshot.capturedAt, Date.now()) : null
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

	return (
		<>
			<section className="card full board-controls">
				<h2>What are you deciding?</h2>
				<div className="modes" role="tablist" aria-label="What to rank for">
				{(
					[
						["stream", "Streaming", "the next 7 days — who wins you this week"],
						["board", "This fortnight", "the standing board, 14 days out"],
						["stash", "Stash", "rest of season — who to hold, not who to start"]
					] as const
				).map(([id, label, why]) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={filters.mode === id}
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
					{/* Only meaningful where probables exist — about a week out. Offering it
					    on the rest-of-season view would be a control that silently does
					    nothing. */}
					{filters.mode !== "stash" && (
						<label className="toggle" title="MLB publishes probable starters about a week ahead. Two starts in a scoring period is roughly double the innings.">
							<input
								type="checkbox"
								checked={filters.twoStartOnly}
								onChange={e => set("twoStartOnly", e.currentTarget.checked)}
							/>
							<span>Two-start SP only</span>
						</label>
					)}
					<label className="toggle">
						<input
							type="checkbox"
							checked={filters.hideInjured}
							onChange={e => set("hideInjured", e.currentTarget.checked)}
						/>
						<span>Hide injured</span>
					</label>
				</div>
			</section>

			{rows[0] && <BillysPick r={rows[0]} horizonDays={
				Math.round((Date.parse(snapshot.horizon.end) - Date.parse(snapshot.horizon.start)) / 86400000)
			} />}

			<section className="card full">
				<h2>
					Recommendations
					{age && (
						<span className={`chip ${age.stale ? "warn" : "ok"} age`}>
							data {age.label}
						</span>
					)}
				</h2>
				<p className="sub">
					{filters.mode === "stash" ?
						"Ranked over every game left in the regular season, so playing time and role matter more than the last fortnight. This is the view for who to hold — the underlying contact numbers on each player are here because a long horizon is where they would matter, though this project has not yet measured that honestly (see the README)."
					: filters.mode === "stream" ?
						"Ranked over the next seven days only — the week that is actually about to happen, using its real slate rather than half of a fortnight."
					:	null}
				</p>
				{!edgeUsable && filters.sort === "marketEdge" && (
					<p className="sub warn-note">
						Market edge needs how many leagues each player is rostered in, and this
						capture only priced {Math.round(edgeCoverage * 100)}% of them — Yahoo
						throttles whoever is asking, and the published snapshot is built by a CI
						runner it throttles hard. Ranking by bscore instead. Pick
						&ldquo;market edge&rdquo; explicitly to rank just the players it could price.
					</p>
				)}
				<p className="sub">
					{rows.length} players ranked in {league.meta.league_name ?? "this league"}&rsquo;s scoring ·
					projected over {snapshot.horizon.start} → {snapshot.horizon.end} ·
					playing time leans on recent form: the last{" "}
					{(snapshot.recentWindow?.hitting ?? [3, 7, 21]).join("/")} days for batters
					and {(snapshot.recentWindow?.pitching ?? [5, 21]).join("/")} for pitchers,
					weighting the most recent window double
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
					<summary>What these columns mean</summary>
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
			<Scarcity rows={rows} league={league} />
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
const Scarcity = ({ rows, league }: { rows: Ranked[]; league: League }) => {
	// slot_order lists every roster SPOT, so a 3-outfielder league names OF three
	// times. Scarcity is a property of the slot, not of each seat in it.
	const active = [
		...new Set(
			(league.roster.slot_order ?? Object.keys(league.roster.slots)).filter(
				s => s !== "BN" && s !== "IL" && s !== "NA"
			)
		)
	]
	const cards = active
		.map(slot => {
			const pool = rows.filter(r => r.slots.includes(slot) && r.rateable)
			if (pool.length < 3) return null
			// the best available, against what the next man up at the same slot gives you
			const best = pool[0]!
			return { slot, cliff: best.bscore, replacement: best.replacement, best }
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
						<span className="who" title={`${c.best.player.name} is the best ${c.slot} on this board`}>
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
const BillysPick = ({ r, horizonDays }: { r: Ranked; horizonDays: number }) => {
	const clauses: string[] = []
	clauses.push(
		`Projected for ${r.bscore} more points than the best ${r.slot} you could add off waivers, over the next ${horizonDays} days`
	)
	if (r.marketEdge !== null && r.rosteredPct !== null)
		clauses.push(
			`he's rostered in ${r.rosteredPct}% of leagues, and that's ${r.marketEdge > 0 ? `${r.marketEdge} points more` : `${Math.abs(r.marketEdge)} points less`} than players priced like him usually give you`
		)
	if (r.projection.volumePerTeamGame !== null)
		clauses.push(
			r.player.group === "hitting" ?
				`${r.projection.volumePerTeamGame.toFixed(1)} plate appearances per team game`
			:	`${r.projection.volumePerTeamGame.toFixed(1)} outs recorded per team game`
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
	children: React.ReactNode
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
			title={COLUMN_HELP[field]}
		>
			{children}
			<span className="arrow">{active ? (filters.desc ? "▾" : "▴") : ""}</span>
		</button>
	)
}

const Row = ({ rank, r, open, onToggle }: { rank: number; r: Ranked; open: boolean; onToggle: () => void }) => (
	<>
		<button className={`board-row${open ? " open" : ""}`} onClick={onToggle} type="button">
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
			<span className="r bscore">
				{r.bscore}
				{(r.scheduledStarts ?? 0) >= 2 && (
					<em className="starts" title={`${r.scheduledStarts} starts scheduled in this window — roughly double the innings of a one-start turn.`}>
						×{r.scheduledStarts}
					</em>
				)}
			</span>
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
		<div className="detail">
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
						:	`He has been hit harder on paper than in reality by ${Math.abs(r.regressionGap)} wOBA.`}
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
