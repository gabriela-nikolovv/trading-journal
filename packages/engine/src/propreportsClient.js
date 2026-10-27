// PropReports API v2 client (https://<firm>.propreports.com/api.php).
//
// Everything network-related is injected (fetchImpl, sleep, clock) so the
// whole client is unit-testable with no network — and so it runs unchanged
// in a Deno Edge Function, where the global fetch is available.
//
// SECURITY: the token is only ever placed in the POST body. It is never
// part of a URL, never included in an error message, and every error text
// is passed through redactToken() before it can reach a log or the UI.
//
// Documented behaviour this implements (API v2 page, Jul 2026):
//  - HTTPS POST, application/x-www-form-urlencoded, `token` on every call
//  - responses are CSV followed by a `Page N/M` trailer line (always, in v2)
//  - paginated actions: accounts/adjustments/fills (50k rows), positions (10k)
//  - rate limit 40 requests per 4 seconds
//  - HTTP status codes carry the failure type (400/401/403/404/405/503)

import { parseCsv } from './csv.js';

export class PropReportsError extends Error {
  /** @param {string} message @param {{kind:string,status?:number}} meta */
  constructor(message, meta) {
    super(message);
    this.name = 'PropReportsError';
    this.kind = meta.kind; // 'auth'|'forbidden'|'bad_request'|'not_found'|'rate_limit'|'server'|'network'|'format'
    this.status = meta.status;
  }
}

/** Strip the token (and its encoded forms) from any text. */
export function redactToken(text, token) {
  if (!token) return String(text);
  let out = String(text);
  for (const variant of new Set([token, encodeURIComponent(token)])) {
    out = out.split(variant).join('[REDACTED]');
  }
  return out;
}

const TRAILER = /(?:^|\n)Page (\d+)\/(\d+)\s*$/;

/**
 * Split a v2 response body into its CSV text and page trailer.
 * A body with no trailer is treated as a single page (defensive: the
 * `login`/`version` style responses have none).
 * @param {string} body
 */
export function splitPageTrailer(body) {
  const m = TRAILER.exec(body);
  if (!m) return { csv: body, page: 1, totalPages: 1, hadTrailer: false };
  return { csv: body.slice(0, m.index), page: Number(m[1]), totalPages: Number(m[2]), hadTrailer: true };
}

function statusToKind(status) {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'bad_request';
}

const USER_MESSAGES = {
  auth: 'PropReports rejected the API token. Create a new token under Profile → API Tokens and enter it again.',
  forbidden: 'This PropReports token is not allowed to read that data.',
  not_found: 'PropReports could not find what was requested.',
  rate_limit: 'PropReports is rate-limiting requests. Please try again in a few seconds.',
  server: 'PropReports is temporarily unavailable.',
  bad_request: 'PropReports could not process the request.',
  network: 'Could not reach PropReports.',
  format: 'PropReports returned data in an unexpected format.',
};

/**
 * @param {Object} opts
 * @param {string} opts.baseUrl     e.g. https://alaric.propreports.com/api.php
 * @param {string} opts.token
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 * @param {()=>number} [opts.now]
 * @param {string} [opts.userAgent]
 * @param {number} [opts.maxRetries]    retries for 5xx / network errors
 */
export function createPropReportsClient({
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  userAgent = 'TradingJournal/1.0',
  maxRetries = 2,
}) {
  if (!token) throw new Error('PropReports token is required');
  if (!baseUrl.startsWith('https://')) throw new Error('PropReports base URL must be https');

  // Sliding-window limiter: at most 40 requests per 4000ms (use 36 for headroom).
  const WINDOW_MS = 4000;
  const MAX_IN_WINDOW = 36;
  /** @type {number[]} */
  let stamps = [];
  async function throttle() {
    for (;;) {
      const t = now();
      stamps = stamps.filter((s) => t - s < WINDOW_MS);
      if (stamps.length < MAX_IN_WINDOW) {
        stamps.push(t);
        return;
      }
      await sleep(WINDOW_MS - (t - stamps[0]) + 1);
    }
  }

  /** One HTTP POST → text body. Retries transient failures. */
  async function post(action, params) {
    const body = new URLSearchParams({ action, token });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
    }

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await throttle();
      let res;
      try {
        res = await fetchImpl(baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent },
          body: body.toString(),
        });
      } catch (e) {
        lastErr = new PropReportsError(USER_MESSAGES.network, { kind: 'network' });
        lastErr.cause = redactToken(e?.message ?? e, token);
        await sleep(300 * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      if (res.ok) return text;

      const kind = statusToKind(res.status);
      lastErr = new PropReportsError(USER_MESSAGES[kind], { kind, status: res.status });
      // Server's own explanation is useful for debugging but must be token-free and short.
      lastErr.detail = redactToken(text.slice(0, 300), token);
      if (kind === 'server' || kind === 'rate_limit') {
        await sleep(500 * 2 ** attempt);
        continue; // transient — retry
      }
      throw lastErr; // auth / forbidden / bad request: retrying cannot help
    }
    throw lastErr;
  }

  /** Fetch every page of a paginated action and return all parsed rows. */
  async function fetchAllPages(action, params) {
    const rows = [];
    let page = 1;
    let total = 1;
    do {
      const text = await post(action, { ...params, page });
      const t = splitPageTrailer(text);
      if (!t.hadTrailer && page === 1 && text.trim() !== '' && !text.includes(',')) {
        // A non-CSV, trailer-less body from a paginated action is an error message.
        throw new PropReportsError(USER_MESSAGES.format, { kind: 'format' });
      }
      rows.push(...parseCsv(t.csv));
      total = t.totalPages;
      page += 1;
    } while (page <= total);
    return rows;
  }

  return {
    /** Validates the token and returns the server version string. */
    async version() {
      return (await post('version', {})).trim();
    },
    /** @returns {Promise<Record<string,string>[]>} accounts this token may query */
    listAccounts() {
      return fetchAllPages('accounts', { optionalFields: 'accountName,creationDate,status' });
    },
    /** @param {number|string} accountId @param {string} startDate YYYY-MM-DD @param {string} endDate */
    fetchFills(accountId, startDate, endDate) {
      return fetchAllPages('fills', {
        accountId,
        startDate,
        endDate,
        // Columns we depend on are opt-in in v2 — request them explicitly.
        optionalFields: 'propReportsId,fillId,currency,multiplier',
      });
    },
    fetchAdjustments(accountId, startDate, endDate) {
      return fetchAllPages('adjustments', { accountId, startDate, endDate, optionalFields: 'propReportsId' });
    },
    /** Daily per-symbol rows incl. PropReports' own Unrealized Delta / Realized. */
    fetchPositions(accountId, startDate, endDate, type = 'all') {
      return fetchAllPages('positions', { accountId, startDate, endDate, type });
    },
  };
}
