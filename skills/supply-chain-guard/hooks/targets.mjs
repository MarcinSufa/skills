// Bash command -> what it would install.
// Target: { ecosystem: 'npm' | 'PyPI' | 'vsx', name, spec, manager, local? }
// bulk: installs with no named package that still resolve fresh versions (cannot be diffed per package).
// unreviewable: installs the guard cannot pin to one registry version (git, URL, alias, custom index, range, opaque shell).

import { isBuiltin } from 'node:module';

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')']);
const WRAPPERS = new Set(['sudo', 'doas', 'time', 'command', 'exec', 'builtin', 'nice', 'nohup', 'env', 'xargs', 'parallel', 'timeout', 'setsid', 'stdbuf', 'ionice', 'flock', 'chronic', 'unbuffer', 'caffeinate', 'corepack', 'taskset', 'chrt', 'numactl', 'prlimit', 'systemd-run', 'runuser', 'su', 'watch']);
const POWERSHELL_CALL = '\0';
const KEYWORDS = new Set(['if', 'then', 'do', 'else', 'elif', 'while', 'until', '{', '!', POWERSHELL_CALL]);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh']);
const EDITORS = new Set(['code', 'cursor', 'code-insiders', 'codium', 'windsurf']);
const DATA_COMMANDS = new Set(['cat', 'tee', 'git', 'gh']);
const NON_EXECUTING_COMMANDS = new Set(['echo', 'printf', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc']);
const CONFIG_READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'ls', 'stat', 'file', 'diff']);
const UNREVIEWED_MANAGERS = new Set(['cargo', 'poetry', 'pdm', 'hatch', 'gem', 'bundle', 'bundler', 'go', 'conda', 'mamba', 'micromamba', 'composer', 'dotnet', 'deno', 'pixi', 'rye']);
const CONFIG_FILE_PATH = /(?:^|[/\\]|[^A-Za-z0-9_./\\-])(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.(?:c|m)js|pnpm-workspace\.yaml|\.corepack\.env|pip\.conf|pip\.ini|uv\.toml|pyproject\.toml|\.bunfig\.toml|bunfig\.toml|\.condarc|nuget\.config|\.cargo[/\\]config(?:\.toml)?|\.gemrc)(?=$|[^A-Za-z0-9_./\\-])/i;
const PNPM_CONFIG_PATH = /(?:^|[/\\]|[^A-Za-z0-9_./\\-])pnpm[/\\](?:rc|config\.yaml)(?=$|[^A-Za-z0-9_./\\-])/i;
const TRUST_LOCKFILE_REASON = 'trust-lockfile skips the release cooldown; allowed only on one pnpm install --frozen-lockfile';
const isTrustLockfileEnvironmentName = (name) => /^(?:PNPM|NPM)_CONFIG_TRUST[_-]LOCKFILE$/i.test(name);
const TRUST_LOCKFILE_NAME_PATTERN = '(?:PNPM|NPM)_CONFIG_TRUST[_-]LOCKFILE';
const TRUST_LOCKFILE_MENTION = new RegExp(`(?:${TRUST_LOCKFILE_NAME_PATTERN}|trust[-_.]?lockfile)`, 'i');
const trustLockfileLiteralEnabled = (value) => /^(?:true|1|yes|on)$/i.test(String(value ?? '').trim());
const trustLockfileExplicitlyFalse = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === "''" || trimmed === '""') return true;
  let literal = trimmed;
  if (/^'(?:[^']|'')*'$/.test(trimmed)) literal = trimmed.slice(1, -1).replace(/''/g, "'");
  else if (/^"[^`$]*"$/.test(trimmed)) literal = trimmed.slice(1, -1);
  return /^(?:false|0|no|off|)$/i.test(literal.trim())
    && (literal.trim() !== '' || value === '' || trimmed === "''" || trimmed === '""');
};
const isTrustLockfileConfigKey = (key) => String(key ?? '').toLowerCase().replace(/[-_.]/g, '') === 'trustlockfile';
const TRUST_LOCKFILE_OPTION = /^--trust[-_]?lockfile(?:=(.*))?$/i;
const trustLockfileOptionEnabled = (arg) => {
  const match = TRUST_LOCKFILE_OPTION.exec(arg);
  return !!match && (match[1] === undefined || booleanEnvironmentValue(match[1]));
};
function trustLockfileConfigOptionEnabled(args) {
  for (let i = 0; i < args.length; i++) {
    const match = /^(--config[.-]trust[-_]?lockfile)(?:=(.*))?$/i.exec(args[i]);
    if (!match) continue;
    if (args[i].includes('=')) {
      if (booleanEnvironmentValue(match[2])) return true;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      if (booleanEnvironmentValue(next)) return true;
      i++;
    } else return true;
  }
  return false;
}
const NPM_FAMILY = ['npm', 'pnpm', 'yarn', 'bun'];
const MANAGER_BINARY_ALIASES = { yarnpkg: 'yarn', pn: 'pnpm', pnx: 'pnpx', uvw: 'uv' };
function commandBase(command, shell = 'bash') {
  const base = command.split(/[\\/]/).at(-1) ?? '';
  const normalized = base.replace(/\.(?:cmd|bat|exe|com|ps1)$/i, '');
  const name = shell === 'powershell' || normalized !== base ? normalized.toLowerCase() : base;
  return MANAGER_BINARY_ALIASES[name] ?? name;
}

const VALUES = {
  npm: ['--registry', '--prefix', '-w', '--workspace', '--tag', '--cache', '--userconfig', '--globalconfig', '--location', '-C', '--loglevel', '--logs-dir', '--logs-max', '--maxsockets', '--fetch-retries', '--fetch-timeout', '--fetch-retry-maxtimeout', '--fetch-retry-mintimeout', '--cafile', '--cert', '--key', '--proxy', '--https-proxy', '--local-address', '--include', '--omit', '--before', '--scope', '--access', '--init-module', '--editor'],
  pnpm: ['--registry', '--config.registry', '--config.configDir', '--config.npmrcAuthFile', '--userconfig', '--globalconfig', '--location', '-C', '--dir', '--filter', '-F', '--config-dir', '--store-dir', '--reporter', '--loglevel'],
  yarn: ['--cwd', '--registry', '--modules-folder', '--cache-folder', '--mutex', '--network-concurrency', '--use-yarnrc'],
  bun: ['--cwd', '--registry', '-c', '--config', '--backend', '--cache-dir', '--env-file', '--preload', '--define', '--target', '--jsx', '--jsx-factory', '--jsx-fragment', '--tsconfig-override', '--max-http-header-size', '--fetch-preconnect', '--dns-result-order', '--user-agent'],
  npx: ['-p', '--package', '-c', '--call', '--registry', '--cache', '--prefix', '-w', '--workspace'],
  py: [
    '-c', '--constraint', '--constraints', '--build-constraint', '--build-constraints', '-b', '--override', '--overrides', '-r', '--requirement', '--requirements', '--requirements-from-script', '--lock', '--preinstall', '--app',
    '-i', '--index-url', '--extra-index-url', '--index', '--default-index', '-f', '--find-links', '--python', '-p',
    '--target', '-t', '--prefix', '--root', '--with', '--with-requirements', '--with-editable', '--from', '--spec', '--project', '--directory',
    '--group', '--requirements', '--optional', '--extra', '--cwd', '--python-version', '--platform', '--upgrade-package', '-P', '--src', '--config-file',
    '--cache-dir', '--log', '--trusted-host', '--proxy', '--cert', '--client-cert', '--timeout', '--retries', '--exists-action', '--extra-pip-args',
    '--index-strategy', '--keyring-provider', '--resolution', '--prerelease', '--exclude-newer', '--only-binary', '--no-binary', '--pip-args',
    '--dest', '-d', '--wheel-dir', '-w', '--pypi-mirror',
  ],
  pip: ['--resume-retries', '--use-feature', '--use-deprecated'],
  uv: ['--color', '--allow-insecure-host', '--native-tls', '--link-mode', '--config-setting', '--config-settings', '--env-file', '--config-file', '--project', '--directory'],
  pipx: ['--python', '--pip-args', '--fetch-python', '--include-resources-from', '--upgrade-strategy', '--suffix', '--backend', '--cooldown', '--output', '--python-args'],
  pipenv: ['--python', '--pypi-mirror'],
  deno: ['--config', '-c', '--import-map', '--cert', '--location', '--v8-flags', '--seed', '--watch-exclude', '--env-file', '--conditions', '--ext'],
  editor: ['--user-data-dir', '--extensions-dir', '--profile'],
};
const valueSet = Object.fromEntries(Object.entries(VALUES).map(([k, v]) => [k, new Set(v)]));
for (const manager of ['pip', 'uv', 'pipx', 'pipenv']) valueSet[manager] = new Set([...valueSet.py, ...valueSet[manager]]);
const valuesForManager = (manager) => valueSet[manager] ?? valueSet.py;
const RUNNER_ALIASES = { npx: 'npmExec', bunx: 'bunX', pnpx: 'pnpmDlx', uvx: 'uvToolRun' };
const canonicalRunnerName = (name) => RUNNER_ALIASES[name] ?? name;
const canonicalManagerName = (manager) => ({ npx: 'npm', bunx: 'bun', pnpx: 'pnpm', uvx: 'uv' })[manager] ?? manager;
const RUNNER_VALUES = {
  npmExec: new Set([...VALUES.npm, '--package', '--call', '-c', '--workspace', '-w', '--allow-scripts']),
  pnpmDlx: new Set([...VALUES.pnpm, '--package', '--allow-build', '--reporter']),
  pnpmExec: new Set([...VALUES.pnpm, '--resume-from', '--workspace-concurrency', '--reporter']),
  yarnDlx: new Set(['--package', '-p', '--cwd']),
  yarnExec: new Set(['--cwd']),
  bunX: new Set(['-p', '--package', '--cwd', '--env-file', '--minimum-release-age']),
  bunExec: new Set(['--cwd', '--env-file']),
  bunRun: new Set([...VALUES.bun, '--watch', '--hot', '--no-clear-screen']),
  uvRun: new Set([
    '--extra', '--no-extra', '--group', '--no-group', '--only-group', '--no-editable-package', '--env-file',
    '--with', '--with-editable', '--with-requirements', '--package', '--python-platform', '--index', '--default-index',
    '-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--index-strategy', '--keyring-provider',
    '-P', '--upgrade-package', '--upgrade-group', '--resolution', '--prerelease', '--prerelease-package',
    '--fork-strategy', '--exclude-newer', '--exclude-newer-package', '--no-sources-package', '--reinstall-package', '--link-mode',
    '-C', '--config-setting', '--config-settings-package', '--no-build-package', '--no-binary-package',
    '--no-build-isolation-package', '--refresh-package', '--cache-dir', '-p', '--python', '--color', '--allow-insecure-host', '--directory',
    '--project', '--config-file',
  ]),
  uvToolRun: new Set([
    '--from', '-w', '--with', '--with-editable', '--with-requirements', '-c', '--constraints', '-b',
    '--build-constraints', '--overrides', '--env-file', '--python-platform', '--torch-backend', '--index',
    '--default-index', '-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--index-strategy',
    '--keyring-provider', '-P', '--upgrade-package', '--upgrade-group', '--resolution', '--prerelease',
    '--prerelease-package', '--fork-strategy', '--exclude-newer', '--exclude-newer-package', '--no-sources-package',
    '--reinstall-package', '--link-mode', '-C', '--config-setting', '--config-settings-package',
    '--no-build-isolation-package', '--no-build-package', '--no-binary-package', '--cache-dir', '--refresh-package', '-p', '--python',
    '--color', '--allow-insecure-host', '--config-file', '--directory', '--project',
  ]),
  pipxRun: new Set([
    '--python-args', '--with', '--spec', '--python', '--fetch-python', '--index-url', '-i', '-f', '--find-links', '--pip-args',
    '--cooldown', '--backend',
  ]),
};
const RUNNER_FLAGS = {
  npmExec: new Set(['--yes', '-y', '--no-install', '--no', '--offline', '--prefer-offline', '--workspaces', '--ws', '--include-workspace-root', '--strict-allow-scripts', '--dangerously-allow-all-scripts']),
  pnpmDlx: new Set(['-c', '--shell-mode', '--silent', '-s']),
  pnpmExec: new Set(['-c', '--shell-mode', '-r', '--recursive', '--parallel', '--report-summary', '--no-reporter-hide-prefix']),
  yarnDlx: new Set(['-q', '--quiet', '-v', '--verbose']),
  yarnExec: new Set([]),
  bunX: new Set(['--bun', '--no-install', '--use-system-ca', '--use-openssl-ca', '--use-bundled-ca', '--trust', '--verbose', '--silent']),
  bunExec: new Set([]),
  bunRun: new Set(['--silent', '--if-present', '--workspaces', '--parallel', '--sequential', '--no-exit-on-error']),
  uvRun: new Set([
    '--all-extras', '--all-groups', '--all-packages', '--active', '--exact', '--frozen', '--gui-script',
    '--isolated', '--locked', '--managed-python', '--module', '-m', '--no-build', '--no-build-isolation',
    '--no-config', '--no-default-groups', '--no-dev', '--no-editable', '--no-env-file', '--no-index',
    '--no-managed-python', '--no-project', '--no-python-downloads', '--no-sync', '--no-sources', '--only-dev',
    '--reinstall', '--refresh', '--script', '-s', '--system-certs', '--native-tls', '--offline', '--no-progress',
    '--compile-bytecode', '-U', '--upgrade', '-n', '--no-cache', '-q', '--quiet', '-v', '--verbose',
  ]),
  uvToolRun: new Set(['--isolated', '--no-env-file', '--no-index', '--no-managed-python', '--no-python-downloads', '--no-build-isolation', '--no-build', '--no-binary', '--no-sources', '-n', '--no-cache', '--refresh', '-U', '--upgrade', '--managed-python', '--system-certs', '--offline', '--no-progress', '-q', '--quiet', '-v', '--verbose']),
  pipxRun: new Set(['--quiet', '-q', '--verbose', '-v', '--skip-maintenance', '--global', '--no-cache', '--refresh', '--no-path-check', '--path', '--pypackages', '--system-site-packages', '--editable', '-e', '--fetch-missing-python']),
};
const RUNNER_PACKAGES = {
  npmExec: ['--package'], pnpmDlx: ['--package'], pnpmExec: [], yarnDlx: ['--package', '-p'],
  yarnExec: [], bunX: ['--package', '-p'], bunExec: [], uvRun: [], uvToolRun: ['--from'],
  pipxRun: ['--spec'],
};
const RUNNER_CALLS = { npmExec: ['-c', '--call'] };
const RUNNER_ALIAS_VALUES = { npx: new Set(['-p']) };
const RUNNER_ALIAS_PACKAGES = { npx: ['-p'] };
const RUNNER_DEFAULT_PACKAGE = new Set(['npmExec', 'pnpmDlx', 'yarnDlx', 'bunX']);
const runnerValues = (name) => {
  const values = RUNNER_VALUES[canonicalRunnerName(name)] ?? RUNNER_VALUES.npmExec;
  const aliasValues = RUNNER_ALIAS_VALUES[name];
  return aliasValues ? new Set([...values, ...aliasValues]) : values;
};
const runnerFlags = (name) => RUNNER_FLAGS[canonicalRunnerName(name)] ?? new Set();
const runnerPackages = (name) => [...(RUNNER_PACKAGES[canonicalRunnerName(name)] ?? []), ...(RUNNER_ALIAS_PACKAGES[name] ?? [])];
const runnerCalls = (name) => RUNNER_CALLS[canonicalRunnerName(name)] ?? [];
const runnerReadingsFor = (name, args) => runnerReadings(args, runnerValues(name), runnerFlags(name));
const ENVIRONMENT_RUNNER_VALUES = {
  poetry: new Set(['--directory', '-C', '--project', '-P']),
  pdm: new Set(['--project', '-p']),
  hatch: new Set(['--env', '-e']),
  pipenv: new Set(['--python', '--pypi-mirror']),
  rye: new Set(['--env-file']),
  pixi: new Set(['--manifest-path', '-m', '--workspace', '-w', '--script', '-s', '--auth-file', '--tls-root-certs', '--env-file']),
  conda: new Set(['--channel', '-c', '--repodata-fn', '--experimental', '--solver', '--name', '-n', '--prefix', '-p', '--file']),
  mamba: new Set(['--channel', '-c', '--repodata-fn', '--solver', '--name', '-n', '--prefix', '-p', '--root-prefix', '-r', '--rc-file', '--env-file']),
  micromamba: new Set(['--channel', '-c', '--repodata-fn', '--solver', '--name', '-n', '--prefix', '-p', '--root-prefix', '-r', '--rc-file', '--env-file']),
  bundle: new Set(['--gemfile', '-g']),
  mise: new Set(['--cd', '-C', '--env', '-E', '--jobs', '-j']),
  asdf: new Set(),
  volta: new Set(),
  fnm: new Set(['--fnm-dir', '--node-dist-mirror', '--log-level', '--arch', '--version-file-strategy']),
  nvm: new Set(),
  direnv: new Set(),
  devbox: new Set(),
  nix: new Set([
    '--option', '--extra-experimental-features', '--experimental-features', '--extra-substituters', '--extra-trusted-public-keys',
    '--log-format', '--download-speed', '--extra-nix-path', '--builders', '--cores', '--connect-timeout', '--arg', '--argstr',
    '--arg-from-file', '--arg-from-stdin', '--eval-store', '--include', '-I', '--expr', '--file', '-f', '--extra-access-tokens',
  ]),
};
const ENV_FILE_WRAPPER_VALUES = {
  dotenv: new Set(['-e', '--env', '--env-file', '-c', '--command']),
  dotenvx: new Set(['-f', '--env-file']),
  'env-cmd': new Set(['-f', '--file', '-e', '--env', '--env-file']),
};
function envFileWrapperArgs(base, args) {
  const values = ENV_FILE_WRAPPER_VALUES[base];
  if (!values || (base === 'dotenvx' && args[0] !== 'run')) return undefined;
  return { args: base === 'dotenvx' ? args.slice(1) : args, values };
}
const ENVIRONMENT_INSTALL_REASON = 'install inside an environment runner that can load project environment';
function askForEnvironmentInstall(result, state, installActionsBefore, manager, raw) {
  if (state.installActions <= installActionsBefore
    || result.unreviewable.some(({ reason }) => reason === ENVIRONMENT_INSTALL_REASON)) return;
  result.unreviewable.push({ manager, raw, reason: ENVIRONMENT_INSTALL_REASON });
}
const isKnown = (name, shell = 'bash') => {
  const base = commandBase(name, shell);
  return NPM_FAMILY.includes(base) || SHELLS.has(base) || EDITORS.has(base) || (UNREVIEWED_MANAGERS.has(base) && base !== 'deno') || ['npx', 'bunx', 'pnpx', 'uv', 'uvx', 'pipx', 'pipenv', 'eval'].includes(base) || ENV_FILE_WRAPPER_VALUES[base] !== undefined || powerShellExecutable(base, shell) || /^(pip|python)(3(\.\d+)?)?$/.test(base);
};
const ENVIRONMENT_RUNNER_VALUE_COUNTS = {
  nix: new Map([['--option', 2], ['--arg', 2], ['--argstr', 2], ['--arg-from-file', 2]]),
};
const managerWords = (args, values, manager) => {
  const readings = [];
  const visit = (index, words, ambiguous = false) => {
    const limit = (manager === 'uv' && ['pip', 'tool'].includes(words[0]))
      || (manager === 'deno' && words[0] === 'run')
      || (manager === 'yarn' && words[0] === 'global')
      || (manager === 'yarn' && words[0] === 'policies')
      || (manager === 'pnpm' && ['env', 'runtime', 'rt'].includes(words[0]))
      || (manager === 'npm' && ['audit', 'cache', 'stage'].includes(words[0])) ? 2 : 1;
    if (words.length >= limit || index >= args.length || readings.length >= 128) {
      readings.push({ words, ambiguous });
      return;
    }
    const arg = args[index];
    if (arg === '--') {
      readings.push({ words: [...words, ...args.slice(index + 1, index + 1 + limit - words.length)], ambiguous });
      return;
    }
    if (!arg.startsWith('-')) {
      visit(index + 1, [...words, arg], ambiguous);
      return;
    }
    const exactValue = values.has(arg);
    const attachedValue = [...values].some((option) => option.length === 2 && arg.startsWith(option) && arg.length > option.length);
    if (arg.includes('=') || exactValue || attachedValue) {
      visit(index + 1 + (exactValue ? 1 : 0), words, ambiguous);
      return;
    }
    visit(index + 1, words, true);
    visit(index + 2, words, true);
  };
  visit(0, [], false);
  return readings;
};
const ADDITIONAL_INSTALL_READINGS = { npm: ['ci', 'install-ci-test'], pnpm: ['install-test'], yarn: ['install'] };
function managerReadingIsInstall(manager, words, args) {
  if (NPM_FAMILY.includes(manager)) {
    let [sub, next] = words;
    if (manager === 'yarn' && sub === 'global') [sub, next] = [next, words[2]];
    if (NPM_VERBS.install[manager]?.includes(sub) || ADDITIONAL_INSTALL_READINGS[manager]?.includes(sub)
      || NPM_VERBS.update[manager]?.includes(sub)
      || NPM_VERBS.create[manager]?.includes(sub)) return true;
    if (manager === 'npm' && ((sub === 'audit' && next === 'fix') || (sub === 'cache' && next === 'add')
      || (sub === 'stage' && next === 'download') || sub === 'self-update')) return true;
    if (manager === 'pnpm' && (sub === 'self-update' || sub === 'with'
      || (sub === 'runtime' && next === 'set') || (sub === 'rt' && next === 'set')
      || (sub === 'env' && next === 'use'))) return true;
    return manager === 'bun' && sub === 'upgrade';
  }
  if (manager === 'pip') return ['install', 'download', 'wheel'].includes(words[0]);
  if (manager === 'pipx') return ['install', 'install-all', 'inject', 'run', 'exec', 'upgrade', 'upgrade-all', 'reinstall', 'reinstall-all', 'upgrade-shared', 'repair'].includes(words[0]);
  if (manager === 'pipenv') return ['install', 'sync', 'upgrade', 'update', 'lock'].includes(words[0]);
  if (manager === 'uv') return ['add', 'sync'].includes(words[0])
    || (words[0] === 'pip' && ['install', 'download', 'wheel', 'sync', 'compile'].includes(words[1]))
    || (words[0] === 'tool' && ['install', 'run', 'upgrade'].includes(words[1]));
  if (manager === 'deno') return ['add', 'install', 'update', 'cache', 'upgrade', 'create'].includes(words[0])
    || (words[0] === 'run' && /(?:npm:|jsr:|https?:\/\/)/i.test(args.join(' ')));
  return false;
}
function managerReadingSet(argv, shell) {
  const index = commandPosition(argv, shell);
  const base = commandBase(argv[index] ?? '', shell);
  let manager = base;
  let args = argv.slice(index + 1);
  if (/^python(3(\.\d+)?)?$/.test(base)) {
    const module = args.indexOf('-m');
    if (module < 0 || !/^pip(3(\.\d+)?)?$/.test(commandBase(args[module + 1] ?? '', shell))) return { manager, readings: [] };
    manager = 'pip';
    args = args.slice(module + 2);
  } else if (/^pip(3(\.\d+)?)?$/.test(base)) manager = 'pip';
  if (![...NPM_FAMILY, 'pip', 'pipx', 'pipenv', 'uv', 'deno'].includes(manager)) return { manager, readings: [] };
  return { manager, readings: managerWords(args, valuesForManager(manager), manager), args };
}
function managerHasInstallReading(argv, shell) {
  const { manager, readings, args } = managerReadingSet(argv, shell);
  return readings.some(({ words }) => managerReadingIsInstall(manager, words, args));
}
function managerHasAmbiguousInstallReading(argv, shell) {
  const { manager, readings, args } = managerReadingSet(argv, shell);
  return readings.some(({ words, ambiguous }) => ambiguous && managerReadingIsInstall(manager, words, args));
}
const ALL_VALUE_OPTIONS = new Set(Object.values(valueSet).flatMap((values) => [...values]));
const REDIRECT_FLAGS = /^(?:(?<configFile>--userconfig|--globalconfig|--use-yarnrc|--config-file|--config-dir|--config|--config\.configDir|--config\.npmrcAuthFile|--pipfile|--env-file)(?:=|$)|(?<source>--reg(?:istry)?|--config\.registry|--index-url|--extra-index-url|--index|--default-index|--find-links|--trusted-host|--pypi-mirror)(?:=|$)|--@[^=]+:registry)/;
const LONG_REDIRECT_OPTIONS = {
  npm: ['--registry', '--userconfig', '--globalconfig'],
  pnpm: ['--registry', '--config.registry', '--config.configDir', '--config.npmrcAuthFile', '--config-dir', '--userconfig', '--globalconfig'],
  yarn: ['--registry', '--use-yarnrc'],
  bun: ['--registry', '--config'],
  pip: ['--index-url', '--extra-index-url', '--find-links', '--trusted-host'],
  pipx: ['--index-url', '--find-links', '--trusted-host'],
  uv: ['--index-url', '--extra-index-url', '--index', '--default-index', '--find-links', '--trusted-host', '--config-file'],
  pipenv: ['--index-url', '--extra-index-url', '--index', '--default-index', '--find-links', '--trusted-host', '--pypi-mirror'],
};
const ABBREVIATED_LONG_OPTION_MANAGERS = new Set(['npm', 'pnpm', 'pip', 'pipx', 'pipenv']);
const DOCUMENTED_LONG_OPTION_PREFIXES = { npm: ['--global'], pnpm: ['--global', '--config'], pipenv: ['--index'] };
const PIP_ENV_OPTIONS = {
  PIP_INDEX_URL: '--index-url', PIP_PYPI_URL: '--index-url', PIP_EXTRA_INDEX_URL: '--extra-index-url',
  PIP_FIND_LINKS: '--find-links', PIP_TRUSTED_HOST: '--trusted-host', PIP_NO_INDEX: '--no-index',
  PIP_REQUIREMENT: '--requirement', PIP_CONSTRAINT: '--constraint', PIP_BUILD_CONSTRAINT: '--build-constraint',
  PIP_EDITABLE: '--editable', PIP_REQUIREMENTS_FROM_SCRIPT: '--requirements-from-script', PIP_GROUP: '--group',
  PIP_CONFIG_SETTINGS: '--config-settings', PIP_CONFIG_FILE: '--config-file',
};
const UV_ENV_OPTIONS = {
  UV_INDEX_URL: '--index-url', UV_DEFAULT_INDEX: '--default-index', UV_EXTRA_INDEX_URL: '--extra-index-url',
  UV_INDEX: '--index', UV_FIND_LINKS: '--find-links', UV_CONFIG_FILE: '--config-file',
  UV_CONSTRAINT: '--constraints', UV_BUILD_CONSTRAINT: '--build-constraints', UV_OVERRIDE: '--overrides',
  UV_INDEX_STRATEGY: '--index-strategy', UV_PRERELEASE: '--prerelease', UV_CACHE_DIR: '--cache-dir', UV_PROJECT: '--project',
};
const PIPX_ENV_OPTIONS = {
  PIPX_DEFAULT_PYTHON: '--python', PIPX_DEFAULT_BACKEND: '--backend', PIPX_COOLDOWN: '--cooldown',
  PIPX_FETCH_PYTHON: '--fetch-python', PIPX_FETCH_MISSING_PYTHON: '--fetch-python',
  PIPX_DISABLE_SHARED_LIBS_AUTO_UPGRADE: '--skip-maintenance',
};
const PIPENV_ENV_OPTIONS = {
  PIPENV_PYPI_MIRROR: '--pypi-mirror', PIPENV_PIPFILE: '--pipfile',
  PIPENV_PYTHON: '--python', PIPENV_DEFAULT_PYTHON_VERSION: '--python',
};
const PACKAGE_MANAGER_ENV_OPTIONS = {
  npm: {
    NPM_CONFIG_REGISTRY: '--registry', NPM_CONFIG_USERCONFIG: '--userconfig', NPM_CONFIG_GLOBALCONFIG: '--globalconfig',
    COREPACK_NPM_REGISTRY: '--registry',
  },
  pnpm: {
    PNPM_CONFIG_REGISTRY: '--registry', PNPM_CONFIG_CONFIG_DIR: '--config-dir',
    PNPM_CONFIG_NPMRC_AUTH_FILE: '--config.npmrcAuthFile', PNPM_CONFIG_USERCONFIG: '--userconfig',
    PNPM_CONFIG_GLOBALCONFIG: '--globalconfig', NPM_CONFIG_USERCONFIG: '--userconfig',
    COREPACK_NPM_REGISTRY: '--registry',
  },
  yarn: {
    NPM_CONFIG_REGISTRY: '--registry', YARN_NPM_REGISTRY_SERVER: '--registry', YARN_RC_FILENAME: '--use-yarnrc',
    COREPACK_NPM_REGISTRY: '--registry',
  },
  bun: { NPM_CONFIG_REGISTRY: '--registry', BUN_CONFIG_REGISTRY: '--registry' },
};
const ARGUMENT_ENVIRONMENT_OPTIONS = { bun: ['BUN_OPTIONS'], pipenv: ['PIPENV_EXTRA_PIP_ARGS'] };
const KNOWN_REGISTRY_ENV_OPTIONS = new Set([
  'PIP_INDEX_URL', 'PIP_PYPI_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS', 'PIP_TRUSTED_HOST',
  'UV_INDEX_URL', 'UV_DEFAULT_INDEX', 'UV_EXTRA_INDEX_URL', 'UV_INDEX', 'UV_FIND_LINKS',
  'PIPENV_PYPI_MIRROR', 'COREPACK_NPM_REGISTRY',
  'NPM_CONFIG_REGISTRY', 'PNPM_CONFIG_REGISTRY', 'YARN_NPM_REGISTRY_SERVER', 'BUN_CONFIG_REGISTRY',
]);
const ARGUMENT_ENVIRONMENT_NAMES = new Set([
  ...Object.values(ARGUMENT_ENVIRONMENT_OPTIONS).flat(),
  ...Object.keys(PIP_ENV_OPTIONS), ...Object.keys(UV_ENV_OPTIONS), ...Object.keys(PIPX_ENV_OPTIONS),
  ...Object.keys(PIPENV_ENV_OPTIONS), ...Object.values(PACKAGE_MANAGER_ENV_OPTIONS).flatMap((options) => Object.keys(options)),
  'COREPACK_ENV_FILE',
].map((name) => name.toUpperCase()));
const KNOWN_CONFIG_ENV_OPTIONS = new Set([
  'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'PNPM_CONFIG_USERCONFIG', 'PNPM_CONFIG_GLOBALCONFIG',
  'PNPM_CONFIG_CONFIG_DIR', 'PNPM_CONFIG_NPMRC_AUTH_FILE', 'PIP_CONFIG_FILE', 'UV_CONFIG_FILE',
  'YARN_RC_FILENAME', 'PIPENV_PIPFILE',
]);
const SHORT_REDIRECT_OPTIONS = {
  pip: { values: { i: 'source', f: 'source' }, flags: new Set(['q', 'v', 'U', 'I']), forms: new Set(['separate', 'attached', 'equals', 'clustered', 'normalized']) },
  uv: { values: { i: 'source', f: 'source' }, flags: new Set(['q', 'v', 'U', 'n']), forms: new Set(['separate', 'attached', 'equals', 'clustered', 'normalized']) },
  pipx: { values: { i: 'source' }, flags: new Set(['U', 'e', 'f']), forms: new Set(['separate', 'attached', 'equals', 'clustered', 'normalized']) },
  pipenv: { values: { i: 'source' }, flags: new Set(['q', 'v', 'd']), forms: new Set(['separate', 'attached', 'equals', 'clustered', 'normalized']) },
  bun: { values: { c: 'configFile' }, flags: new Set(), forms: new Set(['separate', 'equals', 'normalized']) },
};
const PYTHON_INDEX_TOOLS = new Set(['pip', 'uv', 'pipx', 'pipenv']);
function resolvedPythonIndexTool(argv, shell) {
  const index = commandPosition(argv, shell);
  const base = commandBase(argv[index] ?? '', shell);
  let manager = base;
  if (/^python(3(\.\d+)?)?$/.test(base)) {
    const module = argv.indexOf('-m', index + 1);
    manager = module < 0 || !/^pip(3(\.\d+)?)?$/.test(commandBase(argv[module + 1] ?? '', shell)) ? undefined : 'pip';
  } else if (/^pip(3(\.\d+)?)?$/.test(base)) manager = 'pip';
  manager = canonicalManagerName(manager);
  return PYTHON_INDEX_TOOLS.has(manager) ? manager : undefined;
}
const isRegistryEnvName = (name) => {
  const key = name.toUpperCase();
  if (key === 'PIP_NO_INDEX') return false;
  return KNOWN_REGISTRY_ENV_OPTIONS.has(key)
    || /^NPM_CONFIG_.*REGISTRY/.test(key)
    || /^PNPM_CONFIG_.*REGISTRY/.test(key)
    || /^YARN_.*REGISTRY/.test(key)
    || /^BUN_CONFIG_.*REGISTRY/.test(key);
};
const isConfigFileEnvName = (name) => /^(?:NPM|PNPM)_CONFIG_(?:USERCONFIG|GLOBALCONFIG)$/i.test(name)
  || /^PNPM_CONFIG_(?:CONFIG_DIR|NPMRC_AUTH_FILE)$/i.test(name)
  || /^(?:PIP_CONFIG_FILE|UV_CONFIG_FILE|COREPACK_ENV_FILE|YARN_RC_FILENAME|PIPENV_PIPFILE)$/i.test(name);
