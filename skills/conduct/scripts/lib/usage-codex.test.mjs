import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCodexUsage } from "./usage-codex.mjs";

const fixture = readFileSync(new URL("./fixtures/codex-exec.jsonl", import.meta.url), "utf8");

test("reads usage from the fixture's final usage event", () => {
  const u = parseCodexUsage(fixture);
  assert.ok(u && u.input > 0 && Number.isInteger(u.output));
});
test("missing usage gives null", () => {
  assert.equal(parseCodexUsage('{"type":"thread.started","thread_id":"x"}\n'), null);
  assert.equal(parseCodexUsage("nope"), null);
});

test("sums completed turns without adding cached input", () => {
  assert.deepEqual(parseCodexUsage([
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 3, output_tokens: 1 } }),
  ].join("\n")), { input: 15, output: 3 });
});
