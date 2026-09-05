/* Tests for tools/lib/external-requests.js - the third-party request scan. */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  scan, scanCss, scanScript, scanSource, hostsFromCsp, srcsetUrls, hostOf, formatViolation
} = require('./external-requests');

const ROOT = path.join(__dirname, '..', '..');
const SUPABASE = 'vtbvhhilucxroqoaohjb.supabase.co';
const ALLOWED = { allowedHosts: [SUPABASE] };

/* Line 1 doctype, 2 <html><head>, 3 = head content, then </head>, <body>, 6 = body content. */
const page = (head, body) => '<!DOCTYPE html>\n<html><head>\n' + (head || '') + '\n</head>\n<body>\n' + (body || '') + '\n</body></html>';
const hosts = (list) => list.map((v) => v.host).sort();

test('a CDN script is a violation, with its line and host', () => {
  const found = scan(page('<script src="https://cdn.jsdelivr.net/npm/lib@1/dist/lib.min.js"></script>'));
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    where: '<script src>', url: 'https://cdn.jsdelivr.net/npm/lib@1/dist/lib.min.js', host: 'cdn.jsdelivr.net', line: 3
  });
});

test('a Google Fonts stylesheet and its preconnect are violations', () => {
  const found = scan(page(
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">'
  ));
  assert.deepEqual(hosts(found), ['fonts.googleapis.com', 'fonts.gstatic.com']);
  assert.deepEqual(found.map((v) => v.where).sort(), ['<link rel="preconnect" href>', '<link rel="stylesheet" href>']);
});

test('an external image, srcset candidate, poster and iframe are violations', () => {
  const found = scan(page('', [
    '<img src="https://images.example.com/hero.jpg" alt="">',
    '<img src="/assets/a.webp" srcset="/assets/a-1x.webp 1x, https://cdn.example.com/a-2x.webp 2x" alt="">',
    '<video poster="https://media.example.com/poster.jpg" src="/assets/clip.mp4"></video>',
    '<iframe src="https://www.youtube.com/embed/abc"></iframe>'
  ].join('\n')));
  assert.deepEqual(hosts(found), ['cdn.example.com', 'images.example.com', 'media.example.com', 'www.youtube.com']);
  assert.equal(found.find((v) => v.host === 'cdn.example.com').where, '<img srcset>');
  assert.equal(found.find((v) => v.host === 'cdn.example.com').line, 7);
});

test('links, anchors, mailto, tel, canonical/alternate and same-origin assets are never violations', () => {
  const found = scan(page([
    '<link rel="canonical" href="https://www.veyago.cloud/websites/">',
    '<link rel="alternate" hreflang="nl" href="https://www.veyago.cloud/nl/websites/">',
    '<link rel="alternate" type="application/rss+xml" href="https://feeds.example.com/veyago.xml">',
    '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">',
    '<link rel="stylesheet" href="/styles.css">',
    '<script src="/app.js" defer></script>',
    '<script type="application/ld+json">{"@context":"https://schema.org","url":"https://www.veyago.cloud/"}</script>'
  ].join('\n'), [
    '<a href="https://instagram.com/veyago_cloud" target="_blank" rel="noopener">Instagram</a>',
    '<a href="https://wefunder.com/veyago">Invest</a>',
    '<a href="mailto:hello@veyago.cloud">Email</a>',
    '<a href="tel:+15028535090">Call</a>',
    '<a href="#main">Skip</a>',
    '<form action="mailto:hello@veyago.cloud?subject=Hi" method="post"></form>',
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">',
    '<img src="/assets/kept-items-330w.webp" srcset="/assets/kept-items-330w.webp 1x, /assets/kept-items-660w.webp 2x" alt="">'
  ].join('\n')));
  assert.deepEqual(found, []);
});

test('the site\'s own hosts and CSP-allowed hosts pass; everything else does not', () => {
  const html = page(
    '<script src="https://www.veyago.cloud/app.js"></script>\n<script src="//veyago.cloud/app.js"></script>',
    '<img src="https://' + SUPABASE + '/storage/v1/object/public/x.png" alt="">'
  );
  assert.deepEqual(scan(html, ALLOWED), []);
  assert.deepEqual(hosts(scan(html)), [SUPABASE]);
});

