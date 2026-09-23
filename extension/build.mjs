/**
 * ONE SOURCE, TWO BROWSERS.
 *
 * Chrome and Firefox disagree about exactly one thing that matters here — how a background
 * script is declared — and about one thing that matters to their stores: Firefox wants an
 * id it can recognise across updates. Everything else, including the content scripts, the
 * match patterns and the messaging API, is identical, so the difference is confined to the
 * manifest this file writes and nothing in src/ knows which browser it is in.
 *
 * `chrome.*` is used throughout rather than `browser.*` because Chrome does not define
 * `browser` and Firefox does define `chrome`; one global works in both, and the callback
 * style used everywhere works in both as well, where the promise style does not.
 *
 * Output:
 *   dist-ext/chrome/    load this with "Load unpacked"
 *   dist-ext/firefox/   load this with "Load Temporary Add-on"
 *   dist-ext/beanemachine-chrome.zip / -firefox.zip               what the SITE hands out
 *   dist-ext/beanemachine-chrome-store.zip / -firefox-store.zip   what a STORE takes
 *
 * The last two differ from the first two by one file, README.txt, and the reason is written
 * out at `zip` near the foot of this file. It is the difference between a package a reader
 * can act on and a package that tells a Chrome reviewer his listing distributes around him.
 */
import { build } from "vite"
import { appMatches } from "../src/data/extension.ts"
/* The hosts the reader runs on are written from the platform records, not from a constant
   beside them: a platform that needs a reader and is missing from the manifest is a feature
   that silently does nothing, and the failure is invisible because the extension installs
   perfectly and simply never runs anywhere. See `needsReader` in src/data/platforms.ts. */
import { readerMatches } from "../src/data/platforms.ts"
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { basename, dirname, resolve } from "node:path"
import { deflateRawSync } from "node:zlib"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const run = promisify(execFile)

/**
 * TWO THINGS THIS BUILD CAN BE, AND THE DEFAULT IS THE ONE THAT SHIPS.
 *
 * `BM_EXT_DEV=1` adds `http://127.0.0.1/*` and `http://localhost/*` to the pages the bridge
 * is injected into. A match pattern cannot name a port, so in a SHIPPED build those two
 * lines mean any page served from the reader's own machine can ask this extension for his
 * Yahoo league — which is a capability a developer wants and a reader should never be handed
 * without asking. The argument is written out in full at `APP_MATCHES` in
 * src/data/extension.ts.
 *
 * `BM_EXT_OUT` puts the result somewhere other than dist-ext, which is how test/extension.mjs
 * builds both at once: the store build into dist-ext, where the assertions about what each
 * store will accept read it, and a dev build beside it, which is the one the browser loads.
 */
const DEV = process.env.BM_EXT_DEV === "1"

/** Every host a content script reads, from the platform records themselves. */
const READS = readerMatches(DEV)
/*
   AND IT IS NEVER THE REPOSITORY ITSELF.
   
   The first thing this script does is `rm -rf` its output directory. `BM_EXT_OUT=""` resolves
   to the repository root, and an empty environment variable is a normal accident — a shell
   variable that was never set, a CI step whose input was blank. That is a deleted working
   tree, in the first line of a build.
*/
const asked = process.env.BM_EXT_OUT?.trim()
const out = resolve(here, "..", asked || "dist-ext")
if (out === resolve(here, "..") || out === resolve(here))
	throw new Error(
		`BM_EXT_OUT must name a directory of its own; "${process.env.BM_EXT_OUT}" resolves to ` +
			`${out}, which is this project itself and is about to be deleted.`
	)

