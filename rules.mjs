// Find the rules you keep enforcing and never wrote down. `prepare` gathers what you typed to Claude Code, on this
// machine, with copies and likely secrets removed. The agent proposes rules from it, each with quotes. `check` proves
// every quote is really yours: a rule with fewer than two real quotes is dropped. Nothing is added to any file here.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_LINES = 3000;
const SECRET = /(sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,}|eyJ[\w-]{20,}\.[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b[a-f0-9]{40,}\b|(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i;
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const paths = (home) => ({ dir: join(home, '.sawbuck'), input: join(home, '.sawbuck', 'rule-input.txt') });

function typed(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length && c.every((b) => b.type === 'text')) return c.map((b) => b.text).join(' ');
  return '';
}

export function prepareRules({ home = homedir() } = {}) {
  const root = join(home, '.claude', 'projects');
  const found = [];
  const seen = new Set();
  let secrets = 0;
  let dirs = []; try { dirs = readdirSync(root); } catch {}
  for (const d of dirs) {
    let files = []; try { files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const p = join(root, d, f);
      let text = ''; try { text = readFileSync(p, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.includes('"type":"user"')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type !== 'user' || e.isMeta || e.isSidechain) continue;
        const t = typed(e.message).replace(/\s+/g, ' ').trim();
        if (t.length < 8 || t.length > 400 || /^[<[]/.test(t) || t.startsWith('Caveat:') || t.startsWith('This session is being continued')) continue;
        const k = norm(t).slice(0, 120);
        if (seen.has(k)) continue;   // a resumed session copies its history
        seen.add(k);
        if (SECRET.test(t)) { secrets++; continue; }
        found.push({ t, at: e.timestamp || '' });
      }
    }
  }
  found.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const lines = found.slice(-MAX_LINES).map((x) => x.t);
  const { dir, input } = paths(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(input, lines.join('\n') + '\n', { mode: 0o600 });
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

export function rulesCli(args, { home = homedir() } = {}) {
  if (args.includes('--prepare')) {
    const r = prepareRules({ home });
    return `🐴 ${r.lines} of your messages are ready in ${r.input}, copies removed${r.secrets ? `, ${r.secrets} that looked like secrets left out` : ''}. Stays on this machine until an agent reads it.`;
  }
  const i = args.indexOf('--check');
  if (i > -1) {
    const file = args[i + 1];
    if (!file || !existsSync(file) || !statSync(file).isFile()) return '🐴 sawbuck: --check needs the candidates file.';
    if (!existsSync(paths(home).input)) return '🐴 sawbuck: run sawbuck rules --prepare first.';
    const { kept, dropped } = checkRules(file, { home });
    const out = [`🐴 ${kept.length} rules have at least 2 quotes that are really yours${dropped.length ? `, ${dropped.length} dropped` : ''}.`];
    kept.forEach((r, n) => { out.push('', `${n + 1}. ${r.rule}`); for (const q of r.quotes.slice(0, 3)) out.push(`     "${q.slice(0, 110)}"`); });
    return out.join('\n');
  }
  return 'sawbuck rules --prepare | --check <candidates.json>';
}
