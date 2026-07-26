/* Post-build verification for the static export.
 *
 * tools/build.js WIPES /journal (fs.rmSync) and regenerates it, rewrites the
 * build-managed block of sitemap.xml, and re-renders /wallpapers/ and /apps/<slug>/.
 * When a human runs that on a laptop, a broken build is obvious and never ships.
 * Once a build can be triggered from a browser by someone who will not read the
 * console, the ONLY thing standing between a half-written build and production is
 * this module. It is therefore deliberately paranoid: every expected page must
 * exist, be a plausible size, carry a real <title> and canonical, and contain no
 * placeholder leakage; the sitemap must match the generated set exactly.
 *
 * Everything except verifyBuild() is a pure function over strings/objects so the
 * failure modes can be unit-tested without touching a filesystem.
 */
'use strict';

var fs = require('fs');
var path = require('path');

/* A rendered page from tools/lib/chrome.js `page()` is never smaller than a few
   kB (head meta + header + drawer + footer alone clear 4kB). Anything under this
   floor is a truncated write or an empty template, not a real page. */
var MIN_PAGE_BYTES = 500;

/* Must match SITE in tools/lib/chrome.js — verify-build.test.js guards the drift. */
var SITE = 'https://www.veyago.cloud';

/* Must match GEN_MARKER in tools/lib/app-pages.js — guarded in verify-build.test.js. */
var GENERATED_APP_MARKER = '<!-- veyago:generated-app-page -->';

var SITEMAP_START = '<!-- BUILD:generated:start -->';
var SITEMAP_END = '<!-- BUILD:generated:end -->';

/* Placeholder leakage.

   `[object Object]` and `${` are NEVER legitimate output, so they are matched
   anywhere in the page and always fail the build.

   `undefined` / `null` / `NaN` are different: they are ordinary English in a
   journal about software ("On the null pointer"), so matching them in prose
   would hard-block a legitimate article with no way for a non-technical author
   to get past it. They are therefore matched only where the BUILDER writes —
   inside attribute values and <title> — never in body copy. */
var LEAK_PATTERNS = [
  { token: '[object Object]', re: /\[object Object\]/g },
  { token: '${', re: /\$\{/g }
];

/* The machine-written slots. `undefined`/`null`/`NaN` are ordinary English in a
   software journal — "On the null pointer" is a legitimate title, and its slug
   legitimately contains "null" — so the bare word is never enough to fail a
   build. These match only where the token is the WHOLE value the builder
   produced: an entire URL path segment, an entire attribute value, or an entire
   <title>. That is always a bug and never prose. */
var PLACEHOLDER = '(?:undefined|null|NaN)';
var GENERATED_SLOT_PATTERNS = [
  // href="/journal/undefined/" — a whole path segment
  { token: 'undefined path segment', re: new RegExp('(?:href|src)="[^"]*/' + PLACEHOLDER + '(?:/|"|#|\\?)', 'g') },
  // href="undefined" / src="null" — the whole attribute value
  { token: 'undefined attribute',    re: new RegExp('(?:href|src|content)="' + PLACEHOLDER + '"', 'g') },
  // <title>undefined</title> — the whole title
  { token: 'undefined title',        re: new RegExp('<title>\\s*' + PLACEHOLDER + '\\s*(?:\\||</title>)', 'g') }
];

/* At most this many occurrences of one token are reported, so a systematically
   broken template produces a readable report instead of thousands of lines. */
var MAX_LEAKS_REPORTED = 3;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/* Decode the entities tools/lib/escape.js emits, so an expected title containing
   & or ' can be compared against the escaped title in the document. `&amp;` is
   decoded last so "&amp;lt;" round-trips to "&lt;" rather than "<". */
function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

/* Blank out <pre>/<code> regions, preserving length and newlines so indexes into
   the masked string still address the same characters in the original. */
function maskCodeRegions(html) {
  return String(html).replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, function (match) {
    return match.replace(/[^\n]/g, ' ');
  });
}

