// Every public claim as a test, the stated limits included. A sentence on the site or in a README that has no
// test here is a sentence nobody has checked. CLAIMS_SAWBUCK points this at an installed package, so the same
// file proves what is on npm: CLAIMS_SAWBUCK=/path/to/node_modules/sawbuck/sawbuck.mjs node --test test/claims.test.mjs
// Runs on a clean account on purpose: a developer's global gitignore hid a bug that blocked every turn.
import '../testkit.mjs';   // first: a throwaway HOME and temp folder for everything this file starts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, lstatSync, chmodSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.CLAIMS_SAWBUCK || join(HERE, '..', 'sawbuck.mjs');
// the line a person is given to type names the version that printed it (copies.mjs). The suites look for no other
// sawbuck on PATH (testkit.mjs), so here it is always the pinned form.
const VERSION = JSON.parse(readFileSync(join(dirname(CLI), 'package.json'), 'utf8')).version;
const PIN = `npx -y sawbuck@${VERSION}`;
const lit = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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
  const run = (cmd, ev, text = 'x') => spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: session, prompt: text }) }).stdout || '';
  const byMatcher = (ev, m) => (h[ev] || []).find((x) => String(x.matcher || '') === m).hooks[0].command;
  const editHook = (ev, file) => spawnSync('sh', ['-c', byMatcher(ev, 'Edit|Write|MultiEdit|NotebookEdit')], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: ev, tool_name: 'Edit', tool_input: { file_path: join(d, file), old_string: 'a', new_string: 'b' }, cwd: d, session_id: session }) }).stdout || '';
  const agentEdit = (file, fn) => { editHook('PreToolUse', file); edit(d, file, fn); editHook('PostToolUse', file); };
  const pre = (cmd) => spawnSync('sh', ['-c', byMatcher('PreToolUse', 'Bash')], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd: d, session_id: session }) }).stdout || '';
  return { prompt: (text) => run(h.UserPromptSubmit[0].hooks[0].command, 'UserPromptSubmit', text), stop: () => run(h.Stop[0].hooks[0].command, 'Stop'), compact: () => run(h.SessionStart[0].hooks[0].command, 'SessionStart'), pre, agentEdit };
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
// found by running the first commands on real repos (proof-bench/onboard): npm/node-semver ignores everything its
// .gitignore does not list, so git status never showed the two files signing writes
test('claim: in a repo whose ignore rules hide new files, the dry run still lists what signing writes, and signing says how to add them', () => {
  const d = repo(true); put(d, '.gitignore', '/*\n!/.gitignore\n!/package.json\n!/src/\n!/test/\n'); save(d, 'ignore everything not listed');
  let o = sb(d, 'contract', '--dry-run').out;
  assert.doesNotMatch(o, /already signed/, 'it is not signed yet');
  assert.match(o, /promptwheel\.config\.json\s+new/); assert.match(o, /AGENTS\.md\s+new/);
  assert.match(o, /hides? .*from git[^\n]*git add -f AGENTS\.md promptwheel\.config\.json/);
  assert.equal(git(d, 'status', '--porcelain'), '', 'and the dry run wrote nothing');
  o = sb(d, 'contract').out;
  assert.match(o, /signed/); assert.match(o, /git add -f AGENTS\.md promptwheel\.config\.json/);
  assert.doesNotMatch(o, /^\s*Commit promptwheel\.config\.json and AGENTS\.md\./m, 'not the plain line: git would skip both');
  git(d, 'add', '-f', 'AGENTS.md', 'promptwheel.config.json'); git(d, 'commit', '-qm', 'sign');
  assert.match(sb(d, 'contract', '--dry-run').out, /already signed, nothing would change/);
  // a repo with ordinary ignore rules keeps the plain line
  const e = repo(true); o = sb(e, 'contract').out;
  assert.match(o, /Commit promptwheel\.config\.json and AGENTS\.md\./); assert.doesNotMatch(o, /git add -f/);
});
// found by reading 340 real commits with the plain contract in force (proof-bench/contract-replay, 2026-11-12): a silencer
// count that blocks sent back 13 commits where a person added a lint silencer in ordinary work, most of it in new tests
test('claim: with a plain contract one more lint silencer is a note, and --strict makes it send the change back', () => {
  const more = (d) => { edit(d, 'test/add.test.js', (s) => s + "t.test('add again',()=>a.equal(add(1,1),2)) // eslint-disable-line no-undef\n"); save(d, 'one more test, with a silencer'); };
  const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); more(d);
  let r = sb(d, 'check'); assert.equal(r.code, 0, r.out); assert.match(r.out, /note: more silenced checks/);
  const e = repo(true); assert.equal(sb(e, 'contract', '--strict').code, 0); save(e, 'sign'); more(e);
  r = sb(e, 'check'); assert.equal(r.code, 1, r.out); assert.match(r.out, /needs a look: more silenced checks/);
});
// the other half of the same rule, and the reason the note is conditional: a silencer that arrives with a green it could
// have bought is the cheat the count exists for. A plain note let it through (seen 2026-11-12, before any release).
test('claim: with a plain contract a lint error silenced to get to green is still sent back, and the real fix is earned', () => {
  const LINT = "const bad = require('fs').readFileSync('src/add.js', 'utf8').split('\\n').filter((l) => /\\bvar\\b/.test(l) && !/eslint-disable/.test(l)); process.exit(bad.length ? 1 : 0);\n";
  const red = () => { const d = repo(true); put(d, 'lint.js', LINT); json(d, 'package.json', (p) => { p.scripts.test = 'node lint.js'; }); edit(d, 'src/add.js', (s) => 'var legacy = 1;\n' + s); save(d, 'a lint step, red'); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); return d; };
  let d = red(); edit(d, 'src/add.js', (s) => s.replace('var legacy = 1;', 'var legacy = 1; // eslint-disable-line no-var')); save(d, 'make it green');
  let r = sb(d, 'check'); assert.equal(r.code, 1, r.out); assert.match(r.out, /needs a look: more silenced checks/);
  d = red(); edit(d, 'src/add.js', (s) => s.replace('var legacy = 1;', 'const legacy = 1;')); save(d, 'fix');
  r = sb(d, 'check'); assert.equal(r.code, 0, r.out);
});
// found the same night: npm/node-semver runs npm's template-oss check inside `npm test`, and it fails when a tracked file
// matches .gitignore. Following the `git add -f` line there made the repo's own tests fail, so every check after signing
// read "could not measure" (16 of 20 real commits). The way in is that repo's own allowlist, tried in a clean container.
test('claim: in a repo whose tests run npm\'s template-oss check, signing says to allow its files in that repo\'s own settings, not to force them in', () => {
  const HIDE = '/*\n!/.gitignore\n!/package.json\n!/src/\n!/test/\n';
  const d = repo(true); put(d, '.gitignore', HIDE);
  json(d, 'package.json', (p) => { p.scripts.postlint = 'template-oss-check'; p.templateOSS = { version: '5.0.0', allowPaths: ['/src/'] }; });
  save(d, 'a template-oss repo');
  for (const flags of [['--dry-run'], []]) {
    const o = sb(d, 'contract', ...flags).out;
    assert.match(o, /template-oss check/); assert.match(o, /"allowPaths"/); assert.match(o, /"\/AGENTS\.md" and "\/promptwheel\.config\.json"/); assert.match(o, /npx template-oss-apply --force/);
    assert.doesNotMatch(o, /git add -f/, 'not the add -f line: with the files tracked and still ignored, this repo\'s own tests fail');
  }
  // hidden files and no such check: the add -f line, and no word about template-oss
  const e = repo(true); put(e, '.gitignore', HIDE); save(e, 'ignore everything not listed');
  const o = sb(e, 'contract').out; assert.match(o, /git add -f AGENTS\.md promptwheel\.config\.json/); assert.doesNotMatch(o, /template-oss/);
});
test('claim: --dry-run writes nothing', () => { const d = repo(true); assert.equal(sb(d, 'contract', '--dry-run').code, 0); assert.equal(git(d, 'status', '--porcelain'), ''); });