const isRedirectEnvName = (name) => isRegistryEnvName(name) || isConfigFileEnvName(name);
const hasRedirectEnvForCommands = (env) => {
  const names = Object.keys(env ?? {}).filter(isRegistryEnvName);
  return names.length > 0;
};
const hasRedirectConfigEnv = (env) => Object.entries(env ?? {}).some(([name, value]) => isConfigFileEnvName(name)
  && name.toUpperCase() === 'COREPACK_ENV_FILE' && String(value) !== '0');
const REDIRECT_ENV_ASSIGNMENT = /\b([\w@:-]+)\s*=/g;
const hasRedirectEnvAssignment = (text) => [...text.matchAll(REDIRECT_ENV_ASSIGNMENT)].some((m) => {
  if (m[1].toUpperCase() === 'COREPACK_ENV_FILE'
    && /^\s*(?:'0'|"0"|0)(?=\s|[;&|]|$)/.test(text.slice(m.index + m[0].length))) return false;
  if (isConfigFileEnvName(m[1])) return !KNOWN_CONFIG_ENV_OPTIONS.has(m[1].toUpperCase());
  if (!isRegistryEnvName(m[1]) || KNOWN_REGISTRY_ENV_OPTIONS.has(m[1].toUpperCase())) return false;
  return m[1].toUpperCase() !== 'COREPACK_ENV_FILE'
    || !/^\s*(?:'0'|"0"|0)(?=\s|[;&|]|$)/.test(text.slice(m.index + m[0].length));
});
function recordArgumentEnvAssignments(argv, shell, state) {
  const assignmentFor = (args, index) => {
    const arg = args[index] ?? '';
    const standard = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(arg);
    if (standard) return { name: standard[1].toUpperCase(), value: standard[2] };
    if (shell !== 'powershell') return undefined;
    const attached = /^\$(?:env:|\{env:)([\w@:-]+)\}?(?:=(.*))?$/i.exec(arg);
    if (!attached) return undefined;
    if (attached[2] !== undefined) return { name: attached[1].toUpperCase(), value: attached[2] };
    if (args[index + 1] === '=' && args[index + 2] !== undefined) {
      return { name: attached[1].toUpperCase(), value: args[index + 2] };
    }
    return undefined;
  };
  state.environmentVariables ??= new Map();
  const index = commandPosition(argv, shell);
  const prefix = argv.slice(0, index);
  const base = commandBase(argv[index] ?? '', shell);
  const persistentAssignment = ['export', 'set', 'declare', 'typeset', 'local', 'readonly'].includes(base);
  const declarationArgs = argv.slice(index + 1);
  const exportedDeclaration = base === 'export'
    || ['declare', 'typeset', 'local', 'readonly'].includes(base)
      && declarationArgs.some((arg) => /^-[^-]*x/.test(arg));
  if (base === 'set') {
    const args = argv.slice(index + 1);
    if (args.includes('-a') || args.some((arg, i) => arg === '-o' && args[i + 1] === 'allexport')) state.autoExportEnvironment = true;
    if (args.includes('+a') || args.some((arg, i) => arg === '+o' && args[i + 1] === 'allexport')) state.autoExportEnvironment = false;
  }
  if (persistentAssignment) {
    const args = argv.slice(index + 1);
    const printOnly = isBashDeclarationPrintOnly(base, args);
    for (let i = 0; !printOnly && i < args.length; i++) {
      const found = assignmentFor(args, i);
      if (found) {
        recordEnvironmentOccurrence(state, found.name, found.value, 'persistent', exportedDeclaration);
        state.environmentVariables.set(found.name, found.value);
        state.argumentVariables.set(found.name, found.value);
        if (ARGUMENT_ENVIRONMENT_NAMES.has(found.name)) state.argumentEnv.set(found.name, found.value);
      } else if (ARGUMENT_ENVIRONMENT_NAMES.has(args[i].toUpperCase())
        && state.argumentVariables.has(args[i].toUpperCase())) {
        state.environmentVariables.set(args[i].toUpperCase(), state.argumentVariables.get(args[i].toUpperCase()));
        state.argumentEnv.set(args[i].toUpperCase(), state.argumentVariables.get(args[i].toUpperCase()));
      } else if (isTrustLockfileEnvironmentName(args[i])) {
        recordEnvironmentOccurrence(state, args[i], environmentValue(state, args[i].toUpperCase()), 'persistent', exportedDeclaration);
      }
    }
  }
  if (shell === 'powershell') {
    for (let i = 0; i < argv.length; i++) {
      const found = assignmentFor(argv, i);
      if (!found) continue;
      const statementAssignment = i === index || i < index;
      if (!isTrustLockfileEnvironmentName(found.name) || statementAssignment) {
        recordEnvironmentOccurrence(state, found.name, found.value, statementAssignment ? 'persistent' : 'other');
      }
      state.environmentVariables.set(found.name, found.value);
      if (ARGUMENT_ENVIRONMENT_NAMES.has(found.name)) state.argumentEnv.set(found.name, found.value);
    }
  } else {
    for (const arg of prefix) {
      const found = assignmentFor([arg], 0);
      if (found) {
        recordEnvironmentOccurrence(state, found.name, found.value,
          state.autoExportEnvironment ? 'persistent' : 'scoped', state.autoExportEnvironment);
        state.argumentVariables.set(found.name, found.value);
      }
    }
  }
}

function safelyTokenizeArgumentEnvironment(value, shell) {
  if (typeof value !== 'string' || hasShellExpansion(value, shell)) return undefined;
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (shell !== 'powershell' && quote === '"' && ch === '\\') i++;
    } else if (ch === '"' || ch === "'") quote = ch;
  }
  if (quote) return undefined;
  try {
    const json = JSON.parse(value);
    if (Array.isArray(json) && json.every((part) => typeof part === 'string')) return json;
  } catch {}
  const args = tokenize(value, false, shell);
  return args.some((arg) => SEPARATORS.has(arg) || /[`;$]/.test(arg)) ? undefined : args;
}

function injectedArgumentOptions(argv, manager, state) {
  manager = canonicalManagerName(manager);
  const index = commandPosition(argv, state.shell);
  const environment = new Map(state.environmentVariables ?? []);
  for (const arg of argv.slice(0, index)) {
    const found = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(arg);
    if (found) environment.set(found[1].toUpperCase(), found[2]);
    if (state.shell === 'powershell') {
      const ps = /^\$(?:env:|\{env:)([\w@:-]+)\}?(?:=(.*))?$/i.exec(arg);
      if (ps?.[2] !== undefined) environment.set(ps[1].toUpperCase(), ps[2]);
      else if (ps && argv[index - 2] === '=') environment.set(ps[1].toUpperCase(), argv[index - 1]);
    }
  }
  const groups = [];
  const optionEnvironmentValues = (name) => {
    const values = [...(state.environmentOccurrences?.get(name) ?? [])];
    const current = environment.get(name);
    if (current !== undefined && values.at(-1) !== current) values.push(current);
    return values;
  };
  const addArgumentEnvironment = (name, reviewManager, optionManager) => {
    for (const value of optionEnvironmentValues(name)) {
      const parsed = safelyTokenizeArgumentEnvironment(String(value), state.shell);
      if (!parsed) return true;
      if (parsed.length) groups.push({ args: parsed, manager: reviewManager, optionManager });
    }
    return false;
  };
  if (manager === 'bun' && addArgumentEnvironment('BUN_OPTIONS', 'bun', 'bun')) return { groups, unsafe: true };
  if (manager === 'pipenv' && addArgumentEnvironment('PIPENV_EXTRA_PIP_ARGS', 'pip', 'pip')) return { groups, unsafe: true };

  const addMappedOptions = (mapping, reviewManager, optionManager = reviewManager) => {
    const args = [];
    for (const [name, option] of Object.entries(mapping)) {
      for (const value of optionEnvironmentValues(name)) {
        if (value === '') continue;
        if (option === '--no-index') {
          if (/^(?:0|false|no|off)$/i.test(String(value).trim())) continue;
          args.push(option);
        } else args.push(option, String(value));
      }
    }
    if (args.length) groups.push({ args, manager: reviewManager, optionManager });
    return false;
  };

  if (manager === 'pip') {
    if (addMappedOptions(PIP_ENV_OPTIONS, manager)) return { groups, unsafe: true };
  } else if (manager === 'uv') {
    if (addMappedOptions(UV_ENV_OPTIONS, manager)) return { groups, unsafe: true };
  } else if (manager === 'pipx') {
    if (addMappedOptions(PIPX_ENV_OPTIONS, 'pipx')) return { groups, unsafe: true };
    if (addMappedOptions(PIP_ENV_OPTIONS, 'pipx', 'pip')) return { groups, unsafe: true };
    if (addMappedOptions(UV_ENV_OPTIONS, 'pipx', 'uv')) return { groups, unsafe: true };
  } else if (manager === 'pipenv') {
    if (addMappedOptions(PIPENV_ENV_OPTIONS, 'pipenv')) return { groups, unsafe: true };
    if (addMappedOptions(PIP_ENV_OPTIONS, 'pipenv', 'pip')) return { groups, unsafe: true };
  } else if (PACKAGE_MANAGER_ENV_OPTIONS[manager]) {
    if (addMappedOptions(PACKAGE_MANAGER_ENV_OPTIONS[manager], manager)) return { groups, unsafe: true };
  }
  return { groups, unsafe: false };
}
function rawSegments(text, shell = 'bash') {
  const out = [];
  let segment = [];
  for (const token of tokenize(text, true, shell)) {
    if (['&&', '||', ';', '|', '&', '\n'].includes(token.value)) {
      if (segment.length) out.push(text.slice(segment[0].start, segment.at(-1).end));
      segment = [];
    } else segment.push(token);
  }
  if (segment.length) out.push(text.slice(segment[0].start, segment.at(-1).end));
  return out;
}

const POWERSHELL_ENV_WRITERS = new Set(['set-item', 'si', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'copy-item', 'cpi', 'rename-item', 'move-item']);

function powerShellWriteOperands(base, args) {
  const paths = [];
  const names = [];
  const values = [];
  const positionals = [];
  const switches = new Set(['force', 'passthru', 'whatif', 'confirm', 'noclobber', 'recurse', 'verbose', 'debug', 'wait', 'directory', 'container', 'nonewline', 'asbytestream', 'raw', 'usetransaction']);
  for (let j = 0; j < args.length; j++) {
    const arg = args[j];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const split = arg.match(/^-([^:=]+)(?::|=)(.*)$/);
    const option = (split?.[1] ?? arg.slice(1)).toLowerCase();
    const target = ['path', 'literalpath', 'destination'].includes(option) ? paths
      : ['name', 'newname'].includes(option) ? names
        : option === 'value' ? values : null;
    if (split) {
      if (target) target.push(split[2]);
    } else if (!switches.has(option) && args[j + 1] !== undefined && !args[j + 1].startsWith('-')) {
      if (target) target.push(args[j + 1]);
      j++;
    }
  }
  const rename = base === 'rename-item';
  const positionalPath = ['copy-item', 'cpi', 'move-item'].includes(base) ? positionals.at(-1) : positionals[0];
  const positionalPathUsed = !paths.length && !!positionalPath;
  if (positionalPathUsed) paths.push(positionalPath);
  if (rename && positionals.length > (paths.length ? 1 : 0)) names.push(positionals.at(-1));
  else if (rename && paths.length && positionals.length === 1 && !args.some((arg) => /^-(?:newname)(?::|=|$)/i.test(arg))) names.push(positionals[0]);
  return { paths, names, values, positionals, positionalPathUsed };
}

function powerShellEnvironmentNames(base, args) {
  const { paths, names } = powerShellWriteOperands(base, args);
  const out = [];
  for (const path of paths) {
    const match = /^(?:env:|env:[\\/]+|env[\\/]+)([\w@:-]+)$/i.exec(path);
    if (match) out.push(match[1]);
    else if (/^env:$/i.test(path)) out.push(...names.filter((name) => /^[\w@:-]+$/.test(name)));
  }
  return out;
}

const hasPowerShellRedirectEnvAssignment = (text, tokens = tokenize(text)) => {
  const assignments = [];
  const setterCalls = [];
  for (const raw of rawSegments(text, 'powershell')) {
    const assignment = /^\$(?:env:|\{env:)([\w@:-]+)\}?\s*=/i.exec(raw.trim());
    if (assignment) assignments.push(assignment[1]);
    const call = /^(?:\$[A-Za-z_]\w*\s*=\s*)?\[(?:system\.)?environment\]::setenvironmentvariable\s*\(\s*(['"])([\w@:-]+)\1/i.exec(raw.trim());
    if (call) setterCalls.push(call[2]);
  }
  if (setterCalls.some(isRedirectEnvName)) return true;
  if (assignments.some((name) => isRedirectEnvName(name)
    && !KNOWN_REGISTRY_ENV_OPTIONS.has(name.toUpperCase())
    && !KNOWN_CONFIG_ENV_OPTIONS.has(name.toUpperCase()))) return true;
  if (assignments.some((name) => isRegistryEnvName(name) && !KNOWN_REGISTRY_ENV_OPTIONS.has(name.toUpperCase()))) return true;
  for (const part of segments(tokens)) {
    const i = commandPosition(part, 'powershell');
    const base = commandBase(part[i] ?? '', 'powershell');
    if (POWERSHELL_ENV_WRITERS.has(base)
      && powerShellEnvironmentNames(base, part.slice(i + 1)).some(isRedirectEnvName)) return true;
  }
  return false;
};
function hasDynamicAssignmentName(value) {
  const at = value.indexOf('=');
  return at > 0 && hasShellExpansion(value.slice(0, at), 'bash');
}
function hasDynamicEnvAssignment(args) {
  const takesValue = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (takesValue.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (arg.includes('=')) {
      if (hasDynamicAssignmentName(arg)) return true;
      continue;
    }
    if (hasShellExpansion(arg, 'bash')) {
      for (let j = i + 1; j < args.length; j++) {
        if (managerHasInstallReading(args.slice(j), 'bash')) return true;
      }
      return false;
    }
    return false;
  }
  return false;
}
function hasUnknownPowerShellEnvWrite(text, tokens = tokenize(text)) {
  for (const raw of rawSegments(text, 'powershell')) {
    const statement = raw.trim();
    if (/^\$\{env:[^}]*[$`]/i.test(statement)) return true;
    if (!/^(?:\$[A-Za-z_]\w*\s*=\s*)?\[(?:system\.)?environment\]::setenvironmentvariable\b/i.test(statement)) continue;
    const call = /\[(?:system\.)?environment\]::setenvironmentvariable\s*\(\s*([^,]+)/i.exec(statement);
    if (call && !/^(['"])[\w@:-]+\1$/.test(call[1].trim())) return true;
  }
  for (const part of segments(tokens)) {
    const i = commandPosition(part, 'powershell');
    const base = commandBase(part[i] ?? '', 'powershell');
    if (!POWERSHELL_ENV_WRITERS.has(base)) continue;
    const { paths, names } = powerShellWriteOperands(base, part.slice(i + 1));
    const isEnvironmentPath = (value) => /^(?:env:|env:[\\/]+|env[\\/]+|\$\{env:)/i.test(value ?? '');
    if (paths.some(isEnvironmentPath)
      && [...paths, ...names].some((value) => hasShellExpansion(value, 'powershell'))) return true;
  }
  return false;
}
function hasUnknownBashEnvWrite(text, tokens = tokenize(text, true)) {
  for (const part of segments(tokens)) {
    const words = part.map((token) => typeof token === 'string' ? token : token.value);
    const i = commandPosition(words, 'bash');
    const base = commandBase(words[i] ?? '', 'bash');
    const args = stripShellRedirects(part.slice(i + 1));
    if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(base)) {
      if (isBashDeclarationPrintOnly(base, args)
        || (!args.some((arg) => /^-[^-]*p/.test(arg))
          && ['declare', 'typeset', 'local'].includes(base)
          && args.some((arg) => ['-f', '-F'].includes(arg)))) continue;
      const names = [];
      for (let j = 0; j < args.length; j++) {
        const arg = args[j];
        if (arg === '--') {
          names.push(...args.slice(j + 1));
          break;
        }
        if (arg.startsWith('-') && arg !== '-') continue;
        names.push(arg);
      }
      if (names.some((name) => hasDynamicAssignmentName(name) || (!name.includes('=') && hasShellExpansion(name, 'bash')))) return true;
    }
    if (base === 'printf') {
      if (args[0] === '-v' && args[1] && hasShellExpansion(args[1], 'bash')) return true;
    }
    if (base === 'read') {
      const names = [];
      const takesValue = new Set(['-a', '-d', '-i', '-n', '-N', '-p', '-t', '-u']);
      for (let j = 0; j < args.length && !/^(?:\d*<|\d*>|&>)/.test(args[j]); j++) {
        if (args[j] === '--') {
          names.push(...args.slice(j + 1).filter((arg) => !/^(?:\d*<|\d*>|&>)/.test(arg)));
          break;
        }
        if (takesValue.has(args[j])) {
          if (args[j] === '-a' && args[j + 1]) names.push(args[j + 1]);
          j++;
        } else if (args[j].startsWith('-')) continue;
        else names.push(args[j]);
      }
      if (names.some((name) => hasShellExpansion(name, 'bash'))) return true;
    }
    let wrapper = 0;
    while (wrapper < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[wrapper]) || KEYWORDS.has(words[wrapper]))) wrapper++;
    while (wrapper < words.length && WRAPPERS.has(commandBase(words[wrapper], 'bash'))) {
      if (commandBase(words[wrapper], 'bash') === 'env'
        && hasDynamicEnvAssignment(words.slice(wrapper + 1))) return true;
      wrapper = wrappedCommandPosition(words, wrapper, 'bash');
    }
  }
  return false;
}
const INSTALL_INTENT = new RegExp(String.raw`\b(npm|pnpm|yarn|${Object.keys(MANAGER_BINARY_ALIASES).join('|')}|bun|npx|bunx|pnpx|pip[\d.]*|uv|uvx|pipx|corepack)\b[^;&|\n]*?\s(i|in|ins|inst|insta|install|isnt|it|install-test|add|a|update|up|upgrade|dlx|exec|x|create|init|inject|global|tool|dedupe|download|wheel|pack|diff|set|audit|cache|self-update)\b|--install-extension|(^|[\s;&|(])\$\{?\w+\}?\s+(i|install|add)(?=$|\s|[;&|)])`);
const POWERSHELL_INSTALL_INTENT = new RegExp(INSTALL_INTENT.source, 'i');
const OPAQUE = /\$\(|`|\bxargs\b|\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|(^|[\s;&|(])\$\{?\w+\}?\s/;
const BASH_REDIRECT_OPERATORS = ['&>>', '&>', '<<<', '<<', '<&', '<>', '<', '>>', '>|', '>&', '>'];

function tokenize(command, withSpans = false, shell = 'bash') {
  const tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  let tokenStart = 0;
  const push = (end = command.length, redirect = false) => {
    if (has) {
      const token = withSpans ? { value: cur, start: tokenStart, end, ...(redirect ? { redirect: true } : {}) } : cur;
      tokens.push(token);
    }
    cur = '';
    has = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const groupedExpansion = ch === '$' && command[i + 1] === '(' ? '$('
      : shell !== 'powershell' && (ch === '<' || ch === '>') && command[i + 1] === '(' ? `${ch}(`
      : shell === 'powershell' && ch === '@' && command[i + 1] === '(' ? '@('
        : shell !== 'powershell' && ch === '`' ? '`' : null;
    if (groupedExpansion) {
      if (!has) tokenStart = i;
      cur += groupedExpansion;
      has = true;
      if (groupedExpansion.length === 2) i++;
      let depth = groupedExpansion === '`' ? 0 : 1;
      let innerQuote = null;
      for (i++; i < command.length; i++) {
        const inner = command[i];
        cur += inner;
        if (groupedExpansion === '`' && inner === '`') break;
        if (groupedExpansion === '`') continue;
        if (innerQuote) {
          if (inner === innerQuote && command[i + 1] === innerQuote) cur += command[++i];
          else if (inner === innerQuote) innerQuote = null;
        } else if (inner === '"' || inner === "'") innerQuote = inner;
        else if (inner === '(') depth++;
        else if (inner === ')' && --depth === 0) break;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else if (shell !== 'powershell' && ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (!has) tokenStart = i;
      quote = ch;
      has = true;
    } else if (shell !== 'powershell' && ch === '\\' && command[i + 1] === '\n') {
      i++;
    } else if (shell !== 'powershell' && ch === '\\' && i + 1 < command.length) {
      if (!has) tokenStart = i;
      cur += command[++i];
      has = true;
    } else if (ch === ' ' || ch === '\t') {
      push(i);
    } else if (shell !== 'powershell' && (ch === '<' || ch === '>' || ch === '&' && command[i + 1] === '>')) {
      const rest = command.slice(i);
      const operator = BASH_REDIRECT_OPERATORS.find((candidate) => rest.startsWith(candidate));
      if (operator) {
        const ioNumber = (ch === '<' || ch === '>') && has && /^\d+$/.test(cur)
          && command.slice(tokenStart, i) === cur;
        if (!ioNumber) push(i);
        else cur += operator;
        if (!ioNumber) {
          tokenStart = i;
          cur = operator;
          has = true;
        }
        push(i + operator.length, true);
        i += operator.length - 1;
      } else {
        if (!has) tokenStart = i;
        cur += ch;
        has = true;
      }
    } else if (shell === 'powershell' && ch === '&' && command[i + 1] !== '&') {
      push(i);
      tokens.push(withSpans ? { value: POWERSHELL_CALL, start: i, end: i + 1 } : POWERSHELL_CALL);
    } else if ('&|;\n()'.includes(ch)) {
      push(i);
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||') {
        tokens.push(withSpans ? { value: two, start: i, end: i + 2 } : two);
        i++;
      } else tokens.push(withSpans ? { value: ch, start: i, end: i + 1 } : ch);
    } else {
      if (!has) tokenStart = i;
      cur += ch;
      has = true;
    }
  }
  push();
  return tokens;
}

function segments(tokens) {
  const out = [[]];
  for (const t of tokens) {
    if (SEPARATORS.has(typeof t === 'string' ? t : t.value)) out.push([]);
    else out.at(-1).push(t);
  }
  return out.filter((s) => s.length);
}

function stripShellRedirects(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const value = typeof token === 'string' ? token : token.value;
    if (typeof token === 'string' || !token.redirect) {
      out.push(token);
      continue;
    }
    const target = tokens[i + 1];
    const targetValue = typeof target === 'string' ? target : target?.value;
    if (target !== undefined && !SEPARATORS.has(targetValue)
      && !(typeof target !== 'string' && target.redirect)) i++;
  }
  return out.map((token) => typeof token === 'string' ? token : token.value);
}

// Data consumers keep heredoc bodies opaque; other bodies are checked below.
function splitHeredocs(command, shell = 'bash') {
  const scripts = [];
  const checkedBodies = [];
  const bodies = [];
  const heredocEntries = [];
  const bunScripts = [];
  const rest = command.replace(/(^|\n)([^\n]*?)<<-?\s*(['"]?)(\w+)\3[^\n]*\n([\s\S]*?)\n[ \t]*\4(?=\s|$)/g, (all, start, _header, _q, _tag, body) => {
    bodies.push(body);
    const headerEnd = all.indexOf('\n', start.length);
    const header = all.slice(start.length, headerEnd);
    const headerParts = [];
    const separators = [];
    let part = [];
    for (const token of tokenize(header, true, shell)) {
      if (SEPARATORS.has(token.value)) {
        if (part.length) {
          headerParts.push(part);
          separators.push(token.value);
          part = [];
        }
      } else part.push(token);
    }
    if (part.length) headerParts.push(part);
    const bodyPartIndex = headerParts.findIndex((part) => part.some((token) => token.value === '<<'));
    let pipelineEnd = bodyPartIndex;
    while (pipelineEnd >= 0 && pipelineEnd < separators.length
      && ['|', '|&'].includes(separators[pipelineEnd])) pipelineEnd++;
    const bodyParts = bodyPartIndex < 0 ? headerParts : headerParts.slice(bodyPartIndex, pipelineEnd + 1);
    heredocEntries.push({ body, parts: bodyParts, quoted: !!_q });
    const commandWords = bodyParts.map((part) => part.map((token) => token.value));
    const commands = commandWords.map((part) => commandBase(commandAfterWrappers(part, shell), shell)).filter(Boolean);
    const bunCommandIndex = commandWords.findIndex((part) => bunStdinInvocation(part, shell));
    const bunCommand = bunCommandIndex < 0 ? undefined : commandWords[bunCommandIndex];
    const stdinSource = bodyParts.some((part) => {
      const words = part.map((token) => token.value);
      const i = commandPosition(words, shell);
      return ['source', '.'].includes(commandBase(words[i] ?? '', shell))
        && ['/dev/stdin', '/proc/self/fd/0', '/dev/fd/0'].includes(words[i + 1]);
    });
    if (bunCommand) bunScripts.push({ argv: bunCommand, code: body, staticCode: !!_q || !hasShellExpansion(body, shell) });
    if (commands.some((cmd) => SHELLS.has(cmd)) || stdinSource) scripts.push(body);
    else if (!bunCommand && (!commands.length || !commands.every((cmd) => DATA_COMMANDS.has(cmd)))) checkedBodies.push(body);
    return start + header;
  });
  return { rest, scripts, checkedBodies, bodies, heredocEntries, bunScripts };
}

const WRAPPER_VALUE_OPTIONS = {
  sudo: ['-a', '--authentication-type', '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-T', '--command-timeout', '-r', '--role', '-t', '--type', '-D', '--chdir', '-R', '--chroot', '-U', '--other-user', '--preserve-env'],
  doas: ['-u', '-C', '-a', '-h'],
  time: ['-f', '--format', '-o', '--output'],
  command: [],
  exec: ['-a', '--argv0'],
  nice: ['-n', '--adjustment'],
  nohup: [],
  env: ['-a', '--argv0', '-u', '--unset', '-C', '--chdir', '-S', '--split-string', '--block-signal', '--default-signal', '--ignore-signal'],
  xargs: ['-E', '--eof', '-e', '-I', '--replace', '-i', '-L', '-l', '--max-lines', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '-d', '--delimiter', '-a', '--arg-file', '--process-slot-var'],
  parallel: [
    '-a', '--arg-file', '--arg-file-sep', '--arg-sep', '--basefile', '--bf', '--bin', '--block', '--block-timeout', '-C', '--colsep', '--combineexec', '--combine-executable', '--compress-program',
    '-d', '--delimiter', '--delay', '--dirnamereplace', '--dnr', '--env', '--eof', '-e', '-E', '--extensionreplace', '--er', '--filter', '--group-by', '--halt', '--header', '--joblog', '--jl', '-j', '--jobs', '--load',
    '-s', '--max-chars', '-L', '--max-lines', '-l', '-N', '--max-replace-args', '-n', '--max-args', '--max-procs', '-P', '--memfree', '--memsuspend', '--nice',
    '--limit', '--minversion', '--parens', '--profile', '-J', '--process-slot-var', '--recend', '--recstart', '--replace', '-I', '-i', '--restart', '--results', '--res', '--retries', '--return', '--rpl', '--rsync-opts', '--semaphore-name', '--id', '--semaphore-timeout', '--st', '--seqreplace', '--seqr', '--shard', '--shell', '--shell-completion',
    '--slotreplace', '--slotr', '--sql-master', '--sql-worker', '--sql-and-worker', '-S', '--ssh', '--sshlogin', '--sshloginfile', '--slf', '--sshdelay', '--ssh-delay',
    '--tagstring', '--ctagstring', '--template', '--tmpl', '--term-seq', '--timeout', '--tmpdir', '--total', '--total-jobs', '--transferfile', '--tf', '--trc', '--trim', '--workdir', '--wd',
    '--match', '--basenameextensionreplace', '--bner', '--basenamereplace', '--bnr',
  ],
  timeout: ['-k', '--kill-after', '-s', '--signal'],
  setsid: [],
  stdbuf: ['-i', '--input', '-o', '--output', '-e', '--error'],
  ionice: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-u', '--uid', '-P', '--pgid'],
  flock: ['-w', '--wait', '--timeout', '-E', '--conflict-exit-code', '--start', '--length', '-c', '--command'],
  chronic: ['-e', '--exit-code', '-t', '--timeout'],
  unbuffer: ['-t', '--timeout'],
  caffeinate: ['-t', '-w'],
  corepack: ['--install-directory', '--cache-directory'],
  taskset: ['-c', '--cpu-list'],
  chrt: ['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline', '-U', '--clamp-min', '-X', '--clamp-max'],
  numactl: ['-C', '--physcpubind', '--cpubind', '-N', '--cpunodebind', '--nodebind', '-m', '--membind', '-i', '--interleave', '-p', '--preferred', '-P', '--preferred-many', '-w', '--weighted-interleave', '--file', '--shm', '--shmmode', '--shmid', '--length', '--offset'],
  prlimit: ['-p', '--pid', '--core', '--data', '--fsize', '--locks', '--memlock', '--msgqueue', '--nice', '--nofile', '--nproc', '--rss', '--rtprio', '--rttime', '--sigpending', '--stack', '--cpu', '--as'],
  'systemd-run': ['-p', '--property', '-u', '--unit', '-M', '--machine', '-H', '--host', '-E', '--setenv', '--description', '--slice', '--uid', '--gid', '--working-directory', '--root-directory', '--service-type', '--scope-property', '--path-property', '--socket-property', '--timer-property', '--on-active', '--on-boot', '--on-startup', '--on-unit-active', '--on-unit-inactive', '--on-calendar', '--nice', '--output', '--json', '--expand-environment', '--capsule', '--job-mode', '--background'],
  runuser: ['-u', '--user', '-g', '--group', '-G', '--supp-group', '-s', '--shell', '-c', '--command', '--session-command', '-w', '--whitelist-environment'],
  su: ['-c', '--command', '--session-command', '-g', '--group', '-G', '--supp-group', '-s', '--shell', '-w', '--whitelist-environment'],
  watch: ['-n', '--interval', '-d', '--differences', '-q', '--equexit', '-s', '--shotsdir'],
};

const WRAPPER_OPTIONAL_VALUES = {
  sudo: ['--preserve-env'],
  env: ['--block-signal', '--default-signal', '--ignore-signal'],
  parallel: ['-e', '--eof', '-i', '--replace', '--max-lines', '-l'],
  xargs: ['-e', '-i', '-l'],
  prlimit: ['--core', '--data', '--fsize', '--locks', '--memlock', '--msgqueue', '--nice', '--nofile', '--nproc', '--rss', '--rtprio', '--rttime', '--sigpending', '--stack', '--cpu', '--as'],
  watch: ['-d', '--differences'],
};

const WRAPPER_FLAG_OPTIONS = {
  sudo: ['-A', '--askpass', '-B', '--bell', '-b', '--background', '-e', '--edit', '-E', '--preserve-env', '-H', '--set-home', '-i', '--login', '-K', '--remove-timestamp', '-k', '--reset-timestamp', '-l', '--list', '-N', '--no-update', '-n', '--non-interactive', '-P', '--preserve-groups', '-S', '--stdin', '-s', '--shell', '-V', '--version', '-v', '--validate', '--help'],
  doas: ['-L', '-n', '-s', '-v', '--help', '--version'],
  time: ['-p', '--portability', '-v', '--verbose', '--help', '--version'],
  command: ['-p', '--preserve-path', '-v', '--verbose', '-V', '--version', '--help'],
  exec: ['-c', '-l'],
  builtin: ['-p', '--help'],
  nice: ['--help', '--version'],
  nohup: ['--help', '--version'],
  env: ['-i', '--ignore-environment', '-0', '--null', '-v', '--debug', '--list-signal-handling', '--help', '--version'],
  xargs: ['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p', '--interactive', '-x', '--exit', '-o', '--open-tty', '--show-limits', '--help', '--version'],
  parallel: [
    '-m', '--xargs', '-X', '--link', '--pipe', '--pipe-part', '--fifo', '--cat', '--tee', '--null', '--no-run-if-empty', '--dry-run',
    '--verbose', '-t', '-v', '--plain', '--will-cite', '--cite', '--silent', '--group', '--ungroup', '-u', '--line-buffer', '--keep-order', '-k', '--embed',
    '--tag', '--ctag', '--color', '--color-failed', '--cf', '--progress', '--bar', '--eta', '--onall', '--nonall', '--resume', '--resume-failed',
    '--retry-failed', '--semaphore', '--bg', '--fg', '--wait', '--controlmaster', '-M', '--transfer', '--cleanup', '--trc', '--compress', '--no-keep-order', '--show-limits',
    '--noswap', '--filter-hosts', '--hostgroups', '--hgrp', '--record-env', '--session', '--shuf', '--csv', '--output-as-files', '--outputasfiles', '--files', '--files0', '--spreadstdin', '--gnu', '--help', '--version', '-V', '--restart-failed',
    '--number-of-cpus', '--number-of-cores', '--number-of-sockets', '--number-of-threads', '--use-cores-instead-of-threads', '--use-sockets-instead-of-threads', '--open-tty', '--tty', '--latest-line', '--no-run-if-empty', '-r', '--remove-rec-sep', '--removerecsep', '--rrs', '--regexp', '--interactive', '-p', '--quote', '-q', '--shell-quote', '--shebang', '--shebang-wrap', '--citation', '--bibtex', '--fast', '--round-robin', '--round', '--tmux', '--tmuxpane', '--unsafe', '-x', '--exit', '--max-line-length-allowed', '--plus', '--xapply',
  ],
  timeout: ['-f', '--foreground', '--preserve-status', '--verbose', '--help', '--version'],
  setsid: ['-c', '--ctty', '-f', '--fork', '-w', '--wait', '--help', '--version'],
  stdbuf: ['--help', '--version'],
  ionice: ['-t', '--ignore', '-h', '--help', '--version'],
  flock: ['-s', '--shared', '-x', '-e', '--exclusive', '-u', '--unlock', '-n', '--nb', '--nonblocking', '-o', '--close', '-F', '--no-fork', '--fcntl', '-v', '--verbose', '-h', '--help', '-V', '--version'],
  chronic: ['--help', '--version'],
  unbuffer: ['-p', '--no-pty', '--help', '--version'],
  caffeinate: ['-d', '-i', '-m', '-s', '-u', '-w', '--help', '--version'],
  corepack: ['--help', '--version'],
  taskset: ['-a', '--all-tasks', '-p', '--pid', '-h', '--help', '-V', '--version'],
  chrt: ['-f', '--fifo', '-r', '--rr', '-o', '--other', '-b', '--batch', '-i', '--idle', '-d', '--deadline', '-p', '--pid', '-a', '--all-tasks', '-R', '--reset-on-fork', '-m', '--max', '-e', '--ext', '-G', '--reclaim-grub', '-O', '--deadline-overrun', '-v', '--verbose', '-h', '--help', '-V', '--version'],
  numactl: ['--all', '-a', '--balancing', '-b', '--localalloc', '-l', '--show', '--hardware', '--cpu-compress', '--huge', '--strict', '--touch', '--dump', '--dump-nodes', '-h', '--help', '--version'],
  prlimit: ['--help', '--version'],
  'systemd-run': ['--scope', '--system', '--user', '--wait', '--pipe', '-P', '--pty', '-t', '--pty-late', '-T', '--remain-after-exit', '-r', '--send-sighup', '--no-block', '--collect', '-G', '--quiet', '-q', '--verbose', '-v', '--same-dir', '-d', '--same-root-dir', '-R', '--shell', '-S', '--slice-inherit', '--ignore-failure', '--on-clock-change', '--on-timezone-change', '--no-ask-password', '--no-pager', '--help', '-h', '--version'],
  runuser: ['-', '-l', '--login', '-f', '--fast', '-m', '-p', '--preserve-environment', '-P', '--pty', '-T', '--no-pty', '-V', '--help', '--version'],
  su: ['-', '-l', '--login', '-f', '--fast', '-m', '-p', '--preserve-environment', '-P', '--pty', '-T', '--no-pty', '-V', '--help', '--version'],
  watch: ['-b', '--beep', '-c', '--color', '-C', '--no-color', '-e', '--errexit', '-f', '--follow', '-g', '--chgexit', '-p', '--precise', '-r', '--no-rerun', '-t', '--no-title', '-w', '--no-wrap', '-x', '--exec', '-h', '--help', '-v', '--version'],
};

function wrapperValueOption(arg, options) {
  return options.find((name) => arg === name || arg.startsWith(`${name}=`)
    || (name.length === 2 && arg.startsWith(name) && arg.length > name.length));
}

function wrapperValueConsumesNext(wrapper, arg, option) {
  return arg === option && !WRAPPER_OPTIONAL_VALUES[wrapper]?.includes(option);
}

function knownWrapperOption(wrapper, arg) {
  const values = WRAPPER_VALUE_OPTIONS[wrapper] ?? [];
  if (wrapperValueOption(arg, values)) return true;
  const flags = WRAPPER_FLAG_OPTIONS[wrapper] ?? [];
  if (flags.includes(arg)) return true;
  if (arg.startsWith('--') || !arg.startsWith('-') || arg.length < 2) return false;
  const shortValues = new Set(values.filter((option) => option.length === 2));
  const shortFlags = new Set(flags.filter((option) => option.length === 2));
  const letters = arg.slice(1);
  for (let index = 0; index < letters.length; index++) {
    const option = `-${letters[index]}`;
    if (shortValues.has(option)) return index === letters.length - 1 || index < letters.length - 1;
    if (!shortFlags.has(option)) return false;
  }
  return letters.length > 0;
}

function hasUnknownWrapperOption(argv, wrapperIndex, commandIndex, shell = 'bash') {
  const wrapper = commandBase(argv[wrapperIndex] ?? '', shell);
  for (let j = wrapperIndex + 1; j < commandIndex; j++) {
    const arg = argv[j];
    if (arg === '--') break;
    if (wrapper === 'env' && !arg.startsWith('-') && arg.includes('=')) continue;
    const option = wrapperValueOption(arg, WRAPPER_VALUE_OPTIONS[wrapper] ?? []);
    if (arg.startsWith('-') && !knownWrapperOption(wrapper, arg)) return true;
    if (option && wrapperValueConsumesNext(wrapper, arg, option)) j++;
  }
  return false;
}

function hasLaterShellOrManager(argv, start, shell, wrapper) {
  for (const arg of argv.slice(start)) {
    if (wrapper === 'parallel' && /^:{3,4}\+?$/.test(arg)) break;
    const base = commandBase(arg, shell);
    if (SHELLS.has(base) || powerShellExecutable(arg, shell) || isKnown(arg, shell) || UNREVIEWED_MANAGERS.has(base) || base === 'corepack') return true;
  }
  return false;
}

function unknownWrapperOption(argv, shell) {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) || KEYWORDS.has(arg)) {
      i++;
      continue;
    }
    const wrapper = commandBase(arg, shell);
    if (!WRAPPERS.has(wrapper)) return undefined;
    const commandIndex = wrappedCommandPosition(argv, i, shell);
    if (hasUnknownWrapperOption(argv, i, commandIndex, shell) && hasLaterShellOrManager(argv, i + 1, shell, wrapper)) return wrapper;
    i = commandIndex;
  }
  return undefined;
}

