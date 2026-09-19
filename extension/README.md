# The reader

A small add-on for Chrome, Edge and Firefox whose entire job is to read the Yahoo fantasy
page you already have open and hand the text of it to beanemachine.com in the same
browser.

**This page is how to build it, load it and test it.** Why it exists, why it parses
nothing, why the page and the add-on talk by `window.postMessage`, why there are two
manifests, and — the part to read before changing anything — the list of what nobody has
ever verified about it, are all in **[`docs/EXTENSION.md`](../docs/EXTENSION.md)**. The
privacy policy the two stores require is **[`PRIVACY.md`](PRIVACY.md)**, and it is written
to be checkable against the three source files rather than believed.

The one-line version of the why: measured 2026-09-04 with `Origin:
https://beanemachine.com`, `*.fantasysports.yahoo.com` answers with no
`access-control-allow-*` header of any kind, so a web page can never read a league however
politely it asks. A content script inside the reader's own signed-in tab is the one
exception, because it is not a cross-origin request at all.

## Building it

```sh
node extension/build.mjs
```

Writes `dist-ext/chrome/` and `dist-ext/firefox/`, each a complete loadable folder, and
four zips. The build writes the archives itself — it used to shell out to `/usr/bin/zip`
and print "zip not available" on a machine without it, which is this one, so the zips were
built in CI and nowhere else. `dist-ext/` is gitignored; the build is quick and nothing
depends on a committed copy of it.

**Two of the four zips are uploadable and two are not.** `beanemachine-<browser>.zip` is
what the site hands a reader while no listing exists and carries a `README.txt` telling
him to load it unpacked; `beanemachine-<browser>-store.zip` is the same package with that
file removed, because a Chrome Web Store listing may not instruct a reader to install from
outside the Web Store. `extension/SUBMITTING.md` says which goes where.

Three bundles, one entry each, **minified**, each with a four-line banner naming the
repository and the build command — which is all a reviewer can read in a minified file.
Measured 2026-09-19 by `wc -c dist-ext/chrome/*.js`: `yahoo.js` 10,273 bytes,
`background.js` 3,975, `bridge.js` 1,763. Unminified the same three came to 61,833, of
which 57–66% was comment; the source stays commented and the shipped bytes do not carry
the argument. The figure moves whenever `src/data/extension.ts` does — all three entry
points import from it — so re-run the command rather than quoting the number. The icons
are drawn by the build rather than committed as three PNGs that can silently stop matching
the wordmark they came from.

The zip entries are deflated, each entry keeping whichever of stored and deflated is
smaller (a PNG is already compressed and grows). Measured 2026-09-19: the Chrome download
is 8,846 bytes where the stored, unminified archive was 64,973.

`VERSION` at the top of `build.mjs` is bumped by hand. The app reads it out of the
manifest, so the two halves can say which of them is behind rather than "something went
wrong".

## Loading it in Chrome (and Edge)

1. Open **`chrome://extensions`** — on Edge, **`edge://extensions`**.
2. Turn on **Developer mode**. It is the toggle at the top right in Chrome, and in the
   left-hand sidebar in Edge.
3. Press **Load unpacked**.
4. Choose the folder **`dist-ext/chrome`**. Not the `manifest.json` inside it — the folder
   itself.

It stays loaded across restarts. Chrome will show "Loaded unpacked" beside it and may
offer to disable developer-mode add-ons each time it starts; that prompt is about how it
was loaded, not about what it does.

Chrome assigns an unpacked build an id derived from its path, so the id on your machine is
not the id anywhere else. Nothing in this project depends on that id — see
`docs/EXTENSION.md` §4 for why that was a design constraint rather than a happy accident.

## Loading it in Firefox

1. Open **`about:debugging#/runtime/this-firefox`**.
2. Press **Load Temporary Add-on…**.
3. Choose the file **`dist-ext/firefox/manifest.json`**. Firefox asks for the manifest
   here, where Chrome asks for the folder.

**Temporary means temporary**: it is gone when Firefox restarts, and loading it again is
the same three steps. That is Firefox's rule about unsigned add-ons and not something this
build can opt out of — a permanent install has to be signed by Mozilla, and only Developer
Edition and Nightly will install an unsigned one permanently. For day-to-day use on
Firefox, reload it after a restart or use a signed build.

The Firefox manifest sets `strict_min_version: "140.0"`, and `gecko_android` sets 142.0.
It was 128, argued from host permissions — below 127 they are not granted at install, so
the add-on loads and silently cannot read anything. The binding constraint is now the
`data_collection_permissions` key AMO requires of a new submission, which Firefox did not
read until 140 and Firefox for Android until 142. `npx addons-linter` on the built package
says so in those words; see `extension/SUBMITTING.md`.

Each built folder also carries a `README.txt` saying which of these two routes it wants, so
a folder that has been copied somewhere still says how to load itself. It is in the zip the
site hands out and **not** in the `-store` zip, for the reason above.

## Testing it

```sh
node extension/build.mjs        # test/extension.mjs loads dist-ext/chrome, so build first
npm run dev:web                 # the app on :5299, which the suite drives
npm run test:ext                # node --experimental-strip-types test/extension.mjs
```

**189 assertions** against the real unpacked build in a real browser — the number the
suite printed on 2026-09-19 (`passed 189, failed 0`). The block that checks what the
stores receive added 39 of those: the commit before it printed 150 from 145 `t(…)` sites.
It printed 109 on 2026-09-17 at 17:56 and 39 earlier that day; a count in prose goes stale the moment somebody adds a
case, so take the run's own total over this sentence. The `t(…)` call sites in
`test/extension.mjs`: 167 of them, several inside loops over the two built manifests and
the two browsers' packages. Yahoo is served by a local fixture server
and Chromium is told to believe it (`--host-resolver-rules=MAP *.fantasysports.yahoo.com
<port>`), so the pages really are fetched at
`http://baseball.fantasysports.yahoo.com/b1/228947/8`, the match patterns really do decide
whether the content script runs, and the sweep's fetches really are same-origin. Nothing
in the add-on is stubbed. What the fixtures are built from, and what the suite therefore
cannot prove, is `docs/EXTENSION.md` §6 and §8.

Two things worth knowing before you debug a failure:

- **`channel: "chromium"` is load-bearing.** With plain `headless: true` the add-on is not
  loaded at all — `context.serviceWorkers()` comes back empty — and every assertion fails.
- **The suite needs the dev server up.** It drives the real app at `127.0.0.1:5299`; set
  `BASE` to point it somewhere else.

The Firefox build is never loaded by any test. Firefox cannot be driven with an unpacked
add-on from this harness, so what the suite asserts about it is the content of its
manifest and of its package — that its background is an event page and never a service
worker, which is the difference that otherwise fails silently, and that both its zips hold
the seven files a browser needs. What Mozilla itself would say about the package is a
separate check and is not in this suite: `npx addons-linter
dist-ext/beanemachine-firefox-store.zip`, which takes about a minute and needs the
network.

Since 2026-09-19 the suite also opens the built zips and decodes the built PNGs. Nothing
had ever checked what a store actually receives — the zip writer and the icon drawing are
both hand-rolled in `build.mjs`, and the first reader of either was going to be a
reviewer.

## Before publishing

Read **[`SUBMITTING.md`](SUBMITTING.md)**. It has the exact text to paste into each store's
form, which file to upload, and the one command that runs Mozilla's own linter over the
package before you do. The permission justifications are there and in `docs/EXTENSION.md`
§7; the list of what a listing still needs that this repository cannot produce — a
developer account, a fee, a trader declaration — is §8.
