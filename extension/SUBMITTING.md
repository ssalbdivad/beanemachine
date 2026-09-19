# Submitting the add-on

Everything a store asks for, with the exact text to paste and the file to upload. What is here
is prepared; what is yours is an account, a fee and the press of a button.

Build the packages first, from a clean checkout:

```sh
pnpm install --frozen-lockfile
node extension/build.mjs
```

That writes `dist-ext/`. **Four zips, and only two of them are uploadable:**

| file | what it is |
| --- | --- |
| `dist-ext/beanemachine-chrome-store.zip` | upload this to the Chrome Web Store |
| `dist-ext/beanemachine-firefox-store.zip` | upload this to addons.mozilla.org |
| `dist-ext/promo-440x280.png` | the Chrome promotional tile |
| `dist-ext/beanemachine-chrome.zip` | **not for a store.** What the site hands a reader while no listing exists |
| `dist-ext/beanemachine-firefox.zip` | **not for a store.** The same, for Firefox |

The `-store` pair and the plain pair differ by one file: `README.txt`, which says to turn on
Developer mode and load the folder unpacked. That is the only instruction that works for
somebody who downloaded the zip from beanemachine.com, and it is an instruction a Chrome Web
Store listing may not contain about itself — so it ships in the download and never in the
upload. The reasoning is at `zip` in `extension/build.mjs`; `test/extension.mjs` asserts that
the two packages differ by that file alone and that no file in either `-store` zip contains
the words "Developer mode", "Load unpacked", "Load Temporary Add-on" or "about:debugging".

Screenshots are not built — they are captured from the running site, and how is at the foot of
this file.

### Run Mozilla's linter before either upload

`addons-linter` is the exact tool AMO runs on a submission. It takes about a minute over npx
and needs nothing installed:

```sh
npx addons-linter dist-ext/beanemachine-firefox-store.zip
```

Measured 2026-09-19 on this build: **0 errors, 0 warnings, 0 notices.** The same command
earlier the same day returned 2 warnings, both `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` —
see the Firefox section below for what they were and what fixed them.

**Point it at the Firefox package only.** Run against
`beanemachine-chrome-store.zip` it reports `ADDON_ID_REQUIRED` and
`MISSING_DATA_COLLECTION_PERMISSIONS` — measured 2026-09-19 — which are Firefox's rules
about a manifest that is deliberately not Firefox's. Nothing there is a finding about the
Chrome package. Chrome has no equivalent offline linter; what stands in for one is the
block in `test/extension.mjs` that opens the built zips and decodes the built PNGs.

---

## Both stores ask the same four things first

