/* fixtures.js - the Cockpit demo's database: an invented studio and its
 * invented clients, shaped as the Supabase tables and RPCs queries.js reads.
 *
 * NOTHING HERE IS REAL. Every company, person, address and amount is made up
 * for the marketing screenshots (tools/capture-cockpit-shots.js); none is a
 * client, and none may be swapped for one. Domains end in .example so no
 * address can reach anybody.
 *
 * Dates are laid out around the moment the page opens - the agenda's week,
 * invoices due and overdue, the last twelve months of revenue - so a shot
 * taken on any day looks like a working Wednesday.
 */
(function () {
  'use strict';

  /* ── Clock ──────────────────────────────────────────────────────────── */

  var NOW = new Date();
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var dayKey = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var addDays = function (d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; };
  var TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  /* Monday of the week the agenda opens on: this one, or at the weekend the
     one about to start (agendaModel.startWeek). */
  var weekday = (TODAY.getDay() + 6) % 7;
  var MONDAY = weekday >= 5 ? addDays(TODAY, 7 - weekday) : addDays(TODAY, -weekday);

  /* A moment `days` from today at "HH:MM", local, as the ISO the database keeps. */
  function at(days, clock, base) {
    var parts = clock.split(':');
    var d = addDays(base || TODAY, days);
    d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
    return d.toISOString();
  }
  var ago = function (minutes) { return new Date(NOW.getTime() - minutes * 60000).toISOString(); };
  var date = function (days) { return dayKey(addDays(TODAY, days)); };

  var counter = 0;
  var uuid = function () { counter += 1; return '00000000-0000-4000-8000-' + String(counter).padStart(12, '0'); };

  /* ── The studio's people ────────────────────────────────────────────── */

  function person(name, role, title, email) {
    return {
      id: uuid(), user_id: uuid(), full_name: name, email: email, role: role, title: title,
      status: 'active', start_date: '2023-03-01', created_at: '2023-03-01T09:00:00Z', updated_at: ago(60 * 24 * 20)
    };
  }
  var ELENA = person('Elena Varga', 'owner', 'Managing director', 'elena@studio.example');
  var JONAS = person('Jonas Brandt', 'admin', 'Operations lead', 'jonas@studio.example');
  var AMARA = person('Amara Okafor', 'member', 'Product designer', 'amara@studio.example');
  var LUCAS = person('Lucas Moreau', 'member', 'Lead developer', 'lucas@studio.example');
  var SANNE = person('Sanne Vermeer', 'member', 'Client success', 'sanne@studio.example');
  var TEAM = [ELENA, JONAS, AMARA, LUCAS, SANNE];
  var ref = function (p) { return p ? { full_name: p.full_name } : null; };

  /* ── Companies and their people ─────────────────────────────────────── */

  function company(name, domain, kind, stage, value, number) {
    return {
      id: uuid(), name: name, domain: domain, kind: kind, stage: stage, value: value, currency: 'USD',
      owner_id: null, notes: '', client_number: number || null, deleted_at: null
    };
  }
  var HARBOR = company('Harborline Freight', 'harborline.example', 'client', 'client', 48000, 1012);
  var FERN = company('Fernhill Dental Group', 'fernhill-dental.example', 'client', 'client', 36500, 1015);
  var COPPER = company('Copperleaf Architects', 'copperleaf.example', 'client', 'client', 29000, 1018);
  var SALT = company('Saltmarsh Coffee Roasters', 'saltmarsh.example', 'client', 'client', 18400, 1021);
  var ALDER = company('Alder & Finch Legal', 'alderfinch.example', 'client', 'client', 22000, 1023);
  var KESTREL = company('Kestrel Physiotherapy', 'kestrelphysio.example', 'prospect', 'proposal', 16800);
  var TIDE = company('Tidewell Energy Advisors', 'tidewell.example', 'prospect', 'proposal', 42000);
  var OAK = company('Oakmere Property Group', 'oakmere.example', 'prospect', 'qualified', 31500);
  var BRIGHT = company('Brightfield Accountancy', 'brightfield.example', 'prospect', 'qualified', 12600);
  var MARLOW = company('Marlow Street Clinic', 'marlowclinic.example', 'prospect', 'lead', 9800);
  var LANTERN = company('Lantern Bay Hotels', 'lanternbay.example', 'prospect', 'lead', 54000);
  var NORTHCOTE = company('Northcote Bikes', 'northcote.example', 'client', 'dormant', 7400, 1009);
  var COMPANIES = [HARBOR, FERN, COPPER, SALT, ALDER, KESTREL, TIDE, OAK, BRIGHT, MARLOW, LANTERN, NORTHCOTE];
  [HARBOR, COPPER, TIDE, LANTERN, OAK].forEach(function (c) { c.owner_id = ELENA.id; });
  [FERN, SALT, KESTREL, MARLOW].forEach(function (c) { c.owner_id = SANNE.id; });
  [ALDER, BRIGHT, NORTHCOTE].forEach(function (c) { c.owner_id = JONAS.id; });

  function contact(name, co, title, email) {
    return {
      id: uuid(), full_name: name, email: email, phone: null, title: title, notes: '', is_primary: true,
      enquiry_id: null, deleted_at: null, company_id: co.id,
      company: { id: co.id, name: co.name, stage: co.stage, value: co.value, currency: 'USD' }
    };
  }
  var C = {
    rosa: contact('Rosa Delgado', HARBOR, 'Head of operations', 'rosa@harborline.example'),
    tom: contact('Tom Whitaker', HARBOR, 'IT manager', 'tom@harborline.example'),
    hannah: contact('Dr. Hannah Brooks', FERN, 'Practice owner', 'hannah@fernhill-dental.example'),
    mei: contact('Mei Lin', FERN, 'Office manager', 'mei@fernhill-dental.example'),
    oliver: contact('Oliver Grant', COPPER, 'Partner', 'oliver@copperleaf.example'),
    ines: contact('Inés Castillo', SALT, 'Founder', 'ines@saltmarsh.example'),
    david: contact('David Alder', ALDER, 'Managing partner', 'david@alderfinch.example'),
    priya: contact('Priya Nair', KESTREL, 'Clinic director', 'priya@kestrelphysio.example'),
    marcus: contact('Marcus Hale', TIDE, 'CEO', 'marcus@tidewell.example'),
    leah: contact('Leah Sorensen', OAK, 'Marketing lead', 'leah@oakmere.example'),
    ben: contact('Ben Carter', BRIGHT, 'Director', 'ben@brightfield.example'),
    naomi: contact('Naomi Fischer', MARLOW, 'Practice manager', 'naomi@marlowclinic.example'),
    arjun: contact('Arjun Mehta', LANTERN, 'Head of digital', 'arjun@lanternbay.example'),
    kai: contact('Kai Andersen', NORTHCOTE, 'Owner', 'kai@northcote.example')
  };
  var CONTACTS = Object.keys(C).map(function (k) { return C[k]; });

  /* ── Deals: the pipeline board ──────────────────────────────────────── */

  function deal(co, title, stage, value, owner, closeIn, outcome, closedDaysAgo) {
    return {
      id: uuid(), company_id: co.id, title: title, stage: stage, value: value, currency: 'USD',
      owner_id: owner.id, expected_close: closeIn == null ? null : date(closeIn),
      outcome: outcome || null, closed_at: outcome ? ago(60 * 24 * closedDaysAgo) : null,
      notes: '', created_at: ago(60 * 24 * (40 + counter)), deleted_at: null
    };
  }
  var DEALS = [
    deal(LANTERN, 'Booking site and guest app', 'lead', 54000, ELENA, 60),
    deal(MARLOW, 'Patient portal refresh', 'lead', 9800, SANNE, 45),
    deal(HARBOR, 'Driver onboarding app', 'lead', 22000, ELENA, 75),
    deal(OAK, 'Tenant portal', 'qualified', 31500, ELENA, 38),
    deal(BRIGHT, 'Website and client intake', 'qualified', 12600, JONAS, 30),
    deal(SALT, 'Wholesale ordering portal', 'qualified', 14200, SANNE, 52),
    deal(TIDE, 'Energy audit dashboard', 'proposal', 42000, ELENA, 14),
    deal(KESTREL, 'Online booking and new site', 'proposal', 16800, SANNE, 9),
    deal(FERN, 'Second-location launch site', 'proposal', 8900, SANNE, 21),
    deal(NORTHCOTE, 'Spring catalogue refresh', 'dormant', 4800, JONAS, null),
    deal(COPPER, 'Portfolio site rebuild', 'proposal', 29000, ELENA, 0, 'won', 12),
    deal(ALDER, 'Client document portal', 'proposal', 22000, JONAS, 0, 'won', 26),
    deal(FERN, 'Care plan subscriptions', 'qualified', 11500, SANNE, 0, 'won', 41),
    deal(NORTHCOTE, 'Webshop migration', 'proposal', 7400, JONAS, 0, 'lost', 33)
  ];

  /* ── Projects and their tasks ───────────────────────────────────────── */

  function project(name, co, code, accent, status, progress, dueIn, startedAgo, owner, description) {
    return {
      id: uuid(), name: name, company_id: co ? co.id : null, company_name: co ? co.name : null,
      code: code, accent: accent, status: status, progress: progress, due_on: date(dueIn),
      starts_on: date(-startedAgo), completed_at: status === 'completed' ? ago(60 * 24 * 6) : null,
      description: description, owner_id: owner.id, sort_order: 0, task_count: 0, tasks_done: 0, deleted_at: null
    };
  }
  var P = {
    harbor: project('Fleet tracking portal', HARBOR, 'HF', 'default', 'in_progress', 68, 24, 62, LUCAS,
      'Live shipment map and delivery windows for Harborline dispatchers and their customers.'),
    fern: project('Patient booking app', FERN, 'FD', 'travel', 'in_review', 86, 9, 88, AMARA,
      'Online booking, reminders and forms across Fernhill’s three practices.'),
    copper: project('Portfolio site rebuild', COPPER, 'CA', 'client', 'in_progress', 42, 38, 20, AMARA,
      'A calmer, image-led portfolio with a project archive the partners can update themselves.'),
    salt: project('Subscription webshop', SALT, 'SC', 'default', 'in_progress', 57, 17, 45, LUCAS,
      'Coffee subscriptions with pause, skip and gift options, on top of the existing shop.'),
    alder: project('Client document portal', ALDER, 'AF', 'client', 'discovery', 18, 64, 9, JONAS,
      'Secure uploads, signing and case updates for Alder & Finch’s private clients.'),
    site: project('Studio website refresh', null, 'V', 'travel', 'in_progress', 74, 12, 30, ELENA,
      'New case studies, a pricing page and faster pages across the studio’s own site.'),
    fernapp: project('Loyalty app for members', FERN, 'LA', 'default', 'on_hold', 30, 70, 50, AMARA,
      'A points card in the patient app. Paused until the second practice opens.'),
    northcote: project('Webshop migration', NORTHCOTE, 'NB', 'client', 'completed', 100, -8, 120, JONAS,
      'Moved the catalogue, orders and customer accounts to the new platform.')
  };
  var PROJECTS = Object.keys(P).map(function (k) { return P[k]; });

  var TASKS = [];
  function task(p, title, status, who, dueIn, priority) {
    var row = {
      id: uuid(), project_id: p.id, title: title, details: '', status: status, priority: priority || 'normal',
      due_date: dueIn == null ? null : date(dueIn), assignee_id: who ? who.id : null, created_by: ELENA.id,
      created_at: ago(60 * 24 * (30 - TASKS.length % 25)), completed_at: status === 'done' ? ago(60 * 24 * 3) : null,
      assignee: ref(who)
    };
    TASKS.push(row);
    p.task_count += 1;
    if (status === 'done') p.tasks_done += 1;
  }
  task(P.harbor, 'Discovery and route data audit', 'done', ELENA, -40);
  task(P.harbor, 'Dispatcher dashboard wireframes', 'done', AMARA, -30);
  task(P.harbor, 'Driver app data sync', 'done', LUCAS, -18);
  task(P.harbor, 'Map view with live vehicle positions', 'done', LUCAS, -10);
  task(P.harbor, 'Delivery window notifications', 'in_progress', LUCAS, 3, 'high');
  task(P.harbor, 'Dispatcher dashboard review with Rosa', 'todo', ELENA, 1, 'high');
  task(P.harbor, 'Customer tracking page', 'todo', AMARA, 8);
  task(P.fern, 'Practice calendars connected', 'done', LUCAS, -40);
  task(P.fern, 'Patient accounts and sign-in', 'done', LUCAS, -28);
  task(P.fern, 'Treatment picker design', 'done', AMARA, -20);
  task(P.fern, 'Booking flow usability test', 'done', AMARA, -6);
  task(P.fern, 'SMS reminder templates', 'done', SANNE, -4);
  task(P.fern, 'Sign-off on intake forms', 'in_progress', ELENA, 0, 'high');
  task(P.fern, 'App store listing and screenshots', 'todo', AMARA, 5);
  task(P.copper, 'Kickoff and site audit', 'done', ELENA, -18);
  task(P.copper, 'Moodboard and type pairing', 'done', AMARA, -8);
  task(P.copper, 'Photography brief', 'todo', AMARA, 12);
  task(P.copper, 'Project archive CMS model', 'in_progress', LUCAS, 6);
  task(P.copper, 'Homepage design, round two', 'todo', AMARA, 4);
  task(P.salt, 'Subscription plans and pricing', 'done', ELENA, -30);
  task(P.salt, 'Customer account area', 'done', LUCAS, -15);
  task(P.salt, 'Pause and skip logic', 'done', LUCAS, -5);
  task(P.salt, 'Gift subscription checkout', 'in_progress', LUCAS, 2, 'high');
  task(P.salt, 'Launch email to existing customers', 'todo', ELENA, 10);
  task(P.alder, 'Kickoff call', 'done', JONAS, -7);
  task(P.alder, 'Discovery workshop notes', 'in_progress', JONAS, 2);
  task(P.alder, 'Security requirements checklist', 'todo', ELENA, 6, 'high');
  task(P.site, 'Write the Fernhill case study', 'in_progress', ELENA, 1);
  task(P.site, 'Pricing page copy', 'todo', ELENA, 4);
  task(P.site, 'Image compression pass', 'done', LUCAS, -2);
  task(P.site, 'New case study template', 'done', AMARA, -9);
  task(P.site, 'Navigation and footer', 'done', LUCAS, -14);
  task(P.fernapp, 'Points rules draft', 'done', SANNE, -35);
  task(P.fernapp, 'Rewards screen design', 'blocked', AMARA, 20);
  task(P.northcote, 'Redirect map for old product URLs', 'done', LUCAS, -12);

  /* ── Support tickets ────────────────────────────────────────────────── */

  var TICKETS = [];
  function ticket(n, subject, co, who, product, priority, status, owner, hoursAgo, messages) {
    var created = ago(hoursAgo * 60);
    var thread = [];
    for (var i = 0; i < messages; i++) {
      thread.push({
        id: uuid(), direction: i % 2 ? 'outbound' : 'inbound',
        created_at: new Date(Date.parse(created) + i * 45 * 60000).toISOString(),
        delivered_at: i % 2 ? created : null, delivery_error: null
      });
    }
    TICKETS.push({
      id: uuid(), number: n, subject: subject, product: product, priority: priority, status: status, source: 'email',
      created_at: created, updated_at: created, first_response_at: messages > 1 ? created : null,
      resolved_at: status === 'resolved' || status === 'closed' ? ago(hoursAgo * 30) : null,
      first_response_due_at: null, resolve_due_at: null, project_id: null, company_id: co.id,
      contact_id: who.id, assignee_id: owner ? owner.id : null, merged_into_id: null,
      requester_name: who.full_name, requester_email: who.email, deleted_at: null,
      contact: { full_name: who.full_name, email: who.email },
      company: { name: co.name, client_number: co.client_number },
      assignee: ref(owner), ticket_messages: thread
    });
  }
  ticket(1187, 'Reminder texts sending twice to some patients', FERN, C.mei, 'Patient booking app', 'urgent', 'in_progress', LUCAS, 3, 3);
  ticket(1186, 'Tracking page slow for customers on mobile', HARBOR, C.tom, 'Fleet tracking portal', 'high', 'open', LUCAS, 5, 1);
  ticket(1185, 'Add a second admin account for the new office', FERN, C.hannah, 'Patient booking app', 'normal', 'open', ELENA, 9, 1);
  ticket(1184, 'Gift card code not applying at checkout', SALT, C.ines, 'Subscription webshop', 'high', 'waiting', LUCAS, 20, 4);
  ticket(1183, 'Update team photos on the About page', COPPER, C.oliver, 'Website', 'low', 'open', AMARA, 26, 1);
  ticket(1182, 'Invoice PDF missing VAT number', ALDER, C.david, 'Hosting and care', 'normal', 'in_progress', JONAS, 30, 2);
  ticket(1181, 'Export of last quarter’s deliveries', HARBOR, C.rosa, 'Fleet tracking portal', 'normal', 'waiting', ELENA, 44, 3);
  ticket(1180, 'Contact form emails going to spam', COPPER, C.oliver, 'Website', 'high', 'resolved', LUCAS, 70, 4);
  ticket(1179, 'New opening hours for the holidays', SALT, C.ines, 'Website', 'low', 'resolved', SANNE, 96, 2);
  ticket(1178, 'SSL renewal warning in the admin', ALDER, C.david, 'Hosting and care', 'normal', 'closed', JONAS, 140, 2);
  ticket(1177, 'Booking confirmation shows the wrong practice', FERN, C.mei, 'Patient booking app', 'high', 'resolved', LUCAS, 170, 5);
  ticket(1176, 'Driver app login loop after update', HARBOR, C.tom, 'Fleet tracking portal', 'urgent', 'closed', LUCAS, 220, 6);

  /* ── The agenda: two busy weeks around today ────────────────────────── */

  var EVENTS = [];
  function event(day, start, end, title, kind, detail, extra) {
    var e = extra || {};
    EVENTS.push({
      id: uuid(), title: title, detail: detail || '', location: e.location || '',
      starts_at: e.allDay ? dayKey(addDays(MONDAY, day)) + 'T00:00:00Z' : at(day, start, MONDAY),
      ends_at: e.allDay ? dayKey(addDays(MONDAY, day + 1)) + 'T00:00:00Z' : at(day, end, MONDAY),
      all_day: Boolean(e.allDay), kind: kind, status: 'confirmed',
      project_id: e.project ? e.project.id : null, company_id: e.company ? e.company.id : null,
      contact_id: null, updated_at: ago(600), connection_id: null, calendar_id: null, created_by: ELENA.id,
      organizer_name: ELENA.full_name, organizer_email: ELENA.email, meeting_url: e.video ? 'https://meet.example/' + counter : null,
      time_zone: null, recurrence_type: e.weekly ? 'weekly' : null, series_master_id: null, recurrence_summary: e.weekly ? 'Every week' : null,
      reminder_on: true, reminder_minutes: 10, time_zone_iana: null, response_status: 'accepted', is_organizer: true,
      attendees: []
    });
  }
  for (var w = 0; w < 14; w += 7) {
    event(w + 0, '09:00', '09:30', 'Monday planning', 'team', 'The week’s priorities, all hands', { weekly: true, video: true });
    event(w + 0, '10:30', '11:30', 'Harborline sprint review', 'client', 'Fleet tracking portal · demo', { project: P.harbor, company: HARBOR, video: true });
    event(w + 0, '14:00', '16:00', 'Design focus: Copperleaf homepage', 'focus', 'Round two layouts', { project: P.copper });
    event(w + 1, '09:30', '10:15', 'Fernhill intake forms sign-off', 'client', 'With Dr. Hannah Brooks', { project: P.fern, company: FERN, video: true });
    event(w + 1, '11:00', '12:00', 'Tidewell proposal walkthrough', 'client', 'Energy audit dashboard · $42k', { company: TIDE, video: true });
    event(w + 1, '15:30', '16:00', 'Weekly finance check-in', 'internal', 'Invoices, cash and pipeline');
    event(w + 2, '09:00', '09:15', 'Stand-up', 'team', 'Daily', { video: true });
    event(w + 2, '10:00', '11:00', 'Kestrel Physio discovery call', 'client', 'Online booking and new site', { company: KESTREL, video: true });
    event(w + 2, '12:30', '13:30', 'Lunch with Saltmarsh', 'client', 'Launch plan for subscriptions', { company: SALT, location: 'Saltmarsh roastery' });
    event(w + 2, '14:00', '15:30', 'Build: gift checkout', 'focus', 'Subscription webshop', { project: P.salt });
    event(w + 2, '16:00', '16:45', 'Portfolio review with Amara', 'internal', 'Case study picks');
    event(w + 3, '09:00', '09:15', 'Stand-up', 'team', 'Daily', { video: true });
    event(w + 3, '10:00', '11:30', 'Alder & Finch workshop', 'client', 'Document portal discovery', { project: P.alder, company: ALDER, location: 'Their office, 4th floor' });
    event(w + 3, '13:00', '14:00', 'Oakmere intro', 'client', 'Tenant portal · qualified', { company: OAK, video: true });
    event(w + 3, '15:00', '17:00', 'Writing: Fernhill case study', 'focus', 'Studio website refresh', { project: P.site });
    event(w + 4, '09:00', '09:15', 'Stand-up', 'team', 'Daily', { video: true });
    event(w + 4, '10:00', '10:45', 'Design crit', 'team', 'Show the week’s work');
    event(w + 4, '11:30', '12:15', 'Brightfield follow-up', 'client', 'Website and client intake', { company: BRIGHT, video: true });
    event(w + 4, '16:00', '17:00', 'Studio drinks', 'personal', 'Friday wind-down');
  }

  /* ── Money ──────────────────────────────────────────────────────────── */

  var INVOICES = [];
  function invoice(num, co, who, amount, status, issuedAgo, dueIn, notes, lines) {
    var tax = Math.round(amount * 0.08 * 100) / 100;
    INVOICES.push({
      id: uuid(), number: num, client: co.name, client_email: who.email, amount: amount, currency: 'USD',
      status: status, issued_on: status === 'draft' ? null : date(-issuedAgo), due_on: date(dueIn),
      paid_on: status === 'paid' ? date(Math.min(dueIn - 3, -1)) : null, notes: notes, updated_at: ago(60 * 24),
      tax_rate: 8, tax_amount: tax, company_id: co.id, company: { client_number: co.client_number },
      sort_order: 0,
      finance_invoice_lines: (lines || [[notes, 1, amount]]).map(function (l, i) {
        return { id: uuid(), description: l[0], quantity: l[1], unit_amount: l[2], amount: l[1] * l[2], sort_order: i };
      })
    });
  }
  invoice('INV-2026-094', HARBOR, C.rosa, 14500, 'sent', 6, 24, 'Fleet tracking portal · milestone 3',
    [['Milestone 3: live map and notifications', 1, 12500], ['Design support', 16, 125]]);
  invoice('INV-2026-093', FERN, C.hannah, 9800, 'sent', 9, 5, 'Patient booking app · milestone 4');
  invoice('INV-2026-092', SALT, C.ines, 6200, 'overdue', 38, -8, 'Subscription webshop · milestone 2');
  invoice('INV-2026-091', ALDER, C.david, 4400, 'sent', 12, 18, 'Document portal · discovery phase');
  invoice('INV-2026-090', COPPER, C.oliver, 7250, 'overdue', 44, -14, 'Portfolio site · kickoff deposit');
  invoice('INV-2026-089', HARBOR, C.rosa, 12500, 'paid', 30, 0, 'Fleet tracking portal · milestone 2');
  invoice('INV-2026-088', FERN, C.hannah, 1450, 'paid', 22, 8, 'Hosting and care · September');
  invoice('INV-2026-087', ALDER, C.david, 890, 'paid', 25, 5, 'Hosting and care · September');
  invoice('INV-2026-086', FERN, C.hannah, 9800, 'paid', 40, -10, 'Patient booking app · milestone 3');
  invoice('INV-2026-085', NORTHCOTE, C.kai, 7400, 'paid', 52, -22, 'Webshop migration · final');
  invoice('INV-2026-084', SALT, C.ines, 6200, 'paid', 64, -34, 'Subscription webshop · milestone 1');
  invoice('INV-2026-095', KESTREL, C.priya, 3200, 'draft', 0, 30, 'Discovery sprint · booking and site');

  /* The bank feed behind Finance's recent transactions: payments in from the
     paid invoices above, and the studio's own running costs going out. */
  var TRANSACTIONS = [];
  function tx(daysAgo, description, counterparty, amount, kind) {
    TRANSACTIONS.push({
      id: uuid(), posted_at: date(-daysAgo), description: description, counterparty: counterparty,
      amount: amount, currency: 'USD', status: 'posted', source: 'bank', kind: kind
    });
  }
  tx(1, 'Invoice INV-2026-089', HARBOR.name, 12500, 'income');
  tx(2, 'Contractor: illustration', 'Freelance illustrator', -1800, 'expense');
  tx(3, 'Invoice INV-2026-088', FERN.name, 1450, 'income');
  tx(4, 'Cloud hosting', 'Hosting provider', -612, 'software');
  tx(6, 'Invoice INV-2026-087', ALDER.name, 890, 'income');
  tx(8, 'Payroll', 'Studio payroll', -18400, 'payroll');
  tx(9, 'Care plan retainer', HARBOR.name, 2400, 'income');
  tx(11, 'Studio rent', 'Canal Works Property', -3200, 'rent');
  tx(13, 'Invoice INV-2026-086', FERN.name, 9800, 'income');
  tx(15, 'Design and dev tools', 'Software subscriptions', -486, 'software');

  /* Twelve months of income and spending, the latest month so far. */
  var REVENUE = [28400, 31800, 27900, 30600, 32900, 34100, 33800, 37600, 41200, 39800, 45600, 52400];
  var EXPENSES = [22400, 23100, 24800, 22900, 25200, 26100, 25400, 27300, 26800, 28900, 29400, 27600];
  var SERIES = REVENUE.map(function (revenue, i) {
    var d = new Date(TODAY.getFullYear(), TODAY.getMonth() - (REVENUE.length - 1 - i), 1);
    return { month: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01', revenue: revenue, expenses: EXPENSES[i], currency: 'USD' };
  });
  var MIX = [
    { category: 'Websites', amount: 21800, currency: 'USD' },
    { category: 'Retainers', amount: 14600, currency: 'USD' },
    { category: 'Apps', amount: 9400, currency: 'USD' },
    { category: 'Hosting', amount: 3900, currency: 'USD' },
    { category: 'Consulting', amount: 2700, currency: 'USD' }
  ];

  /* The Overview tiles, counted from the rows above so no two numbers on a
     page disagree. */
  var awaiting = INVOICES.filter(function (v) { return v.status === 'sent' || v.status === 'overdue'; });
  var prevThrough = new Date(TODAY.getFullYear(), TODAY.getMonth() - 1, Math.min(TODAY.getDate(), 28));
  var OVERVIEW = {
    revenue_month: REVENUE[REVENUE.length - 1],
    revenue_prev_month: 44850,
    revenue_prev_through: dayKey(prevThrough),
    revenue_currency: 'USD',
    revenue_by_currency: [{ currency: 'USD', month: REVENUE[REVENUE.length - 1] }],
    tickets_open: TICKETS.filter(function (t) { return ['open', 'in_progress', 'waiting'].indexOf(t.status) !== -1; }).length,
    tickets_high: TICKETS.filter(function (t) {
      return ['open', 'in_progress', 'waiting'].indexOf(t.status) !== -1 && ['high', 'urgent'].indexOf(t.priority) !== -1;
    }).length,
    projects_active: PROJECTS.filter(function (p) { return ['completed', 'cancelled'].indexOf(p.status) === -1; }).length,
    tasks_mine: TASKS.filter(function (t) { return t.assignee_id === ELENA.id && t.status !== 'done'; }).length,
    events_today: null,
    invoices_outstanding: {
      count: awaiting.length,
      amount: awaiting.reduce(function (sum, v) { return sum + v.amount; }, 0),
      currency: 'USD',
      due_next: awaiting.map(function (v) { return v.due_on; }).sort()[0],
      by_currency: [{ currency: 'USD', count: awaiting.length }]
    }
  };

  /* ── What happened lately ───────────────────────────────────────────── */

  var ACTIVITY = [];
  function activity(minutesAgo, who, verb, type, entity, summary) {
    ACTIVITY.push({
      id: uuid(), verb: verb, entity_type: type, entity_id: entity ? entity.id : null, summary: summary,
      created_at: ago(minutesAgo), actor: ref(who), project_id: type === 'project' && entity ? entity.id : null
    });
  }
  activity(12, LUCAS, 'updated', 'ticket', TICKETS[0], 'Moved #1187 “Reminder texts sending twice” to In progress');
  activity(38, ELENA, 'created', 'invoice', INVOICES[0], 'Sent invoice INV-2026-094 to Harborline Freight · $14,500');
  activity(95, AMARA, 'completed', 'project', P.fern, 'Finished “SMS reminder templates” on Patient booking app');
  activity(160, SANNE, 'updated', 'company', KESTREL, 'Moved Kestrel Physiotherapy to Proposal');
  activity(240, JONAS, 'created', 'project', P.alder, 'Started Client document portal for Alder & Finch Legal');
  activity(60 * 20, LUCAS, 'updated', 'ticket', TICKETS[7], 'Resolved #1180 “Contact form emails going to spam”');
  activity(60 * 26, ELENA, 'created', 'contact', C.arjun, 'Added Arjun Mehta at Lantern Bay Hotels');
  activity(60 * 30, SANNE, 'updated', 'invoice', INVOICES[6], 'Marked INV-2026-088 as paid');

  var NOTES = [
    { id: uuid(), entity_type: 'project', entity_id: P.harbor.id, body: 'Rosa wants the delivery windows in 30-minute slots, not hourly.',
      created_at: ago(60 * 26), author_id: ELENA.id, author: ref(ELENA) },
    { id: uuid(), entity_type: 'company', entity_id: TIDE.id, body: 'Decision by the board on the 15th. Marcus is the champion.',
      created_at: ago(60 * 50), author_id: ELENA.id, author: ref(ELENA) }
  ];

  /* ── Mail: enough for the nav badge and a believable inbox ──────────── */

  var MAILBOX = {
    id: uuid(), provider: 'microsoft_mail', account_label: 'hello@studio.example', employee_id: null,
    employee_name: null, status: 'connected', is_live: true, last_synced_at: ago(2), last_error: null
  };
  var CALENDAR = {
    id: uuid(), provider: 'microsoft_calendar', account_label: 'Studio calendar', employee_id: null,
    employee_name: null, status: 'connected', is_live: true, last_synced_at: ago(4), last_error: null
  };
  var THREADS = [];
  function thread(who, co, subject, snippet, minutesAgo, unread) {
    THREADS.push({
      id: uuid(), connection_id: MAILBOX.id, subject: subject, snippet: snippet, folder: 'inbox',
      is_read: !unread, is_starred: false, message_count: 2, last_message_at: ago(minutesAgo),
      other_party_name: who.full_name, other_party_email: who.email, ticket_id: null, contact_id: who.id,
      contact: { full_name: who.full_name, email: who.email }, company_id: co.id,
      company: { name: co.name, client_number: co.client_number }
    });
  }
  thread(C.marcus, TIDE, 'Re: Energy audit dashboard proposal', 'Thanks for the walkthrough - two questions on phasing before the board meets.', 25, true);
  thread(C.hannah, FERN, 'Intake forms look great', 'We tried them with two patients this morning and both finished in under three minutes.', 70, true);
  thread(C.rosa, HARBOR, 'Delivery windows', 'Could we show 30-minute slots instead of hourly ones?', 140, true);
  thread(C.priya, KESTREL, 'Following up on our call', 'Attaching the list of treatments we would like bookable online.', 300, false);
  thread(C.ines, SALT, 'Launch date for subscriptions', 'We would love to go live before the holiday rush if we can.', 60 * 22, false);

  /* ── The shapes queries.js reads ────────────────────────────────────── */

  window.COCKPIT_DEMO = {
    me: ELENA,
    tables: {
      employees: TEAM,
      crm_companies: COMPANIES,
      crm_contacts: CONTACTS,
      crm_deals: DEALS,
      client_project_progress: PROJECTS,
      client_projects: [],
      tasks: TASKS,
      support_tickets: TICKETS,
      calendar_events: EVENTS,
      finance_invoices: INVOICES,
      finance_transactions: TRANSACTIONS,
      workspace_activity: ACTIVITY,
      workspace_notes: NOTES,
      project_members: PROJECTS.map(function (p) { return { project_id: p.id, employee_id: p.owner_id, created_at: p.starts_on }; }),
      project_contacts: [],
      project_files: [],
      project_budgets: [],
      integration_status: [MAILBOX, CALENDAR],
      mail_threads: THREADS,
      mail_messages: [],
      mail_signatures: [],
      notification_dismissals: [],
      website_enquiries: []
    },
    rpc: {
      workspace_overview: OVERVIEW,
      revenue_series: SERIES,
      revenue_mix: MIX,
      studio_profile: [],
      employee_private: [],
      mail_unread_counts: [{ connection_id: MAILBOX.id, unread_count: 3 }],
      search_mail: [],
      search_events: []
    }
  };
})();
