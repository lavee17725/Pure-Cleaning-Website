#!/usr/bin/env node
/**
 * Read-only codebase audit — Pure Cleaning CRM.
 *
 * Audits against TYLER'S OWN LAWS (CLAUDE.md), not generic best practice.
 *
 * READ-ONLY BY CONSTRUCTION: this file calls readFileSync and nothing else.
 * No exec, no network, no git. It reads with readFileSync and writes NOTHING,
 * with exactly one exception: --json <path> emits candidates for the skill
 * layer, and that path is REJECTED if it resolves inside the repo (see the
 * guard at the bottom). It cannot modify source, deploy, or commit.
 *
 *   node scripts/audit.js                    # everything
 *   node scripts/audit.js --scope calendar   # calendar + its shared JS
 *   node scripts/audit.js --scope worker
 *   node scripts/audit.js --check drift      # one class
 *   node scripts/audit.js --json /tmp/x.json # candidates for the skill layer
 *   node scripts/audit.js --self-test        # ACCEPTANCE: rediscover known drift
 *
 * WHAT THIS IS NOT: it does not check customer data (integrity-check.js), the
 * live deployment (verify-deploy.js), rendered behaviour (verify-browser.js),
 * types (typecheck.js) or secrets (secret-scan.js). It reads local source and
 * reasons about its structure — the one thing nothing else does, and the blind
 * spot that produced Rule 26.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg  = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SCOPE     = arg('--scope', 'all');
const ONLY      = arg('--check', null);
const JSON_OUT  = arg('--json', null);
const SELF_TEST = argv.includes('--self-test');

// ── Suppression: known and deliberate ────────────────────────────────────────
// Seeded BEFORE first run, by Tyler's instruction: "a first run that dumps
// known noise teaches me to skim it." Anything here is reported as KNOWN in a
// separate section, never as a new finding.
const SUPPRESS = {
  // Known Drift Register (CLAUDE.md) — open, recorded, not news.
  drift: [
    { match: /_d1PropId/,                 why: 'Drift Register D-1 — property key generation' },
    { match: /scheduleJobWithDualWrite/,  why: 'Drift Register D-2 — booking write path (FWQ 1.10)' },
    { match: /normAddr|_ncAgNormStreet|_ADDR_TYPE_FOLD/, why: 'Drift Register D-3 — address normalization' },
    { match: /fmtElapsed|monthsSince|lastServiceDateFor/, why: 'Drift Register D-4 — elapsed since last service' },
  ],
  // Tyler's explicit call, 2026-08-05: identical one-liners that agree by
  // construction. Noise, not risk.
  phoneNormalization: /replace\(\/\\D\/g,\s*''\)\.slice\(-10\)/,
};

// ── File collection ──────────────────────────────────────────────────────────
const SCOPES = {
  all:       ['public/*.html', 'public/js/*.js', 'cloudflare-worker/src/index.js', 'scripts/verify-*.js'],
  calendar:  ['public/pure_cleaning_calendar.html', 'public/js/*.js'],
  worker:    ['cloudflare-worker/src/index.js'],
  directory: ['public/pure_cleaning_customer_directory.html', 'public/js/customer-search.js'],
  gates:     ['scripts/verify-deploy.js', 'scripts/verify-browser.js'],
};

function collect(patterns) {
  const out = [];
  for (const p of patterns) {
    if (!p.includes('*')) { const f = path.join(ROOT, p); if (fs.existsSync(f)) out.push(f); continue; }
    const dir = path.join(ROOT, path.dirname(p));
    if (!fs.existsSync(dir)) continue;
    const re = new RegExp('^' + path.basename(p).replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$');
    for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push(path.join(dir, f));
  }
  return [...new Set(out)];
}

const findings = [];
function add(o) {
  if (ONLY && o.check !== ONLY) return;
  findings.push(o);
}
const rel  = f => path.relative(ROOT, f);
// Blank out comments while preserving byte offsets, so line numbers stay true.
// Without this the detector matched its own explanatory comments — the
// renderDayHealth finding on the first run was a comment describing the fix.
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
  .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// ═══════════════════════════════════════════════════════════════════════════
// CHECK: DRIFT — is this question already answered somewhere else?
// The highest-value check. Two detectors, both high-precision:
//   (a) duplicated CONSTANT MAPS — the roof-label map lived in 6 copies and
//       _ADDR_TYPE_FOLD in 4. A repeated object literal is almost never
//       coincidence and almost always one fact with several homes.
//   (b) the same FUNCTION NAME defined in more than one file.
// Deliberately NOT doing fuzzy body-similarity: it floods with false positives
// (every formatDate looks like every other), and a false finding costs Tyler
// attention, which is the scarce resource.
// ═══════════════════════════════════════════════════════════════════════════
let pageDupCount = 0;
const return_pageDup = [];
function checkDrift(files) {
  const maps = new Map();   // normalized literal -> [{file,line,keys}]
  const fns  = new Map();   // fn name -> [{file,line}]

  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));

    // (a) object literals with >=3 string-ish keys, on one line or a few.
    const litRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^{}]{40,900})\}/g;
    let m;
    while ((m = litRe.exec(src))) {
      const body = m[2];
      const keys = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map(x => x[1]).sort();
      if (keys.length < 3) continue;
      // Shared KEYS are not enough. RIG_LABELS and RIG_CAP_COLORS are both keyed
      // rig_1/rig_2/rig_3 and are NOT duplicates — one holds names, the other
      // colours. Fingerprint the VALUES too, so "same keys, different fact"
      // stops being reported. A false finding costs Tyler attention, which is
      // the scarce resource.
      const vals = [...body.matchAll(/:\s*'([^']{2,40})'/g)].map(x => x[1].toLowerCase()).sort();
      if (vals.length < 3) continue;          // not a literal label/config map
      // UPPER_SNAKE or _camel module constants only — skips local variables
      // like `groups` that happen to be object literals.
      if (!/^_?[A-Z][A-Z0-9_]{2,}$|^_[a-zA-Z]/.test(m[1])) continue;
      const sig = keys.join(',') + '|' + vals.slice(0, 6).join(',');
      if (!maps.has(sig)) maps.set(sig, []);
      maps.get(sig).push({ file: rel(f), line: lineOf(src, m.index), name: m[1], keys: keys.length, vals });
    }

    // (b) named function declarations
    const fnRe = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    while ((m = fnRe.exec(src))) {
      const n = m[1];
      // Body size is the discriminator between a helper and a real
      // implementation. Crude brace-depth scan — good enough to separate a
      // 3-line esc() from a 60-line write path.
      // Skip the parameter list FIRST. `function f({ a, b })` destructures, so
      // naive brace counting closes on the parameter object and reports a
      // 60-line write path as 14 lines — which is how the first version of this
      // suppressed Drift Register D-2. The acceptance test caught it.
      let p = src.indexOf('(', m.index), pd = 0, bodyStart = -1;
      for (let i = p; i < Math.min(src.length, p + 4000); i++) {
        if (src[i] === '(') pd++;
        else if (src[i] === ')') { pd--; if (pd === 0) { bodyStart = src.indexOf('{', i); break; } }
      }
      let depth = 0, end = m.index, seen = false;
      for (let i = bodyStart > 0 ? bodyStart : m.index; i < Math.min(src.length, m.index + 40000); i++) {
        if (src[i] === '{') { depth++; seen = true; }
        else if (src[i] === '}') { depth--; if (seen && depth === 0) { end = i; break; } }
      }
      const bodyLines = src.slice(m.index, end).split('\n').length;
      if (!fns.has(n)) fns.set(n, []);
      fns.get(n).push({ file: rel(f), line: lineOf(src, m.index), size: bodyLines });
    }
  }

  // Merge buckets whose key sets overlap >= 80%. Exact-signature matching split
  // _roofTypeLabels (8 keys) from the five 9-key copies of the same map and
  // under-reported the duplication.
  const sigs = [...maps.keys()];
  for (let i = 0; i < sigs.length; i++) {
    for (let k = i + 1; k < sigs.length; k++) {
      if (!maps.has(sigs[i]) || !maps.has(sigs[k])) continue;
      const [ka, va] = sigs[i].split('|'), [kb, vb] = sigs[k].split('|');
      const jac = (x, y) => {
        const A = new Set(x.split(',')), B = new Set(y.split(','));
        const inter = [...A].filter(t => B.has(t)).length;
        const union = new Set([...A, ...B]).size;
        return union ? inter / union : 0;
      };
      // Same fact = overlapping keys AND overlapping values.
      if (jac(ka, kb) >= 0.8 && jac(va || '', vb || '') >= 0.6) {
        maps.get(sigs[i]).push(...maps.get(sigs[k]));
        maps.delete(sigs[k]);
      }
    }
  }

  for (const [sig, hits] of maps) {
    if (hits.length < 2) continue;
    const where = hits.map(h => `${h.file}:${h.line}`);
    const sup = SUPPRESS.drift.find(s => s.match.test(hits[0].name) || s.match.test(sig));
    add({
      check: 'drift', kind: 'duplicated-constant-map',
      what: `The same ${hits[0].keys}-key map is defined ${hits.length}× (${hits.map(h => h.name).join(', ')})`,
      where, severity: hits.length >= 3 ? 'MEDIUM' : 'LOW',
      confidence: 'certain',
      breaks: 'One fact with several homes — editing one copy silently leaves the others stale.',
      known: sup ? sup.why : null,
    });
  }

  for (const [name, hits] of fns) {
    if (hits.length < 2) continue;
    const files = [...new Set(hits.map(h => h.file))];
    if (files.length < 2) continue;   // overloads in one file are not drift
    // Every admin page in this codebase is a standalone HTML file, so page-to-
    // page helper duplication (esc, render, fmt…) is architecture, not drift —
    // reporting it produced 700+ rows and buried the real signal. A finding
    // requires a SHARED home to exist or obviously belong: public/js/* or the
    // worker. Page↔page duplicates are counted and reported as one summary line.
    const touchesShared = files.some(f => f.startsWith('public/js/') || f.includes('cloudflare-worker'));
    const biggest = Math.max(...hits.map(h => h.size || 0));
    if (!touchesShared && biggest < 25) { pageDupCount++; return_pageDup.push(name); continue; }
    const sup = SUPPRESS.drift.find(s => s.match.test(name));
    add({
      check: 'drift', kind: 'same-function-two-files',
      what: `function ${name}() is defined in ${files.length} files`,
      where: hits.map(h => `${h.file}:${h.line}`),
      severity: Math.max(...hits.map(h => h.size || 0)) >= 25 ? 'HIGH' : 'MEDIUM',
      confidence: 'worth-a-look',
      breaks: 'If both answer the same question they will diverge — Rule 25 / Drift Register class.',
      known: sup ? sup.why : null,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHECK: SILENT FAILURES — the class that reports success while doing nothing.
// ═══════════════════════════════════════════════════════════════════════════
const emptyCatch = [];
function checkSilent(files) {
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const lines = src.split('\n');

    // (a) indexedDB.open without onblocked — the _idbOpen hang. A blocked open
    //     fires NEITHER onsuccess NOR onerror, so the promise never settles and
    //     the caller waits forever with no error to catch.
    if (/indexedDB\.open\(/.test(src)) {
      const idx = src.indexOf('indexedDB.open(');
      const window_ = src.slice(idx, idx + 900);
      if (!/onblocked/.test(window_)) {
        add({ check: 'silent', kind: 'promise-never-settles',
          what: 'indexedDB.open() with no onblocked handler',
          where: [`${rel(f)}:${lineOf(src, idx)}`], severity: 'HIGH', confidence: 'certain',
          breaks: 'A blocked open fires neither onsuccess nor onerror — the promise never settles, the page hangs, and no catch can fire.' });
      }
    }

    // (b) optional-call on an identifier never declared anywhere in the file.
    //     `foo?.()` guards a null VALUE, not an undeclared binding — it throws.
    for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\?\.\(/g)) {
      const name = m[1];
      const declared = new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b|${name}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\())`).test(src);
      if (!declared) {
        add({ check: 'silent', kind: 'optional-call-undeclared',
          what: `${name}?.() — optional call on an identifier not declared in this file`,
          where: [`${rel(f)}:${lineOf(src, m.index)}`], severity: 'HIGH', confidence: 'worth-a-look',
          breaks: 'Optional-call guards a null value, not an undeclared binding. Throws ReferenceError on every execution.' });
      }
    }

    // (c) catch blocks that swallow entirely
    const swallows = [...src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)];
    if (swallows.length) emptyCatch.push({ file: rel(f), n: swallows.length,
      lines: swallows.slice(0, 5).map(m => lineOf(src, m.index)) });

    // (d) fire-and-forget writes — T1.20. A POST/PUT/PATCH whose response is
    //     never inspected, followed by a success toast.
    lines.forEach((ln, i) => {
      if (!/await fetch\(/.test(ln)) return;
      if (!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(lines.slice(i, i + 6).join(' '))) return;
      const after = lines.slice(i, i + 12).join(' ');
      if (/\.ok\b|status\b|catch/.test(after)) return;
      if (/showToast\(\s*['"`]\s*[✓✅]/.test(after)) {
        add({ check: 'silent', kind: 'unverified-success',
          what: 'A write whose response is never checked, followed by a success toast',
          where: [`${rel(f)}:${i + 1}`], severity: 'HIGH', confidence: 'worth-a-look',
          breaks: 'T1.20 — the toast lies when the server rejects. This is how the payment guard\'s 400 showed as success.' });
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHECK: RULE 26 — gate checks that can go green while the screen is wrong.
// ═══════════════════════════════════════════════════════════════════════════
function checkGates(files) {
  for (const f of files.filter(x => /verify-(deploy|browser)\.js$/.test(x))) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    // Asserting a FUNCTION NAME appears in the HTML proves the function exists,
    // not that anything calls it. That is exactly how the UNPAID badge shipped
    // green twice while every completed card was wrong.
    for (const m of src.matchAll(/html\.includes\(\s*['"`](?:function\s+)?([A-Za-z_$][\w$]{5,})['"`]\s*\)/g)) {
      add({ check: 'gates', kind: 'marker-only-assertion',
        what: `Gate asserts the string "${m[1]}" appears in the HTML`,
        where: [`${rel(f)}:${lineOf(src, m.index)}`], severity: 'MEDIUM', confidence: 'worth-a-look',
        breaks: 'Rule 26 — proves the code exists, not that it runs or that the screen is right. A caller that never calls is invisible.' });
    }
    // window.<script-scope let> — the dayOffset bug. Assigning to window does
    // nothing when the binding is a top-level let/const.
    for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) {
      add({ check: 'gates', kind: 'window-assignment-to-scoped-binding',
        what: `Gate sets window.${m[1]} — does nothing if that binding is a top-level let/const`,
        where: [`${rel(f)}:${lineOf(src, m.index)}`], severity: 'HIGH', confidence: 'worth-a-look',
        breaks: 'Rule 26 — the page silently ignores it and the check audits the wrong state while reporting success.' });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHECK: DEAD CODE — flag only, never delete. Endpoints outlive their pages
// (/admin/day-route survived pure_cleaning_day_route.html), so an unreferenced
// handler is a QUESTION, not a verdict.
// ═══════════════════════════════════════════════════════════════════════════
function checkDead(files) {
  const all = files.map(f => ({ f, src: fs.readFileSync(f, 'utf8') }));
  const corpus = all.map(x => x.src).join('\n');
  for (const { f, src } of all) {
    for (const m of src.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      const name = m[1];
      if (name.length < 5) continue;
      const uses = (corpus.match(new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, 'g')) || []).length;
      const inHtml = new RegExp(`on\\w+\\s*=\\s*["'][^"']*${name}\\s*\\(`).test(corpus);
      if (uses <= 1 && !inHtml) {
        add({ check: 'dead', kind: 'uncalled-function',
          what: `function ${name}() has no caller in the audited scope`,
          where: [`${rel(f)}:${lineOf(src, m.index)}`], severity: 'LOW', confidence: 'worth-a-look',
          breaks: 'Dead weight that misleads the next edit. FLAG ONLY — may be called from an unaudited file, a cron, or an inline handler.' });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHECK: DOC STALENESS — separate section. Stale laws are worse than no laws
// because Tyler trusts them.
// ═══════════════════════════════════════════════════════════════════════════
function checkDocs() {
  const claude = path.join(ROOT, 'CLAUDE.md');
  if (!fs.existsSync(claude)) return;
  const src = fs.readFileSync(claude, 'utf8');

  // The verifier check-count comparison lived here and was REMOVED 2026-08-07.
  // Counting assertions statically (pass(/fail( occurrences) undercounts every
  // one inside a loop — it read ~206 where the gate reports 320, so the check
  // silently reported 0 findings whether or not the doc was stale. Tyler's
  // call: "a check I can't trust is worse than no check." The dead-file-
  // reference check below is deterministic and stays.

  // file:line citations that no longer point at what they claim
  for (const m of src.matchAll(/`?([\w/.-]+\.(?:js|html))(?::(\d+))?`?\s*(?:—|-)?/g)) {
    const p = path.join(ROOT, m[1].startsWith('public/') || m[1].startsWith('scripts/') || m[1].startsWith('cloudflare-worker/') ? m[1] : '');
    if (!m[1].includes('/')) continue;
    if (!fs.existsSync(p)) {
      add({ check: 'docs', kind: 'missing-file-reference',
        what: `CLAUDE.md references ${m[1]}, which does not exist`,
        where: [`CLAUDE.md:${lineOf(src, m.index)}`], severity: 'MEDIUM', confidence: 'certain',
        breaks: 'A law pointing at a deleted file sends the next session somewhere that no longer exists.' });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE TEST — T1.24 applied to this tool.
// The manual audit of 2026-08-05 found 7 drift sites. Three were resolved
// (group amount, unpaid, review eligibility) and are GONE from the source by
// design, so they cannot be rediscovered — the honest test is the ones still
// present. If this cannot find those, the tool does not work and must not ship.
// ═══════════════════════════════════════════════════════════════════════════
const KNOWN_DRIFT_STILL_PRESENT = [
  { id: 'D-1 _d1PropId',                needle: /_d1PropId/ },
  { id: 'D-2 scheduleJobWithDualWrite', needle: /scheduleJobWithDualWrite/ },
  { id: 'D-3 address normalization',    needle: /normAddr|_ADDR_TYPE_FOLD|_ncAgNormStreet/ },
  { id: 'roof-label map (6 copies)',    needle: /ROOF_LABELS|roofTypeLabels/ },
];

// SEMANTIC drift — the same question under DIFFERENT names in different files.
// No regex can decide that fmtElapsed, monthsSince and lastServiceDateFor
// answer one question; that is the skill layer's job. Listed here so the
// acceptance test reports it as out-of-scope rather than as a silent pass.
const KNOWN_DRIFT_SEMANTIC = [
  { id: 'D-4 elapsed since service', why: 'three different names, one question — needs reading comprehension' },
];

function selfTest(files) {
  findings.length = 0;
  checkDrift(files);
  const hay = findings.map(f => f.what + ' ' + f.where.join(' ')).join('\n');
  const srcAll = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  console.log('\n  ACCEPTANCE TEST — can the detector rediscover known drift?\n');
  let pass = 0;
  for (const k of KNOWN_DRIFT_STILL_PRESENT) {
    const detected = k.needle.test(hay);
    const existsInSource = k.needle.test(srcAll);
    const verdict = detected ? 'FOUND' : existsInSource ? 'MISSED' : 'n/a (not in scope)';
    if (detected) pass++;
    console.log(`    ${detected ? '✅' : existsInSource ? '❌' : '⚪'}  ${k.id.padEnd(34)} ${verdict}`);
  }
  console.log(`\n    ${pass} / ${KNOWN_DRIFT_STILL_PRESENT.length} mechanically rediscovered`);
  console.log('\n    Out of scope for the script — the skill layer must catch these:');
  for (const k of KNOWN_DRIFT_SEMANTIC) console.log(`    ⚪  ${k.id.padEnd(34)} ${k.why}`);
  if (pass < KNOWN_DRIFT_STILL_PRESENT.length) {
    console.log('\n  🚨 A MECHANICAL CASE WAS MISSED — do not ship. Tyler would rather have no');
    console.log('     tool than one that reports green on a codebase he knows has drift in it.\n');
    process.exitCode = 1;
  } else {
    console.log('\n  Detector rediscovers the known sites. Safe to trust its NEW findings.\n');
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
const files = collect(SCOPES[SCOPE] || SCOPES.all);
if (!files.length) { console.error(`No files for scope "${SCOPE}"`); process.exit(1); }

if (SELF_TEST) { selfTest(files); return; }

checkDrift(files);
checkSilent(files);
checkGates(files);
// Dead-code detection needs a bounded corpus to be meaningful — across every
// page it reports hundreds of per-page helpers that are called from inline
// handlers it cannot see. Opt-in, and never on --scope all.
if (ONLY === 'dead' || (SCOPE !== 'all' && !ONLY)) checkDead(files);
if (SCOPE === 'all' && !ONLY) checkDocs();

// Collapsed summaries — reported as ONE row each, with counts, so a real
// finding is never buried under a hundred identical low-severity ones.
if (emptyCatch.length && (!ONLY || ONLY === 'silent')) {
  const total = emptyCatch.reduce((a, b) => a + b.n, 0);
  add({ check: 'silent', kind: 'empty-catch-summary',
    what: `${total} empty catch blocks across ${emptyCatch.length} file(s)`,
    where: emptyCatch.slice(0, 5).map(e => `${e.file} (${e.n}, e.g. line ${e.lines[0]})`),
    severity: 'LOW', confidence: 'worth-a-look',
    breaks: 'Most are legitimate best-effort. Worth a scan only for any on a decision-driving path.' });
}
if (pageDupCount && (!ONLY || ONLY === 'drift')) {
  add({ check: 'drift', kind: 'page-helper-duplication-summary',
    what: `${pageDupCount} helper names defined in 2+ standalone pages (esc, render, fmt…)`,
    where: [`e.g. ${return_pageDup.slice(0, 6).join(', ')}`],
    severity: 'LOW', confidence: 'worth-a-look',
    breaks: 'Architectural — each admin page is standalone. Reported as a count, not enumerated. Only matters if one holds a business rule.' });
}

// ── Report ───────────────────────────────────────────────────────────────────
const RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const known = findings.filter(f => f.known);
const fresh = findings.filter(f => !f.known);
const certain = fresh.filter(f => f.confidence === 'certain').sort((a, b) => RANK[a.severity] - RANK[b.severity]);
const maybe   = fresh.filter(f => f.confidence !== 'certain').sort((a, b) => RANK[a.severity] - RANK[b.severity]);
const docs    = certain.concat(maybe).filter(f => f.check === 'docs');

console.log(`\n  READ-ONLY AUDIT — scope: ${SCOPE} · ${files.length} file(s)\n`);

const show = (title, list) => {
  const rows = list.filter(f => f.check !== 'docs');
  if (!rows.length) return;
  console.log(`  ── ${title} (${rows.length}) ` + '─'.repeat(Math.max(0, 54 - title.length)));
  for (const f of rows) {
    console.log(`\n  [${f.severity}] ${f.what}`);
    f.where.slice(0, 6).forEach(w => console.log(`      ${w}`));
    if (f.where.length > 6) console.log(`      …and ${f.where.length - 6} more`);
    console.log(`      → ${f.breaks}`);
  }
  console.log('');
};

show('CERTAIN', certain);
show('WORTH A LOOK', maybe);

if (docs.length) {
  console.log(`  ── DOC STALENESS (${docs.length}) ` + '─'.repeat(40));
  for (const f of docs) { console.log(`\n  [${f.severity}] ${f.what}`); f.where.forEach(w => console.log(`      ${w}`)); }
  console.log('');
}

if (known.length) {
  console.log(`  ── ALREADY KNOWN — not new findings (${known.length}) ` + '─'.repeat(24));
  for (const f of known) console.log(`     · ${f.what}  [${f.known}]`);
  console.log('');
}

console.log(`  ${certain.length} certain · ${maybe.length} worth a look · ${docs.length} doc · ${known.length} known`);
console.log('  Read-only: nothing was modified.\n');

if (JSON_OUT) {
  if (JSON_OUT.startsWith(ROOT)) {
    console.error('  Refusing to write inside the repo. Pass a path outside it.');
    process.exit(1);
  }
  fs.writeFileSync(JSON_OUT, JSON.stringify({ scope: SCOPE, files: files.map(rel), findings }, null, 2));
  console.log(`  Candidates → ${JSON_OUT}\n`);
}
