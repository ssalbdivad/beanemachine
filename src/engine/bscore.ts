import type { League } from "../schema.ts"
import type { PlayerSeason, StatLine } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import {
	matchupIndexFor, pitcherMatchupIndex, pitcherQuality, starterBlendedIndex, teamStrength
} from "./matchup.ts"
import { scoreStats, tableFor, type PointsResult } from "./points.ts"
import {
	blendWindows, confidenceOf, project, RECENT_BLEND_WEIGHT, RECENT_RATE_WEIGHT,
	RECENT_WINDOW_WEIGHTS, type Projection
} from "./project.ts"
import { MODEL } from "./weights.ts"


/**
 * Slots that start nobody, so they create no demand for a position and set no
 * replacement bar. One list, exported, because `src/engine/trade.ts` needs exactly
 * the same answer and the two drifted: this one omitted Yahoo's second injured slot
 * "IL+", which `src/import.ts` already marks `injured_only`, so a league carrying
 * one would have priced a spot nobody can start.
 */
export const RESERVE_SLOTS = new Set(["BN", "IL", "NA", "IL+"])

/**
 * The bscore: a player's projected points over the horizon, minus what a freely
 * available replacement at the same roster slot would produce, in THIS league's
 * scoring. Points above replacement is the honest unit — it is denominated in the
 * league's own currency, so a bscore of 40 literally means "forty more points than
 * the next man up".
 */

/**
 * Which roster slots a player can fill.
 *
 * StatsAPI reports one primary position, which was the largest known accuracy
 * gap here: a catcher who also qualifies at first base was scored only as a
 * catcher, and since a player is worth the most at his scarcest slot, that
 * understated him. `eligible` is your platform's own printed eligibility — read,
 * not inferred — and where it exists it wins. Where it does not, the primary
 * position is still all we honestly have.
 */
/** The eligibility groups, as sets rather than array literals rebuilt per player. */
const PITCHER_POS = new Set(["SP", "RP", "P"])
const OUTFIELD_POS = new Set(["LF", "CF", "RF", "OF"])
const INFIELD_POS = new Set(["C", "1B", "2B", "3B", "SS"])

export const slotsFor = (player: PlayerSeason, eligible?: string[]): string[] => {
	if (eligible?.length) {
		const slots = new Set<string>()
		for (const pos of eligible) {
			if (PITCHER_POS.has(pos)) {
				slots.add(pos)
				slots.add("P")
			} else if (OUTFIELD_POS.has(pos)) {
				slots.add("OF")
				slots.add("Util")
			} else if (INFIELD_POS.has(pos)) {
				slots.add(pos)
				slots.add("Util")
			} else if (pos === "DH" || pos === "Util") slots.add("Util")
		}
		// an unrecognised eligibility line is not a reason to claim he plays nowhere
		if (slots.size) return [...slots]
	}
	return primarySlotsFor(player)
}

const primarySlotsFor = (player: PlayerSeason): string[] => {
	const p = player.position
	if (player.group === "pitching")
		return (player.stats.gamesStarted ?? 0) > 0 ? ["SP", "P"] : ["RP", "P"]
	if (OUTFIELD_POS.has(p)) return ["OF", "Util"]
	if (p === "DH") return ["Util"]
	if (INFIELD_POS.has(p)) return [p, "Util"]
	return ["Util"]
}

export interface Rated {
	player: PlayerSeason
	underlying: Underlying | undefined
	injury: string | undefined
	slots: string[]
	projection: Projection
	projected: PointsResult
	season: PointsResult
	/** Projected points over the horizon. */
	points: number
	/** Points above the replacement-level player at this slot. Goes deeply negative,
	 *  on purpose — see `addValue` and METHODOLOGY 4.4. */
	bscore: number
	/**
	 * What ADDING this player is worth: the bscore, floored at zero.
	 *
	 * bscore is a difference of two point totals, and points are bounded below by
	 * zero while the replacement bar is not, so the range is asymmetric by
	 * construction: on the committed capture it runs [-111.06, +59.83], and the floor
	 * is exactly minus the Util bar because a man projected for 0 points is the whole
	 * bar below it. That is arithmetic, not a defect, and 89.3% of the 1,233 rateable
	 * players sit below zero.
	 *
	 * It is still the wrong number to PRINT against an add. Below the bar every
	 * candidate is the same decision — you take the free replacement instead — so the
	 * depth of the hole is not a quantity anyone can act on, and -111 next to a best
	 * available of +60 reads as a broken scale rather than as "no".
	 *
	 * Floored here rather than in each view so the board and the trade panel cannot
	 * invent two different floors. `bscore` itself is untouched: it is what every
	 * stored backtest in `data/results/` is denominated in, it is what
	 * `src/auto/plan.ts` sorts by to pick which of YOUR OWN players to drop, and
	 * flooring it there would tie 1,101 players at zero and make that choice
	 * arbitrary. Comparing two players you already own is exactly where the negative
	 * carries information.
	 */
	addValue: number
	/** The slot where the player is most valuable. */
	slot: string
	replacement: number
	confidence: { value: number; reasons: string[] }
	/** False when no projection was possible — such a player is reported, never
	 *  silently ranked at zero alongside real ones. */
	rateable: boolean
	/** est_woba − woba: positive means results trail contact quality. */
	regressionGap: number | null
	/** Starts actually scheduled in the horizon. Null when MLB has not published
	 *  them yet, which is why a null falls back to the team-games estimate. */
	scheduledStarts?: number | null
	/** Why this player carries no ranking, when he does not. Null when he is
	 *  rateable — an empty string and "no reason given" are different claims. */
	unrateable?: string | null
	/** Yahoo "% Ros" — the share of leagues this player is rostered in. Null when
	 *  the platform did not list him, which is not the same as nobody owning him. */
	rosteredPct?: number | null
}

