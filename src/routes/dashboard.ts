import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { computeCosts } from '../lib/costs';
import { runExtractPlayground } from '../lib/pipeline';
import { getSettings, saveSettings } from '../lib/settings';
import type { AppBindings, AutomationConfig, WaDesired } from '../types';

const app = new Hono<AppBindings>();
app.use('/api/*', async (c, next) => {
  const p = c.req.path;
  if (p.startsWith('/api/auth/') || p.startsWith('/api/bridge/') || p === '/api/me') return next();
  return requireAuth(c, next);
});

const parse = (s: string | null): unknown => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
const limitOf = (v: string | undefined) => Math.min(200, Math.max(1, Number.parseInt(v ?? '50', 10) || 50));
const str = (v: unknown, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

function cleanConfig(raw: unknown): Partial<AutomationConfig> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Partial<AutomationConfig> = {};
  for (const k of ['enabled', 'dryRun', 'requireStopLoss'] as const) if (typeof r[k] === 'boolean') out[k] = r[k];
  if (r.lotMode === 'fixed' || r.lotMode === 'signal') out.lotMode = r.lotMode;
  if (r.tpStrategy === 'first' || r.tpStrategy === 'last' || r.tpStrategy === 'split') out.tpStrategy = r.tpStrategy;
  const fixedLot = num(r.fixedLot, 0.01, 1000);
  if (fixedLot !== undefined) out.fixedLot = fixedLot;
  const maxLot = num(r.maxLot, 0.01, 1000);
  if (maxLot !== undefined) out.maxLot = maxLot;
  const mc = num(r.minConfidence, 0, 1);
  if (mc !== undefined) out.minConfidence = mc;
  const mop = num(r.maxOpenPositions, 0, 1000);
  if (mop !== undefined) out.maxOpenPositions = Math.floor(mop);
  const suffix = str(r.symbolSuffix, 20);
  if (suffix !== undefined) out.symbolSuffix = suffix;
  const prefix = str(r.commentPrefix, 30);
  if (prefix !== undefined) out.commentPrefix = prefix;
  if (r.symbolMap && typeof r.symbolMap === 'object' && !Array.isArray(r.symbolMap)) {
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.symbolMap)) if (typeof v === 'string' && k.trim() && v.trim()) m[k.trim().toUpperCase()] = v.trim();
    out.symbolMap = m;
  }
  if (Array.isArray(r.allowedSymbols)) out.allowedSymbols = r.allowedSymbols.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim().toUpperCase());
  return out;
}

// ---------- Settings ----------
app.get('/api/settings', async (c) => c.json(await getSettings(c.env, c.get('accountId'))));

app.put('/api/settings', async (c) => {
  const b = await c.req.json<{ config?: unknown }>().catch(() => ({}) as { config?: unknown });
  return c.json(await saveSettings(c.env, c.get('accountId'), { config: b.config ? cleanConfig(b.config) : undefined }));
});

// ---------- WhatsApp ----------
app.get('/api/wa', async (c) => {
  const id = c.get('accountId');
  const s = await c.env.DB.prepare('SELECT status, qr, phone, desired, target_chat_id, target_chat_name, bridge_seen_at FROM wa_state WHERE account_id = ?')
    .bind(id)
    .first<{ status: string; qr: string | null; phone: string | null; desired: string; target_chat_id: string | null; target_chat_name: string | null; bridge_seen_at: number | null }>();
  const { results } = await c.env.DB.prepare('SELECT chat_id, name, is_group FROM wa_chats WHERE account_id = ? ORDER BY is_group DESC, name COLLATE NOCASE')
    .bind(id)
    .all<{ chat_id: string; name: string | null; is_group: number }>();
  return c.json({
    status: s?.status ?? 'disconnected',
    qr: s?.qr ?? null,
    phone: s?.phone ?? null,
    desired: s?.desired ?? 'disconnected',
    targetChatId: s?.target_chat_id ?? null,
    targetChatName: s?.target_chat_name ?? null,
    bridgeOnline: !!s?.bridge_seen_at && Date.now() - s.bridge_seen_at < 30_000,
    chats: results.map((r) => ({ id: r.chat_id, name: r.name ?? r.chat_id, isGroup: !!r.is_group })),
  });
});

