// Every public claim as a test, the stated limits included. A sentence on the site or in a README that has no
// test here is a sentence nobody has checked. CLAIMS_SAWBUCK points this at an installed package, so the same
// file proves what is on npm: CLAIMS_SAWBUCK=/path/to/node_modules/sawbuck/sawbuck.mjs node --test test/claims.test.mjs
// Runs on a clean account on purpose: a developer's global gitignore hid a bug that blocked every turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, lstatSync, chmodSync, symlinkSync } from 'node:fs';
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
const signed = (good = true, ...flags) => { const d = repo(good); assert.equal(sb(d, 'contract', '--full', ...flags).code, 0); save(d, 'sign'); return d; };
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
test('claim: signing writes the contract and the lock and commits nothing', () => { const d = repo(true); const n = git(d, 'rev-list', '--count', 'HEAD'); assert.equal(sb(d, 'contract', '--full').code, 0); assert.equal(git(d, 'rev-list', '--count', 'HEAD'), n); for (const f of ['promptwheel.config.json', 'promptwheel.lock.json', '.promptwheel/packs/supply-chain/scan.mjs']) assert.ok(existsSync(join(d, f)), f); });
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
test('claim: signing a GitHub repo adds CI, with no remote it does not', () => { const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); assert.equal(sb(d, 'contract', '--full').code, 0); assert.ok(existsSync(join(d, '.github/workflows/sawbuck.yml'))); save(d, 'sign'); assert.equal(check(d).code, 0); const e = repo(true); sb(e, 'contract', '--full'); assert.ok(!existsSync(join(e, '.github'))); });
test('claim: the CI check signing adds cannot go red just because tests cannot run there, and installs an npm lockfile without scripts', () => { const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); put(d, 'package-lock.json', '{}\n'); assert.equal(sb(d, 'contract', '--full').code, 0); const w = readFileSync(join(d, '.github/workflows/sawbuck.yml'), 'utf8'); assert.match(w, /inconclusive: pass/); assert.match(w, /npm ci --ignore-scripts/); const e = repo(true); git(e, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); sb(e, 'contract', '--full'); assert.doesNotMatch(readFileSync(join(e, '.github/workflows/sawbuck.yml'), 'utf8'), /npm ci/); });
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
test('claim: a sent-back protected path says how a person accepts it: --allow for the rules file and the hooks, removing the rule for the rest', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); put(d, 'Dockerfile', 'FROM node:22\n'); save(d, 'docker'); let o = sb(d, 'check').out; assert.match(o, /sent back/); assert.match(o, /remove that rule from promptwheel\.config\.json in a commit of its own/); assert.doesNotMatch(o, /sawbuck check --allow/); assert.equal(sb(d, 'check', '--allow', 'I asked for it').code, 1, 'and --allow really does not clear it'); git(d, 'reset', '-q', '--hard', 'HEAD~1'); put(d, '.claude/settings.json', '{}\n'); save(d, 'hooks'); o = sb(d, 'check').out; assert.match(o, /sawbuck check --allow "<reason>"/); assert.doesNotMatch(o, /remove that rule/); assert.equal(sb(d, 'check', '--allow', 'team hooks').code, 0); });
test('claim: attach --shared in a repo that already has its rules says the commit of that file needs --allow; with no rules it does not', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); assert.match(sb(d, 'attach', '--shared').out, /protected path in this repo[^\n]*--allow "team hooks"/); const e = repo(true); assert.doesNotMatch(sb(e, 'attach', '--shared').out, /protected path in this repo/); });
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
test('claim: the reason in a revert comes back with it, and a squash takes only the commits', () => { const d = signed(true); put(d, 'src/cache.js', 'exports.c={}\n'); save(d, 'add a result cache'); git(d, 'revert', '--no-edit', 'HEAD'); git(d, 'commit', '-q', '--amend', '-m', 'Revert "add a result cache"\n\nThe cache held live sessions and evicting logged people out.\n\nThis reverts commit abcdef0.'); edit(d, 'src/add.js', (s) => s + '// a\n'); save(d, 'keep going'); git(d, 'reset', '-q', '--soft', 'HEAD~3'); git(d, 'commit', '-qm', 'all in one'); put(d, 'src/cache.js', 'y\n'); const o = sb(d, 'context').out; assert.match(o, /reverted: Revert "add a result cache" \([0-9a-f]{12}, \d{4}-\d\d-\d\d\): The cache held live sessions and evicting logged people out\./); assert.doesNotMatch(o, /This reverts commit/); });
test('claim: a lost commit that a rebase replayed is listed once', () => { const d = signed(true); git(d, 'checkout', '-qb', 'feat'); put(d, 'src/cache.js', 'exports.c={}\n'); save(d, 'add a result cache'); git(d, 'revert', '--no-edit', 'HEAD'); edit(d, 'src/add.js', (s) => s + '// a\n'); save(d, 'keep going'); git(d, 'checkout', '-q', 'main'); put(d, 'README.md', 'main moved\n'); save(d, 'main moves on'); git(d, 'checkout', '-q', 'feat'); git(d, 'rebase', '-q', 'main'); git(d, 'commit', '-q', '--amend', '--no-edit'); edit(d, 'src/add.js', (s) => s + '// main moved\n'); save(d, 'tweak on feat'); git(d, 'checkout', '-q', 'main'); git(d, 'merge', '-q', '--squash', 'feat'); git(d, 'commit', '-qm', 'feature (#1)'); git(d, 'branch', '-qD', 'feat'); put(d, 'src/cache.js', 'y\n'); const o = sb(d, 'context').out; assert.equal((o.match(/add a result cache/g) || []).length, 2, 'the attempt once and its revert once:\n' + o); });
test('claim: an amend is not reported as lost work', () => { const d = signed(true); put(d, 'src/x.js', '1\n'); save(d, 'add x'); put(d, 'src/x.js', '2\n'); git(d, 'add', '-A'); git(d, 'commit', '-q', '--amend', '--no-edit'); put(d, 'src/x.js', '3\n'); assert.doesNotMatch(sb(d, 'context').out, /erased by a rewrite/); });
test('claim: an unattached repo gets no files from this', () => { const { d } = lessons(false); squash(d); put(d, 'src/cache.js', 'y\n'); sb(d, 'context'); assert.ok(!existsSync(join(d, '.sawbuck'))); });
test('limit: the ledger is local, so a clone does not get it', () => { const { d } = lessons(true); squash(d); sb(d, 'context'); const c = mkdtempSync(join(tmpdir(), 'claims-')); git(c, 'clone', '-q', d, 'c'); assert.ok(!existsSync(join(c, 'c/.sawbuck'))); });
test('limit: nothing before the reflog is recovered, and work never committed is not in git at all', () => { const { d } = lessons(false); squash(d); git(d, 'reflog', 'expire', '--expire=now', '--all'); git(d, 'gc', '-q', '--prune=now'); put(d, 'src/cache.js', 'y\n'); assert.doesNotMatch(sb(d, 'context').out, /Revert/); });

