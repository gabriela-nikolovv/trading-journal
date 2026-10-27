-- =====================================================================
-- 0003 — Atomic sync commit
-- =====================================================================
-- The sync engine (packages/engine/src/syncEngine.js) fetches and diffs
-- everything in memory, then hands ONE jsonb batch to apply_sync_batch().
-- Because it is a single function call it runs as ONE transaction: either
-- the whole sync lands or none of it does (spec section 6).
--
-- THE RULE THIS FUNCTION EXISTS TO PROTECT: position_instances mixes
-- API-controlled columns with USER-CONTROLLED ones (stop_loss, sector_id,
-- industry_id, notes). The upsert below only ever writes the API columns,
-- so a re-sync can never overwrite or delete a Stop Loss (spec 8, 11, 54).

-- 1. Dedup fingerprints. The engine tags each fingerprint with an occurrence
--    index (…#1, …#2) so two genuinely identical fills that carry no
--    PropReports Id are both kept; the old natural-key unique index would have
--    rejected the second one, so it is replaced.
alter table public.raw_fills        add column if not exists fingerprint text;
alter table public.raw_adjustments  add column if not exists fingerprint text;
alter table public.raw_adjustments  add column if not exists category_type text check (category_type in ('fee','transfer'));
-- The natural-key guard is kept, but made occurrence-aware: a second fill with the
-- SAME natural key is rejected unless it is explicitly occurrence #2 (a genuine twin).
alter table public.raw_fills add column if not exists occurrence int not null default 1;
drop index if exists public.uq_raw_fills_fingerprint;
create unique index if not exists uq_raw_fills_natural_key
  on public.raw_fills (prop_account_id, symbol, datetime, side, quantity, price, coalesce(order_id, ''), occurrence)
  where propreports_id is null and is_superseded = false;
create unique index if not exists uq_raw_adj_fp on public.raw_adjustments (prop_account_id, fingerprint)
  where propreports_id is null and is_superseded = false and fingerprint is not null;

-- 2. A position instance is identified by (account, symbol, time it opened).
create unique index if not exists uq_position_identity
  on public.position_instances (prop_account_id, symbol, opened_at);

-- 3. The commit.
create or replace function public.apply_sync_batch(p_prop_account_id uuid, p_batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_item jsonb;
  v_inst jsonb;
  v_link jsonb;
  v_inst_id uuid;
  v_keep_ids uuid[] := '{}';
  v_deleted int;
  v_run uuid := nullif(p_batch->>'runId','')::uuid;
begin
  select user_id into v_user from prop_accounts where id = p_prop_account_id;
  if v_user is null then raise exception 'unknown prop account'; end if;

  -- ---- fills: removed / replaced are superseded, never deleted (audit trail) ----
  update raw_fills set is_superseded = true, updated_at = now()
   where prop_account_id = p_prop_account_id
     and id in (select (x->>'id')::uuid from jsonb_array_elements(p_batch#>'{fills,removed}') x);
  update raw_fills set is_superseded = true, updated_at = now()
   where prop_account_id = p_prop_account_id
     and id in (select (x->>'supersedeId')::uuid from jsonb_array_elements(p_batch#>'{fills,replacements}') x);

  for v_item in select * from jsonb_array_elements((p_batch#>'{fills,inserts}') || (p_batch#>'{fills,replacements}')) loop
    insert into raw_fills (id, prop_account_id, user_id, propreports_id, fill_id, order_id, datetime, trade_date,
                           symbol, side, quantity, price, route, status,
                           comm, ecn_fee, sec_fee, taf_fee, nscc_fee, clr_fee, misc_fee,
                           currency, multiplier, fingerprint, occurrence, raw_json)
    values ((v_item->>'id')::uuid, p_prop_account_id, v_user,
            nullif(v_item#>>'{record,propreportsId}',''), nullif(v_item#>>'{record,fillId}',''), nullif(v_item#>>'{record,orderId}',''),
            ((v_item#>>'{record,datetimeIso}')::timestamp at time zone 'UTC'), (v_item#>>'{record,tradeDate}')::date,
            v_item#>>'{record,symbol}', v_item#>>'{record,side}',
            (v_item#>>'{record,quantity}')::numeric, (v_item#>>'{record,price}')::numeric,
            v_item#>>'{record,route}', v_item#>>'{record,status}',
            (v_item#>>'{record,comm}')::numeric, (v_item#>>'{record,ecnFee}')::numeric, (v_item#>>'{record,secFee}')::numeric,
            (v_item#>>'{record,tafFee}')::numeric, (v_item#>>'{record,nsccFee}')::numeric, (v_item#>>'{record,clrFee}')::numeric,
            (v_item#>>'{record,miscFee}')::numeric,
            coalesce(v_item#>>'{record,currency}','USD'), coalesce((v_item#>>'{record,multiplier}')::numeric,1),
            v_item->>'fingerprint', coalesce(nullif(substring(v_item->>'fingerprint' from '#(\d+)$'),'')::int, 1),
            coalesce(v_item#>'{record,raw}','{}'::jsonb));
  end loop;

  -- ---- adjustments (same pattern) ----
  update raw_adjustments set is_superseded = true, updated_at = now()
   where prop_account_id = p_prop_account_id
     and id in (select (x->>'id')::uuid from jsonb_array_elements(p_batch#>'{adjustments,removed}') x);
  update raw_adjustments set is_superseded = true, updated_at = now()
   where prop_account_id = p_prop_account_id
     and id in (select (x->>'supersedeId')::uuid from jsonb_array_elements(p_batch#>'{adjustments,replacements}') x);
  for v_item in select * from jsonb_array_elements((p_batch#>'{adjustments,inserts}') || (p_batch#>'{adjustments,replacements}')) loop
    insert into raw_adjustments (prop_account_id, user_id, propreports_id, adjustment_date, category_name, category_type,
                                 amount, description, fingerprint, raw_json)
    values (p_prop_account_id, v_user, nullif(v_item#>>'{record,propreportsId}',''), (v_item#>>'{record,date}')::date,
            v_item#>>'{record,categoryName}', v_item#>>'{record,categoryType}',
            (v_item#>>'{record,amount}')::numeric, v_item#>>'{record,description}',
            v_item->>'fingerprint', coalesce(v_item#>'{record,raw}','{}'::jsonb));
  end loop;

  -- ---- position instances: upsert API columns ONLY ----
  for v_inst in select * from jsonb_array_elements(p_batch->'instances') loop
    insert into position_instances (prop_account_id, user_id, symbol, direction, status, open_quantity, quantity_traded,
                                    avg_entry_price, avg_exit_price, realized_pnl, fees_allocated, currency, multiplier,
                                    opened_at, closed_at)
    values (p_prop_account_id, v_user, v_inst->>'symbol', v_inst->>'direction', v_inst->>'status',
            (v_inst->>'openQuantity')::numeric, (v_inst->>'quantityTraded')::numeric,
            (v_inst->>'avgEntryPrice')::numeric, (v_inst->>'avgExitPrice')::numeric,
            (v_inst->>'realizedPnl')::numeric, (v_inst->>'feesAllocated')::numeric,
            v_inst->>'currency', (v_inst->>'multiplier')::numeric,
            (v_inst->>'openedAt')::timestamptz, nullif(v_inst->>'closedAt','')::timestamptz)
    on conflict (prop_account_id, symbol, opened_at) do update set
      direction = excluded.direction, status = excluded.status, open_quantity = excluded.open_quantity,
      quantity_traded = excluded.quantity_traded, avg_entry_price = excluded.avg_entry_price,
      avg_exit_price = excluded.avg_exit_price, realized_pnl = excluded.realized_pnl,
      fees_allocated = excluded.fees_allocated, closed_at = excluded.closed_at, updated_at = now()
      -- stop_loss, sector_id, industry_id, notes deliberately absent: user-controlled.
    returning id into v_inst_id;
    v_keep_ids := v_keep_ids || v_inst_id;

    delete from position_fills where position_instance_id = v_inst_id;
    for v_link in select * from jsonb_array_elements(v_inst->'fillLinks') loop
      insert into position_fills (position_instance_id, raw_fill_id, running_quantity_after, running_avg_cost_after)
      values (v_inst_id, (v_link->>'fillId')::uuid, (v_link->>'runningQuantityAfter')::numeric, (v_link->>'runningAvgCostAfter')::numeric)
      on conflict do nothing;
    end loop;
  end loop;

  -- Instances no longer produced by the fills (their fills were removed upstream) no longer exist.
  delete from position_instances where prop_account_id = p_prop_account_id and not (id = any (v_keep_ids));
  get diagnostics v_deleted = row_count;

  -- ---- daily snapshots (derived; fully recomputed for the synced window) ----
  for v_item in select * from jsonb_array_elements(coalesce(p_batch->'snapshots','[]'::jsonb)) loop
    insert into daily_account_snapshots (prop_account_id, user_id, trade_date, schema1_delta, schema3_delta, commissions,
                                         market_data_fees, platform_fees, other_fees, transfers, account_value, realized_net, quantity_traded)
    values (p_prop_account_id, v_user, (v_item->>'tradeDate')::date, (v_item->>'schema1Delta')::numeric, (v_item->>'schema3Delta')::numeric,
            (v_item->>'commissions')::numeric, (v_item->>'marketDataFees')::numeric, (v_item->>'platformFees')::numeric,
            (v_item->>'otherFees')::numeric, (v_item->>'transfers')::numeric, (v_item->>'accountValue')::numeric,
            (v_item->>'realizedNet')::numeric, (v_item->>'quantityTraded')::numeric)
    on conflict (prop_account_id, trade_date) do update set
      schema1_delta = excluded.schema1_delta, schema3_delta = excluded.schema3_delta, commissions = excluded.commissions,
      market_data_fees = excluded.market_data_fees, platform_fees = excluded.platform_fees, other_fees = excluded.other_fees,
      transfers = excluded.transfers, account_value = excluded.account_value, realized_net = excluded.realized_net,
      quantity_traded = excluded.quantity_traded, updated_at = now();
  end loop;

  -- ---- sync bookkeeping ----
  update sync_state set status = 'idle', last_success_at = now(), last_error = null,
         account_cash = (p_batch#>>'{accountInfo,cash}')::numeric, account_unrealized = (p_batch#>>'{accountInfo,unrealized}')::numeric,
         fills_cursor_date = (p_batch->>'cursorDate')::date, adjustments_cursor_date = (p_batch->>'cursorDate')::date, updated_at = now()
   where prop_account_id = p_prop_account_id;
  if v_run is not null then
    update sync_runs set status = 'success', finished_at = now(),
           is_full_history = (p_batch->>'isFullHistory')::boolean,
           fills_fetched = (p_batch#>>'{stats,fillsFetched}')::int, fills_new = (p_batch#>>'{stats,fillsNew}')::int,
           fills_updated = (p_batch#>>'{stats,fillsUpdated}')::int,
           adjustments_fetched = (p_batch#>>'{stats,adjustmentsFetched}')::int, adjustments_new = (p_batch#>>'{stats,adjustmentsNew}')::int,
           adjustments_updated = (p_batch#>>'{stats,adjustmentsUpdated}')::int,
           positions_detected = (p_batch#>>'{stats,positionsDetected}')::int, warnings = coalesce(p_batch->'warnings','[]'::jsonb)
     where id = v_run;
  end if;
  return jsonb_build_object('staleInstancesRemoved', v_deleted);
end $$;

-- Only the backend (service role) may run it; browsers can never call it.
revoke all on function public.apply_sync_batch(uuid, jsonb) from public, anon, authenticated;
