# Trading Journal — Where to find what, and where to fix it

Based on reading `trading-journal-fixed.zip` (folder `trading-journal-main`). I read the code but did **not** run the test suite or the live app, so the "things to check" in section 6 are things I spotted in the code, not confirmed bugs.

---

## 1. The three rules that save you the most time

1. **Edit logic only in `packages/engine/src/`.** The website and the server functions use *copies* of those files that are generated automatically:
   - `web/js/engine/*` is copied by `scripts/copy-engine-to-web.sh` (runs in the *Deploy website* workflow).
   - `supabase/functions/_shared/engine/*` is copied by `scripts/copy-engine-to-functions.sh`.
   - These copy folders are not in the zip. If you ever see them in your repo, never edit them — your change gets overwritten.
2. **Which deploy do you need after a change?**
   - Changed `web/…` or an engine file listed in the web copy script → re-run **Deploy website**.
   - Changed `supabase/functions/…` or an engine file listed in the functions copy script → re-run **Deploy Supabase**.
   - Many engine files are in **both** lists (e.g. `dailySnapshots.js`, `tradeStats.js`, `currentR.js`, `money.js`, `taxonomy.js`, `positionAnalytics.js`) → deploy both.
3. **Database changes = a new migration file** (`0007_….sql`), never an edit to an old one. Old data only changes through new migrations.

Tests live in `packages/engine/test/` (`cd packages/engine && npm test`) and `web/test/`. If you change a formula, change the matching test file too.

---

## 2. The data flow in one picture

```
PropReports API
   │  (propreportsClient.js: fills / adjustments / positions / accounts)
   ▼
supabase/functions/sync/index.ts  ──►  packages/engine/src/syncEngine.js  (runSync)
   │                                      ├─ normalize.js        raw CSV rows → clean records
   │                                      ├─ dedupe.js           duplicates / replaced records
   │                                      ├─ positionEngine.js   fills → trades (open/closed)
   │                                      └─ dailySnapshots.js   per-day P&L numbers
   ▼
supabase/functions/_shared/supabaseStore.ts  ──►  SQL function apply_sync_batch (0003_sync_commit.sql)
   ▼
Postgres tables  (raw_fills, raw_adjustments, position_instances, daily_account_snapshots, …)
   ▼
web/js/api.js  (reads tables)  ──►  web/js/views/*.js  ──►  engine files for display maths
```

Key idea: **`daily_account_snapshots` is the source for the Calendar, Dashboard chart and Weekly Report day numbers.** If a day's number is wrong everywhere, the bug is almost always in `dailySnapshots.js`. If it's wrong in only one tab, the bug is in that tab's file.

---

## 3. "I want to fix X" → go here

### Calendar (numbers, weeks, comments)
| Problem | File | Function / spot |
|---|---|---|
| Calendar daily or weekly **totals wrong** | `packages/engine/src/calendar.js` | `buildCalendarMonth()` (weekly total is the `weeklyTotal` line) |
| Week must start Monday / grid layout | `packages/engine/src/calendar.js` | `buildMonthGrid()`, `mondayIndexedWeekday()` helper near the top |
| **Schema 2** on the calendar (profit share lands on last day) | `packages/engine/src/calendar.js` | `computeSchema2DailyDeltas()` |
| Which day a trade shows on, symbols/quantities in the day panel | `web/js/views/calendar.js` | `dayPanel()` (the `assembleDayDetail({... trades: trades.map(...) })` block) |
| Day panel breakdown table (trading result / costs / fees) | `web/js/views/calendar.js` | `breakdown` / `line()` in `dayPanel()` |
| Which trades are loaded for a tapped day | `web/js/api.js` | `getTradesTouchingDay()` |
| Day comments save/load | `web/js/api.js` (`getDailyComments`, `saveDailyComment`), table in `supabase/migrations/0002_daily_comments.sql` |
| Day comment → weekly comment draft | `calendar.js` (`weekDaysToCommentInput`), `weeklyReport.js` (`buildWeeklyCommentDraft`) |
| Cell colours / layout | `web/css/styles.css` (`.cal-grid`, `.cal-cell`) |

### The P&L numbers themselves (Schema 1 / 2 / 3)
| Problem | File | Function |
|---|---|---|
| **Per-day** Schema 1/3, fees, account value | `packages/engine/src/dailySnapshots.js` | `buildDailySnapshots()` |
| Platform / Market Data fee not recognised | `dailySnapshots.js` | the `/market\s*data/i` and `/platform/i` regex lines in the adjustments loop |
| Fee vs transfer classification of an adjustment category | `packages/engine/src/normalize.js` | `classifyAdjustmentCategory()`; known categories come from table `adjustment_categories` |
| Schema formulas (single day) | `packages/engine/src/pnlSchemas.js` | `computeSchema1Delta`, `computeSchema3Delta` |
| Monthly profit share (once per month) | `pnlSchemas.js` | `applyMonthlyProfitShare`, `computeSchema2ForMonths`, `resolvePctForMonth` |
| Schema series for Dashboard chart | `packages/engine/src/schemaSeries.js` | `dailySeries()`, `cumulative()` |
| Profit-share % storage | table `profit_share_schedule`; `web/js/api.js` `getProfitShareSchedule` / `saveProfitShare`; UI in `web/js/views/settings.js` |

