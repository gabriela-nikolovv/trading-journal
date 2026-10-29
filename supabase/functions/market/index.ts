// POST /functions/v1/market
//   {"action":"positions"}                          → enriched open positions + exposure/risk summary (Current Positions tab)
//   {"action":"quotes","symbols":["AAPL","MSFT"]}   → raw quotes
//   {"action":"classify","symbols":["AAPL"]}        → refresh TradingView sector/industry cache
//
// Prices come through the QuoteProvider interface (Yahoo today). The browser never talks to
// Yahoo/TradingView directly and no secret is involved; the service-role key stays server-side.
//
// NOT YET RUN LIVE: the build sandbox cannot reach Yahoo Finance, TradingView or Supabase. The pure logic
// (parsing, caching, fallbacks, R/exposure maths, taxonomy matching) and the SQL are tested; the wiring
// below is verified only by reading, so expect to fix small things on the first deploy.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createYahooProvider, createQuoteService } from '../_shared/engine/marketData.js';
import { enrichPosition, summarizePortfolio } from '../_shared/engine/positionAnalytics.js';
import { fetchTradingViewClassification } from '../_shared/engine/taxonomy.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  // supabase-js sends x-client-info and apikey on every call; the browser's preflight must allow them.
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ ok: false, error: 'Please sign in.' }, 401);
    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const quotes = createQuoteService({
      provider: createYahooProvider(),
      lastKnown: async (symbol: string) => {
        const { data } = await db.from('market_quotes').select('price, as_of, currency').eq('symbol', symbol).maybeSingle();
        return data ? { price: Number(data.price), asOf: data.as_of, currency: data.currency } : null;
      },
      persist: async (q: any) => {
        await db.from('market_quotes').upsert({ symbol: q.symbol, price: q.price, currency: q.currency ?? 'USD', as_of: q.asOf, session: q.session, source: q.source, fetched_at: new Date().toISOString() });
      },
    });

    const body = await req.json().catch(() => ({}));
    const { action } = body;

    if (action === 'quotes') {
      const m = await quotes.getQuotes(body.symbols ?? []);
      return json({ ok: true, quotes: Object.fromEntries(m) });
    }

    if (action === 'classify') {
      const result = await fetchTradingViewClassification(body.symbols ?? []);
      const { data: sectors } = await db.from('sectors').select('id, name');
      const { data: industries } = await db.from('industries').select('id, name, sector_id');
      for (const [symbol, c] of result) {
        const sector = sectors?.find((s: any) => s.name === (c as any).sector);
        const industry = industries?.find((i: any) => i.name === (c as any).industry && i.sector_id === sector?.id);
        await db.from('symbol_classifications').upsert({
          symbol, status: (c as any).status, reason: (c as any).reason ?? null, fetched_at: new Date().toISOString(),
          sector_id: (c as any).status === 'ok' ? sector?.id ?? null : null, industry_id: (c as any).status === 'ok' ? industry?.id ?? null : null,
        });
      }
      return json({ ok: true, classifications: Object.fromEntries(result) });
    }

    if (action === 'positions') {
      const { data: acct } = await db.from('prop_accounts').select('id').eq('user_id', user.id).eq('is_active', true).maybeSingle();
      if (!acct) return json({ ok: false, error: 'No PropReports account set up yet.' }, 409);

      const { data: rows, error } = await db.from('position_instances')
        .select('id, symbol, direction, open_quantity, avg_entry_price, multiplier, stop_loss, notes, opened_at, sector_id, industry_id, journal_close_note, journal_closed_at, sector:sectors!position_instances_sector_id_fkey(name), industry:industries!fk_position_industry_in_sector(name)')
        .eq('prop_account_id', acct.id).eq('status', 'open');
      if (error) throw error;

      const symbols = (rows ?? []).map((r: any) => r.symbol);
      const priceMap = await quotes.getQuotes(symbols);

      // Automatic classification for symbols the user has not classified; the user's own choice always wins.
      const { data: auto } = await db.from('symbol_classifications').select('symbol, status, sector:sectors(name), industry:industries(name)').in('symbol', symbols);
      const autoBy = new Map((auto ?? []).map((a: any) => [a.symbol, a]));
      const needClassify = symbols.filter((s: string) => !autoBy.has(s));
      if (needClassify.length) console.log('symbols awaiting classification:', needClassify.join(','));

      const positions = (rows ?? []).map((r: any) => {
        const a: any = autoBy.get(r.symbol);
        const userChose = !!r.sector?.name;
        const enriched = enrichPosition({
          symbol: r.symbol, direction: r.direction, openQuantity: Number(r.open_quantity), avgEntryPrice: Number(r.avg_entry_price),
          multiplier: Number(r.multiplier ?? 1), stopLoss: r.stop_loss === null ? null : Number(r.stop_loss),
          sectorName: r.sector?.name ?? (a?.status === 'ok' ? a.sector?.name : null),
          industryName: r.industry?.name ?? (a?.status === 'ok' ? a.industry?.name : null),
        }, priceMap.get(r.symbol.toUpperCase()));
        return { id: r.id, notes: r.notes, openedAt: r.opened_at, sectorId: r.sector_id, industryId: r.industry_id, journalCloseNote: r.journal_close_note, journalClosedAt: r.journal_closed_at, classificationSource: userChose ? 'user' : a?.status === 'ok' ? 'tradingview' : null, ...enriched };
      });
      // accountValue is left null until account snapshots are synced — risk % of account is then (correctly) not shown.
      return json({ ok: true, positions, summary: summarizePortfolio(positions, { accountValue: null }), symbolsAwaitingClassification: needClassify });
    }

    return json({ ok: false, error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('market handler error:', (e as Error).message);
    return json({ ok: false, error: 'Market data is temporarily unavailable.' }, 500);
  }
});
