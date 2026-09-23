import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { hydrate } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { isReserveSlot, ownershipCut, rateAll, slotsFor } from "../engine/bscore.ts"
import { resolvePeriod, scoringEnd, shift, windowFrom } from "../engine/period.ts"
import { scoreStats, tableFor } from "../engine/points.ts"
import {
	activeSlots, freezeShut, isBench, planLineup, planSwaps, seatedInnings, DEFAULTS, type PlanInput
} from "../auto/plan.ts"
import { deriveInningsMinimum, deriveMoveLimit, deriveWaiverRule, leagueLimits } from "../import.ts"
import { freshness, tab } from "./panels.tsx"
import { canReadPool, api, poolIsPartial, type AvailablePool } from "./api.ts"
import { lineupStore } from "./lineup.ts"
import { ledgerStore } from "./ledger.ts"
import { pool as poolStore } from "./pool.ts"
import { roster } from "./roster.ts"
import { normalizeName } from "./useBoard.ts"
import { andList, indexByName } from "../data/names.ts"
import { useSlate } from "./useSlate.ts"
import { lastNight, useActuals } from "./useActuals.ts"
import type { Matchup } from "./useMatchup.ts"
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

/**
 * The one bench reason a paired row already states by naming the man taking the seat.
 *
 * Spelled once, because two places now have to agree about it: `today.bench` writes it
 * and the view suppresses it on a row that names an arrival — "Start Matt Olson at 1B,
 * over Alex Bregman · a better man is projected for that seat today" says the same thing
 * twice, and the second time in the vaguer words. Every OTHER bench reason (an injury, a
 * club not playing, a man left out of tonight's posted order) is news the row cannot
 * carry any other way, so only this one is dropped.
 */
