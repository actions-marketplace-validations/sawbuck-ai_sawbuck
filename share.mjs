// Hand a finding to a memory layer running on this machine, once. Today that is claude-mem's local worker: its session-start
// index shows memory TITLES, so the rule or the lead goes in the title and the evidence in the text. Nothing is read back,
// nothing is sent when no worker answers, and a finding is sent once per repo (.sawbuck/shared.jsonl). Measured, twin bench
// 2026-11-08: a correction that lived only in the person's words came back 18 of 36 times through that layer's own notes
// and 0 to 2 of 36 as a written rule, so the CLAUDE.md line stays the carrier and this only adds reach.
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';

// where a claude-mem worker would be: its port file, its settings, or its default of 37700 + uid % 100
export function memoryWorker({ home = homedir() } = {}) {
  const dir = join(home, '.claude-mem');
  if (!existsSync(dir)) return null;
  let port = 0;
  try { port = parseInt(readFileSync(join(dir, '.worker.port'), 'utf8').trim(), 10) || 0; } catch {}
  if (!port) { try { port = parseInt(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).CLAUDE_MEM_WORKER_PORT, 10) || 0; } catch {} }
  if (!port) { let uid = 0; try { uid = userInfo().uid; } catch {} port = 37700 + (uid % 100); }
  return { name: 'claude-mem', url: `http://127.0.0.1:${port}` };
}

export async function share(repo, { title, text }, { home = homedir(), timeoutMs = 800 } = {}) {
  title = String(title || '').trim(); text = String(text || '').trim();
  if (!title) return { sent: false, reason: 'nothing to share: no title' };
  const w = memoryWorker({ home });
  if (!w) return { sent: false, reason: 'no memory layer on this machine' };
  const key = createHash('sha256').update(title + '\n' + text).digest('hex').slice(0, 16);
  const log = join(repo, '.sawbuck', 'shared.jsonl');
  try { if (existsSync(log) && readFileSync(log, 'utf8').includes(`"key":"${key}"`)) return { sent: false, reason: 'already shared' }; } catch {}
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const h = await fetch(`${w.url}/api/health`, { signal: ctl.signal });
    if (!h.ok) throw new Error(`health ${h.status}`);
    const r = await fetch(`${w.url}/api/memory/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, text: text || title, cwd: repo }), signal: ctl.signal });
    if (!r.ok) throw new Error(`save ${r.status}`);
    mkdirSync(join(repo, '.sawbuck'), { recursive: true });
    appendFileSync(log, JSON.stringify({ key, title, at: new Date().toISOString(), to: w.url }) + '\n');
    return { sent: true, to: w.url, name: w.name };
  } catch (e) {
    return { sent: false, reason: `no ${w.name} worker answered at ${w.url}` };
  } finally { clearTimeout(timer); }
}
