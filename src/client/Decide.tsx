import { useEffect, useMemo, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { hydrate } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { ownershipCut, rateAll, slotsFor } from "../engine/bscore.ts"
import { resolvePeriod, windowFrom } from "../engine/period.ts"
import {
	activeSlots, planLineup, planSwaps, seatedInnings, DEFAULTS, type PlanInput
} from "../auto/plan.ts"
import { deriveInningsMinimum, deriveMoveLimit } from "../import.ts"
import { freshness } from "./panels.tsx"
import { canReadPool, api, poolIsPartial, type AvailablePool } from "./api.ts"
import { lineupStore } from "./lineup.ts"
import { pool as poolStore } from "./pool.ts"
import { roster } from "./roster.ts"
import { normalizeName } from "./useBoard.ts"
import { useSlate } from "./useSlate.ts"
import { useInjuries } from "./useInjuries.ts"
import { statusOf, lockFor, nextLock, clock, type TodayStatus } from "../data/today.ts"
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
const readAgo = (at: string): string => {
	const hours = (Date.now() - Date.parse(at)) / 3_600_000
	if (!Number.isFinite(hours)) return "at an unknown time"
	if (hours < 1) return "in the last hour"
	if (hours < 36) return `${Math.round(hours)} hours ago`
	return `${Math.round(hours / 24)} days ago`
}

/** Yahoo writes its non-playing seats as BN, IL, IL+ and NA. */
const RESERVE = /^(BN|IL|NA)/i

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
	const owned = useMemo(() => {
		if (!leagueKey) return []
		try {
			return roster.of(leagueKey)
		} catch {
			return []
		}
	}, [leagueKey])
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
		if (storedSeats?.spots.length) return { spots: storedSeats.spots, at: storedSeats.at, known: true }
		if (!owned.length || !snapshot) return null
		const byId = new Map(snapshot.players.map(p => [p.id, p]))
		const elig = snapshot.eligibility ?? {}
		const spots = owned.flatMap(k => {
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
	}, [storedSeats, owned, snapshot])

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
		const period = resolvePeriod(league, new Date().toISOString().slice(0, 10), h.seasonEnd)
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
		if (league.scoring_period?.lineup_lock !== "daily") return null
		const h = hydrate(snapshot)
		const day = new Date().toISOString().slice(0, 10)
		const w = windowFrom(h.slate ?? [], day, day)
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
		const idle: string[] = []
		/** Men the board has no row for at all — a capture that predates a call-up, a
		 *  spelling Yahoo and MLB disagree on. Not the same as a man with no game, and
		 *  it must not be reported as one. */
		const unmatched: string[] = []
		for (const sp of seats.spots) {
			const r = byName.get(normalizeName(sp.name))
			if (!r) {
				if (!RESERVE.test(sp.slot)) unmatched.push(sp.name)
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
			if (plays) playing.add(normalizeName(sp.name))
			else if (!RESERVE.test(sp.slot)) idle.push(sp.name)
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
		const activeNow = seats.spots.filter(sp => !RESERVE.test(sp.slot))
		const bench = activeNow.filter(sp => !seated.has(normalizeName(sp.name)))
		const nowActive = new Set(activeNow.map(sp => normalizeName(sp.name)))
		const start = lineup.starters.filter(st => !nowActive.has(normalizeName(st.name)))
		return {
			day, lineup, idle, unmatched, unfilled, playing: playing.size,
			/** Every man rated for TODAY, so the seats nobody you own can fill can be
			 *  offered somebody who is actually on a card tonight. */
			ratedToday: rows,
			/** How many clubs are on today at all. Thirteen empty seats reads as a
			 *  broken app; "only five games are being played" reads as a Wednesday. */
			games: slate ? slate.games.length : null,
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
		const today = new Date().toISOString().slice(0, 10)
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
			const dropped = new Set(plan.swaps.moves.map(m => normalizeName(m.drop)))
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
				.filter(
					r =>
						r.rateable &&
						r.slots.includes(slot) &&
						free.has(normalizeName(r.player.name)) &&
						!taken.has(normalizeName(r.player.name))
				)
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
	}, [today, candidates, league])

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
					Open <b>Setup</b> and set the team count.
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
					Open <b>Setup</b> and read the values off your platform, or enter them.
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
		const base = league.meta.league_url
		const url =
			base && league.meta.team_id ?
				`${base.replace(/\/+$/, "")}/${league.meta.team_id}`
			:	base
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
					For <b>{PERIOD_NAME[rated.period.kind]}</b>, {rated.period.start} to {rated.period.end}
					{rated.period.assumed && " — assumed, your league states no scoring period"}.
				</p>
			)}

			{/* Today first, because today is the one that locks. A lineup change is free
			    and reversible and this league takes one every day; an add costs a move
			    and a player and can be made a few times a week. */}
			{today && (
				<>
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
							{today.games !== null && (
								<>
									{today.games} {today.games === 1 ? "game" : "games"} today ·{" "}
								</>
							)}
							{today.playing} of your men can score · your lineup projects{" "}
							{today.lineup.pointsPlanned}
							{today.nextLock !== null && (
								<> · next lock {clock(today.nextLock)}</>
							)}
						</span>
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
					: today.bench.length || today.start.length || today.lineup.shifts.length ?
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
								{today.lineup.shifts.map(sh => (
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
										today.lineup.shifts.length,
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
							<>vs your seats as read {readAgo(today.readAt)}</>
						:	<>
								Nothing here knows which seats you currently have these men in, so this is
								the lineup to <b>set</b>, not the changes to make. Read your roster off
								your platform on <b>Setup</b> and it becomes a list of changes.
							</>
						}
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
							<span>
								Start <b>{s.start}</b> at {s.startSlot}, sit <b>{s.sit}</b>
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

						    "is what measured best" was too strong even so, and the fold below
						    says why: that sweep was run against the OLD scoring, before swaps
						    were priced on the lineup that follows them. The cap is inherited
						    from a measurement of a different planner, which is a real thing to
						    know and not a thing to bury. */}
						{plan.swaps.moves.length === 0 ? "none clear the bar"
						: plan.swaps.moves.length < DEFAULTS.maxMoves ?
							`${plan.swaps.moves.length} clear${plan.swaps.moves.length === 1 ? "s" : ""} the bar`
						:	`stopping at ${plan.swaps.moves.length}, the cap that measured best`}
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
				<p className="sub">
					None worth making. {plan?.swaps.notes[0] ?? ""}
				</p>
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
									, drop <b>{m.drop}</b>
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
								<span>
									Your league requires <b>{rules.floor} innings a week</b>. Your pitchers
									project <b>{rules.projected} more</b> over what is left of this period
									{rules.after !== null && rules.after !== rules.projected && (
										<>
											{" "}
											— <b>{rules.after}</b> if you make the moves above
										</>
									)}
									.{" "}
									{/* One clause on the line, the rest a tap away. What a reader has
									    to know before acting is that this counts only what is STILL TO
									    COME; why it cannot count the rest is a fact about this page, not
									    about his week. */}
									{/* The clause is an <em> and the fold is its SIBLING, not its child:
									    <details> is flow content and cannot live inside phrasing content,
									    and a browser handed that quietly closes the <em> early — which
									    puts the fold outside the element it is styled inside. */}
									<em className="decide-why">
										still to come only, from their scheduled turns
									</em>
									<details className="decide-fine">
										<summary>why not the whole week</summary>
										Innings already thrown this period are on your team page, which
										nothing here reads — so this can tell you what is left, not whether
										you will clear the floor. The turns themselves are MLB&rsquo;s
										published probables, which are an announcement about a plan.
									</details>
								</span>
							</li>
						)}
						{/* Men on his roster the model could not price at all. They are neither
						    started nor offered up nor mentioned, which is the whole roster
						    quietly shrinking: the lineup above is planned as if he owned 22
						    players when he owns 24. An absence is stated as an absence. */}
						{!!plan?.lineup.skipped.length && (
							<li>
								<span className="decide-note">·</span>
								<span>
									{plan.lineup.skipped.length === 1 ? "One player" : `${plan.lineup.skipped.length} players`}{" "}
									on your roster could not be priced this period, so nothing above
									counts them:{" "}
									<b>{plan.lineup.skipped.map(x => x.split(":")[0]).join(", ")}</b>.
									{/* The per-man reason is `resolveRoster`'s, written for one man
									    ("he has no number to compare") and wrong under a list of two.
									    The shared half is the true half. */}
									<em className="decide-why">
										No projection could be made for them over this window, so they
										are neither started nor offered up.
									</em>
								</span>
							</li>
						)}
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

