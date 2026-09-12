import { useEffect, useMemo, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { hydrate } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { isReserveSlot, ownershipCut, rateAll, slotsFor } from "../engine/bscore.ts"
import { resolvePeriod, windowFrom } from "../engine/period.ts"
import {
	activeSlots, planLineup, planSwaps, seatedInnings, DEFAULTS, type PlanInput
} from "../auto/plan.ts"
import { deriveInningsMinimum, deriveMoveLimit } from "../import.ts"
import { freshness, tab } from "./panels.tsx"
import { canReadPool, api, poolIsPartial, type AvailablePool } from "./api.ts"
import { lineupStore } from "./lineup.ts"
import { ledgerStore } from "./ledger.ts"
import { pool as poolStore } from "./pool.ts"
import { roster } from "./roster.ts"
import { normalizeName } from "./useBoard.ts"
import { andList } from "../data/names.ts"
import { useSlate } from "./useSlate.ts"
import { lastNight, useThrownInnings } from "./useActuals.ts"
import { useStored } from "./stores.ts"
import { useInjuries } from "./useInjuries.ts"
import { statusOf, lockFor, nextLock, clock, localDate, asSlateGames, type TodayStatus } from "../data/today.ts"
import "./decide.css"

/**
 * The answer, before the exploration.
 *
 * Everything else in this app ranks players. Ranking players is not a decision —
 * a decision names both sides of a swap and can be carried out in Yahoo without
 * further thought. This card is the only surface that does that, and it is at the
 * top of the page because it is the reason to open the page.
 *
 * Two decisions, in the order they have to be made:
 *
 *  · WHO STARTS. Costs nothing, is undone in one click, and in this league is made
 *    every single day — the settings page says "Weekly Deadline: Daily", which is a
 *    daily lineup lock. It goes first because a lineup change is free and a waiver
 *    claim is not.
 *  · WHAT TO ADD. Costs one of a fixed number of weekly moves and costs a player.
 *    Scored on what the lineup projects AFTERWARDS, so a man who would be added and
 *    then benched is worth nothing here, which is the truth.
 *
 * Both come from `src/auto/plan.ts`, which is the part of this project that has
 * been measured — 111 weeks across five seasons — and which until now could only
 * be run from a terminal. The page ranked; the terminal decided. This card is the
 * decision, on the page.
 */
/** What the resolved period IS, in the reader's words rather than the type's. */
/**
 * How old the read is, in the reader's terms.
 *
 * The card diffs against the seats as they were READ, and a seat is only true until
 * he next changes his lineup. Saying when makes a stale baseline visible instead of
 * silently authoritative — the same rule `src/client/lineup.ts` was written under.
 */
/* decide.css is being rewritten by another pass as this lands, so the one rule this
   change needs rides with the component that renders it. It belongs beside `.decide-gain`
   in decide.css and can be moved there whenever the two are not being edited at once. */
const ASSUMED_CSS = `
.decide-head .decide-assumed{flex-basis:100%;font-style:italic}
`

const readAgo = (at: string): string => {
	const hours = (Date.now() - Date.parse(at)) / 3_600_000
	if (!Number.isFinite(hours)) return "at an unknown time"
	if (hours < 1) return "in the last hour"
	if (hours < 36) return `${Math.round(hours)} hours ago`
	return `${Math.round(hours / 24)} days ago`
}

/** "Sep 12", from an ISO date, in the reader's own locale. Noon so a timezone cannot
 *  move it to the day before — an ISO date parses as UTC midnight, and in any zone west
 *  of Greenwich `toLocaleDateString` would then print yesterday. */
const plainDate = (iso: string): string =>
	new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })

const PERIOD_NAME: Record<string, string> = {
	matchup: "this matchup",
	daily: "today",
	rolling: "this scoring period",
	days: "the window you picked"
}

