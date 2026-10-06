// Waypoint smoke test — run: `node smoke.mjs`  (part of `npm run check`)
//
// The design lock reads the file; this one runs it. That gap is not theoretical:
// a tidy-up that deleted dead markup helpers took wLabel() and EVEN_SPREAD with
// them, because both happened to sit inside the span being cut — and the lock
// passed, because a parse cannot tell that two screens now throw on render.
//
// So this loads the real app in a real browser, walks every screen in every
// state that matters, and fails on anything a student would see as broken: an
// exception, a console error, or a screen with nothing on it.
//
// It is deliberately offline. Supabase, Plausible and Google Fonts are blocked,
// so a flaky network cannot turn the gate red and a working network cannot turn
// it green by accident. Text renders in the fallback face; that is fine, because
// what is being checked is whether there is any text at all.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const FILE = new URL('./index.html', import.meta.url).pathname;
const SRC  = readFileSync(FILE, 'utf8');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('smoke: playwright is not installed. Run `npm install`, then');
  console.error('       `npx playwright install chromium`, and try again.');
  process.exit(1);
}

// ── The states a student can arrive in ───────────────────────────────────────
// The returning student was captured from a real session before practice went
// behind its flag: a streak, a history and a practice record that later phases
// must leave untouched. Inline rather than a fixture file, so the check stays
// one command over a flat repo.
const RETURNING = {
  wp_year: 'junior',
  wp_courses: '["bio1","bio2","gc1","gc2","oc1","psych"]',
  wp_course_status: '{"bio1":"completed","bio2":"completed","gc1":"completed","gc2":"completed","oc1":"in-progress","psych":"in-progress"}',
  wp_streak: '1',
  wp_total: '5',
  wp_history: '[{"date":"Mon Oct 06 2026","correct":0,"total":5}]',
  wp_qstats: '{}',
  wp_topic_last_seen: '{"psych":"2026-10-06"}',
  wp_lastDate: 'Mon Oct 06 2026',
  wp_milestones: '{}',
  wp_cov_milestones: '{}',
};

const JUNIOR = {
  wp_year: RETURNING.wp_year,
  wp_courses: RETURNING.wp_courses,
  wp_course_status: RETURNING.wp_course_status,
};

const STATES = [
  { name: 'cleared',   store: {} },
  { name: 'junior',    store: JUNIOR },
  { name: 'returning', store: RETURNING },
];

// Every screen the router knows about, read from the router rather than listed
// here — a screen added without a line in this file would otherwise go unwalked.
const SCREENS = [...new Set([...SRC.matchAll(/case '([a-z-]+)':\s*(?:S\.screen|html)/g)].map(m => m[1]))];
if (SCREENS.length < 10) {
  console.error(`smoke: only found ${SCREENS.length} screens in the router — has it been restructured?`);
  process.exit(1);
}

// PRACTICE gates the question system. While it exists, both settings are walked,
// because "practice off" is the shipped state and "practice on" is the one the
// flag promises still works.
const HAS_PRACTICE = /^const PRACTICE = (true|false);/m.test(SRC);
const VARIANTS = HAS_PRACTICE
  ? [{ label: 'PRACTICE=false', src: SRC.replace(/^const PRACTICE = (?:true|false);/m, 'const PRACTICE = false;') },
     { label: 'PRACTICE=true',  src: SRC.replace(/^const PRACTICE = (?:true|false);/m, 'const PRACTICE = true;') }]
  : [{ label: 'as written', src: SRC }];

// ── A local origin, so localStorage and history behave as they do in production
let served = SRC;
const server = createServer((req, res) => {
  if (req.url.startsWith('/index.html') || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(served);
  } else {
    res.writeHead(404).end('');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// A request this test cut off is not a finding; a real one is.
const BLOCKED_NOISE = /net::ERR_(FAILED|BLOCKED|ABORTED|CONNECTION|NAME_NOT_RESOLVED|CERT)/i;

const failures = [];
const browser = await chromium.launch();

for (const variant of VARIANTS) {
  served = variant.src;
  for (const state of STATES) {
    const where = `${variant.label} / ${state.name}`;
    const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });

    // Nothing leaves the machine.
    await ctx.route('**', route => {
      route.request().url().startsWith(ORIGIN) ? route.continue() : route.abort();
    });

    const page = await ctx.newPage();
    const seen = [];
    page.on('pageerror', e => seen.push(`threw: ${String(e).split('\n')[0]}`));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (!BLOCKED_NOISE.test(t)) seen.push(`console: ${t.slice(0, 160)}`);
    });

    await page.addInitScript(store => {
      try { localStorage.clear(); } catch (e) { /* private mode */ }
      for (const [k, v] of Object.entries(store)) localStorage.setItem(k, v);
    }, state.store);

    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForTimeout(350);

    for (const screen of SCREENS) {
      seen.length = 0;
      await page.evaluate(s => window.go(s), screen).catch(e => seen.push(`go() threw: ${e.message}`));
      await page.waitForTimeout(140);
      const text = await page.evaluate(() => (document.getElementById('app')?.innerText || '').trim().length)
                             .catch(() => 0);
      if (text < 20) seen.push(`renders ${text} characters`);
      for (const f of seen) failures.push(`${where}  ${screen}: ${f}`);
    }

    await ctx.close();
  }
}

await browser.close();
server.close();

const states = VARIANTS.length * STATES.length;
if (failures.length) {
  console.log(`FAIL  smoke — ${failures.length} across ${SCREENS.length} screens in ${states} states\n`);
  for (const f of [...new Set(failures)].slice(0, 40)) console.log('  ' + f);
  process.exit(1);
}
console.log(`PASS  smoke — ${SCREENS.length} screens rendered in ${states} state${states === 1 ? '' : 's'}, no errors`);