/**
 * Bumped by hand, and it is the version a READER sees in his browser's list — not the
 * thing the page compares itself against. That is `PROTOCOL` in src/data/extension.ts,
 * which the bridge sends on every hello: "0.1.0 against 0.3.2" is not a question a page can
 * answer, and "speaks 1, needs 2" is.
 *
 * 0.2.0 was the first build that marks a swept page as swept, carries the list its sweep set
 * out to get, and refuses an ask it does not know by name instead of going quiet — protocol 2.
 * 0.3.0 adds `rosters`, the ask that reads every other team in the league — protocol 3.
 *
 * ── THE MINOR NUMBER IS THE PROTOCOL, AND test/extension.mjs ENFORCES IT ──────────────
 *
 * It was 0.2.0 while `PROTOCOL` was 3, and had been since commit 7296c31 bumped the protocol
 * for `rosters` without touching this line. Two different builds therefore shipped as
 * "0.2.0", one of which refuses `rosters` — and the self-hosted update manifest is keyed on
 * this exact string (`updates: [{ version: VERSION, ... }]` near the foot of this file), so
 * Firefox, which only fetches when the advertised version is HIGHER, never offered the newer
 * one to a reader holding the older. Meanwhile both halves told him to go and get it:
 * `protocolSkew` says "Update it in your browser's extensions list", and so do
 * extension/src/yahoo.ts and extension/src/background.ts. It was the one instruction in the
 * product that could not work, which is precisely the failure the protocol number exists to
 * end.
 *
 * The interlock is a rule a hand-bump cannot satisfy by accident: the minor number IS the
 * protocol. Bump `PROTOCOL` to 4 and the suite demands 0.4.x here; there is no table to edit
 * instead and no convention to remember. It is asserted in test/extension.mjs against the
 * BUILT manifest rather than thrown here, so the statement lives beside the other things the
 * two stores are checked for, and one place says what a version is allowed to be.
 *
 * The cost is that the major stays 0 for as long as the rule does. That is the right trade
 * while a hand-bumped string gates whether an update is ever offered; the day this add-on
 * wants a 1.0 is the day the rule is rewritten as "minor OR a recorded table", on purpose,
 * with the suite changed in the same commit.
 */
const VERSION = "0.3.0"

const NAME = "beanemachine — read my Yahoo league"

/**
 * 132 CHARACTERS, BECAUSE CHROME REJECTS 133.
 *
 * `description` has a hard limit in the Chrome Web Store and the one here was 178 — measured
 * on the built manifest — which fails submission rather than being quietly truncated. Firefox
 * has no such limit, and one description for both is worth more than 46 characters: two would
 * be two things to keep true.
 *
 * What was cut is the clause that repeats the other two. It read: "Reads your own Yahoo
 * fantasy baseball league — your team, your league's scoring and who is free — and hands it to
 * beanemachine.com in this browser. Nothing is sent anywhere else." The list of what it reads
 * is on the store page and in PRIVACY.md at length; what a reader cannot get anywhere else in
 * one line is WHOSE league it reads, WHERE the data goes, and that it goes nowhere else.
 */
const DESCRIPTION =
	"Reads your own Yahoo fantasy baseball league and hands it to beanemachine.com in this " +
	"browser. Nothing is sent anywhere else."

/*
   WHERE THE APP LIVES and where Yahoo lives are imported rather than written here, because
   the router needs the same two lists — it has to find an app tab to send progress to — and
   written twice they drift silently: the manifest injects the bridge into a page the router
   will not talk to, and the reader watches a button spin with no words under it. The
   argument for keeping the local addresses in the shipped build is in src/data/extension.ts.
*/

const common = {
	manifest_version: 3,
	name: NAME,
	version: VERSION,
	description: DESCRIPTION,
	/* `tabs` is what lets the router find the Yahoo tab and put the reader back on the
	   app; `storage` is NOT asked for, because nothing is stored — see the note at the top
	   of src/background.ts. A permission nobody uses is a permission somebody has to
	   justify, to a store reviewer and to a reader. */
	permissions: ["tabs"],
	host_permissions: READS,
	content_scripts: [
		{ matches: READS, js: ["yahoo.js"], run_at: "document_idle", all_frames: false },
		{ matches: appMatches(DEV), js: ["bridge.js"], run_at: "document_start", all_frames: false }
	],
	action: { default_title: "Open beanemachine" },
	/* Both stores show this as the developer's website on the listing, and both reviewers
	   follow it. Without it a listing that reads a signed-in site's pages and hands them to
	   `beanemachine.com` offers no way to check that the add-on and the site are the same
	   people — which is the first question this particular add-on invites. It is not a
	   verified-publisher claim and does not pretend to be; see §8 of docs/EXTENSION.md. */
	homepage_url: "https://beanemachine.com",
	/* Both stores read this; it is also the honest floor. MV3 content scripts and
	   `host_permissions` behave the way this code assumes from Chrome 120 on. */
	minimum_chrome_version: "120",
	icons: { 16: "icon-16.png", 48: "icon-48.png", 128: "icon-128.png" }
}

