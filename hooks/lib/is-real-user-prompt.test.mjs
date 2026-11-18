import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPromptSource, isRealUserPrompt, shouldSkipPrompt } from './is-real-user-prompt.mjs';

const command = (extra) => ({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'fix the bug', ...extra });
const mod = (extra) => ({ text: 'fix the bug', wait: false, ...extra });

test('command hook: source user is the only ingest path', () => {
  assert.equal(classifyPromptSource(command({ source: 'user' })), 'user');
  assert.equal(isRealUserPrompt(command({ source: 'user' })), true);
  assert.equal(shouldSkipPrompt(command({ source: 'user' })), false);
});

for (const source of ['poll_event', 'sdk', 'system', 'loop_wakeup', 'schedule_wakeup']) {
  test(`command hook: source ${source} is non-user and skipped`, () => {
    assert.equal(classifyPromptSource(command({ source })), 'non-user');
    assert.equal(isRealUserPrompt(command({ source })), false);
    assert.equal(shouldSkipPrompt(command({ source })), true);
  });
}

test('command hook: omitted source (2.1.327 typed prompt) is unknown and skipped', () => {
  assert.equal(classifyPromptSource(command({})), 'unknown');
  assert.equal(shouldSkipPrompt(command({})), true);
});

test('unknown or non-string source is unknown and skipped', () => {
  for (const source of ['future_kind', 'USER', '', 1, null, { kind: 'user' }]) {
    assert.equal(classifyPromptSource(command({ source })), 'unknown', String(source));
    assert.equal(shouldSkipPrompt(command({ source })), true);
  }
});

test('non-object input is unknown and never throws', () => {
  for (const input of [undefined, null, 'user', 42, true, [], ['user']]) {
    assert.equal(classifyPromptSource(input), 'unknown');
    assert.equal(isRealUserPrompt(input), false);
    assert.equal(shouldSkipPrompt(input), true);
  }
});

test('a throwing getter is unknown, not an exception', () => {
  const input = Object.defineProperty({}, 'source', { get() { throw new Error('boom'); } });
  assert.equal(classifyPromptSource(input), 'unknown');
});

test('mod shape: composer and bridge origins are user', () => {
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' } })), 'user');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'bridge' } })), 'user');
  assert.equal(classifyPromptSource(mod({ origin: 'composer' })), 'user');
});

test('mod shape: injected origins are non-user', () => {
  for (const kind of ['sdk', 'task-notification', 'peer', 'scheduled-trigger', 'auto-continuation', 'channel', 'plugin']) {
    assert.equal(classifyPromptSource(mod({ origin: { kind } })), 'non-user', kind);
  }
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer', handback: true } })), 'non-user');
});

test('mod shape: unclassified, unknown or missing origin is unknown', () => {
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'unclassified' } })), 'unknown');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'code-output' } })), 'unknown');
  assert.equal(classifyPromptSource(mod({ origin: {} })), 'unknown');
  assert.equal(classifyPromptSource(mod({})), 'unknown');
});

test('mod shape: isMeta or a non-user source wins over a composer origin', () => {
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' }, isMeta: true })), 'non-user');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' }, source: 'poll_event' })), 'non-user');
});

test('every present signal must say user', () => {
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' }, source: 'user' })), 'user');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'unclassified' }, source: 'user' })), 'unknown');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'sdk' }, source: 'user' })), 'non-user');
  assert.equal(classifyPromptSource(command({ source: 'user', isMeta: false })), 'user');
});

test('prompt text is never sniffed', () => {
  assert.equal(classifyPromptSource(command({ prompt: '<task-notification>done</task-notification>', source: 'user' })), 'user');
  assert.equal(classifyPromptSource(command({ prompt: 'I typed this myself' })), 'unknown');
});
