import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, readEvents, writeRegistry, readRegistry, writeActivation, resolveActivation, scratchPut, scratchTake, touchHeartbeat, recordHookActivity } from "./events-store.mjs";
import { makeEvent } from "./events-schema.mjs";

let home, repo;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "conduct-home-")); repo = mkdtempSync(path.join(tmpdir(), "repo-")); process.env.CONDUCT_HOME = home; });
const base = { orchestrationId: "conduct-s-abcd1234", runId: "s-1", producer: "conduct-hook" };

test("append keeps a pre-seeded sentinel and validates", () => {
  const f = path.join(repo, "events.ndjson");
  writeFileSync(f, '{"sentinel":true}\n');
  appendEvent(f, makeEvent(base, "heartbeat", {}));
  assert.throws(() => appendEvent(f, { ...makeEvent(base, "heartbeat", {}), runId: "" }), /runId: required/);
  const lines = readFileSync(f, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '{"sentinel":true}');
});

test("readEvents dedupes on eventId and reports skipped lines", () => {
  const f = path.join(repo, "events.ndjson");
  const e = makeEvent(base, "heartbeat", {});
  writeFileSync(f, JSON.stringify(e) + "\n" + JSON.stringify(e) + "\nnot json\n");
  const r = readEvents(f);
  assert.equal(r.events.length, 1);
  assert.equal(r.skipped.length, 1);
});

test("registry and activation round trip; session map wins over cwd", () => {
  writeRegistry("conduct-s-abcd1234", { id: "conduct-s-abcd1234", kind: "conduct", runId: "s-1", eventsPath: path.join(repo, ".conduct/events.ndjson"), pid: 1, startedAt: "2026-09-04T00:00:00Z" });
  assert.equal(readRegistry("conduct-s-abcd1234").kind, "conduct");
  writeActivation("sess-1", "conduct-s-abcd1234");
  assert.deepEqual(resolveActivation({ sessionId: "sess-1", cwd: "C:/nowhere" }), { orchestrationId: "conduct-s-abcd1234", runId: "s-1", eventsPath: path.join(repo, ".conduct/events.ndjson") });
  assert.equal(resolveActivation({ sessionId: "sess-2", cwd: "C:/nowhere" }), null);
});

test("cwd fallback finds .conduct/orchestration.json only without a session id", () => {
  mkdirSync(path.join(repo, ".conduct"), { recursive: true });
  writeFileSync(path.join(repo, ".conduct/orchestration.json"), JSON.stringify({ orchestrationId: "conduct-s-abcd1234", runId: "s-1" }));
  writeRegistry("conduct-s-abcd1234", { id: "conduct-s-abcd1234", kind: "conduct", runId: "s-1", eventsPath: path.join(repo, ".conduct/events.ndjson"), pid: 1, startedAt: "x" });
  const deep = path.join(repo, "a/b"); mkdirSync(deep, { recursive: true });
  assert.equal(resolveActivation({ sessionId: undefined, cwd: deep }).orchestrationId, "conduct-s-abcd1234");
  assert.equal(resolveActivation({ sessionId: "none", cwd: deep }).orchestrationId, "conduct-s-abcd1234");
  assert.equal(resolveActivation({ sessionId: "none", cwd: deep, allowCwdFallback: false }), null);
});

test("ended registry records cannot be resolved by session or cwd", () => {
  mkdirSync(path.join(repo, ".conduct"), { recursive: true });
  writeFileSync(path.join(repo, ".conduct/orchestration.json"), JSON.stringify({ orchestrationId: "conduct-s-abcd1234", runId: "s-1" }));
  writeRegistry("conduct-s-abcd1234", { id: "conduct-s-abcd1234", runId: "s-1", eventsPath: path.join(repo, ".conduct/events.ndjson"), endedAt: "2026-09-04T00:00:00Z" });
  writeActivation("sess-1", "conduct-s-abcd1234");
  assert.equal(resolveActivation({ sessionId: "sess-1", cwd: repo }), null);
  assert.equal(resolveActivation({ sessionId: undefined, cwd: repo }), null);
});

test("a session activated for another orchestration cannot use cwd fallback", () => {
  mkdirSync(path.join(repo, ".conduct"), { recursive: true });
  writeFileSync(path.join(repo, ".conduct/orchestration.json"), JSON.stringify({ orchestrationId: "conduct-s-abcd1234", runId: "s-1" }));
  writeRegistry("conduct-s-abcd1234", { id: "conduct-s-abcd1234", runId: "s-1", eventsPath: path.join(repo, ".conduct/events.ndjson") });
  writeRegistry("conduct-other-12345678", { id: "conduct-other-12345678", runId: "other-1", eventsPath: path.join(repo, "other.ndjson") });
  writeActivation("sess-1", "conduct-other-12345678");
  assert.equal(resolveActivation({ sessionId: "sess-1", cwd: repo }).orchestrationId, "conduct-other-12345678");
});

