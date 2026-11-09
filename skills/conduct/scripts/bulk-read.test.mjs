import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PYTHON,
  MODELS,
  PRICES_USD_PER_MTOK,
  buildSystemPrompt,
  estimateCost,
  estimateTokens,
  isDeniedPath,
  mergeBullets,
  parseArgs,
  parseBullets,
  planChunks,
  promptReserveTokens,
  wrapPdfWithPages,
  wrapWithLineNumbers,
} from "./bulk-read.mjs";

const cli = fileURLToPath(new URL("./bulk-read.mjs", import.meta.url));
const fixtureDir = mkdtempSync(path.join(tmpdir(), "bulk-read-"));
const bigPath = path.join(fixtureDir, "big.txt");
writeFileSync(bigPath, `${Array.from({ length: 5_000 }, (_, i) => `record ${i + 1}`).join("\n")}\n`, "utf8");
after(() => rmSync(fixtureDir, { recursive: true, force: true }));

const python = process.env.BULK_READ_PYTHON || DEFAULT_PYTHON;
const fakeKey = "sk-fake-never-printed";
function run(args, extraEnv = {}, cwd = process.cwd()) {
  const env = {
    ...process.env,
    BULK_READ_BUDGET_TOKENS: "1000",
    DEEPSEEK_API_KEY: fakeKey,
    OPENAI_PLATFORM_KEY: fakeKey,
    BULK_READ_DENY_PATHS: "",
    ...extraEnv,
  };
  delete env.OPENAI_API_KEY;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env, timeout: 15_000 });
  return { ...r, output: `${r.stdout}\n${r.stderr}` };
}

const descriptor = (p, contents) => ({ path: p, lines: contents.split(/\r?\n/).length, text: wrapWithLineNumbers(p, contents) });

test("wrapWithLineNumbers numbers every line from 1 and drops the single trailing newline", () => {
  const wrapped = wrapWithLineNumbers("a.txt", "alpha\r\nbeta\n");
  assert.equal(wrapped, '<file path="a.txt" lines="2">\n1| alpha\n2| beta\n</file>');
});

test("wrapWithLineNumbers keeps genuinely blank lines and a blank trailing block", () => {
  const wrapped = wrapWithLineNumbers("a.txt", "x\n\n\n");
  assert.equal(wrapped, '<file path="a.txt" lines="3">\n1| x\n2| \n3| \n</file>');
});

test("estimateTokens uses 4 chars per token, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcde"), 2);
});

test("planChunks packs whole files while they fit", () => {
  const plan = planChunks([descriptor("a.txt", "alpha"), descriptor("b.txt", "beta")], 1000);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].parts.map((p) => p.path), ["a.txt", "b.txt"]);
  assert.equal("startLine" in plan[0].parts[0], false);
});

test("planChunks splits an oversized file into consecutive line ranges that cover every line", () => {
  const contents = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
  const plan = planChunks([descriptor("long.txt", contents)], 20);
  assert.ok(plan.length > 1);
  let expectedStart = 1;
  for (const chunk of plan) {
    assert.equal(chunk.parts.length, 1);
    const part = chunk.parts[0];
    assert.equal(part.startLine, expectedStart);
    assert.ok(part.endLine >= part.startLine);
    assert.match(part.text, new RegExp(`^<file path="long.txt" lines="80" range="${part.startLine}-${part.endLine}">\\n${part.startLine}\\| line ${part.startLine}\\n`));
    assert.match(part.text, /<\/file>$/);
    expectedStart = part.endLine + 1;
  }
  assert.equal(expectedStart, 81);
});

test("planChunks counts the separator between packed files so the joined chunk stays within budget", () => {
  const files = [descriptor("a.txt", "abc"), descriptor("b.txt", "xyz")];
  assert.equal(estimateTokens(files[0].text), 11);
  assert.equal(planChunks(files, 22).length, 2);
  assert.equal(planChunks(files, 23).length, 1);
});

test("planChunks subtracts reserveTokens so every chunk plus the reserve fits the budget", () => {
  const files = ["alpha", "beta", "gamma"].map((name) => descriptor(`${name}.txt`, Array.from({ length: 28 }, (_, i) => `${name} ${i + 1} ${"x".repeat(16)}`).join("\n")));
  const reserve = 160;
  const chunks = planChunks(files, 260, { reserveTokens: reserve });
  assert.ok(chunks.length > 3);
  for (const chunk of chunks) {
    assert.ok(estimateTokens(chunk.parts.map((p) => p.text).join("\n\n")) + reserve <= 260);
  }
  assert.equal(chunks.flatMap((c) => c.parts).reduce((sum, p) => sum + (p.endLine ? p.endLine - p.startLine + 1 : p.lines), 0), 84);
});

