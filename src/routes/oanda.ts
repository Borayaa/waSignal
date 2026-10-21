import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { oandaLink, oandaRefresh, oandaSelect, oandaStatus, oandaUnlink } from '../lib/brokers/oanda';
import type { AppBindings } from '../types';

const app = new Hono<AppBindings>();
app.use('/api/oanda', requireAuth);
app.use('/api/oanda/*', requireAuth);

app.get('/api/oanda', async (c) => c.json(await oandaStatus(c.env, c.get('accountId'))));

app.put('/api/oanda', async (c) => {
  const b = await c.req.json<{ token?: unknown; environment?: unknown }>().catch(() => ({}) as { token?: unknown; environment?: unknown });
  const token = typeof b.token === 'string' ? b.token.trim() : '';
  if (token.length < 8 || token.length > 300 || /\s/.test(token)) return c.json({ error: 'token required' }, 400);
  if (b.environment !== 'practice' && b.environment !== 'live') return c.json({ error: "environment must be 'practice' or 'live'" }, 400);
  return c.json(await oandaLink(c.env, c.get('accountId'), token, b.environment));
});

app.put('/api/oanda/account', async (c) => {
  const b = await c.req.json<{ accountId?: unknown }>().catch(() => ({}) as { accountId?: unknown });
  if (typeof b.accountId !== 'string' || !b.accountId.trim()) return c.json({ error: 'accountId required' }, 400);
  return c.json(await oandaSelect(c.env, c.get('accountId'), b.accountId));
});

app.post('/api/oanda/refresh-accounts', async (c) => c.json(await oandaRefresh(c.env, c.get('accountId'))));
app.delete('/api/oanda', async (c) => c.json(await oandaUnlink(c.env, c.get('accountId'))));

export default app;
