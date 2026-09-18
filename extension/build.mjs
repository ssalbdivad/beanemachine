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
 *   dist-ext/beanemachine-chrome.zip / -firefox.zip   what a store takes
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
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { basename, dirname, resolve } from "node:path"
import { deflateSync } from "node:zlib"
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
 * 0.2.0 is the first build that marks a swept page as swept, carries the list its sweep set
 * out to get, and refuses an ask it does not know by name instead of going quiet — which is
 * protocol 2.
 */
const VERSION = "0.2.0"

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
				/* MV3 has been generally available in Firefox since 109, but host permissions
				   are only GRANTED at install from 127 — before that they sit ungranted and
				   the reader has to find a checkbox nobody told him about. 128 is the ESR,
				   which is what a cautious install actually runs. */
				strict_min_version: "128.0",
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
			}
		}
	}
}

/**
 * THREE BUNDLES, ONE ENTRY EACH.
 *
 * Content scripts cannot be modules in either browser, so each is built on its own as a
 * self-contained IIFE. A shared chunk between them is not a saving — it is a file neither
 * can import.
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
			minify: false,
			target: "chrome114",
			rollupOptions: { output: { extend: true } }
		}
	})
}

/**
 * THE ICON, DRAWN HERE, BECAUSE BOTH STORES TAKE PNG AND NOTHING ELSE.
 *
 * Three binaries in the repository would be three files that can silently stop matching
 * the wordmark they came from. A PNG is a signature, one IHDR chunk, one deflated block of
 * scanlines and one CRC — so it is written from the same two colours the app uses, at the
 * three sizes the browsers ask for, by the build that ships it.
 *
 * Deliberately a flat mark rather than a scaled-down drawing: at 16px, which is the size
 * that actually appears in a toolbar, anything with a line thinner than two pixels is mud.
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
const chunk = (type, data) => {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const body = Buffer.concat([Buffer.from(type, "ascii"), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(body))
	return Buffer.concat([len, body, crc])
}

/** The app's own ground and ink, the two colours on every screen of it. */
const GROUND = [27, 58, 43]
const INK = [244, 241, 232]

/**
 * @param size   the PNG's own edge, in pixels
 * @param inset  the fraction of that edge left transparent on every side
 *
 * CHROME WANTS THE 128 PADDED AND THE OTHERS NOT. Its store guidance asks for 96x96 of artwork
 * centred in a 128x128 canvas — a sixteenth of the edge, transparent, on each side — because
 * the store draws its own frame around it and a full-bleed icon collides with it. The 16 and
 * the 48 are used in the toolbar and the extensions list, where padding would just make a
 * small icon smaller. Measured on the previous build: alpha 255 at (0, 64), zero transparent
 * columns before ink on row 64, which is the full-bleed shape Chrome asks you not to send.
 */
const iconPng = (size, inset = 0) => {
	const px = (x, y) => {
		const span = 1 - inset * 2
		const u = ((x + 0.5) / size - inset) / span
		const v = ((y + 0.5) / size - inset) / span
		if (u < 0 || u > 1 || v < 0 || v > 1) return [0, 0, 0, 0]
		// a rounded square, so it does not read as a screenshot of a page
		const r = 0.18
		const dx = Math.max(r - u, 0, u - (1 - r))
		const dy = Math.max(r - v, 0, v - (1 - r))
		if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0]
		// two eyes and a smile: the mascot at the only fidelity 16px can hold
		const eye = (cx, cy) => Math.hypot(u - cx, v - cy) < 0.115
		if (eye(0.36, 0.40) || eye(0.64, 0.40)) return [...INK, 255]
		const smile = Math.hypot(u - 0.5, (v - 0.52) * 0.85) 
		if (smile > 0.26 && smile < 0.35 && v > 0.58) return [...INK, 255]
		return [...GROUND, 255]
	}
	const raw = Buffer.alloc(size * (size * 4 + 1))
	let at = 0
	for (let y = 0; y < size; y++) {
		raw[at++] = 0
		for (let x = 0; x < size; x++) {
			const [r, g, b, a] = px(x, y)
			raw[at++] = r
			raw[at++] = g
			raw[at++] = b
			raw[at++] = a
		}
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(size, 0)
	ihdr.writeUInt32BE(size, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // truecolour with alpha
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0))
	])
}

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
	/* 1/16th of the edge on the 128 alone — Chrome's store frames that one. See `iconPng`. */
	for (const size of [16, 48, 128])
		await writeFile(resolve(dir, `icon-${size}.png`), iconPng(size, size === 128 ? 1 / 16 : 0))
	await writeFile(
		resolve(dir, "README.txt"),
		`beanemachine ${VERSION} (${browser})\n\n` +
			(browser === "chrome" ?
				"Open chrome://extensions, turn on Developer mode, press Load unpacked, and choose this folder.\n"
			:	"Open about:debugging#/runtime/this-firefox, press Load Temporary Add-on, and choose the manifest.json in this folder.\n")
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
 * The format is the small one: one local header per file, stored (no compression — these are
 * four small text files and a pair of icons, and DEFLATE would save a few kilobytes at the
 * cost of a second implementation to get wrong), a central directory, an end record. CRC-32
 * is the same table the PNG writer above already needs, which is the reason this is thirty
 * lines rather than a dependency.
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
		const nameBuf = Buffer.from(name, "utf8")
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4) // version needed
		local.writeUInt16LE(0, 6) // flags
		local.writeUInt16LE(0, 8) // stored
		local.writeUInt16LE(time, 10)
		local.writeUInt16LE(date, 12)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(body.length, 18)
		local.writeUInt32LE(body.length, 22)
		local.writeUInt16LE(nameBuf.length, 26)
		local.writeUInt16LE(0, 28)
		locals.push(local, nameBuf, body)

		const dirent = Buffer.alloc(46)
		dirent.writeUInt32LE(0x02014b50, 0)
		dirent.writeUInt16LE(20, 4) // version made by
		dirent.writeUInt16LE(20, 6) // version needed
		dirent.writeUInt16LE(0, 8)
		dirent.writeUInt16LE(0, 10) // stored
		dirent.writeUInt16LE(time, 12)
		dirent.writeUInt16LE(date, 14)
		dirent.writeUInt32LE(crc, 16)
		dirent.writeUInt32LE(body.length, 20)
		dirent.writeUInt32LE(body.length, 24)
		dirent.writeUInt16LE(nameBuf.length, 28)
		dirent.writeUInt32LE(at, 42)
		central.push(dirent, nameBuf)
		at += 30 + nameBuf.length + body.length
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
 * THE 440x280 PROMOTIONAL TILE CHROME ASKS FOR, drawn rather than acquired.
 *
 * It is required for a listing and there was none in this repository. Drawn from the same two
 * colours and the same mascot the icons use, because a tile that does not look like the icon
 * beside it reads as somebody else's add-on — and drawn procedurally for the reason the icons
 * are: an image nobody can regenerate is an image that goes stale the first time the mark
 * changes.
 *
 * No text on it. Chrome overlays the add-on's name and summary on its own store furniture, and
 * a tile carrying a second copy of the name is the commonest reason one is rejected for being
 * cluttered.
 */
