import { useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { DEFAULT_FILTERS, useBoard, type Filters, type Rated } from "./useBoard.ts"

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
	const { rows } = useBoard(snapshot, league, filters)
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
							<option value="undervaluation">most undervalued</option>
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
					{rows.length} players ranked in {league.meta.league_name ?? "this league"}'s scoring ·
					projected over {snapshot.horizon.start} → {snapshot.horizon.end}
				</p>
				<div className="board">
					<div className="board-head">
						<span>#</span>
						<SortHead field="name" filters={filters} setFilters={setFilters}>Player</SortHead>
						<SortHead field="bscore" filters={filters} setFilters={setFilters} right>bscore</SortHead>
						<SortHead field="points" filters={filters} setFilters={setFilters} right>proj</SortHead>
						<SortHead field="replacement" filters={filters} setFilters={setFilters} right>repl</SortHead>
						<SortHead field="confidence" filters={filters} setFilters={setFilters}>conf</SortHead>
						<SortHead field="undervaluation" filters={filters} setFilters={setFilters} right>x−a</SortHead>
					</div>
					{rows.slice(0, 120).map((r, i) => (
						<Row key={r.player.id} rank={i + 1} r={r} open={open === r.player.id}
							onToggle={() => setOpen(open === r.player.id ? null : r.player.id)} />
					))}
					{!rows.length && <p className="empty">No players match these filters.</p>}
				</div>
				{rows.length > 120 && (
					<p className="sub" style={{ marginTop: 12 }}>
						Showing the top 120 of {rows.length} — narrow the filters to see further down.
					</p>
				)}
			</section>
		</>
	)
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
			title={`Sort by ${field}`}
		>
			{children}
			<span className="arrow">{active ? (filters.desc ? "▾" : "▴") : ""}</span>
		</button>
	)
}

const Row = ({ rank, r, open, onToggle }: { rank: number; r: Rated; open: boolean; onToggle: () => void }) => (
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
			<span className="r bscore">{r.bscore}</span>
			<span className="r dim">{r.points}</span>
			<span className="r dim">{r.replacement}</span>
			<Confidence value={r.confidence.value} reasons={r.confidence.reasons} />
			<span className={`r gap${(r.regressionGap ?? 0) > 0 ? " up" : ""}`}>
				{r.regressionGap === null ? "—" : (r.regressionGap > 0 ? "+" : "") + r.regressionGap}
			</span>
		</button>
		{open && <Detail r={r} />}
	</>
)

/** Every number's provenance: what was observed, what was modelled, what's missing. */
const Detail = ({ r }: { r: Rated }) => {
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
					<div className="pair"><dt>volume / team game</dt><dd>{r.projection.volumePerTeamGame ?? "—"}</dd></div>
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
							{r.projection.missing.map(m => <li key={m}>{m}</li>)}
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
