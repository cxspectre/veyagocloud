#!/usr/bin/env node
/* capture-work-shots.js - regenerate the portfolio screenshots on /websites/.
 *
 * The "Recent work" grid shows a real screenshot of every site we built. Sites
 * change, so the shots need to be retakeable by anyone, the same way every
 * time. This drives a local Chromium over the DevTools protocol (no puppeteer,
 * no new dependency - node 22 ships fetch and WebSocket), dismisses the consent
 * banner the privacy-preserving way, and writes the two WebP widths the page
 * asks for.
 *
 *   node tools/capture-work-shots.js            all targets
 *   node tools/capture-work-shots.js td-consult one target
 *
 * Needs a Chromium-family browser (Brave, Chrome, Edge or Chromium) and cwebp
 * (`brew install webp`). Output lands in assets/ and is committed - the site
 * never fetches anything at runtime.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var { spawn, spawnSync } = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.join(ROOT, 'assets');

/* Viewport of the shot. 3:2 at 2x, which is what the card renders at on a
   retina screen; anything larger is bytes nobody sees. */
var VIEW = { width: 1400, height: 933, scale: 2 };
/* 1x and 2x of the card's ~552px column. The 2x file is only ever seen at
   half its pixel size, so it can take a harder squeeze than the 1x. */
var WIDTHS = [{ w: 560, q: 76 }, { w: 1120, q: 58 }];

var TARGETS = [
  { slug: 'work-td-consult', url: 'https://td-consult.info/' },
  { slug: 'work-tdc-advisory', url: 'https://www.tdc-advisory.com/' },
  { slug: 'work-veyago-app', url: 'https://www.veyago.app/' },
  { slug: 'work-ie-global', url: 'https://www.ie-global.net/en' }
];

var BROWSERS = [
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome'
];

/* Consent banners: click the option that accepts the least, then drop whatever
   overlay is left. Never "Accept all" - the shot should show the site, and we
   are not agreeing to tracking on anyone's behalf. */
var DISMISS = function () {
  try {
    var DECLINE = /^(reject|decline|refuse|essential only|only essential|necessary only|strictly necessary|deny|weigeren|alleen noodzakelijk|ablehnen|nur notwendige)/i;
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"]'));
    var hit = buttons.filter(function (b) { return DECLINE.test((b.textContent || b.value || '').trim()); })[0];
    if (hit) hit.click();
  } catch (e) { /* the banner may already be gone */ }
  return true;
};

/* Whatever consent UI survived the click is hidden, never removed - these are
   live React trees and pulling a node out from under them crashes the app into
   its error boundary, which is what the screenshot would then show. */
var HIDE_LEFTOVERS = function () {
  var COOKIE = /cookie|consent|gdpr|\bcmp\b/i;
  Array.prototype.slice.call(document.querySelectorAll('body *')).forEach(function (el) {
    try {
      var pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') return;
      var box = el.getBoundingClientRect();
      if (box.height < 40 || box.height > window.innerHeight * 0.7) return;
      var label = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
      var text = (el.textContent || '').slice(0, 600);
      if (COOKIE.test(label) || COOKIE.test(text)) el.style.setProperty('display', 'none', 'important');
    } catch (e) { /* detached mid-walk */ }
  });
  window.scrollTo(0, 0);
  return true;
};

function fail(msg) { console.error('capture-work-shots: ' + msg); process.exit(1); }

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

async function capture(port, target) {
  var res = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
  var tab = await res.json();
  var cdp = await connect(tab.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.scale, mobile: false
    });
    await cdp.send('Page.navigate', { url: target.url });
    await sleep(6000);                                     /* fonts, hero video, lazy art */
    await cdp.send('Runtime.evaluate', { expression: '(' + DISMISS.toString() + ')()' });
    await sleep(1500);                                     /* banner exit animation */
    await cdp.send('Runtime.evaluate', { expression: '(' + HIDE_LEFTOVERS.toString() + ')()' });
    await sleep(400);
    var shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(shot.data, 'base64');
  } finally {
    cdp.close();
    await fetch('http://127.0.0.1:' + port + '/json/close/' + tab.id).catch(function () {});
  }
}

function toWebp(png, slug) {
  WIDTHS.forEach(function (size) {
    var out = path.join(OUT, slug + '-' + size.w + 'w.webp');
    var run = spawnSync('cwebp', ['-quiet', '-q', String(size.q), '-resize', String(size.w), '0', png, '-o', out]);
    if (run.status !== 0) fail('cwebp failed for ' + slug + ' at ' + size.w + 'w. Is it installed (brew install webp)?');
    console.log('  ' + path.relative(ROOT, out) + '  ' + Math.round(fs.statSync(out).size / 1024) + ' KB');
  });
}

async function main() {
  var only = process.argv[2];
  var targets = only ? TARGETS.filter(function (t) { return t.slug.indexOf(only) !== -1; }) : TARGETS;
  if (!targets.length) fail('no target matches "' + only + '"');

  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veyago-shots-'));
  var port = 9333;
  var browser = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(tmp, 'profile'),
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    if (!await waitForPort(port, 40)) fail('the browser never opened its debugging port.');
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      console.log(t.slug + '  <-  ' + t.url);
      var png = path.join(tmp, t.slug + '.png');
      fs.writeFileSync(png, await capture(port, t));
      toWebp(png, t.slug);
    }
  } finally {
    browser.kill();
    await sleep(500);                                      /* let the profile flush before it goes */
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* temp dir, it can wait for the OS */ }
  }
}

main().catch(function (err) { fail(err && err.message ? err.message : String(err)); });