function wrappedCommandPosition(argv, i, shell = 'bash') {
  const wrapper = commandBase(argv[i] ?? '', shell);
  const options = WRAPPER_VALUE_OPTIONS[wrapper] ?? [];
  let j = i + 1;
  if (wrapper === 'taskset') {
    let mask = false;
    while (j < argv.length) {
      const arg = argv[j];
      if (arg === '--') return j + 1;
      const option = wrapperValueOption(arg, ['-c', '--cpu-list']);
      if (option) {
        j += wrapperValueConsumesNext(wrapper, arg, option) ? 2 : 1;
        mask = true;
        continue;
      }
      if (arg.startsWith('-')) {
        j++;
        continue;
      }
      if (!mask) {
        mask = true;
        j++;
        continue;
      }
      return j;
    }
    return j;
  }
  if (wrapper === 'chrt') {
    let priority = false;
    while (j < argv.length) {
      const arg = argv[j];
      if (arg === '--') return j + 1;
      if (arg.startsWith('-')) {
        const option = wrapperValueOption(arg, options);
        j += option && wrapperValueConsumesNext(wrapper, arg, option) ? 2 : 1;
        continue;
      }
      if (!priority) {
        priority = true;
        j++;
        continue;
      }
      return j;
    }
    return j;
  }
  while (j < argv.length) {
    const arg = argv[j];
    if (arg === '--') return j + 1;
    if (wrapper === 'env' && !arg.startsWith('-') && arg.includes('=')) {
      j++;
      continue;
    }
    if (arg.startsWith('-')) {
      const option = wrapperValueOption(arg, options);
      if (option && wrapperValueConsumesNext(wrapper, arg, option)) j += 2;
      else j++;
      continue;
    }
    if (wrapper === 'timeout' || wrapper === 'flock') j++;
    return j;
  }
  return j;
}

function commandPosition(argv, shell = 'bash') {
  let i = 0;
  while (i < argv.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]) || KEYWORDS.has(argv[i])) i++;
    else if (WRAPPERS.has(commandBase(argv[i], shell))) i = wrappedCommandPosition(argv, i, shell);
    else break;
  }
  return i;
}

function stdinScriptInvocation(argv, wrapperIndex, shell = 'bash') {
  const wrapper = commandBase(argv[wrapperIndex] ?? '', shell);
  if (!['xargs', 'parallel'].includes(wrapper)) return false;
  let child = wrappedCommandPosition(argv, wrapperIndex, shell);
  if (wrapper === 'parallel' && child >= argv.length) return true;
  const replacements = [];
  for (let i = wrapperIndex + 1; i < child; i++) {
    const arg = argv[i];
    if (arg === '-I' || arg === '-i' || arg === '--replace') {
      if (argv[i + 1] !== undefined && i + 1 < child) replacements.push(argv[++i]);
      else replacements.push('{}');
    } else if (/^-I.+/.test(arg)) replacements.push(arg.slice(2));
    else if (/^-i.+/.test(arg)) replacements.push(arg.slice(2));
    else if (arg.startsWith('--replace=')) replacements.push(arg.slice('--replace='.length));
  }
  const originalChild = argv[child] ?? '';
  if (replacements.includes(originalChild) || (wrapper === 'parallel' && /^\{[^{}]*\}$/.test(originalChild))) return true;
  while (child < argv.length && WRAPPERS.has(commandBase(argv[child], shell))) child = wrappedCommandPosition(argv, child, shell);
  const command = commandBase(argv[child] ?? '', shell);
  if (SHELLS.has(command) || command === 'fish') {
    const args = argv.slice(child + 1);
    const c = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
    const code = c < 0 ? undefined : args[c + 1];
    if (code === undefined) return true;
    return wrapper === 'parallel'
      ? /\{[^{}]*\}/.test(code)
      : replacements.some((replace) => code.includes(replace));
  }
  if (powerShellExecutable(command, shell)) {
    const args = argv.slice(child + 1);
    const option = args.findIndex(powerShellCommandOption);
    const code = option < 0 ? undefined : args[option + 1];
    if (code === undefined || code === '-') return true;
    return wrapper === 'parallel'
      ? /\{[^{}]*\}/.test(code)
      : replacements.some((replace) => code.includes(replace));
  }
  return false;
}

function commandAfterWrappers(argv, shell = 'bash') {
  return argv[commandPosition(argv, shell)] ?? '';
}

function supportedManagerInvocations(argv, shell = 'bash') {
  const i = commandPosition(argv, shell);
  const base = commandBase(argv[i] ?? '', shell);
  const managers = new Set();
  if (NPM_FAMILY.includes(base) || ['npx', 'bunx', 'pnpx', 'uv', 'uvx', 'pipx', 'pipenv', 'corepack'].includes(base) || /^pip(3(\.\d+)?)?$/.test(base)) {
    managers.add(/^pip(3(\.\d+)?)?$/.test(base) ? 'pip' : base);
  }
  if (/^python(3(\.\d+)?)?$/.test(base)) {
    const module = argv.indexOf('-m', i + 1);
    if (module !== -1 && /^pip(3(\.\d+)?)?$/.test(commandBase(argv[module + 1] ?? '', shell))) managers.add('pip');
  }
  if (argv.slice(0, i).some((arg) => commandBase(arg, shell) === 'corepack')) managers.add('corepack');
  return managers;
}

function substitutions(command, shell) {
  const out = [];
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (shell === 'powershell') {
      if (quote === "'") {
        if (ch === "'" && command[i + 1] === "'") i++;
        else if (ch === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (ch === '`') i++;
        else if (ch === '"') quote = null;
      } else if (ch === '`') i++;
      else if (ch === "'") quote = "'";
      else if (ch === '"') quote = '"';
    } else {
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (ch === '\\') i++;
        else if (ch === '"') quote = null;
      } else if (ch === '\\') i++;
      else if (ch === "'") quote = "'";
      else if (ch === '"') quote = '"';
    }

    if (command.startsWith('$(', i)) {
      const end = commandSubstitutionEnd(command, i);
      if (end >= 0) {
        out.push(command.slice(i + 2, end));
        i = end;
      }
    } else if (shell !== 'powershell' && (quote !== "'" && ch === '`')) {
      let end = i + 1;
      for (; end < command.length; end++) {
        if (command[end] === '\\') end++;
        else if (command[end] === '`') break;
      }
      if (end < command.length) {
        out.push(command.slice(i + 1, end));
        i = end;
      }
    } else if (shell !== 'powershell' && !quote && (ch === '<' || ch === '>') && command[i + 1] === '(') {
      const end = commandSubstitutionEnd(command, i);
      if (end >= 0) {
        out.push(command.slice(i + 2, end));
        i = end;
      }
    }
  }
  return out;
}

const powerShellExecutable = (name, shell = 'bash') => ['pwsh', 'powershell'].includes(commandBase(name, shell));
const powerShellCommandOption = (arg) => arg.toLowerCase() === '-c'
  || (arg.length > 2 && '-command'.startsWith(arg.toLowerCase()));
const powerShellEncodedOption = (arg) => {
  const value = arg.toLowerCase();
  return value.length > 1 && ['-encodedcommand', '-encodedarguments'].some((name) => name.startsWith(value))
    || ['-ec', '-ea'].includes(value);
};

function powerShellOptionValue(arg) {
  const value = arg.toLowerCase();
  return ['-command', '-file', '-encodedcommand', '-encodedarguments', '-executionpolicy', '-inputformat',
    '-outputformat', '-windowstyle', '-configurationname', '-version', '-workingdirectory', '-settingsfile', '-configurationfile']
    .some((option) => option.startsWith(value)) || ['-c', '-f', '-ec', '-ea', '-ex', '-ep', '-if', '-of', '-w', '-wd'].includes(value);
}

function stdinShell(argv, shell = 'bash') {
  const i = commandPosition(argv, shell);
  const executable = commandBase(argv[i] ?? '', shell);
  const args = argv.slice(i + 1);
  if (['source', '.'].includes(executable)
    && ['/dev/stdin', '/proc/self/fd/0', '/dev/fd/0'].includes(args[0])
    && args.some((arg) => arg === '<<<' || arg === '<<' || arg === '<')) return shell;
  if (SHELLS.has(executable)) {
    let positional = false;
    for (let j = 0; j < args.length; j++) {
      const arg = args[j];
      if (['<<<', '<<', '<', '<&'].includes(arg)) {
        if (args[j + 1] !== undefined) j++;
        continue;
      }
      if (arg === '-s' || arg === '-') return executable;
      if (/^-[a-z]*c[a-z]*$/i.test(arg)) return undefined;
      if (['--rcfile', '--init-file', '-o', '-O'].includes(arg)) {
        positional = true;
        continue;
      }
      if (positional) {
        positional = false;
        continue;
      }
      if (arg.startsWith('-')) continue;
      return undefined;
    }
    return executable;
  }
  if (!powerShellExecutable(executable ?? '', shell)) return undefined;
  for (let j = 0; j < args.length; j++) {
    const arg = args[j];
    if (powerShellCommandOption(arg)) return args[j + 1] === '-' ? 'powershell' : undefined;
    if (powerShellEncodedOption(arg)) return undefined;
    if (/^-file$/i.test(arg) || /^-f$/i.test(arg)) return args[j + 1] === '-' ? 'powershell' : undefined;
    if (arg === '-') return 'powershell';
    if (!arg.startsWith('-')) return undefined;
    if (powerShellOptionValue(arg)) j++;
  }
  return 'powershell';
}

function literalProducer(argv, shell = 'bash') {
  const i = commandPosition(argv, shell);
  const base = commandBase(argv[i] ?? '', shell);
  const args = argv.slice(i + 1);
  if (base === 'echo') return args.join(' ');
  if (base === 'printf' && args.length) {
    let valueIndex = 1;
    const format = args[0];
    if (/%(?!%|s\b)|\\(?:[^abfnrtv\\]|$)/.test(format)) return undefined;
    return format.replace(/%%|%s|\\[abfnrtv\\]/g, (match) => {
      if (match === '%s') return args[valueIndex++] ?? '';
      if (match === '%%') return '%';
      return ({ '\\a': '\x07', '\\b': '\b', '\\f': '\f', '\\n': '\n', '\\r': '\r', '\\t': '\t', '\\v': '\x0b', '\\\\': '\\' })[match];
    });
  }
  return undefined;
}

function hasShellExpansion(text, shell) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (shell === 'powershell') {
      if (quote === "'") {
        if (ch === "'" && text[i + 1] === "'") i++;
        else if (ch === "'") quote = null;
        continue;
      }
      if (ch === '`') {
        i++;
        continue;
      }
      if (quote === '"' && ch === '"') {
        quote = null;
        continue;
      }
      if (!quote && (ch === "'" || ch === '"')) {
        quote = ch;
        continue;
      }
      if ((ch === '$' && (text[i + 1] === '(' || /^(?:\$\{[^}]+\}|\$[A-Za-z_][\w:]*)/.test(text.slice(i))))
        || (ch === '@' && text[i + 1] === '(')) return true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      continue;
    }
    if (!quote && (ch === "'" || ch === '"')) {
      quote = ch;
      continue;
    }
    if (ch === '`' || (ch === '$' && (text[i + 1] === '(' || text[i + 1] === '{' || /[A-Za-z0-9_@*#?$!-]/.test(text[i + 1] ?? '')))) return true;
  }
  return false;
}

function inspectPipedShells(spans, result, state, source, shell) {
  const tokens = spans.map((token) => token.value);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== '|') continue;
    let start = i - 1;
    while (start >= 0 && !['|', '&&', '||', ';', '&', '\n', '(', ')'].includes(tokens[start])) start--;
    let end = i + 1;
    while (end < tokens.length && !['|', '&&', '||', ';', '&', '\n', '(', ')'].includes(tokens[end])) end++;
    const producer = tokens.slice(start + 1, i);
    const target = tokens.slice(i + 1, end);
    if (bunStdinInvocation(target, shell)) {
      const script = literalProducer(producer, shell);
      const rawProducer = source.slice(spans[start + 1]?.start ?? 0, spans[i - 1]?.end ?? 0);
      classifyBunCode(script, target, script !== undefined && !hasShellExpansion(rawProducer, shell), result, state,
        tokens.slice(start + 1, end).join(' '));
      markBunStdinHandled(state, target);
      continue;
    }
    const mode = stdinShell(target, shell);
    if (!mode) continue;
    const script = literalProducer(producer, shell);
    const rawProducer = source.slice(spans[start + 1]?.start ?? 0, spans[i - 1]?.end ?? 0);
    if (script === undefined || hasShellExpansion(rawProducer, shell)) result.unreviewable.push({
      manager: 'shell', raw: tokens.slice(start + 1, end).join(' '), reason: 'script piped into a shell',
    });
    else walk(script, result, state, mode);
  }
}

function inspectHereStringShells(spans, result, state, source, shell) {
  let part = [];
  const inspect = () => {
    if (!part.length) return;
    const argv = part.map((token) => token.value);
    const mode = stdinShell(argv, shell);
    const redirect = part.findIndex((token) => token.redirect && ['<<<', '<<', '<'].includes(token.value));
    const script = part[redirect + 1];
    if (mode && redirect >= 0 && ['<<<', '<<'].includes(part[redirect].value)) {
      if (!script || hasShellExpansion(source.slice(script.start, script.end), shell)) {
        result.unreviewable.push({
          manager: 'shell', raw: source.slice(part[0].start, part.at(-1).end), reason: 'script piped into a shell',
        });
      } else walk(script.value, result, state, mode);
    } else if (mode && redirect >= 0 && part[redirect].value === '<') {
      result.unreviewable.push({
        manager: 'shell', raw: source.slice(part[0].start, part.at(-1).end), reason: 'script piped into a shell',
      });
    }
    part = [];
  };
  for (const token of spans) {
    if (SEPARATORS.has(token.value)) inspect();
    else part.push(token);
  }
  inspect();
}

function positionals(args, values) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return out.concat(args.slice(i + 1));
    if (a.startsWith('-')) {
      if (!a.includes('=') && values.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function flagValues(args, ...names) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n && args[i + 1] !== undefined) out.push(args[i + 1]);
      else if (args[i].startsWith(`${n}=`)) out.push(args[i].slice(n.length + 1));
    }
  }
  return out;
}

function distinctValues(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== ''))];
}

function askForConflictingValues(values, option, manager, raw, result) {
  if (!hasConflictingValues(values.filter((value) => value !== undefined))) return;
  result.unreviewable.push({ manager, raw, reason: `repeated ${option} options select different packages` });
}

function flagValuesWithPrefixes(args, name, manager) {
  const values = new Set(valuesForManager(manager));
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const equalAt = arg.indexOf('=');
    const option = equalAt < 0 ? arg : arg.slice(0, equalAt);
    const matches = option === name || option.startsWith('--') && option.length >= 5
      && [...values].filter((candidate) => candidate.startsWith(option)).length === 1
      && values.has(name) && name.startsWith(option);
    if (!matches) continue;
    if (equalAt >= 0) out.push(arg.slice(equalAt + 1));
    else if (args[i + 1] !== undefined) out.push(args[++i]);
  }
  return out;
}

function pipFileOptions(values) {
  const args = values.flatMap((value) => tokenize(value));
  const has = (...names) => args.some((arg) => typeof arg === 'string' && names.some((name) => arg === name || arg.startsWith(`${name}=`)
    || (name.length === 2 && arg.startsWith(name) && arg.length > name.length)));
  return {
    requirements: has('-r', '--requirement', '--requirements', '--requirements-from-script', '--group', '--with-requirements'),
    constraints: has('-c', '--constraint', '--constraints', '-b', '--build-constraint', '--build-constraints'),
    overrides: has('--override', '--overrides'),
    editable: has('-e', '--editable', '--with-editable'),
  };
}

function configPathOptionForManager(arg, manager) {
  manager = canonicalManagerName(manager);
  if (/^--config(?:=|$)/.test(arg)) return manager === 'bun';
  if (/^--config-file(?:=|$)/.test(arg)) return ['pip', 'uv'].includes(manager);
  if (/^--pipfile(?:=|$)/.test(arg)) return manager === 'pipenv';
  if (/^--config-dir(?:=|$)|^--config\.(?:configDir|npmrcAuthFile)(?:=|$)/.test(arg)) return manager === 'pnpm';
  if (/^--use-yarnrc(?:=|$)/.test(arg)) return manager === 'yarn';
  if (/^--(?:userconfig|globalconfig)(?:=|$)/.test(arg)) return ['npm', 'pnpm'].includes(manager);
  return true;
}

function shortRedirectOption(args, manager) {
  const parser = SHORT_REDIRECT_OPTIONS[canonicalManagerName(manager)];
  if (!parser) return undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (!arg.startsWith('-') || arg.startsWith('--') || arg.length < 2) continue;
    const body = arg.slice(1);
    for (let j = 0; j < body.length; j++) {
      const kind = parser.values[body[j]];
      if (kind) {
        const attached = body.slice(j + 1);
        if (attached) {
          if (attached.startsWith('=') && parser.forms.has('equals')) return kind;
          if (!attached.startsWith('=') && parser.forms.has('attached')) return kind;
          break;
        }
        if (parser.forms.has('normalized') || parser.forms.has('separate') && args[i + 1] !== undefined) return kind;
        break;
      }
      if (!parser.forms.has('clustered') || !parser.flags.has(body[j])) break;
    }
  }
  return undefined;
}

function longRedirectOption(arg, manager) {
  const exact = REDIRECT_FLAGS.exec(arg);
  manager = canonicalManagerName(manager);
  if (exact && arg.split('=', 1)[0] !== '--reg') return { option: arg.split('=', 1)[0], match: exact };
  if (arg.split('=', 1)[0] === '--reg' && !ABBREVIATED_LONG_OPTION_MANAGERS.has(manager)) return undefined;
  if (!ABBREVIATED_LONG_OPTION_MANAGERS.has(manager) || !arg.startsWith('--')) return undefined;
  const option = arg.split('=', 1)[0];
  if (option.length < 5) return undefined;
  const documented = (DOCUMENTED_LONG_OPTION_PREFIXES[manager] ?? []).filter((candidate) => candidate.startsWith(option));
  if (documented.length === 1) {
    const match = REDIRECT_FLAGS.exec(documented[0]);
    return match ? { option: documented[0], match } : undefined;
  }
  const matches = (LONG_REDIRECT_OPTIONS[manager] ?? []).filter((candidate) => candidate.startsWith(option));
  if (matches.length !== 1) return undefined;
  const match = REDIRECT_FLAGS.exec(matches[0]);
  return match ? { option: matches[0], match } : undefined;
}

function hasInstallerRedirect(args, manager, installAction = true, pythonTool, shortOptionManager = manager) {
  const selectedRedirect = args.some((arg) => {
    const redirect = longRedirectOption(arg, shortOptionManager);
    const match = redirect?.match;
    if (!match || /^--env-file(?:=|$)/.test(arg)) return false;
    return !match.groups.configFile || installAction && configPathOptionForManager(redirect.option, manager);
  });
  if (selectedRedirect) return true;
  const shortRedirect = shortRedirectOption(args, shortOptionManager);
  if (shortRedirect === 'source' || shortRedirect === 'configFile' && installAction
    && configPathOptionForManager('--config', shortOptionManager)) return true;
  pythonTool = canonicalManagerName(pythonTool);
  if (!PYTHON_INDEX_TOOLS.has(pythonTool)) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!/^(?:--config-settings(?:-package)?|--config-setting|-C)(?:=|$)/.test(arg)) continue;
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[i + 1] ?? '';
    if (/(?:^|[:,])(?:index-url|extra-index-url|index|default-index|find-links|no-index)\s*[:=]/i.test(value)) return true;
  }
  return false;
}

function reviewPipFileOptions(options, result, manager, raw, targetStart) {
  if (options.requirements || options.constraints || options.overrides || options.editable) bulkUpgrade(result, manager, raw);
  if (!options.constraints && !options.overrides) return;
  const targets = result.targets.splice(targetStart);
  const reason = options.overrides
    ? 'overrides may select a version other than the one reviewed'
    : 'constraints may pin a version other than the one reviewed';
  if (!targets.length) result.unreviewable.push({ manager, raw, reason });
  else targets.forEach((target) => result.unreviewable.push({ manager: target.manager, raw, reason }));
}

function reviewPipInstallerOptions(values, result, manager, raw, targetStart) {
  reviewPipFileOptions(pipFileOptions(values), result, manager, raw, targetStart);
  const args = values.flatMap((value) => tokenize(value));
  if (!hasInstallerRedirect(args, manager, true, 'pip', 'pip')) return;
  const targets = result.targets.splice(targetStart);
  const reason = 'command uses a custom registry or index';
  if (!targets.length) result.unreviewable.push({ manager, raw, reason });
  else targets.forEach((target) => result.unreviewable.push({ manager: target.manager, raw, reason }));
}

function splitStringCommand(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-S' || args[i] === '--split-string') && args[i + 1] !== undefined) {
      return { value: args[i + 1], trailing: args.slice(i + 2) };
    }
    if (args[i].startsWith('-S') && args[i].length > 2) return { value: args[i].slice(2), trailing: args.slice(i + 1) };
    if (args[i].startsWith('--split-string=')) return { value: args[i].slice('--split-string='.length), trailing: args.slice(i + 1) };
  }
  return undefined;
}

function runnerReadings(args, values, flags = new Set(), valueCounts = new Map()) {
  const readings = [];
  let overflow = false;
  const add = (command, options, ambiguous) => {
    if (readings.some((reading) => JSON.stringify([reading.command, reading.options]) === JSON.stringify([command, options]))) return;
    if (readings.length >= 128) {
      overflow = true;
      return;
    }
    readings.push({ command, options, ambiguous });
  };
  const visit = (index, options = [], ambiguous = false) => {
    if (index >= args.length) {
      add([], options, ambiguous);
      return;
    }
    const arg = args[index];
    if (arg === '--') {
      add(args.slice(index + 1), options, ambiguous);
      return;
    }
    if (!arg.startsWith('-')) {
      add(args.slice(index), options, ambiguous);
      return;
    }
    const equalAt = arg.indexOf('=');
    const option = equalAt < 0 ? arg : arg.slice(0, equalAt);
    if (values.has(option)) {
      const value = equalAt < 0 ? args[index + 1] : arg.slice(equalAt + 1);
      visit(index + (equalAt < 0 ? 1 + (valueCounts.get(option) ?? 1) : 1), [...options, { option, value }], ambiguous);
      return;
    }
    const short = equalAt < 0 && [...values].find((name) => name.length === 2 && name[0] === '-' && name[1] !== '-' && arg.startsWith(name) && arg.length > name.length);
    if (short) {
      visit(index + 1, [...options, { option: short, value: arg.slice(short.length) }], ambiguous);
      return;
    }
    if (equalAt >= 0 || flags.has(arg)) {
      visit(index + 1, flags.has(arg) ? [...options, { option: arg, value: undefined }] : options, ambiguous);
      return;
    }
    visit(index + 1, options, true);
    if (index + 1 < args.length) visit(index + 2, options, true);
  };
  visit(0);
  return { readings, overflow };
}

function mergeFindings(result, addition) {
  for (const key of ['targets', 'bulk', 'unreviewable']) {
    for (const item of addition[key]) {
      if (!result[key].some((existing) => JSON.stringify(existing) === JSON.stringify(item))) result[key].push(item);
    }
  }
}

function classifyCommandReadings(parsed, result, raw, state, manager, transform = (command) => command) {
  for (const reading of parsed.readings) {
    const command = transform(reading.command);
    if (!command?.length) continue;
    const addition = { targets: [], bulk: [], unreviewable: [] };
    classifyChecked(command, addition, command.join(' '), state);
    mergeFindings(result, addition);
  }
  if (parsed.overflow) result.unreviewable.push({ manager, raw, reason: 'looks like an install the guard cannot parse' });
}

const afterWord = (args, values, word) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (!args[i].includes('=') && values.has(args[i])) i++;
    } else if (args[i] === word) return args.slice(i + 1);
  }
  return [];
};

const isLocalPath = (s) => /^(\.{1,2}(\/|$)|\/|~\/|file:|link:|workspace:)/.test(s) || (/\.(tgz|tar\.gz|whl|zip)$/.test(s) && !s.includes('://'));
const NON_REGISTRY = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|npm:)/;

function npmSpec(raw, manager, result) {
  if (isLocalPath(raw)) return;
  const at = raw.indexOf('@', 1);
  const name = at === -1 ? raw : raw.slice(0, at);
  const spec = at === -1 ? null : raw.slice(at + 1) || null;
  if (spec && isLocalPath(spec)) return;
  if (NON_REGISTRY.test(raw) || /^[^@][^@]*\/[^@]/.test(raw) || (spec && (NON_REGISTRY.test(spec) || spec.includes('/')))) {
    result.unreviewable.push({ manager, raw, reason: 'non-registry source (git, URL, alias)' });
    return;
  }
  result.targets.push({ ecosystem: 'npm', name, spec, manager });
}

function initializer(raw, manager, result) {
  if (!raw.startsWith('@') && raw.includes('/')) return result.unreviewable.push({ manager, raw, reason: 'initializer from a git repository' });
  const at = raw.indexOf('@', 1);
  const [name, spec] = at === -1 ? [raw, ''] : [raw.slice(0, at), raw.slice(at)];
  const pkg = name.startsWith('@') ? (name.includes('/') ? name.replace('/', '/create-') : `${name}/create`) : `create-${name}`;
  npmSpec(pkg + spec, manager, result);
}

function pypiSpec(raw, manager, result) {
  if (isLocalPath(raw)) return;
  if (/^(git\+|hg\+|svn\+|bzr\+|https?:)/.test(raw) || raw.includes(' @ ')) {
    result.unreviewable.push({ manager, raw, reason: 'non-registry source (VCS or URL)' });
    return;
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(raw);
  if (!m) return;
  const req = m[3].trim();
  const exact = /^===?\s*([^,;\s*]+)$/.exec(req);
  if (req && !exact && !/^>=?\s*[^,;<]+$/.test(req)) {
    result.unreviewable.push({ manager, raw, reason: 'version range resolves to a version other than the latest' });
    return;
  }
  result.targets.push({ ecosystem: 'PyPI', name: m[1].toLowerCase(), spec: exact ? exact[1] : null, manager });
}

function vsxSpec(raw, manager, result) {
  if (raw.endsWith('.vsix')) {
    result.targets.push({ ecosystem: 'vsx', name: raw, spec: null, manager, local: true });
    return;
  }
  const [name, spec] = raw.split('@');
  result.targets.push({ ecosystem: 'vsx', name: name.toLowerCase(), spec: spec || null, manager });
}

const bulkUpgrade = (result, manager, raw) => result.bulk.push({ manager, raw, reason: 'resolves packages without one named target to review' });

function booleanOptionValues(args, name, aliases = []) {
  const names = [name, ...aliases];
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const option of names) {
      if (arg === `--no-${option}`) values.push(false);
      else if (arg.startsWith(`--no-${option}=`)) values.push(/^(?:false|0|no|off)$/i.test(arg.slice(option.length + 6)));
      if (arg === `--${option}`) {
        const value = args[i + 1];
        values.push(value === undefined || value.startsWith('-') ? true : !/^(?:false|0|no|off)$/i.test(value));
      }
      if (arg.startsWith(`--${option}=`)) values.push(!/^(?:false|0|no|off)$/i.test(arg.slice(option.length + 3)));
    }
  }
  return values;
}

