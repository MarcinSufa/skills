import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'run-state.mjs');

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'run-state-'));
  const state = join(dir, 'nested', 'run.json');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, args[0], '--state', state, ...args.slice(1)], { encoding: 'utf8' });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* error text on stderr */ }
    return { code: r.status, out, stderr: r.stderr };
  };
  const read = () => JSON.parse(readFileSync(state, 'utf8'));
  return { dir, state, run, read };
}

function streamFile(dir, costs) {
  const f = join(dir, `leg-${costs.join('-')}.jsonl`);
  const lines = [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: {} }];
  for (const c of costs) lines.push({ type: 'result', subtype: 'success', total_cost_usd: c });
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

test('init writes the policy once and defaults retry to implement:2', () => {
  const s = fresh();
  assert.equal(s.run('init', '--task', 'fix x', '--budget', '5').code, 0);
  assert.deepEqual(s.read().policy, { ceilingUsd: 5, retry: { to: 'implement', max: 2 } });
  assert.equal(s.read().status, 'running');
});

test('init again with the same policy replays, a changed policy is refused', () => {
  const s = fresh();
  s.run('init', '--task', 'fix x', '--budget', '5', '--retry', 'implement:2');
  assert.equal(s.run('init', '--task', 'fix x', '--budget', '5', '--retry', 'implement:2').code, 0);
  const changed = s.run('init', '--task', 'fix x', '--budget', '5', '--retry', 'implement:3');
  assert.equal(changed.code, 2);
  assert.match(changed.stderr, /policy_changed/);
  assert.equal(s.read().policy.retry.max, 2);
});

test('init rejects an unknown retry target and a max outside 1..5', () => {
  for (const r of ['deploy:2', 'implement:0', 'implement:6', 'implement:x']) {
    const s = fresh();
    assert.equal(s.run('init', '--task', 't', '--retry', r).code, 2, r);
    assert.equal(existsSync(s.state), false, r);
  }
});

test('a work failure after the target retries the target with the feedback, up to max', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--retry', 'implement:2');
  const r1 = s.run('fail', '--stage', 'verify', '--kind', 'work', '--signature', 'pytest tests/a.py::test_one', '--feedback', 'expected 1 got 2');
  assert.equal(r1.code, 0);
  assert.deepEqual(r1.out, { decision: 'retry', stage: 'implement', round: 2, retriesLeft: 1, feedback: 'expected 1 got 2' });
  const r2 = s.run('fail', '--stage', 'verify', '--kind', 'work', '--signature', 'pytest tests/a.py::test_two');
  assert.equal(r2.code, 0);
  assert.equal(r2.out.round, 3);
  const r3 = s.run('fail', '--stage', 'verify', '--kind', 'work', '--signature', 'pytest tests/a.py::test_three');
  assert.equal(r3.code, 4);
  assert.equal(r3.out.reason, 'retries_exhausted');
  assert.equal(s.read().status, 'stopped_retry');
});

test('max counts returns to the target across every failing stage', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--retry', 'implement:1');
  assert.equal(s.run('fail', '--stage', 'gates', '--kind', 'work', '--signature', 'lint').code, 0);
  assert.equal(s.run('fail', '--stage', 'verify', '--kind', 'work', '--signature', 'review P1 a.py:3').code, 4);
});

test('the same failure twice in a row stops as no_progress, even when only numbers and spacing changed', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--retry', 'implement:3');
  s.run('fail', '--stage', 'verify', '--kind', 'work', '--signature', 'pytest a.py::t  AssertionError at 0x7f3a in 0.31s');
  const r = s.run('fail', '--stage', 'verify', '--kind', 'work', '--signature', 'PyTest a.py::t AssertionError at 0x9b1c in 1.2s');
  assert.equal(r.code, 4);
  assert.equal(r.out.reason, 'no_progress');
});

test('hook, env, user and cancel failures never retry', () => {
  for (const kind of ['hook', 'env', 'user', 'cancel']) {
    const s = fresh();
    s.run('init', '--task', 't', '--retry', 'implement:2');
    const r = s.run('fail', '--stage', 'gates', '--kind', kind, '--signature', 'blocked');
    assert.equal(r.code, 4, kind);
    assert.equal(r.out.reason, `terminal_${kind}`, kind);
    assert.equal(s.read().status, 'stopped_terminal', kind);
  }
});

test('a failure before the target, or with retry off, is terminal', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--retry', 'implement:2');
  assert.equal(s.run('fail', '--stage', 'clarify', '--kind', 'work', '--signature', 'x').out.reason, 'stage_before_target');
  const off = fresh();
  off.run('init', '--task', 't', '--retry', 'off');
  assert.equal(off.run('fail', '--stage', 'verify', '--kind', 'work', '--signature', 'x').out.reason, 'no_retry_policy');
});

test('check refuses when the remaining budget equals the estimate, and writes the stop', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--budget', '1');
  s.run('book', '--stage', 'implement', '--leg', 'worker', '--usd', '0.6');
  const r = s.run('check', '--stage', 'verify', '--estimate', '0.4');
  assert.equal(r.code, 3);
  assert.equal(r.out.ok, false);
  const st = s.read();
  assert.equal(st.status, 'stopped_budget');
  assert.deepEqual(st.next.stage, 'verify');
  assert.equal(s.run('check', '--stage', 'verify', '--estimate', '0.01').code, 2, 'a stopped run refuses further checks');
});

