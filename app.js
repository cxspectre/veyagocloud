/* Veyago - minimal interactions. */
(function () {
  'use strict';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------------------
     Launch announcement bar - temporary notice for the Kept launch slip.
     Injected here so one source of truth covers every page. To retire it once
     Kept ships, delete this block and the matching ".launch-bar" CSS block.
     Bump LB_KEY when the copy materially changes (re-shows for past dismissers).
     The fixed bar reserves space via --lb-h, which shifts the page + nav down
     uniformly on every page type (hero / policy / legal). See styles.css.
  --------------------------------------------------------------------------- */
  (function launchBar() {
    var LB_KEY = 'veyago.lb.kept-2026-06';
    try { if (localStorage.getItem(LB_KEY) === '1') return; } catch (e) {}
    if (!document.body) return;

    var bar = document.createElement('div');
    bar.className = 'launch-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Launch update');
    bar.innerHTML =
      '<div class="lb-inner">' +
        '<span class="lb-dot" aria-hidden="true"></span>' +
        '<p class="lb-text"><strong>Launch update</strong> - We\'d aimed to launch Kept the week of June 8; ' +
        'it now arrives within two weeks of June 15 as we finish Apple\'s move to an organization developer ' +
        'account and final certification. We\'d rather get it right - updates to follow. ' +
        '<a class="lb-link" href="mailto:hello@veyago.cloud?subject=Notify%20me%20when%20Kept%20launches">Get updates ›</a></p>' +
        '<button class="lb-close" type="button" aria-label="Dismiss launch update">' +
          '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
        '</button>' +
      '</div>';
    document.body.insertBefore(bar, document.body.firstChild);

    var root = document.documentElement;
    function measure() { root.style.setProperty('--lb-h', bar.offsetHeight + 'px'); }

    /* Reserve the height as a snap (no slide on load), then allow eased changes. */
    measure();
    void document.body.offsetHeight;
    document.body.classList.add('lb-anim');
    requestAnimationFrame(function () { bar.classList.add('in'); });

    /* Keep the reserved height correct as the bar re-wraps (resize, font swap). */
    var ro = null;
    if ('ResizeObserver' in window) { ro = new ResizeObserver(measure); ro.observe(bar); }
    else { window.addEventListener('resize', measure, { passive: true }); }

    function dismiss() {
      try { localStorage.setItem(LB_KEY, '1'); } catch (e) {}
      if (ro) ro.disconnect();
      root.style.setProperty('--lb-h', '0px');  /* content eases back up */
      bar.classList.remove('in');               /* bar fades out         */
      var remove = function () { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); bar = null; };
      bar.addEventListener('transitionend', function (e) { if (e.propertyName === 'opacity') remove(); }, { once: true });
      setTimeout(remove, 700);
    }
    bar.querySelector('.lb-close').addEventListener('click', dismiss);
  })();

  /* Year */
  var y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();

  /* Scroll reveals */
  var reveals = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* Nav scroll transparency */
  var nav = document.getElementById('site-nav');
  if (nav) {
    function syncScroll() { nav.classList.toggle('scrolled', window.scrollY > 10); }
    syncScroll();
    window.addEventListener('scroll', syncScroll, { passive: true });
  }

  /* Active nav link */
  var page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links > a, .nav-dropdown a').forEach(function (a) {
    if (a.getAttribute('href') === page) {
      a.classList.add('active');
      var item = a.closest('.nav-item');
      if (item) {
        var btn = item.querySelector('.nav-drop-btn');
        if (btn) btn.classList.add('active');
      }
    }
  });

  /* Company dropdown (click / keyboard - hover handled by CSS) */
  var companyNav = document.getElementById('company-nav');
  if (companyNav) {
    var dropBtn = companyNav.querySelector('.nav-drop-btn');
    function closeDropdown() {
      companyNav.classList.remove('open');
      if (dropBtn) dropBtn.setAttribute('aria-expanded', 'false');
    }
    if (dropBtn) {
      dropBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = companyNav.classList.toggle('open');
        dropBtn.setAttribute('aria-expanded', String(open));
      });
    }
    document.addEventListener('click', function (e) {
      if (!companyNav.contains(e.target)) closeDropdown();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDropdown();
    });
  }

  /* Mobile drawer */
  var toggle = document.getElementById('nav-toggle');
  var drawer = document.getElementById('nav-drawer');
  var scrim = document.getElementById('nav-scrim');
  var closeBtn = document.getElementById('nav-drawer-close');
  if (toggle && drawer && scrim) {
    var lastFocused = null;
    var scrollLockY = 0;
    var inerted = [];

    function drawerOpen() { return drawer.classList.contains('open'); }
    function drawerFocusables() {
      return drawer.querySelectorAll('a[href], button:not([disabled])');
    }
    function isVisible(el) { return !!(el && el.getClientRects().length); }

    /* Take the rest of the page out of the tab order, pointer reach, and a11y tree */
    function setBackgroundInert(on) {
      if (on) {
        inerted = [];
        var kids = document.body.children;
        for (var i = 0; i < kids.length; i++) {
          var el = kids[i];
          if (el === drawer || el === scrim) continue;
          if (!el.hasAttribute('inert')) { el.setAttribute('inert', ''); inerted.push(el); }
        }
      } else {
        inerted.forEach(function (el) { el.removeAttribute('inert'); });
        inerted = [];
      }
    }

    function openDrawer() {
      lastFocused = document.activeElement;
      scrollLockY = window.scrollY || window.pageYOffset || 0;
      drawer.classList.add('open');
      scrim.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close menu');
      drawer.setAttribute('aria-hidden', 'false');
      document.body.style.top = (-scrollLockY) + 'px';
      document.documentElement.classList.add('menu-open');
      setBackgroundInert(true);
      if (closeBtn) closeBtn.focus();
    }

    function closeDrawer() {
      if (!drawerOpen()) return;
      drawer.classList.remove('open');
      scrim.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open menu');
      drawer.setAttribute('aria-hidden', 'true');
      setBackgroundInert(false);
      document.documentElement.classList.remove('menu-open');
      document.body.style.top = '';
      window.scrollTo(0, scrollLockY);
      if (isVisible(lastFocused) && typeof lastFocused.focus === 'function') lastFocused.focus();
    }

    toggle.addEventListener('click', function () {
      drawerOpen() ? closeDrawer() : openDrawer();
    });
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    scrim.addEventListener('click', closeDrawer);

    /* Close (then navigate) when a drawer link is tapped */
    drawer.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', closeDrawer);
    });

    /* Escape closes; Tab is trapped inside the open drawer */
    document.addEventListener('keydown', function (e) {
      if (!drawerOpen()) return;
      if (e.key === 'Escape') { closeDrawer(); return; }
      if (e.key === 'Tab') {
        var f = drawerFocusables();
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        /* Re-capture focus if it has drifted outside the drawer */
        if (!drawer.contains(document.activeElement)) {
          e.preventDefault(); first.focus(); return;
        }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    });
  }
})();
