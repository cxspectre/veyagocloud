#!/usr/bin/env node
/* build-og-images.js — one share card per page, rendered from a template.
 *
 *   node tools/build-og-images.js              write the cards that are missing
 *   node tools/build-og-images.js --force      redraw every card
 *   node tools/build-og-images.js kept         just the cards whose slug matches
 *
 * Before this, three pages had a bespoke og:image and everything else — both
 * research papers, all four articles, the Kept product page — shared one generic
 * assets/og.png. A link to a 5,000-word paper previewed identically to a link to
 * the homepage, on LinkedIn, Slack and everywhere else a share card is the whole
 * first impression.
 *
 * Same approach as tools/capture-work-shots.js: drive a local Chromium over the
 * DevTools protocol, no new dependency. The template is plain HTML in this file,
 * so a card is a data entry rather than a trip through a design tool.
 *
 * Needs a Chromium-family browser (Brave, Chrome, Edge or Chromium).
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var { spawn } = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.join(ROOT, 'assets');

/* Facebook, LinkedIn, X and Slack all crop to 1.91:1. */
var CARD = { width: 1200, height: 630 };

var BROWSERS = [
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome'
];

/* file → { eyebrow, headline, subline, footer }. The headline is the promise the
   page makes; the footer is the address, so a card lifted out of context still
   says where it came from. */
