import { type } from "arktype"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Snapshot } from "../data/snapshot.ts"
import { resolvePeriod } from "../engine/period.ts"
import { localDate } from "../data/today.ts"
import type { Config, League, ScoringPeriod } from "../schema.ts"
import { League as LeagueSchema } from "../schema.ts"
import { api, ApiError, detectMode, getMode } from "./api.ts"
import { Billy } from "./Billy.tsx"
import { Board } from "./Board.tsx"
import { Trade } from "./Trade.tsx"
import { Decide } from "./Decide.tsx"
import { Recap } from "./Recap.tsx"
import { Onboard } from "./Onboard.tsx"
import { Dock } from "./Dock.tsx"
import { leagues } from "./leagues.ts"
import { roster } from "./roster.ts"
import { lineupStore } from "./lineup.ts"
import { slotsFor } from "../engine/bscore.ts"
import { stored, useStored } from "./stores.ts"
import { useExtension } from "./extension.ts"
import { refreshPool } from "./read-yahoo.ts"
import { useMatchup } from "./useMatchup.ts"
import { pool as poolStore, since, type StoredPool } from "./pool.ts"
import {
	EligibilityPanel,
	Fragment2,
	freshness,
	purpose,
	VIEW_HASH,
	viewFromHash,
	isPreset,
	leagueReady,
	PresetNote,
	RosterPanel,
	Setup,
	StatTable,
	TeamCountInput,
	type View,
	VIEWS,
} from "./panels.tsx"
import { useSnapshot } from "./useBoard.ts"
import { useToast } from "./useToast.tsx"

/**
 * What "Start a league from" offers, read from `platform_templates` rather than
 * listed here.
 *
 * It used to be the literal list `["custom", "yahoo", "espn", "sleeper"]`, which
 * was wrong in two directions at once. Sleeper runs no fantasy baseball — src/import.ts
 * refuses a Sleeper URL and cites the check, `/v1/state/mlb` naming no season — so a
 * baseball app was offering a Sleeper league type;
 * and all four templates shipped with 0 stats, 0 slots and no team count, so every
 * option created a league that could rank nothing. scoring.json now ships the two
 * that are true (a Yahoo Head-to-Head Points preset, and a blank one), and this
 * list follows it: removing a template from the data removes it from the picker,
 * with no second list to remember.
 */
interface TemplateOption {
	key: string
	label: string
	/** Whether it arrives with values, which decides where you land after New. */
	filled: boolean
}

const templateOptions = (config: Config | null): TemplateOption[] =>
	Object.entries(config?.platform_templates ?? {}).map(([key, raw]) => {
		const tpl = raw as League | undefined
		const platform = tpl?.meta?.platform ?? key
		const stats =
			Object.keys(tpl?.scoring?.batting ?? {}).length +
			Object.keys(tpl?.scoring?.pitching ?? {}).length
		const name = platform === "custom" ? "" : `${platform[0]!.toUpperCase()}${platform.slice(1)} `
		return {
			key,
			filled: stats > 0,
			// The label states what you get, from the template's own fields: a scoring
			// type it names, or the fact that it names nothing at all.
			label:
				stats > 0 ?
					`a ${name}${tpl?.meta?.scoring_type ?? ""} league (borrowed values)`.replace(/\s+/g, " ")
				:	`a blank ${name}league (nothing filled in)`
		}
	})

/** What is known about the leagues in this browser. Three states, because an
 *  unreadable store and an empty one call for opposite advice. */
type StoreState = "reading" | "read" | "unreadable"

/*
  League management, under the answer rather than over it.

  A rule above it and a quiet label, because these six controls — New, Remove, Download, Load
  file, a template picker and a URL field — are a once-a-season act that used to sit above the
  reader's own team on the one screen he opens to fix his scoring. The rule is what says "the
  screen ends here"; the label is set like the page's other section labels rather than like a
  heading, because it is a signpost and not a part of the argument.
*/
const ADMIN_CSS = `
.bar-admin{margin:var(--sp-5,24px) 0 0;border-top:1px solid var(--line);padding-top:var(--sp-3)}
.bar-admin-head{
  margin:0 0 var(--sp-2);font-family:var(--mono);font-size:var(--fs-2);font-weight:500;
  letter-spacing:.06em;text-transform:uppercase;color:var(--muted);
}
`

/** The league picker is one control doing four jobs, so it says which one. */
const LEAGUE_LABEL: Record<View, string> = {
	board: "Deciding for",
	wire: "Scoring these picks against",
	trade: "League and team"
}

