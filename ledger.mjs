// The shared ledger: what git threw away, on a ref the team and CI can fetch. The local ledger (.sawbuck/rewritten.jsonl)
// dies with the clone: a teammate, a fresh worktree on another machine, or the CI runner never sees the reverted attempt
// and its reason. `sawbuck ledger push` puts the merged ledger on refs/sawbuck/ledger (one file, ledger.jsonl, its own
// history, never on a branch) and pushes that ref; `sawbuck ledger pull` fetches it and folds it into the local ledger.
// Entries are keyed by subject and files, not by sha, because shas do not survive the rewrite that erased them.
// A person runs push and pull; no hook pushes anything. Reads and writes git only: no model, no network but the push.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const LEDGER_REF = 'refs/sawbuck/ledger';
const g = (repo, args, input) => { try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }); } catch { return ''; } };
const gErr = (repo, args) => { try { execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return ''; } catch (e) { return String((e.stderr || e.message || 'failed')).trim().split('\n').pop(); } };

export const entryKey = (e) => `${e.subject}\n${(e.files || []).slice().sort().join(',')}`;
const parse = (raw, extra) => raw.split('\n').filter(Boolean).map((l) => { try { return { ...JSON.parse(l), ...extra }; } catch { return null; } }).filter((e) => e && e.subject);

export const readLocal = (repo) => { try { return parse(readFileSync(join(repo, '.sawbuck', 'rewritten.jsonl'), 'utf8')); } catch { return []; } };
export const readShared = (repo) => parse(g(repo, ['show', `${LEDGER_REF}:ledger.jsonl`]), { shared: true });

// one entry per subject+files; the copy that carries the reason wins, and a shared mark survives a merge
export function merge(...lists) {
  const seen = new Map();
  for (const e of lists.flat()) {
    const k = entryKey(e); const had = seen.get(k);
    if (!had) { seen.set(k, { ...e }); continue; }
    const keep = (!had.why && e.why) ? { ...had, ...e } : { ...e, ...had };
    if (had.shared || e.shared) keep.shared = true;
    seen.set(k, keep);
  }
  return [...seen.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const strip = (e) => { const { shared, ...rest } = e; return rest; };
const hasRemote = (repo, remote) => g(repo, ['remote']).split('\n').filter(Boolean).includes(remote);
const fetchRef = (repo, remote) => gErr(repo, ['fetch', '-q', remote, `+${LEDGER_REF}:${LEDGER_REF}`]);

export function pushLedger(repo, remote = 'origin') {
  if (!hasRemote(repo, remote)) return { error: `no remote named ${remote}` };
  fetchRef(repo, remote);   // take what the remote has first, so two people pushing do not drop each other's entries
  const shared = readShared(repo); const all = merge(shared, readLocal(repo)).map(strip);
  const added = all.length - shared.length;
  if (!added && shared.length) return { pushed: false, entries: all.length, added: 0, remote };
  if (!all.length) return { pushed: false, entries: 0, added: 0, remote };
  const blob = g(repo, ['hash-object', '-w', '--stdin'], all.map((e) => JSON.stringify(e)).join('\n') + '\n').trim();
  const tree = g(repo, ['mktree'], `100644 blob ${blob}\tledger.jsonl\n`).trim();
  const parent = g(repo, ['rev-parse', '-q', '--verify', LEDGER_REF]).trim();
  const commit = g(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `sawbuck ledger: ${all.length} erased attempt${all.length === 1 ? '' : 's'}, ${added} new`]).trim();
  if (!blob || !tree || !commit) return { error: 'could not write the ledger commit (is a git identity configured?)' };
  g(repo, ['update-ref', LEDGER_REF, commit]);
  const err = gErr(repo, ['push', '-q', remote, `${LEDGER_REF}:${LEDGER_REF}`]);
  if (err) return { error: `push to ${remote} failed: ${err}` };
  return { pushed: true, entries: all.length, added, remote };
}

export function pullLedger(repo, remote = 'origin') {
  if (!hasRemote(repo, remote)) return { error: `no remote named ${remote}` };
  const err = fetchRef(repo, remote);
  const shared = readShared(repo);
  if (!shared.length) return { error: err && !/couldn.t find remote ref/i.test(err) ? `fetch from ${remote} failed: ${err}` : `${remote} has no ledger yet (nobody ran sawbuck ledger push there)` };
  const local = readLocal(repo); const before = local.length;
  const all = merge(local, shared);
  const attached = existsSync(join(repo, '.sawbuck', 'state.json'));
  if (attached) { mkdirSync(join(repo, '.sawbuck'), { recursive: true }); writeFileSync(join(repo, '.sawbuck', 'rewritten.jsonl'), all.map((e) => JSON.stringify(strip(e))).join('\n') + '\n'); }
  return { shared: shared.length, added: all.length - before, written: attached, remote };
}

// the counts status shows: what is kept here only, and what the team already has
export function ledgerState(repo) {
  const shared = readShared(repo), local = readLocal(repo);
  const sharedKeys = new Set(shared.map(entryKey));
  const onlyHere = local.filter((e) => !sharedKeys.has(entryKey(e))).length;
  return { shared: shared.length, local: local.length, onlyHere, hasRef: !!g(repo, ['rev-parse', '-q', '--verify', LEDGER_REF]).trim() };
}

export function ledgerCli(args, repo) {
  const sub = args.find((a) => !a.startsWith('-')); const remote = args.filter((a) => !a.startsWith('-'))[1] || 'origin';
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  if (sub === 'push') {
    const r = pushLedger(repo, remote); if (r.error) return { code: 1, text: `sawbuck: ledger not pushed: ${r.error}` };
    if (!r.entries) return { code: 0, text: 'sawbuck: nothing to push: no erased attempt is recorded here yet (the hook records them as it runs).' };
    return { code: 0, text: r.pushed ? `sawbuck: ledger pushed to ${remote} (${LEDGER_REF}): ${n(r.entries, 'erased attempt', 'erased attempts')}, ${r.added} new. A clone gets it with: sawbuck ledger pull` : `sawbuck: nothing new to push; ${remote} already holds all ${r.entries}.` };
  }
  if (sub === 'pull') {
    const r = pullLedger(repo, remote); if (r.error) return { code: 1, text: `sawbuck: ledger not pulled: ${r.error}` };
    return { code: 0, text: `sawbuck: ledger pulled from ${remote}: ${n(r.shared, 'erased attempt', 'erased attempts')} shared, ${r.added} new here${r.written ? '' : ' (read from the ref; attach to keep a local copy)'}.` };
  }
  const s = ledgerState(repo);
  const lines = [`sawbuck ledger: ${n(s.local, 'erased attempt', 'erased attempts')} kept here, ${s.shared} shared on ${LEDGER_REF}${s.hasRef ? '' : ' (no ref fetched yet)'}.`];
  if (s.onlyHere) lines.push(`  ${n(s.onlyHere, 'is', 'are')} on this machine only. sawbuck ledger push [remote] shares ${s.onlyHere === 1 ? 'it' : 'them'} with the team and CI.`);
  lines.push('  sawbuck ledger pull [remote] takes what the team shared into this clone.');
  return { code: 0, text: lines.join('\n') };
}