// ------------------------------------------------------------ protected paths
for (const [name, f] of [['workflows', '.github/workflows/x.yml'], ['registry config', '.npmrc'], ['build images', 'Dockerfile'], ['publish scripts', 'scripts/release.sh'], ['code owners', 'CODEOWNERS'], ['hook config', '.claude/settings.json'], ['scanners', '.promptwheel/packs/supply-chain/README.md'], ['the lock', 'promptwheel.lock.json']]) {
  test(`claim: a change to ${name} fails the gate`, () => { const d = signed(true); put(d, f, 'x\n'); git(d, 'add', '-A', '-f'); git(d, 'commit', '-qm', 'x'); const r = check(d); assert.equal(r.code, 1); assert.ok((r.mandates || []).length > 0); });
}
test('claim: moving a file out of a protected path counts as touching it', () => { const d = signed(true); put(d, 'scripts/release.sh', 'x\n'); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'p', '-q'); git(d, 'mv', 'scripts/release.sh', 'rel.sh'); git(d, 'commit', '-qm', 'mv'); assert.equal(check(d).code, 1); });
test('claim: a new install script fails the gate', () => { const d = signed(true); json(d, 'package.json', (o) => { o.scripts.postinstall = 'x'; }); save(d, 'x'); assert.equal(check(d).code, 1); });
test('claim: under --strict a new dependency needs a reason from a person, and it moves more than one count, so the reason names each', () => {
  const d = strict(true); json(d, 'package.json', (o) => { o.dependencies = { 'left-pad': '1.3.0' }; }); save(d, 'x');
  const r = check(d); assert.equal(r.code, 1); assert.ok(r.allowable.length > 1 && r.allowable.includes('dependency_entries'), JSON.stringify(r.allowable));
  assert.equal(check(d, '--allow', 'a person said so').code, 1, 'a reason that names none of them lets none through');
  const o = sb(d, 'check'); assert.ok(o.out.includes(`--allow "${r.allowable.join(', ')}: <reason>"`), o.out);   // the line to copy
  assert.equal(check(d, '--allow', `${r.allowable.join(', ')}: a person said so`).code, 0);
});
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
test('claim: a commit the person makes between turns is theirs, not scored; the agent\'s own commit in a turn still is', () => { const d = signed(true); const w = wired(d); w.prompt(); w.stop(); put(d, 'test/red.test.js', "const t=require('node:test'),a=require('node:assert');t.test('red',()=>a.equal(1,2))\n"); save(d, 'a red test first, by the person'); w.prompt(); assert.ok(!blocked(w.stop())); const rec = () => { try { return JSON.parse(readFileSync(join(d, '.sawbuck', 'results.json'), 'utf8')); } catch { return { regressions: 0, gamed: 0 }; } }; assert.equal(rec().regressions || 0, 0, 'the red test the person committed between turns is not the agent\'s regression'); assert.equal(rec().gamed || 0, 0); w.prompt(); edit(d, 'test/red.test.js', (s) => s.replace('a.equal(1,2)', 'a.equal(1,1)')); save(d, 'make it pass'); w.stop(); assert.equal(rec().gamed, 1, 'the agent\'s own commit in the turn, a test edited to pass, still reads gamed'); });
test('claim: an outward command asks a person first; a test run does not; the hold can be turned off for a repo', () => { const d = signed(true); const w = wired(d); assert.match(w.pre('npm publish'), /"permissionDecision":"ask"/); assert.match(w.pre('gh pr merge 12 --squash'), /"ask"/); assert.match(w.pre('git push --force origin main'), /"ask"/); assert.match(w.pre('gh issue comment 3 --body hi'), /"ask"/); assert.equal(w.pre('npm test').trim(), ''); assert.equal(w.pre('git push origin main').trim(), '', 'a plain push is not held by default'); assert.equal(w.pre('git commit -m x').trim(), ''); put(d, 'sawbuck.config.json', JSON.stringify({ holds: { off: true } })); assert.equal(w.pre('npm publish').trim(), ''); put(d, 'sawbuck.config.json', JSON.stringify({ holds: { outward: ['\\bgit\\s+push\\b'] } })); assert.match(w.pre('git push origin main'), /"ask"/, 'a repo can add its own'); });
test('claim: on a clean account a signed repo does not block a clean turn', () => { const d = signed(true); const w = wired(d); for (let i = 0; i < 3; i++) { w.prompt(); assert.ok(!blocked(w.stop()), `turn ${i}`); } assert.equal(git(d, 'status', '--porcelain'), ''); assert.equal(check(d).code, 0); });
test('claim: saying yes to the offer does not block its own turn: signing and attaching mid-turn on a clean account', () => { const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); assert.equal(sb(d, 'contract').code, 0); const w = wired(d); assert.ok(!blocked(w.stop()), 'the signing turn ends'); save(d, 'sign'); w.prompt(); assert.ok(!blocked(w.stop()), 'the next clean turn'); w.prompt(); put(d, '.npmrc', 'x\n'); assert.ok(blocked(w.stop()), 'and the wall still works'); });
test('claim: attaching mid-turn does not spare what the agent does next in that turn', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); const w = wired(d); put(d, '.npmrc', 'x\n'); assert.ok(blocked(w.stop())); });
test('claim: the first turn after attach is checked', () => { const d = signed(false); const w = wired(d); w.prompt(); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'cheat'); assert.ok(blocked(w.stop())); });
test('claim: every turn checks protected paths, uncommitted included', () => { const d = signed(true); const w = wired(d); w.prompt(); put(d, '.npmrc', 'x\n'); assert.ok(blocked(w.stop())); });
test('claim: a fresh contract the person left uncommitted, swept unchanged into the agent\'s commit, is not the agent touching it', () => {
  const d = repo(true); assert.equal(sb(d, 'contract').code, 0); const w = wired(d);   // signed, attached, not committed
  w.prompt(); put(d, 'src/extra.js', 'exports.x=1\n'); save(d, 'add extra');   // the agent's git add -A takes the contract along
  assert.match(git(d, 'show', '--name-only', '--format=', 'HEAD'), /promptwheel\.config\.json/, 'the contract rode along');
  assert.ok(!blocked(w.stop()), 'committing the person\'s file as it was is not touching it');
});
test('limit: the agent editing that uncommitted contract and committing it is still sent back', () => {
  const d = repo(true); assert.equal(sb(d, 'contract').code, 0); const w = wired(d);
  w.prompt(); const p = join(d, 'promptwheel.config.json'); const c = JSON.parse(readFileSync(p, 'utf8')); c.mandates = []; writeFileSync(p, JSON.stringify(c)); save(d, 'loosen');
  assert.ok(blocked(w.stop()));
});
// Found 2026-11-16 (proof-bench/swept-in, then proof-bench/beside-guard), in every version from 0.1.64 to 0.1.72. The
// engine answers "fail" for a change that touches a protected path or makes a guard worse, and "gamed" only when
// neither is so; a win in the same change that came from editing the test is then in the report (the metric is marked
// gamed) and not in the word. reflect.mjs read the word, and the end of a turn sends back only what is recorded as
// gamed. Fixed in 0.1.73: a gamed win is recorded as gamed whatever else the change holds. Each claim below failed on
// 0.1.72.
const game = (s) => s.replace('add(2,2),4', 'add(2,2),0');
const ungame = (s) => s.replace('add(2,2),0', 'add(2,2),4');
const latest = (d) => { try { return JSON.parse(readFileSync(join(d, '.sawbuck/results.json'), 'utf8')).latest || {}; } catch { return {}; } };
test('claim: a gamed commit that also carries the person\'s own uncommitted protected file is sent back for the gamed test, the file is not blamed on the agent, and the real fix ends it with that file still in the span', () => {
  const d = signed(false); const w = wired(d);
  put(d, '.npmrc', 'fund=false\n');   // the person's own, there before the prompt, not committed
  w.prompt(); edit(d, 'test/add.test.js', game); save(d, 'make it green');   // the agent's git add -A takes .npmrc along
  assert.match(git(d, 'show', '--name-only', '--format=', 'HEAD'), /\.npmrc/, 'the person\'s file rode along');
  const o = w.stop(); assert.ok(blocked(o), `the gamed test is sent back: ${o}`);
  assert.match(o, /the win on test\/add\.test\.js was gamed/); assert.doesNotMatch(o, /protected path/, 'the person\'s own file is not blamed on the agent');
  assert.equal(latest(d).kind, 'gamed'); assert.equal(latest(d).file, 'test/add.test.js', 'the catch names the test, not the file that rode along');
  const c = check(d); assert.notEqual(c.code, 0); assert.ok((c.mandates || []).some((m) => (m.files || []).includes('.npmrc')), 'the check on that commit still names the protected path');
  edit(d, 'src/add.js', fixAdd); edit(d, 'test/add.test.js', ungame); save(d, 'fix add, put the test back');
  assert.ok(!blocked(w.stop()), 'the source fix ends it, with .npmrc still in the span'); assert.equal(latest(d).kind, 'verified');
  w.prompt('next'); put(d, 'NOTES.md', 'n\n'); save(d, 'notes'); assert.ok(!blocked(w.stop()), 'and the next turn is not sent back');
});
test('claim: a person\'s reason for the test change ends the send-back even where their own protected file in the same commit still fails the check on it', () => {
  const d = signed(false); const w = wired(d); put(d, '.npmrc', 'fund=false\n');
  w.prompt(); edit(d, 'test/add.test.js', game); save(d, 'make it green'); assert.ok(blocked(w.stop()));
  const r = sb(d, 'check', '--allow', 'the spec changed: add subtracts now');
  assert.equal(r.code, 1, 'the check on the commit still fails for the protected path'); assert.match(r.out, /sent back: a protected path changed/);
  assert.match(r.out, /your reason is kept for tests_pass/, r.out);
  assert.ok(!blocked(w.stop()), 'the test change was a person\'s call'); assert.equal(latest(d).kind, 'allowed');
});
test('claim: a gamed test committed beside the agent\'s own protected edit: the first send-back names both, and putting the path back in a new commit does not end the turn', () => {
  const d = signed(false); const w = wired(d);
  w.prompt('make the add test pass'); edit(d, 'test/add.test.js', game); put(d, '.npmrc', 'fund=false\n'); save(d, 'make it green');
  let o = w.stop(); assert.ok(blocked(o)); assert.match(o, /protected path/); assert.match(o, /\.npmrc/);
  assert.match(o, /also has a win on test\/add\.test\.js that came from editing the test/, `the gamed test is named in the same message: ${o}`);
  git(d, 'rm', '-q', '.npmrc'); git(d, 'commit', '-qm', 'take .npmrc out');   // what the message asked for, as a new commit
  o = w.stop(); assert.ok(blocked(o), `the gamed test is sent back once the path is out: ${o}`); assert.match(o, /the win on test\/add\.test\.js was gamed/);
  rmSync(join(d, '.sawbuck', 'results.json')); assert.ok(blocked(w.stop()), 'and it holds with the results file deleted');
  edit(d, 'src/add.js', fixAdd); edit(d, 'test/add.test.js', ungame); save(d, 'fix add, put the test back');
  assert.ok(!blocked(w.stop()), 'the real fix ends it');
  // the control: the same protected edit beside an honest fix is sent back for the path, and ends once the path is out
  const e = signed(false); const x = wired(e); x.prompt('make the add test pass'); edit(e, 'src/add.js', fixAdd); put(e, '.npmrc', 'fund=false\n'); save(e, 'fix add');
  o = x.stop(); assert.ok(blocked(o)); assert.doesNotMatch(o, /also has a win/, 'an honest fix is not called gamed');
  git(e, 'rm', '-q', '.npmrc'); git(e, 'commit', '-qm', 'take .npmrc out'); assert.ok(!blocked(x.stop()), 'an honest fix ends once the path is out');
});
test('claim: with a contract written, a failing test that is deleted or skipped is sent back at the end of the turn, like an edited assertion, and so is an edited assertion beside a new suppression', () => {
  const ways = [
    ['deleted', (d) => edit(d, 'test/add.test.js', (s) => s.split('\n').filter((l) => !l.includes("'add'")).join('\n'))],
    ['skipped', (d) => edit(d, 'test/add.test.js', (s) => s.replace("t.test('add'", "t.test.skip('add'"))],
    ['edited beside a new suppression', (d) => { edit(d, 'test/add.test.js', game); edit(d, 'src/add.js', (s) => '// eslint-disable-next-line no-unused-vars\n' + s); }],
  ];
  for (const [what, cheatIt] of ways) for (const flags of [['--full'], []]) {
    const d = repo(false); assert.equal(sb(d, 'contract', ...flags).code, 0); save(d, 'sign');
    const how = `the failing test ${what}, sawbuck contract ${flags.join(' ') || '(plain)'}`;
    const w = wired(d); w.prompt('make the add test pass'); cheatIt(d); save(d, 'make it green');
    const c = check(d); assert.equal(c.verdict, 'fail', `${how}: the engine's word is fail, a guard got worse`); assert.ok(c.metrics.some((m) => m.gamed === true), `${how}: and its report marks the green as gamed`);
    const o = w.stop(); assert.ok(blocked(o), `${how}: sent back, said: ${o}`); assert.match(o, /was gamed/, how);
    assert.equal(latest(d).kind, 'gamed', how);
    git(d, 'checkout', '-q', 'HEAD~1', '--', '.'); edit(d, 'src/add.js', fixAdd); save(d, 'put it all back, fix add');
    assert.ok(!blocked(w.stop()), `${how}: the real fix ends it`);
  }
});
test('claim: the source fixed with the failing test still deleted: the gamed verdict comes down, and the count that got worse is said once like any regression, not walled', () => {
  const d = signed(false); const w = wired(d); w.prompt('make the add test pass');
  edit(d, 'test/add.test.js', (s) => s.split('\n').filter((l) => !l.includes("'add'")).join('\n')); save(d, 'make it green'); assert.ok(blocked(w.stop()));
  edit(d, 'src/add.js', fixAdd); save(d, 'fix add');   // the source is right now; the test is still gone
  const o = w.stop(); assert.ok(!blocked(o), `the green is earned from the source now: ${o}`); assert.match(o, /Sawbuck caught a problem/);
  assert.equal(latest(d).kind, 'regression', JSON.stringify(latest(d))); assert.ok(!existsSync(guardFile(d)) || !JSON.parse(readFileSync(guardFile(d), 'utf8')).standing, 'the second copy is down too');
  w.prompt('next'); put(d, 'NOTES.md', 'n\n'); save(d, 'notes'); assert.ok(!blocked(w.stop()), 'and the next turn is not sent back');
  // the control: the test still deleted and the source NOT fixed stays sent back, turn after turn
  const e = signed(false); const x = wired(e); x.prompt('make the add test pass');
  edit(e, 'test/add.test.js', (s) => s.split('\n').filter((l) => !l.includes("'add'")).join('\n')); save(e, 'make it green'); assert.ok(blocked(x.stop()));
  edit(e, 'src/add.js', (s) => s + 'exports.sub=(a,b)=>a-b\n'); save(e, 'something else'); assert.ok(blocked(x.stop()), 'a source edit that does not earn the green changes nothing');
});
test('claim: a failing test a person asked to have deleted: their reason ends the send-back, though the count of tests still fails the check on the commit', () => {
  const d = signed(false); const w = wired(d); w.prompt('that add test is wrong, delete it');
  edit(d, 'test/add.test.js', (s) => s.split('\n').filter((l) => !l.includes("'add'")).join('\n')); save(d, 'delete the add test'); assert.ok(blocked(w.stop()));
  const r = sb(d, 'check', '--allow', 'I asked for that test to go'); assert.equal(r.code, 1, r.out); assert.match(r.out, /your reason is kept for tests_pass/, r.out);
  assert.ok(!blocked(w.stop()), 'a person\'s call'); assert.equal(latest(d).kind, 'allowed');
  w.prompt('next'); put(d, 'NOTES.md', 'n\n'); save(d, 'notes'); assert.ok(!blocked(w.stop()), 'and the next turn is not sent back');
});
test('claim: putting the test back ends a gamed send-back, even when the suite is red again and a try at the source is left in', () => {
  let { d, w } = sentBackTurn(); git(d, 'checkout', '-q', 'HEAD~1', '--', 'test/add.test.js'); save(d, 'put the test back');
  assert.ok(!blocked(w.stop()), 'the test is back as it was: nothing is gamed any more');
  assert.equal(latest(d).kind, 'put back', 'the record says what happened in the words the message uses');
  w.prompt('next'); put(d, 'NOTES.md', 'n\n'); save(d, 'notes'); assert.ok(!blocked(w.stop()), 'and the next turn is not sent back');
  ({ d, w } = sentBackTurn()); git(d, 'checkout', '-q', 'HEAD~1', '--', 'test/add.test.js'); edit(d, 'src/add.js', (s) => s.replace('a-b', 'b-a')); save(d, 'put the test back; a try that does not fix it');
  assert.ok(!blocked(w.stop()), 'a source edit that fixes nothing is not a gamed test');
  // the control: the test is still edited, and mul is broken so the suite is red: nothing was put back
  ({ d, w } = sentBackTurn()); edit(d, 'src/add.js', (s) => s.replace('a*b', 'a/b')); save(d, 'break mul');
  assert.ok(blocked(w.stop()), 'the test is still edited: the verdict stands while the suite is red');
});
// Found by the rehearsal of 2026-11-16 (proof-bench/live/rehearse-0.1.73): the person said "put the test back and stop
// there", the agent restored the file and did not commit, and the turn was sent back three times for a gamed green that
// was no longer in the tree. The verdict stays up until a commit settles it, so throwing the restore away brings it back.
test('claim: the test put back in the working tree and not committed yet: the turn is not sent back, the person is told the commit settles it, and throwing the restore away brings the send-back back', () => {
  const { d, w } = sentBackTurn(); const base = git(d, 'rev-parse', 'HEAD~1');
  git(d, 'checkout', '-q', base, '--', 'test/add.test.js'); git(d, 'reset', '-q');   // back as it was, in the working tree only
  assert.match(git(d, 'status', '--porcelain'), /M test\/add\.test\.js/);
  const o = w.stop(); assert.ok(!blocked(o), `not sent back: ${o}`);
  assert.match(o, /test\/add\.test\.js is back as it was in your working tree, not committed yet/); assert.match(o, /commit/);
  assert.equal(latest(d).kind, 'gamed', 'the verdict stays up until a commit settles it');
  assert.doesNotMatch(w.stop(), /back as it was/, 'said once for this state');
  git(d, 'checkout', '-q', '--', 'test/add.test.js');   // the restore thrown away: the gamed test is in the tree again
  w.prompt('next'); assert.ok(blocked(w.stop()), 'the gamed test is in the tree again: sent back');
  git(d, 'checkout', '-q', base, '--', 'test/add.test.js'); save(d, 'put the test back'); assert.ok(!blocked(w.stop()), 'committed: settled');
  assert.equal(latest(d).kind, 'put back'); assert.equal(latest(d).takenBack, true);
});
test('claim: the gamed send-back asks the agent for a direct question to the person, the form the end of a turn waits for', () => {
  const { w } = gamedTurn(); const o = w.stop(); assert.ok(blocked(o));
  assert.match(o, /end your turn by showing the person the test change and asking them what to do, as a direct question/);
});
test('claim: accepting the test change in a turn that made more than one commit: the message gives the line with the span, a reason for the last commit alone does not end it, and the line does', () => {
  const d = signed(false); const w = wired(d); w.prompt('make the add test pass'); edit(d, 'test/add.test.js', game); save(d, 'make it green'); put(d, 'NOTES.md', 'n\n'); save(d, 'notes');
  for (let i = 0; i < 3; i++) assert.ok(blocked(w.stop()));
  const base = git(d, 'rev-parse', 'HEAD~2').slice(0, 12);
  const told = w.stop(); assert.match(told, lit(`${PIN} check --base ${base} --allow \\"<why>\\"`), `the person is given the line that names the span: ${told}`);
  const r1 = sb(d, 'check', '--allow', 'the spec changed'); assert.match(r1.out, lit(`${PIN} check --base ${base} --allow "<reason>"`), `a reason for the last commit alone says what to type: ${r1.out}`);
  w.prompt('again'); assert.ok(blocked(w.stop()), 'and the verdict still stands');
  mkdirSync(join(d, 'src', 'deep'), { recursive: true });
  const r2 = sb(join(d, 'src', 'deep'), 'check', '--base', base, '--allow', 'the spec changed'); assert.equal(r2.code, 0, r2.out);
  assert.ok(!blocked(w.stop()), 'the reason for the whole span ends it, typed from a subfolder'); assert.equal(latest(d).kind, 'allowed');
  // one commit: the line has no span in it, as before
  const one = gamedTurn(); for (let i = 0; i < 3; i++) one.w.stop();
  const t1 = one.w.stop(); assert.match(t1, lit(`${PIN} check --allow \\"<why>\\"`)); assert.doesNotMatch(t1, /check --base/);
});
test('claim: the check says a win was gamed even when its word for the change is "sent back" for something else', () => {
  // a deleted failing test in a signed repo: the count of tests fails the check, and the green was gamed as well
  let d = signed(false); edit(d, 'test/add.test.js', (s) => s.split('\n').filter((l) => !l.includes("'add'")).join('\n')); save(d, 'make it green');
  let r = sb(d, 'check'); assert.equal(r.code, 1); assert.match(r.out, /sent back: this change made something worse/); assert.match(r.out, /a win in this change was gamed as well/, r.out);
  // a gamed test beside a path that takes no reason: only one thing takes a reason, so no list was printed, and the gamed test went unsaid
  d = signed(false); edit(d, 'test/add.test.js', game); put(d, '.npmrc', 'x\n'); save(d, 'make it green');
  r = sb(d, 'check'); assert.equal(r.code, 1); assert.match(r.out, /sent back: a protected path changed/); assert.match(r.out, /a win in this change was gamed as well/, r.out);
  // the controls: a plain gamed commit says gamed once, and a change that only makes something worse does not say gamed
  d = signed(false); edit(d, 'test/add.test.js', game); save(d, 'make it green'); r = sb(d, 'check'); assert.equal(r.code, 2); assert.doesNotMatch(r.out, /as well/);
  d = signed(true); put(d, '.npmrc', 'x\n'); save(d, 'registry'); r = sb(d, 'check'); assert.equal(r.code, 1); assert.doesNotMatch(r.out, /gamed/);
});
test('limit: a test deleted from a green suite, a count worse with nothing gamed, is said once at the end of the turn and not sent back; the check on the commit fails it', () => {
  const d = signed(true); const w = wired(d); w.prompt('tidy the tests');
  edit(d, 'test/add.test.js', (s) => s.split('\n').filter((l) => !l.includes("'mul'")).join('\n')); save(d, 'drop the mul test');
  const c = check(d); assert.equal(c.code, 1, JSON.stringify(c.metrics)); assert.ok(!c.metrics.some((m) => m.gamed === true), 'nothing was won, so nothing is gamed');
  const o = w.stop(); assert.ok(!blocked(o), o); assert.match(o, /Sawbuck caught a problem/); assert.equal(latest(d).kind, 'regression');
  assert.doesNotMatch(w.stop(), /Sawbuck caught/, 'said once');
});
// Found in the same rehearsal, and NOT fixed in 0.1.73 (roadmap L41). In Claude Code 2.1.318 a line the person runs with
// `!` starts a model turn of its own, and no prompt event reaches the hooks for it: the baseline is the one the last
// typed prompt took. This holds today's behaviour so the README's sentence stays true; the fix turns its middle round.
test('limit: a shell line a person runs inside a session starts a turn with no prompt event, so their own protected edit made that way is sent back as the agent\'s; made between two typed prompts it is theirs', () => {
  const d = signed(true); const w = wired(d); w.prompt('look around'); assert.ok(!blocked(w.stop()), 'a quiet turn ends');
  put(d, '.npmrc', 'fund=false\n');   // the person's own edit, by a `!` line: the next thing the hooks see is the end of a turn
  const o = w.stop(); assert.ok(blocked(o), 'the limit: read as the agent\'s'); assert.match(o, /Undo the changes YOU made/);
  const e = signed(true); const x = wired(e); x.prompt('look around'); x.stop(); put(e, '.npmrc', 'fund=false\n');
  x.prompt('next'); assert.ok(!blocked(x.stop()), 'with a typed prompt after it, the same edit is the person\'s');
});
test('claim: the git hook records a gamed test as gamed when the same commit drops the test or touches a protected path', () => {
  let d = hookRepo(); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); sb(d, 'attach', '--git');
  edit(d, 'test/add.test.js', (s) => s.split('\n').filter((l) => !l.includes("'add'")).join('\n')); let o = commit(d, 'make it green');
  assert.equal(latest(d).kind, 'gamed', `the failing test deleted: ${JSON.stringify(latest(d))}`); assert.match(o, /gamed/);
  d = hookRepo(); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); sb(d, 'attach', '--git');
  edit(d, 'test/add.test.js', game); put(d, '.npmrc', 'x\n'); o = commit(d, 'make it green');
  assert.equal(latest(d).kind, 'gamed', `beside a protected path: ${JSON.stringify(latest(d))}`); assert.equal(latest(d).file, 'test/add.test.js');
  assert.match(String(latest(d).reason), /protected path/, 'and the reason still names the protected path, which the git hook has no wall for');
});
test('limit: two sessions in one checkout: the one that touched a protected file is sent back, and so is the other, told not to undo what it did not change', () => {
  const d = signed(true); const a = wired(d, 'A'), b = wired(d, 'B');
  a.prompt(); put(d, '.npmrc', 'x\n'); b.prompt();
  assert.ok(blocked(a.stop()), 'the protected edit does not walk through when another session prompts in between');
  const o = b.stop(); assert.ok(blocked(o), 'the other session is sent back too (one shared record)'); assert.match(o, /do not revert anything you did not change/);
});
test('claim: a person editing a protected path between turns is not the agent', () => { const d = signed(true); const w = wired(d); w.prompt(); w.stop(); put(d, '.npmrc', 'x\n'); w.prompt(); assert.ok(!blocked(w.stop())); });
test('claim: a sent-back protected path says how a person accepts it: --allow for the rules file and the hooks, removing the rule for the rest', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); put(d, 'Dockerfile', 'FROM node:22\n'); save(d, 'docker'); let o = sb(d, 'check').out; assert.match(o, /sent back/); assert.match(o, /remove that rule from promptwheel\.config\.json in a commit of its own/); assert.doesNotMatch(o, /if a person meant this|check --allow "<reason>" accepts/); assert.equal(sb(d, 'check', '--allow', 'I asked for it').code, 1, 'and --allow really does not clear it'); git(d, 'reset', '-q', '--hard', 'HEAD~1'); put(d, '.claude/settings.json', '{}\n'); save(d, 'hooks'); o = sb(d, 'check').out; assert.match(o, lit(`${PIN} check --allow "<reason>"`)); assert.doesNotMatch(o, /remove that rule/); assert.equal(sb(d, 'check', '--allow', 'team hooks').code, 0); });
test('claim: attach --shared in a repo that already has its rules says the commit of that file needs --allow; with no rules it does not', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); assert.match(sb(d, 'attach', '--shared').out, /protected path in this repo[^\n]*--allow "team hooks"/); const e = repo(true); assert.doesNotMatch(sb(e, 'attach', '--shared').out, /protected path in this repo/); });
test('claim: it sends a turn back up to three times by default, then lets it end', () => { const d = signed(true); const w = wired(d); w.prompt(); put(d, '.npmrc', 'x\n'); const seen = []; for (let i = 0; i < 4; i++) seen.push(blocked(w.stop())); assert.deepEqual(seen, [true, true, true, false]); });

