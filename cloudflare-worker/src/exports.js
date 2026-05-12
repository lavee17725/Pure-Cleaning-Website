/**
 * Weekly data export helpers for Google Drive snapshots.
 *
 * All functions are pure: they take loaded customer/job data and return JSON objects.
 * writeToGoogleDrive and getGoogleAccessToken are the only functions that touch external services.
 *
 * Every Monday 4 AM UTC the cron in index.js calls runWeeklyExport(env).
 * Manual trigger: POST /admin/export-weekly?from=&to=
 */

// ─── Google OAuth / Drive constants ──────────────────────────────────────────
export const GOOGLE_AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_API           = 'https://www.googleapis.com/drive/v3';
const GOOGLE_UPLOAD_API          = 'https://www.googleapis.com/upload/drive/v3';
export const GOOGLE_REDIRECT_URI = 'https://purecleaning-api.tylerfumero.workers.dev/oauth/google/callback';

const KV_GOOGLE_REFRESH = 'google_oauth:refresh_token';
const KV_GOOGLE_ACCESS  = 'google_oauth:access_token';
export const KV_GOOGLE_STATE   = 'google_oauth:oauth_state';
export const KV_GOOGLE_FOLDER  = 'google_drive:folder_id';

// ─── Token management ─────────────────────────────────────────────────────────
export async function getGoogleAccessToken(env) {
  const cached = await env.DATA.get(KV_GOOGLE_ACCESS, 'json');
  if (cached?.access_token && cached.expires_at > Date.now() + 120_000) {
    return cached.access_token;
  }
  const refreshToken = await env.DATA.get(KV_GOOGLE_REFRESH);
  if (!refreshToken) throw new Error('Google Drive not authorized — visit /oauth/google/start');
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const tokens = await res.json();
  if (!tokens.access_token) throw new Error(`Google token refresh failed: ${tokens.error || JSON.stringify(tokens)}`);
  await env.DATA.put(KV_GOOGLE_ACCESS, JSON.stringify({
    access_token: tokens.access_token,
    expires_at:   Date.now() + ((tokens.expires_in || 3600) - 120) * 1000,
  }));
  if (tokens.refresh_token) await env.DATA.put(KV_GOOGLE_REFRESH, tokens.refresh_token);
  return tokens.access_token;
}

// ─── Drive upload ─────────────────────────────────────────────────────────────
export async function writeToGoogleDrive(filename, jsonContent, env) {
  const accessToken = await getGoogleAccessToken(env);
  const folderId    = await env.DATA.get(KV_GOOGLE_FOLDER);
  const content     = JSON.stringify(jsonContent, null, 2);
  const boundary    = 'purecleaning_boundary_xyz';

  // Look for an existing file with the same name so we overwrite instead of duplicate
  let existingId = null;
  if (folderId) {
    const q = `name='${filename}' and '${folderId}' in parents and trashed=false`;
    const listRes = await fetch(`${GOOGLE_DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const list = await listRes.json();
    existingId = list.files?.[0]?.id || null;
  }

  const buildBody = (metadata) => [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n');

  let res;
  if (existingId) {
    res = await fetch(`${GOOGLE_UPLOAD_API}/files/${existingId}?uploadType=multipart&fields=id,name,webViewLink`, {
      method: 'PATCH',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: buildBody({ name: filename }),
    });
  } else {
    const meta = { name: filename, mimeType: 'application/json' };
    if (folderId) meta.parents = [folderId];
    res = await fetch(`${GOOGLE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: buildBody(meta),
    });
  }

  const result = await res.json();
  if (!result.id) throw new Error(`Drive upload failed for ${filename}: ${JSON.stringify(result)}`);
  return { id: result.id, name: result.name || filename, webViewLink: result.webViewLink || null };
}

// ─── Shared helpers (self-contained, no index.js dependency) ─────────────────
function fullName(c) { return `${c.firstName || ''} ${c.lastName || ''}`.trim(); }

