import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIET_SWITCHES, buildDietConfig, buildDietEnv, extractModelBlock, pruneStaleDietDirs } from "./grok-diet.mjs";

const CONFIG = `[cli]
installer = "internal"

[model.deepseek-v4-pro]
model = "deepseek-v4-pro"
base_url = "https://api.deepseek.com/v1"
env_key = "DEEPSEEK_API_KEY"
context_window = 128000

[marketplace]
official_marketplace_auto_installed = true

[model."gpt-5.6-x"]
model = "gpt-5.6-x"
base_url = "https://example.test/v1"
`;

describe("extractModelBlock", () => {
  it("returns the block for the requested model and stops at the next table", () => {
    const block = extractModelBlock(CONFIG, "deepseek-v4-pro");
    assert.match(block, /base_url = "https:\/\/api\.deepseek\.com\/v1"/);
    assert.match(block, /env_key = "DEEPSEEK_API_KEY"/);
    assert.doesNotMatch(block, /marketplace/);
  });

  it("matches a quoted header, which is mandatory for ids containing a dot", () => {
    assert.match(extractModelBlock(CONFIG, "gpt-5.6-x"), /base_url = "https:\/\/example\.test\/v1"/);
  });

  it("matches quoted and unquoted dotted headers without matching a near-miss id", () => {
    const config = '[model.grok-4x7]\nmodel = "near miss"\n\n[model."grok-4.7"]\nmodel = "quoted"\n';
    assert.equal(extractModelBlock(config, "grok-4.7"), '[model."grok-4.7"]\nmodel = "quoted"\n');
    assert.equal(extractModelBlock('[model.grok-4.7]\nmodel = "unquoted"\n', "grok-4.7"), '[model.grok-4.7]\nmodel = "unquoted"\n');
  });

  it("does not match a different model whose id starts with the requested one", () => {
    assert.equal(extractModelBlock(CONFIG, "deepseek-v4"), null);
  });

  it("returns null when the model is absent", () => {
    assert.equal(extractModelBlock(CONFIG, "nope"), null);
  });

  it("returns the block when it runs to end of file", () => {
    assert.match(extractModelBlock('[model.solo]\nmodel = "solo"\n', "solo"), /model = "solo"/);
  });
});

describe("buildDietEnv", () => {
  it("keeps home vars real, points GROK_HOME at the diet dir and turns every switch off", () => {
    const ambient = { USERPROFILE: "C:\\Users\\me", HOME: "/home/me", PATH: "p" };
    const env = buildDietEnv(ambient, "/tmp/diet");
    assert.equal(env.USERPROFILE, ambient.USERPROFILE);
    assert.equal(env.HOME, ambient.HOME);
    assert.equal(env.GROK_HOME, "/tmp/diet");
    assert.equal(DIET_SWITCHES.length, 10);
    for (const name of DIET_SWITCHES) assert.equal(env[name], "false");
    assert.equal(Object.hasOwn(ambient, "GROK_HOME"), false);
  });
});

