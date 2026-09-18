# The browser reader — how it works, and what nobody has checked

This is the maintainer's account of the thing in `extension/`. `extension/README.md` is
the page that tells you how to build it and load it; this is the page that tells you why
it is shaped the way it is, and — the part that matters most and is at the bottom under
[What is not verified](#what-is-not-verified) — what this repository has never been able
to check about it.

Read that last section before you change anything. **No real Yahoo page has ever been
read by this code.** Every assertion behind it fires against a fixture, and the fixtures
are reconstructions of shapes measured earlier in this repository rather than captures of
the live site.

---

## 1. Why there is an extension at all

Measured 2026-09-04, with `Origin: https://beanemachine.com`, against the exact pages
`src/import.ts` reads: `*.fantasysports.yahoo.com` answers with **no
`access-control-allow-*` header of any kind**. The browser therefore refuses to hand any
of those responses to a script running on beanemachine.com, whatever the response
contains and however politely it is asked for. That is a fact about Yahoo's servers. No
amount of client code changes it, and this app's whole design — everything is *told* to
it, by typing, pasting or carrying a file — follows from it.

The loophole is not in the header. It is that **a content script injected into the
reader's own Yahoo tab is that tab**: same origin, his cookies, his session, no
cross-origin request anywhere. It reads the page he is already looking at, and it asks
Yahoo for more only when he presses a button. That is the whole trick, and it is why this
is an extension rather than a proxy on somebody's server — a proxy would need his
credentials, would be a second place his league lives, and would be the app reading Yahoo
rather than him.

The alternative considered and rejected was a server-side reader with the reader's
session cookie. It was rejected on three counts, in order of how much they mattered:
asking a reader to hand over a Yahoo session cookie is asking for the keys to his whole
Yahoo account and not just fantasy; the requests would come from one datacentre IP for
every reader, which is the shape of traffic Yahoo throttles (see §6); and it would make a
static site into a service with an outage surface.

---

## 2. The three scripts

One source tree, three entry points, no shared chunk between them — content scripts
cannot be ES modules in either browser, so `extension/build.mjs` builds each as its own
self-contained IIFE.

Measured 2026-09-17 at 15:25 by `node extension/build.mjs && wc -c dist-ext/chrome/*.js`:
`yahoo.js` 16,573 bytes, `background.js` 10,745, `bridge.js` 2,865 — 30,183 bytes in
total, unminified. **Take that as a snapshot and re-run the command rather than quoting
it.** The same figure was 12,278 / 5,790 / 2,865 = 20,933 bytes twenty minutes earlier in
the same session; `src/data/extension.ts`, which all three entry points import from, was
being extended while this was written. What the number is for is the order of magnitude:
the whole add-on is tens of kilobytes of unminified source, small enough that a store
reviewer can read all of it, and that is deliberate (§3).

### `extension/src/yahoo.ts` — the half inside Yahoo

Runs on `*://*.fantasysports.yahoo.com/*`, at `document_idle`, top frame only. It is the
only code in the project that can see a Yahoo page, and it answers exactly three
questions, each of them a reply to something the reader pressed:

- **`page`** — `document.body.innerText` and `location.href` of the tab he has open, and
  nothing else.
- **`league`** — that page, plus one fetch of `/b1/<id>/settings` and one of
  `/b1/<id>/matchup`, both reduced to text inside the content script. One press, three
  pages, because a team page carries a roster and no scoring table, a settings page
  carries a scoring table and no roster, and a reader told after one press that the app
  still does not know how his league scores has been asked to do the same thing twice.
- **`pool`** — the free-agent sweep: nine fetches of `/b1/<id>/players?pos=…`, one
  position at a time, 250 ms apart, stopping at the first wall. Each page is cut to its
  rows by `rowsOnly` (§3) and marked `swept: true`, which is what lets `poolIsPartial`
  tell a nine-position sweep that returned four positions from a reader who happened to be
  standing on the shortstop page. This is the only ask that costs Yahoo more than the page
  the reader already has open, and it is the only one behind a button of its own.

An ask it does not recognise is **refused by name** (`isKnownAsk`) rather than falling
through the listener. Falling through returns `false`, which closes the reply channel,
which the page reports as a lost connection — sending a reader to reload the one thing
that is already newest. See "different clocks" in §5.

Two details in it are load-bearing and easy to undo by accident.

**Every fetch is a path, never an absolute URL.** `pageUrl` in `src/data/yahoo-pool.ts`
builds `https://<sport>.fantasysports.yahoo.com/…` because the Node reader in
`src/auto/` has no origin of its own to be relative to. A content script does have one,
and fetching the absolute form turns a same-origin request into a cross-origin one the
moment the tab's scheme is not the one baked into the string. `samePath()` strips it back
to `pathname + search`. Same-origin is what sends the reader's cookies without asking for
a single extra permission; get this wrong and the sweep silently reads a signed-out
Yahoo.

**A wall arrives as a 200.** Yahoo does not answer a throttle with a status code; it
answers with a page whose words say no. `THROTTLED` and `SIGN_IN` in `yahoo.ts` are the
same two regular expressions `src/auto/roster.ts` uses against the same site, kept
character-identical on purpose so both readers call the same page the same thing. They are
tested against *text*, not HTML, and the text has to come through `renderedText`, whose
script- and style-stripping runs **before** its tag-stripping. That ordering is
load-bearing: strip only tags and the contents of every inline script survive into the
text, and a Yahoo page's head contains the literal string `login.yahoo.com` — which
`SIGN_IN` matches. The reader would be told to sign in to the page he was already signed
in to, and the read refused for a wall that was never there. A throttle read the other way
— as an empty league — is the single most expensive way this feature can fail: it would
tell a reader nobody is available in his league.

### `extension/src/background.ts` — the half that knows which tabs exist

The app's page and the Yahoo page are two different tabs and cannot speak to each other.
This is the only piece with a view of both. It routes a question from one to the other and
routes the answer back.

It keeps one thing between messages: a `Map` of which tab ids have a Yahoo fantasy page in
them, learned from the content script announcing itself rather than by polling. A stale
entry is discovered the moment it is used — `tabs.sendMessage` to a closed tab fails, and
that failure is reported to the reader as "no Yahoo tab", not as an error.

**It opens no tab by itself.** An extension that quietly opened somebody's fantasy site
because a web page asked it to is doing something he did not ask for and cannot tell apart
from a page doing it to him. With no Yahoo tab open it says so, and the app shows a button
that opens one — a tab he sees appear because he pressed something.

**It stores nothing.** `storage` is not among the permissions. An extension holding a copy
of somebody's league would be a second place his data lives, with its own lifetime, its
own staleness and its own uninstall story. The app already has stores built for this, in
his browser, stamped with when each was read.

What it does hold, in memory, for as long as the browser is open: `lastSeen` in the router
(a tab number and a timestamp), and in each Yahoo tab `reading`/`readingSince` (whether a
read is running there) and `spent` (the times of that tab's requests in the last minute,
which is what the per-minute ceiling is counted from). None of it is a copy of anything of
his, none of it survives a restart, and PRIVACY.md sets out all three by name — a document
that says "it keeps nothing" while the code keeps three things is the kind of sentence this
project treats as a defect.

### `extension/src/bridge.ts` — the half inside beanemachine

A content script on the app's own origin, at `document_start`, top frame only. It is a
wire: it forwards the page's questions to the background and the background's answers
back. It reads nothing from the page and has no opinion about any of it.

It says hello more than once, and the reason is a bug the integration suite found rather
than one anybody reasoned out. **A page that loads after the extension cannot hear a hello
that was already said** — which is every page a reader returns to after installing. So the
bridge says hello on load, on `DOMContentLoaded`, on `focus` and on `visibilitychange`;
the page can also *ask* for one (`ask: "hello"`, answered locally, never leaving the
browser); and — the belt to those braces — the bridge stamps
`data-beanemachine-extension="<version>"` on `<html>`. An attribute survives a reload. A
message does not. `extensionHere()` in `src/client/extension.ts` reads that attribute
synchronously during a first render, which is what lets the app avoid printing "no website
can read your Yahoo league" to a reader for whom it is false.

---

## 3. Why the extension is a retriever and not a parser

Everything the extension hands over is a URL and the text of a page. The **app** decides
what any of it means, in `src/data/yahoo-read.ts`, using `leagueFromPastedSettings`,
`rosterFromPaste` and `parsePage` — the same three parsers the paste box has used all
along, with the same tests behind them.

The reason is release latency, and it is the single most important decision in this
directory. **An extension update waits on a store review. The app is a static site that
redeploys in a minute.** Yahoo restyles its pages on its own schedule and has done so at
least once in this project's lifetime. Put the parser in the extension and the day Yahoo
moves a column is the day every reader is broken until somebody else's review queue
clears. Put it in the app and it is fixed before lunch.

Three consequences follow, and all three are worth keeping:

- **The permission justifications get short.** There is no model of a league inside the
  add-on, nothing stored a reader would care about, and nothing to explain beyond "it
  reads your fantasy pages and hands them to the site". See §7.
- **A pasted page and a read page go down the same road.** `readGrabs` is handed text that
  arrives exactly the way a paste arrives, so the tests covering the paste box cover the
  extension's output too, and a bug fixed for one is fixed for both.
- **Nothing that arrives is trusted.** It is parsed by parsers written to be handed a
  stranger's HTML, because that is what they have always been handed.

The one exception is the player table, and it is a real exception rather than a
compromise. `parsePage` reads `data-ys-playerid` and each row's `title=` attribute,
neither of which survives `innerText`, and the id is what makes a free agent *the same
man* as a player in the snapshot rather than a name that might belong to two people. So
players pages — and only players pages — travel as markup. Every other page is sent as
text. The size argument is secondary but real: a roster page was measured in this
repository at roughly 400 KB of markup against roughly 4 KB of text, and the 400 KB would
buy nothing.

`rowsOnly` in `src/data/extension.ts` cuts a swept players page down to its rows before it
crosses `postMessage`, and it is the one piece of code in the add-on that looks at Yahoo's
markup at all — so it is worth being precise about why it is not a parser. It keeps, for
each of `parsePage`'s own row markers, exactly the span `parsePage` would have read (the
marker plus `parsePage`'s own 9,000-character per-row cap) and throws the rest away. It
reads no value, knows nothing about a player, and cannot change what the app decides any
row means; what comes back therefore parses to the identical rows *by construction*, and
`test/extension.mjs` asserts that equality against the fixture rather than taking the
argument's word for it. Its marker is duplicated from `parsePage` rather than imported,
because importing would pull the parser into the shipped add-on and undo the whole split
— and the duplication fails in the only direction that is safe: if Yahoo moves the marker,
nothing matches, `rowsOnly` returns null, and the caller sends the entire page exactly as
before. **A redesign costs bandwidth here and can never cost a row.** That is the only
shape of optimisation that belongs on the side of the wire that cannot be fixed until a
store review says so.

---

## 4. Why `window.postMessage` and not `externally_connectable`

The other way for a web page to talk to an extension is the `externally_connectable`
manifest key plus `chrome.runtime.sendMessage`, with the page naming a fixed extension id.

It was not taken, for two reasons in the same direction.

**Firefox does not implement it.** [Bug
1319168](https://bugzilla.mozilla.org/show_bug.cgi?id=1319168), "Implement
externally_connectable from a website", has been open since 2016 and is still open;
MDN's own page for the key records that in Firefox neither `runtime.connect` nor
`runtime.sendMessage` are available to a web page. Half the target browsers would need a
second mechanism anyway, and the second mechanism is the one below.

**An unpacked build has a different id on every machine.** The id Chrome assigns an
unpacked extension is derived from its path, so the id on a maintainer's laptop is not
the id in CI is not the id a store assigns. The page would have to carry a list of ids
per browser per build channel, and the day that list is wrong the feature is dead with no
error anybody can read.

A content script injected into beanemachine's own origin needs none of it: it is
*already in the page*, so the two halves talk by `window.postMessage` exactly as two
scripts on one page do, and one source file works in both browsers.

The cost of that choice, stated plainly because it is the thing a store reviewer will ask
about: **any script running on an origin the bridge matches can ask the extension to read
the reader's Yahoo pages.** Those origins are `https://beanemachine.com` and
`https://*.beanemachine.com` in the build that ships. They USED to include
`http://localhost` and `http://127.0.0.1`, and that is why this paragraph is here: a match
pattern cannot name a port, so those two meant any page served from the reader's own machine
on any port — and on a developer's machine there is usually something listening that he did
not write. They survive as `BM_EXT_DEV=1`, which is how `test/extension.mjs` builds the copy
it drives, and are not in the store build.
Three checks narrow it as far as this design can: `event.source !== window` rejects
anything from an iframe, `event.origin !== location.origin` rejects another window posting
in, and `all_frames: false` means an iframe embedded in the app's own page never gets the
bridge at all. What it does not do is authenticate the *script* within a page it trusts,
because nothing in the web platform lets it. The honest framing is that the extension
trusts the app's origin the way it trusts the reader, and that the blast radius of a
compromise of that origin includes his Yahoo fantasy pages. It does not include his Yahoo
account: the content script's reach is `*.fantasysports.yahoo.com` and nothing wider, and
mail, photos and finance are not on that host.

The local origins are NOT in the shipped build, and this paragraph used to say they were —
four lines under a paragraph that said the opposite, in the direction that makes the
add-on sound worse than it is. `appMatches(dev)` (src/data/extension.ts) adds
`http://127.0.0.1/*` and `http://localhost/*` only when `BM_EXT_DEV=1`, and that build goes
to `dist-ext/dev`, which is the one `test/extension.mjs` loads. The store build beside it
speaks to `beanemachine.com` and nothing else.

The same split now covers Yahoo. The content script is injected on
`https://*.fantasysports.yahoo.com/*` in a shipped build; the plaintext form is added only
by the dev build, because the test serves a fake Yahoo over http on 127.0.0.1 and points
the browser's resolver at it. Yahoo itself answers over http with a 200 rather than a
redirect, so `*://` was a capability rather than a formality: it let the reader run on a
page a network could have written, on the host whose cookies it then sends with every
fetch it makes.

---

## 5. Two manifests, one source

`extension/build.mjs` writes `dist-ext/chrome/manifest.json` and
`dist-ext/firefox/manifest.json` from one object with one key different.

Chrome MV3 runs the background as `background.service_worker`. **Firefox does not support
that key at all** — [bug
1573659](https://bugzilla.mozilla.org/show_bug.cgi?id=1573659), a meta bug still marked
NEW and unassigned as of its 2026-01-17 update — and runs an event page from
`background.scripts` instead.

The failure mode is what makes this worth a manifest of its own rather than one file
carrying both keys: **ship Chrome's key to Firefox and the add-on installs, appears in
the list, and never runs a line of background code.** No router, no answer to any question
the page asks, and nothing on screen saying why. It is silent. That is why
`test/extension.mjs` ends with a block that reads both built manifests off disk and
asserts the two backgrounds are the two different shapes — the Chromium run can only ever
prove one of the two builds, so the other one is protected by an assertion about the file
rather than by a browser.

The Firefox manifest also carries `browser_specific_settings.gecko`:

- `id: "beanemachine@beanemachine.com"` — a stable id, so an update replaces the install
  rather than sitting beside it.
- `strict_min_version: "128.0"` — not 109. MV3 has been generally available in Firefox
  since 109, but **host permissions are only granted at install from 127**; before that
  they sit ungranted, with nothing telling the reader why nothing works. 128 is the ESR,
  which is what a cautious install actually runs.

`chrome.*` is used throughout rather than `browser.*` because Chrome does not define
`browser` and Firefox does define `chrome`. One global works in both. The callback style
used everywhere works in both as well, where the promise style does not.

**What the Firefox manifest is still missing is in §8 and it blocks the listing.**

### The two halves ship on different clocks

This is the part of publishing that is easy to under-rate. Once the add-on is in a store,
the app and the add-on stop updating together and can never be made to again. A fix to the
site is live a minute after it is pushed and every reader has it on his next load. A fix
to the add-on waits on a review queue, lands when the store feels like landing it, and can
be switched off by a reader who has disabled extension updates. **They are always allowed
to disagree, and the only question is whether the disagreement is announced or silent.**

Silent is the default and it is bad: an older half, asked for something it has never heard
of, returns `false` from its message listener, the browser closes the reply channel, and
the page reports a lost connection and advises a reload — advice that cannot work, for a
reader whose only problem is that he has not updated. He reloads forever.

`src/data/extension.ts` carries the machinery for saying it out loud instead: a `PROTOCOL`
number both halves declare, an `ASKS` list the browser half checks an incoming ask against
rather than falling through, and `protocolSkew`, which returns a failure naming *which*
side is behind. Bump the number only when the page starts needing something an older half
cannot do — not when a sentence changes and not when a bug is fixed.

Checked 2026-09-17 at 15:30: `bridge.ts` sends `protocol: PROTOCOL` on every hello, and
both `yahoo.ts` and `background.ts` refuse an unknown ask through `isKnownAsk` rather than
falling through (`grep -n "PROTOCOL\|isKnownAsk" extension/src/*.ts`). Twenty minutes
earlier the same grep returned nothing — the module had been written ahead of its
consumers — so re-run it rather than trusting this paragraph. The reader-facing version
(`VERSION` in `extension/build.mjs`, 0.2.0 at the time of writing) is a separate number
and deliberately so: "0.1.0 against 0.3.2" is not a question a page can answer, and
"speaks 1, needs 2" is.

---

## 6. How the integration suite fakes Yahoo

`test/extension.mjs`, run by `npm run test:ext`. It needs `node extension/build.mjs`
first (it loads `dist-ext/chrome` off disk) and the dev server up, because it drives the
real app.

The trick is one Chromium flag:

```
--host-resolver-rules=MAP *.fantasysports.yahoo.com 127.0.0.1:<port>
```

A local `http` server serves four fixture pages, and Chromium is told Yahoo's hostname
resolves to it. So the pages really are requested at
`http://baseball.fantasysports.yahoo.com/b1/228947/8`, the extension's own match patterns
really do decide whether its content script runs, and the sweep's fetches really are
same-origin requests on that origin. The build in `dist-ext/chrome` is loaded unpacked,
exactly as a reader loads it. **Nothing about the add-on is stubbed.**

The fixtures are built from shapes this repository has already measured off the real site
— `test/settings.mjs` for the settings page's tab-separated `Stat Category` tables,
`test/ownership.mjs` for the player table's `data-ys-playerid` links, its second
id-bearing link with no title, and the AccuWeather tooltip that once broke the parser. The
roster and matchup fixtures are built out of `data/snapshot.json`, so the men on them are
real men the parsers can match.

Two things the suite found that reading the code would not have, both recorded in comments
at the point they bite:

- **`channel: "chromium"` is load-bearing.** With plain `headless: true`,
  `context.serviceWorkers()` comes back empty — the extension is not loaded at all and
  every assertion fails. The new headless shell loads it. `headless: false` also works and
  needs a display this machine may not have.
- **The hello race in §2**, which timed out the suite before it was understood.

**Count, measured 2026-09-17 at 15:25 by static count of the `t(…)` call sites in
`test/extension.mjs`: 109 assertions — 105 call sites, several of which sit inside a
two-iteration loop over the two built manifests.** It was 38 at 15:04, from 35 sites; the
suite was being added to during the session this was written, so re-derive rather than
quote:

```sh
node -e 'const s=require("fs").readFileSync("test/extension.mjs","utf8");
console.log((s.match(/(^|[^a-zA-Z_.])t\(/gm)||[]).length, "call sites")'
```

They cover, in order: the fixture being
served at Yahoo's hostname; the page seeing the stamp; the handshake and its version; the
Yahoo tab being visible to the background; one press bringing back three pages in the
order team, settings, matchup; the team page arriving as text rather than markup; the
settings page carrying a scoring table; the read landing on the league key the app already
uses; the league's own scoring on both sides of the ball; the team count; nine seats with
the men in them; the opponent told apart from his own team, with none of his own men on
the other side; the sweep returning a page per position; nine requests rather than ninety;
one position at a time; `count=0` on every one of them, which is the bug that hid the top
25 free agents at every position for a season; the pool being the union across positions
(27 men, not three seen nine times); which positions came back; a throttle reported as a
throttle; then the reader's own path through the setup sheet into the stores; then the two
manifests.

**Last measured green — `passed 109, failed 0` — on 2026-09-17 at 17:56, two hours after
the same command reported 20 of 38 with the run aborted. See §8 for both, and for what the
suite cannot prove however green it is.**

---

## 7. Permission justifications, ready to paste

Both stores ask for these in a text box at submission. They are written here so the answer
in the box and the answer in the code cannot drift, and every one of them can be checked
against a line rather than taken on trust.

### Single purpose

> Reads the fantasy baseball league the user is already signed into on Yahoo — his team,
> his league's scoring rules, his current matchup and the list of free agents — and hands
> those pages to beanemachine.com in the same browser, where they are turned into a
> ranked board. It does one thing: retrieve pages the user could open himself, when he
> presses a button.

### `tabs`

> The extension's background script is the only part that can see both the user's Yahoo
> tab and the beanemachine.com tab, and its whole job is to carry a request from one to
> the other. `tabs` is what makes that possible: `chrome.tabs.sendMessage` to ask the
> Yahoo tab for the page it has open, `chrome.tabs.onRemoved` to forget a tab that has
> closed, `chrome.tabs.query` to deliver progress lines ("reading shortstops") back to
> the beanemachine.com tab that asked for them, and `chrome.tabs.create` /
> `chrome.tabs.update` to put the user back on beanemachine.com when he presses the
> toolbar button, or to open Yahoo when he presses the button that says so. No browsing
> history is read, kept or transmitted; nothing is written to disk; the extension does
> not open a tab unless the user pressed something that says it will.

Checkable: `extension/src/background.ts` is the only file that touches `chrome.tabs`, and
the calls are `sendMessage` ×2, `query` ×2, `create` ×2, `update` ×1, `onRemoved` ×1
(`grep -oh "chrome\.[a-zA-Z.]*" extension/src/*.ts | sort | uniq -c`, measured 2026-09-17
at 15:30).

Both `chrome.tabs.query` calls pass `{ url: APP_MATCHES }` — the browser returns only tabs
matching beanemachine.com — plus the two local addresses in a `BM_EXT_DEV=1` build, and in
that build only — and the extension never enumerates
the rest. That is worth knowing because it has not always been true: the progress branch
used to call `chrome.tabs.query({})` and filter with `!/fantasysports\.yahoo\.com/`, which
meant reading the URL of every open tab and posting a message naming a fantasy position
into a bank tab and a work inbox, where nothing was listening and nothing was logged — so
it was invisible rather than harmless. If a change ever reintroduces an unfiltered
`query({})`, the `tabs` justification above and `extension/PRIVACY.md` both become false
and must be rewritten before submission.

### Host permission — `*://*.fantasysports.yahoo.com/*`

> This is where the user's league is. The content script on that host reads the fantasy
> page he already has open, and — only when he presses a button — fetches three or four
> more pages of his own league from inside his own signed-in tab: his league's settings
> page, his current matchup, and the free-agent list one position at a time. Those
> requests are same-origin requests made from his tab, carrying his own session, for
> pages he could click through himself. The pattern is the whole of Yahoo's fantasy host
> because Yahoo puts each sport on its own subdomain
> (`baseball.fantasysports.yahoo.com`, `football.…`) and the user's league is on
> whichever one he plays in. No other Yahoo property is matched: mail, finance, news,
> search and photos are all on different hosts, and none of them is in this pattern.

### Content script on `beanemachine.com`

> The extension has to hand what it read to the web page that uses it, and the page
> cannot be given a fixed extension id to talk to: Firefox has never implemented
> `externally_connectable` for web pages (bug 1319168), and an unpacked build gets a
> different id on every machine. So a second content script runs on the app's own origin
> and relays messages between the page and the extension by `window.postMessage`. It
> reads nothing from that page, changes nothing on it beyond one attribute saying the
> extension is installed, and stores nothing. It matches beanemachine.com alone: the local
> addresses a developer needs are a build flag (`BM_EXT_DEV=1`) rather than a shipped
> permission, because a match pattern cannot name a port and shipping `localhost` would let
> anything at all on the reader's own machine ask for his league.

### Remote code

> No. The extension executes no remotely hosted code. All three scripts are bundled into
> the package by `extension/build.mjs` and are unminified; the only thing fetched at
> runtime is the text of the user's own Yahoo pages, which is treated as data and parsed
> by the website, never evaluated.

### Why there is no `storage` permission

> Nothing is stored. The extension holds one thing in memory while the browser session
> lasts — which tab has a Yahoo page in it, so it knows which tab to ask — and that is
> gone when the browser closes. Everything read is handed straight to the web page, which
> keeps it in that browser's own local storage under the user's control. Adding `storage`
> would create a second copy of the user's league with its own lifetime and its own
> uninstall story, and there is no reason to have one.

Checkable: `permissions` is exactly `["tabs"]` in both built manifests, and
`test/extension.mjs` asserts per browser that `storage` is absent.

### Data disclosures (Chrome's checkbox groups)

The truthful answers, against what the code does:

- **Personally identifiable information** — no. Nothing is sent anywhere by the extension.
- **Health, financial, payment, authentication information** — no.
- **Personal communications** — no.
- **Location** — no.
- **Web history** — no. Tab URLs are read in memory to route a message (see the `tabs`
  note above) and are neither stored nor transmitted.
- **User activity** — no.
- **Website content** — **yes.** The extension reads the text and, for the player table,
  the HTML of the user's own Yahoo fantasy pages, and passes it to beanemachine.com in
  the same browser. This is the extension's entire purpose and the box must be ticked.

All three Chrome certifications — not selling data, not using it for purposes unrelated to
the single purpose, not using it for creditworthiness or lending — are true of this code,
which sends nothing to any server. Chrome also requires an affirmative statement of
compliance with the Limited Use policy on a site belonging to the extension;
`extension/PRIVACY.md` carries it and is what the Privacy policy URL should point at once
it is published at a URL.

---

## 8. What is not verified

This is the section to read twice. Everything above describes code that works against
fixtures. The list below is what nobody has checked, written as absences rather than as
risks, because an absence is what they are.

**No real Yahoo page has ever been read by this code.** Not once, by anybody, at any
point in this feature's life. There is no Yahoo account in this repository, no
credentials in CI, and scraping somebody else's league to run a test is not on. Every
page the extension has ever parsed was served by `test/extension.mjs` from
`127.0.0.1`.

**The fixtures are reconstructions, not captures.** They are built from shapes this
repository measured earlier — the settings page's label-and-value rows from
`test/settings.mjs`, the player table's markup from `test/ownership.mjs` — and those
measurements were taken off the real site. But a fixture built *from* a measurement is not
the page. It contains what somebody knew to reproduce. **The first real read may find
something new**, and the most likely candidates, in rough order of how much they would
cost:

- The settings page not laying its scoring table out the way `leagueFromPastedSettings`
  expects, which would leave a reader on the preset scoring while the screen says his
  league was read. `readGrabs` names what it could not read, which is the mitigation, not
  a fix.
- The matchup page's two rosters not being separable by "the men who are not his", which
  is the only rule `readGrabs` has for telling them apart. There is no label on that page
  a name-matcher can see, and if his own roster is not read in the same breath the
  opponent is reported as empty — deliberately, rather than guessed at.
- A private league serving markup a public one does not. **Untested.** The cookie path — a
  content script's fetch carrying its tab's own session — is exercised structurally by the
  same-origin fetches in the suite, and whether Yahoo serves a private league's pages
  identically is not something this repository can find out.
- `pageKind`'s URL rules being wrong for some league type. They are asserted against the
  URL shapes this project has used for a year, and URLs are the most stable thing on
  Yahoo, but "most stable" is not "checked this week".

**No score is read from the matchup page, on purpose.** The page prints one. It is
deliberately not parsed, because nobody working on this has seen the real page, and a
regular expression written against a page nobody has seen is a number the app would print
with total confidence and no idea whether it was the score, the projection, or last
week's. Only names are taken.

**How Yahoo throttles a real signed-in account is unmeasured.** Commit `de44045` measured
a faster sweep from a *server* returning 150 players, then 25, then 0, then the literal
string "Request denied". The 250 ms spacing and the one-position-at-a-time sweep are set
from that measurement. Whether they are *enough* from a signed-in browser over a long
session has not been measured at all. The honest statement is that a throttle is detected
and reported, not that it is avoided.

**The Firefox build has never been run.** Firefox cannot be driven with an unpacked
extension from this harness, so what is asserted about it is the content of its manifest,
not its behaviour. The event-page background, the `gecko` id and the version floor are
checked as JSON. Nothing has ever loaded `dist-ext/firefox` into a Firefox.

**The store install is unverifiable here.** Loading unpacked is the only route this
repository can exercise. A store listing is reviewed and published by somebody else, and
nothing in this directory can assert one exists. `src/client/Connect.tsx` links to each
browser's store search page, which is what a reader who did not clone this repository
follows.

**The suite was green at 2026-09-17 17:56: `passed 109, failed 0`**, from `node
extension/build.mjs && node --experimental-strip-types test/extension.mjs` with the dev
server on 127.0.0.1:5299. `npx tsc --noEmit` was clean in the same minute.

That is a fact about one run and not a standing property, and the half hour before it is
the reason to say so. At **15:05** the same command against a build of the same minute
gave **20 of 38 passed, 1 failed, 17 never reached**: the run aborted at the 21st
assertion, `the sheet offers to read the league, in a browser that can`, because
`.onboard-offer button` was not present and the suite clicks it without a null check — the
sheet had rendered the already-connected screen instead of the offer. Three other agents
and the main session were editing `src/client/`, `src/data/extension.ts` and
`test/extension.mjs` throughout. The suite went from 38 assertions to 39, `yahoo.ts` went
from three `fetch` call sites to two, and the progress broadcast stopped enumerating every
open tab, all inside that half hour. **Re-run it before trusting any of this**, and do not
read the count in §6 as a pass count.

### What a store listing still needs that this repository does not have

Naming these is the deliverable; none of them is acquired here.

- ~~**Firefox will reject the submission outright.**~~ **Done, 2026-09-18.** Since
  **2025-11-03** every *new* extension submitted to addons.mozilla.org must declare
  `browser_specific_settings.gecko.data_collection_permissions` or be refused at signing,
  and the manifest did not have the key. It declares `{"required": ["none"]}` now.

  The category was the load-bearing question and this entry used to answer it the other
  way, so the reasoning is recorded rather than the conclusion alone. Mozilla defines the
  data transmission that triggers disclosure as data "collected, used, transferred,
  shared, or handled **outside of the add-on or the local browser**" (add-on policies,
  §6). Nothing here leaves the local browser: Yahoo's page to the add-on to the app's own
  page to that page's own storage, all inside the reader's browser, all gone when he
  uninstalls. `none` is therefore the accurate declaration and the only one consistent
  with `extension/PRIVACY.md`, which a reviewer is pointed at and which says the same
  thing at length.

  The ambiguity, kept because whoever submits this will meet it: the app's page is a
  different ORIGIN, and a stricter reading could call that "outside the add-on" even
  though it never leaves the browser. The definition reads as a union — inside the browser
  is a safe harbour whichever page holds it — and no Mozilla text carves out an exception
  for a local cross-origin handoff. The conservative alternative is `["websiteContent"]`,
  which costs nothing but a scarier consent screen and would contradict PRIVACY.md. It is
  written into the manifest's own comment so that changing it is a decision rather than a
  discovery.
- ~~**Chrome will reject the manifest's description.**~~ **Done, 2026-09-18.** Chrome's
  `description` has a hard 132-character limit and refuses a longer one rather than
  truncating it. This manifest carried 178 for as long as it had existed, and nothing
  would have said so until the first upload. It is 125 now, and both builds are asserted
  against the limit in `test/extension.mjs`.
- **A privacy policy at a URL.** Both stores require one for a listing that reads page
  content. `extension/PRIVACY.md` is written and true of the code; it is a file in a repo,
  not a URL, and Chrome's Privacy practices tab wants a link.
- **Screenshots.** Chrome requires at least one, 1280×800 or 640×400, square corners, full
  bleed, up to five. There are none in this repository and nothing in the build emits one.
- **A small promo tile, 440×280.** Required by Chrome. Not emitted.
- **A store icon at the size and shape Chrome asks for.** The build emits 16, 48 and 128
  px PNGs, so the 128 exists — but Chrome asks for 96×96 of artwork inside 16 px of
  transparent padding, and this one is full bleed. Measured 2026-09-17 by decoding
  `dist-ext/chrome/icon-128.png`: alpha is 255 at (0, 64) and (64, 0), and there are zero
  transparent columns before ink on row 64. The corners are rounded (alpha 0 at (0,0)) but
  the edges are not padded. `extension/build.mjs` draws it and is outside this task's file
  list.
- ~~**A packaged zip.**~~ **Done, 2026-09-18.** The build shelled out to `/usr/bin/zip`,
  which does not exist on this machine, so it printed "zip not available" and produced
  none. It writes the archive itself now — stored entries, a fixed timestamp so two builds
  of the same source are the same bytes — and copies both into `public/`, because the site
  has to hand the add-on over while no store has it.
- **A Chrome Web Store developer account**, which needs a Google account and a one-time
  registration fee. Chrome's own registration page does not state the amount; check the
  dashboard.
- **A trader / non-trader declaration**, required of every Chrome Web Store developer
  since the EU Digital Services Act rules took effect on 2024-02-17. Declaring "trader"
  publishes a legal name, address, email and a phone number verified by SMS on the
  listing.
- **Source code for Mozilla's reviewers.** AMO requires the pre-build source and
  reproduction instructions whenever the shipped code is bundled by a tool like Vite, even
  unminified — which this is. The repository is public and `node extension/build.mjs` is
  the whole instruction, so this is a form to fill in rather than work to do.
- **A verified publisher domain** is *not* required to list on either store. It is worth
  naming as absent anyway: without it neither listing can say it is published by the
  owner of beanemachine.com, and the app's walkthrough points readers at a store *search*
  page (`src/client/Connect.tsx`) rather than at a listing, so whatever a reader finds
  there is whatever the search returns.

---

## Sources

- [externally_connectable, MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/externally_connectable)
  and [Bugzilla 1319168](https://bugzilla.mozilla.org/show_bug.cgi?id=1319168)
- [Bugzilla 1573659 — background service worker for MV3](https://bugzilla.mozilla.org/show_bug.cgi?id=1573659)
  and [background, MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Announcing data collection consent changes for new Firefox extensions](https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions/)
  and [browser_specific_settings, MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
- [Source code submission, Firefox Extension Workshop](https://extensionworkshop.com/documentation/publish/source-code-submission/)
- [Fill out the privacy fields, Chrome for Developers](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Supplying images, Chrome for Developers](https://developer.chrome.com/docs/webstore/images)
- [Limited Use, Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Trader/Non-Trader identification and verification](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure)
- [Register as a Chrome Web Store developer](https://developer.chrome.com/docs/webstore/register)
