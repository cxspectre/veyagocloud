-- =============================================================================
-- Veyago — Journal + Wallpapers v1 — initial schema, RLS, and Storage.
--
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- It is idempotent where practical, so re-running is safe.
--
-- Security model (see supabase/README.md): supabase-js runs in the BROWSER on the
-- /admin pages with the public "anon" key. Row Level Security is the ONLY real
-- boundary — anonymous visitors may read published rows; only the single admin
-- (the one row in public.admins) may write. The public website never calls
-- Supabase: a build step (tools/build.js) reads published rows and renders static
-- HTML into the repo. No service-role key is used anywhere.
-- =============================================================================

-- Needed for gen_random_uuid().
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Admin allowlist. Your auth user id goes in here once, by hand (see README §4).
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

-- Helper used by every admin policy below. SECURITY DEFINER so the policy check
-- can read public.admins regardless of the caller's own row visibility, and STABLE
-- so the planner can cache it within a statement.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Keep updated_at honest on articles.
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Articles. The "body" column is the ordered list of section blocks (see spec §4
-- and tools/lib/render-blocks.js). Authored in /admin, rendered to static HTML.
-- ---------------------------------------------------------------------------
create table if not exists public.articles (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,                       -- url segment, e.g. building-the-spine
  title           text not null,
  dek             text,                                       -- standfirst / subtitle
  excerpt         text,                                       -- list + social preview
  cover_image_url text,
  body            jsonb not null default '[]'::jsonb,         -- ordered array of section blocks
  status          text not null default 'draft' check (status in ('draft','published')),
  tier            text not null default 'free' check (tier in ('free','paid')),  -- future use; always free in v1
  reading_minutes int,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists articles_published_idx on public.articles (status, published_at desc);

drop trigger if exists articles_touch_updated_at on public.articles;
create trigger articles_touch_updated_at
  before update on public.articles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Wallpapers. "variants" holds the per-device download options:
--   [ { "label": "Desktop", "url": "...", "width": 5120, "height": 2880, "format": "png" }, ... ]
-- ---------------------------------------------------------------------------
create table if not exists public.wallpapers (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  title        text not null,
  description  text,
  category     text,                                          -- optional grouping, e.g. "Wordmark", "Travel"
  preview_url  text not null,                                 -- the gallery thumbnail
  variants     jsonb not null default '[]'::jsonb,
  status       text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists wallpapers_published_idx on public.wallpapers (status, published_at desc);

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table public.articles   enable row level security;
alter table public.wallpapers enable row level security;
alter table public.admins     enable row level security;

-- Anyone can read PUBLISHED content (used by the build's anon-key reader).
drop policy if exists "read published articles" on public.articles;
create policy "read published articles"
  on public.articles for select
  using (status = 'published');

drop policy if exists "read published wallpapers" on public.wallpapers;
create policy "read published wallpapers"
  on public.wallpapers for select
  using (status = 'published');

-- Admin can do everything. For SELECT this OR's with the public policy above,
-- so the admin also sees drafts.
drop policy if exists "admin writes articles" on public.articles;
create policy "admin writes articles"
  on public.articles for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin writes wallpapers" on public.wallpapers;
create policy "admin writes wallpapers"
  on public.wallpapers for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin reads admins" on public.admins;
create policy "admin reads admins"
  on public.admins for select
  using (public.is_admin());

-- =============================================================================
-- Storage — two public-read, admin-write buckets.
--   article-media : cover images + inline article images
--   wallpapers    : preview thumbnails + full-resolution downloadable files
-- The build pulls these binaries into the repo (/assets/...) so the PUBLIC site
-- serves them first-party; the buckets are the authoring staging area.
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('article-media', 'article-media', true)
on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
values ('wallpapers', 'wallpapers', true)
on conflict (id) do update set public = true;

-- Public read for objects in both buckets.
drop policy if exists "public read media buckets" on storage.objects;
create policy "public read media buckets"
  on storage.objects for select
  using (bucket_id in ('article-media', 'wallpapers'));

-- Admin-only write/update/delete in both buckets.
drop policy if exists "admin writes media buckets" on storage.objects;
create policy "admin writes media buckets"
  on storage.objects for insert
  with check (bucket_id in ('article-media', 'wallpapers') and public.is_admin());

drop policy if exists "admin updates media buckets" on storage.objects;
create policy "admin updates media buckets"
  on storage.objects for update
  using (bucket_id in ('article-media', 'wallpapers') and public.is_admin())
  with check (bucket_id in ('article-media', 'wallpapers') and public.is_admin());

drop policy if exists "admin deletes media buckets" on storage.objects;
create policy "admin deletes media buckets"
  on storage.objects for delete
  using (bucket_id in ('article-media', 'wallpapers') and public.is_admin());

-- =============================================================================
-- BOOTSTRAP (do this AFTER creating your auth user — see README §3–4):
--   insert into public.admins (user_id, email)
--   values ('00000000-0000-0000-0000-000000000000', 'you@example.com');
-- Find the uuid in Dashboard → Authentication → Users (click your user).
-- =============================================================================
