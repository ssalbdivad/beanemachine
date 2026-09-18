/**
 * THE PRIVACY POLICY, AS A PAGE A STORE REVIEWER CAN OPEN.
 *
 * Both stores require a privacy policy at a URL before a listing can be submitted, and this
 * project's is a Markdown file in a repository. Pointing a reviewer at a raw file on a code
 * host is asking him to trust a rendering he did not ask for; pointing him at a 404, which is
 * what beanemachine.com/privacy was until this file existed, ends the submission.
 *
 * ONE SOURCE, RENDERED. The page is generated from `extension/PRIVACY.md` at build time, so
 * the document the add-on ships beside and the page the listing links to cannot drift — which
 * is the failure this project has already had twice in that exact document, and both times it
 * was a sentence that had stopped being true of the code.
 *
 * The converter handles what PRIVACY.md actually uses and nothing else: headings, paragraphs,
 * bold, inline code, links, horizontal rules. A construct it does not know is emitted as its
 * own text rather than swallowed, because a policy with a sentence silently missing is worse
 * than a policy with a stray asterisk in it.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const escape = s =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Inline marks, applied after escaping so nothing here can inject markup. Bold runs first:
 *  the policy writes a match pattern as bold-wrapping-code, and taking the code first leaves
 *  the asterisks stranded around a tag. */
const inline = s =>
	escape(s)
		/* Lazy, not "anything but an asterisk": the policy bolds a MATCH PATTERN, whose own
		   text is asterisks, and a class-based match stops at the first one and leaves the
		   rest stranded on the page. */
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

const render = md => {
	const out = []
	let para = []
	const flush = () => {
		if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`)
		para = []
	}
	/* A fenced block is emitted verbatim. The policy contains one — the grep it invites a
	   reviewer to run — and a command with its own quoting rendered as a paragraph is a command
	   he cannot copy. */
	let fenced = null
	for (const raw of md.split(/\r?\n/)) {
		const line = raw.trimEnd()
		if (/^```/.test(line.trim())) {
			if (fenced === null) {
				flush()
				fenced = []
			} else {
				out.push(`<pre><code>${escape(fenced.join("\n"))}</code></pre>`)
				fenced = null
			}
			continue
		}
		if (fenced !== null) {
			fenced.push(raw)
			continue
		}
		if (!line.trim()) {
			flush()
			continue
		}
		const head = /^(#{1,6})\s+(.*)$/.exec(line)
		if (head) {
			flush()
			const n = head[1].length
			out.push(`<h${n}>${inline(head[2])}</h${n}>`)
			continue
		}
		if (/^---+$/.test(line.trim())) {
			flush()
			out.push("<hr>")
			continue
		}
		const item = /^[-*]\s+(.*)$/.exec(line)
		if (item) {
			flush()
			out.push(`<ul><li>${inline(item[1])}</li></ul>`)
			continue
		}
		para.push(line.trim())
	}
	flush()
	/* Adjacent single-item lists become one list. Cheaper than tracking list state above, and
	   it cannot change the text — only the markup around it. */
	return out.join("\n").replace(/<\/ul>\n<ul>/g, "\n")
}

const md = readFileSync(resolve(here, "PRIVACY.md"), "utf8")
const title = (/^#\s+(.*)$/m.exec(md) ?? [, "Privacy"])[1]

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — beanemachine</title>
<meta name="description" content="What the beanemachine browser add-on reads, what it does with it, and what it keeps.">
<style>
  :root { color-scheme: dark light; --ink:#f4f1e8; --ground:#1b3a2b; --muted:#b9c7bd; --rule:#32513f; --accent:#9ed7a8 }
  @media (prefers-color-scheme: light) {
    :root { --ink:#1b3a2b; --ground:#f7f5ee; --muted:#4a5f51; --rule:#d8d3c4; --accent:#1f6b3a }
  }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 68ch; margin: 0 auto; padding: 3rem 1.25rem 6rem }
  h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 1.5rem }
  h2 { font-size: 1.15rem; margin: 2.5rem 0 .75rem; border-top: 1px solid var(--rule); padding-top: 1.5rem }
  h3 { font-size: 1rem; margin: 1.75rem 0 .5rem }
  p, li { margin: 0 0 1rem }
  ul { padding-left: 1.2rem }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; color: var(--accent) }
  pre { background: rgba(127,127,127,.12); padding: .9rem 1rem; border-radius: 6px; overflow-x: auto }
  pre code { color: inherit }
  a { color: var(--accent) }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 2.5rem 0 }
  .back { display: inline-block; margin-bottom: 2rem; color: var(--muted) }
</style>
</head>
<body>
<main>
<a class="back" href="/">&larr; beanemachine</a>
${render(md)}
</main>
</body>
</html>
`

const out = resolve(here, "..", "public", "privacy")
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, "index.html"), html)
console.log(`privacy page: public/privacy/index.html (${html.length} bytes) from extension/PRIVACY.md`)
