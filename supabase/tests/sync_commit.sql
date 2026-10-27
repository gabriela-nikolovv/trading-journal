-- Verifies apply_sync_batch() with REAL engine output (run gen_sync_batches.mjs first).
-- Run: psql -d tj_test -v ON_ERROR_STOP=1 -v dir=$(pwd)/supabase/tests/out -f supabase/tests/sync_commit.sql
\set ON_ERROR_STOP on
\set b1 `cat :dir/batch1.json`
\set b2 `cat :dir/batch2.json`
\set b3 `cat :dir/batch3.json`

insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111','t@example.com');
insert into prop_accounts (id, user_id, propreports_account_id) values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',348);
insert into sync_state (prop_account_id, user_id, status) values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','running');

-- psql variables are not expanded inside DO $$ blocks, so stash the batches in a table the blocks can read.
create temp table batches as select :'b1'::jsonb as b1, :'b3'::jsonb as b3;

-- ===== sync 1: initial =====
insert into sync_runs (id, prop_account_id, user_id) values ((:'b1'::jsonb->>'runId')::uuid, 'aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111');
select apply_sync_batch('aaaaaaaa-0000-0000-0000-000000000001', :'b1'::jsonb);
do $$ begin
  assert (select count(*) from raw_fills where not is_superseded) = 4, 'sync1: 4 fills';
  assert (select count(*) from raw_adjustments where category_type = 'fee') = 2, 'sync1: platform + market data fee adjustments stored as fees';
  assert (select sum(amount) from raw_adjustments) = -50.95, 'sync1: the Sep 1 fee gap (-50.95) is present';
  assert (select open_quantity from position_instances where symbol='AAPL' and status='open') = 100, 'sync1: AAPL open 100';
  assert (select count(*) from position_fills) >= 4, 'sync1: position->fill traceability rows';
  assert (select status from sync_state) = 'idle', 'sync1: sync_state idle';
  assert (select count(*) from daily_account_snapshots) = 3, 'sync1: 3 snapshot days (09-01 fees, 09-03, 09-04)';
  assert (select schema1_delta from daily_account_snapshots where trade_date='2026-09-01') = -50.95, 'sync1: Sep 1 schema1 = the monthly fee adjustments';
  assert (select schema3_delta from daily_account_snapshots where trade_date='2026-09-01') = 0, 'sync1: schema3 excludes the fees';
  assert (select account_value from daily_account_snapshots where trade_date='2026-09-04') = -35.95, 'sync1: account value chains through the fee day';
  assert (select account_cash from sync_state) = -40.95, 'sync1: PropReports cash stored';
end $$;

-- user sets Stop Loss / notes / sector metadata
update position_instances set stop_loss = 190, notes = 'swing entry' where symbol = 'AAPL';

-- ===== sync 2: AAPL grows, P3 replaced upstream =====
insert into sync_runs (id, prop_account_id, user_id) values ((:'b2'::jsonb->>'runId')::uuid, 'aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111');
select apply_sync_batch('aaaaaaaa-0000-0000-0000-000000000001', :'b2'::jsonb);
do $$ begin
  assert (select count(*) from raw_fills where is_superseded) = 1, 'sync2: replaced fill superseded, not deleted';
  assert (select count(*) from raw_fills where not is_superseded) = 5, 'sync2: 5 active fills (no double count)';
  assert (select open_quantity from position_instances where symbol='AAPL' and status='open') = 120, 'sync2: AAPL open 120';
  assert (select stop_loss from position_instances where symbol='AAPL' and status='open') = 190, 'sync2: STOP LOSS SURVIVED the sync';
  assert (select notes from position_instances where symbol='AAPL' and status='open') = 'swing entry', 'sync2: notes survived';
  assert (select count(*) from position_instances where symbol='AAPL') = 1, 'sync2: same instance updated, not duplicated';
end $$;

