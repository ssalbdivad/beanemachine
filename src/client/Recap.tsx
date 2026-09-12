import { useEffect, useMemo, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { slotsFor } from "../engine/bscore.ts"
import { scoreStats, tableFor } from "../engine/points.ts"
import { resolvePeriod } from "../engine/period.ts"
import { bestNights, gradeRecord, recap, weekShape, type RecapMan } from "../auto/recap.ts"
import { dayIsFinal } from "../data/actuals.ts"
import { normalizeName } from "../data/names.ts"
import { andList } from "../data/names.ts"
import { roster, rosterKey } from "./roster.ts"
import { opponentStore } from "./opponent.ts"
import { rosterFromPaste } from "../data/paste.ts"
import { lineupStore } from "./lineup.ts"
import { ledgerStore } from "./ledger.ts"
import { useStored } from "./stores.ts"
import { useActuals, usePeriodActuals, lastNight } from "./useActuals.ts"
import { localDate } from "../data/today.ts"
import "./recap.css"

/** "Sep 12" from an ISO date, at noon so a zone west of Greenwich cannot print yesterday.
 *  Same helper and same reason as `plainDate` in src/client/Decide.tsx and `span` in
 *  src/client/Trade.tsx — three screens naming a window must spell it the same way. */
const plainDay = (iso: string): string =>
	new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })

/**
 * LAST NIGHT.
 *
 * Every other screen in this app is an estimate and says so. This one is the only surface
 * that states a fact: these are the points your men actually scored, in your league's own
 * scoring, from the record MLB published. It exists because the question a fantasy manager
 * asks first every morning — "what happened, and did I get it right?" — had no screen at
 * all, and because a recommendation engine that never tells you how it did is asking for
 * trust it has not earned.
 *
 * WHY IT IS NOT A TAB. It was going to be. Measured at 390px: the tab strip is 344px wide
 * and the three tabs already in it take 277px with their gaps, leaving 67px — and a fourth
 * tab reading "LAST NIGHT" needs about 108px at the bar's 11px/1.1px-tracking type. Four
 * tabs were tried once before and removed for exactly this reason, with the note in
 * src/client/App.tsx recording that "the tab bar did not fit the phone the app is actually
 * opened on". So this is a strip at the top of Tonight instead, which is better than the
 * tab would have been anyway: last night's result belongs beside tonight's decision, on the
 * screen a reader opens every day, rather than behind a tab he has to remember.
 *
 * THREE NUMBERS, IN INCREASING ORDER OF HOW MUCH THEY STING, and each one refused rather
 * than guessed when its input is missing. `src/auto/recap.ts` does the arithmetic and owns
 * those refusals; this file's whole job is to render them without overstating any of them.
 */