const manifests = {
	chrome: {
		...common,
		/* Chrome MV3 runs the background as a service worker. Firefox does not support
		   `service_worker` AT ALL (bug 1573659) and runs an event page from `scripts`; MDN's
		   own advice is to ship both keys, and before Firefox 121 the mere presence of
		   `service_worker` stopped the background page starting. Two manifests rather than
		   one with both keys, because the two stores also want different minimum-version
		   keys and a single file cannot carry both without each store warning about the
		   other's. */
		background: { service_worker: "background.js" }
	},
	firefox: {
		...common,
		/* Firefox MV3 runs it as an event page and rejects `service_worker`. Same file. */
		background: { scripts: ["background.js"] },
		browser_specific_settings: {
			gecko: {
				/* A stable id so an update replaces the install rather than sitting beside
				   it, and so a temporary install keeps its place. */
				id: "beanemachine@beanemachine.com",
				/**
				 * 140, AND THE KEY BELOW IS THE REASON — NOT HOST PERMISSIONS.
				 *
				 * This was 128, argued from host permissions: MV3 has been generally available
				 * in Firefox since 109, but host permissions are only GRANTED at install from
				 * 127, and 128 was the ESR. That argument is still true and is no longer the
				 * binding one.
				 *
				 * Measured 2026-09-19 by running the tool AMO itself runs, against the built
				 * package: `npx addons-linter dist-ext/beanemachine-firefox-store.zip` at 128.0
				 * returned 0 errors and 2 warnings, both of them
				 * KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION — "strict_min_version requires Firefox
				 * 128, which was released before version 140 introduced support for
				 * browser_specific_settings.gecko.data_collection_permissions", and the same
				 * sentence for Firefox for Android naming 142. So at 128 the key immediately
				 * below is declared to a browser that does not read it: the consent screen
				 * Mozilla now requires would not be shown to anyone on 128..139, which is the
				 * one thing the key exists to guarantee. A floor that silently drops the
				 * disclosure is worse than a floor that excludes an old browser.
				 *
				 * 140 costs nothing in practice: it is itself the current ESR, so "what a
				 * cautious install actually runs" is still included.
				 */
				strict_min_version: "140.0",
				/**
				 * WITHOUT THIS, MOZILLA WILL NOT TAKE THE SUBMISSION AT ALL.
				 *
				 * Since 3 November 2025 a new add-on that does not declare what it collects is
				 * refused at signing with a message saying why. This build has never been
				 * submitted, so it is new.
				 *
				 * `none` is the honest answer, and it is the one this project's own PRIVACY.md
				 * already makes: Mozilla defines the data transmission that triggers disclosure
				 * as data "collected, used, transferred, shared, or handled outside of the
				 * add-on or the local browser", and nothing here leaves the local browser —
				 * Yahoo's page to the add-on to the app's own page to that page's own storage,
				 * all inside the reader's browser, all gone when he uninstalls.
				 *
				 * THE ONE AMBIGUITY, recorded because whoever submits this will meet it: the
				 * app's page is a different ORIGIN from the add-on, and a reviewer taking a
				 * stricter reading could call that "outside the add-on" even though it never
				 * leaves the browser. The definition reads as a union — inside the browser is a
				 * safe harbour whichever page holds it — and no Mozilla text carves out an
				 * exception for a local cross-origin handoff. The conservative alternative is
				 * `["websiteContent"]`, which costs nothing but a scarier consent screen and
				 * would contradict PRIVACY.md's own account of where the data goes. Declaring
				 * `none` is therefore the accurate answer AND the one consistent with the
				 * document a reviewer is pointed at; the alternative is written down here so
				 * that changing it is a decision rather than a discovery.
				 *
				 * `required` must be present; `none` may only appear alone, and never in
				 * `optional`.
				 */
				data_collection_permissions: { required: ["none"] }
			},
			/**
			 * ANDROID HAS ITS OWN FLOOR AND IT IS TWO RELEASES LATER.
			 *
			 * `gecko.strict_min_version` does not set the Android floor; without
			 * `gecko_android`, AMO derives the Android floor from the desktop one. Measured
			 * 2026-09-19 with addons-linter: at 128 the desktop and the Android warnings were
			 * two separate findings, the Android one naming 142 as the release that introduced
			 * `data_collection_permissions` on Android. Raising desktop to 140 alone left the
			 * Android warning standing.
			 *
			 * Android is worth carrying rather than dropping: it is the only route this add-on
			 * has to a phone. Chrome on Android takes no extensions at all and Safari needs a
			 * native wrapper, so a reader with a phone either gets this or types his team in.
			 */
			gecko_android: { strict_min_version: "142.0" }
		}
	}
}

