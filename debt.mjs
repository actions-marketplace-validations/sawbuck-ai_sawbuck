#!/usr/bin/env node
// debt.mjs, Sawbuck's live-suppression-debt ledger: what is STILL silenced in HEAD right now,
// split by severity (disabled/weakened tests vs lint/type/error suppressions), risk-ranked by how
// fragile each file is (reverts/fix-bursts), and split by whether each suppression is DOCUMENTED (a
// rule code or reason) or BARE (just the directive, nobody wrote why). The whole-repo view;
// `sawbuck context` is the task-scoped one. The live state (git grep of HEAD, gated) is the
// complete lens for CURRENT debt; the historical diff scan under-counts it.
// Zero-dep. Usage: node debt.mjs [repo] [--repo P] [--top N] [--since REF] [--fail-on undocumented|test|any|N] [--json]

import './pipe.mjs';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { events as memEvents, debt as memDebt } from './memory.mjs';

const flag = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? (process.argv[i + 1] ?? true) : d; };
// the repo is --repo, or the first plain argument (`sawbuck debt <path>`), at its root
const VALUED = new Set(['--repo', '--top', '--since', '--fail-on']);
const plain = process.argv.slice(2).filter((a, i, l) => !a.startsWith('-') && !VALUED.has(l[i - 1]));
const asked = resolve(flag('--repo', plain[0] || process.cwd()));
let repo = asked;
try { repo = execFileSync('git', ['-C', asked, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
catch { console.error(`sawbuck debt: ${asked} is not a git repository`); process.exit(64); }
const top = Math.max(1, parseInt(flag('--top', '12'), 10) || 12);
const since = flag('--since', null);
const failRaw = flag('--fail-on', null); // undocumented | test | any | <N>; bare --fail-on = undocumented
const failMode = (failRaw === true || String(failRaw).startsWith('--')) ? 'undocumented' : (failRaw ? String(failRaw).toLowerCase() : null);
if (failMode && !/^(undocumented|test|tests|disabled|any|\d+)$/.test(failMode)) { console.error(`sawbuck debt: --fail-on takes undocumented|test|any|N, not "${failRaw}"`); process.exit(64); }
// the gate: fail (exit 1) when the list holds the kind of debt --fail-on names. With --since the list is what the
// branch adds; without it, everything live in HEAD.
const gateFails = (list) => !failMode ? false
  : /^\d+$/.test(failMode) ? list.length >= Math.max(1, +failMode)   // 0 means any: a clean list never fails
  : failMode === 'any' ? list.length > 0
  : (failMode === 'test' || failMode === 'tests' || failMode === 'disabled') ? list.some((it) => it.testSkip)
  : list.some((it) => !it.documented);
const asJson = process.argv.includes('--json');

// events give fragility + fall-back dates (Logbook's facts). Best-effort.
const events = memEvents(repo);

// the live suppression ledger via the Logbook adapter. Each
// item arrives classified (documented/testSkip) and with its line content and blame date (`since`),
// so this file does not import Logbook's pattern or gating. null = Logbook FAILED
// (unmeasurable is NOT clean, refuse and exit nonzero); [] = a genuinely clean tree.
const live = memDebt(repo);
if (live === null) { console.error('sawbuck debt: could not read the suppression ledger (Logbook failed)'); process.exit(1); }
const bare = live.filter((it) => !it.documented && it.content).length;

// --since REF: the DELTA. Suppressions in HEAD but not at REF = debt this branch/PR adds.
if (since && typeof since === 'string') {
  const norm = (s) => String(s).trim().replace(/\s+/g, ' ');
  // the delta base: the raw suppression set at REF (the adapter's ref mode), subtracted from HEAD.
  // null = the ref could not be read (not fetched, a typo): unmeasurable is NOT an empty base, or
  // every pre-existing suppression would read as newly added and a --fail-on gate would fail falsely.
  const baseRows = memDebt(repo, { ref: since });
  if (baseRows === null) { console.error(`sawbuck debt: could not read the suppression ledger at ${since} (is the ref fetched? in GitHub Actions use actions/checkout with fetch-depth: 0)`); process.exit(1); }
  const base = new Set(baseRows.map((r) => r.file + '\u0000' + norm(r.content)));
  const added = live.filter((it) => it.content && !base.has(it.file + '\u0000' + norm(it.content)));
  const skips = added.filter((it) => it.testSkip).length, undoc = added.filter((it) => !it.documented).length;
  // the gate: fail (exit 1) when the branch adds the kind of debt --fail-on names.
  const fail = gateFails(added);
  if (asJson) { console.log(JSON.stringify({ since, added: added.length, testSkips: skips, undocumented: undoc, failOn: failMode, fail, items: added.map((it) => ({ file: it.file, line: it.line, kind: String(it.kind).trim(), documented: it.documented })) }, null, 2)); process.exit(fail ? 1 : 0); }
  if (!added.length) { console.log(`🐴 sawbuck: no new suppression debt since ${since} (clean).`); process.exit(0); }
  const o = [`🐴 sawbuck: ${added.length} new suppression${added.length === 1 ? '' : 's'} since ${since}  ·  ${skips} disabled test${skips === 1 ? '' : 's'}  ·  ${undoc} undocumented (no code/reason)`];
  for (const it of added.slice(0, Math.max(top, 20))) o.push(`     ${it.testSkip ? '🔴' : (it.documented ? '  ' : '✎ ')} ${it.file}:${it.line}  ${String(it.kind).trim()}${it.documented ? '' : '   (bare - no code/reason)'}`);
  o.push(`\n   ✎ = bare/undocumented (the suspect kind); declare intent (a rule code or reason) or remove it.`);
  if (failMode) o.push(fail ? `\n   ❌ debt gate FAILED (--fail-on ${failMode}): this branch adds debt that must be declared or removed.` : `\n   ✓ debt gate passed (--fail-on ${failMode}).`);
  console.log(o.join('\n'));
  process.exit(fail ? 1 : 0);
}

const liveFail = gateFails(live);
if (!live.length) { console.log(asJson ? '{"total":0,"testSkips":0,"codeSuppressions":0,"undocumented":0,"files":[]}' : '🐴 sawbuck: no live suppression debt in HEAD (nothing silenced in src/test/config). A clean tree.'); process.exit(0); }

// Fragility: debt on code that keeps breaking (reverts, fix-bursts) is the debt that matters; debt
// on stable code is mostly noise. One pass over the events builds per-file history; a file's debt
// severity is multiplied by its fragility. Same signals rank.mjs uses.
const DAY = 86400000;
const resolveRename = (f) => f.replace(/\{[^}]*=>\s*([^}]*)\}/g, '$1').replace(/\/{2,}/g, '/');
const histMap = new Map();
for (const e of events) {
  const rv = !!e.revert, fx = !!e.fix;
  if (!rv && !fx) continue;
  for (const raw of (e.files || [])) {
    const f = resolveRename(raw);
    const h = histMap.get(f) || { reverts: 0, fixes: 0, fixDates: [] };
    if (rv) h.reverts++;
    if (fx) { h.fixes++; if (e.date) h.fixDates.push(Date.parse(e.date)); }
    histMap.set(f, h);
  }
}
const fragilityOf = (file) => {
  const h = histMap.get(file) || { reverts: 0, fixes: 0, fixDates: [] };
  const fd = [...h.fixDates].sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0; i + 2 < fd.length; i++) if (fd[i + 2] - fd[i] <= 30 * DAY) { burst = fd.filter((x) => x >= fd[i] && x <= fd[i] + 30 * DAY).length; break; }
  const hot = burst >= 3;
  const mult = 1 + Math.min(3, h.reverts * 0.75 + (hot ? 1 : 0) + h.fixes * 0.1);
  return { reverts: h.reverts, fixes: h.fixes, hot, mult };
};