function contextAround(text, index, length) {
  var start = Math.max(0, index - 32);
  var end = Math.min(text.length, index + length + 32);
  return JSON.stringify(text.slice(start, end).replace(/\s+/g, ' ').trim());
}

/* -> [{ token, index, context }] for every placeholder that leaked into markup. */
function findLeakedTokens(html) {
  var source = String(html);
  var masked = maskCodeRegions(source);
  var found = [];
  LEAK_PATTERNS.concat(GENERATED_SLOT_PATTERNS).forEach(function (pattern) {
    var re = new RegExp(pattern.re.source, pattern.re.flags.indexOf('i') > -1 ? 'gi' : 'g');
    var hits = 0;
    var match;
    while ((match = re.exec(masked)) !== null) {
      if (match[0].length === 0) { re.lastIndex++; continue; }
      hits++;
      if (hits > MAX_LEAKS_REPORTED) break;
      found.push({
        token: pattern.token,
        index: match.index,
        context: contextAround(source, match.index, match[0].length)
      });
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// checkHtmlDocument — is this string a complete, non-leaking page?
// ---------------------------------------------------------------------------

/* checkHtmlDocument(html, { expectTitle, minBytes, label }) -> [problem strings]
   An empty array means the document passed. */
function checkHtmlDocument(html, options) {
  var opts = options || {};
  var label = opts.label ? opts.label + ': ' : '';
  var minBytes = opts.minBytes == null ? MIN_PAGE_BYTES : opts.minBytes;
  var problems = [];

  if (typeof html !== 'string' || html.length === 0) {
    return [label + 'document is empty — nothing was rendered'];
  }

  var bytes = Buffer.byteLength(html, 'utf8');
  if (bytes < minBytes) {
    problems.push(label + 'suspiciously small — ' + bytes + ' bytes, expected at least ' + minBytes);
  }
  if (!/^\s*<!DOCTYPE html>/i.test(html)) {
    problems.push(label + 'missing <!DOCTYPE html> — this does not look like a full page');
  }
  if (html.indexOf('</html>') === -1) {
    problems.push(label + 'missing closing </html> — the file looks truncated');
  }

  problems = problems.concat(checkTitle(html, label, opts.expectTitle));
  problems = problems.concat(checkCanonical(html, label));

  findLeakedTokens(html).forEach(function (leak) {
    problems.push(label + 'leaked placeholder "' + leak.token + '" into the page near ' + leak.context);
  });

  return problems;
}

function checkTitle(html, label, expectTitle) {
  var match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return [label + 'missing <title>'];
  var title = decodeEntities(match[1]).trim();
  if (!title) return [label + '<title> is empty'];
  var want = expectTitle == null ? '' : String(expectTitle).trim();
  if (want && title.indexOf(want) === -1) {
    return [label + '<title> is "' + title + '" — expected it to contain "' + want + '"'];
  }
  return [];
}

function checkCanonical(html, label) {
  var tag = html.match(/<link\b[^>]*\brel=["']?canonical["']?[^>]*>/i);
  if (!tag) return [label + 'missing <link rel="canonical">'];
  var href = tag[0].match(/\bhref=["']([^"']*)["']/i);
  var value = href ? href[1].trim() : '';
  if (!value) return [label + '<link rel="canonical"> has no href'];
  if (!/^https?:\/\//i.test(value)) {
    return [label + 'canonical href "' + value + '" is not an absolute URL'];
  }
  return [];
}

// ---------------------------------------------------------------------------
// checkSitemapCoverage — does the managed block match the generated pages?
// ---------------------------------------------------------------------------

/* The build only owns the block between the BUILD:generated markers; hand-written
   entries outside it must be ignored. Returns { found, xml } where xml is the
   region to inspect (whole document when the markers are absent). */
function managedBlock(sitemapXml) {
  var start = sitemapXml.indexOf(SITEMAP_START);
  var end = sitemapXml.indexOf(SITEMAP_END);
  if (start !== -1 && end !== -1 && end > start) {
    return { found: true, xml: sitemapXml.slice(start + SITEMAP_START.length, end) };
  }
  return { found: false, xml: sitemapXml };
}

function extractLocs(xml, problems) {
  var locs = [];
  var re = /<loc>([\s\S]*?)<\/loc>/gi;
  var match;
  while ((match = re.exec(xml)) !== null) {
    var loc = decodeEntities(match[1]).trim();
    if (!loc) problems.push('sitemap.xml: found a <loc> entry with no URL');
    else locs.push(loc);
  }
  return locs;
}

/* checkSitemapCoverage(sitemapXml, expectedUrls) -> [problem strings] */
function checkSitemapCoverage(sitemapXml, expectedUrls) {
  if (typeof sitemapXml !== 'string' || !sitemapXml.trim()) {
    return ['sitemap.xml is empty or unreadable'];
  }
  var problems = [];
  var expected = (expectedUrls || []).map(function (u) { return String(u).trim(); }).filter(Boolean);
  var block = managedBlock(sitemapXml);
  if (!block.found) {
    problems.push('sitemap.xml: the ' + SITEMAP_START + ' / ' + SITEMAP_END +
      ' markers are missing — the build could not update its managed block');
  }

  var locs = extractLocs(block.xml, problems);
  var counts = Object.create(null);
  locs.forEach(function (loc) { counts[loc] = (counts[loc] || 0) + 1; });

  Object.keys(counts).forEach(function (loc) {
    if (counts[loc] > 1) problems.push('sitemap.xml: "' + loc + '" is listed ' + counts[loc] + ' times');
  });

  expected.forEach(function (url) {
    if (counts[url] == null) problems.push('sitemap.xml: missing entry for "' + url + '"');
  });

  /* Without the markers we cannot tell build-managed entries from hand-written
     ones, so extras are only meaningful when the block was found. */
  if (block.found) {
    var wanted = Object.create(null);
    expected.forEach(function (url) { wanted[url] = true; });
    Object.keys(counts).forEach(function (loc) {
      if (!wanted[loc]) problems.push('sitemap.xml: stale entry "' + loc + '" — no such page was generated');
    });
  }

  return problems;
}

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

/* summarize(problems) -> { ok, count, report } */
function summarize(problems) {
  var list = (problems || []).filter(Boolean);
  var report = list.length === 0
    ? 'Build verified — 0 problems found.'
    : list.length + ' problem(s) found:\n' + list.map(function (p, i) {
      return '  ' + (i + 1) + '. ' + p;
    }).join('\n');
  return { ok: list.length === 0, count: list.length, report: report };
}

// ---------------------------------------------------------------------------
// verifyBuild — the one filesystem-walking entry point
// ---------------------------------------------------------------------------

function readTextFile(file) {
  try { return { ok: true, text: fs.readFileSync(file, 'utf8') }; }
  catch (err) { return { ok: false, error: err }; }
}

/* Read + check one generated page. Returns its text, or null when unusable. */
function checkPageFile(root, rel, opts, problems) {
  var file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    problems.push(rel + ' is MISSING — the build did not write it');
    return null;
  }
  var read = readTextFile(file);
  if (!read.ok) {
    problems.push(rel + ' could not be read: ' + read.error.message);
    return null;
  }
  checkHtmlDocument(read.text, {
    label: rel,
    expectTitle: opts.expectTitle,
    minBytes: opts.minBytes
  }).forEach(function (p) { problems.push(p); });
  return read.text;
}

/* Slugs under /apps/ whose index.html carries this build's generated marker. */
function generatedAppSlugs(root) {
  var dir = path.join(root, 'apps');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(function (entry) { return entry.isDirectory(); })
    .map(function (entry) { return entry.name; })
    .filter(function (name) {
      var read = readTextFile(path.join(dir, name, 'index.html'));
      return read.ok && read.text.indexOf(GENERATED_APP_MARKER) !== -1;
    });
}

function expectedSitemapUrls(site, articles, appPages) {
  var urls = [site + '/journal/'];
  articles.forEach(function (a) { if (a && a.slug) urls.push(site + '/journal/' + a.slug + '/'); });
  urls.push(site + '/wallpapers/');
  appPages.forEach(function (a) { if (a && a.slug) urls.push(site + '/apps/' + a.slug + '/'); });
  return urls;
}

/* An index page must actually list what the build claims it published — a page
   that renders but drops every card is a silent content loss. */
function checkIndexLists(indexHtml, rel, items, problems) {
  if (indexHtml == null) return;
  var text = decodeEntities(indexHtml);
  items.forEach(function (item) {
    var title = item && item.title;
    if (!title) return;
    if (text.indexOf(String(title)) === -1) {
      problems.push(rel + ' does not list "' + title + '" — it was published but is not on the index');
    }
  });
}

function checkSiteConfig(root, problems) {
  var rel = 'assets/js/site-config.js';
  var file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    problems.push(rel + ' is MISSING — the public site has no announcement config');
    return;
  }
  var read = readTextFile(file);
  if (!read.ok) { problems.push(rel + ' could not be read: ' + read.error.message); return; }
  if (read.text.indexOf('window.VEYAGO_SITE_CONFIG') === -1) {
    problems.push(rel + ' does not assign window.VEYAGO_SITE_CONFIG');
  }
  /* build.js writes JSON.stringify output ("announcement": {...}); the checked-in
     file has been hand-edited to unquoted keys before. Accept both. */
  if (!/["']?announcement["']?\s*:/.test(read.text)) {
    problems.push(rel + ' has no announcement block');
  }
  if (read.text.indexOf('${') !== -1) {
    problems.push(rel + ' contains an unresolved template artifact "${"');
  }
}

/* verifyBuild({ root, expected }) -> { ok, count, report, problems }
   expected = { articles:[{slug,title}], wallpapers:[{title}], appPages:[{slug,name}],
                site?, minBytes?, siteConfig? } */
function verifyBuild(options) {
  var opts = options || {};
  var root = opts.root;
  var expected = opts.expected || {};
  var problems = [];

  if (!root || !fs.existsSync(root)) {
    problems.push('verifyBuild: build root "' + String(root) + '" does not exist');
    return Object.assign(summarize(problems), { problems: problems });
  }

  var site = expected.site || SITE;
  var minBytes = expected.minBytes == null ? MIN_PAGE_BYTES : expected.minBytes;
  var articles = Array.isArray(expected.articles) ? expected.articles : [];
  var wallpapers = Array.isArray(expected.wallpapers) ? expected.wallpapers : [];
  var appPages = Array.isArray(expected.appPages) ? expected.appPages : [];

  /* /journal is deleted before it is rebuilt — its index must come back even
     when nothing is published, or the site 404s a linked section. */
  var journalIndex = checkPageFile(root, 'journal/index.html', { minBytes: minBytes }, problems);
  articles.forEach(function (article) {
    if (!article || !article.slug) {
      problems.push('verifyBuild: an expected article has no slug — cannot verify its page');
      return;
    }
    checkPageFile(root, 'journal/' + article.slug + '/index.html', {
      expectTitle: article.title,
      minBytes: minBytes
    }, problems);
  });
  checkIndexLists(journalIndex, 'journal/index.html', articles, problems);

  /* Wallpapers render onto a single index — there are no per-wallpaper pages. */
  var wallpaperIndex = checkPageFile(root, 'wallpapers/index.html', { minBytes: minBytes }, problems);
  checkIndexLists(wallpaperIndex, 'wallpapers/index.html', wallpapers, problems);

  appPages.forEach(function (app) {
    if (!app || !app.slug) {
      problems.push('verifyBuild: an expected app page has no slug — cannot verify its page');
      return;
    }
    checkPageFile(root, 'apps/' + app.slug + '/index.html', {
      expectTitle: app.name || app.title,
      minBytes: minBytes
    }, problems);
  });

  var wantedApps = Object.create(null);
  appPages.forEach(function (app) { if (app && app.slug) wantedApps[app.slug] = true; });
  generatedAppSlugs(root).forEach(function (slug) {
    if (!wantedApps[slug]) {
      problems.push('apps/' + slug + '/index.html is a stale generated page — it was not part of this build');
    }
  });

  var sitemapFile = path.join(root, 'sitemap.xml');
  if (!fs.existsSync(sitemapFile)) {
    problems.push('sitemap.xml is MISSING');
  } else {
    var sitemap = readTextFile(sitemapFile);
    if (!sitemap.ok) problems.push('sitemap.xml could not be read: ' + sitemap.error.message);
    else {
      checkSitemapCoverage(sitemap.text, expectedSitemapUrls(site, articles, appPages))
        .forEach(function (p) { problems.push(p); });
    }
  }

  if (expected.siteConfig !== false) checkSiteConfig(root, problems);

  return Object.assign(summarize(problems), { problems: problems });
}


/* ── Catastrophic-shrink guard ───────────────────────────────────────────
   THE most important check here, and the one the rest of this module cannot
   perform on its own: every other check validates the build against the build
   log, i.e. against itself. If Supabase returns FEWER rows without an error —
   a rotated anon key, an RLS change, replica lag, an accidental bulk unpublish —
   then build.js happily renders an empty/short site, every page it did write is
   internally valid, and self-referential verification reports success while the
   commit deletes the real pages.

   So this compares what the build produced against what is ALREADY COMMITTED
   (counted from the git tree before the build ran). Losing pages is legitimate
   only when someone genuinely unpublished something, which is rare and small;
   losing all of them, or most of them, is always a bug.

   before/after are counts of generated pages by kind. Returns problem strings. */
function checkNoCatastrophicShrink(before, after, opts) {
  opts = opts || {};
  var maxDropRatio = typeof opts.maxDropRatio === 'number' ? opts.maxDropRatio : 0.34;
  var problems = [];

  Object.keys(before || {}).forEach(function (kind) {
    var had = Number(before[kind]) || 0;
    var got = Number(after && after[kind]) || 0;
    if (had === 0) return;                       // nothing to lose

    if (got === 0) {
      problems.push(
        kind + ': the build produced ZERO pages but ' + had + ' are currently published. ' +
        'This is what a failed/short read from Supabase looks like — refusing to wipe the site.');
      return;
    }
    var dropped = had - got;
    if (dropped > 0 && (dropped / had) > maxDropRatio) {
      problems.push(
        kind + ': the build produced ' + got + ' pages but ' + had + ' are currently published (' +
        dropped + ' would be deleted, ' + Math.round((dropped / had) * 100) + '%). ' +
        'That is more than a normal unpublish — refusing to publish. ' +
        'If it is intentional, re-run with ALLOW_LARGE_DELETION=1.');
    }
  });

  return problems;
}

module.exports = {
  checkNoCatastrophicShrink,
  checkHtmlDocument: checkHtmlDocument,
  checkSitemapCoverage: checkSitemapCoverage,
  summarize: summarize,
  verifyBuild: verifyBuild,
  findLeakedTokens: findLeakedTokens,
  maskCodeRegions: maskCodeRegions,
  decodeEntities: decodeEntities,
  expectedSitemapUrls: expectedSitemapUrls,
  MIN_PAGE_BYTES: MIN_PAGE_BYTES,
  SITE: SITE,
  GENERATED_APP_MARKER: GENERATED_APP_MARKER
};