/**
 * THE SOURCE OF THESE BYTES, STAMPED ON THE BYTES.
 *
 * The shipped bundles are minified, so the one question a reviewer or a curious reader has
 * when he opens `yahoo.js` — where did this come from and can I check it — has to be
 * answerable from inside the file. Four lines, 295 bytes on each of three files, against the
 * 46,707 bytes minifying saves.
 *
 * PREPENDED AFTER THE BUILD RATHER THAN PASSED AS `output.banner`, because that does not
 * survive. Measured 2026-09-19, twice: through `rollupOptions.output.banner` the built
 * `yahoo.js` began `(function(){var e=[\`hello\`,` with no banner anywhere in it, as a plain
 * block comment AND as a `/*!` legal comment. Rather than keep guessing at which marker this
 * version of the minifier honours, the bytes are written on after it has finished, where
 * nothing can drop them. It costs one read and one write per bundle.
 */
const BANNER =
	`/*! beanemachine reader ${VERSION} — https://github.com/ssalbdivad/beanemachine\n` +
	`   Source: extension/src/. Built by extension/build.mjs with Vite (Rolldown), minified.\n` +
	`   The build is deterministic: the same commit produces these bytes again.\n` +
	`   Privacy policy: https://beanemachine.com/privacy */\n`

/**
 * THREE BUNDLES, ONE ENTRY EACH.
 *
 * Content scripts cannot be modules in either browser, so each is built on its own as a
 * self-contained IIFE. A shared chunk between them is not a saving — it is a file neither
 * can import.
 *
 * MINIFIED, AND THIS IS A REVERSAL.
 *
 * `minify: false` was deliberate and the argument for it is in docs/EXTENSION.md §2: the
 * whole add-on is small enough that a store reviewer can read all of it. Measured
 * 2026-09-19 on this build, that claim had stopped being about readable code and started
 * being about shipping comments: of `dist-ext/chrome/*.js`, 22,564 of yahoo.js's 39,254
 * bytes were comment (57.5%), 11,057 of background.js's 16,685 (66.3%) and 3,073 of
 * bridge.js's 5,468 (56.2%) — a byte in three going to two stores was a sentence arguing
 * with a decision, and a reviewer who wants the argument wants it beside the code in the
 * repository, not re-downloaded on every update by every reader.
 *
 * Minified: 9,978 + 3,680 + 1,468 = 15,126 bytes against 61,833, a 75.5% cut; with the
 * 295-byte banner on each it is 16,011, a 74.1% cut. Deflated into the package the three
 * come to 6,339 bytes, and the whole Chrome download is 8,846 where it was 64,973 (see the
 * zip writer below). What replaces the
 * comments for a reviewer is three things, all of them stronger than a comment in a
 * bundle: the banner above, naming the repository and the one command that rebuilds it;
 * the AMO source submission, which is required of a bundled add-on whether or not it is
 * minified (SUBMITTING.md, and it is TESTED there rather than asserted); and the fact that
 * the build is deterministic, so anybody can check these bytes byte for byte.
 *
 * Chrome's policy allows minification explicitly and forbids obfuscation; this is the
 * former. No mangling beyond what the minifier does by default, and no sourcemap in the
 * package — a `.map` in the zip is dead weight for every reader to pay for so that one
 * person need not run the build.
 */
const bundle = async (name, entry) => {
	await build({
		configFile: false,
		logLevel: "warn",
		/* Vite copies `public/` into any outDir by default, which put the site's CNAME and
		   logo inside the extension bundle — files that would have shipped to two stores
		   for no reason. */
		publicDir: false,
		build: {
			emptyOutDir: false,
			outDir: resolve(out, "js"),
			lib: { entry: resolve(here, entry), formats: ["iife"], name: `bm_${name}`, fileName: () => `${name}.js` },
			minify: true,
			sourcemap: false,
			target: "chrome114",
			rollupOptions: { output: { extend: true } }
		}
	})
	const file = resolve(out, "js", `${name}.js`)
	await writeFile(file, BANNER + (await readFile(file, "utf8")))
}

/**
 * THE ICONS ARE FILES NOW, NOT CODE. `extension/icons/` holds them and this copies them.
 *
 * They used to be drawn here — a rounded square with two dots and an arc, on the stated theory
 * that 16 px cannot hold a real drawing. It can: `extension/icons.mjs` renders the actual
 * mascot from `public/beanbot.svg`, and at 16 px it still resolves into a navy cap over a pale
 * face. The approximation resolved into a smudge, and the first person to see it in a toolbar
 * said so.
 *
 * The other half of the reason is reproducibility, which is now load-bearing: those PNGs were
 * encoded with `zlib.deflateSync`, whose output depends on the Node version, so the same commit
 * built on two machines produced different zips — and `npm run publish:ext` proves the source
 * archive AMO holds rebuilds the package byte for byte. It cannot prove that about a file whose
 * bytes depend on the builder. Committed artwork is the same everywhere.
 *
 * `crc32` stays because the zip writer below needs it; the PNG encoder that used it is gone.
 */
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	return c >>> 0
})
const crc32 = buf => {
	let c = 0xffffffff
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}
const ICONS = resolve(here, "icons")