const byFile = new Map();
let testSkips = 0, codeSup = 0;
for (const it of live) {
  const t = it.testSkip; t ? testSkips++ : codeSup++;
  const f = byFile.get(it.file) || { file: it.file, skips: 0, bareSup: 0, docSup: 0, kinds: new Set(), oldest: null };
  if (t) f.skips++; else (it.documented ? f.docSup++ : f.bareSup++);
  f.kinds.add(String(it.kind).trim());
  if (it.since && (!f.oldest || it.since < f.oldest)) f.oldest = it.since;
  byFile.set(it.file, f);
}
// RISK = severity (disabled test 3, bare suppression 1.5, documented 1) x file fragility.
const files = [...byFile.values()].map((f) => {
  const sup = f.bareSup + f.docSup;
  const sev = f.skips * 3 + f.bareSup * 1.5 + f.docSup * 1;
  const fr = fragilityOf(f.file);
  return { file: f.file, n: f.skips + sup, skips: f.skips, sup, bareSup: f.bareSup, oldest: f.oldest, reverts: fr.reverts, fixes: fr.fixes, hot: fr.hot, risk: +(sev * fr.mult).toFixed(1) };
}).sort((a, b) => b.risk - a.risk || b.n - a.n);
const onFragile = files.filter((f) => f.reverts > 0 || f.hot).length;