test("promptReserveTokens covers the system prompt and the question line", () => {
  const prompt = buildSystemPrompt(40);
  assert.equal(promptReserveTokens(prompt, "why?"), estimateTokens(prompt) + estimateTokens("Question: why?\n\n"));
});

test("planChunks never loops on a line longer than the budget", () => {
  const plan = planChunks([descriptor("wide.txt", `${"x".repeat(500)}\nshort`)], 10);
  assert.equal(plan.length, 2);
  assert.equal(plan[1].parts[0].startLine, 2);
});

test("mergeBullets flattens, dedupes exact matches and keeps first-seen order", () => {
  assert.deepEqual(mergeBullets([["b", "a"], ["a", "c"], []]), ["b", "a", "c"]);
});

test("parseBullets keeps only marked lines with a path:line or path:pN citation and counts the rest", () => {
  const text = "```\n- a.txt:1 first\n* a.txt:2 second\n\n1. a.pdf:p3 third\na.txt:4 bare\n- no citation here\n- a.txt:x bad\n```\n";
  assert.deepEqual(parseBullets(text), { bullets: ["a.txt:1 first", "a.txt:2 second", "a.pdf:p3 third"], droppedLines: 3 });
});

test("parseBullets keeps the not-found sentinel bullet", () => {
  assert.deepEqual(parseBullets("- not found in the files\n"), { bullets: ["not found in the files"], droppedLines: 0 });
});

test("wrapPdfWithPages prefixes every extracted line, marker lines included, with its page", () => {
  const wrapped = wrapPdfWithPages("a.pdf", "[page 1]\nfirst\n[page 2]\nsecond\nmore\n");
  assert.equal(wrapped, '<file path="a.pdf" lines="5" pages="2">\np1| [page 1]\np1| first\np2| [page 2]\np2| second\np2| more\n</file>');
});

test("wrapWithLineNumbers escapes attribute characters in the path", () => {
  assert.match(wrapWithLineNumbers('we"ird&<.txt', "x"), /^<file path="we&quot;ird&amp;&lt;\.txt" lines="1">/);
});

test("isDeniedPath matches denied tokens within segments case-insensitively on either separator", () => {
  assert.equal(isDeniedPath("C:\\work\\ACME\\a.txt", "acme"), true);
  assert.equal(isDeniedPath("/home/me/client-repo/a.txt", "acme;client-repo"), true);
  assert.equal(isDeniedPath("/home/me/acme-notes/a.txt", "acme"), true);
  assert.equal(isDeniedPath("C:/anything/a.txt", ""), false);
  assert.equal(isDeniedPath("C:/x/Client/a.txt", " client ; other "), true);
});

test("isDeniedPath denies a token contained in a longer segment such as acme-web", () => {
  assert.equal(isDeniedPath("/home/me/projects/acme-web/src/foo.ts", "acme"), true);
});

test("isDeniedPath denies a token contained in an organization segment such as acmecorp", () => {
  assert.equal(isDeniedPath("C:/work/acmecorp/web/x.ts", "acme"), true);
});

test("isDeniedPath denies nothing when the environment deny list is empty or unset", () => {
  const previous = process.env.BULK_READ_DENY_PATHS;
  try {
    process.env.BULK_READ_DENY_PATHS = "";
    assert.equal(isDeniedPath("C:/work/acme-web/x.ts"), false);
    delete process.env.BULK_READ_DENY_PATHS;
    assert.equal(isDeniedPath("C:/work/acme-web/x.ts"), false);
  } finally {
    if (previous === undefined) delete process.env.BULK_READ_DENY_PATHS;
    else process.env.BULK_READ_DENY_PATHS = previous;
  }
});