// ------------------------------------------------------------ the steer scratchpad
const steerHome = (steers, stats = { scored: steers.length, lost: 0 }) => { const h = mkdtempSync(join(tmpdir(), 'claims-home-')); put(h, '.claude/plugins/store/sawbuck-reins_x.json', JSON.stringify({ steers, steerStats: stats })); return h; };
const steersOut = (h, ...a) => spawnSync(process.execPath, [CLI, 'steers', ...a], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout;
test('claim: a steer repeated 3 times across 2 sessions is shown, with a pointer to write it down', () => { const e = (session, repo) => ({ session, repo, nudge: 'verify before trusting' }); const o = steersOut(steerHome([e('1', 'a'), e('1', 'b'), e('2', '')])); assert.match(o, /3x {2}verify before trusting {2}\(a, b, no repo\)/); assert.match(o, /write it down/); });
test('claim: status shows what you keep saying, and says nothing when nothing repeats', () => { const e = (session, repo) => ({ session, repo, nudge: 'verify it live first' }); const d = repo(true); const run = (h) => spawnSync(process.execPath, [CLI, 'status'], { cwd: d, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout; const o = run(steerHome([e('1', 'a'), e('1', 'a'), e('2', 'b')])); assert.match(o, /You keep saying/); assert.match(o, /3x\s+verify it live first/); assert.doesNotMatch(run(steerHome([e('1', 'a')])), /You keep saying/); });
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

test('claim: a gamed catch names the test that was edited, not a file that changed beside it', () => { const d = signed(false); const w = wired(d); w.prompt(); put(d, 'NOTES.md', 'notes\n'); edit(d, 'test/add.test.js', (t) => t.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green'); assert.ok(blocked(w.stop())); const r = JSON.parse(readFileSync(join(d, '.sawbuck/results.json'), 'utf8')); assert.equal(r.latest.kind, 'gamed'); assert.equal(r.latest.file, 'test/add.test.js'); });
test('claim: output piped to a reader that stops early ends quietly, with no stack trace', () => { const d = repo(true); const r = spawnSync('sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} attach . 2>err.txt | head -1`], { cwd: d, encoding: 'utf8', env: ENV }); assert.match(r.stdout, /sawbuck/); assert.doesNotMatch(readFileSync(join(d, 'err.txt'), 'utf8'), /EPIPE|throw er/); });
test('claim: a debt gate of 0 means any new debt, and a clean branch passes it in text and JSON alike', () => { const d = repo(true); assert.equal(sb(d, 'debt', '--since', 'HEAD', '--fail-on', '0').code, 0); const j = sb(d, 'debt', '--since', 'HEAD', '--fail-on', '0', '--json'); assert.equal(j.code, 0, j.out); assert.equal(JSON.parse(j.out).fail, false); });
test('claim: set up from a terminal, commit, then start: the first turn is not blocked by your own commit, and the next violation still is', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); const w = wired(d); save(d, 'rules and hooks'); w.prompt(); assert.ok(!blocked(w.stop()), 'the commit of the rules files is the person\'s'); w.prompt(); put(d, '.github/workflows/x.yml', 'on: push\n'); assert.ok(blocked(w.stop())); });
test('claim: status works from a subfolder of the repo', () => { const d = signed(true); mkdirSync(join(d, 'src/deep'), { recursive: true }); const r = spawnSync(process.execPath, [CLI, 'status'], { cwd: join(d, 'src/deep'), encoding: 'utf8', env: ENV }); assert.doesNotMatch(r.stdout, /Not a git repo/); assert.match(r.stdout, /sawbuck ·/); });
test('claim: detach --user from any folder takes the user-level entry off the list', () => { const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const env = { ...ENV, HOME: home }; const run = (d, ...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: d, encoding: 'utf8', env }); return (r.stdout || '') + (r.stderr || ''); }; const a = repo(true), b = repo(true); run(a, 'attach', '--user'); assert.match(run(a, 'doctor', '--all'), /user/); run(b, 'detach', '--user'); assert.match(run(a, 'doctor', '--all'), /not attached anywhere/); });
test('claim: attach --git leaves a hook that is not a shell script, or not executable, as it found it', () => { const d = repo(true); const pc = join(d, '.git/hooks/post-commit'); put(d, '.git/hooks/post-commit', '#!/usr/bin/env python3\nprint("mine")\n'); chmodSync(pc, 0o755); let r = sb(d, 'attach', '--git'); assert.equal(r.code, 64, r.out); assert.match(r.out, /not a shell script/); assert.equal(readFileSync(pc, 'utf8'), '#!/usr/bin/env python3\nprint("mine")\n'); put(d, '.git/hooks/post-commit', '#!/bin/sh\necho mine\n'); chmodSync(pc, 0o644); r = sb(d, 'attach', '--git'); assert.equal(r.code, 64, r.out); assert.match(r.out, /not executable/); assert.equal(statSync(pc).mode & 0o111, 0, 'still not executable'); assert.equal(readFileSync(pc, 'utf8'), '#!/bin/sh\necho mine\n'); });
test('claim: under user-level hooks, attach says what is still missing in a repo with no rules', () => { const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const env = { ...ENV, HOME: home }; const run = (d, ...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: d, encoding: 'utf8', env }); return (r.stdout || '') + (r.stderr || ''); }; const a = repo(true), b = repo(true); run(a, 'attach', '--user'); assert.match(run(b, 'attach'), /sawbuck contract/); });
test('claim: a protected path the agent changed and committed counts as one catch, not two', () => { const d = signed(true); const w = wired(d); w.prompt(); w.stop(); w.prompt(); put(d, '.github/workflows/x.yml', 'on: push\n'); save(d, 'add a workflow'); assert.ok(blocked(w.stop())); const r = JSON.parse(readFileSync(join(d, '.sawbuck/results.json'), 'utf8')); assert.equal((r.mandates || 0) + (r.regressions || 0) + (r.gamed || 0), 1, JSON.stringify(r)); assert.match(sb(d, 'statusline').out, /1 caught/); });
// ------------------------------------------------------------ the other ways to attach
// A git hook under test must not find a global sawbuck: the test command names node by its full path, and commits run with a bare PATH.
const NODE_TESTS = JSON.stringify({ repeat: 1, metrics: [{ name: 'tests_pass', cmd: `${JSON.stringify(process.execPath)} --test 2>&1`, extract: 'exit', direction: 'up', guard: true }] });
const hookRepo = (good = false) => { const d = repo(good); put(d, 'promptwheel.config.json', NODE_TESTS); save(d, 'config'); return d; };
const commit = (d, msg, path = '/usr/bin:/bin') => { git(d, 'add', '-A'); const r = spawnSync('git', ['commit', '-qm', msg], { cwd: d, encoding: 'utf8', env: { ...ENV, PATH: path } }); return (r.stdout || '') + (r.stderr || ''); };
const record = (d, f = 'results.json') => { try { return JSON.parse(readFileSync(join(d, '.sawbuck', f), 'utf8')); } catch { return {}; } };
const cheat = (s) => s.replace('add(2,2),4', 'add(2,2),0');
test('claim: attach --git checks every commit, whatever made it, starting with the first one', () => { const d = hookRepo(); assert.equal(sb(d, 'attach', '--git').code, 0); assert.ok(!existsSync(join(d, '.claude')), 'no Claude settings'); edit(d, 'test/add.test.js', cheat); commit(d, 'make it green'); assert.ok((record(d).gamed || 0) >= 1, 'the first commit after attach was caught by the hook, with no sawbuck on PATH'); });
test('claim: attach --shared writes a team file with no path from this machine, and removing the hooks shows in git', () => { const d = repo(true); const r = sb(d, 'attach', '--shared'); assert.equal(r.code, 0); assert.match(r.out, /commit \.claude\/settings\.json/); const f = join(d, '.claude/settings.json'); const text = readFileSync(f, 'utf8'); const cmds = Object.values(JSON.parse(text).hooks).flat().flatMap((h) => h.hooks.map((x) => x.command)); assert.equal(cmds.length, 3); for (const c of cmds) assert.match(c, /^npx -y sawbuck@\d+\.\d+\.\d+ (turn --hook|__hook --by claude --stop)$/); assert.ok(!text.includes(d) && !text.includes(HOME) && !text.includes('sawbuck.mjs'), 'nothing machine-specific'); assert.match(git(d, 'status', '--porcelain'), /\.claude\//, 'the file is visible to git'); save(d, 'share the hooks'); put(d, '.claude/settings.json', '{}\n'); assert.match(git(d, 'status', '--porcelain'), /M \.claude\/settings\.json/, 'a removal shows'); git(d, 'checkout', '.claude/settings.json'); assert.equal(sb(d, 'detach').code, 0); assert.ok(!/sawbuck/.test(existsSync(f) ? readFileSync(f, 'utf8') : '')); });
test('claim: shared hooks find the repo from where they run, and block a protected path', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); assert.equal(sb(d, 'attach', '--shared').code, 0); const h = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks; const run = (cmd, ev) => { const args = cmd.replace(/^npx -y sawbuck@[\d.]+ /, '').split(' '); return spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: 'shared', prompt: 'x' }) }).stdout || ''; }; run(h.UserPromptSubmit[0].hooks[0].command, 'UserPromptSubmit'); put(d, '.github/workflows/x.yml', 'on: push\n'); assert.ok(blocked(run(h.Stop[0].hooks[0].command, 'Stop'))); });
test('claim: detach --all takes sawbuck out of every repo, and doctor --all lists them first', () => { const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const env = { ...ENV, HOME: home }; const run = (d, ...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: d, encoding: 'utf8', env }); return (r.stdout || '') + (r.stderr || ''); }; const a = repo(true), b = repo(true); run(a, 'attach'); run(b, 'attach', '--git'); const list = run(a, 'doctor', '--all'); assert.ok(list.includes(a) && list.includes(b), list); assert.match(run(a, 'detach', '--all'), /detached everywhere/); assert.ok(!existsSync(join(a, '.claude/settings.local.json')) && !existsSync(join(b, '.git/hooks/post-commit'))); assert.match(run(a, 'doctor', '--all'), /not attached anywhere/); });
test('claim: detach --dry-run shows what would go and changes nothing', () => { const d = repo(true); sb(d, 'attach'); const before = readFileSync(join(d, '.claude/settings.local.json'), 'utf8'); const r = sb(d, 'detach', '--dry-run'); assert.match(r.out, /would remove/); assert.match(r.out, /settings\.local\.json/); assert.equal(readFileSync(join(d, '.claude/settings.local.json'), 'utf8'), before); });

