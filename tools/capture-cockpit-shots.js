#!/usr/bin/env node
/* capture-cockpit-shots.js - the Veyago Cockpit screenshots, with invented data.
 *
 * Cockpit is the studio's own workspace (the veyago-workspace repo), and every
 * one of its views reads the live database - real clients, real invoices. The
 * marketing page cannot show those. So this serves the workspace's dist/ as it
 * is, swaps only the data layer's bottom for tools/cockpit-demo/ - a fake
 * Supabase client over invented tables, and a session that is already signed
 * in as the fixture's owner - and lets the real queries.js, store.js and every
 * view render it. What the shot shows is the app, not a mock-up of it.
 *
 *   node tools/capture-cockpit-shots.js             all views
 *   node tools/capture-cockpit-shots.js crm         one view
 *   node tools/capture-cockpit-shots.js --serve     just serve it, to look around
 *
 * The workspace is read from ../veyago-workspace/dist unless
 * VEYAGO_WORKSPACE_DIST says otherwise. Nothing in it is changed, and nothing
 * reaches Supabase: supabase.js, config.js, session.js and gate.js are never
 * served. What changes on screen is made in the page after it loads: the
 * wordmark says "Cockpit" rather than "Workspace", and two controls the
 * workspace ships without styles (see READY) get their neighbours' look.
 *
 * The workspace has no dark theme (no prefers-color-scheme anywhere in its
 * CSS), so there is one set of shots, in light.
 *
 * Needs a Chromium-family browser and cwebp (`brew install webp`), like
 * capture-work-shots.js, whose approach this follows. Output lands in assets/.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var http = require('http');
var path = require('path');
var { spawn, spawnSync } = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.join(ROOT, 'assets');
var DEMO = path.join(__dirname, 'cockpit-demo');
var DIST = path.resolve(process.env.VEYAGO_WORKSPACE_DIST || path.join(ROOT, '..', 'veyago-workspace', 'dist'));

/* A 1440 x 900 laptop screen at 2x. */
var VIEW = { width: 1440, height: 900, scale: 2 };
/* The hero is shown wide; the rest sit in a grid. The 2x file is only ever
   seen at half its pixel size, so it takes the harder squeeze. */
var HERO = [{ w: 1200, q: 76 }, { w: 2400, q: 60 }];
var CARD = [{ w: 720, q: 76 }, { w: 1440, q: 60 }];

var TARGETS = [
  { slug: 'overview', route: 'overview', widths: HERO },
  { slug: 'crm', route: 'crm', widths: CARD },
  { slug: 'agenda', route: 'agenda', widths: CARD },
  { slug: 'finance', route: 'finance', widths: CARD },
  { slug: 'invoices', route: 'finance/invoices', widths: CARD },
  { slug: 'tickets', route: 'tickets', widths: CARD },
  { slug: 'projects', route: 'projects', widths: CARD }
];

/* The data layer's bottom, swapped for the demo's. Everything else in
   index.html - queries.js, store.js, actions.js, every view - is served as is. */
var SWAPS = [
  ['data/supabase.js', 'demo/fake-supabase.js'],
  ['data/config.js', 'demo/fixtures.js'],
  ['data/session.js', 'demo/demo-session.js']
];
var DROPPED = ['data/gate.js'];

var BROWSERS = [
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome'
];

var TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

/* Runs in the page once the store has loaded: the product's name in the
   header, and a report of anything that would spoil a shot. */
var READY = function () {
  var store = window.workspaceStore;
  if (!store || !store.state.loaded || store.state.loading) return { ready: false };
  /* Two controls the workspace ships unstyled, so they draw as the browser's
     own: the invoice list's sort buttons and the project board's filters.
     Given the look their neighbours already have, for the shot only. */
  if (!document.getElementById('cockpit-polish')) {
    var style = document.createElement('style');
    style.id = 'cockpit-polish';
    style.textContent = '.sort-header{border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer}'
      + 'select[data-view]{padding:6px 10px;border:1px solid #dce0e6;border-radius:10px;background:#fff;color:var(--ink);font-size:.8125rem}';
    document.head.appendChild(style);
  }
  var mark = document.querySelector('.wordmark > span');
  if (mark) mark.textContent = 'Cockpit';
  document.title = 'Veyago Cockpit';
  var main = document.querySelector('#main');
  var text = main ? main.innerText : '';
  var problems = [];
  if (/loading…|did not load|could not load|could not refresh|went wrong/i.test(text)) problems.push('a loading or failure message');
  if (document.querySelector('#gate:not([hidden])')) problems.push('the sign-in screen');
  if (document.querySelector('.app.locked')) problems.push('a locked shell');
  var toast = document.querySelector('#toast.show');
  if (toast) problems.push('a toast: ' + toast.textContent);
  window.scrollTo(0, 0);
  return { ready: true, problems: problems, failed: store.state.failed };
};

function fail(msg) { console.error('capture-cockpit-shots: ' + msg); process.exit(1); }

