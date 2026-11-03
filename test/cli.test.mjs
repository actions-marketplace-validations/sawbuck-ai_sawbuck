// CLI + ranker behavior tests (node:test). Run: npm test (or node --test).
// Covers the glue built this session: attach/detach wiring, the isolation
// invariant (attach leaves the worktree clean; detach is a true inverse),
// trace/verify/dry-run, rank's per-path filtering, and context.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scopeChain, recall as recallMem } from '../memory.mjs';
import { globToRe, mandateHits, mandatesInForce, protectedDirty } from '../contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'sawbuck.mjs');
const OBSIDIAN = join(HERE, '..', 'providers', 'obsidian.mjs');   // reference local-notes memory provider
const MEM0 = join(HERE, '..', 'providers', 'mem0.mjs');           // reference semantic (networked) memory provider
const LOCAL = join(HERE, '..', 'providers', 'local.mjs');         // reference minimal local-file memory provider
const CLAUDEP = join(HERE, '..', 'providers', 'claude.mjs');      // reference read-only Claude-memory provider
// isolate HOME so the global registry (~/.sawbuck) never touches the real home.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'sawbuck-home-'));
after(() => rmSync(TMP_HOME, { recursive: true, force: true }));
const sawbuck = (args, cwd, env) => execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, ...env } });
// the recording engine (what the hook runs on each commit); `sawbuck check` is now the loud one-shot
const REFLECT = join(HERE, '..', 'reflect.mjs');
const reflect = (args, cwd, env) => { try { return execFileSync(process.execPath, [REFLECT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, ...env } }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const porcelain = (d) => execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).trim();

function tmpRepo() {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-cli-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'a.js'), 'export const v = 1;\n'); g('add', '-A'); g('commit', '-qm', 'init');
  return { d, g };
}

