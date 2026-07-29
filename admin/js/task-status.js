/* The one status machine for tasks, shared by the board (tasks.js) and the
   single-task page (task.js).

   These maps used to be declared separately in both files, and they had
   already drifted: task.js carried `done: 'todo'` so a finished task could be
   reopened from its own page, tasks.js did not, so the board could complete a
   task and then had no way to un-complete it. Nobody chose that — it is just
   what happens when the same four-state machine is written down twice.

   The states themselves are fixed by the database, not by us: 0005's CHECK
   constraint on tasks.status allows exactly todo / in_progress / blocked /
   done, so anything added here without a migration is a write that fails. */
(function () {
  'use strict';

  var LABEL = {
    todo: 'To do',
    in_progress: 'In progress',
    blocked: 'Blocked',
    done: 'Done'
  };

  var BADGE = {
    todo: 'badge-neutral',
    in_progress: 'badge-info',
    blocked: 'badge-warn',
    done: 'badge-success'
  };

  /* The one forward move each state offers, and what to call it. `done` maps
     back to `todo` on purpose: finishing something is the most likely thing to
     do by mistake, so undoing it has to be reachable from wherever it was
     done — which now includes the board. */
  var NEXT = {
    todo: 'in_progress',
    in_progress: 'done',
    blocked: 'in_progress',
    done: 'todo'
  };

  var NEXT_LABEL = {
    todo: 'Start',
    in_progress: 'Complete',
    blocked: 'Unblock',
    done: 'Reopen'
  };

  /* Priority. Only urgent and high used to be visible at all — as a 3px edge
     tint and nothing else — so `low` and `normal` were indistinguishable and
     the level never survived a glance. Every level now has a name and a
     token; whether a given surface shows a badge is its own decision. */
  var PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
  var PRIORITY_BADGE = { urgent: 'badge-danger', high: 'badge-warn' };
  /* Sort weight, highest first. The board orders by due date, which is right —
     this is the tiebreak within a due-date bucket, so an urgent task does not
     sit below a low one that happens to have been created earlier. */
  var PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

  window.adminTaskStatus = {
    LABEL: LABEL,
    BADGE: BADGE,
    NEXT: NEXT,
    NEXT_LABEL: NEXT_LABEL,
    PRIORITY_LABEL: PRIORITY_LABEL,
    PRIORITY_BADGE: PRIORITY_BADGE,
    PRIORITY_RANK: PRIORITY_RANK,

    label: function (s) { return LABEL[s] || s; },
    badge: function (s) { return BADGE[s] || 'badge-neutral'; },
    next: function (s) { return NEXT[s] || null; },
    nextLabel: function (s) { return NEXT_LABEL[s] || null; },
    priorityRank: function (p) {
      /* Unknown priorities sort with 'normal' rather than to an end — an
         unrecognised value is not evidence of urgency in either direction. */
      return PRIORITY_RANK[p] === undefined ? PRIORITY_RANK.normal : PRIORITY_RANK[p];
    },

    /* What a status change is called once it has happened. */
    movedToast: function (s) {
      return {
        todo: 'Task reopened',
        in_progress: 'Task started',
        blocked: 'Task blocked',
        done: 'Task completed'
      }[s] || 'Task updated';
    }
  };
})();
