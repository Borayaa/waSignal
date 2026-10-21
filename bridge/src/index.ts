import 'dotenv/config';
import path from 'node:path';
import { logger } from './logger.js';
import { Session } from './session.js';
import { WorkerClient } from './worker-client.js';

const WORKER_URL = process.env.WORKER_URL || 'https://trading.infragreen.app';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || './auth');
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 3000;

if (!BRIDGE_TOKEN) {
  logger.fatal('BRIDGE_TOKEN is required');
  process.exit(1);
}

const client = new WorkerClient(WORKER_URL, BRIDGE_TOKEN);
const sessions = new Map<string, Session>();
let shuttingDown = false;

async function reconcile() {
  const res = await client.sync();
  if (!res) return;
  const seen = new Set<string>();

  for (const a of res.accounts) {
    seen.add(a.accountId);
    let s = sessions.get(a.accountId);
    if (s) s.targetChatId = a.targetChatId;

    try {
      if (a.desired === 'connected') {
        if (!s || !s.running) {
          s = new Session(a.accountId, a.targetChatId, client, AUTH_DIR);
          sessions.set(a.accountId, s);
          logger.info({ accountId: a.accountId }, 'starting session');
          await s.start();
        }
      } else if (a.desired === 'disconnected') {
        if (s && s.running) {
          logger.info({ accountId: a.accountId }, 'stopping session');
          await s.stop();
        }
        if (s && !s.running) sessions.delete(a.accountId);
      } else if (a.desired === 'logout') {
        logger.info({ accountId: a.accountId }, 'logging out');
        s ??= new Session(a.accountId, a.targetChatId, client, AUTH_DIR);
        await s.logout();
        sessions.delete(a.accountId);
      }
    } catch (e) {
      logger.error({ accountId: a.accountId, err: String(e) }, 'reconcile error');
    }
  }

  for (const [id, s] of sessions) {
    if (seen.has(id)) continue;
    if (s.running) {
      logger.info({ accountId: id }, 'account absent from sync; stopping');
      await s.stop(false).catch(() => {});
    }
    sessions.delete(id);
  }
}

async function loop() {
  while (!shuttingDown) {
    try { await reconcile(); } catch (e) { logger.error({ err: String(e) }, 'loop error'); }
    await new Promise((r) => setTimeout(r, SYNC_INTERVAL_MS));
  }
}

async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ sig }, 'shutting down');
  await Promise.all([...sessions.values()].map((s) => s.stop(false).catch(() => {})));
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException', (e) => logger.error({ err: String(e) }, 'uncaughtException'));

logger.info({ WORKER_URL, AUTH_DIR, SYNC_INTERVAL_MS }, 'bridge started');
void loop();
