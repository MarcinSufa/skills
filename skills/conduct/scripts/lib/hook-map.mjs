import { makeEvent } from "./events-schema.mjs";
import path from "node:path";

const ROLE_RE = /^conduct\.role:\s*(worker|reviewer|gate-author|opinion)/m;
const VENDORS = { codex: "openai", grok: "xai" };

function dispatchOf(command) {
  const tokens = [];
  let token = "", quote = null;
  const flush = () => { if (token) tokens.push(token); token = ""; };
  for (const char of String(command ?? "")) {
    if (quote) { if (char === quote) quote = null; else token += char; }
    else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) flush();
    else if (char === ">") { flush(); tokens.push(">"); }
    else token += char;
  }
  flush();
  const commandIndex = tokens.findIndex((t) => t === "codex" || t === "grok" || t.endsWith("/grok") || t.endsWith("grok.exe"));
  const name = commandIndex >= 0 && (tokens[commandIndex] === "codex" ? "codex" : "grok");
  if (!name) return null;
  const m = tokens.indexOf("-m", commandIndex + 1);
  const model = m >= 0 && tokens[m + 1] && !tokens[m + 1].startsWith("-") ? tokens[m + 1] : "unknown";
  let redirect = -1;
  for (let i = commandIndex + 1; i < tokens.length; i++) {
    if (tokens[i] === ">" && !/^\d+$/.test(tokens[i - 1] ?? "")) { redirect = i; break; }
  }
  const jsonlPath = redirect >= 0 ? tokens[redirect + 1] : null;
  return { vendor: /deepseek/i.test(model) ? "deepseek" : VENDORS[name], model, jsonlPath };
}

function outcomeFrom(response) {
  const rawExitCode = response?.exit_code;
  const hasExitCode = (typeof rawExitCode === "number" && Number.isFinite(rawExitCode))
    || (typeof rawExitCode === "string" && rawExitCode.trim() !== "" && Number.isFinite(Number(rawExitCode)));
  const exitCode = hasExitCode ? Number(rawExitCode) : null;
  const rules = [
    [response?.needs_input, "needs_input"],
    [response?.is_error === true, "error"],
    [hasExitCode && exitCode !== 0, "error"],
    [response?.interrupted === true, "interrupted"],
    [hasExitCode && exitCode === 0, "ok"],
    [response?.interrupted === false, "ok"],
  ];
  return rules.find(([matches]) => matches)?.[1] ?? "unknown";
}

function usageFrom(parsed) {
  return parsed && Number.isInteger(parsed.input) && Number.isInteger(parsed.output)
    ? { "gen_ai.usage.input_tokens": parsed.input, "gen_ai.usage.output_tokens": parsed.output }
    : null;
}

