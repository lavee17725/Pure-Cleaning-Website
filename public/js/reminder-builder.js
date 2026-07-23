/* ═══════════════════════════════════════════════════════════════════════════
   Unified Reminder Builder — ONE modal used by BOTH entry points
   (Customer Directory clock icon + Customer Profile follow-up panel).

   Store: D1 Reminder table (Rule 19 / DL-09 — canonical, not KV). This is the UI
   layer only; it POSTs day-precision reminders to /admin/reminder via `remindAt`.

   Usage:
     ReminderBuilder.open({
       personId,          // 'person_1' + last10 (derived from phone if omitted)
       phone,             // used to derive personId + label
       name,              // customer display name for the title
       apiBase,           // defaults to the production worker
       onSaved,           // callback(reminder) after a successful save
     });
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.ReminderBuilder) return;

  const DEFAULT_API = 'https://purecleaning-api.tylerfumero.workers.dev';

  const QUICK_PICKS = [
    { key: '1w',  label: '1 week',    kind: 'd', n: 7  },
    { key: '1m',  label: '1 month',   kind: 'm', n: 1  },
    { key: '3m',  label: '3 months',  kind: 'm', n: 3  },
    { key: '6m',  label: '6 months',  kind: 'm', n: 6  },
    { key: '12m', label: '1 year',    kind: 'm', n: 12 },
    { key: '18m', label: '18 months', kind: 'm', n: 18 },
    { key: '24m', label: '2 years',   kind: 'm', n: 24 },
  ];

  const REASON_CHIPS = [
    { tag: 'reactivation', label: 'Reactivation',      text: 'Reactivation — time for another clean' },
    { tag: 'sealing',      label: 'Sealing pitch',     text: 'Sealing pitch' },
    { tag: 'callback',     label: 'Callback requested', text: 'Callback requested' },
    { tag: 'quote_check',  label: 'Check on quote',    text: 'Check on quote' },
  ];

  const CADENCES = [1, 3, 6, 12, 18, 24];

  // ── state ──
  let _opts = {};
  let _remindAt = null;     // 'YYYY-MM-DD'
  let _reasonTag = 'manual_follow_up';
  let _editingId = null;    // reminderId when editing an existing (edit-as-replace)
  let _saving = false;

  // ── date helpers (local time — avoid TZ off-by-one) ──
  function _todayLocal() { const d = new Date(); d.setHours(12, 0, 0, 0); return d; }
  function _fmtYMD(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function _parseYMD(s) { const [y, m, d] = s.split('-').map(Number); const dt = new Date(y, m - 1, d); dt.setHours(12, 0, 0, 0); return dt; }
  function _addMonths(d, n) { const r = new Date(d); const day = r.getDate(); r.setMonth(r.getMonth() + n); if (r.getDate() < day) r.setDate(0); return r; }
  function _quickDate(qp) { const base = _todayLocal(); return qp.kind === 'd' ? new Date(base.getTime() + qp.n * 86400000) : _addMonths(base, qp.n); }
  function _friendly(s) { return _parseYMD(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
  function _fromNow(s) {
    const days = Math.round((_parseYMD(s) - _todayLocal()) / 86400000);
    if (days <= 0)   return 'today';
    if (days === 1)  return 'tomorrow';
    if (days < 45)   return `${days} days from today`;
    const months = Math.round(days / 30.4);
    if (months < 12) return `~${months} months from today`;
    const yrs = Math.round(months / 12 * 10) / 10;
    return `~${yrs % 1 === 0 ? yrs : yrs.toFixed(1)} year${yrs >= 2 ? 's' : ''} from today`;
  }

  function _personId() {
    if (_opts.personId) return _opts.personId;
    const p10 = String(_opts.phone || '').replace(/\D/g, '').slice(-10);
    return p10 ? 'person_1' + p10 : null;
  }
  function _api() { return _opts.apiBase || window.PCPC_API || window.API || DEFAULT_API; }

  function _toast(msg) {
    if (typeof window.showToast === 'function') { window.showToast(msg); return; }
    let t = document.getElementById('rbToast');
    if (!t) {
      t = document.createElement('div'); t.id = 'rbToast';
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#0f172a;color:#fff;padding:11px 18px;border-radius:12px;font:600 14px "DM Sans",sans-serif;z-index:100000;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transition:opacity .2s;';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._to); t._to = setTimeout(() => { t.style.opacity = '0'; }, 2600);
  }

  // ── DOM (injected once) ──
  let _root = null;
  function _ensureDom() {
    if (_root) return;
    const style = document.createElement('style');
    style.textContent = `
      .rb-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:99990;padding:16px;font-family:'DM Sans',sans-serif;}
      .rb-overlay.rb-open{display:flex;}
      .rb-card{background:#fff;border-radius:18px;width:100%;max-width:460px;max-height:92vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.3);padding:20px 20px 16px;}
      .rb-title{font-size:18px;font-weight:800;color:#0f172a;margin-bottom:2px;}
      .rb-sub{font-size:12.5px;color:#64748b;margin-bottom:14px;}
      .rb-sec-lbl{font-size:11px;font-weight:800;letter-spacing:.5px;color:#94a3b8;text-transform:uppercase;margin:14px 0 7px;}
      .rb-chips{display:flex;flex-wrap:wrap;gap:7px;}
      .rb-chip{border:1.5px solid #e2e8f0;background:#fff;color:#334155;border-radius:999px;padding:7px 13px;font:600 13px inherit;cursor:pointer;transition:all .12s;}
      .rb-chip:hover{border-color:#94a3b8;}
      .rb-chip.rb-on{background:#0ea5e9;border-color:#0ea5e9;color:#fff;}
      .rb-date{margin-top:9px;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font:600 14px inherit;color:#0f172a;width:100%;}
      .rb-preview{margin-top:10px;padding:10px 12px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;font-size:13px;color:#0369a1;font-weight:600;min-height:19px;}
      .rb-preview.rb-empty{background:#fef9f3;border-color:#fed7aa;color:#9a6a1f;}
      .rb-radio-row{display:flex;flex-direction:column;gap:8px;margin-top:4px;}
      .rb-radio{display:flex;align-items:center;gap:9px;font-size:14px;color:#334155;cursor:pointer;}
      .rb-cad{margin-left:6px;padding:5px 8px;border:1.5px solid #e2e8f0;border-radius:8px;font:600 13px inherit;}
      .rb-cad:disabled{opacity:.4;}
      .rb-reason{margin-top:9px;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:10px;font:500 14px inherit;color:#0f172a;width:100%;resize:vertical;min-height:44px;box-sizing:border-box;}
      .rb-err{color:#dc2626;font-size:12.5px;font-weight:600;margin-top:9px;min-height:16px;}
      .rb-foot{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;}
      .rb-btn{border:none;border-radius:11px;padding:10px 18px;font:700 14px inherit;cursor:pointer;}
      .rb-cancel{background:#f1f5f9;color:#475569;}
      .rb-save{background:#0ea5e9;color:#fff;}
      .rb-save:disabled{opacity:.5;cursor:not-allowed;}
      .rb-existing{margin:2px 0 4px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;}
      .rb-ex-item{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#78350f;padding:4px 0;border-top:1px dashed #fde68a;}
      .rb-ex-item:first-of-type{border-top:none;}
      .rb-ex-item .rb-ex-txt{flex:1;font-weight:600;}
      .rb-ex-act{background:none;border:none;color:#0369a1;font:700 12px inherit;cursor:pointer;padding:2px 4px;}
      .rb-ex-act.rb-del{color:#b91c1c;}
    `;
    document.head.appendChild(style);

    _root = document.createElement('div');
    _root.className = 'rb-overlay';
    _root.innerHTML = `
      <div class="rb-card" role="dialog" aria-modal="true" aria-labelledby="rbTitle">
        <div class="rb-title" id="rbTitle">⏰ Set Reminder</div>
        <div class="rb-sub" id="rbSub"></div>
        <div class="rb-existing" id="rbExisting" style="display:none;"></div>

        <div class="rb-sec-lbl">When?</div>
        <div class="rb-chips" id="rbQuick"></div>
        <input type="date" class="rb-date" id="rbDate" aria-label="Pick exact date">
        <div class="rb-preview rb-empty" id="rbPreview">Pick a quick option or a date above.</div>

        <div class="rb-sec-lbl">Repeat?</div>
        <div class="rb-radio-row">
          <label class="rb-radio"><input type="radio" name="rbRepeat" value="once" checked> One time only</label>
          <label class="rb-radio"><input type="radio" name="rbRepeat" value="rec"> Recurring — every
            <select class="rb-cad" id="rbCad" disabled>${CADENCES.map(n => `<option value="${n}">${n} month${n > 1 ? 's' : ''}</option>`).join('')}</select>
            after the first
          </label>
        </div>

        <div class="rb-sec-lbl">Why? <span style="color:#dc2626;">(required)</span></div>
        <div class="rb-chips" id="rbReasonChips"></div>
        <textarea class="rb-reason" id="rbReason" placeholder="e.g. Follow up on the sealing quote"></textarea>

        <div class="rb-err" id="rbErr"></div>
        <div class="rb-foot">
          <button class="rb-btn rb-cancel" id="rbCancel">Cancel</button>
          <button class="rb-btn rb-save" id="rbSave">Set Reminder</button>
        </div>
      </div>`;
    document.body.appendChild(_root);

    // quick picks
    const qWrap = _root.querySelector('#rbQuick');
    QUICK_PICKS.forEach(qp => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'rb-chip'; b.dataset.qp = qp.key; b.textContent = qp.label;
      b.onclick = () => { const d = _quickDate(qp); _setDate(_fmtYMD(d)); _markQuick(qp.key); };
      qWrap.appendChild(b);
    });
    // reason chips
    const rWrap = _root.querySelector('#rbReasonChips');
    REASON_CHIPS.forEach(rc => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'rb-chip'; b.dataset.tag = rc.tag; b.textContent = rc.label;
      b.onclick = () => {
        _root.querySelectorAll('#rbReasonChips .rb-chip').forEach(x => x.classList.remove('rb-on'));
        b.classList.add('rb-on');
        _reasonTag = rc.tag;
        _root.querySelector('#rbReason').value = rc.text;
      };
      rWrap.appendChild(b);
    });

    _root.querySelector('#rbDate').addEventListener('change', e => { if (e.target.value) { _setDate(e.target.value); _markQuick(null); } });
    _root.querySelector('#rbReason').addEventListener('input', () => { _reasonTag = _reasonTag === 'manual_follow_up' ? 'manual_follow_up' : _reasonTag; });
    _root.querySelectorAll('input[name="rbRepeat"]').forEach(r => r.addEventListener('change', () => {
      _root.querySelector('#rbCad').disabled = _root.querySelector('input[name="rbRepeat"]:checked').value !== 'rec';
    }));
    _root.querySelector('#rbCancel').onclick = close;
    _root.querySelector('#rbSave').onclick = _save;
    _root.addEventListener('click', e => { if (e.target === _root) close(); });
  }

  function _markQuick(key) {
    _root.querySelectorAll('#rbQuick .rb-chip').forEach(c => c.classList.toggle('rb-on', c.dataset.qp === key));
  }
  function _setDate(ymd) {
    _remindAt = ymd;
    _root.querySelector('#rbDate').value = ymd;
    const p = _root.querySelector('#rbPreview');
    p.classList.remove('rb-empty');
    p.textContent = `Reminder set for ${_friendly(ymd)} (${_fromNow(ymd)})`;
  }

  async function _loadExisting() {
    const box = _root.querySelector('#rbExisting');
    box.style.display = 'none'; box.innerHTML = '';
    const pid = _personId();
    if (!pid) return;
    try {
      const res = await fetch(`${_api()}/admin/person/${encodeURIComponent(pid)}/reminders`);
      if (!res.ok) return;
      const data = await res.json();
      const pending = (data.reminders || []).filter(r => (r.status || 'active') === 'active');
      if (!pending.length) return;
      box.innerHTML = `<div style="font-weight:800;font-size:11.5px;color:#92400e;margin-bottom:4px;">EXISTING REMINDERS</div>` +
        pending.map(r => {
          const when = r.nextFireAt || (r.followUpMonth ? r.followUpMonth + '-01' : '');
          const whenLbl = when ? _friendly(when) : (r.followUpMonth || '');
          const reason = (r.note || _reasonLabel(r.type) || 'Follow-up');
          const cad = r.cadenceMonths ? ` · every ${r.cadenceMonths}mo` : '';
          return `<div class="rb-ex-item">
              <span class="rb-ex-txt">${_esc(reason)} — ${_esc(whenLbl)}${cad}</span>
              <button class="rb-ex-act" data-edit="${_esc(r.reminderId)}">Edit</button>
              <button class="rb-ex-act rb-del" data-del="${_esc(r.reminderId)}">Delete</button>
            </div>`;
        }).join('');
      box.style.display = 'block';
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => _delete(b.dataset.del));
      box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
        const r = pending.find(x => x.reminderId === b.dataset.edit);
        if (r) _prefillFromExisting(r);
      });
    } catch (e) { /* non-blocking */ }
  }

  function _prefillFromExisting(r) {
    _editingId = r.reminderId;
    const when = r.nextFireAt || (r.followUpMonth ? r.followUpMonth + '-01' : null);
    if (when && /^\d{4}-\d{2}-\d{2}$/.test(when)) { _setDate(when); _markQuick(null); }
    _root.querySelector('#rbReason').value = r.note || '';
    _reasonTag = r.type || 'manual_follow_up';
    _root.querySelectorAll('#rbReasonChips .rb-chip').forEach(x => x.classList.toggle('rb-on', x.dataset.tag === r.type));
    if (r.cadenceMonths) {
      _root.querySelector('input[name="rbRepeat"][value="rec"]').checked = true;
      _root.querySelector('#rbCad').disabled = false;
      if (CADENCES.includes(r.cadenceMonths)) _root.querySelector('#rbCad').value = String(r.cadenceMonths);
    }
    _root.querySelector('#rbSave').textContent = 'Update Reminder';
    _root.querySelector('#rbErr').textContent = 'Editing — saving replaces the existing reminder.';
  }

  async function _delete(reminderId) {
    try {
      const res = await fetch(`${_api()}/admin/reminder/${encodeURIComponent(reminderId)}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'dismissed' }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      _toast('🗑️ Reminder deleted');
      _loadExisting();
      if (typeof _opts.onSaved === 'function') _opts.onSaved(null);
    } catch (e) { _root.querySelector('#rbErr').textContent = 'Delete failed — ' + e.message; }
  }

  function _reasonLabel(tag) { const m = REASON_CHIPS.find(c => c.tag === tag); return m ? m.label : (tag === 'manual_follow_up' ? '' : tag); }
  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  async function _save() {
    if (_saving) return;
    const errEl = _root.querySelector('#rbErr');
    const reason = _root.querySelector('#rbReason').value.trim();
    errEl.textContent = '';
    if (!_remindAt) { errEl.textContent = 'Pick when to be reminded.'; return; }
    if (!reason)    { errEl.textContent = 'A reason is required — you\'ll thank yourself in 6 months.'; _root.querySelector('#rbReason').focus(); return; }
    const pid = _personId();
    if (!pid) { errEl.textContent = 'Missing customer id.'; return; }

    const recurring = _root.querySelector('input[name="rbRepeat"]:checked').value === 'rec';
    const cadenceMonths = recurring ? Number(_root.querySelector('#rbCad').value) : null;

    _saving = true;
    const btn = _root.querySelector('#rbSave');
    const prevTxt = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const res = await fetch(`${_api()}/admin/reminder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: pid, remindAt: _remindAt, note: reason, type: _reasonTag, cadenceMonths }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.reminderId || data.personId !== pid) throw new Error(data?.error || 'server did not confirm the reminder');
      // Edit-as-replace: dismiss the old one now that the new one is confirmed.
      if (_editingId) {
        await fetch(`${_api()}/admin/reminder/${encodeURIComponent(_editingId)}/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'dismissed' }),
        }).catch(() => {});
      }
      _toast(`✓ Reminder set for ${_friendly(_remindAt)}`);
      if (typeof _opts.onSaved === 'function') _opts.onSaved(data);
      close();
    } catch (e) {
      errEl.textContent = 'Failed to save — ' + e.message;
      btn.disabled = false; btn.textContent = prevTxt;
    } finally {
      _saving = false;
    }
  }

  function open(opts) {
    _opts = opts || {};
    _ensureDom();
    // reset
    _remindAt = null; _reasonTag = 'manual_follow_up'; _editingId = null; _saving = false;
    _markQuick(null);
    _root.querySelector('#rbDate').value = '';
    _root.querySelector('#rbDate').min = _fmtYMD(_todayLocal());
    const p = _root.querySelector('#rbPreview'); p.classList.add('rb-empty'); p.textContent = 'Pick a quick option or a date above.';
    _root.querySelector('#rbReason').value = '';
    _root.querySelectorAll('#rbReasonChips .rb-chip').forEach(x => x.classList.remove('rb-on'));
    _root.querySelector('input[name="rbRepeat"][value="once"]').checked = true;
    _root.querySelector('#rbCad').disabled = true;
    _root.querySelector('#rbErr').textContent = '';
    const btn = _root.querySelector('#rbSave'); btn.disabled = false; btn.textContent = 'Set Reminder';
    _root.querySelector('#rbTitle').textContent = `⏰ Set Reminder`;
    _root.querySelector('#rbSub').textContent = _opts.name ? _opts.name : (_opts.phone || '');
    _root.classList.add('rb-open');
    _loadExisting();
  }
  function close() { if (_root) _root.classList.remove('rb-open'); }

  window.ReminderBuilder = { open, close };
})();