function booleanEnvironmentValue(value) {
  return !/^(?:false|0|no|off|)$/i.test(String(value ?? '').trim());
}

function environmentValue(state, name) {
  return state.environmentVariables?.get(name) ?? state.argumentVariables?.get(name) ?? state.argumentEnv?.get(name);
}

function environmentValues(state, name) {
  const values = state.environmentOccurrences?.get(name);
  if (values?.length) return values;
  const value = environmentValue(state, name);
  return value === undefined ? [] : [value];
}

function booleanEnvironmentValues(state, ...names) {
  return names.flatMap((name) => environmentValues(state, name)
    .map(booleanEnvironmentValue));
}

function hasConflictingValues(values) {
  return values.length > 1 && values.some((value) => value !== values.at(-1));
}

function recordEnvironmentOccurrence(state, name, value, scope = 'other', exported = false) {
  state.environmentOccurrences ??= new Map();
  const values = state.environmentOccurrences.get(name) ?? [];
  values.push(value);
  state.environmentOccurrences.set(name, values);
  if (isTrustLockfileEnvironmentName(name)) {
    state.trustLockfileAssignments ??= [];
    state.trustLockfileAssignments.push({
      name, value, scope, exported, segmentId: state.currentEnvironmentSegmentId,
    });
  }
}

const TRUST_LOCKFILE_OUTPUT_EXT = /\.(?:md|txt|log|html|json)$/i;
const TRUST_LOCKFILE_COMMAND_WRAPPERS = new Set(['env', 'nice', 'ionice', 'taskset', 'timeout', 'chrt', 'stdbuf']);
const TRUST_LOCKFILE_PNPM_SCRIPT_BLOCKLIST = new Set([
  'i', 'install', 'install-test', 'add', 'a', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un',
  'dlx', 'x', 'import', 'fetch', 'patch', 'patch-commit', 'patch-remove', 'patch-add', 'patch-apply',
  'access', 'adduser', 'audit', 'bin', 'cache', 'completion', 'config', 'create', 'dedupe', 'deploy',
  'doctor', 'env', 'find-up', 'help', 'init', 'link', 'list', 'login', 'logout', 'node', 'outdated',
  'pack', 'pkg', 'prune', 'publish', 'rebuild', 'root', 'server', 'setup', 'start', 'store', 'view',
  'why', 'workspace',
]);

function trustLockfilePnpmScriptNameAllowed(name) {
  const normalized = String(name ?? '').toLowerCase();
  return !!normalized && !TRUST_LOCKFILE_PNPM_SCRIPT_BLOCKLIST.has(normalized)
    && !normalized.startsWith('patch');
}

function trustLockfileWrapperArgumentsAllowed(wrapper, args) {
  const numeric = (value) => /^\d+$/.test(value ?? '');
  if (wrapper === 'env') {
    if (args[0] === '--') return args.length === 1;
    return args.length > 0 && args.every((arg) => {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(arg);
      return !!match && trustLockfileAssignmentsAllowed([[match[1], match[2]]]);
    });
  }
  if (wrapper === 'nice') {
    if (args.length === 2 && args[0] === '-n') return /^-?\d+$/.test(args[1]);
    if (args.length === 1 && /^-n-?\d+$/.test(args[0])) return true;
    return args.length === 1 && /^-\d+$/.test(args[0]);
  }
  if (wrapper === 'timeout') return args.length === 1 && /^\d+(?:\.\d+)?(?:[smhd])?$/.test(args[0]);
  if (wrapper === 'ionice') {
    let seenClass = false;
    let seenPriority = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-t') continue;
      if (arg === '-c' || /^-c\d+$/.test(arg)) {
        const value = arg === '-c' ? args[++i] : arg.slice(2);
        if (seenClass || !/^[0-3]$/.test(value ?? '')) return false;
        seenClass = true;
        continue;
      }
      if (arg === '-n' || /^-n\d+$/.test(arg)) {
        const value = arg === '-n' ? args[++i] : arg.slice(2);
        if (seenPriority || !/^[0-7]$/.test(value ?? '')) return false;
        seenPriority = true;
        continue;
      }
      return false;
    }
    return true;
  }
  if (wrapper === 'taskset') {
    if (args.length !== 2 || !['-c', '--cpu-list'].includes(args[0])) return false;
    return /^[0-9,^,-]+$/.test(args[1]);
  }
  if (wrapper === 'chrt') {
    let mode = false;
    let reset = false;
    let priority = false;
    for (const arg of args) {
      if (['-f', '--fifo', '-r', '--rr', '-o', '--other', '-b', '--batch', '-i', '--idle'].includes(arg)) {
        if (mode || priority) return false;
        mode = true;
      } else if (arg === '-R' || arg === '--reset-on-fork') {
        if (reset || priority) return false;
        reset = true;
      } else if (!priority && numeric(arg)) priority = true;
      else return false;
    }
    return mode && priority;
  }
  if (wrapper === 'stdbuf') {
    for (let i = 0; i < args.length; i++) {
      const match = /^-([ioe])(.+)$/.exec(args[i]);
      if (match) {
        if (!/^(?:0|L|\d+[KMG]?)$/.test(match[2])) return false;
        continue;
      }
      if (['-i', '-o', '-e', '--input', '--output', '--error'].includes(args[i])) {
        const value = args[++i];
        if (!/^(?:0|L|\d+[KMG]?)$/.test(value ?? '')) return false;
        continue;
      }
      const long = /^(?:--input|--output|--error)=(.+)$/.exec(args[i]);
      if (!long || !/^(?:0|L|\d+[KMG]?)$/.test(long[1])) return false;
    }
    return true;
  }
  return false;
}

function trustLockfileWrapperChainAllowed(argv, commandIndex, shell) {
  let i = 0;
  while (i < commandIndex) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]) || KEYWORDS.has(argv[i])) {
      i++;
      continue;
    }
    const wrapper = commandBase(argv[i] ?? '', shell).toLowerCase();
    if (!TRUST_LOCKFILE_COMMAND_WRAPPERS.has(wrapper)) return false;
    const next = wrappedCommandPosition(argv, i, shell);
    if (next <= i + 1 || next > commandIndex
      || !trustLockfileWrapperArgumentsAllowed(wrapper, argv.slice(i + 1, next))) return false;
    i = next;
  }
  return i === commandIndex;
}

function trustLockfileGitGlobalOptionsAllowed(args, prefix, state) {
  if (prefix.some((word) => /^GIT_[A-Za-z0-9_]*=/i.test(word))) return false;
  if ([...(state?.environmentVariables?.keys() ?? [])].some((name) => /^GIT_/i.test(name))) return false;

  const forbiddenLongOptions = ['--config-env', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix'];
  let operandsOnly = false;
  for (const arg of args) {
    if (arg === '--') { operandsOnly = true; continue; }
    if (operandsOnly) continue;
    if (arg === '-c' || /^-c./.test(arg)) return false;
    const option = arg.startsWith('--') ? arg.split('=', 1)[0] : '';
    if (option && forbiddenLongOptions.some((name) => name.startsWith(option))) return false;
  }
  return true;
}

function trustLockfileFetchOptionsAllowed(args) {
  const operands = [];
  let all = false;
  for (const arg of args) {
    if (['-q', '--quiet', '-p', '--prune', '--tags', '--no-tags'].includes(arg)) continue;
    if (arg === '--all') { all = true; continue; }
    const depth = /^--depth=(\d+)$/.exec(arg);
    if (depth && Number(depth[1]) > 0) continue;
    if (arg.startsWith('-') || !trustLockfileLiteralPath(arg)) return false;
    operands.push(arg);
  }
  if (all) return operands.length === 0;
  if (operands.length === 0) return true;
  const [remote, ...refspecs] = operands;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)
    || remote.includes('..') || remote.endsWith('.') || remote.toLowerCase().endsWith('.lock')) return false;
  return refspecs.every((refspec) => /^[A-Za-z0-9._/-]+$/.test(refspec)
    && refspec.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.'))
    && !refspec.includes('//') && !refspec.includes('..') && !refspec.includes('@{')
    && !refspec.toLowerCase().endsWith('.lock'));
}

function trustLockfileReadOnlyGitArgsAllowed(subcommand, args) {
  const flags = {
    status: new Set(['-s', '--short', '-b', '--branch', '--show-stash', '--long', '--ignored', '--ahead-behind', '--no-ahead-behind', '--renames', '--no-renames', '--porcelain', '--untracked-files', '--ignore-submodules', '--column', '--find-renames']),
    log: new Set(['-p', '--patch', '-s', '--no-patch', '--oneline', '--decorate', '--no-decorate', '--graph', '--all', '--branches', '--tags', '--remotes', '--stat', '--shortstat', '--name-only', '--name-status', '--abbrev-commit', '--no-abbrev-commit', '--first-parent', '--reverse', '--topo-order', '--date-order', '--no-walk', '--ancestry-path']),
    diff: new Set(['--cached', '--staged', '--quiet', '--exit-code', '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--check', '--summary', '--color', '--no-color', '--ignore-space-change', '--ignore-all-space', '--ignore-space-at-eol', '--ignore-cr-at-eol', '--no-ext-diff', '--no-textconv']),
    'rev-parse': new Set(['--show-toplevel', '--show-prefix', '--show-cdup', '--is-inside-work-tree', '--is-bare-repository', '--git-common-dir', '--is-shallow-repository', '--verify', '--quiet', '-q', '--symbolic', '--symbolic-full-name', '--abbrev-ref', '--default-prefix']),
    show: new Set(['-p', '--patch', '-s', '--no-patch', '--oneline', '--decorate', '--no-decorate', '--stat', '--shortstat', '--name-only', '--name-status', '--abbrev-commit', '--no-abbrev-commit', '--first-parent', '--no-walk']),
  }[subcommand];
  const values = {
    status: new Set(),
    log: new Set(['-S', '-G', '-n', '--max-count', '--skip', '--format', '--pretty', '--author', '--committer', '--grep', '--since', '--after', '--until', '--before', '--date', '--decorate-refs', '--decorate-refs-exclude']),
    diff: new Set(['-U', '--unified', '--word-diff', '--word-diff-regex', '--color-moved', '--color-moved-ws', '--ignore-submodules', '--src-prefix', '--dst-prefix', '--line-prefix', '--inter-hunk-context', '--diff-algorithm']),
    'rev-parse': new Set(['--short', '--disambiguate', '--default', '--prefix', '--sq', '--output-object-format']),
    show: new Set(['--format', '--pretty', '--max-count', '--since', '--after', '--until', '--before', '--date', '--decorate-refs', '--decorate-refs-exclude']),
  }[subcommand];
  const optionalValues = subcommand === 'status'
    ? new Set(['--porcelain', '--untracked-files', '--ignore-submodules', '--column', '--find-renames'])
    : new Set();
  if (!flags || !values) return false;

  let operandsOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (operandsOnly) {
      if (!trustLockfileLiteralPath(arg)) return false;
      continue;
    }
    if (arg === '--') { operandsOnly = true; continue; }
    if (!arg.startsWith('-')) {
      if (!trustLockfileLiteralPath(arg)) return false;
      continue;
    }

    if (!arg.startsWith('--')) {
      if (flags.has(arg)) continue;
      if (subcommand === 'log' && /^-\d+$/.test(arg)) continue;
      if (values.has(arg)) {
        const value = args[++i];
        if (!value || value.startsWith('-') || !trustLockfileLiteralPath(value)) return false;
        continue;
      }
      return false;
    }

    const equal = arg.indexOf('=');
    const name = equal < 0 ? arg : arg.slice(0, equal);
    if (flags.has(name)) {
      if (equal >= 0 && (!optionalValues.has(name) || !arg.slice(equal + 1))) return false;
      if (equal >= 0 && name === '--porcelain' && !/^(?:v1|v2)$/.test(arg.slice(equal + 1))) return false;
      if (equal >= 0 && name === '--untracked-files' && !/^(?:no|normal|all)$/.test(arg.slice(equal + 1))) return false;
      continue;
    }
    if (!values.has(name)) return false;
    let value = equal < 0 ? args[++i] : arg.slice(equal + 1);
    if (!value || value.startsWith('-') || !trustLockfileLiteralPath(value)) return false;
    if (name === '--porcelain' && !/^(?:v1|v2)$/.test(value)) return false;
    if (name === '--untracked-files' && !/^(?:no|normal|all)$/.test(value)) return false;
  }
  return true;
}

