// Copied from the Worker's src/types.ts (bridge protocol).
export interface IncomingMessage {
  messageId: string;
  chatId: string;
  sender: string | null;
  text: string;
  timestamp: number; // unix ms
}

export type WaStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out';
export type WaDesired = 'connected' | 'disconnected' | 'logout';

/** GET /api/bridge/sync */
export interface BridgeSyncResponse {
  accounts: { accountId: string; desired: WaDesired; targetChatId: string | null }[];
  telegram?: { accountId: string; desired: TgDesired; targetChatId: string | null; password?: string }[];
}
export type TgStatus = 'unavailable' | 'disconnected' | 'connecting' | 'qr' | 'password' | 'connected' | 'logged_out';
export type TgDesired = 'connected' | 'disconnected' | 'logout';
export type SignalSource = 'whatsapp' | 'telegram';
/** POST /api/bridge/telegram/state */
export interface BridgeTgStateUpdate {
  accountId: string;
  status: TgStatus;
  qr?: string | null;
  user?: string | null;
  error?: string | null;
}
/** POST /api/bridge/telegram/chats (upsert) */
export interface BridgeTgChatsUpdate {
  accountId: string;
  chats: { id: string; name: string | null; kind: 'channel' | 'group' | 'user' }[];
}
/** POST /api/bridge/state */
export interface BridgeStateUpdate {
  accountId: string;
  status: WaStatus;
  qr?: string | null; // data URL png
  phone?: string | null;
}
/** POST /api/bridge/chats (upsert) */
export interface BridgeChatsUpdate {
  accountId: string;
  chats: { id: string; name: string | null; isGroup: boolean }[];
}
/** POST /api/bridge/message */
export interface BridgeMessage extends IncomingMessage {
  accountId: string;
  source?: SignalSource;
}
