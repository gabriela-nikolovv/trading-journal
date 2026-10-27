import test from 'node:test';
import assert from 'node:assert/strict';
import { createPropReportsClient, splitPageTrailer, redactToken, PropReportsError } from '../src/propreportsClient.js';

const TOKEN = 'secret-token-abc:485';
const mkRes = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const mk = (impl, extra = {}) => createPropReportsClient({ baseUrl: 'https://alaric.propreports.com/api.php', token: TOKEN, fetchImpl: impl, sleep: async () => {}, ...extra });

test('trailer is split off and never parsed as a data row', () => {
  const t = splitPageTrailer('A,B\n1,2\nPage 2/5');
  assert.deepEqual([t.csv, t.page, t.totalPages], ['A,B\n1,2', 2, 5]);
});

test('token is sent in the POST body only — never in the URL — and requests use form encoding', async () => {
  let seen;
  const c = mk(async (url, init) => { seen = { url, init }; return mkRes(200, 'v1.22.12 [2026-05-01]'); });
  await c.version();
  assert.equal(seen.url, 'https://alaric.propreports.com/api.php');
  assert.ok(!seen.url.includes(TOKEN));
  assert.equal(seen.init.method, 'POST');
  assert.match(seen.init.headers['Content-Type'], /x-www-form-urlencoded/);
  assert.equal(new URLSearchParams(seen.init.body).get('token'), TOKEN);
});

test('paginates until the trailer says done and concatenates rows', async () => {
  const pages = { 1: 'Symbol,Price\nAAPL,1\nPage 1/3', 2: 'Symbol,Price\nMSFT,2\nPage 2/3', 3: 'Symbol,Price\nNVDA,3\nPage 3/3' };
  const c = mk(async (_u, init) => mkRes(200, pages[new URLSearchParams(init.body).get('page')]));
  const rows = await c.fetchFills(348, '2026-08-01', '2026-08-31');
  assert.deepEqual(rows.map((r) => r.Symbol), ['AAPL', 'MSFT', 'NVDA']);
});

test('fills request asks for the opt-in columns the sync depends on (propReportsId, fillId, currency, multiplier)', async () => {
  let body;
  const c = mk(async (_u, init) => { body = new URLSearchParams(init.body); return mkRes(200, 'Symbol\nPage 1/1'); });
  await c.fetchFills(348, '2026-08-01', '2026-08-31');
  assert.equal(body.get('action'), 'fills');
  assert.equal(body.get('accountId'), '348');
  assert.ok(body.get('optionalFields').includes('propReportsId'));
});

test('401 → auth error with a friendly message, no retries, token not leaked', async () => {
  let calls = 0;
  const c = mk(async () => { calls++; return mkRes(401, `Invalid token ${TOKEN}`); });
  await assert.rejects(c.listAccounts(), (e) => {
    assert.ok(e instanceof PropReportsError);
    assert.equal(e.kind, 'auth');
    assert.ok(!e.message.includes(TOKEN) && !e.detail.includes(TOKEN), 'token must be redacted');
    return true;
  });
  assert.equal(calls, 1);
});

test('503 is retried then succeeds; network failure surfaces as a friendly error', async () => {
  let n = 0;
  const c = mk(async () => (++n < 3 ? mkRes(503, 'busy') : mkRes(200, 'ok')));
  assert.equal(await c.version(), 'ok');
  const bad = mk(async () => { throw new Error(`socket hang up for ${TOKEN}`); });
  await assert.rejects(bad.version(), (e) => e.kind === 'network' && !e.message.includes(TOKEN) && !String(e.cause).includes(TOKEN));
});

test('rate limiter never sends more than 40 requests inside 4 seconds', async () => {
  let t = 0; const sent = [];
  const c = mk(async () => { sent.push(t); return mkRes(200, 'ok'); }, { now: () => t, sleep: async (ms) => { t += ms; } });
  for (let i = 0; i < 100; i++) await c.version();
  for (let i = 0; i < sent.length; i++) {
    const inWindow = sent.filter((x) => x >= sent[i] && x < sent[i] + 4000).length;
    assert.ok(inWindow <= 40, `window starting ${sent[i]} had ${inWindow}`);
  }
});

test('refuses non-https base URLs; redactToken handles url-encoded form', () => {
  assert.throws(() => createPropReportsClient({ baseUrl: 'http://x', token: 't' }));
  assert.equal(redactToken(`a ${encodeURIComponent(TOKEN)} b`, TOKEN), 'a [REDACTED] b');
});
