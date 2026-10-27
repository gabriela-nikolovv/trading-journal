import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toNumber } from '../src/csv.js';
import { normalizeFillRow, normalizeAdjustmentRow, classifyAdjustmentCategory } from '../src/normalize.js';

describe('CSV parsing maps by header name, not column position (spec section 5)', () => {
  test('parses a fills CSV with columns in a non-obvious order', () => {
    const csv =
      'Order Id,Date/Time,Symbol,Buy/Sell,Quantity,Price,Comm,Ecn Fee,SEC,TAF,NSCC,Clr,Misc,Trade Date,PropReports Id\n' +
      'ORD-1,2026-08-31T09:30:00Z,AAPL,B,100,150.25,1.00,0.20,0.05,0.01,0.009,0.02,0.029,2026-08-31,PR-1001\n';
    const rows = parseCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['Symbol'], 'AAPL');
    assert.equal(rows[0]['Order Id'], 'ORD-1');

    const fill = normalizeFillRow(rows[0], 'acct-1');
    assert.equal(fill.symbol, 'AAPL');
    assert.equal(fill.side, 'B');
    assert.equal(fill.quantity, 100);
    assert.equal(fill.propreportsId, 'PR-1001');
    assert.ok(Math.abs(fill.totalFee - (1 + 0.2 + 0.05 + 0.01 + 0.009 + 0.02 + 0.029)) < 1e-9);
  });

  test('missing optional columns (e.g. no PropReports Id) do not throw', () => {
    const csv = 'Date/Time,Symbol,Buy/Sell,Quantity,Price,Trade Date\n2026-08-31T09:30:00Z,AAPL,S,50,151.00,2026-08-31\n';
    const rows = parseCsv(csv);
    const fill = normalizeFillRow(rows[0], 'acct-1');
    assert.equal(fill.propreportsId, null);
    assert.equal(fill.totalFee, 0);
  });

  test('parenthesized negatives, as seen in report displays, parse as negative numbers', () => {
    assert.equal(toNumber('(4.38)'), -4.38);
    assert.equal(toNumber('46.42'), 46.42);
    assert.equal(toNumber(''), 0);
    assert.equal(toNumber('1,234.56'), 1234.56);
  });
});

describe('adjustment category classification — spec section 35 (Platform fee recognition)', () => {
  const knownCategories = new Map([
    ['Market Data', 'fee'],
    ['Platform', 'fee'],
    ['Wire Transfer', 'transfer'],
  ]);

  test('a known "Platform" category is recognized as a fee (the previous bug)', () => {
    const result = classifyAdjustmentCategory('Platform', knownCategories);
    assert.equal(result.type, 'fee');
    assert.equal(result.isKnown, true);
  });

  test('a known "Market Data" category is recognized as a fee', () => {
    const result = classifyAdjustmentCategory('Market Data', knownCategories);
    assert.equal(result.type, 'fee');
  });

  test('a known transfer category is excluded from P&L classification as "fee"', () => {
    const result = classifyAdjustmentCategory('Wire Transfer', knownCategories);
    assert.equal(result.type, 'transfer');
  });

  test('an unrecognized category is flagged isKnown:false rather than silently trusted', () => {
    const result = classifyAdjustmentCategory('Mystery Charge', knownCategories);
    assert.equal(result.isKnown, false); // must surface a reconciliation warning, not guess silently
    assert.equal(classifyAdjustmentCategory('Multisport', knownCategories).isKnown, true); // fee pattern recognised without setup
  });

  test('normalizeAdjustmentRow reads Category/Amount by header name', () => {
    const rows = parseCsv('Date,Category,Amount,Description\n2026-09-01,Platform,-25.50,Monthly platform fee\n');
    const adj = normalizeAdjustmentRow(rows[0], 'acct-1');
    assert.equal(adj.categoryName, 'Platform');
    assert.equal(adj.amount, -25.5);
  });
});
