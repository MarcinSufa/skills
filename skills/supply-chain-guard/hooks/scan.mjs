// Two unpacked package trees -> red-flag signals + a size-bounded unified diff for the reviewer.
// A pattern signals only when the new version has more matches than the old one, so long-standing
// eval in a minified bundle stays quiet while a newly added one does not.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const SEVERITY = ['info', 'medium', 'high', 'critical'];
const PRIVATE_IP = /^(127\.|0\.|10\.|192\.168\.|169\.254\.|255\.)/;

const RULES = [
  { id: 'ssh-keys', severity: 'critical', re: /authorized_keys|\.ssh[/\\'"]|id_(?:rsa|ed25519|ecdsa)\b/g },
  { id: 'reverse-tunnel', severity: 'critical', re: /\bssh\b[^\n]{0,80}\s-[A-Za-z]*R\s*\d|\/dev\/tcp\/|\bnc\s+(?:-\w+\s+)*-e\b|\bngrok\b/g },
  {
    id: 'persistence',
    severity: 'high',
    re: /crontab|\/etc\/cron|\.bashrc|\.zshrc|\.bash_profile|\.zprofile|LaunchAgents|LaunchDaemons|systemd\/user|\.config\/autostart|CurrentVersion\\{1,2}Run|schtasks|Startup\\{1,2}|HKCU\\{1,2}Software/g,
  },
  {
    id: 'credential-access',
    severity: 'high',
    re: /\.npmrc|\.pypirc|\.aws\/credentials|\.git-credentials|\.docker\/config\.json|\.kube\/config|\.config\/gh\/hosts|NPM_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY/g,
  },
  { id: 'dynamic-code', severity: 'high', re: /\beval\s*\(|new\s+Function\s*\(|\bvm\.runIn\w+|\bexec\s*\(\s*(?:compile|base64|zlib|marshal|codecs|bytes)|marshal\.loads|__import__\s*\(\s*['"]base64/g },
  {
    id: 'obfuscation',
    severity: 'high',
    re: /(?<![A-Za-z0-9+/,])[A-Za-z0-9+/]{300,}={0,2}|(?:\\x[0-9a-fA-F]{2}){24,}|(?:\\u[0-9a-fA-F]{4}){16,}|String\.fromCharCode\((?:\s*\d+\s*,){12,}|\batob\s*\(|Buffer\.from\([^)]{0,200}['"]base64['"]|b64decode\s*\(/g,
  },
  { id: 'process-exec', severity: 'medium', re: /child_process|\bexecSync\b|\bspawnSync\b|\bexecFile\b|subprocess\.|os\.system\s*\(|os\.popen\s*\(|\bPopen\s*\(/g },
  { id: 'raw-socket', severity: 'medium', re: /\bnet\.connect\b|\bnet\.Socket\b|\btls\.connect\b|\bdgram\b|socket\.socket\s*\(|new\s+WebSocket\s*\(/g },
];
const IP_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g;
const URL_RE = /\b(?:https?|wss?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepublish'];
const MAX_TEXT = 4_000_000;
const CODE_EXT = /\.([cm]?[jt]sx?|py[w]?|pth|sh|json|ps1|bat|cmd|vbs|rb|pl|php)$/i;

function walk(root) {
  const files = new Map();
  if (!root) return files;
  const visit = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (ent.isDirectory()) visit(abs);
      else if (ent.isSymbolicLink()) files.set(rel, { abs, size: 0, symlink: fs.readlinkSync(abs) });
      else if (ent.isFile()) files.set(rel, { abs, size: fs.statSync(abs).size });
    }
  };
  visit(root);
  return files;
}

function readText(entry) {
  if (!entry || entry.symlink || entry.size > MAX_TEXT) return null;
  const buf = fs.readFileSync(entry.abs);
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

const count = (text, re) => (text ? (text.match(re) ?? []).length : 0);

function snippet(text, re) {
  re.lastIndex = 0;
  const m = re.exec(text);
  re.lastIndex = 0;
  if (!m) return '';
  return text.slice(Math.max(0, m.index - 80), m.index + Math.min(m[0].length, 120) + 80).replace(/\s+/g, ' ').trim();
}

function hosts(text) {
  const out = new Set();
  for (const m of text?.matchAll(URL_RE) ?? []) out.add(m[1].toLowerCase());
  for (const m of text?.matchAll(IP_RE) ?? []) if (!PRIVATE_IP.test(m[0])) out.add(m[0]);
  return out;
}

function readJson(entry) {
  try {
    return JSON.parse(readText(entry) ?? 'null');
  } catch {
    return null;
  }
}

function entryFiles(files, ecosystem) {
  const entries = new Set();
  for (const [rel, entry] of files) {
    const base = rel.split('/').at(-1);
    if (ecosystem === 'PyPI' && (base === '__init__.py' || base.endsWith('.pth'))) entries.add(rel);
    if (base !== 'package.json' || rel.split('/').length > 2) continue;
    const pkg = readJson(entry);
    const dir = path.posix.dirname(rel) === '.' ? '' : `${path.posix.dirname(rel)}/`;
    for (const m of [pkg?.main ?? 'index.js', pkg?.module, pkg?.browser].filter((x) => typeof x === 'string')) {
      const norm = path.posix.normalize(dir + m.replace(/^\.\//, ''));
      for (const cand of [norm, `${norm}.js`, `${norm}/index.js`]) if (files.has(cand)) entries.add(cand);
    }
  }
  return entries;
}

function manifestSignals(oldFiles, newFiles, signals) {
  for (const [rel, entry] of newFiles) {
    if (rel.split('/').at(-1) !== 'package.json' || rel.split('/').length > 2) continue;
    const now = readJson(entry) ?? {};
    const before = readJson(oldFiles.get(rel)) ?? {};
    for (const key of LIFECYCLE) {
      const cmd = now.scripts?.[key];
      if (cmd && cmd !== before.scripts?.[key]) {
        signals.push({ id: 'install-script', severity: 'high', file: rel, evidence: `"${key}": ${JSON.stringify(cmd).slice(0, 200)}` });
      }
    }
    const eager = (pkg) => (pkg.activationEvents ?? []).filter((e) => e === '*' || e === 'onStartupFinished');
    const newlyEager = eager(now).filter((e) => !eager(before).includes(e));
    if (newlyEager.length) signals.push({ id: 'eager-activation', severity: 'medium', file: rel, evidence: `activationEvents: ${newlyEager.join(', ')}` });
    if (before.main && now.main && before.main !== now.main) signals.push({ id: 'entry-changed', severity: 'medium', file: rel, evidence: `main: ${before.main} -> ${now.main}` });
  }
}

function commonDir(x, y) {
  const a = x.split(path.sep);
  const b = y.split(path.sep);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(0, i).join(path.sep) || path.sep;
}

function unifiedDiff(oldDir, newDir) {
  const base = commonDir(oldDir, newDir);
  const [a, b] = [oldDir, newDir].map((d) => path.relative(base, d).split(path.sep).join('/'));
  const args = ['-c', 'core.quotepath=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--no-prefix', '-U3', a, b];
  let raw;
  try {
    raw = execFileSync('git', args, { cwd: base, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30_000 });
  } catch (err) {
    if (err.status !== 1) throw err;
    raw = err.stdout;
  }
  return { raw, a: `${a}/`, b: `${b}/` };
}

function budgetDiff({ raw, a, b }, priority, budget) {
  const chunks = raw.split(/^(?=diff --git )/m).filter(Boolean).map((chunk) => {
    const file = chunk.split('\n', 1)[0].split(' ').at(-1).replace(b, '').replace(a, '');
    const body = chunk
      .split('\n')
      .map((l) => (l.length > 400 ? `${l.slice(0, 400)} ...[line cut, ${l.length} chars]` : l).replaceAll(a, 'a/').replaceAll(b, 'b/'))
      .join('\n');
    return { file, body };
  });
  chunks.sort((x, y) => (priority.has(y.file) ? 1 : 0) - (priority.has(x.file) ? 1 : 0));
  let out = '';
  const omitted = [];
  for (const c of chunks) {
    if (out.length + c.body.length <= budget) out += c.body;
    else if (out.length < budget && priority.has(c.file)) out += `${c.body.slice(0, budget - out.length)}\n...[chunk cut]\n`;
    else omitted.push(c.file);
  }
  return { text: out, omitted };
}

export function scan({ oldDir, newDir, ecosystem, isNew, budget = 60_000 }) {
  const oldFiles = walk(oldDir);
  const newFiles = walk(newDir);
  const signals = [];
  const entries = entryFiles(newFiles, ecosystem);
  const changed = [...newFiles.keys()].filter((rel) => {
    const o = oldFiles.get(rel);
    const n = newFiles.get(rel);
    if (o?.symlink || n.symlink) return o?.symlink !== n.symlink;
    return !o || o.size !== n.size || !fs.readFileSync(o.abs).equals(fs.readFileSync(n.abs));
  });
  const removed = [...oldFiles.keys()].filter((rel) => !newFiles.has(rel));

  manifestSignals(oldFiles, newFiles, signals);
  const oldHosts = new Set();
  for (const entry of oldFiles.values()) for (const h of hosts(readText(entry))) oldHosts.add(h);
  const newHosts = new Map();

  for (const rel of changed) {
    const entry = newFiles.get(rel);
    if (entry.symlink) {
      signals.push({ id: 'symlink', severity: 'medium', file: rel, evidence: `-> ${entry.symlink}` });
      continue;
    }
    const text = readText(entry);
    if (text === null) {
      if (CODE_EXT.test(rel)) signals.push({ id: 'unscannable', severity: 'high', file: rel, evidence: `${entry.size} bytes of code that is binary or over ${MAX_TEXT} bytes` });
      else signals.push({ id: 'binary-added', severity: 'medium', file: rel, evidence: `${entry.size} bytes` });
      continue;
    }
    if (ecosystem === 'PyPI' && rel.endsWith('.pth') && /^\s*import\s/m.test(text)) {
      signals.push({ id: 'pth-startup-hook', severity: 'high', file: rel, evidence: snippet(text, /^\s*import\s.*$/gm) });
    }
    if (ecosystem === 'PyPI' && /(^|\/)setup\.py$/.test(rel)) signals.push({ id: 'build-script', severity: 'medium', file: rel, evidence: 'setup.py changed' });
    const oldText = readText(oldFiles.get(rel));
    const atLoad = entries.has(rel);
    for (const rule of RULES) {
      const before = count(oldText, rule.re);
      if (count(text, rule.re) <= before) continue;
      // An entry file gaining a capability it never had runs it on every load; one more call in a bundle that already had it is routine.
      const gained = atLoad && before === 0;
      const severity = gained && rule.severity === 'medium' ? 'high' : rule.severity;
      signals.push({ id: rule.id, severity, file: rel, evidence: snippet(text, rule.re), ...(gained && { loadTime: true }) });
    }
    for (const h of hosts(text)) if (!oldHosts.has(h) && !newHosts.has(h)) newHosts.set(h, rel);
  }
  for (const [host, file] of newHosts) {
    const isIp = /^\d/.test(host);
    signals.push({ id: isIp ? 'ip-literal' : 'new-endpoint', severity: isNew ? 'info' : isIp ? 'high' : 'medium', file, evidence: host });
  }

  const sizeOld = [...oldFiles.values()].reduce((s, f) => s + f.size, 0);
  const sizeNew = [...newFiles.values()].reduce((s, f) => s + f.size, 0);
  if (!isNew && sizeNew > sizeOld * 1.5 && sizeNew - sizeOld > 200_000) {
    signals.push({ id: 'size-jump', severity: 'medium', file: '', evidence: `${sizeOld} -> ${sizeNew} bytes` });
  }

  const priority = new Set([...signals.map((s) => s.file), ...entries, ...[...newFiles.keys()].filter((f) => f.endsWith('package.json') || f.endsWith('setup.py') || f.endsWith('pyproject.toml'))]);
  const diff = budgetDiff(unifiedDiff(oldDir, newDir), priority, budget);
  return { signals, changed, removed, sizeOld, sizeNew, diff: diff.text, omitted: diff.omitted };
}
