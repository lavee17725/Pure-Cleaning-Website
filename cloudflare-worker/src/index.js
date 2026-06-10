// Cloudflare Worker for Pure Cleaning Pressure Washing
// Replaces JSONbin with KV-backed REST API

import {
  GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_REDIRECT_URI,
  KV_GOOGLE_STATE, KV_GOOGLE_FOLDER,
  getGoogleAccessToken, writeToGoogleDrive, runWeeklyExport, proactiveRefreshGoogleOAuthToken,
} from './exports.js';

const ALLOWED_ORIGINS = [
  'https://purecleaningpressurecleaning.com',
  'https://www.purecleaningpressurecleaning.com',
  'https://lavee17725.github.io',  // GitHub Pages backup
  'https://purecleaning-api.tylerfumero.workers.dev',  // workers.dev test URL (Phase 3 migration)
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
    { id: 'walkway',       name: 'Sidewalk',             count: 802,  pct: 43.3 },
  ],
  secondary: [
    { id: 'fence',         name: 'Fence',               count: 89,   pct: 4.8 },
    { id: 'rust_removal',  name: 'Rust Removal',        count: 39,   pct: 2.1 },
    { id: 'sealing',       name: 'Sealing',             count: 35,   pct: 1.9 },
    { id: 'gutters',       name: 'Gutters',             count: 31,   pct: 1.7 },
    { id: 'pool_deck',     name: 'Pool Deck',           count: 27,   pct: 1.5 },
    { id: 'pool_patio',   name: 'Pool Patio',          count: 0,    pct: 0.0 },
    { id: 'windows',       name: 'Windows',             count: 25,   pct: 1.4 },
    { id: 'paver_sand',        name: 'Pavers / Joint Sand', count: 25,  pct: 1.3 },
    { id: 'screen_enclosure',  name: 'Screen Enclosure',    count: 0,   pct: 0.0 },
    { id: 'prep_for_painting', name: 'Prep for Painting',   count: 0,   pct: 0.0 },
    { id: 'balcony',           name: 'Balcony',             count: 13,  pct: 0.7 },
  ],
  totalJobsAnalyzed: 1851,
  lastAnalyzed: '2026-05-02T00:00:00.000Z',
};

const DEFAULT_ADDONS_CONFIG = {
  addons: [
    { id: 'driveway',   name: 'Driveway Cleaning',            bundle: 150, standalone: 200, icon: '🛣️', description: '' },
    { id: 'patio',      name: 'Patio Cleaning',               bundle: 100, standalone: 150, icon: '🪨', description: '' },
    { id: 'walkways',   name: 'Sidewalks',                    bundle: 75,  standalone: 125, icon: '🚶', description: '' },
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
                        'reviews_data', 'review_states', 'service_frequency', 'addons_config', 'tasks_db', 'blocked_weeks'];

async function collectAllKVKeys(env) {
  const data = {};
  await Promise.all(BACKUP_KV_KEYS.map(async k => {
    data[k] = await env.DATA.get(k, 'json');
  }));
  return data;
}

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
    const data    = await collectAllKVKeys(env);
    const payload = JSON.stringify({ version: 2, timestamp: ts, keys: data });
    const key     = `backups/${date}/full-backup.json`;

    await env.BACKUPS.put(key, payload, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { date, sizeBytes: String(payload.length), version: '2' },
    });

    heartbeat.status    = 'success';
    heartbeat.sizeBytes = payload.length;
    heartbeat.backupKey = key;

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

// ── Automated snapshot helpers (every-6-hour cron) ───────────────────────

async function appendToAutoSnapshotLog(env, entry) {
  const log = (await env.DATA.get('auto_snapshot:log', 'json')) || [];
  log.unshift(entry);
  if (log.length > 50) log.splice(50);
  await env.DATA.put('auto_snapshot:log', JSON.stringify(log));
}

async function appendToSnapshotFailures(env, entry) {
  const failures = (await env.DATA.get('snapshot_failures', 'json')) || [];
  failures.unshift(entry);
  if (failures.length > 50) failures.splice(50);
  await env.DATA.put('snapshot_failures', JSON.stringify(failures));
}

async function applyAutoSnapshotRetention(env) {
  const listed = await env.BACKUPS.list({ prefix: 'auto_snapshots/' });
  const now    = Date.now();
  const deleted = [];
  for (const obj of (listed.objects || [])) {
    const ageDays = (now - new Date(obj.uploaded).getTime()) / 86400000;
    if (ageDays > 14) {
      try { await env.BACKUPS.delete(obj.key); deleted.push(obj.key); } catch {}
    }
  }
  return deleted;
}

async function runAutoSnapshot(env) {
  const ts      = new Date().toISOString();
  const startMs = Date.now();
  const entry   = { ranAt: ts, status: 'error', sizeBytes: 0, durationMs: 0 };

  if (!env.BACKUPS) {
    entry.error = 'R2 bucket not bound';
    entry.durationMs = Date.now() - startMs;
    await appendToAutoSnapshotLog(env, entry);
    await appendToSnapshotFailures(env, { ranAt: ts, error: entry.error, type: 'config_error' });
    return entry;
  }

  try {
    const data    = await collectAllKVKeys(env);
    const payload = JSON.stringify({ version: 2, timestamp: ts, type: 'auto', keys: data });
    const tsSlug  = ts.replace(/[:.]/g, '-').slice(0, 19);
    const key     = `auto_snapshots/auto_snapshot_${tsSlug}.json`;

    await env.BACKUPS.put(key, payload, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sizeBytes: String(payload.length), version: '2', type: 'auto' },
    });

    entry.status    = 'success';
    entry.sizeBytes = payload.length;
    entry.backupKey = key;

    const deleted = await applyAutoSnapshotRetention(env);
    entry.deletedOldSnapshots = deleted.length;
  } catch (e) {
    entry.error = e.message;
    console.error('Auto-snapshot cron error:', e.message);
    await appendToSnapshotFailures(env, { ranAt: ts, error: e.message, type: 'runtime_error' });
  } finally {
    entry.durationMs = Date.now() - startMs;
    await appendToAutoSnapshotLog(env, entry);
  }

  return entry;
}

// ── Twilio SMS ────────────────────────────────────────────────────────────────
// sendSms: never throws, returns {ok, error}. Logs failures via appendErrorLog
// (Law T1.11 — no silent-catch on the alert path). Lead/confirm save is always
// done before this runs — an SMS failure must never 500 the response.
async function sendSms(env, to, body) {
  const sid   = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from  = env.TWILIO_FROM;
  if (!sid || !token || !from || !to) {
    await appendErrorLog(env, {
      id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      source: 'worker', page: 'sendSms',
      errorType: 'SMS_CONFIG_MISSING',
      message: `sendSms called but config incomplete. sid=${!!sid} token=${!!token} from=${!!from} to=${!!to}`,
    }).catch(() => {});
    return { ok: false, error: 'config_missing' };
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + btoa(`${sid}:${token}`),
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '(unreadable)');
      await appendErrorLog(env, {
        id: crypto.randomUUID(), timestamp: new Date().toISOString(),
        source: 'worker', page: 'sendSms',
        errorType: 'SMS_SEND_FAILED',
        message: `Twilio ${res.status}: ${errText.slice(0, 300)}`,
      }).catch(() => {});
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    await appendErrorLog(env, {
      id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      source: 'worker', page: 'sendSms',
      errorType: 'SMS_FETCH_ERROR',
      message: (e.message || String(e)).slice(0, 300),
    }).catch(() => {});
    return { ok: false, error: e.message };
  }
}

// Text 1 body — new web lead
function _smsLeadBody(firstName, lastName, city, cd) {
  const svcs = Array.isArray(cd.services) ? cd.services.join(', ') : (cd.services || '');
  const ph10 = (cd.phone || '').replace(/\D/g, '').slice(-10);
  const phFmt = ph10.length === 10
    ? `(${ph10.slice(0,3)}) ${ph10.slice(3,6)}-${ph10.slice(6)}`
    : ph10;
  return [
    `🏠 New lead: ${firstName} ${lastName} — ${city}`,
    svcs               ? `Services: ${svcs}` : null,
    cd.timeframe       ? `Timeframe: ${cd.timeframe}` : null,
    cd.notes           ? `Note: ${cd.notes.slice(0, 120)}` : null,
    phFmt              ? `Call: ${phFmt}` : null,
    `View: purecleaningpressurecleaning.com/pure_cleaning_incoming.html`,
  ].filter(Boolean).join('\n');
}

// Text 2 body — quote confirmed by customer
function _smsConfirmedBody(name, city, amount, dateDisplay, services, phone) {
  const ph10 = (phone || '').replace(/\D/g, '').slice(-10);
  const phFmt = ph10.length === 10
    ? `(${ph10.slice(0,3)}) ${ph10.slice(3,6)}-${ph10.slice(6)}`
    : ph10;
  return [
    `✅ Quote confirmed: ${name}${city ? ' — ' + city : ''}`,
    amount      ? `Amount: $${Number(amount).toLocaleString()}` : null,
    dateDisplay ? `Date: ${dateDisplay}` : null,
    services    ? `Services: ${String(services).slice(0, 100)}` : null,
    phFmt       ? `Phone: ${phFmt}` : null,
  ].filter(Boolean).join('\n');
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
    if (event.cron === '0 4 * * 1') {
      // Monday 4 AM UTC — weekly Google Drive export
      ctx.waitUntil((async () => {
        try {
          const now     = new Date();
          // Export covers previous Mon–Sun (the week that just ended)
          const dow     = now.getDay() === 0 ? 7 : now.getDay(); // Mon=1 … Sun=7
          const lastMon = new Date(now); lastMon.setDate(now.getDate() - dow - 6);
          const lastSun = new Date(lastMon); lastSun.setDate(lastMon.getDate() + 6);
          await runWeeklyExport(env,
            lastMon.toISOString().slice(0, 10),
            lastSun.toISOString().slice(0, 10),
          );
        } catch(e) {
          console.error('weekly export cron error:', e.message);
          await env.DATA.put('google_export:last_run', JSON.stringify({
            ranAt: new Date().toISOString(), status: 'error', error: e.message,
          }));
        }
      })());
    } else if (event.cron === '0 4 * * *') {
      // Nightly backup — 4 AM UTC (keepalive runs same minute; Bouncie matcher at 4:30 AM)
      ctx.waitUntil(runNightlyBackup(env));
    } else if (event.cron === '0 */4 * * *') {
      // Bouncie auth keepalive — every 4 hours, keeps refresh token exercised
      ctx.waitUntil(bouncieKeepalive(env).catch(e => console.error('bouncie keepalive error:', e.message)));
    } else if (event.cron === '0 */6 * * *') {
      // Automated KV snapshot — every 6 hours, Tier 1 best practice
      ctx.waitUntil(runAutoSnapshot(env).catch(e => {
        console.error('auto-snapshot cron error:', e.message);
        return appendToSnapshotFailures(env, { ranAt: new Date().toISOString(), error: e.message, type: 'unhandled' }).catch(() => {});
      }));
    } else if (event.cron === '0 9 1 * *') {
      // Google OAuth proactive renewal — 9 AM UTC on the 1st of each month (DL-08)
      ctx.waitUntil(proactiveRefreshGoogleOAuthToken(env).then(r => {
        // @ts-ignore — union: success branch lacks errorCode/errorMessage; r.success guard above makes this safe
        if (!r.success) console.error('[Google OAuth cron] Renewal failed:', r.errorCode, r.errorMessage);
      }).catch(e => console.error('[Google OAuth cron] Unexpected error:', e.message)));
    } else if (event.cron === '30 4 * * *') {
      // Bouncie job duration matcher — 4:30 AM UTC (30 min after 4 AM keepalive so token is fresh)
      // Use previous calendar day (UTC-24h) so ET-scheduled jobs (2 PM-9 PM UTC = same UTC day)
      // are queried with the correct date. Without the offset the cron would use tomorrow's UTC
      // date and Bouncie would return no matching trips.
      const today = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      ctx.waitUntil((async () => {
        const startMs = Date.now();
        const heartbeat = { ranAt: new Date().toISOString(), date: today, status: 'error', jobsMatched: 0, jobsTotal: 0, matchRate: null, errors: [], anomalyReason: null, durationMs: 0 };
        try {
          const result = await bouncieJobDurationMatcher(today, env);
          const total   = result?.total   ?? 0;
          const matched = result?.matched ?? result?.jobsMatched ?? 0;
          heartbeat.jobsMatched = matched;
          heartbeat.jobsTotal   = total;
          heartbeat.matchRate   = total > 0 ? Math.round((matched / total) * 100) / 100 : null;

          // Detect Bouncie auth/connection failure returned as { error: ... } (not thrown).
          // Previously this silently fell through to anomaly_zero_jobs — now flagged explicitly.
          if (result?.error) {
            heartbeat.status      = 'error';
            heartbeat.anomalyReason = `Bouncie auth/connection failure on ${today}: ${result.error} — ${result.message || ''}`;
            heartbeat.errors.push(result.error);
          } else {
            // Honest status — T1.20: don't log success when no work was done.
            // Pure Cleaning doesn't work Sundays — zero jobs on Sunday is expected.
            const dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0=Sun
            if (total === 0 && dow !== 0) {
              heartbeat.status      = 'anomaly_zero_jobs';
              heartbeat.anomalyReason = `Zero completed jobs found in D1 for ${today} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]}). Check if jobs were completed without rigId, or if D1 query failed silently.`;
            } else if (total > 0 && matched / total < 0.5) {
              heartbeat.status      = 'partial_match_failure';
              heartbeat.anomalyReason = `Match rate ${Math.round(matched/total*100)}% below 50% threshold on ${today}. Bouncie token or GPS coverage issue likely.`;
            } else {
              heartbeat.status = 'success';
            }
          }

          // ── Late-completion retry: pick up jobs the original cron missed ────────────
          // Root cause of dead zone: original cron ran for scheduledDate=yesterday.
          // If a job was still 'scheduled' then (completed days later), the cron missed it.
          // The scheduledDate-based 7-day window didn't help — the job's scheduledDate
          // was already outside the window by the time it was marked complete.
          //
          // Fix: scan by COMPLETION recency (completedAt), not schedule recency.
          // Any job completed in the last 14 days with rigId + no actualDuration is retried
          // against ITS OWN scheduledDate (where its GPS trips live).
          //
          // The OR keeps the 7-day scheduledDate condition as a safety net for the rare
          // case where completedAt is NULL (historical jobs from older completion paths).
          //
          // Idempotent: actualDuration IS NULL filter prevents overwriting good matches.
          // Skipped on auth failure (heartbeat.status === 'error') — would also fail.
          if (env.DB && heartbeat.status !== 'error') {
            try {
              const sevenDaysAgo    = new Date(Date.now() -  7 * 86400000).toISOString().slice(0, 10);
              // Fix 2: widened from 14 → 30 days so a ~monthly token outage auto-recovers.
              // completedAt window covers late-completion jobs (scheduled long before completion).
              // scheduledDate window stays 7 days (catches same-week late-completion edge cases).
              const thirtyDaysAgo   = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
              const retryRows = await env.DB.prepare(
                `SELECT DISTINCT scheduledDate FROM Job
                 WHERE state = 'completed'
                   AND actualDuration IS NULL AND rigId IS NOT NULL
                   AND scheduledDate < ?
                   AND (
                     scheduledDate >= ?
                     OR (completedAt IS NOT NULL AND completedAt >= ?)
                   )
                 ORDER BY scheduledDate DESC`
              ).bind(today, sevenDaysAgo, thirtyDaysAgo).all();
              const retryDates = (retryRows.results || []).map(r => r.scheduledDate);
              if (retryDates.length) {
                console.log(`[Bouncie retry] ${retryDates.length} historical date(s) with unmatched jobs: ${retryDates.join(', ')}`);
                heartbeat.retryDates   = retryDates;
                heartbeat.retryMatched = 0;
                for (const retryDate of retryDates) {
                  try {
                    const r2 = await bouncieJobDurationMatcher(retryDate, env);
                    heartbeat.retryMatched += r2?.matched ?? 0;
                    console.log(`[Bouncie retry] ${retryDate}: ${r2?.matched ?? 0}/${r2?.total ?? 0} matched`);
                  } catch(e2) { console.error(`[Bouncie retry] Failed for ${retryDate}: ${e2.message}`); }
                }
              }
            } catch(e2) { console.error(`[Bouncie retry] D1 query failed: ${e2.message}`); }
          }
        } catch (e) {
          console.error('duration cron error:', e.message);
          heartbeat.errors.push(e.message);
        } finally {
          heartbeat.durationMs = Date.now() - startMs;
          await env.DATA.put('bouncie:last_cron_run', JSON.stringify(heartbeat));

          // ── Loud alert: write bouncie_cron_alert event to KV ──────────────────────
          // The calendar's checkAlerts() polls GET /events every 60s and shows a toast
          // for any event type in _ALERT_TYPES. The toast surfaces within 60s of cron fail
          // IF the calendar is open, or on next calendar open (fresh session defaults
          // to ?since=24h ago — so events from 4:30 AM are visible when Tyler opens at 8 AM).
          // Fires for: auth failure, anomaly_zero_jobs, partial_match_failure, thrown error.
          if (heartbeat.status !== 'success') {
            try {
              const eventsData = await env.DATA.get(KV_KEYS.events, 'json') || { events: [] };
              const alertMsg = heartbeat.anomalyReason
                || `Bouncie cron ${heartbeat.status} on ${heartbeat.date}: ${(heartbeat.errors || []).join('; ') || 'Unknown error'}`;
              eventsData.events = eventsData.events || [];
              eventsData.events.push({
                id:        `bouncie_alert_${heartbeat.date}_${Date.now()}`,
                eventType: 'bouncie_cron_alert',
                status:    heartbeat.status,
                message:   alertMsg,
                date:      heartbeat.date,
                createdAt: new Date().toISOString(),
              });
              // Cap at 200 events to prevent unbounded growth
              if (eventsData.events.length > 200) eventsData.events = eventsData.events.slice(-200);
              await env.DATA.put(KV_KEYS.events, JSON.stringify(eventsData));
            } catch(e2) { console.error('bouncie cron alert write failed:', e2.message); }
          }

          // ── Token pre-expiry warning (only when cron is healthy) ──────────────────
          // Bouncie refresh_tokens have a ~30-day hard expiry. bouncie:authorized_at is
          // set at OAuth callback time; daysSinceAuth >= 23 gives a 7-day warning window.
          //
          // Dedup: bouncie:last_token_warning_at prevents nightly repeat toasts.
          // Only writes a new warning if none was written in the last 48h.
          // Clears automatically when Tyler re-auths (authorized_at resets to now,
          // daysSinceAuth drops to ~0, condition is false; last_token_warning_at is also
          // deleted by the OAuth callback so the warning stops immediately).
          if (heartbeat.status === 'success') {
            try {
              const _authAt = await env.DATA.get('bouncie:authorized_at');
              if (_authAt) {
                const _daysSince = (Date.now() - new Date(_authAt).getTime()) / 86400000;
                if (_daysSince >= 23) {
                  const _lastWarn = await env.DATA.get('bouncie:last_token_warning_at');
                  const _warned48h = _lastWarn && (Date.now() - new Date(_lastWarn).getTime()) < 48 * 3600000;
                  if (!_warned48h) {
                    const _daysLeft = Math.round(30 - _daysSince);
                    const _warnMsg  =
                      `Bouncie authorization expires in ~${_daysLeft} day${_daysLeft !== 1 ? 's' : ''}. ` +
                      `Re-authorize now at https://purecleaningpressurecleaning.com/oauth/bouncie/start ` +
                      `to prevent GPS matching from stopping.`;
                    const _evtData = await env.DATA.get(KV_KEYS.events, 'json') || { events: [] };
                    _evtData.events = _evtData.events || [];
                    _evtData.events.push({
                      id:        `bouncie_token_warning_${Date.now()}`,
                      eventType: 'bouncie_cron_alert',
                      status:    'token_expiry_warning',
                      message:   _warnMsg,
                      date:      today,
                      createdAt: new Date().toISOString(),
                    });
                    if (_evtData.events.length > 200) _evtData.events = _evtData.events.slice(-200);
                    await Promise.all([
                      env.DATA.put(KV_KEYS.events, JSON.stringify(_evtData)),
                      env.DATA.put('bouncie:last_token_warning_at', new Date().toISOString()),
                    ]);
                    console.log(`[Bouncie token] Pre-expiry warning written: ${_daysLeft} days remaining`);
                  }
                }
              }
            } catch(e2) { console.error('bouncie token expiry check failed:', e2.message); }
          }
        }
      })());
      // TruckEvent persistence — runs alongside duration matcher at 4:30 AM UTC
      ctx.waitUntil(
        persistTruckEventsNightly(today, env)
          .catch(e => console.error('truckevent cron error:', e.message))
      );
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
      // ── Static assets: serve before auth gate ────────────────────────────────
      // API routes never have file extensions; static files always do (or are /).
      // binding = "ASSETS" in wrangler.toml makes env.ASSETS available here.
      if (env.ASSETS) {
        const pn = url.pathname;
        if (pn === '/' || pn === '') {
          // html_handling="none" means / doesn't auto-serve index.html — do it explicitly
          const r = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url).href, request));
          return addCacheHeaders(r, 'html');
        }
        // /admin/* routes may contain file-extension-like segments (e.g. /admin/photos/key/...satellite.jpg)
        // — never serve those from static assets; fall through to route handling below.
        if (!pn.startsWith('/admin/') && /\.[a-zA-Z0-9]+$/.test(pn)) {
          const r = await env.ASSETS.fetch(request);
          return addCacheHeaders(r, pn.endsWith('.html') ? 'html' : 'asset');
        }
      }

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
        (path === 'blocked-weeks'   && request.method === 'GET')  ||  // public — quote form date selection
        (path === 'reviews'         && request.method === 'GET')  ||  // public — review count badge (cosmetic)
        (path === 'events'          && request.method === 'POST') ||  // public — analytics from all pages; was working pre-auth
        (path === 'calendar/blocked-dates' && request.method === 'GET') ||  // public — stub in agreement.html; falls back gracefully
        (/^customer\/[^/]+$/.test(path) && request.method === 'GET') ||  // public — scoped: returns only that customer's record for agreement/receipt pages
        (/^invoice\/[^/]+$/.test(path)  && request.method === 'GET') ||  // public — scoped: returns ONE invoice's render data for pure_cleaning_invoice.html (rule 13)
        (path === 'dates/suggest'   && request.method === 'GET')  ||
        (path === 'service-frequency' && request.method === 'GET') ||
        (path === 'addons-config'   && request.method === 'GET')  ||
        path.startsWith('oauth/google/')  ||  // Google OAuth flow — browser redirect, no token yet
        path.startsWith('oauth/bouncie/') ||  // Bouncie OAuth flow — same reason, Bouncie can't send our token
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
        if (request.method === 'PUT') return await handleCustomersPut(request, env, corsHeaders);
        if (request.method === 'GET') return jsonResponse(await d1AllCustomersToKvShape(env), corsHeaders);
        return await handleResource(request, env, KV_KEYS.customers, corsHeaders);
      }

      if (path === 'incoming') {
        if (request.method === 'POST') {
          return await handleIncomingSubmit(request, env, corsHeaders);
        }
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

        // ── Day 2 dual-write: sync new/updated customer + scheduled job ──
        try {
          if (env.DB) {
            await _d1SyncNewCustomer(c, env, now);
            await _d1SyncScheduledJob(c, env, now);
          }
        } catch (e) { await _logD1Failure(env, 'quote_approve', e.message); }

        await appendErrorLog(env, {
          id: crypto.randomUUID(), timestamp: now,
          source: 'customer', page: `quote/${code}/approve`,
          errorType: 'QUOTE_APPROVED',
          message: `Quote ${code} approved · phone …${normPhone.slice(-4)} · $${approvedAmount || '?'} · ${selectedDate || 'no date'}`,
          url: request.url,
          userAgent: (request.headers.get('User-Agent') || '').slice(0, 300),
          ip: ip.slice(0, 50),
        });

        // Text 2: alert Tyler — customer approved their quote
        const _appName = `${c.firstName || ''} ${c.lastName || ''}`.trim() || name || '';
        const _appDate = selectedDate
          ? new Date(selectedDate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })
          : '';
        await sendSms(env, env.TYLER_CELL, _smsConfirmedBody(_appName, c.city || body.city || '', approvedAmount, _appDate, svcStr, normPhone));

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

      // ── GET /customer/{phone} — scoped public endpoint for customer-facing pages ──
      // Returns only that one customer's record. Used by agreement.html + receipt.html
      // to avoid fetching the full /customers DB. Rate limited per IP.
      if (/^customer\/[^/]+$/.test(path) && request.method === 'GET') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rk = `rate:custview:${ip}`;
        const n  = (await env.DATA.get(rk, 'json')) || 0;
        if (n >= 30) return jsonResponse({ error: 'rate_limited' }, corsHeaders, 429);
        await env.DATA.put(rk, JSON.stringify(n + 1), { expirationTtl: 60 });

        const rawPhone = path.slice('customer/'.length);
        const customer = await d1CustomerToKvShape(rawPhone, env);
        if (!customer) return jsonResponse({ error: 'not found' }, corsHeaders, 404);
        return jsonResponse({ customer }, corsHeaders);
      }

      // ── GET /invoice/{invoiceId} — scoped public for pure_cleaning_invoice.html ──
      // Returns ONLY that invoice's render data — never any other customer info.
      // Rate limited per IP (30/min). Tracks viewedAt on first call.
      if (/^invoice\/[^/]+$/.test(path) && request.method === 'GET') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rk = `rate:invview:${ip}`;
        const n  = (await env.DATA.get(rk, 'json')) || 0;
        if (n >= 30) return jsonResponse({ error: 'rate_limited' }, corsHeaders, 429);
        await env.DATA.put(rk, JSON.stringify(n + 1), { expirationTtl: 60 });

        const invoiceId = path.slice('invoice/'.length);
        return await handleGetInvoicePublic(env, invoiceId, corsHeaders);
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

      if (path === 'admin/bouncie-keepalive-status' && request.method === 'GET') {
        const [ks, authorizedAt] = await Promise.all([
          env.DATA.get('bouncie:keepalive_status', 'json'),
          env.DATA.get('bouncie:authorized_at'),
        ]);
        return jsonResponse({ ...(ks || { ts: null, status: 'never_run' }), authorizedAt: authorizedAt || null }, corsHeaders);
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

      if (path === 'admin/review-states' && request.method === 'GET')
        return jsonResponse(await env.DATA.get('review_states', 'json') || {}, corsHeaders);

      if (path === 'admin/reconcile-kv-d1' && request.method === 'GET')
        return await handleReconcileKvD1(env, corsHeaders);

      if (path === 'admin/multi-property-audit' && request.method === 'GET')
        return await handleMultiPropertyAudit(env, corsHeaders);

      // Part C: JOB_PROPERTY_AMBIGUOUS — jobs where workSiteAddress ≠ bound Property.streetAddress
      // Scoped to residential customers; partner_referral mismatch is intentional by design.
      if (path === 'admin/diagnostics/property-audit' && request.method === 'GET')
        return await handlePropertyAudit(env, corsHeaders);

      if (path === 'admin/migrate-review-states' && request.method === 'POST')
        return await handleMigrateReviewStates(env, corsHeaders);

      if (path === 'admin/d1-sync-failures' && request.method === 'GET')
        return jsonResponse(await env.DATA.get('d1_sync_failures', 'json') || [], corsHeaders);

      // ── Calendar jobs: D1-native read + mutation (Phase 2A) ──────────────────
      if (path === 'admin/calendar-jobs' && request.method === 'GET')
        return await handleCalendarJobs(request, env, corsHeaders);

      if (path.startsWith('admin/job/') && path.endsWith('/days') && request.method === 'GET') {
        const jobId = path.slice('admin/job/'.length, -'/days'.length);
        return await handleGetJobDays(request, env, jobId, corsHeaders);
      }

      // GET /admin/monthly-breakdown?month=YYYY-MM
      // One row per job-group (parents + standalone). Excludes rig_segment children
      // and day-children (parent represents the group). Group amount computed in SQL
      // because parent.amount is the Day-1 slice for multi-day jobs, not the total.
      // Date filter uses business date: completedAt converted to ET for completed jobs,
      // scheduledDate as-is for scheduled. Auth: gated by isPublic check above (admin).
      if (path === 'admin/monthly-breakdown' && request.method === 'GET') {
        return await handleMonthlyBreakdown(request, env, corsHeaders);
      }

      // POST /admin/invoice/from-job  { jobId } → idempotent create+return Invoice + LineItems.
      // Creates one Invoice row (or returns existing if jobIds already references the jobId),
      // line-items per day for multi-day, atomic counter via DocumentCounter ON CONFLICT UPDATE.
      if (path === 'admin/invoice/from-job' && request.method === 'POST') {
        return await handleInvoiceFromJob(request, env, corsHeaders);
      }

      if (path.startsWith('admin/job/') && path.endsWith('/complete-group') && request.method === 'POST') {
        const jobId = path.slice('admin/job/'.length, -'/complete-group'.length);
        return await handleCompleteJobGroup(request, env, jobId, corsHeaders);
      }

      // POST /admin/job/:jobId/crew-assignment — snapshot per-job crew into JobCrewAssignment
      // Called at completion with the finalized crew (derived or manual).
      // INSERT OR REPLACE on (jobId, crewMemberId) PK makes it idempotent — re-completion safe.
      // Locked historical record: written once, never mutated by later roster edits (T1.22).
      if (path.startsWith('admin/job/') && path.endsWith('/crew-assignment') && request.method === 'POST') {
        if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
        const jcaJobId = path.slice('admin/job/'.length, -'/crew-assignment'.length);
        const jcaBody  = await request.json().catch(() => ({}));
        const jcaCrew  = Array.isArray(jcaBody.crew) ? jcaBody.crew : [];
        const jcaWarns = [];

        // Resolve shortIds → UUIDs in one batch (same bridge as Phase 2)
        const jcaSids = [...new Set(jcaCrew.map(c => c.shortId).filter(Boolean))];
        let jcaUuidMap = {};
        if (jcaSids.length > 0) {
          const jcaPlaceholders = jcaSids.map(() => '?').join(',');
          const { results: jcaCmRows } = await env.DB.prepare(
            `SELECT crewMemberId, shortId FROM CrewMember WHERE shortId IN (${jcaPlaceholders}) AND active = 1`
          ).bind(...jcaSids).all();
          for (const r of (jcaCmRows || [])) jcaUuidMap[r.shortId] = r.crewMemberId;
        }

        const jcaInsert = [];
        for (const entry of jcaCrew) {
          const uuid = jcaUuidMap[entry.shortId];
          if (!uuid) { jcaWarns.push(`shortId '${entry.shortId}' not resolved — skipped (T1.11)`); continue; }
          jcaInsert.push({ crewMemberId: uuid, role: entry.role === 'driver' ? 'driver' : 'crew' });
        }

        if (jcaInsert.length > 0) {
          const jcaStmts = jcaInsert.map(r =>
            env.DB.prepare(
              `INSERT OR REPLACE INTO JobCrewAssignment (jobId, crewMemberId, role) VALUES (?,?,?)`
            ).bind(jcaJobId, r.crewMemberId, r.role)
          );
          await env.DB.batch(jcaStmts);
        }

        return jsonResponse({ success: true, jobId: jcaJobId, inserted: jcaInsert.length, warnings: jcaWarns }, corsHeaders);
      }

      if (path.startsWith('admin/job/') && request.method === 'PATCH') {
        const jobId = path.slice('admin/job/'.length);
        return await handlePatchJob(request, env, jobId, corsHeaders);
      }

      // ── Law T1.18: CREATE path for new scheduled jobs — dual-writes KV+D1 ──────
      // Called by submitScheduleNow() after saveDb() (KV write) completes.
      // Previously missing: scheduleNow only wrote KV; calendar reads D1-only.
      if (path === 'admin/scheduled-job' && request.method === 'POST')
        return await handleCreateScheduledJob(request, env, corsHeaders);

      if (path === 'admin/job/split' && request.method === 'POST')
        return await handleSplitJob(request, env, corsHeaders);

      if (path === 'admin/partner' && request.method === 'POST')
        return await handleCreatePartner(request, env, corsHeaders);

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
        if (action === 'never-ask-review' && request.method === 'POST')
          return await handleNeverAskReview(env, cPhone, corsHeaders, true);
        if (action === 'clear-never-ask-review' && request.method === 'POST')
          return await handleNeverAskReview(env, cPhone, corsHeaders, false);
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

      // ════════════════════════════════════════════════════════════════════════
      // ── R2 Photo admin (Phase 1 foundation) ─────────────────────────────────
      //
      //  POST /admin/photos/upload           — write blob to env.PHOTOS R2
      //  GET  /admin/photos/job/:jobId       — list keys from Job.photoKeys
      //  GET  /admin/photos/key/*            — stream any R2 key
      //
      // All three are auth-gated (inside the verifySession block above).
      // The existing KV photo routes (POST /photos etc.) are unchanged —
      // they continue to serve the completion-modal photos until Phase 4 migration.
      // ────────────────────────────────────────────────────────────────────────

      if (path === 'admin/photos/upload' && request.method === 'POST') {
        return await handlePhotoR2Upload(request, env, url, corsHeaders);
      }
      if (path.startsWith('admin/photos/job/') && request.method === 'GET') {
        const r2JobId = path.slice('admin/photos/job/'.length);
        return await handlePhotoR2GetJob(r2JobId, env, corsHeaders);
      }
      if (path.startsWith('admin/photos/key/') && request.method === 'GET') {
        const r2Key = path.slice('admin/photos/key/'.length);
        return await handlePhotoR2GetKey(r2Key, env, corsHeaders);
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

      // ── Google Drive OAuth ────────────────────────────────────────────────────
      if (path === 'oauth/google/start' && request.method === 'GET') {
        return await handleGoogleStart(env);
      }
      if (path === 'oauth/google/callback' && request.method === 'GET') {
        return await handleGoogleCallback(request, env, url);
      }
      if (path === 'admin/google-drive/set-folder' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        if (!body.folderId) return jsonResponse({ error: 'folderId required' }, corsHeaders, 400);
        await env.DATA.put(KV_GOOGLE_FOLDER, body.folderId);
        return jsonResponse({ success: true, folderId: body.folderId }, corsHeaders);
      }
      if (path === 'admin/google-drive/status' && request.method === 'GET') {
        const [refresh, folder, lastRun, refreshedAt, lastErr] = await Promise.all([
          env.DATA.get('google_oauth:refresh_token'),
          env.DATA.get(KV_GOOGLE_FOLDER),
          env.DATA.get('google_export:last_run', 'json'),
          env.DATA.get('google_oauth:token_refreshed_at'),
          env.DATA.get('google_oauth:last_error', 'json'),
        ]);
        const daysSinceRefresh = refreshedAt
          ? Math.round((Date.now() - new Date(refreshedAt).getTime()) / 86400000)
          : null;
        // null = never proactively refreshed → degraded (not healthy — we don't know token age)
        const oauthStatus = lastErr ? 'failed'
          : (daysSinceRefresh === null || daysSinceRefresh > 35) ? 'degraded'
          : 'healthy';
        return jsonResponse({
          authorized:  !!refresh,
          folderId:    folder || null,
          lastExport:  lastRun || null,
          google_oauth: {
            status:          oauthStatus,
            lastRefreshedAt: refreshedAt || null,
            daysSinceRefresh,
            lastError:       lastErr || null,
          },
        }, corsHeaders);
      }

      // ── Google OAuth: manual proactive refresh trigger (DL-08) ─────────────────
      // Useful for post-re-auth validation and manual recovery without waiting for cron.
      if (path === 'admin/google-oauth/refresh' && request.method === 'POST') {
        const result = await proactiveRefreshGoogleOAuthToken(env);
        return jsonResponse(result, corsHeaders, result.success ? 200 : 500);
      }

      // ── Weekly export: manual trigger ─────────────────────────────────────────
      if (path === 'admin/export-weekly' && request.method === 'POST') {
        const today    = new Date();
        // Default to previous Mon–Sun if no dates provided
        const dayOfWk  = today.getDay() === 0 ? 7 : today.getDay(); // Mon=1 … Sun=7
        const lastMon  = new Date(today); lastMon.setDate(today.getDate() - dayOfWk - 6);
        const lastSun  = new Date(lastMon); lastSun.setDate(lastMon.getDate() + 6);
        const from = url.searchParams.get('from') || lastMon.toISOString().slice(0, 10);
        const to   = url.searchParams.get('to')   || lastSun.toISOString().slice(0, 10);
        try {
          const result = await runWeeklyExport(env, from, to);
          return jsonResponse(result, corsHeaders);
        } catch(e) {
          return jsonResponse({ error: e.message }, corsHeaders, 500);
        }
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

      // ── POST /admin/bouncie/probe-coords — read-only diagnostic ──
      // Runs proximityMatch against Bouncie trips for given lat/lon over a date list.
      // NO D1/KV writes — purely returns what the matcher WOULD see. Used for diagnosing
      // mismatches like "Ivan got no_data but Reza matched same day same rig".
      // Body: { lat, lon, dates: ['YYYY-MM-DD', ...] }
      if (path === 'admin/bouncie/probe-coords' && request.method === 'POST') {
        return await handleBouncieProbeCoords(request, env, corsHeaders);
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
            // D1 Property dual-write: update lat/lng/geocodeSource
            try {
              const ph10 = norm(phone);
              await env.DB.prepare(
                `UPDATE Property SET latitude=?, longitude=?, geocodeSource=?, modifiedAt=? WHERE propertyId IN (SELECT propertyId FROM PersonProperty WHERE personId=?)`
              ).bind(geo.lat, geo.lng, geo.source||null, new Date().toISOString(), 'person_1'+ph10).run();
            } catch(e) { await _logD1Failure(env, 'geocode_property_update', e.message); }
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
          const rigMapping = await env.DATA.get('bouncie:rig_mapping', 'json') || {};
          const targets = imei
            ? [{ rig: 'custom', imei }]
            : Object.entries(rigMapping).filter(([,re]) => re?.imei).map(([rig, re]) => ({ rig, imei: re.imei }));
          const startsAfter = `${date}T00:00:00.000Z`;
          const endsBefore  = `${date}T23:59:59.000Z`;
          const out = {};
          for (const t of targets) {
            const res = await bouncieFetchWithRetry(
              `${BOUNCIE_API_BASE}/trips?imei=${t.imei}&gpsFormat=geojson&startsAfter=${encodeURIComponent(startsAfter)}&endsBefore=${encodeURIComponent(endsBefore)}`,
              env
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
        const entry = {
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
        };
        await appendErrorLog(env, entry);

        // ── Spike detection: 5-min sliding window ────────────────────────────
        const nowMs   = Date.now();
        const buckets = [0, 1, 2].map(i => {
          const ts   = nowMs - i * 300000;
          const date = new Date(ts).toISOString().split('T')[0];
          return `errors:count:${date}:${Math.floor(ts / 300000)}`;
        });
        const curBucketKey = buckets[0];
        const curBucketVal = (await env.DATA.get(curBucketKey, 'json')) || 0;
        await env.DATA.put(curBucketKey, JSON.stringify(curBucketVal + 1), { expirationTtl: 1800 });
        const windowCounts = await Promise.all(buckets.map(k => env.DATA.get(k, 'json').then(v => v || 0)));
        const windowTotal  = windowCounts.reduce((a, b) => a + b, 0);
        if (windowTotal >= 10) {
          await env.DATA.put('alerts:active', JSON.stringify({
            spikeAt:  entry.timestamp,
            count:    windowTotal,
            sample:   { source: entry.source, page: entry.page, message: entry.message },
          }), { expirationTtl: 1800 });
        }

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

      // ── Alert spike flag: read (protected) ────────────────────────────────────
      if (path === 'admin/alerts-active' && request.method === 'GET') {
        const alert = await env.DATA.get('alerts:active', 'json');
        return jsonResponse({ active: !!alert, alert: alert || null }, corsHeaders);
      }

      // ── Worker hours: date range summary (protected) ──────────────────────────
      if (path === 'admin/worker-hours' && request.method === 'GET') {
        const today   = new Date().toISOString().slice(0, 10);
        const weekDay = new Date().getDay(); // 0=Sun
        const daysToMon = weekDay === 0 ? 6 : weekDay - 1;
        const monDate = new Date(); monDate.setDate(monDate.getDate() - daysToMon);
        const sunDate = new Date(monDate); sunDate.setDate(monDate.getDate() + 6);
        const from = url.searchParams.get('from') || monDate.toISOString().slice(0, 10);
        const to   = url.searchParams.get('to')   || sunDate.toISOString().slice(0, 10);
        const db   = await env.DATA.get(KV_KEYS.customers, 'json');
        const customers = (db?.customers || []).filter(c => !c.deleted);
        const workerMap = computeWorkerHours(customers, from, to);
        const workers = Object.entries(workerMap)
          .map(([name, d]) => ({ name, hours: d.hours, jobCount: d.jobCount, avgHoursPerJob: d.avgHoursPerJob, jobs: d.jobs }))
          .sort((a, b) => b.hours - a.hours);
        const totalJobs = [...new Set(workers.flatMap(w => w.jobs.map(j => j.phone + j.date)))].length;
        return jsonResponse({ workers, periodStart: from, periodEnd: to, totalJobs }, corsHeaders);
      }

      // ── Day route view (protected) ───────────────────────────────────────────
      if (path === 'admin/day-route' && request.method === 'GET') {
        return await handleDayRoute(request, env, corsHeaders, url);
      }
      if (path === 'admin/day-route/averages' && request.method === 'GET') {
        return await handleDayRouteAverages(request, env, corsHeaders, url);
      }

      // ── TruckEvent backfill (protected) ──────────────────────────────────────
      if (path === 'admin/truckevent-backfill' && request.method === 'POST') {
        return await handleTruckEventBackfill(request, env, corsHeaders);
      }

      // ── Create property + PersonProperty link (protected) ───────────────────────
      if (path === 'admin/property' && request.method === 'POST') {
        return await handleCreateProperty(request, env, corsHeaders);
      }

      // ── POST /admin/places/resolve — placeId → structured address ──
      // Body: { placeId }
      // Returns: { success, streetAddress, city, state, zip, latitude, longitude, formattedAddress }
      // Used by:
      //   (1) Partner-flow entry guard (new_customer.html) when user picks a Google suggestion
      //       and submits without a typed street — resolves the placeId server-side so the
      //       worksite Property can be created instead of falling back to billing anchor.
      //   (2) One-shot repairs of legacy partner jobs that have workSitePlaceId but no street.
      if (path === 'admin/places/resolve' && request.method === 'POST') {
        return await handlePlacesResolve(request, env, corsHeaders);
      }

      if (path === 'admin/person-property' && request.method === 'PATCH') {
        return await handlePatchPersonProperty(request, env, corsHeaders);
      }

      if (path === 'admin/address-gate' && request.method === 'POST') {
        return await handleAddressGate(request, env, corsHeaders);
      }

      if (path === 'admin/retype-customer' && request.method === 'POST') {
        return await handleRetypeCustomer(request, env, corsHeaders);
      }

      // ── PATCH /admin/person/{personId} — update contact fields + refresh KV ──
      if (path.startsWith('admin/person/') && request.method === 'PATCH') {
        const patchPersonId = path.slice('admin/person/'.length);
        return await handlePatchPerson(request, patchPersonId, env, corsHeaders);
      }

      // ── Proposal endpoints (Commercial Pillar) ───────────────────────────────
      if (path === 'admin/proposal' && request.method === 'POST') {
        return await handleCreateProposal(request, env, corsHeaders);
      }
      if (path.startsWith('admin/proposal/') && request.method === 'GET') {
        const proposalId = path.slice('admin/proposal/'.length);
        return await handleGetProposal(proposalId, env, corsHeaders);
      }
      if (path.startsWith('admin/proposal/') && request.method === 'PATCH') {
        const proposalId = path.slice('admin/proposal/'.length);
        return await handlePatchProposal(request, proposalId, env, corsHeaders);
      }

      // ── PATCH /admin/property-images — set satelliteImageKey/frontImageKey on Property ──
      // Called from new_customer.html after scheduleJobWithDualWrite() confirms the
      // Property row exists. Non-blocking — scheduling is not gated on this write.
      if (path === 'admin/property-images' && request.method === 'PATCH') {
        return await handlePatchPropertyImages(request, env, corsHeaders);
      }

      // ── Google Places API proxy (protected) ──────────────────────────────────
      // Law T1.14: API key stays server-side. KV caches details (30d TTL).
      if (path === 'admin/places/autocomplete' && request.method === 'GET') {
        return await handlePlacesAutocomplete(request, env, corsHeaders, url);
      }
      if (path === 'admin/places/details' && request.method === 'GET') {
        return await handlePlacesDetails(request, env, corsHeaders, url);
      }

      // ── Property dedup + historical canonicalization (protected) ─────────────
      if (path === 'admin/properties/canonicalize-all' && request.method === 'POST') {
        return await handleCanonicalizeAll(request, env, corsHeaders, url);
      }
      if (path === 'admin/property-duplicates' && request.method === 'GET') {
        return await handlePropertyDuplicates(env, corsHeaders);
      }

      // ── POST /admin/property/backfill-access — KV→D1 gateCode+accessNotes backfill ──
      if (path === 'admin/property/backfill-access' && request.method === 'POST') {
        return await handleBackfillPropertyAccess(request, env, corsHeaders);
      }

      // ── Person duplicate review endpoints ────────────────────────────────────
      if (path === 'admin/person-merge-candidates' && request.method === 'GET') {
        return await handlePersonMergeCandidates(env, corsHeaders);
      }
      if (path === 'admin/person-merge' && request.method === 'POST') {
        return await handlePersonMerge(request, env, corsHeaders);
      }
      if (path === 'admin/person-merge-skip' && request.method === 'POST') {
        return await handlePersonMergeSkip(request, env, corsHeaders);
      }

      // ── Google Directions API proxy (protected) ───────────────────────────────
      if (path === 'admin/drive-time' && request.method === 'GET') {
        return await handleDriveTime(request, env, corsHeaders, url);
      }
      if (path === 'admin/drive-time/stats' && request.method === 'GET') {
        return await handleDriveTimeStats(env, corsHeaders);
      }

      if (path === 'admin/rig-day-summary' && request.method === 'GET') {
        return await handleRigDaySummary(request, env, corsHeaders, url);
      }

      // ── Insights: D1 revenue/job aggregates (protected) ──────────────────────
      if (path === 'admin/insights' && request.method === 'GET') {
        const today       = new Date().toISOString().slice(0, 10);
        const currentYear = today.slice(0, 4);
        const start       = url.searchParams.get('start')     || '2010-01-01';
        const end         = url.searchParams.get('end')       || today;
        const prevStart   = url.searchParams.get('prevStart') || null;
        const prevEnd     = url.searchParams.get('prevEnd')   || null;
        const source      = url.searchParams.get('source')    || 'all';
        const srcFilter   = source === 'live' ? " AND source NOT LIKE 'csv_backfill%'" : '';

        const ytdStart = `${currentYear}-01-01`;
        const completedSQL = `SELECT COUNT(*) AS jobCount, COALESCE(SUM(amount),0) AS revenue FROM Job WHERE state='completed' AND scheduledDate BETWEEN ? AND ? AND amount > 0${srcFilter}`;
        const pipelineSQL  = `SELECT COUNT(*) AS jobCount, COALESCE(SUM(amount),0) AS revenue FROM Job WHERE state='scheduled' AND scheduledDate BETWEEN ? AND ?${srcFilter}`;

        const [completed, pipeline, ytd, prevCompleted,
               revenueByMonth, revenueByCity, outstanding, reactivation,
               topCustomers, rigProductivity, avgTicketTrend] = await Promise.all([
          env.DB.prepare(completedSQL).bind(start, end).first(),
          env.DB.prepare(pipelineSQL).bind(start, end).first(),
          env.DB.prepare(completedSQL).bind(ytdStart, today).first(),
          prevStart && prevEnd ? env.DB.prepare(completedSQL).bind(prevStart, prevEnd).first() : Promise.resolve(null),
          // Panel 1 — Revenue by month (last 12)
          env.DB.prepare(
            `SELECT SUBSTR(scheduledDate,1,7) AS month, COUNT(*) AS jobs, CAST(SUM(amount) AS INTEGER) AS revenue ` +
            `FROM Job WHERE state='completed' AND amount > 0 AND scheduledDate >= DATE('now','-12 months')${srcFilter} ` +
            `GROUP BY month ORDER BY month`
          ).all().then(r => r.results || []),
          // Panel 2 — Revenue by city
          env.DB.prepare(
            `SELECT p.city, COUNT(*) AS jobs, CAST(SUM(j.amount) AS INTEGER) AS revenue, CAST(AVG(j.amount) AS INTEGER) AS avgTicket ` +
            `FROM Job j ` +
            `JOIN PersonProperty pp ON j.payerId = pp.personId AND pp.primaryContact=1 ` +
            `JOIN Property p ON pp.propertyId = p.propertyId ` +
            `WHERE j.state='completed' AND j.amount > 0${srcFilter} ` +
            `GROUP BY p.city ORDER BY revenue DESC LIMIT 15`
          ).all().then(r => r.results || []),
          // Panel 3 — Outstanding unpaid
          env.DB.prepare(
            `SELECT COUNT(*) AS jobCount, CAST(COALESCE(SUM(amount),0) AS INTEGER) AS totalUnpaid ` +
            `FROM Job WHERE state='completed' AND paymentStatus='unpaid' AND amount > 0`
          ).first(),
          // Panel 4 — Reactivation pool (6–24 months dormant)
          env.DB.prepare(
            `SELECT COUNT(*) AS count, CAST(COALESCE(SUM(maxAmount),0) AS INTEGER) AS poolRevenue ` +
            `FROM (SELECT payerId, MAX(scheduledDate) AS lastService, MAX(amount) AS maxAmount ` +
            `FROM Job WHERE state='completed' AND amount > 0${srcFilter} ` +
            `GROUP BY payerId ` +
            `HAVING lastService <= DATE('now','-180 days') AND lastService >= DATE('now','-730 days'))`
          ).first(),
          // Panel 5 — Top 10 customers by lifetime spend
          env.DB.prepare(
            `SELECT p.firstName||' '||p.lastName AS name, p.primaryPhone, ` +
            `COUNT(*) AS jobs, CAST(SUM(j.amount) AS INTEGER) AS lifetime, MAX(j.scheduledDate) AS lastService ` +
            `FROM Job j JOIN Person p ON j.payerId = p.personId ` +
            `WHERE j.state='completed' AND j.amount > 0${srcFilter} ` +
            `GROUP BY j.payerId ORDER BY lifetime DESC LIMIT 10`
          ).all().then(r => r.results || []),
          // Panel 6 — Rig productivity last 6 months
          env.DB.prepare(
            `SELECT SUBSTR(scheduledDate,1,7) AS month, rigId, COUNT(*) AS jobs, CAST(SUM(amount) AS INTEGER) AS revenue ` +
            `FROM Job WHERE state='completed' AND rigId IS NOT NULL AND amount > 0 ` +
            `AND scheduledDate >= DATE('now','-6 months')${srcFilter} ` +
            `GROUP BY month, rigId ORDER BY month, rigId`
          ).all().then(r => r.results || []),
          // Panel 7 — Avg ticket trend last 12 months
          env.DB.prepare(
            `SELECT SUBSTR(scheduledDate,1,7) AS month, COUNT(*) AS jobs, ` +
            `CAST(AVG(amount) AS INTEGER) AS avgTicket, CAST(MIN(amount) AS INTEGER) AS minTicket, CAST(MAX(amount) AS INTEGER) AS maxTicket ` +
            `FROM Job WHERE state='completed' AND amount > 0 AND scheduledDate >= DATE('now','-12 months')${srcFilter} ` +
            `GROUP BY month ORDER BY month`
          ).all().then(r => r.results || []),
        ]);

        return jsonResponse({
          completed:       { jobCount: completed?.jobCount  ?? 0, revenue: completed?.revenue ?? 0 },
          pipeline:        { jobCount: pipeline?.jobCount   ?? 0, revenue: pipeline?.revenue  ?? 0 },
          ytd:             { jobCount: ytd?.jobCount        ?? 0, revenue: ytd?.revenue       ?? 0 },
          prevCompleted:   prevStart && prevEnd ? { jobCount: prevCompleted?.jobCount ?? 0, revenue: prevCompleted?.revenue ?? 0 } : null,
          revenueByMonth,
          revenueByCity,
          outstanding:     { jobCount: outstanding?.jobCount ?? 0, totalUnpaid: outstanding?.totalUnpaid ?? 0 },
          reactivation:    { count: reactivation?.count ?? 0, poolRevenue: reactivation?.poolRevenue ?? 0 },
          topCustomers,
          rigProductivity,
          avgTicketTrend,
        }, corsHeaders);
      }

      // ── CrewMember CRUD (protected) ──────────────────────────────────────────
      {
        const normalizeE164 = (raw) => {
          if (!raw) return null;
          if (raw.startsWith('+')) return raw.replace(/\s/g, '');
          const digits = raw.replace(/\D/g, '');
          if (digits.length === 10) return `+1${digits}`;
          if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
          return null;
        };

        // POST /admin/crew — create
        if (path === 'admin/crew' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          if (!body.name || !String(body.name).trim()) return jsonResponse({ error: 'name is required' }, corsHeaders, 400);
          if (!body.phone || !String(body.phone).trim()) return jsonResponse({ error: 'phone is required' }, corsHeaders, 400);
          const phone = normalizeE164(String(body.phone).trim());
          if (!phone) return jsonResponse({ error: 'phone must be a US number' }, corsHeaders, 400);
          const crewMemberId = crypto.randomUUID();
          const now = new Date().toISOString();
          const record = {
            crewMemberId,
            name:       String(body.name).trim(),
            active:     1,
            role:       body.role       || 'field_worker',
            phone,
            email:      body.email      || null,
            hiredAt:    body.hiredAt    || null,
            notes:      body.notes      || null,
            createdAt:  now,
            modifiedAt: now,
          };
          await env.DB.prepare(
            `INSERT INTO CrewMember (crewMemberId,name,active,role,phone,email,hiredAt,notes,createdAt,modifiedAt)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          ).bind(record.crewMemberId, record.name, record.active, record.role, record.phone,
                 record.email, record.hiredAt, record.notes, record.createdAt, record.modifiedAt).run();
          return jsonResponse(record, corsHeaders, 201);
        }

        // GET /admin/crew — list
        if (path === 'admin/crew' && request.method === 'GET') {
          const activeOnly = url.searchParams.get('activeOnly') === 'true';
          const sql = activeOnly
            ? `SELECT * FROM CrewMember WHERE active = 1 ORDER BY name ASC`
            : `SELECT * FROM CrewMember ORDER BY active DESC, name ASC`;
          const { results } = await env.DB.prepare(sql).all();
          return jsonResponse({ crew: results }, corsHeaders);
        }

        // PATCH /admin/crew/:crewMemberId — update
        if (/^admin\/crew\/[^/]+$/.test(path) && request.method === 'PATCH') {
          const crewMemberId = path.split('/').pop();
          const body = await request.json().catch(() => ({}));
          const allowed = ['name', 'phone', 'email', 'hiredAt', 'role', 'notes', 'active'];
          const setClauses = [];
          const values = [];
          for (const field of allowed) {
            if (!(field in body)) continue;
            if (field === 'phone') {
              const phone = normalizeE164(String(body.phone).trim());
              if (!phone) return jsonResponse({ error: 'phone must be a US number' }, corsHeaders, 400);
              setClauses.push(`phone = ?`); values.push(phone);
            } else {
              setClauses.push(`${field} = ?`); values.push(body[field]);
            }
          }
          if (setClauses.length === 0) return jsonResponse({ error: 'No valid fields to update' }, corsHeaders, 400);
          setClauses.push(`modifiedAt = ?`); values.push(new Date().toISOString());
          values.push(crewMemberId);
          const result = await env.DB.prepare(
            `UPDATE CrewMember SET ${setClauses.join(', ')} WHERE crewMemberId = ?`
          ).bind(...values).run();
          if ((result.meta?.changes ?? 0) === 0) return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
          const updated = await env.DB.prepare(`SELECT * FROM CrewMember WHERE crewMemberId = ?`).bind(crewMemberId).first();
          return jsonResponse(updated, corsHeaders);
        }

        // DELETE /admin/crew/:crewMemberId — soft delete
        if (/^admin\/crew\/[^/]+$/.test(path) && request.method === 'DELETE') {
          const crewMemberId = path.split('/').pop();
          const result = await env.DB.prepare(
            `UPDATE CrewMember SET active = 0, modifiedAt = ? WHERE crewMemberId = ?`
          ).bind(new Date().toISOString(), crewMemberId).run();
          if ((result.meta?.changes ?? 0) === 0) return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
          return jsonResponse({ crewMemberId, active: 0 }, corsHeaders);
        }
      }

      // ── May backfill: re-derive crew onto historical null-crew jobs ─────────
      // POST /admin/crew/backfill-from-roster
      // Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&dryRun=true|false (default false)
      // For each completed job in range: actualDuration>0, crewCount IS NULL, non-csv.
      //   - Look up DailyRigAssignment for (scheduledDate, rigId).
      //   - Match  → set Job.crewCount, INSERT OR REPLACE JobCrewAssignment, patch KV jh.crew/crewCount.
      //   - No match → skip (crewCount stays null — no guessing).
      // Idempotent: re-running produces identical results (INSERT OR REPLACE + crewCount overwrite).
      // dryRun=true reports exactly what WOULD change, writes nothing.
      // Per-job try/catch: one job failure never aborts the batch (returns error in result).
      if (path === 'admin/crew/backfill-from-roster' && request.method === 'POST') {
        if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
        const bfFrom    = url.searchParams.get('from') || '2026-05-01';
        const bfTo      = url.searchParams.get('to')   || '2026-05-31';
        const bfDryRun  = url.searchParams.get('dryRun') === 'true';
        const bfNow     = new Date().toISOString();

        // Validate date params
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bfFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(bfTo))
          return jsonResponse({ error: 'from/to must be YYYY-MM-DD' }, corsHeaders, 400);

        // 1. Fetch all null-crew completed jobs in range with Bouncie data (non-csv)
        const { results: bfJobs } = await env.DB.prepare(
          `SELECT j.jobId, j.payerId, j.scheduledDate, j.rigId,
                  p.firstName, p.lastName
           FROM Job j
           JOIN Person p ON j.payerId = p.personId
           WHERE j.scheduledDate >= ? AND j.scheduledDate <= ?
             AND j.state = 'completed'
             AND j.actualDuration > 0
             AND j.crewCount IS NULL
             AND j.source NOT LIKE '%csv%'
           ORDER BY j.scheduledDate, j.rigId`
        ).bind(bfFrom, bfTo).all();

        // 2. Fetch ALL DRA rows in range in one query (roster lookup without N+1)
        const { results: bfDraRows } = await env.DB.prepare(
          `SELECT dra.date, dra.rigId, dra.crewMemberId, dra.role,
                  cm.shortId, cm.name
           FROM DailyRigAssignment dra
           JOIN CrewMember cm ON dra.crewMemberId = cm.crewMemberId
           WHERE dra.date >= ? AND dra.date <= ?`
        ).bind(bfFrom, bfTo).all();

        // Index DRA by "date|rigId" → array of roster members
        const bfRosterIndex = {};
        for (const row of (bfDraRows || [])) {
          const key = `${row.date}|${row.rigId}`;
          if (!bfRosterIndex[key]) bfRosterIndex[key] = [];
          bfRosterIndex[key].push({ crewMemberId: row.crewMemberId, shortId: row.shortId, role: row.role });
        }

        // 3. Load KV customer DB once (for KV sync on real run)
        const bfKvDb = bfDryRun ? null : (await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] });
        let   bfKvDirty = false;

        const bfResults = [];
        let bfCountBackfill = 0, bfCountSkip = 0, bfCountError = 0;

        for (const job of (bfJobs || [])) {
          const custName = `${job.firstName || ''} ${job.lastName || ''}`.trim() || job.payerId;
          const rosterKey = `${job.scheduledDate}|${job.rigId}`;
          const roster    = bfRosterIndex[rosterKey] || null;

          if (!roster || roster.length === 0) {
            bfResults.push({
              jobId: job.jobId, customer: custName,
              scheduledDate: job.scheduledDate, rigId: job.rigId,
              currentCrewCount: null, rosterMatch: false,
              rosterCrew: null, wouldSetCrewCount: null, wouldInsertJCA: 0,
              action: 'skip',
            });
            bfCountSkip++;
            continue;
          }

          const bfCrewCount = roster.length;
          const bfShortIds  = roster.map(r => r.shortId).filter(Boolean);

          if (bfDryRun) {
            bfResults.push({
              jobId: job.jobId, customer: custName,
              scheduledDate: job.scheduledDate, rigId: job.rigId,
              currentCrewCount: null, rosterMatch: true,
              rosterCrew: bfShortIds, wouldSetCrewCount: bfCrewCount,
              wouldInsertJCA: roster.length,
              action: 'would_backfill',
            });
            bfCountBackfill++;
            continue;
          }

          // ── Real run: write D1 + KV ──────────────────────────────────────
          try {
            // (a) UPDATE Job.crewCount in D1
            await env.DB.prepare(
              `UPDATE Job SET crewCount=?, modifiedAt=? WHERE jobId=? AND crewCount IS NULL`
            ).bind(bfCrewCount, bfNow, job.jobId).run();

            // (b) INSERT OR REPLACE JobCrewAssignment rows (idempotent snapshot)
            const bfJcaStmts = roster.map(r =>
              env.DB.prepare(
                `INSERT OR REPLACE INTO JobCrewAssignment (jobId, crewMemberId, role) VALUES (?,?,?)`
              ).bind(job.jobId, r.crewMemberId, r.role)
            );
            await env.DB.batch(bfJcaStmts);

            // (c) Sync KV jobHistory entry — find customer by payerId → phone10
            if (job.payerId.startsWith('person_1')) {
              const bfPh10 = job.payerId.slice('person_1'.length);
              const bfCust = (bfKvDb.customers || []).find(
                c => (c.phone || '').replace(/\D/g, '').slice(-10) === bfPh10
              );
              if (bfCust && Array.isArray(bfCust.jobHistory)) {
                const bfJhEntry = bfCust.jobHistory.find(jh => jh.jobId === job.jobId);
                if (bfJhEntry) {
                  bfJhEntry.crew      = bfShortIds;
                  bfJhEntry.crewCount = bfCrewCount;
                  bfKvDirty = true;
                }
              }
            }

            bfResults.push({
              jobId: job.jobId, customer: custName,
              scheduledDate: job.scheduledDate, rigId: job.rigId,
              currentCrewCount: null, rosterMatch: true,
              rosterCrew: bfShortIds, newCrewCount: bfCrewCount,
              jcaRowsWritten: roster.length, action: 'backfilled',
            });
            bfCountBackfill++;
          } catch (bfErr) {
            bfResults.push({
              jobId: job.jobId, customer: custName,
              scheduledDate: job.scheduledDate, rigId: job.rigId,
              action: 'error', error: bfErr.message,
            });
            bfCountError++;
          }
        }

        // 4. Write KV once if anything changed (real run only)
        if (!bfDryRun && bfKvDirty) {
          await env.DATA.put(KV_KEYS.customers, JSON.stringify(bfKvDb));
        }

        return jsonResponse({
          dryRun: bfDryRun,
          from: bfFrom, to: bfTo,
          processed: (bfJobs || []).length,
          backfilled: bfCountBackfill,
          skipped: bfCountSkip,
          errors: bfCountError,
          jobs: bfResults,
        }, corsHeaders);
      }

      // ── Daily rig assignment: write roster from crew popup ───────────────────
      // POST /admin/daily-rig-assignment
      // Body: { date, rigId, crew: [{shortId, role}], dayType }
      // Idempotent: DELETE existing (date,rigId) rows then INSERT the new set.
      // Resolves each shortId → crewMemberId UUID via CrewMember.shortId bridge (Phase 1).
      // Unknown shortIds are skipped + returned in warnings[] (T1.11 — no silent discard).
      if (path === 'admin/daily-rig-assignment' && request.method === 'POST') {
        if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
        const body = await request.json().catch(() => ({}));
        const { date, rigId, crew, dayType } = body;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
          return jsonResponse({ error: 'date required (YYYY-MM-DD)' }, corsHeaders, 400);
        if (!rigId)
          return jsonResponse({ error: 'rigId required' }, corsHeaders, 400);
        const crewArr   = Array.isArray(crew) ? crew : [];
        const safeDay   = (dayType === 'half') ? 'half' : 'full';
        const now       = new Date().toISOString();
        const warnings  = [];

        // Resolve shortIds → UUIDs in one batch query
        const shortIds = [...new Set(crewArr.map(c => c.shortId).filter(Boolean))];
        let shortIdMap = {};  // shortId → crewMemberId UUID
        if (shortIds.length > 0) {
          const placeholders = shortIds.map(() => '?').join(',');
          const { results: cmRows } = await env.DB.prepare(
            `SELECT crewMemberId, shortId FROM CrewMember WHERE shortId IN (${placeholders}) AND active = 1`
          ).bind(...shortIds).all();
          for (const r of (cmRows || [])) shortIdMap[r.shortId] = r.crewMemberId;
        }

        // Build insert rows; collect warnings for unresolved shortIds (T1.11)
        const insertRows = [];
        for (const entry of crewArr) {
          const sid = entry.shortId;
          if (!sid) continue;
          const uuid = shortIdMap[sid];
          if (!uuid) { warnings.push(`shortId '${sid}' not found in CrewMember — skipped`); continue; }
          const role = (entry.role === 'driver') ? 'driver' : 'crew';
          insertRows.push({ crewMemberId: uuid, role });
        }

        // Idempotent: wipe existing (date, rigId) assignment then insert the new set
        await env.DB.prepare(
          `DELETE FROM DailyRigAssignment WHERE date=? AND rigId=?`
        ).bind(date, rigId).run();

        if (insertRows.length > 0) {
          const stmts = insertRows.map(r =>
            env.DB.prepare(
              `INSERT INTO DailyRigAssignment (date,rigId,crewMemberId,role,dayType,createdAt,modifiedAt)
               VALUES (?,?,?,?,?,?,?)`
            ).bind(date, rigId, r.crewMemberId, r.role, safeDay, now, now)
          );
          await env.DB.batch(stmts);
        }

        return jsonResponse(
          { success: true, date, rigId, inserted: insertRows.length, warnings },
          corsHeaders
        );
      }

      // GET /admin/daily-rig-assignment/range — bulk roster for cross-device calendar hydration
      // Returns ALL DRA rows in a date range, shaped for the merge-into-calState algorithm.
      // Shape: { from, to, assignments: { [date]: { [rigId]: { dayType, crew:[{shortId,role}] } } } }
      // Used by calendar on load + week navigation to merge D1 into localStorage (Piece B).
      if (path === 'admin/daily-rig-assignment/range' && request.method === 'GET') {
        if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
        const rangeFrom = url.searchParams.get('from');
        const rangeTo   = url.searchParams.get('to');
        if (!rangeFrom || !rangeTo)
          return jsonResponse({ error: 'from and to required' }, corsHeaders, 400);
        const { results: rangeRows } = await env.DB.prepare(
          `SELECT dra.date, dra.rigId, dra.role, dra.dayType, cm.shortId, cm.name
           FROM DailyRigAssignment dra
           JOIN CrewMember cm ON dra.crewMemberId = cm.crewMemberId
           WHERE dra.date >= ? AND dra.date <= ?
           ORDER BY dra.date, dra.rigId, dra.role DESC`
        ).bind(rangeFrom, rangeTo).all();
        // Nest by date → rig → {dayType, crew[]}
        const rangeAsgn = {};
        for (const r of (rangeRows || [])) {
          if (!rangeAsgn[r.date])         rangeAsgn[r.date]         = {};
          if (!rangeAsgn[r.date][r.rigId]) rangeAsgn[r.date][r.rigId] = { dayType: r.dayType, crew: [] };
          rangeAsgn[r.date][r.rigId].crew.push({ shortId: r.shortId, name: r.name, role: r.role });
        }
        return jsonResponse({ from: rangeFrom, to: rangeTo, assignments: rangeAsgn }, corsHeaders);
      }

      // GET /admin/daily-rig-assignment — roster lookup for crew derivation at completion
      // Returns the crew assigned to a (date, rig) slot, including shortIds for calendar use.
      if (path === 'admin/daily-rig-assignment' && request.method === 'GET') {
        if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
        const qDate = url.searchParams.get('date');
        const qRig  = url.searchParams.get('rig');
        if (!qDate || !qRig)
          return jsonResponse({ error: 'date and rig required' }, corsHeaders, 400);
        const { results: draRows } = await env.DB.prepare(
          `SELECT dra.crewMemberId, dra.role, dra.dayType, cm.shortId, cm.name
           FROM DailyRigAssignment dra
           JOIN CrewMember cm ON dra.crewMemberId = cm.crewMemberId
           WHERE dra.date = ? AND dra.rigId = ?
           ORDER BY dra.role DESC`  // 'driver' before 'crew' alphabetically
        ).bind(qDate, qRig).all();
        const draCrew   = (draRows || []).map(r => ({
          crewMemberId: r.crewMemberId, shortId: r.shortId, name: r.name, role: r.role,
        }));
        const draDayType = draRows && draRows.length > 0 ? draRows[0].dayType : null;
        return jsonResponse({ date: qDate, rigId: qRig, dayType: draDayType, crew: draCrew }, corsHeaders);
      }

      // ── Worker hours: per-customer attribution (protected) ───────────────────
      if (/^admin\/worker-hours\/customer\/[^/]+$/.test(path) && request.method === 'GET') {
        const phone = path.split('/').pop().replace(/\D/g, '').slice(-10);
        const db  = await env.DATA.get(KV_KEYS.customers, 'json');
        const c   = (db?.customers || []).find(x => (x.phone || '').replace(/\D/g, '').slice(-10) === phone);
        if (!c) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);
        const workerMap = computeWorkerHours([c], '2000-01-01', '2099-12-31');
        const workers = Object.entries(workerMap)
          .map(([name, d]) => ({ name, hours: d.hours, jobCount: d.jobCount, jobs: d.jobs }))
          .sort((a, b) => b.hours - a.hours);
        return jsonResponse({ phone, customer: fullName(c), workers }, corsHeaders);
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

      // ── Auto-snapshot: status (protected) ────────────────────────────────────
      if (path === 'admin/auto-snapshot-status' && request.method === 'GET') {
        const log      = (await env.DATA.get('auto_snapshot:log', 'json')) || [];
        const failures = (await env.DATA.get('snapshot_failures', 'json')) || [];
        const latestFailure = failures[0] || null;
        return jsonResponse({
          schedule:      '0 */6 * * * (every 6 hours UTC)',
          totalRuns:     log.length,
          lastRun:       log[0] || null,
          recentRuns:    log.slice(0, 10),
          latestFailure,
          r2Configured:  !!env.BACKUPS,
        }, corsHeaders);
      }

      // ── Auto-snapshot: manual trigger (protected) ─────────────────────────────
      if (path === 'admin/auto-snapshot/trigger' && request.method === 'POST') {
        const result = await runAutoSnapshot(env);
        return jsonResponse(result, corsHeaders, result.status === 'success' ? 200 : 500);
      }

      // ── Bouncie metrics: recompute all (protected) ────────────────────────────
      if (path === 'admin/compute-metrics' && request.method === 'POST') {
        const db = await env.DATA.get(KV_KEYS.customers, 'json');
        if (!db) return jsonResponse({ error: 'No customer DB' }, corsHeaders, 404);
        const customers = db.customers || [];
        let withMetrics = 0;
        for (const c of customers) {
          computeBouncieMetrics(c);
          if (c.bouncieMetrics) withMetrics++;
        }
        await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
        return jsonResponse({ success: true, totalCustomers: customers.length, withMetrics }, corsHeaders);
      }

      // Fall through to static assets for any unrecognized path (HTML pages, etc.)
      if (env.ASSETS) {
        const r = await env.ASSETS.fetch(request);
        return addCacheHeaders(r, url.pathname.endsWith('.html') ? 'html' : 'asset');
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

// ── R2 Photo admin (Phase 1 foundation) ──────────────────────────────────────
//
// Three endpoints that form the storage plumbing for the full photo system.
// UI capture (Phase 2) and display (Phase 3) are built on top of these.
// The existing KV photo routes below remain untouched until Phase 4 migration.

// POST /admin/photos/upload
//
// Accepts a raw binary image body.  All context comes from query params so the
// full Content-Length is available to R2 without parsing a multipart body.
//
// Required query params:
//   type        — 'before' | 'after' | 'satellite'
//   jobId       — required when type = before | after
//   propertyId  — required when type = satellite
//
// Optional query param:
//   updateD1=true — also patch Job.photoKeys (append) or Property.satelliteImageKey
//                   after the R2 write succeeds.  Phase 2 will pass this flag so
//                   a single upload call both stores the blob and wires the reference.
//                   Omit in Phase 1 tests (pure storage check, no D1 side-effect).
//
// Returns: { success: true, key: "job/{jobId}/before_{ts}.jpg" }
//
async function handlePhotoR2Upload(request, env, url, corsHeaders) {
  if (!env.PHOTOS) return jsonResponse({ error: 'R2 PHOTOS bucket not configured — create bucket and add [[r2_buckets]] binding in wrangler.toml' }, corsHeaders, 503);

  const type       = url.searchParams.get('type')       || '';
  const jobId      = url.searchParams.get('jobId')      || '';
  const propertyId = url.searchParams.get('propertyId') || '';
  const updateD1   = url.searchParams.get('updateD1') === 'true';

  if (!['before', 'after', 'satellite', 'front'].includes(type)) {
    return jsonResponse({ error: 'type must be before | after | satellite | front' }, corsHeaders, 400);
  }
  // satellite + front are property-level reference images; both require propertyId.
  if ((type === 'satellite' || type === 'front') && !propertyId) {
    return jsonResponse({ error: 'propertyId required for type=satellite or type=front' }, corsHeaders, 400);
  }
  if ((type === 'before' || type === 'after') && !jobId) {
    return jsonResponse({ error: 'jobId required for type=before or type=after' }, corsHeaders, 400);
  }

  // Derive R2 key.
  // Satellite + front overwrite on re-upload (same key = same property) — intended.
  // Before/after get a timestamp suffix so multiple uploads per job never collide.
  const ts  = Date.now();
  const key = type === 'satellite'
    ? `property/${propertyId}/satellite.jpg`
    : type === 'front'
      ? `property/${propertyId}/front.jpg`
      : `job/${jobId}/${type}_${ts}.jpg`;

  const contentType = (request.headers.get('Content-Type') || 'image/jpeg').split(';')[0].trim();

  try {
    await env.PHOTOS.put(key, request.body, {
      httpMetadata: { contentType },
    });
  } catch (e) {
    console.error('[handlePhotoR2Upload] R2 put failed:', e.message);
    return jsonResponse({ error: 'R2 write failed', detail: e.message }, corsHeaders, 500);
  }

  // Optional: wire the D1 reference in the same request.
  // Phase 2 will always pass updateD1=true from the quote-builder save flow.
  if (updateD1) {
    const now = new Date().toISOString();
    try {
      if (type === 'satellite' && propertyId) {
        await env.DB.prepare(
          `UPDATE Property SET satelliteImageKey = ?, modifiedAt = ? WHERE propertyId = ?`
        ).bind(key, now, propertyId).run();
      } else if (type === 'front' && propertyId) {
        await env.DB.prepare(
          `UPDATE Property SET frontImageKey = ?, modifiedAt = ? WHERE propertyId = ?`
        ).bind(key, now, propertyId).run();
      } else if ((type === 'before' || type === 'after') && jobId) {
        const row      = await env.DB.prepare(`SELECT photoKeys FROM Job WHERE jobId = ?`).bind(jobId).first();
        const existing = (row?.photoKeys ? JSON.parse(row.photoKeys) : []);
        const updated  = [...existing, key];
        await env.DB.prepare(
          `UPDATE Job SET photoKeys = ?, modifiedAt = ? WHERE jobId = ?`
        ).bind(JSON.stringify(updated), now, jobId).run();
      }
    } catch (e) {
      // R2 write succeeded — log D1 failure but still return the key so the
      // caller can retry the reference patch without re-uploading the blob.
      console.error('[handlePhotoR2Upload] D1 reference patch failed:', e.message);
      return jsonResponse({ success: true, key, d1Warning: 'R2 write OK but D1 reference patch failed — retry with PATCH /admin/job/:id' }, corsHeaders);
    }
  }

  return jsonResponse({ success: true, key }, corsHeaders);
}

// GET /admin/photos/job/:jobId
//
// Returns the R2 keys stored in Job.photoKeys so the UI can build
// GET /admin/photos/key/... URLs for display.
// Returns { jobId, keys: [...], total: N }  — empty keys array when null.
//
async function handlePhotoR2GetJob(jobId, env, corsHeaders) {
  if (!env.PHOTOS) return jsonResponse({ error: 'R2 PHOTOS bucket not configured' }, corsHeaders, 503);
  if (!jobId) return jsonResponse({ error: 'jobId required' }, corsHeaders, 400);

  let row;
  try {
    row = await env.DB.prepare(`SELECT photoKeys FROM Job WHERE jobId = ?`).bind(jobId).first();
  } catch (e) {
    return jsonResponse({ error: 'D1 query failed', detail: e.message }, corsHeaders, 500);
  }
  if (!row) return jsonResponse({ error: 'Job not found', jobId }, corsHeaders, 404);

  const keys = row.photoKeys ? JSON.parse(row.photoKeys) : [];
  return jsonResponse({ jobId, keys, total: keys.length }, corsHeaders);
}

// GET /admin/photos/key/*
//
// Streams any R2 object by its full key.
// URL pattern: /admin/photos/key/job/{jobId}/before_{ts}.jpg
//              /admin/photos/key/property/{propertyId}/satellite.jpg
//
// Long cache (1 year) because R2 keys are content-addressed by timestamp —
// a re-uploaded satellite simply gets a new key via the upload endpoint.
// (Satellite overwrite is same key — browser cache is still correct because
//  the profile page always fetches live from this endpoint on render.)
//
async function handlePhotoR2GetKey(r2Key, env, corsHeaders) {
  if (!env.PHOTOS) return jsonResponse({ error: 'R2 PHOTOS bucket not configured' }, corsHeaders, 503);
  if (!r2Key) return new Response('Not found', { status: 404, headers: corsHeaders });

  let obj;
  try {
    obj = await env.PHOTOS.get(r2Key);
  } catch (e) {
    return jsonResponse({ error: 'R2 read failed', detail: e.message }, corsHeaders, 500);
  }
  if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders });

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type':  obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000',
      ...corsHeaders,
    },
  });
}

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

// ── POST /incoming — rate limit + honeypot + validation ──────────────────────
async function handleIncomingSubmit(request, env, corsHeaders) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, corsHeaders, 400); }

  // Honeypot: bots fill the hidden "website" field; humans don't. Return 200 silently — don't tell the bot it failed.
  if (body.website) return jsonResponse({ success: true }, corsHeaders);

  // Rate limit: 5 submissions per IP per 10 minutes
  const rk = `rate:incoming:${ip}`;
  const count = (await env.DATA.get(rk, 'json')) || 0;
  if (count >= 5) {
    return jsonResponse({ error: 'Too many quote requests. Please wait 10 minutes or call us at (954) 389-2642.' }, corsHeaders, 429);
  }
  await env.DATA.put(rk, JSON.stringify(count + 1), { expirationTtl: 600 });

  // Structural validation
  const cd = body.customerData || {};
  const phone = (cd.phone || body.phone || '').replace(/\D/g, '');
  const firstName = (cd.firstName || body.name || '').trim();
  const lastName  = (cd.lastName  || '').trim();
  const city      = (cd.city      || body.city || '').trim();

  // Reschedule and waitlist submissions have partial data — skip strict validation for those
  const skipValidation = body.source === 'reschedule' || body.source === 'quote_reschedule' || body.source === 'waitlist';
  if (!skipValidation) {
    if (phone.length < 10)     return jsonResponse({ error: 'Please fill out all fields correctly.' }, corsHeaders, 400);
    if (firstName.length < 2)  return jsonResponse({ error: 'Please fill out all fields correctly.' }, corsHeaders, 400);
    if (lastName.length  < 2)  return jsonResponse({ error: 'Please fill out all fields correctly.' }, corsHeaders, 400);
    if (!city)                 return jsonResponse({ error: 'Please fill out all fields correctly.' }, corsHeaders, 400);
  }

  // Save
  if (!body.id)        body.id        = generateId();
  if (!body.createdAt) body.createdAt = new Date().toISOString();
  const existing = await env.DATA.get(KV_KEYS.incoming, 'json') || {};
  if (!existing.requests) existing.requests = [];
  existing.requests.push(body);
  await env.DATA.put(KV_KEYS.incoming, JSON.stringify(existing));
  // Text 1: alert Tyler on every real new quote lead (not reschedule/waitlist noise)
  if (!skipValidation) {
    await sendSms(env, env.TYLER_CELL, _smsLeadBody(firstName, lastName, city, cd));
  }
  return jsonResponse({ success: true, entry: body }, corsHeaders);
}

// PUT /customers — full-blob replace with completedAt guard + blast-radius guard.
// completedAt guard: fills in missing ss.completedAt when state='completed' (Phase 2 belt-and-suspenders).
// blast-radius guard: rejects writes that would lose >50% of existing records — catches accidental
//   small-payload PUTs (smoke tests, migration scripts, manual curl). Use ?force=true to override.
//   NOT applied to /import/rollback (intentional full replacement via separate handler).
async function handleCustomersPut(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'Invalid JSON' }, corsHeaders, 400);

  const now = new Date().toISOString();
  const customers = body.customers || [];

  // ── Blast-radius guard ────────────────────────────────────────────────────
  const url        = new URL(request.url);
  const force      = url.searchParams.get('force') === 'true';
  const currentDb  = await env.DATA.get(KV_KEYS.customers, 'json') || {};
  const currentCount  = (currentDb.customers || []).length;
  const incomingCount = customers.length;
  if (currentCount > 100 && incomingCount < currentCount * 0.5 && !force) {
    return jsonResponse({
      error:   'blast_radius_guard',
      message: `Incoming write has ${incomingCount} customers but KV has ${currentCount}. `+
               `This write would lose more than 50% of records. Use ?force=true to override if intentional.`,
      currentCount,
      incomingCount,
    }, corsHeaders, 400);
  }
  // ─────────────────────────────────────────────────────────────────────────

  for (const c of customers) {
    const ss = c.scheduledStatus;
    if (!ss || ss.state !== 'completed' || ss.completedAt) continue;
    // csv_backfill entries have null completedAt from migration — never stamp NOW
    // or they flood the review queue with 1,200+ false positives on every PUT.
    if ((ss.source||'').indexOf('csv_backfill') !== -1) continue;

    ss.completedAt = now;

    // Append a minimal jobHistory entry if none already covers this date+amount
    const completedDate = ss.scheduledDate || now.slice(0, 10);
    const amount = ss.approvedAmount || 0;
    const norm = (p) => (p || '').replace(/\D/g, '');
    if (!c.jobHistory) c.jobHistory = [];
    const hasEntry = c.jobHistory.some(j =>
      j.date === completedDate && j.status === 'completed' &&
      Math.abs((j.amount || 0) - amount) <= 5
    );
    // Skip server_guard write if a calendar_completion already covers this date+amount.
    // Prevents the double-write pattern where the calendar writes calendar_completion
    // and this guard subsequently writes a redundant server_guard entry.
    const calendarCompletionExists = c.jobHistory.some(j =>
      j.source === 'calendar_completion' &&
      j.date === completedDate &&
      Math.abs((j.amount || 0) - amount) <= 5
    );
    if (!hasEntry && !calendarCompletionExists) {
      c.jobHistory.push({
        jobId:       `${norm(c.phone)}_${completedDate}_${Math.round(amount * 100)}_srv`,
        date:        completedDate,
        services:    ss.jobNotes || '',
        amount,
        rig:         ss.rig || null,
        rigId:       ss.rig || null,
        city:        c.city || null,
        address:     c.address || null,
        status:      'completed',
        completedAt: now,
        crew:        ss.crew || [],
        source:      'server_guard',
      });
    }
  }

  // Bug 2 fix: extract deliberate-edit signals before stripping from KV payload.
  // _addressEdited is set only by explicit user saves (saveFullEdit, submitPhonePath,
  // submitDigitalPath) — never by bulk sync, autocomplete diffs, or migration.
  // Stripping before KV write keeps the flag ephemeral (not persisted to KV).
  const _addrEditedPhones = new Set();
  for (const c of customers) {
    if (c._addressEdited) {
      const _aph = (c.phone||'').replace(/\D/g,'').slice(-10);
      if (_aph) _addrEditedPhones.add(_aph);
      delete c._addressEdited;
    }
  }

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(body));

  // ── Day 2 dual-write: mirror changes to D1 (fire-and-forget, KV is canonical) ──
  try {
    await _d1SyncCustomersPut(customers, currentDb.customers || [], env, _addrEditedPhones);
  } catch (e) {
    await _logD1Failure(env, 'handleCustomersPut', e.message);
  }

  return jsonResponse({ success: true }, corsHeaders);
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
  const {
    date, display, rig, rigLabel, approvedAmount, services, addOns, quoteCode: qCode, city, address, email,
    // Part 2: rust + sealing interest fields (previously never sent — saveOfferingInterest was a no-op stub)
    rustChecked, rustSurface, rustNotes,
    sealingChecked, sealingSurfaces, sealingPaverSand,
  } = body;

  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);

  const now = new Date().toISOString();

  // Backfill missing fields from quote data — never overwrite populated values
  if (city    && !cust.city)    cust.city    = city;
  if (address && !cust.address) cust.address = address;
  if (email   && !cust.email)   cust.email   = email;

  // ── Build full service text ────────────────────────────────────────────────
  // All customer selections (add-ons, rust interest, sealing interest) merged into one
  // string so they survive into ss.jobNotes → D1 servicesRaw → calendar card service line.
  // Empty case: if none present, _fullJobNotes === services (unchanged from before).
  const _addonLabels  = (addOns || []).filter(a => a.name || a.label).map(a => a.name || a.label);
  const _sealingSrfs  = Array.isArray(sealingSurfaces) ? sealingSurfaces : [];
  let _fullJobNotes = services || '';
  if (_addonLabels.length) {
    _fullJobNotes += `  + ADD-ONS: ${_addonLabels.join(', ')}`;
  }
  if (rustChecked) {
    const _rSurf  = rustSurface || 'TBD';
    const _rNotes = (rustNotes || '').trim();
    _fullJobNotes += `  ⚠️ RUST REMOVAL: ${_rSurf}${_rNotes ? ` — "${_rNotes}"` : ''}`;
  }
  if (sealingChecked) {
    const _sSrfs = _sealingSrfs.length ? _sealingSrfs.join(', ') : 'TBD';
    const _sPaver = sealingPaverSand ? ' + paver sand' : '';
    _fullJobNotes += `  ✨ SEALING INTEREST: ${_sSrfs}${_sPaver}`;
  }
  // ─────────────────────────────────────────────────────────────────────────

  cust.quoteStatus = {
    ...(cust.quoteStatus || {}),
    state: 'confirmed',
    confirmedDate: date,
    confirmedDateDisplay: display,
    confirmedAt: now,
    approvedAmount,
    addOns: addOns || [],
    rustInterest:    rustChecked ? { surface: rustSurface||null, notes: rustNotes||'' } : null,
    sealingInterest: sealingChecked ? { surfaces: _sealingSrfs, paverSand: sealingPaverSand||false } : null,
  };

  cust.scheduledStatus = {
    ...(cust.scheduledStatus || {}),
    state: 'scheduled',
    scheduledDate: date,
    rig: rig || cust.scheduledStatus?.rig || null,
    approvedAmount,
    jobNotes: _fullJobNotes || cust.scheduledStatus?.jobNotes || '',
    confirmedByCustomer: true,
    confirmedAt: now,
  };

  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));

  // ── Day 2 dual-write: INSERT scheduled Job + ensure Person/Property exist ──
  try {
    if (env.DB) {
      await _d1SyncNewCustomer(cust, env, now);
      await _d1SyncScheduledJob(cust, env, now);
    }
  } catch (e) { await _logD1Failure(env, 'handleAgreementConfirm', e.message); }

  if (qCode) {
    const kvKey  = `quote_${qCode}`;
    const existing = await env.DATA.get(kvKey, 'json');
    if (existing) {
      // Part 1d (T1.22): propagate serviceTags from quote record → scheduledStatus
      // so _d1SyncScheduledJob can write structured servicesRequested to D1.
      if (Array.isArray(existing.serviceTags) && existing.serviceTags.length > 0) {
        cust.scheduledStatus.serviceTags = existing.serviceTags;
      }
      await env.DATA.put(kvKey, JSON.stringify({
        ...existing,
        confirmedDate: date,
        confirmedDateDisplay: display,
        confirmedAt: now,
        approvedAmount,
        addOns: addOns || existing.addOns || [],
        lastUpdated: now,
      }));

      // ── Phase 2: image keys carry-over → Property ─────────────────────────
      // Photos were uploaded to R2 at quote-build time; R2 keys stored in the
      // quote payload.  _d1SyncNewCustomer (above) guarantees the Property row
      // exists before this runs. Idempotent — UPDATE on same key is safe.
      if ((existing.satelliteImageKey || existing.frontImageKey) && env.DB) {
        try {
          const _imgPropId = cust.address ? _d1PropId(cust.address, cust.city||'') : null;
          if (_imgPropId) {
            if (existing.satelliteImageKey) {
              await env.DB.prepare(
                `UPDATE Property SET satelliteImageKey=?,modifiedAt=? WHERE propertyId=?`
              ).bind(existing.satelliteImageKey, now, _imgPropId).run();
            }
            if (existing.frontImageKey) {
              await env.DB.prepare(
                `UPDATE Property SET frontImageKey=?,modifiedAt=? WHERE propertyId=?`
              ).bind(existing.frontImageKey, now, _imgPropId).run();
            }
          }
        } catch(e) {
          // Non-fatal — R2 blobs are safe. Log and continue.
          await _logD1Failure(env, `handleAgreementConfirm:imageKeys:${phone}`, e.message).catch(()=>{});
        }
      }
    }
  }

  // Text 2: alert Tyler — full service text including add-ons + upsell signals
  const _confName = `${cust.firstName || ''} ${cust.lastName || ''}`.trim() || phone;
  await sendSms(env, env.TYLER_CELL, _smsConfirmedBody(_confName, cust.city || city || '', approvedAmount, display, _fullJobNotes, phone));

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

  // ── Day 2 dual-write: update payment on the most recent completed Job ──
  try {
    if (env.DB) {
      const normPh   = (phone||'').replace(/\D/g,'').slice(-10);
      const personId = _d1PersonId(normPh);
      if (personId) {
        await env.DB.prepare(
          `UPDATE Job SET paymentMethod=?, paymentStatus='paid', paidAt=?, modifiedAt=? WHERE payerId=? AND state='completed' AND (paidAt IS NULL OR paidAt='') ORDER BY scheduledDate DESC LIMIT 1`
        ).bind(method||'cash', now, now, personId).run();
      }
    }
  } catch (e) { await _logD1Failure(env, 'handleLogPayment', e.message); }

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
    body: `Hi {firstName}! It was a pleasure working on your {service} in {city}. If you were happy with the job, it would mean a lot if you left us a quick 5-star Google review 🙏\n\nJust click here: {reviewLink}\n\nFeel free to mention {service} and {city} — that really helps us grow!\n\nThank you again,\nThe Fumero Family\nPure Cleaning Pressure Cleaning`,
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

const REVIEW_ELIGIBLE_CUTOFF    = '2026-05-01';
const NO_RESPONSE_REASK_DAYS    = 30;

function reviewIsReadyToRequest(c, rs, nowIso, thirtyDaysAgo) {
  // rs = review state from review_states[phone] (never from customer_db)
  if (c.deleted) return false;
  if (c.isReferralOnly) return false;
  if (c.customerType === 'partner_referral') return false;
  if (c.optOut) return false;
  if ((c.phone || '').startsWith('REFERRAL_')) return false;
  if (c.neverAskReview === true) return false;
  const gr = rs || {};
  const st = gr.status || 'never_asked';
  if (st === 'left' || st === 'do_not_ask') return false;
  if (st === 'asked') return false;
  if (st === 'declined'    && gr.reaskEligibleAt && gr.reaskEligibleAt > nowIso) return false;
  if (st === 'no_response' && gr.reaskEligibleAt && gr.reaskEligibleAt > nowIso) return false;
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
  if (ss.state === 'completed' && ss.completedAt && ss.completedAt >= REVIEW_ELIGIBLE_CUTOFF &&
      (ss.source||'').indexOf('csv_backfill') === -1) return true;

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
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const [db, states, templates, actualCountRaw] = await Promise.all([
    env.DATA.get(KV_KEYS.customers, 'json').then(d => d || { customers: [] }),
    env.DATA.get('review_states', 'json').then(d => d || {}),
    env.DATA.get('reviews_templates', 'json'),
    env.DATA.get('reviews_actual_count', 'json'),
  ]);

  const tpls        = templates || DEFAULT_TEMPLATES;
  const actualCount = actualCountRaw || { count: 92, lastUpdatedAt: null, updatedBy: null, history: [] };
  const customers   = (db.customers || []).filter(c => !c.deleted);

  const now            = new Date();
  const nowIso         = now.toISOString();
  const thirtyDays     = new Date(+now - 30  * 86400000).toISOString();
  const thisMonthStart = now.toISOString().slice(0, 7) + '-01';
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);

  // ── Auto-tail-off: asked > 7 days with no action → no_response ───────────────
  const SEVEN_DAYS_MS = 7 * 86400000;
  let statesChanged = false;
  for (const [phone, rs] of Object.entries(states)) {
    if (rs.status === 'asked' && rs.askedAt) {
      if (now.getTime() - new Date(rs.askedAt).getTime() >= SEVEN_DAYS_MS) {
        rs.status        = 'no_response';
        rs.noResponseAt  = nowIso;
        rs.reaskEligibleAt = new Date(Date.now() + NO_RESPONSE_REASK_DAYS * 86400000).toISOString();
        statesChanged = true;
      }
    }
  }
  if (statesChanged) await env.DATA.put('review_states', JSON.stringify(states));

  const readyToRequest = [], awaitingConfirmation = [], reviewed = [], wontAsk = [], permanentExclusions = [];
  let totalAsked = 0, thisMonthReviewed = 0, lastMonthReviewed = 0;
  const byTemplate = {};

  for (const c of customers) {
    if (c.neverAskReview === true) { permanentExclusions.push(c); continue; }
    const gr = states[norm(c.phone)] || {};
    const st = gr.status || 'never_asked';
    // Attach review state to customer object so UI can read it without a second API call
    c.googleReview = gr;

    if (st === 'left') {
      reviewed.push(c);
      totalAsked++;
      if (gr.leftAt && gr.leftAt >= thisMonthStart) thisMonthReviewed++;
      if (gr.leftAt && gr.leftAt >= lastMonthStart && gr.leftAt <= lastMonthEnd + 'T23:59:59Z') lastMonthReviewed++;
      if (gr.templateUsedId) byTemplate[gr.templateUsedId] = (byTemplate[gr.templateUsedId] || { asked: 0, reviewed: 0 });
      if (gr.templateUsedId) byTemplate[gr.templateUsedId].reviewed++;
    } else if (st === 'do_not_ask') {
      wontAsk.push(c);
    } else if (st === 'declined'    && gr.reaskEligibleAt && gr.reaskEligibleAt > nowIso) {
      wontAsk.push(c);
    } else if (st === 'no_response' && gr.reaskEligibleAt && gr.reaskEligibleAt > nowIso) {
      wontAsk.push(c);
    } else if (st === 'asked') {
      awaitingConfirmation.push(c);
      totalAsked++;
      if (gr.templateUsedId) { byTemplate[gr.templateUsedId] = byTemplate[gr.templateUsedId] || { asked: 0, reviewed: 0 }; byTemplate[gr.templateUsedId].asked++; }
    } else if (reviewIsReadyToRequest(c, gr, nowIso, thirtyDays)) {
      readyToRequest.push(c);
    }
  }

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
    permanentExclusions,
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
  const norm  = p => (p||'').replace(/\D/g,'').slice(-10);
  const key   = norm(phone);
  const states = await env.DATA.get('review_states', 'json') || {};
  const now   = new Date().toISOString();
  const prev  = states[key] || {};

  states[key] = {
    ...prev,
    status:            'asked',
    askedAt:           prev.askedAt || now,
    lastRequestSentAt: now,
    requestCount:      (prev.requestCount || 0) + 1,
    templateUsedId:    templateUsedId || prev.templateUsedId || null,
    sourceJobId:       jobId || prev.sourceJobId || null,
  };

  // Increment template usage
  if (templateUsedId) {
    const tpls = await env.DATA.get('reviews_templates', 'json');
    if (tpls) {
      const tpl = tpls.find(t => t.id === templateUsedId);
      if (tpl) { tpl.timesUsed = (tpl.timesUsed || 0) + 1; await env.DATA.put('reviews_templates', JSON.stringify(tpls)); }
    }
  }

  await env.DATA.put('review_states', JSON.stringify(states));
  return jsonResponse({ success: true, googleReview: states[key] }, corsHeaders);
}

async function handleReviewStatus(request, env, phone, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const { status, noteAboutReview, starRating } = body;
  const VALID = ['left','declined','do_not_ask','never_asked','asked','no_response'];
  if (!VALID.includes(status)) return jsonResponse({ error: 'Invalid status' }, corsHeaders, 400);

  const norm   = p => (p||'').replace(/\D/g,'').slice(-10);
  const key    = norm(phone);
  const states = await env.DATA.get('review_states', 'json') || {};
  const now    = new Date().toISOString();
  const gr     = states[key] || {};

  gr.status = status;
  if (status === 'left') {
    gr.leftAt = now;
    if (Number.isInteger(starRating) && starRating >= 1 && starRating <= 5) gr.starRating = starRating;
  }
  if (status === 'declined')    { gr.declinedAt = now; gr.reaskEligibleAt = new Date(Date.now() + 180 * 86400000).toISOString(); }
  if (status === 'do_not_ask')  { gr.doNotAskAt = now; }
  if (status === 'no_response') { gr.noResponseAt = now; gr.reaskEligibleAt = new Date(Date.now() + NO_RESPONSE_REASK_DAYS * 86400000).toISOString(); }
  if (noteAboutReview !== undefined) gr.noteAboutReview = noteAboutReview;
  states[key] = gr;

  // Increment reviewsGenerated on template
  if (status === 'left' && gr.templateUsedId) {
    const tpls = await env.DATA.get('reviews_templates', 'json');
    if (tpls) {
      const tpl = tpls.find(t => t.id === gr.templateUsedId);
      if (tpl) { tpl.reviewsGenerated = (tpl.reviewsGenerated || 0) + 1; await env.DATA.put('reviews_templates', JSON.stringify(tpls)); }
    }
  }

  await env.DATA.put('review_states', JSON.stringify(states));
  return jsonResponse({ success: true, googleReview: gr }, corsHeaders);
}

async function handleAllowAskingAgain(env, phone, corsHeaders) {
  const norm   = p => (p||'').replace(/\D/g,'').slice(-10);
  const key    = norm(phone);
  const states = await env.DATA.get('review_states', 'json') || {};
  states[key]  = { ...(states[key] || {}), status: 'never_asked', reaskEligibleAt: null, doNotAskAt: null };
  await env.DATA.put('review_states', JSON.stringify(states));
  return jsonResponse({ success: true }, corsHeaders);
}

async function handleNeverAskReview(env, phone, corsHeaders, set) {
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);
  const db   = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
  const cust = (db.customers||[]).find(c => norm(c.phone) === norm(phone));
  if (!cust) return jsonResponse({ error: 'Customer not found' }, corsHeaders, 404);
  if (set) {
    cust.neverAskReview = true;
    cust.neverAskReviewAt = new Date().toISOString();
  } else {
    delete cust.neverAskReview;
    delete cust.neverAskReviewAt;
  }
  await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true, neverAskReview: set }, corsHeaders);
}

async function handleMigrateReviewStates(env, corsHeaders) {
  const norm   = p => (p||'').replace(/\D/g,'').slice(-10);
  const [db, existing] = await Promise.all([
    env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] },
    env.DATA.get('review_states', 'json').then(d => d || {}),
  ]);
  const customers = (db.customers || []).filter(Boolean);
  let migrated = 0, skipped = 0, cleaned = 0;

  for (const c of customers) {
    if (!c.googleReview) continue;
    const key = norm(c.phone);
    if (!key) { skipped++; continue; }
    // Only migrate if review_states doesn't already have a meaningful entry
    if (!existing[key] || existing[key].status === 'never_asked') {
      existing[key] = { ...c.googleReview };
      migrated++;
    } else {
      skipped++;
    }
    delete c.googleReview;
    cleaned++;
  }

  await env.DATA.put('review_states', JSON.stringify(existing));
  if (cleaned > 0) await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  return jsonResponse({ success: true, migrated, skipped, cleaned, totalStates: Object.keys(existing).length }, corsHeaders);
}

// ── Phase 4: D1 → legacy KV shape compatibility layer ────────────────────────
// Converts D1 rows to the KV customer object shape the UI expects.

// ── Net margin helpers (Migration 0015) ──────────────────────────────────────
// null = cost data not yet captured; NEVER coerce to $0.
// Margin stays null until at least one cost field is known.
function computeNetMargin(j) {
  const costs = [j.gasCost, j.chemicalCost, j.laborCost, j.equipmentCost, j.otherCost];
  const known = costs.filter(v => v != null);
  if (known.length === 0) return null;
  const totalCost = known.reduce((s, v) => s + v, 0);
  return Math.round(((j.amount || 0) - totalCost) * 100) / 100;
}
function computeMarginPct(j) {
  const m = computeNetMargin(j);
  const rev = j.amount || 0;
  return (m != null && rev > 0) ? Math.round((m / rev) * 100) : null;
}

function _d1JobToJhEntry(j, primaryCity, primaryAddr, propById) {
  const jobProp = (propById || {})[j.propertyId];
  const city    = jobProp?.city          || primaryCity;
  const addr    = jobProp?.streetAddress || primaryAddr;
  return {
    jobId:              j.jobId,
    date:               j.scheduledDate   || null,
    services:           j.servicesRaw     || '',
    amount:             j.amount          || 0,
    rig:                j.rigId           || null,
    rigId:              j.rigId           || null,
    city,
    address:            addr,
    status:             j.state === 'completed' ? 'completed' : j.state,
    completedAt:        j.completedAt     || null,
    crew:               [],
    source:             (j.source||'').startsWith('csv_backfill') ? 'csv_backfill' : (j.source || 'calendar_completion'),
    paymentMethod:      j.paymentMethod   || null,
    paidAt:             j.paidAt          || null,
    actualDuration:     j.actualDuration  || null,
    actualArrival:      j.actualArrival   || null,
    actualDeparture:    j.actualDeparture || null,
    bouncieMatchStatus: j.bouncieMatchStatus || null,
    workSiteAddress:    j.workSiteAddress    || null,
    workSiteCity:       j.workSiteCity       || null,
    crewCount:          j.crewCount          ?? null,  // null when unknown — Track 2 must not guess
    roofStories:        j.roofStories        || null,
    // Migration 0015: outcome + cost fields
    tipped:             !!j.tipped,
    tipAmount:          j.tipAmount          ?? null,
    complained:         !!j.complained,
    complaintNotes:     j.complaintNotes     || null,
    gasCost:            j.gasCost            ?? null,
    chemicalCost:       j.chemicalCost       ?? null,
    laborCost:          j.laborCost          ?? null,
    equipmentCost:      j.equipmentCost      ?? null,
    otherCost:          j.otherCost          ?? null,
    milesFromPreviousJob:     j.milesFromPreviousJob     ?? null,
    drivetimeFromPreviousJob: j.drivetimeFromPreviousJob ?? null,
    // Computed at read time — null if no cost data available (never $0)
    netMargin:    computeNetMargin(j),
    marginPct:    computeMarginPct(j),
  };
}

function _d1BuildScheduledStatus(personJobs) {
  if (!personJobs.length) return null;
  // Jobs sorted DESC by scheduledDate.
  // Priority: (1) most-recent completed within 30 days → state='completed'
  //           (2) active scheduled job → state='scheduled'
  //           (3) most recent job of any state (dormant customer)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  // Law T1.15: active scheduled state beats recently-completed.
  // If a customer has BOTH a scheduled future job AND a recently-completed job,
  // the calendar should reflect what they're currently booked for — not what
  // they just finished. Old priority (recentCompleted first) caused c.scheduledStatus
  // to carry stale completed data even when a new job was on the books, breaking
  // print sheets and customer-list status for multi-job customers like Jessica Angellotti.
  // Skip rig-segment children — parent (isRigSegment=0, isMultiDayParent=1) is the
  // book of record and holds the correct amount + rigId=null for the whole group.
  // Without this guard, a rig-segment child (amount=0, rigId=rig_X) could become the
  // KV scheduledStatus representative, showing $0 and the wrong rig on the profile.
  //
  // Fix 1 (multi-day): also skip day-split children (parentJobId set, isRigSegment=0).
  // Previously the latest-dated child (e.g. _d3 Seal $500) would win over the parent
  // ($200), making ss.approvedAmount=$500 instead of the group total $1,000 and
  // ss.jobNotes="Seal" instead of the full service list. The parent is always the
  // representative; group total and full services are computed below.
  const activeScheduled = personJobs.find(j => j.state === 'scheduled'  && !j.isRigSegment && !j.parentJobId);
  const recentCompleted = personJobs.find(j =>
    j.state === 'completed' && j.completedAt && j.completedAt >= thirtyDaysAgo && !j.isRigSegment && !j.parentJobId
  );
  const ss = activeScheduled
           || recentCompleted
           || personJobs.find(j => j.state !== 'cancelled' && !j.isRigSegment && !j.parentJobId);
  if (!ss) return null;

  // Group total: for multi-day parents, sum all non-cancelled children's amounts.
  // For rig-split parents the full amount already lives on the parent row ($0 on children).
  // For standalone jobs this is a no-op (no children).
  // Only day-split children (isRigSegment=0) get services concatenated.
  // Rig-segment children (isRigSegment=1) carry the same servicesRaw as the parent —
  // including them would triple/quadruple the service string. Their billing ($0) is
  // already excluded from the amount sum (they contribute nothing). Fix 4 handles them.
  const _multiDayChildren = ss.isMultiDayParent
    ? personJobs.filter(c => c.parentJobId === ss.jobId && c.state !== 'cancelled' && !c.isRigSegment)
    : [];
  const _childAmtSum = _multiDayChildren.reduce((s, c) => s + (c.amount || 0), 0);
  const _groupApprovedAmt = (ss.amount || 0) + _childAmtSum;

  // Group service string: for multi-day parents, concatenate all days in dayNumber order.
  // e.g. "Pressure Clean → Sand → Seal" instead of only "Pressure Clean" (the parent's row).
  let _groupJobNotes = ss.servicesRaw || '';
  if (ss.isMultiDayParent && _multiDayChildren.length > 0) {
    const _childrenByDay = _multiDayChildren.slice().sort((a, b) => (a.dayNumber||0) - (b.dayNumber||0));
    const _allSvc = [ss.servicesRaw, ..._childrenByDay.map(c => c.dayPhase || c.servicesRaw)]
      .filter(Boolean);
    if (_allSvc.length > 1) _groupJobNotes = _allSvc.join(' → ');
  }

  return {
    state:               ss.state,
    scheduledDate:       ss.scheduledDate  || null,
    rig:                 ss.rigId          || null,
    approvedAmount:      _groupApprovedAmt,
    // Fix 5 (multi-day calendar): explicit group total for payment-warning check.
    // The per-day ss card is suppressed for multi-day parents; day_segment jh entries
    // render each day's card. The payment modal reads groupApprovedAmount so the
    // $1,000 warning fires correctly even though Day-1 card shows $200.
    groupApprovedAmount: _groupApprovedAmt,
    // Fix 5: flag so getScheduledForRig fromKv path can suppress the single merged card
    // and defer to the per-day day_segment entries in getExtraCompletedJobsForRig.
    // dayNumber != null distinguishes day-split parents (dayNumber=1) from rig-group parents
    // (dayNumber=null, isMultiDayParent=1) — rig-group parents must NOT be suppressed here.
    isMultiDayParent:    (ss.isMultiDayParent && ss.dayNumber != null) ? 1 : 0,
    jobNotes:            _groupJobNotes,
    completedAt:         ss.completedAt    || null,
    completedDate:       ss.completedAt    ? ss.completedAt.slice(0,10) : null,
    paymentStatus:       ss.paymentStatus  || 'unpaid',
    paymentMethod:       ss.paymentMethod  || null,
    paidAt:              ss.paidAt         || null,
    crew:                [],
    source:              ss.source         || null,
    window:              null,
    actualDuration:      ss.actualDuration      || null,
    actualArrival:       ss.actualArrival       || null,
    actualDeparture:     ss.actualDeparture     || null,
    durationConfidence:  ss.bouncieMatchStatus  || null,
    bouncieMatchStatus:  ss.bouncieMatchStatus  || null,
    geocodeSource:       ss.geocodeSource       || null,
    roofStories:         ss.roofStories         || null,
    crewCount:           ss.crewCount           || null,
  };
}

function _d1PersonToKv(p, props, pjobs, propById) {
  const primaryProp = props.find(pp => pp.primaryContact === 1) || props[0] || {};
  const city = primaryProp.city || '';
  const addr = primaryProp.streetAddress || '';
  const ph   = (p.primaryPhone||'').replace(/\D/g,'').slice(-10);

  // Multi-day groups: children (parentJobId IS NOT NULL) are excluded from customer-facing
  // records. Only the parent row and standalone jobs appear in jobHistory / totals.
  // The parent's "group amount" = parent.amount + all its completed children's amounts.
  // lastService: use the most recent completed date across ALL rows (including children)
  // so it reflects actual last day of work, not just the parent's scheduledDate.
  const _allCompleted  = pjobs.filter(j => j.state === 'completed');
  const lastService    = _allCompleted[0]?.scheduledDate || null; // pjobs is DESC sorted
  const completedJobs  = _allCompleted.filter(j => !j.parentJobId); // parents + standalone only
  const _groupAmt      = j => {
    if (!j.isMultiDayParent) return j.amount || 0;
    const childAmt = pjobs
      .filter(c => c.parentJobId === j.jobId && c.state === 'completed')
      .reduce((s, c) => s + (c.amount || 0), 0);
    return (j.amount || 0) + childAmt;
  };
  const lifetimeSpend  = Math.round(completedJobs.reduce((s, j) => s + _groupAmt(j), 0));
  const totalJobs      = completedJobs.length;
  const jobHistory     = completedJobs.filter(j => j.jobId).map(j => {
    const entry = _d1JobToJhEntry(j, city, addr, propById);
    if (j.isMultiDayParent) {
      // Fix 2: roll up group total AND concatenate all day-services onto the parent entry.
      // Previously only amount was summed; services came from parent.servicesRaw alone
      // (e.g. "Pressure Clean"), dropping child phases ("Sand", "Seal").
      entry.amount = _groupAmt(j);
      // Exclude rig-segment children (isRigSegment=1) — they duplicate the parent's
      // servicesRaw and are handled separately in Fix 4 (multi-rig/Bouncie).
      const _jhChildren = pjobs
        .filter(c => c.parentJobId === j.jobId && c.state !== 'cancelled' && !c.isRigSegment)
        .sort((a, b) => (a.dayNumber || 0) - (b.dayNumber || 0));
      const _jhAllSvc = [j.servicesRaw, ..._jhChildren.map(c => c.dayPhase || c.servicesRaw)]
        .filter(Boolean);
      if (_jhAllSvc.length > 1) entry.services = _jhAllSvc.join(' → ');
    }
    return entry;
  });

  // Fix 4 (multi-rig): add per-rig supplementary jh entries for rig-segment children.
  // These carry rig=rigId so getExtraCompletedJobsForRig renders the correct column.
  // amount=0 — billing lives on the parent entry only (no double-count).
  // source='rig_segment' — exclusion tag: excluded from lifetimeSpend, totalJobs, tier
  //   calculations, review queue, SMS outreach, and _d1SyncJobHistory D1 writes.
  // Stored persistently in the D1→KV read path so they survive page reloads.
  const _rigSegCompleted = pjobs.filter(j => j.state === 'completed' && j.isRigSegment && j.rigId);
  for (const seg of _rigSegCompleted) {
    jobHistory.push({
      jobId:              seg.jobId,
      date:               seg.scheduledDate || null,
      services:           '',
      amount:             0,
      rig:                seg.rigId || null,
      rigId:              seg.rigId || null,
      status:             'completed',
      completedAt:        seg.completedAt  || null,
      crew:               [],
      source:             'rig_segment',
      crewCount:          seg.crewCount    ?? null,
      // Bouncie GPS fields: present once the nightly matcher writes to this D1 row.
      // jobCardHistoryExtra reads jhEntry.actualArrival directly, so these must be
      // carried through from D1 → jh for the GPS time row to render on the card.
      actualDuration:     seg.actualDuration     || null,
      actualArrival:      seg.actualArrival       || null,
      actualDeparture:    seg.actualDeparture     || null,
      bouncieMatchStatus: seg.bouncieMatchStatus  || null,
    });
  }

  // Fix 5 (multi-day calendar): add per-day supplementary jh entries for each day-child
  // (and the parent/Day-1 row) so getExtraCompletedJobsForRig can render a completed card
  // on each day's own date with its own service label and amount slice.
  // source='day_segment' — excluded from lifetimeSpend (parent jh entry already carries the
  //   group total), totalJobs, tier calculations, and _d1SyncJobHistory D1 writes.
  // The parent primary jh entry ($1,000 group total + all services) is NOT removed — it
  //   remains canonical for job history, profile display, and outreach eligibility.
  //   The calendar rendering path suppresses the single merged completed card for
  //   multi-day parents (via ss.isMultiDayParent) and uses these per-day entries instead.
  // dayNumber != null: day-split parents only (dayNumber=1). Rig-group parents have
  // dayNumber=null and must NOT get day_segment entries — their rig_segment children
  // already handle per-rig calendar attribution.
  const _multiDayParents = completedJobs.filter(j => j.isMultiDayParent && j.dayNumber != null);
  for (const parent of _multiDayParents) {
    // All completed non-rig-segment siblings: children + parent (day 1)
    const _daySiblings = pjobs
      .filter(c => (c.jobId === parent.jobId || c.parentJobId === parent.jobId)
                && c.state === 'completed' && !c.isRigSegment)
      .sort((a, b) => (a.dayNumber || 0) - (b.dayNumber || 0));
    for (const seg of _daySiblings) {
      if (!seg.scheduledDate) continue;
      if (jobHistory.some(e => e.source === 'day_segment' && e.jobId === seg.jobId)) continue;
      jobHistory.push({
        jobId:              seg.jobId,
        date:               seg.scheduledDate,
        services:           seg.dayPhase || seg.servicesRaw || '',
        amount:             seg.amount   || 0,
        rig:                seg.rigId    || null,
        rigId:              seg.rigId    || null,
        status:             'completed',
        completedAt:        seg.completedAt || null,
        crew:               [],
        source:             'day_segment',
        dayNumber:          seg.dayNumber  ?? null,
        dayPhase:           seg.dayPhase   || null,
        crewCount:          seg.crewCount  ?? null,
        // Bouncie GPS fields: present once the nightly matcher writes to this D1 row.
        // jobCardHistoryExtra reads jhEntry.actualArrival directly, so these must be
        // carried through from D1 → jh for the GPS time row to render on each day's card.
        actualDuration:     seg.actualDuration     || null,
        actualArrival:      seg.actualArrival       || null,
        actualDeparture:    seg.actualDeparture     || null,
        bouncieMatchStatus: seg.bouncieMatchStatus  || null,
      });
    }
  }

  // Migration 0015: outcome rollups — computed from D1, never stored directly
  const tippedJobs     = completedJobs.filter(j => j.tipped);
  const isTipper       = tippedJobs.length > 0;
  const avgTipAmount   = isTipper
    ? Math.round(tippedJobs.reduce((s, j) => s + (j.tipAmount || 0), 0) / tippedJobs.length * 100) / 100
    : null;
  const complainedJobs = completedJobs.filter(j => j.complained);
  const complaintCount = complainedJobs.length;
  const complaintList  = complainedJobs.map(j => ({
    date:  j.scheduledDate,
    notes: j.complaintNotes || null,
  }));

  return {
    phone:                  ph,
    firstName:              p.firstName     || '',
    lastName:               p.lastName      || '',
    businessName:           p.businessName  || null,
    email:                  p.email         || null,
    address:                addr,
    city,
    zip:                    primaryProp.zip || null,
    notes:                  p.internalNotes || null,
    alerts:                 [],
    optOut:                 !!p.doNotContact,
    doNotService:           !!p.doNotService,
    isReferralOnly:         !!p.isReferralOnly,
    isReferralSource:       !!p.isReferralSource,
    isCommercialAccount:    !!p.isCommercialAccount,
    isHomeowner:            !!p.isHomeowner,
    preferredPaymentMethod: p.preferredPaymentMethod || null,
    totalJobs,
    lifetimeSpend,
    lastService,
    jobHistory,
    scheduledStatus:        _d1BuildScheduledStatus(pjobs),
    geocoded:               (primaryProp.latitude && primaryProp.longitude)
                              ? { lat: primaryProp.latitude, lng: primaryProp.longitude,
                                  formattedAddress: addr, geocodedAt: null,
                                  source: primaryProp.geocodeSource || null }
                              : null,
    coordinates:            (primaryProp.latitude && primaryProp.longitude)
                              ? { lat: primaryProp.latitude, lng: primaryProp.longitude,
                                  source: primaryProp.geocodeSource || null }
                              : null,
    geocodeSource:          primaryProp.geocodeSource || null,
    gateCode:               primaryProp.gateCode     || null,
    roofType:               primaryProp.roofType     || null,
    sqFt:                   primaryProp.sqft         || null,
    accessNotes:            primaryProp.accessNotes  || null,
    customerType:           p.customerType   || 'residential',
    partnerNotes:           p.partnerNotes   || null,
    bouncieMetrics:         null, // populated by computeBouncieMetrics() after construction
    reviewQueue:            null,
    quoteStatus:            null,
    neverAskReview:         false,
    createdAt:              p.createdAt || null,
    // Migration 0015: outcome rollups (computed from D1 job rows, never stored directly)
    isTipper,
    avgTipAmount,
    complaintCount,
    complaintList,
    hasComplaints: complaintCount > 0,
    // Properties list: all PersonProperty rows for this person, primary first.
    // d1CustomerToKvShape (single-customer endpoint) overwrites this with a richer
    // version that includes googlePlaceId/formattedAddress/googleVerified.
    // Both share the same shape; the bulk version omits the google-verified fields.
    properties: props
      .slice()
      .sort((a, b) => (b.primaryContact || 0) - (a.primaryContact || 0))
      .map(pp => ({
        propertyId:    pp.propertyId,
        streetAddress: pp.streetAddress  || '',
        city:          pp.city           || '',
        zip:           pp.zip            || null,
        propertyLabel: pp.propertyLabel  || null,
        propertyType:  pp.propertyType   || null,
        primaryContact: pp.primaryContact === 1 || pp.primaryContact === '1',
        gateCode:           pp.gateCode            || null,
        roofType:           pp.roofType            || null,
        sqFt:               pp.sqft                || null,
        accessNotes:        pp.accessNotes         || null,
        satelliteImageKey:  pp.satelliteImageKey   || null,  // Phase 3: R2 key
        frontImageKey:      pp.frontImageKey       || null,  // Phase 3: R2 key
      })),
  };
}

async function d1AllCustomersToKvShape(env) {
  const [persons, propLinks, jobs, reviewStates, truckDriveTimes, kvDb] = await Promise.all([
    env.DB.prepare('SELECT * FROM Person').all().then(r => r.results || []),
    env.DB.prepare(
      'SELECT pp.personId, pp.propertyId, pp.primaryContact, pp.propertyLabel, pp.propertyType,' +
      'p.streetAddress, p.city, p.state, p.zip,' +
      'p.latitude, p.longitude, p.geocodeSource, p.gateCode, p.accessNotes,' +
      'p.roofType, p.sqft,' +
      'p.satelliteImageKey, p.frontImageKey ' +             // Phase 3: property images
      'FROM PersonProperty pp JOIN Property p ON pp.propertyId=p.propertyId'
    ).all().then(r => r.results || []),
    env.DB.prepare(
      'SELECT jobId,payerId,propertyId,scheduledDate,state,completedAt,amount,' +
      'paymentMethod,paymentStatus,paidAt,servicesRaw,rigId,source,' +
      'actualDuration,actualArrival,actualDeparture,bouncieMatchStatus,bouncieMatchConfidence,geocodeSource,' +
      'workSiteAddress,workSiteCity,crewCount,' +
      'roofStories,roofType,' +
      'tipped,tipAmount,complained,complaintNotes,' +
      'gasCost,chemicalCost,laborCost,equipmentCost,otherCost,' +
      'drivetimeFromPreviousJob,milesFromPreviousJob,' +
      'parentJobId,isMultiDayParent,isRigSegment,' +
      'dayNumber,dayPhase ' +
      'FROM Job ORDER BY scheduledDate DESC'
    ).all().then(r => r.results || []),
    env.DATA.get('review_states', 'json').then(d => d || {}),
    // TruckEvent drive times per job — empty until first backfill runs, .catch() = table not yet migrated
    env.DB.prepare(
      `SELECT te.jobId,` +
      `(SELECT CAST(durationSeconds/60 AS INTEGER) FROM TruckEvent t2` +
      ` WHERE t2.rigId=te.rigId AND t2.eventType='drive' AND t2.endedAt<=te.startedAt` +
      ` ORDER BY t2.endedAt DESC LIMIT 1) AS driveInMinutes,` +
      `(SELECT CAST(durationSeconds/60 AS INTEGER) FROM TruckEvent t3` +
      ` WHERE t3.rigId=te.rigId AND t3.eventType='drive' AND t3.startedAt>=te.endedAt` +
      ` ORDER BY t3.startedAt ASC LIMIT 1) AS driveOutMinutes` +
      ` FROM TruckEvent te WHERE te.eventType='job_arrival' AND te.jobId IS NOT NULL`
    ).all().then(r => r.results || []).catch(() => []),
    // TEMP KV bridge: alternateContacts + altPhone live in KV only (no D1 column yet).
    // Remove this fetch once Person.alternateContactsJson column is added.
    env.DATA.get('customer_db', 'json').then(d => d || { customers: [] }),
  ]);

  // Index by personId + propertyId
  const propsByPerson = {};
  const propById = {};
  for (const pp of propLinks) {
    if (!propsByPerson[pp.personId]) propsByPerson[pp.personId] = [];
    propsByPerson[pp.personId].push(pp);
    if (pp.propertyId) propById[pp.propertyId] = pp;
  }
  const jobsByPayer = {};
  for (const j of jobs) {
    if (!jobsByPayer[j.payerId]) jobsByPayer[j.payerId] = [];
    jobsByPayer[j.payerId].push(j);
  }

  // TEMP KV bridge: build phone → {alternateContacts, altPhone} lookup
  const _ph10 = p => (p||'').replace(/\D/g,'').slice(-10);
  const kvAltMap = new Map();
  for (const kc of (kvDb.customers || [])) {
    const kph = _ph10(kc.phone);
    if (kph && (kc.alternateContacts || kc.altPhone)) {
      kvAltMap.set(kph, { alternateContacts: kc.alternateContacts || null, altPhone: kc.altPhone || null });
    }
  }

  // TruckEvent drive-time lookup: jobId → { driveInMinutes, driveOutMinutes }
  const driveTimeByJobId = new Map();
  for (const dt of truckDriveTimes) {
    if (dt.jobId) driveTimeByJobId.set(dt.jobId, dt);
  }

  const customers = [];
  for (const p of persons) {
    const ph = (p.primaryPhone||'').replace(/\D/g,'').slice(-10);
    if (!ph || ph.length !== 10) continue; // skip REFERRAL_* + no-phone records
    const pjobs = jobsByPayer[p.personId] || [];
    const customer = _d1PersonToKv(p, propsByPerson[p.personId] || [], pjobs, propById);
    computeBouncieMetrics(customer);
    computeWorkerHoursStats(customer);
    customer.googleReview = reviewStates[ph] || null;
    // Attach TruckEvent drive times to jh entries (additive — empty until first backfill runs)
    if (driveTimeByJobId.size > 0) {
      for (const jh of (customer.jobHistory || [])) {
        const dt = driveTimeByJobId.get(jh.jobId);
        if (dt) {
          if (dt.driveInMinutes  != null) jh.driveInMinutes  = dt.driveInMinutes;
          if (dt.driveOutMinutes != null) jh.driveOutMinutes = dt.driveOutMinutes;
        }
      }
    }
    // TEMP KV bridge: merge alternateContacts + altPhone from KV if present
    const kvAlt = kvAltMap.get(ph);
    if (kvAlt) {
      if (kvAlt.alternateContacts) customer.alternateContacts = kvAlt.alternateContacts;
      if (kvAlt.altPhone) customer.altPhone = kvAlt.altPhone;
    }
    // Phase 2C: virtual fan-out retired. Each Person produces ONE customer object.
    // Multi-property calendar display is now driven by GET /admin/calendar-jobs (Phase 2A).
    customers.push(customer);
  }
  return { customers };
}

async function d1CustomerToKvShape(phone, env) {
  const ph = (phone||'').replace(/\D/g,'').slice(-10);
  if (!ph || ph.length !== 10) return null;
  const personId = _d1PersonId(ph);

  const [personRow, propLinks, pjobs, truckDriveTimes] = await Promise.all([
    env.DB.prepare('SELECT * FROM Person WHERE primaryPhone=?').bind('+1'+ph).first(),
    env.DB.prepare(
      'SELECT pp.propertyId, pp.primaryContact, pp.propertyLabel, pp.propertyType, p.streetAddress, p.city, p.state, p.zip,' +
      'p.latitude, p.longitude, p.geocodeSource, p.gateCode, p.accessNotes,' +
      'p.googlePlaceId, p.formattedAddress, p.googleVerified,' +
      'p.roofType, p.sqft,' +
      'p.satelliteImageKey, p.frontImageKey ' +             // Phase 3: property images
      'FROM PersonProperty pp JOIN Property p ON pp.propertyId=p.propertyId WHERE pp.personId=?'
    ).bind(personId).all().then(r => r.results || []),
    env.DB.prepare(
      'SELECT jobId,payerId,propertyId,scheduledDate,state,completedAt,amount,' +
      'paymentMethod,paymentStatus,paidAt,servicesRaw,rigId,source,' +
      'actualDuration,actualArrival,actualDeparture,bouncieMatchStatus,bouncieMatchConfidence,geocodeSource,' +
      'workSiteAddress,workSiteCity,crewCount,' +
      'roofStories,roofType,' +
      'tipped,tipAmount,complained,complaintNotes,' +
      'gasCost,chemicalCost,laborCost,equipmentCost,otherCost,' +
      'drivetimeFromPreviousJob,milesFromPreviousJob,' +
      'parentJobId,isMultiDayParent,isRigSegment,' +
      'dayNumber,dayPhase ' +
      'FROM Job WHERE payerId=? ORDER BY scheduledDate DESC'
    ).bind(personId).all().then(r => r.results || []),
    // TruckEvent drive times scoped to this person's jobs
    env.DB.prepare(
      `SELECT te.jobId,` +
      `(SELECT CAST(durationSeconds/60 AS INTEGER) FROM TruckEvent t2` +
      ` WHERE t2.rigId=te.rigId AND t2.eventType='drive' AND t2.endedAt<=te.startedAt` +
      ` ORDER BY t2.endedAt DESC LIMIT 1) AS driveInMinutes,` +
      `(SELECT CAST(durationSeconds/60 AS INTEGER) FROM TruckEvent t3` +
      ` WHERE t3.rigId=te.rigId AND t3.eventType='drive' AND t3.startedAt>=te.endedAt` +
      ` ORDER BY t3.startedAt ASC LIMIT 1) AS driveOutMinutes` +
      ` FROM TruckEvent te WHERE te.eventType='job_arrival' AND te.jobId IS NOT NULL` +
      ` AND te.jobId IN (SELECT jobId FROM Job WHERE payerId=?)`
    ).bind(personId).all().then(r => r.results || []).catch(() => []),
  ]);

  if (!personRow) return null;
  const singlePropById = {};
  for (const pp of propLinks) { if (pp.propertyId) singlePropById[pp.propertyId] = pp; }
  const customer = _d1PersonToKv(personRow, propLinks, pjobs, singlePropById);
  computeBouncieMetrics(customer);
  computeWorkerHoursStats(customer);
  const reviewStates = await env.DATA.get('review_states', 'json').then(d => d || {});
  customer.googleReview = reviewStates[ph] || null;
  // Attach TruckEvent drive times to jh entries (additive — empty until first backfill runs)
  if (truckDriveTimes.length > 0) {
    const driveTimeByJobId = new Map(truckDriveTimes.map(dt => [dt.jobId, dt]));
    for (const jh of (customer.jobHistory || [])) {
      const dt = driveTimeByJobId.get(jh.jobId);
      if (dt) {
        if (dt.driveInMinutes  != null) jh.driveInMinutes  = dt.driveInMinutes;
        if (dt.driveOutMinutes != null) jh.driveOutMinutes = dt.driveOutMinutes;
      }
    }
  }
  // Expose all linked properties so multi-property picker UI can list them.
  customer.properties = propLinks.map(pp => ({
    propertyId:       pp.propertyId,
    streetAddress:    pp.streetAddress    || '',
    city:             pp.city             || '',
    zip:              pp.zip              || null,
    propertyLabel:    pp.propertyLabel    || null,
    propertyType:     pp.propertyType     || null,
    primaryContact:   pp.primaryContact === 1 || pp.primaryContact === '1',
    gateCode:         pp.gateCode         || null,
    roofType:         pp.roofType         || null,
    sqFt:             pp.sqft             || null,
    accessNotes:      pp.accessNotes      || null,
    googlePlaceId:     pp.googlePlaceId    || null,
    formattedAddress:  pp.formattedAddress || null,
    googleVerified:    pp.googleVerified   === 1 || pp.googleVerified === '1',
    satelliteImageKey: pp.satelliteImageKey || null,  // Phase 3: R2 key
    frontImageKey:     pp.frontImageKey     || null,  // Phase 3: R2 key
  }));
  // TEMP KV bridge: merge alternateContacts + altPhone from KV (no D1 column yet).
  // Remove once Person.alternateContactsJson column is added.
  const kvDbSingle = await env.DATA.get('customer_db', 'json').then(d => d || { customers: [] });
  const kvC = (kvDbSingle.customers || []).find(c => (c.phone||'').replace(/\D/g,'').slice(-10) === ph);
  if (kvC) {
    if (kvC.alternateContacts) customer.alternateContacts = kvC.alternateContacts;
    if (kvC.altPhone)          customer.altPhone          = kvC.altPhone;
  }
  return customer;
}

// ── Phase 3: KV ↔ D1 reconciliation ──────────────────────────────────────────
async function handleReconcileKvD1(env, corsHeaders) {
  const norm = p => (p||'').replace(/\D/g,'').slice(-10);

  // Read KV + D1 in parallel
  const [kvDb, d1Persons, d1Jobs, d1Props] = await Promise.all([
    env.DATA.get(KV_KEYS.customers, 'json').then(d => d || { customers: [] }),
    env.DB.prepare('SELECT personId, primaryPhone, firstName, lastName FROM Person').all().then(r => r.results || []),
    env.DB.prepare('SELECT jobId, payerId, propertyId, scheduledDate, state, completedAt, amount, paymentMethod, paymentStatus, paidAt FROM Job').all().then(r => r.results || []),
    env.DB.prepare('SELECT propertyId, streetAddress, city FROM Property').all().then(r => r.results || []),
  ]);

  const kvCustomers = (kvDb.customers || []).filter(c => c && !c.deleted);

  // Index D1 data by phone / personId
  const d1PersonByPhone = new Map(); // 10-digit → person row
  for (const p of d1Persons) {
    const ph = (p.primaryPhone||'').replace(/\D/g,'').slice(-10);
    if (ph) d1PersonByPhone.set(ph, p);
  }
  const d1JobsByPayer = new Map(); // personId → [job, ...]
  for (const j of d1Jobs) {
    if (!d1JobsByPayer.has(j.payerId)) d1JobsByPayer.set(j.payerId, []);
    d1JobsByPayer.get(j.payerId).push(j);
  }
  const propById = new Map(); // propertyId → {streetAddress, city}
  for (const p of d1Props) { if (p.propertyId) propById.set(p.propertyId, p); }

  const discrepancies = [];
  const typeCounts = {};
  let checked = 0, missingPerson = 0, jobDiscrepancies = 0;

  const addDisc = (phone, name, type, field, kvVal, d1Val, action) => {
    discrepancies.push({ phone, name, type, field, kvValue: kvVal, d1Value: d1Val, suggested_action: action });
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    jobDiscrepancies++;
  };

  for (const c of kvCustomers) {
    const ph = norm(c.phone);
    if (!ph) continue;
    checked++;
    const name = `${c.firstName||''} ${c.lastName||''}`.trim();
    const d1p = d1PersonByPhone.get(ph);

    // ── Missing Person ──────────────────────────────────────────────────────
    if (!d1p) {
      missingPerson++;
      addDisc(ph, name, 'MISSING_PERSON', 'Person', 'exists', 'missing', 'INSERT Person+Property+PersonProperty');
      continue;
    }

    // ── Person field drift ──────────────────────────────────────────────────
    if ((c.firstName||'').trim() !== (d1p.firstName||'').trim()) {
      addDisc(ph, name, 'PERSON_NAME_DRIFT', 'firstName', c.firstName, d1p.firstName, 'UPDATE Person SET firstName');
    }
    if ((c.lastName||'').trim() !== (d1p.lastName||'').trim()) {
      addDisc(ph, name, 'PERSON_NAME_DRIFT', 'lastName', c.lastName, d1p.lastName, 'UPDATE Person SET lastName');
    }

    // ── Job reconciliation ──────────────────────────────────────────────────
    const personId = d1p.personId;
    const d1Jobs4p = d1JobsByPayer.get(personId) || [];
    const d1JobById = new Map(d1Jobs4p.map(j => [j.jobId, j]));
    const d1JobByDate = new Map(d1Jobs4p.map(j => [j.scheduledDate, j]));

    // Check KV jobHistory entries against D1
    for (const jh of (c.jobHistory || [])) {
      if (jh.source === 'csv_backfill') continue; // pre-Day-1 history — expected gaps
      if (!jh.jobId) continue;
      const d1j = d1JobById.get(jh.jobId);

      if (!d1j) {
        addDisc(ph, name, 'MISSING_JOB', 'Job.jobId', jh.jobId, 'missing',
          `INSERT Job (date=${jh.date} amount=${jh.amount} source=${jh.source})`);
        continue;
      }
      // State match
      if (d1j.state !== 'completed') {
        addDisc(ph, name, 'JOB_STATE_MISMATCH', 'Job.state', 'completed', d1j.state,
          `UPDATE Job SET state='completed' WHERE jobId='${jh.jobId}'`);
      }
      // Amount match (within $1 rounding)
      if (Math.abs((d1j.amount||0) - (jh.amount||0)) > 1) {
        addDisc(ph, name, 'JOB_AMOUNT_MISMATCH', 'Job.amount', jh.amount, d1j.amount,
          `UPDATE Job SET amount=${jh.amount} WHERE jobId='${jh.jobId}'`);
      }
      // Payment status
      const kvPaid = !!(jh.paidAt || jh.paymentMethod);
      const d1Paid = d1j.paymentStatus === 'paid';
      if (kvPaid && !d1Paid) {
        addDisc(ph, name, 'PAYMENT_DRIFT', 'Job.paymentStatus', 'paid', d1j.paymentStatus,
          `UPDATE Job SET paymentStatus='paid', paidAt='${jh.paidAt||''}' WHERE jobId='${jh.jobId}'`);
      }
      // Gate 1: JOB_ADDRESS_DRIFT — jh address vs D1 Property address via Job.propertyId
      // Catches Seeber-class bugs where _d1JobToJhEntry uses wrong property address.
      if (d1j.propertyId && jh.address) {
        const d1Prop = propById.get(d1j.propertyId);
        if (d1Prop) {
          const normA = s => (s||'').toLowerCase().trim().replace(/\s+/g,' ');
          if (normA(d1Prop.streetAddress) !== normA(jh.address) || normA(d1Prop.city) !== normA(jh.city)) {
            addDisc(ph, name, 'JOB_ADDRESS_DRIFT', 'jh.address',
              `${jh.address}, ${jh.city}`,
              `${d1Prop.streetAddress}, ${d1Prop.city}`,
              `check _d1JobToJhEntry propById lookup for jobId=${jh.jobId}`);
          }
        }
      }
    }

    // Check scheduledStatus against D1 — only active scheduled/in_progress jobs
    const ss = c.scheduledStatus;
    if (ss && ss.state === 'scheduled' && ss.scheduledDate) {
      // Look for the scheduled job in D1 by date (since ss jobs may not have a stable jobId)
      const ssJobId = _d1ScheduledJobId(personId, ss.scheduledDate);
      const d1ssj = d1JobById.get(ssJobId) || d1JobByDate.get(ss.scheduledDate);
      if (!d1ssj) {
        addDisc(ph, name, 'MISSING_SCHEDULED_JOB', 'Job(scheduled)',
          `scheduled:${ss.scheduledDate}:$${ss.approvedAmount||0}`, 'missing',
          `INSERT Job (state=scheduled, date=${ss.scheduledDate})`);
      }
    }

    // D1 scheduled jobs that are no longer active in KV (cancelled/reverted/completed since Day 1)
    for (const d1j of d1Jobs4p) {
      if (d1j.state !== 'scheduled') continue;
      // If KV has completed this date in jobHistory, D1 should be 'completed'
      const kvCompleted = (c.jobHistory||[]).some(jh =>
        jh.source !== 'csv_backfill' && jh.date === d1j.scheduledDate && jh.status === 'completed'
      );
      if (kvCompleted) {
        addDisc(ph, name, 'STALE_SCHEDULED', 'Job.state',
          `completed (jh date=${d1j.scheduledDate})`, `scheduled (d1 jobId=${d1j.jobId})`,
          `UPDATE Job SET state='completed' WHERE jobId='${d1j.jobId}'`);
      }
      // Gate 3: STALE_SCHEDULED_DATE_MISMATCH — KV considers job completed but D1 still has a
      // scheduled row with a DIFFERENT date (Tim Page pattern: late completion creates date drift).
      // STALE_SCHEDULED misses this because jh.date ≠ d1j.scheduledDate.
      const kvCompletedOnAnyDate = ss && ss.state === 'completed' && !kvCompleted;
      if (kvCompletedOnAnyDate) {
        addDisc(ph, name, 'STALE_SCHEDULED_DATE_MISMATCH', 'Job.scheduledDate',
          `kv:completed:${ss.scheduledDate}`, `d1:scheduled:${d1j.scheduledDate} (${d1j.jobId})`,
          `UPDATE Job SET state='completed' WHERE jobId='${d1j.jobId}'`);
      }
    }
  }

  // Gate 2: DUPLICATE_SCHEDULED_JOB — same payerId+scheduledDate+propertyId with cnt>1.
  // Catches Janille-class phantoms created when _d1SyncJobHistory inserts a second row
  // under a different jobId format for the same real job.
  const dupRows = await env.DB.prepare(
    `SELECT j.payerId, j.scheduledDate, j.propertyId, j.state, COUNT(*) AS cnt,
            p.firstName, p.lastName, p.primaryPhone
     FROM Job j JOIN Person p ON p.personId = j.payerId
     WHERE j.state IN ('scheduled','in_progress')
     GROUP BY j.payerId, j.scheduledDate, j.propertyId, j.state
     HAVING cnt > 1`
  ).all().then(r => r.results || []).catch(() => []);
  for (const dup of dupRows) {
    const dupPh = (dup.primaryPhone||'').replace(/\D/g,'').slice(-10);
    const dupName = `${dup.firstName||''} ${dup.lastName||''}`.trim();
    discrepancies.push({
      phone: dupPh, name: dupName,
      type: 'DUPLICATE_SCHEDULED_JOB',
      field: 'Job(payerId+scheduledDate+propertyId)',
      kvValue: `${dup.cnt} rows`,
      d1Value: `payerId=${dup.payerId} date=${dup.scheduledDate} prop=${dup.propertyId}`,
      suggested_action: `DELETE extra Job rows WHERE payerId='${dup.payerId}' AND scheduledDate='${dup.scheduledDate}' AND propertyId='${dup.propertyId}' AND state='${dup.state}'`,
    });
    typeCounts['DUPLICATE_SCHEDULED_JOB'] = (typeCounts['DUPLICATE_SCHEDULED_JOB'] || 0) + 1;
  }

  // Gate: PARTNER_MISSING_WORKSITE — partner jobs with no workSiteAddress
  const partnerNoSite = await env.DB.prepare(
    `SELECT j.jobId, j.scheduledDate, j.payerId, p.firstName, p.lastName, p.primaryPhone
     FROM Job j JOIN Person p ON p.personId = j.payerId
     WHERE j.state IN ('scheduled','in_progress')
       AND p.customerType = 'partner_referral'
       AND (j.workSiteAddress IS NULL OR j.workSiteAddress = '')`
  ).all().then(r => r.results || []).catch(() => []);
  for (const row of partnerNoSite) {
    const rowPh = (row.primaryPhone||'').replace(/\D/g,'').slice(-10);
    const rowName = `${row.firstName||''} ${row.lastName||''}`.trim();
    discrepancies.push({
      phone: rowPh, name: rowName,
      type: 'PARTNER_MISSING_WORKSITE',
      field: 'Job.workSiteAddress',
      kvValue: 'partner_referral',
      d1Value: `null (jobId=${row.jobId} date=${row.scheduledDate})`,
      suggested_action: `PATCH /admin/job/${row.jobId} with workSiteAddress`,
    });
    typeCounts['PARTNER_MISSING_WORKSITE'] = (typeCounts['PARTNER_MISSING_WORKSITE'] || 0) + 1;
  }

  // Gate: PROPERTY_MISSING_LABEL — multi-property PersonProperty rows with no label
  // Single-property customers can have NULL label; multi-property MUST be labeled to distinguish.
  try {
    const unlabeled = await env.DB.prepare(
      `SELECT pp.personId, pp.propertyId, prop.streetAddress, prop.city,
              p.firstName, p.lastName, p.primaryPhone,
              (SELECT COUNT(*) FROM PersonProperty pp2 WHERE pp2.personId=pp.personId) AS propCount
       FROM PersonProperty pp
       JOIN Person p ON p.personId = pp.personId
       JOIN Property prop ON prop.propertyId = pp.propertyId
       WHERE (pp.propertyLabel IS NULL OR pp.propertyLabel = '')
         AND (SELECT COUNT(*) FROM PersonProperty pp2 WHERE pp2.personId=pp.personId) > 1`
    ).all().then(r => r.results || []);
    for (const row of unlabeled) {
      const rowPh   = (row.primaryPhone||'').replace(/\D/g,'').slice(-10);
      const rowName = `${row.firstName||''} ${row.lastName||''}`.trim();
      discrepancies.push({
        phone: rowPh, name: rowName,
        type: 'PROPERTY_MISSING_LABEL',
        field: 'PersonProperty.propertyLabel',
        kvValue: `${row.propCount} properties`,
        d1Value: `${row.streetAddress}, ${row.city} (propertyId=${row.propertyId})`,
        suggested_action: `UPDATE PersonProperty SET propertyLabel='Main Residence' WHERE personId='${row.personId}' AND propertyId='${row.propertyId}'`,
      });
      typeCounts['PROPERTY_MISSING_LABEL'] = (typeCounts['PROPERTY_MISSING_LABEL'] || 0) + 1;
    }
  } catch(e) { /* non-critical */ }

  // Gate: TRUCKEVENT_ORPHAN — TruckEvent.jobId references non-existent Job
  try {
    const orphans = await env.DB.prepare(
      `SELECT te.id, te.rigId, te.jobId, te.startedAt
       FROM TruckEvent te
       WHERE te.jobId IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM Job j WHERE j.jobId = te.jobId)`
    ).all().then(r => r.results || []);
    for (const o of orphans) {
      discrepancies.push({
        phone: null, name: `TruckEvent ${o.id}`,
        type: 'TRUCKEVENT_ORPHAN',
        field: 'TruckEvent.jobId',
        kvValue: o.jobId,
        d1Value: 'missing from Job table',
        suggested_action: `DELETE FROM TruckEvent WHERE id='${o.id}' OR re-link to correct jobId`,
      });
      typeCounts['TRUCKEVENT_ORPHAN'] = (typeCounts['TRUCKEVENT_ORPHAN'] || 0) + 1;
    }
  } catch(e) { /* TruckEvent table not yet migrated — skip */ }

  // Gate: TRUCKEVENT_DUPLICATE — same bouncieTripId appearing more than once
  try {
    const dupTrips = await env.DB.prepare(
      `SELECT bouncieTripId, COUNT(*) AS cnt
       FROM TruckEvent
       WHERE bouncieTripId IS NOT NULL
       GROUP BY bouncieTripId
       HAVING cnt > 1`
    ).all().then(r => r.results || []);
    for (const d of dupTrips) {
      discrepancies.push({
        phone: null, name: `TruckEvent bouncieTripId=${d.bouncieTripId}`,
        type: 'TRUCKEVENT_DUPLICATE',
        field: 'TruckEvent.bouncieTripId',
        kvValue: `${d.cnt} rows`,
        d1Value: d.bouncieTripId,
        suggested_action: `DELETE extra TruckEvent rows WHERE bouncieTripId='${d.bouncieTripId}' (keep oldest createdAt)`,
      });
      typeCounts['TRUCKEVENT_DUPLICATE'] = (typeCounts['TRUCKEVENT_DUPLICATE'] || 0) + 1;
    }
  } catch(e) { /* TruckEvent table not yet migrated — skip */ }

  // Gate: PROPERTY_NOT_GOOGLE_VERIFIED — free-typed or legacy addresses lacking place_id
  // These are candidates for canonicalize-all migration.
  try {
    const unverified = await env.DB.prepare(
      `SELECT propertyId, streetAddress, city FROM Property WHERE googleVerified=0 OR googleVerified IS NULL`
    ).all().then(r => r.results || []);
    for (const p of unverified) {
      discrepancies.push({
        phone: null, name: `Property ${p.propertyId}`,
        type: 'PROPERTY_NOT_GOOGLE_VERIFIED',
        field: 'Property.googleVerified',
        kvValue: '0 (unverified)',
        d1Value: p.propertyId,
        suggested_action: `Run POST /admin/properties/canonicalize-all to fetch place_id for: ${[p.streetAddress, p.city].filter(Boolean).join(', ')}`,
      });
      typeCounts['PROPERTY_NOT_GOOGLE_VERIFIED'] = (typeCounts['PROPERTY_NOT_GOOGLE_VERIFIED'] || 0) + 1;
    }
  } catch(e) { /* googleVerified column not yet migrated — skip */ }

  // Gate: DUPLICATE_PROPERTY_BY_PLACE_ID — two Property rows share same googlePlaceId.
  // Should be zero after canonicalize-all dedup phase. Catches any regression.
  try {
    const dupPlaces = await env.DB.prepare(
      `SELECT googlePlaceId, COUNT(*) AS cnt FROM Property
       WHERE googlePlaceId IS NOT NULL GROUP BY googlePlaceId HAVING cnt > 1`
    ).all().then(r => r.results || []);
    for (const d of dupPlaces) {
      discrepancies.push({
        phone: null, name: `googlePlaceId=${d.googlePlaceId}`,
        type: 'DUPLICATE_PROPERTY_BY_PLACE_ID',
        field: 'Property.googlePlaceId',
        kvValue: `${d.cnt} rows`,
        d1Value: d.googlePlaceId,
        suggested_action: `Run POST /admin/properties/canonicalize-all {phase:"dedup"} to merge these rows`,
      });
      typeCounts['DUPLICATE_PROPERTY_BY_PLACE_ID'] = (typeCounts['DUPLICATE_PROPERTY_BY_PLACE_ID'] || 0) + 1;
    }
  } catch(e) { /* googlePlaceId index not yet migrated — skip */ }

  // ── Gate: KV_ONLY_SCHEDULED_JOB (Law T1.18) ──────────────────────────────────
  // KV customer has scheduledStatus.state='scheduled' with a future date but no
  // matching D1 Job row. Root cause: submitScheduleNow wrote KV-only; D1 write missing.
  // Fix: POST /admin/scheduled-job after saveDb(). This gate prevents future silent gaps.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const kvDb  = await env.DATA.get('customer_db', 'json').then(d => d || { customers: [] });
    const d1ScheduledJobIds = new Set(
      (await env.DB.prepare(
        `SELECT jobId FROM Job WHERE state='scheduled' AND scheduledDate >= ?`
      ).bind(today).all().then(r => r.results || [])).map(j => j.jobId)
    );
    // Build the deterministic jobId each KV-scheduled customer would have
    for (const c of (kvDb.customers || [])) {
      const ss = c.scheduledStatus || {};
      if (ss.state !== 'scheduled' || !ss.scheduledDate || ss.scheduledDate < today) continue;
      const ph       = (c.phone || '').replace(/\D/g, '').slice(-10);
      const personId = `person_1${ph}`;
      const expectedJobId = `job_${personId}_${ss.scheduledDate}_scheduled`;
      if (!d1ScheduledJobIds.has(expectedJobId)) {
        discrepancies.push({
          phone: c.phone, name: `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          type: 'KV_ONLY_SCHEDULED_JOB',
          field: 'scheduledStatus.state',
          kvValue:  `scheduled/${ss.scheduledDate}/$${ss.approvedAmount}`,
          d1Value:  'no matching Job row',
          suggested_action: `POST /admin/scheduled-job with payerId=${personId} scheduledDate=${ss.scheduledDate} amount=${ss.approvedAmount}`,
        });
        typeCounts['KV_ONLY_SCHEDULED_JOB'] = (typeCounts['KV_ONLY_SCHEDULED_JOB'] || 0) + 1;
      }
    }
  } catch(e) { /* skip — KV read failure is non-fatal */ }

  // ── Gate: D1_ONLY_SCHEDULED_JOB (Law T1.18) ──────────────────────────────────
  // D1 has a future-scheduled Job row but the corresponding KV customer shows no
  // matching scheduledStatus. Calendar is authoritative (D1); this is informational.
  // Common cause: calendar-side rescheduling updates D1 directly, KV catches up async.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const kvDb  = await env.DATA.get('customer_db', 'json').then(d => d || { customers: [] });
    const kvScheduledByPerson = new Map();
    for (const c of (kvDb.customers || [])) {
      const ss  = c.scheduledStatus || {};
      const ph  = (c.phone || '').replace(/\D/g, '').slice(-10);
      if (ss.state === 'scheduled' && ss.scheduledDate >= today) {
        kvScheduledByPerson.set(`person_1${ph}`, ss.scheduledDate);
      }
    }
    const d1Future = await env.DB.prepare(
      `SELECT j.jobId, j.payerId, j.scheduledDate, j.amount, p.firstName, p.lastName
       FROM Job j JOIN Person p ON p.personId=j.payerId
       WHERE j.state='scheduled' AND j.scheduledDate >= ?`
    ).bind(today).all().then(r => r.results || []);
    for (const j of d1Future) {
      const kvDate = kvScheduledByPerson.get(j.payerId);
      if (!kvDate || kvDate !== j.scheduledDate) {
        discrepancies.push({
          phone: null, name: `${j.firstName || ''} ${j.lastName || ''}`.trim(),
          type: 'D1_ONLY_SCHEDULED_JOB',
          field: 'Job.state',
          kvValue:  kvDate ? `KV shows ${kvDate}` : 'no scheduledStatus',
          d1Value:  `D1 has ${j.scheduledDate} $${j.amount} jobId=${j.jobId}`,
          suggested_action: 'Informational — calendar (D1) is authoritative. KV will reconcile on next saveDb.',
        });
        typeCounts['D1_ONLY_SCHEDULED_JOB'] = (typeCounts['D1_ONLY_SCHEDULED_JOB'] || 0) + 1;
      }
    }
  } catch(e) { /* skip — non-fatal */ }

  // ── Gate: D1_SYNC_FAILURES_LAST_24H ──────────────────────────────────────────
  // Counts entries in d1_sync_failures KV key from the last 24 hours.
  // Catches transient D1 errors (internal error, UNIQUE constraint, etc.) that
  // silently swallow writes. Count > 0 means at least one write needs investigation.
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const failures = await env.DATA.get('d1_sync_failures', 'json') || [];
    const recent   = failures.filter(f => (f.ts || '') > cutoff);
    if (recent.length > 0) {
      discrepancies.push({
        phone: null,
        name:  `${recent.length} D1 sync failure(s) in last 24h`,
        type:  'D1_SYNC_FAILURES_LAST_24H',
        field: 'd1_sync_failures KV key',
        kvValue: `${recent.length} recent entries`,
        d1Value: recent.slice(0, 5).map(f => `[${(f.ts||'').slice(11,19)}] ${f.context}: ${(f.error||'').slice(0,60)}`).join(' | '),
        suggested_action: 'Review d1_sync_failures KV key. Each entry is a silently-swallowed D1 write. Recover any missing jobs via POST /admin/scheduled-job.',
      });
      typeCounts['D1_SYNC_FAILURES_LAST_24H'] = recent.length;
    }
  } catch(e) { /* skip — non-fatal */ }

  // ── Gate: WORKSITE_NOT_GOOGLE_VERIFIED (Law T1.17) ───────────────────────────
  // Partner jobs where the work site address was typed manually (no place_id).
  // Mostly historical entries pre-T1.17. New entries via autocomplete set
  // workSiteGoogleVerified=1. Count > 0 is informational — not actionable for
  // historical jobs, but should not grow after this gate was added.
  try {
    const unverified = await env.DB.prepare(
      `SELECT j.jobId, j.payerId, j.scheduledDate, j.workSiteAddress, j.workSiteCity,
              p.firstName, p.lastName
       FROM Job j
       JOIN Person p ON p.personId = j.payerId
       WHERE (j.workSiteAddress IS NOT NULL AND j.workSiteAddress != '')
         AND (j.workSitePlaceId IS NULL OR j.workSitePlaceId = '')
       ORDER BY j.scheduledDate DESC LIMIT 20`
    ).all().then(r => r.results || []);
    if (unverified.length > 0) {
      discrepancies.push({
        phone: null,
        name:  `${unverified.length} partner job(s) with unverified work site`,
        type:  'WORKSITE_NOT_GOOGLE_VERIFIED',
        field: 'Job.workSitePlaceId',
        kvValue: `${unverified.length} jobs without place_id`,
        d1Value: unverified.slice(0, 5).map(j => `${j.firstName} ${j.lastName}: ${j.workSiteAddress||''}, ${j.workSiteCity||''} (${j.scheduledDate})`).join(' | '),
        suggested_action: 'Historical entries — no action needed. New jobs entered via partner autocomplete will have workSiteGoogleVerified=1.',
      });
      typeCounts['WORKSITE_NOT_GOOGLE_VERIFIED'] = unverified.length;
    }
  } catch(e) { /* skip — non-fatal */ }

  // ── Gate: COMPLETED_JOBS_MISSING_BOUNCIE_24H (T1.21) ─────────────────────
  // Completed jobs from yesterday that have a rigId but no actualDuration.
  // Means last night's Bouncie cron either didn't run, found no jobs, or
  // failed to match. Should be zero every morning after the matcher runs.
  // Gate starts 2026-05-28 (post-fix) — older history is pre-integration.
  // Severity: WARNING — one day's gap isn't urgent but surfaces within 24h.
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const missingBouncie = await env.DB.prepare(
      `SELECT j.jobId, j.scheduledDate, j.rigId,
              p.firstName, p.lastName, p.primaryPhone
       FROM Job j
       JOIN Person p ON p.personId = j.payerId
       WHERE j.state = 'completed'
         AND j.scheduledDate = ?
         AND j.actualDuration IS NULL
         AND j.rigId IS NOT NULL
         AND j.scheduledDate >= '2026-05-28'
       ORDER BY j.scheduledDate DESC`
    ).bind(yesterday).all().then(r => r.results || []);
    if (missingBouncie.length > 0) {
      discrepancies.push({
        phone: null,
        name:  `${missingBouncie.length} completed job(s) on ${yesterday} missing Bouncie duration`,
        type:  'COMPLETED_JOBS_MISSING_BOUNCIE_24H',
        field: 'Job.actualDuration',
        kvValue: `${missingBouncie.length} jobs with rigId, no actualDuration`,
        d1Value: missingBouncie.map(j => `${j.firstName} ${j.lastName} (${j.rigId}): ${j.jobId}`).join(' | '),
        suggested_action: `Run GET /api/bouncie/match?date=${yesterday} to trigger matcher manually. Check bouncie:last_cron_run for heartbeat status. If Bouncie token expired, visit /oauth/bouncie/start.`,
      });
      typeCounts['COMPLETED_JOBS_MISSING_BOUNCIE_24H'] = missingBouncie.length;
    }
  } catch(e) { /* skip — non-fatal */ }

  // ── Gate: BOUNCIE_MATCH_RATE_7D (T1.21) ──────────────────────────────────
  // Match rate over the last 7 days. Below 70% suggests GPS coverage issue,
  // token degradation, or rig mapping drift. Catches gradual failures that
  // single-day gates miss (e.g. one rig's IMEI stops reporting quietly).
  // Only fires when there are ≥3 completed jobs in the window to avoid
  // noise from light weeks.
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const yesterday7   = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const r7 = await env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN actualDuration IS NOT NULL THEN 1 ELSE 0 END) AS matched
       FROM Job
       WHERE state = 'completed'
         AND rigId IS NOT NULL
         AND scheduledDate >= ?
         AND scheduledDate <= ?
         AND scheduledDate >= '2026-05-28'`
    ).bind(sevenDaysAgo, yesterday7).first();
    const total7   = r7?.total   || 0;
    const matched7 = r7?.matched || 0;
    const rate7    = total7 > 0 ? matched7 / total7 : null;
    if (rate7 !== null && total7 >= 3 && rate7 < 0.7) {
      discrepancies.push({
        phone: null,
        name:  `Bouncie match rate ${Math.round(rate7 * 100)}% over last 7 days (${matched7}/${total7} jobs)`,
        type:  'BOUNCIE_MATCH_RATE_7D',
        field: 'Job.actualDuration',
        kvValue: `${matched7}/${total7} jobs matched (${Math.round(rate7 * 100)}%)`,
        d1Value: `7-day window ${sevenDaysAgo} → ${yesterday7}. Below 70% threshold.`,
        suggested_action: 'Check rig IMEI mapping (bouncie:rig_mapping KV key). Verify Bouncie keepalive is running every 4h. Low rate may mean one rig stopped reporting GPS.',
      });
      typeCounts['BOUNCIE_MATCH_RATE_7D'] = Math.round(rate7 * 100);
    }
  } catch(e) { /* skip — non-fatal */ }

  return jsonResponse({
    summary: {
      kvCustomersChecked: checked,
      d1PersonsLoaded:    d1Persons.length,
      d1JobsLoaded:       d1Jobs.length,
      missingPersons:     missingPerson,
      totalDiscrepancies: discrepancies.length,
      byType:             typeCounts,
    },
    discrepancies,
  }, corsHeaders);
}

// ── Gate 3: Multi-property audit ─────────────────────────────────────────────
// Returns all customers with >1 property + their properties + active/recent jobs.
// Pre/post-deploy diff this to catch any multi-property state drift.
async function handleMultiPropertyAudit(env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  try {
    // All persons with more than one property
    const ppRows = await env.DB.prepare(
      `SELECT pp.personId, pp.propertyId, pp.primaryContact, pp.propertyLabel,
              p.firstName, p.lastName, p.primaryPhone,
              prop.streetAddress, prop.city
       FROM PersonProperty pp
       JOIN Person p ON p.personId = pp.personId
       LEFT JOIN Property prop ON prop.propertyId = pp.propertyId
       ORDER BY pp.personId, pp.primaryContact DESC`
    ).all().then(r => r.results || []);

    // Group by personId
    const byPerson = new Map();
    for (const row of ppRows) {
      if (!byPerson.has(row.personId)) {
        byPerson.set(row.personId, {
          personId: row.personId,
          name: `${row.firstName||''} ${row.lastName||''}`.trim(),
          phone: (row.primaryPhone||'').replace(/\D/g,'').slice(-10),
          properties: [],
        });
      }
      byPerson.get(row.personId).properties.push({
        propertyId: row.propertyId,
        streetAddress: row.streetAddress,
        city: row.city,
        primaryContact: row.primaryContact,
        propertyLabel: row.propertyLabel,
      });
    }

    // Filter to multi-property only
    const multiPropPersonIds = [...byPerson.values()]
      .filter(p => p.properties.length > 1)
      .map(p => p.personId);

    if (!multiPropPersonIds.length) {
      return jsonResponse({ multiPropertyCustomers: [], totalMultiPropertyCount: 0 }, corsHeaders);
    }

    // Active + recent completed jobs for each multi-property person
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const jobRows = await env.DB.prepare(
      `SELECT jobId, payerId, scheduledDate, state, rigId, amount, propertyId, completedAt
       FROM Job
       WHERE payerId IN (${multiPropPersonIds.map(() => '?').join(',')})
         AND (state IN ('scheduled','in_progress')
              OR (state = 'completed' AND scheduledDate >= ?))
       ORDER BY payerId, scheduledDate DESC`
    ).bind(...multiPropPersonIds, thirtyDaysAgo).all().then(r => r.results || []);

    const jobsByPayer = new Map();
    for (const j of jobRows) {
      if (!jobsByPayer.has(j.payerId)) jobsByPayer.set(j.payerId, []);
      jobsByPayer.get(j.payerId).push(j);
    }

    const result = multiPropPersonIds.map(pid => {
      const p = byPerson.get(pid);
      return { ...p, propertyCount: p.properties.length, activeJobs: jobsByPayer.get(pid) || [] };
    }).sort((a, b) => b.propertyCount - a.propertyCount);

    return jsonResponse({
      multiPropertyCustomers: result,
      totalMultiPropertyCount: result.length,
    }, corsHeaders);
  } catch (e) {
    return jsonResponse({ error: 'D1 query failed', detail: e.message }, corsHeaders, 500);
  }
}

// ── Part C: JOB_PROPERTY_AMBIGUOUS diagnostic ────────────────────────────────
// GET /admin/diagnostics/property-audit
// Returns open residential jobs where workSiteAddress is set but differs from the
// bound Property.streetAddress — the Oscar-signature mismatch.
// partner_referral is explicitly excluded: their billing/workSite split is by design.
// ─────────────────────────────────────────────────────────────────────────────

async function handlePropertyAudit(env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  try {
    const { results } = await env.DB.prepare(`
      SELECT
        j.jobId,
        j.payerId,
        j.scheduledDate,
        j.state,
        j.workSiteAddress,
        j.workSiteCity,
        p.streetAddress  AS boundAddr,
        p.city           AS boundCity,
        per.firstName,
        per.lastName,
        per.primaryPhone,
        per.customerType
      FROM Job j
      JOIN Property p   ON j.propertyId  = p.propertyId
      JOIN Person per   ON j.payerId     = per.personId
      WHERE j.state         IN ('scheduled','in_progress')
        AND per.customerType != 'partner_referral'
        AND j.workSiteAddress IS NOT NULL
        AND j.workSiteAddress != ''
        AND LOWER(TRIM(j.workSiteAddress)) != LOWER(TRIM(p.streetAddress))
      ORDER BY j.scheduledDate
    `).all();

    return jsonResponse({
      auditedAt: new Date().toISOString(),
      mismatches: results || [],
      mismatchCount: (results || []).length,
      note: 'Jobs where workSiteAddress differs from bound Property.streetAddress. Excludes partner_referral (mismatch is by design). Fix via PATCH /admin/job/:id {propertyId}.',
    }, corsHeaders);
  } catch(e) {
    return jsonResponse({ error: 'D1 query failed', detail: e.message }, corsHeaders, 500);
  }
}

// ── Phase 2A: D1-native calendar endpoints ────────────────────────────────────

async function handleCalendarJobs(request, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  const url       = new URL(request.url);
  const weekStart = url.searchParams.get('weekStart');
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart))
    return jsonResponse({ error: 'weekStart required (YYYY-MM-DD)' }, corsHeaders, 400);

  const weekEnd = new Date(weekStart + 'T12:00:00Z');
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);

  try {
    const { results } = await env.DB.prepare(`
      SELECT
        j.jobId,
        j.payerId,
        j.propertyId,
        j.scheduledDate,
        j.scheduledTimeWindow,
        j.state,
        j.amount,
        j.rigId,
        j.servicesRaw,
        j.jobNotes,
        j.actualDuration,
        j.actualArrival,
        j.actualDeparture,
        j.bouncieMatchStatus,
        j.isMultiBuildingJob,
        j.workSiteAddress,
        j.workSiteCity,
        j.workSiteZip,
        j.workSitePlaceId,
        j.workSiteGoogleVerified,
        j.endCustomerName,
        j.endCustomerPhone,
        j.roofStories,
        j.partnerRate,
        j.crewCount,
        p.firstName,
        p.lastName,
        p.primaryPhone,
        p.email,
        p.customerType,
        prop.streetAddress,
        prop.city,
        prop.state AS propertyState,
        prop.zip,
        prop.latitude,
        prop.longitude,
        prop.gateCode,
        prop.accessNotes,
        prop.sqft,
        prop.roofType AS propRoofType,
        prop.satelliteImageKey,                      -- Phase 3: property images
        prop.frontImageKey,                          -- Phase 3: property images
        pp.propertyLabel,
        pp.propertyType,
        pp.primaryContact,
        j.isMultiDayParent,
        j.parentJobId,
        j.dayNumber,
        j.totalDays,
        j.dayPhase,
        j.isRigSegment
      FROM Job j
      JOIN Person p ON p.personId = j.payerId
      LEFT JOIN Property prop ON prop.propertyId = j.propertyId
      LEFT JOIN PersonProperty pp
        ON pp.personId = j.payerId AND pp.propertyId = j.propertyId
      WHERE j.state = 'scheduled'
        AND j.scheduledDate >= ?
        AND j.scheduledDate < ?
      ORDER BY j.scheduledDate, j.rigId, j.scheduledTimeWindow
    `).bind(weekStart, weekEndStr).all();

    return jsonResponse({ weekStart, weekEnd: weekEndStr, jobs: results || [] }, corsHeaders);
  } catch (e) {
    await _logD1Failure(env, 'handleCalendarJobs', e.message);
    return jsonResponse({ error: 'D1 query failed', detail: e.message }, corsHeaders, 500);
  }
}

// ── GET /admin/monthly-breakdown ─────────────────────────────────────────────
// Returns one row per job-group for the given month. Group amount is computed
// in SQL because the multi-day parent's Job.amount carries only Day 1's slice
// (verified: Jessica's parent = $200, sum-with-children = $1,000). Rig-group
// parent.amount is the full billing (Carlos = $1,200, segments are $0) — the
// same formula works for both because rig_segment children are excluded from
// the sum.
//
// Business date convention: scheduledDate ONLY. It is already an ET YYYY-MM-DD
// business date with no time component, so the month bucket is timezone-safe by
// design. Alternative (UTC completedAt converted via -4 hours) was DST-correct
// during Mar-Nov but off by 1 hour during EST, putting jobs completed 11 PM-12 AM
// ET on the last day of the month into the next month (T1.8 class issue).
// scheduledDate also aligns with how the calendar buckets jobs (by scheduledDate),
// so the monthly view = "what was on the calendar for this month" — Mom's mental model.
// Trade-off: a job rescheduled across a month boundary is bucketed by its FINAL
// scheduledDate, not its completion date. Acceptable — that matches the calendar.
//
// Partner-aware address: COALESCE(j.workSiteAddress, prop.streetAddress). After
// the Step-2 partner model fix, prop.streetAddress IS the worksite for partners,
// so this matches the client-side _partnerAddr helper for new + repaired partner
// jobs. Legacy partner jobs (csv_backfill, pre-repair) get covered by the
// workSiteAddress backup field when present.
async function handleMonthlyBreakdown(request, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  const url   = new URL(request.url);
  const month = url.searchParams.get('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month))
    return jsonResponse({ error: 'month required (YYYY-MM)' }, corsHeaders, 400);

  try {
    const { results } = await env.DB.prepare(`
      SELECT
        j.jobId,
        j.scheduledDate,
        j.completedAt,
        j.state,
        j.amount AS rawAmount,
        j.servicesRaw,
        j.jobNotes,
        j.paymentStatus,
        j.paymentMethod,
        j.paidAt,
        j.workSiteAddress,
        j.workSiteCity,
        j.rigId,
        j.isMultiDayParent,
        -- Group amount: parent.amount + sum(non-rig-segment non-cancelled children).
        -- For standalone jobs and rig-group parents: sum is 0 → equals j.amount.
        -- For multi-day parents (Jessica): rolls up day-children → returns group total.
        (j.amount + COALESCE((
          SELECT SUM(c.amount) FROM Job c
          WHERE c.parentJobId = j.jobId
            AND c.state != 'cancelled'
            AND c.isRigSegment = 0
        ), 0)) AS groupAmount,
        -- Business date = scheduledDate. Timezone-safe (no time component), matches
        -- how the calendar buckets jobs, eliminates DST math. See header comment.
        j.scheduledDate AS businessDate,
        p.firstName,
        p.lastName,
        p.primaryPhone,
        p.customerType,
        prop.streetAddress AS propStreetAddress,
        prop.city          AS propCity
      FROM Job j
      JOIN Person p ON p.personId = j.payerId
      LEFT JOIN Property prop ON prop.propertyId = j.propertyId
      WHERE j.state IN ('completed', 'scheduled', 'in_progress')
        AND j.isRigSegment = 0
        AND j.parentJobId IS NULL
        AND substr(j.scheduledDate, 1, 7) = ?
      ORDER BY j.scheduledDate, j.jobId
    `).bind(month).all();

    // Server-side _partnerAddr equivalent: per-job workSiteAddress first, then
    // Property.streetAddress (post-Step-2 IS the worksite for partner jobs).
    const rows = (results || []).map(r => {
      const customerName = [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || 'Unknown';
      const address      = r.workSiteAddress || r.propStreetAddress || '';
      const city         = r.workSiteCity    || r.propCity          || '';
      return {
        jobId:          r.jobId,
        date:           r.businessDate,                              // YYYY-MM-DD
        customerName,
        phone:          (r.primaryPhone || '').replace(/\D/g, '').slice(-10),
        customerType:   r.customerType || 'residential',
        state:          r.state,
        services:       (r.servicesRaw || r.jobNotes || '').slice(0, 240),
        amount:         Number(r.groupAmount) || 0,
        paymentStatus:  r.paymentStatus || null,                     // 'paid' | 'unpaid' | null
        paymentMethod:  r.paymentMethod || null,
        paidAt:         r.paidAt        || null,
        address,
        city,
        isMultiDayParent: !!r.isMultiDayParent,
      };
    });

    const totalRevenue = rows.reduce((s, r) => s + (r.amount || 0), 0);
    const paidCount    = rows.filter(r => r.paymentStatus === 'paid').length;
    const unpaidCount  = rows.length - paidCount;

    return jsonResponse({
      month,
      rowCount:     rows.length,
      totalRevenue,
      paidCount,
      unpaidCount,
      rows,
    }, corsHeaders);
  } catch(e) {
    await _logD1Failure(env, 'handleMonthlyBreakdown', e.message);
    return jsonResponse({ error: 'D1 query failed', detail: e.message }, corsHeaders, 500);
  }
}

// ── Invoice helpers ─────────────────────────────────────────────────────────
const _PRINT_CO      = 'Pure Cleaning Pressure Cleaning, LLC';
const _PRINT_PHONE   = '954-389-2642';
const _PRINT_WEBSITE = 'purecleaningpressurecleaning.com';
const _PRINT_SINCE   = '1995';

// Server-side _partnerAddr equivalent. Mirrors the client helper used since Batch 1.
function _invoiceServiceAddress(job, prop) {
  return {
    address: job.workSiteAddress || prop?.streetAddress || '',
    city:    job.workSiteCity    || prop?.city          || '',
    zip:     job.workSiteZip     || prop?.zip           || '',
  };
}

// One-row-per-job-group amount: parent + non-rig non-cancelled children, same formula
// as monthly-breakdown. Returns null for non-parent jobs (caller uses j.amount directly).
async function _invoiceGroupAmount(env, job) {
  if (!job.isMultiDayParent) return Number(job.amount || 0);
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM(c.amount), 0) AS childSum
     FROM Job c
     WHERE c.parentJobId = ? AND c.state != 'cancelled' AND c.isRigSegment = 0`
  ).bind(job.jobId).first();
  return Number(job.amount || 0) + Number(r?.childSum || 0);
}

// POST /admin/invoice/from-job  { jobId } → idempotent invoice creation.
// Multi-day parents get one LineItem per non-rig child + parent (Day 1) row.
// Rig-group parents (Carlos) get a single line — billing is on the parent, rigs are
// attribution-only with $0 amounts that would clutter the invoice.
// Address: workSite-first via _invoiceServiceAddress (residential + commercial + partner).
// Bill-to varies by sector: partners → company; commercial → businessName + contact; residential → person.
async function handleInvoiceFromJob(request, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  const body = await request.json().catch(() => null);
  if (!body || !body.jobId) return jsonResponse({ error: 'jobId required' }, corsHeaders, 400);
  const jobId = body.jobId;

  // Load job + person + bound property
  const job = await env.DB.prepare(
    `SELECT j.*, prop.streetAddress AS propStreet, prop.city AS propCity, prop.zip AS propZip,
            p.firstName, p.lastName, p.businessName, p.customerType, p.email, p.primaryPhone,
            p.billingNotes
     FROM Job j
     JOIN Person p ON p.personId = j.payerId
     LEFT JOIN Property prop ON prop.propertyId = j.propertyId
     WHERE j.jobId = ?`
  ).bind(jobId).first();
  if (!job) return jsonResponse({ error: 'job not found', jobId }, corsHeaders, 404);

  // Rule 12 guard: synthetic historicals are NEVER invoiceable. Excluding csv_backfill
  // and any backfill_* source kills the counter-pollution risk permanently and keeps
  // invoices tied only to real deliverable work.
  const _src = String(job.source || '');
  if (_src === 'csv_backfill' || _src.startsWith('backfill_')) {
    return jsonResponse({
      error: 'historical_record_not_invoiceable',
      message: 'historical record — not invoiceable',
      detail: `Job source='${_src}'. Synthetic historical records (csv_backfill, backfill_*) are excluded from invoice generation per DL-04 / Rule 12.`,
    }, corsHeaders, 422);
  }

  // Idempotency: scan existing Invoice rows for one that already references this jobId.
  // jobIds is JSON text like ["jobId1","jobId2"]; we use INSTR rather than LIKE because
  // SQLite errors on "LIKE pattern too complex" when underscores in jobIds need escaping.
  // INSTR has no wildcard semantics — pure substring match — and the JSON quotes around
  // the jobId guarantee uniqueness (no jobId is a substring of another quoted jobId).
  const existing = await env.DB.prepare(
    `SELECT invoiceId FROM Invoice WHERE INSTR(jobIds, ?) > 0 LIMIT 1`
  ).bind(`"${jobId}"`).first();
  if (existing) {
    const url = `https://purecleaningpressurecleaning.com/pure_cleaning_invoice.html?id=${encodeURIComponent(existing.invoiceId)}`;
    // Re-fetch the invoice's number for the response (idempotent caller convenience)
    const meta = await env.DB.prepare(
      `SELECT invoiceId, sector, status, total, paymentTerms, sentAt FROM Invoice WHERE invoiceId = ?`
    ).bind(existing.invoiceId).first();
    return jsonResponse({
      success:    true,
      idempotent: true,
      invoiceId:  existing.invoiceId,
      invoiceNumber: meta?.invoiceId.split('-').slice(-3).join('-') ? meta.invoiceId : existing.invoiceId,
      sector:     meta?.sector,
      status:     meta?.status,
      total:      meta?.total,
      url,
    }, corsHeaders);
  }

  // Sector + status
  const isCommercial = job.customerType === 'commercial' || !!job.isCommercialJob;
  const isPartner    = job.customerType === 'partner_referral';
  const sector       = isCommercial ? 'commercial' : 'residential';

  const paid       = job.paymentStatus === 'paid';
  const status     = paid ? 'paid' : 'sent';
  const paidAt     = job.paidAt || null;
  const paymentMethod = job.paymentMethod || null;
  const paymentTerms  = paid ? null : (job.billingNotes || 'Payment due upon receipt.');

  // Atomic counter increment via ON CONFLICT UPDATE (per migration 0016 docstring)
  const year      = new Date().getFullYear();
  const counterId = `${sector}-invoice-${year}`;
  const counterRow = await env.DB.prepare(
    `INSERT INTO DocumentCounter (counterId, sector, docType, year, lastSeq)
     VALUES (?, ?, 'invoice', ?, 1)
     ON CONFLICT(sector, docType, year) DO UPDATE SET lastSeq = lastSeq + 1
     RETURNING lastSeq`
  ).bind(counterId, sector, year).first();
  const seq           = counterRow?.lastSeq || 1;
  const sectorTag     = sector === 'commercial' ? 'COM' : 'RES';
  const invoiceNumber = `INV-${sectorTag}-${year}-${String(seq).padStart(4, '0')}`;
  const invoiceId     = invoiceNumber;

  // Resolve total
  const total = await _invoiceGroupAmount(env, job);

  // Line items: multi-day expands into one row per non-rig child + parent (Day 1 row)
  const lineItems = [];
  if (job.isMultiDayParent && job.dayNumber != null) {
    const { results: days } = await env.DB.prepare(
      `SELECT jobId, scheduledDate, amount, dayPhase, dayNumber, servicesRaw
       FROM Job
       WHERE (jobId = ? OR parentJobId = ?)
         AND state != 'cancelled' AND isRigSegment = 0
       ORDER BY dayNumber`
    ).bind(jobId, jobId).all();
    for (const d of (days || [])) {
      lineItems.push({
        description: `Day ${d.dayNumber || '?'} — ${d.dayPhase || d.servicesRaw || 'Service'}`,
        quantity:    1,
        unit:        null,
        unitPrice:   Number(d.amount || 0),
        lineTotal:   Number(d.amount || 0),
      });
    }
  } else {
    // Standalone OR rig-group parent (Carlos) — single line item from servicesRaw
    lineItems.push({
      description: (job.servicesRaw || job.jobNotes || 'Pressure cleaning services').slice(0, 220),
      quantity:    1,
      unit:        null,
      unitPrice:   Number(job.amount || 0),
      lineTotal:   Number(total),  // total reflects rig-group parent.amount (segments are $0)
    });
  }

  const now      = new Date().toISOString();
  const today    = now.slice(0, 10);
  const jobIdsJson = JSON.stringify([jobId]);

  // Atomic-ish insert: invoice row first, then line items. Failure of line items leaves an
  // orphan Invoice row — acceptable here (no money double-counted, just an empty invoice;
  // next call's idempotency returns it intact).
  await env.DB.prepare(
    `INSERT INTO Invoice
       (invoiceId, personId, sector, status, invoiceDate, subtotal, total, amountPaid,
        paymentTerms, paymentMethod, paidAt, sentAt, jobIds, createdAt, modifiedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    invoiceId, job.payerId, sector, status, today,
    total, total, paid ? total : 0,
    paymentTerms, paymentMethod, paidAt, now, jobIdsJson, now, now
  ).run();

  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];
    await env.DB.prepare(
      `INSERT INTO LineItem (lineItemId, documentType, documentId, sortOrder,
                             description, quantity, unit, unitPrice, lineTotal, createdAt)
       VALUES (?, 'invoice', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `${invoiceId}-LI-${i + 1}`, invoiceId, i,
      li.description, li.quantity, li.unit, li.unitPrice, li.lineTotal, now
    ).run();
  }

  const url = `https://purecleaningpressurecleaning.com/pure_cleaning_invoice.html?id=${encodeURIComponent(invoiceId)}`;
  return jsonResponse({
    success:        true,
    idempotent:     false,
    invoiceId,
    invoiceNumber,
    sector,
    status,
    total,
    isPartner,
    url,
  }, corsHeaders);
}

// GET /invoice/{invoiceId} — public, scoped, rate-limited. Returns ONLY the render
// data for one invoice. Never exposes personId / jobIds / internal notes.
// Tracks viewedAt on first view.
async function handleGetInvoicePublic(env, invoiceId, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  const inv = await env.DB.prepare(
    `SELECT i.invoiceId, i.sector, i.status, i.invoiceDate, i.subtotal, i.total,
            i.amountPaid, i.paymentTerms, i.paymentMethod, i.paidAt, i.sentAt, i.viewedAt,
            i.jobIds,
            p.firstName, p.lastName, p.businessName, p.customerType, p.primaryPhone
     FROM Invoice i
     JOIN Person p ON p.personId = i.personId
     WHERE i.invoiceId = ?`
  ).bind(invoiceId).first();
  if (!inv) return jsonResponse({ error: 'not found' }, corsHeaders, 404);

  // First-view tracking
  if (!inv.viewedAt) {
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        `UPDATE Invoice SET viewedAt = ?, modifiedAt = ? WHERE invoiceId = ?`
      ).bind(now, now, invoiceId).run();
    } catch(_) { /* non-fatal */ }
  }

  // Line items
  const { results: lis } = await env.DB.prepare(
    `SELECT description, quantity, unit, unitPrice, lineTotal
     FROM LineItem
     WHERE documentType = 'invoice' AND documentId = ?
     ORDER BY sortOrder`
  ).bind(invoiceId).all();

  // Service address: resolved from first referenced jobId (jobIds[0])
  let serviceAddress = { address: '', city: '', zip: '' };
  try {
    const jobIds = JSON.parse(inv.jobIds || '[]');
    if (jobIds[0]) {
      const jobRow = await env.DB.prepare(
        `SELECT j.workSiteAddress, j.workSiteCity, j.workSiteZip,
                prop.streetAddress, prop.city, prop.zip
         FROM Job j
         LEFT JOIN Property prop ON prop.propertyId = j.propertyId
         WHERE j.jobId = ?`
      ).bind(jobIds[0]).first();
      if (jobRow) {
        serviceAddress = {
          address: jobRow.workSiteAddress || jobRow.streetAddress || '',
          city:    jobRow.workSiteCity    || jobRow.city          || '',
          zip:     jobRow.workSiteZip     || jobRow.zip           || '',
        };
      }
    }
  } catch(_) {}

  const isCommercial = inv.customerType === 'commercial';
  const isPartner    = inv.customerType === 'partner_referral';
  const customerName = [inv.firstName, inv.lastName].filter(Boolean).join(' ').trim() || 'Customer';

  return jsonResponse({
    invoiceId:     inv.invoiceId,
    invoiceNumber: inv.invoiceId,
    sector:        inv.sector,
    status:        inv.status,
    invoiceDate:   inv.invoiceDate,
    billTo: {
      companyName:  inv.businessName || null,
      contactName:  customerName,
      isPartner,
      isCommercial,
      phone:        (inv.primaryPhone || '').replace(/\D/g, '').slice(-10),
    },
    serviceAddress,
    lineItems: (lis || []).map(li => ({
      description: li.description,
      quantity:    Number(li.quantity || 1),
      unit:        li.unit,
      unitPrice:   Number(li.unitPrice || 0),
      lineTotal:   Number(li.lineTotal || 0),
    })),
    subtotal:      Number(inv.subtotal || 0),
    total:         Number(inv.total    || 0),
    amountPaid:    Number(inv.amountPaid || 0),
    paymentMethod: inv.paymentMethod || null,
    paidAt:        inv.paidAt        || null,
    paymentTerms:  inv.paymentTerms  || null,
    paidInFull:    inv.status === 'paid',
    brand: {
      coName:  _PRINT_CO,
      phone:   _PRINT_PHONE,
      website: _PRINT_WEBSITE,
      since:   _PRINT_SINCE,
    },
  }, corsHeaders);
}

async function handleCreatePartner(request, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object')
    return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  const { firstName, lastName, businessName, phone, email, partnerNotes } = body;
  if (!phone) return jsonResponse({ error: 'phone required' }, corsHeaders, 400);
  const ph = (phone||'').replace(/\D/g,'').slice(-10);
  if (!ph || ph.length !== 10) return jsonResponse({ error: 'invalid phone' }, corsHeaders, 400);

  const now      = new Date().toISOString();
  const personId = _d1PersonId(ph);
  const e164     = '+1' + ph;

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO Person (personId,firstName,lastName,businessName,primaryPhone,email,customerType,partnerNotes,isHomeowner,doNotContact,createdAt,modifiedAt,migratedFrom,migrationVersion,migratedAt,migrationConfidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(personId, firstName||'', lastName||'', businessName||null, e164, email||null,
           'partner_referral', partnerNotes||null, 0, 0,
           now, now, 'admin_partner_create', 'v4_partner', now, 'high').run();

    // Also write to KV customer_db so GET /customers includes the partner
    const db = await env.DATA.get('customer_db', 'json') || { customers: [] };
    const exists = (db.customers||[]).some(c => (c.phone||'').replace(/\D/g,'').slice(-10) === ph);
    if (!exists) {
      db.customers.push({
        phone: ph,
        firstName: firstName||'',
        lastName:  lastName||'',
        businessName: businessName||null,
        email:    email||null,
        address:  '',
        city:     '',
        zip:      null,
        notes:    null,
        alerts:   [],
        optOut:   false,
        doNotService: false,
        isReferralOnly: false,
        isReferralSource: false,
        isCommercialAccount: false,
        isHomeowner: false,
        preferredPaymentMethod: null,
        customerType: 'partner_referral',
        partnerNotes: partnerNotes||null,
        totalJobs:    0,
        lifetimeSpend: 0,
        lastService:  null,
        jobHistory:   [],
        scheduledStatus: null,
        geocoded:    null,
        coordinates: null,
        geocodeSource: null,
        bouncieMetrics: null,
        reviewQueue: null,
        quoteStatus: null,
        neverAskReview: false,
        createdAt: now,
      });
      await env.DATA.put('customer_db', JSON.stringify(db));
    }

    return jsonResponse({ success: true, personId, phone: ph }, corsHeaders);
  } catch (e) {
    await _logD1Failure(env, 'handleCreatePartner', e.message);
    return jsonResponse({ error: 'Failed to create partner', detail: e.message }, corsHeaders, 500);
  }
}

// ── POST /admin/scheduled-job ─────────────────────────────────────────────────
// Law T1.18: CREATE paths dual-write KV + D1.
// Called by submitScheduleNow() immediately after saveDb() (KV write).
// Also used for kv_backfill recovery when KV-only jobs are detected.
//
// Required body fields: payerId, propertyId, scheduledDate, amount, servicesRequested
// Optional: rigId, jobNotes, servicesRaw, workSiteAddress, workSiteCity,
//           workSiteZip, workSitePlaceId, workSiteGoogleVerified,
//           endCustomerName, endCustomerPhone, source, roofStories, crewCount,
//           serviceTags (structured JSON array from quote_builder_v2 — used for servicesRequested)

// ── _parseServiceTags — flat service string → canonical tag array (T1.22, Part 1c) ──
// Called at worker layer for Mom's new_customer path (flat string arrives, no serviceTags body).
// Also used as fallback when quote_builder_v2 doesn't supply serviceTags.
// Safe: unrecognised tokens are silently omitted; all-fail → null (never break, never guess).
// ADDITIVE: servicesRaw / jobNotes are NEVER touched.
function _parseServiceTags(flatStr) {
  if (!flatStr || typeof flatStr !== 'string') return null;
  const PATTERNS = [
    { pat:/softwash|soft.?wash/i,                tag:{ type:'roof', method:'softwash' } },
    { pat:/roof.*traditional|traditional.*roof/i, tag:{ type:'roof', method:'traditional' } },
    { pat:/roof.*water.?only|water.?only.*roof/i, tag:{ type:'roof', method:'water_only' } },
    { pat:/\broof\b/i,                            tag:{ type:'roof' } },
    { pat:/driveway/i,                            tag:{ type:'driveway' } },
    { pat:/\bpatio\b/i,                           tag:{ type:'patio' } },
    { pat:/pool.?deck/i,                          tag:{ type:'pool_deck' } },
    { pat:/sidewalk|walkway/i,                    tag:{ type:'sidewalk' } },
    { pat:/rinse.wall|rinse.window|rinse.front/i, tag:{ type:'rinse_walls' } },
    { pat:/\brinse\b/i,                           tag:{ type:'rinse_walls' } },
    { pat:/entranceway|entrance\b/i,              tag:{ type:'entranceway' } },
    { pat:/screen.enclos/i,                       tag:{ type:'screen_enclosure' } },
    { pat:/\bbalcony\b/i,                         tag:{ type:'balcony' } },
    { pat:/fence.*wood|wood.*fence/i,             tag:{ type:'fence', material:'wood' } },
    { pat:/fence.*vinyl|vinyl.*fence/i,           tag:{ type:'fence', material:'vinyl' } },
    { pat:/fence.*metal|metal.*fence/i,           tag:{ type:'fence', material:'metal' } },
    { pat:/\bfence\b/i,                           tag:{ type:'fence' } },
    { pat:/\bdeck\b/i,                            tag:{ type:'deck' } },
    { pat:/\bseal/i,                              tag:{ type:'sealing' } },
    { pat:/\brust\b/i,                            tag:{ type:'rust' } },
    { pat:/\bgutter\b/i,                          tag:{ type:'gutter' } },
    { pat:/prep.paint|paint.prep/i,               tag:{ type:'prep_painting' } },
  ];
  const tokens = flatStr.split(/[,/\n·•]+/).map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  const tags = [];
  for (const tok of tokens) {
    for (const { pat, tag } of PATTERNS) {
      if (pat.test(tok)) {
        if (!seen.has(tag.type)) { seen.add(tag.type); tags.push({ ...tag }); }
        break;
      }
    }
  }
  return tags.length > 0 ? tags : null;
}

async function handleCreateScheduledJob(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  const {
    payerId, propertyId, scheduledDate, amount,
    servicesRequested, servicesRaw, jobNotes,
    rigId, workSiteAddress, workSiteCity, workSiteZip,
    workSitePlaceId, workSiteGoogleVerified,
    endCustomerName, endCustomerPhone,
    source, roofStories, crewCount, sqFt, roofType,
    serviceTags,  // structured array from quote_builder_v2 (Part 1b, T1.22)
    parentJobId, dayNumber, totalDays, dayPhase, isMultiDayParent,
  } = body;

  // Part 1b/1c: servicesRequested → JSON array.
  // Precedence: explicit serviceTags (quote builder) > parse flat string (Mom's path) > flat string fallback.
  // servicesRaw is NEVER modified — it keeps the human-readable string for all display consumers.
  const _svcTagsVal = (() => {
    if (Array.isArray(serviceTags) && serviceTags.length > 0) return JSON.stringify(serviceTags);
    const parsed = _parseServiceTags(servicesRaw || servicesRequested);
    if (parsed) return JSON.stringify(parsed);
    return servicesRequested || servicesRaw || null;  // last-resort flat-string fallback
  })();

  if (!payerId)           return jsonResponse({ error: 'payerId required' }, corsHeaders, 400);
  if (!propertyId)        return jsonResponse({ error: 'propertyId required' }, corsHeaders, 400);
  if (!scheduledDate)     return jsonResponse({ error: 'scheduledDate required' }, corsHeaders, 400);
  if (amount == null)     return jsonResponse({ error: 'amount required' }, corsHeaders, 400);
  if (!servicesRequested) return jsonResponse({ error: 'servicesRequested required' }, corsHeaders, 400);

  // Deterministic jobId: payerId + date. For same-payer same-day DIFFERENT-property jobs
  // (multi-property customers), suffix _p2, _p3 etc. to avoid INSERT OR REPLACE collision.
  // Same property = legitimate re-submit → base jobId + INSERT OR REPLACE (existing behaviour).
  const baseJobId = `job_${payerId}_${scheduledDate}_scheduled`;
  const now       = new Date().toISOString();
  const src       = source || 'new_customer_form';

  let jobId = baseJobId;
  try {
    const existing = await env.DB.prepare(
      'SELECT propertyId FROM Job WHERE jobId=?'
    ).bind(baseJobId).first();
    if (existing && existing.propertyId !== propertyId) {
      // Different property on same payer+date — find next free suffix
      let suffix = 2;
      while (true) {
        const candidate = `${baseJobId}_p${suffix}`;
        const taken = await env.DB.prepare(
          'SELECT jobId FROM Job WHERE jobId=?'
        ).bind(candidate).first();
        if (!taken) { jobId = candidate; break; }
        suffix++;
      }
    }
    // existing && existing.propertyId === propertyId → keep baseJobId (re-submit, INSERT OR REPLACE)
    // !existing → keep baseJobId (first job, INSERT OR REPLACE)
  } catch(e) {
    // Non-fatal: if suffix check fails, fall through with baseJobId (safe, original behaviour)
    console.error('handleCreateScheduledJob:suffixCheck', e.message);
  }

  try {
    // INSERT OR REPLACE — re-submitting same payer+date+property overwrites cancelled/stale row.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO Job
         (jobId, payerId, propertyId, scheduledDate, state, amount, paymentStatus,
          servicesRequested, servicesRaw, jobNotes, rigId,
          workSiteAddress, workSiteCity, workSiteZip,
          workSitePlaceId, workSiteGoogleVerified,
          endCustomerName, endCustomerPhone, roofStories, crewCount,
          roofType,
          source, createdAt, modifiedAt,
          parentJobId, dayNumber, totalDays, dayPhase, isMultiDayParent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      jobId, payerId, propertyId, scheduledDate, 'scheduled', amount, 'pending',
      _svcTagsVal, servicesRaw || servicesRequested, jobNotes || servicesRequested,
      rigId || null,
      workSiteAddress || null, workSiteCity || null, workSiteZip || null,
      workSitePlaceId || null, workSiteGoogleVerified ? 1 : 0,
      endCustomerName || null, endCustomerPhone || null,
      roofStories || null, crewCount || null,
      roofType || null,                              // Fix 1: snapshot at job creation (T1.22)
      src, now, now,
      parentJobId || null, dayNumber || null, totalDays || null, dayPhase || null,
      isMultiDayParent ? 1 : 0
    ).run();

    // Sync sqFt and roofType to Property — best-effort, non-fatal
    if (propertyId && (sqFt != null || roofType != null)) {
      await _d1SyncPropertyUpdate(propertyId, {
        ...(sqFt     != null ? { sqft:     sqFt || null }     : {}),
        ...(roofType != null ? { roofType: roofType || null } : {}),
      }, env, now).catch(e => console.error('handleCreateScheduledJob:propSync', e.message));
    }

    await _logD1Failure(env, `handleCreateScheduledJob:${src}`,
      `created jobId=${jobId} payerId=${payerId} scheduledDate=${scheduledDate} amount=${amount}`);

    return jsonResponse({ success: true, jobId, scheduledDate, amount }, corsHeaders);
  } catch(e) {
    await _logD1Failure(env, `handleCreateScheduledJob:error:${payerId}`, e.message);
    return jsonResponse({ error: e.message }, corsHeaders, 500);
  }
}

// ── GET /admin/job/:id/days ───────────────────────────────────────────────────
// Returns all active (non-cancelled) days in a multi-day set, ordered by dayNumber.
// :id may be the root parent OR any child — rootId is resolved automatically.
// Response: { parentJobId: rootId, days: [{ jobId, scheduledDate, amount, dayPhase,
//             dayNumber, totalDays, rigId }, ...] }
async function handleGetJobDays(request, env, jobId, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  if (!jobId)  return jsonResponse({ error: 'jobId required' }, corsHeaders, 400);

  const rootRow = await env.DB.prepare(
    'SELECT COALESCE(parentJobId, jobId) AS rootId FROM Job WHERE jobId=?'
  ).bind(jobId).first();
  if (!rootRow) return jsonResponse({ error: 'job not found' }, corsHeaders, 404);
  const rootId = rootRow.rootId;

  const { results } = await env.DB.prepare(`
    SELECT jobId, scheduledDate, amount, dayPhase, dayNumber, totalDays, rigId, servicesRaw,
           crewCount, isRigSegment
    FROM Job
    WHERE (jobId=? OR parentJobId=?)
      AND state != 'cancelled'
    ORDER BY dayNumber
  `).bind(rootId, rootId).all();

  return jsonResponse({ parentJobId: rootId, days: results || [] }, corsHeaders);
}

// ── POST /admin/job/:id/complete-group ────────────────────────────────────────
// Atomically completes every non-cancelled member of a multi-day/multi-rig group.
// :id may be the root parent OR any child — rootId resolved via COALESCE.
// Body mirrors PATCH /admin/job fields (state/completedAt/roofStories/crewCount/payment).
// Response: { isGroup:true, rootId, completedJobIds:[...] }
//       OR: { isGroup:false }  when only one member found (caller falls back to normal PATCH).
async function handleCompleteJobGroup(request, env, jobId, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  if (!jobId)  return jsonResponse({ error: 'jobId required' }, corsHeaders, 400);

  const body = await request.json().catch(() => ({}));
  const now  = new Date().toISOString();

  // 1. Resolve root (same logic as handleGetJobDays)
  const rootRow = await env.DB.prepare(
    'SELECT COALESCE(parentJobId, jobId) AS rootId FROM Job WHERE jobId=?'
  ).bind(jobId).first();
  if (!rootRow) return jsonResponse({ error: 'job not found' }, corsHeaders, 404);
  const rootId = rootRow.rootId;

  // 2. Fetch all non-cancelled group members
  const { results: members } = await env.DB.prepare(
    'SELECT jobId, payerId, state FROM Job WHERE (jobId=? OR parentJobId=?) AND state != \'cancelled\' ORDER BY dayNumber'
  ).bind(rootId, rootId).all();
  if (!members || members.length === 0)
    return jsonResponse({ error: 'no active members found' }, corsHeaders, 404);

  // Standalone: let caller use normal PATCH
  if (members.length === 1)
    return jsonResponse({ isGroup: false }, corsHeaders);

  // 3. Build cascade fields — ONLY state/time/payment.
  // FIX 4: roofStories, roofType, crewCount are intentionally excluded — each child
  // keeps its own per-row labor data captured at creation/edit time. Completing the
  // group must not overwrite rig-specific crew counts or roof details.
  const completedAt = body.completedAt || now;
  const fields = { state: 'completed', completedAt, modifiedAt: now };
  if (body.paymentStatus === 'paid') {
    fields.paymentStatus = 'paid';
    fields.paymentMethod = body.paymentMethod || null;
    fields.paidAt        = body.paidAt || now;
  }

  // 4. Atomically complete all members via D1 batch — all rows flip or none do.
  // FIX 3: env.DB.batch() is atomic; throws on any failure so the client catch(e)
  // shows the error toast. Never swallows a partial-completion failure.
  const sets = Object.keys(fields).map(k => `${k}=?`);
  const vals = Object.values(fields);
  const sql  = `UPDATE Job SET ${sets.join(', ')} WHERE jobId=? AND state != 'cancelled'`;

  const stmts = members.map(m => env.DB.prepare(sql).bind(...vals, m.jobId));
  await env.DB.batch(stmts); // throws → propagates → client shows toast; no partial state
  const completedIds = members.map(m => m.jobId);

  // 5. KV rebuild: the client's saveDb() call will overwrite this with the authoritative
  //    KV blob (including the single jobHistory entry it created). This rebuild is a
  //    belt-and-suspenders sync in case saveDb() fails — it will reflect the group as
  //    completed even if the client write never lands.
  const payerId = members[0]?.payerId;
  if (payerId?.startsWith('person_1')) {
    const ph = payerId.slice('person_1'.length);
    if (ph.length === 10) {
      try {
        const updatedCustomer = await d1CustomerToKvShape(ph, env);
        if (updatedCustomer) {
          const kvDb = await env.DATA.get('customer_db', 'json') || { customers: [] };
          const idx  = (kvDb.customers||[]).findIndex(c =>
            (c.phone||'').replace(/\D/g,'').slice(-10) === ph
          );
          if (idx >= 0) kvDb.customers[idx] = updatedCustomer;
          else           kvDb.customers.push(updatedCustomer);
          await env.DATA.put('customer_db', JSON.stringify(kvDb));
        }
      } catch(e) {
        await _logD1Failure(env, `handleCompleteJobGroup:kvRebuild:${payerId}`, e.message).catch(() => {});
      }
    }
  }

  return jsonResponse({ isGroup: true, rootId, completedJobIds: completedIds }, corsHeaders);
}

// ── POST /admin/job/split ─────────────────────────────────────────────────────
// Creates OR reconciles a multi-day job set. UI sends complete desired state;
// worker makes D1 match exactly.
// Body: { parentJobId, days: [{ scheduledDate, amount, dayPhase, rigId? }, ...] }
//
// parentJobId may be the root parent OR any child — rootId resolved automatically.
//
// days.length === 1  → un-split: reset parent to standalone, cancel all children
// days.length >= 2   → reconcile: update parent as Day 1, INSERT OR REPLACE _d2.._dN,
//                      cancel any existing children with dayNumber > N
async function handleSplitJob(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  const { parentJobId, days, segmentType, rigs } = body;
  if (!parentJobId)
    return jsonResponse({ error: 'parentJobId required' }, corsHeaders, 400);

  // ── Rig-split path ────────────────────────────────────────────────────────
  // Body: { parentJobId, segmentType:'rig', rigs:[{rigId,crewCount},...] }
  // Creates same-date children with different rigIds, isRigSegment=1.
  // Parent keeps full amount (billing unit); children carry $0 (tracking units).
  // Parent rigId set to null — the group has no single rig.
  //
  // LAYER 4 NOTE: Bouncie GPS attribution for rig-segments is NOT yet correct —
  // the matcher picks the best rig for each job independently. All rig-segments
  // at the same address on the same day will currently receive the same rig's time.
  // Layer 4 fix: constrain matcher to job.rigId when isRigSegment=1.
  if (segmentType === 'rig') {
    if (!Array.isArray(rigs) || rigs.length < 2)
      return jsonResponse({ error: 'at least 2 rigs required for rig-split' }, corsHeaders, 400);

    const now2 = new Date().toISOString();
    const rootRow2 = await env.DB.prepare(
      'SELECT COALESCE(parentJobId, jobId) AS rootId FROM Job WHERE jobId=?'
    ).bind(parentJobId).first();
    if (!rootRow2) return jsonResponse({ error: 'job not found' }, corsHeaders, 404);
    const rootId2 = rootRow2.rootId;

    const parent2 = await env.DB.prepare('SELECT * FROM Job WHERE jobId=?').bind(rootId2).first();
    if (!parent2) return jsonResponse({ error: 'parent job not found' }, corsHeaders, 404);
    if (parent2.state !== 'scheduled')
      return jsonResponse({ error: 'can only rig-split scheduled jobs' }, corsHeaders, 400);

    try {
      // Update parent: becomes the group root. rigId=null (no single rig), keeps full amount.
      await env.DB.prepare(
        `UPDATE Job SET isMultiDayParent=1, dayNumber=NULL, totalDays=?,
         rigId=NULL, dayPhase=NULL, modifiedAt=? WHERE jobId=?`
      ).bind(rigs.length, now2, rootId2).run();

      // Insert rig-segment children — one per rig, same date, isRigSegment=1, amount=0
      const childIds2 = [];
      for (let i = 0; i < rigs.length; i++) {
        const r       = rigs[i];
        const childId = `${rootId2}_r${i + 1}`; // _r1, _r2, _r3 (vs _d2 for day-splits)
        childIds2.push(childId);
        await env.DB.prepare(`
          INSERT OR REPLACE INTO Job
            (jobId, payerId, propertyId, scheduledDate, state, amount, paymentStatus,
             servicesRequested, servicesRaw, jobNotes, rigId, crewCount,
             workSiteAddress, workSiteCity, workSiteZip,
             workSitePlaceId, workSiteGoogleVerified,
             endCustomerName, endCustomerPhone, roofStories,
             source, createdAt, modifiedAt,
             parentJobId, dayNumber, totalDays, dayPhase, isMultiDayParent, isRigSegment)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          childId,
          parent2.payerId,
          parent2.propertyId,
          parent2.scheduledDate,          // SAME date as parent
          'scheduled',
          0,                              // amount=0 — rig-segments are tracking units
          'pending',
          parent2.servicesRequested,
          parent2.servicesRaw            || parent2.servicesRequested,
          parent2.jobNotes               || parent2.servicesRequested,
          r.rigId,                        // each child has its OWN rigId
          r.crewCount                    || null,
          parent2.workSiteAddress        || null,
          parent2.workSiteCity           || null,
          parent2.workSiteZip            || null,
          parent2.workSitePlaceId        || null,
          parent2.workSiteGoogleVerified || 0,
          parent2.endCustomerName        || null,
          parent2.endCustomerPhone       || null,
          parent2.roofStories            || null,
          'rig_split',
          now2, now2,
          rootId2,   // parentJobId
          i + 1,     // dayNumber = rig segment order (1-indexed)
          rigs.length,
          null,      // dayPhase = null for rig-segments
          0,         // isMultiDayParent = 0 (children are never parents)
          1          // isRigSegment = 1 — key differentiator from day-segments
        ).run();
      }

      // KV sync: parent rigId → null so it doesn't render in any rig column
      await _patchJobKvSync(
        { ...parent2, rigId: null },
        { rigId: true },
        env, now2
      ).catch(e => console.error('handleSplitJob:rigKvSync', e.message));

      return jsonResponse({ success: true, parentJobId: rootId2, childIds: childIds2, totalRigs: rigs.length, segmentType: 'rig' }, corsHeaders);
    } catch(e) {
      await _logD1Failure(env, `handleSplitJob:rig:${parentJobId}`, e.message);
      return jsonResponse({ error: e.message }, corsHeaders, 500);
    }
  }
  // ── End rig-split path ────────────────────────────────────────────────────

  if (!Array.isArray(days) || days.length < 1)
    return jsonResponse({ error: 'days must be a non-empty array' }, corsHeaders, 400);

  const now = new Date().toISOString();

  // ── Resolve root: body may pass a child's jobId ──────────────────────────
  const rootRow = await env.DB.prepare(
    'SELECT COALESCE(parentJobId, jobId) AS rootId FROM Job WHERE jobId=?'
  ).bind(parentJobId).first();
  if (!rootRow) return jsonResponse({ error: 'job not found' }, corsHeaders, 404);
  const rootId = rootRow.rootId;

  // ── Fetch root parent row ─────────────────────────────────────────────────
  const parent = await env.DB.prepare('SELECT * FROM Job WHERE jobId=?').bind(rootId).first();
  if (!parent)
    return jsonResponse({ error: 'parent job not found' }, corsHeaders, 404);
  if (parent.state !== 'scheduled')
    return jsonResponse({ error: 'can only split scheduled jobs' }, corsHeaders, 400);

  // ── Fetch all existing days in the set ────────────────────────────────────
  const { results: existingDays } = await env.DB.prepare(
    'SELECT jobId, dayNumber, state FROM Job WHERE jobId=? OR parentJobId=? ORDER BY dayNumber'
  ).bind(rootId, rootId).all();

  try {
    // ── Case: days.length === 1 → un-split ──────────────────────────────────
    if (days.length === 1) {
      const day1 = days[0];
      await env.DB.prepare(
        `UPDATE Job SET isMultiDayParent=0, dayNumber=NULL, totalDays=NULL, dayPhase=NULL,
         amount=?, scheduledDate=?, rigId=?, modifiedAt=? WHERE jobId=?`
      ).bind(
        day1.amount,
        day1.scheduledDate || parent.scheduledDate,
        day1.rigId != null ? day1.rigId : parent.rigId,
        now, rootId
      ).run();

      const childIds = existingDays.filter(d => d.jobId !== rootId).map(d => d.jobId);
      for (const childId of childIds) {
        await env.DB.prepare(
          `UPDATE Job SET state='cancelled', cancelledAt=?, modifiedAt=? WHERE jobId=?`
        ).bind(now, now, childId).run();
      }

      await _patchJobKvSync(
        { ...parent,
          amount:        day1.amount,
          scheduledDate: day1.scheduledDate || parent.scheduledDate,
          rigId:         day1.rigId != null ? day1.rigId : parent.rigId },
        { amount: true, scheduledDate: true, rigId: true },
        env, now
      ).catch(e => console.error('handleSplitJob:kvSync:unsplit', e.message));

      await _logD1Failure(env, 'handleSplitJob',
        `unsplit ${rootId} — cancelled children: [${childIds.join(', ')}]`);
      return jsonResponse({ success: true, parentJobId: rootId, action: 'unsplit', childIds }, corsHeaders);
    }

    // ── Case: days.length >= 2 → reconcile ──────────────────────────────────
    const totalDays = days.length;

    // Update parent → Day 1
    // servicesRaw + jobNotes narrowed to dayPhase so day-1 card shows only its phase,
    // consistent with days 2-N children. servicesRequested retains the full original list.
    const day1 = days[0];
    await env.DB.prepare(
      `UPDATE Job SET isMultiDayParent=1, dayNumber=1, totalDays=?,
       dayPhase=?, servicesRaw=?, jobNotes=?, amount=?, scheduledDate=?, rigId=?, modifiedAt=?
       WHERE jobId=?`
    ).bind(
      totalDays,
      day1.dayPhase      || null,
      day1.dayPhase      || parent.servicesRaw || null,   // narrow to phase; fall back to original if no phase
      day1.dayPhase      || parent.jobNotes    || null,
      day1.amount,
      day1.scheduledDate || parent.scheduledDate,
      day1.rigId != null ? day1.rigId : parent.rigId,
      now, rootId
    ).run();

    // INSERT OR REPLACE child rows for days 2..N
    const childIds = [];
    for (let i = 1; i < days.length; i++) {
      const d       = days[i];
      const dayNum  = i + 1;
      const childId = `${rootId}_d${dayNum}`;
      childIds.push(childId);

      await env.DB.prepare(
        `INSERT OR REPLACE INTO Job
           (jobId, payerId, propertyId, scheduledDate, state, amount, paymentStatus,
            servicesRequested, servicesRaw, jobNotes, rigId,
            workSiteAddress, workSiteCity, workSiteZip,
            workSitePlaceId, workSiteGoogleVerified,
            endCustomerName, endCustomerPhone, roofStories, crewCount,
            source, createdAt, modifiedAt,
            parentJobId, dayNumber, totalDays, dayPhase, isMultiDayParent)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        childId,
        parent.payerId,
        parent.propertyId,
        d.scheduledDate,
        'scheduled',
        d.amount,
        'pending',
        parent.servicesRequested,
        d.dayPhase                    || parent.servicesRaw         || parent.servicesRequested, // narrow to phase
        d.dayPhase                    || parent.jobNotes            || parent.servicesRequested,
        d.rigId != null ? d.rigId     : parent.rigId,
        parent.workSiteAddress        || null,
        parent.workSiteCity           || null,
        parent.workSiteZip            || null,
        parent.workSitePlaceId        || null,
        parent.workSiteGoogleVerified || 0,
        parent.endCustomerName        || null,
        parent.endCustomerPhone       || null,
        parent.roofStories            || null,
        parent.crewCount              || null,
        'split_job',
        now, now,
        rootId,    // parentJobId — children point at root
        dayNum,
        totalDays,
        d.dayPhase || null,
        0          // isMultiDayParent — children are never parents
      ).run();
    }

    // Cancel any existing children with dayNumber > N (removed days)
    const cancelledIds = [];
    for (const ex of existingDays) {
      if (ex.jobId !== rootId && (ex.dayNumber || 0) > totalDays) {
        await env.DB.prepare(
          `UPDATE Job SET state='cancelled', cancelledAt=?, modifiedAt=? WHERE jobId=?`
        ).bind(now, now, ex.jobId).run();
        cancelledIds.push(ex.jobId);
      }
    }

    // KV sync: reflect Day 1 slice on parent's scheduledStatus
    await _patchJobKvSync(
      { ...parent,
        amount:        day1.amount,
        scheduledDate: day1.scheduledDate || parent.scheduledDate,
        rigId:         day1.rigId != null ? day1.rigId : parent.rigId },
      { amount: true, scheduledDate: true, rigId: true },
      env, now
    ).catch(e => console.error('handleSplitJob:kvSync', e.message));

    await _logD1Failure(env, 'handleSplitJob',
      `reconciled ${rootId} → ${totalDays} days: [${childIds.join(', ')}]${cancelledIds.length ? ` cancelled: [${cancelledIds.join(', ')}]` : ''}`);

    return jsonResponse({ success: true, parentJobId: rootId, childIds, totalDays, cancelledIds }, corsHeaders);

  } catch(e) {
    await _logD1Failure(env, `handleSplitJob:error:${rootId}`, e.message);
    return jsonResponse({ error: e.message }, corsHeaders, 500);
  }
}

const _JOB_MUTABLE_FIELDS = new Set([
  'state', 'scheduledDate', 'scheduledTimeWindow', 'rigId',
  'amount', 'jobNotes', 'servicesRaw', 'servicesRequested', 'cancellationReason', 'cancelledAt',
  'completedAt', 'paymentStatus', 'paymentMethod', 'paidAt',
  'workSiteAddress', 'workSiteCity', 'workSiteZip',
  'workSitePlaceId', 'workSiteGoogleVerified',
  'endCustomerName', 'endCustomerPhone', 'partnerRate',
  'crewCount',
  'roofStories',   // Bug B2b: D1 schema had the column; whitelist was missing it (pencil edit silently dropped changes)
  'roofType',      // DL-01: roof material type, written at completion and pencil edit
  'dayPhase',      // Phase 2C: multi-day phase label editable via PATCH
  // Migration 0015: per-job outcome fields (post-job tip + complaint recording)
  'tipped', 'tipAmount', 'complained', 'complaintNotes',
  // Migration 0015: cost-ready fields (structure now; populate as expense tracking matures)
  'gasCost', 'chemicalCost', 'laborCost', 'equipmentCost', 'otherCost',
  // Existing columns that existed in schema but were never whitelisted — fixed in 0015 release
  'drivetimeFromPreviousJob', 'milesFromPreviousJob',
  // Migration 0017: multi-rig segment flag
  'isRigSegment',
  // Secondary-property re-bind: when address-gate creates a new secondary property for an
  // existing job, the UI must re-point propertyId. Validated below (PersonProperty link required).
  'propertyId',
]);

const _JOB_VALID_STATES = new Set([
  'scheduled', 'in_progress', 'completed', 'cancelled', 'rescheduled', 'no_show',
]);

async function handlePatchJob(request, env, jobId, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  if (!jobId) return jsonResponse({ error: 'jobId required' }, corsHeaders, 400);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object')
    return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  // Whitelist check
  const disallowed = Object.keys(body).filter(k => !_JOB_MUTABLE_FIELDS.has(k));
  if (disallowed.length)
    return jsonResponse({ error: `Field(s) not mutable: ${disallowed.join(', ')}` }, corsHeaders, 400);

  // State validation
  if (body.state !== undefined && !_JOB_VALID_STATES.has(body.state))
    return jsonResponse({ error: `Invalid state: ${body.state}` }, corsHeaders, 400);

  // Confirm job exists
  const existing = await env.DB.prepare('SELECT jobId, state, payerId FROM Job WHERE jobId = ?').bind(jobId).first();
  if (!existing) return jsonResponse({ error: 'Job not found', jobId }, corsHeaders, 404);

  // propertyId re-bind: must have a PersonProperty link for this job's payer.
  // Prevents arbitrary FK re-pointing to an unrelated property.
  if (body.propertyId !== undefined) {
    const _propLink = await env.DB.prepare(
      'SELECT 1 FROM PersonProperty WHERE personId=? AND propertyId=?'
    ).bind(existing.payerId, body.propertyId).first();
    if (!_propLink)
      return jsonResponse({
        error: `propertyId ${body.propertyId} has no PersonProperty link for payer ${existing.payerId}`,
      }, corsHeaders, 400);
  }

  const now = new Date().toISOString();

  // Auto-timestamps on state transitions
  const updates = { ...body };
  if (updates.state === 'cancelled' && !updates.cancelledAt) updates.cancelledAt = now;
  if (updates.state === 'completed' && !updates.completedAt) updates.completedAt = now;

  const sets = Object.keys(updates).map(k => `${k}=?`);
  sets.push('modifiedAt=?');
  const vals = [...Object.values(updates), now, jobId];

  try {
    await env.DB.prepare(
      `UPDATE Job SET ${sets.join(', ')} WHERE jobId = ?`
    ).bind(...vals).run();

    const updated = await env.DB.prepare('SELECT * FROM Job WHERE jobId = ?').bind(jobId).first();

    // Fix 5 (T1.22): when roofType is patched on a Job, propagate to Property (durable source).
    // Data model: Property.roofType = persistent truth; Job.roofType = snapshot at service time.
    // ML feature: COALESCE(Job.roofType, Property.roofType). Both stay in sync here.
    // propertyId comes from the updated row — always correct even if propertyId itself was patched.
    if ('roofType' in updates && updated?.propertyId) {
      await _d1SyncPropertyUpdate(updated.propertyId, {
        roofType: updates.roofType || null,
      }, env, now).catch(e => console.error('handlePatchJob:roofType→Property', e.message));
    }

    // Fix C: dual-write KV for primary-property jobs so _d1SyncCustomersPut never
    // sees a D1-vs-KV date mismatch and inserts spurious scheduled rows.
    await _patchJobKvSync(updated, updates, env, now);

    // Station 3 (tip propagation): tipped/tipAmount changes roll up into isTipper and
    // avgTipAmount on the customer blob. _patchJobKvSync only touches scheduledStatus
    // and never rebuilds jobHistory[] or rollup fields, so do a full KV rebuild here.
    if (('tipped' in updates || 'tipAmount' in updates) && updated?.payerId?.startsWith('person_1')) {
      try {
        const ph = updated.payerId.slice('person_1'.length);
        if (ph.length === 10) {
          const updatedCustomer = await d1CustomerToKvShape(ph, env);
          if (updatedCustomer) {
            const kvDb = await env.DATA.get('customer_db', 'json') || { customers: [] };
            const idx  = (kvDb.customers||[]).findIndex(c =>
              (c.phone||'').replace(/\D/g,'').slice(-10) === ph
            );
            if (idx >= 0) kvDb.customers[idx] = updatedCustomer;
            else kvDb.customers.push(updatedCustomer);
            await env.DATA.put('customer_db', JSON.stringify(kvDb));
          }
        }
      } catch(e) {
        await _logD1Failure(env, `handlePatchJob:tipKvRebuild:${jobId}`, e.message).catch(()=>{});
      }
    }

    return jsonResponse({ success: true, jobId, updatedRow: updated }, corsHeaders);
  } catch (e) {
    await _logD1Failure(env, `handlePatchJob:${jobId}`, e.message);
    return jsonResponse({ error: 'D1 update failed', detail: e.message }, corsHeaders, 500);
  }
}

// KV dual-write after PATCH /admin/job/:jobId.
// Keeps KV scheduledStatus in sync for the customer's PRIMARY property job.
// Non-primary multi-property jobs (e.g., Ashley Pinecrest) are D1-only by design —
// calendarJobs[] surfaces them; KV's single scheduledStatus slot tracks only the primary.
async function _patchJobKvSync(job, patchedFields, env, now) {
  if (!env.DATA || !job?.payerId) return;
  try {
    // Reverse _d1PersonId: 'person_1XXXXXXXXXX' → 10-digit phone
    if (!job.payerId.startsWith('person_1')) return;
    const ph10 = job.payerId.slice('person_1'.length);
    if (!ph10 || ph10.length !== 10) return;

    const db = await env.DATA.get(KV_KEYS.customers, 'json');
    if (!db) return;
    const norm = p => (p||'').replace(/\D/g,'').slice(-10);
    const cust = (db.customers||[]).find(c => norm(c.phone) === ph10);
    if (!cust) return;

    // Multi-property guard: if this job's property ≠ customer's primary address prop, D1-only.
    if (cust.address && job.propertyId) {
      const primaryPropId = _d1PropId(cust.address, cust.city||'');
      if (primaryPropId !== job.propertyId) return;
    }

    const ss = cust.scheduledStatus || {};
    if ('scheduledDate'       in patchedFields) ss.scheduledDate  = job.scheduledDate;
    if ('rigId'               in patchedFields) ss.rig            = job.rigId;
    if ('amount'              in patchedFields) ss.approvedAmount  = job.amount;
    if ('scheduledTimeWindow' in patchedFields) ss.window         = job.scheduledTimeWindow;
    if ('servicesRaw'         in patchedFields) ss.jobNotes       = job.servicesRaw || ss.jobNotes;
    if ('jobNotes'            in patchedFields) ss.jobNotes       = job.jobNotes    || ss.jobNotes;
    if ('roofStories'         in patchedFields) ss.roofStories    = job.roofStories ?? null;
    if ('state' in patchedFields) {
      ss.state = job.state;
      if (job.state === 'completed') {
        ss.completedAt   = job.completedAt || now;
        ss.completedDate = (job.completedAt || now).slice(0, 10);
      } else if (job.state === 'rescheduled' || job.state === 'cancelled') {
        ss.completedAt   = null;
        ss.completedDate = null;
      }
    }
    cust.scheduledStatus = ss;
    await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
  } catch (e) {
    await _logD1Failure(env, `_patchJobKvSync:${job?.jobId}`, e.message).catch(()=>{});
  }
}

// ── Day 2 dual-write helpers ──────────────────────────────────────────────────
// KV is canonical. D1 writes are best-effort mirrors. Failures logged, never re-thrown.

function _d1PersonId(phone) {
  const digits = (phone||'').replace(/\D/g,'');
  const d = digits.length === 10 ? '1'+digits : digits.length === 11 ? digits : null;
  return d ? 'person_' + d : null;
}

function _d1PropId(street, city) {
  const norm = s => (s||'').toLowerCase().trim().replace(/\s+/g,' ');
  const key  = (norm(street) + '|' + norm(city)).replace(/[^\w]/g,'_').slice(0,40);
  return 'prop_' + key;
}

// Extract the leading house number from a street address for the correction-vs-move fork.
// Returns null when absent; callers treat null as "unknown → default to Case 2 (new property)".
function _extractHouseNum(addr) {
  const m = (addr||'').trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

function _d1ScheduledJobId(personId, scheduledDate) {
  const slug = (personId + '_' + (scheduledDate||'nodate') + '_scheduled').replace(/[^\w]/g,'_').slice(0,50);
  return 'job_' + slug;
}

async function _logD1Failure(env, context, error) {
  try {
    const key   = 'd1_sync_failures';
    const log   = await env.DATA.get(key, 'json') || [];
    log.unshift({ ts: new Date().toISOString(), context, error: String(error).slice(0,300) });
    await env.DATA.put(key, JSON.stringify(log.slice(0,100)));
  } catch { /* never throw from failure logger */ }
}

async function _d1SyncPropertyUpdate(propId, fields, env, now) {
  if (!propId) return;
  const sets = [], vals = [];
  if (fields.sqft     !== undefined) { sets.push('sqft=?');     vals.push(fields.sqft     || null); }
  if (fields.roofType !== undefined) { sets.push('roofType=?'); vals.push(fields.roofType || null); }
  if (fields.gateCode    !== undefined) { sets.push('gateCode=?');    vals.push(fields.gateCode    || null); }
  if (fields.accessNotes !== undefined) { sets.push('accessNotes=?'); vals.push(fields.accessNotes || null); }
  if (!sets.length) return;
  sets.push('modifiedAt=?'); vals.push(now); vals.push(propId);
  await env.DB.prepare(`UPDATE Property SET ${sets.join(',')} WHERE propertyId=?`).bind(...vals).run();
}

async function _d1SyncNewCustomer(c, env, now) {
  const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
  if (!ph || ph.length !== 10) return;
  const personId = _d1PersonId(ph);
  if (!personId) return;
  const e164 = '+1' + ph;

  try {
    // Person INSERT (ignore if already exists)
    // customerType included so commercial/partner customers land correctly (was missing, bug fix).
    await env.DB.prepare(
      `INSERT OR IGNORE INTO Person (personId,firstName,lastName,primaryPhone,email,isHomeowner,doNotContact,customerType,createdAt,modifiedAt,migratedFrom,migrationVersion,migratedAt,migrationConfidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(personId, c.firstName||'', c.lastName||'', e164, c.email||null, c.isCommercialAccount?0:1, c.optOut?1:0, c.customerType||'residential', now, now, 'kv_dual_write', 'v3_day2_dualwrite', now, 'high').run();

    // Property INSERT OR IGNORE
    if (c.address) {
      const propId = _d1PropId(c.address, c.city||'');
      const lat    = c.coordinates?.lat || c.geocoded?.lat || null;
      const lng    = c.coordinates?.lng || c.geocoded?.lng || null;
      const geoSrc = c.geocodeSource || c.coordinates?.source || null;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO Property (propertyId,streetAddress,city,state,zip,latitude,longitude,geocodeSource,createdAt,modifiedAt,migratedFrom,migrationVersion,migratedAt,migrationConfidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(propId, c.address, c.city||'', 'FL', c.zip||null, lat, lng, geoSrc, now, now, 'kv_dual_write', 'v3_day2_dualwrite', now, 'high').run();

      // Demote any existing primary before linking new address as primary (no-op for new customers)
      await env.DB.prepare('UPDATE PersonProperty SET primaryContact=0 WHERE personId=?').bind(personId).run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO PersonProperty (personId,propertyId,relationship,primaryContact,propertyLabel) VALUES (?,?,?,?,?)`
      ).bind(personId, propId, c.isCommercialAccount?'manager':'owner', 1, 'Main Residence').run();

      await _d1SyncPropertyUpdate(propId, {
        sqft:     c.sqFt || c.roofSqFt || null,
        roofType: c.roofType || c.quoteStatus?.servicesAgreed?.roofType || null,
        gateCode: c.gateCode || null,
      }, env, now);
    }
  } catch(e) { await _logD1Failure(env, `_d1SyncNewCustomer:${ph}`, e.message); }
}

async function _d1SyncJobHistory(c, prevJhIds, env, now) {
  const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
  if (!ph) return;
  const personId = _d1PersonId(ph);
  if (!personId) return;

  // Resolve propertyId for this customer
  const propId = c.address ? _d1PropId(c.address, c.city||'') : null;

  for (const jh of (c.jobHistory||[])) {
    if (!jh.jobId || prevJhIds.has(jh.jobId)) continue;
    if (jh.source === 'csv_backfill') continue; // historical records already in D1 from Day 1
    if (jh.source === 'rig_segment')  continue; // supplementary display entries — D1 row already exists
    if (jh.source === 'day_segment')  continue; // per-day display entries — D1 row already exists
    // Fix D: guard against jobId-format collisions between Day 1 migration rows and Phase 2
    // calendar-generated rows. Same payerId+scheduledDate+propertyId = same real job under a
    // different jobId — skip INSERT rather than creating a phantom duplicate.
    if (propId && jh.date) {
      try {
        const clash = await env.DB.prepare(
          `SELECT jobId FROM Job WHERE payerId=? AND scheduledDate=? AND propertyId=? AND state IN ('completed','scheduled','in_progress') LIMIT 1`
        ).bind(personId, jh.date, propId).first();
        if (clash) {
          await _logD1Failure(env, `_d1SyncJobHistory:dedup:${ph}:${jh.jobId}`, `skipped — D1 already has ${clash.jobId}`);
          continue;
        }
      } catch(e) { /* guard query failed — proceed with INSERT attempt below */ }
    }
    try {
      await env.DB.prepare(
        `INSERT OR ROLLBACK INTO Job (jobId,payerId,propertyId,scheduledDate,state,completedAt,amount,servicesRequested,paymentMethod,paymentStatus,paidAt,servicesRaw,rigId,source,createdAt,modifiedAt,migratedFrom,migrationVersion,migratedAt,migrationConfidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        jh.jobId, personId, propId, jh.date||null, 'completed',
        jh.completedAt||now, jh.amount||0, '[]', jh.paymentMethod||jh.payment||null,
        jh.paidAt?'paid':'unpaid', jh.paidAt||null,
        jh.services||null, jh.rig||jh.rigId||null, 'phone_quote',
        now, now, 'kv_dual_write', 'v3_day2_dualwrite', now, 'high'
      ).run();
    } catch(e) { await _logD1Failure(env, `_d1SyncJobHistory:${ph}:${jh.jobId}`, e.message); }
  }
}

async function _d1SyncScheduledJob(c, env, now) {
  const ss = c.scheduledStatus;
  if (!ss || ss.state !== 'scheduled' || !ss.scheduledDate) return;
  const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
  const personId = _d1PersonId(ph);
  if (!personId) return;
  const propId = c.address ? _d1PropId(c.address, c.city||'') : null;
  const jobId  = _d1ScheduledJobId(personId, ss.scheduledDate);

  // Part 1c (T1.22): structured servicesRequested from serviceTags (set by handleAgreementConfirm)
  // or parsed from flat jobNotes as fallback. servicesRaw stays flat string.
  const _syncSvcReq = (() => {
    if (Array.isArray(ss.serviceTags) && ss.serviceTags.length > 0) return JSON.stringify(ss.serviceTags);
    const parsed = _parseServiceTags(ss.jobNotes);
    if (parsed) return JSON.stringify(parsed);
    return ss.jobNotes || null;
  })();

  try {
    await env.DB.prepare(
      `INSERT OR ROLLBACK INTO Job
         (jobId,payerId,propertyId,scheduledDate,state,amount,
          servicesRequested,servicesRaw,rigId,crewCount,
          roofType,
          actualDuration,actualArrival,actualDeparture,
          bouncieMatchStatus,bouncieMatchConfidence,geocodeSource,
          source,createdAt,modifiedAt,migratedFrom,migrationVersion,migratedAt,migrationConfidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      jobId, personId, propId, ss.scheduledDate, 'scheduled',
      ss.approvedAmount||0, _syncSvcReq, ss.jobNotes||null, ss.rig||null,
      ss.crewCount||2,
      ss.roofType || c.quoteStatus?.servicesAgreed?.roofType || null,  // Fix 3 (T1.22)
      ss.actualDuration||null, ss.actualArrival||null, ss.actualDeparture||null,
      ss.durationConfidence||ss.bouncieMatchStatus||null, null, ss.geocodeSource||null,
      'phone_quote', now, now, 'kv_dual_write', 'v3_day2_dualwrite', now, 'high'
    ).run();
  } catch(e) { await _logD1Failure(env, `_d1SyncScheduledJob:${ph}`, e.message); }
}

async function _d1SyncPersonUpdate(newC, prevC, env, now) {
  const ph = (newC.phone||'').replace(/\D/g,'').slice(-10);
  const personId = _d1PersonId(ph);
  if (!personId) return;
  const sets = [], vals = [];
  const diff = (field, newVal, oldVal) => {
    if ((newVal||'') !== (oldVal||'')) { sets.push(`${field}=?`); vals.push(newVal||''); }
  };
  diff('firstName',    newC.firstName,    prevC.firstName);
  diff('lastName',     newC.lastName,     prevC.lastName);
  diff('email',        newC.email,        prevC.email);
  // customerType: allow all upgrades and lateral changes (residential→partner, partner↔commercial, etc).
  // Block residential downgrade when prevC (KV) is a protected type — that is always a
  // stale-cache PUT, never a legitimate manual change (confirmed 2026-05-29).
  const _incomingType = newC.customerType || 'residential';
  const _prevType     = prevC.customerType || 'residential';
  if (['partner_referral', 'commercial'].includes(_prevType) && _incomingType === 'residential') {
    console.warn(`[_d1SyncPersonUpdate] blocked customerType downgrade: ${personId} ${_prevType}→residential`);
    await _logD1Failure(env, `blocked_customerType_downgrade:${personId}`,
      `${_prevType}→residential (stale KV cache in PUT body)`).catch(()=>{});
  } else {
    diff('customerType', _incomingType, _prevType);
  }
  diff('partnerNotes',  newC.partnerNotes, prevC.partnerNotes);
  diff('internalNotes', newC.notes,        prevC.notes);
  const newDnc = newC.optOut ? 1 : 0, prevDnc = prevC.optOut ? 1 : 0;
  if (newDnc !== prevDnc) { sets.push('doNotContact=?'); vals.push(newDnc); }
  if (!sets.length) return;
  sets.push('modifiedAt=?'); vals.push(now); vals.push(personId);
  await env.DB.prepare(`UPDATE Person SET ${sets.join(',')} WHERE personId=?`).bind(...vals).run();
}

async function _d1SyncCustomersPut(incomingCustomers, prevCustomers, env, addrEditedPhones = new Set()) {
  if (!env.DB) return; // D1 not bound — skip silently
  const now = new Date().toISOString();
  const prevByPhone = new Map();
  for (const c of (prevCustomers||[])) {
    const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
    if (ph) prevByPhone.set(ph, c);
  }

  for (const c of incomingCustomers) {
    if (c._virtualKey) continue; // skip fan-out display clones — not real writes
    const ph = (c.phone||'').replace(/\D/g,'').slice(-10);
    if (!ph || ph.length !== 10) continue;
    const prev = prevByPhone.get(ph);

    // New customer — insert Person + Property + PersonProperty
    if (!prev) {
      await _d1SyncNewCustomer(c, env, now);
      // _d1SyncScheduledJob removed — Law T1.20 (2026-05-26).
      // Collateral scheduled-job creates from bulk sync caused 5 silent failures.
      // All scheduled-state writes go through POST /admin/scheduled-job explicitly.
      continue;
    }

    const personId = _d1PersonId(ph); // needed for PersonProperty upsert + reschedule delete

    // Person field changes (name, email, doNotContact)
    await _d1SyncPersonUpdate(c, prev, env, now);

    // Existing customer — sync new jobHistory entries
    const prevJhIds = new Set((prev.jobHistory||[]).map(j => j.jobId).filter(Boolean));
    await _d1SyncJobHistory(c, prevJhIds, env, now);

    // Upsert Property + PersonProperty for current address before job sync.
    // Prevents FK failure when an existing customer's address changes between
    // submissions — _d1SyncScheduledJob references propertyId which must exist.
    if (c.address && (c.address !== prev?.address || (c.city||'') !== (prev?.city||''))) {
      const _isDeliberate = addrEditedPhones.has(ph);
      try {
        if (_isDeliberate) {
          // Deliberate user edit — fork on house number to detect correction vs. genuine move.
          const _primaryProp = await env.DB.prepare(
            `SELECT pr.propertyId, pr.streetAddress, pr.city
             FROM PersonProperty pp JOIN Property pr ON pp.propertyId=pr.propertyId
             WHERE pp.personId=? AND pp.primaryContact=1 LIMIT 1`
          ).bind(personId).first();

          const _newHouseNum = _extractHouseNum(c.address);
          const _oldHouseNum = _extractHouseNum(_primaryProp?.streetAddress);
          const _newCity     = (c.city||'').toLowerCase().trim();
          const _oldCity     = (_primaryProp?.city||'').toLowerCase().trim();

          // CORRECTION: same house number + same city → spelling/typo fix.
          // UPDATE Property text in place — no new row, no FK changes, no job re-pointing.
          const _isCorrection = !!(_newHouseNum && _oldHouseNum &&
            _newHouseNum === _oldHouseNum && _newCity === _oldCity &&
            _primaryProp?.propertyId);

          if (_isCorrection) {
            await env.DB.prepare(
              'UPDATE Property SET streetAddress=?, city=?, modifiedAt=? WHERE propertyId=?'
            ).bind(c.address, c.city||'', now, _primaryProp.propertyId).run();
            await _d1SyncPropertyUpdate(_primaryProp.propertyId, {
              sqft:        c.sqFt || null,
              roofType:    c.roofType || c.quoteStatus?.servicesAgreed?.roofType || null,
              gateCode:    c.gateCode    || null,
              accessNotes: c.accessNotes || null,
            }, env, now);
          } else {
            // MOVE: different house number or city → genuinely new address.
            // Create new Property row, promote to primary, re-point open jobs.
            // Completed jobs keep their historical propertyId — never rewrite history.
            const propId = _d1PropId(c.address, c.city||'');
            await env.DB.prepare(
              `INSERT OR IGNORE INTO Property (propertyId,streetAddress,city,state,createdAt,modifiedAt,migratedFrom,migrationVersion,migratedAt,migrationConfidence) VALUES (?,?,?,?,?,?,?,?,?,?)`
            ).bind(propId, c.address, c.city||'', 'FL', now, now, 'kv_dual_write', 'v3_day2_dualwrite', now, 'high').run();
            await env.DB.prepare('UPDATE PersonProperty SET primaryContact=0 WHERE personId=?').bind(personId).run();
            await env.DB.prepare(
              `INSERT OR IGNORE INTO PersonProperty (personId,propertyId,relationship,primaryContact,propertyLabel) VALUES (?,?,?,?,?)`
            ).bind(personId, propId, c.isCommercialAccount?'manager':'owner', 1, 'Main Residence').run();
            await env.DB.prepare(
              'UPDATE PersonProperty SET primaryContact=1 WHERE personId=? AND propertyId=?'
            ).bind(personId, propId).run();
            await env.DB.prepare(
              `UPDATE Job SET propertyId=?, modifiedAt=? WHERE payerId=? AND state IN ('scheduled','in_progress')`
            ).bind(propId, now, personId).run();
            await _d1SyncPropertyUpdate(propId, {
              sqft:        c.sqFt || null,
              roofType:    c.roofType || c.quoteStatus?.servicesAgreed?.roofType || null,
              gateCode:    c.gateCode    || null,
              accessNotes: c.accessNotes || null,
            }, env, now);
          }
        } else {
          // Incidental diff (autocomplete, bulk sync, migration): never silently promote.
          // Ensure Property row exists, then INSERT OR IGNORE with primaryContact=0.
          const propId = _d1PropId(c.address, c.city||'');
          await env.DB.prepare(
            `INSERT OR IGNORE INTO Property (propertyId,streetAddress,city,state,createdAt,modifiedAt,migratedFrom,migrationVersion,migratedAt,migrationConfidence) VALUES (?,?,?,?,?,?,?,?,?,?)`
          ).bind(propId, c.address, c.city||'', 'FL', now, now, 'kv_dual_write', 'v3_day2_dualwrite', now, 'high').run();
          await env.DB.prepare(
            `INSERT OR IGNORE INTO PersonProperty (personId,propertyId,relationship,primaryContact,propertyLabel) VALUES (?,?,?,?,?)`
          ).bind(personId, propId, c.isCommercialAccount?'manager':'owner', 0, 'Main Residence').run();
          await _d1SyncPropertyUpdate(propId, {
            sqft:        c.sqFt || null,
            roofType:    c.roofType || c.quoteStatus?.servicesAgreed?.roofType || null,
            gateCode:    c.gateCode    || null,
            accessNotes: c.accessNotes || null,
          }, env, now);
        }
      } catch(e) { await _logD1Failure(env, `_d1SyncCustomersPut:property_upsert:${ph}`, e.message); }
    }

    // Fix B — T1.22: sync gateCode + accessNotes to D1 independent of address change.
    // The address-change block above handles them when address also changes.
    // This catches the case where ONLY gateCode/accessNotes changed (e.g. calendar
    // full-edit modal) — previously those edits wrote to KV only and were lost on reload.
    // Runs ONLY when address did NOT change (no double-write on address-change path).
    {
      const _addrChanged = c.address && (c.address !== prev?.address || (c.city||'') !== (prev?.city||''));
      const _gcChanged   = (c.gateCode    || null) !== (prev?.gateCode    || null);
      const _anChanged   = (c.accessNotes || null) !== (prev?.accessNotes || null);
      if (!_addrChanged && (_gcChanged || _anChanged)) {
        try {
          const _gcProp = await env.DB.prepare(
            `SELECT pr.propertyId FROM PersonProperty pp JOIN Property pr ON pp.propertyId=pr.propertyId
             WHERE pp.personId=? AND pp.primaryContact=1 LIMIT 1`
          ).bind(personId).first();
          if (_gcProp?.propertyId) {
            await _d1SyncPropertyUpdate(_gcProp.propertyId, {
              gateCode:    c.gateCode    || null,
              accessNotes: c.accessNotes || null,
            }, env, now);
          }
        } catch(e) { await _logD1Failure(env, `_d1SyncCustomersPut:gateCode_sync:${ph}`, e.message); }
      }
    }

    // _d1SyncScheduledJob block removed — Law T1.20 (2026-05-26).
    // Previously: bulk sync detected scheduledDate change and called _d1SyncScheduledJob.
    // This caused Bug 3 (Carl Casagrande drag duplicate) and 5 collateral D1_ERROR entries
    // in May 23-26: when any customer's PUT /customers fired, ALL 1,232 customers were
    // iterated and scheduled-job INSERTs attempted for any with state='scheduled'.
    // The INSERT OR ROLLBACK created duplicate jobs when drag patchJob updated D1 date
    // but the KV blob still carried the old date (or vice versa after _patchJobKvSync).
    //
    // Fix: All scheduled-state writes now go through POST /admin/scheduled-job or
    // PATCH /admin/job explicitly (calendar.html: confirmTapSchedule,
    // quickScheduleFromQueue, handleDropToPool, undoAction, undoDelete;
    // new_customer.html: submitScheduleNow). _d1SyncNewCustomer + _d1SyncPersonUpdate
    // preserved — only the scheduled-job collateral creates are removed.
  }
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
  const expiresAt    = Date.now() + (tokens.expires_in || 3600) * 1000;
  const authorizedAt = new Date().toISOString();
  await Promise.all([
    env.DATA.put(KV_BOUNCIE_REFRESH, tokens.refresh_token),
    env.DATA.put(KV_BOUNCIE_ACCESS, JSON.stringify({
      access_token: tokens.access_token,
      expires_at:   expiresAt,
    })),
    // Record auth timestamp so pre-expiry alert can warn ~7 days before 30-day hard expiry.
    env.DATA.put('bouncie:authorized_at', authorizedAt),
    // Clear the dedup guard so the warning stops immediately after re-auth.
    env.DATA.delete('bouncie:last_token_warning_at'),
  ]);

  return page('Bouncie Connected!',
    `<p>Authorization successful. Tokens stored.</p>
     <p>Test the connection: <code>/api/bouncie/vehicles</code></p>
     <p class="meta">Authorized ${new Date().toLocaleString()}</p>`);
}

// ── Google Drive OAuth handlers ───────────────────────────────────────────────
function oauthPage(title, body, ok = true) {
  return new Response(`<!DOCTYPE html>
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
}

async function handleGoogleStart(env) {
  if (!env.GOOGLE_OAUTH_CLIENT_ID) {
    return oauthPage('Setup Required',
      '<p>Set worker secrets first:</p><p><code>wrangler secret put GOOGLE_OAUTH_CLIENT_ID</code></p><p><code>wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET</code></p>', false);
  }
  const state = crypto.randomUUID();
  await env.DATA.put(KV_GOOGLE_STATE, state, { expirationTtl: 600 });
  const params = new URLSearchParams({
    client_id:     env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/drive.file',
    access_type:   'offline',
    prompt:        'consent',
    state,
  });
  return Response.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
}

async function handleGoogleCallback(request, env, url) {
  const error = url.searchParams.get('error');
  if (error) return oauthPage('Authorization Failed',
    `<p>Google returned: <strong>${error}</strong></p><p>Visit <code>/oauth/google/start</code> to retry.</p>`, false);

  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code) return oauthPage('No Code', '<p>No authorization code from Google.</p>', false);

  const storedState = await env.DATA.get(KV_GOOGLE_STATE);
  if (!state || state !== storedState) {
    return oauthPage('State Mismatch', '<p>CSRF state invalid. Visit <code>/oauth/google/start</code> to restart.</p>', false);
  }
  await env.DATA.delete(KV_GOOGLE_STATE);

  let tokens;
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri:  GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });
    tokens = await res.json();
  } catch(e) {
    return oauthPage('Network Error', `<p>${e.message}</p>`, false);
  }

  if (!tokens.refresh_token) {
    return oauthPage('No Refresh Token',
      `<p>Google did not return a refresh_token. This can happen if the app was previously authorized.</p>
       <p>Go to <a href="https://myaccount.google.com/permissions">Google Account → Security → App access</a>, revoke "Pure Cleaning CRM Export", then retry.</p>`, false);
  }

  await Promise.all([
    env.DATA.put('google_oauth:refresh_token', tokens.refresh_token),
    env.DATA.put('google_oauth:access_token', JSON.stringify({
      access_token: tokens.access_token,
      expires_at:   Date.now() + ((tokens.expires_in || 3600) - 120) * 1000,
    })),
  ]);

  return oauthPage('Google Drive Connected!',
    `<p>Authorization successful. Refresh token stored in KV.</p>
     <p>Weekly exports will begin next Monday 4 AM UTC.</p>
     <p>Set your Drive folder: <code>POST /admin/google-drive/set-folder</code> with <code>{"folderId":"..."}</code></p>
     <p>Test now: <code>POST /admin/export-weekly</code></p>
     <p class="meta">Authorized ${new Date().toLocaleString()}</p>`);
}

// Get a valid access token, refreshing if expired
async function getBouncieAccessToken(env, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await env.DATA.get(KV_BOUNCIE_ACCESS, 'json');
    if (cached?.access_token && cached.expires_at > Date.now() + 300_000) {
      return cached.access_token; // 5-min buffer before expiry
    }
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

  // Diagnostic log — tells us whether Bouncie sends a new refresh_token on refresh.
  // If FALSE every run → hard 30-day expiry model (no rotation); build pre-expiry alert.
  // If TRUE → Bouncie rotates and the conditional save below should keep the chain alive.
  console.log('[Bouncie refresh] refresh_token present in response:', !!tokens.refresh_token, 'at', new Date().toISOString());

  await Promise.all([
    env.DATA.put(KV_BOUNCIE_ACCESS, JSON.stringify({ access_token: tokens.access_token, expires_at: expiresAt })),
    ...(tokens.refresh_token ? [env.DATA.put(KV_BOUNCIE_REFRESH, tokens.refresh_token)] : []),
  ]);

  return tokens.access_token;
}

// Fetch a Bouncie API URL with one automatic retry on 403 (expired access token).
// Retry force-refreshes via getBouncieAccessToken so the new token persists in KV.
async function bouncieFetchWithRetry(url, env, fetchOpts = {}) {
  let token = await getBouncieAccessToken(env);
  let res = await fetch(url, { ...fetchOpts, headers: { ...(fetchOpts.headers || {}), Authorization: token } });
  if (res.status === 403) {
    token = await getBouncieAccessToken(env, { forceRefresh: true });
    res   = await fetch(url, { ...fetchOpts, headers: { ...(fetchOpts.headers || {}), Authorization: token } });
  }
  return res;
}

async function bouncieKeepalive(env) {
  const ts = new Date().toISOString();
  const statusKey = 'bouncie:keepalive_status';
  try {
    const token = await getBouncieAccessToken(env);
    const res = await fetch(`${BOUNCIE_API_BASE}/vehicles`, { headers: { Authorization: token } });
    if (!res.ok) throw new Error(`Vehicles endpoint returned HTTP ${res.status}`);
    await env.DATA.put(statusKey, JSON.stringify({ ts, status: 'healthy' }));
    return { ts, status: 'healthy' };
  } catch(e) {
    await env.DATA.put(statusKey, JSON.stringify({ ts, status: 'failed', error: e.message }));
    return { ts, status: 'failed', error: e.message };
  }
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
      ? Math.round((+new Date(departureTrip.startTime) - +new Date(arrivalTrip.endTime)) / 60000)
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

// ── Day Route Averages ────────────────────────────────────────────────────────
// Computes stats from existing KV data (no new Bouncie calls) so it stays fast.
// Data sources:
//   - jobHistory: rig stats, service-type durations, geographic spread, between-job drive times
//   - bouncie:poi_stats:{gas|chlorine}: rolling 7-Eleven/Pro-Line dwell averages
//   - bouncie:morning_stops:{date}: per-date POI samples for in-period median
async function handleDayRouteAverages(request, env, corsHeaders, url) {
  const to   = url.searchParams.get('to')   || new Date().toISOString().slice(0, 10);
  const fromDefault = new Date(); fromDefault.setDate(fromDefault.getDate() - 30);
  const from = url.searchParams.get('from') || fromDefault.toISOString().slice(0, 10);

  const db = await env.DATA.get(KV_KEYS.customers, 'json');
  const customers = (db?.customers || []).filter(Boolean);

  // Rolling POI averages (all-time, stored by Bouncie cron)
  const [gasStats, chlorStats] = await Promise.all([
    env.DATA.get('bouncie:poi_stats:gas', 'json'),
    env.DATA.get('bouncie:poi_stats:chlorine', 'json'),
  ]);

  // In-period morning stop samples for median calculation
  const days = [];
  for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0,10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
    if (days.length > 90) break; // hard cap
  }
  const morningStopsArr = await Promise.all(days.map(d => env.DATA.get(`bouncie:morning_stops:${d}`, 'json')));
  const inPeriodDwell = { gas: [], chlorine: [] };
  for (const ms of morningStopsArr) {
    if (!ms?.morningStops) continue;
    for (const rigStops of Object.values(ms.morningStops)) {
      for (const [key, stop] of Object.entries(rigStops)) {
        if (stop?.found && stop.durationMin > 0 && inPeriodDwell[key]) {
          inPeriodDwell[key].push(stop.durationMin);
        }
      }
    }
  }

  const calcStats = arr => {
    if (!arr.length) return { avgMinutes: null, median: null, sampleSize: 0 };
    const sum = arr.reduce((a, b) => a + b, 0);
    const s   = [...arr].sort((a, b) => a - b);
    const m   = Math.floor(s.length / 2);
    const med = s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
    return { avgMinutes: Math.round(sum / arr.length), median: med, sampleSize: arr.length };
  };

  // Rig stats, service-type durations, geo spread, between-job drive times — from jobHistory
  const categorize = text => {
    const t = (text || '').toLowerCase();
    const isRoof   = /roof|soft\s*wash|softwash/.test(t);
    const isGround = /driveway|patio|sidewalk|walkway|concrete|pressure|paver|pool\s*deck|\bdeck\b|entranceway|entrance|flatwork|pool area/.test(t);
    if (isRoof && isGround) return 'both';
    if (isRoof)   return 'roof';
    if (isGround) return 'ground';
    return 'unknown';
  };

  const RIGS = ['rig_1', 'rig_2', 'rig_3'];
  const rigAccum  = Object.fromEntries(RIGS.map(r => [r, { jobCount: 0, revenue: 0, durMin: 0, durSample: 0 }]));
  const svcSamples = { roof: [], ground: [], both: [], unknown: [] };
  const geoAccum   = {};
  const betweenJobDriveMins = [];

  for (const c of customers) {
    const city = (c.city || 'Unknown').trim();
    // Build per-rig-per-day job lists so we can compute between-job drive times
    const rigDayJobs = {};
    for (const j of (c.jobHistory || [])) {
      if (j.status !== 'completed' || j.source === 'csv_backfill') continue;
      if (!j.date || j.date < from || j.date > to) continue;
      const rig = j.actualRig || j.rigId;
      if (!rig || !rigAccum[rig]) continue;
      const r = rigAccum[rig];
      r.jobCount++;
      r.revenue += j.amount || 0;
      if (j.actualDuration > 0) { r.durMin += j.actualDuration; r.durSample++; }
      const svc = categorize(j.services || j.jobNotes || '');
      if (j.actualDuration > 0 && svcSamples[svc]) svcSamples[svc].push(j.actualDuration);
      if (!geoAccum[city]) geoAccum[city] = { jobCount: 0, durMin: 0, durSample: 0 };
      geoAccum[city].jobCount++;
      if (j.actualDuration > 0) { geoAccum[city].durMin += j.actualDuration; geoAccum[city].durSample++; }
      // Collect for between-job drive time computation
      const key = `${rig}:${j.date}`;
      if (!rigDayJobs[key]) rigDayJobs[key] = [];
      rigDayJobs[key].push(j);
    }
    // Between-job drive times for this customer's jobs (same rig/date, consecutive)
    for (const jobs of Object.values(rigDayJobs)) {
      const sorted = jobs.filter(j => j.actualArrival && j.actualDeparture)
        .sort((a, b) => +new Date(a.actualArrival) - +new Date(b.actualArrival));
      for (let i = 0; i < sorted.length - 1; i++) {
        const driveMin = Math.round((+new Date(sorted[i + 1].actualArrival) - +new Date(sorted[i].actualDeparture)) / 60000);
        if (driveMin > 0 && driveMin < 120) betweenJobDriveMins.push(driveMin); // sanity cap 2h
      }
    }
  }

  const rigStats = Object.fromEntries(RIGS.map(r => {
    const a = rigAccum[r];
    return [r, {
      jobCount:         a.jobCount,
      totalRevenue:     Math.round(a.revenue),
      avgRevenue:       a.jobCount > 0 ? Math.round(a.revenue / a.jobCount) : null,
      totalActiveHours: Math.round(a.durMin / 6) / 10,
      avgJobDuration:   a.durSample > 0 ? Math.round(a.durMin / a.durSample) : null,
      sampleSize:       a.durSample,
    }];
  }));

  const svcAverages = Object.fromEntries(
    Object.entries(svcSamples)
      .filter(([, arr]) => arr.length > 0)
      .map(([svc, arr]) => [svc, calcStats(arr)])
  );

  const geoSpread = Object.fromEntries(
    Object.entries(geoAccum)
      .sort((a, b) => b[1].jobCount - a[1].jobCount)
      .slice(0, 15)
      .map(([city, d]) => [city, { jobCount: d.jobCount, avgJobMinutes: d.durSample > 0 ? Math.round(d.durMin / d.durSample) : null }])
  );

  return jsonResponse({
    periodStart: from, periodEnd: to, sampleDays: days.length,
    dwellAverages: {
      '7eleven': {
        ...(calcStats(inPeriodDwell.gas)),
        allTimeAvgMinutes: gasStats?.avgMin || null,
        allTimeSampleSize: gasStats?.count  || 0,
      },
      proline: {
        ...(calcStats(inPeriodDwell.chlorine)),
        allTimeAvgMinutes: chlorStats?.avgMin || null,
        allTimeSampleSize: chlorStats?.count  || 0,
      },
      home_departure: { note: 'Trip startTime not cached — will compute once day-route caching is added.' },
    },
    driveSegmentAverages: {
      between_jobs: betweenJobDriveMins.length > 0
        ? { ...calcStats(betweenJobDriveMins), note: 'Drive time between consecutive jobs on same rig/day' }
        : { avgMinutes: null, sampleSize: 0, note: 'Insufficient GPS-matched job pairs in date range' },
      home_to_7eleven:       { note: 'Requires day-route caching — not yet accumulated' },
      '7eleven_to_proline':  { note: 'Requires day-route caching — not yet accumulated' },
      proline_to_first_job:  { note: 'Requires day-route caching — not yet accumulated' },
      last_job_to_home:      { note: 'Requires day-route caching — not yet accumulated' },
    },
    rigStats, serviceTypeAverages: svcAverages, geographicSpread: geoSpread,
  }, corsHeaders);
}

// ── Day Route View ────────────────────────────────────────────────────────────
// Known named locations. Coords sourced from HOME_BASE (calendar.html) and MORNING_STOP_POIS.
const DAY_ROUTE_LOCATIONS = [
  { name: 'home',    label: 'Home Base', emoji: '🏠', lat: 26.0418239, lng: -80.3709794 },
  { name: '7eleven', label: '7-Eleven',  emoji: '⛽', lat: 26.0852,    lng: -80.3740    },
  { name: 'proline', label: 'Pro-Line',  emoji: '🧪', lat: 26.0712,    lng: -80.3680    },
];
const DAY_ROUTE_THRESHOLD_KM = 0.0914; // 300 ft

function namedLocationFromCoords(lat, lng) {
  let closest = null, closestDist = Infinity;
  for (const loc of DAY_ROUTE_LOCATIONS) {
    const d = haversineKm(lat, lng, loc.lat, loc.lng);
    if (d < closestDist) { closestDist = d; closest = loc; }
  }
  if (closestDist <= DAY_ROUTE_THRESHOLD_KM) return { ...closest, distanceFt: Math.round(closestDist * 3280.84) };
  return null;
}

function buildDayRoute(date, rig, sortedTrips, rigJobs) {
  const firstCoordOf = tr => { const c = tr?.gps?.coordinates; return c?.length ? c[0]           : null; };
  const lastCoordOf  = tr => { const c = tr?.gps?.coordinates; return c?.length ? c[c.length - 1] : null; };

  const empty = { rig, date, segments: [], noData: true, totals: { jobCount: 0, totalRevenue: 0, totalActiveHours: 0, totalDriveMin: 0 } };
  if (!sortedTrips.length) return empty;

  const segments = [];

  // Departure: identify where the first trip started
  const firstCoord = firstCoordOf(sortedTrips[0]);
  if (firstCoord) {
    const loc = namedLocationFromCoords(firstCoord[1], firstCoord[0]);
    segments.push({ type: 'depart', location: loc?.name || null, label: loc?.label || 'Start', emoji: loc?.emoji || '📍', time: sortedTrips[0].startTime });
  }

  for (let i = 0; i < sortedTrips.length; i++) {
    const trip    = sortedTrips[i];
    const nextTrip = sortedTrips[i + 1];

    // Drive segment — the trip itself
    const driveMin  = Math.round((+new Date(trip.endTime) - +new Date(trip.startTime)) / 60000);
    const distMi    = trip.distance != null ? Math.round(trip.distance * 0.621371 * 10) / 10 : null;
    segments.push({ type: 'drive', distanceMiles: distMi, durationMin: Math.max(driveMin, 0), startTime: trip.startTime, endTime: trip.endTime });

    if (!nextTrip) break;

    // Dwell window between this trip's end and next trip's start
    const dwellStart = trip.endTime;
    const dwellEnd   = nextTrip.startTime;
    const dwellMin   = Math.round((+new Date(dwellEnd) - +new Date(dwellStart)) / 60000);
    if (dwellMin < 1) continue; // sub-minute gap = GPS jitter, skip

    const endCoord = lastCoordOf(trip);

    // Named location?
    if (endCoord) {
      const named = namedLocationFromCoords(endCoord[1], endCoord[0]);
      if (named) {
        segments.push({ type: 'stop', location: named.name, label: named.label, emoji: named.emoji, arriveAt: dwellStart, departAt: dwellEnd, durationMin: dwellMin });
        continue;
      }
    }

    // Job match by time — prefer jobs where actualArrival matches this dwell start (cron has run)
    const timeJob = rigJobs.find(j =>
      j.actualArrival && Math.abs(+new Date(j.actualArrival) - +new Date(dwellStart)) < 120000
    );
    if (timeJob) {
      segments.push({ type: 'job', customer: timeJob.customerName, phone: timeJob.phone, address: timeJob.address, city: timeJob.city, service: timeJob.services || timeJob.jobNotes || '', arriveAt: dwellStart, departAt: dwellEnd, durationMin: dwellMin, confidence: timeJob.durationConfidence || 'matched_high', amount: timeJob.amount || null });
      continue;
    }

    // Job match by proximity — fallback for same-day (cron hasn't run yet)
    if (endCoord) {
      const proxJob = rigJobs.find(j => {
        const jLat = j.geocodedLat; const jLng = j.geocodedLng;
        if (!jLat || !jLng) return false;
        return haversineKm(endCoord[1], endCoord[0], jLat, jLng) <= 0.1524;
      });
      if (proxJob) {
        const dist = haversineKm(endCoord[1], endCoord[0], proxJob.geocodedLat, proxJob.geocodedLng);
        segments.push({ type: 'job', customer: proxJob.customerName, phone: proxJob.phone, address: proxJob.address, city: proxJob.city, service: proxJob.services || proxJob.jobNotes || '', arriveAt: dwellStart, departAt: dwellEnd, durationMin: dwellMin, confidence: dist <= 0.0762 ? 'matched_high' : 'matched_medium', amount: proxJob.amount || null });
        continue;
      }
    }

    // Unknown dwell
    segments.push({ type: 'stop', location: null, label: null, emoji: '📍', arriveAt: dwellStart, departAt: dwellEnd, durationMin: dwellMin, coords: endCoord ? { lat: endCoord[1], lng: endCoord[0] } : null });
  }

  // Return: final location after last trip
  const lastCoord2 = lastCoordOf(sortedTrips[sortedTrips.length - 1]);
  if (lastCoord2) {
    const loc = namedLocationFromCoords(lastCoord2[1], lastCoord2[0]);
    segments.push({ type: loc?.name === 'home' ? 'return' : 'arrive', location: loc?.name || null, label: loc?.label || 'Final stop', emoji: loc?.emoji || '📍', time: sortedTrips[sortedTrips.length - 1].endTime });
  }

  const jobSegs   = segments.filter(s => s.type === 'job');
  const driveSegs = segments.filter(s => s.type === 'drive');
  return {
    rig, date, segments,
    totals: {
      jobCount:         jobSegs.length,
      totalRevenue:     Math.round(jobSegs.reduce((s, j) => s + (j.amount || 0), 0)),
      totalActiveHours: Math.round(jobSegs.reduce((s, j) => s + (j.durationMin || 0), 0) / 6) / 10,
      totalDriveMin:    driveSegs.reduce((s, d) => s + (d.durationMin || 0), 0),
    },
  };
}

async function handleDayRoute(request, env, corsHeaders, url) {
  const date     = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
  const rigParam = url.searchParams.get('rig');

  const db         = await env.DATA.get(KV_KEYS.customers, 'json');
  const customers  = (db?.customers || []).filter(Boolean);
  const rigMapping = await env.DATA.get('bouncie:rig_mapping', 'json') || {};

  let accessToken;
  try { accessToken = await getBouncieAccessToken(env); }
  catch(e) { return jsonResponse({ error: 'Bouncie not authorized', message: e.message }, corsHeaders, 503); }

  const rigsToProcess = rigParam
    ? (rigMapping[rigParam]?.imei ? [[rigParam, rigMapping[rigParam]]] : [])
    : Object.entries(rigMapping).filter(([, re]) => re?.imei);

  const startsAfter = `${date}T00:00:00.000Z`;
  const endsBefore  = `${date}T23:59:59.000Z`;
  const results     = {};

  await Promise.all(rigsToProcess.map(async ([rig, rigEntry]) => {
    try {
      const res = await bouncieFetchWithRetry(
        `${BOUNCIE_API_BASE}/trips?imei=${rigEntry.imei}&gpsFormat=geojson&startsAfter=${encodeURIComponent(startsAfter)}&endsBefore=${encodeURIComponent(endsBefore)}`,
        env
      );
      const trips = res.ok ? await res.json() : [];
      const sortedTrips = Array.isArray(trips) ? trips.sort((a, b) => a.startTime < b.startTime ? -1 : 1) : [];

      // Collect completed jobs for this rig+date with coords
      const rigJobs = [];
      for (const c of customers) {
        for (const j of (c.jobHistory || [])) {
          if (j.date !== date || j.status !== 'completed') continue;
          if (j.rigId !== rig && j.actualRig !== rig) continue;
          rigJobs.push({
            ...j,
            customerName: fullName(c), phone: c.phone, address: c.address, city: c.city,
            geocodedLat: j.lat || j.geocodedLat || c.geocoded?.lat || null,
            geocodedLng: j.lng || j.geocodedLng || c.geocoded?.lng || null,
          });
        }
      }

      results[rig] = buildDayRoute(date, rig, sortedTrips, rigJobs);
    } catch(e) {
      results[rig] = { rig, date, segments: [], error: e.message, totals: { jobCount: 0, totalRevenue: 0, totalActiveHours: 0, totalDriveMin: 0 } };
    }
  }));

  if (rigParam) return jsonResponse(results[rigParam] || { rig: rigParam, date, error: 'Rig not in mapping', segments: [], totals: {} }, corsHeaders);
  return jsonResponse({ date, rigs: results }, corsHeaders);
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
    if (match) {
      return {
        lat:    parseFloat(match.coordinates.y),
        lng:    parseFloat(match.coordinates.x),
        lon:    parseFloat(match.coordinates.x),
        formattedAddress: match.matchedAddress || '',
        confidence: 'medium',
        geocodedAt: new Date().toISOString(),
        source: 'census',
      };
    }
  } catch { /* fall through to Nominatim */ }

  // ── Nominatim fallback (OpenStreetMap — handles non-standard FL subdivision addresses) ──
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`,
      { headers: { 'User-Agent': 'PureCleaningCRM/1.0 (purecleaningpressurecleaning.com)' } }
    );
    const data = await res.json();
    if (!data.length) return null;
    return {
      lat:    parseFloat(data[0].lat),
      lng:    parseFloat(data[0].lon),
      lon:    parseFloat(data[0].lon),
      formattedAddress: data[0].display_name || '',
      confidence: 'low',
      geocodedAt: new Date().toISOString(),
      source: 'nominatim',
    };
  } catch { return null; }
}

// ── POST /admin/bouncie/probe-coords ─────────────────────────────────────────
// Read-only diagnostic. Given { lat, lon, dates: [YYYY-MM-DD, ...] }, fetches
// Bouncie trips for every mapped rig on each date and reports the closest dwell
// per rig. No D1/KV writes. Mirrors the matcher's proximityMatch math so the
// results are directly comparable to what bouncieJobDurationMatcher would see.
async function handleBouncieProbeCoords(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.lat !== 'number' || typeof body.lon !== 'number')
    return jsonResponse({ error: 'lat and lon (numbers) required' }, corsHeaders, 400);
  const dates = Array.isArray(body.dates) ? body.dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  if (!dates.length)
    return jsonResponse({ error: 'dates array required (YYYY-MM-DD)' }, corsHeaders, 400);

  const MEDIUM_KM   = 0.1524; // 500 ft — same threshold matcher uses for hard reject
  const MIN_DUR_MIN = 20;     // same minimum dwell duration

  const rigMapping = await env.DATA.get('bouncie:rig_mapping', 'json') || {};
  const rigEntries = Object.entries(rigMapping).filter(([, re]) => re && re.imei);
  if (!rigEntries.length)
    return jsonResponse({ error: 'no rig mapping configured' }, corsHeaders, 503);

  let accessToken;
  try { accessToken = await getBouncieAccessToken(env); }
  catch(e) { return jsonResponse({ error: 'Bouncie auth failed', message: e.message }, corsHeaders, 502); }

  const tripFirstCoord = tr => { const c = tr?.gps?.coordinates; return c?.length ? c[0]          : null; };
  const tripLastCoord  = tr => { const c = tr?.gps?.coordinates; return c?.length ? c[c.length-1] : null; };

  const probes = [];
  for (const date of dates) {
    const startsAfter = `${date}T00:00:00.000Z`;
    const endsBefore  = `${date}T23:59:59.000Z`;
    const perRig = [];
    for (const [rig, rigEntry] of rigEntries) {
      let trips = [];
      try {
        const res = await bouncieFetchWithRetry(
          `${BOUNCIE_API_BASE}/trips?imei=${rigEntry.imei}&gpsFormat=geojson` +
          `&startsAfter=${encodeURIComponent(startsAfter)}&endsBefore=${encodeURIComponent(endsBefore)}`,
          env
        );
        trips = res.ok ? await res.json() : [];
        if (!Array.isArray(trips)) trips = [];
      } catch(e) { trips = []; }

      // Find arrival trip whose last coord is closest to probe coords
      let closestDistKm = Infinity, arrivalTrip = null;
      for (const trip of trips) {
        const last = tripLastCoord(trip);
        if (!last) continue;
        const d = haversineKm(last[1], last[0], body.lat, body.lon);
        if (d < closestDistKm) { closestDistKm = d; arrivalTrip = trip; }
      }
      const closestDistFt = isFinite(closestDistKm) ? Math.round(closestDistKm * 3280.84) : null;

      // If within threshold, search for departure trip → compute dwell duration
      let dwell = null;
      if (arrivalTrip && closestDistKm <= MEDIUM_KM) {
        let departureTrip = null;
        for (const trip of trips) {
          if (trip.startTime <= arrivalTrip.endTime) continue;
          const first = tripFirstCoord(trip);
          if (!first) continue;
          if (haversineKm(first[1], first[0], body.lat, body.lon) <= MEDIUM_KM) {
            if (!departureTrip || trip.startTime > departureTrip.startTime) departureTrip = trip;
          }
        }
        if (departureTrip) {
          const durationMin = Math.round(
            (+new Date(departureTrip.startTime) - +new Date(arrivalTrip.endTime)) / 60000
          );
          dwell = {
            arrivalAt:   arrivalTrip.endTime,
            departureAt: departureTrip.startTime,
            durationMin,
            qualifying:  durationMin >= MIN_DUR_MIN,
          };
        }
      }

      perRig.push({
        rig,
        imei:                rigEntry.imei,
        nickname:            rigEntry.nickname || rigEntry.name || null,
        tripCount:           trips.length,
        closestDistFt,
        closestDistMi:       isFinite(closestDistKm) ? +(closestDistKm * 0.621371).toFixed(2) : null,
        closestArrivalAt:    arrivalTrip ? arrivalTrip.endTime : null,
        withinGeofence:      isFinite(closestDistKm) && closestDistKm <= MEDIUM_KM,
        dwell,
      });
    }
    probes.push({ date, perRig });
  }

  return jsonResponse({
    lat:          body.lat,
    lon:          body.lon,
    thresholdFt:  500,
    minDwellMin:  MIN_DUR_MIN,
    probes,
  }, corsHeaders);
}

async function bouncieJobDurationMatcher(date, env) {
  console.log(`[Bouncie matcher] Start: date=${date}`);

  // KV load — still needed for write-back mirror to jhEntry/ss (T1.13).
  // Discovery source has changed to D1 (see below), but KV write-back preserves
  // legacy calendar reads and per-customer rolling stats.
  const db = await env.DATA.get(KV_KEYS.customers, 'json');
  const customers = (db?.customers || []).filter(Boolean);
  const _ph10 = p => (p||'').replace(/\D/g,'').slice(-10);

  // ── D1 discovery (T1.15 + T1.21) ──────────────────────────────────────────
  // Previous approach: KV scan for ss.state='completed' || jh[].date=date.
  // Root cause of May 19-present gap: post-Day-2 migration (May 20), completed
  // jobs live in D1. KV scan returned 0 → matcher exited in 584ms every night.
  // Fix: query D1 directly. actualDuration IS NULL keeps re-runs idempotent.
  // rigId IS NOT NULL skips jobs that can't be GPS-matched (hand-delivery etc).
  if (!env.DB) {
    console.error('[Bouncie matcher] D1 not available');
    return { date, total: 0, matched: 0, error: 'D1 not available' };
  }
  let d1Jobs = [];
  try {
    const r = await env.DB.prepare(`
      SELECT j.jobId, j.payerId, j.propertyId, j.scheduledDate, j.rigId,
             j.isRigSegment,
             j.servicesRaw, j.jobNotes,
             j.workSiteAddress, j.workSiteCity, j.workSitePlaceId,
             p.streetAddress, p.city, p.latitude, p.longitude,
             pr.firstName, pr.lastName, pr.primaryPhone
      FROM Job j
      JOIN Property p  ON j.propertyId = p.propertyId
      JOIN Person   pr ON j.payerId    = pr.personId
      WHERE j.state = 'completed'
        AND j.scheduledDate = ?
        AND j.actualDuration IS NULL
        AND j.rigId IS NOT NULL
    `).bind(date).all();
    d1Jobs = r.results || [];
  } catch(e) {
    console.error(`[Bouncie matcher] D1 query failed: ${e.message}`);
    return { date, total: 0, matched: 0, error: 'd1_query_failed', message: e.message };
  }
  console.log(`[Bouncie matcher] D1 query: ${d1Jobs.length} jobs need matching`);
  if (!d1Jobs.length) {
    return { date, total: 0, matched: 0, message: `No unmatched completed jobs in D1 for ${date}` };
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
      const res = await bouncieFetchWithRetry(
        `${BOUNCIE_API_BASE}/trips?imei=${rigEntry.imei}&gpsFormat=geojson&startsAfter=${encodeURIComponent(startsAfter)}&endsBefore=${encodeURIComponent(endsBefore)}`,
        env
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
  function proximityMatch(trips, jobLat, jobLon, useFirstDeparture = false) {
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
        if (!departureTrip || (useFirstDeparture
          ? trip.startTime < departureTrip.startTime   // neighbor: use FIRST departure (own dwell window)
          : trip.startTime > departureTrip.startTime)) // default: use LATEST departure (unchanged — supply-run / micro-event safe)
          departureTrip = trip;
      }
    }

    if (arrivalTrip && departureTrip) {
      const durationMin = Math.round((+new Date(departureTrip.startTime) - +new Date(arrivalTrip.endTime)) / 60000);
      return { arrivalTs: arrivalTrip.endTime, departureTs: departureTrip.startTime, durationMin, closestDistKm, arrivalTrip, departureTrip };
    }
    return { durationMin: 0, closestDistKm };
  }

  const results = [];
  const d1BouncieUpdates = []; // accumulated for batch D1 UPDATE after KV write
  // Fix 1: record specific failure reasons so bouncieMatchStatus is never left NULL
  // after an attempt. NULL now strictly means "not yet attempted." Values: geocode_failed
  // / no_data / no_reliable_match. Jobs with failure status still have actualDuration=NULL
  // and remain in the retry window query, so they continue to be retried automatically.
  const d1FailureUpdates = []; // { jobId, bouncieMatchStatus, bouncieMatchConfidence }
  let matched = 0;
  let coordsCached = 0, coordsGeocoded = 0, coordsFailed = 0;
  const kvDirty = new Set(); // KV customers modified — written back once at end

  for (const row of d1Jobs) {
    const rowPh10 = _ph10(row.primaryPhone || row.payerId);
    const rowName = [row.firstName, row.lastName].filter(Boolean).join(' ') || rowPh10;

    // KV lookup for write-back mirror (T1.13).
    // D1 is the discovery source; KV gets a mirror so legacy calendar reads
    // and per-customer rolling stats (avgJobDuration, bouncieMetrics) stay current.
    const kvCust = customers.find(c => _ph10(c.phone) === rowPh10);
    const ss      = kvCust?.scheduledStatus || {};

    // ── Work-site address resolution (partner/commercial jobs) ─────────────────
    // Partner jobs have workSiteAddress/workSitePlaceId set — the actual location
    // where the rig was, NOT the partner's billing Property address.
    // Residential jobs (workSiteAddress = NULL, ~99% of volume) skip this block
    // entirely and fall through to the unchanged billing-address path below.
    // CRITICAL: never cache work-site coords to Property — that would overwrite
    // the billing address geocode. Geocode at match time only.
    let jobLat = null, jobLon = null, geocodeSource = null;

    if (row.workSiteAddress && row.workSiteCity) {
      // Full street address present — geocode it (Google Maps → Census → Nominatim)
      const wsAddr = [row.workSiteAddress, row.workSiteCity, 'FL'].filter(Boolean).join(', ');
      const wsGeo = await geocodeAddress(wsAddr, env);
      if (wsGeo) {
        jobLat = wsGeo.lat; jobLon = wsGeo.lon || wsGeo.lng;
        geocodeSource = `worksite_${wsGeo.source}`;
        console.log(`[Bouncie matcher] Work-site geocode: ${row.jobId} → ${wsAddr} (${geocodeSource})`);
      }
    } else if (row.workSitePlaceId && env.GOOGLE_PLACES_API_KEY) {
      // No street address but a verified Google Place ID — resolve to exact coords
      try {
        const placeRes = await fetch(
          `https://maps.googleapis.com/maps/api/place/details/json?` +
          `place_id=${encodeURIComponent(row.workSitePlaceId)}&fields=geometry&key=${env.GOOGLE_PLACES_API_KEY}`
        );
        const placeData = await placeRes.json();
        if (placeData.status === 'OK' && placeData.result?.geometry?.location) {
          const loc = placeData.result.geometry.location;
          jobLat = loc.lat; jobLon = loc.lng;
          geocodeSource = 'worksite_places_api';
          console.log(`[Bouncie matcher] Work-site Place ID resolved: ${row.jobId} → ${loc.lat},${loc.lng}`);
        }
      } catch(e2) { /* non-fatal — fall through to billing address */ }
    }

    // ── Billing address fallback — UNCHANGED for all residential jobs ─────────
    // workSiteAddress absent (residential) OR work-site geocode failed → this block.
    // Coordinates: Property.latitude/longitude cached in 96% of rows.
    // Fall back to geocoder only for the remaining 4%; cache result back to
    // Property so subsequent runs skip the API call.
    // NOTE: Property has no geocodedAt column — update modifiedAt instead.
    //       Tyler to decide whether to add geocodedAt in a future schema commit.
    if (!jobLat || !jobLon) {
      jobLat = row.latitude  || null;
      jobLon = row.longitude || null;
      geocodeSource = row.latitude ? 'property_cached' : null;
      if (!jobLat || !jobLon) {
        const fullAddr = [row.streetAddress, row.city, 'FL'].filter(Boolean).join(', ');
        const geo = await geocodeAddress(fullAddr, env);
        if (geo) {
          jobLat = geo.lat; jobLon = geo.lon || geo.lng; geocodeSource = geo.source;
          // Cache coords back to Property — best-effort, non-fatal
          try {
            await env.DB.prepare(
              'UPDATE Property SET latitude=?, longitude=?, geocodeSource=?, modifiedAt=? WHERE propertyId=?'
            ).bind(jobLat, jobLon, geocodeSource, new Date().toISOString(), row.propertyId).run();
          } catch(_) { /* non-fatal */ }
          coordsGeocoded++;
        }
      } else {
        coordsCached++;
      }
    }

    if (!jobLat || !jobLon) {
      results.push({ jobId: row.jobId, name: rowName, status: 'geocode_failed',
        address: row.streetAddress, city: row.city });
      d1FailureUpdates.push({ jobId: row.jobId, bouncieMatchStatus: 'geocode_failed', bouncieMatchConfidence: null });
      coordsFailed++;
      continue;
    }

    // Neighbor detection: another same-date same-rig job within MEDIUM_KM (500 ft)?
    // true  → proximityMatch uses FIRST qualifying departure — each neighbor job gets its own
    //         dwell window, preventing the full combined dwell from being assigned to job 1.
    // false → proximityMatch uses LATEST departure, unchanged — preserves existing handling
    //         for GPS micro-events (0-mi engine pulses) and genuine mid-job supply runs.
    // d1Jobs is the full unmatched set for this date, so both neighbor rows are always present.
    const hasNeighborJob = jobLat !== null && jobLon !== null && d1Jobs.some(other =>
      other.jobId    !== row.jobId  &&
      other.rigId    === row.rigId  &&
      other.latitude !== null && other.longitude !== null &&
      haversineKm(jobLat, jobLon, other.latitude, other.longitude) <= MEDIUM_KM
    );

    // Layer 4: rig-segments pin the search to their declared rig's trips only.
    // Standalone and multi-day jobs scan ALL rigs — exactly as before, zero change.
    // This single line is the entire Layer 4 isolation mechanism.
    const _tripsToScan = (row.isRigSegment && row.rigId)
      ? Object.entries({ [row.rigId]: rigTripsMap[row.rigId] || [] })
      : Object.entries(rigTripsMap); // ← non-rig-segment: identical to original

    // Scan rigs — pick longest qualifying dwell within threshold.
    // Also track the globally closest approach for reporting on rejection.
    let bestRig = null, bestMatch = { durationMin: 0 };
    let globalClosestDistKm = Infinity, globalClosestRig = null, globalClosestArrival = null;
    const rigsWithinThreshold = [];

    for (const [rig, trips] of _tripsToScan) {
      if (!trips.length) continue; // no GPS data for this rig today
      const m = proximityMatch(trips, jobLat, jobLon, hasNeighborJob);
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
      results.push({ jobId: row.jobId, name: rowName, status: 'no_data',
        note: 'No GPS data for any mapped rig on this date.' });
      // Fix 1: stamp D1 so NULL = "not yet attempted" strictly.
      // actualDuration stays NULL → job remains in retry window query → still auto-retried.
      d1FailureUpdates.push({ jobId: row.jobId, bouncieMatchStatus: 'no_data', bouncieMatchConfidence: null });
      continue;
    }

    // No rig matched within threshold — report closest stop for operator review
    if (!bestRig) {
      const closestDistFt = Math.round(globalClosestDistKm * 3280.84);
      const closestMi     = (globalClosestDistKm * 0.621371).toFixed(2);
      // Fix 1 + Fix 4 (closest distance): stamp D1 with reason + closest approach.
      // bouncieMatchConfidence holds "<N>ft" so Tyler can see "missed by 800ft" vs "no GPS at all".
      // Infinity means no trips were scanned (rig had no data) — stored as null in that case.
      const _closestFtStr = isFinite(globalClosestDistKm) ? `${closestDistFt}ft` : null;
      results.push({
        jobId: row.jobId, name: rowName, status: 'no_reliable_match',
        note:  `No reliable proximity match. Best stop was ${closestDistFt} ft (${closestMi} mi) away — exceeds 500 ft threshold.`,
        closestRig: globalClosestRig, closestDistFt, closestArrival: globalClosestArrival,
      });
      d1FailureUpdates.push({ jobId: row.jobId, bouncieMatchStatus: 'no_reliable_match', bouncieMatchConfidence: _closestFtStr });
      continue;
    }

    // Determine confidence tier from actual GPS distance
    const geocodeDistKm = bestMatch.closestDistKm ?? haversineKm(
      jobLat, jobLon,
      tripLastCoord(bestMatch.arrivalTrip)?.[1],
      tripLastCoord(bestMatch.arrivalTrip)?.[0]);
    const geocodeDistFt = Math.round(geocodeDistKm * 3280.84);
    // Rig-segments: only one rig was searched, so rigsWithinThreshold.length===1 is trivially
    // true for any match — don't use it for confidence. Distance alone determines high/medium.
    // Standalone/multi-day: original logic (distance AND single rig present) — UNCHANGED.
    const isHigh   = row.isRigSegment
      ? geocodeDistKm <= HIGH_KM
      : geocodeDistKm <= HIGH_KM && rigsWithinThreshold.length === 1;
    const isMedium = geocodeDistKm <= MEDIUM_KM;
    const matchStatus = isHigh ? 'matched_high' : 'matched_medium';
    const intentRig   = row.rigId || ss.rig || null;

    // GPS timing data — written for both high and medium
    const timingData = {
      actualArrival:      bestMatch.arrivalTs,
      actualDeparture:    bestMatch.departureTs,
      actualDuration:     bestMatch.durationMin,
      durationSource:     'bouncie_gps',
      durationConfidence: matchStatus,
      autoAttributed:     true,
      ...(geocodeSource ? { geocodeSource } : {}),
    };

    // Rig attribution — ONLY for high-confidence matches
    if (isHigh) {
      // @ts-ignore — timingData shape is widened at runtime; rig fields added conditionally for high-confidence matches only
      timingData.actualRig   = bestRig;
      // @ts-ignore — see above
      timingData.intentRig   = intentRig !== bestRig ? intentRig : undefined;
      // @ts-ignore — see above
      timingData.rigsPresent = rigsWithinThreshold.length > 1 ? rigsWithinThreshold : undefined;
    }

    // KV mirror (T1.13) — write to jhEntry and/or ss when KV customer found.
    // If not found, D1 update below still runs — D1 is canonical post-Day 2.
    if (kvCust) {
      const jhEntry = (kvCust.jobHistory || []).slice().reverse().find(j => j.date === date);
      if (jhEntry) {
        Object.assign(jhEntry, timingData);
      }
      // Mirror to ss when it covers this job's date
      if (ss.scheduledDate === date || ss.completedAt?.startsWith(date)) {
        Object.assign(ss, timingData);
        // Rig auto-migration: high-confidence only
        if (isHigh && bestRig && ss.rig !== bestRig) {
          ss.intentRig = intentRig;
          ss.rig       = bestRig;
        }
      }
      // Rolling duration stats
      kvCust.lastJobDuration = bestMatch.durationMin;
      const allDurs = (kvCust.jobHistory || []).filter(j => j.actualDuration).map(j => j.actualDuration);
      if (ss.actualDuration) allDurs.push(ss.actualDuration);
      if (allDurs.length) {
        kvCust.avgJobDuration = Math.round(allDurs.reduce((a, b) => a + b, 0) / allDurs.length);
      }
      computeBouncieMetrics(kvCust);
      kvDirty.add(kvCust);
    } else {
      console.warn(`[Bouncie matcher] No KV customer for ${row.payerId} (${rowName}) — D1 update only`);
    }

    results.push({
      jobId:      row.jobId,
      name:       rowName,
      status:     matchStatus,
      actualRig:  isHigh ? bestRig : null,
      intentRig,
      rigChanged: isHigh && intentRig && intentRig !== bestRig,
      duration:   bestMatch.durationMin,
      geocodeDistFt,
      arrival:    bestMatch.arrivalTs,
      departure:  bestMatch.departureTs,
      rigsPresent: rigsWithinThreshold,
      ...(isMedium && !isHigh ? { note: 'Medium confidence — GPS within 500 ft but > 250 ft. Operator confirmation recommended.' } : {}),
    });

    // Accumulate for D1 update — keyed by jobId (survives Bug 4 UUID migration cleanly)
    d1BouncieUpdates.push({
      jobId:              row.jobId,
      actualDuration:     bestMatch.durationMin,
      actualArrival:      bestMatch.arrivalTs  || null,
      actualDeparture:    bestMatch.departureTs || null,
      bouncieMatchStatus: matchStatus,
      geocodeSource:      geocodeSource         || null,
    });
    matched++;
  }

  console.log(`[Bouncie matcher] Coords: cached=${coordsCached}, geocoded=${coordsGeocoded}, failed=${coordsFailed}`);
  console.log(`[Bouncie matcher] Match results: ${matched}/${d1Jobs.length} matched (high=${results.filter(r=>r.status==='matched_high').length}, medium=${results.filter(r=>r.status==='matched_medium').length}, unmatched=${d1Jobs.length - matched})`);

  // KV write-back — single PUT covering all dirty customers
  if (kvDirty.size > 0) {
    await env.DATA.put(KV_KEYS.customers, JSON.stringify(db));
    console.log(`[Bouncie matcher] KV mirror: ${kvDirty.size} customers updated`);
  }

  // D1 update — keyed by jobId, not payerId+scheduledDate (Bug 4 safe)
  const now = new Date().toISOString();
  let d1UpdateCount = 0;
  for (const upd of d1BouncieUpdates) {
    try {
      await env.DB.prepare(
        `UPDATE Job SET actualDuration=?, actualArrival=?, actualDeparture=?,
         bouncieMatchStatus=?, bouncieMatchConfidence=NULL, geocodeSource=?, modifiedAt=?
         WHERE jobId=?`
      ).bind(
        upd.actualDuration, upd.actualArrival, upd.actualDeparture,
        upd.bouncieMatchStatus, upd.geocodeSource, now,
        upd.jobId
      ).run();
      d1UpdateCount++;
    } catch(e) { await _logD1Failure(env, `bouncie_job_update:${upd.jobId}`, e.message); }
  }
  console.log(`[Bouncie matcher] D1 updates: ${d1UpdateCount}/${d1BouncieUpdates.length} succeeded`);

  // Fix 1: write failure reasons to D1 — separate UPDATE so it never touches actualDuration.
  // Only fires for jobs that were processed this run; pending (never-attempted) jobs stay NULL.
  // SQL omits actualDuration/actualArrival/actualDeparture — those remain NULL for retrying.
  let d1FailCount = 0;
  for (const fail of d1FailureUpdates) {
    try {
      await env.DB.prepare(
        `UPDATE Job SET bouncieMatchStatus=?, bouncieMatchConfidence=?, modifiedAt=?
         WHERE jobId=?`
      ).bind(fail.bouncieMatchStatus, fail.bouncieMatchConfidence, now, fail.jobId).run();
      d1FailCount++;
    } catch(e) { await _logD1Failure(env, `bouncie_fail_update:${fail.jobId}`, e.message); }
  }
  if (d1FailureUpdates.length > 0)
    console.log(`[Bouncie matcher] D1 failure stamps: ${d1FailCount}/${d1FailureUpdates.length} (geocode_failed=${d1FailureUpdates.filter(f=>f.bouncieMatchStatus==='geocode_failed').length}, no_data=${d1FailureUpdates.filter(f=>f.bouncieMatchStatus==='no_data').length}, no_reliable_match=${d1FailureUpdates.filter(f=>f.bouncieMatchStatus==='no_reliable_match').length})`);

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

  return { date, total: d1Jobs.length, matched, results, morningStops };
}

// ── TruckEvent persistence — Bouncie full event stream to D1 ─────────────────
// Phase 1 of Bouncie Full Event Stream doc (10Qeyqs1TRufTpOxSxbwpuwU240GfL-9J).
// Reuses buildDayRoute segment classification; writes TruckEvent rows to D1.

async function _fetchRigJobsForDate(date, rigId, env) {
  // Pull completed jobs for this rig+date from D1 with geocoords for proximity matching.
  // Used by persistTruckEventsForDate as the rigJobs input to buildDayRoute.
  return env.DB.prepare(
    `SELECT j.jobId, j.scheduledDate AS date, j.actualArrival,
            j.bouncieMatchStatus AS durationConfidence,
            j.servicesRaw AS services, j.amount,
            p2.latitude  AS geocodedLat, p2.longitude AS geocodedLng,
            p2.streetAddress AS address, p2.city,
            p1.firstName || ' ' || p1.lastName AS customerName,
            p1.primaryPhone AS phone
     FROM Job j
     JOIN Person p1 ON j.payerId = p1.personId
     LEFT JOIN PersonProperty pp ON pp.personId = j.payerId AND pp.primaryContact = 1
     LEFT JOIN Property p2 ON pp.propertyId = p2.propertyId
     WHERE j.scheduledDate = ? AND j.state = 'completed' AND j.rigId = ?`
  ).bind(date, rigId).all().then(r => r.results || []);
}

async function persistTruckEventsForDate(date, rigId, rigEntry, source, env) {
  const startsAfter = `${date}T00:00:00.000Z`;
  const endsBefore  = `${date}T23:59:59.000Z`;

  let res;
  try {
    res = await bouncieFetchWithRetry(
      `${BOUNCIE_API_BASE}/trips?imei=${rigEntry.imei}&gpsFormat=geojson` +
      `&startsAfter=${encodeURIComponent(startsAfter)}&endsBefore=${encodeURIComponent(endsBefore)}`,
      env
    );
  } catch(e) {
    return { rig: rigId, date, error: e.message, inserted: 0 };
  }

  const trips = res.ok ? await res.json() : [];
  const sortedTrips = Array.isArray(trips)
    ? trips.sort((a, b) => a.startTime < b.startTime ? -1 : 1)
    : [];
  if (!sortedTrips.length) return { rig: rigId, date, inserted: 0, reason: 'no_trips' };

  // Build route segments using existing classification logic (reuse don't rebuild — spec T1.5)
  const rigJobs = await _fetchRigJobsForDate(date, rigId, env);
  const route   = buildDayRoute(date, rigId, sortedTrips, rigJobs);

  const now   = new Date().toISOString();
  const stmts = [];
  const jobIdByArriveAt = new Map(); // arriveAt → jobId; used for post-INSERT drive-leg writes

  for (const seg of route.segments) {
    let id, eventType, startedAt, endedAt, durationSec,
        startLat, startLng, distMi, jobId, poiCategory, poiName, bouncieTripId, matchConf;

    if (seg.type === 'drive') {
      id            = `${rigId}-drive-${seg.startTime}`;
      eventType     = 'drive';
      startedAt     = seg.startTime;
      endedAt       = seg.endTime;
      durationSec   = Math.round((seg.durationMin || 0) * 60);
      distMi        = seg.distanceMiles || null;
      bouncieTripId = id; // deterministic synthetic ID — used for TRUCKEVENT_DUPLICATE gate

    } else if (seg.type === 'depart') {
      id        = `${rigId}-depart-${seg.time}`;
      eventType = 'depart_home';
      startedAt = seg.time;

    } else if (seg.type === 'return') {
      id        = `${rigId}-return-${seg.time}`;
      eventType = 'arrive_home';
      startedAt = seg.time;

    } else if (seg.type === 'arrive') {
      // Final stop at non-home location
      id        = `${rigId}-arrive-${seg.time}`;
      eventType = 'unknown_stop';
      startedAt = seg.time;

    } else if (seg.type === 'job') {
      id          = `${rigId}-job-${seg.arriveAt}`;
      eventType   = 'job_arrival';
      startedAt   = seg.arriveAt;
      endedAt     = seg.departAt;
      durationSec = Math.round((seg.durationMin || 0) * 60);
      matchConf   = seg.confidence || null;
      // Resolve D1 jobId: time match first, address match fallback
      const matched =
        rigJobs.find(j => j.actualArrival && Math.abs(+new Date(j.actualArrival) - +new Date(seg.arriveAt)) < 120000) ||
        rigJobs.find(j => (j.address || '') === (seg.address || '') && (j.city || '') === (seg.city || ''));
      jobId = matched?.jobId || null;
      if (jobId) jobIdByArriveAt.set(seg.arriveAt, jobId);

    } else if (seg.type === 'stop') {
      startedAt   = seg.arriveAt;
      endedAt     = seg.departAt;
      durationSec = Math.round((seg.durationMin || 0) * 60);
      if (seg.location === '7eleven') {
        id = `${rigId}-poi-gas-${seg.arriveAt}`;
        eventType = 'poi_stop'; poiCategory = 'gas'; poiName = seg.label || '7-Eleven';
      } else if (seg.location === 'proline') {
        id = `${rigId}-poi-chem-${seg.arriveAt}`;
        eventType = 'poi_stop'; poiCategory = 'chemicals'; poiName = seg.label || 'Pro-Line';
      } else if (seg.location === 'home') {
        id = `${rigId}-arrive-home-${seg.arriveAt}`;
        eventType = 'arrive_home'; poiCategory = 'home_base';
      } else {
        id = `${rigId}-unknown-${seg.arriveAt}`;
        eventType = 'unknown_stop';
        startLat  = seg.coords?.lat || null;
        startLng  = seg.coords?.lng || null;
      }
    } else {
      continue; // unknown segment type — skip
    }

    if (!id || !startedAt) continue;

    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO TruckEvent
           (id,rigId,eventType,startedAt,endedAt,durationSeconds,
            startLat,startLng,endLat,endLng,distanceMiles,
            jobId,poiCategory,poiName,source,bouncieTripId,matchConfidence,
            createdAt,modifiedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id, rigId, eventType, startedAt, endedAt||null, durationSec||null,
        startLat||null, startLng||null, null, null, distMi||null,
        jobId||null, poiCategory||null, poiName||null,
        source, bouncieTripId||null, matchConf||null,
        now, now
      )
    );
  }

  if (!stmts.length) return { rig: rigId, date, inserted: 0, reason: 'no_segments' };

  const batchResults = await env.DB.batch(stmts);
  const inserted = batchResults.reduce((s, r) => s + (r.meta?.changes || 0), 0);

  // Write arriving drive leg to each Job row — drive segment immediately before job in route.
  // IS NULL guard: idempotent on re-run; never clobbers a manually-entered value.
  const driveUpdateStmts = [];
  for (let i = 1; i < route.segments.length; i++) {
    const seg  = route.segments[i];
    const prev = route.segments[i - 1];
    if (seg.type !== 'job' || prev?.type !== 'drive') continue;
    const jid = jobIdByArriveAt.get(seg.arriveAt);
    if (!jid) continue;
    driveUpdateStmts.push(
      env.DB.prepare(
        `UPDATE Job SET drivetimeFromPreviousJob=?, milesFromPreviousJob=?, modifiedAt=?
         WHERE jobId=? AND drivetimeFromPreviousJob IS NULL`
      ).bind(
        prev.durationMin != null ? Math.round(prev.durationMin) : null,
        prev.distanceMiles ?? null,
        now,
        jid
      )
    );
  }
  const driveLegsWritten = driveUpdateStmts.length
    ? (await env.DB.batch(driveUpdateStmts)).reduce((s, r) => s + (r.meta?.changes || 0), 0)
    : 0;

  return { rig: rigId, date, events: stmts.length, inserted, skipped: stmts.length - inserted, driveLegsWritten };
}

async function persistTruckEventsNightly(date, env) {
  const rigMapping = await env.DATA.get('bouncie:rig_mapping', 'json') || {};
  const rigEntries = Object.entries(rigMapping).filter(([, re]) => re?.imei);
  if (!rigEntries.length) return { date, results: [], totalInserted: 0 };

  const results = await Promise.all(
    rigEntries.map(([rigId, rigEntry]) =>
      persistTruckEventsForDate(date, rigId, rigEntry, 'bouncie_cron', env)
        .catch(e => ({ rig: rigId, date, error: e.message, inserted: 0 }))
    )
  );

  const totalInserted = results.reduce((s, r) => s + (r.inserted || 0), 0);
  await env.DATA.put('truckevent:last_cron_run', JSON.stringify({
    ranAt: new Date().toISOString(), date, results, totalInserted,
  }));
  return { date, results, totalInserted };
}

async function handleTruckEventBackfill(request, env, corsHeaders) {
  const body     = await request.json().catch(() => ({}));
  const toDate   = body.toDate   || new Date().toISOString().slice(0, 10);
  const fromDate = body.fromDate || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const rigMapping = await env.DATA.get('bouncie:rig_mapping', 'json') || {};
  const rigEntries = Object.entries(rigMapping).filter(([, re]) => re?.imei);
  if (!rigEntries.length) {
    return jsonResponse({ error: 'No rigs in bouncie:rig_mapping' }, corsHeaders, 400);
  }

  // Build date list (noon UTC on each day avoids DST boundary edge cases)
  const dates = [];
  const cur = new Date(fromDate + 'T12:00:00Z');
  const end = new Date(toDate   + 'T12:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const allResults = [];
  // Sequential dates — avoids hammering Bouncie; parallel rigs per date is fine (reads only)
  for (const date of dates) {
    const rigResults = await Promise.all(
      rigEntries.map(([rigId, rigEntry]) =>
        persistTruckEventsForDate(date, rigId, rigEntry, 'bouncie_backfill', env)
          .catch(e => ({ rig: rigId, date, error: e.message, inserted: 0 }))
      )
    );
    allResults.push(...rigResults);
  }

  const totalInserted = allResults.reduce((s, r) => s + (r.inserted || 0), 0);
  // @ts-ignore — allResults union: events field present on success branch, absent on error branch; || 0 guards safely
  const totalEvents   = allResults.reduce((s, r) => s + (r.events   || 0), 0);
  return jsonResponse({
    fromDate, toDate,
    datesProcessed: dates.length,
    totalEvents,
    totalInserted,
    results: allResults,
  }, corsHeaders);
}

// ── Places resolver: placeId → structured address ─────────────────────────────
// Hits Google Places "place details" with address_components so the partner-flow
// entry guard can turn a picker-only submission into a real worksite Property.
// Idempotent / read-only — no D1/KV writes here, only Google API call.
async function handlePlacesResolve(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body || !body.placeId)
    return jsonResponse({ success: false, error: 'placeId required' }, corsHeaders, 400);
  if (!env.GOOGLE_PLACES_API_KEY)
    return jsonResponse({ success: false, error: 'places_api_key_missing' }, corsHeaders, 503);

  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?` +
      `place_id=${encodeURIComponent(body.placeId)}` +
      `&fields=address_components,formatted_address,geometry,name,types` +
      `&key=${env.GOOGLE_PLACES_API_KEY}`
    );
    const data = await res.json();
    if (data.status !== 'OK' || !data.result)
      return jsonResponse({ success: false, error: 'places_lookup_failed', detail: data.status, message: data.error_message || null }, corsHeaders, 502);

    const comps = data.result.address_components || [];
    const find  = (type) => comps.find(c => (c.types || []).includes(type));
    const num   = find('street_number')?.long_name || '';
    const route = find('route')?.long_name || '';
    const streetAddress = [num, route].filter(Boolean).join(' ').trim() || null;
    const city  = find('locality')?.long_name
               || find('postal_town')?.long_name
               || find('sublocality')?.long_name
               || find('administrative_area_level_3')?.long_name
               || null;
    const state = find('administrative_area_level_1')?.short_name || null;
    const zip   = find('postal_code')?.long_name || null;
    const loc   = data.result.geometry?.location || {};

    return jsonResponse({
      success:          true,
      placeId:          body.placeId,
      streetAddress,
      city,
      state,
      zip,
      latitude:         loc.lat ?? null,
      longitude:        loc.lng ?? null,
      formattedAddress: data.result.formatted_address || null,
      name:             data.result.name || null,
      types:            data.result.types || null,
    }, corsHeaders);
  } catch(e) {
    return jsonResponse({ success: false, error: 'places_network_error', detail: e.message }, corsHeaders, 502);
  }
}

// ── Property creation: Property + PersonProperty link ─────────────────────────

async function handleCreateProperty(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  const {
    personId, streetAddress, city, zip, propertyType, propertyLabel, primaryContact,
    googlePlaceId, formattedAddress, latitude, longitude,
  } = body;
  if (!personId)      return jsonResponse({ error: 'personId required' }, corsHeaders, 400);
  if (!streetAddress) return jsonResponse({ error: 'streetAddress required' }, corsHeaders, 400);
  if (!city)          return jsonResponse({ error: 'city required' }, corsHeaders, 400);
  if (!propertyLabel) return jsonResponse({ error: 'propertyLabel required' }, corsHeaders, 400);

  const VALID_TYPES = ['main_residence','rental','vacation','investment','other'];
  if (propertyType && !VALID_TYPES.includes(propertyType)) {
    return jsonResponse({ error: `propertyType must be one of: ${VALID_TYPES.join(', ')}` }, corsHeaders, 400);
  }

  // Verify person exists
  const person = await env.DB.prepare('SELECT personId, primaryPhone FROM Person WHERE personId=?')
    .bind(personId).first();
  if (!person) return jsonResponse({ error: `Person not found: ${personId}` }, corsHeaders, 404);

  const now = new Date().toISOString();

  try {
    let propertyId;
    let dedupedExisting = false;

    // Dedup by googlePlaceId: if place_id matches an existing Property, reuse it
    if (googlePlaceId) {
      const existing = await env.DB.prepare('SELECT propertyId FROM Property WHERE googlePlaceId=?')
        .bind(googlePlaceId).first();
      if (existing) {
        propertyId = existing.propertyId;
        dedupedExisting = true;
      }
    }

    if (!propertyId) {
      propertyId = _d1PropId(streetAddress, city);
      const googleVerified = googlePlaceId ? 1 : 0;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO Property
           (propertyId, googlePlaceId, formattedAddress, streetAddress, city, state, zip,
            latitude, longitude, googleVerified, createdAt, modifiedAt)
         VALUES (?, ?, ?, ?, ?, 'FL', ?, ?, ?, ?, ?, ?)`
      ).bind(
        propertyId, googlePlaceId || null, formattedAddress || null,
        streetAddress.trim(), city.trim(), zip || null,
        latitude || null, longitude || null, googleVerified, now, now
      ).run();
    }

    // Demote any existing primary if the new property is being set as primary
    if (primaryContact) {
      await env.DB.prepare('UPDATE PersonProperty SET primaryContact=0 WHERE personId=?').bind(personId).run();
    }
    // INSERT PersonProperty link (IGNORE if already linked)
    await env.DB.prepare(
      `INSERT OR IGNORE INTO PersonProperty
         (personId, propertyId, relationship, primaryContact, propertyLabel, propertyType)
       VALUES (?, ?, 'owner', ?, ?, ?)`
    ).bind(personId, propertyId, primaryContact ? 1 : 0, propertyLabel.trim(), propertyType || null).run();

    // Mirror to KV: refresh this customer's cached record (Law T1.13)
    const ph = (person.primaryPhone||'').replace(/\D/g,'').slice(-10);
    if (ph.length === 10) {
      const updatedCustomer = await d1CustomerToKvShape(ph, env);
      if (updatedCustomer) {
        const kvDb = await env.DATA.get('customer_db', 'json') || { customers: [] };
        const idx  = (kvDb.customers||[]).findIndex(c =>
          (c.phone||'').replace(/\D/g,'').slice(-10) === ph
        );
        if (idx >= 0) kvDb.customers[idx] = updatedCustomer;
        else kvDb.customers.push(updatedCustomer);
        await env.DATA.put('customer_db', JSON.stringify(kvDb));
      }
    }

    return jsonResponse({
      success: true, propertyId, dedupedExisting,
      propertyLabel: propertyLabel.trim(), propertyType: propertyType || null,
    }, corsHeaders);
  } catch(e) {
    await _logD1Failure(env, `handleCreateProperty:${personId}`, e.message);
    return jsonResponse({ error: e.message }, corsHeaders, 500);
  }
}

// ── PATCH /admin/person/{personId} ───────────────────────────────────────────
// Updates whitelisted Person fields in D1 and refreshes the KV customer record.
// Whitelisted: email, firstName, lastName, businessName, primaryPhone.
// Stamps modifiedAt. Returns the updated Person row.
async function handlePatchPerson(request, personId, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  if (!personId) return jsonResponse({ error: 'personId required' }, corsHeaders, 400);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object')
    return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  const ALLOWED = ['email', 'firstName', 'lastName', 'businessName'];
  const fields = {};
  for (const k of ALLOWED) {
    if (k in body) fields[k] = body[k] ?? null;
  }
  if (!Object.keys(fields).length)
    return jsonResponse({ error: `no writable fields provided; allowed: ${ALLOWED.join(', ')}` }, corsHeaders, 400);

  const now = new Date().toISOString();
  fields.modifiedAt = now;

  const setClauses = Object.keys(fields).map(f => `${f}=?`).join(', ');
  const setValues  = Object.values(fields);

  try {
    const result = await env.DB.prepare(
      `UPDATE Person SET ${setClauses} WHERE personId=?`
    ).bind(...setValues, personId).run();

    if (!result.meta?.changes) return jsonResponse({ error: 'person not found' }, corsHeaders, 404);

    // Refresh KV — reverse personId to 10-digit phone for d1CustomerToKvShape
    if (personId.startsWith('person_1') && personId.length >= 18) {
      const ph = personId.slice('person_1'.length);
      if (ph.length === 10) {
        const updatedCustomer = await d1CustomerToKvShape(ph, env).catch(() => null);
        if (updatedCustomer && env.DATA) {
          const kvDb = await env.DATA.get('customer_db', 'json') || { customers: [] };
          const idx  = (kvDb.customers || []).findIndex(c =>
            (c.phone || '').replace(/\D/g, '').slice(-10) === ph
          );
          if (idx >= 0) kvDb.customers[idx] = updatedCustomer;
          else kvDb.customers.push(updatedCustomer);
          await env.DATA.put('customer_db', JSON.stringify(kvDb));
        }
      }
    }

    const updated = await env.DB.prepare('SELECT * FROM Person WHERE personId=?').bind(personId).first();
    return jsonResponse({ success: true, person: updated }, corsHeaders);
  } catch (e) {
    await _logD1Failure(env, `handlePatchPerson:${personId}`, e.message);
    return jsonResponse({ error: 'D1 update failed', detail: e.message }, corsHeaders, 500);
  }
}

// ── Commercial Pillar: Proposal endpoints ────────────────────────────────────

// POST /admin/proposal
// Creates a draft Proposal + its LineItems in a single transactional batch.
// Increments DocumentCounter atomically (INSERT...ON CONFLICT DO UPDATE RETURNING).
// proposalId = PROP-{C|R}-{YYYY}-{MMDD}-{NNN} and is the human-readable PK.
async function handleCreateProposal(request, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object')
    return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  const { personId, sector = 'commercial', lineItems, discountAmt,
          proposalDate, validUntil, subject, introText, closingText,
          paymentTerms, notes, internalNotes } = body;

  if (!personId)   return jsonResponse({ error: 'personId required' }, corsHeaders, 400);
  if (!lineItems?.length) return jsonResponse({ error: 'lineItems[] required (min 1)' }, corsHeaders, 400);
  if (!['commercial','residential'].includes(sector))
    return jsonResponse({ error: "sector must be 'commercial' or 'residential'" }, corsHeaders, 400);

  // 1. Validate person + email
  const person = await env.DB.prepare(
    'SELECT personId, firstName, lastName, email FROM Person WHERE personId=?'
  ).bind(personId).first();
  if (!person) return jsonResponse({ error: 'person not found' }, corsHeaders, 404);
  if (!person.email)
    return jsonResponse({
      error: 'email required for proposals',
      hint: `PATCH /admin/person/${personId} to set email before creating a proposal`,
    }, corsHeaders, 422);

  // 2. Atomic counter increment
  const now     = new Date();
  const year    = now.getUTCFullYear();
  const mm      = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd      = String(now.getUTCDate()).padStart(2, '0');
  const sCode   = sector === 'commercial' ? 'C' : 'R';
  const typeKey = 'proposal';
  const ctrId   = `${sector}-${typeKey}-${year}`;

  const ctrRow = await env.DB.prepare(`
    INSERT INTO DocumentCounter (counterId, sector, docType, year, lastSeq)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(sector, docType, year) DO UPDATE SET lastSeq = lastSeq + 1
    RETURNING lastSeq
  `).bind(ctrId, sector, typeKey, year).first();

  if (!ctrRow?.lastSeq)
    return jsonResponse({ error: 'counter increment failed' }, corsHeaders, 500);

  const seq        = String(ctrRow.lastSeq).padStart(3, '0');
  const proposalId = `PROP-${sCode}-${year}-${mm}${dd}-${seq}`;
  const pDate      = proposalDate || now.toISOString().slice(0, 10);
  const createdAt  = now.toISOString();

  // 3. Compute totals
  const subtotal = lineItems.reduce((s, li) => s + (Number(li.lineTotal) || 0), 0);
  const total    = Math.max(0, subtotal - (Number(discountAmt) || 0));

  // 4. Batch: Proposal row + all LineItem rows (transactional)
  const stmts = [
    env.DB.prepare(`
      INSERT INTO Proposal
        (proposalId, personId, sector, status, proposalDate, validUntil,
         subject, introText, closingText, subtotal, discountAmt, total,
         paymentTerms, notes, internalNotes, createdAt, modifiedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      proposalId, personId, sector, 'draft', pDate,
      validUntil ?? null, subject ?? null, introText ?? null, closingText ?? null,
      subtotal, discountAmt ?? null, total, paymentTerms ?? null,
      notes ?? null, internalNotes ?? null, createdAt, createdAt
    ),
    ...lineItems.map((li, i) =>
      env.DB.prepare(`
        INSERT INTO LineItem
          (lineItemId, documentType, documentId, sortOrder,
           description, quantity, unit, unitPrice, lineTotal, notes, createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        `${proposalId}-li-${i}`, 'proposal', proposalId,
        li.sortOrder ?? i,
        li.description ?? '', Number(li.quantity) || 1,
        li.unit ?? null, Number(li.unitPrice) || 0,
        Number(li.lineTotal) || 0, li.notes ?? null, createdAt
      )
    ),
  ];

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    await _logD1Failure(env, `handleCreateProposal:${proposalId}`, e.message);
    return jsonResponse({ error: 'D1 insert failed', detail: e.message }, corsHeaders, 500);
  }

  return jsonResponse({
    proposalId,
    total,
    subtotal,
    lineItemCount: lineItems.length,
  }, corsHeaders, 201);
}

// GET /admin/proposal/{proposalId}
// Returns Proposal row + LineItems (ordered by sortOrder) + person name/email.
async function handleGetProposal(proposalId, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  if (!proposalId) return jsonResponse({ error: 'proposalId required' }, corsHeaders, 400);

  const [proposal, lineItemsResult] = await Promise.all([
    env.DB.prepare(`
      SELECT p.*, pe.firstName, pe.lastName, pe.email, pe.primaryPhone,
             pe.businessName, pe.customerType
      FROM Proposal p
      JOIN Person pe ON pe.personId = p.personId
      WHERE p.proposalId = ?
    `).bind(proposalId).first(),
    env.DB.prepare(`
      SELECT * FROM LineItem
      WHERE documentType = 'proposal' AND documentId = ?
      ORDER BY sortOrder ASC
    `).bind(proposalId).all(),
  ]);

  if (!proposal) return jsonResponse({ error: 'proposal not found' }, corsHeaders, 404);

  return jsonResponse({
    proposal,
    lineItems: lineItemsResult.results || [],
  }, corsHeaders);
}

// PATCH /admin/proposal/{proposalId}
// Edits a DRAFT proposal. Replaces all LineItems and recomputes totals.
// 409 if status !== 'draft' (can't silently edit a sent/accepted proposal).
// proposalId (the document number) is immutable — only content changes.
async function handlePatchProposal(request, proposalId, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  if (!proposalId) return jsonResponse({ error: 'proposalId required' }, corsHeaders, 400);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object')
    return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  // 1. Fetch current proposal — must exist and be draft
  const existing = await env.DB.prepare(
    'SELECT proposalId, status, personId FROM Proposal WHERE proposalId = ?'
  ).bind(proposalId).first();

  if (!existing) return jsonResponse({ error: 'proposal not found' }, corsHeaders, 404);
  if (existing.status !== 'draft')
    return jsonResponse({
      error: 'cannot edit a proposal that has already been sent or accepted',
      status: existing.status,
    }, corsHeaders, 409);

  const now = new Date().toISOString();
  const { lineItems, discountAmt, subject, introText, closingText,
          paymentTerms, proposalDate, validUntil, notes, internalNotes } = body;

  // 2. Compute new totals if lineItems provided
  let subtotal = null;
  let total    = null;
  if (lineItems?.length) {
    subtotal = lineItems.reduce((s, li) => s + (Number(li.lineTotal) || 0), 0);
    total    = Math.max(0, subtotal - (Number(discountAmt ?? body.discountAmt) || 0));
  }

  // 3. Build Proposal UPDATE fields (only set fields that were provided)
  const fields = {};
  if (subject      !== undefined) fields.subject      = subject;
  if (introText    !== undefined) fields.introText    = introText;
  if (closingText  !== undefined) fields.closingText  = closingText;
  if (paymentTerms !== undefined) fields.paymentTerms = paymentTerms;
  if (proposalDate !== undefined) fields.proposalDate = proposalDate;
  if (validUntil   !== undefined) fields.validUntil   = validUntil;
  if (notes        !== undefined) fields.notes        = notes;
  if (internalNotes!== undefined) fields.internalNotes= internalNotes;
  if (discountAmt  !== undefined) fields.discountAmt  = discountAmt ?? null;
  if (subtotal     !== null)      fields.subtotal     = subtotal;
  if (total        !== null)      fields.total        = total;
  fields.modifiedAt = now;

  const setClauses = Object.keys(fields).map(k => `${k}=?`).join(', ');
  const setValues  = Object.values(fields);

  // 4. Batch: UPDATE Proposal + DELETE existing LineItems + INSERT new LineItems
  const stmts = [
    env.DB.prepare(`UPDATE Proposal SET ${setClauses} WHERE proposalId=?`)
      .bind(...setValues, proposalId),
  ];

  if (lineItems?.length) {
    stmts.push(
      env.DB.prepare(
        `DELETE FROM LineItem WHERE documentType='proposal' AND documentId=?`
      ).bind(proposalId)
    );
    lineItems.forEach((li, i) => {
      stmts.push(
        env.DB.prepare(`
          INSERT INTO LineItem
            (lineItemId, documentType, documentId, sortOrder,
             description, quantity, unit, unitPrice, lineTotal, notes, createdAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          `${proposalId}-li-${now.replace(/\D/g,'').slice(0,14)}-${i}`,
          'proposal', proposalId, li.sortOrder ?? i,
          li.description ?? '', Number(li.quantity) || 1,
          li.unit ?? null, Number(li.unitPrice) || 0,
          Number(li.lineTotal) || 0, li.notes ?? null, now
        )
      );
    });
  }

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    await _logD1Failure(env, `handlePatchProposal:${proposalId}`, e.message);
    return jsonResponse({ error: 'D1 update failed', detail: e.message }, corsHeaders, 500);
  }

  // 5. Return updated proposal
  return await handleGetProposal(proposalId, env, corsHeaders);
}

// ── POST /admin/retype-customer ──────────────────────────────────────────────
// Sets customerType on multiple customers atomically in both D1 and KV.
// Body: { phones: ['9546660001', ...], customerType: 'partner_referral' }
// Bypasses PUT /customers sync path; safe to call after correcting mislabeled records.
async function handleRetypeCustomer(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);
  const { phones, customerType } = body;
  if (!Array.isArray(phones) || !phones.length)
    return jsonResponse({ error: 'phones array required' }, corsHeaders, 400);
  const ALLOWED_TYPES = ['partner_referral', 'commercial', 'residential'];
  if (!ALLOWED_TYPES.includes(customerType))
    return jsonResponse({ error: `customerType must be one of: ${ALLOWED_TYPES.join(', ')}` }, corsHeaders, 400);

  const updated = [], failed = [];
  const now = new Date().toISOString();
  const kvDb = await env.DATA.get('customer_db', 'json') || { customers: [] };

  for (const rawPhone of phones) {
    const ph = (rawPhone||'').replace(/\D/g,'').slice(-10);
    if (!ph || ph.length !== 10) { failed.push({ phone: rawPhone, error: 'invalid phone' }); continue; }
    const personId = _d1PersonId(ph);
    try {
      await env.DB.prepare(
        'UPDATE Person SET customerType=?, modifiedAt=? WHERE personId=?'
      ).bind(customerType, now, personId).run();

      const updatedCustomer = await d1CustomerToKvShape(ph, env);
      if (updatedCustomer) {
        const idx = (kvDb.customers||[]).findIndex(c =>
          (c.phone||'').replace(/\D/g,'').slice(-10) === ph
        );
        if (idx >= 0) kvDb.customers[idx] = updatedCustomer;
        else kvDb.customers.push(updatedCustomer);
      }
      updated.push({ phone: ph, personId, customerType });
    } catch(e) {
      await _logD1Failure(env, `handleRetypeCustomer:${personId}`, e.message);
      failed.push({ phone: ph, personId, error: e.message });
    }
  }

  if (updated.length) await env.DATA.put('customer_db', JSON.stringify(kvDb));
  return jsonResponse({ success: true, updated, failed }, corsHeaders);
}

// ── PATCH /admin/person-property ─────────────────────────────────────────────
// Updates the label for a specific person+property link in PersonProperty.
// Body: { personId, propertyId, propertyLabel }
// Refreshes KV after D1 write so the label surfaces immediately on the calendar.
async function handlePatchPersonProperty(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  const { personId, propertyId, propertyLabel } = body;
  if (!personId)   return jsonResponse({ error: 'personId required' }, corsHeaders, 400);
  if (!propertyId) return jsonResponse({ error: 'propertyId required' }, corsHeaders, 400);
  if (propertyLabel === undefined || propertyLabel === null)
    return jsonResponse({ error: 'propertyLabel required' }, corsHeaders, 400);

  try {
    // Confirm the PersonProperty link exists
    const link = await env.DB.prepare(
      'SELECT personId FROM PersonProperty WHERE personId=? AND propertyId=?'
    ).bind(personId, propertyId).first();
    if (!link) return jsonResponse({ error: 'PersonProperty link not found' }, corsHeaders, 404);

    // PersonProperty has no modifiedAt column — update label only
    await env.DB.prepare(
      `UPDATE PersonProperty SET propertyLabel=? WHERE personId=? AND propertyId=?`
    ).bind(propertyLabel.trim(), personId, propertyId).run();

    // KV refresh — mirror handleCreateProperty pattern (Law T1.13)
    const person = await env.DB.prepare(
      'SELECT primaryPhone FROM Person WHERE personId=?'
    ).bind(personId).first();
    if (person) {
      const ph = (person.primaryPhone||'').replace(/\D/g,'').slice(-10);
      if (ph.length === 10) {
        const updatedCustomer = await d1CustomerToKvShape(ph, env);
        if (updatedCustomer) {
          const kvDb = await env.DATA.get('customer_db', 'json') || { customers: [] };
          const idx  = (kvDb.customers||[]).findIndex(c =>
            (c.phone||'').replace(/\D/g,'').slice(-10) === ph
          );
          if (idx >= 0) kvDb.customers[idx] = updatedCustomer;
          else kvDb.customers.push(updatedCustomer);
          await env.DATA.put('customer_db', JSON.stringify(kvDb));
        }
      }
    }

    return jsonResponse({ success: true, personId, propertyId, propertyLabel: propertyLabel.trim() }, corsHeaders);
  } catch(e) {
    await _logD1Failure(env, `handlePatchPersonProperty:${personId}:${propertyId}`, e.message);
    return jsonResponse({ error: e.message }, corsHeaders, 500);
  }
}

// ── POST /admin/address-gate ─────────────────────────────────────────────────
// Human-confirmed address resolution. Three outcomes:
//   action='correction'              → UPDATE primary Property text in place
//   action='move' + primaryContact=1 → new Property + promote + re-point open jobs
//   action='move' + primaryContact=0 → new Property as secondary (no demote, no re-point)
// All three outcomes refresh KV. Returns full property list for the person.
// Canonical label list locked June 1, 2026.
// ─────────────────────────────────────────────────────────────────────────────

const _CANONICAL_PROP_LABELS = new Set([
  'Main Residence', 'Rental Property', "Friend's Property",
  "Parent's / Relative's", 'Vacation Home', 'Office / Commercial', 'Other',
]);

async function handleAddressGate(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);

  const {
    personId, action, streetAddress, city,
    primaryContact, propertyLabel, propertyType,
    propertyId: targetPropertyId,   // used by action='set-primary'
  } = body;

  if (!personId)
    return jsonResponse({ error: 'personId required' }, corsHeaders, 400);
  if (!action || !['correction','move','set-primary'].includes(action))
    return jsonResponse({ error: "action must be 'correction', 'move', or 'set-primary'" }, corsHeaders, 400);
  if (action !== 'set-primary') {
    if (!streetAddress) return jsonResponse({ error: 'streetAddress required' }, corsHeaders, 400);
    if (!city)          return jsonResponse({ error: 'city required' }, corsHeaders, 400);
  }
  if (action === 'move') {
    if (primaryContact === undefined || primaryContact === null)
      return jsonResponse({ error: "primaryContact (true|false) required for action='move'" }, corsHeaders, 400);
    if (!propertyLabel)
      return jsonResponse({ error: "propertyLabel required for action='move'" }, corsHeaders, 400);
    if (!_CANONICAL_PROP_LABELS.has(propertyLabel))
      return jsonResponse({
        error: `propertyLabel must be one of: ${[..._CANONICAL_PROP_LABELS].join(', ')}`,
      }, corsHeaders, 400);
  }
  if (action === 'set-primary' && !targetPropertyId)
    return jsonResponse({ error: 'propertyId required for action=set-primary' }, corsHeaders, 400);

  const person = await env.DB.prepare(
    'SELECT personId, primaryPhone FROM Person WHERE personId=?'
  ).bind(personId).first();
  if (!person) return jsonResponse({ error: `Person not found: ${personId}` }, corsHeaders, 404);

  const ph  = (person.primaryPhone||'').replace(/\D/g,'').slice(-10);
  const now = new Date().toISOString();

  const primaryProp = await env.DB.prepare(
    `SELECT pr.propertyId, pr.streetAddress, pr.city
     FROM PersonProperty pp JOIN Property pr ON pp.propertyId=pr.propertyId
     WHERE pp.personId=? AND pp.primaryContact=1 LIMIT 1`
  ).bind(personId).first();

  try {
    if (action === 'set-primary') {
      // SET PRIMARY: demote all existing, promote target, re-point open jobs.
      // Completed jobs keep their historical propertyId — never rewrite history.
      const _spLink = await env.DB.prepare(
        'SELECT personId FROM PersonProperty WHERE personId=? AND propertyId=?'
      ).bind(personId, targetPropertyId).first();
      if (!_spLink)
        return jsonResponse({ error: 'PersonProperty link not found' }, corsHeaders, 404);
      await env.DB.prepare('UPDATE PersonProperty SET primaryContact=0 WHERE personId=?').bind(personId).run();
      await env.DB.prepare(
        'UPDATE PersonProperty SET primaryContact=1 WHERE personId=? AND propertyId=?'
      ).bind(personId, targetPropertyId).run();
      await env.DB.prepare(
        `UPDATE Job SET propertyId=?, modifiedAt=? WHERE payerId=? AND state IN ('scheduled','in_progress')`
      ).bind(targetPropertyId, now, personId).run();

    } else if (action === 'correction') {
      // UPDATE primary Property text in place — no new row, no FK changes
      if (!primaryProp)
        return jsonResponse({ error: 'No primary property found for this person' }, corsHeaders, 404);
      await env.DB.prepare(
        'UPDATE Property SET streetAddress=?, city=?, modifiedAt=? WHERE propertyId=?'
      ).bind(streetAddress.trim(), city.trim(), now, primaryProp.propertyId).run();

    } else {
      // MOVE: create new Property row
      const propId = _d1PropId(streetAddress, city);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO Property
           (propertyId,streetAddress,city,state,createdAt,modifiedAt,migratedFrom,migrationVersion,migratedAt,migrationConfidence)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(propId, streetAddress.trim(), city.trim(), 'FL', now, now,
             'address_gate', 'v3_gate', now, 'high').run();

      const VALID_TYPES = ['main_residence','rental','vacation','investment','other'];
      const safeType = (propertyType && VALID_TYPES.includes(propertyType)) ? propertyType : null;

      if (primaryContact) {
        // MOVE + PRIMARY: demote all existing, insert/promote new, re-point open jobs
        // Completed jobs keep their historical propertyId — never rewrite history.
        await env.DB.prepare('UPDATE PersonProperty SET primaryContact=0 WHERE personId=?').bind(personId).run();
        await env.DB.prepare(
          `INSERT OR IGNORE INTO PersonProperty
             (personId,propertyId,relationship,primaryContact,propertyLabel,propertyType)
           VALUES (?,?,?,?,?,?)`
        ).bind(personId, propId, 'owner', 1, propertyLabel.trim(), safeType).run();
        await env.DB.prepare(
          'UPDATE PersonProperty SET primaryContact=1, propertyLabel=?, propertyType=? WHERE personId=? AND propertyId=?'
        ).bind(propertyLabel.trim(), safeType, personId, propId).run();
        await env.DB.prepare(
          `UPDATE Job SET propertyId=?, modifiedAt=? WHERE payerId=? AND state IN ('scheduled','in_progress')`
        ).bind(propId, now, personId).run();
      } else {
        // MOVE + SECONDARY: add labeled secondary — no demote, no job re-point
        // Existing primary stays primary. This is the Janille-mom case.
        await env.DB.prepare(
          `INSERT OR IGNORE INTO PersonProperty
             (personId,propertyId,relationship,primaryContact,propertyLabel,propertyType)
           VALUES (?,?,?,?,?,?)`
        ).bind(personId, propId, 'owner', 0, propertyLabel.trim(), safeType).run();
        // If row pre-existed with different label, update it (INSERT OR IGNORE won't overwrite)
        await env.DB.prepare(
          'UPDATE PersonProperty SET propertyLabel=?, propertyType=? WHERE personId=? AND propertyId=? AND primaryContact=0'
        ).bind(propertyLabel.trim(), safeType, personId, propId).run();
      }
    }

    // Refresh KV for this person (Law T1.13 — mirror handleCreateProperty pattern)
    if (ph.length === 10) {
      const updatedCustomer = await d1CustomerToKvShape(ph, env);
      if (updatedCustomer) {
        const kvDb = await env.DATA.get(KV_KEYS.customers, 'json') || { customers: [] };
        const idx  = (kvDb.customers||[]).findIndex(c =>
          (c.phone||'').replace(/\D/g,'').slice(-10) === ph
        );
        if (idx >= 0) kvDb.customers[idx] = updatedCustomer;
        else kvDb.customers.push(updatedCustomer);
        await env.DATA.put(KV_KEYS.customers, JSON.stringify(kvDb));
      }
    }

    // Return final property state for the person
    const props = await env.DB.prepare(
      `SELECT pr.propertyId, pr.streetAddress, pr.city, pr.state, pr.zip,
              pp.primaryContact, pp.propertyLabel, pp.propertyType
       FROM PersonProperty pp JOIN Property pr ON pp.propertyId=pr.propertyId
       WHERE pp.personId=?
       ORDER BY pp.primaryContact DESC, pr.streetAddress`
    ).bind(personId).all();

    return jsonResponse({ success: true, action, personId, properties: props.results || [] }, corsHeaders);

  } catch(e) {
    await _logD1Failure(env, `handleAddressGate:${personId}:${action}`, e.message);
    return jsonResponse({ error: e.message }, corsHeaders, 500);
  }
}

// ── Google Places API proxy + KV cache ────────────────────────────────────────
// Law T1.14: API key stays server-side. All Places calls go through these endpoints.
// Autocomplete: typeahead search — minimal caching (inputs are mostly unique).
// Details: place_id lookup — KV cached 30 days (same place rarely changes address).
// Session tokens: cost optimization — caller generates UUID per focus session,
//   passes same token to all autocomplete + one details call → billed as 1 session.

async function handlePlacesAutocomplete(request, env, corsHeaders, url) {
  const input       = (url.searchParams.get('input') || '').trim();
  const sessiontoken = url.searchParams.get('sessiontoken') || '';
  if (!input) return jsonResponse({ predictions: [], source: 'empty' }, corsHeaders);

  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key)  return jsonResponse({ error: 'GOOGLE_PLACES_API_KEY not configured' }, corsHeaders, 503);

  // Build Places Autocomplete request (legacy API — address types, US-only, South FL bias)
  const params = new URLSearchParams({
    input,
    sessiontoken,
    types:      'address',
    components: 'country:us',
    location:   '26.0,-80.2',   // South Florida centroid
    radius:     '80000',         // 80 km radius bias (not strict)
    key,
  });
  const apiUrl = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`;

  try {
    const res  = await fetch(apiUrl);
    const data = await res.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      await _logD1Failure(env, 'handlePlacesAutocomplete', `status=${data.status} input="${input}"`);
      return jsonResponse({ predictions: [], source: 'error', status: data.status }, corsHeaders);
    }
    const predictions = (data.predictions || []).map(p => ({
      place_id:    p.place_id,
      description: p.description,
    }));
    return jsonResponse({ predictions, source: 'google' }, corsHeaders);
  } catch(e) {
    await _logD1Failure(env, 'handlePlacesAutocomplete', e.message);
    return jsonResponse({ predictions: [], source: 'error', error: e.message }, corsHeaders, 500);
  }
}

async function handlePlacesDetails(request, env, corsHeaders, url) {
  const placeId     = (url.searchParams.get('place_id') || '').trim();
  const sessiontoken = url.searchParams.get('sessiontoken') || '';
  if (!placeId) return jsonResponse({ error: 'place_id required' }, corsHeaders, 400);

  // KV cache: 30-day TTL — same place rarely changes address
  const cacheKey = `dt:places:${placeId}`;
  const cached   = await env.DATA.get(cacheKey, 'json');
  if (cached) return jsonResponse({ ...cached, source: 'cache' }, corsHeaders);

  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key)  return jsonResponse({ error: 'GOOGLE_PLACES_API_KEY not configured' }, corsHeaders, 503);

  const params = new URLSearchParams({
    place_id: placeId,
    sessiontoken,
    fields: 'formatted_address,geometry,address_components,place_id',
    key,
  });
  const apiUrl = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;

  try {
    const res  = await fetch(apiUrl);
    const data = await res.json();
    if (data.status !== 'OK') {
      await _logD1Failure(env, 'handlePlacesDetails', `status=${data.status} place_id="${placeId}"`);
      return jsonResponse({ error: `Places API: ${data.status}` }, corsHeaders, 502);
    }
    const r    = data.result;
    const comps = r.address_components || [];
    const get   = (types) => (comps.find(c => types.every(t => c.types.includes(t)))?.long_name  || '');
    const getS  = (types) => (comps.find(c => types.every(t => c.types.includes(t)))?.short_name || '');

    const streetNum  = get(['street_number']);
    const streetName = get(['route']);
    const streetAddress = [streetNum, streetName].filter(Boolean).join(' ') || '';
    const city = get(['locality']) || get(['sublocality']) || get(['neighborhood']) || '';
    const state = getS(['administrative_area_level_1']);
    const zip   = get(['postal_code']);

    const result = {
      place_id:         r.place_id,
      formatted_address: r.formatted_address,
      street_address:   streetAddress,
      city,
      state,
      zip,
      latitude:  r.geometry?.location?.lat  || null,
      longitude: r.geometry?.location?.lng  || null,
    };

    // Cache 30 days (30 * 24 * 3600)
    await env.DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 2592000 });

    return jsonResponse({ ...result, source: 'google' }, corsHeaders);
  } catch(e) {
    await _logD1Failure(env, 'handlePlacesDetails', e.message);
    return jsonResponse({ error: e.message }, corsHeaders, 500);
  }
}

// ── POST /admin/properties/canonicalize-all ───────────────────────────────────
// Phase 1: Fetches place_id for every Property WHERE googlePlaceId IS NULL.
// Phase 2: Merges duplicate Property rows that resolve to the same place_id.
// Rate limited to 1 req/sec. KV key 'places_canonicalize_cursor' tracks progress.
// Tyler triggers manually — not auto-scheduled. Never auto-merges low-confidence hits.

async function handleCanonicalizeAll(request, env, corsHeaders, url) {
  const body      = await request.json().catch(() => ({}));
  const phase     = body.phase     || 'canonicalize';   // 'canonicalize' | 'dedup' | 'both'
  const batchSize = Math.min(body.batchSize || 50, 200); // cap at 200 per call
  const reset     = !!body.reset;                         // clear cursor to restart

  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key) return jsonResponse({ error: 'GOOGLE_PLACES_API_KEY not configured' }, corsHeaders, 503);

  if (reset) await env.DATA.delete('places_canonicalize_cursor');

  const results = { updated: 0, ambiguous: 0, failed: 0, deduped: 0, mergedRows: [], errors: [] };

  // ── Phase 1: Canonicalize (fetch place_ids) ──────────────────────────────────
  if (phase === 'canonicalize' || phase === 'both') {
    const cursor = (await env.DATA.get('places_canonicalize_cursor')) || '';
    const rows   = await env.DB.prepare(
      `SELECT propertyId, streetAddress, city, state, zip
       FROM Property
       WHERE googlePlaceId IS NULL
         AND (streetAddress IS NOT NULL AND streetAddress != '')
         AND propertyId > ?
       ORDER BY propertyId
       LIMIT ?`
    ).bind(cursor, batchSize).all().then(r => r.results || []);

    for (const row of rows) {
      const addrStr = [row.streetAddress, row.city, row.state || 'FL', row.zip].filter(Boolean).join(', ');
      const params  = new URLSearchParams({
        input:     addrStr,
        inputtype: 'textquery',
        fields:    'place_id,formatted_address,geometry',
        key,
      });
      try {
        const res  = await fetch(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${params}`);
        const data = await res.json();

        if (data.status === 'OK' && data.candidates?.length === 1) {
          const c = data.candidates[0];
          await env.DB.prepare(
            `UPDATE Property SET googlePlaceId=?, formattedAddress=?, latitude=?, longitude=?, googleVerified=1, modifiedAt=?
             WHERE propertyId=?`
          ).bind(c.place_id, c.formatted_address, c.geometry?.location?.lat||null, c.geometry?.location?.lng||null, new Date().toISOString(), row.propertyId).run();
          // Cache the details so future Details calls are free
          const cacheKey = `dt:places:${c.place_id}`;
          const detail = { place_id: c.place_id, formatted_address: c.formatted_address,
            street_address: row.streetAddress, city: row.city, state: row.state||'FL', zip: row.zip||null,
            latitude: c.geometry?.location?.lat||null, longitude: c.geometry?.location?.lng||null };
          await env.DATA.put(cacheKey, JSON.stringify(detail), { expirationTtl: 2592000 });
          results.updated++;
        } else if (data.status === 'OK' && (data.candidates?.length || 0) > 1) {
          results.ambiguous++;
          await _logD1Failure(env, 'canonicalize:ambiguous', `propertyId=${row.propertyId} addr="${addrStr}" candidates=${data.candidates.length}`);
        } else if (data.status === 'ZERO_RESULTS') {
          results.ambiguous++;
          await _logD1Failure(env, 'canonicalize:no_result', `propertyId=${row.propertyId} addr="${addrStr}"`);
        } else {
          results.failed++;
          results.errors.push({ propertyId: row.propertyId, status: data.status });
          await _logD1Failure(env, 'canonicalize:api_error', `propertyId=${row.propertyId} status=${data.status}`);
        }
      } catch(e) {
        results.failed++;
        results.errors.push({ propertyId: row.propertyId, error: e.message });
        await _logD1Failure(env, 'canonicalize:fetch_error', `propertyId=${row.propertyId} ${e.message}`);
      }
      // Track cursor so next call resumes from here
      await env.DATA.put('places_canonicalize_cursor', row.propertyId);
      // Rate limit: 100ms default (10 QPS — well under Google's 100 QPS billing limit).
      // 1050ms was too conservative and caused Cloudflare's 30s wall-clock timeout on batches > 25.
      await new Promise(r => setTimeout(r, body.delayMs ?? 100));
    }

    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM Property WHERE googlePlaceId IS NULL AND streetAddress IS NOT NULL AND streetAddress != ''`
    ).first().then(r => r?.cnt ?? 0);
    // noAddressRows: properties with no street address — can't be canonicalized, permanently excluded
    const noAddressRows = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM Property WHERE googlePlaceId IS NULL AND (streetAddress IS NULL OR streetAddress = '')`
    ).first().then(r => r?.cnt ?? 0);
    results.remaining = remaining;
    results.noAddressRows = noAddressRows;
    results.cursor = (await env.DATA.get('places_canonicalize_cursor')) || '';
    // Done when no addressable rows remain OR this batch processed 0 rows (cursor exhausted)
    results.done = remaining === 0 || (rows.length > 0 && results.updated + results.ambiguous + results.failed === 0) || rows.length === 0;
  }

  // ── Phase 2: Dedup (merge rows with same place_id) ───────────────────────────
  if (phase === 'dedup' || phase === 'both') {
    const dupGroups = await env.DB.prepare(
      `SELECT googlePlaceId, GROUP_CONCAT(propertyId) AS ids, COUNT(*) AS cnt
       FROM Property WHERE googlePlaceId IS NOT NULL
       GROUP BY googlePlaceId HAVING cnt > 1`
    ).all().then(r => r.results || []);

    for (const grp of dupGroups) {
      const ids = grp.ids.split(',');
      // Canonical = oldest (first) propertyId alphabetically (migration stability)
      // Pick the one with the most job history as canonical
      let canonicalId = ids[0];
      let maxJobs = -1;
      for (const pid of ids) {
        const jc = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM Job WHERE propertyId=?')
          .bind(pid).first().then(r => r?.cnt ?? 0);
        if (jc > maxJobs) { maxJobs = jc; canonicalId = pid; }
      }
      const dupeIds = ids.filter(id => id !== canonicalId);

      for (const dupeId of dupeIds) {
        // Repoint PersonProperty + Job rows
        await env.DB.prepare('UPDATE PersonProperty SET propertyId=? WHERE propertyId=?')
          .bind(canonicalId, dupeId).run();
        await env.DB.prepare('UPDATE Job SET propertyId=? WHERE propertyId=?')
          .bind(canonicalId, dupeId).run();
        // Delete the dupe Property row
        await env.DB.prepare('DELETE FROM Property WHERE propertyId=?').bind(dupeId).run();
        results.deduped++;
        results.mergedRows.push({ merged: dupeId, into: canonicalId, place_id: grp.googlePlaceId });
        await _logD1Failure(env, 'canonicalize:dedup_merge',
          `merged propertyId=${dupeId} into ${canonicalId} (place_id=${grp.googlePlaceId})`);
      }
    }
  }

  return jsonResponse({ success: true, results }, corsHeaders);
}

// ── GET /admin/property-duplicates ───────────────────────────────────────────
// Returns any Property rows that share a googlePlaceId (post-migration residuals).

// ── POST /admin/property/backfill-access ─────────────────────────────────────
// One-time KV→D1 backfill for gateCode + accessNotes.
// Reads the live KV customer_db blob, finds customers with non-empty gateCode or
// accessNotes that differ from what D1 currently has, and writes them to the
// corresponding Property row.
//
// Body: { dryRun: true|false }   (default: true — safe to call without body)
//
// Returns:
//   { dryRun, toWrite: [{phone, name, propertyId, kvGateCode, d1GateCode, kvAccessNotes, d1AccessNotes}],
// ── PATCH /admin/property-images ─────────────────────────────────────────────
// Set Property.satelliteImageKey and/or frontImageKey after the Property row
// is confirmed to exist (called from new_customer.html after scheduleJobWithDualWrite).
// Idempotent: re-sending the same key is a no-op UPDATE.
async function handlePatchPropertyImages(request, env, corsHeaders) {
  if (!env.DB) return jsonResponse({ error: 'D1 not available' }, corsHeaders, 503);
  const body = await request.json().catch(() => null);
  if (!body || !body.propertyId) return jsonResponse({ error: 'propertyId required' }, corsHeaders, 400);
  const { propertyId, satelliteImageKey, frontImageKey } = body;
  const sets = [], vals = [];
  if (satelliteImageKey !== undefined) { sets.push('satelliteImageKey=?'); vals.push(satelliteImageKey || null); }
  if (frontImageKey     !== undefined) { sets.push('frontImageKey=?');     vals.push(frontImageKey     || null); }
  if (!sets.length) return jsonResponse({ success: true, updated: 0 }, corsHeaders);
  sets.push('modifiedAt=?'); vals.push(new Date().toISOString());
  vals.push(propertyId);
  try {
    const result = await env.DB.prepare(
      `UPDATE Property SET ${sets.join(',')} WHERE propertyId=?`
    ).bind(...vals).run();
    return jsonResponse({ success: true, updated: result.meta?.changes ?? 0 }, corsHeaders);
  } catch(e) {
    await _logD1Failure(env, `handlePatchPropertyImages:${propertyId}`, e.message);
    return jsonResponse({ error: 'D1 update failed', detail: e.message }, corsHeaders, 500);
  }
}

//     written, errors, skipped }
//
// Re-runnable / idempotent — skips rows where D1 already matches KV.
async function handleBackfillPropertyAccess(request, env, corsHeaders) {
  const now = new Date().toISOString();
  let dryRun = true;
  try {
    const body = await request.json().catch(() => ({}));
    if (body && body.dryRun === false) dryRun = false;
  } catch { /* default dry run */ }

  // Read KV blob (source of truth for pre-Day-2 / manually entered values)
  const kvDb = await env.DATA.get('customer_db', 'json') || { customers: [] };
  const kvCustomers = (kvDb.customers || []).filter(c => c && !c.deleted);

  // Build D1 Property lookup: personId → { propertyId, gateCode, accessNotes }
  const d1Props = await env.DB.prepare(
    `SELECT pp.personId, pr.propertyId, pr.gateCode, pr.accessNotes
     FROM PersonProperty pp JOIN Property pr ON pp.propertyId=pr.propertyId
     WHERE pp.primaryContact=1`
  ).all().then(r => r.results || []);
  const d1PropByPerson = new Map();
  for (const row of d1Props) {
    if (row.personId) d1PropByPerson.set(row.personId, row);
  }

  const toWrite = [];
  const skipped = [];

  for (const c of kvCustomers) {
    const ph = (c.phone || '').replace(/\D/g, '').slice(-10);
    if (!ph || ph.length !== 10) continue;

    const kvGateCode    = (c.gateCode    || '').trim() || null;
    const kvAccessNotes = (c.accessNotes || '').trim() || null;

    // Skip if nothing in KV
    if (!kvGateCode && !kvAccessNotes) continue;

    const personId = _d1PersonId(ph);
    const d1Row    = d1PropByPerson.get(personId);
    if (!d1Row?.propertyId) {
      skipped.push({ phone: ph, reason: 'no_d1_property' });
      continue;
    }

    const d1GateCode    = (d1Row.gateCode    || '').trim() || null;
    const d1AccessNotes = (d1Row.accessNotes || '').trim() || null;

    // Skip if D1 already matches KV
    if (kvGateCode === d1GateCode && kvAccessNotes === d1AccessNotes) {
      skipped.push({ phone: ph, reason: 'already_in_sync' });
      continue;
    }

    toWrite.push({
      phone:           ph,
      name:            `${c.firstName||''} ${c.lastName||''}`.trim(),
      propertyId:      d1Row.propertyId,
      kvGateCode,
      d1GateCode,
      kvAccessNotes,
      d1AccessNotes,
    });
  }

  const written = [], errors = [];
  if (!dryRun) {
    for (const row of toWrite) {
      try {
        await _d1SyncPropertyUpdate(row.propertyId, {
          gateCode:    row.kvGateCode,
          accessNotes: row.kvAccessNotes,
        }, env, now);
        written.push({ phone: row.phone, name: row.name, propertyId: row.propertyId });
      } catch(e) {
        errors.push({ phone: row.phone, name: row.name, error: String(e.message).slice(0,200) });
        await _logD1Failure(env, `backfill_access:${row.phone}`, e.message);
      }
    }
  }

  return jsonResponse({
    dryRun,
    toWriteCount: toWrite.length,
    toWrite,           // full list for inspection
    writtenCount: written.length,
    written,
    errorCount:   errors.length,
    errors,
    skippedCount: skipped.length,
    // skipped details omitted from response (can be 1241 lines) — only counts matter
  }, corsHeaders);
}

// ── Person duplicate review endpoints ────────────────────────────────────────

// GET /admin/person-merge-candidates
// Returns Tier 2+3 candidates: same name + phone edit distance ≤ 5 OR same place_id.
// Filters out pairs already decided (skip decisions stored in KV person_merge_skipped:*).
async function handlePersonMergeCandidates(env, corsHeaders) {
  // Load all persons with phone
  const persons = await env.DB.prepare(
    `SELECT p.personId, p.firstName, p.lastName, p.primaryPhone, p.createdAt, p.internalNotes AS notes
     FROM Person p WHERE p.primaryPhone IS NOT NULL AND p.primaryPhone != ''`
  ).all().then(r => r.results || []);

  // Load job counts per person
  const jobRows = await env.DB.prepare(
    `SELECT payerId, COUNT(*) AS cnt, SUM(amount) AS total,
            MIN(scheduledDate) AS firstJob, MAX(scheduledDate) AS lastJob
     FROM Job GROUP BY payerId`
  ).all().then(r => r.results || []);
  const jobsByPerson = new Map(jobRows.map(j => [j.payerId, j]));

  // Load properties per person (with place_id)
  const ppRows = await env.DB.prepare(
    `SELECT pp.personId, pp.propertyId, pp.primaryContact, pp.propertyLabel,
            p.streetAddress, p.city, p.googlePlaceId, p.formattedAddress
     FROM PersonProperty pp JOIN Property p ON p.propertyId=pp.propertyId`
  ).all().then(r => r.results || []);
  const propsByPerson = {};
  for (const pp of ppRows) {
    if (!propsByPerson[pp.personId]) propsByPerson[pp.personId] = [];
    propsByPerson[pp.personId].push(pp);
  }

  // Load skip decisions from KV
  const skipKeys = await env.DATA.list({ prefix: 'person_merge_skipped:' });
  const skipped  = new Set(skipKeys.keys.map(k => k.name));

  // Compute edit distance (phone digits only, same length only)
  function editDist(a, b) {
    const da = (a||'').replace(/\D/g,''), db = (b||'').replace(/\D/g,'');
    if (da.length !== db.length) return Math.abs(da.length - db.length) + da.split('').filter((c,i)=>c!==db[i]).length;
    return da.split('').filter((c,i) => c !== db[i]).length;
  }

  const candidates = [];
  const seen = new Set();

  for (let i = 0; i < persons.length; i++) {
    const p1 = persons[i];
    const n1 = `${(p1.firstName||'').toLowerCase()} ${(p1.lastName||'').toLowerCase()}`.trim();
    if (!n1 || n1 === ' ') continue;

    for (let j = i + 1; j < persons.length; j++) {
      const p2 = persons[j];
      const n2 = `${(p2.firstName||'').toLowerCase()} ${(p2.lastName||'').toLowerCase()}`.trim();
      if (n1 !== n2) continue;

      const key = [p1.personId, p2.personId].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);

      const skipKey = `person_merge_skipped:${key}`;
      if (skipped.has(skipKey)) continue; // already decided

      const dist = editDist(p1.primaryPhone, p2.primaryPhone);
      const p1Props = propsByPerson[p1.personId] || [];
      const p2Props = propsByPerson[p2.personId] || [];

      // Shared place_id
      const p1PlaceIds = new Set(p1Props.map(p => p.googlePlaceId).filter(Boolean));
      const sharedPlaceId = p2Props.find(p => p.googlePlaceId && p1PlaceIds.has(p.googlePlaceId));

      if (dist > 5 && !sharedPlaceId) continue; // not a candidate

      candidates.push({
        id:            key,
        name:          `${p1.firstName} ${p1.lastName}`,
        phoneDist:     dist,
        sharedPlaceId: sharedPlaceId?.googlePlaceId || null,
        sharedAddress: sharedPlaceId?.formattedAddress || null,
        records: [p1, p2].map(p => ({
          personId:   p.personId,
          phone:      p.primaryPhone,
          createdAt:  p.createdAt,
          notes:      p.notes || null,
          jobs:       jobsByPerson.get(p.personId) || { cnt: 0, total: 0, firstJob: null, lastJob: null },
          properties: (propsByPerson[p.personId] || []).map(pp => ({
            propertyId:       pp.propertyId,
            streetAddress:    pp.streetAddress,
            city:             pp.city,
            primaryContact:   pp.primaryContact,
            propertyLabel:    pp.propertyLabel,
            googlePlaceId:    pp.googlePlaceId,
            formattedAddress: pp.formattedAddress,
          })),
        })),
      });
    }
  }

  // Sort: shared place_id first (strongest signal), then by edit distance
  candidates.sort((a, b) => {
    if (a.sharedPlaceId && !b.sharedPlaceId) return -1;
    if (!a.sharedPlaceId && b.sharedPlaceId) return 1;
    return a.phoneDist - b.phoneDist;
  });

  return jsonResponse({ candidates, total: candidates.length }, corsHeaders);
}

// POST /admin/person-merge
// Executes the 5-statement merge pattern: repoint jobs + properties, delete orphan.
// Body: { canonicalPersonId, orphanPersonId, reason }
async function handlePersonMerge(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);
  const { canonicalPersonId, orphanPersonId, reason } = body;
  if (!canonicalPersonId || !orphanPersonId) return jsonResponse({ error: 'canonicalPersonId + orphanPersonId required' }, corsHeaders, 400);
  if (canonicalPersonId === orphanPersonId) return jsonResponse({ error: 'same personId' }, corsHeaders, 400);

  try {
    // Step 1: Repoint jobs
    const j = await env.DB.prepare('UPDATE Job SET payerId=? WHERE payerId=?').bind(canonicalPersonId, orphanPersonId).run();
    // Step 2: Move non-duplicate PersonProperty links
    const pp = await env.DB.prepare(
      `UPDATE PersonProperty SET personId=? WHERE personId=? AND propertyId NOT IN (SELECT propertyId FROM PersonProperty WHERE personId=?)`
    ).bind(canonicalPersonId, orphanPersonId, canonicalPersonId).run();
    // Step 3: Delete remaining orphan PersonProperty
    const ppDel = await env.DB.prepare('DELETE FROM PersonProperty WHERE personId=?').bind(orphanPersonId).run();
    // Step 4: Delete orphan Person
    const pDel = await env.DB.prepare('DELETE FROM Person WHERE personId=?').bind(orphanPersonId).run();

    // Clear skip key if it existed
    const skipKey = `person_merge_skipped:${[canonicalPersonId, orphanPersonId].sort().join(':')}`;
    await env.DATA.delete(skipKey).catch(() => {});

    // Log
    await _logD1Failure(env, `person_merge_tier2_3_2026_05_25`,
      `merged orphan=${orphanPersonId} into canonical=${canonicalPersonId} reason=${reason||'review_ui'} jobs=${j.meta?.changes||0}`);

    // Refresh canonical KV via d1CustomerToKvShape
    const canon = await env.DB.prepare('SELECT primaryPhone FROM Person WHERE personId=?').bind(canonicalPersonId).first();
    if (canon?.primaryPhone) {
      const ph = canon.primaryPhone.replace(/\D/g,'').slice(-10);
      const updC = await d1CustomerToKvShape(ph, env);
      if (updC) {
        const kvDb = await env.DATA.get('customer_db', 'json') || { customers: [] };
        const idx = (kvDb.customers||[]).findIndex(c => (c.phone||'').replace(/\D/g,'').slice(-10) === ph);
        if (idx >= 0) kvDb.customers[idx] = updC; else kvDb.customers.push(updC);
        // Also remove orphan from KV customers list if it exists
        const orphanPh = (await env.DB.prepare('SELECT primaryPhone FROM Person WHERE personId=?').bind(orphanPersonId).first().catch(()=>null))?.primaryPhone;
        if (orphanPh) {
          const oph = orphanPh.replace(/\D/g,'').slice(-10);
          const oi = (kvDb.customers||[]).findIndex(c => (c.phone||'').replace(/\D/g,'').slice(-10) === oph);
          if (oi >= 0) kvDb.customers.splice(oi, 1);
        }
        await env.DATA.put('customer_db', JSON.stringify(kvDb));
      }
    }

    return jsonResponse({
      success: true, canonicalPersonId, orphanPersonId,
      jobsRelinked: j.meta?.changes || 0,
      propertiesRelinked: pp.meta?.changes || 0,
      propertiesDeleted: ppDel.meta?.changes || 0,
    }, corsHeaders);
  } catch(e) {
    await _logD1Failure(env, `person_merge_error:${canonicalPersonId}`, e.message);
    return jsonResponse({ error: e.message }, corsHeaders, 500);
  }
}

// POST /admin/person-merge-skip
// Records a "legitimate, not duplicates" decision so future audit runs don't re-flag.
// Body: { personIdA, personIdB, reason }
async function handlePersonMergeSkip(request, env, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: 'JSON body required' }, corsHeaders, 400);
  const { personIdA, personIdB, reason } = body;
  if (!personIdA || !personIdB) return jsonResponse({ error: 'personIdA + personIdB required' }, corsHeaders, 400);

  const key = `person_merge_skipped:${[personIdA, personIdB].sort().join(':')}`;
  await env.DATA.put(key, JSON.stringify({
    skipped: true, reason: reason || 'different people', decidedAt: new Date().toISOString(), decidedBy: 'tyler',
  }));
  await _logD1Failure(env, 'person_merge_skip', `skipped ${personIdA} vs ${personIdB}: ${reason||'different people'}`);
  return jsonResponse({ success: true, key }, corsHeaders);
}

// Zero results = clean. Non-zero = something to review or re-run dedup phase.

async function handlePropertyDuplicates(env, corsHeaders) {
  const groups = await env.DB.prepare(
    `SELECT googlePlaceId, GROUP_CONCAT(propertyId) AS ids, COUNT(*) AS cnt,
            MAX(streetAddress) AS streetAddress, MAX(city) AS city
     FROM Property WHERE googlePlaceId IS NOT NULL
     GROUP BY googlePlaceId HAVING cnt > 1
     ORDER BY cnt DESC`
  ).all().then(r => r.results || []);

  return jsonResponse({
    duplicateGroups: groups.map(g => ({
      googlePlaceId: g.googlePlaceId,
      propertyIds:   g.ids.split(','),
      count:         g.cnt,
      streetAddress: g.streetAddress,
      city:          g.city,
    })),
    total: groups.length,
  }, corsHeaders);
}

// ── Google Directions API proxy + KV cache ────────────────────────────────────
// Scheduling-time drive estimates for FUTURE jobs (before Bouncie has actuals).
// Bouncie TruckEvent data (Phase 1) remains source of truth for completed jobs.
// KV cache key: dt:{fromLat4}_{fromLng4}:{toLat4}_{toLng4} (4-decimal rounding)
// TTL: 7 days — South FL traffic patterns don't shift dramatically week-to-week.

async function handleDriveTime(request, env, corsHeaders, url) {
  const fromStr = url.searchParams.get('from');
  const toStr   = url.searchParams.get('to');

  const parseCoord = s => {
    if (!s) return null;
    const parts = s.split(',');
    if (parts.length !== 2) return null;
    const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  };

  const from = parseCoord(fromStr);
  const to   = parseCoord(toStr);
  if (!from || !to) {
    return jsonResponse({ error: 'from and to must be valid lat,lng pairs (e.g. ?from=25.9876,-80.1234&to=26.1234,-80.5678)' }, corsHeaders, 400);
  }

  // Round to 4 decimals — maximizes cache hit rate for routes to same property
  const r4 = n => Math.round(n * 10000) / 10000;
  const fl = r4(from.lat), fln = r4(from.lng);
  const tl = r4(to.lat),   tln = r4(to.lng);
  const cacheKey = `dt:${fl}_${fln}:${tl}_${tln}`;

  // KV cache hit — 7-day TTL written at store time
  const cached = await env.DATA.get(cacheKey, 'json');
  if (cached) {
    await _dtStatsIncrement(env, 'cacheHits');
    return jsonResponse({ ...cached, source: 'cache' }, corsHeaders);
  }

  // Google Directions API
  const apiKey = env.GOOGLE_DIRECTIONS_API_KEY;
  if (!apiKey) {
    // No key configured — return haversine fallback silently
    return jsonResponse(_dtHaversineFallback(fl, fln, tl, tln), corsHeaders);
  }

  try {
    const gUrl = new URL('https://maps.googleapis.com/maps/api/directions/json');
    gUrl.searchParams.set('origin',         `${fl},${fln}`);
    gUrl.searchParams.set('destination',    `${tl},${tln}`);
    gUrl.searchParams.set('mode',           'driving');
    gUrl.searchParams.set('departure_time', 'now');   // traffic-aware
    gUrl.searchParams.set('key',             apiKey);

    const res  = await fetch(gUrl.toString());
    const data = await res.json();

    if (data.status !== 'OK' || !data.routes?.[0]?.legs?.[0]) {
      throw new Error(`Directions API status: ${data.status}`);
    }

    const leg    = data.routes[0].legs[0];
    const durSec = leg.duration_in_traffic?.value ?? leg.duration?.value ?? 0;
    const distM  = leg.distance?.value ?? 0;
    const result = {
      duration_minutes: Math.round(durSec / 60 * 10) / 10,
      distance_miles:   Math.round(distM  / 1609.344 * 10) / 10,
    };

    // Write to KV cache (7-day TTL) — MUST await: fire-and-forget puts are killed before
    // completing in Cloudflare Workers when there's no ctx.waitUntil().
    await env.DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 7 * 86400 });
    await _dtStatsIncrement(env, 'apiCalls');

    return jsonResponse({ ...result, source: 'google' }, corsHeaders);
  } catch(e) {
    await _logD1Failure(env, `drive_time:${cacheKey}`, e.message);
    // Visible fallback — caller sees source:'haversine_fallback' and can surface to user
    return jsonResponse({ ..._dtHaversineFallback(fl, fln, tl, tln), googleError: e.message }, corsHeaders);
  }
}

async function handleDriveTimeStats(env, corsHeaders) {
  const stats  = await env.DATA.get('dt:stats', 'json') || { apiCalls: 0, cacheHits: 0, since: new Date().toISOString() };
  const total  = (stats.apiCalls || 0) + (stats.cacheHits || 0);
  const hitPct = total > 0 ? Math.round((stats.cacheHits || 0) / total * 100) : 0;
  // Google Directions pricing: $5 per 1,000 Advanced requests (departure_time=now)
  const estimatedCostUsd = Math.round((stats.apiCalls || 0) / 1000 * 5 * 100) / 100;
  return jsonResponse({
    totalRequests: total,
    cacheHits:     stats.cacheHits  || 0,
    apiCalls:      stats.apiCalls   || 0,
    hitRate:       `${hitPct}%`,
    estimatedCostUsd,
    since:         stats.since || null,
    note:          'Top routes not yet tracked; add request logging to enable.',
  }, corsHeaders);
}

// ── Real Bouncie day summary per rig+date ─────────────────────────────────────
// Replaces haversine estimates in the ops/margin panel for completed days.
// Returns source:'truckevent' with real sums when TruckEvent rows exist,
// or source:'none' when no Bouncie data has been processed for that day.
async function handleRigDaySummary(request, env, corsHeaders, url) {
  const date = url.searchParams.get('date');
  const rig  = url.searchParams.get('rig');
  if (!date || !rig)
    return jsonResponse({ error: 'date and rig required' }, corsHeaders, 400);

  try {
    const [driveRow, spanRow] = await Promise.all([
      env.DB.prepare(
        `SELECT ROUND(SUM(distanceMiles), 1)              AS totalDriveMiles,
                CAST(SUM(durationSeconds) / 60 AS INTEGER) AS totalDriveMin
         FROM TruckEvent
         WHERE rigId=? AND DATE(startedAt)=? AND eventType='drive'`
      ).bind(rig, date).first(),
      env.DB.prepare(
        `SELECT
           MIN(CASE WHEN eventType='depart_home' THEN startedAt END) AS departAt,
           MAX(CASE WHEN eventType='arrive_home'  THEN startedAt END) AS returnAt
         FROM TruckEvent
         WHERE rigId=? AND DATE(startedAt)=?`
      ).bind(rig, date).first(),
    ]);

    // No TruckEvent rows → return sentinel so calendar keeps its haversine estimate
    if (!driveRow || driveRow.totalDriveMin == null) {
      return jsonResponse({ date, rig, source: 'none' }, corsHeaders);
    }

    const departAt   = spanRow?.departAt  || null;
    const returnAt   = spanRow?.returnAt  || null;
    const fullDayMin = (departAt && returnAt)
      ? Math.round((+new Date(returnAt) - +new Date(departAt)) / 60000)
      : null;

    return jsonResponse({
      date, rig,
      source:          'truckevent',
      totalDriveMiles: driveRow.totalDriveMiles,
      totalDriveMin:   driveRow.totalDriveMin,
      departAt,
      returnAt,
      fullDayMin,
    }, corsHeaders);
  } catch (e) {
    // Non-critical — calendar falls back to haversine; never throw
    return jsonResponse({ date, rig, source: 'none', error: e.message }, corsHeaders);
  }
}

// haversine × 1.3 (route winding) × 35 mph — used when Google API is unavailable
function _dtHaversineFallback(fromLat, fromLng, toLat, toLng) {
  const distMi = haversineKm(fromLat, fromLng, toLat, toLng) * 0.621371 * 1.3;
  return {
    duration_minutes: Math.round(Math.max(1, distMi / 35 * 60) * 10) / 10,
    distance_miles:   Math.round(distMi * 10) / 10,
    source:           'haversine_fallback',
  };
}

async function _dtStatsIncrement(env, field) {
  try {
    const stats = await env.DATA.get('dt:stats', 'json') || { apiCalls: 0, cacheHits: 0, since: new Date().toISOString() };
    stats[field] = (stats[field] || 0) + 1;
    await env.DATA.put('dt:stats', JSON.stringify(stats));
  } catch(e) { /* stats are non-critical — never block main response */ }
}

// ── Track 2: solo-equivalent duration ────────────────────────────────────────
// throughputMultiplier(crew): how much more work a larger crew completes relative to solo.
//   1 person = 1.0×, 2 people = 1.85× (not 2.0× — coordination overhead), 3 = 2.6×.
//   Tunable table: re-tuning re-normalizes ALL historical jobs on next read (no frozen column).
//   Unknown crew → 1.0 (conservative — never inflates).
//
// soloEquiv(actualDuration, crewCount): "1-person-equivalent size" of the job in minutes.
//   Returns null if EITHER input is missing/zero — never surfaces a silent wrong number.
//   Surfaces ONLY when both actualDuration AND crewCount are known (Phase 3+4 backfill).
function throughputMultiplier(crew) {
  const t = { 1: 1.0, 2: 1.85, 3: 2.6 };
  return t[crew] ?? 1.0;
}
function soloEquiv(actualDuration, crewCount) {
  if (!actualDuration || actualDuration <= 0) return null;
  if (!crewCount     || crewCount     <= 0) return null;   // no crew data → no Track 2
  return Math.round(actualDuration * throughputMultiplier(crewCount));
}

// ── Per-property avg job-duration metric (wall-clock lens) ───────────────────
// Lens: WALL-CLOCK — actualDuration as-is (minutes on-site). No crew multiplier/divisor.
// A 2h40m solo job and a 2h40m 2-crew job both show 2h40m — that's "how long will
// this property take" which is what scheduling + quoting care about.
// crewCount is NOT used here for wall-clock; solo-equiv is added ALONGSIDE as Track 2.
//
// NOTE: d1JobToKvShape still defaults crewCount null→2 (line ~2930) for raw API consumers.
// That default is harmless: solo-equiv returns null for any job with null crew (guarded above).

function computeBouncieMetrics(customer) {
  const address = (customer.address || '').trim();
  if (!address) return;

  // Collect all Bouncie-matched durations from jobHistory + active scheduledStatus.
  // DEDUPE: track seen jobIds (or date as fallback) so a completed job that appears in
  // BOTH jobHistory[] AND scheduledStatus (e.g. Anas Hadeh matchedJobCount=2 bug) counts once.
  const seenIds = new Set();
  const matched = [];

  for (const j of (customer.jobHistory || [])) {
    if (!j.actualDuration || j.actualDuration <= 0) continue;
    const key = j.jobId || j.date || '';
    if (key && seenIds.has(key)) continue;
    if (key) seenIds.add(key);
    // Track BOTH the jobId and the date so scheduledStatus can be deduped by either
    if (j.date) seenIds.add(j.date);
    // crewCount carried for Track 2 solo-equiv (null when not known — soloEquiv() guards)
    matched.push({ date: j.date || '', minutes: j.actualDuration, crewCount: j.crewCount || null });
  }

  const ss = customer.scheduledStatus || {};
  if (ss.actualDuration > 0) {
    // Dedupe by jobId (_lastJobId) first, then by scheduledDate.
    // Both are added to seenIds from jobHistory above so either key catches the duplicate.
    const ssKey = ss._lastJobId || ss.scheduledDate || '';
    if (!ssKey || !seenIds.has(ssKey)) {
      matched.push({
        date: ss.scheduledDate || (ss.completedAt || '').slice(0, 10),
        minutes: ss.actualDuration,
        crewCount: ss.crewCount || null,
      });
    }
  }

  if (!matched.length) {
    delete customer.bouncieMetrics;
    return;
  }

  matched.sort((a, b) => a.date < b.date ? -1 : 1);

  // Track 1 — wall-clock: exact on-site duration, crew-agnostic
  const avg  = Math.round(matched.reduce((a, b) => a + b.minutes, 0) / matched.length);
  const last = matched[matched.length - 1].minutes;

  // Track 2 — solo-equiv: actualDuration × throughputMultiplier(crewCount)
  // Only computed for entries where crewCount is known; others contribute null (excluded from avg)
  const seMatched = matched.map(m => soloEquiv(m.minutes, m.crewCount)).filter(v => v !== null);
  const avgSE  = seMatched.length > 0 ? Math.round(seMatched.reduce((a,b) => a+b, 0) / seMatched.length) : null;
  const lastSE = seMatched.length > 0 ? seMatched[seMatched.length - 1] : null;

  customer.bouncieMetrics = {
    [address]: {
      avgDurationMinutes:   avg,      // Track 1: wall-clock avg (always present when Bouncie matched)
      lastDurationMinutes:  last,     // Track 1: wall-clock last
      avgSoloEquivMinutes:  avgSE,    // Track 2: solo-equiv avg (null when no crew data)
      lastSoloEquivMinutes: lastSE,   // Track 2: solo-equiv last
      lastServiceDate:      matched[matched.length - 1].date,
      matchedJobCount:      matched.length,
    },
  };
}

function computeWorkerHoursStats(customer) {
  // Wall-clock lens (Track 1) + solo-equiv (Track 2) — both computed here for the profile stat.
  // Profile "Job Duration" stat reads avgPerVisit (wall-clock) + avgSoloEquivPerVisit (Track 2).
  const seenIds = new Set();
  const matched = [];
  for (const j of (customer.jobHistory || [])) {
    if (!j.actualDuration || j.actualDuration <= 0) continue;
    if (j.source === 'csv_backfill') continue;
    const key = j.jobId || j.date || '';
    if (key && seenIds.has(key)) continue;
    if (key) seenIds.add(key);
    matched.push({ date: j.date || '', durationMin: j.actualDuration, crewCount: j.crewCount || null });
  }
  if (!matched.length) { delete customer.workerHoursStats; return; }
  matched.sort((a, b) => a.date < b.date ? -1 : 1);

  // Track 1: wall-clock avg/last (unchanged)
  const avg  = matched.reduce((s, j) => s + j.durationMin, 0) / matched.length;
  const last = matched[matched.length - 1];

  // Track 2: solo-equiv — only entries with known crewCount contribute
  const seVals = matched.map(j => soloEquiv(j.durationMin, j.crewCount)).filter(v => v !== null);
  const avgSE  = seVals.length > 0 ? seVals.reduce((a,b) => a+b, 0) / seVals.length : null;

  customer.workerHoursStats = {
    avgPerVisit:          Math.round(avg * 10) / 10 / 60,   // Track 1: wall-clock hours, 1dp
    lastVisitMin:         last.durationMin,                  // Track 1: wall-clock minutes
    lastVisitDate:        last.date,
    totalMatchedVisits:   matched.length,
    avgSoloEquivPerVisit: avgSE !== null                     // Track 2: solo-equiv hours (null if no crew data)
      ? Math.round(avgSE * 10) / 10 / 60
      : null,
  };
}

// ── Cache-Control helpers ─────────────────────────────────────────────────────
// HTML files: no-cache so browsers always fetch fresh after a deploy.
// Static assets: 1-year immutable cache — content-hashed names (main.abc123.js)
//   guarantee cache busting happens via filename change, not header expiry.
function addCacheHeaders(response, type) {
  const h = new Headers(response.headers);
  if (type === 'html') {
    h.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    h.set('Pragma', 'no-cache');
    h.set('Expires', '0');
  } else {
    h.set('Cache-Control', 'public, max-age=31536000, immutable');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

function fullName(c) { return `${c.firstName || ''} ${c.lastName || ''}`.trim(); }

// ── Per-worker hours from crew[] × actualDuration ────────────────────────────
// actualDuration is stored in minutes (from Bouncie GPS durationMin).
// Each worker in crew[] gets credit for the full job duration — crews work as units.
function computeWorkerHours(customers, dateFrom, dateTo) {
  const capitalize = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const result = {};
  for (const c of customers) {
    const custName = fullName(c);
    for (const j of (c.jobHistory || [])) {
      if (j.status !== 'completed') continue;
      if (!j.actualDuration || j.actualDuration <= 0) continue;
      if (!j.crew || j.crew.length === 0) continue;
      if (!j.date || j.date < dateFrom || j.date > dateTo) continue;
      const hours = Math.round((j.actualDuration / 60) * 10) / 10; // min → hours, 1dp
      for (const crewId of j.crew) {
        const name = capitalize(crewId);
        if (!result[name]) result[name] = { hours: 0, jobCount: 0, jobs: [] };
        result[name].hours    = Math.round((result[name].hours + hours) * 10) / 10;
        result[name].jobCount += 1;
        result[name].jobs.push({ date: j.date, customer: custName, phone: c.phone || '', hours });
      }
    }
  }
  for (const w of Object.values(result)) {
    w.avgHoursPerJob = w.jobCount > 0 ? Math.round((w.hours / w.jobCount) * 10) / 10 : 0;
  }
  return result;
}

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

