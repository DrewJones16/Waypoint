// Waypoint content validator — run: `node validate.mjs`
// Guards the question bank against the bug classes we've hit: duplicate IDs,
// malformed schema, missing twists, and twists that don't split into the
// "In class -> On the MCAT" contrast the product is built on.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
let js = src.slice(src.indexOf('const COURSES ='));
js = js.slice(0, js.indexOf('</script>')).replace(/render\(\);\s*$/, '');

const sandbox = {
  window: {}, document: { getElementById: () => null, addEventListener() {}, body: { classList: { add() {}, remove() {} } } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, plausible() {},
};
const ctx = { ...sandbox, console };
const scope = {};
const runner = new Function(...Object.keys(ctx), js + '; return { QUESTIONS, TWISTS, TOPICS, splitTwist, twistTextFor };');
const { QUESTIONS, TWISTS, TOPICS, splitTwist, twistTextFor } = runner(...Object.values(ctx));

const errors = [];
const warn = [];

// 1) duplicate IDs
const ids = QUESTIONS.map(q => q.id);
const dups = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
if (dups.length) errors.push(`Duplicate question IDs: ${dups.join(', ')}`);

// 2) schema
for (const q of QUESTIONS) {
  if (!q.stem) errors.push(`${q.id}: missing stem`);
  if (!Array.isArray(q.opts) || q.opts.length < 2) errors.push(`${q.id}: opts must have >= 2 options`);
  if (typeof q.ans !== 'number' || q.ans < 0 || (Array.isArray(q.opts) && q.ans >= q.opts.length)) errors.push(`${q.id}: ans out of range`);
  if (!q.exp) errors.push(`${q.id}: missing explanation`);
}

// 3) every non-CARS question has a twist
for (const q of QUESTIONS) {
  if (q.topic === 'cars') continue;
  if (!twistTextFor(q)) warn.push(`${q.id}: no twist`);
}

// 4) every twist splits into two non-empty sides
for (const q of QUESTIONS) {
  const t = twistTextFor(q);
  if (!t) continue;
  const { cls, exam } = splitTwist(t);
  if (!cls || !exam) errors.push(`${q.id}: twist does not split into In-class / On-the-MCAT (marker missing or malformed)`);
}
// orphan TWISTS keys (twist for a non-existent question id)
for (const id of Object.keys(TWISTS)) {
  if (!ids.includes(id)) warn.push(`orphan TWISTS key: ${id}`);
}

console.log(`Checked ${QUESTIONS.length} questions, ${Object.keys(TWISTS).length} twist entries.`);
if (warn.length) console.log('\nWARN:\n  ' + warn.join('\n  '));
if (errors.length) { console.error('\nFAIL:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log('\nPASS — no errors.');
