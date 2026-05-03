// Pure Cleaning API client — replaces direct JSONbin calls across all pages
// Worker: https://purecleaning-api.tylerfumero.workers.dev

const PCPC_API_BASE = 'https://purecleaning-api.tylerfumero.workers.dev';

window.pcpcApi = {
  async getCustomers() {
    const r = await fetch(`${PCPC_API_BASE}/customers`);
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    const data = await r.json();
    return data.customers || [];
  },

  async saveCustomers(customers) {
    const r = await fetch(`${PCPC_API_BASE}/customers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customers }),
    });
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  async getCustomerDB() {
    const r = await fetch(`${PCPC_API_BASE}/customers`);
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  async saveCustomerDB(db) {
    const r = await fetch(`${PCPC_API_BASE}/customers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(db),
    });
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  async getIncoming() {
    const r = await fetch(`${PCPC_API_BASE}/incoming`);
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    const data = await r.json();
    return data.requests || [];
  },

  async saveIncoming(requests) {
    const r = await fetch(`${PCPC_API_BASE}/incoming`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  async addIncoming(request) {
    const r = await fetch(`${PCPC_API_BASE}/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  async getEvents() {
    const r = await fetch(`${PCPC_API_BASE}/events`);
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    const data = await r.json();
    return data.events || [];
  },

  async logEvent(event) {
    fetch(`${PCPC_API_BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).catch(err => console.error('Event log failed', err));
  },

  async getLinks() {
    const r = await fetch(`${PCPC_API_BASE}/links`);
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  async saveLinks(links) {
    const r = await fetch(`${PCPC_API_BASE}/links`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links }),
    });
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  async getQuote(quoteCode) {
    const r = await fetch(`${PCPC_API_BASE}/quote/${quoteCode}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  async saveQuote(quoteCode, data) {
    const r = await fetch(`${PCPC_API_BASE}/quote/${quoteCode}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  async updateQuote(quoteCode, partial) {
    const r = await fetch(`${PCPC_API_BASE}/quote/${quoteCode}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    if (!r.ok) throw new Error(`API error: ${r.status}`);
    return r.json();
  },

  _cache: {},

  async getCachedCustomers(maxAgeMs = 60000) {
    const cached = this._cache.customers;
    if (cached && Date.now() - cached.ts < maxAgeMs) return cached.data;
    const customers = await this.getCustomers();
    this._cache.customers = { data: customers, ts: Date.now() };
    return customers;
  },

  invalidateCache(key) {
    if (key) delete this._cache[key];
    else this._cache = {};
  },

  // ── Phone utilities ─────────────────────────────────────────────────────────
  // Always store phones as 10 digits; display/lookup normalized through these helpers.

  normalizePhone(phone) {
    if (!phone) return '';
    return String(phone).replace(/\D/g, '').slice(-10); // strip non-digits, keep last 10
  },

  matchByPhone(customers, phone) {
    const q = this.normalizePhone(phone);
    if (!q) return null;
    return (customers || []).find(c => this.normalizePhone(c.phone) === q) || null;
  },

  formatPhoneDisplay(phone) {
    const d = this.normalizePhone(phone);
    if (d.length !== 10) return d || '—';
    return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  },

  // Normalize all phones in DB to digits-only (one-time backfill)
  async normalizeAllPhones() {
    const db = await this.getCustomerDB();
    let changed = 0;
    (db.customers || []).forEach(c => {
      const norm = this.normalizePhone(c.phone);
      if (norm && norm !== c.phone) { c.phone = norm; changed++; }
    });
    if (changed > 0) await this.saveCustomerDB(db);
    return changed;
  },
};
