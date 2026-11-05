#!/usr/bin/env node
// sawbuck, the CLI. Zero-dep.
// `attach` wires the Claude Code hooks into a repo; `detach` removes them, and the record stays until `--purge`. The
// repo never imports Sawbuck. Rides two engines: promptwheel (the check) + @promptwheel/logbook.
//
// attach writes a receipt to .git/sawbuck/attach.json recording every file it created or modified. detach reads it and
// reverses exactly that; `detach --verify` proves the wiring is gone and names what is left; `doctor` runs what each hook runs.

import './pipe.mjs';
import { execFileSync } from 'node:child_process';
import { erasedBlock, erasedCommits } from './rewrites.mjs';
import { steersReport } from './steers.mjs';
import { rulesCli } from './rules.mjs';
import { shapeCli } from './shape.mjs';
import { ensureExcluded, clearExcluded, EXCLUDED, RECORD_DIRS } from './exclude.mjs';
import { repoState } from './repo-state.mjs';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, unlinkSync, rmdirSync, rmSync, readdirSync } from 'node:fs';
import { basename, join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { PW } from './bins.mjs';
import { frameBlock, mandatesInForce, protectedDirty, blobAt, lockState } from './contract.mjs';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const HOOK = join(HERE, 'sawbuck-hook.mjs');
// run the engine and parse its JSON verdict (it prints JSON even when it exits nonzero)
// A commit message is not a person: an agent can write a Sawbuck-Allow trailer, so no sawbuck path honors one
// (the Stop hook does the same through reflect). `--allow` is the declared override.
function gateReport(repo, a) {
  let o = '', err = '', code = 0;
  try { o = execFileSync(process.execPath, [PW, ...a, '--no-record', '--json'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PROMPTWHEEL_NO_ALLOW_TRAILER: '1' }, timeout: +(process.env.SAWBUCK_CHECK_TIMEOUT_MS) || 120000 }); }
  catch (e) { o = (e.stdout || '').toString(); err = e.signal ? 'the check timed out' : (e.stderr || '').toString(); code = e.status || 0; }
  let rep = null; try { rep = JSON.parse(o.slice(o.indexOf('{'))); } catch {}
  // the engine's own reason, without its zero-config notice
  const why = err.split('\n').filter((l) => l.trim() && !/^no promptwheel\.config\.json, auto-gating/.test(l)).join(' ').trim();
  return { rep, code, why };
}
// why nothing could be measured, in words that match the case: no test command, tests red on both sides, or a
// win the source-only re-run could not apply. `sawbuck init` only where there is no config to edit yet.
function inconclusiveWhy(rep, repo) {
  const ms = (rep && rep.metrics) || [];
  const m = ms.find((x) => x.inert) || ms[0];
  if (ms.some((x) => x.unprovable)) return 'a win here could not be re-proved, because the source-only re-run did not apply. Do not trust this green on its own.';
  const hasCfg = existsSync(join(repo, 'promptwheel.config.json'));
  let cmd = '';
  try { cmd = String((JSON.parse(readFileSync(join(repo, 'promptwheel.config.json'), 'utf8')).metrics || []).find((x) => x && x.name === (m && m.name))?.cmd || ''); } catch {}
  const placeholder = /set your test command/.test(cmd) || (!hasCfg && !detectedTests(repo));
  const where = hasCfg ? 'in promptwheel.config.json' : 'with `sawbuck init`, then in promptwheel.config.json';
  if (placeholder) return `there is no test command here, so nothing was measured. It finds npm, pytest, cargo and go tests on its own. Set yours ${where} (the cmd of "${(m && m.name) || 'tests_pass'}").`;
  return `"${(m && m.name) || 'tests_pass'}" failed before and after this change, so there was no win or loss to measure. If your tests are red, fix them first. If they pass for you, the clean copy the check runs in is missing something: set setup or linkDirs ${where}.`;
}
// the test commands the engine finds with no config (promptwheel's detectTestCmd)
function detectedTests(repo) {
  const has = (f) => existsSync(join(repo, f));
  if (['go.mod', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'pytest.ini'].some(has)) return true;
  try { return !!JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts?.test; } catch { return false; }
}
// is the metric live (actually ran), or inert (never ran in isolation)?
const metricLive = (m) => !!m && !m.inert && m.status !== 'unmeasurable' && m.before != null;
const S_START = '# >>> sawbuck >>>';
const S_END = '# <<< sawbuck <<<';
const BLOCK_RE = new RegExp(`\\n?${S_START}[\\s\\S]*?${S_END}\\n?`, 'g');
const OURS = /sawbuck\.mjs|npx -y sawbuck@/;   // a hook of ours: the baked path, or the portable form --shared writes
// the record/state dirs the engines write into the worktree; excluded locally so
// attach never dirties `git status`.
// The record Sawbuck keeps on disk but must never let dirty git status: the engine records
// plus the logbook's root working-set (ledger cache, digests, annotation planes). It is
// memory, not the user's source, a user who wants LOGBOOK.md committed still can explicitly
// (exclude only affects UNtracked files).

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
                            Exit 0 verified · 1 regression · 2 gamed · 3 inconclusive · 64 could not run
  sawbuck init [--yes] [--wizard] [--no-investigate] [--no-agent-block] [--force]
                            Write promptwheel.config.json: your detected tests and the tripwires, with
                            notes from what your git history shows actually breaks, plus a short guide in
                            AGENTS.md (--no-agent-block to skip). Wizard in a terminal, non-interactive in
                            a pipe/CI (or --yes). An existing config needs --force.
  sawbuck attach [repo] [--user | --shared | --git] [--dry-run]
                            Check every Claude Code turn in this repo. --user: every repo. --shared: a
                            tracked settings file a team commits. --git: a post-commit hook, for any other
                            agent or none. --dry-run prints every file it would write
  sawbuck detach [repo] [--user] [--all] [--verify] [--purge] [--dry-run]
                            Remove the hooks (no flag: whatever is attached here; --all: every repo). The
                            record stays, kept out of git status; --purge deletes it. --verify proves the
                            wiring is gone and names what is left
  sawbuck status [repo]     The inventory: caught over time + debt accruing now + whether it is armed. --json
                            --log [-n N] for the recent checks, newest first
  sawbuck debt [repo] [--since REF] [--fail-on undocumented|test|any|N]
                            The live suppression debt in HEAD, risk-ranked, undocumented flagged. --since REF
                            shows only what a branch adds; --fail-on exits 1 when that debt (or, without
                            --since, any live debt of that kind) is there (a CI gate)
  sawbuck context [repo]    Relevant history for the files you are changing (reverts, weakened tests, hot spots)
  sawbuck doctor [repo]     Run what each hook runs (project and user level) and say if it still works.
                            --all lists every repo it is attached to and checks each
  sawbuck contract [--dry-run] [--full] [--strict]
                            Give this repo its rules: protected paths, the written rule, and your detected
                            tests when there is no config yet (--dry-run to preview). --full adds supply-chain
                            guards, the repo lock, and a CI check on a github.com repo with a real test
                            command; --strict makes them block
  sawbuck rules --prepare   Gather your messages on this machine so an agent can propose the rules you never wrote
  sawbuck rules --check F   Keep only proposed rules with 2 quotes that are really yours
  sawbuck shape --prepare   Gather a sample of your messages so an agent can label what you push on
  sawbuck shape --check F   Draw your steering shape from the labels, keeping only the totals (--png for an image)
  sawbuck steers            What you keep correcting, from the plugin's scratchpad on this machine (--json)
  sawbuck statusline        One-line segment for your status line (🐴 watching | N caught)

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