test("isDeniedPath reads every token from the environment deny list", () => {
  const previous = process.env.BULK_READ_DENY_PATHS;
  process.env.BULK_READ_DENY_PATHS = "acme;other";
  try {
    assert.equal(isDeniedPath("C:/work/acme-web/x.ts"), true);
    assert.equal(isDeniedPath("C:/work/other/x.ts"), true);
    assert.equal(isDeniedPath("C:/work/client-repo/x.ts"), false);
  } finally {
    if (previous === undefined) delete process.env.BULK_READ_DENY_PATHS;
    else process.env.BULK_READ_DENY_PATHS = previous;
  }
});

test("isDeniedPath fails closed when realpath resolution fails for an existing path", () => {
  assert.equal(isDeniedPath(bigPath, "", () => { throw new Error("unavailable"); }), true);
  assert.equal(isDeniedPath(bigPath, "acme;client-repo", () => { throw new Error("unavailable"); }), true);
});

test("CLI resolves a relative path against a client-repo cwd before applying the deny list", () => {
  const cwd = path.join(fixtureDir, "client-repo");
  const relativeFile = path.join(cwd, "src", "foo.ts");
  mkdirSync(path.dirname(relativeFile), { recursive: true });
  writeFileSync(relativeFile, "x\n", "utf8");
  const r = run(["src/foo.ts", "--question", "q", "--dry-run"], { BULK_READ_DENY_PATHS: "client-repo" }, cwd);
  assert.equal(r.status, 4, r.output);
});

test("parseBullets drops wait:30 when it is not a citation to a provided file", () => {
  assert.deepEqual(parseBullets("- wait:30 seconds\n", ["notes.md"]), { bullets: [], droppedLines: 1 });
});

test("parseBullets drops a citation to an unprovided file", () => {
  assert.deepEqual(parseBullets("- other.ts:5| not provided\n", ["notes.md"]), { bullets: [], droppedLines: 1 });
});

test("parseBullets keeps citations wrapped in backticks or bold markers", () => {
  assert.deepEqual(parseBullets("- `notes.md:12` finding\n", ["notes.md"]), {
    bullets: ["`notes.md:12` finding"],
    droppedLines: 0,
  });
  assert.deepEqual(parseBullets("- **notes.md:12** finding\n", ["notes.md"]), {
    bullets: ["**notes.md:12** finding"],
    droppedLines: 0,
  });
  assert.deepEqual(parseBullets("- other.ts:5| not provided\n", ["notes.md"]), { bullets: [], droppedLines: 1 });
});

test("estimateCost reads the price table per million tokens", () => {
  const price = PRICES_USD_PER_MTOK["deepseek-v4-flash"];
  assert.equal(estimateCost("deepseek-v4-flash", 1_000_000, 1_000_000), price.input + price.output);
  assert.equal(estimateCost("deepseek-v4-flash", 0, 0), 0);
  assert.throws(() => estimateCost("unknown-model", 1, 1), /price/);
});

test("price table covers every model in MODELS and is marked estimate", () => {
  for (const model of Object.values(MODELS)) {
    const price = PRICES_USD_PER_MTOK[model.id];
    assert.ok(price, model.id);
    assert.ok(price.input > 0 && price.output > 0);
    assert.match(price.note, /estimate/);
  }
});

test("buildSystemPrompt states the citation formats and the bullet cap", () => {
  const prompt = buildSystemPrompt(7);
  assert.match(prompt, /path:line/);
  assert.match(prompt, /path:pN/);
  assert.match(prompt, /pN\| /);
  assert.match(prompt, /at most 7 bullets/);
  assert.match(prompt, /not found in the files/);
});

test("parseArgs separates positional files from options", () => {
  const args = parseArgs(["a.txt", "--question", "why?", "b.pdf", "--model", "luna", "--max-bullets", "5", "--json", "--dry-run"]);
  assert.deepEqual(args, { files: ["a.txt", "b.pdf"], question: "why?", model: "luna", maxBullets: 5, json: true, dryRun: true });
  assert.equal(parseArgs(["a.txt", "--question", "q"]).model, "flash");
  assert.equal(parseArgs(["a.txt", "--question", "q"]).maxBullets, 40);
  assert.throws(() => parseArgs(["a.txt", "--question", "q", "--bogus"]), /--bogus/);
});

test("CLI: missing --question, unknown model and missing file exit 2 without leaking the key", () => {
  for (const args of [[bigPath], [bigPath, "--question", "q", "--model", "haiku"], [path.join(fixtureDir, "nope.txt"), "--question", "q"]]) {
    const r = run([...args, "--dry-run"]);
    assert.equal(r.status, 2, r.output);
    assert.equal(r.output.includes(fakeKey), false);
  }
});

