// cTrader OAuth + token storage (tokens encrypted at rest).
import type { CtraderAccount, CtraderStatus, Env } from '../types';
import { decrypt, encrypt } from './crypto';
import { getAccountList } from './ctrader';

const AUTH_URL = 'https://id.ctrader.com/my/settings/openapi/grantingaccess/';
const TOKEN_URL = 'https://openapi.ctrader.com/apps/token';
export const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export class BrokerError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

export const ctraderConfigured = (env: Env) => !!(env.CTRADER_CLIENT_ID && env.CTRADER_CLIENT_SECRET);

export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: env.CTRADER_CLIENT_ID ?? '', redirect_uri: redirectUri, scope: 'trading', product: 'web', state });
  return `${AUTH_URL}?${q}`;
}

interface TokenResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  errorCode?: string | null;
  description?: string | null;
}
interface Tokens { accessToken: string; refreshToken: string; expiresAt: number }

async function tokenRequest(env: Env, params: Record<string, string>): Promise<Tokens> {
  const q = new URLSearchParams({ ...params, client_id: env.CTRADER_CLIENT_ID ?? '', client_secret: env.CTRADER_CLIENT_SECRET ?? '' });
  const r = await fetch(`${TOKEN_URL}?${q}`);
  const j = (await r.json().catch(() => ({}))) as TokenResponse;
  if (!r.ok || j.errorCode || !j.accessToken || !j.refreshToken) {
    throw new BrokerError(`cTrader token error: ${j.errorCode ?? r.status}${j.description ? ` ${j.description}` : ''}`, 502);
  }
  return { accessToken: j.accessToken, refreshToken: j.refreshToken, expiresAt: Date.now() + (j.expiresIn ?? 2_628_000) * 1000 };
}

interface AuthRow {
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: number;
  accounts_json: string;
  selected_ctid: number | null;
  selected_is_live: number | null;
}

const row = (env: Env, accountId: string) =>
  env.DB.prepare('SELECT access_token_enc, refresh_token_enc, expires_at, accounts_json, selected_ctid, selected_is_live FROM ctrader_auth WHERE account_id = ?')
    .bind(accountId)
    .first<AuthRow>();

const accountsOf = (r: AuthRow): CtraderAccount[] => {
  try {
    return JSON.parse(r.accounts_json) as CtraderAccount[];
  } catch {
    return [];
  }
};

export async function getStatus(env: Env, accountId: string): Promise<CtraderStatus> {
  const r = await row(env, accountId);
  const accounts = r ? accountsOf(r) : [];
  return {
    configured: ctraderConfigured(env),
    linked: !!r,
    accounts,
    selected: r?.selected_ctid != null ? (accounts.find((a) => a.ctidTraderAccountId === r.selected_ctid) ?? null) : null,
    tokenExpiresAt: r?.expires_at ?? null,
  };
}

/** Exchange an authorization code, store tokens, load accounts, auto-select when there is exactly one. */
export async function linkWithCode(env: Env, accountId: string, code: string, redirectUri: string): Promise<void> {
  const t = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const accounts = await getAccountList(env, t.accessToken);
  const prev = await row(env, accountId);
  let sel = prev?.selected_ctid != null ? accounts.find((a) => a.ctidTraderAccountId === prev.selected_ctid) : undefined;
  if (!sel && accounts.length === 1) sel = accounts[0];
  await env.DB.prepare(
    `INSERT INTO ctrader_auth (account_id, access_token_enc, refresh_token_enc, expires_at, accounts_json, selected_ctid, selected_is_live, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(account_id) DO UPDATE SET access_token_enc = ?2, refresh_token_enc = ?3, expires_at = ?4, accounts_json = ?5, selected_ctid = ?6, selected_is_live = ?7, updated_at = ?8`,
  )
    .bind(accountId, await encrypt(env, t.accessToken), await encrypt(env, t.refreshToken), t.expiresAt, JSON.stringify(accounts), sel?.ctidTraderAccountId ?? null, sel ? (sel.isLive ? 1 : 0) : null, Date.now())
    .run();
}

/** Current access token, refreshed first when it expires within 24 h. */
export async function validAccessToken(env: Env, accountId: string): Promise<{ accessToken: string; row: AuthRow }> {
  const r = await row(env, accountId);
  if (!r) throw new BrokerError('cTrader account not connected', 400);
  if (r.expires_at - Date.now() > REFRESH_WINDOW_MS) return { accessToken: await decrypt(env, r.access_token_enc), row: r };
  const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: await decrypt(env, r.refresh_token_enc) });
  await env.DB.prepare('UPDATE ctrader_auth SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, updated_at = ? WHERE account_id = ?')
    .bind(await encrypt(env, t.accessToken), await encrypt(env, t.refreshToken), t.expiresAt, Date.now(), accountId)
    .run();
  return { accessToken: t.accessToken, row: { ...r, expires_at: t.expiresAt } };
}

export async function selectAccount(env: Env, accountId: string, ctid: number): Promise<CtraderStatus> {
  const r = await row(env, accountId);
  if (!r) throw new BrokerError('cTrader account not connected', 400);
  const a = accountsOf(r).find((x) => x.ctidTraderAccountId === ctid);
  if (!a) throw new BrokerError('ctidTraderAccountId is not in the linked account list', 400);
  await env.DB.prepare('UPDATE ctrader_auth SET selected_ctid = ?, selected_is_live = ?, updated_at = ? WHERE account_id = ?')
    .bind(a.ctidTraderAccountId, a.isLive ? 1 : 0, Date.now(), accountId)
    .run();
  return getStatus(env, accountId);
}

export async function refreshAccounts(env: Env, accountId: string): Promise<CtraderStatus> {
  const { accessToken, row: r } = await validAccessToken(env, accountId);
  const accounts = await getAccountList(env, accessToken);
  const sel = r.selected_ctid != null ? accounts.find((a) => a.ctidTraderAccountId === r.selected_ctid) : undefined;
  const pick = sel ?? (accounts.length === 1 ? accounts[0] : undefined);
  await env.DB.prepare('UPDATE ctrader_auth SET accounts_json = ?, selected_ctid = ?, selected_is_live = ?, updated_at = ? WHERE account_id = ?')
    .bind(JSON.stringify(accounts), pick?.ctidTraderAccountId ?? null, pick ? (pick.isLive ? 1 : 0) : null, Date.now(), accountId)
    .run();
  return getStatus(env, accountId);
}

export async function unlink(env: Env, accountId: string): Promise<CtraderStatus> {
  await env.DB.prepare('DELETE FROM ctrader_auth WHERE account_id = ?').bind(accountId).run();
  return getStatus(env, accountId);
}
