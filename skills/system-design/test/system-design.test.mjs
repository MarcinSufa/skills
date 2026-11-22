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

const phase = (md, name, next) => md.slice(md.indexOf(`## ${name}`), md.indexOf(`## ${next}`));

test('grill asks one question per tool call and has a stop condition', () => {
  const grill = phase(read('SKILL.md'), 'Phase 1: Grill', 'Phase 2: Draft');
  assert.match(grill, /exactly one question/);
  assert.match(grill, /never parallel tool calls/i);
  assert.match(grill, /\*\*Stop condition\.\*\*/);
});

test('capacity numbers come from a script and cover the checklist', () => {
  const md = read('SKILL.md');
  const draft = phase(md, 'Phase 2: Draft', 'Phase 3: Review');
  assert.match(draft, /python3/);
  assert.match(draft, /paste/i);
  for (const item of [/average and peak/, /reads and writes apart/, /storage per year/, /retention period/, /bandwidth in and out at peak/]) {
    assert.match(draft, item);
  }
});

test('the settled-by table stays in chat, not in the doc', () => {
  const md = read('SKILL.md');
  assert.match(phase(md, 'Phase 1: Grill', 'Phase 2: Draft'), /in the chat, not in the doc/);
  assert.match(phase(md, 'Acceptance', 'Interview practice'), /in the chat/);
});

test('deep dives justify themselves against the simplest viable design', () => {
  const draft = phase(read('SKILL.md'), 'Phase 2: Draft', 'Phase 3: Review');
  assert.match(draft, /simplest design that meets the requirements/);
});
