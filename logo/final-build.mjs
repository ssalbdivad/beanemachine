// Billy — the beanemachine mascot. Regenerate with:  node logo/final-build.mjs
//
// Details that were each wrong at least once:
//  · BRIM: a full half-ellipse, upside down relative to the crown's dome, springing
//    from the single point where the dome's outline meets the base line (74, BASE).
//    It does not tuck under the crown and does not overlap it — they touch at one
//    point. Angular polygons and tucked beziers both read as disjointed.
//  · NY: the official Mets cap insignia, placed by its measured bounding box
//    (341 x 500 inside a 575 box). Hand-simplified versions were tried repeatedly
//    and never held up; the real vector is used instead.
//  · SPECS need TEMPLE ARMS or they read as plain round eyes.
//  · SMILE must clear the lenses: lens bottom = EY + LR + 1.9. They collided once.
import { readFileSync, writeFileSync } from "node:fs"
const REF = JSON.parse(readFileSync("logo/reference-ny.json", "utf8"))
const INK = "var(--ink)", ACC = "var(--acc)", LENS = "var(--lens)", GLINT = "var(--glint)"
const BLUE = "var(--mets-blue)", ORANGE = "var(--mets-orange)"

const P = (d, w = 3.6, col = INK) =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const rr = (x, y, w, h, r, sw, fill, col) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const ci = (x, y, r, sw, fill, col) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const dot = (x, y, r, col = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`

const CX = 40, HL = 10, HR = 70, HT = 20, HB = 71, BASE = 31, K = -14
const EY = 45, LR = 11, SMILE_Y = 61
const CROWN_R = 74, BRIM_RX = 16, BRIM_RY = 7.5, NY_H = 18
const apex = (BASE * 2 + 6 * K) / 8
const NY_BB = { x: 116.9, y: 37.5, w: 341.1, h: 500 }

const insignia = (px, py, h) => {
  const s = h / NY_BB.h
  return `<g transform="translate(${(px - s * (NY_BB.x + NY_BB.w / 2)).toFixed(2)} ${(py - s * (NY_BB.y + NY_BB.h / 2)).toFixed(2)}) scale(${s.toFixed(4)})"><path d="${REF.ny}" fill="${ORANGE}"/></g>`
}

export const body = `
${rr(HL, HT, HR - HL, HB - HT, 15, 3.8, "none", INK)}
${P(`M${27 - LR} ${EY - 2} H${HL + 3} l-3 4`, 3.4, ACC)}${P(`M${53 + LR} ${EY - 2} H${HR - 3} l3 4`, 3.4, ACC)}
${ci(27, EY, LR, 3.8, LENS, ACC)}${ci(53, EY, LR, 3.8, LENS, ACC)}
${P(`M${27 + LR} ${EY - 1} h${53 - 27 - 2 * LR}`, 3.4, ACC)}
${dot(27, EY + 1, 3.8)}${dot(53, EY + 1, 3.8)}
${P(`M${27 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
${P(`M${53 - LR * 0.42} ${EY - LR * 0.52} a${LR * 0.62} ${LR * 0.62} 0 0 1 ${LR * 0.5} -${LR * 0.28}`, 2.4, GLINT)}
${P(`M${CX - 7} ${SMILE_Y} q7 5 14 0`, 3.4, INK)}
<path d="M${CROWN_R} ${BASE} A ${BRIM_RX} ${BRIM_RY} 0 0 1 ${CROWN_R + 2 * BRIM_RX} ${BASE} Z" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
<path d="M6 ${BASE} C 6 ${K}, 74 ${K}, ${CROWN_R} ${BASE} Z" fill="${BLUE}" stroke="${INK}" stroke-width="3.4" stroke-linejoin="round"/>
${insignia(CX, (apex + BASE) / 2 + 0.5, NY_H)}`.replace(/\s+/g, " ").trim()

export const VIEWBOX = "4 -6 106 80"
export const VIEWBOX_SQUARE = "4 -19 106 106"

const lit = s => s
  .replace(/var\(--ink\)/g, "#191c1f").replace(/var\(--acc\)/g, "#2f7d5b")
  .replace(/var\(--lens\)/g, "#eaf3ee").replace(/var\(--glint\)/g, "#ffffff")
  .replace(/var\(--mets-blue\)/g, "#002d72").replace(/var\(--mets-orange\)/g, "#ff5910")

if (import.meta.filename === process.argv[1]) {
  writeFileSync("public/beanbot.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX_SQUARE}" width="106" height="106">${lit(body)}</svg>\n`)
  writeFileSync("logo/final.json", JSON.stringify({ body, viewBox: VIEWBOX }, null, 1))
  console.log(`Billy · official insignia ${NY_H} tall · half-ellipse brim rx${BRIM_RX} ry${BRIM_RY} from (${CROWN_R}, ${BASE}) to (${CROWN_R + 2 * BRIM_RX}, ${BASE})`)
  console.log(`lens bottom ${EY + LR + 1.9} · smile top ${SMILE_Y} · clearance ${(SMILE_Y - (EY + LR + 1.9)).toFixed(1)}`)
}
