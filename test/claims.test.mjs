// Every public claim as a test, the stated limits included. A sentence on the site or in a README that has no
// test here is a sentence nobody has checked. CLAIMS_SAWBUCK points this at an installed package, so the same
// file proves what is on npm: CLAIMS_SAWBUCK=/path/to/node_modules/sawbuck/sawbuck.mjs node --test test/claims.test.mjs
// Runs on a clean account on purpose: a developer's global gitignore hid a bug that blocked every turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.CLAIMS_SAWBUCK || join(HERE, '..', 'sawbuck.mjs');
const HOME = mkdtempSync(join(tmpdir(), 'claims-home-'));
const ENV = { ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, 'cfg'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c', PROMPTWHEEL_NO_ALLOW_TRAILER: '' };
delete ENV.CLAUDECODE;

const git = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const save = (d, msg) => { git(d, 'add', '-A'); git(d, 'commit', '-qm', msg); };
const put = (d, f, c) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), c); };
const edit = (d, f, fn) => put(d, f, fn(readFileSync(join(d, f), 'utf8')));
const json = (d, f, fn) => { const o = JSON.parse(readFileSync(join(d, f), 'utf8')); fn(o); put(d, f, JSON.stringify(o, null, 2) + '\n'); };
const sb = (d, ...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: d, encoding: 'utf8', env: ENV }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const check = (d, ...a) => { const r = sb(d, 'check', '--json', ...a); try { return { code: r.code, ...JSON.parse(r.out) }; } catch { return { code: r.code, out: r.out }; } };

const TEST = `const t=require('node:test'),a=require('node:assert');const {add,mul}=require('../src/add.js')
t.test('add',()=>a.equal(add(2,2),4))
t.test('mul',()=>a.equal(mul(2,3),6))
`;
// good = add works; a bad repo starts red, the case a cheat exists for
function repo(good = false) {
  const d = mkdtempSync(join(tmpdir(), 'claims-'));
  git(d, 'init', '-q', '-b', 'main');
  put(d, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n');
  put(d, 'src/add.js', `exports.add=(a,b)=>a${good ? '+' : '-'}b\nexports.mul=(a,b)=>a*b\n`);
  put(d, 'test/add.test.js', TEST); put(d, '.gitignore', 'node_modules\n');
  save(d, 'base'); return d;
}
const signed = (good = true, ...flags) => { const d = repo(good); assert.equal(sb(d, 'contract', ...flags).code, 0); save(d, 'sign'); return d; };
const strict = (good = true) => signed(good, '--strict');
const fixAdd = (s) => s.replace('a-b', 'a+b');
const breakAdd = (s) => s.replace('a+b', 'a-b');

// the hooks exactly as attach wrote them
function wired(d, session = 's') {
  assert.equal(sb(d, 'attach', '--claude').code, 0);
  const h = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks;
  const run = (cmd, ev) => spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: session, prompt: 'x' }) }).stdout || '';
  return { prompt: () => run(h.UserPromptSubmit[0].hooks[0].command, 'UserPromptSubmit'), stop: () => run(h.Stop[0].hooks[0].command, 'Stop'), compact: () => run(h.SessionStart[0].hooks[0].command, 'SessionStart') };
}
const blocked = (out) => out.includes('"block"');

// ------------------------------------------------------------ "re-proves a win from the source edits alone"
test('claim: an honest source fix is verified', () => { const d = repo(); edit(d, 'src/add.js', fixAdd); save(d, 'fix'); assert.equal(check(d).code, 0); });
test('claim: editing the assertion so a red test goes green reads gamed', () => { const d = repo(); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'x'); assert.equal(check(d).code, 2); });
test('claim: deleting the failing test reads gamed', () => { const d = repo(); edit(d, 'test/add.test.js', (s) => s.split('\n').filter((l) => !l.includes("'add'")).join('\n')); save(d, 'x'); assert.equal(check(d).code, 2); });
test('claim: skipping the failing test reads gamed', () => { const d = repo(); edit(d, 'test/add.test.js', (s) => s.replace("t.test('add'", "t.test.skip('add'")); save(d, 'x'); assert.equal(check(d).code, 2); });
test('claim: a green from editing the config reads gamed (the test command in package.json)', () => { const d = repo(); json(d, 'package.json', (o) => { o.scripts.test = 'true'; }); save(d, 'x'); assert.equal(check(d).code, 2); });
test('claim: a working-tree cheat reads gamed before any commit', () => { const d = repo(); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); assert.equal(check(d).code, 2); });
test('claim: breaking something that worked is a regression', () => { const d = repo(true); edit(d, 'src/add.js', breakAdd); save(d, 'x'); assert.equal(check(d).code, 1); });
test('claim: no false alarm on a feature with its own test', () => { const d = repo(true); edit(d, 'src/add.js', (s) => s + 'exports.sub=(a,b)=>a-b\n'); edit(d, 'test/add.test.js', (s) => s + "t.test('sub',()=>a.equal(require('../src/add.js').sub(3,1),2))\n"); save(d, 'x'); assert.equal(check(d).code, 0); });
test('claim: no false alarm on a rename that updates its tests, with a note to look', () => { const d = repo(true); edit(d, 'src/add.js', (s) => s.replaceAll('mul', 'times')); edit(d, 'test/add.test.js', (s) => s.replaceAll('mul', 'times')); save(d, 'x'); const r = check(d); assert.equal(r.code, 0); assert.ok(r.metrics.find((m) => m.name === 'tests_pass').heldByTestEdit); });
test('claim: a pass with nothing to re-prove does not say the source earned a win', () => { const d = repo(true); put(d, 'NOTES.md', 'x\n'); save(d, 'x'); const r = sb(d, 'check'); assert.equal(r.code, 0); assert.match(r.out, /held/); assert.doesNotMatch(r.out, /carried the win/); });