test("CLI: denied path exits 4 before touching the network and names the env var", () => {
  const denied = path.join(fixtureDir, "acme", "x.txt");
  const r = run([denied, "--question", "q"], {
    BULK_READ_DENY_PATHS: "acme",
    NODE_OPTIONS: "--import=data:text/javascript,globalThis.fetch=async%20()%3D%3E%7Bthrow%20new%20Error('NETWORK_SENTINEL')%7D",
  });
  assert.equal(r.status, 4, r.output);
  assert.match(r.output, /BULK_READ_DENY_PATHS/);
  assert.doesNotMatch(r.output, /NETWORK_SENTINEL/);
});

test("CLI: a refusal reports the effective deny list from BULK_READ_DENY_PATHS", () => {
  const denied = path.join(fixtureDir, "acme-web", "x.txt");
  const r = run([denied, "--question", "q", "--dry-run"], { BULK_READ_DENY_PATHS: "acme;client-repo" });
  assert.equal(r.status, 4, r.output);
  assert.match(r.stderr, /BULK_READ_DENY_PATHS=acme;client-repo/);
});

test("CLI: empty BULK_READ_DENY_PATHS has no default deny list", () => {
  const allowed = path.join(fixtureDir, "acme-web", "allowed.txt");
  mkdirSync(path.dirname(allowed), { recursive: true });
  writeFileSync(allowed, "x\n", "utf8");
  const r = run([allowed, "--question", "q", "--dry-run"], { BULK_READ_DENY_PATHS: "" });
  assert.equal(r.status, 0, r.output);
});

test("CLI: missing API key exits 2 outside dry-run", () => {
  const r = run([bigPath, "--question", "q"], { BULK_READ_BUDGET_TOKENS: "100000", DEEPSEEK_API_KEY: "" });
  assert.equal(r.status, 2, r.output);
  assert.match(r.output, /DEEPSEEK_API_KEY/);
});

