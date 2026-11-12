// A dependency edited in place. The check re-runs the tests in a clean copy of each commit, and that copy borrows the
// installed dependencies from the working tree (node_modules, the venv). An edit made inside them is in no diff. The
// outside-git bench (2026-11-11) measured it: with a library patched by hand in node_modules, or a plugin planted in
// the venv, the check read "tests pass before and after" while a fresh install was red. Nothing here can prove such a
// green, so the turn says so: a notice to the person, once, never a block (they may have asked for the patch).
// Recorded by the edit-tool hooks, which name the file exactly, and by the Bash hook for the plain ways a shell writes
// a file (sed -i, a redirect, tee, patch, cp, mv). A write made some other way is not seen: a hint, not a proof.
// At the end of the turn each record is checked against the file itself, so a command that never ran says nothing.
// Deterministic. No model. Stores a path and a time, nothing else.
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, isAbsolute, relative, resolve } from 'node:path';

const DEP = /(^|\/)(node_modules|site-packages|dist-packages)\/(?!\.(?!pnpm\/))|(^|\/)\.cargo\/registry\/|(^|\/)go\/pkg\/mod\//;
const slash = (p) => String(p || '').replace(/\\/g, '/');
// inside an installed dependency (not a tool's cache folder under node_modules, which tools write all the time)
export const inDependency = (p) => DEP.test(slash(p));
export const depEditsPath = (repo) => join(repo, '.sawbuck', 'dep-edits.jsonl');

// the file a plain shell write lands on, when that file is inside a dependency folder; else ''
const TARGET = String.raw`((?:[^\s"'|;&<>]*\/)?(?:node_modules|site-packages|dist-packages)\/[^\s"'|;&<>]+)`;
const WRITES = [
  new RegExp(String.raw`\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b[^|;&]*?["']?` + TARGET),
  new RegExp(String.raw`\bperl\s+-[a-zA-Z]*i[a-zA-Z]*\b[^|;&]*?["']?` + TARGET),
  new RegExp(String.raw`>>?\s*["']?` + TARGET),
  new RegExp(String.raw`\btee\s+(?:-a\s+)?["']?` + TARGET),
  new RegExp(String.raw`\bpatch\b[^|;&]*?["']?` + TARGET),
  new RegExp(String.raw`\b(?:cp|mv|install)\b[^|;&]*\s["']?` + TARGET + String.raw`["']?\s*(?:$|[|;&])`),
];
export function bashDependencyWrite(command) {
  const c = String(command || '');
  for (const re of WRITES) { const m = re.exec(c); if (m && inDependency(m[1])) return m[1]; }
  return '';
}

// one line in the record. Never writes in a repo sawbuck is not attached to. Never throws.
export function noteDependencyEdit(repo, file, { cwd = '', how = 'edit' } = {}) {
  try {
    if (!repo || !file || !inDependency(file)) return null;
    if (!existsSync(join(repo, '.sawbuck', 'state.json'))) return null;
    const abs = isAbsolute(file) ? file : resolve(cwd || repo, file);
    const entry = { at: new Date().toISOString(), file: abs, how };
    mkdirSync(join(repo, '.sawbuck'), { recursive: true });
    appendFileSync(depEditsPath(repo), JSON.stringify(entry) + '\n');
    return entry;
  } catch { return null; }
}

// from a hook's JSON: an edit tool after it ran, a Codex patch, a Cursor edit, or a shell command about to run
export function dependencyEditFromHook(body, repo) {
  let h; try { h = JSON.parse(body || '{}'); } catch { return []; }
  const out = []; const cwd = typeof h.cwd === 'string' ? h.cwd : '';
  const input = h.tool_input || {};
  const add = (f, how) => { const e = noteDependencyEdit(repo, f, { cwd, how }); if (e) out.push(e); };
  if (h.hook_event_name === 'PreToolUse' && !h.command && !h.file_path && h.tool_name !== 'Bash' && h.tool_name !== 'apply_patch') return out;   // an edit tool is noted after it ran
  if (typeof input.file_path === 'string') add(input.file_path, 'edit');
  if (typeof input.notebook_path === 'string') add(input.notebook_path, 'edit');
  if (typeof h.file_path === 'string') add(h.file_path, 'edit');   // Cursor's afterFileEdit
  const patch = input.command || input.patch || input.input;
  if (h.tool_name === 'apply_patch' && typeof patch === 'string') for (const m of patch.matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)) add(m[1].trim(), 'edit');
  const cmd = h.tool_name === 'Bash' && typeof input.command === 'string' ? input.command : (typeof h.command === 'string' ? h.command : '');
  if (cmd) { const f = bashDependencyWrite(cmd); if (f) add(f, 'shell'); }
  return out;
}

