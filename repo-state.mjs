// One read of what Sawbuck has here, shared by the statusline and `sawbuck status`. Files only, no git and no model.
// state: watching (wired in), ready (checkable, not wired yet), memory (history only), or empty.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WEEK = 7 * 864e5;

export function repoState(repo) {
  const record = (f) => { try { return JSON.parse(readFileSync(join(repo, '.sawbuck', f), 'utf8')); } catch { return null; } };
  const has = (f) => existsSync(join(repo, f));
  const results = record('results.json') || {};
  const caught = (results.regressions || 0) + (results.gamed || 0) + (results.mandates || 0);
  const hasConfig = has('promptwheel.config.json');
  const armed = hasConfig || has('package.json');
  const state = has('.sawbuck/state.json') ? 'watching' : armed ? 'ready' : (has('LOGBOOK.md') || has('events.jsonl')) ? 'memory' : '';
  // the reins engine's file; reins does the model work, never sawbuck. A rate nobody has updated for a week is
  // history, not a reading: the judge was turned off, or the plugin is not running.
  const s = record('steer.json');
  const live = s && s.scored && !(s.at && Date.now() - Date.parse(s.at) > WEEK);
  const steer = live ? { rate: Math.round(((s.ema != null ? s.ema : s.steeringRate) || 0) * 100), scored: s.scored } : null;
  return { results, caught, hasConfig, armed, state, steer };
}
