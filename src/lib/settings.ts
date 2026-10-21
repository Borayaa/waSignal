import { DEFAULT_CONFIG, type AccountSettings, type AutomationConfig, type Env } from '../types';

async function configRow(env: Env, accountId: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT config FROM settings WHERE account_id = ?').bind(accountId).first<{ config: string }>();
  return r?.config ?? null;
}

export async function getConfig(env: Env, accountId: string): Promise<AutomationConfig> {
  const raw = await configRow(env, accountId);
  return { ...DEFAULT_CONFIG, ...(raw ? (JSON.parse(raw) as Partial<AutomationConfig>) : {}) };
}

export async function getSettings(env: Env, accountId: string): Promise<AccountSettings> {
  return { config: await getConfig(env, accountId) };
}

/** Merge a partial config. */
export async function saveSettings(env: Env, accountId: string, patch: { config?: Partial<AutomationConfig> }): Promise<AccountSettings> {
  const config = { ...(await getConfig(env, accountId)), ...(patch.config ?? {}) };
  await env.DB.prepare(
    `INSERT INTO settings (account_id, config, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(account_id) DO UPDATE SET config = ?2, updated_at = ?3`,
  )
    .bind(accountId, JSON.stringify(config), Date.now())
    .run();
  return getSettings(env, accountId);
}