export interface RateOptions {
	league: League
	players: PlayerSeason[]
	underlying: { hitting: Map<number, Underlying>; pitching: Map<number, Underlying> }
	injuries: Map<number, string>
	teamGamesPlayed: Map<number, number>
	gamesByTeam: Map<number, number>
	/** Who each team plays over the horizon. Absent means no matchup adjustment is
	 *  applied — the index stays null rather than being assumed neutral. */
	opponentsByTeam?: Map<number, number[]>
	/** keyed "id:group" */
	/** keyed "id:group" then window length */
	recentVolumeByWindow?: Record<string, Record<number, number>>
	/** keyed "id:group" */
	recentStats?: Record<string, StatLine>
	/** Market price by MLBAM id — how many leagues have already taken him. */
	ownership?: Map<number, number>
	/** Scheduled starts over the horizon, by MLBAM id. */
	probableStarts?: Map<number, number>
	/** For each team, the opposing starters its hitters face over the horizon. */
	opposingStarters?: Map<number, number[]>
	/** Who each announced starter is booked against — a pitcher faces only the
	 *  lineups his own turns fall on, not his club's whole week. */
	startOpponents?: Map<number, number[]>
	/** Multi-position eligibility as the platform prints it, by MLBAM id. */
	eligibility?: Map<number, string[]>
	/**
	 * Published-vs-scheduled probables per team. A scheduled-start count is only an
	 * observation where it covers the whole horizon; MLB typically publishes today
	 * and tomorrow and then stops, so a partial count read as a complete one says a
	 * starter makes ONE start in a fortnight and buries him.
	 */
	probableCoverage?: Map<number, { published: number; games: number }>
	/**
	 * What to do with a player currently on the injured list.
	 *
	 * "exclude" refuses to rank him over this horizon; "keep" ranks him anyway.
	 * The right answer depends on the horizon and nothing else: over the next week
	 * a man on the 10-day IL cannot help you, while over the rest of the season he
	 * may be the best thing on your bench.
	 */
	injuryPolicy?: "exclude" | "keep"
	/** Teams in the league — sets how deep the replacement level sits. Required:
	 *  defaulting it would silently move every replacement level and therefore
	 *  every bscore, which is exactly the kind of quiet assumption this app exists
	 *  to refuse. */
	teams: number
}

