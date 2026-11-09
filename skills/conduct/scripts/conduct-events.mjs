#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { makeEvent, validateEvent } from "./lib/events-schema.mjs";
import { appendEvent, readEvents, homeRoot, writeRegistry, readRegistry, writeActivation, resolveActivation, scratchPut, scratchTake, touchHeartbeat, recordHookActivity } from "./lib/events-store.mjs";
import { mapHook } from "./lib/hook-map.mjs";
import { parseTranscriptUsage } from "./lib/usage-transcript.mjs";
import { parseCodexUsage } from "./lib/usage-codex.mjs";
import { parseCodexSpans } from "./lib/spans-codex.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= args.length || args[i + 1].startsWith("--")) return undefined;
  return args[i + 1];
};
const fail = (msg, code = 1) => { process.stdout.write(msg + "\n"); process.exit(code); };
const logError = (err) => {
  try {
    mkdirSync(homeRoot(), { recursive: true });
    appendFileSync(path.join(homeRoot(), "hook-errors.log"), `${new Date().toISOString()} ${cmd} ${err?.stack ?? err}\n`);
  } catch { /* Hook logging must never affect the fail-open boundary. */ }
};

function activation() {
  const a = resolveActivation({ sessionId: opt("session"), cwd: opt("cwd") ?? process.cwd() });
  if (!a) fail("no active orchestration for this session or cwd (run register first)");
  return a;
}
const readJsonFile = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

