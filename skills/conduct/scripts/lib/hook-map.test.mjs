import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mapHook } from "./hook-map.mjs";
import { validateEvent } from "./events-schema.mjs";
import { parseCodexSpans } from "./spans-codex.mjs";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const base = { orchestrationId: "conduct-s-abcd1234", runId: "s-1", producer: "conduct-hook" };
const ctx = (over = {}) => ({ base, now: () => "2026-09-04T10:00:00.000Z", scratch: () => null, readFile: () => null, parsers: { transcript: () => null, codex: () => null, codexSpans: () => [] }, orchEnded: false, currentTask: "implement", ...over });

function scratchRoundTrip(overrides = {}) {
  const scratch = new Map();
  const apply = (payload) => {
    const r = mapHook(payload, ctx({ scratch: (key) => scratch.get(key), ...overrides }));
    for (const key of r.scratchTakes) scratch.delete(key);
    for (const [key, value] of r.scratchPuts) scratch.set(key, value);
    return r;
  };
  return apply;
}

test("Agent PreToolUse becomes leg.start keyed by tool_use_id with role from prompt", () => {
  const p = fx("hook-agent-pretooluse.json");
  p.tool_input.prompt = "conduct.role: reviewer\n" + (p.tool_input.prompt ?? "");
  const r = mapHook(p, ctx());
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, "leg.start");
  assert.equal(r.events[0].legId, p.tool_use_id);
  assert.equal(r.events[0].role, "reviewer");
  assert.equal(r.events[0]["gen_ai.agent.name"], "claude");
  assert.deepEqual(r.scratchPuts[0][0], `leg:${p.tool_use_id}`);
});

test("model absent renders as the literal unknown", () => {
  const p = fx("hook-agent-pretooluse.json"); delete p.tool_input.model;
  assert.equal(mapHook(p, ctx()).events[0]["gen_ai.request.model"], "unknown");
});

test("codex Bash PreToolUse parses model and jsonl path", () => {
  const p = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_b1", session_id: "s", cwd: "C:/w", tool_input: { command: 'codex exec -m gpt-5.6-luna --json -o .conduct/luna-x.md "do it" < /dev/null > .conduct/luna-x.jsonl' } };
  const r = mapHook(p, ctx());
  assert.equal(r.events[0]["gen_ai.agent.name"], "openai");
  assert.equal(r.events[0]["gen_ai.request.model"], "gpt-5.6-luna");
  assert.equal(r.scratchPuts[0][1].jsonlPath, path.resolve("C:/w", ".conduct/luna-x.jsonl"));
});

test("task context and DeepSeek model determine leg identity", () => {
  const p = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_ds", tool_input: { command: "grok run -m deepseek-v4-pro > out.jsonl" } };
  const event = mapHook(p, ctx({ currentTask: "review", currentAttempt: 2 })).events[0];
  assert.equal(event.taskId, "review");
  assert.equal(event.attempt, 2);
  assert.equal(event["gen_ai.agent.name"], "deepseek");
});

test("dispatch parsing accepts wrappers, quoted redirects, and adjacent redirects", () => {
  for (const command of [
    'cd C:/work && codex exec --json > "C:/x.jsonl"',
    'npx codex exec --json >C:/x.jsonl',
  ]) {
    const p = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_dispatch", tool_input: { command } };
    const r = mapHook(p, ctx());
    assert.equal(r.events[0]["gen_ai.agent.name"], "openai");
    assert.equal(r.scratchPuts[0][1].jsonlPath, "C:/x.jsonl");
  }
});

test("dispatch parsing skips a stderr fd redirect ahead of the jsonl redirect", () => {
  const p = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_fd", tool_input: { command: "codex exec --json 2> x.stderr.txt > out.jsonl" } };
  const r = mapHook(p, ctx());
  assert.equal(r.scratchPuts[0][1].jsonlPath, "out.jsonl");
});

test("dispatch parsing does not read model flags inside a quoted prompt", () => {
  const p = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_prompt", tool_input: { command: 'codex exec --json "reply -m fast" > out.jsonl' } };
  assert.equal(mapHook(p, ctx()).events[0]["gen_ai.request.model"], "unknown");
});

test("Bash that is not a dispatch emits nothing", () => {
  const p = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_b2", tool_input: { command: "ls -la" } };
  assert.equal(mapHook(p, ctx()).events.length, 0);
});

