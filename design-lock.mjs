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
const FONT_STEPS  = ['--fs-11','--fs-13','--fs-15','--fs-17','--fs-20','--fs-24','--fs-32'];
const RADII       = ['--r-ctl','--r-card','--r-pill'];
const SHADOWS     = ['--shadow-1','--shadow-2','--shadow-shell','--glow','--glow-lg'];
const SPACE_STEPS = [0,4,8,12,16,20,24,32,48];

// ── Where the rules do not reach ─────────────────────────────────────────────
// :root is where colours are allowed to be literal — that is the point of it.
// Inline <svg> carries fills and strokes that no stylesheet can reach, and the
// gradient/mask stops that need a literal to mean "opaque".
//
// The mask exemption used to be a claim in this comment rather than a line of
// code; it is now actually implemented, because rule 1b below would otherwise
// fail on rgba(0,0,0,1) in a mask, where the literal means "keep this pixel"
// and not a colour at all.
function regions(src) {
  const i = src.indexOf('/* ── THE SYSTEM ─');
  const j = src.indexOf('  }\n\n  *, *::before', i);
  if (i < 0 || j < 0) throw new Error('cannot find the :root token block — has it been renamed?');
  const root = src.slice(i, j + 4);
  const rest = src.slice(0, i) + src.slice(j + 4);
  return {
    root,
    rest: rest
      .replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>')
      .replace(/(-webkit-)?mask-image:[^;]*;/g, 'mask-image:;')
      .replace(/<meta name="theme-color"[^>]*>/g, '<meta theme-color>'),
  };
}

