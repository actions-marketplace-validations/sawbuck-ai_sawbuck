#!/usr/bin/env node
import { ensureExcluded } from './exclude.mjs';
import { shareFinding } from './share.mjs';
// sawbuck-hook.mjs: the Sawbuck Claude Code Stop-hook entry.
// Each turn: if a new commit landed, run reflect on it; then say so once on a fresh catch. State in .sawbuck/state.json.
// Zero-dep. Usage (wired as a Stop hook): node sawbuck-hook.mjs --repo <path>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
import { mandateHits, hashOf, protectedAmong, lockState } from './contract.mjs';
const flag = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const by = flag('--by', '');   // attribution from the harness wiring: the Claude hook passes 'claude', the raw-git hook passes nothing
const stop = process.argv.includes('--stop');   // wired as the Claude Code Stop hook: enforce the contract on a gamed turn
// user-level wiring passes no --repo: the hook runs in whatever cwd the session has, so it resolves the
// repository root itself (a subdirectory belongs to its repo) and leaves a non-repository alone: no
// state, no exclude block, nothing written where there is nothing to verify.
const userMode = !process.argv.includes('--repo');
const sh = (cwd, ...a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const repo = flag('--repo', '') || sh(process.cwd(), 'rev-parse', '--show-toplevel') || process.cwd();
const git = (...a) => sh(repo, ...a);
if (!git('rev-parse', '--git-dir')) process.exit(0);
let hookInput = {};
if (stop) { try { hookInput = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch {} }   // the Stop hook's JSON on stdin (stop_hook_active, prompt_id, ...)
ensureExcluded(repo);   // keep the record out of git status under ANY attach mode (incl. --user)

const CHECK_TIMEOUT = +(process.env.SAWBUCK_CHECK_TIMEOUT_MS) || 600000;   // never hang a turn
const node = (f, a) => { try { return execFileSync(process.execPath, [f, ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT, killSignal: 'SIGKILL' }); } catch (e) { return (e.stdout || '').toString(); } };

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(repo, 'sawbuck.config.json'), 'utf8')); } catch {}

const stDir = join(repo, '.sawbuck');
const stPath = join(stDir, 'state.json');
let st = { lastSha: '', turns: 0, shownTotal: 0 };
try { if (existsSync(stPath)) st = JSON.parse(readFileSync(stPath, 'utf8')); } catch {}

