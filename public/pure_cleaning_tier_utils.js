/* ── Shared Tier Classification ───────────────────────────────────────────────
   Used by: Customer Directory + Bulk Reactivation
   Edit here to update tier logic for BOTH pages simultaneously.
   ─────────────────────────────────────────────────────────────────────────── */

function moAgo(s) {
  if (!s) return null;
  const d = new Date(s.includes('T') ? s : s + 'T12:00:00');
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30);
}

const ROOF_RE = /\broof\b/i;

function getEffectiveStats(c) {
  const jh = c.jobHistory || [];
  if (jh.length > 0) {
    return {
      totalJobs:     jh.length,
      lifetimeSpend: jh.reduce((s, j) => s + (j.amount || 0), 0),
      lastService:   jh.map(j => j.date).filter(Boolean).sort().slice(-1)[0] || null,
    };
  }
  return {
    totalJobs:     c.totalJobs     || 0,
    lifetimeSpend: c.lifetimeSpend || 0,
    lastService:   c.lastService   || null,
  };
}

function getRebookWindow(c) {
  const jh = c.jobHistory || [];
  const allSvc = [
    ...jh.map(j => j.services || ''),
    (c.scheduledStatus || {}).jobNotes      || '',
    (c.quoteStatus     || {}).mainServices  || '',
  ].join(' ');
  return ROOF_RE.test(allSvc) ? { lo: 18, hi: 36 } : { lo: 6, hi: 18 };
}

/* Returns { label, emoji, color, vip } */
function getTier(c) {
  if (c.optOut)    return { label: 'OPT-OUT',    emoji: '⛔', color: '#dc2626', vip: false };
  if (c.movedAway) return { label: 'MOVED',      emoji: '🏠', color: '#64748b', vip: false };

  const { totalJobs, lifetimeSpend, lastService } = getEffectiveStats(c);
  const vip = totalJobs >= 5 || lifetimeSpend >= 2500;

  const ss = c.scheduledStatus || {};
  if (ss.state === 'scheduled' || ss.state === 'needs_scheduling')
    return { label: 'SCHEDULED', emoji: '📋', color: '#2563eb', vip };

  if (!lastService && totalJobs === 0)
    return { label: 'NO HISTORY', emoji: '○', color: '#94a3b8', vip: false };

  const mo = moAgo(lastService);
  if (mo === null) return { label: 'NO HISTORY', emoji: '○', color: '#94a3b8', vip: false };

  const isRepeat  = totalJobs >= 2;
  const { lo, hi } = getRebookWindow(c);
  const inWindow  = mo >= lo && mo <= hi;
  const overdue   = mo > hi;

  if (inWindow && isRepeat)  return { label: 'HOT',        emoji: '🔥', color: '#dc2626', vip };
  if (inWindow && !isRepeat) return { label: 'WARM',       emoji: '🌡️', color: '#f97316', vip };
  if (overdue)               return { label: 'OVERDUE',    emoji: '⏰', color: '#eab308', vip };
  if (isRepeat  && mo <= 6)  return { label: 'LOYAL',      emoji: '💚', color: '#16a34a', vip };
  if (!isRepeat && mo <= 6)  return { label: 'NEW',        emoji: '🌱', color: '#10b981', vip };
  return                            { label: 'DORMANT',    emoji: '💤', color: '#8b5cf6', vip };
}

function isDueForReactivation(c) {
  const { lastService } = getEffectiveStats(c);
  if (!lastService) return false;
  const mo = moAgo(lastService);
  const { hi } = getRebookWindow(c);
  return mo > hi;
}
