import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvent, makeEvent, EVENT_TYPES } from "./events-schema.mjs";

const base = { orchestrationId: "conduct-x-abcd1234", runId: "x-1", producer: "conduct-operator" };

test("makeEvent fills required envelope fields", () => {
  const e = makeEvent(base, "orch.start", { kind: "conduct", goal: "x", vaultRefs: { vaultId: "v" }, cwd: "C:/r", pid: 1 });
  assert.equal(e.schemaVersion, 1);
  assert.match(e.eventId, /^[0-9a-f-]{36}$/);
  assert.match(e.ts, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(validateEvent(e).ok, true);
});

test("makeEvent protects its envelope from payload fields", () => {
  const e = makeEvent(base, "heartbeat", { type: "spoof", runId: "wrong", orchestrationId: "wrong" });
  assert.equal(e.type, "heartbeat");
  assert.equal(e.runId, base.runId);
  assert.equal(e.orchestrationId, base.orchestrationId);
});

test("rejects unknown type and missing runId", () => {
  const e = makeEvent(base, "orch.start", { kind: "conduct", goal: "x", vaultRefs: { vaultId: "v" }, cwd: "C:/r", pid: 1 });
  assert.equal(validateEvent({ ...e, type: "nope" }).ok, false);
  const { runId, ...noRun } = e;
  assert.deepEqual(validateEvent(noRun).errors, ["runId: required"]);
});

test("leg.end usageSource transcript requires both token numbers", () => {
  const ok = makeEvent(base, "leg.end", { legId: "l1", outcome: "ok", "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 2, usageSource: "transcript" });
  assert.equal(validateEvent(ok).ok, true);
  const bad = makeEvent(base, "leg.end", { legId: "l1", outcome: "ok", "gen_ai.usage.input_tokens": 10, usageSource: "transcript" });
  assert.equal(validateEvent(bad).ok, false);
});

test("leg.start model defaults are not silently guessed", () => {
  const e = makeEvent(base, "leg.start", { legId: "l1", taskId: "opinion", attempt: 1, "gen_ai.agent.name": "claude", role: "unknown" });
  assert.equal(validateEvent(e).ok, false, "model is required (use the literal unknown)");
});

test("line size ceiling 4096 bytes", () => {
  const e = makeEvent(base, "leg.annotate", { legId: "l1", phase: "review", note: "x".repeat(5000) });
  assert.equal(validateEvent(e).ok, false);
});

test("every spec type is listed", () => {
  assert.equal(EVENT_TYPES.length, 13);
});
