import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructPositions, reconstructAllPositions, computeUnrealizedPnl } from '../src/positionEngine.js';

/** Quick fill builder for tests. */
function f(id, side, quantity, price, iso, totalFee = 0, extra = {}) {
  return {
    id,
    symbol: extra.symbol ?? 'AAPL',
    datetime: new Date(iso),
    side,
    quantity,
    price,
    totalFee,
    multiplier: extra.multiplier ?? 1,
    currency: extra.currency ?? 'USD',
  };
}

describe('position reconstruction — spec section 9 worked examples', () => {
  test('BUY 100, BUY 50, SELL 50 -> OPEN LONG 100', () => {
    const fills = [
      f('1', 'B', 100, 10, '2026-01-05T09:30:00Z'),
      f('2', 'B', 50, 10, '2026-01-05T10:00:00Z'),
      f('3', 'S', 50, 10, '2026-01-05T11:00:00Z'),
    ];
    const [instance] = reconstructPositions(fills);
    assert.equal(instance.status, 'open');
    assert.equal(instance.direction, 'long');
    assert.equal(instance.openQuantity, 100);
  });

  test('BUY 100, SELL 100 -> POSITION CLOSED', () => {
    const fills = [
      f('1', 'B', 100, 10, '2026-01-05T09:30:00Z'),
      f('2', 'S', 100, 12, '2026-01-05T15:00:00Z'),
    ];
    const [instance] = reconstructPositions(fills);
    assert.equal(instance.status, 'closed');
    assert.equal(instance.openQuantity, 0);
    assert.equal(instance.realizedPnl, 200); // (12-10)*100
    assert.ok(instance.closedAt);
  });

  test('SELL 100, BUY 40 -> OPEN SHORT 60', () => {
    const fills = [
      f('1', 'S', 100, 50, '2026-01-05T09:30:00Z'),
      f('2', 'B', 40, 48, '2026-01-05T09:45:00Z'),
    ];
    const [instance] = reconstructPositions(fills);
    assert.equal(instance.status, 'open');
    assert.equal(instance.direction, 'short');
    assert.equal(instance.openQuantity, 60);
    assert.equal(instance.avgEntryPrice, 50);
    // Covered 40 shares at 48 vs a 50 entry on a short => profit of (50-48)*40 = 80
    assert.equal(instance.realizedPnl, 80);
  });

  test('opening short works identically whether tagged S (sell short) or T (short)', () => {
    const viaS = reconstructPositions([f('1', 'S', 100, 50, '2026-01-05T09:30:00Z')]);
    const viaT = reconstructPositions([f('1', 'T', 100, 50, '2026-01-05T09:30:00Z')]);
    assert.equal(viaS[0].direction, 'short');
    assert.equal(viaT[0].direction, 'short');
    assert.equal(viaS[0].openQuantity, viaT[0].openQuantity);
  });
});

describe('weighted average entry price', () => {
  test('three additions at different prices blend correctly (long)', () => {
    const fills = [
      f('1', 'B', 100, 10, '2026-01-05T09:30:00Z'),
      f('2', 'B', 50, 12, '2026-01-05T10:00:00Z'),
      f('3', 'B', 50, 14, '2026-01-05T11:00:00Z'),
    ];
    const [instance] = reconstructPositions(fills);
    // (100*10 + 50*12 + 50*14) / 200 = (1000+600+700)/200 = 2300/200 = 11.5
    assert.equal(instance.avgEntryPrice, 11.5);
    assert.equal(instance.quantityTraded, 200);
    assert.equal(instance.originalQuantity, 100);
  });

  test('a partial close does NOT change the average entry price of shares left open', () => {
    const fills = [
      f('1', 'B', 100, 10, '2026-01-05T09:30:00Z'),
      f('2', 'B', 50, 12, '2026-01-05T10:00:00Z'),   // avg becomes 10.666667
      f('3', 'S', 50, 13, '2026-01-05T11:00:00Z'),   // partial close, avg stays put
    ];
    const [instance] = reconstructPositions(fills);
    assert.equal(instance.status, 'open');
    assert.equal(instance.openQuantity, 100);
    assert.equal(instance.avgEntryPrice, 10.666667);
    // Realized on the 50 closed: (13 - 10.666667) * 50 = 116.66665 -> engine rounds to 6dp internally
    assert.ok(Math.abs(instance.realizedPnl - 116.6667) < 0.001);
    assert.equal(instance.avgExitPrice, 13);
    assert.equal(instance.closedQuantity, 50);
  });
});

