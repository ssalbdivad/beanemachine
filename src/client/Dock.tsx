import { useEffect, useRef } from "react"

/**
 * The setup, hovering, so the ranking is the first thing on the page.
 *
 * The setup card used to sit above the board on a first visit. That is the
 * conventional shape and it is the wrong one here, because it asks for two minutes
 * of typing from somebody who has not yet seen a single number — and the numbers are
 * the entire argument for typing. A stranger who scrolls past a form to reach a
 * ranked list has already decided the list is the point; a stranger who meets the
 * form first mostly leaves.
 *
 * So the board is the page and this is a bar across the bottom of it: always there,
 * never in the way, one line until it is asked for. Collapsed it says what is
 * borrowed and offers the way out of it; open it is the whole setup in a sheet that
 * scrolls on its own, over a page the reader can still see.
 *
 * Three things it has to get right, all of them learned from bars like this being
 * done badly:
 *
 *  · It must not cover the last rows. The page reserves its height in `app.css`
 *    rather than the bar overlaying whatever happens to be at the foot.
 *  · It must be escapable without hunting. Escape closes it, and so does the button
 *    that opened it.
 *  · It must not trap the page's scroll. The sheet scrolls inside itself and the
 *    board goes on scrolling behind it, because "let me look at that again" is the
 *    commonest thing a reader does halfway through deciding.
 */
export const Dock = ({
	open,
	onToggle,
	summary,
	children
}: {
	open: boolean
	onToggle: (next: boolean) => void
	/** The one line the bar shows when it is closed. Says what is borrowed, because
	 *  that is the fact that makes the button worth pressing. */
	summary: React.ReactNode
	children: React.ReactNode
}) => {
	const sheet = useRef<HTMLDivElement>(null)
	const bar = useRef<HTMLButtonElement>(null)
	/** Whether the sheet has ever been open in this session, so the first render does
	 *  not steal focus onto the bar from wherever the reader actually is. */
	const wasOpen = useRef(false)

	// Escape closes it. Bound on the document rather than on the sheet so it works
	// wherever focus happens to be — a reader who has clicked into the board behind
	// it still expects Escape to dismiss the thing on top.
	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onToggle(false)
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [open, onToggle])

	/*
	 * Opening it puts focus inside, so a keyboard reader is where the content is and not
	 * still on the bar behind it — and CLOSING it puts focus back on the button that did
	 * the closing, which is the half that was missing.
	 *
	 * Measured on the published build: with the sheet open, focus was on `.dock-sheet`;
	 * after Escape, `open` went false and focus was on `<body>`. A screen reader's
	 * position resets to the top of the document from there, and nothing announces that
	 * the sheet has gone. The next Tab happened to reach the bar button, but only because
	 * the sheet was the last thing before it in DOM — luck rather than design.
	 */
	useEffect(() => {
		if (open) {
			wasOpen.current = true
			sheet.current?.focus()
		} else if (wasOpen.current) bar.current?.focus()
	}, [open])

	/*
	 * BACK CLOSES THIS SHEET, AND THE SHAPE THAT WOULD NOT IS WHY THE PUSH IS NOT IN HERE.
	 *
	 * This file used to carry the defect: nothing in the app pushed a history entry, so with
	 * the sheet open and eighteen lines typed, Back went to about:blank. On a phone Back is
	 * how people dismiss a keyboard and undo a tap.
	 *
	 * Measured on the dev server at 390x844 as it now stands: open the bar, type two names,
	 * press Back — the sheet closes, the address stays on `#tonight`, and reopening the bar
	 * gives both lines back. Escape does the same and also leaves the address alone.
	 *
	 * THE PUSH BELONGS TO THE GESTURE, NOT TO AN EFFECT, and that is the whole reason it is
	 * in `go` in src/client/App.tsx rather than here. The obvious shape is an effect keyed on
	 * `open` that pushes an entry on open and pops it in its cleanup. It passes against the
	 * production build and fails against the dev server, which is the tell: `StrictMode`
	 * double-invokes effects in development, so the sequence is setup, CLEANUP, setup — and a
	 * cleanup that calls `history.back()` fires `popstate`, which closes the sheet the moment
	 * it opens. An effect whose teardown navigates cannot be idempotent, and idempotent is
	 * exactly what React requires. React does not double-invoke an event handler, so the same
	 * two calls made from the bar button and from Escape are safe. `go` names this note as
	 * the shape it is avoiding; do not move the push back in here.
	 */

	return (
		<aside className={`dock${open ? " on" : ""}`} aria-label="Set up your league">
			{/*
			  Which layer the reader is on, said in the only way a phone has room to say it.
			  
			  Measured complaint from a stranger's walk: with the sheet up, the board behind
			  it was at full contrast and the tabs above it were live, so nothing on screen
			  distinguished "I am still answering this" from "I am done, close it". The walk
			  itself is six gestures and under three seconds, so the flow is not the problem
			  — knowing where you are in it is.
			  
			  The answer is NOT to make this a modal. The board has to stay readable and
			  scrollable while the reader decides, for the reason in the note at the top of
			  this file, and `aria-modal` stays false because the page behind really is still
			  his to use. So the page is DIMMED rather than taken away, and the dim takes no
			  pointer events at all — which is what keeps "let me look at that again" working
			  with a finger, and is why this is not also a tap-to-dismiss target. Escape and
			  the Close button are the ways out, both of them already here.
			*/}
			{open && <div className="dock-scrim" aria-hidden="true" />}
			{/*
			  MOUNTED WHILE CLOSED, and hidden — because unmounting threw away what he typed.
			  
			  This was `{open && <div …>}`, so closing the sheet unmounted everything inside
			  it and React discarded the state with it. Measured: eighteen lines typed, press
			  Close (or Escape, or now Back), reopen — an empty box. On a phone that is two
			  minutes of typing gone to the gesture people use to dismiss a keyboard.
			  
			  `hidden` rather than `display:none` in CSS, because `hidden` also takes it out
			  of the accessibility tree and out of the tab order, which is what a closed sheet
			  owes a screen reader. The focus effect above keys on `open`, not on mounting, so
			  it is unaffected.
			*/}
			<div
				className="dock-sheet"
				id="dock-sheet"
				ref={sheet}
				tabIndex={-1}
				role="dialog"
				aria-modal="false"
				aria-label="Set up your league"
				hidden={!open}
			>
				{children}
			</div>
			<div className="dock-bar">
				<p className="dock-say">{summary}</p>
				<button
					type="button"
					ref={bar}
					className={open ? "" : "primary"}
					aria-expanded={open}
					/* `aria-expanded` with nothing to point at is half a claim: the button said
					   a region was expanded and never said which, and reading forward from it
					   went to the page footer because the sheet is rendered BEFORE the bar in
					   DOM — measured tab order from inside the open sheet was textarea →
					   summary → Close → footer link, so the sheet is unreachable from its own
					   trigger. The id makes the relationship explicit, which is what lets a
					   screen reader jump to it regardless of where it sits. */
					aria-controls="dock-sheet"
					onClick={() => onToggle(!open)}
				>
					{/* Named for the first thing the sheet asks. It said "Who's on my team" while
					    the sheet opened on the team box; the sheet opens on "Where's your
					    league?" now (src/client/Onboard.tsx), so a button naming the team
					    promised a question that is two screens in. */}
					{open ? "Close" : "Set up my league"}
				</button>
			</div>
		</aside>
	)
}