function categorizeService(text) {
  const t = (text || '').toLowerCase();
  const isRoof   = /roof|soft\s*wash|softwash/.test(t);
  const isGround = /driveway|patio|sidewalk|walkway|concrete|pressure|paver|pool\s*deck|\bdeck\b|entranceway|entrance|flat\s*work|flatwork|pool area/.test(t);
  if (isRoof && isGround) return 'both';
  if (isRoof)   return 'roof';
  if (isGround) return 'ground';
  return 'unknown';
}

function computeWorkerHoursLocal(customers, dateFrom, dateTo) {
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const result = {};
  for (const c of customers) {
    for (const j of (c.jobHistory || [])) {
      if (j.status !== 'completed') continue;
      if (!j.actualDuration || j.actualDuration <= 0) continue;
      if (!j.crew || j.crew.length === 0) continue;
      if (!j.date || j.date < dateFrom || j.date > dateTo) continue;
      const hours = Math.round((j.actualDuration / 60) * 10) / 10;
      for (const id of j.crew) {
        const name = cap(id);
        if (!result[name]) result[name] = { hours: 0, jobCount: 0 };
        result[name].hours    = Math.round((result[name].hours + hours) * 10) / 10;
        result[name].jobCount += 1;
      }
    }
  }
  return result;
}

function monthsSince(dateStr) {
  if (!dateStr) return 999;
  const diff = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return Math.round(diff * 10) / 10;
}

// ─── Report generators ────────────────────────────────────────────────────────

export function generateWeeklySummary(customers, weekStart, weekEnd) {
  const active = customers.filter(c => !c.deleted && !c.optOut && !(c.phone || '').startsWith('REFERRAL_') && !c.isReferralOnly);
  const revenue = { total: 0, byRig: {}, byService: {} };
  const jobsCompleted = { count: 0, byRig: {}, withGPS: 0, withoutGPS: 0 };
  const revenueByCustomer = {};
  const newThisWeek = [];
  const returningThisWeek = [];

  for (const c of active) {
    const weekJobs = (c.jobHistory || []).filter(j =>
      j.status === 'completed' && j.source !== 'csv_backfill' &&
      j.date >= weekStart && j.date <= weekEnd
    );
    if (weekJobs.length === 0) continue;

    for (const j of weekJobs) {
      const amt  = j.amount || 0;
      const svc  = categorizeService(j.services || j.jobNotes || '');
      const rig  = j.rigId || 'unknown';
      revenue.total += amt;
      revenue.byRig[rig]   = (revenue.byRig[rig]   || 0) + amt;
      revenue.byService[svc] = (revenue.byService[svc] || 0) + amt;
      jobsCompleted.count++;
      jobsCompleted.byRig[rig] = (jobsCompleted.byRig[rig] || 0) + 1;
      if (j.actualDuration) jobsCompleted.withGPS++;
      else                  jobsCompleted.withoutGPS++;
    }

    const custRevenue = weekJobs.reduce((s, j) => s + (j.amount || 0), 0);
    revenueByCustomer[c.phone] = { name: fullName(c), phone: c.phone, revenue: custRevenue, jobCount: weekJobs.length };

    const hadPrior = (c.jobHistory || []).some(j =>
      j.status === 'completed' && j.source !== 'csv_backfill' && j.date < weekStart
    );
    if (hadPrior) returningThisWeek.push(fullName(c));
    else          newThisWeek.push(fullName(c));
  }

  const workerHoursRaw = computeWorkerHoursLocal(active, weekStart, weekEnd);
  const workerHours = Object.fromEntries(Object.entries(workerHoursRaw).map(([k, v]) => [k, v.hours]));
  const topCustomers = Object.values(revenueByCustomer).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  // Marketing attribution capture rate — new customers entered this week with a real source
  const newCustomersThisWeek = active.filter(c => {
    const d = (c.customerSince || c.createdAt || '').slice(0, 10);
    return d >= weekStart && d <= weekEnd;
  });
  const newWithRealSource = newCustomersThisWeek.filter(c => {
    const p = c.leadSource?.primary || '';
    return p && p !== 'didnt_ask';
  });
  const attributionCaptureRate = newCustomersThisWeek.length > 0
    ? Math.round((newWithRealSource.length / newCustomersThisWeek.length) * 100)
    : null;

  return {
    weekStart, weekEnd,
    generatedAt: new Date().toISOString(),
    revenue: { total: Math.round(revenue.total), byRig: revenue.byRig, byService: revenue.byService },
    jobsCompleted,
    customers: {
      totalActive:       active.length,
      servedThisWeek:    newThisWeek.length + returningThisWeek.length,
      newThisWeek:       newThisWeek.length,
      returningThisWeek: returningThisWeek.length,
    },
    workerHours,
    topCustomers,
    marketing_attribution_capture_rate: attributionCaptureRate,
    marketing_attribution_detail: {
      newCustomersThisWeek:    newCustomersThisWeek.length,
      withRealSource:          newWithRealSource.length,
      withDidntAsk:            newCustomersThisWeek.length - newWithRealSource.length,
    },
  };
}

