import { useMemo } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import type { League } from "../schema.ts"
import { slotsFor } from "../engine/bscore.ts"
import { recap, type RecapMan } from "../auto/recap.ts"
import { normalizeName } from "../data/names.ts"
import { andList } from "../data/names.ts"
import { roster, rosterKey } from "./roster.ts"
import { lineupStore } from "./lineup.ts"
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

	const { actuals, error, loading } = useActuals(season, date, men.men.length > 0)

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

	// Nothing to say, and saying nothing is the right answer: a reader who has not told the
	// page who his players are cannot be told what they scored, and a strip explaining that
	// would be a third empty card on a screen that already has its own setup prompt.
	if (!men.men.length || men.error) return null

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

	const day = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
		weekday: "long",
		month: "short",
		day: "numeric"
	})
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
