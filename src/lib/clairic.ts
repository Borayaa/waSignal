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
  stop_loss: {
    type: 'number',
    instructions:
      'The stop loss (SL) as an absolute PRICE level. If the SL is written as a distance in pips/points (e.g. "SL 25 pips"), leave this empty.',
  },
  stop_loss_pips: {
    type: 'number',
    instructions: 'The stop loss distance when written in pips/points (e.g. "SL 25 pips" → 25). Empty if the SL is a price or absent.',
  },
  take_profits: {
    type: 'list',
    items: 'number',
    instructions:
      'All take profit (TP) PRICE levels, in the order given. Distances written in pips/points (e.g. "TP 600 pips") are NOT prices: leave empty for those. Ignore trailing words like "open".',
  },
  take_profit_pips: {
    type: 'list',
    items: 'number',
    instructions: 'All take profit distances written in pips/points (e.g. "TP 600 pips" → 600), in order. Empty if the TPs are prices or absent.',
  },
  entry_time_start: { type: 'text', instructions: 'Start of the entry time window, e.g. "Time entry:20.10-23.20" → "20.10". Empty if no time window.' },
  entry_time_end: { type: 'text', instructions: 'End of the entry time window, e.g. "Time entry:20.10-23.20" → "23.20". Empty if no time window.' },
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

/** "20.10" / "20:10" / "2010" / "9" → "20:10"; invalid → null. */
function normTime(v: unknown): string | null {
  const t = toText(v);
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\s*[.:hH]?\s*(\d{2})$/) ?? t.match(/^(\d{1,2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = m[2] != null ? parseInt(m[2], 10) : 0;
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** A pip distance must be written next to a pips/points unit ("25 pips", "pips: 25"); otherwise the model mislabelled a price. */
function pipsWritten(text: string, n: number): boolean {
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(?:pips?|points?|pts?)\b|\b(?:pips?|points?|pts?)\s*[:=]?\s*(\d[\d,]*(?:\.\d+)?)/gi;
  for (const m of text.matchAll(re)) {
    const v = parseFloat((m[1] ?? m[2]).replace(/,/g, ''));
    if (Math.abs(v - n) <= 1e-9 * Math.max(1, n)) return true;
  }
  return false;
}

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
  const slPipsA = get('stop_loss_pips');
  const tpPipsA = get('take_profit_pips');
  const tStart = get('entry_time_start');
  const tEnd = get('entry_time_end');

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
  const tpPipSet = new Set(tpPipsA.value == null ? [] : (Array.isArray(tpPipsA.value) ? tpPipsA.value : [tpPipsA.value]).map(toNum));
  const verifiedTps0 = list
    .map(toNum)
    .filter((n): n is number => n != null)
    .filter((n) => verify(n) != null);
  const pipList = Array.isArray(tpPipsA.value) ? tpPipsA.value : tpPipsA.value != null ? [tpPipsA.value] : [];
  const verifiedTpPips = pipList
    .map(toNum)
    .filter((n): n is number => n != null && n > 0 && pipsWritten(text, n))
    .filter((n) => verify(n) != null);
  const slPipsRaw = toNum(slPipsA.value);
  const verifiedSlPips = slPipsRaw != null && slPipsRaw > 0 && pipsWritten(text, slPipsRaw) ? verify(slPipsRaw) : null;
  const ws = normTime(tStart.value);
  const we = normTime(tEnd.value);
  const verifiedEntry = verify(entry);
  let verifiedSl = verify(toNum(sl.value));
  // The model sometimes echoes a pip distance into the price field; a pip value is never a price.
  if (verifiedSl != null && verifiedSlPips === verifiedSl) verifiedSl = null;
  const verifiedTps = verifiedTps0.filter((n) => !tpPipSet.has(n));
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
    stopLossPips: verifiedSlPips,
    takeProfitPips: verifiedTpPips,
    entryWindow: ws && we ? { start: ws, end: we } : null,
    symbolFromDefault: false,
    confidence: side && rawSymbol ? Math.min(action.confidence ?? 0, symbol.confidence ?? 0) : 0,
    fields,
  };
}
