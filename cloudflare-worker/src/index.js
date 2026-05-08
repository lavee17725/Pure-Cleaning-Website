// Cloudflare Worker for Pure Cleaning Pressure Cleaning
// Replaces JSONbin with KV-backed REST API

const ALLOWED_ORIGINS = [
  'https://purecleaningpressurecleaning.com',
  'https://www.purecleaningpressurecleaning.com',
  'https://lavee17725.github.io',  // GitHub Pages backup
  'http://localhost:3000',  // local dev
  'http://localhost:8000',  // local dev
];

const KV_KEYS = {
  customers: 'customer_db',
  incoming: 'incoming_requests',
  events: 'quote_events',
  links: 'short_links',
  blockedWeeks: 'blocked_weeks',
};

const DEFAULT_SERVICE_FREQUENCY = {
  primary: [
    { id: 'rinse_walls',   name: 'Rinse Walls',         count: 1117, pct: 60.3 },
    { id: 'entranceway',   name: 'Entranceway',         count: 1042, pct: 56.3 },
    { id: 'driveway',      name: 'Driveway',            count: 965,  pct: 52.1 },
    { id: 'roof_cleaning', name: 'Roof Cleaning',       count: 944,  pct: 51.0 },
    { id: 'patio',         name: 'Patio',               count: 943,  pct: 50.9 },
    { id: 'walkway',       name: 'Walkway / Sidewalk',  count: 802,  pct: 43.3 },
  ],
  secondary: [
    { id: 'fence',         name: 'Fence',               count: 89,   pct: 4.8 },
    { id: 'rust_removal',  name: 'Rust Removal',        count: 39,   pct: 2.1 },
    { id: 'sealing',       name: 'Sealing',             count: 35,   pct: 1.9 },
    { id: 'gutters',       name: 'Gutters',             count: 31,   pct: 1.7 },
    { id: 'pool_deck',     name: 'Pool Deck',           count: 27,   pct: 1.5 },
    { id: 'windows',       name: 'Windows',             count: 25,   pct: 1.4 },
    { id: 'paver_sand',    name: 'Pavers / Joint Sand', count: 25,   pct: 1.3 },
    { id: 'garage',        name: 'Garage',              count: 16,   pct: 0.9 },
    { id: 'balcony',       name: 'Balcony',             count: 13,   pct: 0.7 },
  ],
  totalJobsAnalyzed: 1851,
  lastAnalyzed: '2026-05-02T00:00:00.000Z',
};

const DEFAULT_ADDONS_CONFIG = {
  addons: [
    { id: 'driveway',   name: 'Driveway Cleaning',            bundle: 150, standalone: 200, icon: '🛣️', description: '' },
    { id: 'patio',      name: 'Patio Cleaning',               bundle: 100, standalone: 150, icon: '🪨', description: '' },
    { id: 'walkways',   name: 'Walkways / Sidewalks',         bundle: 75,  standalone: 125, icon: '🚶', description: '' },
    { id: 'paver_sand', name: 'Paver Joint Sand Replacement', bundle: 200, standalone: 275, icon: '🧱', description: 'Stops weeds. Restores the clean look between pavers. We do this right after cleaning while they\'re prepped.' },
    { id: 'rust',       name: 'Rust Removal',                 bundle: 50,  standalone: 75,  icon: '🔧', description: '' },
    { id: 'awnings',    name: 'Awning Cleaning',              bundle: 100, standalone: 150, icon: '🏠', description: '' },
  ],
  sealing: {
    description: 'After we clean your driveway or patio, sealing locks in the clean look and protects against oil and grease stains, mildew regrowth, and color fading. Lasts 2–3 years. Pricing depends on surface size and condition — we\'ll quote it in person on the day of cleaning.',
  },
};

// ── Backup helpers ────────────────────────────────────────────────────────

const BACKUP_KV_KEYS = ['customer_db', 'incoming_requests', 'bouncie:rig_mapping',
                        'reviews_data', 'service_frequency', 'addons_config', 'tasks_db', 'blocked_weeks'];

async function runNightlyBackup(env) {
  if (!env.BACKUPS) {
    await env.DATA.put('backup:last_run', JSON.stringify({
      ranAt: new Date().toISOString(), status: 'error',
      errors: ['R2 bucket not bound — uncomment [[r2_buckets]] in wrangler.toml and create the bucket'],
      sizeBytes: 0, durationMs: 0,
    }));
    return;
  }

  const startMs  = Date.now();
  const ts       = new Date().toISOString();
  const date     = ts.split('T')[0];
  const heartbeat = { ranAt: ts, date, status: 'error', sizeBytes: 0, durationMs: 0, errors: [] };

  try {
    // Read all critical KV keys
    const data = {};
    await Promise.all(BACKUP_KV_KEYS.map(async k => {
      data[k] = await env.DATA.get(k, 'json');
    }));

    const payload = JSON.stringify({ version: 2, timestamp: ts, keys: data });
    const key     = `backups/${date}/full-backup.json`;

    await env.BACKUPS.put(key, payload, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { date, sizeBytes: String(payload.length), version: '2' },
    });

    heartbeat.status    = 'success';
    heartbeat.sizeBytes = payload.length;
    heartbeat.backupKey = key;

    // Retention policy
    const deleted = await applyRetentionPolicy(env);
    heartbeat.deletedOldBackups = deleted.length;
  } catch (e) {
    heartbeat.errors.push(e.message);
    console.error('Backup cron error:', e.message);
  } finally {
    heartbeat.durationMs = Date.now() - startMs;
    await env.DATA.put('backup:last_run', JSON.stringify(heartbeat));
  }
}

