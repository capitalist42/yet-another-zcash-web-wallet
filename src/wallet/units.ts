// Zats formatting for display. Deliberately NOT the SDK formatter: the SDK
// import boundary is engine/adapter.ts only. 1 ZEC = 10^8 zats.
const ZATS_PER_ZEC = 100_000_000n;

export const formatZats = (zats: bigint): string => {
  const negative = zats < 0n;
  const abs = negative ? -zats : zats;
  const whole = abs / ZATS_PER_ZEC;
  const frac = (abs % ZATS_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  const body = frac === '' ? whole.toString() : `${whole}.${frac}`;
  return negative ? `-${body}` : body;
};
