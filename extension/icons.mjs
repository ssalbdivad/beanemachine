/**
 * THE TOOLBAR ICONS, RENDERED FROM THE MASCOT — `node extension/icons.mjs`
 *
 * Not part of the build. The three PNGs it writes are COMMITTED, and `build.mjs` copies them
 * verbatim, for two reasons that both matter more than the convenience of generating them:
 *
 *   · a committed file is the same bytes on every machine. The icons used to be drawn
 *     procedurally and encoded with `zlib.deflateSync`, whose output is a function of the Node
 *     version — so two people building the same commit got two different zips, and the source
 *     archive AMO asks for could not be proven to rebuild the package. It can now.
 *   · this script needs Chromium. Making a release depend on a browser download, to redraw
 *     artwork that changes once a year, is a bad trade.
 *
 * WHY IT IS A RENDER AND NOT A DRAWING. There was a hand-rolled mascot here: a rounded square
 * with two dots and an arc, on the theory that 16 px cannot hold more. It could. The first
 * thing anyone said about it was that it looked like garbage, and they were right — at 16 px
 * the real mascot still resolves into a navy cap over a pale face, which is recognisably the
 * same character as the one on the site, and the approximation resolved into a smudge. So this
 * reads `public/beanbot.svg` — the one the app itself shows — and there is now exactly one
 * mascot in the repository rather than two that drift.
 *
 * THE CREAM PLATE IS NOT DECORATION. The mascot is outlined in near-black (#191c1f) and
 * capped in navy, which disappears against a dark toolbar; Firefox and Chrome both have one.
 * The plate is the app's own ink, so the icon carries its own contrast onto either chrome.
 */
import { chromium } from "playwright-core"
import { readFileSync, writeFileSync } from "node:fs"
import { deflateSync, inflateSync } from "node:zlib"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const mascot = readFileSync(resolve(here, "..", "public", "beanbot.svg"), "utf8")
	.replace(/^<svg[^>]*>/, "")
	.replace(/<\/svg>$/, "")

/**
 * A SQUARE CROP OF A MASCOT THAT IS NOT SQUARE. beanbot.svg is 106x106 of viewBox around a
 * figure about 103 wide and 89 tall — the cap's brim is what makes it wide. Centring that in a
 * square leaves the head sitting high, so the box below is shifted down a few units from the
 * arithmetic centre and was picked by looking at the 16 px render, which is the only size where
 * being a unit out is visible.
 */
const BOX = "3 -24 106 106"
const INK = "#f4f1e8" // the app's ink, and the plate the mascot sits on
const GROUND = "#1b3a2b" // the app's ground, and the promotional tile's

/** Chrome's store guidance: 96x96 of artwork inside 128x128, so 16 transparent px a side. */
const INSET = { 16: 0, 48: 0, 128: 1 / 8 }

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 1 })

/** The mascot on its plate, rendered at exactly `edge` pixels and nothing around it. */
const art = async edge => {
	const [x, y, w, h] = BOX.split(" ")
	await page.setViewportSize({ width: edge, height: edge })
	await page.setContent(
		`<html><body style="margin:0">` +
			`<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="${edge}" viewBox="${BOX}">` +
			`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${+w * 0.18}" fill="${INK}"/>` +
			`${mascot}</svg></body></html>`
	)
	return page.screenshot({ omitBackground: true })
}

