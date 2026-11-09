import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = new URL("./conduct-events.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
let home, repo, env;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "conduct-home-")); repo = mkdtempSync(path.join(tmpdir(), "repo-")); mkdirSync(path.join(repo, ".conduct")); env = { ...process.env, CONDUCT_HOME: home }; });
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { env, input, encoding: "utf8" });
function runAsync(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (v) => { stdout += v; });
    child.stderr.on("data", (v) => { stderr += v; });
    child.on("error", reject);
    child.on("close", (status) => (status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout || `exit ${status}`))));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
const events = () => readFileSync(path.join(repo, ".conduct/events.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("register writes registry, activation, orchestration.json and orch.start", () => {
  const r = run(["register", "--slice", "demo", "--session", "sess-1", "--repo", repo, "--vault", "vault-1"]);
  assert.equal(r.status, 0, r.stderr);
  const ids = JSON.parse(r.stdout);
  assert.match(ids.orchestrationId, /^conduct-demo-[0-9a-f]{8}$/);
  assert.equal(ids.runId, "demo-1");
  assert.ok(existsSync(path.join(home, "registry", `${ids.orchestrationId}.json`)));
  assert.ok(existsSync(path.join(home, "sessions", "sess-1.json")));
  assert.equal(events()[0].type, "orch.start");
  assert.equal(events()[0].vaultRefs.vaultId, "vault-1");
});

const registerDemo = () => JSON.parse(run(["register", "--slice", "demo", "--session", "sess-1", "--repo", repo, "--vault", "v"]).stdout);
const recordPath = (id) => path.join(home, "registry", `${id}.json`);
const heartbeatPath = (id) => path.join(home, "registry", `${id}.heartbeat.json`);
const heartbeatOf = (id) => Date.parse(JSON.parse(readFileSync(heartbeatPath(id), "utf8")).heartbeatAt);
const AGED = "2026-01-01T00:00:00.000Z";
const ageHeartbeat = (id) => writeFileSync(heartbeatPath(id), JSON.stringify({ heartbeatAt: AGED }));

test("register omits pid and writes a fresh heartbeatAt to the record and the heartbeat file", () => {
  const before = Date.now();
  const ids = registerDemo();
  const rec = JSON.parse(readFileSync(recordPath(ids.orchestrationId), "utf8"));
  assert.equal(Object.hasOwn(rec, "pid"), false);
  assert.ok(Date.parse(rec.heartbeatAt) >= before);
  assert.ok(heartbeatOf(ids.orchestrationId) >= before);
});

