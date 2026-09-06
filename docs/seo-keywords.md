# Keyword targets

What the Position Tracking campaign should measure, and which page answers each
query. Written 6 September 2026 after the first Semrush audit came back.

No search volumes here. Nobody can read those off a page — Semrush fills them in
when the terms are loaded, and the numbers should come from the tool rather than
from a guess written into a file.

## Two problems with the campaign as it stands

**It tracks one keyword: `veyago.cloud`.** Our own domain. It ranks 1, it has no
volume, it sends no traffic, and it will report "100% visibility, no change" for
as long as it runs. A campaign that cannot go down is not measuring anything.

**It tracks Desktop, United Kingdom.** We are a New York C-Corp quoting in
dollars, with static Dutch and German pages at `/nl/` and `/de/`. The UK is not a
market we sell to. The campaign should run three ways — United States, the
Netherlands, Germany — with mobile tracked as well as desktop, since a small
business owner looking for a web designer is usually on a phone.

## How these were chosen

The audit made the position clear: a four-month-old domain with almost no inbound
links. Head terms are out of reach, and it is worth being blunt about why. A
search written to describe `/websites/` almost word for word — fixed price, $699,
hand-written, no monthly fee — returns DappaSol (whose tier is *also* $699),
Mumoa ("no monthly fee, no annual renewal") and Esker ("100% hand-coded"). Every
line on our page is somebody's headline already, and they have years of links.

So the set below skips the head and goes where the intent is specific enough that
depth beats authority:

- **Migration intent.** The job we say we are asked about most, and almost nobody
  writes for it properly.
- **Price transparency.** We publish real numbers. Most agencies publish "contact
  us", so a page that answers the question can win the query.
- **Dutch and German.** The real edge. We already publish localised pages with
  properly targeted titles, and the competitive set in those languages is thinner
  than in English.

Status column: **live** means a page exists and answers the query today.
**thin** means the page exists but does not really address it. **gap** means
nothing on the site answers it — those are the next articles to write.

## Migration and rebuild — English

| Query | Target | Status |
| --- | --- | --- |
| wix site slow how to fix | `/journal/why-your-wix-site-is-slow/` | live |
| why is my squarespace site so slow | `/journal/why-your-wix-site-is-slow/` | live |
| move off wix without losing google ranking | `/journal/why-your-wix-site-is-slow/` | live |
| rebuild wix site keep seo | `/websites/` | live |
| lovable website to production | `/journal/from-ai-prototype-to-production/` | live |
| v0 prototype to real website | `/journal/from-ai-prototype-to-production/` | live |
| ai generated website problems | `/journal/from-ai-prototype-to-production/` | live |
| export squarespace site to own code | — | gap |

## Price and scope — English

| Query | Target | Status |
| --- | --- | --- |
| what does a $699 website include | `/journal/what-a-699-website-includes/` | live |
| fixed price website design no monthly fee | `/websites/` | live |
| small business website cost breakdown | `/journal/what-a-699-website-includes/` | live |
| website design fixed quote in writing | `/websites/#quote` | live |
| landing page design fixed price | `/websites/` | live |

## Ownership and privacy — English

These are the angle nobody else in the competitive set argues, which makes them
cheap to own even though the volume is smaller.

| Query | Target | Status |
| --- | --- | --- |
| own your website code and domain | `/websites/` | thin |
| website without a cookie banner | — | gap |
| static website no trackers small business | `/websites/` | thin |
| hand coded website vs wordpress | — | gap |

## Dutch — `/nl/websites/`

The `/nl/` title already targets *website laten maken* correctly. These are the
variants worth tracking against it.

| Query | Target | Status |
| --- | --- | --- |
| website laten maken vaste prijs | `/nl/websites/` | live |
| website laten maken kleine onderneming | `/nl/websites/` | live |
| website laten maken zonder maandelijkse kosten | `/nl/websites/` | live |
| landingspagina laten maken prijs | `/nl/websites/` | live |
| wix site traag | — | gap (article not translated) |
| website overzetten van wix | `/nl/websites/` | thin |

## German — `/de/websites/`

| Query | Target | Status |
| --- | --- | --- |
| website erstellen lassen festpreis | `/de/websites/` | live |
| webseite erstellen lassen kleines unternehmen | `/de/websites/` | live |
| webseite ohne monatliche kosten | `/de/websites/` | live |
| landingpage erstellen lassen preis | `/de/websites/` | live |
| wix website langsam | — | gap (article not translated) |
| webseite umziehen wix seo behalten | `/de/websites/` | thin |

## Apps — secondary, different buyer

| Query | Target | Status |
| --- | --- | --- |
| private warranty tracker app ios | `/kept/` | live |
| track warranties and receipts offline iphone | `/kept/` | live |
| receipt tracker no account no cloud | `/kept/` | live |

## Brand — defensive, not growth

Worth tracking only because there is another company called Veyago, in travel,
with a Medium profile, a LinkedIn and the Crunchbase entry. When these slip, the
name is being lost rather than the pages.

| Query | Target |
| --- | --- |
| veyago cloud | `/` |
| veyago studio | `/company/` |
| veyago websites | `/websites/` |
| kept app veyago | `/kept/` |

## The gaps, in the order worth writing them

1. **A cookie-banner article.** We already build every site without one, the
   argument is written across `/approach/`, and nobody selling websites makes it.
2. **Hand-coded vs WordPress.** High commercial intent, and we can answer it with
   real numbers off our own pages rather than opinion.
3. **Dutch and German translations of the three articles.** The single biggest
   remaining win, because it doubles the long-tail coverage in the two markets
   where we can realistically rank. Blocked on architecture: articles come from
   Supabase and the locale builder only covers the six static pages in
   `tools/build-locales.js`. Worth solving before writing more English articles.

## Links, which matter more than any of the above

The audit's real finding is that almost nothing links to us. Two fixes cost
nothing and are worth more than every on-page change combined:

**1. `veyago.app` does not link to `veyago.cloud`.** Our own other domain, and it
passes us nothing. A studio credit in its footer fixes that.

**2. The four sites in the Recent work grid.** We built them and we look after
them. A credit in each footer is four contextual links from real businesses in
adjacent industries — ask first, and only where the client is happy:

```html
<p class="site-credit">
  Site by <a href="https://www.veyago.cloud/websites/" rel="noopener">Veyago</a>
</p>
```

Keep the anchor as *Veyago* or *Veyago — websites for business*. Not "click
here", and not the bare URL: the audit flagged 29 of those on our own site and we
have just finished removing them.
