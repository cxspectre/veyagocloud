/* Browser half of task notifications — wraps the notify-task edge function.
 *
 * Events (mirrors notify-task/index.ts):
 *   'assigned'  (default) → assignee: "New task"
 *   'updated'             → assignee: "Task updated" (priority / due date changed)
 *   'done'                → creator:  "Task done"
 *   'blocked'             → creator:  "Task blocked"
 *
 * The function returns {ok, skipped?}. SILENT reasons are expected correct
 * outcomes — no UI feedback needed. Everything else surfaces a toast so the
 * caller knows the email did not go out. */
(function () {
  'use strict';

  /* Reasons that are the expected, correct outcome — nothing to tell anyone. */
  var SILENT = {
    'unassigned':    1,
    'self-assigned': 1,
    'already done':  1,
    'self-completed':1,  // you completed your own task — no point emailing yourself
    'self-blocked':  1,  // same
    'no creator':    1,  // legacy task with no created_by — nobody to tell
    'no recipients': 1,  // commenter is the only person on the task
    'no body':       1,  // guarded client-side, but harmless if edge function sees it
  };

  /* Fire and report. Never awaited into a save's success path: the task is
     already written by the time this runs, so a mail problem must not read as
     a failed save. Returns a promise for tests; callers may ignore it. */
  function notify(taskId, who, event) {
    var name = who || (event === 'done' || event === 'blocked' ? 'The task creator' : 'the assignee');
    return window.adminRoles.invokeFn('notify-task', { task_id: taskId, event: event || 'assigned' })
      .then(function (out) {
        if (out && out.ok && !out.skipped) return { emailed: true };
        var why = out && out.skipped;
        if (why && SILENT[why]) return { emailed: false, silent: true, reason: why };
        if (why === 'no email on file') {
          window.admin.toast(name + ' has no email on file — they were not notified', 'err');
        } else if (why === 'inactive') {
          window.admin.toast(name + ' is deactivated — they were not notified', 'err');
        } else if (why === 'email not configured') {
          window.admin.toast('Email is not configured, so ' + name + ' was not notified', 'err');
        } else if (why) {
          window.admin.toast(name + ' was not notified — ' + why, 'err');
        } else {
          window.admin.toast(name + ' could not be emailed', 'err');
        }
        return { emailed: false, reason: why || 'send failed' };
      })
      .catch(function (err) {
        window.admin.toast('Could not email ' + name + ' — ' + err.message, 'err');
        return { emailed: false, reason: err.message };
      });
  }

  /* Would a mail actually be attempted for this assignee? Used to label the
     create button honestly ("Create & notify Alex" vs plain "Create task")
     rather than promising an email the server will skip. Mirrors the
     function's own skip conditions, minus the ones only it can know. */
  function wouldNotify(employee, selfEmployee) {
    if (!employee) return false;                       // unassigned
    if (!employee.email) return false;                 // no email on file
    if (employee.status === 'inactive') return false;  // deactivated
    if (selfEmployee && employee.id === selfEmployee.id) return false; // your own
    return true;
  }

  window.adminTaskNotify = { notify: notify, wouldNotify: wouldNotify, SILENT: SILENT };
})();