async function applyRetentionPolicy(env) {
  const listed = await env.BACKUPS.list({ prefix: 'backups/' });
  const now    = Date.now();
  const deleted = [];

  for (const obj of (listed.objects || [])) {
    const m = obj.key.match(/^backups\/(\d{4}-\d{2}-\d{2})\//);
    if (!m) continue;

    const d       = new Date(m[1] + 'T12:00:00Z');
    const ageDays = (now - d.getTime()) / 86400000;

    if (ageDays <= 30)  continue;                              // keep all last 30 days
    if (ageDays <= 90  && d.getUTCDay() === 0) continue;      // keep Sundays up to 90 days
    if (ageDays <= 365 && d.getUTCDate() === 1) continue;     // keep 1st-of-month up to 1 year

    try { await env.BACKUPS.delete(obj.key); deleted.push(obj.key); } catch {}
  }
  return deleted;
}

// ── Error log helper ─────────────────────────────────────────────────────
async function appendErrorLog(env, entry) {
  const date = entry.timestamp?.split('T')[0] || new Date().toISOString().split('T')[0];
  const key  = `errors:log:${date}`;
  const log  = (await env.DATA.get(key, 'json')) || [];
  log.push(entry);
  if (log.length > 500) log.splice(0, log.length - 500); // cap per day
  await env.DATA.put(key, JSON.stringify(log), { expirationTtl: 30 * 86400 }); // 30-day TTL
}

// ── Auth helpers ──────────────────────────────────────────────────────────

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function generateSessionToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function verifySession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  if (!token || token.length < 32) return false;
  const session = await env.DATA.get(`session:${token}`, 'json');
  return !!session;
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 4 * * *') {
      // Nightly backup — 4 AM UTC (runs after Bouncie matcher)
      ctx.waitUntil(runNightlyBackup(env));
    } else {
      // Bouncie job duration matcher — 3 AM UTC (11 PM ET)
      const today = new Date().toISOString().split('T')[0];
      ctx.waitUntil((async () => {
        const startMs = Date.now();
        const heartbeat = { ranAt: new Date().toISOString(), date: today, status: 'error', jobsMatched: 0, errors: [], durationMs: 0 };
        try {
          const result = await bouncieJobDurationMatcher(today, env);
          heartbeat.status = 'success';
          heartbeat.jobsMatched = result?.matched ?? result?.jobsMatched ?? 0;
          heartbeat.jobsTotal   = result?.total ?? 0;
        } catch (e) {
          console.error('duration cron error:', e.message);
          heartbeat.errors.push(e.message);
        } finally {
          heartbeat.durationMs = Date.now() - startMs;
          await env.DATA.put('bouncie:last_cron_run', JSON.stringify(heartbeat));
        }
      })());
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCors(origin);
    }

    // CORS headers for actual requests
    const corsHeaders = getCorsHeaders(origin);

    try {
      // Route handling
      const path = url.pathname.replace(/^\/+|\/+$/g, '');

      if (path === 'health') {
        const db = await env.DATA.get(KV_KEYS.customers, 'json');
        const customerCount = (db?.customers || []).length;
        return jsonResponse({ status: 'ok', timestamp: Date.now(), customerCount }, corsHeaders);
      }

      // ── Auth: login ───────────────────────────────────────────────────────────
      if (path === 'auth/login' && request.method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateKey = `rate:login:${ip}`;
        const attempts = (await env.DATA.get(rateKey, 'json')) || 0;
        if (attempts >= 5) {
          return jsonResponse({ error: 'rate_limited', message: 'Too many attempts. Wait 1 minute.' }, corsHeaders, 429);
        }
        const body = await request.json().catch(() => ({}));
        if (!env.ADMIN_PASSWORD || !constantTimeEqual(body.password || '', env.ADMIN_PASSWORD)) {
          await env.DATA.put(rateKey, JSON.stringify(attempts + 1), { expirationTtl: 60 });
          return jsonResponse({ error: 'invalid_password' }, corsHeaders, 401);
        }
        const token = generateSessionToken();
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        await env.DATA.put(`session:${token}`, JSON.stringify({ createdAt: new Date().toISOString() }), { expirationTtl: 86400 });
        return jsonResponse({ token, expiresAt }, corsHeaders);
      }

      // ── Auth: logout ──────────────────────────────────────────────────────────
      if (path === 'auth/logout' && request.method === 'POST') {
        const auth = request.headers.get('Authorization') || '';
        if (auth.startsWith('Bearer ')) {
          const token = auth.slice(7).trim();
          if (token) await env.DATA.delete(`session:${token}`).catch(() => {});
        }
        return jsonResponse({ success: true }, corsHeaders);
      }

      // ── Auth gate — all routes below require a valid session ──────────────────
      // Public routes (no auth required): health (above), auth/*, customer-facing
      const isPublic =
        (path === 'incoming'        && request.method === 'POST') ||
        (path === 'errors/log'      && request.method === 'POST') ||  // public — clients must report errors without auth
        (path === 'links'           && request.method === 'GET')  ||  // public — q.html needs this to resolve short links
        (path === 'dates/suggest'   && request.method === 'GET')  ||
        (path === 'service-frequency' && request.method === 'GET') ||
        (path === 'addons-config'   && request.method === 'GET')  ||
        path.startsWith('quote/')   ||
        (path.startsWith('agreement/') && (
          path.endsWith('/confirm')       ||
          path.endsWith('/skip-reminder') ||
          path.endsWith('/log-reminder')
        )) ||
        (path.startsWith('appointment/') && request.method === 'POST') ||
        (path.startsWith('receipt/')     && (request.method === 'GET' || request.method === 'PATCH'));

      if (!isPublic) {
        const authed = await verifySession(request, env);
        if (!authed) return jsonResponse({ error: 'Unauthorized', message: 'Authentication required' }, corsHeaders, 401);
      }
      // ── End auth gate ─────────────────────────────────────────────────────────

      if (path === 'customers') {
        return await handleResource(request, env, KV_KEYS.customers, corsHeaders);
      }

      if (path === 'incoming') {
        return await handleResource(request, env, KV_KEYS.incoming, corsHeaders);
      }

      if (path === 'events') {
        if (request.method === 'GET') {
          const data = await env.DATA.get(KV_KEYS.events, 'json') || { events: [] };
          const since = url.searchParams.get('since');
          if (since) {
            const sinceMs = new Date(since).getTime();
            if (!isNaN(sinceMs)) {
              data.events = (data.events || []).filter(e => {
                const ts = new Date(e.createdAt || e.loggedAt || 0).getTime();
                return ts >= sinceMs;
              });
            }
          }
          const phone = url.searchParams.get('phone');
          if (phone) {
            data.events = (data.events || []).filter(e => e.customer?.ph === phone);
          }
          return jsonResponse(data, corsHeaders);
        }
        return await handleResource(request, env, KV_KEYS.events, corsHeaders);
      }

      if (path === 'links') {
        return await handleResource(request, env, KV_KEYS.links, corsHeaders);
      }

      if (path === 'blocked-weeks') {
        return await handleResource(request, env, KV_KEYS.blockedWeeks, corsHeaders);
      }

      if (path === 'reviews') {
        if (request.method === 'GET') {
          const data = await env.DATA.get('reviews_data', 'json') || { count: 101, lastUpdated: null };
          return jsonResponse(data, corsHeaders);
        }
        if (request.method === 'PUT') {
          const body = await request.json();
          const data = { count: parseInt(body.count) || 101, lastUpdated: new Date().toISOString() };
          await env.DATA.put('reviews_data', JSON.stringify(data));
          return jsonResponse({ success: true, ...data }, corsHeaders);
        }
        return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
      }

      // ── TASKS ─────────────────────────────────────────────────────────────────
      const TASKS_CORS = { ...corsHeaders, 'Cache-Control': 'no-store' };
      if (path === 'api/tasks' && request.method === 'GET') {
        const db = await env.DATA.get('tasks_db', 'json') || { tasks: [] };
        return jsonResponse(db, TASKS_CORS);
      }
      if (path === 'api/tasks/bulk' && request.method === 'POST') {
        const { tasks: newTasks } = await request.json();
        const db = await env.DATA.get('tasks_db', 'json') || { tasks: [] };
        const created = newTasks.map(t => ({
          id: crypto.randomUUID(),
          title: t.title, description: t.description || '',
          owner: t.owner || 'unassigned', category: t.category || 'action',
          priority: t.priority || 'medium', status: t.status || 'open',
          dueDate: t.dueDate || null, createdAt: new Date().toISOString(),
          doneAt: null, notes: t.notes || '',
        }));
        db.tasks.push(...created);
        await env.DATA.put('tasks_db', JSON.stringify(db));
        return jsonResponse({ success: true, created: created.length }, TASKS_CORS);
      }
      if (path === 'api/tasks' && request.method === 'POST') {
        const t = await request.json();
        const db = await env.DATA.get('tasks_db', 'json') || { tasks: [] };
        const task = {
          id: crypto.randomUUID(),
          title: t.title, description: t.description || '',
          owner: t.owner || 'unassigned', category: t.category || 'action',
          priority: t.priority || 'medium', status: t.status || 'open',
          dueDate: t.dueDate || null, createdAt: new Date().toISOString(),
          doneAt: null, notes: t.notes || '',
        };
        db.tasks.push(task);
        await env.DATA.put('tasks_db', JSON.stringify(db));
        return jsonResponse({ success: true, task }, TASKS_CORS);
      }
      if (path.startsWith('api/tasks/') && request.method === 'PUT') {
        const id = path.slice('api/tasks/'.length);
        const body = await request.json();
        const db = await env.DATA.get('tasks_db', 'json') || { tasks: [] };
        const i = db.tasks.findIndex(t => t.id === id);
        if (i === -1) return jsonResponse({ error: 'not found' }, TASKS_CORS, 404);
        db.tasks[i] = { ...db.tasks[i], ...body };
        if (body.status === 'done' && !db.tasks[i].doneAt) db.tasks[i].doneAt = new Date().toISOString();
        await env.DATA.put('tasks_db', JSON.stringify(db));
        return jsonResponse({ success: true, task: db.tasks[i] }, TASKS_CORS);
      }
      if (path.startsWith('api/tasks/') && request.method === 'DELETE') {
        const id = path.slice('api/tasks/'.length);
        const db = await env.DATA.get('tasks_db', 'json') || { tasks: [] };
        const i = db.tasks.findIndex(t => t.id === id);
        if (i === -1) return jsonResponse({ error: 'not found' }, TASKS_CORS, 404);
        db.tasks[i].status = 'killed';
        await env.DATA.put('tasks_db', JSON.stringify(db));
        return jsonResponse({ success: true }, TASKS_CORS);
      }
      // ── END TASKS ─────────────────────────────────────────────────────────────

      if (path === 'service-frequency') {
        if (request.method === 'GET') {
          const data = await env.DATA.get('service_frequency', 'json') || DEFAULT_SERVICE_FREQUENCY;
          return jsonResponse(data, corsHeaders);
        }
        if (request.method === 'PUT') {
          const body = await request.json();
          await env.DATA.put('service_frequency', JSON.stringify(body));
          return jsonResponse({ success: true }, corsHeaders);
        }
        return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
      }

      if (path === 'addons-config') {
        if (request.method === 'GET') {
          const config = await env.DATA.get('addons_config', 'json') || DEFAULT_ADDONS_CONFIG;
          return jsonResponse(config, corsHeaders);
        }
        if (request.method === 'PUT') {
          const body = await request.json();
          await env.DATA.put('addons_config', JSON.stringify(body));
          return jsonResponse({ success: true }, corsHeaders);
        }
        return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
      }

      // ── Public: customer approves their quote ──────────────────────────────────
      // Path: POST /quote/{code}/approve
      // Scoped update — reads full DB server-side but never exposes other customers.
      // Phone-validated: body.phone must match the customer record being updated.
      if (path.match(/^quote\/[^/]+\/approve$/) && request.method === 'POST') {
        const code = path.split('/')[1];

        // Rate limit: 10 approvals per IP per minute
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateKey = `rate:approve:${ip}`;
        const attempts = (await env.DATA.get(rateKey, 'json')) || 0;
        if (attempts >= 10) return jsonResponse({ error: 'rate_limited' }, corsHeaders, 429);
        await env.DATA.put(rateKey, JSON.stringify(attempts + 1), { expirationTtl: 60 });

        const body = await request.json().catch(() => ({}));
        const { phone, approvedAmount, selectedDate, name, services } = body;
        if (!phone) return jsonResponse({ error: 'phone required' }, corsHeaders, 400);

        const normPhone = phone.replace(/\D/g, '').slice(-10);
        const now = new Date().toISOString();
        const svcStr = Array.isArray(services) ? services.join(', ') : (services || '');

        // Load DB, find or create customer, update ONLY their record
        const db = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
        let c = (db.customers || []).find(x => (x.phone || '').replace(/\D/g, '').slice(-10) === normPhone);

        if (!c) {
          const parts = (name || '').trim().split(/\s+/);
          c = {
            phone: normPhone,
            firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '',
            address: body.address || '', city: body.city || '',
            lastService: null, totalJobs: 0, lifetimeSpend: 0,
            hasSealHistory: false, phoneStatus: 'active',
            quoteStatus: null, scheduledStatus: null,
            alerts: [], optOut: null, movedAway: null,
            createdAt: now, source: 'digital_quote_approval',
          };
          db.customers.push(c);
        }

        c.quoteStatus = {
          state: 'approved', approvedDate: now.split('T')[0], approvedAt: now,
          approvedAmount: approvedAmount || null, quoteCode: code,
        };
        c.scheduledStatus = {
          state: 'scheduled', scheduledDate: selectedDate || null,
          rig: null, crew: [], jobNotes: svcStr, startTime: '09:00',
          approvedAmount: approvedAmount || null,
          autoScheduled: true, source: 'digital_quote_approval', scheduledAt: now,
        };

        await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));

        await appendErrorLog(env, {
          id: crypto.randomUUID(), timestamp: now,
          source: 'customer', page: `quote/${code}/approve`,
          errorType: 'QUOTE_APPROVED',
          message: `Quote ${code} approved · phone …${normPhone.slice(-4)} · $${approvedAmount || '?'} · ${selectedDate || 'no date'}`,
          url: request.url,
          userAgent: (request.headers.get('User-Agent') || '').slice(0, 300),
          ip: ip.slice(0, 50),
        });

        return jsonResponse({ success: true, scheduled: selectedDate || null }, corsHeaders);
      }

      if (path.startsWith('quote/')) {
        const quoteCode = path.slice('quote/'.length);
        if (!quoteCode) return jsonResponse({ error: 'Quote code required' }, corsHeaders, 400);
        return await handleQuote(request, env, quoteCode, corsHeaders);
      }

      if (path === 'dates/suggest' && request.method === 'GET') {
        return await handleDateSuggest(url, env, corsHeaders);
      }

      if (path.startsWith('payment/') && path.endsWith('/log') && request.method === 'POST') {
        const phone = path.slice('payment/'.length, -('/log'.length));
        return await handleLogPayment(request, env, phone, corsHeaders);
      }

      if (path.startsWith('receipt/')) {
        const rest   = path.slice('receipt/'.length);
        const slash  = rest.indexOf('/');
        const rPhone = slash > -1 ? rest.slice(0, slash) : rest;
        const action = slash > -1 ? rest.slice(slash + 1) : '';
        if (action === 'send'  && request.method === 'POST')  return await handleReceiptSend(request, env, rPhone, corsHeaders);
        if (action === 'track' && request.method === 'PATCH') return await handleReceiptTrack(request, env, rPhone, corsHeaders);
        if (action === ''      && request.method === 'GET')   return await handleGetReceipt(env, rPhone, corsHeaders);
      }



      if (path.startsWith('agreement/') && path.endsWith('/edit-services') && request.method === 'PUT') {
        const phone = path.slice('agreement/'.length, -('/edit-services'.length));
        return await handleEditServices(request, env, phone, corsHeaders);
      }

      if (path.startsWith('agreement/') && path.endsWith('/manual-confirm') && request.method === 'POST') {
        const phone = path.slice('agreement/'.length, -('/manual-confirm'.length));
        return await handleManualConfirm(request, env, phone, corsHeaders);
      }

      if (path.startsWith('agreement/') && path.endsWith('/skip-reminder') && request.method === 'POST') {
        const phone = path.slice('agreement/'.length, -('/skip-reminder'.length));
        return await handleSkipReminder(request, env, phone, corsHeaders);
      }

      if (path.startsWith('agreement/') && path.endsWith('/log-reminder') && request.method === 'POST') {
        const phone = path.slice('agreement/'.length, -('/log-reminder'.length));
        return await handleLogReminder(request, env, phone, corsHeaders);
      }

      if (path.startsWith('agreement/') && path.endsWith('/confirm') && request.method === 'PUT') {
        const phone = path.slice('agreement/'.length, -(('/confirm').length));
        return await handleAgreementConfirm(request, env, phone, corsHeaders);
      }

      if (path.startsWith('appointment/') && (path.endsWith('/date-change') || path.endsWith('/changes')) && request.method === 'POST') {
        const isDateChange = path.endsWith('/date-change');
        const phone = path.slice('appointment/'.length, -(isDateChange ? '/date-change' : '/changes').length);
        const db = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
        const c  = (db.customers||[]).find(x => (x.phone||'').replace(/\D/g,'').slice(-10) === (phone||'').replace(/\D/g,'').slice(-10));
        if (!c) return jsonResponse({ error: 'not found' }, corsHeaders, 404);
        if (!c.scheduledStatus) c.scheduledStatus = {};
        if (isDateChange) c.scheduledStatus.dateChangeRequested = true;
        else              c.scheduledStatus.changesRequested    = true;
        c.scheduledStatus.requestedAt = new Date().toISOString();
        await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
        return jsonResponse({ success: true }, corsHeaders);
      }

      // ── Customer delete / restore / hard-delete ───────────────────────────────
      if (path.startsWith('customer/')) {
        const rest   = path.slice('customer/'.length);
        const slash  = rest.indexOf('/');
        const cPhone = slash > -1 ? rest.slice(0, slash) : rest;
        const action = slash > -1 ? rest.slice(slash + 1) : '';

        if (action === 'delete' && request.method === 'POST')
          return await handleCustomerSoftDelete(request, env, cPhone, corsHeaders);
        if (action === 'restore' && request.method === 'POST')
          return await handleCustomerRestore(request, env, cPhone, corsHeaders);
        if (action === 'permanent-delete' && request.method === 'POST')
          return await handleCustomerHardDelete(request, env, cPhone, corsHeaders);
      }

      if (path === 'admin/cron-heartbeat' && request.method === 'GET') {
        const hb = await env.DATA.get('bouncie:last_cron_run', 'json');
        return jsonResponse(hb || { status: 'never_run' }, corsHeaders);
      }

      if (path === 'admin/recently-deleted' && request.method === 'GET')
        return await handleRecentlyDeleted(env, corsHeaders);

      // ── Reviews hub ───────────────────────────────────────────────────────────
      if (path === 'admin/reviews-hub' && request.method === 'GET')
        return await handleReviewsHub(env, corsHeaders);

      if (path === 'admin/reviews/actual-count' && request.method === 'POST')
        return await handleReviewsUpdateCount(request, env, corsHeaders);

      if (path === 'admin/reviews/template' && request.method === 'POST')
        return await handleReviewsSaveTemplate(request, env, corsHeaders);

      if (path.startsWith('admin/reviews/template/') && request.method === 'DELETE') {
        const tid = path.slice('admin/reviews/template/'.length);
        return await handleReviewsDeleteTemplate(env, tid, corsHeaders);
      }

      // ── Customer review actions ───────────────────────────────────────────────
      if (path.startsWith('customer/')) {
        const rest   = path.slice('customer/'.length);
        const slash  = rest.indexOf('/');
        const cPhone = slash > -1 ? rest.slice(0, slash) : rest;
        const action = slash > -1 ? rest.slice(slash + 1) : '';

        if (action === 'review-request-sent' && request.method === 'POST')
          return await handleReviewRequestSent(request, env, cPhone, corsHeaders);
        if (action === 'review-status' && request.method === 'POST')
          return await handleReviewStatus(request, env, cPhone, corsHeaders);
        if (action === 'allow-asking-again' && request.method === 'POST')
          return await handleAllowAskingAgain(env, cPhone, corsHeaders);
      }

      // ════════════════════════════════════════════════════════════════════════
      // ── Photo storage ────────────────────────────────────────────────────────
      if (path === 'photos' && request.method === 'GET') {
        return await handlePhotoList(url, env, corsHeaders);
      }
      if (path === 'photos' && request.method === 'POST') {
        return await handlePhotoUpload(request, env, corsHeaders);
      }
      if (path.startsWith('photos/') && !path.includes('/thumb')) {
        const photoId = path.slice('photos/'.length);
        if (request.method === 'GET') return await handlePhotoGet(env, photoId, false, corsHeaders);
        if (request.method === 'DELETE') return await handlePhotoDelete(env, photoId, corsHeaders);
        if (request.method === 'PATCH') return await handlePhotoPatch(request, env, photoId, corsHeaders);
      }
      if (path.startsWith('photos/') && path.endsWith('/thumb')) {
        const photoId = path.slice('photos/'.length, -'/thumb'.length);
        if (request.method === 'GET') return await handlePhotoGet(env, photoId, true, corsHeaders);
      }

      // ── Import backup / snapshot / rollback ──────────────────────────────────
      if (path === 'import/snapshot' && request.method === 'POST') {
        return await handleImportSnapshot(env, corsHeaders);
      }
      if (path === 'import/snapshots' && request.method === 'GET') {
        const list = await env.DATA.get('customer_db_snapshots', 'json') || [];
        return jsonResponse({ snapshots: list }, corsHeaders);
      }
      if (path === 'import/rollback' && request.method === 'POST') {
        return await handleImportRollback(request, env, corsHeaders);
      }

      // ── Bouncie OAuth ─────────────────────────────────────────────────────────
      if (path === 'oauth/bouncie/start' && request.method === 'GET') {
        return await handleBouncieStart(env);
      }
      if (path === 'oauth/bouncie/callback' && request.method === 'GET') {
        return await handleBouncieCallback(request, env, url);
      }

      // ── Bouncie vehicles API (Phase 1) ────────────────────────────────────────
      if (path === 'api/bouncie/vehicles' && request.method === 'GET') {
        return await handleBouncieVehicles(env, corsHeaders);
      }

      // ── Bouncie rig mapping ───────────────────────────────────────────────────
      if (path === 'api/bouncie/rig-mapping') {
        if (request.method === 'GET') {
          const mapping = await env.DATA.get('bouncie:rig_mapping', 'json') || {};
          return jsonResponse({ mapping }, corsHeaders);
        }
        if (request.method === 'PUT') {
          const body = await request.json().catch(() => null);
          await env.DATA.put('bouncie:rig_mapping', JSON.stringify(body?.mapping || {}));
          return jsonResponse({ success: true }, corsHeaders);
        }
      }

      // ── Bouncie job duration match (Phase 2) ──────────────────────────────────
      if (path === 'api/bouncie/match' && request.method === 'GET') {
        const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
        try {
          const result = await bouncieJobDurationMatcher(date, env);
          return jsonResponse(result, corsHeaders);
        } catch(e) {
          return jsonResponse({ error: e.message }, corsHeaders, 500);
        }
      }

      // ── Geocode (single address → coordinates, optionally saved to customer) ────
      if (path === 'api/geocode' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { address, phone } = body;
        if (!address) return jsonResponse({ error: 'address required' }, corsHeaders, 400);
        const geo = await geocodeAddress(address, env);
        if (!geo) return jsonResponse({ error: 'geocode_failed', address }, corsHeaders, 422);
        // If phone provided, save coordinates to customer record
        if (phone) {
          const norm = p => (p||'').replace(/\D/g,'').slice(-10);
          const db = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
          const c  = (db.customers||[]).find(x => norm(x.phone) === norm(phone));
          if (c) {
            c.coordinates = { ...geo };
            // Keep c.geocoded in sync for backward-compat with calendar's getJobCoords()
            c.geocoded = { lat: geo.lat, lng: geo.lng, formattedAddress: geo.formattedAddress || '',
                           accuracy: geo.confidence === 'high' ? 'ROOFTOP' : 'RANGE_INTERPOLATED',
                           geocodedAt: geo.geocodedAt };
            if (geo.confidence === 'low') c.needsAddressVerification = true;
            await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
          }
        }
        return jsonResponse({ success: true, ...geo }, corsHeaders);
      }

      // ── Geocode test ─────────────────────────────────────────────────────────
      if (path === 'api/debug/geocode' && request.method === 'GET') {
        const addr = url.searchParams.get('addr') || '1255 Fairfax Court, Weston, FL';
        const geo = await geocodeAddress(addr, env);
        return jsonResponse({ addr, result: geo, keySet: !!env.GOOGLE_MAPS_API_KEY }, corsHeaders);
      }

      // ── Bouncie morning stop results ─────────────────────────────────────────
      if (path === 'api/bouncie/morning-stops' && request.method === 'GET') {
        const date = url.searchParams.get('date');
        if (!date) return jsonResponse({ error: 'date param required' }, corsHeaders, 400);
        const stored = (await env.DATA.get(`bouncie:morning_stops:${date}`, 'json')) || null;
        const poiStats = {};
        for (const poi of MORNING_STOP_POIS) {
          poiStats[poi.key] = await env.DATA.get(`bouncie:poi_stats:${poi.key}`, 'json');
        }
        return jsonResponse({
          date,
          morningStops: stored?.morningStops || null,
          updatedAt:    stored?.updatedAt    || null,
          poiStats,
          pois: MORNING_STOP_POIS.map(p => ({ key: p.key, label: p.label, emoji: p.emoji, lat: p.lat, lon: p.lon })),
        }, corsHeaders);
      }

      // ── Bouncie raw trips debug (read-only) ───────────────────────────────────
      if (path === 'api/bouncie/trips' && request.method === 'GET') {
        const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
        const imei = url.searchParams.get('imei');
        try {
          const token = await getBouncieAccessToken(env);
          const rigMapping = await env.DATA.get('bouncie:rig_mapping', 'json') || {};
          const targets = imei
            ? [{ rig: 'custom', imei }]
            : Object.entries(rigMapping).filter(([,re]) => re?.imei).map(([rig, re]) => ({ rig, imei: re.imei }));
          const startsAfter = `${date}T00:00:00.000Z`;
          const endsBefore  = `${date}T23:59:59.000Z`;
          const out = {};
          for (const t of targets) {
            const res = await fetch(
              `${BOUNCIE_API_BASE}/trips?imei=${t.imei}&gpsFormat=geojson&startsAfter=${encodeURIComponent(startsAfter)}&endsBefore=${encodeURIComponent(endsBefore)}`,
              { headers: { Authorization: token } }
            );
            const trips = res.ok ? await res.json() : { error: `HTTP ${res.status}` };
            const raw = url.searchParams.get('raw') === '1';
            const summary = Array.isArray(trips) ? trips.map(tr => raw ? tr : {
              startTime: tr.startTime, endTime: tr.endTime,
              startAddress: tr.startAddress, endAddress: tr.endAddress,
              startLoc: tr.startLocation, endLoc: tr.endLocation,
              distance: tr.distance,
              // Include all top-level keys so we can see what Bouncie actually returns
              _allKeys: Object.keys(tr),
            }) : trips;
            out[t.rig] = { imei: t.imei, tripCount: Array.isArray(trips) ? trips.length : 0, trips: summary };
          }
          return jsonResponse({ date, rigs: out }, corsHeaders);
        } catch(e) {
          return jsonResponse({ error: e.message }, corsHeaders, 500);
        }
      }

      // ── Weather proxy (key stays server-side) ────────────────────────────────
      if (path === 'api/weather' && request.method === 'GET') {
        return await handleWeather(env, corsHeaders);
      }

      // ── Review queue status ───────────────────────────────────────────────────
      if (path === 'api/review-queue' && request.method === 'GET') {
        return await handleReviewQueue(env, corsHeaders);
      }

      // ── One-time review queue purge (remove entries before 2026-05-01) ─────────
      if (path === 'admin/purge-review-queue' && request.method === 'POST') {
        return await handlePurgeReviewQueue(env, corsHeaders);
      }

      // ── One-time stats backfill ───────────────────────────────────────────────
      if (path === 'admin/backfill-stats' && request.method === 'POST') {
        return await handleBackfillStats(env, corsHeaders);
      }

      // ── Error log: ingest (public) ────────────────────────────────────────────
      if (path === 'errors/log' && request.method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateKey = `rate:errors:${ip}`;
        const attempts = (await env.DATA.get(rateKey, 'json')) || 0;
        if (attempts >= 20) return jsonResponse({ error: 'rate_limited' }, corsHeaders, 429);
        await env.DATA.put(rateKey, JSON.stringify(attempts + 1), { expirationTtl: 60 });

        const body = await request.json().catch(() => ({}));
        await appendErrorLog(env, {
          id:        crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          source:    (body.source    || 'client').slice(0, 20),
          page:      (body.page      || '').slice(0, 200),
          errorType: (body.errorType || 'Error').slice(0, 100),
          message:   (body.message   || '').slice(0, 500),
          stack:     (body.stack     || '').slice(0, 2000),
          url:       (body.url       || '').slice(0, 500),
          userAgent: (request.headers.get('User-Agent') || '').slice(0, 300),
          ip:        ip.slice(0, 50),
        });
        return jsonResponse({ ok: true }, corsHeaders);
      }

      // ── Error log: admin view (protected) ─────────────────────────────────────
      if (path === 'admin/errors' && request.method === 'GET') {
        const since = url.searchParams.get('since'); // e.g. '24h', '7d', or ISO
        const days  = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(Date.now() - i * 86400000);
          days.push(d.toISOString().split('T')[0]);
        }
        const logs = await Promise.all(days.map(d => env.DATA.get(`errors:log:${d}`, 'json').then(v => v || [])));
        let errors = logs.flat().sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        if (since) {
          const ms  = since.endsWith('h') ? parseInt(since) * 3600000
                    : since.endsWith('d') ? parseInt(since) * 86400000 : null;
          const cut = ms ? new Date(Date.now() - ms).toISOString() : since;
          errors = errors.filter(e => e.timestamp >= cut);
        }
        return jsonResponse({ errors: errors.slice(0, 200), total: errors.length }, corsHeaders);
      }

      // ── Backup: on-demand trigger (protected) ─────────────────────────────────
      if (path === 'admin/backup/now' && request.method === 'POST') {
        if (!env.BACKUPS) return jsonResponse({ error: 'R2 not configured — create bucket and uncomment [[r2_buckets]] in wrangler.toml' }, corsHeaders, 503);
        await runNightlyBackup(env);
        const hb = await env.DATA.get('backup:last_run', 'json');
        return jsonResponse(hb || { status: 'unknown' }, corsHeaders);
      }

      // ── Backup: list all backups (protected) ──────────────────────────────────
      if (path === 'admin/backups' && request.method === 'GET') {
        if (!env.BACKUPS) return jsonResponse({ backups: [], error: 'R2 not configured' }, corsHeaders);
        const listed = await env.BACKUPS.list({ prefix: 'backups/' });
        const backups = (listed.objects || [])
          .map(o => ({
            key:       o.key,
            date:      (o.key.match(/backups\/(\d{4}-\d{2}-\d{2})\//) || [])[1] || '',
            sizeBytes: o.size,
            uploaded:  o.uploaded,
            version:   o.customMetadata?.version || '1',
          }))
          .sort((a, b) => b.date.localeCompare(a.date));
        return jsonResponse({ backups, total: backups.length }, corsHeaders);
      }

      // ── Backup: restore from R2 (protected, destructive) ──────────────────────
      if (path === 'admin/backup/restore' && request.method === 'POST') {
        if (!env.BACKUPS) return jsonResponse({ error: 'R2 not configured' }, corsHeaders, 503);
        const body = await request.json().catch(() => ({}));
        if (!body.backupKey || !body.confirmRestore) {
          return jsonResponse({ error: 'backupKey and confirmRestore: true required' }, corsHeaders, 400);
        }

        // Safety: snapshot current state before overwriting
        const preSnapKey = `customer_db_pre_restore_${Date.now()}`;
        const current = await env.DATA.get('customer_db', 'json');
        if (current) await env.DATA.put(preSnapKey, JSON.stringify(current));

        // Fetch backup from R2
        const obj = await env.BACKUPS.get(body.backupKey);
        if (!obj) return jsonResponse({ error: 'Backup not found' }, corsHeaders, 404);
        const text = await obj.text();
        const backup = JSON.parse(text);

        if (!backup.keys) return jsonResponse({ error: 'Invalid backup format — missing keys' }, corsHeaders, 422);

        // Restore each KV key
        const restored = [];
        for (const [k, v] of Object.entries(backup.keys)) {
          if (v !== null && v !== undefined) {
            await env.DATA.put(k, JSON.stringify(v));
            restored.push(k);
          }
        }

        // Audit log
        await appendErrorLog(env, {
          id:        crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          source:    'worker',
          page:      'admin/backup/restore',
          errorType: 'RESTORE',
          message:   `Restored from ${body.backupKey} — keys: ${restored.join(', ')}`,
          url:       request.url,
          userAgent: (request.headers.get('User-Agent') || '').slice(0, 300),
          ip:        (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 50),
        });

        return jsonResponse({
          success: true,
          restoredFrom: body.backupKey,
          backupTimestamp: backup.timestamp,
          keysRestored: restored,
          preRestoreSnapshot: preSnapKey,
        }, corsHeaders);
      }

      // ── Backup: last run heartbeat (protected) ────────────────────────────────
      if (path === 'admin/backup/last_run' && request.method === 'GET') {
        const hb = await env.DATA.get('backup:last_run', 'json');
        return jsonResponse(hb || { status: 'never_run' }, corsHeaders);
      }

      return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
    } catch (err) {
      console.error('Worker error:', err.message);
      // Log uncaught worker exceptions to error monitoring
      try {
        await appendErrorLog(env, {
          id:        crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          source:    'worker',
          page:      url?.pathname || 'unknown',
          errorType: err.name || 'Error',
          message:   (err.message || String(err)).slice(0, 500),
          stack:     (err.stack || '').slice(0, 2000),
          url:       request?.url || '',
          userAgent: (request?.headers?.get('User-Agent') || '').slice(0, 300),
          ip:        (request?.headers?.get('CF-Connecting-IP') || 'unknown').slice(0, 50),
        });
      } catch {} // never let logging mask the real error
      return jsonResponse({ error: 'Internal server error' }, corsHeaders, 500);
    }
  },
};

