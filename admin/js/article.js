/* Article live-preview editor.
   The canvas renders the real .paper-journal/.paper-body styles so what you
   see while editing is exactly what gets published. Blocks are edited inline:
   text, headings, markers and quotes are contenteditable; images show a
   click-to-edit overlay; dividers are drag-only. */
(function () {
  'use strict';

  /* ── State ──────────────────────────────────────────────────────────── */
  var blocks = [];
  var selectedIdx = -1;
  var article = { id: null, status: 'draft', published_at: null };
  var params = new URLSearchParams(window.location.search);

  /* ── DOM refs ─────────────────────────────────────────────────────── */
  var canvasBody  = document.getElementById('canvas-body');
  var titleEl     = document.getElementById('canvas-title');
  var dekEl       = document.getElementById('canvas-dek');
  var metaEl      = document.getElementById('canvas-meta');
  var slugField   = document.getElementById('f-slug');
  var excerptField = document.getElementById('f-excerpt');
  var coverUrlField = document.getElementById('f-cover-url');
  var coverPreview  = document.getElementById('cover-preview');
  var coverPlaceholder = document.getElementById('cover-placeholder');
  var statusBadge = document.getElementById('status-badge');
  var saveHint    = document.getElementById('save-hint');
  var urlSlug     = document.getElementById('url-slug');
  var slugPreview = document.getElementById('slug-preview');

  /* ── Helpers ─────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function slugify(s) {
    return String(s||'').toLowerCase().trim()
      .replace(/[''"]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  }
  function wordCount(el) {
    return (el.textContent||'').trim().split(/\s+/).filter(Boolean).length;
  }
  function setHint(text, kind) {
    saveHint.textContent = text || '';
    saveHint.className = 'ae-save-hint' + (kind ? ' ' + kind : '');
  }
  function setBadge() {
    statusBadge.textContent = article.status;
    statusBadge.className = 'badge badge-' + article.status;
  }

  function updateMeta() {
    var words = 0;
    blocks.forEach(function(b) {
      if (!b) return;
      if (b.type === 'text') words += (b.html || '').replace(/<[^>]*>/g,' ').split(/\s+/).filter(Boolean).length;
      else if (b.text) words += b.text.split(/\s+/).filter(Boolean).length;
    });
    words += wordCount(titleEl) + wordCount(dekEl);
    var mins = Math.max(1, Math.round(words / 200));
    var now = new Date();
    var dateStr = article.published_at
      ? new Date(article.published_at).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'})
      : 'Draft';
    metaEl.textContent = dateStr + ' · ' + mins + ' min read';
  }

  /* ── Slug sync ──────────────────────────────────────────────────── */
  function syncSlug() {
    var auto = slugify(titleEl.textContent || '');
    if (!slugField._manual) slugField.value = auto;
    var display = slugField.value || auto || 'slug';
    if (slugPreview) slugPreview.textContent = display;
    if (urlSlug) urlSlug.textContent = display;
  }

  /* ── Cover image ─────────────────────────────────────────────────── */
  function showCover(url) {
    if (url) {
      coverPreview.src = url;
      coverPreview.hidden = false;
      coverPlaceholder.hidden = true;
    } else {
      coverPreview.hidden = true;
      coverPlaceholder.hidden = false;
    }
  }

  document.getElementById('cover-file').addEventListener('change', async function(e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    setHint('Uploading cover…');
    try {
      var url = await window.admin.upload('article-media', f, 'covers');
      coverUrlField.value = url;
      showCover(url);
      setHint('Cover uploaded.', 'ok');
    } catch(err) { setHint('Upload failed: ' + (err && err.message || err), 'err'); }
  });
  coverUrlField.addEventListener('input', function() { showCover(coverUrlField.value.trim()); });

  /* ── Block data helpers ──────────────────────────────────────────── */
  function blank(type) {
    var b = { type: type };
    if (type === 'section_marker') b.text = '';
    else if (type === 'heading') { b.level = 2; b.text = ''; }
    else if (type === 'text') b.html = '';
    else if (type === 'image') { b.url = ''; b.alt = ''; b.caption = ''; }
    else if (type === 'quote') { b.text = ''; b.attribution = ''; }
    return b;
  }

  /* ── Block rendering ─────────────────────────────────────────────── */
  function toolbarHtml(idx) {
    var b = blocks[idx];
    var typeSelect = '<select class="ae-type-sel" data-idx="' + idx + '">' +
      ['section_marker','heading','text','image','quote','divider'].map(function(t) {
        return '<option value="' + t + '"' + (b.type === t ? ' selected' : '') + '>' +
          {section_marker:'Marker',heading:'Heading',text:'Text',image:'Image',quote:'Quote',divider:'Divider'}[t] +
        '</option>';
      }).join('') + '</select>';
    return '<div class="ae-toolbar">' +
      '<button class="ae-tb-up" title="Move up">↑</button>' +
      '<button class="ae-tb-dn" title="Move down">↓</button>' +
      '<span class="ae-tb-sep"></span>' +
      typeSelect +
      '<span class="ae-tb-sep"></span>' +
      '<button class="ae-tb-del" title="Delete block" style="color:#ff453a">✕</button>' +
    '</div>';
  }

  /* ── Floating selection toolbar ─────────────────────────────────────
     Single shared element, positioned above the selected text.
     Replaces the old per-block static format bar.                      */
  var floatBar = (function() {
    var bar = document.createElement('div');
    bar.className = 'ae-float-bar';
    bar.id = 'ae-float-bar';
    bar.hidden = true;

    /* Default view: format + list buttons */
    var defaultView =
      '<div class="ae-fb-default">' +
        '<button data-cmd="bold"    title="Bold ⌘B"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="14" height="14"><path d="M6 4h8a4 4 0 010 8H6z"/><path d="M6 12h9a4 4 0 010 8H6z"/></svg></button>' +
        '<button data-cmd="italic"  title="Italic ⌘I"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="14" height="14"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg></button>' +
        '<span class="ae-fb-sep"></span>' +
        '<button data-cmd="insertUnorderedList" title="Bullet list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg></button>' +
        '<button data-cmd="insertOrderedList"   title="Numbered list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4" stroke-width="1.5"/><path d="M4 10h2" stroke-width="1.5"/><path d="M4 16h1.5a1.5 1.5 0 010 3H4v-3z" stroke-width="1.5"/></svg></button>' +
        '<span class="ae-fb-sep"></span>' +
        '<button data-cmd="createLink" title="Link ⌘K"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg></button>' +
        '<button data-cmd="unlink"     title="Remove link" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14"><path d="M18.84 12.25l1.72-1.71a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M5.16 11.75l-1.72 1.71a5 5 0 007.07 7.07l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="2" y1="8" x2="6" y2="8"/><line x1="16" y1="18" x2="16" y2="22"/><line x1="18" y1="16" x2="22" y2="16"/></svg></button>' +
      '</div>';

    /* Link-input view: shown when ⌘K is pressed or Link button is clicked */
    var linkView =
      '<div class="ae-fb-link" style="display:none">' +
        '<input class="ae-fb-link-input" type="text" placeholder="https://" />' +
        '<button class="ae-fb-link-ok"  title="Apply link">↵</button>' +
        '<button class="ae-fb-link-back" title="Cancel">✕</button>' +
      '</div>';

    bar.innerHTML = defaultView + linkView;
    document.body.appendChild(bar);

    var defView    = bar.querySelector('.ae-fb-default');
    var lnkView    = bar.querySelector('.ae-fb-link');
    var lnkInput   = bar.querySelector('.ae-fb-link-input');
    var savedRange = null; // selection snapshot before link input takes focus

    function showDefault() { defView.style.display = 'flex'; lnkView.style.display = 'none'; }
    function showLink()    { defView.style.display = 'none'; lnkView.style.display = 'flex'; }

    function saveRange() {
      var sel = window.getSelection();
      if (sel && sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
    }
    function restoreRange() {
      if (!savedRange) return;
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }

    function applyLink() {
      var url = (lnkInput.value || '').trim();
      restoreRange();
      if (url) {
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        document.execCommand('createLink', false, url);
      }
      savedRange = null;
      lnkInput.value = '';
      showDefault();
      hide();
      syncActiveBlock();
    }

    function hide() { bar.hidden = true; }

    /* Position above a DOMRect */
    function positionAbove(rect) {
      bar.hidden = false;
      var bw = bar.offsetWidth;
      var left = rect.left + rect.width / 2;
      // Keep within viewport
      left = Math.max(bw / 2 + 8, Math.min(window.innerWidth - bw / 2 - 8, left));
      bar.style.left = left + 'px';
      bar.style.top  = Math.max(8, rect.top - bar.offsetHeight - 10) + 'px';
    }

    /* Update active states based on current selection */
    function updateStates() {
      bar.querySelectorAll('[data-cmd]').forEach(function(btn) {
        var cmd = btn.dataset.cmd;
        try {
          var active = (cmd === 'bold' || cmd === 'italic')
            ? document.queryCommandState(cmd)
            : false;
          btn.classList.toggle('active', active);
        } catch(e) {}
      });
      // Show/hide unlink button based on whether cursor is on a link
      var sel = window.getSelection();
      var onLink = sel && sel.anchorNode && sel.anchorNode.parentElement &&
                   (sel.anchorNode.parentElement.closest('a') !== null);
      var unlinkBtn = bar.querySelector('[data-cmd="unlink"]');
      if (unlinkBtn) unlinkBtn.style.display = onLink ? '' : 'none';
    }

    /* Format button clicks */
    defView.querySelectorAll('[data-cmd]').forEach(function(btn) {
      btn.addEventListener('mousedown', function(e) {
        e.preventDefault(); // don't blur the contenteditable
        var cmd = btn.dataset.cmd;
        if (cmd === 'createLink') {
          saveRange();
          showLink();
          setTimeout(function() { lnkInput.focus(); }, 10);
        } else {
          document.execCommand(cmd, false, null);
          updateStates();
          syncActiveBlock();
        }
      });
    });

    /* Link confirm */
    lnkView.querySelector('.ae-fb-link-ok').addEventListener('mousedown', function(e) {
      e.preventDefault(); applyLink();
    });
    lnkInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
      if (e.key === 'Escape') { lnkInput.value = ''; showDefault(); hide(); }
    });

    /* Link cancel */
    lnkView.querySelector('.ae-fb-link-back').addEventListener('mousedown', function(e) {
      e.preventDefault(); savedRange = null; lnkInput.value = ''; showDefault(); hide();
    });

    function isLinkView() { return lnkView.style.display !== 'none'; }

    /* Expose */
    return { positionAbove: positionAbove, updateStates: updateStates, hide: hide, showLink: showLink, saveRange: saveRange, lnkInput: lnkInput, showDefault: showDefault, applyLink: applyLink, isLinkView: isLinkView };
  })();

  /* Track which rt-body has focus for keyboard shortcuts / sync */
  var focusedRtBody = null;

  function syncActiveBlock() {
    if (!focusedRtBody) return;
    var idx = parseInt(focusedRtBody.dataset.idx, 10);
    if (blocks[idx]) blocks[idx].html = focusedRtBody.innerHTML;
    updateMeta();
  }

  function renderBlockContent(b, idx) {
    var t = b.type;

    if (t === 'section_marker') {
      return '<p class="eyebrow paper-marker ae-ce" contenteditable="true" spellcheck="true" ' +
        'data-field="text" data-idx="' + idx + '" data-ph="SECTION NAME">' +
        esc(b.text) + '</p>';
    }

    if (t === 'heading') {
      var tag = b.level === 3 ? 'h3' : 'h2';
      return '<' + tag + ' class="ae-ce" contenteditable="true" spellcheck="true" ' +
        'data-field="text" data-idx="' + idx + '" data-ph="Heading text">' +
        esc(b.text) + '</' + tag + '>';
    }

    if (t === 'text') {
      return '<div class="ae-ce ae-rt-body" contenteditable="true" spellcheck="true" ' +
        'data-field="html" data-idx="' + idx + '" data-ph="Start writing…">' +
        (b.html || '') + '</div>';
    }

    if (t === 'image') {
      var imgContent = '';
      if (b.url) {
        imgContent = '<figure class="paper-figure">' +
          '<img src="' + esc(b.url) + '" alt="' + esc(b.alt||'') + '" loading="lazy" />' +
          '<figcaption class="ae-ce" contenteditable="true" data-field="caption" data-idx="' + idx + '" data-ph="Caption (optional)">' +
          esc(b.caption||'') + '</figcaption>' +
        '</figure>';
      } else {
        imgContent = '<div class="ae-img-placeholder">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 13l5-4 4 4 3-2 5 3"/></svg>' +
          '<span style="font-size:.85rem">Click to add image</span>' +
        '</div>';
      }
      return imgContent + '<div class="ae-img-fields">' +
        '<input type="text" placeholder="Image URL" data-field="url" data-idx="' + idx + '" value="' + esc(b.url||'') + '" />' +
        '<input type="file" accept="image/*" data-upload="' + idx + '" style="font-size:.8rem" />' +
        '<input type="text" placeholder="Alt text" data-field="alt" data-idx="' + idx + '" value="' + esc(b.alt||'') + '" />' +
      '</div>';
    }

    if (t === 'quote') {
      return '<blockquote class="pull-quote">' +
        '<p class="ae-ce" contenteditable="true" spellcheck="true" ' +
        'data-field="text" data-idx="' + idx + '" data-ph="Pull quote text…">' +
        esc(b.text||'') + '</p>' +
        '<cite class="ae-ce" contenteditable="true" ' +
        'data-field="attribution" data-idx="' + idx + '" data-ph="— Attribution (optional)">' +
        esc(b.attribution||'') + '</cite>' +
      '</blockquote>';
    }

    if (t === 'divider') {
      return '<hr class="paper-rule" /><p style="text-align:center;font-size:.75rem;color:var(--muted-2);margin:0">Divider</p>';
    }

    return '';
  }

  function betweenBtn(afterIdx) {
    return '<div class="ae-between" data-after="' + afterIdx + '">' +
      '<button class="ae-between-btn" title="Add block here">+</button>' +
    '</div>';
  }

  function renderCanvas() {
    canvasBody.innerHTML = '';

    if (!blocks.length) {
      canvasBody.innerHTML = '<div class="ae-empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" width="28" height="28" style="opacity:.3;margin:0 auto 10px;display:block"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8M8 8h8M8 16h4"/></svg>' +
        '<p>Use the block palette on the left to start writing.</p></div>';
      return;
    }

    canvasBody.appendChild(makeBetween(-1)); // before first block

    blocks.forEach(function(b, i) {
      var wrap = document.createElement('div');
      wrap.className = 'ae-block' + (i === selectedIdx ? ' ae-selected' : '');
      wrap.dataset.idx = i;
      wrap.innerHTML = toolbarHtml(i) + renderBlockContent(b, i);
      canvasBody.appendChild(wrap);
      canvasBody.appendChild(makeBetween(i));
    });

    wireBlockEvents();
    updateMeta();
  }

  function makeBetween(afterIdx) {
    var div = document.createElement('div');
    div.className = 'ae-between';
    div.dataset.after = afterIdx;
    div.innerHTML = '<button class="ae-between-btn" title="Add block here">+</button>';
    div.querySelector('button').addEventListener('click', function(e) {
      e.stopPropagation();
      showTypePopup(afterIdx, div);
    });
    return div;
  }

  /* ── Type popup (click + on between-btn) ────────────────────────── */
  var activePopup = null;
  function closePopup() {
    if (activePopup && activePopup.parentNode) activePopup.parentNode.removeChild(activePopup);
    activePopup = null;
  }

  function showTypePopup(afterIdx, anchor) {
    closePopup();
    var types = [
      { type:'section_marker', label:'Section marker' },
      { type:'heading',        label:'Heading' },
      { type:'text',           label:'Text' },
      { type:'image',          label:'Image' },
      { type:'quote',          label:'Pull quote' },
      { type:'divider',        label:'Divider' }
    ];
    var pop = document.createElement('div');
    pop.style.cssText = 'position:absolute;z-index:50;background:#fff;border:1px solid var(--hair);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.14);padding:4px;min-width:160px';
    types.forEach(function(item) {
      var btn = document.createElement('button');
      btn.textContent = item.label;
      btn.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 12px;font:inherit;font-size:.85rem;border:none;background:none;cursor:pointer;border-radius:7px';
      btn.addEventListener('mouseenter', function() { btn.style.background = 'var(--bg-card)'; });
      btn.addEventListener('mouseleave', function() { btn.style.background = 'none'; });
      btn.addEventListener('click', function() {
        addBlock(item.type, afterIdx);
        closePopup();
      });
      pop.appendChild(btn);
    });
    anchor.style.position = 'relative';
    anchor.appendChild(pop);
    activePopup = pop;
    setTimeout(function() {
      document.addEventListener('click', closePopup, { once: true });
    }, 0);
  }

  /* ── Wire events on rendered blocks ─────────────────────────────── */
  function wireBlockEvents() {
    canvasBody.querySelectorAll('.ae-block').forEach(function(wrap) {
      var idx = parseInt(wrap.dataset.idx, 10);

      // Select on click
      wrap.addEventListener('click', function(e) {
        if (e.target.closest('.ae-toolbar') || e.target.closest('.ae-between')) return;
        selectBlock(idx);
      });

      // Toolbar: up / down / delete / type-change
      var tb = wrap.querySelector('.ae-toolbar');
      if (tb) {
        tb.querySelector('.ae-tb-up').addEventListener('click', function(e) { e.stopPropagation(); moveBlock(idx, -1); });
        tb.querySelector('.ae-tb-dn').addEventListener('click', function(e) { e.stopPropagation(); moveBlock(idx,  1); });
        tb.querySelector('.ae-tb-del').addEventListener('click', function(e) { e.stopPropagation(); removeBlock(idx); });
        var sel = tb.querySelector('.ae-type-sel');
        if (sel) sel.addEventListener('change', function(e) {
          e.stopPropagation();
          var newType = sel.value;
          var old = blocks[idx];
          var nb = blank(newType);
          // Preserve text where it makes sense
          if (old.text != null && nb.text != null) nb.text = old.text;
          if (old.html != null && nb.html != null) nb.html = old.html;
          blocks[idx] = nb;
          selectBlock(idx);
          renderCanvas();
        });
      }

      // Contenteditable → update block data + hook into floating toolbar
      wrap.querySelectorAll('[contenteditable][data-field]').forEach(function(ce) {
        var field = ce.dataset.field;
        var i = parseInt(ce.dataset.idx, 10);

        ce.addEventListener('input', function() {
          if (!blocks[i]) return;
          if (field === 'html') blocks[i].html = ce.innerHTML;
          else blocks[i][field] = ce.textContent;
          updateMeta();
          syncSlug();
        });

        // Ensure paragraphs (not divs) on Enter in text blocks
        if (field === 'html') {
          try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch(e) {}

          ce.addEventListener('focus', function() { focusedRtBody = ce; });
          ce.addEventListener('blur',  function() {
            // Sync on blur unless focus moved to the float bar
            setTimeout(function() {
              if (!document.getElementById('ae-float-bar').contains(document.activeElement)) {
                syncActiveBlock();
              }
            }, 100);
          });

          // Keyboard shortcuts inside text blocks
          ce.addEventListener('keydown', function(e) {
            var meta = e.metaKey || e.ctrlKey;
            if (!meta) return;
            if (e.key === 'b' || e.key === 'B') { e.preventDefault(); document.execCommand('bold',   false, null); floatBar.updateStates(); }
            if (e.key === 'i' || e.key === 'I') { e.preventDefault(); document.execCommand('italic', false, null); floatBar.updateStates(); }
            if (e.key === 'k' || e.key === 'K') {
              e.preventDefault();
              floatBar.saveRange();
              var sel = window.getSelection();
              if (sel && sel.rangeCount) {
                var rect = sel.getRangeAt(0).getBoundingClientRect();
                if (rect.width) floatBar.positionAbove(rect);
              }
              floatBar.showLink();
              setTimeout(function() { floatBar.lnkInput.focus(); }, 10);
            }
          });
        }
      });

      // Image URL field
      wrap.querySelectorAll('input[data-field]').forEach(function(inp) {
        var field = inp.dataset.field;
        var i = parseInt(inp.dataset.idx, 10);
        inp.addEventListener('input', function() {
          if (blocks[i]) blocks[i][field] = inp.value.trim();
          if (field === 'url') { blocks[i].url = inp.value.trim(); renderCanvas(); }
        });
      });

      // Image file upload
      var uploadInput = wrap.querySelector('input[data-upload]');
      if (uploadInput) {
        uploadInput.addEventListener('change', async function(e) {
          var f = e.target.files && e.target.files[0]; if (!f) return;
          setHint('Uploading image…');
          try {
            var url = await window.admin.upload('article-media', f, 'inline');
            blocks[idx].url = url;
            setHint('Uploaded.', 'ok');
            renderCanvas();
            selectBlock(idx);
          } catch(err) { setHint('Upload failed: ' + (err && err.message||err), 'err'); }
        });
      }

      // Placeholder click → focus caption / text
      var ph = wrap.querySelector('.ae-img-placeholder');
      if (ph) ph.addEventListener('click', function() {
        var inp = wrap.querySelector('input[data-field="url"]');
        if (inp) inp.focus();
      });
    });
  }

  /* ── Selection ───────────────────────────────────────────────────── */
  function selectBlock(idx) {
    if (selectedIdx === idx) return;
    selectedIdx = idx;
    canvasBody.querySelectorAll('.ae-block').forEach(function(el) {
      el.classList.toggle('ae-selected', parseInt(el.dataset.idx,10) === idx);
    });
  }

  // Click outside blocks → deselect
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.ae-block') && !e.target.closest('.ae-palette-btn')) {
      selectedIdx = -1;
      canvasBody.querySelectorAll('.ae-block').forEach(function(el) { el.classList.remove('ae-selected'); });
    }
  });

  /* ── Floating toolbar: appear over selected text in a text block ──────
     The bar is shown only for a non-collapsed selection whose anchor sits
     inside an .ae-rt-body. Otherwise it hides. Skipped while the link input
     is open so typing a URL doesn't dismiss it. */
  var floatRaf = null;
  function refreshFloatBar() {
    if (floatBar.isLinkView()) return;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { floatBar.hide(); return; }
    var node = sel.anchorNode;
    var host = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
    host = host && host.closest ? host.closest('.ae-rt-body') : null;
    if (!host) { floatBar.hide(); return; }
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { floatBar.hide(); return; }
    floatBar.showDefault();
    floatBar.positionAbove(rect);
    floatBar.updateStates();
  }
  document.addEventListener('selectionchange', function() {
    if (floatRaf) cancelAnimationFrame(floatRaf);
    floatRaf = requestAnimationFrame(refreshFloatBar);
  });
  // The canvas scrolls internally — a fixed bar would drift, so hide on scroll.
  var canvasScroller = document.querySelector('.ae-canvas-wrap');
  if (canvasScroller) canvasScroller.addEventListener('scroll', function() {
    if (!floatBar.isLinkView()) floatBar.hide();
  }, { passive: true });

  /* ── Mutations ───────────────────────────────────────────────────── */
  function addBlock(type, afterIdx) {
    var b = blank(type);
    blocks.splice(afterIdx + 1, 0, b);
    renderCanvas();
    selectBlock(afterIdx + 1);
    // Focus the new block's editable
    setTimeout(function() {
      var el = canvasBody.querySelector('.ae-block[data-idx="' + (afterIdx+1) + '"] [contenteditable]');
      if (el) el.focus();
    }, 30);
  }

  function removeBlock(idx) {
    blocks.splice(idx, 1);
    selectedIdx = -1;
    renderCanvas();
  }

  function moveBlock(idx, dir) {
    var to = idx + dir;
    if (to < 0 || to >= blocks.length) return;
    var tmp = blocks[idx]; blocks[idx] = blocks[to]; blocks[to] = tmp;
    renderCanvas();
    selectBlock(to);
  }

  /* ── Sidebar palette ─────────────────────────────────────────────── */
  document.querySelectorAll('.ae-palette-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      addBlock(btn.dataset.type, blocks.length - 1);
    });
  });

  /* ── Title / dek sync ────────────────────────────────────────────── */
  titleEl.addEventListener('input', function() { syncSlug(); updateMeta(); });
  dekEl.addEventListener('input', function() { updateMeta(); });
  slugField.addEventListener('input', function() {
    slugField._manual = !!slugField.value;
    syncSlug();
  });

  /* ── Gather for save ─────────────────────────────────────────────── */
  function gather() {
    var title = (titleEl.textContent || '').trim();
    var dek   = (dekEl.textContent || '').trim();
    var slug  = slugField.value.trim() || slugify(title);
    var clean = blocks.filter(function(b) {
      if (!b || !b.type) return false;
      if (b.type === 'divider') return true;
      if (b.type === 'image') return !!b.url;
      if (b.type === 'text') return !!(b.html || '').replace(/<[^>]*>/g,'').trim();
      return !!((b.text||'').trim());
    }).map(function(b) { return JSON.parse(JSON.stringify(b)); });
    var words = clean.reduce(function(acc, b) {
      var t = b.type === 'text' ? (b.html||'').replace(/<[^>]*>/g,' ') : (b.text||'');
      return acc + t.split(/\s+/).filter(Boolean).length;
    }, 0) + wordCount(titleEl) + wordCount(dekEl);
    return {
      title: title,
      dek: dek || null,
      slug: slug,
      excerpt: (excerptField.value || '').trim() || null,
      cover_image_url: coverUrlField.value.trim() || null,
      body: clean,
      reading_minutes: Math.max(1, Math.round(words / 200))
    };
  }

  /* ── Save / Publish ──────────────────────────────────────────────── */
  async function save(publish) {
    var data = gather();
    if (!data.title) { titleEl.focus(); setHint('Add a title first.', 'err'); return; }
    if (!data.slug)  { slugField.focus(); setHint('Add a slug.', 'err'); return; }

    if (publish) {
      data.status = 'published';
      data.published_at = article.published_at || new Date().toISOString();
    } else {
      data.status = article.id ? article.status : 'draft';
      data.published_at = article.published_at;
    }

    document.getElementById('save-btn').disabled = true;
    document.getElementById('publish-btn').disabled = true;
    setHint('Saving…');

    var q = article.id
      ? window.sb.from('articles').update(data).eq('id', article.id).select().single()
      : window.sb.from('articles').insert(data).select().single();

    var res = await q;
    document.getElementById('save-btn').disabled = false;
    document.getElementById('publish-btn').disabled = false;

    if (res.error) { setHint('Save failed: ' + res.error.message, 'err'); return; }

    article.id           = res.data.id;
    article.status       = res.data.status;
    article.published_at = res.data.published_at;
    setBadge();
    setHint((publish ? 'Published' : 'Saved') + ' · run npm run build to deploy', 'ok');

    if (!params.get('id')) {
      params = new URLSearchParams({ id: article.id });
      window.history.replaceState(null, '', '/admin/article?id=' + encodeURIComponent(article.id));
    }
    updateMeta();
  }

  document.getElementById('save-btn').addEventListener('click', function() { save(false); });
  document.getElementById('publish-btn').addEventListener('click', function() { save(true); });

  /* ── Load from Supabase ──────────────────────────────────────────── */
  async function load() {
    var id = params.get('id');
    if (!id) { renderCanvas(); syncSlug(); return; }

    setHint('Loading…');
    var res = await window.sb.from('articles').select('*').eq('id', id).single();
    if (res.error) { setHint('Could not load: ' + res.error.message, 'err'); return; }
    var a = res.data;

    article.id           = a.id;
    article.status       = a.status;
    article.published_at = a.published_at;

    titleEl.textContent  = a.title  || '';
    dekEl.textContent    = a.dek    || '';
    slugField.value      = a.slug   || '';
    slugField._manual    = true;
    excerptField.value   = a.excerpt || '';
    coverUrlField.value  = a.cover_image_url || '';
    showCover(a.cover_image_url);

    blocks = Array.isArray(a.body) ? JSON.parse(JSON.stringify(a.body)) : [];
    setBadge();
    syncSlug();
    renderCanvas();
    setHint('');
  }

  /* ── Boot ────────────────────────────────────────────────────────── */
  async function boot() {
    var s = await (window.adminReady || Promise.resolve(null));
    if (!s) return;
    load();
  }

  boot();
})();