// ------------------------------------------------------------ exit codes
test('claim: exit 3 inconclusive when no test can run', () => { const d = mkdtempSync(join(tmpdir(), 'claims-')); git(d, 'init', '-q'); put(d, 'a', '1'); save(d, 'a'); put(d, 'a', '2'); save(d, 'b'); assert.equal(check(d).code, 3); });
test('claim: exit 64 outside a git repository', () => { assert.equal(sb(mkdtempSync(join(tmpdir(), 'claims-')), 'check').code, 64); });

// ------------------------------------------------------------ the stated limits, held as tests so they stay stated
test('limit: a suite weakened while it stays green is not proved: a note, never a failure', () => { const d = repo(true); edit(d, 'src/add.js', breakAdd); edit(d, 'test/add.test.js', (s) => s.replace('a.equal(add(2,2),4)', 'a.ok(true)')); save(d, 'x'); const r = check(d); assert.equal(r.code, 0); assert.ok(r.metrics.find((m) => m.name === 'tests_pass').heldByTestEdit); });
test('limit: a hardcoded answer in the source passes: the check proves the source carried it, not that the source is good', () => { const d = repo(); edit(d, 'src/add.js', (s) => s.replace('(a,b)=>a-b', '(a,b)=>(a===2&&b===2)?4:a-b')); save(d, 'x'); assert.equal(check(d).code, 0); });
test('limit: the Stop hook does not run the tests on uncommitted work', () => { const d = signed(false); const w = wired(d); w.prompt(); w.stop(); w.prompt(); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); assert.ok(!blocked(w.stop())); assert.equal(check(d).code, 2, 'the same tree reads gamed on demand'); });

// ------------------------------------------------------------ signing
test('claim: signing writes the contract and the lock and commits nothing', () => { const d = repo(true); const n = git(d, 'rev-list', '--count', 'HEAD'); assert.equal(sb(d, 'contract').code, 0); assert.equal(git(d, 'rev-list', '--count', 'HEAD'), n); for (const f of ['promptwheel.config.json', 'promptwheel.lock.json', '.promptwheel/packs/supply-chain/scan.mjs']) assert.ok(existsSync(join(d, f)), f); });
test('claim: a signing commit passes its own contract', () => { const d = signed(true); assert.equal(check(d).code, 0); });
test('claim: a signing commit is not a pass when the tests never ran', () => { const d = repo(false); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); assert.notEqual(sb(d, 'check').out.includes('carried the win'), true); });
test('claim: --dry-run writes nothing', () => { const d = repo(true); assert.equal(sb(d, 'contract', '--dry-run').code, 0); assert.equal(git(d, 'status', '--porcelain'), ''); });