// ── Photo storage (KV-backed) ─────────────────────────────────────────────────
async function handlePhotoUpload(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body || !body.jpeg || !body.photoId) return jsonResponse({ error: 'Missing jpeg or photoId' }, corsHeaders, 400);
  const { photoId, jpeg, thumb, metadata = {} } = body;
  // Validate base64 rough check
  if (typeof jpeg !== 'string' || jpeg.length < 100) return jsonResponse({ error: 'Invalid image data' }, corsHeaders, 400);
  // Store full photo
  await env.DATA.put(`photo:${photoId}`, JSON.stringify({ jpeg, metadata }));
  // Store thumbnail separately
  if (thumb) await env.DATA.put(`photo_thumb:${photoId}`, JSON.stringify({ jpeg: thumb }));
  // Update index
  let index = await env.DATA.get('photos_index', 'json') || [];
  index = index.filter(p => p.photoId !== photoId); // remove if re-uploading same
  index.unshift({ photoId, ...metadata, uploadedAt: new Date().toISOString() });
  if (index.length > 20000) index = index.slice(0, 20000);
  await env.DATA.put('photos_index', JSON.stringify(index));
  return jsonResponse({ success: true, photoId }, corsHeaders);
}

async function handlePhotoGet(env, photoId, thumb, corsHeaders) {
  const key = thumb ? `photo_thumb:${photoId}` : `photo:${photoId}`;
  const stored = await env.DATA.get(key, 'json');
  if (!stored) return new Response('Not found', { status: 404, headers: corsHeaders });
  const b64 = stored.jpeg || stored;
  // Decode base64 to binary
  const bin = atob(typeof b64 === 'string' ? b64.replace(/^data:image\/\w+;base64,/, '') : '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes.buffer, {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000', ...corsHeaders },
  });
}

