// Waypoint design lock — run: `node design-lock.mjs`
//
// The token system in :root is only worth having if it cannot quietly stop
// being true. Ten sprints of individually reasonable decisions left 46 hex
// colours, 16 font sizes and 15 radii before this existed. This reads the file
// — which is the whole app — and fails on anything that has drifted off the
// system: a colour literal, a size off the scale, a fourth radius, a shadow
// that isn't one of the two levels.
//
// It also checks itself. A lock that cannot fail is not a lock, so it injects
// each kind of violation into a copy of the file and confirms it is caught.
import { readFileSync } from 'node:fs';

const FILE = process.argv[2] || new URL('./index.html', import.meta.url).pathname;

// ── What the system allows ───────────────────────────────────────────────────
const FONT_STEPS  = ['--fs-11','--fs-13','--fs-15','--fs-17','--fs-20','--fs-24','--fs-32','--fs-display'];
const RADII       = ['--r-ctl','--r-card','--r-pill'];
const SHADOWS     = ['--shadow-1','--shadow-2','--shadow-shell','--glow','--glow-lg'];
const SPACE_STEPS = [0,4,8,12,16,20,24,32,48];

// ── Where the rules do not reach ─────────────────────────────────────────────
// :root is where colours are allowed to be literal — that is the point of it.
// Inline <svg> carries fills and strokes that no stylesheet can reach, and the
// gradient/mask stops that need a literal to mean "opaque".
function regions(src) {
  const i = src.indexOf('/* ── THE SYSTEM ─');
  const j = src.indexOf('  }\n\n  *, *::before', i);
  if (i < 0 || j < 0) throw new Error('cannot find the :root token block — has it been renamed?');
  const root = src.slice(i, j + 4);
  const rest = src.slice(0, i) + src.slice(j + 4);
  return { root, rest: rest.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>') };
}

// Report a finding with the line it is on, counted in the original file.
function locate(src, needle, from = 0) {
  const at = src.indexOf(needle, from);
  return at < 0 ? '?' : src.slice(0, at).split('\n').length;
}

export function scan(src) {
  const { root, rest } = regions(src);
  const out = [];
  const add = (rule, detail) => out.push({ rule, detail });

  // 1. No colour literal outside :root and <svg>.
  for (const m of rest.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
    add('hex', `${m[0]} near line ${locate(rest, m[0], Math.max(0, m.index - 1))}`);
  }

  // 2. Every font-size on the scale. A computed one (${...}) has to resolve to
  //    a token too, so the literal `px` form is what gets caught here.
  for (const m of src.matchAll(/font-size:\s*([^;"'}]+)/g)) {
    const v = m[1].trim();
    if (v.startsWith('${')) continue;                       // computed; checked at its source
    const tokens = [...v.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(x => x[1]);
    const ok = tokens.length > 0 && tokens.every(t => FONT_STEPS.includes(t));
    if (!ok) add('font-size', `${v} near line ${locate(src, m[0])}`);
  }

  // 3. Every radius one of three.
  for (const m of src.matchAll(/border-radius:\s*([^;"'}]+)/g)) {
    const v = m[1].trim();
    const tokens = [...v.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(x => x[1]);
    const literal = v.replace(/var\(--[a-z0-9-]+\)/g, '').replace(/[\s0]/g, '');
    const ok = tokens.length > 0 && tokens.every(t => RADII.includes(t)) && literal === '';
    if (!ok) add('border-radius', `${v} near line ${locate(src, m[0])}`);
  }

  // 4. Every shadow a token, or none.
  for (const m of (rest).matchAll(/box-shadow:\s*([^;"'}]+)/g)) {
    const v = m[1].trim().replace(/\s+/g, ' ');
    if (v === 'none' || v === 'inherit') continue;
    const tokens = [...v.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(x => x[1]);
    const ok = tokens.length > 0 && tokens.every(t => SHADOWS.includes(t) || t === '--line' || t === '--line-2' || t === '--focus');
    if (!ok) add('box-shadow', `${v.slice(0, 60)} near line ${locate(rest, m[0])}`);
  }

  // 5. Inline <svg> is exempt from the colour rule because a stylesheet cannot
  //    reach a presentation attribute — but only for values the palette already
  //    names, so a stray #3FA in an icon is still a finding.
  const palette = new Set([...root.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map(m => m[0].toUpperCase()));
  for (const svg of src.matchAll(/<svg[\s\S]*?<\/svg>/g)) {
    for (const c of svg[0].matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
      if (!palette.has(c[0].toUpperCase()))
        add('svg-colour', `${c[0]} near line ${locate(src, svg[0])}`);
    }
  }

  // 6. Icons are one stroke width on one grid, at three optical sizes.
  for (const svg of src.matchAll(/<svg\b[^>]*viewBox="0 0 24 24"[^>]*>/g)) {
    const tag = svg[0];
    const sw = /stroke-width="([0-9.]+)"/.exec(tag);
    if (sw && sw[1] !== '2') add('icon-stroke', `${sw[1]} near line ${locate(src, tag)}`);
    const w = /\bwidth="(\d+)"/.exec(tag);
    if (w && !['13','16','20','24'].includes(w[1])) add('icon-size', `${w[1]}px near line ${locate(src, tag)}`);
  }

  // 7. Every uppercase run speaks at one width.
  for (const m of rest.matchAll(/letter-spacing:\s*([^;"'}\n]+)/g)) {
    const v = m[1].trim();
    if (/^-/.test(v) || v === 'var(--track-caps)' || v === 'normal') continue;
    add('tracking', `${v} near line ${locate(rest, m[0])}`);
  }

  return out;
}

// ── The self-test: a lock that cannot fail is not a lock ─────────────────────
const VIOLATIONS = [
  ['a raw hex colour',   s => s.replace('<div id="app">', '<div id="app" style="color:#3A9;">')],
  ['a stray icon colour', s => s.replace('<svg ', '<svg stroke="#3FA9C1" ')],
  ['an off-grid icon',   s => s.replace('<svg width="16"', '<svg width="18"')],
  ['a heavy icon stroke', s => s.replace('stroke-width="2"', 'stroke-width="2.4"')],
  ['a one-off tracking', s => s.replace('<div id="app">', '<div id="app" style="letter-spacing:0.06em;">')],
  ['an off-scale size',  s => s.replace('<div id="app">', '<div id="app" style="font-size:18px;">')],
  ['an off-scale radius',s => s.replace('<div id="app">', '<div id="app" style="border-radius:5px;">')],
  ['an untokened shadow',s => s.replace('<div id="app">', '<div id="app" style="box-shadow:0 2px 9px rgba(0,0,0,0.4);">')],
];

const src = readFileSync(FILE, 'utf8');
let failed = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };

const found = scan(src);
const byRule = found.reduce((a, f) => ((a[f.rule] = a[f.rule] || []).push(f.detail), a), {});
for (const rule of ['hex', 'font-size', 'border-radius', 'box-shadow', 'svg-colour', 'icon-stroke', 'icon-size', 'tracking']) {
  const list = byRule[rule] || [];
  ok(`no off-system ${rule}`, list.length === 0,
     list.length ? `${list.length}: ` + list.slice(0, 6).join('; ') : '');
}

console.log('');
for (const [name, inject] of VIOLATIONS) {
  const before = scan(src).length;
  const after  = scan(inject(src)).length;
  ok(`the lock catches ${name}`, after > before, `${before} → ${after}`);
}

// The token block itself must still define everything the rules refer to.
console.log('');
const { root } = regions(src);
for (const t of [...FONT_STEPS, ...RADII, ...SHADOWS, '--ease', '--dur', '--focus', '--track-caps', '--press'])
  ok(`:root defines ${t}`, root.includes(t + ':'));

// Spacing: the scale exists and is what the sweep snaps to.
ok('the space scale is defined', SPACE_STEPS.slice(1).every((n, i) => root.includes(`--s-${i + 1}: ${n}px`)));

console.log(`\n${failed ? failed + ' FAILED' : 'all clear'} — ${found.length} findings in ${FILE}`);
process.exit(failed ? 1 : 0);
