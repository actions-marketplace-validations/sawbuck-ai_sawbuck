#!/usr/bin/env node
// sawbuck, the CLI. Zero-dep.
// `attach` wires Sawbuck's reflex into a repo (a git post-commit hook by default,
// or Claude Code hooks); `detach` removes it and leaves the repo exactly as it
// was. Isolation invariant: the repo never imports Sawbuck, and detach is a true
// inverse of attach. Rides two engines: promptwheel (the check) + @promptwheel/logbook.
//
// How removal stays honest: attach writes a receipt to .git/sawbuck/attach.json
// recording every file/dir it created or modified and every .git/info/exclude
// line it added. detach reads the receipt and reverses exactly that, deleting
// what it created, stripping only its own lines from what it modified, touching
// nothing it did not touch. `trace` prints the footprint; `detach --verify`
// proves the repo came back clean; `doctor` checks the attachment still resolves.

import { execFileSync } from 'node:child_process';
import { erasedBlock } from './rewrites.mjs';
import { steersReport } from './steers.mjs';
import { ensureExcluded } from './exclude.mjs';
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync, unlinkSync, rmdirSync, rmSync, readdirSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { recall as memRecall, conform as memConform } from './memory.mjs';
import { PW } from './bins.mjs';
import { frameBlock, mandatesInForce, protectedDirty, blobAt, lockState } from './contract.mjs';

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const HOOK = join(HERE, 'sawbuck-hook.mjs');
// run the engine and parse its JSON verdict (it prints JSON even when it exits nonzero)
function gateReport(repo, a) {
  let o = '', code = 0;
  try { o = execFileSync(process.execPath, [PW, ...a, '--no-record', '--json'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: +(process.env.SAWBUCK_CHECK_TIMEOUT_MS) || 120000 }); }
  catch (e) { o = (e.stdout || '').toString(); code = e.status || 0; }
  let rep = null; try { rep = JSON.parse(o.slice(o.indexOf('{'))); } catch {}
  return { rep, code };
}
// is the metric live (actually ran), or inert (never ran in isolation)?
const metricLive = (m) => !!m && !m.inert && m.status !== 'unmeasurable' && m.before != null;
const S_START = '# >>> sawbuck >>>';
const S_END = '# <<< sawbuck <<<';
const BLOCK_RE = new RegExp(`\\n?${S_START}[\\s\\S]*?${S_END}\\n?`, 'g');
// the record/state dirs the engines write into the worktree; excluded locally so
// attach never dirties `git status`.
// The record Sawbuck keeps on disk but must never let dirty git status: the engine records
// plus the logbook's root working-set (ledger cache, digests, annotation planes). It is
// memory, not the user's source, a user who wants LOGBOOK.md committed still can explicitly
// (exclude only affects UNtracked files).
const RECORD_DIRS = ['.sawbuck/', '.promptwheel/*', '!.promptwheel/packs/', 'events.jsonl', 'annotations.jsonl', 'annotation-reviews.jsonl', 'decision-cards.jsonl', 'LOGBOOK.md', 'JOURNEY.md'];

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
// `-n N` (sawbuck log) is a flag with a value, not a repo path.
const positional = rest.filter((a, i) => !a.startsWith('--') && a !== '-n' && rest[i - 1] !== '-n');
const repoArg = () => resolve(positional[0] || '.');
const dry = flags.has('--dry-run');

let version = '0.0.0';
try { version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version; } catch {}

