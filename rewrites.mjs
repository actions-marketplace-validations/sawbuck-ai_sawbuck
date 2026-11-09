// What a rewrite erased. Logbook reads history, so a squash, a rebase or a force push takes the lesson with
// it: a reverted attempt stops being there to find. Git keeps those commits in the reflog for a while, so
// the commits a branch no longer reaches are read from there, kept in .sawbuck/rewritten.jsonl once this repo
// is attached (the reflog expires, the ledger does not), and surfaced by `context` for the paths in hand.
// Reads git only, no model, no network. The ledger is local until `sawbuck ledger push` puts it on refs/sawbuck/ledger
// for the team and CI (ledger.mjs). Never writes in a repo sawbuck is not attached to.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { shareFinding } from './share.mjs';
import { readLocal, readShared, merge as mergeLedgers } from './ledger.mjs';

const MAX = 300;
const g = (repo, ...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }); } catch { return ''; } };

// the local ledger plus whatever the team shared on refs/sawbuck/ledger (ledger.mjs), one entry per subject and files
function ledger(repo) { return mergeLedgers(readLocal(repo), readShared(repo)); }

// commits the reflog remembers and no ref reaches. An amend or a rebase replays the same subject, so a commit
// whose subject is still reachable was not lost, only rewritten, and a replayed one that is lost is listed once.
// The body comes along as the why: a revert's reason lives there, and it is the part a squash takes.
function fromReflog(repo) {
  const raw = g(repo, 'log', '--reflog', '--not', '--all', '-n', String(MAX), '--format=%x00%H%x09%cI%x09%s%x1f%b%x1f', '--name-only', '--no-renames');
  if (!raw.trim()) return [];
  const kept = new Set(g(repo, 'log', '--all', '-n', '5000', '--format=%s').split('\n'));
  const bySubject = new Map();
  for (const chunk of raw.split('\0').slice(1)) {
    const [head, body = '', tail = ''] = chunk.split('\x1f');
    const [sha, at, ...s] = head.split('\t');
    const subject = s.join('\t');
    if (!sha || kept.has(subject)) continue;
    const why = body.replace(/This reverts commit [0-9a-f]+\.?/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const had = bySubject.get(subject);
    if (had && (had.why || !why)) continue;   // one copy per subject; an amend that added the reason wins
    bySubject.set(subject, { sha, at, subject, revert: /^revert\b/i.test(subject), ...(why ? { why } : {}), files: tail.split('\n').filter(Boolean).slice(0, 50) });
  }
  return [...bySubject.values()];
}

// `Revert "cache: cap at 100 entries"` names the attempt as `cache: cap at 100 entries`, so a memory index does not read "reverted: Revert"
export const revertedSubject = (subject) => { const m = /^revert:?\s*"?(.+?)"?\s*$/i.exec(subject || ''); return m ? m[1] : subject; };

export function erasedCommits(repo) {
  const known = ledger(repo);
  const seen = new Set(known.map((e) => e.sha));
  const fresh = fromReflog(repo).filter((e) => !seen.has(e.sha));
  if (fresh.length && existsSync(join(repo, '.sawbuck', 'state.json'))) {
    try { appendFileSync(join(repo, '.sawbuck', 'rewritten.jsonl'), fresh.map((e) => JSON.stringify(e)).join('\n') + '\n'); } catch {}
    // a reverted attempt with its reason is also handed to a memory layer on this machine, once, if one is running
    for (const e of fresh) if (e.revert && e.why) shareFinding(repo, { kind: 'revert', title: `reverted: ${revertedSubject(e.subject)}`, text: e.why, files: e.files || [] }).catch(() => {});
  }
  return [...known, ...fresh];
}

// the lines `context` adds for the paths in hand: reverts first, then the checks that caught something here
export function erasedBlock(repo, changed) {
  const touched = new Set(changed);
  const hits = [], subjects = new Set();
  for (const e of erasedCommits(repo).filter((e) => (e.files || []).some((f) => touched.has(f)))
    .sort((a, b) => (b.revert - a.revert) || String(b.at).localeCompare(String(a.at)))) {
    if (subjects.has(e.subject)) continue;   // the ledger may hold a commit from before and after a rebase
    subjects.add(e.subject); hits.push(e); if (hits.length === 3) break;
  }
  let caught = [];
  try {
    caught = readFileSync(join(repo, '.sawbuck', 'activity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.kind === 'gamed' && touched.has(e.file)).slice(-2).reverse();
  } catch {}
  if (!hits.length && !caught.length) return '';
  const lines = ['not in git history any more (recovered locally, leads):'];
  for (const e of hits) lines.push(`    - ${e.revert ? 'reverted' : 'erased by a rewrite'}: ${e.subject} (${e.sha.slice(0, 12)}, ${String(e.at).slice(0, 10)})${e.why ? `: ${e.why}` : ''}`);
  for (const e of caught) lines.push(`    - caught as gamed on ${e.file} (${e.sha}, ${String(e.at).slice(0, 10)})`);
  return lines.join('\n');
}
