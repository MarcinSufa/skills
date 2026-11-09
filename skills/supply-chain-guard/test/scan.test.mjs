import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scan } from '../hooks/scan.mjs';
import { writeNpm, writeVsx } from './fixtures.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scg-scan-'));
const npmTree = (v) => path.join(writeNpm(tmp(), v), 'package');
const ids = (r) => r.signals.map((s) => `${s.id}:${s.severity}`).sort();

test('a benign patch release raises no signal and still shows its diff', () => {
  const r = scan({ oldDir: npmTree('1.0.0'), newDir: npmTree('1.0.1'), ecosystem: 'npm' });
  assert.deepEqual(r.signals, []);
  assert.match(r.diff, /\+exports\.greet = \(name\) => 'hello, '/);
});

test('the trojaned npm update is flagged for install script, ssh keys, exec and the tunnel address', () => {
  const r = scan({ oldDir: npmTree('1.0.1'), newDir: npmTree('1.0.2'), ecosystem: 'npm' });
  assert.deepEqual(ids(r), ['install-script:high', 'ip-literal:high', 'process-exec:medium', 'ssh-keys:critical']);
  assert.match(r.signals.find((s) => s.id === 'install-script').evidence, /postinstall/);
  assert.equal(r.signals.find((s) => s.id === 'ip-literal').evidence, '192.0.2.1');
});

test('the trojaned extension update is flagged as load-time code in its entry file', () => {
  const r = scan({ oldDir: writeVsx(tmp(), '2.1.311'), newDir: writeVsx(tmp(), '2.1.312'), ecosystem: 'vsx' });
  const exec = r.signals.find((s) => s.id === 'process-exec');
  assert.equal(exec.loadTime, true);
  assert.equal(exec.severity, 'high');
  assert.ok(r.signals.some((s) => s.id === 'ssh-keys' && s.file === 'extension/extension.js'));
});

test('an entry file that already spawned processes is not escalated for one more call', () => {
  const oldDir = writeVsx(tmp(), '2.1.311');
  const newDir = writeVsx(tmp(), '2.1.311');
  fs.appendFileSync(path.join(oldDir, 'extension/extension.js'), `require('child_process');\n`);
  fs.appendFileSync(path.join(newDir, 'extension/extension.js'), `require('child_process');\nrequire('child_process').execSync('git --version');\n`);
  const exec = scan({ oldDir, newDir, ecosystem: 'vsx' }).signals.find((s) => s.id === 'process-exec');
  assert.equal(exec.severity, 'medium');
  assert.equal(exec.loadTime, undefined);
});

test('patterns already present in the old version stay quiet', () => {
  const oldDir = npmTree('1.0.0');
  const newDir = npmTree('1.0.1');
  for (const d of [oldDir, newDir]) fs.appendFileSync(path.join(d, 'index.js'), `module.exports.t = new Function('return 1');\n`);
  assert.deepEqual(scan({ oldDir, newDir, ecosystem: 'npm' }).signals, []);
});

test('a first install reports endpoints as info only, a big unexplained growth as size-jump', () => {
  const fresh = scan({ oldDir: tmp(), newDir: npmTree('1.0.2'), ecosystem: 'npm', isNew: true });
  assert.equal(fresh.signals.find((s) => s.id === 'ip-literal').severity, 'info');

  const oldDir = npmTree('1.0.0');
  const newDir = npmTree('1.0.1');
  fs.writeFileSync(path.join(newDir, 'blob.js'), `module.exports = ${JSON.stringify('x '.repeat(200_000))};\n`);
  assert.ok(scan({ oldDir, newDir, ecosystem: 'npm' }).signals.some((s) => s.id === 'size-jump'));
});

test('python .pth startup hooks and base64 blobs are flagged, data URIs are not', () => {
  const oldDir = tmp();
  const newDir = tmp();
  fs.writeFileSync(path.join(oldDir, 'mod.py'), 'X = 1\n');
  fs.writeFileSync(path.join(newDir, 'mod.py'), `X = 1\nFONT = "data:font/woff2;base64,${'A'.repeat(400)}"\n`);
  assert.deepEqual(scan({ oldDir, newDir, ecosystem: 'PyPI' }).signals, []);

  fs.writeFileSync(path.join(newDir, 'evil.pth'), `import os; exec(__import__('base64').b64decode("${'QUJD'.repeat(100)}"))\n`);
  assert.deepEqual(ids(scan({ oldDir, newDir, ecosystem: 'PyPI' })), ['dynamic-code:high', 'obfuscation:high', 'pth-startup-hook:high']);
});

test('the diff fits the budget and keeps flagged files first', () => {
  const oldDir = npmTree('1.0.1');
  const newDir = npmTree('1.0.2');
  fs.writeFileSync(path.join(newDir, 'aaa-noise.js'), 'x\n'.repeat(5000));
  const r = scan({ oldDir, newDir, ecosystem: 'npm', budget: 2000 });
  assert.ok(r.diff.length <= 2100);
  assert.match(r.diff, /install\.js/);
  assert.deepEqual(r.omitted, ['aaa-noise.js']);
});

test('zip extraction refuses entries that escape the target directory', async () => {
  const { extractZip } = await import('../hooks/sources.mjs');
  const src = tmp();
  fs.writeFileSync(path.join(src, 'ok.txt'), 'fine');
  const zip = path.join(tmp(), 'a.zip');
  const py = (code) => execFileSync('python3', ['-I', '-c', code, zip, src]);
  py('import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED); z.write(sys.argv[2] + "/ok.txt", "dir/ok.txt"); z.writestr("../evil.txt", "x"); z.close()');
  const out = tmp();
  assert.throws(() => extractZip(fs.readFileSync(zip), out), /escapes the archive/);
  assert.equal(fs.existsSync(path.join(out, '..', 'evil.txt')), false);
  py('import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED); z.write(sys.argv[2] + "/ok.txt", "dir/ok.txt"); z.close()');
  extractZip(fs.readFileSync(zip), out);
  assert.equal(fs.readFileSync(path.join(out, 'dir/ok.txt'), 'utf8'), 'fine');
});

test('code the scanner cannot read as text asks instead of passing as an opaque binary', () => {
  const oldDir = npmTree('1.0.1');
  const newDir = npmTree('1.0.1');
  fs.writeFileSync(path.join(newDir, 'nul.js'), Buffer.concat([Buffer.from('\0'), Buffer.from("require('fs').appendFileSync(os.homedir() + '/.ssh/authorized_keys', k)")]));
  fs.writeFileSync(path.join(newDir, 'huge.js'), `// ${'x'.repeat(4_100_000)}\n`);
  fs.writeFileSync(path.join(newDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  const r = scan({ oldDir, newDir, ecosystem: 'npm' });
  assert.deepEqual(r.signals.filter((s) => s.id === 'unscannable').map((s) => `${s.file}:${s.severity}`).sort(), ['huge.js:high', 'nul.js:high']);
  assert.equal(r.signals.find((s) => s.file === 'logo.png').id, 'binary-added');
});

test('a symlink to a device on both sides is compared by target, not read', () => {
  const oldDir = npmTree('1.0.1');
  const newDir = npmTree('1.0.1');
  fs.symlinkSync('/dev/zero', path.join(oldDir, 'z'));
  fs.symlinkSync('/dev/zero', path.join(newDir, 'z'));
  fs.symlinkSync('/dev/urandom', path.join(newDir, 'r'));
  const r = scan({ oldDir, newDir, ecosystem: 'npm' });
  assert.deepEqual(r.signals.map((s) => `${s.id}:${s.file}`), ['symlink:r']);
});
