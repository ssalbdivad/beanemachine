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

Writes `dist-ext/chrome/` and `dist-ext/firefox/`, each a complete loadable folder, plus
`beanemachine-chrome.zip` and `beanemachine-firefox.zip` **if `/usr/bin/zip` is present**
— without it the build says "zip not available" and the folders are loadable as they are,
but a store upload needs the zip, so install it before you go to publish. `dist-ext/` is
gitignored; the build is quick and nothing depends on a committed copy of it.

Three bundles, one entry each, unminified. Measured 2026-09-17 at 15:25 by `wc -c
dist-ext/chrome/*.js`: `yahoo.js` 16,573 bytes, `background.js` 10,745, `bridge.js` 2,865.
That figure moves whenever `src/data/extension.ts` does — all three entry points import
from it — so re-run the command rather than quoting the number. The icons are drawn by the
build rather than committed as three PNGs that can silently stop matching the wordmark
they came from.

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

The Firefox manifest sets `strict_min_version: "128.0"`. Below 127 the host permissions
are not granted at install, so the add-on loads and silently cannot read anything.

Each built folder also carries a `README.txt` saying which of these two routes it wants, so
a folder that has been copied somewhere still says how to load itself.

## Testing it

```sh
node extension/build.mjs        # test/extension.mjs loads dist-ext/chrome, so build first
npm run dev:web                 # the app on :5299, which the suite drives
npm run test:ext                # node --experimental-strip-types test/extension.mjs
```

**39 assertions** against the real unpacked build in a real browser — counted 2026-09-17
at 15:25 from the `t(…)` call sites in `test/extension.mjs`: 36 sites, three of them
inside a two-iteration loop over the two built manifests. The suite is grown regularly and
that total was 38 the same afternoon, so take it from a run rather than from here. Yahoo
is served by a local fixture server
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
manifest — that its background is an event page and never a service worker, which is the
difference that otherwise fails silently.

## Before publishing

Both stores refuse a listing that reads page content without a privacy policy, and both
ask for the permission justifications in a text box. Those justifications are written out
ready to paste in `docs/EXTENSION.md` §7, and the list of what a listing still needs that
this repository does not have — screenshots, a promo tile, a padded store icon, a Firefox
manifest key that AMO now requires of new submissions, a developer account — is §8.
