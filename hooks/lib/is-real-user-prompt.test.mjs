import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPromptSource, isRealUserPrompt, shouldSkipPrompt } from './is-real-user-prompt.mjs';

const command = (extra) => ({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'fix the bug', ...extra });
const mod = (extra) => ({ text: 'fix the bug', wait: false, ...extra });

test('command hook: source user is user and ingested', () => {
  assert.equal(classifyPromptSource(command({ source: 'user' })), 'user');
  assert.equal(isRealUserPrompt(command({ source: 'user' })), true);
  assert.equal(shouldSkipPrompt(command({ source: 'user' })), false);
});

test('command hook: omitted source (2.1.327 typed prompt) is ingested', () => {
  assert.equal(classifyPromptSource(command({})), 'unknown');
  assert.equal(isRealUserPrompt(command({})), true);
  assert.equal(shouldSkipPrompt(command({})), false);
});

for (const source of ['poll_event', 'sdk', 'system', 'loop_wakeup', 'schedule_wakeup']) {
  test(`command hook: explicit source ${source} is non-user and skipped`, () => {
    assert.equal(classifyPromptSource(command({ source })), 'non-user');
    assert.equal(isRealUserPrompt(command({ source })), false);
    assert.equal(shouldSkipPrompt(command({ source })), true);
  });
}

test('unknown or non-string source is unknown and ingested', () => {
  for (const source of ['future_kind', 'USER', 'POLL_EVENT', '', 1, null, { kind: 'poll_event' }]) {
    assert.equal(classifyPromptSource(command({ source })), 'unknown', String(source));
    assert.equal(isRealUserPrompt(command({ source })), true);
    assert.equal(shouldSkipPrompt(command({ source })), false);
  }
});

test('non-object input is unknown, ingested and never throws', () => {
  for (const input of [undefined, null, 'poll_event', 42, true, [], ['poll_event']]) {
    assert.equal(classifyPromptSource(input), 'unknown');
    assert.equal(isRealUserPrompt(input), true);
    assert.equal(shouldSkipPrompt(input), false);
  }
});

test('a throwing getter is unknown and ingested, not an exception', () => {
  const input = Object.defineProperty({}, 'source', { get() { throw new Error('boom'); } });
  assert.equal(classifyPromptSource(input), 'unknown');
  assert.equal(shouldSkipPrompt(input), false);
});

test('mod shape: composer and bridge origins are user', () => {
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' } })), 'user');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'bridge' } })), 'user');
  assert.equal(classifyPromptSource(mod({ origin: 'composer' })), 'user');
  assert.equal(shouldSkipPrompt(mod({ origin: { kind: 'bridge' } })), false);
});

test('mod shape: any other origin.kind is non-user and skipped', () => {
  for (const kind of ['sdk', 'task-notification', 'peer', 'scheduled-trigger', 'auto-continuation', 'channel',
    'plugin', 'unclassified', 'code-output']) {
    assert.equal(classifyPromptSource(mod({ origin: { kind } })), 'non-user', kind);
    assert.equal(shouldSkipPrompt(mod({ origin: { kind } })), true, kind);
  }
});

test('mod shape: missing origin or origin without a kind is ingested', () => {
  for (const origin of [undefined, null, {}, { kind: '' }, { kind: 3 }, 7]) {
    assert.equal(classifyPromptSource(mod({ origin })), 'unknown', String(origin));
    assert.equal(shouldSkipPrompt(mod({ origin })), false);
  }
});

test('mod shape: isMeta or a non-user source wins over a composer origin', () => {
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' }, isMeta: true })), 'non-user');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' }, source: 'poll_event' })), 'non-user');
  assert.equal(classifyPromptSource(mod({ isMeta: true })), 'non-user');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' }, isMeta: false })), 'user');
});

test('any explicit non-user signal wins over a user one', () => {
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' }, source: 'user' })), 'user');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'sdk' }, source: 'user' })), 'non-user');
  assert.equal(classifyPromptSource(mod({ origin: { kind: 'composer' }, source: 'future_kind' })), 'user');
});

test('prompt text is never sniffed', () => {
  assert.equal(classifyPromptSource(command({ prompt: '<task-notification>done</task-notification>' })), 'unknown');
  assert.equal(shouldSkipPrompt(command({ prompt: '<task-notification>done</task-notification>' })), false);
  assert.equal(classifyPromptSource(command({ prompt: 'I typed this myself', source: 'poll_event' })), 'non-user');
});
