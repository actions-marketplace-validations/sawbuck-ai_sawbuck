// Your steering shape: what you push on, as 11 spokes in 4 groups. The model labels a sample of your messages; only the
// totals are kept. Three models agreed on single messages about 70% of the time and on the shape at 0.87 or better, so a
// single label is never shown. It says what you pushed on, not how good you are. Each run is saved with its date.
//
// What is not said: the model also reads a sample of real turns and names habits the agent has that you never push on.
// Nothing is counted. An earlier version counted with patterns, and reading the turns showed the counts were wrong.
// Each habit must quote the agent from 3 turns, a plain check confirms the quotes, and the excerpts are deleted after.
// Tested on one person: on 120 turns two models named the same two habits and differed on the third, so the output
// calls them leads.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { prepareRules, SECRET, forget } from './rules.mjs';
import { readHistory, typedText } from './history.mjs';

// framing (how a thing is said to other people) joined Craft on 2026-11-08: with it as its own spoke two readers' shapes
// correlated at r 0.92 against 0.86 with it folded into voice (proof-bench/spokes). approach (how the work gets done) and
// order (what first) did not make it (r 0.71 and 0.84 as spokes), so they stay unplaced and are shown as such.
export const GROUPS = { Truth: ['correctness', 'proof', 'honesty'], Intent: ['scope', 'autonomy'], Craft: ['voice', 'framing', 'naming', 'visual', 'simplicity'], Control: ['process', 'safety'] };
const SPOKES = Object.values(GROUPS).flat();
const MIN_SPOKES = 200;   // below this, spokes are noise: show the 4 groups
const SAMPLE = 600;
const TURNS = 120, MIN_TURNS = 20, MIN_CITES = 3;   // turns read (at 60, two reads named different habits; at 120 two models agreed on 2 of 3), fewest worth reading, turns a habit must be quoted from
const paths = (home) => ({ dir: join(home, '.sawbuck'), rules: join(home, '.sawbuck', 'rule-input.txt'), input: join(home, '.sawbuck', 'shape-input.txt'), hist: join(home, '.sawbuck', 'shape-history.jsonl'), svg: join(home, '.sawbuck', 'shape.svg'), turns: join(home, '.sawbuck', 'shape-turns.txt'), notsaid: join(home, '.sawbuck', 'shape-notsaid.json') });
const title = (s) => s[0].toUpperCase() + s.slice(1);

export function prepareShape({ home = homedir() } = {}) {
  const r = prepareRules({ home });
  const p = paths(home);
  const lines = readFileSync(p.rules, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [lines[i], lines[j]] = [lines[j], lines[i]]; }
  const pick = lines.slice(0, SAMPLE);
  const priv = (f, text) => { writeFileSync(f, text, { mode: 0o600 }); chmodSync(f, 0o600); };   // the mode alone only applies to a new file
  priv(p.input, pick.map((l, i) => `${i + 1}\t${l}`).join('\n') + '\n');
  const turns = sampleTurns({ home });
  rmSync(p.notsaid, { force: true });
  if (turns.length >= MIN_TURNS) priv(p.turns, turns.map((l, i) => `${i + 1}\t${l}`).join('\n') + '\n'); else rmSync(p.turns, { force: true });
  return { input: p.input, lines: pick.length, secrets: r.secrets, turns: turns.length >= MIN_TURNS ? turns.length : 0, turnsFile: p.turns };
}