// ------------------------------------------------------------ protected paths
for (const [name, f] of [['workflows', '.github/workflows/x.yml'], ['registry config', '.npmrc'], ['build images', 'Dockerfile'], ['publish scripts', 'scripts/release.sh'], ['code owners', 'CODEOWNERS'], ['hook config', '.claude/settings.json'], ['scanners', '.promptwheel/packs/supply-chain/README.md'], ['the lock', 'promptwheel.lock.json']]) {
  test(`claim: a change to ${name} fails the gate`, () => { const d = signed(true); put(d, f, 'x\n'); git(d, 'add', '-A', '-f'); git(d, 'commit', '-qm', 'x'); const r = check(d); assert.equal(r.code, 1); assert.ok((r.mandates || []).length > 0); });
}
test('claim: moving a file out of a protected path counts as touching it', () => { const d = signed(true); put(d, 'scripts/release.sh', 'x\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'p', '-q'); git(d, 'mv', 'scripts/release.sh', 'rel.sh'); git(d, 'commit', '-qm', 'mv'); assert.equal(check(d).code, 1); });
test('claim: a new install script fails the gate', () => { const d = signed(true); json(d, 'package.json', (o) => { o.scripts.postinstall = 'x'; }); save(d, 'x'); assert.equal(check(d).code, 1); });
test('claim: under --strict a new dependency needs a reason from a person', () => { const d = strict(true); json(d, 'package.json', (o) => { o.dependencies = { 'left-pad': '1.3.0' }; }); save(d, 'x'); assert.equal(check(d).code, 1); assert.equal(check(d, '--allow', 'a person said so').code, 0); });
test('claim: under --strict a new network address in the source is caught by the lock', () => { const d = strict(true); edit(d, 'src/add.js', (s) => s + 'exports.x=()=>fetch("https://a.invalid")\n'); save(d, 'x'); assert.equal(check(d).code, 1); });

test('claim: a new contract starts by watching: a new dependency is a note, not a failure', () => { const d = signed(true); json(d, 'package.json', (o) => { o.dependencies = { 'left-pad': '1.3.0' }; }); save(d, 'x'); const r = sb(d, 'check'); assert.equal(r.code, 0); assert.match(r.out, /note: a new dependency/); });
test('claim: ordinary new code is a note, naming what changed', () => { const d = signed(true); put(d, 'src/billing/new.js', 'exports.b=require("fs").readFileSync\n'); save(d, 'x'); const r = sb(d, 'check'); assert.equal(r.code, 0); assert.match(r.out, /note: the shape of the repo changed: .*billing|note: the shape of the repo changed: /); });
test('claim: a new install script still fails in a new contract, and says so in words', () => { const d = signed(true); json(d, 'package.json', (o) => { o.scripts.postinstall = 'x'; }); save(d, 'x'); const r = sb(d, 'check'); assert.equal(r.code, 1); assert.match(r.out, /a new install script/); });
test('claim: signing a GitHub repo adds CI, with no remote it does not', () => { const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); assert.equal(sb(d, 'contract').code, 0); assert.ok(existsSync(join(d, '.github/workflows/sawbuck.yml'))); save(d, 'sign'); assert.equal(check(d).code, 0); const e = repo(true); sb(e, 'contract'); assert.ok(!existsSync(join(e, '.github'))); });
test('claim: the CI check signing adds cannot go red just because tests cannot run there, and installs an npm lockfile without scripts', () => { const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); put(d, 'package-lock.json', '{}\n'); assert.equal(sb(d, 'contract').code, 0); const w = readFileSync(join(d, '.github/workflows/sawbuck.yml'), 'utf8'); assert.match(w, /inconclusive: pass/); assert.match(w, /npm ci --ignore-scripts/); const e = repo(true); git(e, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); sb(e, 'contract'); assert.doesNotMatch(readFileSync(join(e, '.github/workflows/sawbuck.yml'), 'utf8'), /npm ci/); });
test('claim: help leads with three commands', () => { const o = sb(mkdtempSync(join(tmpdir(), 'claims-')), '--help').out; assert.match(o, /contract/); assert.doesNotMatch(o, /memory-conformance/); });

// ------------------------------------------------------------ "editing the rule does not lift it"
test('claim: deleting a rule in the change that breaks it does not lift it', () => { const d = signed(true); json(d, 'promptwheel.config.json', (o) => { o.mandates = []; }); put(d, '.npmrc', 'x\n'); save(d, 'x'); assert.equal(check(d).code, 1); });
test('claim: weakening the contract alone fails, so it cannot be done in two steps', () => { const d = signed(true); json(d, 'promptwheel.config.json', (o) => { o.metrics[0].cmd = 'true'; }); save(d, 'x'); assert.equal(check(d).code, 1); });
test('claim: a person lifts a rule with --allow, and a commit message cannot', () => { const d = signed(true); json(d, 'promptwheel.config.json', (o) => { o.mandates = []; }); save(d, 'drop\n\nPromptwheel-Allow: because'); assert.equal(check(d).code, 1, 'trailer'); assert.equal(check(d, '--allow', 'a person').code, 0); });

test('claim: signing writes the rule, even where a contract already exists', () => { const d = repo(true); put(d, 'promptwheel.config.json', JSON.stringify({ repeat: 1, metrics: [{ name: 'tests_pass', cmd: 'npm test --silent', extract: 'exit', direction: 'pass', guard: true }] })); save(d, 'c'); assert.equal(sb(d, 'contract').code, 0); assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /survives verification/); });
test('claim: attach alone says the rule is missing', () => { const d = repo(true); assert.match(sb(d, 'attach', '--claude').out, /no written rule here yet/); });
test('claim: --purge never deletes a committed LOGBOOK.md', () => { const d = signed(true); put(d, 'LOGBOOK.md', 'mine\n'); git(d, 'add', '-f', 'LOGBOOK.md'); git(d, 'commit', '-qm', 'log'); wired(d); sb(d, 'detach', '--claude', '--purge'); assert.ok(existsSync(join(d, 'LOGBOOK.md'))); });

