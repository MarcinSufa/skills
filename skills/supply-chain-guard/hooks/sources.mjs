// Target -> both versions unpacked from the registry: { oldVersion, newVersion, published, oldDir, newDir, isNew }.
// The installed version is only read for its number; both trees come from the registry so the layouts match.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const MAX_DOWNLOAD = 300 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export const registries = (env = process.env) => ({
  npm: (env.SCG_NPM_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/$/, ''),
  pypi: (env.SCG_PYPI_URL ?? 'https://pypi.org/pypi').replace(/\/$/, ''),
  vsx: (env.SCG_VSX_API ?? 'https://open-vsx.org/api').replace(/\/$/, ''),
});

async function get(url, as = 'json') {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: as === 'json' ? 'application/json' : '*/*' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  if (as === 'json') return res.json();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error(`${url} is larger than ${MAX_DOWNLOAD} bytes`);
  return buf;
}

function verify(buf, { sha512, sha256, sha1 }, url) {
  const checks = [
    ['sha512', sha512 && Buffer.from(sha512, 'base64').toString('hex')],
    ['sha256', sha256],
    ['sha1', sha1],
  ].filter(([, want]) => want);
  if (!checks.length) return;
  const [algo, want] = checks[0];
  const got = crypto.createHash(algo).update(buf).digest('hex');
  if (got !== want) throw new Error(`${algo} mismatch for ${url}`);
}

function unpack(buf, kind, workDir, label) {
  const archive = path.join(workDir, `${label}.${kind}`);
  const dir = path.join(workDir, label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(archive, buf);
  if (kind === 'tgz') {
    execFileSync('tar', ['-xzf', archive, '-C', dir, '--no-same-owner'], { stdio: 'ignore', timeout: 30_000 });
    const top = fs.readdirSync(dir);
    return top.length === 1 && fs.statSync(path.join(dir, top[0])).isDirectory() ? path.join(dir, top[0]) : dir;
  }
  extractZip(buf, dir);
  return dir;
}

// ponytail: no zip64 and no encryption. Both throw, which the guard turns into ask; add zip64 if a real package needs it.
export function extractZip(buf, dir) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error('not a zip archive');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || p === 0xffffffff) throw new Error('zip64 archives are not supported');
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const [method, flags] = [buf.readUInt16LE(p + 10), buf.readUInt16LE(p + 8)];
    const size = buf.readUInt32LE(p + 20);
    const [nameLen, extraLen, commentLen] = [buf.readUInt16LE(p + 28), buf.readUInt16LE(p + 30), buf.readUInt16LE(p + 32)];
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replaceAll('\\', '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`encrypted zip entry ${name}`);
    const target = path.resolve(dir, name);
    if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`zip entry escapes the archive: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (method === 0) fs.writeFileSync(target, data);
    else if (method === 8) fs.writeFileSync(target, zlib.inflateRawSync(data, { maxOutputLength: MAX_DOWNLOAD - total }));
    else throw new Error(`zip method ${method} not supported (${name})`);
    total += fs.statSync(target).size;
  }
}

const ageDays = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : null);

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// npm: dist-tag or exact version is read from the packument, a range is resolved by npm itself.
async function npm(target, { cwd, env, workDir }) {
  const reg = registries(env).npm;
  const doc = await get(`${reg}/${target.name.replace('/', '%2f')}`);
  if (!doc) throw new Error(`npm package ${target.name} not found in ${reg}`);
  const spec = target.spec ?? 'latest';
  let newVersion = doc['dist-tags']?.[spec] ?? (doc.versions?.[spec] ? spec : null);
  if (!newVersion) {
    const out = execFileSync('npm', ['view', `${target.name}@${spec}`, 'version', '--json', '--registry', reg], { encoding: 'utf8', timeout: FETCH_TIMEOUT_MS, cwd });
    newVersion = [JSON.parse(out)].flat().at(-1);
  }
  const oldVersion = readJsonFile(path.join(cwd, 'node_modules', target.name, 'package.json'))?.version ?? null;
  const fetchTree = async (version, label) => {
    const dist = doc.versions?.[version]?.dist;
    if (!dist?.tarball) throw new Error(`no tarball for ${target.name}@${version}`);
    const buf = await get(dist.tarball, 'buffer');
    verify(buf, { sha512: dist.integrity?.startsWith('sha512-') && dist.integrity.slice(7), sha1: dist.shasum }, dist.tarball);
    return unpack(buf, 'tgz', workDir, label);
  };
  return { oldVersion, newVersion, published: doc.time?.[newVersion] ?? null, digest: doc.versions?.[newVersion]?.dist?.integrity, fetchTree };
}

// PyPI: compare pure wheels when both versions have one (that is what pip installs), else sdists.
async function pypi(target, { cwd, env, workDir }) {
  const base = registries(env).pypi;
  const doc = await get(`${base}/${target.name}/json`);
  if (!doc) throw new Error(`PyPI project ${target.name} not found`);
  const newVersion = target.spec ?? doc.info.version;
  const python = [path.join(cwd, '.venv/bin/python'), env.VIRTUAL_ENV && path.join(env.VIRTUAL_ENV, 'bin/python')].find((p) => p && fs.existsSync(p)) ?? 'python3';
  let oldVersion = null;
  try {
    oldVersion = execFileSync(python, ['-I', '-c', 'import sys, importlib.metadata as m; print(m.version(sys.argv[1]))', target.name], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {}
  const files = (v) => doc.releases?.[v] ?? [];
  const pureWheel = (v) => files(v).find((f) => f.packagetype === 'bdist_wheel' && f.filename.endsWith('-none-any.whl'));
  const sdist = (v) => files(v).find((f) => f.packagetype === 'sdist');
  const wheels = pureWheel(newVersion) && (!oldVersion || pureWheel(oldVersion));
  const pick = (v) => (wheels ? pureWheel(v) : sdist(v)) ?? files(v)[0];
  const fetchTree = async (version, label) => {
    const file = pick(version);
    if (!file) throw new Error(`no downloadable file for ${target.name}==${version}`);
    const buf = await get(file.url, 'buffer');
    verify(buf, { sha256: file.digests?.sha256 }, file.url);
    return unpack(buf, file.filename.endsWith('.tar.gz') ? 'tgz' : 'zip', workDir, label);
  };
  return { oldVersion, newVersion, published: pick(newVersion)?.upload_time_iso_8601 ?? null, digest: pick(newVersion)?.digests?.sha256, fetchTree };
}

function installedExtensionVersion(id, env) {
  const home = env.HOME ?? os.homedir();
  const dirs = env.SCG_EXTENSION_DIRS?.split(path.delimiter) ?? ['.cursor/extensions', '.vscode/extensions', '.vscode-server/extensions', '.cursor-server/extensions'].map((d) => path.join(home, d));
  const versions = dirs.flatMap((d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  }).flatMap((entry) => {
    const m = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+\\.\\d+\\.\\d+)`, 'i').exec(entry);
    return m ? [m[1]] : [];
  });
  return versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? null;
}

