// testkit.mjs: every test file imports this first. It sits beside the code, not in test/, because node --test runs
// every file in test/ as a test. Each file gets one private folder that holds its temp repos and a
// throwaway HOME, removed when the file is done. Before it, a test that started sawbuck without its own HOME wrote the
// real ~/.sawbuck/registry.json, and one run of the suite left about 330 folders in /tmp.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

// the homes a stray run could reach: the HOME the suite was started with, and the account's own (what sawbuck falls
// back to when a child is started with no HOME at all)
const account = (() => { try { return userInfo().homedir; } catch { return ''; } })();
const wasClean = [...new Set([process.env.HOME, account])].filter((h) => h && !existsSync(join(h, '.sawbuck')));

export const ROOT = mkdtempSync(join(tmpdir(), 'sawbuck-test-'));
export const TMP_HOME = join(ROOT, 'home');
mkdirSync(TMP_HOME);
process.env.TMPDIR = ROOT;     // tmpdir() here and in every child this file starts
process.env.HOME = TMP_HOME;   // every child inherits it, unless a test passes a HOME of its own
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

// On a clean account (CI, the bare run before a release) a home that had no ~/.sawbuck must still have none.
after(() => { for (const h of wasClean) assert.ok(!existsSync(join(h, '.sawbuck')), `a test wrote ${join(h, '.sawbuck')}: it ran sawbuck without a throwaway HOME`); });
