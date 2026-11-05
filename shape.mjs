// Your steering shape: what you push on, as 12 spokes in 4 groups. The model labels a sample of your messages; only the
// totals are kept. Two models agree on single messages about half the time and on the shape at 0.93, so a single label is
// never shown. It says what you pushed on, not how good you are. Each run is saved with its date to compare later.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { prepareRules } from './rules.mjs';
import { exposure, writtenRules } from './exposure.mjs';

export const GROUPS = { Truth: ['correctness', 'proof', 'honesty'], Intent: ['direction', 'scope', 'autonomy'], Craft: ['voice', 'naming', 'visual', 'simplicity'], Control: ['process', 'safety'] };
const SPOKES = Object.values(GROUPS).flat();
const MIN_SPOKES = 200;   // below this, spokes are noise: show the 4 groups
const SAMPLE = 600;
const paths = (home) => ({ dir: join(home, '.sawbuck'), rules: join(home, '.sawbuck', 'rule-input.txt'), input: join(home, '.sawbuck', 'shape-input.txt'), hist: join(home, '.sawbuck', 'shape-history.jsonl'), expo: join(home, '.sawbuck', 'shape-exposure.json'), svg: join(home, '.sawbuck', 'shape.svg') });
const title = (s) => s[0].toUpperCase() + s.slice(1);

