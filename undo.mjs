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

// one hook for both events. Returns the undone entry when one is recorded, else null. Never throws.
export function undoHook(body, repo) {
  let h; try { h = JSON.parse(body || '{}'); } catch { return null; }
  if (!EDIT_TOOLS.includes(String(h.tool_name || ''))) return null;
  const input = h.tool_input || {};
  const file = relFile(repo, input.file_path || input.notebook_path);
  if (!file || file.startsWith('.sawbuck')) return null;
  if (!existsSync(join(repo, '.sawbuck', 'state.json'))) return null;   // never writes in a repo sawbuck is not attached to
  const session = (String(h.session_id || 's').replace(/[^\w-]/g, '').slice(0, 40)) || 's';
  const dir = join(repo, '.sawbuck', 'snap', session);
  const p = join(dir, `${sha(file)}.json`);
  let rec = null; try { rec = JSON.parse(readFileSync(p, 'utf8')); } catch {}
  const abs = join(repo, file); const now = new Date().toISOString();
  if (h.hook_event_name === 'PreToolUse') {
    if (!rec) { mkdirSync(dir, { recursive: true }); const t = readText(abs); writeFileSync(p, JSON.stringify({ file, baseText: t, baseHash: t === null ? '' : sha(t), at: now })); }
    return null;
  }
  if (h.hook_event_name !== 'PostToolUse' || !rec) return null;
  const t = readText(abs); const hash = t === null ? '' : sha(t);
  if (hash !== rec.baseHash) {
    // away from the snapshot: the first such change in the session is what a later undo puts back
    if (!rec.changedAt) { rec.changedAt = now; rec.change = addedSummary(rec.baseText, t); writeFileSync(p, JSON.stringify(rec)); }
    return null;
  }
  // back at the snapshot. The person's undo = a prompt came after the change and before this restore.
  const st = state(repo);
  const spoke = rec.changedAt && st.lastPromptAt && Date.parse(st.lastPromptAt) > Date.parse(rec.changedAt);
  let entry = null;
  if (spoke && rec.change && rec.change.added > 0) {
    entry = { at: now, file, added: rec.change.added, first: rec.change.first, why: String(st.lastPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 240), session };
    appendFileSync(undonePath(repo), JSON.stringify(entry) + '\n');
  }
  rec.changedAt = null; rec.change = null; writeFileSync(p, JSON.stringify(rec));   // the next change starts a new cycle
  return entry;
}

// the lines the prompt hook and `context` add for the paths in hand: newest first, one per file and change, three at most
export function undoneLines(repo, changed) {
  const touched = new Set(changed || []);
  const seen = new Set(); const out = [];
  for (const e of readUndone(repo).reverse()) {
    if (!touched.has(e.file)) continue;
    const k = `${e.file}\n${e.first}`; if (seen.has(k)) continue; seen.add(k);
    out.push(`    - undone here at your request (${String(e.at).slice(0, 10)}): ${e.added} line${e.added === 1 ? '' : 's'} starting \`${e.first}\` in ${e.file}${e.why ? `. Your words: "${e.why}"` : ''}`);
    if (out.length === 3) break;
  }
  return out;
}
