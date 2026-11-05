// memory.mjs, Sawbuck's adapter to Logbook, the one place that calls it: history, live debt, and a note on a catch. Zero-dep.
// A read returns null when Logbook failed, [] when it ran clean, so unmeasurable never reads as clean.
import { execFileSync } from 'node:child_process';
import { LB } from './bins.mjs';

// null on a real failure, stdout otherwise
function run(bin, repo, args, maxBuffer = 512 * 1024 * 1024) {
  try { return execFileSync(process.execPath, [bin, ...args], { cwd: repo, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}
function parseArray(out) {
  const t = (out || '').trim();
  if (!t.startsWith('[')) return [];
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; } catch { return []; }
}

// --- debt sub-classification (Sawbuck policy; applied once so the ledger and the per-turn surface
// agree).
export const isTestSkip = (m) => /\bit\.skip\b|\btest\.skip\b|xit\(|xdescribe\(|\bdescribe\.skip\b|pytest\.mark\.skip|unittest\.skip|\bt\.Skip\b|@Disabled\b|@Ignore\b|^\[Ignore\b|^Skip\s*=|^#\[ignore|markTestSkipped|markTestIncomplete/.test(String(m).trim());
export const isDocumented = (c) => {
  c = String(c || '');
  if (/eslint-disable/.test(c)) return /eslint-disable(?:-next-line|-line)?\s+\S/.test(c);
  if (/@ts-ignore/.test(c)) return false;
  if (/@ts-expect-error/.test(c)) return /@ts-expect-error\s+\S/.test(c);
  if (/noqa/i.test(c)) return /noqa:\s*\w/i.test(c);
  if (/type:\s*ignore/i.test(c)) return /ignore\s*\[/.test(c);
  return /\(\s*["']/.test(c) || /=\s*["']/.test(c);
};

const classify = (r, source) => ({
  file: r.file, line: r.line, kind: String(r.kind ?? '').trim(), content: r.content ?? '',
  since: r.since ?? null, sha: r.sha ?? null,
  documented: r.content ? isDocumented(r.content) : false,
  testSkip: typeof r.testSkip === 'boolean' ? r.testSkip : isTestSkip(r.kind ?? r.content ?? ''),   // logbook >=0.9.8 classifies it; the regex is the fallback for older providers
  source,
});

// events(): the raw git event record, the ranking input. [] on failure, exactly as "no history".
export function events(repo) {
  const out = run(LB, repo, ['query', '--json'], 256 * 1024 * 1024);
  if (out === null) return [];
  return out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// debt(): live suppressions still in the tree, each classified. null when Logbook could not answer.
export function debt(repo, { paths = null, ref = null } = {}) {
  const out = run(LB, repo, ['audit', '--json', ...(ref ? ['--ref', ref] : []), ...((paths || []).flatMap((f) => ['--file', f]))]);
  return out === null ? null : parseArray(out).map((r) => classify(r, 'logbook'));
}

// record(): keep a machine finding as an annotation. Best-effort, never throws into the caller.
export function record(repo, { sha, reason, side, evidenceFile, by = 'sawbuck' }) {
  const text = String(reason).slice(0, 280);
  const exec = (a) => execFileSync(process.execPath, [LB, ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    try { exec(['annotate', sha, text, ...(side ? ['--side', side] : []), ...(evidenceFile ? ['--evidence-file', evidenceFile] : []), '--by', by]); }
    catch { exec(['annotate', sha, text, '--by', by]); }
    return true;
  } catch { return false; }
}
