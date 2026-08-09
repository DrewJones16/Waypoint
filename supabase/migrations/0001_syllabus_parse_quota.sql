-- Syllabus parsing: per-user daily quota.
--
-- This table is the ONLY thing the parse endpoint writes. Syllabus contents are
-- never stored server-side: the Edge Function reads the text or PDF, calls the
-- model, returns the schedule, and forgets it. What lives here is a counter —
-- user id, date, count — and nothing else.

create table if not exists public.syllabus_parse_quota (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  used    int  not null default 0,
  primary key (user_id, day)
);

-- No policies are defined on purpose. Only the service role touches this table,
-- and the service role bypasses RLS — so RLS on with zero policies means every
-- other key (anon, a signed-in user's own JWT) can read and write exactly
-- nothing. A student can't inspect or reset their own counter.
alter table public.syllabus_parse_quota enable row level security;

-- Claim one parse. Returns the new count, or NULL when the student is already at
-- the cap for the day.
--
-- The guard lives in the ON CONFLICT ... WHERE clause so the check and the
-- increment are one statement: two requests racing in the same millisecond
-- serialize on the primary key, and the second one sees the first one's count.
-- A read-then-write in the Edge Function would let both through.
create or replace function public.claim_syllabus_parse(p_user_id uuid, p_limit int default 5)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  insert into public.syllabus_parse_quota (user_id, day, used)
  values (p_user_id, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update
    set used = syllabus_parse_quota.used + 1
    where syllabus_parse_quota.used < p_limit
  returning used into v_used;

  return v_used;   -- NULL when the guard blocked the update: over the cap
end;
$$;

-- Give a parse back when the failure was ours — the model call errored, the
-- network dropped. A student who lost a parse to a 500 shouldn't also lose one
-- of their five. Not called when the parse succeeded but found no schedule:
-- that's a real answer, and it cost real tokens.
create or replace function public.release_syllabus_parse(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.syllabus_parse_quota
     set used = greatest(used - 1, 0)
   where user_id = p_user_id
     and day = (now() at time zone 'utc')::date;
$$;

-- Both functions take a user id as an argument rather than reading auth.uid(),
-- because the Edge Function has already verified the JWT and calls them with the
-- service role. That means they must be unreachable from a browser: anyone
-- holding the publishable anon key could otherwise spend someone else's quota.
revoke all on function public.claim_syllabus_parse(uuid, int)  from public, anon, authenticated;
revoke all on function public.release_syllabus_parse(uuid)     from public, anon, authenticated;
