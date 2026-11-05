#!/usr/bin/env node
// sawbuck contract: one command that signs a repo to a working contract. Keeps whatever contract is already
// here, adds your tests and tripwires if there is none, then the supply-chain protections and the architecture
// lock. Zero-LLM. Re-running changes nothing. Protected product code (auth, billing) is suggested, never added:
// freezing those is a person's decision.
import { ensureExcluded } from './exclude.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PW } from './bins.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] || process.cwd();
const dry = process.argv.includes('--dry-run');
const strict = process.argv.includes('--strict');
const noCi = process.argv.includes('--no-ci');
// a new contract starts by watching: everyday change shows as a note. Protected paths, install scripts and sources
// outside the registry still fail from day one. --strict holds them all, and an existing contract is left as it is.
const REPORT = new Set(['dependency_entries', 'lock_drift', 'pins_changed', 'unpinned_execution', 'install_policy_gaps']);
const WORKFLOW = `# Written by sawbuck contract. Checks every pull request against the contract in promptwheel.config.json.
name: Sawbuck
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with: { fetch-depth: 0 }
      - uses: promptwheel-ai/promptwheel@v0
`;
const cfgPath = join(repo, 'promptwheel.config.json');
const run = (args, cwd, stdio = ['ignore', 'pipe', 'pipe']) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio });

// the preset as the engine writes it, in a scratch repo, so the contract and the engine cannot drift apart
const scratch = mkdtempSync(join(tmpdir(), 'sawbuck-contract-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: scratch, stdio: 'ignore' });
  writeFileSync(join(scratch, 'package.json'), '{"name":"scratch"}\n');
  run([PW, 'init', '--preset', 'supply-chain', '--no-agent-block'], scratch);
  const preset = JSON.parse(readFileSync(join(scratch, 'promptwheel.config.json'), 'utf8'));
  const had = existsSync(cfgPath);
  if (dry) {
    process.stdout.write(`sawbuck contract would ${had ? 'add to' : 'write'} ${cfgPath}: ${preset.metrics.length} guards and ${preset.mandates.length} protected-path rules, the scanners under .promptwheel/packs/, and promptwheel.lock.json.\n`);
  } else {
    if (!had) run([join(HERE, 'init.mjs'), '-y', '--no-investigate'], repo);
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : { repeat: 1, metrics: [] };
    const before = { m: (cfg.mandates || []).length, g: (cfg.metrics || []).length };
    const names = (l) => new Set((l || []).map((x) => x && x.name));
    const hasM = names(cfg.mandates), hasG = names(cfg.metrics);
    cfg.mandates = [...(cfg.mandates || []), ...preset.mandates.filter((m) => !hasM.has(m.name))];
    cfg.metrics = [...(cfg.metrics || []), ...preset.metrics.filter((m) => !hasG.has(m.name)).map((m) => (!strict && REPORT.has(m.name) ? { ...m, report: true } : m))];
    cfg.evaluatorPaths = [...new Set([...(cfg.evaluatorPaths || []), ...(preset.evaluatorPaths || [])])];
    cfg.allowTrailer = false;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    const pack = join(repo, '.promptwheel', 'packs', 'supply-chain');
    mkdirSync(pack, { recursive: true });
    cpSync(join(scratch, '.promptwheel', 'packs', 'supply-chain'), pack, { recursive: true });
    // the gate measures in clean worktrees, so the scanners must reach git. A repo attached earlier, or one that
    // ignores .promptwheel/ for the outcome record, would hide them and every guard would read unmeasurable.
    for (const f of [join(repo, '.gitignore'), resolve(repo, execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim())]) {
      if (!existsSync(f)) continue;
      const text = readFileSync(f, 'utf8');
      const next = text.replace(/^\.promptwheel\/?[ \t]*$/gm, '.promptwheel/*\n!.promptwheel/packs/');
      if (next !== text) writeFileSync(f, next);
    }
    ensureExcluded(repo);
    // CI goes in here, before the rules take hold: afterwards the contract itself would refuse an agent the file.
    // Only for a GitHub repo with a real test command: a placeholder would fail every pull request.
    const wf = join(repo, '.github', 'workflows', 'sawbuck.yml');
    let remote = ''; try { remote = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
    const realTests = !(cfg.metrics || []).some((m) => /set your test command/.test(String(m.cmd)));
    let ci = '';
    if (!noCi && /github\.com/.test(remote) && realTests && !existsSync(wf)) { mkdirSync(dirname(wf), { recursive: true }); writeFileSync(wf, WORKFLOW); ci = wf; }
    const locked = existsSync(join(repo, 'promptwheel.lock.json'));
    if (!locked) run([join(pack, 'lock.mjs'), 'write', repo], repo);
    const added = (cfg.mandates.length - before.m) + (cfg.metrics.length - before.g);
    process.stdout.write(added || !locked ? `sawbuck: signed. ${cfg.metrics.length} guards, ${cfg.mandates.length} protected-path rules, and the shape of this repo in promptwheel.lock.json.\n${strict ? '' : '  New dependencies and structure changes show as notes for now; protected paths and install scripts block. --strict blocks them all.\n'}${ci ? '  Added .github/workflows/sawbuck.yml, so pull requests are checked in CI.\n' : ''}` : 'sawbuck: already signed, nothing changed.\n');
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

// a suggestion, not a rule: only a person should freeze product code
let files = [];
try { files = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n'); } catch { /* not a repo: attach says so */ }
const seen = new Set();
for (const f of files) { const m = f.match(/^(.*?(?:^|\/)(?:auth|authentication|billing|payments?|migrations))\//); if (m && !/(^|\/)(node_modules|test|tests|docs?)\//.test(m[1])) seen.add(m[1]); }
if (seen.size) process.stdout.write(`\n  To protect product code too, add these to "mandates" in promptwheel.config.json:\n${[...seen].slice(0, 5).map((d) => `    { "name": "${d.replace(/\W+/g, '-')}", "paths": ["${d}/**"], "reason": "changed by a person" }`).join('\n')}\n`);
if (!dry) process.stdout.write('\n  Commit promptwheel.config.json, promptwheel.lock.json and .promptwheel/packs/. Then /sawbuck-reins:watch or sawbuck attach --claude arms it.\n');
