// copies.mjs: which sawbuck answers a line that names no version, and the line that reaches this one.
//
// A line with a version in it (`npx -y sawbuck@0.1.72 check`, a hook's own path) says which copy it means. A line
// without one (`sawbuck check`, `npx -y sawbuck check`) is answered by whatever the machine holds: a global install
// first (npm runs it for `npx sawbuck` and asks the registry nothing), and on npm 8 the copy of the first npx run.
// A global copy does not update itself, and until 0.1.72 nothing here looked for one. Measured 2026-11-15
// (proof-bench/old-global): 36 of 36 on npm 8 to 11; a repo wired with `attach --git` by the newest copy had every
// commit checked by a global 0.1.46, and an honest fix was recorded as gamed.
//
// The look is the first `sawbuck` on PATH and the package.json beside its real path: about 0.1 ms, no child
// process, so a hook can afford it on a prompt. It does not ask npm for its global prefix (70 to 120 ms), so a
// global copy whose folder is not on PATH is missed here.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'sawbuck.mjs');
export const VERSION = (() => { try { return String(JSON.parse(readFileSync(join(dirname(MAIN), 'package.json'), 'utf8')).version || ''); } catch { return ''; } })();
const real = (p) => { try { return realpathSync(p); } catch { return ''; } };

// three numbers, compared as numbers: 0.1.9 is older than 0.1.10. A version that is not three numbers is neither
// older nor newer than anything, so nothing is said about it.
export function older(a, b) {
  const n = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? m.slice(1).map(Number) : null; };
  const x = n(a), y = n(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

// The first sawbuck on PATH: { path, real, version, self }, or null. `self` when it is this very copy; `version` is
// '' when what is there is not an npm install of sawbuck (a wrapper script: nothing is claimed about it).
// SAWBUCK_PATH_LOOK, when set, is the list looked at in place of PATH (empty: look nowhere). The suites set it, so a
// sawbuck installed on the machine that runs them is not taken for part of a test.
export function onPath(env = process.env) {
  if (process.platform === 'win32') return null;   // a .cmd shim there, not read
  const list = env.SAWBUCK_PATH_LOOK !== undefined ? env.SAWBUCK_PATH_LOOK : env.PATH;
  for (const d of String(list || '').split(delimiter)) {
    if (!d) continue;
    const f = join(d, 'sawbuck');
    if (!existsSync(f)) continue;
    const r = real(f);
    if (!r) continue;
    let version = '';
    try { const p = JSON.parse(readFileSync(join(dirname(r), 'package.json'), 'utf8')); if (p.name === 'sawbuck') version = String(p.version || ''); } catch { /* not an npm install */ }
    return { path: f, real: r, version, self: r === real(MAIN) };
  }
  return null;
}

// another copy, older than this one, that a line with no version would reach
export function olderOnPath(env) { const p = onPath(env); return p && !p.self && older(p.version, VERSION) ? p : null; }
// another copy, newer than this one: the person has updated since this copy was wired in
export function newerOnPath(env) { const p = onPath(env); return p && !p.self && older(VERSION, p.version) ? p : null; }

// the line a person on this machine can type to run this version. A bare `sawbuck` only when that is this copy or
// one of the same version: for a person who has the plugin and nothing else it is no command at all, and beside an
// older global copy it is that one.
export function cli(args, env) { const p = onPath(env); return p && (p.self || p.version === VERSION) ? `sawbuck ${args}` : `npx -y sawbuck@${VERSION} ${args}`; }

// what to say when an older copy would answer. One line for the agent (the exact line to use for the rule's check),
// one for the person (the one command that updates it).
export function olderSaid(env) {
  const p = olderOnPath(env);
  if (!p) return null;
  return {
    copy: p,
    agent: `▣ sawbuck here is ${VERSION}. On this machine a line with no version in it (\`sawbuck ...\`, \`npx -y sawbuck ...\`) runs an older copy, ${p.version} (${p.path}). Where the rule says \`npx -y sawbuck check\` or \`context\`, run this exact line instead: npx -y sawbuck@${VERSION} check`,
    person: `Sawbuck: an older copy of sawbuck is installed on this machine, ${p.version} (${p.path}). A bare \`sawbuck\` and \`npx sawbuck\` run that one, not the ${VERSION} that is watching this repo, and the two can disagree. To update it: npm i -g sawbuck@latest`,
  };
}
