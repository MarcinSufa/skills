// Prompt-source guard v2 (fail-open): was this prompt typed by a person, or injected by the host?
// UserPromptSubmit (command hook) and prompt.submit (JS mod) also fire for Code Mode code output and
// Poll, scheduled tasks, /loop wakeups, subagent reports and peer messages. Only explicit non-user
// signals are skipped. Omitted or unrecognised signals count as user: Claude Code 2.1.327 omits
// `source` on typed prompts, so failing closed would drop every typed prompt. Never throws.

const NON_USER_SOURCES = new Set(['sdk', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']);
const USER_ORIGIN_KINDS = new Set(['composer', 'bridge']);

function fromSource(source) {
  if (source === 'user') return 'user';
  return NON_USER_SOURCES.has(source) ? 'non-user' : 'unknown';
}

function fromOrigin(origin) {
  const kind = typeof origin === 'string' ? origin : (origin !== null && typeof origin === 'object' ? origin.kind : undefined);
  if (typeof kind !== 'string' || kind === '') return 'unknown';
  return USER_ORIGIN_KINDS.has(kind) ? 'user' : 'non-user';
}

export function classifyPromptSource(input) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'unknown';
    if (input.isMeta === true) return 'non-user';
    const verdicts = [fromSource(input.source), fromOrigin(input.origin)];
    if (verdicts.includes('non-user')) return 'non-user';
    if (verdicts.includes('user')) return 'user';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isRealUserPrompt(input) {
  return classifyPromptSource(input) !== 'non-user';
}

export function shouldSkipPrompt(input) {
  return !isRealUserPrompt(input);
}
