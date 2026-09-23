/**
 * THE EXTENSION API, DECLARED TO THE SURFACE THIS EXTENSION ACTUALLY USES.
 *
 * `extension/src` was outside tsconfig's `include`, so the three files that run inside
 * somebody else's signed-in Yahoo tab were never type-checked: `tsc --listFiles` counted
 * zero files under that directory while `npm run check` reported success. That is the
 * hardest code in this repo to debug once it ships — no console anybody will read, no
 * stack trace that reaches a person, and a store review between a fix and its arrival.
 *
 * WHY NOT `@types/chrome`. It is about 12,000 lines describing an API this extension
 * touches thirteen members of, and every one of those members is listed below, derived
 * by `grep -ho 'chrome\.[a-zA-Z.]*' extension/src/*.ts | sort -u` rather than guessed at.
 * A dependency that large exists to be wrong in ways nobody checks; this file is small
 * enough to read, and if it drifts from Chrome the build still passes and the suite still
 * drives a real browser with a real extension loaded, which is where a wrong shape is
 * actually caught.
 *
 * DELIBERATELY NARROW, AND THAT IS THE POINT. A member not declared here is a compile
 * error rather than an `any`, so reaching for a new part of the API is a decision
 * somebody makes on purpose and writes down, instead of one that happens.
 *
 * `browser` is Firefox's own name for the same object. The bundles are built per browser
 * from one source (see extension/build.mjs) and use `chrome`, which Firefox also provides.
 */
declare namespace chrome {
	namespace runtime {
		/** Set after a callback-style call fails. Reading it is how an orphaned content
		 *  script is told apart from a tab that simply did not answer. */
		const lastError: { message?: string } | undefined
		/** Only the two fields this extension reads. `content_scripts` is read to derive
		 *  the app's own match patterns from the manifest rather than keeping a second
		 *  list in step with it — see `APP_MATCHES`. */
		function getManifest(): {
			version: string
			content_scripts?: { js?: string[]; matches?: string[] }[]
		}
		function sendMessage(message: unknown, respond?: (answer: unknown) => void): void
		const onMessage: {
			addListener(
				fn: (
					message: any,
					sender: { tab?: { id?: number; url?: string } },
					respond: (answer: unknown) => void
				) => boolean | void
			): void
		}
	}
	namespace tabs {
		interface Tab {
			id?: number
			url?: string
			active?: boolean
			windowId?: number
			lastAccessed?: number
		}
		/** Both call shapes, because this extension uses the CALLBACK one: it runs in an
		 *  MV3 service worker that can be stopped between the call and the promise, and a
		 *  callback carries `lastError` with it. */
		function query(info: { url?: string | string[]; active?: boolean }): Promise<Tab[]>
		function query(
			info: { url?: string | string[]; active?: boolean },
			respond: (tabs: Tab[] | undefined) => void
		): void
		function create(info: { url: string; active?: boolean }): Promise<Tab>
		function update(tabId: number, info: { active?: boolean }): Promise<Tab>
		function sendMessage(tabId: number, message: unknown, respond?: (answer: unknown) => void): void
		const onRemoved: { addListener(fn: (tabId: number) => void): void }
		const onActivated: { addListener(fn: (info: { tabId: number; windowId: number }) => void): void }
	}
	/** One member, for one line. `tabs.update({active:true})` selects a tab inside its own
	 *  window and does not raise that window, so the toolbar button did nothing visible for
	 *  a reader keeping Yahoo and the board in two windows — see `action.onClicked`. */
	namespace windows {
		function update(windowId: number, info: { focused?: boolean }): Promise<unknown>
	}
	namespace action {
		const onClicked: { addListener(fn: (tab: tabs.Tab) => void): void }
	}
}
