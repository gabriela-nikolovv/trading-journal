// POST /functions/v1/sync   body: {"action":"setup"} | {"action":"sync","full":false}
//
// The browser sends its Supabase login JWT. The PropReports token is read ONLY
// from the function's secrets (PROPREPORTS_TOKEN) — it is never sent to, stored
// in, or returned to the browser. Set it with:  supabase secrets set PROPREPORTS_TOKEN=...
//
// NOT YET DEPLOYED/RUN: written against the tested engine + SQL, but the build
// sandbox cannot reach Supabase or PropReports, so first live verification
// happens on your project (see README → "First live run").
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createPropReportsClient, redactToken } from '../_shared/engine/propreportsClient.js';
import { runSync } from '../_shared/engine/syncEngine.js';
import { createSupabaseStore } from '../_shared/supabaseStore.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const token = Deno.env.get('PROPREPORTS_TOKEN');
  try {
    if (!token) return json({ ok: false, error: 'PropReports token is not configured on the server.' }, 500);

    // 1. Who is calling? (real Supabase auth — not a frontend-only password)
    const url = Deno.env.get('SUPABASE_URL')!;
    const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ ok: false, error: 'Please sign in.' }, 401);

    const db = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!); // service role stays server-side
    const pr = createPropReportsClient({ baseUrl: Deno.env.get('PROPREPORTS_URL') ?? 'https://alaric.propreports.com/api.php', token });
    const { action = 'sync', full = false } = await req.json().catch(() => ({}));

    if (action === 'setup') {
      await pr.version(); // validates the token
      const accounts = await pr.listAccounts();
      if (accounts.length !== 1) return json({ ok: false, error: `Expected exactly one authorised account, found ${accounts.length}.`, accounts: accounts.map((a) => ({ id: a['Account Id'], name: a['Account'] })) }, 409);
      const a = accounts[0];
      const { data, error } = await db.from('prop_accounts').upsert({
        user_id: user.id, propreports_account_id: Number(a['Account Id']), propreports_account_name: a['Account Name'] || null, account_code: a['Account'] || null, currency: a['Currency'] || 'USD',
      }, { onConflict: 'user_id,propreports_account_id' }).select('id').single();
      if (error) throw error;
      return json({ ok: true, propAccountId: data.id, firstTraded: a['First Traded'] || null });
    }

    const { data: acct } = await db.from('prop_accounts').select('id').eq('user_id', user.id).eq('is_active', true).maybeSingle();
    if (!acct) return json({ ok: false, error: 'No PropReports account set up yet.' }, 409);
    const store = createSupabaseStore(db, acct.id);
    const today = new Date().toISOString().slice(0, 10);
    const result = await runSync({ client: pr, store, today, token, forceFull: full });
    return json(result, result.ok ? 200 : 502);
  } catch (e) {
    console.error('sync handler error:', redactToken((e as Error).message, token)); // never log the token
    return json({ ok: false, error: 'PropReports synchronization failed. Your previous data is still available.' }, 500);
  }
});
