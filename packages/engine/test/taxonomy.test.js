import test from 'node:test';
import assert from 'node:assert/strict';
import { TRADINGVIEW_TAXONOMY, PUBLISHED_INDUSTRY_COUNTS, flattenTaxonomy, industriesForSector, matchTaxonomy, fetchTradingViewClassification } from '../src/taxonomy.js';

test('every sector has exactly the industry count TradingView publishes (129 industries, 20 sectors)', () => {
  assert.equal(Object.keys(TRADINGVIEW_TAXONOMY).length, 20);
  for (const [sector, n] of Object.entries(PUBLISHED_INDUSTRY_COUNTS)) {
    assert.equal(industriesForSector(sector).length, n, `${sector}`);
  }
  assert.equal(flattenTaxonomy().length, 129);
});

test('no industry name appears in two sectors except TradingView\'s own same-named "Miscellaneous"', () => {
  const seen = new Map();
  for (const r of flattenTaxonomy()) {
    if (seen.has(r.industry)) assert.fail(`${r.industry} is in both ${seen.get(r.industry)} and ${r.sector}`);
    seen.set(r.industry, r.sector);
  }
});

test('spec example: Health Technology never offers Software industries; Software lives under Technology Services', () => {
  const ht = industriesForSector('Health Technology');
  assert.ok(ht.includes('Biotechnology'));
  assert.ok(!ht.includes('Packaged Software'));
  assert.ok(industriesForSector('Technology Services').includes('Packaged Software'));
  assert.deepEqual(industriesForSector('Not A Sector'), []);
});

test('matching tolerates case / "&" / spacing differences but never forces a mismatched pair', () => {
  assert.deepEqual(matchTaxonomy('Electronic technology', 'telecommunications equipment'), { status: 'ok', sector: 'Electronic Technology', industry: 'Telecommunications Equipment' });
  assert.equal(matchTaxonomy('Retail trade', 'Aerospace and Defense').status, 'unmapped'); // real industry, wrong sector
  assert.equal(matchTaxonomy('Electronic Technology', 'Aerospace and Defense').status, 'ok'); // "and" == "&"
  assert.equal(matchTaxonomy('Made Up', 'Whatever').status, 'unmapped');
});

test('classification: scanner rows are mapped; unknown tickers and unknown taxonomy names are unmapped (not invented)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [
    { s: 'NASDAQ:AAPL', d: ['AAPL', 'Electronic Technology', 'Telecommunications Equipment'] },
    { s: 'NYSE:WEIRD', d: ['WEIRD', 'Some New Sector', 'Odd'] },
  ] }) });
  const m = await fetchTradingViewClassification(['AAPL', 'weird', 'GHOST'], { fetchImpl });
  assert.equal(m.get('AAPL').status, 'ok');
  assert.equal(m.get('WEIRD').status, 'unmapped');
  assert.match(m.get('GHOST').reason, /no classification for GHOST/);
});

test('classification: network or HTTP failure → "could not be retrieved", nothing invented', async () => {
  const down = await fetchTradingViewClassification(['AAPL'], { fetchImpl: async () => { throw new Error('x'); } });
  assert.equal(down.get('AAPL').status, 'unavailable');
  const http = await fetchTradingViewClassification(['AAPL'], { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  assert.match(http.get('AAPL').reason, /HTTP 503/);
});
