import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser,
  useMultiFileAuthState, type WASocket, type proto,
} from 'baileys';
import pino from 'pino';
import { logger } from './logger.js';
import type { WorkerClient } from './worker-client.js';

type ChatInfo = { name: string | null; isGroup: boolean };

export function extractText(message: proto.IMessage | null | undefined): string {
  let m: proto.IMessage | null | undefined = message;
  for (let i = 0; m && i < 6; i++) {
    const inner =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.viewOnceMessageV2Extension?.message ??
      m.documentWithCaptionMessage?.message ??
      m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  if (!m) return '';
  // editedMessage content may be a protocolMessage wrapper
  const edited = m.protocolMessage?.editedMessage;
  if (edited) return extractText(edited);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
}

export class Session {
  private sock: WASocket | null = null;
  private stopped = false;
  private retry = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private chatTimer: NodeJS.Timeout | null = null;
  private chats = new Map<string, ChatInfo>();
  private dirty = new Set<string>();
  private gen = 0;

  constructor(
    readonly accountId: string,
    public targetChatId: string | null,
    private client: WorkerClient,
    private authDir: string,
  ) {}

  get dir() { return path.join(this.authDir, this.accountId); }
  get running() { return !this.stopped; }

  async start() {
    this.stopped = false;
    this.retry = 0;
    await this.client.postState({ accountId: this.accountId, status: 'connecting' });
    await this.connect();
  }

  private async connect() {
    if (this.stopped) return;
    const gen = ++this.gen;
    const log = logger.child({ accountId: this.accountId });
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.dir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        logger: pino({ level: 'warn' }) as any,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
      } as any);
      this.sock = sock;

      sock.ev.on('creds.update', () => { saveCreds().catch((e) => log.error({ err: String(e) }, 'saveCreds')); });

      sock.ev.on('connection.update', async (u) => {
        if (gen !== this.gen || this.stopped) return;
        try {
          if (u.qr) {
            const qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
            await this.client.postState({ accountId: this.accountId, status: 'qr', qr });
          }
          if (u.connection === 'open') {
            this.retry = 0;
            const phone = sock.user?.id ? jidNormalizedUser(sock.user.id).split('@')[0] : null;
            await this.client.postState({ accountId: this.accountId, status: 'connected', phone, qr: null });
            await this.fetchGroups();
          }
          if (u.connection === 'close') {
            const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
            log.info({ code }, 'connection closed');
            if (code === DisconnectReason.loggedOut) {
              await this.wipe();
              this.stopped = true;
              this.sock = null;
              await this.client.postState({ accountId: this.accountId, status: 'logged_out', qr: null, phone: null });
            } else if (!this.stopped) {
              await this.client.postState({ accountId: this.accountId, status: 'connecting' });
              this.scheduleReconnect();
            }
          }
        } catch (e) {
          log.error({ err: String(e) }, 'connection.update handler');
        }
      });

      sock.ev.on('messaging-history.set', ({ chats, contacts }) => {
        for (const c of chats ?? []) this.addChat(c.id, (c as any).name ?? (c as any).displayName);
        for (const c of contacts ?? []) this.addChat(c.id, c.name ?? c.notify);
      });
      sock.ev.on('chats.upsert', (list) => { for (const c of list) this.addChat(c.id, (c as any).name); });
      sock.ev.on('contacts.upsert', (list) => { for (const c of list) this.addChat(c.id, c.name ?? c.notify); });
      sock.ev.on('groups.upsert', (list) => { for (const g of list) this.addChat(g.id, g.subject); });

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          try {
            const chatId = msg.key.remoteJid;
            if (!chatId || !this.targetChatId || chatId !== this.targetChatId) continue;
            const text = extractText(msg.message);
            if (!text || !msg.key.id) continue;
            const ts = Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000;
            void this.client.postMessage({
              accountId: this.accountId,
              messageId: msg.key.id,
              chatId,
              sender: msg.pushName || msg.key.participant || chatId,
              text,
              timestamp: ts,
            });
          } catch (e) {
            log.error({ err: String(e) }, 'message handler');
          }
        }
      });
    } catch (e) {
      log.error({ err: String(e) }, 'connect failed');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.endSocket();
      void this.connect();
    }, delay);
  }

  private async fetchGroups() {
    if (!this.sock) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const g of Object.values(groups)) this.addChat(g.id, g.subject);
    } catch (e) {
      logger.warn({ accountId: this.accountId, err: String(e) }, 'groupFetchAllParticipating failed');
    }
  }

  private addChat(id: string | null | undefined, name?: string | null) {
    if (!id || id === 'status@broadcast' || id.endsWith('@newsletter') || id.endsWith('@broadcast')) return;
    const prev = this.chats.get(id);
    const isGroup = id.endsWith('@g.us');
    const newName = name || prev?.name || null;
    if (prev && prev.name === newName) return;
    this.chats.set(id, { name: newName, isGroup });
    this.dirty.add(id);
    if (!this.chatTimer) {
      this.chatTimer = setTimeout(() => { this.chatTimer = null; void this.flushChats(); }, 2000);
    }
  }

  private async flushChats() {
    const ids = [...this.dirty];
    this.dirty.clear();
    if (!ids.length) return;
    const chats = ids.map((id) => ({ id, name: this.chats.get(id)!.name, isGroup: this.chats.get(id)!.isGroup }));
    await this.client.postChats({ accountId: this.accountId, chats });
  }

  private endSocket() {
    const s = this.sock;
    this.sock = null;
    this.gen++;
    if (s) {
      try { s.ev.removeAllListeners('connection.update'); s.end(undefined); } catch { /* ignore */ }
    }
  }

  /** Stop socket, keep creds. */
  async stop(postState = true) {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.chatTimer) clearTimeout(this.chatTimer);
    this.chatTimer = null;
    this.endSocket();
    if (postState) await this.client.postState({ accountId: this.accountId, status: 'disconnected', qr: null });
  }

  /** Log out and delete creds. */
  async logout() {
    const s = this.sock;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (s) { try { await s.logout(); } catch { /* ignore */ } }
    this.endSocket();
    await this.wipe();
    await this.client.postState({ accountId: this.accountId, status: 'logged_out', qr: null, phone: null });
  }

  async wipe() {
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
