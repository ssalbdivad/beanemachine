import { useEffect, useMemo, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import {
	evaluateTrade, replacementBySlot, startingLineup, type Lineup, type Start, type TradeVerdict
} from "../engine/trade.ts"
import type { League } from "../schema.ts"
import { ApiError } from "./api.ts"
import { roster as store, rosterKey } from "./roster.ts"
import "./trade.css"
import { DEFAULT_FILTERS, useBoard, type Filters, type Ranked } from "./useBoard.ts"

/**
 * The trade analyzer, in front of a human.
 *
 * A trade is not "who has the higher bscore" — `src/engine/trade.ts` exists to say
 * so — and this page is arranged to make that hard to miss: what you actually
 * start, before and after, and the one number that is the answer. The engine's own
 * refusals are shown rather than filtered out, so a spot nothing can fill, a
 * rostered player with no projection, and a stored id no longer in the snapshot
 * are all on screen instead of quietly rounded to zero.
 */

/** The standing fortnight board — the same horizon the default ranking uses, so a
 *  trade is priced against the numbers the reader just saw on it. */
const TRADE_FILTERS: Filters = { ...DEFAULT_FILTERS }

/** One spot's worth, to a tenth. */
const pts = (v: number) => v.toFixed(1)
/** A whole lineup, or the difference between two, at the same two decimals the
 *  engine's own sentence quotes — so the big number and the prose can't disagree. */
const total = (v: number) => v.toFixed(2)
const signed = (v: number) => `${v > 0 ? "+" : ""}${total(v)}`

/** Who is actually in a lineup, by the id a roster is keyed on. */
const startingKeys = (lineup: Lineup) =>
	new Set(lineup.starters.flatMap(s => (s.player ? [rosterKey(s.player.player)] : [])))

export interface TradeProps {
	/** The captured player data the whole app ranks against. Null while it loads. */
	snapshot: Snapshot | null
	/** The league whose slots and scoring the trade is priced in. */
	league: League | null
	/** The key that league is stored under. A roster is meaningless across leagues,
	 *  so it is kept per key — switching leagues switches teams. */
	leagueKey: string | null
	/** Snapshot load failure, passed straight through the way `Board` takes it. */
	error: string | null
}

export const Trade = ({ snapshot, league, leagueKey, error }: TradeProps) => {
	const { rated, scored } = useBoard(snapshot, league, TRADE_FILTERS)
	const [owned, setOwned] = useState<string[]>([])
	const [storeError, setStoreError] = useState<string | null>(null)
	const [give, setGive] = useState<string[]>([])
	const [take, setTake] = useState<string[]>([])
	const [ownQuery, setOwnQuery] = useState("")
	const [takeQuery, setTakeQuery] = useState("")

	// A team belongs to one league, so changing leagues loads that league's team and
	// abandons a half-built offer rather than re-pricing it against other slots.
	useEffect(() => {
		setGive([])
		setTake([])
		if (!leagueKey) {
			setOwned([])
			return
		}
		try {
			setOwned(store.of(leagueKey))
			setStoreError(null)
		} catch (e) {
			setOwned([])
			setStoreError(e instanceof ApiError ? e.message : String(e))
		}
	}, [leagueKey])

	const byKey = useMemo(
		() => new Map(rated.map(r => [rosterKey(r.player), r])),
		[rated]
	)

	// Every startable slot's waiver bar, read off the same pool the board ranks.
	// Rebuilt only when the pool or the league does, not on every keystroke.
	const bars = useMemo(
		() =>
			league && league.meta.max_teams !== null ?
				replacementBySlot(league, rated, league.meta.max_teams)
			:	null,
		[league, rated]
	)

	const mine = useMemo(
		() => owned.flatMap(k => (byKey.has(k) ? [byKey.get(k)!] : [])),
		[owned, byKey]
	)
	/** Stored ids the snapshot has no row for. Reported, never dropped: a team that
	 *  silently shrank would price a lineup the reader does not have. */
	const unresolved = owned.filter(k => !byKey.has(k))

	const verdict = useMemo((): TradeVerdict | null => {
		if (!league || league.meta.max_teams === null || (!give.length && !take.length)) return null
		return evaluateTrade({
			league,
			roster: mine,
			out: give.flatMap(k => (byKey.has(k) ? [byKey.get(k)!] : [])),
			in: take.flatMap(k => (byKey.has(k) ? [byKey.get(k)!] : [])),
			pool: rated,
			teams: league.meta.max_teams
		})
	}, [league, mine, give, take, byKey, rated])

	const persist = (next: () => string[]) => {
		try {
			setOwned(next())
			setStoreError(null)
		} catch (e) {
			setStoreError(e instanceof ApiError ? e.message : String(e))
		}
	}

	if (error)
		return (
			<section className="card full">
				<h2>Trade</h2>
				<p className="empty">Couldn&rsquo;t load the snapshot: {error}</p>
			</section>
		)
	if (!league || !leagueKey)
		return (
			<section className="card full">
				<h2>Trade</h2>
				<p className="empty">
					Import or configure a league first — a trade is worth what it does to the slots
					that league makes you fill.
				</p>
			</section>
		)
	if (league.meta.max_teams === null)
		return (
			<section className="card full">
				<h2>Trade</h2>
				<p className="empty">
					This league doesn&rsquo;t say how many teams are in it, and how deep the waiver
					wire runs depends on that — so a vacated spot has no honest price yet. Open{" "}
					<b>League setup</b> and set the team count.
				</p>
			</section>
		)
	// An unconfigured template has a roster shape but no scoring, so every player
	// projects exactly zero — and eighteen zero rows read as a working lineup rather
	// than as a league that cannot price anything yet. Same refusal the board makes.
	if (scored && !scored.hitting && !scored.pitching)
		return (
			<section className="card full trade-unscored">
				<h2>This league has no scoring yet</h2>
				<p className="sub">
					<b>{league.meta.league_name ?? leagueKey}</b> gives you the roster shape but not
					what each stat is worth, so every projection would score exactly zero and every
					trade would come out at +0.00. That is not a verdict, it is a missing input.
				</p>
				<p className="sub">
					Paste your league URL above to read the real values off the platform, or open{" "}
					<b>League setup</b> and enter them. A trade is priced in your league&rsquo;s own
					points, so it cannot mean anything until those exist.
				</p>
			</section>
		)
	if (!snapshot || !bars)
		return (
			<section className="card full">
				<h2>Trade</h2>
				<p className="empty">Loading player data…</p>
			</section>
		)

	const held = new Set(owned)
	const lineup = startingLineup(league, mine, bars)
	const found = (query: string, exclude: Set<string>) => {
		const needle = query.trim().toLowerCase()
		if (!needle) return []
		return rated
			.filter(
				r => !exclude.has(rosterKey(r.player)) && r.player.name.toLowerCase().includes(needle)
			)
			.sort((a, b) => Number(b.rateable) - Number(a.rateable) || b.points - a.points)
			.slice(0, 12)
	}

	return (
		<>
			<section className="card full trade-team">
				<h2>My team</h2>
				<p className="sub">
					Who you own in {league.meta.league_name ?? leagueKey}, with each man&rsquo;s bscore
					and then his projected points. Kept in this browser under this league&rsquo;s own
					key — the same players fill different slots against a different waiver wire
					elsewhere, so a roster never travels between leagues.
				</p>
				{storeError && (
					<div className="trade-store-error">
						<ul className="notes warn">
							<li>{storeError}</li>
						</ul>
						{/* The message says to clear it, so the control that does has to be here:
						    a roster that cannot be read also cannot be edited away player by
						    player, and `clear` itself has to parse the store before it can spare
						    the other leagues' rosters. */}
						<button
							type="button"
							className="ghost"
							onClick={() => {
								try {
									store.reset()
									setOwned([])
									setStoreError(null)
								} catch (e) {
									setStoreError(e instanceof ApiError ? e.message : String(e))
								}
							}}
						>
							Clear the stored roster
						</button>
					</div>
				)}
				<div className="trade-search">
					<label className="ctl grow">
						<span>Add a player you own</span>
						<input
							type="text"
							data-ctl="own-search"
							value={ownQuery}
							placeholder="Player name…"
							onChange={e => setOwnQuery(e.currentTarget.value)}
						/>
					</label>
					{owned.length > 0 && (
						<button
							type="button"
							className="ghost"
							onClick={() =>
								confirm(`Clear all ${owned.length} players from this team?`) &&
								persist(() => store.clear(leagueKey))
							}
						>
							Clear team
						</button>
					)}
				</div>
				{ownQuery.trim() && (
					<div className="trade-results">
						{found(ownQuery, held).map(r => (
							<Line
								key={rosterKey(r.player)}
								r={r}
								className="trade-result"
								action="Add"
								onAction={() => {
									persist(() => store.add(leagueKey, rosterKey(r.player)))
									setOwnQuery("")
								}}
							/>
						))}
						{!found(ownQuery, held).length && (
							<p className="empty">
								Nobody by that name is in this capture, or you already own him.
							</p>
						)}
					</div>
				)}
				<div className="trade-owned">
					{mine.length ?
						mine
							.slice()
							.sort((a, b) => b.points - a.points)
							.map(r => (
								<Line
									key={rosterKey(r.player)}
									r={r}
									className="trade-own"
									action="Remove"
									onAction={() => persist(() => store.remove(leagueKey, rosterKey(r.player)))}
								/>
							))
					:	<p className="empty">
							No players yet. Search above and add the ones you own — every number on
							this page is about your slots, so there is nothing to say until it knows
							what you hold.
						</p>
					}
				</div>
				{unresolved.length > 0 && (
					<ul className="notes warn trade-unresolved">
						{unresolved.map(k => (
							<li key={k}>
								{k} is on this team but has no row in the current capture, so nothing can
								be projected for him. He is counted nowhere below.
							</li>
						))}
					</ul>
				)}
			</section>

			<LineupCard league={league} lineup={lineup} count={mine.length} />

			<section className="card full trade-deal">
				<h2>The deal</h2>
				<p className="sub">
					Pick who leaves and who arrives. The verdict is what your starting lineup
					projects afterwards — bench depth counts only as far as it changes what you can
					start.
				</p>
				<div className="deal">
					<div className="deal-side">
						<h3>You give up</h3>
						{mine.length ?
							<div className="picks">
								{mine
									.slice()
									.sort((a, b) => b.points - a.points)
									.map(r => {
										const k = rosterKey(r.player)
										return (
											<button
												key={k}
												type="button"
												className={`chip-btn${give.includes(k) ? " on" : ""}`}
												aria-pressed={give.includes(k)}
												onClick={() =>
													setGive(g => (g.includes(k) ? g.filter(x => x !== k) : [...g, k]))
												}
											>
												{r.player.name}
											</button>
										)
									})}
							</div>
						:	<p className="empty">Add your team above first.</p>}
					</div>
					<div className="deal-side">
						<h3>You get</h3>
						<label className="ctl grow">
							<span>Search anyone</span>
							<input
								type="text"
								data-ctl="get-search"
								value={takeQuery}
								placeholder="Player name…"
								onChange={e => setTakeQuery(e.currentTarget.value)}
							/>
						</label>
						{takeQuery.trim() && (
							<div className="trade-results">
								{found(takeQuery, new Set([...held, ...take])).map(r => (
									<Line
										key={rosterKey(r.player)}
										r={r}
										className="trade-result"
										action="Get"
										onAction={() => {
											setTake(t => [...t, rosterKey(r.player)])
											setTakeQuery("")
										}}
									/>
								))}
							</div>
						)}
						<div className="picks">
							{take.flatMap(k => (byKey.has(k) ? [byKey.get(k)!] : [])).map(r => {
								const k = rosterKey(r.player)
								return (
									<button
										key={k}
										type="button"
										className="chip-btn on"
										title="Remove from the offer"
										onClick={() => setTake(t => t.filter(x => x !== k))}
									>
										{r.player.name} ×
									</button>
								)
							})}
						</div>
					</div>
				</div>
			</section>

			{verdict && (
				<Verdict
					v={verdict}
					leaving={give.flatMap(k => (byKey.has(k) ? [byKey.get(k)!] : []))}
					arriving={take.flatMap(k => (byKey.has(k) ? [byKey.get(k)!] : []))}
				/>
			)}
		</>
	)
}

/** One player, the way the board draws one: who he is, what he is worth, and the
 *  single thing you can do with him here. */
const Line = ({
	r,
	className,
	action,
	onAction
}: {
	r: Ranked
	className: string
	action: string
	onAction: () => void
}) => (
	<div className={`trade-line ${className}`}>
		<span className="who">
			<b>{r.player.name}</b>
			<span className="meta">
				<span className="code">{r.rateable ? r.slot : (r.slots[0] ?? "—")}</span>
				{r.player.team ?? "—"}
				{r.injury && <em className="hurt">{r.injury}</em>}
			</span>
		</span>
		{r.rateable ?
			<>
				<span
					className={`r bs${r.bscore < 0 ? " neg" : ""}`}
					title="bscore — points above the best man still on waivers at this slot"
				>
					{r.bscore}
				</span>
				<span className="r proj" title="Projected points over the horizon in this league's scoring">
					{pts(r.points)}
				</span>
			</>
		:	<span className="r none" title="No projection was possible for him, so he can start nowhere">
				no projection
			</span>
		}
		<button type="button" className="chip-btn act" onClick={onAction}>
			{action}
		</button>
	</div>
)

/** `Start.source` in one word each. Named rather than used verbatim because
 *  "empty" is already a class in app.css, and a lineup row is not that. */
const SOURCE_CLASS: Record<Start["source"], string> = {
	roster: "roster",
	replacement: "wire",
	empty: "hole"
}

/** What you actually start. Every spot is accounted for out loud: filled by you,
 *  covered off the wire, or empty — and an empty one is a hole, not a zero. */
const LineupCard = ({
	league,
	lineup,
	count
}: {
	league: League
	lineup: Lineup
	count: number
}) => (
	<section className="card full trade-lineup">
		<h2>Your starting lineup</h2>
		{count === 0 ?
			<p className="empty">
				Nothing to fill {league.meta.league_name ?? "this league"}&rsquo;s{" "}
				{lineup.starters.length} startable spots with yet. Add the players you own above
				and this fills in.
			</p>
		:	<>
				<div className="lineup-head">
					<span className="lineup-total" title="The sum of every startable spot below">
						{total(lineup.points)}
					</span>
					<span className="lineup-unit">
						projected points · {lineup.starters.filter(s => s.source === "roster").length} of{" "}
						{lineup.starters.length} spots filled by your own players
					</span>
				</div>
				<div className="lineup">
					{lineup.starters.map((s, i) => (
						<div className={`lineup-row ${SOURCE_CLASS[s.source]}`} key={`${s.slot}-${i}`}>
							<span className="code">{s.slot}</span>
							<span className="lineup-who">
								{s.player ?
									s.player.player.name
								: s.source === "replacement" ?
									<em title="Nobody you own is worth this spot — either nobody you own is eligible here, or the best one who is projects below the freely available player the spot is priced at.">
										best free agent at {s.slot}
									</em>
								:	<em className="hole-name" title="No price is known for this spot — nobody in the whole pool is eligible here, so there is no freely available body to price it at.">
										nothing can fill this
									</em>
								}
							</span>
							<span className="lineup-pts">{s.source === "empty" ? "—" : pts(s.points)}</span>
						</div>
					))}
				</div>
				<div className="lineup-holes">
					{lineup.holes.length ?
						<ul className="notes warn">
							{[...new Set(lineup.holes)].map(slot => (
								<li className="hole" key={slot}>
									{lineup.holes.filter(h => h === slot).length}× {slot}: nobody in the pool is
									eligible there, so the spot has no replacement level and is worth nothing
									rather than something unknown.
								</li>
							))}
						</ul>
					:	<p className="tiny-note">
							Every startable spot has a known replacement level, so no spot on this lineup
							is a hole — the ones you don&rsquo;t fill are priced off the wire.
						</p>
					}
				</div>
				{lineup.unprojectable.length > 0 && (
					<ul className="notes warn lineup-unprojectable">
						{lineup.unprojectable.map(r => (
							<li key={rosterKey(r.player)}>
								{r.player.name} has no projection, so he can start nowhere. He is on your
								team and counted in no total here.
							</li>
						))}
					</ul>
				)}
				{lineup.bench.length > 0 && (
					<div className="bench">
						<h3>On your bench</h3>
						<div className="picks">
							{lineup.bench.map(r => {
								const under = lineup.belowBar.some(b => rosterKey(b.player) === rosterKey(r.player))
								return (
									<span
										className={`chip${under ? " chip-under" : ""}`}
										key={rosterKey(r.player)}
										title={
											under ?
												`${pts(r.points)} projected points — below the replacement bar at every ` +
												`slot he can fill, so the spot is worth more left to a free agent`
											:	`${pts(r.points)} projected points — somebody better holds every spot ` +
												`he can fill`
										}
									>
										{r.player.name}
										{under && <span className="chip-mark"> · under the wire</span>}
									</span>
								)
							})}
						</div>
					</div>
				)}
			</>
		}
	</section>
)

/** Before → after → the difference, then the mechanism. The engine writes the
 *  sentence; nothing is added to it here, and nothing it could not read is hidden. */
const Verdict = ({
	v,
	leaving,
	arriving
}: {
	v: TradeVerdict
	leaving: Ranked[]
	arriving: Ranked[]
}) => {
	// A player in the deal who is in neither lineup moved no spot, so the engine's
	// sentence never mentions him. Saying so is better than leaving him unexplained:
	// the point of the metric is that bench depth is worth nothing until it starts.
	const started = startingKeys(v.lineups.before)
	const starts = startingKeys(v.lineups.after)
	const idle = arriving.filter(r => !starts.has(rosterKey(r.player)))
	const spare = leaving.filter(r => !started.has(rosterKey(r.player)))
	return (
	<section className="card full trade-verdict">
		<h2>Verdict</h2>
		<div className="verdict-nums">
			<span className="vn">
				<b className="verdict-before">{total(v.before)}</b>
				<span>before</span>
			</span>
			<span className="vn-arrow" aria-hidden="true">
				→
			</span>
			<span className="vn">
				<b className="verdict-after">{total(v.after)}</b>
				<span>after</span>
			</span>
			<span className={`vn net${v.delta > 0 ? " up" : v.delta < 0 ? " down" : ""}`}>
				<b className="verdict-delta">{signed(v.delta)}</b>
				<span>projected points</span>
			</span>
		</div>
		<p className="verdict-why">{v.explanation}</p>
		{(idle.length > 0 || spare.length > 0) && (
			<div className="verdict-idle">
				{idle.map(r => (
					<p className="tiny-note" key={rosterKey(r.player)}>
						{r.player.name} arrives but does not crack your starting lineup, so he adds
						nothing to the number above. That is the answer, not an omission.
					</p>
				))}
				{spare.map(r => (
					<p className="tiny-note" key={rosterKey(r.player)}>
						{r.player.name} was not starting for you, so giving him up costs nothing here.
					</p>
				))}
			</div>
		)}
		{v.changes.length ?
			<div className="slot-changes">
				<h3>What changes, spot by spot</h3>
				{v.changes.map((c, i) => (
					<div className="slot-change" key={`${c.slot}-${i}`}>
						<span className="code">{c.slot}</span>
						<span className="was">{c.before ?? "empty"}</span>
						<span className="vn-arrow" aria-hidden="true">
							→
						</span>
						<span className="now">{c.after ?? "empty"}</span>
						<span className={`pts${c.points > 0 ? " up" : c.points < 0 ? " down" : ""}`}>
							{signed(c.points)}
						</span>
					</div>
				))}
			</div>
		:	<p className="tiny-note">
				No spot in your starting lineup changes hands, which is why the net is what it is.
			</p>
		}
		{v.missing.length > 0 && (
			<>
				<h3>What this could not read</h3>
				<ul className="notes warn verdict-missing">
					{v.missing.map(m => (
						<li key={m}>{m}</li>
					))}
				</ul>
			</>
		)}
	</section>
	)
}

export default Trade
