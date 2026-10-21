import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { safeEqual } from './crypto';
import type { AppBindings } from '../types';

const COOKIE = 'wa_session';
const MAX_AGE = 7 * 24 * 60 * 60;

export async function setSession(c: Context<AppBindings>, accountId: string): Promise<void> {
  const token = await sign({ sub: accountId, exp: Math.floor(Date.now() / 1000) + MAX_AGE }, c.env.SESSION_SECRET, 'HS256');
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: MAX_AGE });
}

export function clearSession(c: Context<AppBindings>): void {
  deleteCookie(c, COOKIE, { path: '/', secure: true });
}

export async function sessionAccountId(c: Context<AppBindings>): Promise<string | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  try {
    const payload = await verify(token, c.env.SESSION_SECRET, 'HS256');
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const id = await sessionAccountId(c);
  if (!id) return c.json({ error: 'Unauthorized' }, 401);
  c.set('accountId', id);
  await next();
};

export const requireBridge: MiddlewareHandler<AppBindings> = async (c, next) => {
  const m = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '');
  if (!c.env.BRIDGE_TOKEN || !m || !safeEqual(m[1], c.env.BRIDGE_TOKEN)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
};
