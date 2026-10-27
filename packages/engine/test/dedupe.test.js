import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIncomingRecord, fillFingerprint } from '../src/dedupe.js';

describe('duplicate prevention and replaced-record detection', () => {
  const baseFill = {
    accountId: 'acct-1',
    symbol: 'AAPL',
    datetimeIso: '2026-01-05T09:30:00Z',
    side: 'B',
    quantity: 100,
    price: 10,
    orderId: 'ORD-1',
  };

  test('same PropReports Id already stored -> no_op', () => {
    const fp = fillFingerprint(baseFill);
    const existing = { id: 'row-1', propreportsId: 'PR-100', fingerprint: fp };
    const result = classifyIncomingRecord({
      incomingPropReportsId: 'PR-100',
      incomingFingerprint: fp,
      existingByPropReportsId: new Map([['PR-100', existing]]),
      existingByFingerprint: new Map([[fp, existing]]),
    });
    assert.equal(result.action, 'no_op');
  });

  test('same trade data, a new PropReports Id -> replace, not a duplicate insert', () => {
    const fp = fillFingerprint(baseFill);
    const existing = { id: 'row-1', propreportsId: 'PR-100', fingerprint: fp };
    const result = classifyIncomingRecord({
      incomingPropReportsId: 'PR-200', // corrected record from PropReports
      incomingFingerprint: fp,
      existingByPropReportsId: new Map([['PR-100', existing]]), // not found by the NEW id
      existingByFingerprint: new Map([[fp, existing]]),
    });
    assert.equal(result.action, 'replace');
    assert.equal(result.existing.id, 'row-1');
  });

  test('genuinely new fill -> insert_new', () => {
    const fp = fillFingerprint(baseFill);
    const result = classifyIncomingRecord({
      incomingPropReportsId: 'PR-999',
      incomingFingerprint: fp,
      existingByPropReportsId: new Map(),
      existingByFingerprint: new Map(),
    });
    assert.equal(result.action, 'insert_new');
  });

  test('no PropReports Id available at all -> falls back to fingerprint matching', () => {
    const fp = fillFingerprint(baseFill);
    const existing = { id: 'row-1', propreportsId: null, fingerprint: fp };
    const dup = classifyIncomingRecord({
      incomingPropReportsId: null,
      incomingFingerprint: fp,
      existingByPropReportsId: new Map(),
      existingByFingerprint: new Map([[fp, existing]]),
    });
    assert.equal(dup.action, 'no_op');

    const fresh = classifyIncomingRecord({
      incomingPropReportsId: null,
      incomingFingerprint: 'a-different-fingerprint',
      existingByPropReportsId: new Map(),
      existingByFingerprint: new Map([[fp, existing]]),
    });
    assert.equal(fresh.action, 'insert_new');
  });
});