export const App = () => {
	const [config, setConfig] = useState<Config | null>(null)
	const [key, setKey] = useState<string | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	// Billy's lenses light for a moment when a save lands
	const [acknowledged, setAcknowledged] = useState(false)
	/**
	 * WHICH SCREEN, AND IT IS IN THE ADDRESS NOW.
	 *
	 * The URL never changed. It was the same string on Tonight, on Pickups and on My league,
	 * which cost three things a reader notices: nothing was bookmarkable, nothing was
	 * shareable, and a reload always returned to Tonight whatever he had been reading. The
	 * last is the one that stings — a phone reloads a backgrounded tab on its own.
	 *
	 * A hash rather than a path, because this is a static site served from one file and a path
	 * would 404 on a refresh unless the host rewrites. Read once here so the first paint is
	 * already the right screen and no effect has to correct it.
	 */
	const [view, setView] = useState<View>(() => {
		try {
			return viewFromHash(window.location.hash) ?? "board"
		} catch {
			return "board"
		}
	})
	/**
	 * Whether the first-run setup is on screen.
	 *
	 * It opens by itself when this browser holds no league, which is now every first
	 * visit: the site used to seed one — a real Yahoo league belonging to a real
	 * person — so a stranger's first screen was a ranked board denominated in
	 * somebody else's points, under a notice explaining that it was. It closes when
	 * the reader says so, and it can be reopened, because "I set the league up and
	 * now I want to add my roster" is a thing people come back for.
	 */
	const [onboarding, setOnboarding] = useState(false)
	/**
	 * Whether the setup sheet is OPEN, which is not the same as whether it exists.
	 *
	 * `onboarding` says the reader has no league, or has asked for the setup back —
	 * that is when the bar is on the page at all. This says whether the sheet above it
	 * is showing. They are separate on purpose: a first visit has the bar and a closed
	 * sheet, so the ranking is the first thing on the page; pressing "Set up a league"
	 * from the toolbar opens the sheet immediately, because that reader asked for it.
	 */
	const [setupOpen, setSetupOpen] = useState(false)
	/**
	 * BACK GOES BACK, and this is the shape that works.
	 *
	 * The defect was measured and is the oldest entry in docs/FINDINGS.md: nothing in this
	 * app pushed a history entry, so Back left the site from anywhere. With the setup sheet
	 * open and eighteen lines typed, it went to about:blank; after Tonight → Pickups it did
	 * not return to Tonight, it exited. On a phone Back is how people dismiss a keyboard and
	 * undo a tap — the most-pressed control on the device — and every press of it was a
	 * reader leaving.
	 *
	 * THE SHAPE THAT DOES NOT WORK is recorded in src/client/Dock.tsx and was tried first: an
	 * effect keyed on `open` that pushes on open and pops in its cleanup. It passes against
	 * the production build and fails against the dev server, because StrictMode
	 * double-invokes effects — setup, cleanup, setup — and a cleanup that calls
	 * `history.back()` fires `popstate` and closes the sheet the moment it opens. An effect
	 * whose teardown navigates cannot be idempotent, and idempotent is what React requires.
	 *
	 * So the push happens in the GESTURE, which React does not double-invoke, and the
	 * listener is permanently mounted and only ever RESTORES. Nothing in the listener
	 * navigates, so there is no path by which it can feed itself.
	 *
	 * Two things share the mechanism because they are the same question to a reader — "undo
	 * the last thing I did": which screen he is on, and whether the setup sheet is up. Both
	 * live in one entry, so Back from Pickups-with-the-sheet-open takes the sheet down first
	 * and the tab second, in the order he did them.
	 *
	 * The FIRST entry gets `replaceState` rather than a push, so every entry in the stack has
	 * our state on it and the listener never has to guess what the initial screen was.
	 * `replaceState` twice is the same as once, which is what makes that effect safe under
	 * StrictMode where `back()` was not.
	 */
	const go = useCallback(
		(next: { view?: View; sheet?: boolean }) => {
			const toView = next.view ?? view
			const toSheet = next.sheet ?? setupOpen
			/* No entry for a step that changes nothing, or Back would need N presses to
			   undo one visible thing — which is the failure a reader reads as a broken
			   button rather than as a tidy stack. */
			if (toView === view && toSheet === setupOpen) return
			/*
			 * CLOSING THE SHEET POPS RATHER THAN PUSHING, and the alternative was measured
			 * wrong on the dev server: pressing Escape pushed a second entry whose only
			 * difference was the sheet being down, so Back REOPENED the sheet. Closing a thing
			 * is the undo of opening it, and Back after it should land where the reader was
			 * before he opened it, not back inside it.
			 *
			 * `depth` is what makes this safe. The entry written on mount carries 0 and every
			 * push carries one more, so "are we standing on an entry this app pushed" is a
			 * question with an answer — and the one case where `history.back()` would leave the
			 * site, a sheet that was open on the very first entry, is the case this refuses.
			 * Without the counter the guard would have been `state.bm.sheet === true`, which
			 * cannot tell a pushed entry from the initial one.
			 */
			const at = (history.state as { bm?: { depth?: number } } | null)?.bm
			const depth = at?.depth ?? 0
			if (next.sheet === false && setupOpen && next.view === undefined && depth > 0) {
				/* `back()` called from a GESTURE, never from an effect's cleanup. That is the
				   whole difference from the shape documented as broken in src/client/Dock.tsx:
				   React does not double-invoke an event handler, so this cannot fire twice. The
				   state change comes back through `popstate`, which is the one place it is set. */
				try {
					history.back()
					return
				} catch {
					/* fall through to the push below */
				}
			}
			if (next.view !== undefined) setView(next.view)
			if (next.sheet !== undefined) setSetupOpen(next.sheet)
			try {
				/* The URL carries the SCREEN and not the sheet. A sheet is a thing a reader
				   opened over the page he is on, not a place — sharing "the setup sheet on
				   Pickups" is not a thing anybody wants to send, and a reload landing with it
				   open would be the page deciding what he is doing. So the hash names the
				   screen, and the history entry carries both. */
				history.pushState(
					{ bm: { view: toView, sheet: toSheet, depth: depth + 1 } },
					"",
					`#${VIEW_HASH[toView]}`
				)
			} catch {
				// A browser that refuses pushState still gets a working app; it just gets the
				// old Back behaviour, which is the one this is improving and not relying on.
			}
		},
		[view, setupOpen]
	)

	useEffect(() => {
		try {
			if (!(history.state as { bm?: unknown } | null)?.bm)
				history.replaceState(
					{ ...(history.state as object | null), bm: { view, sheet: setupOpen, depth: 0 } },
					"",
					`#${VIEW_HASH[view]}`
				)
		} catch {
			/* see `go` */
		}
		const onPop = (e: PopStateEvent) => {
			const at = (e.state as { bm?: { view: View; sheet: boolean; depth?: number } } | null)?.bm
			/* An entry that is not ours is somebody else's page in this tab's history, and
			   restoring nothing is the correct response: the browser is already navigating
			   away and touching state here would fight it. */
			if (!at) return
			setView(at.view)
			setSetupOpen(at.sheet)
		}
		/* A hash EDITED in the address bar fires `hashchange` and not `popstate`, and a link
		   pasted into the same tab is exactly that. Nothing here pushes, so the two listeners
		   cannot feed each other. */
		const onHash = () => {
			const at = viewFromHash(window.location.hash)
			if (at) setView(at)
		}
		window.addEventListener("popstate", onPop)
		window.addEventListener("hashchange", onHash)
		return () => {
			window.removeEventListener("popstate", onPop)
			window.removeEventListener("hashchange", onHash)
		}
		/* Mounted once and never re-bound. The handler reads only the event, so it needs no
		   dependency on `view` or `setupOpen` — and a listener re-bound on every state change
		   is a listener that can be mid-swap when a gesture fires. */
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	/** True while a file is over the window. A drop target nobody can see is a
	 *  feature nobody uses, so the page says it will take the file. */
	const [dragging, setDragging] = useState(false)
	/** Set by the toolbar so the Setup card can open the same picker: one file
	 *  input, three ways to reach it. Stable, so the toolbar's effect that hands it
	 *  up does not re-run on every render. */
	const openPicker = useRef<(() => void) | null>(null)
	const registerPicker = useCallback((open: () => void) => {
		openPicker.current = open
	}, [])
	const { snapshot, error: snapshotError } = useSnapshot()
	const { toast, show } = useToast()
	/**
	 * The exact free-agent list this browser is carrying for the active league, if
	 * any. Read here rather than in `Status` so it is one localStorage hit per
	 * config change instead of one per render, and recomputed when `config` moves
	 * because that is what a dropped file changes.
	 */
	/** Any write to this browser — a pasted free-agent list included — makes the
	 *  masthead and the board re-read. See src/client/stores.ts. */
	const rev = useStored()
	/** The browser reader, when there is one. See src/client/extension.ts — this is the
	 *  only place the whole app asks whether Yahoo can be read from here. */
	const ext = useExtension()
	const wire = useMemo(() => (key ? poolStore.of(key) : null), [key, config, rev])
	/**
	 * Remounts the two views that ask for a free-agent list when the list changes
	 * under them.
	 *
	 * Board and Trade each fetch availability once, in an effect keyed on the league
	 * id — which is right, because that is what the request depends on. Loading a
	 * file does not change the league id: the commonest case by far is re-reading
	 * the league you already have, so the id is identical and the effect never
	 * re-runs. Measured on the static build before this existed: dropping a file
	 * carrying 150 free agents left the board still saying "can't tell", because the
	 * one fetch it was ever going to make had already been refused, seconds earlier,
	 * on a page that had no pool yet.
	 *
	 * A remount is the honest fix from outside those components. It is keyed on the
	 * READ TIME rather than on the league, so it changes exactly when a genuinely
	 * different list arrives and never on an ordinary re-render — and a browser
	 * carrying no pool holds one constant key, so this cannot churn the board for
	 * the visitors who never load a file at all.
	 */
	const wireKey = wire?.at ?? "no-carried-pool"
	const acknowledge = useCallback(() => {
		setAcknowledged(true)
		setTimeout(() => setAcknowledged(false), 900)
	}, [])

	const run = useCallback(
		async (fn: () => Promise<void>) => {
			setBusy(true)
			try {
				await fn()
			} catch (e) {
				show(e instanceof ApiError ? e.message : String(e), true)
			} finally {
				setBusy(false)
			}
		},
		[show]
	)

	const adopt = useCallback((next: Config, preferred?: string) => {
		const keys = Object.keys(next.leagues)
		const chosen =
			preferred && keys.includes(preferred) ? preferred
			: next.active_league && keys.includes(next.active_league) ? next.active_league
			: keys[0] ?? null
		setConfig(next)
		setKey(chosen)
		setLoadError(null)
		/*
		 * WHERE A FIRST VISIT LANDS, and it has moved twice for the same reason.
		 *
		 * It opened on the SETUP once, on the reasoning that a bscore is denominated in a
		 * league's own points and there is no honest board without one. Both halves are
		 * true and the conclusion was wrong: a stranger cannot tell whether this is worth
		 * two minutes until he has seen what it produces, and "fill in seventeen point
		 * values and then I will show you" is the ask that loses him. So it moved to the
		 * ranked board, which at least produces something.
		 *
		 * Walking that as a stranger at 390x844 said the board was the wrong something.
		 * Measured on the published build with an empty profile: 489 vertical pixels of
		 * filters before any content and ZERO ranked rows on the first screen — the first
		 * one sits at document y932 on an 844px phone. The first name he does reach is a
		 * White Sox rookie reliever with a 32px number beside it, and the top five are
		 * three White Sox and two men from the two worst teams in baseball. None of that
		 * is a bug: a free-agent board ranked by value over replacement SHOULD be full of
		 * men nobody has rostered. It is simply the worst available answer to "what is
		 * this?" — and the sentence that explains whose scoring it is was measured
		 * OCCLUDED behind the setup dock at first paint.
		 *
		 * Tonight is the better answer to the same argument, and only became so once
		 * src/client/Recap.tsx existed. That screen now opens with what the best nights in
		 * baseball were actually worth last night, priced in a real scoring table —
		 * facts, not estimates, about players everybody has heard of, needing nothing from
		 * the reader — above the app's clearest sentence about what it does, with one tap
		 * through to the board for anyone who wants the thousand rows. The tab is also the
		 * one the title names and the question a manager actually arrives with.
		 *
		 * Set here rather than in an effect so it is true on the first paint and never
		 * flashes the wrong screen.
		 */
		if (!keys.length) {
			setOnboarding(true)
			/*
			 * UNLESS HE ASKED FOR A SCREEN, in which case he gets the one he asked for.
			 *
			 * This line was unconditional, and it is the only thing in the app that can
			 * overrule the address bar. It does not bite on the dev server — a dev read
			 * supplies a league, so `keys.length` is not zero there — and on the PUBLISHED
			 * build, where a first visit really does hold no league, every deep link landed on
			 * Tonight with the bar still reading `#pickups`. Measured on the 4173 preview
			 * against an empty profile: `#pickups`, `#my-league` and `#tonight` all selected
			 * Tonight, which makes a shared link a lie three times out of three and is exactly
			 * the state hash routing was added to end.
			 *
			 * `view` was already initialised from the hash above, so a link that names a screen
			 * needs nothing done to it — what it needs is for this not to happen.
			 */
			if (!viewFromHash(window.location.hash)) setView("board")
		}
	}, [])

	useEffect(() => {
		void run(async () => {
			try {
				const [, stored] = await Promise.all([detectMode(), leagues.load()])
				adopt(stored)
			} catch (e) {
				// a toast fades, and with no config the page would sit on "Loading…" forever
				setLoadError(e instanceof ApiError ? e.message : String(e))
				throw e
			}
		})
	}, [run, adopt])

	/**
	 * Loading a league file, from wherever it arrived.
	 *
	 * One function, because there are now three doors onto it — the toolbar button,
	 * the Setup card, and dropping the file on the page — and three copies of a
	 * confirm-then-replace would be three chances for one of them to skip the
	 * confirm. The file replaces the store outright (see leagues.replace), so what
	 * is about to go is named before it goes.
	 */
	const loadFile = useCallback(
		(file: File) => {
			if (!/\.json$/i.test(file.name) && file.type !== "application/json")
				return show(`${file.name} isn't a .json league file.`, true)
			void run(async () => {
				/**
				 * Name what is ARRIVING, not only what is going.
				 *
				 * This asked "Replace the 1 league in this browser with scoring.json?" — a
				 * warning about loss, raised at the exact moment a Yahoo user is doing the
				 * one thing the app told him to do: read his league locally and drop the
				 * file here. It fires for everybody, because the example league is always
				 * there to be replaced, so it is the last thing between every Yahoo user
				 * and a working board. Saying what he is about to GET is the difference
				 * between a warning and a confirmation.
				 *
				 * The file is read before the prompt rather than after, which costs nothing
				 * on a local file and is what makes the prompt able to describe it. A file
				 * that will not parse says so instead of asking a question about it.
				 */
				const text = await file.text()
				const existing = Object.keys(config?.leagues ?? {}).length
				let incoming = ""
				try {
					const parsed = JSON.parse(text) as {
						leagues?: Record<string, unknown>
						pools?: Record<string, unknown>
						rosters?: Record<string, unknown>
					}
					/* The league's own NAME, not the key it is filed under. `Object.keys` gave
					   "yahoo:228947", so the dialog asked "Load yahoo:228947 (with your roster)
					   from downloaded.json?" — an identifier this app made up, in the one
					   sentence standing between a reader and replacing everything he has. */
					const named = Object.values(parsed.leagues ?? {}).map(
						l => (l as { meta?: { league_name?: string } })?.meta?.league_name
					)
					const names = Object.keys(parsed.leagues ?? {}).map(
						(k, i) => named[i] ?? k
					)
					const extras = [
						Object.keys(parsed.pools ?? {}).length ? "its free-agent list" : "",
						Object.keys(parsed.rosters ?? {}).length ? "your roster" : ""
					].filter(Boolean)
					incoming =
						names.length === 1 ?
							`${names[0]}${extras.length ? ` (with ${extras.join(" and ")})` : ""}`
						: names.length ? `${names.length} leagues`
						: ""
				} catch {
					throw new ApiError(`${file.name} could not be read, so nothing was replaced.`)
				}
				if (
					existing &&
					!confirm(
						incoming ?
							`Load ${incoming} from ${file.name}?\n\nThis replaces the ` +
								`${existing} league${existing === 1 ? "" : "s"} already in this browser.`
						:	`Replace the ${existing} league${existing === 1 ? "" : "s"} in this browser with ${file.name}?`
					)
				)
					return
				const loaded = leagues.replace(text)
				adopt(loaded.config)
				// A file is a finished setup: it carries the league, and usually the roster
				// and the free-agent list too. Leaving the first-run card up over a board
				// that is already ranked would be asking for what has just arrived.
				setOnboarding(false)
				// what actually arrived, counted from the file rather than assumed: a
				// file with no roster in it must not be reported as having brought one
				const carried = [
					`${loaded.leagues} league${loaded.leagues === 1 ? "" : "s"}`,
					loaded.rosters ? `${loaded.rosters} roster${loaded.rosters === 1 ? "" : "s"}` : null,
					loaded.lineups ? `${loaded.lineups} lineup${loaded.lineups === 1 ? "" : "s"}` : null,
					// Named separately from the leagues because it is the one thing in the
					// file this page could not otherwise get at all, and because its absence
					// has to be visible: a file with no pool leaves the board estimating.
					loaded.pools ?
						`${loaded.pools} free-agent list${loaded.pools === 1 ? "" : "s"}`
					:	null
				].filter(Boolean)
				show(`Loaded ${carried.join(", ")} from ${file.name}`)
			})
		},
		[config, run, adopt, show]
	)

	/**
	 * Starting a league from a template.
	 *
	 * Two things changed here and both were in the way of a first-time visitor. The
	 * key used to come from a `prompt()`, a modal asking for a string that is only
	 * ever seen again in this dropdown — so it is derived now (leagues.suggestKey).
	 * And every template used to be blank, so this always landed on League setup
	 * with a form to fill in; a preset arrives ready to rank, so it lands on the
	 * board, which is the thing the visitor came for. `leagueReady` decides which,
	 * from the created league itself rather than from the template's name.
	 */
	const create = useCallback(
		(template: string) =>
			run(async () => {
				if (!config) return
				const k = leagues.suggestKey(config, template)
				const next = leagues.create(k, template)
				adopt(next, k)
				const made = next.leagues[k]!
				if (leagueReady(made)) {
					setView("board")
					// named by the platform the league itself carries, not by the template
					// key, which is an internal string nobody chose
					show(
						`Ranking on the ${made.meta.platform[0]!.toUpperCase()}${made.meta.platform.slice(1)} ` +
							`preset — check its values on My league`
					)
				} else {
					setView("trade")
					show(`Created ${k} — every field is blank until you fill it in`)
				}
			}),
		[config, run, adopt, show]
	)

	/**
	 * Drag a league file anywhere onto the page.
	 *
	 * The file route is the answer for a Yahoo user — the platform no browser can
	 * read — and it was a button in a toolbar that only appears on one tab, labelled
	 * as though it were a restore-from-backup. Listening on the window means the
	 * file lands wherever it is dropped, including on the board a visitor is
	 * looking at when they realise it is not their league.
	 *
	 * `dragover` must be prevented for a drop to fire at all, and the counter-free
	 * approach (dragleave anywhere clears it) is deliberate: dragleave fires for
	 * every child element the pointer crosses, so a boolean set on dragover and
	 * cleared only when the pointer actually leaves the window keeps the overlay
	 * from flickering.
	 */
	useEffect(() => {
		const over = (e: DragEvent) => {
			if (!e.dataTransfer?.types.includes("Files")) return
			e.preventDefault()
			setDragging(true)
		}
		const leave = (e: DragEvent) => {
			if (e.relatedTarget === null) setDragging(false)
		}
		const drop = (e: DragEvent) => {
			if (!e.dataTransfer?.files.length) return
			e.preventDefault()
			setDragging(false)
			loadFile(e.dataTransfer.files[0]!)
		}
		window.addEventListener("dragover", over)
		window.addEventListener("dragleave", leave)
		window.addEventListener("drop", drop)
		return () => {
			window.removeEventListener("dragover", over)
			window.removeEventListener("dragleave", leave)
			window.removeEventListener("drop", drop)
		}
	}, [loadFile])

	const league = key && config ? config.leagues[key] : undefined
	// Nothing is known until the store has been read, and "no leagues", "not looked
	// yet" and "the store is unreadable" are three different screens. One value
	// decides which, so no two controls can disagree about it.
	const store: StoreState = loadError ? "unreadable" : config ? "read" : "reading"
	const loading = store === "reading"
	// The board, the draft and a trade are all priced in the same three inputs.
	// Until they exist, the guided panel is what the page leads with.
	const ready = leagueReady(league)
	/** What scoring.json offers to start from, and which of those is ready-made.
	 *  Both read from the data: a preset that stops shipping stops being offered. */
	const templates = useMemo(() => templateOptions(config), [config])
	const preset = templates.find(t => t.filled) ?? null

	/**
	 * Turn the borrowed preset into a league of this reader's own.
	 *
	 * Hoisted out of the Onboard prop it used to be written inline in, because a SECOND
	 * caller appeared: a tapped "Did you mean" suggestion is the same act of commitment as
	 * a successful paste, and until it could reach this it silently did nothing — see the
	 * note on `onAddSuggested` below. Returns the key it created, or null, so both callers
	 * can tell a visitor the truth about whether anything was saved.
	 */
	const adoptPreset = useCallback((): string | null => {
		if (!config || !preset) return null
		try {
			const k = leagues.suggestKey(config, preset.key)
			const next = leagues.create(k, preset.key)
			adopt(next, k)
			return k
		} catch (e) {
			show(e instanceof ApiError ? e.message : String(e), true)
			return null
		}
	}, [config, preset, adopt, show])

	/**
	 * A ranked board before anybody has committed a league.
	 *
	 * The first visit used to be the setup and nothing else, on the reasoning that a
	 * bscore is denominated in a league's own points and there is no honest board
	 * without one. Both halves of that are true and the conclusion was wrong: a
	 * stranger cannot tell whether this is worth two minutes of setup until he has
	 * seen what it produces, and "trust me, fill in seventeen point values" is the
	 * ask that loses him. What was actually wrong before was seeding somebody's REAL
	 * league and letting it pass for his own.
	 *
	 * So the board runs on the shipped PRESET — one real head-to-head points league's
	 * values, copied from its settings page and labelled as copied,
	 * nobody's team, labelled as borrowed on the card above it and in the board's own
	 * heading — and the setup sits beside it rather than in front of it. Every number
	 * moves the moment a real league arrives, which is the argument for setting one
	 * up, made by showing it rather than by asserting it.
	 */
	const preview = useMemo((): League | null => {
		if (league || !preset || !config) return null
		const tpl = config.platform_templates[preset.key]
		const parsed = LeagueSchema(tpl)
		return parsed instanceof type.errors ? null : parsed
	}, [league, preset, config])
	/** The league every ranked surface is denominated in: the reader's own where he
	 *  has one, the preset preview where he has not, and null where neither exists. */
	const shown = league ?? preview
	/**
	 * Whether this browser holds a team for the active league.
	 *
	 * Asked HERE rather than inside `Recap`, because it decides where that card goes and a
	 * component cannot place itself. Cheap — the roster store is a list of ids — and it
	 * swallows its own failure: an unreadable roster means "no team to answer about", which
	 * is the same placement as no team, and My league owns the explaining either way.
	 */
	const hasTeam = useMemo(() => {
		if (!key) return false
		try {
			return roster.of(key).length > 0
		} catch {
			return false
		}
	}, [key, rev])
	/** The reader's own men, for the one period read the page makes. Same swallow as
	 *  `hasTeam` above and for the same reason. */
	const ownedIds = useMemo(() => {
		if (!key) return [] as string[]
		try {
			return roster.of(key)
		} catch {
			return [] as string[]
		}
	}, [key, rev])
	/**
	 * HOW THE WEEK STANDS, READ ONCE FOR THE WHOLE PAGE.
	 *
	 * Tonight and Last night were asking `byDateRange` for the same window, the same league
	 * and overlapping groups, a few hundred lines apart, because neither knew the other was
	 * doing it. It is one read here, handed to both — and the matchup gap that falls out of
	 * it is what the Tonight card gets for nothing.
	 */
	const matchup = useMatchup(
		typeof snapshot?.season === "number" ? snapshot.season : null,
		league ?? null,
		snapshot?.horizon.end ?? null,
		key,
		ownedIds,
		/* A team by EITHER measure: the hand-typed route stores seats and no roster, and
		   inferring "has a team" from the roster alone took the recap card's week block away
		   from exactly those readers. */
		hasTeam || !!(key && lineupStore.of(key)?.spots.length),
		rev
	)
	/**
	 * League MANAGEMENT — create, remove, import, download, load a file — is chrome
	 * for a thing you do once, and it was sitting above the recommendations on every
	 * view. Measured in the browser: it pushed the first ranked row to y=1187, so on
	 * a 1200px screen the board this page exists to show was entirely below the fold.
	 *
	 * It shows where it belongs: on League setup, or when there is no league at all
	 * and importing one is the only thing left to do. Elsewhere all that survives is
	 * the switcher, and only when there is more than one league to switch between.
	 */
	/** Whether the setup dock is on the page at all — see the note where it renders. */
	const docked = !loadError && !loading && (onboarding || !league)
	const manage =
		/*
		 * Never while the dock is up, and that is stronger than the rule it replaces.
		 *
		 * The toolbar is the same five unexplained buttons the dock exists to stand in
		 * for — New, Remove, Download, Load file and a URL field — and this used to be
		 * gated on `!onboarding`, which is not the same thing: clicking a tab turns
		 * `onboarding` off, so a reader with no league who pressed Today got the dock
		 * AND the toolbar, which is the maze the dock was built to end. Gated on
		 * whether the dock is on screen, the two can never both be offering the way in.
		 *
		 * "league" was its own tab and is now the second half of Setup, so the league
		 * management chrome belongs on the screen where a league is set up — and on the
		 * unreadable-store screen, where Load file is the only way out.
		 */
		!docked && (view === "trade" || store === "unreadable")

	return (
		<div className={`wrap${busy ? " busy" : ""}${acknowledged ? " saved" : ""}`}>
			{/* The first stop on the page, and off screen until it is the focused one. A
			    keyboard reader had to pass the masthead, three tabs, four status chips and
			    a dozen filter controls to reach the ranking, on every visit. */}
			<a className="skip" href="#main">
				Skip to the answer
			</a>
			{/* Styled inline rather than in app.css: it is one element that exists only
			    while a file is in the air, and it has to sit above everything the page
			    has painted. `pointer-events: none` matters — the window's own drop
			    handler is what takes the file, and an overlay that swallowed the event
			    would make the page look like it accepted a file it never received. */}
			{dragging && (
				<div
					className="dropzone"
					style={{
						position: "fixed",
						inset: 0,
						zIndex: 50,
						display: "grid",
						placeItems: "center",
						pointerEvents: "none",
						background: "color-mix(in srgb, var(--bg) 82%, transparent)",
						outline: "3px dashed var(--accent)",
						outlineOffset: "-14px",
						font: "600 18px/1.5 inherit",
						textAlign: "center",
						padding: "var(--sp-4)"
					}}
				>
					{/* A file is a file. Naming its format and the command that writes it, to
					    somebody holding the file over the page, is the software explaining
					    itself at the one moment nobody needs it to. */}
					<span>Drop it to load your league</span>
				</div>
			)}
			<header>
				{/*
				  One line.

				  The masthead was 199px on a desktop and 203px on a phone — a wordmark, a
				  tagline on its own line, and a banner saying leagues are saved in this
				  browser — sitting above a page whose first ranked row was already 1,229px
				  down. None of the three is a decision input, and two of them are read
				  once. So they share the line: Billy and the wordmark carry the identity,
				  the tagline sits beside them and drops out under 640px where there is no
				  room for charm, and the storage reassurance moves to Setup, which
				  is the screen where somebody is deciding whether to trust this with a
				  league.
				*/}
				<div className="mark">
					<Billy />
					<h1>
						beane<b>machine</b>
					</h1>
					<p className="tagline">How can you not be robotic about baseball?</p>
				</div>
			</header>

			{/*
			  A <nav>, and no longer a tablist.

			  It claimed `role="tablist"` with three `role="tab"` children and behaved like
			  neither. Measured with focus on a tab: ArrowRight, ArrowLeft, Home and End all
			  did nothing, all three were separate Tab stops rather than a roving one,
			  `aria-controls` was null on every one, and there was no `role="tabpanel"` for
			  them to control — the only one on the page belongs to the board's own horizon
			  tablist. A screen reader announces "tab, 1 of 3", the reader reaches for the
			  arrow keys, and nothing happens. It also carried `aria-current="page"`, which is
			  a navigation-link property, on a role that is not a link.

			  Two honest ways out: build the real tablist (roving tabindex, arrow keys,
			  aria-controls, a labelled panel — the board's `.modes` already does all four and
			  is the pattern), or stop claiming to be one. This takes the second, because it
			  IS a navigation: each of the three swaps the whole page, the address of the
			  screen is stored, and there would then be two tablists on one screen, one of
			  them nested in the other's panel, which is the arrangement that confuses people
			  most. `aria-current="page"` is exactly right on a nav and is what is left.
			*/}
			<nav className="views" aria-label="Sections">
				{VIEWS.map(v => (
					<button
						key={v.id}
						/* The hover is gone where the screen now says its own sentence — a hover
						   that repeats visible text is noise, and a hover that is the only copy of a
						   sentence was the defect. What survives is the DISABLED case, which is
						   information no screen can carry: a tab that highlights and then shows the
						   same setup card reads as a broken button. */
						title={shown ? undefined : `${v.purpose} — set a league up first`}
						aria-current={view === v.id ? "page" : undefined}
						className={view === v.id ? "on" : ""}
						// Nothing on any of them exists yet. A tab that highlights and then
						// shows the same setup card reads as a broken button; saying why
						// costs one attribute.
						disabled={!shown}
						// the .on class carries the tab's state; the accent is the same "this one
						// is live" signal .modes and .chip-btn already use for a selected control
						style={view === v.id ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
						onClick={() => {
							/*
							 * A TAB PRESS CLOSES THE SHEET AND KEEPS THE BAR, and the version that
							 * did otherwise threw away what the reader had typed.
							 *
							 * This was `setOnboarding(false)`, on the reasoning that choosing a tab
							 * is choosing to leave the setup. `docked` is `onboarding || !league`,
							 * so the moment a league exists — which is the moment the preset is
							 * adopted, in the middle of the first visit — that line UNMOUNTED the
							 * dock, and an unmounted sheet loses its textarea. The sheet is kept
							 * mounted and merely hidden precisely so that closing it by any route
							 * does not discard eighteen typed lines (see src/client/Dock.tsx); this
							 * route was the exception nobody had walked, and test/static.mjs caught
							 * it by navigating the way a reader does rather than by the hash.
							 *
							 * So the sheet closes and the one-line bar stays. He gets the screen he
							 * asked for, his typing is still there, and the way back is still on
							 * screen. `onboarding` goes false where it means something: "Show me the
							 * board" at the end of the setup, a loaded file, and the dock's own
							 * close-with-a-league, which is a reader saying he is finished.
							 */
							go({ view: v.id, sheet: false })
						}}
					>
						{v.label}
					</button>
				))}
				{/* "How to read this →" used to sit here. It is the same link the colophon
				    already carries, and on a 390px phone it pushed the three tabs into a
				    horizontal scroll and cut itself off mid-word. A duplicate link that
				    breaks the navigation is worse than no link, and the navigation is the
				    one thing on the page that has to fit. */}
			</nav>

			<Toolbar
				config={config}
				store={store}
				view={view}
				manage={manage}
				activeKey={key}
				templates={templates}
				onSelect={k => void run(async () => adopt(leagues.activate(k), k))}
				onImport={url =>
					void run(async () => {
						// reading the league needs a server; storing what it read never does
						const { key: k, league } = await api.import(url)
						adopt(leagues.save(k, league), k)
						show(`Imported ${league.meta.league_name ?? k}`)
					})
				}
				onCreate={template => void create(template)}
				onRemove={k =>
					void run(async () => {
						adopt(leagues.remove(k))
						show("Removed")
					})
				}
				onOnboard={() => {
					setOnboarding(true)
					go({ sheet: true })
				}}
				onDownload={() => {
					if (!config) return
					const file = leagues.download(config)
					const carried = [
						`${Object.keys(file.leagues).length} league${Object.keys(file.leagues).length === 1 ? "" : "s"}`,
						file.rosters ? `${Object.keys(file.rosters).length} roster` : null,
						file.lineups ? `${Object.keys(file.lineups).length} lineup` : null,
						file.pools ? `${Object.keys(file.pools).length} free-agent list` : null
					].filter(Boolean)
					show(`Saved a file with ${carried.join(", ")} in it. Drop it on this page to load it back.`)
				}}
				onLoadFile={loadFile}
				onPicker={registerPicker}
				onReject={m => show(m, true)}
				part="selector"
			/>

			<Status
				league={league ?? null}
				store={store}
				detail={view === "trade"}
				snapshot={snapshot}
				snapshotError={snapshotError}
				wire={wire}
				/* The paste control, not the file picker — see the note on `WireChip`. It
				   lives on My league, so this is a navigation; the reader lands on the screen
				   that holds it rather than on a dialog he has nothing to put in. */
				onFixWire={() => {
					setOnboarding(false)
					go({ view: "trade", sheet: false })
				}}
				/*
				  THE ONE CONTROL THAT IS ON EVERY SCREEN, so the reminder to go and get a
				  fresher list is too. Offered only when this browser can actually do it and
				  only for the league the chip is about; a button that cannot do the thing it
				  names is worse than no button.
				*/
				onRefreshWire={
					ext.present && snapshot && key && league?.meta.platform === "yahoo" ?
						() =>
							void run(async () => {
								const id = key.startsWith("yahoo:") ? key.slice("yahoo:".length) : null
								if (!id) return
								const got = await refreshPool(ext, snapshot, key, id)
								stored()
								/* The sweep's own account of itself, appended rather than dropped. A read
								   that got 225 men and refused one position as another position's list
								   has two things to say, and the second one is the one that explains
								   the board's gap — see `notes` on `PoolRead`. */
								show(
									[
										got.added !== null ?
											`Read ${got.added} free agents off your league.`
										:	`${got.failure?.what ?? "That could not be read"}${got.failure?.fix ? ` — ${got.failure.fix}` : ""}`,
										...got.notes
									].join(" ")
								)
							})
					:	null
				}
				wireBusy={ext.busy}
			/>

			{/*
			  A BROWSER THAT WILL KEEP NOTHING STILL GETS THE BOARD, and is told the truth about
			  what it will not do.
			
			  It used to get the masthead and "your leagues couldn't be read" and no board at all
			  — no ranked players, no card, no last night — because the starter file was fetched
			  and then WRITTEN, and a refused write took the whole config down with it. Every one
			  of those screens is computed from a fetch and a capture; not one of them needs a
			  store to render. What is refused is keeping things, so that is what is said, once,
			  here rather than per store as each one fails in turn.
			*/}
			{!loadError && leagues.keepsNothing() && (
				<div className="grid">
					<section className="card full">
						<h2>This browser won&rsquo;t keep anything</h2>
						<ul className="flags">
							<li>{leagues.keepsNothing()}</li>
						</ul>
						<p className="sub" style={{ margin: "var(--sp-3) 0 0" }}>
							Everything below works and none of it will survive closing the tab &mdash; your
							team, your league&rsquo;s values and anything you read will be gone. A private
							window usually does this. <b>Download</b> above saves a file you can load back
							anywhere.
						</p>
					</section>
				</div>
			)}

			{/* A store that can't be read is not an empty store, and every tab's own
			    "configure a league first" would quietly claim it is. */}
			{loadError && (
				<div className="grid">
					<section className="card full">
						<h2>Your leagues couldn&rsquo;t be read</h2>
						<ul className="flags">
							<li>{loadError}</li>
						</ul>
						<p className="sub" style={{ margin: "var(--sp-3) 0 0" }}>
							Nothing was overwritten and nothing was guessed at. <b>Load file</b> above
							replaces what is in this browser with a file you saved.
						</p>
					</section>
				</div>
			)}

			{/* A league that exists but cannot rank yet: this names the gaps in place,
			    on whichever tab is open, without taking the screen over the way the
			    first-run setup does. */}
			{!loadError && !loading && !onboarding && league && !ready && (
				<Setup
					leagueKey={key}
					league={league ?? null}
					canImport={getMode() !== "static"}
					preset={preset?.label ?? null}
					onUsePreset={preset ? () => void create(preset.key) : undefined}
					onLoadFile={() => openPicker.current?.()}
					onOpenSetup={view === "trade" ? undefined : () => go({ view: "trade" })}
				/>
			)}

			{/* A preset ranks immediately, which is the point of it and also the risk:
			    a board that works looks like a board that is right. This says whose
			    numbers it is working from, on every tab, until they are checked. */}
			{league && isPreset(league) && key && (
				<PresetNote
					league={league}
					/* The long form only on the league's own screen — see `full`. The same
					   condition `onOpenSetup` is already keyed on, written out rather than
					   inferred from it, because one of the two is about a button and the other is
					   about 276 vertical pixels on a phone. */
					full={view === "trade"}
					onOpenSetup={view === "trade" ? undefined : () => go({ view: "trade" })}
					onChecked={() =>
						void run(async () => {
							if (
								/* "YOUR league", not the league's own name. `league.meta.league_name`
								   on a preset resolves to the preset's LABEL, so this dialog asked
								   "Confirm that these values match Yahoo H2H points (preset)'s own
								   settings page?" — whether the preset matches the preset, which is a
								   question with no useful answer and which a reader cannot even tell
								   is the wrong question. The only league that matters here is his. */
								!confirm(
									`Confirm that these values match your own league's settings page? ` +
										`Nothing was read from your league, so this records that you ` +
										`checked them by hand — it does not make them read from your league.`
								)
							)
								return
							const on = localDate()
							const platform = league.meta.platform
							// The preset marker goes, so the notice ends; `verified` does not,
							// because nothing was read off the league and only an import can
							// change that. What replaces the preset's "check this" list is one
							// line saying where the values came from and who vouched for them.
							adopt(
								leagues.save(key, {
									...league,
									provenance: {
										...league.provenance,
										method: `manual entry: started from the ${platform} preset, then checked by hand against the league's own settings page on ${on}`
									},
									needs_review: [
										`These values were started from the ${platform} preset and confirmed by hand on ${on}. Nothing was read from this league's own pages, so it stays unverified — importing the league is the only route that changes that.`
									]
								}),
								key
							)
							show("Recorded as checked by hand — the values are yours now")
						})
					}
				/>
			)}

			{/* `<main id="main">` is where "skip to the answer" lands, and it is also the
			    landmark a screen reader jumps to. It wraps the view content rather than the
			    whole page, because the masthead, the tabs and the status chips are exactly
			    what both of those readers are trying to get past. */}
			{/* Nothing below can say anything until a league exists — the board is
			    empty and a trade has no prices — so on a first
			    visit the setup above is the page rather than a card on top of four
			    empty ones. Keyed on the LEAGUE rather than on whether the setup is
			    open, because those come apart: the setup stays open while a
			    half-read league is being finished, and that league can already rank
			    a board worth seeing underneath it. */}
			{/* `tabIndex={-1}` so the skip link can actually put focus here — without it
			    the browser scrolls to the landmark and leaves focus on the body, and the
			    next Tab starts again from the top of the page. */}
			<main id="main" tabIndex={-1}>
			{!shown ? null
			: view === "board" ?
				/*
				  TODAY is its own screen now, and the ranked board is its own screen.
				  
				  They used to share one tab called "Today": the decision card,
				  then a thousand-row table under it. Measured at phone width, that put the
				  first ranked row 1,600px down and the answer and the lookup in a single
				  8,400px scroll — two questions asked at different moments (before first
				  pitch; when you have a move to spend) stacked on one another because they
				  happen to share an engine. A reader who came to be told what to do had to
				  scroll past nothing; a reader who came to look somebody up had to scroll
				  past everything.
				  
				  One screen, one question. Today is the decision. Wire is the lookup, and
				  it is one tap away with a link at the foot of this one.
				*/
				<div className="grid">
					{/*
					  THE SCREEN SAYS WHAT IT IS FOR, in text, because the hover never reached a
					  phone.
					  
					  The three tab sentences in `VIEWS` are the best orientation copy in this app
					  and all three were `title` attributes on the nav buttons — a hover, on a
					  product opened on a phone, where 68 of the 70 attributes on one screen were
					  longer than six words and not one of them was reachable by a thumb. Pickups
					  renders its own through `purpose("wire")`; these two are composed by App out
					  of several cards, so App is where the screen-level sentence belongs rather
					  than inside whichever card happens to come first.
					  
					  Measured cost for the same pattern on Pickups: 113px at 390x844 and 75px at
					  1280x1000, with that screen's answer card still whole above the fold.
					*/}
					<div className="full">
						<p className="sub board-intro">{purpose("board")}</p>
					</div>
					{/*
					  LAST NIGHT SITS ABOVE TONIGHT, and the order is the argument.
					  
					  It was going to be a fourth tab. Measured at 390px: the tab strip is 344px
					  wide and the three tabs in it take 277px with their gaps, so a fourth
					  reading "LAST NIGHT" — about 108px at the bar's 11px type with 1.1px of
					  tracking — does not fit, and four tabs were removed once already for
					  exactly that reason (see the note below on Setup).
					  
					  Above rather than below, because it is the only surface in this app that
					  states a FACT. Everything under it is an estimate that says so. A reader
					  arriving in the morning is answered before he is advised, and a reader
					  arriving at 6pm scrolls past one card to reach tonight. It renders nothing
					  at all until there is a team to say something about, so it costs a first
					  visit neither a pixel nor a request.
					*/}
					{/*
					  WHERE LAST NIGHT SITS DEPENDS ON WHETHER THERE IS A TONIGHT TO ANSWER.
					  
					  With no team, the decision card is a pitch and last night's real numbers are
					  the most interesting thing the page can show a stranger, so they lead.
					  
					  With a team, the decision card IS the product and it has a deadline on it.
					  Putting the recap above it pushed the answer to y826 on a desktop and y901
					  on a phone — off the first screen — and test/board.mjs and test/journey.mjs
					  both assert that the answer is on the first screen, which is a constraint
					  this repo chose on purpose and which a reward for yesterday does not get to
					  overrule. A manager opening the app at 6:40pm is working against a lock;
					  the morning reader scrolls one card.
					*/}
					{!hasTeam && (
						<Recap snapshot={snapshot} league={shown} leagueKey={key} matchup={matchup} />
					)}
					<Decide
						snapshot={snapshot}
						league={shown}
						leagueKey={key}
						error={snapshotError}
						matchup={matchup}
						onOpenTeam={() => go({ view: "trade" })}
					/>
					{hasTeam && (
						<Recap snapshot={snapshot} league={shown} leagueKey={key} matchup={matchup} />
					)}
					<p className="next-screen">
						<button type="button" className="chip-btn" onClick={() => go({ view: "wire" })}>
							Everyone you can get →
						</button>
					</p>
				</div>
			: view === "wire" ?
				<div className="grid">
					<Board
						key={wireKey}
						snapshot={snapshot}
						league={shown}
						leagueKey={key}
						error={snapshotError}
						preview={!league}
					/>
				</div>
			: view === "trade" ?
				/*
				  SETUP is one screen: your team, then your league.
				  
				  They were two tabs — "My team & trades" and "Setup" — out of four,
				  and both are things one person does once a season from a laptop. Half the
				  navigation was furniture, and the tab bar did not fit the phone the app is
				  actually opened on. They are also the same job: everything the other two
				  screens say is priced in the values below, and the men above are who those
				  prices are about.
				  
				  Team first, because a league with no roster produces a board and no
				  decision, and because the paste is the step people abandon.
				*/
				<>
					<div className="grid">
						{/* The third of the three, for the same reason — and it is the longest and
						    says the thing nothing else on any screen says: everything the other two
						    screens tell you is priced in these values. */}
						<div className="full">
							<p className="sub board-intro">{purpose("trade")}</p>
						</div>
						{/*
						  No `key={wireKey}` here, and that is the point.
						  
						  The remount exists so a surface that fetched availability once re-asks
						  when a different free-agent list arrives. Board needs it and holds
						  nothing a reader typed. Trade IS the screen the list is pasted INTO —
						  so remounting it on the write wiped the textarea's own confirmation
						  ("Found 12 free agents…") in the same tick it appeared. A reader who
						  pastes, sees it work, and watches the message vanish has been told it
						  did not. Store writes now announce themselves (src/client/stores.ts),
						  so the re-read happens without throwing the component away.
						*/}
						<Trade
							snapshot={snapshot}
							league={league ?? null}
							leagueKey={key}
							error={snapshotError}
							say={show}
						/>
					</div>
					{league && key ?
						<LeagueEditor
							key={key}
							leagueKey={key}
							league={league}
							snapshot={snapshot}
							onSaved={next => {
								adopt(next, key)
								acknowledge()
								show("Saved to this browser")
							}}
							onError={m => show(m, true)}
							run={run}
						/>
					:	null}
				</>
			:	null}
			</main>

			{/* app.css is being rewritten by another pass as this lands, so the rules this
			    change needs ride with the component that renders them — the same arrangement
			    `ASSUMED_CSS` uses in src/client/Decide.tsx. They belong beside the other
			    `.bar` rules in app.css and can move there whenever the two are not being
			    edited at once. */}
			<style href="bar-admin" precedence="default">{ADMIN_CSS}</style>
			{/*
			  LEAGUE MANAGEMENT, UNDER THE ANSWER RATHER THAN OVER IT.
			  
			  This was above `main` on every screen it appeared on, which meant My league —
			  the screen a reader reaches when he wants to fix his scoring — opened with
			  "Start a league from / a blank league (nothing filled in) / New / Remove /
			  Download / Load file / Import a league from its URL" before anything about his
			  own team. Six controls for things a person does once a season from a laptop,
			  between him and the reason he came.
			  
			  Under `main` rather than inside the Setup view, so the Load-file escape from an
			  unreadable store is still reachable from whatever screen he is standing on —
			  `manage` is true for that case on every view, and moving it into one view would
			  have taken the only way out with it.
			*/}
				<Toolbar
					config={config}
					store={store}
					view={view}
					manage={manage}
					activeKey={key}
					templates={templates}
					onSelect={k => void run(async () => adopt(leagues.activate(k), k))}
					onImport={url =>
						void run(async () => {
							// reading the league needs a server; storing what it read never does
							const { key: k, league } = await api.import(url)
							adopt(leagues.save(k, league), k)
							show(`Imported ${league.meta.league_name ?? k}`)
						})
					}
					onCreate={template => void create(template)}
					onRemove={k =>
						void run(async () => {
							adopt(leagues.remove(k))
							show("Removed")
						})
					}
					onOnboard={() => {
						setOnboarding(true)
						go({ sheet: true })
					}}
					onDownload={() => {
						if (!config) return
						const file = leagues.download(config)
						const carried = [
							`${Object.keys(file.leagues).length} league${Object.keys(file.leagues).length === 1 ? "" : "s"}`,
							file.rosters ? `${Object.keys(file.rosters).length} roster` : null,
							file.lineups ? `${Object.keys(file.lineups).length} lineup` : null,
							file.pools ? `${Object.keys(file.pools).length} free-agent list` : null
						].filter(Boolean)
						show(`Saved a file with ${carried.join(", ")} in it. Drop it on this page to load it back.`)
					}}
					onLoadFile={loadFile}
					onPicker={registerPicker}
					onReject={m => show(m, true)}
					part="manage"
				/>

			{/*
			  The setup hovers at the foot of the page rather than sitting above the
			  board, and the reason is the whole first-visit problem in one line: the
			  numbers are the argument for spending two minutes, and a form shown before
			  them asks for the two minutes first. See src/client/Dock.tsx.
			*/}
			{docked && (
				<Dock
					open={setupOpen}
					/*
					 * Closing the sheet when a league EXISTS also ends the onboarding state, and
					 * the two are not the same switch by accident.
					 *
					 * `onboarding` is what puts the dock on the page and takes the management
					 * toolbar off it — they must never both offer the way in. So a reader who
					 * pressed "Set up a league" in that toolbar, looked at the sheet and closed
					 * it again used to be left with neither: the dock closed, `onboarding` still
					 * true, and the row holding the button he had just pressed gone. With no
					 * league there is nothing to go back to, so the dock stays.
					 */
					onToggle={next => {
						go({ sheet: next })
						if (!next && league) setOnboarding(false)
					}}
					summary={
						/*
						  THE RECEIPT, where the bar used to say the least interesting true thing
						  it could.
						
						  "Editing Yahoo H2H-Pts 228947" tells a reader the name of the thing he is
						  looking at, which he can see. Once his league has actually been READ, the
						  bar can tell him what came across — the count of free agents and how long
						  ago — which is the first time this line says something he did not already
						  know. Both halves are read from the store rather than remembered from the
						  read, so the sentence stays true on the next visit and cannot outlive the
						  thing it describes.
						*/
						league && wire?.players.length ?
							<>
								Read <b>{league.meta.league_name ?? "your league"}</b> &mdash;{" "}
								{wire.players.length} free agents, {since(wire.at, Date.now()).label}.
							</>
						: league ?
							<>
								Editing <b>{league.meta.league_name ?? key}</b>.
							</>
						:	/*
						     The one conversion moment in the app, said as a benefit rather than as
						     a disclaimer.
						     
						     It read "Standard scoring — not your league yet. Yours stays in this
						     browser." Every word true, and all of it about what the app has not
						     got. What makes a stranger press a button is what he gets for it, and
						     what he gets is the thing the board behind the bar cannot tell him:
						     who to start tonight. The borrowed-values caveat has not gone — it is
						     on the board itself, attached to the numbers it is about — and the
						     privacy line moved inside the sheet, next to the box he types his team
						     into, which is where that question is actually asked.
						   */
							<>Tell it who&rsquo;s on your team and it will tell you who to start tonight.</>
					}
				>
<Onboard
					snapshot={snapshot}
					leagueKey={key}
					league={league ?? null}
					canImport={getMode() !== "static"}
					onCreateLeague={(platform, made) =>
						void run(async () => {
							if (!config) return
							// The settings page prints the league's own id, so a pasted league is
							// keyed exactly as an imported one is — the same league read by the
							// two routes lands in the same place instead of twice.
							const k =
								made.meta.league_id ?
									`${made.meta.platform}:${made.meta.league_id}`
								:	leagues.suggestKey(config, platform)
							adopt(leagues.save(k, made), k)
							show(`Read ${made.meta.league_name ?? "your league"} from that page`)
						})
					}
					/*
					 * Turn the preview into a real league, synchronously, and hand back its
					 * key — because the caller needs it in the same tick to write a roster
					 * against it. `create` is the async, toast-and-navigate version for a
					 * reader who deliberately chose the preset; this is the quiet one for a
					 * reader who has just typed his team and does not know there was a
					 * question about scoring yet.
					 */
					/*
					 * The one number that moves every row, set from a chip rather than a form.
					 * Written straight to the active league because the reader has said it —
					 * there is nothing to derive and nothing to check it against.
					 */
					/*
					 * The lineup-lock handler is gone with the question that fed it.
					 *
					 * src/client/Onboard.tsx no longer asks "can you change your lineup every day?"
					 * during setup: the gate that made it necessary changed, so Today now renders
					 * unless the league is KNOWN to lock for the period and states the assumption on
					 * its own heading, and the question is a select on My league. The saving code
					 * that lived here — writing `lineup_lock` with `source: "you said so during
					 * setup"` so a later read off the settings page could overwrite it without
					 * anyone guessing where it came from — is not lost: `patch` in the league editor
					 * below writes the same field through the same store.
					 */
					/*
					 * One accepted suggestion, and it goes into BOTH stores.
					 *
					 * The roster is the list of men who are yours; the lineup is where they sit.
					 * A tapped name has a roster entry and no seat — the line it came from was
					 * misspelled, so whatever position it carried was never read — and "BN" is
					 * the honest seat for a man you own and have not placed. Tonight then treats
					 * him as a bench player it may seat, which is what he is.
					 *
					 * Roster only would have been worse than nothing: `Decide` plans from the
					 * stored seats where it has them, so a man in the roster and absent from the
					 * lineup is a man the card silently never considers.
					 */
					/*
					 * IT ADOPTS A LEAGUE IF THERE IS NOT ONE YET, and it reports whether it
					 * worked.
					 *
					 * This opened `if (!key || !snapshot) return`, which silently did nothing —
					 * and the one path that reaches these chips without a league is the path
					 * where nothing else has adopted one. `readTeam` in Onboard.tsx returns
					 * early, before adopting the preset, when the paste matched NOBODY, which is
					 * exactly when the "Did you mean" suggestions are the whole screen. Meanwhile
					 * the chip's own handler marked the name added unconditionally, so the chip
					 * vanished and the sheet printed "Got them. 5 players" with an empty league
					 * list and a null roster in storage — and the team-count question and the
					 * finish button never appeared, because both are gated on a league existing.
					 *
					 * So the documented highest-attrition step in the product was a dead end
					 * that told the visitor he had succeeded. A tapped suggestion is the same act
					 * of commitment as a successful paste and earns the same preset adoption.
					 * Returning a boolean is what lets the chip stop lying: see the call site.
					 */
					onAddSuggested={async (id, group, name) => {
						let ok = false
						await run(async () => {
							if (!snapshot) return
							const k = key ?? adoptPreset()
							if (!k) return
							roster.add(k, `${id}:${group}`)
							const p = snapshot.players.find(x => x.id === id && x.group === group)
							const seats = lineupStore.of(k)
							if (p)
								lineupStore.set(
									k,
									[
										...(seats?.spots ?? []),
										{
											slot: "BN",
											name: p.name,
											positions: slotsFor(p, (snapshot.eligibility ?? {})[String(p.id)]),
											team: p.team ?? null
										}
									],
									seats?.at ?? new Date().toISOString()
								)
							show(`Added ${name}`)
							ok = true
						})
						return ok
					}}
					onTeamCount={teams =>
						void run(async () => {
							if (!league || !key) return
							adopt(
								leagues.save(key, { ...league, meta: { ...league.meta, max_teams: teams } }),
								key
							)
						})
					}
					onAdoptPreset={adoptPreset}
					onImportUrl={url =>
						void run(async () => {
							const { key: k, league: got } = await api.import(url)
							adopt(leagues.save(k, got), k)
							show(`Imported ${got.meta.league_name ?? k}`)
						})
					}
					onLoadFile={() => openPicker.current?.()}
					/*
					 * "Let me type the values myself" has to land on a screen that lets him.
					 *
					 * It used to be `setView("trade")` and nothing else, and on a first visit —
					 * which is the only visit this sheet appears on — My league holds exactly one
					 * card: "Import or configure a league first." Measured from a fresh context on
					 * the published build: the whole page body was that sentence, the footer and
					 * the dock. A button promising an editor delivering a card telling him to go
					 * and find one reads as a broken app, and a stranger leaves there.
					 *
					 * So it adopts the preview first, exactly as typing a team does. The values he
					 * is about to edit start as the preset's — which is what the sheet has been
					 * saying all along — and now there is a league for them to belong to.
					 */
					onOpenSetup={() => {
						if (!league) {
							if (!config || !preset) return
							try {
								const k = leagues.suggestKey(config, preset.key)
								adopt(leagues.create(k, preset.key), k)
							} catch (e) {
								show(e instanceof ApiError ? e.message : String(e), true)
								return
							}
						}
						setOnboarding(false)
						go({ view: "trade", sheet: false })
					}}
					onDone={() => {
						setOnboarding(false)
						go({ view: "board", sheet: false })
					}}
				/>
				</Dock>
			)}

			{/*
			  `provenance.verified`, not merely "a league exists".
			  
			  This was `own={!!league}`, and adopting the preset makes `league` truthy — so
			  the moment a first visit took the one-tap route, the footer asserted "Every
			  number is in your league's own points" on the same screen as the card saying
			  "These values are copied from one real Yahoo league, not read from yours." The
			  comment on Colophon below records fixing this exact contradiction for the
			  NO-league case; adopting a preset walked straight back into it.
			  
			  `verified` is the schema's own flag for "every stored value was read from the
			  league's own pages", which is precisely the condition under which the first
			  sentence is true. A preset is a real league's table borrowed, and the second
			  sentence is the honest one about it until the reader confirms or imports.
			*/}
			<Colophon own={!!league && league.provenance.verified} />

			{/*
			  THE LIVE REGION IS ALWAYS THERE, and it used to arrive with its own message.
			
			  A `role="status"` element that is inserted into the document at the same moment it
			  gets its text is not reliably announced: a screen reader watches a live region for
			  CHANGES, and a region that did not exist a moment ago has nothing to change from.
			  This was the app's only live region, so every toast it has ever shown — a league
			  saved, a player removed, a read that failed — was a message announced to nobody.
			
			  Two elements now: a permanently mounted region that holds the words, and the
			  visible toast, which is still conditional because a bubble on screen with nothing
			  in it is a bubble on screen. `aria-hidden` on the visible one so the announcement
			  is made once rather than twice.
			*/}
			<div className="visually-hidden" role="status" aria-live="polite">
				{toast?.message ?? ""}
			</div>
			{toast && (
				<div className={`toast on${toast.bad ? " bad" : ""}`} aria-hidden="true">
					{toast.message}
				</div>
			)}
		</div>
	)
}

/**
 * What the app is willing to claim, and where the working is.
 *
 * The advanced reader has the opposite problem to the beginner: the measured
 * results exist, in detail, and the app pointed at exactly one of them — a
 * single "How to read this" link in the nav, to the guide. METHODOLOGY.md is
 * where the backtest, the negative results and the caveats live and nothing on
 * screen mentioned it at all.
 *
 * WHAT THIS COMPONENT RENDERS is three links and one sentence about the unit the
 * numbers are in. It does NOT render the caveats below, and this comment said it did —
 * "they belong on the page and not only in a doc", above a footer that has never
 * carried one. They are kept because they are the reason the Methodology link is here
 * at all: a reader who follows it is owed them, and a reader who does not should not be
 * given a win count with no p-value on the way past.
 *
 * - Ranking, docs/METHODOLOGY.md §6.5: mean Spearman rho 0.6759 vs a naive
 *   0.5743 for hitting (+17.7%, 48 of 50 folds) and 0.5318 vs 0.4697 for
 *   pitching (+13.2%, 49 of 50), 14-day horizon, 2016-2026 — and these belong to the
 *   SINGLE-WINDOW ancestor of the shipped model, which §6.5 says and a comment twenty
 *   lines below this one used to contradict. The shipped multi-window blend measures
 *   17.7% on hitters and 13.9% on pitchers against the same naive baseline.
 * - The human comparison, §9: 63/111 weeks is 63W-47L with ties excluded,
 *   z 1.53, one-sided p 0.064 — short of the 5% bar this project applies to
 *   its other results, and quoting the win count without the p-value is the
 *   asymmetry METHODOLOGY calls out by name. Beating an inactive manager
 *   (98/111) and a streak-chaser (74/111) is the part that is established.
 * - Probables, §3.5: "This cannot be backtested, and the weight was not set by
 *   a measurement." Nothing archives what was announced when.
 *
 * Market edge gets its own line because it is a control on the board a reader can
 * select today, and the board's own warning does not cover it: Board.tsx warns only when
 * `edgeCoverage < 0.35`, and about coverage, not about the values themselves.
 *
 * The leak it used to describe is FIXED and this comment was the last place still saying
 * otherwise. "225 players across four games reading 51%" was true of the capture stamped
 * 2026-09-02, which `leakedByTeam` in src/data/yahoo-pool.ts predates. Re-measured on the
 * capture actually committed (2026-09-08): 880 players priced, exactly ONE at 51%, all
 * 31 Yankees on different values, and the depth-270 cut at 35% with 4 tied. One club
 * still has half its men on one value — the Angels, 15 of 29 at 0%, with the Reds next at
 * 12 of 28 — and that residue is what is worth watching, not a board-wide leak.
 */
const Colophon = ({ own }: { own: boolean }) => (
	<footer className="colophon">
		<p className="links">
			<a
				href="https://github.com/ssalbdivad/beanemachine/blob/main/docs/GUIDE.md"
				target="_blank"
				rel="noreferrer"
			>
				How to read this
			</a>
			<a
				href="https://github.com/ssalbdivad/beanemachine/blob/main/docs/METHODOLOGY.md"
				target="_blank"
				rel="noreferrer"
			>
				Methodology &amp; measured results
			</a>
			<a href="https://github.com/ssalbdivad/beanemachine" target="_blank" rel="noreferrer">
				Source
			</a>
		</p>
		{/*
		  One sentence, and the caveat that changes a decision.

		  This was four paragraphs — 277 words of backtest results, folds, z-scores and
		  p-values — rendered under EVERY tab. Measured on the first screen a new
		  visitor sees, it was 67% of the words on the page. It was also the wrong
		  words: it quoted "48 of 50 hitting folds" at a reader who cannot act on it,
		  while METHODOLOGY.md says that number was measured on a configuration this app
		  no longer ships. Rigour that nobody reads and that has quietly drifted from the
		  code is not rigour.

		  What survives is the one thing a reader's decision depends on: a bscore is not
		  a promise of points. Everything else — every fold, every effect size, and the
		  three things that could not be measured at all — is in METHODOLOGY.md, which is
		  linked above and is where it can be kept true.
		*/}
		{/* The explanation moved to the table, under the heads, generated from the
		    ordering actually in force — see `.board-legend` in Board.tsx. It was here,
		    on every screen including the one with no table on it, and it named the
		    column the streaming list is NOT sorted by. What is left is the pointer.
		    
		    And the pointer's first clause is conditional, because it was false on exactly
		    the screen a stranger sees first. With no league this said "Every number is in
		    your league's own points" three inches under a banner reading "Standard
		    scoring, not yours. Every number below is real and none of it is about your
		    league yet" — the app contradicting itself on one screen, about the one fact
		    that decides whether any of the numbers apply to the reader. */}
		<p className="tiny-note">
			{own ?
				"Every number is in your league's own points. "
			:	"Every number is in the scoring this board borrowed from one real league, not yours yet. "}
			How the projections were built and measured, and the parts that could not be,
			are in Methodology.
		</p>
	</footer>
)

const Toolbar = ({
	config,
	store,
	view,
	manage,
	activeKey,
	templates,
	onSelect,
	onImport,
	onCreate,
	onRemove,
	onDownload,
	onOnboard,
	onLoadFile,
	onPicker,
	onReject,
	part
}: {
	config: Config | null
	store: StoreState
	view: View
	/** Whether the create/remove/import/file controls are on screen at all. */
	manage: boolean
	activeKey: string | null
	/** Read from scoring.json, so the picker cannot offer a template the data
	 *  does not ship. */
	templates: TemplateOption[]
	onSelect: (key: string) => void
	onImport: (url: string) => void
	onCreate: (template: string) => void
	onRemove: (key: string) => void
	onDownload: () => void
	/** Reopens the guided setup — the same screen a first visit lands on. */
	onOnboard: () => void
	onLoadFile: (file: File) => void
	/** Hands the file input's opener up, so the Setup card can offer the same
	 *  route without a second `<input type=file>` to keep in step. */
	onPicker: (open: () => void) => void
	onReject: (message: string) => void
	/**
	 * Which half of this to draw, and the split is the whole point of it.
	 *
	 * The `selector` is the one line that says which league everything below is
	 * denominated in. That is orientation and belongs at the top of the page.
	 *
	 * `manage` is New, Remove, Download, Load file, a template picker and a URL field —
	 * six controls for things a person does once a season from a laptop. They were ALSO at
	 * the top, so My league opened with "Start a league from / a blank league / New /
	 * Remove / Download / Load file / Import a league from its URL" above anything about
	 * the reader's own team, on the one screen he reaches when he wants to fix his
	 * scoring. They now sit under the content, behind a summary that says what they are
	 * for, on the same screens as before — nothing became unreachable, including the
	 * Load-file escape from an unreadable store, which is why this renders under `main`
	 * for every view rather than only inside Setup.
	 */
	part: "selector" | "manage"
}) => {
	const [url, setUrl] = useState("")
	/**
	 * The ready-made one leads: it is the only option that ends in a ranked board
	 * without further typing, and it was not offered at all before.
	 *
	 * Null until somebody actually picks, rather than seeded with a default. The
	 * first render happens while the store is still being read, so `templates` is
	 * empty then — a `useState` initialiser would have frozen the fallback in, and
	 * did: it left "a blank league" selected on every load, which is the option that
	 * ranks nothing.
	 */
	const [chosen, setChosen] = useState<string | null>(null)
	const template = chosen ?? templates.find(t => t.filled)?.key ?? "custom"
	const picker = useRef<HTMLInputElement>(null)
	useEffect(() => {
		onPicker(() => picker.current?.click())
	}, [onPicker])
	const keys = Object.keys(config?.leagues ?? {})
	// the same control means different things per view, so it says which
	const label = LEAGUE_LABEL[view]
	const selector = (
				<label className="ctl">
					<span>{label}</span>
					<select
						value={activeKey ?? ""}
						disabled={!keys.length}
						aria-label={label}
						onChange={e => onSelect(e.currentTarget.value)}
					>
						{/* an empty disabled box reads as broken; this says which of the three
						    reasons it is empty for */}
						{!keys.length && (
							<option value="">
								{store === "reading" ? "Reading this browser…"
								: store === "unreadable" ? "Couldn't be read"
								: "No leagues in this browser"}
							</option>
						)}
						{keys.map(k => (
							<option key={k} value={k}>
								{config!.leagues[k]!.meta.league_name ?? k}
								{config!.leagues[k]!.meta.team_name ? ` · ${config!.leagues[k]!.meta.team_name}` : ""}
							</option>
						))}
					</select>
				</label>
	)
	/* The way back to the first-run setup.
	   A reader who already has a league had no route to it at all — it opens by itself on a
	   first visit and never again — and "I set up the wrong league" and "I want to add my
	   second one" are both ordinary. Deliberately not `.primary`: Import owns that below, and
	   the two are different promises — Import reads a league now, this walks a person through
	   getting one in.

	   IT STAYS ABOVE THE FOLD, and it is the one control from that row that does. The rest of
	   them are database operations on this browser's store; this is the guided route, and a
	   first pass at moving the row put it inside the disclosure with them — which hid the only
	   signposted way back into setup behind a summary nobody would read looking for it, and
	   was caught by test/ui.mjs failing to find it rather than by reasoning. */
	const guided = (
		<button
			data-ctl="onboard"
			title="Read a league off its own settings page, or start from a preset — the guided setup"
			onClick={onOnboard}
		>
			Set up a league
		</button>
	)

	if (part === "selector") {
		/* One league is the normal case, and a select with one option is a control that
		   cannot do anything — the chips below already name the league it would name. So it
		   appears when there is a choice to make, or when the store itself has something to
		   report, because the select is where that gets reported. "read" is the state where
		   the store answered; "reading" and "unreadable" both have something to say. */
		/* `|| manage` keeps the old rule exactly where it was load-bearing: on the screen
		   where a league is being set up, naming which one is being edited is worth a
		   one-option select, and test/ui.mjs asserts it. The "a control that cannot do
		   anything" argument applies to the screens where there is nothing to manage. */
		const choose = keys.length >= 2 || store !== "read" || manage
		return choose || manage ?
				<div className="bar">
					{choose ? selector : null}
					{manage ? guided : null}
				</div>
			:	null
	}
	if (!manage) return null
	return (
		<section className="bar-admin">
			{/*
			  A HEADING, NOT A DISCLOSURE, and the first attempt was the disclosure.
			  
			  Folding these six controls away read well and broke two things a fold cannot
			  help: Playwright cannot click into a closed `<details>`, so test/ui.mjs and
			  test/static.mjs lost the Download round-trip, the New-league path and the
			  template picker — and a reader looking for "how do I load the file I saved in
			  March" has no reason to open a summary before he has read one. Position was
			  the whole complaint: they were ABOVE the reader's own team on the screen he
			  opens to fix his scoring. Under the content with a heading that says what they
			  are for answers it, and costs nobody a tap.
			  
			  Named for what a person wants rather than for what the controls are: a second
			  league, a file to load, a copy to keep.
			*/}
			<h2 className="bar-admin-head">Other leagues, files and backups</h2>
			<div className="bar">
				<label className="ctl">
					<span>Start a league from</span>
					<select
						id="tpl"
						value={template}
						aria-label="Start a league from"
						onChange={e => setChosen(e.currentTarget.value)}
					>
						{templates.map(t => (
							<option key={t.key} value={t.key}>
								{t.label}
							</option>
						))}
					</select>
				</label>
				<button
					title={
						templates.find(t => t.key === template)?.filled ?
							"Start from one real league's values, which you then check against your own — nothing here was read from yours"
						:	"Start an empty league you fill in yourself — no values are invented"
					}
					onClick={() => onCreate(template)}
				>
					New
				</button>
				<button
					className="ghost"
					disabled={!activeKey}
					// Same defect as the scoring rows' × buttons, milder: the contents say
					// "Remove" with no object, in a toolbar beside New, Download and Load file,
					// and the title that names the object is discarded by the name algorithm.
					aria-label={
						activeKey ?
							`Remove ${config?.leagues[activeKey]?.meta?.league_name ?? activeKey} from this browser`
						:	"Remove this league from this browser"
					}
					title="Remove this league"
					/* By name, not by key. `activeKey` is "yahoo:228947" — something this app
					   filed it under and the reader has never seen — in a dialog that deletes
					   a league. The key is the fallback only where the league never named
					   itself. */
					onClick={() =>
						activeKey &&
						confirm(
							`Remove ${config?.leagues[activeKey]?.meta?.league_name ?? activeKey} from this browser?`
						) &&
						onRemove(activeKey)
					}
				>
					Remove
				</button>
				<button
					disabled={!keys.length}
					title="Save everything in this browser — your leagues, your team and the seats they were in — as one file you can load on another phone or computer"
					onClick={onDownload}
				>
					Download
				</button>
				<button
					title="Load a file you saved here before. Dropping it anywhere on the page does the same."
					onClick={() => picker.current?.click()}
				>
					Load file
				</button>
				<input
					ref={picker}
					type="file"
					accept="application/json,.json"
					hidden
					aria-label="Load a league file you saved"
					onChange={e => {
						const chosen = e.currentTarget.files?.[0]
						// picking the same file twice has to fire again, so clear it either way
						e.currentTarget.value = ""
						// The confirm moved to the one loader in App: a dropped file and a
						// picked one have to warn identically, and two copies of that check
						// is one copy too many to keep in step.
						if (chosen) onLoadFile(chosen)
					}}
				/>
			</div>
			<form
				className="bar"
				onSubmit={e => {
					e.preventDefault()
					if (!url.trim()) return onReject("Paste a league URL first.")
					onImport(url.trim())
					setUrl("")
				}}
			>
				<label className="ctl grow">
					<span>Import a league from its URL</span>
					<input
						type="text"
						value={url}
						onChange={e => setUrl(e.currentTarget.value)}
						placeholder="Paste a Yahoo or ESPN league URL…"
						aria-label="Import a league from its URL"
					/>
				</label>
				<button className="primary" type="submit">
					Import
				</button>
			</form>
		</section>
	)
}

/**
 * The masthead strip: which league everything below is denominated in, where its
 * values came from, and how old the observed data is. All three degrade to a
 * stated absence rather than to nothing at all — an empty strip would read as a
 * page that had not finished loading.
 */
const Status = ({
	league,
	store,
	detail,
	snapshot,
	snapshotError,
	wire,
	onFixWire,
	onRefreshWire,
	wireBusy
}: {
	league: League | null
	store: StoreState
	/** Provenance — platform, scoring type, whether it was read or typed, when —
	 *  is what you check while setting a league up and never again. It rides along
	 *  on the setup view; on the board it is four chips of noise above the ranking. */
	detail: boolean
	snapshot: Snapshot | null
	snapshotError: string | null
	/** The exact free-agent list this browser holds for the active league, or null. */
	wire: StoredPool | null
	/** Where the masthead sends a reader whose availability is still an estimate. */
	onFixWire: () => void
	/** Re-read the free agents from Yahoo, when this browser can. Null when it cannot. */
	onRefreshWire: (() => void) | null
	wireBusy: boolean
}) => {
	const age = freshness(snapshot?.capturedAt, Date.now())
	const data =
		snapshotError ? { className: "chip warn", value: "unavailable" }
		: !snapshot ? { className: "chip", value: "loading…" }
		: { className: `chip${age.stale ? " warn" : ""}`, value: age.label }
	return (
		<div className="chips">
			{league ?
				<Chips league={league} detail={detail} />
			: store === "reading" ?
				<span className="chip">reading this browser&rsquo;s leagues…</span>
			: store === "unreadable" ?
				<span className="chip warn">leagues unreadable</span>
			:	<span className="chip warn">no league yet</span>}
			{/*
			  NO TOOLTIP, and the stale case says so in words.
			  
			  The hover read "Age of the MLB and Statcast capture the ranking is computed from",
			  which a phone cannot open and which uses three words about the software to restate
			  the label beside it. What a reader needs from this chip is not what it is the age
			  OF — "player data" already says that — but whether the age matters, and that was
			  carried by the warn colour alone. Colour is not a sentence, and a reader who
			  cannot see the difference got nothing at all.
			  
			  So the qualification is text, on the only case where there is one: `freshness`
			  calls anything past thirty-six hours stale, which is the point at which a day's
			  games have happened since the numbers were taken.
			*/}
			{/* The clause COUNTS, because the first version of it understated by three days. It
			    read "— a day of games has happened since" for every stale case, and on a capture
			    84.3 hours old, beside a label already reading "4d ago", that is the app
			    understating its own staleness next to the number that contradicts it.
			    `freshness` calls anything past thirty-six hours stale, so the smallest true
			    version of this is still one day. */}
			<span className={data.className}>
				player data <b>{data.value}</b>
				{age.stale && !snapshotError && snapshot ?
					` — ${age.days === 1 ? "a day" : `${age.days} days`} of games since`
				:	""}
			</span>
			<WireChip
				league={league}
				wire={wire}
				onFix={onFixWire}
				onRefresh={onRefreshWire}
				busy={wireBusy}
			/>
		</div>
	)
}

/**
 * Which free agents this page has, and how old they are — beside the league, on
 * every tab.
 *
 * The board already prefers an exact free-agent list to the ownership estimate.
 * What it could not do was SAY which of the two it was working from, and on the
 * hosted build the honest answer was always the estimate: the list is read off
 * Yahoo's own pages and Yahoo sends no CORS headers, so beanemachine.com is never
 * handed one. A reader asking "which starters should I stream" got a ranking that
 * silently included everybody already rostered, with nothing on the page admitting
 * that the availability question had not been answered at all.
 *
 * So this states it, permanently, in the masthead:
 *
 *   · a list is carried  → how many, and WHEN it was read. The count without the
 *     time would be the exact failure this project refuses — the wire turns over
 *     whenever anybody clicks Add, so a pool with no timestamp is a claim about
 *     right now that nothing supports.
 *   · none is carried, and there is no server → the way to get one, as a button.
 *     This is the load door: it works from every tab, whereas Download/Load file
 *     live in a toolbar that only appears on League setup.
 *   · none is carried, but a local server is up → nothing, because the server
 *     reads the wire live on every page load and a prompt would be noise.
 *
 * Yahoo-only, because the pool is. ESPN sends CORS headers and the page reads that
 * league for itself.
 */
const STALE_WIRE_HOURS = 24

const WireChip = ({
	league,
	wire,
	onFix,
	onRefresh,
	busy
}: {
	league: League | null
	wire: StoredPool | null
	/** Where a reader goes to answer this. See the note on the button below for why it
	 *  is no longer the file picker. */
	onFix: () => void
	/** Re-read the list from Yahoo, when this browser can. Absent when it cannot, which is
	 *  the case the chip has always been written for. */
	onRefresh: (() => void) | null
	busy: boolean
}) => {
	if (league?.meta.platform !== "yahoo") return null
	if (wire) {
		const age = since(wire.at, Date.now())
		const stale = age.hours > STALE_WIRE_HOURS || !Number.isFinite(age.hours)
		/*
		  THE REMINDER LIVES ON THE READOUT, and only once it is true.
		
		  A free-agent list is the most perishable thing this app holds: one rival's claim
		  invalidates a row of it, and Yahoo processes waivers overnight, which is where the
		  24 hours comes from. Until today the only thing the app could do about an old list
		  was colour the chip amber and hope — the fix was a command line on another machine.
		  A browser that can re-read it turns the readout into the control, in the one place
		  that is already on every screen.
		
		  It stays a plain readout while the list is fresh. A button that is always there is
		  a button asking to be pressed, and pressing it is nine requests to somebody else's
		  site for an answer that has not changed.
		*/
		if (stale && onRefresh)
			return (
				<button
					type="button"
					className="chip warn"
					data-wire="stale"
					style={{ font: "inherit", fontSize: "var(--fs-3)", cursor: "pointer" }}
					onClick={onRefresh}
					disabled={busy}
				>
					free agents <b>{wire.players.length}</b> read {age.label} &mdash;{" "}
					{busy ? "reading\u2026" : "read them again"}
				</button>
			)
		return (
			<span
				className={`chip${stale ? " warn" : " ok"}`}
				data-wire="carried"
				title={
					`The exact free agents in your league, read at ${wire.at}. Anyone added or ` +
					`dropped since is not reflected. ${wire.note}`
				}
			>
				free agents <b>{wire.players.length}</b> read {age.label}
			</span>
		)
	}
	// A server reads the wire live, so there is nothing here to ask for.
	if (getMode() === "server") return null
	return (
		<button
			type="button"
			className="chip warn"
			data-wire="none"
			style={{ font: "inherit", fontSize: "var(--fs-3)", cursor: "pointer" }}
			onClick={onFix}
			/*
			  A tooltip is not a place to explain anything — a phone cannot open one — and
			  this held five sentences about access-control headers and a shell command.
			  What it needs to say is what the chip beside it already means.

			  AND THE ACTION CHANGED. It read "none carried — load a file" and opened a file
			  picker: the route for somebody who has run this project's own command line on a
			  desktop, which is nobody arriving at beanemachine.com. To a reader with no file
			  it is a dead end wearing a button, and "a file" is the app talking about itself.
			  What EVERY reader can actually do is paste his league's free-agent page, which
			  is a control on My league — so that is where this goes now. The file route has
			  not gone anywhere; it is in the toolbar on that same screen, where somebody who
			  has a file will look for it.
			*/
			/* The tooltip this replaced held the whole explanation — "Who is free is an
			   estimate from how widely each player is rostered across all of Yahoo, not your
			   league's own list. Your league's own list makes it exact." — on a control whose
			   visible text already says "estimated" and "make it exact", which is the fact and
			   the action. A phone cannot open it, so for most readers the sentence did not
			   exist; for the rest it restated the button. The WHY belongs on the screen the
			   button leads to, and My league now prints where the taken/free line falls and in
			   which league, in text, under the lineup it applies to. */
		>
			free agents <b>estimated</b> &mdash; make it exact
		</button>
	)
}

const Chips = ({ league, detail }: { league: League; detail: boolean }) => {
	const { meta, provenance } = league
	return (
		<>
			{[detail ? meta.platform : null, meta.team_name].filter(Boolean).map(v => (
				<span className="chip" key={String(v)}>
					<b>{String(v)}</b>
				</span>
			))}
			{meta.max_teams != null && (
				<span className="chip">
					<b>{meta.max_teams}</b> teams
				</span>
			)}
			{detail && meta.scoring_type && <span className="chip">{meta.scoring_type}</span>}
			{/*
			  THE SAME FACT, IN WORDS ABOUT BASEBALL.
			  
			  These chips read "read from source", "unverified" and "fetched 2026-09-08". Each
			  one is a true statement and none of them is about a fantasy league: "source" is
			  the word for where a program got something, "unverified" is what a form says when
			  it distrusts you, and "fetched" is what a program does. The house rule is that
			  nothing user-facing talks about the software, and a chip is the shortest possible
			  place to break it — a reader has no sentence around it to work out what it meant.
			  
			  What the flag actually means is whether every value was read off the reader's own
			  league pages or typed in from somewhere else, which is the difference between a
			  board priced in HIS points and one priced in a borrowed table. That is worth
			  saying, and it says itself in five words.
			  
			  The untrue case still shows everywhere, because it changes how much to trust
			  every number below; the true case rides with the detail, because it is the
			  uninteresting one.
			*/}
			{(detail || !provenance.verified) && (
				<span className={`chip ${provenance.verified ? "ok" : "warn"}`}>
					{provenance.verified ? "from your league" : "not from your league"}
				</span>
			)}
			{detail && provenance.fetched_at && (
				<span className="chip">read {provenance.fetched_at}</span>
			)}
		</>
	)
}

/** The scoring period as the league states it, with every field present. */
type Period = NonNullable<ScoringPeriod>

/** Every field null: a league that has said nothing about its period. Written only
 *  when an edit actually lands. Opening the editor must not turn an unstated period
 *  into a stored one — null means "not known", and a control that defaults itself on
 *  mount would turn the reader's silence into the league's answer. */
const NO_PERIOD: Period = {
	kind: null,
	days: null,
	starts_on: null,
	anchor: null,
	lineup_lock: null,
	source: null
}

/** Lowercase three-letter, as `resolvePeriod` matches them against `Date.getUTCDay`. */
const WEEKDAYS = [
	["mon", "Monday"],
	["tue", "Tuesday"],
	["wed", "Wednesday"],
	["thu", "Thursday"],
	["fri", "Friday"],
	["sat", "Saturday"],
	["sun", "Sunday"]
] as const

/**
 * How long a matchup period runs.
 *
 * Uncontrolled for the reason `ValueInput` and `TeamCountInput` in panels.tsx are:
 * the element has to be allowed to hold text the number is not finished being, and a
 * field React rewrites on every keystroke cannot be typed into. Empty is a real
 * answer — it is the league not having said, which is the state the panel above
 * prints the board's assumption for.
 */
const PeriodDaysInput = ({
	value,
	onChange,
	onReject
}: {
	value: number | null
	onChange: (next: number | null) => void
	onReject: (message: string) => void
}) => {
	const el = useRef<HTMLInputElement>(null)
	/** The number this field last handed up. It comes straight back as `value`, and
	 *  rewriting the field on that echo would eat a digit mid-number. */
	const sent = useRef<number | null | undefined>(undefined)
	const show = (to: number | null) => {
		if (el.current) el.current.value = to == null ? "" : String(to)
	}
	useEffect(() => {
		if (value === sent.current) return
		sent.current = undefined
		show(value)
	}, [value])
	return (
		<span className="field">
			<input
				ref={el}
				type="number"
				min="1"
				step="1"
				placeholder="—"
				aria-label="Days in a scoring period"
				defaultValue={value == null ? "" : String(value)}
				onChange={e => {
					const node = e.currentTarget
					const raw = node.value.trim()
					// "" with badInput set is a keystroke the browser cannot parse yet — a
					// stray "-", say. It is not somebody clearing the field.
					if (raw === "" && node.validity.badInput) return
					// empty is a real answer: it means nobody has said how long the period
					// is, and the panel says what the board reads in place of it
					if (raw === "") {
						sent.current = null
						return onChange(null)
					}
					const n = Math.round(Number(raw))
					// unlike the team count, no valid length is a prefix of another one that
					// this rejects — "1" is itself a period — so the minimum holds per
					// keystroke rather than waiting for blur
					if (Number.isFinite(n) && n >= 1) {
						sent.current = n
						onChange(n)
					} else {
						show(value)
						onReject("Enter a whole number of days.")
					}
				}}
				onBlur={e => {
					// text the browser never parsed committed nothing, so the field must not
					// be left showing it
					if (e.currentTarget.validity.badInput) {
						show(value)
						return onReject("Enter a whole number of days.")
					}
					// and once the typing is over the field shows what was actually stored,
					// so "007" does not sit there as a length no league holds
					show(value)
				}}
			/>
			<span className="unit">days</span>
		</span>
	)
}

/**
 * The league's own week, for a league whose period could not be read off its
 * platform.
 *
 * Everything here is nullable and the key itself is optional, so the panel's job is
 * as much to print what the board does with a null as to collect a value. It prints
 * `resolvePeriod`'s own `basis` sentence rather than a second copy of that reasoning,
 * because a second copy is a thing that can drift: the board's footer and this panel
 * would then disagree about the same league on the same day.
 */
const ScoringPeriodPanel = ({
	draft,
	saved,
	snapshot,
	onChange,
	onReject
}: {
	draft: League
	saved: ScoringPeriod | undefined
	snapshot: Snapshot | null
	onChange: (next: ScoringPeriod) => void
	onReject: (message: string) => void
}) => {
	const stated = draft.scoring_period ?? null
	/** The end of the captured slate, exactly as `useBoard` derives it, so the window
	 *  printed here is the window the board ranks over. Null with no snapshot: there
	 *  is then nothing to clip a window to, and dates are left unstated rather than
	 *  guessed. */
	const slateEnd = useMemo(
		() =>
			snapshot ?
				(snapshot.slate ?? []).reduce((a, g) => (g.date > a ? g.date : a), snapshot.horizon.end)
			:	null,
		[snapshot]
	)
	const resolved = useMemo(() => {
		const today = localDate()
		// `resolvePeriod` takes a slate end only to clip the window to what was
		// captured. With no snapshot there is nothing to clip to, so it is handed
		// `today` and only `basis` — which period.ts derives from the league alone,
		// never from the slate — is printed.
		return resolvePeriod(draft, today, slateEnd ?? today)
	}, [draft, slateEnd])

	/** An edit starts from whatever the league already said, with null — not a
	 *  default — everywhere it said nothing, so changing one field cannot invent the
	 *  other five. */
	const patch = (fields: Partial<Period>) => {
		const next = { ...NO_PERIOD, ...(stated ?? {}), ...fields }
		// Knowing nothing again is a state the league has to be able to return to:
		// clearing a mistaken entry must leave silence rather than an object claiming
		// six unknowns. `source` counts as something known, because it is the quote a
		// wrong value would be traced back through.
		const says = Object.values(next).some(v => v !== null)
		onChange(says ? next : null)
	}

	/** Which of these fields the board actually reads, given the period chosen. It is
	 *  stated rather than shown by disabling anything, because a fact the league does
	 *  hold is worth recording whether or not today's window is ranked on it. */
	const reads =
		stated?.kind === "matchup" ?
			"The length, the start day, the lock and the anchor are all read — the anchor in place of the start day, wherever one is set."
		: stated?.kind === "daily" ?
			"A daily league's window is today, so nothing else here is read."
		: stated?.kind === "none" ?
			"A league with no periods is ranked over a rolling week, so nothing else here is read."
		:	"Until the period is stated the board takes a rolling week and reads nothing else here."

	/** What the board fills each null in with. Every line names a fallback that is in
	 *  period.ts and would otherwise move a ranking without saying so. `basis` names
	 *  the Monday and seven-day fallbacks itself; the unstated lineup lock leaves no
	 *  trace there, because an unlocked period reads the same as a stated one. */
	const assumptions: string[] = []
	if ((stated?.kind ?? null) === null)
		assumptions.push(
			"This league has not said how its scoring period runs, so that window is an assumption rather than its own."
		)
	else if (stated?.kind === "matchup" && stated.starts_on === null && stated.anchor === null)
		assumptions.push("Neither a start day nor an anchor is stated, so the board falls back to a Monday start.")
	if (stated?.kind === "matchup" && stated.days === null)
		assumptions.push("No length is stated, so the board reads the period as seven days long.")
	if (stated?.kind === "matchup" && stated.lineup_lock === null)
		assumptions.push(
			"No lineup lock is stated, so the board treats the rest of the current period as still yours to act on."
		)

	const edited = JSON.stringify(stated) !== JSON.stringify(saved ?? null)

	return (
		<>
			<p className="sub">
				{/* The second sentence quoted "7.4 games a club when 4.7 remained", measured on
				    "the shipped league" — and the published build ships no league at all
				    (public/scoring.json carries `leagues: {}`), so the figure is not
				    reproducible from anything a reader has. What it was there to convey is why
				    these two fields are worth filling in, which is sayable without a number
				    nobody can check: a window that runs past the reset counts games that score
				    for somebody else's matchup. */}
				Which days a matchup is scored over, and whether the lineup can still be changed
				inside it — two facts that do not follow from each other. The period decides
				where the streaming window ends; the lock decides which period you can still act
				on. Get the period wrong and the board counts games played after your matchup has
				already been settled.
			</p>

			<div className="period">
				<label className="ctl">
					<span>Period</span>
					<select
						value={stated?.kind ?? ""}
						aria-label="How this league's scoring period runs"
						onChange={e => patch({ kind: (e.currentTarget.value || null) as Period["kind"] })}
					>
						<option value="">not stated</option>
						<option value="matchup">a matchup over days</option>
						<option value="daily">one day at a time</option>
						<option value="none">no periods at all</option>
					</select>
				</label>
				<label className="ctl">
					<span>Length</span>
					<PeriodDaysInput
						value={stated?.days ?? null}
						onReject={onReject}
						onChange={days => patch({ days })}
					/>
				</label>
				<label className="ctl">
					<span>Starts on</span>
					<select
						value={stated?.starts_on ?? ""}
						aria-label="Weekday the scoring period opens on"
						onChange={e =>
							patch({ starts_on: (e.currentTarget.value || null) as Period["starts_on"] })
						}
					>
						<option value="">not stated</option>
						{WEEKDAYS.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</label>
				<label className="ctl">
					<span>Lineups lock</span>
					<select
						value={stated?.lineup_lock ?? ""}
						aria-label="When this league locks the lineup"
						onChange={e =>
							patch({ lineup_lock: (e.currentTarget.value || null) as Period["lineup_lock"] })
						}
					>
						<option value="">not stated</option>
						<option value="daily">every day</option>
						<option value="period">for the whole period</option>
					</select>
				</label>
			</div>

			<p className="sub period-reads">{reads}</p>

			<p className="sub">
				The board ranks the streaming week over {resolved.basis}.
				{slateEnd !== null &&
					` Right now that window is ${resolved.start} → ${resolved.end}${
						resolved.clipped ? ", cut short by the end of the captured slate" : ""
					}.`}
			</p>

			{assumptions.length > 0 && (
				<ul className="flags">
					{assumptions.map(a => (
						<li key={a}>{a}</li>
					))}
				</ul>
			)}

			<details>
				<summary>Anchor the period to a date</summary>
				<p className="sub">
					For a league whose grid does not fall on a fixed weekday. Any date known to be
					the first day of some period: the board steps forward from it in strides of the
					length above, so an anchor without a length is stepped in sevens. It replaces
					the start day rather than adjusting it — with an anchor set, the weekday above
					is not read at all.
				</p>
				<div className="period">
					<label className="ctl">
						<span>First day of a period</span>
						<input
							type="date"
							value={stated?.anchor ?? ""}
							aria-label="A date known to be the first day of a scoring period"
							onChange={e => patch({ anchor: e.currentTarget.value || null })}
						/>
					</label>
				</div>
			</details>

			{stated?.source && (
				<p className="sub period-source">
					Read from: {stated.source}
					{edited &&
						" — that is where the stored values came from, not what is in the boxes now."}
				</p>
			)}
		</>
	)
}

/**
 * What the scoring period resolved to, in one line.
 *
 * The card it heads is a form for a value the importer derives, and the only thing a
 * reader checks is whether the derivation got it right. So the summary is that
 * answer — "7-day matchup from Monday, lineups lock daily" — and everything that
 * produced it stays one tap below.
 */
const periodSummary = (draft: League): string => {
	const p = draft.scoring_period
	if (!p || p.kind === null) return "not stated — a rolling week is assumed, and the board says so"
	if (p.kind === "none") return "no periods — scored over the season"
	const days = p.days ? `${p.days}-day ` : ""
	const from = p.starts_on ? ` from ${p.starts_on[0]!.toUpperCase()}${p.starts_on.slice(1)}` : ""
	const lock =
		p.lineup_lock === "daily" ? ", lineups lock daily"
		: p.lineup_lock === "period" ? ", lineups lock for the period"
		: ""
	return `${days}${p.kind}${from}${lock}`
}

const LeagueEditor = ({
	leagueKey,
	league,
	snapshot,
	onSaved,
	onError,
	run
}: {
	leagueKey: string
	league: League
	snapshot: Snapshot | null
	onSaved: (config: Config) => void
	onError: (message: string) => void
	run: (fn: () => Promise<void>) => void
}) => {
	/*
	 * The draft, in a dozen lines where a form library used to be.
	 *
	 * This was `@tanstack/react-form`, and the shipped bundle paid 62 KB of 655 for it —
	 * 9.9%, measured by attributing minified bytes to modules through the sourcemap.
	 * What the library was actually asked for: hold one object, validate it against the
	 * ArkType schema on every change, say whether it differs from what was loaded, and
	 * revert. Not one `<form.Field>` was ever mounted — which is also why TanStack's own
	 * `isDirty` did not work here, and why the dirty check was already a JSON comparison
	 * against the loaded league rather than the library's answer.
	 *
	 * `key={leagueKey}` at the call site means selecting a different league remounts
	 * this editor, so the draft does not need to watch for one.
	 */
	const [draft, setDraft] = useState<League>(league)
	const set = <K extends keyof League>(field: K, value: League[K]): void =>
		setDraft(d => ({ ...d, [field]: value }))

	/** The SAME schema that guards what reaches storage, so the Save button cannot be
	 *  enabled on a league the store would refuse. */
	const invalid = useMemo(() => {
		const out = LeagueSchema(draft)
		return out instanceof type.errors ? out : null
	}, [draft])
	const dirty = JSON.stringify(draft) !== JSON.stringify(league)
	const save = (): void =>
		run(async () => {
			if (invalid) return
			onSaved(leagues.save(leagueKey, draft))
		})

	const raw = (draft.league_rules as { raw_settings?: Record<string, unknown> } | undefined)?.raw_settings

	return (
		<>
			{/* Its own grid, above the scoring one: the team count and the scoring
			    period are the two league-wide facts a ranking turns on that are
			    neither a stat nor a slot, and neither had a field on this page. The
			    board, the draft and the trade page all told you to "open League
			    setup and set the team count" against a page that had no field for
			    it; the streaming week is ranked over whatever period the league
			    states, and a league whose period could not be read off its platform
			    had no way to state one. Kept out of the grid below because that
			    grid's first two cards are batting and pitching, which is what the
			    suites read them as. */}
			<div className="grid">
				<section className="card full">
					<h2>This league</h2>
					{/* Said in baseball. The old version named the arithmetic ("replacement
					    level is teams × slots") and a screen that no longer exists, to somebody
					    filling in a number. What he needs is why the number matters. */}
					<p className="sub">
						The more teams, the thinner the free-agent pool &mdash; and every player here
						is measured against whoever is left at his position once every team has
						filled it. Nothing is ranked until this is set.
					</p>
					<TeamCountInput
						value={draft.meta.max_teams}
						onReject={onError}
						onChange={max_teams => set("meta", { ...draft.meta, max_teams })}
					/>
					{draft.meta.max_teams == null && (
						<p className="empty" style={{ marginTop: "var(--sp-2)" }}>
							Not set. Nothing is assumed in its place, so nothing is ranked.
						</p>
					)}
				</section>

				{/*
				  Folded, because it is derived and almost never edited.
				  
				  The period is read off the league's own settings by
				  `deriveScoringPeriod` and shown back as a form of five controls plus the
				  quoted rows it was read from — 914px of a 6,800px screen, for a value one
				  person corrects once a season if the import got it wrong. The summary
				  states what it resolved TO, which is the only part anybody checks, and
				  the controls are one tap away for the person who has to change it.
				*/}
				<section className="card full">
					<details className="period-fold">
						<summary>
							<h2>Scoring period</h2>
							<span className="sub">{periodSummary(draft)}</span>
						</summary>
						<ScoringPeriodPanel
							draft={draft}
							saved={league.scoring_period}
							snapshot={snapshot}
							onReject={onError}
							onChange={p => set("scoring_period", p)}
						/>
					</details>
				</section>
			</div>

			<div className="grid">
				<section className="card">
					<h2>Batting</h2>
					<p className="sub">Points per stat, as scored by this league.</p>
					<StatTable
						table={draft.scoring.batting}
						side="batting"
						onReject={onError}
						onChange={batting => set("scoring", { ...draft.scoring, batting })}
					/>
				</section>

				<section className="card">
					<h2>Pitching</h2>
					<p className="sub">Negative values are penalties.</p>
					<StatTable
						table={draft.scoring.pitching}
						side="pitching"
						onReject={onError}
						onChange={pitching => set("scoring", { ...draft.scoring, pitching })}
					/>
				</section>

				<section className="card full">
					<h2>Roster slots</h2>
					<p className="sub">{draft.roster.raw ?? "Slot counts for this league."}</p>
					<RosterPanel roster={draft.roster} onReject={onError} onChange={r => set("roster", r)} />
				</section>

				<section className="card">
					<h2>Position eligibility</h2>
					{draft.eligibility?.source && <p className="sub">{draft.eligibility.source}</p>}
					<EligibilityPanel
						eligibility={draft.eligibility}
						onReject={onError}
						onChange={e => set("eligibility", e)}
					/>
				</section>

				<section className="card">
					<h2>Needs review</h2>
					{/* "null" is not a word about baseball, and "the source" is a word about where a
					    program got something. The five `needs_review` strings that named field paths
					    were fixed earlier; this intro line was left behind and says both in one
					    sentence. */}
					<p className="sub">
						Anything your league&rsquo;s own pages did not state is left blank and listed
						here.
					</p>
					{draft.needs_review.length ?
						<ul className="flags">
							{draft.needs_review.map(f => (
								<li key={f}>{f}</li>
							))}
						</ul>
					:	<p className="empty">Nothing outstanding — every value came from the league.</p>}
				</section>

				{raw && Object.keys(raw).length > 0 && (
					<section className="card full">
						<h2>League rules</h2>
						<p className="sub">Verbatim from the league's settings page.</p>
						<details>
							<summary>{Object.keys(raw).length} settings</summary>
							<dl>
								{Object.entries(raw).map(([k, v]) => (
									<Fragment2 key={k} term={k}>
										{String(v)}
									</Fragment2>
								))}
							</dl>
						</details>
					</section>
				)}

				{draft.scoring.unmapped != null && (
					<section className="card full">
						<h2>Unmapped scoring</h2>
						<p className="sub">Kept raw rather than guessed at.</p>
						<pre>{JSON.stringify(draft.scoring.unmapped, null, 2)}</pre>
					</section>
				)}
			</div>

			<div className={dirty ? "savebar on" : "savebar"}>
				<div className="inner">
					<span className="msg">
						{invalid ? `Invalid: ${invalid.summary}` : "Unsaved changes"}
					</span>
					<button onClick={() => setDraft(league)}>Revert</button>
					<button className="primary" disabled={!!invalid} onClick={save}>
						Save
					</button>
				</div>
			</div>
		</>
	)
}