// ------------------------------------------------------------ the wall, through the hooks attach writes
test('claim: on a clean account a signed repo does not block a clean turn', () => { const d = signed(true); const w = wired(d); for (let i = 0; i < 3; i++) { w.prompt(); assert.ok(!blocked(w.stop()), `turn ${i}`); } assert.equal(git(d, 'status', '--porcelain'), ''); assert.equal(check(d).code, 0); });
test('claim: saying yes to the offer does not block its own turn: signing and attaching mid-turn on a clean account', () => { const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); assert.equal(sb(d, 'contract').code, 0); const w = wired(d); assert.ok(!blocked(w.stop()), 'the signing turn ends'); save(d, 'sign'); w.prompt(); assert.ok(!blocked(w.stop()), 'the next clean turn'); w.prompt(); put(d, '.npmrc', 'x\n'); assert.ok(blocked(w.stop()), 'and the wall still works'); });
test('claim: attaching mid-turn does not spare what the agent does next in that turn', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); const w = wired(d); put(d, '.npmrc', 'x\n'); assert.ok(blocked(w.stop())); });
test('claim: the first turn after attach is checked', () => { const d = signed(false); const w = wired(d); w.prompt(); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'cheat'); assert.ok(blocked(w.stop())); });
test('claim: every turn checks protected paths, uncommitted included', () => { const d = signed(true); const w = wired(d); w.prompt(); put(d, '.npmrc', 'x\n'); assert.ok(blocked(w.stop())); });
test('claim: a person editing a protected path between turns is not the agent', () => { const d = signed(true); const w = wired(d); w.prompt(); w.stop(); put(d, '.npmrc', 'x\n'); w.prompt(); assert.ok(!blocked(w.stop())); });
test('claim: it sends a turn back up to three times by default, then lets it end', () => { const d = signed(true); const w = wired(d); w.prompt(); put(d, '.npmrc', 'x\n'); const seen = []; for (let i = 0; i < 4; i++) seen.push(blocked(w.stop())); assert.deepEqual(seen, [true, true, true, false]); });

test('claim: a blocked protected path counts as one catch, however many send-backs', () => { const d = signed(true); const w = wired(d); w.prompt(); put(d, '.npmrc', 'x\n'); w.stop(); w.stop(); w.stop(); assert.match(sb(d, 'statusline').out, /1 caught/); assert.match(sb(d, 'status').out, /1 protected path/); assert.equal(readFileSync(join(d, '.sawbuck/activity.jsonl'), 'utf8').trim().split('\n').filter((l) => l.includes('"mandate"')).length, 1); });
test('claim: a block does not clear a gamed verdict that still stands', () => { const d = signed(false); const w = wired(d); w.prompt(); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'cheat'); assert.ok(blocked(w.stop())); w.prompt(); put(d, '.npmrc', 'x\n'); w.stop(); assert.equal(JSON.parse(readFileSync(join(d, '.sawbuck/results.json'), 'utf8')).latest.kind, 'gamed'); });
test('claim: the status line names the repo it detected, from any folder of it', () => { const d = signed(true); const w = wired(d); w.prompt(); w.stop(); const n = d.split('/').pop(); assert.match(sb(d, 'statusline').out, new RegExp(`sawbuck · ${n} · watching`)); assert.match(sb(join(d, 'src'), 'statusline').out, new RegExp(n)); });
test('claim: outside a repository the status line says so', () => { assert.match(sb(mkdtempSync(join(tmpdir(), 'claims-')), 'statusline').out, /no repo here/); });
test('claim: attaching a repo under user-level hooks does not wire a second set', () => { const home = mkdtempSync(join(tmpdir(), 'claims-home-')); put(home, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /x/sawbuck.mjs __hook' }] }] } })); const d = signed(true); const r = spawnSync(process.execPath, [CLI, 'attach', '--claude'], { cwd: d, encoding: 'utf8', env: { ...ENV, HOME: home } }); assert.match(r.stdout, /user-level/); assert.ok(!existsSync(join(d, '.claude/settings.local.json'))); });

test('claim: a repo watched by user-level hooks is not blocked by sawbuck\'s own record', () => { const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const env = { ...ENV, HOME: home }; const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); const hook = (args, ev) => spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: 's', prompt: 'x' }) }).stdout || ''; hook(['turn', '--hook'], 'UserPromptSubmit'); assert.equal(git(d, 'status', '--porcelain'), '', 'nothing of ours shows up'); assert.ok(!blocked(hook(['__hook', '--by', 'claude', '--stop'], 'Stop'))); });