/**
 * PADDING THE 128, ARITHMETICALLY, BECAUSE THE BROWSER WOULD NOT DO IT EXACTLY.
 *
 * Chrome's Supplying Images page asks for 96x96 of artwork centred in a 128x128 canvas. Three
 * ways of asking Chromium for that — grid centring, an absolute offset in whole pixels, a
 * clipping box with `overflow:hidden`, and finally compositing the finished 96 px PNG as an
 * <img> at an integer offset — all measured 97 px of artwork, the last of them with 200/255 of
 * alpha in the stray column, which is ink you can see. Somewhere in that pipeline the layer is
 * resampled by a fraction of a pixel, and it is not worth finding where.
 *
 * So the 96 is rendered on its own, where the viewport IS the artwork and cannot be off by
 * one, and the transparent border is added by copying scanlines. A PNG is a signature, an IHDR,
 * one deflated block of filter-zero scanlines and a CRC; that is the whole of what follows.
 * This runs by hand and its output is committed, so `deflateSync` being Node-version-dependent
 * costs nothing here — which is exactly why it could not stay in the build.
 */
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	return c >>> 0
})
const chunk = (type, data) => {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const body = Buffer.concat([Buffer.from(type, "ascii"), data])
	let c = 0xffffffff
	for (const byte of body) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE((c ^ 0xffffffff) >>> 0)
	return Buffer.concat([len, body, crc])
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** RGBA scanlines out of a truecolour-with-alpha PNG, which is what Chromium hands back. */
const pixels = png => {
	let at = 8, w = 0, h = 0
	const idat = []
	while (at + 8 <= png.length) {
		const len = png.readUInt32BE(at)
		const type = png.toString("ascii", at + 4, at + 8)
		if (type === "IHDR") {
			w = png.readUInt32BE(at + 8)
			h = png.readUInt32BE(at + 12)
			if (png[at + 16] !== 8 || png[at + 17] !== 6)
				throw new Error(`expected 8-bit RGBA, got depth ${png[at + 16]} colour ${png[at + 17]}`)
		}
		if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + len))
		at += 12 + len
	}
	const raw = inflateSync(Buffer.concat(idat))
	const rgba = Buffer.alloc(w * h * 4)
	/* Every filter Chromium may have used, undone one scanline at a time. Paeth is the one it
	   actually picks most rows, and getting it subtly wrong shows up as a faint diagonal. */
	const bpp = 4
	for (let y = 0; y < h; y++) {
		const filter = raw[y * (w * 4 + 1)]
		for (let i = 0; i < w * 4; i++) {
			const x = raw[y * (w * 4 + 1) + 1 + i]
			const a = i >= bpp ? rgba[y * w * 4 + i - bpp] : 0
			const b = y > 0 ? rgba[(y - 1) * w * 4 + i] : 0
			const c = y > 0 && i >= bpp ? rgba[(y - 1) * w * 4 + i - bpp] : 0
			let add = 0
			if (filter === 1) add = a
			else if (filter === 2) add = b
			else if (filter === 3) add = (a + b) >> 1
			else if (filter === 4) {
				const p = a + b - c
				const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
				add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
			}
			rgba[y * w * 4 + i] = (x + add) & 0xff
		}
	}
	return { w, h, rgba }
}

/** `art` pixels of RGBA, centred in a transparent `size` square, re-encoded. */
const pad = (png, size) => {
	const { w, h, rgba } = pixels(png)
	const off = (size - w) / 2
	if (!Number.isInteger(off) || w !== h)
		throw new Error(`cannot centre ${w}x${h} in ${size} on a whole pixel`)
	const raw = Buffer.alloc(size * (size * 4 + 1))
	for (let y = 0; y < h; y++)
		rgba.copy(raw, (y + off) * (size * 4 + 1) + 1 + off * 4, y * w * 4, (y + 1) * w * 4)
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(size, 0)
	ihdr.writeUInt32BE(size, 4)
	ihdr[8] = 8
	ihdr[9] = 6
	return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}

for (const size of [16, 48, 128]) {
	const edge = Math.round(size * (1 - INSET[size] * 2))
	const drawn = await art(edge)
	writeFileSync(resolve(here, "icons", `icon-${size}.png`), edge === size ? drawn : pad(drawn, size))
	console.log(`icon-${size}.png — ${edge}x${edge} of artwork in ${size}x${size}`)
}

/**
 * AND THE 440x280 TILE CHROME REQUIRES OF A LISTING, from the same mascot for the same reason:
 * a tile that does not look like the icon beside it in the store reads as somebody else's
 * add-on. No text on it — Chrome overlays the name and summary on its own furniture, and a
 * tile carrying a second copy of the name is the commonest reason one comes back as cluttered.
 */
await page.setViewportSize({ width: 440, height: 280 })
await page.setContent(
	`<html><body style="margin:0;width:440px;height:280px;background:${GROUND};` +
		`display:flex;align-items:center;justify-content:center">` +
		`<svg xmlns="http://www.w3.org/2000/svg" width="210" height="210" viewBox="${BOX}">` +
		`<rect x="${BOX.split(" ")[0]}" y="${BOX.split(" ")[1]}" width="${BOX.split(" ")[2]}" ` +
		`height="${BOX.split(" ")[3]}" rx="${+BOX.split(" ")[2] * 0.18}" fill="${INK}"/>` +
		`${mascot}</svg></body></html>`
)
writeFileSync(resolve(here, "icons", "promo-440x280.png"), await page.screenshot())
console.log("promo-440x280.png — the tile a Chrome listing requires")

await browser.close()