async function handlePhotoList(url, env, corsHeaders) {
  let index = await env.DATA.get('photos_index', 'json') || [];
  const phone = url.searchParams.get('phone');
  const from  = url.searchParams.get('from');
  const to    = url.searchParams.get('to');
  const svc   = url.searchParams.get('service');
  const city  = url.searchParams.get('city');
  if (phone) index = index.filter(p => p.customerPhone === phone);
  if (from)  index = index.filter(p => (p.jobDate||'') >= from);
  if (to)    index = index.filter(p => (p.jobDate||'') <= to);
  if (svc)   index = index.filter(p => (p.services||'').toLowerCase().includes(svc.toLowerCase()));
  if (city)  index = index.filter(p => (p.city||'').toLowerCase() === city.toLowerCase());
  return jsonResponse({ photos: index, total: index.length }, corsHeaders);
}

async function handlePhotoDelete(env, photoId, corsHeaders) {
  await Promise.all([
    env.DATA.delete(`photo:${photoId}`),
    env.DATA.delete(`photo_thumb:${photoId}`),
  ]);
  let index = await env.DATA.get('photos_index', 'json') || [];
  index = index.filter(p => p.photoId !== photoId);
  await env.DATA.put('photos_index', JSON.stringify(index));
  return jsonResponse({ success: true }, corsHeaders);
}

async function handlePhotoPatch(request, env, photoId, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  let index = await env.DATA.get('photos_index', 'json') || [];
  const idx = index.findIndex(p => p.photoId === photoId);
  if (idx >= 0) { index[idx] = { ...index[idx], ...body }; }
  await env.DATA.put('photos_index', JSON.stringify(index));
  // Also patch metadata stored with full photo
  const stored = await env.DATA.get(`photo:${photoId}`, 'json');
  if (stored) {
    stored.metadata = { ...(stored.metadata||{}), ...body };
    await env.DATA.put(`photo:${photoId}`, JSON.stringify(stored));
  }
  return jsonResponse({ success: true }, corsHeaders);
}

// ── Import snapshot / rollback ────────────────────────────────────────────────
async function handleImportSnapshot(env, corsHeaders) {
  const db = await env.DATA.get('customer_db', 'json');
  if (!db) return jsonResponse({ error: 'No customer DB to snapshot' }, corsHeaders, 404);
  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const key = `customer_db_backup_${ts}`;
  await env.DATA.put(key, JSON.stringify(db));
  let list = await env.DATA.get('customer_db_snapshots', 'json') || [];
  list.unshift({ key, createdAt: new Date().toISOString(), customerCount: (db.customers||[]).length });
  if (list.length > 10) {
    const purge = list.splice(10);
    await Promise.all(purge.map(s => env.DATA.delete(s.key).catch(() => {})));
  }
  await env.DATA.put('customer_db_snapshots', JSON.stringify(list));
  return jsonResponse({ success: true, key, createdAt: new Date().toISOString(), customerCount: (db.customers||[]).length }, corsHeaders);
}

async function handleImportRollback(request, env, corsHeaders) {
  const { key } = await request.json().catch(() => ({}));
  if (!key || !key.startsWith('customer_db_backup_'))
    return jsonResponse({ error: 'Invalid backup key' }, corsHeaders, 400);
  const backup = await env.DATA.get(key, 'json');
  if (!backup) return jsonResponse({ error: 'Backup not found' }, corsHeaders, 404);
  await env.DATA.put('customer_db', JSON.stringify(backup));
  return jsonResponse({ success: true, restoredFrom: key, customerCount: (backup.customers||[]).length }, corsHeaders);
}

async function handleResource(request, env, kvKey, corsHeaders) {
  if (request.method === 'GET') {
    const data = await env.DATA.get(kvKey, 'json');
    return jsonResponse(data || {}, corsHeaders);
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    await env.DATA.put(kvKey, JSON.stringify(body));
    return jsonResponse({ success: true }, corsHeaders);
  }

  if (request.method === 'POST') {
    // Append a new entry to a list-style resource
    const newEntry = await request.json();
    const existing = await env.DATA.get(kvKey, 'json') || {};

    // Determine the array field name based on resource
    const arrayField = getArrayField(kvKey);
    if (!existing[arrayField]) existing[arrayField] = [];

    // Add ID and timestamp if not present
    if (!newEntry.id) newEntry.id = generateId();
    if (!newEntry.createdAt) newEntry.createdAt = new Date().toISOString();

    existing[arrayField].push(newEntry);
    await env.DATA.put(kvKey, JSON.stringify(existing));

    return jsonResponse({ success: true, entry: newEntry }, corsHeaders);
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return jsonResponse({ error: 'ID required' }, corsHeaders, 400);

    const existing = await env.DATA.get(kvKey, 'json') || {};
    const arrayField = getArrayField(kvKey);
    if (existing[arrayField]) {
      existing[arrayField] = existing[arrayField].filter(e => e.id !== id);
      await env.DATA.put(kvKey, JSON.stringify(existing));
    }

    return jsonResponse({ success: true }, corsHeaders);
  }

  return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
}

async function handleQuote(request, env, quoteCode, corsHeaders) {
  const kvKey = `quote_${quoteCode}`;

  if (request.method === 'GET') {
    const data = await env.DATA.get(kvKey, 'json');
    if (!data) return jsonResponse({ error: 'Quote not found' }, corsHeaders, 404);
    return jsonResponse(data, corsHeaders);
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    if (!body.createdAt) body.createdAt = new Date().toISOString();
    body.lastUpdated = new Date().toISOString();
    await env.DATA.put(kvKey, JSON.stringify(body));
    return jsonResponse({ success: true, code: quoteCode }, corsHeaders);
  }

  if (request.method === 'PATCH') {
    const existing = await env.DATA.get(kvKey, 'json');
    if (!existing) return jsonResponse({ error: 'Quote not found' }, corsHeaders, 404);
    const updates = await request.json();
    const merged = { ...existing, ...updates, lastUpdated: new Date().toISOString() };
    await env.DATA.put(kvKey, JSON.stringify(merged));
    return jsonResponse({ success: true, quote: merged }, corsHeaders);
  }

  if (request.method === 'DELETE') {
    await env.DATA.delete(kvKey);
    return jsonResponse({ success: true }, corsHeaders);
  }

  return jsonResponse({ error: 'Method not allowed' }, corsHeaders, 405);
}

// ── Agreement confirm ─────────────────────────────────────────────────────────
async function handleAgreementConfirm(request, env, phone, corsHeaders) {
  const body = await request.json();
  const { date, display, rig, rigLabel, approvedAmount, services, addOns, quoteCode: qCode, city, address, email } = body;

  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const now = new Date().toISOString();

  // Backfill missing fields from quote data — never overwrite populated values
  if (city    && !cust.city)    cust.city    = city;
  if (address && !cust.address) cust.address = address;
  if (email   && !cust.email)   cust.email   = email;

  cust.quoteStatus = {
    ...(cust.quoteStatus || {}),
    state: 'confirmed',
    confirmedDate: date,
    confirmedDateDisplay: display,
    confirmedAt: now,
    approvedAmount,
    addOns: addOns || [],
  };

  cust.scheduledStatus = {
    ...(cust.scheduledStatus || {}),
    state: 'scheduled',
    scheduledDate: date,
    rig: rig || cust.scheduledStatus?.rig || null,
    approvedAmount,
    jobNotes: services || cust.scheduledStatus?.jobNotes || '',
    confirmedByCustomer: true,
    confirmedAt: now,
  };

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));

  if (qCode) {
    const kvKey  = `quote_${qCode}`;
    const existing = await env.DATA.get(kvKey, 'json');
    if (existing) {
      await env.DATA.put(kvKey, JSON.stringify({
        ...existing,
        confirmedDate: date,
        confirmedDateDisplay: display,
        confirmedAt: now,
        approvedAmount,
        addOns: addOns || existing.addOns || [],
        lastUpdated: now,
      }));
    }
  }

  return jsonResponse({ success: true, confirmedDate: date, confirmedDateDisplay: display }, corsHeaders);
}

// ── Payment logging + receipt ─────────────────────────────────────────────────
async function handleLogPayment(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { totalPaid, method, methodOther, paidDate, notes } = body;

  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const now = new Date().toISOString();
  cust.paymentInfo = {
    totalPaid: totalPaid || 0,
    method:     method     || 'cash',
    methodOther: methodOther || '',
    paidDate:   paidDate   || now.slice(0, 10),
    paidAt:     now,
    notes:      notes      || '',
  };

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true }, corsHeaders);
}

async function handleGetReceipt(env, phone, corsHeaders) {
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);
  return jsonResponse({ customer: cust }, corsHeaders);
}

async function handleReceiptSend(request, env, phone, corsHeaders) {
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const now = new Date().toISOString();
  cust.receiptInfo = { ...(cust.receiptInfo||{}), sentAt: now, sentTo: phone };
  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true, sentAt: now }, corsHeaders);
}

async function handleReceiptTrack(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { event } = body;
  const FIELDS = { viewed:'viewedAt', pdf_downloaded:'pdfDownloadedAt', printed:'printedAt', emailed:'emailedAt', review_clicked:'reviewClickedAt', request_another_clicked:'requestAnotherClickedAt' };
  const field = FIELDS[event];
  if (!field) return jsonResponse({ error: 'Unknown event' }, corsHeaders, 400);

  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  if (!cust.receiptInfo) cust.receiptInfo = {};
  cust.receiptInfo[field] = cust.receiptInfo[field] || new Date().toISOString();
  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true }, corsHeaders);
}

