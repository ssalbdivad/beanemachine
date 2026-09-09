import { useEffect, useMemo, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import {
	evaluateTrade, replacementBySlot, replacementPlayerBySlot,
	startingLineup, type Lineup, type Start, type TradeVerdict
} from "../engine/trade.ts"
import type { League } from "../schema.ts"
import { canReadPool, api, ApiError } from "./api.ts"
import { pool as poolStore } from "./pool.ts"
import { roster as store, rosterKey } from "./roster.ts"
import { lineupStore, type StoredLineup } from "./lineup.ts"
import { playersInText } from "../data/paste.ts"
import { plan, railViolations, DEFAULTS, type Plan } from "../auto/plan.ts"
import "./trade.css"
import { tradesClosed } from "./panels.tsx"
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
	/** Takes the reader to the card that actually answers "what should I add" — this
	 *  page used to answer it too, worse, and the two could disagree. */
	onOpenBoard: () => void
}

export const Trade = ({ snapshot, league, leagueKey, error, onOpenBoard }: TradeProps) => {
	const { rated, scored } = useBoard(snapshot, league, TRADE_FILTERS)
	const [owned, setOwned] = useState<string[]>([])
	const [storeError, setStoreError] = useState<string | null>(null)
	const [give, setGive] = useState<string[]>([])
	const [take, setTake] = useState<string[]>([])
	const [pasted, setPasted] = useState("")
	const [wirePasted, setWirePasted] = useState("")
	const [wireNote, setWireNote] = useState<string | null>(null)
	const [pasteNote, setPasteNote] = useState<string | null>(null)
	const [ownQuery, setOwnQuery] = useState("")
	const [takeQuery, setTakeQuery] = useState("")
	/** Narrows the give-up side. Separate from `ownQuery`, which searches all of
	 *  baseball to ADD to your team; this one only ever looks at players you hold. */
	const [giveQuery, setGiveQuery] = useState("")

	// A team belongs to one league, so changing leagues loads that league's team and
	// abandons a half-built offer rather than re-pricing it against other slots.
	useEffect(() => {
		setGive([])
		setTake([])
		setGiveQuery("")
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

	/**
	 * The free agents you could actually add.
	 *
	 * The board has fetched this for a while to power its "free agents only" filter;
	 * this page never had it, which is why it could price a trade but not propose a
	 * pickup. An add/drop plan is meaningless without it — every candidate would be
	 * somebody already on a roster.
	 */
	const [pool, setPool] = useState<Set<string> | null>(null)
	/**
	 * Your league's own wire, as a test the engine can apply to any rated player.
	 *
	 * `pool` is the free-agent list read off your platform, keyed by normalised name
	 * because platform ids are each platform's own. Null until it loads, and null
	 * forever on a platform no browser can read — and null is the signal that puts
	 * the two functions below back on their estimate.
	 */
	/** Whether this league still takes trades — see `tradesClosed`. */
	const [showClosedDeal, setShowClosedDeal] = useState(false)
	const tradeWindow = useMemo(
		() => tradesClosed(league, new Date().toISOString().slice(0, 10)),
		[league]
	)
	const gettable = useMemo(
		() =>
			pool?.size ?
				(r: { player: { name: string } }) => pool.has(normalizeName(r.player.name))
			:	undefined,
		[pool]
	)
	// Every startable slot's bar. With the wire loaded this is the best man actually
	// on it; without, the (teams x seats)-th best player anywhere, which is a guess
	// at who would be left. Rebuilt only when the pool or the league does.
	const bars = useMemo(
		() =>
			league && league.meta.max_teams !== null ?
				replacementBySlot(league, rated, league.meta.max_teams, gettable)
			:	null,
		[league, rated, gettable]
	)
	// and WHO those men are, best first, so two seats covered off the wire name two
	// different people rather than printing one man twice
	const barMen = useMemo(
		() =>
			league && league.meta.max_teams !== null ?
				replacementPlayerBySlot(league, rated, league.meta.max_teams, gettable)
			:	null,
		[league, rated, gettable]
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
			teams: league.meta.max_teams,
			// the same wire the lineup card was priced against, or the verdict's "before"
			// is a different team from the one on screen
			gettable
		})
	}, [league, mine, give, take, byKey, rated, gettable])

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
	const [pulling, setPulling] = useState(false)
	const [pullNote, setPullNote] = useState<string | null>(null)
	const leagueId = league?.meta.league_id ?? null
	const teamId = league?.meta.team_id ?? null
	const platform = league?.meta.platform ?? "yahoo"
	const platformName = platform === "espn" ? "ESPN" : "Yahoo"
	/**
	 * Which team in the league is yours, when the league URL never said.
	 *
	 * Yahoo puts the team number in the URL you pasted and ESPN puts it in
	 * `teamId=`, so `team_id` is usually already known — but an ESPN league URL
	 * without `teamId=` is common, and this card used to be hidden outright unless
	 * `team_id` existed, which meant those users could never reach the button at
	 * all. So where the URL did not say, it is ASKED for rather than guessed.
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

	/**
	 * Read the team out of whatever he pasted.
	 *
	 * The reason this exists rather than another button that reads Yahoo: on
	 * 2026-09-09 the Yahoo read returned 25 free agents instead of 150, then none,
	 * then "Request denied", while the page went on offering to do it. A paste cannot
	 * be revoked. The browser doing the reading is his, already signed in, and not
	 * rate-limited as a scraper because it is not one — and it works on PRIVATE
	 * leagues, which is most leagues and which nothing here has ever reached.
	 *
	 * The seats come with it where the paste carried them, which is what makes the
	 * daily diff on Recommendations work: a roster page prints the slot to the left
	 * of each name, and `playersInText` keeps it.
	 */
	/**
	 * The free-agent list, pasted.
	 *
	 * Without this the wire is an ownership ESTIMATE for anybody on Yahoo, because
	 * Yahoo will not answer a browser and answers a server only when it feels like
	 * it. Pasting the league's own free-agent page replaces the estimate with the
	 * real list, from the one browser that is allowed to see it — and, like the
	 * roster paste, it works on a private league.
	 *
	 * Stored in the same place a server read would land, with `positionsRead` left
	 * empty and no `positionsRequested`: `poolIsPartial` reads that as "cannot tell"
	 * rather than as a throttled sweep, which is the truth. A human pasted a page; he
	 * knows what he copied and nothing here should second-guess him.
	 */
	const readWirePaste = () => {
		if (!leagueKey || !snapshot || !leagueId) return
		const found = playersInText(wirePasted, snapshot.players)
		if (!found.players.length) {
			setWireNote(
				"No players found in that. Open your league's free-agent or players page, " +
					"select all of it, and paste — the names are what this matches on."
			)
			return
		}
		const byId = new Map(snapshot.players.map(pl => [pl.id, pl]))
		poolStore.set(leagueKey, {
			at: new Date().toISOString(),
			leagueId,
			players: found.players.map(f => ({
				yahooId: String(f.id),
				name: f.name,
				team: byId.get(f.id)?.team ?? null,
				positions:
					snapshot.eligibility?.[String(f.id)] ??
					(byId.get(f.id)?.position ? [byId.get(f.id)!.position!] : [])
			})),
			positionsRead: [],
			note: `Pasted from your league's own free-agent page: ${found.players.length} players.`
		})
		setWireNote(
			`Found ${found.players.length} free agent${found.players.length === 1 ? "" : "s"}. ` +
				`Recommendations will use this exact list instead of estimating who is taken.`
		)
		setWirePasted("")
	}

	const readPaste = () => {
		if (!leagueKey || !snapshot) return
		const found = playersInText(pasted, snapshot.players)
		const byId = new Map(snapshot.players.map(pl => [pl.id, pl]))
		if (!found.players.length) {
			setPasteNote(
				"No players found in that. Select your whole roster page — the names are what " +
					"this matches on, so extra columns and adverts do no harm."
			)
			return
		}
		const keys = found.players.flatMap(f =>
			rated.filter(r => normalizeName(r.player.name) === normalizeName(f.name)).map(r => rosterKey(r.player))
		)
		persist(() => store.set(leagueKey, [...new Set(keys)]))
		const withSeats = found.players.filter(f => f.slot)
		if (withSeats.length)
			setSeats(
				lineupStore.set(
					leagueKey,
					withSeats.map(f => ({
						slot: f.slot!,
						name: f.name,
						/**
						 * The league's own eligibility where the sweep reached him, and his
						 * primary position where it did not.
						 *
						 * The map covers 328 players, not all 1,435, and an empty list means
						 * "no slot can be proven legal for him" — so a pasted roster came back
						 * with every man unseatable and a lineup projecting zero. The primary
						 * position is a weaker claim and it is the same fallback the board
						 * already makes; stating it is better than seating nobody.
						 */
						positions:
							snapshot.eligibility?.[String(f.id)] ??
							(byId.get(f.id)?.position ? [byId.get(f.id)!.position!] : []),
						team: byId.get(f.id)?.team ?? null
					})),
					new Date().toISOString()
				)
			)
		setPasteNote(
			`Found ${found.players.length} player${found.players.length === 1 ? "" : "s"}` +
				(withSeats.length ?
					`, ${withSeats.length} with the seat they were in — the daily lineup on Recommendations can diff against that.`
				:	". No seats were in that text, so Recommendations will show the lineup to set rather than the changes to make.") +
				(found.ambiguous.length ?
					` Two different players share ${found.ambiguous.join(" and ")}, so neither was added — search for the one you own below.`
				:	"")
		)
		setPasted("")
	}

	useEffect(() => {
		if (!leagueKey) return
		setSeats(lineupStore.of(leagueKey))
	}, [leagueKey])

	useEffect(() => {
		const id = league?.meta.league_id
		if (!id || !canReadPool(league?.meta.platform)) return
		let live = true
		api.available(String(id), {
			platform: league?.meta.platform,
			season: league?.meta.season,
			sport: league?.meta.sport
		})
			.then(p => live && setPool(new Set(p.players.map(x => normalizeName(x.name)))))
			.catch(() => live && setPool(null))
		return () => {
			live = false
		}
	}, [league?.meta.league_id, league?.meta.platform, league?.meta.season])

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
	/** Men this capture could not project. Named in the fold's summary because a
	 *  roster whose count looks right while two of it are unpriceable is the one
	 *  thing a collapsed list could hide. */
	const unrateable = mine.filter(r => !r.rateable).length
	const lineup = startingLineup(league, mine, bars)
	/** Who your lineup actually starts. The Verdict already reduces over this to
	 *  say a departing bench man cost nothing; the deal side says it beforehand,
	 *  which is when it can change the offer you build. */
	const starting = startingKeys(lineup)
	const giveNeedle = giveQuery.trim().toLowerCase()
	const giveable = mine
		.slice()
		.sort((a, b) => b.points - a.points)
		.filter(r => !giveNeedle || r.player.name.toLowerCase().includes(giveNeedle))
	/**
	 * The give-up side, split by the one thing that decides who you can spare.
	 *
	 * A man who is not in your starting lineup costs the lineup nothing to trade —
	 * the Verdict card already says exactly that, but only once you have picked him.
	 * On the shipped team it is 12 of 24, so the split covers half the roster and the
	 * wall's order answers "who can I lose" before you click anything.
	 *
	 * Three groups, not two, because an unrateable player is not a spare one. On the
	 * shipped team Byron Buxton and Nick Kurtz have no projection in this capture, so
	 * they are absent from the starting lineup for a reason the model never reached:
	 * it did not weigh them and find them wanting, it could not weigh them. Filed
	 * under "costs you nothing" they would have read as the cheapest men to trade.
	 */
	const giveGroups = [
		{
			key: "spare",
			men: giveable.filter(r => r.rateable && !starting.has(rosterKey(r.player))),
			label: (n: number) =>
				`${n} not in your starting lineup — giving one up costs the lineup nothing`
		},
		{
			key: "starting",
			men: giveable.filter(r => r.rateable && starting.has(rosterKey(r.player))),
			label: (n: number) => `${n} you are starting — trading one leaves a spot to refill`
		},
		{
			key: "unrated",
			men: giveable.filter(r => !r.rateable),
			label: (n: number) =>
				`${n} with no projection in this capture — what giving one up costs is unknown, not zero`
		}
	].filter(g => g.men.length > 0)
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
					Who you own in {league.meta.league_name ?? leagueKey}. Read it off the platform
					or add men by name; either way it is saved in this browser, per league, and
					everything below is priced against it.
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
				{/**
				  * The route that cannot be taken away.
				  *
				  * It leads, above the platform read, because the platform read is the one
				  * that stops working: on 2026-09-09 the Yahoo sweep returned a sixth of
				  * the wire, then none of it, then "Request denied", while this page went
				  * on offering the button. A paste is the reader's own signed-in browser
				  * doing the reading, it is not rate-limited because it is not a scraper,
				  * and it reaches PRIVATE leagues — which is most leagues, and which
				  * nothing else here has ever reached.
				  */}
				<div className="paste-roster">
					<h3>Paste your roster</h3>
					{/* Named steps, and the actual keystrokes. "Select the page" assumes the
					    reader knows to select-all, which is the step people miss — and the page
					    to open has a different name on every platform, so all four are said. */}
					<ol className="paste-how">
						<li>
							Open your team on your fantasy site — <b>My Team</b> on Yahoo and ESPN,{" "}
							<b>Roster</b> on Sleeper, CBS and Fantrax.
						</li>
						<li>
							Select the whole page: <kbd>Ctrl</kbd>+<kbd>A</kbd> (<kbd>⌘</kbd>+
							<kbd>A</kbd> on a Mac), then <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy.
						</li>
						<li>
							Click in the box below and paste, then press <b>Read that</b>.
						</li>
					</ol>
					<p className="sub">
						Extra columns, adverts and menus do no harm — only the names are read. It
						works on a private league, and it brings the seat each man is in with it,
						which is what lets Recommendations show the changes to make.
					</p>
					<textarea
						data-ctl="paste-roster"
						value={pasted}
						onChange={e => setPasted(e.currentTarget.value)}
						placeholder={"C\tBen Rice NYY - C,1B\n1B\tJonathan Aranda TB - 1B\n…"}
						rows={4}
						aria-label="Paste your roster page here"
					/>
					<button type="button" className="chip-btn" onClick={readPaste} disabled={!pasted.trim()}>
						Read that
					</button>
					{pasteNote && <p className="sub paste-note">{pasteNote}</p>}
				</div>
				{/* The other half, and the one that turns an estimate into a fact. Without it
				    "who is available" is inferred from how widely a man is rostered across all
				    of Yahoo; with it, it is his league's own list. */}
				<div className="paste-roster">
					<h3>Paste your free agents</h3>
					<p className="sub">
						Optional, and worth a minute: without it, who is available is{" "}
						<b>estimated</b> from how widely each player is rostered. Open your
						league&rsquo;s <b>Players</b> or <b>Free Agents</b> page, set the filter to
						available players, select all and paste. Do it once a week — anyone added or
						dropped since is not in it.
					</p>
					<textarea
						data-ctl="paste-wire"
						value={wirePasted}
						onChange={e => setWirePasted(e.currentTarget.value)}
						placeholder={"Shea Langeliers ATH - C\nTyler Stephenson CIN - C\n…"}
						rows={4}
						aria-label="Paste your league's free-agent page here"
					/>
					<button
						type="button"
						className="chip-btn"
						onClick={readWirePaste}
						disabled={!wirePasted.trim()}
					>
						Read that
					</button>
					{wireNote && <p className="sub paste-note">{wireNote}</p>}
				</div>
				{leagueId && (
					<div className="pull-roster">
						{/* The league says which team is yours only when its URL carried one.
						    Where it did not, ASK — hiding the button left every ESPN user whose
						    URL had no `teamId=` with no way to reach this at all. */}
						{!teamId && (
							<label className="ctl">
								<span>Your team number in this league</span>
								<input
									type="text"
									data-ctl="read-team-id"
									value={teamEntry}
									placeholder="8"
									onChange={e => setTeamEntry(e.currentTarget.value)}
								/>
							</label>
						)}
						{/* No longer `primary`. This route works when the platform allows it and
						    stops when it does not — on 2026-09-09 Yahoo answered a sweep with a
						    sixth of the wire, then nothing, then "Request denied" — and a button
						    styled as the main way in was making a promise this app cannot keep.
						    The paste above it is the one that always works. */}
						<button
							type="button"
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
									`This league's URL didn't say which team is yours, so ${platformName} needs the ` +
									`number to read it.`
								:	"Only publicly-viewable leagues can be read this way, and the platform " +
									"can refuse or throttle it at any time — Yahoo does. If it fails or comes " +
									"back short, paste instead: that always works and reaches private leagues " +
									"too.")}
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
				{/*
				 * FOLDED, not cut. Measured 2026-09-04 on the shipped league (24 players,
				 * 1280x1000): this list was 899px of an 3487px page, and every one of the
				 * 24 men in it is shown again — in the seat he actually holds — by
				 * "Your starting lineup" directly below. A flat copy of a list the next
				 * card arranges is the least informative 900px on the page, and it was
				 * pushing the one card that RECOMMENDS something to y=1912.
				 *
				 * It is still all here and one click away, because it is the only place a
				 * man can be removed by hand, and the summary carries the two counts the
				 * reader would otherwise have to open it to get.
				 */}
				<div className="trade-owned">
					{mine.length ?
						<details className="trade-owned-fold">
							{/* One line. The disclosure triangle already says it opens; a summary
							    that wrapped to two rows was spending the height the fold saved. */}
							<summary>
								{mine.length} player{mine.length === 1 ? "" : "s"} on this team
								{unrateable > 0 && ` · ${unrateable} with no projection`}
							</summary>
							{mine
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
								))}
						</details>
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

			{/*
			 * The recommendation comes BEFORE the lineup, and both come before the deal.
			 *
			 * This is the only card on the page that proposes something rather than
			 * pricing something you proposed, and it was third. Measured 2026-09-04 on
			 * the shipped league at 1280x1000 it opened at y=1912 — below two screens of
			 * a roster you already knew and a lineup you could see on Yahoo — while the
			 * page's own answer ("+33.71 Grant Taylor for Randy Vásquez") sat there.
			 * Ordered by what each card answers without being asked, it goes first.
			 */}
			{/* "What to add and drop" was a second, worse answer to the question the
			    decision card on Recommendations already answers. It required the SEATS
			    your league has you in and an exact free-agent list, so a visitor who had
			    just typed his team in here was told to go and read a roster, and a Yahoo
			    user was told the page "needs the local server" — the sentence this whole
			    audit exists to delete. The card needs neither: it works from the men you
			    own and estimates availability from ownership when nothing has read the
			    wire. One question, one answer, and it is the better one. */}
			<section className="card full advice">
				<h2>What to add and drop</h2>
				<p className="sub">
					On <b>Recommendations</b>, at the top — it names both sides of every move and
					works from whatever this browser knows, including a team you entered by hand.
				</p>
				<button type="button" className="chip-btn" onClick={onOpenBoard}>
					Take me there
				</button>
			</section>
			<LineupCard
				league={league}
				lineup={lineup}
				count={mine.length}
				barMen={barMen}
				wireRead={!!gettable}
			/>

			{/* The two sides are symmetric now. The right has always been a search box;
			    the left was every player you own rendered at once — 24 name-only chips
			    in seven rows on the shipped league, ~280px of wall, with nothing on any
			    of them to tell you which one you could stand to lose. Same set, still
			    all reachable, but filterable and carrying the number the choice turns
			    on. */}
			{/* Retired rather than removed once the league's own deadline has passed. The
			    evaluator still works and the code is still here; what is gone is the
			    invitation to use it on a league that will not accept the deal. */}
			{tradeWindow.closed && !showClosedDeal ?
				<section className="card full trade-deal trade-closed">
					<h2>The deal</h2>
					<p className="sub">
						Your league stopped taking trades on <b>{tradeWindow.on}</b>, so a deal priced
						here could not be made. Your roster and lineup above are still live, and adds
						and drops are on <b>Recommendations</b>.
					</p>
					{/* A disclosure, not a wall. The default is clean because the deadline has
					    passed; the evaluator still works and a reader with a reason to run it
					    — a keeper league, a dynasty, a what-if — is one click from it. */}
					<button type="button" className="chip-btn" onClick={() => setShowClosedDeal(true)}>
						Price one anyway
					</button>
				</section>
			:	<section className="card full trade-deal">
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
							<>
								{/* Mirrors "Search anyone" opposite. 24 chips is a wall to read and a
								    trivial list to filter, and the reader building an offer already
								    has a name in mind. */}
								<label className="ctl grow">
									<span>Filter your players</span>
									<input
										type="text"
										data-ctl="give-search"
										value={giveQuery}
										placeholder="Player name…"
										onChange={e => setGiveQuery(e.currentTarget.value)}
									/>
								</label>
								{/* The chips stay bare names. Putting each man's bscore in the label made every
								    chip about twice as wide and the card 694px tall against 395 — more
								    information, more wall. The number rides his title, and "My team" two cards
								    up already lists all 24 of them with bscore and projected points beside the
								    name. What the wall gains here is ORDER: the ones you can spare, first. */}
								{giveGroups.map((g, i) => (
									// the gap between groups is what makes them read as groups, and
									// trade.css is not this change's file
									<div
										key={g.key}
										className={`give-group give-${g.key}`}
										style={i ? { marginTop: 14 } : undefined}
									>
										<p className="tiny-note">{g.label(g.men.length)}</p>
										<div className="picks">
											{g.men.map(r => {
												const k = rosterKey(r.player)
												return (
													<button
														key={k}
														type="button"
														className={`chip-btn${give.includes(k) ? " on" : ""}`}
														aria-pressed={give.includes(k)}
														title={
															g.key === "unrated" ?
																"No projection was possible for him over this horizon, so he starts nowhere and counts in no total here. What giving him up costs cannot be read off a number nothing produced."
															: g.key === "spare" ?
																`${pts(r.points)} projected points, bscore ${r.bscore}. He is not in your starting lineup, so trading him changes nothing below unless somebody else moves.`
															:	`${pts(r.points)} projected points, bscore ${r.bscore}. He is starting for you, so trading him leaves a spot to refill.`
														}
														onClick={() =>
															setGive(cur => (cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k]))
														}
													>
														{r.player.name}
													</button>
												)
											})}
										</div>
									</div>
								))}
								{!giveable.length && <p className="empty">Nobody on your team matches that.</p>}
							</>
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
			}

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

