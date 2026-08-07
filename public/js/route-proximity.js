/* Route proximity — ONE implementation, both surfaces.
 *
 * The directory is where the phone call actually lands: Darla or Tony looks the
 * customer up BEFORE any quote or booking form is open, with the customer on
 * the line. That lookup is the moment the suggestion has to be visible, so this
 * has to render fast and say something a rushed person can act on.
 *
 * Rule 25 — the WORKER decides. This file renders what /admin/nearby-jobs
 * returns and adds no judgement of its own: no distance maths, no capacity
 * rules, no radius. Change the radius in KV, not here.
 *
 * DISTANCE, NEVER MINUTES. Straight-line cannot be converted to drive time
 * honestly — the detour factor computed from real trips came out at 0.85x,
 * which is impossible, proving milesFromPreviousJob measures something other
 * than road distance. South Florida is grid-and-canal constrained, so a
 * confident "8 minutes" across a canal is worse than an honest "1.4 miles".
 *
 * SILENT WHEN NOTHING IS NEARBY. No empty state, no "no matches found" — a row
 * that says nothing still costs a glance, and this surface is measured in
 * seconds. Note that through slow season it will be silent almost always:
 * there were 8 scheduled jobs in the whole 21-day window when this shipped.
 */
(function () {
  'use strict';

  // Resolved LAZILY, at call time. Pages declare `const PCPC_API = …` at top
  // level, which is a script-scope binding and NOT a window property — reading
  // window.PCPC_API returned undefined and every lookup silently hit a relative
  // path. Same class as the `window.dayOffset` bug (Rule 26). Falls back to the
  // same origin, which is correct here because the Worker serves both.
  function apiBase() {
    if (typeof window.PCPC_API === 'string' && window.PCPC_API) return window.PCPC_API;
    try { if (typeof PCPC_API === 'string' && PCPC_API) return PCPC_API; } catch (_) {}
    return '';
  }
  const _cache = new Map();          // key -> {at, matches}
  const TTL_MS = 60 * 1000;

  const _esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function _dayLabel(iso) {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }

  /** Ask the worker. Returns [] on any failure — a suggestion is an
   *  enhancement and must never break the page it sits on. */
  async function lookup({ lat, lng, address, city, phone }) {
    const qs = new URLSearchParams();
    if (Number.isFinite(lat) && Number.isFinite(lng)) { qs.set('lat', lat); qs.set('lng', lng); }
    // phone: the directory's payload carries no coordinates, so the worker
    // resolves them from D1 — exact, and no geocode call per lookup.
    else if (phone) { qs.set('phone', String(phone).replace(/\D/g, '').slice(-10)); }
    else if (address) { qs.set('address', address); if (city) qs.set('city', city); }
    else return [];

    const key = qs.toString();
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.matches;

    try {
      // Attach auth explicitly. Pages install their own fetch wrapper, but it
      // does not always cover a relative path from a shared module — this
      // returned 401 silently, and `return []` made it look like "no matches
      // nearby" rather than "not signed in".
      const tok = (() => { try { return localStorage.getItem('admin_token') || ''; } catch (_) { return ''; } })();
      const r = await fetch(`${apiBase()}/admin/nearby-jobs?${key}`,
        tok ? { headers: { Authorization: 'Bearer ' + tok } } : undefined);
      if (!r.ok) {
        // Distinguish "signed out" from "nothing nearby" in the console — a
        // silent empty result is exactly how this hid for three deploys.
        if (r.status === 401) console.warn('[route-proximity] not authenticated');
        return [];
      }
      const d = await r.json();
      const matches = Array.isArray(d.matches) ? d.matches : [];
      _cache.set(key, { at: Date.now(), matches });
      return matches;
    } catch (_) { return []; }
  }

  /** Render into `el`. Empty string when there is nothing to say. */
  function render(el, matches, opts) {
    if (!el) return;
    if (!matches || !matches.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
    const onPick = (opts && opts.onPickDate) ? 'rp-pickable' : '';
    el.innerHTML = matches.map(m => {
      const full = m.fillingUp
        ? `<span class="rp-full" title="${m.dayJobCount} jobs already on ${m.rigId}">filling up</span>` : '';
      const rig = m.rigId ? ` <span class="rp-rig">${_esc(m.rigId.replace('rig_', 'rig '))}</span>` : '';
      return `<div class="rp-hit ${onPick}" data-date="${_esc(m.date)}" data-rig="${_esc(m.rigId || '')}">
        <div class="rp-line">📍 <b>${_esc(_dayLabel(m.date))}</b> — ${m.distanceMiles} mi from ${_esc(m.anchorName || 'another job')}${rig}${full}</div>
        <div class="rp-sub">Good day to book this one.</div>
      </div>`;
    }).join('');
    el.style.display = '';
    if (opts && opts.onPickDate) {
      el.querySelectorAll('.rp-hit').forEach(h => h.addEventListener('click', () => {
        // Pre-selects a date. NEVER books, never modifies an existing job.
        opts.onPickDate(h.dataset.date, h.dataset.rig || null);
      }));
    }
  }

  /** Convenience: look up and render in one call. */
  async function show(el, where, opts) {
    const matches = await lookup(where);
    render(el, matches, opts);
    return matches.length;
  }

  const CSS = `
  .rp-wrap{margin:6px 0 2px;}
  .rp-hit{background:#eff6ff;border:1px solid #bfdbfe;border-left:3px solid #2563eb;border-radius:8px;
    padding:7px 10px;margin-bottom:5px;font-size:13px;line-height:1.35;}
  .rp-hit.rp-pickable{cursor:pointer;}
  .rp-hit.rp-pickable:active{background:#dbeafe;}
  .rp-line{color:#1e3a8a;}
  .rp-line b{color:#1e40af;}
  .rp-sub{color:#3b82f6;font-size:11.5px;margin-top:1px;}
  .rp-rig{font-size:10.5px;font-weight:700;background:#dbeafe;color:#1e40af;border-radius:4px;padding:0 5px;margin-left:4px;}
  .rp-full{font-size:10.5px;font-weight:700;background:#fef3c7;color:#92400e;border:1px solid #fde68a;
    border-radius:4px;padding:0 5px;margin-left:4px;}
  @media (max-width:640px){ .rp-hit{font-size:12.5px;padding:6px 8px;} }`;

  function injectCss() {
    if (document.getElementById('rp-css')) return;
    const st = document.createElement('style');
    st.id = 'rp-css'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  window.RouteProximity = { lookup, render, show, injectCss, PREFIX: '📍' };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectCss);
  else injectCss();
})();
