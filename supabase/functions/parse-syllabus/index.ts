// parse-syllabus — Waypoint's first server-side brain.
//
// Takes a student's actual syllabus — pasted text, an uploaded PDF, or photos of
// the printed pages — and returns a week-by-week schedule mapped onto the
// Waypoint units for that course. The model maps; the student confirms on the
// client before any of it becomes state.
//
// Three things this function is careful about:
//
//   1. The API key never leaves the server. It lives as a Supabase secret and is
//      read from the environment here — the browser never sees it.
//   2. Syllabus contents are never stored. They arrive, they're sent to the
//      model, the schedule comes back, and nothing is written down. The only
//      table this touches is a counter of how many parses a user has spent
//      today. Nothing is logged that could contain a line of someone's syllabus.
//   3. Nothing the model returns is trusted. Every unit id is checked against
//      the list the client sent, every week number against 1-20, every field
//      against its type. A model that invents an id produces a week with one
//      fewer mapping, never a corrupt schedule.
//
// A failure here must always leave the app working on its static PACING table.
// Every error path returns a plain reason the client can show and move on from.

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

// ── Configuration ─────────────────────────────────────────────────────────────

const MODEL = 'claude-opus-5';

// Thinking is on by default on this model and shares the ceiling with the
// response, so max_tokens covers both. A 20-week schedule is well under 2k
// output tokens; the rest is headroom for thinking and long verbatim labels.
const MAX_TOKENS = 16000;

// Structured extraction, not open-ended reasoning. `medium` reads a syllabus as
// accurately as `high` here at a fraction of the latency — raise it if real
// syllabi start defeating it.
const EFFORT = 'medium';

const DAILY_LIMIT = 5;

// Weeks outside this range aren't a term. A syllabus that yields week 47 is a
// misparse, and one week per row is the shape every real syllabus takes.
const MIN_WEEK = 1, MAX_WEEK = 20;

// ~5MB of PDF, which is a generous syllabus. Base64 inflates by 4/3, and the
// client caps at 5MB before it ever gets here — this is the backstop.
const MAX_PDF_B64  = 7_200_000;
const MAX_TEXT     = 200_000;   // a whole syllabus pasted in, with room to spare
const MAX_UNITS    = 200;
const MAX_LABEL    = 300;       // one week's topic line, not a paragraph

// Photographed pages. A syllabus is often paper rather than a file — a printout
// in a binder, a handout from advising, a page projected in a club meeting — and
// a schedule routinely runs across two or three of them. Those pages are one
// document: one request, one parse, one quota unit, however many it took.
const MAX_IMAGES     = 6;
const MAX_IMAGE_B64  = 3_000_000;    // ~2.2MB a page; the client downscales far under this
const MAX_IMAGES_B64 = 9_000_000;    // and all of them together

// Refused from the Content-Length header, before the body is ever buffered. A
// student who skips the client's downscaling and sends six raw 8MB photos
// deserves a sentence, not a timeout — and reading 48MB into memory to find that
// out is how the timeout would happen.
const MAX_REQUEST_BYTES = 14_000_000;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// What each format's first bytes look like once base64 has eaten them. Sniffing
// beats the declared type: a mislabelled page would otherwise 400 at the API,
// after the quota was spent, with nothing useful to tell the student.
const IMAGE_MAGIC: Array<[string, string]> = [
  ['/9j/',        'image/jpeg'],
  ['iVBORw0KGgo', 'image/png'],
  ['R0lGOD',      'image/gif'],
  ['UklGR',       'image/webp'],
];

type Page = { media: string; data: string };

function readImage(raw: unknown): Page | null {
  if (typeof raw !== 'string') return null;
  const declared = raw.match(/^data:([^;,]+)[^,]*,/);
  const data = raw.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!data || data.length > MAX_IMAGE_B64) return null;
  const sniffed = IMAGE_MAGIC.find(([prefix]) => data.startsWith(prefix));
  const media = sniffed ? sniffed[1]
              : (declared && IMAGE_TYPES.has(declared[1]) ? declared[1] : '');
  return media ? { media, data } : null;
}

