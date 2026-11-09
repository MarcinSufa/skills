import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTranscriptUsage } from "./usage-transcript.mjs";

const fixture = readFileSync(new URL("./fixtures/subagent-transcript.jsonl", import.meta.url), "utf8");

test("sums usage across assistant turns in the fixture", () => {
  const u = parseTranscriptUsage(fixture);
  assert.ok(u && Number.isInteger(u.input) && Number.isInteger(u.output));
  assert.ok(u.input > 0 && u.output > 0);
});
test("garbage and empty give null", () => {
  assert.equal(parseTranscriptUsage("garbage"), null);
  assert.equal(parseTranscriptUsage(""), null);
});

test("a partially written transcript gives null instead of an undercount", () => {
  const firstHalf = fixture.split("\n").slice(0, Math.floor(fixture.split("\n").length / 2)).join("\n") + "\npartial";
  assert.equal(parseTranscriptUsage(firstHalf), null);
});
test("a transcript with no usage fields gives null, not zero", () => {
  assert.equal(parseTranscriptUsage('{"type":"assistant","message":{"role":"assistant"}}\n'), null);
});
test("keeps only the highest API block for each request", () => {
  const text = [
    JSON.stringify({ type: "assistant", requestId: "req-1", apiBlockIndex: 0, message: { usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } } }),
    JSON.stringify({ type: "assistant", requestId: "req-1", apiBlockIndex: 1, message: { usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } } }),
    JSON.stringify({ type: "assistant", requestId: "req-2", apiBlockIndex: 0, message: { usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 1, output_tokens: 2 } } }),
  ].join("\n");
  assert.deepEqual(parseTranscriptUsage(text), { input: 21, output: 6 });
});