// ── Edit services ─────────────────────────────────────────────────────────────
async function handleEditServices(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { servicesAgreed, basePrice, addOns, notes, editedBy, quoteCode: qCode } = body;

  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const now = new Date().toISOString();
  const qs  = cust.quoteStatus || {};
  const ss  = cust.scheduledStatus || {};

  const newServices   = typeof servicesAgreed === 'string' ? servicesAgreed : (servicesAgreed?.fullDescription || qs.mainServices || '');
  const enabledAddons = (addOns || []).filter(a => a.enabled);
  const addonsTotal   = enabledAddons.reduce((s, a) => s + (a.bundle || 0), 0);
  const totalAmount   = (basePrice || 0) + addonsTotal;

  const historyEntry = {
    at: now, by: editedBy || 'mom',
    previousState: { services: qs.mainServices || '', price: ss.approvedAmount || qs.approvedAmount || 0 },
    newState:      { services: newServices, price: totalAmount },
    notes: notes || '',
  };

  cust.quoteStatus = {
    ...qs,
    mainServices: newServices,
    servicesAgreed: { fullDescription: newServices },
    approvedAmount: basePrice || 0,
    totalAmount,
    lastEditedAt: now,
    editHistory: [...(qs.editHistory || []), historyEntry],
    miniQuoteCustomData: { ...(qs.miniQuoteCustomData || {}), ...(addOns ? { addOns } : {}) },
  };

  cust.scheduledStatus = { ...ss, approvedAmount: totalAmount, jobNotes: newServices, lastEditedAt: now };

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));

  if (qCode) {
    const existing = await env.DATA.get(`quote_${qCode}`, 'json');
    if (existing) {
      await env.DATA.put(`quote_${qCode}`, JSON.stringify({
        ...existing, mainServices: newServices, approvedAmount: basePrice || 0,
        totalAmount, addOns: enabledAddons, lastEditedAt: now,
        miniQuoteCustomData: cust.quoteStatus.miniQuoteCustomData, lastUpdated: now,
      }));
    }
  }

  return jsonResponse({ success: true, totalAmount }, corsHeaders);
}


async function handleManualConfirm(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { scheduledDate, rig } = body;

  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const now = new Date().toISOString();
  cust.quoteStatus = { ...(cust.quoteStatus||{}), state:'confirmed', confirmedBy:'verbal', confirmedAt:now, reminderSkipped:true };

  const ss = cust.scheduledStatus || {};
  if (scheduledDate) {
    cust.scheduledStatus = {
      ...ss, state:'scheduled', scheduledDate, rig: rig || ss.rig || null,
      approvedAmount: ss.approvedAmount || cust.quoteStatus?.approvedAmount || 0,
      confirmedByCustomer: false, confirmedAt: now,
    };
  } else if (!ss.state || ss.state === 'needs_scheduling') {
    cust.scheduledStatus = { ...ss, state: 'needs_scheduling' };
  }

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true }, corsHeaders);
}

async function handleSkipReminder(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const skip = body.skip !== false;

  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  cust.quoteStatus = { ...(cust.quoteStatus||{}), reminderSkipped: skip };
  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true, reminderSkipped: skip }, corsHeaders);
}

async function handleLogReminder(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { type } = body;

  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const qs  = cust.quoteStatus || {};
  const now = new Date().toISOString();
  cust.quoteStatus = { ...qs, remindersSent: [...(qs.remindersSent||[]), { sentAt:now, type: type||'first' }] };
  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true }, corsHeaders);
}

// ── Date suggestion algorithm ─────────────────────────────────────────────────
async function handleDateSuggest(url, env, corsHeaders) {
  const city     = (url.searchParams.get('city') || '').trim().toLowerCase();
  const RIGS     = ['rig_1', 'rig_2', 'rig_3'];
  const RIG_LABELS = { rig_1: 'Old Tacoma', rig_2: 'New Tacoma', rig_3: 'Chevy' };
  const MAX_PER_RIG = 3;
  const DAY_NAMES   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAY_SCORES  = [0, 3, 5, 5, 5, 3, 0]; // prefer Tue/Wed/Thu

  const [custData, blockedData] = await Promise.all([
    env.DATA.get(KV_KEYS.customers, 'json')    || { customers: [] },
    env.DATA.get(KV_KEYS.blockedWeeks, 'json') || { blockedWeeks: [] },
  ]);
  const customers    = custData.customers || [];
  const blockedWeeks = blockedData.blockedWeeks || [];

  // Build capacity map: { 'YYYY-MM-DD': { rig_1: N, rig_2: N, rig_3: N } }
  const cap = {};
  customers.forEach(c => {
    const ss = c.scheduledStatus || {};
    if ((ss.state === 'scheduled' || ss.state === 'in_progress') && ss.scheduledDate && ss.rig) {
      if (!cap[ss.scheduledDate]) cap[ss.scheduledDate] = {};
      cap[ss.scheduledDate][ss.rig] = (cap[ss.scheduledDate][ss.rig] || 0) + 1;
    }
  });

  // Walk next 28 calendar days (enough to always find 3 business days)
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const candidates = [];

  for (let offset = 1; offset <= 28 && candidates.length < 9; offset++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() + offset);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends

    const dateStr = d.toISOString().slice(0, 10);

    // Skip blocked weeks
    if (blockedWeeks.some(bw => dateStr >= bw.weekStart && dateStr <= bw.weekEnd)) continue;

    // Check capacity
    const dayCap = cap[dateStr] || {};
    const availRigs = RIGS.filter(r => (dayCap[r] || 0) < MAX_PER_RIG);
    if (!availRigs.length) continue; // all rigs full

    // Geography score: jobs in same city that day
    const sameCityJobs = customers.filter(c => {
      const ss = c.scheduledStatus || {};
      return ss.scheduledDate === dateStr &&
             (ss.state === 'scheduled' || ss.state === 'in_progress') &&
             (c.city || '').trim().toLowerCase() === city;
    });
    const geoScore = sameCityJobs.length > 0 ? 5 + sameCityJobs.length : 0;

    // Capacity clustering score (some jobs → good, empty → neutral, very full → less good)
    const totalJobs = Object.values(dayCap).reduce((s, n) => s + n, 0);
    const clusterScore = totalJobs > 0 && totalJobs < 6 ? 2 : 0;

    const totalScore = geoScore + DAY_SCORES[dow] + clusterScore;

    // Best rig: least loaded available
    const bestRig = availRigs.sort((a, b) => (dayCap[a] || 0) - (dayCap[b] || 0))[0];

    // Build reason string
    let reason;
    if (sameCityJobs.length > 0) {
      reason = `${sameCityJobs.length} other ${city || 'area'} job${sameCityJobs.length > 1 ? 's' : ''} that day · ${RIG_LABELS[bestRig]} available`;
    } else if (totalJobs === 0) {
      reason = `Open day · ${RIG_LABELS[bestRig]} available`;
    } else {
      reason = `${totalJobs} job${totalJobs > 1 ? 's' : ''} scheduled · ${RIG_LABELS[bestRig]} has room`;
    }

    candidates.push({
      date:       dateStr,
      dayName:    DAY_NAMES[dow],
      display:    `${DAY_NAMES[dow]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`,
      score:      totalScore,
      rig:        bestRig,
      rigLabel:   RIG_LABELS[bestRig],
      reason,
      geoMatch:   sameCityJobs.length > 0,
    });
  }

  // Sort by score desc, take top 3
  candidates.sort((a, b) => b.score - a.score);
  const top3 = candidates.slice(0, 3).map((s, i) => ({
    ...s,
    label: i === 0 ? 'Best fit' : 'Alternative',
  }));

  return jsonResponse({ suggestions: top3 }, corsHeaders);
}

// ── Reviews Hub ──────────────────────────────────────────────────────────────
const REVIEW_LINK = 'https://share.google/ChFC1uAe9Xdveb8XN';

const DEFAULT_TEMPLATES = [
  {
    id: 'tpl_fumero_family',
    name: 'Fumero Family (default)',
    body: `Hi {firstName}! It was a pleasure servicing your home. If you have a moment, a quick 5-star Google review would mean the world to our family business 🙏\n\nClick here: {reviewLink}\n\nMentioning the service (like soft wash or driveway) and your city helps us grow.\n\nThanks so much for your support!\n\n— The Fumero Family\nPure Cleaning Pressure Cleaning`,
    isActive: true, createdAt: '2026-05-07T00:00:00.000Z', timesUsed: 0, reviewsGenerated: 0
  },
  {
    id: 'tpl_direct',
    name: 'Direct ask',
    body: `Hey {firstName}! Tony finished your {service} on {jobDate}.\n\nCould you take 30 seconds to leave a Google review?\n{reviewLink}\n\nMeans a lot. Thanks! — Pure Cleaning`,
    isActive: false, createdAt: '2026-01-01T00:00:00.000Z', timesUsed: 0, reviewsGenerated: 0
  },
  {
    id: 'tpl_family',
    name: 'Family business angle',
    body: `Hi {firstName}! We hope you loved your {service}.\n\nPure Cleaning is family-owned since 1995, and Google reviews are how new customers find us. If you're up for it, would you leave a quick review?\n\n⭐ {reviewLink}\n\nTruly appreciate it. — The Pure Cleaning Family`,
    isActive: false, createdAt: '2026-01-01T00:00:00.000Z', timesUsed: 0, reviewsGenerated: 0
  },
  {
    id: 'tpl_casual',
    name: 'Casual / no pressure',
    body: `Hey {firstName}! How'd your {service} turn out?\n\nIf you're happy with it, a quick Google review would mean the world: {reviewLink}\n\nNo pressure either way! — Tony`,
    isActive: false, createdAt: '2026-01-01T00:00:00.000Z', timesUsed: 0, reviewsGenerated: 0
  },
];

const REVIEW_ELIGIBLE_CUTOFF = '2026-05-01';

function reviewIsReadyToRequest(c, nowIso, sevenDaysAgo, thirtyDaysAgo) {
  if (c.deleted) return false;
  const gr = c.googleReview || {};
  const st = gr.status || 'never_asked';
  if (st === 'left' || st === 'do_not_ask') return false;
  if (st === 'asked') return false;
  if (st === 'declined' && gr.reaskEligibleAt && gr.reaskEligibleAt > nowIso) return false;
  if (gr.lastRequestSentAt && gr.lastRequestSentAt > thirtyDaysAgo) return false;

  // Must have a completed job on or after the cutoff date.
  // Require completedAt (calendar completions always set this).
  // Exclude csv_backfill entries — they're historical records, not recent completions.
  const jh = c.jobHistory || [];
  const hasQualifyingJH = jh.some(j =>
    j.status === 'completed' &&
    j.source !== 'csv_backfill' &&
    j.completedAt &&
    j.completedAt >= REVIEW_ELIGIBLE_CUTOFF
  );
  if (hasQualifyingJH) return true;

  // Calendar completions write completedAt on scheduledStatus
  const ss = c.scheduledStatus || {};
  if (ss.state === 'completed' && ss.completedAt && ss.completedAt >= REVIEW_ELIGIBLE_CUTOFF) return true;

  return false;
}

function reviewJobService(c) {
  const ss = c.scheduledStatus || {};
  const qs = c.quoteStatus || {};
  return ss.jobNotes || qs.mainServices || qs.notes || 'Pressure Cleaning';
}

function reviewJobDate(c) {
  const jh = c.jobHistory || [];
  const qualifying = jh
    .filter(j => j.status === 'completed' && j.source !== 'csv_backfill' && j.completedAt && j.completedAt >= REVIEW_ELIGIBLE_CUTOFF)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  if (qualifying.length) return qualifying[0].completedAt;
  const ss = c.scheduledStatus || {};
  if (ss.state === 'completed' && ss.completedAt && ss.completedAt >= REVIEW_ELIGIBLE_CUTOFF)
    return ss.completedAt;
  return null;
}