function trustLockfileGitInvocation(argv, commandIndex, shell, state) {
  const gitPath = argv[commandIndex] ?? '';
  if (commandBase(gitPath, shell).toLowerCase() !== 'git' || /[\\/]/.test(gitPath)) return false;
  const prefix = argv.slice(0, commandIndex);
  if (!trustLockfileGitGlobalOptionsAllowed(argv.slice(commandIndex + 1), prefix, state)) return false;

  const args = argv.slice(commandIndex + 1);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (/^-c(?:$|.)/i.test(arg) || /^--config-env(?:=|$)/i.test(arg)
      || /^--(?:exec-path|git-dir|work-tree|super-prefix|namespace)(?:=|$)/i.test(arg)) return false;
    if (arg === '-C' || arg.startsWith('-C')) {
      const value = arg === '-C' ? args[++i] : arg.slice(2);
      if (!trustLockfileLiteralPath(value)) return false;
      i++;
      continue;
    }
    if (['--no-pager', '--paginate', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--literal-pathspecs'].includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) return false;
    break;
  }
  const subcommand = args[i];
  if (!subcommand || args.slice(i + 1).some((arg) => hasShellExpansion(arg, shell))) return false;
  const rest = args.slice(i + 1);
  if (rest.some((arg) => /^-c(?:$|.)/i.test(arg) || /^--(?:config-env|exec-path|git-dir|work-tree)(?:=|$)/i.test(arg))) {
    return false;
  }

  if (['status', 'log', 'diff', 'rev-parse', 'show', 'fetch'].includes(subcommand)) {
    if (subcommand !== 'fetch' && !trustLockfileReadOnlyGitArgsAllowed(subcommand, rest)) return false;
    if (['log', 'diff', 'show'].includes(subcommand)) {
      for (let j = 0; j < rest.length; j++) {
        const arg = rest[j];
        if (arg === '--output' || arg === '-o' || /^--output=/.test(arg) || /^-o.+/.test(arg)
          || ['--ext-diff', '--textconv'].includes(arg)) return false;
        if (arg === '--config-env' || /^--config-env=/.test(arg)
          || ['--exec-path', '--git-dir', '--work-tree'].includes(arg)) return false;
      }
    }
    if (subcommand === 'fetch') {
      if (!trustLockfileFetchOptionsAllowed(rest)) return false;
    }
    return true;
  }

  if (subcommand === 'branch') {
    const branchArgs = rest;
    if (branchArgs.length === 1 && branchArgs[0] === '--show-current') return true;
    let list = false;
    for (let j = 0; j < branchArgs.length; j++) {
      const arg = branchArgs[j];
      if (['-a', '--all'].includes(arg)) continue;
      if (['--list', '-l'].includes(arg)) { list = true; continue; }
      if (arg.startsWith('-')) return false;
      if (!list || hasShellExpansion(arg, shell)) return false;
    }
    return list || branchArgs.some((arg) => ['-a', '--all'].includes(arg));
  }

  if (subcommand === 'worktree') {
    if (rest[0] === 'list') {
      return rest.slice(1).every((arg) => ['--porcelain', '-z', '-v', '--verbose'].includes(arg));
    }
    if (rest[0] !== 'add') return false;
    const addArgs = rest.slice(1);
    let branch = false;
    let path;
    const operands = [];
    for (let j = 0; j < addArgs.length; j++) {
      const arg = addArgs[j];
      if (arg === '-q' || arg === '--quiet') continue;
      if (arg === '-b' || arg === '--branch') {
        const name = addArgs[++j];
        if (branch || !name || name.startsWith('-') || !trustLockfileLiteralPath(name)) return false;
        branch = true;
        continue;
      }
      if (arg.startsWith('-') || !trustLockfileLiteralPath(arg)) return false;
      operands.push(arg);
    }
    path = operands[0];
    return !!path && operands.length <= 2;
  }

  return false;
}

function trustLockfilePnpmScriptInvocation(argv, commandIndex, shell, afterTrust) {
  if (!afterTrust) return false;
  const binary = argv[commandIndex] ?? '';
  if (commandBase(binary, shell).toLowerCase() !== 'pnpm' || /[\\/]/.test(binary)) return false;
  const prefix = argv.slice(0, commandIndex);
  if (prefix.some((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return false;
  const args = argv.slice(commandIndex + 1);
  if (args.some((arg) => /^--config(?:\.|$)/i.test(arg))) return false;
  let i = 0;
  let filtered = false;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '-r' || arg === '--recursive') { i++; continue; }
    if (arg === '-F' || arg === '--filter') {
      const filter = args[i + 1];
      if (!filter || filter.startsWith('-') || hasShellExpansion(filter, shell)) return false;
      filtered = true;
      i += 2;
      continue;
    }
    if (arg.startsWith('--filter=')) {
      const filter = arg.slice('--filter='.length);
      if (!filter || hasShellExpansion(filter, shell)) return false;
      filtered = true;
      i++;
      continue;
    }
    break;
  }
  const action = args[i];
  if (!action || action.startsWith('-') || hasShellExpansion(action, shell)
    || !trustLockfilePnpmScriptNameAllowed(action)) return false;
  const scriptForm = filtered || args.slice(0, i).some((arg) => arg === '-r' || arg === '--recursive');
  if (action === 'run') return trustLockfilePnpmScriptNameAllowed(args[i + 1]);
  if (['test', 'exec', 'build', 'lint', 'typecheck'].includes(action)) {
    return action !== 'exec' || trustLockfilePnpmScriptNameAllowed(args[i + 1]);
  }
  return scriptForm;
}

function trustLockfileOptionName(value) {
  return String(value ?? '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function trustLockfileLiteralPath(value) {
  return !!value && !hasShellExpansion(value) && !/[;&|(){}<>*?\[\]\n\r]/.test(value);
}

function trustLockfileAssignmentsAllowed(assignments) {
  if (!assignments.length) return false;
  return assignments.every(([name, value]) => {
    if (isTrustLockfileEnvironmentName(name)) return trustLockfileLiteralEnabled(value);
    return name.toUpperCase() === 'NODE_ENV' && String(value) === 'production';
  }) && assignments.some(([name]) => isTrustLockfileEnvironmentName(name));
}

function trustLockfileInstallOptionsAllowed(args) {
  let frozen = false;
  const values = new Set(['reporter', 'filter']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-r' || arg === '-s') continue;
    if (!arg.startsWith('-')) return false;
    if (arg === '-C' || arg.startsWith('-C')) return false;

    let key;
    let value;
    let hasValue = false;
    if (arg.startsWith('--')) {
      const equal = arg.indexOf('=');
      key = trustLockfileOptionName(equal < 0 ? arg.slice(2) : arg.slice(2, equal));
      if (equal >= 0) {
        hasValue = true;
        value = arg.slice(equal + 1);
      }
    } else return false;

    if (key === 'frozen-lockfile') {
      if (hasValue && !/^(?:true|1|yes|on)$/i.test(value)) return false;
      frozen = true;
      continue;
    }
    if (['prefer-offline', 'offline', 'silent', 'ignore-scripts', 'recursive'].includes(key)) {
      if (hasValue && !/^(?:true|1|yes|on)$/i.test(value)) return false;
      continue;
    }
    if (!values.has(key)) return false;
    if (!hasValue) {
      value = args[++i];
      if (value === undefined || value.startsWith('-')) return false;
    }
    if (!value || !trustLockfileLiteralPath(value)) return false;
  }
  return frozen;
}

function trustLockfilePnpmInvocation(argv, shell, depth = 0, state) {
  if (depth > 12 || !argv.length) return false;
  let i = 0;
  const assignments = [];
  const addAssignment = (word) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
    if (!match) return false;
    assignments.push([match[1], match[2]]);
    return true;
  };

  while (i < argv.length && addAssignment(argv[i])) i++;
  if (i >= argv.length) return false;
  const base = commandBase(argv[i], shell).toLowerCase();
  if (base === 'env') {
    i++;
    while (i < argv.length) {
      const arg = argv[i];
      if (arg === '--') { i++; break; }
      if (arg === '-i' || arg === '--ignore-environment') { i++; continue; }
      if (arg.startsWith('-')) return false;
      const envAssignment = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(arg);
      if (envAssignment) {
        assignments.push([envAssignment[1], envAssignment[2]]);
        i++;
        continue;
      }
      break;
    }
    if (i >= argv.length || !trustLockfileAssignmentsAllowed(assignments)) return false;
    return trustLockfilePnpmInvocation(argv.slice(i), shell, depth + 1, state);
  }
  if (base === 'nice') {
    i++;
    if (argv[i] === '-n') {
      if (!/^-?\d+$/.test(argv[i + 1] ?? '')) return false;
      i += 2;
    } else if (/^-n-?\d+$/.test(argv[i] ?? '')) i++;
    else if (/^-\d+$/.test(argv[i] ?? '')) i++;
    if (i >= argv.length || (assignments.length && !trustLockfileAssignmentsAllowed(assignments))) return false;
    return trustLockfilePnpmInvocation(argv.slice(i), shell, depth + 1, state);
  }
  if (base === 'timeout') {
    i++;
    if (argv[i]?.startsWith('-')) return false;
    if (!/^\d+(?:\.\d+)?(?:[smhd])?$/.test(argv[i] ?? '')) return false;
    i++;
    if (i >= argv.length || (assignments.length && !trustLockfileAssignmentsAllowed(assignments))) return false;
    return trustLockfilePnpmInvocation(argv.slice(i), shell, depth + 1, state);
  }
  if (TRUST_LOCKFILE_COMMAND_WRAPPERS.has(base)) {
    const next = wrappedCommandPosition(argv, i, shell);
    if (next <= i + 1 || next >= argv.length
      || !trustLockfileWrapperArgumentsAllowed(base, argv.slice(i + 1, next))
      || (assignments.length && !trustLockfileAssignmentsAllowed(assignments))) return false;
    return trustLockfilePnpmInvocation(argv.slice(next), shell, depth + 1, state);
  }
  if (base === 'bash') {
    const args = argv.slice(i + 1);
    const code = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
    if (code < 0 || args.length !== code + 2 || (assignments.length && !trustLockfileAssignmentsAllowed(assignments))) return false;
    return trustLockfileWholeCommandAllowed(args[code + 1], 'bash', depth + 1, state);
  }
  if (base === 'jobq') {
    const queued = queuedJobqShellCommand(argv, shell);
    if (!queued || queued.shell !== 'bash' || (assignments.length && !trustLockfileAssignmentsAllowed(assignments))) return false;
    return trustLockfileWholeCommandAllowed(queued.script, queued.shell, depth + 1, state);
  }

  if (assignments.length && !trustLockfileAssignmentsAllowed(assignments)) return false;
  if (/[\\/]/.test(argv[i] ?? '')) return false;
  const manager = canonicalManagerName(commandBase(argv[i] ?? '', shell));
  if (manager !== 'pnpm') return false;
  if (!['install', 'i'].includes(argv[i + 1])) return false;
  return trustLockfileInstallOptionsAllowed(argv.slice(i + 2));
}

function trustLockfileRedirectsAllowed(part, {
  allowBareLog = false,
  extensions = TRUST_LOCKFILE_OUTPUT_EXT,
} = {}) {
  for (let i = 0; i < part.length; i++) {
    const token = part[i];
    const value = typeof token === 'string' ? token : token.value;
    if (typeof token === 'string' || !token.redirect || !/^(?:&?>|\d*>|\d*&>)/.test(value)) continue;
    const target = part[i + 1];
    const destination = typeof target === 'string' ? target : target?.value;
    if (!destination) return false;
    if (/^\d+$/.test(destination) && />&/.test(value)) continue;
    if (!trustLockfileLiteralPath(destination)) return false;
    if (!extensions.test(destination)
      && !(allowBareLog && /(?:^|[/\\])log\d*$/i.test(destination))) return false;
    i++;
  }
  return true;
}

function trustLockfileWithoutRedirects(part) {
  const out = [];
  for (let i = 0; i < part.length; i++) {
    const token = part[i];
    if (typeof token === 'string' || !token.redirect) {
      out.push(token);
      continue;
    }
    const target = part[i + 1];
    const targetValue = typeof target === 'string' ? target : target?.value;
    if (target !== undefined && !SEPARATORS.has(targetValue)
      && !(typeof target !== 'string' && target.redirect)) i++;
  }
  return out;
}

function trustLockfileHasFileOutput(part) {
  for (let i = 0; i < part.length; i++) {
    const token = part[i];
    const value = typeof token === 'string' ? token : token.value;
    if (typeof token === 'string' || !token.redirect || !/^(?:&?>|\d*>|\d*&>)/.test(value)) continue;
    const target = part[i + 1];
    const destination = typeof target === 'string' ? target : target?.value;
    if (destination && /^\d+$/.test(destination) && />&/.test(value)) continue;
    return true;
  }
  return false;
}

function trustLockfilePipeConsumer(part, shell, state) {
  const argv = trustLockfileWithoutRedirects(part).map((token) => typeof token === 'string' ? token : token.value);
  if (trustLockfileHasFileOutput(part)) return false;
  const index = commandPosition(argv, shell);
  let base = commandBase(argv[index] ?? '', shell).toLowerCase();
  if (/^(?:tail|head)-\d+$/.test(base)) base = base.split('-', 1)[0];
  const args = argv.slice(index + 1);
  if (['tail', 'head', 'grep', 'rg', 'wc', 'cat'].includes(base)) {
    if (base === 'rg' && args.some((arg) => /^--pre(?:=|$)|^--pre-glob(?:=|$)/.test(arg))) return false;
    if (base === 'rg' && state?.environmentVariables?.has('RIPGREP_CONFIG_PATH')) return false;
    if (args.some((arg) => hasShellExpansion(arg, shell))) return false;
    return true;
  }
  if (base !== 'tee') return false;
  const destinations = [];
  for (let i = 0; i < args.length; i++) {
    if (['-a', '--append', '-i', '--ignore-interrupts'].includes(args[i])) continue;
    if (args[i].startsWith('-')) return false;
    destinations.push(args[i]);
  }
  return destinations.length > 0 && destinations.every((path) => /\.(?:log|txt)$/i.test(path) && trustLockfileLiteralPath(path));
}

function trustLockfileSafeCommand(part, shell, source, depth = 0, state, afterTrust = false) {
  if (depth > 12 || !part.length) return undefined;
  const cleanPart = trustLockfileWithoutRedirects(part);
  const argv = cleanPart.map((token) => typeof token === 'string' ? token : token.value);
  if (part.some((token) => typeof token !== 'string' && token.redirect && /^<<?/.test(token.value))) return undefined;
  const redirectsValid = trustLockfileRedirectsAllowed(part);
  const redirectsInstallValid = trustLockfileRedirectsAllowed(part, { extensions: /\.(?:log|txt)$/i });
  const redirectsLogOnly = trustLockfileRedirectsAllowed(part, { allowBareLog: true, extensions: /\.(?:log|txt)$/i });

  const queued = queuedJobqShellCommand(argv, shell);
  const index = commandPosition(argv, shell);
  const base = commandBase(argv[index] ?? '', shell).toLowerCase();
  if (!trustLockfileWrapperChainAllowed(argv, index, shell)) return undefined;
  const commandPrefixAssignments = argv.slice(0, index).flatMap((word) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
    return match ? [[match[1], match[2]]] : [];
  });
  if (commandPrefixAssignments.length && !trustLockfileAssignmentsAllowed(commandPrefixAssignments)) return undefined;
  if (queued) {
    if (!redirectsInstallValid && !redirectsLogOnly) return undefined;
    const parsed = trustLockfileScriptToken(cleanPart, shell, source);
    if (!parsed || hasShellExpansion(parsed.script, parsed.shell)) return undefined;
    return trustLockfileWholeCommandAllowed(parsed.script, parsed.shell, depth + 1, state) ? 'trust' : undefined;
  }
  if (base === 'bash') {
    if (!redirectsInstallValid && !redirectsLogOnly) return undefined;
    const args = argv.slice(index + 1);
    const code = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
    const token = cleanPart[index + 1 + code + 1];
    if (code < 0 || args.length !== code + 2 || !token || typeof token === 'string'
      || !/^['"]/.test(source.slice(token.start, token.end))
      || hasShellExpansion(args[code + 1], 'bash')) return undefined;
    return trustLockfileWholeCommandAllowed(args[code + 1], 'bash', depth + 1, state) ? 'trust' : undefined;
  }
  const pnpmInvocation = canonicalManagerName(commandBase(argv[index] ?? '', shell)) === 'pnpm'
    && trustLockfilePnpmInvocation(argv, shell, depth + 1, state);
  if (pnpmInvocation && (redirectsInstallValid || redirectsLogOnly)) return 'trust';
  if (trustLockfilePnpmScriptInvocation(argv, index, shell, afterTrust)) {
    return redirectsInstallValid ? 'safe' : undefined;
  }
  if (base === 'git' && !trustLockfileHasFileOutput(part)
    && trustLockfileGitInvocation(argv, index, shell, state)) return 'safe';
  if (trustLockfilePipeConsumer(cleanPart, shell, state)) return 'consumer';

  const assignments = [];
  for (let i = 0; i < index; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[i]);
    if (match) assignments.push([match[1], match[2]]);
  }
  if (assignments.length || index < 0 || !redirectsValid || trustLockfileHasFileOutput(part)) return undefined;
  const args = argv.slice(index + 1);
  let normalizedBase = base;
  if (/^(?:tail|head)-\d+$/.test(normalizedBase)) normalizedBase = normalizedBase.split('-', 1)[0];
  if (['cd', 'pushd'].includes(normalizedBase)) {
    const paths = args[0] === '--' ? args.slice(1) : args;
    return paths.length === 1 && paths[0] !== '-' && trustLockfileLiteralPath(paths[0]) ? 'safe' : undefined;
  }
  if (normalizedBase === 'popd') return args.length === 0 || (args.length === 1 && /^\+\d+$/.test(args[0])) ? 'safe' : undefined;
  if (normalizedBase === ':' || normalizedBase === 'true') return args.length === 0 ? 'safe' : undefined;
  if (normalizedBase === 'mkdir') return args[0] === '-p' && args.length > 1 && args.slice(1).every(trustLockfileLiteralPath) ? 'safe' : undefined;
  if (normalizedBase === 'echo' || normalizedBase === 'printf') {
    if (normalizedBase === 'printf' && (args[0] === '-v' || /^-v.+/.test(args[0] ?? ''))) return undefined;
    if (args.some((arg) => hasShellExpansion(arg, shell))) return undefined;
    return 'safe';
  }
  if (['head', 'tail'].includes(normalizedBase)) {
    if (args.some((arg) => hasShellExpansion(arg, shell))) return undefined;
    return 'safe';
  }
  return undefined;
}

function trustLockfileWholeCommandAllowed(source, shell, depth = 0, state) {
  if (depth > 12) return false;
  const text = Array.isArray(source) ? source.join(' ') : String(source ?? '');
  if (!TRUST_LOCKFILE_MENTION.test(text) || /(?:\bfunction\s+[A-Za-z_]\w*|\b[A-Za-z_]\w*\s*\(\s*\))\s*\{/.test(text)) return false;
  const tokens = Array.isArray(source) ? source : tokenize(text, true, shell);
  const commands = trustLockfileMentionCommands(tokens, text);
  if (!commands.length) return false;
  let trustLines = 0;
  let afterTrust = false;
  let pipeMode;
  for (let i = 0; i < commands.length; i++) {
    const entry = commands[i];
    if (entry.functionBody) return false;
    const kind = trustLockfileSafeCommand(entry.tokens, shell, text, depth + 1, state, afterTrust);
    if (!kind) return false;
    if (kind === 'trust') {
      if (entry.separatorBefore === '|' || pipeMode) return false;
      trustLines++;
      afterTrust = true;
      pipeMode = entry.separatorAfter === '|' ? 'trust' : undefined;
    } else if (entry.separatorBefore === '|') {
      if (kind !== 'consumer' || !pipeMode) return false;
      pipeMode = entry.separatorAfter === '|' ? pipeMode : undefined;
    } else {
      if (pipeMode) return false;
      if (entry.separatorAfter === '|') {
        if (kind !== 'safe' && kind !== 'consumer') return false;
        if (kind === 'consumer') return false;
        pipeMode = 'safe';
      } else pipeMode = undefined;
    }
  }
  return trustLines === 1 && afterTrust && !pipeMode;
}

function canAllowTrustLockfileOnCommand(argv, shell, state, depth = 0) {
  if (depth > 12 || !state.trustLockfileWholeCommandAllowed) return false;
  if (state.trustLockfileOpaqueShellDepth > 0) return false;
  const assignments = (state.trustLockfileAssignments ?? []).filter(({ segmentId }) => segmentId === state.currentEnvironmentSegmentId);
  if (!assignments.length || assignments.some(({ scope }) => scope !== 'scoped')
    || assignments.some(({ value }) => !trustLockfileLiteralEnabled(value))) return false;

  const commandArgv = stripShellRedirects(argv);
  return trustLockfilePnpmInvocation(commandArgv, shell, depth + 1, state);
}

function hasTrustLockfileConfigSetting(tokens, shell = 'bash') {
  return segments(tokens).some((part) => {
    const i = commandPosition(part, shell);
    const base = canonicalManagerName(commandBase(part[i] ?? '', shell));
    if (!['npm', 'pnpm'].includes(base)) return false;
    if (base === 'pnpm' && part.slice(i + 1).some(trustLockfileOptionEnabled)) return true;
    if (trustLockfileConfigOptionEnabled(part.slice(i + 1))) return true;
    const pos = positionals(part.slice(i + 1), valueSet[base]);
    let key;
    if (['npm', 'pnpm'].includes(base) && pos[0] === 'set' && pos[1]) key = pos[1];
    else if (pos[0] === 'config' && pos[1] === 'set' && pos[2]) key = pos[2];
    else if (['npm', 'pnpm'].includes(base) && pos[0] === 'c' && pos[1] === 'set' && pos[2]) key = pos[2];
    return isTrustLockfileConfigKey(key);
  });
}

const containsTrustLockfileName = (text) => new RegExp(`(?<![A-Za-z0-9_])${TRUST_LOCKFILE_NAME_PATTERN}(?![A-Za-z0-9_])`, 'i').test(text);
const isTrustLockfileVariableArgument = (arg) => {
  const name = /^([A-Za-z_][A-Za-z0-9_-]*)(?:\+?=|$)/.exec(arg)?.[1];
  return !!name && isTrustLockfileEnvironmentName(name);
};
const variableAssignmentTarget = (operand) => operand.split('=', 1)[0].replace(/\+$/, '');
const hasComputedVariableAssignmentTarget = (operand) => {
  const target = variableAssignmentTarget(operand);
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)
    && (target.startsWith('!') || /[$`*?\[\]{}]/.test(target));
};
const isBashDeclarationPrintOnly = (base, args) => {
  if (!['export', 'declare', 'typeset', 'local', 'readonly'].includes(base)
    || !args.some((arg) => /^-[^-]*p/.test(arg))) return false;
  const operands = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (optionsEnded || !/^[+-][A-Za-z]+$/.test(arg)) operands.push(arg);
  }
  return operands.every((arg) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg));
};

function stripBashComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) out += text[++i];
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '#' && (i === 0 || /[\s;&|(){}]/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      if (i < text.length) out += '\n';
    } else out += ch;
  }
  return out;
}

function trustLockfileMentionCommands(tokens, source = '') {
  const commands = [];
  let command = [];
  let separatorBefore = ';';
  const flush = (separatorAfter = ';') => {
    if (command.length) commands.push({ tokens: command, separatorBefore, separatorAfter, functionBody: false });
    command = [];
    separatorBefore = separatorAfter;
  };
  const groupStarts = [];
  let closedGroups = [];
  for (const token of tokens) {
    const value = typeof token === 'string' ? token : token.value;
    if (value === '{' || value === '(') {
      if (command.length) flush(separatorBefore);
      groupStarts.push(commands.length);
      continue;
    }
    if (value === '}' || value === ')') {
      if (command.length) flush(';');
      const start = groupStarts.pop();
      if (start !== undefined && commands.length > start) closedGroups.push([start, commands.length - 1]);
      continue;
    }
    if (SEPARATORS.has(value)) {
      if (value === '|') {
        for (const [start, end] of closedGroups) {
          for (let i = start; i <= end; i++) commands[i].separatorAfter = '|';
        }
      }
      closedGroups = [];
      flush(value);
      continue;
    }
    command.push(token);
  }
  flush();
  const functionRanges = [];
  const declarations = /(?:\bfunction\s+[A-Za-z_]\w*|\b[A-Za-z_]\w*\s*\(\s*\))\s*\{/g;
  for (const match of source.matchAll(declarations)) {
    const open = source.indexOf('{', match.index + match[0].length - 1);
    let depth = 1;
    let quote = null;
    let end = source.length;
    for (let i = open + 1; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\\') { i++; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { end = i; break; }
    }
    functionRanges.push([open + 1, end]);
  }
  for (const entry of commands) {
    const mention = entry.tokens.find((token) => TRUST_LOCKFILE_MENTION.test(typeof token === 'string' ? token : token.value));
    const offset = mention && typeof mention !== 'string' ? mention.start : -1;
    entry.functionBody = offset >= 0 && functionRanges.some(([start, end]) => start <= offset && offset < end);
  }
  return commands;
}

function trustLockfileRcPath(value) {
  return /(?:^|[/\\])(?:\.(?:bashrc|bash_profile|bash_login|zshenv|zshrc|zprofile|zlogin|profile|kshrc|cshrc|npmrc|yarnrc(?:\.yml)?|env(?:\.[\w.-]+)?|pnpmfile\.[cm]js)|[\w.-]+\.env)(?=$|[^\w.-])/i.test(value ?? '');
}

function trustLockfileRedirectsToRc(part) {
  for (let i = 0; i < part.length; i++) {
    const token = part[i];
    const value = typeof token === 'string' ? token : token.value;
    const isRedirect = typeof token !== 'string' && token.redirect;
    if (!isRedirect || !/^(?:&?>|\d*>|\d*&>)/.test(value)) continue;
    const target = part[i + 1];
    const targetValue = typeof target === 'string' ? target : target?.value;
    if (targetValue && !/^[0-9&>-]+$/.test(targetValue) && trustLockfileRcPath(targetValue)) return true;
  }
  return false;
}

function trustLockfileScriptToken(part, shell, source) {
  const argv = part.map((token) => typeof token === 'string' ? token : token.value);
  let scriptIndex;
  let scriptShell;
  const queued = queuedJobqShellCommand(argv, shell);
  if (queued?.shell === 'bash') {
    const index = commandPosition(argv, shell);
    const args = argv.slice(index + 1);
    const separator = args.indexOf('--');
    const command = args.slice(separator + 1);
    const code = command.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
    scriptIndex = index + separator + code + 3;
    scriptShell = queued.shell;
  } else {
    const index = commandPosition(argv, shell);
    const executable = commandBase(argv[index] ?? '', shell);
    if (executable !== 'bash') return undefined;
    const args = argv.slice(index + 1);
    const code = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
    if (code < 0 || args[code + 1] === undefined) return undefined;
    scriptIndex = index + code + 2;
    scriptShell = executable;
  }
  const token = part[scriptIndex];
  const literal = token && typeof token !== 'string' ? source?.slice(token.start, token.end) : '';
  if (!literal || !/^(['"])[\s\S]*\1$/.test(literal)) return undefined;
  return { script: argv[scriptIndex], shell: scriptShell };
}

function trustLockfileDataCommand(part, shell, { heredoc = false, source = '', state } = {}) {
  const argv = trustLockfileWithoutRedirects(part).map((token) => typeof token === 'string' ? token : token.value);
  if (!argv.length || trustLockfileRedirectsToRc(part)) return false;
  const parsedScript = trustLockfileScriptToken(part, shell, source);
  if (parsedScript) return !hasShellExpansion(parsedScript.script, parsedScript.shell);
  const index = commandPosition(argv, shell);
  const base = commandBase(argv[index] ?? '', shell).toLowerCase();
  const args = argv.slice(index + 1);
  if (argv.slice(0, index).some((word) => WRAPPERS.has(commandBase(word, shell)))) return false;
  if (index < 0 || !base || ['source', '.', 'eval', 'trap', 'alias', 'function'].includes(base)) return false;
  const prefixAssignments = argv.slice(0, index).filter((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (base === 'rg' && (args.some((arg) => /^--pre(?:=|$)|^--pre-glob(?:=|$)/.test(arg))
    || prefixAssignments.some((word) => /^RIPGREP_CONFIG_PATH=/i.test(word))
    || state?.environmentVariables?.has('RIPGREP_CONFIG_PATH'))) return false;
  if (base === 'less' && prefixAssignments.some((word) => /^(?:LESSOPEN|LESSCLOSE)=/i.test(word))) return false;
  if (base === 'git' && !trustLockfileGitGlobalOptionsAllowed(args, prefixAssignments, state)) return false;
  if (base === 'less' && [...(state?.environmentVariables?.keys() ?? [])].some((name) => ['LESSOPEN', 'LESSCLOSE'].includes(name))) return false;
  if (hasOutputRedirect(part.map((token) => typeof token === 'string' ? token : token.value))
    && !trustLockfileRedirectsAllowed(part)) return false;
  if (base === 'echo') return !heredoc;
  if (base === 'printf') {
    if (args[0] === '-v' || /^-v.+/.test(args[0] ?? '')) return false;
    if (heredoc) return false;
    return true;
  }
  if (base === 'tee') {
    const destinations = [];
    for (let i = 0; i < args.length; i++) {
      if (['-a', '--append', '-i', '--ignore-interrupts'].includes(args[i])) continue;
      if (args[i].startsWith('-')) return false;
      destinations.push(args[i]);
    }
    return destinations.every((path) => TRUST_LOCKFILE_OUTPUT_EXT.test(path));
  }
  if (['grep', 'rg', 'ag', 'cat', 'head', 'tail', 'less', 'wc'].includes(base)) {
    if (base === 'less' && args.some((arg) => ['-o', '-O', '--log-file'].includes(arg)
      || /^-[oO].+/.test(arg) || /^--log-file=/.test(arg))) return false;
    return !heredoc || ['cat', 'grep', 'rg', 'ag', 'head', 'tail', 'less', 'wc'].includes(base);
  }
  const gitIndex = commandBase(argv[index] ?? '', shell).toLowerCase() === 'git';
  if (gitIndex) {
    const sub = positionals(args, new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']))[0];
    if (['log', 'show', 'diff', 'format-patch'].includes(sub)
      && args.some((arg) => arg === '--output' || arg === '-o' || arg.startsWith('--output=') || /^-o.+/.test(arg))) return false;
    if (args.some((arg, i) => (arg === '-c' && /^core\.hooksPath=/i.test(args[i + 1] ?? ''))
      || /^-c(core\.hooksPath)=/i.test(arg))) return false;
    if (['log', 'show', 'diff', 'grep', 'blame', 'status', 'format-patch'].includes(sub)) return !heredoc;
    if (sub !== 'commit') return false;
    for (let i = 0; i < args.length; i++) {
      if (['-m', '-F'].includes(args[i]) && args[i + 1] !== undefined) return !heredoc || args[i + 1] === '-';
      if (args[i].startsWith('-m') && args[i].length > 2) return !heredoc;
      if (args[i].startsWith('-F') && args[i].length > 2) return !heredoc;
    }
    return false;
  }
  if (base === 'gh') {
    const [resource, action] = positionals(args, new Set(['-R', '--repo', '--hostname'])) ;
    if (!['pr', 'issue'].includes(resource) || !['view', 'comment', 'create'].includes(action)) return false;
    for (let i = 0; i < args.length; i++) {
      if (['--body', '--body-file'].includes(args[i]) && args[i + 1] !== undefined) {
        return !heredoc || (args[i] === '--body-file' && args[i + 1] === '-');
      }
      if (args[i].startsWith('--body=')) return !heredoc;
    }
  }
  return false;
}

function hasTrustLockfileMentionFloor(tokens, shell, state, source = '', heredocEntries = []) {
  if (!tokens.some((token) => TRUST_LOCKFILE_MENTION.test(typeof token === 'string' ? token : token.value))
    && !heredocEntries.some(({ body }) => TRUST_LOCKFILE_MENTION.test(body))) return false;
  const commands = trustLockfileMentionCommands(tokens, source);
  for (let i = 0; i < commands.length; i++) {
    const entry = commands[i];
    const argv = entry.tokens.map((token) => typeof token === 'string' ? token : token.value);
    if (!argv.some((word) => TRUST_LOCKFILE_MENTION.test(word))) continue;
    const id = entry.tokens.find((token) => typeof token !== 'string')?.segmentId;
    if (id !== undefined && state.allowedTrustLockfileSegments.has(id)) continue;
    if (entry.functionBody || !trustLockfileDataCommand(entry.tokens, shell, { source, state })) return true;
    for (let next = i; commands[next].separatorAfter === '|'; next++) {
      if (next + 1 >= commands.length || !trustLockfileDataCommand(commands[next + 1].tokens, shell, { source, state })) return true;
    }
  }
  for (const { body, parts } of heredocEntries) {
    if (!TRUST_LOCKFILE_MENTION.test(body)) continue;
    const recipientParts = parts.map((part) => {
      const words = [];
      for (let i = 0; i < part.length; i++) {
        const value = typeof part[i] === 'string' ? part[i] : part[i].value;
        if (value === '<<') { i++; continue; }
        words.push(part[i]);
      }
      return words;
    }).filter((part) => part.length);
    if (!recipientParts.length || !recipientParts.every((part) => trustLockfileDataCommand(part, shell, { heredoc: true, state }))) return true;
    const first = recipientParts[0].map((word) => typeof word === 'string' ? word : word.value);
    const index = commandPosition(first, shell);
    const base = commandBase(first[index] ?? '', shell).toLowerCase();
    if (!['cat', 'grep', 'rg', 'ag', 'head', 'tail', 'less', 'wc', 'git', 'gh'].includes(base)) return true;
  }
  return false;
}

function arithmeticHasComputedAssignmentTarget(expression) {
  const assignment = /<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|(?<![=!<>])=(?!=)/.exec(expression);
  if (assignment) return hasComputedVariableAssignmentTarget(expression.slice(0, assignment.index).split(',').at(-1).trim());
  const increment = /(?:\+\+|--)/.exec(expression);
  if (!increment) return false;
  const target = increment.index === 0
    ? expression.slice(increment.index + 2).trim().split(/\s/, 1)[0]
    : expression.slice(0, increment.index).trim().split(/\s/).at(-1);
  return hasComputedVariableAssignmentTarget(target ?? '');
}
const arithmeticWritesTrustLockfile = (expression) => {
  const name = TRUST_LOCKFILE_NAME_PATTERN;
  return new RegExp(`(?:^|[^A-Za-z0-9_])${name}(?=\\s*(?:\\+\\+|--|<<=|>>=|[+\\-*/%&|^]?=(?!=)))|(?:\\+\\+|--)\\s*${name}(?![A-Za-z0-9_])`, 'i').test(expression);
};

function commandSubstitutionEnd(text, start) {
  let depth = 1;
  let quote = null;
  for (let i = start + 2; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
      else if (text.startsWith('$(', i)) {
        const end = commandSubstitutionEnd(text, i);
        if (end < 0) return -1;
        i = end;
      }
      continue;
    }
    if (ch === '\\') i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (text.startsWith('$(', i)) {
      const end = commandSubstitutionEnd(text, i);
      if (end < 0) return -1;
      i = end;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

function maskArithmeticCommandSubstitutions(expression) {
  let out = '';
  for (let i = 0; i < expression.length; i++) {
    if (expression.startsWith('$((', i)) {
      out += '$((';
      i++;
      continue;
    }
    if (expression.startsWith('$(', i)) {
      const end = commandSubstitutionEnd(expression, i);
      if (end >= 0) {
        out += ' '.repeat(end - i + 1);
        i = end;
        continue;
      }
    }
    out += expression[i];
  }
  return out;
}

function bashMutationSyntax(text) {
  let out = '';
  let quote = null;
  const copyExpansion = (start, open) => {
    const marker = open === '${' ? '}' : '))';
    const end = text.indexOf(marker, start + open.length);
    const last = end < 0 ? text.length - 1 : end + marker.length - 1;
    const expansion = text.slice(start, last + 1);
    out += open === '$(('
      ? maskArithmeticCommandSubstitutions(expansion)
      : expansion;
    return last;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      out += ' ';
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < text.length) i++;
      else if (text.startsWith('$((', i)) i = copyExpansion(i, '$((');
      else if (text.startsWith('${', i)) i = copyExpansion(i, '${');
      else out += ' ';
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      i++;
      out += '  ';
    } else if (ch === "'") {
      quote = "'";
      out += ' ';
    } else if (ch === '"') {
      quote = '"';
      out += ' ';
    } else if (ch === '#' && (i === 0 || /[\s;&|()]/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      if (i < text.length) out += '\n';
    } else if (text.startsWith('$((', i)) {
      i = copyExpansion(i, '$((');
    } else if (text.startsWith('((', i)) {
      i = copyExpansion(i, '((');
    } else if (text.startsWith('${', i)) {
      i = copyExpansion(i, '${');
    } else out += ch;
  }
  return out;
}

function readVariableNames(args) {
  const names = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^(?:\d*<|&>)/.test(arg)) break;
    if (arg === '--') {
      names.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      names.push(arg);
      continue;
    }
    if (arg.startsWith('--')) continue;
    const flags = arg.slice(1);
    let consumedValue = false;
    for (let j = 0; j < flags.length; j++) {
      const flag = flags[j];
      if (flag === 'a') {
        if (args[i + 1] !== undefined) names.push(args[++i]);
        break;
      }
      if ('dNnptui'.includes(flag)) {
        if (j === flags.length - 1 && args[i + 1] !== undefined) i++;
        consumedValue = true;
        break;
      }
    }
    if (consumedValue) continue;
  }
  return names;
}

function hasBashTrustLockfileMutation(text, tokens = tokenize(text, true)) {
  const syntax = bashMutationSyntax(text);
  const defaultAssignment = new RegExp(`\\$\\{\\s*${TRUST_LOCKFILE_NAME_PATTERN}\\s*:?=`, 'i');
  if (defaultAssignment.test(syntax)) return true;
  for (const match of syntax.matchAll(/\$\{([^}]*)\}/g)) {
    const assignment = /(?::=|(?<![=!<>])=(?!=))/.exec(match[1]);
    if (assignment && hasComputedVariableAssignmentTarget(match[1].slice(0, assignment.index).trim())) return true;
  }
  const arithmetic = /(?:\$\(\(|\(\()([\s\S]*?)\)\)/g;
  for (const match of syntax.matchAll(arithmetic)) {
    const expression = maskArithmeticCommandSubstitutions(match[1]);
    if (arithmeticWritesTrustLockfile(expression) || arithmeticHasComputedAssignmentTarget(expression)) return true;
  }

  return segments(tokens).some((part) => {
    const words = part.map((token) => typeof token === 'string' ? token : token.value);
    const index = commandPosition(words, 'bash');
    const base = commandBase(words[index] ?? '', 'bash');
    const args = stripShellRedirects(part.slice(index + 1));
    if (base === 'eval') return args.some(containsTrustLockfileName);
    if (base === 'for') return words[index + 2] === 'in'
      && (isTrustLockfileEnvironmentName(words[index + 1] ?? '')
        || hasComputedVariableAssignmentTarget(words[index + 1] ?? ''));
    if (base === 'read') return readVariableNames(args).some((name) => isTrustLockfileVariableArgument(name)
      || hasComputedVariableAssignmentTarget(name));
    if (base === 'mapfile' || base === 'readarray') {
      const values = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--') {
          values.push(...args.slice(i + 1));
          break;
        }
        if (args[i] === '-u' || args[i] === '-n' || args[i] === '-O' || args[i] === '-C' || args[i] === '-c' || args[i] === '-d' || args[i] === '-s') i++;
        else if (!args[i].startsWith('-')) values.push(args[i]);
      }
      return isTrustLockfileVariableArgument(values[0] ?? '')
        || (values.length > 0 && hasComputedVariableAssignmentTarget(values[0]));
    }
    if (base === 'printf') {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-v') return isTrustLockfileVariableArgument(args[i + 1] ?? '')
          || (!!args[i + 1] && hasComputedVariableAssignmentTarget(args[i + 1]));
        if (args[i].startsWith('-v') && args[i].length > 2) {
          const name = args[i].slice(2);
          return isTrustLockfileVariableArgument(name) || hasComputedVariableAssignmentTarget(name);
        }
        if (!args[i].startsWith('-')) break;
      }
      return false;
    }
    if (base === 'getopts') return isTrustLockfileEnvironmentName(args[1] ?? '')
      || (!!args[1] && hasComputedVariableAssignmentTarget(args[1]));
    if (['declare', 'typeset', 'local', 'readonly', 'export'].includes(base)) {
      if (isBashDeclarationPrintOnly(base, args)) return false;
      const names = args.filter((arg) => !/^[+-]/.test(arg) && arg !== '--');
      if (names.some((name) => isTrustLockfileVariableArgument(name) || hasComputedVariableAssignmentTarget(name))) return true;
      const nameref = ['declare', 'typeset', 'local'].includes(base)
        && args.some((arg) => /^-[^-]*n/.test(arg));
      return nameref && names.some((name) => {
        const equals = name.indexOf('=');
        if (equals < 0) return false;
        const value = name.slice(equals + 1);
        return isTrustLockfileEnvironmentName(value) || hasComputedVariableAssignmentTarget(value);
      });
    }
    if (base === 'let') return args.some((arg) => arithmeticWritesTrustLockfile(arg)
      || arithmeticHasComputedAssignmentTarget(arg));
    return false;
  });
}

function hasTrustLockfileFileWrite(text, tokens, shell = 'bash') {
  if (!/trust[-_]?lockfile/i.test(text)) return false;
  const environmentFile = /(?:^|[/\\])(?:\.env(?:[.\w-]*)?|[\w.-]+\.env)(?=$|[^\w.-])/i;
  const shellRcFile = /(?:^|[/\\])\.(?:bashrc|bash_profile|bash_login|zshenv|zshrc|zprofile|zlogin|profile|kshrc|cshrc|config\/fish\/config\.fish)(?=$|[^\w.-])/i;
  const writers = new Set(['tee', 'tee-object', 'set-content', 'add-content', 'out-file']);
  return segments(tokens).some((part) => {
    const i = commandPosition(part, shell);
    const base = commandBase(part[i] ?? '', shell).toLowerCase();
    const writes = hasOutputRedirect(part) || writers.has(base);
    return writes && part.some((arg) => environmentFile.test(arg) || shellRcFile.test(arg));
  });
}

function recordPowerShellTrustLockfileSetter(text, state) {
  for (const raw of rawSegments(text, 'powershell')) {
    const call = /^\s*(?:\$[A-Za-z_]\w*\s*=\s*)?\[(?:system\.)?environment\]::setenvironmentvariable\s*\(\s*(['"])([\w@:-]+)\1\s*,\s*([^,)]*)/i.exec(raw);
    if (call && isTrustLockfileEnvironmentName(call[2])) {
      const value = call[3].trim() || undefined;
      recordEnvironmentOccurrence(state, call[2], value, 'persistent');
    }

    const tokens = tokenize(raw, false, 'powershell');
    const i = commandPosition(tokens, 'powershell');
    const base = commandBase(tokens[i] ?? '', 'powershell');
    if (!['set-item', 'si', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac'].includes(base)) continue;
    const args = tokens.slice(i + 1);
    const { values, positionals, positionalPathUsed } = powerShellWriteOperands(base, args);
    const value = values.at(-1) ?? positionals[positionalPathUsed ? 1 : 0];
    for (const name of powerShellEnvironmentNames(base, args)) {
      if (isTrustLockfileEnvironmentName(name)) recordEnvironmentOccurrence(state, name, value, 'persistent');
    }
  }
}

function hasPackageLockBypass(manager, sub, args, state) {
  if (['npm', 'pnpm'].includes(manager) && ['install', 'i', 'add'].includes(sub)) {
    const values = manager === 'npm'
      ? booleanOptionValues(args, 'package-lock')
      : booleanOptionValues(args, 'lockfile', ['lockf']);
    const env = manager === 'npm'
      ? booleanEnvironmentValues(state, 'NPM_CONFIG_PACKAGE_LOCK')
      : booleanEnvironmentValues(state, 'PNPM_CONFIG_LOCKFILE', 'NPM_CONFIG_LOCKFILE');
    if (values.includes(false) || env.includes(false)) return true;
    if (manager === 'pnpm') {
      const pnpmResolution = [
        booleanOptionValues(args, 'fix-lockfile', ['fix-lockf']),
        booleanOptionValues(args, 'lockfile-only', ['lockfile-o']),
        booleanOptionValues(args, 'resolution-only'),
        booleanOptionValues(args, 'update-checksums', ['update-checks']),
        booleanOptionValues(args, 'force'),
        booleanOptionValues(args, 'frozen-lockfile', ['frozen-lockf']),
        booleanOptionValues(args, 'prefer-frozen-lockfile', ['prefer-frozen-lockf']),
      ];
      const pnpmResolutionEnvironment = [
        booleanEnvironmentValues(state, 'PNPM_CONFIG_FIX_LOCKFILE', 'NPM_CONFIG_FIX_LOCKFILE'),
        booleanEnvironmentValues(state, 'PNPM_CONFIG_LOCKFILE_ONLY', 'NPM_CONFIG_LOCKFILE_ONLY'),
        booleanEnvironmentValues(state, 'PNPM_CONFIG_UPDATE_CHECKSUMS', 'NPM_CONFIG_UPDATE_CHECKSUMS'),
        booleanEnvironmentValues(state, 'PNPM_CONFIG_FORCE', 'NPM_CONFIG_FORCE'),
        booleanEnvironmentValues(state, 'PNPM_CONFIG_FROZEN_LOCKFILE', 'NPM_CONFIG_FROZEN_LOCKFILE'),
        booleanEnvironmentValues(state, 'PNPM_CONFIG_PREFER_FROZEN_LOCKFILE', 'NPM_CONFIG_PREFER_FROZEN_LOCKFILE'),
      ];
      if (pnpmResolution.slice(0, 5).some((options) => options.includes(true))
        || pnpmResolution.slice(5).some((options) => options.includes(false))
        || pnpmResolutionEnvironment.slice(0, 4).some((options) => options.includes(true))
        || pnpmResolutionEnvironment.slice(4).some((options) => options.includes(false))) return true;
    }
  }
  if (manager === 'yarn' && ['install', 'add'].includes(sub)) {
    if (booleanOptionValues(args, 'lockfile').includes(false)
      || booleanOptionValues(args, 'frozen-lockfile').includes(false)
      || booleanOptionValues(args, 'immutable').includes(false)
      || booleanEnvironmentValues(state, 'YARN_ENABLE_IMMUTABLE_INSTALLS').includes(false)
      || flagValues(args, '--mode').includes('update-lockfile')) return true;
  }
  if (manager === 'bun' && ['install', 'add'].includes(sub)) {
    const injected = [];
    for (const value of environmentValues(state, 'BUN_OPTIONS')) {
      const parsed = safelyTokenizeArgumentEnvironment(String(value), state.shell);
      if (!parsed) return true;
      injected.push(...parsed);
    }
    const options = [...args, ...injected];
    if (booleanOptionValues(options, 'lockfile-only', ['package-lock-only']).includes(true)
      || booleanEnvironmentValues(state, 'BUN_CONFIG_SKIP_LOAD_LOCKFILE').includes(true)) return true;
    if (sub === 'install' && (booleanOptionValues(options, 'force').includes(true) || options.includes('-f'))
      && !args.some((arg) => ['-g', '--global'].includes(arg))) return true;
  }
  if (manager === 'pipenv' && ['install', 'upgrade', 'update', 'lock'].includes(sub)) {
    const deploy = booleanOptionValues(args, 'deploy');
    const ignorePipfile = booleanOptionValues(args, 'ignore-pipfile');
    if (booleanOptionValues(args, 'skip-lock').includes(true)
      || booleanEnvironmentValues(state, 'PIPENV_SKIP_LOCK').includes(true)) return true;
    const ignoreFromEnvironment = booleanEnvironmentValues(state, 'PIPENV_IGNORE_PIPFILE');
    const ignoreValues = [...ignoreFromEnvironment, ...ignorePipfile];
    if (ignoreValues.includes(true)
      && (hasConflictingValues(ignoreValues) || hasConflictingValues(deploy)
        || deploy.length === 0 || deploy.includes(false))) return true;
    if (sub === 'lock') return true;
  }
  return false;
}

const NPM_VERBS = {
  install: { npm: ['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'install-test', 'it', 'link', 'ln'], pnpm: ['add', 'install', 'i'], yarn: ['add', 'install'], bun: ['add', 'a', 'install', 'i'] },
  update: { npm: ['update', 'up', 'upgrade', 'udpate'], pnpm: ['update', 'up', 'upgrade'], yarn: ['up', 'upgrade'], bun: ['update'] },
  run: { npm: ['exec', 'x'], pnpm: ['dlx'], yarn: ['dlx'], bun: ['x'] },
  create: { npm: ['create', 'init', 'innit'], pnpm: ['create'], yarn: ['create'], bun: ['create'] },
};

const NPM_MANAGER_PACKAGES = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PYTHON_MANAGER_PACKAGES = new Set(['pip', 'pipx', 'pipenv', 'uv']);

function packageName(spec) {
  const at = spec.indexOf('@', spec.startsWith('@') ? spec.indexOf('/') + 1 : 1);
  return at < 0 ? spec : spec.slice(0, at);
}

function isGlobalManagerInstall(args) {
  return args.some((arg, i) => ['-g', '--global', '--location=global'].includes(arg)
    || arg === '--location' && args[i + 1] === 'global');
}

function npmFamily(manager, rest, result, raw, state) {
  const values = valueSet[manager];
  let [sub, ...pos] = positionals(rest, values);
  let args = afterWord(rest, values, sub);
  if (manager === 'yarn' && sub === 'global') [sub, args] = [pos[0], afterWord(args, values, pos[0])];
  pos = positionals(args, values);
  if (manager === 'pnpm' && sub === 'with') {
    const withArgs = afterWord(rest, values, 'with');
    const version = positionals(withArgs, values)[0];
    if (version && version !== 'current') result.unreviewable.push({ manager, raw, reason: 'downloads a package manager release' });
    if (version) {
      const versionIndex = withArgs.indexOf(version);
      if (versionIndex >= 0) npmFamily('pnpm', withArgs.slice(versionIndex + 1), result, raw, state);
    }
    return;
  }
  if (manager === 'pnpm' && ((sub === 'runtime' || sub === 'rt') && pos[0] === 'set')) {
    result.unreviewable.push({ manager, raw, reason: 'downloads a runtime release' });
    return;
  }
  if (manager === 'pnpm' && sub === 'env' && pos[0] === 'use' && args.some((arg) => ['-g', '--global'].includes(arg))) {
    result.unreviewable.push({ manager, raw, reason: 'downloads a runtime release' });
    return;
  }
  if (manager === 'yarn' && sub === 'policies' && pos[0] === 'set-version') {
    result.unreviewable.push({ manager, raw, reason: 'downloads a package manager release' });
    return;
  }
  if (manager === 'yarn' && sub === 'init' && args.some((arg) => ['-i', '--install'].includes(arg) || /^--install=/.test(arg) || /^-i.+/.test(arg))) {
    result.unreviewable.push({ manager, raw, reason: 'downloads a package manager release' });
    return;
  }
  const globalManagerSpecs = manager === 'npm' && isGlobalManagerInstall(rest)
    && ['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'add', 'update', 'up', 'upgrade'].includes(sub)
    ? pos.filter((spec) => NPM_MANAGER_PACKAGES.has(packageName(spec))) : [];
  if (globalManagerSpecs.length) result.unreviewable.push({ manager, raw, reason: 'downloads a package manager release' });
  pos = pos.filter((spec) => !globalManagerSpecs.includes(spec));
  const lockBypass = NPM_VERBS.install[manager].includes(sub) && hasPackageLockBypass(manager, sub, rest, state);
  if (lockBypass) bulkUpgrade(result, manager, raw);
  if (manager === 'bun' && sub === 'add' && (args.includes('--analyze') || args.includes('-a'))) bulkUpgrade(result, manager, raw);
  else if (NPM_VERBS.install[manager].includes(sub)) pos.forEach((p) => npmSpec(p, manager, result));
  else if (NPM_VERBS.update[manager].includes(sub)) {
    if (pos.length) pos.forEach((p) => npmSpec(p, manager, result));
    else if (!globalManagerSpecs.length) bulkUpgrade(result, manager, raw);
  } else if (sub === 'audit' && (args.includes('fix') || args.some((arg) => arg === '--fix' || arg.startsWith('--fix=')))) {
    bulkUpgrade(result, manager, raw);
  } else if (sub === 'dedupe' && !args.includes('--check')) {
    if (manager === 'yarn' && pos.length) pos.forEach((p) => npmSpec(p, manager, result));
    else bulkUpgrade(result, manager, raw);
  } else if (manager === 'yarn' && sub === 'upgrade-interactive') {
    bulkUpgrade(result, manager, raw);
  } else if (manager === 'npm' && sub === 'pack' && pos.length) {
    pos.forEach((p) => npmSpec(p, manager, result));
  } else if (manager === 'npm' && sub === 'diff') {
    const specs = flagValues(args, '--diff');
    if (!specs.length && !args.some((arg) => ['--help', '-h'].includes(arg))) result.unreviewable.push({ manager, raw, reason: 'downloads package contents for a diff without a package name to review' });
    else specs.forEach((p) => /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(p)
      ? result.unreviewable.push({ manager, raw, reason: 'downloads package contents for a diff without a package name to review' })
      : npmSpec(p, manager, result));
  } else if (manager === 'bun' && sub === 'pm' && pos[0] === 'diff') {
    const diffArgs = afterWord(rest, values, 'pm').slice(1);
    const specs = positionals(diffArgs, values);
    if (!specs.length && !diffArgs.some((arg) => ['--help', '-h'].includes(arg))) result.unreviewable.push({ manager, raw, reason: 'downloads package contents for a diff without a package name to review' });
    else {
      let priorName;
      specs.forEach((p) => {
        if (isLocalPath(p)) return;
        if (p.includes('..')) result.unreviewable.push({ manager, raw, reason: 'downloads package contents for a diff with an ambiguous version pair' });
        else if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(p) && priorName) npmSpec(`${priorName}@${p}`, manager, result);
        else {
          npmSpec(p, manager, result);
          const at = p.indexOf('@', p.startsWith('@') ? p.indexOf('/') + 1 : 1);
          priorName = at < 0 ? p : p.slice(0, at);
        }
      });
    }
  } else if (manager === 'npm' && sub === 'cache' && pos[0] === 'add') {
    pos.slice(1).forEach((p) => npmSpec(p, manager, result));
  } else if (manager === 'npm' && sub === 'stage' && pos[0] === 'download') {
    result.unreviewable.push({ manager, raw, reason: 'downloads a staged package without a package name to review' });
  } else if (manager === 'yarn' && sub === 'set' && pos[0] === 'version') {
    result.unreviewable.push({ manager, raw, reason: 'downloads a package manager release' });
  } else if (manager === 'yarn' && sub === 'set' && pos[0] === 'resolution' && pos.length > 2) {
    const descriptor = pos[1];
    const at = descriptor.indexOf('@', descriptor.startsWith('@') ? descriptor.indexOf('/') + 1 : 1);
    const name = at < 0 ? '' : descriptor.slice(0, at);
    const resolution = pos[2].replace(/^npm:/, '');
    if (name && !resolution.includes('@')) npmSpec(`${name}@${resolution}`, manager, result);
    else result.unreviewable.push({ manager, raw, reason: 'changes a package resolution that cannot be mapped to one registry target' });
  } else if ((manager === 'pnpm' && sub === 'self-update') || (manager === 'bun' && sub === 'upgrade')) {
    result.unreviewable.push({ manager, raw, reason: 'downloads a package manager release' });
  } else if (sub === 'patch' && pos.length) {
    pos.slice(0, 1).forEach((p) => npmSpec(p, manager, result));
  } else if (NPM_VERBS.run[manager].includes(sub)) {
    const runnerName = { npm: 'npmExec', pnpm: 'pnpmDlx', yarn: 'yarnDlx', bun: 'bunX' }[manager];
    runner(args, manager, result, raw, state, runnerName);
  } else if (manager === 'bun' && sub === 'run') {
    runner(args, manager, result, raw, state, 'bunRun');
  } else if (sub === 'exec') {
    const runnerName = { npm: 'npmExec', pnpm: 'pnpmExec', yarn: 'yarnExec', bun: 'bunExec' }[manager];
    if (manager === 'bun') {
      const parsed = runnerReadingsFor(runnerName, args);
      for (const reading of parsed.readings) {
        const addition = { targets: [], bulk: [], unreviewable: [] };
        walk(reading.command.length === 1 ? reading.command[0] : reading.command, addition, state);
        mergeFindings(result, addition);
      }
      if (parsed.overflow) result.unreviewable.push({ manager, raw, reason: 'looks like an install the guard cannot parse' });
    } else runner(args, manager, result, raw, state, runnerName);
  }
  else if (NPM_VERBS.create[manager].includes(sub) && pos.length) initializer(pos[0], manager, result);
}

function runner(args, manager, result, raw, state, runnerName = manager) {
  const canonicalName = canonicalRunnerName(runnerName);
  const packages = runnerPackages(runnerName);
  const calls = runnerCalls(runnerName);
  const parsed = runnerReadingsFor(runnerName, args);
  for (const reading of parsed.readings) {
    const installActionsBefore = state.installActions;
    const commands = reading.options.filter(({ option }) => calls.includes(option)).map(({ value }) => value).filter(Boolean);
    const addition = { targets: [], bulk: [], unreviewable: [] };
    commands.forEach((command) => walk(command, addition, state));
    const command = commands.length ? [] : reading.command;
    const pkgs = reading.options.filter(({ option }) => packages.includes(option)).map(({ value }) => value).filter(Boolean);
    const shellMode = canonicalName === 'pnpmDlx' && reading.options.some(({ option }) => ['-c', '--shell-mode'].includes(option));
    if (!pkgs.length && command[0] && !shellMode && RUNNER_DEFAULT_PACKAGE.has(canonicalName)) pkgs.push(command[0]);
    pkgs.forEach((pkg) => npmSpec(pkg, manager, addition));
    if (command.length) {
      if (shellMode) walk(command.length === 1 ? command[0] : command, addition, state);
      else classifyChecked(command, addition, command.join(' '), state);
    }
    if (['bunRun', 'bunX'].includes(canonicalName)) {
      askForEnvironmentInstall(addition, state, installActionsBefore, manager, raw);
    }
    mergeFindings(result, addition);
  }
  if (parsed.overflow) result.unreviewable.push({ manager, raw, reason: 'looks like an install the guard cannot parse' });
}

function uvToolRun(args, manager, result, raw, state) {
  const parsed = runnerReadingsFor('uvToolRun', args);
  const installActionsBefore = state.installActions;
  for (const reading of parsed.readings) {
    const addition = { targets: [], bulk: [], unreviewable: [] };
    const from = reading.options.filter(({ option }) => option === '--from').map(({ value }) => value);
    askForConflictingValues(from, '--from', manager, raw, addition);
    const packages = from.length ? distinctValues(from) : [reading.command[0]].filter(Boolean);
    packages.forEach((pkg) => pypiSpec(pkg, manager, addition));
    if (reading.command.length) classifyChecked(reading.command, addition, reading.command.join(' '), state);
    mergeFindings(result, addition);
  }
  if (parsed.overflow) result.unreviewable.push({ manager, raw, reason: 'looks like an install the guard cannot parse' });
  if (flagValues(args, '--with-requirements', '--with-editable').length) bulkUpgrade(result, manager, raw);
  askForEnvironmentInstall(result, state, installActionsBefore, manager, raw);
}

function pipInstall(args, manager, result, raw, state) {
  const requirement = flagValues(args, '-r', '--requirement', '--requirements', '--requirements-from-script', '--group').length > 0
    || args.some((a) => /^-r.+/.test(a));
  const constrained = flagValues(args, '-c', '--constraint', '--constraints', '--build-constraint', '--build-constraints', '-b').length > 0
    || args.some((a) => /^-(?:c|b).+/.test(a));
  const overridden = flagValues(args, '--override', '--overrides').length > 0;
  if (requirement) bulkUpgrade(result, manager, raw);
  if (constrained || overridden) bulkUpgrade(result, manager, raw);
  const filtered = [];
  const editable = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['-r', '--requirement', '--requirements', '--requirements-from-script', '--group', '-e', '--editable'].includes(arg)) {
      if (['-e', '--editable'].includes(arg) && args[i + 1] !== undefined) editable.push(args[++i]);
      else if (args[i + 1] !== undefined) i++;
    } else if (/^(?:-e|--editable)=/.test(arg)) editable.push(arg.slice(arg.indexOf('=') + 1));
    else if (/^-e.+/.test(arg)) editable.push(arg.slice(2));
    else filtered.push(arg);
  }
  const before = result.targets.length;
  editable.forEach((p) => pypiSpec(p, manager, result));
  const specs = positionals(filtered, manager === 'pipx' ? valueSet.py : valuesForManager(manager));
  const upgrade = args.some((arg) => ['-U', '--upgrade'].includes(arg));
  const managerSpecs = specs.filter((spec) => {
    const name = packageName(spec);
    return PYTHON_MANAGER_PACKAGES.has(name) && (name === 'pip' || upgrade);
  });
  if (managerSpecs.length) result.unreviewable.push({ manager, raw, reason: 'downloads a package manager release' });
  specs.filter((spec) => !managerSpecs.includes(spec)).forEach((p) => pypiSpec(p, manager, result));
  if (constrained) {
    for (const target of result.targets.splice(before)) result.unreviewable.push({
      manager: target.manager,
      raw,
      reason: 'constraints may pin a version other than the one reviewed',
    });
  }
  if (overridden) {
    for (const target of result.targets.splice(before)) result.unreviewable.push({
      manager: target.manager,
      raw,
      reason: 'overrides may select a version other than the one reviewed',
    });
  }
}

function withPackages(args, manager, result) {
  flagValues(args, '--with').flatMap((w) => w.split(',')).filter(Boolean).forEach((p) => pypiSpec(p.trim(), manager, result));
}

function pipxMayDownloadPython(args) {
  const configured = flagValues(args, '--fetch-python');
  if (args.includes('--fetch-missing-python')) configured.push('missing');
  return configured.some((value) => ['always', 'missing'].includes(String(value).toLowerCase()));
}

function unreviewedManagerAction(base, rest) {
  const values = base === 'deno' ? valuesForManager(base) : [];
  const words = positionals(rest, new Set(['--directory', '-C', '--project', '--environment', '-e', '--manifest-path', '-m', '--update', '--package', '--version', '-v', ...values]));
  const [sub, sub2] = words;
  if (base === 'hatch') return (sub === 'env' && ['create', 'update'].includes(sub2)) || sub === 'run' || sub === 'shell';
  if (base === 'dotnet') return sub === 'restore' || (sub === 'add' && sub2 === 'package') || (sub === 'package' && sub2 === 'add') || (sub === 'tool' && ['install', 'update', 'restore', 'run'].includes(sub2));
  if (base === 'composer' && sub === 'global') return ['install', 'require', 'update', 'create-project'].includes(words[1]);
  if (base === 'go') return ['install', 'get'].includes(sub) || (sub === 'mod' && ['download', 'tidy', 'vendor'].includes(sub2)) || (sub === 'run' && !!words[1] && !isLocalPath(words[1]) && words[1].includes('@'));
  if (['conda', 'mamba', 'micromamba'].includes(base)) return ['install', 'update', 'create'].includes(sub) || (sub === 'env' && ['create', 'update'].includes(sub2));
  if (base === 'cargo') return ['install', 'binstall', 'add', 'update', 'fetch', 'vendor'].includes(sub) && !(sub === 'install' && rest.includes('--list'));
  if (base === 'poetry') return ['install', 'add', 'update', 'sync', 'lock'].includes(sub) || (sub === 'self' && ['add', 'update'].includes(sub2));
  if (base === 'pdm') return ['install', 'add', 'update', 'sync', 'lock'].includes(sub) || (sub === 'self' && sub2 === 'update');
  if (base === 'gem') return ['install', 'i', 'update', 'fetch', 'unpack', 'exec'].includes(sub);
  if (['bundle', 'bundler'].includes(base)) return ['install', 'add', 'update', 'lock', 'cache'].includes(sub);
  if (base === 'composer') return ['install', 'require', 'update', 'create-project'].includes(sub);
  if (base === 'deno') return ['add', 'install', 'update', 'cache', 'upgrade', 'create'].includes(sub)
    || /(?:npm:|jsr:|https?:\/\/)/i.test(rest.join(' '));
  if (base === 'pixi') return ['add', 'install', 'update'].includes(sub)
    || (sub === 'global' && sub2 === 'install')
    || (sub === 'exec' && rest.some((arg) => ['--with', '-w', '--spec', '-s'].includes(arg) || ['--with=', '--spec='].some((flag) => arg.startsWith(flag))));
  if (base === 'rye') return ['add', 'install', 'sync'].includes(sub) || (sub === 'lock' && rest.some((arg) => arg === '--update-all' || arg === '--update')) || (sub === 'self' && sub2 === 'update');
  return false;
}

function commandAfterOptions(args, values = [], flags = []) {
  return runnerReadings(args, new Set(values), new Set(flags));
}

function commandAfterFlag(args, flags) {
  const i = args.findIndex((arg) => flags.includes(arg) || flags.some((flag) => arg.startsWith(`${flag}=`)));
  if (i < 0) return undefined;
  return args[i].includes('=') ? [args[i].slice(args[i].indexOf('=') + 1)] : args.slice(i + 1);
}

function hatchCommand(args) {
  let command = args.filter((arg) => !/^[+-][\w-]+=/.test(arg));
  if (/^[^:]+:.+/.test(command[0] ?? '')) command[0] = command[0].slice(command[0].indexOf(':') + 1);
  return command;
}

function environmentRunner(base, rest, result, state, raw) {
  const installActionsBefore = state.installActions;
  if (base === 'nix-shell') {
    const command = commandAfterFlag(rest, ['--run', '--command']);
    if (!command) return false;
    const parsed = { readings: [{ command, options: [], ambiguous: false }], overflow: false };
    for (const reading of parsed.readings) {
      if (reading.command.length) walk(reading.command.length === 1 ? reading.command[0] : reading.command, result, state);
    }
    askForEnvironmentInstall(result, state, installActionsBefore, base, raw);
    return true;
  }
  const envFileWrapper = envFileWrapperArgs(base, rest);
  if (envFileWrapper) {
    classifyCommandReadings(runnerReadings(envFileWrapper.args, envFileWrapper.values), result, raw, state, base);
    askForEnvironmentInstall(result, state, installActionsBefore, base, raw);
    return true;
  }
  const globals = ENVIRONMENT_RUNNER_VALUES[base];
  if (!globals) return false;
  const parsedGlobals = runnerReadings(rest, globals, undefined, ENVIRONMENT_RUNNER_VALUE_COUNTS[base]);
  const before = result.targets.length + result.bulk.length + result.unreviewable.length;
  let foundRunner = false;
  let overflow = parsedGlobals.overflow;
  const classifyStrings = (parsed) => {
    for (const reading of parsed.readings) {
      if (!reading.command.length) continue;
      const addition = { targets: [], bulk: [], unreviewable: [] };
      walk(reading.command.length === 1 ? reading.command[0] : reading.command, addition, state);
      mergeFindings(result, addition);
    }
    if (parsed.overflow) result.unreviewable.push({ manager: base, raw, reason: 'looks like an install the guard cannot parse' });
  };
  const read = (args, values = [], flags = []) => commandAfterOptions(args, values, flags);
  const subcommands = {
    poetry: new Set(['run']), pdm: new Set(['run']), hatch: new Set(['run']), pipenv: new Set(['run']), rye: new Set(['run']),
    pixi: new Set(['run', 'exec']), conda: new Set(['run']), mamba: new Set(['run']), micromamba: new Set(['run']),
    bundle: new Set(['exec']), mise: new Set(['exec', 'x']), asdf: new Set(['exec']), volta: new Set(['run']),
    fnm: new Set(['exec']), nvm: new Set(['exec', 'run']), direnv: new Set(['exec']), devbox: new Set(['run']),
    nix: new Set(['develop', 'shell']),
  }[base];
  for (const globalReading of parsedGlobals.readings) {
    const command = globalReading.command;
    const sub = command[0];
    let child;
    let parsed;
    let commandString = false;
    let transform = (argv) => argv;
    if (base === 'hatch' && sub === 'env' && command[1] === 'run') {
      child = command.slice(2);
      parsed = read(child, ['--env', '-e', '--include', '-i', '--exclude', '-x', '--filter', '-f']);
      transform = hatchCommand;
    } else if (subcommands.has(sub)) {
      child = command.slice(1);
      if (base === 'poetry') parsed = read(child, ['--directory', '-C', '--project']);
      else if (base === 'pdm') parsed = read(child, ['--env', '--env-file', '--working-dir', '--pyproject']);
      else if (base === 'hatch') {
        parsed = read(child, ['--env', '-e']);
        transform = hatchCommand;
      } else if (base === 'pipenv') parsed = read(child, ['--python']);
      else if (base === 'rye') parsed = read(child, ['--pyproject', '--env-file']);
      else if (base === 'pixi' && sub === 'run') parsed = read(child, ['--environment', '-e', '--platform', '-p', '--manifest-path', '--config-file', '--auth-file', '--env-file']);
      else if (base === 'pixi' && sub === 'exec'
        && !child.some((arg) => ['--with', '-w', '--spec', '-s'].includes(arg) || ['--with=', '--spec='].some((flag) => arg.startsWith(flag)))) {
        parsed = read(child, ['--channel', '-c', '--platform', '-p', '--tls-root-certs']);
      } else if (['mamba', 'micromamba'].includes(base)) parsed = read(child, ['--name', '-n', '--prefix', '-p', '--cwd', '--env-file']);
      else if (base === 'conda') parsed = read(child, ['--name', '-n', '--prefix', '-p', '--cwd']);
      else if (base === 'bundle') parsed = read(child);
      else if (base === 'mise') {
        const shellCommand = commandAfterFlag(child, ['-c', '--command']);
        const separator = child.indexOf('--');
        const commandValue = shellCommand ?? (separator < 0 ? undefined : child.slice(separator + 1));
        if (commandValue !== undefined) parsed = { readings: [{ command: commandValue, options: [], ambiguous: false }], overflow: false };
        commandString = shellCommand !== undefined;
      } else if (base === 'asdf') parsed = read(child);
      else if (base === 'volta') parsed = read(child, ['--node', '--npm', '--yarn', '--env']);
      else if (base === 'fnm') parsed = read(child, ['--using', '--fnm-dir', '--node-dist-mirror', '--log-level', '--arch', '--version-file-strategy'], ['--corepack-enabled', '--resolve-engines']);
      else if (base === 'nvm') {
        const options = runnerReadings(child, new Set(), new Set(['--silent']));
        parsed = { readings: options.readings.map((reading) => ({ ...reading, command: reading.command.slice(1) })), overflow: options.overflow };
      } else if (base === 'direnv') {
        const options = runnerReadings(child, new Set(), new Set(['--help', '--version']));
        parsed = { readings: options.readings.map((reading) => ({ ...reading, command: reading.command.slice(1) })), overflow: options.overflow };
      } else if (base === 'devbox') parsed = read(child, ['--config', '-c', '--env', '-e', '--env-file']);
      else if (base === 'nix') {
        const commandValue = commandAfterFlag(child, ['-c', '--command']);
        if (commandValue !== undefined) parsed = { readings: [{ command: commandValue, options: [], ambiguous: false }], overflow: false };
        commandString = true;
      }
    }
    if (!parsed) continue;
    foundRunner = true;
    overflow ||= parsed.overflow;
    if (commandString) classifyStrings(parsed);
    else classifyCommandReadings(parsed, result, raw, state, base, transform);
  }
  if (overflow && !result.unreviewable.some(({ manager, raw: source }) => manager === base && source === raw)) {
    result.unreviewable.push({ manager: base, raw, reason: 'looks like an install the guard cannot parse' });
  }
  if (!foundRunner && result.targets.length + result.bulk.length + result.unreviewable.length === before && INSTALL_INTENT.test(raw)) {
    result.unreviewable.push({ manager: base, raw, reason: 'looks like an install the guard cannot parse' });
  }
  if (foundRunner) {
    askForEnvironmentInstall(result, state, installActionsBefore, base, raw);
    return true;
  }
  return overflow || INSTALL_INTENT.test(raw);
}

function walkOpaqueShellCommand(command, result, state, shell = state.shell) {
  const previousDepth = state.trustLockfileOpaqueShellDepth ?? 0;
  state.trustLockfileOpaqueShellDepth = previousDepth + 1;
  try {
    walk(command, result, state, shell);
  } finally {
    state.trustLockfileOpaqueShellDepth = previousDepth;
  }
}

function queuedJobqShellCommand(argv, shell = 'bash') {
  const index = commandPosition(argv, shell);
  if (commandBase(argv[index] ?? '', shell) !== 'jobq') return undefined;
  const args = argv.slice(index + 1);
  if (args[0] !== 'add') return undefined;
  const separator = args.indexOf('--');
  if (separator < 0) return undefined;
  const command = args.slice(separator + 1);
  const executable = commandBase(command[0] ?? '', shell);
  if (!SHELLS.has(executable)) return undefined;
  const code = command.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
  if (code < 1 || command[code + 1] === undefined || command.length !== code + 2) return undefined;
  return { script: command[code + 1], shell: executable };
}

function classify(argv, result, raw, state, source = raw, tokenSpans) {
  let i = 0;
  let viaXargs = false;
  while (i < argv.length) {
    const t = argv[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || KEYWORDS.has(t)) i++;
    else if (WRAPPERS.has(commandBase(t, state.shell))) {
      const wrapper = commandBase(t, state.shell);
      viaXargs ||= ['xargs', 'parallel'].includes(wrapper);
      const wrappedIndex = wrappedCommandPosition(argv, i, state.shell);
      if (wrapper === 'command' && argv.slice(i + 1, wrappedIndex).some((arg) => ['-v', '-V', '--verbose', '--version'].includes(arg))) return;
      if (wrapper === 'builtin' && argv.slice(i + 1, wrappedIndex).includes('-p')) return;
      if (stdinScriptInvocation(argv, i, state.shell)) {
        result.unreviewable.push({ manager: 'shell', raw, reason: 'script piped into a shell' });
        return;
      }
      if (wrapper === 'corepack' && ['use', 'install', 'prepare', 'up'].includes(argv[wrappedIndex])) {
        result.unreviewable.push({ manager: 'corepack', raw, reason: 'downloads a package manager release' });
        return;
      }
      if (wrapper === 'corepack' && /^(?:npm|pnpm|yarn|yarnpkg|bun)@.+$/i.test(argv[wrappedIndex] ?? '')) {
        result.unreviewable.push({ manager: 'corepack', raw, reason: 'downloads a package manager release' });
        return;
      }
      if (wrapper === 'env') {
        const split = splitStringCommand(argv.slice(i + 1));
        if (split) return walk([...tokenize(split.value), ...split.trailing], result, state);
      }
      if (wrapper === 'watch') {
        const commandIndex = wrappedCommandPosition(argv, i, state.shell);
        if (commandIndex < argv.length) walk(argv.slice(commandIndex).join(' '), result, state);
        return;
      }
      if (['runuser', 'su'].includes(wrapper)) {
        const commandOption = argv.findIndex((arg, index) => index > i && index < wrappedIndex
          && ['-c', '--command', '--session-command'].includes(arg));
        if (commandOption >= 0 && argv[commandOption + 1]) return walk(argv[commandOption + 1], result, state);
      }
      if (wrapper === 'sudo') {
        const shellMode = argv.slice(i + 1, wrappedIndex).some((arg) => ['-s', '--shell', '-i', '--login'].includes(arg));
        if (shellMode && wrappedIndex < argv.length) return walk(argv.slice(wrappedIndex).join(' '), result, state);
      }
      if (wrapper === 'flock') {
        const commandOption = argv.findIndex((arg, index) => index > i && ['-c', '--command'].includes(arg));
        if (commandOption >= 0 && argv[commandOption + 1]) return walk(argv[commandOption + 1], result, state);
      }
      i = wrappedCommandPosition(argv, i, state.shell);
    } else break;
  }
  const [cmd, ...rest] = argv.slice(i);
  if (!cmd) return;
  const base = commandBase(cmd, state.shell);
  if (base === 'bun') {
    const bunArgv = bunArgumentsWithEnvironment(argv, state, result, raw);
    if (!bunArgv) return;
    const options = scanBunOptions(bunArgv, state.shell);
    classifyBunModuleOptions(options, result, raw);
    const inline = bunInlineInvocation(argv, state.shell, options);
    if (inline) {
      classifyBunCode(inline.code, bunArgv, inline.code !== undefined && !hasShellExpansion(source, state.shell), result, state, raw);
      return;
    }
    if (bunStdinInvocation(argv, state.shell)) {
      const key = argv.join(' ');
      const count = state.bunStdinHandled?.get(key) ?? 0;
      if (count) {
        if (count === 1) state.bunStdinHandled.delete(key);
        else state.bunStdinHandled.set(key, count - 1);
        return;
      }
      classifyBunCode(undefined, bunArgv, false, result, state, raw);
      return;
    }
  }
  if (powerShellExecutable(cmd, state.shell)) {
    const encoded = rest.find(powerShellEncodedOption);
    if (encoded) {
      result.unreviewable.push({ manager: 'powershell', raw, reason: 'encoded PowerShell command' });
      return;
    }
    const commandIndex = rest.findIndex(powerShellCommandOption);
    if (commandIndex !== -1 && rest.length > commandIndex + 1) {
      const command = rest.slice(commandIndex + 1);
      walkOpaqueShellCommand(command.length === 1 ? command[0] : command, result, state, 'powershell');
    } else if (base !== 'pwsh') {
      for (let j = 0; j < rest.length; j++) {
        if (/^-file$|^-f$/i.test(rest[j])) return;
        if (powerShellOptionValue(rest[j])) {
          j++;
          continue;
        }
        if (rest[j].startsWith('-')) continue;
        const command = rest.slice(j);
        walkOpaqueShellCommand(command.length === 1 ? command[0] : command, result, state, 'powershell');
        break;
      }
    }
    return;
  }
  if (environmentRunner(base, rest, result, state, raw)) return;
  if (UNREVIEWED_MANAGERS.has(base) && unreviewedManagerAction(base, rest)) {
    result.unreviewable.push({ manager: base, raw, reason: 'package manager the guard does not review' });
    return;
  }
  if (viaXargs && INSTALL_INTENT.test([cmd, ...rest].join(' '))) {
    result.unreviewable.push({ manager: base, raw, reason: 'package names come from stdin through xargs' });
    return;
  }
  if (SHELLS.has(base)) {
    const c = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (c !== -1 && rest[c + 1]) {
      const scriptToken = tokenSpans?.[i + c + 2];
      const sourceStart = tokenSpans?.[0]?.start ?? 0;
      const doubleQuoted = scriptToken && source.slice(scriptToken.start - sourceStart, scriptToken.end - sourceStart).startsWith('"');
      if (base !== 'bash' || !doubleQuoted || hasShellExpansion(rest[c + 1], base)) {
        walkOpaqueShellCommand(rest[c + 1], result, state);
      }
      else walk(rest[c + 1], result, state);
    }
    return;
  }
  if (base === 'eval') return walkOpaqueShellCommand(rest.length === 1 ? rest[0] : rest, result, state);
  if (state.shell === 'powershell' && ['iex', 'invoke-expression'].includes(base)) {
    return walkOpaqueShellCommand(rest.length === 1 ? rest[0] : rest, result, state, 'powershell');
  }
  if (EDITORS.has(base)) {
    const customGallery = base === 'codium' && [
      'VSCODE_GALLERY_SERVICE_URL', 'VSCODE_GALLERY_ITEM_URL', 'VSCODE_GALLERY_EXTENSION_URL_TEMPLATE',
    ].some((name) => environmentValues(state, name).some((value) => String(value ?? '').trim()));
    const marketplaceReason = ['code', 'code-insiders'].includes(base)
      ? 'installs from the Visual Studio Marketplace, which the guard does not review'
      : customGallery ? 'installs from a custom extension marketplace, which the guard does not review' : null;
    rest.forEach((a, j) => {
      if (a === '--install-extension' && rest[j + 1]) {
        const extension = rest[j + 1];
        if (marketplaceReason && !extension.endsWith('.vsix')) result.unreviewable.push({ manager: base, raw, reason: marketplaceReason });
        else vsxSpec(extension, base, result);
      } else if (a.startsWith('--install-extension=')) {
        const extension = a.slice('--install-extension='.length);
        if (marketplaceReason && !extension.endsWith('.vsix')) result.unreviewable.push({ manager: base, raw, reason: marketplaceReason });
        else vsxSpec(extension, base, result);
      }
    });
    return;
  }
  if (['npx', 'bunx', 'pnpx'].includes(base)) return runner(rest, base, result, raw, state, base);
  if (NPM_FAMILY.includes(base)) return npmFamily(base, rest, result, raw, state);
  if (/^pip(3(\.\d+)?)?$/.test(base)) {
    const values = valuesForManager('pip');
    const sub = positionals(rest, values)[0];
    if (sub === 'install' || sub === 'download') pipInstall(afterWord(rest, values, sub), 'pip', result, raw, state);
    else if (sub === 'wheel') pipInstall(afterWord(rest, values, sub), 'pip', result, raw, state);
    return;
  }
  if (base === 'pipenv') {
    const values = valuesForManager('pipenv');
    const sub = positionals(rest, values)[0];
    if (hasPackageLockBypass(base, sub, rest, state)) bulkUpgrade(result, base, raw);
    if (['install', 'upgrade', 'update'].includes(sub)) {
      const args = afterWord(rest, values, sub);
      const targetStart = result.targets.length;
      reviewPipFileOptions(pipFileOptions(args), result, base, raw, targetStart);
      const specs = positionals(args, values);
      if (['upgrade', 'update'].includes(sub) && !specs.length) bulkUpgrade(result, base, raw);
      else specs.forEach((spec) => pypiSpec(spec, base, result));
      reviewPipInstallerOptions(flagValuesWithPrefixes(args, '--extra-pip-args', base), result, base, raw, targetStart);
    } else if (sub === 'sync') {
      const args = afterWord(rest, values, sub);
      reviewPipInstallerOptions(flagValuesWithPrefixes(args, '--extra-pip-args', base), result, base, raw, result.targets.length);
    }
    return;
  }
  if (/^python(3(\.\d+)?)?$/.test(base)) {
    const m = rest.indexOf('-m');
    if (m !== -1 && rest[m + 1]) classifyChecked(rest.slice(m + 1), result, rest.slice(m + 1).join(' '), state);
    return;
  }
  if (base === 'uvx') {
    withPackages(rest, 'uvx', result);
    uvToolRun(rest, 'uvx', result, raw, state);
    return;
  }
  if (base === 'uv') {
    const values = valuesForManager('uv');
    const [sub, sub2] = positionals(rest, values);
    const after = (word) => afterWord(rest, values, word);
    withPackages(rest, 'uv', result);
    if (sub === 'pip' && ['install', 'download'].includes(sub2)) pipInstall(after(sub2), 'uv', result, raw, state);
    else if (sub === 'pip' && ['sync', 'compile'].includes(sub2)) bulkUpgrade(result, 'uv', raw);
    else if (sub === 'pip' && sub2 === 'wheel') pipInstall(after('wheel'), 'uv', result, raw, state);
    else if (sub === 'python' && ['install', 'upgrade'].includes(sub2)) result.unreviewable.push({ manager: 'uv', raw, reason: 'downloads a runtime release' });
    else if (sub === 'add') pipInstall(after('add'), 'uv', result, raw, state);
    else if (sub === 'tool' && sub2 === 'install') {
      const args = after('install');
      const from = flagValues(args, '--from');
      askForConflictingValues(from, '--from', 'uv', raw, result);
      const packages = from.length ? distinctValues(from) : [positionals(args, values)[0]].filter(Boolean);
      const targetStart = result.targets.length;
      packages.forEach((pkg) => pypiSpec(pkg, 'uv', result));
      reviewPipFileOptions(pipFileOptions(args), result, 'uv', raw, targetStart);
    }
    else if (sub === 'tool' && sub2 === 'run') {
      const args = after('run');
      uvToolRun(args, 'uv', result, raw, state);
    } else if (sub === 'tool' && sub2 === 'upgrade') {
      const args = after('upgrade');
      const tools = positionals(args, values);
      if (args.includes('--all') || flagValues(args, '--with-requirements').length) bulkUpgrade(result, 'uv', raw);
      else {
        const managerTools = tools.filter((pkg) => packageName(pkg) === 'uv');
        if (managerTools.length) result.unreviewable.push({ manager: 'uv', raw, reason: 'downloads a package manager release' });
        tools.filter((pkg) => !managerTools.includes(pkg)).forEach((pkg) => pypiSpec(pkg, 'uv', result));
      }
    } else if (['run', 'lock', 'sync'].includes(sub) && flagValuesWithPrefixes(rest, '--upgrade-group', 'uv').length) bulkUpgrade(result, 'uv', raw);
    else if (sub === 'run' && flagValues(rest, '--with-requirements', '--with-editable').length) bulkUpgrade(result, 'uv', raw);
    else if (sub === 'run' && flagValues(rest, '--upgrade-package', '-P').length) {
      flagValues(rest, '--upgrade-package', '-P').forEach((p) => pypiSpec(p, 'uv', result));
    } else if (sub === 'run' && rest.some((a) => ['--upgrade', '-U'].includes(a))) {
      bulkUpgrade(result, 'uv', raw);
    } else if ((sub === 'lock' || sub === 'sync') && flagValues(rest, '--upgrade-package', '-P').length) {
      flagValues(rest, '--upgrade-package', '-P').forEach((p) => pypiSpec(p, 'uv', result));
    } else if ((sub === 'lock' || sub === 'sync') && rest.some((a) => ['--upgrade', '-U'].includes(a))) bulkUpgrade(result, 'uv', raw);
    else if (sub === 'build') bulkUpgrade(result, 'uv', raw);
    else if (sub === 'self' && sub2 === 'update') result.unreviewable.push({ manager: 'uv', raw, reason: 'downloads a package manager release' });
    if (sub === 'run') {
      const parsed = commandAfterOptions(after('run'), RUNNER_VALUES.uvRun, RUNNER_FLAGS.uvRun);
      const installActionsBefore = state.installActions;
      classifyCommandReadings(parsed, result, raw, state, 'uv');
      askForEnvironmentInstall(result, state, installActionsBefore, 'uv', raw);
    }
    return;
  }
  if (base === 'pipx') {
    const values = valuesForManager('pipx');
    const [sub, ...pos] = positionals(rest, values);
    const args = afterWord(rest, values, sub);
    if (sub === 'interpreter' && pos[0] === 'upgrade') {
      result.unreviewable.push({ manager: 'pipx', raw, reason: 'downloads a runtime release' });
    } else if (['install', 'install-all', 'upgrade', 'reinstall', 'reinstall-all', 'repair', 'run'].includes(sub)
      && pipxMayDownloadPython(args)) result.unreviewable.push({ manager: 'pipx', raw, reason: 'downloads a runtime release' });
    if (sub === 'runpip') {
      const command = ['pip', ...args.slice(1)];
      classifyChecked(command, result, command.join(' '), state);
    }
    else if (sub === 'inject') {
      const targetStart = result.targets.length;
      pos.slice(1).forEach((p) => pypiSpec(p, 'pipx', result));
      reviewPipFileOptions(pipFileOptions(args), result, 'pipx', raw, targetStart);
      reviewPipInstallerOptions(flagValuesWithPrefixes(args, '--pip-args', 'pipx'), result, 'pipx', raw, targetStart);
    }
    else if (['install', 'run', 'exec', 'upgrade', 'reinstall'].includes(sub)) {
      const targetStart = result.targets.length;
      const runOptions = sub === 'run' ? runnerReadings(args, RUNNER_VALUES.pipxRun, RUNNER_FLAGS.pipxRun) : undefined;
      const specs = runOptions
        ? runOptions.readings.flatMap((reading) => {
          const selected = reading.options.filter(({ option }) => option === '--spec').map(({ value }) => value);
          askForConflictingValues(selected, '--spec', 'pipx', raw, result);
          return selected.length ? distinctValues(selected) : [reading.command[0]].filter(Boolean);
        })
        : (() => {
          const selected = flagValues(args, '--spec');
          askForConflictingValues(selected, '--spec', 'pipx', raw, result);
          return selected.length ? distinctValues(selected) : [pos[0]].filter(Boolean);
        })();
      const scriptFiles = sub === 'run' && !flagValues(args, '--spec').length
        ? specs.filter((spec) => /(?:^|[\\/])[^\\/]+\.py(?:$|[?#])/i.test(spec))
        : [];
      flagValues(args, '--preinstall').forEach((spec) => pypiSpec(spec, 'pipx', result));
      specs.filter((spec) => !scriptFiles.includes(spec)).forEach((spec) => pypiSpec(spec, 'pipx', result));
      if (sub === 'install' && flagValues(args, '--lock').length) bulkUpgrade(result, 'pipx', raw);
      if (scriptFiles.length) bulkUpgrade(result, 'pipx', raw);
      if (runOptions) {
        for (const reading of runOptions.readings) {
          if (!reading.command.length) continue;
          const addition = { targets: [], bulk: [], unreviewable: [] };
          classifyChecked(reading.command, addition, reading.command.join(' '), state);
          mergeFindings(result, addition);
        }
        runOptions.readings.flatMap((reading) => reading.options.filter(({ option }) => option === '--with').map(({ value }) => value))
          .filter(Boolean).forEach((spec) => pypiSpec(spec, 'pipx', result));
        if (runOptions.overflow) result.unreviewable.push({ manager: 'pipx', raw, reason: 'looks like an install the guard cannot parse' });
      }
      if (sub === 'upgrade' && args.includes('--include-injected')) bulkUpgrade(result, 'pipx', raw);
      reviewPipInstallerOptions(flagValuesWithPrefixes(args, '--pip-args', 'pipx'), result, 'pipx', raw, targetStart);
    } else if (['install-all', 'upgrade-all', 'reinstall-all', 'upgrade-shared'].includes(sub)) {
      bulkUpgrade(result, 'pipx', raw);
      reviewPipInstallerOptions(flagValuesWithPrefixes(args, '--pip-args', 'pipx'), result, 'pipx', raw, result.targets.length);
    }
  }
}

function configKeyValue(token) {
  const [key] = token.split('=', 1);
  return key.toLowerCase();
}

function hasRedirectConfigCommand(text, tokens = tokenize(text), shell = 'bash') {
  return segments(tokens).some((part) => {
    const i = commandPosition(part, shell);
    const base = commandBase(part[i] ?? '', shell);
    const args = part.slice(i + 1);
    const words = positionals(args, new Set());
    if (base === 'conda' && words[0] === 'config' && /--(?:add|append|prepend|remove|set)(?:\s+|=)(?:channels?|channel_alias|default_channels|custom_channels)\b/i.test(part.join(' '))) return true;
    if (base === 'dotnet' && words[0] === 'nuget' && ['add', 'update'].includes(words[1]) && words[2] === 'source') return true;
    if (base === 'poetry' && words[0] === 'source' && ['add', 'remove', 'priority'].includes(words[1])) return true;
    if (base === 'cargo' && flagValues(args, '--config').some((value) => /registr(?:y|ies)|source|replace-with|index/i.test(value))) return true;
    if (base === 'gem' && words[0] === 'sources' && args.some((arg) => ['--add', '--remove', '--clear'].includes(arg))) return true;
    if (['bundle', 'bundler'].includes(base) && words[0] === 'config' && ['set', 'unset', 'delete'].includes(words[1]) && /^mirror\./i.test(words[2] ?? '')) return true;
    if (base === 'composer' && words[0] === 'config' && /^repositories\./i.test(words[1] ?? '')) return true;
    if (base === 'go' && ((words[0] === 'env' && args.includes('-w') && words.slice(1).some((word) => /^(?:GOPROXY|GOPRIVATE|GONOSUMDB|GOFLAGS)(?:=|$)/i.test(word)))
      || part.some((arg) => /^(?:GOPROXY|GOPRIVATE|GONOSUMDB|GOFLAGS)=/i.test(arg)))) return true;
    const manager = NPM_FAMILY.includes(base) ? base : /^pip(3(\.\d+)?)?$/.test(base ?? '') ? 'pip' : null;
    if (!manager) return false;
    const pos = positionals(part.slice(i + 1), valueSet[manager] ?? valueSet.py);
    let key;
    if (['npm', 'pnpm'].includes(manager) && pos[0] === 'set' && pos[1]) key = pos[1];
    else if (manager !== 'bun' && pos[0] === 'config' && pos[1] === 'set' && pos[2]) key = pos[2];
    else if (['npm', 'pnpm'].includes(manager) && pos[0] === 'c' && pos[1] === 'set' && pos[2]) key = pos[2];
    if (!key) return false;
    key = configKeyValue(key);
    return /registry|index|find[-_.]?links|userconfig|globalconfig|config[-_.]?file/i.test(key);
  });
}

function hasKnownInlineCode(argv, shell = 'bash') {
  const i = commandPosition(argv, shell);
  const base = commandBase(argv[i] ?? '', shell);
  const args = argv.slice(i + 1);
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(base)) return args.some((a) => a === '-c' || (a.startsWith('-c') && a.length > 2));
  if (base === 'bun') return args.some((a) => a === '-e' || (a.startsWith('-e') && a.length > 2));
  return false;
}

const BUN_CODE_VALUES = new Set([
  '--eval', '-e', '--print', '-p', '--elide-lines', '--filter', '-F', '--shell', '--title',
  '--unhandled-rejections', '--console-depth', '--watch-kill-signal', '--preload', '-r', '--require', '--import',
  '--conditions', '--main-fields', '--extension-order', '--tsconfig-override', '--define', '-d', '--drop', '--loader', '-l',
  '--jsx-factory', '--jsx-fragment', '--jsx-import-source', '--jsx-runtime', '--port', '--fetch-preconnect',
  '--max-http-header-size', '--dns-result-order', '--user-agent', '--env-file', '--cwd', '--config', '-c',
  '--timeout', '--rerun-each', '--retry', '--seed', '--max-concurrency', '--environment', '--globals',
  '--test-name-pattern', '-t', '--reporter', '--reporter-outfile', '--reporter-junit-suites', '--coverage-reporter',
  '--coverage-dir',
]);
const BUN_OPTIONAL_VALUES = new Set([
  '--inspect', '--inspect-wait', '--inspect-brk', '--install', '--bail', '--shard', '--timings',
]);
const BUN_FLAGS = new Set([
  '--silent', '--if-present', '--help', '-h', '--workspaces', '--parallel', '--sequential', '--no-exit-on-error',
  '--bun', '-b', '--interactive', '--smol', '--aot', '--aot-log-type-mismatches', '--aot-allow-code-from-disk',
  '--expose-gc', '--no-deprecation', '--throw-deprecation', '--zero-fill-buffers', '--no-addons', '--no-ffi-cc',
  '--check', '--watch', '--hot', '--no-clear-screen', '--no-install', '-i', '--prefer-offline', '--prefer-latest',
  '--preserve-symlinks', '--preserve-symlinks-main', '--no-macros', '--jsx-side-effects', '--ignore-dce-annotations',
  '--use-system-ca', '--use-openssl-ca', '--use-bundled-ca', '--redis-preconnect', '--sql-preconnect', '--concurrent',
  '--randomize', '--react-compiler', '--todo', '--dots', '--coverage', '--update-snapshots', '-u', '--no-isolate',
  '--update-timings',
]);
const BUN_MODULE_VALUES = new Set(['--preload', '-r', '--require', '--import', '--jsx-import-source']);
const BUN_EVAL_VALUES = new Set(['-e', '--eval', '-p', '--print']);
const BUN_NON_RUNTIME_COMMANDS = new Set([
  'install', 'i', 'add', 'a', 'update', 'up', 'remove', 'rm', 'uninstall', 'link', 'unlink', 'x', 'create',
  'init', 'upgrade', 'audit', 'outdated', 'why', 'info', 'publish', 'pack', 'patch', 'pm', 'build',
]);

function isBunEvalOption(arg) {
  return BUN_EVAL_VALUES.has(arg) || /^-(?:e|p).+/.test(arg) || /^--(?:eval|print)=/.test(arg);
}

function bunRuntimeArgs(argv, shell) {
  const i = commandPosition(argv, shell);
  if (commandBase(argv[i] ?? '', shell) !== 'bun') return undefined;
  let args = argv.slice(i + 1);
  if (args[0] === 'run' || args[0] === 'repl') args = args.slice(1);
  return args;
}

function bunRuntimeCommand(argv, shell) {
  const index = commandPosition(argv, shell);
  if (commandBase(argv[index] ?? '', shell) !== 'bun') return false;
  const args = argv.slice(index + 1);
  const options = scanBunOptions(argv, shell);
  if (options?.hasInlineCode) return true;
  const action = positionals(args, BUN_CODE_VALUES)[0];
  if (action === undefined) return !args.some((arg) => ['--help', '-h', '--version', '-v', '--revision'].includes(arg));
  return !BUN_NON_RUNTIME_COMMANDS.has(action);
}

function bunArgumentsWithEnvironment(argv, state, result, raw) {
  const index = commandPosition(argv, state.shell);
  const options = [];
  const bunOptionsValues = environmentValues(state, 'BUN_OPTIONS');
  const installSettings = [];
  for (const bunOptions of bunOptionsValues) {
    const parsed = safelyTokenizeArgumentEnvironment(String(bunOptions), state.shell);
    if (!parsed) {
      if (bunRuntimeCommand(argv, state.shell)) {
        result.unreviewable.push({ manager: 'bun', raw, reason: 'Bun runtime options from BUN_OPTIONS cannot be read statically' });
        return undefined;
      }
    } else {
      const installValues = booleanOptionValues(parsed, 'install');
      installSettings.push(installValues.length > 0 && !installValues.includes(true) && !parsed.includes('-i'));
      options.push(...parsed);
    }
  }
  if (hasConflictingValues(installSettings)) options.push('--install=auto');
  for (const inspectPreload of environmentValues(state, 'BUN_INSPECT_PRELOAD')) {
    if (String(inspectPreload) === '') continue;
    if (hasShellExpansion(String(inspectPreload), state.shell)) {
      if (bunRuntimeCommand(argv, state.shell)) {
        result.unreviewable.push({ manager: 'bun', raw, reason: 'Bun runtime preload from BUN_INSPECT_PRELOAD cannot be read statically' });
        return undefined;
      }
    } else options.push('--preload', String(inspectPreload));
  }
  return [...argv.slice(0, index + 1), ...options, ...argv.slice(index + 1)];
}

function scanBunOptions(argv, shell) {
  const args = bunRuntimeArgs(argv, shell);
  if (!args) return undefined;
  const moduleValues = [];
  let code;
  let hasInlineCode = false;
  let optionEnd = args.length;
  let trailingStart = args.length;
  const pending = [0];
  const visited = new Set();
  while (pending.length) {
    let i = pending.pop();
    if (visited.has(i)) continue;
    visited.add(i);
    while (i < args.length) {
      const arg = args[i];
      const match = /^(--eval|--print)=([\s\S]*)$/.exec(arg);
      if (match) {
        if (!hasInlineCode) code = match[2];
        hasInlineCode = true;
        optionEnd = i;
        trailingStart = i + 1;
        break;
      }
      if (BUN_EVAL_VALUES.has(arg)) {
        if (!hasInlineCode) code = args[i + 1];
        hasInlineCode = true;
        optionEnd = i;
        trailingStart = i + 2;
        break;
      }
      if (/^-e.+/.test(arg) || /^-p.+/.test(arg)) {
        if (!hasInlineCode) code = arg.slice(2);
        hasInlineCode = true;
        optionEnd = i;
        trailingStart = i + 1;
        break;
      }
      if (arg === '--') {
        optionEnd = i;
        trailingStart = i + 1;
        break;
      }
      if (arg.startsWith('-')) {
        const equal = arg.indexOf('=');
        const option = equal > 0 ? arg.slice(0, equal) : arg;
        if (BUN_MODULE_VALUES.has(option)) {
          const value = equal > 0 ? arg.slice(equal + 1) : isBunEvalOption(args[i + 1] ?? '') ? undefined : args[i + 1];
          if (value !== undefined) moduleValues.push(value);
          if (equal > 0) {
            i++;
            continue;
          }
        }
        if (equal > 0 || BUN_OPTIONAL_VALUES.has(option) || BUN_FLAGS.has(option)) {
          i++;
          continue;
        }
        if (BUN_CODE_VALUES.has(option)) {
          i += isBunEvalOption(args[i + 1] ?? '') ? 1 : 2;
          continue;
        }
        pending.push(i + 1);
        if (args[i + 1] !== undefined && !isBunEvalOption(args[i + 1])) pending.push(i + 2);
        break;
      }
      if (['run', 'test', 'repl'].includes(arg)) {
        i++;
        continue;
      }
      optionEnd = i;
      trailingStart = i + 1;
      break;
    }
  }
  for (let i = trailingStart; i < args.length; i++) {
    const arg = args[i];
    const equal = arg.indexOf('=');
    const option = equal > 0 ? arg.slice(0, equal) : arg;
    if (!BUN_MODULE_VALUES.has(option)) continue;
    const value = equal > 0 ? arg.slice(equal + 1) : args[i + 1];
    if (value !== undefined) moduleValues.push(value);
    if (equal < 0 && value !== undefined) i++;
  }
  const runtimeArgs = args.slice(0, optionEnd);
  const installValues = booleanOptionValues(runtimeArgs, 'install');
  const noInstall = installValues.length > 0 && !installValues.includes(true) && !runtimeArgs.includes('-i');
  return { code, hasInlineCode, moduleValues, noInstall };
}

function bunInlineInvocation(argv, shell, options = scanBunOptions(argv, shell)) {
  if (!options) return undefined;
  if (options.hasInlineCode) return { code: options.code, noInstall: options.noInstall };
  const commandIndex = commandPosition(argv, shell);
  if (commandBase(argv[commandIndex] ?? '', shell) === 'bun' && argv[commandIndex + 1] === 'repl') {
    return { code: undefined, noInstall: options.noInstall };
  }
  return undefined;
}

function classifyBunModuleOptions(options, result, raw) {
  if (!options || options.noInstall) return;
  const reported = new Set();
  for (const value of options.moduleValues) {
    if (isBarePackageSpecifier(value) && !reported.has(value)) {
      reported.add(value);
      result.unreviewable.push({ manager: 'bun', raw, reason: `Bun auto-install may download ${value}` });
    }
  }
}

function bunStdinInvocation(argv, shell = 'bash') {
  const i = commandPosition(argv, shell);
  if (commandBase(argv[i] ?? '', shell) !== 'bun') return false;
  const args = argv.slice(i + 1);
  return args[0] === '-' || args[0] === 'run' && args[1] === '-';
}

function markBunStdinHandled(state, argv) {
  const key = argv.join(' ');
  state.bunStdinHandled ??= new Map();
  state.bunStdinHandled.set(key, (state.bunStdinHandled.get(key) ?? 0) + 1);
}

function isBarePackageSpecifier(specifier) {
  return !!specifier && !['./', '../', '/', '#', 'node:', 'bun:'].some((prefix) => specifier.startsWith(prefix))
    && !/^[A-Za-z]:[\\/]/.test(specifier)
    && !/^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier)
    && !isBuiltin(specifier);
}

function bunCodeTokens(code) {
  const tokens = [];
  for (let i = 0; i < code.length;) {
    if (/\s/.test(code[i])) {
      i++;
      continue;
    }
    if (code.startsWith('//', i)) {
      i = code.indexOf('\n', i + 2);
      if (i < 0) break;
      continue;
    }
    if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (['"', "'", '`'].includes(code[i])) {
      const quote = code[i++];
      let value = '';
      let dynamic = false;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < code.length) {
          value += code[i + 1];
          i += 2;
        } else {
          if (quote === '`' && code.startsWith('${', i)) dynamic = true;
          value += code[i++];
        }
      }
      if (i < code.length) i++;
      tokens.push({ type: dynamic ? 'dynamic' : 'string', value });
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
    if (word) {
      tokens.push({ type: 'word', value: word[0] });
      i += word[0].length;
      continue;
    }
    tokens.push({ type: 'punct', value: code[i++] });
  }
  return tokens;
}

function bunCodeReason(code) {
  const tokens = bunCodeTokens(code);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.value === 'import' && tokens[i + 1]?.value === '(' || token.value === 'require' && tokens[i + 1]?.value === '(') {
      const argument = tokens[i + 2];
      if (argument?.type === 'string' && tokens[i + 3]?.value === ')') {
        if (isBarePackageSpecifier(argument.value)) return `Bun auto-install may download ${argument.value}`;
      } else return 'Bun auto-install may download a package referenced by non-static code';
      continue;
    }
    if (token.value !== 'import') continue;
    if (tokens[i + 1]?.type === 'string') {
      if (isBarePackageSpecifier(tokens[i + 1].value)) return `Bun auto-install may download ${tokens[i + 1].value}`;
      continue;
    }
    for (let j = i + 1; j < tokens.length && j < i + 48 && tokens[j].value !== ';'; j++) {
      if (tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
        if (isBarePackageSpecifier(tokens[j + 1].value)) return `Bun auto-install may download ${tokens[j + 1].value}`;
        break;
      }
      if (['import', 'export', 'const', 'let', 'var', 'function', 'class'].includes(tokens[j].value)) break;
    }
  }
  return undefined;
}