test('claim: clearing the npx cache does not turn the wall off', () => { if (process.env.CLAIMS_SAWBUCK) return; const root = mkdtempSync(join(tmpdir(), 'claims-npx-')); const pkg = join(root, '_npx', 'x', 'sawbuck'); mkdirSync(dirname(pkg), { recursive: true }); execFileSync('cp', ['-r', join(HERE, '..'), pkg]); const d = signed(true); const r = spawnSync(process.execPath, [join(pkg, 'sawbuck.mjs'), 'attach', '--claude'], { cwd: d, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, r.stderr); const cmd = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks.Stop[0].hooks[0].command; rmSync(pkg, { recursive: true }); const bin = join(root, 'bin'); put(bin, 'npx', '#!/bin/sh\necho "fallback: $*"\n'); execFileSync('chmod', ['+x', join(bin, 'npx')]); const o = spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', env: { ...ENV, PATH: `${bin}:${ENV.PATH}` } }); assert.match(o.stdout, /fallback: -y sawbuck@.* __hook/); });

// ------------------------------------------------------------ history that a rewrite erased
const lessons = (attached) => {
  const d = signed(true); const w = attached ? wired(d) : null;
  put(d, 'src/cache.js', 'exports.c={}\n'); save(d, 'add a result cache'); git(d, 'revert', '--no-edit', 'HEAD');
  edit(d, 'src/add.js', (s) => s + '// a\n'); save(d, 'keep going');
  return { d, w };
};
const squash = (d) => { git(d, 'reset', '-q', '--soft', 'HEAD~3'); git(d, 'commit', '-qm', 'all in one'); };
test('claim: a revert erased by a squash comes back in context for that path', () => { const { d } = lessons(false); squash(d); put(d, 'src/cache.js', 'y\n'); const o = sb(d, 'context').out; assert.match(o, /reverted: Revert "add a result cache"/); });
test('claim: the ledger outlives the reflog once a repo is attached', () => { const { d, w } = lessons(true); w.prompt(); w.stop(); squash(d); put(d, 'src/cache.js', 'y\n'); w.prompt(); git(d, 'reflog', 'expire', '--expire=now', '--all'); git(d, 'gc', '-q', '--prune=now'); assert.match(sb(d, 'context').out, /Revert "add a result cache"/); });
test('claim: an amend is not reported as lost work', () => { const d = signed(true); put(d, 'src/x.js', '1\n'); save(d, 'add x'); put(d, 'src/x.js', '2\n'); git(d, 'add', '-A'); git(d, 'commit', '-q', '--amend', '--no-edit'); put(d, 'src/x.js', '3\n'); assert.doesNotMatch(sb(d, 'context').out, /erased by a rewrite/); });
test('claim: an unattached repo gets no files from this', () => { const { d } = lessons(false); squash(d); put(d, 'src/cache.js', 'y\n'); sb(d, 'context'); assert.ok(!existsSync(join(d, '.sawbuck'))); });
test('limit: the ledger is local, so a clone does not get it', () => { const { d } = lessons(true); squash(d); sb(d, 'context'); const c = mkdtempSync(join(tmpdir(), 'claims-')); git(c, 'clone', '-q', d, 'c'); assert.ok(!existsSync(join(c, 'c/.sawbuck'))); });
test('limit: nothing before the reflog is recovered, and work never committed is not in git at all', () => { const { d } = lessons(false); squash(d); git(d, 'reflog', 'expire', '--expire=now', '--all'); git(d, 'gc', '-q', '--prune=now'); put(d, 'src/cache.js', 'y\n'); assert.doesNotMatch(sb(d, 'context').out, /Revert/); });

// ------------------------------------------------------------ the steer scratchpad
const steerHome = (steers, stats = { scored: steers.length, lost: 0 }) => { const h = mkdtempSync(join(tmpdir(), 'claims-home-')); put(h, '.claude/plugins/store/sawbuck-reins_x.json', JSON.stringify({ steers, steerStats: stats })); return h; };
const steersOut = (h, ...a) => spawnSync(process.execPath, [CLI, 'steers', ...a], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout;
test('claim: a steer repeated 3 times across 2 sessions is shown, with a pointer to write it down', () => { const e = (session, repo) => ({ session, repo, nudge: 'verify before trusting' }); const o = steersOut(steerHome([e('1', 'a'), e('1', 'b'), e('2', '')])); assert.match(o, /3x {2}verify before trusting {2}\(a, b, no repo\)/); assert.match(o, /write it down/); });
test('claim: a steer from one session is not called a pattern', () => { const e = { session: '1', repo: 'a', nudge: 'verify first' }; assert.match(steersOut(steerHome([e, e, e])), /Nothing repeats yet/); });
test('claim: replies that could not be scored are shown as an undercount', () => { assert.match(steersOut(steerHome([{ session: '1', repo: 'a', nudge: 'x y' }], { scored: 1, lost: 4 })), /4 could not be scored, so this undercounts/); });
test('claim: the scratchpad report reads only: it writes no file', () => { const h = steerHome([]); steersOut(h); assert.deepEqual(readdirSync(join(h, '.claude/plugins/store')), ['sawbuck-reins_x.json']); assert.ok(!existsSync(join(h, '.sawbuck'))); });

// ------------------------------------------------------------ finding the rules nobody wrote
const historyHome = (msgs) => { const h = mkdtempSync(join(tmpdir(), 'claims-home-')); put(h, '.claude/projects/p/s.jsonl', msgs.map((m, i) => JSON.stringify({ type: 'user', uuid: String(i), timestamp: `2026-01-0${(i % 9) + 1}`, message: { role: 'user', content: m } })).join('\n') + '\n'); return h; };
const rulesRun = (h, ...a) => spawnSync(process.execPath, [CLI, 'rules', ...a], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout;
test('claim: rules --prepare keeps your words, drops copies, and leaves out what looks like a secret', () => { const h = historyHome(['never use em dashes in copy', 'never use em dashes in copy', 'my token=abcd1234efgh please use it', 'key is ghp_abcdefghijklmnopqrstuvwxyz123456', '<system>noise from the harness here</system>']); const o = rulesRun(h, '--prepare'); assert.match(o, /2 that looked like secrets left out/); const t = readFileSync(join(h, '.sawbuck/rule-input.txt'), 'utf8'); assert.equal(t.trim(), 'never use em dashes in copy'); });
test('claim: a proposed rule needs 2 quotes that are really yours; an invented quote does not count', () => { const h = historyHome(['always verify from the live registry', 'did you verify that on npm yet', 'stop saying it works before checking']); rulesRun(h, '--prepare'); const f = join(h, 'c.json'); writeFileSync(f, JSON.stringify([{ rule: 'Verify first', quotes: ['verify from the live registry', 'did you verify that on npm'] }, { rule: 'Made up', quotes: ['always verify from the live registry', 'a sentence nobody ever typed'] }])); const o = rulesRun(h, '--check', f); assert.match(o, /1 rules have at least 2 quotes/); assert.match(o, /1 dropped/); assert.match(o, /Verify first/); assert.doesNotMatch(o, /Made up/); });
test('claim: the rules command writes no rule anywhere: only its input file under ~/.sawbuck', () => { const h = historyHome(['never use em dashes in copy']); const d = repo(true); rulesRun(h, '--prepare'); assert.deepEqual(readdirSync(join(h, '.sawbuck')), ['rule-input.txt']); assert.equal(git(d, 'status', '--porcelain'), ''); });

test('claim: signing writes no personal rule into a file the team shares', () => { const home = mkdtempSync(join(tmpdir(), 'claims-home-')); put(home, '.sawbuck/rules.md', 'Never use em dashes\n'); const d = repo(true); const r = spawnSync(process.execPath, [CLI, 'contract'], { cwd: d, encoding: 'utf8', env: { ...ENV, HOME: home } }); assert.equal(r.status, 0); assert.doesNotMatch(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /em dashes/); });
test('claim: signing again keeps a Standing rules section someone wrote in the block', () => { const d = repo(true); sb(d, 'contract'); const p = join(d, 'AGENTS.md'); put(d, 'AGENTS.md', readFileSync(p, 'utf8').replace('<!-- /sawbuck:contract -->', '\n### Standing rules\n\n- Keep this one\n<!-- /sawbuck:contract -->')); sb(d, 'contract'); const t = readFileSync(p, 'utf8'); assert.equal(t.match(/Keep this one/g).length, 1); assert.equal(t.match(/sawbuck:contract -->/g).length, 2); });
test('claim: a session gets the rule once, and again after a compaction, not on every prompt', () => { const d = signed(true); const w = wired(d); assert.match(w.prompt(), /protected, do not touch/); w.stop(); assert.equal(w.prompt().trim(), ''); w.stop(); assert.match(w.compact(), /protected, do not touch/); });
test('claim: history is on demand, and per turn only if you ask for it', () => { const { d } = lessons(true); const w = wired(d); squash(d); put(d, 'src/cache.js', 'y\n'); assert.doesNotMatch(w.prompt(), /relevant history|not in git history/); w.stop(); put(d, 'sawbuck.config.json', '{"turn":{"context":true}}'); assert.match(wired(d, 'other').prompt(), /not in git history/); });
test('claim: a steer rate nobody updated for a week is not shown', () => { const d = signed(true); put(d, '.sawbuck/steer.json', JSON.stringify({ scored: 5, ema: 0.3, at: new Date(Date.now() - 8 * 864e5).toISOString() })); assert.doesNotMatch(sb(d, 'statusline').out, /steer/); put(d, '.sawbuck/steer.json', JSON.stringify({ scored: 5, ema: 0.3, at: new Date().toISOString() })); assert.match(sb(d, 'statusline').out, /steer 30%/); });
test('claim: signing copies only the scanners it runs', () => { const d = signed(true); assert.deepEqual(readdirSync(join(d, '.promptwheel/packs/supply-chain')).sort(), ['lock.mjs', 'scan.mjs']); assert.equal(check(d).code, 0); });

// ------------------------------------------------------------ the steering shape
const shapeRun = (h, ...a) => spawnSync(process.execPath, [CLI, 'shape', ...a], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout;
const labelFile = (h, m) => { const f = join(h, 'l.json'); writeFileSync(f, JSON.stringify(m)); return f; };
test('claim: the shape shows totals and never a single message', () => { const h = historyHome(['never push to main please']); shapeRun(h, '--prepare'); const m = {}; for (let i = 0; i < 300; i++) m[i] = ['proof', 'scope', 'none', 'voice'][i % 4]; const o = shapeRun(h, '--check', labelFile(h, m)); assert.match(o, /Truth/); assert.match(o, /Proof \d+/); assert.doesNotMatch(o, /never push to main/); assert.doesNotMatch(readFileSync(join(h, '.sawbuck/shape-history.jsonl'), 'utf8'), /never push/); assert.match(readFileSync(join(h, '.sawbuck/shape.svg'), 'utf8'), /<svg/); });
test('claim: a small history shows the 4 groups, not 12 spokes it cannot support', () => { const h = historyHome(['x y z message']); const m = {}; for (let i = 0; i < 40; i++) m[i] = i % 2 ? 'proof' : 'scope'; const o = shapeRun(h, '--check', labelFile(h, m)); assert.match(o, /Too few messages/); assert.doesNotMatch(o, /Proof \d+/); });
test('claim: a later shape shows what changed since the last one', () => { const h = historyHome(['x y z message']); const f = (p) => { const m = {}; for (let i = 0; i < 300; i++) m[i] = i % 2 ? p : 'scope'; return labelFile(h, m); }; shapeRun(h, '--check', f('proof')); assert.match(shapeRun(h, '--check', f('naming')), /\(was \d+%\)/); });
test('claim: an invented label is ignored', () => { const h = historyHome(['x y z message']); const o = shapeRun(h, '--check', labelFile(h, { 1: 'genius', 2: 'proof' })); assert.match(o, /from 1 messages/); });

test('claim: the shape reads what you said against what the agent did, and names both kinds of pattern', () => { const h = historyHome(['x y z message']); put(h, '.sawbuck/shape-exposure.json', JSON.stringify({ turns: 100, working: 100, code: 50, unverified: 20, risky: 30, big: 1, shipped: 1, ui: 1, copy: 1, renames: 0, asked: 1 })); const m = {}; for (let i = 0; i < 300; i++) m[i] = i % 3 ? 'proof' : 'scope'; const o = shapeRun(h, '--check', labelFile(h, m)); assert.match(o, /Fighting it: Proof/); assert.match(o, /Not said: Safety/); assert.match(o, /20 of 50/); assert.doesNotMatch(o, /Not said: Naming/); });
test('claim: a check within the next 3 turns counts, and deleting a temp folder is not risk', async () => { const { exposure } = await import(process.env.CLAIMS_SAWBUCK ? join(dirname(process.env.CLAIMS_SAWBUCK), 'exposure.mjs') : '../exposure.mjs'); const h = mkdtempSync(join(tmpdir(), 'claims-home-')); const u = (i) => JSON.stringify({ type: 'user', uuid: `u${i}`, message: { content: 'go on then' } }); const tool = (i, name, input) => JSON.stringify({ type: 'assistant', uuid: `a${i}`, message: { content: [{ type: 'tool_use', name, input }] } }); put(h, 'p/s.jsonl', [u(1), tool(1, 'Edit', { file_path: 'a.js', old_string: 'a', new_string: 'b' }), u(2), tool(2, 'Bash', { command: 'npm test' }), u(3), tool(3, 'Bash', { command: 'rm -rf /tmp/x' }), u(4), tool(4, 'Edit', { file_path: 'b.js', old_string: 'a', new_string: 'b' })].join('\n') + '\n'); const c = exposure({ root: h }); assert.equal(c.code, 2); assert.equal(c.unverified, 1); assert.equal(c.risky, 0); });

test('claim: plain activity is never called a fight: shipping is not a failure', () => { const h = historyHome(['x y z message']); put(h, '.sawbuck/shape-exposure.json', JSON.stringify({ turns: 100, working: 100, code: 50, unverified: 1, risky: 1, big: 1, shipped: 60, ui: 1, copy: 1, renames: 0, asked: 1 })); const m = {}; for (let i = 0; i < 300; i++) m[i] = i % 3 ? 'process' : 'scope'; assert.doesNotMatch(shapeRun(h, '--check', labelFile(h, m)), /Fighting it: Process/); });

test('claim: a blind spot you already wrote down is not reported as one, and a rule that is not holding says so', () => { const h = historyHome(['x y z message']); put(h, '.sawbuck/shape-exposure.json', JSON.stringify({ turns: 100, working: 100, code: 50, unverified: 20, risky: 30, big: 1, shipped: 1, ui: 1, copy: 1, renames: 0, asked: 1, written: { safety: true, proof: true } })); const m = {}; for (let i = 0; i < 300; i++) m[i] = i % 3 ? 'proof' : 'scope'; const o = shapeRun(h, '--check', labelFile(h, m)); assert.doesNotMatch(o, /Not said: Safety/); assert.match(o, /Written down already, so left out: Safety/); assert.match(o, /not holding/); });
test('claim: a pattern comes with a rule you can use', () => { const h = historyHome(['x y z message']); put(h, '.sawbuck/shape-exposure.json', JSON.stringify({ turns: 100, working: 100, code: 50, unverified: 1, risky: 30, big: 1, shipped: 1, ui: 1, copy: 1, renames: 0, asked: 1 })); const m = {}; for (let i = 0; i < 300; i++) m[i] = 'scope'; assert.match(shapeRun(h, '--check', labelFile(h, m)), /Try: Ask before force pushing/); });
test('claim: what the agent did counts recent, real work: scratch files and old sessions are left out', async () => { const { exposure } = await import(process.env.CLAIMS_SAWBUCK ? join(dirname(process.env.CLAIMS_SAWBUCK), 'exposure.mjs') : '../exposure.mjs'); const h = mkdtempSync(join(tmpdir(), 'claims-home-')); const now = new Date().toISOString(); const u = (i, t) => JSON.stringify({ type: 'user', uuid: `u${i}`, timestamp: t, message: { content: 'go on then' } }); const e = (i, t, p) => JSON.stringify({ type: 'assistant', uuid: `a${i}`, timestamp: t, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: p, old_string: 'a', new_string: 'b' } }] } }); put(h, 'p/s.jsonl', [u(1, now), e(1, now, '/tmp/x/a.js'), u(2, '2020-01-01T00:00:00Z'), e(2, '2020-01-01T00:00:00Z', 'old.js'), u(3, now), e(3, now, 'src/b.js')].join('\n') + '\n'); const c = exposure({ root: h }); assert.equal(c.code, 1); });

test('claim: --png saves an image with a tool already on the machine, and says so when there is none', () => { const h = historyHome(['x y z message']); const f = labelFile(h, { 1: 'proof' }); const bin = join(h, 'bin'); mkdirSync(bin); const run = (p) => spawnSync(process.execPath, [CLI, 'shape', '--check', f, '--png'], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h, PATH: p } }).stdout; assert.match(run(bin), /No image tool here/); assert.ok(!existsSync(join(h, '.sawbuck/shape.png'))); writeFileSync(join(bin, 'rsvg-convert'), '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done; echo png > "$2"\n', { mode: 0o755 }); assert.match(run(`${bin}:/bin:/usr/bin`), /Image to share: .*shape\.png/); assert.ok(existsSync(join(h, '.sawbuck/shape.png'))); });
test('claim: a pattern needs enough turns behind it', () => { const h = historyHome(['x y z message']); put(h, '.sawbuck/shape-exposure.json', JSON.stringify({ turns: 3, working: 3, code: 1, unverified: 1, risky: 1, big: 0, shipped: 0, ui: 0, copy: 0, renames: 0, asked: 1 })); const m = {}; for (let i = 0; i < 300; i++) m[i] = 'scope'; const o = shapeRun(h, '--check', labelFile(h, m)); assert.doesNotMatch(o, /Not said|Fighting it/); assert.match(o, /Not enough recent turns/); });

// ------------------------------------------------------------ leaving
test('claim: detach removes the hooks', () => { const d = signed(true); wired(d); assert.equal(sb(d, 'detach', '--claude').code, 0); assert.ok(!existsSync(join(d, '.claude/settings.local.json'))); });
test('claim: the signed contract stays after detach, and --purge removes the record', () => { const d = signed(true); wired(d); check(d); sb(d, 'detach', '--claude', '--purge'); assert.ok(existsSync(join(d, 'promptwheel.config.json'))); assert.ok(!existsSync(join(d, '.sawbuck'))); assert.ok(!existsSync(join(d, '.promptwheel/outcomes.jsonl'))); });
