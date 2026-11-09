// verify-env checks. Read-only: no installs, no writes, no network; command output is never printed,
// only a short status line per check. Every OS access goes through `deps` so tests can fake it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const CORE = {
  require: ['node', 'git'],
  optional: ['npm', 'pnpm', 'gh', 'codex', 'claude'],
  versions: {},
  ghAuth: true,
  pathFirst: {},
  ports: [],
  minDiskMb: 1024,
  chromium: false,
};

// Profile keys replace the core value, except lists, which are merged (a tool in `require` leaves `optional`).
export function mergeProfile(core, profile = {}) {
  const out = { ...core, ...profile };
  out.require = [...new Set([...(core.require || []), ...(profile.require || [])])];
  out.optional = [...new Set([...(core.optional || []), ...(profile.optional || [])])].filter((t) => !out.require.includes(t));
  out.versions = { ...core.versions, ...profile.versions };
  out.pathFirst = { ...core.pathFirst, ...profile.pathFirst };
  return out;
}

// cmd /s drops the first and last quote of the line, so the whole line is quoted once more, as Node does for shell: true.
// Args are fixed literals (--version, auth status); nothing from a profile reaches this line.
export function cmdArgs(file, args) {
  return ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`];
}

export function realDeps({ timeoutMs = 10000 } = {}) {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    exists: (p) => fs.existsSync(p),
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    readdir: (p) => fs.readdirSync(p),
    freeMb: (p) => { const s = fs.statfsSync(p); return Math.floor((s.bavail * s.bsize) / 1048576); },
    run(file, args) {
      // .cmd/.bat shims on Windows need cmd.exe; everything else runs directly, never through a shell string.
      const win = process.platform === 'win32';
      const viaCmd = win && /\.(cmd|bat)$/i.test(file);
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const child = viaCmd
          ? spawn(process.env.ComSpec || 'cmd.exe', cmdArgs(file, args), { windowsVerbatimArguments: true, windowsHide: true })
          : spawn(file, args, { windowsHide: true, detached: !win });
        child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
        child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
        // A timeout ends the whole tree: a .cmd shim or wrapper script may have started the real tool as its child.
        const timer = setTimeout(() => {
          timedOut = true;
          if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          else try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
          resolve({ code: 127, stdout, stderr });
        }, timeoutMs);
        child.on('error', () => { clearTimeout(timer); resolve({ code: 127, stdout, stderr }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? 127 : code ?? 1, stdout, stderr }); });
      });
    },
    portInUse: (port) => new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? true : e.code || 'error'));
      srv.once('listening', () => srv.close(() => resolve(false)));
      srv.listen(port, '127.0.0.1');
    }),
  };
}

// Path rules follow d.platform, not the host, so a fake win32 or linux host behaves the same on any OS.
const pathFor = (d) => (d.platform === 'win32' ? path.win32 : path.posix);
const expandHome = (p, d) => (p.startsWith('~') ? pathFor(d).join(d.home, p.slice(1)) : p);
const pathKey = (env) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// First match of `name` on PATH, like `command -v`; PATHEXT on Windows.
export function which(name, d) {
  const sep = d.platform === 'win32' ? ';' : ':';
  const P = pathFor(d);
  const exts = d.platform === 'win32' ? (d.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of (d.env[pathKey(d.env)] || '').split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const p = P.join(dir, name + ext.toLowerCase());
      if (d.exists(p)) return p;
      if (ext && d.exists(P.join(dir, name + ext))) return P.join(dir, name + ext);
    }
  }
  return null;
}

export function parseVersion(text) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text || '');
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

// ">=20", ">=9.1": the only operator a profile needs.
export function satisfies(v, spec) {
  const want = parseVersion(spec);
  if (!v || !want) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== want[i]) return v[i] > want[i];
  return true;
}

const shortHome = (p, d) => (p && d.home && p.startsWith(d.home) ? '~' + p.slice(d.home.length) : p);

async function checkTool(name, required, profile, d) {
  const id = `tool:${name}`;
  const bad = required ? 'fail' : 'warn';
  const where = which(name, d);
  if (!where) return { id, status: bad, detail: `${name} not on PATH` };
  const r = await d.run(where, ['--version']);
  const v = parseVersion(r.stdout + r.stderr);
  if (r.code !== 0) return { id, status: bad, detail: `${name} --version exit ${r.code} (${shortHome(where, d)})` };
  const spec = profile.versions[name];
  const shown = v ? v.join('.') : '?';
  if (spec && !satisfies(v, spec)) return { id, status: bad, detail: `${name} ${shown}, needs ${spec}` };
  return { id, status: 'ok', detail: `${name} ${shown} (${shortHome(where, d)})` };
}

async function checkGhAuth(d) {
  const gh = which('gh', d);
  if (!gh) return { id: 'gh-auth', status: 'warn', detail: 'gh not on PATH, auth not checked' };
  // Exit code only: the output names the account and token scopes.
  const r = await d.run(gh, ['auth', 'status']);
  return r.code === 0
    ? { id: 'gh-auth', status: 'ok', detail: 'gh auth status: logged in' }
    : { id: 'gh-auth', status: 'fail', detail: `gh auth status exit ${r.code} (run gh auth login)` };
}

// pathFirst: {"gh": "~/.claude/home/bin"} means `gh` must resolve to that directory (a shim ahead of the real tool).
function checkPathFirst(name, dir, d) {
  const P = pathFor(d);
  const want = P.resolve(expandHome(dir, d));
  const got = which(name, d);
  const id = `path:${name}`;
  const fold = (p) => (d.platform === 'win32' ? p.toLowerCase() : p);
  if (got && fold(P.dirname(got)) === fold(want)) return { id, status: 'ok', detail: `${name} -> ${shortHome(want, d)}` };
  return { id, status: 'warn', detail: `${name} resolves to ${got ? shortHome(got, d) : 'nothing'}, expected ${shortHome(want, d)} first on PATH` };
}

function checkDisk(minMb, d) {
  try {
    const free = d.freeMb(d.home);
    return { id: 'disk', status: free >= minMb ? 'ok' : 'fail', detail: `${free} MB free in ~ (min ${minMb})` };
  } catch (e) {
    return { id: 'disk', status: 'warn', detail: `free space unknown (${e.code || e.message})` };
  }
}

async function checkPort(port, d) {
  const id = `port:${port}`;
  const used = await d.portInUse(port);
  if (used === false) return { id, status: 'ok', detail: `port ${port} free` };
  return { id, status: 'warn', detail: used === true ? `port ${port} already in use` : `port ${port} not checked (${used})` };
}

function playwrightDir(d) {
  const P = pathFor(d);
  if (d.env.PLAYWRIGHT_BROWSERS_PATH) return d.env.PLAYWRIGHT_BROWSERS_PATH;
  if (d.platform === 'win32') return P.join(d.env.LOCALAPPDATA || P.join(d.home, 'AppData', 'Local'), 'ms-playwright');
  if (d.platform === 'darwin') return P.join(d.home, 'Library', 'Caches', 'ms-playwright');
  return P.join(d.home, '.cache', 'ms-playwright');
}

function checkChromium(d) {
  const out = [];
  if (d.env.PLAYWRIGHT_BROWSERS_PATH === '0') return [{ id: 'chromium', status: 'warn', detail: 'PLAYWRIGHT_BROWSERS_PATH=0: browsers live in the project node_modules, not checked' }];
  const dir = playwrightDir(d);
  let builds = [];
  try { builds = d.readdir(dir).filter((n) => /^chromium/.test(n)); } catch (e) {
    if (e.code !== 'ENOENT') return [{ id: 'chromium', status: 'warn', detail: `${shortHome(dir, d)} unreadable (${e.code || e.message})` }];
  }
  out.push(builds.length
    ? { id: 'chromium', status: 'ok', detail: `${builds.length} Playwright chromium build(s) in ${shortHome(dir, d)}` }
    : { id: 'chromium', status: 'fail', detail: `no Playwright chromium in ${shortHome(dir, d)}` });
  if (d.platform === 'linux') {
    let v = null;
    try { v = d.readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').trim(); } catch (e) { if (e.code !== 'ENOENT') v = `unreadable (${e.code || e.message})`; }
    if (v?.startsWith('unreadable')) out.push({ id: 'chromium-sandbox', status: 'warn', detail: `apparmor_restrict_unprivileged_userns ${v}` });
    else if (v === '1') out.push({ id: 'chromium-sandbox', status: 'warn', detail: 'unprivileged userns restricted by AppArmor: Chromium sandbox fails, runs need --no-sandbox' });
    else out.push({ id: 'chromium-sandbox', status: 'ok', detail: v === null ? 'no AppArmor userns restriction' : `apparmor_restrict_unprivileged_userns=${v}` });
  }
  return out;
}

export async function runChecks(profile, d) {
  const results = [];
  for (const t of profile.require) results.push(await checkTool(t, true, profile, d));
  for (const t of profile.optional) results.push(await checkTool(t, false, profile, d));
  if (profile.ghAuth) results.push(await checkGhAuth(d));
  for (const [name, dir] of Object.entries(profile.pathFirst)) results.push(checkPathFirst(name, dir, d));
  if (profile.minDiskMb) results.push(checkDisk(profile.minDiskMb, d));
  for (const p of profile.ports) results.push(await checkPort(p, d));
  if (profile.chromium) results.push(...checkChromium(d));
  return results;
}

export function exitCode(results) {
  if (results.some((r) => r.status === 'fail')) return 1;
  if (results.some((r) => r.status === 'warn')) return 2;
  return 0;
}

export function table(results) {
  const w = Math.max(...results.map((r) => r.id.length), 2);
  return results.map((r) => `${r.status.toUpperCase().padEnd(4)}  ${r.id.padEnd(w)}  ${r.detail}`).join('\n');
}
