import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichPosition, summarizePortfolio } from '../src/positionAnalytics.js';

const Q = (price, extra = {}) => ({ symbol: 'X', ok: true, price, asOf: '2026-09-04T20:00:00Z', session: 'closed', source: 'yahoo', ...extra });
const LONG = { symbol: 'AAPL', direction: 'long', openQuantity: 100, avgEntryPrice: 100, stopLoss: 95 };

test('value, unrealized P&L, % and Current R for a long (spec 13/14: +2.0R)', () => {
  const p = enrichPosition(LONG, Q(110));
  assert.equal(p.marketValue, 11000);
  assert.equal(p.unrealizedPnl, 1000);
  assert.equal(p.pnlPct, 10);
  assert.deepEqual(p.currentR, { status: 'ok', value: 2 });
  assert.equal(p.riskToStop, 500);
  assert.equal(p.potentialLossToStop, 1500); // from $110 down to the $95 stop on 100 shares
});

test('long below entry: -0.6R and negative P&L', () => {
  const p = enrichPosition(LONG, Q(97));
  assert.deepEqual(p.currentR, { status: 'ok', value: -0.6 });
  assert.equal(p.unrealizedPnl, -300);
});

test('short: P&L and R signs flip correctly (+2.0R at 90 with stop 105)', () => {
  const s = { symbol: 'XYZ', direction: 'short', openQuantity: 10, avgEntryPrice: 100, stopLoss: 105 };
  const p = enrichPosition(s, Q(90));
  assert.equal(p.unrealizedPnl, 100);
  assert.deepEqual(p.currentR, { status: 'ok', value: 2 });
  assert.equal(p.marketValue, 900);
  assert.equal(p.potentialLossToStop, 150);
  assert.deepEqual(enrichPosition(s, Q(103)).currentR, { status: 'ok', value: -0.6 });
});

test('missing stop → STOP NOT SET: no R, no risk, but value and P&L still shown', () => {
  const p = enrichPosition({ ...LONG, stopLoss: null }, Q(110));
  assert.equal(p.currentR.status, 'not_set');
  assert.equal(p.riskStatus, 'not_set');
  assert.equal(p.riskToStop, null);
  assert.equal(p.unrealizedPnl, 1000);
});

test('invalid stop (long with stop above entry) → validation warning, no fake number', () => {
  const p = enrichPosition({ ...LONG, stopLoss: 105 }, Q(110));
  assert.equal(p.currentR.status, 'invalid');
  assert.match(p.riskReason, /below Entry/);
  assert.equal(p.riskToStop, null);
});

test('no price → value / P&L / R are null with a reason, never zero', () => {
  const p = enrichPosition(LONG, { symbol: 'AAPL', ok: false, reason: 'Unable to retrieve current price for AAPL.' });
  assert.equal(p.priceStatus, 'unavailable');
  assert.equal(p.marketValue, null);
  assert.equal(p.unrealizedPnl, null);
  assert.equal(p.currentR.status, 'unavailable');
  assert.equal(p.riskToStop, 500); // risk to stop needs no price
});

test('stale price is used but labelled stale', () => {
  const p = enrichPosition(LONG, Q(110, { stale: true, staleReason: 'last known' }));
  assert.equal(p.priceStatus, 'stale');
  assert.equal(p.priceReason, 'last known');
});

test('multiplier is applied to value, P&L and risk', () => {
  const p = enrichPosition({ ...LONG, multiplier: 50, openQuantity: 2 }, Q(110));
  assert.equal(p.marketValue, 11000); // 2 × 110 × 50
  assert.equal(p.unrealizedPnl, 1000); // 2 × 10 × 50
  assert.equal(p.riskToStop, 500);     // 2 × 5 × 50
});

test('portfolio: long/short/total/net exposure, grouping by sector & industry, risk, missing-stop list', () => {
  const a = enrichPosition({ ...LONG, sectorName: 'Electronic Technology', industryName: 'Telecommunications Equipment' }, Q(110));
  const b = enrichPosition({ symbol: 'MRNA', direction: 'short', openQuantity: 10, avgEntryPrice: 100, stopLoss: 105, sectorName: 'Health Technology', industryName: 'Biotechnology' }, Q(90));
  const c = enrichPosition({ symbol: 'NOSTOP', direction: 'long', openQuantity: 10, avgEntryPrice: 10, stopLoss: null }, Q(10));
  const s = summarizePortfolio([a, b, c], { accountValue: 100000 });
  assert.equal(s.longExposure, 11100);
  assert.equal(s.shortExposure, 900);
  assert.equal(s.totalExposure, 12000);
  assert.equal(s.netExposure, 10200);
  assert.equal(s.bySector[0].name, 'Electronic Technology');
  assert.equal(s.bySector.find((x) => x.name === 'Unclassified').exposure, 100);
  assert.equal(s.totalRiskToStops, 550);              // 500 + 50; NOSTOP excluded
  assert.deepEqual(s.positionsMissingStop, ['NOSTOP']);
  assert.equal(s.riskPctOfAccount, 0.55);
  assert.equal(s.unrealizedPnl, 1100);
});

test('negative account value (valid on a prop account) → no risk percentage, not a nonsense number', () => {
  const s = summarizePortfolio([enrichPosition(LONG, Q(110))], { accountValue: -646.46 });
  assert.equal(s.riskPctOfAccount, null);
});

test('unpriced positions are excluded from exposure and counted so the UI can say so', () => {
  const s = summarizePortfolio([enrichPosition(LONG, undefined), enrichPosition(LONG, Q(110))]);
  assert.equal(s.unpricedPositions, 1);
  assert.equal(s.totalExposure, 11000);
});