const ALLOWED_ORIGINS = [
  'https://waypointmcat.com',
  'https://www.waypointmcat.com',
  'http://localhost:3000',
];

// ── The contract ──────────────────────────────────────────────────────────────

// Structured outputs, not a "return ONLY JSON" instruction plus a regex. The
// schema is enforced by the API, so the failure mode we'd otherwise be coding
// around — a model that returns valid JSON wrapped in a sentence of prose —
// can't happen. Validation below is for semantics (real unit ids, real weeks),
// not for shape.
//
// No minimum/maximum on `week`: numeric constraints aren't supported in this
// schema dialect, and week bounds are enforced in validateSchedule() anyway.
const SCHEDULE_SCHEMA = {
  type: 'object',
  properties: {
    confidence: { type: 'string', enum: ['high', 'low'] },
    termStart:  { anyOf: [{ type: 'string' }, { type: 'null' }] },
    weeks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          week:       { type: 'integer' },
          label:      { type: 'string' },
          unitIds:    { type: 'array', items: { type: 'string' } },
          // Per-week, distinct from the document-level confidence above: this
          // one says whether the student needs to look at this row.
          confidence: { type: 'string', enum: ['high', 'low'] },
        },
        required: ['week', 'label', 'unitIds', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['confidence', 'termStart', 'weeks'],
  additionalProperties: false,
};

function buildPrompt(courseName: string, units: Array<{ id: string; label: string }>, pages: number) {
  const list = units.map(u => `  ${u.id} — ${u.label}`).join('\n');

  // Photos fail in ways files don't, and the failures look like success from the
  // outside: a cropped table still parses into a schedule, just the wrong one.
  // These two lines are the whole difference between "here is half your
  // semester, presented as all of it" and an honest answer.
  const photos = pages ? `

What you are looking at: ${pages} photograph${pages !== 1 ? 's' : ''} of a printed syllabus, in page order. Read them as one document — a schedule table often continues from one page onto the next, and a week split across two photos is still one week.

Photographs go wrong in ways a file doesn't. If glare, an angle, a shadow or a cropped edge means you genuinely cannot read the schedule, return "confidence": "low" and an empty weeks array. Do not reconstruct what an unreadable region probably said. If you can read part of the schedule but the photo plainly cuts it off, return the weeks you can actually read and nothing more — a short honest schedule is recoverable, because the student can photograph the missing page; an invented one is not, because they will never know to.` : '';

  return `You are reading a college course syllabus for ${courseName} and extracting its weekly schedule.${photos}

Map each week of the syllabus to zero or more of these unit ids. These are the only ids that exist; there are no others to choose from:

${list}

How to read it:

- Work through the weekly schedule in order. One entry per week the syllabus lists, numbered as the syllabus numbers them.
- Set "label" to the syllabus's own words for that week, copied as closely as the source allows. The student is going to read these labels back and check them against the paper in front of them, so a paraphrase is worse than a clumsy verbatim quote.
- Choose unit ids by what the week actually covers. A week can map to several units, or to one, or to none.
- Weeks with no course content — exams, review sessions, breaks, holidays, project work, guest lectures — get an empty unitIds array. That is the correct answer for those weeks, not a reason to guess.
- If a week covers material that has no matching unit in the list above, leave its unitIds empty. Do not stretch an unrelated id to cover it, and do not invent an id.
- Set each week's "confidence" to say whether a person needs to check that row. This is the single most useful thing you can tell them, because it decides what they read and what they can skip.
  - "high" when the week's text plainly names its topic and your mapping follows from it, and also when the text plainly says there is no course content — "Midterm exam", "Fall break", "No class". An empty unitIds you are sure about is a high-confidence answer, not a doubt.
  - "low" when you had to guess: the text is vague or administrative ("Unit 3", "TBD", "Catch-up", "Continued", "Chapter 7" with no subject), it could reasonably map to more than one of the units above, or it looks like real course content that none of the available units covers.
  - When you are genuinely torn, choose "low". Being asked about a week that was already right costs a student two seconds; a wrong mapping they were never shown costs them a semester of practising the wrong topic.
- Set "termStart" to the date of the first day of instruction in YYYY-MM-DD form if the syllabus states it or it can be read directly off the schedule. Use null if it doesn't.
- Set "confidence" to "high" when you found a real weekly schedule you could follow. Set it to "low" when the document has no weekly structure to extract — a policy-only syllabus, a reading list, or something that isn't a syllabus at all. In that case return an empty weeks array. An invented schedule is worse to the student than an honest "couldn't find one", because they will trust it.`;
}

// ── Reading the answer ────────────────────────────────────────────────────────

// The response format is schema-enforced, so a bare JSON.parse should always
// work. Should. If the enforcement ever doesn't apply — a parameter that stops
// being honoured, a model that wraps its answer in a fence or a sentence — the
// difference between a working feature and a dead one is a few lines of
// tolerance, so they're here. Order matters: the straight parse is the fast
// path and the only one that runs when everything is behaving.
function extractJson(raw: string): unknown {
  const s = (raw || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* not bare JSON — keep looking */ }

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* not that either */ }
  }
  const open = s.indexOf('{'), close = s.lastIndexOf('}');
  if (open !== -1 && close > open) {
    try { return JSON.parse(s.slice(open, close + 1)); } catch { /* give up */ }
  }
  return null;
}

