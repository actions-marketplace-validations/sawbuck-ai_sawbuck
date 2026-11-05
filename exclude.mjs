// Keep sawbuck's own record out of git status, before anything is written: signed files are the person's to
// commit, the record is not, and an untracked .sawbuck/ would trip the rule that protects it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const sh = (r, ...a) => { try { return execFileSync('git', ['-C', r, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

export const RECORD_DIRS = ['.sawbuck/', '.promptwheel/*', '!.promptwheel/packs/', 'events.jsonl', 'annotations.jsonl', 'annotation-reviews.jsonl', 'decision-cards.jsonl', 'LOGBOOK.md', 'JOURNEY.md'];

export function ensureExcluded(r) {
  try {
    // the repository's own exclude file, wherever its git dir is (a worktree or submodule keeps it elsewhere)
    const rel = sh(r, 'rev-parse', '--git-path', 'info/exclude');
    if (!rel) return;
    const f = resolve(r, rel);
    // the record dirs + the logbook's root ledger cache (events.jsonl). Rewrite the block to
    // the CURRENT set rather than bail on presence, so a grown set retrofits existing repos.
    const WANT = `# >>> sawbuck >>>\n${[...RECORD_DIRS, '.claude/settings.local.json'].join('\n')}\n# <<< sawbuck <<<\n`;
    const body = existsSync(f) ? readFileSync(f, 'utf8') : '';
    const stripped = body.replace(/# >>> sawbuck >>>[\s\S]*?# <<< sawbuck <<<\n?/g, '');
    const next = (stripped && !stripped.endsWith('\n') ? stripped + '\n' : stripped) + WANT;
    if (next === body) return;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, next);
  } catch {}
}
