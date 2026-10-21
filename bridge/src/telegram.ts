import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { logger } from './logger.js';
import type { WorkerClient } from './worker-client.js';

export const TG_API_ID = Number(process.env.TELEGRAM_API_ID) || 0;
export const TG_API_HASH = process.env.TELEGRAM_API_HASH || '';
export const tgConfigured = () => TG_API_ID > 0 && !!TG_API_HASH;

const FATAL_AUTH = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/;

function maskPhone(p?: string | null) {
  if (!p) return null;
  return p.length > 5 ? `+${p.replace(/^\+/, '').slice(0, 2)}${'*'.repeat(Math.max(p.length - 5, 2))}${p.slice(-3)}` : p;
}

export class TelegramSession {
  private tg: TelegramClient | null = null;
  private stopped = true;
  private gen = 0;
  private pendingPassword: ((p: string) => void) | null = null;
  private passwordInbox: string | null = null;
  private rejectPassword: ((e: Error) => void) | null = null;
  private log;

  constructor(
    readonly accountId: string,
    public targetChatId: string | null,
    private client: WorkerClient,
    private authDir: string,
  ) {
    this.log = logger.child({ accountId, src: 'telegram' });
  }

  get file() { return path.join(this.authDir, `tg-${this.accountId}.session`); }
  get running() { return !this.stopped; }

  /** Called from sync when the dashboard submitted a 2FA password. */
  providePassword(p: string) {
    if (this.pendingPassword) { const f = this.pendingPassword; this.pendingPassword = null; f(p); }
    else this.passwordInbox = p;
  }

  private state(status: Parameters<WorkerClient['postTgState']>[0]['status'], extra: { qr?: string | null; user?: string | null; error?: string | null } = {}) {
    return this.client.postTgState({ accountId: this.accountId, status, ...extra });
  }