// ponytail: universal Open VSX builds only. Platform-specific extensions (e.g. anthropic.claude-code linux-x64)
// need /{namespace}/{name}/{targetPlatform}/{version}; add SCG_VSX_PLATFORM when the universal 404s in practice.
async function vsx(target, { env, workDir }) {
  const api = registries(env).vsx;
  let id = target.name;
  let localTree = null;
  let digest = null;
  if (target.local) {
    const buf = fs.readFileSync(target.name);
    digest = crypto.createHash('sha256').update(buf).digest('hex');
    localTree = unpack(buf, 'zip', workDir, 'local');
    const manifest = readJsonFile(path.join(localTree, 'extension/package.json')) ?? {};
    id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  }
  const [ns, name] = id.split('.');
  const meta = (v) => get(`${api}/${ns}/${name}${v ? `/${v}` : ''}`);
  const latest = localTree ? null : await meta(target.spec);
  if (!localTree && !latest) throw new Error(`extension ${id} not found in ${api}`);
  const newVersion = localTree ? readJsonFile(path.join(localTree, 'extension/package.json'))?.version : latest.version;
  const oldVersion = installedExtensionVersion(id, env);
  const fetchTree = async (version, label) => {
    if (localTree && label === 'new') return localTree;
    const doc = version === latest?.version ? latest : await meta(version);
    if (!doc?.files?.download) throw new Error(`no download for ${id}@${version}`);
    const buf = await get(doc.files.download, 'buffer');
    if (doc.files.sha256) {
      const sum = await get(doc.files.sha256, 'buffer').catch(() => null);
      if (sum) verify(buf, { sha256: sum.toString('utf8').trim().split(/\s/)[0] }, doc.files.download);
    }
    if (label === 'new') digest = crypto.createHash('sha256').update(buf).digest('hex');
    return unpack(buf, 'zip', workDir, label);
  };
  return { id, oldVersion, newVersion, published: latest?.timestamp ?? null, get digest() { return digest; }, fetchTree };
}

const RESOLVERS = { npm, PyPI: pypi, vsx };

export async function fetchVersions(target, { cwd, env = process.env }) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-'));
  const cleanup = () => fs.rmSync(workDir, { recursive: true, force: true });
  try {
    const r = await RESOLVERS[target.ecosystem](target, { cwd, env, workDir });
    const sameVersion = !target.local && r.oldVersion === r.newVersion;
    const empty = path.join(workDir, 'empty');
    fs.mkdirSync(empty);
    const [oldDir, newDir] = sameVersion ? [null, null] : await Promise.all([r.oldVersion ? r.fetchTree(r.oldVersion, 'old') : empty, r.fetchTree(r.newVersion, 'new')]);
    return {
      name: r.id ?? target.name,
      oldVersion: r.oldVersion,
      newVersion: r.newVersion,
      published: r.published,
      ageDays: ageDays(r.published),
      isNew: !r.oldVersion,
      sameVersion,
      digest: r.digest ?? null,
      oldDir,
      newDir,
      cleanup,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}
