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

// ── What a generic student is promised ──────────────────────────────────────
// Courses cover topics through a catalog now, so that a school's real course
// list can say what it covers. Every student not at that school stays on the
// generic catalog, and the generic catalog is derived from the same TOPICS the
// weights were always read from — so their screens must be character for
// character what they were.
//
// "Must be" is worth nothing unless something checks it, and a refactor that
// touches fifty call sites is exactly where a quiet half-percent goes
// unnoticed. This is the text, captured from main before the first line of it
// was written.
const SNAPSHOT = JSON.parse(readFileSync(new URL('./generic-snapshot.json', import.meta.url), 'utf8'));

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

// The same student at BYU: the equivalent courses, in the codes on their own
// schedule. Their coverage is the same 38% the generic junior reads, which is
// the arithmetic half of "the map speaks BYU". The other half is below.
const BYU = {
  wp_school: 'byu',
  wp_year: 'junior',
  wp_courses: '["bio130","cell305","chem105","chem106","chem351","psych111"]',
  wp_course_status: '{"bio130":"completed","cell305":"completed","chem105":"completed","chem106":"completed","chem351":"in-progress","psych111":"in-progress"}',
  wp_course_when: '{"bio130":"2025-fall","cell305":"2026-spring","chem105":"2025-fall","chem106":"2026-spring"}',
};

// And at the University of Utah. Same student again, third set of codes.
const UTAH = {
  wp_school: 'utah',
  wp_year: 'junior',
  wp_courses: '["ubiol1610","ubiol2420","uchem1210","uchem1220","uchem2310","upsy1010"]',
  wp_course_status: '{"ubiol1610":"completed","ubiol2420":"completed","uchem1210":"completed","uchem1220":"completed","uchem2310":"in-progress","upsy1010":"in-progress"}',
  wp_course_when: '{"ubiol1610":"2025-fall","ubiol2420":"2026-spring","uchem1210":"2025-fall","uchem1220":"2026-spring"}',
};

// `peer` marks the states that are THE SAME STUDENT in different course lists:
// four classes finished and two in progress, covering the same MCAT ground
// whichever catalog names them. Their coverage has to agree topic by topic,
// and when it does not the check says which topic and in whose list.
//
// It is the only check here that can catch a mapping error with no symptom.
// Every other one asks whether a screen renders or a word is wrong; this one
// asks whether the three tables mean the same thing, which is the whole claim
// a second school makes.
const STATES = [
  { name: 'cleared',   store: {} },
  { name: 'junior',    store: JUNIOR, peer: true },
  { name: 'returning', store: RETURNING },
  { name: 'byu',       store: BYU,    peer: true },
  { name: 'utah',      store: UTAH,   peer: true },
];

// ── No other catalog's course name reaches a student ───────────────────────
// A student on a school's list sees that school's codes and nothing else: not
// the generic names their list replaced, and not another school's codes.
//
// Two screens may, and only these two, each for a reason that is about someone
// other than the student reading it:
//
//   landing — the example route on the marketing card is a DIFFERENT, made-up
//     student, described in the generic terms their route is built from. (It
//     is computed in the generic catalog too; without that a school's visitor
//     was shown the card at 0%.)
//   sources — the weight model itself. Its splits are written for a standard
//     two-semester sequence, because that is what they were derived from, and
//     a school's courses are mapped ONTO that model rather than replacing it.
//     Renaming them in a school's terms would claim a derivation that does not
//     exist. The screen says so, in a paragraph only non-generic students see.
const LEAK_OK = ['landing', 'sources'];

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

// ── The words have to match the product ─────────────────────────────────────
// Waypoint shows where a student stands and where to go and learn each part.
// It does not run the studying any more, so nothing on screen may promise that
// it does. Checked against rendered text rather than source, because what a
// student reads is the only version that counts.
const PROMISES = /\b(practice|practise|practised|practising|practicing|questions?|streak|drills?|spaced repetition)\b/i;

