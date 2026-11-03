// contract.mjs: the contract's hard rules, read the way promptwheel reads them. Shared by the CLI
// (frame / turn) and the Stop hook (the turn-level wall), so there is one resolver and one renderer.
// Read-only, never throws, zero-dep.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// mandates accumulate down the `extends` chain; a local mandate of the same name overrides an inherited one
export function resolvedMandates(repo) {
  const seen = new Set(); const byName = new Map();
  const load = (file) => {
    const p = resolve(file); if (seen.has(p)) return; seen.add(p);
    let cfg = null; try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { return; }
    if (!cfg || typeof cfg !== 'object') return;
    const ext = cfg.extends == null ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
    for (const e of ext) if (typeof e === 'string') load(resolve(dirname(p), e));
    for (const m of (Array.isArray(cfg.mandates) ? cfg.mandates : [])) if (m && m.name) byName.set(String(m.name), m);
  };
  load(join(repo, 'promptwheel.config.json'));
  return [...byName.values()].filter((m) => Array.isArray(m.paths) && m.paths.some((s) => typeof s === 'string' && s.trim()));
}

// the same glob dialect as promptwheel's evaluatorPaths / mandates (ported verbatim): a bare name
// matches that basename at any depth; a pattern with "/" is anchored at the repo root; "*" stops at
// "/", "**" crosses it, "?" is one char; a leading "/" anchors to the root explicitly.
export function globToRe(glob) {
  let g = glob; const anchored = g.startsWith('/'); if (anchored) g = g.slice(1);
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\x00/g, '.*');
  const pre = (anchored || glob.includes('/')) ? '^' : '(^|/)';
  return new RegExp(`${pre}${body}$`);
}

// which changed paths violate which mandate: [{ name, reason, files }]
export function mandateHits(repo, changedPaths) {
  const out = [];
  for (const m of resolvedMandates(repo)) {
    const res = m.paths.filter((s) => typeof s === 'string' && s.trim()).map(globToRe);
    const files = changedPaths.filter((f) => res.some((re) => re.test(f)));
    if (files.length) out.push({ name: String(m.name), reason: m.reason ? String(m.reason).slice(0, 300) : '', files: files.slice(0, 20) });
  }
  return out;
}

// the prompt face of the contract: one compact block, or '' when there is no contract
export function frameBlock(repo) {
  const mandates = resolvedMandates(repo);
  if (!mandates.length) return '';
  const lines = mandates.map((m) => `  ${m.paths.filter((s) => typeof s === 'string' && s.trim()).join(' · ')}${m.reason ? `  (${String(m.reason).slice(0, 160)})` : ''}`);
  return '▣ contract (sawbuck) · hard rules in force this session, enforced by the gate on every turn:\n  protected, do not touch:\n' + lines.join('\n');
}
