/**
 * PREPARING A RELEASE OF BOTH ADD-ONS: `npm run publish:ext`
 *
 * Not an uploader. Nothing here has credentials and nothing here talks to a store — the
 * upload is four presses on two websites and it is the one part that should stay deliberate.
 * What this does is every mechanical step around it, and it REFUSES rather than warns,
 * because each of these has a failure that is invisible until a reviewer finds it:
 *
 *   · a dirty tree. `git archive` reads HEAD, not the working directory, so uncommitted
 *     work is silently absent from the source archive — and the source a reviewer rebuilds
 *     then does not match the package he was sent. Nothing about that is visible from the
 *     dashboard. It is the first check for that reason.
 *   · the wrong linter flags. `addons-linter` assumes Mozilla hosting, so the self-hosted
 *     package reports one error — `update_url` is not allowed for a listed add-on — which is
 *     exactly the key route A exists to carry. Run without `--self-hosted` it reads as a
 *     broken package; run WITH it on the listed package it would hide a real finding. Both
 *     are run, each with its own rule.
 *   · a source archive that does not rebuild. This unzips it into an empty directory,
 *     installs, builds, and compares all three uploadable packages byte for byte against the
 *     ones on disk. That is what a reviewer does, so it is what this does, and a release
 *     where it fails is a release that would come back.
 *
 * The version is read, never written: bumping it is a commit with a reason in it, not a flag
 * on a script. If the version has not moved, AMO refuses the upload and says so, which is the
 * right place for that to be caught.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const run = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: "pipe", ...opts })
const die = (why, fix) => {
	console.error(`\n✗ ${why}\n  ${fix}\n`)
	process.exit(1)
}
const skipVerify = process.argv.includes("--skip-verify")

/* ── 1. the tree, because the archive is made from HEAD ─────────────────────────────── */
const dirty = run("git", ["status", "--porcelain"]).trim()
if (dirty)
	die(
		`the working tree has uncommitted changes, and \`git archive\` reads HEAD:\n\n${dirty
			.split("\n")
			.map(l => `      ${l}`)
			.join("\n")}`,
		"Commit them first, or the source archive will not match what you upload."
	)
const commit = run("git", ["rev-parse", "--short", "HEAD"]).trim()

/* ── 2. build ───────────────────────────────────────────────────────────────────────── */
console.log("building…")
run("node", ["extension/build.mjs"], { stdio: "inherit" })
const VERSION = /const VERSION = "(.+?)"/.exec(readFileSync(resolve(here, "build.mjs"), "utf8"))[1]

/* ── 3. the linter AMO itself runs, with each package's own rule ────────────────────── */
const lint = (zip, self) => {
	const out = (() => {
		try {
			return run("npx", ["addons-linter", ...(self ? ["--self-hosted"] : []), `dist-ext/${zip}`])
		} catch (e) {
			return `${e.stdout ?? ""}${e.stderr ?? ""}`
		}
	})()
	const errors = Number(/errors\s+(\d+)/.exec(out)?.[1] ?? "?")
	console.log(`  ${zip}${self ? " --self-hosted" : ""}: ${errors} errors`)
	if (errors !== 0)
		die(`${zip} does not pass the linter AMO runs`, out.split("\n").slice(-25).join("\n"))
}
console.log("\nlinting the two Firefox packages, each under its own hosting rule…")
lint("beanemachine-firefox-store.zip", false)
lint("beanemachine-firefox-selfhost.zip", true)

/* ── 4. the source archive a store asks for ─────────────────────────────────────────── */
const source = resolve(root, "beanemachine-source.zip")
run("git", ["archive", "--format=zip", "HEAD", "-o", source])
console.log(`\nsource archive: ${(statSync(source).size / 1e6).toFixed(2)} MB from ${commit}`)

/* ── 5. and the proof that it rebuilds what you are about to upload ─────────────────── */
const UPLOADS = [
	"beanemachine-firefox-selfhost.zip",
	"beanemachine-firefox-store.zip",
	"beanemachine-chrome-store.zip"
]
if (skipVerify) console.log("\n⚠ --skip-verify: the source archive was NOT rebuilt and compared.")
else {
	console.log("\nrebuilding from the source archive in a clean directory (a minute or two)…")
	const tmp = mkdtempSync(resolve(tmpdir(), "bm-src-"))
	try {
		run("unzip", ["-q", source, "-d", tmp])
		run("pnpm", ["install", "--frozen-lockfile"], { cwd: tmp })
		run("node", ["extension/build.mjs"], { cwd: tmp })
		const differs = UPLOADS.filter(z => {
			const a = resolve(tmp, "dist-ext", z)
			const b = resolve(root, "dist-ext", z)
			return !existsSync(a) || Buffer.compare(readFileSync(a), readFileSync(b)) !== 0
		})
		if (differs.length)
			die(
				`the source archive does not rebuild: ${differs.join(", ")}`,
				"A reviewer who follows the build instructions would get different bytes."
			)
		console.log(`  all ${UPLOADS.length} uploadable packages rebuilt byte for byte ✓`)
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
}

/* ── 6. what is left, which is the part with a human in it ──────────────────────────── */
const signed = resolve(here, "signed", "beanemachine-firefox.xpi")
const linked = /^const FIREFOX_XPI: string \| null = "(.+?)"/m.exec(
	readFileSync(resolve(root, "src", "client", "Connect.tsx"), "utf8")
)?.[1]

console.log(`\n────────  version ${VERSION}, commit ${commit}  ────────`)
console.log(`
ROUTE A — Firefox, signed and self-hosted
  1. addons.mozilla.org/developers → Submit a New Add-on → "On your own"
  2. upload   dist-ext/beanemachine-firefox-selfhost.zip
  3. source   beanemachine-source.zip   (yes to the generated/minified question)
     build instructions: extension/SUBMITTING.md, "Source code"
  4. save the signed .xpi to extension/signed/beanemachine-firefox.xpi
  5. set FIREFOX_XPI in src/client/Connect.tsx, then npm run build && npm run test:all

ROUTE B — the stores
  Chrome    upload dist-ext/beanemachine-chrome-store.zip   + dist-ext/promo-440x280.png
            screenshots in dist-ext/store (npm run shots)
  Firefox   upload dist-ext/beanemachine-firefox-store.zip  (listed; "On this site")
  then set CHROME_LISTING / FIREFOX_LISTING to the listing's own URL, not a search`)

console.log(
	`\nFirefox install route today: ${
		linked ? `one press — the site serves ${linked}`
		: existsSync(signed) ? "STILL THE FOUR-STEP SIDELOAD — the signed file is here but FIREFOX_XPI is null"
		: "the four-step sideload — no signed file yet, so step 4 above is the next thing"
	}`
)
console.log("\nRun `npm run test:all` before pushing. Nothing here uploaded anything.\n")
