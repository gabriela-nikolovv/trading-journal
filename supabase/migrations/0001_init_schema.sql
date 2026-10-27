-- =====================================================================
-- Trading Journal — Initial Schema
-- =====================================================================
-- Design principles (see project spec):
--   A. RAW TRADING FACTS      -> raw_fills, raw_adjustments (from PropReports, never edited by users)
--   B. DERIVED INFORMATION    -> position_instances, daily_account_snapshots,
--                                monthly_profit_share (computed by the engine, safe to recompute)
--   C. USER-MANAGED METADATA  -> stop_loss / sector / industry / notes on position_instances,
--                                weekly_reports.weekly_comment + manual_overrides
--                                (sync must NEVER overwrite these)
--
-- Every table carries user_id directly (denormalized) so RLS policies are a
-- simple `auth.uid() = user_id` check with no joins/subqueries needed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PROP ACCOUNTS
-- ---------------------------------------------------------------------
create table if not exists public.prop_accounts (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  prop_firm                 text not null default 'Alaric',
  platform                  text not null default 'Hammer Pro',
  propreports_account_id    integer not null,           -- numeric "Account Id" from the `accounts` action
  propreports_account_name  text,                        -- "Account" display name
  account_code              text,                        -- e.g. FPTI000645A404
  currency                  text not null default 'USD',
  is_active                 boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (user_id, propreports_account_id)
);

-- ---------------------------------------------------------------------
-- 2. USER SETTINGS  +  PROFIT SHARE SCHEDULE (configurable, never hard-coded)
-- ---------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  market_data_provider    text not null default 'yahoo_finance',
  tradingview_taxonomy_ok boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Historical schedule so a % change never rewrites past months' results.
create table if not exists public.profit_share_schedule (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  pct             numeric(6,3) not null check (pct >= 0 and pct <= 100),
  effective_from  date not null,                  -- first calendar month this % applies to
  created_at      timestamptz not null default now(),
  unique (user_id, effective_from)
);

