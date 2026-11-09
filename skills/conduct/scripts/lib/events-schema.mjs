import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 1;
export const PRODUCERS = ["loop-runner", "conduct-hook", "conduct-operator"];
export const USAGE_SOURCES = ["reported", "transcript", "estimated", "no_spend", "unknown"];
export const OUTCOMES = ["ok", "error", "needs_input", "interrupted", "unknown"];
export const MAX_LINE_BYTES = 4096;

const req = (...names) => (p, errors) => { for (const n of names) if (p[n] === undefined || p[n] === null) errors.push(`${n}: required`); };
const oneOf = (name, values) => (p, errors) => { if (p[name] !== undefined && !values.includes(p[name])) errors.push(`${name}: must be one of ${values.join("|")}`); };

export const PAYLOAD_RULES = {
  "orch.start": [req("kind", "goal", "vaultRefs", "cwd", "pid"), oneOf("kind", ["loop-runner", "conduct"])],
  "orch.state": [req("state"), oneOf("state", ["active", "needs_input", "stale", "finished"])],
  "orch.end": [req("terminal")],
  "task.meta": [req("taskId")],
  "task.phase": [req("taskId", "phase", "attempt")],
  "task.donewhen": [req("taskId", "attempt", "results")],
  "leg.start": [req("legId", "taskId", "attempt", "gen_ai.agent.name", "gen_ai.request.model", "role")],
  "leg.end": [req("legId", "outcome", "usageSource"), oneOf("outcome", OUTCOMES), oneOf("usageSource", USAGE_SOURCES), (p, e) => {
    const both = Number.isInteger(p["gen_ai.usage.input_tokens"]) && Number.isInteger(p["gen_ai.usage.output_tokens"]);
    if (p.usageSource === "transcript" && !both) e.push("usageSource transcript requires both token counts");
    if (p.usageSource === "reported" && !both) e.push("usageSource reported requires both token counts");
  }],
  "leg.annotate": [req("legId", "phase")],
  "review.verdict": [req("taskId", "attempt", "verdict"), oneOf("verdict", ["APPROVE", "REJECT"])],
  "span": [req("legId", "spanId", "toolUseId", "gen_ai.operation.name", "gen_ai.tool.name", "status", "tsStart"), oneOf("status", OUTCOMES)],
  "decision.recorded": [req("memoryId", "phase")],
  "heartbeat": [],
};
export const EVENT_TYPES = Object.keys(PAYLOAD_RULES);

export function validateEvent(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["event: must be an object"] };
  if (obj.schemaVersion !== SCHEMA_VERSION) errors.push("schemaVersion: must be 1");
  for (const f of ["eventId", "ts", "orchestrationId", "runId", "type", "producer"]) if (typeof obj[f] !== "string" || obj[f] === "") errors.push(`${f}: required`);
  if (typeof obj.ts === "string" && Number.isNaN(Date.parse(obj.ts))) errors.push("ts: not ISO 8601");
  if (!PRODUCERS.includes(obj.producer)) errors.push("producer: unknown");
  const rules = PAYLOAD_RULES[obj.type];
  if (!rules) errors.push(`type: unknown ${String(obj.type)}`);
  else for (const rule of rules) rule(obj, errors);
  if (Buffer.byteLength(JSON.stringify(obj), "utf8") > MAX_LINE_BYTES) errors.push(`line: exceeds ${MAX_LINE_BYTES} bytes`);
  return { ok: errors.length === 0, errors };
}

export function makeEvent(base, type, payload) {
  return { ...payload, ...base, schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), ts: new Date().toISOString(), type };
}
