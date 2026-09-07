# Journal drafts

Three unpublished articles for the Websites section, each in two forms: `<slug>.md` (the source, for the admin editor) and `<slug>.json` (the same article in the fixture shape `tools/build.js --fixture` accepts, one article per file, `status: "draft"`, no cover image, `published_at` 2026-09-03). The `.json` is generated from the `.md`, so treat the Markdown as the master copy and regenerate the fixture rather than editing both.

**To publish (one paste):** run `supabase/seed/publish-website-articles.sql` in the Supabase SQL editor. It upserts all three rows as `status: "published"` straight from the fixtures below, so it is safe to re-run, and `/journal/` flips itself from noindex to index as soon as it has an article. Then run the Publish workflow (or `npm run build`) to regenerate `/journal` from Supabase. Regenerate the SQL from the fixtures if the text changes.

**To publish by hand instead:** open `/admin`, create a new article, and paste the Markdown in section by section. The editor is a block editor, not a Markdown importer, so each `##` becomes a Heading block, each paragraph-plus-list run becomes a Text block (bold and links survive the paste clean; only p/strong/em/a/ul/ol/li/br are kept at build time anyway), each `>` line becomes a Pull quote block, and each `---` becomes a Divider. Set the title, dek, slug and excerpt from the front-matter block (there is no tags or author field in the schema, so those front-matter lines are for the editor's reference only), leave the cover empty unless you want one, then Publish and run `npm run build` as normal.

**To preview locally without Supabase:** `node tools/build.js --fixture data/journal/drafts/<slug>.json` renders the article to `/journal/<slug>/` and the fixture does not filter on `status`, so a draft renders fine. Be aware that the build wipes and regenerates the whole `/journal` folder and rewrites the build-managed block of `sitemap.xml`, so run it on a throwaway checkout or reset with `node tools/build.js --fixture data/journal/empty.json` afterwards and discard the changes.

## Package numbers the pricing article depends on

`what-a-699-website-includes` quotes the published packages verbatim. If any of these change on `/websites/`, update the article (both files) in the same change.

| Line | USD | EUR | Also stated in the article |
| --- | --- | --- | --- |
| Launch (landing page) | $699 | €750 | one page, up to five sections, one round of revisions, 7 to 10 working days |
| Business (multi-page) | $1,690 | €1,790 | up to six pages, two rounds of revisions, two to four weeks |
| Back office (site + tools) | from $3,900 | from €4,100 | everything in Business plus a login area, built on Supabase, four to eight weeks |
| Copywriting | from $120 per page | from €130 per page | |
| Extra pages | $140 each | €150 each | |
| Care plan | $49 per month | €49 per month | updates, uptime monitoring, backups, small changes |
| Rush delivery | +25% | +25% | |

All prices are stated as excluding tax. Rebuilds are priced as whichever tier they land in, with content and URL migration included; no logo or brand design; the client owns the code, repository and domain.

The other two articles carry no prices. All three close with a single link to `https://www.veyago.cloud/websites/#quote`.