async function handleReviewsHub(env, corsHeaders) {
  const [db, templates, actualCountRaw] = await Promise.all([
    env.DATA.get(KV_KEYS.customers, 'json').then(d => d || { customers: [] }),
    env.DATA.get('reviews_templates', 'json'),
    env.DATA.get('reviews_actual_count', 'json'),
  ]);

  const tpls      = templates || DEFAULT_TEMPLATES;
  const actualCount = actualCountRaw || { count: 92, lastUpdatedAt: null, updatedBy: null, history: [] };
  const customers = (db.customers || []).filter(c => !c.deleted);

  const now        = new Date();
  const nowIso     = now.toISOString();
  const sevenDays  = new Date(now - 4  * 86400000).toISOString().slice(0, 10); // 4-day review window
  const thirtyDays = new Date(now - 30 * 86400000).toISOString();
  const sixMonthsAgo = new Date(now - 180 * 86400000).toISOString();
  const thisMonthStart = now.toISOString().slice(0, 7) + '-01';
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);

  const readyToRequest = [], awaitingConfirmation = [], reviewed = [], wontAsk = [];
  let totalAsked = 0, thisMonthReviewed = 0, lastMonthReviewed = 0;
  const byTemplate = {};

  for (const c of customers) {
    const gr = c.googleReview || {};
    const st = gr.status || 'never_asked';

    if (st === 'left') {
      reviewed.push(c);
      totalAsked++;
      if (gr.leftAt && gr.leftAt >= thisMonthStart) thisMonthReviewed++;
      if (gr.leftAt && gr.leftAt >= lastMonthStart && gr.leftAt <= lastMonthEnd + 'T23:59:59Z') lastMonthReviewed++;
      if (gr.templateUsedId) byTemplate[gr.templateUsedId] = (byTemplate[gr.templateUsedId] || { asked: 0, reviewed: 0 });
      if (gr.templateUsedId) byTemplate[gr.templateUsedId].reviewed++;
    } else if (st === 'do_not_ask') {
      wontAsk.push(c);
    } else if (st === 'declined' && gr.reaskEligibleAt && gr.reaskEligibleAt > nowIso) {
      wontAsk.push(c);
    } else if (st === 'asked') {
      awaitingConfirmation.push(c);
      totalAsked++;
      if (gr.templateUsedId) { byTemplate[gr.templateUsedId] = byTemplate[gr.templateUsedId] || { asked: 0, reviewed: 0 }; byTemplate[gr.templateUsedId].asked++; }
    } else if (reviewIsReadyToRequest(c, nowIso, sevenDays, thirtyDays)) {
      readyToRequest.push(c);
    }
  }

  // Sort ready by most recent job date first, limit to 100
  readyToRequest.sort((a, b) => {
    const da = reviewJobDate(a) || ''; const db2 = reviewJobDate(b) || '';
    return db2.localeCompare(da);
  });

  const conversionRate = totalAsked > 0 ? Math.round(reviewed.length / totalAsked * 100) : 0;

  return jsonResponse({
    readyToRequest: readyToRequest.slice(0, 100),
    readyTotal: readyToRequest.length,
    awaitingConfirmation,
    reviewed,
    wontAsk,
    templates: tpls,
    actualCount,
    insights: {
      totalReviewed: reviewed.length,
      totalAsked,
      conversionRate,
      thisMonthReviewed,
      lastMonthReviewed,
      byTemplate,
    },
  }, corsHeaders);
}

async function handleReviewsUpdateCount(request, env, corsHeaders) {
  const { count, updatedBy = 'tyler' } = await request.json().catch(() => ({}));
  if (typeof count !== 'number' || count < 0) return jsonResponse({ error: 'Invalid count' }, corsHeaders, 400);
  const existing = await env.DATA.get('reviews_actual_count', 'json') || { count: 92, lastUpdatedAt: null, history: [] };
  const entry = { count, date: new Date().toISOString().slice(0, 10) };
  existing.count = count;
  existing.lastUpdatedAt = new Date().toISOString();
  existing.updatedBy = updatedBy;
  existing.history = [entry, ...(existing.history || [])].slice(0, 24);
  await env.DATA.put('reviews_actual_count', JSON.stringify(existing));
  return jsonResponse({ success: true, ...existing }, corsHeaders);
}

async function handleReviewsSaveTemplate(request, env, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const existing = await env.DATA.get('reviews_templates', 'json') || [...DEFAULT_TEMPLATES];

  if (body.isActive) existing.forEach(t => { t.isActive = false; });

  if (body.id) {
    const idx = existing.findIndex(t => t.id === body.id);
    if (idx !== -1) {
      existing[idx] = { ...existing[idx], ...body, id: body.id };
    } else {
      existing.push({ timesUsed: 0, reviewsGenerated: 0, createdAt: new Date().toISOString(), ...body });
    }
  } else {
    body.id = 'tpl_' + Math.random().toString(36).slice(2, 10);
    body.createdAt = new Date().toISOString();
    body.timesUsed = 0; body.reviewsGenerated = 0;
    existing.push(body);
  }
  await env.DATA.put('reviews_templates', JSON.stringify(existing));
  return jsonResponse({ success: true, templates: existing }, corsHeaders);
}

async function handleReviewsDeleteTemplate(env, tid, corsHeaders) {
  const existing = await env.DATA.get('reviews_templates', 'json') || [...DEFAULT_TEMPLATES];
  const tpl = existing.find(t => t.id === tid);
  if (!tpl) return jsonResponse({ error: 'Template not found' }, corsHeaders, 404);
  if (tpl.isActive) return jsonResponse({ error: 'Cannot delete the active template. Set another as active first.' }, corsHeaders, 400);
  const filtered = existing.filter(t => t.id !== tid);
  await env.DATA.put('reviews_templates', JSON.stringify(filtered));
  return jsonResponse({ success: true }, corsHeaders);
}

async function handleReviewRequestSent(request, env, phone, corsHeaders) {
  const { templateUsedId = null, jobId = null } = await request.json().catch(() => ({}));
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const now = new Date().toISOString();
  cust.googleReview = {
    ...(cust.googleReview || {}),
    status: 'asked',
    askedAt: cust.googleReview?.askedAt || now,
    lastRequestSentAt: now,
    requestCount: ((cust.googleReview || {}).requestCount || 0) + 1,
    templateUsedId: templateUsedId || cust.googleReview?.templateUsedId || null,
    sourceJobId: jobId || cust.googleReview?.sourceJobId || null,
  };

  // Increment template usage
  if (templateUsedId) {
    const tpls = await env.DATA.get('reviews_templates', 'json');
    if (tpls) {
      const tpl = tpls.find(t => t.id === templateUsedId);
      if (tpl) { tpl.timesUsed = (tpl.timesUsed || 0) + 1; await env.DATA.put('reviews_templates', JSON.stringify(tpls)); }
    }
  }

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true, googleReview: cust.googleReview }, corsHeaders);
}

async function handleReviewStatus(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { status, noteAboutReview } = body;
  const VALID = ['left','declined','do_not_ask','never_asked','asked'];
  if (!VALID.includes(status)) return jsonResponse({ error: 'Invalid status' }, corsHeaders, 400);

  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const now = new Date().toISOString();
  const gr  = cust.googleReview || {};
  gr.status = status;
  if (status === 'left')     { gr.leftAt = now; }
  if (status === 'declined') { gr.declinedAt = now; gr.reaskEligibleAt = new Date(Date.now() + 180 * 86400000).toISOString(); }
  if (status === 'do_not_ask') { gr.doNotAskAt = now; }
  if (noteAboutReview !== undefined) gr.noteAboutReview = noteAboutReview;
  cust.googleReview = gr;

  // Increment reviewsGenerated on template
  if (status === 'left' && gr.templateUsedId) {
    const tpls = await env.DATA.get('reviews_templates', 'json');
    if (tpls) {
      const tpl = tpls.find(t => t.id === gr.templateUsedId);
      if (tpl) { tpl.reviewsGenerated = (tpl.reviewsGenerated || 0) + 1; await env.DATA.put('reviews_templates', JSON.stringify(tpls)); }
    }
  }

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true, googleReview: cust.googleReview }, corsHeaders);
}

async function handleAllowAskingAgain(env, phone, corsHeaders) {
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  cust.googleReview = { ...(cust.googleReview || {}), status: 'never_asked', reaskEligibleAt: null, doNotAskAt: null };
  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true }, corsHeaders);
}

// ── Customer soft-delete / restore / hard-delete ────────────────────────────
const PROTECTED_PHONES = new Set(['9546843614']); // Keith Wolf — never deleteable

async function handleCustomerSoftDelete(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { reason = '', deletedBy = 'tyler' } = body;
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const normPhone = norm(phone);

  if (PROTECTED_PHONES.has(normPhone))
    return jsonResponse({ error: 'protected', message: 'This customer is protected from deletion.' }, corsHeaders, 403);

  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === normPhone);
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  cust.deleted    = true;
  cust.deletedAt  = new Date().toISOString();
  cust.deletedBy  = deletedBy;
  cust.deleteReason = reason || null;

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true, deletedAt: cust.deletedAt }, corsHeaders);
}

async function handleCustomerRestore(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { restoredBy = 'tyler' } = body;
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);

  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  cust.deleted    = false;
  cust.restoredAt = new Date().toISOString();
  cust.restoredBy = restoredBy;

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true, restoredAt: cust.restoredAt }, corsHeaders);
}

async function handleCustomerHardDelete(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { confirmName = '', deletedBy = 'tyler' } = body;
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const normPhone = norm(phone);

  if (PROTECTED_PHONES.has(normPhone))
    return jsonResponse({ error: 'protected', message: 'This customer is protected from deletion.' }, corsHeaders, 403);

  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const idx  = (db.customers||[]).findIndex(c => norm(c.phone) === normPhone);
  if (idx === -1) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const cust = db.customers[idx];
  const fullName = `${cust.firstName||''} ${cust.lastName||''}`.trim().toLowerCase();
  if (confirmName.trim().toLowerCase() !== fullName)
    return jsonResponse({ error: 'name_mismatch', message: 'Name confirmation did not match.' }, corsHeaders, 400);

  db.customers.splice(idx, 1);
  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true }, corsHeaders);
}

async function handleRecentlyDeleted(env, corsHeaders) {
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const deleted = (db.customers||[]).filter(c => c.deleted && c.deletedAt && c.deletedAt >= cutoff);
  deleted.sort((a, b) => (b.deletedAt||'').localeCompare(a.deletedAt||''));
  return jsonResponse({ customers: deleted }, corsHeaders);
}

function getArrayField(kvKey) {
  if (kvKey === KV_KEYS.customers) return 'customers';
  if (kvKey === KV_KEYS.incoming) return 'requests';
  if (kvKey === KV_KEYS.events) return 'events';
  if (kvKey === KV_KEYS.links) return 'links';
  if (kvKey === KV_KEYS.blockedWeeks) return 'blockedWeeks';
  return 'items';
}

function generateId() {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function handleCors(origin) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  });
}

function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      ...corsHeaders,
    },
  });
}

// ── Bouncie OAuth — Phase 1 ───────────────────────────────────────────────────

const BOUNCIE_CLIENT_ID    = 'pure-cleaning-crm';
const BOUNCIE_REDIRECT_URI = 'https://purecleaning-api.tylerfumero.workers.dev/oauth/bouncie/callback';
const BOUNCIE_TOKEN_URL    = 'https://auth.bouncie.com/oauth/token';
const BOUNCIE_AUTH_URL     = 'https://auth.bouncie.com/dialog/authorize';
const BOUNCIE_API_BASE     = 'https://api.bouncie.dev/v1';

const KV_BOUNCIE_REFRESH  = 'bouncie:refresh_token';
const KV_BOUNCIE_ACCESS   = 'bouncie:access_token';
const KV_BOUNCIE_STATE    = 'bouncie:oauth_state';
const KV_BOUNCIE_VEHICLES = 'bouncie:vehicles_cache';

// Redirect user to Bouncie consent screen with CSRF state
async function handleBouncieStart(env) {
  const state = crypto.randomUUID();
  await env.DATA.put(KV_BOUNCIE_STATE, state, { expirationTtl: 600 }); // 10-minute window
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     BOUNCIE_CLIENT_ID,
    redirect_uri:  BOUNCIE_REDIRECT_URI,
    state,
  });
  return Response.redirect(`${BOUNCIE_AUTH_URL}?${params}`, 302);
}