// One line per past turn from the last 90 days: what you asked, what the agent did, how its reply ended, what you said
// next. Only sessions with 3 or more typed prompts: a one-prompt session is a script, not a conversation.
export function sampleTurns({ home = homedir(), n = TURNS, days = 90 } = {}) {
  const since = Date.now() - days * 864e5, T = [];
  const cut = (x, k) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, k);
  const noise = (t) => /^[<[]/.test(t) || t.startsWith('Caveat:') || t.startsWith('This session is being continued');
  let cur = null, S = [], typed = 0;
  const close = (next) => { if (cur && cur.tools) S.push({ ...cur, next }); cur = null; };
  const end = () => { close(''); if (typed >= 3) T.push(...S); S = []; typed = 0; };
  readHistory(join(home, '.claude', 'projects'), {
    onSession: end,
    onEvent: (e) => {
      if (e.timestamp && Date.parse(e.timestamp) < since) return;
      if (e.type === 'user') {
        const t = typedText(e.message);
        if (t === null || noise(t.trim())) return;   // a tool result or a background notice is not your reply: the turn goes on
        close(t); typed++; cur = { you: t, did: [], said: '', tools: 0 };
      } else if (cur && Array.isArray(e.message && e.message.content)) {
        for (const b of e.message.content) {
          if (b.type === 'text' && b.text) cur.said = b.text;
          if (b.type !== 'tool_use') continue;
          cur.tools++;
          const i = b.input || {};
          if (cur.did.length < 8) cur.did.push(b.name === 'Bash' ? `ran: ${cut(i.command, 70)}` : /^(Edit|Write|MultiEdit)$/.test(b.name) ? `edited ${String(i.file_path || '').split('/').slice(-2).join('/')}` : b.name);
        }
      }
    },
  });
  for (let i = T.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [T[i], T[j]] = [T[j], T[i]]; }
  // the person's words are kept free of the line's separators, so nothing they typed can sit where the agent's side is read
  const mine = (x, k) => cut(x, k).replace(/\|/g, '/');
  return T.map((t) => `you: ${mine(t.you, 160)}${AGENT}(${t.tools} tool calls): ${t.did.join('; ')} | it ended: ${cut(t.said.slice(-220), 220)}${NEXT}${mine(t.next, 120) || '(session ended)'}`).filter((l) => !SECRET.test(l)).slice(0, n);
}
const AGENT = ' | it did ', NEXT = ' | you next: ';

// Keep a habit only if it quotes the agent's side of 3 different turns, word for word. Your own messages do not count
// as evidence and are never printed. Returns the lines to show, and removes the excerpts either way.
function notSaid(p) {
  let turns = null, named = null;
  try { turns = new Map(readFileSync(p.turns, 'utf8').split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return [l.slice(0, i), l.slice(i + 1)]; })); } catch {}
  try { const m = readFileSync(p.notsaid, 'utf8').match(/\[[\s\S]*\]/); named = m ? JSON.parse(m[0]) : null; } catch {}
  rmSync(p.turns, { force: true }); rmSync(p.notsaid, { force: true });
  if (!turns || !Array.isArray(named)) return [];
  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const one = (x, k) => (typeof x === 'string' ? x : '').replace(/\s+/g, ' ').trim().slice(0, k);
  const agentSide = (l) => { const a = l.indexOf(AGENT), b = l.lastIndexOf(NEXT); return a > -1 && b > a ? norm(l.slice(a, b)) : ''; };
  const out = [];
  let kept = 0;
  // the first 3 that hold up, wherever they sit in the answer; the answer is the model's, so nothing in it is trusted
  for (const c of named.slice(0, 50)) {
    if (kept === 3) break;
    if (!c || typeof c !== 'object' || !one(c.what, 200)) continue;
    const seen = new Set(), quotes = [];
    for (const t of Array.isArray(c.turns) ? c.turns : []) {
      if (!t || typeof t !== 'object' || typeof t.quote !== 'string') continue;
      const q = norm(t.quote), id = String(t.n), l = turns.get(id);
      if (typeof l !== 'string' || q.length < 12 || seen.has(id) || !agentSide(l).includes(q)) continue;
      seen.add(id); quotes.push(one(t.quote, 80));
    }
    if (quotes.length < MIN_CITES) continue;
    kept++;
    out.push(`    ${one(c.what, 200)} (${quotes.length} turns)`, ...[...new Set(quotes)].slice(0, 3).map((q) => `      "${q}"`), ...(one(c.rule, 200) ? [`      Try: ${one(c.rule, 200)}`] : []));
  }
  const n = turns.size;
  return out.length ? ['', `  Not said, from one read of ${n} past turns. Leads to check, with the agent's own words:`, ...out] : ['', `  Not said: nothing stood out in the ${n} past turns read.`];
}