export function generateCustomerHealth(customers) {
  const active = customers.filter(c => !c.deleted && !c.optOut && !(c.phone || '').startsWith('REFERRAL_') && !c.isReferralOnly);
  const now = Date.now();

  const overdueForService = [];
  const pendingQuotesAtRisk = [];
  const didNotServiceFollowUps = { followupNow: [], reengage: [], sixMonthCheckin: [], coldStorage: [] };
  const highValueLowEngagement = [];

  for (const c of active) {
    const completedJobs = (c.jobHistory || []).filter(j => j.status === 'completed' && j.source !== 'csv_backfill');
    const lifetimeValue = completedJobs.reduce((s, j) => s + (j.amount || 0), 0);
    const lastDates = completedJobs.map(j => j.date).filter(Boolean).sort();
    const lastService = lastDates[lastDates.length - 1] || null;
    const moSince = monthsSince(lastService);

    // Ground overdue (6+ months), roof overdue (18+ months)
    const groundJobs = completedJobs.filter(j => categorizeService(j.services || j.jobNotes || '') !== 'roof');
    const roofJobs   = completedJobs.filter(j => categorizeService(j.services || j.jobNotes || '') === 'roof');
    const lastGround = groundJobs.map(j => j.date).filter(Boolean).sort().pop() || null;
    const lastRoof   = roofJobs.map(j => j.date).filter(Boolean).sort().pop() || null;
    const groundMo = monthsSince(lastGround);
    const roofMo   = monthsSince(lastRoof);

    if ((lastGround && groundMo >= 6) || (lastRoof && roofMo >= 18)) {
      overdueForService.push({
        name: fullName(c), phone: c.phone, lifetimeValue: Math.round(lifetimeValue),
        lastService, monthsSinceLastService: moSince,
        groundOverdue: lastGround ? groundMo : null,
        roofOverdue:   lastRoof   ? roofMo   : null,
      });
    }

    // High value (lifetime > $1000), no service in 6+ months
    if (lifetimeValue >= 1000 && moSince >= 6) {
      highValueLowEngagement.push({
        name: fullName(c), phone: c.phone, lifetimeValue: Math.round(lifetimeValue),
        lastService, monthsSince: moSince,
      });
    }

    // Pending quotes at risk (verbal_pending or state='sent' for 5+ days)
    const ql = c.quoteLifecycle;
    const qs = c.quoteStatus || {};
    const pendingDate = qs.sentDate || qs.sentAt;
    if (ql === 'verbal_pending' || (qs.state === 'sent' && pendingDate)) {
      const days = pendingDate ? Math.floor((now - new Date(pendingDate).getTime()) / 86400000) : 0;
      if (days >= 5) {
        pendingQuotesAtRisk.push({ name: fullName(c), phone: c.phone, daysPending: days, source: ql || qs.state });
      }
    }

    // Did Not Service follow-ups
    if (c.quoteLifecycle === 'did_not_service') {
      const lastEntry = (c.quoteHistory || []).slice().reverse().find(e => e.outcome === 'did_not_service') || {};
      const daysSince = lastEntry.outcomeAt ? Math.floor((now - new Date(lastEntry.outcomeAt).getTime()) / 86400000) : null;
      const entry = { name: fullName(c), phone: c.phone, quotedService: lastEntry.quotedService || null, daysSinceDecline: daysSince, lastReachOutAt: c.lastReachOutAt || null };
      if      (daysSince === null || daysSince < 30)  didNotServiceFollowUps.followupNow.push(entry);
      else if (daysSince < 180)                        didNotServiceFollowUps.reengage.push(entry);
      else if (daysSince < 365)                        didNotServiceFollowUps.sixMonthCheckin.push(entry);
      else                                             didNotServiceFollowUps.coldStorage.push(entry);
    }
  }

  // Sort overdue by (lifetime value × months overdue) descending
  overdueForService.sort((a, b) => (b.lifetimeValue * b.monthsSinceLastService) - (a.lifetimeValue * a.monthsSinceLastService));
  highValueLowEngagement.sort((a, b) => b.lifetimeValue - a.lifetimeValue);

  // Marketing attribution health — last 30 days
  const cutoff30 = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const recent = active.filter(c => (c.customerSince || c.createdAt || '').slice(0, 10) >= cutoff30);
  const recentWithReal = recent.filter(c => { const p = c.leadSource?.primary || ''; return p && p !== 'didnt_ask'; });
  const recentCaptureRate = recent.length > 0 ? Math.round((recentWithReal.length / recent.length) * 100) : null;
  const attributionAlert = (recentCaptureRate !== null && recentCaptureRate < 50)
    ? { alert: 'low_attribution_capture', captureRate: recentCaptureRate, newCustomers30d: recent.length, withRealSource: recentWithReal.length, message: `Only ${recentCaptureRate}% of new customers in the last 30 days have a real marketing source — ${recent.length - recentWithReal.length} used "Didn't ask".` }
    : null;

  return {
    generatedAt: new Date().toISOString(),
    overdueForService: overdueForService.slice(0, 50),
    pendingQuotesAtRisk,
    didNotServiceFollowUps,
    coldStorageCount: didNotServiceFollowUps.coldStorage.length,
    highValueLowEngagement: highValueLowEngagement.slice(0, 30),
    attributionAlert,
  };
}

