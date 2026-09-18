# Privacy policy

**beanemachine — read my Yahoo league**
Last updated 2026-09-17.

Every sentence below is a statement about code in this folder, and every one of them can
be checked against a line of it. Where something is not known, this page says so rather
than reassuring you.

---

## The short version

It reads the Yahoo fantasy pages you are already signed into, in your own browser, when
you press a button, and hands what it read to beanemachine.com in that same browser.

**Nothing is sent to us. Nothing is sent to anybody.** There is no server on the other end
of this. The only network requests it makes are to Yahoo, from your own tab, for pages you
could open yourself by clicking.

It keeps nothing of yours. It has no storage permission and no database, and when you
remove it there is nothing of yours left behind in it, because there never was anything in
it. Three small facts about what it is doing right now live in memory while your browser is
open — a tab number, whether a read is running, and the times of the last minute's requests
— and they are set out in full below rather than tucked under this sentence.

---

## What it reads, exactly

Only when you press something. It never reads on a timer, on a schedule, or in the
background — every read below is the direct answer to a button.

**The Yahoo page you have open.** Its address, and the text of it: what you would get by
selecting the whole page and copying it. (`grabHere` in `src/yahoo.ts`.)

**Three or four more pages of your own league**, if you press the button that reads your
league. Your league's settings page, your current matchup, and — on the separate button
for it — the free-agent list, one position at a time, nine positions in all. These are
fetched from inside your own signed-in tab, as ordinary same-origin requests carrying your
own Yahoo session, exactly as if you had clicked through to each page. (`sweep` and the
`league` branch in `src/yahoo.ts`; the requests are made with a path rather than a full
address specifically so that they stay inside the tab you are already in — `samePath`.)

**The markup of the free-agent table, rather than just its text**, and only that table.
Yahoo's player rows carry a numeric player id in the HTML that does not survive being
copied as text, and that id is what makes a free agent recognisably the same person as a
player already known to the site, instead of a name that might belong to two people. On
the free-agent read, the player rows are cut out of the page and the rest of it — header,
footer, adverts, everything around the table — is thrown away before anything is handed
over. (`rowsOnly`, applied in `src/yahoo.ts`.)

**Which of your open tabs has Yahoo in it**, so a request from the website can be sent to
the right tab. Your browser is asked for that list at the moment it is needed, rather than a
list being kept — nothing about your tabs is stored between one request and the next.

Three things are remembered, and they are worth saying plainly rather than leaving them to
be discovered. All three are held in memory only and all three go when your browser closes.

When you switch tabs, the add-on notes the number of the tab you switched to and the time,
so that when you have two leagues open it can tell which one you were last looking at. It is
the tab's number and a timestamp — not its address, not its contents. (`lastSeen` in
`src/background.ts`.)

Inside a Yahoo tab, it remembers whether a read is running in that tab right now, and when
it started, so that a second press is told to wait rather than making the same requests
twice over. (`reading` and `readingSince` in `src/yahoo.ts`.)

And in that same tab it keeps the TIMES of the requests it has made in the last minute — a
list of timestamps and nothing else, no addresses — so that it can refuse to ask Yahoo more
than forty-five times in any minute. That limit exists for your sake rather than ours: it is
your signed-in session making the requests, and a page driving it too hard is your account
that gets throttled. (`spent` in `src/yahoo.ts`.)

