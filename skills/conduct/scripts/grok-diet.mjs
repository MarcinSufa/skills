#!/usr/bin/env node
/**
 * Dispatch a grok worker on the token diet (conduct references/token-hygiene.md,
 * Grok contract; recipe in references/grok.md). Home vars stay real: grok's ten
 * GROK_CLAUDE_ and GROK_CURSOR_ compat
 * switches plus a slim GROK_HOME with a [skills] ignore list cut the first-turn prefix by 48%,
 * while redirecting USERPROFILE only managed 7% and broke git identity. Stale diet dirs are
 * pruned on every real run; --dry-run touches nothing under tmpdir.
 *
 * Usage:
 *   grok-diet.mjs --cwd <worktree> --prompt-file <brief> [--model <id>]
 *                 [--max-turns 80] [--dry-run] [-- <extra grok args>]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export const DIET_SWITCHES = Object.freeze([
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED",
  "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
  "GROK_CURSOR_RULES_ENABLED",
]);

const DIET_DIR_PREFIX = "grok-diet-";
const DIET_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pulls one `[model.<id>]` table out of a grok config.toml; null when absent. */
export function extractModelBlock(config, modelId) {
  const escapedModelId = escapeRegExp(modelId);
  const header = new RegExp(`^\\[model\\.(?:"${escapedModelId}"|${escapedModelId})\\]\\s*$`, "m");
  const start = config.search(header);
  if (start === -1) return null;
  const rest = config.slice(start);
  const next = rest.slice(1).search(/^\[/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

export function buildDietEnv(ambient, dietHome) {
  const env = { ...ambient, GROK_HOME: dietHome };
  for (const name of DIET_SWITCHES) env[name] = "false";
  return env;
}

export function buildDietConfig(modelBlock) {
  const modelSection = modelBlock == null || modelBlock === "" ? "" : `${modelBlock.trimEnd()}\n\n`;
  return `[cli]\ninstaller = "internal"\n\n${modelSection}[skills]\nignore = ["~/.agents/skills", "~/.claude/skills", "~/.claude/plugins"]\n`;
}

export function pruneStaleDietDirs(root, nowMs, maxAgeMs, remove = rmSync) {
  const removed = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(DIET_DIR_PREFIX)) continue;
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() || nowMs - stat.mtimeMs <= maxAgeMs) continue;
      remove(path, { recursive: true, force: true, maxRetries: 3 });
      removed.push(path);
    } catch {
      continue;
    }
  }
  return removed;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function main() {
  const cwd = arg("cwd");
  const promptFile = arg("prompt-file");
  const model = arg("model", "deepseek-v4-flash");
  const maxTurns = arg("max-turns", "80");
  const dryRun = process.argv.includes("--dry-run");
  const passThrough = process.argv.includes("--") ? process.argv.slice(process.argv.indexOf("--") + 1) : [];

  if (!cwd || !promptFile) {
    console.error("usage: grok-diet.mjs --cwd <worktree> --prompt-file <brief> [--model <id>] [--max-turns 80] [--dry-run]");
    process.exit(2);
  }
  if (!existsSync(promptFile)) {
    console.error(`brief not found: ${promptFile}`);
    process.exit(2);
  }

  const realGrok = join(homedir(), ".grok");
  const configPath = join(realGrok, "config.toml");
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const block = extractModelBlock(config, model);
  if (block === null) {
    console.error(`grok-diet: no [model.${model}] block; treating ${model} as a built-in Grok model`);
  }

  const args = [
    "--prompt-file", promptFile,
    "--cwd", cwd,
    "-m", model,
    "--permission-mode", "bypassPermissions",
    "--max-turns", String(maxTurns),
    "--output-format", "plain",
    ...passThrough,
  ];
  // Full path, never PATH + shell: the binary is not on the tool-shell PATH, and a shell would
  // re-split worktree paths containing a space.
  const exe = join(realGrok, "bin", process.platform === "win32" ? "grok.exe" : "grok");
  const bin = existsSync(exe) ? exe : "grok";

  if (dryRun) {
    console.log(`model block: ${block === null ? "none (built-in)" : "custom (from config.toml)"}`);
    console.log(`GROK_HOME=${join(tmpdir(), `${DIET_DIR_PREFIX}XXXXXX`)} (would be created)`);
    console.log([bin, ...args].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "));
    return;
  }

  pruneStaleDietDirs(tmpdir(), Date.now(), DIET_DIR_MAX_AGE_MS);
  const dietHome = mkdtempSync(join(tmpdir(), DIET_DIR_PREFIX));
  for (const file of ["auth.json", "models_cache.json"]) {
    const from = join(realGrok, file);
    if (existsSync(from)) copyFileSync(from, join(dietHome, file));
  }
  writeFileSync(join(dietHome, "config.toml"), buildDietConfig(block), "utf8");
  const env = buildDietEnv(process.env, dietHome);

  const run = spawnSync(bin, args, { env, stdio: "inherit" });
  console.error(`usage log: ${join(dietHome, "logs", "unified.jsonl")}`);
  process.exit(run.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("grok-diet.mjs")) main();
