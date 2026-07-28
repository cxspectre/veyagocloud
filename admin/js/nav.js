/* Injects the admin sidebar into every admin page, handles the mobile toggle,
   highlights the active nav item, and wires sign-out. Must load after client.js. */
(function () {
  'use strict';

  var PATH = window.location.pathname;

  /* Detail screens are the second level of a section: a member belongs to Team,
     an article to Journal. They are not nav destinations — you arrive at one
     specific record, never at "members" in general — so they stay out of the
     list and light their parent instead. Without this the sidebar highlighted
     nothing on exactly the screens where you are deepest.

     Checklist, Transactions and Invoices are NOT here: they are destinations in
     their own right (Transactions and Invoices own every finance write), so
     they earn their own entries below and highlight themselves. */
  var PARENT = {
    article:       'journal',
    'apps-editor': 'apps',
    member:        'team',
    'member-new':  'team',
    task:          'tasks'
  };

  /* Resolve the current page to a canonical key for active-link matching.
     Clean URLs and .html both normalise to the extensionless form:
     /admin/, /admin/index.html, /admin/team.html, /admin/team all match. */
  function currentKey() {
    if (PATH === '/admin/' || PATH === '/admin/index.html' || PATH === '/admin/index' || PATH === '/admin') return '/admin/';
    var file = PATH.split('/').pop().replace(/\.html$/, '');
    if (!file) return '/admin/';
    return '/admin/' + (PARENT[file] || file);
  }
  var CURRENT = currentKey();

  /* Sidebar. `manager: true` hides the item from assistants and employees —
     cosmetic only; RLS is the real boundary and every such page also guards
     itself. Grouped by the job being done, not by which table it writes. */
  var NAV = [
    { label: 'Home',          href: '/admin/',               icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>' },
    { section: 'Content' },
    { label: 'Journal',       href: '/admin/journal',        icon: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/>' },
    { label: 'Wallpapers',    href: '/admin/wallpapers',     icon: '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 13l5-4 4 4 3-2 5 3"/>' },
    { label: 'Apps',          href: '/admin/apps',           icon: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>' },
    { label: 'Announcements', href: '/admin/announcements',  icon: '<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>' },
    /* The terminal step of the content job, so it sits last under Content —
       everything above it feeds it. `publisher` rather than `manager`: an
       assistant needs to reach this screen to ask for approval. */
    { label: 'Publish',       href: '/admin/publish',        icon: '<path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/>', publisher: true },
    { section: 'Company' },
    { label: 'Tasks',         href: '/admin/tasks',          icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
    { label: 'Team',          href: '/admin/team',           icon: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>' },
    { label: 'Onboarding',    href: '/admin/onboarding',     icon: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>' },
    /* The company-wide template. Editing it changes every employee's list, which
       is exactly why it should not be findable only through one small header
       button on a page about a single person. */
    { label: 'Checklist',     href: '/admin/checklist',      sub: true, manager: true },
    { label: 'Finance',       href: '/admin/finance',        icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>', manager: true },
    /* Finance itself is read-only by design (finance.js:1-6). These two own every
       finance write in the product and had no nav entry at all, so every mutation
       sat two clicks deep behind a screen that cannot perform it. */
    { label: 'Transactions',  href: '/admin/transactions',   sub: true, manager: true },
    { label: 'Invoices',      href: '/admin/invoices',       sub: true, manager: true }
  ];

  /* Footer links live under the user chip rather than in the main list. */
  var FOOT_NAV = [
    { label: 'Account',  href: '/admin/account' },
    { label: 'Settings', href: '/admin/settings', manager: true }
  ];

  /* There is no notification mechanism anywhere in this admin, so an approval
     could sit unseen indefinitely. A count on the nav item is the cheapest
     honest signal: no new dependency, visible from every screen. It is a
     snapshot at page load, not a live subscription — the email is what makes a
     request timely, this is what makes it recoverable when email is not
     configured. Managers only; nobody else can act on it. */
  async function badgePendingPublishes(sidebar) {
    var link = sidebar.querySelector('.adm-nav a[href="/admin/publish"]');
    if (!link || !window.sb) return;

    var res = await window.sb.from('publish_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    /* Before migration 0011 is applied this table does not exist. A missing
       badge is the right failure — silence, not an error in the chrome. */
    if (res.error || !res.count) return;

    var badge = document.createElement('span');
    badge.className = 'adm-nav-count';
    badge.textContent = String(res.count);
    /* The link's accessible name has to carry it too, or the count is
       decoration for anyone not looking at it. */
    link.setAttribute('aria-label', 'Publish, ' + res.count + ' waiting for approval');
    link.appendChild(badge);
  }

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
        /* Manager-only links render immediately when the cached role says
           manager (no flash); otherwise start hidden and reveal after the
           async role check. Cosmetic only — RLS guards the data. */
        var cachedRole = (window.adminRoles && window.adminRoles.cachedRole) ? window.adminRoles.cachedRole() : null;
        var cachedManager = cachedRole === 'owner' || cachedRole === 'admin';
        var cachedPublisher = cachedManager || cachedRole === 'assistant';
        /* Sub-items are indented under the item above and carry no icon — the
           indent is the relationship, and a second icon column would only
           compete with the parent's. */
        var classes = (item.sub ? 'adm-nav-sub' : '') + (cls ? (item.sub ? ' ' : '') + cls : '');
        var attrs = (classes ? ' class="' + classes + '"' : '') +
                    (cls ? ' aria-current="page"' : '') +
                    (item.manager ? ' data-manager-only' + (cachedManager ? '' : ' hidden') : '') +
                    (item.publisher ? ' data-publisher-only' + (cachedPublisher ? '' : ' hidden') : '');
        navHtml += '<a href="' + item.href + '"' + attrs + '>' +
          (item.sub ? '' : svgIcon(item.icon)) + item.label +
        '</a>';
      }
    });
    navHtml += '</nav>';

    var cachedRoleFoot = (window.adminRoles && window.adminRoles.cachedRole) ? window.adminRoles.cachedRole() : null;
    var cachedManagerFoot = cachedRoleFoot === 'owner' || cachedRoleFoot === 'admin';
    var footLinks = FOOT_NAV.map(function (item) {
      var cls = CURRENT === item.href.replace(/\/$/, '') ? ' active' : '';
      return '<a class="adm-foot-link' + cls + '" href="' + item.href + '"' +
        (item.manager ? ' data-manager-only' + (cachedManagerFoot ? '' : ' hidden') : '') +
        '>' + item.label + '</a>';
    }).join('');

    var footHtml =
      '<div class="adm-sidebar-foot">' +
        '<a class="adm-user" id="adm-user" href="/admin/account" hidden>' +
          '<div class="avatar" id="adm-user-avatar"></div>' +
          '<div style="min-width:0"><div class="adm-user-name" id="adm-user-name"></div>' +
          '<div class="adm-user-role" id="adm-user-role"></div></div>' +
        '</a>' +
        '<div class="adm-foot-links">' + footLinks + '</div>' +
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
       RLS keeps the underlying data locked regardless). adminReady is a
       promise, so this works no matter whether auth resolved before or after
       this code runs — unlike the admin:authed event, which we could miss. */
    if (window.adminReady && window.adminRoles) {
      window.adminReady.then(async function (session) {
        if (!session) return;
        var manager = await window.adminRoles.isManager();
        sidebar.querySelectorAll('[data-manager-only]').forEach(function (a) { a.hidden = !manager; });
        var publisher = await window.adminRoles.isPublisher();
        sidebar.querySelectorAll('[data-publisher-only]').forEach(function (a) { a.hidden = !publisher; });
        if (manager) badgePendingPublishes(sidebar);

        /* Signed-in identity chip above the sign-out button. */
        var r = await window.adminRoles.resolve();
        var chip = document.getElementById('adm-user');
        if (chip && r.role) {
          var name = (r.employee && r.employee.full_name) || session.user.email || 'Signed in';
          var colors = { owner: '#0071e3', admin: '#5856d6', assistant: '#ff9500', employee: '#86868b' };
          var av = document.getElementById('adm-user-avatar');
          av.textContent = name.trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
          av.style.background = colors[r.role] || '#86868b';
          document.getElementById('adm-user-name').textContent = name;
          document.getElementById('adm-user-role').textContent = r.role;
          chip.hidden = false;
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
