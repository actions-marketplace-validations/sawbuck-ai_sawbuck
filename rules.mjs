// Find the rules you keep enforcing and never wrote down. `prepare` gathers what you typed to Claude Code, on this
// machine, with copies and likely secrets removed. The agent proposes rules from it, each with quotes. `check` proves
// every quote is really yours: a rule with fewer than two real quotes is dropped. Nothing is added to any file here.
// Once the check has run, the gathered messages and the candidates are deleted: they were for that one read.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readHistory, typedText } from './history.mjs';

const MAX_LINES = 3000;
export const SECRET = /(sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,}|eyJ[\w-]{20,}\.[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b[a-f0-9]{40,}\b|(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i;
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const paths = (home) => ({ dir: join(home, '.sawbuck'), input: join(home, '.sawbuck', 'rule-input.txt') });
// remove what one read gathered. A file the model wrote counts only when it sits in ~/.sawbuck: anywhere else it is the person's own.
export function forget(home, ...files) {
  const dir = resolve(paths(home).dir);
  for (const f of files) if (f && dirname(resolve(f)) === dir) rmSync(f, { force: true });
}

export function prepareRules({ home = homedir() } = {}) {
  const found = [];
  const seen = new Set();
  let secrets = 0;
  readHistory(join(home, '.claude', 'projects'), {
    onEvent: (e) => {
      if (e.type !== 'user') return;
      const t = (typedText(e.message) || '').replace(/\s+/g, ' ').trim();
      if (t.length < 8 || t.length > 400 || /^[<[]/.test(t) || t.startsWith('Caveat:') || t.startsWith('This session is being continued')) return;
      const k = norm(t).slice(0, 120);
      if (seen.has(k)) return;
      seen.add(k);
      if (SECRET.test(t)) { secrets++; return; }
      found.push({ t, at: e.timestamp || '' });
    },
  });
  found.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const lines = found.slice(-MAX_LINES).map((x) => x.t);
  const { dir, input } = paths(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(input, lines.join('\n') + '\n', { mode: 0o600 });
  chmodSync(input, 0o600);   // the mode above only applies to a new file
  return { input, lines: lines.length, secrets };
}

export function checkRules(file, { home = homedir() } = {}) {
  const lines = readFileSync(paths(home).input, 'utf8').split('\n').map(norm);
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/\[[\s\S]*\]/);
  const list = m ? JSON.parse(m[0]) : [];
  const kept = [], dropped = [];
  for (const r of list) {
    const quotes = (r.quotes || []).filter((q) => { const n = norm(String(q)); return n.length >= 8 && lines.some((l) => l.includes(n)); });
    (quotes.length >= 2 ? kept : dropped).push({ rule: String(r.rule), quotes });
  }
  return { kept, dropped };
}

// the notes Claude Code's own memory holds for this repo (~/.claude/projects/<repo>/memory/*.md): written by the agent, so not
// quotes of the person's, but already explicit; /rules offers to promote them into the repo's CLAUDE.md as they stand
export function memoryNotes({ home = homedir(), repo = process.cwd() } = {}) {
  const dir = join(home, '.claude', 'projects', resolve(repo).replace(/\//g, '-'), 'memory');
  let files = []; try { files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { return []; }
  return files.map((f) => {
    const t = readFileSync(join(dir, f), 'utf8'); const fm = t.match(/^---\n([\s\S]*?)\n---\n?/); const head = fm ? fm[1] : ''; const body = (fm ? t.slice(fm[0].length) : t).trim();
    const get = (k) => (head.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm')) || [, ''])[1].trim().replace(/^"|"$/g, '');
    return { file: join(dir, f), name: get('name') || f.replace(/\.md$/, ''), description: get('description'), type: get('type'), source: get('source'), body };
  });
}

export function rulesCli(args, { home = homedir(), repo = process.cwd() } = {}) {
  if (args.includes('--notes')) {
    const notes = memoryNotes({ home, repo }).filter((n) => n.source !== 'sawbuck');
    if (!notes.length) return `sawbuck: Claude Code's own memory holds no notes for this repo.`;
    const out = [`sawbuck: ${notes.length} note${notes.length === 1 ? '' : 's'} in Claude Code's own memory for this repo (written by the agent for itself, so these are not your quotes):`];
    notes.forEach((n, i) => { out.push('', `${i + 1}. ${n.description || n.name}${n.type ? ` [${n.type}]` : ''}`, `     ${n.body.split('\n').find((l) => l.trim() && !l.startsWith('**')) || ''}`.trimEnd()); });
    return out.join('\n');
  }
  if (args.includes('--prepare')) {
    const r = prepareRules({ home });
    return `sawbuck: ${r.lines} of your messages are ready in ${r.input}, copies removed${r.secrets ? `, ${r.secrets} that looked like secrets left out` : ''}. Stays on this machine until an agent reads it.`;
  }
  const i = args.indexOf('--check');
  if (i > -1) {
    const file = args[i + 1];
    if (!file || !existsSync(file) || !statSync(file).isFile()) return 'sawbuck: --check needs the candidates file.';
    if (!existsSync(paths(home).input)) return 'sawbuck: run sawbuck rules --prepare first.';
    const { kept, dropped } = checkRules(file, { home });
    forget(home, paths(home).input, file);
    const out = [`sawbuck: ${kept.length} rules have at least 2 quotes that are really yours${dropped.length ? `, ${dropped.length} dropped` : ''}.`];
    kept.forEach((r, n) => { out.push('', `${n + 1}. ${r.rule}`); for (const q of r.quotes.slice(0, 3)) out.push(`     "${q.slice(0, 110)}"`); });
    return out.join('\n');
  }
  return 'sawbuck rules --prepare | --check <candidates.json> | --notes';
}
