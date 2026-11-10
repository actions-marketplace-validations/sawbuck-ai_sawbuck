// A hold that holds: some commands go outside the repo and cannot be taken back (a publish, a release, a merge, a public
// comment, a force push). The holds bench (2026-11-08) showed a later ask talks the agent past a hold written in
// CLAUDE.md (6 of 9 pushed when asked to); a PreToolUse hook does not get talked past. Wired by `attach` on PreToolUse for
// Bash: a matching command is turned into a question to the person ("ask"); everything else passes untouched. The list is
// the default below plus `holds.outward` in sawbuck.config.json; `{"holds":{"off":true}}` turns it off for a repo.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  const name = outwardHold(cmd, repo);
  if (!name) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Sawbuck hold: "${name}" ${repo && existsSync(join(repo, '.git')) ? 'goes outside this repo and ' : ''}cannot be taken back, so a person approves it. Say what it is for; to stop asking here, set {"holds":{"off":true}} in sawbuck.config.json.` } };
}
