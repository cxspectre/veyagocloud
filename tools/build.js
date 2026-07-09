/* Static export for the journal + wallpapers.
 *
 *   npm run build                     # read published rows from Supabase (needs .env)
 *   node tools/build.js --fixture <f> # render from a local JSON fixture (no Supabase)
 *
 * Reads PUBLISHED articles + wallpapers, renders them to static HTML in the repo
 * (/journal/, /journal/<slug>/, /wallpapers/), pulls wallpaper binaries into
 * /assets/wallpapers/ so the public site serves them first-party, and refreshes the
 * build-managed block of sitemap.xml. The public site never calls Supabase — this
 * build is the only thing that does, with the public anon key (RLS-gated, read-only).
 */
'use strict';

var fs = require('fs');
var path = require('path');

var { SITE } = require('./lib/chrome');
var { renderArticlePage, renderJournalIndex } = require('./lib/journal-pages');
var { renderWallpapersIndex } = require('./lib/wallpaper-pages');
var { renderAppPage, GEN_MARKER } = require('./lib/app-pages');
var { readingMinutes } = require('./lib/reading-time');
var { isoDate } = require('./lib/format');
var { slugify } = require('./lib/slugify');
var { applySitemap } = require('./lib/sitemap');

var ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Tiny .env loader (no dependency) — KEY=VALUE lines; never overrides real env.
// ---------------------------------------------------------------------------
function loadEnv() {
  var file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
    var m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) return;
    var key = m[1];
    var val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[key] == null) process.env[key] = val;
  });
}

function parseArgs(argv) {
  var out = { fixture: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture') out.fixture = argv[++i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data acquisition
// ---------------------------------------------------------------------------
function fromFixture(file) {
  var raw = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  if (Array.isArray(raw)) return { articles: raw, wallpapers: [], apps: [] };
  if (raw && raw.body && raw.slug) return { articles: [raw], wallpapers: [], apps: [] };
  return { articles: raw.articles || [], wallpapers: raw.wallpapers || [], apps: raw.apps || [] };
}

async function fromSupabase() {
  var url = process.env.SUPABASE_URL;
  var key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'No Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env ' +
      '(see supabase/README.md), or run with --fixture <file>.'
    );
  }
  var { createClient } = require('@supabase/supabase-js');
  var sb = createClient(url, key, { auth: { persistSession: false } });

  var [articlesRes, wallpapersRes, annRes, appsRes] = await Promise.all([
    sb.from('articles').select('*').eq('status', 'published').order('published_at', { ascending: false }),
    sb.from('wallpapers').select('*').eq('status', 'published').order('published_at', { ascending: false }),
    sb.from('site_announcements').select('*').eq('active', true).limit(1),
    sb.from('apps').select('*').eq('published', true).order('sort_order', { ascending: true }).order('created_at', { ascending: true })
  ]);

  if (articlesRes.error) throw new Error('Reading articles: ' + articlesRes.error.message);
  if (wallpapersRes.error) throw new Error('Reading wallpapers: ' + wallpapersRes.error.message);
  // announcement + apps errors are non-fatal (tables/columns might not exist yet)
  if (appsRes && appsRes.error) console.warn('  ! could not read apps (' + appsRes.error.message + ') — skipping app pages');

  var announcement = (annRes && annRes.data && annRes.data[0]) || null;
  return {
    articles: articlesRes.data || [],
    wallpapers: wallpapersRes.data || [],
    announcement: announcement,
    apps: (appsRes && appsRes.data) || []
  };
}

// ---------------------------------------------------------------------------
// Wallpaper binaries → pulled into the repo so the public page is first-party.
// http(s) URLs are downloaded and rewritten to a local /assets path; already-local
// paths (e.g. in fixtures) are left as-is.
// ---------------------------------------------------------------------------
function localName(url, fallback) {
  try {
    var base = path.basename(new URL(url).pathname);
    if (base) return base;
  } catch (e) { /* not an absolute URL */ }
  return fallback;
}

async function pullAsset(url, destDir, webDir, fallback) {
  if (!url || !/^https?:\/\//i.test(url)) return url; // local already — keep it
  var name = localName(url, fallback);
  var res = await fetch(url);
  if (!res.ok) {
    console.warn('  ! could not fetch ' + url + ' (' + res.status + ') — keeping remote URL');
    return url;
  }
  var buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, name), buf);
  return webDir + '/' + name;
}

