import { openSync, writeSync, closeSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateEvent } from "./events-schema.mjs";

export const homeRoot = () => process.env.CONDUCT_HOME ?? path.join(os.homedir(), ".conduct-events");
const ensure = (dir) => { mkdirSync(dir, { recursive: true }); return dir; };

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "ENOENT"]);
const RENAME_DEADLINE_MS = 2_000;
function renameWithRetry(tmp, file) {
  const deadline = performance.now() + RENAME_DEADLINE_MS;
  for (let attempt = 1; ; attempt++) {
    try { renameSync(tmp, file); return; }
    catch (err) {
      if (!RENAME_RETRY_CODES.has(err.code) || performance.now() >= deadline) { rmSync(tmp, { force: true }); throw err; }
      sleepSync(Math.min(attempt * 5, 50));
    }
  }
}
const atomicWriteJson = (file, obj) => { ensure(path.dirname(file)); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(obj, null, 2)); renameWithRetry(tmp, file); };
// No existsSync pre-check: `end` unlinks the session activation file, so a concurrent reader can see
// it exist and then hit ENOENT on the read. A missing file is "no record", never a crash.
function readJson(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  return JSON.parse(text);
}

export function appendEvent(filePath, event) {
  const v = validateEvent(event);
  if (!v.ok) throw new Error(v.errors.join("; "));
  ensure(path.dirname(filePath));
  const fd = openSync(filePath, "a");
  try { writeSync(fd, JSON.stringify(event) + "\n"); } finally { closeSync(fd); }
}

export function readEvents(filePath) {
  const events = [], skipped = [], seen = new Set();
  if (!existsSync(filePath)) return { events, skipped };
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let obj; try { obj = JSON.parse(line); } catch { skipped.push(line); continue; }
    if (!validateEvent(obj).ok) { skipped.push(line); continue; }
    if (seen.has(obj.eventId)) continue;
    seen.add(obj.eventId); events.push(obj);
  }
  return { events, skipped };
}

const registryFile = (id) => path.join(homeRoot(), "registry", `${id}.json`);
export const writeRegistry = (id, record) => atomicWriteJson(registryFile(id), record);
export const readRegistry = (id) => readJson(registryFile(id));

const heartbeatFile = (id) => path.join(homeRoot(), "registry", `${id}.heartbeat.json`);
function lastHeartbeatMs(id) {
  try { return Date.parse(readJson(heartbeatFile(id))?.heartbeatAt); } catch { return Number.NaN; }
}
const HEARTBEAT_COALESCE_MS = 5_000;
export function touchHeartbeat(id, { now = Date.now(), write = atomicWriteJson } = {}) {
  const rec = readRegistry(id);
  if (!rec || rec.endedAt !== undefined) return;
  const age = now - lastHeartbeatMs(id);
  if (age >= 0 && age < HEARTBEAT_COALESCE_MS) return;
  write(heartbeatFile(id), { heartbeatAt: new Date(now).toISOString() });
}

export function recordHookActivity(id, { appended, abandoned, heartbeat = touchHeartbeat, onHeartbeatError }) {
  if (abandoned) writeRegistry(id, { ...readRegistry(id), endedAt: new Date().toISOString(), terminal: "abandoned" });
  if (!appended) return;
  try { heartbeat(id); } catch (err) { onHeartbeatError(err); }
}

const activationFile = (sessionId) => path.join(homeRoot(), "sessions", `${sessionId}.json`);
export const writeActivation = (sessionId, orchestrationId) => atomicWriteJson(activationFile(sessionId), { orchestrationId });

function nearestOrchestrationJson(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const f = path.join(dir, ".conduct", "orchestration.json");
    if (existsSync(f)) return readJson(f);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveActivation({ sessionId, cwd, allowCwdFallback = true }) {
  const bySession = sessionId ? readJson(activationFile(sessionId)) : null;
  const orchestrationId = bySession?.orchestrationId ?? (allowCwdFallback && cwd ? nearestOrchestrationJson(cwd)?.orchestrationId : null);
  if (!orchestrationId) return null;
  const rec = readRegistry(orchestrationId);
  if (!rec || rec.endedAt) return null;
  return { orchestrationId, runId: rec.runId, eventsPath: rec.eventsPath };
}

const scratchFile = (o, key) => path.join(homeRoot(), "scratch", o, `${key.replace(/[^\w.-]/g, "_")}.json`);
export const scratchPut = (o, key, obj) => atomicWriteJson(scratchFile(o, key), obj);
export function scratchTake(o, key) { const f = scratchFile(o, key); const v = readJson(f); if (v) unlinkSync(f); return v; }
