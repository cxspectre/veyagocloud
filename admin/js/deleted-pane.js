/* "Recently deleted" — the other half of soft delete.

   Migration 0012 made deleting content recoverable and left staff SELECT wide
   precisely so the admin could show what it removed and put it back. Four
   confirm dialogs then told the user "this can be undone" while nothing in the
   product could undo it. A promise in a dialog is still a promise.

   One component rather than four implementations: the four content screens
   differ only in table name and which column holds the title. That is the whole
   lesson of the design review this came out of — the admin had four empty-state
   treatments and two stat-card systems because each screen solved the same
   problem privately.

   Managers only. guard_soft_delete raises for anyone else, so a Restore button
   in front of staff would be a control the database refuses. */
(function () {
  'use strict';

  function when(iso) {
    if (!iso) return '';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (mins < 2880) return Math.round(mins / 60) + 'h ago';
    return Math.round(mins / 1440) + 'd ago';
  }

  /* opts.table     the content table
     opts.cols      columns to select (must include id and the title column)
     opts.titleOf   row -> display string
     opts.onRestore called after a successful restore, to reload the live list */
  function mount(root, opts) {
    if (!root || !opts || !opts.isManager) return null;

    var wrap = document.createElement('details');
    wrap.className = 'card-pane deleted-pane';
    wrap.style.marginTop = '16px';

    var summary = document.createElement('summary');
    summary.className = 'deleted-summary';
    summary.textContent = 'Recently deleted';
    wrap.appendChild(summary);

    var list = document.createElement('ul');
    list.className = 'adm-list';
    wrap.appendChild(list);

    var msg = document.createElement('p');
    msg.className = 'msg';
    wrap.appendChild(msg);

    root.appendChild(wrap);

    function setMsg(t, k) { msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

    async function load() {
      list.innerHTML = '<li class="skel skel-sm"></li>';
      var res = await window.sb.from(opts.table)
        .select(opts.cols + ',deleted_at')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })
        .limit(20);

      if (res.error) {
        /* Before 0012 is applied the column does not exist. Hide the pane
           rather than showing an error for a feature that is not live yet. */
        wrap.hidden = true;
        return;
      }

      var rows = res.data || [];
      /* Nothing deleted is the normal state — an empty disclosure that never
         says anything is just a thing to click. */
      wrap.hidden = !rows.length;
      summary.textContent = 'Recently deleted (' + rows.length + ')';

      list.innerHTML = '';
      rows.forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'adm-item';

        var main = document.createElement('div');
        main.className = 'adm-item-main';
        var t = document.createElement('div');
        t.className = 'adm-item-title';
        t.textContent = opts.titleOf(r) || '(untitled)';
        var s = document.createElement('div');
        s.className = 'adm-item-sub';
        s.textContent = 'deleted ' + when(r.deleted_at);
        main.appendChild(t); main.appendChild(s);

        var acts = document.createElement('div');
        acts.className = 'adm-item-acts';
        var btn = document.createElement('button');
        btn.className = 'btn btn-sm';
        btn.type = 'button';
        btn.textContent = 'Restore';
        btn.addEventListener('click', function () { restore(r, btn); });
        acts.appendChild(btn);

        li.appendChild(main); li.appendChild(acts);
        list.appendChild(li);
      });
    }

    async function restore(row, btn) {
      btn.disabled = true;
      setMsg('Restoring…');
      /* .select() so a zero-row result is distinguishable from a success —
         guard_soft_delete refuses non-managers, and PostgREST reports that as
         no rows rather than as an error. */
      var res = await window.sb.from(opts.table)
        .update({ deleted_at: null })
        .eq('id', row.id)
        .select('id');
      btn.disabled = false;

      if (res.error) { setMsg('Could not restore it: ' + res.error.message, 'err'); return; }
      if (!res.data || !res.data.length) {
        setMsg('That could not be restored — you may not have permission.', 'err');
        return;
      }
      setMsg('');
      window.admin.toast('Restored — it goes back on the site at the next publish');
      load();
      if (opts.onRestore) opts.onRestore();
    }

    load();
    return { reload: load };
  }

  window.adminDeletedPane = { mount: mount };
})();
