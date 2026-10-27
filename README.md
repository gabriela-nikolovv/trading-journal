# Trading Journal — complete application (schema, engine, sync, market data, website)

**START HERE → `SETUP-GUIDE.md`** (step-by-step, no terminal needed).

This delivery covers four things, all complete and verified:

1. **The full Supabase Postgres schema** (`supabase/migrations/`)
2. **The position reconstruction + P&L engine** (`packages/engine/src/`)
3. **The Weekly Report generator** (data assembly + PDF renderer matching your template)
4. **The Calendar engine** (`packages/engine/src/calendar.js`) — Monday-start
   month grid, schema-switchable daily/weekly totals, per-day comments, and
   the day-detail view, wired directly into the Weekly Report's
   comment-draft suggestion.

Nothing here talks to Supabase, PropReports, or Yahoo Finance yet — that's
the sync engine, still to come. Everything below was actually run and
verified in this environment.

## What was verified, and how

**Schema**: installed real PostgreSQL 16 locally, ran both migrations
(`0001_init_schema.sql`, then `0002_daily_comments.sql`) against it
end-to-end with no errors, then ran `supabase/tests/rls_and_constraints.sql`
— proving per-user RLS isolation, blocked cross-user inserts, duplicate
rejection (both the strong PropReports-Id key and the fingerprint
fallback), the one-open-position-per-symbol constraint, and (new) that
`daily_comments` is per-user and allows only one comment per account/day.

Run it yourself: `createdb tj_test && psql -d tj_test -f supabase/tests/local_auth_stub.sql && psql -d tj_test -f supabase/migrations/0001_init_schema.sql && psql -d tj_test -f supabase/migrations/0002_daily_comments.sql && psql -d tj_test -f supabase/tests/rls_and_constraints.sql`.

