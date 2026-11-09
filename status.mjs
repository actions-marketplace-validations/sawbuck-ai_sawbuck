#!/usr/bin/env node
// status.mjs, the inventory: one on-demand view of everything Sawbuck has accumulated for a repo.
// Unions the three faces that are otherwise surfaced piecemeal: what it has CAUGHT for you over
// time (the outcome record), what debt is ACCRUING right now (the live suppression ledger), and
// whether it is ARMED here (what it can measure). The quiet per-turn faces stay quiet; this is the
// "show me everything" face you run when you go looking.
//
// Read-only, zero-dep, bounded. The debt scan is best-effort (a pointer if it cannot run in time).
// Usage: node status.mjs [--repo P] [--json]

import './pipe.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoState } from './repo-state.mjs';
import { readSteers, groupSteers } from './steers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const flag = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? (process.argv[i + 1] ?? true) : d; };
const repo = resolve(flag('--repo', process.cwd()));
const asJson = process.argv.includes('--json');

const readLines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

const ICON = { verified: '✓', gamed: '🚩', regression: '✗', inconclusive: '≈', allowed: '✎', mandate: '⛔' };

// --- 1) the outcome record: what the check has done here -------------------
// results.json holds the all-time catch tally (gamed + regression, never trimmed); activity.jsonl is
// the recent per-check feed (verified included, capped ~200). We read both and keep each honest.
const { results, caught: catchesAllTime, state: kind, steer, armed, hasConfig, wired } = repoState(repo);
const repeatedAll = groupSteers(readSteers().steers).filter((g) => g.n >= 3 && g.sessions >= 2);
// this repo's own first; one said elsewhere on this machine is listed with the repos it came from, so a fresh repo is not told it said it here
const sameRepo = (r) => { try { return r === repo || resolve(r) === repo || basename(r) === basename(repo); } catch { return false; } };
const repeated = [...repeatedAll.filter((g) => g.repos.some(sameRepo)), ...repeatedAll.filter((g) => !g.repos.some(sameRepo))];
const feed = readLines(join(repo, '.sawbuck', 'activity.jsonl')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const tally = { verified: 0, gamed: 0, regression: 0, inconclusive: 0, allowed: 0, mandate: 0 };
for (const e of feed) if (e && tally[e.kind] != null) tally[e.kind]++;
const seen = feed.length;
const latest = results.latest || (feed.length ? feed[feed.length - 1] : null);
const since = feed.length ? (feed[0].at || '').slice(0, 10) : null;

// --- 2) the armed state: what it can measure here (shared with the statusline) ---
const isGit = !!existsSync(join(repo, '.git'));
const state = kind || 'unarmed';

// --- 3) the live debt ledger: best-effort, bounded -------------------------
// A full-repo HEAD grep + gating; fast on normal repos, can be heavy on a giant one. Bounded so
// status never hangs; on timeout/failure it degrades to a pointer at `sawbuck debt`.
let debt = null, debtErr = null;
if (isGit) {
  const ms = +(process.env.SAWBUCK_STATUS_DEBT_MS) || 20000;
  try {
    const o = execFileSync(process.execPath, [join(HERE, 'debt.mjs'), '--repo', repo, '--json'], { encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    debt = JSON.parse(o.slice(o.indexOf('{')));
  } catch (e) { debtErr = e.killed ? 'timeout' : 'unavailable'; }
}

// --- JSON face -------------------------------------------------------------
if (asJson) {
  console.log(JSON.stringify({
    repo: basename(repo),
    state,
    armed,
    git: isGit,
    config: hasConfig,
    outcomes: { seen, caughtAllTime: catchesAllTime, gamedAllTime: results.gamed || 0, regressionsAllTime: results.regressions || 0, recent: tally, latest, since },
    steer,
    repeated: repeated.slice(0, 3).map((g) => ({ nudge: g.nudge, n: g.n })),
    debt: debt ? { total: debt.total, testSkips: debt.testSkips, undocumented: debt.undocumented, filesOnFragileCode: debt.filesOnFragileCode, top: (debt.files || []).slice(0, 5) } : null,
    debtError: debtErr,
  }, null, 2));
  process.exit(0);
}

// --- human face ------------------------------------------------------------
const out = [];
const stateLabel = { watching: 'watching (wired in)', ready: 'ready (checkable, not wired yet)', memory: 'memory only (history, no check configured)', unarmed: 'not a measurable repo yet' }[state];
out.push(`sawbuck · ${basename(repo)}  ·  ${stateLabel}`);

// Outcomes
if (seen || catchesAllTime) {
  out.push('');
  out.push(`   Caught for you${seen ? `  ·  last ${seen} check${seen === 1 ? '' : 's'}` : ''}`);
  if (seen) {
    const parts = [
      tally.verified ? `${ICON.verified} ${tally.verified} verified` : '',
      tally.gamed ? `${ICON.gamed} ${tally.gamed} gamed` : '',
      tally.mandate ? `${ICON.mandate} ${tally.mandate} protected path${tally.mandate === 1 ? '' : 's'}` : '',
      tally.regression ? `${ICON.regression} ${tally.regression} regression${tally.regression === 1 ? '' : 's'}` : '',
      tally.inconclusive ? `${ICON.inconclusive} ${tally.inconclusive} inconclusive` : '',
      tally.allowed ? `${ICON.allowed} ${tally.allowed} allowed` : '',
    ].filter(Boolean).join('   ');
    out.push(`     ${parts || 'no checks recorded yet'}`);
  }
  // the all-time catch count outlasts the 200-line window, so surface it when it is larger
  if (catchesAllTime && catchesAllTime > (tally.gamed + tally.regression)) {
    out.push(`     ${catchesAllTime} caught here all-time (${results.gamed || 0} gamed, ${results.regressions || 0} regression${(results.regressions || 0) === 1 ? '' : 's'})`);
  }
  if (latest) {
    const k = latest.kind || '';
    const when = (latest.at || '').slice(0, 10);
    const why = String(latest.reason || '').replace(/^sawbuck:\s*/i, '').slice(0, 90);
    out.push(`     latest: ${ICON[k] || '·'} ${k}${latest.file ? ` · ${latest.file}` : ''}${why ? ` · ${why}` : ''}${when ? `  (${when})` : ''}`);
  }
} else {
  out.push('');
  out.push(`   Caught for you  ·  nothing recorded yet (the check logs here on each commit/turn)`);
}

// Steering (only when the judge has scored turns here)
if (steer) {
  out.push('');
  out.push(`   Steer rate  ·  ${steer.rate}% of your recent turns redirected the agent (${steer.scored} scored, recent-window average)`);
}
// what you keep saying, across repos: a steer the judge kept 3 times in 2 sessions is a rule waiting to be written
if (repeated.length) {
  out.push('');
  out.push('   You keep saying  ·  write one down if it is a rule (/sawbuck-reins:rules can help)');
  for (const g of repeated.slice(0, 3)) out.push(`     ${g.n}x  ${g.nudge}${g.repos.some(sameRepo) ? '' : `  (in ${g.repos.map((r) => basename(r)).join(', ')})`}`);
}

// Debt
out.push('');
if (debt && debt.total) {
  out.push(`   Debt accruing now`);
  out.push(`     ${debt.total} silenced in HEAD  ·  ${debt.testSkips} disabled test${debt.testSkips === 1 ? '' : 's'}  ·  ${debt.undocumented} undocumented (no code/reason)`);
  for (const f of (debt.files || []).slice(0, 3)) {
    const bits = [f.testSkips ? `${f.testSkips} test` : '', f.suppressions ? `${f.suppressions} lint/type${f.undocumented ? `, ${f.undocumented} bare` : ''}` : ''].filter(Boolean).join(' + ');
    const frag = [f.reverts ? `${f.reverts} revert${f.reverts === 1 ? '' : 's'}` : '', f.hot ? 'fix-hotspot' : ''].filter(Boolean).join(', ');
    out.push(`     ${f.reverts || f.hot ? '🔥 ' : '   '}${f.file}  ·  ${f.live} (${bits})${frag ? `  · ${frag}` : ''}  ·  risk ${f.risk}`);
  }
  out.push(`     → sawbuck debt for the full ledger`);
} else if (debt) {
  out.push(`   Debt accruing now  ·  none live in HEAD (nothing silenced in src/test/config). A clean tree.`);
} else if (debtErr === 'timeout') {
  out.push(`   Debt accruing now  ·  scan did not finish in time here (a large repo); run \`sawbuck debt\` directly.`);
} else if (isGit) {
  out.push(`   Debt accruing now  ·  could not read the ledger; run \`sawbuck debt\` for the detail.`);
}

// Measuring / next action
out.push('');
if (!isGit) {
  out.push(`   Not a git repo here, so there is nothing to verify or remember. cd into your project.`);
} else if (state === 'watching' && wired === 'user' && !hasConfig) {
  out.push('   Measuring here  ·  wired in at user level, and that check runs only in a repo that has a promptwheel.config.json. `sawbuck contract` writes one.');
} else if (state === 'watching') {
  out.push(`   Measuring here  ·  ${hasConfig ? '✓ wired in with a contract (promptwheel.config.json)' : '✓ wired in (zero-config auto-detect)'}. Protected paths are checked at the end of each turn, and each commit is re-proved from the source.`);
} else if (state === 'ready') {
  out.push(`   Measuring here  ·  checkable but not wired yet. Try it now: \`sawbuck check\`  •  make it automatic: \`sawbuck attach\``);
} else {
  out.push(`   Measuring here  ·  ${hasConfig ? 'a contract exists' : 'no test command detected yet'}. \`sawbuck init\` to set up the check, or \`sawbuck context\` for the history alone.`);
}

console.log(out.join('\n'));
