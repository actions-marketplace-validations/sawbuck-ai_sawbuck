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
// WHAT THE VERDICT WORD LEAVES OUT. The engine answers "fail" when a change touches a protected path or makes a guard
// worse, and "gamed" only when neither is so. A win in the same change that came from editing the test is then in the
// report (a metric marked gamed, a weakened gate) and not in the word. Until 0.1.73 this file read the word, and the
// end of a turn sends back only what is recorded here as gamed. So, with a contract written (its counts are guards), a
// failing test that was deleted or skipped ended the turn with one line and no send-back; and a gamed test committed
// beside a protected path was left to the wall, which sent the turn back for the path, or spared it as the person's
// own, and never read the test (proof-bench/beside-guard and swept-in, 2026-11-16: every version from 0.1.64).
// A gamed win is recorded as gamed whatever else the change holds.
const metrics = report.metrics || [];
const gateWeakened = !!(report.gate && Array.isArray(report.gate.weakened) && report.gate.weakened.length && !report.gate.allowed);
const gamedHere = verdict === 'gamed' || metrics.some((m) => m.gamed === true) || gateWeakened;
const failedGuards = metrics.filter((m) => m.guard && !m.ok).map((m) => m.name);
const protectedHere = (report.mandates || []).length > 0;
// What the engine would answer were no protected path in the change: its own rule (deriveVerdict) without the mandate.
// Under the hooks a protected path is the wall's to send back, or to spare when it was the person's own file committed
// as it was; a gamed verdict is about the metrics.
const nothingCertified = (metrics.some((m) => m.inert) && !metrics.some((m) => m.status === 'improved' && !m.tripwire)) || metrics.some((m) => m.unprovable === true);
const alone = !protectedHere ? verdict : failedGuards.length ? 'fail' : gamedHere ? 'gamed' : nothingCertified ? 'inconclusive' : 'pass';
// The goalposts this span moved, by the engine's own split (promptwheel 0.8.12 on): the paths its source-only re-run
// does not take from the change. null when the engine did not say.
const goalposts = (report.gate && Array.isArray(report.gate.goalposts)) ? report.gate.goalposts : null;
// the results record, and the base this run measured from (a full sha), so a gamed verdict can be
// held against the SAME span until it re-proves: the hook re-runs base..HEAD, not last-commit..HEAD
const recDir = join(repo, '.sawbuck');
const recPath = join(recDir, 'results.json');
let rec = { regressions: 0, gamed: 0, latest: null };
try { if (existsSync(recPath)) rec = JSON.parse(readFileSync(recPath, 'utf8')); } catch {}
delete rec.settled;   // this run's own answer about a standing verdict (below): nothing already in the file is that
let baseSha = ''; try { baseSha = git('rev-parse', `${base}^{commit}`); } catch {}
const standing = !!(rec.latest && rec.latest.kind === 'gamed' && rec.latest.base && rec.latest.base === baseSha);
const writeRec = () => { try { mkdirSync(recDir, { recursive: true }); writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n'); } catch {} };
appendActivity(verdict, report, standing);   // the event feed logs EVERY measurable check, so you can watch it work (verified too, not only catches)
if (standing) {
  let headSha = ''; try { headSha = git('rev-parse', head); } catch {}
  // `settled` is this run's answer about the standing verdict, kept beside `latest` because what the span holds now may
  // be recorded over `latest` below. The Stop hook reads it back to take its second copy down.
  const settle = (kind, reason, more = {}) => { const at = new Date().toISOString(); rec.latest = { sha: headSha.slice(0, 8), kind, base: baseSha, file: rec.latest.file, reason, at, by: by || null, ...more }; rec.settled = { base: baseSha, how: more.takenBack ? 'taken back' : 'earned', at }; writeRec(); };
  // the metrics the verdict was about, when the record says (0.1.73 on): each is a win again, and this time the
  // source-only re-run carries it. A record from before names none; then any win the source carries counts.
  const was = Array.isArray(rec.latest.metrics) ? rec.latest.metrics : [];
  const earned = (m) => m.status === 'improved' && m.gamed === false;
  const earnedNow = !gamedHere && !metrics.some((m) => m.unprovable === true) && (was.length ? was.every((n) => metrics.some((m) => m.name === n && earned(m))) : metrics.some(earned));
  if (alone === 'pass') {
    // the span the gamed verdict was measured over now passes from the source: the wall comes down. A protected path
    // still changed in the span is not this verdict's business: the wall has it under the hooks, and the git hook
    // records it below, once.
    settle('verified', 'the source earned the green over the span the gamed verdict was measured on');
    if (verdict === 'pass') process.exit(0);
  } else if (earnedNow) {
    // the source carries the win now, and something else in the span is worse (the failing test is still deleted, so
    // the count of tests is down). That is a regression like any other: recorded below and said once, not a wall.
    // Holding the gamed verdict here sent a turn back for good over a test a person had asked to have removed.
    settle('verified', 'the source earned the green over the span the gamed verdict was measured on; what else the span made worse is recorded on its own');
  } else if (!gamedHere && goalposts && goalposts.length === 0) {
    // the test was put back: this span moves no goalpost any more, so there is no win here to doubt. With the suite red
    // as it was before, the engine can certify nothing ("inconclusive"), and until 0.1.73 that kept the verdict up for
    // good: the message's own "put the test back" did not end it. What the span holds now is an ordinary change, read
    // below like any other.
    settle('unverified', 'the test change was taken back: this span moves no test, config or grader any more', { takenBack: true });
  } else {
    // gamed again, or a span that cannot be certified with the test still edited: the source has not earned the green
    // over the span the verdict was measured on, so the gamed record holds, advanced to this head (the Stop hook keeps
    // the wall up), its file and attribution untouched (a commit the person made in between is not the catch), and
    // nothing is counted or noted a second time
    rec.latest = { ...rec.latest, sha: headSha.slice(0, 8), at: new Date().toISOString(), standingVerdict: verdict };
    writeRec();
    process.stderr.write(`sawbuck: the gamed verdict on ${rec.latest.file} still stands (${verdict} over the same span)\n`);
    process.exit(0);
  }
}
if (!gamedHere && verdict !== 'fail') process.exit(0);   // only breakage is worth recording
// A fail that is only a protected path, under the hooks: the Stop hook's wall counts it and sends the turn back, so
// counting it here too would show two catches for one change. The git hook has no wall, so it records it. Only when
// nothing in the same change is gamed: the wall does not read a test.
if (!gamedHere && by && protectedHere && !failedGuards.length) process.exit(0);

// map the engine's report to Sawbuck's plain outcome words
const kind = gamedHere ? 'gamed' : 'regression';

// --- 2) build the finding from the result ----------------------------------
const sha = git('rev-parse', head);
const changed = git('diff', '--name-only', '-z', base, head).split('\0').filter(Boolean);
const testish = (f) => /(\.test\.|\.spec\.|__tests__|\/tests?\/|\.config\.|golden|fixture|snapshot)/i.test(f);
const srcFiles = changed.filter((f) => !testish(f));
// a gamed win is named by the goalpost that moved (a test first, then config or a golden file); a regression by the source
const isTest = (f) => /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/)/i.test(f);
// a protected path that was touched is the finding, whatever else the change did: name the rule and the file
const hit = kind === 'regression' ? protectedHit(report) : null;
// a gamed win is named by a goalpost the engine says moved, when it says; a protected path in the same change is never
// the name for it unless nothing else changed (the contract edited to weaken the check is both)
const prot = new Set((report.mandates || []).flatMap((m) => (m && m.files) || []));
const moved = (goalposts || []).filter((f) => changed.includes(f));
const beside = changed.filter((f) => !prot.has(f));
const firstTest = (list) => list.find(isTest) || list.find(testish);
const evidenceFile = kind === 'gamed' ? (firstTest(moved.filter((f) => !prot.has(f))) || firstTest(beside) || moved[0] || beside[0] || changed[0]) : hit ? hit.file : (srcFiles[0] || changed[0]);
if (!evidenceFile) process.exit(0);

const gamedMetric = metrics.find((m) => m.gamed === true);
// with no wall to say it (the git hook), a protected path touched in the same change stays in the reason
const alsoProtected = (kind === 'gamed' && !by) ? protectedHit(report) : null;
const reason = kind === 'gamed'
  ? `sawbuck: a change here was gamed, ${gamedMetric?.gamingReason || (gateWeakened ? 'the check itself was weakened in the same change' : 'a metric "improved" by weakening its test, not the source')}${alsoProtected ? `; the same change ${alsoProtected.why}` : ''}`
  : hit ? `sawbuck: a change here ${hit.why}`
  : `sawbuck: a change here regressed a guarded metric beyond noise`;

// --- 3) record the finding in memory (unreviewed, machine-authored note) ----
// A note on the commit, through the Logbook adapter. A gamed verdict still standing over the same span never
// gets here (it exited above), so one catch is one note and one tick.
memRecord(repo, { sha, reason: reason.slice(0, 280), by: 'sawbuck' });

// --- 4) tick the results record (the visible proof-of-work) -----------------
if (kind === 'gamed') rec.gamed += 1; else rec.regressions += 1;
rec.latest = { sha: sha.slice(0, 8), kind, base: baseSha || null, file: evidenceFile, reason: reason.replace(/^sawbuck: /, '').slice(0, kind === 'gamed' && alsoProtected ? 280 : 140), at: new Date().toISOString(), by: by || null,
  ...(kind === 'gamed' ? { metrics: metrics.filter((m) => m.gamed === true).map((m) => m.name).slice(0, 8) } : {}),
  ...(kind === 'gamed' && moved.length ? { goalposts: moved.slice(0, 6) } : {}), ...(kind === 'gamed' && failedGuards.length ? { also: failedGuards.slice(0, 8) } : {}) };
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
  const k = gamedHere ? 'gamed' : map[v];   // no hook passes --allow and a trailer clears nothing, so there is no "allowed" to log here
  if (!k) return;
  let sha = '', file = '';
  try { sha = git('rev-parse', head).slice(0, 8); } catch {}
  const hit = k === 'regression' ? protectedHit(rep) : null;
  try { file = (hit && hit.file) || git('diff', '--name-only', '-z', base, head).split('\0').filter(Boolean)[0] || ''; } catch {}
  const gm = (rep.metrics || []).find((m) => m.gamed === true);
  if (k === 'gamed') { const names = (rep.gate && Array.isArray(rep.gate.goalposts)) ? rep.gate.goalposts : []; if (names.length) file = names.find((f) => /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/)/i.test(f)) || names[0]; }
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
