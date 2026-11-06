-- 0008 — Trading rules shown on the home page (the "Trading Journal" logo).
-- User-written content only: the PropReports sync never reads or writes this table.
create table if not exists public.trading_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body        text not null check (length(btrim(body)) > 0),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_trading_rules_user_position on public.trading_rules (user_id, position);

alter table public.trading_rules enable row level security;
drop policy if exists trading_rules_owner_policy on public.trading_rules;
create policy trading_rules_owner_policy on public.trading_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.trading_rules to authenticated;
