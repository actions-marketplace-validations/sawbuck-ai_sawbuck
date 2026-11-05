#!/usr/bin/env node
// dispatch.mjs, the dispatch: a compact proof-of-work receipt from the results.
// A receipt, not an ad. Silent when nothing's been recorded to show (unless --force).
// Zero-dep. Usage: node dispatch.mjs [--repo <path>] [--force] [--json]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const flag = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? (process.argv[i + 1] ?? true) : d; };
const repo = flag('--repo', process.cwd());
const force = process.argv.includes('--force');

let rec = null;
try { rec = JSON.parse(readFileSync(join(repo, '.sawbuck', 'results.json'), 'utf8')); } catch {}

const total = rec ? (rec.regressions || 0) + (rec.gamed || 0) + (rec.mandates || 0) : 0;
if (!rec || (!total && !force)) process.exit(0);          // nothing recorded → stay quiet
if (process.argv.includes('--json')) { console.log(JSON.stringify(rec)); process.exit(0); }

const n = (x, s) => `${x} ${s}${x === 1 ? '' : 's'}`;
const L = rec.latest;
// Attribute the latest catch to the agent that made it (the Claude hook passes 'claude').
let head;
if (L && L.kind === 'gamed') head = L.by ? `🐴 Sawbuck caught ${L.by} gaming a metric` : `🐴 Sawbuck caught a gamed change`;
else if (L && L.kind === 'regression') head = L.by ? `🐴 Sawbuck caught a regression from ${L.by}` : `🐴 Sawbuck caught a regression`;
else head = `🐴 Sawbuck`;
let line = head;
if (L) {
  const why = String(L.reason || L.kind).replace(/^a change here was gamed,\s*/i, '').replace(/^a change here\s+/i, '');
  line += `\n   ${L.file}: ${why}`;
}
const tally = [rec.gamed ? n(rec.gamed, 'gamed change') : '', rec.regressions ? n(rec.regressions, 'regression') : ''].filter(Boolean).join(', ');
if (tally) line += `\n   (${tally} caught here so far)`;
console.log(line);