// ------------------------------------------------------------ the steering shape
const shapeRun = (h, ...a) => spawnSync(process.execPath, [CLI, 'shape', ...a], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout;
test('claim: your gathered messages and the quotes drawn from them are deleted once the rules check has run', () => { const h = historyHome(['always verify from the live registry', 'did you verify that on npm yet']); rulesRun(h, '--prepare'); const f = join(h, '.sawbuck/rule-candidates.json'); writeFileSync(f, JSON.stringify([{ rule: 'Verify first', quotes: ['verify from the live registry', 'did you verify that on npm'] }])); assert.match(rulesRun(h, '--check', f), /1 rules have at least 2 quotes/); assert.deepEqual(readdirSync(join(h, '.sawbuck')), []); });
test('claim: a candidates file outside ~/.sawbuck is the person\'s own and is left alone', () => { const h = historyHome(['always verify from the live registry', 'did you verify that on npm yet']); rulesRun(h, '--prepare'); const f = join(h, 'c.json'); writeFileSync(f, JSON.stringify([{ rule: 'Verify first', quotes: ['verify from the live registry', 'did you verify that on npm'] }])); rulesRun(h, '--check', f); assert.ok(existsSync(f)); assert.ok(!existsSync(join(h, '.sawbuck/rule-input.txt'))); });
const labelFile = (h, m) => { const f = join(h, 'l.json'); writeFileSync(f, JSON.stringify(m)); return f; };
test('claim: the shape shows totals and never a single message', () => { const h = historyHome(['never push to main please']); shapeRun(h, '--prepare'); const m = {}; for (let i = 0; i < 300; i++) m[i] = ['proof', 'scope', 'none', 'voice'][i % 4]; const o = shapeRun(h, '--check', labelFile(h, m)); assert.match(o, /Truth/); assert.match(o, /Proof \d+/); assert.doesNotMatch(o, /never push to main/); assert.doesNotMatch(readFileSync(join(h, '.sawbuck/shape-history.jsonl'), 'utf8'), /never push/); assert.match(readFileSync(join(h, '.sawbuck/shape.svg'), 'utf8'), /<svg/); });
test('claim: a small history shows the 4 groups, not 11 spokes it cannot support', () => { const h = historyHome(['x y z message']); const m = {}; for (let i = 0; i < 40; i++) m[i] = i % 2 ? 'proof' : 'scope'; const o = shapeRun(h, '--check', labelFile(h, m)); assert.match(o, /Too few messages/); assert.doesNotMatch(o, /Proof \d+/); });
test('claim: a later shape shows what changed since the last one', () => { const h = historyHome(['x y z message']); const f = (p) => { const m = {}; for (let i = 0; i < 300; i++) m[i] = i % 2 ? p : 'scope'; return labelFile(h, m); }; shapeRun(h, '--check', f('proof')); assert.match(shapeRun(h, '--check', f('naming')), /\(was \d+%\)/); });
test('claim: the sampled messages and their labels are deleted once the shape check has run; totals and the card stay', () => { const h = historyHome(['never push to main please', 'show me the test output first']); shapeRun(h, '--prepare'); const m = {}; for (let i = 0; i < 40; i++) m[i] = i % 2 ? 'proof' : 'scope'; const f = join(h, '.sawbuck/shape-labels.json'); writeFileSync(f, JSON.stringify(m)); assert.match(shapeRun(h, '--check', f), /your steering shape/); assert.deepEqual(readdirSync(join(h, '.sawbuck')).sort(), ['shape-history.jsonl', 'shape.svg']); });
test('claim: an invented label is ignored', () => { const h = historyHome(['x y z message']); const o = shapeRun(h, '--check', labelFile(h, { 1: 'genius', 2: 'proof' })); assert.match(o, /from 1 messages/); });




test('claim: scope and direction count as one spoke, because two models could not split them', () => { const h = historyHome(['x y z message']); const m = {}; for (let i = 0; i < 300; i++) m[i] = i % 2 ? 'direction' : 'scope'; const o = shapeRun(h, '--check', labelFile(h, m)); assert.match(o, /Scope 99/); assert.doesNotMatch(o, /Direction/); });
test('claim: plain signing writes the rule and protected paths, and nothing else to commit', () => { const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); const r = sb(d, 'contract'); assert.equal(r.code, 0); assert.match(r.out, /--full adds/); assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /Sawbuck/); const c = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')); assert.ok(c.mandates.some((m) => JSON.stringify(m.paths).includes('.github/workflows'))); assert.ok(!c.mandates.some((m) => /packs|promptwheel\.lock/.test(JSON.stringify(m.paths)))); for (const f of ['promptwheel.lock.json', '.promptwheel/packs', '.github/workflows/sawbuck.yml']) assert.ok(!existsSync(join(d, f)), f); });
test('claim: plain signing still blocks a protected path and a gamed test', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); const w = wired(d); w.prompt(); put(d, '.github/workflows/x.yml', 'on: push\n'); assert.ok(blocked(w.stop())); });
test('claim: --full on a repo signed plainly adds the rest', () => { const d = repo(true); sb(d, 'contract'); assert.equal(sb(d, 'contract', '--full').code, 0); assert.ok(existsSync(join(d, 'promptwheel.lock.json'))); });
// what is not said: a home with n real turns (a prompt, a tool call, a reply ending in praise) in one session
const turnsHome = (n, dir = 'p', ending = 'All done. That is a real milestone to stand on.') => { const h = mkdtempSync(join(tmpdir(), 'claims-home-')); const at = new Date().toISOString(); const ev = []; for (let i = 0; i < n; i++) ev.push({ type: 'user', uuid: `u${i}`, timestamp: at, message: { role: 'user', content: `please change thing number ${i} for me` } }, { type: 'assistant', uuid: `a${i}`, timestamp: at, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `ls dir${i}` } }, { type: 'text', text: ending }] } }); put(h, `.claude/projects/${dir}/s.jsonl`, ev.map((e) => JSON.stringify(e)).join('\n') + '\n'); return h; };
const labels300 = (h) => { const m = {}; for (let i = 0; i < 300; i++) m[i] = i % 2 ? 'proof' : 'scope'; return labelFile(h, m); };
const cite = (ns, quote) => ns.map((n) => ({ n, quote }));
test('claim: a habit you never push on is shown only with the agent\'s own words from 3 turns', () => { const h = turnsHome(30); assert.match(shapeRun(h, '--prepare'), /30 past turns are ready/); put(h, '.sawbuck/shape-notsaid.json', JSON.stringify([{ what: 'Ends replies with praise.', turns: cite([1, 2, 3, 4], 'That is a real milestone to stand on.'), rule: 'End with what was done.' }, { what: 'Invented habit.', turns: cite([1, 2, 3], 'words the agent never said here') }, { what: 'Too thin.', turns: cite([1, 2], 'That is a real milestone to stand on.') }])); const o = shapeRun(h, '--check', labels300(h)); assert.match(o, /Not said, from one read of 30 past turns/); assert.match(o, /Ends replies with praise\. \(4 turns\)/); assert.match(o, /"That is a real milestone to stand on\."/); assert.match(o, /Try: End with what was done\./); assert.equal(o.match(/"That is a real milestone to stand on\."/g).length, 1, 'the same words are shown once'); assert.doesNotMatch(o, /Invented habit|Too thin/); });
test('claim: your own messages are not evidence and are never printed', () => { const h = turnsHome(30); shapeRun(h, '--prepare'); put(h, '.sawbuck/shape-notsaid.json', JSON.stringify([{ what: 'Quotes the person.', turns: cite([1, 2, 3], 'please change thing number') }])); const o = shapeRun(h, '--check', labels300(h)); assert.match(o, /nothing stood out in the 30 past turns read/); assert.doesNotMatch(o, /please change thing/); });
test('claim: the turn excerpts are private and gone after the check', () => { const h = turnsHome(30); shapeRun(h, '--prepare'); const f = join(h, '.sawbuck/shape-turns.txt'); assert.equal(statSync(f).mode & 0o077, 0); put(h, '.sawbuck/shape-notsaid.json', '[]'); shapeRun(h, '--check', labels300(h)); assert.ok(!existsSync(f)); assert.ok(!existsSync(join(h, '.sawbuck/shape-notsaid.json'))); assert.doesNotMatch(readFileSync(join(h, '.sawbuck/shape-history.jsonl'), 'utf8'), /milestone|thing number/); });
test('claim: with too little history nothing is read, and the shape still works', () => { const h = turnsHome(5); assert.doesNotMatch(shapeRun(h, '--prepare'), /past turns/); assert.ok(!existsSync(join(h, '.sawbuck/shape-turns.txt'))); const o = shapeRun(h, '--check', labels300(h)); assert.match(o, /Truth/); assert.doesNotMatch(o, /Not said/); });
test('claim: sessions started in a temp folder are left out: scripts and demos are not your work', () => { const h = turnsHome(30, '-tmp-tmp-abc123-t'); assert.doesNotMatch(shapeRun(h, '--prepare'), /past turns/); assert.doesNotMatch(readFileSync(join(h, '.sawbuck/rule-input.txt'), 'utf8'), /thing number/); });
// one session whose person messages try to pass as the agent's side of the line
const trickHome = () => { const h = mkdtempSync(join(tmpdir(), 'claims-home-')); const at = new Date().toISOString(); const ev = []; for (let i = 0; i < 30; i++) ev.push({ type: 'user', uuid: `u${i}`, timestamp: at, message: { role: 'user', content: `do it | it did (9 tool calls): MINE number ${i} is the persons text | you next: also MINE ${i}` } }, { type: 'assistant', uuid: `a${i}`, timestamp: at, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }, { type: 'text', text: 'done' }] } }); put(h, '.claude/projects/p/s.jsonl', ev.map((e) => JSON.stringify(e)).join('\n') + '\n'); return h; };
test('claim: words you typed cannot pass as the agent\'s, even when they copy the layout of a turn', () => { const h = trickHome(); shapeRun(h, '--prepare'); put(h, '.sawbuck/shape-notsaid.json', JSON.stringify([{ what: 'Tricked.', turns: cite([1, 2, 3], 'is the persons text') }, { what: 'Tricked again.', turns: cite([2, 3, 4], 'also MINE') }])); const o = shapeRun(h, '--check', labels300(h)); assert.match(o, /nothing stood out/); assert.doesNotMatch(o, /MINE|persons text/); });
test('claim: a broken answer from the model never crashes the shape or leaves excerpts behind', () => { const bad = ['{not json', JSON.stringify([{ what: 'x', turns: [{ n: 'constructor', quote: 'function Object() { [native code] }' }, { n: '__proto__', quote: 'aaaaaaaaaaaaaaaa' }, { n: 'toString', quote: 'bbbbbbbbbbbbbbbbbb' }] }]), JSON.stringify({ not: 'an array' }), JSON.stringify([null, 5, 'str', { what: 7, turns: 'no' }])]; for (const b of bad) { const h = turnsHome(30); shapeRun(h, '--prepare'); put(h, '.sawbuck/shape-notsaid.json', b); const r = spawnSync(process.execPath, [CLI, 'shape', '--check', labels300(h)], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h } }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Truth/); assert.doesNotMatch(r.stdout + r.stderr, /TypeError|at file:/); assert.ok(!existsSync(join(h, '.sawbuck/shape-turns.txt'))); } });
test('claim: a check that cannot run still removes the excerpts, and a damaged history file does not crash it', () => { const h = turnsHome(30); shapeRun(h, '--prepare'); const t = join(h, '.sawbuck/shape-turns.txt'); assert.ok(existsSync(t)); shapeRun(h, '--check', join(h, 'missing.json')); assert.ok(!existsSync(t), 'gone after a failed check'); shapeRun(h, '--prepare'); put(h, 'bad.json', '{"1": '); const r = spawnSync(process.execPath, [CLI, 'shape', '--check', join(h, 'bad.json')], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h } }); assert.doesNotMatch(r.stdout + r.stderr, /SyntaxError|at file:/); assert.ok(!existsSync(t)); shapeRun(h, '--prepare'); put(h, '.sawbuck/shape-history.jsonl', '{broken\n'); const r2 = spawnSync(process.execPath, [CLI, 'shape', '--check', labels300(h)], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h } }); assert.equal(r2.status, 0, r2.stderr); assert.match(r2.stdout, /Truth/); });
test('claim: the excerpt files are private even when an older, readable one was already there', () => { const h = turnsHome(30); put(h, '.sawbuck/shape-turns.txt', 'old\n'); put(h, '.sawbuck/shape-input.txt', 'old\n'); put(h, '.sawbuck/rule-input.txt', 'old\n'); for (const f of ['shape-turns.txt', 'shape-input.txt', 'rule-input.txt']) chmodSync(join(h, '.sawbuck', f), 0o644); shapeRun(h, '--prepare'); for (const f of ['shape-turns.txt', 'shape-input.txt', 'rule-input.txt']) assert.equal(statSync(join(h, '.sawbuck', f)).mode & 0o077, 0, f); });
test('claim: the first three habits that hold up are shown, wherever they sit in the answer', () => { const h = turnsHome(30); shapeRun(h, '--prepare'); const junk = Array.from({ length: 6 }, (_, i) => ({ what: `Invented ${i}.`, turns: cite([1, 2, 3], 'never said by the agent at all') })); put(h, '.sawbuck/shape-notsaid.json', JSON.stringify([...junk, { what: 'Real one.', turns: cite([4, 5, 6], 'That is a real milestone to stand on.') }])); const o = shapeRun(h, '--check', labels300(h)); assert.match(o, /Real one\. \(3 turns\)/); assert.doesNotMatch(o, /Invented/); });
test('claim: a session started in a folder named tmp itself is left out too', () => { const h = turnsHome(30, '-tmp'); assert.doesNotMatch(shapeRun(h, '--prepare'), /past turns/); });
test('limit: one read names leads, not every habit: the output says so', () => { const h = turnsHome(30); shapeRun(h, '--prepare'); put(h, '.sawbuck/shape-notsaid.json', JSON.stringify([{ what: 'Ends replies with praise.', turns: cite([5, 6, 7], 'That is a real milestone to stand on.') }])); assert.match(shapeRun(h, '--check', labels300(h)), /from one read of 30 past turns\. Leads to check/); });
test('claim: --png saves an image with a tool already on the machine, and says so when there is none', () => { const h = historyHome(['x y z message']); const f = labelFile(h, { 1: 'proof' }); const bin = join(h, 'bin'); mkdirSync(bin); const run = (p) => spawnSync(process.execPath, [CLI, 'shape', '--check', f, '--png'], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h, PATH: p } }).stdout; assert.match(run(bin), /No image tool here/); assert.ok(!existsSync(join(h, '.sawbuck/shape.png'))); writeFileSync(join(bin, 'rsvg-convert'), '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done; echo png > "$2"\n', { mode: 0o755 }); assert.match(run(`${bin}:/bin:/usr/bin`), /Image to share: .*shape\.png/); assert.ok(existsSync(join(h, '.sawbuck/shape.png'))); });