test('a protocol-relative URL is a request to that host', () => {
  const found = scan(page('<script src="//cdnjs.cloudflare.com/ajax/libs/x/1.0/x.js"></script>'));
  assert.deepEqual(hosts(found), ['cdnjs.cloudflare.com']);
});

test('<base href> decides what a relative URL points at', () => {
  const found = scan(page('<base href="https://cdn.example.com/site/">\n<script src="app.js"></script>'));
  assert.deepEqual(hosts(found), ['cdn.example.com']);
});

test('external forms are violations - they send the visitor\'s data', () => {
  const found = scan(page('', '<form action="https://forms.example.com/submit" method="post"></form>'));
  assert.deepEqual(hosts(found), ['forms.example.com']);
});

test('inline scripts: fetch, XMLHttpRequest.open and WebSocket with a literal URL', () => {
  const found = scan(page('', [
    '<script>',
    '  fetch("https://tracker.example.com/pixel");',
    '  var x = new XMLHttpRequest(); x.open(\'GET\', \'https://api.example.com/v1\');',
    '  var ws = new WebSocket(`wss://ws.example.com/live`);',
    '  fetch(`https://${host}/dynamic`);            // unresolvable, skipped',
    '  fetch("/local/endpoint");                     // same origin',
    '  fetch("https://' + SUPABASE + '/functions/v1/website-enquiry");',
    '</script>',
    '<script type="text/template">fetch("https://never-run.example.com/")</script>'
  ].join('\n')), ALLOWED);
  assert.deepEqual(hosts(found), ['api.example.com', 'tracker.example.com', 'ws.example.com']);
  assert.deepEqual(found.map((v) => v.where).sort(), [
    'inline <script> XMLHttpRequest.open()', 'inline <script> fetch()', 'inline <script> new WebSocket()'
  ]);
  assert.equal(found.find((v) => v.host === 'tracker.example.com').line, 7);
});

test('an import map pointing at a CDN is a violation', () => {
  const found = scan(page('<script type="importmap">{"imports":{"vue":"https://unpkg.com/vue@3/dist/vue.esm-browser.js","local":"/assets/js/x.js"}}</script>'));
  assert.deepEqual(hosts(found), ['unpkg.com']);
  assert.equal(found[0].where, '<script type="importmap">');
});

test('inline style url() and a <style> @import are violations', () => {
  const found = scan(page(
    '<style>@import url("https://fonts.googleapis.com/css2?family=Inter"); body { background: url(/assets/bg.png) }</style>',
    '<div style="background-image: url(https://images.example.com/bg.jpg)"></div>'
  ));
  assert.deepEqual(hosts(found), ['fonts.googleapis.com', 'images.example.com']);
  assert.deepEqual(found.map((v) => v.where).sort(), ['<style> @import', 'style="" url()']);
});

test('scanCss: url() and @import forms, comments ignored, data: and relative skipped', () => {
  const css = [
    '/* url(https://commented-out.example.com/x.png) */',
    '@import "https://fonts.googleapis.com/css2?family=Inter";',
    '@import url(https://cdn.example.com/reset.css);',
    '.a { background: url("https://images.example.com/a.png") }',
    '.b { background: url(/assets/b.png), url(data:image/svg+xml,%3Csvg/%3E) }',
    '.c { mask: url(\'../assets/c.svg\') }'
  ].join('\n');
  const found = scanCss(css);
  assert.deepEqual(found.map((v) => [v.line, v.host, v.where]), [
    [2, 'fonts.googleapis.com', 'css @import'], [3, 'cdn.example.com', 'css @import'], [4, 'images.example.com', 'css url()']
  ]);
});

test('the real enquiry.js and newsletter.js make no third-party request', () => {
  ['assets/js/enquiry.js', 'assets/js/newsletter.js', 'app.js'].forEach((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.deepEqual(scanScript(text, ALLOWED), [], file);
  });
});