// 1) new commit(s) since last turn → run the check on them. A gamed verdict stands until the span it
// was measured over re-proves verified: while the latest record is gamed, the re-run keeps that
// record's base, so a follow-up commit (an amend, an empty commit, unrelated work) cannot clear the
// wall without the source fix the re-proof demands. Under user-level wiring the check runs only where
// a contract exists (--no-auto): nobody's whole test suite runs three times in a repo they never set up.
const head = git('rev-parse', 'HEAD');
const readRec = () => { try { return JSON.parse(readFileSync(join(stDir, 'results.json'), 'utf8')); } catch { return null; } };
const writeRec = (r) => { try { mkdirSync(stDir, { recursive: true }); writeFileSync(join(stDir, 'results.json'), JSON.stringify(r, null, 2) + '\n'); } catch {} };
const logActivity = (ev) => { try { mkdirSync(stDir, { recursive: true }); appendFileSync(join(stDir, 'activity.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...ev }) + '\n'); } catch {} };
const hasCommit = (ref) => { try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; } };
let rec = readRec();
// the span re-proved is the TURN's: from the commit HEAD was at when the prompt began (the turn baseline) to HEAD now. Commits
// the person made between turns (a red test first, a merge, a pull) are theirs, not the agent's, and are not scored; a
// standing gamed verdict keeps its own base below. The first turn after attach has no baseline yet and starts from lastSha.
const isAncestor = (a, b) => { try { execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; } };
const tb = (st.turnBaseline && st.turnBaseline.sha) || '';
const from = (tb && st.lastSha && tb !== st.lastSha && isAncestor(st.lastSha, tb)) ? tb : (st.lastSha || tb || '');
if (head && from && head !== from) {
  let standing = !!(rec && rec.latest && rec.latest.kind === 'gamed' && rec.latest.base && rec.latest.sha !== head.slice(0, 8));
  if (standing && !hasCommit(rec.latest.base)) {
    // the span can no longer be re-proved (a rebase, a squash, a pruned branch took its base away):
    // say so in the feed, drop the record to unverified (never blocked on), and keep checking new
    // commits from the last one seen, so the wall's loss is visible instead of a silent stop
    logActivity({ kind: 'note', sha: head.slice(0, 8), file: rec.latest.file || '', reason: 'the base of the standing gamed verdict is gone from this clone (rebased or pruned); the record is cleared and new commits are checked from the last one seen', by: by || 'hook' });
    rec.latest = { ...rec.latest, kind: 'unverified', at: new Date().toISOString(), reason: 'the base of the gamed verdict left the clone before the span re-proved from the source' };
    writeRec(rec);
    standing = false;
  }
  // a rebase or a reset inside the turn: HEAD no longer descends from `from`, and the span from..head would blame
  // upstream's commits on the agent (an upstream test edit read as the agent's gamed green). Re-prove only the commits
  // that are new since the turn began and on no remote: the agent's own, replayed on top. Nothing new means the agent
  // only rebased, and there is nothing of its own to re-prove.
  // The agent's own commits = new since the turn began, not reachable from any ref tip that existed at the turn's start,
  // and on no remote. In a plain turn that is exactly from..head. After a rebase or a merge of upstream inside the turn,
  // it is the agent's commits replayed on top, and upstream's commits (an upstream test edit among them) stay upstream's.
  // Merge commits themselves are not re-proved: the span starts at the agent's first own non-merge commit.
  let base = standing ? rec.latest.base : from; let skip = false;
  if (!standing) {
    const tips = (st.turnBaseline && Array.isArray(st.turnBaseline.refs)) ? st.turnBaseline.refs : [];
    let own = git('rev-list', '--no-merges', head, `^${from}`, ...tips.map((t) => `^${t}`), '--not', '--remotes').split('\n').filter(Boolean);
    // a rebase replays commits that existed before the turn under new shas (the person's own branch commits among them);
    // a replayed commit is patch-equivalent to one reachable from a recorded tip, and `git cherry` marks those "-"
    if (own.length && tips.length) {
      for (const t of tips) {
        const fresh = new Set(git('cherry', t, head).split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2).trim()));
        own = own.filter((c) => fresh.has(c));
        if (!own.length) break;
      }
    }
    if (!own.length) { logActivity({ kind: 'note', sha: head.slice(0, 8), file: '', reason: 'the commits this turn added came from elsewhere (a rebase, a merge, a fast-forward); none is the agent\'s own, nothing to re-prove', by }); skip = true; }
    else base = git('rev-parse', `${own[own.length - 1]}^`).trim() || from;
  }
  if (!skip) node(join(HERE, 'reflect.mjs'), ['--repo', repo, '--base', base, '--head', head, ...(by ? ['--by', by] : []), ...(userMode ? ['--no-auto'] : [])]);
  rec = readRec();
}
st.lastSha = head || st.lastSha;
st.turns += 1;

// 2) the record of what the check has charted (read above, after any re-run)
const total = rec ? (rec.regressions || 0) + (rec.gamed || 0) + (rec.mandates || 0) : 0;
const saveState = () => { try { mkdirSync(stDir, { recursive: true }); writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n'); } catch {} };
// the budget is per prompt: prompt_id when the harness sends one, else the prompt's own timestamp (written by
// `sawbuck turn --hook`), never a constant that would spend it for good
const promptId = hookInput.prompt_id || st.lastPromptAt || 'none';
// Send the turn back, at most enforce.maxBlocks times per prompt, then let it end with a warning: it can never
// loop, because the harness's own block cap resets on every tool call.
const sendBack = (idKey, countKey, reason, stillOpen) => {
  const max = +(cfg.enforce?.maxBlocks) || 3;
  if (st[idKey] !== promptId) { st[idKey] = promptId; st[countKey] = 0; }
  const spent = (st[countKey] || 0) >= max;
  if (!spent) st[countKey] = (st[countKey] || 0) + 1;
  saveState();
  process.stdout.write(JSON.stringify(spent ? { systemMessage: `Sawbuck stopped blocking after ${max} tries: ${stillOpen}` } : { decision: 'block', reason }));
  process.exit(0);
};

// 2b) THE WALL AT TURN LEVEL (Claude Code Stop hook only): a mandate is checked against the WORKING
// tree on every stop, not only on commits, because an agent usually ends a turn with uncommitted
// edits. A deterministic path match, milliseconds, no metric run. Block the stop (bounded per prompt)
// and send the agent back to undo its protected edits and make the fix elsewhere. The rules are the
// working tree's AND the committed contract's (editing the config in the same turn lifts nothing),
// and a protected file that was already dirty with the same content when the prompt began (the
// baseline `sawbuck turn --hook` recorded) is the person's own work and does not count. A protected
// edit COMMITTED since the baseline's commit counts too: a commit mid-turn does not walk through.
if (stop && !process.env.SAWBUCK_NO_ENFORCE) {
  const now = new Date().toISOString();
  const dirty = [...new Set([...git('diff', '--name-only', '--no-renames', 'HEAD').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean))];
  const base = (st.turnBaseline && typeof st.turnBaseline === 'object') ? st.turnBaseline : null;
  const baseline = (base && base.files && typeof base.files === 'object') ? base.files : {};
  const committedSince = (base && base.sha && head && base.sha !== head) ? git('diff', '--name-only', '--no-renames', base.sha, 'HEAD').split('\n').filter(Boolean) : [];
  const hashNow = {}; for (const f of dirty) if (Object.prototype.hasOwnProperty.call(baseline, f)) hashNow[f] = hashOf(repo, f);
  const untouched = (f) => Object.prototype.hasOwnProperty.call(baseline, f) && hashNow[f] === baseline[f];
  // a person's own uncommitted file (in the baseline) that the turn only committed, content unchanged, is still theirs:
  // after /contract, the agent's `git add -A` sweeps the new contract into its commit, and that is not a protected edit
  const committedAsTheyWere = (f) => Object.prototype.hasOwnProperty.call(baseline, f)
    && (git('rev-parse', '--verify', '-q', `HEAD:${f}`) || 'deleted') === baseline[f]
    && (!dirty.includes(f) || untouched(f));
  const changed = [...new Set([...dirty.filter((f) => !untouched(f)), ...committedSince.filter((f) => !committedAsTheyWere(f))])];
  const leftAlone = [...new Set([...dirty.filter(untouched), ...committedSince.filter(committedAsTheyWere)])];
  // the rules in force when the turn began: a rule this turn adds does not apply to it, so signing a contract does
  // not block itself, and one it deletes or narrows still holds
  const hits = changed.length ? mandateHits(repo, changed, base && Array.isArray(base.rules) ? { list: base.rules } : {}) : [];
  st.lastStopAt = now;   // the next prompt may take a fresh baseline only because this stop happened
  st.lastStopHead = head || null;   // and where HEAD stood: a commit between turns is the person's, not the agent's
  if (hits.length) {
    // remember EVERY protected path THIS TURN changed (dirty past the baseline, or committed since
    // it) and what it holds, uncapped, plus the commit the baseline stood at, so the next prompt
    // cannot adopt any of it. Only the turn's own changes: a person's file the baseline spared stays
    // spared, or the next clean turn would be blocked over work that was never the agent's.
    const files = {};
    for (const f of protectedAmong(repo, changed)) files[f] = hashOf(repo, f);
    // a flagged file the person had dirty before the prompt: keep the hash of THEIR content (the
    // baseline stored it in the object database), so the block can name the exact restore and the
    // next baseline can recognise the restored file as theirs
    const before = {};
    for (const f of Object.keys(files)) if (Object.prototype.hasOwnProperty.call(baseline, f) && baseline[f] && baseline[f] !== 'deleted') before[f] = baseline[f];
    st.lastViolation = { at: now, sha: (base && base.sha) || null, files, ...(Object.keys(before).length ? { before } : {}) };
  } else if (st.lastViolation) { delete st.lastViolation; }
  saveState();
  if (hits.length) {
    const desc = hits.map((h) => `"${h.name}"${h.reason ? ' (' + h.reason + ')' : ''}: ${h.files.join(', ')}${h.committed ? ' [this rule is in the committed contract; editing promptwheel.config.json in the working tree does not lift it]' : ''}`).join('; ');
    const spared = leftAlone.length ? ` Edits that were already there before this prompt were left out of this check and must stay as they are: ${leftAlone.join(', ')}.` : '';
    const before = (st.lastViolation && st.lastViolation.before) || {};
    const restore = Object.keys(before).length ? ' To put back what you overwrote: ' + Object.entries(before).map(([f, h]) => `restore ${f} to the content it had when the prompt began: git cat-file -p ${h} > ${f}`).join('; ') + '.' : '';
    const committedHit = hits.some((h) => h.files.some((f) => committedSince.includes(f)));
    const accept = committedHit ? ' To accept this change on purpose, change the rule in the contract or revert the path.' : '';
    const upgrade = base ? '' : ' (No prompt baseline is recorded in this repo, so edits a person made before the prompt cannot be told apart from yours: ask them to run sawbuck attach again, which upgrades the hooks.)';
    // one catch per prompt, however many times the turn is sent back. Kept beside rec.latest, never in it:
    // a block must not replace a gamed verdict that is still standing.
    if (st.mandateCountedPrompt !== promptId) {
      st.mandateCountedPrompt = promptId;
      const r = readRec() || { regressions: 0, gamed: 0, latest: null };
      r.mandates = (r.mandates || 0) + 1;
      r.lastMandate = { name: hits[0].name, file: hits[0].files[0], at: now };
      writeRec(r);
      logActivity({ kind: 'mandate', file: hits[0].files[0], reason: `mandate ${hits[0].name} violated in the working tree`, by: by || 'hook' });
    }
    sendBack('mandatePromptId', 'mandateBlocks', `Sawbuck: a protected path in the contract was touched, the turn is not done. Protected paths changed in this turn: ${desc}. Undo the changes YOU made under the protected paths and make the fix elsewhere; do not revert anything you did not change (the rule is a wall, not a reminder; the gate fails any change that touches them).${spared}${restore}${accept}${upgrade}`, `protected paths are still changed (${desc}).`);
  }
}

// 3) CONTRACT ENFORCEMENT (Claude Code Stop hook only): if THIS turn's commit was gamed,
// block the stop and send the agent back to earn the green in the source. Bounded per
// prompt, because Claude Code's built-in block cap resets on every tool call and so cannot
// bound a tool-using agent on its own. Opt out with SAWBUCK_NO_ENFORCE=1 (falls back to a flag).
const gamedThisTurn = rec && rec.latest && rec.latest.kind === 'gamed' && rec.latest.sha === (head || '').slice(0, 8);
if (stop && gamedThisTurn && !process.env.SAWBUCK_NO_ENFORCE) {
  st.shownTotal = total;
  const where = rec.latest.file;
  // the catch is a finding too: handed once to whatever memory runs here, beside the rules and the reverted attempts
  // awaited: sendBack exits the process, and an unawaited hand-off died with it (found by hand against a live worker, 2026-11-08)
  await shareFinding(repo, { kind: 'gamed', title: `gamed: ${where} edited to pass`, text: rec.latest.reason || `A green on ${where} came from editing the test, config or grader, not the source.`, files: [where] }).catch(() => {});
  sendBack('blockPromptId', 'blockCount', `Sawbuck: the win on ${where} was gamed. It came from editing the test or config, not the source, so it did not survive a source-only re-run. The turn is not done: fix the source so the metric passes on its own, then finish.`, `the win on ${where} is still gamed and needs a real source fix.`);
}

// 3b) THE LOCK AT TURN LEVEL: tell the person the moment a turn changes the repo's structure or its resolved
// dependencies. A notice, not a block: a person who asked for a new dependency should not fight the wall, and
// the gate in CI is the hard stop, which needs their reason. Said once per change.
if (stop && !process.env.SAWBUCK_NO_ENFORCE && st.turnBaseline && st.turnBaseline.lock) {
  const was = st.turnBaseline.lock, now = lockState(repo);
  if (now) {
    const known = new Set(was.drift || []);
    const fresh = (now.drift || []).filter((i) => !known.has(i));
    const pinsMoved = !!now.pins && now.pins !== was.pins;
    const key = JSON.stringify([fresh, pinsMoved ? now.pins : '']);
    if ((fresh.length || pinsMoved) && st.lockNotice !== key) {
      st.lockNotice = key; saveState();
      const what = [...fresh.slice(0, 8), ...(pinsMoved ? ['the resolved dependency tree'] : [])].join(', ');
      process.stdout.write(JSON.stringify({ systemMessage: `Sawbuck: this turn changed what the lock holds: ${what}${fresh.length > 8 ? `, and ${fresh.length - 8} more` : ''}. If you did not ask for that, look before you commit. The gate needs your reason to pass it: promptwheel run --allow "<reason>".` }));
      process.exit(0);
    }
  }
}

// 4) otherwise, say a fresh catch once (a flag; never blocks). The band and statusline carry the rest.
if (total > (st.shownTotal || 0)) {
  const L = rec && rec.latest;
  process.stdout.write(`Sawbuck caught a ${L && L.kind === 'gamed' ? 'gamed change' : 'problem'}${L && L.file ? ` in ${L.file}` : ''}${L && L.reason ? `: ${L.reason}` : ''}\n`);
  st.shownTotal = total;
}
saveState();
