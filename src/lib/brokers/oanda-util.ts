// Pure helpers for the OANDA client (no I/O) so they can be unit-checked.

const INDEX_MAP: Record<string, string> = {
  US30: 'US30_USD', NAS100: 'NAS100_USD', SPX500: 'SPX500_USD', GER40: 'DE30_EUR', UK100: 'UK100_GBP', JP225: 'JP225_USD',
};

/** Broker symbol (after alias mapping) -> OANDA instrument name. */
export function toOandaInstrument(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/[\s/]/g, '');
  if (s.includes('_')) return s;
  if (INDEX_MAP[s]) return INDEX_MAP[s];
  if (/^[A-Z]{6}$/.test(s)) return `${s.slice(0, 3)}_${s.slice(3)}`;
  return s;
}

/** Units of the instrument per 1.00 lot. `type` is OANDA's instrument type (CURRENCY | METAL | CFD) when known. */
export function unitsPerLot(instrument: string, type?: string | null): number {
  if (instrument.startsWith('XAU_')) return 100;
  if (instrument.startsWith('XAG_')) return 5000;
  const t = (type ?? '').toUpperCase();
  if (t === 'CURRENCY' || t === 'METAL') return 100_000;
  if (t === 'CFD') return 1;
  return /^(X[A-Z]{2}|[A-Z]{3})_[A-Z]{3}$/.test(instrument) && !/\d/.test(instrument) && !/^(BCO|WTICO|NATGAS|SUGAR|CORN|SOYBN|WHEAT|XCU)_/.test(instrument) ? 100_000 : 1;
}

export const formatPrice = (v: number, displayPrecision: number): string => v.toFixed(displayPrecision);

/** lots -> signed units string at tradeUnitsPrecision, clamped to [minimumTradeSize, maximumOrderUnits]. */
export function lotsToUnits(lots: number, perLot: number, side: 'BUY' | 'SELL', precision: number, min: number, max: number): string {
  const f = 10 ** precision;
  let u = Math.round(lots * perLot * f) / f;
  u = Math.max(min, Math.min(max, u));
  return (side === 'SELL' ? -u : u).toFixed(precision);
}

/** unix ms -> RFC3339 (nanosecond form OANDA itself uses). */
export const toRfc3339 = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.000000000Z');
