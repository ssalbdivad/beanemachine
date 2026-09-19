import { readGrabs } from "../data/yahoo-read.ts"
import type { GrabFailure } from "../data/extension.ts"
import type { PlayerSeason } from "../data/statsapi.ts"
import type { ExtensionState } from "./extension.ts"
import { pool as poolStore } from "./pool.ts"
import { roster as rosterStore } from "./roster.ts"
import { lineupStore } from "./lineup.ts"
import { opponentStore } from "./opponent.ts"
import { taken as takenStore } from "./taken.ts"

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
	/**
	 * WHAT THE READ ITSELF HAS TO SAY, which this used to drop on the floor.
	 *
	 * `readGrabs` writes a sentence whenever a page came back as something other than what was
	 * asked for — Yahoo serving the same list for two positions is the case it was added for —
	 * and both callers here took `got.pool` and threw `got.notes` away. So the app knew exactly
	 * why a position had been refused and the only sentence that reached the reader was the
	 * downstream one saying it never came back: the wrong half of the truth, with the right
	 * half computed and discarded one function away.
	 */
	notes: string[]
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
	if (!swept.grabs?.length) return { added: null, failure: swept.failure ?? null, notes: [] }
	const got = readGrabs(swept.grabs, snapshot)
	if (!got.pool?.players.length)
		return {
			added: null,
			notes: got.notes,
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
				positions: p.positions,
				rosteredPct: p.rosteredPct,
				status: p.status
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
			notes: got.notes,
			failure: {
				step: "store",
				what: `the free agents could not be saved: ${(e as Error).message}`,
				fix: "A private window usually does this, and so does a full phone."
			}
		}
	}
	return { added: got.pool.players.length, failure: swept.failure ?? null, notes: got.notes }
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
export const knownTeamId = (leagueKey: string | null): string | null => {
	if (!leagueKey) return null
	try {
		return lineupStore.of(leagueKey)?.teamId ?? null
	} catch {
		return null
	}
}

export interface RostersRead {
	/** How many men came back taken, when the read was complete. Null on every refusal,
	 *  including a partial one — see `complete`. */
	taken: number | null
	/** How many teams answered, out of how many were asked for, so a screen can say what
	 *  happened rather than only that nothing did. */
	read: number
	asked: number
	failure: GrabFailure | null
	notes: string[]
}

/**
 * EVERY OTHER TEAM IN HIS LEAGUE, which is the only exact answer to "who can I add".
 *
 * `max_teams − 1` requests, one page at a time, paced and capped inside the extension the
 * way the sweep is. It is its own press and is deliberately NOT folded into `readLeagueHere`:
 * nine requests sit behind their own button, which is the bargain the sweep already struck
 * with the reader.
 *
 * REFUSED BEFORE IT ASKS where the league has not said how many teams it has. Without that
 * number there is no list of team ids to read and no denominator to check the answer
 * against, and a union of "as many as answered" is exactly the partial set this whole store
 * refuses to hold.
 *
 * HIS OWN TEAM IS LEFT OUT WHERE IT IS KNOWN. He is not a counterparty, and his own men
 * are already in the roster store. Where the app does not know which team is his — a
 * browser that has never read his team page, so `knownTeamId` is null — every team is read
 * instead, which is the honest fallback: his own men are genuinely taken, so a union that
 * includes them still answers "can I add him" correctly, and the alternative is refusing a
 * read over a number nobody stated.
 *
 * WRITTEN ONLY WHEN COMPLETE. A partial read reports what came back and stores nothing,
 * because the old list — however old — is a true statement about the league, and a union
 * missing one roster is a false one.
 */