// ── Validation ────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s: unknown): string | null {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : s;
}

// Everything the model returned, checked against what we know. Unknown unit ids
// are dropped rather than rejected: one bad mapping in week 9 shouldn't cost the
// student the other fourteen weeks, and the confirm screen is where they'd have
// caught it anyway.
function validateSchedule(raw: unknown, knownUnitIds: Set<string>) {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};

  const seen = new Set<number>();
  const weeks = (Array.isArray(obj.weeks) ? obj.weeks : [])
    .map((w) => {
      if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
      const row = w as Record<string, unknown>;

      const week = typeof row.week === 'number' ? Math.trunc(row.week) : NaN;
      if (!Number.isFinite(week) || week < MIN_WEEK || week > MAX_WEEK) return null;
      if (seen.has(week)) return null;   // one row per week; first wins
      seen.add(week);

      const label = typeof row.label === 'string' ? row.label.trim().slice(0, MAX_LABEL) : '';

      const unitIds = Array.isArray(row.unitIds)
        ? [...new Set(row.unitIds.filter((id): id is string => typeof id === 'string' && knownUnitIds.has(id)))]
        : [];

      // Anything that isn't an explicit "high" is low. Over-asking costs the
      // student a glance; under-asking hides a bad mapping behind a summary row
      // they never opened, and they practise the wrong topic all term.
      const confidence = row.confidence === 'high' ? 'high' : 'low';

      return { week, label, unitIds, confidence };
    })
    .filter((w): w is { week: number; label: string; unitIds: string[] } => w !== null)
    .sort((a, b) => a.week - b.week);

  // Confidence is the model's read, but an empty schedule is low confidence
  // whatever it called itself — there is nothing there to be confident about.
  const confidence = (obj.confidence === 'high' && weeks.length > 0) ? 'high' : 'low';

  return { confidence, termStart: validDate(obj.termStart), weeks };
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    // Every header the client actually sends has to be named here or the
    // preflight fails and the real request is never made. `apikey` is the easy
    // one to forget: Supabase wants it on every call, so the browser asks about
    // it, and a list that omits it blocks the request before the function is
    // ever reached. `x-client-info` is what supabase-js adds if this is ever
    // called through the library instead of raw fetch.
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