// Two exceptions, each for a reason, each as narrow as it can be.
function allowedLine(line) {
  // 1. AAMC's exam composition. "The MCAT is 230 questions", "59 questions
  //    each", the Questions column of the derivation — these are the inputs to
  //    every percentage the map draws, and Sources exists to show that
  //    arithmetic. They promise nothing; they are the denominator. Only
  //    admitted where the sentence is plainly about the exam's own structure.
  if (/question/i.test(line) && /\b(230|59|53|AAMC|count|share of questions|Questions)\b/.test(line)) return true;
  // 2. The study panel sending a student to someone else's practice, and the
  //    line saying we are not affiliated with them.
  if (/Practise reading here|CARS practice|not affiliated with Khan Academy/i.test(line)) return true;
  return false;
}

// The figures line is machine-readable on purpose: a prose diff tells you a
// screen changed, this tells you whether a number did.
function snapshotDiff(key, got) {
  const want = SNAPSHOT.screens[key];
  if (want === undefined) return `no snapshot for ${key}`;
  if (want === got) return null;
  const a = want.split('\n'), b = got.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: expected "${(a[i] || '').slice(0, 60)}" but read "${(b[i] || '').slice(0, 60)}"`;
  }
  return 'differs in trailing whitespace';
}

const failures = [];
const peers = {};          // state name → what that student's coverage is made of
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

      // With practice off, nothing on screen may promise practice.
      if (variant.label !== 'PRACTICE=true') {
        const lines = await page.evaluate(() => (document.getElementById('app')?.innerText || '').split('\n'))
                                .catch(() => []);
        for (const line of lines) {
          const t = line.trim();
          if (t && PROMISES.test(t) && !allowedLine(t)) seen.push(`promises practice: "${t.slice(0, 90)}"`);
        }
      }
      for (const f of seen) failures.push(`${where}  ${screen}: ${f}`);
    }

    // With practice on, the loop has to actually close. The flag's promise is
    // not "the questions are still in the file" — it is that a student can
    // reach one from the navigation as it now stands.
    if (variant.label === 'PRACTICE=true' && state.name !== 'cleared') {
      await page.evaluate(() => window.go('reveal'));
      await page.waitForTimeout(400);
      const pressed = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.btn-primary')].find(x => /^Practice /.test(x.innerText));
        if (!b) return 'no focus button on the Route';
        b.click();
        return null;
      });
      await page.waitForTimeout(400);
      const landed = await page.evaluate(() => S.screen);
      const asked  = await page.evaluate(() => !!document.querySelector('.ans-btn'));
      if (pressed) failures.push(`${where}  focus button: ${pressed}`);
      else if (landed !== 'question' || !asked)
        failures.push(`${where}  focus button: landed on "${landed}"${asked ? '' : ' with no answer options'}, expected a question`);
    }

    // ── The same student, whichever list names their classes ────────────────
    if (variant.label !== 'PRACTICE=true' && state.peer) {
      peers[state.name] = await page.evaluate(() => ({
        cov: coverage(S.courses, true),
        // The credit each topic carries: 1 finished, 0.5 taking, 0 neither.
        // Comparing these rather than the total is what lets a failure name a
        // topic — and it catches two errors that cancel out in the sum.
        topics: Object.fromEntries(TOPICS.map(t => [t.id, topicCredit(t.id)])),
      })).catch(e => ({ cov: null, topics: {}, threw: e.message }));
    }

    // ── No other catalog's course name reaches this student ─────────────────
    if (state.store.wp_school) {
      // Derived in the page from the real tables rather than listed here, so a
      // course renamed in any catalog cannot slip past a stale constant.
      // Anything that is also a topic name, a tile name, a section heading or
      // one of THIS student's own course names is not a leak; it is the map's
      // own vocabulary.
      const words = await page.evaluate(() => {
        const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const bound = w => new RegExp('(?<![A-Za-z0-9])' + esc(w) + '(?![A-Za-z0-9])');
        const ok = new Set([...TOPICS.map(t => t.name), ...Object.values(TILE_NAMES), ...Object.values(MAP_NAMES),
                            ...allCourses().map(c => c.section), ...MCAT_SECTIONS.map(s => s.short), ...MCAT_SECTIONS.map(s => s.long),
                            ...allCourses().map(c => c.name)]);
        // A name this student's own catalog SPELLS OUT is not a leak. Utah's
        // "General Chemistry I & Lab" contains the generic course called
        // "General Chemistry I", because both are English for the same class,
        // and its "Fundamental Principles of Biology I & Lab" contains
        // "Biology I" the same way. Six screens reported as leaking on that
        // alone. If a generic row really did render, every other generic name
        // on it is still watched.
        const mine = allCourses().map(c => c.name + ' ' + (c.title || '')).join(' \n ');
        const out = new Set();
        // Every catalog the student is NOT on — the generic list their codes
        // replaced, and every other school's codes.
        for (const cat of Object.values(CATALOGS)) {
          if (cat.id === schoolId()) continue;
          cat.courses.forEach(c => { if (!ok.has(c.name) && !bound(c.name).test(mine)) out.add(c.name); });
        }
        // Only a topic that HAS a generic course has a generic course name to
        // leak. CARS has none, and its "Ongoing" is a state word.
        TOPICS.forEach(t => { if (t.disp && t.course && !ok.has(t.disp) && !bound(t.disp).test(mine)) out.add(t.disp); });
        return [...out];
      }).catch(() => []);
      if (!words.length) failures.push(`${where}  could not work out which names would be a leak`);
      // Whole tokens. "CHEM 351" is not on a Utah student's screen because
      // "CHEM 3510" is: that is one code being a prefix of another, not BYU's
      // list reaching them.
      const leaks = text => words.filter(w =>
        new RegExp('(?<![A-Za-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])').test(text));

      for (const screen of SCREENS) {
        if (LEAK_OK.includes(screen)) continue;
        await page.evaluate(s => window.go(s), screen).catch(() => {});
        await page.waitForTimeout(130);
        const text = await page.evaluate(() => document.getElementById('app').innerText || '').catch(() => '');
        for (const w of leaks(text)) failures.push(`${where}  ${screen}: shows another catalog's course "${w}"`);
      }
      // And every parcel's study panel, which is where a course is named most.
      const topics = await page.evaluate(() => TOPICS.map(t => t.id)).catch(() => []);
      for (const tid of topics) {
        const text = await page.evaluate(x => {
          S.screen = 'reveal'; S._mapOpen = x; render();
          return (document.getElementById('parcel-detail') || {}).innerText || '';
        }, tid).catch(() => '');
        for (const w of leaks(text)) failures.push(`${where}  panel ${tid}: shows another catalog's course "${w}"`);
      }
      await page.evaluate(() => { S._mapOpen = null; }).catch(() => {});
    }

    // ── The generic promise, checked ────────────────────────────────────────
    // Only with practice off, which is what ships, and only for the two states
    // the snapshot was taken in.
    if (variant.label !== 'PRACTICE=true' && SNAPSHOT.screens[`${state.name}/reveal`]) {
      for (const scr of ['reveal', 'explain', 'coverage']) {
        await page.evaluate(x => window.go(x), scr).catch(() => {});
        await page.waitForTimeout(160);
        // The sheet's parcel labels are hidden for the reading, not compared.
        // fitSheetLabels() chooses between the full name, the short name, a
        // rotated name and nothing by MEASURING the rendered width, and this
        // test blocks Google Fonts on purpose — so which label a parcel ends
        // up with depends on the fallback face of whatever machine is running
        // the check. On this one the browser default draws "Biochemistry";
        // under a monospace fallback the same parcel draws "Biochem", under a
        // serif it draws "Physiology" where the default draws "Physio". That
        // is a property of the font, and a snapshot that fails on somebody
        // else's laptop because of it is worse than no snapshot.
        //
        // Nothing is lost by dropping them: the figures line below carries the
        // coverage figure and all nineteen topic states, which is what the
        // labels were standing in for, and it cannot drift with a typeface.
        const got = await page.evaluate(() => {
          const app = document.getElementById('app');
          const labels = [...app.querySelectorAll('.pl-name, .pl-sub')];
          const was = labels.map(e => e.style.display);
          labels.forEach(e => { e.style.display = 'none'; });
          const text = app.innerText.trim();
          labels.forEach((e, i) => { e.style.display = was[i]; });   // the fitter's own choices, put back
          return text;
        }).catch(() => '(threw)');
        const d = snapshotDiff(`${state.name}/${scr}`, got);
        if (d) failures.push(`${where}  ${scr}: generic text moved — ${d}`);
      }
      const figures = await page.evaluate(() => {
        const cov = coverage(S.courses, true);
        const states = TOPICS.map(t => {
          const c = topicCourse(t.id);
          const st = !coursesCovering(t.id).length ? 'nocourse'
                   : !topicCovered(t.id) ? 'ahead'
                   : topicTaking(t.id) ? 'taking' : 'done';
          return `${t.id}:${st}`;
        }).join(' ');
        return `coverage=${cov.toFixed(6)} ${states}`;
      }).catch(e => '(threw) ' + e.message);
      const d = snapshotDiff(`${state.name}/figures`, figures);
      if (d) failures.push(`${where}  figures: generic coverage moved — ${d}`);
    }

    await ctx.close();
  }
}

