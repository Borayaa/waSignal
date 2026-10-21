import { Hono } from 'hono';
import authRoutes from './routes/auth';
import bridgeRoutes from './routes/bridge';
import ctraderRoutes from './routes/ctrader';
import dashboardRoutes from './routes/dashboard';
import telegramRoutes from './routes/telegram';
import { processIncomingMessage } from './lib/pipeline';
import { BrokerError } from './lib/ctauth';
import { CtraderError } from './lib/ctrader';
import type { AppBindings, Env, SignalQueueMessage } from './types';

const app = new Hono<AppBindings>();

app.route('/', authRoutes);
app.route('/', bridgeRoutes);
app.route('/', ctraderRoutes); // before dashboardRoutes: its OAuth callback must bypass the dashboard auth middleware
app.route('/', dashboardRoutes);
app.route('/', telegramRoutes); // has its own requireAuth

app.onError((err, c) => {
  if (err instanceof BrokerError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof CtraderError) return c.json({ error: err.message }, 502);
  console.error(err);
  if (c.req.path.startsWith('/api/')) return c.json({ error: err.message || 'Internal error' }, 500);
  return c.text('Internal error', 500);
});

app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found' }, 404) : c.env.ASSETS.fetch(c.req.raw)));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<SignalQueueMessage>, env: Env): Promise<void> {
    for (const m of batch.messages) {
      try {
        await processIncomingMessage(env, m.body.accountId, m.body.msg);
      } catch (e) {
        console.error('queue: processIncomingMessage failed', e);
      }
      m.ack();
    }
  },
} satisfies ExportedHandler<Env, SignalQueueMessage>;
