import { Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import { BrokerClient } from '../lib/broker';
import { authorizeUrl, ctraderConfigured, getStatus, linkWithCode, refreshAccounts, selectAccount, unlink } from '../lib/ctauth';
import { requireAuth, sessionAccountId } from '../lib/auth';
import type { AppBindings } from '../types';

const app = new Hono<AppBindings>();

// The OAuth callback is a top-level browser navigation (SameSite=Lax cookie is sent) but must redirect, not return 401 JSON.
app.use('/api/ctrader/*', async (c, next) => (c.req.path === '/api/ctrader/callback' ? next() : requireAuth(c, next)));
app.use('/api/broker/*', requireAuth);

const redirectUri = (url: string) => `${new URL(url).origin}/api/ctrader/callback`;
const back = (error?: string) => `/dashboard#automation${error ? `?ctrader_error=${encodeURIComponent(error.slice(0, 300))}` : '?ctrader=connected'}`;

app.get('/api/ctrader/connect', async (c) => {
  if (!ctraderConfigured(c.env)) return c.json({ error: 'cTrader Open API is not configured (CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET)' }, 400);
  const state = await sign(
    { sub: c.get('accountId'), nonce: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 },
    c.env.SESSION_SECRET,
    'HS256',
  );
  return c.redirect(authorizeUrl(c.env, redirectUri(c.req.url), state), 302);
});

app.get('/api/ctrader/callback', async (c) => {
  const sessionId = await sessionAccountId(c);
  if (!sessionId) return c.redirect(back('not signed in'), 302);
  const denied = c.req.query('error');
  if (denied) return c.redirect(back(c.req.query('error_description') || denied), 302);
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.redirect(back('missing code or state'), 302);
  try {
    const p = await verify(state, c.env.SESSION_SECRET, 'HS256');
    if (p.sub !== sessionId) return c.redirect(back('state does not match the signed-in account'), 302);
    await linkWithCode(c.env, sessionId, code, redirectUri(c.req.url));
  } catch (e) {
    console.error('ctrader callback failed', e);
    return c.redirect(back((e as Error).message || 'link failed'), 302);
  }
  return c.redirect(back(), 302);
});

app.get('/api/ctrader', async (c) => c.json(await getStatus(c.env, c.get('accountId'))));

app.put('/api/ctrader/account', async (c) => {
  const b = await c.req.json<{ ctidTraderAccountId?: unknown }>().catch(() => ({}) as { ctidTraderAccountId?: unknown });
  const id = Number(b.ctidTraderAccountId);
  if (!Number.isFinite(id)) return c.json({ error: 'ctidTraderAccountId required' }, 400);
  return c.json(await selectAccount(c.env, c.get('accountId'), id));
});

app.post('/api/ctrader/refresh-accounts', async (c) => c.json(await refreshAccounts(c.env, c.get('accountId'))));
app.delete('/api/ctrader', async (c) => c.json(await unlink(c.env, c.get('accountId'))));

// ---------- Trading data (BrokerError -> 400, CtraderError -> 502 via app.onError) ----------
const broker = (c: { env: AppBindings['Bindings']; get(k: 'accountId'): string }) => BrokerClient.forAccount(c.env, c.get('accountId'));

app.get('/api/broker/account', async (c) => c.json(await (await broker(c)).accountInfo()));
app.get('/api/broker/positions', async (c) => c.json({ positions: await (await broker(c)).positions() }));
app.get('/api/broker/orders', async (c) => c.json({ orders: await (await broker(c)).orders() }));
app.get('/api/broker/history', async (c) => c.json({ history: await (await broker(c)).history(Number.parseInt(c.req.query('days') ?? '7', 10) || 7) }));

app.post('/api/broker/close', async (c) => {
  const b = await c.req.json<{ positionId?: unknown; volumeLots?: unknown }>().catch(() => ({}) as { positionId?: unknown; volumeLots?: unknown });
  const positionId = Number(b.positionId);
  if (!Number.isFinite(positionId) || positionId <= 0) return c.json({ error: 'positionId required' }, 400);
  const volumeLots = typeof b.volumeLots === 'number' && b.volumeLots > 0 ? b.volumeLots : undefined;
  return c.json(await (await broker(c)).closeTrade({ positionId, volumeLots }));
});

app.post('/api/broker/test', async (c) => c.json(await (await broker(c)).test()));

export default app;
