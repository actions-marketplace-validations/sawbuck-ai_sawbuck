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
function wired(d) {
  assert.equal(sb(d, 'attach', '--claude').code, 0);
  const h = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks;
  const run = (cmd, ev) => spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: 's', prompt: 'x' }) }).stdout || '';
  return { prompt: () => run(h.UserPromptSubmit[0].hooks[0].command, 'UserPromptSubmit'), stop: () => run(h.Stop[0].hooks[0].command, 'Stop') };
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

// ------------------------------------------------------------ leaving
test('claim: detach removes the hooks', () => { const d = signed(true); wired(d); assert.equal(sb(d, 'detach', '--claude').code, 0); assert.ok(!existsSync(join(d, '.claude/settings.local.json'))); });
test('claim: the signed contract stays after detach, and --purge removes the record', () => { const d = signed(true); wired(d); check(d); sb(d, 'detach', '--claude', '--purge'); assert.ok(existsSync(join(d, 'promptwheel.config.json'))); assert.ok(!existsSync(join(d, '.sawbuck'))); assert.ok(!existsSync(join(d, '.promptwheel/outcomes.jsonl'))); });
