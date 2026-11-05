// What was not said. The shape records what you pushed on; this counts what the agent did, from your transcripts, so a
// spoke can be read against its opportunity. Plain counting is only a lead: on real history most flagged turns had in fact
// verified, in ways no pattern saw. So each count keeps its turns, and a sample is read before a pattern is named.
// No model here, nothing leaves this machine.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readHistory, typedText } from './history.mjs';
import { SECRET } from './rules.mjs';

// A real check: a test runner, a build, a type or syntax check, a validator. The bare word "test" is not one: `test -f` and `cat test/a.js` matched it.
const VERIFY = /(npm (run )?test|yarn test|pnpm test|npx (vitest|jest|mocha|playwright|tsc|eslint)|node --(test|check)|bash -n|sh -n|pytest|vitest|\bjest\b|\bmocha\b|\bplaywright\b|cargo (test|check)|go (test|vet)|\btsc\b|\beslint\b|npm run (build|check|lint|typecheck)|astro build|sawbuck check|promptwheel run|make (test|check)|plugin (validate|test)|py_compile|unittest)/i;
// running the file you just edited is a check too; git add naming it is not
const RUNS = /(^|[\s;&|(])(node|python3?|bash|sh|tsx|\.\/)/;
const RISKY_PATH = /(^|\/)(\.env[^/]*|\.npmrc|\.yarnrc(\.yml)?|\.github\/workflows\/[^/]+|Dockerfile[^/]*|docker-compose[^/]*|CODEOWNERS|\.claude\/settings(\.local)?\.json|[^/]*(secret|credential)[^/]*)$/i;
const RISKY_CMD = /(git push(?![^|;&]*\b(v\d|refs\/tags))[^|;&]*(--force|-f\b)|git reset --hard|curl[^|]*\|\s*(sh|bash)|sudo |drop table|chmod 777)/i;
// deleting a temp or build folder is housekeeping, not risk: on real history two thirds of rm -rf were that
const RM = /rm -rf\s+([~\/.]\S*)/i, RM_SAFE = /tmp|scratch|\$|dist|build|node_modules|cache|\.next|coverage/i;   // a bare relative name is local cleanup
const CODE = /\.(m?[jt]sx?|py|go|rs|rb|java|kt|cs|php|c|cc|cpp|h|swift|sh)$/i;
const BIG = 200;
const SCRATCH = /(^|\/)(tmp|scratchpad|scratch)\/|^\/tmp\/|\/\.claude\//;   // throwaway work does not need a test run
const DAYS = 90;   // what to work on now, not what happened last year

// Rules you have already written, by spoke. A plain keyword match on your own files, so it is a hint: it finds that a
// rule on the subject exists, not that it says the right thing.
const WRITTEN = {
  proof: /\b(verify|verified|run the tests?|tests? pass|prove|proof|before claiming|before trusting)\b/i,
  safety: /\b(secrets?|credentials?|force.?push|destructive|protected paths?|never delete|before deleting)\b/i,
  simplicity: /\b(simple|simplify|bloat|smallest|minimal|keep it short|overengineer\w*)\b/i,
  autonomy: /\b(do not ask|don't ask|ask first|ask before|proceed without|keep going)\b/i,
};
export function writtenRules({ home = homedir(), repo = process.cwd() } = {}) {
  const files = [join(home, '.claude', 'CLAUDE.md'), join(home, '.sawbuck', 'rules.md'), join(repo, 'CLAUDE.md'), join(repo, 'AGENTS.md')];
  let text = '';
  for (const f of files) { try { text += '\n' + readFileSync(f, 'utf8'); } catch {} }
  return Object.fromEntries(Object.entries(WRITTEN).map(([s, re]) => [s, re.test(text)]));
}

function lines(s) { return s ? String(s).split('\n').length : 0; }

export function exposure({ root = join(homedir(), '.claude', 'projects'), days = DAYS } = {}) {
  const since = days ? Date.now() - days * 864e5 : 0;
  const WINDOW = 3;   // a check may come a turn or two later: count code as unchecked only if none ran in the next 3 turns
  const c = { turns: 0, working: 0, code: 0, unverified: 0, risky: 0, big: 0, asked: 0 };
  const examples = { proof: [], safety: [], autonomy: [] };
  const cut = (x, n) => String(x).replace(/\s+/g, ' ').trim().slice(0, n);
  const keep = (k, line) => { if (!SECRET.test(line)) examples[k].push(line); };
  let turn = null, T = [];
  const close = () => {
    if (!turn) return;
    c.turns++; T.push(turn);
    if (turn.tools) {
      c.working++;
      if (turn.code) c.code++;
      if (turn.risky) { c.risky++; keep('safety', `you: ${cut(turn.you, 160)} | it did: ${cut(turn.risky, 160)}`); }
      if (turn.added >= BIG) c.big++;
      if (/\?\s*$/.test(turn.last)) { c.asked++; keep('autonomy', `you: ${cut(turn.you, 160)} | it ended with: ${cut(turn.last.slice(-220), 220)}`); }
    }
    turn = null;
  };
  const endSession = () => {
    close();
    T.forEach((t, i) => {
      const next = T.slice(i, i + 1 + WINDOW);
      if (!t.code || next.some((x) => x.verified || t.edited.some((f) => x.runs.includes(f)))) return;
      c.unverified++;
      keep('proof', `you: ${cut(t.you, 160)} | edited: ${t.edited.slice(0, 4).join(' ')} | commands after: ${next.flatMap((x) => x.cmds).slice(-5).map((x) => cut(x, 80)).join(' ;; ')} | it said: ${cut(t.last.slice(-160), 160)}`);
    });
    T = [];
  };
  const onTool = (b) => {
    turn.tools++;
    const i = b.input || {};
    if (b.name === 'Bash') {
      const cmd = String(i.command || '');
      if (VERIFY.test(cmd)) turn.verified = true;
      if (RUNS.test(cmd) && !/^\s*git\b/.test(cmd)) turn.runs += '\n' + cmd.slice(0, 2000);
      const rm = cmd.match(RM);
      if (RISKY_CMD.test(cmd) || (rm && !RM_SAFE.test(rm[1]))) turn.risky = cmd;
      turn.cmds.push(cmd);
    } else if (b.name === 'Edit' || b.name === 'Write' || b.name === 'MultiEdit') {
      const p = String(i.file_path || '');
      if (CODE.test(p) && !SCRATCH.test(p)) { turn.code++; turn.edited.push(p.split('/').pop()); }
      if (RISKY_PATH.test(p)) turn.risky = `edited ${p}`;
      turn.added += Math.max(0, lines(i.content || i.new_string) - lines(i.old_string));
    }
  };
  readHistory(root, {
    onSession: endSession,
    onEvent: (e) => {
      if (since && e.timestamp && Date.parse(e.timestamp) < since) return;
      if (e.type === 'user') {
        if (typedText(e.message) === null) return;
        close();
        turn = { you: typedText(e.message), tools: 0, code: 0, edited: [], cmds: [], runs: '', verified: false, risky: '', added: 0, last: '' };
      } else if (turn && Array.isArray(e.message && e.message.content)) {
        for (const b of e.message.content) {
          if (b.type === 'text') turn.last = b.text || turn.last;
          if (b.type === 'tool_use') onTool(b);
        }
      }
    },
  });
  return { ...c, examples };
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(exposure()));