await rm(out, { recursive: true, force: true })
await mkdir(resolve(out, "js"), { recursive: true })

await bundle("background", "src/background.ts")
await bundle("yahoo", "src/yahoo.ts")
await bundle("bridge", "src/bridge.ts")

for (const [browser, manifest] of Object.entries(manifests)) {
	const dir = resolve(out, browser)
	await mkdir(dir, { recursive: true })
	for (const f of ["background.js", "yahoo.js", "bridge.js"])
		await cp(resolve(out, "js", f), resolve(dir, f))
	await writeFile(resolve(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
	/* The 128 carries 16 transparent px a side — 96x96 of artwork, which is what Chrome's store
	   frames. That inset lives in extension/icons.mjs; test/extension.mjs measures it here. */
	for (const size of [16, 48, 128])
		await copyFile(resolve(ICONS, `icon-${size}.png`), resolve(dir, `icon-${size}.png`))
	/**
	 * THIS FILE IS TRUE OF THE DOWNLOAD AND FALSE OF THE STORE PACKAGE, so it goes in one zip
	 * and not the other — see `zip` below. It tells a reader to turn on Developer mode and
	 * load an unpacked folder, which is exactly what he must do with a zip he got from
	 * beanemachine.com, and exactly what the Chrome Web Store refuses to let a listing say.
	 */
	await writeFile(
		resolve(dir, "README.txt"),
		`beanemachine ${VERSION} (${browser})\n\n` +
			(browser === "chrome" ?
				"Open chrome://extensions — on Edge, edge://extensions.\n" +
					"Turn on Developer mode, press Load unpacked, and choose this folder.\n"
			:	"Open about:debugging#/runtime/this-firefox, press Load Temporary Add-on, and choose the manifest.json in this folder.\n" +
					"Firefox forgets a temporary add-on when you quit it. Do this again next time, or use Chrome.\n")
	)
}

/**
 * A ZIP, WRITTEN HERE, BECAUSE `/usr/bin/zip` IS NOT EVERYWHERE.
 *
 * This shelled out to `zip` and returned null when the binary was absent — which is the case
 * on the machine this project is developed on, so the zips were built in CI and nowhere else,
 * and nothing that depended on them could be tested before it shipped. That was tolerable
 * while the zips were only a convenience for a store upload. It stopped being tolerable when
 * the site started handing the file to readers: a download link whose file is built by a
 * binary that may not exist is a 404 waiting for the one machine that lacks it.
 *
 * The format is the small one: one local header per file, a central directory, an end record.
 * CRC-32 is the same table the PNG writer above already needs, which is the reason this is
 * forty lines rather than a dependency.
 *
 * DEFLATED, AND THE COMMENT HERE USED TO ARGUE THE OPPOSITE. It read: "stored (no compression
 * — these are four small text files and a pair of icons, and DEFLATE would save a few
 * kilobytes at the cost of a second implementation to get wrong)". Both halves were wrong.
 * Measured 2026-09-19 on the Chrome folder as it stood BEFORE the bundles were minified:
 * 64,169 bytes of payload stored against 24,405 deflated — 62% of the file, not "a few
 * kilobytes", on a file the SITE hands to every reader over a connection it does not choose.
 * And the second implementation is `deflateRawSync`, which is in node:zlib and is the same
 * library the PNG writer three hundred lines above already calls; method 8 is two header
 * fields and a different byte count. On the minified folder the same measurement is 18,437
 * stored against 8,042.
 *
 * PER ENTRY, NOT PER ARCHIVE, because deflate does not always win. The same measurement:
 * icon-16.png went 139 -> 142 bytes and icon-48.png 305 -> 310 — a PNG's IDAT is already
 * deflated and re-compressing it costs the block header. So each entry keeps whichever of the
 * two is smaller and declares the method it actually used. A zip that stores an entry it
 * called deflated is a corrupt zip in every reader on earth, so the method is derived from
 * the bytes chosen rather than set alongside them.
 */
const dosTime = () => {
	/* A fixed timestamp rather than the clock: two builds of the same source should produce
	   the same bytes, so a reader can tell a rebuild from a change. 1 Jan 2020, 00:00. */
	return { time: 0, date: ((2020 - 1980) << 9) | (1 << 5) | 1 }
}

const zipOf = async (dir, names) => {
	const { time, date } = dosTime()
	const locals = []
	const central = []
	let at = 0
	for (const name of names) {
		const body = await readFile(resolve(dir, name))
		const crc = crc32(body)
		/* Level 9 rather than the default 6, and it is very nearly a coin toss: measured
		   2026-09-19 on the minified Chrome folder, 8,042 bytes at 9 against 8,044 at 6. Two
		   bytes. It is 9 because the asymmetry is total — this build runs once on one machine
		   and the file it writes is downloaded by everybody — and not because the number is
		   interesting. Both levels are deterministic, which is the property the fixed
		   timestamp above needs to mean anything. */
		const packed = deflateRawSync(body, { level: 9 })
		/* Strictly smaller, so a tie stores: stored is the form every reader implements
		   without a code path. */
		const deflated = packed.length < body.length
		const payload = deflated ? packed : body
		const method = deflated ? 8 : 0
		const nameBuf = Buffer.from(name, "utf8")
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		/* 20 is "2.0", which is the version that introduced DEFLATE — so it is the right
		   floor for both branches and does not have to move with `method`. */
		local.writeUInt16LE(20, 4) // version needed
		local.writeUInt16LE(0, 6) // flags
		local.writeUInt16LE(method, 8)
		local.writeUInt16LE(time, 10)
		local.writeUInt16LE(date, 12)
		local.writeUInt32LE(crc, 14) // of the UNCOMPRESSED bytes, in both branches
		local.writeUInt32LE(payload.length, 18)
		local.writeUInt32LE(body.length, 22)
		local.writeUInt16LE(nameBuf.length, 26)
		local.writeUInt16LE(0, 28)
		locals.push(local, nameBuf, payload)

		const dirent = Buffer.alloc(46)
		dirent.writeUInt32LE(0x02014b50, 0)
		dirent.writeUInt16LE(20, 4) // version made by
		dirent.writeUInt16LE(20, 6) // version needed
		dirent.writeUInt16LE(0, 8)
		dirent.writeUInt16LE(method, 10)
		dirent.writeUInt16LE(time, 12)
		dirent.writeUInt16LE(date, 14)
		dirent.writeUInt32LE(crc, 16)
		dirent.writeUInt32LE(payload.length, 20)
		dirent.writeUInt32LE(body.length, 24)
		dirent.writeUInt16LE(nameBuf.length, 28)
		dirent.writeUInt32LE(at, 42)
		central.push(dirent, nameBuf)
		at += 30 + nameBuf.length + payload.length
	}
	const dirBytes = Buffer.concat(central)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(names.length, 8)
	end.writeUInt16LE(names.length, 10)
	end.writeUInt32LE(dirBytes.length, 12)
	end.writeUInt32LE(at, 16)
	return Buffer.concat([...locals, dirBytes, end])
}

/**
 * TWO ZIPS PER BROWSER, AND THE DIFFERENCE IS ONE FILE.
 *
 * `beanemachine-<browser>.zip` is what the SITE hands over while no listing exists, and it
 * carries README.txt: sideloading is the only thing that reader can do with it, and once the
 * file is on his disk and the tab is closed, that README is the only instruction he has.
 *
 * `beanemachine-<browser>-store.zip` is what gets UPLOADED, and it must not carry it. A
 * Chrome Web Store listing may not tell a reader to install from outside the Web Store, and a
 * package whose README's first line is "turn on Developer mode, press Load unpacked" tells a
 * reviewer, in writing, that this add-on is distributed around him. That is a rejection, and
 * it is one nothing in this repository would have caught: the file is correct, the manifest
 * is correct, and the zip they are in goes to two readers who need opposite instructions.
 *
 * Two zips rather than one README worded to serve both, because there is no such wording. A
 * store reader has nothing to do after pressing Add; telling him how to load an unpacked
 * folder is at best noise and at worst the sentence that gets the listing pulled.
 *
 * Both are otherwise byte-identical inputs — same manifest, same three bundles, same three
 * icons — and test/extension.mjs asserts that the entry lists differ by README.txt alone, so
 * this cannot quietly become two different add-ons.
 */
const PACKAGE = ["manifest.json", "background.js", "yahoo.js", "bridge.js",
	"icon-16.png", "icon-48.png", "icon-128.png"]

/**
 * THE THIRD FIREFOX PACKAGE, AND WHY IT CANNOT BE THE SAME FILE AS THE OTHER TWO.
 *
 * A SELF-DISTRIBUTED add-on updates itself only if its manifest names an update manifest to
 * poll. Without one, every new version is a reader installing by hand again — which is the
 * thing signing was supposed to end.
 *
 * And that key is REFUSED on a listed submission: AMO rejects `update_url` for an add-on
 * listed on addons.mozilla.org, because there it is AMO's job. So the same manifest cannot
 * serve both routes, and the difference is not cosmetic — one of the two uploads is
 * rejected outright if they are swapped.
 *
 * Hence three Firefox zips, each named for the one thing it is for, all built every time so
 * nobody has to remember a flag:
 *
 *   beanemachine-firefox.zip           the site's download, today's unsigned route
 *   beanemachine-firefox-selfhost.zip  UNLISTED signing — carries update_url
 *   beanemachine-firefox-store.zip     a LISTED submission — must not carry it
 */
const UPDATE_MANIFEST = "https://beanemachine.com/updates.json"
const GECKO_ID = manifests.firefox.browser_specific_settings.gecko.id

const zip = async (browser, { readme, selfhost }) => {
	const dir = resolve(out, browser)
	const file = resolve(
		out,
		`beanemachine-${browser}${selfhost ? "-selfhost" : readme ? "" : "-store"}.zip`
	)
	if (selfhost) {
		/* Written into the folder just long enough to be zipped, then the shared manifest is
		   put back — so the unpacked folder on disk stays the one the other two zips were
		   made from and a developer loading it never gets the self-hosted variant by accident. */
		const shared = await readFile(resolve(dir, "manifest.json"), "utf8")
		const m = JSON.parse(shared)
		m.browser_specific_settings.gecko.update_url = UPDATE_MANIFEST
		await writeFile(resolve(dir, "manifest.json"), `${JSON.stringify(m, null, "\t")}\n`)
		const names = PACKAGE.filter(n => existsSync(resolve(dir, n)))
		await writeFile(file, await zipOf(dir, names))
		await writeFile(resolve(dir, "manifest.json"), shared)
		return file
	}
	/* Named rather than walked, so a file nobody meant to ship cannot arrive in the download
	   by having been left in the folder. Every one of these is written a few lines above. */
	const names = [...PACKAGE, ...(readme ? ["README.txt"] : [])].filter(n =>
		existsSync(resolve(dir, n))
	)
	await writeFile(file, await zipOf(dir, names))
	return file
}

/** The ones the site hands out. Only these are copied into `public/`. */
const zips = []
/** The ones a store takes. Never copied anywhere; SUBMITTING.md names them. */
const uploads = []
/** The one a self-distributed signing takes. Firefox only: Chrome has no unlisted route. */
let selfhostZip = null
for (const browser of Object.keys(manifests)) {
	zips.push(await zip(browser, { readme: true }))
	/* NOT WRITTEN AT ALL BY A DEV BUILD. The dev build injects the bridge into every page
	   served from the reader's own machine (see `DEV` at the top); an upload package built
	   from it would be a store listing that hands a Yahoo league to anything on localhost.
	   An artifact that must never be uploaded is safest as an artifact that does not exist. */
	if (!DEV) uploads.push(await zip(browser, { readme: false }))
	if (!DEV && browser === "firefox") selfhostZip = await zip(browser, { selfhost: true })
}

/*
   THE SITE HAS TO BE ABLE TO HAND IT OVER, because no store has it yet.

   The walkthrough's first step used to point at a store search page. Rendered on
   2026-09-18, the Chrome Web Store returned "It looks like there aren't any search results
   for your search", and the add-on id is a 404 on Mozilla's own API — so the topmost offer
   in the onboarding sheet led every reader to an empty page, with nothing on the screen
   saying so.
   
   Until a listing exists, the honest route is the one a developer already uses: download the
   folder and load it. That only works if the site serves the file, so the store build's zips
   are copied into `public/`, which Vite ships verbatim. They are gitignored — a build
   artifact in the tree is a build artifact that goes stale — and test/static.mjs asserts the
   published site actually serves them, because a download link that 404s is the same defect
   as the store link it replaces.
   
   The DEV build never does this: what a reader downloads must be the build that speaks to
   beanemachine.com alone, never the one carrying local addresses.
*/
/* The listing's own artwork, beside the zips a store takes. Not in `public/`: it belongs to a
   submission, not to the site. */
if (!DEV) {
	await copyFile(resolve(ICONS, "promo-440x280.png"), resolve(out, "promo-440x280.png"))
	console.log("promo tile: dist-ext/promo-440x280.png")
}
if (!DEV && zips.length) {
	const web = resolve(here, "..", "public")
	for (const made of zips) await copyFile(made, resolve(web, basename(made)))
	console.log(`copied ${zips.length} zip(s) into public/, which is what the site hands out`)
}

/*
   THE SIGNED ADD-ON, AND THE ONE INTERLOCK THAT KEEPS IT HONEST.

   Mozilla will sign this add-on without listing it — AMO's self-distribution route, free and
   private — and hand back an .xpi. A SIGNED .xpi installs from an ordinary link: Firefox
   opens its own install panel, there is no about:debugging, no Developer mode, and the add-on
   survives a restart, which `Load Temporary Add-on` does not. That turns the Firefox step of
   the setup sheet from four lines into one press.

   It cannot be built here. It is a file Mozilla returns, so the process is: drop it at
   extension/signed/beanemachine-firefox.xpi, and this copies it into `public/` so the site
   serves it. extension/SUBMITTING.md has the submission steps.

   THE INTERLOCK. The page cannot check whether a file exists, so `FIREFOX_XPI` in
   src/client/Connect.tsx states it, and exactly one of these two mistakes is possible:
   a file nobody links to, or a link to a file that is not there. The second one is a 404 in
   the first step of the walkthrough — the same defect as the store-search page this project
   already shipped once. So the build refuses to be quiet about either.
*/
/*
   THE UPDATE MANIFEST, SO A SIGNED INSTALL IS THE LAST ONE A READER DOES BY HAND.

   `beanemachine-firefox-selfhost.zip` carries `update_url` pointing here. Firefox polls this
   file, compares `version` with what is installed, and fetches `update_link` when it is
   newer — so shipping a new build is: sign it, drop it in, bump VERSION, deploy. Without
   this file a self-distributed add-on never updates at all, and every version is the
   download-and-install dance again.

   WRITTEN EVEN BEFORE THERE IS A SIGNED FILE, because the URL in the manifest has to resolve
   from the moment the first signed copy is installed, and a 404 there is an add-on that
   silently never updates. Until the signed file exists it advertises the version that is
   built, pointing at where the signed file will be; `update_hash` is added only once there
   is a real file to hash, because a wrong hash makes Firefox refuse the update outright.
*/
const signed = resolve(here, "signed", "beanemachine-firefox.xpi")
const signedHere = existsSync(signed)
const linked = /^const FIREFOX_XPI: string \| null = "(.+?)"/m.exec(
	await readFile(resolve(here, "..", "src", "client", "Connect.tsx"), "utf8")
)?.[1]
if (!DEV && signedHere) {
	await copyFile(signed, resolve(here, "..", "public", basename(signed)))
	console.log(`copied ${basename(signed)} into public/ — Firefox installs it in one press`)
}
if (!DEV) {
	const update = {
		addons: {
			[GECKO_ID]: {
				updates: [
					{
						version: VERSION,
						update_link: `https://beanemachine.com/${basename(signed)}`,
						...(signedHere ?
							{
								update_hash: `sha256:${createHash("sha256")
									.update(await readFile(signed))
									.digest("hex")}`
							}
						:	{})
					}
				]
			}
		}
	}
	await writeFile(
		resolve(here, "..", "public", "updates.json"),
		`${JSON.stringify(update, null, "\t")}\n`
	)
	console.log(
		`wrote public/updates.json for ${VERSION}` +
			(signedHere ? " with the signed file's hash" : " — no signed file yet, so no hash")
	)
}
if (!DEV && signedHere && !linked)
	console.log(
		`  ⚠ ${basename(signed)} is published but FIREFOX_XPI in src/client/Connect.tsx is null,\n` +
			`    so the sheet still walks Firefox readers through Load Temporary Add-on.`
	)
if (!DEV && !signedHere && linked)
	throw new Error(
		`src/client/Connect.tsx links Firefox at "${linked}" but ${signed} does not exist. ` +
			`The walkthrough's first step would 404. Add the signed file or set FIREFOX_XPI back to null.`
	)

console.log(
	`built ${Object.keys(manifests).join(" and ")} into ${out}` +
		(DEV ?
			" — with the local addresses, which is a build for testing and NOT what goes to a store"
		:	" — hosted site only, which is what goes to a store")
)
const named = list => list.map(z => z.replace(`${out}/`, "")).join(", ")
console.log(`the site hands out: ${named(zips)}`)
if (uploads.length) console.log(`a store takes: ${named(uploads)} (no README.txt — see \`zip\`)`)