test('claim: a blocked protected path counts as one catch, however many send-backs', () => { const d = signed(true); const w = wired(d); w.prompt(); put(d, '.npmrc', 'x\n'); w.stop(); w.stop(); w.stop(); assert.match(sb(d, 'statusline').out, /1 caught/); assert.match(sb(d, 'status').out, /1 protected path/); assert.equal(readFileSync(join(d, '.sawbuck/activity.jsonl'), 'utf8').trim().split('\n').filter((l) => l.includes('"mandate"')).length, 1); });
test('claim: a gamed catch is handed to the memory running on this machine before the hook exits', async () => {
  // a fake claude-mem worker in this process; the hook must await the hand-off, since it exits the process to block the stop
  const got = []; const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push({ url: req.url, body: b }); res.setHeader('content-type', 'application/json'); res.end(req.url === '/api/health' ? '{"status":"ok"}' : '{"success":true,"id":1}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const home = mkdtempSync(join(tmpdir(), 'claims-mem-home-')); mkdirSync(join(home, '.claude-mem'), { recursive: true }); writeFileSync(join(home, '.claude-mem', '.worker.port'), String(srv.address().port));
  try {
    const d = signed(false); const w = wired(d); w.prompt();
    edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green');
    const cmd = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks.Stop[0].hooks[0].command;
    const out = await new Promise((res) => { const p = execFile('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', env: { ...ENV, HOME: home } }, (err, stdout) => res(stdout || '')); p.stdin.end(JSON.stringify({ hook_event_name: 'Stop', cwd: d, session_id: 'mem' })); });
    assert.ok(blocked(out), out);
    const save_ = got.find((g) => g.url === '/api/memory/save'); assert.ok(save_, 'the worker got the finding before the hook exited');
    const body = JSON.parse(save_.body); assert.equal(body.title, 'gamed: test/add.test.js edited to pass'); assert.equal(body.cwd, d);
    assert.match(readFileSync(join(d, '.sawbuck', 'shared.jsonl'), 'utf8'), /"kind":"gamed"/);
  } finally { srv.close(); }
});
// ------------------------------------------------------------ "what git threw away, shared with the team and CI"
const withRemote = () => { const d = signed(true); const bare = mkdtempSync(join(tmpdir(), 'claims-remote-')); git(bare, 'init', '-q', '--bare', '-b', 'main'); git(d, 'remote', 'add', 'origin', bare); git(d, 'push', '-q', 'origin', 'main'); return { d, bare }; };
const eraseRevert = (d) => { const k = git(d, 'rev-parse', 'HEAD'); put(d, 'src/cache.js', 'exports.c={}\n'); save(d, 'cache: add an LRU limit'); git(d, 'revert', '--no-edit', 'HEAD'); git(d, 'commit', '-q', '--amend', '-m', 'Revert "cache: add an LRU limit"\n\nIt logged users out.'); git(d, 'reset', '-q', '--hard', k); };
test('claim: an erased revert pushed to the shared ledger reaches a fresh clone, with its reason, before any edit there', () => {
  const { d, bare } = withRemote(); const w = wired(d); eraseRevert(d); w.prompt();   // the hook records the erased revert here
  assert.match(sb(d, 'ledger').out, /2 erased attempts kept here, 0 shared/, 'the attempt and its revert');
  const p1 = sb(d, 'ledger', 'push'); assert.equal(p1.code, 0, p1.out); assert.match(p1.out, /pushed to origin .*2 erased attempts, 2 new/);
  assert.match(sb(d, 'ledger', 'push').out, /nothing new to push/, 'a second push adds nothing');
  const c = mkdtempSync(join(tmpdir(), 'claims-clone-')); git(c, 'clone', '-q', bare, '.');
  assert.ok(!/logged users out/.test(sb(c, 'context').out), 'a plain clone has none of it');
  const pull = sb(c, 'ledger', 'pull'); assert.equal(pull.code, 0, pull.out); assert.match(pull.out, /2 erased attempts shared/);
  put(c, 'src/cache.js', 'exports.c={max:10}\n');   // context is scoped to the files in hand
  assert.match(sb(c, 'context').out, /reverted: Revert "cache: add an LRU limit".*It logged users out/, 'context in the clone shows the revert and why, with no attach there');
  const h = spawnSync(process.execPath, [CLI, 'turn', '--hook', c], { cwd: c, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: c, session_id: 'c', prompt: 'cap src/cache.js' }) }).stdout || '';
  assert.match(h, /logged users out/, 'a prompt in the clone that names the file gets the erased history with the prompt');
});
test('claim: the debt gate names what git threw away on the paths a branch touches, from the shared ledger', () => {
  const { d, bare } = withRemote(); const w = wired(d); eraseRevert(d); w.prompt(); assert.equal(sb(d, 'ledger', 'push').code, 0);
  const c = mkdtempSync(join(tmpdir(), 'claims-ci-')); git(c, 'clone', '-q', bare, '.'); git(c, 'fetch', '-q', 'origin', '+refs/sawbuck/ledger:refs/sawbuck/ledger');   // what the Action step does
  git(c, 'checkout', '-qb', 'feat'); put(c, 'src/cache.js', 'exports.c={max:10}\n'); save(c, 'cache again');
  const r = sb(c, 'debt', '--since', 'main'); assert.equal(r.code, 0, r.out); assert.match(r.out, /no new suppression debt/); assert.match(r.out, /from the ledger.*\n.*reverted: Revert "cache: add an LRU limit".*It logged users out/s);
  put(c, 'src/other.js', 'x\n'); save(c, 'unrelated'); git(c, 'checkout', '-q', 'main'); git(c, 'checkout', '-qb', 'feat2'); put(c, 'src/other.js', 'y\n'); save(c, 'other');
  assert.ok(!/logged users out/.test(sb(c, 'debt', '--since', 'main').out), 'a branch that does not touch the file hears nothing');
});
test('claim: the Action posts the erased history as a PR comment, by running its own step on the real debt output', () => {
  const { d, bare } = withRemote(); const w = wired(d); eraseRevert(d); w.prompt(); assert.equal(sb(d, 'ledger', 'push').code, 0);
  const c = mkdtempSync(join(tmpdir(), 'claims-pr-')); git(c, 'clone', '-q', bare, '.'); git(c, 'fetch', '-q', 'origin', '+refs/sawbuck/ledger:refs/sawbuck/ledger');
  git(c, 'checkout', '-qb', 'feat'); put(c, 'src/cache.js', 'exports.c={max:10}\n'); save(c, 'cache again');
  // the step's run block, taken from action.yml as written, with a stand-in gh that keeps the body it was handed
  const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  const step = yml.split('- name: the erased history, as a PR comment (opt-in)')[1]; assert.ok(step, 'the comment step exists');
  const script = step.split('run: |\n')[1].split('\n').filter((l) => /^ {8}\S/.test(l)).map((l) => l.slice(8)).join('\n');
  const run = (debtOut) => {
    const t = mkdtempSync(join(tmpdir(), 'claims-runner-')); mkdirSync(join(t, 'bin'));
    writeFileSync(join(t, 'bin', 'gh'), '#!/bin/sh\n[ "$1 $2 $3" = "pr comment 7" ] && cp "$5" "$RUNNER_TEMP/posted.md"\n', { mode: 0o755 });
    writeFileSync(join(t, 'sawbuck-debt.txt'), debtOut);
    const r = spawnSync('bash', ['-c', script], { cwd: c, encoding: 'utf8', env: { ...ENV, PATH: `${join(t, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: t, PR: '7', GH_TOKEN: 'x' } });
    assert.equal(r.status, 0, r.stderr); return existsSync(join(t, 'posted.md')) ? readFileSync(join(t, 'posted.md'), 'utf8') : null;
  };
  const posted = run(sb(c, 'debt', '--since', 'main').out);
  assert.ok(posted, 'a branch on the reverted file gets a comment');
  assert.match(posted, /reverted: Revert "cache: add an LRU limit".*It logged users out/s, 'the comment carries the revert and its reason');
  git(c, 'checkout', '-q', 'main'); git(c, 'checkout', '-qb', 'feat2'); put(c, 'src/other.js', 'y\n'); save(c, 'other');
  assert.equal(run(sb(c, 'debt', '--since', 'main').out), null, 'a branch that does not touch the file gets no comment');
});
test('limit: ledger push needs a remote and says so; pull from a remote with no ledger says so', () => {
  const d = signed(true); assert.match(sb(d, 'ledger', 'push').out, /no remote named origin/);
  const { d: e } = withRemote(); assert.match(sb(e, 'ledger', 'pull').out, /has no ledger yet/);
});
test('claim: after detach the record stays but says detached, so nothing reads it as watching; attach clears that', () => {
  const d = signed(true); wired(d); assert.ok(existsSync(join(d, '.sawbuck', 'state.json')));
  assert.equal(sb(d, 'detach').code, 0); const st = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8')); assert.equal(st.detached, true, 'the record is kept and marked');
  assert.equal(sb(d, 'attach', '--claude').code, 0); assert.ok(!JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8')).detached, 'attached again, the mark is gone');
  assert.equal(sb(d, 'detach', '--purge').code, 0); assert.ok(!existsSync(join(d, '.sawbuck', 'state.json')), 'purge removes the record itself');
});
// ------------------------------------------------------------ "what it tried and undid comes back, and the record stops it" (attempts bench: 27 of 27 vs 0 of 27)
const cacheLine = (s) => s.replace('exports.add=(a,b)=>a+b', 'const cache=new Map()\nexports.add=(a,b)=>{const k=a+","+b;if(cache.has(k))return cache.get(k);const v=a+b;cache.set(k,v);return v}');
test('claim: an edit the person had undone in a session comes back with the prompt that names the file, in their own words', () => {
  const d = signed(true); const w = wired(d); const before = readFileSync(join(d, 'src/add.js'), 'utf8');
  w.prompt('add is slow, speed it up'); w.agentEdit('src/add.js', cacheLine);   // the agent adds a cache
  w.prompt('Undo that. A stale cache logged people out after a password reset last time.'); w.agentEdit('src/add.js', () => before);   // the person says undo, the agent restores the file
  w.stop();
  assert.equal(readFileSync(join(d, 'src/add.js'), 'utf8'), before); assert.equal(git(d, 'status', '--porcelain'), '', 'nothing in git: no commit, no revert');
  const u = readFileSync(join(d, '.sawbuck', 'undone.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(u.length, 1); assert.equal(u[0].file, 'src/add.js'); assert.match(u[0].first, /cache/); assert.match(u[0].why, /logged people out/);
  const out = w.prompt('getUser-style: make src/add.js faster, it gets called a lot');
  assert.match(out, /undone here at your request .*cache.*src\/add\.js.*logged people out/, 'the prompt that names the file gets the undo and the reason');
  put(d, 'src/add.js', before + '//\n'); assert.match(sb(d, 'context').out, /undone here at your request/, 'context shows it for the file in hand');
  assert.match(sb(d, 'status').out, /1 undone in a session at your request/);
});
test('claim: a partial undo is kept too: the person said no to part of the change and the agent took that part out', () => {
  const d = signed(true); const w = wired(d); const before = readFileSync(join(d, 'src/add.js'), 'utf8');
  w.prompt('add is slow, add a cache and a log line'); w.agentEdit('src/add.js', (s) => s + 'const cache=new Map()\nconst hits=0\nfunction log(k){console.log(k)}\n');
  w.prompt('Drop the cache, it logged people out before. Keep the log line.'); w.agentEdit('src/add.js', () => before + 'function log(k){console.log(k)}\n');
  const u = readFileSync(join(d, '.sawbuck', 'undone.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(u.length, 1); assert.equal(u[0].kind, 'part'); assert.match(u[0].first, /cache/); assert.match(u[0].why, /logged people out/);
  assert.match(w.prompt('make src/add.js faster'), /partly undone here at your request .*cache/);
});
test('claim: under Codex the undo ledger reads the files apply_patch names; under Cursor it rebuilds the text before each edit', () => {
  const d = signed(true); sb(d, 'attach', '--codex'); const before = readFileSync(join(d, 'src/add.js'), 'utf8');
  const h = JSON.parse(readFileSync(join(d, '.codex/hooks.json'), 'utf8')).hooks;
  const by = (ev, m) => h[ev].find((x) => String(x.matcher || '') === m).hooks[0].command;
  const run = (cmd, input) => spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ cwd: d, session_id: 'cx', ...input }) }).stdout || '';
  const patch = { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/add.js\n@@\n+x\n*** End Patch' } };
  run(by('UserPromptSubmit', ''), { hook_event_name: 'UserPromptSubmit', prompt: 'add a cache' });
  run(by('PreToolUse', 'apply_patch'), { hook_event_name: 'PreToolUse', ...patch }); put(d, 'src/add.js', before + 'const cache=new Map()\nconst size=0\n'); run(by('PostToolUse', 'apply_patch'), { hook_event_name: 'PostToolUse', ...patch });
  run(by('UserPromptSubmit', ''), { hook_event_name: 'UserPromptSubmit', prompt: 'Undo that, a stale cache logged people out.' });
  run(by('PreToolUse', 'apply_patch'), { hook_event_name: 'PreToolUse', ...patch }); put(d, 'src/add.js', before); run(by('PostToolUse', 'apply_patch'), { hook_event_name: 'PostToolUse', ...patch });
  assert.match(readFileSync(join(d, '.sawbuck', 'undone.jsonl'), 'utf8'), /"kind":"whole".*logged people out/, 'Codex');
  const c = signed(true); sb(c, 'attach', '--cursor'); const cb = readFileSync(join(c, 'src/add.js'), 'utf8');
  const ch = JSON.parse(readFileSync(join(c, '.cursor/hooks.json'), 'utf8')).hooks;
  const cr = (ev, input) => spawnSync('sh', ['-c', ch[ev][0].command], { cwd: c, encoding: 'utf8', env: ENV, input: JSON.stringify({ conversation_id: 'k', ...input }) }).stdout || '';
  cr('beforeSubmitPrompt', { prompt: 'add a cache' }); const added = 'const cache=new Map()\nconst size=0\n';
  put(c, 'src/add.js', cb + added); cr('afterFileEdit', { file_path: join(c, 'src/add.js'), edits: [{ old_string: cb, new_string: cb + added }] });
  cr('beforeSubmitPrompt', { prompt: 'Undo that, a stale cache logged people out.' });
  put(c, 'src/add.js', cb); cr('afterFileEdit', { file_path: join(c, 'src/add.js'), edits: [{ old_string: cb + added, new_string: cb }] });
  assert.match(readFileSync(join(c, '.sawbuck', 'undone.jsonl'), 'utf8'), /"kind":"whole".*logged people out/, 'Cursor');
});
test('limit: an undo the agent makes on its own, with no word from the person in between, is not recorded', () => {
  const d = signed(true); const w = wired(d); const before = readFileSync(join(d, 'src/add.js'), 'utf8');
  w.prompt('try a cache in src/add.js'); w.agentEdit('src/add.js', cacheLine); w.agentEdit('src/add.js', () => before);
  assert.ok(!existsSync(join(d, '.sawbuck', 'undone.jsonl')), 'the agent changed its own mind: not an undo at the person\'s request');
  assert.ok(!/undone here/.test(w.prompt('make src/add.js faster')));
});
test('limit: the undo hook writes nothing in a repo sawbuck is not attached to', () => {
  const d = repo(true); const r = spawnSync(process.execPath, [CLI, 'undo', '--hook', d], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(d, 'src/add.js') }, session_id: 'x' }) });
  assert.equal(r.status, 0); assert.ok(!existsSync(join(d, '.sawbuck')));
});
// ------------------------------------------------------------ "a rebase inside a turn does not blame upstream's commits on the agent" (everflux: agents rebasing forks nightly)
test('claim: a turn that rebases onto upstream re-proves only the agent\'s own commits; an upstream test edit is not the agent\'s gamed green', () => {
  const d = signed(false); const w = wired(d);   // red at base: add is broken
  // upstream moves: a person over there made the red test pass by editing it (their business, not this agent's)
  git(d, 'checkout', '-qb', 'upstream'); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'upstream: adjust the add test'); put(d, 'src/mul.js', 'exports.x=1\n'); save(d, 'upstream: a new file');
  git(d, 'checkout', '-q', 'main'); git(d, 'checkout', '-qb', 'feat');
  // the person's own earlier commit on the branch skips a test (theirs to answer for); the rebase will replay it under a new sha
  put(d, 'test/later.test.js', "const t=require('node:test'),a=require('node:assert');t.test.skip('later',()=>a.equal(1,2))\n"); save(d, 'feat: a skipped test for later (the person)');
  w.prompt('rebase my branch onto upstream and add a note'); 
  put(d, 'NOTES.md', 'a note\n'); save(d, 'feat: a note');   // the agent's own honest commit
  git(d, 'rebase', '-q', 'upstream');   // history rewritten inside the turn: HEAD no longer descends from the last known sha
  const out = w.stop();
  assert.ok(!blocked(out), `upstream's test edit, or the person's replayed commit, was blamed on the agent: ${out}`);
  const recOf = () => { try { return JSON.parse(readFileSync(join(d, '.sawbuck', 'results.json'), 'utf8')); } catch { return {}; } };
  const act = readFileSync(join(d, '.sawbuck', 'activity.jsonl'), 'utf8');
  assert.equal(recOf().gamed || 0, 0); assert.match(act, /"kind":"verified".*NOTES\.md/, 'the agent\'s own replayed commit was re-proved');
  assert.ok(!/later\.test\.js/.test(act), 'the person\'s pre-turn commit, replayed by the rebase under a new sha, was not re-proved as the agent\'s');
  // and after the rebase the hook still catches the agent's own gamed green: the person commits a red test between turns, the agent edits it to pass
  put(d, 'test/red.test.js', "const t=require('node:test'),a=require('node:assert');t.test('red',()=>a.equal(1,2))\n"); save(d, 'a red test, by the person');
  w.prompt('make the red test pass'); edit(d, 'test/red.test.js', (s) => s.replace('a.equal(1,2)', 'a.equal(1,1)')); save(d, 'make it pass');
  assert.ok(blocked(w.stop()), 'the agent\'s own test edit after the rebase still reads gamed');
});
// ------------------------------------------------------------ Codex: the same hooks, Codex's contract (developers.openai.com/codex/hooks)
test('claim: attach --codex wires Codex: the rules reach the prompt, a gamed commit is sent back in JSON, an outward command is held, detach removes it', () => {
  const d = signed(false); const r = sb(d, 'attach', '--codex'); assert.equal(r.code, 0, r.out); assert.match(r.out, /trust them/);
  const h = JSON.parse(readFileSync(join(d, '.codex/hooks.json'), 'utf8')).hooks;
  const run = (ev, extra = {}, matcher) => spawnSync('sh', ['-c', (h[ev].find((x) => String(x.matcher || '') === String(matcher || '')) || h[ev][0]).hooks[0].command], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: 'cx', turn_id: 't1', model: 'gpt', permission_mode: 'default', ...extra }) }).stdout || '';
  assert.match(run('UserPromptSubmit', { prompt: 'make add pass' }), /rules \(sawbuck\)/, 'plain text on the prompt hook is added as context in Codex');
  edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green');
  const stop = run('Stop', { stop_hook_active: false, last_assistant_message: 'done' }); const j = JSON.parse(stop);
  assert.equal(j.decision, 'block'); assert.match(j.reason, /gamed/);
  const pre = JSON.parse(run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm publish' }, tool_use_id: 'u1' }, 'Bash'));
  assert.equal(pre.hookSpecificOutput.permissionDecision, 'deny', 'Codex does not support ask yet, so the hold denies'); assert.match(pre.hookSpecificOutput.permissionDecisionReason, /person/);
  assert.equal(run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'u2' }, 'Bash'), '');
  assert.ok(!/\.codex/.test(git(d, 'status', '--porcelain')), 'kept out of git status');
  assert.equal(sb(d, 'detach', '--codex').code, 0); assert.ok(!existsSync(join(d, '.codex/hooks.json')));
});
test('limit: under Codex a plain line from the Stop hook is wrapped as JSON, since Codex rejects plain text there', () => {
  const d = signed(true); sb(d, 'attach', '--codex'); const h = JSON.parse(readFileSync(join(d, '.codex/hooks.json'), 'utf8')).hooks;
  const run = (ev) => spawnSync('sh', ['-c', h[ev][0].hooks[0].command], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: 'cx', prompt: 'x' }) }).stdout || '';
  run('UserPromptSubmit'); edit(d, 'src/add.js', (s) => s.replace('a+b', 'a-b')); save(d, 'oops');
  const o = run('Stop').trim(); if (o) assert.doesNotThrow(() => JSON.parse(o), `not JSON: ${o}`);
});
test('claim: rules --notes flags a memory note that names only files the repo no longer has', () => {
  const d = signed(true); const home = mkdtempSync(join(tmpdir(), 'claims-notes-')); const md = join(home, '.claude', 'projects', d.replace(/\//g, '-'), 'memory'); mkdirSync(md, { recursive: true });
  writeFileSync(join(md, 'a.md'), '---\nname: a\ndescription: add lives in src/add.js\nmetadata:\n  type: project\n---\n\nThe adder is src/add.js.\n');
  writeFileSync(join(md, 'b.md'), '---\nname: b\ndescription: the cache is in src/cache.js\nmetadata:\n  type: project\n---\n\nCaching lives in src/cache.js and src/lru.js.\n');
  const o = spawnSync(process.execPath, [CLI, 'rules', '--notes'], { cwd: d, encoding: 'utf8', env: { ...ENV, HOME: home } }).stdout;
  assert.match(o, /stale\? it names src\/cache\.js, src\/lru\.js/); assert.ok(!/stale\? it names src\/add\.js/.test(o)); assert.match(o, /1 note name only files this repo no longer has/);
});
test('claim: attach --cursor wires Cursor: a gamed commit comes back as a follow-up message, an outward command asks, detach removes it', () => {
  const d = signed(false); const r = sb(d, 'attach', '--cursor'); assert.equal(r.code, 0, r.out);
  const h = JSON.parse(readFileSync(join(d, '.cursor/hooks.json'), 'utf8')); assert.equal(h.version, 1);
  const run = (ev, extra = {}) => spawnSync('sh', ['-c', h.hooks[ev][0].command], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ conversation_id: 'c1', generation_id: 'g1', hook_event_name: ev, workspace_roots: [d], ...extra }) }).stdout || '';
  assert.deepEqual(JSON.parse(run('beforeSubmitPrompt', { prompt: 'make add pass' })), { continue: true });
  edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green');
  const stop = JSON.parse(run('stop', { status: 'completed', loop_count: 0 })); assert.match(stop.followup_message || '', /gamed/);
  assert.deepEqual(JSON.parse(run('stop', { status: 'completed', loop_count: 3 })), {}, 'three send-backs, then the turn ends');
  const sh = JSON.parse(run('beforeShellExecution', { command: 'npm publish', cwd: d })); assert.equal(sh.permission, 'ask'); assert.match(sh.user_message, /publish/);
  assert.deepEqual(JSON.parse(run('beforeShellExecution', { command: 'npm test', cwd: d })), { permission: 'allow' });
  assert.ok(!/\.cursor/.test(git(d, 'status', '--porcelain')));
  assert.equal(sb(d, 'detach', '--cursor').code, 0); assert.ok(!existsSync(join(d, '.cursor/hooks.json')));
});
// the gamed send-back, and the person's way out of it
const gamedTurn = () => { const d = signed(false); const w = wired(d); w.prompt('make add pass'); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green'); return { d, w }; };
const stopSaying = (d, said) => { const t = join(d, '..', `transcript-${Date.now()}-${Math.random()}.jsonl`); writeFileSync(t, JSON.stringify({ type: 'user', message: { content: 'make add pass' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: said }] } }) + '\n');
  const cmd = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks.Stop[0].hooks[0].command;
  return spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: 'Stop', cwd: d, session_id: 's', transcript_path: t }) }).stdout || ''; };
test('claim: a gamed turn is sent back with two ways for the agent: fix the source as the test was, or show the person the test change and ask', () => {
  const { w } = gamedTurn(); const o = w.stop(); assert.ok(blocked(o));
  assert.match(o, /fix the source so the test passes as it was written/); assert.match(o, /do not change the source to fit it: end your turn by showing the person the test change and asking them/);
});
test('claim: an agent that asks the person about the test may end the turn, and the person gets the three choices as commands', () => {
  const { d } = gamedTurn();
  const o = stopSaying(d, 'I changed test/add.test.js to expect 0 because add subtracts. That may be the wrong call: should add really return 4 for add(2,2)?');
  assert.ok(!blocked(o), o); const m = JSON.parse(o).systemMessage;
  assert.match(m, /your agent is asking you about it/); assert.match(m, /git checkout [0-9a-f]+ -- test\/add\.test\.js/); assert.match(m, lit(`accept it: ${PIN} check --allow "<why>"`));
  assert.equal(JSON.parse(readFileSync(join(d, '.sawbuck/results.json'), 'utf8')).latest.kind, 'gamed', 'asking does not clear the verdict');
});
test('limit: an agent that says it is done, with no question to the person, is still sent back', () => {
  const { d } = gamedTurn(); assert.ok(blocked(stopSaying(d, 'Done. All tests pass now.')));
});
test('claim: after three send-backs the person is told the three choices', () => {
  const { w } = gamedTurn(); for (let i = 0; i < 3; i++) assert.ok(blocked(w.stop()));
  const o = w.stop(); assert.ok(!blocked(o)); const m = JSON.parse(o).systemMessage;
  assert.match(m, /stopped blocking after 3 tries/); assert.match(m, /git checkout [0-9a-f]+ -- test\/add\.test\.js/); assert.match(m, lit(`${PIN} check --allow`));
});
test('claim: enforce.maxBlocks 0 asks the person first: a gamed turn is not sent back, and the person gets the three choices at once', () => {
  const d = signed(false); put(d, 'sawbuck.config.json', JSON.stringify({ enforce: { maxBlocks: 0 } }) + '\n'); save(d, 'ask me first');
  const w = wired(d); w.prompt('make add pass'); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green');
  const o = w.stop(); assert.ok(!blocked(o), o); const m = JSON.parse(o).systemMessage;
  assert.match(m, /set to ask you first/); assert.match(m, /git checkout [0-9a-f]+ -- test\/add\.test\.js/); assert.match(m, lit(`${PIN} check --allow`));
});
test('claim: the person accepting the test change with --allow ends the send-back, and the hold asks before anyone types --allow', () => {
  const { d, w } = gamedTurn(); assert.ok(blocked(w.stop()));
  assert.match(w.pre('npx sawbuck check --allow "the spec changed"'), /"permissionDecision":"ask"/);
  assert.equal(sb(d, 'check', '--allow', 'the spec changed').code, 0);
  assert.ok(!blocked(w.stop()), 'allowed by a person: the turn may end');
  const r = JSON.parse(readFileSync(join(d, '.sawbuck/results.json'), 'utf8')).latest; assert.equal(r.kind, 'allowed'); assert.equal(r.allowed.reason, 'the spec changed');
});
test('claim: a block does not clear a gamed verdict that still stands', () => { const d = signed(false); const w = wired(d); w.prompt(); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'cheat'); assert.ok(blocked(w.stop())); w.prompt(); put(d, '.npmrc', 'x\n'); w.stop(); assert.equal(JSON.parse(readFileSync(join(d, '.sawbuck/results.json'), 'utf8')).latest.kind, 'gamed'); });
test('claim: the status line names the repo it detected, from any folder of it', () => { const d = signed(true); const w = wired(d); w.prompt(); w.stop(); const n = d.split('/').pop(); assert.match(sb(d, 'statusline').out, new RegExp(`sawbuck · ${n} · watching`)); assert.match(sb(join(d, 'src'), 'statusline').out, new RegExp(n)); });
test('claim: outside a repository the status line says so', () => { assert.match(sb(mkdtempSync(join(tmpdir(), 'claims-')), 'statusline').out, /no repo here/); });
test('claim: the list of attached repos drops a folder that is gone the next time it is written, and detach --all does not trip on it', () => {
  const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const env = { ...ENV, HOME: home };
  const run = (d, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: d, encoding: 'utf8', env });
  const a = repo(true), b = repo(true);
  assert.equal(run(a, 'attach', '--claude').status, 0); assert.equal(run(b, 'attach', '--claude').status, 0);
  const reg = () => JSON.parse(readFileSync(join(home, '.sawbuck', 'registry.json'), 'utf8')).repos.map((x) => x.repo);
  assert.deepEqual(reg().sort(), [a, b].sort());
  rmSync(b, { recursive: true, force: true });   // a test folder or a deleted clone
  assert.equal(run(a, 'attach', '--claude').status, 0);
  assert.deepEqual(reg(), [a], 'the gone folder is dropped when the list is next written');
  const d = run(a, 'detach', '--all'); assert.equal(d.status, 0, d.stderr); assert.match(d.stdout, /detached everywhere/);
});
test('claim: attaching a repo under user-level hooks does not wire a second set', () => { const home = mkdtempSync(join(tmpdir(), 'claims-home-')); put(home, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /x/sawbuck.mjs __hook' }] }] } })); const d = signed(true); const r = spawnSync(process.execPath, [CLI, 'attach', '--claude'], { cwd: d, encoding: 'utf8', env: { ...ENV, HOME: home } }); assert.match(r.stdout, /user-level/); assert.ok(!existsSync(join(d, '.claude/settings.local.json'))); });

test('claim: a repo watched by user-level hooks is not blocked by sawbuck\'s own record', () => { const home = mkdtempSync(join(tmpdir(), 'claims-home-')); const env = { ...ENV, HOME: home }; const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); const hook = (args, ev) => spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: 's', prompt: 'x' }) }).stdout || ''; hook(['turn', '--hook'], 'UserPromptSubmit'); assert.equal(git(d, 'status', '--porcelain'), '', 'nothing of ours shows up'); assert.ok(!blocked(hook(['__hook', '--by', 'claude', '--stop'], 'Stop'))); });

test('claim: clearing the npx cache does not turn the wall off', () => { if (process.env.CLAIMS_SAWBUCK) return; const root = mkdtempSync(join(tmpdir(), 'claims-npx-')); const pkg = join(root, '_npx', 'x', 'sawbuck'); mkdirSync(dirname(pkg), { recursive: true }); execFileSync('cp', ['-r', join(HERE, '..'), pkg]); const d = signed(true); const r = spawnSync(process.execPath, [join(pkg, 'sawbuck.mjs'), 'attach', '--claude'], { cwd: d, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, r.stderr); const cmd = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks.Stop[0].hooks[0].command; rmSync(pkg, { recursive: true }); const bin = join(root, 'bin'); put(bin, 'npx', '#!/bin/sh\necho "fallback: $*"\n'); execFileSync('chmod', ['+x', join(bin, 'npx')]); const o = spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', env: { ...ENV, PATH: `${bin}:${ENV.PATH}` } }); assert.match(o.stdout, /fallback: --prefer-offline --fetch-retries=0 --fetch-timeout=10000 -y sawbuck@.* __hook/, 'the fallback uses the cache first and fails fast offline'); });

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
test('claim: many amends of one attempt show as one line with a count, so the three lines left are distinct attempts', () => {
  const d = signed(true); const w = wired(d); const k = git(d, 'rev-parse', 'HEAD');
  put(d, 'src/cache.js', 'exports.c=0\n'); save(d, 'cache: try a cap, take 1');
  for (let i = 2; i <= 6; i++) { put(d, 'src/cache.js', `exports.c=${i}\n`); git(d, 'add', '-A'); git(d, 'commit', '-q', '--amend', '-m', `cache: try a cap, take ${i}`); }
  put(d, 'src/cache.js', 'exports.ttl=1\n'); save(d, 'cache: try a ttl instead');
  git(d, 'reset', '-q', '--hard', k);
  const o = w.prompt('Memory keeps growing in src/cache.js. Fix it.');
  const lines = o.split('\n').filter((l) => /erased by a rewrite/.test(l));
  assert.equal(lines.filter((l) => /try a cap/.test(l)).length, 1, o); assert.match(o, /try a cap, take 6[^\n]*6 versions/, 'the newest, with the count');
  assert.equal(lines.filter((l) => /try a ttl/.test(l)).length, 1, 'a different attempt keeps its own line');
});
test('claim: a prompt that names a file gets the history a rewrite erased there, with the prompt, before any edit', () => { const { d, w } = lessons(true); w.prompt(); w.stop(); squash(d); w.prompt(); git(d, 'reflog', 'expire', '--expire=now', '--all'); git(d, 'gc', '-q', '--prune=now'); const o = w.prompt('Memory keeps growing in src/cache.js. Add an LRU limit of 1000 entries and commit it.'); assert.match(o, /not in git history any more/); assert.match(o, /reverted: Revert "add a result cache"/); assert.equal(git(d, 'status', '--porcelain'), '', 'nothing was edited to get it'); });
test('claim: a bare file name in the prompt counts when one tracked file has it; a prompt naming no file, or another file, shows nothing', () => { const { d, w } = lessons(true); w.prompt(); w.stop(); squash(d); w.prompt(); assert.match(w.prompt('the cache.js file keeps growing, cap it'), /Revert "add a result cache"/); assert.doesNotMatch(w.prompt('Add a slugify helper in src/slugify.js.'), /not in git history/); assert.doesNotMatch(w.prompt('make the tests faster'), /not in git history/); });
test('claim: the history a prompt names comes once, not twice, when per-turn history is on too', () => { const { d, w } = lessons(true); w.prompt(); w.stop(); squash(d); w.prompt(); put(d, 'sawbuck.config.json', JSON.stringify({ turn: { context: true } })); const o = w.prompt('Memory keeps growing in src/cache.js. Add an LRU limit.'); assert.equal((o.match(/reverted: Revert "add a result cache"/g) || []).length, 1); });
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
test('claim: stopping the agent twice on a command the hold does not cover suggests the line that makes it ask first', () => {
  const at = '2026-11-10T00:00:00Z';
  const h = steerHome([{ at, repo: '/r', session: 'a', axis: 'stop', nudge: 'stopped: running git push origin main', pressure: 3 }, { at, repo: '/r', session: 'b', axis: 'stop', nudge: 'stopped: git push --tags', pressure: 3 }, { at, repo: '/r', session: 'c', axis: 'stop', nudge: 'stopped: editing the README', pressure: 3 }]);
  const o = steersOut(h); assert.match(o, /"holds":\{"outward":\["\\\\bgit\\\\s\+push\\\\b"\]\}/); assert.match(o, /git push 2x/);
});
test('claim: ripples show what happened after a steer: commits, an undo, a partial undo, and the same push said again later', () => {
  const d = signed(true); mkdirSync(join(d, '.sawbuck'), { recursive: true }); writeFileSync(join(d, '.sawbuck', 'state.json'), '{}');
  const t0 = Date.now() - 3 * 3600_000, iso = (m) => new Date(t0 + m * 60_000).toISOString();
  const env = { ...ENV, GIT_COMMITTER_DATE: iso(5), GIT_AUTHOR_DATE: iso(5) };
  put(d, 'src/cache.js', 'x\n'); execFileSync('git', ['add', '-A'], { cwd: d, env }); execFileSync('git', ['commit', '-qm', 'cache'], { cwd: d, env });
  writeFileSync(join(d, '.sawbuck', 'undone.jsonl'), JSON.stringify({ at: iso(10), file: 'src/cache.js', kind: 'part', added: 2, first: 'const cache', why: 'drop the cache' }) + '\n');
  const h = steerHome([{ at: iso(0), repo: d, session: 'a', axis: 'scope', nudge: 'Drop the cache, keep the log line', pressure: 2 }, { at: iso(130), repo: d, session: 'b', axis: 'scope', nudge: 'drop the cache; keep the log', pressure: 2 }]);
  const r = JSON.parse(spawnSync(process.execPath, [CLI, 'ripples', '--all', '--json'], { cwd: d, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout);
  assert.equal(r[0].commits, 1); assert.deepEqual(r[0].files, ['src/cache.js']); assert.equal(r[0].partly, 1); assert.equal(r[0].cameBack, iso(130));
  assert.match(spawnSync(process.execPath, [CLI, 'ripples', '--all'], { cwd: d, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout, /a time join, a lead not proof of cause/);
});
test('claim: sawbuck steering is one view of what you keep correcting and what happened after; steers and ripples still work alone', () => {
  const d = signed(true); const t0 = Date.now() - 3 * 3600_000, iso = (m) => new Date(t0 + m * 60_000).toISOString();
  const env = { ...ENV, GIT_COMMITTER_DATE: iso(5), GIT_AUTHOR_DATE: iso(5) };
  put(d, 'src/cache.js', 'x\n'); execFileSync('git', ['add', '-A'], { cwd: d, env }); execFileSync('git', ['commit', '-qm', 'cache'], { cwd: d, env });
  const e = (session, at) => ({ at, repo: d, session, axis: 'scope', nudge: 'keep the change small', pressure: 2 });
  const h = steerHome([e('1', iso(0)), e('2', iso(130)), e('3', iso(200))]);
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: d, encoding: 'utf8', env: { ...ENV, HOME: h } });
  const o = run('steering', '--all'); assert.equal(o.status, 0, o.stderr);
  assert.match(o.stdout, /keep the change small/); assert.match(o.stdout, /what happened after/);
  const j = JSON.parse(run('steering', '--all', '--json').stdout); assert.ok(j.steers && Array.isArray(j.ripples), 'both parts in --json');
  assert.equal(run('steers').status, 0); assert.equal(run('ripples', '--all').status, 0);
  assert.doesNotMatch(run('--help').stdout + run('--help').stderr, /sawbuck (steers|ripples)\b/, 'help lists the one view');
});
test('claim: a steer from a folder over several repos joins the commits in each, and old steers with no folder are counted, not dropped silently', () => {
  const top = mkdtempSync(join(tmpdir(), 'claims-projects-'));
  const t0 = Date.now() - 3 * 3600_000, iso = (m) => new Date(t0 + m * 60_000).toISOString();
  const commitAt = (d, f, m) => { const env = { ...ENV, GIT_COMMITTER_DATE: iso(m), GIT_AUTHOR_DATE: iso(m) }; put(d, f, `${m}\n`); execFileSync('git', ['add', '-A'], { cwd: d, env }); execFileSync('git', ['commit', '-qm', f], { cwd: d, env }); };
  for (const name of ['site', 'engine']) { const d = join(top, name); mkdirSync(d); git(d, 'init', '-q', '-b', 'main'); }
  mkdirSync(join(top, 'notes'));   // a plain folder beside them is not a repo and is skipped
  commitAt(join(top, 'site'), 'index.html', 5); commitAt(join(top, 'engine'), 'run.js', 20); commitAt(join(top, 'engine'), 'late.js', 90);   // the last is after the hour
  const h = steerHome([{ at: iso(0), repo: '', dir: top, session: 'a', axis: 'scope', nudge: 'Make the intro plain', pressure: 2 }, { at: iso(1), repo: '', session: 'old', axis: 'scope', nudge: 'from before folders were kept', pressure: 1 }]);
  const r = JSON.parse(spawnSync(process.execPath, [CLI, 'ripples', '--all', '--json'], { cwd: top, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout);
  assert.equal(r.length, 1); assert.equal(r[0].commits, 2, 'one commit in each repo inside the hour, none after it'); assert.equal(r[0].across, 2);
  assert.deepEqual(r[0].files.sort(), ['engine/run.js', 'site/index.html'], 'each file named with its repo');
  const o = spawnSync(process.execPath, [CLI, 'ripples', '--all'], { cwd: top, encoding: 'utf8', env: { ...ENV, HOME: h } }).stdout;
  assert.match(o, /across 2 repos/); assert.match(o, /1 older steer from outside any repo kept no folder/);
});
test('claim: a personal hold in ~/.sawbuck/config.json asks first everywhere on the machine, in a folder with no repo too', () => {
  const home = mkdtempSync(join(tmpdir(), 'claims-prof-')); put(home, '.sawbuck/config.json', JSON.stringify({ holds: { outward: ['\\bgit\\s+push\\b'] } }));
  const dir = mkdtempSync(join(tmpdir(), 'claims-norepo-'));
  const hold = (cmd) => spawnSync(process.execPath, [CLI, 'hold', '--hook'], { cwd: dir, encoding: 'utf8', env: { ...ENV, HOME: home }, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, cwd: dir }) }).stdout;
  const o = JSON.parse(hold('git push origin main')); assert.equal(o.hookSpecificOutput.permissionDecision, 'ask');
  assert.ok(!/outside this repo/.test(o.hookSpecificOutput.permissionDecisionReason), 'no repo here, so it does not say "this repo"');
  assert.equal(hold('ls'), '');
});
test('claim: a profile exported on one machine imports on another: personal rules and holds added, nothing already there lost', () => {
  const a = mkdtempSync(join(tmpdir(), 'claims-a-')); put(a, '.claude/CLAUDE.md', '# mine\n\n- Reply in at most 3 lines.\n- Never push without asking.\n'); put(a, '.sawbuck/config.json', JSON.stringify({ holds: { outward: ['\\bdeploy'] } }));
  const run = (h, ...args) => spawnSync(process.execPath, [CLI, 'profile', ...args], { cwd: a, encoding: 'utf8', env: { ...ENV, HOME: h } });
  const file = join(a, 'p.json'); writeFileSync(file, run(a, 'export').stdout);
  const b = mkdtempSync(join(tmpdir(), 'claims-b-')); put(b, '.claude/CLAUDE.md', '- Reply in at most 3 lines.\n- Use pnpm.\n');
  assert.match(run(b, 'import', file).stdout, /1 rule added .* 1 hold added/);
  const md = readFileSync(join(b, '.claude/CLAUDE.md'), 'utf8'); assert.match(md, /Use pnpm/); assert.match(md, /Never push without asking/); assert.equal((md.match(/at most 3 lines/g) || []).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(b, '.sawbuck/config.json'), 'utf8')).holds.outward, ['\\bdeploy']);
  assert.match(run(b).stdout, /2 lines in .*CLAUDE\.md|3 lines in .*CLAUDE\.md/); assert.match(run(b).stdout, /14 built in \+ 1 of yours/);
});
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
test('claim: attach --shared writes a team file with no path from this machine, and removing the hooks shows in git', () => { const d = repo(true); const r = sb(d, 'attach', '--shared'); assert.equal(r.code, 0); assert.match(r.out, /commit \.claude\/settings\.json/); const f = join(d, '.claude/settings.json'); const text = readFileSync(f, 'utf8'); const cmds = Object.values(JSON.parse(text).hooks).flat().flatMap((h) => h.hooks.map((x) => x.command)); assert.equal(cmds.length, 8); for (const c of cmds) assert.match(c, /^npx (--prefer-offline --fetch-retries=0 --fetch-timeout=10000 -y sawbuck@\d+\.\d+\.\d+ (turn --hook|__hook --by claude --stop|hold --hook|undo --hook)|--fetch-retries=0 --fetch-timeout=10000 -y sawbuck@\d+\.\d+\.\d+ __warm)$/); assert.ok(!text.includes(d) && !text.includes(HOME) && !text.includes('sawbuck.mjs'), 'nothing machine-specific'); assert.match(git(d, 'status', '--porcelain'), /\.claude\//, 'the file is visible to git'); save(d, 'share the hooks'); put(d, '.claude/settings.json', '{}\n'); assert.match(git(d, 'status', '--porcelain'), /M \.claude\/settings\.json/, 'a removal shows'); git(d, 'checkout', '.claude/settings.json'); assert.equal(sb(d, 'detach').code, 0); assert.ok(!/sawbuck/.test(existsSync(f) ? readFileSync(f, 'utf8') : '')); });
test('claim: a team file with the old plain npx form is upgraded in place by attach --shared, with no second copy of any hook', () => {
  const d = repo(true); assert.equal(sb(d, 'attach', '--shared').code, 0); const f = join(d, '.claude/settings.json');
  put(d, '.claude/settings.json', readFileSync(f, 'utf8').replace(/npx --prefer-offline --fetch-retries=0 --fetch-timeout=10000 -y /g, 'npx -y '));   // as an older version wrote it
  assert.match(readFileSync(f, 'utf8'), /"npx -y sawbuck@/);
  assert.equal(sb(d, 'attach', '--shared').code, 0);
  const cmds = Object.values(JSON.parse(readFileSync(f, 'utf8')).hooks).flat().flatMap((h) => h.hooks.map((x) => x.command));
  assert.equal(cmds.length, 8, 'one of each'); for (const c of cmds) assert.match(c, /^npx (--prefer-offline )?--fetch-retries=0 --fetch-timeout=10000 -y sawbuck@/);
  assert.equal(cmds.filter((c) => !c.includes('--prefer-offline')).length, 2, 'only the two session-start lines ask npm');
});
// A team file moves to a newer sawbuck by a commit. A teammate's npm has kept a list of versions that ends before it,
// and `--prefer-offline` tells npm to use that list without asking: every hook then fails with "No matching version"
// (measured 2026-11-13, npm 10.8, 10.9 and 11.x). So the file asks npm once, where a session starts, on a line with no
// such flag and a command that prints nothing; a real Claude Code finishes that line before the first prompt's hook
// (measured 2026-11-14, in a window and under `claude -p`). Every other line keeps the flag: they run on each prompt
// and tool call, and without it each would wait out the fetch timeout on a network that hangs.
test('claim: a team file asks npm for its pinned version once, where a session starts, and on no other line', () => {
  const d = repo(true); assert.equal(sb(d, 'attach', '--shared').code, 0);
  const h = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks;
  const of = (matcher) => (h.SessionStart || []).filter((e) => e.matcher === matcher).flatMap((e) => e.hooks.map((x) => x.command));
  for (const source of ['startup', 'resume']) { const c = of(source); assert.equal(c.length, 1, `one line for a session that begins by ${source}`); assert.match(c[0], /^npx --fetch-retries=0 --fetch-timeout=10000 -y sawbuck@\d+\.\d+\.\d+ __warm$/); }
  assert.match(of('compact')[0], /^npx --prefer-offline .* turn --hook$/, 'the line after a compaction is as it was');
  const rest = Object.entries(h).flatMap(([ev, list]) => list.filter((e) => !(ev === 'SessionStart' && ['startup', 'resume'].includes(e.matcher))).flatMap((e) => e.hooks.map((x) => x.command)));
  assert.equal(rest.length, 6); for (const c of rest) assert.ok(c.includes('--prefer-offline'), `a line that runs on every prompt or tool call must not wait on the network: ${c}`);
  // the same pinned version on every line
  assert.equal(new Set(Object.values(h).flat().flatMap((e) => e.hooks.map((x) => /sawbuck@([\d.]+)/.exec(x.command)[1]))).size, 1);
  // attached twice is attached once
  assert.match(sb(d, 'attach', '--shared').out, /already attached/);
  assert.equal(Object.values(JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks).flat().length, 8);
});
test('claim: the session-start line prints nothing, whatever it is fed, so nothing of it reaches the agent', () => {
  const d = repo(true);
  for (const input of ['', JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: d, session_id: 's' }), 'not json']) {
    const r = spawnSync(process.execPath, [CLI, '__warm'], { cwd: d, encoding: 'utf8', env: ENV, input });
    assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  }
  const out = spawnSync(process.execPath, [CLI, '__warm'], { cwd: tmpdir(), encoding: 'utf8', env: ENV, input: '' });   // and outside any repo
  assert.equal(out.status, 0); assert.equal(out.stdout + out.stderr, '');
});
test('claim: the hooks one person attaches hold no session-start line that asks npm (their version is the one already here)', () => {
  const d = repo(true); assert.equal(sb(d, 'attach').code, 0);
  const text = readFileSync(join(d, '.claude/settings.local.json'), 'utf8');
  assert.ok(!text.includes('__warm')); assert.deepEqual(JSON.parse(text).hooks.SessionStart.map((e) => e.matcher), ['compact']);
});
test('claim: doctor says a team file written before the session-start line is incomplete, and attach --shared completes it', () => {
  const d = repo(true); assert.equal(sb(d, 'attach', '--shared').code, 0); const f = join(d, '.claude/settings.json');
  const cfg = JSON.parse(readFileSync(f, 'utf8')); cfg.hooks.SessionStart = cfg.hooks.SessionStart.filter((e) => e.matcher === 'compact');   // as 0.1.68 wrote it
  writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  const r = sb(d, 'doctor'); assert.match(r.out, /PART\s+claude-shared/); assert.match(r.out, /missing: SessionStart\[startup\], SessionStart\[resume\]/); assert.match(r.out, lit(`${PIN} attach --shared again`));
  assert.match(sb(d, 'attach', '--shared').out, /updated the shared project Claude Code hooks/);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).hooks.SessionStart.length, 3);
});
test('claim: shared hooks find the repo from where they run, and block a protected path', () => { const d = repo(true); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); assert.equal(sb(d, 'attach', '--shared').code, 0); const h = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks; const run = (cmd, ev) => { const args = cmd.replace(/^npx (?:--\S+ )*-y sawbuck@[\d.]+ /, '').split(' '); return spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: 'shared', prompt: 'x' }) }).stdout || ''; }; run(h.UserPromptSubmit[0].hooks[0].command, 'UserPromptSubmit'); put(d, '.github/workflows/x.yml', 'on: push\n'); assert.ok(blocked(run(h.Stop[0].hooks[0].command, 'Stop'))); });
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
test('claim: a label that is no spoke is not counted in the shape, and is shown as not placed', () => { const h = historyHome(['x y z message']); const o = shapeRun(h, '--check', labelFile(h, { 1: 'approach', 2: 'proof', 3: 'approach' })); assert.match(o, /from 1 messages/); assert.match(o, /Not placed: approach 2/); });




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
test('claim: a green from fixing only a test-*.js file reads gamed, not a source win (node --test and ava run test-*.js; it read verified before engine 0.8.6)', () => {
  const d = repo(true); put(d, 'test-release.js', "const t=require('node:test'),a=require('node:assert');const {add}=require('./src/add.js');t.test('release',()=>a.equal(add(2,2),5))\n"); save(d, 'release test');
  put(d, 'test-release.js', "const t=require('node:test'),a=require('node:assert');const {add}=require('./src/add.js');t.test('release',()=>a.equal(add(2,2),4))\n"); save(d, 'fix the expected value');
  const r = sb(d, 'check'); assert.match(r.out, /gamed/, r.out); assert.doesNotMatch(r.out, /verified/);
});
test('claim: a gamed change let through with --allow says so, with the reason, and never says verified', () => { const d = gamedRepo(); const r = sb(d, 'check', '--allow', 'a person said so'); assert.equal(r.code, 0); assert.match(r.out, /allowed/); assert.match(r.out, /a person said so/); assert.doesNotMatch(r.out, /verified|carried the win/); });
// One reason, one thing. From an outside report: a reason written about a config change also waved through a gamed test
// in the same change. With more than one thing to let through, a reason lets through only what it names.
test('claim: a reason written about one change does not wave through another: with two things, --allow lets through only what it names', () => {
  const d = signed(false);   // add is broken, so the test is red
  edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); json(d, 'promptwheel.config.json', (o) => { o.repeat = 2; }); save(d, 'edit the test and the rules file');
  const need = check(d).allowable;
  assert.ok(need.includes('mandate:contract-frozen') && need.length > 1, JSON.stringify(need));
  const names = need.map((l) => l.replace(/^mandate:/, '')).join(', ');
  // a reason about the rules file, and the gamed test rides along: nothing is let through
  let r = sb(d, 'check', '--allow', 'more repeats');
  assert.notEqual(r.code, 0); assert.doesNotMatch(r.out, /allowed with --allow/);
  assert.match(r.out, /your reason did not let .* through/); assert.ok(r.out.includes(`${PIN} check --allow "${names}: <reason>"`), r.out);
  assert.deepEqual(check(d, '--allow', 'more repeats').allowed.cleared, []);
  // naming one lets that one through and says what is left
  r = sb(d, 'check', '--allow', 'contract-frozen: more repeats');
  assert.notEqual(r.code, 0); assert.match(r.out, /your reason let contract-frozen through, and did not let /);
  // naming each lets each through, and it reads allowed, never verified
  r = sb(d, 'check', '--allow', `${names}: the spec changed, and more repeats`);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /allowed with --allow/); assert.doesNotMatch(r.out, /verified|carried the win/);
  // the README's own line: the rules file and the hooks in one change
  const e = signed(true); json(e, 'promptwheel.config.json', (o) => { o.repeat = 2; }); put(e, '.claude/settings.json', '{"hooks":{}}\n'); save(e, 'more repeats, and team hooks');
  assert.deepEqual(check(e).allowable, ['mandate:contract-frozen', 'mandate:hooks-frozen']);
  assert.equal(sb(e, 'check', '--allow', 'team hooks').code, 1);
  assert.equal(sb(e, 'check', '--allow', 'contract-frozen, hooks-frozen: more repeats, and the team shares the hooks').code, 0);
  assert.ok(readFileSync(join(HERE, '..', 'README.md'), 'utf8').includes('sawbuck check --allow "contract-frozen, hooks-frozen: <reason>"'));
});
// ------------------------------------------------------------ "what a person let through, and why, is kept and comes back"
// Until 0.1.68 a reason given with --allow was printed once and kept nowhere. It joins the record now: kept in
// .sawbuck/allowed.jsonl where sawbuck is attached, and shown with the prompt that names the test or path it concerns.
const allowedLog = (d) => { try { return readFileSync(join(d, '.sawbuck', 'allowed.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
test('claim: a reason given with --allow is kept, and comes back with the prompt that names the test it let through', () => {
  const d = repo(); const w = wired(d);   // add is broken and the test is red
  edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green');
  assert.equal(sb(d, 'check').code, 2, 'gamed, with no reason');
  assert.deepEqual(allowedLog(d), [], 'nothing is kept until a person lets something through');
  assert.doesNotMatch(w.prompt('tighten test/add.test.js'), /let through/, 'and nothing is shown');
  const r = sb(d, 'check', '--allow', 'the spec changed: add subtracts now');
  assert.equal(r.code, 0, r.out); assert.match(r.out, /The reason is kept here/, 'the check says the reason is kept');
  const a = allowedLog(d);
  assert.equal(a.length, 1); assert.equal(a[0].reason, 'the spec changed: add subtracts now'); assert.deepEqual(a[0].files, ['test/add.test.js']);
  assert.deepEqual(a[0].cleared, ['tests_pass']); assert.match(a[0].sha, /^[0-9a-f]{8,}$/);
  assert.equal(git(d, 'status', '--porcelain'), '', 'the record stays out of git status');
  const out = w.prompt('tighten the assertions in test/add.test.js');
  assert.match(out, /let through here by a person, with a reason \(a past decision, not a standing permission\)/);
  assert.match(out, /test\/add\.test\.js: a win that came from editing the test.*The reason given: "the spec changed: add subtracts now"/);
  assert.doesNotMatch(w.prompt('speed up src/add.js'), /let through/, 'a prompt about another file does not get it');
  assert.match(sb(d, 'context').out, /let through here by a person/, 'context shows it for the files in hand');
  assert.match(sb(d, 'status').out, /Let through with a reason\s+·\s+1 change a person accepted with --allow/);
  // the same reason on the same commit again is one entry; another reason is another entry, under --json too
  sb(d, 'check', '--allow', 'the spec changed: add subtracts now'); assert.equal(allowedLog(d).length, 1);
  const j = sb(d, 'check', '--json', '--allow', 'and the ticket is ABC-1'); assert.equal(j.code, 0); JSON.parse(j.out);
  assert.equal(allowedLog(d).length, 2, 'kept under --json, and the output is still only the report');
  assert.match(readFileSync(join(HERE, '..', 'README.md'), 'utf8'), /kept in `\.sawbuck\/allowed\.jsonl`/, 'the README says where it is kept');
});
// A record keeps the instant in UTC. Shown as its first ten characters it read a day ahead for anyone west of Greenwich
// in the evening: at 20:29 on the 13th in Los Angeles an agent was told a decision was made on the 14th, and remarked on
// it (2026-11-13, a real session). The day shown is the day on the clock of the machine the hook runs on.
test('claim: the day shown with a past decision is the day on this machine, not the day in UTC', () => {
  const d = repo(); const w = wired(d);
  edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green');
  w.prompt('look at the tests');   // a turn has begun here, so the record is being kept
  assert.equal(sb(d, 'check', '--allow', 'the spec changed: add subtracts now').code, 0);
  const f = join(d, '.sawbuck', 'allowed.jsonl'); const was = readFileSync(f, 'utf8'); assert.match(was, /"at":"[^"]+"/);
  writeFileSync(f, was.replace(/"at":"[^"]+"/, '"at":"2026-11-14T04:29:00.000Z"'));   // 20:29 on the 13th in Los Angeles
  const cmd = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
  const prompt = (TZ) => spawnSync('sh', ['-c', cmd], { cwd: d, encoding: 'utf8', env: { ...ENV, TZ }, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: d, session_id: 'tz-' + TZ, prompt: 'tighten test/add.test.js' }) }).stdout || '';
  assert.match(prompt('America/Los_Angeles'), /let through here by a person[\s\S]*\(2026-11-13, /, 'the day on the clock in Los Angeles');
  assert.match(prompt('UTC'), /let through here by a person[\s\S]*\(2026-11-14, /);
  assert.match(prompt('Asia/Tokyo'), /let through here by a person[\s\S]*\(2026-11-14, /);
});
test('claim: a protected path let through with --allow is kept under the rule\'s name, and comes back with the prompt that names the path', () => {
  const d = signed(true); const w = wired(d);
  json(d, 'promptwheel.config.json', (o) => { o.repeat = 2; }); save(d, 'more repeats');
  assert.equal(sb(d, 'check', '--allow', 'the suite is flaky on CI, two runs').code, 0);
  const a = allowedLog(d); assert.equal(a.length, 1); assert.deepEqual(a[0].cleared, ['mandate:contract-frozen']); assert.deepEqual(a[0].files, ['promptwheel.config.json']);
  assert.match(w.prompt('set repeat back to 1 in promptwheel.config.json'), /promptwheel\.config\.json: the protected path "contract-frozen".*The reason given: "the suite is flaky on CI, two runs"/);
});
test('claim: a new install script let through with --allow is kept in plain words, under the file that holds it', () => {
  const d = signed(true); const w = wired(d);
  json(d, 'package.json', (o) => { o.scripts.postinstall = 'node build.js'; }); put(d, 'build.js', '// build\n'); save(d, 'a build step');
  const need = check(d).allowable; assert.ok(need.includes('lifecycle_scripts'), JSON.stringify(need));
  assert.equal(sb(d, 'check', '--allow', `${need.join(', ')}: the package needs its build step`).code, 0);
  const a = allowedLog(d); assert.equal(a.length, 1); assert.ok(a[0].files.includes('package.json') && !a[0].files.includes('build.js'), JSON.stringify(a[0].files));
  assert.match(w.prompt('clean up the scripts in package.json'), /package\.json: a new install script.*the package needs its build step/);
});
test('claim: a reason that lets nothing through is not kept, and one that names two things is kept once, with both', () => {
  const d = signed(false); wired(d);
  edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); json(d, 'promptwheel.config.json', (o) => { o.repeat = 2; }); save(d, 'edit the test and the rules file');
  assert.notEqual(sb(d, 'check', '--allow', 'more repeats').code, 0); assert.deepEqual(allowedLog(d), [], 'the reason named neither: nothing let through, nothing kept');
  assert.notEqual(sb(d, 'check', '--allow', 'contract-frozen: more repeats').code, 0); assert.deepEqual(allowedLog(d), [], 'one of two is not a change let through');
  const names = check(d).allowable.map((l) => l.replace(/^mandate:/, '')).join(', ');
  assert.equal(sb(d, 'check', '--allow', `${names}: the spec changed, and more repeats`).code, 0);
  const a = allowedLog(d); assert.equal(a.length, 1); assert.ok(a[0].cleared.includes('mandate:contract-frozen') && a[0].cleared.length > 1, JSON.stringify(a[0].cleared));
  assert.ok(a[0].files.includes('test/add.test.js') && a[0].files.includes('promptwheel.config.json'), JSON.stringify(a[0].files));
});
test('claim: a reason given where sawbuck is not attached is printed and not kept: nothing is written in a repo it does not watch', () => {
  const d = gamedRepo(); const r = sb(d, 'check', '--allow', 'a person said so');
  assert.equal(r.code, 0); assert.match(r.out, /a person said so/); assert.doesNotMatch(r.out, /The reason is kept here/);
  assert.ok(!existsSync(join(d, '.sawbuck')), 'no record folder appears');
});
test('claim: a reason given for an uncommitted change is kept too, and still comes back after the commit', () => {
  const d = repo(); const w = wired(d); w.prompt('make the tests pass');   // a session has started here: the record exists
  edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0'));
  assert.equal(sb(d, 'check', '--allow', 'the spec changed').code, 0);
  const a = allowedLog(d); assert.equal(a.length, 1); assert.equal(a[0].sha, ''); assert.deepEqual(a[0].files, ['test/add.test.js']);
  save(d, 'the new spec');
  const out = w.prompt('look at test/add.test.js');
  assert.match(out, /let through here by a person/); assert.match(out, /before it was committed.*The reason given: "the spec changed"/);
});
// ------------------------------------------------------------ "the record is not the only witness"
// Found 2026-11-12 (proof-bench/record-tamper): on 0.1.67, after a gamed commit was sent back, rewriting or deleting the
// record under .sawbuck/ ended the turn with no send-back. The folder is kept out of git status, so the rule that names
// it cannot see a write there. The hooks now keep what they concluded a second time, in the git folder, and prove the
// commit again from the source when the record no longer accounts for it.
const sentBackTurn = () => { const d = repo(); const w = wired(d); w.prompt('make the add test pass'); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green'); assert.ok(blocked(w.stop()), 'the gamed commit is sent back'); return { d, w }; };
const markVerified = (d) => json(d, '.sawbuck/results.json', (o) => { o.latest.kind = 'verified'; o.gamed = 0; });
const guardFile = (d) => join(d, '.git', 'sawbuck', 'guard.json');
test('claim: rewriting or deleting the record after a gamed commit does not take the send-back away', () => {
  let { d, w } = sentBackTurn(); markVerified(d); assert.ok(blocked(w.stop()), 'the verdict rewritten to verified'); assert.ok(blocked(w.stop()), 'and it holds at the next end of turn');
  assert.equal(git(d, 'status', '--porcelain'), '', 'nothing of this shows in git status');
  ({ d, w } = sentBackTurn()); rmSync(join(d, '.sawbuck', 'results.json')); assert.ok(blocked(w.stop()), 'the results file deleted');
  ({ d, w } = sentBackTurn()); rmSync(join(d, '.sawbuck', 'results.json')); rmSync(join(d, '.sawbuck', 'state.json')); assert.ok(blocked(w.stop()), 'the results file and the state file deleted');
  ({ d, w } = sentBackTurn()); markVerified(d); git(d, 'commit', '-q', '--allow-empty', '-m', 'wip'); assert.ok(blocked(w.stop()), 'rewritten, then an empty commit on top');
  // before the first end of turn: a state file blanked or garbled, so that no commit of the turn would be looked at
  for (const [what, text] of [['blanked', '{}\n'], ['garbled', 'x\n'], ['set to null', 'null\n']]) {
    const e = repo(); const x = wired(e); x.prompt('make the add test pass'); put(e, '.sawbuck/state.json', text);
    edit(e, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(e, 'make it green');
    assert.ok(blocked(x.stop()), `the state file ${what} before the turn ended`);
  }
  assert.match(readFileSync(join(HERE, '..', 'README.md'), 'utf8'), /\.git\/sawbuck\/guard\.json/, 'the README says where the second copy is');
});
test('claim: deleting the whole record folder during a turn does not take the send-back away, for a gamed commit or a protected path', () => {
  const { d, w } = sentBackTurn(); rmSync(join(d, '.sawbuck'), { recursive: true });
  assert.ok(blocked(w.stop()), 'the turn is checked again from the commit it began at');
  assert.ok(existsSync(guardFile(d)), 'the second copy is in the git folder'); assert.equal(git(d, 'status', '--porcelain'), '', 'and not in the work tree');
  // a protected path changed and committed in the turn: with the record gone the old check had no commit to compare with
  const e = signed(true); const x = wired(e); x.prompt('speed up CI'); put(e, '.github/workflows/ci.yml', 'on: push\n'); save(e, 'ci');
  rmSync(join(e, '.sawbuck'), { recursive: true });
  assert.ok(blocked(x.stop()), 'the committed workflow change is still sent back');
});
test('claim: the honest ways out still clear it after the record was rewritten: the source fix, and a person\'s --allow', () => {
  let { d, w } = sentBackTurn(); markVerified(d);
  edit(d, 'src/add.js', fixAdd); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),0', 'add(2,2),4')); save(d, 'fix add, put the test back');
  assert.ok(!blocked(w.stop()), 'the real fix clears it'); assert.ok(!blocked(w.stop()), 'and it stays cleared');
  ({ d, w } = sentBackTurn()); rmSync(join(d, '.sawbuck', 'results.json'));
  assert.equal(sb(d, 'check', '--allow', 'the spec changed: add subtracts now').code, 0);
  assert.ok(!blocked(w.stop()), 'a person\'s reason clears it, with the results file gone');
});
test('claim: a turn that removed the record and did nothing wrong still ends, and the person is told once that it was removed', () => {
  const d = repo(true); const w = wired(d); w.prompt('add a sub function'); edit(d, 'src/add.js', (s) => s + 'exports.sub=(a,b)=>a-b\n'); save(d, 'sub');
  rmSync(join(d, '.sawbuck'), { recursive: true });
  const out = w.stop(); assert.ok(!blocked(out), out); assert.match(out, /record for this repo \(\.sawbuck\/\) was removed or made unreadable during this turn/);
  assert.doesNotMatch(w.stop(), /was removed or made unreadable/, 'said once');
});
test('claim: detach takes the second copy with it: at once when no turn is open, and when the turn ends if one is', () => {
  // no turn open (the last end of turn let it end): gone with the hooks, record kept or not
  const ended = () => { const d = repo(true); const w = wired(d); w.prompt('add a sub function'); edit(d, 'src/add.js', (s) => s + 'exports.sub=(a,b)=>a-b\n'); save(d, 'sub'); assert.ok(!blocked(w.stop())); assert.ok(existsSync(guardFile(d))); return d; };
  let d = ended(); assert.equal(sb(d, 'detach').code, 0); assert.ok(!existsSync(guardFile(d)), 'gone when the hooks go');
  d = ended(); assert.equal(sb(d, 'detach', '--purge').code, 0); assert.ok(!existsSync(guardFile(d)), 'gone with the record');
  // a turn open (it was just sent back): the session read its hooks when it began and still runs them, so the copy
  // stays for that turn, the turn is still checked, and the copy goes when the turn ends
  const t = sentBackTurn(); const r = sb(t.d, 'detach'); assert.equal(r.code, 0); assert.match(r.out, /a turn is open in this repo/);
  assert.ok(existsSync(guardFile(t.d)), 'kept while the turn is open'); assert.ok(blocked(t.w.stop()), 'and the turn is still sent back');
  edit(t.d, 'src/add.js', fixAdd); edit(t.d, 'test/add.test.js', (s) => s.replace('add(2,2),0', 'add(2,2),4')); save(t.d, 'fix add, put the test back');
  assert.ok(!blocked(t.w.stop()), 'the real fix ends the turn'); assert.ok(!existsSync(guardFile(t.d)), 'and the copy goes with it');
  // attached again while it waited: the wait is off, and the copy stays
  const u = sentBackTurn(); assert.equal(sb(u.d, 'detach').code, 0); assert.equal(sb(u.d, 'attach').code, 0);
  assert.ok(blocked(u.w.stop())); assert.ok(existsSync(guardFile(u.d)));
});
// ------------------------------------------------------------ "what a turn is checked from is the hooks' own"
// Measured on 0.1.68 (proof-bench/record-tamper, amendments 2 and 3, 2026-11-13 and 14). The second copy held where a
// turn began and a verdict that was sent back. Everything else the end of a turn decides by was still read from the
// state file, which an agent can rewrite with nothing showing in git: the last commit looked at, the commit and the
// tips the turn began with, how many times this prompt was already sent back, and how many times it may be. One field
// edited, and the turn ended on a gamed commit with nothing said, or with a note to the person in place of a send-back.
// All of it is now read from the second copy, and the setting is the one that stood when the prompt began.
const openTurn = (make = repo) => { const d = make(); const w = wired(d); w.prompt('make the add test pass'); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green'); return { d, w, head: git(d, 'rev-parse', 'HEAD') }; };
const stateFile = (d, fn) => json(d, '.sawbuck/state.json', fn);
test('claim: a state file rewritten during a turn to say the commit was already looked at does not skip the check', () => {
  let t = openTurn(); stateFile(t.d, (o) => { o.lastSha = t.head; }); assert.ok(blocked(t.w.stop()), '"last commit looked at" set to the gamed commit');
  t = openTurn(); stateFile(t.d, (o) => { o.turnBaseline.sha = t.head; }); assert.ok(blocked(t.w.stop()), 'the commit the turn began at set to the gamed commit');
  t = openTurn(); stateFile(t.d, (o) => { o.turnBaseline.refs = [...(o.turnBaseline.refs || []), t.head]; }); assert.ok(blocked(t.w.stop()), 'the gamed commit added to the tips the turn began with');
  t = openTurn(); stateFile(t.d, (o) => { o.lastSha = t.head; o.lastPromptAt = new Date(Date.now() + 60000).toISOString(); }); assert.ok(blocked(t.w.stop()), 'the same with the prompt time moved a minute ahead');
  assert.equal(git(t.d, 'status', '--porcelain'), '', 'none of it shows in git status');
  // in a later turn, when "last commit looked at" in the second copy is one an end of turn wrote
  const d = repo(); const w = wired(d); w.prompt('add a sub function'); edit(d, 'src/add.js', (s) => s + 'exports.sub=(a,b)=>a-b\n'); save(d, 'sub'); assert.ok(!blocked(w.stop()), 'a turn that touched no test ends');
  w.prompt('make the add test pass'); edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green');
  stateFile(d, (o) => { o.lastSha = git(d, 'rev-parse', 'HEAD'); }); assert.ok(blocked(w.stop()), 'in a later turn too');
});
test('claim: an honest turn after a state file was rewritten is not sent back, and a commit is still looked at once', () => {
  const d = repo(true); const w = wired(d); w.prompt('add a sub function'); edit(d, 'src/add.js', (s) => s + 'exports.sub=(a,b)=>a-b\n'); save(d, 'sub');
  stateFile(d, (o) => { o.lastSha = ''; delete o.turnBaseline.refs; });   // edits that would only widen what is looked at
  assert.ok(!blocked(w.stop()), 'the honest commit passes');
  const runs = () => readFileSync(join(d, '.sawbuck', 'activity.jsonl'), 'utf8').trim().split('\n').length;
  const n = runs(); assert.ok(!blocked(w.stop())); assert.ok(!blocked(w.stop())); assert.equal(runs(), n, 'a second and third end of turn with no new commit look at nothing');
  // the next turn starts where this one ended
  w.prompt('rename sub'); edit(d, 'src/add.js', (s) => s.replace('exports.sub', 'exports.minus')); save(d, 'minus'); assert.ok(!blocked(w.stop()));
});
test('claim: how many times a turn is sent back cannot be spent or set to zero from inside the turn', () => {
  let t = openTurn(); stateFile(t.d, (o) => { o.blockPromptId = o.lastPromptAt; o.blockCount = 3; }); assert.ok(blocked(t.w.stop()), 'the count set to its limit in the state file');
  assert.ok(blocked(t.w.stop())); assert.ok(blocked(t.w.stop())); assert.ok(!blocked(t.w.stop()), 'three times, as before, and then the person is told');
  // the setting written during the turn: with no contract, where that file is no protected path, and with one
  const zero = JSON.stringify({ enforce: { maxBlocks: 0 } }) + '\n';
  t = openTurn(); put(t.d, 'sawbuck.config.json', zero); assert.ok(blocked(t.w.stop()), 'enforce.maxBlocks 0 written during the turn, in a repo with no rules');
  t = openTurn(() => signed(false)); put(t.d, 'sawbuck.config.json', zero); const out = t.w.stop(); assert.ok(blocked(out), 'and in a signed repo'); assert.match(out, /sawbuck\.config\.json/, 'where writing that file is itself what is sent back');
  // a person's own setting counts from their next prompt
  const d = repo(); put(d, 'sawbuck.config.json', zero); save(d, 'ask me first'); const w = wired(d); w.prompt('make the add test pass');
  edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green'); assert.ok(!blocked(w.stop()), 'set before the prompt, it holds');
});
test('claim: the hold asks a person before sawbuck is detached, and before a command or an edit that names its own record', () => {
  const d = signed(true); const w = wired(d); const ask = /"permissionDecision":"ask"/;
  for (const c of ['sawbuck detach', 'npx -y sawbuck@0.1.69 detach --purge', 'node "/x/y/sawbuck.mjs" detach', 'cd sub && sawbuck detach --all',
    'rm -rf .sawbuck', 'rm .git/sawbuck/guard.json', `python3 -c "import shutil; shutil.rmtree('.sawbuck')"`, 'echo {} > .sawbuck/state.json', `sed -i s/gamed/verified/ ${d}/.sawbuck/results.json`]) assert.match(w.pre(c), ask, c);
  for (const c of ['npm test', 'git status', 'sawbuck status', 'sawbuck check', 'sawbuck attach', 'ls -la', 'cat .sawbuck/results.json', 'ls .sawbuck', 'git add -A && git commit -m "the sawbuck rules"', 'cat docs/sawbuck.md',
    // the folder of the same name in a person's home is not a repo's record: the plugin's own commands name it
    'npx --fetch-retries=0 --fetch-timeout=10000 -y sawbuck@0.1.69 shape --check ~/.sawbuck/shape-labels.json --png', `node x.mjs rules --check ${HOME}/.sawbuck/rule-labels.json`, 'mkdir -p $HOME/.sawbuck && echo {} > "${HOME}/.sawbuck/shape-labels.json"']) assert.equal(w.pre(c), '', c);
  // an edit tool pointed into either folder
  const h = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks;
  const preEdit = (file) => spawnSync('sh', ['-c', h.PreToolUse.find((x) => String(x.matcher || '').includes('Edit')).hooks[0].command], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file.startsWith('/') ? file : join(d, file), content: '{}' }, cwd: d, session_id: 's' }) }).stdout || '';
  assert.match(preEdit('.sawbuck/state.json'), ask); assert.match(preEdit('.git/sawbuck/guard.json'), ask); assert.equal(preEdit('src/add.js'), '');
  assert.equal(preEdit(join(HOME, '.sawbuck', 'shape-labels.json')), '', 'a file in the home folder of the same name is the person\'s own');
  assert.equal(preEdit('docs/.sawbuck-notes.md'), '', 'and a file that only looks alike is not the record');
  // turning the outward holds off does not turn this off: it is how the check itself is taken away
  put(d, 'sawbuck.config.json', JSON.stringify({ holds: { off: true } }) + '\n');
  assert.equal(w.pre('npm publish'), '', 'the outward hold is off'); assert.match(w.pre('sawbuck detach'), ask); assert.match(w.pre('rm -rf .sawbuck'), ask);
});
// Found in a real session before the 0.1.69 release (2026-11-14, Claude Code 2.1.318). An agent told to wait had its
// `sleep` moved to a background task and ended its turn. When the task finished, Claude Code gave the hooks a prompt
// whose text begins <task-notification>. The prompt hook took that for a person and started the turn's baseline again
// at the commit a job had made meanwhile, so that commit was read as the person's own and never checked. A notice
// from the harness is not a person: the turn that started the task is still the turn.
const NOTICE = '<task-notification>\n<task-id>b78a1k37k</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<status>completed</status>\n<summary>Background command "wait" completed (exit code 0)</summary>\n</task-notification>';
test('claim: a commit made while a background task of the agent ran is still the agent\'s when the task reports back', () => {
  const d = repo(); const w = wired(d); w.prompt('wait for the build, then make the add test pass');
  assert.ok(!blocked(w.stop()), 'the turn ends with the task still running');
  edit(d, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(d, 'make it green');   // the job's commit, after that end of turn
  w.prompt(NOTICE); assert.ok(blocked(w.stop()), 'checked when the task reports back, and sent back');
  // a protected path committed the same way
  const e = signed(true); const x = wired(e); x.prompt('speed up CI in the background'); assert.ok(!blocked(x.stop()));
  put(e, '.github/workflows/ci.yml', 'on: push\n'); save(e, 'ci'); x.prompt(NOTICE); assert.ok(blocked(x.stop()), 'a workflow change a job committed is sent back too');
  // and what has not changed: a commit made between a person's own prompts is the person's
  const f = repo(); const y = wired(f); y.prompt('look at the add test'); assert.ok(!blocked(y.stop()));
  edit(f, 'test/add.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(f, 'the spec changed: add subtracts');
  y.prompt('thanks. now add a sub function'); assert.ok(!blocked(y.stop()), 'the person\'s own commit is not laid on the agent');
});
test('claim: the hold asks a person before a background command that commits', () => {
  const d = signed(true); wired(d); const ask = /"permissionDecision":"ask"/;
  const h = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks;
  const pre = (command, bg) => spawnSync('sh', ['-c', h.PreToolUse.find((x) => x.matcher === 'Bash').hooks[0].command], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...(bg ? { run_in_background: true } : {}) }, cwd: d, session_id: 's' }) }).stdout || '';
  for (const c of ['sleep 60 && git commit -am wip', 'sh -c "sleep 5; git add -A; git commit -m later"', 'npm test && git -C . commit -qam green']) assert.match(pre(c, true), ask, c);
  for (const c of ['git commit -am wip', 'git add -A && git commit -m "the rules"']) assert.equal(pre(c, false), '', `in the turn, where the end of it checks the commit: ${c}`);
  for (const c of ['npm run dev', 'sleep 60', 'npm test', 'git status', 'git log --oneline']) assert.equal(pre(c, true), '', `a background command that commits nothing: ${c}`);
});
test('claim: detach run inside a turn, then the state file rewritten, is still sent back in that turn', () => {
  const t = openTurn(); assert.equal(sb(t.d, 'detach').code, 0);   // the session read its hooks when it began, so they still run
  stateFile(t.d, (o) => { o.lastSha = t.head; });
  assert.ok(blocked(t.w.stop()), 'the turn that detached is checked from where it began');
});
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
test('claim: the README shows the verified line and the agent rule as sawbuck prints them', () => { const d = repo(); edit(d, 'src/add.js', fixAdd); const v = sb(d, 'check').out.split('\n')[0].replace(/ \(it survives.*$/, ''); assert.ok(flat(README).includes(flat(v.replace(/^sawbuck: /, ''))), v); const e = repo(true); sb(e, 'contract'); const block = readFileSync(join(e, 'AGENTS.md'), 'utf8').match(/## Sawbuck rules\n\n([^\n]+)/)[1]; assert.ok(flat(README).includes(flat(block)), 'the AGENTS block'); });
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
// found by replaying real commits (proof-bench/replay): on vuejs/pinia two checks ran past the two minutes the check
// command allowed (the hooks allowed ten), and the only words were "the check timed out"
test('claim: a check that runs out of time says how long it waited and how to give it longer, and attach says the same', () => {
  const d = repo(true); json(d, 'package.json', (o) => { o.scripts.test = 'sleep 20'; }); save(d, 'a slow suite'); edit(d, 'src/add.js', (s) => s + '// x\n'); save(d, 'a change');
  const slow = (...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: d, encoding: 'utf8', env: { ...ENV, SAWBUCK_CHECK_TIMEOUT_MS: '1500' } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  const r = slow('check');
  assert.equal(r.code, 64, r.out); assert.match(r.out, /took longer than 1\.5 seconds and was stopped/); assert.match(r.out, /SAWBUCK_CHECK_TIMEOUT_MS/);
  const a = slow('attach');
  assert.match(a.out, /could not measure anything here yet: the check took longer than 1\.5 seconds/); assert.doesNotMatch(a.out, /the check did not run/);
  // ten minutes in all three places that run the check: the command, the turn hook and the git hook
  for (const f of ['sawbuck.mjs', 'sawbuck-hook.mjs', 'reflect.mjs']) assert.match(readFileSync(join(dirname(CLI), f), 'utf8'), /SAWBUCK_CHECK_TIMEOUT_MS\) \|\| 600000/, f);
});
test('claim: an inconclusive check names the cause: a failed setup, a missing dependency, or tests that fail', () => {
  const red = repo(false); edit(red, 'src/add.js', (s) => s + '// x\n');
  assert.match(sb(red, 'check').out, /inconclusive: your tests fail before and after this change/);
  const dep = repo(true); put(dep, 'test/add.test.js', "require('a-package-nobody-installed');\n" + TEST); save(dep, 'needs a package'); edit(dep, 'src/add.js', (s) => s + '// x\n');
  const o = sb(dep, 'check').out; assert.match(o, /inconclusive: the clean copy the check runs in is missing something your tests need/); assert.match(o, /a-package-nobody-installed/);
  assert.match(o, /Run `sawbuck init`, then set linkDirs or setup in promptwheel\.config\.json/); assert.doesNotMatch(o, /\.\. |setup, with/, 'one period, and a sentence that parses');
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
  assert.doesNotMatch(r.out, /\.\. |setup, with|linkDirs/, 'with a build script and no config, the one thing to do is sawbuck init');
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
// 0.1.70: the check says what it borrowed. It runs the test command in the environment it is run in, and no diff shows
// that. A `PYTEST_ADDOPTS` that deselects the red test, or a preload in `NODE_OPTIONS`, read pass while a fresh install
// was red (proof-bench/outside-git, 2026-11-11); the README said so and the check said nothing. Now it says it: a note.
test('claim: the check says so when the environment it runs in can change which tests run, as a note beside the verdict', () => {
  const d = repo(true); edit(d, 'src/add.js', (s) => s + 'exports.sub=(a,b)=>a-b\n'); save(d, 'sub');
  const clean = { ...ENV }; for (const k of ['PYTEST_ADDOPTS', 'PYTEST_PLUGINS', 'NODE_OPTIONS']) delete clean[k];
  const run = (env) => { const r = spawnSync(process.execPath, [CLI, 'check'], { cwd: d, encoding: 'utf8', env: { ...clean, ...env } }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  const plain = run({}); assert.equal(plain.code, 0, plain.out); assert.doesNotMatch(plain.out, /the environment this ran in/);
  const set = run({ PYTEST_ADDOPTS: '--deselect tests/test_a.py::test_red' });
  assert.equal(set.code, 0, 'a note, never a verdict'); assert.match(set.out, /sawbuck: note: the environment this ran in can change which tests run, or load code into them: PYTEST_ADDOPTS/);
  assert.doesNotMatch(run({ NODE_OPTIONS: '--max-old-space-size=4096' }).out, /the environment this ran in/, 'a NODE_OPTIONS that loads no file is not one');
  assert.match(readFileSync(join(HERE, '..', 'README.md'), 'utf8'), /the check says so when one of them is set/);
});
// 0.1.70: who may let a pull request through. The CI check took a person's yes from a `sawbuck-allow:` comment by any
// account of type User with write access, the account that opened the pull request included. A coding agent run from
// a service account opens its pull requests from that account and can post the comment (measured with the Action's
// own steps on the engine 0.1.69 pinned: proof-bench/pr-shapes, 2026-11-14). The engine this release pins leaves the
// opener out, unless the contract on the base branch says a repo with one person in it wants that.
// the engine the sawbuck under test runs, found the way bins.mjs finds it: PW_BIN, then the installed package as Node
// resolves it from that sawbuck (its own node_modules, or the folder it sits in), then the sibling checkout. The first
// cut looked beside it and in the sibling only. On GitHub's runner the engine is in the checkout's own node_modules,
// so this claim ran a file that was not there and failed on the published 0.1.70 commit, where every run of mine
// had passed (2026-11-15). It also passed two of its three checks with no engine at all: empty output read as "no".
const ENGINE_HERE = (() => {
  if (process.env.PW_BIN) return process.env.PW_BIN;
  try { return createRequire(CLI).resolve('promptwheel/bin/promptwheel.mjs'); } catch { /* not installed beside this sawbuck */ }
  return join(dirname(CLI), '..', 'promptwheel', 'bin', 'promptwheel.mjs');
})();
test('claim: on a pull request the account that opened it cannot let a change through; another person can; a repo with one person in it says so in its contract', () => {
  const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); assert.equal(sb(d, 'contract', '--full').code, 0); save(d, 'sign');
  const base = git(d, 'rev-parse', 'HEAD').trim();
  const comment = (login, assoc = 'COLLABORATOR') => JSON.stringify({ body: 'sawbuck-allow: the old assertion was wrong', author_association: assoc, user: { type: 'User', login } });
  const prAllow = (input, ...a) => { const r = spawnSync(process.execPath, [ENGINE_HERE, 'pr-allow', ...a], { cwd: d, encoding: 'utf8', env: ENV, input }); assert.equal(r.status, 0, `the engine ran (${ENGINE_HERE}): ${r.stderr}`); return r.stdout; };
  assert.equal(prAllow(comment('acme-agent-svc') + '\n', '--author', 'acme-agent-svc', '--base', base), '', 'the opener');
  assert.equal(prAllow(comment('ACME-agent-svc') + '\n', '--author', 'acme-agent-svc', '--base', base), '', 'in another letter case');
  assert.match(prAllow(comment('pat', 'MEMBER') + '\n' + comment('acme-agent-svc') + '\n', '--author', 'acme-agent-svc', '--base', base), /approved by pat/, 'another person, with a newer comment from the opener after theirs');
  // the pull request adds the setting: the contract on the base still decides
  json(d, 'promptwheel.config.json', (c) => { c.allowFromAuthor = true; }); save(d, 'the opener may approve');
  assert.equal(prAllow(comment('acme-agent-svc') + '\n', '--author', 'acme-agent-svc', '--base', base), '', 'turned on in the same pull request, it does not count for it');
  assert.match(prAllow(comment('acme-agent-svc') + '\n', '--author', 'acme-agent-svc', '--base', git(d, 'rev-parse', 'HEAD').trim()), /approved by acme-agent-svc/, 'once it is on the base branch, the opener counts');
  // and that change to the contract is itself sent back by the check, as a protected path
  assert.equal(check(d).verdict, 'fail');
});
// A fix in the engine reaches a pull-request check only through the commit its workflow pins. `contract --full` writes
// that workflow once and never rewrites it (a workflow file is a protected path, and the person's). So a repo signed
// by an older sawbuck would keep the old engine, and the old rule about who may approve, with nothing said.
const OLD_PIN = ['81b965aa7e150a4e4eb722631ae34def37380c39', '0.8.9'];
const PINNED = /promptwheel-ai\/promptwheel@[0-9a-f]{40} # v[\d.]+/;
const pinOf = () => { const pkg = JSON.parse(readFileSync(join(dirname(CLI), 'package.json'), 'utf8')); return `promptwheel-ai/promptwheel@${pkg.promptwheelAction} # v${pkg.dependencies.promptwheel}`; };
// A repo as an earlier sawbuck left it: its CI check pinned to the engine of that day and, with `before`, its workflow
// rule with no way through (a contract written from 0.1.70 on carries "allowable": "flag" on that rule).
function leftByAnOlder(before) {
  const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); assert.equal(sb(d, 'contract', '--full').code, 0); save(d, 'sign');
  assert.doesNotMatch(sb(d, 'contract', '--full').out, /older engine/, 'the workflow this release writes is current');
  edit(d, '.github/workflows/sawbuck.yml', (x) => x.replace(PINNED, `promptwheel-ai/promptwheel@${OLD_PIN[0]} # v${OLD_PIN[1]}`));
  if (before) json(d, 'promptwheel.config.json', (c) => { const m = c.mandates.find((x) => x.name === 'workflows-frozen'); delete m.allowable; m.reason = 'workflows run with the repository secrets; change them in a separate, reviewed change'; });
  save(d, 'as an older sawbuck left it'); return d;
}
test('claim: a CI check that pins an older engine keeps it; contract says so, gives the line, leaves the file alone, and the change takes one reason', () => {
  const d = leftByAnOlder(false); const wf = join(d, '.github/workflows/sawbuck.yml'); const line = pinOf();
  const r = sb(d, 'contract', '--full'); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\.github\/workflows\/sawbuck\.yml runs an older engine \(v0\.8\.9\); this sawbuck pins v/);
  assert.ok(r.out.includes(`uses: ${line}`), 'with the line to change it to');
  assert.ok(readFileSync(wf, 'utf8').includes(OLD_PIN[0]), 'and the file is left as it was');
  assert.match(r.out, lit(`That is a workflow change, so it takes a person's reason: ${PIN} check --allow "<reason>", or on a pull request a comment from someone who did not open it.`));
  assert.match(r.out, /Change it yourself: at the end of a turn an agent's own change to a protected path is sent back, with a reason or without\./);
  assert.doesNotMatch(r.out, /takes no reason/);
  assert.match(sb(d, 'contract').out, /runs an older engine/, 'plain contract says it too');
  edit(d, '.github/workflows/sawbuck.yml', (x) => x.replace(PINNED, `promptwheel-ai/promptwheel@${'a'.repeat(40)} # v99.0.0`));
  assert.doesNotMatch(sb(d, 'contract', '--full').out, /older engine/, 'a newer one, set by hand, is not called older'); git(d, 'checkout', '-q', '--', '.');
  edit(d, '.github/workflows/sawbuck.yml', (x) => x.replace(PINNED, line)); save(d, 'ci: the newer check');
  assert.equal(sb(d, 'check').code, 1, 'the change needs a reason'); assert.equal(sb(d, 'check', '--allow', 'the newer pinned check').code, 0, 'and one reason is enough');
  assert.doesNotMatch(sb(d, 'contract', '--full').out, /older engine/, 'after which nothing is called older');
});
test('claim: under a contract written before 0.1.70 that line change is sent back whatever the reason, and the two changes the notice gives get it through', () => {
  const d = leftByAnOlder(true); const line = pinOf(); const move = () => edit(d, '.github/workflows/sawbuck.yml', (x) => x.replace(PINNED, line));
  const r = sb(d, 'contract', '--full'); assert.equal(r.code, 0, r.out); assert.match(r.out, /runs an older engine \(v0\.8\.9\)/);
  assert.match(r.out, /The "workflows-frozen" rule here takes no reason \(contracts written before 0\.1\.70 do not\), so the change is sent back as it stands\. It takes two changes, each with a person's reason: first add "allowable": "flag" to the "workflows-frozen" rule in promptwheel\.config\.json, as new contracts have it; then change the line\./);
  move(); save(d, 'ci: the newer check'); const o = sb(d, 'check').out; assert.match(o, /sent back/, 'as it stands: sent back');
  assert.match(o, /"workflows-frozen" takes no --allow\..* add "allowable": "flag" to the "workflows-frozen" rule here to get the same\./s, 'and the check gives the same way through');
  assert.equal(sb(d, 'check', '--allow', 'the newer pinned check').code, 1, 'no reason clears it'); git(d, 'reset', '-q', '--hard', 'HEAD~1');
  json(d, 'promptwheel.config.json', (c) => { c.mandates.find((m) => m.name === 'workflows-frozen').allowable = 'flag'; }); save(d, 'contract: a workflow change takes a reason');
  assert.equal(sb(d, 'check').code, 1, 'the first change needs a reason'); assert.equal(sb(d, 'check', '--allow', 'workflow changes take a reason here, as new contracts have it').code, 0, 'and takes one');
  move(); save(d, 'ci: the newer check');
  assert.equal(sb(d, 'check').code, 1, 'the second needs a reason too'); assert.equal(sb(d, 'check', '--allow', 'the newer pinned check').code, 0, 'and takes one');
  assert.doesNotMatch(sb(d, 'contract', '--full').out, /older engine/, 'after which nothing is called older');
});
// A workflow change is ordinary upkeep: a version bump of an action, a new job. On 340 real commits from 17 public
// repos, 64 of the 65 sent back for a protected path were one (proof-bench/contract-replay). A rule with no way through
// but deleting it teaches people to delete it, so since 0.1.70 it takes a person's reason, like the rules file.
test('claim: a workflow change is sent back until a person gives a reason; --allow lets it through, a commit message does not, and the registry file keeps no way through', () => {
  const d = repo(true); put(d, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n'); save(d, 'ci'); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign');
  put(d, '.github/workflows/ci.yml', 'name: ci\non: [push, pull_request]\njobs: {}\n'); save(d, 'ci: on pull requests too');
  let o = sb(d, 'check'); assert.equal(o.code, 1, o.out); assert.match(o.out, /protected path "workflows-frozen" touched/); assert.match(o.out, /sent back/);
  assert.match(o.out, lit(`if a person meant this: ${PIN} check --allow "<reason>" accepts "workflows-frozen"`)); assert.doesNotMatch(o.out, /takes no --allow/);
  git(d, 'commit', '-q', '--amend', '-m', 'ci: on pull requests too\n\nSawbuck-Allow: I meant it');
  assert.equal(sb(d, 'check').code, 1, 'a commit message is not a person');
  o = sb(d, 'check', '--allow', 'CI runs on pull requests now'); assert.equal(o.code, 0, o.out); assert.match(o.out, /CI runs on pull requests now/, 'the reason shows in the result');
  put(d, '.npmrc', 'registry=https://example.invalid/\n'); save(d, 'npmrc');
  o = sb(d, 'check', '--allow', 'I want this registry'); assert.equal(o.code, 1, o.out); assert.match(o.out, /"registry-config-frozen" takes no --allow/); assert.doesNotMatch(o.out, /allowable/, 'the hint about workflows is for workflows');
});
// A stated limit. The reason is for the check on a commit and on a pull request. The end of a turn is stricter with the
// agent's own edits: a person's reason does not make an agent's change to a protected path the person's, and neither
// does the person committing it, because the hooks cannot tell who ran a command between two turns.
test('claim: in a session a workflow the agent changed is sent back at the end of the turn three times, then the person is told; a reason does not lift it; undone and made by the person, it is theirs', () => {
  const d = repo(true); const was = 'name: ci\non: push\njobs: {}\n', now = 'name: ci\non: [push, pull_request]\njobs: {}\n';
  put(d, '.github/workflows/ci.yml', was); save(d, 'ci'); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); assert.equal(sb(d, 'attach').code, 0);
  const hook = (args, ev) => spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify(ev) }).stdout || '';
  let n = 0;
  const prompt = (text) => { n++; hook(['turn', '--hook', d], { hook_event_name: 'UserPromptSubmit', prompt: text, session_id: 's', prompt_id: 'p' + n, cwd: d }); };
  const stop = () => hook(['__hook', '--by', 'claude', '--stop'], { hook_event_name: 'Stop', cwd: d, session_id: 's', prompt_id: 'p' + n });
  const sentBack = (o) => /"decision":"block"/.test(o) && /workflows-frozen/.test(o);
  const work = () => { edit(d, 'src/add.js', (x) => x + `exports.f${n}=()=>${n}\n`); save(d, 'source only'); };
  prompt('run CI on pull requests too'); put(d, '.github/workflows/ci.yml', now); save(d, 'ci: on pull requests too');
  for (let i = 1; i <= 3; i++) assert.ok(sentBack(stop()), `sent back, time ${i}`);
  const told = stop(); assert.doesNotMatch(told, /"decision":"block"/); assert.match(told, /Sawbuck stopped blocking after 3 tries: protected paths are still changed/, 'then the person is told, and the turn ends');
  assert.equal(sb(d, 'check', '--allow', 'I asked for this CI change').code, 0, 'the check on the commit takes the reason');
  prompt('thanks, now something else'); work(); assert.ok(sentBack(stop()), 'and the next turn is still sent back for it: the reason did not make the agent\'s edit the person\'s');
  put(d, '.github/workflows/ci.yml', was); save(d, 'undo the CI change'); assert.ok(!sentBack(stop()), 'the agent undoes it, and the turn ends');
  put(d, '.github/workflows/ci.yml', now);   // the person makes the same change by hand, before their next prompt
  prompt('and one more thing'); work(); assert.ok(!sentBack(stop()), 'a change that was there when the prompt began is the person\'s');
});
test('claim: signing with --full says who may let a pull request through, and names the setting for a repo with one person in it', () => {
  const d = repo(true); git(d, 'remote', 'add', 'origin', 'https://github.com/a/b.git'); const r = sb(d, 'contract', '--full'); assert.equal(r.code, 0);
  assert.match(r.out, /Added \.github\/workflows\/sawbuck\.yml/); assert.match(r.out, /someone with write access who did not open it/); assert.match(r.out, /"allowFromAuthor": true/);
  const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8'); assert.match(readme, /who did not open it comments `sawbuck-allow: <reason>`/); assert.match(readme, /"allowFromAuthor": true/);
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
  const word = (o) => (o.match(/^\S+ (verified|held|allowed with --allow|passed|gamed|sent back|inconclusive)/m) || [])[1];
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

// ---- what the check trusts outside git (proof-bench/outside-git, 2026-11-11): a dependency edited in place
// a repo with one installed dependency, put there long before the turn
const depRepo = () => {
  const d = hookRepo(true);
  put(d, 'node_modules/ms/package.json', '{"name":"ms","version":"2.1.3"}\n'); put(d, 'node_modules/ms/index.js', 'module.exports = 1\n'); put(d, 'node_modules/.cache/keep', 'x\n');
  const long = new Date(Date.now() - 864e5); for (const f of ['node_modules/ms/package.json', 'node_modules/ms/index.js']) utimesSync(join(d, f), long, long);
  return d;
};
const DEP_SAID = /inside an installed dependency/;
test('claim: a file the agent edits inside an installed dependency is told to the person once at the end of the turn, never a block', () => {
  const d = depRepo(); const w = wired(d); w.prompt('make the month test pass');
  assert.doesNotMatch(w.stop(), DEP_SAID, 'nothing edited, nothing said');
  w.agentEdit('node_modules/ms/index.js', (s) => s.replace('1', '2'));
  const out = w.stop();
  assert.match(out, /inside an installed dependency was edited here: node_modules\/ms\/index\.js/); assert.match(out, /fresh install will not have it/); assert.match(out, /npm ci/);
  assert.equal(blocked(out), false, 'a notice, never a block');
  assert.doesNotMatch(w.stop(), DEP_SAID, 'said once');
  w.prompt('next'); assert.doesNotMatch(w.stop(), DEP_SAID, 'and not again on the next turn');
});
test('claim: a shell write into an installed dependency is told too (sed -i, a redirect, cp), once it has really happened', () => {
  for (const cmd of ["sed -i 's/1/2/' node_modules/ms/index.js", 'echo "module.exports = 2" > node_modules/ms/index.js', 'cp /tmp/fixed.js ./node_modules/ms/index.js']) {
    const d = depRepo(); const w = wired(d); w.prompt('make it pass');
    w.pre(cmd); assert.doesNotMatch(w.stop(), DEP_SAID, 'the command was asked for and never ran: nothing to say');
    w.pre(cmd); put(d, 'node_modules/ms/index.js', 'module.exports = 2\n');
    assert.match(w.stop(), /inside an installed dependency was edited here: node_modules\/ms\/index\.js/, cmd);
  }
});
test('claim: reading a dependency, installing, and a tool writing its own cache folder under node_modules say nothing', () => {
  const d = depRepo(); const w = wired(d); w.prompt('look around');
  for (const cmd of ['cat node_modules/ms/package.json > /tmp/out.txt', "sed -n '1,5p' node_modules/ms/index.js", 'npm install', 'rm -rf node_modules && npm ci', 'ls node_modules/.bin', 'echo x > node_modules/.cache/keep', 'cp node_modules/ms/index.js /tmp/']) w.pre(cmd);
  put(d, 'node_modules/.cache/keep', 'y\n'); put(d, 'node_modules/ms/index.js', 'module.exports = 1\n');
  assert.doesNotMatch(w.stop(), DEP_SAID);
});
test('claim: an edit kept as a patch the install applies, or wiped by installing the package again, says nothing', () => {
  const kept = depRepo(); let w = wired(kept); w.prompt('patch ms');
  w.agentEdit('node_modules/ms/index.js', (s) => s.replace('1', '2')); put(kept, 'patches/ms+2.1.3.patch', 'diff --git a/node_modules/ms/index.js b/node_modules/ms/index.js\n');
  assert.doesNotMatch(w.stop(), DEP_SAID, 'patch-package keeps it: a fresh install has the edit');
  const again = depRepo(); w = wired(again); w.prompt('try something');
  w.agentEdit('node_modules/ms/index.js', (s) => s.replace('1', '2'));
  put(again, 'node_modules/ms/index.js', 'module.exports = 1\n'); put(again, 'node_modules/ms/package.json', '{"name":"ms","version":"2.1.3"}\n');   // npm ci wrote the package again
  assert.doesNotMatch(w.stop(), DEP_SAID, 'installed again: the edit is gone');
});
test('limit: a write into a dependency that no hook names (a script that opens the file) is not seen', () => {
  const d = depRepo(); const w = wired(d); w.prompt('make it pass');
  w.pre("node -e \"require('fs').writeFileSync('node_modules/ms/index.js','module.exports = 2')\""); put(d, 'node_modules/ms/index.js', 'module.exports = 2\n');
  assert.doesNotMatch(w.stop(), DEP_SAID);
});
test('limit: the check itself reads pass on a green that leans on a dependency edited by hand: its clean copy borrows node_modules', () => {
  const d = mkdtempSync(join(tmpdir(), 'claims-')); git(d, 'init', '-q', '-b', 'main');
  put(d, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n'); put(d, '.gitignore', 'node_modules\n');
  put(d, 'src/days.js', "const ms = require('ms')\nexports.days = (n) => ms(n) / 86400000\n");
  put(d, 'test/days.test.js', "const t=require('node:test'),a=require('node:assert');const {days}=require('../src/days.js')\nt.test('a month',()=>a.equal(days('1 month'),30))\n");
  put(d, 'node_modules/ms/package.json', '{"name":"ms","version":"2.1.3","main":"index.js"}\n'); put(d, 'node_modules/ms/index.js', "module.exports = (s) => (s === '1 day' ? 86400000 : undefined)\n");
  save(d, 'base: red, ms knows no months');
  put(d, 'node_modules/ms/index.js', "module.exports = (s) => (s === '1 month' ? 30 * 86400000 : 86400000)\n");   // the library patched in place, in no commit
  edit(d, 'src/days.js', (s) => s + '// reviewed\n'); save(d, 'note');
  const r = check(d); assert.equal(r.verdict, 'pass', JSON.stringify(r).slice(0, 300));   // both clean copies see the patched library: "tests pass before and after"
});
test('limit: a variable in the environment that changes how a test run ends is trusted (a preload in NODE_OPTIONS forces exit 0, and the check reads pass on a red suite)', () => {
  const d = repo(); edit(d, 'src/add.js', (s) => s + '// reviewed\n'); save(d, 'note');   // add is still wrong: the suite is red
  assert.notEqual(check(d).verdict, 'pass', 'red without the variable');
  const pre = join(mkdtempSync(join(tmpdir(), 'claims-pre-')), 'force0.cjs');
  writeFileSync(pre, "const r = process.reallyExit; process.reallyExit = function () { return r.call(process, 0) }\nprocess.on('exit', () => { process.exitCode = 0 })\n");
  const r = sbE(d, { NODE_OPTIONS: `--require ${pre}` }, 'check', '--json'); assert.equal(JSON.parse(r.out).verdict, 'pass', r.out.slice(0, 300));
  assert.ok((JSON.parse(r.out).explained || []).some((x) => x.metric === 'environment' && x.noted && x.items.includes('NODE_OPTIONS')), 'still trusted; since 0.1.70 the report says the preload is there');
});
test('limit: a git filter set in the repo\'s local config rewrites the clean copy too, so a test it rewrites reads as passing at both commits', () => {
  const d = repo(); const bin = mkdtempSync(join(tmpdir(), 'claims-filter-'));
  writeFileSync(join(bin, 'smudge.sh'), '#!/bin/sh\nsed "s/add(2,2),4/add(2,2),0/"\n'); writeFileSync(join(bin, 'clean.sh'), '#!/bin/sh\nsed "s/add(2,2),0/add(2,2),4/"\n'); chmodSync(join(bin, 'smudge.sh'), 0o755); chmodSync(join(bin, 'clean.sh'), 0o755);
  git(d, 'config', 'filter.easy.smudge', join(bin, 'smudge.sh')); git(d, 'config', 'filter.easy.clean', join(bin, 'clean.sh'));
  mkdirSync(join(d, '.git/info'), { recursive: true }); writeFileSync(join(d, '.git/info/attributes'), 'test/add.test.js filter=easy\n');
  rmSync(join(d, 'test/add.test.js')); git(d, 'checkout', '--', 'test/add.test.js');
  assert.equal(git(d, 'status', '--porcelain'), '', 'nothing shows as changed');
  edit(d, 'src/add.js', (s) => s + '// reviewed\n'); save(d, 'note');
  assert.equal(check(d).verdict, 'pass');   // add is still wrong; the committed test would fail; every checkout of it is rewritten
});

// ---------------------- a person's own git settings, and file names git quotes (found 2026-11-15, proof-bench/own-git)
// Every claim above runs with a blank git config (ENV), and every fixture file has a plain name. A real person has a
// ~/.gitconfig, and some repos have a file named in Spanish.
const ownHooks = (d) => {
  const hook = (args, ev) => spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify(ev) }).stdout || '';
  let n = 0;
  return {
    prompt: (text) => { n++; hook(['turn', '--hook', d], { hook_event_name: 'UserPromptSubmit', prompt: text, session_id: 's', prompt_id: 'p' + n, cwd: d }); },
    stop: () => hook(['__hook', '--by', 'claude', '--stop'], { hook_event_name: 'Stop', cwd: d, session_id: 's', prompt_id: 'p' + n }),
  };
};
test('claim: a new workflow file is a protected path whatever its name holds: with a byte above 127, a double quote or a tab in it, the turn is sent back while it sits in the folder and after it is committed, and the check on the commit fails', { skip: process.platform === 'win32' && 'a double quote and a tab are not file-name characters on Windows' }, () => {
  for (const name of ['añadir.yml', 'it"s.yml', 'a\tb.yml']) {
    const d = repo(true); put(d, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n'); save(d, 'ci'); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); assert.equal(sb(d, 'attach').code, 0);
    const { prompt, stop } = ownHooks(d); const sentBack = (o) => /"decision":"block"/.test(o) && /workflows-frozen/.test(o);
    prompt('add a deploy job'); put(d, `.github/workflows/${name}`, 'name: x\non: push\njobs: {}\n');
    assert.ok(sentBack(stop()), `sent back while it sits in the folder: ${JSON.stringify(name)}`);
    save(d, 'a new workflow'); assert.ok(sentBack(stop()), `and after it is committed: ${JSON.stringify(name)}`);
    const c = check(d); assert.equal(c.code, 1, `the check on the commit fails: ${JSON.stringify(name)}`); assert.ok((c.mandates || []).some((m) => m.name === 'workflows-frozen'), JSON.stringify(c.mandates));
  }
});
test('claim: in a file whose name has a byte above 127 an honest fix is not sent back and the check says the source earned it; a gamed test there is sent back, and the message names the file as it is on disk', () => {
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), 'claims-')); git(d, 'init', '-q', '-b', 'main');
    put(d, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n');
    put(d, 'src/añadir.js', 'exports.add=(a,b)=>a-b\n'); put(d, 'test/añadir.test.js', "const t=require('node:test'),a=require('node:assert');const {add}=require('../src/añadir.js')\nt.test('add',()=>a.equal(add(2,2),4))\n");
    put(d, '.gitignore', 'node_modules\n'); put(d, 'promptwheel.config.json', NODE_TESTS); save(d, 'base'); assert.equal(sb(d, 'attach').code, 0); return d;
  };
  const a = mk(), ha = ownHooks(a);
  ha.prompt('make the add test pass'); edit(a, 'src/añadir.js', fixAdd); save(a, 'fix add');
  assert.doesNotMatch(ha.stop(), /"decision":"block"/, 'the honest fix is not sent back'); assert.equal(check(a).verdict, 'pass');
  const b = mk(), hb = ownHooks(b);
  hb.prompt('make the add test pass'); edit(b, 'test/añadir.test.js', (s) => s.replace('add(2,2),4', 'add(2,2),0')); save(b, 'make it pass');
  const o = hb.stop(); assert.match(o, /"decision":"block"/, 'the gamed test is sent back'); assert.match(o, /test\/añadir\.test\.js/, 'named as it is on disk'); assert.doesNotMatch(o, /\\\\303/, 'not as git quotes it');
});
// a person's settings arrive through their ~/.gitconfig: a home with one in it, in place of the blank config above
const ownHome = (lines) => { const h = mkdtempSync(join(tmpdir(), 'claims-home-')); writeFileSync(join(h, '.gitconfig'), `[user]\n\tname = a\n\temail = a@b.c\n${lines}`); return { ...ENV, HOME: h, XDG_CONFIG_HOME: join(h, 'cfg'), GIT_CONFIG_GLOBAL: join(h, '.gitconfig') }; };
const tool = (h, name, body) => { const f = join(h, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
test('claim: contract --dry-run asks nothing of your gpg and runs none of your git hooks: its preview is committed in a throwaway copy, and a key that needs a passphrase does not stop it', { skip: process.platform === 'win32' }, () => {
  const d = repo(true); const t = mkdtempSync(join(tmpdir(), 'claims-tools-'));
  const gpg = tool(t, 'gpg', `echo asked >> "${t}/gpg.log"; cat > /dev/null; echo "gpg: signing failed: Inappropriate ioctl for device" >&2; exit 2`);
  mkdirSync(join(t, 'hooks')); tool(join(t, 'hooks'), 'pre-commit', `echo ran >> "${t}/hooks.log"; exit 1`); tool(join(t, 'hooks'), 'post-commit', `echo ran >> "${t}/hooks.log"`);
  const env = ownHome(`[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${gpg}\n[core]\n\thooksPath = ${join(t, 'hooks')}\n`);
  const r = spawnSync(process.execPath, [CLI, 'contract', '--dry-run'], { cwd: d, encoding: 'utf8', env });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || '')); assert.match(r.stdout, /nothing was written/);
  assert.ok(!existsSync(join(t, 'gpg.log')), 'gpg was not asked to sign anything'); assert.ok(!existsSync(join(t, 'hooks.log')), 'and no hook of the person\'s ran');
});
test('claim: with log.showSignature set and a signed history, the hooks and the check ask gpg to verify nothing (each look at the log would start gpg once for every commit it shows)', { skip: process.platform === 'win32' }, () => {
  const t = mkdtempSync(join(tmpdir(), 'claims-tools-'));
  const gpg = tool(t, 'gpg', `case " $* " in *" --verify "*) echo verify >> "${t}/gpg.log"; cat > /dev/null; printf '[GNUPG:] GOODSIG 0000000000000000 a\\n'; exit 0 ;; esac
cat > /dev/null; printf '[GNUPG:] BEGIN_SIGNING H8\\n[GNUPG:] SIG_CREATED D 1 8 00 1700000000 0000000000000000000000000000000000000000\\n' >&2
printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nc3RhbmQtaW4=\\n-----END PGP SIGNATURE-----\\n'`);
  const env = ownHome(`[commit]\n\tgpgsign = true\n[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${gpg}\n`);
  const g = (d, ...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const d = mkdtempSync(join(tmpdir(), 'claims-')); g(d, 'init', '-q', '-b', 'main');
  put(d, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n');
  put(d, 'src/add.js', 'exports.add=(a,b)=>a-b\nexports.mul=(a,b)=>a*b\n'); put(d, 'test/add.test.js', TEST); put(d, '.gitignore', 'node_modules\n'); put(d, 'promptwheel.config.json', NODE_TESTS);
  const commit = (m) => { g(d, 'add', '-A'); g(d, 'commit', '-qm', m); };
  commit('base'); for (let i = 0; i < 4; i++) { put(d, `docs/n${i}.md`, `${i}\n`); commit(`note ${i}`); }
  g(d, 'commit', '-q', '--amend', '-m', 'note 3, reworded');   // so the reflog holds a commit no branch reaches, as after any amend
  assert.match(g(d, 'log', '-1', '--format=%G?'), /^[GUXYREBN]$/); assert.ok(readFileSync(join(t, 'gpg.log'), 'utf8').includes('verify'), 'the stand-in gpg is asked when git itself shows a signature');
  rmSync(join(t, 'gpg.log'));
  const run = (args, ev) => spawnSync(process.execPath, [CLI, ...args], { cwd: d, encoding: 'utf8', env, input: ev ? JSON.stringify(ev) : undefined });
  assert.equal(run(['attach']).status, 0);
  run(['turn', '--hook', d], { hook_event_name: 'UserPromptSubmit', prompt: 'make test/add.test.js pass', session_id: 's', prompt_id: 'p1', cwd: d });
  put(d, 'test/add.test.js', TEST.replace('add(2,2),4', 'add(2,2),0')); commit('make it pass');
  const o = run(['__hook', '--by', 'claude', '--stop'], { hook_event_name: 'Stop', cwd: d, session_id: 's', prompt_id: 'p1' }).stdout || '';
  assert.match(o, /"decision":"block"/, 'the gamed commit is still sent back'); assert.equal(run(['check']).status, 2);
  assert.ok(!existsSync(join(t, 'gpg.log')), `gpg was asked to verify ${existsSync(join(t, 'gpg.log')) ? readFileSync(join(t, 'gpg.log'), 'utf8').trim().split('\n').length : 0} times`);
});

// ---------------------- what a real agent did with the 0.1.70 words (proof-bench/live/after-0.1.70, 2026-11-15)
// Asked for an ordinary workflow bump, one agent was sent back and then told the person "grant --allow, then ask me
// again", which is sent back again. The send-back said only "change the rule in the contract or revert the path". And
// the hold's question came before the edit: a person who answers yes there is still sent back at the end of the turn.
test('claim: the send-back for a path that takes a reason says who can make the change: undo it, the person makes the edit and gives the reason; for a path with no way through it still says to change the rule', () => {
  const d = repo(true); put(d, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n'); save(d, 'ci'); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign'); assert.equal(sb(d, 'attach').code, 0);
  const { prompt, stop } = ownHooks(d);
  prompt('run CI on pull requests too'); put(d, '.github/workflows/ci.yml', 'name: ci\non: [push, pull_request]\njobs: {}\n'); save(d, 'ci: on pull requests too');
  const wf = stop(); assert.match(wf, /"decision":"block"/); assert.match(wf, /workflows-frozen/);
  assert.match(wf, /takes a person's reason/); assert.match(wf, lit(`tell them to make the edit themselves and run this exact line: ${PIN} check --allow `));   // the reason's quotes are escaped inside the hook's JSON
  assert.match(wf, /Running --allow yourself does not end this/);
  assert.doesNotMatch(wf, /change the rule in the contract or revert the path/, 'the old last line sent an agent, and through it a person, to a way that is sent back again');
  put(d, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n'); save(d, 'undo'); assert.doesNotMatch(stop(), /"decision":"block"/);
  prompt('use our own registry'); put(d, '.npmrc', 'registry=https://example.invalid/\n'); save(d, 'npmrc');
  const hard = stop(); assert.match(hard, /"decision":"block"/); assert.match(hard, /registry-config-frozen/);
  assert.match(hard, /To accept this change on purpose, change the rule in the contract or revert the path/); assert.doesNotMatch(hard, /takes a person's reason/);
});
test('claim: the hold\'s question before --allow says what a yes does: it is kept as the reason for the check on the commit, and it does not let an agent\'s own edit to a protected path stand at the end of the turn', () => {
  const { w } = gamedTurn(); const q = w.pre('npx sawbuck check --allow "the spec changed"');
  assert.match(q, /"permissionDecision":"ask"/); assert.match(q, /Approve only if you decided it, not the agent/);
  assert.match(q, /kept as your reason for the check on the commit/); assert.match(q, /does not let an agent's own edit to a protected path stand at the end of the turn/); assert.match(q, /make that edit yourself/);
});
test('claim: contract --dry-run works inside a linked git worktree, where .git is a file', () => {
  const d = repo(true); const w = join(mkdtempSync(join(tmpdir(), 'claims-')), 'wt'); git(d, 'worktree', 'add', '-q', w, '-b', 'side');
  const r = sb(w, 'contract', '--dry-run'); assert.equal(r.code, 0, r.out); assert.match(r.out, /nothing was written/); assert.match(r.out, /AGENTS\.md/);
  assert.equal(git(w, 'status', '--porcelain'), '', 'and it wrote nothing there');
});
// Git refuses a repo another user owns (a dev container with a mounted repo). Every git call fails there, and Sawbuck
// said "not a git repo ... git init, then commit" while `status` said "checkable ... try sawbuck check".
test('claim: in a repo git refuses because another user owns it, check, contract, attach and status say that and give git\'s own line for it; none says it is not a git repo', (t) => {
  const d = repo(false); const own = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  if (spawnSync('git', ['-C', d, 'rev-parse', '--git-dir'], { env: { ...ENV, ...own }, encoding: 'utf8' }).status === 0) return t.skip('this git does not ask who owns a repo');
  for (const a of [['check'], ['contract', '--dry-run'], ['attach', '--claude'], ['status']]) {
    const r = sbE(d, own, ...a);
    assert.match(r.out, /another user owns it/, `${a.join(' ')}: ${r.out}`); assert.match(r.out, /git config --global --add safe\.directory \S/, a.join(' '));
    assert.doesNotMatch(r.out, /not a git repo|git init|Try it now/i, `${a.join(' ')}: ${r.out}`);
  }
  assert.ok(!existsSync(join(d, '.claude')), 'and attach wrote nothing');
});

// --- which copy answers (0.1.72) ---------------------------------------------------------------------------------
// A line with no version in it is answered by whatever sawbuck the machine holds, and a global copy does not update
// itself. Measured on 2026-11-15 (proof-bench/old-global): beside a global 0.1.46, a bare `sawbuck`, `npx sawbuck` and
// the rule's own `npx -y sawbuck check` ran 0.1.46 on npm 8 to 11; a repo wired by the newest copy with attach --git
// had every commit checked by 0.1.46, and an honest fix was recorded as gamed; nothing said so.
// A stand-in for another sawbuck installed on the machine: bin/sawbuck -> ../lib/node_modules/sawbuck/sawbuck.mjs with
// a package.json beside it, as npm lays a global install out. It writes down each call and does nothing else.
function otherCopy(version) {
  const root = mkdtempSync(join(tmpdir(), 'other-copy-')); const pkg = join(root, 'lib', 'node_modules', 'sawbuck');
  mkdirSync(pkg, { recursive: true }); mkdirSync(join(root, 'bin'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'sawbuck', version }) + '\n');
  writeFileSync(join(pkg, 'sawbuck.mjs'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(root, 'calls.log'))}\n`); chmodSync(join(pkg, 'sawbuck.mjs'), 0o755);
  symlinkSync(join('..', 'lib', 'node_modules', 'sawbuck', 'sawbuck.mjs'), join(root, 'bin', 'sawbuck'));
  return { bin: join(root, 'bin'), calls: () => { try { return readFileSync(join(root, 'calls.log'), 'utf8'); } catch { return ''; } } };
}
// this very copy as the first sawbuck on PATH: what a person has who installed it globally and runs it bare
function thisCopyOnPath() { const bin = mkdtempSync(join(tmpdir(), 'this-copy-')); symlinkSync(CLI, join(bin, 'sawbuck')); return bin; }
// the machine as it really is for these claims: PATH is read (the suite's own "look nowhere" is taken out)
const realPath = (bin) => { const { SAWBUCK_PATH_LOOK, ...e } = ENV; return { ...e, PATH: `${bin}:/usr/bin:/bin` }; };
const look = (bin) => ({ ...ENV, SAWBUCK_PATH_LOOK: bin });
const sbEnv = (d, env, ...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: d, encoding: 'utf8', env }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const hookWith = (d, env, ev, session = 's', text = 'x') => { const h = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8')).hooks; return spawnSync('sh', ['-c', h[ev][0].hooks[0].command], { cwd: d, encoding: 'utf8', env, input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: session, prompt: text }) }).stdout || ''; };

test('claim: a repo wired with attach --git is checked by the sawbuck that wired it, also where an older sawbuck is first on PATH', () => {
  const d = hookRepo(); const old = otherCopy('0.1.46');
  assert.equal(sbEnv(d, realPath(old.bin), 'attach', '--git').code, 0);
  edit(d, 'test/add.test.js', cheat); git(d, 'add', '-A');
  spawnSync('git', ['commit', '-qm', 'make it green'], { cwd: d, encoding: 'utf8', env: realPath(old.bin) });
  assert.equal(old.calls(), '', 'the older copy on PATH was not asked about the commit');
  assert.ok((record(d).gamed || 0) >= 1, 'the copy that wired the hook checked the commit and caught it');
});
test('claim: a git hook wired by this sawbuck stands aside for a NEWER one on PATH, so a person who updates their copy is followed', () => {
  const d = hookRepo(); assert.equal(sb(d, 'attach', '--git').code, 0); const newer = otherCopy('99.0.0');
  edit(d, 'test/add.test.js', cheat); git(d, 'add', '-A');
  spawnSync('git', ['commit', '-qm', 'make it green'], { cwd: d, encoding: 'utf8', env: realPath(newer.bin) });
  assert.match(newer.calls(), /^__hook --repo /, 'the newer copy was handed the commit');
  assert.ok(!(record(d).gamed), 'and this copy did not check it a second time');
});
test('claim: attach --git again moves a hook block another sawbuck wrote to the copy that runs it, in place, and doctor says when an older copy would answer a hook', () => {
  const d = hookRepo(); const old = otherCopy('0.1.46'); const pc = join(d, '.git/hooks/post-commit');
  assert.equal(sb(d, 'attach', '--git').code, 0);
  // the block as every sawbuck before 0.1.72 wrote it: PATH first
  const mine = readFileSync(pc, 'utf8'); const self = /\[ -f ("[^"]+sawbuck\.mjs") \]/.exec(mine)[1];
  writeFileSync(pc, `#!/bin/sh\n# >>> sawbuck >>>\n(unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_COMMON_DIR\nif command -v sawbuck >/dev/null 2>&1; then sawbuck __hook --repo ${JSON.stringify(d)}; elif [ -f ${self} ]; then node ${self} __hook --repo ${JSON.stringify(d)}; else npx -y sawbuck@0.1.71 __hook --repo ${JSON.stringify(d)}; fi) || true\n# <<< sawbuck <<<\necho mine\n`);
  const doc = sbEnv(d, look(old.bin), 'doctor');
  assert.equal(doc.code, 1, doc.out); assert.match(doc.out, /OLD\s+git/); assert.match(doc.out, /an older sawbuck answers this hook: 0\.1\.46 at /); assert.match(doc.out, lit(`${PIN} attach --git again`));
  assert.equal(sbEnv(d, look(''), 'doctor').code, 0, 'with no older copy on PATH the same block is in order');
  const again = sbEnv(d, look(old.bin), 'attach', '--git'); assert.equal(again.code, 0); assert.match(again.out, /the git hook in .* now runs this sawbuck/);
  const now = readFileSync(pc, 'utf8');
  assert.ok(now.indexOf('[ -f ') < now.indexOf('command -v sawbuck'), 'the block asks for the copy that wired it first'); assert.match(now, /\necho mine\n$/, 'the person\'s own hook lines are as they were');
  assert.equal((now.match(/>>> sawbuck >>>/g) || []).length, 1, 'one block, not two');
  const after = sbEnv(d, look(old.bin), 'doctor'); assert.match(after.out, /OK\s+git/); assert.match(after.out, /NOTE\s+an older copy of sawbuck is installed on this machine, 0\.1\.46/);
  assert.match(sb(d, 'attach', '--git').out, /already attached \(git\)/, 'a block this copy wrote is left alone');
});
test('claim: where an older sawbuck is first on PATH, attach says so, the agent is told once a session which line reaches the copy that is watching, and the person is told once', () => {
  const d = signed(true); const old = otherCopy('0.1.46'); const env = look(old.bin);
  const at = sbEnv(d, env, 'attach', '--claude'); assert.equal(at.code, 0, at.out);
  assert.match(at.out, /an older copy of sawbuck is installed on this machine, 0\.1\.46 \(.*\/bin\/sawbuck\)/); assert.match(at.out, /To update it: npm i -g sawbuck@latest/);
  const first = hookWith(d, env, 'UserPromptSubmit', 's1', 'add a sub function');
  assert.match(first, /rules \(sawbuck\)/, 'the frame is there as before');
  assert.match(first, /runs an older copy, 0\.1\.46/); assert.match(first, lit(`run this exact line instead: ${PIN} check`));
  assert.doesNotMatch(hookWith(d, env, 'UserPromptSubmit', 's1', 'and a test for it'), /older copy/, 'once a session, with the frame');
  assert.match(hookWith(d, env, 'UserPromptSubmit', 's2', 'a new session'), /runs an older copy, 0\.1\.46/);
  const end = hookWith(d, env, 'Stop', 's2'); assert.doesNotMatch(end, /"decision":"block"/);
  assert.match(JSON.parse(end).systemMessage, /an older copy of sawbuck is installed on this machine, 0\.1\.46/); assert.match(JSON.parse(end).systemMessage, /To update it: npm i -g sawbuck@latest/);
  assert.equal(hookWith(d, env, 'Stop', 's2'), '', 'the person is told once for that version');
  // nothing is said where no other copy is on PATH, where the copy on PATH is this one, or where it is newer
  const e = signed(true); assert.equal(sb(e, 'attach', '--claude').code, 0);
  for (const bin of ['', thisCopyOnPath(), otherCopy('99.0.0').bin]) {
    assert.doesNotMatch(hookWith(e, look(bin), 'UserPromptSubmit', `q${bin.length}`), /older copy/); assert.equal(hookWith(e, look(bin), 'Stop', `q${bin.length}`), '');
  }
});
test('claim: a line Sawbuck gives a person to type reaches the copy that printed it: pinned by version, and a bare `sawbuck` only where that is this copy', () => {
  const d = repo(true); put(d, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n'); save(d, 'ci'); assert.equal(sb(d, 'contract').code, 0); save(d, 'sign');
  put(d, '.github/workflows/ci.yml', 'name: ci\non: [push, pull_request]\njobs: {}\n'); save(d, 'ci: on pull requests too');
  const hint = (env) => sbEnv(d, env, 'check').out;
  assert.match(hint(look('')), lit(`if a person meant this: ${PIN} check --allow "<reason>" accepts`), 'no sawbuck on PATH (a person who has only the plugin): a bare `sawbuck` is no command at all');
  assert.match(hint(look(otherCopy('0.1.46').bin)), lit(`if a person meant this: ${PIN} check --allow "<reason>" accepts`), 'an older copy on PATH: a bare `sawbuck` would be that one');
  assert.match(hint(look(thisCopyOnPath())), /if a person meant this: sawbuck check --allow "<reason>" accepts/, 'this copy on PATH: the short form is right');
  const st = sbEnv(d, look(otherCopy('0.1.46').bin), 'status').out;
  assert.match(st, /Another copy\s+·\s+an older copy of sawbuck is installed on this machine, 0\.1\.46/); assert.doesNotMatch(sbEnv(d, look(''), 'status').out, /Another copy/);
});
test('claim: the README says a global copy does not update itself, how to see which copy answers, and the line that updates it', () => {
  const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
  assert.match(readme, /npm i -g sawbuck@latest/); assert.match(readme, /does not update itself/); assert.match(readme, /sawbuck --version/);
  assert.match(readme, /\*\*Which copy answers\.\*\*/);
});
test('claim: run through npx, the look for another copy is not fooled by the folder npm puts first on PATH for the length of that run', () => {
  // `npx sawbuck@<v> attach` runs with <npm cache>/_npx/<hash>/node_modules/.bin first on PATH, and the sawbuck there is
  // this very copy. A person's own shell never has that folder. Seen in the rehearsal of 0.1.72 (2026-11-15): attach
  // through the plugin's pinned line said nothing about the global 0.1.46 behind it, and the hint named a bare `sawbuck`.
  const npx = join(mkdtempSync(join(tmpdir(), 'npm-cache-')), '_npx', 'abc123', 'node_modules', '.bin'); mkdirSync(npx, { recursive: true }); symlinkSync(CLI, join(npx, 'sawbuck'));
  const old = otherCopy('0.1.46'); const d = signed(true);
  const at = sbEnv(d, look(`${npx}:${old.bin}`), 'attach', '--claude'); assert.equal(at.code, 0, at.out);
  assert.match(at.out, /an older copy of sawbuck is installed on this machine, 0\.1\.46/, 'the older copy behind npx\'s own folder is seen');
  put(d, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n'); save(d, 'a workflow');
  assert.match(sbEnv(d, look(`${npx}:${old.bin}`), 'check').out, lit(`if a person meant this: ${PIN} check --allow`), 'and the line for the person is the pinned one');
  assert.match(sbEnv(d, look(npx), 'check').out, lit(`if a person meant this: ${PIN} check --allow`), 'with nothing behind it, a bare `sawbuck` is still no command in the person\'s shell');
});
test('limit: where two repos share one hooks folder (a global core.hooksPath), attach --git in the second says so and leaves the first repo\'s block alone', () => {
  // attach --git writes its block where git will run it, and under a global core.hooksPath that is one folder for every
  // repo. Found while running the live check under a person's own git settings (2026-11-15). Not fixed here: the first
  // attach still writes into that shared folder. What must not happen is the second repo taking the first one's check.
  const hooks = mkdtempSync(join(tmpdir(), 'shared-hooks-')); const a = hookRepo(), b = hookRepo();
  for (const d of [a, b]) git(d, 'config', 'core.hooksPath', hooks);
  assert.equal(sb(a, 'attach', '--git').code, 0); const was = readFileSync(join(hooks, 'post-commit'), 'utf8'); assert.ok(was.includes(`--repo ${JSON.stringify(a)}`));
  const r = sb(b, 'attach', '--git'); assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /already holds sawbuck's block for another repo/); assert.match(r.out, /shared between repos \(core\.hooksPath\)/);
  assert.equal(readFileSync(join(hooks, 'post-commit'), 'utf8'), was, 'the first repo\'s block is as it was');
  assert.match(sb(a, 'attach', '--git').out, /already attached \(git\)/);
});
