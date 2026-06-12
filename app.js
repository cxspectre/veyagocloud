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

  /* ---------------------------------------------------------------------------
     Lightweight i18n - 6-language* client-side switcher (*EN + 4 locales today).
     English is the source of truth in the HTML; non-English locales are applied
     at runtime by matching the live text against a dictionary loaded from
     /i18n/<code>.js. The picker (nav + drawer) is injected here so one source of
     truth covers every page. Legal-page bodies stay English simply by not being
     in the dictionaries. To add a language: add it to LANGS and drop in a
     matching /i18n/<code>.js. See styles.css ".lang" for the picker styling.
  --------------------------------------------------------------------------- */
  (function i18n() {
    var LANGS = [
      { code: 'en', name: 'English' },
      { code: 'nl', name: 'Nederlands' },
      { code: 'fr', name: 'Français' },
      { code: 'de', name: 'Deutsch' },
      { code: 'es', name: 'Español' }
    ];
    var SUP = {}; LANGS.forEach(function (l) { SUP[l.code] = l.name; });
    var LS = 'veyago.lang';
    var SUGGEST_LS = 'veyago.lang.suggest';   // '1' once the suggestion has been dismissed
    /* Suggestion toast copy, shown in the target language so a speaker recognises it. */
    var SUGGEST = {
      nl: { msg: 'Veyago is ook beschikbaar in het Nederlands.', yes: 'Naar Nederlands', no: 'Niet nu' },
      fr: { msg: 'Veyago est aussi disponible en français.', yes: 'Passer en français', no: 'Pas maintenant' },
      de: { msg: 'Veyago ist auch auf Deutsch verfügbar.', yes: 'Auf Deutsch wechseln', no: 'Nicht jetzt' },
      es: { msg: 'Veyago también está disponible en español.', yes: 'Cambiar a español', no: 'Ahora no' }
    };

    function stored() { try { return localStorage.getItem(LS); } catch (e) { return null; } }
    /* First supported language in the visitor's locale preference order. On-device only -
       no IP-geolocation lookup, in keeping with the privacy-first brand. Drives the suggestion. */
    function detect() {
      var ls = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
      for (var i = 0; i < ls.length; i++) {
        var two = String(ls[i]).slice(0, 2).toLowerCase();
        if (SUP[two]) return two;
      }
      return 'en';
    }
    /* Default to English unless the visitor explicitly chose a language - we suggest
       their locale (see the toast at the end), never force it. */
    var lang = stored() || 'en';
    if (!SUP[lang]) lang = 'en';
    document.documentElement.lang = lang;

    function setLang(code) {
      if (!SUP[code]) return;
      try { localStorage.setItem(LS, code); } catch (e) {}
      if (code === lang) return;
      location.reload();   // English source + dict-on-load makes reload the clean path
    }

    /* ---- Picker UI (injected into the nav and the mobile drawer) ---- */
    var GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>';
    var CLOSE = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    function buildNavPicker() {
      var navRight = document.querySelector('.nav-right');
      var toggle = document.getElementById('nav-toggle');
      if (!navRight || !toggle) return;
      var wrap = document.createElement('div');
      wrap.className = 'lang'; wrap.id = 'lang-switch';
      var menu = LANGS.map(function (l) {
        return '<button role="menuitem" type="button" class="lang-opt' + (l.code === lang ? ' active' : '') +
          '" data-setlang="' + l.code + '" lang="' + l.code + '">' + l.name + '</button>';
      }).join('');
      wrap.innerHTML =
        '<button class="lang-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Change language">' +
          GLOBE + '<span class="lang-cur">' + lang.toUpperCase() + '</span>' +
        '</button>' +
        '<div class="lang-menu" role="menu">' + menu + '</div>';
      navRight.insertBefore(wrap, toggle);

      var btn = wrap.querySelector('.lang-btn');
      var pop = wrap.querySelector('.lang-menu');
      function close() { wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = wrap.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
      pop.addEventListener('click', function (e) {
        var b = e.target.closest('[data-setlang]'); if (b) setLang(b.getAttribute('data-setlang'));
      });
    }

    function buildDrawerPicker() {
      var links = document.querySelector('.nav-drawer-links');
      if (!links) return;
      var label = document.createElement('p');
      label.className = 'nm-label'; label.textContent = 'Language';
      label.setAttribute('data-i18n-skip', '');
      links.appendChild(label);
      LANGS.forEach(function (l) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'nm-sub lang-opt' + (l.code === lang ? ' active' : '');
        b.setAttribute('data-setlang', l.code);
        b.setAttribute('lang', l.code);
        b.setAttribute('data-i18n-skip', '');
        b.textContent = l.name;
        b.addEventListener('click', function () { setLang(l.code); });
        links.appendChild(b);
      });
    }

    buildNavPicker();
    buildDrawerPicker();

    /* ---- Apply a dictionary to the live DOM ---- */
    var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1 };
    function squish(s) { return s.replace(/\s+/g, ' ').trim(); }

    function applyDict(dict) {
      var strings = dict.strings || {};
      var attrsMap = dict.attrs || {};
      var htmlMap = dict.html || {};

      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          var el = node.parentNode;
          while (el && el.nodeType === 1 && el !== document.body) {
            if (SKIP_TAGS[el.tagName]) return NodeFilter.FILTER_REJECT;
            if (el.namespaceURI && el.namespaceURI.indexOf('svg') !== -1) return NodeFilter.FILTER_REJECT;
            if (el.hasAttribute('data-i18n') || el.hasAttribute('data-i18n-skip')) return NodeFilter.FILTER_REJECT;
            if (el.classList && (el.classList.contains('brand') || el.classList.contains('lang'))) return NodeFilter.FILTER_REJECT;
            el = el.parentNode;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var nodes = [], n;
      while ((n = walker.nextNode())) nodes.push(n);
      nodes.forEach(function (node) {
        var raw = node.nodeValue;
        var lead = (raw.match(/^\s*/) || [''])[0];
        var trail = (raw.match(/\s*$/) || [''])[0];
        var core = squish(raw);
        var t = strings[core];
        if (t != null && t !== core) node.nodeValue = lead + t + trail;
      });

      var richEls = document.querySelectorAll('[data-i18n]');
      for (var i = 0; i < richEls.length; i++) {
        var key = richEls[i].getAttribute('data-i18n');
        if (htmlMap[key]) richEls[i].innerHTML = htmlMap[key];
      }

      var attrEls = document.querySelectorAll('[alt],[aria-label],[title]');
      for (var j = 0; j < attrEls.length; j++) {
        ['alt', 'aria-label', 'title'].forEach(function (a) {
          var el = attrEls[j];
          if (!el.hasAttribute(a) || el.hasAttribute('data-i18n-skip')) return;
          var v = squish(el.getAttribute(a) || '');
          if (!v) return;
          var t = (attrsMap[v] != null ? attrsMap[v] : strings[v]);
          if (t != null && t !== v) el.setAttribute(a, t);
        });
      }

      if (dict.meta) {
        var path = location.pathname.replace(/index\.html$/, '');
        if (path === '') path = '/';
        var m = dict.meta[path];
        if (m) {
          if (m.title) document.title = m.title;
          if (m.description) {
            var md = document.querySelector('meta[name="description"]');
            if (md) md.setAttribute('content', m.description);
          }
        }
      }
    }

    /* ---- Load + apply the active locale ---- */
    window.__veyagoI18n = {
      lang: lang,
      register: function (code, dict) { if (code === lang) { try { applyDict(dict); } catch (e) {} } }
    };
    if (lang !== 'en') {
      var s = document.createElement('script');
      s.src = '/i18n/' + lang + '.js';
      s.onerror = function () { document.documentElement.lang = 'en'; };
      document.head.appendChild(s);
    }

    /* ---- Locale suggestion: offer the visitor's language, don't force it ---- */
    (function suggest() {
      if (stored()) return;                          // an explicit choice wins, no nagging
      var code = detect();
      if (code === 'en' || !SUGGEST[code]) return;   // English preferred (or unsupported) - nothing to offer
      try { if (localStorage.getItem(SUGGEST_LS) === '1') return; } catch (e) {}  // already dismissed

      var copy = SUGGEST[code];
      var el = document.createElement('div');
      el.className = 'lang-suggest'; el.lang = code;
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', copy.msg);
      el.innerHTML =
        '<span class="ls-globe" aria-hidden="true">' + GLOBE + '</span>' +
        '<div class="ls-body">' +
          '<p class="ls-msg">' + copy.msg + '</p>' +
          '<div class="ls-actions">' +
            '<button type="button" class="ls-yes">' + copy.yes + '</button>' +
            '<button type="button" class="ls-no">' + copy.no + '</button>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="ls-close" aria-label="' + copy.no + '">' + CLOSE + '</button>';

      function close() {
        try { localStorage.setItem(SUGGEST_LS, '1'); } catch (e) {}
        el.classList.remove('in');
        var rm = function () { if (el.parentNode) el.parentNode.removeChild(el); };
        el.addEventListener('transitionend', function (ev) { if (ev.propertyName === 'opacity') rm(); }, { once: true });
        setTimeout(rm, 500);
      }
      el.querySelector('.ls-yes').addEventListener('click', function () { setLang(code); });
      el.querySelector('.ls-no').addEventListener('click', close);
      el.querySelector('.ls-close').addEventListener('click', close);

      document.body.appendChild(el);
      setTimeout(function () { el.classList.add('in'); }, 600);   // a beat after load, so it's noticed
    })();
  })();

  /* Year */
  var y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();

  /* Research-paper table-of-contents scroll-spy */
  (function paperToc() {
    var toc = document.querySelector('.paper-toc');
    if (!toc) return;
    var links = {};
    toc.querySelectorAll('a[href^="#"]').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
    var heads = [].slice.call(document.querySelectorAll('.paper-body h2[id]'));
    if (!heads.length) return;
    var current = null;
    function setActive(id) {
      if (id === current || !links[id]) return;
      if (current && links[current]) links[current].classList.remove('active');
      links[id].classList.add('active');
      current = id;
    }
    setActive(heads[0].id);
    if (reduced || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) setActive(e.target.id); });
    }, { rootMargin: '-72px 0px -78% 0px', threshold: 0 });
    heads.forEach(function (h) { io.observe(h); });
  })();

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
