export function splitJsonlRecords(text) {
  const raw = String(text ?? "");
  const records = [];
  let byteOffset = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() !== "") {
      const parseable = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      let parsed;
      try {
        parsed = JSON.parse(parseable);
      } catch {
        parsed = null;
      }
      records.push({ parsed, byteOffset });
    }
    byteOffset += Buffer.byteLength(line, "utf8") + 1;
  }
  return records;
}

export function parseCodexUsage(text) {
  let total = null;
  for (const { parsed: event } of splitJsonlRecords(text)) {
    const usage = event?.type === "turn.completed" ? event.usage : null;
    if (Number.isInteger(usage?.input_tokens) && Number.isInteger(usage?.output_tokens)) {
      total ??= { input: 0, output: 0 };
      total.input += usage.input_tokens;
      total.output += usage.output_tokens;
    }
  }
  return total;
}
