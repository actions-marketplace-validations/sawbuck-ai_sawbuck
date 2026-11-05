// Keep sawbuck's own record out of git status, before anything is written: signed files are the person's to
// commit, the record is not, and an untracked .sawbuck/ would trip the rule that protects it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const sh = (r, ...a) => { try { return execFileSync('git', ['-C', r, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

export const RECORD_DIRS = ['.sawbuck/', '.promptwheel/*', '!.promptwheel/packs/', 'events.jsonl', 'annotations.jsonl', 'LOGBOOK.md', 'JOURNEY.md'];

// everything the block hides, under any attach mode
export const EXCLUDED = [...RECORD_DIRS, '.claude/settings.local.json'];

// The one writer of the block, in the repository's own exclude file wherever its git dir is (a worktree or
// submodule keeps it elsewhere). Rewrites to the current set, so a grown set retrofits existing repos; no lines
// strips it. Returns whether the file changed; with `dry`, whether it would, writing nothing.
function writeBlock(r, lines, dry) {
  try {
    const rel = sh(r, 'rev-parse', '--git-path', 'info/exclude');
    if (!rel) return false;
    const f = resolve(r, rel);
    const body = existsSync(f) ? readFileSync(f, 'utf8') : '';
    const stripped = body.replace(/# >>> sawbuck >>>[\s\S]*?# <<< sawbuck <<<\n?/g, '');
    const block = lines.length ? `# >>> sawbuck >>>\n${lines.join('\n')}\n# <<< sawbuck <<<\n` : '';
    const next = (block && stripped && !stripped.endsWith('\n') ? stripped + '\n' : stripped) + block;
    if (next === body) return false;
    if (dry) return true;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, next);
    return true;
  } catch { return false; }
}
export const ensureExcluded = (r, dry) => writeBlock(r, EXCLUDED, dry);
export const clearExcluded = (r, dry) => writeBlock(r, [], dry);