**Engine**: `cd packages/engine && npm install && npm test` — 69 tests.
The Calendar tests anchor to reality wherever possible: `buildMonthGrid`'s
September-2026 output is checked against what you told us directly ("Tuesday
is 1st September" → the week must start Monday Aug 31), and the weekly
rollup for that week reproduces the real $41.56 from your report exactly.
A dedicated integration test proves the full loop you asked for: daily
comments on Calendar days → `buildWeeklyCommentDraft` → the exact suggested
text the Weekly Report's comment prompt would show.

**Visual fidelity** (Weekly Report PDF): the supplied template was
rasterized at 200dpi and color-sampled pixel-by-pixel, then compared side
by side with the generated output — full details unchanged from before, see
`packages/engine/src/weeklyReportPdf.js`'s header comment.

## What Phase 3 (Calendar) actually built

- **`daily_comments` table** (`0002_daily_comments.sql`) — a new
  user-controlled table, deliberately separate from `daily_account_snapshots`
  (which sync recomputes), so a resync can never touch a comment you wrote.
  One comment per account per day, RLS-scoped like everything else.
- **`buildMonthGrid(year, month)`** — pure calendar math for a Monday-start
  grid, including the leading/trailing days from adjacent months needed to
  complete each week row.
- **`computeSchema2DailyDeltas(days, pct)`** — Schema 2 has no natural
  per-day value (profit share is a once-a-month lump sum). This allocates
  the month's deduction onto the last day that has data; every other day
  shows its pre-share Schema 1 number. Summed across the month, the result
  reproduces the exact monthly Schema 2 total — tested against the
  $1000/50%/$500 worked example.
- **`buildCalendarMonth(...)`** — combines the grid with daily snapshot data
  and the selected schema into what the Calendar tab renders: per-day cells
  (delta, whether it traded, its comment) plus a weekly total that always
  uses the currently selected schema, never a mix.
- **`assembleDayDetail(...)`** — the "tap a day" view: symbols traded,
  direction, realized P&L, open/closed status, and that day's comment. It
  formats trade summaries it's given rather than re-deriving them —
  `positionEngine.js` remains the single source of truth for trading facts.
- **`weekDaysToCommentInput` + `dayLabelForDate`** — the actual bridge that
  turns a week's Calendar day-comments into the exact input
  `buildWeeklyCommentDraft` (built in Phase 2) needs, closing the loop you
  asked for: write comments on individual days, then have the Weekly Report
  suggest a draft built from them before you generate the PDF.

## Key architecture decisions made while building this

- **Signed-quantity ledger, not fill-type branching.** Every fill collapses
  to a signed quantity (B/C → +, S/T → −); the whole position — including
  reversals — falls out of the running signed total.

- **Fees live in two places, and both must be read.** `raw_fills`' own fee
  columns, and separately the `adjustments` endpoint's Fee-type categories
  (Market Data, Platform) — almost certainly why the previous build missed
  Platform fees.

- **BAT and W/L Ratio are PropReports-native, not derived** — confirmed by
  you; `weeklyReport.js` treats them as required pass-through input rather
  than a guessed formula.

- **Two different jobs need two different P&L sources**, noted for the sync
  engine: the fills ledger for live open-position state, PropReports'
  `positions` endpoint (which already returns daily Unrealized Delta) for
  historical daily P&L.

- **Schema 2 is fundamentally monthly, not daily** — rather than pretending
  it has a per-day value, the Calendar allocates the real once-a-month
  deduction onto the day it actually happens, and is explicit about that in
  code comments rather than quietly approximating.

- **DATABASE TRUTH vs. REPORT PRESENTATION EDITS, kept structurally
  separate** — `assembleWeeklyReportData` produces computed truth,
  `applyManualOverrides` layers pre-export edits without mutating it.

- **Real font embedding, not the default fonts** — pdf-lib's built-in fonts
  can't render "Δ"; fixed via a properly licensed embedded TTF.

- **RLS pattern**: every table carries `user_id` directly so every policy is
  a simple `auth.uid() = user_id` — verified against a real database, not
  just inspected.

## Honestly flagged, not swept under the rug

- **Max Drawdown**: confirmed correct at $8.68 — the template's $8.64 was a
  manual transcription mistake on the source report, not a formula bug.
- **Realized Net, BAT, W/L Ratio**: PropReports-native figures, not
  something this engine computes — still need to confirm whether the API v2
  exposes them directly before the sync engine can populate them for real.
- **Schema 2 in the Calendar** assumes the profit-share % in effect doesn't
  change mid-month — a reasonable assumption given profit share is
  calculated at month-end, but worth keeping in mind if the % is ever
  changed retroactively mid-month in Settings.

## What's NOT built yet

The sync engine (Edge Functions calling PropReports + Yahoo Finance), the
CSV→DB write path, the reconciliation job, and the frontend are all still
ahead. The Calendar and Weekly Report engines are ready to be wired to real
data as soon as the sync engine exists.

## Layout

```
supabase/
  migrations/0001_init_schema.sql      the core schema
  migrations/0002_daily_comments.sql   Calendar day-comments table
  tests/local_auth_stub.sql            dev-only Supabase auth stub
  tests/rls_and_constraints.sql        RLS + dedup + one-open-position + daily-comment proofs
packages/engine/
  assets/fonts/           Liberation Sans (+ license) embedded into PDFs
  examples/generate-sample-report.mjs   npm run generate:sample
  src/
    money.js, csv.js, normalize.js, dedupe.js       shared building blocks
    positionEngine.js      the ledger reconstruction algorithm
    pnlSchemas.js           Schema 1 / 2 / 3 + monthly profit share
    currentR.js             Current R with stop-loss validation
    reportTotals.js         Weekly Report automatic fields
    format.js               template-exact display formatting
    weeklyReport.js          report data assembly + comment draft + overrides
    weeklyReportPdf.js       the PDF renderer
    calendar.js              month grid + schema-switchable rollups + day detail
  test/                   69 tests, incl. your real week as a fixture
  out/sample-weekly-report.pdf   generated sample (also attached separately)
```




## Phase 4 — Sync engine (added)

**Built and tested here (95 engine tests + two SQL suites, real Postgres 16):**
- `propreportsClient.js` — API v2 client: form-encoded POST, token only in the body, `Page N/M` trailer pagination, 40-req/4s limiter, retry on 5xx/network, token redaction on every error path, opt-in columns (`propReportsId`, `fillId`, `currency`, `multiplier`) requested explicitly.
- `syncPlanner.js` — full history (from the account's *First Traded* date, month windows) vs incremental (cursor − 7-day lookback so replaced/removed records are noticed).
- `syncEngine.js` — fetch everything first, diff against stored rows (PropReports Id → replacement detection → fingerprint fallback with occurrence index so genuine twin fills survive), rebuild positions in memory, then ONE atomic commit. Any failure leaves the last good data untouched and records a friendly error. Fails loudly on unexpected CSV columns instead of importing zeros; flags unknown adjustment categories.
- `tradeStats.js` — BAT / W-L / Avg Hold / biggest winner-loser using PropReports' published Trade Performance definitions (see below).
- `0003_sync_commit.sql` — `apply_sync_batch()`: single-transaction commit that upserts position **API columns only** — Stop Loss, sector, industry and notes are never touched. Not callable by `anon`/`authenticated`. `supabase/tests/sync_commit.sql` proves it using genuine engine output (`gen_sync_batches.mjs`): Stop Loss + notes survive a growing position and a full close, replaced fills are superseded not deleted, a failed batch leaves zero partial rows, replays are rejected.

**Written but NOT yet run (needs your Supabase project):** `supabase/functions/sync/index.ts`, `supabase/functions/_shared/supabaseStore.ts`. Run `scripts/copy-engine-to-functions.sh` before `supabase functions deploy sync`.

**Known limits / first-live-run checklist**
1. `adjustments` CSV columns are not visible in the public docs excerpt I could read (page truncated); the parser expects `Date`, `Category`, `Amount`, `Description`. If your real export differs, the sync fails with a clear message listing the columns received — send me that and I adjust.
2. A full-history first sync could exceed the Edge Function time limit on a long history; if so, the fix is to process a few windows per call (the planner already produces independent windows).
3. PropReports token is a Supabase secret (`PROPREPORTS_URL` optional). The in-app "enter your token" screen is not built.
4. **Realized Net** (the $8.59 on your report) is still unexplained: winner 23.18 − loser 0.04 ≠ 8.59. It needs real fills/positions output to pin down. BAT, W/L and Avg Hold are computable (definitions published by PropReports).


## Phase 5 — Market prices (Yahoo) and TradingView sectors (added)

**Built and tested here (126 engine tests; SQL suites for sync, taxonomy, RLS all pass on Postgres 16):**
- `marketData.js` — `QuoteProvider` interface + Yahoo Finance provider + caching quote service. Never fabricates a price; rejects Yahoo answering with a different symbol; a closed market returns the last price labelled with its real timestamp/session; if the live call fails it falls back to the stored last-known price **marked stale** (or says unavailable). Swap providers by implementing `fetchQuote(symbol)`.
- `positionAnalytics.js` — per position: market value (qty × price × multiplier), unrealized P&L, P&L %, Current R (via the tested `computeCurrentR`), risk to stop, potential loss to stop; portfolio: long/short/total/net exposure, by symbol / sector / industry, total risk, missing/invalid-stop lists. Risk % of account is withheld when account value is not positive.
- `taxonomy.js` + migration `0004` — TradingView's 20 sectors / 129 industries, seeded in the database (generated from the JS by `scripts/gen-taxonomy-migration.mjs` so they cannot drift). The database itself rejects an industry that does not belong to the chosen sector (composite key) and an industry with no sector. TradingView scanner lookup maps onto the taxonomy; anything that does not map exactly is `unmapped` for you to pick manually, never forced.
- Edge Function `supabase/functions/market` (`positions`, `quotes`, `classify`).

**Honest limits**
1. **Not run live.** The sandbox cannot reach Yahoo Finance or TradingView. Yahoo's chart endpoint and TradingView's scanner are *unofficial* (no key, no SLA, can change). The parsers are tested on fixtures shaped like their documented/observed responses, not on captured live responses.
2. **Taxonomy provenance.** 100 of the 129 industries were read directly from TradingView's US Industries page (or its other-market tables); the other 29 were below that page's first screen, so their names were filled in from knowledge and checked against TradingView's published per-sector industry counts (all 20 sectors match). Eyeball those 23 names once: they are listed under `recalled` in `taxonomy.js`.
3. Current Positions needs account value for "risk % of account"; account snapshots are not synced yet, so that figure is blank for now.


## Phase 6 — Website (added)

`web/` is a dependency-free static site (plain ES modules, no build step) published by GitHub Pages:
login → first-time setup → Dashboard · Current Positions · Calendar · Trades · Weekly Report · Settings, with a SYNC NOW bar on every page and an automatic sync every time it opens.
It runs the *same* tested engine modules in the browser (copied in by `scripts/copy-engine-to-web.sh` during deploy). PDF generation happens in the browser with pdf-lib.

Also new in this phase: `dailySnapshots.js` (daily numbers from PropReports `positions` + `adjustments`, reproducing the real week incl. the −50.95 month-start fee gap), `statistics.js`, `schemaSeries.js`, `weekBuilder.js`, migration `0005`, and the two GitHub workflows (`.github/workflows`, copies in `github-workflows/`).

**Tests:** `cd packages/engine && npm ci && node --test` (engine, 143) · `cd web && npm ci && npm test` (website in jsdom, 24) · SQL suites in `supabase/tests/` (need Postgres 16).
Edge Functions were type-checked with Deno 2; the browser/PDF path was exercised with the real pdf-lib and fonts.