// ── WHERE YOU STAND, AGAINST A SERVER THAT IS ONLY EVER A FIXTURE ───────────
// The comparison is the one part of the app whose content comes from outside
// this repo, so it is checked against mocked replies: every shape
// route_compare() can return, read back off the rendered page at both widths.
//
// The geometry is checked too, not just the words. Each figure in the reply
// has one place on a scale that runs to 77, and a band drawn anywhere else is
// a comparison that lies quietly — the sort of bug no sentence catches.
const COMPARE_ID = '11111111-2222-4333-8444-555555555555';

// What the students further along have finished. Four of these seven must
// never reach the screen, each for its own reason, which is why they are here.
const AHEAD = [
  { course: 'chem481',   share: 0.82 },   // 13% to this student: the first move
  { course: 'phscs105',  share: 0.71 },   // 3%
  { course: 'phscs106',  share: 0.64 },   // 3%
  { course: 'cell305',   share: 0.93 },   // already finished — never offered back
  { course: 'mmbio240',  share: 0.70 },   // worth nothing on top of what they hold
  { course: 'ubiol1610', share: 0.58 },   // another catalog's id
  { course: 'chem999',   share: 0.55 },   // an id this file has never heard of
];

// p25 / p50 / p75, and what the student reads: 38%.
const COMPARE_CASES = [
  { name: 'both groups small',
    reply: { school: { n: 7 }, all: { n: 7 }, min_n: 20 },
    want:  [/13 more BYU juniors and you'll see where you stand\./],
    not:   [/middle BYU junior/, /covered/] },

  { name: 'one short of twenty',
    reply: { school: { n: 19 }, all: { n: 19 }, min_n: 20 },
    want:  [/1 more BYU junior and/],
    not:   [/1 more BYU juniors/] },

  { name: 'school small, every school large',
    // The `ahead` list here is one route_compare() will not send: course ids
    // mean different things in different catalogs, so the all-schools group
    // has no course list to give. It is in the fixture anyway, because "the
    // client would ignore it if it arrived" is the property worth holding —
    // the alternative is a Utah course code on a BYU student's Route the day
    // somebody adds one server-side.
    reply: { school: { n: 12 }, all: { n: 40, p25: 30, p50: 41, p75: 55, ahead: AHEAD }, min_n: 20 },
    want:  [/The middle Waypoint junior at any school has covered 41%\. You've covered 38%\./],
    // No course list: an id from another school's catalog is not a class this
    // student can register for, and the server does not send one.
    not:   [/CHEM/, /ahead of you/],
    scale: { p25: 30, p50: 41, p75: 55 } },

  { name: 'their own school, large',
    reply: { school: { n: 34, p25: 31, p50: 45, p75: 58, ahead: AHEAD, terms: [] },
             all: { n: 61, p25: 28, p50: 43, p75: 56 }, min_n: 20 },
    want:  [/The middle BYU junior has covered 45%\. You've covered 38%\./,
            /Most BYU juniors ahead of you have finished CHEM 481 \(13% of the exam\), PHSCS 105 & 107 \(3%\) and PHSCS 106 & 108 \(3%\)\./],
    not:   [/CELL 305/, /MMBIO 240/, /chem999/, /Biology I/],
    scale: { p25: 31, p50: 45, p75: 58 } },

  { name: 'further along than the middle',
    reply: { school: { n: 34, p25: 18, p50: 29, p75: 44, ahead: AHEAD, terms: [] },
             all: { n: 61, p25: 20, p50: 31, p75: 48 }, min_n: 20 },
    want:  [/You've covered more than most BYU juniors\./],
    not:   [/ahead of you/, /CHEM 481/],
    scale: { p25: 18, p50: 29, p75: 44 } },

  { name: 'level with the middle',
    reply: { school: { n: 22, p25: 30, p50: 38, p75: 52, ahead: AHEAD, terms: [] },
             all: { n: 40, p25: 30, p50: 38, p75: 52 }, min_n: 20 },
    // One sentence, not the same figure twice.
    want:  [/The middle BYU junior has covered 38%, and so have you\./],
    not:   [/You've covered 38%/],
    scale: { p25: 30, p50: 38, p75: 52 } },

  { name: 'the server down',
    reply: null,
    want:  [],
    // Not even the offer: this student opted in, so the only honest thing to
    // show while the server is unreachable is nothing.
    not:   [/Compare my route/, /where you stand/, /middle BYU junior/] },
];

// Never these four, on any screen of a comparison. Coverage is which classes
// somebody has taken; a word that turns it into a placing or a contest is a
// different product.
const BANNED = /\brank(?:ed|ing|s)?\b|\bpercentiles?\b|\bbehind\b|\bbeats?\b/i;

served = VARIANTS[0].src;        // the shipped flag state
for (const c of COMPARE_CASES) {
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 1100 } });
    await ctx.route('**', route => {
      const u = route.request().url();
      if (u.startsWith(ORIGIN)) return route.continue();
      if (/\/rpc\/route_compare$/.test(u)) {
        return c.reply ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(c.reply) })
                       : route.fulfill({ status: 404, body: '' });
      }
      if (/\/rpc\//.test(u)) return route.fulfill({ status: 200, body: '' });   // the writers
      route.abort();
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => failures.push(`compare / ${c.name}: threw ${String(e).split('\n')[0]}`));

    await page.addInitScript(store => {
      try { localStorage.clear(); } catch (e) { /* private mode */ }
      for (const [k, v] of Object.entries(store)) localStorage.setItem(k, v);
    }, { ...BYU, wp_compare_id: COMPARE_ID });

    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForTimeout(450);          // the fetch is fired after boot
    await page.evaluate(() => window.go('reveal'));
    await page.waitForTimeout(220);

    // Both widths off one load. Nothing about the comparison depends on how
    // the page was fetched, so resizing is the same test for a fifth of the
    // wall clock — and this file is run on every push.
    for (const width of [375, 1280]) {
    const where = `compare / ${c.name} @ ${width}px`;
    await page.setViewportSize({ width, height: 1100 });
    await page.waitForTimeout(120);

    const got = await page.evaluate(() => {
      const app = document.getElementById('app');
      const cmp = document.querySelector('.cmp');
      const bar = document.querySelector('.cmp-scale');
      // Each mark as a percentage of the scale's own width, which is the only
      // way to ask "is 45% drawn at 45 of 77" without trusting the stylesheet.
      const place = sel => {
        const e = bar && bar.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect(), b = bar.getBoundingClientRect();
        return { left: (r.left - b.left) / b.width * 100, width: r.width / b.width * 100 };
      };
      return {
        cmp:  cmp ? cmp.innerText : '',
        route: app.innerText,
        band: place('.cmp-band'), mid: place('.cmp-mid'), you: place('.cmp-you'),
        over: app.scrollWidth - app.clientWidth,
      };
    }).catch(e => ({ cmp: '(threw) ' + e.message, route: '', over: 0 }));

    for (const re of c.want) if (!re.test(got.cmp)) failures.push(`${where}: no "${re.source}" in "${got.cmp.replace(/\n/g, ' / ').slice(0, 150)}"`);
    for (const re of c.not)  if (re.test(got.cmp))  failures.push(`${where}: shows "${re.source}", which it must not`);
    if (!c.want.length && got.cmp) failures.push(`${where}: shows "${got.cmp.slice(0, 80)}" where it must show nothing`);
    // A class already finished is worth nothing more, whatever the fixture
    // claims most students ahead have taken. Asserted on the arithmetic rather
    // than on the screen, because the screen is protected twice — by the
    // filter that drops a finished course and by the one that drops a course
    // worth zero — and a test that cannot fail proves nothing.
    if (!c.scale) { /* checked once per run is enough */ } else {
      const worthless = await page.evaluate(() => allCourses()
        .filter(c => S.courses.has(c.id) && S.courseStatus[c.id] !== 'in-progress')
        .filter(c => courseWouldAdd(c.id) !== 0)
        .map(c => c.id + ' would add ' + courseWouldAdd(c.id)));
      for (const w of worthless) failures.push(`${where}: a finished class is still worth something — ${w}`);
    }
    const banned = BANNED.exec(got.route);
    if (banned) failures.push(`${where}: the word "${banned[0]}" is on the Route`);
    if (got.over > 1) failures.push(`${where}: the page is ${got.over}px wider than its column`);

    // 38% of the way to 77 is 49.4% along, and nothing else is.
    if (c.scale) {
      const at = v => v / 77 * 100;
      const near = (got_, want_, what) => {
        if (got_ === null || got_ === undefined) return failures.push(`${where}: no ${what} on the scale`);
        if (Math.abs(got_ - want_) > 1.2) failures.push(`${where}: ${what} drawn at ${got_.toFixed(1)}% of the scale, expected ${want_.toFixed(1)}%`);
      };
      near(got.band && got.band.left, at(c.scale.p25), 'the band');
      near(got.band && got.band.width, at(c.scale.p75) - at(c.scale.p25), "the band's width");
      near(got.mid && got.mid.left, at(c.scale.p50), 'the median');
      near(got.you && got.you.left, at(38), 'the student');
    }
    }
    await ctx.close();
  }
}

