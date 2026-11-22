import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(SKILL, ...p), 'utf8');

const SECTIONS = [
  'Goal and non-goals',
  'Requirements',
  'Capacity estimates',
  'API',
  'Data model and ownership',
  'High-level architecture',
  'Deep dives',
  'Trade-offs and rejected alternatives',
  'Failure modes and recovery',
  'Security',
  'Rollout and migration',
  'Verification plan and definition of done',
  'Open questions',
];

test('the template lists the 13 sections in order', () => {
  const md = read('SKILL.md');
  const template = md.slice(md.indexOf('## The template'), md.indexOf('## Phase 1'));
  const found = [...template.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].map((m) => m[1]);
  assert.deepEqual(found, SECTIONS);
});

test('evals.json names this skill and every eval has a prompt and expectations', () => {
  const evals = JSON.parse(read('evals', 'evals.json'));
  assert.equal(evals.skill_name, 'system-design');
  const ids = evals.evals.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of evals.evals) {
    assert.ok(e.prompt, `eval ${e.id} has no prompt`);
    assert.ok(e.expectations.length > 0, `eval ${e.id} has no expectations`);
  }
});

test('start stage 2 hands architectural tasks to system-design', () => {
  const start = readFileSync(join(SKILL, '..', 'start', 'SKILL.md'), 'utf8');
  const stage2 = start.split('\n').find((l) => l.startsWith('2. **Clarify.**'));
  assert.match(stage2, /`system-design`/);
  assert.match(stage2, /accepts its design doc/);
});

test('start fast path never skips system-design for an architectural task', () => {
  const start = readFileSync(join(SKILL, '..', 'start', 'SKILL.md'), 'utf8');
  const fast = start.split('\n').find((l) => l.startsWith('Fast path:'));
  assert.match(fast, /architectural task[^.]*never takes the fast path/);
});

test('ordinary tasks keep the 5-item questionnaire', () => {
  const start = readFileSync(join(SKILL, '..', 'start', 'SKILL.md'), 'utf8');
  const stage2 = start.split('\n').find((l) => l.startsWith('2. **Clarify.**'));
  assert.match(stage2, /Other open architecture or product questions[^.]*max 5 items/);
});
