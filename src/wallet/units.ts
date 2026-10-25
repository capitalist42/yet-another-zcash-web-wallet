// Zats formatting for display. Deliberately NOT the SDK formatter: the SDK
// import boundary is engine/adapter.ts only. 1 ZEC = 10^8 zats.
const ZATS_PER_ZEC = 100_000_000n;
/** ZIP-321: a ZEC amount above this is not a monetary value. */
const MAX_ZEC_ZATS = 21_000_000n * ZATS_PER_ZEC;

/**
 * ZIP-321 decimal ZEC → zats. Whole and fraction both nonempty when a point
 * is present; at most 8 fractional digits; leading zeros allowed. Null when
 * the text is not that grammar or the value exceeds 21_000_000 ZEC.
 */
export const parseZecAmount = (text: string): bigint | null => {
  if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const zats = BigInt(whole!) * ZATS_PER_ZEC + BigInt(frac.padEnd(8, '0') || '0');
  if (zats > MAX_ZEC_ZATS) return null;
  return zats;
};

export const formatZats = (zats: bigint): string => {
  const negative = zats < 0n;
  const abs = negative ? -zats : zats;
  const whole = abs / ZATS_PER_ZEC;
  const frac = (abs % ZATS_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  const body = frac === '' ? whole.toString() : `${whole}.${frac}`;
  return negative ? `-${body}` : body;
};
