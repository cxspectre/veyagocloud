/* Paste cleaning for the rich-text blocks in both editors.

   THE BUG THIS FIXES. tools/lib/sanitize.js allows exactly p, strong, em, a,
   ul, ol, li and br, and runs at BUILD time, in Node. Neither editor had a
   paste listener, so pasting from Word, Notion or a web page stored whatever
   the browser produced — h2s, imgs, tables, spans with inline styles — verbatim
   in Postgres. The canvas then rendered it with the real /styles.css, so it
   looked right; the author approved what they saw and published; and the build
   silently deleted it. The work survived a correct Save and a correct Publish
   and disappeared anyway.

   Cleaning at paste time does not remove a capability — the build was always
   going to strip it. It moves the loss from invisible-and-later to
   visible-and-now, and says what went, which is the difference between an
   editor that lies to you and one that does not.

   THE ALLOWLIST IS DUPLICATED HERE ON PURPOSE. sanitize.js cannot be imported:
   it requires jsdom and dompurify and its own header says it is "never shipped
   to the browser". paste-clean.test.js asserts the two lists are identical by
   reading both files, and compares the output of both sanitisers over a corpus
   of real paste payloads — so the copy cannot drift without a test failing. */
(function () {
  'use strict';

  /* Must equal ALLOWED_TAGS in tools/lib/sanitize.js. */
  var ALLOWED = ['p', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'br'];

  /* Everything else is dropped, but a disallowed element's TEXT is kept —
     matching DOMPurify's KEEP_CONTENT default, which is what the build uses.
     So <h2>Title</h2> arrives as the words "Title", not as nothing. */
  var VOID_DROP = ['img', 'video', 'audio', 'iframe', 'object', 'embed', 'input', 'svg'];

  /* Tags whose content is markup rather than prose. Keeping their text would
     paste stylesheet rules and script bodies into the article as words. */
  var DROP_WITH_CONTENT = ['script', 'style', 'noscript', 'head', 'title', 'meta', 'link'];

  function allowedHref(v) {
    var s = String(v || '').trim();
    if (!s) return null;
    /* Relative paths and anchors are fine and cannot change origin. */
    if (s.charAt(0) === '/' || s.charAt(0) === '#') return s;
    return /^(https?:|mailto:)/i.test(s) ? s : null;
  }

  /* Returns { html, dropped } where dropped maps a tag name to how many were
     removed, so the caller can say something specific rather than "formatting
     was lost". */
  function clean(html) {
    var dropped = {};
    function note(tag) { dropped[tag] = (dropped[tag] || 0) + 1; }

    /* <template> parses markup without running anything: no image request, no
       script, no side effect. Never assign untrusted HTML to a live element. */
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');

    function walk(node) {
      var child = node.firstChild;
      while (child) {
        var next = child.nextSibling;

        if (child.nodeType === 3) {                       // text — always keep
          child = next; continue;
        }
        if (child.nodeType !== 1) {                       // comments etc.
          node.removeChild(child); child = next; continue;
        }

        var tag = child.tagName.toLowerCase();

        if (DROP_WITH_CONTENT.indexOf(tag) !== -1 || VOID_DROP.indexOf(tag) !== -1) {
          note(tag);
          node.removeChild(child);
          child = next; continue;
        }

        walk(child);

        if (ALLOWED.indexOf(tag) === -1) {
          /* Unwrap: keep the words, lose the element. */
          note(tag);
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          child = next; continue;
        }

        /* Strip every attribute, then put back only what the build keeps. */
        var href = tag === 'a' ? allowedHref(child.getAttribute('href')) : null;
        var attrs = Array.prototype.map.call(child.attributes, function (a) { return a.name; });
        attrs.forEach(function (n) { child.removeAttribute(n); });

        if (tag === 'a') {
          if (href) {
            child.setAttribute('href', href);
            /* Same two attributes the build's afterSanitizeAttributes hook adds. */
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
          } else {
            /* A link that cannot be trusted becomes its own text rather than a
               dead or dangerous anchor. */
            note('a');
            while (child.firstChild) node.insertBefore(child.firstChild, child);
            node.removeChild(child);
            child = next; continue;
          }
        }

        child = next;
      }
    }

    walk(tpl.content);
    return { html: tpl.innerHTML, dropped: dropped };
  }

  /* "2 headings and an image" rather than "some formatting". */
  function describe(dropped) {
    var NAMES = {
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
      h5: 'heading', h6: 'heading', img: 'image', table: 'table',
      blockquote: 'quote', pre: 'code block', hr: 'divider'
    };
    var counts = {};
    Object.keys(dropped).forEach(function (tag) {
      var name = NAMES[tag];
      if (!name) return;                 // spans, divs and fonts are not news
      counts[name] = (counts[name] || 0) + dropped[tag];
    });
    var parts = Object.keys(counts).map(function (n) {
      return counts[n] + ' ' + n + (counts[n] === 1 ? '' : 's');
    });
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  /* Wire every contenteditable inside `root`. onNote is called with a sentence
     when something worth mentioning was removed. */
  function attach(root, onNote) {
    if (!root) return;
    root.addEventListener('paste', function (e) {
      var target = e.target;
      if (!target || !target.isContentEditable) return;

      var cb = e.clipboardData || window.clipboardData;
      if (!cb) return;

      var html = cb.getData('text/html');
      var text = cb.getData('text/plain');

      e.preventDefault();

      if (!html) {
        /* Plain text still needs intercepting: the browser would otherwise
           insert it with the surrounding block's formatting inherited. */
        document.execCommand('insertText', false, text || '');
        return;
      }

      var out = clean(html);
      document.execCommand('insertHTML', false, out.html);

      var note = describe(out.dropped);
      if (note && onNote) {
        onNote('Pasted — ' + note + ' removed. Articles only carry paragraphs, ' +
               'bold, italic, links and lists; add the rest as their own blocks.');
      }
    }, true);
  }

  window.adminPasteClean = { clean: clean, attach: attach, describe: describe, ALLOWED: ALLOWED };
})();
