/* side.js - which side of Veyago a shared page shows, settled before it paints.

   Every page is on the Private side (the apps), the Business side (what Veyago
   does for companies), or both: About, Team, Approach, Support and the legal
   pages. A shared page carries both menus and styles.css shows one of them by
   html[data-side]. This file, loaded blocking in the <head> of shared pages
   only, moves that attribute to the side the visitor was last on, so the menu
   never flickers from one to the other.

   The choice lives in localStorage ("veyago.side") and nowhere else: no
   cookie, nothing sent anywhere. Without storage, or without this script, the
   page simply shows the side written into its HTML. app.js does the rest -
   remembering the side of every page visited, and the switch's keyboard. */
(function () {
  'use strict';
  var root = document.documentElement;
  if (root.hasAttribute('data-page-side')) return;   // a page with a side of its own keeps it
  var side = null;
  try { side = window.localStorage.getItem('veyago.side'); } catch (e) { return; }
  if (side === 'private' || side === 'business') root.setAttribute('data-side', side);
})();
