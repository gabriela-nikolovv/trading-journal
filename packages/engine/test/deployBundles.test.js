import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = (f) => join(root, 'packages', 'engine', 'src', `${f}.js`);

function bundle(scriptName) {
  const script = readFileSync(join(root, 'scripts', scriptName), 'utf8');
  return script.match(/for f in ([^;]+); do/)[1].trim().split(/\s+/);
}
// Every file a bundle ships must only import other files the bundle also ships (or packages that
// the target runtime provides). A missing one would break the deploy, so check it here.
function checkBundle(name, files, entryPoints) {
  const have = new Set(files);
  for (const f of files) {
    assert.ok(existsSync(src(f)), `${name}: ${f}.js does not exist`);
    for (const m of readFileSync(src(f), 'utf8').matchAll(/from '(\.\/[^']+)'/g)) {
      const dep = m[1].replace('./', '').replace('.js', '');
      assert.ok(have.has(dep), `${name}: ${f}.js imports ./${dep}.js which is NOT in the bundle`);
    }
    for (const m of readFileSync(src(f), 'utf8').matchAll(/from '([^.][^']*)'/g)) assert.fail(`${name}: ${f}.js imports package "${m[1]}", which the runtime may not provide`);
  }
  for (const e of entryPoints) assert.ok(have.has(e), `${name}: entry module ${e} missing`);
}

test('Edge Function bundle is self-contained (sync + market functions can import everything they need)', () => {
  checkBundle('functions', bundle('copy-engine-to-functions.sh'), ['syncEngine', 'propreportsClient', 'marketData', 'positionAnalytics', 'taxonomy']);
});

test('Website bundle is self-contained and contains every module the views import', () => {
  const files = bundle('copy-engine-to-web.sh');
  checkBundle('web', files, ['weekBuilder', 'weeklyReport', 'weeklyReportPdfCore', 'calendar', 'schemaSeries', 'statistics', 'positionAnalytics', 'taxonomy', 'tradeStats', 'format']);
  // and every ./engine/x.js the web code imports is shipped
  const webJs = ['app', 'api', 'lib', 'pdf', 'main'].map((f) => readFileSync(join(root, 'web', 'js', `${f}.js`), 'utf8'))
    .concat(['dashboard', 'positions', 'calendar', 'trades', 'weekly', 'settings', 'charts', 'home'].map((f) => readFileSync(join(root, 'web', 'js', 'views', `${f}.js`), 'utf8')));
  for (const code of webJs) for (const m of code.matchAll(/engine\/([A-Za-z0-9]+)\.js/g)) assert.ok(files.includes(m[1]), `web imports engine/${m[1]}.js which is not copied`);
});
