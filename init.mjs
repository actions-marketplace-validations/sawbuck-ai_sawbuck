#!/usr/bin/env node
// sawbuck init: generate the CONTRACT (promptwheel.config.json) for this repo.
//
// Base = `promptwheel init` (stack-detected tests + antihack tripwires). Then
// INVESTIGATE git history via the logbook and show the EVIDENCE: what has actually
// broken here (reverts, suppressions, test-weakenings, hot files), so the contract
// is tuned to this repo and EXPLAINED, not generic. Deterministic, zero-LLM, zero-dep.
//
// TTY-aware by design: a human in a terminal gets a wizard (review the contract +
// the evidence, toggle guards, confirm); a pipe / CI / agent gets a non-interactive
// write with sensible defaults, so init stays scriptable. Flags:
//   -y, --yes         non-interactive: accept the proposed contract and write it
//   --wizard          force the interactive wizard even without a TTY
//   --no-investigate  skip the git-history step (just the base contract)
//   --force           overwrite an existing promptwheel.config.json
//   --preset <name>   pass through to `promptwheel init`

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PW, LB } from './bins.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const repo = (() => { try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' }).trim(); } catch { return process.cwd(); } })();

const yes = has('--yes') || has('-y');
const forceWizard = has('--wizard');
const investigate = !has('--no-investigate');
const force = has('--force');
const noBlock = has('--no-agent-block');
const presetIdx = argv.indexOf('--preset');
const preset = presetIdx > -1 ? argv[presetIdx + 1] : null;

const cfgPath = join(repo, 'promptwheel.config.json');
const priorExisted = existsSync(cfgPath);
if (priorExisted && !force) { out('sawbuck init: promptwheel.config.json already exists. Pass --force to regenerate.'); process.exit(2); }
const prior = priorExisted ? readFileSync(cfgPath, 'utf8') : null;
const restore = () => { try { if (prior != null) writeFileSync(cfgPath, prior); else if (existsSync(cfgPath)) unlinkSync(cfgPath); } catch {} };

// 1) base contract from promptwheel init (stack-detected tests + antihack tripwires)
// --no-agent-block: suppress promptwheel's own AGENTS.md gate block here; sawbuck writes its own
// sawbuck-flavored contract block below, so the user does not get two overlapping agent guides.
const pwArgs = ['init', '--force', '--no-agent-block'];
if (preset) pwArgs.push('--preset', preset);
try { execFileSync(process.execPath, [PW, ...pwArgs], { cwd: repo, stdio: 'ignore' }); }
catch { restore(); out('sawbuck init: could not generate the base contract (promptwheel init failed).'); process.exit(1); }
let cfg;
try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { restore(); out('sawbuck init: base contract unreadable.'); process.exit(1); }

// 2) investigate git history: what actually breaks here
const evidence = investigate ? investigateHistory() : null;
const rationale = guardRationale(evidence);

// 3) non-interactive write, or the wizard
const interactive = forceWizard || (process.stdin.isTTY && !yes);
if (interactive) runWizard();
else { writeCfg(); report(); }

// ---------------------------------------------------------------------------
function investigateHistory() {
  let record = '';
  try { record = execFileSync(process.execPath, [LB, 'query', '--json'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); }
  catch (e) { record = (e.stdout || '').toString(); }
  const events = record.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const codeish = (p) => /\.(m?[jt]sx?|cjs|py|go|rs|rb|java|kt|c|cc|cpp|h|hpp|php|swift|scala|clj|ex|exs)$/i.test(p);
  let reverts = 0, suppressions = 0, weakenings = 0;
  const freq = new Map();
  for (const e of events) {
    if (e.revert) reverts++;
    if (e.suppressions && e.suppressions.length) suppressions += e.suppressions.length;
    if ((e.del_asserts || 0) > (e.add_asserts || 0) + 2) weakenings++;
    for (const f of (e.files || [])) { const p = f.replace(/\{[^}]*=>\s*([^}]*)\}/g, '$1').replace(/\/{2,}/g, '/'); if (codeish(p)) freq.set(p, (freq.get(p) || 0) + 1); }
  }
  const hot = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([path, changes]) => ({ path, changes }));
  return { commits: events.length, reverts, suppressions, weakenings, hot };
}

// which guards the history justifies (annotations shown next to the contract)
function guardRationale(ev) {
  if (!ev) return {};
  const r = {};
  if (ev.suppressions > 0) r.suppressions = `${ev.suppressions} suppression${ev.suppressions === 1 ? '' : 's'} added in this repo's history`;
  if (ev.weakenings > 0) { const m = `${ev.weakenings} test-weakening${ev.weakenings === 1 ? '' : 's'} in history`; r.assertions = m; r.test_count = m; r.skipped_tests = m; }
  return r;
}

