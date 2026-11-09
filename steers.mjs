// The steer scratchpad, for the person: what you keep correcting, read from Claude Code's plugin store on this
// machine. Reads only. Counts here are measured; nothing is projected. The grouping matches the plugin's.
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'it', 'this', 'that', 'do', 'not', 'dont', 'use', 'be', 'in', 'on', 'for', 'with', 'is', 'are', 'your', 'you']);
export const steerKey = (n) => String(n).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).slice(0, 3).sort().join(' ');

export function readSteers(home = homedir()) {
  const dir = join(home, '.claude', 'plugins', 'store');
  const out = { steers: [], stats: { scored: 0, lost: 0 } };
  let files = []; try { files = readdirSync(dir).filter((f) => f.startsWith('sawbuck-reins_') && f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (Array.isArray(d.steers)) out.steers.push(...d.steers.filter((e) => e && typeof e.nudge === 'string'));   // a null or half-written entry is not a steer
      if (d.steerStats) { out.stats.scored += d.steerStats.scored || 0; out.stats.lost += d.steerStats.lost || 0; }
    } catch {}
  }
  return out;
}

export function groupSteers(list) {
  const g = new Map();
  for (const e of list) {
    const key = steerKey(e.nudge); if (!key) continue;
    const x = g.get(key) || { key, nudge: e.nudge, n: 0, sessions: new Set(), repos: new Set() };
    x.n++; x.sessions.add(e.session); x.repos.add(e.repo || 'no repo'); g.set(key, x);
  }
  return [...g.values()].map((x) => ({ key: x.key, nudge: x.nudge, n: x.n, sessions: x.sessions.size, repos: [...x.repos] }))
    .sort((a, b) => b.n - a.n || b.repos.length - a.repos.length);
}

export function steersReport({ json = false, home } = {}) {
  const { steers, stats } = readSteers(home);
  const groups = groupSteers(steers);
  const repeated = groups.filter((g) => g.n >= 3 && g.sessions >= 2);
  if (json) return JSON.stringify({ steers: steers.length, scored: stats.scored, unscored: stats.lost, repeated });
  if (!steers.length && !stats.scored) return 'sawbuck: no steers recorded yet. They appear as you work with the plugin\'s live judge on.';
  const out = [`sawbuck: ${steers.length} steers kept, from ${stats.scored} replies scored${stats.lost ? ` (${stats.lost} could not be scored, so this undercounts)` : ''}. Measured, not estimated.`];
  if (repeated.length) {
    out.push('', 'You keep saying:');
    for (const g of repeated.slice(0, 10)) out.push(`  ${String(g.n).padStart(3)}x  ${g.nudge}  (${g.repos.join(', ')})`);
    out.push('', 'If one of these is a rule, write it down: a protected path in promptwheel.config.json, or a line in CLAUDE.md.');
  } else out.push('', 'Nothing repeats yet: a steer shows here after 3 times across 2 sessions.');
  // the hardest steer: the person stopped the agent mid-turn (the plugin keeps these as axis "stop")
  const stops = steers.filter((e) => e.axis === 'stop');
  if (stops.length) {
    out.push('', `You stopped it ${stops.length} time${stops.length === 1 ? '' : 's'}. What it was doing (a lead to read, not a verdict: the most common reason to stop an agent is having something to add):`);
    for (const e of stops.slice(-5).reverse()) out.push(`  ${String(e.nudge || '').replace(/^stopped: /, '')}  (${basename(e.repo || '') || 'no repo'})`);
    out.push('  A thing you stop it on more than once is a hold: say it once in CLAUDE.md, or protect the path.');
  }
  return out.join('\n');
}