test("codex PostToolUse ends the leg; usage unknown when jsonl missing", () => {
  const p = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_b1", tool_input: { command: "codex exec -m gpt-5.6-luna --json" }, tool_response: { exit_code: 0 } };
  const r = mapHook(p, ctx({ scratch: (k) => (k === "leg:toolu_b1" ? { legId: "toolu_b1", tsStart: "t", jsonlPath: "C:/none.jsonl" } : null) }));
  assert.equal(r.events[0].type, "leg.end");
  assert.equal(r.events[0].usageSource, "unknown");
  assert.equal(r.events[0]["gen_ai.usage.input_tokens"], undefined);
});

test("nested vendor dispatch ends the leg before span mapping", () => {
  const p = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_b1", agent_id: "agent-1", cwd: "C:/work", tool_response: { exit_code: 1 } };
  const r = mapHook(p, ctx({ scratch: (k) => k === "leg:toolu_b1" ? { legId: "toolu_b1", jsonlPath: ".conduct/x.jsonl" } : null }));
  assert.equal(r.events[0].type, "leg.end");
  assert.equal(r.events[0].outcome, "error");
});

test("missing tool response evidence is unknown", () => {
  const p = { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_a1", tool_response: {} };
  const r = mapHook(p, ctx({ scratch: (k) => k === "leg:toolu_a1" ? { legId: "toolu_a1" } : null }));
  assert.equal(r.events[0].outcome, "unknown");
});

test("invalid exit code values are no evidence, while numeric values retain precedence", () => {
  const cases = [
    [{ exit_code: null }, "unknown"],
    [{ exit_code: "" }, "unknown"],
    [{ exit_code: false }, "unknown"],
    [{ exit_code: [] }, "unknown"],
    [{ exit_code: "1" }, "error"],
    [{ exit_code: 1.5 }, "error"],
  ];
  for (const [tool_response, expected] of cases) {
    const p = { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_outcome", tool_response };
    const r = mapHook(p, ctx({ scratch: (k) => k === "leg:toolu_outcome" ? { legId: "toolu_outcome" } : null }));
    assert.equal(r.events[0].outcome, expected, JSON.stringify(tool_response));
  }
});

test("background Agent launch acknowledgement binds without ending the leg and keeps the resolved model", () => {
  const p = fx("hook-agent-posttooluse.json");
  p.tool_use_id = "toolu_a1";
  p.tool_response.agentId = "agent-1";
  const r = mapHook(p, ctx({ scratch: (k) => k === "leg:toolu_a1" ? { legId: "toolu_a1", tsStart: "t" } : null }));
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.scratchPuts, [
    ["leg:toolu_a1", { legId: "toolu_a1", tsStart: "t", resolvedModel: "claude-haiku-4-5-20251001" }],
    ["agent:agent-1", { legId: "toolu_a1", resolvedModel: "claude-haiku-4-5-20251001", agentType: "general-purpose" }],
  ]);
});

test("launch acknowledgement and SubagentStart bind in either order", () => {
  for (const startFirst of [true, false]) {
    const pre = fx("hook-agent-pretooluse.json");
    const start = fx("hook-subagentstart.json");
    const ack = fx("hook-agent-posttooluse.json");
    const stop = fx("hook-subagentstop.json");
    const legId = `toolu_${startFirst ? "start" : "ack"}`;
    const agentId = `agent_${startFirst ? "start" : "ack"}`;
    start.agent_id = agentId;
    ack.tool_use_id = legId;
    ack.tool_response.agentId = agentId;
    stop.agent_id = agentId;
    const scratch = new Map([[`leg:${legId}`, { legId, tsStart: "t" }]]);
    const apply = (payload) => {
      const r = mapHook(payload, ctx({ scratch: (key) => scratch.get(key), readFile: () => "jsonl", parsers: { transcript: () => ({ input: 5, output: 2 }), codex: () => null } }));
      for (const key of r.scratchTakes) scratch.delete(key);
      for (const [key, value] of r.scratchPuts) scratch.set(key, value);
      return r;
    };
    pre.tool_use_id = legId;
    apply(pre);
    if (startFirst) apply(start);
    apply(ack);
    if (!startFirst) apply(start);
    const result = apply(stop);
    assert.equal(result.events[0].type, "leg.end");
    assert.equal(result.events[0].legId, legId);
    assert.equal(result.events[0]["gen_ai.request.model"], "claude-haiku-4-5-20251001");
    assert.equal(scratch.has(`leg:${legId}`), false);
    assert.deepEqual(scratch.get(`agent:${agentId}`), { legId, resolvedModel: "claude-haiku-4-5-20251001", agentType: "general-purpose", ended: true });
  }
});

test("reused agent ids clear ended tombstones at both binding entry points", () => {
  const start = { hook_event_name: "SubagentStart", agent_id: "agent_reused", agent_type: "general-purpose" };
  const ack = { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_reused", tool_input: {}, tool_response: { status: "async_launched", isAsync: true, agentId: "agent_reused", resolvedModel: "model" } };
  const ended = { legId: "toolu_old", ended: true, agentType: "old" };
  const started = mapHook(start, ctx({ scratch: () => ended }));
  assert.equal(started.scratchPuts[0][1].ended, undefined);
  const acknowledged = mapHook(ack, ctx({ scratch: (key) => key === "agent:agent_reused" ? ended : { legId: "toolu_reused" } }));
  assert.equal(acknowledged.scratchPuts[1][1].ended, undefined);
});

test("reused agent ids end the new leg after SubagentStart revives the binding", () => {
  const agentId = "agent_reused";
  const oldLegId = "toolu_old";
  const newLegId = "toolu_new";
  const scratch = new Map([
    [`agent:${agentId}`, { legId: oldLegId, agentType: "general-purpose" }],
    [`leg:${oldLegId}`, { legId: oldLegId, tsStart: "t" }],
  ]);
  const apply = (payload, options = {}) => {
    const r = mapHook(payload, ctx({
      scratch: (key) => scratch.get(key),
      readFile: options.readFile ?? (() => "jsonl"),
      parsers: { transcript: () => ({ input: 8, output: 3 }), codex: () => null },
    }));
    for (const key of r.scratchTakes) scratch.delete(key);
    for (const [key, value] of r.scratchPuts) scratch.set(key, value);
    return r;
  };

  const firstStop = apply({ hook_event_name: "SubagentStop", agent_id: agentId, agent_transcript_path: "transcript.jsonl" });
  scratch.set(`leg:${newLegId}`, { legId: newLegId, tsStart: "t" });
  apply({ hook_event_name: "SubagentStart", agent_id: agentId, agent_type: "general-purpose" });
  apply({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: newLegId,
    tool_input: { subagent_type: "general-purpose" },
    tool_response: { status: "async_launched", isAsync: true, agentId, resolvedModel: "model" },
  });
  const stop = apply({ hook_event_name: "SubagentStop", agent_id: agentId, agent_transcript_path: "transcript.jsonl" });

  assert.equal(firstStop.events[0].legId, oldLegId);
  assert.equal(stop.events.length, 1);
  assert.equal(stop.events[0].type, "leg.end");
  assert.equal(stop.events[0].legId, newLegId);
  assert.equal(stop.events[0]["gen_ai.usage.input_tokens"], 8);
  assert.equal(scratch.has(`leg:${oldLegId}`), false);
  assert.equal(scratch.has(`leg:${newLegId}`), false);
});

test("explicit failure evidence outranks interrupted false", () => {
  for (const tool_response of [{ interrupted: false, is_error: true }, { interrupted: false, exit_code: 1 }]) {
    const p = { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_failure", tool_response };
    const r = mapHook(p, ctx({ scratch: (k) => k === "leg:toolu_failure" ? { legId: "toolu_failure" } : null }));
    assert.equal(r.events[0].outcome, "error");
  }
});

test("real successful Bash response with interrupted false is ok", () => {
  const p = fx("hook-subagent-posttooluse.json");
  p.tool_use_id = "toolu_b_success";
  p.agent_id = undefined;
  const r = mapHook(p, ctx({ scratch: (k) => k === "leg:toolu_b_success" ? { legId: "toolu_b_success" } : null }));
  assert.equal(r.events[0].outcome, "ok");
});

test("codex PostToolUse reports usage when the parser returns both numbers", () => {
  const p = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_b1", tool_input: { command: "codex exec -m gpt-5.6-luna --json" }, tool_response: { exit_code: 0 } };
  const r = mapHook(p, ctx({ scratch: () => ({ legId: "toolu_b1", tsStart: "t", jsonlPath: "C:/x.jsonl" }), readFile: () => "raw", parsers: { transcript: () => null, codex: () => ({ input: 100, output: 7 }) } }));
  assert.equal(r.events[0].usageSource, "reported");
  assert.equal(r.events[0]["gen_ai.usage.input_tokens"], 100);
});

test("subagent PostToolUse becomes a span bound through agent_id", () => {
  const p = fx("hook-subagent-posttooluse.json");
  if (p.agent_id === undefined) { assert.ok(true, "S-A0: agent_id absent, spans limited to conductor session"); return; }
  const r = mapHook(p, ctx({ scratch: (k) => (k === `agent:${p.agent_id}` ? { legId: "toolu_a1" } : k === `span:${p.tool_use_id}` ? { tsStart: "2026-09-04T09:59:00.000Z" } : null) }));
  assert.equal(r.events[0].type, "span");
  assert.equal(r.events[0].legId, "toolu_a1");
  assert.equal(r.events[0].tsStart, "2026-09-04T09:59:00.000Z");
});

test("a span without a matching PreToolUse has no fabricated duration", () => {
  const p = fx("hook-subagent-posttooluse.json");
  delete p.duration_ms;
  const events = mapHook(p, ctx({ scratch: (k) => k === `agent:${p.agent_id}` ? { legId: "toolu_a1" } : null })).events;
  assert.equal(events.length, 0);
});

test("SubagentStop with a parsed transcript stores usage for the Agent PostToolUse", () => {
  const p = fx("hook-subagentstop.json");
  const r = mapHook(p, ctx({ scratch: (k) => (k === `agent:${p.agent_id}` ? { legId: "toolu_a1" } : null), readFile: () => "jsonl", parsers: { transcript: () => ({ input: 5000, output: 300 }), codex: () => null } }));
  assert.deepEqual(r.scratchPuts, [
    ["usage:toolu_a1", { input: 5000, output: 300, usageSource: "transcript" }],
    [`agent:${p.agent_id}`, { legId: "toolu_a1", ended: true }],
  ]);
  assert.deepEqual(r.scratchTakes, ["leg:toolu_a1"]);
  assert.equal(r.events[0].type, "leg.end");
  assert.equal(r.events[0].outcome, "unknown");
});

test("SubagentStop with unparsable transcript emits unknown, never numbers", () => {
  const p = fx("hook-subagentstop.json");
  const r = mapHook(p, ctx({ scratch: () => ({ legId: "toolu_a1" }), readFile: () => "garbage" }));
  assert.deepEqual(r.scratchPuts, [
    ["usage:toolu_a1", { usageSource: "unknown" }],
    [`agent:${p.agent_id}`, { legId: "toolu_a1", ended: true }],
  ]);
  assert.deepEqual(r.scratchTakes, ["leg:toolu_a1"]);
  assert.equal(r.events[0].outcome, "unknown");
});

test("codex Bash leg emits one span per parsed item, then a single leg.end", () => {
  const fixtureText = readFileSync(new URL("./fixtures/codex-exec-tools.jsonl", import.meta.url), "utf8");
  const root = path.resolve("/x"); // absolute on every platform: /x on POSIX, <drive>:\x on Windows
  const jsonlPath = path.resolve(root, "codex-exec-tools.jsonl");
  const apply = scratchRoundTrip({
    readFile: (file) => (file === jsonlPath ? fixtureText : null),
    parsers: { transcript: () => null, codex: () => null, codexSpans: parseCodexSpans },
  });
  apply({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_codex", cwd: root, tool_input: { command: "codex exec -m gpt-5.6-luna --json > codex-exec-tools.jsonl" } });
  const r = apply({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_codex", cwd: root, tool_response: { exit_code: 0 } });
  assert.equal(r.events.length, 5);
  assert.deepEqual(r.events.map((e) => e.type), ["span", "span", "span", "span", "leg.end"]);
  const ids = new Set();
  for (const span of r.events.slice(0, -1)) {
    const result = validateEvent(span);
    assert.equal(result.ok, true, result.errors.join(", "));
    assert.equal(span.tsSource, "bound");
    assert.equal("tsEnd" in span, false);
    assert.ok(span.payloadRef.startsWith(`${jsonlPath}:`), span.payloadRef);
    assert.ok(path.isAbsolute(jsonlPath));
    assert.equal(ids.has(span.spanId), false);
    ids.add(span.spanId);
  }
  assert.equal(r.events.at(-1).type, "leg.end");
});

test("deleting the PreToolUse vendor write leaves the codex leg emitting no spans (mutation proof)", () => {
  const fixtureText = readFileSync(new URL("./fixtures/codex-exec-tools.jsonl", import.meta.url), "utf8");
  const root = "C:/x";
  const jsonlPath = path.resolve(root, "codex-exec-tools.jsonl");
  const scratch = new Map([["leg:toolu_codex_novendor", { legId: "toolu_codex_novendor", tsStart: "t", jsonlPath }]]);
  const r = mapHook(
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_codex_novendor", cwd: root, tool_response: { exit_code: 0 } },
    ctx({ scratch: (key) => scratch.get(key), readFile: (file) => (file === jsonlPath ? fixtureText : null), parsers: { transcript: () => null, codex: () => null, codexSpans: parseCodexSpans } }),
  );
  assert.equal(r.events.filter((e) => e.type === "span").length, 0);
});

test("grok Bash legs emit no codex spans", () => {
  const root = "C:/x";
  const apply = scratchRoundTrip({
    readFile: () => "irrelevant",
    parsers: { transcript: () => null, codex: () => null, codexSpans: () => { throw new Error("must not be called for grok legs"); } },
  });
  apply({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_grok", cwd: root, tool_input: { command: "grok run -m grok-1 > grok.jsonl" } });
  const r = apply({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_grok", cwd: root, tool_response: { exit_code: 0 } });
  assert.equal(r.events.filter((e) => e.type === "span").length, 0);
});

test("unreadable codex jsonl yields zero spans and unknown usage", () => {
  const root = "C:/x";
  const apply = scratchRoundTrip({
    readFile: () => null,
    parsers: { transcript: () => null, codex: () => null, codexSpans: parseCodexSpans },
  });
  apply({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_codex_unreadable", cwd: root, tool_input: { command: "codex exec --json > missing.jsonl" } });
  const r = apply({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_codex_unreadable", cwd: root, tool_response: { exit_code: 0 } });
  assert.equal(r.events.filter((e) => e.type === "span").length, 0);
  assert.equal(r.events.at(-1).type, "leg.end");
  assert.equal(r.events.at(-1).usageSource, "unknown");
});

test("a duplicated item id gets its spanId disambiguated by byte offset, not a collision", () => {
  const record = (type, item) => JSON.stringify({ type, item });
  const dupText = [
    record("item.started", { id: "dup-1", type: "command_execution", command: "run 1", status: "in_progress" }),
    record("item.completed", { id: "dup-1", type: "command_execution", command: "run 1", exit_code: 0, status: "completed" }),
    record("item.started", { id: "dup-1", type: "command_execution", command: "run 2", status: "in_progress" }),
    record("item.completed", { id: "dup-1", type: "command_execution", command: "run 2", exit_code: 1, status: "completed" }),
  ].join("\n") + "\n";
  const root = "C:/x";
  const apply = scratchRoundTrip({
    readFile: () => dupText,
    parsers: { transcript: () => null, codex: () => null, codexSpans: parseCodexSpans },
  });
  apply({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_dup", cwd: root, tool_input: { command: "codex exec --json > dup.jsonl" } });
  const r = apply({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_dup", cwd: root, tool_response: { exit_code: 0 } });
  const spans = r.events.filter((e) => e.type === "span");
  const parsed = parseCodexSpans(dupText);
  assert.deepEqual(spans.map((s) => s.spanId), ["toolu_dup/dup-1", `toolu_dup/dup-1@${parsed[1].byteOffset}`]);
  assert.deepEqual(spans.map((s) => s.toolUseId), ["dup-1", "dup-1"]);
  assert.deepEqual(spans.map((s) => s.status), ["ok", "error"]);
});

test("SessionEnd emits orch.end once", () => {
  assert.equal(mapHook({ hook_event_name: "SessionEnd" }, ctx()).events[0].type, "orch.end");
  assert.equal(mapHook({ hook_event_name: "SessionEnd" }, ctx({ orchEnded: true })).events.length, 0);
});
