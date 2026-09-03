/* enquiry.js - the "Get a quote" form on /websites/ and /services/.

   First-party by design. Nothing is called on page load; the only request this
   file ever makes is the POST when someone presses Send, and it goes to our own
   Supabase Edge Function (website-enquiry), which relays it to us through Resend.
   No third-party form provider, no analytics, no tracking pixel.

   If the endpoint is unreachable, or ENDPOINT is left empty, the form degrades
   to a mailto: link pre-filled with what the visitor typed - the same path the
   site used before this form existed, so nothing is ever lost. */
(function () {
  'use strict';

  var CONFIG = {
    ENDPOINT: 'https://vtbvhhilucxroqoaohjb.supabase.co/functions/v1/website-enquiry',
    FALLBACK_EMAIL: 'hello@veyago.cloud',
    MIN_SECONDS: 3          // a real person needs at least this long to fill the form
  };

  var forms = document.querySelectorAll('form[data-enquiry]');
  if (!forms.length) return;

  /* Status copy lives in the page as hidden text (see .enq-msgs) rather than in
     this file, so the site's language switcher translates it like everything
     else. This reads it back by key. */
  function msg(form, key, fallback) {
    var el = form.querySelector('[data-msg="' + key + '"]');
    return (el && el.textContent.trim()) || fallback;
  }

  function setStatus(form, text, kind) {
    var box = form.querySelector('.enq-status');
    if (!box) return;
    box.textContent = text;
    box.className = 'enq-status' + (kind ? ' enq-' + kind : '');
    box.hidden = !text;
  }

  function val(form, name) {
    var el = form.elements[name];
    return el ? String(el.value || '').trim() : '';
  }

  function markInvalid(form, name, invalid) {
    var el = form.elements[name];
    if (!el) return;
    el.classList.toggle('enq-invalid', !!invalid);
    if (invalid) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* Same rules the Edge Function enforces, applied first so a typo gets an
     instant, specific message instead of a round trip. */
  function validate(form) {
    var problems = [];
    var name = val(form, 'name');
    var email = val(form, 'email');
    var website = val(form, 'website');

    markInvalid(form, 'name', name.length < 2);
    if (name.length < 2) problems.push('name');

    markInvalid(form, 'email', !EMAIL_RE.test(email));
    if (!EMAIL_RE.test(email)) problems.push('email');

    var badSite = website && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(website);
    markInvalid(form, 'website', badSite);
    if (badSite) problems.push('website');

    return problems;
  }

  function payload(form) {
    return {
      kind: form.getAttribute('data-enquiry') || 'website',
      name: val(form, 'name'),
      email: val(form, 'email'),
      business: val(form, 'business'),
      website: val(form, 'website'),
      message: val(form, 'message'),
      hp_ref: val(form, 'hp_ref'),                         // honeypot - stays empty for humans
      t: Number(form.getAttribute('data-rendered-at') || 0), // when the form was drawn
      locale: document.documentElement.lang || 'en',
      page: location.pathname
    };
  }

  /* The pre-filled mailto: the form falls back to. Body is plain text; the
     visitor sees exactly what will be sent. */
  function mailtoHref(form) {
    var p = payload(form);
    var subject = (p.kind === 'product' ? 'Project enquiry' : 'Website enquiry') + (p.business ? ' - ' + p.business : '');
    var lines = [
      'Name: ' + p.name,
      'Email: ' + p.email,
      p.business ? 'Business: ' + p.business : '',
      p.website ? 'Current site: ' + p.website : ''
    ].filter(Boolean);
    var body = lines.join('\n') + (p.message ? '\n\n' + p.message : '');
    return 'mailto:' + CONFIG.FALLBACK_EMAIL +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
  }

  function showFallback(form, text) {
    var box = form.querySelector('.enq-status');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(document.createTextNode(text + ' '));
    var a = document.createElement('a');
    a.href = mailtoHref(form);
    a.textContent = msg(form, 'fallback-link', 'Send it by email instead');
    box.appendChild(a);
    box.className = 'enq-status enq-err';
    box.hidden = false;
  }

  function showSuccess(form) {
    var done = form.querySelector('.enq-done');
    var fields = form.querySelector('.enq-fields');
    if (fields) fields.hidden = true;
    setStatus(form, '', null);
    if (done) {
      done.hidden = false;
      done.setAttribute('tabindex', '-1');
      done.focus();
    }
  }

  function onSubmit(form, e) {
    e.preventDefault();
    var problems = validate(form);
    if (problems.length) {
      setStatus(form, msg(form, 'invalid', 'Please check the highlighted fields.'), 'err');
      var first = form.elements[problems[0]];
      if (first && first.focus) first.focus();
      return;
    }

    var p = payload(form);
    /* Bots fill hidden fields and submit instantly. Humans do neither. Say
       nothing revealing - just quietly take the fallback path. */
    var tooFast = p.t && (Date.now() - p.t) / 1000 < CONFIG.MIN_SECONDS;
    if (p.hp_ref || tooFast) { showFallback(form, msg(form, 'error', 'That didn\'t go through.')); return; }

    if (!CONFIG.ENDPOINT || typeof fetch !== 'function') {
      showFallback(form, msg(form, 'error', 'That didn\'t go through.'));
      return;
    }

    var button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    setStatus(form, msg(form, 'sending', 'Sending…'), 'busy');

    var timer = null;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) timer = setTimeout(function () { controller.abort(); }, 15000);

    fetch(CONFIG.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(p),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.ok && body && body.ok) { showSuccess(form); return; }
        if (res.status === 429) { showFallback(form, msg(form, 'rate-limited', 'Too many messages from this address just now.')); return; }
        if (res.status === 400 && body && body.field && form.elements[body.field]) {
          markInvalid(form, body.field, true);
          setStatus(form, msg(form, 'invalid', body.error || 'Please check the highlighted fields.'), 'err');
          form.elements[body.field].focus();
          return;
        }
        if (res.status === 400 && body && body.error) { setStatus(form, body.error, 'err'); return; }
        showFallback(form, msg(form, 'error', 'That didn\'t go through.'));
      });
    }).catch(function () {
      showFallback(form, msg(form, 'error', 'That didn\'t go through.'));
    }).then(function () {
      if (timer) clearTimeout(timer);
      if (button) button.disabled = false;
    });
  }

  Array.prototype.forEach.call(forms, function (form) {
    form.setAttribute('data-rendered-at', String(Date.now()));
    form.setAttribute('novalidate', '');
    form.addEventListener('submit', function (e) { onSubmit(form, e); });
    ['name', 'email', 'website'].forEach(function (n) {
      var el = form.elements[n];
      if (el) el.addEventListener('input', function () { markInvalid(form, n, false); });
    });
  });
})();
