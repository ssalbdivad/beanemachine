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
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { dirname, resolve } from "node:path"
import { deflateSync } from "node:zlib"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, "../dist-ext")
const run = promisify(execFile)

/** Bumped by hand. The app reads it out of the manifest and can say "update the
 *  extension" rather than "something went wrong" when the two disagree. */
const VERSION = "0.1.0"

const NAME = "beanemachine — read my Yahoo league"
const DESCRIPTION =
	"Reads your own Yahoo fantasy baseball league — your team, your league's scoring and " +
	"who is free — and hands it to beanemachine.com in this browser. Nothing is sent anywhere else."

/**
 * WHERE THE APP LIVES, for the bridge content script.
 *
 * The local ones are here on purpose and stay in the shipped build: this project is a
 * static site somebody can clone and serve, and an extension that only spoke to the
 * hosted copy would be untestable by the person developing it — which is how a bridge ends
 * up shipped broken. Match patterns ignore the port, so one line covers every dev server.
 */
const APP_MATCHES = [
	"https://beanemachine.com/*",
	"https://*.beanemachine.com/*",
	"http://127.0.0.1/*",
	"http://localhost/*"
]

const YAHOO_MATCHES = ["*://*.fantasysports.yahoo.com/*"]

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
	host_permissions: YAHOO_MATCHES,
	content_scripts: [
		{ matches: YAHOO_MATCHES, js: ["yahoo.js"], run_at: "document_idle", all_frames: false },
		{ matches: APP_MATCHES, js: ["bridge.js"], run_at: "document_start", all_frames: false }
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
				strict_min_version: "128.0"
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

const iconPng = size => {
	const px = (x, y) => {
		const u = (x + 0.5) / size
		const v = (y + 0.5) / size
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
	for (const size of [16, 48, 128]) await writeFile(resolve(dir, `icon-${size}.png`), iconPng(size))
	await writeFile(
		resolve(dir, "README.txt"),
		`beanemachine ${VERSION} (${browser})\n\n` +
			(browser === "chrome" ?
				"Open chrome://extensions, turn on Developer mode, press Load unpacked, and choose this folder.\n"
			:	"Open about:debugging#/runtime/this-firefox, press Load Temporary Add-on, and choose the manifest.json in this folder.\n")
	)
}

const zip = async browser => {
	if (!existsSync("/usr/bin/zip")) return null
	const file = resolve(out, `beanemachine-${browser}.zip`)
	await run("zip", ["-qr", file, "."], { cwd: resolve(out, browser) })
	return file
}

const zips = []
for (const browser of Object.keys(manifests)) {
	const made = await zip(browser)
	if (made) zips.push(made)
}

console.log(`built ${Object.keys(manifests).join(" and ")} into ${out}`)
if (zips.length) console.log(`zipped: ${zips.map(z => z.replace(`${out}/`, "")).join(", ")}`)
else console.log("zip not available; the folders are loadable as they are")
