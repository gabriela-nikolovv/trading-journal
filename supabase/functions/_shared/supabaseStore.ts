// Supabase adapter for the engine's Store interface. Uses the SERVICE-ROLE
// client, so it must only ever run inside an Edge Function — never in the browser.
// NOT YET RUN against a live project (the build sandbox has no network access
// to Supabase); the SQL it calls (apply_sync_batch) IS tested against Postgres.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const PAGE = 1000; // PostgREST returns at most 1000 rows per request

async function selectAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`database read failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export function createSupabaseStore(db: SupabaseClient, propAccountId: string) {
  return {
    async getAccount() {
      const { data: a, error } = await db.from('prop_accounts').select('id, propreports_account_id').eq('id', propAccountId).single();
      if (error) throw new Error('prop account not found');
      const { data: s } = await db.from('sync_state').select('fills_cursor_date, adjustments_cursor_date').eq('prop_account_id', propAccountId).maybeSingle();
      const { data: first } = await db.from('raw_fills').select('trade_date').eq('prop_account_id', propAccountId).order('trade_date').limit(1);
      return {
        id: a.id, propreportsAccountId: a.propreports_account_id,
        firstTradedDate: first?.[0]?.trade_date ?? null, // refined from the accounts action by the handler on first run
        fillsCursorDate: s?.fills_cursor_date ?? null, adjustmentsCursorDate: s?.adjustments_cursor_date ?? null,
      };
    },
    async beginRun({ isFullHistory }: { isFullHistory: boolean }) {
      const { data: acct } = await db.from('prop_accounts').select('user_id').eq('id', propAccountId).single();
      const { data, error } = await db.from('sync_runs').insert({ prop_account_id: propAccountId, user_id: acct!.user_id, is_full_history: isFullHistory }).select('id').single();
      if (error) throw new Error(`could not start sync run: ${error.message}`);
      await db.from('sync_state').upsert({ prop_account_id: propAccountId, user_id: acct!.user_id, status: 'running', last_run_started_at: new Date().toISOString() });
      return data.id as string;
    },
    async getActiveFills(from: string, to: string) {
      const rows = await selectAll<any>((a, b) => db.from('raw_fills').select('id, propreports_id, fingerprint').eq('prop_account_id', propAccountId).eq('is_superseded', false).gte('trade_date', from).lte('trade_date', to).range(a, b));
      return rows.map((r) => ({ id: r.id, propreportsId: r.propreports_id, fingerprint: r.fingerprint }));
    },
    async getActiveAdjustments(from: string, to: string) {
      const rows = await selectAll<any>((a, b) => db.from('raw_adjustments').select('id, propreports_id, fingerprint').eq('prop_account_id', propAccountId).eq('is_superseded', false).gte('adjustment_date', from).lte('adjustment_date', to).range(a, b));
      return rows.map((r) => ({ id: r.id, propreportsId: r.propreports_id, fingerprint: r.fingerprint }));
    },
    async getAdjustmentCategories() {
      const { data } = await db.from('adjustment_categories').select('name, category_type');
      return new Map((data ?? []).map((c: any) => [c.name, c.category_type as 'fee' | 'transfer']));
    },
    async getAccountValueBefore(date: string) {
      const { data } = await db.from('daily_account_snapshots').select('account_value').eq('prop_account_id', propAccountId).lt('trade_date', date).order('trade_date', { ascending: false }).limit(1);
      return data?.[0]?.account_value != null ? Number(data[0].account_value) : 0;
    },
    async getAllActiveFills() {
      const rows = await selectAll<any>((a, b) => db.from('raw_fills').select('*').eq('prop_account_id', propAccountId).eq('is_superseded', false).order('datetime').range(a, b));
      return rows.map((r) => ({
        id: r.id, symbol: r.symbol, datetime: new Date(r.datetime), side: r.side, quantity: Number(r.quantity), price: Number(r.price),
        totalFee: ['comm', 'ecn_fee', 'sec_fee', 'taf_fee', 'nscc_fee', 'clr_fee', 'misc_fee'].reduce((s, k) => s + Number(r[k]), 0),
        multiplier: Number(r.multiplier ?? 1), currency: r.currency ?? 'USD',
      }));
    },
    async commit(batch: unknown) {
      const { error } = await db.rpc('apply_sync_batch', { p_prop_account_id: propAccountId, p_batch: batch });
      if (error) throw new Error(`database commit failed: ${error.message}`);
    },
    async failRun(runId: string, e: { message: string; detail?: string }) {
      await db.from('sync_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error_message: e.message }).eq('id', runId);
      await db.from('sync_state').update({ status: 'failed', last_error: e.message, updated_at: new Date().toISOString() }).eq('prop_account_id', propAccountId);
      if (e.detail) console.error('sync failure detail:', e.detail); // already token-redacted by the engine
    },
  };
}
