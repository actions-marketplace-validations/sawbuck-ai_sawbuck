// The undo ledger: what the agent tried and the person had undone, inside a session, with nothing left in git.
// The attempts bench (2026-11-10) measured it: an approach undone at the person's request, never committed, came back
// in the next session 27 of 27 times; with the record shown at the prompt, 0 of 27. So the ledger that keeps erased
// reverts also keeps undone attempts. Wired by `attach` on PreToolUse and PostToolUse for the edit tools: before an
// edit the file's content is snapshotted once per session; after an edit, a file back at its snapshot after a change
// AND after a word from the person is an undo, recorded with what the change had added and the person's words.
// Deterministic: a restore is a restore. No model. Stores a diff summary and the person's own prompt, nothing else.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const EDIT_MATCHER = EDIT_TOOLS.join('|');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const undonePath = (repo) => join(repo, '.sawbuck', 'undone.jsonl');

export function readUndone(repo) {
  try { return readFileSync(undonePath(repo), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.file); } catch { return []; }
}

const relFile = (repo, p) => { if (!p) return ''; const r = relative(repo, isAbsolute(p) ? p : join(repo, p)); return !r || r.startsWith('..') ? '' : r; };
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const state = (repo) => { try { return JSON.parse(readFileSync(join(repo, '.sawbuck', 'state.json'), 'utf8')); } catch { return {}; } };

// what a change added, for the record: the count of new lines and the first one (a set difference of lines)
export function addedSummary(before, after) {
  const had = new Set(String(before || '').split('\n'));
  const added = String(after || '').split('\n').filter((l) => l.trim() && !had.has(l));
  return { added: added.length, first: (added[0] || '').trim().slice(0, 80) };
}

// the core, for any agent: before an edit to `file`, snapshot it once per session; after an edit, an undo at the person's
// request is recorded. Whole: the file is back at its snapshot after a change and after a word from the person. Partial:
// after a word from the person, most of what the change added is gone again (at least half its lines, and two or more),
// the person said no to part of it and the agent took that part out. Returns the entry or null. Never throws.
export function undoObserve(repo, { session = 's', file, event, before = undefined }) {
  try {
    if (!file || file.startsWith('.sawbuck')) return null;
    if (!existsSync(join(repo, '.sawbuck', 'state.json'))) return null;   // never writes in a repo sawbuck is not attached to
    const sess = (String(session).replace(/[^\w-]/g, '').slice(0, 40)) || 's';
    const dir = join(repo, '.sawbuck', 'snap', sess); const p = join(dir, `${sha(file)}.json`);
    let rec = null; try { rec = JSON.parse(readFileSync(p, 'utf8')); } catch {}
    const abs = join(repo, file); const now = new Date().toISOString();
    if (event === 'pre') {
      if (!rec) { mkdirSync(dir, { recursive: true }); const t = before !== undefined ? before : readText(abs); writeFileSync(p, JSON.stringify({ file, baseText: t, baseHash: t === null ? '' : sha(t), at: now })); }
      return null;
    }
    if (event !== 'post' || !rec) return null;
    const t = readText(abs); const hash = t === null ? '' : sha(t);
    const st = state(repo);
    const spoke = rec.changedAt && st.lastPromptAt && Date.parse(st.lastPromptAt) > Date.parse(rec.changedAt);
    const why = String(st.lastPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const record = (kind, gone) => { const entry = { at: now, file, kind, added: gone.length, first: gone[0].trim().slice(0, 80), why, session: sess }; appendFileSync(undonePath(repo), JSON.stringify(entry) + '\n'); return entry; };
    if (hash === rec.baseHash) {
      // back at the snapshot: the whole change undone, if the person spoke after it was made
      let entry = null;
      if (spoke && rec.change && rec.change.lines && rec.change.lines.length) entry = record('whole', rec.change.lines);
      rec.changedAt = null; rec.change = null; writeFileSync(p, JSON.stringify(rec));   // the next change starts a new cycle
      return entry;
    }
    if (!rec.changedAt) {
      // away from the snapshot: the first such change in the session is what a later undo takes back
      const had = new Set(String(rec.baseText || '').split('\n'));
      const lines = String(t || '').split('\n').filter((l) => l.trim() && !had.has(l));
      rec.changedAt = now; rec.change = { ...addedSummary(rec.baseText, t), lines: lines.slice(0, 200) }; writeFileSync(p, JSON.stringify(rec));
      return null;
    }
    if (spoke && rec.change && rec.change.lines && rec.change.lines.length >= 2 && !rec.partialAt) {
      const now_ = new Set(String(t || '').split('\n'));
      const gone = rec.change.lines.filter((l) => !now_.has(l));
      if (gone.length >= 2 && gone.length * 2 >= rec.change.lines.length) { rec.partialAt = now; writeFileSync(p, JSON.stringify(rec)); return record('part', gone); }
    }
    return null;
  } catch { return null; }
}

// Claude Code's PreToolUse / PostToolUse on the edit tools
export function undoHook(body, repo) {
  let h; try { h = JSON.parse(body || '{}'); } catch { return null; }
  if (!EDIT_TOOLS.includes(String(h.tool_name || ''))) return null;
  const input = h.tool_input || {};
  const file = relFile(repo, input.file_path || input.notebook_path);
  const event = h.hook_event_name === 'PreToolUse' ? 'pre' : h.hook_event_name === 'PostToolUse' ? 'post' : '';
  return undoObserve(repo, { session: h.session_id, file, event });
}

// Codex: apply_patch carries a patch; the files it names are snapshotted before and observed after
export function patchFiles(command) {
  return [...String(command || '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}
export function undoCodex(body, repo) {
  let h; try { h = JSON.parse(body || '{}'); } catch { return []; }
  const cmd = (h.tool_input && (h.tool_input.command || h.tool_input.patch || h.tool_input.input)) || '';
  const event = h.hook_event_name === 'PreToolUse' ? 'pre' : h.hook_event_name === 'PostToolUse' ? 'post' : '';
  return patchFiles(cmd).map((f) => undoObserve(repo, { session: h.session_id, file: relFile(repo, f), event })).filter(Boolean);
}

// Cursor: afterFileEdit only, with the edits made; the text before them is the text after, each edit reversed
export function undoCursor(body, repo) {
  let h; try { h = JSON.parse(body || '{}'); } catch { return null; }
  const file = relFile(repo, h.file_path); if (!file) return null;
  const now = readText(join(repo, file)); if (now === null) return null;
  let before = now; for (const e of [...(h.edits || [])].reverse()) { if (e && typeof e.new_string === 'string' && before.includes(e.new_string)) before = before.replace(e.new_string, String(e.old_string || '')); }
  const session = String(h.conversation_id || h.session_id || 'cursor');
  undoObserve(repo, { session, file, event: 'pre', before });
  return undoObserve(repo, { session, file, event: 'post' });
}

// the lines the prompt hook and `context` add for the paths in hand: newest first, one per file and change, three at most
export function undoneLines(repo, changed) {
  const touched = new Set(changed || []);
  const seen = new Set(); const out = [];
  for (const e of readUndone(repo).reverse()) {
    if (!touched.has(e.file)) continue;
    const k = `${e.file}\n${e.first}`; if (seen.has(k)) continue; seen.add(k);
    out.push(`    - ${e.kind === 'part' ? 'partly undone' : 'undone'} here at your request (${String(e.at).slice(0, 10)}): ${e.added} line${e.added === 1 ? '' : 's'} starting \`${e.first}\` in ${e.file}${e.why ? `. Your words: "${e.why}"` : ''}`);
    if (out.length === 3) break;
  }
  return out;
}
