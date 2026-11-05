// Your steering shape: what you push on, as 11 spokes in 4 groups. The model labels a sample of your messages; only the
// totals are kept. Three models agreed on single messages about 70% of the time and on the shape at 0.87 or better, so a
// single label is never shown. It says what you pushed on, not how good you are. Each run is saved with its date.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { prepareRules } from './rules.mjs';

export const GROUPS = { Truth: ['correctness', 'proof', 'honesty'], Intent: ['scope', 'autonomy'], Craft: ['voice', 'naming', 'visual', 'simplicity'], Control: ['process', 'safety'] };
const SPOKES = Object.values(GROUPS).flat();
const MIN_SPOKES = 200;   // below this, spokes are noise: show the 4 groups
const SAMPLE = 600;
const paths = (home) => ({ dir: join(home, '.sawbuck'), rules: join(home, '.sawbuck', 'rule-input.txt'), input: join(home, '.sawbuck', 'shape-input.txt'), hist: join(home, '.sawbuck', 'shape-history.jsonl'), svg: join(home, '.sawbuck', 'shape.svg') });
const title = (s) => s[0].toUpperCase() + s.slice(1);

export function prepareShape({ home = homedir() } = {}) {
  const r = prepareRules({ home });
  const p = paths(home);
  const lines = readFileSync(p.rules, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [lines[i], lines[j]] = [lines[j], lines[i]]; }
  const pick = lines.slice(0, SAMPLE);
  writeFileSync(p.input, pick.map((l, i) => `${i + 1}\t${l}`).join('\n') + '\n', { mode: 0o600 });
  return { input: p.input, lines: pick.length, secrets: r.secrets };
}

export function tally(labels) {
  const counts = Object.fromEntries(SPOKES.map((s) => [s, 0]));
  let none = 0;
  // two models split scope and direction at random (shape r 0.55 with both, 0.97 merged), so they count as one
  for (const raw of Object.values(labels)) { const v = raw === 'direction' ? 'scope' : raw; if (v === 'none') none++; else if (v in counts) counts[v]++; }
  const total = SPOKES.reduce((a, s) => a + counts[s], 0);
  const groups = Object.fromEntries(Object.entries(GROUPS).map(([g, ss]) => [g, total ? Math.round(100 * ss.reduce((a, s) => a + counts[s], 0) / total) : 0]));
  const top = Math.max(1, ...SPOKES.map((s) => counts[s]));
  // the 0 to 99 scale is relative to your own top spoke and compressed so the shape reads: shares carry the real size
  const ratings = Object.fromEntries(SPOKES.map((s) => [s, Math.round(40 + 59 * Math.sqrt(counts[s] / top))]));
  const shares = Object.fromEntries(SPOKES.map((s) => [s, total ? Math.round(100 * counts[s] / total) : 0]));
  return { n: total, none, groups, ratings, shares, spokes: total >= MIN_SPOKES };
}

// What was not said: each spoke we can measure from what the agent did, read against how often you push on it.
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
  writeFileSync(p.svg, shapeSvg(t));
  const out = [`🐴 your steering shape, from ${t.n} messages that pushed on something (${t.none} did not). What you push on, not a score.`, ''];
  for (const [g, ss] of Object.entries(GROUPS)) {
    const was = prev && prev.groups[g] != null ? `  (was ${prev.groups[g]}%)` : '';
    out.push(`  ${g.padEnd(8)} ${String(t.groups[g]).padStart(3)}%${was}`);
    if (t.spokes) out.push(`    ${ss.map((s) => `${title(s)} ${t.ratings[s]}`).join('  ')}`);
  }
  if (!t.spokes) out.push('', `  Too few messages for the 11 spokes (${t.n} of ${MIN_SPOKES}), so this shows the 4 groups.`);
  appendFileSync(p.hist, JSON.stringify({ at: new Date().toISOString(), n: t.n, groups: t.groups, shares: t.shares }) + '\n');
  out.push('', `  Card: ${p.svg}`);
  if (args.includes('--png')) { const png = pngCard(p.svg); out.push(png ? `  Image to share: ${png}` : '  No image tool here (rsvg-convert or Chrome): open the card in a browser to save an image.'); }
  return out.join('\n');
}