export const Recap = ({
	snapshot,
	league,
	leagueKey
}: {
	snapshot: Snapshot | null
	league: League | null
	leagueKey: string | null
}) => {
	const rev = useStored()
	const date = lastNight()

	/**
	 * Your men, each joined to the id MLB keys him by and to the seat he was in.
	 *
	 * TWO SOURCES, and the same precedence the Tonight card uses, for the same reasons. The
	 * stored SEATS are preferred when they exist, because they are the only thing that knows
	 * where a man was sitting and a recap without seats cannot say what a LINEUP scored. The
	 * ROSTER is the authority on who is yours, so where it has ids the seats are filtered by
	 * it — a seat that outlived a cleared roster is how the Tonight card once went on
	 * printing a whole plan for a team that had just been deleted. A man the capture cannot
	 * name at all is kept, because that is an absence rather than a disowning.
	 *
	 * Where neither a seat nor a name resolves to a player in the capture, he is dropped
	 * rather than carried as a zero: this card's whole claim is that its numbers come from
	 * MLB's record, and a man it cannot look up has no record to show.
	 *
	 * A TWO-WAY PLAYER is two rows in the capture under one name, and the seat decides which
	 * of them a row is about: a seat whose eligibility mentions a pitching slot is about his
	 * pitching line. That is a reading of the seat and not a proof, and it is the best
	 * available — nothing in the stored seats states a side of the ball. Where there is no
	 * seat, the roster's own key settles it outright, because the roster stores the side.
	 */
	const men = useMemo((): { men: RecapMan[]; error: string | null; seatsAt: string | null } => {
		if (!leagueKey || !snapshot) return { men: [], error: null, seatsAt: null }
		let ids: string[] = []
		try {
			ids = roster.of(leagueKey)
		} catch (e) {
			/* A store the app has declared unreadable must not be acted on silently — My
			   league owns the explaining and the repair, and this card's job is to withhold.
			   Same rule as the Tonight card's `owned` memo. */
			return { men: [], error: e instanceof Error ? e.message : String(e), seatsAt: null }
		}
		const seats = lineupStore.of(leagueKey)
		const elig = snapshot.eligibility ?? {}
		const named = new Map<string, typeof snapshot.players>()
		for (const p of snapshot.players) {
			const n = normalizeName(p.name)
			const at = named.get(n)
			if (at) at.push(p)
			else named.set(n, [p])
		}
		const owned = new Set(ids.map(k => k.split(":")[0]))

		if (seats?.spots.length) {
			const out: RecapMan[] = []
			for (const sp of seats.spots) {
				const cands = named.get(normalizeName(sp.name)) ?? []
				if (!cands.length) continue
				if (ids.length && !cands.some(c => owned.has(String(c.id)))) continue
				const wantsPitcher = sp.positions.some(x => /^(SP|RP|P)$/i.test(x.trim()))
				const p =
					cands.length > 1 ?
						(cands.find(c => c.group === (wantsPitcher ? "pitching" : "hitting")) ?? cands[0]!)
					:	cands[0]!
				out.push({
					key: rosterKey(p),
					name: p.name,
					slot: sp.slot,
					positions: sp.positions.length ? sp.positions : slotsFor(p, elig[String(p.id)])
				})
			}
			if (out.length) return { men: out, error: null, seatsAt: seats.at }
		}

		/* No seats: a team typed by hand, which is the only route a Yahoo user has in a
		   browser and therefore the common case rather than the edge one. Every number that
		   needs a lineup comes back null from `recap` and says so. */
		const byKey = new Map(snapshot.players.map(p => [`${p.id}:${p.group}`, p]))
		const out = ids.flatMap(k => {
			const p = byKey.get(k)
			return p ?
					[{
						key: rosterKey(p),
						name: p.name,
						slot: null,
						/* SLOTS, not MLB's positions — `legalSlotsFor` asks whether a token appears
						   in the league's own `slot_accepts` lists, which are written in the
						   platform's slot names. A centre fielder is "CF" to MLB and fills an "OF"
						   seat. Same call the Tonight card makes, for the same reason. */
						positions: slotsFor(p, elig[String(p.id)])
					}]
				:	[]
		})
		return { men: out, error: null, seatsAt: null }
	}, [leagueKey, snapshot, rev])

	const season =
		typeof snapshot?.season === "number" ? snapshot.season
		: typeof league?.meta.season === "number" ? league.meta.season
		: null

	/*
	  THE READ HAPPENS EVEN WITH NO TEAM, which is the one place this card spends a request on
	  somebody who has told the page nothing — and it is the best 38 KB in the product.
	  
	  Before any setup, every number this app can show a stranger is about a borrowed league
	  and a board ranked by value over replacement, which correctly puts unrostered men on top
	  and to a Yahoo manager reads as five names he has never heard of. Last night's real
	  points need nothing from him, are about players he knows, and are facts rather than
	  estimates. It is gated on a LEAGUE rather than on a roster, because the points have to
	  be denominated in something, and the preset says on the card that they are borrowed.
	*/
	const { actuals, error, missing, loading } = useActuals(season, date, !!league)
	/* Whether that day's baseball is actually over — see `dayIsFinal`. A reader at twenty
	   past midnight is asking about games with outs left in them, and the card may show
	   what MLB has so far as long as it says so. What it may not do is write a verdict. */
	const final = dayIsFinal(date)

	/** What the best nights in baseball were worth, for a reader with no team yet. */
	const best = useMemo(
		/*
		  SIX, NOT EIGHT, and the number comes off the screen rather than out of the air.
		  
		  Measured at 390x844 on the published build with eight: at rest (`scrollY` 0) the setup
		  dock owns the pixels rows seven and eight are drawn in — `document.elementFromPoint`
		  between y=725 and y=844 returns `DIV.dock-bar`, `P.dock-say` and `BUTTON.primary` over
		  them — and at the other end of the document the sticky masthead owns row eight's. So a
		  list of eight showed six at either end of its scroll, and the two it hid were the two
		  a reader would have had to go looking for.
		  
		  FIVE, after re-measuring the published build rather than reasoning about it: with six,
		  the rows land at y=421, 486, 551, 617, 682 and 747, and the dock begins at about 742 —
		  so the sixth was still under it and `elementFromPoint` at its centre returned the dock's
		  own paragraph. Five is what fits the state the screen is actually IN when a reader
		  arrives, which is at rest with the dock up.
		  
		  A count that varied by viewport would fit more on a desktop and is not worth the
		  machinery: the phone is the device this is opened on, nothing downstream reads this list,
		  and the cost is the sixth-best night in baseball.
		*/
		() => (actuals && league && !men.men.length ? bestNights(actuals.lines, league, 5) : null),
		[actuals, league, men]
	)

	/**
	 * THIS MATCHUP SO FAR, which is the only honest thing this app can say about a week.
	 *
	 * One number, and the restraint is the whole design. What every man you hold has scored
	 * inside the league's own scoring period, from MLB's day-by-day record. Not "what your
	 * lineup scored": the seats changed every day of that week and this browser holds only
	 * today's, so a lineup total over a period would be today's seats applied to Monday, which
	 * is a confident number about a team that did not exist.
	 *
	 * It is also not the SCORE. Yahoo pays only the men in your lineups, and the app can see
	 * neither your past lineups nor any of your opponent's — grep across src/ finds nothing
	 * that reads a rival roster or a scoreboard, and the Tonight card says so in its own words.
	 * What this is is the size of your week, which is the thing a streaming decision is made
	 * against, and the sentence says which of the two it is.
	 *
	 * One request pays for it and the innings floor both: same window, same dates, and
	 * `usePeriodActuals` is shared so the pitching rows are not fetched twice.
	 */
	/* The league's own period, resolved the same way every other screen resolves it — from the
	   league and the capture's last scheduled day, never from a guess about a week. Null where
	   the snapshot has not arrived, which is the state the hook below refuses to fetch in. */
	const period = useMemo(
		() => (league && snapshot ? resolvePeriod(league, localDate(), snapshot.horizon.end) : null),
		[league, snapshot]
	)
	const periodTo = lastNight()
	const soFar = usePeriodActuals(
		season,
		/* The period's OWN first day, not `start`, which is today wherever today is inside the
		   period — that edge is for a forward-looking rating and this question is about what has
		   already happened. See `periodStart` in src/engine/period.ts. */
		period?.periodStart ?? null,
		periodTo,
		!!period?.periodStart && period.periodStart <= periodTo && men.men.length > 0,
		["hitting", "pitching"]
	)
	/**
	 * AND WHAT HIS MEN SCORED, once the reader has told the page who they are.
	 *
	 * The same arithmetic on the same read, over the same window, against the same scoring
	 * table — which is what makes the comparison fair in the one way it can be. Neither figure
	 * is what Yahoo will pay, because Yahoo pays only the men in a lineup and this page can see
	 * neither his lineups nor the reader's past ones; both count every man held, so the GAP is
	 * measured the same way on both sides, and the sentence says that out loud twice.
	 */
	const rivalKeys = useMemo(() => {
		if (!leagueKey) return []
		try {
			return opponentStore.of(leagueKey)
		} catch {
			return []
		}
	}, [leagueKey, rev])

	const periodTotalFor = (keys: string[]): number | null => {
		if (!soFar.lines || !league || !keys.length) return null
		let sum = 0
		for (const key of keys) {
			const line = soFar.lines.get(key)
			if (!line) continue
			const group = key.endsWith(":pitching") ? "pitching" : "hitting"
			sum += scoreStats(line.stats, tableFor(league, group), group).points
		}
		return Number(sum.toFixed(1))
	}
	const rivalTotal = useMemo(
		() => periodTotalFor(rivalKeys),
		[soFar.lines, league, rivalKeys]
	)
	/** Men the reader has entered on both sides, by name, so the card can say whose. */
	const both = useMemo(() => {
		if (!rivalKeys.length || !men.men.length) return []
		const his = new Set(rivalKeys)
		return men.men.filter(m => his.has(m.key)).map(m => m.name)
	}, [rivalKeys, men])

	/** Who made that number and who is eating it, off the read it already paid for. */
	const week = useMemo(
		() =>
			soFar.lines && league && men.men.length && period?.periodStart ?
				weekShape(
					men.men,
					soFar.lines,
					league,
					Math.round(
						(Date.parse(`${periodTo}T00:00:00Z`) -
							Date.parse(`${period.periodStart}T00:00:00Z`)) /
							86_400_000
					) + 1
				)
			:	null,
		[soFar.lines, league, men, period, periodTo]
	)

	const periodTotal = useMemo((): number | null => {
		if (!soFar.lines || !league || !men.men.length) return null
		let sum = 0
		for (const m of men.men) {
			const line = soFar.lines.get(m.key)
			if (!line) continue
			const group = m.key.endsWith(":pitching") ? "pitching" : "hitting"
			sum += scoreStats(line.stats, tableFor(league, group), group).points
		}
		return Number(sum.toFixed(1))
	}, [soFar.lines, league, men])

	const result = useMemo(() => {
		if (!actuals || !league || !men.men.length) return null
		return recap({
			date,
			men: men.men,
			lines: actuals.lines,
			league,
			missing,
			shape: {
				slots: league.roster.slots,
				slot_order: league.roster.slot_order,
				slot_accepts: league.roster.slot_accepts
			}
		})
	}, [actuals, league, men, date, missing])

	/**
	 * BILLY'S RECORD, and it is the only number in this app that can be wrong in public.
	 *
	 * Everything above needs no history: it works on a first visit from public data. This
	 * needs the recommendation as it stood before the games, which `src/client/ledger.ts`
	 * has been recording since the Tonight card started writing it.
	 *
	 * One request total, ever. Yesterday is graded from the read this card already made, and
	 * every earlier day comes back from the verdict stored when IT was yesterday. Sixty days
	 * graded live would be 120 requests and about 2.3 MB every render, for answers that
	 * cannot change.
	 */
	const record = useMemo(() => {
		if (!leagueKey || !league || !actuals) return null
		let entries
		try {
			entries = ledgerStore.of(leagueKey)
		} catch {
			// A damaged history is My league's to explain and the reader's to clear. This card
			// still has last night, which needs none of it.
			return null
		}
		if (!entries.length) return null
		return gradeRecord({
			entries,
			/*
			  THREE STATES, AND ONLY ONE OF THEM IS A DAY THIS RECORD MAY SPEAK ABOUT.
			  
			  A half-answered read maps to null: grading a day whose hitters are missing would
			  score both lineups over the pitchers alone. A day whose late games are still in
			  play is left OUT of the map, because "the results aren't in yet" is exactly what
			  is true of it — the read succeeded and the games have not finished. Only a
			  complete, finished day is handed over, and `settle` below is gated on the same
			  two conditions, because a verdict is written once and never asked again.
			*/
			byDate: new Map(
				missing.length ? [[date, null]]
				: !final ? []
				: [[date, actuals.lines]]
			),
			readable: date,
			league
		})
	}, [leagueKey, league, actuals, date, rev, missing, final])

	/* Yesterday's verdict is written down the first morning it can be, so tomorrow's record
	   needs no request for it. `settle` refuses to overwrite, which is what keeps this from
	   being a write loop — the write bumps the revision, the revision recomputes `record`,
	   and the second pass finds the day already settled. */
	const settled = useRef<string | null>(null)
	useEffect(() => {
		if (!leagueKey || !record) return
		/* Belt and braces: `record` cannot contain an unfinished or half-read day after the
		   memo above, and this is the write that cannot be taken back, so it says the
		   condition out loud rather than relying on the day not being in the list. */
		if (!final || missing.length) return
		const today = record.days.find(d => d.date === date)
		if (!today || settled.current === date) return
		settled.current = date
		try {
			ledgerStore.settle(leagueKey, date, {
				asked: today.asked,
				had: today.had,
				worth: today.worth,
				unchanged: today.unchanged,
				at: new Date().toISOString()
			})
		} catch {
			// nothing above depends on the write succeeding
		}
	}, [leagueKey, record, date, final, missing])

	const day = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
		weekday: "long",
		month: "short",
		day: "numeric"
	})

	/*
	  A READER WITH NO TEAM GETS LAST NIGHT ANYWAY, and this is the first thing he sees.
	  
	  It used to render nothing at all here, on the reasoning that a man who has not said who
	  his players are cannot be told what they scored. True, and the conclusion was wrong: what
	  he CAN be told is what the best nights in baseball were worth, which needs nothing from
	  him, names players he knows, and is the only thing on a first visit that is a fact rather
	  than an estimate. The borrowed scoring is stated on the card, in the same words the board
	  uses about itself.
	  
	  A damaged roster store falls through to here too, and that is right: it means the card
	  stops claiming to be about HIS team without going blank, and My league still owns the
	  explaining and the repair.
	*/
	if (!men.men.length || men.error)
		return best && best.length ?
				<section className="card full recap">
					<header className="recap-head">
						<h2>Last night</h2>
						<span className="recap-day">{day}</span>
					</header>
					<p className="sub">
						The best nights in baseball, worth what one real league&rsquo;s scoring would have
						paid for them. Real box scores, not projections &mdash; put your team in and this
						becomes your team&rsquo;s night.
					</p>
					<ul className="recap-list recap-best">
						{/* The gutter holds the RANK here, not a seat: there is no lineup on this
						    version of the list, and a club abbreviated into four characters was
						    tried and abandoned — initials gave "Milwaukee Brewers" as B and "New
						    York Yankees" as YY, and a thirty-club table would be one more thing to
						    keep current against a league that has moved a franchise twice this
						    decade. The club is spelled out on the line below instead, where there
						    is room for it. */}
						{best.map((b, i) => (
							<li key={b.key}>
								<span className="recap-slot">{i + 1}</span>
								<span className="recap-name">{b.name}</span>
								<span className="recap-pts">{b.points}</span>
								<span className="recap-top">
									{[b.team, b.top.map(c => `${c.code} ${c.points > 0 ? "+" : ""}${c.points}`).join("  ")]
										.filter(Boolean)
										.join("  \u00b7  ")}
								</span>
							</li>
						))}
					</ul>
				</section>
			:	null

	if (loading)
		return (
			<section className="card full recap recap-wait">
				<h2>Last night</h2>
				<p className="sub">Asking MLB what your men did&hellip;</p>
			</section>
		)

	if (!result)
		return (
			<section className="card full recap recap-wait">
				<h2>Last night</h2>
				<p className="sub">
					{error ?
						`Couldn’t check last night’s results — ${error}`
					:	"Couldn’t check last night’s results."}
				</p>
			</section>
		)

	/*
	  NO BASEBALL IS ITS OWN SCREEN.
	  
	  `recap` has already refused every total, so rendering the normal card would print a
	  bold 0 over a sentence explaining that the 0 means nothing. The date is the subject
	  here and the team is not mentioned, because the team had nothing to do with it.
	*/
	if (result.noGames)
		return (
			<section className="card full recap">
				<header className="recap-head">
					<h2>Last night</h2>
					<span className="recap-day">{day}</span>
				</header>
				<p className="sub">
					There was no baseball on {plainDay(date)} &mdash; MLB has no box scores for that
					date at all, so there is nothing to report rather than nothing scored.
				</p>
			</section>
		)

	/** The headline is whichever of the two totals the page is entitled to state. */
	const headline = result.startedTotal ?? result.ownedTotal
	/**
	 * WHETHER THOSE SEATS WERE HIS SEATS THAT NIGHT.
	 *
	 * `lineupStore` holds one set of seats per league and stamps when they were read. If that
	 * stamp is AFTER the day being recapped — a roster pasted this morning, which is the
	 * commonest case, because the morning is when a reader opens this card — then the seats
	 * describe today's team and not last night's. Calling that total "your lineup" would be a
	 * confident claim about a lineup nobody recorded.
	 *
	 * It is still worth printing: what the lineup he has NOW would have scored on those games
	 * is exactly the question a reader asks when he is deciding whether to change it. So the
	 * number stays and the label changes, which is the whole difference between this and a
	 * guess.
	 */
	const seatsAfter = !!men.seatsAt && men.seatsAt.slice(0, 10) > date
	const played = result.men.filter(m => m.points !== null).length

	return (
		<section className="card full recap">
			<header className="recap-head">
				<h2>Last night</h2>
				<span className="recap-day">{day}</span>
			</header>

			<p className="recap-score">
				<b>{headline}</b>{" "}
				<span>
					{result.unread.length ? "from the players MLB answered for"
					: result.startedTotal === null ? "from your players"
					: seatsAfter ? "from the lineup you have now"
					: "from your lineup"}
				</span>
			</p>

			{/* STILL BEING PLAYED, said under the number rather than at the foot of the card.
			    34 hours after midnight UTC on the day in question is 10:00 UTC the next
			    morning — 6am in New York — and the latest first pitch MLB scheduled in the
			    week measured in src/data/actuals.ts was 02:10 UTC. So a reader looking at this
			    before breakfast on the East Coast is looking at a figure that can still go up,
			    and the one thing the app must not do is imply it cannot. */}
			{!final && (
				<p className="sub">
					Some of those games may not be over yet &mdash; that is what MLB had recorded
					when this page asked, and the late ones on the west coast finish after it.
				</p>
			)}

			{/* The stamp, where it lands after the games. Said once, under the figure it
			    qualifies, because a reader who has just pasted a roster is the reader most
			    likely to be looking at this card. */}
			{seatsAfter && result.startedTotal !== null && (
				<p className="sub">
					Those are the seats you gave this page on{" "}
					{plainDay(men.seatsAt!.slice(0, 10))}, which is after the games below &mdash; so
					that is what the lineup you have NOW would have scored, not what yours did.
				</p>
			)}

			{/* The second number, and it is a different claim: everybody you hold, started or
			    not. Only shown where it differs, because "your lineup scored 83.4 and your
			    players scored 83.4" is one fact printed twice. */}
			{result.startedTotal !== null && result.ownedTotal !== result.startedTotal && (
				<p className="sub">
					Everyone you hold, bench included, scored {result.ownedTotal}. {played} of{" "}
					{result.men.length} of your men played.
				</p>
			)}

			{/*
			  THE NUMBER EVERY MANAGER ALREADY KEEPS IN HIS HEAD, and no app has shown him.

			  It is labelled as hindsight in the sentence itself rather than in a footnote,
			  because it is computed from numbers that did not exist when the lineup was due
			  and the app must not imply he should have known. What makes it worth printing
			  anyway is that it is the size of the prize: over a season the gap between a
			  manager's lineup and the best one available to him is most of what separates
			  managers.
			*/}
			{result.leftOnBench !== null && result.leftOnBench > 0 && (
				<p className="recap-bench">
					<b>{result.leftOnBench}</b> points sat on your bench &mdash; knowing now what
					nobody knew then, the best lineup you could have set was worth{" "}
					{result.best.total}.
					{result.biggest && (
						/* Two sentences, because a starter who was BAD and a starter who never
						   took the field are not the same miss, and "scored 12 more than him"
						   over a man with no box score at all is a comparison with nothing. */
						<>
							{" "}
							Most of it was one seat: <b>{result.biggest.in}</b> scored{" "}
							{result.biggest.inPoints}
							{result.biggest.outPoints === null ?
								<>
									{" "}
									and <b>{result.biggest.out}</b>, who had the seat he could have filled,
									never played.
								</>
							:	<>
									{" "}
									where <b>{result.biggest.out}</b> scored {result.biggest.outPoints} in the
									seat he could have filled.
								</>
							}
						</>
					)}
				</p>
			)}
			{/* `played > 0` because "nothing sat on your bench, that was the best lineup
			    available to you" is technically true of a night nobody played and reads as
			    praise for a lineup that did not exist. The line below says what happened. */}
			{result.leftOnBench === 0 && result.played > 0 && (
				<p className="recap-bench recap-perfect">
					Nothing sat on your bench. That was the best lineup available to you.
				</p>
			)}

			{result.played === 0 && !result.unread.length && (
				<p className="sub">
					None of your men played on {plainDay(date)} &mdash; every one of their clubs was
					off or out of the day&rsquo;s record, so the {headline} above is an empty day
					rather than a bad one.
				</p>
			)}

			{/* Every refusal the arithmetic made, in the reader's words. These are the
			    sentences that keep the numbers above honest, so they are on the card rather
			    than in the fold. */}
			{result.blocked.map(b => (
				<p className="sub" key={b}>
					{b}
				</p>
			))}
			{error && <p className="sub">Part of last night is missing &mdash; {error}</p>}
			{result.unscoreable.length > 0 && (
				<p className="sub">
					MLB&rsquo;s day-by-day record does not carry{" "}
					{andList(result.unscoreable)}, so {result.unscoreable.length === 1 ? "it is" : "they are"}{" "}
					missing from every total above rather than counted as nothing.
				</p>
			)}

			{/*
			  THE WEEK, under the night, because the night is what he came for.
			  
			  One number and three qualifications, all of them in the sentence rather than in a
			  fold: which days it covers, that it counts every man he holds rather than the men
			  he started, and that it is therefore the size of his week and not the score. The
			  third is the one that matters — Yahoo pays only the men in a lineup, this browser
			  holds only today's seats, and nothing in this app can see an opponent at all.
			*/}
			{periodTotal !== null && period?.periodStart && (
				<p className="sub">
					In this {period.kind === "matchup" ? "matchup" : "scoring period"} so far (
					{plainDay(period.periodStart!)} to {plainDay(periodTo)}), every man you hold has
					scored{" "}
					<b>{periodTotal}</b> — counted for the men on your team now, whatever seat each
					was in at the time, so it is the size of your week rather than the score.
				</p>
			)}

			{/*
			  WHO MADE IT AND WHO IS EATING IT, which is the part of a week total a manager can
			  act on. One sentence, no fold, and nothing extra on the wire: it comes off the same
			  period read that produced the number above it. See `weekShape` in src/auto/recap.ts
			  for what it refuses to say and why — a best man needs three men to have played, a
			  drag has to be genuinely negative, and an absence is only reported for a hitter
			  over four days or more.
			*/}
			{periodTotal !== null && week && (week.best || week.drag || week.dead.length > 0) && (
				<p className="sub recap-week">
					{week.best && (
						<>
							<b>{week.best.name}</b> has made most of it with {week.best.points}.
						</>
					)}
					{week.drag && (
						<>
							{" "}
							<b>{week.drag.name}</b> has taken {Math.abs(week.drag.points)} back off it.
						</>
					)}
					{week.dead.length > 0 && (
						<>
							{" "}
							{andList(week.dead)} {week.dead.length === 1 ? "has" : "have"} not been in a
							box score in it at all.
						</>
					)}
				</p>
			)}

			{/*
			  THE DENOMINATOR IS THE HONEST PART.
			  
			  Most days a lineup is already the best one and the advice is "leave it alone",
			  which is worth exactly nothing — so a win rate over every recorded day would
			  flatter itself with days on which nothing was claimed. Only the days Billy asked
			  for a CHANGE are counted, and the net is allowed to come back negative.
			  
			  It also says how many days it is speaking about, because it can only speak about
			  days the app was opened: a record that did not say so would read as a record of
			  the season.
			*/}
			{record && record.changed > 0 && (
				<p className="recap-record">
					<b>{record.net > 0 ? `+${record.net}` : record.net}</b> points is what following
					Billy&rsquo;s lineup would have been worth, over the {record.changed}{" "}
					{record.changed === 1 ? "day" : "days"} he asked you to change something
					&mdash; better on {record.better}, worse on {record.worse}, level on{" "}
					{record.even}.
					{record.unchanged > 0 && (
						<>
							{" "}
							On {record.unchanged} other {record.unchanged === 1 ? "day" : "days"} he
							left your lineup alone, which is worth nothing either way and is not
							counted.
						</>
					)}
				</p>
			)}
			{/*
			  THE OTHER HALF OF THE MATCHUP, once the reader has said who it is.
			  
			  "Am I winning?" is the question a head-to-head manager asks most and the one this app
			  has never answered. The absence was correct — Yahoo stopped answering the read that
			  would have supplied it, there is no backend, and nothing here may invent a rival
			  roster — but "we cannot know" was never the only option. The app learns everything
			  else by being told, and an opponent's roster is the same gesture against a different
			  name.
			  
			  The paste lives HERE, behind a tap, on the card where the answer appears. Not on My
			  league: a reader meets this at the moment he is looking at his own week's number,
			  which is the moment the question occurs to him, and a box on another screen would be
			  a feature he has to go and find. Nothing else on any screen changes.
			  
			  IT IS NOT THE SCORE and says so in both places. Both figures count every man held,
			  because neither side's lineups are visible; the gap is therefore measured the same
			  way on both sides, which is the only kind of fairness available and is enough to
			  settle the question it is asked for — whether to chase the high-variance arm tonight.
			*/}
			{periodTotal !== null && period?.periodStart && (
				<details className="recap-all" open={rivalTotal !== null}>
					<summary>{rivalTotal === null ? "Who are you playing?" : "How the week stands"}</summary>
					{/*
					  A MAN CANNOT BE ON BOTH TEAMS, so a paste that says he is gets caught.
					  
					  The realistic mistake here is pasting your own roster page into the opponent
					  box — the two gestures are identical and the boxes are one tap apart — and
					  the result would be a gap of zero reported with total confidence. It is also
					  the only check available: nothing else about a rival roster can be validated,
					  because any twelve real men are a possible team.
					*/}
					{both.length > 0 && (
						<p className="recap-bench">
							<b>{both.length}</b> of the men you just entered are on YOUR team as well
							&mdash; {andList(both.slice(0, 3))}
							{both.length > 3 ? ` and ${both.length - 3} more` : ""}. One man cannot be
							on both sides of a matchup, so this is probably your own roster. Paste his
							and the comparison will mean something.
						</p>
					)}
					{rivalTotal !== null && both.length === 0 && (
						<p className="recap-bench">
							His men have scored <b>{rivalTotal}</b> to your {periodTotal} &mdash;{" "}
							{periodTotal === rivalTotal ?
								"level"
							: periodTotal > rivalTotal ?
								`you are ahead by ${Number((periodTotal - rivalTotal).toFixed(1))}`
							:	`you are behind by ${Number((rivalTotal - periodTotal).toFixed(1))}`}
							. Both sides count every man held, because this page can see neither
							lineup &mdash; so it is the gap, measured the same way twice, and not the
							score your league will pay.
						</p>
					)}
					<OpponentBox
						leagueKey={leagueKey}
						snapshot={snapshot}
						count={rivalKeys.length}
					/>
				</details>
			)}

			{/*
			  THE DAYS BEHIND THE NUMBER, because a record nobody can check is a boast.
			  
			  One line per day it graded: what the lineup it asked for scored, what the lineup
			  already there scored, and the difference. That is the whole of the claim made
			  visible, which is the only form in which this app is allowed to make it — and it is
			  how a reader finds the day that is carrying the total, which is usually one day.
			  
			  Behind a tap rather than on the card, because the aggregate is the answer and
			  sixty lines of working is not. Ungradeable days are not in here: they are not
			  evidence about anything, and `skipped` says how many there were and why.
			*/}
			{record && record.changed > 0 && (
				<details className="recap-all">
					<summary>Every day it is counting</summary>
					<ul className="recap-list recap-days">
						{[...record.days]
							.filter(d => d.worth !== null && !d.unchanged)
							.reverse()
							.map(d => (
								<li key={d.date}>
									<span className="recap-slot">{plainDay(d.date)}</span>
									<span className="recap-name">
										asked {d.asked}, you had {d.had}
									</span>
									<span className="recap-pts">
										{d.worth! > 0 ? `+${d.worth}` : d.worth}
									</span>
								</li>
							))}
					</ul>
					{record.skipped.length > 0 && (
						<p className="sub">
							{record.skipped.length}{" "}
							{record.skipped.length === 1 ? "other day is" : "other days are"} on record and
							not counted &mdash; {record.skipped[0]!.why}.
						</p>
					)}
				</details>
			)}

			{record && record.changed === 0 && record.days.length > 0 && (
				<p className="sub">
					{record.unchanged === record.days.length ?
						<>
							On {record.days.length === 1 ? "the one day" : `all ${record.days.length} days`}{" "}
							on record, Billy asked for the lineup you already had. Nothing to score him
							on yet.
						</>
					:	<>
							Nothing on record can be scored yet &mdash;{" "}
							{record.skipped[0]?.why ?? "last night\u2019s results aren\u2019t in"}.
						</>
					}
				</p>
			)}

			{/* Its own class, because there are three `.recap-all` folds on this card now — the
			    opponent, the days behind the record, and this — and a selector that depended on
			    which came first in the DOM is how a test ends up opening the wrong one, which is
			    exactly what happened the first run after the other two landed. */}
			<details className="recap-all recap-men">
				<summary>Every man, best night first</summary>
				<ul className="recap-list recap-each">
					{result.men.map(m => (
						<li key={m.key} className={m.started ? "recap-in" : ""}>
							<span className="recap-slot">{m.slot ?? ""}</span>
							<span className="recap-name">{m.name}</span>
							<span className="recap-pts">
								{/* A man with no line DID NOT PLAY, and that is not a zero. Jo Adell
								    went 0-for-4 on this day and is worth exactly 0.0; a man who was
								    never in the park is worth nothing at all, and printing the second
								    as the first tells a reader his shortstop had a bad night when he
								    was resting. */}
								{m.points === null ? <em>didn&rsquo;t play</em> : m.points}
							</span>
							<span className="recap-top">
								{m.top.map(c => `${c.code} ${c.points > 0 ? "+" : ""}${c.points}`).join("  ")}
							</span>
						</li>
					))}
				</ul>
			</details>
		</section>
	)
}

