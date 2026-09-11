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

	// Opening it puts focus inside, so a keyboard reader is where the content is and
	// not still on the bar behind it.
	useEffect(() => {
		if (open) sheet.current?.focus()
	}, [open])

	return (
		<aside className={`dock${open ? " on" : ""}`} aria-label="Set up your league">
			{open && (
				<div
					className="dock-sheet"
					ref={sheet}
					tabIndex={-1}
					role="dialog"
					aria-modal="false"
					aria-label="Set up your league"
				>
					{children}
				</div>
			)}
			<div className="dock-bar">
				<p className="dock-say">{summary}</p>
				<button
					type="button"
					className={open ? "" : "primary"}
					aria-expanded={open}
					onClick={() => onToggle(!open)}
				>
					{open ? "Close" : "Set up my league"}
				</button>
			</div>
		</aside>
	)
}