export function generateOperationsMetrics(customers, weekStart, weekEnd) {
  const active = customers.filter(c => !c.deleted);
  const durationsByService = {};
  const jobsByCity = {};
  const rigActivity = {};

  for (const c of active) {
    const weekJobs = (c.jobHistory || []).filter(j =>
      j.status === 'completed' && j.source !== 'csv_backfill' &&
      j.date >= weekStart && j.date <= weekEnd
    );
    for (const j of weekJobs) {
      const svc = categorizeService(j.services || j.jobNotes || '');
      const key = `${svc}_${j.rigId || 'unknown'}`;
      if (!durationsByService[key]) durationsByService[key] = { total: 0, count: 0 };
      if (j.actualDuration) {
        durationsByService[key].total += j.actualDuration;
        durationsByService[key].count += 1;
      }

      const city = (c.city || 'Unknown').trim();
      jobsByCity[city] = (jobsByCity[city] || 0) + 1;

      const rig = j.rigId || 'unknown';
      if (!rigActivity[rig]) rigActivity[rig] = { jobCount: 0, totalMinutes: 0, gpsJobCount: 0 };
      rigActivity[rig].jobCount++;
      if (j.actualDuration) {
        rigActivity[rig].totalMinutes  += j.actualDuration;
        rigActivity[rig].gpsJobCount++;
      }
    }
  }

  const avgDurationsByService = Object.fromEntries(
    Object.entries(durationsByService)
      .filter(([, v]) => v.count > 0)
      .map(([k, v]) => [k, Math.round(v.total / v.count)])
  );

  const rigUtilization = Object.fromEntries(
    Object.entries(rigActivity).map(([rig, d]) => [rig, {
      jobCount:      d.jobCount,
      gpsMatchedJobs: d.gpsJobCount,
      avgJobMinutes: d.gpsJobCount > 0 ? Math.round(d.totalMinutes / d.gpsJobCount) : null,
    }])
  );

  return {
    weekStart, weekEnd,
    generatedAt: new Date().toISOString(),
    avgJobDurationByServiceAndRig: avgDurationsByService,
    geographicSpread: jobsByCity,
    rigUtilization,
    note: 'Drive times between jobs require Bouncie morning_stops data — not yet linked to job entries.',
  };
}