// ── Where the voice rules apply ─────────────────────────────────────────────
// The question bank is content, not chrome. "ATP → cAMP" and "5′→3′" are how
// chemistry is written, and a student reads them as chemistry. So the copy
// rules below run over everything EXCEPT the bank and the comments — which is
// to say, over the strings the interface says in its own voice.
function uiVoice(src) {
  let v = src;
  const cut = (startRe, endMark) => {
    const i = v.search(startRe);
    if (i < 0) return;
    const j = v.indexOf(endMark, i);
    if (j > 0) v = v.slice(0, i) + v.slice(j + endMark.length);
  };
  cut(/^const QUESTIONS = \[/m, '\n];');
  cut(/^const TWISTS = \{/m, '\n};');
  // Comments are not said out loud — including the ones trailing a line of
  // code, which is where the question picks keep their "ETC toxin · Tay-Sachs"
  // notes. The lookbehind spares "https://".
  // A block comment opens after whitespace or an opening bracket, never mid-
  // token. `accept="image/*"` is not a comment, and treating it as one paired
  // its "/*" with a real "*/" 165,000 characters later — silently deleting the
  // course picker, the Route, Settings and the share card from everything
  // below, which is to say from every voice rule. The rules passed because
  // they were looking at a third less app than they thought.
  v = v.replace(/<!--[\s\S]*?-->/g, '')
       .replace(/(^|[\s{;(])\/\*[\s\S]*?\*\//g, '$1')
       .replace(/(?<!:)\/\/.*$/gm, '');
  return v;
}

// A short allow-list, one reason each. It should stay short.
const VOICE_ALLOW = [
  // The AAMC disclaimer is quoted wording and is not ours to restyle.
  'MCAT® is a registered trademark',
  // A course row carries two facts about one thing: the code printed on the
  // student's schedule and the title that says which class it is. That is the
  // case the middle dot is actually for, and it is the only one in the app —
  // the rule exists to stop two UNRELATED facts being welded together.
  'ccard-title',
];

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

  // 1b. And no rgb()/rgba()/hsl() literal either. This is the rule that was
  //     missing: the lock checked hex only, so for ten sprints colour drifted
  //     in through rgba unchecked — 213 of them outside :root by the time the
  //     app was repapered, in seventeen colour families at sixty-four alphas,
  //     including eleven different greens. A palette is only a palette if the
  //     translucent tints are in it too, so these have to be tokens as well.
  for (const m of rest.matchAll(/\b(?:rgba?|hsla?)\([^)]*\)/g)) {
    add('rgb', `${m[0]} near line ${locate(rest, m[0], Math.max(0, m.index - 1))}`);
  }

  // 1c. The voice rules. Each of these was a habit the interface had rather
  //     than a thing it meant: an arrow after a button label that already said
  //     where it went, a label shouted in capitals above the heading it
  //     restated, two unrelated facts joined by a middle dot, and one section
  //     of the exam coloured as though it were a different product.
  const voice = uiVoice(src)
    .split('\n')
    .filter(l => !VOICE_ALLOW.some(a => l.includes(a)))
    .join('\n');
  // Both directions. A back button is already a back button, and "←" was the
  // same habit pointing the other way.
  for (const m of voice.matchAll(/→|←|&rarr;|&larr;/g))
    add('arrow', `an arrow in UI copy near line ${locate(voice, m[0], Math.max(0, m.index - 1))}`);
  for (const m of voice.matchAll(/text-transform:\s*uppercase/g))
    add('shouting', `uppercase near line ${locate(voice, m[0], Math.max(0, m.index - 1))}`);
  for (const m of voice.matchAll(/ · /g))
    add('middle-dot', `a " · " meta string near line ${locate(voice, m[0], Math.max(0, m.index - 1))}`);
  for (const m of voice.matchAll(/var\(--violet[a-z-]*\)/g))
    add('violet', `${m[0]} near line ${locate(voice, m[0], Math.max(0, m.index - 1))}`);

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

  // 5b. theme-color is the one colour the browser reads before any CSS exists,
  //     so it cannot be a var() — but it can still be required to be a colour
  //     the palette actually names, which is what keeps the phone's chrome and
  //     the page the same paper.
  const theme = /<meta name="theme-color"[^>]*content="(#[0-9A-Fa-f]{3,8})"/.exec(src);
  if (!theme) add('theme-color', 'no <meta name="theme-color"> declared');
  else if (!palette.has(theme[1].toUpperCase()))
    add('theme-color', `${theme[1]} is not in the palette`);

  // 6. Icons are one stroke width on one grid, at three optical sizes.
  for (const svg of src.matchAll(/<svg\b[^>]*viewBox="0 0 24 24"[^>]*>/g)) {
    const tag = svg[0];
    const sw = /stroke-width="([0-9.]+)"/.exec(tag);
    if (sw && sw[1] !== '2') add('icon-stroke', `${sw[1]} near line ${locate(src, tag)}`);
    const w = /\bwidth="(\d+)"/.exec(tag);
    if (w && !['13','16','20','24'].includes(w[1])) add('icon-size', `${w[1]}px near line ${locate(src, tag)}`);
  }

  // 7. No positive tracking. It existed for the small-caps eyebrows, and with
  //    those gone the only letter-spacing left is the negative kind that tightens
  //    a headline. Loosened tracking on lowercase text is how a shouted label
  //    comes back wearing a different hat.
  for (const m of rest.matchAll(/letter-spacing:\s*([^;"'}\n]+)/g)) {
    const v = m[1].trim();
    if (/^-/.test(v) || v === 'normal') continue;
    add('tracking', `${v} near line ${locate(rest, m[0])}`);
  }

  return out;
}

// ── The self-test: a lock that cannot fail is not a lock ─────────────────────
const VIOLATIONS = [
  ['a raw hex colour',   s => s.replace('<div id="app">', '<div id="app" style="color:#3A9;">')],
  ['a raw rgba colour',  s => s.replace('<div id="app">', '<div id="app" style="color:rgba(1,2,3,0.5);">')],
  ['a stray icon colour', s => s.replace('<svg ', '<svg stroke="#3FA9C1" ')],
  ['an off-palette theme-color', s => s.replace(/(<meta name="theme-color" content=")#[0-9A-Fa-f]+/, '$1#ABCDEF')],
  ['an arrow in UI copy', s => s.replace('<div id="app">', '<div id="app">Continue →')],
  ['a shouted label',    s => s.replace('<div id="app">', '<div id="app" style="text-transform: uppercase;">')],
  ['a middle-dot string', s => s.replace('<div id="app">', '<div id="app">Free · fast')],
  ['a violet token',     s => s.replace('<div id="app">', '<div id="app" style="color:var(--violet);">')],
  ['an off-grid icon',   s => s.replace('<svg width="16"', '<svg width="18"')],
  ['a heavy icon stroke', s => s.replace('stroke-width="2"', 'stroke-width="2.4"')],
  ['any positive tracking', s => s.replace('<div id="app">', '<div id="app" style="letter-spacing:0.06em;">')],
  ['an off-scale size',  s => s.replace('<div id="app">', '<div id="app" style="font-size:18px;">')],
  ['an off-scale radius',s => s.replace('<div id="app">', '<div id="app" style="border-radius:5px;">')],
  ['an untokened shadow',s => s.replace('<div id="app">', '<div id="app" style="box-shadow:0 2px 9px rgba(0,0,0,0.4);">')],
];

const src = readFileSync(FILE, 'utf8');

// ── Outbound study links, printed for review ────────────────────────────────
// Not fetched: this check stays offline, so a flaky network can never redden
// it and a working one can never green it by accident. The point is that every
// URL leaving the app passes under a human eye before it ships, and that the
// Anki tags still waiting on the deck are impossible to forget.
function printStudyLinks(source) {
  const urls = [...source.matchAll(/url: '(https:\/\/[^']+)'/g)].map(m => m[1]);
  const aamc = /AAMC_PREP_URL = '(https:\/\/[^']+)'/.exec(source);
  const course = /KHAN_COURSE = '(https:\/\/[^']+)'/.exec(source);
  const all = [...new Set([...urls, course && course[1], aamc && aamc[1]].filter(Boolean))];
  if (!all.length) return;
  const checked = /KHAN_CHECKED = '([\d-]+)'/.exec(source);
  console.log(checked
    ? `\nStudy links — last opened by hand on ${checked[1]}; none is fetched here:`
    : '\nStudy links — UNDATED, so nobody has opened these; none is fetched here:');
  for (const u of all) console.log('  ' + u);

  const tags = [...source.matchAll(/'(\d+[A-Z])': (null|'[^']*')/g)];
  const missing = tags.filter(([, , v]) => v === 'null').map(([, c]) => c);
  if (missing.length) {
    console.log(`\nTODO(Drew) — ${missing.length} AnKing tags still unconfirmed, so those parcels show no Anki line:`);
    console.log('  ' + missing.join(' '));
    console.log('  Copy each from the deck\'s AAMC Content Outline tag tree, exactly as written.');
  }
}

// ── Every school catalog, printed for review ────────────────────────────────
// Same reason as the study links: a table of somebody else's course codes is
// only as good as the last time a person read it, and the rows still waiting
// on an answer have to be impossible to forget.
//
// Discovered, not listed. A second school was added the day after the first
// one shipped; a printer that knows the name of one of them prints half the
// table and says nothing about the half it missed.
function schoolCatalogs(source) {
  const out = [];
  for (const m of source.matchAll(/const ([A-Z][A-Z0-9_]*)_COURSES = \[([\s\S]*?)\n\]\.map\(/g)) {
    if (m[1] === 'GENERIC') continue;          // derived from TOPICS, nothing to read
    out.push({
      key: m[1],
      rows: m[2].split(/\n  \{ /).slice(1).map(chunk => ({
        id:     (/id:'([^']+)'/.exec(chunk) || [])[1],
        code:   (/code:'([^']+)'/.exec(chunk) || [])[1],
        title:  (/title:'([^']+)'/.exec(chunk) || [])[1],
        covers: ((/covers: \[([^\]]*)\]/.exec(chunk) || [, ''])[1].match(/'([^']+)'/g) || []).map(x => x.slice(1, -1)),
        // Two kinds of empty: answered with nothing, and not answered at all.
        nothing:(/(?:^|[\s,{])nothing:'([^']+)'/m.exec(chunk) || [])[1] || null,
        todo:   (/(?:^|[\s,{])todo:'([^']+)'/m.exec(chunk) || [])[1] || null,
        // A row whose coverage rests on a reading rather than a quotation
        // carries inferred: true, and the check repeats it where it cannot be
        // missed. Thin evidence should cost a line of output every run.
        //
        // A FIELD, not a word in the prose. The first version of this grepped
        // the note for "inferred" and flagged the one Utah row whose note says
        // "Quoted, not inferred" — the exact opposite of what it reported.
        inferred: /(?:^|[\s,{])inferred: true/m.test(chunk),
      })),
      // The display name and the date somebody last read the catalog, from the
      // CATALOGS entry rather than from the array.
      name:    (new RegExp("\\n  " + m[1].toLowerCase() + ": \\{[\\s\\S]*?name: '([^']+)'").exec(source) || [])[1] || m[1],
      checked: (new RegExp("\\n  " + m[1].toLowerCase() + ": \\{[\\s\\S]*?retrieved: '([\\d-]+)'").exec(source) || [])[1],
    });
  }
  return out;
}

function printCatalog(source) {
  for (const cat of schoolCatalogs(source)) {
    console.log(`\n${cat.name} — ${cat.rows.length} rows, read${cat.checked ? ' on ' + cat.checked : ''}:`);
    for (const r of cat.rows)
      console.log('  ' + (r.code || '?').padEnd(28)
        + (r.covers.length ? r.covers.join(' ') : r.nothing ? 'no MCAT content' : 'NOT ANSWERED')
        + (r.inferred && r.covers.length ? '   (inferred, not quoted)' : ''));
    const open = cat.rows.filter(r => !r.covers.length && !r.nothing);
    if (open.length) {
      console.log(`\nTODO(Drew) — ${open.length} ${cat.name} rows have no topics yet, so they add nothing to that student's coverage:`);
      for (const r of open) console.log(`  ${(r.code || '?').padEnd(28)} ${r.todo || 'no question recorded'}`);
    }
  }
}

let failed = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); if (!c) failed++; };

const found = scan(src);
const byRule = found.reduce((a, f) => ((a[f.rule] = a[f.rule] || []).push(f.detail), a), {});
for (const rule of ['hex', 'rgb', 'arrow', 'shouting', 'middle-dot', 'violet', 'font-size', 'border-radius', 'box-shadow', 'svg-colour', 'theme-color', 'icon-stroke', 'icon-size', 'tracking']) {
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
for (const t of [...FONT_STEPS, ...RADII, ...SHADOWS, '--ease', '--dur', '--focus', '--press'])
  ok(`:root defines ${t}`, root.includes(t + ':'));

// Spacing: the scale exists and is what the sweep snaps to.
ok('the space scale is defined', SPACE_STEPS.slice(1).every((n, i) => root.includes(`--s-${i + 1}: ${n}px`)));

// Two concepts sharing one URL is the shape of the bug that shipped: concept 9
// pointed at concept 10's unit, so one parcel sent students to the wrong
// lesson and another's was unreachable. Nothing in a palette scan can see
// that, and a reader comparing ten long slugs by eye will not either.
console.log('');
{
  const units = [...src.matchAll(/^\s+\d+:\s+\{ title: '[^']+',\s+url: '([^']+)' \},$/gm)].map(m => m[1]);
  const dupes = units.filter((u, i) => units.indexOf(u) !== i);
  ok('every Khan concept has its own unit', units.length >= 10 && dupes.length === 0,
     units.length < 10 ? `only parsed ${units.length} units` : dupes.length ? 'shared: ' + [...new Set(dupes)].join(', ') : `${units.length} distinct`);
  const checked = /KHAN_CHECKED = '(\d{4}-\d{2}-\d{2})'/.exec(src);
  ok('the study links carry the date they were opened', !!checked, checked ? checked[1] : 'KHAN_CHECKED is missing or malformed');
}

// A `covers` entry that names no real topic is silent: the course simply
// covers nothing, and a BYU student's map is quietly short by that much.
console.log('');
{
  const cats = schoolCatalogs(src);
  const tblock = /const TOPICS = \[([\s\S]*?)\n\];/.exec(src);
  const topicIds = new Set(((tblock ? tblock[1] : '').match(/id:'([a-z0-9-]+)'/g) || []).map(x => x.slice(4, -1)));
  const weights = [...(tblock ? tblock[1] : '').matchAll(/id:'([a-z0-9-]+)',\s*name:'[^']*',\s*w:(\d+)/g)]
    .map(m => ({ id: m[1], w: +m[2] }));
  const whole = weights.filter(t => t.id !== 'cars').reduce((n, t) => n + t.w, 0);

  ok('every school catalog is readable', cats.length > 0, `${cats.length} found`);
  // Ids are unique ACROSS catalogs, not just within one. Both lists live in the
  // same wp_courses array so a student can switch school and find their old
  // answers intact, and a collision would silently select a course at a school
  // they have never been to.
  const seen = new Map(), collide = [];
  for (const cat of cats) for (const r of cat.rows) {
    if (seen.has(r.id)) collide.push(`${r.id} in ${seen.get(r.id)} and ${cat.name}`);
    else seen.set(r.id, cat.name);
  }
  ok('every course id is its own, across catalogs', collide.length === 0, collide.join('; '));

  for (const cat of cats) {
    const bad = [];
    for (const r of cat.rows) for (const c of r.covers) if (!topicIds.has(c)) bad.push(`${r.code} → ${c}`);
    ok(`${cat.name}: every row covers real topics`, cat.rows.length > 0 && bad.length === 0,
       cat.rows.length === 0 ? 'no rows parsed' : bad.length ? bad.join('; ') : `${cat.rows.length} rows`);
    // An empty row has to say WHICH empty it is. "Answered: nothing" and
    // "nobody has said yet" look identical in the data and mean opposite
    // things, and the second is the one that must never go quiet.
    const silent = cat.rows.filter(r => !r.covers.length && !r.todo && !r.nothing).map(r => r.code);
    ok(`${cat.name}: every empty row says which kind of empty`, silent.length === 0, silent.join(', '));
    const both = cat.rows.filter(r => r.todo && r.nothing).map(r => r.code);
    ok(`${cat.name}: no row is answered and unanswered at once`, both.length === 0, both.join(', '));
    // The reachable ceiling. Every weighted topic this catalog can cover,
    // against every weighted topic there is — so a row quietly going empty
    // shows up as a number rather than as a student's map being short for no
    // stated reason.
    const covered = new Set(cat.rows.flatMap(r => r.covers));
    const reach = weights.filter(t => covered.has(t.id)).reduce((n, t) => n + t.w, 0);
    ok(`${cat.name}: coursework can reach the whole exam`, weights.length > 0 && reach === whole,
       weights.length === 0 ? 'could not read the weights' : `${reach}% of ${whole}% outside CARS`);
  }
}

printStudyLinks(src);
printCatalog(src);

console.log(`\n${failed ? failed + ' FAILED' : 'all clear'} — ${found.length} findings in ${FILE}`);
process.exit(failed ? 1 : 0);
