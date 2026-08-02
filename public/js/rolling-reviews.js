/* Rolling Google reviews carousel — ONE component for every public page.
 *
 * 2026-07-31: the homepage had this inline while service + city pages ran an
 * older static 4-card block against /public/google-reviews. Two implementations
 * of the same thing drift (they already had), and the static block never showed
 * a review Tyler earned after it was written. This file is now the only copy.
 *
 * Contract — a page opts in by having:
 *   <div class="rev-grid" id="revGrid"> …curated fallback cards… </div>
 * and loading this script. On success the curated cards are REPLACED by the
 * live synced corpus; on any failure they stay exactly as they are (fails soft
 * — a marketing page must never render an empty or broken review section).
 *
 * Also fills any element with id="badgeReviewCount" / id="trustReviewCount" or
 * [data-review-count] with the live aggregate, and hides [data-review-count]
 * elements when the count is unavailable rather than leaving a stale number.
 *
 * Review text is rendered VERBATIM (escaped, truncated at a word boundary with
 * an ellipsis). Never edit, summarize, or fabricate review content, and always
 * keep the "Posted on Google" attribution.
 *
 * NOTE: /js/*.js is edge-cached immutable — bump the ?v=N on every <script src>
 * when this file changes, or pages will keep serving the old copy.
 */
