// What a person let through, and why. A change the check would send back passes when a person gives a reason:
// `sawbuck check --allow "<reason>"`. Until 0.1.68 that reason was printed once and kept nowhere. It joins the record
// now: kept in .sawbuck/allowed.jsonl once this repo is attached, and shown with the prompt that names the test or
// path it concerns, in `sawbuck context`, and as a count in `status`. It is shown as a past decision. It lets nothing
// through by itself: the next change to that test or path is checked like any other.
// Local, like the undo ledger, and out of git status. Never written in a repo sawbuck is not attached to. No model, no
// network. It keeps the reason as typed, the names it let through, the commit, and the files those names concern.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mandateHits } from './contract.mjs';

const MAX = 500;
export const allowedPath = (repo) => join(repo, '.sawbuck', 'allowed.jsonl');
const g = (repo, ...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

export function readAllowed(repo) {
  try { return readFileSync(allowedPath(repo), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.reason && Array.isArray(e.files)); } catch { return []; }
}

// the engine's words for its supply-chain counters, as it prints them on a pull request
const PLAIN = {
  lifecycle_scripts: 'a new install script', dependency_entries: 'a new dependency', lock_nonregistry_sources: 'a dependency from outside the registry',
  unpinned_execution: 'something that runs without a pinned version', install_policy_gaps: 'a weaker install policy',
  lock_drift: 'a change in the shape of the repo', pins_changed: 'a change in the resolved dependency versions',
};
const TESTISH = /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/|\.config\.|golden|fixture|snapshot)/i;
const MANIFEST = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|\.npmrc|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|promptwheel\.lock\.json)$/;
const RULES = /(^|\/)(promptwheel|sawbuck)\.config\.json$/;
const among = (changed, re) => { const f = changed.filter((x) => re.test(x)); return f.length ? f : changed; };

// one thing a reason let through: what it was, in words, and the files it concerns. Those are the goalposts (the test,
// the protected path, the manifest), not the whole change, so the entry comes back for them and not for every file
// the same commit happened to touch.
function thing(label, rep, changed, hits) {
  if (label.startsWith('mandate:')) {
    // the engine takes a rule it let through out of its report, so the paths are matched again here, against the
    // rules in force before the change; if that finds none, the whole change stands in, so the entry is not lost
    const name = label.slice(8); const hit = hits.find((x) => x.name === name);
    return { what: `the protected path "${name}"`, files: (hit && hit.files.length) ? hit.files : changed };
  }
  if (label === 'gate') return { what: 'a change to the check itself', files: among(changed, RULES) };
  const m = (rep.metrics || []).find((x) => x && x.name === label) || {};
  if (m.gamingReason) return { what: 'a win that came from editing the test', files: among(changed, TESTISH) };
  if (m.unprovable === false) return { what: 'a win that could not be re-proved', files: among(changed, TESTISH) };
  return { what: PLAIN[label] || `the guard "${label}"`, files: among(changed, MANIFEST) };
}

// Keep a change a person let through. `rep` is the engine's report for the run that passed with their reason. Returns
// the entry (new, or the one already kept for the same reason on the same commit), or null when nothing is kept: no
// reason, nothing let through, or a repo sawbuck is not attached to. Never throws.
export function recordAllowed(repo, rep, { dirty = false, base = 'HEAD~1', head = 'HEAD' } = {}) {
  try {
    const cleared = (rep && rep.allowed && Array.isArray(rep.allowed.cleared)) ? rep.allowed.cleared : [];
    const reason = String((rep && rep.allowed && rep.allowed.reason) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!cleared.length || !reason) return null;
    if (!existsSync(join(repo, '.sawbuck', 'state.json'))) return null;
    const changed = (dirty
      ? [...g(repo, 'diff', '--name-only', '--no-renames', 'HEAD').split('\n'), ...g(repo, 'ls-files', '--others', '--exclude-standard').split('\n')]
      : g(repo, 'diff', '--name-only', '--no-renames', base, head).split('\n')).filter(Boolean);
    const hits = cleared.some((l) => l.startsWith('mandate:')) ? mandateHits(repo, changed, { ref: dirty ? 'HEAD' : base }) : [];
    const things = cleared.map((l) => thing(l, rep, changed, hits));
    const files = [...new Set(things.flatMap((t) => t.files))].slice(0, 20);
    const entry = { at: new Date().toISOString(), sha: dirty ? '' : g(repo, 'rev-parse', head).slice(0, 12), reason, cleared, what: [...new Set(things.map((t) => t.what))], files };
    const same = (e) => e.sha === entry.sha && e.reason === reason && JSON.stringify(e.cleared) === JSON.stringify(cleared) && JSON.stringify(e.files) === JSON.stringify(files);
    const had = readAllowed(repo); const already = had.find(same);
    if (already) return already;
    if (had.length >= MAX) writeFileSync(allowedPath(repo), had.slice(-(MAX - 1)).map((e) => JSON.stringify(e)).join('\n') + '\n');
    appendFileSync(allowedPath(repo), JSON.stringify(entry) + '\n');
    return entry;
  } catch { return null; }
}

// the lines the prompt hook and `context` add for the paths in hand: newest first, one per decision, three at most
export function allowedLines(repo, changed) {
  const touched = new Set(changed || []); const out = [];
  for (const e of readAllowed(repo).reverse()) {
    const f = (e.files || []).filter((x) => touched.has(x)); if (!f.length) continue;
    const what = (Array.isArray(e.what) && e.what.length) ? e.what.join(', and ') : 'a change the check would have sent back';
    out.push(`    - ${f.slice(0, 3).join(', ')}: ${what} (${String(e.at).slice(0, 10)}, ${e.sha ? e.sha : 'before it was committed'}). The reason given: "${e.reason}"`);
    if (out.length === 3) break;
  }
  return out;
}
export function allowedBlock(repo, changed) {
  const lines = allowedLines(repo, changed);
  return lines.length ? ['let through here by a person, with a reason (a past decision, not a standing permission):', ...lines].join('\n') : '';
}
