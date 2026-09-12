import { useEffect, useMemo, useRef } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { slotsFor } from "../engine/bscore.ts"
import { bestNights, gradeRecord, recap, type RecapMan } from "../auto/recap.ts"
import { normalizeName } from "../data/names.ts"
import { andList } from "../data/names.ts"
import { roster, rosterKey } from "./roster.ts"
import { lineupStore } from "./lineup.ts"
import { ledgerStore } from "./ledger.ts"
import { useStored } from "./stores.ts"
import { useActuals, lastNight } from "./useActuals.ts"
import "./recap.css"

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
	const men = useMemo((): { men: RecapMan[]; error: string | null } => {
		if (!leagueKey || !snapshot) return { men: [], error: null }
		let ids: string[] = []
		try {
			ids = roster.of(leagueKey)
		} catch (e) {
			/* A store the app has declared unreadable must not be acted on silently — My
			   league owns the explaining and the repair, and this card's job is to withhold.
			   Same rule as the Tonight card's `owned` memo. */
			return { men: [], error: e instanceof Error ? e.message : String(e) }
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
			if (out.length) return { men: out, error: null }
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
		return { men: out, error: null }
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
	const { actuals, error, loading } = useActuals(season, date, !!league)

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
		  
		  Six is what fits the state the screen is actually IN when he arrives, which is at rest
		  with the dock up. The men it drops are the seventh and eighth best nights in baseball;
		  nothing downstream reads this list, so the cost is exactly two rows of interest.
		*/
		() => (actuals && league && !men.men.length ? bestNights(actuals.lines, league, 6) : null),
		[actuals, league, men]
	)

	const result = useMemo(() => {
		if (!actuals || !league || !men.men.length) return null
		return recap({
			date,
			men: men.men,
			lines: actuals.lines,
			league,
			shape: {
				slots: league.roster.slots,
				slot_order: league.roster.slot_order,
				slot_accepts: league.roster.slot_accepts
			}
		})
	}, [actuals, league, men, date])

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
			byDate: new Map([[date, actuals.lines]]),
			league
		})
	}, [leagueKey, league, actuals, date, rev])

	/* Yesterday's verdict is written down the first morning it can be, so tomorrow's record
	   needs no request for it. `settle` refuses to overwrite, which is what keeps this from
	   being a write loop — the write bumps the revision, the revision recomputes `record`,
	   and the second pass finds the day already settled. */
	const settled = useRef<string | null>(null)
	useEffect(() => {
		if (!leagueKey || !record) return
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
	}, [leagueKey, record, date])

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
							<li key={`${b.name}-${b.group}`}>
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

	/** The headline is whichever of the two totals the page is entitled to state. */
	const headline = result.startedTotal ?? result.ownedTotal
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
					{result.startedTotal !== null ? "from your lineup" : "from your players"}
				</span>
			</p>

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
						<>
							{" "}
							Most of it was one seat: <b>{result.biggest.in}</b> scored{" "}
							{result.biggest.swing} more than <b>{result.biggest.out}</b>, who had the
							seat he could have filled.
						</>
					)}
				</p>
			)}
			{result.leftOnBench === 0 && (
				<p className="recap-bench recap-perfect">
					Nothing sat on your bench. That was the best lineup available to you.
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

			<details className="recap-all">
				<summary>Every man, best night first</summary>
				<ul className="recap-list">
					{result.men.map(m => (
						<li key={m.name} className={m.started ? "recap-in" : ""}>
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
