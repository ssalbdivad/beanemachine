# Submitting the add-on

Everything a store asks for, with the exact text to paste and the file to upload. What is here
is prepared; what is yours is an account, a fee and the press of a button.

Build both packages first, from a clean checkout:

```sh
pnpm install --frozen-lockfile
node extension/build.mjs
```

That writes `dist-ext/`, and the three things a submission uses:

| file | what it is |
| --- | --- |
| `dist-ext/beanemachine-chrome.zip` | the Chrome package |
| `dist-ext/beanemachine-firefox.zip` | the Firefox package |
| `dist-ext/promo-440x280.png` | the Chrome promotional tile |

Screenshots are not built — they are captured from the running site, and how is at the foot of
this file.

---

## Both stores ask the same four things first

**Name** — `beanemachine — read my Yahoo league` (35 characters; Chrome's limit is 75.)

**Summary / short description** — the manifest's own, 125 characters against Chrome's hard
limit of 132:

> Reads your own Yahoo fantasy baseball league and hands it to beanemachine.com in this browser. Nothing is sent anywhere else.

**Category** — Sports. **Language** — English (UK or US; the copy is British.)

**Privacy policy URL** — `https://beanemachine.com/privacy`

That page is generated at build time from `extension/PRIVACY.md`, so the document shipped
beside the add-on and the page the listing links to are the same text and cannot drift. It is
written by `extension/privacy-page.mjs` into `public/privacy/index.html`, which Vite publishes.

---

## Chrome Web Store

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

### Artwork

- **Icon** — in the package (`icon-128.png`, 96×96 of artwork inside 128 with transparent
  padding, which is the shape Chrome asks for).
- **Promotional tile, 440×280** — `dist-ext/promo-440x280.png`.
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

### The one thing that is different, and it is not the manifest

**AMO requires a source-code submission when the uploaded files are generated or minified.**
Ours are bundled with esbuild through Vite, so the zip alone is not enough. Upload the
repository as the source, and give these as the build instructions:

> Node 24. From a clean checkout:
>
>     pnpm install --frozen-lockfile
>     node extension/build.mjs
>
> The reviewed files are `dist-ext/firefox/`. `extension/build.mjs` is the whole build: it
> bundles three entry points from `extension/src/` with esbuild via Vite, writes the manifest
> from `src/data/extension.ts` and `src/data/platforms.ts`, draws the icons procedurally, and
> zips the folder. No step fetches anything.

### Manifest

`browser_specific_settings.gecko` already carries what AMO requires of a new submission since
2025-11-03:

```json
{
  "id": "beanemachine@beanemachine.com",
  "strict_min_version": "128.0",
  "data_collection_permissions": { "required": ["none"] }
}
```

`none` is the accurate declaration: Mozilla defines the data transmission that triggers
disclosure as data handled "outside of the add-on or the local browser", and nothing here
leaves the local browser. The argument, and the conservative alternative if a reviewer takes a
stricter view of the cross-origin handoff, are written into `extension/build.mjs` beside the
key.

### Listing

Name, summary, category and privacy policy URL as above. AMO's description field takes the same
detailed description.

**Firefox for Android** — worth ticking. It is the only route this add-on has to a phone:
Chrome on Android takes no extensions at all, and Safari needs a native wrapper. The manifest
is already compatible; nothing is Android-specific.

---

## Screenshots

Captured from the published build rather than mocked, so what a reader sees on the listing is
what the site does. With the preview running (`npm run build && npm run preview`, which serves
`dist` on 4173):

```sh
node extension/shots.mjs
```

It writes four 1280×800 PNGs into `dist-ext/store/`:

1. `1-tonight.png` — the card that answers who to start
2. `2-pickups.png` — the ranked board
3. `3-my-league.png` — where a league lives in the browser
4. `4-walkthrough.png` — the four-step install, which is the one that tells a reviewer what the
   add-on is for

It seeds a real team from the committed capture so the screens show the product working; it
touches nothing in the repository.

---

## What is left that only you can do

- A Chrome Web Store developer account and its one-time registration fee.
- An addons.mozilla.org account. Free.
- A trader / non-trader declaration on Chrome's dashboard.
- Pressing submit, and answering whatever comes back.

Everything above this line is in the repository and rebuilds from `node extension/build.mjs`.