// Exchange auth code for tokens, store in KV
async function handleBouncieCallback(request, env, url) {
  const page = (title, body, ok = true) => new Response(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Pure Cleaning</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,"Helvetica Neue",sans-serif;background:#f4f6f9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1.5rem;}
.card{background:#fff;border-radius:18px;padding:2.5rem 2rem;max-width:440px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1);}
.icon{font-size:52px;margin-bottom:1rem;}
h2{font-size:22px;font-weight:800;color:${ok ? '#0a1628' : '#e53e3e'};margin-bottom:.75rem;}
p{font-size:14px;color:#6b7280;line-height:1.6;margin-top:.5rem;}
code{font-size:12px;background:#f1f5f9;padding:2px 6px;border-radius:4px;}
.meta{font-size:11px;color:#9ca3af;margin-top:1.5rem;font-family:monospace;}
</style></head>
<body><div class="card"><div class="icon">${ok ? '✅' : '❌'}</div><h2>${title}</h2>${body}</div></body></html>`,
  { headers: { 'Content-Type': 'text/html' } });

  const error = url.searchParams.get('error');
  if (error) return page('Authorization Failed',
    `<p>Bouncie returned: <strong>${error}</strong></p>
     <p>Visit <code>/oauth/bouncie/start</code> to try again.</p>`, false);

  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code) return page('No Code Received', '<p>No authorization code from Bouncie.</p>', false);

  // CSRF verification
  const storedState = await env.DATA.get(KV_BOUNCIE_STATE);
  if (!state || state !== storedState) {
    return page('State Mismatch',
      '<p>CSRF state invalid. Visit <code>/oauth/bouncie/start</code> to restart the flow.</p>', false);
  }
  await env.DATA.delete(KV_BOUNCIE_STATE);

  // Exchange code for tokens
  let tokens;
  try {
    const res = await fetch(BOUNCIE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     BOUNCIE_CLIENT_ID,
        client_secret: env.BOUNCIE_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  BOUNCIE_REDIRECT_URI,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return page('Token Exchange Failed',
        `<p>Bouncie returned ${res.status}.</p><p class="meta">${txt}</p>`, false);
    }
    tokens = await res.json();
  } catch(e) {
    return page('Network Error', `<p>${e.message}</p>`, false);
  }

  if (!tokens.refresh_token) {
    return page('No Refresh Token',
      '<p>Bouncie did not return a refresh_token. Check the app scopes in your Bouncie developer dashboard.</p>', false);
  }

  // Store tokens separately in KV
  const expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;
  await Promise.all([
    env.DATA.put(KV_BOUNCIE_REFRESH, tokens.refresh_token),
    env.DATA.put(KV_BOUNCIE_ACCESS, JSON.stringify({
      access_token: tokens.access_token,
      expires_at:   expiresAt,
    })),
  ]);

  return page('Bouncie Connected!',
    `<p>Authorization successful. Tokens stored.</p>
     <p>Test the connection: <code>/api/bouncie/vehicles</code></p>
     <p class="meta">Authorized ${new Date().toLocaleString()}</p>`);
}

// Get a valid access token, refreshing if expired
async function getBouncieAccessToken(env) {
  const cached = await env.DATA.get(KV_BOUNCIE_ACCESS, 'json');
  if (cached?.access_token && cached.expires_at > Date.now() + 300_000) {
    return cached.access_token; // 5-min buffer before expiry
  }

  const refreshToken = await env.DATA.get(KV_BOUNCIE_REFRESH);
  if (!refreshToken) throw new Error('Bouncie not authorized — visit /oauth/bouncie/start');

  const res = await fetch(BOUNCIE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     BOUNCIE_CLIENT_ID,
      client_secret: env.BOUNCIE_CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${txt}`);
  }

  const tokens    = await res.json();
  const expiresAt = Date.now() + (tokens.expires_in || 3600) * 1000;

  await Promise.all([
    env.DATA.put(KV_BOUNCIE_ACCESS, JSON.stringify({ access_token: tokens.access_token, expires_at: expiresAt })),
    ...(tokens.refresh_token ? [env.DATA.put(KV_BOUNCIE_REFRESH, tokens.refresh_token)] : []),
  ]);

  return tokens.access_token;
}

// Return vehicles list — 1-hour KV cache
async function handleBouncieVehicles(env, corsHeaders) {
  const CACHE_MS = 60 * 60 * 1000;
  const cached   = await env.DATA.get(KV_BOUNCIE_VEHICLES, 'json');
  if (cached && (Date.now() - cached.cachedAt) < CACHE_MS) {
    return jsonResponse({ ...cached, fromCache: true }, corsHeaders);
  }

  let accessToken;
  try {
    accessToken = await getBouncieAccessToken(env);
  } catch(e) {
    return jsonResponse({ error: e.message, authorized: false }, corsHeaders, 401);
  }

  const res = await fetch(`${BOUNCIE_API_BASE}/vehicles`, {
    headers: { Authorization: accessToken }, // Bouncie uses raw token, no "Bearer" prefix
  });

  if (!res.ok) {
    const txt = await res.text();
    return jsonResponse({ error: `Bouncie API ${res.status}`, detail: txt }, corsHeaders, 502);
  }

  const raw      = await res.json();
  const list     = Array.isArray(raw) ? raw : (raw.vehicles || raw.data || []);

  const vehicles = list.map(v => ({
    imei:     v.imei     || null,
    vin:      v.vin      || null,
    nickname: v.nickName || v.nickname || v.customName || v.name || v.imei || 'Unknown',
    make:     v.model?.make || null,
    model:    v.model?.name || null,
    year:     v.model?.year || null,
    isRunning: v.stats?.isRunning || false,
    lat:      v.stats?.location?.lat  ?? null,
    lon:      v.stats?.location?.lon  ?? null,
    address:  v.stats?.location?.address || null,
    heading:  v.stats?.location?.heading ?? null,
    speed:    v.stats?.speed    || null,
    odometer: v.stats?.odometer || null,
    battery:  v.stats?.battery?.status || null,
    milOn:    v.stats?.mil?.milOn     || false,
    lastUpdated: v.stats?.lastUpdated || null,
    raw:      v,
  }));

  const result = { vehicles, vehicleCount: vehicles.length, cachedAt: Date.now(), fromCache: false };
  await env.DATA.put(KV_BOUNCIE_VEHICLES, JSON.stringify(result));
  return jsonResponse(result, corsHeaders);
}

// ── Bouncie Phase 2 — Job Duration Matcher ────────────────────────────────────

// Morning route stop POIs — update coordinates to match exact locations.
// Verify via Google Maps: search the address and drop a pin to get lat/lon.
const MORNING_STOP_POIS = [
  {
    key:           'gas',
    label:         '7-Eleven',
    emoji:         '⛽',
    lat:           26.0852,   // TODO: verify exact 7-Eleven on Weston Rd
    lon:           -80.3740,
    thresholdKm:   0.10,      // 100 m
    avgExpectedMin: 5,
  },
  {
    key:           'chlorine',
    label:         'Pro-Line',
    emoji:         '🧪',
    lat:           26.0712,   // TODO: verify exact Pro-Line on Weston Rd
    lon:           -80.3680,
    thresholdKm:   0.10,
    avgExpectedMin: 8,
  },
];

// Scan a rig's trip array for POI dwell stops.
// Uses same arrival/departure pattern as job matching: trip ending near POI = arrival;
// next trip starting near POI = departure; gap between = dwell duration.
function checkMorningStopsForRig(trips, pois, tripFirstCoord, tripLastCoord) {
  const results = {};
  for (const poi of pois) {
    let arrivalTrip = null, closestDist = Infinity;
    for (const trip of trips) {
      const last = tripLastCoord(trip);
      if (!last) continue;
      const d = haversineKm(last[1], last[0], poi.lat, poi.lon);
      if (d < closestDist) closestDist = d;
      if (d <= poi.thresholdKm) {
        if (!arrivalTrip || trip.endTime > arrivalTrip.endTime) arrivalTrip = trip;
      }
    }
    if (!arrivalTrip) {
      results[poi.key] = {
        found:         false,
        label:         poi.label,
        emoji:         poi.emoji,
        closestMeters: Math.round(closestDist * 1000),
      };
      continue;
    }
    let departureTrip = null;
    for (const trip of trips) {
      if (trip.startTime <= arrivalTrip.endTime) continue;
      const first = tripFirstCoord(trip);
      if (!first) continue;
      if (haversineKm(first[1], first[0], poi.lat, poi.lon) <= poi.thresholdKm) {
        if (!departureTrip || trip.startTime < departureTrip.startTime) departureTrip = trip;
      }
    }
    const durationMin = departureTrip
      ? Math.round((new Date(departureTrip.startTime) - new Date(arrivalTrip.endTime)) / 60000)
      : null;
    results[poi.key] = {
      found:       true,
      label:       poi.label,
      emoji:       poi.emoji,
      arrivedAt:   arrivalTrip.endTime,
      departedAt:  departureTrip?.startTime || null,
      durationMin,
    };
  }
  return results;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function geocodeAddress(address, env = null) {
  if (!address) return null;

  // ── Google Maps Geocoding (preferred — requires GOOGLE_MAPS_API_KEY secret) ──
  const apiKey = env?.GOOGLE_MAPS_API_KEY;
  if (apiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&components=country:US&key=${apiKey}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (data.status === 'OK' && data.results?.[0]) {
        const r    = data.results[0];
        const loc  = r.geometry.location;
        const lt   = r.geometry.location_type;
        const conf = lt === 'ROOFTOP' ? 'high'
                   : (lt === 'RANGE_INTERPOLATED' || lt === 'GEOMETRIC_CENTER') ? 'medium'
                   : 'low';
        return {
          lat:              loc.lat,
          lng:              loc.lng,
          lon:              loc.lng, // backward compat alias
          formattedAddress: r.formatted_address,
          placeId:          r.place_id,
          confidence:       conf,
          locationType:     lt,
          geocodedAt:       new Date().toISOString(),
          source:           'google_maps',
        };
      }
      if (data.status !== 'ZERO_RESULTS') {
        console.warn('Google geocode status:', data.status, address);
      }
    } catch (e) { console.warn('Google geocode error:', e.message); }
  }

  // ── Census fallback (no key needed, lower accuracy on FL addresses) ──────────
  try {
    const res = await fetch(
      `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=2020&format=json`,
      { headers: { 'User-Agent': 'PureCleaning/1.0' } }
    );
    const data = await res.json();
    const match = data?.result?.addressMatches?.[0];
    if (!match) return null;
    return {
      lat:    parseFloat(match.coordinates.y),
      lng:    parseFloat(match.coordinates.x),
      lon:    parseFloat(match.coordinates.x),
      formattedAddress: match.matchedAddress || '',
      confidence: 'medium',
      geocodedAt: new Date().toISOString(),
      source: 'census',
    };
  } catch { return null; }
}

async function bouncieJobDurationMatcher(date, env) {
  const db = await env.DATA.get(KV_KEYS.customers, 'json');
  const customers = (db?.customers || []).filter(Boolean);

  // Match any customer with a completed job on this date, via:
  //   a) scheduledStatus.state=completed + scheduledDate=date (calendar-scheduled jobs)
  //   b) jobHistory entry with date=date + status=completed (CSV-imported historical jobs)
  const completedToday = customers.filter(c => {
    const ss = c.scheduledStatus;
    if (ss && ss.state === 'completed') {
      if (ss.scheduledDate === date) return true;
      if (ss.completedAt?.startsWith(date)) return true;
    }
    // Also include customers whose jobHistory has a completed entry for this date
    return (c.jobHistory || []).some(j => j.date === date && j.status === 'completed');
  });
  if (!completedToday.length) {
    return { date, total: 0, matched: 0, message: `No completed jobs on ${date}` };
  }

  const rigMapping = await env.DATA.get('bouncie:rig_mapping', 'json') || {};

  let accessToken;
  try { accessToken = await getBouncieAccessToken(env); }
  catch(e) { return { date, error: 'Bouncie not authorized', message: e.message }; }

  // Bouncie returns trip.gps (LineString), NOT trip.startLocation/endLocation.
  // First coord = trip origin, last coord = trip destination ([lon, lat]).
  //
  // Strict thresholds — no low-confidence auto-attribution:
  const HIGH_KM     = 0.0762; // 250 ft → matched_high
  const MEDIUM_KM   = 0.1524; // 500 ft → matched_medium  (hard reject above this)
  const MIN_DUR_MIN = 20;

  // Pre-fetch trips for ALL rigs in parallel — GPS truth, not intent
  const startsAfter = `${date}T00:00:00.000Z`;
  const endsBefore  = `${date}T23:59:59.000Z`;
  const allRigEntries = Object.entries(rigMapping).filter(([, re]) => re?.imei);
  const rigTripsMap = {};
  await Promise.all(allRigEntries.map(async ([rig, rigEntry]) => {
    try {
      const res = await fetch(
        `${BOUNCIE_API_BASE}/trips?imei=${rigEntry.imei}&gpsFormat=geojson&startsAfter=${encodeURIComponent(startsAfter)}&endsBefore=${encodeURIComponent(endsBefore)}`,
        { headers: { Authorization: accessToken } }
      );
      const trips = res.ok ? await res.json() : [];
      rigTripsMap[rig] = Array.isArray(trips)
        ? trips.sort((a, b) => a.startTime < b.startTime ? -1 : 1)
        : [];
    } catch(e) {
      rigTripsMap[rig] = [];
    }
  }));

  // Extract first and last GPS coordinate from a trip's gps LineString.
  const tripFirstCoord = tr => { const c = tr?.gps?.coordinates; return c?.length ? c[0]          : null; };
  const tripLastCoord  = tr => { const c = tr?.gps?.coordinates; return c?.length ? c[c.length - 1]: null; };

  // Find the closest dwell window in a set of trips for a given job location.
  // Always returns closestDistKm so callers can report distance even on rejection.
  // Only returns a usable durationMin when distance <= MEDIUM_KM and duration >= MIN_DUR_MIN.
  function proximityMatch(trips, jobLat, jobLon) {
    // Find the trip whose last coord is closest to the job (ignoring threshold for now)
    let arrivalTrip = null;
    let closestDistKm = Infinity;
    for (const trip of trips) {
      const last = tripLastCoord(trip);
      if (!last) continue;
      const d = haversineKm(last[1], last[0], jobLat, jobLon);
      if (d < closestDistKm) { closestDistKm = d; arrivalTrip = trip; }
    }
    if (!arrivalTrip) return { durationMin: 0, closestDistKm: Infinity };

    // Hard reject: closest approach is farther than MEDIUM_KM
    if (closestDistKm > MEDIUM_KM) {
      return { durationMin: 0, closestDistKm, closestArrival: arrivalTrip.endTime };
    }

    // Within threshold — find the departure trip (latest trip starting near job, after arrival)
    let departureTrip = null;
    for (const trip of trips) {
      if (trip.startTime <= arrivalTrip.endTime) continue;
      const first = tripFirstCoord(trip);
      if (!first) continue;
      if (haversineKm(first[1], first[0], jobLat, jobLon) <= MEDIUM_KM) {
        if (!departureTrip || trip.startTime > departureTrip.startTime) departureTrip = trip;
      }
    }

    if (arrivalTrip && departureTrip) {
      const durationMin = Math.round((new Date(departureTrip.startTime) - new Date(arrivalTrip.endTime)) / 60000);
      return { arrivalTs: arrivalTrip.endTime, departureTs: departureTrip.startTime, durationMin, closestDistKm, arrivalTrip, departureTrip };
    }
    return { durationMin: 0, closestDistKm };
  }

  const results = [];
  let matched = 0;

  for (const customer of completedToday) {
    const ss = customer.scheduledStatus || {};

    // Geocode job address — build full string so Census geocoder finds FL addresses
    let jobLat = ss.lat || customer.geocoded?.lat || null;
    let jobLon = ss.lon || customer.geocoded?.lng || null;
    if (!jobLat || !jobLon) {
      const addrParts = [customer.address, customer.city, 'FL', customer.zip].filter(Boolean);
      const fullAddr  = addrParts.join(', ');
      const geo = await geocodeAddress(fullAddr, env);
      if (geo) { jobLat = geo.lat; jobLon = geo.lon || geo.lng; }
    }
    if (!jobLat || !jobLon) {
      const addrTried = [customer.address, customer.city, 'FL', customer.zip].filter(Boolean).join(', ');
      results.push({ phone: customer.phone, name: fullName(customer), status: 'geocode_failed', address: customer.address, addrTried, hasCity: !!customer.city });
      continue;
    }

    // Scan ALL rigs — pick longest qualifying dwell within threshold.
    // Also track the globally closest approach for reporting on rejection.
    let bestRig = null, bestMatch = { durationMin: 0 };
    let globalClosestDistKm = Infinity, globalClosestRig = null, globalClosestArrival = null;
    const rigsWithinThreshold = [];

    for (const [rig, trips] of Object.entries(rigTripsMap)) {
      if (!trips.length) continue; // no GPS data for this rig today
      const m = proximityMatch(trips, jobLat, jobLon);
      // Track globally closest stop regardless of acceptance
      if (m.closestDistKm < globalClosestDistKm) {
        globalClosestDistKm = m.closestDistKm;
        globalClosestRig    = rig;
        globalClosestArrival = m.closestArrival || m.arrivalTs;
      }
      if (m.durationMin >= MIN_DUR_MIN) {
        rigsWithinThreshold.push(rig);
        if (m.durationMin > bestMatch.durationMin) { bestRig = rig; bestMatch = m; }
      }
    }

    // No mapped rigs had any GPS data at all
    const mappedRigsWithTrips = allRigEntries.filter(([rig]) => (rigTripsMap[rig] || []).length > 0);
    if (!bestRig && mappedRigsWithTrips.length === 0) {
      results.push({ phone: customer.phone, name: fullName(customer), status: 'no_data',
        note: 'No GPS data for any mapped rig on this date.' });
      continue;
    }

    // No rig matched within threshold — report closest stop for operator review
    if (!bestRig) {
      const closestDistFt = Math.round(globalClosestDistKm * 3280.84);
      const closestMi     = (globalClosestDistKm * 0.621371).toFixed(2);
      results.push({
        phone:    customer.phone,
        name:     fullName(customer),
        status:   'no_reliable_match',
        note:     `No reliable proximity match. Manual rig assignment needed. Best stop was ${closestDistFt} ft (${closestMi} mi) away — exceeds 500 ft threshold.`,
        closestRig:        globalClosestRig,
        closestDistFt,
        closestArrival:    globalClosestArrival,
      });
      continue;
    }

    // Determine confidence tier from actual GPS distance
    const geocodeDistKm = bestMatch.closestDistKm ?? haversineKm(
      jobLat, jobLon,
      tripLastCoord(bestMatch.arrivalTrip)?.[1],
      tripLastCoord(bestMatch.arrivalTrip)?.[0]);
    const geocodeDistFt = Math.round(geocodeDistKm * 3280.84);
    const isHigh   = geocodeDistKm <= HIGH_KM && rigsWithinThreshold.length === 1;
    const isMedium = geocodeDistKm <= MEDIUM_KM;
    const matchStatus  = isHigh ? 'matched_high' : 'matched_medium';
    const intentRig    = ss.rig || null;

    // GPS timing data — written for both high and medium
    const timingData = {
      actualArrival:      bestMatch.arrivalTs,
      actualDeparture:    bestMatch.departureTs,
      actualDuration:     bestMatch.durationMin,
      durationSource:     'bouncie_gps',
      durationConfidence: matchStatus,
      autoAttributed:     true,
    };

    // Rig attribution — ONLY for high-confidence matches
    if (isHigh) {
      timingData.actualRig  = bestRig;
      timingData.intentRig  = intentRig !== bestRig ? intentRig : undefined;
      timingData.rigsPresent = rigsWithinThreshold.length > 1 ? rigsWithinThreshold : undefined;
    }

    const jhEntry = (customer.jobHistory || []).slice().reverse().find(j => j.date === date);
    if (jhEntry) {
      Object.assign(jhEntry, timingData);
    } else {
      Object.assign(ss, timingData);
    }

    // Auto-migrate calendar card rig ONLY for high-confidence matches
    if (isHigh && bestRig && ss.rig !== bestRig) {
      ss.intentRig = intentRig;
      ss.rig       = bestRig;
    }

    // Update rolling duration stats
    customer.lastJobDuration = bestMatch.durationMin;
    const allDurs = (customer.jobHistory || []).filter(j => j.actualDuration).map(j => j.actualDuration);
    if (ss.actualDuration && !jhEntry) allDurs.push(ss.actualDuration);
    if (allDurs.length) {
      customer.avgJobDuration = Math.round(allDurs.reduce((a, b) => a + b, 0) / allDurs.length);
    }

    results.push({
      phone:        customer.phone,
      name:         fullName(customer),
      status:       matchStatus,
      actualRig:    isHigh ? bestRig : null,
      intentRig,
      rigChanged:   isHigh && intentRig && intentRig !== bestRig,
      duration:     bestMatch.durationMin,
      geocodeDistFt,
      arrival:      bestMatch.arrivalTs,
      departure:    bestMatch.departureTs,
      rigsPresent:  rigsWithinThreshold,
      ...(isMedium && !isHigh ? { note: `Medium confidence — GPS within 500 ft but > 250 ft. Operator confirmation recommended.` } : {}),
    });
    matched++;
  }

  if (matched > 0) await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));

  // ── Morning stop validation ────────────────────────────────────────────────
  const morningStops = {};
  for (const [rig, trips] of Object.entries(rigTripsMap)) {
    if (!trips.length) continue;
    morningStops[rig] = checkMorningStopsForRig(trips, MORNING_STOP_POIS, tripFirstCoord, tripLastCoord);
  }

  // Update running POI average stop durations
  for (const stops of Object.values(morningStops)) {
    for (const [poiKey, stop] of Object.entries(stops)) {
      if (!stop.found || stop.durationMin == null || stop.durationMin <= 0) continue;
      const statsKey = `bouncie:poi_stats:${poiKey}`;
      const stats = (await env.DATA.get(statsKey, 'json')) || { count: 0, totalMin: 0 };
      stats.count++;
      stats.totalMin += stop.durationMin;
      stats.avgMin = Math.round(stats.totalMin / stats.count);
      await env.DATA.put(statsKey, JSON.stringify(stats));
    }
  }

  // Persist for later retrieval (90-day TTL)
  await env.DATA.put(
    `bouncie:morning_stops:${date}`,
    JSON.stringify({ date, morningStops, updatedAt: new Date().toISOString() }),
    { expirationTtl: 90 * 86400 },
  );

  return { date, total: completedToday.length, matched, results, morningStops };
}

function fullName(c) { return `${c.firstName || ''} ${c.lastName || ''}`.trim(); }

// ── Review queue ──────────────────────────────────────────────────────────────

const REVIEW_QUEUE_CUTOFF = '2026-05-01'; // Only surface review requests for jobs on or after this date

async function handlePurgeReviewQueue(env, corsHeaders) {
  const db = await env.DATA.get(KV_KEYS.customers, 'json');
  if (!db?.customers) return jsonResponse({ removed: 0, kept: 0, message: 'No customers found' }, corsHeaders);
  let removed = 0, kept = 0;
  for (const c of db.customers) {
    if (!c.reviewQueue) continue;
    const jd = c.reviewQueue.jobDate || '';
    if (jd < REVIEW_QUEUE_CUTOFF) {
      delete c.reviewQueue;
      removed++;
    } else {
      kept++;
    }
  }
  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ removed, kept, cutoff: REVIEW_QUEUE_CUTOFF }, corsHeaders);
}

