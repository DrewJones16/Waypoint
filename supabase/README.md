# Syllabus parsing — server setup

This is the one piece of Waypoint that can't live in `index.html`. Parsing a
syllabus needs an AI API key, and a key that ships to the browser is a key
anyone can spend. So the call happens in a Supabase Edge Function, where the key
sits as a project secret.

Everything here is inert until it's deployed. The app keeps working on its
static pacing table exactly as it does today; nothing in `index.html` changes
until the client side of this ships.

**Project:** `xaldfseldfqctmplfpfu` (the same one Waypoint already uses for accounts and sync)

---

## Step 1 — Add the API key as a secret

Get an API key from [platform.claude.com](https://platform.claude.com) → **API keys**.

**Dashboard:** Project → **Edge Functions** → **Secrets** → **Add new secret**

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

**Or CLI:**

```sh
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected
into every Edge Function automatically — don't add those by hand.

> The key is never returned to the browser and never appears in a log line. If
> it leaks anyway, rotate it in the Claude console and re-run this step; nothing
> else needs to change.

---

## Step 2 — Create the quota table

Dashboard → **SQL Editor** → **New query**, paste the whole of
[`migrations/0001_syllabus_parse_quota.sql`](migrations/0001_syllabus_parse_quota.sql),
and run it.

That file creates one table and two functions. The table holds a user id, a
date, and a count — that's the entire schema. **No syllabus content is ever
written to the database.**

---

## Step 3 — Deploy the function

```sh
supabase login
supabase link --project-ref xaldfseldfqctmplfpfu
supabase functions deploy parse-syllabus --no-verify-jwt
```

**The `--no-verify-jwt` flag is required, and it does not make the endpoint
open.** Supabase's built-in check rejects any request without an `Authorization`
header — including the browser's CORS preflight, which never has one. With the
gateway check off, the function verifies the JWT itself (`auth.getUser`) and
returns 401 without a valid one. This is the standard pattern for a function a
browser calls directly; skipping the flag makes the endpoint unreachable from
the app.

No CLI? Dashboard → **Edge Functions** → **Deploy a new function**, name it
`parse-syllabus`, paste [`functions/parse-syllabus/index.ts`](functions/parse-syllabus/index.ts),
and set **Verify JWT** to off.

---

## Step 4 — Check it works

Grab a real token: sign in at waypointmcat.com, open the browser console, and run

```js
JSON.parse(localStorage.waypoint_auth).access_token
```

Then, with `TOKEN` set to that value:

```sh
URL=https://xaldfseldfqctmplfpfu.supabase.co/functions/v1/parse-syllabus
```

**A real schedule parses.** Swap in a few weeks of an actual syllabus:

```sh
curl -sS "$URL" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "courseId": "bio2",
  "courseName": "Biology II",
  "units": [
    {"id":"physio:muscle","label":"Muscle Physiology"},
    {"id":"physio:cardiovascular","label":"Cardiovascular"},
    {"id":"neuro:action-potential","label":"Action Potentials"}
  ],
  "text": "Week 1: Muscle structure and contraction\nWeek 2: Cardiac cycle and the heart\nWeek 3: MIDTERM EXAM — no new material\nWeek 4: Resting potential and action potentials"
}'
```

Expect `confidence: "high"`, four weeks, week 3 with an empty `unitIds`, and
labels that read like the syllabus rather than like Waypoint.

**A recipe does not.** Same call with `"text": "Preheat the oven to 400F.
Combine flour, butter and sugar. Bake 25 minutes."` should return
`confidence: "low"` and `weeks: []` — not an invented semester.

**Signed out is refused:**

```sh
curl -sS -o /dev/null -w '%{http_code}\n' "$URL" -H 'content-type: application/json' -d '{}'
# 401
```

**The sixth parse of the day is refused** — run the first call six times; the
last one returns 429 with `That's 5 syllabi today — the limit resets tomorrow.`
To reset while testing:

```sql
delete from public.syllabus_parse_quota where user_id = '<your-user-id>';
```

---

## What it costs

Claude Opus 5, at $5 per million input tokens and $25 per million output. A
typical syllabus is 2–6k tokens in and under 2k out, so **roughly $0.05–0.09 a
parse** — about $0.45 a day per student at the 5-parse cap, and in practice one
or two parses ever, at the start of a term.

If that turns out to be the wrong trade once real syllabi are flowing, it's one
line in `functions/parse-syllabus/index.ts`:

```ts
const MODEL = 'claude-sonnet-5';   // ~40% the input cost, ~60% the output cost
```

Redeploy and it takes effect immediately — no other change, no client change.