test("CLI: dry-run plans the 5,000-line file into many chunks and prints the prompt", () => {
  const r = run([bigPath, "--question", "Find the records", "--dry-run"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /model: deepseek-v4-flash/);
  assert.match(r.output, /endpoint: https:\/\/api\.deepseek\.com\/v1\/chat\/completions/);
  assert.match(r.output, /lines=5000/);
  assert.match(r.output, /chunks: \d{2}/);
  assert.match(r.output, /chunk plan/i);
  assert.match(r.output, /system prompt/i);
  assert.match(r.output, /path:line/);
  assert.doesNotMatch(r.output, /record 4999/, "dry-run must not dump file contents");

  const luna = run([bigPath, "--question", "Find the records", "--model", "luna", "--dry-run"]);
  assert.equal(luna.status, 0, luna.output);
  assert.match(luna.output, /model: gpt-6-luna/);
  assert.match(luna.output, /endpoint: https:\/\/api\.openai\.com\/v1\/responses/);
});

test("CLI: dry-run with --json prints one JSON object", () => {
  const r = run([bigPath, "--question", "q", "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.output);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.model, "deepseek-v4-flash");
  assert.ok(parsed.chunks > 1);
  assert.equal(parsed.files[0].lines, 5000);
  assert.equal(parsed.budgetTokens, 1000);
  assert.equal(parsed.reserveTokens, promptReserveTokens(buildSystemPrompt(40), "q"));
  for (const line of parsed.chunkPlan) assert.ok(Number(/~(\d+) tokens/.exec(line)[1]) + parsed.reserveTokens <= 1000, line);
});

test("CLI: dry-run on a synthetic PDF keeps page markers (skipped without fitz)", () => {
  const check = spawnSync(python, ["-c", "import fitz"], { encoding: "utf8", timeout: 10_000 });
  if (check.status !== 0) {
    console.log(`SKIP PDF test: ${python} -c 'import fitz' unavailable (${(check.stderr || "").trim().slice(0, 200)})`);
    return;
  }
  const pdfPath = path.join(fixtureDir, "synthetic.pdf");
  const made = spawnSync(
    python,
    ["-c", "import fitz, sys; d = fitz.open(); d.new_page().insert_text((72, 72), 'first page'); d.new_page().insert_text((72, 72), 'second page'); d.save(sys.argv[1])", pdfPath],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(made.status, 0, made.stderr);
  const r = run([pdfPath, "--question", "q", "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.output);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.files[0], { path: pdfPath, lines: 4, bytes: parsed.files[0].bytes, pages: 2 });
  assert.ok(parsed.files[0].bytes > 0);
  assert.match(parsed.chunkPlan[0], /synthetic\.pdf:p1-p2/);
  assert.doesNotMatch(r.output, /first page/);
});

test("CLI: a file whose first line is a secret never reaches stdout or stderr", () => {
  const secretPath = path.join(fixtureDir, "secret.txt");
  writeFileSync(secretPath, "secret=sk-test-DO-NOT-PRINT\nsecond\n", "utf8");
  for (const extra of [["--dry-run"], ["--dry-run", "--json"], []]) {
    const mock = path.join(fixtureDir, "secret-mock.json");
    writeFileSync(mock, JSON.stringify([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: "- secret.txt:2| second" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }]), "utf8");
    const r = run([secretPath, "--question", "q", ...extra], { BULK_READ_FETCH_MOCK: mock });
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.output, /DO-NOT-PRINT/);
    assert.doesNotMatch(r.output, /preview/);
    assert.match(r.output, /bytes["=: ]+35/);
  }
});

test("CLI: the timeout covers the response body, not only the headers", () => {
  const mock = path.join(fixtureDir, "hang-mock.json");
  writeFileSync(mock, JSON.stringify([{ status: 200, hang: "body", body: "never delivered" }]), "utf8");
  const started = Date.now();
  const r = run([bigPath, "--question", "q"], { BULK_READ_BUDGET_TOKENS: "100000", BULK_READ_FETCH_MOCK: mock, BULK_READ_TIMEOUT_MS: "300" });
  assert.equal(r.status, 5, r.output);
  assert.match(r.stderr, /timeout after 300 ms/);
  assert.ok(Date.now() - started < 10_000);
});

test("CLI: luna falls back to output_text when the output array is absent", () => {
  const mock = path.join(fixtureDir, "luna-output-text.json");
  writeFileSync(mock, JSON.stringify([{ status: 200, body: JSON.stringify({ output_text: "- big.txt:1| via output_text", usage: { input_tokens: 3, output_tokens: 2 } }) }]), "utf8");
  const r = run([bigPath, "--question", "q", "--model", "luna", "--json"], { BULK_READ_BUDGET_TOKENS: "100000", BULK_READ_FETCH_MOCK: mock });
  assert.equal(r.status, 0, r.output);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.bullets, ["big.txt:1| via output_text"]);
  assert.equal(parsed.promptTokens, 3);
});

test("CLI: text report labels the cost as an estimate, reports droppedLines and names the honoured fetch mock", () => {
  const mock = path.join(fixtureDir, "cost-mock.json");
  writeFileSync(mock, JSON.stringify([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: "- big.txt:1| record 1\nstray line" } }], usage: { prompt_tokens: 1000, completion_tokens: 10 } }) }]), "utf8");
  const r = run([bigPath, "--question", "q"], { BULK_READ_BUDGET_TOKENS: "100000", BULK_READ_FETCH_MOCK: mock });
  assert.equal(r.status, 0, r.output);
  assert.equal(r.stdout, "- big.txt:1| record 1\n");
  assert.match(r.stderr, /costUsdEstimate: 0\.000312 USD \(estimate\)/);
  assert.match(r.stderr, /droppedLines: 1/);
  assert.match(r.stderr, /bulletsCapped: 0/);
  assert.match(r.stderr, new RegExp(`fetch mocked from .*cost-mock\\.json`));
});

const networkSentinel = "--import=data:text/javascript,globalThis.fetch=async%20()%3D%3E%7Bthrow%20new%20Error('NETWORK_SENTINEL')%7D";

test("CLI: a budget that cannot hold the reserve plus a minimal chunk exits 2 naming both, before any network call", () => {
  const r = run([bigPath, "--question", "q".repeat(300)], { BULK_READ_BUDGET_TOKENS: "10", NODE_OPTIONS: networkSentinel });
  assert.equal(r.status, 2, r.output);
  assert.match(r.stderr, /budget 10/);
  assert.match(r.stderr, /reserve \d+/);
  assert.match(r.stderr, /BULK_READ_BUDGET_TOKENS/);
  assert.doesNotMatch(r.output, /NETWORK_SENTINEL/);
});

