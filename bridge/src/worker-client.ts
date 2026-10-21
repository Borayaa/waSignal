import { logger } from './logger.js';
import type {
  BridgeChatsUpdate, BridgeMessage, BridgeStateUpdate, BridgeSyncResponse,
} from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WorkerClient {
  constructor(private baseUrl: string, private token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Returns parsed JSON, or null on failure. Never throws. */
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
    const url = this.baseUrl + path;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return (await res.json().catch(() => ({}))) as T;
        if (res.status >= 500) {
          logger.warn({ path, status: res.status, attempt }, 'worker 5xx');
        } else {
          logger.error({ path, status: res.status, text: (await res.text().catch(() => '')).slice(0, 300) }, 'worker 4xx');
          return null;
        }
      } catch (err) {
        logger.warn({ path, attempt, err: String(err) }, 'worker request failed');
      }
      if (attempt < 3) await sleep(500 * 2 ** (attempt - 1));
    }
    return null;
  }

  sync() { return this.request<BridgeSyncResponse>('GET', '/api/bridge/sync'); }
  postState(u: BridgeStateUpdate) { return this.request('POST', '/api/bridge/state', u); }
  async postChats(u: BridgeChatsUpdate) {
    for (let i = 0; i < u.chats.length; i += 500) {
      await this.request('POST', '/api/bridge/chats', { accountId: u.accountId, chats: u.chats.slice(i, i + 500) });
    }
  }
  postMessage(m: BridgeMessage) { return this.request('POST', '/api/bridge/message', m); }
}