export const rateAll = (o: RateOptions): Rated[] => {
	const slotCounts = o.league.roster.slots
	/**
	 * A league that scores nothing must not produce a board of zeros.
	 *
	 * The roster templates ship a shape, not a scoring table — you supply that by
	 * importing your league or entering values. Until then every projection scores
	 * exactly 0, and a ranked list of 1,432 players all worth 0 reads as a working
	 * board rather than as an unconfigured one. That is the project's own rule
	 * broken in the most visible place: absent was being rendered as zero.
	 */
	const scores = {
		hitting: Object.values(o.league.scoring.batting).some(v => v !== 0),
		pitching: Object.values(o.league.scoring.pitching).some(v => v !== 0)
	}
	// Opponent quality is derived from the same pool being rated, so it moves with
	// whatever the board is showing and never needs a separate capture.
	const strength = teamStrength(o.players)
	// each pitcher's own wOBA allowed, so a hitter can be matched against the man on
	// the mound rather than against an average of an ace and a fifth starter
	const quality = pitcherQuality(o.players)

	const rated: Rated[] = o.players.map(player => {
		const underlying = o.underlying[player.group].get(player.id)
		const injury = o.injuries.get(player.id)
		const horizonGames = player.teamId ? (o.gamesByTeam.get(player.teamId) ?? 0) : 0
		const eligible = o.eligibility?.get(player.id)
		// only trust the count where MLB has published every game of this team's window
		const cov = player.teamId ? o.probableCoverage?.get(player.teamId) : undefined
		const startsUsable =
			o.probableStarts !== undefined && cov !== undefined && cov.games > 0 && cov.published >= cov.games
		/**
		 * Inside a COVERED window, absence is an observation rather than a gap.
		 *
		 * `startsUsable` already establishes the only condition under which that is
		 * true — every game of this team's window has a named starter — and the
		 * count was then thrown away for anyone not on the list, because `null`
		 * means "unknown" and `project` falls back to outs per team game. So a
		 * 28-start pitcher whose club has published all four of its starters, none
		 * of them him, was ranked on the streaming board for a period he provably
		 * does not pitch in.
		 *
		 * Only for a pitcher who is predominantly a starter: a covered window says
		 * nothing about when a reliever appears, so relievers and swingmen keep the
		 * fallback. The share bar is the same constant project.ts uses, so the two
		 * places that ask "are this man's appearances starts" cannot drift apart.
		 */
		const gp = player.stats.gamesPitched ?? 0
		const mostlyStarts =
			player.group === "pitching" &&
			gp > 0 &&
			(player.stats.gamesStarted ?? 0) / gp >= MODEL.probables.minStartShare

		/**
		 * Two starts in a scoring period is roughly double the innings, and it is the
		 * single largest edge in streaming — so the count has to survive a window MLB
		 * has only partly published, which is every window longer than a few days.
		 *
		 * Measured on the reference capture, from the snapshot's own horizon start:
		 * over 3 days 26 of 30 clubs have every game published, over 5 days 8, and
		 * **over 7 days none at all** — 98 of 192 games carry a named starter. The
		 * all-or-nothing gate above therefore never opened on a normal week, so the
		 * starts basis never fired there and a confirmed two-start man was projected
		 * off the same team-games average as everybody else.
		 *
		 * Opening the gate naively is what the gate was built to prevent, and that
		 * failure is on the record (METHODOLOGY 3.5): read a partial window as
		 * complete and a starter named for today carries ONE start across a fortnight
		 * while the field is projected at two or three, and he falls about 350 places.
		 *
		 * So the count is split rather than gated. What MLB has published is an
		 * observation and is used as one; the games it has not yet named are credited
		 * at this pitcher's own rate of starting, which is what the team-games
		 * fallback was silently doing for the whole window anyway:
		 *
		 *     starts = published(him) + unpublished(his club) × (his GS / his club's GP)
		 *
		 * The two ends behave correctly by construction. Fully published: the second
		 * term is zero and this reduces to exactly the previous behaviour, including a
		 * covered window meaning zero for a starter nobody named. Nothing published:
		 * the first term is zero and the second reproduces the team-games estimate. In
		 * between — the normal case — a man named twice gets at least two, and a man
		 * named once gets one plus his share of what is still unnamed.
		 */
		const published = o.probableStarts?.get(player.id) ?? 0
		const unnamed = cov ? Math.max(cov.games - cov.published, 0) : 0
		const teamGP = player.teamId ? o.teamGamesPlayed.get(player.teamId) : undefined
		/**
		 * The recency-blended playing time, hoisted because two things need it: the
		 * projection itself, and the start count below.
		 */
		const recentVolumePerGame = blendWindows(
			o.recentVolumeByWindow?.[`${player.id}:${player.group}`] ?? {},
			RECENT_WINDOW_WEIGHTS[player.group]
		)
		/**
		 * His own rate of starting, for the games MLB has NOT named yet.
		 *
		 * This was `gamesStarted ÷ his club's games played`, and that is a numerator
		 * and a denominator drawn from different populations — the shape every bug
		 * found in this codebase has had. His starts accrue only over the part of the
		 * season he was actually in a rotation; his club's games count the whole of
		 * it. So every pitcher who missed time reads as a man who rarely starts.
		 *
		 * Measured on the committed capture over the resolved scoring period, 44 of
		 * 193 predominantly-starting pitchers carried a start rate below 0.10 despite
		 * four or more starts — against the ~0.20 a five-man rotation actually runs
		 * at. Blake Snell, a full-time starter who missed most of the season, was
		 * credited with **0.11 starts and 1.7 outs** for a week in which his club had
		 * three unnamed games: half an inning, for a man who takes a turn every fifth
		 * day. Chris Bassitt read 0.40 starts across four unnamed games.
		 *
		 * The rate is therefore taken from the same recency-blended per-team-game
		 * volume the fallback itself uses, divided by his own measured outs per start
		 * — both already observed, both already trusted elsewhere in the model, and
		 * no new constant introduced:
		 *
		 *     startRate = blended outs per team game ÷ outs per start
		 *
		 * This GENERALISES the old formula rather than replacing it. Where no recent
		 * window exists the blend IS the season rate, and
		 * (outs ÷ teamGP) ÷ (outs ÷ GS) = GS ÷ teamGP exactly — verified on the
		 * capture: all 43 such pitchers reproduce the previous number to the last
		 * digit. It is also what finally makes METHODOLOGY 3.5.0's "nothing published
		 * reproduces the team-games estimate" true. The season-only version did not:
		 * it reproduced only the season half of a fallback that is 50% recent, so a
		 * starter's projection silently lost the recency blend §3.3 calls the single
		 * largest source of accuracy in the model.
		 *
		 * Like everything else built on probables this cannot be backtested (§3.5).
		 * It is reported as a correction to a wrong population, not as a measured
		 * gain: 95 of 193 start counts move, median 0.00 and mean +0.08 starts.
		 */
		const outsPerStart =
			mostlyStarts && player.stats.outs !== undefined && (player.stats.gamesStarted ?? 0) > 0 ?
				player.stats.outs / player.stats.gamesStarted!
			:	null
		const seasonOutsPerTeamGame =
			teamGP && player.stats.outs !== undefined ? player.stats.outs / teamGP : null
		const blendedOutsPerTeamGame =
			seasonOutsPerTeamGame === null ? null
			: recentVolumePerGame === null ? seasonOutsPerTeamGame
			: (1 - RECENT_BLEND_WEIGHT.pitching) * seasonOutsPerTeamGame +
				RECENT_BLEND_WEIGHT.pitching * recentVolumePerGame
		const startRate =
			outsPerStart !== null && outsPerStart > 0 && blendedOutsPerTeamGame !== null ?
				// never more turns than his club has games
				Math.min(blendedOutsPerTeamGame / outsPerStart, 1)
			:	0
		const scheduled =
			o.probableStarts === undefined || cov === undefined || cov.games === 0 ? null
			: !mostlyStarts ?
				// a published count says nothing about when a reliever next appears
				startsUsable ? (o.probableStarts?.get(player.id) ?? null) : null
			:	Number((published + unnamed * startRate).toFixed(2))
		// The club's week, which is the right question for a hitter.
		const teamIndex = o.opponentsByTeam ? matchupIndexFor(player, o.opponentsByTeam, strength) : null
		const matchupIndex =
			player.group === "pitching" ?
				// ...but a starter faces only the lineups his own turns fall on
				pitcherMatchupIndex(player, o.startOpponents, teamIndex, strength, scheduled)
			:	starterBlendedIndex(player, teamIndex, o.opposingStarters, quality, horizonGames)
		const projection = project(
			player,
			underlying,
			player.teamId ? o.teamGamesPlayed.get(player.teamId) : undefined,
			horizonGames,
			{
				recentVolumePerGame,
				recentWeight: RECENT_BLEND_WEIGHT[player.group],
				recentStats: o.recentStats?.[`${player.id}:${player.group}`] ?? null,
				recentRateWeight: RECENT_RATE_WEIGHT[player.group],
				matchupIndex,
				projectedStarts: scheduled
			}
		)
		const table = tableFor(o.league, player.group)
		return {
			player,
			underlying,
			injury,
			slots: slotsFor(player, eligible),
			projection,
			projected: scoreStats(projection.stats, table, player.group),
			season: scoreStats(player.stats, table, player.group),
			points: 0,
			bscore: 0,
			addValue: 0,
			slot: "",
			replacement: 0,
			confidence: confidenceOf(player, underlying, injury),
			/**
			 * An injured player is not projectable over a short horizon, and pretending
			 * otherwise is the most expensive mistake this board can make: he was
			 * healthy for most of the window the recent-volume blend reads, so he
			 * projects at a full-time rate and ranks among the best available while
			 * being unable to play at all. No source states a return date, so rather
			 * than invent a discount the honest answer is that he cannot be projected
			 * over this window — and that is reported, not hidden.
			 */
			rateable:
				scores[player.group] &&
				projection.projectedVolume !== null &&
				projection.projectedVolume > 0 &&
				!(injury !== undefined && (o.injuryPolicy ?? "exclude") === "exclude"),
			/**
			 * Every unrateable player owes a reason, and three of the four ways to
			 * become one gave none.
			 *
			 * The field's own contract says null means rateable. It did not hold: an
			 * unconfigured league, a missing volume line and a volume that rounds to
			 * nothing all produced `rateable: false` with `unrateable: null`, which is
			 * the "absent reported as absent" rule broken in the one place whose whole
			 * job is reporting absence. Measured on the committed capture over the
			 * resolved scoring period, 7 of 221 unrateable players carried no reason
			 * (1 of 200 over the fortnight) — men with a single plate appearance all
			 * season, whose projected volume rounds to 0.0.
			 */
			unrateable:
				// injury wins: it is the more informative reason, and it is the one the
				// Stash view's own copy answers
				injury !== undefined && (o.injuryPolicy ?? "exclude") === "exclude" ?
					`${injury} — no source states a return date, so there is no honest ` +
						`projection over this horizon. The Stash view ranks him anyway.`
				: scheduled === 0 ?
					`MLB has published a starter for every game of this window and he is not ` +
						`one of them, so he is not scheduled to pitch in it.`
				: !scores[player.group] ?
					`this league scores nothing on the ${player.group} side, so there is no ` +
						`points total to rank him by — import your league's scoring, or enter it.`
				: projection.projectedVolume === null ?
					`no projection is possible: ${projection.missing.join("; ")}.`
				: projection.projectedVolume === 0 ?
					`his projected ${player.group === "hitting" ? "plate appearances" : "outs"} ` +
						`over ${projection.horizonGames} games round to none, so there is no line ` +
						`to score.`
				:	null,
			regressionGap: underlying?.xwobaGap ?? null,
			scheduledStarts: scheduled
		}
	})

	for (const r of rated) r.points = r.projected.points

	/**
	 * Replacement level per slot: the (teams × slots)-th best projected player who
	 * is eligible there. That is literally the best player still on waivers once
	 * every team has filled the slot — so the depth follows the league's own roster
	 * configuration rather than a rule of thumb.
	 */
	const replacementBySlot = new Map<string, number>()
	for (const [slot, count] of Object.entries(slotCounts)) {
		if (RESERVE_SLOTS.has(slot)) continue
		const eligible = rated
			.filter(r => r.rateable && r.slots.includes(slot))
			.sort((a, b) => b.points - a.points)
		const depth = Math.min(o.teams * count, Math.max(eligible.length - 1, 0))
		replacementBySlot.set(slot, eligible[depth]?.points ?? 0)
	}

	for (const r of rated) {
		let best = { slot: r.slots[0] ?? "Util", value: -Infinity, replacement: 0 }
		for (const slot of r.slots) {
			const replacement = replacementBySlot.get(slot)
			if (replacement === undefined) continue
			const value = r.points - replacement
			if (value > best.value) best = { slot, value, replacement }
		}
		r.slot = best.slot
		r.replacement = Number(best.replacement.toFixed(2))
		r.bscore = Number((best.value === -Infinity ? 0 : best.value).toFixed(2))
		// the display floor, derived from the rounded bscore so the two can never
		// disagree in the last decimal place
		r.addValue = Math.max(r.bscore, 0)
	}

	return rated.sort((a, b) => b.bscore - a.bscore)
}

