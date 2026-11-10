#!/usr/bin/env node
// sawbuck, the CLI. Zero-dep.
// `attach` wires the Claude Code hooks into a repo; `detach` removes them, and the record stays until `--purge`. The
// repo never imports Sawbuck. Rides two engines: promptwheel (the check) + @promptwheel/logbook.
//
// attach writes a receipt to .git/sawbuck/attach.json recording every file it created or modified. detach reads it and
// reverses exactly that, and still takes our hooks out when the receipt is lost; `detach --verify` proves the wiring is
// gone and names what is left; `doctor` runs what each hook runs.

import './pipe.mjs';
import { execFileSync } from 'node:child_process';
import { erasedBlock, erasedCommits } from './rewrites.mjs';
import { shareFinding } from './share.mjs';
import { ledgerCli } from './ledger.mjs';
import { ripplesReport } from './ripples.mjs';
import { profileCli } from './profile.mjs';
import { undoHook, undoCodex, undoCursor, EDIT_MATCHER } from './undo.mjs';
import { holdDecision } from './hold.mjs';
import { steersReport } from './steers.mjs';
import { rulesCli } from './rules.mjs';
import { shapeCli } from './shape.mjs';
import { ensureExcluded, clearExcluded, EXCLUDED, RECORD_DIRS } from './exclude.mjs';
import { repoState, hooksIn, OURS, S_START } from './repo-state.mjs';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, rmdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { basename, join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { PW } from './bins.mjs';
import { frameBlock, mandatesInForce, protectedDirty, protectedAmong, blobAt, lockState } from './contract.mjs';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const HOOK = join(HERE, 'sawbuck-hook.mjs');
// run the engine and parse its JSON verdict (it prints JSON even when it exits nonzero)
// A commit message is not a person: an agent can write a Sawbuck-Allow trailer, so no sawbuck path honors one
// (the Stop hook and the git hook do the same through reflect). `--allow` is the declared override.
function gateReport(repo, a) {
  let o = '', err = '', code = 0;
  try { o = execFileSync(process.execPath, [PW, ...a, '--no-record', '--json'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PROMPTWHEEL_NO_ALLOW_TRAILER: '1' }, timeout: +(process.env.SAWBUCK_CHECK_TIMEOUT_MS) || 120000 }); }
  catch (e) { o = (e.stdout || '').toString(); err = e.signal ? 'the check timed out' : (e.stderr || '').toString(); code = e.status || 0; }
  let rep = null; try { rep = JSON.parse(o.slice(o.indexOf('{'))); } catch {}
  // the engine's own reason, without its zero-config notice
  const why = err.split('\n').filter((l) => l.trim() && !/^no promptwheel\.config\.json, auto-gating/.test(l)).join(' ').trim();
  const plain = /Error: (this shell cannot write[^\n]*)/.exec(err);   // the engine's own sentence, without node's stack
  if (plain) return { rep, code, why: plain[1] };
  return { rep, code, why };
}
// why nothing could be measured, in words that match the case: no test command, tests red on both sides, or a
// win the source-only re-run could not apply. `sawbuck init` only where there is no config to edit yet.
// a setup command that failed, in words: "(exit 7) at the base and head refs: <its last line>". '' when setup worked.
const setupFailure = (rep) => { const s = rep && rep.setup; if (!s) return ''; const at = Object.keys(s), f = s[at[0]]; return `(exit ${f.exit}) at the ${at.join(' and ')} ref${at.length > 1 ? 's' : ''}${f.lastLine ? ': ' + f.lastLine : ''}`; };
function inconclusiveWhy(rep, repo) {
  const ms = (rep && rep.metrics) || [];
  const m = ms.find((x) => x.inert) || ms[0];
  if (ms.some((x) => x.unprovable)) return 'a win here could not be re-proved, because the source-only re-run did not apply. Do not trust this green on its own.';
  if (setupFailure(rep)) return `the setup command failed ${setupFailure(rep)}. Fix "setup" in promptwheel.config.json, then check again.`;
  const hasCfg = existsSync(join(repo, 'promptwheel.config.json'));
  let cmd = '';
  try { cmd = String((JSON.parse(readFileSync(join(repo, 'promptwheel.config.json'), 'utf8')).metrics || []).find((x) => x && x.name === (m && m.name))?.cmd || ''); } catch {}
  const placeholder = /set your test command/.test(cmd) || (!hasCfg && !detectedTests(repo));
  const where = hasCfg ? 'in promptwheel.config.json' : 'with `sawbuck init`, then in promptwheel.config.json';
  if (placeholder) return `there is no test command here, so nothing was measured. It finds npm, pytest, cargo and go tests on its own. Set yours ${where} (the cmd of "${(m && m.name) || 'tests_pass'}").`;
  // tests that import a built folder (dist, build) or a sibling package's built output need the build to run first
  let build = false; try { build = !!JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts?.build; } catch {}
  const needsBuild = !build ? '' : hasCfg ? ' This repo has a build script: if your tests need it, set "setup" to it in promptwheel.config.json.' : ' This repo has a build script, and tests often need it first: `sawbuck init` writes a config that runs it.';
  if (m && m.cause === 'too-much-output') return `your test command was stopped: ${m.detail}. Make it quieter, or point the check at a smaller command ${where}.`;
  if (m && m.cause === 'missing-dependency') return `the clean copy the check runs in is missing something your tests need: ${m.detail}. Link it with linkDirs, or install it with setup, ${where}.${needsBuild}`;
  return `your tests fail before and after this change, so there was no win or loss to measure ("${(m && m.name) || 'tests_pass'}"). Fix the failing tests first. If they pass for you, the clean copy the check runs in is missing something: set setup or linkDirs ${where}.${needsBuild}`;
}
// the test commands the engine finds with no config (promptwheel's detectTestCmd)
function detectedTests(repo) {
  const has = (f) => existsSync(join(repo, f));
  if (['go.mod', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'pytest.ini'].some(has)) return true;
  try { return !!JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts?.test; } catch { return false; }
}
// is the metric live (actually ran), or inert (never ran in isolation)?
const metricLive = (m) => !!m && !m.inert && m.status !== 'unmeasurable' && m.before != null;
const S_END = '# <<< sawbuck <<<';
const BLOCK_RE = new RegExp(`${S_START}[\\s\\S]*?${S_END}\\n?`, 'g');   // exactly what attach --git puts in, so taking it out leaves the bytes that were there

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
// `-n N` (status --log) is a flag with a value, not a repo path.
const positional = rest.filter((a, i) => !a.startsWith('--') && a !== '-n' && rest[i - 1] !== '-n');
const repoArg = () => resolve(positional[0] || '.');
const dry = flags.has('--dry-run');

let version = '0.0.0';
try { version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version; } catch {}

const help = `sawbuck ${version}: write down the rules your agent follows, and prove they held

Usage:
  sawbuck check [repo] [--base R --head R] [--repeat N] [--allow "<reason>"] [--json]
                            Verify your latest change right now (working tree if dirty, else the last
                            commit, or the range you name). Zero-config, no attach, no hook. The
                            fastest way to see it work. Every promptwheel run flag passes through.
                            Exit 0 pass (verified, held, or allowed) · 1 sent back (a regression or a
                            protected path) · 2 gamed · 3 inconclusive · 64 could not run
                            (--working with nothing uncommitted is 64 too)
  sawbuck init [--yes] [--wizard] [--no-investigate] [--no-agent-block] [--force]
                            Write promptwheel.config.json: your detected tests and the tripwires, with
                            notes from what your git history shows actually breaks, plus a short guide in
                            AGENTS.md (--no-agent-block to skip). Wizard in a terminal, non-interactive in
                            a pipe/CI (or --yes). An existing config needs --force.
  sawbuck attach [repo] [--user | --shared | --git | --codex | --cursor] [--dry-run]
                            Watch every Claude Code turn in this repo: protected paths at the end of each
                            turn, a source-only re-run on each commit. --user: every repo that has a
                            promptwheel.config.json. --shared: a tracked settings file a team commits.
                            --git: a post-commit hook, for any other agent or none (commits in a linked
                            worktree are not checked). --codex: the same hooks for Codex in
                            .codex/hooks.json (trust them once in Codex's /hooks). --cursor: the check and
                            the hold for Cursor in .cursor/hooks.json. --dry-run prints every file it would write
  sawbuck detach [repo] [--user] [--all] [--verify] [--purge] [--dry-run]
                            Remove the hooks (no flag: whatever is wired here; --all: every repo). The
                            record stays, kept out of git status; --purge deletes it. --verify proves the
                            wiring is gone and names what is left. --dry-run lists what would go
  sawbuck status [repo]     The inventory: caught over time + debt accruing now + whether it is armed. --json
                            --log [-n N] for the recent checks, newest first
  sawbuck debt [repo] [--since REF] [--fail-on undocumented|test|any|N]
                            The live suppression debt in HEAD, risk-ranked, undocumented flagged. --since REF
                            shows only what a branch adds; --fail-on exits 1 when that debt (or, without
                            --since, any live debt of that kind) is there (a CI gate)
  sawbuck context [repo]    Relevant history for the files you are changing (reverts, weakened tests, hot spots)
  sawbuck ledger [push|pull] [remote]
                            What git threw away, shared: push puts the erased attempts and their reasons on
                            refs/sawbuck/ledger for the team and CI; pull takes them into this clone; no
                            argument shows the counts
  sawbuck doctor [repo]     Run what each hook runs (project and user level) and say if it still works,
                            is incomplete, or is gone. --all lists every repo it is attached to and checks each
  sawbuck contract [--dry-run] [--full] [--strict]
                            Give this repo its rules: protected paths, the written rule, and your detected
                            tests when there is no config yet (--dry-run to preview). --full adds supply-chain
                            guards, the repo lock, and a CI check on a github.com repo with a real test
                            command; --strict makes them block
  sawbuck rules --prepare   Gather your messages on this machine so an agent can propose the rules you never wrote
  sawbuck rules --check F   Keep only proposed rules with 2 quotes that are really yours
  sawbuck undo --hook       The edit-tool hooks attach wires: an edit the person had undone in a session is kept, with their words, and shown with the prompt that names the file
  sawbuck hold --hook       The PreToolUse hook attach wires: a publish, release, merge, public comment or force push asks a person first
  sawbuck share --title T [text]  Hand a finding to the memory you run (claude-mem, Claude Code's notes, a Markdown folder), once
  sawbuck rules --notes     The notes Claude Code's own memory holds for this repo, to promote into its CLAUDE.md
  sawbuck shape --prepare   Gather a sample of your messages so an agent can label what you push on
  sawbuck shape --check F   Draw your steering shape from the labels, keeping only the totals (--png for an image)
  sawbuck steers            What you keep correcting, from the plugin's scratchpad on this machine (--json)
  sawbuck profile [export | import F]
                            Your machine-wide profile: personal rules (~/.claude/CLAUDE.md), holds
                            (~/.sawbuck/config.json), hooks, steering; export/import carries rules and holds
  sawbuck ripples [--all]   What happened after each steer here: commits, undos (whole or partial), the check's
                            verdicts, reverts, and whether you said it again (--json; --all for every repo)
  sawbuck statusline        One-line segment for your status line (watching | N caught)

  sawbuck --help | --version

Engines: promptwheel (the check) + @promptwheel/logbook (memory). Zero-LLM, offline, free.`;

