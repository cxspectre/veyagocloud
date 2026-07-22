/* Projects R&D admin. */
(function () {
  'use strict';
  var listEl  = document.getElementById('proj-list');
  var formEl  = document.getElementById('proj-form');
  var msg     = document.getElementById('msg');
  var current = { id: null };

  var F = {
    name:       document.getElementById('pr-name'),
    stage:      document.getElementById('pr-stage'),
    question:   document.getElementById('pr-question'),
    finding:    document.getElementById('pr-finding'),
    essayTitle: document.getElementById('pr-essay-title'),
    essaySlug:  document.getElementById('pr-essay-slug'),
    relLabel:   document.getElementById('pr-rel-label'),
    relHref:    document.getElementById('pr-rel-href'),
    published:  document.getElementById('pr-published')
  };

  function setMsg(t, k) { if (!msg) return; msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); }

  async function load() {
    var res = await window.sb.from('projects').select('*').order('sort_order,created_at');
    if (res.error) { setMsg('Could not load: ' + res.error.message, 'err'); return; }
    render(res.data || []);
  }

  var STAGE_LABELS = { researching: 'Researching', prototyping: 'Prototyping', building: 'Building', graduated: 'Graduated' };

  function render(rows) {
    if (!listEl) return;
    if (!rows.length) { listEl.innerHTML = '<li class="adm-empty"><p>No projects yet.</p></li>'; return; }
    listEl.innerHTML = '';
    rows.forEach(function (p) {
      var li = document.createElement('li'); li.className = 'adm-item';
      var icon = document.createElement('div'); icon.className = 'adm-item-icon'; icon.textContent = '◇';
      var main = document.createElement('div'); main.className = 'adm-item-main';
      var t = document.createElement('div'); t.className = 'adm-item-title'; t.textContent = p.name;
      var s = document.createElement('div'); s.className = 'adm-item-sub';
      s.textContent = (STAGE_LABELS[p.stage] || p.stage) + (p.essay_slug ? ' · paper: /' + p.essay_slug : '') + (p.related_label ? ' → ' + p.related_label : '');
      main.appendChild(t); main.appendChild(s);
      var acts = document.createElement('div'); acts.className = 'adm-item-acts';
      var badge = document.createElement('span'); badge.className = 'badge badge-' + p.stage; badge.textContent = STAGE_LABELS[p.stage] || p.stage;
      var pub = document.createElement('span'); pub.className = 'badge ' + (p.published ? 'badge-published' : 'badge-draft'); pub.textContent = p.published ? 'Published' : 'Hidden';
      var editBtn = document.createElement('button'); editBtn.className = 'btn btn-sm'; editBtn.type = 'button'; editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { openForm(p); });
      acts.appendChild(badge); acts.appendChild(pub); acts.appendChild(editBtn);
      li.appendChild(icon); li.appendChild(main); li.appendChild(acts);
      listEl.appendChild(li);
    });
  }

  function openForm(p) {
    current.id = p ? p.id : null;
    F.name.value = p ? (p.name || '') : '';
    F.stage.value = p ? (p.stage || 'researching') : 'researching';
    F.question.value = p ? (p.question || '') : '';
    F.finding.value = p ? (p.finding || '') : '';
    F.essayTitle.value = p ? (p.essay_title || '') : '';
    F.essaySlug.value = p ? (p.essay_slug || '') : '';
    F.relLabel.value = p ? (p.related_label || '') : '';
    F.relHref.value = p ? (p.related_href || '') : '';
    F.published.checked = p ? !!p.published : false;
    document.getElementById('form-title').textContent = p ? 'Edit project' : 'New project';
    document.getElementById('pr-delete').hidden = !p;
    formEl.hidden = false;
    formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeForm() { formEl.hidden = true; current.id = null; }

  async function save() {
    var name = F.name.value.trim();
    if (!name) { F.name.focus(); return; }
    var slugify = function (s) { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); };
    var data = { name: name, slug: slugify(name), stage: F.stage.value, question: F.question.value.trim() || null, finding: F.finding.value.trim() || null, essay_title: F.essayTitle.value.trim() || null, essay_slug: F.essaySlug.value.trim() || null, related_label: F.relLabel.value.trim() || null, related_href: F.relHref.value.trim() || null, published: F.published.checked };
    var q = current.id ? window.sb.from('projects').update(data).eq('id', current.id) : window.sb.from('projects').insert(data);
    var res = await q;
    if (res.error) { setMsg('Save failed: ' + res.error.message, 'err'); return; }
    setMsg('Saved.', 'ok'); closeForm(); load();
  }

  async function remove() {
    if (!current.id || !confirm('Delete this project?')) return;
    var res = await window.sb.from('projects').delete().eq('id', current.id);
    if (res.error) { setMsg(res.error.message, 'err'); return; }
    closeForm(); load();
  }

  document.getElementById('new-btn').addEventListener('click', function () { openForm(null); });
  document.getElementById('pr-save').addEventListener('click', save);
  document.getElementById('pr-cancel').addEventListener('click', closeForm);
  document.getElementById('pr-delete').addEventListener('click', remove);
  /* adminReady is a promise — immune to the event-vs-registration race that
     left pages blank when Supabase resolved the session early. */
  window.adminReady.then(function (s) { if (s) load(); });
})();
