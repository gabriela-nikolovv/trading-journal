// All data access for the website. Every call goes through Supabase with the signed-in user's
// session, so Row Level Security decides what is visible — the browser never holds a service key
// and never sees the PropReports token.
//
// The views only talk to the object returned by createApi(), so tests can swap in a fake.

const PAGE = 1000;

async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

/** Row → shape the engine modules expect. Timestamps are kept as the Date objects the engine uses. */
export function toTrade(r) {
  return {
    id: r.id, symbol: r.symbol, direction: r.direction, status: r.status,
    openQuantity: Number(r.open_quantity), quantityTraded: Number(r.quantity_traded),
    avgEntryPrice: Number(r.avg_entry_price), avgExitPrice: r.avg_exit_price === null ? null : Number(r.avg_exit_price),
    realizedPnl: Number(r.realized_pnl), feesAllocated: Number(r.fees_allocated),
    openedAt: new Date(r.opened_at), closedAt: r.closed_at ? new Date(r.closed_at) : null,
    stopLoss: r.stop_loss === null ? null : Number(r.stop_loss), notes: r.notes,
    sector: r.sector?.name ?? null, industry: r.industry?.name ?? null, sectorId: r.sector_id, industryId: r.industry_id,
    multiplier: Number(r.multiplier ?? 1), journalCloseNote: r.journal_close_note, journalClosedAt: r.journal_closed_at,
  };
}
export function toSnapshot(r) {
  return {
    date: r.trade_date, schema1Delta: Number(r.schema1_delta), schema3Delta: Number(r.schema3_delta),
    commissions: Number(r.commissions), marketDataFees: Number(r.market_data_fees), platformFees: Number(r.platform_fees),
    otherFees: Number(r.other_fees), transfers: Number(r.transfers), accountValue: r.account_value === null ? 0 : Number(r.account_value),
    realizedNet: Number(r.realized_net), quantityTraded: Number(r.quantity_traded),
  };
}

const TRADE_SELECT = '*, sector:sectors(name), industry:industries(name)';

