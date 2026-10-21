import { Hono } from 'hono';
import { requireBridge } from '../lib/auth';
import { decrypt } from '../lib/crypto';
import type { AppBindings, BridgeChatsUpdate, BridgeMessage, BridgeStateUpdate, BridgeSyncResponse, BridgeTgChatsUpdate, BridgeTgStateUpdate, TgDesired, WaDesired } from '../types';

const app = new Hono<AppBindings>();
app.use('/api/bridge/*', requireBridge);

app.get('/api/bridge/sync', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT account_id, desired, target_chat_id FROM wa_state WHERE desired != 'disconnected' OR status != 'disconnected'",
  ).all<{ account_id: string; desired: WaDesired; target_chat_id: string | null }>();
  if (results.length) {
    const now = Date.now();
    for (let i = 0; i < results.length; i += 50) {
      await c.env.DB.batch(
        results.slice(i, i + 50).map((r) => c.env.DB.prepare('UPDATE wa_state SET bridge_seen_at = ? WHERE account_id = ?').bind(now, r.account_id)),
      );
    }
  }
  const tg = await c.env.DB.prepare(
    "SELECT account_id, desired, target_chat_id, password_enc FROM tg_state WHERE desired != 'disconnected' OR status NOT IN ('disconnected', 'unavailable')",
  ).all<{ account_id: string; desired: TgDesired; target_chat_id: string | null; password_enc: string | null }>();
  const telegram: BridgeSyncResponse['telegram'] = [];
  if (tg.results.length) {
    const now = Date.now();
    for (const r of tg.results) {
      let password: string | undefined;
      if (r.password_enc) {
        try {
          password = await decrypt(c.env, r.password_enc);
        } catch (e) {
          console.error('tg password decrypt failed', e);
        }
      }
      telegram.push({ accountId: r.account_id, desired: r.desired, targetChatId: r.target_chat_id, ...(password !== undefined ? { password } : {}) });
    }
    for (let i = 0; i < tg.results.length; i += 50) {
      await c.env.DB.batch(
        tg.results.slice(i, i + 50).map((r) =>
          r.password_enc
            ? c.env.DB.prepare('UPDATE tg_state SET bridge_seen_at = ?, password_enc = NULL WHERE account_id = ?').bind(now, r.account_id)
            : c.env.DB.prepare('UPDATE tg_state SET bridge_seen_at = ? WHERE account_id = ?').bind(now, r.account_id),
        ),
      );
    }
  }
  const body: BridgeSyncResponse = {
    accounts: results.map((r) => ({ accountId: r.account_id, desired: r.desired, targetChatId: r.target_chat_id })),
    telegram,
  };
  return c.json(body);
});

app.post('/api/bridge/state', async (c) => {
  const b = await c.req.json<BridgeStateUpdate>().catch(() => null);
  if (!b?.accountId || !b.status) return c.json({ error: 'accountId and status required' }, 400);
  const now = Date.now();
  const qr = b.status === 'qr' ? (b.qr ?? null) : null;
  if (b.status === 'logged_out') {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE wa_state SET status = 'logged_out', qr = NULL, phone = NULL, desired = 'disconnected', target_chat_id = NULL, target_chat_name = NULL, bridge_seen_at = ?1, updated_at = ?1 WHERE account_id = ?2",
      ).bind(now, b.accountId),
      c.env.DB.prepare('DELETE FROM wa_chats WHERE account_id = ?').bind(b.accountId),
    ]);
  } else {
    await c.env.DB.prepare(
      'UPDATE wa_state SET status = ?1, qr = ?2, phone = COALESCE(?3, phone), bridge_seen_at = ?4, updated_at = ?4 WHERE account_id = ?5',
    )
      .bind(b.status, qr, b.phone ?? null, now, b.accountId)
      .run();
  }
  return c.json({ ok: true });
});

