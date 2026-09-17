import { readGrabs } from "../data/yahoo-read.ts"
import type { GrabFailure } from "../data/extension.ts"
import type { PlayerSeason } from "../data/statsapi.ts"
import type { ExtensionState } from "./extension.ts"
import { pool as poolStore } from "./pool.ts"
import { roster as rosterStore } from "./roster.ts"
import { lineupStore } from "./lineup.ts"
import { opponentStore } from "./opponent.ts"

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

/**
 * THE WHOLE LEAGUE, INTO THIS BROWSER, from wherever the reader pressed.
 *
 * The setup sheet and My league both offer this, and written twice they would be two
 * slightly different answers to "what did we just read" — which is how one screen ends up
 * saying 231 free agents and another 27. The sheet additionally creates the league when
 * there is not one yet, which is why `onLeague` is a callback rather than a store write:
 * adopting a preview as a real league is a decision that belongs to the screen that was
 * showing the preview.
 */
/**
 * The team id this browser has already seen for a league, or null the first time.
 *
 * Kept on the lineup store's own entry rather than in a store of its own: it is a fact
 * ABOUT the seats that were read, it arrived with them, and a fourth store holding one
 * string per league would be a fourth thing to clear, migrate and explain.
 */
const knownTeamId = (leagueKey: string | null): string | null => {
	if (!leagueKey) return null
	try {
		return lineupStore.of(leagueKey)?.teamId ?? null
	} catch {
		return null
	}
}

export const readLeagueHere = async (
	ext: ExtensionState,
	snapshot: { players: PlayerSeason[]; eligibility?: Record<string, string[]> },
	leagueKey: string,
	onLeague?: (league: import("../schema.ts").League) => void
): Promise<{ said: string; read: boolean }> => {
	const answer = await ext.ask("league")
	if (!answer.grabs?.length) {
		const f = answer.failure
		return { said: `${f?.what ?? "That could not be read"}${f?.fix ? ` — ${f.fix}` : ""}`, read: false }
	}
	/*
	  WHAT THIS READ IS SUPPOSED TO BE ABOUT, handed over so the parser can refuse.
	
	  The screen has an active league; the reader's browser has whatever Yahoo tab he left
	  open. When those differ every page in the grab set belongs to the open tab's league,
	  and this function writes it under the SCREEN's key — a rival league's nine men landing
	  in this league's roster store with nothing anywhere saying so. The sweep was already
	  safe, because the router refuses a tab whose league is not the one asked for; a `league`
	  press names no league at all, and this is the hole that closes it.
	
	  `teamId` is the same argument one step finer: a press from another manager's roster page
	  in the reader's own league is a page this app can parse perfectly and must not store.
	  It is only known once a first read has stored one, which is why it is optional here
	  rather than required.
	*/
	const reading = readGrabs(answer.grabs, snapshot, undefined, {
		leagueKey,
		teamId: knownTeamId(leagueKey) ?? undefined
	})
	const said: string[] = []
	if (reading.league && onLeague) {
		onLeague(reading.league)
		said.push("Read your league's own scoring")
	}
	if (reading.roster?.players.length) {
		try {
			rosterStore.set(leagueKey, reading.roster.keys)
			if (reading.roster.spots.length)
				lineupStore.set(
					leagueKey,
					reading.roster.spots,
					reading.at ?? new Date().toISOString(),
					/* Stored so the NEXT press can refuse another manager's roster page — which
					   is a page this app parses perfectly and must not write. */
					reading.teamId
				)
			said.push(`${reading.roster.players.length} men, in the seats they are in`)
		} catch (e) {
			said.push(`your team could not be saved: ${(e as Error).message}`)
		}
	}
	if (reading.opponent?.length) {
		try {
			opponentStore.set(leagueKey, reading.opponent)
			said.push(`${reading.opponent.length} on the other side of your matchup`)
		} catch {
			/* An opponent is one paste away and worth nothing if it costs the read that
			   carried it. */
		}
	}
	const id = reading.leagueId
	if (id) {
		const swept = await refreshPool(ext, snapshot, leagueKey, id, reading.sport ?? "baseball")
		if (swept.added !== null) said.push(`${swept.added} free agents`)
		else if (swept.failure) said.push(swept.failure.what)
	}
	/*
	  A READ THAT PARTLY FAILED SAYS SO, and it did not.
	
	  `answer.failure` is set whenever a page in the set could not be fetched — a settings
	  page Yahoo refused, a matchup page behind a wall — while the grabs that DID arrive come
	  back as normal. This returned only what had worked, so a reader whose scoring table
	  silently failed to arrive was told "9 men, in the seats they are in" and nothing else,
	  and would have gone on looking at a board priced in borrowed values believing it was
	  his own.
	*/
	/* THE MEN THE PARSER REFUSED, said rather than computed and dropped.
	
	   `rosterFromPaste` writes a sentence naming every line it could not match — a surname two
	   men share, a nickname, a typo — and the paste box has always shown it. This route
	   computed the same sentence and threw it away, so two men could vanish off a reader's
	   team for the rest of the season with nothing on any screen mentioning them. It is only
	   carried when it has something to say about a REFUSAL: on a clean read the parser's note
	   is a count the receipt already gives in better words. */
	const refused =
		reading.roster && (reading.roster.unmatched.length || reading.roster.ambiguous.length) ?
			reading.roster.note
		:	null
	const snags = [
		answer.failure ? `${answer.failure.what}${answer.failure.fix ? ` — ${answer.failure.fix}` : ""}` : null,
		refused,
		...reading.notes
	].filter(Boolean)
	const got = said.length ? `${said.join(", ")}.` : ""
	return {
		said: [got, ...snags].filter(Boolean).join(" ") || "Nothing new came back.",
		read: said.length > 0
	}
}

/** Hours since an ISO instant, or null when there is nothing to measure. Shared so the
 *  chip and the sheet cannot disagree about whether a list is old. */
export const hoursSince = (at: string | null | undefined): number | null => {
	if (!at) return null
	const ms = Date.now() - Date.parse(at)
	return Number.isFinite(ms) ? ms / 3_600_000 : null
}
