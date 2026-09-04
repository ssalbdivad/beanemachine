import { useEffect, useMemo, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import {
	evaluateTrade, replacementBySlot, replacementPlayerBySlot,
	startingLineup, type Lineup, type Start, type TradeVerdict
} from "../engine/trade.ts"
import type { League } from "../schema.ts"
import { api, ApiError } from "./api.ts"
import { roster as store, rosterKey } from "./roster.ts"
import { lineupStore, type StoredLineup } from "./lineup.ts"
import { plan, railViolations, DEFAULTS, type Plan } from "../auto/plan.ts"
import "./trade.css"
import { DEFAULT_FILTERS, normalizeName, useBoard, type Filters, type Ranked } from "./useBoard.ts"

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
	// and WHO each of those bars is, so a spot the wire covers can name him
	const barMen = useMemo(
		() =>
			league && league.meta.max_teams !== null ?
				replacementPlayerBySlot(league, rated, league.meta.max_teams)
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

	/**
	 * Read the roster off the league's own Yahoo page instead of typing it.
	 *
	 * This card is the gate to the starting lineup and to every trade verdict, and
	 * it used to open on an empty search box asking you to add the players you own
	 * — twenty-seven of them, one at a time, before the page could say anything.
	 * Yahoo already serves the roster publicly on the team page that `src/import.ts`
	 * downloads anyway for the team NAME, so nothing new has to be reachable.
	 *
	 * Yahoo's ids are its own, so the join runs through `normalizeName` — the same
	 * join `ownership` and `eligibility` already use. Anyone it cannot place is
	 * NAMED rather than silently dropped: a roster that quietly lost two players
	 * would misprice every lineup below it.
	 */
	const [seats, setSeats] = useState<StoredLineup | null>(null)
	/**
	 * The free agents you could actually add.
	 *
	 * The board has fetched this for a while to power its "free agents only" filter;
	 * this page never had it, which is why it could price a trade but not propose a
	 * pickup. An add/drop plan is meaningless without it — every candidate would be
	 * somebody already on a roster.
	 */
	const [pool, setPool] = useState<Set<string> | null>(null)
	const [pulling, setPulling] = useState(false)
	const [pullNote, setPullNote] = useState<string | null>(null)
	const leagueId = league?.meta.league_id ?? null
	const teamId = league?.meta.team_id ?? null
	const platform = league?.meta.platform ?? "yahoo"
	const platformName =
		platform === "espn" ? "ESPN"
		: platform === "sleeper" ? "Sleeper"
		: "Yahoo"
	/**
	 * Which team in the league is yours, when the league URL never said.
	 *
	 * Yahoo puts the team number in the URL you pasted and ESPN puts it in
	 * `teamId=`, so for those `team_id` is usually already known. A Sleeper league
	 * URL names the league and nothing else — Sleeper keys a team by `roster_id`,
	 * the small 1..N it shows beside your team, and ownership by an 18-digit
	 * account id that appears nowhere in any URL. So it cannot be derived and has
	 * to be asked for. It used to be neither: this whole card was hidden unless
	 * `team_id` existed, which on Sleeper meant the button could never appear at
	 * all, and on an ESPN URL without `teamId=` meant the same.
	 */
	const [teamEntry, setTeamEntry] = useState("")
	const readTeamId = teamId ?? (teamEntry.trim() || null)
	const season = Number(league?.meta.season)

	const pullRoster = async () => {
		if (!leagueId || !readTeamId || !leagueKey) return
		setPulling(true)
		setPullNote(null)
		try {
			const res = await api.roster({
				platform,
				leagueId: String(leagueId),
				teamId: String(readTeamId),
				// ESPN 404s a season a league never played and the reader otherwise
				// assumes the current one, so an imported league's own season is sent
				...(platform === "espn" && Number.isFinite(season) ? { season } : {})
			})
			if (!res.players.length) {
				setPullNote(res.note)
				return
			}
			// one pass over the rated pool, keyed the way the join needs
			const byName = new Map<string, Ranked[]>()
			for (const r of rated) {
				const k = normalizeName(r.player.name)
				byName.set(k, [...(byName.get(k) ?? []), r])
			}
			const keys: string[] = []
			const missed: string[] = []
			for (const y of res.players) {
				const hits = byName.get(normalizeName(y.name))
				if (!hits?.length) {
					missed.push(y.name)
					continue
				}
				// a two-way player is two rated rows; Yahoo's page does not say which
				// you hold, so both are added and you can drop the one you do not
				for (const r of hits) keys.push(rosterKey(r.player))
			}
			persist(() => store.set(leagueKey, keys))
			// the seats as they were read, which is what the planner needs and what
			// the id list cannot carry
			const at = new Date().toISOString()
			setSeats(
				lineupStore.set(
					leagueKey,
					res.players
						.filter(y => y.slot)
						.map(y => ({ slot: y.slot!, name: y.name, positions: y.positions, team: y.team })),
					at
				)
			)
			// the reader's own note, because it is the one that knows what happened:
			// which platform, how many rows, and whether the seats came with them
			setPullNote(
				res.note +
					(missed.length ?
						` ${missed.length} not in this capture, add by hand: ${missed.join(", ")}.`
					:	"")
			)
		} catch (e) {
			setPullNote(e instanceof ApiError ? e.message : String(e))
		} finally {
			setPulling(false)
		}
	}

	useEffect(() => {
		if (!leagueKey) return
		setSeats(lineupStore.of(leagueKey))
	}, [leagueKey])

	useEffect(() => {
		const id = league?.meta.league_id
		if (!id || league?.meta.platform !== "yahoo") return
		let live = true
		api.available(String(id))
			.then(p => live && setPool(new Set(p.players.map(x => normalizeName(x.name)))))
			.catch(() => live && setPool(null))
		return () => {
			live = false
		}
	}, [league?.meta.league_id, league?.meta.platform])

	/**
	 * What to add and what to drop, from the same analysis the board runs on.
	 *
	 * `src/auto/plan.ts` has decided this since the autonomous runner shipped: it is
	 * pure, it is covered by 75 assertions, and until now nothing in the browser
	 * could reach it. It needs three things this page did not have — your seats as
	 * the platform renders them, the free agents you can actually add, and the
	 * league's real roster shape — and now has all three.
	 *
	 * Fed the FORTNIGHT board deliberately. `DEFAULTS` (keepFloor 25, minGain 5) are
	 * absolute point quantities and were measured against that horizon; handing them
	 * the current scoring period, which tops out around a fifth of the scale, makes
	 * the planner mute by construction rather than cautious.
	 *
	 * `railViolations` re-checks the finished plan against its own rules, exactly as
	 * `src/auto/run.ts` does, and anything it returns is a bug rather than a warning
	 * — so the card withholds the plan and says so instead of showing a move that
	 * broke a rail.
	 */
	const advice = useMemo((): { plan: Plan; rails: string[] } | null => {
		if (!league || !seats?.spots.length || !pool?.size || league.meta.max_teams === null) return null
		const input = {
			roster: seats.spots.map(sp => ({
				slot: sp.slot,
				name: sp.name,
				positions: sp.positions,
				team: sp.team ?? null,
				status: ""
			})),
			rated,
			availableNames: pool,
			shape: {
				slots: league.roster.slots,
				slot_order: league.roster.slot_order,
				slot_accepts: league.roster.slot_accepts
			},
			options: DEFAULTS
		}
		try {
			const out = plan(input)
			return { plan: out, rails: railViolations(out, input) }
		} catch {
			// a planner that throws is a bug, and a card that renders half a plan is
			// worse than one that renders none
			return null
		}
	}, [league, seats, pool, rated])

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
					and then his projected points. Saved in this browser, per league.
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
				{leagueId && (
					<div className="pull-roster">
						{/* The league says which team is yours only when its URL carried one.
						    Where it did not, ASK — hiding the button left Sleeper users with
						    no way to reach this at all. */}
						{!teamId && (
							<label className="ctl">
								<span>
									{platform === "sleeper" ?
										"Your roster number in this league"
									:	"Your team number in this league"}
								</span>
								<input
									type="text"
									data-ctl="read-team-id"
									value={teamEntry}
									placeholder={platform === "sleeper" ? "1" : "8"}
									onChange={e => setTeamEntry(e.currentTarget.value)}
								/>
							</label>
						)}
						<button
							type="button"
							className="primary"
							disabled={pulling || !readTeamId}
							onClick={() => void pullRoster()}
						>
							{pulling ?
								"Reading…"
							: owned.length ?
								`Re-read my roster from ${platformName}`
							:	`Read my roster from ${platformName}`}
						</button>
						<span className="sub">
							{pullNote ??
								(!readTeamId ?
									platform === "sleeper" ?
										`Sleeper's league URL doesn't say which team is yours. Its roster number is the ` +
										`small one beside your team. Sleeper runs no fantasy baseball, so a Sleeper ` +
										`league will say what sport it is rather than hand back the wrong players.`
									:	`This league's URL didn't say which team is yours, so ${platformName} needs the ` +
										`number to read it.`
								:	"Only publicly-viewable leagues can be read without signing in.")}
						</span>
					</div>
				)}
				<div className="trade-search">
					<label className="ctl grow">
						<span>Or add a player you own</span>
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

			<LineupCard league={league} lineup={lineup} count={mine.length} barMen={barMen} />
			<AdviceCard advice={advice} seats={seats} pool={pool} platform={league.meta.platform ?? null} />

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

/**
 * The add/drop the analysis actually recommends.
 *
 * Every other card on this page prices something you propose. This is the only one
 * that proposes something itself, and it is the reason the roster read exists.
 *
 * It shows the planner's own reasoning rather than a verdict: the gain, the man
 * going out and the man coming in with the scores that decided it, and the notes
 * saying what was considered and declined. `skipped` is printed too — a plan that
 * silently ignored a candidate would be indistinguishable from one that never saw
 * him.
 */
const AdviceCard = ({
	advice,
	seats,
	pool,
	platform
}: {
	advice: { plan: Plan; rails: string[] } | null
	seats: StoredLineup | null
	pool: Set<string> | null
	platform: string | null
}) => {
	if (!seats?.spots.length)
		return (
			<section className="card full advice">
				<h2>What to add and drop</h2>
				<p className="empty">
					Read your roster above and this fills in. It needs the seats your league has
					you in, not just who you own, because what to start and what to drop both
					turn on where a man currently sits.
				</p>
			</section>
		)
	if (!pool?.size)
		return (
			<section className="card full advice">
				<h2>What to add and drop</h2>
				<p className="empty">
					{platform === "yahoo" ?
						"Your league's free agent list couldn't be read, so there is nobody to " +
						"recommend adding. Only publicly-viewable Yahoo leagues can be read " +
						"without signing in, and this needs the local server."
					:	"Reading the free agent list only works for publicly-viewable Yahoo " +
						"leagues right now, so there is nobody to recommend adding here."}
				</p>
			</section>
		)
	if (!advice) return null
	const { plan: p, rails } = advice
	// A rail violation is a bug in the planner, not advice to weigh. run.ts prints
	// nothing when one fires and neither does this.
	if (rails.length)
		return (
			<section className="card full advice">
				<h2>What to add and drop</h2>
				<ul className="notes warn">
					{rails.map(r => (
						<li key={r}>{r}</li>
					))}
				</ul>
				<p className="sub">
					The plan broke one of its own rules, so it is withheld rather than shown.
				</p>
			</section>
		)
	return (
		<section className="card full advice">
			<h2>What to add and drop</h2>
			<p className="sub">
				From your seats as read {seats.at.slice(0, 10)}, the fortnight board, and your
				league&rsquo;s own free agents. Nothing here is executed — it is a
				recommendation to review.
			</p>
			{p.moves.length ?
				<ul className="advice-moves">
					{p.moves.map(m => (
						<li key={`${m.add}-${m.drop}`}>
							<span className="advice-gain">+{m.gain}</span>
							<span className="advice-swap">
								<b>{m.add}</b> <span className="advice-score">{m.addScore}</span>
								<span className="advice-arrow"> for </span>
								<b>{m.drop}</b> <span className="advice-score">{m.dropScore}</span>
							</span>
							<span className="advice-reason">{m.reason}</span>
						</li>
					))}
				</ul>
			:	<p className="empty">No move clears the bar.</p>}
			{/* The planner explains every move it DIDN'T make, one line per player, and
			    on a full roster that is sixteen near-identical sentences burying the two
			    it did. They are the honest reasoning and none is dropped — they are just
			    a click down, where the moves are the headline. Folded wholesale rather
			    than grouped by matching their prose: a UI that keys on the wording of an
			    engine string breaks silently the day that string is reworded. */}
			{p.notes.length > 0 && (
				<details className="advice-notes">
					<summary>
						{p.notes.length === 1 ? "Why one other move wasn’t made" : (
							`Why ${p.notes.length} other moves weren’t made`
						)}
					</summary>
					<ul className="notes">
						{p.notes.map(n => (
							<li key={n}>{n}</li>
						))}
					</ul>
				</details>
			)}
			{p.skipped.length > 0 && (
				<details className="advice-skipped">
					<summary>{p.skipped.length} considered and passed over</summary>
					<ul className="notes">
						{p.skipped.map(x => (
							<li key={x}>{x}</li>
						))}
					</ul>
				</details>
			)}
		</section>
	)
}

/** What you actually start. Every spot is accounted for out loud: filled by you,
 *  covered off the wire, or empty — and an empty one is a hole, not a zero. */
const LineupCard = ({
	league,
	lineup,
	count,
	barMen
}: {
	league: League
	lineup: Lineup
	count: number
	/** Who each slot's replacement bar actually is, so a spot the wire covers can
	 *  name him instead of leaving the reader to guess. */
	barMen: Map<string, { player: { name: string } }> | null
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
									/* This said "best free agent at OF", which nothing had checked: the
									   bar is the (teams x seats)-th best eligible player in the whole
									   pool and he may well be on somebody's roster. It also raised the
									   one question the card could not answer — WHICH free agent — so it
									   names him and claims only what is true of him. */
									<em
										title={
											`This spot is priced at replacement level for ${s.slot}: what the ` +
											`${league.meta.max_teams}-team-deep best eligible ${s.slot} projects. ` +
											`Nobody you own beats that here. He is not checked against your ` +
											`league's wire, so he may already be rostered.`
										}
									>
										replacement {s.slot}
										{barMen?.get(s.slot) && ` · ${barMen.get(s.slot)!.player.name}`}
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
