#!/usr/bin/env node
/**
 * Pre-commit secret scanner.
 *
 * Scans git-staged files for patterns that look like real secrets.
 * Blocks commit if anything matches (unless SKIP_SECRET_SCAN=1).
 *
 * Run manually:  node scripts/secret-scan.js
 * Skip (false +): SKIP_SECRET_SCAN=1 git commit
 */

const { execSync } = require('child_process');
const fs  = require('fs');
const path = require('path');

if (process.env.SKIP_SECRET_SCAN === '1') {
  console.log('⚠️   Secret scan skipped (SKIP_SECRET_SCAN=1)');
  process.exit(0);
}

// ── Patterns that indicate real secrets ──────────────────────────────────
const PATTERNS = [
  { name: 'Bearer token',        re: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/g },
  { name: 'API key assignment',  re: /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi },
  { name: 'Generic token',       re: /\btoken\s*[:=]\s*['"][A-Za-z0-9_\-\.]{30,}['"]/gi },
  { name: 'AWS access key',      re: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub PAT (ghp_)',   re: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'GitHub OAuth (gho_)', re: /gho_[A-Za-z0-9]{36}/g },
  { name: 'Google API key',      re: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: 'Slack token',         re: /xox[baprs]-[A-Za-z0-9]+-[A-Za-z0-9-]+/g },
  { name: 'Stripe live secret',  re: /sk_live_[0-9a-zA-Z]{24,}/g },
  { name: 'Stripe live public',  re: /pk_live_[0-9a-zA-Z]{24,}/g },
  { name: 'Generic password',    re: /\bpassword\s*[:=]\s*['"][^'"]{8,}['"]/gi },
  { name: 'Hardcoded secret',    re: /\bsecret\s*[:=]\s*['"][A-Za-z0-9_\-\.\/\+]{16,}['"]/gi },
  // Bouncie-specific
  { name: 'Bouncie client secret', re: /pure-cleaning-crm[^'"]*secret/gi },
];

// ── Allow-list: matches that are never secrets ────────────────────────────
const ALLOW_PATTERNS = [
  /YOUR_[A-Z_]+_HERE/,
  /REPLACE_ME/i,
  /XXXX+/,
  /\bexample\b/i,
  /\bplaceholder\b/i,
  /\bfake\b/i,
  /\btest\b/i,
  /\bdummy\b/i,
  /\bsample\b/i,
  /\benv\.[A-Z_]+/,          // env.SOME_VAR reference (not the value)
  /process\.env\./,
  /wrangler secret/i,
  /<your[_\s]/i,
];

// ── Files to always skip ──────────────────────────────────────────────────
const SKIP_FILES = [
  '.env.example',
  'package-lock.json',
  'scripts/secret-scan.js', // the scanner itself contains the patterns
];

// ── Extensions to skip (binary, generated) ───────────────────────────────
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.pdf', '.zip', '.tar', '.gz',
  '.map',
]);

function isAllowed(match) {
  return ALLOW_PATTERNS.some(p => p.test(match));
}

function getStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function scanFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return [];

  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return [];

  const base = path.basename(filePath);
  if (SKIP_FILES.includes(base) || SKIP_FILES.includes(filePath)) return [];

  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }

  const hits = [];
  const lines = content.split('\n');

  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment-only lines
      if (/^\s*(\/\/|#|\/\*)/.test(line)) continue;

      let match;
      const lineRe = new RegExp(re.source, re.flags);
      while ((match = lineRe.exec(line)) !== null) {
        if (!isAllowed(match[0])) {
          // Redact the match for display (show first 6 + ***)
          const preview = match[0].length > 12
            ? match[0].slice(0, 6) + '***[REDACTED]'
            : '***[REDACTED]';
          hits.push({ file: filePath, line: i + 1, pattern: name, preview });
        }
      }
    }
  }

  return hits;
}

// ── Main ──────────────────────────────────────────────────────────────────
const stagedFiles = getStagedFiles();

if (stagedFiles.length === 0) {
  // Not running as a hook with staged files — scan all tracked JS/HTML files
  console.log('ℹ️   No staged files found. Pass file paths as arguments or stage files first.');
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (args.length) {
    const hits = args.flatMap(scanFile);
    if (hits.length) {
      console.log('\n🚨  Secrets detected:');
      for (const h of hits) console.log(`  ${h.file}:${h.line}  [${h.pattern}]  ${h.preview}`);
      process.exit(1);
    } else {
      console.log('✅  No secrets detected in provided files.');
    }
  }
  process.exit(0);
}

console.log(`\n🔍  Secret scan — checking ${stagedFiles.length} staged file(s)…`);

const allHits = stagedFiles.flatMap(scanFile);

if (allHits.length === 0) {
  console.log('✅  No secrets detected.\n');
  process.exit(0);
}

console.log('\n🚨  COMMIT BLOCKED — possible secrets detected:\n');
for (const { file, line, pattern, preview } of allHits) {
  console.log(`  ${file}:${line}  [${pattern}]`);
  console.log(`    → ${preview}\n`);
}
console.log('Fix the above before committing.');
console.log('If this is a false positive: SKIP_SECRET_SCAN=1 git commit\n');
process.exit(1);
