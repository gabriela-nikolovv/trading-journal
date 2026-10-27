import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCurrentR } from '../src/currentR.js';

describe('spec section 51 — critical Current R test', () => {
  test('LONG, entry 100, stop 95, current 110 -> +2.0R', () => {
    const r = computeCurrentR({ direction: 'long', entry: 100, stop: 95, current: 110 });
    assert.equal(r.status, 'ok');
    assert.equal(r.value, 2.0);
  });

  test('LONG, entry 100, stop 95, current 97 -> -0.6R', () => {
    const r = computeCurrentR({ direction: 'long', entry: 100, stop: 95, current: 97 });
    assert.equal(r.status, 'ok');
    assert.equal(r.value, -0.6);
  });

  test('SHORT, entry 100, stop 105, current 90 -> +2.0R', () => {
    const r = computeCurrentR({ direction: 'short', entry: 100, stop: 105, current: 90 });
    assert.equal(r.status, 'ok');
    assert.equal(r.value, 2.0);
  });

  test('SHORT, entry 100, stop 105, current 103 -> -0.6R', () => {
    const r = computeCurrentR({ direction: 'short', entry: 100, stop: 105, current: 103 });
    assert.equal(r.status, 'ok');
    assert.equal(r.value, -0.6);
  });
});

describe('missing / invalid stop loss (spec sections 11, 14, 38)', () => {
  test('no stop set -> STOP NOT SET, never a fabricated value', () => {
    const r = computeCurrentR({ direction: 'long', entry: 100, stop: null, current: 110 });
    assert.equal(r.status, 'not_set');
  });

  test('LONG with stop above entry is invalid, not silently computed', () => {
    const r = computeCurrentR({ direction: 'long', entry: 100, stop: 105, current: 110 });
    assert.equal(r.status, 'invalid');
  });

  test('SHORT with stop below entry is invalid, not silently computed', () => {
    const r = computeCurrentR({ direction: 'short', entry: 100, stop: 95, current: 90 });
    assert.equal(r.status, 'invalid');
  });
});
