// Stabilizers (node:test). Each one turns a Sawbuck promise into a guarantee
// that fails loudly the day it stops being true:
//   1. the check has no model and no network (the $0 / un-gameable differentiator)
//   2+4. verify the verifier: the real engine catches gaming, clears honest work,
//        and emits exactly the JSON shape reflect.mjs consumes (the contract)
//   3. the check can never hang a commit/turn (a timeout backstop)
//   5. the glue never imports engine internals (option-B layer boundary)
//   6. detach --purge leaves zero trace
//   7. doctor flags an attachment whose hook no longer resolves
// Run: node --test

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'sawbuck.mjs');
const PW = require.resolve('promptwheel/bin/promptwheel.mjs');   // the check engine (sibling)
const GLUE_FILES = ['sawbuck.mjs', 'reflect.mjs', 'dispatch.mjs', 'sawbuck-hook.mjs', 'rank.mjs', 'debt.mjs', 'memory.mjs', 'status.mjs', 'bins.mjs', 'providers/obsidian.mjs', 'providers/local.mjs', 'providers/claude.mjs'].map((f) => join(HERE, '..', f));

const TMP_HOME = mkdtempSync(join(tmpdir(), 'sawbuck-shome-'));
after(() => rmSync(TMP_HOME, { recursive: true, force: true }));
const sawbuck = (args, cwd, env) => execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, ...env } });

function tmpGit() {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-stab-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'a.js'), 'export const v = 1;\n'); g('add', '-A'); g('commit', '-qm', 'init');
  return { d, g };
}

// ---- 1) the check is model-free and offline -------------------------------
test('stabilizer: no LLM SDK or network client enters the check path or the glue', () => {
  const llm = /\b(?:import|require)\b[^;\n]*['"](openai|@anthropic-ai\/[\w.-]+|anthropic|cohere-ai|langchain|@langchain\/[\w.-]+|@google\/generative-ai|@google\/genai|mistralai|replicate|ollama|groq-sdk|together-ai|@huggingface\/[\w.-]+)['"]/;
  const net = /\b(?:import|require)\b[^;\n]*['"](?:node:)?(https?|net|tls|dgram|http2|node-fetch|undici|axios|got|superagent)['"]/;
  const targets = [PW, ...GLUE_FILES];
  for (const f of targets) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!llm.test(src), `${f} must not import an LLM SDK (zero-model is the differentiator)`);
    assert.ok(!net.test(src), `${f} must not import a network client (zero-network is the differentiator)`);
  }
  // and nothing LLM-shaped declared as a dependency
  const badDep = /openai|anthropic|cohere|langchain|generative-ai|genai|mistral|replicate|ollama|groq|together|huggingface/i;
  for (const p of [join(HERE, '..', 'package.json'), require.resolve('promptwheel/package.json')]) {
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    for (const k of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.ok(!badDep.test(k), `${p} declares an LLM-ish dependency: ${k}`);
  }
});

// ---- 2 + 4) verify the verifier + lock the JSON contract reflect.mjs reads --
function pwReport(baseFiles, headFiles) {
  const metrics = [{ name: 'tests_pass', cmd: 'node test.js', extract: 'exit', direction: 'pass', guard: true }];
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-pw-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  try {
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics }));
    for (const [p, c] of Object.entries(baseFiles)) writeFileSync(join(d, p), c);
    g('add', '-A'); g('commit', '-qm', 'base');
    for (const [p, c] of Object.entries(headFiles)) writeFileSync(join(d, p), c);
    g('add', '-A'); g('commit', '-qm', 'head');
    let out = '';
    try { out = execFileSync(process.execPath, [PW, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--no-record', '--json'], { cwd: d, encoding: 'utf8' }); }
    catch (e) { out = (e.stdout || '').toString(); }
    const i = out.indexOf('{');
    return i >= 0 ? JSON.parse(out.slice(i)) : null;
  } finally { rmSync(d, { recursive: true, force: true }); }
}
const BASE = {
  'src.js': 'module.exports={add:(a,b)=>a+b};\n',
  'test.js': "const a=require('assert');const{add,subtract}=require('./src');a.strictEqual(add(2,2),4);a.strictEqual(subtract(5,3),2);\n",
};

test('stabilizer: the check CATCHES a gamed win and emits the contract reflect.mjs reads', () => {
  // head makes the suite pass by deleting the failing assertion, no source change
  const report = pwReport(BASE, { 'test.js': "const a=require('assert');const{add}=require('./src');a.strictEqual(add(2,2),4);\n" });
  assert.ok(report, 'the engine produced a JSON report');
  assert.equal(report.verdict, 'gamed', 'a test-only "win" is flagged gamed');
  const m = (report.metrics || []).find((x) => x.gamed === true);
  assert.ok(m, 'at least one metric carries gamed===true (the field reflect.mjs reads)');
  assert.equal(typeof m.gamingReason, 'string', 'gamingReason is a string (reflect.mjs surfaces it)');
});

test('stabilizer: the check CLEARS an honest fix (no false positive)', () => {
  // head fixes it in source, the win survives a source-only re-run
  const report = pwReport(BASE, { 'src.js': 'module.exports={add:(a,b)=>a+b,subtract:(a,b)=>a-b};\n' });
  assert.ok(report, 'the engine produced a JSON report');
  assert.equal(report.verdict, 'pass', 'an honest source fix is not flagged');
});

// ---- 3) the check can never hang a commit/turn ----------------------------
test('stabilizer: a hanging check is bounded by SAWBUCK_CHECK_TIMEOUT_MS', () => {
  const { d, g } = tmpGit();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics: [{ name: 'slow', cmd: 'sleep 5 && echo 0', extract: 'number', direction: 'down', guard: true }] }));
    g('add', '-A'); g('commit', '-qm', 'cfg');
    writeFileSync(join(d, 'a.js'), 'export const v = 2;\n'); g('add', '-A'); g('commit', '-qm', 'change');
    const t0 = Date.now();
    try { sawbuck(['check', '--base', 'HEAD~1', '--head', 'HEAD'], d, { SAWBUCK_CHECK_TIMEOUT_MS: '2000', LOGBOOK_NO_CACHE: '1' }); } catch { /* the one-shot exits nonzero when the metric is killed */ }
    const dt = Date.now() - t0;
    assert.ok(dt < 4500, `check returned in ${dt}ms, the 2s timeout fired before the 5s sleep finished`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- 5) the glue never imports engine internals (layer boundary) ----------
