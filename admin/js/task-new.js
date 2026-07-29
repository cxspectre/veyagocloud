/* New task — the considered case, on its own screen.

   WHY THIS IS ONE PANEL AND NOT A STEPPED FLOW. member-new.js and
   invoice-new.js are stepped because each has a hidden prerequisite, an
   irreversible half-commit, or a document that leaves the building and cannot
   be recalled. A task has none of that: it is frequent, cheap, fully
   editable afterwards, and deleting one costs nothing. invoice-new.js's own
   header states the rule — "a task, a transaction ... stay single-panel on
   purpose". A three-step wizard for something someone does fifteen times a
   day would be a downgrade dressed as rigour.

   What IS worth taking seriously is the one part that does leave the
   building: assigning a task emails the assignee immediately, and the panel
   this replaced never said so. That is disclosed inline, under the field that
   causes it, and named on the button — so the email is visible before you
   commit rather than discovered afterwards.

   The board keeps a one-line quick-add for the everyday personal to-do, which
   assigns to you and therefore provably mails nobody. */
(function () {
  'use strict';

  var employees = [];
  var byId = {};
  var selfEmployee = null;
  var isManager = false;

  function $(id) { return document.getElementById(id); }

  /* Unhide first, then write — a hidden role="alert" is not in the
     accessibility tree, so writing then revealing announces nothing. */
  function setErr(text) {
    var el = $('form-err');
    el.hidden = !text;
    el.textContent = '';
    if (text) setTimeout(function () { el.textContent = text; }, 0);
  }

  function chosen() {
    var id = $('n-assignee').value;
    return id ? byId[id] : null;
  }

  /* The hint and the button label are the same judgement rendered twice: will
     this actually email someone? adminTaskNotify.wouldNotify mirrors
     notify-task's own skip conditions, so neither can promise a mail the
     server will quietly decline to send. */
  function syncNotice() {
    var who = chosen();
    var hint = $('n-assignee-hint');
    var btn = $('create-btn');

    if (!who) {
      hint.textContent = 'Nobody is emailed until this is assigned.';
      btn.textContent = 'Create task';
      return;
    }
    if (selfEmployee && who.id === selfEmployee.id) {
      hint.textContent = 'This one is yours — no email is sent.';
      btn.textContent = 'Create task';
      return;
    }
    if (!who.email) {
      hint.textContent = who.full_name + ' has no email on file, so they will not be notified.';
      btn.textContent = 'Create task';
      return;
    }
    hint.textContent = who.full_name + ' will be emailed as soon as you create this.';
    btn.textContent = 'Create & notify ' + who.full_name.split(/\s+/)[0];
  }

  async function create(ev) {
    ev.preventDefault();
    setErr('');

    var title = ($('n-title').value || '').trim();
    if (!title) { setErr('Give the task a title.'); $('n-title').focus(); return; }

    var btn = $('create-btn');
    btn.disabled = true;
    var was = btn.textContent;
    btn.textContent = 'Creating…';

    var who = chosen();
    var session = await window.admin.session();
    var res = await window.sb.from('tasks').insert({
      title: title,
      details: ($('n-details').value || '').trim() || null,
      assignee_id: $('n-assignee').value || null,
      priority: $('n-priority').value,
      due_date: $('n-due').value || null,
      created_by: session ? session.user.id : null
    }).select('id').single();

    if (res.error) {
      btn.disabled = false;
      btn.textContent = was;
      setErr('Could not create the task: ' + res.error.message);
      return;
    }

    window.admin.toast('Task created');

    /* Not awaited into the navigation: the task is already saved, and a mail
       problem must not read as a failed save. adminTaskNotify reports only
       the honest negatives — a delivery that worked is the expected state and
       needs no words. */
    if (who && res.data && res.data.id) {
      window.adminTaskNotify.notify(res.data.id, who.full_name);
    }

    /* Deliberately not re-enabling the button: assigning location.href only
       schedules the navigation, and re-arming Create for the unload window is
       long enough to insert the task twice. */
    window.location.href = '/admin/tasks';
  }

  async function load() {
    var perms = await window.adminRoles.resolve();
    isManager = perms.role === 'owner' || perms.role === 'admin';
    selfEmployee = perms.employee;

    /* email is selected so the disclosure can tell "will be emailed" from
       "has no email on file" — RLS already permits it (team.js reads it). */
    var emps = await window.sb.from('employees')
      .select('id,full_name,status,email').neq('status', 'inactive').order('full_name');
    if (emps.error) { setErr('Could not load the team: ' + emps.error.message); return; }
    employees = emps.data || [];
    byId = {};
    employees.forEach(function (e) { byId[e.id] = e; });

    var sel = $('n-assignee');
    sel.innerHTML = '<option value="">Unassigned</option>';
    employees.forEach(function (e) {
      var o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.full_name + (selfEmployee && e.id === selfEmployee.id ? ' (you)' : '');
      sel.appendChild(o);
    });

    /* A non-manager can only meaningfully give work to themselves — RLS lets
       them create, and the guard trigger stops them reassigning afterwards —
       so default them to their own name rather than to Unassigned. */
    if (!isManager && selfEmployee) sel.value = selfEmployee.id;

    syncNotice();
    sel.addEventListener('change', syncNotice);
    $('task-form').addEventListener('submit', create);
    $('n-title').focus();
  }

  window.adminReady.then(function (s) { if (s) load(); });
})();
