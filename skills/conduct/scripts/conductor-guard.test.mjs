import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MODE, analyzeBash, decide, guardMode, hookOutput, parseShell, writable } from "./conductor-guard.mjs";

const cli = new URL("./conductor-guard.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
const settingsPath = new URL("../settings/conductor-settings.json", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
const cwd = path.resolve(tmpdir(), "..", "repo");
const home = path.resolve(tmpdir(), "..", "home");
const ctx = { cwd, env: {}, home };
const bash = (command) => analyzeBash(command, ctx);
const tool = (tool_name, tool_input, extra = {}) => decide({ hook_event_name: "PreToolUse", session_id: "s", cwd, tool_name, tool_input, ...extra }, {}, home);

test("Edit/Write/MultiEdit/NotebookEdit on code and tests are denied on the main thread", () => {
  for (const [name, input] of [
    ["Edit", { file_path: path.join(cwd, "src/foo.ts") }],
    ["Write", { file_path: "test/foo.test.ts" }],
    ["MultiEdit", { file_path: path.join(cwd, "package.json") }],
    ["NotebookEdit", { notebook_path: path.join(cwd, "docs/n.ipynb") }],
    ["Write", { file_path: path.join(cwd, ".conduct/gate-x.mjs") }],
    ["Write", { file_path: path.join(cwd, ".claude/settings.local.json") }],
    ["Write", { file_path: path.join(cwd, ".conduct/../src/x.md") }],
  ]) assert.match(tool(name, input).deny, new RegExp(`^${name} on `), `${name} ${JSON.stringify(input)}`);
});

test("conductor artifacts are writable", () => {
  for (const file of [
    ".conduct/brief-x.md", ".conduct/ledger.md", ".conduct/x-diff.patch", ".conduct/payload.json", ".conduct/luna-x.jsonl",
    "docs/superpowers/specs/2026-11-02-x.md", "briefs/lead-x.md", "plans/p.md", "specs/s.txt",
    path.join(home, ".claude/plans/plan.md"), path.join(home, ".claude/projects/-repo/memory/m.md"), path.join(tmpdir(), "payload.json"),
  ]) assert.deepEqual(tool("Write", { file_path: file }), { allow: true }, file);
  assert.equal(writable("src/notes.md", ctx), false);
  assert.equal(writable("docs/fixtures/hook.json", ctx), false);
});

test("CONDUCT_BRIEF_DIR adds artifact directories", () => {
  const extra = path.resolve(cwd, "..", "brief-store");
  assert.equal(writable(path.join(extra, "a.md"), ctx), false);
  assert.equal(writable(path.join(extra, "a.json"), { ...ctx, env: { CONDUCT_BRIEF_DIR: extra } }), true);
  assert.equal(writable(path.join(extra, "a.ts"), { ...ctx, env: { CONDUCT_BRIEF_DIR: extra } }), false);
});

test("subagents (agent_id) pass; an --agent main thread (agent_type only) is still guarded", () => {
  assert.deepEqual(tool("Edit", { file_path: "src/foo.ts" }, { agent_id: "a1", agent_type: "general-purpose" }), { allow: true });
  assert.deepEqual(tool("Bash", { command: "sed -i s/a/b/ src/foo.ts" }, { agent_id: "a1" }), { allow: true });
  assert.ok(tool("Edit", { file_path: "src/foo.ts" }, { agent_type: "conductor" }).deny);
});

test("CONDUCT_GUARD modes: unset/unknown -> shadow (default), enforce/on -> enforce, off -> off", () => {
  assert.equal(DEFAULT_MODE, "shadow");
  for (const v of [undefined, "", "shadow", "bogus"]) assert.equal(guardMode({ CONDUCT_GUARD: v }), "shadow", String(v));
  for (const v of ["enforce", "on", "ENFORCE"]) assert.equal(guardMode({ CONDUCT_GUARD: v }), "enforce", v);
  assert.equal(guardMode({ CONDUCT_GUARD: "off" }), "off");
});

test("CONDUCT_GUARD=off disables the guard", () => {
  assert.deepEqual(decide({ tool_name: "Write", cwd, tool_input: { file_path: "src/a.ts" } }, { CONDUCT_GUARD: "off" }, home), { allow: true });
});

test("read-only tools and read-only shell are allowed", () => {
  assert.deepEqual(tool("Read", { file_path: "src/foo.ts" }), { allow: true });
  assert.deepEqual(tool("Grep", { pattern: "x" }), { allow: true });
  for (const c of [
    "ls -la", "cat src/foo.ts | grep -n bar", "git status && git diff --stat", "rg foo src 2>/dev/null", "npm test 2>&1 | tail -20",
    "node --test test/", "node -v", "python3 -m pytest -q", "node skills/conduct/scripts/preflight-close.mjs . --slice x --diff-patch > .conduct/x-diff.patch",
    "git worktree add ../wt -b slice/x origin/main", "git merge --no-ff slice/x", "git commit -m 'add a thing'",
    "git apply --check .conduct/x.patch", "mkdir -p .conduct", "rm -rf .conduct/tmp", "find . -name '*.ts' -exec grep -l foo {} +",
    "python3 -c 'import json,sys; print(json.load(sys.stdin)[\"a\"])' < .conduct/p.json", "node -e 'console.log(1 > 0)'",
    "echo \"a > b\"", "jq . <<< '{\"a\":1}'", "cd .conduct && echo ok > note.md",
  ]) assert.equal(bash(c), null, c);
});

test("dispatching workers is allowed, including their output redirects into .conduct/", () => {
  for (const c of [
    './worker.sh "edit src/foo.ts per .conduct/brief-x.md"',
    'codex exec -m gpt-5.6-luna --json -o .conduct/luna-x.md "reply > done" < /dev/null > .conduct/luna-x.jsonl 2> .conduct/luna-x.stderr.txt',
    "grok --prompt-file .conduct/brief-x.md -m grok-5 --cwd ../wt > .conduct/grok-x.jsonl",
    "cursor-agent -p --output-format json \"$(cat .conduct/brief-x.md)\" > .conduct/composer-x.json",
    "node \"$CLAUDE_SKILL_DIR/scripts/conduct-events.mjs\" emit --type task.phase --payload-file .conduct/p.json",
    "node .conduct/gate-x.mjs",
  ]) assert.equal(bash(c), null, c);
});

test("shell writes to code are denied", () => {
  const cases = {
    "echo 'export const x = 1' > src/foo.ts": /redirect > src\/foo\.ts/,
    "printf x >> src/foo.ts": /redirect >> /,
    "cat > src/foo.ts <<'EOF'\nexport const x = 1\nEOF": /redirect > src\/foo\.ts/,
    "echo x &> src/a.ts": /redirect &>/,
    "echo x 2>src/err.ts": /redirect > src\/err\.ts/,
    "echo x | tee src/foo.ts": /^tee src/,
    "echo x | tee -a .conduct/n.md src/foo.ts": /^tee src/,
    "sed -i 's/a/b/' src/foo.ts": /sed -i/, "sed -i.bak -e 's/a/b/' src/foo.ts": /sed -i/, "sed --in-place 's/a/b/' x.ts": /sed -i/,
    "perl -pi -e 's/a/b/' src/foo.ts": /perl -i/, "ruby -i -pe 'x' a.rb": /ruby -i/,
    "cp /tmp/foo.ts src/foo.ts": /^cp into src/, "mv .conduct/foo.md src/foo.ts": /^mv /, "install -m 644 a src/b.ts": /^install into/,
    "rm src/foo.ts": /^rm src/, "truncate -s 0 src/foo.ts": /^truncate/, "touch src/new.ts": /^touch/, "dd if=/dev/zero of=src/foo.ts": /^dd of=/,
    "git apply .conduct/x.patch": /git apply/, "git am < x.patch": /git am/, "patch -p1 < x.diff": /^patch/, "git commit -am wip": /git commit -a/,
    "git -C ../wt commit --all -m wip": /git commit -a/,
    "python3 -c \"open('src/a.ts','w').write('x')\"": /inline code/, "python3 -c \"import pathlib; pathlib.Path('a.ts').write_text('x')\"": /inline code/,
    "node -e \"require('fs').writeFileSync('src/a.ts','x')\"": /inline code/, "node -e 'require(\"child_process\").execSync(\"x\")'": /inline code/,
    "python3 - <<'EOF'\nopen('src/a.ts', 'w').write('x')\nEOF": /heredoc code/, "cat .conduct/x.md | python3": /stdin/, "curl -s http://x | sh": /stdin/,
    "bash -c 'echo x > src/a.ts'": /redirect > src\/a\.ts/, "sh -c \"sed -i s/a/b/ x.ts\"": /sed -i/, "eval 'echo x > a.ts'": /redirect/,
    "bash <<'EOF'\nrm src/foo.ts\nEOF": /^rm src/, "bash .conduct/steps.md": /write-then-execute/,
    "echo $(rm src/foo.ts)": /^rm src/, "x=`sed -i s/a/b/ f.ts`": /sed -i/, "diff <(cat a) >(tee src/x.ts)": /^tee src/,
    "find src -name '*.ts' -delete": /find -delete/, "find src -name '*.ts' -exec rm {} \\;": /find -exec: rm/,
    "ls | xargs rm": /^rm/, "sudo -u me cp a src/b.ts": /^cp into/, "FOO=1 timeout 5 tee src/a.ts": /^tee src/,
    "npx prettier --write src": /prettier rewriting/, "eslint --fix src": /eslint rewriting/, "python3 -m black src": /black rewriting/,
    "curl -o src/vendor.js http://x": /curl -o/, "wget http://x/a.js": /wget/,
    "awk '{print > \"src/out.ts\"}' a": /awk writing/, "echo 'unterminated": /could not parse/,
  };
  for (const [c, re] of Object.entries(cases)) assert.match(bash(c) ?? "(allowed)", re, c);
});

test("parseShell keeps quoted operators inside words and reads heredoc bodies", () => {
  const [cmd] = parseShell("codex exec \"a > b; c | d\" > out.jsonl");
  assert.deepEqual(cmd.words, ["codex", "exec", "a > b; c | d"]);
  assert.deepEqual(cmd.redirects, [{ op: ">", target: "out.jsonl" }]);
  const [h] = parseShell("cat <<-EOF > .conduct/b.md\n\tline > src/x.ts\n\tEOF\n");
  assert.deepEqual(h.stdin, ["\tline > src/x.ts"]);
  assert.equal(bash("cat <<'EOF' > .conduct/brief.md\nrun: echo x > src/foo.ts\nEOF"), null);
});

test("deny output tells the model to delegate instead", () => {
  const out = JSON.parse(hookOutput(tool("Edit", { file_path: "src/foo.ts" })));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /conductor never implements/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /dispatch a worker/);
  assert.equal(hookOutput({ allow: true }), "");
});

const runCli = (input, guard, stateHome = mkdtempSync(path.join(tmpdir(), "guard-shadow-"))) => {
  const env = { ...process.env, CONDUCT_HOME: stateHome };
  if (guard === undefined) delete env.CONDUCT_GUARD; else env.CONDUCT_GUARD = guard;
  const r = spawnSync(process.execPath, [cli], { input, encoding: "utf8", env });
  const log = path.join(stateHome, "conductor-guard-shadow.ndjson");
  return { ...r, log: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
};
const codeEdit = JSON.stringify({ session_id: "s1", tool_name: "Edit", cwd, tool_input: { file_path: "src/a.ts" } });

test("CLI (enforce): deny JSON for a code edit, silence for a subagent, exit 2 on unreadable input", () => {
  const run = (input) => runCli(input, "enforce");
  const denied = run(JSON.stringify({ tool_name: "Write", cwd, tool_input: { file_path: "src/a.ts", content: "x" } }));
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  const sub = run(JSON.stringify({ tool_name: "Write", cwd, agent_id: "a1", tool_input: { file_path: "src/a.ts" } }));
  assert.equal(sub.status, 0);
  assert.equal(sub.stdout, "");
  assert.equal(run("not json").status, 2);
});

test("CLI default (CONDUCT_GUARD unset) is shadow: logs the would-be denial and does not block", () => {
  for (const guard of [undefined, "shadow"]) {
    const r = runCli(codeEdit, guard);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    const [line] = r.log();
    assert.equal(line.sessionId, "s1");
    assert.equal(line.tool, "Edit");
    assert.equal(line.input, "src/a.ts");
    assert.match(line.reason, /^Edit on /);
  }
  const allowed = runCli(JSON.stringify({ tool_name: "Write", cwd, tool_input: { file_path: ".conduct/brief-x.md" } }));
  assert.equal(allowed.stdout, "");
  assert.deepEqual(allowed.log(), []);
});

test("CLI enforce/on blocks and writes no shadow log; off neither blocks nor logs", () => {
  for (const guard of ["enforce", "on"]) {
    const r = runCli(codeEdit, guard);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", guard);
    assert.deepEqual(r.log(), []);
  }
  const off = runCli(codeEdit, "off");
  assert.equal(off.status, 0);
  assert.equal(off.stdout, "");
  assert.deepEqual(off.log(), []);
});

test("settings file wires the guard for every write-capable tool and has no permission rules", () => {
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  const [entry] = s.hooks.PreToolUse;
  assert.deepEqual(entry.matcher.split("|").sort(), ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"]);
  assert.match(entry.hooks[0].command, /conductor-guard\.mjs/);
  // permissions.deny would also bind subagents (the SDD workers); see README "Conductor guard".
  assert.equal(s.permissions, undefined);
});
