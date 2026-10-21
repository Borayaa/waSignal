import { Hono } from 'hono';
import { clearSession, requireAuth, setSession } from '../lib/auth';
import { decrypt, encrypt, sha256Hex } from '../lib/crypto';
import type { AppBindings } from '../types';

interface AccountRow {
  id: string;
  api_key_enc: string;
  key_preview: string;
  label: string | null;
  created_at: number;
}

// Constant-time comparison (hash both sides so lengths do not leak).
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let d = 0;
  for (let i = 0; i < ha.length; i++) d |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return d === 0 && ha.length === hb.length;
}

const app = new Hono<AppBindings>();

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ apiKey?: unknown; label?: unknown; inviteCode?: unknown }>().catch(() => ({}) as { apiKey?: unknown; label?: unknown; inviteCode?: unknown });
  const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (key.length < 8) return c.json({ error: 'Invalid API key' }, 400);
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null;
  const now = Date.now();
  const keyHash = await sha256Hex(key);

  let acc = await c.env.DB.prepare('SELECT id, api_key_enc, key_preview, label, created_at FROM accounts WHERE key_hash = ?')
    .bind(keyHash)
    .first<AccountRow>();

  if (acc) {
    let healthy = true;
    try {
      healthy = (await decrypt(c.env, acc.api_key_enc)) === key;
    } catch {
      healthy = false;
    }
    const enc = healthy ? acc.api_key_enc : await encrypt(c.env, key);
    await c.env.DB.prepare('UPDATE accounts SET last_login_at = ?, label = COALESCE(?, label), api_key_enc = ? WHERE id = ?')
      .bind(now, label, enc, acc.id)
      .run();
    acc = { ...acc, label: label ?? acc.label };
  } else {
    if (c.env.SIGNUP_ENABLED !== 'true') return c.json({ error: 'Invalid API key' }, 401);
    if (c.env.INVITE_CODE) {
      const given = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
      if (!(await safeEqual(given, c.env.INVITE_CODE))) return c.json({ error: 'Invite code required to create a new account' }, 403);
    }
    const id = crypto.randomUUID();
    const preview = `${key.slice(0, 4)}…${key.slice(-4)}`;
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO accounts (id, key_hash, api_key_enc, key_preview, label, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
        id, keyHash, await encrypt(c.env, key), preview, label, now, now,
      ),
      c.env.DB.prepare("INSERT INTO settings (account_id, config, updated_at) VALUES (?, '{}', ?)").bind(id, now),
      c.env.DB.prepare('INSERT INTO wa_state (account_id, updated_at) VALUES (?, ?)').bind(id, now),
    ]);
    acc = { id, api_key_enc: '', key_preview: preview, label, created_at: now };
  }

  await setSession(c, acc.id);
  return c.json({ id: acc.id, label: acc.label, keyPreview: acc.key_preview });
});

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/me', requireAuth, async (c) => {
  const a = await c.env.DB.prepare('SELECT id, key_preview, label, created_at FROM accounts WHERE id = ?')
    .bind(c.get('accountId'))
    .first<AccountRow>();
  if (!a) {
    clearSession(c);
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return c.json({ id: a.id, label: a.label, keyPreview: a.key_preview, createdAt: a.created_at });
});

export default app;