function classifyBunCode(code, argv, staticCode, result, state, raw) {
  const noInstall = scanBunOptions(argv, state.shell)?.noInstall ?? false;
  if (!staticCode) {
    if (!noInstall) result.unreviewable.push({ manager: 'bun', raw, reason: 'Bun auto-install may download packages from code that cannot be read statically' });
    return;
  }
  const reason = noInstall ? undefined : bunCodeReason(code ?? '');
  if (reason) result.unreviewable.push({ manager: 'bun', raw, reason });
  else if (INSTALL_INTENT.test(code ?? '')) result.unreviewable.push({ manager: 'bun', raw, reason: 'inline interpreter code mentions an install' });
}

function isConfigPath(path) {
  const value = path.replace(/^['"]|['"]$/g, '').replace(/[;,)]$/, '');
  return CONFIG_FILE_PATH.test(value) || PNPM_CONFIG_PATH.test(value);
}

function hasOutputRedirect(part) {
  return part.some((token) => /^\d*(?:>>?|>\|)/.test(token));
}

function hasOutputOption(part) {
  return part.some((token) => token === '-o' || (token.startsWith('-o') && token.length > 2) || token === '--output' || token.startsWith('--output='));
}

function isConfigReadOnlyWithoutRedirect(part, shell = 'bash') {
  if (hasOutputRedirect(part) || hasOutputOption(part)) return false;
  const i = commandPosition(part, shell);
  const base = commandBase(part[i] ?? '', shell);
  if (CONFIG_READ_ONLY.has(base)) return true;
  if (base !== 'git') return false;
  const args = part.slice(i + 1);
  if (args.some((arg) => arg === '-c' || arg.startsWith('-c'))) return false;
  const subcommand = positionals(args, new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']))[0];
  return ['diff', 'log', 'show', 'status'].includes(subcommand);
}

function hasConfigFileReference(text, tokens = tokenize(text), shell = 'bash') {
  return segments(tokens).some((part) => {
    const configEnvironment = /(?:^|\s)(?:\$env:|\$\{env:)?(?:NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG)|PNPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|CONFIG_DIR|NPMRC_AUTH_FILE)|PIP_CONFIG_FILE|UV_CONFIG_FILE|COREPACK_ENV_FILE|YARN_RC_FILENAME|PIPENV_PIPFILE)\s*=/i.test(part.join(' '));
    return !configEnvironment && !isConfigReadOnlyWithoutRedirect(part, shell) && part.some(isConfigPath);
  });
}

function isNonExecutingCommand(argv, shell = 'bash') {
  const i = commandPosition(argv, shell);
  const base = commandBase(argv[i] ?? '', shell);
  if (NON_EXECUTING_COMMANDS.has(base)) return true;
  if (base !== 'git') return false;
  const args = argv.slice(i + 1);
  if (args.some((arg) => arg === '-c' || arg.startsWith('-c'))) return false;
  const subcommand = positionals(args, new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']))[0];
  return ['commit', 'log', 'show', 'diff', 'grep', 'tag'].includes(subcommand);
}

function hasExpansionForToken(value, shell, source) {
  return tokenize(source, true, shell).some((token) => token.value === value
    && hasShellExpansion(source.slice(token.start, token.end), shell));
}

function hasExpandedCommandBasename(command, shell, source) {
  const basename = command.split(shell === 'powershell' ? /[\\/]/ : '/').at(-1) ?? '';
  return hasExpansionForToken(command, shell, source) && hasShellExpansion(basename, shell);
}

function hasProcessSubstitution(text, shell) {
  if (shell === 'powershell') return false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      continue;
    }
    if (!quote && (ch === "'" || ch === '"')) {
      quote = ch;
      continue;
    }
    if ((ch === '<' || ch === '>') && text[i + 1] === '(') return true;
  }
  return false;
}

function hasPathExpansion(text, shell) {
  if (shell === 'powershell') return false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      continue;
    }
    if (!quote && (ch === "'" || ch === '"')) {
      quote = ch;
      continue;
    }
    if (quote) continue;
    if (ch === '*' || ch === '?') return true;
    if (ch === '[' && text.indexOf(']', i + 1) > i + 1) return true;
    if (ch === '{') {
      const end = text.indexOf('}', i + 1);
      if (end > i + 1 && /,|\.\./.test(text.slice(i + 1, end))) return true;
    }
    if (ch === '~' && i === 0 && (text[i + 1] === '/' || text[i + 1] === undefined)) return true;
  }
  return false;
}

