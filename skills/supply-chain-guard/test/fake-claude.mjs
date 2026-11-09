#!/usr/bin/env node
// Stand-in for `claude -p`: records the prompt and answers FAKE_VERDICT, or fails when FAKE_VERDICT=crash.
import fs from 'node:fs';

const prompt = fs.readFileSync(0, 'utf8');
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args: process.argv.slice(2), prompt })}\n`);
if (process.env.FAKE_VERDICT === 'crash') process.exit(1);
const review = { verdict: process.env.FAKE_VERDICT ?? 'allow', reasons: ['fake reviewer'] };
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(review), structured_output: review, total_cost_usd: 0 }));