if (cmd === "register") {
  const slice = opt("slice"), session = opt("session"), repoArg = opt("repo"), vaultId = opt("vault");
  const repo = repoArg ? path.resolve(repoArg) : null;
  if (!slice || !session || !vaultId) fail("usage: register --slice <name> --session <id> --repo <path> --vault <vaultId> [--ticket <id>] [--plan-group <id>]");
  const orchestrationId = `conduct-${slice}-${createHash("sha256").update(session).digest("hex").slice(0, 8)}`;
  const prev = readRegistry(orchestrationId);
  const runNo = prev ? Number(String(prev.runId).split("-").at(-1)) + 1 : 1;
  const runId = `${slice}-${runNo}`;
  const eventsPath = path.join(repo, ".conduct", "events.ndjson");
  const now = new Date().toISOString();
  writeRegistry(orchestrationId, { id: orchestrationId, kind: "conduct", goal: slice, runId, eventsPath, cwd: repo, startedAt: now, heartbeatAt: now, vaultRefs: { vaultId, ticketId: opt("ticket") ?? null, planGroupId: opt("plan-group") ?? null } });
  touchHeartbeat(orchestrationId);
  writeActivation(session, orchestrationId);
  mkdirSync(path.join(repo, ".conduct"), { recursive: true });
  writeFileSync(path.join(repo, ".conduct", "orchestration.json"), JSON.stringify({ orchestrationId, runId }, null, 2));
  appendEvent(eventsPath, makeEvent({ orchestrationId, runId, producer: "conduct-operator" }, "orch.start", { kind: "conduct", goal: slice, vaultRefs: { vaultId, ticketId: opt("ticket") ?? null, planGroupId: opt("plan-group") ?? null }, cwd: repo, pid: process.pid, sessionId: session }));
  process.stdout.write(JSON.stringify({ orchestrationId, runId, eventsPath }) + "\n");
} else if (cmd === "emit") {
  const a = activation();
  const type = opt("type"), file = opt("payload-file");
  if (!type || !file) fail("usage: emit --type <type> --payload-file <json>");
  const payload = JSON.parse(readFileSync(file, "utf8"));
  const event = makeEvent({ orchestrationId: a.orchestrationId, runId: a.runId, producer: "conduct-operator" }, type, payload);
  const v = validateEvent(event);
  if (!v.ok) fail(v.errors.join("; "), 2);
  appendEvent(a.eventsPath, event);
  if (type === "task.phase") writeRegistry(a.orchestrationId, { ...readRegistry(a.orchestrationId), currentTask: payload.taskId, currentAttempt: payload.attempt });
  touchHeartbeat(a.orchestrationId);
} else if (cmd === "hook") {
  try {
    const raw = readFileSync(0, "utf8");
    const p = JSON.parse(raw);
    const a = resolveActivation({ sessionId: p.session_id, cwd: p.cwd, allowCwdFallback: Boolean(p.agent_id) });
    if (!a) process.exit(0);
    const ended = readEvents(a.eventsPath).events.some((e) => e.type === "orch.end");
    const registry = readRegistry(a.orchestrationId);
    const ctx = { base: { orchestrationId: a.orchestrationId, runId: a.runId, producer: "conduct-hook" }, now: () => new Date().toISOString(), scratch: (k) => scratchTake(a.orchestrationId, k) ?? null, readFile: readJsonFile, parsers: { transcript: parseTranscriptUsage, codex: parseCodexUsage, codexSpans: parseCodexSpans }, orchEnded: ended, currentTask: registry?.currentTask, currentAttempt: registry?.currentAttempt };
    const peeked = new Map();
    ctx.scratch = (k) => { if (!peeked.has(k)) peeked.set(k, scratchTake(a.orchestrationId, k)); return peeked.get(k); };
    const r = mapHook(p, ctx);
    for (const [k, v] of peeked) if (v && !r.scratchTakes.includes(k)) scratchPut(a.orchestrationId, k, v);
    for (const [k, v] of r.scratchPuts) scratchPut(a.orchestrationId, k, v);
    let appended = false;
    for (const e of r.events) { try { appendEvent(a.eventsPath, e); appended = true; } catch (err) { logError(err); } }
    const abandoned = p.hook_event_name === "SessionEnd" && r.events.some((e) => e.type === "orch.end");
    recordHookActivity(a.orchestrationId, { appended, abandoned, onHeartbeatError: logError });
    if (abandoned) {
      const sessionFile = p.session_id ? path.join(homeRoot(), "sessions", `${p.session_id}.json`) : null;
      if (sessionFile && existsSync(sessionFile)) unlinkSync(sessionFile);
    }
    if (process.env.CONDUCT_HOOK_DEBUG === "1") process.stderr.write(JSON.stringify(r.events) + "\n");
  } catch (err) { logError(err); }
  finally { process.exit(0); }
} else if (cmd === "end") {
  const a = activation();
  const terminal = opt("terminal") ?? "closed";
  appendEvent(a.eventsPath, makeEvent({ orchestrationId: a.orchestrationId, runId: a.runId, producer: "conduct-operator" }, "orch.end", { terminal }));
  writeRegistry(a.orchestrationId, { ...readRegistry(a.orchestrationId), endedAt: new Date().toISOString(), terminal });
  const s = opt("session"); if (s) { const f = path.join(homeRoot(), "sessions", `${s}.json`); if (existsSync(f)) unlinkSync(f); }
} else if (cmd === "rotate" || cmd === "unlock") {
  const a = activation();
  const dir = path.join(homeRoot(), "scratch", a.orchestrationId);
  if (existsSync(dir)) for (const f of readdirSync(dir)) {
    const full = path.join(dir, f);
    const ageMs = Date.now() - statSync(full).mtimeMs;
    if (cmd === "unlock" || ageMs > 10 * 60_000) {
      if (cmd === "rotate" && f.startsWith("span_")) { const key = f.replace(/\.json$/, ""); appendEvent(a.eventsPath, makeEvent({ orchestrationId: a.orchestrationId, runId: a.runId, producer: "conduct-hook" }, "span", { legId: "unbound", spanId: key.slice(5), toolUseId: key.slice(5), "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "unknown", status: "interrupted", tsStart: new Date(statSync(full).mtimeMs).toISOString(), tsEnd: new Date().toISOString() })); }
      if (f.startsWith("leg_")) { const key = f.replace(/\.json$/, ""); appendEvent(a.eventsPath, makeEvent({ orchestrationId: a.orchestrationId, runId: a.runId, producer: "conduct-hook" }, "leg.end", { legId: key.slice(4), outcome: "interrupted", usageSource: "unknown" })); }
      unlinkSync(full);
    }
  }
} else if (cmd === "reseed") {
  const a = activation();
  const from = opt("from"); if (!from) fail("usage: reseed --from <events.ndjson>");
  for (const e of readEvents(from).events) {
    const { schemaVersion, eventId, ts, orchestrationId, runId, type, producer, ...payload } = e;
    appendEvent(a.eventsPath, makeEvent({ orchestrationId: a.orchestrationId, runId: a.runId, producer: producer ?? "conduct-operator" }, type, payload));
  }
} else {
  fail("usage: conduct-events.mjs register|emit|hook|end|rotate|unlock|reseed ...");
}
