// bins.mjs: resolve the two engine CLIs once, for every sawbuck entry point.
// Order: env override (PW_BIN / LB_BIN), the installed package, then the dev sibling checkout.
// The memory engine is reached only through memory.mjs (the Memory Contract seam); LB lives
// here so the resolver is written once, not per file.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function resolveBin(envVar, pkgSubpath, devPath) {
  if (process.env[envVar]) return process.env[envVar];
  // deep bin subpath (no-exports pkgs, e.g. promptwheel), then the bare package name
  // (pkgs whose exports map "." to the bin, e.g. @promptwheel/logbook), then the dev sibling.
  const bare = pkgSubpath.replace(/\/bin\/[^/]*$/, '');
  for (const spec of [pkgSubpath, bare]) { try { return require.resolve(spec); } catch {} }
  return devPath;
}

export const PW = resolveBin('PW_BIN', 'promptwheel/bin/promptwheel.mjs', join(HERE, '..', 'promptwheel', 'bin', 'promptwheel.mjs'));
export const LB = resolveBin('LB_BIN', '@promptwheel/logbook/bin/logbook.mjs', join(HERE, '..', 'logbook', 'bin', 'logbook.mjs'));