**Which of your open tabs are beanemachine.com**, so that a progress line ("reading
shortstops") reaches the page that asked for it, and so that the toolbar button can put
you back on that page. It asks the browser for tabs matching beanemachine.com — and, in a
build made for developing the add-on and not in the one you installed, two local addresses
as well — and the browser answers with those and no others — it does not look
through your open tabs itself. (`chrome.tabs.query({ url: APP_MATCHES })`, twice, in
`src/background.ts`. An earlier version of this file disclosed that the add-on examined
the address of every open tab in order to skip the Yahoo ones; that is what the code did,
and it was narrowed to the query described here.)

That is the complete list.

## What it does not read

It does not read any page outside Yahoo's fantasy site and beanemachine.com. Those are
the only two places it runs at all: the match patterns in the `manifest.json` inside the
file you installed are `https://*.fantasysports.yahoo.com/*`, `https://beanemachine.com/*`
and `https://*.beanemachine.com/*` — that is the whole list, and a browser will not inject
it anywhere else.

This paragraph used to say the list included `localhost`, and a later paragraph of this
same document said it did not. The later one was right: local addresses are added only by
a build made for developing the add-on, which is not the build any store distributes. A
document that promises every sentence can be checked against a line of code cannot leave a
sentence in it that fails its own check, and the way to check this one is to open
`manifest.json` in the installed add-on and read the two `matches` lists. Your mail, your finances, your search history and the
rest of your Yahoo account are on other hosts and are not matched.

It does not read anything on beanemachine.com. The part of it that runs there passes
messages and nothing more; the only mark it leaves on that page is one attribute saying it
is installed, so the page can stop telling you to install it. (`src/bridge.ts`.)

It does not read your Yahoo password, and it never sees one. It uses the session your
browser already has, the same way the rest of your tabs do.

**Your matchup page is read, and the score on it is never used.** Being exact about this,
because an earlier version of this page said the score was "not taken" and that was not true
of the code: the add-on hands over that page's text like any other, and the score is in it.
What happens to it is nothing — the website takes the player NAMES out of that page and
discards the rest, and no screen anywhere prints a score. The reason is that the people who
wrote this have never seen a real matchup page, and a number read off a page nobody has seen
would be printed with confidence and no idea whether it was the score, the projection, or
last week's.

---

## Where it goes

To the beanemachine.com page open in the same browser, and nowhere else.

The route is: the part inside Yahoo hands the pages to the part that routes messages,
which hands them to the part inside beanemachine.com, which posts them into that page —
addressed to that page's own origin, not broadcast. All of this happens inside your
browser. Nothing crosses the network on the way.

That page then reads what it was handed and keeps the result in your browser's own local
storage, under your control, on your machine. Nothing is uploaded from there either — the
site is a static site with no account and no server that holds anything of yours.

**How to check this claim rather than believe it.** Every network call in the whole add-on
is in `src/yahoo.ts`, and every one of them asks for a *path* — not a full address —
which a browser can only resolve against the Yahoo page the call is being made from. The
other two files make none at all:

```sh
grep -rn 'fetch(\|XMLHttpRequest\|sendBeacon' extension/src/
```

Measured 2026-09-17 at 15:30, that returns two lines, both `fetch(samePath(url), …)` in
`src/yahoo.ts`. Run it yourself rather than trusting the count — the count changes when
the code is refactored and the property being claimed does not. If that command ever
returns a line in `background.ts` or `bridge.ts`, or a call with a hostname in it, this
page is out of date and should not be believed.

There is no analytics, no error reporting, no telemetry and no remote configuration,
because there is nowhere for any of it to go.

---

## What it stores

Nothing.

It does not ask for the storage permission — the whole permission list is one entry,
`tabs` — so the browser will not let it write to extension storage even if a future change
tried to. The only thing it holds between one message and the next is the list of tab
numbers described above, in memory, for as long as the browser is running.

Everything read ends up in the website's own local storage in your browser. That is one
copy, in one place, that you can see and clear.

---

## Why it asks for what it asks for

**`tabs`** — because the Yahoo page and the beanemachine.com page are two different tabs
and cannot speak to each other. This is what lets a request from one reach the other, lets
a closed tab be forgotten, lets a progress line get back to the page that asked, and lets
the toolbar button put you back on beanemachine.com. No browsing history is read, kept or
sent.

**`*://*.fantasysports.yahoo.com/*`** — because that is where your league is. The pattern
covers the whole of Yahoo's fantasy site because Yahoo puts each sport on its own
subdomain and your league is on whichever one you play in.

**beanemachine.com** — because what was read has to be handed to the page that uses it, and
a web page has no other way to talk to an add-on that works in both Chrome and Firefox.

This page used to say `localhost` and `127.0.0.1` were included too, so that somebody
running the site on their own machine could use it. They were, and they are not any more: a
permission cannot name a port, so allowing `localhost` allows ANY page served from your own
machine, on any port, to ask this add-on for your Yahoo league — and on a developer's
machine there is usually something listening that he did not write. The capability survives
as a build somebody testing the site makes for himself; it is not in the one you install.

There is no storage permission, no `<all_urls>`, no `webRequest`, no cookie permission and
no scripting permission.

**Something worth knowing rather than glossing over:** because the way a web page talks to
an add-on is by posting a message into its own page, any script running on
beanemachine.com can ask it to read your Yahoo fantasy pages. It cannot reach anything else: the add-on's own reach is Yahoo's fantasy
host and nothing wider, so your Yahoo account, mail and everything else stay out of it. A
message from an embedded frame is refused, and a message from another window is refused.

---

## How to revoke it

Remove it from your browser's add-ons list — `chrome://extensions` in Chrome,
`edge://extensions` in Edge, `about:addons` in Firefox — and every permission above is
gone with it, immediately.

There is nothing else to delete on our side, because there is no our side: nothing of
yours was ever sent anywhere, so there is no account to close and no request to make.

What you read into the website stays in that browser's local storage until you clear it.
Clearing site data for beanemachine.com removes it. Signing out of Yahoo, or clearing
Yahoo's cookies, stops it being able to read anything even while installed.

---

## Children

This is a fantasy baseball tool. It is not directed at children, it asks for no age, and
it collects nothing from anybody.

---

## Chrome Web Store Limited Use

Use of information received from Google APIs, and of any user data handled by this
extension, adheres to the [Chrome Web Store User Data
Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements. Concretely: the data this extension handles — the
content of your own Yahoo fantasy pages — is used only to provide the single feature it
exists for, is passed only to the beanemachine.com page in your own browser, is never
transferred to us or to any third party, is never sold, is never used for advertising or
for creditworthiness or lending purposes, and is never read by a human, because it does
not leave your machine.

---

## Changes to this policy

This file is versioned in the repository the extension is built from, and its history is
the change log. If what the code does changes, this file changes in the same commit; the
date at the top is the date of the last such change.

## Who to contact

Questions go to the developer contact address published on the store listing this
extension is distributed from. No address is committed to this file, so that one address
does not have to be maintained in two places.
