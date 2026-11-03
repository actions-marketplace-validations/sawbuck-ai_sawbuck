// contract.mjs: the contract's hard rules, read the way promptwheel reads them. Shared by the CLI
// (frame / turn) and the Stop hook (the turn-level wall), so there is one resolver and one renderer.
// Read-only, never throws, zero-dep.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute, posix } from 'node:path';
import { execFileSync } from 'node:child_process';

const gitOut = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const validMandate = (m) => m && Array.isArray(m.paths) && m.paths.some((s) => typeof s === 'string' && s.trim());
const pathsOf = (m) => m.paths.filter((s) => typeof s === 'string' && s.trim());

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
  return [...byName.values()].filter(validMandate);
}

// the mandates COMMITTED at `ref` (default HEAD), read with `git show` and following `extends` inside
// the repo, the way promptwheel reads a gate at a ref. [] when there is no config there.
export function resolvedMandatesAt(repo, ref = 'HEAD') {
  const seen = new Set(); const byName = new Map();
  const load = (p) => {
    if (seen.has(p)) return; seen.add(p);
    let raw = null; try { raw = gitOut(repo, ['show', `${ref}:${p}`]); } catch { return; }
    let cfg = null; try { cfg = JSON.parse(raw); } catch { return; }
    if (!cfg || typeof cfg !== 'object') return;
    const ext = cfg.extends == null ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
    for (const e of ext) if (typeof e === 'string' && !isAbsolute(e)) load(posix.normalize(posix.join(posix.dirname(p), e.split('\\').join('/'))));
    for (const m of (Array.isArray(cfg.mandates) ? cfg.mandates : [])) if (m && m.name) byName.set(String(m.name), m);
  };
  load('promptwheel.config.json');
  return [...byName.values()].filter(validMandate);
}

// the rules in force for a turn: the working-tree contract, plus every committed mandate the working
// tree does not carry unchanged (same name, same paths). Editing the contract in the working tree
// does not lift a committed rule, so a change cannot disarm the wall and break it in one turn; a
// rule that comes only from the commit is tagged `committed`.
export function mandatesInForce(repo, ref = 'HEAD') {
  const wt = resolvedMandates(repo);
  const key = (m) => JSON.stringify([String(m.name), pathsOf(m).sort()]);
  const have = new Set(wt.map(key));
  const committed = resolvedMandatesAt(repo, ref).filter((m) => !have.has(key(m))).map((m) => ({ ...m, committed: true }));
  return [...wt, ...committed];
}

// a working-tree file's content hash as git would store it; 'deleted' when it is gone
export function hashOf(repo, file) {
  try { return gitOut(repo, ['hash-object', '--', file]).trim(); } catch { return 'deleted'; }
}

// the protected paths that are dirty right now, each with its content hash: the baseline `turn`
// records when a prompt begins, so the Stop hook counts only what the turn itself changed and leaves
// a person's own pre-existing edits alone. {} when nothing protected is dirty (or not a git repo).
export function protectedDirty(repo) {
  let changed = [];
  try { changed = [...new Set([...gitOut(repo, ['diff', '--name-only', 'HEAD']).split('\n'), ...gitOut(repo, ['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean))]; }
  catch { return {}; }
  const res = mandatesInForce(repo).flatMap((m) => pathsOf(m).map(globToRe));
  const out = {};
  for (const f of changed) if (res.some((re) => re.test(f))) out[f] = hashOf(repo, f);
  return out;
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

// which changed paths violate which mandate: [{ name, reason, files, committed? }]. The rules are the
// working tree's plus the committed ones (mandatesInForce); pass { ref: null } for the working tree alone.
export function mandateHits(repo, changedPaths, opts = {}) {
  const list = opts.ref === null ? resolvedMandates(repo) : mandatesInForce(repo, opts.ref || 'HEAD');
  const out = [];
  for (const m of list) {
    const res = pathsOf(m).map(globToRe);
    const files = changedPaths.filter((f) => res.some((re) => re.test(f)));
    if (!files.length) continue;
    const prev = out.find((h) => h.name === String(m.name));
    if (prev) { prev.files = [...new Set([...prev.files, ...files])].slice(0, 20); if (!prev.reason && m.reason) prev.reason = String(m.reason).slice(0, 300); continue; }
    out.push({ name: String(m.name), reason: m.reason ? String(m.reason).slice(0, 300) : '', files: files.slice(0, 20), ...(m.committed ? { committed: true } : {}) });
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
