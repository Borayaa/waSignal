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
}
