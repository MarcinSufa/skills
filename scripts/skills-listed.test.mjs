import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const skills = readdirSync(join(ROOT, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

test('every skill has a row in the README table', () => {
  const readme = read('README.md');
  const missing = skills.filter((s) => !readme.includes(`| [${s}](skills/${s}/README.md) |`));
  assert.deepEqual(missing, []);
});

test('every skill has a tile in the overview figure', () => {
  const src = read('docs', 'figures', 'readme.src.html');
  const start = src.indexOf('<section class="slide" data-figure="skills">');
  assert.notEqual(start, -1, 'overview figure not found');
  const figure = src.slice(start, src.indexOf('</section>', start));
  const missing = skills.filter((s) => !figure.includes(`<b>${s}</b>`));
  assert.deepEqual(missing, []);
});

test('every SKILL.md description parses as YAML', () => {
  // An unquoted plain scalar cannot hold ": " or " #"; the plugin loader then drops all frontmatter.
  const bad = skills.filter((s) => {
    const m = /^description: (.*)$/m.exec(read('skills', s, 'SKILL.md'));
    if (!m) return true;
    const v = m[1];
    return !/^['"|>]/.test(v) && (v.includes(': ') || v.includes(' #'));
  });
  assert.deepEqual(bad, []);
});