### PropReports integration (what is taken from the API)
| Problem | File | Spot |
|---|---|---|
| Which API actions/fields are requested | `packages/engine/src/propreportsClient.js` | `listAccounts`, `fetchFills` (`optionalFields`), `fetchAdjustments`, `fetchPositions` at the bottom of the file |
| Rate limiting / retries / error messages | `propreportsClient.js` | `throttle()`, `post()`, `USER_MESSAGES` |
| CSV parsing, `(1.23)` negatives, optional columns | `packages/engine/src/csv.js` | `parseCsv`, `toNumber`, column lookup helper |
| Column name → field mapping for fills / adjustments | `packages/engine/src/normalize.js` | `normalizeFillRow`, `normalizeAdjustmentRow` |
| "Missing column" errors on sync | `packages/engine/src/syncEngine.js` | `REQUIRED_FILL_COLUMNS`, `REQUIRED_ADJ_COLUMNS`, `REQUIRED_POS_COLUMNS` at the top |
| Date windows (full history vs incremental, 7-day lookback) | `packages/engine/src/syncPlanner.js` | `planWindows()` |
| Duplicates / replaced fills | `packages/engine/src/dedupe.js` | `fillFingerprint`, `diffRecords` (in `syncEngine.js`) |
| Warnings shown after sync (account value mismatch etc.) | `syncEngine.js` | the `warnings.push(...)` calls inside `runSync()` |
| Server entry point, auth, setup action, token handling | `supabase/functions/sync/index.ts` |
| Reads/writes to the DB during sync | `supabase/functions/_shared/supabaseStore.ts` and `supabase/migrations/0003_sync_commit.sql` (`apply_sync_batch`) |
| PropReports token | Supabase secret `PROPREPORTS_TOKEN` only — never in code |

### Positions, trades, statistics
| Problem | File | Function |
|---|---|---|
| Open/closed positions, partial closes, reversals, avg entry | `packages/engine/src/positionEngine.js` | `reconstructPositions`, `reconstructAllPositions` |
| Unrealized P&L formula | `positionEngine.js` | `computeUnrealizedPnl` |
| Current R and stop-loss validation | `packages/engine/src/currentR.js` | `computeCurrentR` |
| Position value, risk to stop, exposure by symbol/sector/industry | `packages/engine/src/positionAnalytics.js` | `enrichPosition`, `summarizePortfolio` |
| Current Positions page layout, Edit / Close buttons | `web/js/views/positions.js` | `render` (layout), `row`, `editDialog`, `closeDialog` |
| Prices (Yahoo), caching, "price unavailable" | `packages/engine/src/marketData.js` + `supabase/functions/market/index.ts` |
| Sector/industry lists and TradingView matching | `packages/engine/src/taxonomy.js`, tables from `0004_market_and_taxonomy.sql` |
| BAT, W/L ratio, avg winner/loser, hold time (weekly report) | `packages/engine/src/tradeStats.js` | `computeTradeStats` |
| Dashboard statistics (win rate, profit factor, expectancy, by symbol…) | `packages/engine/src/statistics.js` | `computeStatistics`, `tradeResult`, `tradeR` |
| Trades tab filters / detail | `web/js/views/trades.js`, query in `web/js/api.js` `getTradesPage` |
| Dashboard layout / cards / chart | `web/js/views/dashboard.js`, `web/js/views/charts.js` |

### Weekly report
| Problem | File | Function |
|---|---|---|
| **Which numbers go in the report** (days, account value, stats) | `packages/engine/src/weekBuilder.js` | `buildWeekInput()` |
| Weekly total, average daily Δ, up/down days, max drawdown | `packages/engine/src/reportTotals.js` | `computeWeeklyTotalDelta`, `computeAverageDailyDelta`, `computeUpDownDays`, `computeMaxDrawdown` |
| Daily "Total Δ" **without** monthly fees (1st-of-month rule) | `packages/engine/src/dailySnapshots.js` | `reportDayDelta()` |
| Assembling report data / manual overrides | `packages/engine/src/weeklyReport.js` | `assembleWeeklyReportData`, `applyManualOverrides` |
| Number formatting like `(4.38)` | `packages/engine/src/format.js` |
| **PDF look** (sizes, colours, boxes, labels) | `packages/engine/src/weeklyReportPdfCore.js` | `renderWeeklyReportPdfCore`; fonts in `packages/engine/assets/fonts/` |
| Report tab workflow (week picker → comment → edit → download) | `web/js/views/weekly.js` |
| Browser PDF glue | `web/js/pdf.js` |

