// The words used for the three P&L types, in one place. Change the text between the quotes to rename
// them everywhere on the site (the order of the list is the order they appear in menus).
// The internal keys (schema1 / schema3 / schema2) must stay as they are.

export const PNL_TYPES = [
  ['schema1', 'Total'],
  ['schema3', 'Pure trading'],
  ['schema2', 'After Share'],
];

// Shown only in Settings → "P&L types".
export const PNL_EXPLAIN = {
  schema1: 'PropReports’ Total Δ: the trading result minus every fee (trade fees, market data, platform and other monthly fees), each fee counted once. This is what your account value moves by.',
  schema3: 'The trading result only — realized P&L plus the change in unrealized P&L — before any fee and before the profit share. How the trades themselves performed.',
  schema2: 'Total after the prop firm’s profit share. The share is taken once a month, on the last day, and only when the month is positive, so it is shown by month and by year only. Per-trade statistics use Total when After Share is selected.',
};

export const PNL_NAME = Object.fromEntries(PNL_TYPES);
