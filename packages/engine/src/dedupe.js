// Duplicate prevention + replaced-record detection (spec section 34).
//
// PropReports Id is the strong identifier. Per the API docs, a corrected
// record reappears with the SAME underlying trade data but a DIFFERENT
// PropReports Id — so a fingerprint match with a changed PropReports Id is
// a replacement, not a duplicate. When PropReports Id is unavailable, we
// fall back to a natural-key fingerprint alone.

/**
 * Build a natural-key fingerprint for a fill (order matters for stability).
 * @param {{accountId:string|number, symbol:string, datetimeIso:string, side:string, quantity:number, price:number, orderId?:string}} f
 */
export function fillFingerprint(f) {
  return [f.accountId, f.symbol, f.datetimeIso, f.side, f.quantity, f.price, f.orderId ?? ''].join('|');
}

/**
 * Build a natural-key fingerprint for an adjustment.
 * @param {{accountId:string|number, date:string, categoryName:string, amount:number}} a
 */
export function adjustmentFingerprint(a) {
  return [a.accountId, a.date, a.categoryName, a.amount].join('|');
}

/**
 * @typedef {Object} ExistingRecord
 * @property {string} id                 Our internal row id.
 * @property {string|null} propreportsId
 * @property {string} fingerprint
 *
 * @param {Object} args
 * @param {string|null} args.incomingPropReportsId
 * @param {string} args.incomingFingerprint
 * @param {Map<string, ExistingRecord>} args.existingByPropReportsId  keyed by propreportsId
 * @param {Map<string, ExistingRecord>} args.existingByFingerprint    keyed by fingerprint
 * @returns {{action:'no_op'|'insert_new'|'replace', existing?:ExistingRecord}}
 */
export function classifyIncomingRecord({
  incomingPropReportsId,
  incomingFingerprint,
  existingByPropReportsId,
  existingByFingerprint,
}) {
  if (incomingPropReportsId) {
    const byId = existingByPropReportsId.get(incomingPropReportsId);
    if (byId) {
      return { action: 'no_op', existing: byId };
    }
    const byFingerprint = existingByFingerprint.get(incomingFingerprint);
    if (byFingerprint && byFingerprint.propreportsId && byFingerprint.propreportsId !== incomingPropReportsId) {
      // Same trade data, a new PropReports Id => the old record was corrected/replaced.
      return { action: 'replace', existing: byFingerprint };
    }
    return { action: 'insert_new' };
  }

  // No PropReports Id available at all — fall back to the fingerprint alone.
  const byFingerprint = existingByFingerprint.get(incomingFingerprint);
  if (byFingerprint) {
    return { action: 'no_op', existing: byFingerprint };
  }
  return { action: 'insert_new' };
}
