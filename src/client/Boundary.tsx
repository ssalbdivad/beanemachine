import { Component, type ErrorInfo, type ReactNode } from "react"

/**
 * What the reader sees when something throws.
 *
 * Until this existed the answer was a white page. React unmounts the whole tree on
 * an uncaught render error, so any one of the twenty-odd components below could take
 * the site down to nothing — and one of them did: `roster.of` throws on a store it
 * cannot parse, deliberately, and reading it from a card during render turned a
 * corrupt localStorage key into a blank screen with no way out and nothing to
 * report. A blank page is the worst possible failure for a site somebody opened to
 * make a decision, because it looks like the site is gone rather than like something
 * went wrong.
 *
 * The recovery offered is the one that actually works. Almost everything this app
 * keeps lives in this browser — leagues, rosters, seats, the carried free-agent
 * list — and a store that cannot be parsed will throw again on every reload,
 * forever, until it is cleared. So the button clears them, and says exactly what it
 * is about to delete first: a recovery that quietly destroys a team somebody typed
 * in by hand is not a recovery.
 *
 * The error text is shown rather than swallowed. There is no error reporting service
 * behind this and adding one would send a stranger's league to a third party, so the
 * reader is the only person who can report it and he needs something to paste.
 */
interface State {
	error: Error | null
	stack: string | null
}

/** Everything this app keeps in the browser, in one place, because the recovery has
 *  to name what it removes and a list that drifts would understate it. */
const STORES = [
	"beanemachine:config",
	"beanemachine:roster",
	"beanemachine:lineup",
	"beanemachine:pool",
	"beanemachine:view",
	"beanemachine:draft"
]

export class Boundary extends Component<{ children: ReactNode }, State> {
	state: State = { error: null, stack: null }

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error }
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// the component stack is the half that says WHERE, and React only hands it over
		// here — `getDerivedStateFromError` never sees it
		this.setState({ stack: info.componentStack ?? null })
		console.error(error, info.componentStack)
	}

	render() {
		const { error, stack } = this.state
		if (!error) return this.props.children
		return (
			<main className="boundary">
				<h1>beanemachine broke</h1>
				<p>
					Something threw while drawing the page, so the rest of it stopped. This is a
					bug, not something you did wrong.
				</p>
				<pre className="boundary-error">
					{error.name}: {error.message}
					{stack ? `\n${stack.trim()}` : ""}
				</pre>
				<p>
					<a href="https://github.com/ssalbdivad/beanemachine/issues/new" target="_blank" rel="noreferrer">
						Report it
					</a>{" "}
					with that text, and it will be fixed.
				</p>
				<h2>If it keeps happening</h2>
				<p>
					Everything this app knows is kept in this browser, and a stored value it
					cannot read will throw again on every reload until it is removed. Clearing
					takes away <b>your leagues, your roster, your seats and any free-agent list
					you carried in</b> — a team you typed in by hand is gone and would have to be
					entered again. Nothing on your fantasy platform is touched.
				</p>
				<button
					type="button"
					className="chip-btn"
					onClick={() => {
						try {
							for (const k of STORES) window.localStorage.removeItem(k)
						} catch {
							// a browser refusing storage is why we are here on some paths; the
							// reload is still worth attempting
						}
						window.location.reload()
					}}
				>
					Clear what this site stored, and reload
				</button>
				<p className="boundary-soft">
					Or just <button type="button" className="linkish" onClick={() => window.location.reload()}>reload</button>{" "}
					first — a one-off failure will not come back.
				</p>
			</main>
		)
	}
}
