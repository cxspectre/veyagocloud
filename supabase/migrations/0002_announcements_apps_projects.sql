-- =============================================================================
-- Veyago admin expansion — announcements, apps catalogue, projects registry.
-- Run in Supabase SQL editor AFTER 0001_init.sql.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Site announcements (the launch-bar shown on every page).
-- Only ONE row should be active at a time; the UI enforces this by deactivating
-- others when you activate a new one. The build exports the active row to
-- assets/js/site-config.js, which app.js reads (zero runtime Supabase calls).
-- ---------------------------------------------------------------------------
create table if not exists public.site_announcements (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,              -- localStorage dismiss key, e.g. "kept-launch-v2"
  message     text not null,             -- plain text, shown in the bar
  link_text   text,                      -- optional CTA label
  link_href   text,                      -- optional CTA href (mailto: or https://)
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists announcements_touch_updated_at on public.site_announcements;
create trigger announcements_touch_updated_at
  before update on public.site_announcements
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Apps catalogue. Mirrors the shape in data/apps.js.
-- ---------------------------------------------------------------------------
create table if not exists public.apps (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  name          text not null,
  tagline       text,                   -- one plain-voice positioning line
  description   text,                  -- 1-2 sentences for the card
  category      text,                  -- 'travel' | 'life-admin' | 'education' | 'local-retail'
  status        text not null default 'in-development'
                  check (status in ('live','beta','scheduled','in-development')),
  launch_window text,                  -- e.g. 'Q3 2026' — shown only when status = scheduled
  platforms     text,                  -- 'iOS & Android', 'iOS'
  pricing       text,
  app_store_url text,
  product_url   text,                  -- external product site or /veyago etc.
  icon_url      text,                  -- app icon stored in Storage
  published     boolean not null default false,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists apps_touch_updated_at on public.apps;
create trigger apps_touch_updated_at
  before update on public.apps
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Projects / R&D registry. Mirrors data/projects.js.
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  stage       text not null default 'researching'
                check (stage in ('researching','prototyping','building','graduated')),
  question    text,                    -- the research question
  finding     text,                   -- summary of what we found / where it stands
  essay_title text,                   -- if there's a working paper at /projects/<essay_slug>/
  essay_slug  text,
  related_label text,                 -- link to the resulting app: label
  related_href  text,                 -- e.g. /apps/#kept
  published   boolean not null default false,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.site_announcements enable row level security;
alter table public.apps               enable row level security;
alter table public.projects           enable row level security;

-- Announcements: anyone can read (needed for the build's anon-key reader).
drop policy if exists "read announcements" on public.site_announcements;
create policy "read announcements"
  on public.site_announcements for select using (true);

drop policy if exists "admin writes announcements" on public.site_announcements;
create policy "admin writes announcements"
  on public.site_announcements for all
  using (public.is_admin()) with check (public.is_admin());

-- Published apps/projects: anyone can read.
drop policy if exists "read published apps" on public.apps;
create policy "read published apps"
  on public.apps for select using (published = true);

drop policy if exists "read published projects" on public.projects;
create policy "read published projects"
  on public.projects for select using (published = true);

-- Admin can do everything (incl. reading drafts).
drop policy if exists "admin writes apps" on public.apps;
create policy "admin writes apps"
  on public.apps for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin writes projects" on public.projects;
create policy "admin writes projects"
  on public.projects for all
  using (public.is_admin()) with check (public.is_admin());
