-- =============================================================================
-- Veyago — add a composable product-page layout to apps.
--
-- The apps admin gains a live, section-based editor (hero, feature rows with
-- image placement, steps, feature cards, CTA band) — the same kind of page the
-- hand-authored /kept/ and /veyago/ pages use. The composed sections live in a
-- single JSONB column so the build can render /apps/<slug>/index.html from them.
--
-- Run AFTER 0002_announcements_apps_projects.sql. Safe to re-run.
-- =============================================================================

alter table public.apps
  add column if not exists layout jsonb not null default '[]'::jsonb;

comment on column public.apps.layout is
  'Ordered array of product-page sections composed in /admin/apps-editor.html. '
  'Section shapes: hero, feature, steps, cards, cta. Rendered to /apps/<slug>/ by tools/build.js.';
