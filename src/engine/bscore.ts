import type { League } from "../schema.ts"
import type { PlayerSeason, StatLine } from "../data/statsapi.ts"
import type { Underlying } from "../data/savant.ts"
import { matchupIndexFor, pitcherQuality, starterBlendedIndex, teamStrength } from "./matchup.ts"
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
export const slotsFor = (player: PlayerSeason, eligible?: string[]): string[] => {
	if (eligible?.length) {
		const slots = new Set<string>()
		for (const pos of eligible) {
			if (["SP", "RP", "P"].includes(pos)) {
				slots.add(pos)
				slots.add("P")
			} else if (["LF", "CF", "RF", "OF"].includes(pos)) {
				slots.add("OF")
				slots.add("Util")
			} else if (["C", "1B", "2B", "3B", "SS"].includes(pos)) {
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
	if (["LF", "CF", "RF", "OF"].includes(p)) return ["OF", "Util"]
	if (p === "DH") return ["Util"]
	if (["C", "1B", "2B", "3B", "SS"].includes(p)) return [p, "Util"]
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
	/** Points above the replacement-level player at this slot. */
	bscore: number
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
		const scheduled =
			startsUsable ? (o.probableStarts?.get(player.id) ?? (mostlyStarts ? 0 : null)) : null
		const matchupIndex = starterBlendedIndex(
			player,
			o.opponentsByTeam ? matchupIndexFor(player, o.opponentsByTeam, strength) : null,
			o.opposingStarters,
			quality,
			horizonGames
		)
		const projection = project(
			player,
			underlying,
			player.teamId ? o.teamGamesPlayed.get(player.teamId) : undefined,
			horizonGames,
			{
				recentVolumePerGame: blendWindows(
					o.recentVolumeByWindow?.[`${player.id}:${player.group}`] ?? {},
					RECENT_WINDOW_WEIGHTS[player.group]
				),
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
			unrateable:
				// injury wins: it is the more informative reason, and it is the one the
				// Stash view's own copy answers
				injury !== undefined && (o.injuryPolicy ?? "exclude") === "exclude" ?
					`${injury} — no source states a return date, so there is no honest ` +
						`projection over this horizon. The Stash view ranks him anyway.`
				: scheduled === 0 ?
					`MLB has published a starter for every game of this window and he is not ` +
						`one of them, so he is not scheduled to pitch in it.`
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
	}

	return rated.sort((a, b) => b.bscore - a.bscore)
}

/** Percentile of the regression gap within the rated pool — the undervaluation
 *  signal, expressed relative to the players actually being compared. */
/**
 * A rated player plus the comparative numbers, which need the whole pool to compute
 * and so cannot live on Rated itself.
 *
 * `uscore` — "underrated score" — is bscore per point of ownership: what he is worth
 * divided by how much of the field has already noticed. bscore answers who is best,
 * uscore answers who is best *relative to how available he is*, which on a waiver
 * wire is the question you can act on. It is `null` wherever Yahoo lists no
 * ownership figure, because unknown is not the same as unowned.
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
 * The smallest ownership a quotient can honestly divide by.
 *
 * Yahoo reports "% Ros" as a whole number, so a player shown at 0% is not owned in
 * literally no league — he is somewhere in [0, 0.5). Nearly a quarter of the priced
 * pool sits in that bucket (117 of 501 on the current capture), and dividing by a
 * literal zero would give every one of them Infinity and collapse the column into a
 * meaningless tie. Taking the bucket's midpoint is the standard continuity
 * treatment of a rounded-down reading, not a number invented to avoid a divide.
 */
const MIN_PCT = 0.5
const floorPct = (pct: number) => Math.max(pct, MIN_PCT)

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
			uscore: pct === null || !r.rateable ? null : Number((r.bscore / floorPct(pct)).toFixed(1))
		}
	})
}