async function handleReviewQueue(env, corsHeaders) {
  const db        = await env.DATA.get(KV_KEYS.customers, 'json');
  const customers = (db?.customers || []).filter(c => c && !c.deleted);
  const now       = Date.now();
  const FOUR_DAYS = 4  * 86400000;
  const FOURTEEN  = 14 * 86400000;

  const queue = customers
    .filter(c => {
      if (c.reviewQueue?.status !== 'pending' && c.reviewQueue?.status !== 'window_closed') return false;
      // Safety net: never surface entries older than the cutoff
      const jd = c.reviewQueue?.jobDate || '';
      return jd >= REVIEW_QUEUE_CUTOFF;
    })
    .map(c => {
      const queuedMs = c.reviewQueue?.queuedAt ? new Date(c.reviewQueue.queuedAt).getTime() : 0;
      const ageMs    = now - queuedMs;
      const ageDays  = Math.floor(ageMs / 86400000);
      let status;
      if (c.reviewQueue?.status === 'window_closed' || ageMs > FOURTEEN) status = 'closed';
      else if (ageMs >= FOUR_DAYS) status = 'ready';
      else status = 'waiting';
      return {
        phone:     c.phone,
        firstName: c.firstName || '',
        lastName:  c.lastName  || '',
        jobDate:   c.reviewQueue?.jobDate || null,
        queuedAt:  c.reviewQueue?.queuedAt || null,
        ageDays,
        status,
      };
    })
    .sort((a, b) => (b.ageDays - a.ageDays));

  return jsonResponse({ queue, total: queue.length }, corsHeaders);
}
// ── Weather proxy ──────────────────────────────────────────────────────────────
const WX_KEY = '19f3873c2b89c318ad7981028a7bac13';
const WX_LAT = 26.1420;
const WX_LON = -80.2101;
async function handleWeather(env, corsHeaders) {
  try {
    const cached = await env.DATA.get('weather_cache', 'json');
    if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < 3 * 60 * 60 * 1000) {
      return jsonResponse(cached, corsHeaders);
    }
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${WX_LAT}&lon=${WX_LON}&appid=${WX_KEY}&units=imperial&cnt=40`;
    const res = await fetch(url);
    if (!res.ok) return jsonResponse({ error: 'weather unavailable' }, corsHeaders, 503);
    const data = await res.json();
    const byDate = {};
    for (const item of (data.list || [])) {
      const dateStr = item.dt_txt.split(' ')[0];
      if (!byDate[dateStr]) byDate[dateStr] = { rain: 0 };
      byDate[dateStr].rain = Math.max(byDate[dateStr].rain, Math.round((item.pop || 0) * 100));
    }
    const result = { daily: byDate, fetchedAt: Date.now() };
    await env.DATA.put('weather_cache', JSON.stringify(result), { expirationTtl: 10800 });
    return jsonResponse(result, corsHeaders);
  } catch(e) {
    return jsonResponse({ error: e.message }, corsHeaders, 500);
  }
}

// ── Stats backfill ─────────────────────────────────────────────────────────────
async function handleBackfillStats(env, corsHeaders) {
  const db = await env.DATA.get(KV_KEYS.customers, 'json');
  const customers = (db?.customers || []).filter(Boolean);
  let updated = 0, unchanged = 0;
  const sample = [];

  for (const c of customers) {
    const jh = (c.jobHistory || []).filter(j => j.date);
    if (!jh.length) { unchanged++; continue; }

    const newTotal = jh.length;
    const newSpend = Math.round(jh.reduce((s, j) => s + (j.amount || 0), 0));
    const newLast  = jh.reduce((max, j) => (!max || j.date > max) ? j.date : max, null);

    if (c.totalJobs !== newTotal || c.lifetimeSpend !== newSpend) {
      const before = { totalJobs: c.totalJobs, lifetimeSpend: c.lifetimeSpend };
      c.totalJobs    = newTotal;
      c.lifetimeSpend = newSpend;
      if (newLast && (!c.lastService || newLast > c.lastService)) c.lastService = newLast;
      updated++;
      if (sample.length < 8) {
        sample.push({
          name:   `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          phone:  c.phone,
          before,
          after:  { totalJobs: newTotal, lifetimeSpend: newSpend },
        });
      }
    } else {
      unchanged++;
    }
  }

  if (updated > 0) await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ updated, unchanged, total: customers.length, sample }, corsHeaders);
}