/** Percentile of the regression gap within the rated pool — the undervaluation
 *  signal, expressed relative to the players actually being compared. */
/**
 * A rated player plus the comparative numbers, which need the whole pool to compute
 * and so cannot live on Rated itself.
 *
 * `uscore` — "underrated score" — is what he adds times the share of leagues where
 * he is still free: value you can realistically capture, in the same points bscore
 * is in. bscore answers who is best, uscore answers who is the best you can
 * actually get. It is `null` wherever Yahoo lists no ownership figure, because
 * unknown is not the same as unowned.
 */
export type Ranked = Rated & {
	undervaluation: number | null
	rosteredPct: number | null
	marketEdge: number | null
	uscore: number | null
}

export const withUndervaluation = (
	rated: Rated[]
): (Rated & { undervaluation: number | null })[] => {
	// Percentile WITHIN a side. For a batter a positive est_woba − woba means his
	// results trail his contact; for a pitcher it means the opposite. Ranking both
	// in one pool, as an earlier version did, produced a number with no meaning.
	// The sign flip happens on the way into the pool, which is what lets one sort
	// serve both sides — the old per-row negation reversed the order it just built.
	const signed = (r: Rated) =>
		r.player.group === "hitting" ? r.regressionGap! : -r.regressionGap!
	const gapsBySide = {
		hitting: [] as number[],
		pitching: [] as number[]
	}
	for (const r of rated)
		if (r.regressionGap !== null && r.rateable) gapsBySide[r.player.group].push(signed(r))
	for (const key of ["hitting", "pitching"] as const) gapsBySide[key].sort((a, b) => a - b)

	// strictly below, so ties share a percentile exactly as the filter did
	const below = (arr: number[], x: number) => {
		let lo = 0,
			hi = arr.length
		while (lo < hi) {
			const m = (lo + hi) >> 1
			if (arr[m]! < x) lo = m + 1
			else hi = m
		}
		return lo
	}

	return rated.map(r => {
		if (r.regressionGap === null || !r.rateable) return { ...r, undervaluation: null }
		const pool = gapsBySide[r.player.group]
		return {
			...r,
			undervaluation: Number(
				((below(pool, signed(r)) / Math.max(pool.length, 1)) * 100).toFixed(1)
			)
		}
	})
}


