/** Minimal RFC4180 CSV reader — Savant leaderboards quote fields containing commas
 *  (notably "last_name, first_name") so a naive split corrupts every row. */
export const parseCsv = (text: string): Record<string, string>[] => {
	const rows: string[][] = []
	let row: string[] = []
	let field = ""
	let quoted = false
	// strip UTF-8 BOM, which Savant emits and which would corrupt the first header
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

	for (let i = 0; i < src.length; i++) {
		const c = src[i]
		if (quoted) {
			if (c === '"') {
				if (src[i + 1] === '"') {
					field += '"'
					i++
				} else quoted = false
			} else field += c
		} else if (c === '"') quoted = true
		else if (c === ",") {
			row.push(field)
			field = ""
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && src[i + 1] === "\n") i++
			row.push(field)
			field = ""
			if (row.some(v => v !== "")) rows.push(row)
			row = []
		} else field += c
	}
	row.push(field)
	if (row.some(v => v !== "")) rows.push(row)

	const [header, ...body] = rows
	if (!header) return []
	// Savant's first column header is literally `last_name, first_name` with a newline
	const keys = header.map(h => h.trim().replace(/\s+/g, " "))
	return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])))
}

/** Parses a numeric cell, returning null rather than 0 for blank/non-numeric —
 *  a missing measurement must never masquerade as a real zero. */
export const num = (v: string | undefined): number | null => {
	if (v === undefined) return null
	const t = v.trim()
	if (t === "" || t === "null" || t === "NA") return null
	const n = Number(t)
	return Number.isFinite(n) ? n : null
}
