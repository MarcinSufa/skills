#!/usr/bin/env node
// reap.mjs, the conduct teardown sweeper. A plain run is a report: it discovers git
// repositories under bounded roots (the working directory plus any paths given as
// arguments, one level of child directories, never a disk walk), deduplicates them by
// git common directory, enumerates their worktrees, and classifies each one. The only
// destructive path is `--destroy <exact canonical worktree path>`, at most one worktree
// per run, gated on conduct provenance, a guard set, and explicit confirmation.
// It never forces a removal, never deletes a branch, never edits a settings file,
// never signals a process, and never touches session scratchpads.
// Node 24, ES modules, no dependencies, Windows first.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';

const EXIT_CLEAN = 0; // nothing owned and actionable, or the requested removal succeeded
const EXIT_OWNED_LEFTOVERS = 2; // the report found owned, actionable leftovers
const EXIT_REFUSED = 3; // a destructive request was refused by a guard
const EXIT_BAD_INVOCATION = 64; // the arguments could not be understood
const EXIT_INTERNAL = 70; // an unexpected internal failure, or discovery could not look: fail closed

// Append helper used instead of the built-in array method throughout this file.
function add(list, value) {
  list[list.length] = value;
}

function canonical(candidate) {
  return path.normalize(path.resolve(candidate));
}

// Key for path equality: canonical, no trailing separator, case-folded on Windows.
function comparable(candidate) {
  let key = canonical(candidate);
  while (key.length > 3 && (key.endsWith('\\') || key.endsWith('/'))) key = key.slice(0, -1);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\s+$/, '');
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

// Separates "this path is not a repository" (a legitimate skip) from "git could not
// execute or could not be configured" (missing binary, dubious ownership, broken
// config). A report that cannot look must never say clean, so the second class is
// surfaced as a failure with its cause instead of being swallowed.
function gitLook(cwd, args) {
  try {
    return { out: git(cwd, args), failure: null };
  } catch (error) {
    const stderr = error instanceof Error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    if (/not a git repository/i.test(stderr)) return { out: null, failure: null };
    const detail = stderr !== '' ? stderr : error instanceof Error ? error.message : String(error);
    return { out: null, failure: detail };
  }
}

function parseArguments(argv) {
  const parsed = { roots: [], destroy: null, confirm: null, problems: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--destroy' || arg === '--confirm') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        add(parsed.problems, `${arg} requires a value: the exact canonical worktree path`);
      } else if (arg === '--destroy' && parsed.destroy !== null) {
        add(parsed.problems, '--destroy may be given only once; exactly one worktree per run');
        i += 1;
      } else if (arg === '--confirm' && parsed.confirm !== null) {
        add(parsed.problems, '--confirm may be given only once');
        i += 1;
      } else {
        if (arg === '--destroy') parsed.destroy = value;
        else parsed.confirm = value;
        i += 1;
      }
    } else if (arg.startsWith('--')) {
      add(parsed.problems, `unknown flag: ${arg}`);
    } else {
      add(parsed.roots, arg);
    }
  }
  if (parsed.destroy !== null && parsed.roots.length > 0) {
    add(parsed.problems, 'a --destroy run takes no extra root paths');
  }
  if (parsed.confirm !== null && parsed.destroy === null) {
    add(parsed.problems, '--confirm only accompanies --destroy');
  }
  return parsed;
}

