import { useSyncExternalStore } from "react"

/**
 * When something in this browser changed.
 *
 * Every league, roster, lineup and free-agent list lives in localStorage, and until
 * now the only thing that made a screen notice a write was that the component doing
 * the writing also held the value in React state. That works exactly as far as the
 * component that writes — and no further.
 *
 * Measured: pasting a roster into the first-run setup wrote it correctly, and the
 * Today card went on saying "Add your players and this becomes tonight's lineup"
 * until the page was reloaded. A reader who has just done the one thing the app asked
 * of him, and sees the app go on asking, has been told the app did not work. That is
 * the payoff of the whole onboarding, and it was invisible.
 *
 * So writes announce themselves. One counter, one subscriber list, and a hook that
 * turns it into a render — `useSyncExternalStore` rather than an effect, because a
 * write that happens during the same commit as the read must not be missed, which is
 * exactly the case here: the setup writes and the card beside it re-reads.
 *
 * It is a COUNTER rather than a payload on purpose. The stores are the source of
 * truth and every reader already knows how to read them; what a reader needs is to
 * be told to look again. Anything finer would be a second copy of the data, and two
 * copies is the bug this file exists to end rather than to introduce.
 */
let revision = 0
const listeners = new Set<() => void>()

/** Called by every store that writes. Cheap enough to call on every write. */
export const stored = (): void => {
	revision++
	for (const fire of listeners) fire()
}

const subscribe = (fire: () => void): (() => void) => {
	listeners.add(fire)
	return () => {
		listeners.delete(fire)
	}
}

const snapshot = (): number => revision

/**
 * Re-renders the calling component whenever anything in this browser is written.
 *
 * Deliberately not scoped to one store or one league. The screens here read three or
 * four stores each and a scoped subscription would be four hooks and four chances to
 * forget one; the cost of the broad version is a re-render on a write nobody on this
 * screen cares about, which happens a handful of times in a session.
 *
 * The returned number is meant to be used as a memo dependency, which is what makes
 * a `useMemo` over localStorage correct rather than accidentally correct.
 */
export const useStored = (): number =>
	useSyncExternalStore(subscribe, snapshot, snapshot)

/**
 * The one way into localStorage, and the one sentence said when there isn't one.
 *
 * Reaching localStorage at all throws in a private window, and `setItem` throws when
 * the quota is full. Both are the store failing, so both read as one — which is why
 * every store here goes through a small accessor rather than touching
 * `window.localStorage` where it stands.
 *
 * The problem was that there were FOUR of those accessors, character-for-character
 * identical: roster.ts lines 38-49 before this change, pool.ts 83-94, lineup.ts 36-45
 * and ledger.ts 79-88. With them came four copies of the sentence they throw, and only
 * roster.ts's copy carried the second half — "A private window usually does this." —
 * which is the half that tells the reader what is actually wrong. It is true of all
 * four stores; the other three had simply never been given it. That is how a
 * duplicated string fails: not all at once but one copy at a time, and the docs in
 * this repo have already lost a sentence that way.
 *
 * So the sentence lives here once and takes the noun as an argument. The noun stays
 * the reader's own word for the thing — "a roster", "your lineup", "a record of what
 * was recommended" — because a shared message that degrades to "there is nowhere to
 * keep your data" would be worse than the four copies it replaced. Parameterise the
 * specific part; share the part that must not drift.
 *
 * The ERROR CLASS is an argument rather than one shared class, and the first reason given
 * for that was wrong. The claim was that Boundary.tsx, which prints `error.name` into the
 * text a reader is asked to paste into a bug report, would say "RosterError" against
 * "LedgerError" and so name WHICH store is unreadable. It does not. Every one of the five
 * is `class X extends ApiError {}` (or `extends Error`) with no `name` of its own, so each
 * inherits the plain string "Error" — measured by calling this accessor with no `window`
 * defined, which is the same failure a private window produces:
 *
 *   node --experimental-strip-types --input-type=module -e '
 *     const { storageFor } = await import("./src/client/stores.ts")
 *     const { RosterError } = await import("./src/client/roster.ts")
 *     try { storageFor("a roster", RosterError) } catch (e) { console.log(e.constructor.name, "|", e.name) }'
 *   → RosterError | Error
 *
 * The first value is `constructor.name`, which nothing renders; the second is `name`,
 * which Boundary prints. All five stores answer the same way. So the only thing that tells a reader which store broke is the
 * SENTENCE, and the five sentences differ — which is the argument for parameterising the
 * noun, not for parameterising the class. Whether these classes should set `name` is a
 * real question and a user-facing change; it is not answered here.
 *
 * What does survive as a reason is api.ts. pool.ts deliberately cannot import it — api.ts
 * imports pool.ts, and `extends ApiError` is evaluated at module scope, so the cycle would
 * hit `ApiError` in its temporal dead zone and take the whole bundle down (the note at the
 * top of pool.ts has the detail). An accessor that imported `ApiError` here to throw one
 * shared class would have locked out the one store that could not follow, which is the
 * store with the least in common with the others and the most to gain. Each class also
 * stays declared beside the store it belongs to, so a screen that ever does need to tell a
 * damaged roster from a damaged history has something to catch; today none of them does
 * (`grep -rn 'instanceof RosterError\|instanceof LedgerError' src/` finds nothing — every
 * catch site in Board.tsx and Trade.tsx tests `instanceof ApiError` and shows `e.message`).
 */
/**
 * WHAT THE BROWSER SAID, IN WORDS A READER CAN ACT ON.
 *
 * A storage exception's own text is written for whoever wrote the page: "Failed to execute
 * 'setItem' on 'Storage': Setting the value of 'beanemachine:roster' exceeded the quota."
 * Every store here interpolated that verbatim, so the app's own rule — that nothing a reader
 * sees names a file, a field or a piece of software — was broken by the one class of message
 * he is most likely to meet, on the two screens where he enters his team.
 *
 * The CAUSE survives, because it is the part he can do something about: a full browser is
 * cleared, a private window is left, and a blocked origin is a setting. What goes is the API,
 * the method and the key. An exception nobody here recognises keeps its own words rather than
 * being flattened into "something went wrong", which would be a worse trade: unrecognised and
 * unreadable beats unrecognised and unsaid.
 */
export const saidPlainly = (e: unknown): string => {
	const err = e as { name?: string; message?: string }
	const text = `${err?.name ?? ""} ${err?.message ?? ""}`
	if (/quota|exceeded the quota|QuotaExceeded/i.test(text))
		return "this browser has no room left to save it"
	if (/SecurityError|access is denied|denied for this document/i.test(text))
		return "this browser does not allow saving on this page"
	if (/private|incognito/i.test(text)) return "a private window will not keep anything"
	return err?.message ?? String(e)
}

export const storageFor = (
	keeping: string,
	Fail: new (message: string) => Error
): Storage => {
	try {
		return window.localStorage
	} catch (e) {
		throw new Fail(
			`This browser won't let the page save anything (${saidPlainly(e)}), ` +
				`so there is nowhere to keep ${keeping}. A private window usually does this.`
		)
	}
}
