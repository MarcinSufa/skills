#!/usr/bin/env node
// portless-preview: thin launcher around `PORTLESS_HTTPS=0 npx -y portless@0.15.5 run <dev command>`.
// The child's own stdout banner is the source of truth: portless prints a hostname line
// ("-- <hostnames> (auto-resolves to 127.0.0.1)" or "(LAN: <ip>)") and a port line
// ("-- Using port <port>", sometimes with "(fixed)"). Every child line is forwarded
// unchanged; once BOTH facts are seen, ONE extra line in clean tokens is appended:
//   PORTLESS_PREVIEW browser=<url> node=<url>
// The literal 127.0.0.1 URL matters because the Windows resolver fails *.localhost for
// Node and Python. Nothing starts on import; the dev server starts only when invoked.
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const WINDOWS = process.platform === 'win32';
const HOST_RE = /^-- ([^\s,]+).* \((?:auto-resolves to 127\.0\.0\.1|LAN: [\d.]+)\)/;
const PORT_RE = /^-- Using port (\d+)(?: \(fixed\))?$/;
// portless enables colors when EITHER std stream is a TTY; stderr is inherited here, so in
// a real terminal the hostname line arrives wrapped in SGR codes (\x1B[2m...\x1B[22m).
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Windows: the direct child is the shell shim, so child.kill() alone would orphan the
// tree; taskkill /T fells it whole. POSIX: detached process group, signalled as a whole.
function killTree(child, signal) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  if (WINDOWS) {
    // spawnSync does NOT throw when taskkill is missing or fails; the verdict is on the result.
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0) child.kill(signal);
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}

function main() {
  const args = process.argv.slice(2);

  // Node preflight; exit code 2 marks environment failures, distinct from child exit codes.
  const major = Number(process.version.slice(1).split('.', 1)[0]);
  if (process.env.PORTLESS_PREVIEW_FORCE_PREFLIGHT_FAIL === '1' || !(major >= 24)) {
    console.error(`PORTLESS_PREVIEW preflight-failed node=${process.version} required=24+`);
    process.exit(2);
  }

  // Flags are forwarded untouched: no allow-list, no parsing. On Windows npx is a .cmd
  // shim, so the invocation goes to the shell as ONE plain space-joined string.
  const invocation = ['-y', 'portless@0.15.5', 'run', ...args];
  const child = spawn(WINDOWS ? ['npx.cmd', ...invocation].join(' ') : 'npx', WINDOWS ? [] : invocation, {
    stdio: ['inherit', 'pipe', 'inherit'], // stdout piped: the banner is the source of truth
    shell: WINDOWS,
    detached: !WINDOWS,
    windowsHide: true,
    env: { ...process.env, PORTLESS_HTTPS: '0' },
  });
  process.on('SIGINT', () => killTree(child, 'SIGINT'));
  process.on('SIGTERM', () => killTree(child, 'SIGTERM'));

  // A consumer that stops reading (`... | head -1`) is a normal shutdown, not a crash:
  // without this handler the EPIPE throws, 'close' never runs, and the child is orphaned.
  process.stdout.on('error', (error) => {
    if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') throw error;
    killTree(child, 'SIGTERM');
    process.exit(0);
  });

  let hostname = null, port = null, announced = false, buffered = '';

  function inspect(line) {
    if (announced) return;
    // Match on a stripped copy (colors off the anchor, CR off the tail); the forwarded
    // bytes above stay untouched so the banner looks exactly as portless printed it.
    const decolored = line.replace(ANSI_RE, '');
    const clean = decolored.endsWith('\r') ? decolored.slice(0, -1) : decolored;
    if (hostname === null) hostname = HOST_RE.exec(clean)?.[1] ?? null;
    if (port === null) port = PORT_RE.exec(clean)?.[1] ?? null;
    if (hostname !== null && port !== null) {
      announced = true;
      console.log(`PORTLESS_PREVIEW browser=http://${hostname} node=http://127.0.0.1:${port}`);
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk); // the banner must look exactly as it does without the wrapper
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) inspect(line);
  });

  // 'close', not 'exit': every pending stdout chunk is parsed before the verdict.
  child.on('close', (code, signal) => {
    if (buffered !== '') inspect(buffered); // final line without a trailing newline
    if (!announced) {
      // Child ended before both facts appeared: one controlled marker, no invented URL.
      console.error('PORTLESS_PREVIEW banner-incomplete');
      killTree(child, 'SIGTERM');
    }
    const childCode = code ?? (signal ? 1 : 0); // child's own exit code is preserved below
    // A clean child exit without a banner is still a wrapper failure: exit 1 (2 = preflight only).
    process.exitCode = childCode === 0 && !announced ? 1 : childCode;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
