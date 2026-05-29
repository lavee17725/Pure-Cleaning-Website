#!/usr/bin/env node
// Runs tsc and filters node_modules noise (transitive imports bypass jsconfig exclude).
// Indented continuation lines following a node_modules error are also dropped.
// Exits 1 if any project-source errors remain; 0 otherwise.
const { execSync } = require('child_process');
let output = '';
try {
  execSync('npx tsc -p jsconfig.json', { stdio: 'pipe' });
} catch (e) {
  output = (e.stdout || e.stderr || '').toString();
}
const lines = output.split('\n');
const filtered = [];
let skipIndented = false;
for (const line of lines) {
  if (!line.trim()) continue;
  if (line.includes('node_modules')) { skipIndented = true; continue; }
  if (skipIndented && /^\s/.test(line)) continue; // continuation of a node_modules error
  skipIndented = false;
  filtered.push(line);
}
if (filtered.length) { console.error(filtered.join('\n')); process.exit(1); }
process.exit(0);