test("CLI: the chunk ceiling refuses a billed run above 20 chunks by default, before any network call", () => {
  const live = run([bigPath, "--question", "q"], { NODE_OPTIONS: networkSentinel });
  assert.equal(live.status, 2, live.output);
  assert.match(live.stderr, /\d{2} chunks exceed the ceiling of 20 \(BULK_READ_MAX_CHUNKS\)/);
  assert.doesNotMatch(live.output, /NETWORK_SENTINEL/);

  const raised = run([bigPath, "--question", "q"], { BULK_READ_MAX_CHUNKS: "1000", NODE_OPTIONS: networkSentinel });
  assert.equal(raised.status, 5, raised.output);
  assert.match(raised.output, /NETWORK_SENTINEL/);
});

test("CLI: dry-run previews a plan above the default ceiling with a warning but refuses an explicit BULK_READ_MAX_CHUNKS", () => {
  const preview = run([bigPath, "--question", "q", "--dry-run"]);
  assert.equal(preview.status, 0, preview.output);
  assert.match(preview.stderr, /a live run would refuse: \d{2} chunks exceed the ceiling of 20 \(BULK_READ_MAX_CHUNKS\)/);

  const explicit = run([bigPath, "--question", "q", "--dry-run", "--json"], { BULK_READ_MAX_CHUNKS: "3" });
  assert.equal(explicit.status, 2, explicit.output);
  assert.equal(explicit.stdout, "");
  assert.match(explicit.stderr, /\d{2} chunks exceed the ceiling of 3 \(BULK_READ_MAX_CHUNKS\)/);
});

test("CLI: dry-run JSON exposes the 95% effective budget and plans against it", () => {
  const r = run([bigPath, "--question", "q", "--dry-run", "--json"]);
  assert.equal(r.status, 0, r.output);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.budgetTokens, 1000);
  assert.equal(parsed.effectiveBudget, 950);
  for (const line of parsed.chunkPlan) assert.ok(Number(/~(\d+) tokens/.exec(line)[1]) + parsed.reserveTokens <= 950, line);
});

test("CLI: non-2xx bodies are redacted against every secret env value of 8+ characters, not only the active key", () => {
  const mock = path.join(fixtureDir, "redact-mock.json");
  writeFileSync(mock, JSON.stringify([{ status: 500, body: "upstream failure other-vendor-token-VALUE short ab key" }]), "utf8");
  const r = run([bigPath, "--question", "q"], { BULK_READ_BUDGET_TOKENS: "100000", BULK_READ_FETCH_MOCK: mock, OTHER_TOKEN: "other-vendor-token-VALUE", TINY_KEY: "ab" });
  assert.equal(r.status, 5, r.output);
  assert.match(r.stderr, /HTTP 500 upstream failure \[redacted\] short ab key/);
});

