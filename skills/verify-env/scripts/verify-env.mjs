#!/usr/bin/env node
// Usage: verify-env.mjs [--json] [--profile <file>] [--host <name>]
// Profile: --profile, else .verify-env.json in the current directory, else the core checks only.
// A profile may hold "hosts": {"<name>": {...}}; the entry for --host (default: os.hostname()) is merged last.
// Exit: 0 all ok, 1 a check failed, 2 only warnings, 3 bad usage or unreadable profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CORE, exitCode, mergeProfile, realDeps, runChecks, table } from './lib.mjs';

function parseArgs(argv) {
  const a = { json: false, profile: null, host: os.hostname() };
  const value = (i) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--profile') a.profile = value(i++);
    else if (argv[i] === '--host') a.host = value(i++);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return a;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPortList = (v) => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
const SHAPE = { require: Array.isArray, optional: Array.isArray, ports: isPortList, versions: isObject, pathFirst: isObject };

function checkShape(p) {
  if (!isObject(p)) throw new Error('profile and each hosts entry must be JSON objects');
  for (const [key, ok] of Object.entries(SHAPE)) if (key in p && !ok(p[key])) throw new Error(`profile key "${key}" has the wrong type`);
  for (const key of ['versions', 'pathFirst'])
    for (const [name, v] of Object.entries(p[key] || {})) if (typeof v !== 'string') throw new Error(`profile ${key}.${name} must be a string`);
}

export function loadProfile(file, host) {
  if (!file) return CORE;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { hosts = {}, ...base } = raw;
  for (const p of [base, ...Object.values(hosts)]) checkShape(p);
  return mergeProfile(mergeProfile(CORE, base), hosts[host] || {});
}

async function main() {
  let args, profile;
  try {
    args = parseArgs(process.argv.slice(2));
    const local = path.resolve('.verify-env.json');
    profile = loadProfile(args.profile || (fs.existsSync(local) ? local : null), args.host);
  } catch (e) {
    console.error(`verify-env: ${e.message}`);
    process.exit(3);
  }
  const results = await runChecks(profile, realDeps());
  const code = exitCode(results);
  if (args.json) console.log(JSON.stringify({ exit: code, checks: results }, null, 2));
  else console.log(table(results));
  process.exit(code);
}

main();
