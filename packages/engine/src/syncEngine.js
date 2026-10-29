// Sync orchestrator: PropReports → (normalize, dedupe, detect replacements) →
// one atomic commit → positions rebuilt from the full active fill history.
//
// SAFETY MODEL (spec section 6): nothing is written until every window of
// every action has been fetched and validated. The write is a single
// `store.commit(batch)` call (a database transaction in the Supabase
// adapter). If anything fails first, the journal still shows the last good
// state and only the sync status/error is updated.
//
// The engine knows nothing about Supabase or HTTP — `client` and `store`
// are injected, which is what makes it testable end to end without a network.

import { normalizeFillRow, normalizeAdjustmentRow, classifyAdjustmentCategory } from './normalize.js';
import { fillFingerprint, adjustmentFingerprint, classifyIncomingRecord } from './dedupe.js';
import { reconstructAllPositions } from './positionEngine.js';
import { planWindows, addDays } from './syncPlanner.js';
import { buildDailySnapshots } from './dailySnapshots.js';
import { redactToken } from './propreportsClient.js';

const REQUIRED_FILL_COLUMNS = ['Date/Time', 'Symbol', 'Price'];
const REQUIRED_ADJ_COLUMNS = ['Date', 'Amount'];
const REQUIRED_POS_COLUMNS = ['Date', 'Symbol', 'Realized', 'Unrealized Delta'];

/** Fail loudly if a CSV is missing columns we cannot work without (instead of silently reading zeros). */
function assertColumns(rows, required, label) {
  if (rows.length === 0) return;
  const have = Object.keys(rows[0]);
  const missing = required.filter((c) => !have.includes(c));
  const hasSide = label !== 'fills' || have.includes('B/S') || have.includes('Buy/Sell');
  const hasQty = label !== 'fills' || have.includes('Qty') || have.includes('Quantity');
  if (missing.length || !hasSide || !hasQty) {
    const e = new Error(
      `PropReports ${label} data is missing expected columns (${[...missing, ...(hasSide ? [] : ['B/S']), ...(hasQty ? [] : ['Qty'])].join(', ')}). Columns received: ${have.join(', ')}`
    );
    e.userMessage = `PropReports returned ${label} in a format the journal does not recognise. Your previous data is still available.`;
    throw e;
  }
}

/** Tag duplicates inside one batch so legitimately identical fills (no PropReports Id) are not collapsed. */
function withOccurrence(fingerprints) {
  const seen = new Map();
  return fingerprints.map((fp) => {
    const n = (seen.get(fp) ?? 0) + 1;
    seen.set(fp, n);
    return `${fp}#${n}`;
  });
}

/**
 * Compare incoming records with what is stored for the same window.
 * @template T
 * @param {Object} o
 * @param {Array<T & {propreportsId:string|null}>} o.incoming
 * @param {string[]} o.fingerprints    parallel to incoming
 * @param {Array<{id:string,propreportsId:string|null,fingerprint:string}>} o.existing  non-superseded rows in the fetched window
 */
function diffRecords({ incoming, fingerprints, existing }) {
  const byPrId = new Map(existing.filter((e) => e.propreportsId).map((e) => [e.propreportsId, e]));
  const byFp = new Map(existing.map((e) => [e.fingerprint, e]));
  const inserts = [];
  const replacements = [];
  const seenExistingIds = new Set();

  incoming.forEach((rec, i) => {
    const c = classifyIncomingRecord({
      incomingPropReportsId: rec.propreportsId,
      incomingFingerprint: fingerprints[i],
      existingByPropReportsId: byPrId,
      existingByFingerprint: byFp,
    });
    if (c.action === 'no_op') seenExistingIds.add(c.existing.id);
    else if (c.action === 'replace') {
      seenExistingIds.add(c.existing.id);
      replacements.push({ supersedeId: c.existing.id, record: rec, fingerprint: fingerprints[i] });
    } else inserts.push({ record: rec, fingerprint: fingerprints[i] });
  });

  // Stored rows inside the window that PropReports no longer returns at all.
  const removed = existing.filter((e) => !seenExistingIds.has(e.id));
  return { inserts, replacements, removed };
}

