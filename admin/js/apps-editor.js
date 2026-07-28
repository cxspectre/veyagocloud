/* App product-page editor.
   The canvas renders the REAL site sections — hero (text + device), feature
   rows with the screenshot on either side, steps, feature cards and a dark CTA
   band — using /styles.css, so what you compose is what gets published. Text is
   edited inline (contenteditable); images, buttons, links and the image side
   (flip) are edited through each section's field strip and toolbar.

   Layout is stored in apps.layout (jsonb); the catalogue card fields live in the
   sidebar. tools/build.js renders /apps/<slug>/index.html from the same shape. */
(function () {
  'use strict';

  /* ── State ──────────────────────────────────────────────────────────── */
  var sections = [];
  var selectedIdx = -1;
  var app = { id: null, status: 'in-development', published: false };
  var params = new URLSearchParams(window.location.search);

  /* ── DOM refs ───────────────────────────────────────────────────────── */
  var canvasBody  = document.getElementById('canvas-body');
  var statusBadge = document.getElementById('status-badge');
  var saveHint    = document.getElementById('save-hint');
  var urlSlug     = document.getElementById('url-slug');
  var slugPreview = document.getElementById('slug-preview');
  var nameField   = document.getElementById('ap-name');
  var slugField   = document.getElementById('ap-slug');
  var statusField = document.getElementById('ap-status');
  var iconUrlField = document.getElementById('ap-icon');
  var iconPreview  = document.getElementById('icon-preview');
  var iconPlaceholder = document.getElementById('icon-placeholder');

  /* ── Tiny helpers ───────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function att(s) { return esc(s).replace(/"/g,'&quot;'); }
  function slugify(s) {
    return String(s||'').toLowerCase().trim()
      .replace(/[''"]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  }
  function val(id) { var el = document.getElementById(id); return el ? (el.value||'').trim() : ''; }
  function setHint(text, kind) {
    saveHint.textContent = text || '';
    saveHint.className = 'ae-save-hint' + (kind ? ' ' + kind : '');
  }
  function setBadge() {
    statusBadge.textContent = app.published ? app.status : app.status + ' · hidden';
    statusBadge.className = 'badge badge-' + app.status;
  }

  /* ── Icon set for feature cards (matches the public .ic gradient tones) ─ */
  var ICONS = {
    lock:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2"/></svg>',
    bell:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16h12l-1.6-2.2V10a4.4 4.4 0 0 0-8.8 0v3.8L6 16z"/><path d="M10.4 19a1.7 1.7 0 0 0 3.2 0"/></svg>',
    scan:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="17" height="12.5" rx="2.4"/><circle cx="12" cy="13.2" r="3.1"/><path d="M8.5 7l1.4-2h4.2l1.4 2"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.4L12 17l-1.9-5.6L4.5 10l5.6-1.4z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.8"/></svg>',
    doc:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.6h7L18.4 8v11a1.6 1.6 0 0 1-1.6 1.6H7A1.6 1.6 0 0 1 5.4 19V5.2A1.6 1.6 0 0 1 7 3.6z"/><path d="M13.6 3.6V8h4.4"/></svg>',
    shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2l7.4 2.8v5.2c0 4.6-3.2 7.8-7.4 9.2-4.2-1.4-7.4-4.6-7.4-9.2V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    tag:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.6V5.4A1.4 1.4 0 0 1 5.4 4h7.2a1.4 1.4 0 0 1 1 .4l6 6a1.4 1.4 0 0 1 0 2l-7.2 7.2a1.4 1.4 0 0 1-2 0l-6-6a1.4 1.4 0 0 1-.4-1z"/><circle cx="8.4" cy="8.4" r="1.2"/></svg>'
  };
  var ICON_KEYS = Object.keys(ICONS);
  var TONES = ['ic-blue','ic-purple','ic-green','ic-orange','ic-teal'];

  var APPLE_SVG = '<svg viewBox="0 0 814 1000" aria-hidden="true"><path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-42.4-150.3-109.3C76.7 726.2 30.4 600.4 30.4 480.4c0-109.8 55.7-167.2 96.5-205.2 53.2-49.5 104-60.9 148.8-60.9 65.7 0 118.4 44.3 158.3 44.3 37.7 0 97.5-47.8 170.7-47.8 23.4 0 108.2 2.7 156.3 75.6zm-237.5-325.3c23.4-27.8 38.1-64.2 38.1-100.6 0-5.8-.5-11.7-1.6-16.4-35.6 1.3-78.5 23.9-104 51.5-22.8 25.2-41 61.6-41 98.6 0 6.5.6 13 1.1 15.1 2.2.4 5.8.8 9.4.8 32.5 0 74.7-21.7 98-48.9z" fill="#fff"/></svg>';

  var TYPE_LABEL = { hero:'Hero', feature:'Feature row', steps:'Steps', cards:'Feature cards', cta:'CTA band' };

  /* ── Section factories ──────────────────────────────────────────────── */
  function card(i) { return { icon: ICON_KEYS[i % ICON_KEYS.length], tone: TONES[i % TONES.length], title:'', text:'' }; }
  function blank(type) {
    if (type === 'hero')    return { type:'hero', eyebrow:'', headline:'', lead:'', image:'', imageAlt:'', ctaKind:'appstore', ctaLabel:'App Store', ctaSub:'Coming soon to the', ctaHref:'', linkLabel:'', linkHref:'' };
    if (type === 'feature') return { type:'feature', eyebrow:'', headline:'', lead:'', image:'', imageAlt:'', flip:false, soft:false };
    if (type === 'steps')   return { type:'steps', eyebrow:'', headline:'', items:[{title:'',text:''},{title:'',text:''},{title:'',text:''}] };
    if (type === 'cards')   return { type:'cards', eyebrow:'', headline:'', soft:false, items:[card(0),card(1),card(2)] };
    if (type === 'cta')     return { type:'cta', headline:'', lead:'', linkLabel:'', linkHref:'' };
    return { type:type };
  }

  /* ── Inline-editable element ────────────────────────────────────────── */
  function ce(tag, cls, idx, field, value, ph, extra) {
    var c = (cls ? cls + ' ' : '') + 'ae-ce';
    return '<' + tag + ' class="' + c + '" contenteditable="true" spellcheck="true" data-idx="' + idx + '"' +
      (field ? ' data-field="' + field + '"' : '') + (extra || '') +
      ' data-ph="' + att(ph) + '">' + esc(value || '') + '</' + tag + '>';
  }

  function media(s, idx) {
    if (s.image) {
      return '<div class="device"><img src="' + att(s.image) + '" alt="' + att(s.imageAlt || '') + '" loading="lazy" /></div>';
    }
    return '<div class="ae-img-placeholder ape-ph" data-idx="' + idx + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 13l5-4 4 4 3-2 5 3"/></svg>' +
      '<span style="font-size:.85rem">Click to add screenshot</span></div>';
  }

  function heroActions(s) {
    var out = '';
    if (s.ctaKind === 'appstore') {
      out += '<a class="badge-as" href="' + att(s.ctaHref || '#') + '">' + APPLE_SVG +
        '<span><span class="bas-sub">' + esc(s.ctaSub || 'Coming soon to the') + '</span>' +
        '<span class="bas-name">' + esc(s.ctaLabel || 'App Store') + '</span></span></a>';
    } else if (s.ctaKind === 'button') {
      out += '<a class="btn btn-blue" href="' + att(s.ctaHref || '#') + '">' + esc(s.ctaLabel || 'Get the app') + '</a>';
    }
    if (s.linkLabel) out += '<a class="link" href="' + att(s.linkHref || '#') + '">' + esc(s.linkLabel) + '</a>';
    return out ? '<div class="actions">' + out + '</div>' : '';
  }

  /* ── Section body markup (the real site sections) ───────────────────── */
  function bodyByType(s, idx) {
    if (s.type === 'hero') {
      return '<section class="section hero split">' +
        '<div class="wrap">' +
          '<div class="hero-text">' +
            ce('p','eyebrow',idx,'eyebrow',s.eyebrow,'EYEBROW') +
            ce('h1','headline',idx,'headline',s.headline,'Headline') +
            ce('p','lead',idx,'lead',s.lead,'One plain-voice line about the app.') +
            heroActions(s) +
          '</div>' +
          '<div class="hero-media">' + media(s, idx) + '</div>' +
        '</div></section>';
    }
    if (s.type === 'feature') {
      return '<section class="section feat-section' + (s.soft ? ' soft' : '') + '">' +
        '<div class="feat-row' + (s.flip ? ' flip' : '') + '">' +
          '<div class="fr-body">' +
            ce('p','eyebrow',idx,'eyebrow',s.eyebrow,'EYEBROW') +
            ce('h2','section-headline',idx,'headline',s.headline,'Feature headline') +
            ce('p','lead',idx,'lead',s.lead,'Describe what this does and why it matters.') +
          '</div>' +
          '<div class="fr-media">' + media(s, idx) + '</div>' +
        '</div></section>';
    }
    if (s.type === 'steps') {
      var steps = s.items.map(function (it, j) {
        return '<div class="step ape-item">' +
          '<div class="num">' + (j + 1) + '</div>' +
          itemDel(idx, j) +
          ce('h4','',idx,'',it.title,'Step title',' data-item="' + j + '" data-sub="title"') +
          ce('p','',idx,'',it.text,'What happens here',' data-item="' + j + '" data-sub="text"') +
        '</div>';
      }).join('');
      return '<section class="section">' +
        '<div class="wrap">' +
          ce('p','eyebrow',idx,'eyebrow',s.eyebrow,'EYEBROW') +
          ce('h2','section-headline',idx,'headline',s.headline,'How it works') +
        '</div>' +
        '<div class="wrap"><div class="steps">' + steps + '</div></div></section>';
    }
    if (s.type === 'cards') {
      var cards = s.items.map(function (it, j) {
        return '<div class="card ape-item">' +
          '<div class="ape-ic-wrap">' +
            '<div class="ic ' + att(it.tone || 'ic-blue') + '">' + (ICONS[it.icon] || ICONS.spark) + '</div>' +
            '<select class="ape-ic-sel" data-cardicon="' + idx + '" data-item="' + j + '" title="Icon">' +
              ICON_KEYS.map(function (k) { return '<option value="' + k + '"' + (k === it.icon ? ' selected' : '') + '>' + k + '</option>'; }).join('') +
            '</select>' +
          '</div>' +
          itemDel(idx, j) +
          ce('h3','',idx,'',it.title,'Card title',' data-item="' + j + '" data-sub="title"') +
          ce('p','',idx,'',it.text,'Card description',' data-item="' + j + '" data-sub="text"') +
        '</div>';
      }).join('');
      return '<section class="section' + (s.soft ? ' soft' : '') + '">' +
        '<div class="wrap">' +
          ce('p','eyebrow',idx,'eyebrow',s.eyebrow,'EYEBROW') +
          ce('h2','section-headline',idx,'headline',s.headline,'Everything in one place') +
        '</div>' +
        '<div class="cards' + (s.items.length <= 2 ? ' two' : '') + '">' + cards + '</div></section>';
    }
    if (s.type === 'cta') {
      return '<section class="section dark">' +
        '<div class="wrap">' +
          ce('h2','section-headline',idx,'headline',s.headline,'Closing headline') +
          ce('p','lead',idx,'lead',s.lead,'A final line that invites action.') +
          (s.linkLabel ? '<div class="actions"><a class="link" href="' + att(s.linkHref || '#') + '">' + esc(s.linkLabel) + '</a></div>' : '') +
        '</div></section>';
    }
    return '';
  }

  function itemDel(idx, j) {
    return '<button class="ape-item-del" data-del="' + idx + '" data-item="' + j + '" title="Remove">×</button>';
  }

  /* ── Section toolbar (move / toggles / delete) ──────────────────────── */
  function tgl(key, on, label) {
    return '<button class="ape-tgl' + (on ? ' on' : '') + '" data-toggle="' + key + '" title="' + att(label) + '">' + esc(label) + '</button>';
  }
  function toolbar(s) {
    var t = '<div class="ae-toolbar">' +
      '<button class="ae-tb-up" title="Move up">↑</button>' +
      '<button class="ae-tb-dn" title="Move down">↓</button>' +
      '<span class="ae-tb-sep"></span>' +
      '<span class="ape-tb-label">' + TYPE_LABEL[s.type] + '</span>';
    if (s.type === 'feature') t += '<span class="ae-tb-sep"></span>' + tgl('flip', s.flip, 'Flip side') + tgl('soft', s.soft, 'Soft bg');
    if (s.type === 'cards')   t += '<span class="ae-tb-sep"></span>' + tgl('soft', s.soft, 'Soft bg');
    t += '<span class="ae-tb-sep"></span><button class="ae-tb-del" title="Delete section" style="color:#ff453a">✕</button></div>';
    return t;
  }

  /* ── Field strip (structured controls, shown when selected) ─────────── */
  function imgFields(s, idx, label) {
    return '<label class="ape-fl">' + (label || 'Screenshot') + '</label>' +
      '<div class="ape-frow">' +
        '<input type="text" placeholder="Image URL" data-inp="1" data-idx="' + idx + '" data-field="image" data-rerender="1" value="' + att(s.image || '') + '" />' +
        '<label class="ape-up">Upload<input type="file" accept="image/*" data-upload="' + idx + '" hidden /></label>' +
      '</div>' +
      '<input class="ape-fi" type="text" placeholder="Alt text (describe the image)" data-inp="1" data-idx="' + idx + '" data-field="imageAlt" value="' + att(s.imageAlt || '') + '" />';
  }
  function opt(v, cur, label) { return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + label + '</option>'; }

  function fieldsHtml(s, idx) {
    var f = '';
    if (s.type === 'hero') {
      f = imgFields(s, idx, 'Hero screenshot') +
        '<label class="ape-fl">Primary button</label>' +
        '<div class="ape-frow">' +
          '<select data-inp="1" data-idx="' + idx + '" data-field="ctaKind" data-rerender="1">' +
            opt('appstore', s.ctaKind, 'App Store badge') + opt('button', s.ctaKind, 'Blue button') + opt('none', s.ctaKind, 'No button') +
          '</select>' +
          '<input type="text" placeholder="Button label" data-inp="1" data-idx="' + idx + '" data-field="ctaLabel" data-rerender="1" value="' + att(s.ctaLabel || '') + '" />' +
        '</div>' +
        '<input class="ape-fi" type="text" placeholder="Button link (App Store URL, mailto, /page/)" data-inp="1" data-idx="' + idx + '" data-field="ctaHref" data-rerender="1" value="' + att(s.ctaHref || '') + '" />' +
        '<label class="ape-fl">Secondary text link</label>' +
        '<div class="ape-frow">' +
          '<input type="text" placeholder="Link text (e.g. Privacy)" data-inp="1" data-idx="' + idx + '" data-field="linkLabel" data-rerender="1" value="' + att(s.linkLabel || '') + '" />' +
          '<input type="text" placeholder="Link URL" data-inp="1" data-idx="' + idx + '" data-field="linkHref" data-rerender="1" value="' + att(s.linkHref || '') + '" />' +
        '</div>';
    } else if (s.type === 'feature') {
      f = imgFields(s, idx, 'Feature screenshot') +
        '<p class="ape-tip">Use the toolbar above to flip the image to the other side or soften the background.</p>';
    } else if (s.type === 'steps') {
      f = '<button class="ape-add" data-add="' + idx + '">+ Add step</button>';
    } else if (s.type === 'cards') {
      f = '<button class="ape-add" data-add="' + idx + '">+ Add card</button>';
    } else if (s.type === 'cta') {
      f = '<label class="ape-fl">Button / link</label>' +
        '<div class="ape-frow">' +
          '<input type="text" placeholder="Link text" data-inp="1" data-idx="' + idx + '" data-field="linkLabel" data-rerender="1" value="' + att(s.linkLabel || '') + '" />' +
          '<input type="text" placeholder="Link URL" data-inp="1" data-idx="' + idx + '" data-field="linkHref" data-rerender="1" value="' + att(s.linkHref || '') + '" />' +
        '</div>';
    }
    return '<div class="ape-fields">' + f + '</div>';
  }

  /* ── Canvas render ──────────────────────────────────────────────────── */
  function sectionHtml(s, idx) {
    return '<div class="ae-block ape-section' + (idx === selectedIdx ? ' ae-selected' : '') + '" data-idx="' + idx + '">' +
      toolbar(s) + bodyByType(s, idx) + fieldsHtml(s, idx) + '</div>';
  }
  function betweenHtml(after) {
    return '<div class="ae-between ape-between" data-after="' + after + '"><button class="ae-between-btn" title="Add section here">+</button></div>';
  }

  function renderCanvas() {
    if (!sections.length) {
      canvasBody.innerHTML = '<div class="ae-empty" style="margin:40px">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" width="28" height="28" style="opacity:.3;margin:0 auto 10px;display:block"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg>' +
        '<p>Add a section from the palette on the left to start building the page.</p></div>';
      updateUrl();
      return;
    }
    var html = betweenHtml(-1);
    sections.forEach(function (s, i) { html += sectionHtml(s, i) + betweenHtml(i); });
    canvasBody.innerHTML = html;
    wireEvents();
    updateUrl();
  }

  /* ── Wire events on rendered sections ───────────────────────────────── */
  function wireEvents() {
    // Block clicks inside the canvas from navigating
    canvasBody.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); });
    });

    canvasBody.querySelectorAll('.ape-section').forEach(function (wrap) {
      var idx = parseInt(wrap.dataset.idx, 10);

      wrap.addEventListener('click', function (e) {
        if (e.target.closest('.ae-toolbar') || e.target.closest('.ae-between')) return;
        selectSection(idx);
      });

      var tb = wrap.querySelector('.ae-toolbar');
      if (tb) {
        tb.querySelector('.ae-tb-up').addEventListener('click', function (e) { e.stopPropagation(); moveSection(idx, -1); });
        tb.querySelector('.ae-tb-dn').addEventListener('click', function (e) { e.stopPropagation(); moveSection(idx,  1); });
        tb.querySelector('.ae-tb-del').addEventListener('click', function (e) { e.stopPropagation(); removeSection(idx); });
        tb.querySelectorAll('[data-toggle]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var k = btn.dataset.toggle;
            if (sections[idx]) { sections[idx][k] = !sections[idx][k]; markDirty(); renderCanvas(); }
          });
        });
      }

      // Inline contenteditable → model
      wrap.querySelectorAll('.ae-ce[contenteditable]').forEach(function (el) {
        el.addEventListener('input', function () {
          var s = sections[idx]; if (!s) return;
          if (el.dataset.item != null) {
            var it = s.items && s.items[+el.dataset.item];
            if (it) it[el.dataset.sub] = el.textContent;
          } else {
            s[el.dataset.field] = el.textContent;
          }
        });
      });

      // Structured field inputs
      wrap.querySelectorAll('[data-inp]').forEach(function (inp) {
        inp.addEventListener('input', function () {
          if (sections[idx]) sections[idx][inp.dataset.field] = inp.value;
        });
        inp.addEventListener('change', function () {
          if (sections[idx]) sections[idx][inp.dataset.field] = inp.value;
          if (inp.dataset.rerender) renderCanvas();
        });
      });

      // Image uploads
      wrap.querySelectorAll('[data-upload]').forEach(function (up) {
        up.addEventListener('change', async function (e) {
          var file = e.target.files && e.target.files[0]; if (!file) return;
          setHint('Uploading image…');
          try {
            var url = await window.admin.upload('article-media', file, 'app-media');
            if (sections[idx]) sections[idx].image = url;
            markDirty();
            setHint('Image uploaded.', 'ok');
            renderCanvas();
          } catch (err) { setHint('Upload failed: ' + (err && err.message || err), 'err'); }
        });
      });

      // Placeholder → open the file picker
      var ph = wrap.querySelector('.ape-ph');
      if (ph) ph.addEventListener('click', function (e) {
        e.stopPropagation();
        selectSection(idx);
        var up = wrap.querySelector('[data-upload]');
        if (up) up.click();
      });

      // Card icon pickers
      wrap.querySelectorAll('[data-cardicon]').forEach(function (sel) {
        sel.addEventListener('change', function (e) {
          e.stopPropagation();
          var s = sections[idx]; var it = s && s.items && s.items[+sel.dataset.item];
          if (it) { it.icon = sel.value; renderCanvas(); }
        });
      });

      // Add / remove items
      var add = wrap.querySelector('[data-add]');
      if (add) add.addEventListener('click', function (e) { e.stopPropagation(); addItem(idx); });
      wrap.querySelectorAll('[data-del]').forEach(function (del) {
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          delItem(idx, +del.dataset.item);
        });
      });

      // Add-between buttons
    });

    canvasBody.querySelectorAll('.ape-between').forEach(function (b) {
      b.querySelector('button').addEventListener('click', function (e) {
        e.stopPropagation();
        showTypePopup(parseInt(b.dataset.after, 10), b);
      });
    });
  }

  /* ── Selection ──────────────────────────────────────────────────────── */
  function selectSection(idx) {
    selectedIdx = idx;
    canvasBody.querySelectorAll('.ape-section').forEach(function (el) {
      el.classList.toggle('ae-selected', parseInt(el.dataset.idx, 10) === idx);
    });
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.ae-block') && !e.target.closest('.ae-palette-btn') && !e.target.closest('.ape-type-pop')) {
      selectedIdx = -1;
      canvasBody.querySelectorAll('.ape-section').forEach(function (el) { el.classList.remove('ae-selected'); });
    }
  });

  /* ── Mutations ──────────────────────────────────────────────────────── */
  function addSection(type, afterIdx) {
    sections.splice(afterIdx + 1, 0, blank(type));
    markDirty();
    renderCanvas();
    selectSection(afterIdx + 1);
    setTimeout(function () {
      var el = canvasBody.querySelector('.ape-section[data-idx="' + (afterIdx + 1) + '"] .ae-ce[contenteditable]');
      if (el) el.focus();
    }, 30);
  }
  function removeSection(idx) { sections.splice(idx, 1); selectedIdx = -1; markDirty(); renderCanvas(); }
  function moveSection(idx, dir) {
    var to = idx + dir;
    if (to < 0 || to >= sections.length) return;
    var tmp = sections[idx]; sections[idx] = sections[to]; sections[to] = tmp;
    markDirty(); renderCanvas(); selectSection(to);
  }
  function addItem(idx) {
    var s = sections[idx]; if (!s || !s.items) return;
    s.items.push(s.type === 'cards' ? card(s.items.length) : { title:'', text:'' });
    markDirty(); renderCanvas(); selectSection(idx);
  }
  function delItem(idx, j) {
    var s = sections[idx]; if (!s || !s.items) return;
    s.items.splice(j, 1);
    markDirty(); renderCanvas(); selectSection(idx);
  }

  /* ── Add-section popup ──────────────────────────────────────────────── */
  var activePopup = null;
  function closePopup() { if (activePopup && activePopup.parentNode) activePopup.parentNode.removeChild(activePopup); activePopup = null; }
  function showTypePopup(afterIdx, anchor) {
    closePopup();
    var types = [
      { type:'hero',    label:'Hero (text + device)' },
      { type:'feature', label:'Feature row (image)' },
      { type:'steps',   label:'Steps (1·2·3)' },
      { type:'cards',   label:'Feature cards' },
      { type:'cta',     label:'CTA band (dark)' }
    ];
    var pop = document.createElement('div');
    pop.className = 'ape-type-pop';
    pop.style.cssText = 'position:absolute;z-index:50;background:#fff;border:1px solid var(--hair);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.16);padding:4px;min-width:190px;left:50%;transform:translateX(-50%);top:24px';
    types.forEach(function (t) {
      var btn = document.createElement('button');
      btn.textContent = t.label;
      btn.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 12px;font:inherit;font-size:.85rem;border:none;background:none;cursor:pointer;border-radius:7px';
      btn.addEventListener('mouseenter', function () { btn.style.background = 'var(--bg-card)'; });
      btn.addEventListener('mouseleave', function () { btn.style.background = 'none'; });
      btn.addEventListener('click', function (e) { e.stopPropagation(); addSection(t.type, afterIdx); closePopup(); });
      pop.appendChild(btn);
    });
    anchor.style.position = 'relative';
    anchor.appendChild(pop);
    activePopup = pop;
    setTimeout(function () { document.addEventListener('click', closePopup, { once: true }); }, 0);
  }

  /* ── Sidebar: palette ───────────────────────────────────────────────── */
  document.querySelectorAll('.ae-palette-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { addSection(btn.dataset.type, sections.length - 1); });
  });

  /* ── Sidebar: slug + icon + status ──────────────────────────────────── */
  function updateUrl() {
    var slug = slugField.value || slugify(nameField.value) || 'slug';
    if (slugPreview) slugPreview.textContent = slug;
    if (urlSlug) urlSlug.textContent = slug;
  }
  nameField.addEventListener('input', function () {
    if (!slugField._manual) slugField.value = slugify(nameField.value);
    updateUrl();
  });
  slugField.addEventListener('input', function () { slugField._manual = !!slugField.value; updateUrl(); });
  statusField.addEventListener('change', function () { app.status = statusField.value; setBadge(); });

  function showIcon(url) {
    if (url) { iconPreview.src = url; iconPreview.hidden = false; iconPlaceholder.hidden = true; }
    else { iconPreview.hidden = true; iconPlaceholder.hidden = false; }
  }
  iconUrlField.addEventListener('input', function () { showIcon(iconUrlField.value.trim()); });
  document.getElementById('ap-icon-file').addEventListener('change', async function (e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    document.getElementById('ap-icon-status').textContent = 'Uploading…';
    try {
      var url = await window.admin.upload('article-media', f, 'app-icons');
      iconUrlField.value = url; showIcon(url);
      markDirty();
      document.getElementById('ap-icon-status').textContent = 'Uploaded.';
    } catch (err) { document.getElementById('ap-icon-status').textContent = 'Upload failed: ' + (err && err.message || err); }
  });

  /* ── Gather / save ──────────────────────────────────────────────────── */
  function gather() {
    var name = val('ap-name');
    return {
      name: name,
      slug: val('ap-slug') || slugify(name),
      tagline: val('ap-tagline') || null,
      description: val('ap-desc') || null,
      category: val('ap-category') || null,
      status: val('ap-status'),
      launch_window: val('ap-window') || null,
      platforms: val('ap-platforms') || null,
      pricing: val('ap-pricing') || null,
      app_store_url: val('ap-store') || null,
      product_url: val('ap-product') || null,
      icon_url: val('ap-icon') || null,
      published: document.getElementById('ap-published').checked,
      layout: JSON.parse(JSON.stringify(sections))
    };
  }

  /* ── Unsaved-work guard ───────────────────────────────────────────
     Same contract as the article editor — see js/editor-guard.js for why the
     draft is mirrored to this device rather than autosaved to Postgres. */
  var FIELDS = ['ap-name','ap-slug','ap-tagline','ap-desc','ap-category','ap-status',
                'ap-window','ap-platforms','ap-pricing','ap-store','ap-product','ap-icon'];

  function snapshot() {
    var f = {};
    FIELDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) f[id] = el.value;
    });
    var pub = document.getElementById('ap-published');
    return {
      fields: f,
      published: !!(pub && pub.checked),
      slugManual: !!slugField._manual,
      sections: sections
    };
  }

  function restoreSnapshot(p) {
    var f = p.fields || {};
    FIELDS.forEach(function (id) { if (id in f) fill(id, f[id]); });
    var pub = document.getElementById('ap-published');
    if (pub) pub.checked = !!p.published;
    slugField._manual = !!p.slugManual;
    showIcon(f['ap-icon'] || '');
    sections = Array.isArray(p.sections) ? JSON.parse(JSON.stringify(p.sections)) : [];
    /* setBadge() reads app.status AND app.published, so both have to come back
       or the badge describes the row rather than the restored draft. */
    app.status = f['ap-status'] || app.status;
    app.published = !!p.published;
    setBadge(); updateUrl(); renderCanvas();
  }

  var guard = window.adminEditorGuard.create({
    kind:        'app',
    root:        document.querySelector('.ae-root'),
    status:      saveHint,
    publishHref: '/admin/settings',
    snapshot:    snapshot,
    restore:     restoreSnapshot,
    recordId:    function () { return app.id; },
    rowStamp:    function () { return app.updated_at; },
    save:        function (publish) { return save(publish); }
  });

  /* Hoisted so the section mutators above can call it regardless of order. */
  function markDirty() { if (guard) guard.markDirty(); }

  async function save(publish) {
    var data = gather();
    if (!data.name) { nameField.focus(); setHint('Add an app name first.', 'err'); return; }
    if (!data.slug) { slugField.focus(); setHint('Add a slug.', 'err'); return; }
    if (publish) { data.published = true; document.getElementById('ap-published').checked = true; }

    var saveBtn = document.getElementById('save-btn'), pubBtn = document.getElementById('publish-btn');
    saveBtn.disabled = pubBtn.disabled = true;
    setHint('Saving…');

    var q = app.id
      ? window.sb.from('apps').update(data).eq('id', app.id).select().single()
      : window.sb.from('apps').insert(data).select().single();
    var res = await q;
    saveBtn.disabled = pubBtn.disabled = false;

    if (res.error) { setHint('Save failed: ' + res.error.message, 'err'); return; }

    app.id = res.data.id;
    app.status = res.data.status;
    app.published = res.data.published;
    app.updated_at = res.data.updated_at;
    setBadge();
    /* Saving writes the row; the catalogue page only changes when the site is
       rebuilt, so say that and link to where it happens. */
    guard.markClean(publish ? 'Published to catalogue' : 'Saved');

    if (!params.get('id')) {
      params = new URLSearchParams({ id: app.id });
      window.history.replaceState(null, '', '/admin/apps-editor?id=' + encodeURIComponent(app.id));
    }
  }
  document.getElementById('save-btn').addEventListener('click', function () { save(false); });
  document.getElementById('publish-btn').addEventListener('click', function () { save(true); });

  /* ── Load ───────────────────────────────────────────────────────────── */
  function fill(id, v) { var el = document.getElementById(id); if (el) el.value = v == null ? '' : v; }

  async function load() {
    var id = params.get('id');
    if (!id) {
      sections = [blank('hero'), blank('feature')];
      app.status = statusField.value || 'in-development';
      setBadge(); renderCanvas(); updateUrl();
      guard.offerRecovery(document.querySelector('.ae-root'));
      return;
    }
    setHint('Loading…');
    var res = await window.sb.from('apps').select('*').eq('id', id).single();
    if (res.error) { setHint('Could not load: ' + res.error.message, 'err'); return; }
    var a = res.data;

    app.id = a.id; app.status = a.status; app.published = a.published;
    app.updated_at = a.updated_at;
    fill('ap-name', a.name); fill('ap-slug', a.slug); slugField._manual = true;
    fill('ap-tagline', a.tagline); fill('ap-desc', a.description);
    fill('ap-status', a.status || 'in-development'); fill('ap-window', a.launch_window);
    fill('ap-category', a.category || 'travel'); fill('ap-platforms', a.platforms);
    fill('ap-pricing', a.pricing); fill('ap-store', a.app_store_url);
    fill('ap-product', a.product_url); fill('ap-icon', a.icon_url);
    document.getElementById('ap-published').checked = !!a.published;
    showIcon(a.icon_url);

    sections = Array.isArray(a.layout) ? JSON.parse(JSON.stringify(a.layout)) : [];
    setBadge(); updateUrl(); renderCanvas();
    setHint('');
    /* After the row is in place, so a mirror older than the row is discarded
       instead of offered. */
    guard.offerRecovery(document.querySelector('.ae-root'));
  }

  /* ── Boot ───────────────────────────────────────────────────────────── */
  async function boot() {
    var s = await (window.adminReady || Promise.resolve(null));
    if (!s) return;
    load();
  }
  boot();
})();
