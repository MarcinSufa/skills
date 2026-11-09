#!/usr/bin/env node
// PreToolUse guard for a conductor session: the Iron Rule ("the conductor never implements"),
// enforced instead of prompted. Loaded only through settings/conductor-settings.json (claude --settings <that file>).
//
// - Subagents are workers: a hook payload carrying `agent_id` comes from a subagent and passes untouched
//   (Claude Code sets agent_id only inside a subagent; the main thread of an `--agent` session has
//   agent_type without agent_id, so it is still guarded).
// - Edit/Write/MultiEdit/NotebookEdit on the main thread: allowed only for conductor artifacts
//   (see writable()); everything else is denied.
// - Bash on the main thread: a shell-ish parse looks for file writes (redirects, tee, sed -i, cp/mv/rm,
//   dd of=, git apply, inline interpreter code that writes...). This part is a HEURISTIC, not a sandbox;
//   the known escapes are listed in the skill's README.md ("Conductor guard").
//
// CONDUCT_GUARD picks the mode (operator-only: the model cannot set the hook's env):
//   unset/shadow - never blocks; each would-be denial is appended to <CONDUCT_HOME>/conductor-guard-shadow.ndjson
//   enforce/on   - blocks
//   off          - disables the guard
// Shadow is the default; switch to enforce after reviewing the shadow log,
// by changing DEFAULT_MODE below (or per launch: export CONDUCT_GUARD=enforce).
// CONDUCT_BRIEF_DIR adds directories (path-delimiter separated) where the conductor may write artifacts.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homeRoot } from "./lib/events-store.mjs";

export const DEFAULT_MODE = "shadow"; // flip to "enforce" after the shadow log review
const MODES = { shadow: "shadow", enforce: "enforce", on: "enforce", off: "off" };
// Unknown values fall back to the default rather than guessing.
export const guardMode = (env = process.env) => MODES[String(env.CONDUCT_GUARD ?? "").trim().toLowerCase()] ?? DEFAULT_MODE;
export const shadowLogPath = () => path.join(homeRoot(), "conductor-guard-shadow.ndjson");

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DOC_DIRS = new Set(["briefs", "specs", "plans", "docs"]);
const DOC_EXT = new Set([".md", ".markdown", ".txt"]);
const ARTIFACT_EXT = new Set([...DOC_EXT, ".json", ".jsonl", ".ndjson", ".patch", ".diff", ".log"]);
const SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "-"]);

const expandHome = (p, home) => (p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p);
const inside = (file, dir) => { const rel = path.relative(dir, file); return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); };

// Where the main thread may write: .conduct/ artifacts (briefs, fusion, ledger, diff patches, worker jsonl,
// event payloads), prose under briefs/specs/plans/docs, Claude's own plan/memory files, $CONDUCT_BRIEF_DIR,
// and artifact files in the OS temp dir. Never code: the extension list carries no executable format.
export function writable(file, { cwd = process.cwd(), env = {}, home = os.homedir() } = {}) {
  if (!file) return false;
  if (SINKS.has(file)) return true;
  const abs = path.resolve(cwd, expandHome(file, home));
  const ext = path.extname(abs).toLowerCase();
  const segments = path.dirname(abs).split(/[\\/]+/);
  const extra = (env.CONDUCT_BRIEF_DIR ?? "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(cwd, expandHome(d, home)));
  if (ARTIFACT_EXT.has(ext) && (segments.includes(".conduct") || extra.some((d) => inside(abs, d)) || inside(abs, os.tmpdir()))) return true;
  if (!DOC_EXT.has(ext)) return false;
  const claude = path.join(home, ".claude");
  if (inside(abs, path.join(claude, "plans"))) return true;
  if (inside(abs, path.join(claude, "projects")) && segments.includes("memory")) return true;
  return segments.some((s) => DOC_DIRS.has(s));
}

function inArtifactDir(file, { cwd = process.cwd(), env = {}, home = os.homedir() } = {}) {
  const abs = path.resolve(cwd, expandHome(file, home));
  const extra = (env.CONDUCT_BRIEF_DIR ?? "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(cwd, expandHome(d, home)));
  return abs.split(/[\\/]+/).includes(".conduct") || extra.some((d) => inside(abs, d));
}

// ---------- shell parsing ----------

// Reads a balanced "( ... )" body starting after the opening paren; quotes are respected.
function readBalanced(src, i) {
  let depth = 1, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === "\\" && q === '"') j++; else if (c === q) q = null; continue; }
    if (c === "\\") { j++; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { inner: src.slice(i, j), end: j + 1 };
  }
  throw new Error("unbalanced parenthesis");
}

