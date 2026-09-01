// Round 3: cutie-patootie robot, Blitzcrank-adjacent — chunky rounded plates,
// oversized head, big glasses, and it's examining a beanball (circle + S crease,
// which reads as coffee bean and baseball seam at once).
import { writeFileSync } from "node:fs"
const INK = "var(--ink)", ACC = "var(--acc)", GLASS = "var(--glass)", WARM = "var(--warm)"
const c = []
const add = (n, body, note = "") => c.push({ n: `${String(c.length + 1).padStart(2, "0")} ${n}`, body, note })

const P = (d, w = 3.4, col = INK, extra = "") =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`
const rr = (x, y, w, h, r, sw = 3.4, fill = "none", col = INK) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const ci = (x, y, r, sw = 3.4, fill = "none", col = INK) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${col}" stroke-width="${sw}"/>`
const dot = (x, y, r, col = INK) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>`
// the beanball: one S-curve = bean crease = baseball seam
const beanball = (cx, cy, r, sw = 3) =>
  ci(cx, cy, r, sw) + P(`M${cx} ${cy - r} C ${cx - r * 0.85} ${cy - r * 0.45}, ${cx + r * 0.85} ${cy + r * 0.45}, ${cx} ${cy + r}`, sw * 0.92, ACC)

/* ---------- parts ---------- */
const heads = {
  boxy:   (x, y, w, h) => rr(x, y, w, h, 12),
  round:  (x, y, w, h) => ci(x + w / 2, y + h / 2, Math.min(w, h) / 2 + 2),
  dome:   (x, y, w, h) => P(`M${x} ${y + h - 6} v-${h / 2 - 4} a${w / 2} ${h / 2 - 2} 0 0 1 ${w} 0 v${h / 2 - 4} a6 6 0 0 1 -6 6 h-${w - 12} a6 6 0 0 1 -6 -6 z`),
  capsule:(x, y, w, h) => rr(x, y, w, h, h / 2)
}
const glasses = {
  round: (lx, rx, y, r) =>
    ci(lx, y, r, 3.2, "var(--lens)", ACC) + ci(rx, y, r, 3.2, "var(--lens)", ACC) +
    P(`M${lx + r} ${y} h${rx - lx - 2 * r}`, 3, ACC) + dot(lx, y, 2.4) + dot(rx, y, 2.4),
  square: (lx, rx, y, r) =>
    rr(lx - r, y - r * 0.85, r * 2, r * 1.7, 4, 3.2, "var(--lens)", ACC) +
    rr(rx - r, y - r * 0.85, r * 2, r * 1.7, 4, 3.2, "var(--lens)", ACC) +
    P(`M${lx + r} ${y} h${rx - lx - 2 * r}`, 3, ACC) + dot(lx, y, 2.4) + dot(rx, y, 2.4),
  goggle: (lx, rx, y, r) =>
    ci(lx, y, r + 1.5, 4, "var(--lens)", ACC) + ci(rx, y, r + 1.5, 4, "var(--lens)", ACC) +
    P(`M${lx + r + 1} ${y} h${rx - lx - 2 * r - 2}`, 4, ACC) + dot(lx, y, 2.6) + dot(rx, y, 2.6),
  visor: (lx, rx, y, r) =>
    rr(lx - r - 2, y - r * 0.9, rx - lx + 2 * r + 4, r * 1.8, r * 0.9, 3.2, "var(--lens)", ACC) +
    dot(lx, y, 2.6) + dot(rx, y, 2.6)
}
const antennas = {
  straight: (x, y) => P(`M${x} ${y} v-7`, 3.2) + dot(x, y - 9.5, 3.2, ACC),
  bent:     (x, y) => P(`M${x} ${y} v-4 l5 -4`, 3.2) + dot(x + 6.5, y - 9.5, 3.2, ACC),
  twin:     (x, y) => P(`M${x - 7} ${y} l-3 -6`, 3) + P(`M${x + 7} ${y} l3 -6`, 3) + dot(x - 11, y - 7.5, 2.8, ACC) + dot(x + 11, y - 7.5, 2.8, ACC),
  none:     () => ""
}
const mouths = {
  smile: (x, y, w) => P(`M${x - w} ${y} q${w} ${w * 0.62} ${w * 2} 0`, 3, INK),
  grill: (x, y, w) => P(`M${x - w} ${y} h${w * 2}`, 3, INK) + P(`M${x - w * 0.4} ${y - 3} v6`, 2.4) + P(`M${x + w * 0.4} ${y - 3} v6`, 2.4),
  none:  () => ""
}
// chunky Blitzcrank shoulders + pincer holding the beanball
const bodyWithPincer = (cx, top, bw, ballAt) =>
  rr(cx - bw / 2, top, bw, 22, 9) +
  P(`M${cx - bw / 2 - 1} ${top + 7} h-8 a5 5 0 0 0 -5 5 v6`, 3.4) +
  P(`M${cx + bw / 2 + 1} ${top + 7} h8 a5 5 0 0 1 5 5 v4`, 3.4) +
  P(`M${ballAt[0] - 7} ${ballAt[1] - 6} a8 8 0 0 0 0 12`, 3.2) +
  beanball(ballAt[0], ballAt[1], 9)

/* ---------- A. head-only busts (the actual logo candidates) ---------- */
for (const hk of ["boxy", "round", "dome", "capsule"])
  for (const gk of ["round", "square", "goggle", "visor"])
    add(`bust-${hk}-${gk}`,
      `${antennas.straight(48, 20)}${heads[hk](22, 20, 52, 42)}${glasses[gk](38, 58, 38, 9)}${mouths.smile(48, 52, 7)}
       ${P("M22 40 h-6", 3.2)}${P("M74 40 h6", 3.2)}`,
      `${hk} head · ${gk} glasses`)

/* ---------- B. full mascot: robot inspecting a beanball ---------- */
for (const hk of ["boxy", "round"])
  for (const gk of ["round", "goggle"])
    for (const ak of ["straight", "bent"])
      add(`mascot-${hk}-${gk}-${ak}`,
        `${antennas[ak](40, 14)}${heads[hk](22, 14, 36, 28)}${glasses[gk](32, 48, 27, 6.5)}${mouths.smile(40, 37, 4.5)}
         ${bodyWithPincer(38, 46, 30, [66, 58])}`,
        `mascot · ${hk} · ${gk} · ${ak} antenna`)

/* ---------- C. head + hands cupping the beanball underneath ---------- */
for (const gk of ["round", "goggle", "square"])
  for (const hk of ["boxy", "capsule"])
    add(`cupped-${hk}-${gk}`,
      `${antennas.straight(48, 16)}${heads[hk](24, 16, 48, 34)}${glasses[gk](40, 58, 32, 8)}
       ${P("M30 56 a10 10 0 0 0 10 10 h16 a10 10 0 0 0 10 -10", 3.4)}
       ${beanball(48, 60, 10)}`,
      `cupping the bean · ${hk} · ${gk}`)

/* ---------- D. beanball as the robot's own belly/chest ---------- */
for (const gk of ["round", "goggle"])
  for (const hk of ["boxy", "dome"])
    add(`belly-${hk}-${gk}`,
      `${antennas.straight(40, 12)}${heads[hk](22, 12, 36, 26)}${glasses[gk](32, 48, 24, 6.5)}
       ${rr(20, 42, 40, 30, 12)}${beanball(40, 57, 11)}
       ${P("M20 50 h-6 v10", 3.2)}${P("M60 50 h6 v10", 3.2)}`,
      `bean is the chest core · ${hk} · ${gk}`)

/* ---------- E. tiny bot peering into a big beanball (analysis) ---------- */
for (const gk of ["round", "goggle"])
  add(`peer-${gk}`,
    `${antennas.straight(20, 24)}${heads.boxy(8, 24, 26, 22)}${glasses[gk](16, 27, 34, 5.5)}
     ${P("M34 40 h4", 3)}${beanball(56, 40, 17, 3.4)}`,
    `little bot, big bean · ${gk}`)

/* ---------- F. glasses pushed up on the forehead (extra cute) ---------- */
for (const hk of ["boxy", "round"])
  add(`pushed-up-${hk}`,
    `${antennas.bent(48, 18)}${heads[hk](24, 18, 48, 38)}
     ${glasses.round(40, 58, 27, 8)}
     ${dot(40, 44, 3.6, INK)}${dot(58, 44, 3.6, INK)}${mouths.smile(49, 50, 6)}`,
    `specs up on the brow · ${hk}`)

const cell = ({ n, body, note }) => `
  <figure>
    <svg viewBox="0 0 96 84" width="118" height="103">${body}</svg>
    <div class="small">
      <svg viewBox="0 0 96 84" width="30" height="26">${body}</svg>
      <svg viewBox="0 0 96 84" width="20" height="18">${body}</svg>
    </div>
    <figcaption>${n}<br><i>${note}</i></figcaption>
  </figure>`

writeFileSync("logo/sheet3.html", `<!doctype html><meta charset="utf-8">
<style>
:root{--ink:#191c1f;--acc:#2f7d5b;--lens:#e8f1ec;--warm:#c2694a;--faint:#b9b2a5}
body{margin:0;background:#faf8f3;font:12px ui-sans-serif,system-ui;color:#6f6a61}
.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;padding:16px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:3px;
  background:#fffdf9;border:1px solid #e5e0d5;border-radius:10px;padding:8px 4px}
.small{display:flex;align-items:flex-end;gap:8px}
figcaption{font-size:9px;text-align:center;line-height:1.3}
i{color:#a09a8e;font-size:8px}
</style>
<div class="grid">${c.map(cell).join("")}</div>`)
writeFileSync("logo/candidates3.json", JSON.stringify(c, null, 1))
console.log(`round 3: ${c.length} robot candidates`)