export function mapHook(p, ctx) {
  const out = { events: [], scratchPuts: [], scratchTakes: [] };
  const ev = (type, payload) => out.events.push({ ...makeEvent(ctx.base, type, payload), ts: ctx.now() });
  const id = p.tool_use_id;
  const legStart = (vendor, model, extra = {}) => ev("leg.start", { legId: id, taskId: ctx.currentTask ?? "unknown", attempt: ctx.currentAttempt ?? 1, "gen_ai.agent.name": vendor, "gen_ai.request.model": model, role: "unknown", toolUseId: id, ...extra });

  switch (p.hook_event_name) {
    case "PreToolUse": {
      if (p.tool_name === "Agent") {
        const role = ROLE_RE.exec(p.tool_input?.prompt ?? "")?.[1] ?? "unknown";
        legStart("claude", p.tool_input?.model ?? "unknown", { role });
        out.scratchPuts.push([`leg:${id}`, { legId: id, tsStart: ctx.now() }]);
      } else if (p.tool_name === "Bash") {
        const d = dispatchOf(p.tool_input?.command);
        if (d) {
          const jsonlPath = d.jsonlPath && p.cwd ? path.resolve(p.cwd, d.jsonlPath) : d.jsonlPath;
          legStart(d.vendor, d.model);
          out.scratchPuts.push([`leg:${id}`, { legId: id, tsStart: ctx.now(), jsonlPath, vendor: d.vendor }]);
        }
      } else if (p.agent_id) {
        out.scratchPuts.push([`span:${id}`, { tsStart: ctx.now() }]);
      }
      break;
    }
    case "SubagentStart": {
      const binding = ctx.scratch(`agent:${p.agent_id}`);
      const liveBinding = binding?.ended ? null : binding;
      out.scratchPuts.push([`agent:${p.agent_id}`, { ...liveBinding, agentType: p.agent_type, ...(liveBinding?.legId ? {} : { legId: null, binding: "pending" }) }]);
      break;
    }
    case "PostToolUse": {
      const launchAgentId = p.tool_name === "Agent" && p.tool_response?.status === "async_launched" && p.tool_response?.isAsync === true
        ? p.tool_response.agentId
        : null;
      if (launchAgentId) {
        const binding = ctx.scratch(`agent:${launchAgentId}`);
        const leg = ctx.scratch(`leg:${id}`);
        if (leg) {
          out.scratchPuts.push([`leg:${id}`, { ...leg, resolvedModel: p.tool_response.resolvedModel ?? leg.resolvedModel }]);
          const { binding: _pending, ended: _ended, ...existingBinding } = binding ?? {};
          out.scratchPuts.push([`agent:${launchAgentId}`, { ...existingBinding, legId: id, resolvedModel: p.tool_response.resolvedModel, agentType: binding?.agentType ?? p.tool_input?.subagent_type }]);
        }
        break;
      }
      const leg = ctx.scratch(`leg:${id}`);
      if (leg) {
        out.scratchTakes.push(`leg:${id}`);
        const exit = outcomeFrom(p.tool_response);
        let usage = null, usageSource = "unknown";
        if (p.tool_name === "Bash") {
          const usagePath = leg.jsonlPath ? (path.isAbsolute(leg.jsonlPath) ? leg.jsonlPath : path.resolve(p.cwd ?? process.cwd(), leg.jsonlPath)) : null;
          const raw = usagePath ? ctx.readFile(usagePath) : null;
          usage = raw ? usageFrom(ctx.parsers.codex(raw)) : null;
          usageSource = usage ? "reported" : "unknown";
          if (leg.vendor === "openai" && raw) {
            const seen = new Set();
            for (const span of ctx.parsers.codexSpans(raw)) {
              const repeated = seen.has(span.itemId);
              seen.add(span.itemId);
              const spanId = repeated ? `${id}/${span.itemId}@${span.byteOffset}` : `${id}/${span.itemId}`;
              ev("span", { legId: id, spanId, toolUseId: span.itemId, "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": span.toolName, label: span.label, status: span.status, tsStart: leg.tsStart, tsSource: "bound", payloadRef: `${usagePath}:${span.byteOffset}` });
            }
          }
        } else if (p.tool_name === "Agent") {
          const stored = ctx.scratch(`usage:${id}`);
          out.scratchTakes.push(`usage:${id}`);
          usage = stored ? usageFrom(stored) : null;
          usageSource = usage ? stored.usageSource : "unknown";
        }
        ev("leg.end", { legId: id, outcome: exit, usageSource, ...(usage ?? {}) });
        break;
      }
      if (p.agent_id && p.tool_name !== "Agent") {
        const bound = ctx.scratch(`agent:${p.agent_id}`);
        const started = ctx.scratch(`span:${id}`);
        out.scratchTakes.push(`span:${id}`);
        const tsEnd = ctx.now();
        const tsStart = started?.tsStart ?? (Number.isFinite(p.duration_ms) ? new Date(Date.parse(tsEnd) - p.duration_ms).toISOString() : null);
        if (!tsStart) break;
        const response = p.tool_response;
        const status = outcomeFrom(response);
        ev("span", { legId: bound?.legId ?? "unbound", spanId: id, toolUseId: id, "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": p.tool_name, status, ...(tsStart ? { tsStart, tsEnd } : {}) });
        break;
      }
      break;
    }
    case "SubagentStop": {
      const bound = ctx.scratch(`agent:${p.agent_id}`);
      if (!bound?.legId || bound.ended) break;
      ctx.scratch(`leg:${bound.legId}`);
      out.scratchTakes.push(`leg:${bound.legId}`);
      const raw = p.agent_transcript_path ? ctx.readFile(p.agent_transcript_path) : null;
      const parsed = raw ? ctx.parsers.transcript(raw) : null;
      const usage = parsed ? usageFrom(parsed) : null;
      const usageRecord = usage ? { ...parsed, usageSource: "transcript" } : { usageSource: "unknown" };
      out.scratchPuts.push([`usage:${bound.legId}`, usageRecord]);
      out.scratchPuts.push([`agent:${p.agent_id}`, { ...bound, ended: true }]);
      ev("leg.end", { legId: bound.legId, outcome: "unknown", usageSource: usageRecord.usageSource, ...(usage ?? {}), ...(bound.resolvedModel ? { "gen_ai.request.model": bound.resolvedModel } : {}) });
      break;
    }
    case "Stop": ev("heartbeat", {}); break;
    case "SessionEnd": if (!ctx.orchEnded) ev("orch.end", { terminal: "abandoned" }); break;
    default: break;
  }
  return out;
}
