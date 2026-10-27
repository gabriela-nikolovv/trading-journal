-- Verifies migration 0004: seeded TradingView taxonomy + sector→industry integrity.
-- Run on a database that has migrations 0001–0004 applied.
\set ON_ERROR_STOP on
insert into auth.users (id, email) values ('22222222-2222-2222-2222-222222222222','tax@example.com');
insert into prop_accounts (id, user_id, propreports_account_id) values ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',1);
insert into position_instances (id, prop_account_id, user_id, symbol, direction, status, open_quantity, quantity_traded, avg_entry_price, opened_at)
values ('dddddddd-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','AAPL','long','open',100,100,200,now());

do $$ begin
  assert (select count(*) from sectors) = 20, '20 TradingView sectors';
  assert (select count(*) from industries) = 129, '129 TradingView industries';
  assert (select count(*) from industries i join sectors s on s.id=i.sector_id where s.name='Health Technology') = 5, 'Health Technology has 5 industries';
  -- the spec's own example: Software must not appear under Health Technology
  assert not exists (select 1 from industries i join sectors s on s.id=i.sector_id where s.name='Health Technology' and i.name='Packaged Software'), 'no Software under Health Technology';
end $$;

-- 1. A matching sector + industry is accepted (and is user-controlled data the sync never touches).
update position_instances set
  sector_id   = (select id from sectors where name='Technology Services'),
  industry_id = (select i.id from industries i join sectors s on s.id=i.sector_id where s.name='Technology Services' and i.name='Packaged Software')
where symbol='AAPL';

-- 2. An industry from a DIFFERENT sector is rejected by the database itself.
do $$ begin
  begin
    update position_instances set
      sector_id   = (select id from sectors where name='Health Technology'),
      industry_id = (select i.id from industries i where i.name='Packaged Software')
    where symbol='AAPL';
    raise exception 'mismatched industry/sector should have been rejected';
  exception when foreign_key_violation then null; end;
end $$;

-- 3. An industry with no sector is rejected.
do $$ begin
  begin
    update position_instances set sector_id = null where symbol='AAPL';
    raise exception 'industry without sector should have been rejected';
  exception when check_violation then null; end;
end $$;

-- 4. Clearing both is fine.
update position_instances set sector_id = null, industry_id = null where symbol='AAPL';

-- 5. The classification cache enforces the same pairing.
insert into symbol_classifications (symbol, sector_id, industry_id, status)
select 'AAPL', s.id, i.id, 'ok' from sectors s join industries i on i.sector_id=s.id where s.name='Electronic Technology' and i.name='Telecommunications Equipment';
do $$ begin
  begin
    insert into symbol_classifications (symbol, sector_id, industry_id, status)
    select 'BAD', s.id, i.id, 'ok' from sectors s, industries i where s.name='Finance' and i.name='Semiconductors';
    raise exception 'cross-sector classification should have been rejected';
  exception when foreign_key_violation then null; end;
end $$;

-- 6. Quotes + taxonomy are readable by logged-in users but NOT writable from the browser role.
do $$ begin
  assert not has_table_privilege('authenticated', 'public.market_quotes', 'insert') or
         not exists (select 1 from pg_policies where tablename='market_quotes' and cmd in ('INSERT','ALL')),
         'authenticated must not be able to write market_quotes via RLS';
  assert (select count(*) from pg_policies where tablename in ('market_quotes','symbol_classifications') and cmd='SELECT') = 2, 'read policies present';
end $$;
\echo TAXONOMY TESTS PASSED