const die = (msg) => { process.stderr.write(`sawbuck: ${msg}\n`); process.exit(1); };
const usage = (msg) => { process.stderr.write(`sawbuck: ${msg}\n`); process.exit(64); };   // could not run: never a verdict code
// the repository a path belongs to (its toplevel), so a command run from a subdirectory lands at the
// root: hooks pinned to the root, the receipt and the exclude under its git dir. '' outside a repo.
function gitTop(p) { try { return execFileSync('git', ['-C', p, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }
const repoRoot = () => gitTop(repoArg()) || repoArg();
// paths inside the repository's git dir, asked of git: a worktree or a submodule keeps its git dir
// elsewhere (.git is a FILE there), so join(repo, '.git', ...) is wrong in exactly the repos where it hurts
function gitPath(repo, rel) { try { return resolve(repo, execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { return join(repo, '.git', rel); } }
function gitDir(repo) { try { return resolve(repo, execFileSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { return join(repo, '.git'); } }
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
// `detach --dry-run` walks the same path as the real detach and lists what it would touch, so the two cannot drift.
// What a dry run "removed" reads as gone for the rest of the walk, so the steps that follow decide as they would for real.
const planned = { lines: new Map(), gone: new Set(), receipts: new Map(), registry: null };
const there = (p) => existsSync(p) && !planned.gone.has(p);
const say = (s) => { if (!dry) out(s); };

if (cmd === '--version' || cmd === '-v') { console.log(version); process.exit(0); }
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  out(flags.has('--all') ? help : `sawbuck ${version}: write down the rules your agent follows, and prove they held

  sawbuck contract   give this repo its rules: protected paths, your tests
  sawbuck check      verify your latest change right now
  sawbuck attach     make it automatic in Claude Code: protected paths each turn, every commit re-proved
  sawbuck status     what it has caught here

  sawbuck help --all   everything else`);
  process.exit(0);
}

// `sawbuck <command> --help`: that command's lines from the help, and nothing runs. Internal commands get the whole help.
if (rest.includes('--help') || rest.includes('-h')) {
  const own = []; let cur = null;
  for (const l of help.split('\n')) { const m = l.match(/^  sawbuck (\S+)/); if (m) cur = m[1]; else if (!/^ {20,}\S/.test(l)) cur = null; if (cur === cmd) own.push(l); }
  if (own.length || ['rank', 'frame', 'turn', '__hook'].includes(cmd)) { out(own.length ? `sawbuck ${version}\n\n${own.join('\n')}` : help); process.exit(0); }
}
// a flag a command does not know is an error, never a silent no-op. `check` is not here: it passes its flags to the
// engine, which refuses the ones it does not know. --claude is what older installs pass: taken, not listed.
const KNOWN = {
  contract: ['--dry-run', '--full', '--strict'],
  init: ['--yes', '-y', '--wizard', '--no-investigate', '--no-agent-block', '--force', '--preset'],
  attach: ['--user', '--shared', '--git', '--dry-run', '--claude', '--codex', '--cursor'],
  detach: ['--user', '--all', '--verify', '--purge', '--dry-run', '--claude', '--codex', '--cursor'],
  doctor: ['--all'],
  status: ['--json', '--log', '-n'],
};
if (KNOWN[cmd]) { const bad = rest.filter((a) => a.startsWith('-') && !KNOWN[cmd].includes(a)); if (bad.length) usage(`unknown flag ${bad.join(' ')} for ${cmd} (it takes ${KNOWN[cmd].filter((f) => f !== '--claude').join(', ')})`); }

switch (cmd) {
  case 'contract': {
    const top = gitTop(repoArg());
    if (!top) usage(`${repoArg()} is not a git repository (run it inside your project)`);
    try { execFileSync(process.execPath, [join(HERE, 'contract-cmd.mjs'), top, ...rest.filter((a) => KNOWN.contract.includes(a))], { stdio: 'inherit' }); }
    catch (e) { process.exit(e.status || 1); }
    break;
  }
  case 'init': {
    try { execFileSync(process.execPath, [join(HERE, 'init.mjs'), ...rest], { stdio: 'inherit' }); }
    catch (e) { process.exit(e.status || 1); }
    break;
  }
  case 'status': {
    // the inventory: one view unioning what the check has caught over time, what debt is accruing
    // now, and whether it is armed here. The "show me everything" face. --log is the recent feed.
    if (flags.has('--log')) { logReport(repoRoot(), rest); break; }
    try { execFileSync(process.execPath, [join(HERE, 'status.mjs'), '--repo', repoRoot(), ...rest.filter((a) => a.startsWith('--'))], { stdio: 'inherit' }); }
    catch (e) { process.exit(e.status || 1); }
    break;
  }
  case 'check': {
    // one-shot: gate your latest change right now (working tree if dirty, else the last commit),
    // zero-config (the engine finds npm, pytest, cargo and go tests), and say plainly whether the win was
    // earned. No attach, no hook, no record. The try-it-first on-ramp.
    // `sawbuck check` IS `promptwheel run` with a plain-spoken verdict: every engine flag passes
    // through (--base/--head/--repeat/--allow/--json/--no-detect-gaming), so there is one entry
    // point for a person and the engine stays the one for CI and libraries.
    const VALUE_FLAGS = new Set(['--base', '--head', '--repeat', '--allow']);
    const pass = []; const pos = []; let json = false, base = null, head = null;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--json') { json = true; continue; }
      if (VALUE_FLAGS.has(a)) { const v = rest[++i]; if (v == null) usage(`${a} needs a value`); if (a === '--base') base = v; else if (a === '--head') head = v; else pass.push(a, v); continue; }
      if (a.startsWith('--')) { pass.push(a); continue; }
      pos.push(a);
    }
    const repo = resolve(pos[0] || '.');
    // stderr ignored so a benign failing probe (e.g. rev-parse HEAD~1 on a one-commit repo) does not
    // leak a scary "fatal:" line before sawbuck's own message.
    const g = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
    // 64 (EX_USAGE) for every "could not run" below, never a verdict code: a script or CI must not read it as gamed (2).
    if (!g('rev-parse', '--git-dir')) { out(`sawbuck: ${repo} is not a git repo. The check re-proves a change against git history, so run it inside one (git init, then commit).`); process.exit(64); }
    if (!g('rev-parse', '--verify', 'HEAD')) { out('sawbuck: no commit yet. Make one, then `sawbuck check` verifies your next change against it.'); process.exit(64); }
    const uncommitted = g('status', '--porcelain').length > 0;
    const dirty = !base && !head && uncommitted;
    // --working on a clean tree would read the tree against the commit it already is, and call that held
    if (pass.includes('--working') && !uncommitted) { out('sawbuck: nothing uncommitted to check, the working tree is clean. `sawbuck check` verifies the last commit.'); process.exit(64); }
    // nothing to verify yet: a clean tree with no previous commit to diff against (a fresh repo). Say so
    // plainly instead of the generic "could not run" below, so the first run is not a dead end.
    if (!dirty && !base && !g('rev-parse', '--verify', 'HEAD~1')) { out('sawbuck: nothing to verify yet, the working tree is clean and this is the only commit. Make a change (or add one more commit), then `sawbuck check` re-proves the win from your source edits alone.'); process.exit(64); }
    const where = dirty ? 'working' : (base || head) ? `${base || 'HEAD~1'}..${head || 'HEAD'}` : 'last';
    const args = dirty ? ['run', '--working'] : ['run', '--base', base || 'HEAD~1', '--head', head || 'HEAD'];
    const { rep, code, why } = gateReport(repo, [...args, ...pass]);
    if (!rep || !rep.verdict) { out(`sawbuck: could not run the check here: ${why || 'the engine gave no verdict'}`); process.exit(64); }
    if (json) { out(JSON.stringify(rep)); process.exit(code); }
    const m = (rep.metrics || [])[0];
    for (const md of rep.mandates || []) out(`⛔ protected path "${md.name}" touched${md.reason ? ': ' + md.reason : ''}  (touched: ${(md.files || []).join(', ')})${md.removed ? '  [deleted in this same change; the rule stays in force for the change that removes it]' : ''}`);
    const win = (rep.metrics || []).find((x) => x.status === 'improved' && !x.tripwire);
    const noDetect = pass.includes('--no-detect-gaming');
    if (rep.verdict === 'pass' && rep.allowed) out(`✎ allowed with --allow: "${rep.allowed.reason}". That is a person's call, not a proof: ${(rep.allowed.cleared || []).join(', ') || 'the change'} was let through without a source-only re-proof.`);
    else if (rep.verdict === 'pass' && win && noDetect) out(`✓ passed: "${win.name}" improved, but gaming detection is off (--no-detect-gaming), so the win was not re-proved from the source.`);
    else if (rep.verdict === 'pass' && win) out(`✓ verified: your ${where} change earned it. "${win.name}" improved, and the source carried the win (it survives a source-only re-run).`);
    else if (rep.verdict === 'pass') out(`✓ held: nothing got worse in your ${where} change, and there was no win to re-prove.`);
    else if (rep.verdict === 'gamed') {
      out('🚩 gamed: a win here came from editing the test, config, or grader, not the source. It does NOT survive a source-only re-run, so it does not count.');
      if (((rep.gate && rep.gate.weakened) || []).some((w) => w.change === 'measurement-edited')) out('sawbuck: this change also edits how the check measures (setup, env or linkDirs in promptwheel.config.json), and a change is judged by the settings in force before it. Commit that edit on its own first, then check your fix again.');
      if (!dirty && /^(Sawbuck|Promptwheel)-Allow:/im.test(g('log', '--format=%B', `${base || 'HEAD~1'}..${head || 'HEAD'}`))) out('sawbuck: note: a Sawbuck-Allow trailer does not clear this, because an agent can write a commit message. A person passes --allow "<reason>".');
    }
    else if (rep.verdict === 'fail' && (rep.mandates || []).length) {
      out('✗ sent back: a protected path changed, however green the rest is.');
      // the way through, for a person who meant it: two of the default rules take a reason, the rest are lifted first
      const names = (l) => l.map((x) => `"${x.name}"`).join(', ');
      const soft = rep.mandates.filter((x) => x.allowable), hard = rep.mandates.filter((x) => !x.allowable);
      if (soft.length) out(`sawbuck: if a person meant this: sawbuck check --allow "<reason>" accepts ${names(soft)}, and the result shows the reason.`);
      if (hard.length) out(`sawbuck: ${names(hard)} ${hard.length > 1 ? 'take' : 'takes'} no --allow. To change that path on purpose, remove that rule from promptwheel.config.json in a commit of its own (that edit takes --allow), then make the change.`);
    }
    else if (rep.verdict === 'fail') out('✗ sent back: this change made something worse.');
    else out(`≈ inconclusive: ${inconclusiveWhy(rep, repo)}`);
    if (rep.verdict !== 'inconclusive' && setupFailure(rep)) out(`⚠ the setup command failed ${setupFailure(rep)}. The check still ran, so see whether "setup" in promptwheel.config.json is still right.`);
    if ((rep.metrics || []).some((x) => x.heldByTestEdit)) out('⚠ your tests changed too, and the old tests fail on this source. Fine for an intended change. Otherwise check the tests were not weakened: a green that stays green is not proved.');
    for (const x of rep.explained || []) out(`sawbuck: ${x.noted ? 'note' : 'needs a look'}: ${x.what}${x.items ? ': ' + x.items.join(', ') : ''}${!x.noted && x.allowable ? '. If you meant this: --allow "<reason>", or on a pull request comment sawbuck-allow: <reason>' : ''}`);
    if (rep.gate && rep.gate.changed) out(`⚠ the gate definition changed in this change (fingerprint ${rep.gate.fingerprint.base} -> ${rep.gate.fingerprint.head}): a metric, guard, evaluatorPath or mandate was added, removed or edited.`);
    process.exit(code);
  }
  case 'rank': {
    try { execFileSync(process.execPath, [join(HERE, 'rank.mjs'), ...rest], { stdio: 'inherit' }); }
    catch (e) { process.exit(e.status || 1); }
    break;
  }
  case 'debt': {
    // the whole-repo debt ledger: live suppressions still in HEAD, severity-split, worst-first.
    try { execFileSync(process.execPath, [join(HERE, 'debt.mjs'), ...rest], { stdio: 'inherit' }); }
    catch (e) { process.exit(e.status || 1); }
    break;
  }
  case 'context': {
    // Nothing to show stays off stdout: an older attach runs this on every prompt and adds its stdout to the prompt.
    // A person or an agent who ran it still learns why, on stderr.
    const root = repoRoot(); const o = contextBlock(root, flags.has('--speak'));
    if (o) out(o); else process.stderr.write(contextBlock(root, true) + '\n');
    break;
  }
  case 'frame': {
    // the prompt face of the contract: re-impress the hard rules (mandates, resolved through `extends`)
    // as one compact block at the live end of the context, so a deep or freshly compacted session
    // cannot forget them. Silent without a contract; --speak explains instead.
    const o = frameBlock(repoRoot());
    if (o) out(o);
    else if (flags.has('--speak')) out('sawbuck frame: no protected paths in promptwheel.config.json yet. Add one (a protected path) and this re-asserts it every turn and after every compaction, so a deep context cannot forget it.');
    break;
  }
  case 'turn': {
    // the ONE per-prompt hook. The agent gets the contract frame once a session and again after a compaction: one
    // written statement held in every bench, so saying it on each prompt only spends context. The relevant history
    // is on demand (`sawbuck context`), and per turn only with {"turn":{"context":true}} in sawbuck.config.json.
    // Wired by `attach` on UserPromptSubmit and after a compaction.
    // the repository the way the Stop hook sees it: the root of the cwd under user-level wiring (a
    // subdirectory belongs to its repo), the pinned path under project wiring; '' outside a repo
    const top = gitTop(repoArg());
    const repo = top || repoArg();
    // When a PROMPT begins (the UserPromptSubmit hook, never the SessionStart[compact] one, which
    // fires mid-turn), remember which protected paths were already dirty and what they held, so the
    // Stop hook's wall counts only what this turn changes and leaves a person's own edits alone.
    // Only under --hook (the wiring passes it) is stdin read for the hook's JSON, so a plain
    // `sawbuck turn` never waits on a pipe. Three rules keep the baseline honest: a new baseline is
    // taken only when the previous turn actually reached a Stop (an interrupt, a crash, or a re-run of
    // this command mid-turn leaves the last one standing, so nothing the agent left behind is adopted);
    // a file still carrying the content the last violation flagged is never baselined; and the
    // baseline's commit does not advance past a flagged commit until a clean stop or a commit the
    // person made between turns that no longer carries the flagged content.
    let hookEvent = '', session = '', framed = false, promptText = '';
    if (flags.has('--hook') && !process.stdin.isTTY) { try { const h = JSON.parse(readFileSync(0, 'utf8') || '{}'); hookEvent = String(h.hook_event_name || ''); session = String(h.session_id || ''); promptText = String(h.prompt || ''); } catch {} }
    if (hookEvent === 'UserPromptSubmit' && top) {
      try {
        ensureExcluded(repo);   // before the first write: under user-level hooks nothing else has done it yet
        const stDir = join(repo, '.sawbuck'); const stPath = join(stDir, 'state.json');
        let st = {}; try { st = JSON.parse(readFileSync(stPath, 'utf8')); } catch {}
        const now = new Date().toISOString();
        {   // a baseline even with no rules yet: a turn that signs a contract is judged by the contract it began with
          const prev = st.turnBaseline && typeof st.turnBaseline === 'object' ? st.turnBaseline : null;
          const stoppedSince = st.lastStopAt && st.lastPromptAt && Date.parse(st.lastStopAt) >= Date.parse(st.lastPromptAt);
          // a baseline attach wrote is not a prompt: it covers the turn that ran attach, if there was one. Set up from
          // a terminal, nothing is in flight, and the commits made before this prompt are the person's.
          const unfinished = !!prev && !!st.lastPromptAt && !stoppedSince && prev.by !== 'attach';
          if (!unfinished) {
            const flagged = (st.lastViolation && st.lastViolation.files && typeof st.lastViolation.files === 'object') ? st.lastViolation.files : {};
            const before = (st.lastViolation && st.lastViolation.before && typeof st.lastViolation.before === 'object') ? st.lastViolation.before : {};
            // the content is stored (hash-object -w), so a person's edit the agent later overwrites can
            // be restored by hash; a file still carrying the flagged content is baselined at the content
            // the person had before the agent touched it, or not at all
            const files = protectedDirty(repo, { store: true });
            for (const f of Object.keys(files)) if (flagged[f] === files[f]) { if (before[f] && before[f] !== 'deleted') files[f] = before[f]; else delete files[f]; }
            let sha = ''; try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
            // HEAD moved since the last Stop: the agent was not running, so the commits between turns
            // are the person's (accepting a change, a pull, a branch switch) and the baseline starts
            // there, UNLESS HEAD still carries a flagged file's content: then the pin holds (a commit
            // a background process landed after the Stop does not walk the agent's change through).
            const moved = !!(sha && st.lastStopHead && sha !== st.lastStopHead);
            const stillInHead = moved && Object.entries(flagged).some(([f, h]) => { const b = blobAt(repo, sha, f); return h === 'deleted' ? b === '' : (!!h && b === h); });
            const pin = !!(st.lastViolation && st.lastViolation.sha);
            if (moved && !stillInHead && st.lastViolation) delete st.lastViolation.sha;
            st.turnBaseline = { at: now, sha: ((!moved || stillInHead) && pin && st.lastViolation.sha) || sha, files, lock: lockState(repo), rules: mandatesInForce(repo), refs: refTips(repo) };
          }
        }
        framed = !!session && st.framedSession === session;
        if (session) st.framedSession = session;
        st.lastPrompt = promptText.replace(/\s+/g, ' ').trim().slice(0, 240);   // the person's words, for an undo record (local, git-excluded)
        st.lastPromptAt = now;   // every prompt, mandates or not: the walls key their block budgets on it when the harness sends no prompt_id
        mkdirSync(stDir, { recursive: true }); writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n');
      } catch { /* the frame never fails a prompt */ }
    }
    let history = false;
    try { history = JSON.parse(readFileSync(join(repo, 'sawbuck.config.json'), 'utf8')).turn?.context === true; } catch {}
    if (!history && top) erasedCommits(repo);   // the ledger outlives the reflog whether or not it is printed
    // The files a prompt names get the history a rewrite erased (a revert and its reason) WITH the prompt, before any
    // edit, whether or not per-turn history is on. Measured (proof-bench/twin, 2026-11-08): shown this way, 0 of 27
    // redid a reverted change and 27 of 27 asked first; on demand after the first edit, the agent checked once per
    // session and redid it 27 of 27; shown after the edit, 0 blind but only 19 of 27 held. Timing is the product.
    const named = hookEvent === 'UserPromptSubmit' && top ? namedFiles(repo, promptText) : [];
    const o = [framed ? '' : frameBlock(repo), history ? contextBlock(repo, false, named) : (named.length ? erasedBlock(repo, named) : '')].filter(Boolean).join('\n');
    if (o) out(o);
    break;
  }
  case '__hook': {
    if (rest.includes('codex')) {
      // Codex reads Stop's stdout as JSON only; a plain line from the hook becomes a systemMessage
      let o = ''; try { o = execFileSync(process.execPath, [HOOK, ...rest], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }); } catch (e) { o = String(e.stdout || ''); }
      o = o.trim(); if (o) process.stdout.write(o.startsWith('{') ? o : JSON.stringify({ systemMessage: o }));
      break;
    }
    try { execFileSync(process.execPath, [HOOK, ...rest], { stdio: 'inherit' }); } catch (e) { process.exit(e.status || 0); }
    break;
  }
  case 'attach': {
    const user = flags.has('--user'), shared = flags.has('--shared'), git = flags.has('--git'), codex = flags.has('--codex'), cursor = flags.has('--cursor');
    if (user + shared + git + codex + cursor > 1) usage('attach takes one of --user, --shared, --git, --codex or --cursor');
    const top = gitTop(repoArg());
    if (!top && !user) usage(`${repoArg()} is not a git repository (attach wires one; run it inside your project, or name its path)`);
    const repo = top || repoArg();
    if (codex) { wireCodex(repo); break; }
    if (cursor) { wireCursor(repo); break; }
    if (git) wireGit(repo); else wireClaude(repo, { user, shared });
    if (!dry) verifyAttach(repo);
    break;
  }
  case 'detach': {
    const purge = flags.has('--purge');
    if (flags.has('--all')) detachAll(purge);
    else {
      const repo = repoRoot();
      if (flags.has('--user')) unwireClaude(repo, { user: true });
      else if (flags.has('--claude')) unwireClaude(repo, {});
      else if (flags.has('--codex')) unwireCodex(repo);
      else if (flags.has('--cursor')) unwireCursor(repo);
      else {
        // no flag: take out whatever is wired in this repo, older git hooks included. The receipt says what attach
        // wrote; our hooks in the project settings or the post-commit hook count without one, so a lost receipt or a
        // teammate's clone of a --shared repo is not left wired.
        const a = readManifest(manifestPath(repo)).attachments || {};
        const hasClaude = !!(a.claude || a['claude-shared']) || [false, true].some((shared) => hooksIn(claudeFile(repo, { shared }).f));
        if (hasClaude) unwireClaude(repo, {});
        if (a.git || hasBlock(repo) || !hasClaude) unwireGit(repo);
        unwireCodex(repo, { quiet: true }); unwireCursor(repo, { quiet: true });
      }
      if (purge) purgeRecord(repo); else markDetached(repo, true);   // the dry run lists the mark like every other change   // the record stays and says it is detached, so nothing reads it as watching
      syncExclude(repo, readManifest(manifestPath(repo)));   // after a purge the exclude lines go too
      const left = recordLeft(repo);
      if (left.length) say(`sawbuck: still on disk: ${left.join(', ')}. It is the record, kept out of git status; \`sawbuck detach --purge\` removes it.`);
      if (flags.has('--verify') && !dry) verifyClean(repo);
    }
    if (dry) out(dryText([...planned.lines.values()], 'remove'));
    break;
  }
  case 'doctor': { if (flags.has('--all')) doctorAll(); else doctorRepo(repoRoot()); break; }
  case 'rules': { out(rulesCli(rest, { repo: gitTop(process.cwd()) || process.cwd() })); break; }
  case '__cursor': {
    // Cursor's hooks (cursor.com/docs/hooks) carry other names and shapes; this adapter turns each into the Claude Code
    // form our hooks already speak, and the answer back. Cursor cannot add context to a prompt, so the prompt hook only
    // records the turn's baseline and the person's words; the rules reach the agent through AGENTS.md and .cursorrules.
    const [ev, r0] = rest.filter((a) => !a.startsWith('--')); const r = gitTop(r0 || '.') || r0 || process.cwd();
    let h = {}; if (!process.stdin.isTTY) { try { h = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch {} }
    const session = String(h.conversation_id || h.session_id || 'cursor');
    const call = (args, input) => { try { return execFileSync(process.execPath, [SELF, ...args], { encoding: 'utf8', input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { return String(e.stdout || ''); } };
    if (ev === 'beforeSubmitPrompt') { call(['turn', '--hook', r], { hook_event_name: 'UserPromptSubmit', prompt: String(h.prompt || ''), session_id: session, cwd: r }); out(JSON.stringify({ continue: true })); break; }
    if (ev === 'stop') {
      if ((h.loop_count || 0) >= 3) { out('{}'); break; }   // the same budget as Claude Code: three send-backs, then the turn ends
      const o = call(['__hook', '--repo', r, '--by', 'cursor', '--stop'], { hook_event_name: 'Stop', session_id: session, cwd: r }).trim();
      let j = null; try { j = JSON.parse(o); } catch {}
      out(JSON.stringify(j && j.decision === 'block' ? { followup_message: j.reason } : {})); break;
    }
    if (ev === 'beforeShellExecution') {
      const d = holdDecision(JSON.stringify({ tool_name: 'Bash', tool_input: { command: String(h.command || '') } }), r);
      const why = d && d.hookSpecificOutput && d.hookSpecificOutput.permissionDecisionReason;
      out(JSON.stringify(why ? { permission: 'ask', user_message: why, agent_message: why } : { permission: 'allow' })); break;
    }
    if (ev === 'afterFileEdit') {
      const e = undoCursor(JSON.stringify(h), r);
      if (e) shareFinding(r, { kind: 'undone', title: `${e.kind === 'part' ? 'partly undone' : 'undone'}: ${e.first || e.file} in ${e.file}`, text: e.why || '', files: [e.file] }).catch(() => {});
      out('{}'); break;
    }
    out('{}'); break;
  }
  case 'hold': {
    // the PreToolUse hook attach wires on Bash: an outward command (publish, release, merge, public comment, force push)
    // becomes a question to the person; everything else passes. Reads the hook's JSON on stdin only under --hook.
    let body = ''; if (flags.has('--hook') && !process.stdin.isTTY) { try { body = readFileSync(0, 'utf8'); } catch {} }
    let d = holdDecision(body, gitTop(repoArg()) || repoArg());
    // Codex parses "ask" but does not support it yet (the call would go through): under --codex the hold denies,
    // and the reason tells the agent a person runs this one
    if (d && flags.has('--codex') && d.hookSpecificOutput) d = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${d.hookSpecificOutput.permissionDecisionReason} Codex cannot ask here, so the hold stops it: tell the person, and they run it themselves.` } };
    if (d) out(JSON.stringify(d));
    break;
  }
  case 'undo': {
    // the undo ledger's hook, wired by attach on PreToolUse and PostToolUse for the edit tools. Before an edit: snapshot
    // the file once per session. After one: a file back at its snapshot, after a change and after a word from the person,
    // is an undo; it is recorded with what the change had added and the person's words, and handed to the memory sinks.
    let body = ''; if (flags.has('--hook') && !process.stdin.isTTY) { try { body = readFileSync(0, 'utf8'); } catch {} }
    const r = gitTop(repoArg()) || repoArg();
    const found = flags.has('--codex') ? undoCodex(body, r) : [undoHook(body, r)].filter(Boolean);
    for (const e of found) shareFinding(r, { kind: 'undone', title: `${e.kind === 'part' ? 'partly undone' : 'undone'}: ${e.first || e.file} in ${e.file}`, text: e.why || `An edit to ${e.file} was undone at the person's request.`, files: [e.file] }).catch(() => {});
    break;
  }
  case 'share': {
    // a finding (a rule you accepted, a reverted attempt, a gamed green) handed to whatever memory runs on this machine, once
    const take = (flag) => { const k = rest.indexOf(flag); return k > -1 ? rest[k + 1] : ''; };
    const title = take('--title'); const kind = take('--kind') || 'rule'; const to = take('--to'); const files = take('--files');
    const skip = new Set(['--title', '--kind', '--to', '--files'].flatMap((f) => { const k = rest.indexOf(f); return k > -1 ? [k, k + 1] : []; }));
    const text = rest.filter((a, k) => !skip.has(k) && !a.startsWith('--')).join(' ');
    if (!title) usage('share needs --title "<the rule or lead>" and, after it, the words behind it (--kind rule|revert|gamed, --to claude-mem,auto-memory,markdown, --files a,b)');
    const here = gitTop(process.cwd()) || process.cwd();   // the words after --title are the text, never a repo path
    shareFinding(here, { kind, title, text, files: files ? files.split(',') : [] }, { to: to ? to.split(',') : null }).then((rs) => {
      for (const r of rs) { if (r.where) out(`sawbuck: shared "${title}" with ${r.sink} (${r.where})`); else process.stderr.write(`sawbuck: not shared with ${r.sink}: ${r.skipped}\n`); }
    });
    break;
  }

  case 'ledger': {
    // push | pull | nothing, then an optional remote: the words are subcommands, never a repo path; the repo is where you stand
    const r = ledgerCli(rest, gitTop(process.cwd()) || process.cwd()); out(r.text); if (r.code) process.exitCode = r.code; break;
  }
  case 'shape': { out(shapeCli(rest)); break; }
  case 'steers': { out(steersReport({ json: flags.has('--json') })); break; }
  case 'profile': { const r = profileCli(rest); out(r.text); if (r.code) process.exitCode = r.code; break; }
  case 'ripples': { out(ripplesReport({ json: flags.has('--json'), repo: flags.has('--all') ? null : (gitTop(process.cwd()) || null) })); break; }
  case 'statusline': {
    // compact status-line segment for the cwd repo. Never throws; fast.
    try {
      const repo = gitTop(process.cwd());
      if (!repo) process.stdout.write('sawbuck · no repo here');
      if (repo) {
        const name = basename(repo);
        const { caught, state, steer } = repoState(repo);
        // the last verdict from the activity feed (includes verified passes), so you see it working each turn
        let last = '';
        try { const L = readFileSync(join(repo, '.sawbuck', 'activity.jsonl'), 'utf8').trim().split('\n'); const e = JSON.parse(L[L.length - 1]); last = { verified: '✓', gamed: '🚩', regression: '✗', inconclusive: '≈', allowed: '✎' }[e.kind] || ''; } catch {}
        const label = caught > 0 ? `${caught} caught` : state;
        const seg = label ? `sawbuck · ${label}` : '';
        const named = label ? `sawbuck · ${name} · ${label}` : '';   // which repo it detected, in the default line
        const base = named ? (last ? `${named} · ${last}` : named) : '';
        // live steering % from the reins engine's file (OFFLINE read; reins does the LLM work, never sawbuck)
        const st = steer ? `steer ${steer.rate}%` : '';
        // configurable template: SAWBUCK_STATUSLINE picks which segments show and in what order
        // (tokens {status} {sawbuck} {repo} {verdict} {steer} plus any literal text); empty tokens collapse
        // so you never get a dangling separator. Unset = the default composition. Mix in other
        // tools (git branch, model, your own adapters) by composing in your statusline script.
        const tpl = process.env.SAWBUCK_STATUSLINE;
        let outp;
        if (tpl && tpl.trim()) {
          const tok = { status: base, sawbuck: seg, repo: label ? name : '', verdict: last, steer: st };
          outp = tpl.replace(/\{(status|sawbuck|repo|verdict|steer)\}/g, (_, k) => tok[k] || '')
                    .replace(/\s*·\s*·\s*/g, ' · ').replace(/^\s*·\s*/, '').replace(/\s*·\s*$/, '').replace(/\s{2,}/g, ' ').trim();
        } else {
          outp = [base, st].filter(Boolean).join(' · ');
        }
        if (outp) process.stdout.write(outp);
      }
    } catch {}
    break;
  }
  default: die(`unknown command '${cmd}'\n\n${help}`);
}

function logReport(repo, rest) {
  let lines = [];
  try { lines = readFileSync(join(repo, '.sawbuck', 'activity.jsonl'), 'utf8').split('\n').filter(Boolean); } catch {}
  if (!lines.length) { out('sawbuck: no activity recorded yet (the check logs here on each commit/turn).'); return; }
  const ni = rest.indexOf('-n');
  const n = ni > -1 ? (parseInt(rest[ni + 1], 10) || 20) : 20;
  const icon = { verified: '✓', gamed: '🚩', regression: '✗', inconclusive: '≈', allowed: '✎', mandate: '⛔' };
  const recent = lines.slice(-n).reverse();
  out(`sawbuck activity (last ${recent.length}):`);
  for (const l of recent) {
    try {
      const e = JSON.parse(l);
      out(`  ${(e.at || '').slice(0, 16).replace('T', ' ')}  ${icon[e.kind] || '·'} ${String(e.kind).padEnd(11)} ${e.file || ''}${e.reason ? '   ' + e.reason : ''}`);
    } catch {}
  }
}

// --- context: the ranked history for the files in hand, on demand ---------------------------
// the read face: ranked relevant history for what you're working on right now. Silent when there is
// nothing to say, so it is safe on every UserPromptSubmit (that hook's stdout is injected into context;
// "nothing notable" every turn would be noise). `speak` forces a reply for the explicit command.
// the files a prompt names: "src/cache.js" as written, or a bare "cache.js" when exactly one file has that name. A file
// counts when it is tracked, on disk, or in the ledger of erased commits (a reverted file is gone from the tree, and
// re-creating it is the case the history is for). Quotes and backticks around a path are not part of it. At most 8.
function namedFiles(repo, text) {
  if (!text) return [];
  const toks = [...new Set((text.match(/[\w./-]+\.[A-Za-z0-9]{1,8}/g) || []).map((t) => t.replace(/^\.\//, '').replace(/[.,;:]+$/, '')))];
  if (!toks.length) return [];
  let known = []; try { known = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch {}
  try { for (const e of erasedCommits(repo)) for (const f of e.files || []) if (!known.includes(f)) known.push(f); } catch {}
  const out = [];
  for (const t of toks) {
    if (out.length === 8) break;
    if (known.includes(t) || (existsSync(join(repo, t)) && !relative(repo, join(repo, t)).startsWith('..'))) { if (!out.includes(t)) out.push(t); continue; }
    if (!t.includes('/')) { const m = known.filter((f) => f === t || f.endsWith('/' + t)); if (m.length === 1 && !out.includes(m[0])) out.push(m[0]); }
  }
  return out;
}

function contextBlock(repo, speak, extra = []) {
  const g = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  // new files count: re-creating what was reverted is the case the history is for
  let changed = [...new Set([...g('diff', '--name-only', 'HEAD').split('\n'), ...g('ls-files', '--others', '--exclude-standard').split('\n')])].filter(Boolean);
  if (!changed.length) changed = g('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean);
  changed = [...new Set([...changed, ...extra])];   // and the files the prompt names, so their past arrives before the edit
  if (!changed.length) return speak ? 'sawbuck: nothing changed to look up (no working edits, and no previous commit to read).' : '';
  const fileArgs = changed.flatMap((f) => ['--file', f]);
  let o = '';
  try { o = execFileSync(process.execPath, [join(HERE, 'rank.mjs'), '--repo', repo, ...fileArgs, '--top', '3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { o = (e.stdout || '').toString(); }
  const erased = erasedBlock(repo, changed);
  if (/relevant history/.test(o)) return [o.trimEnd(), erased].filter(Boolean).join('\n');
  if (erased) return erased;
  return speak ? 'sawbuck: no notable history for the files you are touching (a clean trail).' : '';
}

// after attach, prove the check can actually measure something here (the inert-metric trap):
// run the gate on the last commit and say what it can or cannot measure, so you never attach
// into silent nothing. Best-effort and bounded; the wire already succeeded regardless.
function verifyAttach(repo) {
  // stderr ignored: a benign failing probe (rev-parse HEAD~1 on a one-commit repo) must not leak a "fatal:" line
  const g = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  if (!g('rev-parse', 'HEAD')) { out('   attached. Make a commit, then run `sawbuck check` to see it work.'); return; }
  out('   verifying I can measure here (one-time)...');
  const base = g('rev-parse', '--verify', 'HEAD~1') ? 'HEAD~1' : 'HEAD';
  const { rep } = gateReport(repo, ['run', '--base', base, '--head', 'HEAD']);
  const m = rep && (rep.metrics || [])[0];
  if (metricLive(m)) out(`   ✓ I can measure "${m.name}" here. On each commit I'll verify a win survived a source-only re-run, and flag it if it did not.`);
  else out(`   ⚠ I could not measure anything here yet: ${rep ? inconclusiveWhy(rep, repo) : 'the check did not run'}`);
}

// --- the attach receipt (out of the worktree, inside .git) ------------------
function manifestPath(repo) { return join(gitDir(repo), 'sawbuck', 'attach.json'); }
function userManifestPath() { return join(homedir(), '.sawbuck', 'user-attach.json'); }
function readManifest(p) { if (planned.receipts.has(p)) return planned.receipts.get(p); try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { version: 1, attachments: {} }; } }
function writeManifest(p, m) {
  if (dry) planned.receipts.set(p, m);
  if (!Object.keys(m.attachments || {}).length) { dropFile(p, 'the attach receipt'); rmIfEmptyDir(dirname(p)); return; }
  putFile(p, JSON.stringify(m, null, 2) + '\n', 'the attach receipt');
}

// Every write and removal on the detach path goes through these two: under --dry-run each is listed instead of done.
function putFile(f, text, what) {
  if (dry) { planned.lines.set(f, `modify  ${f}  (${what})`); return; }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}
function dropFile(p, what) {
  if (!there(p)) return;
  if (dry) { planned.lines.set(p, `delete  ${p}  (${what})`); planned.gone.add(p); return; }
  try { rmSync(p, { recursive: true, force: true }); } catch {}
}
function rmIfEmptyDir(d) { if (dry) return; try { if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d); } catch {} }
// --- .git/info/exclude: keep the worktree clean without touching .gitignore --
// Any attachment keeps the block, the last one out takes it. Returns whether the file changed.
function excludeFile(repo) { return gitPath(repo, 'info/exclude'); }
// The lines stay while the record they hide is still on disk: clearing them would put .sawbuck/ in git status and a
// signed repo would fail its own hooks-frozen rule over Sawbuck's record. --purge deletes the record, then the lines.
function syncExclude(repo, manifest) {
  const changed = Object.keys(manifest.attachments || {}).length ? ensureExcluded(repo, dry) : hiddenLeft(repo).length ? false : clearExcluded(repo, dry);
  if (dry && changed) planned.lines.set(excludeFile(repo), `modify  ${excludeFile(repo)}  (the lines that keep the record out of git status)`);
  return changed;
}
// the record paths still on disk and not tracked (a committed LOGBOOK.md is the person's file)
function recordLeft(repo) {
  const tracked = (p) => { try { return !!execFileSync('git', ['-C', repo, 'ls-files', '--', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return false; } };
  return ['.sawbuck/', '.promptwheel/outcomes.jsonl', 'events.jsonl', 'annotations.jsonl', 'LOGBOOK.md', 'JOURNEY.md'].filter((p) => there(join(repo, p)) && !tracked(p));
}
// what the block hides that is still there: the record, and a settings.local.json the person keeps
function hiddenLeft(repo) {
  const local = join(repo, '.claude', 'settings.local.json');
  let own = false; try { own = there(local) && !execFileSync('git', ['-C', repo, 'ls-files', '--', '.claude/settings.local.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  return [...recordLeft(repo), ...(own ? ['.claude/settings.local.json'] : [])];
}

// --- git post-commit (attach --git) -----------------------------------------
// For any agent or none: every commit is checked, whatever made it. The hook prefers a `sawbuck` on PATH (so it
// survives a reinstall), then the absolute path of the sawbuck that attached, then the same version through npx.
function hookBlock(repo) {
  const r = JSON.stringify(repo);
  // git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE into its hooks. The check shells out to git and would
  // inherit them, operate on the wrong repo, and silently catch nothing. Clear them first, in a subshell: the block
  // sits above the person's own hook lines, and those keep what git gave them.
  return `${S_START}\n(unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_COMMON_DIR\nif command -v sawbuck >/dev/null 2>&1; then sawbuck __hook --repo ${r}; elif [ -f ${JSON.stringify(SELF)} ]; then ${nodeCmd()} ${JSON.stringify(SELF)} __hook --repo ${r}; else npx -y sawbuck@${version} __hook --repo ${r}; fi) || true\n${S_END}\n`;
}
// The first commit after attach is checked only if there is a commit to check it from: HEAD as it stands now.
// A baseline other hooks are keeping (Claude hooks wired here or at user level, a turn in flight) is left alone;
// one left behind by an attachment that is gone is not, or commits made while nothing watched would be laid on the next one.
function gitBaseline(repo) {
  let sha = ''; try { sha = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  const path = join(repo, '.sawbuck', 'state.json');
  let st = {}; try { st = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const kept = (st.lastSha || (st.turnBaseline && st.turnBaseline.sha)) && (Object.keys(readManifest(manifestPath(repo)).attachments || {}).length || hooksIn(claudeFile(repo, { user: true }).f));
  return { path, st, sha: kept ? '' : sha };
}
function wireGit(repo) {
  const pc = gitPath(repo, 'hooks/post-commit');
  // core.hooksPath inside the work tree (the husky way): the team tracks those files or a hook tool rewrites them, and
  // our block pins this machine's paths. Refuse, and give the portable line a person can add.
  if (!relative(repo, pc).startsWith('..') && relative(gitDir(repo), pc).startsWith('..')) usage(`git hooks here live in ${relative(repo, dirname(pc))}/, inside the work tree (core.hooksPath), where the team or a hook tool owns the files, so attach --git writes nothing. Use plain \`sawbuck attach\`, or add this line by hand to the post-commit hook kept there (with husky: .husky/post-commit): (unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_COMMON_DIR; npx -y sawbuck@${version} __hook --repo "$PWD") || true`);
  const existed = existsSync(pc);
  const was = existed ? readFileSync(pc, 'utf8') : '';
  if (was.includes(S_START)) { out(`sawbuck: already attached (git) in ${repo}`); return; }
  // our block is shell, and git only runs an executable hook: a hook in another language, or one git is not running,
  // is left exactly as it is
  if (existed && was.startsWith('#!') && !/^#!\s*\S*\/(env\s+)?(ba|da|z|k)?sh\b/.test(was.split('\n')[0])) usage(`the post-commit hook here is not a shell script (${was.split('\n')[0]}). Add this line to it by hand: npx -y sawbuck@${version} __hook`);
  if (existed && process.platform !== 'win32') { let x = false; try { x = !!(statSync(pc).mode & 0o111); } catch {} if (!x) usage(`the post-commit hook here is not executable, so git does not run it. Make it executable (chmod +x ${relative(repo, pc)}) or remove it, then run attach --git again.`); }
  // Our block goes right after the shebang line, so a hook that ends in `exit 0` still reaches it. The receipt notes
  // the shebang or the newline we had to add, so detach leaves a hook that was here before byte for byte as it was.
  const shebang = !was.startsWith('#!'), nl = !shebang && !was.includes('\n');
  const body = (shebang ? '#!/bin/sh\n' : '') + was + (nl ? '\n' : '');
  const at = body.indexOf('\n') + 1;
  const mp = manifestPath(repo), base = gitBaseline(repo);
  if (dry) {
    out(dryText([
      `${existed ? 'modify' : 'create'}  ${pc}  (post-commit hook block)`,
      ensureExcluded(repo, true) ? `exclude ${excludeFile(repo)}  (${EXCLUDED.join(', ')})` : null,
      `${existsSync(mp) ? 'modify' : 'create'}  ${mp}  (attach receipt)`,
      base.sha ? `write   ${base.path}  (the commit to check from, so the first commit after this is checked)` : null,
      `write   ${regPath()}  (the list of attached repos, for detach --all)`,
    ].filter(Boolean)));
    return;
  }
  writeFileSync(pc, body.slice(0, at) + hookBlock(repo) + body.slice(at));
  chmodSync(pc, 0o755);
  const m = readManifest(mp);
  m.attachments = { ...m.attachments, git: { pc: { created: !existed, ...(existed && shebang ? { shebang } : {}), ...(nl ? { nl } : {}) } } };
  syncExclude(repo, m);
  writeManifest(mp, m);
  if (base.sha) { try { mkdirSync(dirname(base.path), { recursive: true }); writeFileSync(base.path, JSON.stringify({ turns: 0, shownTotal: 0, ...base.st, lastSha: base.sha }, null, 2) + '\n'); } catch {} }
  regAdd(repo, 'git');
  out(`sawbuck: attached (git post-commit) in ${repo}. Every commit is checked, whatever made it.`);
}
function hasBlock(repo) { try { return readFileSync(gitPath(repo, 'hooks/post-commit'), 'utf8').includes(S_START); } catch { return false; } }
function unwireGit(repo) {
  const pc = gitPath(repo, 'hooks/post-commit');
  const m = readManifest(manifestPath(repo));
  const rec = m.attachments?.git;
  const wired = hasBlock(repo);
  // signing with no attach still hides the record, so a repo with no receipt can have a block to take back
  if (!wired && !rec) { say(syncExclude(repo, m) ? `sawbuck: removed the record lines from ${excludeFile(repo)}` : 'sawbuck: nothing to detach'); return; }
  if (wired) {
    // take out what attach put in, and nothing else: a hook that was here before is the same bytes again
    let rest = readFileSync(pc, 'utf8').replace(BLOCK_RE, '');
    if (rec?.pc?.shebang && rest.startsWith('#!/bin/sh\n')) rest = rest.slice('#!/bin/sh\n'.length);
    if (rec?.pc?.nl && rest.endsWith('\n')) rest = rest.slice(0, -1);
    // true inverse: if we created this hook and it is trivial again, remove it
    if ((rec?.pc?.created || !rec) && isTrivialHook(rest)) dropFile(pc, 'the post-commit hook attach created');
    else putFile(pc, rest, 'our block in the post-commit hook');
  }
  if (rec) { delete m.attachments.git; syncExclude(repo, m); writeManifest(manifestPath(repo), m); }
  regRemove(repo, 'git');
  say(`sawbuck: detached (git) from ${repo}`);
}
function isTrivialHook(text) { return text.replace(/^#!.*\n?/, '').trim() === ''; }

// --- Claude Code hooks ------------------------------------------------------
// user-level hooks (~/.claude) target the repo by cwd; project hooks pin the repo.
// Project default writes the gitignored settings.local.json. --shared writes the tracked settings.json for a team:
// its hooks run the pinned version through npx and find the repo from where they run, so the file holds no path from
// this machine, and removing the hooks shows in git. Safe merge; refuses malformed JSON; idempotent.
function claudeFile(repo, { user, shared }) {
  const dir = join(user ? homedir() : repo, '.claude');
  const name = user || shared ? 'settings.json' : 'settings.local.json';
  return { dir, f: join(dir, name) };
}
// hooks run under /bin/sh, which does not load nvm, so a bare `node` is missing on many machines and the
// hook fails quietly, leaving the wall off. Use node from PATH when there is one (it follows an upgrade),
// else the node that ran this attach. Windows keeps plain node: its hooks do not run under sh.
export function nodeCmd(execPath = process.execPath, platform = process.platform) {
  if (platform === 'win32') return 'node';
  return `"$(command -v node || echo ${JSON.stringify(execPath).replace(/^"|"$/g, "'")})"`;
}
function wireClaude(repo, opts) {
  const { user, shared } = opts;
  // user-level hooks already cover every repo; a second set would run each check twice and spend the
  // send-back budget twice as fast. --shared is a deliberate team file, so it is written anyway.
  if (!user && !shared) {
    const uf = claudeFile(repo, { user: true }).f;
    try { if (OURS.test(readFileSync(uf, 'utf8'))) { out(`sawbuck: already watching here through your user-level hooks (${uf}); nothing to add${existsSync(join(repo, 'promptwheel.config.json')) ? '' : '. The check runs here once this repo has its rules: sawbuck contract'}`); return; } } catch {}
  }
  const { dir, f } = claudeFile(repo, opts);
  const dirExisted = existsSync(dir);
  const fileExisted = existsSync(f);
  let cfg = {};
  if (fileExisted) { try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { die(`${f} exists but is not valid JSON; I will not overwrite it. Add the hooks by hand.`); } }
  // run through npx, the installed path lives in a cache that can be cleared, and a missing hook fails quietly and
  // leaves the wall off: fall back to fetching the same version
  const run = (args) => {
    if (shared) return `npx -y sawbuck@${version} ${args}`;
    const direct = `${nodeCmd()} ${JSON.stringify(SELF)} ${args}`;
    return process.platform !== 'win32' && SELF.includes('/_npx/') ? `if [ -f ${JSON.stringify(SELF)} ]; then ${direct}; else npx -y sawbuck@${version} ${args}; fi` : direct;
  };
  const here = user || shared;   // no repo path in the command: the hook works out the repo from where it runs
  const ctx = run(here ? 'turn --hook' : `turn --hook ${JSON.stringify(repo)}`);
  const chk = run(here ? '__hook --by claude --stop' : `__hook --repo ${JSON.stringify(repo)} --by claude --stop`);
  const hold = run(here ? 'hold --hook' : `hold --hook ${JSON.stringify(repo)}`);
  const undo = run(here ? 'undo --hook' : `undo --hook ${JSON.stringify(repo)}`);
  // attached already? "already attached" only when every hook of THIS version is present; an older
  // attachment (say, without the SessionStart[compact] hook) is upgraded in place, never left stale.
  let upgrading = false;
  if (OURS.test(JSON.stringify(cfg))) {
    const has = (event, command, matcher) => ((cfg.hooks || {})[event] || []).some((h) => h && (matcher ? h.matcher === matcher : !h.matcher) && Array.isArray(h.hooks) && h.hooks.some((x) => x && x.command === command));
    if (has('UserPromptSubmit', ctx) && has('SessionStart', ctx, 'compact') && has('Stop', chk) && has('PreToolUse', hold, 'Bash') && has('PreToolUse', undo, EDIT_MATCHER) && has('PostToolUse', undo, EDIT_MATCHER)) { out(`sawbuck: already attached (${user ? 'user' : shared ? 'shared' : 'claude'}) in ${f}`); return; }
    upgrading = true;
  }
  const mode = user ? 'user' : shared ? 'claude-shared' : 'claude';
  const mp = user ? userManifestPath() : manifestPath(repo);
  const stPath = join(repo, '.sawbuck', 'state.json');
  let st = {}; try { st = JSON.parse(readFileSync(stPath, 'utf8')); } catch {}
  if (st.detached && !dry) { delete st.detached; try { writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n'); } catch {} }   // attached again: the record no longer says detached
  // attach often runs inside a turn (saying yes to the offer), and that turn's Stop hook then has no baseline, so the
  // files signing just wrote would read as the agent's violations. What is here now is the baseline; anything after it counts.
  const baseline = !user && existsSync(join(repo, 'promptwheel.config.json')) && !st.turnBaseline;
  if (dry) {
    out(dryText([
      `${upgrading ? 'update' : fileExisted ? 'modify' : 'create'}  ${f}  (UserPromptSubmit + SessionStart[compact] + Stop + PreToolUse[Bash] + PreToolUse/PostToolUse[edit tools] hooks: the per-turn block, the check, the hold on outward commands, and the undo ledger)`,
      !user && ensureExcluded(repo, true) ? `exclude ${excludeFile(repo)}  (${EXCLUDED.join(', ')})` : null,
      `${existsSync(mp) ? 'modify' : 'create'}  ${mp}  (attach receipt)`,
      baseline ? `write   ${stPath}  (the turn baseline, so this turn's own signing is not read as the agent's)` : null,
      `write   ${regPath()}  (the list of attached repos, for detach --all)`,
    ].filter(Boolean)));
    return;
  }
  cfg.hooks = cfg.hooks || {};
  const put = (event, command, matcher) => {
    // one entry of ours per event and matcher: the hold (Bash) and the undo ledger (edit tools) share PreToolUse
    cfg.hooks[event] = (cfg.hooks[event] || []).filter((h) => !(OURS.test(JSON.stringify(h)) && String(h.matcher || '') === String(matcher || '')));
    cfg.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
  };
  put('UserPromptSubmit', ctx);
  // right after a compaction the summary has just dropped detail: re-impress the contract frame there too
  // (SessionStart with the `compact` source injects stdout into context).
  put('SessionStart', ctx, 'compact');
  put('Stop', chk);
  // the hold on outward commands: a publish, a release, a merge, a public comment, a force push ask a person first
  put('PreToolUse', hold, 'Bash');
  // the undo ledger: a file snapshotted before an edit, an undo at the person's request recorded after one
  put('PreToolUse', undo, EDIT_MATCHER);
  put('PostToolUse', undo, EDIT_MATCHER);
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  if (baseline) {
    try {
      ensureExcluded(repo);
      let sha = ''; try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
      st.turnBaseline = { sha, files: protectedDirty(repo, { store: true }), by: 'attach', refs: refTips(repo) };
      st.lastPromptAt = new Date().toISOString();
      mkdirSync(dirname(stPath), { recursive: true }); writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n');
    } catch {}
  }
  const m = readManifest(mp);
  const prev = (m.attachments || {})[mode];   // an upgrade keeps the receipt of what the first attach created
  m.attachments = { ...m.attachments, [mode]: { file: f, fileCreated: prev ? !!prev.fileCreated : !fileExisted, dirCreated: prev ? !!prev.dirCreated : !dirExisted } };
  if (!user) syncExclude(repo, m);
  writeManifest(mp, m);
  regAdd(repo, mode);
  const kind = user ? 'USER-LEVEL' : shared ? 'shared project' : 'project';
  out(upgrading ? `sawbuck: updated the ${kind} Claude Code hooks in ${f} to this version` : `sawbuck: wired ${kind} Claude Code hooks in ${f}`);
  if (shared) out(`  commit ${relative(repo, f)} so the team gets the check. It runs sawbuck ${version} through npx on every machine.`);
  if (shared && protectedAmong(repo, [relative(repo, f)]).length) out(`  That file is a protected path in this repo, so the check on its commit reads "sent back" unless a person passes --allow "team hooks" (on a pull request: a comment, sawbuck-allow: team hooks).`);
  if (!user && !existsSync(join(repo, 'AGENTS.md')) && !existsSync(join(repo, 'CLAUDE.md'))) out('  no written rule here yet, and that is what changes the agent: run sawbuck contract.');
  if (user) out('  profile-switches by cwd: memory in any git repo, the check where a promptwheel.config.json exists.');
}
function unwireClaude(repo, { user }) {
  const mp = user ? userManifestPath() : manifestPath(repo);
  const m = readManifest(mp);
  const modes = user ? ['user'] : ['claude', 'claude-shared'];
  let did = false, touched = false;
  for (const mode of modes) {
    const rec = m.attachments?.[mode];
    const f = rec?.file || claudeFile(repo, { user, shared: mode === 'claude-shared' }).f;
    if (existsSync(f)) {
      let raw = ''; try { raw = readFileSync(f, 'utf8'); } catch {}
      if (OURS.test(raw)) {
        let cfg = null; try { cfg = JSON.parse(raw); } catch {}
        if (cfg) {
          removeClaudeEntries(cfg);
          if ((rec?.fileCreated || !rec) && isTrivialSettings(cfg)) { dropFile(f, 'our Claude Code hooks were all it held'); if (rec?.dirCreated) rmIfEmptyDir(dirname(f)); }
          else putFile(f, JSON.stringify(cfg, null, 2) + '\n', 'our Claude Code hooks');
          say(`sawbuck: removed Claude Code hooks from ${f}`);
          did = true;
        }
      }
    }
    if (rec) { delete m.attachments[mode]; touched = true; }
  }
  if (touched) { if (!user) syncExclude(repo, m); writeManifest(mp, m); }
  for (const mode of modes) regRemove(repo, mode);
  if (!did && !touched) say('sawbuck: no Claude attachment found to detach');
}
function removeClaudeEntries(cfg) {
  if (!cfg.hooks) return;
  for (const ev of ['UserPromptSubmit', 'SessionStart', 'Stop', 'PreToolUse', 'PostToolUse']) {
    if (!Array.isArray(cfg.hooks[ev])) continue;
    cfg.hooks[ev] = cfg.hooks[ev].filter((h) => !OURS.test(JSON.stringify(h)));
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];     // no empty [] residue
  }
  if (cfg.hooks && !Object.keys(cfg.hooks).length) delete cfg.hooks;
}
function isTrivialSettings(cfg) { return Object.keys(cfg).length === 0; }

// --- verify / doctor / purge: prove and clean the footprint ----------------
function footprint(repo) {
  const items = [];
  const pc = gitPath(repo, 'hooks/post-commit');
  try { if (existsSync(pc) && readFileSync(pc, 'utf8').includes(S_START)) items.push({ what: pc, state: 'git hook' }); } catch {}
  for (const f of [join(repo, '.claude', 'settings.local.json'), join(repo, '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.json')]) {
    try { if (existsSync(f) && OURS.test(readFileSync(f, 'utf8'))) items.push({ what: f, state: 'claude hooks' }); } catch {}
  }
  const xf = excludeFile(repo);
  // the exclude lines are part of the record while it is on disk (syncExclude), wiring only once it is gone
  try { if (existsSync(xf) && readFileSync(xf, 'utf8').includes(S_START) && !hiddenLeft(repo).length) items.push({ what: xf, state: 'local exclude' }); } catch {}
  const mp = manifestPath(repo);
  if (existsSync(mp)) { const m = readManifest(mp); items.push({ what: mp, state: `receipt: ${Object.keys(m.attachments || {}).join(', ') || 'empty'}` }); }
  return items;
}
function verifyClean(repo) {
  // the record may stay (your data, unless --purge, and named above); the mechanism must be gone.
  const left = footprint(repo);
  if (!left.length) out('sawbuck: verified, the hooks and the receipt are gone.');
  else { out('sawbuck: NOT clean, these remain:'); for (const it of left) out(`  ${it.state.padEnd(22)} ${it.what}`); process.exitCode = 1; }
}
// every ref tip at the start of a turn, so a rebase inside the turn can tell the agent's own commits from upstream's
function refTips(repo) {
  try { return [...new Set(execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(objectname)'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean))].slice(0, 500); } catch { return []; }
}
// detach keeps .sawbuck/state.json as the record; this flag is how the plugin band and status tell "detached" from "watching"
function markDetached(repo, detached) {
  const p = join(repo, '.sawbuck', 'state.json');
  if (!there(p)) return;
  if (dry) { if (detached) planned.lines.set(p, `modify  ${p}  (the record stays, marked detached so nothing reads it as watching)`); return; }
  try { const st = JSON.parse(readFileSync(p, 'utf8')); if (detached) st.detached = true; else delete st.detached; writeFileSync(p, JSON.stringify(st, null, 2) + '\n'); } catch {}
}
// --- Codex (attach --codex) -------------------------------------------------
// Codex's hooks speak Claude Code's contract nearly field for field (developers.openai.com/codex/hooks): prompt-time
// context, a Stop that sends the agent back, PreToolUse on Bash. <repo>/.codex/hooks.json, kept out of git status.
// Codex runs a new or changed hook only after the person trusts it in /hooks. Not wired under Codex: the undo ledger
// (Codex edits through apply_patch, a patch, not a file path).
function codexFile(repo) { return join(repo, '.codex', 'hooks.json'); }
function wireCodex(repo) {
  const f = codexFile(repo); let cfg = {};
  if (existsSync(f)) { try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { die(`${f} exists but is not valid JSON; I will not overwrite it.`); } }
  const run = (args) => `${nodeCmd()} ${JSON.stringify(SELF)} ${args}`;
  const r = JSON.stringify(repo);
  cfg.hooks = cfg.hooks || {};
  const put = (event, command, matcher) => {
    cfg.hooks[event] = (cfg.hooks[event] || []).filter((h) => !(OURS.test(JSON.stringify(h)) && String(h.matcher || '') === String(matcher || '')));
    cfg.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
  };
  put('UserPromptSubmit', run(`turn --hook ${r}`));
  put('SessionStart', run(`turn --hook ${r}`), 'compact');
  put('Stop', run(`__hook --repo ${r} --by codex --stop`));
  put('PreToolUse', run(`hold --hook --codex ${r}`), 'Bash');
  // the undo ledger: apply_patch names the files it touches; they are snapshotted before and observed after
  put('PreToolUse', run(`undo --hook --codex ${r}`), 'apply_patch');
  put('PostToolUse', run(`undo --hook --codex ${r}`), 'apply_patch');
  if (dry) { out(dryText([`${existsSync(f) ? 'modify' : 'create'}  ${f}  (UserPromptSubmit + SessionStart[compact] + Stop + PreToolUse[Bash] + Pre/PostToolUse[apply_patch] for Codex)`])); return; }
  mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  ensureExcluded(repo);
  try { const ex = join(gitDir(repo), 'info', 'exclude'); const t = existsSync(ex) ? readFileSync(ex, 'utf8') : ''; if (!/^\/?\.codex\/hooks\.json$/m.test(t)) { mkdirSync(dirname(ex), { recursive: true }); writeFileSync(ex, t + (t && !t.endsWith('\n') ? '\n' : '') + '.codex/hooks.json\n'); } } catch {}
  out(`sawbuck: wired Codex hooks in ${f}. Open /hooks in Codex once and trust them; Codex skips a new hook until you do.`);
}
function unwireCodex(repo, { quiet } = {}) {
  const f = codexFile(repo); if (!existsSync(f)) { if (!quiet) say('sawbuck: no Codex hooks found to detach'); return; }
  let cfg; try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { return; }
  if (!OURS.test(JSON.stringify(cfg))) { if (!quiet) say('sawbuck: no Codex hooks of ours in ' + f); return; }
  removeClaudeEntries(cfg);
  if (dry) { planned.lines.set(f, `modify  ${f}  (our Codex hooks)`); return; }
  if (!Object.keys(cfg).length || (Object.keys(cfg).length === 1 && cfg.description)) rmSync(f); else writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  say(`sawbuck: removed the Codex hooks from ${f}`);
}
// --- Cursor (attach --cursor) -------------------------------------------------
// <repo>/.cursor/hooks.json, kept out of git status: the check at stop (a gamed commit comes back as a follow-up message),
// the hold before shell commands (Cursor supports ask), and the prompt hook for the turn's baseline. Not wired: the
// undo ledger, and history with the prompt (Cursor's prompt hook can only allow or block).
function cursorFile(repo) { return join(repo, '.cursor', 'hooks.json'); }
function wireCursor(repo) {
  const f = cursorFile(repo); let cfg = {};
  if (existsSync(f)) { try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { die(`${f} exists but is not valid JSON; I will not overwrite it.`); } }
  const cmd = (ev) => `${nodeCmd()} ${JSON.stringify(SELF)} __cursor ${ev} ${JSON.stringify(repo)}`;
  cfg.version = cfg.version || 1; cfg.hooks = cfg.hooks || {};
  for (const ev of ['beforeSubmitPrompt', 'stop', 'beforeShellExecution', 'afterFileEdit']) cfg.hooks[ev] = [...(cfg.hooks[ev] || []).filter((x) => !OURS.test(JSON.stringify(x))), { command: cmd(ev) }];
  if (dry) { out(dryText([`${existsSync(f) ? 'modify' : 'create'}  ${f}  (beforeSubmitPrompt + stop + beforeShellExecution + afterFileEdit for Cursor)`])); return; }
  mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  ensureExcluded(repo);
  try { const ex = join(gitDir(repo), 'info', 'exclude'); const t = existsSync(ex) ? readFileSync(ex, 'utf8') : ''; if (!/^\/?\.cursor\/hooks\.json$/m.test(t)) writeFileSync(ex, t + (t && !t.endsWith('\n') ? '\n' : '') + '.cursor/hooks.json\n'); } catch {}
  out(`sawbuck: wired Cursor hooks in ${f}. Cursor picks them up on its next start.`);
}
function unwireCursor(repo, { quiet } = {}) {
  const f = cursorFile(repo); if (!existsSync(f)) { if (!quiet) say('sawbuck: no Cursor hooks found to detach'); return; }
  let cfg; try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { return; }
  if (!OURS.test(JSON.stringify(cfg))) { if (!quiet) say('sawbuck: no Cursor hooks of ours in ' + f); return; }
  for (const ev of Object.keys(cfg.hooks || {})) { cfg.hooks[ev] = cfg.hooks[ev].filter((x) => !OURS.test(JSON.stringify(x))); if (!cfg.hooks[ev].length) delete cfg.hooks[ev]; }
  if (dry) { planned.lines.set(f, `modify  ${f}  (our Cursor hooks)`); return; }
  if (!Object.keys(cfg.hooks || {}).length) rmSync(f); else writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  say(`sawbuck: removed the Cursor hooks from ${f}`);
}
function purgeRecord(repo) {
  let n = 0;
  const purge = (p) => { if (!there(p)) return; dropFile(p, 'the record'); n++; say(`sawbuck: purged ${p}`); };
  for (const d of RECORD_DIRS) {
    // a committed LOGBOOK.md or JOURNEY.md is the person's file, not our record
    try { if (execFileSync('git', ['-C', repo, 'ls-files', '--', d], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) continue; } catch {}
    purge(join(repo, d));
  }
  purge(join(repo, '.promptwheel', 'outcomes.jsonl'));   // the rest of .promptwheel/ is the signed contract: yours to keep or delete
  if (!n) say('sawbuck: no record to purge');
}
// the path a hook bakes in: the quoted one ending in sawbuck.mjs, in a shell hook or in JSON, where the quotes are escaped
function extractBaked(text) { const m = text.match(/"([^"]*sawbuck\.mjs)\\?"/); return m ? m[1] : null; }
// Does the hook still work? Run exactly what it runs, with --version in place of the hook's arguments: the same
// node lookup, the same baked path, the same npx fallback. A hook never looks sawbuck up on PATH, so neither does this.
function hookRuns(command) {
  const probe = command.replace(/(sawbuck\.mjs"?|sawbuck@[\w.-]+) [^;]*/g, '$1 --version');
  if (process.platform === 'win32') { const b = extractBaked(JSON.stringify(command)); return !!b && existsSync(b); }
  try { return /^\d+\.\d+\.\d+/.test(execFileSync('sh', ['-c', probe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }).trim()); } catch { return false; }
}
function doctorRepo(repo) {
  const checks = [];
  // the git hook tries a sawbuck on PATH first, then the baked path, then npx
  const pc = gitPath(repo, 'hooks/post-commit');
  try { if (existsSync(pc)) { const b = readFileSync(pc, 'utf8'); if (b.includes(S_START)) { const baked = extractBaked(b); let onPath = false; try { onPath = !!execFileSync('sh', ['-c', 'command -v sawbuck'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {} checks.push({ mode: 'git', file: pc, ok: onPath || (!!baked && existsSync(baked)) || /npx -y sawbuck@/.test(b) }); } } } catch {}
  for (const [mode, f] of [['claude', join(repo, '.claude', 'settings.local.json')], ['claude-shared', join(repo, '.claude', 'settings.json')], ['user', join(homedir(), '.claude', 'settings.json')]]) {
    let cfg = null; try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    const ours = (list) => (Array.isArray(list) ? list : []).flatMap((h) => (h && Array.isArray(h.hooks) ? h.hooks : [])).map((x) => x && x.command).filter((c) => typeof c === 'string' && OURS.test(c));
    const cmds = ours(Object.values((cfg && cfg.hooks) || {}).flat());
    if (!cmds.length) continue;
    // the set attach writes, each under its own event: the rule on a prompt and after a compaction, the check on Stop
    const at = (event, re, matcher) => ours(((cfg.hooks || {})[event] || []).filter((h) => !matcher || (h && h.matcher === matcher))).some((c) => re.test(c));
    const missing = [at('UserPromptSubmit', /\bturn --hook\b/) ? '' : 'UserPromptSubmit', at('SessionStart', /\bturn --hook\b/, 'compact') ? '' : 'SessionStart[compact]', at('Stop', /__hook\b.*--stop\b/) ? '' : 'Stop with --stop', at('PreToolUse', /\bhold --hook\b/, 'Bash') ? '' : 'PreToolUse[Bash] with hold', at('PreToolUse', /\bundo --hook\b/, EDIT_MATCHER) ? '' : 'PreToolUse[edit tools] with undo', at('PostToolUse', /\bundo --hook\b/, EDIT_MATCHER) ? '' : 'PostToolUse[edit tools] with undo'].filter(Boolean);
    checks.push({ mode, file: f, ok: !missing.length && [...new Set(cmds)].every(hookRuns), missing });
  }
  // the receipt says hooks were wired here, and they are gone: a removal git status cannot show (the file is excluded, or under .git)
  const receipt = Object.keys(readManifest(manifestPath(repo)).attachments || {}).filter((m) => !checks.some((c) => c.mode === m));
  if (!checks.length && !receipt.length) { out(`sawbuck: no attachment in ${repo}, nothing to check.`); return; }
  let bad = receipt.length;
  const again = (m) => `sawbuck attach${{ git: ' --git', 'claude-shared': ' --shared', user: ' --user' }[m] || ''} again`;
  out(`sawbuck doctor, ${repo}:`);
  for (const c of checks) {
    if (!c.ok) bad++;
    const why = c.ok ? '' : c.missing && c.missing.length ? `  (the hook set is incomplete, missing: ${c.missing.join(', ')}; run ${again(c.mode)})` : `  (the hook does not run: what it calls is gone; run ${again(c.mode)})`;
    out(`  ${c.ok ? 'OK   ' : c.missing && c.missing.length ? 'PART ' : 'STALE'} ${c.mode.padEnd(14)} ${c.file}${why}`);
  }
  for (const m of receipt) out(`  GONE  ${m.padEnd(14)} the receipt says ${m === 'git' ? 'a post-commit hook was wired here, but our block is gone' : 'hooks were wired here, but the hooks are gone'}. Run ${again(m)}, or sawbuck detach to drop the receipt.`);
  if (bad) process.exitCode = 1;
}
function doctorAll() {
  const r = regRead();
  if (!r.repos.length) { out('sawbuck: not attached anywhere.'); return; }
  out('sawbuck is attached to:');
  for (const x of r.repos) out(`  ${x.mode.padEnd(14)} ${x.mode === 'user' ? 'every repo you open in Claude Code (hooks in ~/.claude/settings.json; the check runs where a promptwheel.config.json exists)' : x.repo}`);
  for (const repo of new Set(r.repos.map((x) => x.repo))) doctorRepo(repo);
}

// --- every attachment, in one list, so there is one way out of all of them ---
function regPath() { return join(homedir(), '.sawbuck', 'registry.json'); }
function regRead() { if (planned.registry) return { ...planned.registry }; try { const r = JSON.parse(readFileSync(regPath(), 'utf8')); r.repos = (r.repos || []).filter((x) => existsSync(x.repo)); return r; } catch { return { repos: [] }; } }   // a repo that is gone is not attached
function regWrite(r) {
  const f = regPath();
  if (dry) planned.registry = r;
  if (!r.repos.length) { dropFile(f, 'the list of attached repos'); rmIfEmptyDir(dirname(f)); return; }
  putFile(f, JSON.stringify(r, null, 2) + '\n', 'the list of attached repos');
}
function regAdd(repo, mode) { const r = regRead(); r.repos = r.repos.filter((x) => !(x.repo === repo && x.mode === mode)); r.repos.push({ repo, mode, at: new Date().toISOString() }); regWrite(r); }
function regRemove(repo, mode) { const r = regRead(); const keep = r.repos.filter((x) => !(x.mode === mode && (mode === 'user' || x.repo === repo))); if (keep.length !== r.repos.length) regWrite({ ...r, repos: keep }); }
function detachAll(purge) {
  const r = regRead();
  if (!r.repos.length) { say('sawbuck: nothing to detach: not attached anywhere.'); return; }
  for (const x of [...r.repos]) {
    if (x.mode === 'git') unwireGit(x.repo);
    else if (x.mode === 'user') unwireClaude(x.repo, { user: true });
    else unwireClaude(x.repo, {});
    if (purge) purgeRecord(x.repo);
    syncExclude(x.repo, readManifest(manifestPath(x.repo)));
  }
  say('sawbuck: detached everywhere.');
}
// --- shared helpers ---------------------------------------------------------
function dryText(plan, verb = 'leave') { return verb === 'remove' ? ['sawbuck --dry-run: would remove (changing nothing):', ...(plan.length ? plan.map((p) => '  ' + p) : ['  nothing: no wiring here'])].join('\n') : ['sawbuck --dry-run: would leave this footprint (writing nothing):', ...plan.map((p) => '  ' + p), '  all of it reversible with `detach`.'].join('\n'); }
