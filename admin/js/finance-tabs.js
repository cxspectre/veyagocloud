/* Wires the Overview / Transactions / Invoices tab strip on /admin/finance.

   Three pages became one PAGE, not one CONTROLLER — finance.js, transactions.js
   and invoices.js each still own their own tab's data and behaviour, load
   independently on adminReady, and know nothing about tabs. This file's only
   job is which panel is visible, so the three stay exactly as focused as they
   were as separate pages (transactions.js alone is 458 lines — concatenating
   the three into one controller would have meant a single file pushing 1,200+
   lines for what is still, underneath, three separate jobs).

   State lives in the URL hash — same pattern as member.js's Profile/Onboarding/
   Tasks tabs — so a reload, a shared link, or the browser back button all keep
   the tab you were looking at. That file's version has run in production for a
   while with no test of its own; this one gets one, in finance-tabs.test.js. */
(function () {
  'use strict';

  var TABS = ['overview', 'transactions', 'invoices'];

  function currentTab() {
    var h = (window.location.hash || '').replace(/^#/, '');
    return TABS.indexOf(h) === -1 ? 'overview' : h;
  }

  function showTab(name) {
    TABS.forEach(function (t) {
      var on    = t === name;
      var btn   = document.getElementById('tab-' + t);
      var panel = document.getElementById('panel-' + t);
      if (btn) {
        btn.className = 'adm-tab' + (on ? ' active' : '');
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.tabIndex = on ? 0 : -1;
      }
      if (panel) panel.hidden = !on;
    });
  }

  function wire() {
    TABS.forEach(function (t, idx) {
      var btn = document.getElementById('tab-' + t);
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (currentTab() === t) { showTab(t); return; }   // hash already right
        window.location.hash = t;                          // → hashchange → showTab
      });
      btn.addEventListener('keydown', function (ev) {
        var next = -1;
        if (ev.key === 'ArrowRight') next = (idx + 1) % TABS.length;
        else if (ev.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = TABS.length - 1;
        if (next === -1) return;
        ev.preventDefault();
        window.location.hash = TABS[next];
        var target = document.getElementById('tab-' + TABS[next]);
        if (target) target.focus();
      });
    });

    /* Also fires for a same-page click on an in-panel "Manage invoices →" /
       "View all →" link, which is exactly the redundant cross-page navigation
       this merge exists to remove — those are now #hash links, not new pages. */
    window.addEventListener('hashchange', function () { showTab(currentTab()); });
    showTab(currentTab());
  }

  /* Elements already exist by the time this runs — loaded at the end of
     <body>, same as every other admin script (see member.js: wireTabs() is
     called unconditionally at top level, not gated behind adminReady). */
  wire();

  /* Exposed for finance-tabs.test.js only. Nothing in the product reaches into
     this — the hash is the real, public interface. */
  window.adminFinanceTabs = { currentTab: currentTab, showTab: showTab, TABS: TABS };
})();
