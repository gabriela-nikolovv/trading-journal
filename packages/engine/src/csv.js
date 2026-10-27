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
  if (raw === undefined || raw === null || raw.trim() === '') return 0;
  const trimmed = raw.trim();
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
