// What was not said. The shape records what you pushed on; this records what the agent did, from your transcripts, so a
// spoke can be read against its opportunity: an agent that often changes code and runs nothing, in history where you
// rarely ask for proof, is a blind spot. Plain counting of tool calls. No model, nothing leaves this machine.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const VERIFY = /\b(test|tests|pytest|vitest|jest|mocha|ava|playwright|cargo (test|check)|go (test|vet)|tsc|eslint|lint|typecheck|npm run (build|check)|curl|sawbuck check|promptwheel run|make (test|check))\b/i;
const RISKY_PATH = /(^|\/)(\.env[^/]*|\.npmrc|\.yarnrc(\.yml)?|\.github\/workflows\/[^/]+|Dockerfile[^/]*|docker-compose[^/]*|CODEOWNERS|\.claude\/settings(\.local)?\.json|[^/]*(secret|credential)[^/]*)$/i;
const RISKY_CMD = /(git push[^|;&]*(--force|-f\b)|git reset --hard|curl[^|]*\|\s*(sh|bash)|sudo |drop table|chmod 777)/i;
// deleting a temp or build folder is housekeeping, not risk: on real history two thirds of rm -rf were that
const RM = /rm -rf\s+(\S+)/i, RM_SAFE = /tmp|scratch|\$|dist|build|node_modules|cache|\.next|coverage/i;
const SHIP = /\b(git commit|git push|npm publish|gh pr (create|merge)|gh release|vercel|deploy)\b/i;
const UI = /\.(css|scss|sass|less|tsx|jsx|vue|svelte|astro|html|svg)$/i;
const COPY = /\.(md|mdx|txt|rst)$/i;
const CODE = /\.(m?[jt]sx?|py|go|rs|rb|java|kt|cs|php|c|cc|cpp|h|swift|sh)$/i;
const BIG = 200;

function lines(s) { return s ? String(s).split('\n').length : 0; }

export function exposure({ root = join(homedir(), '.claude', 'projects') } = {}) {
  const WINDOW = 3;   // a check may come a turn or two later: count code as unchecked only if none ran in the next 3 turns
  const c = { turns: 0, working: 0, code: 0, unverified: 0, risky: 0, big: 0, shipped: 0, ui: 0, copy: 0, renames: 0, asked: 0 };
  const seen = new Set();
  let dirs = []; try { dirs = readdirSync(root); } catch { return c; }
  for (const d of dirs) {
    let files = []; try { files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      let turn = null;
      const T = [];
      const close = () => {
        if (!turn) return; c.turns++; T.push(turn);
        if (!turn.tools) return;
        c.working++;
        if (turn.code) c.code++;
        if (turn.risky) c.risky++; if (turn.added >= BIG) c.big++; if (turn.ship) c.shipped++; if (turn.ui) c.ui++; if (turn.copy) c.copy++; if (turn.rename) c.renames++;
        if (/\?\s*$/.test(turn.last)) c.asked++;
      };
      let text = ''; try { text = readFileSync(join(root, d, f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.isSidechain || e.isMeta) continue;
        if (e.uuid) { if (seen.has(e.uuid)) continue; seen.add(e.uuid); }   // a resumed session copies its history
        if (e.type === 'user') {
          const m = e.message && e.message.content;
          const typed = typeof m === 'string' || (Array.isArray(m) && m.length && m.every((b) => b.type === 'text'));
          if (typed) { close(); turn = { tools: 0, code: 0, verified: false, risky: false, added: 0, ship: false, ui: false, copy: false, rename: false, last: '' }; }
        } else if (turn && Array.isArray(e.message && e.message.content)) {
          for (const b of e.message.content) {
            if (b.type === 'text') turn.last = b.text || turn.last;
            if (b.type !== 'tool_use') continue;
            turn.tools++;
            const i = b.input || {};
            if (b.name === 'Bash') {
              const cmd = String(i.command || '');
              if (VERIFY.test(cmd)) turn.verified = true;
              const rm = cmd.match(RM);
              if (RISKY_CMD.test(cmd) || (rm && !RM_SAFE.test(rm[1]))) turn.risky = true;
              if (SHIP.test(cmd)) turn.ship = true;
              if (/\bgit mv\b/.test(cmd)) turn.rename = true;
            } else if (b.name === 'Edit' || b.name === 'Write' || b.name === 'MultiEdit') {
              const p = String(i.file_path || '');
              if (CODE.test(p)) turn.code++;
              if (UI.test(p)) turn.ui = true;
              if (COPY.test(p)) turn.copy = true;
              if (RISKY_PATH.test(p)) turn.risky = true;
              if (i.replace_all) turn.rename = true;
              turn.added += Math.max(0, lines(i.content || i.new_string) - lines(i.old_string));
            }
          }
        }
      }
      close();
      T.forEach((t, i) => { if (t.code && !T.slice(i, i + 1 + WINDOW).some((x) => x.verified)) c.unverified++; });
    }
  }
  return c;
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(exposure()));
