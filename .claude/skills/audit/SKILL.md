---
name: audit
description: Read-only codebase audit against Tyler's own laws (CLAUDE.md) — drift, Rule 25, Rule 21/T1.22, Rule 26, silent failures, dead code, doc staleness. Produces a ranked report. Never writes, edits, deploys, or fixes anything.
---

# Read-only codebase audit

## THE ONE RULE

**This skill NEVER writes, edits, deploys, commits, or fixes anything — not
even an "obvious" one-line fix, not even a typo, not even something broken you
are certain about.**

The output is always a report. If you find something that needs fixing, you
say so and stop. Tyler decides what gets fixed and when. Fixing something
mid-audit means he can't trust that the audit didn't change what it measured.

If you catch yourself reaching for Edit or Write during an audit, that is the
signal you have drifted out of the skill.

---

## How to run it

```
node scripts/audit.js --scope calendar     # calendar + shared JS
node scripts/audit.js --scope worker
node scripts/audit.js --scope directory
node scripts/audit.js --scope gates
node scripts/audit.js                      # everything (slow, whole codebase)
node scripts/audit.js --check drift        # one class
node scripts/audit.js --self-test          # acceptance test (see below)
```

`--scope` exists so an audit fits a session. Whole-codebase runs produce more
than Tyler will read in one sitting; prefer the area he is actually working in.

**Run `--self-test` first if you have not run it this session.** It proves the
drift detector can still rediscover the four known-drift sites found manually
on 2026-08-05. If it cannot, **the tool is broken — say so and do not present
its findings as trustworthy.** That is T1.24 applied to the tool itself, and it
was Tyler's hard requirement.

---

## What the script can and cannot do

The script is **mechanical** — deterministic, read-only by construction, high
precision. It finds:

- duplicated constant maps (same keys AND same values in 2+ places)
- the same function name defined in 2+ files
- `indexedDB.open()` with no `onblocked` (the promise-never-settles class)
- `foo?.()` where `foo` is never declared in the file
- empty catch blocks
- writes whose response is never checked, followed by a success toast (T1.20)
- gate checks asserting on marker strings or `window.<scoped-let>` (Rule 26)
- functions with no caller in scope
- stale doc claims and dead file references

### Vocabulary check (failure mode #5) — needs data

`--vocab-data <file>` supplies `{"Table.column": {"value": count}}`. Without it
the vocabulary check runs its STATIC half only and compares nothing. Capture it
with a wrangler query, write it to the scratch dir, then pass it:

```
npx wrangler d1 execute pure-cleaning-crm-v1 --remote \
  --config cloudflare-worker/wrangler.toml --json \
  --command "SELECT 'Job.roofType' c, roofType v, COUNT(*) n FROM Job WHERE roofType IS NOT NULL GROUP BY v" 
node scripts/audit.js --check vocab --vocab-data <scratch>/vocab.json
```

Read the THREE BUCKETS in the coverage line and repeat them to Tyler: traced
columns, clean vs mismatched, and how many lookups were UNTRACEABLE. Roughly a
third use a computed key (`LABELS[fn(x)]`, `LABELS[a || b]`) and cannot be
resolved without executing the code. **Never present the check as complete.**

**It cannot decide whether two things answer the same QUESTION.** That is your
job, and it is the highest-value part of this skill.

---

## Your job: the semantic layer

Take the script's candidates and add what a regex cannot see.

### 1. DRIFT — same question, different names

The script catches same-*name* duplication. The dangerous case is the same
*question* under different names in different files:

> `fmtElapsed` (directory) · `monthsSince` (bulk reactivation) ·
> `lastServiceDateFor` (worker) — three names, one question: "how long since
> we served this customer?" That is Drift Register D-4, and no regex finds it.

Read the code and ask: **if the business rule changed, how many places would
have to change?** More than one is a finding.

Cross-reference the **Known Drift Register in CLAUDE.md**. Entries already
listed are reported as known, never as new. Report only NEW instances.

### 2. RULE 25 — pages render, the worker decides

Look for a page computing a **judgment**: is this ready, is this unpaid, is
this eligible, what is this worth. Tells:

- a client-side `.filter()` over `dbRecord.customers` that decides eligibility
- a page-side function whose name mirrors a worker function
- a threshold or business constant living in a page

Formatting, sorting and **narrowing** the worker's answer are fine. Computing
a second opinion is not. The UNPAID badge and the review banner were both this.

### 3. RULE 21 / T1.22 — capture ⟹ persist ⟹ connect

For each field on a read surface, ask: **where is it written?** Check it
appears in `_JOB_MUTABLE_FIELDS` if PATCH-able, and in the INSERT column list
of every path that creates the record. A field in a read surface with no write
path is the `sqFt` failure. A field written only to the KV blob is DL-09 — the
next rebuild erases it.

### 4. RULE 26 — checks that can go green while the screen is wrong

For each gate candidate, ask: **would this fail if the feature were broken but
the code still present?** If a check asserts `html.includes('someFunction')`,
it passes whether or not anything calls it.

### 5. RULE 28 — a strict read demands a validated write

For every vocabulary the script finds, ask: **can an unvalidated path write this
column?** A `<select>` writing enum is fine; the danger is a second path — a
legacy KV field, a bulk resync, a free-text admin input — reaching the same
column. Check the column appears in `/admin/debug/vocab-values`; if it has a
normaliser but is missing from that endpoint, the gate is blind to it.

### 6. SILENT FAILURES

Beyond the script's patterns: defaults that mask missing data (`|| 0` on a
value where null means "unknown"), success reported before verification, error
paths that cannot be reached.

---

## Output format

Rank by **business impact, not ease of fixing.**

Each finding carries: **what · where (file:line) · what it could break ·
severity · confidence.**

- **CRITICAL** — silently corrupts money or customer data
- **HIGH** — wrong information reaches Tyler or a customer
- **MEDIUM** — drift that has not diverged yet; dead code that misleads
- **LOW** — cosmetic, unreachable, stylistic

**Keep CERTAIN and WORTH A LOOK in separate sections. Never interleave them.**
If you are unsure, say so — a false finding wastes Tyler's attention, which is
the scarce resource. Under-reporting with honesty beats over-reporting with
confidence.

Put **doc staleness in its own section** so it does not dilute code findings.
Stale laws are worse than no laws because Tyler trusts them.

Write the full report to the session scratch directory. **Never inside the
repo.** Summarize the top findings in chat; do not paste the whole file.

---

## What NOT to report

- The ~200 inline copies of `phone.replace(/\D/g,'').slice(-10)` — Tyler ruled
  these noise on 2026-08-05. Identical one-liners that agree by construction.
- Known Drift Register entries, as new findings.
- Endpoints with no page — **endpoints outlive their pages.** `/admin/day-route`
  survived the deletion of `pure_cleaning_day_route.html` because
  `pure_cleaning_costs.html` still uses it. Check for other consumers before
  calling an endpoint dead.
- Style preferences. This audits against CLAUDE.md, not general taste.