describe('reversals', () => {
  test('BUY 100 @10, then SELL 150 @12 closes the long AND opens a new 50-share short', () => {
    const fills = [
      f('1', 'B', 100, 10, '2026-01-05T09:30:00Z', 2),
      f('2', 'S', 150, 12, '2026-01-05T15:00:00Z', 15),
    ];
    const instances = reconstructPositions(fills);
    assert.equal(instances.length, 2);

    const [closedLong, openShort] = instances;
    assert.equal(closedLong.direction, 'long');
    assert.equal(closedLong.status, 'closed');
    assert.equal(closedLong.openQuantity, 0);
    assert.equal(closedLong.realizedPnl, 200); // (12-10)*100
    // Fee on fill #2 (15) is prorated 100/150 to the closing leg, 50/150 to the new opening leg.
    assert.equal(closedLong.feesAllocated, 2 + 10); // fill1 fee (2) + prorated close fee (10)

    assert.equal(openShort.direction, 'short');
    assert.equal(openShort.status, 'open');
    assert.equal(openShort.openQuantity, 50);
    assert.equal(openShort.avgEntryPrice, 12);
    assert.equal(openShort.feesAllocated, 5); // remaining prorated fee
    // Note: stop loss / sector / notes are DB-layer, user-controlled fields —
    // the engine never sets them, so a brand-new instance naturally starts
    // with none set. The DB layer must not copy them over from the old
    // instance either (see position_instances migration comments).
  });

  test('a full close followed by a fresh position is two separate instances, not a reversal', () => {
    const fills = [
      f('1', 'B', 100, 10, '2026-01-01T09:30:00Z'), // Day 1: open
      f('2', 'S', 100, 11, '2026-01-03T09:30:00Z'), // Day 3: close
      f('3', 'B', 50, 9, '2026-01-04T09:30:00Z'),   // Day 4: brand new position
    ];
    const instances = reconstructPositions(fills);
    assert.equal(instances.length, 2);
    assert.equal(instances[0].status, 'closed');
    assert.equal(instances[1].status, 'open');
    assert.equal(instances[1].openQuantity, 50);
    assert.equal(instances[1].avgEntryPrice, 9);
  });
});

describe('multi-symbol grouping', () => {
  test('reconstructAllPositions keeps symbols fully independent', () => {
    const fills = [
      f('1', 'B', 100, 10, '2026-01-05T09:30:00Z', 0, { symbol: 'AAPL' }),
      f('2', 'B', 10, 300, '2026-01-05T09:31:00Z', 0, { symbol: 'MSFT' }),
      f('3', 'S', 100, 11, '2026-01-05T10:00:00Z', 0, { symbol: 'AAPL' }),
    ];
    const bySymbol = reconstructAllPositions(fills);
    assert.equal(bySymbol.AAPL.length, 1);
    assert.equal(bySymbol.AAPL[0].status, 'closed');
    assert.equal(bySymbol.MSFT.length, 1);
    assert.equal(bySymbol.MSFT[0].status, 'open');
  });
});

describe('unrealized P&L (live valuation, price-agnostic from the ledger)', () => {
  test('long position gains value when price rises above entry', () => {
    const pnl = computeUnrealizedPnl({ direction: 'long', avgEntryPrice: 100, openQuantity: 10, currentPrice: 110 });
    assert.equal(pnl, 100); // (110-100)*10
  });

  test('short position gains value when price falls below entry', () => {
    const pnl = computeUnrealizedPnl({ direction: 'short', avgEntryPrice: 100, openQuantity: 10, currentPrice: 90 });
    assert.equal(pnl, 100); // (90-100)*10*-1
  });
});