do $$ begin
  assert (select count(*) from daily_account_snapshots) = 3, 'sync2: snapshots upserted, not duplicated';
end $$;

-- the user-controlled journal-close marker must also survive a sync
update position_instances set journal_close_note = 'planned exit', journal_closed_at = now() where symbol='AAPL';

-- ===== sync 3: AAPL fully closed =====
insert into sync_runs (id, prop_account_id, user_id) values ((:'b3'::jsonb->>'runId')::uuid, 'aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111');
select apply_sync_batch('aaaaaaaa-0000-0000-0000-000000000001', :'b3'::jsonb);
do $$ begin
  assert (select status from position_instances where symbol='AAPL') = 'closed', 'sync3: AAPL closed';
  assert (select stop_loss from position_instances where symbol='AAPL') = 190, 'sync3: closed position keeps its historical stop loss';
  assert (select closed_at is not null from position_instances where symbol='AAPL'), 'sync3: closed_at set';
  assert (select journal_close_note from position_instances where symbol='AAPL') = 'planned exit', 'sync3: journal-close note survived the sync';
end $$;

do $$ begin
  assert (select count(*) from sync_runs where status='success') = 3, 'all 3 sync runs recorded as success';
  assert (select fills_new from sync_runs order by started_at limit 1) = 4, 'run 1 recorded 4 new fills';
  assert (select count(*) from sync_runs where fills_updated = 1) = 1, 'run 2 recorded 1 replaced fill';
end $$;

-- ===== replay of the same batch must not duplicate =====
-- (the engine would classify these as no_op; here we prove the DB itself refuses duplicate PropReports Ids)
do $$ begin
  begin
    perform apply_sync_batch('aaaaaaaa-0000-0000-0000-000000000001', (select b1 from batches));
    raise exception 'replay should have been rejected';
  exception when unique_violation then null; end;
  assert (select count(*) from raw_fills where not is_superseded) = 6, 'replay rolled back: still 6 active fills';
end $$;

-- ===== atomicity: a batch that fails midway leaves NOTHING behind =====
do $$
declare before_n int; bad jsonb;
begin
  select count(*) into before_n from raw_fills;
  bad := jsonb_set((select b3 from batches), '{fills,inserts}',
    '[{"id":"cccccccc-0000-0000-0000-000000000001","fingerprint":"x#1","record":{"propreportsId":"OK1","datetimeIso":"2026-09-12 10:00:00.000","tradeDate":"2026-09-12","symbol":"ZZZ","side":"B","quantity":1,"price":1,"comm":0,"ecnFee":0,"secFee":0,"tafFee":0,"nsccFee":0,"clrFee":0,"miscFee":0}},
      {"id":"cccccccc-0000-0000-0000-000000000002","fingerprint":"x#2","record":{"propreportsId":"BAD","datetimeIso":"NOT A DATE","tradeDate":"2026-09-12","symbol":"ZZZ","side":"B","quantity":1,"price":1,"comm":0,"ecnFee":0,"secFee":0,"tafFee":0,"nsccFee":0,"clrFee":0,"miscFee":0}}]'::jsonb);
  begin
    perform apply_sync_batch('aaaaaaaa-0000-0000-0000-000000000001', bad);
    raise exception 'bad batch should have failed';
  exception when others then
    if sqlerrm like 'bad batch should%' then raise; end if;
  end;
  assert (select count(*) from raw_fills) = before_n, 'atomicity: no partial rows from the failed batch';
end $$;

-- ===== the browser roles can NOT call the commit function =====
do $$ begin
  assert not has_function_privilege('authenticated', 'public.apply_sync_batch(uuid,jsonb)', 'execute'), 'authenticated must not execute apply_sync_batch';
  assert not has_function_privilege('anon', 'public.apply_sync_batch(uuid,jsonb)', 'execute'), 'anon must not execute apply_sync_batch';
end $$;
\echo SYNC COMMIT TESTS PASSED