/** What you actually start. Every spot is accounted for out loud: filled by you,
 *  covered off the wire, or empty — and an empty one is a hole, not a zero. */
const LineupCard = ({
	league,
	lineup,
	count,
	barMen,
	wireRead
}: {
	league: League
	lineup: Lineup
	count: number
	/** Who each slot's replacement bar actually is, best first, so a spot the wire
	 *  covers can name him instead of leaving the reader to guess — and so two seats
	 *  of the same slot name two different men. */
	barMen: Map<string, { player: { name: string } }[]> | null
	/** True when `barMen` came from the league's own free-agent list rather than
	 *  from the whole-pool estimate. It decides whether this card may call these men
	 *  free agents, which is the one thing the estimate can never support. */
	wireRead: boolean
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
				{/* Seat number WITHIN its slot, so the second Util spot names the second
				    man on the wire. The card used to read one name per slot and print
				    it in every seat of that slot, which put the same player in both
				    Util spots — a lineup no league would accept. */}
				<div className="lineup">
					{lineup.starters.map((s, i) => {
						const nth = lineup.starters.slice(0, i).filter(x => x.slot === s.slot).length
						const bar = barMen?.get(s.slot)?.[nth]
						return (
						<div className={`lineup-row ${SOURCE_CLASS[s.source]}`} key={`${s.slot}-${i}`}>
							<span className="code">{s.slot}</span>
							<span className="lineup-who">
								{s.player ?
									s.player.player.name
								: s.source === "replacement" ?
									/* Two different claims, and the card may only make the one its data
									   supports. With the league's wire read, this man IS free and the
									   card says so. Without it he is the (teams x seats)-th best
									   eligible player anywhere — an estimate of who would be left — and
									   he may well be on somebody's roster, which is what the card said
									   about every spot before the wire was ever consulted. */
									<em
										title={
											wireRead ?
												`Free in your league right now, read off its own free-agent list: ` +
												`the best ${s.slot} on the wire. Nobody you own beats him here.`
											:	`This spot is priced at replacement level for ${s.slot}: what the ` +
												`${league.meta.max_teams}-team-deep best eligible ${s.slot} projects. ` +
												`Nobody you own beats that here. He is not checked against your ` +
												`league's wire, so he may already be rostered.`
										}
									>
										{wireRead ? "free agent" : "replacement"} {s.slot}
										{bar && ` · ${bar.player.name}`}
									</em>
								:	<em className="hole-name" title="No price is known for this spot — nobody in the whole pool is eligible here, so there is no freely available body to price it at.">
										nothing can fill this
									</em>
								}
							</span>
							<span className="lineup-pts">{s.source === "empty" ? "—" : pts(s.points)}</span>
						</div>
					)
					})}
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