if (asJson) {
  console.log(JSON.stringify({ total: live.length, testSkips, codeSuppressions: codeSup, undocumented: bare, filesOnFragileCode: onFragile, ...(failMode ? { failOn: failMode, fail: liveFail } : {}), files: files.map((f) => ({ file: f.file, live: f.n, testSkips: f.skips, suppressions: f.sup, undocumented: f.bareSup, reverts: f.reverts, hot: f.hot, risk: f.risk, oldest: f.oldest })) }, null, 2));
  process.exit(liveFail ? 1 : 0);
}

const out = [];
out.push(`🐴 sawbuck: live suppression debt in ${basename(repo)}`);
out.push(`   ${live.length} still silenced in HEAD  ·  ${testSkips} disabled/weakened test${testSkips === 1 ? '' : 's'} (hidden-failure risk)  ·  ${codeSup} lint/type suppression${codeSup === 1 ? '' : 's'}  ·  ${bare} undocumented (no code/reason)`);
if (onFragile) out.push(`   ${onFragile} of ${files.length} debt-carrying files sit on fragile code (reverts/hotspots); look there first`);
out.push(`\n   highest-risk debt (severity x how fragile the file is):`);
for (const f of files.slice(0, top)) {
  const bits = [f.skips ? `${f.skips} test` : '', f.sup ? `${f.sup} lint/type${f.bareSup ? `, ${f.bareSup} bare` : ''}` : ''].filter(Boolean).join(' + ');
  const frag = [f.reverts ? `${f.reverts} revert${f.reverts === 1 ? '' : 's'}` : '', f.hot ? 'fix-hotspot' : '', (!f.hot && f.fixes >= 3) ? `${f.fixes} fixes` : ''].filter(Boolean).join(', ');
  out.push(`     ${f.reverts || f.hot ? '🔥 ' : '   '}${f.file}  ·  ${f.n} (${bits})${frag ? `  · ${frag}` : ''}  ·  risk ${f.risk}`);
}
const dated = live.filter((it) => it.since).sort((a, b) => String(a.since).localeCompare(String(b.since)));
if (dated.length) {
  out.push(`\n   oldest still-silenced (most stale):`);
  for (const it of dated.slice(0, 5)) out.push(`     ${it.file}:${it.line}  ${String(it.kind).trim()}  (since ${it.since})`);
}
out.push(`\n   bare = no code/reason, the suspect kind. leads, not verdicts; full dated ledger: logbook audit`);
if (failMode) out.push(liveFail ? `\n   ❌ debt gate FAILED (--fail-on ${failMode}): HEAD carries this debt. Add --since <base> to gate only what a branch adds.` : `\n   ✓ debt gate passed (--fail-on ${failMode}).`);
console.log(out.join('\n'));
process.exit(liveFail ? 1 : 0);
