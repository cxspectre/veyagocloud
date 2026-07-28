/* Unsaved-work protection shared by the two WYSIWYG editors (article, apps-editor).
   Load after client.js and before the editor's own controller.

   Both editors are manual-save-only: a 700-line canvas whose single commit point
   is a button. Nothing here changes that model — it makes losing the work between
   commits hard instead of silent.

   WHY A LOCAL MIRROR RATHER THAN SERVER AUTOSAVE. The content tables carry no
   version column and no authorship (supabase/migrations/0001_init.sql), so every
   write is last-write-wins with nothing to attribute or restore from. Autosaving
   to Postgres would add a second concurrent writer to a table that cannot detect
   a conflict, and would mutate an already-published row between deploys. A
   localStorage mirror protects the same keystrokes — it survives a token expiry,
   a crash, a stray click and a closed tab — and adds no new writer. Server
   autosave is the right feature once rows carry a version; it is not this change.

   Four guards, cheapest first:
     1. a local mirror written ~1s after you stop typing
     2. beforeunload, so closing the tab or reloading asks
     3. in-page link interception, so the 15 one-click exits ask
     4. Cmd/Ctrl+S, so the habit works
   Plus a recovery offer on load when a mirror is newer than the stored row. */
(function () {
  'use strict';

  var PREFIX    = 'veyago.admin.draft.';
  var MIRROR_MS = 1000;
  /* Allowance for browser-vs-database clock drift when judging a mirror stale. */
  var SKEW_MS   = 5 * 60 * 1000;

  function ago(ts) {
    var secs = Math.round((Date.now() - ts) / 1000);
    if (secs < 45) return 'moments ago';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
    return new Date(ts).toLocaleString();
  }

  /* Create a guard for one editor.

     opts.kind      string   storage namespace, e.g. 'article'
     opts.root      Element  container whose input/change events mean "edited"
     opts.snapshot  fn       () -> plain serialisable object of editable state
     opts.restore   fn       (payload) -> void, applies a recovered mirror
     opts.recordId  fn       () -> current row id, or null before the first save
     opts.rowStamp  fn       () -> ISO string the stored row was last updated, or null
     opts.save      fn       (publish) -> Promise, the editor's existing save
     opts.status    Element  where save state is rendered
     opts.publishHref string link offered once something is saved but not deployed */
  function create(opts) {
    var dirty       = false;
    var mirrorTimer = null;
    var lastKey     = null;

    function key() { return PREFIX + opts.kind + '.' + (opts.recordId() || 'new'); }

    /* ── Status line ───────────────────────────────────────────────────
       Text is set through textContent because callers interpolate raw
       Supabase error strings into it. The one HTML case is a static link. */
    function render(text, kind) {
      if (!opts.status) return;
      opts.status.textContent = text || '';
      opts.status.className = 'ae-save-hint' + (kind ? ' ' + kind : '');
    }

    /* Saved-but-not-deployed is the only state that carries a link. Kept short
       because .ae-save-hint sits in a nowrap topbar slot. */
    function renderSaved(verb) {
      if (!opts.status) return;
      opts.status.className = 'ae-save-hint ok';
      opts.status.textContent = verb + ' · not live yet · ';
      var a = document.createElement('a');
      a.href = opts.publishHref || '/admin/settings';
      a.textContent = 'Publish →';
      opts.status.appendChild(a);
    }

    /* ── The mirror ────────────────────────────────────────────────── */
    function writeMirror() {
      try {
        var k = key();
        /* A new row gets its id on first save; drop the pre-id mirror so a
           recovered draft cannot resurface against the wrong record. */
        if (lastKey && lastKey !== k) localStorage.removeItem(lastKey);
        lastKey = k;
        localStorage.setItem(k, JSON.stringify({ savedAt: Date.now(), payload: opts.snapshot() }));
      } catch (e) {
        /* Quota, private mode, or a snapshot that will not serialise. The other
           three guards still apply, so fail quiet rather than block typing. */
      }
    }

    function clearMirror() {
      try {
        localStorage.removeItem(key());
        if (lastKey) localStorage.removeItem(lastKey);
      } catch (e) {}
      lastKey = null;
    }

    function readMirror() {
      try {
        var raw = localStorage.getItem(key());
        if (!raw) return null;
        var m = JSON.parse(raw);
        return (m && m.payload && m.savedAt) ? m : null;
      } catch (e) { return null; }
    }

    /* ── Dirty tracking ───────────────────────────────────────────────
       Delegated at the container so it survives every canvas re-render,
       and covers contenteditable, inputs, selects and textareas alike. */
    function markDirty() {
      dirty = true;
      render('Unsaved changes');
      clearTimeout(mirrorTimer);
      mirrorTimer = setTimeout(writeMirror, MIRROR_MS);
    }

    function markClean(verb) {
      dirty = false;
      clearTimeout(mirrorTimer);
      clearMirror();
      lastKey = key();
      if (verb) renderSaved(verb);
    }

    if (opts.root) {
      opts.root.addEventListener('input', markDirty, true);
      opts.root.addEventListener('change', markDirty, true);
    }

    /* ── Guard 2: the tab ─────────────────────────────────────────── */
    window.addEventListener('beforeunload', function (e) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';   // required by Chrome/Safari to show the prompt
      return '';
    });

    /* ── Guard 3: in-page links ───────────────────────────────────────
       The editors put a back link in the topbar and the sidebar injects
       nine more. Any of them is one click from discarding the draft, and
       beforeunload does not fire reliably for same-document navigations
       started by script, so intercept the click itself.

       Once the user accepts, dirty is cleared before the click proceeds.
       The mirror is already on disk, and leaving dirty set would hand the
       same decision straight to beforeunload — two dialogs, different
       wording, for one intentional exit. */
    function confirmLeave(e, question) {
      if (window.confirm(question)) { dirty = false; return; }
      e.preventDefault();
      e.stopPropagation();
    }

    document.addEventListener('click', function (e) {
      if (!dirty) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      if (a.target === '_blank' || a.hasAttribute('download')) return;
      var href = a.getAttribute('href') || '';
      if (href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
      /* Anchors inside the preview canvas are content being edited, not exits —
         clicking into a linked word to reword it must not raise a leave prompt. */
      if (a.closest('.ae-canvas, .ape-canvas, [contenteditable]')) return;
      confirmLeave(e, 'You have unsaved changes.\n\nLeave this page and discard them?');
    }, true);

    /* Sign out is a button, not a link, so it needs its own hook. */
    document.addEventListener('click', function (e) {
      if (!dirty) return;
      var b = e.target && e.target.closest ? e.target.closest('#adm-signout') : null;
      if (!b) return;
      confirmLeave(e, 'You have unsaved changes.\n\nSign out and discard them?');
    }, true);

    /* ── Guard 4: Cmd/Ctrl+S ────────────────────────────────────────
       preventDefault is unconditional so the browser's "Save Page As…"
       never opens over the editor. The in-flight lock matters most before
       the first save: until the insert resolves the record has no id, so a
       second save() would take the insert branch again and create a
       duplicate row. Key auto-repeat makes that trivial to trigger. */
    var saving = false;

    document.addEventListener('keydown', function (e) {
      if (!(e.metaKey || e.ctrlKey) || (e.key !== 's' && e.key !== 'S')) return;
      e.preventDefault();
      if (e.repeat || saving || !dirty) return;
      /* Call save synchronously — deferring it into a microtask would only
         widen the window this lock exists to close. */
      saving = true;
      var running;
      try {
        running = opts.save(false);
      } catch (err) {
        saving = false;
        throw err;
      }
      Promise.resolve(running)
        .catch(function () { /* the editor renders its own save errors */ })
        .then(function () { saving = false; });
    });

    /* ── Recovery offer ───────────────────────────────────────────────
       Never applied automatically: the stored row may be newer than the
       mirror (edited elsewhere since), and silently overwriting it would
       be the same data loss in the other direction. */
    function offerRecovery(mountEl) {
      var m = readMirror();
      if (!m) return false;

      /* If the row was saved well after the mirror was written, the mirror is
         stale — the work it held has already been committed or superseded.

         savedAt is a browser clock reading and rowStamp is a Postgres one, so
         this comparison spans two clocks. It is deliberately lopsided: judging
         a live mirror stale destroys the very work this file exists to keep,
         while being too cautious costs one dismissable banner. SKEW_MS makes
         the cautious direction the default. */
      var stamp = opts.rowStamp && opts.rowStamp();
      if (stamp) {
        var rowMs = new Date(stamp).getTime();
        if (!isNaN(rowMs) && rowMs >= m.savedAt + SKEW_MS) { clearMirror(); return false; }
      }

      var bar = document.createElement('div');
      bar.className = 'ae-recover';
      bar.setAttribute('role', 'status');

      var txt = document.createElement('span');
      txt.textContent = 'Unsaved changes from ' + ago(m.savedAt) + ' were found on this device.';

      var restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-sm btn-primary';
      restoreBtn.textContent = 'Restore them';

      var discardBtn = document.createElement('button');
      discardBtn.type = 'button';
      discardBtn.className = 'btn btn-sm';
      discardBtn.textContent = 'Discard';

      restoreBtn.addEventListener('click', function () {
        opts.restore(m.payload);
        bar.remove();
        markDirty();
      });
      discardBtn.addEventListener('click', function () {
        clearMirror();
        bar.remove();
      });

      bar.appendChild(txt);
      bar.appendChild(restoreBtn);
      bar.appendChild(discardBtn);
      (mountEl || document.body).prepend(bar);
      return true;
    }

    return {
      markDirty: markDirty,
      markClean: markClean,
      isDirty: function () { return dirty; },
      render: render,
      renderSaved: renderSaved,
      offerRecovery: offerRecovery
    };
  }

  window.adminEditorGuard = { create: create };
})();
