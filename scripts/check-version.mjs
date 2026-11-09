import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.argv[2];
if (!base) throw new Error('usage: node scripts/check-version.mjs <base-ref>');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const semver = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a x.y.z version: ${v}`);
  return m.slice(1).map(Number);
};
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

const head = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8')).version;
const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
if (market.plugins.some((p) => 'version' in p)) throw new Error('keep the version in plugin.json only');
semver(head);

const changed = git('diff', '--name-only', `${base}...HEAD`, '--', 'skills/').trim();
if (!changed) process.exit(0);
let before;
try {
  before = JSON.parse(git('show', `${base}:.claude-plugin/plugin.json`)).version;
} catch {
  process.exit(0);
}
if (!newer(semver(head), semver(before))) {
  console.error(`skills/ changed but the plugin version stayed ${before}; raise it in .claude-plugin/plugin.json`);
  process.exit(1);
}