// Splits a command line into simple commands: { words, redirects: [{op, target}], stdin: [heredoc bodies] }.
// Command substitutions and process substitutions are parsed recursively and appended as commands.
export function parseShell(src) {
  const cmds = [], subs = [], heredocs = [];
  let cur, word = null, pending = null, i = 0;
  const newCmd = () => { cur = { words: [], redirects: [], stdin: [] }; cmds.push(cur); };
  const append = (s) => { word = (word ?? "") + s; };
  const flush = () => {
    if (word === null) return;
    if (pending?.kind === "redirect") cur.redirects.push({ op: pending.op, target: word });
    else if (pending?.kind === "heredoc") heredocs.push({ cmd: cur, delim: word, strip: pending.strip });
    else if (pending?.kind === "herestring") cur.stdin.push(word);
    else if (pending?.kind !== "input") cur.words.push(word);
    pending = null; word = null;
  };
  const sep = () => { flush(); if (pending) throw new Error("redirect without target"); newCmd(); };
  const readHeredocs = () => {
    for (const h of heredocs.splice(0)) {
      const lines = [];
      for (;;) {
        if (i >= src.length) throw new Error(`unterminated heredoc ${h.delim}`);
        const nl = src.indexOf("\n", i), end = nl < 0 ? src.length : nl;
        const line = src.slice(i, end); i = end + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        lines.push(line);
      }
      h.cmd.stdin.push(lines.join("\n"));
    }
  };
  newCmd();
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === " " || c === "\t") { flush(); i++; continue; }
    if (c === "\n") { sep(); i++; readHeredocs(); continue; }
    if (c === "#" && word === null) { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "\\") { if (n === "\n") i += 2; else { append(n ?? ""); i += 2; } continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e < 0) throw new Error("unterminated quote"); append(src.slice(i + 1, e)); i = e + 1; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[++j]; continue; }
        if (src[j] === "$" && src[j + 1] === "(") { const b = readBalanced(src, j + 2); subs.push(b.inner); s += "$(…)"; j = b.end - 1; continue; }
        if (src[j] === "`") { const e = src.indexOf("`", j + 1); if (e < 0) throw new Error("unterminated backtick"); subs.push(src.slice(j + 1, e)); s += "`…`"; j = e; continue; }
        s += src[j];
      }
      if (j >= src.length) throw new Error("unterminated quote");
      append(s); i = j + 1; continue;
    }
    if (c === "$" && n === "(") { const b = readBalanced(src, i + 2); subs.push(b.inner); append("$(…)"); i = b.end; continue; }
    if (c === "`") { const e = src.indexOf("`", i + 1); if (e < 0) throw new Error("unterminated backtick"); subs.push(src.slice(i + 1, e)); append("`…`"); i = e + 1; continue; }
    if ((c === "<" || c === ">") && n === "(" && word === null) { const b = readBalanced(src, i + 2); subs.push(b.inner); append("/dev/fd/…"); i = b.end; continue; }
    if (c === ";" || c === "|" || c === "(" || c === ")") { sep(); i += (c === "|" && (n === "|" || n === "&")) || (c === ";" && n === ";") ? 2 : 1; continue; }
    if (c === "&") {
      if (n === ">") { flush(); const app = src[i + 2] === ">"; pending = { kind: "redirect", op: app ? "&>>" : "&>" }; i += app ? 3 : 2; continue; }
      sep(); i += n === "&" ? 2 : 1; continue;
    }
    if (c === ">" || c === "<") {
      if (word !== null && /^\d+$/.test(word)) word = null; else flush();
      if (c === ">") {
        const op = n === ">" ? ">>" : ">"; i += n === ">" || n === "|" ? 2 : 1;
        if (src[i] === "&" && /[\d-]/.test(src[i + 1] ?? "")) { i++; while (/[\d-]/.test(src[i] ?? "")) i++; continue; }
        if (src[i] === "&") i++;
        pending = { kind: "redirect", op }; continue;
      }
      if (n === "<" && src[i + 2] === "<") { pending = { kind: "herestring" }; i += 3; continue; }
      if (n === "<") { const strip = src[i + 2] === "-"; pending = { kind: "heredoc", strip }; i += strip ? 3 : 2; continue; }
      if (n === "&") { i += 2; while (/[\d-]/.test(src[i] ?? "")) i++; continue; }
      if (n === ">") { pending = { kind: "redirect", op: "<>" }; i += 2; continue; }
      pending = { kind: "input" }; i++; continue;
    }
    append(c); i++;
  }
  flush();
  if (pending) throw new Error("redirect without target");
  if (heredocs.length) throw new Error("unterminated heredoc");
  const out = cmds.filter((cmd) => cmd.words.length || cmd.redirects.length || cmd.stdin.length);
  for (const s of subs) out.push(...parseShell(s));
  return out;
}

