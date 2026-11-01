// run-all.mjs - runs every Node suite in its own process; exits 1 if any fails.
// The Playwright suites (ui-browser, stats-browser) need a browser: run them with `npm run test:browser`.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUITES = ['purity.mjs', 'rules.mjs', 'conformance.mjs', 'smoke.mjs', 'controller.mjs', 'bots.mjs', 'sim-check.mjs', 'ui-node.mjs', 'stats-node.mjs'];
let failed = 0;
for (const s of SUITES) {
  const path = fileURLToPath(new URL(`./${s}`, import.meta.url));
  const r = spawnSync(process.execPath, [path], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`!! ${s} FAILED`); }
}
console.log(failed ? `${failed} suite(s) failed` : `All ${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
