import type { Env, ExtractionResult, OrderKind, TradeSide } from '../types';

const FIELDS = {
  action: {
    type: 'text',
    instructions: 'The trade direction word of the signal: BUY or SELL (LONG/SHORT also count). Empty if the message is not a trade signal.',
  },
  order_type: {
    type: 'text',
    instructions: 'The order type wording: "limit", "stop", "now", or "market". Empty if not stated.',
  },
  symbol: { type: 'text', instructions: 'The traded instrument or currency pair, e.g. XAUUSD, GOLD, EURUSD, US30. Empty if none.' },
  entry_price: {
    type: 'number',
    instructions:
      'The entry/open price: the number right after BUY/SELL, LIMIT/STOP, "@", "at" or "entry" (e.g. "SELL LIMIT 2371" → 2371, "BUY @ 2345" → 2345). Never the SL or TP. If a range like 2350-2355 is given, use the first number.',
  },
  entry_price_high: { type: 'number', instructions: 'The second (upper) number of an entry range, if the entry is a range.' },
  stop_loss: { type: 'number', instructions: 'The stop loss (SL) price.' },
  take_profits: { type: 'list', items: 'number', instructions: 'All take profit (TP) price levels, in the order given.' },
  lot_size: { type: 'number', instructions: 'The lot size / volume, if stated.' },
};

interface Answer {
  value: unknown;
  confidence: number | null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, '').replace(/[^\d.+-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

function normSide(v: unknown): TradeSide | null {
  const t = toText(v)?.toUpperCase() ?? '';
  if (/\b(BUY|LONG)\b/.test(t)) return 'BUY';
  if (/\b(SELL|SHORT)\b/.test(t)) return 'SELL';
  return null;
}

// A pending order without an entry stays LIMIT/STOP so validation rejects it; it must never degrade to MARKET.
function normKind(v: unknown): OrderKind {
  const t = toText(v)?.toLowerCase() ?? '';
  if (t.includes('limit')) return 'LIMIT';
  if (t.includes('stop') && !t.includes('loss')) return 'STOP';
  return 'MARKET';
}

/** Every number written in the message (e.g. "1.0900", "2,345.5", "2350-2355" → 2350, 2355). */
function numbersIn(text: string): number[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((m) => parseFloat(m.replace(/,/g, ''))).filter(Number.isFinite);
}

// Prices must appear literally in the message; anything else is a model misread and is dropped.
const inText = (nums: number[], n: number | null) => n == null || nums.some((x) => Math.abs(x - n) <= 1e-9 * Math.max(1, Math.abs(n)));

export async function extractSignal(env: Env, text: string): Promise<ExtractionResult> {
  const res = (await env.AI.run('@cf/cloudflare/clairic', { state: text, fields: FIELDS })) as any;
  const answers: Record<string, any> = res?.answers ?? res?.result?.answers ?? {};

  const fields: ExtractionResult['fields'] = {};
  const get = (k: string): Answer => {
    const a = answers[k];
    const value = a && typeof a === 'object' && 'value' in a ? a.value : (a ?? null);
    const confidence = a && typeof a.confidence === 'number' ? a.confidence : null;
    fields[k] = { value, confidence };
    return { value, confidence };
  };

  const action = get('action');
  const orderType = get('order_type');
  const symbol = get('symbol');
  const entryA = get('entry_price');
  get('entry_price_high');
  const sl = get('stop_loss');
  const tps = get('take_profits');
  const lot = get('lot_size');

  const side = normSide(action.value);
  const rawSymbol = toText(symbol.value)?.toUpperCase().replace(/[\/\s#]/g, '') || null;
  const entry = toNum(entryA.value);
  const list = Array.isArray(tps.value) ? tps.value : tps.value != null ? [tps.value] : [];
  const volume = toNum(lot.value);

  const nums = numbersIn(text);
  const dropped: number[] = [];
  const verify = (n: number | null) => {
    if (inText(nums, n)) return n;
    dropped.push(n as number);
    return null;
  };
  const verifiedTps = list
    .map(toNum)
    .filter((n): n is number => n != null)
    .filter((n) => verify(n) != null);
  const verifiedEntry = verify(entry);
  const verifiedSl = verify(toNum(sl.value));
  if (dropped.length) fields._dropped = { value: dropped, confidence: null };

  return {
    isSignal: !!(side && rawSymbol),
    side,
    orderKind: normKind(orderType.value),
    rawSymbol,
    entry: verifiedEntry,
    stopLoss: verifiedSl,
    takeProfits: verifiedTps,
    volume: volume != null && volume > 0 ? volume : null,
    confidence: side && rawSymbol ? Math.min(action.confidence ?? 0, symbol.confidence ?? 0) : 0,
    fields,
  };
}
