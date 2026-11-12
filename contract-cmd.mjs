#!/usr/bin/env node
// sawbuck contract: give a repo its first rules with one command. Keeps whatever config is already here (and adds no
// tests to it); with no config it writes one with your detected tests. Adds the protected paths and the written rule, which is what changes the agent (the pressure bench: 11 of
// 20 to 0 of 20). --full adds the supply-chain guards, the repo lock and a CI check (github.com origin, real test command). Zero-LLM. Re-running changes
// nothing. Protected product code (auth, billing) is suggested, never added: freezing those is a person's decision.
import './pipe.mjs';
import { ensureExcluded } from './exclude.mjs';
import { writeAgentBlock } from './agent-block.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, cpSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PW } from './bins.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The check's own action is pinned by commit, like GitHub's: the commit the engine's release tag points at. A moving
// tag with write access to pull requests is the kind of thing the unpinned_execution guard exists to flag.
const PKG = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const ACTION = `promptwheel-ai/promptwheel@${PKG.promptwheelAction} # v${PKG.dependencies.promptwheel}`;
const repo = process.argv[2] || process.cwd();
const dry = process.argv.includes('--dry-run');
const strict = process.argv.includes('--strict');
const full = process.argv.includes('--full') || strict;
// a new contract starts by watching: everyday change shows as a note. Protected paths, install scripts and sources
// outside the registry still fail from day one. --strict holds them all, and makes the notes of an earlier --full block.
const REPORT = new Set(['dependency_entries', 'lock_drift', 'pins_changed', 'unpinned_execution', 'install_policy_gaps']);
// Tests need their dependencies, so an npm lockfile gets an install, with no scripts. Elsewhere tests may not run in
// CI, so inconclusive does not fail the job: protected paths are checked either way, and a gamed or failed verdict still fails.
const workflow = (npm) => `# Written by sawbuck contract. Checks every pull request against the contract in promptwheel.config.json.
name: Sawbuck
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with: { fetch-depth: 0 }
${npm ? `      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with: { node-version: 22 }
      - run: npm ci --ignore-scripts
` : ''}      - uses: ${ACTION}
        with: { inconclusive: pass }
`;
const cfgPath = join(repo, 'promptwheel.config.json');
// The files signing writes that this repo's ignore rules hide from git: git status does not show them and git add skips
// them, so "commit these" would be a dead end. Some repos ignore everything their .gitignore does not list (npm's do).
// git check-ignore leaves tracked files out, and exits 1 when none of these is ignored.
const SIGNED_FILES = ['AGENTS.md', 'promptwheel.config.json', 'promptwheel.lock.json', '.github/workflows/sawbuck.yml', '.promptwheel/packs/supply-chain/scan.mjs'];
const hiddenFromGit = (root) => { try { return execFileSync('git', ['-C', root, 'check-ignore', '--', ...SIGNED_FILES.filter((f) => existsSync(join(root, f)))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map((f) => f.replace(/^(\.promptwheel\/packs\/supply-chain\/).*/, '$1')); } catch { return []; } };
const addByName = (files) => `  This repo's ignore rules hide ${files.join(' and ')} from git, so add ${files.length > 1 ? 'them' : 'it'} by name: git add -f ${files.join(' ')}\n`;
const run = (args, cwd, stdio = ['ignore', 'pipe', 'pipe']) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio });

// the preset as the engine writes it, in a scratch repo, so the contract and the engine cannot drift apart
const scratch = mkdtempSync(join(tmpdir(), 'sawbuck-contract-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: scratch, stdio: 'ignore' });
  writeFileSync(join(scratch, 'package.json'), '{"name":"scratch"}\n');
  run([PW, 'init', '--preset', 'supply-chain', '--no-agent-block'], scratch);
  const preset = JSON.parse(readFileSync(join(scratch, 'promptwheel.config.json'), 'utf8'));
  const had = existsSync(cfgPath);
  // without --full, the paths that exist only for the lock and the scanners do not apply
  const mandates = preset.mandates.filter((m) => full || !JSON.stringify(m.paths || []).match(/packs|promptwheel\.lock/));
  // what both the dry run and the real run report: every protected path in the contract after signing, and the
  // supply-chain guards --full puts beside your own tests
  const names = (l) => new Set((l || []).map((x) => x && x.name));
  const counts = (c) => `${new Set([...names(c.mandates), ...names(mandates)]).size} protected paths${full ? `, ${preset.metrics.length} supply-chain guards` : ''}`;
  if (dry) {
    // The preview is the real run, done in a throwaway copy of what signing reads, so the two cannot drift apart:
    // the files in the repo's top folder, an existing workflow, the scanners, the remote and the exclude file.
    const shadow = mkdtempSync(join(tmpdir(), 'sawbuck-preview-'));
    try {
      const g = (...a) => execFileSync('git', ['-c', 'user.name=sawbuck', '-c', 'user.email=sawbuck@local', ...a], { cwd: shadow, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      g('init', '-q');
      for (const e of readdirSync(repo, { withFileTypes: true })) if (e.isFile() && statSync(join(repo, e.name)).size < 32 * 1024 * 1024) cpSync(join(repo, e.name), join(shadow, e.name));
      for (const rel of [join('.github', 'workflows', 'sawbuck.yml'), join('.promptwheel', 'packs')]) if (existsSync(join(repo, rel))) cpSync(join(repo, rel), join(shadow, rel), { recursive: true });
      if (existsSync(join(repo, 'node_modules'))) { try { symlinkSync(join(repo, 'node_modules'), join(shadow, 'node_modules')); } catch { /* the lint check may not be offered in the preview */ } }
      const exclude = (root) => resolve(root, execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim());
      let remote = ''; try { remote = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
      if (remote) g('remote', 'add', 'origin', remote);
      try { if (existsSync(exclude(repo))) { mkdirSync(dirname(exclude(shadow)), { recursive: true }); cpSync(exclude(repo), exclude(shadow)); } } catch {}
      const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
      const exWas = read(exclude(shadow));
      g('add', '-A', '-f'); g('commit', '-q', '--allow-empty', '-m', 'as it is now');   // -f: a file the repo tracks in spite of its ignore rules is tracked here too
      run([fileURLToPath(import.meta.url), shadow, ...process.argv.slice(3).filter((a) => a !== '--dry-run')], shadow);
      const rows = new Map();
      for (const l of g('status', '--porcelain', '-uall').split('\n').filter(Boolean)) {
        const f = l.slice(3).replace(/^(\.promptwheel\/packs\/supply-chain\/).*/, '$1');
        if (f !== 'node_modules') rows.set(f, l.startsWith('??') ? 'new' : 'changed');
      }
      const hid = hiddenFromGit(shadow);
      for (const f of hid) rows.set(f, 'new');
      const after = existsSync(join(shadow, 'promptwheel.config.json')) ? JSON.parse(read(join(shadow, 'promptwheel.config.json'))) : { metrics: [], mandates: [] };
      let now = {}; try { if (had) now = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch {}
      const notes = strict ? (now.metrics || []).filter((m) => m && m.report && REPORT.has(m.name)).length : 0;
      const what = {
        'promptwheel.config.json': `${counts(now)}, ${(after.metrics || []).length} checks in all (${(after.metrics || []).map((m) => m.name).join(', ')})${notes ? `, and ${notes} guards that are notes would block` : ''}`,
        'AGENTS.md': 'the written rule', 'CLAUDE.md': 'the written rule', '.cursorrules': 'the written rule',
        '.github/workflows/sawbuck.yml': 'a CI check on pull requests',
        'promptwheel.lock.json': 'the shape of this repo',
        '.promptwheel/packs/supply-chain/': 'the two scanners the supply-chain guards run',
        '.gitignore': 'so the scanners reach git',
      };
      if (!rows.size) process.stdout.write('sawbuck contract --dry-run: already signed, nothing would change.\n');
      else {
        process.stdout.write('sawbuck contract --dry-run: nothing was written. A real run would write:\n');
        for (const [f, how] of rows) process.stdout.write(`  ${f.padEnd(34)} ${how}${what[f] ? ': ' + what[f] : ''}\n`);
        if (read(exclude(shadow)) !== exWas) process.stdout.write('  and lines in .git/info/exclude that keep Sawbuck\'s record out of git status (local, never committed)\n');
        if (hid.length) process.stdout.write(addByName(hid));
      }
    } finally { rmSync(shadow, { recursive: true, force: true }); }
  } else {
    if (!had) run([join(HERE, 'init.mjs'), '-y', '--no-investigate'], repo);
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : { repeat: 1, metrics: [] };
    const before = { m: (cfg.mandates || []).length, g: (cfg.metrics || []).length };
    const hasM = names(cfg.mandates), hasG = names(cfg.metrics);
    cfg.mandates = [...(cfg.mandates || []), ...mandates.filter((m) => !hasM.has(m.name))];
    if (full) {
      cfg.metrics = [...(cfg.metrics || []), ...preset.metrics.filter((m) => !hasG.has(m.name)).map((m) => (!strict && REPORT.has(m.name) ? { ...m, report: true } : m))];
      cfg.evaluatorPaths = [...new Set([...(cfg.evaluatorPaths || []), ...(preset.evaluatorPaths || [])])];
    }
    // --strict on a repo signed with --full: the guards that were notes now block, as the --full output promised
    let hardened = 0;
    if (strict) for (const m of cfg.metrics || []) if (m && m.report && REPORT.has(m.name)) { delete m.report; hardened++; }
    cfg.allowTrailer = false;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    const pack = join(repo, '.promptwheel', 'packs', 'supply-chain');
    if (full) {
      mkdirSync(pack, { recursive: true });
      cpSync(join(scratch, '.promptwheel', 'packs', 'supply-chain'), pack, { recursive: true, filter: (f) => !/(README\.md|pack\.json)$/.test(f) });
      // the gate measures in clean worktrees, so the scanners must reach git. A repo attached earlier, or one that
      // ignores .promptwheel/ for the outcome record, would hide them and every guard would read unmeasurable.
      for (const f of [join(repo, '.gitignore'), resolve(repo, execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim())]) {
        if (!existsSync(f)) continue;
        const text = readFileSync(f, 'utf8');
        const next = text.replace(/^\.promptwheel\/?[ \t]*$/gm, '.promptwheel/*\n!.promptwheel/packs/');
        if (next !== text) writeFileSync(f, next);
      }
    }
    ensureExcluded(repo);
    // the written rule is what changes the agent (the pressure bench: 11 of 20 to 0 of 20), so every signing writes it
    writeAgentBlock(repo);
    // CI goes in here, before the rules take hold: afterwards the contract itself would refuse an agent the file.
    // Only for a GitHub repo with a real test command: a placeholder would fail every pull request.
    const wf = join(repo, '.github', 'workflows', 'sawbuck.yml');
    let remote = ''; try { remote = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
    const realTests = !(cfg.metrics || []).some((m) => /set your test command/.test(String(m.cmd)));
    let ci = '';
    if (full && /github\.com/.test(remote) && realTests && !existsSync(wf)) { mkdirSync(dirname(wf), { recursive: true }); writeFileSync(wf, workflow(existsSync(join(repo, 'package-lock.json')))); ci = wf; }
    const locked = existsSync(join(repo, 'promptwheel.lock.json'));
    if (full && !locked) run([join(pack, 'lock.mjs'), 'write', repo], repo);
    const added = (cfg.mandates.length - before.m) + (cfg.metrics.length - before.g);
    const fresh = added || hardened || ci || (full && !locked);
    process.stdout.write(!fresh ? 'sawbuck: already signed, nothing changed.\n' : full
      ? `sawbuck: signed. ${counts(cfg)}, and the shape of this repo in promptwheel.lock.json.\n${strict ? (hardened ? `  ${hardened} guards that were notes now block. The contract is a protected path, so the commit that carries this needs a person's reason: sawbuck check --allow "<reason>".\n` : '') : '  New dependencies and structure changes show as notes for now; protected paths and install scripts block. --strict blocks them all.\n'}${ci ? '  Added .github/workflows/sawbuck.yml, so pull requests are checked in CI. Commit it with the rest.\n' : ''}`
      : `sawbuck: signed. ${counts(cfg)}, and the rule in AGENTS.md.\n  --full adds supply-chain guards, a repo lock and a CI check.\n`);
    if (full && !ci && !existsSync(wf)) process.stdout.write(`  No CI check added: ${!/github\.com/.test(remote) ? 'this repo has no github.com origin' : 'there is no real test command yet, and a placeholder would fail every pull request'}. Run sawbuck contract --full again once it has one.\n`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

// a suggestion, not a rule: only a person should freeze product code
let files = [];
try { files = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n'); } catch { /* not a repo: attach says so */ }
const seen = new Set();
for (const f of files) { const m = f.match(/^(.*?(?:^|\/)(?:auth|authentication|billing|payments?|migrations))\//); if (m && !/(^|\/)(node_modules|test|tests|docs?|examples?|samples?|demos?|fixtures?)\//.test(m[1])) seen.add(m[1]); }
if (seen.size) process.stdout.write(`\n  To protect product code too, add these protected paths under "mandates" in promptwheel.config.json:\n${[...seen].slice(0, 5).map((d) => `    { "name": "${d.replace(/\W+/g, '-')}", "paths": ["${d}/**"], "reason": "changed by a person" }`).join('\n')}\n`);
if (!dry) {
  const hid = hiddenFromGit(repo);
  process.stdout.write(hid.length
    ? `\n${addByName(hid)}  Commit ${hid.length > 1 ? 'them' : 'it'}${full ? ' with the rest of what signing wrote' : ''}. Then sawbuck attach watches every turn: protected paths at turn end, each commit re-proved.\n`
    : `\n  Commit promptwheel.config.json and AGENTS.md${full ? ', promptwheel.lock.json and .promptwheel/packs/' : ''}. Then sawbuck attach watches every turn: protected paths at turn end, each commit re-proved.\n`);
}
