import { splitJsonlRecords } from "./usage-codex.mjs";

const IGNORED_ITEM_TYPES = new Set(["agent_message", "reasoning", "error"]);

function labelFor(type, item) {
  if (type === "command_execution") return String(item?.command ?? "").trim().slice(0, 120);
  if (type === "file_change") {
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    if (changes.length === 0) return type;
    const suffix = changes.length > 1 ? ` (+${changes.length - 1})` : "";
    const head = `${changes[0]?.kind ?? "unknown"} ${changes[0]?.path ?? "unknown"}`;
    return head.slice(0, 120 - suffix.length) + suffix;
  }
  return type;
}

function statusFor(type, item, hasCompleted) {
  if (!hasCompleted) return "interrupted";
  if (type === "command_execution") return Number.isInteger(item?.exit_code) ? (item.exit_code === 0 ? "ok" : "error") : "unknown";
  if (type === "file_change") return item?.status === "completed" ? "ok" : item?.status === "failed" ? "error" : "unknown";
  return "unknown";
}

export function parseCodexSpans(text) {
  const entries = [];
  const openIndexByItemId = new Map();
  for (const { parsed, byteOffset } of splitJsonlRecords(text)) {
    if (parsed?.type !== "item.started" && parsed?.type !== "item.completed") continue;
    const item = parsed.item;
    const itemType = item?.type;
    if (!item?.id || !itemType || IGNORED_ITEM_TYPES.has(itemType)) continue;
    const openIndex = openIndexByItemId.get(item.id);
    const open = openIndex !== undefined ? entries[openIndex] : undefined;
    if (parsed.type === "item.started" && open?.completed) {
      const entry = { itemId: item.id, toolName: itemType, started: { item, byteOffset } };
      openIndexByItemId.set(item.id, entries.push(entry) - 1);
      continue;
    }
    if (open) {
      open.toolName = itemType;
      if (parsed.type === "item.started") open.started = { item, byteOffset };
      else open.completed = { item, byteOffset };
      continue;
    }
    const entry = { itemId: item.id, toolName: itemType, [parsed.type === "item.started" ? "started" : "completed"]: { item, byteOffset } };
    openIndexByItemId.set(item.id, entries.push(entry) - 1);
  }
  return entries.map((entry) => {
    const record = entry.completed ?? entry.started;
    return {
      itemId: entry.itemId,
      toolName: entry.toolName,
      label: labelFor(entry.toolName, record.item),
      status: statusFor(entry.toolName, record.item, Boolean(entry.completed)),
      byteOffset: record.byteOffset,
    };
  });
}
