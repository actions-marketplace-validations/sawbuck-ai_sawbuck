// The record is not the only witness. Sawbuck's record lives under .sawbuck/, kept out of git status, so the rule that
// names that folder cannot see a write there: the end-of-turn check finds changed protected paths through git. On 0.1.67,
// after a gamed commit was sent back, deleting or rewriting that record ended the turn with no send-back
// (proof-bench/record-tamper, 2026-11-12). A file the agent can rewrite unseen must not be what decides that.
//
// So the hooks keep two things a second time, in the git folder beside the attach receipt (.git/sawbuck/guard.json):
//   baseline   what the prompt hook recorded when the turn began (the commit, the protected files already dirty, the
//              rules in force), so a turn whose state file is gone at its end is checked from where it began;
//   standing   a gamed verdict the end-of-turn hook sent back (the commit, the base it was measured from, the file),
//              so a record that no longer says so is put back, and the span is proved again from the source.
// Only the engine's own pass over that span, or a person's reason (`sawbuck check --allow`), takes `standing` down.
//
// Since 0.1.69 the second copy also holds what the end-of-turn hook itself counts, and the hook reads it from here:
//   baseline   is used whole when a turn ends (its commit, the tips it listed, the dirty files, the lock, the rules,
//              and how many send-backs the repo allowed when the prompt began), whatever the state file says;
//   own        the last commit the hook looked at (`seen`), how many times this prompt was sent back, the marks for
//              notices said once, and whether a turn is open. On 0.1.68 these were read from the state file, and one
//              field edited there ended a turn on a gamed commit with nothing said (record-tamper, amendments 2 and 3).
//   detached   `sawbuck detach` arrived while a turn was open. The session read its hooks when it began, so they
//              still run: that turn is checked from here to its end, and then this file goes.
//
// What this does not close (proof-bench/record-tamper has both cases, open): a record rewritten to say a person allowed
// the change copies a person's yes, and nothing kept on the machine can tell a copy from the real thing. An agent that
// removes both copies has removed both; the hold asks a person before a command that names either (hold.mjs), and a
// command that reaches them without naming them is not seen. This makes the cheap ways round fail, not every way.
// The check itself, and a run in CI, read none of this.
// No model, no network. Never throws.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const gitDir = (repo) => { try { return resolve(repo, execFileSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { return ''; } };
export const guardPath = (repo) => { const d = gitDir(repo); return d ? join(d, 'sawbuck', 'guard.json') : ''; };

export function readGuard(repo) {
  try { const g = JSON.parse(readFileSync(guardPath(repo), 'utf8')); return (g && typeof g === 'object' && !Array.isArray(g)) ? g : {}; } catch { return {}; }
}

// merge `patch` into the guard; a key set to null is removed
export function writeGuard(repo, patch) {
  try {
    const p = guardPath(repo); if (!p) return;
    const next = { ...readGuard(repo), ...patch };
    for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
    mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(next) + '\n');
  } catch { /* the guard never fails a hook */ }
}

// what the end-of-turn hook counts and remembers, kept under `own` (with `seen`, the last commit it looked at)
export const OWN = ['blockPromptId', 'blockCount', 'mandatePromptId', 'mandateBlocks', 'mandateCountedPrompt', 'depNoticed', 'lockNotice', 'shownTotal'];
export const ownOf = (st) => { const o = { seen: (st && st.lastSha) || '' }; for (const k of OWN) if (st && st[k] !== undefined && st[k] !== null) o[k] = st[k]; return o; };
export const turnOpen = (g) => !!(g && g.own && g.own.turnOpen);

// detach: the hooks are gone, so nothing is checked from a second copy either. While a turn is open the copy stays,
// marked, until that turn ends (the end-of-turn hook removes it); true when it stayed.
export function detachGuard(repo) {
  const g = readGuard(repo);
  if (turnOpen(g)) { writeGuard(repo, { detached: new Date().toISOString() }); return true; }
  clearGuard(repo); return false;
}
export function clearGuard(repo) {
  try { const p = guardPath(repo); if (!p) return; rmSync(p, { force: true }); try { rmdirSync(dirname(p)); } catch { /* the attach receipt may still be there */ } } catch {}
}