if (cmd === '--version' || cmd === '-v') { console.log(version); process.exit(0); }
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  out(flags.has('--all') ? help : `sawbuck ${version}: write down the rules your agent follows, and prove they held

  sawbuck contract   give this repo its rules: protected paths, your tests
  sawbuck check      verify your latest change right now
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
// a flag contract does not know is an error, never a silent no-op
if (cmd === 'contract') { const bad = rest.filter((a) => a.startsWith('-') && !['--dry-run', '--full', '--strict'].includes(a)); if (bad.length) usage(`unknown flag ${bad.join(' ')} for contract (it takes --dry-run, --full, --strict)`); }

switch (cmd) {
  case 'contract': {
    const top = gitTop(repoArg());
    if (!top) usage(`${repoArg()} is not a git repository (run it inside your project)`);
    try { execFileSync(process.execPath, [join(HERE, 'contract-cmd.mjs'), top, ...rest.filter((a) => ['--dry-run', '--full', '--strict'].includes(a))], { stdio: 'inherit' }); }
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
    if (flags.has('--log')) { logReport(repoArg(), rest); break; }
    try { execFileSync(process.execPath, [join(HERE, 'status.mjs'), '--repo', repoArg(), ...rest.filter((a) => a.startsWith('--'))], { stdio: 'inherit' }); }
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
      if (VALUE_FLAGS.has(a)) { const v = rest[++i]; if (v == null) die(`${a} needs a value`); if (a === '--base') base = v; else if (a === '--head') head = v; else pass.push(a, v); continue; }
      if (a.startsWith('--')) { pass.push(a); continue; }
      pos.push(a);
    }
    const repo = resolve(pos[0] || '.');
    // stderr ignored so a benign failing probe (e.g. rev-parse HEAD~1 on a one-commit repo) does not
    // leak a scary "fatal:" line before sawbuck's own message.
    const g = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
    // 64 (EX_USAGE) for every "could not run" below, never a verdict code: a script or CI must not read it as gamed (2).
    if (!g('rev-parse', '--git-dir')) { out(`🐴 sawbuck: ${repo} is not a git repo. The check re-proves a change against git history, so run it inside one (git init, then commit).`); process.exit(64); }
    if (!g('rev-parse', '--verify', 'HEAD')) { out('🐴 sawbuck: no commit yet. Make one, then `sawbuck check` verifies your next change against it.'); process.exit(64); }
    const dirty = !base && !head && g('status', '--porcelain').length > 0;
    // nothing to verify yet: a clean tree with no previous commit to diff against (a fresh repo). Say so
    // plainly instead of the generic "could not run" below, so the first run is not a dead end.
    if (!dirty && !base && !g('rev-parse', '--verify', 'HEAD~1')) { out('🐴 sawbuck: nothing to verify yet, the working tree is clean and this is the only commit. Make a change (or add one more commit), then `sawbuck check` re-proves the win from your source edits alone.'); process.exit(64); }
    const where = dirty ? 'working' : (base || head) ? `${base || 'HEAD~1'}..${head || 'HEAD'}` : 'last';
    const args = dirty ? ['run', '--working'] : ['run', '--base', base || 'HEAD~1', '--head', head || 'HEAD'];
    const { rep, code, why } = gateReport(repo, [...args, ...pass]);
    if (!rep || !rep.verdict) { out(`🐴 sawbuck: could not run the check here: ${why || 'the engine gave no verdict'}`); process.exit(64); }
    if (json) { out(JSON.stringify(rep)); process.exit(code); }
    const m = (rep.metrics || [])[0];
    for (const md of rep.mandates || []) out(`🐴 ⛔ protected path "${md.name}" touched${md.reason ? ': ' + md.reason : ''}  (touched: ${(md.files || []).join(', ')})${md.removed ? '  [deleted in this same change; the rule stays in force for the change that removes it]' : ''}`);
    const win = (rep.metrics || []).find((x) => x.status === 'improved' && !x.tripwire);
    const noDetect = pass.includes('--no-detect-gaming');
    if (rep.verdict === 'pass' && rep.allowed) out(`🐴 ✎ allowed with --allow: "${rep.allowed.reason}". That is a person's call, not a proof: ${(rep.allowed.cleared || []).join(', ') || 'the change'} was let through without a source-only re-proof.`);
    else if (rep.verdict === 'pass' && win && noDetect) out(`🐴 ✓ passed: "${win.name}" improved, but gaming detection is off (--no-detect-gaming), so the win was not re-proved from the source.`);
    else if (rep.verdict === 'pass' && win) out(`🐴 ✓ verified: your ${where} change earned it. "${win.name}" improved, and the source carried the win (it survives a source-only re-run).`);
    else if (rep.verdict === 'pass') out(`🐴 ✓ held: nothing got worse in your ${where} change, and there was no win to re-prove.`);
    else if (rep.verdict === 'gamed') {
      out('🐴 🚩 gamed: a win here came from editing the test, config, or grader, not the source. It does NOT survive a source-only re-run, so it does not count.');
      if (!dirty && /^(Sawbuck|Promptwheel)-Allow:/im.test(g('log', '--format=%B', `${base || 'HEAD~1'}..${head || 'HEAD'}`))) out('🐴 note: a Sawbuck-Allow trailer does not clear this, because an agent can write a commit message. A person passes --allow "<reason>".');
    }
    else if (rep.verdict === 'fail' && (rep.mandates || []).length) out('🐴 ✗ sent back: a rule in the contract was broken, however green the rest is.');
    else if (rep.verdict === 'fail') out('🐴 ✗ sent back: this change made something worse.');
    else out(`🐴 ≈ inconclusive: ${inconclusiveWhy(rep, repo)}`);
    if ((rep.metrics || []).some((x) => x.heldByTestEdit)) out('🐴 ⚠ your tests changed too, and the old tests fail on this source. Fine for an intended change. Otherwise check the tests were not weakened: a green that stays green is not proved.');
    for (const x of rep.explained || []) out(`🐴 ${x.noted ? 'note' : 'needs a look'}: ${x.what}${x.items ? ': ' + x.items.join(', ') : ''}${!x.noted && x.allowable ? '. If you meant this: --allow "<reason>", or on a pull request comment sawbuck-allow: <reason>' : ''}`);
    if (rep.gate && rep.gate.changed) out(`🐴 ⚠ the gate definition changed in this change (fingerprint ${rep.gate.fingerprint.base} -> ${rep.gate.fingerprint.head}): a metric, guard, evaluatorPath or mandate was added, removed or edited.`);
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
  case 'context': { const o = contextBlock(repoRoot(), flags.has('--speak')); if (o) out(o); break; }
  case 'frame': {
    // the prompt face of the contract: re-impress the hard rules (mandates, resolved through `extends`)
    // as one compact block at the live end of the context, so a deep or freshly compacted session
    // cannot forget them. Silent without a contract; --speak explains instead.
    const o = frameBlock(repoRoot());
    if (o) out(o);
    else if (flags.has('--speak')) out('🐴 sawbuck frame: no protected paths in promptwheel.config.json yet. Add one (a protected path) and this re-asserts it every turn and after every compaction, so a deep context cannot forget it.');
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
    let hookEvent = '', session = '', framed = false;
    if (flags.has('--hook') && !process.stdin.isTTY) { try { const h = JSON.parse(readFileSync(0, 'utf8') || '{}'); hookEvent = String(h.hook_event_name || ''); session = String(h.session_id || ''); } catch {} }
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
            st.turnBaseline = { at: now, sha: ((!moved || stillInHead) && pin && st.lastViolation.sha) || sha, files, lock: lockState(repo), rules: mandatesInForce(repo) };
          }
        }
        framed = !!session && st.framedSession === session;
        if (session) st.framedSession = session;
        st.lastPromptAt = now;   // every prompt, mandates or not: the walls key their block budgets on it when the harness sends no prompt_id
        mkdirSync(stDir, { recursive: true }); writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n');
      } catch { /* the frame never fails a prompt */ }
    }
    let history = false;
    try { history = JSON.parse(readFileSync(join(repo, 'sawbuck.config.json'), 'utf8')).turn?.context === true; } catch {}
    if (!history && top) erasedCommits(repo);   // the ledger outlives the reflog whether or not it is printed
    const o = [framed ? '' : frameBlock(repo), history ? contextBlock(repo, false) : ''].filter(Boolean).join('\n');
    if (o) out(o);
    break;
  }
  case '__hook': {
    try { execFileSync(process.execPath, [HOOK, ...rest], { stdio: 'inherit' }); } catch (e) { process.exit(e.status || 0); }
    break;
  }
  case 'attach': {
    const user = flags.has('--user'), shared = flags.has('--shared'), git = flags.has('--git');
    if (user + shared + git > 1) usage('attach takes one of --user, --shared or --git');
    const top = gitTop(repoArg());
    if (!top && !user) usage(`${repoArg()} is not a git repository (attach wires one; run it inside your project, or name its path)`);
    const repo = top || repoArg();
    if (git) wireGit(repo); else wireClaude(repo, { user, shared });
    if (!dry) verifyAttach(repo);
    break;
  }
  case 'detach': {
    const purge = flags.has('--purge');
    if (flags.has('--all')) { if (dry) { out(dryText(regRead().repos.map((x) => `detach  ${x.mode.padEnd(14)} ${x.repo}`), 'remove')); break; } detachAll(purge); break; }
    const repo = repoRoot();
    if (dry) { out(dryText(footprint(repo).map((it) => `remove  ${it.state.padEnd(22)} ${it.what}`), 'remove')); break; }
    if (flags.has('--user')) unwireClaude(repo, { user: true });
    else if (flags.has('--claude')) unwireClaude(repo, {});
    else {
      // no flag: reverse whatever this repo's receipt says is attached, older git hooks included,
      // so a bare `detach` is always the inverse of the `attach` you ran.
      const a = readManifest(manifestPath(repo)).attachments || {};
      const hasClaude = !!(a.claude || a['claude-shared']);
      if (hasClaude) unwireClaude(repo, {});
      if (a.git || !hasClaude) unwireGit(repo);
    }
    if (purge) purgeRecord(repo);
    syncExclude(repo, readManifest(manifestPath(repo)));   // after a purge the exclude lines go too
    const left = recordLeft(repo);
    if (left.length) out(`sawbuck: still on disk: ${left.join(', ')}. It is the record, kept out of git status; \`sawbuck detach --purge\` removes it.`);
    if (flags.has('--verify')) verifyClean(repo);
    break;
  }
  case 'doctor': { if (flags.has('--all')) doctorAll(); else doctorRepo(repoRoot()); break; }
  case 'rules': { out(rulesCli(rest)); break; }
  case 'shape': { out(shapeCli(rest)); break; }
  case 'steers': { out(steersReport({ json: flags.has('--json') })); break; }
  case 'statusline': {
    // compact status-line segment for the cwd repo. Never throws; fast.
    try {
      const repo = gitTop(process.cwd());
      if (!repo) process.stdout.write('🐴 sawbuck · no repo here');
      if (repo) {
        const name = basename(repo);
        const { caught, state, steer } = repoState(repo);
        // the last verdict from the activity feed (includes verified passes), so you see it working each turn
        let last = '';
        try { const L = readFileSync(join(repo, '.sawbuck', 'activity.jsonl'), 'utf8').trim().split('\n'); const e = JSON.parse(L[L.length - 1]); last = { verified: '✓', gamed: '🚩', regression: '✗', inconclusive: '≈', allowed: '✎' }[e.kind] || ''; } catch {}
        const label = caught > 0 ? `${caught} caught` : state;
        const seg = label ? `🐴 sawbuck · ${label}` : '';
        const named = label ? `🐴 sawbuck · ${name} · ${label}` : '';   // which repo it detected, in the default line
        const base = named ? (last ? `${named} · ${last}` : named) : '';
        // live steering % from the reins engine's file (OFFLINE read; reins does the LLM work, never sawbuck)
        const st = steer ? `${steer.rate >= 50 ? '✊' : '🐎'} steer ${steer.rate}%` : '';
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
function contextBlock(repo, speak) {
  const g = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  // new files count: re-creating what was reverted is the case the history is for
  let changed = [...new Set([...g('diff', '--name-only', 'HEAD').split('\n'), ...g('ls-files', '--others', '--exclude-standard').split('\n')])].filter(Boolean);
  if (!changed.length) changed = g('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean);
  if (!changed.length) return speak ? '🐴 sawbuck: nothing changed to look up (no working edits, and no previous commit to read).' : '';
  const fileArgs = changed.flatMap((f) => ['--file', f]);
  let o = '';
  try { o = execFileSync(process.execPath, [join(HERE, 'rank.mjs'), '--repo', repo, ...fileArgs, '--top', '3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { o = (e.stdout || '').toString(); }
  const erased = erasedBlock(repo, changed);
  if (/relevant history/.test(o)) return [o.trimEnd(), erased].filter(Boolean).join('\n');
  if (erased) return erased;
  return speak ? '🐴 sawbuck: no notable history for the files you are touching (a clean trail).' : '';
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
  else out(`   ⚠ I could not measure anything here yet: ${rep ? inconclusiveWhy(rep, repo) : 'the check did not run'} I stay quiet until then.`);
}

// --- the attach receipt (out of the worktree, inside .git) ------------------
function manifestPath(repo) { return join(gitDir(repo), 'sawbuck', 'attach.json'); }
function userManifestPath() { return join(homedir(), '.sawbuck', 'user-attach.json'); }
function readManifest(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { version: 1, attachments: {} }; } }
function writeManifest(p, m) {
  if (!Object.keys(m.attachments || {}).length) { delFile(p); rmIfEmptyDir(dirname(p)); return; }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
}

function delFile(p) { try { if (existsSync(p)) unlinkSync(p); } catch {} }
function rmIfEmptyDir(d) { try { if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d); } catch {} }

// --- .git/info/exclude: keep the worktree clean without touching .gitignore --
// Any attachment keeps the block, the last one out takes it. Returns whether the file changed.
function excludeFile(repo) { return gitPath(repo, 'info/exclude'); }
// The lines stay while the record they hide is still on disk: clearing them would put .sawbuck/ in git status and a
// signed repo would fail its own hooks-frozen rule over Sawbuck's record. --purge deletes the record, then the lines.
function syncExclude(repo, manifest) {
  if (Object.keys(manifest.attachments || {}).length) return ensureExcluded(repo);
  return hiddenLeft(repo).length ? false : clearExcluded(repo);
}
// the record paths still on disk and not tracked (a committed LOGBOOK.md is the person's file)
function recordLeft(repo) {
  const tracked = (p) => { try { return !!execFileSync('git', ['-C', repo, 'ls-files', '--', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return false; } };
  return ['.sawbuck/', '.promptwheel/outcomes.jsonl', 'events.jsonl', 'annotations.jsonl', 'LOGBOOK.md', 'JOURNEY.md'].filter((p) => existsSync(join(repo, p)) && !tracked(p));
}
// what the block hides that is still there: the record, and a settings.local.json the person keeps
function hiddenLeft(repo) {
  const local = join(repo, '.claude', 'settings.local.json');
  let own = false; try { own = existsSync(local) && !execFileSync('git', ['-C', repo, 'ls-files', '--', '.claude/settings.local.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  return [...recordLeft(repo), ...(own ? ['.claude/settings.local.json'] : [])];
}

// --- git post-commit (attach --git) -----------------------------------------
// For any agent or none: every commit is checked, whatever made it. The hook prefers a `sawbuck` on PATH (so it
// survives a reinstall), then the absolute path of the sawbuck that attached, then the same version through npx.
function hookBlock(repo) {
  const r = JSON.stringify(repo);
  // git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE into its hooks. The check shells out to git and would
  // inherit them, operate on the wrong repo, and silently catch nothing. Clear them first.
  return `${S_START}\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_COMMON_DIR\nif command -v sawbuck >/dev/null 2>&1; then sawbuck __hook --repo ${r}; elif [ -f ${JSON.stringify(SELF)} ]; then ${nodeCmd()} ${JSON.stringify(SELF)} __hook --repo ${r}; else npx -y sawbuck@${version} __hook --repo ${r}; fi || true\n${S_END}\n`;
}
function wireGit(repo) {
  const pc = gitPath(repo, 'hooks/post-commit');
  const existed = existsSync(pc);
  let body = existed ? readFileSync(pc, 'utf8') : '#!/bin/sh\n';
  if (body.includes(S_START)) { out(`sawbuck: already attached (git) in ${repo}`); return; }
  if (!body.startsWith('#!')) body = '#!/bin/sh\n' + body;
  if (!body.endsWith('\n')) body += '\n';
  if (dry) {
    out(dryText([
      `${existed ? 'modify' : 'create'}  ${pc}  (post-commit hook block)`,
      `exclude ${excludeFile(repo)}  (${EXCLUDED.join(', ')})`,
      `create  ${manifestPath(repo)}  (attach receipt)`,
    ]));
    return;
  }
  writeFileSync(pc, body + hookBlock(repo));
  chmodSync(pc, 0o755);
  const m = readManifest(manifestPath(repo));
  m.attachments = { ...m.attachments, git: { pc: { created: !existed } } };
  syncExclude(repo, m);
  writeManifest(manifestPath(repo), m);
  regAdd(repo, 'git');
  out(`sawbuck: attached (git post-commit) in ${repo}. Every commit is checked, whatever made it.`);
}
function unwireGit(repo) {
  const pc = gitPath(repo, 'hooks/post-commit');
  const m = readManifest(manifestPath(repo));
  const hasReceipt = !!m.attachments?.git;
  // signing with no attach still hides the record, so a repo with no receipt can have a block to take back
  if (!existsSync(pc) && !hasReceipt) { out(syncExclude(repo, m) ? `sawbuck: removed the record lines from ${excludeFile(repo)}` : 'sawbuck: nothing to detach'); return; }
  if (existsSync(pc)) {
    const stripped = readFileSync(pc, 'utf8').replace(BLOCK_RE, '\n').replace(/\n{3,}/g, '\n\n');
    const created = m.attachments?.git?.pc?.created;
    // true inverse: if we created this hook and it is trivial again, remove it
    if ((created || !hasReceipt) && isTrivialHook(stripped)) delFile(pc);
    else writeFileSync(pc, stripped);
  }
  if (hasReceipt) { delete m.attachments.git; syncExclude(repo, m); writeManifest(manifestPath(repo), m); }
  regRemove(repo, 'git');
  out(`sawbuck: detached (git) from ${repo}`);
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
    try { if (OURS.test(readFileSync(uf, 'utf8'))) { out(`sawbuck: already watching here through your user-level hooks (${uf}); nothing to add`); return; } } catch {}
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
  // attached already? "already attached" only when every hook of THIS version is present; an older
  // attachment (say, without the SessionStart[compact] hook) is upgraded in place, never left stale.
  let upgrading = false;
  if (OURS.test(JSON.stringify(cfg))) {
    const has = (event, command, matcher) => ((cfg.hooks || {})[event] || []).some((h) => h && (matcher ? h.matcher === matcher : !h.matcher) && Array.isArray(h.hooks) && h.hooks.some((x) => x && x.command === command));
    if (has('UserPromptSubmit', ctx) && has('SessionStart', ctx, 'compact') && has('Stop', chk)) { out(`sawbuck: already attached (${user ? 'user' : shared ? 'shared' : 'claude'}) in ${f}`); return; }
    upgrading = true;
  }
  if (dry) {
    out(dryText([
      `${upgrading ? 'update' : fileExisted ? 'modify' : 'create'}  ${f}  (UserPromptSubmit + SessionStart[compact] + Stop hooks: the per-turn block, and the check)`,
      user ? null : `exclude ${excludeFile(repo)}  (${EXCLUDED.join(', ')})`,
      `create  ${user ? userManifestPath() : manifestPath(repo)}  (attach receipt)`,
      !user && existsSync(join(repo, 'promptwheel.config.json')) ? `write   ${join(repo, '.sawbuck', 'state.json')}  (the turn baseline, so this turn's own signing is not read as the agent's)` : null,
    ].filter(Boolean)));
    return;
  }
  cfg.hooks = cfg.hooks || {};
  const put = (event, command, matcher) => {
    cfg.hooks[event] = (cfg.hooks[event] || []).filter((h) => !OURS.test(JSON.stringify(h)));
    cfg.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
  };
  put('UserPromptSubmit', ctx);
  // right after a compaction the summary has just dropped detail: re-impress the contract frame there too
  // (SessionStart with the `compact` source injects stdout into context).
  put('SessionStart', ctx, 'compact');
  put('Stop', chk);
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
  // attach often runs inside a turn (saying yes to the offer), and that turn's Stop hook then has no baseline, so the
  // files signing just wrote would read as the agent's violations. What is here now is the baseline; anything after it counts.
  if (!user && existsSync(join(repo, 'promptwheel.config.json'))) {
    try {
      ensureExcluded(repo);
      const stPath = join(repo, '.sawbuck', 'state.json');
      let st = {}; try { st = JSON.parse(readFileSync(stPath, 'utf8')); } catch {}
      if (!st.turnBaseline) {
        let sha = ''; try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
        st.turnBaseline = { sha, files: protectedDirty(repo, { store: true }), by: 'attach' };
        st.lastPromptAt = new Date().toISOString();
        mkdirSync(dirname(stPath), { recursive: true }); writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n');
      }
    } catch {}
  }
  const mode = user ? 'user' : shared ? 'claude-shared' : 'claude';
  const mp = user ? userManifestPath() : manifestPath(repo);
  const m = readManifest(mp);
  const prev = (m.attachments || {})[mode];   // an upgrade keeps the receipt of what the first attach created
  m.attachments = { ...m.attachments, [mode]: { file: f, fileCreated: prev ? !!prev.fileCreated : !fileExisted, dirCreated: prev ? !!prev.dirCreated : !dirExisted } };
  if (!user) syncExclude(repo, m);
  writeManifest(mp, m);
  regAdd(repo, mode);
  const kind = user ? 'USER-LEVEL' : shared ? 'shared project' : 'project';
  out(upgrading ? `sawbuck: updated the ${kind} Claude Code hooks in ${f} to this version` : `sawbuck: wired ${kind} Claude Code hooks in ${f}`);
  if (shared) out(`  commit ${relative(repo, f)} so the team gets the check. It runs sawbuck ${version} through npx on every machine.`);
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
          if ((rec?.fileCreated || !rec) && isTrivialSettings(cfg)) { delFile(f); if (rec?.dirCreated) rmIfEmptyDir(dirname(f)); }
          else writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
          out(`sawbuck: removed Claude Code hooks from ${f}`);
          did = true;
        }
      }
    }
    if (rec) { delete m.attachments[mode]; touched = true; }
  }
  if (touched) { if (!user) syncExclude(repo, m); writeManifest(mp, m); }
  for (const mode of modes) regRemove(repo, mode);
  if (!did && !touched) out('sawbuck: no Claude attachment found to detach');
}
function removeClaudeEntries(cfg) {
  if (!cfg.hooks) return;
  for (const ev of ['UserPromptSubmit', 'SessionStart', 'Stop']) {
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
function purgeRecord(repo) {
  let n = 0;
  for (const d of RECORD_DIRS) {
    const p = join(repo, d);
    // a committed LOGBOOK.md or JOURNEY.md is the person's file, not our record
    try { if (execFileSync('git', ['-C', repo, 'ls-files', '--', d], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) continue; } catch {}
    try { if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); n++; out(`sawbuck: purged ${p}`); } } catch {}
  }
  const outcomes = join(repo, '.promptwheel', 'outcomes.jsonl');   // the rest of .promptwheel/ is the signed contract: yours to keep or delete
  try { if (existsSync(outcomes)) { rmSync(outcomes, { force: true }); n++; out(`sawbuck: purged ${outcomes}`); } } catch {}
  if (!n) out('sawbuck: no record to purge');
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
    const cmds = Object.values((cfg && cfg.hooks) || {}).flat().flatMap((h) => (h && Array.isArray(h.hooks) ? h.hooks : [])).map((x) => x && x.command).filter((c) => typeof c === 'string' && OURS.test(c));
    if (cmds.length) checks.push({ mode, file: f, ok: [...new Set(cmds)].every(hookRuns) });
  }
  // the receipt says hooks were wired here, and they are gone: a removal git status cannot show (the file is excluded)
  const receipt = Object.keys(readManifest(manifestPath(repo)).attachments || {}).filter((m) => m.startsWith('claude') && !checks.some((c) => c.mode === m));
  if (!checks.length && !receipt.length) { out(`sawbuck: no attachment in ${repo}, nothing to check.`); return; }
  let bad = receipt.length;
  out(`sawbuck doctor, ${repo}:`);
  for (const c of checks) {
    if (!c.ok) bad++;
    out(`  ${c.ok ? 'OK   ' : 'STALE'} ${c.mode.padEnd(14)} ${c.file}${c.ok ? '' : '  (the hook does not run: what it calls is gone; run sawbuck attach again)'}`);
  }
  for (const m of receipt) out(`  GONE  ${m.padEnd(14)} the receipt says hooks were wired here, but the hooks are gone. Run sawbuck attach again, or sawbuck detach to drop the receipt.`);
  if (bad) process.exitCode = 1;
}
function doctorAll() {
  const r = regRead();
  if (!r.repos.length) { out('sawbuck: not attached anywhere.'); return; }
  out('sawbuck is attached to:');
  for (const x of r.repos) out(`  ${x.mode.padEnd(14)} ${x.repo}`);
  for (const repo of new Set(r.repos.map((x) => x.repo))) doctorRepo(repo);
}

// --- every attachment, in one list, so there is one way out of all of them ---
function regPath() { return join(homedir(), '.sawbuck', 'registry.json'); }
function regRead() { try { const r = JSON.parse(readFileSync(regPath(), 'utf8')); r.repos = (r.repos || []).filter((x) => existsSync(x.repo)); return r; } catch { return { repos: [] }; } }   // a repo that is gone is not attached
function regWrite(r) {
  const f = regPath();
  if (!r.repos.length) { delFile(f); rmIfEmptyDir(dirname(f)); return; }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(r, null, 2) + '\n');
}
function regAdd(repo, mode) { const r = regRead(); r.repos = r.repos.filter((x) => !(x.repo === repo && x.mode === mode)); r.repos.push({ repo, mode, at: new Date().toISOString() }); regWrite(r); }
function regRemove(repo, mode) { const r = regRead(); r.repos = r.repos.filter((x) => !(x.repo === repo && x.mode === mode)); regWrite(r); }
function detachAll(purge) {
  const r = regRead();
  if (!r.repos.length) { out('sawbuck: nothing to detach: not attached anywhere.'); return; }
  for (const x of [...r.repos]) {
    if (x.mode === 'git') unwireGit(x.repo);
    else if (x.mode === 'user') unwireClaude(x.repo, { user: true });
    else unwireClaude(x.repo, {});
    if (purge) purgeRecord(x.repo);
    syncExclude(x.repo, readManifest(manifestPath(x.repo)));
  }
  out('sawbuck: detached everywhere.');
}
// --- shared helpers ---------------------------------------------------------
function dryText(plan, verb = 'leave') { return verb === 'remove' ? ['sawbuck --dry-run: would remove (changing nothing):', ...(plan.length ? plan.map((p) => '  ' + p) : ['  nothing: no wiring here'])].join('\n') : ['sawbuck --dry-run: would leave this footprint (writing nothing):', ...plan.map((p) => '  ' + p), '  all of it reversible with `detach`.'].join('\n'); }