var CARDS = [
  {
    file: 'og-kept.png',
    eyebrow: 'Veyago · Kept',
    headline: 'Keep track of anything with a date.',
    subline: 'Warranties, receipts, renewals. On-device. Free.',
    footer: 'www.veyago.cloud/kept · on the App Store'
  },
  {
    file: 'og-team.png',
    eyebrow: 'Veyago · Team',
    headline: 'Two people. No account managers.',
    subline: 'Cassian Drefke and Wessel Gelderblom.',
    footer: 'www.veyago.cloud/team · a New York studio'
  },
  {
    file: 'og-services.png',
    eyebrow: 'Veyago · Services',
    headline: 'Hire the studio, not an agency.',
    subline: 'Product design and engineering, a few projects a year.',
    footer: 'www.veyago.cloud/services · a New York studio'
  },
  {
    file: 'og-projects.png',
    eyebrow: 'Veyago · Research',
    headline: 'The research before the build.',
    subline: 'Working papers, a public pipeline, named sources.',
    footer: 'www.veyago.cloud/projects · a New York studio'
  },
  {
    file: 'og-paper-unkept-life.png',
    eyebrow: 'Veyago · Working paper',
    headline: 'The Unkept Life',
    subline: 'The cognitive cost of life admin, and the case for a private answer.',
    footer: 'www.veyago.cloud/projects/the-unkept-life · 5,000 words'
  },
  {
    file: 'og-paper-edge-moves-in.png',
    eyebrow: 'Veyago · Working paper',
    headline: 'The Edge Moves In',
    subline: 'Intelligence is migrating to the device. What that changes.',
    footer: 'www.veyago.cloud/projects/the-edge-moves-in · 3,700 words'
  },
  {
    file: 'og-article-wix.png',
    eyebrow: 'Veyago · Field note',
    headline: 'Why your Wix site is slow.',
    subline: 'Where the weight comes from, and the two checks that prove it.',
    footer: 'www.veyago.cloud/journal · 7 min read'
  },
  {
    file: 'og-article-699.png',
    eyebrow: 'Veyago · Field note',
    headline: 'What a $699 website includes.',
    subline: 'Three packages, line by line, with what costs extra.',
    footer: 'www.veyago.cloud/journal · 6 min read'
  },
  {
    file: 'og-article-ai-prototype.png',
    eyebrow: 'Veyago · Field note',
    headline: 'From AI prototype to production.',
    subline: 'What Lovable and v0 get right, and where they stop.',
    footer: 'www.veyago.cloud/journal · 6 min read'
  },
  {
    file: 'og-article-side-of-line.png',
    eyebrow: 'Veyago · Essay',
    headline: 'On your side of the line.',
    subline: 'Software can get smarter without taking your life to a server.',
    footer: 'www.veyago.cloud/journal · 7 min read'
  }
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* The mark is inlined as a data URI so the page needs no network and no server. */
function markDataUri() {
  var file = path.join(OUT, 'apple-touch-icon.png');
  return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
}

function template(card, mark) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${CARD.width}px;height:${CARD.height}px}
  body{
    font:400 16px/1.4 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;
    color:#111114;
    background:linear-gradient(160deg,#f7f8fa 0%,#ffffff 45%,#f4f5f8 100%);
    padding:64px 80px;display:flex;flex-direction:column;
    -webkit-font-smoothing:antialiased;
  }
  .brand{display:flex;align-items:center;gap:22px;margin-bottom:56px}
  .brand img{width:72px;height:72px;border-radius:18px;display:block}
  .brand span{font-size:34px;font-weight:700;letter-spacing:-.02em}
  .eyebrow{font-size:22px;letter-spacing:.14em;text-transform:uppercase;color:#6b6f76;margin-bottom:22px}
  h1{font-size:${card.headline.length > 34 ? 68 : 78}px;line-height:1.06;font-weight:700;letter-spacing:-.035em;max-width:1000px}
  .sub{margin-top:26px;font-size:29px;line-height:1.35;color:#54585f;max-width:930px}
  .foot{margin-top:auto;padding-top:26px;border-top:1px solid #e2e4e8;font-size:21px;color:#6b6f76}
  </style></head><body>
  <div class="brand"><img src="${mark}" alt=""><span>Veyago</span></div>
  <p class="eyebrow">${esc(card.eyebrow)}</p>
  <h1>${esc(card.headline)}</h1>
  <p class="sub">${esc(card.subline)}</p>
  <p class="foot">${esc(card.footer)}</p>
  </body></html>`;
}

function fail(msg) { console.error('build-og-images: ' + msg); process.exit(1); }

function findBrowser() {
  var hit = BROWSERS.filter(function (b) { return fs.existsSync(b); })[0];
  if (!hit) fail('no Chromium-family browser found. Install Brave, Chrome, Edge or Chromium.');
  return hit;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

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

async function render(port, html) {
  var res = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
  var tab = await res.json();
  var cdp = await connect(tab.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: CARD.width, height: CARD.height, deviceScaleFactor: 1, mobile: false
    });
    await cdp.send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
    await sleep(700);                                      /* layout + the inlined mark */
    var shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(shot.data, 'base64');
  } finally {
    cdp.close();
    await fetch('http://127.0.0.1:' + port + '/json/close/' + tab.id).catch(function () {});
  }
}

async function main() {
  var argv = process.argv.slice(2);
  var force = argv.indexOf('--force') !== -1;
  var only = argv.filter(function (a) { return a.charAt(0) !== '-'; })[0];

  var wanted = CARDS.filter(function (c) { return !only || c.file.indexOf(only) !== -1; });
  if (!wanted.length) fail('no card matches "' + only + '"');
  var todo = wanted.filter(function (c) { return force || !fs.existsSync(path.join(OUT, c.file)); });

  if (!todo.length) {
    console.log('og images: every card already exists (use --force to redraw).');
    return;
  }

  var mark = markDataUri();
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veyago-og-'));
  var port = 9334;
  var browser = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(tmp, 'profile'),
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    if (!await waitForPort(port, 40)) fail('the browser never opened its debugging port.');
    for (var i = 0; i < todo.length; i++) {
      var card = todo[i];
      var png = await render(port, template(card, mark));
      fs.writeFileSync(path.join(OUT, card.file), png);
      console.log('  assets/' + card.file + '  ' + Math.round(png.length / 1024) + ' KB  — ' + card.headline);
    }
    console.log('og images: ' + todo.length + ' card(s) written.');
  } finally {
    browser.kill();
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* the OS can have it */ }
  }
}

if (require.main === module) main().catch(function (err) { fail(err && err.message ? err.message : String(err)); });

module.exports = { CARDS, template };
