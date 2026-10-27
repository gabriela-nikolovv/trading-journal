import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installDom } from './harness.js';
import { assembleWeeklyReportData } from '../../packages/engine/src/weeklyReport.js';

installDom();
const require = createRequire(new URL('../../packages/engine/package.json', import.meta.url));

test('browser PDF path: uses the pdf-lib / fontkit GLOBALS and fetched fonts, and produces a real PDF', async () => {
  window.PDFLib = require('pdf-lib');
  window.fontkit = require('@pdf-lib/fontkit');
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    const bytes = readFileSync(new URL(`../${url}`, import.meta.url));
    return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const { browserPdf } = await import('../js/pdf.js');
  const pdf = browserPdf();
  const report = assembleWeeklyReportData({
    accountName: 'Gabriela Nikolova', accountCode: 'FPTI000645A404', weekStart: '2026-08-31', weekEnd: '2026-09-04',
    days: [['Monday', '2026-08-31', -4.38, -641.45], ['Tuesday', '2026-09-01', -4.21, -696.61], ['Wednesday', '2026-09-02', -0.09, -696.7], ['Thursday', '2026-09-03', 3.82, -692.88], ['Friday', '2026-09-04', 46.42, -646.46]].map(([label, date, totalDelta, accountValue]) => ({ label, date, totalDelta, accountValue })),
    propReportsNative: { realizedNet: 8.59, quantity: 32, bat: 0.5, wlRatio: 557.22, avgSizeInPosition: 5, avgNetWinner: 23.18, avgNetLoser: -0.04, avgHoldTime: '13d 12:37:38', biggestNetWinner: 23.18, biggestNetLoser: -0.04 },
    weeklyComment: 'Overall recovered from the previous week’s bad streak.',
  });
  const bytes = await pdf.render(report);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  assert.ok(bytes.length > 5000);
  assert.deepEqual(requested, ['assets/fonts/LiberationSans-Regular.ttf', 'assets/fonts/LiberationSans-Bold.ttf']);
  await pdf.render(report);
  assert.equal(requested.length, 2, 'fonts are fetched once and cached');
});

test('browser PDF path: a missing PDF library gives a plain-language error', async () => {
  delete window.PDFLib;
  const { browserPdf } = await import('../js/pdf.js');
  await assert.rejects(browserPdf().render({}), /PDF library did not load/);
});

test('api.js: row mapping, and server error messages are unwrapped into friendly text', async () => {
  const { toTrade, toSnapshot, createApi } = await import('../js/api.js');
  const t = toTrade({ id: 'x', symbol: 'AAPL', direction: 'long', status: 'open', open_quantity: '100.000000', quantity_traded: '100', avg_entry_price: '200.5', avg_exit_price: null, realized_pnl: '0', fees_allocated: '0.5', opened_at: '2026-09-01T14:00:00Z', closed_at: null, stop_loss: null, notes: null, sector: { name: 'Finance' }, industry: null });
  assert.deepEqual([t.openQuantity, t.avgEntryPrice, t.stopLoss, t.sector, t.closedAt], [100, 200.5, null, 'Finance', null]);
  assert.equal(toSnapshot({ trade_date: '2026-09-01', schema1_delta: '-55.16', schema3_delta: '-4.21', commissions: '0', market_data_fees: '25', platform_fees: '25.95', other_fees: '0', transfers: '0', account_value: '-696.61', realized_net: '0', quantity_traded: '0' }).schema1Delta, -55.16);
  const sb = { functions: { invoke: async () => ({ data: null, error: { context: { json: async () => ({ error: 'PropReports token is not configured on the server.' }) } } }) } };
  await assert.rejects(createApi(sb).runSync({}), /token is not configured/);
  const sb2 = { functions: { invoke: async () => ({ data: { ok: false, error: 'No PropReports account set up yet.' }, error: null }) } };
  await assert.rejects(createApi(sb2).getPositions(), /No PropReports account/);
});

test('main.js: without Supabase settings it shows a plain explanation instead of a blank page', async () => {
  document.body.innerHTML = '<div id="app"></div>'; window.APP_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
  await import('../js/main.js');
  assert.match(document.getElementById('app').textContent, /not connected to Supabase yet/);
});
