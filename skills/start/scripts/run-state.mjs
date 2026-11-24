#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const STAGES = ['sharpen', 'team', 'clarify', 'implement', 'gates', 'verify', 'lessons'];
const KINDS = ['work', 'hook', 'env', 'user', 'cancel'];
const MAX_RETRIES = 5;
// Money is kept in integer micros so 0.1 + 0.2 sums exactly.
const toMicros = (usd) => Math.round(Number(usd) * 1e6);
const toUsd = (micros) => micros / 1e6;

class UsageError extends Error {}
const fail = (msg) => { throw new UsageError(msg); };

function usd(value, flag) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n < 0) fail(`${flag} must be a USD amount >= 0`);
  return n;
}

function stage(value) {
  if (!STAGES.includes(value)) fail(`--stage must be one of ${STAGES.join(', ')}`);
  return value;
}

function parseRetry(value = 'implement:2') {
  if (value === 'off') return null;
  const m = /^([a-z]+):(\d+)$/.exec(value);
  if (!m || !STAGES.includes(m[1]) || STAGES.indexOf(m[1]) >= STAGES.indexOf('verify')) fail(`--retry must be <stage before verify>:<1..${MAX_RETRIES}> or off`);
  const max = Number(m[2]);
  if (max < 1 || max > MAX_RETRIES) fail(`--retry max must be 1..${MAX_RETRIES}`);
  return { to: m[1], max };
}

