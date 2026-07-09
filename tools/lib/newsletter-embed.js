/* Server-rendered markup for the newsletter capture block (spec §11). It is a
   plain first-party <form> — it makes NO network call on page load. The companion
   /assets/js/newsletter.js progressively enhances it: on submit only, it posts to
   the configured provider (Buttondown/Ghost). Honeypot field guards against bots.
   Used at the foot of every journal article and on the wallpapers page. */
'use strict';

var { esc, attr } = require('./escape');

function newsletterSection(opts) {
  opts = opts || {};
  var id = opts.id || 'nl';
  var heading = opts.heading || 'Get the next one in your inbox';
  var dek = opts.dek || 'Occasional field notes from the studio. No spam, unsubscribe anytime.';
  var note = opts.note || 'We hand your email to our newsletter tool only when you subscribe — never stored here, never sold.';
  var inputId = 'nl-email-' + id;
  return `<section class="newsletter" data-newsletter aria-labelledby="nl-h-${attr(id)}">
          <div class="nl-inner">
            <p class="eyebrow">Newsletter</p>
            <h2 class="nl-heading" id="nl-h-${attr(id)}">${esc(heading)}</h2>
            <p class="nl-dek">${esc(dek)}</p>
            <form class="nl-form" data-newsletter-form novalidate>
              <label class="nl-label" for="${attr(inputId)}">Email address</label>
              <div class="nl-row">
                <input class="nl-input" id="${attr(inputId)}" type="email" name="email" autocomplete="email" placeholder="you@example.com" required />
                <button class="nl-btn" type="submit">Subscribe</button>
              </div>
              <div class="nl-hp" aria-hidden="true">
                <label>Leave this field empty<input type="text" name="website" tabindex="-1" autocomplete="off" /></label>
              </div>
              <p class="nl-note">${esc(note)}</p>
              <p class="nl-status" data-newsletter-status role="status" aria-live="polite"></p>
            </form>
          </div>
        </section>`;
}

module.exports = { newsletterSection };
