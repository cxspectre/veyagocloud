/* Newsletter capture — progressive enhancement for the first-party form rendered
   by tools/lib/newsletter-embed.js.

   PRIVACY: this script makes NO network request on page load. It only attaches a
   submit handler. A request to the newsletter provider happens solely when the
   visitor presses Subscribe — a consensual, disclosed hand-off. There is no
   third-party script and no tracker. The subscriber list lives in the newsletter
   tool, never on veyago.cloud (spec §1, §11).

   SETUP: the newsletter provider (Buttondown vs Ghost) is decided separately. Until
   then the form degrades to an email fallback. When you choose a provider, fill in
   CONFIG below. Examples:

     Buttondown (embeddable form, no secret needed):
       ENDPOINT: 'https://buttondown.com/api/emails/embed-subscribe/<your-username>'
       BODY: 'form'
     Ghost (Members magic-link subscribe):
       ENDPOINT: 'https://<your-ghost-site>/members/api/send-magic-link/'
       BODY: 'json'    // sends { email, emailType: 'subscribe' }
*/
(function () {
  'use strict';

  var CONFIG = {
    ENDPOINT: '',                 // '' → fallback mode (no provider wired yet)
    METHOD: 'POST',
    BODY: 'form',                 // 'form' (x-www-form-urlencoded) | 'json'
    EMAIL_FIELD: 'email',
    EXTRA_FIELDS: {},             // e.g. { emailType: 'subscribe' } for Ghost
    FALLBACK_EMAIL: 'hello@veyago.cloud',   // used when ENDPOINT is empty
    FALLBACK_URL: ''              // optional hosted subscribe page; preferred over mailto if set
  };

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function setStatus(form, msg, kind) {
    var el = form.querySelector('[data-newsletter-status]');
    if (!el) return;
    el.className = 'nl-status' + (kind ? ' nl-' + kind : '');
    el.innerHTML = msg;
  }

  function fallbackMessage() {
    if (CONFIG.FALLBACK_URL) {
      return 'Newsletter is launching shortly — <a href="' + CONFIG.FALLBACK_URL +
        '" target="_blank" rel="noopener">subscribe here</a> in the meantime.';
    }
    return 'Newsletter is launching shortly — email ' +
      '<a href="mailto:' + CONFIG.FALLBACK_EMAIL + '?subject=Subscribe%20me">' +
      CONFIG.FALLBACK_EMAIL + '</a> and we\'ll add you.';
  }

  function buildRequest(email) {
    var headers = {};
    var body;
    var fields = { };
    fields[CONFIG.EMAIL_FIELD] = email;
    Object.keys(CONFIG.EXTRA_FIELDS).forEach(function (k) { fields[k] = CONFIG.EXTRA_FIELDS[k]; });

    if (CONFIG.BODY === 'json') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(fields);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = Object.keys(fields).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(fields[k]);
      }).join('&');
    }
    return { headers: headers, body: body };
  }

  function onSubmit(form, e) {
    e.preventDefault();

    // Honeypot: real users never see/fill this. If it's filled, treat as success
    // (so a bot gets no signal) but send nothing.
    var hp = form.querySelector('input[name="website"]');
    if (hp && hp.value) { setStatus(form, 'Thanks — you\'re subscribed.', 'ok'); form.reset(); return; }

    var input = form.querySelector('input[type="email"]');
    var email = (input && input.value || '').trim();
    if (!EMAIL_RE.test(email)) {
      if (input) input.classList.add('nl-invalid');
      setStatus(form, 'Please enter a valid email address.', 'err');
      return;
    }
    if (input) input.classList.remove('nl-invalid');

    // No provider wired yet → graceful fallback, still zero silent calls.
    if (!CONFIG.ENDPOINT) { setStatus(form, fallbackMessage(), 'err'); return; }

    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    setStatus(form, 'Subscribing…', '');

    var req = buildRequest(email);
    fetch(CONFIG.ENDPOINT, {
      method: CONFIG.METHOD,
      headers: req.headers,
      body: req.body,
      mode: 'cors'
    }).then(function (res) {
      // Some providers (Buttondown embed) answer opaquely; treat reachable as ok.
      if (res.ok || res.type === 'opaque' || res.status === 0) {
        setStatus(form, 'Thanks — check your inbox to confirm.', 'ok');
        form.reset();
      } else {
        setStatus(form, 'Something went wrong (' + res.status + '). ' + fallbackMessage(), 'err');
        if (btn) btn.disabled = false;
      }
    }).catch(function () {
      setStatus(form, 'Could not reach the newsletter service. ' + fallbackMessage(), 'err');
      if (btn) btn.disabled = false;
    });
  }

  function init() {
    var forms = document.querySelectorAll('[data-newsletter-form]');
    for (var i = 0; i < forms.length; i++) {
      (function (form) {
        form.addEventListener('submit', function (e) { onSubmit(form, e); });
      })(forms[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