// ---------- command rules ----------

const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "in", "time", "case", "esac"]);
// wrapper -> options that consume the next word
const WRAPPERS = {
  sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-U"], env: ["-u", "-C", "-S"], command: [], builtin: [], exec: ["-a"], nohup: [],
  nice: ["-n"], ionice: ["-c", "-n"], stdbuf: ["-i", "-o", "-e"], timeout: ["-s", "-k"], xargs: ["-I", "-i", "-n", "-L", "-P", "-d", "-a", "-E", "-s"],
  npx: ["-p", "--package"], bunx: [], pnpx: [], uvx: ["--from", "--with"], flock: ["-w", "-E"], setsid: [], chronic: [], unbuffer: [],
};
const INTERPRETERS = {
  python: { inline: ["-c"], value: ["-m", "-W", "-X"], module: "-m" },
  node: { inline: ["-e", "--eval", "-p", "--print"], value: ["-r", "--require", "--import", "--loader", "--input-type", "--env-file", "-C", "--conditions"] },
  bun: { inline: ["-e", "--eval", "-p", "--print"], value: [] },
  deno: { inline: ["eval"], value: [] },
  perl: { inline: ["-e", "-E"], value: ["-I", "-M", "-m"], inplace: true },
  ruby: { inline: ["-e"], value: ["-I", "-r"], inplace: true },
  php: { inline: ["-r"], value: ["-d", "-c"] },
  bash: { inline: ["-c"], value: ["-o", "-O"], shell: true }, sh: { inline: ["-c"], value: ["-o"], shell: true },
  zsh: { inline: ["-c"], value: ["-o"], shell: true }, dash: { inline: ["-c"], value: [], shell: true },
};
const interpreterOf = (name) => INTERPRETERS[name] ?? (/^python[\d.]*$/.test(name) ? INTERPRETERS.python : /^(node|nodejs)\d*$/.test(name) ? INTERPRETERS.node : null);
// Inline code that writes files. Deliberately broad: a false positive costs the conductor one
// rephrase (or a worker dispatch); a false negative is a silent role break.
const WRITE_CODE = [
  /(?<!std(?:out|err)\.)\bwrite(?:File|FileSync|Sync|_text|_bytes|lines)?\s*\(/,
  /\b(?:appendFile|createWriteStream|copyFile|cpSync|renameSync|rename|unlink|unlinkSync|rmSync|rmdirSync|truncate|truncateSync|mkdtemp)\s*\(/,
  /\b(?:shutil\.\w+|os\.(?:remove|replace|rename|unlink|truncate)|\.touch\(|file_put_contents|File\.write|IO\.write|FileUtils\.)/,
  /\bopen\s*\([^)]*?,\s*(?:mode\s*=\s*)?['"][rbt]*[wax+]/, /\.open\(\s*['"][rbt]*[wax+]/,
  /\bopen\s*(?:\(|my\b|\$|\w)[^;]*['"]\s*\+?>/, /\bsystem\s*\(|\bexec(?:Sync|FileSync)?\s*\(|\bspawn(?:Sync)?\s*\(|subprocess\b|os\.system/,
];
const FORMATTERS = {
  prettier: (a) => a.some((x) => x === "--write" || x === "-w"), eslint: (a) => a.some((x) => x.startsWith("--fix")),
  biome: (a) => a.some((x) => /^--(write|apply|fix)/.test(x)), ruff: (a) => a[0] === "format" || a.some((x) => x.startsWith("--fix")) && !a.includes("--no-fix"),
  black: (a) => !a.some((x) => x === "--check" || x === "--diff"), gofmt: (a) => a.includes("-w"), goimports: (a) => a.includes("-w"),
  rustfmt: (a) => !a.includes("--check"), dprint: (a) => a[0] === "fmt", "clang-format": (a) => a.includes("-i"),
};

const positional = (args, valueOpts = []) => {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") { out.push(...args.slice(k + 1)); break; }
    if (a.startsWith("-") && a !== "-") { if (valueOpts.includes(a)) k++; continue; }
    out.push(a);
  }
  return out;
};

function stripPrefixes(words) {
  let w = [...words];
  for (let changed = true; changed && w.length;) {
    changed = false;
    while (w.length && (KEYWORDS.has(w[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) { w.shift(); changed = true; }
    const name = path.basename(w[0] ?? "");
    if (name in WRAPPERS) {
      w.shift(); changed = true;
      while (w.length && (w[0].startsWith("-") || (name === "env" && w[0].includes("=")))) { const o = w.shift(); if (WRAPPERS[name].includes(o)) w.shift(); }
      if ((name === "timeout" || name === "flock") && w.length > 1) w.shift(); // duration / lock file
    } else if ((name === "pnpm" || name === "yarn") && (w[1] === "exec" || w[1] === "dlx")) { w.splice(0, 2); changed = true; }
  }
  return w;
}

function checkInterpreter(name, spec, args, stdin, ctx, depth) {
  if (spec.inplace && args.some((a) => /^-[^-IMm]/.test(a) && a.slice(1).includes("i"))) return `${name} -i (in-place edit)`;
  const inline = [];
  let script = null, module = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (spec.inline.includes(a)) { inline.push(args[k + 1] ?? ""); k++; if (spec.shell) break; continue; }
    if (spec.module && a === spec.module) { module = args[k + 1]; break; }
    if (spec.value.includes(a)) { k++; continue; }
    if (a === "-" || a === "--") break;
    if (a.startsWith("-")) {
      // combined short flags such as `python3 -Bc '...'` or `perl -ne '...'`
      const hit = spec.inline.find((f) => f.length === 2 && !f.startsWith("--") && a.length > 2 && !a.startsWith("--") && a.endsWith(f[1]));
      if (hit) { inline.push(args[k + 1] ?? ""); k++; if (spec.shell) break; }
      continue;
    }
    script = a; break;
  }
  if (inline.length) {
    if (spec.shell) for (const code of inline) { const r = analyzeBash(code, ctx, depth + 1); if (r) return r; }
    else if (inline.some((code) => WRITE_CODE.some((re) => re.test(code)))) return `${name} inline code that writes files or spawns processes`;
    return null;
  }
  if (module) return FORMATTERS[module] ? checkFormatter(module, args.slice(args.indexOf(module) + 1)) : null;
  if (script) return writable(script, ctx) ? `${name} running ${script}, a file the conductor can write (write-then-execute bypass)` : null;
  if (!stdin.length) return args.length === 0 || args.includes("-") ? `${name} reading code from stdin/pipe (cannot be inspected)` : null;
  for (const body of stdin) {
    if (spec.shell) { const r = analyzeBash(body, ctx, depth + 1); if (r) return r; }
    else if (WRITE_CODE.some((re) => re.test(body))) return `${name} heredoc code that writes files or spawns processes`;
  }
  return null;
}
const checkFormatter = (name, args) => (FORMATTERS[name]?.(args) ? `${name} rewriting files in place` : null);

function checkCommand(cmd, ctx, depth) {
  for (const r of cmd.redirects) if (!writable(r.target, ctx)) return `redirect ${r.op} ${r.target}`;
  const words = stripPrefixes(cmd.words);
  if (!words.length) return null;
  const name = path.basename(words[0]);
  // xargs supplies file arguments from stdin: model them as an unknown (never writable) path
  const args = cmd.words.some((w) => path.basename(w) === "xargs") ? [...words.slice(1), "<xargs-input>"] : words.slice(1);
  const notWritable = (files) => files.find((f) => !writable(f, ctx));
  // Deleting/creating empty files inside .conduct/ (or $CONDUCT_BRIEF_DIR) is housekeeping, whatever the extension.
  const notTouchable = (files) => files.find((f) => !writable(f, ctx) && !inArtifactDir(f, ctx));
  const interp = interpreterOf(name);
  if (interp) return checkInterpreter(name, interp, args, cmd.stdin, ctx, depth);
  if (FORMATTERS[name]) return checkFormatter(name, args);
  switch (name) {
    case "eval": return analyzeBash(args.join(" "), ctx, depth + 1);
    case "tee": { const f = notWritable(positional(args)); return f ? `tee ${f}` : null; }
    case "sed": return args.some((a) => a === "--in-place" || a.startsWith("--in-place=") || /^-[a-zA-Z]*i/.test(a)) ? "sed -i (in-place edit)" : null;
    case "awk": case "gawk": { const prog = args.join(" "); return /(^|\s)-i\s*inplace/.test(prog) || /\bprint[^|;]*>\s*"/.test(prog) ? "awk writing files" : null; }
    case "cp": case "install": case "ln": case "rsync": case "scp": {
      const t = args.findIndex((a) => a === "-t" || a === "--target-directory");
      const pos = positional(args, ["-t", "--target-directory", "-m", "--mode", "-o", "-g", "-S", "--suffix"]);
      const dest = t >= 0 ? args[t + 1] : pos.at(-1);
      return dest && !writable(dest, ctx) ? `${name} into ${dest}` : null;
    }
    case "mv": { const f = notWritable(positional(args, ["-t", "--target-directory", "-S", "--suffix"])); return f ? `mv ${f}` : null; }
    case "rm": case "unlink": case "shred": case "rmdir": { const f = notTouchable(positional(args)); return f ? `${name} ${f}` : null; }
    case "truncate": { const f = notTouchable(positional(args, ["-s", "--size", "-r", "--reference"])); return f ? `truncate ${f}` : null; }
    case "touch": { const f = notTouchable(positional(args, ["-d", "-t", "-r", "--date", "--reference"])); return f ? `touch ${f}` : null; }
    case "dd": { const of = args.find((a) => a.startsWith("of=")); return of && !writable(of.slice(3), ctx) ? `dd ${of}` : null; }
    case "patch": return args.includes("--dry-run") ? null : "patch (applying a diff is implementing)";
    case "curl": {
      if (args.some((a) => a === "-O" || a === "--remote-name" || /^-[a-zA-Z]*O$/.test(a))) return "curl -O (download into the tree)";
      const k = args.findIndex((a) => a === "-o" || a === "--output");
      const out = k >= 0 ? args[k + 1] : args.find((a) => /^-o./.test(a))?.slice(2);
      return out && !writable(out, ctx) ? `curl -o ${out}` : null;
    }
    case "wget": {
      if (args.includes("--spider")) return null;
      const k = args.findIndex((a) => a === "-O" || a === "--output-document");
      const out = k >= 0 ? args[k + 1] : args.find((a) => /^-O./.test(a) || a.startsWith("--output-document="))?.replace(/^(-O|--output-document=)/, "");
      return !out || !writable(out, ctx) ? `wget writing ${out ?? "a file"}` : null;
    }
    case "find": {
      if (args.includes("-delete")) return "find -delete";
      for (let k = 0; k < args.length; k++) if (["-exec", "-execdir", "-ok", "-okdir"].includes(args[k])) {
        const end = args.findIndex((a, j) => j > k && (a === ";" || a === "+"));
        const r = checkCommand({ words: args.slice(k + 1, end < 0 ? undefined : end), redirects: [], stdin: [] }, ctx, depth + 1);
        if (r) return `find -exec: ${r}`;
      }
      return null;
    }
    case "git": {
      let k = 0;
      while (k < args.length && args[k].startsWith("-")) k += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[k]) ? 2 : 1;
      const sub = args[k], rest = args.slice(k + 1);
      if (sub === "apply") return rest.some((a) => ["--check", "--stat", "--numstat", "--summary"].includes(a)) && !rest.includes("--apply") ? null : "git apply (applying a diff is implementing)";
      if (sub === "am") return rest.some((a) => ["--abort", "--show-current-patch"].includes(a)) ? null : "git am (applying patches is implementing)";
      if (sub === "commit" && rest.some((a) => a === "--all" || /^-[a-zA-Z]*a/.test(a))) return "git commit -a (committing unreviewed working-tree changes)";
      return null;
    }
    default: return null;
  }
}

// Returns a block reason, or null when the command looks write-free.
export function analyzeBash(command, ctx = {}, depth = 0) {
  if (depth > 8) return "nested shell too deep to inspect";
  let cmds;
  try { cmds = parseShell(command); } catch (err) { return `could not parse the command (${err.message})`; }
  let local = ctx;
  for (const cmd of cmds) {
    const r = checkCommand(cmd, local, depth); if (r) return r;
    // follow a plain `cd <dir>` so later relative paths resolve where the shell will write them
    if (cmd.words[0] === "cd" && cmd.words[1]) local = { ...local, cwd: path.resolve(local.cwd ?? process.cwd(), expandHome(cmd.words[1], local.home ?? os.homedir())) };
  }
  return null;
}

const ADVICE =
  "The conduct Iron Rule: the conductor never implements, and this session runs with the conductor guard. " +
  "Do not retry the same change through another tool or shell trick. Instead: write the change as a brief " +
  "(.conduct/brief-<slice>.md) and dispatch a worker - an external CLI worker (codex/grok/cursor or a repo worker script) " +
  "or an Agent/Task subagent (SDD); subagents are not guarded. The conductor may write .md/.json/.jsonl/.patch under .conduct/ " +
  "and .md/.txt under briefs/, specs/, plans/, docs/ (plus $CONDUCT_BRIEF_DIR).";

// Returns { deny: reason } or { allow: true } for one PreToolUse payload. Shadow vs enforce is the caller's call.
export function decide(p, env = process.env, home = os.homedir()) {
  if (guardMode(env) === "off" || p.agent_id) return { allow: true };
  const ctx = { cwd: p.cwd || process.cwd(), env, home };
  if (EDIT_TOOLS.has(p.tool_name)) {
    const file = p.tool_input?.file_path ?? p.tool_input?.notebook_path;
    return writable(file, ctx) ? { allow: true } : { deny: `${p.tool_name} on ${file ?? "(no path)"} - not a conductor artifact` };
  }
  if (p.tool_name === "Bash") {
    const r = analyzeBash(String(p.tool_input?.command ?? ""), ctx);
    return r ? { deny: `Bash: ${r}` } : { allow: true };
  }
  return { allow: true };
}

export function hookOutput(result) {
  if (!result.deny) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `conductor-guard blocked: ${result.deny}. ${ADVICE}` } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let p;
  try { p = JSON.parse(readFileSync(0, "utf8")); } catch (err) {
    process.stderr.write(`conductor-guard: unreadable hook input (${err.message}); blocking to stay safe\n`);
    process.exit(2);
  }
  const result = decide(p);
  if (result.deny && guardMode() === "shadow") {
    try {
      mkdirSync(homeRoot(), { recursive: true });
      const input = String(p.tool_input?.file_path ?? p.tool_input?.notebook_path ?? p.tool_input?.command ?? "").slice(0, 300);
      appendFileSync(shadowLogPath(), JSON.stringify({ ts: new Date().toISOString(), sessionId: p.session_id, cwd: p.cwd, tool: p.tool_name, input, reason: result.deny }) + "\n");
    } catch { /* shadow mode must never block */ }
    process.exit(0);
  }
  const out = hookOutput(result);
  if (out) process.stdout.write(out + "\n");
  process.exit(0);
}