/**
 * Market edge: how far a player's bscore sits above what the field's ownership
 * implies he is worth.
 *
 * A bare bscore ranking answers "who is best", which on a waiver wire is only
 * half the question — the best players are already taken. This answers "who is
 * the field wrong about", by comparing each player against the players the field
 * prices the same way he is priced.
 *
 * Implemented as a residual rather than as a percentile difference, so the answer
 * stays denominated in league points: an edge of +18 means eighteen points more
 * than the typical player rostered in about as many leagues. A percentile gap
 * would have made every unrostered replacement-level body look like a find.
 */
/**
 * uscore — what you can realistically ADD, in points.
 *
 * It was `bscore / owned%`, a literal quotient, and the shape was wrong in three
 * ways at once. A ratio is scale-free, so it read 1.8 where bscore reads 21 and
 * there was no way to compare the two columns. Dividing by a number in [0,100]
 * explodes at the bottom and collapses at the top, so the ranking was decided by
 * whoever happened to be barely owned rather than by who was worth having: a
 * marginal 5%-owned arm at 1.7 outranked a 21-point player at 42% ownership. And
 * three quarters of the board rounded to 0.0 or below.
 *
 * This is `addValue × (1 − owned)` instead: what he adds, times the share of
 * leagues where he is still there to be added. Same units as bscore, so the two
 * columns can be read against each other; monotone in both inputs, so being
 * better and being freer both help and neither can be gamed by a small
 * denominator; and bounded by bscore itself, so nothing can run away.
 *
 * `addValue` rather than raw bscore, because a player below the waiver bar is not
 * a negative pickup — he is simply one you do not make (METHODOLOGY 4.4). Using
 * bscore here would have produced a large NEGATIVE uscore for the least-owned
 * players, i.e. the ranking upside down.
 *
 * Measured on the reference capture: the top of the column becomes Ryan Jeffers
 * at 12.3 (21.2 points, rostered in 42%) ahead of Drew Anderson at 8.2 (8.6
 * points, rostered in 5%) — the quotient had that pair the other way round.
 */