export function createApi(sb) {
  const call = async (fn, body) => {
    const { data, error } = await sb.functions.invoke(fn, { body });
      if (error) {
        console.error('Supabase function error:', error);
      
        try {
          const response = error.context;
          if (response) {
            console.error('HTTP status:', response.status);
            console.error('Response body:', await response.clone().text());
          }
        } catch (e) {
          console.error('Could not read error response:', e);
        }
      
        throw new Error(error.message || 'Supabase function failed.');
      }
    if (data && data.ok === false) throw new Error(data.error ?? 'The request failed.');
    return data;
  };

  return {
    // ---------- auth ----------
    async getSession() { return (await sb.auth.getSession()).data.session; },
    async signIn(email, password) { const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw new Error('Sign-in failed. Check your email and password.'); },
    async signOut() { await sb.auth.signOut(); },
    onAuthChange(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s)); },

    // ---------- account + sync ----------
    async getAccount() { return must(await sb.from('prop_accounts').select('*').eq('is_active', true).limit(1).maybeSingle()); },
    async getSyncStatus(accountId) {
      const state = must(await sb.from('sync_state').select('*').eq('prop_account_id', accountId).maybeSingle());
      const lastRun = must(await sb.from('sync_runs').select('*').eq('prop_account_id', accountId).order('started_at', { ascending: false }).limit(1).maybeSingle());
      return { state, lastRun };
    },
    setupAccount() { return call('sync', { action: 'setup' }); },
    runSync({ full = false } = {}) { return call('sync', { action: 'sync', full }); },

    // ---------- P&L data ----------
    async getSnapshots() { return (await fetchAll(() => sb.from('daily_account_snapshots').select('*').order('trade_date'))).map(toSnapshot); },
    async getClosedTrades() { return (await fetchAll(() => sb.from('position_instances').select(TRADE_SELECT).eq('status', 'closed').order('closed_at'))).map(toTrade); },
    async getTradesPage({ filters = {}, page = 0, pageSize = 25 }) {
      let q = sb.from('position_instances').select(TRADE_SELECT, { count: 'exact' });
      q = filters.status === 'open' ? q.eq('status', 'open') : filters.status === 'all' ? q : q.eq('status', 'closed');
      if (filters.symbol) q = q.ilike('symbol', `%${filters.symbol.trim()}%`);
      if (filters.direction) q = q.eq('direction', filters.direction);
      if (filters.sectorId) q = q.eq('sector_id', filters.sectorId);
      if (filters.industryId) q = q.eq('industry_id', filters.industryId);
      if (filters.from) q = q.gte('closed_at', `${filters.from}T00:00:00Z`);
      if (filters.to) q = q.lte('closed_at', `${filters.to}T23:59:59Z`);
      if (filters.result === 'win') q = q.gt('realized_pnl', 0);
      if (filters.result === 'loss') q = q.lt('realized_pnl', 0);
      const { data, error, count } = await q.order('opened_at', { ascending: false }).range(page * pageSize, page * pageSize + pageSize - 1);
      if (error) throw new Error(error.message);
      return { rows: (data ?? []).map(toTrade), total: count ?? 0 };
    },
    async getTradesTouchingDay(day) {
      const start = `${day}T00:00:00Z`, end = `${day}T23:59:59Z`;
      const closed = must(await sb.from('position_instances').select(TRADE_SELECT).gte('closed_at', start).lte('closed_at', end));
      const opened = must(await sb.from('position_instances').select(TRADE_SELECT).gte('opened_at', start).lte('opened_at', end));
      const seen = new Set();
      return [...closed, ...opened].filter((r) => (seen.has(r.id) ? false : seen.add(r.id))).map(toTrade);
    },
    async getTradeFills(instanceId) {
      const links = must(await sb.from('position_fills').select('running_quantity_after, running_avg_cost_after, fill:raw_fills(datetime, side, quantity, price, symbol, comm, ecn_fee, sec_fee, taf_fee, nscc_fee, clr_fee, misc_fee)').eq('position_instance_id', instanceId));
      return links.map((l) => l.fill).filter(Boolean).sort((a, b) => a.datetime.localeCompare(b.datetime));
    },
    async countOpenPositions() { const { count } = await sb.from('position_instances').select('id', { count: 'exact', head: true }).eq('status', 'open'); return count ?? 0; },

    // ---------- current positions + market data ----------
    getPositions() { return call('market', { action: 'positions' }); },
    classify(symbols) { return call('market', { action: 'classify', symbols }); },
    getQuotes(symbols) { return call('market', { action: 'quotes', symbols }); },
    async updatePosition(id, patch) { must(await sb.from('position_instances').update(patch).eq('id', id)); },

    // ---------- taxonomy ----------
    async getSectors() { return must(await sb.from('sectors').select('id, name').order('name')); },
    async getIndustries() { return must(await sb.from('industries').select('id, name, sector_id').order('name')); },

    // ---------- comments ----------
    async getDailyComments(from, to) {
      return must(await sb.from('daily_comments').select('trade_date, comment').gte('trade_date', from).lte('trade_date', to)).map((r) => ({ date: r.trade_date, comment: r.comment }));
    },
    async saveDailyComment(accountId, userId, date, comment) {
      if (!comment.trim()) { must(await sb.from('daily_comments').delete().eq('prop_account_id', accountId).eq('trade_date', date)); return; }
      must(await sb.from('daily_comments').upsert({ prop_account_id: accountId, user_id: userId, trade_date: date, comment: comment.trim(), updated_at: new Date().toISOString() }, { onConflict: 'prop_account_id,trade_date' }));
    },

    // ---------- profit share ----------
    async getProfitShareSchedule() { return must(await sb.from('profit_share_schedule').select('pct, effective_from').order('effective_from')).map((r) => ({ pct: Number(r.pct), effectiveFrom: r.effective_from })); },
    async saveProfitShare(userId, pct, effectiveFrom) {
      must(await sb.from('profit_share_schedule').upsert({ user_id: userId, pct, effective_from: effectiveFrom }, { onConflict: 'user_id,effective_from' }));
    },

    // ---------- user settings ----------
    async getSettings() { return must(await sb.from('user_settings').select('*').maybeSingle()); },
    async saveSettings(userId, patch) { must(await sb.from('user_settings').upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })); },

    // ---------- weekly reports ----------
    async getWeeklyReport(accountId, weekStart) { return must(await sb.from('weekly_reports').select('*').eq('prop_account_id', accountId).eq('week_start_date', weekStart).maybeSingle()); },
    async saveWeeklyReport(row) { must(await sb.from('weekly_reports').upsert(row, { onConflict: 'prop_account_id,week_start_date' })); },
  };
}
