// Local stand-in for registry.npmjs.org, open-vsx.org and api.osv.dev, serving the fixtures in fixtures.mjs.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { npmVersions, vsxVersions, writeNpm, writeVsx } from './fixtures.mjs';

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

export async function startRegistry({ published = { '1.0.0': 40, '1.0.1': 30, '1.0.2': 20 }, extPublished = { '2.1.311': 30, '2.1.312': 20 }, malicious = [], extensionVersions = vsxVersions } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-registry-'));
  const blobs = new Map();
  const tarballs = {};
  for (const v of Object.keys(npmVersions)) {
    const root = writeNpm(fs.mkdtempSync(path.join(dir, 'src-')), v);
    const file = path.join(dir, `scg-demo-${v}.tgz`);
    execFileSync('tar', ['-czf', file, '-C', root, 'package']);
    const buf = fs.readFileSync(file);
    blobs.set(`/scg-demo/-/scg-demo-${v}.tgz`, buf);
    tarballs[v] = buf;
  }
  for (const v of Object.keys(extensionVersions)) {
    const root = writeVsx(fs.mkdtempSync(path.join(dir, 'src-')), v, extensionVersions[v]);
    const file = path.join(dir, `scg-ext-${v}.vsix`);
    execFileSync('python3', ['-I', '-c', 'import sys, shutil; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', file.replace(/\.vsix$/, ''), root]);
    fs.renameSync(file.replace(/\.vsix$/, '.zip'), file);
    blobs.set(`/vsx/scg-ext-${v}.vsix`, fs.readFileSync(file));
  }

  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (blobs.has(req.url)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(blobs.get(req.url));
    }
    if (req.url === '/scg-demo') {
      const versions = Object.keys(published);
      return json({
        name: 'scg-demo',
        'dist-tags': { latest: versions.at(-1) },
        time: Object.fromEntries(versions.map((v) => [v, daysAgo(published[v])])),
        versions: Object.fromEntries(
          versions.map((v) => [
            v,
            {
              ...JSON.parse(npmVersions[v]['package.json']),
              dist: {
                tarball: `${base}/scg-demo/-/scg-demo-${v}.tgz`,
                shasum: crypto.createHash('sha1').update(tarballs[v]).digest('hex'),
                integrity: `sha512-${crypto.createHash('sha512').update(tarballs[v]).digest('base64')}`,
              },
            },
          ]),
        ),
      });
    }
    const ext = /^\/vsx-api\/scgtest\/scg-ext(?:\/([\d.]+))?$/.exec(req.url);
    if (ext) {
      const v = ext[1] ?? Object.keys(extPublished).at(-1);
      if (!extPublished[v]) return json({ error: 'not found' }, 404);
      return json({ namespace: 'scgtest', name: 'scg-ext', version: v, timestamp: daysAgo(extPublished[v]), files: { download: `${base}/vsx/scg-ext-${v}.vsix` } });
    }
    if (req.url === '/v1/query' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const q = JSON.parse(body);
        const hit = malicious.includes(`${q.package.name}@${q.version}`);
        json(hit ? { vulns: [{ id: 'MAL-2026-0001', summary: 'Malicious code in scg-demo (fixture)' }] } : {});
      });
      return;
    }
    json({ error: 'not found' }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    env: { SCG_NPM_REGISTRY: base, SCG_VSX_API: `${base}/vsx-api`, SCG_OSV_URL: base },
    close: () => new Promise((r) => server.close(r)).finally(() => fs.rmSync(dir, { recursive: true, force: true })),
  };
}
