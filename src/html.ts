/**
 * Just enough HTML scraping for league settings pages. Yahoo renders settings
 * as plain server-side tables, so a tolerant regex pass is sturdier here than a
 * DOM parser dependency — and it keeps the toolchain to zero runtime deps
 * beyond arktype.
 */

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " "
}

export const decodeEntities = (s: string): string =>
	s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" || body[1] === "X" ?
					parseInt(body.slice(2), 16)
				:	parseInt(body.slice(1), 10)
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole
		}
		return ENTITIES[body.toLowerCase()] ?? whole
	})

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, " ")

const squish = (s: string): string => s.replace(/\s+/g, " ").trim()

export const cellText = (s: string): string => squish(decodeEntities(stripTags(s)))

const withoutScripts = (doc: string): string =>
	doc.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")

/** Every `<table>` in the document, as rows of already-cleaned cell strings. */
export const parseTables = (doc: string): string[][][] => {
	const clean = withoutScripts(doc)
	const tables: string[][][] = []
	for (const table of clean.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
		const rows: string[][] = []
		for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
			const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m =>
				cellText(m[1]!)
			)
			if (cells.length) rows.push(cells)
		}
		if (rows.length) tables.push(rows)
	}
	return tables
}

/** Whole-document visible text, whitespace-collapsed. */
export const documentText = (doc: string): string =>
	squish(decodeEntities(stripTags(withoutScripts(doc))))

/** Parses a numeric cell, returning null for anything that isn't purely a number. */
export const parseNumber = (s: string): number | null => {
	const t = s.replace(/,/g, "").trim()
	return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null
}