function evidenceLines() {
  if (!evidence) return ['  (history investigation skipped)'];
  if (!evidence.commits) return ['  (no git history yet to investigate)'];
  const L = [`  history: ${evidence.commits} commits, ${evidence.reverts} reverts, ${evidence.suppressions} suppressions, ${evidence.weakenings} test-weakenings`];
  if (evidence.hot.length) { L.push('  hot files (change most often, worth watching):'); for (const h of evidence.hot) L.push(`    ${String(h.changes).padStart(3)}x  ${h.path}`); }
  return L;
}

function describeMetric(m) {
  const dir = m.direction === 'pass' ? 'must pass' : m.direction === 'down' ? 'must not rise' : 'must not fall';
  const role = m.guard ? 'guard' : 'info';
  const why = rationale[m.name] ? `   <- ${rationale[m.name]}` : '';
  return `${m.name} (${dir}, ${role})${why}`;
}

function writeCfg() { writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n'); }

// Write (or refresh) the agent-orienting contract block so a coding agent (or a loop not wired to the
// `attach --claude` hook) knows the rules. AGENTS.md (the cross-tool convention; created if absent) +
// CLAUDE.md / .cursorrules when present. Idempotent + safe: only the sentinel-delimited block is
// touched. `--no-agent-block` skips it.
function writeAgentBlock() {
  const START = '<!-- sawbuck:contract -->', END = '<!-- /sawbuck:contract -->';
  const block = `${START}\n## Sawbuck contract\n\nThis repo is under a Sawbuck contract: a change is done only when the win survives verification from the source alone. Before finishing, run \`sawbuck check\`. If it reads \`gamed\`, the green came from editing a test, config, or grader, not the source, so undo that and earn it in the source. Run \`sawbuck context\` first to see what broke in these files before (reverts, weakened tests, fragile spots). Never skip, weaken, or delete a test to go green.\n${END}\n`;
  const targets = ['AGENTS.md', ...['CLAUDE.md', '.cursorrules'].filter((f) => existsSync(join(repo, f)))];
  const done = [];
  for (const f of targets) {
    const p = join(repo, f);
    let text = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const s = text.indexOf(START);
    if (s > -1) { const e = text.indexOf(END, s); text = (e > -1 ? text.slice(0, s) + block + text.slice(e + END.length).replace(/^\n+/, '\n') : text.slice(0, s) + block); }
    else { text = (text.trim() ? text.replace(/\n*$/, '\n\n') : '') + block; }
    try { writeFileSync(p, text); done.push(f); } catch { /* best-effort */ }
  }
  return done;
}

function report() {
  out('sawbuck: wrote promptwheel.config.json');
  if (!noBlock) { const w = writeAgentBlock(); if (w.length) out(`sawbuck: wrote the agent guide (the contract rules) to ${w.join(', ')}`); }
  out("\n  the contract (what a win must satisfy):");
  for (const m of cfg.metrics) out('    - ' + describeMetric(m));
  if (evidence) { out('\n  investigated this repo:'); for (const l of evidenceLines()) out(l); }
  out('\n  next:  sawbuck attach           # enforce the contract every commit');
  out('         sawbuck check            # verify your uncommitted changes now');
}

function runWizard() {
  out('sawbuck init: a contract for this repo\n');
  if (evidence) { out('  investigated this repo:'); for (const l of evidenceLines()) out(l); out(''); }
  out('  proposed contract:');
  cfg.metrics.forEach((m, i) => out(`    [x] ${i + 1}. ${describeMetric(m)}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const off = new Set();
  const ask = () => rl.question('\n  toggle a number to drop/keep it, Enter to accept, q to abort: ', (a) => {
    a = a.trim();
    if (a === '') { finish(); return; }
    if (a === 'q' || a === 'Q') { restore(); out('sawbuck init: aborted, no changes written.'); rl.close(); process.exit(1); }
    const n = parseInt(a, 10);
    if (n >= 1 && n <= cfg.metrics.length) {
      const m = cfg.metrics[n - 1];
      if (off.has(n)) off.delete(n); else off.add(n);
      out(`    [${off.has(n) ? ' ' : 'x'}] ${n}. ${m.name} ${off.has(n) ? 'dropped' : 'kept'}`);
    } else { out('  (enter a number from the list, Enter to accept, or q)'); }
    ask();
  });
  const finish = () => {
    rl.close();
    cfg.metrics = cfg.metrics.filter((_, i) => !off.has(i + 1));
    if (!cfg.metrics.length) { restore(); out('sawbuck init: no metrics left to enforce, aborted.'); process.exit(1); }
    writeCfg();
    out('');
    report();
  };
  ask();
}