function findBrowser() {
  var hit = BROWSERS.filter(function (b) { return fs.existsSync(b); })[0];
  if (!hit) fail('no Chromium-family browser found. Install Brave, Chrome, Edge or Chromium.');
  return hit;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ── The demo server ─────────────────────────────────────────────────── */

function demoIndex() {
  var html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  SWAPS.forEach(function (swap) {
    var tag = new RegExp('src="' + swap[0].replace(/[.]/g, '\\.') + '(\\?[^"]*)?"');
    if (!tag.test(html)) fail('index.html no longer loads ' + swap[0] + ' - the demo needs updating.');
    html = html.replace(tag, 'src="' + swap[1] + '"');
  });
  DROPPED.forEach(function (file) {
    html = html.replace(new RegExp('<script src="' + file.replace(/[.]/g, '\\.') + '(\\?[^"]*)?"></script>'), '');
  });
  return html;
}

/* Files from dist/, the demo's from tools/cockpit-demo/, and nothing from
   outside either: a path that climbs out is a 404. */
function resolveFile(urlPath) {
  var clean = decodeURIComponent(urlPath.split('?')[0]);
  var inDemo = clean.indexOf('/demo/') === 0;
  var base = inDemo ? DEMO : DIST;
  var file = path.normalize(path.join(base, inDemo ? clean.slice('/demo/'.length) : clean));
  if (file.indexOf(base + path.sep) !== 0) return null;
  var blocked = SWAPS.map(function (s) { return path.join(DIST, s[0]); }).concat(DROPPED.map(function (f) { return path.join(DIST, f); }));
  if (blocked.indexOf(file) !== -1) return null;
  return file;
}

function startServer() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    fail('no workspace at ' + DIST + '. Set VEYAGO_WORKSPACE_DIST to its dist/ folder.');
  }
  var server = http.createServer(function (req, res) {
    var urlPath = req.url === '/' ? '/index.html' : req.url;
    if (urlPath.split('?')[0] === '/index.html') {
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      return res.end(demoIndex());
    }
    var file = resolveFile(urlPath);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}

/* ── The browser ─────────────────────────────────────────────────────── */

/* One CDP session per page, awaited by message id. */
function connect(wsUrl) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(wsUrl);
    var next = 1;
    var pending = new Map();
    ws.addEventListener('message', function (ev) {
      var msg = JSON.parse(ev.data);
      var slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else slot.resolve(msg.result);
    });
    ws.addEventListener('error', function () { reject(new Error('CDP socket failed: ' + wsUrl)); });
    ws.addEventListener('open', function () {
      resolve({
        send: function (method, params) {
          var id = next++;
          return new Promise(function (res, rej) {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
          });
        },
        close: function () { ws.close(); }
      });
    });
  });
}

async function waitForPort(port, tries) {
  for (var i = 0; i < tries; i++) {
    try {
      var res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (res.ok) return true;
    } catch (err) { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

async function waitForReady(cdp, slug) {
  for (var i = 0; i < 60; i++) {
    var out = await cdp.send('Runtime.evaluate', { expression: '(' + READY.toString() + ')()', returnByValue: true });
    var state = out.result && out.result.value;
    if (state && state.ready) {
      if (state.failed && state.failed.length) throw new Error(slug + ': the demo data did not load for ' + state.failed.join(', '));
      if (state.problems.length) throw new Error(slug + ': the page shows ' + state.problems.join(', '));
      return;
    }
    await sleep(250);
  }
  throw new Error(slug + ': the workspace never finished loading.');
}

async function capture(port, base, target) {
  var res = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
  var tab = await res.json();
  var cdp = await connect(tab.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.scale, mobile: false
    });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await cdp.send('Page.navigate', { url: base + '/#' + target.route });
    await waitForReady(cdp, target.slug);
    await sleep(900);                                      /* the page's entrance animation */
    await waitForReady(cdp, target.slug);                  /* and the wordmark again after any repaint */
    var shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(shot.data, 'base64');
  } finally {
    cdp.close();
    await fetch('http://127.0.0.1:' + port + '/json/close/' + tab.id).catch(function () {});
  }
}

function toWebp(png, target) {
  target.widths.forEach(function (size) {
    var out = path.join(OUT, 'cockpit-' + target.slug + '-' + size.w + 'w.webp');
    var run = spawnSync('cwebp', ['-quiet', '-q', String(size.q), '-m', '6', '-resize', String(size.w), '0', png, '-o', out]);
    if (run.status !== 0) fail('cwebp failed for ' + target.slug + ' at ' + size.w + 'w. Is it installed (brew install webp)?');
    console.log('  ' + path.relative(ROOT, out) + '  ' + Math.round(fs.statSync(out).size / 1024) + ' KB');
  });
}

async function main() {
  var args = process.argv.slice(2);
  var server = await startServer();
  var base = 'http://127.0.0.1:' + server.address().port;

  if (args.indexOf('--serve') !== -1) {
    console.log('Cockpit demo at ' + base + '/  (serving ' + DIST + ', Ctrl-C to stop)');
    return;
  }

  var only = args[0];
  var targets = only ? TARGETS.filter(function (t) { return t.slug.indexOf(only) !== -1; }) : TARGETS;
  if (!targets.length) fail('no view matches "' + only + '"');

  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veyago-cockpit-'));
  var port = 9334;
  var browser = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(tmp, 'profile'),
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    if (!await waitForPort(port, 40)) fail('the browser never opened its debugging port.');
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      console.log('cockpit-' + t.slug + '  <-  #' + t.route);
      var png = path.join(tmp, t.slug + '.png');
      fs.writeFileSync(png, await capture(port, base, t));
      toWebp(png, t);
    }
  } finally {
    browser.kill();
    server.close();
    await sleep(500);                                      /* let the profile flush before it goes */
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* temp dir, it can wait for the OS */ }
  }
}

main().catch(function (err) { fail(err && err.message ? err.message : String(err)); });