const OUTRANKED = "a better man is projected for that seat today"

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
	matchup,
	onOpenTeam,
	only,
	onOpenTonight
}: {
	snapshot: Snapshot | null
	league: League | null
	leagueKey: string | null
	/** How the week stands, read once for the whole page — see src/client/useMatchup.ts.
	 *  This card uses the pitching half of it for the innings floor and the gap for the one
	 *  thing it could never say: whether he is ahead. */
	matchup: Matchup
	/** Why the player data could not be read, when it could not. */
	error: string | null
	/** Takes the reader to the one screen that always works, on every platform:
	 *  entering his own players. A card that says "add your players" and does not
	 *  take him there is a card that has told him to go and find something.
	 *
	 *  NULL MEANS SOMETHING ELSE ON SCREEN IS ALREADY ASKING. See the empty state
	 *  below: with no league of his own, the setup dock is on the page carrying the
	 *  same press under a different name, and this card stands down rather than
	 *  offering a second door to one room. */
	onOpenTeam: (() => void) | null
	/**
	 * "pickups" draws only the waiver half of this card, for the top of Pickups.
	 *
	 * Pickups used to answer "who should I add" on its own, three different ways at once:
	 * Billy's pick reduced on bscore, the list under it sorted by "for you", and the
	 * streaming horizon by raw points — while Tonight, from `planSwaps`, said something
	 * else again. Walked on the owner's league: Billy crowned Grant Taylor, the list put
	 * Jake Burger first and Taylor fourth, and Tonight said "Add Jake Burger, drop Sandy
	 * Alcantara". So Pickups now leads with THIS card's adds, computed by this component
	 * rather than copied, so the two screens cannot drift, and the board under it is the
	 * working rather than a fourth opinion.
	 */
	only?: "pickups"
	/** The way from the pickups card to the rest of the plan. */
	onOpenTonight?: () => void
}) => {
	const storedSeats = leagueKey ? lineupStore.of(leagueKey) : null
	/** Tonight, live, from MLB. One request, no server — see src/data/today.ts. */
	/*
	   `loading` IS THE THIRD STATE, and discarding it made a pending read look like a finished
	   one. `useSlate` answers slate, error and loading; the stale-capture notice below fires on
	   `error` alone, which is the app's correct handling of a read that FAILED. A read that has
	   not answered yet falls through to the same capture fallback with no sentence attached —
	   so for the first few seconds the card presented a ten-day-old schedule as tonight, with
	   no lock times, a different lineup and a different add, and then rearranged itself
	   unprompted. The comment above that notice says it in its own words: both feeds fall back
	   to the shipped capture, which is the right behaviour and the wrong thing to do silently.
	   The fix landed for the failed case and not for the pending one.
	*/
	/**
	 * THE NIGHT THIS CARD IS ABOUT, which is not always tonight.
	 *
	 * Yahoo prints "Daily - Today" and some leagues run the other daily form: the lineup
	 * you can still change is TOMORROW's, because tonight's locked at yesterday's deadline.
	 * On one of those, every sentence on this card was about a lineup nobody could change
	 * any more — a true reason about the wrong day, with no hedge on it.
	 *
	 * Null means the league did not say and nothing is assumed: the card plans tonight,
	 * exactly as it always has.
	 */
	const planning = league?.scoring_period?.locks ?? null
	const planningDay = planning === "tomorrow" ? shift(localDate(), 1) : localDate()
	/* The live schedule is read for the night being PLANNED, not for the night in progress.
	   This replaces the request rather than adding one. */
	const { slate, error: slateError, loading: slateLoading } = useSlate(planningDay)
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
	const {
		merged: liveInjuries,
		error: injuryError,
		uncoveredDays: injuryGap
	} = useInjuries(captured, snapshot?.capturedAt)
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
	/**
	 * The bare player ids the roster store holds, without the `:group` half of the key.
	 *
	 * Six places on this card now join a printed name to a board row, and the ids are what
	 * tell two men of one name apart — see `indexByName` in src/data/names.ts. Derived once
	 * rather than spelled `new Set(ownedIds.map(k => k.split(":")[0]))` at each of them,
	 * which is the duplication this file's own history keeps paying for: six copies of one
	 * key rule is six chances for one of them to drift.
	 *
	 * The `:group` half is deliberately dropped. A two-way player is ONE man the reader
	 * owns, stored under two keys, and a set keyed on the pair would answer "no" for
	 * whichever half of Ohtani the caller did not happen to ask about.
	 */
	const mineIds = useMemo(
		() => new Set(ownedIds.map(k => k.split(":")[0] ?? k)),
		[ownedIds]
	)
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
		const ownedNames = new Set<string>()
		const knownNames = new Set<string>()
		for (const p of snapshot?.players ?? []) {
			const n = normalizeName(p.name)
			knownNames.add(n)
			if (mineIds.has(String(p.id))) ownedNames.add(n)
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
				team: p.team ?? null,
				/* A roster derived from ids the reader owns has no page behind it, so there
				   is no league flag to read. Null, stated, rather than the field missing and
				   the two shapes disagreeing. */
				status: null as string | null
			}]
		})
		return spots.length ? { spots, at: null as string | null, known: false } : null
	}, [storedSeats, ownedIds, mineIds, snapshot])

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

	/**
	 * Which positions the free-agent read actually reached, so the seats it never looked at
	 * fall back to the whole-pool bar instead of to zero.
	 *
	 * Only from a REAL read: `estimatedWire` is the ownership estimate, which speaks for
	 * every man in baseball at once and has no positions to declare. Measured in the engine
	 * pass that added the guard — a wire truncated to four infield positions put a
	 * replacement bar of 0 under SP, RP and P, which credits every pitcher with his whole
	 * projected total and rearranged the top of the board around men nothing had looked for.
	 */
	const wirePositions = useMemo(
		() => (wire?.players.length ? (wire.positionsRead ?? null) : null),
		[wire]
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
				availablePositions: wirePositions ?? undefined,
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
	}, [snapshot, league, wireTest, wirePositions, injuries])

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

	/** Bumped when a lock passes, and a dependency of the memo below. See the timer that arms
	 *  it further down for why the card has to be able to re-derive itself on the clock alone,
	 *  with nothing upstream of it having changed. */
	const [crossed, setCrossed] = useState(0)

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
		const day = planningDay
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
		/**
		 * HIS SEATS, JOINED TO TONIGHT'S BOARD — one row per seat, chosen rather than
		 * collided.
		 *
		 * This was `new Map(rows.map(r => [normalizeName(r.player.name), r]))`, and a Map
		 * keeps the LAST row per key. Five keys collide on the committed capture (see
		 * `indexByName` in src/data/names.ts, re-derived 2026-09-22), so a seat reading
		 * "Luis Garcia Jr." at 1B got the relief pitcher of that name: his projection, his
		 * bscore, and his `player.teamId` — which is the field two lines of this card read
		 * to say when the seat locks. A lock time off the wrong club is advice about the
		 * wrong clock.
		 *
		 * The seat's own printed eligibility and the ids the roster store says are his are
		 * both known HERE and nowhere downstream, which is why the join is resolved once,
		 * up front, into the plain name→row map the rest of this memo already reads. A
		 * name that is still two men after both is put in `twoMen` and refused: the card
		 * would otherwise have to pick one, and picking is what this fixes.
		 */
		const board = indexByName(rows, r => r.player)
		const byName = new Map<string, (typeof rows)[number]>()
		/** Seats whose printed name is two different players on the board. Kept apart from
		 *  `unmatched` because "we cannot find him" and "we found two of him" are different
		 *  things to be told, and only the second is the reader's to fix. */
		const twoMen: string[] = []
		for (const sp of seats.spots) {
			const got = board.pick(sp.name, { positions: sp.positions, owned: mineIds })
			if (got.row) byName.set(normalizeName(sp.name), got.row)
			else if (got.why === "ambiguous") twoMen.push(sp.name)
		}
		/** What MLB says about each man tonight, where the live read succeeded. */
		const liveStatus = new Map<string, TodayStatus | null>()
		const playing = new Set<string>()
		/** Men MLB has actually put in tonight's card — a published batting order or an
		 *  announced start. A claim, not a silence. */
		const placed = new Set<string>()
		/** Men in startable seats MLB has left out of tonight's posted order. */
		const scratched: string[] = []
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
				/* A seat refused for ambiguity is not a seat the board has no row for, and it
				   must not be counted as one: the two have different sentences and only one of
				   them is true. */
				if (!isReserveSlot(sp.slot) && !twoMen.includes(sp.name)) unmatched.push(sp.name)
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
			/*
			   A SCRATCH IS NOT AN OPTIMISATION, so it does not queue behind the optimisations.
			   
			   A man MLB has left out of tonight's posted order, sitting in a startable seat, is
			   the single most actionable thing this screen can say in an evening: that seat
			   scores nothing unless the reader moves, and unlike every other row on the card it
			   is a FACT rather than a ranking. It was reaching him grouped with everybody else
			   under "not in today's lineup", below the change rows, in a list ordered by lock
			   time — findable, and not led with.
			   
			   Only men in seats that can score. `isReserveSlot` covers the bench and the injured
			   list both, which is the right test here: a scratch on the bench is not news.
			*/
			if (live?.kind === "benched" && !isReserveSlot(sp.slot))
				scratched.push(sp.name)
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
		/*
		   HOW MUCH OF TONIGHT HAS ALREADY HAPPENED, counted in games rather than guessed at.
		
		   Three states per game and they are three different sentences: a club of his that is
		   FINAL has everything it is going to have, one that is UNDERWAY is still adding, and
		   one still TO COME has not contributed anything. The same three decide whether the
		   running total below is worth reading at all, whether it is still worth asking for,
		   and whether it has become a fact.
		
		   Called-off games are excluded here as everywhere else on this card: a postponed game
		   is not a game he is waiting on.
		*/
		/*
		   A GAME THAT WAS CALLED OFF IS NEWS, and the card computed it and never said it.
		
		   `src/data/today.ts` has parsed postponements, suspensions and cancellations into
		   `slate.called` since the day a postponed game was seating men — and its own comment
		   says the games "stay in `games` so a screen can SAY a game was called off". No screen
		   did. The only trace was the game COUNT going down by one, which a reader cannot
		   distinguish from a light Wednesday.
		
		   It matters at two different moments. Before the seat locks, it is the one change that
		   is free: a man whose game has gone is a guaranteed zero, and anybody playing beats
		   him. Afterwards, it is the difference between a seat he got wrong and a seat nothing
		   could be done about — which is what stops him going to look for the mistake.
		
		   Named for men in STARTABLE seats only. A bench man whose game is off costs him
		   nothing, and a card that reports it is a card that reports the weather.
		*/
		const calledOff: string[] = []
		for (const sp of seats.spots) {
			if (isReserveSlot(sp.slot) || isBench(sp.slot)) continue
			const id = byName.get(normalizeName(sp.name))?.player.teamId
			if (typeof id !== "number" || !slate) continue
			if (slate.games.some(g => slate.called.has(g.gamePk) && (g.homeTeamId === id || g.awayTeamId === id)))
				calledOff.push(sp.name)
		}
		const clubs = new Set<number>()
		for (const sp of seats.spots) {
			const id = byName.get(normalizeName(sp.name))?.player.teamId
			if (typeof id === "number") clubs.add(id)
		}
		const mine = (slate?.games ?? []).filter(
			g =>
				!slate?.called.has(g.gamePk) &&
				(clubs.has(g.homeTeamId) || clubs.has(g.awayTeamId))
		)
		const isFinal = (st: string): boolean => /^(Final|Game Over|Completed)/i.test(st)
		/* Its own read of the clock rather than the `now` the freeze uses, because that one is
		   declared a hundred lines further down this memo and reaching forward to it is a
		   temporal-dead-zone crash — which is exactly what the first version of this block was.
		   Both are fresh: the whole memo re-derives when a lock passes. */
		const atNow = Date.now()
		const started = (g: { homeTeamId: number }): boolean =>
			!!slate && (lockFor(g.homeTeamId, slate) ?? Infinity) <= atNow
		const mineGames = {
			final: mine.filter(g => isFinal(g.state)).length,
			underway: mine.filter(g => !isFinal(g.state) && started(g)).length,
			toCome: mine.filter(g => !isFinal(g.state) && !started(g)).length
		}
		/* Hoisted: the seat list is now read twice — once to find the seats nobody filled,
		   and once to walk slot by slot pairing who leaves each seat with who takes it. */
		const seatOrder = activeSlots({
			slots: league.roster.slots,
			slot_order: league.roster.slot_order,
			slot_accepts: league.roster.slot_accepts
		})
		const used = new Map<string, number>()
		for (const st of lineup.starters) used.set(st.slot, (used.get(st.slot) ?? 0) + 1)
		const unfilled: string[] = []
		for (const slot of seatOrder) {
			const left = used.get(slot) ?? 0
			if (left > 0) used.set(slot, left - 1)
			else unfilled.push(slot)
		}
		/**
		 * THE SEATS BEFORE AND THE SEATS AFTER, indexed by slot — which is what turns a
		 * bench row into a move a manager can make.
		 *
		 * `arrivesAt` is used twice below and it is the same question both times: does
		 * anybody go into a seat of this kind who was not in one before? A man who moves
		 * from one of his own seats to another counts, and that is the case this card had
		 * no way to see. `today.start` holds only men coming off the BENCH, and on a real
		 * 27-man imported roster (2026-09-23) it held ONE row while nine men were told to
		 * sit: Matt Olson went SP→1B, Junior Caminero Util→3B, Zach Neto P→SS, Rafael
		 * Devers P→Util, Yordan Alvarez RP→Util and Pete Crow-Armstrong C→OF, and the card
		 * mentioned none of them. It said "Bench Alex Bregman 1B" and never said Olson was
		 * taking the seat. `lineup.shifts` does not rescue it either — `planLineup` empties
		 * `swaps` AND `shifts` whenever the best legal lineup does not clear `lineupMinGain`
		 * (see the early return in src/auto/plan.ts), which on that roster it did not, by
		 * -144.42, while `starters` still described the rearrangement.
		 *
		 * So the pairing is read off `lineup.starters` — the planner's own statement of who
		 * sits where afterwards — against the seats as they were read. Nothing is inferred
		 * and no seat is reordered to manufacture a pair.
		 */
		const beforeBySlot = new Map<string, string[]>()
		for (const sp of seats.spots) {
			if (isReserveSlot(sp.slot) || isBench(sp.slot)) continue
			beforeBySlot.set(sp.slot, [...(beforeBySlot.get(sp.slot) ?? []), normalizeName(sp.name)])
		}
		const afterBySlot = new Map<string, typeof lineup.starters>()
		for (const st of lineup.starters)
			afterBySlot.set(st.slot, [...(afterBySlot.get(st.slot) ?? []), st])
		/** Men the plan seats at `slot` who were not in a seat of that kind before. */
		const arrivesAt = (slot: string): typeof lineup.starters =>
			(afterBySlot.get(slot) ?? []).filter(
				st => !(beforeBySlot.get(slot) ?? []).includes(normalizeName(st.name))
			)
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
		/* The arithmetic of all three, and the reasons, are in `freezeShut` in
		   src/auto/plan.ts — it is about a plan rather than about a screen, and putting it
		   there is what let test/auto.mjs reach the case a card cannot easily produce. */
		/**
		 * EVERY MAN THE CARD HAS A ROW FOR, which is more men than it used to be.
		 *
		 * `named` was the men coming off the bench and the men going onto it. That was the
		 * whole card once; it is not now. A man already in an active seat who moves to a
		 * better one is an instruction too — "Start Matt Olson at 1B" — and his own first
		 * pitch closes that seat exactly as it closes anybody else's. Left out of `named` he
		 * was never frozen, so the card went on offering a seat change the platform had
		 * already refused, and never appeared in the sentence that says which changes it has
		 * stopped offering. Caught by test/decide.mjs's two-page freeze comparison once that
		 * suite started picking its mover out of the arrivals.
		 */
		const arriving = [...new Set(seatOrder)].flatMap(slot => arrivesAt(slot))
		const { frozen, stuck, shifts: offeredShifts, lostToLocks } = freezeShut(
			lineup,
			[
				...startAll.map(st => st.name),
				...benchAll.map(sp => sp.name),
				...arriving.map(st => st.name)
			],
			shut
		)
		const bench = benchAll.filter(sp => !frozen.has(normalizeName(sp.name)))
		const start = startAll.filter(st => !frozen.has(normalizeName(st.name)))
		/** Men whose seats the platform has already closed, so the card can say the
		 *  changes it is NOT offering rather than look like it found fewer. */
		/* Only men whose OWN game has started: the sentence this feeds says exactly that, and
		   a man held back because somebody else cannot move is in `stuck` instead, with the
		   reason that is true of him.
		
		   IT CARRIES THE DEADLINE RATHER THAN THE EVENT. The sentence used to say "his game has
		   started", which is not the fact the code has: what it knows is that the scheduled
		   first pitch has passed, and a rain-delayed 7:05 game is locked on the platform while
		   MLB still calls it Pre-Game. The time is what a reader can check against his own
		   clock, and it is the thing that actually closed the seat. */
		const lockAt = (name: string): number | null =>
			slate ? lockFor(byName.get(normalizeName(name))?.player.teamId, slate) : null
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
		const benchRows = bench.map(sp => {
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
					/* Ahead of the unmatched sentence, because it is the more specific of the
					   two and the only one that is actionable: the reader can look at his own
					   roster and see which Max Muncy he has. Saying "no projection exists for
					   that name" about a name the board holds two rows for would be false. */
					twoMen.includes(sp.name) ?
						"two different players go by that name, so nothing here can say which is yours"
					: !r || unmatched.includes(sp.name) ?
						"he is not on the board — no projection exists for that name"
					: live && live.kind === "no-game" ? "no game today"
					: live && live.kind === "benched" ? "not in today's lineup"
					/* What HIS league says, which is a fact about his own page and is
					   therefore ahead of anything derived. It names the day-to-day and the
					   minors, which MLB's feed does not keep. */
					: sp.status ? `Yahoo has him ${sp.status}`
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
					/*
					 * "A BETTER MAN" HAS TO BE A MAN, and for most of these rows there was
					 * nobody.
					 *
					 * This was the last-resort branch for anyone rateable, playing and not
					 * seated, and it asserted that somebody better had taken his seat.
					 * Measured on a real 27-man imported roster (2026-09-23): five men got
					 * this sentence and for four of them the seat ended up EMPTY — Bregman
					 * at 1B, Tucker at 3B, Busch at SS and Greene at OF, on a card that
					 * said in its own next block that eight seats would score nothing. A
					 * reader who goes looking for the better man finds an empty seat, which
					 * is the app being wrong about a fact rather than merely unhelpful.
					 *
					 * `arrivesAt` is the test, and it is the planner's own answer: somebody
					 * the plan seats at that slot who was not in a seat of that kind before.
					 * Where there is one the old sentence is true and it stays. Where there
					 * is not, what is true is smaller and is said instead — he is not in the
					 * best legal lineup and nothing you own fills the seat behind him. The
					 * row this reason renders in no longer claims a gain either; see
					 * `seatMoves`.
					 */
					/*
					 * HIS SEAT, WHICH THIS APP DOES NOT BELIEVE IN, ahead of any ranking —
					 * because it is a fact about the data rather than a judgement about the man,
					 * and because it is the row a reader should weigh against his own eyes
					 * before acting on it.
					 *
					 * `rateAll` prices him and `planLineup` can seat him nowhere, so he leaves
					 * the lineup whatever his projection says. Telling him a better man has the
					 * seat would be true of the plan and false about the reason: the plan did
					 * not outrank him, it could not keep him. See `misseated` in
					 * src/auto/plan.ts for what puts a man here and for the measurement.
					 */
					: lineup.misseated.some(m => normalizeName(m.name) === normalizeName(sp.name)) ?
						/* The FACT, in five words. What it means — that this app's eligibility may
						   simply be narrower than his league's, and that these rows are therefore
						   worth less than the rest — is one sentence in the watch fold, said once,
						   rather than twenty-three words repeated on every affected row. */
						`no record here that he may play ${sp.slot}`
					: arrivesAt(sp.slot).length ? OUTRANKED
					:	"nobody you own can legally fill that seat tonight, so it stays empty either way"
			}
		})

		/**
		 * ONE ROW PER SEAT, both halves of it — the shape this card was missing.
		 *
		 * A bench with no replacement is not a move a manager can make. Measured on a real
		 * 27-man imported roster (2026-09-23) the card benched ten men, named a starter for
		 * one of them, and then said in a separate block twelve seats would score nothing:
		 * the same fact stated twice from opposite directions, with the half that tells him
		 * what to DO missing from both. `seatMoves` is the join — for each kind of seat, who
		 * the planner puts in it and who comes out of it.
		 *
		 * THE PAIRING IS THE ENGINE'S, NEVER THIS FILE'S. `arrivesAt` reads
		 * `lineup.starters`, which is the planner's own statement of who ends up where, and
		 * `out` is `benchRows`, which is the men the planner left out. Nothing is matched by
		 * value, nothing is reordered to make the counts line up, and a seat whose arrival
		 * cannot be named gets no arrival rather than a guessed one — see the `over an empty
		 * seat` branch in the view.
		 *
		 * WHY WHOLE GROUPS RATHER THAN PAIRS. A slot with three seats (OF here, P and Util
		 * in most leagues) cannot say WHICH of two departing outfielders the arriving man
		 * displaced, because the engine did not decide that and the two seats are the same
		 * seat. So the row names every arrival and every departure at that slot in one
		 * sentence — "Start A at OF, over B and C" — which is exactly what the planner
		 * claims and is still one instruction the reader can carry out. Pairing them 1:1 in
		 * list order would have read better and would have been invented.
		 *
		 * Frozen men are dropped from `in` for the same reason they are already dropped from
		 * `out`: the platform will refuse the change, and `locked` and `stuck` below say so
		 * in their own words.
		 */
		const seatedAt = new Map(lineup.starters.map(st => [normalizeName(st.name), st.slot]))
		const seatMoves = [...new Set(seatOrder)].flatMap(slot => {
			const arriving = arrivesAt(slot).filter(st => !frozen.has(normalizeName(st.name)))
			const leaving = benchRows.filter(b => b.slot === slot)
			/*
			   A SEAT ITS OCCUPANT LEFT FOR ANOTHER SEAT IS NOT AN EMPTY SEAT.
			
			   Without this the row for a slot somebody vacated by moving elsewhere read "over
			   an empty seat", which is false in exactly the direction that matters: the reader
			   looks at his C seat, finds Pete Crow-Armstrong in it, and the card has told him
			   it was free. The destination is named because it is the only thing that makes
			   the two rows add up — he sees the man again three rows down, arriving somewhere
			   else, and now knows why.
			*/
			const moved = (beforeBySlot.get(slot) ?? []).flatMap(n => {
				const to = seatedAt.get(n)
				if (to === undefined || to === slot) return []
				const sp = seats.spots.find(x => normalizeName(x.name) === n)
				return sp && !frozen.has(n) ? [{ name: sp.name, to }] : []
			})
			/*
			   AND A SEAT SOMEBODY LOCKED CANNOT BE HANDED TO ANYBODY.
			
			   `leaving` is freeze-filtered — a man whose game has started is not offered up —
			   so a slot whose departure is frozen came back with an empty `out`, and the row
			   then took the last branch and said "over an empty seat" about a seat he was
			   still sitting in. Seen on the built card at 13:40: "Start Pete Crow-Armstrong at
			   OF — over an empty seat" with Riley Greene in one of the three OF seats and his
			   1:10pm lock an hour past.
			
			   The room a slot really has is its free seats plus the men who can still leave it,
			   and an arrival beyond that is a move the platform will refuse. Suppressed rather
			   than reworded: `locked` already names the man whose seat closed, which is the one
			   thing the reader can do something about, and offering the arrival anyway would be
			   an instruction he cannot carry out. Best first, so what survives is the arrival
			   worth most.
			*/
			const room =
				seatOrder.filter(x => x === slot).length -
				(beforeBySlot.get(slot)?.length ?? 0) +
				leaving.length +
				moved.length
			const offered = [...arriving].sort((a, b) => b.points - a.points).slice(0, Math.max(room, 0))
			if (!offered.length && !leaving.length && !moved.length) return []
			return [{
				slot,
				in: offered.map(st => ({
					name: st.name,
					points: st.points,
					/* When this seat stops being changeable — the only thing on the row that
					   expires, and the reason the old start rows were sorted by it. */
					lock: lockAt(st.name)
				})),
				out: leaving.map(b => ({ name: b.name, why: b.why })),
				moved
			}]
		})

		const locked = [
			...new Map(
				[...startAll, ...benchAll, ...arriving]
					.filter(m => shut(m.name))
					.map(m => [m.name, { name: m.name, at: lockAt(m.name) }] as const)
			).values()
		]
		return {
			day, lineup, idle, unmatched, twoMen, unfilled, playing: playing.size, locked, stuck, mineGames,
			/**
			 * Men in an active seat this league's rules do not grant them — see `misseated`
			 * in src/auto/plan.ts for the measurement that put it there.
			 *
			 * It is the reason the planned total can be lower than the reader's own: their
			 * points are in the lineup he has and in no seat of the one the planner builds.
			 * Carried out because the card has to be able to SAY that rather than let two
			 * numbers disagree in silence, and because it is the one caveat that tells him
			 * which rows to weigh against his own eyes.
			 */
			misseated: lineup.misseated,
			/** Every seat that changes hands tonight, arrivals and departures joined. The
			 *  view renders this and no longer walks `bench`, `start` and `shifts` as three
			 *  separate lists — see the note where it is built. */
			seatMoves,
			/** Men leaving an active seat, with the engine's reason. Still carried whole
			 *  because the ledger records what Billy asked to be sat, and `skippedWhy`
			 *  dedupes against it — neither wants the seat-level grouping. */
			bench: benchRows,
			calledOff,
			/** What the lineup reaches if the reader does everything the card still offers.
			 *  Equal to `lineup.pointsPlanned` when nothing is frozen. */
			pointsReach: Number((lineup.pointsPlanned - lostToLocks).toFixed(2)),
			placed: placed.size,
			scratched,
			waiting: waiting.size,
			/** Whether the live read answered at all. With no slate there is nothing to
			 *  split a headcount on and the header says the one number it has. */
			live: !!slate,
			/** Seat changes within the lineup, minus any man whose game has started —
			 *  see the note on `frozen` above; a shift is a change to HIS seat, so only
			 *  his own lock can stop it.
			 *
			 *  NO LONGER RENDERED AS ROWS OF ITS OWN. A shift is an arrival at the seat the
			 *  man moves INTO, so `seatMoves` carries it where the reader needs it — "Start
			 *  Matt Olson at 1B, and sit Alex Bregman" rather than a "Move Olson from SP to
			 *  1B" row three rows away from the bench row it explains. It is kept because it
			 *  is a list of men the card has named, which is what stops the same man being
			 *  explained a second time in the could-not-be-priced note. */
			shifts: offeredShifts,
			/** Nobody has said whether this league locks daily, so these changes are
			 *  offered on the assumption that it does — which the heading states. */
			assumedDaily: !league.scoring_period?.lineup_lock,
			/** Which night these changes are for. "tomorrow" means tonight's lineup has
			 *  already locked in this league, so the heading says so rather than claiming
			 *  a night the reader cannot act on. */
			planning,
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
			 * HOW MANY OF HIS SEATS THIS PAGE HAS BEEN GIVEN, against how many the league says
			 * he has. Null unless the two are both known and the second is larger.
			 *
			 * The setup sheet invites him to enter only his starters — "Only got a few? Start
			 * with your starters. You can add the rest later" — and then every seat he skipped
			 * is counted as a hole. Measured: thirteen names pasted into a twenty-seven-seat
			 * league produced "7 seats score nothing tonight" and three waiver adds. If he
			 * really holds thirteen men those adds are the most valuable thing on the page, so
			 * the defect is not the advice: it is that the card derives a free seat from a list
			 * length the reader was told he could truncate, and says nothing about where the
			 * length came from. The fix is to state the provenance where the claim is made.
			 */
			partial:
				!seats.at && league.roster.counts && seats.spots.length < league.roster.counts.total ?
					{ given: seats.spots.length, total: league.roster.counts.total }
				:	null,
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
	}, [snapshot, league, seats, slate, injuries, crossed, mineIds])

	/*
	 * THE CARD IS DERIVED AT A MOMENT, AND THE MOMENT HAS TO BE NOW.
	 *
	 * `const now = Date.now()` sits inside the `today` memo, whose deps are the snapshot, the
	 * league, the seats, the slate and the injuries. Nothing in the page ticks, so every
	 * answer that depends on the clock — which seats are frozen, what the plan can still
	 * reach, the "next lock 7:05pm" in the header, the order the change rows are sorted in —
	 * was re-derived only when one of those five changed. In practice that meant waiting for
	 * MLB to flip a game Pre-Game → In Progress and then up to 180 seconds of poll latency,
	 * so a reader could be offered a seat the platform had already closed minutes earlier.
	 * This is the specific failure the slate's poll was written to end, surviving in the
	 * consumer.
	 *
	 * ONE TIMER, ARMED AT THE NEXT LOCK, not an interval. The moments at which the answer
	 * changes are known exactly — they are the first pitches of the clubs his men are on, and
	 * `nextLock` already picks the earliest one still ahead. So staleness goes to about a
	 * second, and the 1,446-player re-rate happens once per lock boundary instead of sixty
	 * times an hour on a phone. Re-armed on `visibilitychange` as well, because a suspended
	 * tab's timer does not fire and the commonest way to read this card is to come back to it.
	 */
	useEffect(() => {
		const at = today?.nextLock
		if (at == null) return
		let timer = 0 as unknown as ReturnType<typeof setTimeout>
		const arm = (): void => {
			clearTimeout(timer)
			timer = setTimeout(() => setCrossed(c => c + 1), Math.max(0, at - Date.now()) + 1_000)
		}
		arm()
		document.addEventListener("visibilitychange", arm)
		return () => {
			clearTimeout(timer)
			document.removeEventListener("visibilitychange", arm)
		}
	}, [today?.nextLock])

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
		/* Capped at the last day his league scores, where its own page says one — see
		   `scoringEnd`. Nothing to rank past it: those games happen and his league does not
		   pay for them. */
		const w = windowFrom(h.slate ?? [], today, scoringEnd(league, h.seasonEnd))
		if (!w.games.size) return new Set<string>()
		const rows = rateAll({
			players: h.players, league, available: wireTest, availablePositions: wirePositions ?? undefined,
			teamGamesPlayed: h.teamGamesPlayed,
			gamesByTeam: w.games, opponentsByTeam: w.opponents,
			recentVolumeByWindow: h.recentVolumeByWindow, recentStats: h.recentStats,
			ownership: h.ownership, eligibility: h.eligibility, underlying: h.underlying,
			injuries, injuryPolicy: "keep", teams: league.meta.max_teams
		})
		/* WALKED FROM THE SEATS, not from the board. This looped every rated row and asked
		   whether its name was one of his, which made the board's own duplicate names the
		   deciding vote: either Max Muncy's rest-of-season value could protect the other,
		   because the only thing the two were compared on was a string. Asking the seat
		   instead lets the join use the eligibility printed beside it and the ids the
		   roster store holds — see `indexByName`. Rateable rows only, so a man with no
		   projection cannot shadow the man who has one. */
		const board = indexByName(
			rows.filter(r => r.rateable),
			r => r.player
		)
		const keep = new Set<string>()
		for (const sp of seats.spots) {
			const got = board.pick(sp.name, { positions: sp.positions, owned: mineIds })
			/* PER TEAM GAME, which is the unit `keepFloor` is in — see `PlanOptions`. This
			   read `r.bscore`, a rest-of-season TOTAL, against a 1.9-a-game bar, so on the
			   committed capture (re-derived 2026-09-22, median 18 team games remaining) it
			   protected 170 of the top 270 men where the per-game reading protects 40. That
			   set is handed to `planSwaps` as `protect`, so it compounded with the same
			   defect inside the planner: a quadrupled protect set on top of a halved
			   droppable one, which is why the card could offer adds and almost never an
			   add/drop. Revert it and the season horizon swallows the roster again. */
			if (got.row && (got.row.bscorePerGame ?? 0) >= DEFAULTS.keepFloor)
				keep.add(normalizeName(sp.name))
		}
		return keep
	}, [snapshot, league, seats, wireTest, injuries, mineIds])

	/*
	  MOVED ABOVE THE PLAN, because the plan now uses it.
	
	  `banked` is the innings this reader's pitchers have actually thrown inside the league's
	  own scoring period, from MLB's day-by-day record. It sat below the planner and was
	  rendered on the card; the planner's innings note meanwhile ended "worth checking against
	  what you have already thrown", which is the app handing a reader a subtraction it had
	  the other half of two hundred lines away.
	*/
	/*
	  ONE READ FOR THE WHOLE PAGE, and this card no longer makes its own.
	
	  It used to ask `byDateRange` for the pitching side of the league's period, to say how
	  many innings had been banked against the floor — and the recap card asked for the same
	  window, the same league and the same group a few hundred lines away, because neither
	  knew about the other. `useMatchup` holds the one read, and the gap it also computes is
	  what this card gets out of the change.
	*/
	const periodStart = rated?.period.periodStart ?? null
	const thrown = { lines: matchup.lines }
	/**
	 * WHAT HIS LINEUP HAS ACTUALLY SCORED TONIGHT, which no screen in this app could say.
	 *
	 * Every number on this card is a projection, and at nine in the evening the one thing a
	 * manager wants is the running total. The recap is hard-wired to yesterday — correctly,
	 * it is the morning-after screen — so between the first pitch and midnight the app knew
	 * nothing at all about what was happening.
	 *
	 * GATED ON HIS OWN GAMES, not on the clock. Before the first of them starts, the read is
	 * worthless and is not made: `byDateRange` for a date with no games played answers in
	 * about 500 bytes of empty splits, and a man missing from it is "did not play" rather than
	 * zero, which would make a pre-game total look like a shut-out.
	 *
	 * POLLED WHILE, AND ONLY WHILE, ONE OF HIS GAMES IS LIVE. A total that never moves is
	 * worse than no total — a reader checks it, sees the same figure, and concludes nothing is
	 * happening. At the same 180s cadence as the slate, so the two live reads on this screen
	 * stay in step. Once his last game is final the number is a fact and asking again cannot
	 * change it, so the poll stops.
	 *
	 * NOTHING ABOUT TONIGHT MAY REACH THE LEDGER. `settle` writes a verdict once and never
	 * asks again, which is why the recap gates it on `dayIsFinal`; this read is on a different
	 * date and never touches that path.
	 */
	const liveGames = today?.mineGames ?? null
	const tonightStarted = !!liveGames && liveGames.final + liveGames.underway > 0
	const tonightDone = !!liveGames && liveGames.underway === 0 && liveGames.toCome === 0
	const sofar = useActuals(
		typeof snapshot?.season === "number" ? snapshot.season : null,
		localDate(),
		tonightStarted,
		tonightStarted && !tonightDone ? 180_000 : 0
	)
	/**
	 * HIS LINEUP'S OWN TOTAL, or his men's where nobody has told this page the seats.
	 *
	 * Two numbers and a comma, and deliberately no arithmetic between this and the
	 * projection: this league pays -3 for an earned run, so tonight's figure can go DOWN, and
	 * the projection covers seats whose games are already over. "43 of 112" and "on pace for"
	 * are both claims the data cannot carry.
	 */
	const scoredTonight = useMemo((): { points: number; lineup: boolean } | null => {
		if (!sofar.actuals || !league || !seats?.spots.length || !today) return null
		/* A half-read evening is not a running total: with the hitting side missing, every bat
		   he has looks like a man who has not come up yet. Same rule as the recap's. */
		if (sofar.missing.length) return null
		/* The seat's own eligibility and the reader's ids pick the row, because the line it
		   leads to is keyed `${id}:${group}` — the wrong Luis García here does not fail to
		   score, it scores somebody else's night into this reader's total. A name that is
		   still two men contributes nothing, which is the same silence a man with no line
		   gets one branch down: an understated total beats a confidently wrong one. */
		const board = indexByName(today.ratedToday, r => r.player)
		let sum = 0
		let any = false
		for (const sp of seats.spots.filter(sp => !isReserveSlot(sp.slot))) {
			const r = board.pick(sp.name, { positions: sp.positions, owned: mineIds }).row
			if (!r) continue
			const line = sofar.actuals.lines.get(`${r.player.id}:${r.player.group}`)
			if (!line) continue
			any = true
			sum += scoreStats(line.stats, tableFor(league, r.player.group), r.player.group).points
		}
		return any ? { points: Number(sum.toFixed(1)), lineup: !!seats.at } : null
	}, [sofar.actuals, sofar.missing, league, seats, today, mineIds])

	/** Seated names to pitching ids, off the capture rather than off the rating, so a man in a
	 *  seat still counts toward the innings he has thrown even on a day the rating skipped
	 *  him — which is every day he is hurt, and exactly when a floor starts to bite. */
	/* An INDEX rather than a Map, and here the ids are the only thing that can decide: the
	   capture holds two pitchers called Yunior Marte (#805074 and #628708) and the group
	   test cannot separate them, so `m.set(name, p.id)` silently banked one man's innings
	   against the other's seat. That is a number a reader compares to his league's floor
	   and acts on. Where the roster store is empty there is nothing to choose with and the
	   seat contributes nothing, which understates rather than misattributes. */
	const pitchersByName = useMemo(
		() => indexByName((snapshot?.players ?? []).filter(p => p.group === "pitching"), p => p),
		[snapshot]
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
		/*
		   ONLY THE MEN IN SEATS, because only they throw innings that count.
		
		   This summed every pitcher the reader HOLDS, and the floor it is compared against is a
		   quantity about his lineup: `seatedInnings` in src/auto/plan.ts sums seats alone, and
		   its own comment records summing the whole staff reporting 82.5 against a floor of 20
		   — a comfortable pass built out of four pitchers on the bench. The same mistake made
		   here is worse, because it is the reassuring direction: "with 211.2 already thrown that
		   still lands clear of your league's 20" about innings that never counted toward it.
		
		   Seats come from the lineup store, so a team with no seats read has no seated total and
		   the honest answer is null rather than the whole staff's.
		*/
		const seated = seats?.spots.filter(sp => !isReserveSlot(sp.slot)) ?? []
		if (!seated.length) return null
		const seatedKeys = new Set<string>()
		for (const sp of seated) {
			const p = pitchersByName.pick(sp.name, { owned: mineIds }).row
			if (p) seatedKeys.add(`${p.id}:pitching`)
		}
		let outs = 0
		for (const k of seatedKeys) outs += thrown.lines.get(k)?.stats.outs ?? 0
		return Number((outs / 3).toFixed(1))
	}, [thrown.lines, seats, pitchersByName, periodStart, mineIds])


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
			/* The one piece of evidence that separates two men of the same name in the same
			   group — the two Max Muncys in the capture — and the browser is the only caller
			   that has it. Without it the planner refuses such a spot into `blocked`; with
			   it, it plans the man the reader actually owns. See `indexByName`. */
			ownedIds: mineIds,
			shape: {
				slots: league.roster.slots,
				slot_order: league.roster.slot_order,
				slot_accepts: league.roster.slot_accepts
			},
			options: DEFAULTS,
			/*
			  THE LEAGUE'S OWN LIMITS, rather than this app's defaults alone.
			
			  `DEFAULTS.maxMoves` is 2 a week, and the comment on it says plainly that the
			  number is inherited rather than established. A league that allows six is not
			  served by two, and — the half that actually costs a reader something — a league
			  that allows ONE was being offered two, which is a plan he cannot carry out. The
			  planner takes the lower of the two and says which one bit.
			
			  This card already read both numbers for its own display (the innings floor line
			  and the move-cap clause) and then let the planner work from the default, so the
			  screen was quoting his league's rule beside advice that ignored it.
			*/
			limits: {
				...leagueLimits(league),
				/*
				  BOTH HALVES OF THE INNINGS SUM, which only this caller has.
				
				  `banked` is what his pitchers have actually thrown inside the league's own
				  scoring period, read from MLB's day-by-day record. `windowIsPeriod` is stated
				  rather than inferred and is true HERE because this card rates over
				  `resolvePeriod`'s own window — the board rates over a fortnight and must never
				  claim the same thing, which is why the planner asks rather than assumes: 25
				  innings clears a 20-a-week floor on the arithmetic and misses it badly in fact.
				*/
				inningsBanked: banked,
				windowIsPeriod: true
			}
		}
		return { lineup: planLineup(input), swaps: planSwaps(input, 60, keepForSeason) }
	}, [rated, league, seats, candidates, keepForSeason, banked, mineIds])
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
	/*
	 * `periodStart`, NOT `start`, and reading the wrong one killed this feature outright.
	 *
	 * `resolvePeriod` sets `start = today > periodStart ? today : periodStart` for every period
	 * kind, because `start` is where a forward-looking rating accrues FROM. So this read today's
	 * date, asked for the window today..yesterday, got the inverted-range refusal, and fell
	 * through to `banked = 0` on every day in every league — the card printed "your pitchers have
	 * thrown 0 in it so far" for a staff that had thrown forty innings. `periodStart` was added to
	 * `ResolvedPeriod` in the same commit FOR this question and then not used by it.
	 */
	const rules = useMemo(() => {
		const raw = ((league?.league_rules as { raw_settings?: Record<string, string> } | undefined)
			?.raw_settings ?? {}) as Record<string, string>
		const floor = deriveInningsMinimum(raw).perPeriod
		const cap = deriveMoveLimit(raw).perPeriod
		/* When a move he makes tonight actually lands. Read here rather than in the view
		   so the early return below — the no-lineup path — carries it too: the moves list
		   renders on that path and the rule is about the moves, not about the innings. */
		const waivers = deriveWaiverRule(raw)
		if (floor === null || !rated || !lineup?.starters.length)
			return { floor, cap, waivers, projected: null, after: null }
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
		return { floor, cap, waivers, projected, after }
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
		const nothing = {
			fills: [] as { slot: string; name: string; points: number; team: string | null }[],
			lockedOut: 0,
			movedIn: 0
		}
		if (!league || !today?.unfilled.length || !today.ratedToday.length) return nothing
		if (!candidates.length) return nothing
		const free = new Set(candidates.map(p => normalizeName(p.name)))
		const seen = new Set<string>()
		/** One man can only fill one seat. Sam Antonacci is eligible at 2B, 3B, OF and
		 *  Util in this league, so without this he was offered for four of them at once
		 *  — four adds that are really one, and three seats still empty afterwards. */
		const taken = new Set<string>()
		/*
		   A MAN THE MOVES ABOVE ALREADY OFFER IS NOT OFFERED AGAIN HERE.
		
		   Measured by a walk: Dominic Canzone appeared twice on one card, as "Util · Add
		   Dominic Canzone · 7.11 projected tonight" under Empty seats and again as "+14.36 ·
		   Add Dominic Canzone for your Util seat — you have a free seat, so nobody comes out"
		   under Make these moves. One man, one seat, two rows, and no way for a reader to tell
		   whether that is one add or two.
		
		   The MOVES row is the one that survives, because it prices the add against the rest of
		   the roster and states what it costs; this block's row is the same recommendation with
		   less of the argument. The seat is still accounted for — it gets its own sentence
		   below, pointing at the block that fills it, rather than falling into "nobody is
		   eligible", which would be false of it.
		*/
		const offeredAbove = new Set((plan?.swaps.moves ?? []).map(m => normalizeName(m.add)))
		/** Seats the moves block already fills, so this one neither repeats them nor calls
		 *  them empty. */
		const movedIn = new Set<string>()
		/** Seats whose best answer exists and has already locked. A different sentence from a
		 *  seat nobody is eligible for, and at 9pm it is the common one. */
		const shut_out = new Set<string>()
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
			/*
			   AND HIS GAME MUST NOT HAVE STARTED, which is the half of "on a card tonight" this
			   block claimed and did not check.
			
			   `statusOf` says the same "starting" about a man in the ninth inning as about one
			   at 7:04pm, so at 9pm the seat offer read "Add X · 6.2 projected tonight" for a man
			   whose game had ended an hour before — a move and a player spent for the same zero
			   the seat already had. The reader's own rows have been gated on exactly this since
			   the freeze (`shut`, a few hundred lines up), so the card was freezing his own
			   shortstop for a 1:05pm lock and offering him a free agent from a 2:20pm game on the
			   same screen.
			
			   The scheduled first pitch rather than the game's state, for the reason in `locked`:
			   a delayed game is closed on the platform while MLB still calls it Pre-Game.
			*/
			if (best && offeredAbove.has(normalizeName(best.player.name))) {
				movedIn.add(slot)
				continue
			}
			if (best && slate) {
				const at = lockFor(best.player.teamId, slate)
				if (at !== null && at <= Date.now()) {
					shut_out.add(slot)
					continue
				}
			}
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
		return { fills: out.slice(0, 4), lockedOut: shut_out.size, movedIn: movedIn.size }
	}, [today, candidates, league, slate, crossed, plan])

	/**
	 * ONE LIST OF THINGS TO GO AND DO, biggest first.
	 *
	 * THE DEFECT THIS ENDS. Walked on a real 27-man imported roster, 2026-09-23: the card
	 * led with "×10 Bench Pete Crow-Armstrong C, Alex Bregman 1B, …" and never said who
	 * took any of those seats; then a separate block said "Empty seats — 12 seats score
	 * nothing tonight", which is the same fact from the other end; and the only instruction
	 * the reader came for — the add and the drop — was the fifth block down, under a fold.
	 * Three blocks, two of them restating each other, and the answer last.
	 *
	 * WHY THE WAIVER MOVES AND THE LINEUP MOVES SHARE A LIST. They are different in kind to
	 * this codebase — one costs a move and a player, the other is free and reversible, and
	 * `src/auto/plan.ts` prices them on different horizons — and they are the same thing to
	 * the reader: something to go and do in Yahoo before first pitch. Splitting them by
	 * their cost to the planner is the app organising the page around its own internals,
	 * and it put the most valuable row on the card below two blocks of the least valuable.
	 *
	 * AND THE TWO NUMBERS ARE NOT THE SAME NUMBER, which is why every row says what its own
	 * is. An add's figure is what the lineup gains over the whole scoring period with the
	 * move made; a seat's is what the arriving man projects TONIGHT. Sorting them together
	 * is a choice — it puts a 29.67-point week above a 10.74-point night, which is the
	 * right order for a reader deciding what to do first and is not a comparison of like
	 * with like. Labelling each row is what keeps that honest; hiding it behind two
	 * headings, which is what the card did, is what did not.
	 *
	 * A SEAT APPEARS ONCE. `fillTonight` offers a free agent for a seat nobody you own can
	 * fill, and its rows used to sit in their own block — so "Sit Tarik Skubal at SP" and
	 * "SP · Add Connor Prielipp" were two rows about one seat, on one card, with nothing
	 * saying so. Merged in by slot, that is one row: add the man, and this is who comes out.
	 */
	const toDo = useMemo(() => {
		/**
		 * THE FACT ON THE ROW, THE PROVENANCE IN THE FOLD.
		 *
		 * `rateAll` writes reasons of a length that suits a terminal: "Injured 60-Day — no
		 * source states a return date, so there is no honest projection over this horizon.
		 * The Stash view ranks him anyway" is three sentences of caveat inside a row whose
		 * job is to say what to do. What a reader acts on is the first clause; the rest is
		 * where the claim comes from, and it is kept — moved to the watch fold rather than
		 * dropped, which is the same trade the card made for every other caveat on it.
		 *
		 * Cut at the first em-dash or sentence break, because that is where this app's own
		 * reasons put the fact: "Injured 60-Day", "he is not on the board", "no game today".
		 * A reason with neither is already short and survives whole.
		 */
		const head = (w: string): string => {
			const marks = [w.indexOf(" \u2014 "), w.indexOf(". ")].filter(i => i > 0)
			return marks.length ? w.slice(0, Math.min(...marks)) : w
		}
		/** The reasons a row shortened, in full, for the fold to carry. */
		const caveats: { name: string; why: string }[] = []
		type Arrival = { name: string; points: number; wire: boolean; team: string | null }
		type Seat = {
			slot: string
			in: Arrival[]
			out: { name: string; why: string }[]
			/** Men who held one of these seats and are in the plan at a different one. */
			moved: { name: string; to: string }[]
			/** The earliest first pitch among the arriving men — when the row expires. */
			lock: number | null
		}
		const bySlot = new Map<string, Seat>()
		for (const m of today?.seatMoves ?? [])
			bySlot.set(m.slot, {
				slot: m.slot,
				in: m.in.map(x => ({ name: x.name, points: x.points, wire: false, team: null })),
				out: m.out.map(o => {
					const short = head(o.why)
					if (short !== o.why) caveats.push({ name: o.name, why: o.why })
					return { name: o.name, why: short }
				}),
				moved: [...m.moved],
				lock: m.in.reduce<number | null>(
					(a, x) => (x.lock === null ? a : a === null ? x.lock : Math.min(a, x.lock)),
					null
				)
			})
		for (const f of fillTonight.fills) {
			const row = bySlot.get(f.slot)
			const arrival = { name: f.name, points: f.points, wire: true, team: f.team }
			if (row) row.in.push(arrival)
			else bySlot.set(f.slot, { slot: f.slot, in: [arrival], out: [], moved: [], lock: null })
		}
		/* A slot whose only news is that its man went to a better seat has nothing for the
		   reader to do — the row where he ARRIVES is the instruction. It is carried this far
		   because a free agent may still be offered for the seat he left, and that row has to
		   be able to say the seat is not standing empty. */
		for (const [slot, row] of bySlot) if (!row.in.length && !row.out.length) bySlot.delete(slot)
		const rows = [
			...(plan?.swaps.moves ?? []).map(m => ({ kind: "add" as const, value: m.gain, move: m, seat: null })),
			...[...bySlot.values()].map(seat => ({
				kind: "seat" as const,
				/* Null for a row with nobody arriving: there is no gain to claim, because the
				   seat scores nothing either way. A row that printed a number there would be
				   pricing a change that buys the reader nothing. */
				value:
					seat.in.length ?
						Number(seat.in.reduce((a, x) => a + x.points, 0).toFixed(2))
					:	null,
				move: null,
				seat
			}))
		]
		/* Stable, so the rows with no value keep the league's own slot order rather than
		   whatever order a comparator that cannot separate them happens to leave them in.
		   `(a.value ?? -Infinity) - (b.value ?? -Infinity)` is NaN for two of them, which
		   leaves the sort unspecified — the first version of this did exactly that. */
		rows.sort((a, b) =>
			a.value === null && b.value === null ? 0
			: a.value === null ? 1
			: b.value === null ? -1
			: b.value - a.value
		)
		return { rows, caveats }
	}, [today, fillTonight, plan])

	/**
	 * A row of the one list, drawn the same way wherever it is drawn.
	 *
	 * `addRow` is shared with the period-lineup branch further down, which still renders
	 * the waiver moves under a heading of their own because a league that locks its lineup
	 * for the week has no Today list to fold them into. One markup, two callers — the two
	 * copies this replaces had already drifted once.
	 */
	const addRow = (m: NonNullable<typeof plan>["swaps"]["moves"][number]): ReactNode => (
		<li key={`add-${m.add}-${m.drop}`} className="decide-do-add">
			{/*
			  TWO SCALES, AND THE COLUMN HAS TO SHOW WHICH IS WHICH.

			  "+29.67" and "18.56" sat in one gutter, in one colour, on two rows that both
			  began with the word "Add" — and they are a gain over the whole scoring period
			  and a man's points for one night. A legend under the list explained the
			  difference, which is the tell that the column did not. Three things separate
			  them now and none of them is a legend: the sign, the colour (see
			  `.decide-do-add .decide-delta` in decide.css), and a unit clause on every row.
			*/}
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
				:	null}
				<em className="decide-why">
					over this scoring period
					{!m.drop && <> · you have a free seat, so nobody comes out</>}
				</em>
			</span>
		</li>
	)

	/** Names, bolded, read as a sentence rather than as a CSV. `className` marks the men
	 *  who are NOT yours — a suite has to be able to tell an add from a start, and on the
	 *  row the only difference is the verb three words to the left. */
	const nameList = (names: string[], className?: string): ReactNode =>
		names.map((n, i) => (
			<span key={n} className={className}>
				{i > 0 && (i === names.length - 1 ? " and " : ", ")}
				<b>{n}</b>
			</span>
		))

	/**
	 * One seat, both halves.
	 *
	 * Three shapes, and which one is drawn is decided by the data rather than chosen:
	 * somebody arrives and somebody leaves (the pair), somebody arrives into a seat that
	 * was standing empty, or somebody leaves and nobody takes it. There is no fourth, and
	 * in particular there is no shape in which this file guesses which departing man an
	 * arriving one displaced — see the note on `seatMoves`.
	 */
	const seatRow = (
		seat: {
			slot: string
			in: { name: string; points: number; wire: boolean }[]
			out: { name: string; why: string }[]
			moved: { name: string; to: string }[]
			lock: number | null
		},
		value: number | null
	): ReactNode => {
		const own = seat.in.filter(x => !x.wire).map(x => x.name)
		const wired = seat.in.filter(x => x.wire).map(x => x.name)
		/* The reason a man is coming out, minus the one the row itself already gives. See
		   `OUTRANKED`: on a paired row the better man is named three words to the left. */
		/* The engine's own sentences, some of which end in a full stop and some of which do
		   not, and the row puts a clause after them either way — "not scheduled to pitch in
		   this window. — that seat scores nothing". The reason is the engine's to write and
		   the punctuation is this row's to fit, so the terminal stop comes off here rather
		   than being normalised upstream, where several other readers print these verbatim. */
		const whys = [...new Set(seat.out.map(o => o.why))]
			.filter(w => !(seat.in.length && w === OUTRANKED))
			.map(w => w.replace(/\.$/, ""))
		/* Each reason in its own element, separated rather than joined into one string. Two
		   suites assert that every reason on this card comes from the closed vocabulary
		   Decide writes — the check that stops a blanket sentence being invented here — and a
		   reason they can only reach by splitting prose on a middot is a check that a
		   punctuation edit turns off. */
		const reasons = (
			<>
				{whys.map((w, i) => (
					<span key={w} className="decide-reason">
						{i > 0 && " · "}
						{w}
					</span>
				))}
			</>
		)
		/*
		  "AND SIT", NOT "OVER", and the word is load-bearing now that a wire man arrives in
		  the same row shape as one of his own. "Add Connor Prielipp at SP, over Tarik Skubal"
		  reads as DROP Skubal, on a card whose other rows say "drop" and mean it. One of
		  those two costs him a player and one is undone in a click, and the verb is the only
		  thing on the row that tells them apart.

		  `decide-in` / `decide-out` / `decide-moved` wrap the three groups so a suite can read
		  a row as the three claims it makes rather than by splitting its prose on a comma,
		  and `decide-add-wire` separates the men inside `decide-in` who are not yet his.
		*/
		const over =
			seat.out.length ?
				<>
					, and sit <span className="decide-out">{nameList(seat.out.map(o => o.name))}</span>
				</>
			:	null
		/*
		  THE MOVER IS NAMED ONLY WHERE THE ROW WOULD OTHERWISE BE WRONG, which is a narrower
		  place than the first version put it.
		
		  It exists for one reason: a seat its occupant left for a better one is NOT an empty
		  seat, and the branch at the foot of this row would otherwise say it was. That branch
		  only fires when nobody is being sat here, so that is the only case the clause is
		  needed in — and adding it everywhere turned two rows into cascade descriptions
		  nobody can execute in one pass:
		
		    "Start Rafael Devers and Yordan Alvarez at Util, and sit Nick Kurtz — Junior
		     Caminero moves to 3B"
		    "Add Matthew Liberatore at P, and sit Sandy Alcantara and Cristopher Sánchez —
		     Zach Neto and Rafael Devers move to SS and Util"
		
		  Five men and three seats in one sentence is not a move. Where somebody IS being sat,
		  the departure already proves the seat was occupied and the clause buys nothing — and
		  every mover named here has his own arrival row a few lines away, which is where the
		  reader acts on him. With several movers and nobody sat, the count goes in without the
		  names: what the row has to establish is that the seats were not standing empty, not
		  who used to be in which.
		*/
		const movedOn =
			seat.out.length ? null
			: seat.moved.length === 1 ?
				<span className="decide-moved">
					{" "}
					&mdash; {nameList(seat.moved.map(m => m.name))} moves to {seat.moved[0]!.to}
				</span>
			: seat.moved.length > 1 ?
				<span className="decide-moved">
					{" "}
					&mdash; {seat.moved.length} men move out of {seat.slot} to better seats
				</span>
			:	null
		return (
			<li
				key={`seat-${seat.slot}-${seat.in.map(x => x.name).join()}-${seat.out.map(o => o.name).join()}`}
				className={seat.in.length ? "decide-do-start" : "decide-do-sit"}
				/* The seat this row is about, as data. It is in the sentence too — "at SS" —
				   but a suite that has to split prose on a preposition to find out which seat
				   a row changes is a suite that goes red on a wording edit. */
				data-slot={seat.slot}>
				<span className="decide-delta">{value === null ? <>&mdash;</> : value}</span>
				<span>
					{seat.in.length ?
						<>
							<span className="decide-in">
								{own.length > 0 && <>Start {nameList(own)}</>}
								{own.length > 0 && wired.length > 0 && <>, and add </>}
								{own.length === 0 && wired.length > 0 && <>Add </>}
								{wired.length > 0 && nameList(wired, "decide-add-wire")}
							</span>{" "}
							at {seat.slot}
							{over}
							{movedOn}
							{/* THE ONLY UNPAIRED SHAPE THIS FILE MAY INVENT IS NONE. Where the data
							    cannot say which man an arrival displaced it says the seat was empty,
							    which is what an empty `out` AND an empty `moved` mean together, and
							    is checkable against the seat-by-seat fold below. */}
							{!over && !movedOn && <> &mdash; over an empty seat</>}
							{/* THE NUMBER IS IN THE GUTTER AND THE UNIT IS HERE, because the two are
							    different quantities on one card: a priced add's figure is a gain over
							    the whole scoring period and this one is what the arriving man projects
							    TONIGHT. Printing the figure again beside the word was the first
							    version and it read as a second number. */}
							<em className="decide-why">
								projected tonight
								{whys.length > 0 && <> · {reasons}</>}
								{/* When this seat stops being changeable. It is the only thing on the
								    row that expires. */}
								{seat.lock !== null && (
									<span className="decide-lock"> · locks {clock(seat.lock)}</span>
								)}
							</em>
						</>
					:	<>
							Sit <span className="decide-out">{nameList(seat.out.map(o => o.name))}</span> at{" "}
							{seat.slot}
							{movedOn}
							{/*
							  AND SAY THAT THE SEAT GOES EMPTY, which is the whole difference between
							  this row and the paired one above it. Nobody is arriving, so the
							  instruction buys nothing on its own and the reader is entitled to know
							  that before he acts on it. It is a fact rather than a judgement: the
							  planner seats fewer men at this slot than the slot has seats, so at
							  least one of them ends the night empty whatever he does.
							*/}
							<em className="decide-why">
								{reasons} &mdash; that seat scores nothing tonight either way
							</em>
						</>
					}
				</span>
			</li>
		)
	}

	/** Seats the plan leaves exactly as it found them — one line, so the list above can be
	 *  only the changes. Counted off the arrivals rather than off `start` and `shifts`,
	 *  which between them missed six of this roster's movers; see `seatMoves`. */
	const settledSeats = today ?
		Math.max(
			today.lineup.starters.length -
				today.seatMoves.reduce((a, m) => a + m.in.length, 0),
			0
		)
	:	0

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
		/*
		 * THE LEDGER IS KEYED ON `${id}:${group}`, so a name that resolves to the wrong man
		 * does not merely lose a row — it grades this reader's evening against somebody
		 * else's line, permanently, in the one store whose contents cannot be rebuilt.
		 *
		 * Every name asked about here is a man in one of his own seats, so the seat's
		 * printed eligibility is available for the join even though `today.lineup.starters`
		 * carries only a name and a slot: the positions are looked up off `seats.spots` by
		 * the same printed name. Where that leaves two men, the row is REFUSED — the same
		 * empty array an unmatched name already returns, which `gradeRecord` reads as a day
		 * it cannot grade rather than as a day Billy got wrong.
		 */
		const board = indexByName(today.ratedToday, r => r.player)
		const seatPositions = new Map(seats.spots.map(sp => [normalizeName(sp.name), sp.positions]))
		const rowFor = (name: string) =>
			board.pick(name, { positions: seatPositions.get(normalizeName(name)), owned: mineIds }).row
		const side = (name: string, slot: string | null, projected: number | null) => {
			const r = rowFor(name)
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
			.flatMap(sp => side(sp.name, sp.slot, rowFor(sp.name)?.points ?? null))
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
	}, [leagueKey, today, seats, plan, mineIds])

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
				/* And the men on the one list's own rows, who are not all in `start`: a man
				   moving between two active seats is an arrival the card names and is in
				   neither `start` nor `bench`. Left out, he could be named on a row AND in the
				   could-not-be-priced note, which is the duplication this whole block exists
				   to prevent. */
				...(today?.seatMoves ?? []).flatMap(m => m.in.map(x => x.name)),
				...(today?.locked ?? []).map(l => l.name),
				...(today?.stuck ?? []).map(st => st.in)
			].map(normalizeName)
		)
		/*
		 * A LINE WITH NO NAME IN IT IS NOT A MAN, and this used to make one up out of it.
		 *
		 * Every entry `planLineup` writes is `Name: reason`, and this splits on the first
		 * ": " to get the two halves. One entry was not: the `lineupMinGain` return pushed
		 * "the best legal lineup is worth -144.42 more than today's, below the 0-point lineup
		 * bar, so the lineup is left alone" into the same array, with no colon in it — so
		 * `name` became the whole sentence and the card rendered it in the player slot: "One
		 * player on your roster could not be priced, so nothing above counts him: the best
		 * legal lineup is worth -144.42 more than today's…". Reproduced on a real 27-man
		 * imported roster, 2026-09-23.
		 *
		 * That entry is now `LineupPlan.leftAlone`, typed as the claim about the lineup that
		 * it is, and it is rendered where the card already makes that claim. This branch is
		 * the second lock on the same door: a line this function cannot read a name out of
		 * still reaches the reader — an absence is stated, never swallowed — but it reaches
		 * him as a SENTENCE, with no names beside it, because a name is the one thing it does
		 * not contain. `men` empty is what the view reads to draw that shape.
		 *
		 * It also removed a near-duplicate bullet. The invented reason for a no-colon line
		 * was "No projection could be made for him, so he is neither started nor offered up",
		 * one word away from the engine's own "no projection could be made for him, so he has
		 * no number to compare" — two bullets, both opening "N players on your roster could
		 * not be priced", stacked on top of each other, for what a reader reads as one fact.
		 */
		const by = new Map<string, string[]>()
		for (const line of plan?.lineup.skipped ?? []) {
			const at = line.indexOf(": ")
			if (at === -1) {
				by.set(`${line[0]!.toUpperCase()}${line.slice(1)}.`, [])
				continue
			}
			const name = line.slice(0, at)
			if (named.has(normalizeName(name))) continue
			const why = `${line.slice(at + 2)[0]!.toUpperCase()}${line.slice(at + 2).slice(1)}.`
			by.set(why, [...(by.get(why) ?? []), name])
		}
		return [...by].map(([why, men]) => ({ why, men }))
	}, [plan, today])

	if (!league) return null
	/* On Pickups every blocked state below belongs to somebody else: the board carries its
	   own loading, error and refusal, and a reader with no team gets Billy's pick instead. */
	if (only && (error || !snapshot || owned.error || !seats?.spots.length)) return null

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
					Open <b>{tab("trade")}</b> to clear it.
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
	/*
	   A LEAGUE ONE INPUT SHORT GETS ONE CARD, AND IT IS NOT THIS ONE.

	   With no team count, or no scoring, this rendered its own blocked card — "Nothing yet —
	   <league> does not say how many teams are in it. Open My league and set the team
	   count." — directly underneath App's `Setup` card, which renders in exactly the same
	   states (`leagueReady` is false precisely when a gap has no value) and says "Finish
	   <league> · Add these on My league: How many teams · [Open My league]". Walked on
	   2026-09-22 at 390x844: the same instruction twice on one screen, and three times on My
	   league once the field's own caption was counted. The owner named that pattern.

	   `Setup` is the one that stays: it lists every missing input at once rather than
	   whichever one this function checked first, and it carries the button. Here, nothing —
	   the refusal is still made (no plan is offered for a league that cannot be priced), it
	   is just not announced twice.
	*/
	if (league.meta.max_teams === null) return null
	const scores =
		Object.values(league.scoring.batting).some(v => v !== 0) ||
		Object.values(league.scoring.pitching).some(v => v !== 0)
	if (!scores) return null

	// Each of these is a different missing thing with a different fix, and naming the
	// wrong one sends the reader to the wrong button.
	if (!seats?.spots.length) {
		/**
		 * TWO BUTTONS, ONE ACTION, TWO NAMES — and this is the one that goes.
		 *
		 * Walked on the published build at 1280px with nothing stored: the page carried
		 * "What should I do? / Add the players you own. [Add your players]" in the flow, and a
		 * docked bar under it reading "Start with your league. [Set up my league]". Both
		 * presses ran the same handler — open the setup sheet — because a reader with no
		 * league of his own has exactly one next step. Two names for it is the reader having
		 * to work out whether they differ, and they do not.
		 *
		 * The dock is the one that stays: it is pinned, it is on every tab, and its sentence
		 * names the actual first step, which is the LEAGUE and not the players. So App passes
		 * null here while the league on screen is the borrowed preview, and this card renders
		 * nothing — leaving last night's best games, which is the app showing what it does,
		 * above one ask.
		 *
		 * Once he has a league of his own the dock is gone, `onOpenTeam` is a function again,
		 * and everything below is what he sees: the ask for players, which is then the only
		 * one on the page.
		 */
		if (!onOpenTeam) return null
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
				{/*
				  A PRESS IS A PRESS, NOT A WORD IN A SENTENCE.

				  The button was the first token of the paragraph — "[Add your players] and
				  this becomes tonight's lineup…" — so at 390px the sentence started to the
				  RIGHT of a 44px-tall control and then wrapped underneath it, around a box
				  that is not a word. Screenshotted on the shipped build, it reads as broken
				  layout rather than as an invitation, and it is the first thing a stranger
				  with no team sees.

				  The sentence says what pressing it buys; the button says what it does. Same
				  two facts, in the two shapes a reader already knows how to use.
				*/}
				{/*
				  ONE INSTRUCTION, ONE BUTTON. The sentence here was "Tonight's lineup and the
				  moves to make, from the players you own. About a minute, and it stays in this
				  browser." plus, on ESPN, "Your platform can read the whole roster in one
				  click." — 21 to 30 words selling the step, estimating its duration and making a
				  privacy promise, all of which the owner has ruled out of UI text: strings
				  instruct, they do not explain the app. The heading already asks the question;
				  this line says what to do; the button does it. The platform-specific promise
				  belongs to the sheet the button opens, which asks the platform first.
				*/}
				<p>Add the players you own.</p>
				<p className="decide-cta-row">
					<button type="button" className="primary decide-cta" onClick={onOpenTeam}>
						Add your players
					</button>
				</p>
			</section>
		)
	}

	if (only === "pickups") {
		/* Tonight's own rows, in Tonight's order, keeping only the ones that bring a man
		   off the wire: the paired adds, and a seat tonight that a free agent fills. A row
		   that only starts or sits men already on the team is Tonight's business, not this
		   screen's. */
		const adds = toDo.rows.filter(row => row.move || row.seat?.in.some(x => x.wire))
		return (
			<section className="card full decide decide-pickups">
				<h2>Who should I add?</h2>
				{!candidates.length ?
					<p className="sub">
						No add can be judged: nothing has read your league&rsquo;s free-agent list, and
						who is free cannot be estimated from this capture either.
					</p>
				: !adds.length ?
					<p className="sub">None worth making.</p>
				:	<ul className="decide-list decide-do">
						{adds.map(row =>
							row.move ? addRow(row.move)
							: row.seat ? seatRow(row.seat, row.value)
							:	null
						)}
					</ul>
				}
				<p className="sub decide-rest">
					{estimatedWire ?
						<b>Who is free is an estimate. </b>
					: wireAge ?
						<>Your league&rsquo;s own free-agent list, read {wireAge}. </>
					:	null}
					{onOpenTonight && (
						<button type="button" className="chip-btn" onClick={onOpenTonight}>
							Tonight&rsquo;s full lineup &rarr;
						</button>
					)}
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
					{rated.period.assumed && " — assumed"}.
				</p>
			)}

			{/*
			  A SCRATCH LEADS, because it is the one thing on this screen that is not a ranking.
			  
			  A man MLB has left out of tonight's posted order while he sits in a startable seat
			  is the most actionable sentence the app can produce in an evening: that seat scores
			  nothing unless the reader moves, and it is a FACT rather than an opinion about who
			  is better. It was reaching him grouped with everybody else under "not in today's
			  lineup", beneath the change rows, in a list ordered by lock time — findable, and
			  not led with.
			  
			  Above the Today heading rather than inside it, because the heading is already four
			  clauses long at 390px and because this is categorically different from the rest:
			  every other row is the app's judgement, and this is somebody else's lineup card.
			*/}
			{today && today.scratched.length > 0 && (
				<p className="sub decide-scratch">
					<b>{andList(today.scratched)}</b>{" "}
					{today.scratched.length === 1 ? "is" : "are"} not in tonight&rsquo;s posted lineup
					{today.scratched.length === 1 ? "" : "s"} &mdash;{" "}
					{today.scratched.length === 1 ? "that seat scores" : "those seats score"} nothing
					unless you change {today.scratched.length === 1 ? "it" : "them"}.
				</p>
			)}

			{/* The games that are NOT being played after all, beside the men who are not in the
			    ones that are. Same shape as the scratch line above and for the same reason: it
			    is somebody else's decision about his team, not this app's judgement. */}
			{today && today.calledOff.length > 0 && (
				<p className="sub decide-called">
					<b>{andList(today.calledOff)}</b>&rsquo;s{" "}
					{today.calledOff.length === 1 ? "game has" : "games have"} been called off &mdash;{" "}
					{today.calledOff.length === 1 ? "that seat scores" : "those seats score"} nothing
					tonight, whoever is in {today.calledOff.length === 1 ? "it" : "them"}.
				</p>
			)}

			{/* Today first, because today is the one that locks. A lineup change is free
			    and reversible and this league takes one every day; an add costs a move
			    and a player and can be made a few times a week. */}
			{today && (
				<>
					<style href="decide-assumed" precedence="default">{ASSUMED_CSS}</style>
					<h3 className="decide-head">
						{/* The night this card is about. A league whose daily deadline is the next
						    day's lineup has already locked tonight, so calling this Today would be
						    naming a night the reader cannot act on. */}
						{today.planning === "tomorrow" ? "Tomorrow" : "Today"}
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
							{/* ON A LIGHT NIGHT ONLY, which is the night it was added for. The note
							    where it is computed says why it exists: thirteen empty seats read as a
							    broken app, and "only five games are being played" reads as a Wednesday.
							    On a fifteen-game Saturday it explains nothing — it is the ordinary
							    number — and this header is the whole card for a man who reads one line
							    and already wraps to four lines at 390px. Eight is half a full slate,
							    which is where "there is not much on tonight" starts being the
							    explanation for a lineup that cannot fill itself. */}
							{today.games !== null && today.games <= 8 && (
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
							{today.pointsReach > today.lineup.pointsNow ?
								<>
									your lineup projects {today.lineup.pointsNow}, or{" "}
									{today.pointsReach} once you make these changes
								</>
							:	<>your lineup projects {today.lineup.pointsNow}</>
							}
						</span>
						{/*
						  AND WHAT IT HAS ACTUALLY SCORED, once any of his games has started.
						  
						  The first fact on a card made entirely of projections, and it is the number
						  a manager actually wants at nine in the evening. Two numbers and a comma:
						  no "43 of 112", no "on pace for" and no gap between this and the
						  projection, because this league pays -3 for an earned run — so tonight's
						  figure can FALL — and the projection covers seats whose games are already
						  over. See `scoredTonight` for what is counted and `sofar` for when it is
						  asked for.
						*/}
						{scoredTonight && (
							<span className="decide-gain decide-sofar">
								{scoredTonight.lineup ? "your lineup has" : "your men have"} scored{" "}
								<b>{scoredTonight.points}</b> so far tonight
								{today.mineGames.final > 0 && (
									<>
										{" "}
										&middot; {today.mineGames.final}{" "}
										{today.mineGames.final === 1 ? "game is" : "games are"} final
									</>
								)}
								{today.mineGames.toCome > 0 && <> &middot; {today.mineGames.toCome} still to come</>}
							</span>
						)}
						{/* The assumption, on the heading it qualifies rather than in a footnote.
						    A league whose lineup locks for the whole period cannot act on any of
						    this, and nobody has told us which kind this is — so the changes below
						    are offered on the commoner of the two and the reader is told that in
						    the same breath. Answering it is a chip on My league. */}
						{/* One instruction, and only where it changes what he does: tonight's
						    lineup is shut in this league, and the one he is looking at is
						    tomorrow's. */}
						{today.planning === "tomorrow" && (
							<span className="decide-gain decide-assumed">
								set tomorrow&rsquo;s lineup &mdash; tonight&rsquo;s is closed
							</span>
						)}
						{today.assumedDaily && (
							<span className="decide-gain decide-assumed">
								if your league lets you change the lineup every day &mdash;{" "}
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
						{/*
						  WHILE THE READ IS STILL OUT, the same sentence with the reason it is true:
						  tonight's schedule has not arrived yet, so what is on the screen is the
						  capture. It says so for the seconds it lasts and then stops saying it,
						  which is the difference between a card that rearranges itself in front of
						  a reader and one that told him it was about to.
						*/}
						{!slateError && slateLoading && (
							<span className="decide-stale">
								tonight&rsquo;s schedule is still coming — these seats and times are from
								the capture, {freshness(snapshot?.capturedAt, Date.now()).label}, until it
								arrives
							</span>
						)}
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
						{/*
						  A GAP THE LIVE READ CANNOT REACH, which arrives on a date rather than on a
						  change to any code.
						
						  The injured list here is the capture's, patched with every move MLB has
						  reported since — and that patch looks back a fortnight at most. Once the
						  capture is older than that, the patch starts AFTER it, and every placement
						  and return in between is invisible while the capture's own entry stays
						  authoritative. That is the failure this card is most written against:
						  starting a man the box score already contradicted.
						
						  Said in days, because days is what he can weigh, and said only while it is
						  true — the ordinary case is that the two overlap and there is nothing here.
						*/}
						{!injuryError && injuryGap > 0 && (
							<span className="decide-stale">
								{injuryGap} {injuryGap === 1 ? "day" : "days"} of injury news between
								this capture and what MLB still reports could not be read, so a man
								placed on the list in that window may still look available
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
							None of your players could be priced for today — this is not a
							recommendation to bench them.{" "}
							{today.bench.length} {today.bench.length === 1 ? "man is" : "men are"} in
							your active seats.
						</p>
					: toDo.rows.length ?
						<>
							{/*
							  THE WHOLE ANSWER, IN ONE LIST, BIGGEST FIRST.
							
							  This was three lists and a fold: the lineup diff, then "Empty seats",
							  then — five blocks down, under `Make these moves` — the add and the
							  drop the reader actually came for. Two of the three were the same fact
							  said from opposite ends ("×10 Bench …" and "12 seats score nothing
							  tonight"), and the half that says what to DO about a benched man was in
							  none of them. See `toDo` for what each row's number is and why they are
							  sorted together.
							*/}
							<ul className="decide-list decide-do">
								{toDo.rows.map(row =>
									row.move ? addRow(row.move)
									: row.seat ? seatRow(row.seat, row.value)
									:	null
								)}
							</ul>
							{/*
							  WHAT THE NUMBERS ARE, once, under the list they qualify.
							
							  Two units share this list on purpose and a reader comparing 29.67 with
							  10.74 is entitled to know they are not the same quantity. Said here
							  rather than on every row: it is one fact about the list, and the card's
							  own measured history is that a clause repeated under each row is the
							  thing that pushes the last instruction off the screen.
							*/}
							{/* A <div>, not a <p>, because it holds a <details> — see the same note in
							    Board.tsx. */}
							<div className="sub decide-rest decide-numbers">
								{/* The ordering, which is a property of the LIST. What each figure is
								    denominated in used to be here too and is on the rows now — a legend
								    that has to explain a column is a column that does not work. */}
								{toDo.rows.length > 1 ? <>Biggest first. </> : null}
								{estimatedWire ?
									<b>Who is free is an estimate</b>
								: wireAge ?
									<>Your league&rsquo;s own free-agent list, read {wireAge}</>
								:	<>Points your lineup gains over this period</>}
								<details className="decide-fine">
									<summary>what these numbers are</summary>
									An add&rsquo;s figure is what your starting lineup projects over this
									period with the move made; a seat&rsquo;s is what the arriving man
									projects tonight. Everyone leaving on an add is under the keep floor —
									no more than{" "}
									{/* A GAME. The floor is `bscorePerGame < keepFloor`, and printing a rate
									    with "points" after it is the same unit slip that let the planner
									    compare a whole-window total against this number for months. */}
									{DEFAULTS.keepFloor} a game clear of what the wire still offers at his own
									slot — and none is worth holding for the rest of the season either.
									{estimatedWire ?
										<>
											{" "}
											Nothing has read your league&rsquo;s own free-agent list, so these
											are the men rostered in {estimatedWire.cut.cut}% of leagues or fewer
											— the boundary a {estimatedWire.cut.depth / estimatedWire.cut.seats}
											-team league with {estimatedWire.cut.seats} seats implies. Some will
											already be taken in yours.
										</>
									: wireAge ?
										<> Anyone picked up or dropped since is not in it.</>
									:	null}
								</details>
							</div>
							{/*
							  THE RULE THAT GOVERNS THE ADDS, kept beside them rather than in a heading
							  of its own.
							
							  It was the subtitle of `Make these moves`, which no longer exists as a
							  block — but every word of it still changes what the reader does: how many
							  moves this run is proposing, how many his league would allow, and when a
							  claim he makes tonight actually lands. "2 of the 6 your league allows"
							  reads as four left on the table, so the two numbers stay separate and the
							  cap is named as the league's rule rather than as a finding. The
							  measurement behind the app's own limit is in src/auto/plan.ts, beside the
							  cap it governs, which is where the next person to change it stands.
							*/}
							{plan && (rules.cap !== null || plan.swaps.moves.length > 0) && (
								<p className="sub decide-adds">
									{/* "No add clears the bar" is a claim about a search, and with no wire
									    and no usable ownership estimate no search was made. The list's own
									    empty state says this where the list is empty; it has to be said
									    here too, because a card with lineup rows and no candidates would
									    otherwise report a bar that nothing was ever measured against. */}
									{!candidates.length ?
										"No add can be judged: nothing has read your league\u2019s free-agent list, and who is free cannot be estimated from this capture either"
									: plan.swaps.moves.length === 0 ? "No add clears the bar"
									: plan.swaps.moves.length < DEFAULTS.maxMoves ?
										`${plan.swaps.moves.length} add${plan.swaps.moves.length === 1 ? "" : "s"} clear${plan.swaps.moves.length === 1 ? "s" : ""} the bar`
									:	`Stopping at ${plan.swaps.moves.length} adds`}
									{candidates.length > 0 && rules.cap !== null &&
										` · your league allows ${rules.cap}`}
									{/* WHEN, not why. The gain above is accrued from today, and in a league
									    with a waiver period the claimed man is not his tonight — so the one
									    thing the reader needs beside the instruction is the day it lands.
									    The rows it was read from sit in the title, which is where this app
									    already sends provenance. */}
									{candidates.length > 0 && rules.waivers.days !== null && (
										<span title={rules.waivers.sources.join(" · ")}>
											{` · waivers clear in ${rules.waivers.days} day${rules.waivers.days === 1 ? "" : "s"}`}
										</span>
									)}
								</p>
							)}
						</>
					: !candidates.length ?
						/* Two absences and no third sentence about them. Both stay, because they are
						   different absences with different fixes: a free-agent list nobody has read,
						   and a capture whose ownership figures cannot locate the boundary. */
						<p className="sub">
							Nothing to change in your lineup, and no add can be judged: nothing has read
							your league&rsquo;s free-agent list, and who is free cannot be estimated from
							this capture either.
						</p>
					:	<p className="sub">
							Nothing to do — every seat already holds the right man for today, and no add
							clears the bar.
						</p>
					}
					{/* Only where some seats ARE already right. With no seats read there is no
					    baseline, every row is a "start", and the count is zero — "your other 0
					    seats are already right" is a sentence about nothing. */}
					{settledSeats > 0 && (
						<p className="sub decide-rest">
							Your other {settledSeats} {settledSeats === 1 ? "seat is" : "seats are"}{" "}
							already right.
						</p>
					)}
					{/* WHERE THE SEAT COUNT CAME FROM, said before the count it justifies. See
					    `partial` above: a hand-typed team is as long as the reader made it, the
					    sheet told him a short list was fine, and nothing on this card distinguished
					    a seat he has not filled in his league from a seat he simply has not told
					    this page about. */}
					{today.partial && (
						<p className="sub decide-partial">
							{/* NO ARITHMETIC BETWEEN THE TWO NUMBERS. The first draft said "so 14 of
							    these are empty" — 27 seats minus 13 men — over a heading that counted
							    6, because the heading counted STARTABLE seats and the league's total
							    includes the bench and the injured list. The honest claim is about
							    provenance, not about a count. */}
							These seats come from the {today.partial.given} men you have named, not from
							your league&rsquo;s own {today.partial.total}. Read your roster off your
							platform on <b>{tab("trade")}</b> to settle it.
						</p>
					)}
					{/*
					  THE SEATS NOTHING CAN BE DONE ABOUT — ONE LINE, and it used to be a block.
					
					  "Empty seats · 12 seats score nothing tonight" was a heading, a count, a list
					  of adds, and three explanatory sentences, sitting above the only instruction
					  on the card that cost anything. Every seat it could DO something about is now
					  a row in the list above, which leaves this one fact: how many are left that
					  nobody can. That is a caveat, not an instruction, so it gets the shape of one.
					
					  Still two reasons and still two clauses, because they are different: a seat no
					  free man is eligible for is a seat nothing was ever going to fill, and a seat
					  whose best answer has already started is one there is nothing LEFT to do about
					  — which is what stops a reader going to look for the move he missed.
					*/}
					{(() => {
						const nobody =
							today.unfilled.length -
							fillTonight.fills.length -
							fillTonight.lockedOut -
							fillTonight.movedIn
						if (nobody <= 0 && fillTonight.lockedOut <= 0) return null
						return (
							<p className="sub decide-empty-seats">
								{nobody > 0 && (
									<>
										{nobody === 1 ? "One seat has" : `${nobody} seats have`} nobody: no
										free man eligible there is on a card tonight.
									</>
								)}
								{nobody > 0 && fillTonight.lockedOut > 0 && " "}
								{fillTonight.lockedOut > 0 && (
									<>
										{fillTonight.lockedOut === 1 ?
											"One more had somebody, and his game has already begun"
										:	`${fillTonight.lockedOut} more had somebody, and those games have already begun`}{" "}
										&mdash; so there is nothing left to do about{" "}
										{fillTonight.lockedOut === 1 ? "it" : "them"}.
									</>
								)}
							</p>
						)
					})()}
					{/* The changes NOT offered, named. Without this the card looks like it found
					    fewer moves rather than like it refused to offer ones the platform will
					    reject, and a reader who remembers seeing a shortstop swap an hour ago
					    has no way to tell which of those two happened. */}
					{today.locked.length > 0 && (
						<p className="sub decide-locked">
							{today.locked.length === 1 ?
								<>
									<b>{today.locked[0]!.name}</b>&rsquo;s game was due to start
									{today.locked[0]!.at !== null ? ` at ${clock(today.locked[0]!.at)}` : ""},
									so that seat is no longer yours to change.
								</>
							:	<>
									{today.locked.length} of your seats were due to start before now
									&mdash; {andList(today.locked.map(l => l.name))} &mdash; so they are no
									longer yours to change.
								</>
							}
						</p>
					)}
					{/* A change given up for a different reason, said in different words. The
					    sentence above is about a man whose own game has started; this is about a
					    man who cannot be seated because somebody in the way can no longer move. */}
					{today.stuck.length > 0 &&
						(() => {
							const movers = [...new Set(today.stuck.map(s => s.mover))]
							return (
								<p className="sub decide-stuck">
									{andList(today.stuck.map(s => s.in))}{" "}
									{today.stuck.length === 1 ? "would have needed" : "would each have needed"}{" "}
									{andList(movers)} to change{" "}
									{movers.length === 1 ? "seat, and his game has started" : "seats, and those games have started"} &mdash; so{" "}
									{today.stuck.length === 1 ? "that seat is left as it is" : "those seats are left as they are"}.
								</p>
							)
						})()}

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
							{/*
							  THE REASON IS SAID ONCE, UNDER THE LIST; THE ROW KEEPS THE INSTRUCTION.

							  Every one of these rows carried the whole sentence — "leave empty — nobody
							  you own is projected to play here today", eleven words, identical but for
							  nothing at all. Measured in a browser at 390x844 against the roster
							  test/decide.mjs constructs: nine empty seats on a five-game night, so that
							  one sentence was 99 of the card's 766 words with the folds open — 13% of
							  the card to say one thing nine times — and a 27-seat league whose slate is
							  light runs to twenty-odd copies.

							  One row per seat stays, because that is the invariant this fold exists for
							  and the one test/decide.mjs asserts: every active seat accounted for,
							  filled or explicitly left empty. What was never per-seat is the REASON. It
							  is one fact about tonight's schedule, so it costs two words on the row and
							  one sentence at the foot instead of eleven words twenty times.
							*/}
							{today.unfilled.map((slot, i) => (
								<li key={`empty-${slot}-${i}`} className="decide-empty">
									<span className="decide-slot">{slot}</span>
									<span>
										<em className="decide-why">
											{today.lineup.starters.length ? "leave empty" : "not priced"}
										</em>
									</span>
								</li>
							))}
						</ul>
						{today.unfilled.length > 0 && (
							<p className="sub decide-empty-why">
								{today.lineup.starters.length ?
									"Nobody you own is projected to play in those seats today."
								:	"No projection could be made for anyone you own today."}
							</p>
						)}
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
								This is the lineup to <b>set</b>, not the changes to make. Read your roster
								off your platform on <b>My league</b> and it becomes a list of changes.
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
					{/*
					  AND THE PARAGRAPH IS GONE WHERE THERE IS NO GAP TO STATE.

					  The other arm of this ternary read "How your week stands is on Last night,
					  against an opponent you tell it about" — an errand, on the screen that is
					  supposed to answer. Tonight is where a manager arrives at 6:40 to be told who
					  to start; it is not where he is sent to another screen to go and paste a
					  roster so that a different sentence can appear here later. Where the opponent
					  is known the gap below is a fact he can act on and it stays; where it is not,
					  the card says nothing rather than handing him homework, and the <p> is not
					  rendered at all rather than rendered empty.
					*/}
					{matchup.gap !== null &&
					matchup.rivals > 0 &&
					matchup.mine !== null &&
					matchup.rivals >= Math.ceil(ownedIds.length * (2 / 3)) && (
					<p className="sub decide-read">
						{/* "It does not know your matchup or the score" was true of the whole app
						    when it was written and is now true of only half of it: the card above
						    will compare your week against an opponent you paste, which is the one
						    honest thing available — both sides counted the same way, neither of
						    them the score Yahoo will pay. So this sentence narrows to what is
						    still true of THIS card, and points at what answers the rest. A line
						    that keeps claiming an absence the app has filled is as wrong as one
						    that claims an ability it lacks. */}
						{/* The first sentence used to be an inputs list — "This reads tonight's
						    schedule, the batting orders that have been posted and the injured list"
						    — which is the software describing itself, and a reader who has just been
						    told who is scratched and who is hurt has watched it do all three. What he
						    is owed here is the ABSENCE, which is the rest of the paragraph. */}
						{/*
						  THE GAP, WHERE THERE IS ONE, and the same refusal where there is not.
						
						  This sentence has said "it does not know your league's scoreboard" since it
						  was written, and that half is still exactly true: nothing in this app reads
						  a scoreboard, and what is below is not one. What it CAN say now is the gap
						  — every man each side holds, scored over the league's own period, measured
						  the same way twice — because the reader's own browser can read his
						  opponent's roster off the matchup page in the press that reads his league.
						
						  AND IT STOPS THERE, deliberately. A margin does not steer a single row of
						  this card: the spread that would be needed to turn "behind by 40" into
						  "start the wilder arm" was measured on 64,027 player-days and does not
						  survive the test — a player's own measured spread predicts his next spread
						  18-31% WORSE than knowing only his cohort and his level (src/backtest/
						  spread.ts). So the number is told to the reader, who can act on it, and is
						  kept out of the ranking, which cannot.
						*/}
						{/* AND ONLY WHERE THE TWO LISTS ARE COMPARABLE. "Every man each side holds" is
						    the clause that makes this number defensible, and it is false whenever the
						    opponent list is short — which is the ordinary failure of both routes that
						    fill it: a paste where three names did not match, and a matchup page read
						    before the reader's own roster was stored. A gap of 262.9 against a
						    two-man opponent is not a lead, and the recap card already refuses the
						    same comparison; this card was printing it in bold. Two thirds, because a
						    roster differs from a roster by an injured-list seat or two and not by a
						    third. */}
							<>
								You are{" "}
								{matchup.gap === 0 ?
									"level"
								: matchup.gap > 0 ?
									<>ahead by {matchup.gap}</>
								:	<>behind by {Math.abs(matchup.gap)}</>}
								{matchup.daysLeft !== null && (
									<>
										{" "}
										with {matchup.daysLeft} {matchup.daysLeft === 1 ? "day" : "days"} left
									</>
								)}
								&nbsp;&mdash; every man each side holds, over this scoring period, which is
								not the score your league will pay.
								{/*
								  WITH WHAT, which is the question a reader asks the moment he knows he is
								  behind — and the one the card can answer with arithmetic it has already
								  done. `total` in useMatchup.ts scored every man through his league's own
								  table and knew the side of the ball for each; it summed them and threw
								  the split away. "Behind by 41" and "behind by 41, and it is all pitching"
								  are different instructions for tonight.
								
								  Said only where it points somewhere. Two halves within a few points of
								  each other are a week that is simply close, and a sentence naming a
								  "hole" of four points would be this app inventing a reason to act.
								*/}
								{matchup.gapBy &&
									(() => {
										const { hitting, pitching } = matchup.gapBy
										const worse = Math.abs(hitting - pitching)
										/* Ten points over a scoring period, on a table where a home run is
										   worth four and an out recorded is worth one: below that the two
										   halves are telling a reader the same thing. */
										if (worse < 10) return null
										/*
										   AND ONLY WHEN THERE IS A HOLE TO NAME.
										
										   These are two GAPS, not two totals: a positive half means his men
										   out-scored his opponent's men on that side of the ball. Without
										   this line the sentence picked the SMALLER of the two gaps
										   whatever its sign, so a reader ahead on both halves was told
										   "the gap is in your arms" about arms that were thirty points to
										   the good — a confident instruction to go and fix something that
										   is not broken, printed beside a number that is correct.
										
										   Reproduced in a browser: +92.1 bats, +26.1 arms, total +118.2,
										   and the card named the arms. The case the sentence was written
										   for — a reader behind on one half — is untouched, because the
										   smaller of two gaps is negative exactly when there is a half to
										   name.
										*/
										if (Math.min(hitting, pitching) >= 0) return null
										const behindAt = hitting < pitching ? "bats" : "arms"
										const side = hitting < pitching ? hitting : pitching
										const other = hitting < pitching ? pitching : hitting
										const otherName = hitting < pitching ? "arms" : "bats"
										/*
										   BOTH NUMBERS ARE MARGINS AGAINST HIS OPPONENT, and the first
										   version printed them as bare signed figures — "+12 there
										   against +45" — which reads as two scores. They are neither
										   side's points: each is his men minus his opponent's men on
										   that half of the ball, which is the same comparison the total
										   above it makes, said twice.
										*/
										return (
											<>
												{" "}
												The gap is in your <b>{behindAt}</b>: they are{" "}
												{Math.abs(side)} behind his, while your {otherName} are{" "}
												{Math.abs(other)} {other >= 0 ? "ahead of" : "behind"} his.
											</>
										)
									})()}
							</>
						</p>
					)}
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
				/*
				  "NOTHING BEATS IT" AND "NOTHING BEATS IT BY ENOUGH" ARE DIFFERENT FACTS, and
				  this said the first about both.
				
				  `planLineup` empties `swaps` and `shifts` when the best legal lineup does not
				  clear `lineupMinGain`, and until now the only trace of that was a sentence
				  pushed into `skipped` — a list of MEN, one per line as "Name: reason". Every
				  reader of that array splits on the first ": " to get the name, so the card
				  rendered the whole sentence in the player slot of its could-not-be-priced
				  bullet: "One player on your roster could not be priced, so nothing above
				  counts him: the best legal lineup is worth -144.42 more than today's…".
				  Reproduced on a real 27-man imported roster, 2026-09-23.
				
				  It is now `LineupPlan.leftAlone`, typed as what it is, and it lands here —
				  the one place on the card that was already making this exact claim, and
				  making it too strongly. src/auto/run.ts has printed the two as different
				  sentences all along.
				*/
				<p className="sub">
					Already right — {plan.lineup.pointsNow} projected points
					{plan.lineup.leftAlone ?
						<>, and {plan.lineup.leftAlone}</>
					:	<>, and no legal rearrangement of your own players beats it</>}
					.
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


			{/*
			  THE MOVES STAY WITH THE LINEUP THEY BELONG TO.

			  In a daily-lock league the adds are rows in Today's one list — see `toDo` —
			  because to the reader an add and a start are the same kind of thing and
			  splitting them put the most valuable instruction on the card five blocks down.
			  A league that locks its lineup for the whole period has no Today list to fold
			  them into, so here they keep a heading of their own. Same rows, same planner,
			  one place that draws them.
			*/}
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
						    conceded exactly that, and then the string shipped it anyway. Why it is
						    too strong: that sweep was run against the OLD
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
						:	/* The tail "which is this app's own limit and not a measured best" came off
						     this line: it is the page being unsure of itself in the middle of the
						     advice, at the exact moment it is asking to be trusted, and a reader can
						     do nothing with it. The retraction is not lost, and it is no longer on
						     this card at all: it lives in src/auto/plan.ts beside the cap it
						     governs, which is where the next person to change the number stands.
						     It came off the "How this was decided" fold too — that fold holds the
						     planner's notes about THIS roster, not this repository's history. */
							`stopping at ${plan.swaps.moves.length}`}
						{rules.cap !== null && ` · your league allows ${rules.cap}`}
						{/* WHEN, not why. The gain above is accrued from today, and in a league
						    with a waiver period the claimed man is not his tonight — so the one
						    thing the reader needs beside the instruction is the day it lands.
						    The rows it was read from sit in the title, which is where this app
						    already sends provenance. */}
						{rules.waivers.days !== null && (
							<span title={rules.waivers.sources.join(" · ")}>
								{` · waivers clear in ${rules.waivers.days} day${rules.waivers.days === 1 ? "" : "s"}`}
							</span>
						)}
					</span>
				)}
			</h3>
			{/* Gated on the CANDIDATES, not on the wire. Gated on the wire, this told a
			    reader with a perfectly good ownership estimate behind him that no add
			    could be judged, and sent him to a command line — which is the difference
			    between a website and a developer tool. It only says nothing where there
			    is genuinely nothing: no wire AND no usable ownership in the capture. */}
			{/* Two absences and no third sentence about them. The tail read "so there is no
			    honest way to say who you could get", which restates "no add can be judged" in
			    the app's own voice and adds nothing the reader can act on — 36 words down to
			    22. Both absences stay, because they are different absences with different
			    fixes: a free-agent list nobody has read, and a capture whose ownership
			    figures cannot locate the boundary. */}
			{!candidates.length ?
				<p className="sub">
					No add can be judged: nothing has read your league&rsquo;s free-agent list, and
					who is free cannot be estimated from this capture either.
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
					{/* Named so a suite can tell this list from the others on the card. The row
					    markup itself is `addRow`, shared with the one list Today renders — two
					    copies of it had already drifted once. */}
					<ul className="decide-list decide-moves">{plan.swaps.moves.map(addRow)}</ul>
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
							{/* A GAME. The floor is `bscorePerGame < keepFloor`, and printing a rate
							    with "points" after it is the same unit slip that let the planner
							    compare a whole-window total against this number for months. */}
							{DEFAULTS.keepFloor} a game clear of what the wire still offers at his own
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
				</>
			)}


			{/*
			  CAVEATS, BEHIND ONE LINE — they are not instructions and they were sitting where
			  instructions go.

			  Four bullets stood between the reader and the foot of the card: an innings floor
			  he is nowhere near, two groups of men nothing could price, and what the moves
			  cost against that floor. Every one of them is true and worth keeping, and not one
			  of them is a thing to go and do tonight. The summary counts them, so a reader who
			  is being warned about something knows there is something to open; it names no
			  number and makes no claim, so an unopened fold cannot outrun what is inside it.

			  The COSTS bullet is the one that could argue for staying out here, and it does not
			  get to: it qualifies the adds in the list above, which already carry their own
			  number, and a warning that fires on a floor the same fold says he clears is not a
			  warning the card should lead with.
			*/}
			{(() => {
				const watch =
					(rules.floor !== null && rules.projected !== null ? 1 : 0) +
					skippedWhy.length +
					(today?.misseated.length ? 1 : 0) +
					toDo.caveats.length +
					(rules.floor !== null &&
					rules.after !== null &&
					rules.projected !== null &&
					rules.after < rules.projected ?
						1
					:	0)
				if (!watch) return null
				return (
				<details className="decide-notes decide-watch-fold">
					<summary>
						{watch} {watch === 1 ? "thing" : "things"} to watch
					</summary>
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
											Innings already thrown could not be read. Your pitchers project{" "}
											<b>{rules.projected} more</b> over what is left of this period
											{rules.after !== null && rules.after !== rules.projected && (
												<>
													{" "}
													&mdash; <b>{rules.after}</b> if you make the moves above
												</>
											)}
											.{" "}
										</>
									}
									{/*
									  THE CAVEAT CLAUSE IS GONE FROM THE LINE, and the absence it sometimes carried
									  moved into the sentence that owns it.
									
									  An <em class="decide-why"> sat here in both shapes. With the read landed it said
									  "counted for every pitcher you hold now, whatever seat he was in at the time —
									  which is the most this page can know": 21 words at rest on the answer screen,
									  provenance for a number the reader can do nothing differently about, ending in
									  this page talking about its own limits. Measured at 390x844 against the roster
									  test/decide.mjs builds, it was one of three such clauses standing between the
									  top of the card and the last instruction on it. The same sentence is still in
									  the fold below, in full, for a reader who goes looking for where the numbers
									  came from.
									
									  With the read NOT landed it said "still to come only, from their scheduled
									  turns", and THAT clause was doing real work: it is the only thing stopping a
									  reader weighing 4 against a floor of 20 and claiming a panic streamer. It is an
									  absence, so it is stated as one — first, in the sentence itself — instead of
									  trailing the number in italics.
									*/}
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
						{/*
						  THE MEN THIS APP CANNOT PUT WHERE IT FOUND THEM — the caveat that explains
						  why the plan's total can be lower than his own lineup's.
						
						  `rateAll` prices them and `planLineup` can seat them nowhere, so their
						  points are in the lineup he has and in no seat of the lineup it builds.
						  Measured on a 27-man imported roster, 2026-09-23: five such men, 35.86
						  points for one night and 203.21 over the period, and the planner's own
						  min-gain bar then fired on the difference as though the rearrangement had
						  lost them. That bar now stands down here (see `misseated` in
						  src/auto/plan.ts) — which means the card gives the plan, and this sentence
						  is what stops it being a silent claim that he has his lineup wrong.
						
						  It names this app's data first and his lineup second, in that order, because
						  that is the likelier of the two to be at fault — and because after
						  src/data/paste.ts started unioning a man's own startable seat into his
						  positions (2026-09-23) a real platform read cannot produce this state at
						  all. What is left that can: a hand-typed team, and a man whose OTHER seats
						  the capture's eligibility gets wrong, which it covers for 328 of 1,446
						  players. So the bullet is rare rather than ordinary, and the earlier note
						  here that called it ordinary was wrong — see `misseated` in
						  src/auto/plan.ts for the retraction and the control behind it.
						*/}
						{today && today.misseated.length > 0 && (
							<li>
								<span className="decide-note">·</span>
								<span>
									{today.misseated.length === 1 ? "One of your men sits" : `${today.misseated.length} of your men sit`}{" "}
									in a seat nothing here records {today.misseated.length === 1 ? "him" : "them"} as
									eligible for, so no lineup above can keep{" "}
									{today.misseated.length === 1 ? "him" : "them"} in{" "}
									{today.misseated.length === 1 ? "it" : "them"}:{" "}
									<b>
										{andList(today.misseated.map(m => `${m.name} at ${m.slot}`))}
									</b>
									.
									{/* The union of what it DOES have them at was here and said nothing: over
									    eight men it read "This app has them at OF, Util, 3B, 1B and SS", which
									    is a set no reader can attach to a man. Each man's own seat is already
									    in the list above; what he needs after it is which way to bet. */}
									<em className="decide-why">
										Where your league grants{" "}
										{today.misseated.length === 1 ? "that seat" : "those seats"}, your league
										is right and this app&rsquo;s eligibility is short &mdash; so the rows
										about {today.misseated.length === 1 ? "it" : "them"} are worth less than
										the rest.
									</em>
								</span>
							</li>
						)}
						{/*
						  AND THE PROVENANCE THE ROWS PUT DOWN. A reason like "Injured 60-Day — no
						  source states a return date, so there is no honest projection over this
						  horizon. The Stash view ranks him anyway" is three sentences of caveat
						  inside a row whose job is to say what to do, so the row keeps the fact and
						  the rest arrives here. Nothing is dropped; see `head` in `toDo`.
						*/}
						{toDo.caveats.map(c => (
							<li key={`caveat-${c.name}`}>
								<span className="decide-note">·</span>
								<span>
									<b>{c.name}</b> <em className="decide-why">{c.why}</em>
								</span>
							</li>
						))}
						{/* Men on his roster the model could not price at all. They are neither
						    started nor offered up nor mentioned, which is the whole roster
						    quietly shrinking: the lineup above is planned as if he owned 22
						    players when he owns 24. An absence is stated as an absence. */}
						{skippedWhy.map(g => (
							<li key={g.why}>
								<span className="decide-note">·</span>
								<span>
									{/* No men, no sentence about men. See `skippedWhy`: a line the split
									    could not read a name out of is still reported, as itself. */}
									{g.men.length > 0 && (
										<>
											{g.men.length === 1 ? "One player" : `${g.men.length} players`} on
											your roster could not be priced, so nothing above counts{" "}
											{g.men.length === 1 ? "him" : "them"}: <b>{g.men.join(", ")}</b>.
										</>
									)}
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
				</details>
				)
			})()}

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
						{/*
						  THE HARDCODED RETRACTION CAME OFF THIS LIST, and nothing it protected is
						  lost with it.

						  It read: "Stopping at 2 a week is inherited rather than established: 2 beat
						  one and beat three across 111 weeks and five seasons, but that sweep priced a
						  swap by comparing the two players’ own ratings, where these are priced on what
						  your whole lineup projects afterwards. No season has been played against the
						  newer way of pricing them." Forty-nine words, and every one of them is this
						  repository describing its own measurement history to a man deciding who to
						  start. It existed to retract an overclaim on the heading above — that line
						  once said the cap "is what measured best" — and that overclaim was itself
						  removed: the heading now says "stopping at 2", which claims nothing and so
						  needs no retracting. The evidence is not deleted, it is in src/auto/plan.ts
						  at the cap it governs (`treat the cap as inherited rather than established`)
						  and in the comment on that heading, which is where the next person to change
						  the number will be standing.

						  What is left in this fold is the planner’s own notes, which name men and
						  bars for THIS roster on THIS night. Those are an audit trail for advice the
						  reader is being asked to act on. A paragraph about which sweep priced which
						  way is not.
						*/}
					</ul>
				</details>
			)}
		</section>
	)
}

