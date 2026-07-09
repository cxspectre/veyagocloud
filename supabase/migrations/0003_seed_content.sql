-- =============================================================================
-- Veyago — seed existing site content into the CMS tables.
--
-- Run this AFTER 0001_init.sql and 0002_announcements_apps_projects.sql.
-- Mirrors the content currently live on veyago.cloud so the admin immediately
-- reflects reality. Safe to re-run (uses ON CONFLICT DO NOTHING).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Announcement: the Kept launch-update bar currently hardcoded in site-config.js
-- ---------------------------------------------------------------------------
insert into public.site_announcements (key, message, link_text, link_href, active)
values (
  'kept-2026-06',
  '<strong>Launch update</strong> — We''d aimed to launch Kept the week of June 8; it now arrives within two weeks of June 15 as we finish Apple''s move to an organization developer account and final certification.',
  'Get updates ›',
  'mailto:hello@veyago.cloud?subject=Notify%20me%20when%20Kept%20launches',
  true
)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Apps (from data/apps.js — all four entries, published flag preserved)
-- ---------------------------------------------------------------------------
insert into public.apps
  (slug, name, tagline, description, category, status, launch_window, platforms, pricing,
   product_url, published, sort_order)
values
  (
    'veyago-travel',
    'Veyago',
    'Your next voyage starts with a swipe.',
    'Swipe, bracket, and let Veyago Intelligence decide — a travel OS that turns "where should we go?" into a planned trip, solo or with your whole group.',
    'travel',
    'scheduled',
    'Q3 2026',
    'iOS & Android',
    'Free · optional Premium',
    '/veyago/',
    true,
    1
  ),
  (
    'kept',
    'Kept',
    'Never lose track of what matters.',
    'Warranties, receipts, documents, subscriptions and expiry dates — sorted by what''s next and reminded before anything lapses. No account, no servers; everything stays on your device and your iCloud.',
    'life-admin',
    'scheduled',
    'late June 2026',
    'iOS',
    'Free · one-time lifetime unlock',
    '/kept/',
    true,
    2
  ),
  (
    'newcomer-academy',
    'Newcomer Academy',
    'Learn to code, one story at a time.',
    'A story-driven path from your first line of code toward real fluency. Foundations is built and running; the rest of the curriculum arrives in phases.',
    'education',
    'in-development',
    null,
    'iPhone · iPad · Mac',
    'Free Foundations · one-time unlock for the rest',
    null,
    false,  -- not on the catalogue yet; flip to true when it has a firm date
    3
  ),
  (
    'spatiback',
    'Spätiback',
    'Your Späti, rewarded.',
    'Berlin-focused convenience-store discovery, deals and loyalty. The earliest project in the studio — held until it is further along.',
    'local-retail',
    'in-development',
    null,
    'iOS',
    'Free',
    null,
    false,  -- held; too early to be public
    4
  )
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Projects (from data/projects.js)
-- ---------------------------------------------------------------------------
insert into public.projects
  (slug, name, stage, question, finding, essay_title, essay_slug,
   related_label, related_href, published, sort_order)
values
  (
    'on-device-intelligence',
    'On-device intelligence',
    'researching',
    'Is the old trade-off between intelligent and private still real — or is it collapsing?',
    'For most of the cloud era you could build software that was intelligent or private, not both. That trade-off is now narrowing for a specific class of work — latency-sensitive, privacy-critical, structured around your own data — so a privacy-first product can finally offer understanding, not just storage, without sending anything anywhere. This research informs the whole catalogue rather than any single app.',
    'The Edge Moves In',
    'the-edge-moves-in',
    null,
    null,
    true,
    1
  ),
  (
    'newcomer-academy',
    'Newcomer Academy',
    'prototyping',
    'Can a story-driven, narrative path take a true beginner to real coding fluency where reference-style courses lose them?',
    'Foundations is built and running — proving the story-driven approach with real learners. The rest of the curriculum is early and phased, with no launch date and no research paper yet. It sits here, rather than on the Apps page, until it has a firm date.',
    null,
    null,
    null,
    null,
    true,
    2
  ),
  (
    'spatiback',
    'Spätiback',
    'prototyping',
    'Can a neighbourhood convenience network — Berlin''s Spätis — support real discovery, deals and loyalty without the surveillance retail apps usually carry?',
    'The earliest project in the studio, in early prototyping. We are testing whether the idea holds before committing to a build; there is no research paper yet, and we would rather show it honestly as exploration than dress it up.',
    null,
    null,
    null,
    null,
    false,  -- held; too early to be public
    3
  ),
  (
    'kept',
    'Kept',
    'building',
    'Why does so much life admin — warranties, receipts, documents, subscriptions, expiry dates — slip through the cracks?',
    'The failure is not discipline, it is architecture: the records that govern your obligations are scattered with no trusted home, the consequences of losing track arrive late, and nothing watches a deadline before it lapses. The analysis points to a single, private, on-device system of record that does the watching — and prepares the action for you to approve.',
    'The Unkept Life',
    'the-unkept-life',
    'Kept',
    '/apps/#kept',
    true,
    4
  ),
  (
    'veyago-travel',
    'Veyago travel',
    'building',
    'Why do group trips stall in decision paralysis — and could a swipe-and-eliminate mechanic turn that into a shared decision?',
    'Group trips stall not on logistics but on the decision: where do we even go? The working thesis is that a four-round elimination bracket turns paralysis into a decision a group can actually reach together. The full research write-up is in progress.',
    null,
    null,
    'Veyago travel',
    '/apps/#veyago',
    true,
    5
  )
on conflict (slug) do nothing;
