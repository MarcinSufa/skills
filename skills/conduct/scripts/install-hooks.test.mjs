import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = new URL("./install-hooks.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: "utf8" });

test("install is idempotent and preserves existing hooks; uninstall removes only ours", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "settings-"));
  const f = path.join(dir, "settings.json");
  writeFileSync(f, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node other.mjs" }] }] }, permissions: { allow: ["Bash(node:*)"] } }));
  assert.equal(run("--settings", f, "--scripts-dir", "C:/s").status, 0);
  const once = readFileSync(f, "utf8");
  assert.equal(run("--settings", f, "--scripts-dir", "C:/s").status, 0);
  assert.equal(readFileSync(f, "utf8"), once);
  const s = JSON.parse(once);
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.PreToolUse[0].matcher, ".*");
  assert.deepEqual(Object.keys(s.hooks).sort(), ["PostToolUse", "PreToolUse", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"]);
  assert.deepEqual(s.permissions.allow, ["Bash(node:*)"]);
  assert.equal(run("--settings", f, "--scripts-dir", "C:/s", "--uninstall").status, 0);
  const after = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(after.hooks.Stop.length, 1);
  assert.equal(after.hooks.PreToolUse, undefined);
});