// Pull an article's cover + inline images into the repo, so the public journal
// page is first-party (no Supabase Storage URLs leaking onto public pages).
async function localiseArticle(a) {
  var slug = a.slug || slugify(a.title) || 'article';
  var destDir = path.join(ROOT, 'assets', 'journal', slug);
  var webDir = '/assets/journal/' + slug;
  var out = Object.assign({}, a);
  if (a.cover_image_url) out.cover_image_url = await pullAsset(a.cover_image_url, destDir, webDir, slug + '-cover.png');
  var body = [];
  for (var i = 0; i < (a.body || []).length; i++) {
    var b = a.body[i];
    if (b && b.type === 'image' && b.url) {
      body.push(Object.assign({}, b, { url: await pullAsset(b.url, destDir, webDir, 'img-' + i + '.png') }));
    } else {
      body.push(b);
    }
  }
  out.body = body;
  return out;
}

async function localiseWallpaper(w) {
  var slug = w.slug || slugify(w.title) || 'wallpaper';
  var destDir = path.join(ROOT, 'assets', 'wallpapers', slug);
  var webDir = '/assets/wallpapers/' + slug;
  var out = Object.assign({}, w);
  out.preview_url = await pullAsset(w.preview_url, destDir, webDir, slug + '-preview.png');
  var variants = [];
  for (var i = 0; i < (w.variants || []).length; i++) {
    var v = w.variants[i];
    var fallback = slugify(v.label || ('variant-' + i)) + '.' + (v.format || 'png');
    var localUrl = await pullAsset(v.url, destDir, webDir, fallback);
    variants.push(Object.assign({}, v, { url: localUrl }));
  }
  out.variants = variants;
  return out;
}

