// day.mjs: the day a record was written, as the clock of this machine has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// the time zone is read when a process starts, so each case is its own process
const day = (TZ, at) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { localDay } from ${JSON.stringify(join(HERE, '..', 'day.mjs'))}; process.stdout.write(localDay(${JSON.stringify(at)}));`], { encoding: 'utf8', env: { ...process.env, TZ } }).stdout;

test('an instant late in the evening west of Greenwich is that evening\'s day', () => {
  assert.equal(day('America/Los_Angeles', '2026-11-14T04:29:00.000Z'), '2026-11-13');
  assert.equal(day('UTC', '2026-11-14T04:29:00.000Z'), '2026-11-14');
});
test('an instant early in the morning east of Greenwich is that morning\'s day', () => {
  assert.equal(day('Asia/Tokyo', '2026-11-13T20:00:00.000Z'), '2026-11-14');
  assert.equal(day('Pacific/Auckland', '2026-12-31T12:00:00.000Z'), '2027-01-01');
});
test('a value that is already a day stays that day, wherever the machine is', () => {
  for (const TZ of ['America/Los_Angeles', 'UTC', 'Asia/Tokyo']) assert.equal(day(TZ, '2026-11-14'), '2026-11-14');
});
test('a value that is not a time comes back as its first ten characters, and nothing comes back as nothing', () => {
  assert.equal(day('UTC', 'not a time at all'), 'not a time');
  assert.equal(day('UTC', ''), '');
});