// Yield the root itself plus its immediate child directories that carry a .git entry.
// Every immediate child is scanned: the one-level depth bound is what prevents a disk
// walk, so there is no child-count cap (a cap loses worktrees silently). A root whose
// children cannot be read at all is reported as an incomplete scan and fails closed.
function* candidateRepoPaths(root, failures) {
  yield root;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    add(failures, `scan incomplete: could not read ${root}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    if (existsSync(path.join(child, '.git'))) yield child;
  }
}

function discoverRepos(roots) {
  const seen = new Map();
  const failures = [];
  for (const root of roots) {
    const abs = canonical(root);
    if (!existsSync(abs)) continue;
    for (const repoPath of candidateRepoPaths(abs, failures)) {
      const probe = gitLook(repoPath, ['rev-parse', '--git-common-dir']);
      if (probe.failure !== null) {
        add(failures, `${repoPath}: ${probe.failure}`);
        continue;
      }
      if (probe.out === null || probe.out === '') continue;
      const commonAbs = comparable(path.isAbsolute(probe.out) ? probe.out : path.join(repoPath, probe.out));
      if (!seen.has(commonAbs)) seen.set(commonAbs, { commonDir: commonAbs, anchor: repoPath });
    }
  }
  return { repos: [...seen.values()], failures };
}

function listWorktrees(repo) {
  const probe = gitLook(repo.anchor, ['worktree', 'list', '--porcelain']);
  if (probe.out === null) {
    // Discovery already proved this anchor was a repository git could read, so a
    // failure here is unexpected: fail closed rather than dropping the repo silently.
    throw new Error(`could not list worktrees for ${repo.anchor}: ${probe.failure ?? 'no longer a repository'}`);
  }
  const out = probe.out;
  const records = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = {
        path: canonical(line.slice('worktree '.length)),
        head: null,
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
        primary: records.length === 0,
      };
      add(records, current);
    } else if (current === null) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  return records;
}

// Provenance entries are read with their file types so that only a regular FILE named
// brief-*.md can grant authority; a directory or a link with that name grants nothing.
function conductArtifacts(worktreePath) {
  try {
    return { present: true, entries: readdirSync(path.join(worktreePath, '.conduct'), { withFileTypes: true }) };
  } catch {
    return { present: false, entries: [] };
  }
}

// Ownership marker: .conduct/ containing at least one brief-*.md regular file. Nothing
// else grants authority; path and branch names carry none.
function isOwned(artifacts) {
  return artifacts.present && artifacts.entries.some((entry) => entry.isFile() && /^brief-.+\.md$/i.test(entry.name));
}

function hasScratchpadSegment(worktreePath) {
  return worktreePath.split(/[\\/]/).some((segment) => /scratchpad/i.test(segment));
}

function branchElsewhere(record, records) {
  if (record.branch === null) return false;
  return records.some((other) => other !== record && other.branch === record.branch);
}

// Entries in `git status --porcelain` other than the untracked .conduct/ artifacts.
// In a real slice worktree the status is never literally empty: .conduct/ is untracked
// and not gitignored, so the sub-protocol tolerates exactly that directory and nothing else.
function dirtBeyondConduct(worktreePath) {
  const out = tryGit(worktreePath, ['status', '--porcelain']);
  if (out === null) return ['git status could not run'];
  const offending = [];
  for (const line of out.split(/\r?\n/)) {
    if (line === '') continue;
    const entry = line.slice(3).replace(/^"|"$/g, '');
    const untrackedConduct =
      line.startsWith('?? ') && (entry === '.conduct' || entry === '.conduct/' || entry.startsWith('.conduct/'));
    if (untrackedConduct) continue;
    add(offending, line);
  }
  return offending;
}

// Fail-closed git read for guard checks. tryGit collapses "git said no" and "git
// failed" into one null, and that collapse has twice let a swallowed failure
// authorize an action in this file, so a guard that cannot look aborts the run
// instead of passing.
function guardGit(cwd, args) {
  let out;
  try {
    out = git(cwd, args);
  } catch (error) {
    const stderr = error instanceof Error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const detail = stderr !== '' ? stderr : error instanceof Error ? error.message : String(error);
    throw new Error(`guard could not look: git ${args.join(' ')} failed in ${cwd} (${detail}); aborting instead of passing`);
  }
  if (out === '') {
    throw new Error(`guard could not look: git ${args.join(' ')} in ${cwd} returned nothing; aborting instead of passing`);
  }
  return out;
}

// Checks every lock this design names: index.lock, HEAD.lock, packed-refs.lock,
// config.lock and shallow.lock in the worktree git dir and the common dir, plus any
// *.lock under refs/ in either. The refusal reason lists the exact files found, so
// the claim never exceeds the check. The two rev-parse reads are fail-closed: a
// worktree that reaches this guard was proven readable by discovery, so a failure
// here means the scan would cover zero directories and must abort, not pass.
function gitLockFiles(worktreePath) {
  const found = [];
  const dirs = [];
  add(dirs, canonical(guardGit(worktreePath, ['rev-parse', '--absolute-git-dir'])));
  const common = guardGit(worktreePath, ['rev-parse', '--git-common-dir']);
  const commonAbs = canonical(path.isAbsolute(common) ? common : path.resolve(worktreePath, common));
  if (!dirs.some((dir) => comparable(dir) === comparable(commonAbs))) add(dirs, commonAbs);
  for (const dir of dirs) {
    for (const name of ['index.lock', 'HEAD.lock', 'packed-refs.lock', 'config.lock', 'shallow.lock']) {
      const lock = path.join(dir, name);
      if (existsSync(lock)) add(found, lock);
    }
    const pending = [path.join(dir, 'refs')];
    while (pending.length > 0) {
      const current = pending.pop();
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue; // a refs directory that does not exist has no locks
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) add(pending, full);
        else if (entry.name.endsWith('.lock')) add(found, full);
      }
    }
  }
  return found;
}

// Parses `git config -z` output, NUL between entries and a newline between key and
// value, so a space anywhere in the key or the value survives intact. Never split
// --get-regexp output on whitespace: submodule names and paths may contain spaces.
// Fail-closed: --get-regexp exits 1 for "no matches", and only that exact shape
// (exit 1, empty stderr, empty stdout) counts as none. Anything else, exit 128
// from a malformed committed .gitmodules included, aborts: an initialized
// submodule hiding behind a broken file must block, not pass.
function initializedSubmodules(worktreePath) {
  const modulesFile = path.join(worktreePath, '.gitmodules');
  if (!existsSync(modulesFile)) return [];
  const probe = spawnSync(
    'git',
    ['config', '--file', modulesFile, '-z', '--get-regexp', String.raw`submodule\..*\.path`],
    { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const out = probe.stdout ?? '';
  const err = (probe.stderr ?? '').trim();
  if (probe.error) {
    throw new Error(`guard could not look: git config --get-regexp failed in ${worktreePath} (${probe.error.message}); aborting instead of passing`);
  }
  if (probe.status === 1 && err === '' && out === '') return [];
  if (probe.status !== 0 || err !== '') {
    throw new Error(`guard could not look: git config --get-regexp on ${modulesFile} gave exit ${probe.status}${err !== '' ? ` (${err})` : ''}; aborting instead of passing`);
  }
  const found = [];
  for (const entry of out.split('\0')) {
    if (entry === '') continue;
    const separator = entry.indexOf('\n');
    const subPath = separator === -1 ? '' : entry.slice(separator + 1);
    if (subPath !== '' && existsSync(path.join(worktreePath, subPath, '.git'))) add(found, subPath);
  }
  return found;
}

// No link-type gate here: whether Node reports a Windows junction as a symlink is
// irrelevant, because the resolved real path is compared either way. Anything whose
// real location falls outside the worktree blocks removal, whatever the link flavour.
function nodeModulesEscapes(worktreePath) {
  const nodeModules = path.join(worktreePath, 'node_modules');
  try {
    lstatSync(nodeModules);
  } catch {
    return false; // no node_modules entry at all
  }
  try {
    const realRoot = comparable(realpathSync(worktreePath));
    const real = comparable(realpathSync(nodeModules));
    return real !== realRoot && !real.startsWith(realRoot + path.sep);
  } catch {
    return true; // a path that cannot be resolved is treated as escaping
  }
}

// Every commit in the worktree must already be reachable from the approved base.
function isAncestor(anchor, maybeAncestor, tip) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', maybeAncestor, tip], {
      cwd: anchor,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// Resolves a ref that may legitimately be absent, for a decision that authorizes
// deletion. Only a clean "not found" (exit status 1, empty stderr, empty stdout)
// counts as absent. Anything else, a broken-ref warning, malformed ref content, a
// ref peeling to a non-commit, or git failing to execute, is an operational failure
// and must abort the run. tryGit is never used here: it collapses "absent" and "git
// failed" into one null, and in this file that collapse has twice let a git failure
// authorize an action that should have been refused.
function resolveOptionalCommitRef(anchor, ref) {
  const options = { cwd: anchor, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
  const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], options);
  const out = (probe.stdout ?? '').trim();
  const err = (probe.stderr ?? '').trim();
  if (probe.error) return { commit: null, absent: false, failure: probe.error.message };
  if (probe.status === 1 && err === '' && out === '') return { commit: null, absent: true, failure: null };
  if (probe.status !== 0 || err !== '' || !/^[0-9a-f]{40,64}$/.test(out)) {
    return { commit: null, absent: false, failure: `git rev-parse --verify ${ref} gave exit ${probe.status}${err !== '' ? `: ${err}` : ''}` };
  }
  // The ref exists; it must also peel to a commit. --quiet is dropped so a peel
  // failure names its cause. A ref pointing at a tree or blob aborts here instead
  // of passing for absent.
  const peel = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], options);
  const peelOut = (peel.stdout ?? '').trim();
  const peelErr = (peel.stderr ?? '').trim();
  if (peel.error) return { commit: null, absent: false, failure: peel.error.message };
  if (peel.status !== 0 || peelErr !== '' || !/^[0-9a-f]{40,64}$/.test(peelOut)) {
    return { commit: null, absent: false, failure: `${ref} exists but does not peel to a commit (exit ${peel.status}${peelErr !== '' ? `: ${peelErr}` : ''})` };
  }
  return { commit: peelOut, absent: false, failure: null };
}

// The base for "already reachable" is a remote ref where one exists: origin/dev,
// origin/main, then origin/master. Where every one is cleanly absent, the primary's
// local HEAD is used and every message built from this base says so instead of
// calling it approved. A remote ref that is broken rather than absent aborts the
// run: it must never authorize the local-HEAD path.
function approvedBase(repo, records) {
  for (const ref of ['origin/dev', 'origin/main', 'origin/master']) {
    const probe = resolveOptionalCommitRef(repo.anchor, `refs/remotes/${ref}`);
    if (probe.failure !== null) {
      throw new Error(
        `could not resolve refs/remotes/${ref} (${probe.failure}); a broken remote ref must be repaired before reap can pick an approved base`,
      );
    }
    if (!probe.absent) return { commit: probe.commit, label: `approved base ${ref}` };
  }
  return {
    commit: records.length > 0 ? records[0].head : null,
    label: 'primary local HEAD (no origin/dev, origin/main or origin/master resolves; not a remote-approved base)',
  };
}

// The full guard set. An empty result means the worktree is safe to remove.
function evaluate(record, records, base, repo) {
  const reasons = [];
  if (record.primary) add(reasons, 'primary checkout; never removable');
  if (hasScratchpadSegment(record.path)) add(reasons, 'session scratchpad path; out of destructive scope');
  if (record.locked) add(reasons, 'worktree registration is locked');
  if (record.prunable) add(reasons, 'registration marked prunable; directory state indeterminate');
  if (record.detached || record.branch === null) add(reasons, 'detached HEAD; refused outright in version one');
  if (branchElsewhere(record, records)) add(reasons, 'branch checked out in another worktree');
  if (!existsSync(record.path)) {
    add(reasons, 'directory missing on disk');
    return reasons;
  }
  for (const lock of gitLockFiles(record.path)) add(reasons, `git lock present: ${lock}`);
  const dirt = dirtBeyondConduct(record.path);
  if (dirt.length > 0) {
    add(reasons, `dirty beyond .conduct (${dirt.length} ${dirt.length === 1 ? 'entry' : 'entries'})`);
  }
  const submodules = initializedSubmodules(record.path);
  if (submodules.length > 0) add(reasons, `initialized submodule: ${submodules.join(', ')}`);
  if (nodeModulesEscapes(record.path)) add(reasons, 'node_modules is a link resolving outside the worktree');
  if (record.head !== null && base.commit !== null && !isAncestor(repo.anchor, record.head, base.commit)) {
    add(reasons, `commits not reachable from the ${base.label}`);
  }
  return reasons;
}

function classify(record, base, repo, artifacts, reasons) {
  if (record.primary) {
    return { bucket: 'PRIMARY', detail: 'primary checkout; never a candidate' };
  }
  // Registration and existence come before provenance: a missing directory cannot
  // carry provenance, so it must never be mistaken for a healthy unowned worktree.
  if (!existsSync(record.path)) {
    const why = record.prunable
      ? 'registration marked prunable and directory missing on disk'
      : 'directory missing on disk';
    return { bucket: 'BLOCKED', detail: `${why}; provenance not inspectable; consider git worktree prune by hand`, anomaly: true };
  }
  if (isOwned(artifacts)) {
    if (reasons.length === 0) {
      return { bucket: 'OWNED-ACTIONABLE', detail: 'conduct provenance and every guard passes; removable via --destroy' };
    }
    // Removal-mechanics hazards (a nested repository, an escaping node_modules link,
    // a locked registration) must not hide an owned leftover from the close: the slice
    // stays owned and actionable in the report even though reap itself refuses to
    // remove it, so a failed or impossible teardown never turns silently green.
    const mechanics = reasons.filter((why) =>
      /^initialized submodule|^node_modules is a link|^worktree registration is locked/.test(why),
    );
    if (mechanics.length === reasons.length) {
      return {
        bucket: 'OWNED-ACTIONABLE',
        detail: `conduct provenance; ${mechanics.join('; ')}; reap will not remove this itself, handle it by hand at close`,
      };
    }
    return { bucket: 'BLOCKED', detail: reasons.join('; ') };
  }
  const finished =
    record.head !== null &&
    base.commit !== null &&
    record.head !== base.commit &&
    !record.detached &&
    isAncestor(repo.anchor, record.head, base.commit);
  if (finished) {
    return { bucket: 'STALE-UNOWNED', detail: `work already reachable from the ${base.label}, but no conduct provenance; report only` };
  }
  return { bucket: 'ACTIVE-INDETERMINATE', detail: 'no conduct provenance and no finished shape; treated as possibly in use' };
}

// ---- Teardown transaction: crash-recoverable staging of .conduct/ ----
// A destroy stages .conduct/ aside before removal. A hard kill anywhere in that
// window must not hide the artifacts, so staging is a transaction: a manifest naming
// the canonical worktree, source and target is written BEFORE the rename, and every
// report and every destroy reconciles matching staged siblings before doing anything
// else. The run stays nonzero while any transaction is unresolved. Signal handlers
// would only ever be best effort on top of this, never a substitute: a hard kill
// runs no handler, and startup reconciliation is what covers that.
const STAGED_DIR_RE = /\.conduct-staged-\d+-\d+$/;
const MANIFEST_SUFFIX = '.txn.json';

function transactionPaths(worktreePath) {
  const staged = path.join(
    path.dirname(worktreePath),
    `${path.basename(worktreePath)}.conduct-staged-${process.pid}-${Date.now()}`,
  );
  return { source: path.join(worktreePath, '.conduct'), staged, manifest: `${staged}${MANIFEST_SUFFIX}` };
}

// Every directory that could hold a staged sibling: the bounded roots themselves and
// the parent directory of every registered worktree, plus the parent of a destroy
// target. A staged sibling always lives next to its worktree, so these are the
// places an interrupted transaction can be waiting.
function transactionScanDirs(roots, repos, destroyTarget) {
  const dirs = [];
  for (const root of roots) {
    const abs = canonical(root);
    if (existsSync(abs)) add(dirs, abs);
  }
  for (const repo of repos) {
    for (const record of listWorktrees(repo)) add(dirs, path.dirname(record.path));
  }
  if (destroyTarget !== null) add(dirs, path.dirname(canonical(destroyTarget)));
  return dirs;
}

// Reconciles every visible staged .conduct/ sibling and transaction manifest.
// Restores artifacts where the worktree directory still exists, removes manifests
// whose transaction left nothing behind, and reports everything it cannot resolve
// safely. It never deletes artifacts: a staged copy whose worktree is gone stays on
// disk, is surfaced by every later run, and keeps the close red until a hand
// resolves it.
function reconcileTransactions(scanDirs) {
  const actions = [];
  const unresolved = [];
  const seen = new Set();
  for (const dir of scanDirs) {
    const dirKey = comparable(dir);
    if (seen.has(dirKey)) continue;
    seen.add(dirKey);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      add(unresolved, {
        where: dir,
        detail: `could not scan for interrupted teardown transactions: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const transactions = new Map();
    for (const entry of entries) {
      if (entry.isDirectory() && STAGED_DIR_RE.test(entry.name)) {
        const record = transactions.get(entry.name) ?? { staged: false, manifest: false };
        record.staged = true;
        transactions.set(entry.name, record);
      } else if (entry.isFile() && entry.name.endsWith(MANIFEST_SUFFIX)) {
        const base = entry.name.slice(0, -MANIFEST_SUFFIX.length);
        if (!STAGED_DIR_RE.test(base)) continue;
        const record = transactions.get(base) ?? { staged: false, manifest: false };
        record.manifest = true;
        transactions.set(base, record);
      }
    }
    for (const [stagedName, presence] of transactions) {
      const stagedPath = path.join(dir, stagedName);
      const manifestPath = `${stagedPath}${MANIFEST_SUFFIX}`;
      // The staged sibling's own name carries the worktree basename; the manifest,
      // where readable, names the worktree explicitly and wins.
      let worktreePath = canonical(path.join(dir, stagedName.replace(STAGED_DIR_RE, '')));
      if (presence.manifest) {
        try {
          const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
          if (typeof parsed.worktree === 'string' && parsed.worktree !== '') worktreePath = canonical(parsed.worktree);
        } catch {
          // a torn manifest still names its worktree through the staged sibling's name
        }
      }
      if (!presence.staged) {
        // The transaction left nothing to restore; only its manifest remains.
        try {
          unlinkSync(manifestPath);
          add(actions, `removed the finished-transaction manifest ${manifestPath}`);
        } catch (error) {
          add(unresolved, {
            where: manifestPath,
            detail: `could not remove the finished-transaction manifest: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        continue;
      }
      if (!existsSync(worktreePath)) {
        add(unresolved, {
          where: stagedPath,
          detail: `interrupted teardown transaction; .conduct/ artifacts preserved here but the worktree ${worktreePath} is gone; recover or delete them by hand${presence.manifest ? `, then delete ${manifestPath}` : ''}`,
        });
        continue;
      }
      const conductDir = path.join(worktreePath, '.conduct');
      if (existsSync(conductDir)) {
        add(unresolved, {
          where: stagedPath,
          detail: `interrupted teardown transaction; both ${conductDir} and this staged copy exist; refusing to guess which is canonical; resolve by hand`,
        });
        continue;
      }
      try {
        renameSync(stagedPath, conductDir);
      } catch (error) {
        add(unresolved, {
          where: stagedPath,
          detail: `interrupted teardown transaction; could not restore into ${conductDir}: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (presence.manifest) {
        try {
          unlinkSync(manifestPath);
        } catch (error) {
          add(unresolved, {
            where: manifestPath,
            detail: `restored .conduct/ into ${worktreePath} but could not remove the transaction manifest: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
      }
      add(actions, `restored .conduct/ into ${worktreePath} from the interrupted teardown at ${stagedPath}`);
    }
  }
  return { actions, unresolved };
}

function report(repos, unresolvedTransactions = 0) {
  if (repos.length === 0) {
    console.log('reap: no git repositories discovered under the bounded roots.');
    if (unresolvedTransactions > 0) {
      console.log('reap: unresolved teardown transactions remain; the close is incomplete until they are resolved by hand.');
      return EXIT_OWNED_LEFTOVERS;
    }
    return EXIT_CLEAN;
  }
  let ownedActionable = 0;
  let blocked = 0;
  let stale = 0;
  let active = 0;
  let anomalies = 0;
  for (const repo of repos) {
    const records = listWorktrees(repo);
    if (records.length === 0) continue;
    const base = approvedBase(repo, records);
    console.log(`repository: ${records[0].path}`);
    for (const record of records) {
      const artifacts = conductArtifacts(record.path);
      const reasons = evaluate(record, records, base, repo);
      const verdict = classify(record, base, repo, artifacts, reasons);
      if (verdict.bucket === 'OWNED-ACTIONABLE') ownedActionable += 1;
      else if (verdict.bucket === 'BLOCKED') blocked += 1;
      else if (verdict.bucket === 'STALE-UNOWNED') stale += 1;
      else if (verdict.bucket === 'ACTIVE-INDETERMINATE') active += 1;
      if (verdict.anomaly) anomalies += 1;
      console.log(`  ${verdict.bucket.padEnd(21)} ${record.path}  :: ${verdict.detail}`);
    }
  }
  console.log(
    `reap: ${ownedActionable} owned-and-actionable, ${blocked} blocked-with-reasons, ` +
      `${stale} stale-but-unowned, ${active} active-or-indeterminate.`,
  );
  if (ownedActionable > 0 || anomalies > 0 || unresolvedTransactions > 0) {
    if (ownedActionable > 0) {
      console.log('reap: owned actionable leftovers exist; the slice close is incomplete until they are handled.');
    }
    if (anomalies > 0) {
      console.log('reap: registered worktrees with missing directories remain; the close is incomplete until they are handled.');
    }
    if (unresolvedTransactions > 0) {
      console.log('reap: unresolved teardown transactions remain; the close is incomplete until they are resolved by hand.');
    }
    return EXIT_OWNED_LEFTOVERS;
  }
  console.log('reap: nothing owned and actionable.');
  return EXIT_CLEAN;
}

function refuse(target, why) {
  console.error(`reap: REFUSED ${target}`);
  console.error(`reap: ${why}`);
  return EXIT_REFUSED;
}

function snapshot(worktreePath) {
  return {
    status: tryGit(worktreePath, ['status', '--porcelain']),
    head: tryGit(worktreePath, ['rev-parse', 'HEAD']),
  };
}

async function confirmExact(targetPath, confirmValue) {
  if (confirmValue !== null) return comparable(confirmValue) === comparable(targetPath);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('reap: non-interactive shell; supply --confirm with the exact canonical path');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('type the exact canonical path to confirm removal\n> ');
    return comparable(answer.trim()) === comparable(targetPath);
  } finally {
    rl.close();
  }
}

// The discovery anchor is picked in readdir order, so it can land on the destroy
// target itself. Git operations for a destroy must never run with their cwd inside
// the tree being deleted: `git worktree remove` then guts the tracked files, fails,
// and git unregisters the worktree anyway, leaving every later report green over
// the orphan. The destroy anchor is therefore always another worktree of the same
// repository, preferring the primary checkout (records[0]).
function removalAnchor(records, target) {
  const targetKey = comparable(target.path);
  for (const record of records) {
    if (comparable(record.path) === targetKey) continue;
    if (existsSync(record.path)) return record.path;
  }
  return null;
}

async function destroyOne(repos, targetArg, confirmValue) {
  const target = canonical(targetArg);
  const targetKey = comparable(target);
  let found = null;
  for (const repo of repos) {
    const records = listWorktrees(repo);
    for (const record of records) {
      if (comparable(record.path) === targetKey) found = { repo, records, record };
    }
  }
  if (found === null) {
    return refuse(target, 'not in the discovered worktree set; reap removes only worktrees it discovered itself');
  }
  const { repo, records, record } = found;
  const cwdKey = comparable(process.cwd());
  if (cwdKey === targetKey || cwdKey.startsWith(targetKey + path.sep)) {
    return refuse(target, 'the process working directory is inside the destroy target; git operations never anchor at the tree being removed; rerun from outside it');
  }
  const anchor = removalAnchor(records, record);
  if (anchor === null) {
    return refuse(target, 'no other worktree of this repository exists on disk to anchor the removal; refusing rather than anchoring inside the destroy target');
  }
  const opRepo = { commonDir: repo.commonDir, anchor };
  // Registration and existence guards come before provenance: a directory that is
  // missing cannot carry provenance, and refusing it for provenance would mislead.
  if (!existsSync(record.path)) {
    const why = record.prunable
      ? 'directory missing on disk and registration marked prunable; nothing to remove, consider git worktree prune by hand'
      : 'directory missing on disk; nothing to remove';
    return refuse(target, why);
  }
  const artifacts = conductArtifacts(record.path);
  if (!isOwned(artifacts)) {
    return refuse(target, 'no conduct provenance: a .conduct/ directory with at least one brief-*.md regular file is required');
  }
  const base = approvedBase(opRepo, records);
  const reasons = evaluate(record, records, base, opRepo);
  if (reasons.length > 0) return refuse(target, reasons.join('; '));

  const before = snapshot(record.path);
  console.log(`target: ${record.path}`);
  console.log('.conduct/ artifacts acknowledged for removal with the worktree:');
  for (const entry of artifacts.entries) console.log(`  .conduct/${entry.name}`);
  console.log(`about to run: git worktree remove "${record.path}"`);

  const confirmed = await confirmExact(record.path, confirmValue);
  if (!confirmed) return refuse(target, 'confirmation missing or not matching the exact canonical path');

  // Re-read the worktree state immediately before removal; abort on any change.
  const after = snapshot(record.path);
  if (before.status !== after.status || before.head !== after.head) {
    return refuse(target, 'worktree state changed since the report; aborted without removing anything');
  }

  // The .conduct/ sub-protocol: nothing is destroyed before the removal is known to
  // succeed. Staging is a recoverable transaction: the manifest naming the canonical
  // worktree, source and target is written BEFORE the rename, so a hard kill at any
  // later point leaves a transaction that the next report or destroy reconciles at
  // startup. Every in-run failure path below restores the artifacts via the finally
  // block; the staged copy and the manifest are deleted only after the removal
  // succeeded, and any leftover keeps every later run nonzero.
  const { source: conductDir, staged: stagedConduct, manifest: manifestPath } = transactionPaths(record.path);
  try {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          worktree: canonical(record.path),
          source: canonical(conductDir),
          target: canonical(stagedConduct),
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return refuse(target, `could not write the teardown transaction manifest ${manifestPath}: ${detail}; nothing was removed`);
  }
  try {
    renameSync(conductDir, stagedConduct);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      unlinkSync(manifestPath);
    } catch {
      // a manifest with no staged sibling is removed by the next run's reconciliation
    }
    return refuse(target, `could not stage .conduct/ aside before removal: ${detail}; nothing was removed`);
  }
  let removed = false;
  // Whether git still lists the worktree after a failed removal. Recorded in the
  // catch, but reported only after the finally block has actually attempted the
  // restore, so no message ever claims a restoration that has not happened yet.
  let registrationAfterFailure = null;
  try {
    const remaining = tryGit(record.path, ['status', '--porcelain']);
    if (remaining === null || remaining !== '') {
      return refuse(target, 'the clean check after staging .conduct/ aside did not pass; leaving the worktree in place');
    }
    try {
      git(anchor, ['worktree', 'remove', record.path]);
    } catch (error) {
      const detail = error instanceof Error && typeof error.stderr === 'string' ? error.stderr.trim() : String(error);
      console.error(`reap: plain removal failed and --force is never used: ${detail}`);
      const still = tryGit(anchor, ['worktree', 'list', '--porcelain']);
      if (still === null) {
        registrationAfterFailure = 'unknown';
      } else {
        const listed = still
          .split(/\r?\n/)
          .some((line) => line.startsWith('worktree ') && comparable(line.slice('worktree '.length)) === comparable(record.path));
        registrationAfterFailure = listed ? 'registered' : 'unregistered';
      }
      return EXIT_REFUSED;
    }
    removed = true;
  } finally {
    if (!removed) {
      let restored = false;
      try {
        mkdirSync(record.path, { recursive: true });
        renameSync(stagedConduct, conductDir);
        restored = existsSync(conductDir);
      } catch {
        restored = false;
      }
      if (restored) {
        try {
          unlinkSync(manifestPath);
        } catch {
          console.error(`reap: could not remove the transaction manifest ${manifestPath}; the next run reconciles it`);
        }
        console.error(`reap: restored .conduct/ into ${record.path}; verified present at ${conductDir}`);
      } else {
        console.error(
          `reap: could not restore .conduct/ into ${record.path}; artifacts preserved at ${stagedConduct}; the open transaction manifest ${manifestPath} keeps every later run nonzero until this is resolved by hand`,
        );
      }
      if (registrationAfterFailure === 'unregistered') {
        console.error(
          `reap: git unregistered the worktree during the failed removal; ${record.path} will NOT appear as a worktree in later reports; recover the ${restored ? 'restored artifacts' : 'preserved artifacts'} by hand`,
        );
      } else if (registrationAfterFailure === 'unknown') {
        console.error(`reap: could not verify whether ${record.path} is still registered after the failed removal`);
      }
    }
  }
  let stagedGone = false;
  try {
    rmSync(stagedConduct, { recursive: true, force: true });
    stagedGone = !existsSync(stagedConduct);
  } catch {
    stagedGone = false;
  }
  if (!stagedGone) {
    console.error(`reap: removal succeeded but the staged .conduct/ copy could not be deleted; artifacts remain at ${stagedConduct}`);
    console.error(`reap: the open transaction manifest ${manifestPath} keeps every later run nonzero until this is resolved by hand`);
    return EXIT_INTERNAL;
  }
  try {
    unlinkSync(manifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`reap: removal succeeded but the transaction manifest ${manifestPath} could not be deleted: ${detail}; the next run reconciles it`);
    return EXIT_INTERNAL;
  }
  console.log(`removed: ${record.path}`);
  return EXIT_CLEAN;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.problems.length > 0) {
    for (const problem of parsed.problems) console.error(`reap: ${problem}`);
    console.error('reap: report:  node reap.mjs [root ...]');
    console.error('reap: destroy: node reap.mjs --destroy <exact canonical worktree path> [--confirm <same path>]');
    return EXIT_BAD_INVOCATION;
  }
  const roots = [process.cwd(), ...parsed.roots];
  const discovered = discoverRepos(roots);
  if (discovered.failures.length > 0) {
    // A tool that could not look must never report clean: print every cause and
    // fail closed instead of letting a broken git look like an empty machine.
    for (const failure of discovered.failures) console.error(`reap: discovery could not look: ${failure}`);
    console.error('reap: no clean verdict is possible while discovery cannot look; fix the cause above and rerun.');
    return EXIT_INTERNAL;
  }
  // Reconcile interrupted teardown transactions before any report or destroy: a
  // hard-killed destroy leaves a staged .conduct/ sibling plus a manifest, and no
  // verdict is trustworthy while those artifacts sit outside their worktree.
  const reconciliation = reconcileTransactions(transactionScanDirs(roots, discovered.repos, parsed.destroy));
  for (const action of reconciliation.actions) console.log(`reap: reconciled interrupted teardown: ${action}`);
  for (const problem of reconciliation.unresolved) {
    console.error(`  ${'OWNED-ACTIONABLE'.padEnd(21)} ${problem.where}  :: ${problem.detail}`);
  }
  if (parsed.destroy !== null) {
    if (reconciliation.unresolved.length > 0) {
      return refuse(
        canonical(parsed.destroy),
        'unresolved teardown transactions remain (listed above); resolve them by hand before any new destroy',
      );
    }
    return destroyOne(discovered.repos, parsed.destroy, parsed.confirm);
  }
  return report(discovered.repos, reconciliation.unresolved.length);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`reap: internal failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = EXIT_INTERNAL;
}