test("CLI: bulletsCapped counts bullets dropped by --max-bullets", () => {
  const mock = path.join(fixtureDir, "capped-mock.json");
  writeFileSync(mock, JSON.stringify([{ status: 200, body: JSON.stringify({ choices: [{ message: { content: "- big.txt:1| one\n- big.txt:2| two\n- big.txt:3| three" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }]), "utf8");
  const r = run([bigPath, "--question", "q", "--max-bullets", "2", "--json"], { BULK_READ_BUDGET_TOKENS: "100000", BULK_READ_FETCH_MOCK: mock });
  assert.equal(r.status, 0, r.output);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.bullets, ["big.txt:1| one", "big.txt:2| two"]);
  assert.equal(parsed.bulletsCapped, 1);
});

test("CLI: a chunk failure prints the tokens spent so far before exiting 5", () => {
  const mock = path.join(fixtureDir, "partial-mock.json");
  writeFileSync(mock, JSON.stringify([
    { status: 200, body: JSON.stringify({ choices: [{ message: { content: "- big.txt:1| first" } }], usage: { prompt_tokens: 11, completion_tokens: 2 } }) },
    { status: 503, body: "down" },
  ]), "utf8");
  const r = run([bigPath, "--question", "q", "--json"], { BULK_READ_BUDGET_TOKENS: "20000", BULK_READ_FETCH_MOCK: mock });
  assert.equal(r.status, 5, r.output);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /HTTP 503/);
  assert.match(r.stderr, /after 1 of 2 chunks/);
  assert.match(r.stderr, /"promptTokens": ?11/);
  assert.match(r.stderr, /"completionTokens": ?2/);
});

test("planChunks keeps a page range on every split PDF part", () => {
  const extracted = Array.from({ length: 3 }, (_, p) => [`[page ${p + 1}]`, ...Array.from({ length: 10 }, (_, i) => `page ${p + 1} line ${i + 1}`)].join("\n")).join("\n");
  const text = wrapPdfWithPages("a.pdf", extracted);
  const plan = planChunks([{ path: "a.pdf", lines: 33, text }], 40);
  assert.ok(plan.length > 1);
  const ranges = plan.map((chunk) => /pages="(p\d+-p\d+)"/.exec(chunk.parts[0].text)?.[1]);
  assert.ok(ranges.every(Boolean), JSON.stringify(ranges));
  assert.equal(ranges[0], "p1-p1");
  assert.equal(ranges.at(-1).split("-")[1], "p3");
  for (const chunk of plan) assert.ok(estimateTokens(chunk.parts[0].text) <= 40);
});

function fakeFitz(name, source) {
  const dir = path.join(fixtureDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "fitz.py"), source, "utf8");
  return dir;
}

test("CLI: python runs with a sanitized env in utf8 mode and its stderr is redacted (skipped without python)", () => {
  if (spawnSync(python, ["-c", "pass"], { encoding: "utf8", timeout: 10_000 }).status !== 0) return console.log(`SKIP: ${python} unavailable`);
  const dir = fakeFitz("fitz-env", [
    "import os, sys",
    "keys = ['DEEPSEEK_API_KEY', 'OPENAI_PLATFORM_KEY', 'MY_TOKEN', 'SOME_SECRET', 'PYTHONPATH']",
    "sys.stderr.write(' '.join(f'{k}={os.environ.get(k, \"absent\")[:3]}' for k in keys))",
    "sys.stderr.write(f' probe={os.environ.get(\"LEAK_PROBE\")} utf8_mode={sys.flags.utf8_mode} ioenc={os.environ.get(\"PYTHONIOENCODING\")}')",
    "sys.exit(1)",
  ].join("\n"));
  const pdfPath = path.join(fixtureDir, "env.pdf");
  writeFileSync(pdfPath, "%PDF-1.4\n", "utf8");
  const r = run([pdfPath, "--question", "q", "--dry-run"], { PYTHONPATH: dir, MY_TOKEN: `${fakeKey}-tok`, SOME_SECRET: "hush-hush", LEAK_PROBE: fakeKey });
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /DEEPSEEK_API_KEY=abs OPENAI_PLATFORM_KEY=abs MY_TOKEN=abs SOME_SECRET=abs PYTHONPATH=(?!abs)/);
  assert.match(r.stderr, /probe=\[redacted\] utf8_mode=1 ioenc=utf-8/);
  assert.doesNotMatch(r.output, /sk-fake|hush-hush/);
});

test("CLI: PDF text containing U+FFFD exits 3 naming the PDF (skipped without python)", () => {
  if (spawnSync(python, ["-c", "pass"], { encoding: "utf8", timeout: 10_000 }).status !== 0) return console.log(`SKIP: ${python} unavailable`);
  const dir = fakeFitz("fitz-fffd", [
    "class Page:",
    "    def get_text(self): return 'fine\\n\\ufffdbroken\\n'",
    "def open(path): return [Page()]",
  ].join("\n"));
  const pdfPath = path.join(fixtureDir, "mojibake.pdf");
  writeFileSync(pdfPath, "%PDF-1.4\n", "utf8");
  const r = run([pdfPath, "--question", "q", "--dry-run"], { PYTHONPATH: dir });
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /mojibake\.pdf/);
  assert.match(r.stderr, /U\+FFFD/);
  assert.doesNotMatch(r.output, /broken/);
});

test("CLI: PDF exits 3 when the python interpreter is unavailable", () => {
  const pdfPath = path.join(fixtureDir, "unreadable.pdf");
  writeFileSync(pdfPath, "%PDF-1.4\n", "utf8");
  const r = run([pdfPath, "--question", "q", "--dry-run"], { BULK_READ_PYTHON: path.join(fixtureDir, "no-python.exe") });
  assert.equal(r.status, 3, r.output);
  assert.match(r.output, /PyMuPDF|fitz/);
});
