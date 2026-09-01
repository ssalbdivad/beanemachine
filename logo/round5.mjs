// Round 5: head-only Beanbot, with the glasses made unmistakable.
// What actually signals "glasses" rather than "big eyes":
//   1. temple arms reaching back to the head edge   2. a real bridge over the nose
//   3. frames in a different colour from the head    4. a glint, so the lens reads as glass
//   5. pupils visibly *behind* the lens
import { writeFileSync } from "node:fs"
const INK = "var(--ink)", ACC = "var(--acc)", LENS = "var(--lens)", GLINT = "var(--glint)"
const c = []
const add = (n, body, note = "") => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${n}`, body, note })

const P = (d, w = 3.6, col = INK) =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const rr = (x, y, w, h, r, sw = 3.8, fill = "none", col = INK) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const ci = (x, y, r, sw = 3.8, fill = "none", col = INK) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const dot = (x, y, r, col = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`

const HEAD_L = 15, HEAD_R = 73, EY = 37
const head = () => rr(HEAD_L, 15, HEAD_R - HEAD_L, 45, 15)
const antenna = () => P("M44 15 v-6", 3.6) + dot(44, 6.4, 3.8, ACC)
const smile = (y = 51, w = 7) => P(`M${44 - w} ${y} q${w} ${w * 0.72} ${w * 2} 0`, 3.4, INK)
const glint = (cx, cy, r) => P(`M${cx - r * 0.42} ${cy - r * 0.52} a${r * 0.62} ${r * 0.62} 0 0 1 ${r * 0.5} -${r * 0.28}`, 2.4, GLINT)

// lens shapes
const lens = {
  round: (cx, cy, r, fr) => ci(cx, cy, r, 3.8, LENS, fr),
  squarish: (cx, cy, r, fr) => rr(cx - r, cy - r * 0.88, r * 2, r * 1.76, r * 0.5, 3.8, LENS, fr),
  hex: (cx, cy, r, fr) =>
    `<path d="M${cx - r} ${cy - r * 0.4} L${cx - r * 0.5} ${cy - r * 0.9} H${cx + r * 0.5} L${cx + r} ${cy - r * 0.4} V${cy + r * 0.4} L${cx + r * 0.5} ${cy + r * 0.9} H${cx - r * 0.5} L${cx - r} ${cy + r * 0.4} Z" fill="${LENS}" stroke="${fr}" stroke-width="3.8" stroke-linejoin="round"/>`
}
const bridge = {
  bar:    (lx, rx, y, r) => P(`M${lx + r} ${y - 1} h${rx - lx - 2 * r}`, 3.4, ACC),
  arch:   (lx, rx, y, r) => P(`M${lx + r} ${y - 1} q${(rx - lx - 2 * r) / 2} -5 ${rx - lx - 2 * r} 0`, 3.4, ACC),
  double: (lx, rx, y, r) => P(`M${lx + r} ${y - 3} h${rx - lx - 2 * r}`, 2.8, ACC) + P(`M${lx + r} ${y + 2} h${rx - lx - 2 * r}`, 2.8, ACC)
}
// the temple arm: the single clearest "these are glasses" cue
const temples = {
  stub:  (lx, rx, y, r) => P(`M${lx - r} ${y - 1} H${HEAD_L + 1}`, 3.4, ACC) + P(`M${rx + r} ${y - 1} H${HEAD_R - 1}`, 3.4, ACC),
  hook:  (lx, rx, y, r) => P(`M${lx - r} ${y - 2} H${HEAD_L + 3} l-3 4`, 3.4, ACC) + P(`M${rx + r} ${y - 2} H${HEAD_R - 3} l3 4`, 3.4, ACC),
  past:  (lx, rx, y, r) => P(`M${lx - r} ${y - 1} H${HEAD_L - 5}`, 3.4, ACC) + P(`M${rx + r} ${y - 1} H${HEAD_R + 5}`, 3.4, ACC),
  none:  () => ""
}

const bust = (ls, br, tp, { r = 12, lx = 31, rx = 57, fr = ACC, glints = true, brow = false } = {}) =>
  `${antenna()}${head()}
   ${brow ? P(`M${lx - r} ${EY - r - 4} q${r} -4 ${r * 2} 0`, 3, INK) + P(`M${rx - r} ${EY - r - 4} q${r} -4 ${r * 2} 0`, 3, INK) : ""}
   ${temples[tp](lx, rx, EY, r)}
   ${lens[ls](lx, EY, r, fr)}${lens[ls](rx, EY, r, fr)}
   ${bridge[br](lx, rx, EY, r)}
   ${dot(lx, EY + 1, 4)}${dot(rx, EY + 1, 4)}
   ${glints ? glint(lx, EY, r) + glint(rx, EY, r) : ""}
   ${smile()}`

/* explore what makes the specs read */
for (const tp of ["stub", "hook", "past", "none"])
  add(`round-bar-${tp}`, bust("round", "bar", tp), `round lens · bar bridge · ${tp} temples`)
for (const tp of ["stub", "hook", "past"])
  add(`round-arch-${tp}`, bust("round", "arch", tp), `round · arch bridge · ${tp}`)
for (const tp of ["stub", "hook", "past"])
  add(`squarish-bar-${tp}`, bust("squarish", "bar", tp), `squarish lens · ${tp}`)
for (const tp of ["stub", "hook"])
  add(`hex-bar-${tp}`, bust("hex", "bar", tp), `hex lens · ${tp}`)
add("round-double-hook", bust("round", "double", "hook"), "double bridge")
add("round-bar-hook-noglint", bust("round", "bar", "hook", { glints: false }), "no glint")
add("round-bar-hook-brow", bust("round", "bar", "hook", { brow: true }), "with brows")
add("big-round-hook", bust("round", "bar", "hook", { r: 13.5, lx: 30, rx: 58 }), "oversized lenses")
add("small-round-hook", bust("round", "bar", "hook", { r: 10, lx: 32, rx: 56 }), "smaller lenses")
add("round-ink-frames", bust("round", "bar", "hook", { fr: INK }), "ink frames, not green")
add("wide-set-hook", bust("round", "bar", "hook", { r: 12, lx: 29, rx: 59 }), "wider set")
add("close-set-hook", bust("round", "bar", "hook", { r: 12, lx: 33, rx: 55 }), "closer set")

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="0 0 88 72" width="132" height="108">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 88 72" width="34" height="28">${body}</svg>
      <svg viewBox="0 0 88 72" width="22" height="18">${body}</svg>
      <svg viewBox="0 0 88 72" width="16" height="13">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet5.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--lens:#eaf3ee;--glint:#ffffff}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:9px 4px}
.small{display:flex;align-items:center;gap:9px}
figcaption{font-size:9.5px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:8.5px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates5.json", JSON.stringify(c, null, 1))
console.log(`round 5: ${c.length} head-only variants`)