// Every error the client can show verbatim. No stack traces, no model output,
// nothing that could carry a fragment of the syllabus back out.
function fail(message: string, status: number, origin: string | null) {
  return json({ ok: false, message }, status, origin);
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST')    return fail('Use POST.', 405, origin);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('[parse-syllabus] ANTHROPIC_API_KEY is not set');
    return fail('Syllabus parsing isn\'t configured yet. Waypoint will keep using the typical pacing.', 503, origin);
  }

  // ── Who is this? ────────────────────────────────────────────────────────────
  // Sign-in is required, and not as a growth tactic: a parsed syllabus is
  // durable personal data that has to sync, and a per-user id is the only thing
  // a daily cap can be counted against.
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return fail('Sign in to use your syllabus.', 401, origin);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const { data: userData, error: userErr } =
    await createClient(supabaseUrl, anonKey).auth.getUser(token);
  const userId = userData?.user?.id;
  if (userErr || !userId) return fail('Your session expired. Sign in again.', 401, origin);

  // ── What did they send? ─────────────────────────────────────────────────────
  // Size is checked from the header first, so an oversized request costs a
  // sentence rather than a stalled read that ends in a gateway timeout the
  // student can't act on.
  const declaredBytes = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BYTES) {
    return fail('That\'s a lot of pages — try fewer, or crop to the schedule.', 413, origin);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail('That request wasn\'t readable.', 400, origin);
  }

  const courseId   = typeof body.courseId === 'string' ? body.courseId : '';
  const courseName = typeof body.courseName === 'string' && body.courseName ? body.courseName : 'this course';
  if (!courseId) return fail('No course was named.', 400, origin);

  const rawUnits = Array.isArray(body.units) ? body.units : [];
  const units = rawUnits
    .filter((u): u is { id: string; label: string } =>
      !!u && typeof u === 'object' &&
      typeof (u as Record<string, unknown>).id === 'string' &&
      typeof (u as Record<string, unknown>).label === 'string')
    .slice(0, MAX_UNITS);
  if (!units.length) return fail('That course has no units to map onto yet.', 400, origin);

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  // Tolerate a data: URL — a client that hands us the whole FileReader result
  // shouldn't fail on the prefix. Newlines are stripped because the API rejects
  // base64 that carries them.
  const pdfBase64 = typeof body.pdfBase64 === 'string'
    ? body.pdfBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
    : '';

  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES) {
    return fail(`That's more than ${MAX_IMAGES} pages — send the schedule pages on their own.`, 413, origin);
  }
  const images = rawImages.map(readImage);
  // One unreadable page fails the request rather than being dropped: a schedule
  // silently missing its second page is exactly the outcome the whole photo path
  // has to avoid, and the student can retake a shot in five seconds.
  if (images.some(p => p === null)) {
    return fail('One of those pages didn\'t come through. Retake it, or paste the schedule instead.', 400, origin);
  }
  const pages = images as Page[];

  if (!text && !pdfBase64 && !pages.length) return fail('Nothing was attached to read.', 400, origin);
  if (text.length > MAX_TEXT) {
    return fail('That\'s longer than a syllabus — paste just the schedule section.', 413, origin);
  }
  if (pdfBase64.length > MAX_PDF_B64) {
    return fail('That file is too big. Try a PDF under 5MB, or paste the schedule instead.', 413, origin);
  }
  // The header check above catches the honest oversized request; this catches the
  // one that arrived chunked, with no length to check.
  if (pages.reduce((n, p) => n + p.data.length, 0) > MAX_IMAGES_B64) {
    return fail('That\'s a lot of pages — try fewer, or crop to the schedule.', 413, origin);
  }

  // ── Spend a parse ───────────────────────────────────────────────────────────
  // Claimed before the model runs, so a farmed endpoint burns quota rather than
  // tokens. Given back below if the failure turns out to be ours.
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: used, error: quotaErr } =
    await admin.rpc('claim_syllabus_parse', { p_user_id: userId, p_limit: DAILY_LIMIT });

  if (quotaErr) {
    console.error('[parse-syllabus] quota check failed:', quotaErr.message);
    return fail('Couldn\'t start that just now. Try again in a minute.', 503, origin);
  }
  if (used === null) {
    return fail(`That's ${DAILY_LIMIT} syllabi today — the limit resets tomorrow.`, 429, origin);
  }

  const refund = async () => {
    try { await admin.rpc('release_syllabus_parse', { p_user_id: userId }); }
    catch (e) { console.error('[parse-syllabus] refund failed:', (e as Error).message); }
  };

  // ── Read it ─────────────────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey });

  // The syllabus goes before the instructions: the model reads the document,
  // then what to do with it. Photographed pages keep the order the student shot
  // them in — a schedule table that runs onto a second page only reads correctly
  // if page 2 follows page 1.
  const content: unknown[] = [];
  if (pdfBase64) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
    });
  }
  for (const page of pages) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: page.media, data: page.data },
    });
  }
  if (text) {
    content.push({ type: 'text', text: `Syllabus:\n\n${text}` });
  }
  content.push({ type: 'text', text: buildPrompt(courseName, units, pages.length) });

  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: SCHEDULE_SCHEMA },
    },
    messages: [{ role: 'user', content }],
  };

  let message;
  try {
    // Safety classifiers can decline a request outright. `fallbacks: "default"`
    // has the API re-run a declined request on its recommended substitute
    // server-side, so a false positive on someone's biology syllabus costs a
    // second or two instead of the whole feature. If the beta isn't enabled on
    // this account the call 400s on the parameter, and we go again without it
    // rather than failing the parse over a nicety.
    try {
      message = await (client as any).beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (e) {
      const msg = String((e as Error)?.message || '');
      if (!/fallback/i.test(msg)) throw e;
      console.warn('[parse-syllabus] server-side fallbacks unavailable; retrying without');
      message = await client.messages.create(params as never);
    }
  } catch (e) {
    console.error('[parse-syllabus] model call failed:', (e as Error).message);
    await refund();
    return fail('Couldn\'t read that just now. Waypoint will keep using the typical pacing.', 502, origin);
  }

  // A refusal is a real answer, not an error — say so plainly and don't charge
  // for it. Truncation is ours: the ceiling was too low for this document.
  if (message.stop_reason === 'refusal') {
    await refund();
    return fail('Couldn\'t read that one. Waypoint will keep using the typical pacing.', 422, origin);
  }
  if (message.stop_reason === 'max_tokens') {
    console.error('[parse-syllabus] hit max_tokens');
    await refund();
    return fail('That syllabus was too long to finish reading. Paste just the weekly schedule.', 422, origin);
  }

  const blocks = (message.content || []).map((b: { type: string }) => b.type).join(',');
  const block  = (message.content || []).find((b: { type: string }) => b.type === 'text');
  const answer = block ? String((block as { text: string }).text || '') : '';
  const parsed = extractJson(answer);

  // Diagnostics carry shape, never content — the model's answer quotes the
  // syllabus verbatim, so its text can't go in a log line. Which blocks came
  // back, how long the text was, and whether it looked like JSON is enough to
  // tell "the model said nothing" from "it answered in prose" from "it answered
  // correctly and our own matching threw the answer away".
  if (!parsed) {
    console.error(`[parse-syllabus] unreadable model output: blocks=[${blocks}] len=${answer.length} brace=${answer.trimStart().startsWith('{')} fenced=${answer.includes('\`\`\`')} stop=${message.stop_reason}`);
  }

  const rawWeeks = (parsed && typeof parsed === 'object' && Array.isArray((parsed as { weeks?: unknown }).weeks))
    ? ((parsed as { weeks: unknown[] }).weeks).length : -1;

  const schedule = validateSchedule(parsed, new Set(units.map(u => u.id)));

  // Counts only. Never the syllabus, never a label, never the schedule.
  // rawWeeks vs weeks is the load-bearing pair: equal means we kept what the
  // model found, 4 vs 0 means the model did its job and our validation didn't.
  // pages= is the one that matters for photos: a shot that reads as well as the
  // same syllabus pasted will show the same weeks count, and one that doesn't is
  // visible here without anyone reading a line of the syllabus.
  console.log(`[parse-syllabus] course=${courseId} pages=${pages.length} blocks=[${blocks}] rawWeeks=${rawWeeks} weeks=${schedule.weeks.length} confidence=${schedule.confidence} used=${used}/${DAILY_LIMIT}`);

  return json({
    ok: true,
    courseId,
    remaining: Math.max(DAILY_LIMIT - (used as number), 0),
    ...schedule,
  }, 200, origin);
});