// the package a path belongs to, as people write it: "ms", "@scope/name", "requests"
export function packageOf(file) {
  const p = slash(file);
  const nm = p.includes('node_modules/') ? p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length) : '';
  if (nm) { const s = nm.split('/'); return s[0].startsWith('@') ? `${s[0]}/${s[1] || ''}` : s[0]; }
  const sp = /(?:site-packages|dist-packages)\/([^/]+)/.exec(p);
  return sp ? sp[1].replace(/\.py$/, '') : '';
}

// the package was installed again after the edit was recorded (its own manifest is newer than the record): the edit
// is gone, or it came from the install itself, and there is nothing to say
function installedAgain(file, pkg, atMs) {
  const p = slash(file);
  try {
    if (p.includes('node_modules/') && pkg) {
      const root = p.slice(0, p.lastIndexOf('node_modules/') + 'node_modules/'.length) + pkg;
      const manifest = `${root}/package.json`;
      return manifest !== p && statSync(manifest).mtimeMs >= atMs - 2000;
    }
    const m = /^(.*\/(?:site-packages|dist-packages))\//.exec(p);
    if (m && pkg) {
      const want = pkg.toLowerCase().replace(/[-_.]+/g, '_');
      for (const n of readdirSync(m[1])) {
        if (!n.endsWith('.dist-info') || !n.toLowerCase().replace(/[-_.]+/g, '_').startsWith(want + '_')) continue;
        try { if (statSync(join(m[1], n, 'RECORD')).mtimeMs >= atMs - 2000) return true; } catch {}
      }
    }
  } catch {}
  return false;
}

// a patch kept in the repo for that package (patch-package, pnpm, yarn), written since the edit: then the edit is one a
// fresh install will have, and there is nothing to say
function keptAsPatch(repo, pkg, sinceMs) {
  if (!pkg) return false;
  const want = pkg.replace('/', '+').toLowerCase(), alt = pkg.replace('/', '__').toLowerCase(), plain = pkg.toLowerCase();
  for (const dir of ['patches', '.yarn/patches']) {
    let names = []; try { names = readdirSync(join(repo, dir)); } catch { continue; }
    for (const n of names) {
      const l = n.toLowerCase();
      if (!(l.startsWith(want) || l.startsWith(alt) || l.startsWith(plain) || l.includes(plain.replace('/', '-')))) continue;
      try { if (statSync(join(repo, dir, n)).mtimeMs >= sinceMs - 2000) return true; } catch {}
    }
  }
  return false;
}

// what to say at the end of a turn: the files recorded after `sinceIso` that really were written since they were
// recorded and are not kept as a patch. Newest record per file. [] when there is nothing to say.
export function dependencyEditsSince(repo, sinceIso) {
  let lines = []; try { lines = readFileSync(depEditsPath(repo), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const since = Date.parse(sinceIso || '') || 0; const byFile = new Map();
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e || !e.file || !(Date.parse(e.at) > since)) continue;
    byFile.set(e.file, e);
  }
  const out = [];
  for (const e of byFile.values()) {
    let m = 0; try { m = statSync(e.file).mtimeMs; } catch { continue; }           // gone again: nothing to say
    if (m < Date.parse(e.at) - 2000) continue;                                       // recorded, never written
    if (installedAgain(e.file, packageOf(e.file), Date.parse(e.at))) continue;        // reinstalled since: the edit is gone
    if (keptAsPatch(repo, packageOf(e.file), Date.parse(e.at))) continue;
    const rel = relative(repo, e.file);
    out.push({ ...e, shown: rel && !rel.startsWith('..') ? slash(rel) : slash(e.file), pkg: packageOf(e.file) });
  }
  return out.sort((a, b) => a.shown.localeCompare(b.shown));
}

// the notice, or '' when there is nothing to say
export function dependencyNotice(edits) {
  if (!edits || !edits.length) return '';
  const names = edits.slice(0, 3).map((e) => e.shown).join(', ') + (edits.length > 3 ? `, and ${edits.length - 3} more` : '');
  const py = edits.some((e) => /site-packages|dist-packages/.test(e.shown));
  return `Sawbuck: ${edits.length === 1 ? 'a file' : 'files'} inside an installed dependency ${edits.length === 1 ? 'was' : 'were'} edited here: ${names}. That edit is in no commit, and a fresh install will not have it, so tests that pass here can fail everywhere else. The check cannot prove a green that leans on it. If you meant it, keep it as a patch your install applies. If not, install again (${py ? 'pip install --force-reinstall <package>' : 'npm ci'}) and fix it in your own code.`;
}
