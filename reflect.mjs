#!/usr/bin/env node
// reflect.mjs, the Sawbuck feedback edge.
//
// Run the check (the promptwheel engine) on the latest commit; on a gamed or
// regression result, deterministic ground truth, record a finding in the
// memory (the logbook engine) on the touched source paths, and tick the results
// record. Quiet by default; the dispatch surfaces catches on a cadence.
//
// Zero-dep, Node ESM. Orchestrates the engine CLIs behind a clean layer
// boundary, never reaching into their source.
//
//   node reflect.mjs [--repo <path>] [--base <ref>] [--head <ref>]
//   defaults: repo=cwd, base=HEAD~1, head=HEAD   (evaluates the latest commit)
//
// Engines resolve to the monorepo siblings by default; PW_BIN / LB_BIN override.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record as memRecord } from './memory.mjs';
import { PW } from './bins.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The MEMORY engine is reached only through memory.mjs (the Memory Contract seam), never
// resolved or shelled directly here.

const flag = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const repo = flag('--repo', process.cwd());
const base = flag('--base', 'HEAD~1');
const head = flag('--head', 'HEAD');
const by = flag('--by', '');   // the agent that authored the change (Claude-first: the Claude hook passes 'claude'); empty = unattributed (raw-git path)

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
// backstop so the check can never hang a commit/turn; generous default, overridable.
const CHECK_TIMEOUT = +(process.env.SAWBUCK_CHECK_TIMEOUT_MS) || 600000;
const runNode = (file, a) => execFileSync(process.execPath, [file, ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT, killSignal: 'SIGKILL' });

// --- 1) the check: measure the commit, parse the structured result ----------
// The check exits nonzero on fail/gamed/inconclusive, but still prints the JSON
// report to stdout, so recover it from the thrown error too.
function check() {
  const parse = (out) => { const i = out.indexOf('{'); return i < 0 ? null : JSON.parse(out.slice(i)); };
  try {
    return parse(runNode(PW, ['run', '--base', base, '--head', head, '--json']));
  } catch (e) {
    return parse((e.stdout || '').toString());
  }
}

const report = check();
if (!report || !report.verdict) process.exit(0);          // couldn't measure → nothing to learn
const verdict = report.verdict;                            // engine contract: 'gamed' | 'fail' | ...
appendActivity(verdict, report);   // the event feed logs EVERY measurable check, so you can watch it work (verified too, not only catches)
if (verdict !== 'gamed' && verdict !== 'fail') process.exit(0);   // only breakage is worth recording

// map the engine verdict to Sawbuck's plain outcome words
const kind = verdict === 'gamed' ? 'gamed' : 'regression';

// --- 2) build the finding from the result ----------------------------------
const sha = git('rev-parse', head);
const changed = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
const testish = (f) => /(\.test\.|\.spec\.|__tests__|\/tests?\/|\.config\.|golden|fixture|snapshot)/i.test(f);
const srcFiles = changed.filter((f) => !testish(f));
const evidenceFile = srcFiles[0] || changed[0];
if (!evidenceFile) process.exit(0);

const gamedMetric = (report.metrics || []).find((m) => m.gamed === true);
const reason = kind === 'gamed'
  ? `sawbuck: a change here was gamed, ${gamedMetric?.gamingReason || 'a metric "improved" by weakening its test, not the source'}`
  : `sawbuck: a change here regressed a guarded metric beyond noise`;

// --- 3) record the finding in memory (unreviewed, machine-authored note) ----
// The Memory Contract's `record` capability, through the adapter (no direct engine shell here).
// Kept simple: a commit-attached digest note. A later pass could add --span grounding
// and true coupling (the fix diff -> "change X also needs Y").
memRecord(repo, { sha, reason: reason.slice(0, 280), side: 'diff', evidenceFile, by: 'sawbuck' });

// --- 4) tick the results record (the visible proof-of-work) -----------------
const recDir = join(repo, '.sawbuck');
const recPath = join(recDir, 'results.json');
let rec = { regressions: 0, gamed: 0, latest: null };
try { if (existsSync(recPath)) rec = JSON.parse(readFileSync(recPath, 'utf8')); } catch {}
if (kind === 'gamed') rec.gamed += 1; else rec.regressions += 1;
rec.latest = { sha: sha.slice(0, 8), kind, file: evidenceFile, reason: reason.replace(/^sawbuck: /, '').slice(0, 140), at: new Date().toISOString(), by: by || null };
try { mkdirSync(recDir, { recursive: true }); writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n'); } catch {}

// --- 5) quiet by default (dispatch surfaces on cadence); one line to stderr -
process.stderr.write(`sawbuck: ${kind} recorded on ${evidenceFile}\n`);

// --- the activity feed: one line per check so you can watch it work, verified
// included, not only catches. Capped, lives in the git-excluded .sawbuck/, opt
// out with SAWBUCK_NO_LOG=1. `sawbuck log` reads it.
function appendActivity(v, rep) {
  if (process.env.SAWBUCK_NO_LOG) return;
  const map = { pass: 'verified', gamed: 'gamed', fail: 'regression', inconclusive: 'inconclusive' };
  const k = (v === 'pass' && rep.allowed) ? 'allowed' : map[v];   // a declared override is logged distinctly, for the audit trail
  if (!k) return;
  let sha = '', file = '';
  try { sha = git('rev-parse', head).slice(0, 8); } catch {}
  try { file = git('diff', '--name-only', base, head).split('\n').filter(Boolean)[0] || ''; } catch {}
  const gm = (rep.metrics || []).find((m) => m.gamed === true);
  const why = k === 'gamed' ? (gm?.gamingReason || 'the win came from editing the goalposts')
    : k === 'regression' ? 'a guarded metric regressed beyond noise'
    : k === 'allowed' ? ('declared intentional: ' + (rep.allowed?.reason || ''))
    : k === 'verified' ? 'the source earned the green'
    : 'could not certify a pass';
  const ev = { at: new Date().toISOString(), kind: k, sha, file, reason: String(why).slice(0, 160), by: by || null };
  const dir = join(repo, '.sawbuck');
  const p = join(dir, 'activity.jsonl');
  try {
    mkdirSync(dir, { recursive: true });
    let lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
    lines.push(JSON.stringify(ev));
    if (lines.length > 200) lines = lines.slice(-200);
    writeFileSync(p, lines.join('\n') + '\n');
  } catch {}
}
