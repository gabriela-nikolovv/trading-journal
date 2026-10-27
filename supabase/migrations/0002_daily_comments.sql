-- =====================================================================
-- Daily comments — Calendar tab (spec section 20 + mid-build addition)
-- =====================================================================
-- USER-MANAGED METADATA (category C, see 0001's header comment): a
-- comment a person leaves on a specific trading day when they tap it in
-- the Calendar. Kept in its own table, separate from daily_account_snapshots
-- (which sync recomputes on every resync), so a resync can NEVER touch it —
-- same principle as Stop Loss surviving a position resync.
--
-- This also feeds the Weekly Report workflow: when prompting for that
-- week's comment, the app pre-fills a draft assembled from that week's
-- daily_comments rows (see packages/engine/src/weeklyReport.js's
-- buildWeeklyCommentDraft), which the user can then edit.
-- =====================================================================

create table if not exists public.daily_comments (
  id                uuid primary key default gen_random_uuid(),
  prop_account_id   uuid not null references public.prop_accounts(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  trade_date        date not null,
  comment           text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (prop_account_id, trade_date)
);

create index if not exists idx_daily_comments_account_date on public.daily_comments (prop_account_id, trade_date);

alter table public.daily_comments enable row level security;
create policy daily_comments_owner_policy on public.daily_comments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
