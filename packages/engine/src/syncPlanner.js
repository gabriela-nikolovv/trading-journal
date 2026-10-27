// Decides WHICH date windows a sync should request.
//
// - Full history: from the account's first traded date to today, in
//   month-sized windows (the docs ask integrators to keep ranges short for
//   busy accounts).
// - Incremental: from (cursor − lookback) to today. The lookback overlap is
//   what lets us notice corrected / replaced / removed records, which
//   PropReports re-imports under a new PropReports Id.
//
// All dates are plain YYYY-MM-DD strings handled in UTC so a user's local
// timezone can never shift a day boundary (spec section 43).

const DAY = 86400000;

/** @param {string} ymd */
export function parseYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`Invalid date: ${ymd}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
/** @param {number} ms */
export function toYmd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(ymd, n) {
  return toYmd(parseYmd(ymd) + n * DAY);
}

/**
 * @param {Object} o
 * @param {string} o.today                 YYYY-MM-DD
 * @param {boolean} o.isFullHistory
 * @param {string|null} [o.firstTradedDate] from the accounts action
 * @param {string|null} [o.cursorDate]      last fully-synced date
 * @param {number} [o.lookbackDays]         incremental overlap (default 7)
 * @param {number} [o.windowDays]           max window size (default 31)
 * @returns {{startDate:string,endDate:string}[]}
 */
export function planWindows({ today, isFullHistory, firstTradedDate = null, cursorDate = null, lookbackDays = 7, windowDays = 31 }) {
  let start;
  if (isFullHistory || !cursorDate) {
    // No first-traded date (blank for accounts with no activity) → nothing to fetch yet,
    // except we still look at the last 31 days so a brand-new account's first fills are caught.
    start = firstTradedDate || addDays(today, -windowDays);
  } else {
    start = addDays(cursorDate, -lookbackDays);
  }
  if (parseYmd(start) > parseYmd(today)) start = today;

  const windows = [];
  let cursor = start;
  while (parseYmd(cursor) <= parseYmd(today)) {
    const end = toYmd(Math.min(parseYmd(cursor) + (windowDays - 1) * DAY, parseYmd(today)));
    windows.push({ startDate: cursor, endDate: end });
    cursor = addDays(end, 1);
  }
  return windows;
}
