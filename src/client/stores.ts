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
