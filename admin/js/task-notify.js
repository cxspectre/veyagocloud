/* Telling someone a task landed on their plate — the browser half of it.

   notify-task's own header says it is "called by the browser after a task is
   created or reassigned". Only the first half was true: tasks.js fired it on
   create, and task.js — the page where a manager deliberately hands work to a
   named person — never called it at all. Reassigning a task notified nobody,
   silently, and had done since the function was written.

   Shared here rather than fixed twice, because the interesting part is not the
   call, it is reading the ANSWER correctly. The function returns 200 with
   {ok:true, skipped:'<reason>'} for the five cases where no mail should go
   (unassigned, already done, no email on file, inactive, self-assigned) and
   {ok:false} with no `skipped` when Resend actually refused. Treating "the
   promise resolved" as "they were emailed" would report a delivery that never
   happened — the exact failure member.js:463 already avoids for invites. */
(function () {
  'use strict';

  /* Reasons that are the expected, correct outcome — nothing to tell anyone. */
  var SILENT = { 'unassigned': 1, 'self-assigned': 1, 'already done': 1 };

  /* Fire and report. Never awaited into a save's success path: the task is
     already written by the time this runs, so a mail problem must not read as
     a failed save. Returns a promise for tests; callers may ignore it. */
  function notify(taskId, who) {
    var name = who || 'the assignee';
    return window.adminRoles.invokeFn('notify-task', { task_id: taskId })
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