const HB_ID = "conduct-s-abcd1234";
const T0 = Date.parse("2026-09-04T00:00:00Z");
const recordFile = () => path.join(home, "registry", `${HB_ID}.json`);
const heartbeatFile = () => path.join(home, "registry", `${HB_ID}.heartbeat.json`);
const seedRecord = (extra = {}) => writeRegistry(HB_ID, { id: HB_ID, kind: "conduct", runId: "s-1", eventsPath: path.join(repo, ".conduct/events.ndjson"), startedAt: "2026-09-04T00:00:00Z", heartbeatAt: "2026-09-04T00:00:00Z", ...extra });
function countingWriter() {
  const calls = [];
  const write = (file, obj) => { calls.push(file); writeFileSync(file, JSON.stringify(obj)); };
  return { calls, write };
}

test("touchHeartbeat writes heartbeatAt to the sibling heartbeat file and never rewrites the registry record", () => {
  seedRecord();
  const recordBefore = readFileSync(recordFile(), "utf8");
  touchHeartbeat(HB_ID, { now: T0 + 60_000 });
  assert.deepEqual(JSON.parse(readFileSync(heartbeatFile(), "utf8")), { heartbeatAt: new Date(T0 + 60_000).toISOString() });
  assert.equal(readFileSync(recordFile(), "utf8"), recordBefore);
  assert.deepEqual(readdirSync(path.join(home, "registry")).filter((name) => name.endsWith(".tmp")), []);
});

test("touchHeartbeat coalesces sequential heartbeat file writes to one per 5 seconds, counted by writes (best-effort under concurrency, no CAS)", () => {
  seedRecord();
  const { calls, write } = countingWriter();
  touchHeartbeat(HB_ID, { now: T0, write });
  touchHeartbeat(HB_ID, { now: T0 + 1_000, write });
  touchHeartbeat(HB_ID, { now: T0 + 4_999, write });
  assert.equal(calls.length, 1);
  touchHeartbeat(HB_ID, { now: T0 + 5_000, write });
  assert.deepEqual(calls, [heartbeatFile(), heartbeatFile()]);
});

test("a heartbeat file stamped in the future does not suppress the refresh", () => {
  seedRecord();
  writeFileSync(heartbeatFile(), JSON.stringify({ heartbeatAt: new Date(T0 + 60_000).toISOString() }));
  const { calls, write } = countingWriter();
  touchHeartbeat(HB_ID, { now: T0, write });
  assert.equal(calls.length, 1);
});

test("an end written between touchHeartbeat's read and its write survives unchanged", () => {
  seedRecord();
  let endedRecord = null;
  const write = (file, obj) => {
    writeRegistry(HB_ID, { ...readRegistry(HB_ID), endedAt: "2026-09-04T00:02:00.000Z", terminal: "closed" });
    endedRecord = readFileSync(recordFile(), "utf8");
    writeFileSync(file, JSON.stringify(obj));
  };
  touchHeartbeat(HB_ID, { now: T0 + 60_000, write });
  assert.ok(endedRecord, "the barrier between read and write must run");
  assert.equal(readFileSync(recordFile(), "utf8"), endedRecord);
  assert.equal(readRegistry(HB_ID).endedAt, "2026-09-04T00:02:00.000Z");
});

test("touchHeartbeat after end writes nothing and leaves the ended record byte-identical", () => {
  seedRecord({ endedAt: "2026-09-04T00:02:00.000Z", terminal: "closed" });
  const recordBefore = readFileSync(recordFile(), "utf8");
  const { calls, write } = countingWriter();
  touchHeartbeat(HB_ID, { now: T0 + 60_000, write });
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(recordFile(), "utf8"), recordBefore);
});

test("SessionEnd writes the abandoned tombstone even when the heartbeat write fails", () => {
  seedRecord();
  const failingWrite = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  const errors = [];
  recordHookActivity(HB_ID, { appended: true, abandoned: true, heartbeat: (id) => touchHeartbeat(id, { now: T0 + 60_000, write: failingWrite }), onHeartbeatError: (err) => errors.push(err) });
  const rec = readRegistry(HB_ID);
  assert.ok(rec.endedAt);
  assert.equal(rec.terminal, "abandoned");
});

test("a heartbeat failure on an ordinary hook event is reported, not thrown", () => {
  seedRecord();
  const errors = [];
  recordHookActivity(HB_ID, { appended: true, abandoned: false, heartbeat: () => { throw new Error("disk full"); }, onHeartbeatError: (err) => errors.push(err) });
  assert.equal(errors.length, 1);
  assert.equal(readRegistry(HB_ID).endedAt, undefined);
});

test("touchHeartbeat on a missing record is a no-op", () => {
  const { calls, write } = countingWriter();
  touchHeartbeat("conduct-does-not-exist", { now: T0, write });
  assert.equal(calls.length, 0);
  assert.equal(readRegistry("conduct-does-not-exist"), null);
});

test("scratch put and take is single-shot", () => {
  scratchPut("o1", "toolu_1", { legId: "l1", tsStart: "t" });
  assert.deepEqual(scratchTake("o1", "toolu_1"), { legId: "l1", tsStart: "t" });
  assert.equal(scratchTake("o1", "toolu_1"), null);
});
