import test from 'node:test';
import assert from 'node:assert/strict';
import { toYahooSymbol, parseYahooChart, createYahooProvider, createQuoteService } from '../src/marketData.js';

// Fixture shaped like Yahoo's v8 chart response (meta block only matters to us).
// NOTE: built from the documented/observed shape of this unofficial endpoint, NOT captured live from here.
const NOW = Date.parse('2026-09-04T15:00:00Z'); // Friday 11:00 New York (regular session)
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
const chart = (over = {}) => ({
  chart: { error: null, result: [{ meta: {
    symbol: 'AAPL', currency: 'USD', regularMarketPrice: 210.5, regularMarketTime: sec('2026-09-04T14:59:50Z'),
    currentTradingPeriod: {
      pre: { start: sec('2026-09-04T08:00:00Z'), end: sec('2026-09-04T13:30:00Z') },
      regular: { start: sec('2026-09-04T13:30:00Z'), end: sec('2026-09-04T20:00:00Z') },
      post: { start: sec('2026-09-04T20:00:00Z'), end: sec('2026-09-05T00:00:00Z') },
    }, ...over } }] },
});

test('symbol mapping: class shares use Yahoo dash notation, everything else untouched', () => {
  assert.equal(toYahooSymbol('BRK.B'), 'BRK-B');
  assert.equal(toYahooSymbol(' aapl '), 'AAPL');
  assert.equal(toYahooSymbol('XYZ'), 'XYZ');
});

test('regular-session price parses with its real timestamp and session', () => {
  const q = parseYahooChart(chart(), 'AAPL', NOW);
  assert.deepEqual([q.ok, q.price, q.session, q.stale, q.source], [true, 210.5, 'regular', false, 'yahoo']);
  assert.equal(q.asOf, '2026-09-04T14:59:50.000Z');
});

test('market closed overnight is NOT an error: last price returned, session "closed", not stale', () => {
  const night = Date.parse('2026-09-05T03:00:00Z');
  const q = parseYahooChart(chart(), 'AAPL', night);
  assert.equal(q.ok, true);
  assert.equal(q.session, 'closed');
  assert.equal(q.stale, false);
});

test('a price older than a long weekend is flagged stale with a reason', () => {
  const later = Date.parse('2026-09-12T15:00:00Z');
  const q = parseYahooChart(chart(), 'AAPL', later);
  assert.equal(q.stale, true);
  assert.match(q.staleReason, /days ago/);
});

test('unknown symbol → unavailable with an explanation, no price invented', () => {
  const q = parseYahooChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }, 'ZZZZ', NOW);
  assert.equal(q.ok, false);
  assert.equal(q.price, undefined);
  assert.match(q.reason, /no price for ZZZZ/);
});

test('Yahoo answering with a DIFFERENT symbol is rejected (no silent substitution)', () => {
  const q = parseYahooChart(chart({ symbol: 'AAPL.MX' }), 'AAPL', NOW);
  assert.equal(q.ok, false);
  assert.match(q.reason, /wrong instrument/);
});

test('zero / missing price is unavailable, not $0', () => {
  assert.equal(parseYahooChart(chart({ regularMarketPrice: 0 }), 'AAPL', NOW).ok, false);
  assert.equal(parseYahooChart(chart({ regularMarketPrice: undefined }), 'AAPL', NOW).ok, false);
});

test('provider: HTTP 404 with a Yahoo error body uses Yahoo\'s reason; 429 and network failures give friendly reasons', async () => {
  const mk = (res) => createYahooProvider({ fetchImpl: async () => res(), now: () => NOW });
  const nf = await mk(() => ({ ok: false, status: 404, json: async () => ({ chart: { result: null, error: { code: 'Not Found', description: 'delisted' } } }) })).fetchQuote('ZZZZ');
  assert.match(nf.reason, /delisted/);
  const rl = await mk(() => ({ ok: false, status: 429, json: async () => ({}) })).fetchQuote('AAPL');
  assert.match(rl.reason, /rate-limiting/);
  const net = await createYahooProvider({ fetchImpl: async () => { throw new Error('boom'); } }).fetchQuote('AAPL');
  assert.match(net.reason, /Could not reach Yahoo/);
});

test('provider requests the right URL (BRK.B → BRK-B)', async () => {
  let url;
  const p = createYahooProvider({ fetchImpl: async (u) => { url = u; return { ok: true, status: 200, json: async () => chart({ symbol: 'BRK-B' }) }; }, now: () => NOW });
  assert.equal((await p.fetchQuote('BRK.B')).ok, true);
  assert.match(url, /chart\/BRK-B\?/);
});

test('service: de-duplicates symbols, caches, and a second call inside the TTL does not hit the provider', async () => {
  let calls = 0; let t = NOW;
  const provider = { name: 'fake', fetchQuote: async (s) => { calls++; return { symbol: s, ok: true, price: 10, session: 'regular', asOf: new Date(t).toISOString(), source: 'fake' }; } };
  const svc = createQuoteService({ provider, now: () => t });
  await svc.getQuotes(['AAPL', 'aapl', 'MSFT']);
  assert.equal(calls, 2);
  await svc.getQuotes(['AAPL']);
  assert.equal(calls, 2);
  t += 31_000; // regular-session TTL is 30s
  await svc.getQuotes(['AAPL']);
  assert.equal(calls, 3);
});

test('service: live failure falls back to the durable last-known price, clearly labelled stale with ITS timestamp', async () => {
  const provider = { name: 'fake', fetchQuote: async (s) => ({ symbol: s, ok: false, reason: 'Could not reach Yahoo Finance for AAPL.' }) };
  const svc = createQuoteService({ provider, lastKnown: async () => ({ price: 205, asOf: '2026-09-03T20:00:00.000Z' }) });
  const q = (await svc.getQuotes(['AAPL'])).get('AAPL');
  assert.deepEqual([q.ok, q.price, q.stale, q.asOf], [true, 205, true, '2026-09-03T20:00:00.000Z']);
  assert.match(q.staleReason, /Live price unavailable/);
});

test('service: live failure and nothing stored → unavailable (never a made-up price)', async () => {
  const provider = { name: 'fake', fetchQuote: async (s) => ({ symbol: s, ok: false, reason: 'nope' }) };
  const q = (await createQuoteService({ provider, lastKnown: async () => null }).getQuotes(['AAPL'])).get('AAPL');
  assert.equal(q.ok, false);
});

test('service: a failing cache write never breaks the price', async () => {
  const provider = { name: 'fake', fetchQuote: async (s) => ({ symbol: s, ok: true, price: 1, session: 'closed', asOf: new Date(NOW).toISOString() }) };
  const q = (await createQuoteService({ provider, now: () => NOW, persist: async () => { throw new Error('db down'); } }).getQuotes(['A'])).get('A');
  assert.equal(q.ok, true);
});

test('provider is swappable: the service works with any object that has fetchQuote', async () => {
  const other = { name: 'alt', fetchQuote: async (s) => ({ symbol: s, ok: true, price: 99, source: 'alt', session: 'closed', asOf: new Date(NOW).toISOString() }) };
  assert.equal((await createQuoteService({ provider: other }).getQuotes(['X'])).get('X').source, 'alt');
});