const BUCKETS = 10

export const withMarketEdge = (
	rated: (Rated & { undervaluation: number | null })[],
	ownership: Map<number, number> | undefined
): Ranked[] => {
	const priced = rated.flatMap(r => {
		const pct = ownership?.get(r.player.id)
		return pct === undefined || !r.rateable ? [] : [{ pct, bscore: r.bscore }]
	})

	// median rather than mean: the top bucket contains superstars whose bscores are
	// long-tailed, and a mean there would set an unreachable bar for everyone in it
	const curve: { pct: number; par: number }[] = []
	if (priced.length >= BUCKETS * 4) {
		const byPct = [...priced].sort((a, b) => a.pct - b.pct)
		const size = Math.floor(byPct.length / BUCKETS)
		for (let i = 0; i < BUCKETS; i++) {
			const slice = byPct.slice(i * size, i === BUCKETS - 1 ? byPct.length : (i + 1) * size)
			if (!slice.length) continue
			const scores = slice.map(x => x.bscore).sort((a, b) => a - b)
			curve.push({
				pct: slice.reduce((a, c) => a + c.pct, 0) / slice.length,
				par: scores[Math.floor(scores.length / 2)]!
			})
		}
	}

	/** What a player rostered this widely typically produces. */
	const parAt = (pct: number): number | null => {
		if (curve.length < 2) return null
		if (pct <= curve[0]!.pct) return curve[0]!.par
		if (pct >= curve[curve.length - 1]!.pct) return curve[curve.length - 1]!.par
		for (let i = 1; i < curve.length; i++) {
			const a = curve[i - 1]!, b = curve[i]!
			if (pct <= b.pct) return a.par + ((pct - a.pct) / (b.pct - a.pct)) * (b.par - a.par)
		}
		return null
	}

	return rated.map(r => {
		const pct = ownership?.get(r.player.id) ?? null
		const par = pct === null || !r.rateable ? null : parAt(pct)
		return {
			...r,
			rosteredPct: pct,
			marketEdge: par === null ? null : Number((r.bscore - par).toFixed(1)),
			uscore:
				pct === null || !r.rateable ? null
				:	Number((r.addValue * (1 - Math.min(pct, 100) / 100)).toFixed(1))
		}
	})
}