test('check passes below the ceiling and splits the remaining budget per parallel leg', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--budget', '3');
  const r = s.run('check', '--stage', 'implement', '--estimate', '0.5', '--legs', '2');
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, { ok: true, spentUsd: 0, remainingUsd: 3, neededUsd: 1, perLegCapUsd: 1.5 });
  const over = s.run('check', '--stage', 'implement', '--estimate', '1.5', '--legs', '2');
  assert.equal(over.code, 3);
});

test('the estimate defaults to the largest earlier leg of that stage, else 10% of the ceiling', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--budget', '2');
  assert.equal(s.run('check', '--stage', 'implement').out.neededUsd, 0.2);
  s.run('book', '--stage', 'implement', '--leg', 'worker', '--usd', '0.7');
  s.run('book', '--stage', 'implement', '--leg', 'worker', '--usd', '0.3');
  assert.equal(s.run('check', '--stage', 'implement').out.neededUsd, 0.7);
});

test('book sums every result line of a stream-json file and counts subagents and retry rounds', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--budget', '10', '--retry', 'implement:2');
  s.run('book', '--stage', 'implement', '--leg', 'worker', '--stream', streamFile(s.dir, [0.25, 0.5]));
  s.run('book', '--stage', 'verify', '--leg', 'reviewer-subagent', '--unpriced', '--estimate', '0.4');
  s.run('fail', '--stage', 'verify', '--kind', 'work', '--signature', 'P1 a.py:3');
  s.run('book', '--stage', 'implement', '--leg', 'worker', '--usd', '0.2');
  const st = s.read();
  assert.deepEqual(st.spent.map((e) => [e.stage, e.round, e.usd, e.unpriced]), [
    ['implement', 1, 0.75, false],
    ['verify', 1, 0.4, true],
    ['implement', 2, 0.2, false],
  ]);
  const status = s.run('status').out;
  assert.equal(status.spentUsd, 1.35);
  assert.equal(status.unpricedUsd, 0.4);
});

test('book --unpriced without an estimate uses the per-leg estimate of the last check, never zero', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--budget', '4');
  s.run('check', '--stage', 'verify', '--estimate', '0.3');
  s.run('book', '--stage', 'verify', '--leg', 'codex', '--unpriced');
  assert.equal(s.read().spent[0].usd, 0.3);
  const t = fresh();
  t.run('init', '--task', 't');
  assert.equal(t.run('book', '--stage', 'verify', '--leg', 'codex', '--unpriced').code, 2);
});

test('book --stream with no result line is refused', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--budget', '4');
  const f = join(s.dir, 'empty.jsonl');
  writeFileSync(f, '{"type":"system"}\n');
  const r = s.run('book', '--stage', 'implement', '--leg', 'worker', '--stream', f);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no result line/);
});

test('without --budget nothing is refused but spend is still booked', () => {
  const s = fresh();
  s.run('init', '--task', 't');
  s.run('book', '--stage', 'implement', '--leg', 'worker', '--usd', '50');
  assert.equal(s.run('check', '--stage', 'verify', '--estimate', '100').code, 0);
  assert.equal(s.run('status').out.spentUsd, 50);
});

test('resume only raises the ceiling and reopens a budget stop at the refused stage', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--budget', '1');
  s.run('book', '--stage', 'implement', '--leg', 'worker', '--usd', '0.9');
  s.run('check', '--stage', 'verify', '--estimate', '0.2');
  assert.equal(s.run('resume', '--budget', '1').code, 2);
  const r = s.run('resume', '--budget', '2');
  assert.equal(r.code, 0);
  assert.equal(r.out.next.stage, 'verify');
  assert.equal(s.read().status, 'running');
  assert.equal(s.read().policy.ceilingUsd, 2);
});

test('resume does not reopen a retry or terminal stop', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--retry', 'implement:1');
  s.run('fail', '--stage', 'verify', '--kind', 'hook', '--signature', 'blocked');
  assert.equal(s.run('resume', '--budget', '9').code, 2);
});

test('a booking that reaches the ceiling stops the run, so done cannot report success', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--budget', '1');
  assert.equal(s.run('check', '--stage', 'implement', '--estimate', '0.3').code, 0);
  const r = s.run('book', '--stage', 'implement', '--leg', 'worker', '--usd', '1.2');
  assert.equal(r.code, 3);
  assert.equal(r.out.overCeiling, true);
  assert.equal(s.read().status, 'stopped_budget');
  assert.equal(s.run('done').code, 2);
});

test('book --unpriced refuses a zero estimate, also after a check without a ceiling', () => {
  const s = fresh();
  s.run('init', '--task', 't');
  s.run('check', '--stage', 'verify');
  assert.equal(s.run('book', '--stage', 'verify', '--leg', 'codex', '--unpriced').code, 2);
  assert.equal(s.run('book', '--stage', 'verify', '--leg', 'codex', '--unpriced', '--estimate', '0').code, 2);
  assert.equal(s.run('book', '--stage', 'verify', '--leg', 'codex', '--unpriced', '--estimate', '0.2').code, 0);
});

test('book still records real spend after a budget or retry stop, but not after done', () => {
  const s = fresh();
  s.run('init', '--task', 't', '--budget', '1');
  s.run('check', '--stage', 'verify', '--estimate', '5');
  assert.equal(s.run('book', '--stage', 'verify', '--leg', 'late-reviewer', '--usd', '0.1').code, 0);
  const d = fresh();
  d.run('init', '--task', 't');
  d.run('done');
  assert.equal(d.run('book', '--stage', 'verify', '--leg', 'x', '--usd', '0.1').code, 2);
});
