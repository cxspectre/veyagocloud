/* One source of truth for the site-wide entity graph.
 *
 * Every public page declares the same Organization and WebSite nodes. Before this
 * module they were copy-pasted per page and had drifted: three different
 * descriptions, telephone on one page only, contactType "sales" here and
 * "customer support" there. A search engine that sees four descriptions for one
 * @id has four weak signals instead of one strong one, so the nodes are defined
 * here once and written into the pages by `npm run sync:entities`
 * (tools/sync-entities.js). The static-export builders import the same objects,
 * so generated pages and hand-authored pages cannot disagree.
 *
 * The people are here too: /team/ carries the Person nodes, everything else
 * references them by @id.
 */
'use strict';

var SITE = 'https://www.veyago.cloud';

var ORG_ID = SITE + '/#organization';
var WEBSITE_ID = SITE + '/#website';
var FOUNDER_ID = SITE + '/team/#cassian-drefke';
var VP_ID = SITE + '/team/#wessel-gelderblom';

/* The sentence that defines the company. It is the Organization description, the
   opening clause of the homepage meta description, and the first line of body
   copy on /company/ — an answer engine that reads any one of the three gets the
   same claim. Change it in all three places or in none. */
var ORG_DEFINITION =
  'Veyago Inc. is an independent New York software studio that builds privacy-first iOS apps ' +
  'and fast, hand-written websites for small businesses.';

/* Profiles the company actually controls and already links to from the footer or
   the body of a page. Nothing aspirational: an unverifiable sameAs is worse than
   a short list. */
var ORG_SAME_AS = [
  'https://instagram.com/veyago_cloud',
  'https://wefunder.com/veyago',
  'https://veyago.app',
  'https://apps.apple.com/app/id6776402520',
  'https://github.com/cxspectre/veyagocloud'
];

var POSTAL_ADDRESS = {
  '@type': 'PostalAddress',
  streetAddress: '54 State Street, Ste 804 #17055',
  addressLocality: 'Albany',
  addressRegion: 'NY',
  postalCode: '12207',
  addressCountry: 'US'
};

var LANGUAGES = ['en', 'nl', 'de'];

/* Both published numbers, each labelled the way the footer labels it, plus the
   sales route. One contactPoint per real way of reaching a person. */
var CONTACT_POINTS = [
  {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    telephone: '+1-518-913-2531',
    email: 'hello@veyago.cloud',
    areaServed: 'US',
    availableLanguage: LANGUAGES
  },
  {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    telephone: '+1-943-273-6579',
    email: 'hello@veyago.cloud',
    areaServed: 'Worldwide',
    availableLanguage: LANGUAGES
  },
  {
    '@type': 'ContactPoint',
    contactType: 'sales',
    email: 'hello@veyago.cloud',
    url: SITE + '/websites/#quote',
    areaServed: 'Worldwide',
    availableLanguage: LANGUAGES
  }
];

/* The canonical Organization node. Fresh object every call so a caller that
   mutates its copy cannot corrupt the next page's. */
function organization() {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: 'Veyago Inc.',
    alternateName: 'Veyago',
    legalName: 'Veyago Inc.',
    url: SITE + '/',
    logo: {
      '@type': 'ImageObject',
      url: SITE + '/assets/apple-touch-icon.png',
      width: 512,
      height: 512
    },
    image: SITE + '/assets/og.png',
    description: ORG_DEFINITION,
    slogan: 'Software for the journey.',
    foundingDate: '2026-04-28',
    foundingLocation: { '@type': 'Place', name: 'New York, United States' },
    founder: { '@id': FOUNDER_ID },
    employee: [{ '@id': FOUNDER_ID }, { '@id': VP_ID }],
    numberOfEmployees: { '@type': 'QuantitativeValue', value: 2 },
    knowsAbout: [
      'iOS app development',
      'on-device machine learning',
      'privacy by design',
      'website design and development',
      'technical SEO',
      'small business websites'
    ],
    address: POSTAL_ADDRESS,
    email: 'hello@veyago.cloud',
    telephone: '+1-518-913-2531',
    contactPoint: CONTACT_POINTS,
    areaServed: 'Worldwide',
    sameAs: ORG_SAME_AS
  };
}

function website() {
  return {
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    url: SITE + '/',
    name: 'Veyago',
    alternateName: 'Veyago Inc.',
    description: ORG_DEFINITION,
    inLanguage: ['en', 'nl', 'de'],
    publisher: { '@id': ORG_ID }
  };
}

/* The founder, declared in full on /team/ and referenced by @id from every
   article, paper and product page. A named, described human author is the single
   biggest E-E-A-T signal a two-person studio can supply. */
function founder() {
  return {
    '@type': 'Person',
    '@id': FOUNDER_ID,
    name: 'Cassian Drefke',
    givenName: 'Cassian',
    familyName: 'Drefke',
    jobTitle: 'Founder & CEO',
    description:
      'Cassian Drefke founded Veyago Inc. in New York in April 2026 and leads product ' +
      'strategy, design and engineering. He wrote the briefs that became Kept and the ' +
      'Veyago travel app, and builds the studio’s client websites himself.',
    image: {
      '@type': 'ImageObject',
      url: SITE + '/assets/cassian-drefke-480w.webp',
      width: 480,
      height: 360
    },
    url: SITE + '/team/#cassian-drefke',
    email: 'hello@veyago.cloud',
    worksFor: { '@id': ORG_ID },
    homeLocation: { '@type': 'Place', name: 'New York, United States' },
    knowsAbout: [
      'iOS app development',
      'Swift and SwiftUI',
      'on-device machine learning',
      'privacy-first product design',
      'technical SEO',
      'static site architecture'
    ],
    knowsLanguage: ['en', 'nl', 'de']
  };
}

function vicePresident() {
  return {
    '@type': 'Person',
    '@id': VP_ID,
    name: 'Wessel Gelderblom',
    givenName: 'Wessel',
    familyName: 'Gelderblom',
    jobTitle: 'Vice President',
    description:
      'Wessel Gelderblom leads strategy and operations at Veyago Inc. He scopes and ' +
      'schedules client projects, keeps delivery on its dates, and runs the handover ' +
      'at the end of every website build.',
    image: {
      '@type': 'ImageObject',
      url: SITE + '/assets/wessel-gelderblom-480w.webp',
      width: 480,
      height: 480
    },
    url: SITE + '/team/#wessel-gelderblom',
    email: 'hello@veyago.cloud',
    worksFor: { '@id': ORG_ID },
    knowsAbout: ['product operations', 'project delivery', 'client strategy'],
    knowsLanguage: ['en', 'nl', 'de']
  };
}

/* The byline reference used by Article/Report/BlogPosting author fields. A bare
   @id on purpose: the full Person node is declared in the same @graph, and
   repeating its type and name here would read as a second declaration. */
function authorRef() {
  return { '@id': FOUNDER_ID };
}

/* A BreadcrumbList from a trail of { name, url? }. The last step is the current
   page and carries no url, which is what Google's own examples do. */
function breadcrumb(trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(function (step, i) {
      var item = { '@type': 'ListItem', position: i + 1, name: step.name };
      if (step.url) item.item = step.url;
      return item;
    })
  };
}

module.exports = {
  SITE,
  ORG_ID,
  WEBSITE_ID,
  FOUNDER_ID,
  VP_ID,
  ORG_DEFINITION,
  ORG_SAME_AS,
  organization,
  website,
  founder,
  vicePresident,
  authorRef,
  breadcrumb
};
