/* =============================================================================
   Veyago app catalogue - canonical content model (single source of truth).

   The static catalogue in /apps/index.html is authored from these objects; keep
   the two in sync (each published app = one .cat-card). On a no-build static
   site this stays plain HTML for SEO + i18n, while this file documents the model
   and is the obvious place to make a content edit.

   App shape:
     id          kebab id
     name        product name
     category    'travel' | 'life-admin' | 'education' | 'local-retail'
     positioning one plain-voice line
     description 1-2 sentences (shown on the card)
     status      'live' | 'beta' | 'scheduled' | 'in-development'
     window      target window text (scheduled only), else null
     platforms   human string, e.g. 'iOS & Android'
     pricing     honest pricing, e.g. 'Free · one-time lifetime unlock'
     badges      values that are TRUE of this app only (see VALUES wording)
     cta         { label, href }  - label follows status
     deeper      { label, href } | null  - secondary route (product page/site)
     visual      { src, alt } | null  - real screenshot only; null => honest placeholder
     published   show on the catalogue yet?
     lastUpdated ISO date - anchors the status, flags staleness

   HONESTY: status is never inflated; a window is shown only if we intend to hit
   it; no invented traction; visuals are real screenshots or a labelled preview.
============================================================================= */

export const VALUES = {
  privacy:   'Privacy by design',
  onDevice:  'On-device',
  noTrack:   'No tracking',
  noAds:     'No ad targeting',
  noSold:    'No data sold',
  payOnce:   'Pay once',
  noDark:    'No dark patterns',
};

export const apps = [
  {
    id: 'veyago',
    name: 'Veyago',
    category: 'travel',
    positioning: 'Your next voyage starts with a swipe.',
    description:
      'Swipe, bracket, and let Veyago Intelligence decide - a travel OS that turns "where should we go?" into a planned trip, solo or with your whole group.',
    status: 'scheduled',
    window: 'Q3 2026',
    platforms: 'iOS & Android',
    pricing: 'Free · optional Premium',
    badges: [VALUES.noAds, VALUES.noSold],
    cta: { label: 'Join the waitlist', href: 'https://waitlister.me/p/veyago-travel-made-easy' },
    deeper: { label: 'Learn more', href: '/veyago/' },
    visual: { src: '/assets/veyago-discover.jpg', alt: 'The Veyago Discover screen - an editorial feature on Tokyo with time-sensitive in-season picks' },
    published: true,
    lastUpdated: '2026-06-12',
  },
  {
    id: 'kept',
    name: 'Kept',
    category: 'life-admin',
    positioning: 'Never lose track of what matters.',
    description:
      'Warranties, receipts, documents, subscriptions and expiry dates - sorted by what\'s next and reminded before anything lapses. No account, no servers; everything stays on your device and your iCloud.',
    status: 'scheduled',
    window: 'late June 2026',
    platforms: 'iOS',
    pricing: 'Free · one-time lifetime unlock',
    badges: [VALUES.privacy, VALUES.onDevice, VALUES.noTrack, VALUES.payOnce],
    cta: { label: 'Notify me', href: 'mailto:hello@veyago.cloud?subject=Notify%20me%20when%20Kept%20launches' },
    deeper: { label: 'View Kept', href: '/kept/' },
    visual: { src: '/assets/kept-upcoming.png', alt: 'Kept showing upcoming expiry dates and reminders' },
    published: true,
    lastUpdated: '2026-06-12',
  },
  {
    id: 'newcomer-academy',
    name: 'Newcomer Academy',
    category: 'education',
    positioning: 'Learn to code, one story at a time.',
    description:
      'A story-driven path from your first line of code toward real fluency. Foundations is built and running; the rest of the curriculum arrives in phases.',
    status: 'in-development',
    window: null,
    platforms: 'iPhone · iPad · Mac',
    pricing: 'Free Foundations · one-time unlock for the rest',
    badges: [VALUES.payOnce, VALUES.noTrack, VALUES.noAds],
    cta: { label: 'Follow along', href: 'mailto:hello@veyago.cloud?subject=Newcomer%20Academy%20interest' },
    deeper: null,
    visual: null, // no shippable build yet -> honest labelled placeholder, never a staged shot
    published: true,
    lastUpdated: '2026-06-12',
  },
  {
    id: 'spatiback',
    name: 'Spätiback',
    category: 'local-retail',
    positioning: 'Your Späti, rewarded.',
    description:
      'Berlin-focused convenience-store discovery, deals and loyalty. The earliest project in the studio - held until it is further along.',
    status: 'in-development',
    window: null,
    platforms: 'iOS',
    pricing: 'Free',
    badges: [VALUES.noDark],
    cta: { label: 'Follow along', href: 'mailto:hello@veyago.cloud?subject=Sp%C3%A4tiback%20interest' },
    deeper: null,
    visual: null,
    // Held entirely for now - too early to be public (off both the catalogue and Projects).
    // Flip published to true (and re-add a Projects entry) when it is further along.
    published: false,
    lastUpdated: '2026-06-12',
  },
];
