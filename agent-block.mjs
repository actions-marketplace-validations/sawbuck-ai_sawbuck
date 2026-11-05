import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Write (or refresh) the agent-orienting contract block so a coding agent (or a loop not wired to the
// `attach --claude` hook) knows the rules. AGENTS.md (the cross-tool convention; created if absent) +
// CLAUDE.md / .cursorrules when present. Idempotent + safe: only the sentinel-delimited block is
// touched. `--no-agent-block` skips it.
export function writeAgentBlock(repo) {
  const START = '<!-- sawbuck:contract -->', END = '<!-- /sawbuck:contract -->';
  const block = `${START}\n## Sawbuck contract\n\nThis repo is under a Sawbuck contract: a change is done only when the win survives verification from the source alone. Before finishing, run \`npx -y sawbuck check\`. If it reads \`gamed\`, the green came from editing a test, config, or grader, not the source, so undo that and earn it in the source. Run \`npx -y sawbuck context\` after your first edit to see what broke in these files before (reverts, weakened tests, fragile spots). Never skip, weaken, or delete a test to go green.\n${END}\n`;
  const targets = ['AGENTS.md', ...['CLAUDE.md', '.cursorrules'].filter((f) => existsSync(join(repo, f)))];
  const done = [];
  for (const f of targets) {
    const p = join(repo, f);
    let text = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const s = text.indexOf(START);
    if (s > -1) { const e = text.indexOf(END, s); text = (e > -1 ? text.slice(0, s) + block + text.slice(e + END.length).replace(/^\n+/, '\n') : text.slice(0, s) + block); }
    else { text = (text.trim() ? text.replace(/\n*$/, '\n\n') : '') + block; }
    try { writeFileSync(p, text); done.push(f); } catch { /* best-effort */ }
  }
  return done;
}