describe("buildDietConfig", () => {
  it("wraps the model block with the internal installer and the skills ignore list, no plugins table", () => {
    const config = buildDietConfig('[model.solo]\nmodel = "solo"\n');
    assert.match(config, /^\[cli\]\ninstaller = "internal"\n/);
    assert.match(config, /\[model\.solo\]\nmodel = "solo"\n/);
    assert.match(config, /\[skills\]\nignore = \["~\/\.agents\/skills", "~\/\.claude\/skills", "~\/\.claude\/plugins"\]\n$/);
    assert.doesNotMatch(config, /\[plugins\]/);
  });

  it("omits the model table when no custom model block is supplied", () => {
    const config = buildDietConfig(null);
    assert.doesNotMatch(config, /\[model\./);
    assert.match(config, /\[cli\]\ninstaller = "internal"/);
    assert.match(config, /\[skills\]\nignore = \["~\/\.agents\/skills", "~\/\.claude\/skills", "~\/\.claude\/plugins"\]/);
  });
});

describe("pruneStaleDietDirs", () => {
  it("removes only grok-diet-* directories older than maxAgeMs", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-diet-test-root-"));
    try {
      const stale = join(root, "grok-diet-stale");
      const fresh = join(root, "grok-diet-fresh");
      const foreign = join(root, "other-stale");
      const staleFile = join(root, "grok-diet-file");
      for (const dir of [stale, fresh, foreign]) mkdirSync(dir);
      writeFileSync(staleFile, "");
      const now = 1_000_000_000_000;
      const old = new Date(now - 2 * 3600_000);
      for (const path of [stale, foreign, staleFile]) utimesSync(path, old, old);
      utimesSync(fresh, new Date(now - 60_000), new Date(now - 60_000));

      assert.deepEqual(pruneStaleDietDirs(root, now, 3600_000), [stale]);
      assert.equal(existsSync(stale), false);
      for (const kept of [fresh, foreign, staleFile]) assert.equal(existsSync(kept), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow a grok-diet-* link into an old directory outside root", () => {
    const scratch = mkdtempSync(join(tmpdir(), "grok-diet-test-scratch-"));
    try {
      const root = join(scratch, "root");
      const target = join(scratch, "elsewhere");
      const payload = join(target, "keep.txt");
      mkdirSync(root);
      mkdirSync(target);
      writeFileSync(payload, "precious");
      const now = 1_000_000_000_000;
      const old = new Date(now - 2 * 3600_000);
      utimesSync(target, old, old);
      const link = join(root, "grok-diet-link");
      symlinkSync(target, link, "junction");

      assert.deepEqual(pruneStaleDietDirs(root, now, 3600_000), []);
      assert.equal(existsSync(payload), true);
      assert.equal(existsSync(link), true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("skips an entry the remover cannot delete and still removes the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "grok-diet-test-root-"));
    try {
      const locked = join(root, "grok-diet-locked");
      const stale = join(root, "grok-diet-stale");
      for (const dir of [locked, stale]) mkdirSync(dir);
      const now = 1_000_000_000_000;
      const old = new Date(now - 2 * 3600_000);
      for (const dir of [locked, stale]) utimesSync(dir, old, old);
      const remover = (path, options) => {
        if (path === locked) throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
        rmSync(path, options);
      };

      assert.deepEqual(pruneStaleDietDirs(root, now, 3600_000, remover), [stale]);
      assert.equal(existsSync(locked), true);
      assert.equal(existsSync(stale), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("gate diet-v2 (graduated from .conduct/gate-diet-v2.test.mjs)", () => {
  const switches = [
    "GROK_CLAUDE_SKILLS_ENABLED", "GROK_CLAUDE_AGENTS_ENABLED", "GROK_CLAUDE_MCPS_ENABLED",
    "GROK_CLAUDE_HOOKS_ENABLED", "GROK_CLAUDE_RULES_ENABLED", "GROK_CURSOR_SKILLS_ENABLED",
    "GROK_CURSOR_AGENTS_ENABLED", "GROK_CURSOR_MCPS_ENABLED", "GROK_CURSOR_HOOKS_ENABLED",
    "GROK_CURSOR_RULES_ENABLED",
  ];

  it("DIET_SWITCHES is exactly the ten required switch names", () => {
    assert.deepEqual([...DIET_SWITCHES], switches);
  });

  it("buildDietEnv preserves real home variables, sets switches, and leaves ambient unchanged", () => {
    const ambient = { USERPROFILE: "real-profile", HOME: "real-home", PATH: "path-value" };
    const before = { ...ambient };
    const result = buildDietEnv(ambient, "diet-home");
    assert.notEqual(result, ambient);
    assert.deepEqual(ambient, before);
    assert.equal(result.USERPROFILE, "real-profile");
    assert.equal(result.HOME, "real-home");
    assert.equal(result.GROK_HOME, "diet-home");
    for (const name of switches) assert.equal(result[name], "false");
  });

  it("buildDietEnv leaves absent home variables absent", () => {
    const result = buildDietEnv({}, "diet-home");
    assert.equal(Object.hasOwn(result, "USERPROFILE"), false);
    assert.equal(Object.hasOwn(result, "HOME"), false);
  });

  it("buildDietConfig contains cli, model, and skills ignore, without plugins", () => {
    const model = '[model.test]\nname = "test-model"\n';
    const config = buildDietConfig(model);
    assert.match(config, /\[cli\][\s\S]*?installer\s*=\s*"internal"/);
    assert.ok(config.includes(model));
    assert.match(config, /\[skills\][\s\S]*?ignore\s*=\s*\["~\/\.agents\/skills",\s*"~\/\.claude\/skills",\s*"~\/\.claude\/plugins"\]/);
    assert.doesNotMatch(config, /^\[plugins\]/m);
  });

  it("pruneStaleDietDirs removes only old matching direct child directories", () => {
    const root = mkdtempSync(join(tmpdir(), "diet-gate-prune-"));
    try {
      const old = join(root, "grok-diet-old");
      const young = join(root, "grok-diet-young");
      const other = join(root, "keep-me");
      for (const dir of [old, young, other]) mkdirSync(dir);
      const now = Date.now();
      utimesSync(old, new Date(now - 20000), new Date(now - 20000));
      utimesSync(young, new Date(now - 1000), new Date(now - 1000));
      utimesSync(other, new Date(now - 20000), new Date(now - 20000));
      assert.deepEqual(pruneStaleDietDirs(root, now, 10000), [old]);
      assert.deepEqual(readdirSync(root).sort(), ["grok-diet-young", "keep-me"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run prints GROK_HOME and the command, no USERPROFILE, and leaves tmpdir untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "diet-gate-dry-run-"));
    try {
      const home = join(root, "home");
      const grok = join(home, ".grok");
      mkdirSync(grok, { recursive: true });
      writeFileSync(join(grok, "config.toml"), '[model.deepseek-v4-flash]\nname = "fixture"\n');
      const prompt = join(root, "brief.md");
      writeFileSync(prompt, "fixture brief");
      const tmp = join(root, "tmp");
      const stale = join(tmp, "grok-diet-stale");
      mkdirSync(stale, { recursive: true });
      const old = new Date(Date.now() - 48 * 3600_000);
      utimesSync(stale, old, old);
      const env = { ...process.env, USERPROFILE: home, HOME: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
      const script = fileURLToPath(new URL("./grok-diet.mjs", import.meta.url));

      const result = spawnSync(process.execPath, [script, "--cwd", root, "--prompt-file", prompt, "--dry-run"], { encoding: "utf8", env });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^GROK_HOME=/m);
      assert.doesNotMatch(result.stdout, /USERPROFILE/);
      assert.ok(result.stdout.trim().split(/\r?\n/).length >= 2);
      assert.deepEqual(readdirSync(tmp), ["grok-diet-stale"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run selects built-in and custom modes from a config containing only DeepSeek", () => {
    const root = mkdtempSync(join(tmpdir(), "diet-gate-model-modes-"));
    try {
      const home = join(root, "home");
      const grok = join(home, ".grok");
      mkdirSync(grok, { recursive: true });
      writeFileSync(join(grok, "config.toml"), '[model.deepseek-v4-flash]\nname = "fixture"\n');
      const prompt = join(root, "brief.md");
      writeFileSync(prompt, "fixture brief");
      const script = fileURLToPath(new URL("./grok-diet.mjs", import.meta.url));
      const env = { ...process.env, HOME: home, USERPROFILE: home };

      const builtin = spawnSync(process.execPath, [script, "--cwd", root, "--prompt-file", prompt, "--model", "grok-4.7", "--dry-run"], { encoding: "utf8", env });
      assert.equal(builtin.status, 0, builtin.stderr);
      assert.match(builtin.stdout, /model block: none \(built-in\)/);

      const custom = spawnSync(process.execPath, [script, "--cwd", root, "--prompt-file", prompt, "--model", "deepseek-v4-flash", "--dry-run"], { encoding: "utf8", env });
      assert.equal(custom.status, 0, custom.stderr);
      assert.match(custom.stdout, /model block: custom \(from config\.toml\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run treats a missing config.toml as an empty config for a built-in model", () => {
    const root = mkdtempSync(join(tmpdir(), "diet-gate-no-config-"));
    try {
      const home = join(root, "home");
      mkdirSync(join(home, ".grok"), { recursive: true });
      const prompt = join(root, "brief.md");
      writeFileSync(prompt, "fixture brief");
      const script = fileURLToPath(new URL("./grok-diet.mjs", import.meta.url));
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const result = spawnSync(process.execPath, [script, "--cwd", root, "--prompt-file", prompt, "--model", "grok-4.7", "--dry-run"], { encoding: "utf8", env });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /model block: none \(built-in\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