// ------------------------------------------------------------ leaving
test('claim: detach removes the hooks', () => { const d = signed(true); wired(d); assert.equal(sb(d, 'detach', '--claude').code, 0); assert.ok(!existsSync(join(d, '.claude/settings.local.json'))); });
test('claim: the signed contract stays after detach, and --purge removes the record', () => { const d = signed(true); wired(d); check(d); sb(d, 'detach', '--claude', '--purge'); assert.ok(existsSync(join(d, 'promptwheel.config.json'))); assert.ok(!existsSync(join(d, '.sawbuck'))); assert.ok(!existsSync(join(d, '.promptwheel/outcomes.jsonl'))); });

// ------------------------------------------------------------ 0.1.47: what each command says is what it did
const sbE = (d, env, ...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: d, encoding: 'utf8', env: { ...ENV, ...env } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const excludeText = (d) => { try { return readFileSync(join(d, '.git/info/exclude'), 'utf8'); } catch { return ''; } };
const gamedRepo = (msg = 'x') => { const d = repo(); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, msg); return d; };
test('claim: a plain detach does not make a signed repo fail its own rule', () => { const d = signed(true); const w = wired(d); w.prompt(); w.stop(); assert.ok(existsSync(join(d, '.sawbuck'))); assert.equal(sb(d, 'detach').code, 0); assert.equal(git(d, 'status', '--porcelain'), ''); assert.equal(check(d).code, 0); });
test('claim: detach --verify names what is left on disk, and --purge removes it', () => { const d = signed(true); const w = wired(d); w.prompt(); w.stop(); const v = sb(d, 'detach', '--verify'); assert.equal(v.code, 0); assert.doesNotMatch(v.out, /back to how it was/); assert.match(v.out, /still on disk: .*\.sawbuck/); assert.match(v.out, /--purge/); const p = sb(d, 'detach', '--purge', '--verify'); assert.doesNotMatch(p.out, /still on disk/); assert.doesNotMatch(excludeText(d), /sawbuck/); });
test('claim: attach --dry-run lists every file attach writes, .sawbuck/state.json included', () => { const d = signed(true); assert.match(sb(d, 'attach', '--claude', '--dry-run').out, /\.sawbuck\/state\.json/); assert.ok(!existsSync(join(d, '.sawbuck'))); });
test('claim: doctor tests what the hook runs: a dead path is not OK, even with sawbuck on PATH', () => { const d = signed(true); wired(d); assert.equal(sb(d, 'doctor').code, 0); const f = join(d, '.claude/settings.local.json'); put(d, '.claude/settings.local.json', readFileSync(f, 'utf8').replaceAll(CLI.replace(/\\/g, '\\\\'), '/no/such/sawbuck.mjs')); const bin = mkdtempSync(join(tmpdir(), 'claims-bin-')); writeFileSync(join(bin, 'sawbuck'), '#!/bin/sh\n', { mode: 0o755 }); const r = sbE(d, { PATH: `${bin}:${ENV.PATH}` }, 'doctor'); assert.equal(r.code, 1); assert.doesNotMatch(r.out, /\bOK\b/); });
test('claim: doctor checks user-level hooks too', () => { const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const d = repo(true); assert.equal(sbE(d, { HOME: home }, 'attach', '--user').code, 0); const r = sbE(d, { HOME: home }, 'doctor'); assert.equal(r.code, 0); assert.doesNotMatch(r.out, /no attachment/); assert.match(r.out, /OK.*user/); });
test('claim: a gamed change let through with --allow says so, with the reason, and never says verified', () => { const d = gamedRepo(); const r = sb(d, 'check', '--allow', 'a person said so'); assert.equal(r.code, 0); assert.match(r.out, /allowed/); assert.match(r.out, /a person said so/); assert.doesNotMatch(r.out, /verified|carried the win/); });
test('claim: with gaming detection off, the check does not say the win was re-proved', () => { const d = gamedRepo(); const r = sb(d, 'check', '--no-detect-gaming'); assert.equal(r.code, 0); assert.match(r.out, /gaming detection is off/); assert.doesNotMatch(r.out, /verified|carried the win/); });
for (const a of [['contract', '--help'], ['attach', '--help'], ['detach', '--help'], ['init', '-h'], ['check', '-h']]) {
  test(`claim: ${a.join(' ')} prints help and writes nothing`, () => { const d = repo(true); const x = excludeText(d); const r = sb(d, ...a); assert.equal(r.code, 0); assert.match(r.out, new RegExp(`sawbuck ${a[0]}`)); assert.equal(git(d, 'status', '--porcelain'), ''); assert.equal(excludeText(d), x); assert.ok(!existsSync(join(d, '.git/sawbuck')) && !existsSync(join(d, '.claude'))); });
}
test('claim: --strict after --full makes the guards that were notes block', () => { const d = signed(true); assert.equal(sb(d, 'contract', '--strict').code, 0); assert.ok(!JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics.some((m) => m.report)); save(d, 'strict'); json(d, 'package.json', (o) => { o.dependencies = { 'left-pad': '1.3.0' }; }); save(d, 'dep'); assert.equal(check(d).code, 1); });
test('claim: contract refuses a flag it does not know, and writes nothing', () => { const d = repo(true); const r = sb(d, 'contract', '--no-ci'); assert.equal(r.code, 64); assert.match(r.out, /--no-ci/); assert.equal(git(d, 'status', '--porcelain'), ''); });
test('claim: --full says when it adds no CI check, and why', () => { const d = repo(true); const r = sb(d, 'contract', '--full'); assert.match(r.out, /No CI check added: .*github\.com/); });
const debtRepo = () => { const d = repo(true); put(d, 'src/a.py', 'x = 1  # type: ignore\n'); save(d, 'sup'); return d; };
test('claim: debt reads the repo you name', () => { const d = debtRepo(); const r = sb(mkdtempSync(join(tmpdir(), 'claims-')), 'debt', d); assert.equal(r.code, 0); assert.match(r.out, /1 still silenced/); });
test('claim: debt --fail-on any fails on live debt without --since', () => { assert.equal(sb(debtRepo(), 'debt', '--fail-on', 'any').code, 1); assert.equal(sb(repo(true), 'debt', '--fail-on', 'any').code, 0); });
test('claim: debt refuses a --fail-on it does not know', () => { const r = sb(debtRepo(), 'debt', '--fail-on', 'bogus'); assert.equal(r.code, 64); assert.match(r.out, /undocumented\|test\|any/); });
test('claim: with no test command, inconclusive says so, and does not blame isolation or send a signed repo to init', () => { const d = mkdtempSync(join(tmpdir(), 'claims-')); git(d, 'init', '-q'); put(d, 'a', '1'); save(d, 'a'); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); put(d, 'a', '2'); save(d, 'b'); const r = sb(d, 'check'); assert.equal(r.code, 3); assert.match(r.out, /no test command/); assert.doesNotMatch(r.out, /isolation|sawbuck init/); });
test('claim: when the tests fail before and after, inconclusive says that, not isolation', () => { const d = repo(false); put(d, 'NOTES.md', 'x\n'); save(d, 'x'); const r = sb(d, 'check'); assert.equal(r.code, 3); assert.match(r.out, /your tests fail before and after/); assert.doesNotMatch(r.out, /did not run in isolation/); });
test('limit: auto-detect finds npm, pytest, cargo and go tests; a Makefile test target is not one of them', () => { const d = mkdtempSync(join(tmpdir(), 'claims-')); git(d, 'init', '-q'); put(d, 'Makefile', 'test:\n\ttrue\n'); put(d, 'a', '1'); save(d, 'a'); put(d, 'a', '2'); save(d, 'b'); const r = sb(d, 'check'); assert.equal(r.code, 3); assert.match(r.out, /no test command/); });
test('claim: a check that cannot run says why, in the engine\'s words, exit 64', () => { const d = repo(true); edit(d, 'src/add.js', (s) => s + '//\n'); save(d, 'x'); let r = sb(d, 'check', '--base', 'nope'); assert.equal(r.code, 64); assert.match(r.out, /base ref "nope"/); r = sb(d, 'check', '--bogus-flag'); assert.equal(r.code, 64); assert.match(r.out, /unknown flag --bogus-flag/); r = sb(d, 'check', '--repeat', 'abc'); assert.equal(r.code, 64, `a bad value: ${r.out}`); assert.match(r.out, /--repeat/); r = sb(d, 'check', '--repeat'); assert.equal(r.code, 64, `a missing value: ${r.out}`); assert.match(r.out, /--repeat needs a value/); put(d, 'promptwheel.config.json', '{bad'); save(d, 'j'); r = sb(d, 'check'); assert.equal(r.code, 64); assert.match(r.out, /invalid config/); });
test('limit: contract keeps an existing config as it is and adds no tests to it', () => { const d = repo(true); put(d, 'promptwheel.config.json', '{"repeat":1,"metrics":[]}\n'); save(d, 'c'); assert.equal(sb(d, 'contract').code, 0); assert.deepEqual(JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics, []); });
test('limit: init proposes the detected tests and the tripwires, not coverage, latency or cost', () => { const d = repo(true); const r = sb(d, 'init', '--yes', '--no-investigate'); assert.equal(r.code, 0); const names = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics.map((m) => m.name).join(' '); assert.doesNotMatch(names, /coverage|latency|cost/); });
test('claim: a Sawbuck-Allow trailer clears nothing, in check or in the Stop hook, signed or not', () => { const d = gamedRepo('cheat\n\nSawbuck-Allow: because'); const r = sb(d, 'check'); assert.equal(r.code, 2); assert.match(r.out, /trailer/); const e = repo(); const w = wired(e); w.prompt(); edit(e, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(e, 'cheat\n\nSawbuck-Allow: because'); assert.ok(blocked(w.stop())); });
test('limit: removing the hooks from the git-excluded settings.local.json is invisible to the check; doctor sees it', () => { const d = signed(true); wired(d); put(d, '.claude/settings.local.json', '{}\n'); assert.equal(git(d, 'status', '--porcelain'), ''); assert.equal(check(d).code, 0); const r = sb(d, 'doctor'); assert.equal(r.code, 1); assert.match(r.out, /hooks are gone/); });
const flat = (s) => s.replace(/\s+/g, ' ');
const README = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
test('claim: the README shows the verified line and the agent rule as sawbuck prints them', () => { const d = repo(); edit(d, 'src/add.js', fixAdd); const v = sb(d, 'check').out.split('\n')[0].replace(/ \(it survives.*$/, ''); assert.ok(flat(README).includes(flat(v.replace(/^🐴 /, ''))), v); const e = repo(true); sb(e, 'contract'); const block = readFileSync(join(e, 'AGENTS.md'), 'utf8').match(/## Sawbuck rules\n\n([^\n]+)/)[1]; assert.ok(flat(README).includes(flat(block)), 'the AGENTS block'); });
test('claim: promptwheel exports conformsToContract, the validator the contract names', async () => { const { PW } = await import(join(HERE, '..', 'bins.mjs')); const m = await import(PW); assert.equal(typeof m.conformsToContract, 'function'); assert.doesNotMatch(README + readFileSync(join(HERE, '..', 'CONTRACT.md'), 'utf8'), /promptwheel conformance/); });

// ------------------------------------------------------------ the git hook, through real commits
for (const t of ['Sawbuck-Allow', 'Promptwheel-Allow']) {
  test(`claim: a ${t} trailer clears nothing through the git hook either`, () => {
    const d = hookRepo(); sb(d, 'attach', '--git');
    edit(d, 'test/add.test.js', cheat); commit(d, `make it green\n\n${t}: because`);
    assert.ok((record(d).gamed || 0) >= 1, 'gamed, trailer or not');
    assert.doesNotMatch(readFileSync(join(d, '.sawbuck/activity.jsonl'), 'utf8'), /"allowed"/);
  });
}
test('claim: attach --git runs even when the hook already there ends in exit 0, and detach puts that hook back byte for byte', () => {
  const mine = '#!/bin/sh\necho mine\n\n\n\nexit 0\n';
  const d = hookRepo(); const pc = join(d, '.git/hooks/post-commit'); writeFileSync(pc, mine, { mode: 0o755 });
  assert.equal(sb(d, 'attach', '--git').code, 0);
  edit(d, 'test/add.test.js', cheat); const o = commit(d, 'make it green');
  assert.match(o, /mine/, 'their hook still runs'); assert.ok((record(d).gamed || 0) >= 1, 'and ours runs before their exit');
  assert.equal(sb(d, 'detach').code, 0); assert.equal(readFileSync(pc, 'utf8'), mine);
  for (const other of ['#!/bin/sh\necho mine', 'echo mine\n', '#!/bin/sh', '']) {
    writeFileSync(pc, other); sb(d, 'attach', '--git'); assert.match(readFileSync(pc, 'utf8'), /sawbuck/); sb(d, 'detach');
    assert.equal(readFileSync(pc, 'utf8'), other, JSON.stringify(other));
  }
});
test('claim: attach --git refuses a hooks folder inside the work tree, writes nothing, and the line it gives works when added by hand', () => {
  const d = hookRepo(); put(d, '.husky/post-commit', '#!/bin/sh\n'); chmodSync(join(d, '.husky/post-commit'), 0o755); git(d, 'config', 'core.hooksPath', '.husky'); save(d, 'husky');
  for (const a of [['attach', '--git'], ['attach', '--git', '--dry-run']]) {
    const r = sb(d, ...a); assert.equal(r.code, 64, r.out); assert.equal(r.out.trim().split('\n').length, 1, 'one line'); assert.match(r.out, /`sawbuck attach`/);
    assert.equal(git(d, 'status', '--porcelain'), ''); assert.ok(!existsSync(join(d, '.git/sawbuck')) && !existsSync(join(d, '.sawbuck')), 'nothing written');
  }
  const line = sb(d, 'attach', '--git').out.match(/by hand .*?: (\(unset .*\|\| true)$/m)[1];
  // the line names the published package; here npx is a stand-in that runs the sawbuck under test
  const bin = mkdtempSync(join(tmpdir(), 'claims-bin-')); writeFileSync(join(bin, 'npx'), `#!/bin/sh\nshift; shift\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const path = `${bin}:/usr/bin:/bin`;
  edit(d, '.husky/post-commit', (s) => s + line + '\n'); commit(d, 'add the hook line', path);
  edit(d, 'test/add.test.js', cheat); commit(d, 'make it green', path);
  assert.ok((record(d).gamed || 0) >= 1, 'the commit after the line went in was caught');
  // the stated limit: a line added by hand is not an attachment sawbuck knows about
  assert.match(sb(d, 'status').out, /ready \(checkable, not wired yet\)/); assert.match(sb(d, 'doctor').out, /no attachment/); assert.match(sb(d, 'detach').out, /nothing to detach/); assert.ok(readFileSync(join(d, '.husky/post-commit'), 'utf8').includes(line));
});
test('claim: the git hook names a protected path that a commit changed', () => {
  const d = hookRepo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); sb(d, 'attach', '--git');
  put(d, '.npmrc', 'x\n'); const o = commit(d, 'registry');
  const L = record(d).latest || {};
  assert.match(String(L.reason), /protected path/); assert.match(String(L.reason), /\.npmrc/); assert.doesNotMatch(String(L.reason), /regressed/); assert.equal(L.file, '.npmrc');
  assert.match(o, /protected path.*\.npmrc/, 'the hook prints it'); assert.match(readFileSync(join(d, '.sawbuck/activity.jsonl'), 'utf8'), /protected path/);
});
test('limit: a commit made in a linked git worktree is not checked by the git hook', () => {
  const d = hookRepo(); sb(d, 'attach', '--git');
  const w = join(mkdtempSync(join(tmpdir(), 'claims-')), 'wt'); git(d, 'worktree', 'add', '-q', w, '-b', 'side');
  edit(w, 'test/add.test.js', cheat); commit(w, 'make it green');
  assert.ok(record(d, 'state.json').turns >= 1, 'the hook ran, on the checkout it was attached from');
  assert.ok(!record(d).gamed && !existsSync(join(w, '.sawbuck')), 'so the commit in the worktree was not checked');
});

test('claim: attach --git checks from the commit it was attached at, not from where an earlier attachment stopped', () => {
  const d = hookRepo(); sb(d, 'attach', '--git'); put(d, 'NOTES.md', '1\n'); commit(d, 'notes'); sb(d, 'detach');
  edit(d, 'test/add.test.js', cheat); commit(d, 'made while detached, so no hook saw it');
  sb(d, 'attach', '--git'); put(d, 'NOTES.md', '2\n'); commit(d, 'more notes');
  assert.ok(!record(d).gamed, 'a commit from before this attach is not laid on the first commit after it');
  assert.equal(sb(d, 'check', '--base', 'HEAD~2').code, 2, 'the range is still there to check by hand');
});
test('limit: the very first commit of a repo has nothing to be checked against', () => {
  const d = mkdtempSync(join(tmpdir(), 'claims-')); git(d, 'init', '-q', '-b', 'main'); assert.equal(sb(d, 'attach', '--git').code, 0);
  put(d, 'promptwheel.config.json', NODE_TESTS); put(d, 'src/add.js', 'exports.add=(a,b)=>a+b\nexports.mul=(a,b)=>a*b\n'); put(d, 'test/add.test.js', TEST); commit(d, 'first');
  assert.ok(record(d, 'state.json').turns >= 1, 'the hook ran'); assert.equal(record(d).latest, undefined, 'and had no earlier commit to check from');
  edit(d, 'src/add.js', breakAdd); commit(d, 'second'); assert.equal((record(d).latest || {}).kind, 'regression', 'the next commit is checked');
});

// ------------------------------------------------------------ doctor, status and check say what is true
test('claim: doctor says a git hook that is gone is gone', () => {
  const d = repo(true); sb(d, 'attach', '--git'); assert.equal(sb(d, 'doctor').code, 0);
  const pc = join(d, '.git/hooks/post-commit'); writeFileSync(pc, '#!/bin/sh\n');
  let r = sb(d, 'doctor'); assert.equal(r.code, 1, r.out); assert.match(r.out, /GONE\s+git/);
  rmSync(pc); r = sb(d, 'doctor'); assert.equal(r.code, 1, r.out); assert.match(r.out, /GONE\s+git/); assert.doesNotMatch(r.out, /nothing to check/);
});
test('claim: doctor reports an incomplete hook set as not OK', () => {
  const d = repo(true);
  const broken = (what, fn) => { sb(d, 'detach'); sb(d, 'attach'); assert.equal(sb(d, 'doctor').code, 0); json(d, '.claude/settings.local.json', fn); const r = sb(d, 'doctor'); assert.equal(r.code, 1, `${what}: ${r.out}`); assert.doesNotMatch(r.out, /\bOK\b/, what); };
  broken('the Stop hook removed', (o) => { delete o.hooks.Stop; });
  broken('--stop dropped', (o) => { const h = o.hooks.Stop[0].hooks[0]; h.command = h.command.replace(' --stop', ''); });
  broken('the Stop hook moved under another event', (o) => { o.hooks.PostToolUse = o.hooks.Stop; delete o.hooks.Stop; });
  broken('the prompt hook removed', (o) => { delete o.hooks.UserPromptSubmit; });
});
test('claim: watching means the hooks are wired: after detach, status and the status line read ready', () => {
  const d = signed(true); const w = wired(d); w.prompt(); w.stop(); assert.match(sb(d, 'statusline').out, /· watching/);
  assert.equal(sb(d, 'detach').code, 0); assert.ok(existsSync(join(d, '.sawbuck/state.json')), 'the record stays');
  assert.match(sb(d, 'statusline').out, /· ready/); const s = sb(d, 'status').out; assert.match(s, /ready \(checkable, not wired yet\)/); assert.doesNotMatch(s, /watching|✓ wired in/);
  sb(d, 'attach', '--git'); assert.match(sb(d, 'statusline').out, /· watching/, 'the git hook counts'); sb(d, 'detach'); assert.match(sb(d, 'statusline').out, /· ready/);
  const allow = '{"permissions":{"allow":["Bash(npx -y sawbuck@0.1.47 status)"]}}\n'; put(d, '.claude/settings.local.json', allow);
  assert.match(sb(d, 'statusline').out, /· ready/, 'a permission that names sawbuck is not a hook'); assert.match(sb(d, 'detach').out, /nothing to detach/); assert.equal(readFileSync(join(d, '.claude/settings.local.json'), 'utf8'), allow);
});
test('claim: user-level hooks read as watching, and status says the check needs a promptwheel.config.json where there is none', () => {
  const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const d = repo(true); assert.equal(sbE(d, { HOME: home }, 'attach', '--user').code, 0);
  assert.match(sbE(d, { HOME: home }, 'statusline').out, /· watching/);
  const s = sbE(d, { HOME: home }, 'status').out; assert.match(s, /only in a repo that has a promptwheel\.config\.json/); assert.doesNotMatch(s, /zero-config auto-detect/);
});
test('claim: under user-level hooks the check runs only in a repo that has a promptwheel.config.json', () => {
  const env = { ...ENV, HOME: mkdtempSync(join(tmpdir(), 'claims-home-')) };
  const stop = (d) => spawnSync(process.execPath, [CLI, '__hook', '--by', 'claude', '--stop'], { cwd: d, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: 'Stop', cwd: d, session_id: 's' }) }).stdout || '';
  const caught = (d) => { stop(d); edit(d, 'test/add.test.js', cheat); save(d, 'make it green'); return blocked(stop(d)); };
  assert.equal(caught(repo()), false, 'no config: the gamed commit is not checked');
  assert.equal(caught(hookRepo()), true, 'with a config it is');
});
test('claim: check --working on a clean tree says there is nothing uncommitted, exit 64, and does not read the last commit as held', () => {
  const d = gamedRepo(); const r = sb(d, 'check', '--working'); assert.equal(r.code, 64, r.out); assert.match(r.out, /nothing uncommitted/); assert.match(r.out, /`sawbuck check`/); assert.doesNotMatch(r.out, /held|verified/);
  const e = repo(); edit(e, 'test/add.test.js', cheat); assert.equal(sb(e, 'check', '--working').code, 2, 'a dirty tree is still checked');
});
test('claim: a protected path change is sent back in those words', () => { const d = signed(true); put(d, '.npmrc', 'x\n'); save(d, 'x'); const r = sb(d, 'check'); assert.equal(r.code, 1); assert.match(r.out, /sent back: a protected path changed, however green the rest is\./); });

// ------------------------------------------------------------ smaller: bad input is refused, not ignored
test('claim: a broken entry in the steer store does not crash steers or status', () => {
  const h = steerHome([null, 7, { session: '1' }, { session: '1', repo: 'a', nudge: 'verify first' }]);
  const r = spawnSync(process.execPath, [CLI, 'steers'], { cwd: h, encoding: 'utf8', env: { ...ENV, HOME: h } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1 steers kept/); assert.doesNotMatch(r.stderr, /TypeError/);
  const s = sbE(repo(true), { HOME: h }, 'status'); assert.equal(s.code, 0, s.out); assert.doesNotMatch(s.out, /TypeError/);
});
for (const c of ['attach', 'detach', 'init', 'doctor', 'status']) {
  test(`claim: ${c} refuses a flag it does not know, exit 64, and writes nothing`, () => { const d = repo(true); const x = excludeText(d); const r = sb(d, c, '--bogus'); assert.equal(r.code, 64, r.out); assert.match(r.out, /--bogus/); assert.equal(git(d, 'status', '--porcelain'), ''); assert.equal(excludeText(d), x); assert.ok(!existsSync(join(d, '.git/sawbuck')) && !existsSync(join(d, '.claude'))); });
}
test('claim: the flags each command lists still work, --claude from an older install included', () => {
  const d = repo(true); const env = { HOME: mkdtempSync(join(tmpdir(), 'claims-home-')) };   // its own home: doctor --all reads every repo attached from it
  for (const a of [['attach', '--claude'], ['status', '--json'], ['status', '--log', '-n', '3'], ['doctor', '--all'], ['detach', '--claude', '--verify', '--purge'], ['attach', '--dry-run'], ['detach', '--all', '--dry-run'], ['init', '-y', '--no-investigate', '--no-agent-block', '--preset', 'antihack'], ['init', '--yes', '--force']]) { const r = sbE(d, env, ...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.out}`); }
});
test('claim: init outside a git repository refuses, exit 64, and writes nothing', () => { const d = mkdtempSync(join(tmpdir(), 'claims-')); const r = sb(d, 'init', '--yes'); assert.equal(r.code, 64, r.out); assert.match(r.out, /not a git repository/); assert.doesNotMatch(r.out, /fatal:/); assert.deepEqual(readdirSync(d), []); });
test('claim: init reads the whole history, not only the newest 200 commits', () => { const d = repo(true); for (let i = 0; i < 205; i++) git(d, 'commit', '-q', '--allow-empty', '-m', `c${i}`); assert.match(sb(d, 'init', '--yes').out, /history: 206 commits/); });
test('claim: init prints its own lines only', () => { const d = repo(true); const r = sb(d, 'init', '--yes'); assert.equal(r.code, 0); assert.match(r.out, /history: \d+ commits/); assert.doesNotMatch(r.out, /matching event/); });
test('claim: a bare detach removes our hooks even when the receipt is lost', () => {
  const d = repo(true); sb(d, 'attach'); sb(d, 'attach', '--git'); rmSync(join(d, '.git/sawbuck'), { recursive: true });
  const r = sb(d, 'detach'); assert.equal(r.code, 0); assert.doesNotMatch(r.out, /nothing to detach/);
  assert.ok(!existsSync(join(d, '.claude/settings.local.json')) && !existsSync(join(d, '.git/hooks/post-commit')), 'both are gone');
});
test('claim: a teammate can detach in their clone of a repo that shares its hooks', () => {
  const d = repo(true); sb(d, 'attach', '--shared'); save(d, 'share the hooks');
  const c = join(mkdtempSync(join(tmpdir(), 'claims-')), 'c'); git(d, 'clone', '-q', d, c);
  const r = sb(c, 'detach'); assert.equal(r.code, 0); assert.doesNotMatch(r.out, /nothing to detach/);
  const f = join(c, '.claude/settings.json'); assert.ok(!/sawbuck/.test(existsSync(f) ? readFileSync(f, 'utf8') : ''));
  assert.match(git(c, 'status', '--porcelain'), /\.claude\/settings\.json/, 'and the removal shows in git');
});

// ------------------------------------------------------------ a dry run lists what the real run touches
// every file under the roots by content (git's own files aside), so what a command touched is what differs
const snap = (roots) => {
  const m = new Map();
  const skip = (p) => /\/(\.npm|node_modules)$/.test(p) || (/\/\.git\/[^/]+$/.test(p) && !/\/\.git\/(hooks|info|sawbuck)$/.test(p));
  const walk = (p) => { if (skip(p)) return; if (lstatSync(p).isDirectory()) for (const f of readdirSync(p)) walk(join(p, f)); else m.set(p, readFileSync(p, 'latin1')); };
  for (const r of roots) if (existsSync(r)) walk(r);
  return m;
};
const touched = (roots, fn) => { const a = snap(roots); const r = fn(); const b = snap(roots); return { r, files: [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort() }; };
const under = (f, w) => f === w.replace(/\/$/, '') || f.startsWith(w.replace(/\/?$/, '/'));
const sameAsDry = (d, home, ...cmd) => {
  const roots = [d, home]; const env = { HOME: home };
  const dryRun = touched(roots, () => sbE(d, env, ...cmd, '--dry-run'));
  assert.deepEqual(dryRun.files, [], `${cmd.join(' ')} --dry-run changes nothing`);
  const want = dryRun.r.out.split('\n').map((l) => (l.match(/^ .*?\s(\/\S+)/) || [])[1]).filter(Boolean);
  const real = touched(roots, () => sbE(d, env, ...cmd));
  for (const f of real.files) assert.ok(want.some((w) => under(f, w)), `${cmd.join(' ')} touched ${f}, which the dry run did not list:\n${dryRun.r.out}`);
  for (const w of want) assert.ok(real.files.some((f) => under(f, w)), `${cmd.join(' ')} --dry-run listed ${w}, which the real run did not touch`);
  return dryRun.r.out;
};
const freshHome = () => mkdtempSync(join(tmpdir(), 'claims-home-'));
test('claim: attach --dry-run lists exactly the files attach writes, the list of attached repos included', () => {
  const home = freshHome();
  assert.match(sameAsDry(hookRepo(true), home, 'attach'), /\.sawbuck\/registry\.json/);
  assert.match(sameAsDry(signed(true), home, 'attach'), /\.sawbuck\/state\.json/);
  assert.match(sameAsDry(hookRepo(true), home, 'attach', '--git'), /registry\.json/);
  assert.match(sameAsDry(hookRepo(true), home, 'attach', '--shared'), /settings\.json/);
  assert.match(sameAsDry(hookRepo(true), freshHome(), 'attach', '--user'), /user-attach\.json/);
});
test('claim: detach --dry-run lists exactly what each detach removes', () => {
  const home = freshHome(); const both = () => { const d = hookRepo(true); sbE(d, { HOME: home }, 'attach'); return d; };
  assert.match(sameAsDry(both(), home, 'detach'), /settings\.local\.json/);
  const g = hookRepo(true); sbE(g, { HOME: home }, 'attach', '--git'); edit(g, 'src/add.js', (s) => s + '//\n'); commit(g, 'a commit, so there is a record'); assert.match(sameAsDry(g, home, 'detach', '--purge'), /\.sawbuck/);
  const u = both(); const uh = freshHome(); sbE(u, { HOME: uh }, 'attach', '--user');
  const o = sameAsDry(u, uh, 'detach', '--user'); assert.match(o, /\.claude\/settings\.json/); assert.doesNotMatch(o, /settings\.local\.json/, 'the project hooks stay, so they are not listed');
});
test('claim: contract --full --dry-run and the real run count the same things in the same words', () => {
  const count = (s) => { const m = s.match(/(\d+) protected paths, (\d+) supply-chain guards/); assert.ok(m, s); return [m[1], m[2]]; };
  const d = repo(true); assert.deepEqual(count(sb(d, 'contract', '--full', '--dry-run').out), count(sb(d, 'contract', '--full').out));
  const e = repo(true); sb(e, 'contract'); assert.deepEqual(count(sb(e, 'contract', '--full', '--dry-run').out), count(sb(e, 'contract', '--full').out), 'and on a repo already signed plainly');
});

// An outside report found the preview left out AGENTS.md, the CI workflow and five of the checks. The test above only
// compared two counts in a sentence, so this one compares what lands on disk.
test('claim: contract --dry-run lists exactly the files a real run writes, and the same checks', () => {
  const listed = (o) => [...o.matchAll(/^  (\S+)\s+(?:new|changed)\b/gm)].map((m) => m[1]).sort();
  const wrote = (d) => [...new Set(git(d, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).map((l) => l.replace(/^\s*\S+\s+/, '').replace(/^(\.promptwheel\/packs\/supply-chain\/).*/, '$1')))].sort();   // git() trims, so the first line has lost its leading space
  const checks = (o) => (o.match(/(\d+) checks/) || [])[1];
  for (const [name, setup, flags] of [['plain', () => {}, []], ['--full', () => {}, ['--full']], ['--full after plain', (d) => { sb(d, 'contract'); save(d, 'signed plainly'); }, ['--full']], ['--strict after --full', (d) => { sb(d, 'contract', '--full'); save(d, 'signed'); }, ['--strict']]]) {
    const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); setup(d);
    const dry = sb(d, 'contract', ...flags, '--dry-run').out;
    assert.equal(git(d, 'status', '--porcelain'), '', `${name}: the dry run wrote nothing`);
    assert.equal(sb(d, 'contract', ...flags).code, 0);
    assert.deepEqual(listed(dry), wrote(d), `${name}: the files`);
    assert.equal(+checks(dry), JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics.length, `${name}: the checks`);
  }
});
test('claim: contract --dry-run on a repo that is already signed says nothing would change', () => {
  const d = repo(true); sb(d, 'contract'); save(d, 'signed');
  assert.match(sb(d, 'contract', '--dry-run').out, /already signed, nothing would change/);
});

// ------------------------------------------------------------ the docs say what the code does
const CONTRACT = readFileSync(join(HERE, '..', 'CONTRACT.md'), 'utf8');
test('claim: the sample verdict in CONTRACT.md carries the gamingReason the check really prints', () => { const m = check(gamedRepo()).metrics.find((x) => x.gamed); assert.ok(CONTRACT.includes(`"gamingReason": ${JSON.stringify(m.gamingReason)}`), m.gamingReason); });
test('claim: the README lists the protected paths contract writes, and which of them take --allow', () => {
  const d = repo(true); assert.equal(sb(d, 'contract').code, 0);
  const wrote = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).mandates.map((m) => `${m.name}|${m.paths.join(',')}|${m.allowable ? 'allow' : 'remove'}`).sort();
  const rows = [...README.matchAll(/^\| `([a-z-]+-frozen)` \| (.+?) \| (.+?) \|$/gm)].map(([, n, paths, how]) => `${n}|${[...paths.matchAll(/`([^`]+)`/g)].map((x) => x[1]).join(',')}|${/--allow/.test(how) ? 'allow' : 'remove'}`).sort();
  assert.deepEqual(rows, wrote);
});
test('claim: the README and the contract name only commands the help lists, and no memory provider to plug in', () => {
  const listed = new Set([...sb(HERE, 'help', '--all').out.matchAll(/^ {2}sawbuck (\w+)/gm)].map((m) => m[1]));
  for (const [, c] of (README + CONTRACT).matchAll(/(?:^|[`\s])sawbuck ([a-z]+)/gm)) assert.ok(listed.has(c), `sawbuck ${c} is not in the help`);
  assert.doesNotMatch(README + CONTRACT, /attach --claude|memory provider|pluggable/);
});