/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Who the reader can actually ADD, without a server.
 *
 * The board's whole streaming answer was unreachable on beanemachine.com. "Free
 * agents only" reads the league's live free-agent list through the local API, and
 * the hosted page has no API — so the control was permanently disabled there and
 * the streaming list opened, measured on the live capture of 2026-09-04, with
 * Tyler Glasnow (94% rostered), Blake Snell, Chris Sale (99%) and Drew Rasmussen
 * (95%). To stream a starter is to pick one up. Four men nobody can pick up is not
 * an answer to that question.
 *
 * The snapshot already carries Yahoo's "% Ros" for everyone Yahoo listed, so the
 * estimate below needs nothing the hosted page does not already have.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * How many players this league can hold at once: every seat on every roster.
 *
 * Deliberately NOT `RESERVE_SLOTS`-filtered, which is the mistake waiting to be
 * made here. That set exists because a bench seat starts nobody and therefore sets
 * no replacement bar — a question about VALUE. This is a question about SUPPLY, and
 * a player on somebody's bench is every bit as unavailable as one in his lineup. An
 * IL seat counts for the same reason and for one more: the ownership column being
 * ranked below prices injured stars too, so dropping IL seats from the count while
 * leaving injured players in the ranking would be a numerator and a denominator
 * drawn from different populations, which is the shape of every bug this codebase
 * has found in itself.
 *
 * League 228947: 10 teams x 27 seats (18 active, 5 bench, 4 IL) = 270 players.
 */
export const rosterableDepth = (league: League): number | null => {
	const teams = league.meta.max_teams
	if (teams == null) return null
	const seats = Object.values(league.roster.slots).reduce((a, b) => a + b, 0)
	return seats > 0 ? teams * seats : null
}

/**
 * The ownership percentage that separates "probably taken" from "probably free" —
 * calibrated to this league's own size rather than to a threshold somebody picked.
 *
 * Rank everyone Yahoo priced by how widely he is rostered and count down to the
 * (teams x seats)-th name. That player is, by construction, the last one the league
 * has room for; the field agrees he is roughly the most-owned player still gettable.
 * A 12-team league reaches further down that list than a 10-team one and gets a
 * lower cut out of the same data, which is the point — `WIDELY_ROSTERED = 70` in
 * Board.tsx was one number standing in for every league in the world.
 *
 * The comparison is STRICTLY above the cut, so a tie at the boundary falls on the
 * available side. That is the deliberate direction: showing a man who turns out to
 * be taken costs the reader a click on Yahoo, hiding one who was free costs him the
 * pickup.
 */
export interface OwnershipCut {
	/** Whether this capture's ownership can support the estimate at all. */
	usable: boolean
	/** The boundary percentage. Meaningless when `usable` is false. */
	cut: number
	/** teams x seats — how many players the league can hold. */
	depth: number
	/** Seats on ONE roster, which is the bar the tie test below is measured against. */
	seats: number
	/** How many players this capture priced at all. */
	priced: number
	/** How many of them sit on exactly the cut, unable to be ordered against it. */
	tied: number
	/** One sentence naming what the estimate is, or why there isn't one. */
	basis: string
}

