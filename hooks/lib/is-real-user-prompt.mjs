// Prompt-source guard v1: was this prompt typed by a person, or injected by the host?
// UserPromptSubmit (command hook) and prompt.submit (JS mod) also fire for Code Mode code output and
// Poll, scheduled tasks, /loop wakeups, subagent reports and peer messages. Only "user" may be ingested.
// Omitted or unrecognised signals are "unknown" and skipped: Claude Code 2.1.327 omits `source` on
// typed prompts too, so ingest pauses there until it sends source "user". Never throws.

const NON_USER_SOURCES = new Set(['sdk', 'system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']);
const USER_ORIGIN_KINDS = new Set(['composer', 'bridge']);
const NON_USER_ORIGIN_KINDS = new Set([
  'auto-continuation', 'channel', 'coordinator', 'observer', 'observer-activity', 'peer', 'peer-send-message',
  'plugin', 'projects-relay', 'scheduled-trigger', 'sdk', 'slack-ping', 'task-notification',
]);

function fromSource(source) {
  if (source === undefined) return undefined;
  if (source === 'user') return 'user';
  return NON_USER_SOURCES.has(source) ? 'non-user' : 'unknown';
}

function fromOrigin(origin) {
  if (origin === undefined) return undefined;
  const kind = typeof origin === 'string' ? origin : origin?.kind;
  if (origin?.handback === true) return 'non-user';
  if (USER_ORIGIN_KINDS.has(kind)) return 'user';
  return NON_USER_ORIGIN_KINDS.has(kind) ? 'non-user' : 'unknown';
}

export function classifyPromptSource(input) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'unknown';
    if (input.isMeta === true) return 'non-user';
    const verdicts = [fromSource(input.source), fromOrigin(input.origin)].filter((verdict) => verdict !== undefined);
    if (verdicts.includes('non-user')) return 'non-user';
    if (verdicts.length > 0 && verdicts.every((verdict) => verdict === 'user')) return 'user';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function isRealUserPrompt(input) {
  return classifyPromptSource(input) === 'user';
}

export function shouldSkipPrompt(input) {
  return !isRealUserPrompt(input);
}