const promoPng = (w, h) => {
	const px = (x, y) => {
		const u = (x + 0.5) / h
		const v = (y + 0.5) / h
		/* The mascot, left of centre, at the size the tile can hold. */
		const cx = (w / h) * 0.34
		const eye = (ex, ey) => Math.hypot(u - ex, v - ey) < 0.075
		if (eye(cx - 0.09, 0.42) || eye(cx + 0.09, 0.42)) return [...INK, 255]
		const smile = Math.hypot(u - cx, (v - 0.54) * 0.85)
		if (smile > 0.17 && smile < 0.23 && v > 0.58) return [...INK, 255]
		/* A seam of ink down the right third, so the tile has a shape at thumbnail size. */
		const seam = (w / h) * 0.62
		if (Math.abs(u - seam) < 0.006) return [...INK, 255]
		return [...GROUND, 255]
	}
	const raw = Buffer.alloc(h * (w * 4 + 1))
	let at = 0
	for (let y = 0; y < h; y++) {
		raw[at++] = 0
		for (let x = 0; x < w; x++) {
			const [r, g, b, a] = px(x, y)
			raw[at++] = r
			raw[at++] = g
			raw[at++] = b
			raw[at++] = a
		}
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(w, 0)
	ihdr.writeUInt32BE(h, 4)
	ihdr[8] = 8
	ihdr[9] = 6
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0))
	])
}

const zip = async browser => {
	const dir = resolve(out, browser)
	const file = resolve(out, `beanemachine-${browser}.zip`)
	/* Named rather than walked, so a file nobody meant to ship cannot arrive in the download
	   by having been left in the folder. Every one of these is written a few lines above. */
	const names = ["manifest.json", "background.js", "yahoo.js", "bridge.js", "README.txt",
		"icon-16.png", "icon-48.png", "icon-128.png"].filter(n => existsSync(resolve(dir, n)))
	await writeFile(file, await zipOf(dir, names))
	return file
}

const zips = []
for (const browser of Object.keys(manifests)) {
	const made = await zip(browser)
	if (made) zips.push(made)
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
	await writeFile(resolve(out, "promo-440x280.png"), promoPng(440, 280))
	console.log("promo tile: dist-ext/promo-440x280.png")
}
if (!DEV && zips.length) {
	const web = resolve(here, "..", "public")
	for (const made of zips) await copyFile(made, resolve(web, basename(made)))
	console.log(`copied ${zips.length} zip(s) into public/, which is what the site hands out`)
}

console.log(
	`built ${Object.keys(manifests).join(" and ")} into ${out}` +
		(DEV ?
			" — with the local addresses, which is a build for testing and NOT what goes to a store"
		:	" — hosted site only, which is what goes to a store")
)
if (zips.length) console.log(`zipped: ${zips.map(z => z.replace(`${out}/`, "")).join(", ")}`)
else console.log("no zip was written, which should not happen — the folders are loadable as they are")
