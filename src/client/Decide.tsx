import { useMemo } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { hydrate } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { rateAll } from "../engine/bscore.ts"
import { resolvePeriod, windowFrom } from "../engine/period.ts"
import { activeSlots, planLineup, planSwaps, DEFAULTS, type PlanInput } from "../auto/plan.ts"
import { deriveInningsMinimum, deriveMoveLimit } from "../import.ts"
import { lineupStore } from "./lineup.ts"
import { pool as poolStore } from "./pool.ts"
import { normalizeName } from "./useBoard.ts"
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
	leagueKey
}: {
	snapshot: Snapshot | null
	league: League | null
	leagueKey: string | null
}) => {
	const seats = leagueKey ? lineupStore.of(leagueKey) : null
	const wire = leagueKey ? poolStore.of(leagueKey) : null

	/**
	 * Rated over the SCORING PERIOD, not a fortnight.
	 *
	 * The horizon is the decision, not a setting. A head-to-head matchup is settled
	 * on the period, so that is the window a move this week is worth something over;
	 * ranking the next fourteen days would price half of it against a matchup that
	 * has not started.
	 */
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
				injuries: h.injuries,
				injuryPolicy: "exclude",
				teams: league.meta.max_teams
			})
		}
	}, [snapshot, league])

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
			underlying: h.underlying, injuries: h.injuries, injuryPolicy: "exclude",
			teams: league.meta.max_teams
		})
		const byName = new Map(rows.map(r => [normalizeName(r.player.name), r]))
		const playing = new Set<string>()
		const idle: string[] = []
		for (const sp of seats.spots) {
			const r = byName.get(normalizeName(sp.name))
			const plays = r?.player.teamId != null && w.games.has(r.player.teamId)
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
		return { day, lineup, idle, unfilled, playing: playing.size }
	}, [snapshot, league, seats])

	const plan = useMemo(() => {
		if (!rated || !league || !seats?.spots.length) return null
		const input: PlanInput = {
			// `team` is optional on the stored seat and required on the planner's, and
			// the difference is real: a seat read with no club beside it is a seat whose
			// club we do not know, not one with no club.
			roster: seats.spots.map(sp => ({ ...sp, team: sp.team ?? null })),
			rated: rated.rows,
			availableNames: new Set((wire?.players ?? []).map(p => normalizeName(p.name))),
			available: (wire?.players ?? []).map(p => ({ name: p.name, positions: p.positions })),
			shape: {
				slots: league.roster.slots,
				slot_order: league.roster.slot_order,
				slot_accepts: league.roster.slot_accepts
			},
			options: DEFAULTS
		}
		return { lineup: planLineup(input), swaps: planSwaps(input) }
	}, [rated, league, seats, wire])
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
		if (floor === null || !rated || !lineup?.starters.length) return { floor, cap, projected: null }
		/**
		 * Only the men in SEATS, because only they throw innings that count.
		 *
		 * This summed every pitcher on the roster and reported 82.5 against a floor of
		 * 20 — a comfortable pass built by counting four pitchers sitting on the bench,
		 * whose innings accrue to nobody. The floor is a question about the lineup, so
		 * it is asked of the lineup.
		 */
		const started = new Set(
			lineup.starters
				.filter(st => !RESERVE.test(st.slot))
				.map(st => normalizeName(st.name))
		)
		let outs = 0
		for (const r of rated.rows) {
			if (!r.rateable || r.player.group !== "pitching") continue
			if (!started.has(normalizeName(r.player.name))) continue
			outs += (r.projection.stats.outs as number | undefined) ?? 0
		}
		return { floor, cap, projected: Number((outs / 3).toFixed(1)) }
	}, [league, rated, lineup])

	if (!league) return null

	// Each of these is a different missing thing with a different fix, and naming the
	// wrong one sends the reader to the wrong button.
	if (!seats?.spots.length) {
		/**
		 * How to fix it depends on the platform, and getting that wrong sends the
		 * reader somewhere that cannot work.
		 *
		 * ESPN answers a browser directly, so "read it on My team" is a real
		 * instruction. Yahoo sends no CORS headers at all — no page can ever read a
		 * Yahoo league, this one included — so for a Yahoo league that same sentence
		 * is a dead end, and the only route is the command line and this file. The
		 * card used to give both readers the ESPN instruction.
		 */
		const yahoo = league.meta.platform === "yahoo"
		/**
		 * The TEAM url, not the league url.
		 *
		 * `src/cli.ts` reads the roster off team 8's own page, and the stored
		 * `league_url` stops at the league. Printing that would give a command that
		 * silently returns settings and free agents and no roster — which is the one
		 * thing this card is blocked on.
		 */
		const base = league.meta.league_url
		const url =
			base && league.meta.team_id ?
				`${base.replace(/\/+$/, "")}/${league.meta.team_id}`
			:	(base ?? "<your league URL>")
		return (
			<section className="card full decide decide-blocked">
				<h2>What should I do?</h2>
				<p>
					Nothing yet — this page has not been told which players are yours, so it
					cannot tell you who to start or who to add.
				</p>
				{yahoo ?
					<>
						<p>
							Yahoo sends no CORS headers, so no web page is ever handed your league —
							not this one, not any. Run this once on your own machine and drop the
							file it writes anywhere on this page:
						</p>
						<pre className="decide-cmd">
							node --experimental-strip-types src/cli.ts {url}
						</pre>
						<p className="sub">
							It reads three things: your league&rsquo;s settings, the free agents in
							it, and your roster with the seat each man is in. The middle one is why
							this route exists — without it nothing here knows who you could get.
						</p>
					</>
				:	<p>
						Read your roster on <b>My team</b> — your platform answers a browser
						directly, so this page can do it itself.
					</p>
				}
				<p className="sub">
					Until then the board below ranks every player in baseball, which is a
					leaderboard rather than an answer.
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
							{today.playing} of your men have a game · {today.lineup.pointsPlanned} projected
						</span>
					</h3>
					{today.lineup.starters.length ?
						<ul className="decide-list decide-today">
							{today.lineup.starters.map((st, i) => (
								<li key={`${st.slot}-${i}`}>
									<span className="decide-slot">{st.slot}</span>
									<span>
										<b>{st.name}</b> <em className="decide-why">{st.points} projected</em>
									</span>
								</li>
							))}
							{today.unfilled.map((slot, i) => (
								<li key={`empty-${slot}-${i}`} className="decide-empty">
									<span className="decide-slot">{slot}</span>
									<span>
										<em className="decide-why">
											leave empty — nobody you own is projected to play here today
										</em>
									</span>
								</li>
							))}
						</ul>
					:	<p className="sub">None of your players has a game today.</p>}
					{today.idle.length > 0 && (
						<p className="sub decide-idle">
							<b>Sit {today.idle.length}:</b> {today.idle.join(", ")} — their clubs are not
							playing today, so they score nothing in a seat.
						</p>
					)}
				</>
			)}

			<h3 className="decide-head">
				{today ? "Over the rest of the period" : "Set your lineup"}
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
							<span className="decide-delta">+{s.gain}</span>
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
						    not: the planner stops at two because two is what measured best —
						    two moves a week beat one and beat three over 111 weeks and five
						    seasons. Below the cap the sentence is the other one, and true. */}
						{plan.swaps.moves.length === 0 ? "none clear the bar"
						: plan.swaps.moves.length < DEFAULTS.maxMoves ?
							`${plan.swaps.moves.length} clear${plan.swaps.moves.length === 1 ? "s" : ""} the bar`
						:	`${plan.swaps.moves.length} a week is what measured best`}
						{rules.cap !== null && ` · your league allows ${rules.cap}`}
					</span>
				)}
			</h3>
			{!wire?.players.length ?
				<p className="sub">
					No add can be judged: this page has not read your league&rsquo;s free-agent list,
					so it does not know who you could get. Yahoo sends no CORS headers, so a browser
					never can — run the command line once and drop the file it writes onto this page.
				</p>
			: !plan?.swaps.moves.length ?
				<p className="sub">
					None worth making. {plan?.swaps.notes[0] ?? ""}
				</p>
			:	<ul className="decide-list">
					{plan.swaps.moves.map(m => (
						<li key={`${m.add}-${m.drop}`}>
							<span className="decide-delta">+{m.gain}</span>
							<span>
								Add <b>{m.add}</b>, drop <b>{m.drop}</b>
								<em className="decide-why">{m.reason}</em>
							</span>
						</li>
					))}
				</ul>
			}

			{rules.floor !== null && rules.projected !== null && (
				<>
					<h3 className="decide-head">Watch</h3>
					<ul className="decide-list decide-watch">
						{rules.floor !== null && rules.projected !== null && (
							<li>
								<span
									className={
										rules.projected >= rules.floor ? "decide-ok" : "decide-warn"
									}
								>
									{rules.projected >= rules.floor ? "OK" : "SHORT"}
								</span>
								<span>
									Your league requires <b>{rules.floor} innings</b> this period and your
									pitchers project <b>{rules.projected}</b>.{" "}
									<em className="decide-why">
										An estimate from their scheduled turns, not an announcement — and it
										counts the staff you have now, before any move above.
									</em>
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
					</ul>
				</details>
			)}
		</section>
	)
}

