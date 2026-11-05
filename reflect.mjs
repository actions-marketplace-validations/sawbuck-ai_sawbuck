#!/usr/bin/env node
// reflect.mjs, the Sawbuck feedback edge.
//
// Run the check (the promptwheel engine) on the latest commit; on a gamed or
// regression result, deterministic ground truth, record a finding in the
// memory (the logbook engine) on the touched source paths, and tick the results
// record. Quiet by default; the Stop hook says a fresh catch once.
//
// Zero-dep, Node ESM. Orchestrates the engine CLIs behind a clean layer
// boundary, never reaching into their source.
//
//   node reflect.mjs [--repo <path>] [--base <ref>] [--head <ref>]
//   defaults: repo=cwd, base=HEAD~1, head=HEAD   (evaluates the latest commit)
//
// PW_BIN / LB_BIN override the engines.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { record as memRecord } from './memory.mjs';
import { PW } from './bins.mjs';

// Logbook is reached only through memory.mjs, never resolved or shelled directly here.

const flag = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const repo = flag('--repo', process.cwd());
const base = flag('--base', 'HEAD~1');
const head = flag('--head', 'HEAD');
const by = flag('--by', '');   // the agent that authored the change (Claude-first: the Claude hook passes 'claude'); empty = unattributed (raw-git path)
const noAuto = process.argv.includes('--no-auto');   // user-level wiring: measure only where a contract exists, never auto-gate a stranger's suite

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
// backstop so the check can never hang a commit/turn; generous default, overridable.
const CHECK_TIMEOUT = +(process.env.SAWBUCK_CHECK_TIMEOUT_MS) || 600000;
// A Sawbuck-Allow or Promptwheel-Allow trailer never clears the verdict, whichever hook ran this: the git hook cannot
// tell who made a commit, and an agent can write a commit message. The override is a person running
// `sawbuck check --allow "<reason>"`.
const childEnv = { ...process.env, PROMPTWHEEL_NO_ALLOW_TRAILER: '1' };
const runNode = (file, a) => execFileSync(process.execPath, [file, ...a], { cwd: repo, encoding: 'utf8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT, killSignal: 'SIGKILL' });

// --- 1) the check: measure the commit, parse the structured result ----------
// The check exits nonzero on fail/gamed/inconclusive, but still prints the JSON
// report to stdout, so recover it from the thrown error too.
function check() {
  const parse = (out) => { const i = out.indexOf('{'); return i < 0 ? null : JSON.parse(out.slice(i)); };
  try {
    return parse(runNode(PW, ['run', '--base', base, '--head', head, '--json', ...(noAuto ? ['--no-auto'] : [])]));
  } catch (e) {
    return parse((e.stdout || '').toString());
  }
}

const report = check();
if (!report || !report.verdict) process.exit(0);          // couldn't measure → nothing to learn
const verdict = report.verdict;                            // engine contract: 'gamed' | 'fail' | ...
// the results record, and the base this run measured from (a full sha), so a gamed verdict can be
// held against the SAME span until it re-proves: the hook re-runs base..HEAD, not last-commit..HEAD
const recDir = join(repo, '.sawbuck');
const recPath = join(recDir, 'results.json');
let rec = { regressions: 0, gamed: 0, latest: null };
try { if (existsSync(recPath)) rec = JSON.parse(readFileSync(recPath, 'utf8')); } catch {}
let baseSha = ''; try { baseSha = git('rev-parse', `${base}^{commit}`); } catch {}
const standing = !!(rec.latest && rec.latest.kind === 'gamed' && rec.latest.base && rec.latest.base === baseSha);
const writeRec = () => { try { mkdirSync(recDir, { recursive: true }); writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n'); } catch {} };
appendActivity(verdict, report, standing);   // the event feed logs EVERY measurable check, so you can watch it work (verified too, not only catches)
if (standing) {
  let headSha = ''; try { headSha = git('rev-parse', head); } catch {}
  if (verdict === 'pass') {
    // the span the gamed verdict was measured over now passes from the source: the wall comes down
    rec.latest = { sha: headSha.slice(0, 8), kind: 'verified', base: baseSha, file: rec.latest.file, reason: 'the source earned the green over the span the gamed verdict was measured on', at: new Date().toISOString(), by: by || null };
    writeRec();
    process.exit(0);
  }
  // gamed again, a regression on top, or a span that cannot be certified: the source has still not
  // earned the green over the span the verdict was measured on, so the gamed record holds, advanced
  // to this head (the Stop hook keeps the wall up), its file and attribution untouched (a commit
  // the person made in between is not the catch), and nothing is counted or noted a second time
  rec.latest = { ...rec.latest, sha: headSha.slice(0, 8), at: new Date().toISOString(), standingVerdict: verdict };
  writeRec();
  process.stderr.write(`sawbuck: the gamed verdict on ${rec.latest.file} still stands (${verdict} over the same span)\n`);
  process.exit(0);
}
if (verdict !== 'gamed' && verdict !== 'fail') process.exit(0);   // only breakage is worth recording
// A fail that is only a protected path, under the Claude hooks: the Stop hook's wall counts it and sends the turn
// back, so counting it here too would show two catches for one change. The git hook has no wall, so it records it.
if (verdict === 'fail' && by && (report.mandates || []).length && !(report.metrics || []).some((m) => m.guard && m.ok === false)) process.exit(0);

// map the engine verdict to Sawbuck's plain outcome words
const kind = verdict === 'gamed' ? 'gamed' : 'regression';

// --- 2) build the finding from the result ----------------------------------
const sha = git('rev-parse', head);
const changed = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
const testish = (f) => /(\.test\.|\.spec\.|__tests__|\/tests?\/|\.config\.|golden|fixture|snapshot)/i.test(f);
const srcFiles = changed.filter((f) => !testish(f));
// a gamed win is named by the goalpost that moved (a test first, then config or a golden file); a regression by the source
const isTest = (f) => /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/)/i.test(f);
// a protected path that was touched is the finding, whatever else the change did: name the rule and the file
const hit = kind === 'regression' ? protectedHit(report) : null;
const evidenceFile = kind === 'gamed' ? (changed.find(isTest) || changed.find(testish) || changed[0]) : hit ? hit.file : (srcFiles[0] || changed[0]);
if (!evidenceFile) process.exit(0);

const gamedMetric = (report.metrics || []).find((m) => m.gamed === true);
const reason = kind === 'gamed'
  ? `sawbuck: a change here was gamed, ${gamedMetric?.gamingReason || 'a metric "improved" by weakening its test, not the source'}`
  : hit ? `sawbuck: a change here ${hit.why}`
  : `sawbuck: a change here regressed a guarded metric beyond noise`;

// --- 3) record the finding in memory (unreviewed, machine-authored note) ----
// A note on the commit, through the Logbook adapter. A gamed verdict still standing over the same span never
// gets here (it exited above), so one catch is one note and one tick.
memRecord(repo, { sha, reason: reason.slice(0, 280), by: 'sawbuck' });

// --- 4) tick the results record (the visible proof-of-work) -----------------
if (kind === 'gamed') rec.gamed += 1; else rec.regressions += 1;
rec.latest = { sha: sha.slice(0, 8), kind, base: baseSha || null, file: evidenceFile, reason: reason.replace(/^sawbuck: /, '').slice(0, 140), at: new Date().toISOString(), by: by || null };
writeRec();

// --- 5) quiet by default; one line to stderr -
process.stderr.write(`sawbuck: ${kind} recorded on ${evidenceFile}\n`);

// the first protected path (mandate) the engine reports as touched, in words
function protectedHit(rep) {
  const m = (rep.mandates || []).find((x) => x && (x.files || []).length);
  return m ? { file: m.files[0], why: `touched the protected path "${m.name}": ${m.files.slice(0, 3).join(', ')}${m.files.length > 3 ? `, and ${m.files.length - 3} more` : ''}` } : null;
}

// --- the activity feed: one line per check so you can watch it work, verified
// included, not only catches. Capped, lives in the git-excluded .sawbuck/, opt
// out with SAWBUCK_NO_LOG=1. `sawbuck status --log` reads it.
function appendActivity(v, rep, standing = false) {
  if (process.env.SAWBUCK_NO_LOG) return;
  const map = { pass: 'verified', gamed: 'gamed', fail: 'regression', inconclusive: 'inconclusive' };
  const k = map[v];   // no hook passes --allow and a trailer clears nothing, so there is no "allowed" to log here
  if (!k) return;
  let sha = '', file = '';
  try { sha = git('rev-parse', head).slice(0, 8); } catch {}
  const hit = k === 'regression' ? protectedHit(rep) : null;
  try { file = (hit && hit.file) || git('diff', '--name-only', base, head).split('\n').filter(Boolean)[0] || ''; } catch {}
  const gm = (rep.metrics || []).find((m) => m.gamed === true);
  const why = k === 'gamed' ? (gm?.gamingReason || 'the win came from editing the goalposts')
    : k === 'regression' ? (hit ? `the change ${hit.why}` : 'a guarded metric regressed beyond noise')
    : k === 'verified' ? 'the check passed'
    : 'could not certify a pass';
  // `standing`: this check re-proved the span of a gamed verdict that is still up, not a new catch
  const ev = { at: new Date().toISOString(), kind: k, sha, file, reason: String(why).slice(0, 160), by: by || null, ...(standing ? { standing: true } : {}) };
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