test('scanScript: a literal fetch to the Supabase function is allowed, anywhere else is not', () => {
  const ok = 'fetch("https://' + SUPABASE + '/functions/v1/website-enquiry", { method: "POST" })';
  const bad = 'fetch("https://hooks.slack.com/services/x", { method: "POST" })';
  assert.deepEqual(scanScript(ok, ALLOWED), []);
  assert.deepEqual(hosts(scanScript(ok)), [SUPABASE]);
  assert.deepEqual(hosts(scanScript(bad, ALLOWED)), ['hooks.slack.com']);
});

test('scanScript: dynamic import, static import, EventSource, Worker and sendBeacon', () => {
  const js = [
    'import x from "https://esm.sh/x";',
    'const y = await import("https://cdn.skypack.dev/y");',
    'new EventSource("https://events.example.com/stream");',
    'new Worker("https://workers.example.com/w.js");',
    'navigator.sendBeacon("https://analytics.example.com/beat", data);',
    'import local from "./local.js";'
  ].join('\n');
  assert.deepEqual(hosts(scanScript(js)), [
    'analytics.example.com', 'cdn.skypack.dev', 'esm.sh', 'events.example.com', 'workers.example.com'
  ]);
});

test('scanSource dispatches on the file extension', () => {
  assert.equal(scanSource('x.html', page('<script src="https://cdn.example.com/x.js"></script>')).length, 1);
  assert.equal(scanSource('x.css', '.a{background:url(https://cdn.example.com/x.png)}').length, 1);
  assert.equal(scanSource('x.js', 'fetch("https://cdn.example.com/x")').length, 1);
  assert.equal(scanSource('x.md', 'fetch("https://cdn.example.com/x")').length, 0);
});

test('hostsFromCsp: exact hosts from fetch directives only, deduplicated', () => {
  const publicCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; " +
    "font-src 'self'; connect-src 'self' https://" + SUPABASE + "; frame-src 'none'; object-src 'none'; " +
    "base-uri 'self'; form-action 'self' mailto:; frame-ancestors 'none'; upgrade-insecure-requests";
  assert.deepEqual(hostsFromCsp(publicCsp), [SUPABASE]);

  const adminCsp = "img-src 'self' data: https://" + SUPABASE + "; connect-src 'self' https://" + SUPABASE +
    ' wss://' + SUPABASE + '; object-src blob:';
  assert.deepEqual(hostsFromCsp(adminCsp), [SUPABASE]);

  assert.deepEqual(hostsFromCsp("form-action https://forms.example.com; report-uri https://r.example.com/x"), []);
  assert.deepEqual(hostsFromCsp("img-src https: *.example.com 'sha256-abc' cdn.example.com:443/path"), ['cdn.example.com']);
  assert.deepEqual(hostsFromCsp(''), []);
});

test('the checked-in public CSP allows exactly the Supabase project host', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const block = vercel.headers.find((h) => h.source === '/((?!admin).*)');
  const csp = block.headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.deepEqual(hostsFromCsp(csp), [SUPABASE]);
});

test('hostOf and srcsetUrls', () => {
  assert.equal(hostOf('https://CDN.Example.com/x'), 'cdn.example.com');
  assert.equal(hostOf('/assets/x.png'), 'www.veyago.cloud');
  assert.equal(hostOf('//veyago.cloud/x'), 'veyago.cloud');
  assert.equal(hostOf('mailto:hello@veyago.cloud'), null);
  assert.equal(hostOf('data:text/plain,hi'), null);
  assert.equal(hostOf('#main'), null);
  assert.equal(hostOf('ftp://files.example.com/x'), null);
  assert.equal(hostOf('https://<placeholder>/x'), null);
  assert.deepEqual(srcsetUrls('/a.webp 1x,  https://c.example.com/a.webp 2x, /b.webp 800w'), ['/a.webp', 'https://c.example.com/a.webp', '/b.webp']);
});

test('formatViolation is one readable line per finding', () => {
  const line = formatViolation('websites/index.html', { where: '<script src>', url: 'https://cdn.example.com/x.js', host: 'cdn.example.com', line: 12 });
  assert.equal(line, 'websites/index.html:12  <script src>  https://cdn.example.com/x.js  (host: cdn.example.com)');
});