const SUPPORTED_EXPANDED_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'pip', 'pip3', 'uv', 'uvx', 'pipx', 'pipenv', 'corepack', 'deno']);

const POWERSHELL_ALIAS_COMMANDS = new Set(['set-alias', 'new-alias', 'sal', 'nal']);

function managerPrefix(words, shell) {
  return supportedManagerInvocations(words, shell).size > 0;
}

function recordManagerVariables(tokens, shell, state) {
  for (const part of segments(tokens)) {
    if (shell === 'powershell') {
      const assignment = /^\$([A-Za-z_]\w*)\s*=\s*(.+)$/i.exec(part.join(' '));
      if (assignment) {
        const value = assignment[2].trim();
        const words = tokenize(value, false, shell);
        const name = assignment[1].toLowerCase();
        if (words.length && !hasShellExpansion(value, shell)) state.literalVariables.set(name, words);
        if (managerPrefix(words, shell)) state.managerVariables.set(name, commandBase(words[commandPosition(words, shell)] ?? '', shell));
      }
      const base = (part[0] ?? '').toLowerCase();
      if (POWERSHELL_ALIAS_COMMANDS.has(base)) {
        const args = part.slice(1);
        let name;
        let value;
        const positional = [];
        for (let i = 0; i < args.length; i++) {
          const arg = args[i].toLowerCase();
          if (['-name', '-value', '-definition'].includes(arg) && args[i + 1] !== undefined) {
            if (arg === '-name') name = args[++i];
            else if (arg === '-value' || arg === '-definition') value = args[++i];
          } else if (!arg.startsWith('-')) positional.push(args[i]);
        }
        name ??= positional[0];
        value ??= positional[1];
        if (name && value !== undefined) state.commandAliases.set(name.toLowerCase(), {
          words: tokenize(value, false, shell),
          dynamic: hasShellExpansion(value, shell),
        });
      }
      continue;
    }
    if (part[0] === 'alias') {
      for (const arg of part.slice(1)) {
        const equals = arg.indexOf('=');
        if (equals <= 0) continue;
        const name = arg.slice(0, equals);
        const value = arg.slice(equals + 1);
        state.commandAliases.set(name, { words: tokenize(value, false, shell), dynamic: hasShellExpansion(value, shell) });
      }
    }
    for (const arg of part) {
      const match = /^([A-Za-z_]\w*)=(.*)$/.exec(arg);
      if (!match) break;
      const [, name, value] = match;
      const words = tokenize(value, false, shell);
      if (words.length && !hasShellExpansion(value, shell)) state.literalVariables.set(name, words);
      if (managerPrefix(words, shell)) state.managerVariables.set(name, commandBase(words[commandPosition(words, shell)] ?? '', shell));
    }
  }
}

function variableName(value, shell) {
  const match = shell === 'powershell'
    ? /^\$\{?([A-Za-z_]\w*)\}?$/i.exec(value)
    : /^\$\{?([A-Za-z_]\w*)\}?$/.exec(value);
  return match ? (shell === 'powershell' ? match[1].toLowerCase() : match[1]) : undefined;
}

function resolveBoundCommand(argv, shell, state) {
  const index = commandPosition(argv, shell);
  const command = argv[index] ?? '';
  const key = shell === 'powershell' ? command.toLowerCase() : command;
  const alias = state.commandAliases.get(key);
  let prefix = alias?.words;
  let unresolvedAlias = alias?.dynamic && !managerPrefix(prefix ?? [], shell);
  const name = variableName(command, shell);
  if (!prefix && name && state.literalVariables.has(name)) {
    const value = state.literalVariables.get(name);
    if (managerPrefix(value, shell)) prefix = value;
  }
  if (!prefix) return { argv, unresolvedAlias };
  return { argv: [...argv.slice(0, index), ...prefix, ...argv.slice(index + 1)], unresolvedAlias };
}

function potentialInstallAction(argv, shell) {
  const args = argv.slice(commandPosition(argv, shell) + 1);
  const action = args.find((arg) => !arg.startsWith('-')) ?? '';
  return hasShellExpansion(action, shell) || /^(?:i|in|ins|inst|insta|install|add|a|update|up|upgrade|dlx|exec|x|create|init|inject|global|tool)$/i.test(action);
}

function expandedManagerName(command, shell, state) {
  const match = shell === 'powershell'
    ? /^\$\{?([A-Za-z_]\w*)\}?$/i.exec(command)
    : /^\$\{?([A-Za-z_]\w*)\}?$/.exec(command);
  return match ? state.managerVariables.get(shell === 'powershell' ? match[1].toLowerCase() : match[1]) : undefined;
}

function hasExpandedManagerAction(argv, shell, source, state) {
  const i = commandPosition(argv, shell);
  const command = argv[i] ?? '';
  const base = commandBase(command, shell);
  const rest = argv.slice(i + 1);
  if (hasExpandedCommandBasename(command, shell, source)) {
    const actions = positionals(rest, ALL_VALUE_OPTIONS);
    const action = actions[0];
    if (action === undefined || hasExpansionForToken(action, shell, source)) return false;
    const verb = action.toLowerCase();
    if (verb === 'pip' && actions[1]?.toLowerCase() === 'install'
      && !hasExpansionForToken(actions[1], shell, source)) return true;
    if (['install', 'i', 'add', 'ci', 'update', 'upgrade', 'up', 'sync', 'dlx', 'x'].includes(verb)) return true;
    const manager = expandedManagerName(command, shell, state);
    return verb === 'exec' && ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'corepack'].includes(manager);
  }
  let selectors = [];
  if (NPM_FAMILY.includes(base)) selectors = [positionals(rest, valueSet[base])[0]];
  else if (/^pip(3(\.\d+)?)?$/.test(base) || base === 'pipenv' || base === 'deno') {
    const values = base === 'deno' ? valuesForManager('deno') : valuesForManager(base);
    selectors = [positionals(rest, values)[0]];
  } else if (base === 'uv') {
    const words = positionals(rest, valuesForManager('uv'));
    selectors = [words[0]];
    if (['pip', 'tool'].includes(words[0])) selectors.push(words[1]);
    if (words[0] === 'run') {
      const parsed = runnerReadings(afterWord(rest, valuesForManager('uv'), 'run'), RUNNER_VALUES.uvRun, RUNNER_FLAGS.uvRun);
      selectors.push(...parsed.readings.map((reading) => reading.command[0]));
    }
    if (words[0] === 'tool' && words[1] === 'run') {
      const parsed = runnerReadingsFor('uvToolRun', afterWord(rest, valuesForManager('uv'), 'run'));
      selectors.push(...parsed.readings.map((reading) => reading.command[0]));
      selectors.push(...parsed.readings.flatMap((reading) => reading.options.filter(({ option }) => option === '--from').map(({ value }) => value)));
    }
  } else if (base === 'pipx') {
    const values = valuesForManager(base);
    const sub = positionals(rest, values)[0];
    selectors = [sub];
    if (sub === 'run') {
      const parsed = runnerReadings(afterWord(rest, values, sub), RUNNER_VALUES.pipxRun, RUNNER_FLAGS.pipxRun);
      selectors.push(...parsed.readings.map((reading) => reading.command[0]));
      selectors.push(...parsed.readings.flatMap((reading) => reading.options.filter(({ option }) => option === '--spec').map(({ value }) => value)));
    }
  } else if (/^python(3(\.\d+)?)?$/.test(base)) {
    const module = rest.indexOf('-m');
    if (module >= 0 && rest[module + 1] !== undefined) {
      selectors = [rest[module + 1]];
      if (/^pip(3(\.\d+)?)?$/.test(commandBase(rest[module + 1], shell))) selectors.push(positionals(rest.slice(module + 2), valuesForManager('pip'))[0]);
    }
  } else if (['npx', 'bunx', 'pnpx'].includes(base)) {
    const runnerName = base;
    const parsed = runnerReadingsFor(runnerName, rest);
    selectors = [
      ...parsed.readings.map((reading) => reading.command[0]),
      ...parsed.readings.flatMap((reading) => reading.options.filter(({ option }) => runnerCalls(runnerName).includes(option)).map(({ value }) => value)),
    ];
  } else if (base === 'uvx') {
    const parsed = runnerReadingsFor('uvx', rest);
    selectors = parsed.readings.map((reading) => reading.command[0]);
    selectors.push(...parsed.readings.flatMap((reading) => reading.options.filter(({ option }) => option === '--from').map(({ value }) => value)));
  }
  return selectors.some((selector) => selector !== undefined && hasExpansionForToken(selector, shell, source));
}

function hasExpandedInstallTarget(argv, shell, source) {
  const i = commandPosition(argv, shell);
  const manager = commandBase(argv[i] ?? '', shell);
  if (!NPM_FAMILY.includes(manager)) return false;
  const values = valueSet[manager];
  const rest = argv.slice(i + 1);
  let sub = positionals(rest, values)[0];
  let args = afterWord(rest, values, sub);
  if (manager === 'yarn' && sub === 'global') {
    const globalArgs = positionals(args, values);
    sub = globalArgs[0];
    args = afterWord(args, values, sub);
  }
  if (!NPM_VERBS.install[manager].includes(sub) && !NPM_VERBS.update[manager].includes(sub)) return false;
  return positionals(args, values).some((target) => hasExpansionForToken(target, shell, source));
}

function isManagerCommandSegment(argv, shell, state, source, depth = 0) {
  if (!argv.length || depth > 4) return false;
  const binding = resolveBoundCommand(argv, shell, state);
  if (binding.argv !== argv && (binding.argv.length !== argv.length || binding.argv.some((arg, i) => arg !== argv[i]))) {
    return isManagerCommandSegment(binding.argv, shell, state, source, depth + 1);
  }
  if (binding.unresolvedAlias && potentialInstallAction(argv, shell)) return true;
  if (supportedManagerInvocations(argv, shell).size) return !managerHasInstallReading(argv, shell);
  if (unknownCommandWrapsManager(argv, shell)) return true;
  if (hasExpandedManagerAction(argv, shell, source, state) || hasExpandedInstallTarget(argv, shell, source)) return true;
  const index = commandPosition(argv, shell);
  const command = argv[index];
  return Boolean(command && hasExpandedCommandBasename(command, shell, source)
    && isManagerCommandSegment(argv.slice(index + 1), shell, state, source, depth + 1));
}