test('stabilizer: the glue only execs the engine bins, never imports their source', () => {
  const staticImport = /^\s*import\s[^;]*\bfrom\s*['"](promptwheel|@promptwheel\/logbook)(?:['"]|\/)/m;
  const requireCall = /\brequire\s*\(\s*['"](promptwheel|@promptwheel\/logbook)/;   // require.resolve(...) is allowed; require(...) is not
  // dynamic import of an engine's source (the old debt.mjs/rank.mjs trick: `await import(pathToFileURL(LB))`
  // to borrow auditHead/SUPPRESS_PAT). The memory engine is reachable ONLY by shelling its bin, through
  // memory.mjs; no glue file may import its source by any mechanism.
  const dynamicEngineImport = /\bimport\s*\(\s*(pathToFileURL|require\.resolve|['"`](?:promptwheel|@promptwheel\/logbook))/;
  for (const f of GLUE_FILES) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!staticImport.test(src), `${f} statically imports an engine (must spawn its bin instead)`);
    assert.ok(!requireCall.test(src), `${f} require()s an engine (use require.resolve + execFile)`);
    assert.ok(!dynamicEngineImport.test(src), `${f} dynamic-imports an engine's source (go through memory.mjs, which shells the bin)`);
  }
});

// ---- 6) detach --purge leaves zero trace ----------------------------------
test('stabilizer: detach --purge removes the record too', () => {
  const { d } = tmpGit();
  try {
    sawbuck(['attach', '.'], d);
    mkdirSync(join(d, '.sawbuck'), { recursive: true });
    writeFileSync(join(d, '.sawbuck', 'results.json'), '{}');
    sawbuck(['detach', '--purge', '.'], d);
    assert.ok(!existsSync(join(d, '.sawbuck')), 'the record dir is purged');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- 7) doctor + runtime-resolved hook ------------------------------------
test('stabilizer: the git hook resolves sawbuck at runtime (survives a reinstall)', () => {
  const { d } = tmpGit();
  try {
    sawbuck(['attach', '.'], d);
    const hook = readFileSync(join(d, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.match(hook, /command -v sawbuck/, 'prefers a sawbuck on PATH');
    assert.match(hook, /node "/, 'falls back to the absolute path');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('stabilizer: doctor reports a healthy attachment, and flags a stale one', () => {
  const { d } = tmpGit();
  try {
    sawbuck(['attach', '.'], d);
    assert.match(sawbuck(['doctor', '.'], d), /OK/, 'a live attachment is OK');
    // now simulate sawbuck having moved: a baked path that no longer exists, and not on PATH
    const pc = join(d, '.git', 'hooks', 'post-commit');
    writeFileSync(pc, `#!/bin/sh\n# >>> sawbuck >>>\nif command -v sawbuck >/dev/null 2>&1; then sawbuck __hook --repo ${JSON.stringify(d)}; else node "/no/such/sawbuck.mjs" __hook --repo ${JSON.stringify(d)}; fi || true\n# <<< sawbuck <<<\n`);
    assert.throws(() => sawbuck(['doctor', '.'], d, { SAWBUCK_NO_PATH_CHECK: '1' }), 'a stale attachment makes doctor exit nonzero');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