**Name** — `beanemachine — read my Yahoo league` (35 characters; Chrome's limit is 75.)

**Summary / short description** — the manifest's own, 125 characters against Chrome's hard
limit of 132:

> Reads your own Yahoo fantasy baseball league and hands it to beanemachine.com in this browser. Nothing is sent anywhere else.

`test/extension.mjs` asserts that this blockquote is the string the built manifest carries, so
editing one without the other fails the suite rather than the submission.

**Category** — Sports. **Language** — English (UK or US; the copy is British.)

**Privacy policy URL** — `https://beanemachine.com/privacy`

That page is generated at build time from `extension/PRIVACY.md`, so the document shipped
beside the add-on and the page the listing links to are the same text and cannot drift. It is
written by `extension/privacy-page.mjs` into `public/privacy/index.html`, which Vite publishes.

---

## Chrome Web Store

Upload `dist-ext/beanemachine-chrome-store.zip`.

### Listing

**Detailed description** — paste this:

> beanemachine ranks your Yahoo fantasy baseball league and tells you who to start tonight and
> who to pick up. No website can read a Yahoo league on its own, so this add-on does it in your
> own browser, from the tab you are already signed in to.
>
> Press it once and your team, your league's scoring, the seats you have and who is free on the
> waiver wire all cross over to beanemachine.com, in this browser.
>
> It reads Yahoo fantasy pages only. It sends nothing to any server. It keeps nothing — it has
> no storage permission and no database, and when you remove it there is nothing of yours left
> behind in it.

### Privacy practices tab

- **Single purpose** —
  > Reads the signed-in user's own Yahoo fantasy league pages and hands their contents to
  > beanemachine.com in the same browser, so that site can rank his players.

- **Permission justifications**
  - `tabs` —
    > To find the user's open Yahoo tab so a request from beanemachine.com is sent to the right
    > one, to send a progress line back to the page that asked, and to bring the user back to
    > that page. The add-on asks the browser for tabs matching Yahoo and matching
    > beanemachine.com; it never enumerates the rest.
  - Host permission `https://*.fantasysports.yahoo.com/*` —
    > To read the user's own league pages — his team, his league's settings, his matchup and his
    > league's free-agent list — from inside the tab he is already signed in to. Yahoo serves
    > each sport on its own subdomain, so the pattern covers the fantasy site and nothing else.
  - **Remote code** — No. Everything executed is in the package.

- **Data types collected** — tick **Website content**. Chrome's own policy says this applies
  even when data is processed locally and never transmitted to a server, which is this case.

- **Certifications** — all three are true and PRIVACY.md says so in the same words: the data is
  used only for the single purpose above; it is not sold to third parties; it is not used or
  transferred for creditworthiness or lending.

### The code in the package is minified, and the form asks about that

Chrome's policy allows minification and forbids obfuscation. These bundles are minified by
Vite's own minifier and nothing else is done to them: no mangling beyond the default, no
encoding, no runtime string assembly. Every file opens with four lines naming the repository,
the one command that rebuilds it and the privacy policy URL, so a reviewer who wants the
source has it from inside the file. The build is deterministic — the same commit produces the
same bytes, which is how the reproduction below is checked.

Measured 2026-09-19: 61,833 bytes of unminified bundle became 16,011, and the package went
from 64,973 bytes to 8,624.

### Artwork

- **Icon** — in the package (`icon-128.png`, 96×96 of artwork centred in 128×128 with 16 px of
  transparency on each side, which is the shape Chrome asks for; asserted in
  `test/extension.mjs` by decoding the PNG and taking the bounding box of what is opaque).
- **Promotional tile, 440×280** — `dist-ext/promo-440x280.png`, full bleed.
- **Screenshots, 1280×800** — see the foot of this file. At least one, at most five.

### What Chrome will probably ask about

The add-on reads a signed-in site's pages and hands the content to a different origin. That is
the shape a reviewer looks hardest at. The answer is in PRIVACY.md and is checkable in four
files: every network call asks for a PATH, not an address (`samePath` in `src/yahoo.ts`), so
nothing can leave the tab it was read in; the only recipient is the page the user is standing
on; and there is no storage permission, no server and no analytics. If they ask, send them the
policy URL and that grep rather than a paragraph.

---

## Firefox (addons.mozilla.org)

Upload `dist-ext/beanemachine-firefox-store.zip`.

### The one thing that is different, and it is not the manifest

**AMO requires a source-code submission when the uploaded files are generated or minified.**
Ours are both. Upload the repository as the source and give the build instructions below.

**These instructions were followed, in a clean directory, on 2026-09-19, and the result was
compared byte for byte against `dist-ext/firefox/`: manifest.json, background.js, yahoo.js,
bridge.js and all three icons were identical, and so was
`beanemachine-firefox-store.zip` itself.** That is the point of the fixed timestamp in the zip
writer and of `minify` being a setting rather than an environment: a reviewer who runs this
gets the same bytes he was sent, and can say so.

Make the source zip from the tracked tree rather than by zipping the working directory — that
is what keeps `node_modules/`, `dist/` and `dist-ext/` out of it, and it is reproducible:

```sh
git archive --format=zip HEAD -o beanemachine-source.zip
```

Paste these as the build instructions:

> Node 24 or newer (built and checked on Node 25.2.1) and pnpm 10. From the unpacked source:
>
>     pnpm install --frozen-lockfile
>     node extension/build.mjs
>
> The reviewed files are `dist-ext/firefox/`, and `dist-ext/beanemachine-firefox-store.zip`
> is the uploaded package rebuilt. `extension/build.mjs` is the whole build: it bundles three
> entry points from `extension/src/` with Vite 8 (whose bundler is Rolldown) as three
> self-contained IIFEs, minifies them, prepends a four-line provenance banner, writes both
> manifests from `src/data/extension.ts` and `src/data/platforms.ts`, draws the icons and the
> promotional tile procedurally as PNGs, and writes the zips. No step fetches anything, and
> the build is deterministic: the zip entries carry a fixed timestamp, so the same commit
> produces the same archive.
>
> `pnpm install` runs a `prepare` script that builds an unrelated command-line bundle
> (`dist-cli/`). It is harmless and nothing the add-on uses comes from it; `pnpm install
> --frozen-lockfile --ignore-scripts` skips it and the add-on still builds. Both were run on
> 2026-09-19 and gave the same bytes.

It says **Vite, not esbuild.** This file said esbuild until 2026-09-19 and esbuild has never
been installed in this project — `pnpm ls` resolves `vite@8.2.2` onto `rolldown@1.2.6`. A
reviewer following the old text would have looked for a tool that is not in the lockfile.

### Manifest

`browser_specific_settings` carries what AMO requires of a new submission since 2025-11-03:

```json
{
  "gecko": {
    "id": "beanemachine@beanemachine.com",
    "strict_min_version": "140.0",
    "data_collection_permissions": { "required": ["none"] }
  },
  "gecko_android": { "strict_min_version": "142.0" }
}
```

**The floors are set by the key above them, not by host permissions.** `strict_min_version`
was `128.0`, argued from host permissions being granted at install only from Firefox 127.
Measured 2026-09-19, `npx addons-linter` on the built package returned 0 errors and two
warnings at that floor: `data_collection_permissions` was introduced in Firefox **140** and in
Firefox for Android **142**, so at 128 the declaration would have been ignored by every
browser from 128 to 139 — the consent screen Mozilla now requires would simply not have been
shown. 140 is itself the current ESR, so the original argument ("the version a cautious
install runs") still holds. With both floors set the linter is silent.

`none` is the accurate declaration: Mozilla defines the data transmission that triggers
disclosure as data handled "outside of the add-on or the local browser", and nothing here
leaves the local browser. The argument, and the conservative alternative if a reviewer takes a
stricter view of the cross-origin handoff, are written into `extension/build.mjs` beside the
key.

### Listing

Name, summary, category and privacy policy URL as above. AMO's description field takes the same
detailed description.

**Firefox for Android** — worth ticking, and `gecko_android` above is what makes it truthful.
It is the only route this add-on has to a phone: Chrome on Android takes no extensions at all,
and Safari needs a native wrapper. Nothing in the code is Android-specific.

---

## Screenshots

Captured from the published build rather than mocked, so what a reader sees on the listing is
what the site does. With the preview running (`npm run build && npm run preview`, which serves
`dist` on 4173):

```sh
node extension/shots.mjs
```

It writes 1280×800 PNGs into `dist-ext/store/`:

1. `1-tonight.png` — the card that answers who to start
2. `2-pickups.png` — the ranked board
3. `3-my-league.png` — where a league lives in the browser
4. `4-walkthrough.png` — **only once a listing exists.** While `IN_STORE` in
   `src/client/Connect.tsx` is `false`, the setup sheet shows the sideload route — Developer
   mode, Load unpacked, choose the folder — which is the right screen for the reader the site
   serves today and a screenshot a Chrome listing may not carry. `shots.mjs` reads the words
   on the rendered screen and refuses to write the file when they are those words, printing
   what it skipped and why. Flip `IN_STORE` and run it again for the fourth shot.

It seeds a real team from the committed capture so the screens show the product working; it
touches nothing in the repository.

---

## What is left that only you can do

- A Chrome Web Store developer account and its one-time registration fee.
- An addons.mozilla.org account. Free.
- A trader / non-trader declaration on Chrome's dashboard.
- Pressing submit, and answering whatever comes back.

Everything above this line is in the repository and rebuilds from `node extension/build.mjs`.
