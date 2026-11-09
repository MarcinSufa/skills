function parseLines(text) {
  const lines = String(text ?? "").split("\n").filter((line) => line.trim() !== "");
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); }
    catch { return null; }
  }
  return parsed;
}

export function parseTranscriptUsage(text) {
  const requests = new Map();

  const lines = parseLines(text);
  if (!lines) return null;
  for (const event of lines) {
    if (event?.type !== "assistant" || typeof event.requestId !== "string") continue;
    const usage = event.message?.usage;
    if (!usage || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) continue;
    if (usage.cache_read_input_tokens !== undefined && !Number.isInteger(usage.cache_read_input_tokens)) continue;
    if (usage.cache_creation_input_tokens !== undefined && !Number.isInteger(usage.cache_creation_input_tokens)) continue;

    const current = requests.get(event.requestId);
    const blockIndex = Number.isInteger(event.apiBlockIndex) ? event.apiBlockIndex : 0;
    if (!current || blockIndex >= current.blockIndex) {
      requests.set(event.requestId, {
        blockIndex,
        input: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        output: usage.output_tokens,
      });
    }
  }

  if (requests.size === 0) return null;
  return [...requests.values()].reduce(
    (total, usage) => ({ input: total.input + usage.input, output: total.output + usage.output }),
    { input: 0, output: 0 },
  );
}