/**
 * The paste, and it is the same parser the reader's own team goes through.
 *
 * `rosterFromPaste` does all the work — names matched against the capture, a unique surname
 * accepted, an ambiguous one refused with the reason, a pasted page's furniture ignored — so an
 * opponent's team can be typed from memory or pasted off his roster page exactly like the
 * reader's own. Nothing here understands Yahoo's table, which is what makes it survive a
 * redesign.
 *
 * What it does NOT keep is the seats. A paste carries them and they are thrown away: nothing on
 * this card can use his lineup, so storing it would be keeping a fact to make no claim with.
 */
const OpponentBox = ({
	leagueKey,
	snapshot,
	count
}: {
	leagueKey: string | null
	snapshot: Snapshot | null
	count: number
}) => {
	const [text, setText] = useState("")
	const [note, setNote] = useState<string | null>(null)
	if (!leagueKey || !snapshot) return null
	return (
		<div className="recap-rival">
			<p className="sub">
				{count > 0 ?
					`${count} of his men are on record. Paste his team again to replace them.`
				:	"Paste his roster page, or type his players one to a line \u2014 first and last name, or a surname only one man in baseball has."}
			</p>
			<textarea
				value={text}
				onChange={e => setText(e.currentTarget.value)}
				rows={4}
				aria-label="Your opponent's team"
				placeholder={"Aaron Judge\nJuan Soto\nSkubal"}
			/>
			<p className="recap-rival-go">
				<button
					type="button"
					className="primary"
					onClick={() => {
						const got = rosterFromPaste(text, snapshot)
						/*
						 * THE NOTE IS BUILT HERE, not borrowed from the parser.
						 *
						 * `got.note` is written for the reader's OWN team and says things that are
						 * true of that and wrong of this — measured on the first paste through
						 * this box: "No seats were in that text, so tonight's lineup comes back as
						 * the lineup to SET rather than as the changes to make", a sentence about
						 * the reader's lineup printed under his opponent's roster. Nothing on this
						 * card uses his seats, so their absence is not news.
						 *
						 * What IS worth repeating is the parser's own two refusals, because they
						 * are the only reason a name he typed is missing: a line nothing matched,
						 * and a surname two men share. Both are in `unmatched`, so one clause
						 * covers them and it quotes them the way the rest of the app quotes a line.
						 */
						const missed =
							got.unmatched.length ?
								` ${got.unmatched.length} line${got.unmatched.length === 1 ? "" : "s"} matched nobody: ${got.unmatched.map(l => `\u00ab${l}\u00bb`).join(", ")}.`
							:	""
						if (!got.keys.length)
							return setNote(`Nobody in that matched a player.${missed}`)
						try {
							opponentStore.set(leagueKey, got.keys)
							setText("")
							setNote(
								`${got.players.length} of his men are on record${missed ? "." + missed : "."}`
							)
						} catch (e) {
							setNote(e instanceof Error ? e.message : String(e))
						}
					}}
				>
					That&rsquo;s his team
				</button>
				{count > 0 && (
					<button
						type="button"
						onClick={() => {
							try {
								opponentStore.clear(leagueKey)
								setNote(null)
							} catch (e) {
								setNote(e instanceof Error ? e.message : String(e))
							}
						}}
					>
						Forget him
					</button>
				)}
			</p>
			{note && <p className="sub">{note}</p>}
		</div>
	)
}
