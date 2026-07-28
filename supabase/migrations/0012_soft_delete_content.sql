-- 0012 — deleting content becomes a manager act, and a recoverable one.
--
-- 0007 repointed every content table at is_staff() with `for all`, and "for
-- all" includes DELETE. So a plain `employee` — the least-privileged role in
-- the product — could permanently remove every article, wallpaper, app page,
-- announcement and project on the public site, with one click, no confirmation
-- beyond a window.confirm, and no way back. That was never stated anywhere: the
-- role copy said "create and edit site content".
--
-- Two changes, decided 2026-07-28:
--   1. DELETE narrows to managers (owner, admin).
--   2. Deleting is soft. deleted_at is set instead of the row being destroyed,
--      so a mistake is a mistake and not an incident.
--
-- WHERE THE FILTERING LIVES. The public build (tools/build.js) reads with the
-- ANON key, so RLS applies to it. Putting `deleted_at is null` in the anonymous
-- SELECT policies means a deleted row cannot reach the live site even if a
-- query somewhere forgets to filter — the irreversible, public-facing path is
-- protected structurally rather than by remembering. Staff SELECT is left wide
-- so the admin can still see and restore what it deleted; admin lists filter
-- explicitly, and the worst case there is a deleted row showing in a list.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The column
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.articles           add column if not exists deleted_at timestamptz;
alter table public.wallpapers         add column if not exists deleted_at timestamptz;
alter table public.apps               add column if not exists deleted_at timestamptz;
alter table public.projects           add column if not exists deleted_at timestamptz;
alter table public.site_announcements add column if not exists deleted_at timestamptz;

-- Partial indexes: every list query filters on this, and the live set is the
-- overwhelming majority, so index the rows that are actually read.
create index if not exists articles_live_idx           on public.articles (published_at desc)    where deleted_at is null;
create index if not exists wallpapers_live_idx         on public.wallpapers (published_at desc)  where deleted_at is null;
create index if not exists apps_live_idx               on public.apps (created_at desc)          where deleted_at is null;
create index if not exists projects_live_idx           on public.projects (created_at desc)      where deleted_at is null;
create index if not exists site_announcements_live_idx on public.site_announcements (created_at desc) where deleted_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Anonymous read excludes deleted rows
--    This is what makes the build safe. Recreated rather than altered, because
--    a policy's USING clause cannot be amended in place — and dropped by the
--    names 0001/0002 actually used, because RLS policies are OR'd: a missed
--    drop leaves the permissive original serving deleted rows to the build.
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists "read published articles" on public.articles;
create policy "read published articles"
  on public.articles for select
  using (status = 'published' and deleted_at is null);

drop policy if exists "read published wallpapers" on public.wallpapers;
create policy "read published wallpapers"
  on public.wallpapers for select
  using (status = 'published' and deleted_at is null);

drop policy if exists "read announcements" on public.site_announcements;
create policy "read announcements"
  on public.site_announcements for select
  using (deleted_at is null);

drop policy if exists "read published apps" on public.apps;
create policy "read published apps"
  on public.apps for select
  using (published = true and deleted_at is null);

drop policy if exists "read published projects" on public.projects;
create policy "read published projects"
  on public.projects for select
  using (published = true and deleted_at is null);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Split the write policies
--    0007's single `for all` policy is replaced by explicit verbs, so DELETE
--    can be narrowed without also narrowing the editing that staff are hired
--    to do. Dropped by name — 0007 created these, so the names are known.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array['articles','wallpapers','site_announcements','apps','projects'] loop
    execute format('drop policy if exists %I on public.%I',
                   'staff writes ' || replace(t, 'site_announcements', 'announcements'), t);

    /* Staff read everything, including deleted rows: the admin has to be able
       to show what it removed, and to put it back. */
    execute format($f$
      create policy "staff reads %1$s" on public.%1$I for select
        using (public.is_staff());
    $f$, t);

    execute format($f$
      create policy "staff creates %1$s" on public.%1$I for insert
        with check (public.is_staff());
    $f$, t);

    execute format($f$
      create policy "staff edits %1$s" on public.%1$I for update
        using (public.is_staff()) with check (public.is_staff());
    $f$, t);

    /* Hard delete is managers only, and in practice nothing in the UI calls it
       — the admin sets deleted_at instead. It stays available so a manager can
       genuinely purge something from the SQL editor. */
    execute format($f$
      create policy "manager deletes %1$s" on public.%1$I for delete
        using (public.is_manager());
    $f$, t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Only a manager may set or clear deleted_at
--    Without this the UPDATE policy above would let any staff member soft-
--    delete, which is the same power under a different verb.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.guard_soft_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service role (the build, the deploy function) has no auth.uid().
  if auth.uid() is null then
    return new;
  end if;
  if new.deleted_at is distinct from old.deleted_at and not public.is_manager() then
    raise exception 'Only an owner or admin can delete or restore content';
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['articles','wallpapers','site_announcements','apps','projects'] loop
    execute format('drop trigger if exists guard_soft_delete on public.%I', t);
    /* Named to sort before %I_touch_updated_at where one exists — two BEFORE
       UPDATE triggers fire in alphabetical order. */
    execute format($f$
      create trigger guard_soft_delete before update on public.%1$I
        for each row execute function public.guard_soft_delete();
    $f$, t);
  end loop;
end $$;
