# The reader

A small add-on for Chrome, Edge and Firefox whose entire job is to read the Yahoo
fantasy page you already have open and hand the text of it to beanemachine.com in the
same browser.

It exists because of one measurement and one loophole in it. Measured 2026-09-04 with
`Origin: https://beanemachine.com` against the exact pages `src/import.ts` reads,
`*.fantasysports.yahoo.com` answers with no `access-control-allow-*` header of any kind
— so the browser will not hand a response from Yahoo to a script running on
beanemachine.com, whatever the response contains and however politely it is asked for.
That is a fact about Yahoo and no amount of client code changes it.

What it does not decide is what the *reader's own browser* can do outside that page. A
content script injected into his Yahoo tab is that tab: signed in as him, subject to his
cookies, making no cross-origin request at all. It reads the page he is looking at, and
it asks Yahoo for more only when he presses a button. That is the whole trick, and it is
the reason this directory exists rather than a proxy on somebody's server.

## What it reads

Three things, all of them the reader's own, none of them without him.

- **The page he has open**, as `document.body.innerText` plus the URL. A team page is
  his roster, a settings page is his league's scoring, slots and team count. One press
  fetches both, because a team page carries no scoring table and a settings page carries
  no roster, and telling him after one press that the app still does not know how his
  league scores is asking him to press it twice.
- **The player table**, as the page's own HTML rather than its text, for the free-agent
  sweep only. `parsePage` in `src/data/yahoo-pool.ts` reads `data-ys-playerid` and each
  row's `title=`, neither of which survives `innerText`, and the id is what makes a free
  agent the same man as a player in the snapshot rather than a name that might be two
  people. A roster page is about 400 KB of markup against about 4 KB of text and is sent
  as text for that reason.
- **Nine positions, one at a time**, on a second press, with a quarter-second between
  them: `C, 1B, 2B, 3B, SS, OF, Util, SP, RP`, unioned into one pool. Slowly, because
  commit `de44045` records Yahoo answering a faster sweep with 150 players, then 25,
  then 0, then the string "Request denied". A throttle is reported to the app as a
  throttle; it is never quietly returned as a short league.

It runs on `*://*.fantasysports.yahoo.com/*`, which is Yahoo's fantasy host for every
sport it runs — the sport is read back out of the subdomain (`sportFrom` in
`src/data/extension.ts`), and the app is what decides whether a page is a baseball page
worth anything. It also runs on beanemachine.com and on `localhost` / `127.0.0.1`, where
it is the half that talks to the app; the local origins stay in the shipped build on
purpose, because an add-on that only speaks to the hosted copy cannot be tested by the
person changing it, which is how a bridge ends up shipped broken.

## What it never does

- **It parses nothing.** It hands over a URL and a page's text; `src/data/yahoo-read.ts`
  runs that through `leagueFromPastedSettings`, `rosterFromPaste` and `parsePage` — the
  same three parsers a *pasted* page goes through, with the same tests behind them. The
  reason is release latency: an add-on update waits on a store review while the site
  redeploys in a minute, and Yahoo restyles on its own schedule, so the parser has to
  live on the side that can be fixed today.
- **It stores nothing.** `storage` is not among its permissions. The only thing it holds
  between messages is which tab has Yahoo in it, so it knows which tab to ask.
- **It opens no tabs by itself.** An add-on that quietly opened somebody's fantasy site
  because a web page asked it to is doing something he did not ask for and cannot tell
  apart from a page doing it to him. With no Yahoo tab open it says so, and the app
  shows him a button that opens one — a tab he sees appear because he pressed something.
- **It sends nothing to any server.** Not to beanemachine's API, which has no part in
  this route and is never told the league exists, and not anywhere else. The only
  requests it makes are to Yahoo, from the reader's own signed-in browser, for pages he
  could click through himself.
- **It watches nothing.** Every read is a reply to a request he started.

Its permissions are `tabs` — so the background half can find the Yahoo tab and put him
back on the app — and host access to `*.fantasysports.yahoo.com`. That is the whole list,
and it is short on purpose: a permission nobody uses is a permission somebody has to
justify, to a store reviewer and to a reader.

## Building it

```sh
node extension/build.mjs
```

Writes `dist-ext/chrome/` and `dist-ext/firefox/`, each a complete loadable folder, plus
`beanemachine-chrome.zip` and `beanemachine-firefox.zip` if `/usr/bin/zip` is present
(without it the build says so and the folders are loadable as they are). `dist-ext/` is
gitignored; the build is quick and nothing depends on a committed copy of it.