/**
 * @param {Object} deps
 * @param {ReturnType<import('./propreportsClient.js').createPropReportsClient>} deps.client
 * @param {Store} deps.store
 * @param {string} deps.today        YYYY-MM-DD (UTC trading date)
 * @param {string} [deps.token]      only used to redact error text
 * @param {boolean} [deps.forceFull]
 *
 * @typedef {Object} Store
 * @property {()=>Promise<{id:string, propreportsAccountId:number, firstTradedDate:string|null, fillsCursorDate:string|null, adjustmentsCursorDate:string|null}>} getAccount
 * @property {(info:{isFullHistory:boolean})=>Promise<string>} beginRun   returns run id; marks sync_state running
 * @property {(from:string,to:string)=>Promise<Array<{id:string,propreportsId:string|null,fingerprint:string}>>} getActiveFills
 * @property {(from:string,to:string)=>Promise<Array<{id:string,propreportsId:string|null,fingerprint:string}>>} getActiveAdjustments
 * @property {()=>Promise<Map<string,'fee'|'transfer'>>} getAdjustmentCategories
 * @property {(date:string)=>Promise<number>} getAccountValueBefore  account value at the end of the last snapshot day before `date` (0 if none)
 * @property {()=>Promise<Array<any>>} getAllActiveFills       normalized-fill shaped, for the position rebuild
 * @property {(batch:any)=>Promise<void>} commit               ONE transaction
 * @property {(runId:string,error:{message:string,detail?:string})=>Promise<void>} failRun
 */
