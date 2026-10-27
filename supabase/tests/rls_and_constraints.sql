-- =====================================================================
-- Smoke test: RLS isolation + the constraints the sync engine depends on.
-- Run locally with:
--   createdb tj_test
--   psql -d tj_test -f supabase/tests/local_auth_stub.sql
--   psql -d tj_test -f supabase/migrations/0001_init_schema.sql
--   psql -d tj_test -f supabase/tests/rls_and_constraints.sql
-- Every numbered check below should print the labeled PASS/expected error.
-- =====================================================================

grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'gabi@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'other-user@example.com');

insert into prop_accounts (id, user_id, propreports_account_id, account_code) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 404, 'FPTI000645A404'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 999, 'OTHERACCT');

insert into raw_fills (prop_account_id, user_id, propreports_id, datetime, trade_date, symbol, side, quantity, price) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'PR-1', '2026-08-31T09:30:00Z', '2026-08-31', 'AAPL', 'B', 100, 150.25),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'PR-9', '2026-08-31T09:30:00Z', '2026-08-31', 'MSFT', 'B', 10, 300.00);

-- 1) A logged-in user sees only their own rows.
\echo '[1] as Gabi (user A) — expect exactly her own account + fill'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select account_code from prop_accounts;
select symbol, propreports_id from raw_fills;

\echo '[2] as the other user (user B) — expect exactly their own account + fill'
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select account_code from prop_accounts;
select symbol, propreports_id from raw_fills;

-- 3) A user cannot insert a row claiming to belong to someone else, even
--    though they supplied a valid prop_account_id/user_id pair that exists.
\echo '[3] EXPECTED ERROR — user A inserting a row tagged as user B must be rejected by RLS'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into raw_fills (prop_account_id, user_id, propreports_id, datetime, trade_date, symbol, side, quantity, price)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'PR-HACK', '2026-08-31T09:30:00Z', '2026-08-31', 'HACK', 'B', 1, 1);

reset role;

-- 4) Strong dedup: the same PropReports Id can never be inserted twice.
\echo '[4] EXPECTED ERROR — duplicate PropReports Id must be rejected'
insert into raw_fills (prop_account_id, user_id, propreports_id, datetime, trade_date, symbol, side, quantity, price)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'PR-1', '2026-08-31T09:30:00Z', '2026-08-31', 'AAPL', 'B', 100, 150.25);

-- 5) Fallback dedup: without a PropReports Id, the natural-key fingerprint still blocks a true duplicate.
\echo '[5] EXPECTED ERROR — duplicate natural key with no PropReports Id must be rejected'
insert into raw_fills (prop_account_id, user_id, datetime, trade_date, symbol, side, quantity, price)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '2026-09-01T09:30:00Z', '2026-09-01', 'TSLA', 'B', 5, 200);
insert into raw_fills (prop_account_id, user_id, datetime, trade_date, symbol, side, quantity, price)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '2026-09-01T09:30:00Z', '2026-09-01', 'TSLA', 'B', 5, 200);

\echo '[5b] a genuine twin (explicit occurrence 2) is allowed'
insert into raw_fills (prop_account_id, user_id, datetime, trade_date, symbol, side, quantity, price, occurrence)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '2026-09-01T09:30:00Z', '2026-09-01', 'TSLA', 'B', 5, 200, 2);

-- 6) Only one OPEN position per (account, symbol); any number of closed ones is fine.
\echo '[6] EXPECTED ERROR on the second insert, then a closed AAPL row succeeds'
insert into position_instances (prop_account_id, user_id, symbol, direction, status, open_quantity, opened_at)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'AAPL', 'long', 'open', 100, now());
insert into position_instances (prop_account_id, user_id, symbol, direction, status, open_quantity, opened_at)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'AAPL', 'long', 'open', 50, now());
insert into position_instances (prop_account_id, user_id, symbol, direction, status, open_quantity, opened_at, closed_at)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'AAPL', 'long', 'closed', 0, now(), now());
select symbol, status, open_quantity from position_instances order by status;

-- 7) daily_comments: RLS isolation + one-comment-per-day uniqueness.
\echo '[7] daily comments — Gabi sees her own, user B sees none, duplicate day is rejected'
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into daily_comments (prop_account_id, user_id, trade_date, comment)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '2026-09-01', 'Good breakout on TSLA');
select trade_date, comment from daily_comments;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select trade_date, comment from daily_comments;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
\echo 'EXPECTED ERROR — a second comment on the same account+day must be rejected'
insert into daily_comments (prop_account_id, user_id, trade_date, comment)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '2026-09-01', 'A second comment, same day');
reset role;

