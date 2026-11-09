import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCodexSpans } from "./spans-codex.mjs";

const fixture = readFileSync(new URL("./fixtures/codex-exec-tools.jsonl", import.meta.url), "utf8");

function lineAt(text, offset) {
  return Buffer.from(text, "utf8").subarray(offset).toString("utf8").split("\n", 1)[0].replace(/\r$/, "");
}

test("fixture parses to the expected item ids in file order", () => {
  const entries = parseCodexSpans(fixture);
  assert.deepEqual(entries.map((e) => e.itemId), ["item_2", "item_3", "item_5", "item_16"]);
});

test("byteOffset points at the completed line for each entry", () => {
  for (const entry of parseCodexSpans(fixture)) {
    const parsed = JSON.parse(lineAt(fixture, entry.byteOffset));
    assert.equal(parsed.item.id, entry.itemId);
    assert.equal(parsed.type, "item.completed");
  }
});

test("status follows exit_code and file_change status", () => {
  const byId = new Map(parseCodexSpans(fixture).map((e) => [e.itemId, e]));
  assert.equal(byId.get("item_2").status, "ok");
  assert.equal(byId.get("item_3").status, "ok");
  assert.equal(byId.get("item_5").status, "error");
  assert.equal(byId.get("item_16").status, "ok");
});

test("labels are capped at 120 chars and never carry aggregated_output", () => {
  for (const entry of parseCodexSpans(fixture)) {
    assert.ok(entry.label.length <= 120);
    assert.equal(entry.label.includes("aggregated_output"), false);
  }
});

test("file_change label is '<kind> <path>' with a (+N) suffix for extra changes", () => {
  const fileEntry = parseCodexSpans(fixture).find((e) => e.itemId === "item_16");
  assert.match(fileEntry.label, /^add .*gate-p2-0a-satisfiability\.md \(\+1\)$/);
});

test("an item.started with no item.completed is interrupted, offset at the started line", () => {
  const record = (type, item) => JSON.stringify({ type, item });
  const text = record("item.started", { id: "cmd-only", type: "command_execution", command: "sleep 10", status: "in_progress" }) + "\n"
    + record("turn.completed", { usage: { input_tokens: 1, output_tokens: 1 } }) + "\n";
  const [entry] = parseCodexSpans(text);
  assert.equal(entry.status, "interrupted");
  assert.equal(JSON.parse(lineAt(text, entry.byteOffset)).type, "item.started");
});

test("a BOM and a leading non-JSON stderr line do not shift later offsets", () => {
  const record = (type, item) => JSON.stringify({ type, item });
  const body = record("item.started", { id: "cmd-a", type: "command_execution", command: "echo hi", status: "in_progress" }) + "\n"
    + record("item.completed", { id: "cmd-a", type: "command_execution", command: "echo hi", exit_code: 0, status: "completed" }) + "\n";
  const withPreamble = "\uFEFFstderr: noise\n" + body;
  const [entry] = parseCodexSpans(withPreamble);
  assert.equal(JSON.parse(lineAt(withPreamble, entry.byteOffset)).item.id, "cmd-a");
});

test("a BOM directly before the first JSON record does not drop it", () => {
  const record = (type, item) => JSON.stringify({ type, item });
  const text = "\uFEFF" + record("item.started", { id: "cmd-bom", type: "command_execution", command: "echo hi", status: "in_progress" }) + "\n"
    + record("item.completed", { id: "cmd-bom", type: "command_execution", command: "echo hi", exit_code: 0, status: "completed" }) + "\n";
  const entries = parseCodexSpans(text);
  assert.deepEqual(entries.map((e) => e.itemId), ["cmd-bom"]);
  assert.equal(entries[0].status, "ok");
  assert.equal(JSON.parse(lineAt(text, entries[0].byteOffset)).item.id, "cmd-bom");
});

test("a repeated item.started for an already completed id opens a new entry", () => {
  const record = (type, item) => JSON.stringify({ type, item });
  const text = [
    record("item.started", { id: "dup-1", type: "command_execution", command: "run 1", status: "in_progress" }),
    record("item.completed", { id: "dup-1", type: "command_execution", command: "run 1", exit_code: 0, status: "completed" }),
    record("item.started", { id: "dup-1", type: "command_execution", command: "run 2", status: "in_progress" }),
    record("item.completed", { id: "dup-1", type: "command_execution", command: "run 2", exit_code: 1, status: "completed" }),
  ].join("\n") + "\n";
  const entries = parseCodexSpans(text);
  assert.deepEqual(entries.map((e) => e.itemId), ["dup-1", "dup-1"]);
  assert.equal(entries[0].status, "ok");
  assert.equal(entries[0].label, "run 1");
  assert.equal(entries[1].status, "error");
  assert.equal(entries[1].label, "run 2");
});

test("agent_message, reasoning and error items are not spans", () => {
  const record = (type, item) => JSON.stringify({ type, item });
  const text = [
    record("item.completed", { id: "a1", type: "agent_message", text: "hi" }),
    record("item.completed", { id: "r1", type: "reasoning", text: "thinking" }),
    record("item.completed", { id: "e1", type: "error", message: "oops" }),
  ].join("\n") + "\n";
  assert.deepEqual(parseCodexSpans(text), []);
});

test("empty or garbage text yields no entries", () => {
  assert.deepEqual(parseCodexSpans(""), []);
  assert.deepEqual(parseCodexSpans("not json\nalso not json"), []);
});

test("an unknown item type is tool-like, using its type as the tool name and label", () => {
  const record = (type, item) => JSON.stringify({ type, item });
  const text = record("item.completed", { id: "mcp-1", type: "mcp_tool_call", status: "completed" }) + "\n";
  const [entry] = parseCodexSpans(text);
  assert.equal(entry.toolName, "mcp_tool_call");
  assert.equal(entry.label, "mcp_tool_call");
});