export const readRostersHere = async (
	ext: ExtensionState,
	snapshot: { players: PlayerSeason[]; eligibility?: Record<string, string[]> },
	leagueKey: string,
	leagueId: string,
	teams: number | null,
	sport = "baseball"
): Promise<RostersRead> => {
	if (!teams || teams < 2)
		return {
			taken: null,
			read: 0,
			asked: 0,
			failure: {
				step: "rosters",
				what: "your league has not said how many teams it has",
				fix: "Set the number of teams on My league, then press this again."
			},
			notes: []
		}
	const mine = knownTeamId(leagueKey)
	const teamIds = Array.from({ length: teams }, (_, i) => String(i + 1)).filter(id => id !== mine)
	const answer = await ext.ask("rosters", { leagueId, sport, teamIds })
	if (!answer.grabs?.length)
		return { taken: null, read: 0, asked: teamIds.length, failure: answer.failure ?? null, notes: [] }
	const got = readGrabs(answer.grabs, snapshot)
	const rosters = got.rosters
	if (!rosters)
		return {
			taken: null,
			read: 0,
			asked: teamIds.length,
			failure: answer.failure ?? {
				step: "rosters",
				what: "none of those pages could be read as a roster",
				fix: "Open your league on Yahoo and press it again."
			},
			notes: got.notes
		}
	if (!rosters.complete)
		return {
			taken: null,
			read: rosters.teamsRead.length,
			asked: rosters.teamsAsked.length,
			failure: answer.failure ?? null,
			notes: got.notes
		}
	try {
		takenStore.set(leagueKey, {
			at: got.at ?? new Date().toISOString(),
			leagueId,
			byTeam: rosters.byTeam,
			teamsRead: rosters.teamsRead,
			teamsAsked: rosters.teamsAsked,
			/* The reader's own account of where this came from, in the words a chip will
			   print. A carried file and a read age differently and must say which they are. */
			note: "read off your league's own rosters in this browser"
		})
	} catch (e) {
		return {
			taken: null,
			read: rosters.teamsRead.length,
			asked: rosters.teamsAsked.length,
			failure: {
				step: "store",
				what: "this browser would not keep who is taken",
				fix: "Check that this site is allowed to store data, then try again.",
				detail: String(e)
			},
			notes: got.notes
		}
	}
	return {
		taken: new Set(Object.values(rosters.byTeam).flat()).size,
		read: rosters.teamsRead.length,
		asked: rosters.teamsAsked.length,
		failure: answer.failure ?? null,
		notes: got.notes
	}
}

export const readLeagueHere = async (
	ext: ExtensionState,
	snapshot: { players: PlayerSeason[]; eligibility?: Record<string, string[]> },
	leagueKey: string,
	onLeague?: (league: import("../schema.ts").League) => void
): Promise<{ said: string; read: boolean }> => {
	/*
	   THE TEAM THIS BROWSER ALREADY KNOWS IS HIS, SENT SO THE PRESS CAN ASK FOR IT.

	   A Yahoo URL names a team on exactly one page shape, and it is the team page itself. So
	   a press from the players page — where a manager spends his week — or from the league
	   home named no team, and the descriptor could not put his roster in the plan: measured
	   on all four shapes, `onePress` returned settings and matchup and never a team. The
	   board was then priced against seats nothing had ever read.

	   This id has been on the lineup store since the first read that stored seats and was
	   never sent. Undefined on a browser that has read nothing yet, which is the honest
	   absence: the press falls back to the URL, exactly as it always has.
	*/
	const mine = knownTeamId(leagueKey)
	const answer = await ext.ask("league", { teamId: mine ?? undefined })
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
		teamId: mine ?? undefined
	})
	const said: string[] = []
	if (reading.league && onLeague) {
		onLeague(reading.league)
		/* Named separately because they are two pages and two fetches: a reader whose
		   settings page landed and whose eligibility page did not has a league that scores
		   correctly and states no thresholds, and the receipt has to be able to say which. */
		said.push(
			reading.eligibility ?
				"Read your league's own scoring and eligibility"
			:	"Read your league's own scoring"
		)
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
	/** Anything the SWEEP had to say about itself — a position served as another position's
	 *  list, a page that came back empty. Carried into the receipt below rather than dropped,
	 *  which is what happened to it until 2026-09-18. */
	const sweptNotes: string[] = []
	if (id) {
		const swept = await refreshPool(ext, snapshot, leagueKey, id, reading.sport ?? "baseball")
		if (swept.added !== null) said.push(`${swept.added} free agents`)
		else if (swept.failure) said.push(swept.failure.what)
		sweptNotes.push(...swept.notes)
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
		...reading.notes,
		...sweptNotes
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