export const Decide = ({
	snapshot,
	league,
	leagueKey,
	error,
	onOpenTeam
}: {
	snapshot: Snapshot | null
	league: League | null
	leagueKey: string | null
	/** Why the player data could not be read, when it could not. */
	error: string | null
	/** Takes the reader to the one screen that always works, on every platform:
	 *  entering his own players. A card that says "add your players" and does not
	 *  take him there is a card that has told him to go and find something. */
	onOpenTeam: () => void
}) => {
	const storedSeats = leagueKey ? lineupStore.of(leagueKey) : null
	/** Tonight, live, from MLB. One request, no server — see src/data/today.ts. */
	const { slate, error: slateError } = useSlate()
	/**
	 * The capture's injured list, brought up to date.
	 *
	 * The shipped snapshot's injury map is right on the day it is built and wrong
	 * every day after — and wrong the expensive way round, because a man placed on
	 * the list yesterday is still, to the file, available to start tonight. `merged`
	 * is null while the request is in flight or after it failed, and null means "use
	 * the capture as it stands", which is the honest fallback rather than a blank.
	 */
	const captured = useMemo(() => (snapshot ? hydrate(snapshot).injuries : null), [snapshot])
	const { merged: liveInjuries, error: injuryError } = useInjuries(captured, snapshot?.capturedAt)
	const injuries = liveInjuries ?? captured ?? new Map<number, string>()

	/**
	 * An unreadable roster store must not take the page down.
	 *
	 * `roster.of` throws on a store it cannot parse — deliberately, because repairing
	 * one means guessing which ids were meant and a roster guessed wrong prices every
	 * recommendation on this card. **My team** owns that conversation: it catches the
	 * throw, says what is wrong and offers the control that clears it.
	 *
	 * This card is not that screen. Called unguarded during render it turned a corrupt
	 * localStorage key into a blank page, which is a worse answer to "your store is
	 * broken" than the one already written two tabs away.
	 */
	/**
	 * Anything written to this browser re-reads the stores below.
	 *
	 * Without it, pasting a roster into the first-run setup wrote it correctly and this
	 * card went on saying "Add your players and this becomes tonight's lineup" until the
	 * page was reloaded — the payoff of the whole onboarding, invisible, to a reader who
	 * had just done the one thing the app asked of him.
	 */
	const rev = useStored()

	/*
	 * "No roster" and "the roster could not be read" are different, and this used to
	 * return [] for both.
	 *
	 * `seats` then fell through to the lineup store, so with `beanemachine:roster` set to
	 * invalid JSON this card printed a full twenty-man plan — "drop Jose Espada" — while
	 * My league, on the same page load, said the store was unreadable and offered a button
	 * to clear it. Acting on a store the app has declared unreadable, without saying so, is
	 * the one thing this card must not do. My league still owns the explaining and the
	 * repair; this card's job is to refuse.
	 */
	const owned = useMemo((): { ids: string[]; error: string | null } => {
		if (!leagueKey) return { ids: [], error: null }
		try {
			return { ids: roster.of(leagueKey), error: null }
		} catch (e) {
			return { ids: [], error: e instanceof Error ? e.message : String(e) }
		}
	}, [leagueKey, rev])
	const ownedIds = owned.ids
	const carried = leagueKey ? poolStore.of(leagueKey) : null

	/**
	 * A team entered BY HAND is still a team.
	 *
	 * `lineupStore` holds seats — which slot each man is in — and only two things
	 * ever write it: a `scoring.json` carried in from the command line, and a roster
	 * read off the platform. Neither is available to somebody who opened
	 * beanemachine.com and typed his players into **My team**, which is the only
	 * route a Yahoo user has in a browser at all. So the surface that exists to tell
	 * him what to do told him "this page has not been told which players are yours"
	 * — about a team he had just finished entering.
	 *
	 * `roster.ts` has him: ids, per league, which is everything except the seats. The
	 * seats are then genuinely unknown rather than assumed, and that difference is
	 * carried through rather than papered over — `known` is false, nothing claims to
	 * diff against a lineup nobody read, and the card says so. Eligibility comes from
	 * the snapshot's own map, which is swept off Yahoo's player pages: a real source,
	 * not a guess at where a man may play.
	 */
	const seats = useMemo(() => {
		/*
		 * THE ROSTER IS THE AUTHORITY ON WHO IS YOURS. The stored seats say only where
		 * they sit.
		 *
		 * This read `storedSeats` whenever it had spots and consulted `owned` only as a
		 * fallback, and nothing in the app has ever cleared the lineup store. So pressing
		 * "Clear team" on My league — no corruption, no edge case — emptied the roster and
		 * left the seats, and Tonight went on printing the whole plan for the team that had
		 * just been deleted: "12 of your men can score", "Bench Jair Camargo", "Add Dominic
		 * Canzone for your Util seat, drop Jose Espada". My league said "No players yet" on
		 * the same page load. It survived reloads, and the only escape was reading a new
		 * roster or finding the error boundary's clear button by crashing the page.
		 *
		 * Requiring a man to still be owned fixes it here, at the point the claim is made,
		 * rather than relying on every future clear path remembering to delete a second
		 * store. An EMPTY roster therefore means no seats at all, which is the honest
		 * answer — and the card's own no-roster state is what renders.
		 */
		const mine = new Set(ownedIds.map(k => k.split(":")[0]))
		const ownedNames = new Set<string>()
		const knownNames = new Set<string>()
		for (const p of snapshot?.players ?? []) {
			const n = normalizeName(p.name)
			knownNames.add(n)
			if (mine.has(String(p.id))) ownedNames.add(n)
		}
		/*
		 * A seat survives if the roster still owns the man, OR if the capture cannot name
		 * him at all — the second is an absence, not a disowning, and My league already
		 * reports those men by id with "has no row in the current capture", so dropping
		 * them here would turn a stated gap into a silent one.
		 *
		 * And the filter only applies where the roster KNOWS something. A lineup with no
		 * roster beside it is a real state — it is how the shipped seed arrives, and how a
		 * league loaded from a file can arrive — and there the seats are all there is.
		 */
		const stillMine =
			ownedIds.length && snapshot ?
				storedSeats?.spots.filter(sp => {
					const n = normalizeName(sp.name)
					return ownedNames.has(n) || !knownNames.has(n)
				})
			:	storedSeats?.spots
		if (stillMine?.length) return { spots: stillMine, at: storedSeats!.at, known: true }
		if (!ownedIds.length || !snapshot) return null
		const byId = new Map(snapshot.players.map(p => [p.id, p]))
		const elig = snapshot.eligibility ?? {}
		const spots = ownedIds.flatMap(k => {
			const p = byId.get(Number(k.split(":")[0]))
			if (!p) return []
			return [{
				slot: "BN",
				/**
				 * SLOTS, not positions.
				 *
				 * `legalSlotsFor` in src/auto/plan.ts asks whether any of these appears in
				 * the league's `slot_accepts` list for a seat, and those lists are written
				 * in the platform's slot names — "OF", "SP", "RP". MLB's own position is
				 * not one of them: a centre fielder is "CF" and a pitcher is "P", so
				 * neither ever matched an OF or an SP seat.
				 *
				 * The league's own eligibility grid covers 328 of the capture's 1,446
				 * players, so more than three quarters of every hand-entered roster fell
				 * through to that raw position — and the daily card, the surface this app
				 * is named for, seated one man out of eighteen and blamed a projection
				 * that existed. `slotsFor` is the mapping the engine already uses to build
				 * `Rated.slots`; calling it here is what makes the two agree.
				 */
				name: p.name,
				positions: slotsFor(p, elig[String(p.id)]),
				team: p.team ?? null
			}]
		})
		return spots.length ? { spots, at: null as string | null, known: false } : null
	}, [storedSeats, ownedIds, snapshot])

	/**
	 * The same wire the board reads, from the same place.
	 *
	 * This card read only the CARRIED pool — the one in the file you dropped — while
	 * the board asked `api.available`, which prefers a live read where one is
	 * possible and falls back to the carried copy where it is not. The two then
	 * disagreed about who was free, and disagreed silently: on 2026-09-08 the board
	 * offered Chandler Simpson, correctly, because his league had dropped him since
	 * the file was written, and this card went on recommending against a wire four
	 * days old. Two answers to "who can I get" on one page is worse than either.
	 *
	 * The carried copy is still the answer where nothing better exists, which is the
	 * hosted site: no server, and Yahoo will not talk to a browser.
	 */
	const [read, setRead] = useState<AvailablePool | null>(null)
	const leagueId = league?.meta.league_id ?? null
	useEffect(() => {
		if (!leagueId || !canReadPool(league?.meta.platform)) return
		let on = true
		api.available(leagueId, {
			platform: league?.meta.platform,
			season: league?.meta.season,
			sport: league?.meta.sport
		})
			// a partial sweep is not a wire — see `poolIsPartial`. Left unset, the card
			// falls through to the ownership estimate, which covers everybody.
			.then(p => on && p.players.length && !poolIsPartial(p) && setRead(p))
			.catch(() => {
				// the carried copy below is the fallback, and it needs no announcement
				// here — the board already reports why a live read failed
			})
		return () => {
			on = false
		}
	}, [leagueId, league?.meta.platform, league?.meta.season])

	const wire = read ?? carried

	/**
	 * Who he could get, when nobody has read his league's actual wire.
	 *
	 * This is the whole difference between an app and a developer tool. Reading a
	 * Yahoo league needs a server — Yahoo sends no CORS headers, measured again
	 * 2026-09-09 — and until one is deployed the card's answer to "what should I add"
	 * was: run a TypeScript file from a checkout you do not have. For a website that
	 * is not an answer, and the estimate it refused to make is one the rest of this
	 * app has been making all along.
	 *
	 * The board's availability ladder already has this rung: rank everyone by how
	 * widely he is rostered, cut at `teams × seats`, and call the men below it
	 * probably free. It is an estimate and it is labelled one everywhere it appears —
	 * but it is calibrated to THIS league's size, it is the same rung the board's own
	 * filter uses, and it is enormously better than nothing.
	 *
	 * Never used where a real list exists: a read beats an estimate, always.
	 * Eligibility comes from the snapshot's map, which is swept off Yahoo's player
	 * pages, so a man is only offered for a seat his own platform grants him.
	 */
	const estimatedWire = useMemo(() => {
		if (wire?.players.length || !snapshot || !league) return null
		const ownership = new Map(
			Object.entries(snapshot.ownership ?? {}).map(([k, v]) => [Number(k), Number(v)])
		)
		const cut = ownershipCut(league, ownership)
		if (!cut?.usable) return null
		const elig = snapshot.eligibility ?? {}
		const mine = new Set((seats?.spots ?? []).map(sp => normalizeName(sp.name)))
		const players = snapshot.players.flatMap(p => {
			const pct = ownership.get(p.id)
			if (pct === undefined || pct > cut.cut) return []
			if (mine.has(normalizeName(p.name))) return []
			// Same mapping as the roster above, and for the same reason: these go to
			// `legalSlotsFor`, which compares against the league's slot names.
			const positions = slotsFor(p, elig[String(p.id)])
			return positions.length ? [{ name: p.name, positions }] : []
		})
		return players.length ? { players, cut } : null
	}, [wire, snapshot, league, seats])
	/**
	 * How old the wire is, where that is a question worth asking.
	 *
	 * The card already says when the SEATS were read, because a stale lineup makes the
	 * diff wrong. A stale wire is worse and quieter: it goes on offering a man the
	 * league picked up days ago and never offers one it has just dropped. On
	 * 2026-09-08 the carried file was four days old and did not contain Chandler
	 * Simpson, whom this league had released in the meantime and who is the best
	 * outfielder on it.
	 *
	 * `AvailablePool.readAt` is the right source and already models this: it is set
	 * only on a list CARRIED IN from a local run, because that is the only one whose
	 * age can differ from now — a server read happens while you wait. An earlier
	 * version of this asked whether `api.available` had answered at all, which is not
	 * the same question: that call falls back to the carried store itself, so it
	 * answers with a four-day-old file and reports it as fresh.
	 */
	const wireAge =
		read?.readAt ? readAgo(read.readAt)
		: read ? null
		: carried?.at ? readAgo(carried.at)
		: null

	/**
	 * Rated over the SCORING PERIOD, not a fortnight.
	 *
	 * The horizon is the decision, not a setting. A head-to-head matchup is settled
	 * on the period, so that is the window a move this week is worth something over;
	 * ranking the next fourteen days would price half of it against a matchup that
	 * has not started.
	 */
	/** The list every recommendation is drawn from: the league's own wire where one
	 *  has been read, and the ownership estimate where none has. */
	const candidates = useMemo(
		() =>
			wire?.players.length ?
				wire.players.map(p => ({ name: p.name, positions: p.positions }))
			:	(estimatedWire?.players ?? []),
		[wire, estimatedWire]
	)

	/** The league's own free-agent list as a test any rated player can be put to. */
	const wireTest = useMemo(() => {
		const names = new Set(candidates.map(x => normalizeName(x.name)))
		return names.size ?
				(r: { player: { name: string } }) => names.has(normalizeName(r.player.name))
			:	undefined
	}, [candidates])

	const rated = useMemo(() => {
		if (!snapshot || !league || league.meta.max_teams == null) return null
		const h = hydrate(snapshot)
		const slate = h.slate ?? []
		const period = resolvePeriod(league, localDate(), h.seasonEnd)
		const w = windowFrom(slate, period.start, period.end)
		if (!w.games.size) return null
		return {
			period,
			window: w,
			rows: rateAll({
				players: h.players,
				league,
				/**
				 * Priced against the league's own wire, where it has been read.
				 *
				 * Everything this card says about a man he can spare — "well below what a
				 * free agent at his own slot is worth" — is a claim about the wire, and
				 * `planSwaps` decides who is droppable on the same quantity. Rated
				 * without this the bar is the whole-pool simulation, so the sentence was
				 * measured against players he cannot have, which is the exact defect this
				 * card was built to end.
				 */
				available: wireTest,
				teamGamesPlayed: h.teamGamesPlayed,
				gamesByTeam: w.games,
				opponentsByTeam: w.opponents,
				recentVolumeByWindow: h.recentVolumeByWindow,
				recentStats: h.recentStats,
				ownership: h.ownership,
				probableStarts: w.probableStarts,
				opposingStarters: w.opposingStarters,
				startOpponents: w.startOpponents,
				eligibility: h.eligibility,
				probableCoverage: w.coverage,
				underlying: h.underlying,
				injuries,
				injuryPolicy: "exclude",
				teams: league.meta.max_teams
			})
		}
		// `wireTest` belongs here: the bar every recommendation is measured against is
		// drawn from it, and it changes when the live pool read lands after mount. Left
		// out, the board stayed priced against the previous wire — or against the
		// whole-pool simulation, if none had loaded at first render — while `plan` and
		// `keepForSeason` moved on. That is the exact defect the memo above says it
		// exists to end, one memo up.
	}, [snapshot, league, wireTest, injuries])

	/**
	 * TODAY — the decision this league actually forces every day.
	 *
	 * "Weekly Deadline: Daily" is a daily lineup lock, so he sets a lineup every
	 * single day of the season. Nothing in this app knew what day it was:
	 * `startingLineup` takes no date, so its answer was byte-identical on every day
	 * of the fortnight and it seated men whose clubs were not playing. On this
	 * league's own slate that is five idle men seated on 2026-09-10 while two with
	 * games sat on the bench.
	 *
	 * The fix needs no new model. `windowFrom(slate, today, today)` is one day's
	 * games, the same function the rest of the board runs on, and a roster filtered
	 * to the clubs in it cannot seat a man who is not playing. A seat left over is
	 * then honestly empty — nobody you own throws today — rather than filled by
	 * somebody who is not on the field.
	 *
	 * Null bars, deliberately. This is a question about the 24 men he owns and the 18
	 * seats they go in; "would a waiver body beat him" is a different question, asked
	 * at most a few times a week, and it is answered under `Make these moves`. Bars
	 * from a fortnight would also be nonsense here — a fortnight's replacement level
	 * against one day's points would price almost every seat as a hole.
	 */

	const today = useMemo(() => {
		if (!snapshot || !league || league.meta.max_teams == null || !seats?.spots.length) return null
		/*
		 * AN ABSENCE IS NOT A NO.
		 *
		 * This read `!== "daily"`, so a league that had never been asked about its lock —
		 * which is every league until the reader answers one chip — got no Today section at
		 * all. The reasoning was right for `"period"`: a lineup locked for the week means
		 * tonight is not a decision anybody can act on, and offering changes would be
		 * offering something the platform will refuse. It was wrong for null, and null is
		 * the common case.
		 *
		 * Measured by a stranger walking the published build at 390x844: the lock question
		 * sits 50px below the fold while the button that ends setup is pinned 193px above
		 * it, so the natural gesture — press the big button you can see — skips the
		 * question. He landed on "For this scoring period, 2026-09-11 to 2026-09-17 —
		 * assumed, your league states no scoring period" with no Today section, under a bar
		 * that had promised to tell him who to start tonight. The whole product was behind
		 * one chip he never saw.
		 *
		 * Withholding the answer on an absence is also the opposite of this app's own rule
		 * everywhere else: an absence is STATED. So the section renders, and `assumedDaily`
		 * carries the fact that nobody has said — the heading says it, and the chip that
		 * settles it is one tap away on My league.
		 */
		if (league.scoring_period?.lineup_lock === "period") return null
		const h = hydrate(snapshot)
		/*
		   `localDate()`, never `toISOString()`.
		   
		   `new Date().toISOString().slice(0, 10)` is the UTC date, and from 8pm Eastern
		   onwards that is TOMORROW. Measured with the clock pinned to Sunday 2026-09-13
		   20:30 EDT: the live feed was correctly requested for 2026-09-13 — `useSlate`
		   already used `localDate()` — while this card read "For this matchup, 2026-09-14
		   to 2026-09-20" and benched men whose clubs were playing at that moment, each with
		   a true reason about the wrong day. Four hours of every evening, in the window a
		   lineup is actually set, on the screen named for tonight.
		   
		   A slate is a local-calendar thing: a 7pm Eastern game is tonight's game to
		   somebody in California too. See the note on `localDate` in src/data/today.ts.
		*/
		const day = localDate()
		/*
		   TONIGHT'S OWN SLATE RATES TONIGHT, where the live read succeeded.
		   
		   This passed `h.slate` — the CAPTURED schedule — to `windowFrom`, which is how
		   the engine learns who plays, who they play, and who is announced to start.
		   The capture is stamped days before the page is opened, and measured on the
		   committed one, probables are published through 2026-09-11 and there are ZERO
		   for 09-12 through 09-27. So this card asked the engine about tonight with no
		   announced starters at all — coverage 0 published of 30 games — and the engine
		   did the only honest thing available to it, which was to credit every starter a
		   fractional turn (0.22 to 0.29 of a start) and rank him on his season rate.
		   Eight pitcher seats planned as though nobody in baseball were pitching, with
		   tonight's real probables already in memory one variable away.
		   
		   The fallback is the capture and not an empty window, because a failed live read
		   must not take the card down: the capture is wrong about tonight's starters and
		   right about who plays most nights, which beats saying nothing. `slate` is null
		   whenever the read failed — see useSlate — and a successful read of a day with
		   no baseball on it is a real answer, so the test is whether it has games rather
		   than whether it exists.
		*/
		const live = slate && slate.date === day && slate.games.length > 0
		const w = windowFrom(live ? asSlateGames(slate) : (h.slate ?? []), day, day)
		if (!w.games.size) return null
		const rows = rateAll({
			players: h.players, league, teamGamesPlayed: h.teamGamesPlayed,
			gamesByTeam: w.games, opponentsByTeam: w.opponents,
			recentVolumeByWindow: h.recentVolumeByWindow, recentStats: h.recentStats,
			ownership: h.ownership, probableStarts: w.probableStarts,
			opposingStarters: w.opposingStarters, startOpponents: w.startOpponents,
			eligibility: h.eligibility, probableCoverage: w.coverage,
			underlying: h.underlying, injuries, injuryPolicy: "exclude",
			teams: league.meta.max_teams
		})
		const byName = new Map(rows.map(r => [normalizeName(r.player.name), r]))
		/** What MLB says about each man tonight, where the live read succeeded. */
		const liveStatus = new Map<string, TodayStatus | null>()
		const playing = new Set<string>()
		/** Men MLB has actually put in tonight's card — a published batting order or an
		 *  announced start. A claim, not a silence. */
		const placed = new Set<string>()
		/** Men whose club is playing and about whom MLB has said nothing yet. Most of any
		 *  given day, and not the same as men who will sit. */
		const waiting = new Set<string>()
		const idle: string[] = []
		/** Men the board has no row for at all — a capture that predates a call-up, a
		 *  spelling Yahoo and MLB disagree on. Not the same as a man with no game, and
		 *  it must not be reported as one. */
		const unmatched: string[] = []
		for (const sp of seats.spots) {
			const r = byName.get(normalizeName(sp.name))
			if (!r) {
				if (!isReserveSlot(sp.slot)) unmatched.push(sp.name)
				continue
			}
			// "has a game" is a claim about a man who can play it. Counting everyone whose
			// club is on today put his whole 24 in the total, two of them on the injured
			// list — `injuryPolicy: "exclude"` had already made them unrateable.
			//
			// The schedule comes from the committed capture, which is right about a
			// season and cannot be right about tonight: it is stamped days ago and knows
			// nothing about a scratch, a rest day or a lineup card. `slate` is tonight,
			// read live from MLB on mount, and where it disagrees it wins — a man his own
			// manager has left out is not a man to start, whatever the projection says.
			const live = slate ? statusOf(r.player.id, r.player.teamId, r.player.group, slate) : null
			liveStatus.set(normalizeName(sp.name), live)
			const onField =
				live ? live.kind !== "no-game" && live.kind !== "benched"
				:	r.player.teamId != null && w.games.has(r.player.teamId)
			const plays = r.rateable && onField
			if (plays) {
				playing.add(normalizeName(sp.name))
				/*
				   PLACED IN TONIGHT'S CARD is a different fact from CAN SCORE, and the header
				   was printing the second while sounding like the first.
				   
				   Measured on a real 24-man roster at 18:40: "22 of your men can score" counted
				   every non-IL man but the one scratch — including eight pitchers MLB had not
				   named for tonight and a catcher whose club's order was not posted. The honest
				   count was fourteen: twelve hitters in a published order and two announced
				   starters. The other eight were not a claim about them, they were silence.
				   
				   `statusOf` already draws the line and the comment on `TodayStatus` explains why
				   the four states are not collapsed: "starting" and "pitching" are MLB saying he
				   is in it, "waiting" is MLB not having said anything yet, and most of any given
				   day is "waiting". So the two are counted separately and the header says both.
				*/
				if (live && (live.kind === "starting" || live.kind === "pitching"))
					placed.add(normalizeName(sp.name))
				else if (live && live.kind === "waiting") waiting.add(normalizeName(sp.name))
			} else if (!isReserveSlot(sp.slot)) idle.push(sp.name)
		}
		const lineup = planLineup({
			roster: seats.spots
				.filter(sp => playing.has(normalizeName(sp.name)))
				.map(sp => ({ ...sp, team: sp.team ?? null })),
			rated: rows,
			availableNames: new Set(),
			shape: {
				slots: league.roster.slots,
				slot_order: league.roster.slot_order,
				slot_accepts: league.roster.slot_accepts
			},
			options: DEFAULTS
		})
		/**
		 * Seats that ended up with nobody, and why — never dropped in silence.
		 *
		 * `planLineup.emptySlots` reports seats no rostered player may LEGALLY fill,
		 * which is a rarer and different thing. A seat can also come out empty because
		 * everyone eligible for it projects nothing today: a starting pitcher who is
		 * not starting is unrateable over a one-day window, correctly, so an SP seat
		 * behind him has no candidate. Leaving it empty is the right answer and Yahoo
		 * allows it. Rendering fourteen rows and saying nothing about the other four
		 * is not — the card would read as a complete lineup.
		 */
		const used = new Map<string, number>()
		for (const st of lineup.starters) used.set(st.slot, (used.get(st.slot) ?? 0) + 1)
		const unfilled: string[] = []
		for (const slot of activeSlots({
			slots: league.roster.slots,
			slot_order: league.roster.slot_order,
			slot_accepts: league.roster.slot_accepts
		})) {
			const left = used.get(slot) ?? 0
			if (left > 0) used.set(slot, left - 1)
			else unfilled.push(slot)
		}
		/**
		 * What to CHANGE, not what the lineup is.
		 *
		 * He already has a lineup in Yahoo; `src/client/lineup.ts` stored it, seat by
		 * seat, when it was read. Printing all eighteen rows asks him to check every
		 * one against a screen in another tab. What he needs is the difference, which
		 * here is four men: the pitchers who are not pitching today.
		 *
		 * Diffed by NAME against the seats as read. A man in an active seat who is not
		 * in today's lineup comes out; one in today's lineup who is not in an active
		 * seat goes in. Paired only where the counts allow — a bench with no
		 * replacement is still a change he has to make.
		 */
		const seated = new Set(lineup.starters.map(st => normalizeName(st.name)))
		const activeNow = seats.spots.filter(sp => !isReserveSlot(sp.slot))
		const benchAll = activeNow.filter(sp => !seated.has(normalizeName(sp.name)))
		const nowActive = new Set(activeNow.map(sp => normalizeName(sp.name)))
		const startAll = lineup.starters.filter(st => !nowActive.has(normalizeName(st.name)))

		/*
		   A SEAT THAT HAS ALREADY SHUT IS NOT AN INSTRUCTION.
		   
		   Measured at 18:40 on a real roster: row 1 of 9 under "Make these changes" read
		   "SS Start Kevin McGonigle 7.35 projected today · locks 1:05pm" — his club had
		   been In Progress since 13:05. The rows sort by lock time ascending, so the seats
		   that had ALREADY GONE sorted first, and the list a reader works down top-first
		   opened with the part of it he could no longer do.
		   
		   Dropping a row is not enough on its own, and getting that wrong is worse than
		   the original. The changes are a NET accounting — N men in, N out — so the bench
		   instruction paired with a locked start is still live: drop "Start McGonigle" and
		   keep "Bench Gunnar Henderson" and obeying the card EMPTIES the shortstop seat,
		   7.09 points turned into 0 by following advice. So both halves of a swap go or
		   neither does, and `lineup.swaps` is what knows which row pairs with which.
		   
		   Three ways a man is frozen, and they are the same rule from three directions: he
		   cannot be seated after his own game has started, he cannot be taken out of a
		   seat whose game has started, and he cannot be shifted between two seats when one
		   of them has. What is left is the set of changes the platform will still accept.
		*/
		const now = Date.now()
		const shut = (name: string): boolean => {
			const at = slate ? lockFor(byName.get(normalizeName(name))?.player.teamId, slate) : null
			return at !== null && at <= now
		}
		const frozen = new Set<string>()
		for (const st of startAll) if (shut(st.name)) frozen.add(normalizeName(st.name))
		for (const sp of benchAll) if (shut(sp.name)) frozen.add(normalizeName(sp.name))
		for (const sw of lineup.swaps) {
			if (!frozen.has(normalizeName(sw.start)) && !(sw.sit && frozen.has(normalizeName(sw.sit))))
				continue
			frozen.add(normalizeName(sw.start))
			if (sw.sit) frozen.add(normalizeName(sw.sit))
		}
		const bench = benchAll.filter(sp => !frozen.has(normalizeName(sp.name)))
		const start = startAll.filter(st => !frozen.has(normalizeName(st.name)))
		/** Men whose seats the platform has already closed, so the card can say the
		 *  changes it is NOT offering rather than look like it found fewer. */
		const locked = [...new Set([
			...startAll.filter(st => frozen.has(normalizeName(st.name))).map(st => st.name),
			...benchAll.filter(sp => frozen.has(normalizeName(sp.name))).map(sp => sp.name)
		])]
		return {
			day, lineup, idle, unmatched, unfilled, playing: playing.size, locked,
			placed: placed.size,
			waiting: waiting.size,
			/** Whether the live read answered at all. With no slate there is nothing to
			 *  split a headcount on and the header says the one number it has. */
			live: !!slate,
			/** Seat changes within the lineup, minus any man whose game has started —
			 *  see the note on `frozen` above; a shift is a change to HIS seat, so only
			 *  his own lock can stop it. */
			shifts: lineup.shifts.filter(sh => !frozen.has(normalizeName(sh.name))),
			/** Nobody has said whether this league locks daily, so these changes are
			 *  offered on the assumption that it does — which the heading states. */
			assumedDaily: !league.scoring_period?.lineup_lock,
			/** Every man rated for TODAY, so the seats nobody you own can fill can be
			 *  offered somebody who is actually on a card tonight. */
			ratedToday: rows,
			/** How many clubs are on today at all. Thirteen empty seats reads as a
			 *  broken app; "only five games are being played" reads as a Wednesday. */
			/* Called-off games are not counted, for the same reason they no longer seat
			   anybody: "15 games today" beside a lineup that cannot fill its seats is the
			   exact confusion this count exists to prevent. See `called` in
			   src/data/today.ts for what a postponed game used to look like from here. */
			games: slate ? slate.games.length - slate.called.size : null,
			readAt: seats.at,
			/**
			 * Three reasons a man comes out, and they are different claims.
			 *
			 * This was a two-way ternary — club idle, else "not projected to play" — and
			 * the third is the commonest: he is projected to play, and lost the seat to
			 * somebody better. On 2026-09-08 it printed "Roman Anthony — he is not
			 * projected to play today" about a man rateable at 4.14 points with Boston
			 * playing, who had simply been outranked for the last outfield seat. A
			 * ranking reported as a fact about availability is a claim the code cannot
			 * support, and a reader who checks it finds the app wrong about the schedule.
			 *
			 * The fourth case is a name the board never matched, which used to fall
			 * through `idle` and come out as "his club is not playing today" — the one
			 * state that should reach the reader as "we could not find him".
			 */
			bench: bench.map(sp => {
				const r = byName.get(normalizeName(sp.name))
				const live = liveStatus.get(normalizeName(sp.name)) ?? null
				return {
					name: sp.name,
					slot: sp.slot,
					/**
					 * MLB's answer first, where there is one.
					 *
					 * "he is not projected to play today" is a statement about a projection
					 * dressed as a statement about the schedule, and a reader who checks it
					 * finds the app wrong about a fact. Tonight's card, tonight's schedule
					 * and tonight's probables are all knowable for free, and they say which
					 * of four different things is actually true.
					 */
					why:
						!r || unmatched.includes(sp.name) ?
							"he is not on the board — no projection exists for that name"
						: live && live.kind === "no-game" ? "no game today"
						: live && live.kind === "benched" ? "not in today's lineup"
						/*
						 * The ENGINE'S own reason, where it has one.
						 *
						 * This branch used to read "a better man is projected for that seat
						 * today" for every man who was neither idle nor unmatched — a
						 * sentence this file invented. `rateAll` already builds a specific
						 * one per player (src/engine/bscore.ts:435): he is on the injured
						 * list, MLB has published a starter for every game of the window and
						 * he is not one of them, this league scores nothing on his side of
						 * the ball, his projected volume rounds to zero. Throwing those away
						 * and substituting a guess is the exact failure this app exists not
						 * to commit: it named a gap it did not have and hid the one it did.
						 */
						: !r.rateable && r.unrateable ? r.unrateable
						: !r.rateable ? "no projection could be made for him over this window"
						: idle.includes(sp.name) ? "his club is not playing today"
						:	"a better man is projected for that seat today"
				}
			}),
			/**
			 * Ordered by when each man's game starts, not by what the change is worth.
			 *
			 * There is no single lineup moment: measured across the 2025 season, first
			 * pitches spread over a median 7h25m window and about a quarter fall in the
			 * 7pm ET hour. So a list ordered by value is ordered on the wrong axis at the
			 * moment somebody is acting on it — half of it is already unchangeable and
			 * the reader has to find the half that is not. Earliest first pitch first,
			 * and a man with no known start time sorts last, because nothing is expiring
			 * for him.
			 */
			start: start
				.map(st => ({
					name: st.name,
					slot: st.slot,
					points: st.points,
					lock: slate ? lockFor(byName.get(normalizeName(st.name))?.player.teamId, slate) : null
				}))
				.sort((a, b) => (a.lock ?? Infinity) - (b.lock ?? Infinity)),
			/**
			 * The next seat still to lock, so the card can say how long is left.
			 *
			 * Over every man who has a game, not only over the ones being changed. The
			 * deadline a reader is working against is the first of HIS games to start —
			 * after which that seat is fixed whatever the card later says about it — and
			 * a card that only counted the men it happened to be recommending would go
			 * quiet on exactly the evening when nothing needs changing yet and something
			 * might in an hour. Null when they have all started, which is itself worth
			 * being told.
			 */
			nextLock:
				slate ?
					nextLock(
						[...playing].map(name => lockFor(byName.get(name)?.player.teamId, slate))
					)
				:	null
		}
	}, [snapshot, league, seats, slate, injuries])

	/**
	 * Men who are worth too much over the REST OF THE SEASON to give away for a week.
	 *
	 * `keepFloor` is a bscore, and bscore is denominated in the horizon it was rated
	 * over, so the same 25 protects a different set of men depending on the window.
	 * Over a fortnight 5 of the shipped roster's 21 sit below it; over this league's
	 * six-day period, 12 do — Juan Soto among them. A short week should not be enough
	 * to offer up one of the best hitters in baseball, and the week cannot see that,
	 * because within the week it is true that he is not worth much.
	 *
	 * So the same floor is asked of the rest of the season, and a man safe on either
	 * horizon is safe. Rated once, on games remaining rather than a fixed length,
	 * because "the rest of the season" is what a keeper decision is actually about.
	 */
	const keepForSeason = useMemo(() => {
		if (!snapshot || !league || league.meta.max_teams == null || !seats?.spots.length)
			return new Set<string>()
		const h = hydrate(snapshot)
		const today = localDate()
		const w = windowFrom(h.slate ?? [], today, h.seasonEnd)
		if (!w.games.size) return new Set<string>()
		const rows = rateAll({
			players: h.players, league, available: wireTest, teamGamesPlayed: h.teamGamesPlayed,
			gamesByTeam: w.games, opponentsByTeam: w.opponents,
			recentVolumeByWindow: h.recentVolumeByWindow, recentStats: h.recentStats,
			ownership: h.ownership, eligibility: h.eligibility, underlying: h.underlying,
			injuries, injuryPolicy: "keep", teams: league.meta.max_teams
		})
		const mine = new Set(seats.spots.map(sp => normalizeName(sp.name)))
		const keep = new Set<string>()
		for (const r of rows) {
			if (!r.rateable) continue
			const n = normalizeName(r.player.name)
			if (mine.has(n) && r.bscore >= DEFAULTS.keepFloor) keep.add(n)
		}
		return keep
	}, [snapshot, league, seats, wireTest, injuries])

	const plan = useMemo(() => {
		if (!rated || !league || !seats?.spots.length) return null
		const input: PlanInput = {
			// `team` is optional on the stored seat and required on the planner's, and
			// the difference is real: a seat read with no club beside it is a seat whose
			// club we do not know, not one with no club.
			roster: seats.spots.map(sp => ({ ...sp, team: sp.team ?? null })),
			rated: rated.rows,
			// a read beats an estimate, always; the estimate is only reached when nothing
			// has read this league's wire — see `estimatedWire`
			availableNames: new Set(candidates.map(p => normalizeName(p.name))),
			available: candidates.map(p => ({ name: p.name, positions: p.positions })),
			shape: {
				slots: league.roster.slots,
				slot_order: league.roster.slot_order,
				slot_accepts: league.roster.slot_accepts
			},
			options: DEFAULTS
		}
		return { lineup: planLineup(input), swaps: planSwaps(input, 60, keepForSeason) }
	}, [rated, league, seats, candidates, keepForSeason])
	const lineup = plan?.lineup ?? null

	/**
	 * The two per-period rules the league states, and what his own staff does against
	 * the innings one.
	 *
	 * The floor is a QUANTITY problem before it is a quality one, and the app has
	 * only ever stated the rule. Projecting his own rostered pitchers against it is
	 * the half that answers anything — and it is the half that says whether dropping
	 * a pitcher is safe.
	 */
	/**
	 * INNINGS ALREADY BANKED, which is the half of the innings floor this card has never had.
	 *
	 * Counted for every pitcher the reader holds NOW, whatever seat each was in at the time,
	 * because that is the most this page can know: nothing records which men were active on
	 * the third of the period, and the honest unit is therefore the men rather than the
	 * seats. The sentence on screen says so. A man added yesterday brings the innings he
	 * threw before he was yours, which is the one direction this can be wrong in, and it is
	 * a direction the reader can see and correct for.
	 */
	const periodStart = rated?.period.start ?? null
	const thrown = useThrownInnings(
		typeof snapshot?.season === "number" ? snapshot.season : null,
		periodStart,
		lastNight(),
		!!periodStart && ownedIds.some(k => k.endsWith(":pitching"))
	)
	const banked = useMemo((): number | null => {
		/* A PERIOD THAT OPENED TODAY HAS THROWN NOTHING, and that is a fact rather than an
		   absence. The hook asks for no range in that case — a window running backwards is not
		   a request worth making — and returning null here would make the card fall back to
		   the sentence that cannot answer the question, on the one day when the answer is
		   certain. Measured on the shipped league, whose week opens on a Monday: this is one
		   day in seven. */
		if (!thrown.lines)
			return periodStart && periodStart > lastNight() ? 0 : null
		let outs = 0
		for (const k of ownedIds) {
			if (!k.endsWith(":pitching")) continue
			outs += thrown.lines.get(k)?.stats.outs ?? 0
		}
		return Number((outs / 3).toFixed(1))
	}, [thrown.lines, ownedIds, periodStart])

	const rules = useMemo(() => {
		const raw = ((league?.league_rules as { raw_settings?: Record<string, string> } | undefined)
			?.raw_settings ?? {}) as Record<string, string>
		const floor = deriveInningsMinimum(raw).perPeriod
		const cap = deriveMoveLimit(raw).perPeriod
		if (floor === null || !rated || !lineup?.starters.length)
			return { floor, cap, projected: null, after: null }
		/**
		 * Only the men in SEATS, because only they throw innings that count.
		 *
		 * This summed every pitcher on the roster and reported 82.5 against a floor of
		 * 20 — a comfortable pass built by counting four pitchers sitting on the bench,
		 * whose innings accrue to nobody. The floor is a question about the lineup, so
		 * it is asked of the lineup.
		 */
		const inningsOf = (starters: { slot: string; name: string }[]) =>
			seatedInnings(rated.rows, starters)
		const projected = inningsOf(lineup.starters)

		/**
		 * ...and the same question asked of the roster the MOVES would leave.
		 *
		 * Two of the swaps above can be a pitcher out and a hitter in, and this league
		 * forfeits its pitching side under twenty innings. Reporting only the innings
		 * he has now, next to advice that would remove some of them, is the card
		 * checking the wrong roster: it would clear him at 63.5 and then tell him to
		 * drop two arms. So the floor is asked twice, and the second answer is the one
		 * that can stop a move.
		 */
		let after: number | null = null
		if (league && plan?.swaps.moves.length && league.roster.slot_accepts && seats?.spots.length) {
			// A move with no drop displaces nobody, so nobody leaves the lineup for it.
			const dropped = new Set(
				plan.swaps.moves.flatMap(m => (m.drop ? [normalizeName(m.drop)] : []))
			)
			const added = plan.swaps.moves.map(m => {
				const r = rated.rows.find(x => normalizeName(x.player.name) === normalizeName(m.add))
				return {
					slot: "BN",
					name: m.add,
					positions: (wire?.players ?? []).find(w => normalizeName(w.name) === normalizeName(m.add))
						?.positions ?? [],
					team: r?.player.team ?? null
				}
			})
			const post = planLineup({
				roster: [
					...seats.spots
						.filter(sp => !dropped.has(normalizeName(sp.name)))
						.map(sp => ({ ...sp, team: sp.team ?? null })),
					...added
				],
				rated: rated.rows,
				availableNames: new Set(),
				shape: {
					slots: league.roster.slots,
					slot_order: league.roster.slot_order,
					slot_accepts: league.roster.slot_accepts
				},
				options: DEFAULTS
			})
			after = inningsOf(post.starters)
		}
		return { floor, cap, projected, after }
	}, [league, rated, lineup, plan, seats, wire])

	/**
	 * The seats that will score nothing tonight, and who could fill them.
	 *
	 * This is the biggest measured lever in a points league and the app was burying
	 * it in a disclosure. The published decompositions put volume accumulation —
	 * never leaving an allowed slot unused — at roughly the magnitude of all
	 * in-season move quality combined, and in this league's own scoring an empty
	 * hitter seat costs about 6.9 points a day against 0.7–1.5 for a realistic
	 * within-roster upgrade. Ranking adds by season value while three seats sit
	 * empty is optimising the small term.
	 *
	 * Two conditions, both hard: the man has to be gettable, and he has to be on a
	 * card TONIGHT. A free agent who does not play tonight fills the seat with the
	 * same zero it already has.
	 *
	 * THE SECOND CONDITION WAS A COMMENT AND NOT A CHECK. "Tonight" was `ratedToday`,
	 * which is rated over the COMMITTED CAPTURE's schedule — the file this app itself
	 * describes as right about a season and necessarily wrong about tonight — while the
	 * reader's own men were gated on `statusOf(..., slate)`, the live read. Measured by
	 * serving MLB's real schedule minus three games: the same card, on one load, benched
	 * the reader's Reds and White Sox men with "no game today" and offered him free
	 * agents from those same clubs as "projected tonight". The live read now gates both
	 * sides, which is the only way the card can stop contradicting itself.
	 */
	const fillTonight = useMemo(() => {
		if (!league || !today?.unfilled.length || !today.ratedToday.length) return []
		if (!candidates.length) return []
		const free = new Set(candidates.map(p => normalizeName(p.name)))
		const seen = new Set<string>()
		/** One man can only fill one seat. Sam Antonacci is eligible at 2B, 3B, OF and
		 *  Util in this league, so without this he was offered for four of them at once
		 *  — four adds that are really one, and three seats still empty afterwards. */
		const taken = new Set<string>()
		const out: { slot: string; name: string; points: number; team: string | null }[] = []
		for (const slot of today.unfilled) {
			if (seen.has(slot)) continue
			seen.add(slot)
			// `slots` on a Rated is the set of seats the engine has already worked out he
			// may legally fill in THIS league — the same list the lineup planner seats
			// him by — so nothing here has to re-derive eligibility and the two cannot
			// disagree about it.
			const best = today.ratedToday
				.filter(r => {
					if (!r.rateable || !r.slots.includes(slot)) return false
					const n = normalizeName(r.player.name)
					if (!free.has(n) || taken.has(n)) return false
					// Tonight's card where there is one. No live read at all leaves the
					// capture's schedule as the only answer there is, which is the state the
					// whole card is already labelled for.
					if (!slate) return true
					const live = statusOf(r.player.id, r.player.teamId, r.player.group, slate)
					return live.kind !== "no-game" && live.kind !== "benched"
				})
				.sort((a, b) => b.points - a.points)[0]
			if (best && best.points > 0) {
				taken.add(normalizeName(best.player.name))
				out.push({
					slot,
					name: best.player.name,
					points: best.points,
					team: best.player.team ?? null
				})
			}
		}
		return out.slice(0, 4)
	}, [today, candidates, league, slate])

	/**
	 * WHAT WAS RECOMMENDED, WRITTEN DOWN BEFORE THE GAMES ARE PLAYED.
	 *
	 * This is the only write this card makes, and the only reason it exists is that the
	 * comparison it enables is impossible afterwards. `src/auto/recap.ts` can already say
	 * what a reader's men scored and what the best lineup would have been worth, both from
	 * public data with no history at all — but to say whether BILLY beat the lineup the
	 * reader already had, it needs the recommendation as it stood while the outcome was
	 * still unknown. Recomputed tomorrow from tomorrow's capture it would be a backtest;
	 * recorded now it is a claim. See src/client/ledger.ts.
	 *
	 * THE SIGNATURE GUARD IS LOAD-BEARING, not an optimisation. `ledgerStore.record` writes
	 * to this browser and then calls `stored()`, which bumps the revision every screen
	 * subscribes to — including the `owned` memo above, which returns a fresh array each
	 * time, which gives `seats` a new identity, which recomputes `today`, which re-runs this
	 * effect. Without the guard that is an unbounded write loop. With it, the second pass
	 * computes the same signature and stops.
	 *
	 * `at` is deliberately NOT in the signature, which makes it the moment this advice first
	 * appeared rather than the last moment it was re-rendered. That is the more useful of
	 * the two: a reader looking at a graded day wants to know when Billy started saying
	 * this, and a re-render at 11pm did not make the 6:40pm recommendation newer.
	 *
	 * Failure is swallowed on purpose, and it is the one place in this file that swallows
	 * anything. A damaged record is My league's problem to explain and the reader's to
	 * clear; a card whose job is to tell him what to do tonight must not refuse to do it
	 * because a history it has not shown him yet cannot be appended to.
	 */
	const recorded = useRef<string | null>(null)
	useEffect(() => {
		if (!leagueKey || !today || !seats) return
		const byName = new Map(today.ratedToday.map(r => [normalizeName(r.player.name), r]))
		const side = (name: string, slot: string | null, projected: number | null) => {
			const r = byName.get(normalizeName(name))
			return r ?
					[{ key: `${r.player.id}:${r.player.group}`, name, slot, projected }]
				:	[]
		}
		/* The WHOLE recommended lineup, not only the changes to it. "The lineup Billy asked
		   for" is every seat he asked for, and a grade that scored only the changes would be
		   comparing two different-sized teams. */
		const start = today.lineup.starters.flatMap(st => side(st.name, st.slot, st.points))
		const sit = today.bench.flatMap(b => side(b.name, b.slot, null))
		/* The lineup already in place, from the seats as they were READ. A hand-typed team
		   has every man on the bench, so `!isReserveSlot` empties this by itself and the day
		   is recorded as ungradeable rather than as a tie — which is what `gradeRecord` then
		   says in words. No special case needed. */
		const had = seats.spots
			.filter(sp => !isReserveSlot(sp.slot))
			.flatMap(sp => side(sp.name, sp.slot, byName.get(normalizeName(sp.name))?.points ?? null))
		const moves = (plan?.swaps.moves ?? []).map(m => ({ add: m.add, drop: m.drop ?? null }))
		const entry = { date: today.day, at: new Date().toISOString(), start, sit, had, moves }
		const sig = JSON.stringify([entry.date, start, sit, had, moves])
		if (recorded.current === sig) return
		recorded.current = sig
		try {
			ledgerStore.record(leagueKey, entry)
		} catch {
			// see the note above: this card does not refuse its own job over the history
		}
	}, [leagueKey, today, seats, plan])

	/**
	 * The men the plan could not price, grouped by WHY — one row per reason, never one
	 * per man, which is the same rule the bench rows follow for the same reason: sixteen
	 * rows of one sentence is not sixteen decisions.
	 */
	const skippedWhy = useMemo(() => {
		/*
		 * NOBODY IS EXPLAINED TWICE ON ONE CARD, and this is where it was happening.
		 *
		 * A man on the 60-day injured list in an active seat reached the reader twice, in
		 * two different sets of words. The bench rows said "Bench him — MLB lists him
		 * Injured 60-Day", which is the actionable one; this block said "One player on your
		 * roster could not be priced, so nothing above counts him: Injured 60-Day — no
		 * source states a return date." Both true, one man, two sentences, and nothing on
		 * screen tying them together — a reader checking whether he has understood finds
		 * what looks like two separate problems with the same player.
		 *
		 * So this block names only men the card has not already named. It keeps its whole
		 * job where that job is real: a man in a RESERVE seat, or one the board has no row
		 * for, never appears in the bench rows at all, and the lineup above is silently
		 * planned as if the reader owned twenty-two players when he owns twenty-four. That
		 * absence is what this block exists to state, and it still states it.
		 *
		 * The bench rows are the survivors rather than this one for two reasons: they carry
		 * the action (the seat has to be changed in Yahoo either way), and they are grouped
		 * by MLB's answer about TONIGHT, which is newer than the engine's answer about the
		 * window.
		 */
		const named = new Set(
			[
				...(today?.bench ?? []).map(b => b.name),
				...(today?.start ?? []).map(x => x.name),
				...(today?.shifts ?? []).map(x => x.name),
				...(today?.locked ?? [])
			].map(normalizeName)
		)
		const by = new Map<string, string[]>()
		for (const line of plan?.lineup.skipped ?? []) {
			const at = line.indexOf(": ")
			const name = at === -1 ? line : line.slice(0, at)
			if (named.has(normalizeName(name))) continue
			const why =
				at === -1 ?
					"No projection could be made for him, so he is neither started nor offered up."
				:	`${line.slice(at + 2)[0]!.toUpperCase()}${line.slice(at + 2).slice(1)}.`
			by.set(why, [...(by.get(why) ?? []), name])
		}
		return [...by].map(([why, men]) => ({ why, men }))
	}, [plan, today])

	if (!league) return null

	/**
	 * Waiting for the data and failing to get it are different states, and neither is
	 * "no projection could be made for this period" — which is what both used to
	 * reach, a sentence about the answer where the reader needed a sentence about the
	 * app. The board distinguishes them; so does this now.
	 */
	if (error)
		return (
			<section className="card full decide decide-blocked">
				<h2>What should I do?</h2>
				<p>Couldn&rsquo;t load the player data, so nothing here can be priced: {error}</p>
			</section>
		)
	if (!snapshot)
		return (
			<section className="card full decide decide-blocked">
				<h2>What should I do?</h2>
				<p className="empty">Loading player data…</p>
			</section>
		)
	/*
	 * An unreadable roster stops this card, before any of it is drawn.
	 *
	 * It used to plan from the lineup store instead and say nothing — a full twenty-man
	 * plan against a team the app could not read, on the same load as My league saying so
	 * and offering the repair. One sentence, and it points at the screen that owns the
	 * fix rather than repeating it: this card is not that screen.
	 */
	if (owned.error)
		return (
			<section className="card full decide decide-blocked">
				<h2>What should I do?</h2>
				<p>
					Your team can&rsquo;t be read out of this browser, so nothing here can be
					planned: {owned.error}
				</p>
				<p className="sub">
					Open <b>{tab("trade")}</b> &mdash; it says what went wrong and has the button
					that clears it.
				</p>
			</section>
		)

	/**
	 * A league that scores nothing gets a refusal, not a plan.
	 *
	 * The roster templates ship a shape without a scoring table, so until one is
	 * entered every projection is exactly zero. `rateAll` already refuses to rank
	 * that — everyone comes back unrateable — but this card had no guard, and an
	 * unrateable roster reaches the diff as a lineup nobody is in: it would have told
	 * him to bench all eighteen of his starters. The board and the trade page both
	 * make this refusal; the surface that gives instructions is the last one that
	 * should skip it.
	 */
	/**
	 * ...and one that does not say how many teams are in it gets the same.
	 *
	 * Replacement level is the (teams x seats)-th man deep, so without a team count
	 * there is no honest bar and `rateAll` refuses. The card would have fallen through
	 * to "no projection could be made for this period", which names the symptom and
	 * not the missing input, and sends nobody anywhere.
	 */
	if (league.meta.max_teams === null)
		return (
			<section className="card full decide decide-blocked">
				<h2>What should I do?</h2>
				<p>
					Nothing yet — <b>{league.meta.league_name ?? "this league"}</b> does not say how
					many teams are in it, and how deep the wire runs before it reaches replacement
					level depends on that. Without it no move has an honest price.
				</p>
				<p className="sub">
					Open <b>My league</b> and set the team count.
				</p>
			</section>
		)

	const scores =
		Object.values(league.scoring.batting).some(v => v !== 0) ||
		Object.values(league.scoring.pitching).some(v => v !== 0)
	if (!scores)
		return (
			<section className="card full decide decide-blocked">
				<h2>What should I do?</h2>
				<p>
					Nothing yet — <b>{league.meta.league_name ?? "this league"}</b> gives the roster
					shape but not what each stat is worth, so every projection here would be exactly
					zero and every recommendation would be a tie. That is a missing input, not an
					answer.
				</p>
				<p className="sub">
					Open <b>My league</b> and read the values off your platform, or enter them.
				</p>
			</section>
		)

	// Each of these is a different missing thing with a different fix, and naming the
	// wrong one sends the reader to the wrong button.
	if (!seats?.spots.length) {
		/**
		 * The first thing a stranger sees, and for a long time it was a command line.
		 *
		 * beanemachine.com opened on somebody else's team and told the reader to run
		 * `node --experimental-strip-types src/cli.ts` — from a checkout he does not
		 * have, against a league id that was not his. That is a developer tool wearing
		 * a domain name, and it is the single thing most likely to make a visitor
		 * close the tab.
		 *
		 * What is actually true: every platform can be entered BY HAND here, in the
		 * browser, in a minute, and the recommendations that follow are real — the
		 * availability behind them is an ownership estimate rather than a read, and it
		 * is labelled one. ESPN can additionally be read automatically, because it
		 * sends CORS headers. Yahoo cannot be read by any browser, which is a fact
		 * about Yahoo and not a thing to make the reader's problem.
		 *
		 * So the manual route leads, because it is the one that always works. The
		 * command line survives as a footnote for the exact answer, and only names a
		 * league when this browser actually holds one — printing the author's own
		 * league id at a stranger was worse than printing nothing.
		 */
		const espn = league.meta.platform === "espn"
		return (
			<section className="card full decide decide-blocked">
				{/*
				  One sentence and a button.

				  This was four paragraphs — a hundred and ten words, most of it about CORS —
				  standing between a reader and the only thing he can do on this screen. It
				  explained that availability would be estimated, why Yahoo cannot be read by
				  any browser, and how to run a command line, to somebody who has not yet told
				  the app who is on his team. None of it changes the next tap.

				  What survives is the ask and what it buys. The estimate is already labelled
				  on the control that uses it, and the command line is already on My team,
				  where a reader who wants the exact list is standing.
				*/}
				<h2>What should I do?</h2>
				<p>
					<button type="button" className="primary decide-cta" onClick={onOpenTeam}>
						Add your players
					</button>{" "}
					and this becomes tonight&rsquo;s lineup and the moves to make. About a
					minute, and it stays in this browser.
					{espn && " Your platform answers a browser directly, so it can read the whole roster in one click."}
				</p>
			</section>
		)
	}

	return (
		<section className="card full decide">
			<h2>What should I do?</h2>
			{rated && (
				<p className="sub decide-window">
					{/* Dates a person reads, not dates a machine writes. This printed
					    "2026-09-12 to 2026-09-18" on the same screen as "Friday, Sep 11" — two
					    formats for one kind of fact, and the ISO one is the format a file uses.
					    The year is dropped because the whole app is about this season and a
					    reader deciding tonight's lineup does not need telling which year it is. */}
					For <b>{PERIOD_NAME[rated.period.kind]}</b>, {plainDate(rated.period.start)} to{" "}
					{plainDate(rated.period.end)}
					{rated.period.assumed && " — assumed, your league states no scoring period"}.
				</p>
			)}

			{/* Today first, because today is the one that locks. A lineup change is free
			    and reversible and this league takes one every day; an add costs a move
			    and a player and can be made a few times a week. */}
			{today && (
				<>
					<style href="decide-assumed" precedence="default">{ASSUMED_CSS}</style>
					<h3 className="decide-head">
						Today
						<span className="decide-gain">
							{/* "have a game" is not what this counts. A starting pitcher on his club's
							    off-turn HAS a game — his club is playing — and cannot score in it,
							    and the set is now the men who are rateable today, which is the
							    useful one. So the words are the ones that match it.

							    The GAME COUNT is here because without it the card reads as broken.
							    On a five-game Wednesday a 27-man roster has four men who can score
							    and fourteen empty seats, and a reader who is not told that only five
							    clubs are playing concludes the app has lost his team. It is the
							    schedule, and saying so costs three words. */}
							{/*
							  THE DEADLINE LEADS, and it used to be fourth of four.
							  
							  The header is the whole card for anybody who reads one line, and at
							  390px it wraps to four lines of which the deadline was the last. It is
							  also the only thing on the row that EXPIRES: a game count and a
							  projection are equally true at 6pm and at 9pm, while "next lock 7:05pm"
							  stops being true at 7:05 and is the one fact that decides whether the
							  reader acts now or after dinner. `nextLock` is null once they have all
							  started, which is itself worth leading with.
							*/}
							{today.nextLock !== null ?
								<>
									<b>next lock {clock(today.nextLock)}</b> ·{" "}
								</>
							:	<>every seat has started ·{" "}</>}
							{today.games !== null && (
								<>
									{today.games} {today.games === 1 ? "game" : "games"} today ·{" "}
								</>
							)}
							{today.live && today.placed + today.waiting > 0 ?
								<>
									{today.placed} of your men {today.placed === 1 ? "is" : "are"} in
									tonight&rsquo;s card
									{today.waiting > 0 && <> · {today.waiting} waiting on a lineup</>} ·{" "}
								</>
							:	<>{today.playing} of your men can score · </>}
							{/*
							  "PROJECTS 128" WAS THE TOTAL AFTER MAKING EVERY CHANGE BELOW.
							  
							  `pointsPlanned` means the planned lineup, which is the point of the
							  name, and the sentence said "your lineup projects" — so a reader who
							  made none of the changes was told his lineup was worth a number it was
							  not. The two differ by exactly the gain the card is arguing for, which
							  is the worst possible place to be loose: it quietly credits the reader
							  with the advice before he has taken it.
							  
							  Both numbers are now named, and only where they differ — "projects 112,
							  or 128 once you make these changes". Where the lineup is already the
							  planned one there is one number and one clause, because "112, or 112
							  once you make no changes" is a sentence about nothing.
							*/}
							{/*
							  The pair is printed only where the plan is WORTH MORE, and that is not a
							  formality — measured on a constructed roster, `pointsPlanned` came back
							  82.22 against a `pointsNow` of 117.85.
							  
							  It is not a planner bug. A man currently in a seat this app cannot prove
							  he is eligible for contributes to the lineup as it stands and can be
							  seated nowhere by the solver, so he drops out of the planned total — and
							  the league's own eligibility grid covers 328 of the capture's 1,446
							  players, so it is not a rare shape. Printing "or 82.22 once you make these
							  changes" in that state advertises a downgrade. The changes below are still
							  worth reading, because some of them are forced: a man nobody says will
							  play has to come out whatever the total does.
							  
							  So where the plan is better the reader sees both numbers and the gain is
							  the argument; where it is not, he sees the lineup he actually has and the
							  header makes no claim about the plan at all.
							*/}
							{today.lineup.pointsPlanned > today.lineup.pointsNow ?
								<>
									your lineup projects {today.lineup.pointsNow}, or{" "}
									{today.lineup.pointsPlanned} once you make these changes
								</>
							:	<>your lineup projects {today.lineup.pointsNow}</>
							}
						</span>
						{/* The assumption, on the heading it qualifies rather than in a footnote.
						    A league whose lineup locks for the whole period cannot act on any of
						    this, and nobody has told us which kind this is — so the changes below
						    are offered on the commoner of the two and the reader is told that in
						    the same breath. Answering it is a chip on My league. */}
						{today.assumedDaily && (
							<span className="decide-gain decide-assumed">
								if your league lets you change the lineup every day &mdash; most do, and{" "}
								<b>{tab("trade")}</b> takes the answer
							</span>
						)}
						{/*
						  A live read that failed has to say so.
						  
						  Both feeds fall back to the shipped capture, which is the right
						  behaviour and the wrong thing to do silently: the capture is days old,
						  it cannot know about tonight's card or this morning's IL move, and a
						  card that quietly presents it as tonight is making exactly the claim
						  this file exists to stop making. `slateError` and the injury error were
						  both being captured and never rendered.
						*/}
						{(slateError || injuryError) && (
							<span className="decide-stale">
								couldn&rsquo;t reach MLB ({slateError ?? injuryError}) — tonight&rsquo;s{" "}
								{slateError && injuryError ?
									"lineups and injured list are"
								: slateError ?
									"lineups are"
								:	"injured list is"}{" "}
								from the capture, {freshness(snapshot?.capturedAt, Date.now()).label}
							</span>
						)}
					</h3>
					{/* Everyone unpriceable is not "bench everyone". A roster whose names none
					    of the board recognises — a capture that predates a call-up, a read that
					    caught a different league — produces a lineup nobody is in, and the diff
					    renders that as eighteen rows saying Bench. There is no lineup to
					    compare against, so there is no diff, and saying so is the answer. */}
					{!today.lineup.starters.length && today.bench.length ?
						<p className="sub">
							None of your players could be priced for today, so there is nothing to
							compare against — this is not a recommendation to bench them.{" "}
							{today.bench.length} {today.bench.length === 1 ? "man is" : "men are"} in
							your active seats.
						</p>
					: today.bench.length || today.start.length || today.shifts.length ?
						<>
							<ul className="decide-list decide-changes">
								{today.start.map(st => (
									<li key={`in-${st.name}`}>
										<span className="decide-slot">{st.slot}</span>
										<span>
											Start <b>{st.name}</b>{" "}
											<em className="decide-why">
												{st.points} projected today
												{/* When this seat stops being changeable. It is the only
												    thing on the row that expires, and the rows are ordered
												    by it — see the note on `start`. */}
												{st.lock !== null && (
													<span className="decide-lock"> · locks {clock(st.lock)}</span>
												)}
											</em>
										</span>
									</li>
								))}
								{/*
								  Grouped by REASON, not one row per man.
								  Measured on a real 27-man roster on a five-game night: sixteen
								  consecutive rows reading "Bench X — he is not projected to play
								  today", identical but for the name, above the two moves that were
								  the point of the card. Sixteen rows of the same sentence is not
								  sixteen decisions; it is one fact about the schedule and a list of
								  who it applies to. The names stay — each is still a seat he has to
								  change in Yahoo — but they cost a line each instead of a row each.
								*/}
								{Object.entries(
									today.bench.reduce<Record<string, typeof today.bench>>((by, b) => {
										;(by[b.why] ??= []).push(b)
										return by
									}, {})
								).map(([why, men]) => (
									<li key={`out-${why}`} className="decide-bench-group">
										<span className="decide-slot">
											{men.length === 1 ? men[0]!.slot : `×${men.length}`}
										</span>
										<span>
											Bench{" "}
											{men.map((b, i) => (
												<span key={b.name}>
													{i > 0 && ", "}
													<b>{b.name}</b>{" "}
													<em className="decide-seat">{b.slot}</em>
												</span>
											))}{" "}
											<em className="decide-why">{why}</em>
										</span>
									</li>
								))}
								{/* A man who stays in the lineup but changes seat is a change he has
								    to make, and leaving it out made the rest impossible to follow:
								    "Start Jac Caglianone at 1B" cannot be done while Aranda is in
								    that seat, and the card never mentioned Aranda. `planLineup`
								    reports these separately and they were dropped on the floor. */}
								{today.shifts.map(sh => (
									<li key={`shift-${sh.name}`}>
										<span className="decide-slot">{sh.to}</span>
										<span>
											Move <b>{sh.name}</b>{" "}
											<em className="decide-why">
												from {sh.from} to {sh.to}, to free the seat above
											</em>
										</span>
									</li>
								))}
							</ul>
							{/* Only where some seats ARE already right. With no seats read there is no
							    baseline, every row is a "start", and the count is zero — "your other 0
							    seats are already right" is a sentence about nothing. */}
							{(() => {
								const rest = Math.max(
									today.lineup.starters.length -
										today.start.length -
										today.shifts.length,
									0
								)
								return rest > 0 ?
										<p className="sub decide-rest">
											Your other {rest} {rest === 1 ? "seat is" : "seats are"} already
											right.
										</p>
									:	null
							})()}
						</>
					:	<p className="sub">
							Nothing to change — every seat already holds the right man for today.
						</p>
					}
					{/* The changes NOT offered, named. Without this the card looks like it found
					    fewer moves rather than like it refused to offer ones the platform will
					    reject, and a reader who remembers seeing a shortstop swap an hour ago
					    has no way to tell which of those two happened. */}
					{today.locked.length > 0 && (
						<p className="sub decide-locked">
							{today.locked.length === 1 ?
								<>
									<b>{today.locked[0]}</b>&rsquo;s game has started, so that seat is left
									as it is.
								</>
							:	<>
									{today.locked.length} of your seats have already started &mdash;{" "}
									{andList(today.locked)} &mdash; so they are left as they are.
								</>
							}
						</p>
					)}
					{/*
					  The seats that will score nothing, and the men who could stop that.
					  
					  This is the largest measured lever in a points-league season — never
					  leaving an allowed slot unused — and it was buried inside the seat-by-seat
					  disclosure below, described as "leave empty". Leaving it empty is the
					  right answer only if nobody gettable is playing; where somebody is, the
					  seat is worth about seven points a night and the upgrade a move usually
					  buys is worth about one.
					  
					  Both conditions are hard. He has to be free — or as free as the wire can
					  say, and the line under the moves says which — and he has to be on a card
					  TONIGHT, because a free agent who is not playing fills the seat with the
					  same zero it already has.
					*/}
					{fillTonight.length > 0 && (
						<>
							<h3 className="decide-head decide-fill-head">
								Empty seats
								<span className="decide-gain">
									{today.unfilled.length}{" "}
									{today.unfilled.length === 1 ? "seat scores" : "seats score"} nothing
									tonight
								</span>
							</h3>
							<ul className="decide-list decide-fill">
								{fillTonight.map(f => (
									<li key={`${f.slot}-${f.name}`}>
										<span className="decide-slot">{f.slot}</span>
										<span>
											Add <b>{f.name}</b>{" "}
											<em className="decide-why">
												{f.points} projected tonight{f.team ? ` · ${f.team}` : ""}
											</em>
										</span>
									</li>
								))}
							</ul>
							{/*
							  THE SEATS IT COULD NOT FILL, counted rather than left to be inferred.
							  
							  The heading says "4 seats score nothing tonight" and the list under it
							  named two. The other two had nobody: either no free man is eligible
							  there, or the ones who are are not on a card tonight, or one man was
							  the best answer for two seats and can only take one. A reader left to
							  work that out from a list that is shorter than its own heading reads
							  it as the app having run out of room.
							*/}
							{today.unfilled.length > fillTonight.length && (
								<p className="sub decide-fill-rest">
									{today.unfilled.length - fillTonight.length === 1 ?
										"The other seat has"
									:	`The other ${today.unfilled.length - fillTonight.length} have`}{" "}
									nobody: no free man eligible there is on a card tonight. Leaving{" "}
									{today.unfilled.length - fillTonight.length === 1 ? "it" : "them"} empty
									is the right answer.
								</p>
							)}
						</>
					)}
					<details className="decide-notes">
						<summary>The whole lineup, seat by seat</summary>
						<ul className="decide-list decide-today">
							{today.lineup.starters.map((st, i) => (
								<li key={`${st.slot}-${i}`}>
									<span className="decide-slot">{st.slot}</span>
									<span>
										<b>{st.name}</b> <em className="decide-why">{st.points} projected</em>
									</span>
								</li>
							))}
							{/* "Leave empty" is a recommendation, and it is only true when the seat
							    was actually contested. With nobody priced at all, every seat is
							    unfilled and this fold would advise emptying the whole lineup — the
							    same "could not answer" read as "answered no" that the section
							    above now guards. Unknown is said as unknown. */}
							{today.unfilled.map((slot, i) => (
								<li key={`empty-${slot}-${i}`} className="decide-empty">
									<span className="decide-slot">{slot}</span>
									<span>
										<em className="decide-why">
											{today.lineup.starters.length ?
												"leave empty — nobody you own is projected to play here today"
											:	"not priced — no projection could be made for anyone you own today"}
										</em>
									</span>
								</li>
							))}
						</ul>
					</details>
					{/* Two different things to say, because two different things are true. With
					    seats read off the platform there is a baseline and the list above is a
					    DIFF, which is only as good as the read's age. With a team entered by
					    hand there is no baseline at all — nobody knows which seats he has them
					    in — so the list is the lineup to set, and claiming to compare it against
					    something would be inventing the something. */}
					<p className="sub decide-read">
						{today.readAt ?
							/* One clause, with the age in it, because the age is the only part that
							   changes what the reader should do. The second sentence — "change your
							   lineup in Yahoo since then and this list is against the old one" —
							   restated the first for anyone who had already understood it. */
							/* "as read" was true of one of the two ways seats arrive and false of the
							   commoner one. A reader who TYPED his team forty seconds ago was told the
							   comparison was against seats "as read", which claims a platform read
							   that never happened — and on a phone, typing is the only route. The
							   age is the part that changes what he should do, so it stays; the verb
							   is now one that is true however the seats got here. */
							<>vs the seats you last gave it, {readAgo(today.readAt)}</>
						:	<>
								Nothing here knows which seats you currently have these men in, so this is
								the lineup to <b>set</b>, not the changes to make. Read your roster off
								your platform on <b>My league</b> and it becomes a list of changes.
							</>
						}
					</p>
					{/*
					  WHAT THIS CARD DOES NOT KNOW, said once, under the thing it qualifies.
					  
					  A heading reading "What should I do?" over nine instructions reads as
					  exhaustive, and a reader is entitled to assume that anything it has not
					  mentioned it checked and found unremarkable. Two of the biggest levers of a
					  head-to-head evening are not in that set and cannot be: grep across src/
					  finds nothing that reads a fantasy opponent's roster or a league scoreboard
					  — the only "opponent" anywhere in the client is the MLB club a hitter faces
					  — and Yahoo stopped answering the read that could have supplied it (see
					  commit de44045). So the app does not know the score, and down sixty with two
					  days left the right play is the high-variance arm while up sixty it is the
					  safe one, and this card gives the same answer in both.
					  
					  The absence is stated rather than fixed, which is the house rule. Fixing it
					  would mean a typed-in margin driving a re-sort by ceiling — a ranking change
					  with no measurement behind it, dressed as a feature.
					*/}
					<p className="sub decide-read">
						This reads tonight&rsquo;s schedule, the batting orders that have been posted
						and the injured list. It does not know your matchup or the score, so nothing
						above is playing for or against a lead.
					</p>
				</>
			)}

			{/**
			  * The period lineup, for leagues that set one.
			  *
			  * Hidden entirely where TODAY is answered above, and not to save space: the
			  * two contradict each other. A daily-lock league does not set a lineup for
			  * the week — it sets one every day — so a second list rearranging the same
			  * seats over six days is not a plan he can carry out, and it disagreed with
			  * the one he can. Today said bench Nolan McLean; this said move him from SP
			  * to P. Two answers to "who starts", on one card, for one team.
			  *
			  * The period still decides the MOVES below, because an add accrues over all
			  * of it. Only the lineup half is a daily question here.
			  */}
			{!today && (
				<>
			<h3 className="decide-head">
				Set your lineup
				{plan?.lineup && plan.lineup.gain > 0 && (
					<span className="decide-gain">+{plan.lineup.gain} pts, and it costs nothing</span>
				)}
			</h3>
			{!plan ? <p className="sub">No projection could be made for this period.</p>
			: plan.lineup.blocked ?
				<p className="sub">{plan.lineup.blocked}</p>
			: !plan.lineup.swaps.length && !plan.lineup.shifts.length ?
				<p className="sub">
					Already right — {plan.lineup.pointsNow} projected points, and no legal
					rearrangement of your own players beats it.
				</p>
			:	<ul className="decide-list">
					{plan.lineup.swaps.map(s => (
						<li key={`${s.start}-${s.sit}`}>
							{/* signed, not prefixed. The paired swaps come out of an index match and
							    the pairing can put a small loss beside a larger gain, which rendered
							    as "+-0.33". */}
							<span className="decide-delta">{s.gain > 0 ? `+${s.gain}` : s.gain}</span>
							{/*
							  `sit` is `string | null`, and null is a real and common case: the seat was
							  EMPTY, so nobody has to come out for him. This rendered the clause
							  unconditionally and printed "Start Matt McLain at 2B, sit " with an empty
							  <b> after it — observed verbatim on the published build's first visit.
							  A sentence that trails off where a name should be reads as a bug in the
							  data, and the honest version is better news than the broken one: an
							  empty seat is a free upgrade.
							*/}
							<span>
								Start <b>{s.start}</b> at {s.startSlot}
								{s.sit ?
									<>
										, sit <b>{s.sit}</b>
									</>
								:	" — the seat is empty, so nobody comes out"}
							</span>
						</li>
					))}
					{plan.lineup.shifts.map(s => (
						<li key={`shift-${s.name}`}>
							<span className="decide-delta decide-free">—</span>
							<span>
								Move <b>{s.name}</b> from {s.from} to {s.to}
							</span>
						</li>
					))}
				</ul>
			}

				</>
			)}

			<h3 className="decide-head">
				Make these moves
				{/* "2 of the 6 your league allows" reads as four left on the table. The cap
				    is the league's rule; the number actually proposed is a measured
				    finding — two moves a week beat one and beat three across 111 weeks and
				    five seasons — and a reader deciding whether to make a third deserves
				    to be told which is which. */}
				{plan && (
					<span className="decide-gain">
						{/* "2 worth making" would claim a third was weighed and rejected. It was
						    not: the planner stops at two because two is the cap, and two is
						    what measured best — beating one and beating three over 111 weeks and
						    five seasons.

						    "is what measured best" was too strong even so, the comment above
						    conceded exactly that, and then the string shipped it anyway. The fold
						    below says why it is too strong: that sweep was run against the OLD
						    scoring, before swaps were priced on the lineup that follows them, and
						    src/auto/plan.ts says in so many words that the cap is NOT YET
						    RE-MEASURED. A summary must not outrun the drawer it summarises — the
						    reader who never opens the fold is the one the claim reaches.
						    
						    The first attempt at the honest version said "a cap carried over from an
						    earlier version and not re-measured since", which is a fact about this
						    repository in a heading about baseball. What a reader needs is that the
						    number is a limit somebody chose rather than a finding, which is the
						    same information without the changelog. */}
						{plan.swaps.moves.length === 0 ? "none clear the bar"
						: plan.swaps.moves.length < DEFAULTS.maxMoves ?
							`${plan.swaps.moves.length} clear${plan.swaps.moves.length === 1 ? "s" : ""} the bar`
						:	`stopping at ${plan.swaps.moves.length}, which is this app's own limit and not a measured best`}
						{rules.cap !== null && ` · your league allows ${rules.cap}`}
					</span>
				)}
			</h3>
			{/* Gated on the CANDIDATES, not on the wire. Gated on the wire, this told a
			    reader with a perfectly good ownership estimate behind him that no add
			    could be judged, and sent him to a command line — which is the difference
			    between a website and a developer tool. It only says nothing where there
			    is genuinely nothing: no wire AND no usable ownership in the capture. */}
			{!candidates.length ?
				<p className="sub">
					No add can be judged here yet: nothing has read your league&rsquo;s free-agent
					list, and this capture&rsquo;s ownership figures cannot locate the boundary
					either, so there is no honest way to say who you could get.
				</p>
			: !plan?.swaps.moves.length ?
				/*
				  "None worth making." is the whole answer.
				  
				  It used to be followed by `plan.swaps.notes[0]`, which on a real 24-man roster
				  was a 470-character sentence naming 21 of those 24 players back at the reader,
				  printing the planner's own term for a threshold on the primary surface, and
				  asserting both halves of a contradiction about the same men — below the bar
				  that makes them droppable AND worth too much over the rest of the season to
				  give away. A manager scanning at 6:40 cannot tell which number governs.
				  
				  The note is not deleted; it is already in the fold below, which is where a
				  reader who wants the reasoning goes. What is removed is its appearance on the
				  line that answers the question. The "rest of the season" half of it is also the
				  clause that is inverted in an elimination week — the model knows nothing about
				  the playoffs, so the screen must stop making a claim that depends on them.
				*/
				<p className="sub">None worth making.</p>
			:	<>
					<ul className="decide-list">
						{plan.swaps.moves.map(m => (
							<li key={`${m.add}-${m.drop}`}>
								<span className="decide-delta">+{m.gain}</span>
								<span>
									Add <b>{m.add}</b>
									{m.seats?.length ?
										<span className="decide-seat"> for your {m.seats.join(" or ")} seat</span>
									:	null}
									{/* No drop clause when nothing is dropped. The planner only pairs an
									    add with a drop once every seat is taken — see `room` in
									    planSwaps — and printing ", drop —" or an empty <b> here is how a
									    card ends up telling somebody to drop Aaron Judge for nothing. */}
									{m.drop ?
										<>
											, drop <b>{m.drop}</b>
										</>
									:	<em className="decide-why"> &mdash; you have a free seat, so nobody comes out</em>}
								</span>
							</li>
						))}
					</ul>
					{/* Said once. Every move carried the same two clauses — what the gain is
					    denominated in, and why the man leaving can be spared — which on a
					    phone was an eight-line paragraph under each of two moves, most of it
					    identical. What differs per move is the gain and the seat, and those
					    are on the row. */}
					{/*
					  Four sentences became one clause and a disclosure.

					  The paragraph explained what the gain is denominated in, that every man
					  leaving is under the keep floor, that none is worth holding for the rest
					  of the season, and — where the wire is an estimate — the arithmetic behind
					  the ownership cut. All of it true, none of it a thing a reader does
					  anything differently about. What DOES change a decision is the one word
					  in front: whether the availability is read or estimated. That stays on the
					  line; the rest is one tap away.
					*/}
					{/* A <div>, not a <p>, because it holds a <details> — see the same note in
					    Board.tsx. */}
					<div className="sub decide-rest">
						{estimatedWire ?
							<b>Who is free is an estimate</b>
						: wireAge ?
							<>Your league&rsquo;s own free-agent list, read {wireAge}</>
						:	<>Points your lineup gains over this period</>}
						<details className="decide-fine">
							<summary>what these numbers are</summary>
							Each figure is what your starting lineup projects over this period with
							the move made. Everyone leaving is under the keep floor — no more than{" "}
							{DEFAULTS.keepFloor} points clear of what the wire still offers at his own
							slot — and none is worth holding for the rest of the season either.
							{estimatedWire ?
								<>
									{" "}
									Nothing has read your league&rsquo;s own free-agent list, so these are
									the men rostered in {estimatedWire.cut.cut}% of leagues or fewer — the
									boundary a {estimatedWire.cut.depth / estimatedWire.cut.seats}-team
									league with {estimatedWire.cut.seats} seats implies. Some will already
									be taken in yours.
								</>
							: wireAge ?
								<> Anyone picked up or dropped since is not in it.</>
							:	null}
						</details>
					</div>
				</>
			}

			{(rules.floor !== null || !!plan?.lineup.skipped.length) && (
				<>
					<h3 className="decide-head">Watch</h3>
					<ul className="decide-list decide-watch">
						{/* Two numbers that are NOT comparable, and used to be compared. The floor
						    is "min innings pitched per team per WEEK"; the projection is rated over
						    `resolvePeriod`, which starts TODAY, so it is what is LEFT of the week
						    and counts nothing already thrown. Set against each other they made a
						    verdict that decayed through the week for no reason — 34.6 innings on
						    the Friday, 20.1 on the Saturday, 10.1 on the Sunday against a fixed 20,
						    so the card read SHORT after six of seven days had been pitched.
						    Innings already thrown are on his team page, which nothing here opens,
						    so the verdict is gone and the two facts stand as what they are. */}
						{rules.floor !== null && rules.projected !== null && (
							<li>
								<span className="decide-note">·</span>
								{/* A <div>, not a <span>, because it holds a <details>. React only warns
								    about <details> inside <p>, so this one passed quietly — but <span> is
								    phrasing content and cannot legally contain flow content either, and
								    the rule is about what the markup MEANS, not about which violations a
								    framework happens to log. */}
								<div>
									Your league requires <b>{rules.floor} innings a week</b>.{" "}
									{/*
									  BOTH HALVES OF THE FLOOR, and the reason this sentence changed shape.
									  
									  It said only how many innings were still to come, which is the half
									  that cannot answer the question. Measured with the shipped league and
									  a real roster: "Your league requires 20 innings a week. Your pitchers
									  project 4 more over what is left of this period." A reader three days
									  into a week reads 4 against 20 and claims a panic streamer — the
									  single most expensive move available to him — when he may already
									  have banked fifteen. The same line also HALVED during one evening
									  with nothing having happened, because the window it counted shrank
									  while the fixed 20 did not.
									  
									  Now the banked innings lead, the projection follows, and the total is
									  the thing compared against the floor. Where the read has not landed
									  or could not be made, the old sentence is what survives — a missing
									  half is stated as missing, never as zero, because zero banked
									  innings is exactly the alarming reading that started this.
									*/}
									{banked !== null ?
										<>
											Your pitchers have thrown <b>{banked}</b> in it so far and project{" "}
											<b>{rules.projected} more</b> from their scheduled turns &mdash;{" "}
											<b>{Number((banked + rules.projected).toFixed(1))}</b> against{" "}
											{rules.floor}
											{rules.after !== null && rules.after !== rules.projected && (
												<>
													, or{" "}
													<b>{Number((banked + rules.after).toFixed(1))}</b> if you make the
													moves above
												</>
											)}
											.{" "}
										</>
									:	<>
											Your pitchers project <b>{rules.projected} more</b> over what is left
											of this period
											{rules.after !== null && rules.after !== rules.projected && (
												<>
													{" "}
													&mdash; <b>{rules.after}</b> if you make the moves above
												</>
											)}
											.{" "}
										</>
									}
									{/* One clause on the line, the rest a tap away. What a reader has
									    to know before acting is that this counts only what is STILL TO
									    COME; why it cannot count the rest is a fact about this page, not
									    about his week. */}
									{/* The clause is an <em> and the fold is its SIBLING, not its child:
									    <details> is flow content and cannot live inside phrasing content,
									    and a browser handed that quietly closes the <em> early — which
									    puts the fold outside the element it is styled inside. */}
									<em className="decide-why">
										{banked !== null ?
											"counted for every pitcher you hold now, whatever seat he was in at the time \u2014 which is the most this page can know"
										:	"still to come only, from their scheduled turns"}
									</em>
									<details className="decide-fine">
										<summary>{banked !== null ? "what these two numbers are" : "why not the whole week"}</summary>
										{/* The old version of this said "Innings already thrown this period are
										    on your team page, which nothing here reads — so this can tell you
										    what is left, not whether you will clear the floor." That was true
										    and is not any more: one `byDateRange` read covers the whole period
										    for every pitcher in baseball. The sentence is kept for the case
										    where the read did not land, because then it is true again. */}
										{banked !== null ?
											<>
												The innings already thrown come from MLB&rsquo;s own day-by-day
												record for this period, counted for every pitcher you hold now —
												so a man you added on Wednesday brings what he threw on Monday
												with him, which is the one direction this can be wrong in. The
												turns still to come are MLB&rsquo;s published probables, which
												are an announcement about a plan.
											</>
										:	<>
												Innings already thrown this period could not be read, so this can
												tell you what is left and not whether you will clear the floor.
												The turns themselves are MLB&rsquo;s published probables, which
												are an announcement about a plan.
											</>
										}
									</details>
								</div>
							</li>
						)}
						{/* Men on his roster the model could not price at all. They are neither
						    started nor offered up nor mentioned, which is the whole roster
						    quietly shrinking: the lineup above is planned as if he owned 22
						    players when he owns 24. An absence is stated as an absence. */}
						{skippedWhy.map(g => (
							<li key={g.why}>
								<span className="decide-note">·</span>
								<span>
									{g.men.length === 1 ? "One player" : `${g.men.length} players`} on your
									roster could not be priced, so nothing above counts{" "}
									{g.men.length === 1 ? "him" : "them"}: <b>{g.men.join(", ")}</b>.
									{/*
									  THE ENGINE'S OWN REASON, grouped — not one sentence invented here.
									  
									  This said "No projection could be made for them over this window"
									  about every skipped man. Measured on a league pasted with a batters
									  table and no pitchers table: it listed all eight pitchers under that
									  sentence, and the window was not the reason — the league scores
									  nothing on their side of the ball, which `rateAll` says in those
									  words and which My league already reported twice on its own screen.
									  `plan.lineup.skipped` has carried "Name: reason" all along and this
									  threw the reason away at the colon.
									*/}
									<em className="decide-why">{g.why}</em>
								</span>
							</li>
						))}
						{/* A DIFFERENCE of two projections needs no baseline, so this is the one
						    thing that can honestly be said about the moves and the floor together.
						    The old form compared each projection against the floor and could
						    therefore block a correct move on the same artefact as the line above. */}
						{rules.floor !== null &&
							rules.after !== null &&
							rules.projected !== null &&
							rules.after < rules.projected && (
								<li>
									<span className="decide-warn">COSTS</span>
									<span>
										Those moves give up{" "}
										<b>{Number((rules.projected - rules.after).toFixed(1))} innings</b> of
										what is still to come, and this league sets a floor. That is a real
										cost even where the line above cannot say where you stand against it.
									</span>
								</li>
							)}
					</ul>
				</>
			)}

			{/* How the answer was arrived at, under it rather than in it. These are the
			    planner's own notes — a search depth, a man it protected, a bar something
			    fell under. They are the audit trail for a recommendation the reader is
			    asked to act on, so they are not dropped; they are also not "watch items",
			    which is where they were, sitting beside an innings floor he can actually
			    be caught out by. */}
			{!!plan?.swaps.notes.length && (
				<details className="decide-notes">
					<summary>How this was decided</summary>
					<ul>
						{plan.swaps.notes.map(n => (
							<li key={n}>{n}</li>
						))}
						<li>
							Stopping at {DEFAULTS.maxMoves} a week is inherited rather than
							established: {DEFAULTS.maxMoves} beat one and beat three across 111 weeks
							and five seasons, but that sweep scored a swap as a difference of two
							bscores, and these are scored on what your lineup projects afterwards. No
							season has been played against this scoring yet.
						</li>
					</ul>
				</details>
			)}
		</section>
	)
}