export async function runSync({ client, store, today, token, forceFull = false, newId = () => globalThis.crypto.randomUUID() }) {
  const account = await store.getAccount();
  const isFullHistory = forceFull || !account.fillsCursorDate;
  const runId = await store.beginRun({ isFullHistory });

  try {
    // A brand-new database has no fills to infer the start date from, so ask
    // PropReports when this account first traded (accounts → "First Traded").
    let firstTradedDate = account.firstTradedDate;
    let creationDate = null;
    if (isFullHistory && client.listAccounts) {
      const row = (await client.listAccounts()).find((a) => String(a['Account Id']) === String(account.propreportsAccountId));
      if (!firstTradedDate) firstTradedDate = row?.['First Traded'] || null;
      const c = String(row?.['Creation Date'] ?? row?.['Created'] ?? '').slice(0, 10);
      creationDate = /^\d{4}-\d{2}-\d{2}$/.test(c) ? c : null;
    }
    const windows = planWindows({
      today,
      isFullHistory,
      firstTradedDate,
      cursorDate: account.fillsCursorDate,
    });
    const rangeStart = windows[0].startDate;
    const rangeEnd = windows[windows.length - 1].endDate;

    // ---- 1. FETCH everything first (no writes yet) ----------------------
    const fillRows = [];
    const adjRows = [];
    const posRows = [];
    // Charges can be posted before the first trade (sign-up / first-month fees). They still reduce the
    // balance PropReports reports, so on a full sync also read adjustments from the account's creation date.
    if (isFullHistory && creationDate && firstTradedDate && creationDate < firstTradedDate) {
      adjRows.push(...(await client.fetchAdjustments(account.propreportsAccountId, creationDate, addDays(firstTradedDate, -1))));
    }
    for (const w of windows) {
      fillRows.push(...(await client.fetchFills(account.propreportsAccountId, w.startDate, w.endDate)));
      adjRows.push(...(await client.fetchAdjustments(account.propreportsAccountId, w.startDate, w.endDate)));
      if (client.fetchPositions) posRows.push(...(await client.fetchPositions(account.propreportsAccountId, w.startDate, w.endDate)));
    }
    assertColumns(fillRows, REQUIRED_FILL_COLUMNS, 'fills');
    assertColumns(adjRows, REQUIRED_ADJ_COLUMNS, 'adjustments');
    assertColumns(posRows, REQUIRED_POS_COLUMNS, 'positions');

    const warnings = [];

    // ---- 2. NORMALIZE ----------------------------------------------------
    const fills = fillRows.map((r) => normalizeFillRow(r, account.id));
    const fillFps = withOccurrence(fills.map((f) => fillFingerprint({ ...f, accountId: account.id })));

    const categories = await store.getAdjustmentCategories();
    const warnedCategories = new Set();
    const adjustments = adjRows.map((r) => {
      const a = normalizeAdjustmentRow(r, account.id);
      const cls = classifyAdjustmentCategory(a.categoryName, categories);
      if (!cls.isKnown && !warnedCategories.has(a.categoryName)) {
        warnedCategories.add(a.categoryName);
        warnings.push({
          type: 'unknown_adjustment_category',
          message: `Adjustment category "${a.categoryName}" is not configured; treated as a ${cls.type}. Check Settings → Adjustment categories.`,
        });
      }
      return { ...a, categoryType: cls.type, categoryKnown: cls.isKnown };
    });
    const adjFps = withOccurrence(adjustments.map((a) => adjustmentFingerprint({ ...a, accountId: account.id })));

    // ---- 3. DIFF against stored rows in the same window -------------------
    const fillDiff = diffRecords({
      incoming: fills,
      fingerprints: fillFps,
      existing: await store.getActiveFills(rangeStart, rangeEnd),
    });
    const adjDiff = diffRecords({
      incoming: adjustments,
      fingerprints: adjFps,
      existing: await store.getActiveAdjustments(rangeStart, rangeEnd),
    });

    for (const r of fillDiff.replacements) {
      warnings.push({ type: 'fill_replaced', message: `A ${r.record.symbol} fill on ${r.record.tradeDate} was replaced upstream (new PropReports Id).` });
    }
    for (const r of fillDiff.removed) {
      warnings.push({ type: 'fill_removed_upstream', message: `A stored fill (${r.propreportsId ?? r.id}) is no longer returned by PropReports and was excluded.` });
    }

    // ---- 4. REBUILD positions from the full active history ----------------
    // Done in memory against (existing active fills − removed − superseded) + new,
    // so a failure here still leaves the database untouched.
    const goneIds = new Set([...fillDiff.removed.map((r) => r.id), ...fillDiff.replacements.map((r) => r.supersedeId)]);
    const existingActive = (await store.getAllActiveFills()).filter((f) => !goneIds.has(f.id));
    // New rows get their database id HERE so position→fill links can reference real ids.
    for (const x of [...fillDiff.inserts, ...fillDiff.replacements]) x.id = newId();
    const newFills = [...fillDiff.inserts, ...fillDiff.replacements].map((x) => ({
      ...x.record,
      id: x.id,
      datetime: new Date(x.record.datetimeIso.replace(' ', 'T') + 'Z'),
    }));
    const byAccount = reconstructAllPositions([...existingActive, ...newFills]);
    const instances = Object.values(byAccount).flat();

    // ---- 4b. DAILY SNAPSHOTS (calendar / dashboard / weekly report numbers) ----
    const fillCostsByDate = new Map();
    for (const f of fills) fillCostsByDate.set(f.tradeDate, (fillCostsByDate.get(f.tradeDate) ?? 0) + (f.totalFee ?? 0));
    const snap = buildDailySnapshots({
      positionRows: posRows,
      adjustments,
      startingAccountValue: await store.getAccountValueBefore(rangeStart),
      fillCostsByDate,
    });
    warnings.push(...snap.warnings);

    // Cross-check against PropReports' own current Cash + Unrealized (accounts action).
    let accountInfo = null;
    if (client.listAccounts) {
      const row = (await client.listAccounts()).find((a) => String(a['Account Id']) === String(account.propreportsAccountId));
      if (row && row['Cash'] !== '' && row['Cash'] !== undefined) {
        accountInfo = { cash: Number(row['Cash']), unrealized: Number(row['Unrealized'] || 0) };
        const last = snap.rows.at(-1);
        const reported = accountInfo.cash + accountInfo.unrealized;
        if (last && Math.abs(last.accountValue - reported) > 0.05) {
          warnings.push({
            type: 'account_value_mismatch',
            message: `Reconstructed account value ${last.accountValue.toFixed(2)} differs from PropReports Cash + Unrealized ${reported.toFixed(2)}. The difference is ${(reported - last.accountValue).toFixed(2)}. It is usually a charge or deposit dated before the history PropReports returned, or a fee type that is not configured; check Settings and the first full-history sync.`,
          });
        }
      }
    }

    // ---- 5. ONE atomic commit ---------------------------------------------
    const stats = {
      fillsFetched: fills.length,
      fillsNew: fillDiff.inserts.length,
      fillsUpdated: fillDiff.replacements.length,
      adjustmentsFetched: adjustments.length,
      adjustmentsNew: adjDiff.inserts.length,
      adjustmentsUpdated: adjDiff.replacements.length,
      snapshotDays: snap.rows.length,
      positionsDetected: instances.length,
      openPositions: instances.filter((p) => p.status === 'open').length,
    };
    await store.commit({
      runId,
      isFullHistory,
      fills: fillDiff,
      adjustments: adjDiff,
      instances,
      snapshots: snap.rows,
      accountInfo,
      cursorDate: today,
      stats,
      warnings,
    });
    return { ok: true, runId, ...stats, warnings };
  } catch (err) {
    const message = err.userMessage ?? err.message ?? 'Unknown error';
    await store.failRun(runId, {
      message: redactToken(message, token),
      detail: redactToken(String(err.detail ?? err.cause ?? ''), token),
    });
    return {
      ok: false,
      runId,
      error: redactToken(
        err.userMessage ?? (err.name === 'PropReportsError' ? err.message : 'PropReports synchronization failed.'),
        token
      ) + ' Your previous data is still available.',
    };
  }
}
