-- =====================================================================
-- 0005 — Journal-only close marker, PropReports account cash/unrealized
-- =====================================================================
-- "Close" in the app NEVER sends an order and NEVER changes trading facts. It only records that
-- the user considers the position closed, until PropReports confirms (the sync is authoritative).
-- These columns are user-controlled: apply_sync_batch() never writes them.
alter table public.position_instances add column if not exists journal_close_note text;
alter table public.position_instances add column if not exists journal_closed_at timestamptz;

-- Latest Cash / Unrealized as reported by PropReports' `accounts` action (used to cross-check
-- the reconstructed account value; buying power is not provided by the API).
alter table public.sync_state add column if not exists account_cash numeric(14,4);
alter table public.sync_state add column if not exists account_unrealized numeric(14,4);

-- Name printed on the weekly report (presentation setting).
alter table public.user_settings add column if not exists report_display_name text;