export const ownershipCut = (
	league: League,
	ownership: Map<number, number> | undefined
): OwnershipCut | null => {
	const depth = rosterableDepth(league)
	const teams = league.meta.max_teams
	if (depth === null || teams == null) return null
	const seats = depth / teams
	const values = [...(ownership?.values() ?? [])].sort((a, b) => b - a)
	const priced = values.length
	const nothing = (basis: string): OwnershipCut => ({
		usable: false, cut: 0, depth, seats, priced, tied: 0, basis
	})
	/**
	 * A capture that priced fewer players than the league has seats cannot locate
	 * the boundary at all — the cut would fall off the end of the list and every
	 * unpriced player, which is most of baseball, would be called free on no
	 * evidence.
	 */
	if (priced < depth)
		return nothing(
			`this capture carries a rostered share for only ${priced} players, fewer than the ` +
				`${depth} a ${teams}-team league with ${seats} seats can hold, so there is no ` +
				`point in the list where the league runs out of room`
		)
	const cut = values[depth - 1]!
	const tied = values.filter(v => v === cut).length
	/**
	 * The gate, and it is not decoration: it is what stops this estimate repeating
	 * the failure it exists to fix.
	 *
	 * Yahoo's "% Ros" is swept off player pages whose tooltip also carries a
	 * per-game weather line, and a sweep that reads the wrong cell puts a whole
	 * club on one identical percentage. `leakedByTeam` in data/yahoo-pool.ts
	 * discards those at capture time, but the snapshot committed at 2026-09-02
	 * predates it, and on that capture 225 of 848 priced players sit at exactly
	 * 51% — 83% of the 270-deep boundary is a single tie the column cannot order.
	 * Ranking by it there produced a "who you can get" list headed by Zack Wheeler,
	 * Jacob deGrom and Logan Gilbert: the same unreachable aces, differently
	 * spelled.
	 *
	 * So the tie at the cut must be smaller than ONE roster. Past that the estimate
	 * cannot even say which team's worth of players the boundary falls in, and a
	 * boundary that cannot be located to within a single roster is not a boundary.
	 * The bar is the league's own seat count, not a constant.
	 *
	 * Measured, both captures, 10 teams x 27 seats, depth 270:
	 *   2026-09-02 (committed, leaked)  cut 51%, 225 tied — 8.3x one roster, refused
	 *   2026-09-04 (live, deleaked)     cut 35%,   4 tied — 0.15x one roster, used
	 */
	if (tied > seats)
		return nothing(
			`${tied} players in this capture are rostered in exactly ${cut}% of leagues, which ` +
				`is more than the ${seats} seats on one roster — the boundary between taken and ` +
				`free lands inside a tie this column cannot order, so it is not read`
		)
	return {
		usable: true,
		cut,
		depth,
		seats,
		priced,
		tied,
		basis:
			`estimated: a ${teams}-team league with ${seats} seats holds ${depth} players, and the ` +
			`${depth}th most widely rostered player in this capture is rostered in ${cut}% of ` +
			`leagues — so above ${cut}% is treated as taken`
	}
}

/**
 * Is this player likely to be sitting on the wire in a league of this size?
 *
 * An UNLISTED player counts as available, and that is a decision rather than an
 * oversight, so here is the argument and the measurement behind it.
 *
 * Yahoo's sweep walks 8 pages of 25 across 9 positions — about 200 deep per
 * position, ordered by ownership. A player it never reached is therefore below
 * roughly the 200th-most-owned man at his position, which is far below a
 * 270-player boundary. Measured on the live 2026-09-04 capture: 0 of the top 270
 * players by season points are unlisted, the listed pool's median season total is
 * 337 points against the unlisted pool's 36, and the single best unlisted player
 * scored 386 where the best listed one scored 1,531. Deep unlisted arms are exactly
 * who a streamer picks up, and dropping them would cut 19 of the 106 pitchers with
 * a start in the window — so they are shown.
 *
 * The rule is only safe because `ownershipCut` refuses first. On the thin, leaked
 * 2026-09-02 capture the same measurement reads 67 of the top 270 unlisted —
 * Ohtani, Harper, Schwarber, Alonso — and calling those free would be the original
 * complaint with worse manners. The gate catches that capture before this function
 * is ever consulted.
 *
 * A single hole in an otherwise clean read is caught by the VALUE test instead.
 * Blake Snell and Garrett Crochet are both unlisted on the 2026-09-04 capture and
 * both rostered everywhere; Snell came out top of the gettable list. The reasoning
 * that makes unlisted mean gettable is precisely what rules them out: the sweep is
 * ordered by Yahoo's own rank and reaches ~200 deep per position, so a player good
 * enough to sit inside a league's rostered depth CANNOT also be too obscure for the
 * sweep to have reached. If he is both, the read has a hole and the honest answer
 * about him is that we do not know — not that he is free.
 *
 * So an unlisted player counts as gettable only while his own projection puts him
 * outside the rostered depth. No new constant: it is the same `teams x seats`
 * boundary the ownership cut uses, applied to the ranking instead of to ownership.
 * A listed player is unaffected — his percentage is a real read and answers for
 * itself.
 */
export const likelyAvailable = (
	rosteredPct: number | null,
	cut: OwnershipCut,
	/** Where this player sits in the value ranking, and how deep the league rosters.
	 *  Omitted keeps the old behaviour, which is correct wherever the caller has no
	 *  ranking to hand — a name search, a single row. */
	value?: { rank: number; depth: number }
): boolean =>
	rosteredPct === null ?
		// unlisted: gettable only if he is not also good enough to be rostered
		value === undefined || value.rank >= value.depth
	:	rosteredPct <= cut.cut
