import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { encrypt } from '../lib/crypto';
import type { AppBindings, TgDesired } from '../types';

const app = new Hono<AppBindings>();
app.use('/api/tg', requireAuth);
app.use('/api/tg/*', requireAuth);

app.get('/api/tg', async (c) => {
  const id = c.get('accountId');
  const s = await c.env.DB.prepare('SELECT status, qr, user_label, desired, target_chat_id, target_chat_name, error, bridge_seen_at FROM tg_state WHERE account_id = ?')
    .bind(id)
    .first<{ status: string; qr: string | null; user_label: string | null; desired: string; target_chat_id: string | null; target_chat_name: string | null; error: string | null; bridge_seen_at: number | null }>();
  const { results } = await c.env.DB.prepare(
    "SELECT chat_id, name, kind FROM tg_chats WHERE account_id = ? ORDER BY CASE kind WHEN 'channel' THEN 0 WHEN 'group' THEN 1 ELSE 2 END, name COLLATE NOCASE",
  )
    .bind(id)
    .all<{ chat_id: string; name: string | null; kind: string }>();
  return c.json({
    status: s?.status ?? 'disconnected',
    qr: s?.qr ?? null,
    user: s?.user_label ?? null,
    desired: s?.desired ?? 'disconnected',
    targetChatId: s?.target_chat_id ?? null,
    targetChatName: s?.target_chat_name ?? null,
    error: s?.error ?? null,
    bridgeOnline: !!s?.bridge_seen_at && Date.now() - s.bridge_seen_at < 30_000,
    chats: results.map((r) => ({ id: r.chat_id, name: r.name ?? r.chat_id, kind: r.kind })),
  });
});

for (const [path, desired] of [['connect', 'connected'], ['disconnect', 'disconnected'], ['logout', 'logout']] as const) {
  app.post(`/api/tg/${path}`, async (c) => {
    const id = c.get('accountId');
    const d: TgDesired = desired;
    const stmts = [
      d === 'logout'
        ? c.env.DB.prepare('UPDATE tg_state SET desired = ?, updated_at = ?, target_chat_id = NULL, target_chat_name = NULL, password_enc = NULL WHERE account_id = ?').bind(d, Date.now(), id)
        : c.env.DB.prepare('UPDATE tg_state SET desired = ?, updated_at = ?, error = NULL WHERE account_id = ?').bind(d, Date.now(), id),
    ];
    if (d === 'logout') stmts.push(c.env.DB.prepare('DELETE FROM tg_chats WHERE account_id = ?').bind(id));
    await c.env.DB.batch(stmts);
    return c.json({ ok: true });
  });
}

app.put('/api/tg/target', async (c) => {
  const id = c.get('accountId');
  const b = await c.req.json<{ chatId?: string | null }>().catch(() => ({}) as { chatId?: string | null });
  let chatId: string | null = null;
  let name: string | null = null;
  if (b.chatId) {
    const ch = await c.env.DB.prepare('SELECT chat_id, name FROM tg_chats WHERE account_id = ? AND chat_id = ?').bind(id, b.chatId).first<{ chat_id: string; name: string | null }>();
    if (!ch) return c.json({ error: 'Unknown chat' }, 400);
    chatId = ch.chat_id;
    name = ch.name ?? ch.chat_id;
  }
  await c.env.DB.prepare('UPDATE tg_state SET target_chat_id = ?, target_chat_name = ?, updated_at = ? WHERE account_id = ?').bind(chatId, name, Date.now(), id).run();
  return c.json({ targetChatId: chatId, targetChatName: name });
});

app.post('/api/tg/password', async (c) => {
  const id = c.get('accountId');
  const b = await c.req.json<{ password?: unknown }>().catch(() => ({}) as { password?: unknown });
  if (typeof b.password !== 'string' || !b.password || b.password.length > 256) return c.json({ error: 'password required' }, 400);
  const st = await c.env.DB.prepare('SELECT status FROM tg_state WHERE account_id = ?').bind(id).first<{ status: string }>();
  if (st?.status !== 'password') return c.json({ error: 'Telegram is not waiting for a password' }, 400);
  await c.env.DB.prepare('UPDATE tg_state SET password_enc = ?, error = NULL, updated_at = ? WHERE account_id = ?')
    .bind(await encrypt(c.env, b.password), Date.now(), id)
    .run();
  return c.json({ ok: true });
});

export default app;