-- ---------------------------------------------------------------------
-- 3. SYNCHRONIZATION STATE + HISTORY
-- ---------------------------------------------------------------------
create table if not exists public.sync_state (
  prop_account_id       uuid primary key references public.prop_accounts(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  status                text not null default 'idle' check (status in ('idle','running','failed')),
  last_run_started_at   timestamptz,
  last_success_at       timestamptz,
  last_error            text,
  fills_cursor_date     date,          -- last `Trade Date` fully synced (fills)
  adjustments_cursor_date date,        -- last date fully synced (adjustments)
  updated_at            timestamptz not null default now()
);

create table if not exists public.sync_runs (
  id                    uuid primary key default gen_random_uuid(),
  prop_account_id       uuid not null references public.prop_accounts(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  status                text not null default 'running' check (status in ('running','success','failed')),
  is_full_history       boolean not null default false,
  fills_fetched         integer not null default 0,
  fills_new             integer not null default 0,
  fills_updated         integer not null default 0,   -- replaced records (new PropReports Id)
  adjustments_fetched   integer not null default 0,
  adjustments_new       integer not null default 0,
  adjustments_updated   integer not null default 0,
  positions_detected    integer not null default 0,
  warnings              jsonb not null default '[]'::jsonb,
  error_message         text
);
create index if not exists idx_sync_runs_account on public.sync_runs (prop_account_id, started_at desc);

-- ---------------------------------------------------------------------
-- 4. RAW TRADING FACTS — FILLS  (source of truth: PropReports `fills` action)
-- ---------------------------------------------------------------------
create table if not exists public.raw_fills (
  id                uuid primary key default gen_random_uuid(),
  prop_account_id   uuid not null references public.prop_accounts(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,

  propreports_id    text,             -- `PropReports Id` optionalField — detects replaced records
  fill_id           text,             -- `fillId` optionalField
  order_id          text,             -- `Order Id`
  datetime          timestamptz not null,   -- `Date/Time`
  trade_date        date not null,          -- `Trade Date`
  symbol            text not null,
  side              text not null check (side in ('B','S','T','C')), -- Buy/Sell/Short/Cover
  quantity          numeric(18,6) not null,
  price             numeric(18,6) not null,
  route             text,
  status            text,             -- may include NC / MF suffixes (superuser only)

  -- fee columns exactly as documented in the Fills CSV response
  comm              numeric(14,4) not null default 0,
  ecn_fee           numeric(14,4) not null default 0,
  sec_fee           numeric(14,4) not null default 0,
  taf_fee           numeric(14,4) not null default 0,
  nscc_fee          numeric(14,4) not null default 0,
  clr_fee           numeric(14,4) not null default 0,
  misc_fee          numeric(14,4) not null default 0,

  currency          text default 'USD',
  multiplier        numeric(14,6) default 1,

  is_superseded     boolean not null default false,  -- true once a corrected record replaces it
  superseded_by     uuid references public.raw_fills(id),
  raw_json          jsonb not null default '{}'::jsonb,  -- full original row, for audit / future fields

  synced_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Strongest identifier first; partial index because propreports_id can be null.
create unique index if not exists uq_raw_fills_propreports_id
  on public.raw_fills (prop_account_id, propreports_id)
  where propreports_id is not null;

-- Fallback natural-key fingerprint for dedup when PropReports Id is unavailable.
create unique index if not exists uq_raw_fills_fingerprint
  on public.raw_fills (prop_account_id, symbol, datetime, side, quantity, price, coalesce(order_id, ''))
  where propreports_id is null and is_superseded = false;

create index if not exists idx_raw_fills_account_date on public.raw_fills (prop_account_id, trade_date);
create index if not exists idx_raw_fills_account_symbol on public.raw_fills (prop_account_id, symbol);

-- ---------------------------------------------------------------------
-- 5. RAW TRADING FACTS — ADJUSTMENTS  (fees/transfers that never appear in fills)
-- ---------------------------------------------------------------------
create table if not exists public.adjustment_categories (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  name                text not null,                     -- exact PropReports category name, e.g. "Market Data"
  category_type       text not null check (category_type in ('fee','transfer')),
  -- fee  -> included in Schema 1 & 2, excluded from Schema 3
  -- transfer -> cash movement only; excluded from ALL P&L schemas, still affects account value
  notes               text,
  created_at          timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.raw_adjustments (
  id                uuid primary key default gen_random_uuid(),
  prop_account_id   uuid not null references public.prop_accounts(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,

  propreports_id    text,
  adjustment_date   date not null,
  category_name     text not null,      -- raw category name as returned by PropReports
  category_id       uuid references public.adjustment_categories(id),
  amount            numeric(14,4) not null,   -- signed: negative = debit to this account
  description       text,

  is_superseded     boolean not null default false,
  superseded_by     uuid references public.raw_adjustments(id),
  raw_json          jsonb not null default '{}'::jsonb,

  synced_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists uq_raw_adjustments_propreports_id
  on public.raw_adjustments (prop_account_id, propreports_id)
  where propreports_id is not null;

create index if not exists idx_raw_adjustments_account_date on public.raw_adjustments (prop_account_id, adjustment_date);

-- ---------------------------------------------------------------------
-- 6. SECTOR / INDUSTRY TAXONOMY (TradingView-aligned)
-- ---------------------------------------------------------------------
create table if not exists public.sectors (
  id    uuid primary key default gen_random_uuid(),
  name  text not null unique
);

create table if not exists public.industries (
  id         uuid primary key default gen_random_uuid(),
  sector_id  uuid not null references public.sectors(id) on delete cascade,
  name       text not null,
  unique (sector_id, name)
);

-- ---------------------------------------------------------------------
-- 7. DERIVED — POSITION INSTANCES (open + closed, one continuous lifecycle each)
-- ---------------------------------------------------------------------
create table if not exists public.position_instances (
  id                  uuid primary key default gen_random_uuid(),
  prop_account_id     uuid not null references public.prop_accounts(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,

  symbol              text not null,
  direction           text not null check (direction in ('long','short')),
  status              text not null check (status in ('open','closed')),

  -- API-controlled (recomputed by the engine every sync — never hand-edited)
  open_quantity       numeric(18,6) not null default 0,
  quantity_traded      numeric(18,6) not null default 0,   -- total opening quantity across this instance
  avg_entry_price     numeric(18,6),
  avg_exit_price      numeric(18,6),
  realized_pnl        numeric(14,4) not null default 0,    -- pure trading realized P&L (Schema-3 basis)
  fees_allocated      numeric(14,4) not null default 0,    -- fill-level fees tied to this instance
  currency            text default 'USD',
  multiplier          numeric(14,6) default 1,

  opened_at           timestamptz not null,
  closed_at           timestamptz,

  -- USER-CONTROLLED — synchronization must never overwrite these
  stop_loss           numeric(18,6),
  sector_id           uuid references public.sectors(id),
  industry_id         uuid references public.industries(id),
  notes               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_positions_account_status on public.position_instances (prop_account_id, status);
create index if not exists idx_positions_account_symbol on public.position_instances (prop_account_id, symbol);

-- Only one OPEN instance per (account, symbol) at a time.
create unique index if not exists uq_one_open_position_per_symbol
  on public.position_instances (prop_account_id, symbol)
  where status = 'open';

-- Traceability: which fills make up which position instance, and the running state after each.
create table if not exists public.position_fills (
  id                    uuid primary key default gen_random_uuid(),
  position_instance_id  uuid not null references public.position_instances(id) on delete cascade,
  raw_fill_id           uuid not null references public.raw_fills(id) on delete cascade,
  running_quantity_after numeric(18,6) not null,
  running_avg_cost_after numeric(18,6),
  unique (position_instance_id, raw_fill_id)
);

-- Audit trail of manual metadata edits (never overwritten by sync, but we log the history).
create table if not exists public.position_metadata_audit (
  id                    uuid primary key default gen_random_uuid(),
  position_instance_id  uuid not null references public.position_instances(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  field                 text not null,      -- 'stop_loss' | 'sector_id' | 'industry_id' | 'notes'
  old_value             text,
  new_value             text,
  changed_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 8. DERIVED — DAILY ACCOUNT SNAPSHOTS (backs Calendar + Weekly Report)
-- ---------------------------------------------------------------------
create table if not exists public.daily_account_snapshots (
  id                        uuid primary key default gen_random_uuid(),
  prop_account_id           uuid not null references public.prop_accounts(id) on delete cascade,
  user_id                   uuid not null references auth.users(id) on delete cascade,
  trade_date                date not null,

  -- Schema 1 (report total: trading + all fees/adjustments), Schema 3 (pure trading) daily deltas
  schema1_delta             numeric(14,4) not null default 0,
  schema3_delta             numeric(14,4) not null default 0,

  -- Fee/adjustment split for transparency
  commissions               numeric(14,4) not null default 0,
  market_data_fees          numeric(14,4) not null default 0,
  platform_fees             numeric(14,4) not null default 0,
  other_fees                numeric(14,4) not null default 0,
  transfers                 numeric(14,4) not null default 0,   -- cash movement, not P&L

  account_value             numeric(14,4),        -- closing account value for the day
  realized_net              numeric(14,4) not null default 0,
  quantity_traded           numeric(18,6) not null default 0,

  is_month_boundary_fee_day boolean not null default false,
  month_boundary_fee_amount numeric(14,4) not null default 0,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (prop_account_id, trade_date)
);
create index if not exists idx_daily_snapshots_account_date on public.daily_account_snapshots (prop_account_id, trade_date);

-- ---------------------------------------------------------------------
-- 9. DERIVED — MONTHLY PROFIT SHARE (Schema 2 basis; computed once, persisted)
-- ---------------------------------------------------------------------
create table if not exists public.monthly_profit_share (
  id                        uuid primary key default gen_random_uuid(),
  prop_account_id           uuid not null references public.prop_accounts(id) on delete cascade,
  user_id                   uuid not null references auth.users(id) on delete cascade,
  month_start               date not null,             -- first day of the calendar month
  schema1_monthly_total     numeric(14,4) not null,
  qualifies                 boolean not null,           -- true only if schema1_monthly_total > 0
  pct_applied               numeric(6,3) not null,
  prop_firm_share           numeric(14,4) not null default 0,
  user_share                numeric(14,4) not null,     -- = schema1_monthly_total if not qualifying
  is_finalized              boolean not null default false,  -- true once the month has fully closed
  calculated_at             timestamptz not null default now(),
  unique (prop_account_id, month_start)
);

-- ---------------------------------------------------------------------
-- 10. WEEKLY REPORTS (presentation layer — never mutates trading data)
-- ---------------------------------------------------------------------
create table if not exists public.weekly_reports (
  id                uuid primary key default gen_random_uuid(),
  prop_account_id   uuid not null references public.prop_accounts(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  week_start_date   date not null,   -- Monday
  week_end_date     date not null,   -- Friday

  computed_data     jsonb not null,           -- full computed snapshot at generation time (DATABASE TRUTH)
  weekly_comment    text,
  manual_overrides  jsonb not null default '{}'::jsonb,  -- REPORT PRESENTATION EDITS only

  status            text not null default 'draft' check (status in ('draft','finalized')),
  generated_at      timestamptz not null default now(),
  finalized_at      timestamptz,
  pdf_generated_at  timestamptz,

  unique (prop_account_id, week_start_date)
);

-- ---------------------------------------------------------------------
-- 11. RECONCILIATION LOG
-- ---------------------------------------------------------------------
create table if not exists public.reconciliation_log (
  id                uuid primary key default gen_random_uuid(),
  prop_account_id   uuid not null references public.prop_accounts(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  check_type        text not null,   -- e.g. 'schema1_vs_propreports_total', 'duplicate_fill', 'qty_mismatch'
  period_label      text,            -- e.g. a date or week label the check covers
  expected_value    numeric(14,4),
  actual_value      numeric(14,4),
  difference        numeric(14,4),
  severity          text not null default 'warning' check (severity in ('info','warning','error')),
  details           jsonb not null default '{}'::jsonb,
  resolved          boolean not null default false,
  created_at        timestamptz not null default now()
);
create index if not exists idx_reconciliation_account on public.reconciliation_log (prop_account_id, created_at desc);

-- ---------------------------------------------------------------------
-- 12. MARKET PRICE CACHE (provider-agnostic)
-- ---------------------------------------------------------------------
create table if not exists public.market_price_cache (
  symbol      text primary key,
  price       numeric(18,6),
  currency    text default 'USD',
  source      text not null default 'yahoo_finance',
  as_of       timestamptz not null,
  is_stale    boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- =====================================================================
-- ROW LEVEL SECURITY — every table scoped to auth.uid() = user_id
-- =====================================================================
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'prop_accounts','user_settings','profit_share_schedule','sync_state','sync_runs',
      'raw_fills','adjustment_categories','raw_adjustments','position_instances',
      'position_metadata_audit','daily_account_snapshots','monthly_profit_share',
      'weekly_reports','reconciliation_log'
    ])
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format(
      'create policy %I on public.%I for all using (auth.uid() = user_id) with check (auth.uid() = user_id);',
      t || '_owner_policy', t
    );
  end loop;
end $$;

-- position_fills has no direct user_id column; scope via its parent position_instance.
alter table public.position_fills enable row level security;
create policy position_fills_owner_policy on public.position_fills
  for all using (
    exists (
      select 1 from public.position_instances pi
      where pi.id = position_fills.position_instance_id and pi.user_id = auth.uid()
    )
  );

-- sectors / industries are shared reference data, readable by any authenticated user.
alter table public.sectors enable row level security;
alter table public.industries enable row level security;
create policy sectors_read_all on public.sectors for select using (auth.role() = 'authenticated');
create policy industries_read_all on public.industries for select using (auth.role() = 'authenticated');

-- market_price_cache is shared, provider-fetched data — readable by any authenticated user,
-- writes only via the backend (service role bypasses RLS in Edge Functions).
alter table public.market_price_cache enable row level security;
create policy market_price_cache_read_all on public.market_price_cache for select using (auth.role() = 'authenticated');