function hasInstallIntentForSegment(value, shell) {
  if (shell === 'powershell') return POWERSHELL_INSTALL_INTENT.test(value);
  value = value.replace(/\bpnpm\s+exec(?:\s+--)?\s+([A-Za-z0-9_./-]+)(?=\s|$)/gi, (match, word) => {
    const child = commandBase(word, shell);
    const manager = NPM_FAMILY.includes(child) || ['npx', 'pnpx', 'bunx', 'pip', 'pipx', 'pipenv', 'uv', 'uvx'].includes(child);
    return manager || SHELLS.has(child) || WRAPPERS.has(child) ? match : match.replace(/\bexec\b/i, 'run');
  });
  return INSTALL_INTENT.test(value);
}

function hasUnclassifiedInstallIntent(command, shell, state) {
  const { rest, scripts, bodies } = splitHeredocs(command, shell);
  const hasIntent = (value) => (shell === 'powershell' ? POWERSHELL_INSTALL_INTENT : INSTALL_INTENT).test(value);
  const spans = tokenize(rest, true, shell);
  let part = [];
  let found = false;
  const inspect = () => {
    if (!part.length) return;
    const argv = part.map((token) => token.value);
    const raw = rest.slice(part[0].start, part.at(-1).end);
    if (managerHasInstallReading(argv, shell)
      || (!isManagerCommandSegment(argv, shell, state, raw) && hasInstallIntentForSegment(raw, shell))) found = true;
    part = [];
  };
  for (const token of spans) {
    if (SEPARATORS.has(token.value)) inspect();
    else part.push(token);
  }
  inspect();
  for (const body of bodies) {
    if (scripts.includes(body)) {
      if (hasUnclassifiedInstallIntent(body, shell, state)) found = true;
    } else if (hasIntent(body)) found = true;
  }
  for (const substitution of substitutions(rest, shell)) {
    if (hasUnclassifiedInstallIntent(substitution, shell, state)) found = true;
  }
  return found;
}

function unknownCommandWrapsManager(argv, shell) {
  const i = commandPosition(argv, shell);
  const command = argv[i] ?? '';
  const base = commandBase(command, shell);
  const basename = command.split(shell === 'powershell' ? /[\\/]/ : '/').at(-1) ?? '';
  const args = argv.slice(i + 1);
  const manager = commandBase(args[0] ?? '', shell);
  const supported = NPM_FAMILY.includes(manager)
    || ['npx', 'bunx', 'pnpx', 'uv', 'uvx', 'pipx', 'pipenv', 'deno', 'corepack'].includes(manager)
    || /^pip(3(\.\d+)?)?$/.test(manager)
    || (/^python(3(\.\d+)?)?$/.test(manager)
      && args[1] === '-m' && /^pip(3(\.\d+)?)?$/.test(commandBase(args[2] ?? '', shell)));
  return command && !(shell === 'powershell' && base === 'start-process')
    && !isKnown(base, shell) && !UNREVIEWED_MANAGERS.has(base)
    && !isNonExecutingCommand(argv, shell) && !hasShellExpansion(basename, shell)
    && supported && !hasShellExpansion(args[0], shell);
}

function opaqueExecutionSegment(argv, shell, state, source) {
  const resolved = resolveBoundCommand(argv, shell, state).argv;
  const index = commandPosition(resolved, shell);
  const command = resolved[index] ?? '';
  const base = commandBase(command, shell);
  const args = resolved.slice(index + 1);
  const spans = tokenize(source, true, shell);
  const hasOpaqueExpansion = (value) => hasShellExpansion(value, shell) || hasProcessSubstitution(value, shell);
  let wrapperIndex = 0;
  while (wrapperIndex < index) {
    const wrapper = commandBase(resolved[wrapperIndex] ?? '', shell);
    if (!WRAPPERS.has(wrapper)) break;
    const commandIndex = wrappedCommandPosition(resolved, wrapperIndex, shell);
    if (['exec', 'command', 'builtin'].includes(wrapper)) {
      if (wrapper === 'command' && resolved.slice(wrapperIndex + 1, commandIndex).some((arg) => ['-v', '-V', '--verbose', '--version'].includes(arg))) return false;
      for (let j = wrapperIndex + 1; j < commandIndex; j++) {
        const arg = resolved[j];
        if (arg === '--') break;
        if (arg.startsWith('-') && !knownWrapperOption(wrapper, arg)) {
          return resolved.slice(j + 1).some((value, offset) => {
            const span = spans[j + 1 + offset];
            const raw = span?.start === undefined ? value : source.slice(span.start, span.end);
            return hasOpaqueExpansion(raw) || hasPathExpansion(raw, shell);
          });
        }
        const option = wrapperValueOption(arg, WRAPPER_VALUE_OPTIONS[wrapper] ?? []);
        if (option && wrapperValueConsumesNext(wrapper, arg, option)) j++;
      }
    }
    wrapperIndex = commandIndex;
  }
  if (['source', '.'].includes(base)) {
    let file = index + 1;
    let unknownOption = false;
    while (file < resolved.length && resolved[file].startsWith('-') && resolved[file] !== '--') {
      if (resolved[file] === '-p') file += 2;
      else if (resolved[file].startsWith('-p') && resolved[file].length > 2) file++;
      else {
        unknownOption = true;
        break;
      }
    }
    if (unknownOption) return resolved.slice(file + 1).some((value, offset) => {
      const span = spans[file + 1 + offset];
      const raw = span?.start === undefined ? value : source.slice(span.start, span.end);
      return hasOpaqueExpansion(raw) || hasPathExpansion(raw, shell);
    });
    if (resolved[file] === '--') file++;
    if (file >= resolved.length) return false;
    const raw = spans[file]?.start === undefined ? resolved[file] : source.slice(spans[file].start, spans[file].end);
    const fileSource = spans[file]?.start === undefined ? raw : source.slice(spans[file].start, spans[file].end);
    return hasOpaqueExpansion(fileSource) || hasPathExpansion(fileSource, shell);
  }
  if (base === 'eval') return args.some(hasOpaqueExpansion);
  if (SHELLS.has(base)) {
    const code = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
    return code >= 0 && args[code + 1] !== undefined && hasOpaqueExpansion(args[code + 1]);
  }
  if (powerShellExecutable(command, shell)) {
    const code = args.findIndex(powerShellCommandOption);
    return code >= 0 && args.length > code + 1 && hasOpaqueExpansion(args.slice(code + 1).join(' '));
  }
  if (shell === 'powershell' && ['iex', 'invoke-expression'].includes(base)) {
    return args.some(hasOpaqueExpansion);
  }
  if (!command || !hasExpandedCommandBasename(command, shell, source)) return false;
  return !hasLaterShellOrManager(resolved, index + 1, shell, '');
}

function runnerOwnOptions(argv, shell) {
  const index = commandPosition(argv, shell);
  const base = commandBase(argv[index] ?? '', shell);
  const normalizeScopedRegistry = (args) => args.map((arg) => arg.replace(/^--@[^=]+:registry(?==|$)/, '--registry'));
  const rest = normalizeScopedRegistry(argv.slice(index + 1));
  const envFileWrapper = envFileWrapperArgs(base, rest);
  if (envFileWrapper) return ['--env-file'];
  if (base === 'poetry' && rest[0] === 'run') return [];
  const options = new Set();
  let foundRunner = false;
  const addOptions = (parsed) => parsed?.readings.flatMap(({ options: found }) => found.map(({ option }) => option)).forEach((option) => options.add(option));
  const addRunnerOptions = (args, name) => addOptions(runnerReadingsFor(name, args));
  const runnerName = (manager, sub) => manager === 'npm' && ['exec', 'x'].includes(sub) ? 'npmExec'
    : manager === 'pnpm' && sub === 'dlx' ? 'pnpmDlx'
      : manager === 'pnpm' && sub === 'exec' ? 'pnpmExec'
        : manager === 'yarn' && sub === 'dlx' ? 'yarnDlx'
          : manager === 'yarn' && sub === 'exec' ? 'yarnExec'
            : manager === 'bun' && sub === 'x' ? 'bunX'
              : manager === 'bun' && sub === 'run' ? 'bunRun'
                : manager === 'bun' && sub === 'exec' ? 'bunExec' : undefined;
  const globalReadings = (manager) => runnerReadings(rest, valuesForManager(manager));
  if (['npx', 'bunx', 'pnpx'].includes(base)) {
    const name = base;
    foundRunner = true;
    addRunnerOptions(rest, name);
  } else if (NPM_FAMILY.includes(base)) {
    for (const reading of globalReadings(base).readings) {
      const [sub] = reading.command;
      const name = runnerName(base, sub);
      if (!name) continue;
      foundRunner = true;
      reading.options.forEach(({ option }) => options.add(option));
      addRunnerOptions(reading.command.slice(1), name);
    }
  } else if (base === 'uv') {
    const values = valuesForManager('uv');
    for (const reading of globalReadings(base).readings) {
      const [sub, sub2] = reading.command;
      if (sub === 'run') {
        foundRunner = true;
        reading.options.forEach(({ option }) => options.add(option));
        addRunnerOptions(reading.command.slice(1), 'uvRun');
      } else if (sub === 'tool' && sub2 === 'run') {
        foundRunner = true;
        reading.options.forEach(({ option }) => options.add(option));
        const toolReadings = runnerReadings(normalizeScopedRegistry(reading.command.slice(1)), values);
        for (const toolReading of toolReadings.readings) {
          if (toolReading.command[0] !== 'run') continue;
          toolReading.options.forEach(({ option }) => options.add(option));
          addRunnerOptions(toolReading.command.slice(1), 'uvToolRun');
        }
      }
    }
  } else if (base === 'uvx') {
    foundRunner = true;
    addRunnerOptions(rest, 'uvToolRun');
  }
  else if (base === 'pipx') {
    for (const reading of globalReadings(base).readings) {
      if (reading.command[0] !== 'run') continue;
      foundRunner = true;
      reading.options.forEach(({ option }) => options.add(option));
      addRunnerOptions(reading.command.slice(1), 'pipxRun');
    }
  } else if (base === 'pdm' && rest[0] === 'run') {
    foundRunner = true;
    addOptions(commandAfterOptions(rest.slice(1), ['--env', '--env-file', '--working-dir', '--pyproject']));
  } else if (base === 'pixi') {
    const global = runnerReadings(rest, ENVIRONMENT_RUNNER_VALUES.pixi);
    for (const reading of global.readings) {
      reading.options.forEach(({ option }) => options.add(option));
      if (reading.command[0] === 'run') {
        foundRunner = true;
        addOptions(commandAfterOptions(reading.command.slice(1), ['--environment', '-e', '--platform', '-p', '--manifest-path', '--config-file', '--auth-file', '--env-file']));
      }
    }
  } else if (ENVIRONMENT_RUNNER_VALUES[base]?.has('--env-file')) {
    const parsed = runnerReadings(rest, ENVIRONMENT_RUNNER_VALUES[base], undefined, ENVIRONMENT_RUNNER_VALUE_COUNTS[base]);
    for (const reading of parsed.readings) {
      reading.options.forEach(({ option }) => options.add(option));
      if (reading.command[0] === 'run') {
        foundRunner = true;
        addOptions(commandAfterOptions(reading.command.slice(1), ['--env-file']));
      }
    }
  } else if (base === 'devbox' && rest[0] === 'run') {
    foundRunner = true;
    addOptions(commandAfterOptions(rest.slice(1), ['--config', '-c', '--env', '-e', '--env-file']));
  }
  return foundRunner ? [...options] : argv;
}

function classifyChecked(argv, result, raw, state, source = raw, tokenSpans, depth = 0) {
  if (depth > 12) {
    result.unreviewable.push({ manager: 'shell', raw, reason: 'looks like an install the guard cannot parse' });
    return;
  }
  if (tokenSpans) argv = stripShellRedirects(tokenSpans);
  if (!argv.length) return;
  const unknownWrapper = unknownWrapperOption(argv, state.shell);
  if (unknownWrapper) {
    result.unreviewable.push({ manager: unknownWrapper, raw, reason: 'wrapper option grammar is unknown before a shell or package manager command' });
    return;
  }
  const queued = queuedJobqShellCommand(argv, state.shell);
  if (queued) {
    walk(queued.script, result, state, queued.shell);
    return;
  }
  const sourceCommandIndex = commandPosition(argv, state.shell);
  const sourceCommandName = commandBase(argv[sourceCommandIndex] ?? '', state.shell);
  if (['source', '.'].includes(sourceCommandName)
    && ['/dev/stdin', '/proc/self/fd/0', '/dev/fd/0'].includes(argv[sourceCommandIndex + 1])
    && /(?:<<<|<<|<)\s*/.test(source)) return;
  const binding = resolveBoundCommand(argv, state.shell, state);
  if (binding.unresolvedAlias && potentialInstallAction(argv, state.shell)) {
    result.unreviewable.push({ manager: 'shell', raw, reason: 'looks like an install the guard cannot parse' });
    return;
  }
  if (binding.argv !== argv && (binding.argv.length !== argv.length || binding.argv.some((arg, i) => arg !== argv[i]))) {
    const index = commandPosition(binding.argv, state.shell);
    const manager = commandBase(binding.argv[index] ?? '', state.shell);
    const action = positionals(binding.argv.slice(index + 1), valueSet[manager] ?? valueSet.py)[0];
    if (['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'corepack'].includes(manager) && action === 'exec') {
      result.unreviewable.push({ manager, raw, reason: 'looks like an install the guard cannot parse' });
      return;
    }
    classifyChecked(binding.argv, result, raw, state, source, undefined, depth + 1);
    return;
  }
  const aliasKey = state.shell === 'powershell' ? (argv[commandPosition(argv, state.shell)] ?? '').toLowerCase() : argv[commandPosition(argv, state.shell)];
  if (state.commandAliases.has(aliasKey) && potentialInstallAction(argv, state.shell)) {
    result.unreviewable.push({ manager: 'shell', raw, reason: 'looks like an install the guard cannot parse' });
    return;
  }
  if (canAllowTrustLockfileOnCommand(argv, state.shell, state)) {
    state.allowedTrustLockfileSegments ??= new Set();
    state.allowedTrustLockfileSegments.add(state.currentEnvironmentSegmentId);
  }
  const totalBefore = result.targets.length + result.bulk.length + result.unreviewable.length;
  const targetsBefore = result.targets.length;
  const bulkBefore = result.bulk.length;
  const unreviewableBefore = result.unreviewable.length;
  const installActionsBefore = state.installActions;
  const managerInvocationsBefore = new Set(state.managerInvocations);
  const managers = supportedManagerInvocations(argv, state.shell);
  managers.forEach((manager) => state.managerInvocations.add(manager));
  const commandIndex = commandPosition(argv, state.shell);
  const commandWord = argv[commandIndex];
  const expandedCommand = commandWord && hasExpandedCommandBasename(commandWord, state.shell, source);
  const bunInline = commandBase(commandWord ?? '', state.shell) === 'bun' && !!bunInlineInvocation(argv, state.shell);
  const wrapped = argv.slice(commandIndex + 1);
  if (unknownCommandWrapsManager(argv, state.shell)) {
    const findingsBefore = result.targets.length + result.bulk.length + result.unreviewable.length;
    const nestedInstallActionsBefore = state.installActions;
    classifyChecked(wrapped, result, raw, state, source, undefined, depth + 1);
    if (state.installActions > nestedInstallActionsBefore
      && result.targets.length + result.bulk.length + result.unreviewable.length === findingsBefore) {
      result.unreviewable.push({ manager: commandBase(wrapped[0] ?? '', state.shell), raw, reason: 'looks like an install the guard cannot parse' });
    }
    if (state.installActions > nestedInstallActionsBefore) state.installActions++;
    return;
  }
  if (!bunInline && hasExpandedManagerAction(argv, state.shell, source, state)) {
    result.unreviewable.push({ manager: commandAfterWrappers(argv, state.shell) || 'shell', raw, reason: 'looks like an install the guard cannot parse' });
    return;
  }
  if (!bunInline && hasExpandedInstallTarget(argv, state.shell, source)) {
    result.unreviewable.push({ manager: commandAfterWrappers(argv, state.shell) || 'shell', raw, reason: 'looks like an install the guard cannot parse' });
    return;
  }
  state.redirectConfigChange ||= hasRedirectConfigCommand(raw, argv, state.shell);
  if (expandedCommand) {
    if (argv.length > commandIndex + 1) classifyChecked(argv.slice(commandIndex + 1), result, argv.slice(commandIndex + 1).join(' '), state, source);
    return;
  }
  classify(argv, result, raw, state, source, tokenSpans);
  if (result.targets.length + result.bulk.length + result.unreviewable.length === totalBefore
    && managerHasAmbiguousInstallReading(argv, state.shell)) {
    result.unreviewable.push({ manager: commandAfterWrappers(argv, state.shell) || 'shell', raw, reason: 'looks like an install the guard cannot parse' });
    return;
  }
  const redirectOptions = runnerOwnOptions(argv, state.shell);
  const envFile = redirectOptions.some((arg) => /^--env-file(?:=|$)/.test(arg));
  const installAction = result.targets.length > targetsBefore || result.bulk.length > bulkBefore
    || managerHasInstallReading(argv, state.shell) || state.installActions > installActionsBefore;
  if (installAction) state.installActions++;
  const pythonTool = resolvedPythonIndexTool(argv, state.shell);
  const { manager: resolvedManager } = managerReadingSet(argv, state.shell);
  const argumentOptions = injectedArgumentOptions(argv, resolvedManager, state);
  for (const group of argumentOptions.groups) {
    reviewPipFileOptions(pipFileOptions(group.args), result, group.manager, raw, targetsBefore);
  }
  const directRedirect = hasInstallerRedirect(redirectOptions, resolvedManager, installAction, pythonTool, resolvedManager)
    || argumentOptions.groups.some((group) => hasInstallerRedirect(
      group.args, group.optionManager, installAction, pythonTool, group.optionManager,
    ));
  if (argumentOptions.unsafe && installAction) result.unreviewable.push({
    manager: resolvedManager, raw, reason: 'looks like an install the guard cannot parse',
  });
  const envFileInstall = envFile && installAction;
  const nestedManagers = [...state.managerInvocations].filter((manager) => !managerInvocationsBefore.has(manager));
  const redirectManagers = managers.size ? [...managers] : nestedManagers;
  const redirected = state.redirectEnvAssignment || directRedirect || envFileInstall;
  if (redirected && (redirectManagers.length || result.targets.length > targetsBefore || result.bulk.length > bulkBefore)) {
    for (const t of result.targets.splice(targetsBefore)) result.unreviewable.push({ manager: t.manager, raw, reason: `${t.name} from a custom registry or index` });
    for (const entry of result.bulk.splice(bulkBefore)) result.unreviewable.push({ manager: entry.manager, raw, reason: 'install from a custom registry or index' });
    if (result.unreviewable.length === unreviewableBefore) result.unreviewable.push({ manager: redirectManagers[0] ?? [...state.managerInvocations][0] ?? 'shell', raw, reason: 'command uses a custom registry or index' });
  }
  const installIntent = bunInline
    ? INSTALL_INTENT.test(bunInlineInvocation(argv, state.shell)?.code ?? '')
    : hasInstallIntentForSegment(raw, state.shell);
  if (result.targets.length + result.bulk.length + result.unreviewable.length !== totalBefore || !installIntent) return;
  const command = commandAfterWrappers(argv, state.shell);
  const base = commandBase(command, state.shell);
  if (isKnown(base, state.shell) && hasKnownInlineCode(argv, state.shell)) {
    result.unreviewable.push({ manager: command, raw, reason: 'inline interpreter code mentions an install' });
  } else if (!isKnown(base, state.shell) && !isNonExecutingCommand(argv, state.shell)) {
    result.unreviewable.push({ manager: command || 'shell', raw, reason: 'command text mentions an install the guard cannot parse' });
  }
}

function classifyArgumentSegment(argv, result, state, shell, raw, tokenSpans) {
  const previousSegment = state.currentEnvironmentSegmentId;
  state.currentEnvironmentSegmentId = state.nextEnvironmentSegmentId++;
  try {
    recordArgumentEnvAssignments(argv, shell, state);
    classifyChecked(argv, result, raw, state, raw, tokenSpans);
  } finally {
    state.currentEnvironmentSegmentId = previousSegment;
  }
}

function walk(command, result, state, shell = state.shell) {
  const previous = state.trustLockfileWholeCommandAllowed;
  const source = Array.isArray(command) ? command.join(' ') : splitHeredocs(String(command ?? ''), shell).rest;
  const local = trustLockfileWholeCommandAllowed(source, shell, 0, state);
  state.trustLockfileWholeCommandAllowed = previous === undefined ? local : previous && local;
  try {
    return walkInternal(command, result, state, shell);
  } finally {
    state.trustLockfileWholeCommandAllowed = previous;
  }
}

function walkInternal(command, result, state, shell = state.shell) {
  if (Array.isArray(command)) {
    const raw = command.join(' ');
    if (shell !== 'powershell') state.trustLockfileConfigSetting ||= hasBashTrustLockfileMutation(raw, command);
    recordManagerVariables(command, shell, state);
    state.redirectEnvAssignment ||= shell === 'powershell'
      ? hasPowerShellRedirectEnvAssignment(raw, command) || hasUnknownPowerShellEnvWrite(raw, command)
      : hasRedirectEnvAssignment(raw) || hasUnknownBashEnvWrite(raw, command);
    state.redirectConfigChange ||= hasRedirectConfigCommand(raw, command, shell) || hasConfigFileReference(raw, command, shell);
    state.trustLockfileConfigSetting ||= hasTrustLockfileConfigSetting(command, shell);
    state.trustLockfileConfigSetting ||= hasTrustLockfileFileWrite(raw, command, shell);
    state.installIntent ||= INSTALL_INTENT.test(raw);
    const taggedTokens = [];
    let segmentId = state.nextEnvironmentSegmentId;
    let hasPart = false;
    for (const value of command) {
      if (SEPARATORS.has(value)) {
        taggedTokens.push(value);
        if (hasPart) segmentId++;
        hasPart = false;
      } else {
        taggedTokens.push({ value, segmentId });
        hasPart = true;
      }
    }
    for (const part of segments(command)) {
      classifyArgumentSegment(stripShellRedirects(part), result, state, shell, part.join(' '));
    }
    state.trustLockfileConfigSetting ||= hasTrustLockfileMentionFloor(taggedTokens, shell, state, raw);
    return;
  }
  let input = shell === 'powershell' ? command.replace(/`[ \t]*\r?\n/g, '') : command;
  if (shell === 'powershell') recordPowerShellTrustLockfileSetter(input, state);
  if (shell === 'powershell') {
    const here = input.match(/@(['"])\r?\n([\s\S]*?)\r?\n\1@(?=\s*\|)/);
    if (here) {
      const pipe = input.indexOf('|', here.index + here[0].length);
      const tail = input.slice(pipe + 1).split(/[;&\n]/, 1)[0];
      const mode = stdinShell(tokenize(tail, false, shell), shell);
      if (mode && hasShellExpansion(here[0], shell)) result.unreviewable.push({
        manager: 'shell', raw: here[0], reason: 'script piped into a shell',
      });
      else if (mode) walk(here[2], result, state, mode);
      input = input.slice(0, here.index) + 'echo' + input.slice(here.index + here[0].length);
    }
  }
  const { rest, scripts, checkedBodies, heredocEntries, bunScripts } = splitHeredocs(input, shell);
  if (shell !== 'powershell') state.trustLockfileConfigSetting ||= hasBashTrustLockfileMutation(rest, tokenize(rest, true, shell));
  state.redirectEnvAssignment ||= shell === 'powershell'
    ? hasPowerShellRedirectEnvAssignment(rest) || hasUnknownPowerShellEnvWrite(rest)
    : hasRedirectEnvAssignment(rest) || hasUnknownBashEnvWrite(rest);
  state.redirectConfigChange ||= hasRedirectConfigCommand(rest, tokenize(rest, false, shell), shell)
    || hasConfigFileReference(rest, tokenize(rest, false, shell), shell);
  const trustLockfileTokens = tokenize(rest, false, shell);
  state.trustLockfileConfigSetting ||= hasTrustLockfileConfigSetting(trustLockfileTokens, shell);
  state.trustLockfileConfigSetting ||= hasTrustLockfileFileWrite(input, trustLockfileTokens, shell);
  state.installIntent ||= INSTALL_INTENT.test(rest);
  bunScripts.forEach(({ argv, code, staticCode }) => {
    classifyBunCode(code, argv, staticCode, result, state, argv.join(' '));
    markBunStdinHandled(state, argv);
  });
  scripts.forEach((s) => walk(s, result, state, shell));
  for (const { body, quoted } of heredocEntries) {
    if (quoted || scripts.includes(body) || !TRUST_LOCKFILE_MENTION.test(body)) continue;
    if (shell !== 'powershell' && hasBashTrustLockfileMutation(body, tokenize(body, true, shell))) {
      state.trustLockfileConfigSetting = true;
    }
    substitutions(body, shell).forEach((substitution) => walk(substitution, result, state, shell));
  }
  checkedBodies.filter((body) => INSTALL_INTENT.test(body)).forEach((body) => result.unreviewable.push({
    manager: 'heredoc', raw: body, reason: 'command text mentions an install the guard cannot parse',
  }));
  substitutions(rest, shell).forEach((s) => walk(s, result, state, shell));
  const spans = tokenize(rest, true, shell);
  const tokens = spans.map((token) => token.value);
  recordManagerVariables(tokens, shell, state);
  inspectPipedShells(spans, result, state, rest, shell);
  if (shell !== 'powershell') inspectHereStringShells(spans, result, state, rest, shell);
  let segment = [];
  const classifySegment = () => {
    if (!segment.length) return;
    const segmentId = state.nextEnvironmentSegmentId;
    segment.forEach((token) => { token.segmentId = segmentId; });
    const argv = stripShellRedirects(segment);
    classifyArgumentSegment(argv, result, state, shell, rest.slice(segment[0].start, segment.at(-1).end), segment);
    segment = [];
  };
  for (const token of spans) {
    if (SEPARATORS.has(token.value)) classifySegment();
    else segment.push(token);
  }
  classifySegment();
  if (shell !== 'powershell') {
    const floorSource = stripBashComments(rest);
    state.trustLockfileConfigSetting ||= hasTrustLockfileMentionFloor(
      spans.filter((token) => floorSource.slice(token.start, token.end).trim()), shell, state, floorSource, heredocEntries,
    );
  }
}

export function parseCommand(command, { shell = 'bash', env = {} } = {}) {
  const rawText = String(command ?? '');
  const text = shell === 'powershell' ? rawText.replace(/`[ \t]*\r?\n/g, '') : rawText;
  const result = { targets: [], bulk: [], unreviewable: [] };
  const environmentOccurrences = new Map();
  const state = {
    shell,
    redirectEnvAssignment: false,
    redirectConfigChange: false,
    installIntent: false,
    installActions: 0,
    managerInvocations: new Set(),
    managerVariables: new Map(),
    argumentEnv: new Map(),
    argumentVariables: new Map(),
    literalVariables: new Map(),
    commandAliases: new Map(),
    environmentVariables: new Map(Object.entries(env ?? {}).map(([name, value]) => [name.toUpperCase(), String(value)])),
    environmentOccurrences,
    trustLockfileAssignments: [],
    nextEnvironmentSegmentId: 1,
    allowedTrustLockfileSegments: new Set(),
  };
  for (const [name, value] of Object.entries(env ?? {})) {
    recordEnvironmentOccurrence(state, name.toUpperCase(), String(value), 'inherited');
    if (ARGUMENT_ENVIRONMENT_NAMES.has(name.toUpperCase())) state.argumentEnv.set(name.toUpperCase(), String(value));
  }
  walk(text, result, state);
  const { rest } = splitHeredocs(text, shell);
  if (hasRedirectEnvForCommands(env) || state.redirectEnvAssignment) {
    result.unreviewable.push(...result.targets.map((t) => ({ manager: t.manager, raw: text, reason: `${t.name} with a registry or index set in the environment` })));
    result.targets = [];
    result.unreviewable.push(...result.bulk.map((entry) => ({ manager: entry.manager, raw: text, reason: `${entry.manager} with a registry or index set in the environment` })));
    result.bulk = [];
    if (state.managerInvocations.size && !result.unreviewable.length) {
      for (const manager of state.managerInvocations) result.unreviewable.push({ manager, raw: text, reason: 'command uses a registry or index set in the environment' });
    }
    if (!result.unreviewable.length && state.installIntent) result.unreviewable.push({ manager: 'env', raw: text, reason: 'install with a registry or index set in the environment' });
    for (const entry of result.unreviewable) {
      entry.reason = entry.reason.replace(' from a custom registry or index', ' with a registry or index set in the environment');
    }
  }
  if (hasRedirectConfigEnv(env)) {
    const configuredManagers = new Set(Object.keys(env).flatMap((name) => {
      const key = name.toUpperCase();
      if (/^NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG)$/.test(key)) return ['npm', 'pnpm', 'npx', 'pnpx'];
      if (/^PNPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG)$/.test(key)) return ['pnpm', 'pnpx'];
      if (/^PNPM_CONFIG_(?:CONFIG_DIR|NPMRC_AUTH_FILE)$/.test(key)) return ['pnpm', 'pnpx'];
      if (key === 'PIP_CONFIG_FILE') return ['pip', 'pipx'];
      if (key === 'UV_CONFIG_FILE') return ['uv', 'uvx', 'pipx'];
      if (key === 'YARN_RC_FILENAME') return ['yarn'];
      if (key === 'PIPENV_PIPFILE') return ['pipenv'];
      if (key === 'COREPACK_ENV_FILE') return ['npm', 'pnpm', 'yarn'];
      return [];
    }));
    const matches = [...result.targets, ...result.bulk].filter((entry) => configuredManagers.has(entry.manager));
    for (const entry of matches) result.unreviewable.push({
      manager: entry.manager, raw: text, reason: 'uses a registry or index config file from the environment',
    });
    result.targets = result.targets.filter((entry) => !configuredManagers.has(entry.manager));
    result.bulk = result.bulk.filter((entry) => !configuredManagers.has(entry.manager));
    const invoked = [...state.managerInvocations].filter((manager) => configuredManagers.has(manager));
    if (!matches.length && (invoked.length || state.installIntent) && result.unreviewable.length === 0) {
      for (const manager of invoked.length ? invoked : [[...configuredManagers][0] ?? 'config']) result.unreviewable.push({
        manager, raw: text, reason: 'uses a registry or index config file from the environment',
      });
    }
  }
  if (state.redirectConfigChange) {
    for (const target of result.targets.splice(0)) result.unreviewable.push({
      manager: target.manager, raw: text, reason: 'changes the package registry or index config',
    });
    if (!result.unreviewable.some((entry) => entry.reason === 'changes the package registry or index config')) {
      result.unreviewable.push({ manager: 'config', raw: text, reason: 'changes the package registry or index config' });
    }
  }
  const invalidTrustLockfileAssignment = state.trustLockfileAssignments.some(({ value, scope, segmentId, exported }) => exported
    || !trustLockfileExplicitlyFalse(value)
    && (scope !== 'scoped' || !state.allowedTrustLockfileSegments.has(segmentId)));
  if ((invalidTrustLockfileAssignment || state.trustLockfileConfigSetting)
    && !result.unreviewable.some(({ reason }) => reason === TRUST_LOCKFILE_REASON)) {
    result.unreviewable.push({ manager: 'pnpm', raw: text, reason: TRUST_LOCKFILE_REASON });
  }
  const found = result.targets.length + result.bulk.length + result.unreviewable.length;
  const commandSegments = [];
  let segment = [];
  for (const token of tokenize(rest, true, shell)) {
    if (SEPARATORS.has(token.value)) {
      if (segment.length) commandSegments.push({
        argv: segment.map((part) => part.value),
        text: rest.slice(segment[0].start, segment.at(-1).end),
      });
      segment = [];
    } else segment.push(token);
  }
  if (segment.length) commandSegments.push({
    argv: segment.map((part) => part.value),
    text: rest.slice(segment[0].start, segment.at(-1).end),
  });
  const fallbackSegments = commandSegments.filter(({ argv }) => !unknownCommandWrapsManager(argv, shell));
  const opaqueExecution = commandSegments.some(({ argv, text: segment }) => opaqueExecutionSegment(argv, shell, state, segment));
  const installIntent = hasUnclassifiedInstallIntent(text, shell, state);
  const expandedCommandWithoutAction = segments(tokenize(rest, false, shell)).some((part) => {
    const command = part[commandPosition(part, shell)];
    return command && hasExpandedCommandBasename(command, shell, rest) && !hasExpandedManagerAction(part, shell, rest, state);
  });
  if (opaqueExecution && (installIntent || result.targets.length || result.bulk.length)) {
    result.unreviewable.push({ manager: shell === 'powershell' ? 'powershell' : 'shell', raw: text, reason: 'looks like an install the guard cannot parse' });
  } else if (!found && !expandedCommandWithoutAction && fallbackSegments.some(({ argv, text: segment }) =>
    !isNonExecutingCommand(argv, shell) && OPAQUE.test(segment) && hasInstallIntentForSegment(segment, shell))) {
    result.unreviewable.push({ manager: 'shell', raw: text, reason: 'looks like an install the guard cannot parse' });
  } else if (!found && !expandedCommandWithoutAction && shell === 'powershell'
    && fallbackSegments.some(({ text: segment }) => POWERSHELL_INSTALL_INTENT.test(segment.replace(/["'&]/g, ' ')))) {
    result.unreviewable.push({ manager: 'powershell', raw: text, reason: 'PowerShell syntax the guard does not parse mentions an install' });
  }
  return result;
}
