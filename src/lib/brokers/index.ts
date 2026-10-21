import type { AccountInfo, Deal, Env, OrderRequest, PendingOrder, Position, TradeResult } from '../../types';
import { BrokerClient } from '../broker';
import { getConfig } from '../settings';
import { OandaClient } from './oanda';

export interface Broker {
  accountInfo(): Promise<AccountInfo>;
  positions(): Promise<Position[]>;
  orders(): Promise<PendingOrder[]>;
  history(days?: number): Promise<Deal[]>;
  openTrade(req: OrderRequest): Promise<TradeResult>;
  closeTrade(a: { positionId: number; volumeLots?: number }): Promise<TradeResult>;
  test(): Promise<{ ok: boolean; account?: AccountInfo; latencyMs?: number; error?: string }>;
}

/** Broker selected by the account's config (default cTrader). Throws BrokerError 400 when not connected. */
export async function getBroker(env: Env, accountId: string): Promise<Broker> {
  const { broker } = await getConfig(env, accountId);
  return broker === 'oanda' ? OandaClient.forAccount(env, accountId) : BrokerClient.forAccount(env, accountId);
}
