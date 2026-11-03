#!/usr/bin/env node
// rank.mjs, query-conditioned relevance for Sawbuck's read face.
// Given the paths a change touches, score each path's history by
// severity x recency x recurrence, so the agent sees the few relevant warnings
// for what it is about to edit, not the whole book.
// Zero-dep. Usage:
//   node rank.mjs [--repo P] [--base REF --head REF] [--file P ...] [--top N] [--json]
//   default paths = files changed in base..head (base=HEAD~1, head=HEAD)
//
// Note: logbook `query --file` does not narrow the --json record, so we pull the
// record once and filter client-side by e.files (resolving `{old => new}`
// renames). v1 does not follow a file across a pre-rename name.

import { execFileSync } from 'node:child_process';
import { events as memEvents, debt as memDebt } from './memory.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const multi = (n) => process.argv.reduce((a, v, i) => (process.argv[i - 1] === n ? [...a, v] : a), []);
const repo = arg('--repo', process.cwd());
const base = arg('--base', 'HEAD~1');
const head = arg('--head', 'HEAD');
const top = parseInt(arg('--top', '5'), 10);
const asJson = process.argv.includes('--json');

const git = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim(); } catch { return ''; } };

let paths = multi('--file');
if (!paths.length) paths = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
if (!paths.length) { console.log(asJson ? '[]' : 'rank: no paths to rank'); process.exit(0); }

// the full event record (the memory provider's recall facts), ranked client-side below
// (the provider's --file does not narrow the record, so we pull it once and filter by path here).
const EVENTS = memEvents(repo);

const resolveRename = (f) => f.replace(/\{[^}]*=>\s*([^}]*)\}/g, '$1').replace(/\/{2,}/g, '/');
const touches = (e, p) => (e.files || []).some((f) => resolveRename(f) === p);

const now = Date.now();
const recency = (d) => 1 / (1 + Math.max(0, (now - Date.parse(d)) / 86400000) / 120); // ~4-month half-weight
// weaken/suppress are commit-level signals; only credit them to code/test files,
// not the README/config that merely rode along in the same commit.
const codeish = (p) => /\.(m?[jt]sx?|cjs|py|go|rs|rb|java|kt|c|cc|cpp|h|hpp|php|swift|scala|clj|ex|exs)$/i.test(p);
// a suppression or assertion drop on a TEST path is a hidden-failure risk (a skipped
// or weakened test), so it outranks the same marker in app code (a lone style
// eslint-disable). The relevance lead: sharpen the signal, don't flatten it.
const isTest = (p) => /(^|\/)(tests?|__tests__|specs?)\//i.test(p) || /[._-](test|spec)\.[a-z0-9]+$/i.test(p) || /(^|\/)test_[^/]+\.py$/i.test(p);