export function generateExceptions(customers) {
  const now = new Date().toISOString().split('T')[0];
  const jobsWithoutCrew   = [];
  const jobsWithoutGPS    = [];
  const missingData       = [];
  const duplicatePhones   = {};
  const seenPhones        = {};

  for (const c of customers) {
    if (c.deleted) continue;

    // Duplicate phone detection
    const ph = (c.phone || '').replace(/\D/g, '').slice(-10);
    if (ph && !ph.startsWith('0000')) {
      if (seenPhones[ph]) {
        if (!duplicatePhones[ph]) duplicatePhones[ph] = [seenPhones[ph]];
        duplicatePhones[ph].push(fullName(c));
      } else {
        seenPhones[ph] = fullName(c);
      }
    }

    // Missing required fields
    const missing = [];
    if (!c.firstName && !c.lastName) missing.push('name');
    if (!c.address)  missing.push('address');
    if (!c.phone)    missing.push('phone');
    if (missing.length) missingData.push({ name: fullName(c) || c.phone || 'Unknown', phone: c.phone, missing });

    // Recent jobs (last 90 days) without crew or GPS
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    for (const j of (c.jobHistory || [])) {
      if (j.status !== 'completed' || j.source === 'csv_backfill') continue;
      if (!j.date || j.date < cutoffStr) continue;
      if (!j.crew || j.crew.length === 0) {
        jobsWithoutCrew.push({ customer: fullName(c), phone: c.phone, date: j.date, amount: j.amount });
      }
      if (!j.actualDuration) {
        jobsWithoutGPS.push({ customer: fullName(c), phone: c.phone, date: j.date, rigId: j.rigId });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    jobsWithoutCrew:   jobsWithoutCrew.slice(0, 50),
    jobsWithoutGPS:    jobsWithoutGPS.slice(0, 50),
    customersWithMissingData: missingData.slice(0, 30),
    duplicatePhones:   Object.entries(duplicatePhones).map(([ph, names]) => ({ phone: ph, names })),
    summary: {
      jobsWithoutCrewCount: jobsWithoutCrew.length,
      jobsWithoutGPSCount:  jobsWithoutGPS.length,
      missingDataCount:     missingData.length,
      duplicatePhoneCount:  Object.keys(duplicatePhones).length,
    },
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────
export async function runWeeklyExport(env, weekStart, weekEnd) {
  const db = await env.DATA.get('customer_db', 'json');
  const customers = db?.customers || [];

  const [summary, health, ops, exceptions] = await Promise.all([
    Promise.resolve(generateWeeklySummary(customers, weekStart, weekEnd)),
    Promise.resolve(generateCustomerHealth(customers)),
    Promise.resolve(generateOperationsMetrics(customers, weekStart, weekEnd)),
    Promise.resolve(generateExceptions(customers)),
  ]);

  const dateTag    = weekStart;
  const filesWritten = [];
  const driveLinks   = [];
  const errors       = [];

  const uploads = [
    { name: `weekly_summary_${dateTag}.json`,       data: summary    },
    { name: `customer_health_${dateTag}.json`,       data: health     },
    { name: `operations_metrics_${dateTag}.json`,    data: ops        },
    { name: `exceptions_${dateTag}.json`,            data: exceptions },
  ];

  for (const { name, data } of uploads) {
    try {
      const result = await writeToGoogleDrive(name, data, env);
      filesWritten.push(result.name);
      if (result.webViewLink) driveLinks.push(result.webViewLink);
    } catch (e) {
      errors.push({ file: name, error: e.message });
    }
  }

  // Write heartbeat
  await env.DATA.put('google_export:last_run', JSON.stringify({
    ranAt: new Date().toISOString(), weekStart, weekEnd,
    filesWritten, errors, success: errors.length === 0,
  }));

  return { success: errors.length === 0, filesWritten, driveLinks, errors, weekStart, weekEnd };
}