### Settings, login, shell, look & feel
- Login, setup screen, sync bar, tabs: `web/js/app.js`
- Supabase URL / anon key: `web/js/config.js` (filled by the deploy workflow — don't hard-code secrets)
- All styling and the pink theme: `web/css/styles.css`
- Settings page: `web/js/views/settings.js`
- Shared helpers (`money()`, `fmtDate`, schema dropdown names): `web/js/lib.js`
- All database reads/writes from the browser: `web/js/api.js`

### Database
- Tables + security rules: `supabase/migrations/0001_init_schema.sql`
- Daily comments: `0002` · atomic sync commit: `0003` · prices/classification: `0004` · manual journal close: `0005` · FK fix: `0006`
- SQL tests: `supabase/tests/`

### Deployment
- Active workflows: `.github/workflows/` (the root `github-workflows/` folder looks like a duplicate copy for manual upload — keep the two in sync or delete one)
- Step-by-step guide: `SETUP-GUIDE.md`

---

## 4. Date / timezone behaviour (relevant to calendar fixes)

Timestamps are stored as PropReports reported them (wall-clock labelled UTC) and the views display them in UTC. Day boundaries are made with `toISOString().slice(0, 10)` in `calendar.js` (view), `weekBuilder.js`, `tradeStats.js` and `api.js`. If a trade appears on the "wrong" day, it's a UTC-vs-local assumption, and the fix has to be applied consistently in all of those places.

---

## 5. Suggested order for an optimization pass

1. Run `npm test` in `packages/engine` and `web` first, so you have a baseline.
2. Calendar fixes (section 6, items 1–3).
3. Weekly-report stats (item 4).
4. Risk % of account (item 5).
5. Housekeeping: stale README, duplicate workflow folder.

---

## 6. Things I noticed in the code worth checking

These come from reading the code, not from running it. Verify each before changing anything.

1. **Calendar Schema 2 vs Schema 1/3 on boundary weeks.** In `calendar.js` → `buildCalendarMonth()`, Schema 1/3 deltas are built from *all* snapshot days, but Schema 2 is built only from days **inside the displayed month**. Grey days from the neighbouring month will probably show blank under Schema 2 and the weekly total for a week that straddles two months would then differ from Schema 1/3. `schemaSeries.js` → `dailySeries()` already computes Schema 2 per month for the whole history; reusing it would likely fix this.
2. **Schema 2 mid-month.** `computeSchema2DailyDeltas()` puts the whole profit-share deduction on the *latest day with data*. For the current, unfinished month that means the deduction appears on the most recent trading day instead of at month end, and moves as new days arrive. Decide whether you want that, or no deduction until the month is complete.
3. **Quantity in the day panel is a heuristic.** In `web/js/views/calendar.js` → `dayPanel()`: `quantity: t.quantityTraded / (t.status === 'closed' ? 2 : 1)`. That halves the traded quantity for closed trades (assuming buy + sell are equal). It will be off for partial adds/trims. `weekBuilder.js` uses the same `/ 2` idea for `avgSizeInPosition`.
4. **Realized Net is flagged as a hypothesis** in the header of `dailySnapshots.js` (`realized − trade costs`). Compare it with the "Realized Net" in a real PropReports report; if it differs, this is the line to change. The same applies to BAT / W/L: `tradeStats.js` computes them itself and states that treating wash trades as excluded is an unverified assumption.
5. **Risk as % of account never shows.** `supabase/functions/market/index.ts` passes `accountValue: null` to `summarizePortfolio`, so the "% of account" figure is always hidden. The latest account value is in `daily_account_snapshots` — it could be read there.
6. **Edge Functions say "NOT YET RUN LIVE"** in their header comments (`sync/index.ts`, `market/index.ts`, `supabaseStore.ts`). If they've now been verified on your Supabase project, update those comments.
7. **`README.md` is out of date** — it still says nothing talks to Supabase/PropReports yet and mentions only two migrations and 69 tests. `SETUP-GUIDE.md` is the current document.
8. **Day-trade lookup edge:** `getTradesTouchingDay()` ends the range at `T23:59:59Z`, so an event stamped inside the final second of a day could be missed. Using "< next day 00:00" would be safer.

---

## 7. How to work on a fix safely

1. Write down the symptom + which tab + which date/number is wrong.
2. Use the tables above to find the file; if it's an engine file, change it there only.
3. Run that file's test (e.g. `node --test test/calendar.test.js` inside `packages/engine`), then the full `npm test`.
4. Deploy: website and/or Supabase, per rule 2 in section 1.
5. Press **Sync Now** (or a full sync if snapshot logic changed — snapshot rows are only recalculated for the dates a sync touches).
