// import-csv.js — CSV → Cloudflare KV customer import
import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import readline from 'readline';

const CSV_FILES = [
  '/Users/tylerfumero/Desktop/2024_Master_Full_clean.csv',
  "/Users/tylerfumero/Desktop/2025_Master_Full 3.csv",
  '/Users/tylerfumero/Desktop/2026_Master_Full.csv',
];

const WORKER_URL = 'https://purecleaning-api.tylerfumero.workers.dev/customers';
const BACKUP_DIR = `./backups/${new Date().toISOString().split('T')[0]}`;

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? digits : null;
}

function splitName(fullName) {
  if (!fullName) return { firstName: '', lastName: '' };
  const trimmed = fullName.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function parseTotal(raw) {
  if (!raw) return 0;
  const cleaned = String(raw).replace(/[$,]/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function toTitleCase(str) {
  if (!str) return '';
  return str.trim().replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function parseDate(raw) {
  if (!raw) return null;
  // Handle M/D/YY and M/D/YYYY
  const parts = String(raw).trim().split('/');
  if (parts.length === 3) {
    let [m, d, y] = parts;
    if (y.length === 2) y = '20' + y;
    const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (!isNaN(new Date(iso).getTime())) return iso;
  }
  const date = new Date(raw);
  if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
  return null;
}

function generateId() {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
}

async function readCSV(filepath) {
  const content = await fs.readFile(filepath, 'utf-8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main() {
  console.log('Reading CSVs...\n');

  let allRows = [];
  for (const file of CSV_FILES) {
    try {
      const rows = await readCSV(file);
      console.log(`  ${path.basename(file)}: ${rows.length} rows`);
      allRows = allRows.concat(rows);
    } catch (err) {
      console.error(`  ERROR reading ${file}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`\nTotal raw rows: ${allRows.length}`);

  // ── Deduplicate by phone ──────────────────────────────────────────────────
  const customersByPhone = new Map();
  const noPhoneRows = [];
  let earliestDate = null;
  let latestDate = null;

  for (const row of allRows) {
    const phone = normalizePhone(row['Phone']);
    const date  = parseDate(row['Date']);
    const total = parseTotal(row['Total']);

    if (date) {
      if (!earliestDate || date < earliestDate) earliestDate = date;
      if (!latestDate   || date > latestDate)   latestDate   = date;
    }

    if (!phone) {
      noPhoneRows.push(row);
      continue;
    }

    if (!customersByPhone.has(phone)) {
      const { firstName, lastName } = splitName(row['Customer']);
      customersByPhone.set(phone, {
        id: generateId(),
        firstName,
        lastName,
        phone,
        address: (row['Address'] || '').trim(),
        city: toTitleCase(row['City']),
        lastService: date,
        totalJobs: 0,
        lifetimeSpend: 0,
        jobHistory: [],
        source: 'csv_import',
        importedAt: new Date().toISOString(),
      });
    }

    const customer = customersByPhone.get(phone);

    customer.totalJobs    += 1;
    customer.lifetimeSpend += total;
    customer.jobHistory.push({
      date,
      total,
      services: (row['Services'] || '').trim(),
      address:  (row['Address']  || '').trim(),
      sqft:     row['Sq Ft'] ? parseFloat(row['Sq Ft']) || null : null,
      payment:  (row['Payment']  || '').trim(),
    });

    // Most recent service date
    if (date && (!customer.lastService || date > customer.lastService)) {
      customer.lastService = date;
    }

    // Most recent address (use address from the latest job)
    if (date && customer.lastService === date && (row['Address'] || '').trim()) {
      customer.address = (row['Address'] || '').trim();
      customer.city    = toTitleCase(row['City']);
    }

    // Prefer longest non-empty name
    const newName = splitName(row['Customer']);
    const currentFull  = `${customer.firstName} ${customer.lastName}`.trim();
    const proposedFull = `${newName.firstName} ${newName.lastName}`.trim();
    if (proposedFull.length > currentFull.length) {
      customer.firstName = newName.firstName;
      customer.lastName  = newName.lastName;
    }
  }

  const customers = Array.from(customersByPhone.values());

  // ── Stats ─────────────────────────────────────────────────────────────────
  const totalRevenue  = customers.reduce((s, c) => s + c.lifetimeSpend, 0);
  const avgSpend      = totalRevenue / customers.length;
  const repeatCustomers = customers.filter(c => c.totalJobs >= 2).length;

  const cityBreakdown = {};
  customers.forEach(c => {
    const city = c.city || 'Unknown';
    cityBreakdown[city] = (cityBreakdown[city] || 0) + 1;
  });
  const topCities = Object.entries(cityBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const jobDistribution = { 1: 0, 2: 0, '3-5': 0, '6-10': 0, '11+': 0 };
  customers.forEach(c => {
    if      (c.totalJobs === 1)  jobDistribution[1]++;
    else if (c.totalJobs === 2)  jobDistribution[2]++;
    else if (c.totalJobs <= 5)   jobDistribution['3-5']++;
    else if (c.totalJobs <= 10)  jobDistribution['6-10']++;
    else                         jobDistribution['11+']++;
  });

  console.log('\n══════════════════════════════════════');
  console.log('          IMPORT PREVIEW');
  console.log('══════════════════════════════════════');
  console.log(`Raw rows read:            ${allRows.length}`);
  console.log(`Unique customers (phone): ${customers.length}`);
  console.log(`Rows with no/bad phone:   ${noPhoneRows.length}`);
  console.log(`Repeat customers (2+ jobs): ${repeatCustomers}`);
  console.log(`Total revenue:            $${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`Avg lifetime spend:       $${Math.round(avgSpend).toLocaleString()}`);
  console.log(`Date range:               ${earliestDate} → ${latestDate}`);
  console.log('\nJob count distribution:');
  Object.entries(jobDistribution).forEach(([k, v]) => console.log(`  ${k} job(s): ${v} customers`));
  console.log('\nTop 10 cities:');
  topCities.forEach(([city, count]) => console.log(`  ${city}: ${count}`));

  if (noPhoneRows.length > 0) {
    console.log(`\nRows flagged (no valid phone):`);
    noPhoneRows.slice(0, 10).forEach(r => console.log(`  ${r['Customer']} | ${r['Phone']} | ${r['Date']}`));
    if (noPhoneRows.length > 10) console.log(`  ...and ${noPhoneRows.length - 10} more`);
  }

  console.log('\n══════════════════════════════════════');

  // ── Approval prompt ───────────────────────────────────────────────────────
  const answer = await ask('\nType YES to write to Cloudflare KV, or NO to abort: ');

  if (answer.trim().toUpperCase() !== 'YES') {
    console.log('\nAborted. No data written.');
    return;
  }

  // ── Backup first ──────────────────────────────────────────────────────────
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const backupPath = path.join(BACKUP_DIR, 'customers_imported.json');
  await fs.writeFile(backupPath, JSON.stringify({ customers }, null, 2));
  console.log(`\nBackup saved: ${path.resolve(backupPath)}`);

  if (noPhoneRows.length > 0) {
    const noPhonePath = path.join(BACKUP_DIR, 'no_phone_rows.json');
    await fs.writeFile(noPhonePath, JSON.stringify(noPhoneRows, null, 2));
    console.log(`No-phone rows: ${path.resolve(noPhonePath)}`);
  }

  // ── Write to Cloudflare KV ────────────────────────────────────────────────
  console.log(`\nWriting ${customers.length} customers to Cloudflare KV...`);
  const putRes = await fetch(WORKER_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customers }),
  });

  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`Worker PUT failed: ${putRes.status} — ${body}`);
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log('Verifying...');
  const verifyRes  = await fetch(WORKER_URL);
  const verifyData = await verifyRes.json();
  const verified   = verifyData.customers?.length ?? 0;

  if (verified === customers.length) {
    console.log(`\nSUCCESS: ${verified} customers confirmed in Cloudflare KV`);
  } else {
    console.log(`\nCOUNT MISMATCH: wrote ${customers.length}, verified ${verified}`);
    process.exit(1);
  }

  console.log('\n══════════════════════════════════════');
  console.log('          IMPORT COMPLETE');
  console.log('══════════════════════════════════════');
  console.log(`Customers in KV:  ${verified}`);
  console.log(`Backup:           ${path.resolve(backupPath)}`);
  console.log(`No-phone rows:    ${noPhoneRows.length} (saved to backup dir)`);
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
