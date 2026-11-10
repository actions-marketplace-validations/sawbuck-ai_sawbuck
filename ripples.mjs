// Ripples: what happened after each steer. A push you give is a rock in a pond; this reads the rings it made, from
// records Sawbuck already keeps, joined by repo and time (the window runs from the steer to the next steer in the same
// repo, an hour at most): commits made and the files they touched, edits undone at your request (whole or in part), the
// check's verdicts, reverts, and whether the same push came back in a later session. Reads only; no model; a time join is
// a lead, not proof of cause, and the report says so.
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { readSteers, steerKey } from './steers.mjs';

const HOUR = 3600_000;
const lines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const inWin = (at, a, b) => { const t = Date.parse(at); return t >= a && t < b; };

function commitsIn(repo, a, b) {
  try {
    const raw = execFileSync('git', ['-C', repo, 'log', '--all', `--since=${new Date(a).toISOString()}`, `--until=${new Date(b).toISOString()}`, '--format=%x00%h%x09%cI%x09%s', '--name-only', '--no-renames'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20 });
    return raw.split('\0').slice(1).map((c) => { const [head, ...files] = c.split('\n'); const [sha, at, subject] = head.split('\t'); return { sha, at, subject, files: files.filter(Boolean) }; });
  } catch { return []; }
}

// the plugin keeps a repo's folder name, not its path: find the path in the attach registry, then beside where you stand
function resolveRepo(name, home) {
  if (!name) return '';
  if (name.startsWith('/')) return name;
  try { const r = JSON.parse(readFileSync(join(home, '.sawbuck', 'registry.json'), 'utf8')); const hit = (r.repos || []).map((x) => x.repo).find((p) => basename(p) === name); if (hit) return hit; } catch {}
  for (const base of [process.cwd(), join(process.cwd(), '..'), join(home, 'IdeaProjects'), home]) { const p = join(base, name); if (existsSync(join(p, '.git'))) return p; if (basename(base) === name && existsSync(join(base, '.git'))) return base; }
  return '';
}

export function ripples({ home = homedir(), repo = null } = {}) {
  const all = readSteers(home).steers.map((e) => ({ ...e, repo: resolveRepo(e.repo, home) })).filter((e) => e.at && e.repo && (!repo || e.repo === repo)).sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const byRepo = new Map(); for (const e of all) { if (!byRepo.has(e.repo)) byRepo.set(e.repo, []); byRepo.get(e.repo).push(e); }
  const out = [];
  for (const [r, list] of byRepo) {
    if (!existsSync(join(r, '.git'))) continue;
    const undone = lines(join(r, '.sawbuck', 'undone.jsonl')), activity = lines(join(r, '.sawbuck', 'activity.jsonl')), erased = lines(join(r, '.sawbuck', 'rewritten.jsonl'));
    list.forEach((e, i) => {
      const a = Date.parse(e.at), next = list[i + 1] ? Date.parse(list[i + 1].at) : Infinity, b = Math.min(next, a + HOUR);
      const key = steerKey(e.nudge);
      const later = all.find((o) => Date.parse(o.at) > a && o.session !== e.session && steerKey(o.nudge) === key);
      const u = undone.filter((x) => inWin(x.at, a, b)), v = activity.filter((x) => inWin(x.at, a, b)), rv = erased.filter((x) => x.revert && inWin(x.at, a, b));
      const c = commitsIn(r, a, b);
      out.push({ at: e.at, repo: r, axis: e.axis || '', pressure: e.pressure || 0, nudge: e.nudge, commits: c.length, files: [...new Set(c.flatMap((x) => x.files))].slice(0, 6), undone: u.filter((x) => x.kind !== 'part').length, partly: u.filter((x) => x.kind === 'part').length, verdicts: v.map((x) => x.kind), reverts: rv.length, cameBack: later ? later.at : null });
    });
  }
  return out;
}

export function ripplesReport({ home, repo, json = false } = {}) {
  const rs = ripples({ home, repo });
  if (json) return JSON.stringify(rs);
  if (!rs.length) return 'sawbuck: no steers recorded in a repo yet. Ripples appear once the plugin\'s live judge has scored turns where Sawbuck is attached.';
  const out = [`sawbuck: what happened after ${rs.length} of your steers (from the steer to the next one, an hour at most; a time join, a lead not proof of cause)`];
  // by kind of push: how often it moved code, was taken back, or came back later
  const by = new Map(); for (const r of rs) { const k = r.axis || 'other'; const x = by.get(k) || { n: 0, moved: 0, undone: 0, partly: 0, gamed: 0, back: 0 }; x.n++; if (r.commits) x.moved++; if (r.undone) x.undone++; if (r.partly) x.partly++; if (r.verdicts.includes('gamed')) x.gamed++; if (r.cameBack) x.back++; by.set(k, x); }
  out.push('', '  push            n   moved code   undone   partly undone   gamed after   came back later');
  for (const [k, x] of [...by].sort((p, q) => q[1].n - p[1].n).slice(0, 10)) out.push(`  ${k.slice(0, 14).padEnd(14)} ${String(x.n).padStart(3)}   ${String(x.moved).padStart(10)}   ${String(x.undone).padStart(6)}   ${String(x.partly).padStart(13)}   ${String(x.gamed).padStart(11)}   ${String(x.back).padStart(15)}`);
  const recent = rs.filter((r) => r.commits || r.undone || r.partly || r.reverts || r.cameBack).slice(-5).reverse();
  if (recent.length) {
    out.push('', 'Recent steers that left a ring:');
    for (const r of recent) out.push(`  ${String(r.at).slice(0, 10)} ${r.nudge}  (${basename(r.repo)})`, `      ${[r.commits ? `${r.commits} commit${r.commits === 1 ? '' : 's'}${r.files.length ? ` (${r.files.slice(0, 3).join(', ')})` : ''}` : '', r.undone ? `${r.undone} undone` : '', r.partly ? `${r.partly} partly undone` : '', r.verdicts.length ? `check: ${[...new Set(r.verdicts)].join(', ')}` : '', r.reverts ? `${r.reverts} revert${r.reverts === 1 ? '' : 's'}` : '', r.cameBack ? `you said it again ${String(r.cameBack).slice(0, 10)}` : ''].filter(Boolean).join(' · ')}`);
  }
  out.push('', 'A push that keeps coming back is a rule to write down (/sawbuck-reins:rules). One that moved nothing may not have landed.');
  return out.join('\n');
}
