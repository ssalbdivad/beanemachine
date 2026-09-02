import { type } from "arktype"
import { useEffect, useMemo, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { recommend, type Candidate, type DraftAdvice } from "../engine/draft.ts"
import type { League } from "../schema.ts"
import { ApiError } from "./api.ts"
import "./draft.css"
import { roster as team, rosterKey } from "./roster.ts"
import { DEFAULT_FILTERS, useBoard, type Filters } from "./useBoard.ts"

/**
 * Draft mode, in front of a human.
 *
 * The board ranks the whole league; this ranks what is left, against the spots you
 * have not filled. `src/engine/draft.ts` does the arithmetic — every number here is
 * a marginal one, so the fourth outfielder really does read as worth nothing — and
 * this page's job is to make the two things a draft needs cheap: marking players
 * off the board as they go, and saying which spot punishes waiting.
 *
 * Nothing on this page guesses at a pick nobody has made. A player is on the board
 * until you say he isn't, the cliff is measured on who is actually left, and a
 * stored id the snapshot has no row for is named rather than dropped.
 */

/**
 * A draft is a season-long decision, so it is priced over the rest of the season
 * rather than the standing fortnight the board opens on. That is the same choice
 * the board's "stash" mode makes and for the same reason: a two-start week wins a
 * week, and a rising role wins a September.
 */
const DRAFT_FILTERS: Filters = { ...DEFAULT_FILTERS, mode: "stash" }

const pts = (v: number) => v.toFixed(1)
const total = (v: number) => v.toFixed(2)
const signed = (v: number) => `${v > 0 ? "+" : ""}${total(v)}`

/** The board is stored the way a roster is — this browser, per league, validated
 *  going in and coming out — but under its own key. Clearing a draft must never
 *  reach into the team `roster.ts` keeps, and the two hold different things: who
 *  is gone, and who is yours. Ids are written in `rosterKey`'s format, so a player
 *  drafted here IS the player the trade page prices, with no translation. */
const STORE_KEY = "beanemachine:draft"

class DraftError extends ApiError {}

const Stored = type({ "[string]": type(/^\d+:(hitting|pitching)$/).array() })
type Stored = typeof Stored.infer

const storage = (): Storage => {
	try {
		return window.localStorage
	} catch (e) {
		throw new DraftError(
			`This browser won't let the page use local storage (${(e as Error).message}), so ` +
				`there is nowhere to keep a draft board. A private window usually does this.`
		)
	}
}

const read = (): Stored => {
	const raw = storage().getItem(STORE_KEY)
	if (raw === null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		throw new DraftError(
			`The draft board in this browser ("${STORE_KEY}") isn't valid JSON: ${(e as Error).message}`
		)
	}
	const out = Stored(parsed)
	// Repairing it would mean guessing which players were off the board, and a board
	// guessed wrong recommends someone who is already gone.
	if (out instanceof type.errors)
		throw new DraftError(
			`The draft board in this browser ("${STORE_KEY}") isn't a valid board:\n${out}\n` +
				`Clear it to start again.`
		)
	return out
}

const write = (next: Stored): Stored => {
	const out = Stored(next)
	if (out instanceof type.errors)
		throw new DraftError(`Refusing to store an invalid draft board:\n${out}`)
	try {
		storage().setItem(STORE_KEY, JSON.stringify(out))
	} catch (e) {
		throw new DraftError(`This browser refused to store the draft board: ${(e as Error).message}`)
	}
	return out
}

/** Every write starts from what is in storage right now — another tab may have
 *  marked a pick since this page rendered. Order is preserved because it is the
 *  draft order, which the cliff table reports back. */
const board = {
	of: (league: string): string[] => read()[league] ?? [],
	add: (league: string, key: string): string[] => {
		const stored = read()
		const gone = stored[league] ?? []
		if (gone.includes(key)) return gone
		return write({ ...stored, [league]: [...gone, key] })[league]!
	},
	remove: (league: string, key: string): string[] => {
		const stored = read()
		return write({ ...stored, [league]: (stored[league] ?? []).filter(k => k !== key) })[league]!
	},
	clear: (league: string): string[] => {
		const { [league]: _, ...kept } = read()
		write(kept)
		return []
	},
	/** The way back from a board too broken to parse — `clear` has to read the store
	 *  first so it can spare the other leagues, which is the one thing it cannot do
	 *  when the store is the problem. */
	reset: (): void => {
		try {
			storage().removeItem(STORE_KEY)
		} catch (e) {
			throw new DraftError(`This browser refused to clear the draft board: ${(e as Error).message}`)
		}
	}
}

export interface DraftProps {
	/** The captured player data the whole app ranks against. Null while it loads. */
	snapshot: Snapshot | null
	/** The league whose slots and scoring the picks are priced in. */
	league: League | null
	/** The key the league is stored under. A board is meaningless across leagues —
	 *  different slots, different scarcity — so it is kept per key. */
	leagueKey: string | null
	/** Snapshot load failure, passed straight through the way `Board` takes it. */
	error: string | null
}

export const Draft = ({ snapshot, league, leagueKey, error }: DraftProps) => {
	const { rated, scored } = useBoard(snapshot, league, DRAFT_FILTERS)
	const [gone, setGone] = useState<string[]>([])
	const [owned, setOwned] = useState<string[]>([])
	const [storeError, setStoreError] = useState<string | null>(null)
	const [query, setQuery] = useState("")

	// A board belongs to one league, so changing leagues loads that league's draft
	// rather than re-pricing a half-finished one against different slots.
	useEffect(() => {
		if (!leagueKey) {
			setGone([])
			setOwned([])
			return
		}
		try {
			setGone(board.of(leagueKey))
			setOwned(team.of(leagueKey))
			setStoreError(null)
		} catch (e) {
			setGone([])
			setOwned([])
			setStoreError(e instanceof ApiError ? e.message : String(e))
		}
	}, [leagueKey])

	const byKey = useMemo(() => new Map(rated.map(r => [rosterKey(r.player), r])), [rated])
	const resolve = (keys: string[]) => keys.flatMap(k => (byKey.has(k) ? [byKey.get(k)!] : []))
	const taken = useMemo(() => resolve(gone), [gone, byKey])
	const mine = useMemo(() => resolve(owned), [owned, byKey])
	/** Stored ids the snapshot has no row for. Reported, never dropped: a board that
	 *  silently shrank would recommend somebody who is already gone. */
	const unresolved = [...gone, ...owned].filter(k => !byKey.has(k))

	const advice = useMemo((): DraftAdvice | null => {
		if (!league || league.meta.max_teams === null || !rated.length) return null
		return recommend({ league, pool: rated, taken, mine, teams: league.meta.max_teams })
	}, [league, rated, taken, mine])

	const persist = (next: () => void) => {
		try {
			next()
			setStoreError(null)
		} catch (e) {
			setStoreError(e instanceof ApiError ? e.message : String(e))
		}
	}
	/** Off the board, by anyone. */
	const strike = (key: string) =>
		leagueKey && persist(() => setGone(board.add(leagueKey, key)))
	/** Off the board AND mine — the same team the trade page prices, so a draft
	 *  finishes with a roster rather than with a list that has to be retyped. */
	const claim = (key: string) =>
		leagueKey &&
		persist(() => {
			setGone(board.add(leagueKey, key))
			setOwned(team.add(leagueKey, key))
		})
	const undo = (key: string) =>
		leagueKey &&
		persist(() => {
			setGone(board.remove(leagueKey, key))
			setOwned(team.remove(leagueKey, key))
		})

	if (error)
		return (
			<section className="card full">
				<h2>Draft</h2>
				<p className="empty">Couldn&rsquo;t load the snapshot: {error}</p>
			</section>
		)
	if (!league || !leagueKey)
		return (
			<section className="card full">
				<h2>Draft</h2>
				<p className="empty">
					Import or configure a league first — a pick is worth what it does to the slots
					that league makes you fill.
				</p>
			</section>
		)
	if (league.meta.max_teams === null)
		return (
			<section className="card full">
				<h2>Draft</h2>
				<p className="empty">
					This league doesn&rsquo;t say how many teams are in it, and how far the board has
					to run before it reaches replacement level depends on that — so no pick has an
					honest price yet. Open <b>League setup</b> and set the team count.
				</p>
			</section>
		)
	// An unconfigured template has a roster shape but no scoring, so every player
	// projects exactly zero and every pick would look identical. Same refusal the
	// board and the trade page make.
	if (scored && !scored.hitting && !scored.pitching)
		return (
			<section className="card full">
				<h2>This league has no scoring yet</h2>
				<p className="sub">
					<b>{league.meta.league_name ?? leagueKey}</b> gives you the roster shape but not
					what each stat is worth, so every projection would score exactly zero and every
					pick would come out at +0.00. That is not a recommendation, it is a missing input.
				</p>
				<p className="sub">
					Paste your league URL above to read the real values off the platform, or open{" "}
					<b>League setup</b> and enter them.
				</p>
			</section>
		)
	if (!snapshot || !advice)
		return (
			<section className="card full">
				<h2>Draft</h2>
				<p className="empty">Loading player data…</p>
			</section>
		)

	const off = new Set([...gone, ...owned])
	const needle = query.trim().toLowerCase()
	const results =
		!needle ? []
		:	rated
				.filter(r => !off.has(rosterKey(r.player)) && r.player.name.toLowerCase().includes(needle))
				.sort((a, b) => Number(b.rateable) - Number(a.rateable) || b.points - a.points)
				.slice(0, 12)
	const spots = advice.lineup.starters.length
	const filled = advice.lineup.starters.filter(s => s.source === "roster").length
	const steepest = Math.max(...advice.cliffs.map(c => c.cliff ?? 0), 0)

	return (
		<>
			<section className="card full draft-pick">
				<h2>Your pick</h2>
				<p className="sub">
					Ranked by what each man adds to <b>your</b> starting lineup, not by who is best
					left — once your outfield is full another outfielder is worth nothing, and this
					says so. Priced over the rest of the season against the players still available.
				</p>
				{storeError && (
					<div className="draft-store-error">
						<ul className="notes warn">
							<li>{storeError}</li>
						</ul>
						{/* The message says to clear it, so the control that does has to be here:
						    a board that cannot be read also cannot be unmarked pick by pick. */}
						<button
							type="button"
							className="ghost"
							onClick={() =>
								persist(() => {
									board.reset()
									setGone([])
								})
							}
						>
							Clear the stored board
						</button>
					</div>
				)}
				{advice.pick ?
					<>
						<div className="pick-head">
							<span className={`pick-gain${advice.pick.gain > 0 ? " up" : ""}`}>
								{signed(advice.pick.gain)}
							</span>
							<span className="pick-who">
								<b>{advice.pick.player.player.name}</b>
								<span className="meta">
									<span className="code">{advice.pick.at ?? "bench"}</span>
									{advice.pick.player.player.team ?? "—"}
									{advice.pick.player.injury && (
										<em className="hurt">{advice.pick.player.injury}</em>
									)}
								</span>
							</span>
							<span className="pick-acts">
								<button
									type="button"
									className="primary"
									onClick={() => claim(rosterKey(advice.pick!.player.player))}
								>
									I took him
								</button>
								<button
									type="button"
									className="ghost"
									title="Someone else took him — off the board, not on your team"
									onClick={() => strike(rosterKey(advice.pick!.player.player))}
								>
									Gone
								</button>
							</span>
						</div>
						<p className="pick-why">{advice.explanation}</p>
						{advice.alternatives.length > 0 && (
							<>
								<h3>Next best</h3>
								<div className="alts">
									{advice.alternatives.map(c => (
										<Alt
											key={rosterKey(c.player.player)}
											c={c}
											onClaim={() => claim(rosterKey(c.player.player))}
											onStrike={() => strike(rosterKey(c.player.player))}
										/>
									))}
								</div>
							</>
						)}
					</>
				:	<p className="empty">
						There is nobody left on the board — every projectable player is either yours or
						marked taken.
					</p>
				}
				{advice.missing.length > 0 && (
					<>
						<h3>What this could not read</h3>
						<ul className="notes warn draft-missing">
							{advice.missing.map(m => (
								<li key={m}>{m}</li>
							))}
						</ul>
					</>
				)}
			</section>

			<section className="card full draft-cliffs">
				<h2>Where the cliff is</h2>
				<p className="sub">
					For every spot: the man you would take there now, the man left if he goes first,
					and the drop between them. A deep slot costs a point or two to wait on; a cliff
					costs thirty, and that is what says to take the catcher early. Everything here is
					measured on the players actually still available.
				</p>
				<div className="cliff-head">
					<span>slot</span>
					<span>you would take</span>
					<span className="r">adds</span>
					<span>then</span>
					<span className="r">drop</span>
					<span className="r">gone</span>
				</div>
				{advice.cliffs.map(c => (
					<div className="cliff-row" key={c.slot}>
						<span className="code">{c.slot}</span>
						<span className="cliff-who">
							{c.best ?
								c.best.player.player.name
							:	<em className="none">nobody left is eligible here</em>}
						</span>
						<span className="r cliff-gain">{c.best ? signed(c.best.gain) : "—"}</span>
						<span className="cliff-who next">
							{c.next ?
								c.next.player.player.name
							:	<em className="none">nobody</em>}
						</span>
						<span className="r cliff-drop">
							{c.cliff === null ?
								<span title="There is no second man at this slot, so there is no drop to measure — that is not a cliff of zero.">
									—
								</span>
							:	<>
									{total(c.cliff)}
									<i
										className="cliff-bar"
										style={{ width: `${steepest ? (c.cliff / steepest) * 100 : 0}%` }}
										aria-hidden="true"
									/>
								</>
							}
						</span>
						<span
							className="r cliff-gone"
							title={`${c.gone} eligible here are off the board, ${c.recent} of them in the last ${league.meta.max_teams} picks you marked`}
						>
							{c.gone}
							{c.recent > 0 && <b className="run"> +{c.recent}</b>}
						</span>
					</div>
				))}
				<p className="tiny-note">
					The <b>gone</b> column counts everyone eligible at that slot who is off the board,
					and the run beside it counts how many of those went in the last{" "}
					{league.meta.max_teams} picks you marked. It is an observation, not a forecast —
					nothing here guesses what the next manager does, and a run only moves a number by
					the players it actually removed.
				</p>
			</section>

			<section className="card full draft-board">
				<h2>Off the board</h2>
				<p className="sub">
					Mark players as they go. <b>Gone</b> takes someone off the board;{" "}
					<b>Mine</b> also puts him on your team — the same team the trade page prices, so a
					finished draft is a finished roster.
				</p>
				<div className="draft-search">
					<label className="ctl grow">
						<span>Mark a player taken</span>
						<input
							type="text"
							data-ctl="draft-search"
							value={query}
							placeholder="Player name…"
							onChange={e => setQuery(e.currentTarget.value)}
						/>
					</label>
					{gone.length > 0 && (
						<button
							type="button"
							className="ghost"
							onClick={() =>
								confirm(
									`Put all ${gone.length} players back on the board and drop the ` +
										`${owned.length} on your team for this league?`
								) &&
								persist(() => {
									setGone(board.clear(leagueKey))
									setOwned(team.clear(leagueKey))
								})
							}
						>
							Reset this draft
						</button>
					)}
				</div>
				{needle && (
					<div className="draft-results">
						{results.map(r => (
							<div className="draft-line" key={rosterKey(r.player)}>
								<span className="who">
									<b>{r.player.name}</b>
									<span className="meta">
										<span className="code">{r.rateable ? r.slot : (r.slots[0] ?? "—")}</span>
										{r.player.team ?? "—"}
										{r.injury && <em className="hurt">{r.injury}</em>}
									</span>
								</span>
								<span className="r proj">{r.rateable ? pts(r.points) : "no projection"}</span>
								<span className="pick-acts">
									<button type="button" className="chip-btn" onClick={() => claim(rosterKey(r.player))}>
										Mine
									</button>
									<button type="button" className="chip-btn" onClick={() => strike(rosterKey(r.player))}>
										Gone
									</button>
								</span>
							</div>
						))}
						{!results.length && (
							<p className="empty">Nobody by that name is in this capture, or he is already off the board.</p>
						)}
					</div>
				)}
				<div className="draft-gone">
					<h3>
						{gone.length} off the board · {owned.length} yours
					</h3>
					{gone.length ?
						<div className="draft-picks">
							{/* newest first: a draft is read backwards, and the last few picks are the
							    run you are trying to see */}
							{[...gone].reverse().map(k => (
								<button
									type="button"
									key={k}
									className={`chip-btn${owned.includes(k) ? " on" : ""}`}
									title="Put him back on the board"
									onClick={() => undo(k)}
								>
									{byKey.get(k)?.player.name ?? k} ×
								</button>
							))}
						</div>
					:	<p className="empty">
							Nothing is off the board yet, so every recommendation is being made against
							the whole pool.
						</p>
					}
				</div>
				{unresolved.length > 0 && (
					<ul className="notes warn draft-unresolved">
						{unresolved.map(k => (
							<li key={k}>
								{k} is marked in this draft but has no row in the current capture, so
								nothing can be projected for him. He is counted nowhere above.
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="card full draft-mine">
				<h2>What you have drafted</h2>
				<div className="draft-tally">
					<span className="draft-tally-num">{total(advice.lineup.points)}</span>
					<span className="draft-tally-unit">
						projected points · {filled} of {spots} startable spots filled by your own picks
					</span>
				</div>
				{mine.length ?
					<div className="draft-picks">
						{advice.lineup.starters
							.flatMap(s => (s.player ? [{ slot: s.slot, player: s.player }] : []))
							.map(s => (
								<span className="chip" key={rosterKey(s.player.player)}>
									<b>{s.slot}</b> {s.player.player.name}
								</span>
							))}
						{advice.lineup.bench.map(r => {
							// during a draft this is the sharper of the two: a man who starts
							// nowhere is bench depth, a man below the bar everywhere is a pick
							// spent on someone the waiver wire would have given you
							const under = advice.lineup.belowBar.some(
								b => rosterKey(b.player) === rosterKey(r.player)
							)
							return (
								<span
									className={`chip bench-chip${under ? " chip-under" : ""}`}
									key={rosterKey(r.player)}
									title={
										under ?
											"Starts nowhere, and projects below the freely available man at every " +
											"slot he can fill"
										:	"Drafted, but starts nowhere — somebody better holds every spot he can fill"
									}
								>
									<b>BN</b> {r.player.name}
								</span>
							)
						})}
					</div>
				:	<p className="empty">
						You haven&rsquo;t taken anyone yet. The spots you have not filled are priced at
						replacement level — the best man still on the board there once every one of the{" "}
						{league.meta.max_teams} teams has filled that spot — which is what makes the
						first pick&rsquo;s number mean something.
					</p>
				}
			</section>
		</>
	)
}

/** One of the next-best few: what he adds, where he would go, and the two things
 *  you can do with him. The gain is the only number that ranks him — his projected
 *  points are shown beside it because a human wants to see both. */
const Alt = ({
	c,
	onClaim,
	onStrike
}: {
	c: Candidate
	onClaim: () => void
	onStrike: () => void
}) => (
	<div className="draft-line alt">
		<span className="who">
			<b>{c.player.player.name}</b>
			<span className="meta">
				<span className="code">{c.at ?? "bench"}</span>
				{c.player.player.team ?? "—"}
				{c.player.injury && <em className="hurt">{c.player.injury}</em>}
			</span>
		</span>
		<span className={`r alt-gain${c.gain > 0 ? " up" : ""}`} title="What he adds to your starting lineup">
			{signed(c.gain)}
		</span>
		<span className="r proj" title="Projected points over the rest of the season">
			{pts(c.player.points)}
		</span>
		<span className="pick-acts">
			<button type="button" className="chip-btn" onClick={onClaim}>
				Mine
			</button>
			<button type="button" className="chip-btn" onClick={onStrike}>
				Gone
			</button>
		</span>
	</div>
)

export default Draft
