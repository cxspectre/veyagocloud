/* Veyago — lightweight, dependency-free interactions. */
(function () {
  'use strict';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Footer year */
  var yEl = document.getElementById('year');
  if (yEl) yEl.textContent = new Date().getFullYear();

  /* Scroll-reveal (in-page anchor offset handled in CSS via scroll-margin-top) */
  var reveals = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.16, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* Per-group stagger index → drives --i in the reveal transition-delay */
  document.querySelectorAll('.svc-grid,.stats,.steps,.app-grid,.tile-row,.proc').forEach(function (g) {
    [].forEach.call(g.children, function (el, i) {
      if (el.classList.contains('reveal')) el.style.setProperty('--i', i);
    });
  });

  if (!reduced) {
    /* Nav elevation + scroll-progress, one rAF-throttled handler */
    var nav = document.querySelector('.nav'),
        bar = document.querySelector('.scroll-progress'),
        ticking = false;
    function onScroll() {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () {
        var yy = window.scrollY,
            h = document.documentElement.scrollHeight - window.innerHeight;
        if (nav) nav.classList.toggle('scrolled', yy > 8);
        if (bar) bar.style.setProperty('--p', h > 0 ? (yy / h).toFixed(4) : 0);
        ticking = false;
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    /* Phone tilt — pointer only, capped ±6° */
    document.querySelectorAll('.panel-media').forEach(function (m) {
      var p = m.querySelector('.phone'); if (!p) return;
      m.addEventListener('pointermove', function (e) {
        var r = m.getBoundingClientRect();
        p.style.setProperty('--ry', (((e.clientX - r.left) / r.width - 0.5) * 12).toFixed(2) + 'deg');
        p.style.setProperty('--rx', (-((e.clientY - r.top) / r.height - 0.5) * 12).toFixed(2) + 'deg');
      });
      m.addEventListener('pointerleave', function () {
        p.style.setProperty('--ry', '0deg'); p.style.setProperty('--rx', '0deg');
      });
    });
  }
})();
