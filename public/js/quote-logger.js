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
  // IDs verified against DEFAULT_SERVICES in new_customer.html (Rule 24):
  // Pool Patio → pool_deck ("Pool Deck", the ID with real job history — the
  // picker's separate pool_patio ID has 0 uses). House → rinse_walls, same
  // target as Walls, PLUS a "house wash" note carried into the custom-service
  // text so the distinction survives the hand-off (v1.1).
  const CHIPS = [
    { key: 'roof',       label: 'Roof',       svcId: 'roof_cleaning' },
    { key: 'walls',      label: 'Walls',      svcId: 'rinse_walls' },
    { key: 'driveway',   label: 'Driveway',   svcId: 'driveway' },
    { key: 'patio',      label: 'Patio',      svcId: 'patio' },
    { key: 'pool_patio', label: 'Pool Patio', svcId: 'pool_deck' },
    { key: 'house',      label: 'House',      svcId: 'rinse_walls', note: 'house wash' },
    { key: 'sealing',    label: 'Sealing',    svcId: 'sealing' },
    { key: 'rust',       label: 'Rust',       svcId: 'rust_removal' },
    { key: 'gutters',    label: 'Gutters',    svcId: 'gutters' },
    { key: 'fence',      label: 'Fence',      svcId: 'fence' },
  ];
  // (quotedBy toggle removed in v1.1 — column stays in D1, UI + write gone)

  let _opts = {}, _saving = false, _match = null; // _match = {personId, name, jobs, last}
  let _customs = [];        // write-in services (v1.1) — free text, multiple allowed
  let _wallsAuto = false;   // Walls lit by the Roof auto-bundle (vs a hand-tap)

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
          <button class="ql-x" id="qlClose" aria-label="Close">✕</button>
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
        <div class="ql-field">
          <div class="ql-chips" id="qlSvcChips"></div>
          <div id="qlCustomWrap" style="display:none;margin-top:7px;">
            <input id="qlCustomText" placeholder="e.g. awning, screen enclosure…" autocomplete="off">
          </div>
        </div>
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

    // service chips + auto-bundle (v1.1): tapping Roof auto-lights Walls
    // (mirrors the real picker's roof_cleaning→rinse_walls law, no popup).
    // A hand-tap on Walls — either direction — makes it Darla's call from
    // then on; un-tapping Roof only clears Walls if it's still auto-lit.
    const sc = wrap.querySelector('#qlSvcChips');
    const chipEl = key => sc.querySelector(`.ql-chip[data-key="${key}"]`);
    CHIPS.forEach(ch => {
      const b = document.createElement('div');
      b.className = 'ql-chip'; b.dataset.key = ch.key; b.textContent = ch.label;
      b.onclick = () => {
        const nowOn = b.classList.toggle('on');
        if (ch.key === 'walls') _wallsAuto = false;             // manual → Darla's call
        if (ch.key === 'roof') {
          const walls = chipEl('walls');
          if (nowOn && !walls.classList.contains('on')) { walls.classList.add('on'); _wallsAuto = true; }
          else if (!nowOn && _wallsAuto) { walls.classList.remove('on'); _wallsAuto = false; }
        }
      };
      sc.appendChild(b);
    });
    // ＋ Other → inline write-in; each entered text becomes a removable chip,
    // input stays open for another (multiple customs allowed).
    const other = document.createElement('div');
    other.className = 'ql-chip'; other.id = 'qlOtherChip'; other.textContent = '＋ Other';
    other.onclick = () => {
      const w = wrap.querySelector('#qlCustomWrap');
      const show = w.style.display === 'none';
      w.style.display = show ? 'block' : 'none';
      other.classList.toggle('on', show);
      if (show) wrap.querySelector('#qlCustomText').focus();
    };
    sc.appendChild(other);
    const custIn = wrap.querySelector('#qlCustomText');
    const commitCustom = () => {
      const t = custIn.value.trim();
      if (!t) return;
      _customs.push(t);
      custIn.value = '';
      _renderCustoms();
    };
    custIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitCustom(); } });
    custIn.addEventListener('blur', commitCustom);

    // phone: format-as-typed + dedupe lookup on blur
    const ph = wrap.querySelector('#qlPhone');
    ph.addEventListener('input', () => { ph.value = _fmtPhone(ph.value); });
    ph.addEventListener('blur', _dedupeLookup);

    wrap.querySelector('#qlClose').onclick = close;
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    wrap.querySelector('#qlSave').onclick    = () => _save(false);
    wrap.querySelector('#qlConfirm').onclick = () => _save(true);
  }

  // Write-in chips render between the standard chips and ＋ Other; tap to remove.
  function _renderCustoms() {
    const sc = document.getElementById('qlSvcChips');
    const other = document.getElementById('qlOtherChip');
    sc.querySelectorAll('.ql-chip[data-custom]').forEach(x => x.remove());
    _customs.forEach((t, i) => {
      const b = document.createElement('div');
      b.className = 'ql-chip on'; b.dataset.custom = String(i);
      b.textContent = `${t} ✕`;
      b.title = 'Tap to remove';
      b.onclick = () => { _customs.splice(i, 1); _renderCustoms(); };
      sc.insertBefore(b, other);
    });
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
    // Commit any text still sitting in the write-in box (Darla taps Save
    // without hitting Enter — blur fires first, but belt-and-suspenders).
    const pending = document.getElementById('qlCustomText').value.trim();
    if (pending) { _customs.push(pending); document.getElementById('qlCustomText').value = ''; }
    const chipKeys = [...document.querySelectorAll('#qlSvcChips .ql-chip.on')]
      .map(b => b.dataset.key).filter(Boolean);           // custom chips have no data-key
    const priceRaw = document.getElementById('qlPrice').value;
    return {
      firstName: sp === -1 ? nameRaw : nameRaw.slice(0, sp),
      lastName:  sp === -1 ? '' : nameRaw.slice(sp + 1).trim(),
      phone:     _p10(document.getElementById('qlPhone').value),
      city:      document.getElementById('qlCity').value.trim(),
      services:  [...chipKeys, ..._customs.map(t => ({ custom: t }))],
      priceQuoted: priceRaw === '' ? null : Number(priceRaw),
      personId:  _match ? _match.personId : null,
    };
  }

  function _handoffUrl(q, quoteId) {
    const chipKeys = q.services.filter(s => typeof s === 'string');
    const customs  = q.services.filter(s => s && typeof s === 'object' && s.custom).map(s => s.custom);
    // Dedupe (House + Walls both target rinse_walls) and collect chip notes
    // ("house wash") into the custom-service text so nothing is lost.
    const svcIds = [...new Set(chipKeys.map(k => (CHIPS.find(c => c.key === k) || {}).svcId).filter(Boolean))];
    const notes  = chipKeys.map(k => (CHIPS.find(c => c.key === k) || {}).note).filter(Boolean);
    const customText = [...notes, ...customs].join(', ');
    if (q.personId) {
      // Existing customer → the ?phone= path opens the booking flow in
      // existing-customer mode with full prefill; quote context rides along.
      const p = new URLSearchParams({ phone: q.phone, quoteId });
      if (q.priceQuoted != null) p.set('qprice', String(q.priceQuoted));
      if (svcIds.length) p.set('qsvc', svcIds.join(','));
      if (customText) p.set('qcustom', customText);
      return `/pure_cleaning_new_customer.html?${p}`;
    }
    // New caller → the existing ?fromOnline= base64-JSON prefill blob,
    // extended with svc/svcCustom/price/quoteId (see new_customer init).
    const blob = { fn: q.firstName, ln: q.lastName, phone: q.phone, city: q.city, svc: svcIds, svcCustom: customText || null, price: q.priceQuoted, quoteId };
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
    ['qlName', 'qlPhone', 'qlCity', 'qlPrice', 'qlCustomText'].forEach(id => { document.getElementById(id).value = ''; });
    document.querySelectorAll('#qlSvcChips .ql-chip.on, #qlCityChips .ql-chip.on').forEach(b => b.classList.remove('on'));
    document.getElementById('qlCustomWrap').style.display = 'none';
    document.getElementById('qlMatch').style.display = 'none';
    document.getElementById('qlErr').style.display = 'none';
    _match = null;
    _customs = [];
    _wallsAuto = false;
    _renderCustoms();
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