One source, two manifests, and the difference is one key. Chrome MV3 runs the background
as a `service_worker`; Firefox does not support that key at all and runs an event page
from `scripts`. Firefox is pinned at `128.0`, which is the ESR: MV3 has been available
there since 109, but host permissions are only *granted* at install from 127, and before
that they sit ungranted with nothing telling the reader why nothing works. The icons are
drawn by the build rather than committed as three PNGs that can silently stop matching
the wordmark they came from.

## Loading it in Chrome (and Edge)

1. Open **`chrome://extensions`** — on Edge, **`edge://extensions`**.
2. Turn on **Developer mode**. It is the toggle at the top right in Chrome, and in the
   left-hand sidebar in Edge.
3. Press **Load unpacked**.
4. Choose the folder **`dist-ext/chrome`**. Not the `manifest.json` inside it — the
   folder itself.

It stays loaded across restarts. Chrome will show "Loaded unpacked" beside it and may
offer to disable developer-mode add-ons each time it starts; that prompt is about how it
was loaded, not about what it does.

## Loading it in Firefox

1. Open **`about:debugging#/runtime/this-firefox`**.
2. Press **Load Temporary Add-on…**.
3. Choose the file **`dist-ext/firefox/manifest.json`**. Firefox asks for the manifest
   here, where Chrome asks for the folder.

**Temporary means temporary**: it is gone when Firefox restarts, and loading it again is
the same three steps. That is Firefox's rule about unsigned add-ons and not something
this build can opt out of — a permanent install has to be signed by Mozilla, and only
Developer Edition and Nightly will install an unsigned one permanently. For day-to-day
use on Firefox, reload it after a restart or use a signed build.

Each built folder also carries a `README.txt` saying which of these two routes it wants,
so a folder that has been copied somewhere still says how to load itself.

## Testing it

```sh
node extension/build.mjs        # test/extension.mjs loads dist-ext/chrome, so build first
npm run dev:web                 # the app on :5299, which the suite drives
node test/extension.mjs
```

19 assertions against the real unpacked build in a real browser. Yahoo is served by a
local fixture server and Chromium is told to believe it
(`--host-resolver-rules=MAP *.fantasysports.yahoo.com <port>`), so the pages really are
fetched at `http://baseball.fantasysports.yahoo.com/b1/228947/8`, the match patterns
really do decide whether the content script runs, and the sweep's fetches really are
same-origin. Nothing in the add-on is stubbed.

It covers: the handshake and the version, one press bringing back two pages, the team
page arriving as text rather than as 400 KB of markup, the league's own scoring on both
sides of the ball, the team count, nine seats with the men in them, a nine-position
sweep that asks Yahoo nine times rather than ninety and asks for the top of each list,
the pool being the union across positions (27 men, not one page counted nine times), and
a throttle reported as a throttle.

Two things the suite found that reading the code would not have. `channel: "chromium"`
is load-bearing: with plain `headless: true` the add-on is not loaded at all —
`context.serviceWorkers()` comes back empty — and every assertion fails. And a page that
loads *after* the add-on cannot hear a hello that was already said, which is every page
a reader returns to after installing, so the page asks for one.

## What is not verifiable here

- **That Yahoo's live pages still look like the fixtures.** The fixtures are built from
  shapes this repository measured off the real site — `test/ownership.mjs` for the
  player table, `test/settings.mjs` for the settings page — but a redesign tomorrow is
  invisible to this suite. That is an argument for the app parsing rather than the
  add-on, not against the test.
- **That a signed-in private league reads the same way.** There is no Yahoo account in
  CI and scraping somebody's real league to run a test is not on. The cookie path — a
  content script's fetch carrying the tab's own session — is exercised structurally by
  the same-origin requests in the suite, and whether Yahoo serves a *private* league's
  markup identically to a public one is untested here.
- **The store install.** Loading unpacked, above, is the route this repository can
  actually verify; a store listing is reviewed and published by somebody else, and
  nothing in this directory can assert one exists. The app's own walkthrough
  (`src/client/Connect.tsx`) links to each browser's store and names the buttons there,
  which is where a reader who did not clone this repository goes.
- **How Yahoo throttles a real account.** `de44045` measured 150 → 25 → 0 → "Request
  denied" against the reference league from a server. The quarter-second spacing and the
  one-position-at-a-time sweep are set from that measurement; whether they are *enough*
  from a signed-in browser has not been measured over a long session, and the honest
  statement is that the throttle is detected and reported rather than avoided.