async function setDesired(c: { env: AppBindings['Bindings'] }, id: string, desired: WaDesired) {
  const extra = desired === 'logout' ? ', target_chat_id = NULL, target_chat_name = NULL' : '';
  const stmts = [c.env.DB.prepare(`UPDATE wa_state SET desired = ?, updated_at = ?${extra} WHERE account_id = ?`).bind(desired, Date.now(), id)];
  if (desired === 'logout') stmts.push(c.env.DB.prepare('DELETE FROM wa_chats WHERE account_id = ?').bind(id));
  await c.env.DB.batch(stmts);
}
for (const [path, desired] of [['connect', 'connected'], ['disconnect', 'disconnected'], ['logout', 'logout']] as const) {
  app.post(`/api/wa/${path}`, async (c) => {
    await setDesired(c, c.get('accountId'), desired);
    return c.json({ ok: true });
  });
}

app.put('/api/wa/target', async (c) => {
  const id = c.get('accountId');
  const b = await c.req.json<{ chatId?: string | null }>().catch(() => ({}) as { chatId?: string | null });
  let chatId: string | null = null;
  let name: string | null = null;
  if (b.chatId) {
    const ch = await c.env.DB.prepare('SELECT chat_id, name FROM wa_chats WHERE account_id = ? AND chat_id = ?').bind(id, b.chatId).first<{ chat_id: string; name: string | null }>();
    if (!ch) return c.json({ error: 'Unknown chat' }, 400);
    chatId = ch.chat_id;
    name = ch.name ?? ch.chat_id;
  }
  await c.env.DB.prepare('UPDATE wa_state SET target_chat_id = ?, target_chat_name = ?, updated_at = ? WHERE account_id = ?').bind(chatId, name, Date.now(), id).run();
  return c.json({ targetChatId: chatId, targetChatName: name });
});

// ---------- Signals & trades ----------
app.get('/api/signals', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, chat_id, sender, text, received_at, status, reason, extraction, signal, source FROM signals WHERE account_id = ? ORDER BY received_at DESC, id DESC LIMIT ?',
  )
    .bind(c.get('accountId'), limitOf(c.req.query('limit')))
    .all<Record<string, any>>();
  return c.json({
    signals: results.map((r) => ({
      id: r.id, chatId: r.chat_id, sender: r.sender, text: r.text, receivedAt: r.received_at, status: r.status, reason: r.reason, source: r.source === 'telegram' ? 'telegram' : 'whatsapp',
      extraction: parse(r.extraction), signal: parse(r.signal),
    })),
  });
});

app.get('/api/trades', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, signal_id, action, request, response, ok, ticket, created_at FROM trades WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  )
    .bind(c.get('accountId'), limitOf(c.req.query('limit')))
    .all<Record<string, any>>();
  return c.json({
    trades: results.map((r) => ({
      id: r.id, signalId: r.signal_id, action: r.action, request: parse(r.request), response: parse(r.response),
      ok: !!r.ok, ticket: r.ticket, createdAt: r.created_at,
    })),
  });
});

app.get('/api/stats', async (c) => {
  const id = c.get('accountId');
  const d = new Date();
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const [today, totals] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT status, COUNT(*) AS n FROM signals WHERE account_id = ? AND received_at >= ? GROUP BY status').bind(id, start),
    c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM signals WHERE account_id = ?1) AS signals, (SELECT COUNT(*) FROM trades WHERE account_id = ?1) AS trades').bind(id),
  ]);
  const by: Record<string, number> = {};
  let received = 0;
  for (const r of today.results as { status: string; n: number }[]) {
    by[r.status] = r.n;
    received += r.n;
  }
  const t = totals.results[0] as { signals: number; trades: number };
  return c.json({
    today: {
      received,
      executed: (by.executed ?? 0) + (by.partial ?? 0),
      rejected: by.rejected ?? 0,
      failed: by.failed ?? 0,
      ignored: by.ignored ?? 0,
      dryRun: by.dry_run ?? 0,
    },
    total: { signals: t.signals, trades: t.trades },
  });
});

app.post('/api/extract', async (c) => {
  const b = await c.req.json<{ text?: unknown; execute?: unknown }>().catch(() => ({}) as { text?: unknown; execute?: unknown });
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) return c.json({ error: 'text required' }, 400);
  return c.json(await runExtractPlayground(c.env, c.get('accountId'), text.slice(0, 4000), b.execute === true));
});

// ---------- Costs ----------
app.get('/api/costs', async (c) => c.json(await computeCosts(c.env, c.get('accountId'), c.req.query('month'))));

export default app;
