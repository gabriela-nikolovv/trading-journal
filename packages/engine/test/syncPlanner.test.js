import test from 'node:test';
import assert from 'node:assert/strict';
import { planWindows, addDays } from '../src/syncPlanner.js';

test('full history: from first traded date to today in ≤31-day windows with no gaps or overlaps', () => {
  const w = planWindows({ today: '2026-10-15', isFullHistory: true, firstTradedDate: '2026-08-01' });
  assert.equal(w[0].startDate, '2026-08-01');
  assert.equal(w.at(-1).endDate, '2026-10-15');
  for (let i = 1; i < w.length; i++) assert.equal(w[i].startDate, addDays(w[i - 1].endDate, 1));
  assert.ok(w.every((x) => (Date.parse(x.endDate) - Date.parse(x.startDate)) / 86400000 <= 30));
});
test('incremental: starts at cursor minus lookback so replaced records are re-checked', () => {
  const w = planWindows({ today: '2026-10-15', isFullHistory: false, cursorDate: '2026-10-14' });
  assert.deepEqual(w, [{ startDate: '2026-10-07', endDate: '2026-10-15' }]);
});
test('account with no First Traded date still checks the most recent window', () => {
  const w = planWindows({ today: '2026-10-15', isFullHistory: true, firstTradedDate: null });
  assert.equal(w.at(-1).endDate, '2026-10-15');
});
