/**
 * auto-auth.js — shared token helper for verify-deploy.js and verify-browser.js
 *
 * Resolution order:
 *   1. VERIFY_TOKEN env var  — raw session token (CI / manual override)
 *   2. ADMIN_PASSWORD env var — password → exchange for session token
 *   3. .env.local file       — reads ADMIN_PASSWORD line → exchange for token
 *
 * Returns a valid Bearer session token, or null if no credentials are configured
 * (graceful skip). Throws an Error if credentials ARE configured but auth fails
 * (so a wrong password is a hard deploy failure, not a silent skip).
 *
 * Usage:
 *   const { getVerifyToken } = require('./lib/auto-auth');
 *   const token = await getVerifyToken();   // null → skip checks; string → use as Bearer
 */

const fs   = require('fs');
const path = require('path');

const API        = 'https://purecleaning-api.tylerfumero.workers.dev';
const PAGES_BASE = 'https://purecleaningpressurecleaning.com';
const ENV_FILE   = path.join(__dirname, '../../.env.local');

function readEnvLocal() {
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*ADMIN_PASSWORD\s*=\s*(.+)/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* .env.local doesn't exist — that's OK */
  }
  return null;
}

async function exchangePassword(password) {
  const res = await fetch(`${API}/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Origin: PAGES_BASE },
    body:    JSON.stringify({ password }),
  });
  if (res.status === 429) throw new Error('auth/login rate-limited — too many attempts. Wait 1 minute.');
  if (res.status === 401) throw new Error('ADMIN_PASSWORD is incorrect — check .env.local');
  if (!res.ok)            throw new Error(`auth/login returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data.token) throw new Error('auth/login response missing token field');
  return data; // { token, expiresAt }
}

async function getVerifyToken() {
  // 1. Explicit raw session token — highest priority (CI environments)
  if (process.env.VERIFY_TOKEN) return { token: process.env.VERIFY_TOKEN, expiresAt: Date.now() + 86400000 };

  // 2. ADMIN_PASSWORD env var
  const pwFromEnv = process.env.ADMIN_PASSWORD;
  if (pwFromEnv) return exchangePassword(pwFromEnv);

  // 3. .env.local file
  const pwFromFile = readEnvLocal();
  if (pwFromFile) return exchangePassword(pwFromFile);

  // No credentials configured → caller should skip and warn
  return null;
}

module.exports = { getVerifyToken };
