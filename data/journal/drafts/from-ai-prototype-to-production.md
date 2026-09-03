---
title: "You built it with Lovable or an AI prompt. Here's how to take it to production."
slug: from-ai-prototype-to-production
description: "What Lovable, v0, Bolt and a ChatGPT prompt get right, the ways those sites usually fail a month later, and what taking one to production involves."
dek: "What the prompt-to-site tools get right, where they usually stop, and what finishing the job actually involves."
tags: [websites, ai, rebuilds, lovable]
marker: Websites
author: Veyago
status: draft
published_at: 2026-09-03T09:00:00Z
---

You typed a description of your business into Lovable, v0, Bolt or ChatGPT, and something came back that looked like a website. It had a hero, a grid of features, a contact form and colours you did not have to choose. You put it live the same evening.

A month on, it feels slower than it did, nobody can find it on Google, changing the phone number takes an hour, and the copy says things about your business that are not quite true. This is the state a lot of sites are in when someone writes to us, and it is worth saying plainly: the tool did not fail. It did the thing it is for. It is just not the thing you need next.

## What those tools do well.

Credit where it is due.

- They get you from nothing to something in an hour, which is more than most agencies manage in a fortnight of discovery calls.
- They are good at layout. The hero, the three-column grid, the pricing table. The shape of a modern site is a solved problem, and they solve it.
- They make it cheap to find out what you actually want. Looking at a wrong draft is the fastest route to a right brief.

If the site is a way to find out whether anyone cares, they are exactly the right tool. The trouble starts when the test succeeds and the prototype quietly becomes the front door of the business.

## Where they usually stop.

The failure modes are consistent enough to list.

- **No real SEO.** The page has a title, and sometimes a description, but they are generic. There is no structured data, often no sitemap, and nobody has told Google the site exists. Not being indexed at all is one of the first things we check for, and it is common.
- **Generic copy.** The words were generated from a sentence about you. They read like every other generated site, and they make claims, "trusted by thousands", "industry-leading", that are not yours and may not be true.
- **Forms that go nowhere.** The contact form was drawn, not wired. Submissions vanish, or land in a service on a free plan that has since expired. Enquiries can go missing for months this way without anyone noticing.
- **Framework weight for a brochure.** The tool built a full React application to show five paragraphs and a phone number. The visitor downloads a runtime to read a menu. It is the same slowness a Wix site has, arrived at from the other direction.
- **Nobody owns the hosting or the domain.** The site lives on the tool's subdomain, or on an account created with a login nobody wrote down. When the tool changes its pricing, or you want to leave, you find out what you actually own.
- **Security basics missing.** No security headers, sometimes an API key sitting in the page source, occasionally a database the whole internet can read because the default was open and nobody closed it.

Some of these are minor. Two of them, lost enquiries and open databases, are the kind of thing you would want to know about today.

> The tool did not fail. It did what it is for. It is just not the thing you need next.

## What taking it the rest of the way involves.

"The rest of the way" is deliberate. We do not throw the prototype out. It is the best brief you could have given us.

- **Keep what works.** The structure you settled on, the sections you kept, the tone you liked. Those decisions are made, and they are yours.
- **Rebuild the structure underneath.** For a brochure site that means plain, hand-written HTML and CSS: no framework, no runtime, a page that arrives as a page. If the site genuinely needs interaction, a configurator or a customer portal, we reach for React. The tool follows the job.
- **Real content.** We replace the generated copy with what you actually do, in your words or ours, and we take out every claim that is not true.
- **Forms that deliver.** A contact form that lands in your inbox, with a copy kept somewhere you can find it, and a test we do together on launch day.
- **Headers and security.** Proper security headers, no secrets in the page, and if there is a database, rules that mean only the right people can read it.
- **SEO that exists.** Titles and descriptions per page, structured data, a sitemap, Search Console in your account, and redirects from whatever the old addresses were.
- **Your own accounts.** Hosting on a free static host in your name, your domain pointed at it, and the code in a repository you own. If we disappeared tomorrow, the site would not.
- **Analytics-free by default.** We do not add tracking unless you ask for it. Most small businesses need the Search Console numbers and their inbox, not a dashboard nobody opens. If you do want analytics, we will pick something that respects your visitors and say so on your privacy page.

The result should feel like the site you already have, finished. Same shape, same sections, but fast, findable, honest, and yours.

## How to tell if your site is actually fine.

Not every prototype needs this, and we would rather say so than sell you a rebuild. Run through these, honestly.

1. Search Google for your business name in quotes, and for your street address. Does your site appear? If not, it is not indexed, and that is the first thing to fix.
2. Fill in your own contact form from your phone. Did the message arrive? Where?
3. Open the site on a phone, away from wifi. Count the seconds before you can read it.
4. Read the copy aloud. Is every sentence true of your business?
5. Find the login for the hosting and for the domain. Can you? Are they in your name?
6. Paste your address into PageSpeed Insights, which Google offers free, and look at the mobile score.

If the answers are yes, it arrived, quickly, yes, yes, and green, your site is fine. Keep it and spend the money on something else. If two or three of them are no, you have a working prototype and a very good brief, which is a better place to start than most people get.

---

[Send us the address of your current site](https://www.veyago.cloud/websites/#quote) and we will tell you honestly what it would take to finish it, or that it does not need finishing. Either answer is free.