export function prepareShape({ home = homedir() } = {}) {
  const r = prepareRules({ home });
  const p = paths(home);
  const lines = readFileSync(p.rules, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [lines[i], lines[j]] = [lines[j], lines[i]]; }
  const pick = lines.slice(0, SAMPLE);
  writeFileSync(p.input, pick.map((l, i) => `${i + 1}\t${l}`).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(p.expo, JSON.stringify({ ...exposure({ root: join(home, '.claude', 'projects') }), written: writtenRules({ home }) }) + '\n');
  return { input: p.input, lines: pick.length, secrets: r.secrets };
}

export function tally(labels) {
  const counts = Object.fromEntries(SPOKES.map((s) => [s, 0]));
  let none = 0;
  for (const v of Object.values(labels)) { if (v === 'none') none++; else if (v in counts) counts[v]++; }
  const total = SPOKES.reduce((a, s) => a + counts[s], 0);
  const groups = Object.fromEntries(Object.entries(GROUPS).map(([g, ss]) => [g, total ? Math.round(100 * ss.reduce((a, s) => a + counts[s], 0) / total) : 0]));
  const top = Math.max(1, ...SPOKES.map((s) => counts[s]));
  // the 0 to 99 scale is relative to your own top spoke and compressed so the shape reads: shares carry the real size
  const ratings = Object.fromEntries(SPOKES.map((s) => [s, Math.round(40 + 59 * Math.sqrt(counts[s] / top))]));
  const shares = Object.fromEntries(SPOKES.map((s) => [s, total ? Math.round(100 * counts[s] / total) : 0]));
  return { n: total, none, groups, ratings, shares, spokes: total >= MIN_SPOKES };
}

// What was not said: each spoke we can measure from what the agent did, read against how often you push on it.
const MIN_TURNS = 30;   // a pattern needs enough turns behind it: 1 of 3 is not one
const HIGH_PUSH = 8, HIGH_DOING = 10, HIGH_FAULT = 5;   // a fault counts sooner than plain activity
const SEEN = {
  proof: { fault: true, of: 'code', n: 'unverified', says: 'changed code and ran no check within 3 turns', rule: 'Run the tests before saying a change works.' },
  safety: { fault: true, of: 'working', n: 'risky', says: 'touched something risky', rule: 'Ask before force pushing, deleting outside temp folders, or touching secrets, workflows or deploy files.' },
  process: { of: 'working', n: 'shipped', says: 'committed, pushed or published', rule: 'Do not commit or push unless I ask.' },
  voice: { of: 'working', n: 'copy', says: 'wrote docs or copy', rule: 'Write docs in plain, short sentences.' },
  visual: { of: 'working', n: 'ui', says: 'changed the interface', rule: 'Show me interface changes before calling them done.' },
  simplicity: { fault: true, of: 'working', n: 'big', says: 'added 200 lines or more', rule: 'Keep changes small. Ask before adding more than 200 lines.' },
  naming: { of: 'working', n: 'renames', says: 'renamed something', rule: 'Ask before renaming anything public.' },
  autonomy: { of: 'working', n: 'asked', says: 'stopped to ask you', rule: 'Keep going on reversible work without asking.' },
};
export function patterns(t, c) {
  if (!c || !c.working) return [];
  return Object.entries(SEEN).map(([s, m]) => {
    const pct = Math.round(100 * (c[m.n] || 0) / Math.max(1, c[m.of]));
    const push = t.shares[s], often = pct >= (m.fault ? HIGH_FAULT : HIGH_DOING), pushed = push >= HIGH_PUSH;
    // a fault you keep raising is a fight; activity you raise is just attention, since committing is not a failure
    const has = !!(c.written && c.written[s]);
    const enough = c[m.of] >= MIN_TURNS;
    const kind = !enough ? 'too few' : often && pushed ? (m.fault ? 'fighting it' : 'watched') : often ? (has ? 'covered' : 'blind spot') : pushed ? 'handled' : 'quiet';
    return { spoke: s, kind, pct, count: c[m.n] || 0, of: c[m.of], push, says: m.says, rule: m.rule, has };
  });
}

export function shapeSvg(t, found = []) {
  const names = t.spokes ? SPOKES : Object.keys(GROUPS);
  const vals = t.spokes ? names.map((s) => t.ratings[s] / 99) : names.map((g) => 0.25 + 0.75 * t.groups[g] / Math.max(1, ...Object.values(t.groups)));
  const pt = (i, v) => { const a = 2 * Math.PI * i / names.length; return [(500 + 330 * v * Math.sin(a)).toFixed(1), (520 - 330 * v * Math.cos(a)).toFixed(1)]; };
  const doing = Object.fromEntries(found.map((f) => [f.spoke, f.pct]));
  const topDoing = Math.max(1, ...Object.values(doing));
  const seenPts = t.spokes && found.length ? names.flatMap((n, i) => (n in doing ? [pt(i, 0.4 + 0.59 * Math.sqrt(doing[n] / topDoing))] : [])) : [];
  const ring = (v) => names.map((_, i) => pt(i, v).join(',')).join(' ');
  const labels = names.map((n, i) => { const [x, y] = pt(i, 1.14); return `<text x="${x}" y="${y}" text-anchor="middle" fill="#e8e6e1" font-size="22" font-weight="700">${title(n)}</text><text x="${x}" y="${+y + 28}" text-anchor="middle" fill="#c9a24a" font-size="24" font-weight="700">${t.spokes ? t.ratings[n] : t.groups[n] + '%'}</text>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" font-family="system-ui,sans-serif"><rect width="1000" height="1000" fill="#0b0e13"/><text x="50" y="70" fill="#e8e6e1" font-size="40" font-weight="700">My steering shape</text>${[0.25, 0.5, 0.75, 1].map((v) => `<polygon points="${ring(v)}" fill="none" stroke="#2a313b"/>`).join('')}<polygon points="${names.map((_, i) => pt(i, vals[i]).join(',')).join(' ')}" fill="#c9a24a" fill-opacity="0.35" stroke="#c9a24a" stroke-width="4"/>${seenPts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="#4fb3a5"/>`).join('')}${labels}<text x="50" y="960" fill="#8d94a0" font-size="19">Gold: what I push on, from ${t.n} messages.${seenPts.length ? ' Teal dots: what the agent did.' : ''} Relative to my own top. Not a score. sawbuck.ai</text></svg>\n`;
}

export function shapeCli(args, { home = homedir() } = {}) {
  if (args.includes('--prepare')) { const r = prepareShape({ home }); return `🐴 ${r.lines} of your messages are ready in ${r.input}${r.secrets ? `, ${r.secrets} that looked like secrets left out` : ''}.`; }
  const i = args.indexOf('--check');
  if (i === -1) return 'sawbuck shape --prepare | --check <labels.json>';
  const file = args[i + 1];
  if (!file || !existsSync(file)) return '🐴 sawbuck: --check needs the labels file.';
  const m = readFileSync(file, 'utf8').match(/\{[\s\S]*\}/);
  const t = tally(m ? JSON.parse(m[0]) : {});
  if (!t.n) return '🐴 sawbuck: no usable labels in that file.';
  const p = paths(home);
  mkdirSync(p.dir, { recursive: true });
  let prev = null;
  if (existsSync(p.hist)) { const l = readFileSync(p.hist, 'utf8').trim().split('\n').filter(Boolean); if (l.length) prev = JSON.parse(l[l.length - 1]); }
  let c = null; try { c = JSON.parse(readFileSync(p.expo, 'utf8')); } catch {}
  const found = patterns(t, c);
  writeFileSync(p.svg, shapeSvg(t, found));
  const out = [`🐴 your steering shape, from ${t.n} messages that pushed on something (${t.none} did not). What you push on, not a score.`, ''];
  for (const [g, ss] of Object.entries(GROUPS)) {
    const was = prev && prev.groups[g] != null ? `  (was ${prev.groups[g]}%)` : '';
    out.push(`  ${g.padEnd(8)} ${String(t.groups[g]).padStart(3)}%${was}`);
    if (t.spokes) out.push(`    ${ss.map((s) => `${title(s)} ${t.ratings[s]}`).join('  ')}`);
  }
  if (!t.spokes) out.push('', `  Too few messages for the 12 spokes (${t.n} of ${MIN_SPOKES}), so this shows the 4 groups.`);
  appendFileSync(p.hist, JSON.stringify({ at: new Date().toISOString(), n: t.n, groups: t.groups, shares: t.shares, ...(c ? { exposure: c } : {}) }) + '\n');
  const fight = found.filter((f) => f.kind === 'fighting it'), blind = found.filter((f) => f.kind === 'blind spot');
  if (fight.length || blind.length) out.push('', '  Patterns to work on:');
  for (const f of fight) out.push(`    Fighting it: ${title(f.spoke)}. You push on it (${f.push}%), and the agent still ${f.says} in ${f.pct}% of turns (${f.count} of ${f.of}).`, f.has ? '      You seem to have a written rule on this already, and it is not holding. Make it specific, or protect it in the contract.' : `      Try: ${f.rule}`);
  for (const f of blind) out.push(`    Not said: ${title(f.spoke)}. The agent ${f.says} in ${f.pct}% of turns (${f.count} of ${f.of}), and only ${f.push}% of your pushes touch it. Is that what you want?`, `      Try: ${f.rule}`);
  const covered = found.filter((f) => f.kind === 'covered');
  if (covered.length) out.push('', `  Written down already, so left out: ${covered.map((f) => title(f.spoke)).join(', ')}. Matched by keyword, so check they say what you mean.`);
  if (found.some((f) => f.kind === 'too few')) out.push('', `  Not enough recent turns to name every pattern yet: each needs ${MIN_TURNS}.`);
  if (found.length) out.push('', '  What the agent did covers your last 90 days, not counting scratch work. Direction, scope, correctness and honesty have no behaviour signal, so they show only what you said.');
  out.push('', `  Card: ${p.svg}`);
  return out.join('\n');
}