app.post('/api/bridge/chats', async (c) => {
  const b = await c.req.json<BridgeChatsUpdate>().catch(() => null);
  if (!b?.accountId || !Array.isArray(b.chats)) return c.json({ error: 'accountId and chats required' }, 400);
  const now = Date.now();
  const stmts = b.chats
    .filter((ch) => ch && typeof ch.id === 'string')
    .map((ch) =>
      c.env.DB.prepare(
        `INSERT INTO wa_chats (account_id, chat_id, name, is_group, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(account_id, chat_id) DO UPDATE SET name = excluded.name, is_group = excluded.is_group, updated_at = excluded.updated_at`,
      ).bind(b.accountId, ch.id, ch.name ?? null, ch.isGroup ? 1 : 0, now),
    );
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  await c.env.DB.prepare('UPDATE wa_state SET bridge_seen_at = ? WHERE account_id = ?').bind(now, b.accountId).run();
  return c.json({ ok: true });
});

app.post('/api/bridge/telegram/state', async (c) => {
  const b = await c.req.json<BridgeTgStateUpdate>().catch(() => null);
  if (!b?.accountId || !b.status) return c.json({ error: 'accountId and status required' }, 400);
  const now = Date.now();
  if (b.status === 'logged_out') {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE tg_state SET status = 'logged_out', qr = NULL, user_label = NULL, desired = 'disconnected', target_chat_id = NULL, target_chat_name = NULL, password_enc = NULL, error = ?2, bridge_seen_at = ?1, updated_at = ?1 WHERE account_id = ?3",
      ).bind(now, b.error ?? null, b.accountId),
      c.env.DB.prepare('DELETE FROM tg_chats WHERE account_id = ?').bind(b.accountId),
    ]);
  } else {
    await c.env.DB.prepare(
      'UPDATE tg_state SET status = ?1, qr = ?2, user_label = COALESCE(?3, user_label), error = ?4, bridge_seen_at = ?5, updated_at = ?5 WHERE account_id = ?6',
    )
      .bind(b.status, b.status === 'qr' ? (b.qr ?? null) : null, b.user ?? null, b.error ?? null, now, b.accountId)
      .run();
  }
  return c.json({ ok: true });
});

app.post('/api/bridge/telegram/chats', async (c) => {
  const b = await c.req.json<BridgeTgChatsUpdate>().catch(() => null);
  if (!b?.accountId || !Array.isArray(b.chats)) return c.json({ error: 'accountId and chats required' }, 400);
  const now = Date.now();
  const stmts = b.chats
    .filter((ch) => ch && typeof ch.id === 'string')
    .map((ch) =>
      c.env.DB.prepare(
        `INSERT INTO tg_chats (account_id, chat_id, name, kind, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(account_id, chat_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, updated_at = excluded.updated_at`,
      ).bind(b.accountId, ch.id, ch.name ?? null, ch.kind === 'channel' || ch.kind === 'user' ? ch.kind : 'group', now),
    );
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  await c.env.DB.prepare('UPDATE tg_state SET bridge_seen_at = ? WHERE account_id = ?').bind(now, b.accountId).run();
  return c.json({ ok: true });
});

app.post('/api/bridge/message', async (c) => {
  const b = await c.req.json<BridgeMessage>().catch(() => null);
  if (!b?.accountId || !b.chatId || !b.messageId || typeof b.text !== 'string') return c.json({ error: 'invalid message' }, 400);
  const source = b.source === 'telegram' ? 'telegram' : 'whatsapp';
  const st = await c.env.DB.prepare(`SELECT target_chat_id FROM ${source === 'telegram' ? 'tg_state' : 'wa_state'} WHERE account_id = ?`)
    .bind(b.accountId)
    .first<{ target_chat_id: string | null }>();
  if (!st?.target_chat_id || st.target_chat_id !== b.chatId) return c.json({ ok: true, status: 'ignored' });
  const { accountId, source: _s, ...rest } = b;
  const msg = { ...rest, source } as const;
  // Queue consumer has no 30 s waitUntil limit (extraction + cTrader session).
  await c.env.SIGNAL_QUEUE.send({ accountId, msg });
  return c.json({ ok: true, status: 'received' });
});

export default app;
