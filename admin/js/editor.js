/* A lean first-party block editor. Produces the article block schema directly
   (the same array tools/lib/render-blocks.js renders) — no third-party editor,
   no adapter. Block types: section_marker, heading, text, image, quote, divider.

   Usage:
     var ed = window.BlockEditor(document.getElementById('editor'));
     ed.load(existingBlocks);        // [] for a new article
     var blocks = ed.serialize();    // → schema array, ready to store in articles.body
*/
window.BlockEditor = function (container) {
  'use strict';

  var blocks = [];
  var blocksEl, addBarEl;

  var TYPES = [
    { type: 'section_marker', label: 'Marker' },
    { type: 'heading', label: 'Heading' },
    { type: 'text', label: 'Text' },
    { type: 'image', label: 'Image' },
    { type: 'quote', label: 'Quote' },
    { type: 'divider', label: 'Divider' }
  ];

  function blank(type) {
    if (type === 'heading') return { type: 'heading', level: 2, text: '' };
    if (type === 'image') return { type: 'image', url: '', alt: '', caption: '' };
    if (type === 'quote') return { type: 'quote', text: '', attribution: '' };
    if (type === 'divider') return { type: 'divider' };
    if (type === 'section_marker') return { type: 'section_marker', text: '' };
    return { type: 'text', html: '' };
  }

  /* execCommand emits <b>/<i>/<div>; map to the allowlisted tags so formatting
     survives the build-time sanitiser (which keeps only p,strong,em,a,ul,ol,li,br). */
  function cleanRich(html) {
    return String(html || '')
      .replace(/<b(\s[^>]*)?>/gi, '<strong>').replace(/<\/b>/gi, '</strong>')
      .replace(/<i(\s[^>]*)?>/gi, '<em>').replace(/<\/i>/gi, '</em>')
      .replace(/<div(\s[^>]*)?>/gi, '<p>').replace(/<\/div>/gi, '</p>')
      .trim();
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function move(i, delta) {
    var j = i + delta;
    if (j < 0 || j >= blocks.length) return;
    var tmp = blocks[i]; blocks[i] = blocks[j]; blocks[j] = tmp;
    render();
  }
  function remove(i) { blocks.splice(i, 1); render(); }
  function add(type) { blocks.push(blank(type)); render(); }

  // --- per-type body builders (wire inputs straight to the model) ---
  function bodyFor(b, i) {
    var body = el('div', 'block-body');

    if (b.type === 'divider') {
      body.appendChild(el('div', 'block-divider', '— hairline divider —'));
      return body;
    }

    if (b.type === 'section_marker') {
      var mi = el('input', 'input');
      mi.type = 'text'; mi.placeholder = 'FIELD NOTES'; mi.value = b.text || '';
      mi.addEventListener('input', function () { b.text = mi.value; });
      body.appendChild(mi);
      return body;
    }

    if (b.type === 'heading') {
      var wrap = el('div', 'row-2');
      var sel = el('select', 'select');
      sel.innerHTML = '<option value="2">Heading (H2)</option><option value="3">Subheading (H3)</option>';
      sel.value = String(b.level || 2);
      sel.addEventListener('change', function () { b.level = parseInt(sel.value, 10) || 2; });
      var hi = el('input', 'input');
      hi.type = 'text'; hi.placeholder = 'Heading text'; hi.value = b.text || '';
      hi.addEventListener('input', function () { b.text = hi.value; });
      wrap.appendChild(sel); wrap.appendChild(hi);
      body.appendChild(wrap);
      return body;
    }

    if (b.type === 'text') {
      var tb = el('div', 'rt-toolbar');
      [['B', 'bold'], ['I', 'italic'], ['Link', 'createLink'], ['• List', 'insertUnorderedList'], ['1. List', 'insertOrderedList']]
        .forEach(function (pair) {
          var btn = el('button', null, pair[0]); btn.type = 'button';
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            area.focus();
            if (pair[1] === 'createLink') {
              var url = window.prompt('Link URL (https://…)');
              if (url) document.execCommand('createLink', false, url);
            } else {
              document.execCommand(pair[1], false, null);
            }
            b.html = cleanRich(area.innerHTML);
          });
          tb.appendChild(btn);
        });
      var area = el('div', 'rt-area');
      area.setAttribute('contenteditable', 'true');
      area.setAttribute('role', 'textbox');
      area.setAttribute('aria-multiline', 'true');
      area.innerHTML = b.html || '';
      try { document.execCommand('styleWithCSS', false, false); } catch (e) {}
      try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}
      area.addEventListener('input', function () { b.html = cleanRich(area.innerHTML); });
      area.addEventListener('blur', function () { b.html = cleanRich(area.innerHTML); });
      body.appendChild(tb);
      body.appendChild(area);
      return body;
    }

    if (b.type === 'image') {
      var urlField = el('div', 'field');
      urlField.innerHTML = '<label>Image URL</label>';
      var ui = el('input', 'input'); ui.type = 'text'; ui.placeholder = 'https://… or upload below'; ui.value = b.url || '';
      ui.addEventListener('input', function () { b.url = ui.value; });
      urlField.appendChild(ui);

      var fileField = el('div', 'field');
      fileField.innerHTML = '<label>…or upload to article-media</label>';
      var fi = el('input'); fi.type = 'file'; fi.accept = 'image/*';
      var status = el('span', 'hint', '');
      fi.addEventListener('change', async function () {
        if (!fi.files || !fi.files[0]) return;
        status.textContent = 'Uploading…';
        try {
          var url = await window.admin.upload('article-media', fi.files[0], 'inline');
          b.url = url; ui.value = url; status.textContent = 'Uploaded.';
        } catch (err) { status.textContent = 'Upload failed: ' + (err && err.message || err); }
      });
      fileField.appendChild(fi); fileField.appendChild(status);

      var altField = el('div', 'field');
      altField.innerHTML = '<label>Alt text</label>';
      var ai = el('input', 'input'); ai.type = 'text'; ai.value = b.alt || '';
      ai.addEventListener('input', function () { b.alt = ai.value; });
      altField.appendChild(ai);

      var capField = el('div', 'field');
      capField.innerHTML = '<label>Caption (optional)</label>';
      var ci = el('input', 'input'); ci.type = 'text'; ci.value = b.caption || '';
      ci.addEventListener('input', function () { b.caption = ci.value; });
      capField.appendChild(ci);

      body.appendChild(urlField); body.appendChild(fileField);
      body.appendChild(altField); body.appendChild(capField);
      return body;
    }

    if (b.type === 'quote') {
      var qf = el('div', 'field'); qf.innerHTML = '<label>Quote</label>';
      var qt = el('textarea', 'textarea'); qt.value = b.text || '';
      qt.addEventListener('input', function () { b.text = qt.value; });
      qf.appendChild(qt);
      var af = el('div', 'field'); af.innerHTML = '<label>Attribution (optional)</label>';
      var at = el('input', 'input'); at.type = 'text'; at.value = b.attribution || '';
      at.addEventListener('input', function () { b.attribution = at.value; });
      af.appendChild(at);
      body.appendChild(qf); body.appendChild(af);
      return body;
    }

    return body;
  }

  function blockRow(b, i) {
    var row = el('div', 'block');
    var head = el('div', 'block-head');
    head.appendChild(el('span', 'block-type', b.type.replace('_', ' ')));
    var ctrls = el('div', 'block-ctrls');
    [['↑', function () { move(i, -1); }], ['↓', function () { move(i, 1); }], ['✕', function () { remove(i); }]]
      .forEach(function (pair) {
        var btn = el('button', 'icon-btn', pair[0]); btn.type = 'button';
        btn.title = pair[0] === '✕' ? 'Delete' : 'Move';
        btn.addEventListener('click', pair[1]);
        ctrls.appendChild(btn);
      });
    head.appendChild(ctrls);
    row.appendChild(head);
    row.appendChild(bodyFor(b, i));
    return row;
  }

  function render() {
    blocksEl.innerHTML = '';
    if (!blocks.length) {
      blocksEl.appendChild(el('p', 'empty', 'No blocks yet — add one below.'));
    } else {
      blocks.forEach(function (b, i) { blocksEl.appendChild(blockRow(b, i)); });
    }
  }

  function buildAddBar() {
    addBarEl = el('div', 'add-block');
    addBarEl.appendChild(el('span', 'label', 'Add block:'));
    TYPES.forEach(function (t) {
      var btn = el('button', 'btn btn-sm', t.label); btn.type = 'button';
      btn.addEventListener('click', function () { add(t.type); });
      addBarEl.appendChild(btn);
    });
  }

  // --- mount ---
  blocksEl = el('div', 'blocks');
  buildAddBar();
  container.appendChild(blocksEl);
  container.appendChild(addBarEl);
  render();

  return {
    load: function (arr) { blocks = Array.isArray(arr) ? JSON.parse(JSON.stringify(arr)) : []; render(); },
    serialize: function () {
      // drop empties so we don't persist blank blocks
      return blocks.filter(function (b) {
        if (b.type === 'divider') return true;
        if (b.type === 'image') return !!b.url;
        if (b.type === 'text') return !!cleanRich(b.html);
        if (b.type === 'quote') return !!(b.text && b.text.trim());
        return !!((b.text || '').trim());
      }).map(function (b) {
        if (b.type === 'text') return { type: 'text', html: cleanRich(b.html) };
        return JSON.parse(JSON.stringify(b));
      });
    }
  };
};