// Pull an app's icon + every section image into the repo, so the public product
// page is first-party (no Supabase Storage URLs leaking onto public pages).
async function localiseApp(a) {
  var slug = a.slug || slugify(a.name) || 'app';
  var destDir = path.join(ROOT, 'assets', 'apps', slug);
  var webDir = '/assets/apps/' + slug;
  var out = Object.assign({}, a);
  if (a.icon_url) out.icon_url = await pullAsset(a.icon_url, destDir, webDir, slug + '-icon.png');
  var layout = [];
  var srcLayout = Array.isArray(a.layout) ? a.layout : [];
  for (var i = 0; i < srcLayout.length; i++) {
    var s = srcLayout[i];
    if (s && s.image) {
      layout.push(Object.assign({}, s, { image: await pullAsset(s.image, destDir, webDir, 'section-' + i + '.png') }));
    } else {
      layout.push(s);
    }
  }
  out.layout = layout;
  return out;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// site-config.js — announcement config for app.js (no runtime Supabase call).
// ---------------------------------------------------------------------------
function generateSiteConfig(announcement) {
  var config;
  if (announcement && announcement.message) {
    config = {
      active: true,
      key: announcement.key || 'announcement',
      message: announcement.message,
      linkText: announcement.link_text || null,
      linkHref: announcement.link_href || null
    };
  } else {
    config = { active: false };
  }
  var json = JSON.stringify({ announcement: config }, null, 2);
  var js = '/* Generated by `npm run build` — edit at /admin/announcements and rebuild. */\n' +
    'window.VEYAGO_SITE_CONFIG = ' + json + ';\n';
  fs.mkdirSync(path.join(ROOT, 'assets', 'js'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'assets', 'js', 'site-config.js'), js);
}

// Write helpers
// ---------------------------------------------------------------------------
function writePage(relDir, html) {
  var dir = path.join(ROOT, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
}

// Slugs that already have a hand-authored bespoke product page (top-level /kept/,
// /veyago/). We never generate /apps/<slug>/ for these — their catalogue card points
// at the bespoke page, and a generated twin would be duplicate content.
var BESPOKE_SLUGS = ['kept', 'veyago'];

// An app gets a generated /apps/<slug>/ page only when it's published, has a real
// layout to render, and isn't one of the bespoke-page apps.
function shouldBuildAppPage(a) {
  if (!a.published) return false;
  if (!a.slug) return false;
  if (BESPOKE_SLUGS.indexOf(a.slug) !== -1) return false;
  return Array.isArray(a.layout) && a.layout.length > 0;
}

// Remove only /apps/<slug>/ directories that THIS build generated (identified by
// the marker stamped into their index.html) so unpublished/renamed apps don't leave
// stale pages behind. The hand-authored /apps/index.html and any future bespoke
// /apps/<slug>/ page (no marker) are left untouched.
function cleanGeneratedApps() {
  var appsDir = path.join(ROOT, 'apps');
  if (!fs.existsSync(appsDir)) return;
  fs.readdirSync(appsDir, { withFileTypes: true }).forEach(function (ent) {
    if (!ent.isDirectory()) return;
    var idx = path.join(appsDir, ent.name, 'index.html');
    if (fs.existsSync(idx) && fs.readFileSync(idx, 'utf8').indexOf(GEN_MARKER) !== -1) {
      fs.rmSync(path.join(appsDir, ent.name), { recursive: true, force: true });
    }
  });
}

function sitemapEntries(articles, wallpapers, appPages) {
  var entries = [];
  var latestArticle = articles.map(function (a) { return isoDate(a.published_at); }).filter(Boolean).sort().pop();
  entries.push({ loc: SITE + '/journal/', lastmod: latestArticle || '', priority: '0.8' });
  articles.forEach(function (a) {
    entries.push({ loc: SITE + '/journal/' + a.slug + '/', lastmod: isoDate(a.published_at), priority: '0.6' });
  });
  var latestWp = wallpapers.map(function (w) { return isoDate(w.published_at); }).filter(Boolean).sort().pop();
  entries.push({ loc: SITE + '/wallpapers/', lastmod: latestWp || '', priority: '0.7' });
  (appPages || []).forEach(function (a) {
    entries.push({ loc: SITE + '/apps/' + a.slug + '/', lastmod: isoDate(a.updated_at || a.created_at), priority: '0.6' });
  });
  return entries;
}

function updateSitemap(articles, wallpapers, appPages) {
  var file = path.join(ROOT, 'sitemap.xml');
  if (!fs.existsSync(file)) { console.warn('  ! sitemap.xml not found — skipping'); return; }
  var xml = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, applySitemap(xml, sitemapEntries(articles, wallpapers, appPages)));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  loadEnv();
  var args = parseArgs(process.argv.slice(2));

  var data = args.fixture ? fromFixture(args.fixture) : await fromSupabase();
  var articles = data.articles || [];
  var wallpapers = data.wallpapers || [];
  var announcement = data.announcement || null;
  var apps = data.apps || [];

  console.log((args.fixture ? 'fixture' : 'supabase') + ': ' +
    articles.length + ' article(s), ' + wallpapers.length + ' wallpaper(s), ' +
    apps.length + ' app(s), ' +
    (announcement ? 'announcement active' : 'no active announcement'));

  // Generate site-config.js (announcement for app.js, no runtime Supabase call)
  if (!args.fixture) {
    generateSiteConfig(announcement);
    console.log('  wrote assets/js/site-config.js');
  }

  // /journal is fully build-managed — wipe it so unpublished/renamed articles
  // don't leave stale pages behind, then regenerate from the published set.
  fs.rmSync(path.join(ROOT, 'journal'), { recursive: true, force: true });

  // Articles — pull cover + inline images into the repo, then render.
  var localArticles = [];
  for (var ai = 0; ai < articles.length; ai++) {
    var la = await localiseArticle(articles[ai]);
    if (la.reading_minutes == null) la.reading_minutes = readingMinutes(la.body || []);
    writePage('journal/' + la.slug, renderArticlePage(la));
    console.log('  built /journal/' + la.slug + '/  (' + la.title + ')');
    localArticles.push(la);
  }
  writePage('journal', renderJournalIndex(localArticles));
  console.log('  built /journal/  (' + localArticles.length + ' card(s))');

  // Wallpapers — pull binaries into the repo, then render
  var localWallpapers = [];
  for (var i = 0; i < wallpapers.length; i++) {
    localWallpapers.push(await localiseWallpaper(wallpapers[i]));
  }
  writePage('wallpapers', renderWallpapersIndex(localWallpapers));
  console.log('  built /wallpapers/  (' + localWallpapers.length + ' wallpaper(s))');

  // App product pages — clear our previously-generated pages, then render each
  // qualifying app (published + has a layout + not a bespoke-page app). Image
  // binaries are pulled into the repo so the public page stays first-party.
  cleanGeneratedApps();
  var builtApps = [];
  for (var pi = 0; pi < apps.length; pi++) {
    var appRow = apps[pi];
    if (!shouldBuildAppPage(appRow)) {
      if (appRow.published && BESPOKE_SLUGS.indexOf(appRow.slug) !== -1) {
        console.log('  skipped /apps/' + appRow.slug + '/  (bespoke page — see /' + appRow.slug + '/)');
      }
      continue;
    }
    var localApp = await localiseApp(appRow);
    writePage('apps/' + localApp.slug, renderAppPage(localApp));
    console.log('  built /apps/' + localApp.slug + '/  (' + (localApp.name || localApp.slug) + ')');
    builtApps.push(localApp);
  }

  updateSitemap(articles, wallpapers, builtApps);
  console.log('  updated sitemap.xml');

  console.log('done.');
}

main().catch(function (err) {
  console.error('\nbuild failed: ' + err.message);
  process.exit(1);
});