(function () {
  var API = 'https://purecleaning-api.tylerfumero.workers.dev';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function truncate(s, n) {
    s = String(s || '');
    if (s.length <= n) return s;
    var cut = s.slice(0, n), sp = cut.lastIndexOf(' ');
    return (sp > 40 ? cut.slice(0, sp) : cut).replace(/\s+$/, '') + '…';
  }
  function relDate(iso) {
    if (!iso) return '';
    var days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (isNaN(days) || days < 1) return 'recently';
    if (days < 7)   return days + (days === 1 ? ' day ago' : ' days ago');
    if (days < 30)  { var w = Math.floor(days / 7);   return w + (w === 1 ? ' week ago'  : ' weeks ago'); }
    if (days < 365) { var m = Math.floor(days / 30);  return m + (m === 1 ? ' month ago' : ' months ago'); }
    var y = Math.floor(days / 365); return y + (y === 1 ? ' year ago' : ' years ago');
  }

  // Injected so service/city pages don't each need the CSS. Colour vars are
  // given literal fallbacks — only index.html defines --navy2/--gold.
  function injectCss() {
    if (document.getElementById('rr-css')) return;
    var st = document.createElement('style');
    st.id = 'rr-css';
    st.textContent = [
      '.rr-card{display:flex;flex-direction:column}',
      '.rr-top{display:flex;justify-content:space-between;align-items:center}',
      '.rr-date{font-size:12px;color:#8ea1bd;font-weight:600}',
      '.rr-card p{flex:1}',
      '.rr-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1)}',
      '.rr-foot .who{margin-top:0}',
      '.rr-google{font-size:11.5px;color:#8ea1bd;font-weight:600}',
      '.rev-grid.rr-live{transition:opacity .35s ease}',
      '.rr-nav{display:flex;justify-content:center;align-items:center;gap:14px;margin-top:22px}',
      '.rr-arrow{width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.22);background:var(--navy2,#102341);color:#fff;font-size:18px;font-weight:800;cursor:pointer;line-height:1;padding:0}',
      '.rr-arrow:hover{background:#16305a}',
      '.rr-dots{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;max-width:60%}',
      '.rr-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.28);border:none;cursor:pointer;padding:0}',
      '.rr-dot.on{background:var(--gold,#f59e0b);width:22px;border-radius:4px}',
      '.rr-agg{text-align:center;margin-top:20px}',
      '.rr-agg a{font-weight:800;text-decoration:none;font-size:15.5px;border-bottom:2px solid var(--gold,#f59e0b);padding-bottom:2px}',
      // Theme-scoped bits. The homepage renders this section on dark navy; the
      // service + city pages render it on a light background. Colours that are
      // legible on one are invisible on the other (a white "See all…" link on a
      // white section), so the palette is chosen from the measured background
      // rather than assumed.
      '.rr-dark .rr-foot{border-top:1px solid rgba(255,255,255,.1)}',
      '.rr-dark .rr-date,.rr-dark .rr-google{color:#8ea1bd}',
      '.rr-dark-agg a{color:#fff}',
      '.rr-light .rr-foot{border-top:1px solid rgba(15,23,42,.12)}',
      '.rr-light .rr-date,.rr-light .rr-google{color:#64748b}',
      '.rr-light-agg a{color:#0f172a}',
      '.rr-light .rr-arrow{background:#0f172a;border-color:rgba(15,23,42,.25);color:#fff}',
      '.rr-light .rr-dot{background:rgba(15,23,42,.25)}',
    ].join('');
    document.head.appendChild(st);
  }

  // Live aggregate into any count placeholder. Hiding beats showing a stale or
  // wrong number, so a missing count removes the element instead of leaving
  // whatever was hardcoded in the HTML.
  function applyCount(count) {
    var ids = ['badgeReviewCount', 'trustReviewCount', 'aboutReviewCount', 'aboutReviewCount2'];
    var ok = typeof count === 'number' && count > 0;
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (!el) continue;
      if (ok) el.textContent = String(count);
      else if (el.hasAttribute('data-hide-if-unknown')) el.style.display = 'none';
    }
    var nodes = document.querySelectorAll('[data-review-count]');
    for (var j = 0; j < nodes.length; j++) {
      if (ok) nodes[j].textContent = String(count);
      else nodes[j].style.display = 'none';
    }
  }


  // Walk up from the grid to the first element with a real background colour and
  // decide light vs dark from its luminance. Defaults to light — the safer miss,
  // since most pages here are light and dark text on an unknown background is
  // more likely readable than white text.
  function themeOf(el) {
    for (var n = el; n && n !== document.documentElement; n = n.parentElement) {
      var bg = getComputedStyle(n).backgroundColor || '';
      var m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
      if (!m) continue;
      if (m[4] !== undefined && parseFloat(m[4]) === 0) continue;   // transparent → keep walking
      var lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      return lum < 0.5 ? 'dark' : 'light';
    }
    return 'light';
  }

  function boot() {
    var grid = document.getElementById('revGrid');

    fetch(API + '/public/reviews')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok || !Array.isArray(d.reviews) || !d.reviews.length) return; // fails soft
        var agg   = d.aggregate || {};
        var count = (typeof agg.count === 'number' && agg.count > 0) ? agg.count : d.reviews.length;
        applyCount(count);
        if (!grid) return;   // count-only page (e.g. about.html) — nothing more to do

        injectCss();
        var theme = themeOf(grid);
        grid.classList.add(theme === 'dark' ? 'rr-dark' : 'rr-light');
        var reviews = d.reviews;
        var gUrl    = d.googleUrl || 'https://share.google/ChFC1uAe9Xdveb8XN';

        function cardHtml(r) {
          return '<div class="rcard rr-card">' +
            '<div class="rr-top"><span class="rs">★★★★★</span><span class="rr-date">' + esc(relDate(r.date)) + '</span></div>' +
            '<p>"' + esc(truncate(r.text, 240)) + '"</p>' +
            '<div class="rr-foot"><span class="who">— ' + esc(r.author || 'Google user') + '</span>' +
            '<span class="rr-google">Posted on Google</span></div>' +
          '</div>';
        }

        var perView = matchMedia('(max-width: 760px)').matches ? 1 : 2;
        var pages   = Math.max(1, Math.ceil(reviews.length / perView));
        var idx     = 0;

        grid.classList.add('rr-live');
        var nav  = document.createElement('div'); nav.className = 'rr-nav ' + (theme === 'dark' ? 'rr-dark' : 'rr-light');
        var prev = document.createElement('button'); prev.className = 'rr-arrow'; prev.setAttribute('aria-label', 'Previous reviews'); prev.innerHTML = '‹';
        var next = document.createElement('button'); next.className = 'rr-arrow'; next.setAttribute('aria-label', 'Next reviews');     next.innerHTML = '›';
        var dots = document.createElement('div'); dots.className = 'rr-dots';
        var dotCount = Math.min(pages, 12);
        for (var i = 0; i < dotCount; i++) {
          var b = document.createElement('button');
          b.className = 'rr-dot';
          b.setAttribute('aria-label', 'Reviews page ' + (i + 1));
          (function (k) { b.onclick = function () { go(k, true); }; })(i);
          dots.appendChild(b);
        }
        nav.appendChild(prev); nav.appendChild(dots); nav.appendChild(next);

        var aggEl = document.createElement('div');
        aggEl.className = 'rr-agg ' + (theme === 'dark' ? 'rr-dark-agg' : 'rr-light-agg');
        aggEl.innerHTML = '<a href="' + esc(gUrl) + '" target="_blank" rel="noopener noreferrer">See all ' + count + '+ Google reviews →</a>';

        grid.parentNode.insertBefore(nav, grid.nextSibling);
        nav.parentNode.insertBefore(aggEl, nav.nextSibling);
        if (pages <= 1) nav.style.display = 'none';

        function render() {
          var start = idx * perView;
          grid.style.opacity = '0';
          setTimeout(function () {
            grid.innerHTML = reviews.slice(start, start + perView).map(cardHtml).join('');
            var dd = dots.children;
            for (var j = 0; j < dd.length; j++) dd[j].className = 'rr-dot' + (j === idx % dotCount ? ' on' : '');
            grid.style.opacity = '1';
          }, 180);
        }
        var timer  = null;
        var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        function schedule() {
          if (reduce || pages <= 1) return;
          clearInterval(timer);
          timer = setInterval(function () { go(idx + 1, false); }, 6000);
        }
        function go(to, user) { idx = (to + pages) % pages; render(); if (user) schedule(); }

        prev.onclick = function () { go(idx - 1, true); };
        next.onclick = function () { go(idx + 1, true); };

        render(); schedule();

        var rt = null;
        addEventListener('resize', function () {
          clearTimeout(rt);
          rt = setTimeout(function () {
            var pv = matchMedia('(max-width: 760px)').matches ? 1 : 2;
            if (pv === perView) return;
            perView = pv;
            pages = Math.max(1, Math.ceil(reviews.length / perView));
            idx = 0;
            nav.style.display = pages <= 1 ? 'none' : '';
            render();
          }, 200);
        });
      })
      .catch(function () { /* network error → curated fallback stays */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
