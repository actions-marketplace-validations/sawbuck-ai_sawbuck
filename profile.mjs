// The per-machine profile: what holds for you in every repo and in none. Your personal rules live in ~/.claude/CLAUDE.md
// (Claude Code loads it in every session, repo or not; /rules writes there by default), your personal holds in
// ~/.sawbuck/config.json, the machine-wide hooks in ~/.claude/settings.json (`sawbuck attach --user`), and your steering
// record in the plugin's store. `profile` shows them in one view; `export` writes the rules and holds to one file and
// `import` folds that file into another machine. It carries rules and holds only: no transcripts, no steers, no repo data.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readSteers, groupSteers } from './steers.mjs';
import { OUTWARD } from './hold.mjs';

const P = (home) => ({ rules: join(home, '.claude', 'CLAUDE.md'), cfg: join(home, '.sawbuck', 'config.json'), settings: join(home, '.claude', 'settings.json') });
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const json = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
const ruleLines = (t) => t.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l));

export function profileView(home = homedir()) {
  const p = P(home), rules = ruleLines(read(p.rules)), holds = (json(p.cfg).holds || {});
  const hooked = /sawbuck\.mjs|npx (?:--\S+ )*-y sawbuck@/.test(read(p.settings));
  const { steers } = readSteers(home); const top = groupSteers(steers).filter((g) => g.n >= 2).slice(0, 3);
  const out = ['sawbuck: your profile on this machine (it applies in every repo and outside any repo)', ''];
  out.push(`  Rules       ${rules.length} line${rules.length === 1 ? '' : 's'} in ${p.rules}${rules.length ? '' : '  (/sawbuck-reins:rules writes here by default)'}`);
  for (const l of rules.slice(0, 5)) out.push(`              ${l.trim().slice(0, 100)}`);
  out.push(`  Hooks       ${hooked ? 'wired for every repo (sawbuck attach --user)' : 'per repo only; `sawbuck attach --user` wires them once for the whole machine'}`);
  out.push(`  Holds       ${holds.off ? 'OFF on this machine' : `${OUTWARD.length} built in${(holds.outward || []).length ? ` + ${holds.outward.length} of yours (${p.cfg})` : ''}`}`);
  out.push(`  Steering    ${steers.length} steers kept${top.length ? `; you keep saying: ${top.map((g) => `"${g.nudge}" ${g.n}x`).join(', ')}` : ''}`);
  out.push('', '  Move it to another machine: sawbuck profile export > my-profile.json, then sawbuck profile import my-profile.json there.');
  return out.join('\n');
}

export function profileExport(home = homedir()) {
  const p = P(home);
  return JSON.stringify({ sawbuckProfile: 1, rules: ruleLines(read(p.rules)).map((l) => l.trim()), holds: json(p.cfg).holds || {} }, null, 2);
}

export function profileImport(file, home = homedir()) {
  let x; try { x = JSON.parse(readFileSync(file, 'utf8')); } catch { return { error: `${file} is not a profile file` }; }
  if (!x || x.sawbuckProfile !== 1) return { error: `${file} is not a profile file (no sawbuckProfile: 1)` };
  const p = P(home), have = read(p.rules), haveSet = new Set(ruleLines(have).map((l) => l.trim()));
  const add = (x.rules || []).map(String).filter((l) => /^\s*[-*]\s+\S/.test(l) && !haveSet.has(l.trim()));
  if (add.length) { mkdirSync(dirname(p.rules), { recursive: true }); writeFileSync(p.rules, have + (have && !have.endsWith('\n') ? '\n' : '') + (have ? '\n' : '') + add.join('\n') + '\n'); }
  const cfg = json(p.cfg); const h = cfg.holds || {}; const before = new Set(h.outward || []);
  const newHolds = (x.holds && Array.isArray(x.holds.outward) ? x.holds.outward : []).filter((o) => !before.has(o));
  if (newHolds.length) { cfg.holds = { ...h, outward: [...(h.outward || []), ...newHolds] }; mkdirSync(dirname(p.cfg), { recursive: true }); writeFileSync(p.cfg, JSON.stringify(cfg, null, 2) + '\n'); }
  return { rules: add.length, holds: newHolds.length };
}

export function profileCli(args, home = homedir()) {
  const sub = args.find((a) => !a.startsWith('-'));
  if (sub === 'export') return { text: profileExport(home) };
  if (sub === 'import') {
    const f = args.filter((a) => !a.startsWith('-'))[1]; if (!f) return { code: 64, text: 'sawbuck: profile import needs the file: sawbuck profile import my-profile.json' };
    const r = profileImport(f, home); if (r.error) return { code: 1, text: `sawbuck: ${r.error}` };
    return { text: `sawbuck: profile imported: ${r.rules} rule${r.rules === 1 ? '' : 's'} added to ~/.claude/CLAUDE.md, ${r.holds} hold${r.holds === 1 ? '' : 's'} added to ~/.sawbuck/config.json (what was already there is kept).` };
  }
  return { text: profileView(home) };
}