// ------------------------------------------------------------ an outside field report on 0.1.44 (2026-11-05)
// A private npm-workspaces monorepo, 15 defects. Each one still open on 0.1.49 is a test here, written before its fix.
function monoRepo() {
  const d = mkdtempSync(join(tmpdir(), 'claims-mono-'));
  git(d, 'init', '-q', '-b', 'main');
  put(d, '.gitignore', 'node_modules\n');
  put(d, 'package.json', JSON.stringify({ name: 'mono', private: true, version: '1.0.0', workspaces: ['apps/*', 'packages/*'], scripts: { test: 'node --test' } }) + '\n');
  put(d, 'apps/web/package.json', '{"name":"web","version":"1.0.0"}\n');
  put(d, 'packages/util/package.json', '{"name":"@x/util","version":"1.0.0","main":"index.js"}\n');
  put(d, 'packages/util/index.js', 'exports.add=(a,b)=>a-b\n');
  put(d, 'apps/web/node_modules/localdep/package.json', '{"name":"localdep","version":"1.0.0","main":"index.js"}\n'); put(d, 'apps/web/node_modules/localdep/index.js', 'module.exports=(x)=>x\n');
  mkdirSync(join(d, 'node_modules/@x'), { recursive: true }); symlinkSync('../../packages/util', join(d, 'node_modules/@x/util'));
  put(d, 'apps/web/src/sum.js', "const id=require('localdep');const {add}=require('@x/util');exports.sum=(a,b)=>id(add(a,b))\n");
  put(d, 'apps/web/test/sum.test.js', "require('node:test').test('sum',()=>require('node:assert').equal(require('../src/sum.js').sum(2,3),5))\n");
  save(d, 'base');
  return d;
}
test('claim: a workspaces monorepo is measured with nothing to write: a workspace\'s own dependencies and its sibling packages resolve', () => {
  const d = monoRepo(); put(d, 'packages/util/index.js', 'exports.add=(a,b)=>a+b\n');
  const r = sb(d, 'check'); assert.equal(r.code, 0, r.out); assert.match(r.out, /verified: your working change earned it/);
  const e = monoRepo(); put(e, 'apps/web/test/sum.test.js', "require('node:test').test('sum',()=>require('node:assert').equal(require('../src/sum.js').sum(2,3),-1))\n");
  assert.equal(sb(e, 'check').code, 2, 'and a test edited to go green there reads gamed');
});
test('claim: an inconclusive check names the cause: a failed setup, a missing dependency, or tests that fail', () => {
  const red = repo(false); edit(red, 'src/add.js', (s) => s + '// x\n');
  assert.match(sb(red, 'check').out, /inconclusive: your tests fail before and after this change/);
  const dep = repo(true); put(dep, 'test/add.test.js', "require('a-package-nobody-installed');\n" + TEST); save(dep, 'needs a package'); edit(dep, 'src/add.js', (s) => s + '// x\n');
  const o = sb(dep, 'check').out; assert.match(o, /inconclusive: the clean copy the check runs in is missing something your tests need/); assert.match(o, /a-package-nobody-installed/);
  const setup = repo(true); put(setup, 'promptwheel.config.json', JSON.stringify({ repeat: 1, setup: 'echo "boom: no compiler" >&2; exit 7', metrics: [{ name: 'tests_pass', cmd: 'false', extract: 'exit', direction: 'pass', guard: true }] }) + '\n'); save(setup, 'cfg'); edit(setup, 'src/add.js', (s) => s + '// x\n');
  assert.match(sb(setup, 'check').out, /inconclusive: the setup command failed \(exit 7\)[^\n]*boom: no compiler/);
});
// found by running real repos (proof-bench/field): eslint/rewrite's tests import a sibling package's built output
test('claim: when the tests need a build first, the inconclusive message points at sawbuck init, and following it works', () => {
  const d = mkdtempSync(join(tmpdir(), 'claims-')); git(d, 'init', '-q', '-b', 'main');
  put(d, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test', build: 'mkdir -p build && cp src/add.js build/add.js' } }) + '\n'); put(d, '.gitignore', 'build\n');
  put(d, 'src/add.js', 'exports.add=(a,b)=>a+b\n');
  put(d, 'test/add.test.js', "require('node:test').test('add',()=>require('node:assert').equal(require('../build/add.js').add(2,2),4))\n"); save(d, 'base');
  put(d, 'NOTES.md', 'x\n'); save(d, 'a note');
  const r = sb(d, 'check'); assert.equal(r.code, 3, r.out);
  assert.match(r.out, /is missing something your tests need[^\n]*build[^\n]*`sawbuck init` writes a config that runs it/);
  assert.equal(sb(d, 'init', '--yes', '--no-investigate', '--no-agent-block').code, 0); save(d, 'config');
  put(d, 'NOTES.md', 'y\n'); save(d, 'another note');
  const ok = sb(d, 'check'); assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /held/);
});
test('claim: a setup command that fails is said even when the tests still pass', () => {
  const d = repo(true); put(d, 'promptwheel.config.json', JSON.stringify({ repeat: 1, setup: 'echo "boom: no compiler" >&2; exit 7', metrics: [{ name: 'tests_pass', cmd: 'npm test --silent', extract: 'exit', direction: 'pass', guard: true }] }) + '\n'); save(d, 'cfg'); edit(d, 'src/add.js', (s) => s + '// x\n');
  const o = sb(d, 'check').out; assert.match(o, /held: nothing got worse/); assert.match(o, /setup command failed \(exit 7\)[^\n]*boom: no compiler/);
});
test('claim: a gamed verdict in a change that also edits how the check measures says to commit that edit on its own first', () => {
  // the tests need a build step. With no config nothing can be measured. A person adds the setup and fixes the bug in one change.
  const d = mkdtempSync(join(tmpdir(), 'claims-')); git(d, 'init', '-q', '-b', 'main');
  put(d, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' } }) + '\n'); put(d, '.gitignore', 'build\n');
  put(d, 'src/add.js', 'exports.add=(a,b)=>a-b\n');
  put(d, 'test/add.test.js', "require('node:test').test('add',()=>require('node:assert').equal(require('../build/add.js').add(2,2),4))\n"); save(d, 'base');
  const cfg = JSON.stringify({ repeat: 1, setup: 'mkdir -p build && cp src/add.js build/add.js', metrics: [{ name: 'tests_pass', cmd: 'npm test --silent', extract: 'exit', direction: 'pass', guard: true }] }) + '\n';
  edit(d, 'src/add.js', fixAdd); put(d, 'promptwheel.config.json', cfg);
  const r = sb(d, 'check'); assert.equal(r.code, 2, r.out);
  assert.match(r.out, /this change also edits how the check measures[^\n]*Commit that edit on its own first/);
  // and doing what it says works: the setup on its own, then the fix
  git(d, 'checkout', '-q', '--', 'src/add.js'); save(d, 'measure with a build step'); edit(d, 'src/add.js', fixAdd);
  const ok = sb(d, 'check'); assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /verified/);
});
test('claim: signing does not move any of the repo\'s own counts: the tool\'s copied scanners are left out of every tripwire', () => {
  const d = repo(true); assert.equal(sb(d, 'contract', '--full').code, 0); save(d, 'sign');
  const rep = check(d);
  for (const n of ['test_count', 'skipped_tests', 'suppressions', 'assertions']) { const m = rep.metrics.find((x) => x.name === n); assert.equal(m.before, m.after, `${n} moved from ${m.before} to ${m.after} by signing`); }
});
test('claim: the CI workflow --full writes pins every action by commit, the check\'s own included, at the engine version this release pins', () => {
  const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); assert.equal(sb(d, 'contract', '--full').code, 0);
  const wf = readFileSync(join(d, '.github/workflows/sawbuck.yml'), 'utf8');
  const uses = [...wf.matchAll(/uses: (\S+)(?: # (\S+))?/g)]; assert.ok(uses.length >= 2, wf);
  for (const [, u] of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is not pinned by commit`);
  const own = uses.find(([, u]) => u.startsWith('promptwheel-ai/promptwheel@')); assert.ok(own, wf);
  assert.equal(own[2], `v${JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).dependencies.promptwheel}`, 'the comment names the pinned engine version');
  save(d, 'sign'); assert.equal(check(d).metrics.find((m) => m.name === 'unpinned_execution').after, 0, 'and the repo\'s own unpinned_execution guard counts nothing in it');
});
test('claim: doctor --all says user-level hooks cover every repo, not one folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const d = repo(true); assert.equal(sbE(d, { HOME: home }, 'attach', '--user').code, 0);
  const o = sbE(d, { HOME: home }, 'doctor', '--all').out;
  assert.match(o, /user\s+every repo you open in Claude Code/); assert.doesNotMatch(o.split('\n').find((l) => /^\s+user\s/.test(l)) || '', new RegExp(d.split('/').pop()));
});
test('claim: context with nothing to show prints nothing to stdout, so an old hook stays quiet, and says why on stderr', () => {
  const d = repo(true); put(d, 'x.txt', 'x\n'); save(d, 'second');
  const r = spawnSync(process.execPath, [CLI, 'context'], { cwd: d, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.match(r.stderr, /sawbuck: (no notable history|nothing changed)/);
});
// The printed verdict and the JSON are two views of one run. The report's worst finding was the two disagreeing
// (the terminal said "verified" while the JSON said the source carried none of the win), so they are checked together.
test('claim: the printed verdict and the JSON say the same thing, for every kind of result', () => {
  const word = (o) => (o.match(/^🐴 \S+ (verified|held|allowed with --allow|passed|gamed|sent back|inconclusive)/m) || [])[1];
  const expect = (rep) => rep.verdict === 'gamed' ? 'gamed' : rep.verdict === 'fail' ? 'sent back' : rep.verdict === 'inconclusive' ? 'inconclusive'
    : rep.allowed ? 'allowed with --allow' : rep.metrics.some((m) => m.status === 'improved' && !m.tripwire) ? 'verified' : 'held';
  const cases = {
    'an honest fix': [() => { const d = repo(false); edit(d, 'src/add.js', fixAdd); return d; }, []],
    'a test edited to go green': [() => { const d = repo(false); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); return d; }, []],
    'the same, waived': [() => { const d = repo(false); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); return d; }, ['--allow', 'the spec changed']],
    'nothing to measure': [() => { const d = repo(false); edit(d, 'src/add.js', (s) => s + '// x\n'); return d; }, []],
    'nothing to measure, waived': [() => { const d = repo(false); edit(d, 'src/add.js', (s) => s + '// x\n'); return d; }, ['--allow', 'ship it']],
    'a harmless change': [() => { const d = repo(true); edit(d, 'src/add.js', (s) => s + '// x\n'); return d; }, []],
    'a regression': [() => { const d = repo(true); edit(d, 'src/add.js', breakAdd); return d; }, []],
    'a protected path': [() => { const d = repo(true); sb(d, 'contract'); save(d, 'sign'); put(d, 'Dockerfile', 'FROM node:22\n'); return d; }, []],
    'the rules file, waived': [() => { const d = repo(true); sb(d, 'contract'); save(d, 'sign'); json(d, 'promptwheel.config.json', (o) => { o.repeat = 2; }); return d; }, ['--allow', 'more repeats']],
  };
  for (const [name, [make, flags]] of Object.entries(cases)) {
    const d = make(); const text = sb(d, 'check', ...flags); const rep = check(d, ...flags);
    assert.equal(word(text.out), expect(rep), `${name}: the terminal said "${word(text.out)}" for a JSON verdict of ${rep.verdict}${rep.allowed ? ' (allowed)' : ''}\n${text.out}`);
    assert.equal(text.code, rep.code, `${name}: the exit codes`);
    if (rep.allowed || rep.verdict !== 'pass') assert.doesNotMatch(text.out, /verified|the source carried the win/, `${name}: never "verified" on a waived or failed run`);
    if (rep.verdict === 'inconclusive') assert.equal(text.code, 3, `${name}: inconclusive is never exit 0`);
  }
});
// The report could not tell whether the tool was armed: status, doctor and the attachment list each told a different
// story under user-level hooks. Every way of attaching is checked against every command that reports it.
test('claim: however it is attached, status, the status line and doctor all say it is watching', () => {
  for (const mode of [[], ['--shared'], ['--git'], ['--user']]) {
    const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const env = { HOME: home };
    const d = repo(true); assert.equal(sbE(d, env, 'contract').code, 0); save(d, 'sign');
    assert.equal(sbE(d, env, 'attach', ...mode).code, 0, mode.join(' '));
    const name = mode[0] || 'project';
    assert.match(sbE(d, env, 'status').out, /watching/, `${name}: status`);
    assert.match(sbE(d, env, 'statusline').out, /watching/, `${name}: status line`);
    // doctor runs what each hook runs. The shared hooks run this version through npx, which exists only once it is
    // published, so that one is checked by the release script's cold test, not here.
    if (name !== '--shared') { const doc = sbE(d, env, 'doctor'); assert.equal(doc.code, 0, `${name}: doctor\n${doc.out}`); assert.match(doc.out, /OK/, `${name}: doctor`); }
    assert.match(sbE(d, env, 'doctor', '--all').out, /attached to/, `${name}: the list`);
  }
});
