// Minimal RFC4180-ish CSV parser with no dependencies.
//
// Spec section 5 is explicit: "Do not assume column ordering. Map fields by
// their actual column names. Handle missing optional columns safely." This
// parser returns an array of plain objects keyed by header name so every
// caller reads fields like row['Trade Date'] rather than row[3].

/**
 * @param {string} text  Raw CSV text from a PropReports API response.
 * @returns {Record<string,string>[]}
 */
export function parseCsv(text) {
  const rows = parseRows(text.replace(/\r\n/g, '\n'));
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  return dataRows
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map((r) => {
      /** @type {Record<string,string>} */
      const obj = {};
      header.forEach((col, i) => {
        obj[col] = r[i] ?? '';
      });
      return obj;
    });
}

/** @param {string} text @returns {string[][]} */
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Safe numeric read: PropReports renders negatives as "(1.23)" in reports
 * but plain "-1.23" in the API CSV — handle both, and treat blank as 0.
 * @param {string|undefined} raw
 */
export function toNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const trimmed = String(raw).trim();
  const parenNegative = /^\((.*)\)$/.exec(trimmed);
  const cleaned = (parenNegative ? parenNegative[1] : trimmed).replace(/,/g, '');
  const value = Number(cleaned);
  if (Number.isNaN(value)) return 0;
  return parenNegative ? -value : value;
}

/**
 * Read an optional column by trying several possible header spellings,
 * since PropReports optionalFields are opt-in per API token and column
 * names have shifted casing/spacing across versions in practice.
 * @param {Record<string,string>} row
 * @param {string[]} candidates
 */
export function readOptional(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return undefined;
}

// ---- Trade fee columns ------------------------------------------------------
// PropReports writes its fee columns as "Comm, ECN Fee, SEC, CLR, CAT, TAF, NSCC, NFA, ORF, MISC, ACC"
// (see the Totals by Date / Trades exports). The old code looked for 'Ecn Fee', 'Clr', 'Misc' with exact
// case, so the ECN fee (and CLR / MISC / ACC when non-zero) was silently read as 0 — that is the
// 2–13 cent gap per symbol. Headers are now matched ignoring case, spaces and punctuation.
const headerKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const TRADE_FEE_KEYS = new Set(['comm', 'ecnfee', 'ecn', 'sec', 'taf', 'nscc', 'clr', 'cat', 'nfa', 'orf', 'misc', 'acc', 'access', 'ftt']);

/** Read a column by name ignoring case / spaces / punctuation ("ECN Fee" = "Ecn Fee" = "ecnFee"). */
export function readColumn(row, names) {
  const wanted = new Set(names.map(headerKey));
  for (const k of Object.keys(row ?? {})) if (wanted.has(headerKey(k)) && row[k] !== '' && row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
}

/** True when the row carries at least one per-execution fee column. */
export function hasTradeFeeColumns(row) {
  return Object.keys(row ?? {}).some((k) => TRADE_FEE_KEYS.has(headerKey(k)));
}

/** Σ of every per-execution fee column on the row (rebates are negative), each column counted once. */
export function tradeFeeTotal(row) {
  const seen = new Set();
  let total = 0;
  for (const [k, v] of Object.entries(row ?? {})) {
    const key = headerKey(k);
    if (!TRADE_FEE_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    total += toNumber(v);
  }
  return total;
}
