#!/usr/bin/env node
/**
 * Send big files or PDFs through a cheap per-token worker and get back only
 * cited bullets, so the driving session never Reads the file itself
 * (conduct references/token-hygiene.md and references/bulk-read.md).
 *
 * Usage:
 *   bulk-read.mjs <file>... --question "<q>" [--model flash|luna] [--max-bullets 40] [--json] [--dry-run]
 *
 * Exit codes: 0 ok, 2 usage (also budget below the reserve, or more chunks than
 * BULK_READ_MAX_CHUNKS), 3 PDF extraction unavailable, 4 policy refusal,
 * 5 network / timeout / non-2xx.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MODELS = {
  flash: {
    id: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    keyEnv: "DEEPSEEK_API_KEY",
    budgetTokens: 120_000,
  },
  luna: {
    id: "gpt-6-luna",
    endpoint: "https://api.openai.com/v1/responses",
    keyEnv: "OPENAI_PLATFORM_KEY",
    budgetTokens: 200_000,
  },
};

export const PRICES_USD_PER_MTOK = {
  "deepseek-v4-flash": {
    input: 0.3,
    output: 1.2,
    note: "estimate: peak cache-miss rate, api-docs.deepseek.com/quick_start/pricing, 2026-09-12 (off-peak is half)",
  },
  "gpt-6-luna": {
    input: 0.1,
    output: 0.5,
    note: "estimate: standard tier short context, developers.openai.com/api/docs/pricing, 2026-09-23",
  },
};

const CHARS_PER_TOKEN = 4;
const ESTIMATOR_MARGIN = 0.95;
const MIN_CHUNK_TOKENS = 256;
const DEFAULT_MAX_CHUNKS = 20;
const MIN_SECRET_LENGTH = 8;
const TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BULLETS = 40;

function effectiveDenyList() {
  return process.env.BULK_READ_DENY_PATHS ?? "";
}

export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateCost(modelId, promptTokens, completionTokens) {
  const price = PRICES_USD_PER_MTOK[modelId];
  if (!price) throw new Error(`no price entry for ${modelId}`);
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}

function splitLines(contents) {
  return contents.replace(/\r?\n$/, "").split(/\r?\n/);
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function wrapNumbered(path, totalLines, numbered, range, pages) {
  const pagesAttr = pages ? ` pages="${pages}"` : "";
  const rangeAttr = range ? ` range="${range.startLine}-${range.endLine}"` : "";
  return `<file path="${escapeAttr(path)}" lines="${totalLines}"${pagesAttr}${rangeAttr}>\n${numbered.join("\n")}\n</file>`;
}

export function wrapWithLineNumbers(path, contents) {
  const lines = splitLines(contents);
  return wrapNumbered(path, lines.length, lines.map((line, i) => `${i + 1}| ${line}`));
}

export function wrapPdfWithPages(path, extractedText) {
  let page = 1;
  const numbered = splitLines(extractedText).map((line) => {
    const marker = /^\[page (\d+)\]$/.exec(line);
    if (marker) page = Number(marker[1]);
    return `p${page}| ${line}`;
  });
  return wrapNumbered(path, numbered.length, numbered, undefined, page);
}

function pageOf(line) {
  return /^p(\d+)\| /.exec(line)?.[1];
}

function pageRangeOf(numbered) {
  const first = pageOf(numbered[0]);
  return first ? `p${first}-p${pageOf(numbered.at(-1))}` : undefined;
}

function numberedLinesOf(wrappedText) {
  return wrappedText.split("\n").slice(1, -1);
}

export function promptReserveTokens(systemPrompt, question) {
  return estimateTokens(systemPrompt) + estimateTokens(`Question: ${question}\n\n`);
}

export function planChunks(files, totalBudgetTokens, { reserveTokens = 0 } = {}) {
  const budgetTokens = totalBudgetTokens - reserveTokens;
  const chunks = [];
  let current = { parts: [], tokens: 0 };
  const flush = () => {
    if (current.parts.length) chunks.push({ parts: current.parts });
    current = { parts: [], tokens: 0 };
  };

  for (const file of files) {
    const tokens = estimateTokens(file.text);
    if (tokens <= budgetTokens) {
      const separator = current.parts.length ? 1 : 0;
      if (current.tokens + separator + tokens > budgetTokens) flush();
      current.parts.push({ path: file.path, lines: file.lines, text: file.text });
      current.tokens += tokens + (current.parts.length > 1 ? 1 : 0);
      continue;
    }
    flush();
    const numbered = numberedLinesOf(file.text);
    let start = 0;
    while (start < numbered.length) {
      const widestPages = pageRangeOf([numbered[start], numbered.at(-1)]);
      const headerTokens = estimateTokens(wrapNumbered(file.path, file.lines, [], { startLine: start + 1, endLine: numbered.length }, widestPages));
      let end = start;
      let used = headerTokens + estimateTokens(numbered[start]);
      while (end + 1 < numbered.length && used + estimateTokens(numbered[end + 1]) + 1 <= budgetTokens) {
        end += 1;
        used += estimateTokens(numbered[end]) + 1;
      }
      const range = { startLine: start + 1, endLine: end + 1 };
      const slice = numbered.slice(start, end + 1);
      chunks.push({
        parts: [{ path: file.path, lines: file.lines, ...range, text: wrapNumbered(file.path, file.lines, slice, range, pageRangeOf(slice)) }],
      });
      start = end + 1;
    }
  }
  flush();
  return chunks;
}

export function mergeBullets(bulletLists) {
  return [...new Set(bulletLists.flat())];
}

const NOT_FOUND_BULLET = "not found in the files";
const BULLET_MARKER = /^(?:[-*•]|\d+[.)])\s+/;
const CITATION = /:\d+\b|:p\d+\b/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function providedFileNames(providedFiles) {
  return [...new Set(providedFiles.flatMap((file) => {
    const value = String(file);
    const basename = value.split(/[\\/]/).at(-1) ?? value;
    return [value, basename].filter(Boolean);
  }))];
}

function citesProvidedFile(line, providedFiles) {
  return providedFileNames(providedFiles).some((file) => {
    const citation = new RegExp("(?:^|[\\s([{\"'*`])" + escapeRegExp(file) + ":(?:p)?\\d+\\b", "i");
    return citation.test(line);
  });
}

export function parseBullets(text, providedFiles) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("```"));
  const bullets = lines
    .filter((line) => BULLET_MARKER.test(line))
    .map((line) => line.replace(BULLET_MARKER, ""))
    .filter((line) => line === NOT_FOUND_BULLET || (providedFiles === undefined ? CITATION.test(line) : citesProvidedFile(line, providedFiles)));
  return { bullets, droppedLines: lines.length - bullets.length };
}

export function isDeniedPath(path, denyList = effectiveDenyList(), resolveRealpath = realpathSync) {
  const denied = denyList.split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const absolutePath = resolve(path);
  const pathsToCheck = [absolutePath];
  if (existsSync(absolutePath)) {
    try {
      pathsToCheck.push(resolveRealpath(absolutePath));
    } catch {
      return true;
    }
  }
  if (denied.length === 0) return false;
  return pathsToCheck.some((candidate) => candidate.split(/[\\/]+/).some((segment) => {
    const normalizedSegment = segment.toLowerCase();
    return denied.some((token) => normalizedSegment.includes(token));
  }));
}

export function buildSystemPrompt(maxBullets) {
  return [
    "You are in bulk-reader mode. Answer the question using ONLY the files provided; outside knowledge is off-limits.",
    "Text files prefix every line with its 1-based number as `N| text`; cite them as `path:line`.",
    "PDFs prefix every line with its page as `pN| text`; cite them as `path:pN`.",
    "Output ONLY bullets, one per line, each starting with `- `, then the citation, then a space, then the finding.",
    `Output at most ${maxBullets} bullets. No preamble, no closing remarks, no fences, no code blocks, no headings.`,
    "Never invent line or page numbers: cite only numbers that appear in the provided text.",
    `If the files do not answer the question, output exactly one bullet: \`${NOT_FOUND_BULLET}\`.`,
  ].join("\n");
}

export function parseArgs(argv) {
  const args = { files: [], question: undefined, model: "flash", maxBullets: DEFAULT_MAX_BULLETS, json: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--question") args.question = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--max-bullets") args.maxBullets = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else args.files.push(a);
  }
  return args;
}

const PDF_SCRIPT = [
  "import fitz, sys",
  "doc = fitz.open(sys.argv[1])",
  "for i, page in enumerate(doc, 1):",
  "    print(f'[page {i}]')",
  "    for line in page.get_text().splitlines():",
  "        print(line)",
].join("\n");

const SECRET_ENV = /KEY|TOKEN|SECRET/i;

function sanitizedEnv(env) {
  const kept = {};
  const secrets = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV.test(name)) {
      if (value) secrets.push(value);
    } else {
      kept[name] = value;
    }
  }
  return { env: { ...kept, PYTHONIOENCODING: "utf-8" }, secrets };
}

function redactAll(text, secrets) {
  return secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH).reduce((out, secret) => redact(out, secret), String(text));
}

function pdfError(path, detail) {
  return Object.assign(new Error(`PDF extraction unavailable for ${path}: ${detail}`), { exitCode: 3 });
}

// Linux/macOS ship python3 and often no bare `python`; Windows installs `python`.
export const DEFAULT_PYTHON = process.platform === "win32" ? "python" : "python3";

function extractPdfText(path) {
  const python = process.env.BULK_READ_PYTHON || DEFAULT_PYTHON;
  const { env, secrets } = sanitizedEnv(process.env);
  const r = spawnSync(python, ["-X", "utf8", "-c", PDF_SCRIPT, path], {
    encoding: "utf8",
    env,
    maxBuffer: 512 * 1024 * 1024,
    timeout: TIMEOUT_MS,
  });
  if (r.error || r.status !== 0) {
    const detail = redactAll((r.error?.message || r.stderr || "").trim(), secrets).slice(0, 300);
    throw pdfError(path, `${python} -c "import fitz" (PyMuPDF) failed: ${detail}`);
  }
  if (r.stdout.includes("�")) {
    throw pdfError(path, "extracted text contains U+FFFD (undecodable bytes from python stdout)");
  }
  return r.stdout;
}

function loadFile(path) {
  const bytes = statSync(path).size;
  if (extname(path).toLowerCase() === ".pdf") {
    const text = wrapPdfWithPages(path, extractPdfText(path));
    const numbered = numberedLinesOf(text);
    return { path, lines: numbered.length, bytes, pages: Number(pageOf(numbered.at(-1))), text };
  }
  const contents = readFileSync(path, "utf8");
  return { path, lines: splitLines(contents).length, bytes, text: wrapWithLineNumbers(path, contents) };
}

function redact(text, key) {
  return key ? String(text).split(key).join("[redacted]") : String(text);
}

function requestBody(model, systemPrompt, userText) {
  if (model.id === MODELS.luna.id) {
    // No temperature: this Responses API model rejects it.
    return { model: model.id, instructions: systemPrompt, input: userText };
  }
  return {
    model: model.id,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
  };
}

function readCompletion(model, json) {
  if (model.id === MODELS.luna.id) {
    const assembled = (json.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("\n");
    const text = assembled || (typeof json.output_text === "string" ? json.output_text : "");
    return { text, promptTokens: json.usage?.input_tokens ?? 0, completionTokens: json.usage?.output_tokens ?? 0 };
  }
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
  };
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function mockedFetch(mockPath, logPath) {
  const responses = JSON.parse(readFileSync(mockPath, "utf8"));
  const requests = [];
  return async (url, init) => {
    requests.push({ url, method: init.method, model: JSON.parse(init.body).model });
    if (logPath) writeFileSync(logPath, JSON.stringify(requests), "utf8");
    const next = responses.shift();
    if (!next) throw new Error(`BULK_READ_FETCH_MOCK: no canned response left for request ${requests.length}`);
    const whenAborted = new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(abortError())));
    if (next.hang === "headers") return whenAborted;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: () => (next.hang === "body" ? whenAborted : Promise.resolve(next.body)),
    };
  };
}

function resolveFetch() {
  const mockPath = process.env.BULK_READ_FETCH_MOCK;
  if (!mockPath) return fetch;
  console.error(`fetch mocked from ${mockPath}`);
  return mockedFetch(mockPath, process.env.BULK_READ_FETCH_LOG);
}

async function callWorker(model, key, secrets, systemPrompt, question, chunkText, doFetch) {
  const timeoutMs = Number(process.env.BULK_READ_TIMEOUT_MS) || TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let body;
  try {
    response = await doFetch(model.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(requestBody(model, systemPrompt, `Question: ${question}\n\n${chunkText}`)),
      signal: controller.signal,
    });
    body = await response.text();
  } catch (error) {
    const reason = error.name === "AbortError" ? `timeout after ${timeoutMs} ms` : redactAll(error.message, secrets);
    throw Object.assign(new Error(`${model.endpoint}: ${reason}`), { exitCode: 5 });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw Object.assign(new Error(`${model.endpoint}: HTTP ${response.status} ${redactAll(body, secrets).slice(0, 300)}`), { exitCode: 5 });
  }
  try {
    return readCompletion(model, JSON.parse(body));
  } catch (error) {
    throw Object.assign(new Error(`${model.endpoint}: malformed JSON response (${redactAll(error.message, secrets).slice(0, 120)})`), { exitCode: 5 });
  }
}

function usage(message) {
  if (message) console.error(message);
  console.error('usage: bulk-read.mjs <file>... --question "<q>" [--model flash|luna] [--max-bullets 40] [--json] [--dry-run]');
  process.exit(2);
}

function describeFiles(files) {
  return files.map((f) => `${f.path} (lines=${f.lines}, bytes=${f.bytes}${f.pages ? `, pages=${f.pages}` : ""})`);
}

function chunkText(chunk) {
  return chunk.parts.map((p) => p.text).join("\n\n");
}

function describePart(part) {
  const pages = pageRangeOf(numberedLinesOf(part.text));
  if (pages) return `${part.path}:${pages}`;
  return part.startLine ? `${part.path}:${part.startLine}-${part.endLine}` : part.path;
}

function describePlan(chunks) {
  return chunks.map((chunk, i) => {
    const parts = chunk.parts.map(describePart);
    const tokens = estimateTokens(chunkText(chunk));
    return `  chunk ${i + 1}: ${parts.join(", ")} (~${tokens} tokens)`;
  });
}

function report(args, model, files, chunks, extra) {
  const base = { model: model.id, endpoint: model.endpoint, chunks: chunks.length, files, ...extra };
  if (args.json) {
    console.log(JSON.stringify(base, null, 2));
    return;
  }
  console.error(`model: ${model.id}`);
  console.error(`endpoint: ${model.endpoint}`);
  console.error(`chunks: ${chunks.length}`);
  console.error(`files: ${describeFiles(files).join("; ")}`);
  for (const [k, v] of Object.entries(extra)) {
    if (k === "bullets") continue;
    console.error(k === "costUsdEstimate" ? `${k}: ${v} USD (estimate)` : `${k}: ${v}`);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage(error.message);
  }
  if (args.files.length === 0) usage("no input files");
  if (!args.question) usage("--question is required");
  const model = MODELS[args.model];
  if (!model) usage(`unknown --model ${args.model}; use flash or luna`);
  if (!Number.isInteger(args.maxBullets) || args.maxBullets < 1) usage("--max-bullets must be a positive integer");
  const denied = args.files.filter((file) => isDeniedPath(file));
  if (denied.length) {
    console.error(`policy refusal: ${denied.join(", ")} matches a denied path segment (BULK_READ_DENY_PATHS=${effectiveDenyList()}); client code never goes to a third-party model`);
    process.exit(4);
  }
  for (const file of args.files) if (!existsSync(file)) usage(`file not found: ${file}`);

  let files;
  try {
    files = args.files.map(loadFile);
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode ?? 2);
  }

  const budget = Number(process.env.BULK_READ_BUDGET_TOKENS) || model.budgetTokens;
  const effectiveBudget = Math.floor(budget * ESTIMATOR_MARGIN);
  const systemPrompt = buildSystemPrompt(args.maxBullets);
  const reserveTokens = promptReserveTokens(systemPrompt, args.question);
  if (effectiveBudget - reserveTokens < MIN_CHUNK_TOKENS) {
    usage(`budget ${budget} tokens (${effectiveBudget} after the ${Math.round((1 - ESTIMATOR_MARGIN) * 100)}% estimator margin) minus reserve ${reserveTokens} for the prompt and question leaves less than ${MIN_CHUNK_TOKENS} per chunk; raise BULK_READ_BUDGET_TOKENS or shorten the question`);
  }
  const chunks = planChunks(files, effectiveBudget, { reserveTokens });
  const explicitMaxChunks = Number(process.env.BULK_READ_MAX_CHUNKS);
  const maxChunks = explicitMaxChunks || DEFAULT_MAX_CHUNKS;
  const ceilingBreach = chunks.length > maxChunks ? `${chunks.length} chunks exceed the ceiling of ${maxChunks} (BULK_READ_MAX_CHUNKS)` : undefined;
  if (ceilingBreach && (!args.dryRun || explicitMaxChunks)) usage(ceilingBreach);
  const fileSummary = files.map(({ text, ...summary }) => summary);

  if (args.dryRun) {
    if (ceilingBreach) console.error(`a live run would refuse: ${ceilingBreach}`);
    if (args.json) {
      console.log(JSON.stringify({ model: model.id, endpoint: model.endpoint, budgetTokens: budget, effectiveBudget, reserveTokens, chunks: chunks.length, files: fileSummary, chunkPlan: describePlan(chunks), systemPrompt }, null, 2));
      return;
    }
    console.log(`model: ${model.id}`);
    console.log(`endpoint: ${model.endpoint}`);
    console.log(`budget tokens: ${budget} (effective after the estimator margin: ${effectiveBudget}; reserved for prompt and question: ${reserveTokens})`);
    console.log(`files: ${describeFiles(files).join("; ")}`);
    console.log(`chunks: ${chunks.length}`);
    console.log("chunk plan:");
    for (const line of describePlan(chunks)) console.log(line);
    console.log("system prompt:");
    console.log(systemPrompt);
    return;
  }

  const key = process.env[model.keyEnv];
  if (!key) usage(`${model.keyEnv} is not set`);

  const started = Date.now();
  const { secrets } = sanitizedEnv(process.env);
  const doFetch = resolveFetch();
  const lists = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let droppedLines = 0;
  const metricsSoFar = () => ({
    promptTokens,
    completionTokens,
    droppedLines,
    elapsedMs: Date.now() - started,
    costUsdEstimate: Number(estimateCost(model.id, promptTokens, completionTokens).toFixed(6)),
  });
  for (const chunk of chunks) {
    try {
      const result = await callWorker(model, key, secrets, systemPrompt, args.question, chunkText(chunk), doFetch);
      promptTokens += result.promptTokens;
      completionTokens += result.completionTokens;
      const parsed = parseBullets(result.text, args.files);
      droppedLines += parsed.droppedLines;
      lists.push(parsed.bullets);
    } catch (error) {
      console.error(error.message);
      console.error(`partial metrics after ${lists.length} of ${chunks.length} chunks: ${JSON.stringify(metricsSoFar())}`);
      process.exit(error.exitCode ?? 5);
    }
  }
  const merged = mergeBullets(lists);
  const bullets = merged.slice(0, args.maxBullets);
  const metrics = { ...metricsSoFar(), bulletsCapped: merged.length - bullets.length };
  if (!args.json) for (const bullet of bullets) console.log(`- ${bullet}`);
  report(args, model, fileSummary, chunks, { ...metrics, bullets });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
