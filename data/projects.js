/* =============================================================================
   Veyago Projects / in-house R&D - canonical content model.

   The workbench at /projects/index.html is authored from these objects; the
   research index is the set of entries that carry an `essay`. A project appears
   only once it has something real (a finding, a prototype, visible progress) -
   no empty placeholders (the spec's "research theatre").

   Pipeline stage: 'researching' | 'prototyping' | 'building' | 'graduated'
     researching  - investigating a question; findings, no committed build
     prototyping  - testing an approach in a rough build
     building     - committed, in active development (also on /apps/)
     graduated    - shipped as an app; /apps/ is its canonical home

   Project shape:
     id, name, stage, question, finding (summary),
     essay   : { title, slug } | null   - full paper at /projects/<slug>/
     related : { label, href } | null   - the app it becomes, on /apps/
     published, lastUpdated
============================================================================= */

export const STAGES = [
  { id: 'researching', label: 'Researching', note: 'A question, investigated. Findings, no committed build.' },
  { id: 'prototyping', label: 'Prototyping', note: 'Testing an approach in a rough build to see if it holds.' },
  { id: 'building',    label: 'Building',    note: 'Committed and in active development - also on the Apps page.' },
  { id: 'graduated',   label: 'Graduated',   note: 'Shipped as an app. The Apps page becomes its home.' },
];

export const projects = [
  {
    id: 'on-device-intelligence',
    name: 'On-device intelligence',
    stage: 'researching',
    question: 'Is the old trade-off between intelligent and private still real - or is it collapsing?',
    finding:
      'For most of the cloud era you could build software that was intelligent or private, not both. That trade-off is now narrowing for a specific class of work - latency-sensitive, privacy-critical, structured around your own data - so a privacy-first product can finally offer understanding, not just storage, without sending anything anywhere. This research informs the whole catalogue rather than any single app.',
    essay: { title: 'The Edge Moves In', slug: 'the-edge-moves-in' },
    related: null,
    published: true,
    lastUpdated: '2026-06-12',
  },
  {
    id: 'spatiback',
    name: 'Spätiback',
    stage: 'prototyping',
    question: 'Can a neighbourhood convenience network - Berlin\'s Spätis - support real discovery, deals and loyalty without the surveillance retail apps usually carry?',
    finding:
      'The earliest project in the studio, in early prototyping. We are testing whether the idea holds before committing to a build; there is no research paper yet, and we would rather show it honestly as exploration than dress it up.',
    essay: null,
    related: null,
    published: false,  // held - too early to be public; restore the pipeline chip + entry on /projects/ to bring back
    lastUpdated: '2026-06-12',
  },
  {
    id: 'kept',
    name: 'Kept',
    stage: 'building',
    question: 'Why does so much life admin - warranties, receipts, documents, subscriptions, expiry dates - slip through the cracks?',
    finding:
      'The failure is not discipline, it is architecture: the records that govern your obligations are scattered with no trusted home, the consequences of losing track arrive late, and nothing watches a deadline before it lapses. The analysis points to a single, private, on-device system of record that does the watching - and prepares the action for you to approve.',
    essay: { title: 'The Unkept Life', slug: 'the-unkept-life' },
    related: { label: 'Kept', href: '/apps/#kept' },
    published: true,
    lastUpdated: '2026-06-12',
  },
  {
    id: 'veyago-travel',
    name: 'Veyago travel',
    stage: 'building',
    question: 'Why do group trips stall in decision paralysis - and could a swipe-and-eliminate mechanic turn that into a shared decision?',
    finding:
      'Group trips stall not on logistics but on the decision: where do we even go? The working thesis is that a four-round elimination bracket turns paralysis into a decision a group can actually reach together. The full research write-up is in progress.',
    essay: null,
    related: { label: 'Veyago travel', href: '/apps/#veyago' },
    published: true,
    lastUpdated: '2026-06-12',
  },
];