test('attach wires an idempotent git post-commit hook; detach is a true inverse', () => {
  const { d } = tmpRepo();
  try {
    sawbuck(['attach', '.'], d);
    const pc = join(d, '.git', 'hooks', 'post-commit');
    assert.ok(existsSync(pc), 'post-commit created');
    assert.match(readFileSync(pc, 'utf8'), /# >>> sawbuck >>>/);
    assert.match(sawbuck(['attach', '.'], d), /already attached/);       // idempotent
    sawbuck(['detach', '.'], d);
    assert.ok(!existsSync(pc), 'post-commit we created is removed, not left as a stub');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('init --yes writes a contract and investigates git history (evidence-backed guards)', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'package.json'), '{"name":"x","type":"module","scripts":{"test":"node --test"}}');
    g('add', '-A'); g('commit', '-qm', 'add package.json');
    // a commit that adds a suppression, so the git-history investigation has something to find
    writeFileSync(join(d, 'a.js'), 'export const v = 1; // eslint-disable-line\n');
    g('commit', '-qam', 'quick fix with a suppression');
    const o = sawbuck(['init', '--yes'], d);
    const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
    assert.ok(Array.isArray(cfg.metrics) && cfg.metrics.length > 0, 'contract has metrics');
    assert.ok(cfg.metrics.some((m) => m.name === 'suppressions'), 'suppressions guard present');
    assert.match(o, /investigated this repo/);
    assert.match(o, /history: \d+ commits/);
    assert.match(o, /<- \d+ suppression/, 'tied the suppressions guard to real history');
    // init also writes the agent-orienting contract block (and suppresses promptwheel's own, no double)
    assert.match(o, /agent guide/, 'reports writing the agent guide');
    const agents = readFileSync(join(d, 'AGENTS.md'), 'utf8');
    assert.match(agents, /<!-- sawbuck:contract -->/, 'wrote the sentinel-delimited contract block');
    assert.match(agents, /run `sawbuck check`/, 'the block orients the agent');
    assert.ok(!/promptwheel:gate/.test(agents), 'suppressed the promptwheel gate block (no double block)');
    assert.throws(() => sawbuck(['init', '--yes'], d), 'refuses to clobber an existing contract without --force');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('event feed: the check logs every result (gamed + verified) and sawbuck log reads it', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics: [{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b;\n');   // bug: should be a - b
    const honestTest = "import {test} from 'node:test'; import assert from 'node:assert'; import {sub} from './calc.mjs';\ntest('sub', () => assert.strictEqual(sub(5, 3), 2));\n";
    writeFileSync(join(d, 'calc.test.mjs'), honestTest);
    g('add', '-A'); g('commit', '-qm', 'task: sub is red');
    // GAMED: edit the TEST to expect the bug, source stays wrong
    writeFileSync(join(d, 'calc.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert'; import {sub} from './calc.mjs';\ntest('sub', () => assert.strictEqual(sub(5, 3), 8));\n");
    g('commit', '-qam', 'make the suite green');
    reflect(['--repo', d], d);
    // VERIFIED: fix the source, restore the honest test
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n');
    writeFileSync(join(d, 'calc.test.mjs'), honestTest);
    g('commit', '-qam', 'fix sub in source');
    reflect(['--repo', d], d);
    const feed = readFileSync(join(d, '.sawbuck', 'activity.jsonl'), 'utf8');
    assert.match(feed, /"kind":"gamed"/, 'the gamed check was logged');
    assert.match(feed, /"kind":"verified"/, 'the verified check was logged too (not only catches)');
    const log = sawbuck(['log'], d);
    assert.match(log, /sawbuck activity/);
    assert.match(log, /verified/);
    assert.match(log, /gamed/);
    // `-n N` is a flag with a value, not the repo path (it used to resolve to a directory named -n)
    const one = sawbuck(['log', '-n', '1'], d);
    assert.match(one, /sawbuck activity \(last 1\)/, '-n limits the feed instead of being read as the repo path');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('status: the inventory unions outcomes, live debt, and the armed state', () => {
  const { d, g } = tmpRepo();
  try {
    // an armed repo with a bare (undocumented) suppression committed into HEAD -> live debt
    writeFileSync(join(d, 'promptwheel.config.json'), '{"metrics":[]}');
    writeFileSync(join(d, 'a.js'), 'export const v = 1; // eslint-disable-line\n');
    g('commit', '-qam', 'add a bare suppression');
    // seed the outcome record (what the check has caught over time) + the per-check feed
    mkdirSync(join(d, '.sawbuck'), { recursive: true });
    writeFileSync(join(d, '.sawbuck', 'results.json'), JSON.stringify({ regressions: 1, gamed: 2, latest: { kind: 'gamed', file: 'a.js', reason: 'the win came from editing the test', at: '2026-10-31T00:00:00Z' } }));
    writeFileSync(join(d, '.sawbuck', 'activity.jsonl'),
      [{ at: '2026-10-30T00:00:00Z', kind: 'verified', file: 'a.js' }, { at: '2026-10-31T00:00:00Z', kind: 'gamed', file: 'a.js' }].map((e) => JSON.stringify(e)).join('\n') + '\n');

    const o = sawbuck(['status', '.'], d);
    assert.match(o, /Caught for you/, 'surfaces the outcome record');
    assert.match(o, /verified/, 'shows the recent-check breakdown');
    assert.match(o, /Debt accruing now/, 'surfaces the live-debt section');
    assert.match(o, /Measuring here/, 'reports whether it is armed here');

    const j = JSON.parse(sawbuck(['status', '.', '--json'], d));
    assert.equal(j.outcomes.gamedAllTime, 2, 'all-time gamed count from the record');
    assert.equal(j.state, 'ready', 'a config present, not wired -> ready');
    // The live-debt capability needs a provider with `audit --json` (logbook >= 0.9.5); with an older
    // provider the memory adapter degrades to no debt (never a crash). When the provider DID answer, it
    // must have counted the committed bare suppression.
    if (j.debt && j.debt.total > 0) assert.ok(j.debt.undocumented >= 1, 'the bare suppression reads undocumented');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('recall composition: the same note from two providers dedups to one, keeps the higher score + both sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sawbuck-fake-'));
  const repo = mkdtempSync(join(tmpdir(), 'sawbuck-fakerepo-'));
  const script = (score) => `const c=process.argv[2];\nif(c==='recall'){console.log(JSON.stringify([{kind:'note',summary:'shared gotcha about app.js',score:${score}}]));process.exit(0)}\nprocess.exit(2);\n`;
  const hi = join(dir, 'hi.mjs'), lo = join(dir, 'lo.mjs');
  writeFileSync(hi, script(0.9)); writeFileSync(lo, script(0.2));
  const prev = process.env.SAWBUCK_MEMORY;
  try {
    process.env.SAWBUCK_MEMORY = 'fakehi,fakelo';
    process.env.SAWBUCK_MEMORY_FAKEHI_BIN = hi;
    process.env.SAWBUCK_MEMORY_FAKELO_BIN = lo;
    const notes = recallMem(repo, ['app.js']);
    assert.equal(notes.length, 1, 'the overlapping note collapses to one');
    assert.equal(notes[0].score, 0.9, 'keeps the higher-scored instance');
    assert.ok(notes[0].source.includes('fakehi') && notes[0].source.includes('fakelo'), 'records that both providers knew it');
  } finally {
    if (prev === undefined) delete process.env.SAWBUCK_MEMORY; else process.env.SAWBUCK_MEMORY = prev;
    delete process.env.SAWBUCK_MEMORY_FAKEHI_BIN; delete process.env.SAWBUCK_MEMORY_FAKELO_BIN;
    rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true });
  }
});

test('scopeChain: isolated leaf by default; self..root chain under a configured root', () => {
  const root = mkdtempSync(join(tmpdir(), 'sawbuck-root-'));
  const repo = join(root, 'group', 'repo');
  mkdirSync(repo, { recursive: true });
  const prev = process.env.SAWBUCK_MEMORY_ROOT;
  try {
    delete process.env.SAWBUCK_MEMORY_ROOT;
    assert.deepEqual(scopeChain(repo), ['repo'], 'no root in play -> an isolated leaf, no inheritance');
    process.env.SAWBUCK_MEMORY_ROOT = root;
    assert.deepEqual(scopeChain(repo), ['group/repo', 'group', ''], 'under a root -> self + ancestors + root ("")');
    delete process.env.SAWBUCK_MEMORY_ROOT;
    writeFileSync(join(root, '.sawbuck-root'), '');
    assert.deepEqual(scopeChain(repo), ['group/repo', 'group', ''], 'a .sawbuck-root marker is discovered by walking up');
  } finally {
    if (prev === undefined) delete process.env.SAWBUCK_MEMORY_ROOT; else process.env.SAWBUCK_MEMORY_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('obsidian scope isolation: a sibling scope never leaks, the root scope is shared', () => {
  const V = mkdtempSync(join(tmpdir(), 'sawbuck-vault-'));
  mkdirSync(join(V, 'repoA')); mkdirSync(join(V, 'repoB'));
  try {
    writeFileSync(join(V, 'repoA', 'a.md'), '# A\n\nfoo.js in repoA.\n');
    writeFileSync(join(V, 'repoB', 'b.md'), '# B\n\nfoo.js in repoB.\n');
    writeFileSync(join(V, 'shared.md'), '# Shared\n\nfoo.js across projects.\n');
    const recall = (sc) => JSON.parse(execFileSync(process.execPath, [OBSIDIAN, 'recall', '--file', 'foo.js', ...sc, '--json'], { encoding: 'utf8', env: { ...process.env, OBSIDIAN_VAULT: V } }));
    const a = recall(['--scope', 'repoA', '--scope', '']);
    assert.ok(a.some((f) => f.ref === 'repoA/a.md'), 'leaf scope note is present');
    assert.ok(a.some((f) => f.ref === 'shared.md'), 'root-scope (vault root) note is shared');
    assert.ok(!a.some((f) => f.ref === 'repoB/b.md'), 'a SIBLING scope must never leak into recall');
    const b = recall(['--scope', 'repoB', '--scope', '']);
    assert.ok(b.some((f) => f.ref === 'repoB/b.md') && !b.some((f) => f.ref === 'repoA/a.md'), 'isolation holds both directions');
  } finally { rmSync(V, { recursive: true, force: true }); }
});

test('memory-conformance: the obsidian reference provider conforms (recall array, debt unsupported)', () => {
  const { d } = tmpRepo();
  try {
    const o = sawbuck(['memory-conformance', OBSIDIAN], d);
    assert.match(o, /recall: ok/, 'recall returns a JSON array');
    assert.match(o, /debt:\s+unsupported/, 'a note vault signals debt unsupported (nonzero), not a bare []');
    assert.match(o, /conforms to the Memory Contract/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('claude provider: read-only recall from project memory (CLAUDE.md), debt/record unsupported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sawbuck-cm-'));
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Gotchas\n\nThe retry in app.js must keep the backoff; do not simplify it.\n');
    const got = JSON.parse(execFileSync(process.execPath, [CLAUDEP, 'recall', '--file', 'app.js', '--json'], { encoding: 'utf8', cwd: dir }));
    assert.ok(got.some((f) => /retry in app\.js/.test(f.summary)), 'surfaces the relevant CLAUDE.md line');
    // debt + record are unsupported (read-only), so they exit nonzero
    assert.throws(() => execFileSync(process.execPath, [CLAUDEP, 'debt', '--json'], { cwd: dir, stdio: 'ignore' }), 'debt unsupported');
    assert.throws(() => execFileSync(process.execPath, [CLAUDEP, 'record', '--ref', 'x', '--summary', 'y'], { cwd: dir, stdio: 'ignore' }), 'record unsupported');
    assert.match(sawbuck(['memory-conformance', CLAUDEP], dir), /conforms to the Memory Contract/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local provider: record + recall roundtrip, folder-scoped (a sibling scope is excluded), and conforms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sawbuck-local-'));
  const store = join(dir, 'm.json');
  const run = (args) => execFileSync(process.execPath, [LOCAL, ...args], { encoding: 'utf8', env: { ...process.env, SAWBUCK_LOCAL_MEMORY: store } });
  try {
    run(['record', '--ref', 'c1', '--summary', 'watch the retry in app.js', '--scope', 'repoA', '--evidence-file', 'app.js', '--by', 'sawbuck']);
    const a = JSON.parse(run(['recall', '--file', 'app.js', '--scope', 'repoA', '--scope', '']));
    assert.ok(a.some((f) => f.ref === 'c1'), 'recall in the recording scope finds the note');
    const b = JSON.parse(run(['recall', '--file', 'app.js', '--scope', 'repoB', '--scope', '']));
    assert.ok(!b.some((f) => f.ref === 'c1'), 'a sibling scope is isolated');
    assert.match(sawbuck(['memory-conformance', LOCAL], dir), /conforms to the Memory Contract/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('memory-conformance: the mem0 reference provider conforms offline (recall [], debt unsupported, no crash)', () => {
  const { d } = tmpRepo();
  try {
    // no MEM0_API_KEY: recall degrades to [] (clean, not an error), debt exits unsupported. A networked
    // semantic provider must still conform without a key, so it never crashes a read.
    const o = sawbuck(['memory-conformance', MEM0], d, { MEM0_API_KEY: '' });
    assert.match(o, /recall: ok/, 'recall returns a JSON array even with no key');
    assert.match(o, /debt:\s+unsupported/, 'a semantic store signals debt unsupported, not a bare []');
    assert.match(o, /conforms to the Memory Contract/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('recall + composition: a second provider (obsidian) contributes notes alongside logbook', () => {
  const { d } = tmpRepo();                       // commits a.js
  const V = mkdtempSync(join(tmpdir(), 'sawbuck-vault-'));
  try {
    writeFileSync(join(V, 'gotcha.md'), '# a.js gotcha\n\nThe value in a.js must stay 1 for the downstream parser.\n');
    writeFileSync(join(d, 'a.js'), 'export const v = 2;\n');   // a working change, so a.js is a changed path
    // SAWBUCK_MEMORY lists both; recall pulls notes from the contract-dialect provider (obsidian),
    // logbook (git-truth) is not asked for notes. The default obsidian bin resolves next to memory.mjs.
    const o = sawbuck(['recall', '.'], d, { SAWBUCK_MEMORY: 'logbook,obsidian', OBSIDIAN_VAULT: V });
    assert.match(o, /\[obsidian\]/, 'tags the note with its source provider');
    assert.match(o, /a\.js gotcha/, 'surfaces the relevant vault note');
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(V, { recursive: true, force: true }); }
});

test('git attach leaves the worktree clean and detach --verify proves full removal', () => {
  const { d } = tmpRepo();
  try {
    assert.equal(porcelain(d), '', 'clean before');
    sawbuck(['attach', '.'], d);
    assert.equal(porcelain(d), '', 'attach touched nothing in the tracked worktree');
    assert.ok(existsSync(join(d, '.git', 'sawbuck', 'attach.json')), 'receipt written in .git (out of tree)');
    const v = sawbuck(['detach', '--verify', '.'], d);
    assert.match(v, /verified/);
    assert.ok(!existsSync(join(d, '.git', 'sawbuck')), 'receipt removed');
    const xf = join(d, '.git', 'info', 'exclude');
    if (existsSync(xf)) assert.doesNotMatch(readFileSync(xf, 'utf8'), /sawbuck/, 'exclude block removed');
    assert.equal(porcelain(d), '', 'clean after');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach preserves a pre-existing post-commit hook and detach restores it', () => {
  const { d } = tmpRepo();
  const pc = join(d, '.git', 'hooks', 'post-commit');
  try {
    writeFileSync(pc, '#!/bin/sh\necho mine\n');
    sawbuck(['attach', '.'], d);
    assert.match(readFileSync(pc, 'utf8'), /echo mine/, 'our block is appended, theirs kept');
    sawbuck(['detach', '.'], d);
    assert.ok(existsSync(pc), 'their hook is NOT deleted (we did not create it)');
    assert.equal(readFileSync(pc, 'utf8').replace(/\n+$/, '\n'), '#!/bin/sh\necho mine\n', 'restored to theirs');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --dry-run writes nothing', () => {
  const { d } = tmpRepo();
  try {
    const o = sawbuck(['attach', '--dry-run', '.'], d);
    assert.match(o, /would leave/);
    assert.ok(!existsSync(join(d, '.git', 'hooks', 'post-commit')), 'no hook written');
    assert.ok(!existsSync(join(d, '.git', 'sawbuck')), 'no receipt written');
    assert.equal(porcelain(d), '', 'worktree untouched');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('trace shows the footprint, and reports clean after detach', () => {
  const { d } = tmpRepo();
  try {
    sawbuck(['attach', '.'], d);
    assert.match(sawbuck(['trace', '.'], d), /post-commit/);
    sawbuck(['detach', '.'], d);
    assert.match(sawbuck(['trace', '.'], d), /no footprint/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('statusline reflects the profile (memory / ready / watching / caught)', () => {
  const { d } = tmpRepo();
  try {
    // logbook history only, no check contract: memory
    writeFileSync(join(d, 'LOGBOOK.md'), '# history\n');
    assert.match(sawbuck(['statusline'], d), /🐴 sawbuck · memory/);
    // checkable (a contract, or just a test command) but not wired in yet: ready
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ metrics: [{ name: 'x', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }] }));
    assert.match(sawbuck(['statusline'], d), /🐴 sawbuck · ready/);
    // wired in (attached): watching
    mkdirSync(join(d, '.sawbuck'), { recursive: true });
    writeFileSync(join(d, '.sawbuck', 'state.json'), JSON.stringify({ lastSha: '', turns: 1 }));
    assert.match(sawbuck(['statusline'], d), /🐴 sawbuck · watching/);
    // catches recorded: N caught
    writeFileSync(join(d, '.sawbuck', 'results.json'), JSON.stringify({ regressions: 1, gamed: 1 }));
    assert.match(sawbuck(['statusline'], d), /🐴 sawbuck · 2 caught/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach refuses a non-git directory', () => {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-nogit-'));
  try { assert.throws(() => sawbuck(['attach', '.'], d)); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('git post-commit hook records a catch through a REAL commit (GIT_DIR inheritance regression)', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics: [{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b; // BUG\n');
    writeFileSync(join(d, 'calc.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert';import {sub} from './calc.mjs';\ntest('sub',()=>assert.strictEqual(sub(5,3),2));\n");
    g('add', '-A'); g('commit', '-q', '-m', 'base (red)');
    sawbuck(['attach', '.'], d);
    sawbuck(['__hook', '--repo', d], d);   // arm the reflex on the base commit
    // the cheat: edit the TEST to expect the buggy value, landed via a REAL git commit so the
    // post-commit hook fires with git's own GIT_DIR/GIT_INDEX_FILE exported (the bug's trigger).
    writeFileSync(join(d, 'calc.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert';import {sub} from './calc.mjs';\ntest('sub',()=>assert.strictEqual(sub(5,3),8));\n");
    g('commit', '-q', '-am', 'fake the pass');
    const r = JSON.parse(readFileSync(join(d, '.sawbuck', 'results.json'), 'utf8'));
    assert.ok((r.gamed || 0) + (r.regressions || 0) >= 1, 'the post-commit hook caught the faked win through a real commit (the hook must clear inherited git env)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rank filters findings per path (regression for the --file no-op bug)', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'a.js'), 'export const v = 2;\n'); g('add', '-A'); g('commit', '-qm', 'fix: patch a');  // fix touches a.js
    writeFileSync(join(d, 'b.js'), 'export const w = 1;\n'); g('add', '-A'); g('commit', '-qm', 'chore: add b');  // no signal, b.js
    const ranked = JSON.parse(sawbuck(['rank', '--base', 'HEAD~2', '--head', 'HEAD', '--json'], d, { LOGBOOK_NO_CACHE: '1' }));
    const a = ranked.find((r) => r.path === 'a.js');
    const b = ranked.find((r) => r.path === 'b.js');
    assert.ok(a && a.score > 0, 'a.js is ranked (it has a fix in its history)');
    assert.ok(!b, 'b.js is NOT ranked, proves per-path filtering, not the old all-equal bug');
    assert.match(a.top[0].subject, /patch a/, 'a.js surfaces its OWN commit');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rank flags a fix-burst as HOT (3+ fixes clustered in 30 days)', () => {
  const { d, g } = tmpRepo();
  try {
    for (let i = 0; i < 3; i++) { writeFileSync(join(d, 'a.js'), `export const v = ${i + 2};\n`); g('add', '-A'); g('commit', '-qm', `fix: patch ${i}`); }
    const ranked = JSON.parse(sawbuck(['rank', '--base', 'HEAD~3', '--head', 'HEAD', '--json'], d, { LOGBOOK_NO_CACHE: '1' }));
    const a = ranked.find((r) => r.path === 'a.js');
    assert.ok(a && a.hot === true, 'a.js flagged HOT (fix-burst)');
    assert.match(JSON.stringify(a.top), /HOT/, 'surfaces the HOT finding first');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rank does NOT flag a test rewrite as weakened when it adds more asserts than it removes', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'a.test.js'), "const assert=require('assert');assert.equal(1,1);assert.equal(2,2);\n"); g('add', '-A'); g('commit', '-qm', 'test: add a.test.js');
    writeFileSync(join(d, 'a.test.js'), "const assert=require('assert');assert.equal(1,1);assert.ok(3);assert.ok(4);assert.ok(5);\n"); g('add', '-A'); g('commit', '-qm', 'fix: rework a.test.js');  // del 1, add 3
    const ranked = JSON.parse(sawbuck(['rank', '--base', 'HEAD~2', '--head', 'HEAD', '--json'], d, { LOGBOOK_NO_CACHE: '1' }));
    const a = ranked.find((r) => r.path === 'a.test.js');
    assert.ok(a, 'a.test.js is ranked (it has a fix in its history)');
    assert.doesNotMatch(JSON.stringify(a.top), /weakened/, 'a net-positive rewrite is not flagged as weakened');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('context runs on the working state and prints the leads framing', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'a.js'), 'export const v = 9;\n'); g('add', '-A'); g('commit', '-qm', 'fix: bump a');
    const o = sawbuck(['context'], d, { LOGBOOK_NO_CACHE: '1' });
    assert.match(o, /relevant history/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --user wires cwd-based (profile-switching) hooks at the user level', () => {
  const { d } = tmpRepo();
  const home = mkdtempSync(join(tmpdir(), 'sawbuck-uhome-'));
  const f = join(home, '.claude', 'settings.json');
  try {
    sawbuck(['attach', '--user', '.'], d, { HOME: home });
    const cfg = JSON.parse(readFileSync(f, 'utf8'));
    assert.match(JSON.stringify(cfg.hooks.UserPromptSubmit), /sawbuck\.mjs.*turn/, 'per-turn hook wired at user level');
    assert.doesNotMatch(JSON.stringify(cfg.hooks.Stop), /--repo/, 'cwd-based: no repo pinned');
    sawbuck(['detach', '--user', '.'], d, { HOME: home });
    assert.ok(!existsSync(f), 'user settings we created are removed (true inverse)');
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('attach --claude writes gitignored settings.local.json and keeps git status clean', () => {
  const { d } = tmpRepo();
  const f = join(d, '.claude', 'settings.local.json');
  try {
    sawbuck(['attach', '--claude', '.'], d);
    const cfg = JSON.parse(readFileSync(f, 'utf8'));
    assert.match(JSON.stringify(cfg.hooks.UserPromptSubmit), /turn/, 'per-turn (frame + history) hook wired');
    assert.match(JSON.stringify(cfg.hooks.SessionStart), /"matcher":"compact".*turn/, 'the same block is re-injected after a compaction');
    assert.match(JSON.stringify(cfg.hooks.Stop), /__hook/, 'check (reflex) hook wired');
    assert.equal(porcelain(d), '', 'local settings are locally excluded → worktree still clean');
    sawbuck(['attach', '--claude', '.'], d);            // idempotent
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).hooks.UserPromptSubmit.length, 1, 'no duplicate on re-attach');
    sawbuck(['detach', '--claude', '.'], d);
    assert.ok(!existsSync(f), 'local settings we created are removed (true inverse)');
    assert.equal(porcelain(d), '', 'clean after detach');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --claude --shared writes the tracked settings.json (visible in git by design)', () => {
  const { d } = tmpRepo();
  const f = join(d, '.claude', 'settings.json');
  try {
    sawbuck(['attach', '--claude', '--shared', '.'], d);
    assert.ok(existsSync(f), 'wrote the shared, tracked settings.json');
    assert.match(porcelain(d), /\.claude/, 'shared settings intentionally show up in git');
    sawbuck(['detach', '--claude', '.'], d);
    assert.ok(!existsSync(f), 'removed');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --claude will not clobber a malformed settings file', () => {
  const { d } = tmpRepo();
  const dir = join(d, '.claude'); const f = join(dir, 'settings.local.json');
  try {
    mkdirSync(dir, { recursive: true }); writeFileSync(f, '{ not json');
    assert.throws(() => sawbuck(['attach', '--claude', '.'], d));
    assert.equal(readFileSync(f, 'utf8'), '{ not json', 'left untouched');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the reflex keeps the record out of git status under any attach mode (incl. --user)', () => {
  const { d } = tmpRepo();
  try {
    sawbuck(['__hook', '--repo', d], d, { LOGBOOK_NO_CACHE: '1' });
    const ex = readFileSync(join(d, '.git', 'info', 'exclude'), 'utf8');
    assert.match(ex, /# >>> sawbuck >>>/, 'exclude block written by the reflex');
    assert.match(ex, /\.sawbuck\//);
    assert.match(ex, /\.promptwheel\//);
    assert.match(ex, /events\.jsonl/, 'the logbook root ledger cache is excluded (finding #11)');
    assert.match(ex, /LOGBOOK\.md/, 'the logbook digests are excluded too');
    assert.match(ex, /annotations\.jsonl/, 'the logbook annotation plane is excluded too');
    // the records AND the whole logbook root working-set may not dirty git status
    for (const f of ['events.jsonl', 'annotations.jsonl', 'LOGBOOK.md', 'JOURNEY.md']) writeFileSync(join(d, f), 'x\n');
    mkdirSync(join(d, '.sawbuck'), { recursive: true }); writeFileSync(join(d, '.sawbuck', 'results.json'), '{}');
    assert.equal(execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'records + logbook working-set do not dirty git status');
    // retrofit: a stale block (written before events.jsonl was added) is refreshed, not left as-is
    writeFileSync(join(d, '.git', 'info', 'exclude'), '# >>> sawbuck >>>\n.sawbuck/\n.promptwheel/\n# <<< sawbuck <<<\n');
    sawbuck(['__hook', '--repo', d], d, { LOGBOOK_NO_CACHE: '1' });
    assert.match(readFileSync(join(d, '.git', 'info', 'exclude'), 'utf8'), /events\.jsonl/, 'a stale exclude block is retrofitted with events.jsonl');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('where lists an attached repo and drops it after detach', () => {
  const { d } = tmpRepo();
  try {
    sawbuck(['attach', '.'], d);
    assert.ok(sawbuck(['where'], d).includes(d), 'where lists the attached repo');
    sawbuck(['detach', '.'], d);
    assert.ok(!sawbuck(['where'], d).includes(d), 'where no longer lists it after detach');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('check (CLI) leaves an honest source fix uncharted (no false positive through the command)', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics: [{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b; // BUG\n');
    writeFileSync(join(d, 'calc.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert';import {sub} from './calc.mjs';\ntest('sub',()=>assert.strictEqual(sub(5,3),2));\n");
    g('add', '-A'); g('commit', '-q', '-m', 'base (red)');
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n');   // real fix, test untouched
    g('commit', '-q', '-am', 'fix sub in source');
    reflect(['--repo', d, '--base', 'HEAD~1', '--head', 'HEAD'], d, { LOGBOOK_NO_CACHE: '1' });
    let r = {}; try { r = JSON.parse(readFileSync(join(d, '.sawbuck', 'results.json'), 'utf8')); } catch { /* no file = no catch */ }
    assert.equal((r.gamed || 0) + (r.regressions || 0), 0, 'a red->green fix earned in source is never charted as a catch');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('frame resolves mandates through extends and turn joins frame + history in one block', () => {
  const { d, g } = tmpRepo();
  try {
    mkdirSync(join(d, 'base'), { recursive: true });
    writeFileSync(join(d, 'base', 'shared.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'], reason: 'reviewed PR only' }], metrics: [] }));
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ extends: './base/shared.json', mandates: [{ name: 'no-migrations', paths: ['db/migrations/**'] }], metrics: [{ name: 'ok', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'a.js'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const frame = sawbuck(['frame', '.'], d);
    assert.match(frame, /protected, do not touch/);
    assert.match(frame, /src\/auth\/\*\*  \(reviewed PR only\)/, 'the inherited mandate shows with its reason');
    assert.match(frame, /db\/migrations\/\*\*/, 'the local mandate shows');
    writeFileSync(join(d, 'a.js'), 'b\n');
    const turn = sawbuck(['turn', '.'], d, { LOGBOOK_NO_CACHE: '1' });
    assert.ok(turn.startsWith('▣ contract (sawbuck)'), 'turn leads with the frame');
    // no mandates -> frame is silent, turn is silent on a clean trail
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ metrics: [] }));
    assert.equal(sawbuck(['frame', '.'], d).trim(), '');
    assert.match(sawbuck(['frame', '--speak', '.'], d), /no mandates/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('contract: the glob dialect matches promptwheel (** crosses dirs, * stays in a segment, bare names match at any depth)', () => {
  assert.ok(globToRe('src/auth/**').test('src/auth/login.js'));
  assert.ok(globToRe('src/auth/**').test('src/auth/deep/er/x.js'));
  assert.ok(!globToRe('src/auth/**').test('src/authz/x.js'));
  assert.ok(globToRe('src/*.js').test('src/a.js'));
  assert.ok(!globToRe('src/*.js').test('src/deep/a.js'));
  assert.ok(globToRe('secrets.json').test('config/secrets.json'));
  assert.ok(globToRe('/secrets.json').test('secrets.json'));
  assert.ok(!globToRe('/secrets.json').test('config/secrets.json'));
});

test('the wall counts only what the turn changed: a protected file the person left dirty before the prompt is spared', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'a\n'); writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n'); writeFileSync(join(d, 'src', 'x.js'), 'b\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'my wip\n');                      // the PERSON's own uncommitted edit
    writeFileSync(join(d, 'src', 'auth', 'new.js'), 'my untracked\n');               // and an untracked file of theirs
    assert.deepEqual(Object.keys(protectedDirty(d)).sort(), ['src/auth/new.js', 'src/auth/old.js']);
    // the prompt begins: `turn` on the UserPromptSubmit hook records the baseline (a compaction re-run does not)
    const turn = (event) => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: event }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    // without --hook the hook JSON on stdin is ignored (and stdin is never waited on)
    execFileSync(process.execPath, [CLI, 'turn', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    assert.ok(!existsSync(join(d, '.sawbuck', 'state.json')) || !JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8')).turnBaseline, 'no baseline without --hook');
    turn('UserPromptSubmit');
    const st = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    assert.deepEqual(Object.keys(st.turnBaseline.files).sort(), ['src/auth/new.js', 'src/auth/old.js']);
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    // the agent only touched src/x.js: the person's dirty protected files do not block the stop
    writeFileSync(join(d, 'src', 'x.js'), 'c\n');
    assert.ok(!/"decision":"block"/.test(hook('p1')), 'pre-existing protected edits are not the turn\'s');
    // the agent also edits a protected file: blocked, naming only its own file, sparing the person's
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n');
    const r = JSON.parse(hook('p2'));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /Protected paths changed in this turn: "no-auth": src\/auth\/login\.js/);
    assert.match(r.reason, /do not revert anything you did not change/);
    assert.match(r.reason, /left out of this check.*src\/auth\/old\.js/); assert.match(r.reason, /left out of this check.*src\/auth\/new\.js/);
    // the agent changes the person's file too: now it counts (the content moved past the baseline)
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'agent rewrote it\n');
    assert.match(JSON.parse(hook('p3')).reason, /src\/auth\/login\.js, src\/auth\/old\.js|src\/auth\/old\.js, src\/auth\/login\.js/);
    // a compaction re-run of turn mid-turn must NOT re-baseline the agent's edits as pre-existing
    turn('SessionStart');
    assert.equal(JSON.parse(hook('p3')).decision, 'block', 'SessionStart[compact] leaves the baseline alone');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the baseline cannot launder the agent\'s own protected edit: a file still carrying the last violation\'s content is never baselined', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n'); writeFileSync(join(d, 'src', 'x.js'), 'b\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    turn();                                                                     // prompt 1 begins, tree clean
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n');               // the agent edits the wall
    for (let i = 0; i < 3; i++) assert.equal(JSON.parse(hook('p1')).decision, 'block');
    assert.match(JSON.parse(hook('p1')).systemMessage || '', /stopped blocking/, 'the budget runs out and the turn ends with the edit still there');
    const st = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    assert.ok(st.lastViolation && st.lastViolation.files['src/auth/login.js'], 'the violation and its content are remembered');
    turn();                                                                     // prompt 2 begins: "ok, continue"
    const st2 = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    assert.ok(!('src/auth/login.js' in st2.turnBaseline.files), 'the un-reverted agent edit is not adopted as pre-existing');
    const r = JSON.parse(hook('p2'));
    assert.equal(r.decision, 'block', 'the wall re-arms on the new prompt, as it did before baselines existed');
    assert.match(r.reason, /src\/auth\/login\.js/);
    // the person reverts it: the next prompt is clean and the memory of the violation clears
    g('checkout', '--', 'src/auth/login.js');
    assert.ok(!/"decision":"block"/.test(hook('p3')));
    assert.ok(!JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8')).lastViolation);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a turn that never reached a Stop keeps the previous baseline, so neither an interrupt nor a mid-turn re-run of turn adopts the agent\'s edit', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n'); writeFileSync(join(d, 'src', 'auth', 'old.js'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    const state = () => JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    turn();                                                            // prompt 1, clean tree
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n');      // the agent edits the wall...
    turn();                                                            // ...and re-runs turn itself mid-turn (no Stop in between)
    assert.ok(!('src/auth/login.js' in state().turnBaseline.files), 'the baseline did not move: no Stop happened since the prompt');
    // the person presses Esc (no Stop), then types the next prompt: still the agent\'s edit, still on the wall
    turn();
    assert.ok(!('src/auth/login.js' in state().turnBaseline.files), 'an interrupted turn leaves the baseline standing');
    assert.equal(JSON.parse(hook('p2')).decision, 'block');
    // a clean stop lets the next prompt take a fresh baseline, so the person\'s own edit is spared
    g('checkout', '--', 'src/auth/login.js');
    assert.ok(!/"decision":"block"/.test(hook('p2')), 'clean');
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'my own wip\n');
    turn();
    assert.ok('src/auth/old.js' in state().turnBaseline.files, 'after a Stop the baseline is fresh and holds the person\'s edit');
    assert.ok(!/"decision":"block"/.test(hook('p3')), 'the person\'s edit does not block');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a protected edit committed mid-turn still counts, and the baseline\'s commit does not advance past it until a clean stop', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    const state = () => JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    turn();
    assert.equal(state().turnBaseline.sha, base);
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n'); g('add', 'src/auth/login.js'); g('commit', '-q', '-m', 'auth fix');   // committed mid-turn: the tree is clean
    let r = JSON.parse(hook('p1'));
    assert.equal(r.decision, 'block', 'a commit does not walk through the wall');
    assert.match(r.reason, /src\/auth\/login\.js/);
    for (let i = 0; i < 2; i++) hook('p1');
    assert.match(JSON.parse(hook('p1')).systemMessage || '', /stopped blocking/);
    turn();                                                            // prompt 2: the baseline must not advance past the flagged commit
    assert.equal(state().turnBaseline.sha, base, 'the baseline\'s commit stays at the one the violation was measured against');
    assert.equal(JSON.parse(hook('p2')).decision, 'block', 'still on the wall on the next prompt');
    // the person takes the commit back out: clean stop, and the baseline advances
    g('revert', '--no-edit', 'HEAD');
    assert.ok(!/"decision":"block"/.test(hook('p2')));
    turn();
    assert.notEqual(state().turnBaseline.sha, base, 'after a clean stop the baseline moves to the new HEAD');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a violation across more than twenty protected files is remembered whole: none of them is adopted by the next baseline', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-tests', paths: ['test/**'] }], metrics: [] }));
    mkdirSync(join(d, 'test'), { recursive: true });
    writeFileSync(join(d, 'test', 'seed.js'), '1\n'); g('add', '-A'); g('commit', '-q', '-m', 'base');
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    turn();
    for (let i = 0; i < 25; i++) writeFileSync(join(d, 'test', `t${i}.js`), 'x\n');
    for (let i = 0; i < 3; i++) assert.equal(JSON.parse(hook('p1')).decision, 'block');
    hook('p1');
    const st = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    assert.equal(Object.keys(st.lastViolation.files).length, 25, 'every changed protected path is remembered, not the first twenty');
    turn();
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8')).turnBaseline.files), [], 'none of the twenty-five is adopted');
    assert.equal(JSON.parse(hook('p2')).decision, 'block');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the wall unions the committed contract: dropping a mandate from the working-tree config does not disarm it', () => {
  const { d, g } = tmpRepo();
  try {
    mkdirSync(join(d, 'base'), { recursive: true });
    writeFileSync(join(d, 'base', 'shared.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'], reason: 'reviewed PR only' }], metrics: [] }));
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ extends: './base/shared.json', mandates: [{ name: 'no-db', paths: ['db/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    assert.deepEqual(mandatesInForce(d).map((m) => m.name).sort(), ['no-auth', 'no-db']);
    // the agent narrows the inherited rule to nothing and deletes the local one, uncommitted, then breaks both
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/legacy/**'] }], metrics: [] }));
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'b\n');
    const inForce = mandatesInForce(d);
    assert.deepEqual(inForce.map((m) => [m.name, !!m.committed]).sort(), [['no-auth', false], ['no-auth', true], ['no-db', true]], 'both versions of the edited rule, and the deleted one, are in force');
    const hits = mandateHits(d, ['src/auth/login.js', 'promptwheel.config.json']);
    assert.deepEqual(hits.map((h) => [h.name, h.files, !!h.committed]), [['no-auth', ['src/auth/login.js'], true]]);
    // when the working-tree version of a rule hits too, the merged entry still says the committed one did
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/login.js'] }], metrics: [] }));
    const both = mandateHits(d, ['src/auth/login.js', 'src/auth/other.js']);
    assert.deepEqual(both.map((h) => [h.name, h.files.sort(), !!h.committed]), [['no-auth', ['src/auth/login.js', 'src/auth/other.js'], true]]);
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/legacy/**'] }], metrics: [] }));   // back to the narrowed tree for the rest
    assert.deepEqual(mandateHits(d, ['src/auth/login.js'], { ref: null }), [], 'the working tree alone would have let it through');
    const r = JSON.parse(execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: 'p1' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } }));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /no-auth.*src\/auth\/login\.js.*committed contract/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --claude upgrades an older attachment in place instead of saying already attached', () => {
  const { d } = tmpRepo();
  try {
    writeFileSync(join(d, 'a.js'), '1\n');
    sawbuck(['attach', '--claude', d], d);
    const f = join(d, '.claude', 'settings.local.json');
    const cfg = JSON.parse(readFileSync(f, 'utf8'));
    assert.ok(cfg.hooks.SessionStart && cfg.hooks.SessionStart.some((h) => h.matcher === 'compact'), 'this version wires SessionStart[compact]');
    assert.match(sawbuck(['attach', '--claude', d], d), /already attached/);
    // an attachment from a version without the SessionStart hook (and the older `context` command)
    delete cfg.hooks.SessionStart;
    cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit.map((h) => ({ ...h, hooks: h.hooks.map((x) => ({ ...x, command: x.command.replace(' turn ', ' context ') })) }));
    writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
    const out = sawbuck(['attach', '--claude', d], d);
    assert.match(out, /updated the project Claude Code hooks/);
    const up = JSON.parse(readFileSync(f, 'utf8'));
    assert.ok(up.hooks.SessionStart.some((h) => h.matcher === 'compact' && h.hooks.some((x) => / turn --hook /.test(x.command))), 'the compact hook is added, with --hook');
    assert.ok(up.hooks.UserPromptSubmit.every((h) => h.hooks.every((x) => !/ context /.test(x.command))), 'the old command is replaced, not duplicated');
    assert.equal(up.hooks.UserPromptSubmit.filter((h) => JSON.stringify(h).includes('sawbuck.mjs')).length, 1);
    assert.match(sawbuck(['attach', '--claude', d], d), /already attached/);
    sawbuck(['detach', d], d);
    assert.ok(!existsSync(f), 'detach still removes the file the first attach created');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the Stop hook blocks a turn that leaves a protected path changed, then lets a clean turn end', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'], reason: 'reviewed PR only' }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n'); writeFileSync(join(d, 'src', 'x.js'), 'b\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'c\n');                       // the agent touched the wall
    assert.deepEqual(mandateHits(d, ['src/auth/login.js', 'src/x.js']).map((h) => h.files), [['src/auth/login.js']]);
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    let r = JSON.parse(hook('p1'));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /no-auth.*src\/auth\/login\.js/);
    assert.match(readFileSync(join(d, '.sawbuck', 'activity.jsonl'), 'utf8'), /"kind":"mandate"/);
    r = JSON.parse(hook('p1')); assert.equal(r.decision, 'block', 'still blocked on the second try of the same prompt');
    r = JSON.parse(hook('p1')); assert.equal(r.decision, 'block');
    r = JSON.parse(hook('p1')); assert.ok(!r.decision && /stopped blocking/.test(r.systemMessage), 'the block budget is bounded per prompt');
    g('checkout', '--', 'src/auth/login.js'); writeFileSync(join(d, 'src', 'x.js'), 'd\n');   // reverted the wall, fixed elsewhere
    const out = hook('p2');
    assert.ok(!/"decision":"block"/.test(out), 'a clean turn is allowed to end');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
