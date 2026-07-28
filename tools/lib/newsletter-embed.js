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
  /* The copy is written for the state the product is actually in. Until a
     provider is configured in assets/js/newsletter.js, submitting does not
     subscribe anyone — it shows an address to write to, and somebody adds you
     by hand. Promising "the next one in your inbox" was a commitment nothing
     could keep. Restore the stronger wording when ENDPOINT is set. */
  var heading = opts.heading || 'Want the next one?';
  var dek = opts.dek || 'Occasional field notes from the studio. Leave your address and we will add you by hand — no list software, no spam, and a reply to unsubscribe.';
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
                <button class="nl-btn" type="submit">Send it to me</button>
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