  private async readSession() {
    try { return (await fs.readFile(this.file, 'utf8')).trim(); } catch { return ''; }
  }
  private async deleteSession() { await fs.rm(this.file, { force: true }).catch(() => {}); }
  private async saveSession() {
    if (!this.tg) return;
    await fs.mkdir(this.authDir, { recursive: true });
    await fs.writeFile(this.file, String(this.tg.session.save()), { mode: 0o600 });
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  async start() {
    this.stopped = false;
    const gen = ++this.gen;
    await this.state('connecting');
    try {
      const saved = await this.readSession();
      const tg = new TelegramClient(new StringSession(saved), TG_API_ID, TG_API_HASH, {
        connectionRetries: 10, autoReconnect: true, useWSS: false,
      });
      tg.setLogLevel(LogLevel.WARN);
      this.tg = tg;
      await tg.connect();
      if (gen !== this.gen) return;

      if (!(await tg.checkAuthorization())) {
        if (saved) {
          // stored session no longer valid
          await this.markLoggedOut('Session no longer valid');
          return;
        }
        await this.qrLogin(tg, gen);
        if (gen !== this.gen) return;
        await this.saveSession();
      }
      await this.onReady(tg, gen);
    } catch (e) {
      if (gen !== this.gen || this.stopped) return;
      await this.handleError(e);
    }
  }

  private async qrLogin(tg: TelegramClient, gen: number) {
    await tg.signInUserWithQrCode(
      { apiId: TG_API_ID, apiHash: TG_API_HASH },
      {
        qrCode: async ({ token }) => {
          if (gen !== this.gen) return;
          const url = `tg://login?token=${token.toString('base64url')}`;
          const png = await QRCode.toDataURL(url, { margin: 1, width: 320 });
          await this.state('qr', { qr: png });
        },
        password: async (hint) => {
          if (gen !== this.gen) throw new Error('stopped');
          await this.state('password', { error: this.lastPwError, ...(hint ? {} : {}) });
          this.lastPwError = null;
          if (this.passwordInbox) { const p = this.passwordInbox; this.passwordInbox = null; return p; }
          return new Promise<string>((resolve, reject) => {
            this.pendingPassword = resolve;
            this.rejectPassword = reject;
          });
        },
        onError: async (err) => {
          const msg = (err as any)?.errorMessage || String(err);
          if (msg === 'PASSWORD_HASH_INVALID') {
            this.lastPwError = 'Wrong password';
            return false; // loop calls password() again
          }
          if (/FLOOD|SRP/.test(msg) && gen === this.gen) { this.lastPwError = msg; return false; }
          this.log.warn({ err: msg }, 'telegram login error');
          return true;
        },
      },
    );
  }
  private lastPwError: string | null = null;

  private async onReady(tg: TelegramClient, gen: number) {
    const me = (await tg.getMe()) as Api.User;
    const label = me.username ? `@${me.username}` : [me.firstName, me.lastName].filter(Boolean).join(' ') || maskPhone(me.phone) || 'Telegram user';
    const suffix = me.username && me.phone ? ` (${maskPhone(me.phone)})` : '';
    this.log.info({ user: label }, 'telegram connected');
    tg.addEventHandler((ev) => void this.onMessage(ev, gen), new NewMessage({}));
    await this.state('connected', { user: label + suffix, qr: null, error: null });
    await this.pushChats(tg);
  }

  private async pushChats(tg: TelegramClient) {
    try {
      const dialogs = await tg.getDialogs({ limit: 500 });
      const chats = dialogs.map((d) => ({
        id: String(d.id),
        name: d.title || d.name || null,
        kind: (d.isChannel ? 'channel' : d.isGroup ? 'group' : 'user') as 'channel' | 'group' | 'user',
      })).filter((c) => c.id && c.id !== 'undefined');
      await this.client.postTgChats({ accountId: this.accountId, chats });
    } catch (e) {
      this.log.warn({ err: String(e) }, 'getDialogs failed');
    }
  }

  private async onMessage(ev: NewMessageEvent, gen: number) {
    try {
      if (gen !== this.gen || this.stopped) return;
      const m = ev.message;
      const chatId = m.chatId?.toString();
      if (!chatId || !this.targetChatId || chatId !== this.targetChatId) return;
      const text = (m.message || '').trim();
      if (!text) return;
      let sender: string | null = m.postAuthor || null;
      if (!sender) {
        const s: any = await m.getSender().catch(() => null);
        sender = s ? (s.title || [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || null) : null;
      }
      await this.client.postMessage({
        accountId: this.accountId,
        source: 'telegram',
        messageId: `tg:${chatId}:${m.id}`,
        chatId,
        sender,
        text,
        timestamp: m.date * 1000,
      });
    } catch (e) {
      this.log.warn({ err: String(e) }, 'message handler error');
    }
  }

  private async handleError(e: unknown) {
    const msg = (e as any)?.errorMessage || String(e);
    this.log.error({ err: msg }, 'telegram error');
    if (FATAL_AUTH.test(msg)) { await this.markLoggedOut(); return; }
    await this.teardown();
    this.stopped = true;
    await this.state('disconnected', { error: msg.slice(0, 200) });
  }

  private async markLoggedOut(error?: string) {
    await this.teardown();
    await this.deleteSession();
    this.stopped = true;
    await this.state('logged_out', error ? { error } : {});
  }

  private async teardown() {
    this.gen++;
    this.pendingPassword = null;
    this.rejectPassword?.(new Error('stopped'));
    this.rejectPassword = null;
    this.passwordInbox = null;
    const tg = this.tg;
    this.tg = null;
    if (tg) {
      await Promise.race([tg.destroy().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    }
  }

  async stop(post = true) {
    this.stopped = true;
    await this.teardown();
    if (post) await this.state('disconnected', { qr: null });
  }

  async logout() {
    const tg = this.tg;
    if (tg) { try { await tg.invoke(new Api.auth.LogOut()); } catch { /* best effort */ } }
    this.stopped = true;
    await this.teardown();
    await this.deleteSession();
    await this.state('logged_out');
  }

  /** Logout when no live client exists: try to use the stored session, best effort. */
  static async logoutOffline(s: TelegramSession) {
    const saved = await s.readSession();
    if (saved && tgConfigured()) {
      try {
        const tg = new TelegramClient(new StringSession(saved), TG_API_ID, TG_API_HASH, { connectionRetries: 1 });
        tg.setLogLevel(LogLevel.WARN);
        s.tg = tg;
        await tg.connect();
        await tg.invoke(new Api.auth.LogOut());
      } catch { /* ignore */ }
    }
    await s.logout();
  }
}
