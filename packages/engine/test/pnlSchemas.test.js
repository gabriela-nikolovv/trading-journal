import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSchema1Delta,
  computeSchema3Delta,
  applyMonthlyProfitShare,
  computeSchema2ForMonths,
  resolvePctForMonth,
} from '../src/pnlSchemas.js';

describe('spec section 50 — critical P&L test', () => {
  const components = {
    tradingResult: 1000,
    commissions: 0,
    marketDataFees: 50,
    platformFees: 50,
    otherFees: 100,
  };

  test('Schema 3 (pure trading) = $1000', () => {
    assert.equal(computeSchema3Delta(components), 1000);
  });

  test('Schema 1 (report total) = $800', () => {
    assert.equal(computeSchema1Delta(components), 800);
  });

  test('Schema 2 (after 50% profit share on the qualifying $800) = $400', () => {
    const result = applyMonthlyProfitShare(computeSchema1Delta(components), 50);
    assert.equal(result.qualifies, true);
    assert.equal(result.propFirmShare, 400);
    assert.equal(result.userShare, 400);
  });
});

describe('spec section 49 — profit share must not be deducted repeatedly', () => {
  test('a $1000 qualifying month splits 500/500 exactly once, not compounded', () => {
    const result = applyMonthlyProfitShare(1000, 50);
    assert.equal(result.propFirmShare, 500);
    assert.equal(result.userShare, 500);

    // Re-running the SAME month must be idempotent — never re-applied to the remainder.
    const again = applyMonthlyProfitShare(1000, 50);
    assert.deepEqual(result, again);
  });

  test('independent months each use their own total — no cross-month compounding', () => {
    const monthly = computeSchema2ForMonths(
      [
        { monthKey: '2026-01-01', schema1Total: 1000 },
        { monthKey: '2026-02-01', schema1Total: 1000 },
      ],
      () => 50
    );
    assert.equal(monthly[0].userShare, 500);
    assert.equal(monthly[1].userShare, 500); // NOT 250 — February is not applied against January's remainder
  });

  test('a losing or flat month takes no profit share', () => {
    const losing = applyMonthlyProfitShare(-300, 50);
    assert.equal(losing.qualifies, false);
    assert.equal(losing.propFirmShare, 0);
    assert.equal(losing.userShare, -300);

    const flat = applyMonthlyProfitShare(0, 50);
    assert.equal(flat.qualifies, false);
    assert.equal(flat.userShare, 0);
  });
});

describe('profit share percentage is configurable and historically versioned', () => {
  test('resolvePctForMonth picks the % effective at or before the given month', () => {
    const schedule = [
      { pct: 50, effectiveFrom: '2026-01-01' },
      { pct: 40, effectiveFrom: '2026-06-01' },
    ];
    assert.equal(resolvePctForMonth(schedule, '2026-03-01'), 50);
    assert.equal(resolvePctForMonth(schedule, '2026-06-01'), 40);
    assert.equal(resolvePctForMonth(schedule, '2026-12-01'), 40);
  });

  test('a later percentage change never rewrites an already-computed past month', () => {
    const schedule = [{ pct: 50, effectiveFrom: '2026-01-01' }];
    const januaryPct = resolvePctForMonth(schedule, '2026-01-01');
    schedule.push({ pct: 40, effectiveFrom: '2026-06-01' }); // pct changes going forward
    // Recomputing January still resolves to the % that was effective in January.
    assert.equal(resolvePctForMonth(schedule, '2026-01-01'), januaryPct);
  });

  test('throws rather than silently guessing when no schedule entry applies yet', () => {
    assert.throws(() => resolvePctForMonth([{ pct: 50, effectiveFrom: '2026-06-01' }], '2026-01-01'));
  });
});
