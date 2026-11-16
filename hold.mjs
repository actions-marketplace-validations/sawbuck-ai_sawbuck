// A hold that holds: some commands go outside the repo and cannot be taken back (a publish, a release, a merge, a public
// comment, a force push). The holds bench (2026-11-08) showed a later ask talks the agent past a hold written in
// CLAUDE.md (6 of 9 pushed when asked to); a PreToolUse hook does not get talked past. Wired by `attach` on PreToolUse for
// Bash: a matching command is turned into a question to the person ("ask"); everything else passes untouched. The list is
// the default below plus `holds.outward` in sawbuck.config.json; `{"holds":{"off":true}}` turns it off for a repo.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { guardPath } from './guard.mjs';

export const ALLOW = /\b(sawbuck|promptwheel)(\.mjs)?\b[^|;&]*\s--allow\b/;
// Sawbuck's own record (.sawbuck/) and the second copy its hooks keep (.git/sawbuck/) are what the end of a turn is
// checked from, and both are out of git status: a write there shows in no diff. So a command that detaches sawbuck, a
// command that names either folder, and an edit tool pointed into one each become a question to the person. Asked
// whether the outward holds are on or off, like --allow: it is how the check itself is taken away. Reading is not
// asked. It is a question, not a wall: a command that reaches those files without naming them is not seen here.
// The folder of the same name in a person's home (~/.sawbuck/: their own holds, and what `rules` and `shape` gather)
// is not a repo's record, and the plugin's own commands name it: never asked here.
export const DETACH = /\bsawbuck(?:\.mjs)?["']?(?:@[\w.-]+)?["']?\s+detach\b/;
const BG_COMMIT = /\bgit\b[^|;&]*\s(?:commit|merge|rebase|cherry-pick|am|revert)\b/;
const PLAIN_READ = /^\s*(?:cat|ls|head|tail|wc|stat|file|less|more)\b[^;&|<>`$]*$/;
export function namesRepoRecord(command, home = process.env.HOME || homedir()) {
  const c = String(command || '');
  if (/\.git\/sawbuck(?![\w-])/.test(c)) return true;
  const re = /(?:^|[^\w.-])\.sawbuck(?![\w.-])/g; let m;
  while ((m = re.exec(c))) {
    const before = c.slice(0, m.index + m[0].indexOf('.sawbuck'));
    if (['~', '$HOME', '${HOME}', home].filter(Boolean).some((h) => before.endsWith(`${h}/`))) continue;   // the home folder
    return true;
  }
  return false;
}
const OWN_WHY = 'Sawbuck: this detaches Sawbuck or touches its own record (.sawbuck/, or .git/sawbuck/), which is what the end of a turn is checked from. Approve only if you asked for it, not the agent.';
const askOwn = () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: OWN_WHY } });
// the edit tools (Edit, Write and the like): a file under either folder
export function ownRecordEdit(hookJson, repo) {
  let h = {}; try { h = JSON.parse(hookJson || '{}'); } catch {}
  if (h.hook_event_name !== 'PreToolUse' || !h.tool_input || typeof h.tool_input !== 'object' || !repo) return null;
  const f = String(h.tool_input.file_path || h.tool_input.notebook_path || ''); if (!f) return null;
  const abs = resolve(repo, f); const gp = guardPath(repo);
  const under = (dir) => !!dir && (abs === dir || abs.startsWith(dir + sep));
  return (under(join(resolve(repo), '.sawbuck')) || under(gp ? dirname(gp) : '')) ? askOwn() : null;
}
export const OUTWARD = [
  ['npm publish', /\bnpm\s+publish\b/], ['pnpm publish', /\bpnpm\s+publish\b/], ['yarn publish', /\byarn\s+(npm\s+)?publish\b/],
  ['gh release', /\bgh\s+release\s+(create|upload|edit|delete)\b/], ['gh pr merge', /\bgh\s+pr\s+merge\b/],
  ['gh issue comment', /\bgh\s+issue\s+comment\b/], ['gh pr comment', /\bgh\s+pr\s+(comment|review)\b/], ['gh pr create', /\bgh\s+pr\s+create\b/],
  ['git push --force', /\bgit\s+push\b[^|;&]*\s(--force\b|-f\b|--force-with-lease\b|\+[\w/]+)/], ['git push --delete', /\bgit\s+push\b[^|;&]*\s(--delete|-d)\b/],
  ['vercel --prod', /\b(npx\s+)?vercel\b[^|;&]*--prod\b/], ['cargo publish', /\bcargo\s+publish\b/], ['twine upload', /\btwine\s+upload\b/], ['gem push', /\bgem\s+push\b/],
];

// the repo's holds (sawbuck.config.json) and the person's own, for every repo and none (~/.sawbuck/config.json):
// patterns add up; either one saying off turns the hold off where it says it
export function holdConfig(repo, home = process.env.HOME || homedir()) {
  const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')).holds || {}; } catch { return {}; } };
  const mine = read(join(home, '.sawbuck', 'config.json')), here = repo ? read(join(repo, 'sawbuck.config.json')) : {};
  return { off: !!(here.off || mine.off), outward: [...(Array.isArray(mine.outward) ? mine.outward : []), ...(Array.isArray(here.outward) ? here.outward : [])] };
}

// the hold a command trips, or null
export function outwardHold(command, repo) {
  const c = String(command || '');
  const cfg = holdConfig(repo);
  if (cfg.off) return null;
  const extra = (Array.isArray(cfg.outward) ? cfg.outward : []).map((p) => { try { return [String(p), new RegExp(p)]; } catch { return null; } }).filter(Boolean);
  for (const [name, re] of [...OUTWARD, ...extra]) if (re.test(c)) return name;
  return null;
}

// the PreToolUse answer: a question to the person for an outward command, nothing for everything else
export function holdDecision(hookJson, repo) {
  let h = {}; try { h = JSON.parse(hookJson || '{}'); } catch {}
  if (h.tool_name && h.tool_name !== 'Bash') return null;
  const cmd = h.tool_input && typeof h.tool_input.command === 'string' ? h.tool_input.command : '';
  // --allow records a person's decision to accept what the check could not prove; the agent typing it is not that.
  // Always asked, holds off or not: it is how a gamed verdict is cleared.
  if (DETACH.test(cmd) || (namesRepoRecord(cmd) && !PLAIN_READ.test(cmd))) return askOwn();
  // a commit made by a background task lands after the end of the turn, where a commit is read as the person's own
  // (unless the task reports back first: then the prompt hook keeps the turn's baseline). Asked like the two above.
  if (h.tool_input && h.tool_input.run_in_background === true && BG_COMMIT.test(cmd)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Sawbuck: this runs in the background and commits. A commit that lands after the turn has ended is not checked with the turn. Approve only if you asked for it; or have the agent commit in the turn.' } };
  if (ALLOW.test(cmd)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Sawbuck: --allow records that a person accepts a change the check could not prove (a test, config or protected file changed). Approve only if you decided it, not the agent. A yes is kept as your reason for the check on the commit. It does not let an agent\'s own edit to a protected path stand at the end of the turn: to keep one, make that edit yourself.' } };
  const name = outwardHold(cmd, repo);
  if (!name) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Sawbuck hold: "${name}" ${repo && existsSync(join(repo, '.git')) ? 'goes outside this repo and ' : ''}cannot be taken back, so a person approves it. Say what it is for; to stop asking here, set {"holds":{"off":true}} in sawbuck.config.json.` } };
}
