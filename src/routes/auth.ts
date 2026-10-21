import { Hono } from 'hono';
import { clearSession, requireAuth, setSession } from '../lib/auth';
import { sha256Hex } from '../lib/crypto';
import { dummyHash, hashPassword, validatePassword, validateUsername, verifyPassword } from '../lib/password';
import type { AppBindings } from '../types';

interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  session_version: number;
  failed_logins: number;
  locked_until: number | null;
  created_at: number;
  last_login_at: number | null;
}

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// Constant-time comparison (hash both sides so lengths do not leak).
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let d = 0;
  for (let i = 0; i < ha.length; i++) d |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return d === 0 && ha.length === hb.length;
}

const me = (a: { id: string; username: string; created_at: number; last_login_at: number | null }) => ({
  id: a.id,
  username: a.username,
  createdAt: a.created_at,
  lastLoginAt: a.last_login_at,
});

type Body = Record<string, unknown>;
const readBody = (c: { req: { json: <T>() => Promise<T> } }): Promise<Body> => c.req.json<Body>().catch(() => ({}) as Body);

const app = new Hono<AppBindings>();

app.post('/api/auth/signup', async (c) => {
  const body = await readBody(c);
  if (c.env.SIGNUP_ENABLED !== 'true') return c.json({ error: 'Sign-ups are disabled' }, 403);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = body.password;
  const err = validateUsername(username) ?? validatePassword(password);
  if (err) return c.json({ error: err }, 400);
  if (c.env.INVITE_CODE) {
    const given = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
    if (!(await safeEqual(given, c.env.INVITE_CODE))) return c.json({ error: 'Invalid invite code' }, 403);
  }
  const taken = await c.env.DB.prepare('SELECT 1 AS x FROM accounts WHERE username = ?').bind(username).first();
  if (taken) return c.json({ error: 'Username already taken' }, 409);

  const id = crypto.randomUUID();
  const now = Date.now();
  const hash = await hashPassword(password as string);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO accounts (id, username, password_hash, session_version, created_at, last_login_at) VALUES (?, ?, ?, 1, ?, ?)').bind(
        id, username, hash, now, now,
      ),
      c.env.DB.prepare("INSERT INTO settings (account_id, config, updated_at) VALUES (?, '{}', ?)").bind(id, now),
      c.env.DB.prepare('INSERT INTO wa_state (account_id, updated_at) VALUES (?, ?)').bind(id, now),
      c.env.DB.prepare('INSERT INTO tg_state (account_id, updated_at) VALUES (?, ?)').bind(id, now),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return c.json({ error: 'Username already taken' }, 409);
    throw e;
  }
  await setSession(c, id, 1);
  return c.json(me({ id, username, created_at: now, last_login_at: now }), 201);
});

app.post('/api/auth/login', async (c) => {
  const body = await readBody(c);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const bad = () => c.json({ error: 'Invalid username or password' }, 401);
  if (!username || !password || password.length > 128 || username.length > 64) return bad();

  const acc = await c.env.DB.prepare(
    'SELECT id, username, password_hash, session_version, failed_logins, locked_until, created_at, last_login_at FROM accounts WHERE username = ?',
  )
    .bind(username)
    .first<AccountRow>();

  const now = Date.now();
  if (acc?.locked_until && acc.locked_until > now) {
    const mins = Math.ceil((acc.locked_until - now) / 60000);
    return c.json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` }, 429);
  }

  const ok = await verifyPassword(password, acc ? acc.password_hash : await dummyHash());
  if (!acc || !ok) {
    if (acc) {
      // An expired lock restarts the counter.
      const prev = acc.locked_until && acc.locked_until <= now ? 0 : acc.failed_logins;
      const fails = prev + 1;
      if (fails >= MAX_FAILS) {
        await c.env.DB.prepare('UPDATE accounts SET failed_logins = 0, locked_until = ? WHERE id = ?').bind(now + LOCK_MS, acc.id).run();
      } else {
        await c.env.DB.prepare('UPDATE accounts SET failed_logins = ?, locked_until = NULL WHERE id = ?').bind(fails, acc.id).run();
      }
    }
    return bad();
  }

  await c.env.DB.prepare('UPDATE accounts SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').bind(now, acc.id).run();
  await setSession(c, acc.id, acc.session_version);
  return c.json(me({ ...acc, last_login_at: now }));
});

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/me', requireAuth, async (c) => {
  const a = await c.env.DB.prepare('SELECT id, username, created_at, last_login_at FROM accounts WHERE id = ?')
    .bind(c.get('accountId'))
    .first<AccountRow>();
  if (!a) {
    clearSession(c);
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return c.json(me(a));
});

app.put('/api/auth/password', requireAuth, async (c) => {
  const body = await readBody(c);
  const cur = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const err = validatePassword(body.newPassword);
  if (err) return c.json({ error: err }, 400);
  const id = c.get('accountId');
  const a = await c.env.DB.prepare('SELECT password_hash, session_version FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
  if (!a) {
    clearSession(c);
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (cur.length > 128 || !(await verifyPassword(cur, a.password_hash))) return c.json({ error: 'Current password is incorrect' }, 401);
  const version = a.session_version + 1;
  await c.env.DB.prepare('UPDATE accounts SET password_hash = ?, session_version = ? WHERE id = ?')
    .bind(await hashPassword(body.newPassword as string), version, id)
    .run();
  await setSession(c, id, version);
  return c.json({ ok: true });
});

export default app;