test("a hook event that reaches the store refreshes the heartbeat file", () => {
  const ids = registerDemo();
  ageHeartbeat(ids.orchestrationId);
  const r = run(["hook"], JSON.stringify({ hook_event_name: "Stop", session_id: "sess-1", cwd: repo }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(heartbeatOf(ids.orchestrationId) > Date.parse(AGED));
});

test("emit refreshes the heartbeat file", () => {
  const ids = registerDemo();
  ageHeartbeat(ids.orchestrationId);
  const f = path.join(repo, "hb.json"); writeFileSync(f, JSON.stringify({}));
  assert.equal(run(["emit", "--type", "heartbeat", "--payload-file", f, "--session", "sess-1"]).status, 0);
  assert.ok(heartbeatOf(ids.orchestrationId) > Date.parse(AGED));
});

test("hook and emit never rewrite the registry record", () => {
  const ids = registerDemo();
  const recordBefore = readFileSync(recordPath(ids.orchestrationId), "utf8");
  ageHeartbeat(ids.orchestrationId);
  assert.equal(run(["hook"], JSON.stringify({ hook_event_name: "Stop", session_id: "sess-1", cwd: repo })).status, 0);
  ageHeartbeat(ids.orchestrationId);
  const f = path.join(repo, "hb.json"); writeFileSync(f, JSON.stringify({}));
  assert.equal(run(["emit", "--type", "heartbeat", "--payload-file", f, "--session", "sess-1"]).status, 0);
  assert.equal(readFileSync(recordPath(ids.orchestrationId), "utf8"), recordBefore);
});

test("a concurrent emit and end never lose the endedAt write", async () => {
  const ids = registerDemo();
  const f = path.join(repo, "hb.json"); writeFileSync(f, JSON.stringify({}));
  const emits = Array.from({ length: 10 }, () => runAsync(["emit", "--type", "heartbeat", "--payload-file", f, "--session", "sess-1"]));
  const end = runAsync(["end", "--terminal", "closed", "--session", "sess-1"]);
  // An emit that resolves its activation after `end` has written endedAt (or removed the session
  // file) is refused by design; which emits land first is scheduling, not something to assert.
  // Any other failure (a crash, a torn read) still fails the test.
  const results = await Promise.allSettled(emits);
  await end;
  for (const r of results) if (r.status === "rejected") assert.match(r.reason.message, /^no active orchestration for this session or cwd/);
  const rec = JSON.parse(readFileSync(recordPath(ids.orchestrationId), "utf8"));
  assert.ok(rec.endedAt, "endedAt must survive concurrent heartbeat writes");
  assert.equal(rec.terminal, "closed");
});

test("20 concurrent emits never expose a half-written heartbeat file and leave no temp files", async () => {
  const ids = registerDemo();
  ageHeartbeat(ids.orchestrationId);
  const f = path.join(repo, "hb.json"); writeFileSync(f, JSON.stringify({}));
  let torn = false;
  const poll = setInterval(() => { try { JSON.parse(readFileSync(heartbeatPath(ids.orchestrationId), "utf8")); } catch { torn = true; } }, 1);
  await Promise.all(Array.from({ length: 20 }, () => runAsync(["emit", "--type", "heartbeat", "--payload-file", f, "--session", "sess-1"])));
  clearInterval(poll);
  assert.equal(torn, false);
  assert.ok(heartbeatOf(ids.orchestrationId) > Date.parse(AGED));
  assert.deepEqual(readdirSync(path.join(home, "registry")).filter((name) => name.endsWith(".tmp")), []);
});

test("register twice on the same session bumps the run (resume)", () => {
  run(["register", "--slice", "demo", "--session", "sess-1", "--repo", repo, "--vault", "v"]);
  const r = run(["register", "--slice", "demo", "--session", "sess-1", "--repo", repo, "--vault", "v"]);
  assert.equal(JSON.parse(r.stdout).runId, "demo-2");
});

test("register rejects a missing value instead of swallowing the next flag", () => {
  const r = run(["register", "--slice", "demo", "--session", "--repo", repo, "--vault", "v"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /usage: register/);
  assert.equal(existsSync(path.join(home, "sessions", "--repo.json")), false);
});

test("emit validates and appends with producer conduct-operator", () => {
  run(["register", "--slice", "demo", "--session", "sess-1", "--repo", repo, "--vault", "v"]);
  const f = path.join(repo, "p.json"); writeFileSync(f, JSON.stringify({ memoryId: "m1", phase: "fusion" }));
  assert.equal(run(["emit", "--type", "decision.recorded", "--payload-file", f, "--session", "sess-1"]).status, 0);
  const last = events().at(-1);
  assert.equal(last.type, "decision.recorded"); assert.equal(last.producer, "conduct-operator");
  const bad = run(["emit", "--type", "leg.end", "--payload-file", f, "--session", "sess-1"]);
  assert.equal(bad.status, 2); assert.match(bad.stdout + bad.stderr, /legId: required/);
});

test("hook: Agent PreToolUse then PostToolUse produce a matched leg pair", () => {
  run(["register", "--slice", "demo", "--session", "sess-1", "--repo", repo, "--vault", "v"]);
  const pre = { hook_event_name: "PreToolUse", session_id: "sess-1", cwd: repo, tool_name: "Agent", tool_use_id: "toolu_1", tool_input: { prompt: "conduct.role: worker\nx", model: "sonnet" } };
  assert.equal(run(["hook"], JSON.stringify(pre)).status, 0);
  const post = { ...pre, hook_event_name: "PostToolUse", tool_response: {} };
  assert.equal(run(["hook"], JSON.stringify(post)).status, 0);
  const legs = events().filter((e) => e.type.startsWith("leg."));
  assert.deepEqual(legs.map((e) => e.type), ["leg.start", "leg.end"]);
  assert.equal(legs[0].legId, legs[1].legId);
  assert.equal(legs[1].usageSource, "unknown");
});

test("hook: a session without activation writes nothing and exits 0", () => {
  const pre = { hook_event_name: "PreToolUse", session_id: "stranger", cwd: tmpdir(), tool_name: "Agent", tool_use_id: "toolu_9", tool_input: {} };
  const r = run(["hook"], JSON.stringify(pre));
  assert.equal(r.status, 0);
  assert.equal(existsSync(path.join(repo, ".conduct/events.ndjson")), false);
});

test("hook: malformed stdin exits 0 and logs", () => {
  const r = run(["hook"], "{not json");
  assert.equal(r.status, 0);
  assert.ok(existsSync(path.join(home, "hook-errors.log")));
});

test("hook: a logging failure still exits 0", () => {
  const unwritableHome = path.join(home, "not-a-directory");
  writeFileSync(unwritableHome, "file");
  const r = spawnSync(process.execPath, [cli, "hook"], { env: { ...env, CONDUCT_HOME: unwritableHome }, input: "{not json", encoding: "utf8" });
  assert.equal(r.status, 0);
});

test("end writes orch.end and a tombstone and removes activation", () => {
  const ids = JSON.parse(run(["register", "--slice", "demo", "--session", "sess-1", "--repo", repo, "--vault", "v"]).stdout);
  assert.equal(run(["end", "--terminal", "closed", "--session", "sess-1"]).status, 0);
  assert.equal(events().at(-1).type, "orch.end");
  const rec = JSON.parse(readFileSync(path.join(home, "registry", `${ids.orchestrationId}.json`), "utf8"));
  assert.equal(rec.terminal, "closed"); assert.ok(rec.endedAt);
  assert.equal(existsSync(path.join(home, "sessions", "sess-1.json")), false);
});

test("reseed restamps events for the active orchestration", () => {
  run(["register", "--slice", "demo", "--session", "sess-1", "--repo", repo, "--vault", "v"]);
  const src = path.join(repo, "old.ndjson"); writeFileSync(src, readFileSync(path.join(repo, ".conduct/events.ndjson")));
  assert.equal(run(["reseed", "--from", src, "--session", "sess-1"]).status, 0);
  assert.equal(events().length, 2);
  assert.equal(new Set(events().map((e) => e.eventId)).size, 2);
  assert.ok(events().every((e) => e.orchestrationId === JSON.parse(readFileSync(path.join(home, "sessions", "sess-1.json"), "utf8")).orchestrationId));
});