await browser.close();
server.close();

// ── Do the three students agree? ───────────────────────────────────────────
// The same four finished classes and two in progress, in three course lists.
// If the tables mean the same thing, the credit on every topic matches; if
// they do not, the topic that differs is named, which is the difference
// between "Utah reads 35%" and "Utah's genetics is not covered".
{
  const names = Object.keys(peers);
  if (names.length < 2) failures.push(`parity: only ${names.length} peer state${names.length === 1 ? '' : 's'} measured`);
  const [first, ...rest] = names;
  for (const other of rest) {
    const a = peers[first], b = peers[other];
    const off = Object.keys(a.topics).filter(id => a.topics[id] !== b.topics[id]);
    for (const id of off)
      failures.push(`parity  ${id}: ${first} counts ${a.topics[id]}, ${other} counts ${b.topics[id]} — same student, two course lists`);
    if (!off.length && a.cov !== b.cov)
      failures.push(`parity: ${first} reads ${a.cov}% and ${other} reads ${b.cov}% with every topic matching`);
  }
  if (names.length && !failures.some(f => f.startsWith('parity')))
    console.log(`      the same student reads ${peers[first].cov}% as ${names.join(', ')}`);
}

const states = VARIANTS.length * STATES.length;
if (failures.length) {
  console.log(`FAIL  smoke — ${failures.length} across ${SCREENS.length} screens in ${states} states\n`);
  for (const f of [...new Set(failures)].slice(0, 40)) console.log('  ' + f);
  process.exit(1);
}
console.log(`PASS  smoke — ${SCREENS.length} screens rendered in ${states} state${states === 1 ? '' : 's'}, no errors`);
