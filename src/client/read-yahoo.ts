import { readGrabs } from "../data/yahoo-read.ts"
import type { GrabFailure } from "../data/extension.ts"
import type { PlayerSeason } from "../data/statsapi.ts"
import type { ExtensionState } from "./extension.ts"
import { pool as poolStore } from "./pool.ts"

/**
 * READING A LEAGUE, IN ONE PLACE, because two places would drift.
 *
 * The setup sheet reads a league when a reader first connects, and the free-agent chip
 * re-reads one when the list has gone stale — same two asks, same parsers, same stores, and
 * the only difference is which screen the reader pressed. Written twice they would be two
 * slightly different answers to "what did we just read", which is how a card ends up saying
 * 231 free agents on one screen and 27 on another.
 *
 * WHAT IT WILL NOT DO. It never asks on its own. Every function here is the direct
 * consequence of a press, because a free-agent sweep is nine requests to somebody else's
 * site and a background refresh would be nine requests he did not ask for — and because a
 * list that refreshed itself would have an age nobody could account for, which is the one
 * thing this app refuses about a pool.
 */

/** How old a pool has to be before the app says anything. Not a new number: it is
 *  `STALE_WIRE_HOURS`, the line the chip has coloured itself on since long before any of
 *  this, and it is the right one — Yahoo processes waiver claims overnight, so a wire
 *  genuinely turns over about once a day. */
export const STALE_POOL_HOURS = 24

export interface PoolRead {
	added: number | null
	failure: GrabFailure | null
}

/**
 * THE FREE AGENTS, RE-READ.
 *
 * Nine requests, one position at a time, paced inside the extension. What comes back is
 * written with the same `positionsRequested` the sweep asked for, so a sweep that was
 * throttled after four positions is refused by `poolIsPartial` on exactly the rule a
 * carried file is refused by — which is what keeps "the exact list" meaning one thing
 * however it arrived.
 */
export const refreshPool = async (
	ext: ExtensionState,
	snapshot: { players: PlayerSeason[]; eligibility?: Record<string, string[]> },
	leagueKey: string,
	leagueId: string,
	sport = "baseball"
): Promise<PoolRead> => {
	const swept = await ext.ask("pool", { leagueId, sport })
	if (!swept.grabs?.length) return { added: null, failure: swept.failure ?? null }
	const got = readGrabs(swept.grabs, snapshot)
	if (!got.pool?.players.length)
		return {
			added: null,
			failure:
				swept.failure ?? {
					step: "pool",
					what: "that came back with nobody in it",
					fix: "Open your league's players page on Yahoo and try again."
				}
		}
	try {
		poolStore.set(leagueKey, {
			at: got.at ?? new Date().toISOString(),
			leagueId,
			players: got.pool.players.map(p => ({
				yahooId: p.yahooId,
				name: p.name,
				team: p.team,
				positions: p.positions
			})),
			positionsRead: got.pool.positionsRead,
			positionsRequested: got.pool.positionsRequested,
			/* The reader's own account of where this came from, in the words the chip will
			   print. "Carried in a file" and "read off your league in this browser" are
			   different claims about the same list and age differently. */
			note: "read off your league in this browser"
		})
	} catch (e) {
		return {
			added: null,
			failure: {
				step: "store",
				what: `the free agents could not be saved: ${(e as Error).message}`,
				fix: "A private window usually does this, and so does a full phone."
			}
		}
	}
	return { added: got.pool.players.length, failure: swept.failure ?? null }
}

/** Hours since an ISO instant, or null when there is nothing to measure. Shared so the
 *  chip and the sheet cannot disagree about whether a list is old. */
export const hoursSince = (at: string | null | undefined): number | null => {
	if (!at) return null
	const ms = Date.now() - Date.parse(at)
	return Number.isFinite(ms) ? ms / 3_600_000 : null
}
