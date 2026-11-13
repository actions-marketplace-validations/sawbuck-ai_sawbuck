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
// What this does not close (proof-bench/record-tamper has both cases, open): a record rewritten to say a person allowed
// the change, and a state file rewritten to say the commit was already looked at. Those copy a person's yes, or the
// hooks' own bookkeeping, and nothing kept on the machine can tell a copy from the real thing. An agent that removes
// both copies has removed both. This makes the cheap ways round fail (a file or the folder deleted, blanked or garbled,
// one verdict flipped), not every way. The check itself, and a run in CI, read none of this.
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

// detach: the hooks are gone, so nothing is checked from a second copy either
export function clearGuard(repo) {
  try { const p = guardPath(repo); if (!p) return; rmSync(p, { force: true }); try { rmdirSync(dirname(p)); } catch { /* the attach receipt may still be there */ } } catch {}
}