export function tally(labels) {
  const counts = Object.fromEntries(SPOKES.map((s) => [s, 0]));
  let none = 0; const unplaced = {};
  // two models split scope and direction at random (shape r 0.55 with both, 0.97 merged), so they count as one. A label
  // that is none of the spokes is not dropped: it is counted as not placed and shown, because the gap is the finding
  // (2026-11-08: the largest kind of steering one person did, "approach", fit no spoke).
  for (const raw of Object.values(labels)) { const v = raw === 'direction' ? 'scope' : raw; if (v === 'none') none++; else if (v in counts) counts[v]++; else if (typeof v === 'string' && /^[a-z][a-z -]{1,24}$/.test(v)) unplaced[v] = (unplaced[v] || 0) + 1; }
  const total = SPOKES.reduce((a, s) => a + counts[s], 0);
  const groups = Object.fromEntries(Object.entries(GROUPS).map(([g, ss]) => [g, total ? Math.round(100 * ss.reduce((a, s) => a + counts[s], 0) / total) : 0]));
  const top = Math.max(1, ...SPOKES.map((s) => counts[s]));
  // the 0 to 99 scale is relative to your own top spoke and compressed so the shape reads: shares carry the real size
  const ratings = Object.fromEntries(SPOKES.map((s) => [s, Math.round(40 + 59 * Math.sqrt(counts[s] / top))]));
  const shares = Object.fromEntries(SPOKES.map((s) => [s, total ? Math.round(100 * counts[s] / total) : 0]));
  return { n: total, none, groups, ratings, shares, spokes: total >= MIN_SPOKES, unplaced };
}

