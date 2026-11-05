// One reader for Claude Code history on this machine, so every feature counts the same way: side threads and meta lines
// are skipped, and a line copied by a resumed session counts once.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function typedText(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length && c.every((b) => b.type === 'text')) return c.map((b) => b.text).join(' ');
  return null;
}

// calls onSession() before each transcript and onEvent(e) for each line, and returns nothing
export function readHistory(root, { onSession = () => {}, onEvent }) {
  const seen = new Set();
  let dirs = []; try { dirs = readdirSync(root); } catch { return; }
  for (const d of dirs) {
    let files = []; try { files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      let text = ''; try { text = readFileSync(join(root, d, f), 'utf8'); } catch { continue; }
      onSession();
      for (const line of text.split('\n')) {
        if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.isSidechain || e.isMeta) continue;
        if (e.uuid) { if (seen.has(e.uuid)) continue; seen.add(e.uuid); }
        onEvent(e);
      }
    }
  }
  onSession();
}