const help = `sawbuck ${version}: sign your agent to a contract

Usage:
  sawbuck check [repo] [--base R --head R] [--repeat N] [--allow "<reason>"] [--json]
                            Verify your latest change right now (working tree if dirty, else the last
                            commit, or the range you name). Zero-config, no attach, no hook. The
                            fastest way to see it work. Every promptwheel run flag passes through.
                            Exit 0 verified · 1 regression · 2 gamed · 3 inconclusive · 64 could not run
  sawbuck init [--yes] [--wizard] [--no-investigate] [--no-agent-block]
                            Write the contract (promptwheel.config.json), tuned and explained by what your
                            git history shows actually breaks, plus a short contract guide in AGENTS.md
                            (--no-agent-block to skip). Wizard in a terminal, non-interactive in a pipe/CI (or --yes).
  sawbuck attach [repo]     Enforce the contract on every commit (a git post-commit hook)
      --claude              instead on every Claude Code turn (project hooks in .claude/settings.local.json)
      --shared              with --claude, write the tracked .claude/settings.json (team-shared, visible in git)
      --user                user-level Claude hooks that follow your cwd (attach once, every project)
      --dry-run             print the exact footprint it would leave, and write nothing
  sawbuck detach [repo] [--claude | --user] [--all] [--verify] [--purge]
                            Remove it and restore the repo (no flag: whatever is attached here); --verify
                            proves it came back clean; --purge also deletes the record (.sawbuck/)
  sawbuck status [repo]     The inventory: caught over time + debt accruing now + whether it is armed. --json
  sawbuck log [repo] [-n N] Recent checks, newest first (verified / gamed / regression)
  sawbuck debt [repo] [--since REF] [--fail-on undocumented|test|any|N]
                            The live suppression debt in HEAD, risk-ranked, undocumented flagged. --since REF
                            shows only what a branch adds; --fail-on exits nonzero (a CI gate)
  sawbuck context [repo]    Relevant history for the files you are changing (reverts, weakened tests, hot spots)
  sawbuck frame [repo]      The contract's hard rules (mandates, inherited ones included) as one compact block;
                            silent without a contract (--speak explains)
  sawbuck turn [repo]       frame + context in one block: what attach --claude runs on every prompt

  sawbuck trace [repo]      Show every file Sawbuck has placed in this repo (the footprint)
  sawbuck doctor [repo]     Check the attachment still resolves to a live sawbuck; --all for every repo
  sawbuck where             List every repo Sawbuck is attached to
  sawbuck contract          Sign this repo: tests, tripwires, protected paths, and the architecture lock (--dry-run to preview)
  sawbuck steers            What you keep correcting, from the plugin's scratchpad on this machine (--json)
  sawbuck statusline        One-line segment for your status line (🐴 watching | N caught | steer %)

  sawbuck recall [repo]     Related notes for your changes from extra memory providers
                            (SAWBUCK_MEMORY=logbook,obsidian + OBSIDIAN_VAULT), alongside context
  sawbuck memory-conformance <bin>
                            Check a provider bin speaks the Memory Contract (recall/debt/record)
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
  out(flags.has('--all') ? help : `sawbuck ${version}: sign your agent to a contract

  sawbuck contract   sign this repo: protected paths, your tests, CI
  sawbuck check      verify your latest change right now
  sawbuck status     what it has caught here

  sawbuck help --all   everything else`);
  process.exit(0);
}

switch (cmd) {
  case 'contract': {
    const top = gitTop(repoArg());
    if (!top) usage(`${repoArg()} is not a git repository (a contract signs one; run it inside your project)`);
    try { execFileSync(process.execPath, [join(HERE, 'contract-cmd.mjs'), top, ...rest.filter((a) => ['--dry-run', '--strict', '--no-ci'].includes(a))], { stdio: 'inherit' }); }
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
    // now, and whether it is armed here. The "show me everything" face.
    try { execFileSync(process.execPath, [join(HERE, 'status.mjs'), '--repo', repoArg(), ...rest.filter((a) => a.startsWith('--'))], { stdio: 'inherit' }); }
    catch (e) { process.exit(e.status || 1); }
    break;
  }
  case 'check': {
    // one-shot: gate your latest change right now (working tree if dirty, else the last commit),
    // zero-config (the engine auto-detects your test command), and say plainly whether the win was
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
    const { rep, code } = gateReport(repo, [...args, ...pass]);
    if (!rep || !rep.verdict) { out('🐴 sawbuck: could not run the check here. Make sure this is a git repo with a commit, and a test command (or run `sawbuck init`).'); process.exit(64); }
    if (json) { out(JSON.stringify(rep)); process.exit(code); }
    const m = (rep.metrics || [])[0];
    for (const md of rep.mandates || []) out(`🐴 ⛔ mandate "${md.name}" violated${md.reason ? ': ' + md.reason : ''}  (touched: ${(md.files || []).join(', ')})${md.removed ? '  [deleted in this same change; a mandate stays in force for the change that removes it]' : ''}`);
    const win = (rep.metrics || []).find((x) => x.status === 'improved' && !x.tripwire);
    if (rep.verdict === 'pass' && win) out(`🐴 ✓ verified: your ${where} change earned it. "${win.name}" improved, and the source carried the win (it survives a source-only re-run).`);
    else if (rep.verdict === 'pass') out(`🐴 ✓ held: nothing got worse in your ${where} change, and there was no win to re-prove.`);
    else if (rep.verdict === 'gamed') out('🐴 🚩 gamed: a win here came from editing the test, config, or grader, not the source. It does NOT survive a source-only re-run, so it does not count.');
    else if (rep.verdict === 'fail' && (rep.mandates || []).length) out('🐴 ✗ sent back: a hard rule in the contract was broken, however green the rest is.');
    else if (rep.verdict === 'fail') out('🐴 ✗ sent back: this change made something worse.');
    else out('🐴 ≈ inconclusive: the check ran but could not measure your metric (it did not run in isolation). Point it at your real test command: `sawbuck init`, or set setup/linkDirs in promptwheel.config.json.');
    if ((rep.metrics || []).some((x) => x.heldByTestEdit)) out('🐴 ⚠ your tests changed too, and the old tests fail on this source. Fine for an intended change. Otherwise check the tests were not weakened: a green that stays green is not proved.');
    for (const x of rep.explained || []) out(`🐴 ${x.noted ? 'note' : 'needs a look'}: ${x.what}${x.items ? ': ' + x.items.join(', ') : ''}${!x.noted && x.allowable ? '. If you meant this: --allow "<reason>", or on a pull request comment sawbuck-allow: <reason>' : ''}`);
    if (rep.gate && rep.gate.changed) out(`🐴 ⚠ the gate definition changed in this change (fingerprint ${rep.gate.fingerprint.base} -> ${rep.gate.fingerprint.head}): a metric, guard, evaluatorPath or mandate was added, removed or edited.`);
    process.exit(code);
  }
  case 'log': {
    // the event feed: a running log of what the check did, so you can watch it work.
    const repo = repoArg();
    let lines = [];
    try { lines = readFileSync(join(repo, '.sawbuck', 'activity.jsonl'), 'utf8').split('\n').filter(Boolean); } catch {}
    if (!lines.length) { out('sawbuck: no activity recorded yet (the check logs here on each commit/turn).'); break; }
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
    break;
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
    else if (flags.has('--speak')) out('🐴 sawbuck frame: no mandates in promptwheel.config.json yet. Add one (a protected path) and this re-asserts it every turn and after every compaction, so a deep context cannot forget it.');
    break;
  }
  case 'turn': {
    // the ONE per-prompt hook: the contract frame (forward: what must hold) and the relevant history
    // (backward: what broke here before) in a single block, one process per prompt. Silent when
    // there is nothing to say. Wired by `attach --claude` on UserPromptSubmit and after a compaction.
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
    let hookEvent = '';
    if (flags.has('--hook') && !process.stdin.isTTY) { try { hookEvent = String(JSON.parse(readFileSync(0, 'utf8') || '{}').hook_event_name || ''); } catch {} }
    if (hookEvent === 'UserPromptSubmit' && top) {
      try {
        ensureExcluded(repo);   // before the first write: under user-level hooks nothing else has done it yet
        const stDir = join(repo, '.sawbuck'); const stPath = join(stDir, 'state.json');
        let st = {}; try { st = JSON.parse(readFileSync(stPath, 'utf8')); } catch {}
        const now = new Date().toISOString();
        {   // a baseline even with no rules yet: a turn that signs a contract is judged by the contract it began with
          const prev = st.turnBaseline && typeof st.turnBaseline === 'object' ? st.turnBaseline : null;
          const stoppedSince = st.lastStopAt && st.lastPromptAt && Date.parse(st.lastStopAt) >= Date.parse(st.lastPromptAt);
          const unfinished = !!prev && !!st.lastPromptAt && !stoppedSince;
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
        st.lastPromptAt = now;   // every prompt, mandates or not: the walls key their block budgets on it when the harness sends no prompt_id
        mkdirSync(stDir, { recursive: true }); writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n');
      } catch { /* the frame never fails a prompt */ }
    }
    const o = [frameBlock(repo), contextBlock(repo, false)].filter(Boolean).join('\n');
    if (o) out(o);
    break;
  }
  case 'recall': {
    // the notes face: supplementary relevant notes for your current changes, from any non-git memory
    // provider (e.g. an Obsidian vault). On-demand. Git history + live debt come from context / debt.
    const repo = repoRoot();
    const g = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
    let changed = g('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
    if (!changed.length) changed = g('diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean);
    if (!changed.length) { out('🐴 sawbuck: nothing changed to look up.'); break; }
    const notes = memRecall(repo, changed);
    if (!notes.length) { out('🐴 sawbuck: no related notes (configure extra memory providers with SAWBUCK_MEMORY, e.g. logbook,obsidian; logbook history is in `sawbuck context`).'); break; }
    out(`🐴 related notes for ${changed.length} changed path${changed.length === 1 ? '' : 's'} (leads, not conclusions):`);
    for (const n of notes) out(`  - [${n.source}] ${n.summary}${n.ref ? `  (${n.ref})` : ''}`);
    break;
  }
  case 'memory-conformance': {
    // check that a provider bin speaks the Memory Contract (recall returns Finding[]; debt returns
    // Suppression[] or exits nonzero to signal it is not a git-truth provider). Read-only probe.
    const bin = positional[0];
    if (!bin) die('usage: sawbuck memory-conformance <provider-bin>   (a bin speaking the contract verbs recall/debt/record)');
    const r = memConform(bin, process.cwd());
    out(`🐴 memory-conformance: ${bin}`);
    out(`   recall: ${r.recall}`);
    out(`   debt:   ${r.debt}`);
    out(r.pass ? '   ✓ conforms to the Memory Contract.' : '   ✗ does not conform (see above).');
    process.exit(r.pass ? 0 : 1);
  }
  case '__hook': {
    try { execFileSync(process.execPath, [HOOK, ...rest], { stdio: 'inherit' }); } catch (e) { process.exit(e.status || 0); }
    break;
  }
  case 'attach': {
    const user = flags.has('--user');
    const top = gitTop(repoArg());
    if (!top && !user) usage(`${repoArg()} is not a git repository (attach wires one; run it inside your project, or name its path)`);
    const repo = top || repoArg();
    if (user) { wireClaude(repo, { user: true }); if (!dry) verifyAttach(repo); break; }
    if (flags.has('--claude')) { wireClaude(repo, { shared: flags.has('--shared') }); if (!dry) verifyAttach(repo); break; }
    wireGit(repo);
    if (!dry) verifyAttach(repo);
    break;
  }
  case 'detach': {
    const purge = flags.has('--purge');
    if (flags.has('--all')) { detachAll(purge); break; }
    const repo = repoRoot();
    if (flags.has('--user')) unwireClaude(repo, { user: true });
    else if (flags.has('--claude')) unwireClaude(repo, {});
    else {
      // no flag: reverse whatever this repo's receipt says is attached (git and/or project Claude
      // hooks), so a bare `detach` is always the inverse of the `attach` you ran.
      const a = readManifest(manifestPath(repo)).attachments || {};
      const hasClaude = !!(a.claude || a['claude-shared']);
      if (hasClaude) unwireClaude(repo, {});
      if (a.git || !hasClaude) unwireGit(repo);
    }
    if (purge) purgeRecord(repo);
    if (flags.has('--verify')) verifyClean(repo);
    break;
  }
  case 'trace': { traceRepo(repoRoot()); break; }
  case 'doctor': { if (flags.has('--all')) doctorAll(); else doctorRepo(repoRoot()); break; }
  case 'where': { whereAttached(); break; }
  case 'steers': { out(steersReport({ json: flags.has('--json') })); break; }
  case 'statusline': {
    // compact status-line segment for the cwd repo. Never throws; fast.
    try {
      const repo = gitTop(process.cwd());
      if (!repo) process.stdout.write('🐴 sawbuck · no repo here');
      if (repo) {
        const name = basename(repo);
        let caught = 0;
        try { const r = JSON.parse(readFileSync(join(repo, '.sawbuck', 'results.json'), 'utf8')); caught = (r.regressions || 0) + (r.gamed || 0) + (r.mandates || 0); } catch {}
        // the last verdict from the activity feed (includes verified passes), so you see it working each turn
        let last = '';
        try { const L = readFileSync(join(repo, '.sawbuck', 'activity.jsonl'), 'utf8').trim().split('\n'); const e = JSON.parse(L[L.length - 1]); last = { verified: '✓', gamed: '🚩', regression: '✗', inconclusive: '≈', allowed: '✎' }[e.kind] || ''; } catch {}
        // one state model, shared with the Reins band: watching (wired in) / ready (checkable, not wired yet) / memory (history only)
        const active = existsSync(join(repo, '.sawbuck', 'state.json'));
        const armed = existsSync(join(repo, 'promptwheel.config.json')) || existsSync(join(repo, 'package.json'));
        const mem = existsSync(join(repo, 'LOGBOOK.md')) || existsSync(join(repo, 'events.jsonl'));
        const label = caught > 0 ? `${caught} caught` : active ? 'watching' : armed ? 'ready' : mem ? 'memory' : '';
        const seg = label ? `🐴 sawbuck · ${label}` : '';
        const named = label ? `🐴 sawbuck · ${name} · ${label}` : '';   // which repo it detected, in the default line
        const base = named ? (last ? `${named} · ${last}` : named) : '';
        // live steering % from the reins engine's file (OFFLINE read; reins does the LLM work, never sawbuck)
        let st = '';
        try { const sj = JSON.parse(readFileSync(join(repo, '.sawbuck', 'steer.json'), 'utf8')); if (sj && sj.scored) { const p = Math.round(((sj.ema != null ? sj.ema : sj.steeringRate) || 0) * 100); st = `${p >= 50 ? '✊' : '🐎'} steer ${p}%`; } } catch {}
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

// --- the per-turn block: frame (forward, from contract.mjs) + context (backward) ---------------
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
  else out('   ⚠ I could not measure anything here yet (your test command did not run in isolation). Point me at it: `sawbuck init`, or set setup/linkDirs in promptwheel.config.json. I stay quiet until then.');
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
// Rewrites a single marked block to the union of excludes the current
// attachments need. Never deletes the file (an empty one is git's own default).
function excludeFile(repo) { return gitPath(repo, 'info/exclude'); }
function syncExclude(repo, manifest) {
  const need = new Set();
  const a = manifest.attachments || {};
  if (Object.keys(a).length) for (const d of RECORD_DIRS) need.add(d);     // any attach → the check may write the record dirs
  if (a.claude) need.add('.claude/settings.local.json');                    // default claude settings are local; hide them too
  const lines = [...need];
  const f = excludeFile(repo);
  let body = (existsSync(f) ? readFileSync(f, 'utf8') : '').replace(BLOCK_RE, '\n').replace(/\n{3,}/g, '\n\n');
  if (lines.length) {
    if (body && !body.endsWith('\n')) body += '\n';
    body += `${S_START}\n${lines.join('\n')}\n${S_END}\n`;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
  } else if (existsSync(f)) {
    writeFileSync(f, body);                                                 // strip our block, leave the rest
  }
}

// --- git post-commit --------------------------------------------------------
// The hook prefers a `sawbuck` on PATH (so it survives a reinstall/upgrade) and
// falls back to the absolute path of the sawbuck that attached (dev checkouts).
function hookBlock(repo) {
  const r = JSON.stringify(repo);
  // git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE into its hooks. The check
  // shells out to git (worktrees, diffs) and would inherit them, operate on the wrong
  // repo, and silently catch nothing. Clear them so the reflex runs against `repo` clean.
  return `${S_START}\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_COMMON_DIR\nif command -v sawbuck >/dev/null 2>&1; then sawbuck __hook --repo ${r}; else ${nodeCmd()} ${JSON.stringify(SELF)} __hook --repo ${r}; fi || true\n${S_END}\n`;
}
function wireGit(repo) {
  if (!gitTop(repo)) usage(`${repo} is not a git repository`);
  const pc = gitPath(repo, 'hooks/post-commit');
  const existed = existsSync(pc);
  let body = existed ? readFileSync(pc, 'utf8') : '#!/bin/sh\n';
  if (body.includes(S_START)) { out(`sawbuck: already attached (git) in ${repo}`); return; }
  if (!body.startsWith('#!')) body = '#!/bin/sh\n' + body;
  if (!body.endsWith('\n')) body += '\n';
  if (dry) {
    out(dryText([
      `${existed ? 'modify' : 'create'}  ${pc}  (post-commit hook block)`,
      `exclude ${excludeFile(repo)}  (${RECORD_DIRS.join(', ')})`,
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
  out(`sawbuck: attached (git post-commit) in ${repo}`);
}
function unwireGit(repo) {
  const pc = gitPath(repo, 'hooks/post-commit');
  const m = readManifest(manifestPath(repo));
  const hasReceipt = !!m.attachments?.git;
  if (!existsSync(pc) && !hasReceipt) { out('sawbuck: nothing to detach'); return; }
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
// Project default writes the gitignored settings.local.json; --shared writes the
// tracked settings.json on purpose. Safe merge; refuses malformed JSON; idempotent.
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
    try { if (readFileSync(uf, 'utf8').includes('sawbuck.mjs')) { out(`sawbuck: already watching here through your user-level hooks (${uf}); nothing to add`); return; } } catch {}
  }
  const { dir, f } = claudeFile(repo, opts);
  const dirExisted = existsSync(dir);
  const fileExisted = existsSync(f);
  let cfg = {};
  if (fileExisted) { try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { die(`${f} exists but is not valid JSON; I will not overwrite it. Add the hooks by hand.`); } }
  const ctx = user ? `${nodeCmd()} ${JSON.stringify(SELF)} turn --hook` : `${nodeCmd()} ${JSON.stringify(SELF)} turn --hook ${JSON.stringify(repo)}`;
  const chk = user ? `${nodeCmd()} ${JSON.stringify(SELF)} __hook --by claude --stop` : `${nodeCmd()} ${JSON.stringify(SELF)} __hook --repo ${JSON.stringify(repo)} --by claude --stop`;
  // attached already? "already attached" only when every hook of THIS version is present; an older
  // attachment (say, without the SessionStart[compact] hook) is upgraded in place, never left stale.
  let upgrading = false;
  if (JSON.stringify(cfg).includes('sawbuck.mjs')) {
    const has = (event, command, matcher) => ((cfg.hooks || {})[event] || []).some((h) => h && (matcher ? h.matcher === matcher : !h.matcher) && Array.isArray(h.hooks) && h.hooks.some((x) => x && x.command === command));
    if (has('UserPromptSubmit', ctx) && has('SessionStart', ctx, 'compact') && has('Stop', chk)) { out(`sawbuck: already attached (${user ? 'user' : 'claude'}) in ${f}`); return; }
    upgrading = true;
  }
  if (dry) {
    out(dryText([
      `${upgrading ? 'update' : fileExisted ? 'modify' : 'create'}  ${f}  (UserPromptSubmit + SessionStart[compact] + Stop hooks: the per-turn block, and the check)`,
      user ? null : `exclude ${excludeFile(repo)}  (${RECORD_DIRS.join(', ')}${shared ? '' : ', .claude/settings.local.json'})`,
      `create  ${user ? userManifestPath() : manifestPath(repo)}  (attach receipt)`,
    ].filter(Boolean)));
    return;
  }
  cfg.hooks = cfg.hooks || {};
  const put = (event, command, matcher) => {
    cfg.hooks[event] = (cfg.hooks[event] || []).filter((h) => !JSON.stringify(h).includes('sawbuck.mjs'));
    cfg.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
  };
  put('UserPromptSubmit', ctx);
  // right after a compaction the summary has just dropped detail: re-impress the contract frame and the
  // relevant history there too (SessionStart with the `compact` source injects stdout into context).
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
        st.turnBaseline = { sha, files: protectedDirty(repo, { store: true }) };
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
  out(upgrading ? `sawbuck: updated the ${user ? 'USER-LEVEL' : shared ? 'shared project' : 'project'} Claude Code hooks in ${f} to this version`
                : `sawbuck: wired ${user ? 'USER-LEVEL' : shared ? 'shared project' : 'project'} Claude Code hooks in ${f}`);
  if (user) out('  profile-switches by cwd: memory in any git repo, the check where a promptwheel.config.json exists.');
  else if (!shared) out('  (settings.local.json is gitignored; use --shared to commit the hooks for your team)');
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
      if (raw.includes('sawbuck.mjs')) {
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
    cfg.hooks[ev] = cfg.hooks[ev].filter((h) => !JSON.stringify(h).includes('sawbuck.mjs'));
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];     // no empty [] residue
  }
  if (cfg.hooks && !Object.keys(cfg.hooks).length) delete cfg.hooks;
}
function isTrivialSettings(cfg) { return Object.keys(cfg).length === 0; }

// --- trace / verify / doctor / purge: show, prove, and clean the footprint --
function footprint(repo) {
  const items = [];
  const pc = gitPath(repo, 'hooks/post-commit');
  try { if (existsSync(pc) && readFileSync(pc, 'utf8').includes(S_START)) items.push({ what: pc, state: 'git hook' }); } catch {}
  for (const f of [join(repo, '.claude', 'settings.local.json'), join(repo, '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.json')]) {
    try { if (existsSync(f) && readFileSync(f, 'utf8').includes('sawbuck.mjs')) items.push({ what: f, state: 'claude hooks' }); } catch {}
  }
  const xf = excludeFile(repo);
  try { if (existsSync(xf) && readFileSync(xf, 'utf8').includes(S_START)) items.push({ what: xf, state: 'local exclude' }); } catch {}
  for (const d of RECORD_DIRS) if (existsSync(join(repo, d))) items.push({ what: join(repo, d), state: 'record dir (ignored)' });
  const mp = manifestPath(repo);
  if (existsSync(mp)) { const m = readManifest(mp); items.push({ what: mp, state: `receipt: ${Object.keys(m.attachments || {}).join(', ') || 'empty'}` }); }
  return items;
}
function traceRepo(repo) {
  const items = footprint(repo);
  if (!items.length) { out(`sawbuck: no footprint in ${repo}, nothing attached.`); return; }
  out(`sawbuck footprint in ${repo}:`);
  for (const it of items) out(`  ${it.state.padEnd(22)} ${it.what}`);
  out('\n  detach reverses every line above; `detach --verify` proves it.');
}
function verifyClean(repo) {
  // the record dirs may stay (your data, unless --purge); the mechanism must be gone.
  const left = footprint(repo).filter((it) => !/record dir/.test(it.state));
  if (!left.length) out('sawbuck: verified, the repo is back to how it was (mechanism fully removed).');
  else { out('sawbuck: NOT clean, these remain:'); for (const it of left) out(`  ${it.state.padEnd(22)} ${it.what}`); process.exitCode = 1; }
}
function purgeRecord(repo) {
  let n = 0;
  for (const d of RECORD_DIRS) {
    const p = join(repo, d);
    try { if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); n++; out(`sawbuck: purged ${p}`); } } catch {}
  }
  const outcomes = join(repo, '.promptwheel', 'outcomes.jsonl');   // the rest of .promptwheel/ is the signed contract: yours to keep or delete
  try { if (existsSync(outcomes)) { rmSync(outcomes, { force: true }); n++; out(`sawbuck: purged ${outcomes}`); } } catch {}
  if (!n) out('sawbuck: no record to purge');
}
// is `sawbuck` resolvable on PATH? (SAWBUCK_NO_PATH_CHECK forces the strict/offline answer)
function onPath() {
  if (process.env.SAWBUCK_NO_PATH_CHECK) return false;
  try { execFileSync('sh', ['-c', 'command -v sawbuck'], { stdio: 'ignore' }); return true; } catch { return false; }
}
// the path a hook bakes in: the quoted one ending in sawbuck.mjs, in a shell hook or in JSON, where the quotes are escaped
function extractBaked(text) { const m = text.match(/"([^"]*sawbuck\.mjs)\\?"/); return m ? m[1] : null; }
function doctorRepo(repo) {
  const checks = [];
  const pc = gitPath(repo, 'hooks/post-commit');
  try { if (existsSync(pc)) { const b = readFileSync(pc, 'utf8'); if (b.includes(S_START)) checks.push({ mode: 'git', file: pc, baked: extractBaked(b) }); } } catch {}
  for (const [mode, f] of [['claude', join(repo, '.claude', 'settings.local.json')], ['claude-shared', join(repo, '.claude', 'settings.json')]]) {
    try { if (existsSync(f)) { const b = readFileSync(f, 'utf8'); if (b.includes('sawbuck.mjs')) checks.push({ mode, file: f, baked: extractBaked(b) }); } } catch {}
  }
  if (!checks.length) { out(`sawbuck: no attachment in ${repo}, nothing to check.`); return; }
  const pathOk = onPath();
  let bad = 0;
  out(`sawbuck doctor, ${repo}:`);
  for (const c of checks) {
    const ok = pathOk || (c.baked ? existsSync(c.baked) : false);
    if (!ok) bad++;
    out(`  ${ok ? 'OK   ' : 'STALE'} ${c.mode.padEnd(14)} ${c.file}${ok ? '' : `  (baked path gone: ${c.baked || '?'} and sawbuck not on PATH, re-attach or install it)`}`);
  }
  out(pathOk ? '\n  sawbuck resolves on PATH, attachments survive a reinstall.' : '\n  tip: `npm i -g sawbuck` so hooks resolve by PATH and survive an upgrade.');
  if (bad) process.exitCode = 1;
}
function doctorAll() {
  const r = regRead();
  if (!r.repos.length) { out('sawbuck: nothing to check (registry empty).'); return; }
  const repos = [...new Set(r.repos.map((x) => x.repo))];
  for (const repo of repos) doctorRepo(repo);
}

// --- registry: know and remove every attachment -----------------------------
function regPath() { return join(homedir(), '.sawbuck', 'registry.json'); }
function regRead() { try { return JSON.parse(readFileSync(regPath(), 'utf8')); } catch { return { repos: [] }; } }
function regWrite(r) {
  const f = regPath();
  if (!r.repos.length) { delFile(f); rmIfEmptyDir(dirname(f)); return; }
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(r, null, 2) + '\n');
}
function regAdd(repo, mode) { const r = regRead(); r.repos = r.repos.filter((x) => !(x.repo === repo && x.mode === mode)); r.repos.push({ repo, mode, at: new Date().toISOString() }); regWrite(r); }
function regRemove(repo, mode) { const r = regRead(); r.repos = r.repos.filter((x) => !(x.repo === repo && x.mode === mode)); regWrite(r); }
function whereAttached() {
  const r = regRead();
  if (!r.repos.length) { out('sawbuck: not attached anywhere (registry empty).'); return; }
  out('sawbuck is attached to:');
  for (const x of r.repos) out(`  ${x.mode.padEnd(14)} ${x.repo}`);
}
function detachAll(purge) {
  const r = regRead();
  if (!r.repos.length) { out('sawbuck: nothing to detach (registry empty).'); return; }
  for (const x of [...r.repos]) {
    if (x.mode === 'git') unwireGit(x.repo);
    else if (x.mode === 'user') unwireClaude(x.repo, { user: true });
    else unwireClaude(x.repo, {});
    if (purge) purgeRecord(x.repo);
  }
  out('sawbuck: detached everywhere.');
}

// --- shared helpers ---------------------------------------------------------
function dryText(plan) { return ['sawbuck --dry-run: would leave this footprint (writing nothing):', ...plan.map((p) => '  ' + p), '  all of it reversible with `detach`.'].join('\n'); }