export function shapeSvg(t) {
  const names = t.spokes ? SPOKES : Object.keys(GROUPS);
  const vals = t.spokes ? names.map((s) => t.ratings[s] / 99) : names.map((g) => 0.25 + 0.75 * t.groups[g] / Math.max(1, ...Object.values(t.groups)));
  const pt = (i, v) => { const a = 2 * Math.PI * i / names.length; return [(500 + 330 * v * Math.sin(a)).toFixed(1), (520 - 330 * v * Math.cos(a)).toFixed(1)]; };
  const ring = (v) => names.map((_, i) => pt(i, v).join(',')).join(' ');
  const labels = names.map((n, i) => { const [x, y] = pt(i, 1.14); return `<text x="${x}" y="${y}" text-anchor="middle" fill="#e8e6e1" font-size="22" font-weight="700">${title(n)}</text><text x="${x}" y="${+y + 28}" text-anchor="middle" fill="#c9a24a" font-size="24" font-weight="700">${t.spokes ? t.ratings[n] : t.groups[n] + '%'}</text>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" font-family="system-ui,sans-serif"><rect width="1000" height="1000" fill="#0b0e13"/><text x="50" y="70" fill="#e8e6e1" font-size="40" font-weight="700">My steering shape</text>${[0.25, 0.5, 0.75, 1].map((v) => `<polygon points="${ring(v)}" fill="none" stroke="#2a313b"/>`).join('')}<polygon points="${names.map((_, i) => pt(i, vals[i]).join(',')).join(' ')}" fill="#c9a24a" fill-opacity="0.35" stroke="#c9a24a" stroke-width="4"/>${labels}<text x="50" y="960" fill="#8d94a0" font-size="19">Gold: what I push on, from ${t.n} messages. Relative to my own top. Not a score. sawbuck.ai</text></svg>\n`;
}

// A PNG of the card, with what is already on the machine: sawbuck ships no image library. A snap browser sees neither
// a hidden folder nor the real /tmp, so it works in a plain folder in home and the result is copied over.
function pngCard(svg) {
  const png = svg.replace(/\.svg$/, '.png');
  rmSync(png, { force: true });
  const run = (bin, args) => { try { execFileSync(bin, args, { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } };
  if (run('rsvg-convert', ['-w', '1200', '-o', png, svg]) && existsSync(png)) return png;
  const tmp = join(dirname(dirname(svg)), `sawbuck-shape-${process.pid}`);
  try {
    mkdirSync(tmp, { recursive: true });
    const a = join(tmp, 'shape.svg'), b = join(tmp, 'shape.png');
    copyFileSync(svg, a);
    for (const bin of ['google-chrome', 'chromium', 'chromium-browser']) {
      if (run(bin, ['--headless', '--disable-gpu', '--hide-scrollbars', '--window-size=1000,1000', `--screenshot=${b}`, `file://${a}`]) && existsSync(b)) { copyFileSync(b, png); return png; }
    }
  } catch {} finally { rmSync(tmp, { recursive: true, force: true }); }
  return '';
}

export function shapeCli(args, { home = homedir() } = {}) {
  if (args.includes('--prepare')) { const r = prepareShape({ home }); return `sawbuck: ${r.lines} of your messages are ready in ${r.input}${r.secrets ? `, ${r.secrets} that looked like secrets left out` : ''}.${r.turns ? `\nsawbuck: ${r.turns} past turns are ready in ${r.turnsFile}. They are deleted after the check.` : ''}`; }
  const i = args.indexOf('--check');
  if (i === -1) return 'sawbuck shape --prepare | --check <labels.json>';
  const file = args[i + 1];
  const p = paths(home);
  // a check that cannot run still clears the excerpts: they are only for this one read
  const stop = (msg) => { rmSync(p.turns, { force: true }); rmSync(p.notsaid, { force: true }); return msg; };
  if (!file || !existsSync(file)) return stop('sawbuck: --check needs the labels file.');
  let labels = {};
  try { const m = readFileSync(file, 'utf8').match(/\{[\s\S]*\}/); labels = m ? JSON.parse(m[0]) : {}; } catch {}
  const t = tally(labels && typeof labels === 'object' ? labels : {});
  if (!t.n) return stop('sawbuck: no usable labels in that file.');
  mkdirSync(p.dir, { recursive: true });
  let prev = null;
  try { const l = readFileSync(p.hist, 'utf8').trim().split('\n').filter(Boolean); if (l.length) prev = JSON.parse(l[l.length - 1]); } catch {}
  if (!prev || typeof prev !== 'object' || !prev.groups) prev = null;
  writeFileSync(p.svg, shapeSvg(t));
  const out = [`sawbuck: your steering shape, from ${t.n} messages that pushed on something (${t.none} did not). What you push on, not a score.`, ''];
  for (const [g, ss] of Object.entries(GROUPS)) {
    const was = prev && prev.groups[g] != null ? `  (was ${prev.groups[g]}%)` : '';
    out.push(`  ${g.padEnd(8)} ${String(t.groups[g]).padStart(3)}%${was}`);
    if (t.spokes) out.push(`    ${ss.map((s) => `${title(s)} ${t.ratings[s]}`).join('  ')}`);
  }
  if (!t.spokes) out.push('', `  Too few messages for the ${SPOKES.length} spokes (${t.n} of ${MIN_SPOKES}), so this shows the 4 groups.`);
  const up = Object.entries(t.unplaced || {}).sort((a, b) => b[1] - a[1]);
  if (up.length) out.push('', `  Not placed: ${up.slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')}. Pushes the reader saw that fit none of the spokes; the shape does not count them, and they are the first place to look for a kind of steering the spokes miss.`);
  appendFileSync(p.hist, JSON.stringify({ at: new Date().toISOString(), n: t.n, groups: t.groups, shares: t.shares }) + '\n');
  forget(home, p.input, p.rules, file);   // the sampled messages and their labels were for this one read; the totals above are what stays
  out.push(...notSaid(p));
  out.push('', `  Card: ${p.svg}`);
  if (args.includes('--png')) { const png = pngCard(p.svg); out.push(png ? `  Image to share: ${png}` : '  No image tool here (rsvg-convert or Chrome): open the card in a browser to save an image.'); }
  return out.join('\n');
}
