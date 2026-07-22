/* Injects the admin sidebar into every admin page, handles the mobile toggle,
   highlights the active nav item, and wires sign-out. Must load after client.js. */
(function () {
  'use strict';

  var PATH = window.location.pathname;

  /* Resolve the current page to a canonical key for active-link matching.
     /admin/ and /admin/index.html both map to '/admin/'. */
  function currentKey() {
    if (PATH === '/admin/' || PATH === '/admin/index.html' || PATH === '/admin') return '/admin/';
    var file = PATH.split('/').pop();
    return file ? '/admin/' + file : '/admin/';
  }
  var CURRENT = currentKey();

  var NAV = [
    { label: 'Dashboard',     href: '/admin/',                   icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { section: 'Content' },
    { label: 'Articles',      href: '/admin/journal.html',        icon: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>' },
    { label: 'Wallpapers',    href: '/admin/wallpapers.html',     icon: '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 13l5-4 4 4 3-2 5 3"/>' },
    { section: 'Site' },
    { label: 'Announcements', href: '/admin/announcements.html',  icon: '<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>' },
    { label: 'Apps',          href: '/admin/apps.html',           icon: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>' },
    { label: 'Projects',      href: '/admin/projects.html',       icon: '<polygon points="12 2 2 7 12 12 22 7"/><polyline points="2 17 12 22 22 17"/>' },
    { section: 'Company' },
    { label: 'Team',          href: '/admin/team.html',           icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
    { label: 'Onboarding',    href: '/admin/onboarding.html',     icon: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>' },
    { label: 'Tasks',         href: '/admin/tasks.html',          icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
    { label: 'Finance',       href: '/admin/finance.html',        icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>', managerOnly: true },
    { section: 'Settings' },
    { label: 'Users',         href: '/admin/users.html',          icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2.7a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h.01a1.65 1.65 0 001-1.51V2.7a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h.01a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.01a1.65 1.65 0 001.51 1h.09a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>' }
  ];

  function svgIcon(d) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }

  function buildSidebar() {
    var aside = document.createElement('aside');
    aside.className = 'adm-sidebar';
    aside.id = 'adm-sidebar';

    var logoHtml =
      '<a class="adm-logo" href="/admin/">' +
        '<img src="/assets/veyago-icon.png" alt="" width="22" height="22" />' +
        '<div><div class="adm-logo-text">Veyago</div><div class="adm-logo-sub">Admin</div></div>' +
      '</a>';

    var navHtml = '<nav class="adm-nav" aria-label="Admin navigation">';
    NAV.forEach(function (item) {
      if (item.section) {
        navHtml += '<p class="adm-nav-section">' + item.section + '</p>';
      } else {
        var key = item.href === '/admin/' ? '/admin/' : '/admin/' + item.href.split('/').pop();
        var cls = CURRENT === key ? 'active' : '';
        var attrs = (cls ? ' class="' + cls + '"' : '') +
                    (item.managerOnly ? ' data-manager-only hidden' : '');
        navHtml += '<a href="' + item.href + '"' + attrs + '>' +
          svgIcon(item.icon) + item.label +
        '</a>';
      }
    });
    navHtml += '</nav>';

    var footHtml =
      '<div class="adm-sidebar-foot">' +
        '<button class="adm-signout" id="adm-signout" type="button">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" width="16" height="16"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
          'Sign out' +
        '</button>' +
      '</div>';

    aside.innerHTML = logoHtml + navHtml + footHtml;
    return aside;
  }

  function buildToggle() {
    var btn = document.createElement('button');
    btn.className = 'adm-toggle';
    btn.id = 'adm-toggle';
    btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
    return btn;
  }

  function mount() {
    document.body.classList.add('adm-body');
    var shell = document.querySelector('.adm-shell');
    if (!shell) return;

    var sidebar = buildSidebar();
    shell.insertBefore(sidebar, shell.firstChild);

    var overlay = document.createElement('div');
    overlay.className = 'adm-overlay';
    overlay.id = 'adm-overlay';
    var toggle = buildToggle();
    document.body.appendChild(toggle);
    document.body.appendChild(overlay);

    function open()  { sidebar.classList.add('open');    overlay.classList.add('open'); }
    function close() { sidebar.classList.remove('open'); overlay.classList.remove('open'); }

    toggle.addEventListener('click', function () {
      sidebar.classList.contains('open') ? close() : open();
    });
    overlay.addEventListener('click', close);
    sidebar.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', close); });

    var so = document.getElementById('adm-signout');
    if (so) so.addEventListener('click', function () { window.admin && window.admin.signOut(); });

    /* Reveal manager-only links once the role is known (hidden = UX only;
       RLS keeps the underlying data locked regardless). */
    document.addEventListener('admin:authed', async function () {
      if (!window.adminRoles) return;
      var manager = await window.adminRoles.isManager();
      if (!manager) return;
      sidebar.querySelectorAll('[data-manager-only]').forEach(function (a) { a.hidden = false; });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
