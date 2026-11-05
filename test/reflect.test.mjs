// Behavior test for the Sawbuck glue (node:test). Run: npm test  (or: node --test)
//
// The whole M0 loop in one scenario, with the engines stubbed via PW_BIN / LB_BIN:
//   trip a bad commit -> the check says gamed -> reflect records it as a gamed
//   change in the results.
// Stubbing the check keeps this deterministic (no real metric run needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFLECT = join(HERE, '..', 'reflect.mjs');

// A repo with two commits; the second changes a source file (the finding target).
function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sawbuck-reflect-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'sawbuck-test');
  writeFileSync(join(dir, 'app.js'), 'export const v = 1;\n');
  git('add', '.'); git('commit', '-qm', 'init');
  writeFileSync(join(dir, 'app.js'), 'export const v = 2;\n');
  git('add', '.'); git('commit', '-qm', 'change app');
  // Stub engines (untracked -> absent from the diff reflect inspects).
  // The check engine keeps its own verdict vocabulary ('gamed'); Sawbuck surfaces the same word.
  const pw = join(dir, 'pw-stub.mjs');
  writeFileSync(pw, "console.log(JSON.stringify({verdict:'gamed',metrics:[{gamed:true,gamingReason:'tests were edited to pass'}]}));\n");
  const lb = join(dir, 'lb-stub.mjs');
  writeFileSync(lb, 'process.exit(0);\n');
  return { dir, env: { ...process.env, PW_BIN: pw, LB_BIN: lb } };
}

const runReflect = (dir, env) =>
  execFileSync(process.execPath, [REFLECT, '--repo', dir], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('reflect records a gamed result as a gamed change in the results', () => {
  const { dir, env } = setupRepo();
  try {
    runReflect(dir, env);
    const rec = JSON.parse(readFileSync(join(dir, '.sawbuck', 'results.json'), 'utf8'));
    assert.equal(rec.gamed, 1);
    assert.equal(rec.regressions, 0);
    assert.equal(rec.latest.kind, 'gamed');
    assert.equal(rec.latest.file, 'app.js');
    assert.match(rec.latest.reason, /gamed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
