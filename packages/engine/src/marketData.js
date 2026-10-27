// Market-data layer (spec sections 12, 13): a provider interface, a Yahoo
// Finance implementation, and a caching quote service.
//
// RULES BAKED IN
//  - Never fabricate a price. A symbol Yahoo cannot price comes back
//    { ok:false, reason } — callers show "price unavailable", not a guess.
//  - Never silently substitute a different instrument: if Yahoo answers with
//    a different symbol than we asked for, that is treated as unavailable.
//  - A closed market is not an error: the last regular-session price is the
//    right price, labelled with its timestamp and session.
//  - A last-known price used because the live call failed is returned as
//    stale with its real timestamp, never passed off as current.
//
// Yahoo's chart endpoint is UNOFFICIAL (no key, no SLA, may change or rate
// limit). That is exactly why everything goes through the QuoteProvider
// interface below: swap the provider, nothing else changes.

/**
 * @typedef {Object} Quote
 * @property {string} symbol            symbol as the journal knows it
 * @property {boolean} ok
 * @property {number} [price]
 * @property {string} [asOf]            ISO timestamp of the price itself
 * @property {'regular'|'pre'|'post'|'closed'} [session]
 * @property {string} [currency]
 * @property {string} [source]          provider name
 * @property {boolean} [stale]          price is old or a last-known fallback
 * @property {string} [staleReason]
 * @property {string} [reason]          why ok is false
 *
 * @typedef {Object} QuoteProvider
 * @property {string} name
 * @property {(symbol:string)=>Promise<Quote>} fetchQuote
 */

/** PropReports/US class-share notation (BRK.B) → Yahoo notation (BRK-B). */
export function toYahooSymbol(symbol) {
  const s = String(symbol).trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z]{1,5}\.[A-Z]$/.test(s) ? s.replace('.', '-') : s;
}

const DAY_MS = 86400000;

/**
 * Turn one Yahoo chart response into a Quote (pure; unit-tested on fixtures).
 * @param {any} json
 * @param {string} symbol   journal symbol
 * @param {number} nowMs
 * @returns {Quote}
 */
export function parseYahooChart(json, symbol, nowMs) {
  const unavailable = (reason) => ({ symbol, ok: false, source: 'yahoo', reason });
  const err = json?.chart?.error;
  if (err) return unavailable(`Yahoo Finance has no price for ${symbol} (${err.description || err.code || 'unknown error'}).`);

  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) return unavailable(`Yahoo Finance returned no data for ${symbol}.`);

  // Guard against silent substitution.
  if (String(meta.symbol).toUpperCase() !== toYahooSymbol(symbol)) {
    return unavailable(`Yahoo Finance answered with ${meta.symbol} when asked for ${symbol}; ignored to avoid using the wrong instrument.`);
  }
  const price = Number(meta.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return unavailable(`Yahoo Finance returned no usable price for ${symbol}.`);

  const asOfMs = Number(meta.regularMarketTime) * 1000;
  if (!Number.isFinite(asOfMs)) return unavailable(`Yahoo Finance returned no timestamp for ${symbol}.`);

  // Session from the trading-period windows Yahoo supplies (all in epoch seconds).
  const tp = meta.currentTradingPeriod ?? {};
  const within = (p) => p && nowMs / 1000 >= p.start && nowMs / 1000 < p.end;
  const session = within(tp.regular) ? 'regular' : within(tp.pre) ? 'pre' : within(tp.post) ? 'post' : 'closed';

  // A closed market still has a perfectly good last price; only flag if it is genuinely old
  // (more than 4 days covers a long weekend).
  const ageMs = nowMs - asOfMs;
  const stale = ageMs > 4 * DAY_MS;

  return {
    symbol, ok: true, price, asOf: new Date(asOfMs).toISOString(), session,
    currency: meta.currency || 'USD', source: 'yahoo', stale,
    ...(stale ? { staleReason: `Last trade was ${Math.floor(ageMs / DAY_MS)} days ago.` } : {}),
  };
}

/** @returns {QuoteProvider} */
export function createYahooProvider({ fetchImpl = globalThis.fetch, now = () => Date.now(), userAgent = 'Mozilla/5.0 (TradingJournal)' } = {}) {
  return {
    name: 'yahoo',
    async fetchQuote(symbol) {
      const ySym = toYahooSymbol(symbol);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&range=5d`;
      let res;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
      } catch {
        return { symbol, ok: false, source: 'yahoo', reason: `Could not reach Yahoo Finance for ${symbol}.` };
      }
      if (res.status === 429) return { symbol, ok: false, source: 'yahoo', reason: 'Yahoo Finance is rate-limiting requests; try again shortly.' };
      let json;
      try { json = await res.json(); } catch { json = null; }
      // Yahoo reports unknown symbols as HTTP 404 *with* a JSON error body — parse it for the real reason.
      if (!res.ok && !json?.chart?.error) return { symbol, ok: false, source: 'yahoo', reason: `Yahoo Finance returned HTTP ${res.status} for ${symbol}.` };
      return parseYahooChart(json, symbol, now());
    },
  };
}

/**
 * Caching, de-duplicating, concurrency-limited service over any provider.
 * @param {Object} o
 * @param {QuoteProvider} o.provider
 * @param {()=>number} [o.now]
 * @param {number} [o.concurrency]
 * @param {(symbol:string)=>Promise<{price:number,asOf:string,currency?:string}|null>} [o.lastKnown]  durable fallback (database)
 * @param {(quote:Quote)=>Promise<void>} [o.persist]                                                 called with every good quote
 */
export function createQuoteService({ provider, now = () => Date.now(), concurrency = 5, lastKnown, persist }) {
  /** @type {Map<string,{at:number,quote:Quote}>} */
  const cache = new Map();
  // Cache briefly while the market is open (prices move); longer when it is closed (they do not).
  const ttl = (q) => (q.ok && q.session === 'regular' ? 30_000 : 10 * 60_000);

  async function one(symbol) {
    const hit = cache.get(symbol);
    if (hit && now() - hit.at < ttl(hit.quote)) return hit.quote;

    let q = await provider.fetchQuote(symbol);
    if (q.ok) {
      cache.set(symbol, { at: now(), quote: q });
      if (persist) await persist(q).catch(() => {}); // a failed cache write must never break a price
      return q;
    }
    // Live call failed: fall back to the last durable price, clearly labelled — or stay unavailable.
    const prev = lastKnown ? await lastKnown(symbol).catch(() => null) : null;
    if (prev) {
      return { symbol, ok: true, price: prev.price, asOf: prev.asOf, currency: prev.currency || 'USD', session: 'closed', source: provider.name,
               stale: true, staleReason: `Live price unavailable (${q.reason}). Showing the last known price from ${prev.asOf}.` };
    }
    return q;
  }

  return {
    /** @param {string[]} symbols @returns {Promise<Map<string,Quote>>} */
    async getQuotes(symbols) {
      const unique = [...new Set(symbols.map((s) => String(s).trim().toUpperCase()))];
      const out = new Map();
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
        while (i < unique.length) {
          const sym = unique[i++];
          out.set(sym, await one(sym));
        }
      }));
      return out;
    },
  };
}