function normalizeSignature(sig) {
  return sig.toLowerCase()
    .replace(/0x[0-9a-f]+/g, '0x')
    .replace(/\d+(\.\d+)?\s*(ms|s)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function load(path) {
  if (!existsSync(path)) fail(`no run state at ${path}; run init first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function save(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, path);
}

const spentMicros = (state) => state.spent.reduce((sum, e) => sum + toMicros(e.usd), 0);
// A retry reruns every stage from its target on, so those stages share the target's round.
function roundOf(state, s) {
  const to = state.policy.retry?.to;
  return to && STAGES.indexOf(s) >= STAGES.indexOf(to) ? state.rounds[to] ?? 1 : 1;
}

// A budget stop replaces next; the retry feedback in it is the worker's only copy of the failure details.
const keptFeedback = (state) => (state.next?.feedback ? { feedback: state.next.feedback } : {});

function requireRunning(state) {
  if (state.status !== 'running') fail(`run is ${state.status}; resume it or start a new run`);
}

function streamCost(file) {
  const results = readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o) => o?.type === 'result' && typeof o.total_cost_usd === 'number');
  if (results.length === 0) fail(`${file} has no result line with total_cost_usd; book it with --unpriced`);
  // total_cost_usd is a running total: a session that resumes (after a background subagent) writes it again.
  const lastPerSession = new Map(results.map((o, i) => [o.session_id ?? `line-${i}`, o.total_cost_usd]));
  return [...lastPerSession.values()].reduce((sum, usd) => sum + toMicros(usd), 0);
}

const commands = {
  init(o) {
    if (!o.task) fail('--task is required');
    const policy = { ceilingUsd: o.budget === undefined ? null : usd(o.budget, '--budget'), retry: parseRetry(o.retry) };
    if (existsSync(o.state)) {
      const prev = load(o.state);
      if (JSON.stringify(prev.policy) !== JSON.stringify(policy) || prev.task !== o.task) {
        fail(`policy_changed: ${o.state} holds ${JSON.stringify(prev.policy)}; resume it or use a new state file`);
      }
      return { code: 0, out: prev };
    }
    const state = { v: 1, task: o.task, policy, status: 'running', spent: [], rounds: {}, failures: [], lastEstimate: {}, next: null };
    save(o.state, state);
    return { code: 0, out: state };
  },

  check(o, state) {
    requireRunning(state);
    const s = stage(o.stage);
    const legs = o.legs === undefined ? 1 : Number(o.legs);
    if (!Number.isInteger(legs) || legs < 1) fail('--legs must be an integer >= 1');
    const ceiling = state.policy.ceilingUsd === null ? null : toMicros(state.policy.ceilingUsd);
    const earlier = state.spent.filter((e) => e.stage === s).map((e) => toMicros(e.usd));
    const perLeg = o.estimate !== undefined ? toMicros(usd(o.estimate, '--estimate'))
      : earlier.length ? Math.max(...earlier)
      : ceiling === null ? 0 : Math.round(ceiling / 10);
    state.lastEstimate[s] = toUsd(perLeg);
    const spent = spentMicros(state);
    const needed = perLeg * legs;
    if (ceiling === null) {
      save(o.state, state);
      return { code: 0, out: { ok: true, spentUsd: toUsd(spent), remainingUsd: null, neededUsd: toUsd(needed), perLegCapUsd: null } };
    }
    const remaining = ceiling - spent;
    // Equality is refused: a step estimated to use exactly what is left would end the run over the line.
    const ok = remaining > needed;
    const out = { ok, spentUsd: toUsd(spent), remainingUsd: toUsd(remaining), neededUsd: toUsd(needed), perLegCapUsd: ok ? toUsd(Math.floor(remaining / legs)) : 0 };
    if (!ok) {
      state.status = 'stopped_budget';
      state.next = { stage: s, round: roundOf(state, s), reason: 'budget', ...out, ...keptFeedback(state) };
    }
    save(o.state, state);
    return { code: ok ? 0 : 3, out };
  },

  book(o, state) {
    // Spend that happened after a stop is still real, so only a finished run refuses it.
    if (state.status === 'done') fail('run is done; start a new run');
    const s = stage(o.stage);
    if (!o.leg) fail('--leg is required (worker, reviewer, subagent name, ...)');
    const sources = [o.usd, o.stream, o['running-total'], o.unpriced || undefined].filter((v) => v !== undefined).length;
    if (sources !== 1) fail('give exactly one of --usd, --stream, --running-total, --unpriced');
    let micros;
    let session;
    if (o.usd !== undefined) micros = toMicros(usd(o.usd, '--usd'));
    else if (o['running-total'] !== undefined) {
      // A new driving session restarts its total at 0, so only readings of the same session are subtracted.
      if (!o.session) fail('--running-total needs --session <label>, one per driving session');
      session = o.session;
      const before = state.spent.filter((e) => e.leg === o.leg && e.session === session).reduce((sum, e) => sum + toMicros(e.usd), 0);
      micros = toMicros(usd(o['running-total'], '--running-total')) - before;
      if (micros < 0) fail(`--running-total is below the ${toUsd(before)} USD already booked for leg ${o.leg} in session ${session}`);
    }
    else if (o.stream !== undefined) micros = streamCost(o.stream);
    else {
      const est = o.estimate !== undefined ? usd(o.estimate, '--estimate') : state.lastEstimate[s];
      // Without a ceiling nothing is guarded by the estimate, so a leg of unknown cost is booked at 0 and counted.
      if (!(est > 0) && state.policy.ceilingUsd !== null) fail('--unpriced needs an estimate above 0 under a ceiling (--estimate, or an earlier check of this stage)');
      micros = toMicros(est ?? 0);
    }
    state.spent.push({ stage: s, round: roundOf(state, s), leg: o.leg, ...(session ? { session } : {}), usd: toUsd(micros), unpriced: o.unpriced === true });
    const spent = spentMicros(state);
    const ceiling = state.policy.ceilingUsd === null ? null : toMicros(state.policy.ceilingUsd);
    const overCeiling = ceiling !== null && spent >= ceiling;
    if (overCeiling && state.status === 'running') {
      state.status = 'stopped_budget';
      state.next = { stage: s, round: roundOf(state, s), reason: 'over_ceiling', bookedLeg: o.leg, ...keptFeedback(state) };
    }
    save(o.state, state);
    return { code: overCeiling ? 3 : 0, out: { bookedUsd: toUsd(micros), spentUsd: toUsd(spent), overCeiling } };
  },

  fail(o, state) {
    requireRunning(state);
    const s = stage(o.stage);
    if (!KINDS.includes(o.kind)) fail(`--kind must be one of ${KINDS.join(', ')}`);
    if (!o.signature) fail('--signature is required: the failing command and first failing test or assertion, or the finding with file:line');
    const signature = normalizeSignature(o.signature);
    const policy = state.policy.retry;
    const lastWork = state.failures.filter((f) => f.kind === 'work').at(-1);
    const used = policy ? roundOf(state, policy.to) - 1 : 0;
    let reason = null;
    if (o.kind !== 'work') reason = `terminal_${o.kind}`;
    else if (!policy) reason = 'no_retry_policy';
    else if (STAGES.indexOf(s) < STAGES.indexOf(policy.to)) reason = 'stage_before_target';
    else if (lastWork && lastWork.signature === signature) reason = 'no_progress';
    else if (used >= policy.max) reason = 'retries_exhausted';
    state.failures.push({ stage: s, round: roundOf(state, s), kind: o.kind, signature, feedback: o.feedback ?? null, decision: reason ?? 'retry' });
    if (reason) {
      state.status = reason === 'no_progress' || reason === 'retries_exhausted' ? 'stopped_retry' : 'stopped_terminal';
      state.next = { stage: s, round: roundOf(state, s), reason };
      save(o.state, state);
      return { code: 4, out: { decision: 'stop', reason, failures: state.failures } };
    }
    const round = used + 2;
    state.rounds[policy.to] = round;
    state.next = { stage: policy.to, round, feedback: o.feedback ?? null };
    save(o.state, state);
    return { code: 0, out: { decision: 'retry', stage: policy.to, round, retriesLeft: policy.max - used - 1, feedback: o.feedback ?? null } };
  },

  resume(o, state) {
    if (state.status === 'running') return { code: 0, out: { status: 'running', next: state.next } };
    if (state.status !== 'stopped_budget') fail(`a ${state.status} run is not resumed; start a new run`);
    const raised = usd(o.budget, '--budget');
    if (raised <= state.policy.ceilingUsd) fail(`--budget must be above the current ceiling ${state.policy.ceilingUsd}; only the user raises it`);
    state.policy.ceilingUsd = raised;
    state.status = 'running';
    save(o.state, state);
    return { code: 0, out: { status: 'running', ceilingUsd: raised, next: state.next } };
  },

  done(o, state) {
    requireRunning(state);
    state.status = 'done';
    state.next = null;
    save(o.state, state);
    return commands.status(o, state);
  },

  status(_o, state) {
    const unpriced = state.spent.filter((e) => e.unpriced).reduce((sum, e) => sum + toMicros(e.usd), 0);
    const unknownCostLegs = state.spent.filter((e) => e.unpriced && toMicros(e.usd) === 0).length;
    return { code: 0, out: { status: state.status, task: state.task, ceilingUsd: state.policy.ceilingUsd, spentUsd: toUsd(spentMicros(state)), unpricedUsd: toUsd(unpriced), unknownCostLegs, rounds: state.rounds, failures: state.failures.length, next: state.next } };
  },
};

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!commands[cmd]) fail(`usage: run-state.mjs <${Object.keys(commands).join('|')}> --state <file> [options]`);
  const { values } = parseArgs({
    args: rest,
    options: {
      state: { type: 'string' }, task: { type: 'string' }, budget: { type: 'string' }, retry: { type: 'string' },
      stage: { type: 'string' }, estimate: { type: 'string' }, legs: { type: 'string' }, leg: { type: 'string' },
      usd: { type: 'string' }, stream: { type: 'string' }, 'running-total': { type: 'string' }, unpriced: { type: 'boolean' },
      kind: { type: 'string' }, signature: { type: 'string' }, feedback: { type: 'string' }, session: { type: 'string' },
    },
  });
  if (!values.state) fail('--state <file> is required');
  return cmd === 'init' ? commands.init(values) : commands[cmd](values, load(values.state));
}

try {
  const { code, out } = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(code);
} catch (err) {
  process.stderr.write(`run-state: ${err.message}\n`);
  process.exit(2);
}
