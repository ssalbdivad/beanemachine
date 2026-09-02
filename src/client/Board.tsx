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
	const { rows } = useBoard(snapshot, league, filters, availableNames)
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

	return (
		<>
			<section className="card full board-controls">
				<h2>Filters</h2>
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
						<span>Slot</span>
						<select value={filters.slot} onChange={e => set("slot", e.currentTarget.value)}>
							{SLOTS.map(s => (
								<option key={s} value={s}>{s || "any slot"}</option>
							))}
						</select>
					</label>
					<label className="ctl">
						<span>Side</span>
						<select
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
							value={filters.sort}
							onChange={e => set("sort", e.currentTarget.value as Filters["sort"])}
						>
							<option value="bscore">bscore (value over replacement)</option>
							<option value="points">projected points</option>
							<option value="undervaluation">most undervalued (above replacement)</option>
						</select>
					</label>
					<label className="ctl">
						<span>Min confidence</span>
						<select
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
		</>
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
		"Luck — how far his results trail the quality of his contact, ranked against everyone else on his side of the ball. 90 means only 10% have been unluckier."
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
			<span className="r bscore">{r.bscore}</span>
			<span className="r dim">{r.points}</span>
			<span className="r dim">{r.replacement}</span>
			<Confidence value={r.confidence.value} reasons={r.confidence.reasons} />
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
					Expected stats are MLB's model of what this contact usually produces — not
					something that happened.
				</p>
				<dl>
					{r.underlying?.xwoba != null ?
						<>
							<div className="pair"><dt>xwOBA</dt><dd>{r.underlying.xwoba}</dd></div>
							{r.underlying.xba != null && (
								<div className="pair"><dt>xBA</dt><dd>{r.underlying.xba}</dd></div>
							)}
							{r.underlying.xslg != null && (
								<div className="pair"><dt>xSLG</dt><dd>{r.underlying.xslg}</dd></div>
							)}
						</>
					:	<p className="empty">No Statcast row for this player.</p>}
				</dl>
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
