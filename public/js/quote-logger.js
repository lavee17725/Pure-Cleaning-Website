/* ═══════════════════════════════════════════════════════════════════════════
   Quick Quote Logger — the 15-second yellow-pad entry, ONE modal used by
   BOTH entry points (admin hub + calendar header).

   Store: D1 Quote table (Rule 19 / DL-09 — canonical, no KV mirror). This is
   the UI layer only; it POSTs to /admin/quote (auth via each page's fetch shim).

   Design law: THE ENEMY IS FRICTION. Name, phone, city chip, service chips,
   price — save. Nothing else. Enrichment happens only on accept, in the
   existing booking flow.

   Two save actions:
     [Save Quote]        → status 'quoted', lands in the pool.
     [Confirmed — Book]  → status 'accepted' + resolvedAt at create (same pad
                           row, same timestamp order), then IMMEDIATELY hands
                           off into pure_cleaning_new_customer.html pre-filled
                           — exactly like the pool's Accept button.

   Usage: QuoteLogger.open({ apiBase?, onSaved? })
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.QuoteLogger) return;

  const DEFAULT_API = 'https://purecleaning-api.tylerfumero.workers.dev';

  // Top 5 by real quote frequency (per Darla's pads), then the rest of the
  // service area alphabetically. Free-type input always available.
  const CITIES_TOP  = ['Weston', 'Davie', 'Pembroke Pines', 'Plantation', 'Coral Springs'];
  const CITIES_REST = ['Cooper City', 'Fort Lauderdale', 'Hollywood', 'Miramar', 'Parkland', 'Southwest Ranches', 'Sunrise', 'Tamarac'];

  // chip key → new_customer.html service-picker id (for the accept hand-off).
  // 'other' intentionally unmapped — it has no 1:1 picker equivalent.
  const CHIPS = [
    { key: 'roof',        label: 'Roof',        svcId: 'roof_cleaning' },
    { key: 'driveway',    label: 'Driveway',    svcId: 'driveway' },
    { key: 'patio',       label: 'Patio',       svcId: 'patio' },
    { key: 'house_walls', label: 'House/Walls', svcId: 'rinse_walls' },
    { key: 'sealing',     label: 'Sealing',     svcId: 'sealing' },
    { key: 'rust',        label: 'Rust',        svcId: 'rust_removal' },
    { key: 'other',       label: 'Other',       svcId: null },
  ];
  const QUOTED_BY = ['darla', 'tyler', 'tony'];

  let _opts = {}, _saving = false, _match = null; // _match = {personId, name, jobs, last}

  function _api() { return _opts.apiBase || window.PCPC_API || window.API || DEFAULT_API; }
  const _p10 = v => String(v || '').replace(/\D/g, '').slice(0, 10);

  function _fmtPhone(v) {
    const d = _p10(v);
    if (d.length < 4) return d;
    if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }

  function _toast(msg) {
    if (typeof window.showToast === 'function') { window.showToast(msg); return; }
    let t = document.getElementById('qlToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'qlToast';
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0f172a;color:#fff;padding:11px 18px;border-radius:12px;font:600 14px "DM Sans",sans-serif;z-index:100000;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transition:opacity .2s;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => { t.style.opacity = '0'; }, 2200);
  }

  function _ensureDom() {
    if (document.getElementById('qlOverlay')) return;
    const style = document.createElement('style');
    style.textContent = `
      .ql-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:99990;padding:16px;font-family:'DM Sans',sans-serif;}
      .ql-overlay.open{display:flex;}
      .ql-modal{background:#fff;border-radius:16px;width:100%;max-width:420px;max-height:92vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.3);padding:18px 18px 16px;}
      .ql-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
      .ql-title{font-size:17px;font-weight:800;color:#0f172a;}
      .ql-who{display:flex;gap:4px;}
      .ql-who button{border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;padding:4px 9px;font:700 11px 'DM Sans',sans-serif;color:#64748b;cursor:pointer;text-transform:capitalize;}
      .ql-who button.on{background:#0f172a;border-color:#0f172a;color:#fff;}
      .ql-x{border:none;background:none;font-size:20px;color:#94a3b8;cursor:pointer;padding:2px 6px;}
      .ql-field{margin-bottom:11px;}
      .ql-field input{width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:10px;padding:11px 12px;font:600 15px 'DM Sans',sans-serif;color:#0f172a;outline:none;}
      .ql-field input:focus{border-color:#0ea5e9;}
      .ql-chips{display:flex;flex-wrap:wrap;gap:6px;}
      .ql-chip{border:1.5px solid #e2e8f0;background:#f8fafc;border-radius:999px;padding:8px 13px;font:700 13px 'DM Sans',sans-serif;color:#334155;cursor:pointer;user-select:none;}
      .ql-chip.on{background:#0ea5e9;border-color:#0ea5e9;color:#fff;}
      .ql-citychips .ql-chip{padding:6px 11px;font-size:12px;}
      .ql-citychips{margin-bottom:6px;}
      .ql-match{display:none;background:#fefce8;border:1.5px solid #fde047;border-radius:10px;padding:8px 11px;font:600 12.5px 'DM Sans',sans-serif;color:#713f12;margin-top:6px;line-height:1.45;}
      .ql-price{position:relative;}
      .ql-price span{position:absolute;left:12px;top:50%;transform:translateY(-50%);font:700 15px 'DM Sans',sans-serif;color:#94a3b8;}
      .ql-price input{padding-left:26px;}
      .ql-actions{display:flex;gap:8px;margin-top:14px;}
      .ql-btn{flex:1;border:none;border-radius:11px;padding:13px 8px;font:800 14px 'DM Sans',sans-serif;cursor:pointer;}
      .ql-btn:disabled{opacity:.55;cursor:default;}
      .ql-save{background:#0f172a;color:#fff;}
      .ql-confirm{background:#16a34a;color:#fff;}
      .ql-err{display:none;color:#dc2626;font:700 12.5px 'DM Sans',sans-serif;margin-top:8px;}
      @media (max-width:520px){
        .ql-overlay{align-items:flex-end;padding:0;}
        .ql-modal{border-radius:16px 16px 0 0;max-width:none;}
      }`;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'qlOverlay';
    wrap.className = 'ql-overlay';
    wrap.innerHTML = `
      <div class="ql-modal" role="dialog" aria-label="Log Quote">
        <div class="ql-head">
          <div class="ql-title">＋ Log Quote</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <div class="ql-who" id="qlWho" title="Who quoted it (sticks until changed)"></div>
            <button class="ql-x" id="qlClose" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="ql-field"><input id="qlName" placeholder="Name — First Last" autocomplete="off"></div>
        <div class="ql-field">
          <input id="qlPhone" type="tel" inputmode="tel" placeholder="Phone (required)" autocomplete="off">
          <div class="ql-match" id="qlMatch"></div>
        </div>
        <div class="ql-field">
          <div class="ql-chips ql-citychips" id="qlCityChips"></div>
          <input id="qlCity" placeholder="City (tap above or type)" autocomplete="off" list="qlCityList">
          <datalist id="qlCityList">${CITIES_REST.map(c => `<option value="${c}">`).join('')}</datalist>
        </div>
        <div class="ql-field"><div class="ql-chips" id="qlSvcChips"></div></div>
        <div class="ql-field ql-price"><span>$</span><input id="qlPrice" type="number" inputmode="decimal" min="0" step="1" placeholder="Price quoted"></div>
        <div class="ql-actions">
          <button class="ql-btn ql-save" id="qlSave">Save Quote</button>
          <button class="ql-btn ql-confirm" id="qlConfirm">✓ Confirmed — Book</button>
        </div>
        <div class="ql-err" id="qlErr"></div>
      </div>`;
    document.body.appendChild(wrap);

    // city chips
    const cc = wrap.querySelector('#qlCityChips');
    CITIES_TOP.forEach(city => {
      const b = document.createElement('div');
      b.className = 'ql-chip'; b.textContent = city;
      b.onclick = () => {
        const inp = wrap.querySelector('#qlCity');
        const on = b.classList.contains('on');
        cc.querySelectorAll('.ql-chip').forEach(x => x.classList.remove('on'));
        if (on) { inp.value = ''; } else { b.classList.add('on'); inp.value = city; }
      };
      cc.appendChild(b);
    });
    wrap.querySelector('#qlCity').addEventListener('input', () => {
      cc.querySelectorAll('.ql-chip').forEach(x =>
        x.classList.toggle('on', x.textContent === wrap.querySelector('#qlCity').value));
    });

    // service chips
    const sc = wrap.querySelector('#qlSvcChips');
    CHIPS.forEach(ch => {
      const b = document.createElement('div');
      b.className = 'ql-chip'; b.dataset.key = ch.key; b.textContent = ch.label;
      b.onclick = () => b.classList.toggle('on');
      sc.appendChild(b);
    });

    // quotedBy — sticky identity, NOT a per-quote field (zero per-call friction:
    // set once, persists in localStorage until someone else takes the phone).
    const who = wrap.querySelector('#qlWho');
    QUOTED_BY.forEach(w => {
      const b = document.createElement('button');
      b.textContent = w; b.dataset.w = w;
      b.onclick = () => {
        localStorage.setItem('pcpc_quoted_by', w);
        who.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.w === w));
      };
      who.appendChild(b);
    });

    // phone: format-as-typed + dedupe lookup on blur
    const ph = wrap.querySelector('#qlPhone');
    ph.addEventListener('input', () => { ph.value = _fmtPhone(ph.value); });
    ph.addEventListener('blur', _dedupeLookup);

    wrap.querySelector('#qlClose').onclick = close;
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    wrap.querySelector('#qlSave').onclick    = () => _save(false);
    wrap.querySelector('#qlConfirm').onclick = () => _save(true);
  }

  // Inline, non-blocking existing-customer banner. Informational only —
  // Darla instantly knows it's a repeat customer; save is never gated on it.
  // Rule 12: csv_backfill entries are excluded from the "last job" line
  // (count still includes them — they're real history, just synthetic rows).
  async function _dedupeLookup() {
    _match = null;
    const el = document.getElementById('qlMatch');
    el.style.display = 'none';
    const p10 = _p10(document.getElementById('qlPhone').value);
    if (p10.length !== 10) return;
    try {
      const r = await fetch(`${_api()}/customer/${p10}`);
      if (!r.ok) return; // 404 = genuinely new caller
      const c = (await r.json()).customer;
      if (!c) return;
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.businessName || 'existing customer';
      const jobs = Array.isArray(c.jobHistory) ? c.jobHistory : [];
      const real = jobs.filter(j => j && j.source !== 'csv_backfill' && (j.date || j.completedDate));
      const last = real.length ? real.reduce((a, b) => ((a.date || a.completedDate) > (b.date || b.completedDate) ? a : b)) : null;
      const lastTxt = last
        ? `, last ${(last.services || last.mainServices || 'job')} ${(last.date || last.completedDate)}`
        : '';
      _match = { personId: 'person_1' + p10, name };
      el.innerHTML = `↩ Existing customer — <b>${name}</b>, ${jobs.length} job${jobs.length === 1 ? '' : 's'}${lastTxt}`;
      el.style.display = 'block';
    } catch (_) { /* lookup is best-effort; never block the entry */ }
  }

  function _collect() {
    const nameRaw = document.getElementById('qlName').value.trim();
    const sp = nameRaw.indexOf(' ');
    const services = [...document.querySelectorAll('#qlSvcChips .ql-chip.on')].map(b => b.dataset.key);
    const priceRaw = document.getElementById('qlPrice').value;
    return {
      quotedBy:  localStorage.getItem('pcpc_quoted_by') || null,
      firstName: sp === -1 ? nameRaw : nameRaw.slice(0, sp),
      lastName:  sp === -1 ? '' : nameRaw.slice(sp + 1).trim(),
      phone:     _p10(document.getElementById('qlPhone').value),
      city:      document.getElementById('qlCity').value.trim(),
      services,
      priceQuoted: priceRaw === '' ? null : Number(priceRaw),
      personId:  _match ? _match.personId : null,
    };
  }

  function _handoffUrl(q, quoteId) {
    const svcIds = q.services.map(k => (CHIPS.find(c => c.key === k) || {}).svcId).filter(Boolean);
    if (q.personId) {
      // Existing customer → the ?phone= path opens the booking flow in
      // existing-customer mode with full prefill; quote context rides along.
      const p = new URLSearchParams({ phone: q.phone, quoteId });
      if (q.priceQuoted != null) p.set('qprice', String(q.priceQuoted));
      if (svcIds.length) p.set('qsvc', svcIds.join(','));
      return `/pure_cleaning_new_customer.html?${p}`;
    }
    // New caller → the existing ?fromOnline= base64-JSON prefill blob,
    // extended with svc/price/quoteId (see new_customer init).
    const blob = { fn: q.firstName, ln: q.lastName, phone: q.phone, city: q.city, svc: svcIds, price: q.priceQuoted, quoteId };
    return `/pure_cleaning_new_customer.html?fromOnline=${encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(blob)))))}`;
  }

  async function _save(confirmed) {
    if (_saving) return;
    const err = document.getElementById('qlErr');
    err.style.display = 'none';
    const q = _collect();
    if (q.phone.length !== 10) {
      err.textContent = 'Phone number is required (10 digits).';
      err.style.display = 'block';
      return;
    }
    _saving = true;
    const btn = document.getElementById(confirmed ? 'qlConfirm' : 'qlSave');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await fetch(`${_api()}/admin/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...q, status: confirmed ? 'accepted' : 'quoted' }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) throw new Error(data.error || `HTTP ${r.status}`);
      if (confirmed) {
        // Same pad row, already accepted — keep going straight into booking.
        location.href = _handoffUrl(q, data.quoteId);
        return;
      }
      _toast('✓ Logged');
      if (typeof _opts.onSaved === 'function') _opts.onSaved(data);
      close();
    } catch (e) {
      err.textContent = `Save failed: ${e.message}`;
      err.style.display = 'block';
    } finally {
      _saving = false;
      btn.disabled = false; btn.textContent = label;
    }
  }

  function _reset() {
    ['qlName', 'qlPhone', 'qlCity', 'qlPrice'].forEach(id => { document.getElementById(id).value = ''; });
    document.querySelectorAll('#qlSvcChips .ql-chip.on, #qlCityChips .ql-chip.on').forEach(b => b.classList.remove('on'));
    document.getElementById('qlMatch').style.display = 'none';
    document.getElementById('qlErr').style.display = 'none';
    _match = null;
    const w = localStorage.getItem('pcpc_quoted_by');
    document.querySelectorAll('#qlWho button').forEach(b => b.classList.toggle('on', b.dataset.w === w));
  }

  function open(opts) {
    _opts = opts || {};
    _ensureDom();
    _reset();
    document.getElementById('qlOverlay').classList.add('open');
    setTimeout(() => document.getElementById('qlName').focus(), 60);
  }
  function close() { const o = document.getElementById('qlOverlay'); if (o) o.classList.remove('open'); }

  window.QuoteLogger = { open, close };
})();
