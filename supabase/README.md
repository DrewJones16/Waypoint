# Server setup

Two pieces of Waypoint can't live in `index.html`: **syllabus parsing**, which
needs an API key, and **route comparison**, which needs a table every student
writes one row to. Everything else is still one static file.

Steps 1 to 4 are syllabus parsing. Step 5 is comparison, and is independent —
run either, both, or neither.

---

## Syllabus parsing

Parsing a syllabus needs an AI API key, and a key that ships to the browser is a
key anyone can spend. So the call happens in a Supabase Edge Function, where the
key sits as a project secret.

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

## What syllabus parsing costs

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

---

## Route comparison

## Step 5 — Create the comparison table

Dashboard → **SQL Editor** → **New query**, paste the whole of
[`migrations/0002_route_compare.sql`](migrations/0002_route_compare.sql), and
run it. It is independent of steps 1–4 and needs no secret and no deploy.

That file creates one table and three functions. **Until you run it, the app is
exactly today's app**: every call is wrapped so that a missing function is
indistinguishable from a student who has not opted in, and nothing about
comparison appears on any screen.

### What the row holds

A random id made in the browser, a school, a year, a coverage figure, two arrays
of course ids, and a planned test term. **No name, no email, no user id, no
account link** — nothing in the file references `auth.users`, so a snapshot
cannot be joined to the student who wrote it. Holding the id is what owning the
row means, and the id lives only on that student's devices.

### Checking it is shut

Row-level security is on with no policies, the same pattern as step 2, so the
publishable key can reach the table only through the three functions. With
`ANON` set to the anon key from Project Settings → API:

```sh
URL=https://xaldfseldfqctmplfpfu.supabase.co
```

**The table is unreadable.** Returns `[]`, whatever is in it:

```sh
curl -sS "$URL/rest/v1/route_snapshot?select=*" -H "apikey: $ANON"
```

**A comparison for a group that does not exist yet** returns a count and nothing
else — this is also what every group looks like below twenty:

```sh
curl -sS "$URL/rest/v1/rpc/route_compare" -H "apikey: $ANON" \
  -H 'content-type: application/json' -d '{"p_school":"byu","p_year":"junior"}'
# {"school":{"n":0},"all":{"n":0},"min_n":20}
```

**Junk is dropped rather than stored.** Coverage above 77 (the ceiling, because
CARS is 23% and no class teaches it), an unknown school, a 41-course array — all
return success and write nothing:

```sh
curl -sS "$URL/rest/v1/rpc/save_route_snapshot" -H "apikey: $ANON" \
  -H 'content-type: application/json' -d '{
    "p_id":"00000000-0000-4000-8000-000000000001",
    "p_school":"hogwarts","p_year":"junior","p_coverage":99,
    "p_done":[],"p_taking":[]}'
```

**Removing is real.** `delete_route_snapshot` with the id deletes the row; there
is no tombstone and no counter left behind.

### Adding a school

`save_route_snapshot` lists the known catalog ids — `generic`, `byu`, `utah`.
Adding a catalog to `index.html` means adding it to that list in a new
migration. One line, and the cost of not letting a typo create a group that can
never reach twenty and so never shows anything.
