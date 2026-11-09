#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const settingsPath = option("settings");
const scriptsDir = option("scripts-dir");
const uninstall = args.includes("--uninstall");

if (!settingsPath || !scriptsDir || args.some((arg, index) => arg.startsWith("--") && arg !== "--uninstall" && (!args[index + 1] || args[index + 1].startsWith("--")))) {
  console.error("usage: install-hooks.mjs --settings <path> --scripts-dir <abs dir> [--uninstall]");
  process.exit(2);
}

const command = `node "${scriptsDir.replace(/\\/g, "/")}/conduct-events.mjs" hook`;
const events = {
  PreToolUse: ".*",
  PostToolUse: "",
  SubagentStart: "",
  SubagentStop: "",
  Stop: "",
  SessionEnd: ""
};

const hasSettings = existsSync(settingsPath);
const settings = hasSettings ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const hooks = settings.hooks ?? {};
settings.hooks = hooks;
const isOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((hook) => hook.command === command);

for (const [event, matcher] of Object.entries(events)) {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
  const remaining = entries.filter((entry) => !isOurs(entry));
  if (!uninstall) {
    remaining.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
  }
  if (remaining.length) hooks[event] = remaining;
  else delete hooks[event];
}

const next = JSON.stringify(settings, null, 2) + "\n";
if (hasSettings && readFileSync(settingsPath, "utf8") === next) process.exit(0);

if (hasSettings) {
  const backupPath = `${settingsPath}.conduct-events.bak`;
  if (!existsSync(backupPath)) copyFileSync(settingsPath, backupPath);
}

const temporaryPath = `${settingsPath}.conduct-events.tmp-${process.pid}`;
writeFileSync(temporaryPath, next, "utf8");
renameSync(temporaryPath, settingsPath);