// Per-language suppression normalization. A 100-repo study found a suppression's
// raw count is an idiom artifact, not a risk level: a `# noqa` is background noise in Python (141
// markers/repo) but a `t.Skip` is notable in Go. So a hit is discounted by how ubiquitous its
// idiom is in the FILE's language. Discount-only [0.4, 1]: common idioms shrink, rare ones stay at
// full base weight, and the ordering floor holds (revert 3 > test-skip 2.5 > suppression 2).
// Reverts are idiom-independent and never normalized. --raw turns this off.
const raw = process.argv.includes('--raw');
const langOf = (p) => {
  const e = (p.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (/^tsx?$/.test(e)) return 'ts';
  if (/^(m?jsx?|cjs)$/.test(e)) return 'js';
  if (['py', 'go', 'rs', 'php', 'phtml'].includes(e)) return e === 'phtml' ? 'php' : e;
  if (['java', 'kt', 'kts', 'scala', 'groovy'].includes(e)) return 'java';
  if (['cs', 'fs', 'vb'].includes(e)) return 'cs';
  return 'other';
};
// baseline = markers/repo for that language+kind, from the study's per-language table.
const BASELINE = {
  py: { code: 141, skip: 4.6 }, ts: { code: 89, skip: 19.1 }, js: { code: 37, skip: 10.5 },
  go: { code: 1.6, skip: 21.6 }, java: { code: 0.5, skip: 13.9 }, rs: { code: 0.3, skip: 4.1 },
  cs: { code: 0.5, skip: 158 }, php: { code: 0.5, skip: 15 }, other: { code: 20, skip: 10 },
};
const REF = 15; // a hit at or below ~15 markers/repo for its language+kind keeps full weight
const normMult = (p, kind) => {
  if (raw) return 1;
  const b = Math.max((BASELINE[langOf(p)] || BASELINE.other)[kind], 0.5);
  return Math.max(0.4, Math.min(1, REF / b));
};

// The "slider": debt rises on its own, but gently. A disabled test or an undocumented suppression
// on a touched file always surfaces; a file that is churning (hot / reverted) surfaces any debt;
// a stable file's routine documented suppressions stay quiet until they pile past DEBT_MIN. Tune
// with SAWBUCK_DEBT_MIN. This is how debt rises by itself in the per-turn context, no command run.
const DEBT_MIN = Math.max(1, +(process.env.SAWBUCK_DEBT_MIN) || 6);

// Still-live filter + ambient debt, via the memory adapter (the Memory Contract's `debt`
// capability), scoped to the touched paths so the per-turn hook stays cheap. A suppression on a path
// now CLEAN of suppressions is churn, not current risk (the study: AutoMapper carries 4 live
// `[Ignore]` vs ~158/repo across C# history). The adapter runs the provider's own detection + gating
// and returns classified suppressions, so the glue never imports the provider's pattern. null = the
// provider failed -> treat all as live (do not penalize); [] = genuinely clean. --raw turns it off.
let liveSet = null;
const liveDebt = new Map(); // path -> { n, skips, bare }: live suppressions, for ambient surfacing
if (!raw && paths.length) {
  const sup = memDebt(repo, { paths });
  if (sup !== null) {
    liveSet = new Set();
    for (const it of sup) {
      liveSet.add(it.file);
      const d = liveDebt.get(it.file) || { n: 0, skips: 0, bare: 0 };
      d.n++;
      if (it.testSkip) d.skips++; else if (!it.documented) d.bare++;
      liveDebt.set(it.file, d);
    }
  }
}
// a suppression on a still-silenced path keeps its weight; on a now-clean path it is near-zero.
const stillLive = (p) => (liveSet === null || liveSet.has(p) ? 1 : 0.25);

const DAY = 86400000;
const ranked = paths.map((p) => {
  let score = 0; const hits = []; const fixDates = [];
  for (const e of EVENTS) {
    if (!touches(e, p)) continue;
    if (e.fix) fixDates.push(Date.parse(e.date));
    let w = 0, kind = null;
    if (e.revert) { w = 3; kind = 'revert (do-not-retry)'; }
    // "weakened" only on a NET assertion drop (logbook's own rule: del > add + 2), 
    // a rewrite that removes some asserts but adds more is not a weakening.
    else if (codeish(p) && ((e.suppressions && e.suppressions.length) || ((e.del_asserts || 0) > (e.add_asserts || 0) + 2) || e.downgrades > 0)) {
      const hasSupp = e.suppressions && e.suppressions.length;
      const tst = isTest(p);
      const m = hasSupp ? normMult(p, tst ? 'skip' : 'code') * stillLive(p) : 1; // normalize by language x still-live; leave a pure assertion-drop at full weight
      if (tst) { w = 2.5 * m; kind = 'test disabled / weakened'; }
      else { w = 2 * m; kind = 'suppression in source'; }
    }
    else if (e.fix) { w = 1.2; kind = 'bugfix here'; }
    else continue;
    const weighted = w * recency(e.date);
    score += weighted;
    hits.push({ sha: e.sha, date: e.date, kind, subject: e.subject, w: +weighted.toFixed(2) });
  }
  // burst: >=3 bug-fixes clustered inside any 30-day window = actively on fire.
  // At 153-repo scale it is ~11% precision / 7.5x lift, modestly better than the flat
  // lifetime signal (~8% / 5.2x). A useful lead, not a verdict; boosted but honest.
  fixDates.sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0; i + 2 < fixDates.length; i++) if (fixDates[i + 2] - fixDates[i] <= 30 * DAY) { burst = fixDates.filter((x) => x >= fixDates[i] && x <= fixDates[i] + 30 * DAY).length; break; }
  if (burst >= 3) { score += 4; hits.unshift({ date: new Date(fixDates[fixDates.length - 1]).toISOString().slice(0, 10), kind: `HOT: ${burst} fixes in 30 days`, subject: 'this file was actively on fire, verify carefully', w: 99 }); }
  // ambient debt: the live suppression debt on this file rises on its own when it is the suspect kind
  // (a disabled test or an undocumented suppression), when the file is fragile (hot/reverted), or when
  // it piles past the slider. Routine documented suppressions on stable files stay quiet. The score
  // bump lets a file with ONLY debt (no history) surface at all; `sawbuck debt` is the full ledger.
  const dbt = liveDebt.get(p);
  if (dbt) {
    const fragile = burst >= 3 || hits.some((h) => /revert/.test(h.kind || ''));
    if (dbt.skips || dbt.bare || (fragile && dbt.n) || dbt.n >= DEBT_MIN) {
      const extra = [dbt.skips ? `${dbt.skips} disabled test${dbt.skips === 1 ? '' : 's'}` : '', dbt.bare ? `${dbt.bare} undocumented` : ''].filter(Boolean).join(', ');
      const w = dbt.skips ? 2.6 : (dbt.bare ? 2.2 : 1.4);
      score += w;
      hits.push({ kind: 'live debt here', subject: `${dbt.n} suppression${dbt.n === 1 ? '' : 's'} still silenced${extra ? ` (${extra})` : ''}; sawbuck debt for the ledger`, w });
    }
  }
  hits.sort((a, b) => b.w - a.w);
  return { path: p, score: +score.toFixed(2), top: hits.slice(0, 3), hot: burst >= 3 };
}).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, top);

if (asJson) { console.log(JSON.stringify(ranked, null, 2)); process.exit(0); }
if (!ranked.length) { console.log('rank: nothing notable in the history of the touched paths'); process.exit(0); }

const out = [`relevant history for ${paths.length} touched path${paths.length === 1 ? '' : 's'} (top ${ranked.length}):`];
for (const r of ranked) {
  out.push(`\n  ${r.hot ? '🔥 ' : ''}${r.path}  ·  score ${r.score}`);
  for (const h of r.top) out.push(`    - ${h.kind}: ${h.subject}${h.sha ? ` (${h.sha}, ${h.date})` : ''}`);
}
out.push('\n  leads, not conclusions; verify against the diff before acting.');
console.log(out.join('\n'));
