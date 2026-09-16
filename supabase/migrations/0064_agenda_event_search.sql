-- =============================================================================
-- 0064 — Searching the agenda beyond the weeks it happens to have loaded.
--
-- The agenda's own search (shell-model.js) only ever sees what the workspace
-- has already fetched: the shown week and the weeks either side of it, plus
-- upcoming project meetings. A past meeting, or a plain (non-project) event
-- weeks away in either direction, is invisible to it — the audit's own words,
-- "searching a past meeting or a non-project event weeks outside the loaded
-- window, which needs a database search". Wave 1's own agenda batch speced
-- this exact shape without building it; this migration builds it.
--
-- Modelled on search_mail (0055), but simpler: search_mail is
-- SECURITY DEFINER because it must read across every mailbox a person can
-- open and rank by full-text relevance, which needs its own is_staff() check
-- since RLS is bypassed. calendar_events already has the right SELECT policy
-- (0026: a hand-made event is any staff member's, a synced one follows
-- can_read_connection), so SECURITY INVOKER is enough here — Postgres applies
-- the caller's own RLS row by row, the same way revenue_series and
-- revenue_mix (0030, 0031) already lean on security_invoker instead of
-- reimplementing a permission check.
--
-- ILIKE, not full-text: an event's title, detail and location are short and
-- few compared with a mailbox's messages, so a plain substring search is
-- enough, and it is what the finding asked for. A search word containing a
-- literal % or _ matches a little more loosely than someone typing it would
-- expect (both are LIKE wildcards) — a known, minor limitation, not a
-- correctness bug: nothing here concatenates untrusted SQL, p_query is a
-- bound parameter throughout.
--
-- Cancelled events are never returned, matching every other list this
-- workspace draws from calendar_events (calendar_events_window_idx, 0026;
-- agenda-model.js's own drawable() filter) — a removed or declined meeting
-- should not resurface through search only because the window filter does
-- not apply to it.
-- =============================================================================

create or replace function public.search_events(p_query text, p_limit int default 20)
returns setof public.calendar_events
language sql
stable
security invoker
set search_path = public
as $$
  select *
  from public.calendar_events
  where p_query is not null
    and btrim(p_query) <> ''
    and status <> 'cancelled'
    and (
      title ilike '%' || p_query || '%'
      or detail ilike '%' || p_query || '%'
      or location ilike '%' || p_query || '%'
    )
  order by starts_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke all on function public.search_events(text, int) from public, anon;
grant execute on function public.search_events(text, int) to authenticated;

comment on function public.search_events(text, int) is
  'A past meeting or a non-project event outside the weeks the agenda has '
  'loaded, found by a word in its title, detail or location — never a '
  'cancelled one. security_invoker: calendar_events'' own RLS (0026) decides '
  'what comes back, row by row, the same as any other read of the table. '
  'p_limit is honoured up to 50 however high a caller asks; a blank or null '
  'query returns nothing rather than the whole table (0064).';

-- ── Prove it took ────────────────────────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'search_events'
      and p.prosecdef = false -- security invoker, not definer
  ) then
    raise exception '0064: public.search_events is missing, or is not security invoker';
  end if;

  if has_function_privilege('anon', 'public.search_events(text, int)', 'execute') then
    raise exception '0064: anon can still execute search_events';
  end if;

  if not has_function_privilege('authenticated', 'public.search_events(text, int)', 'execute') then
    raise exception '0064: authenticated cannot execute search_events';
  end if;
end
$$;
