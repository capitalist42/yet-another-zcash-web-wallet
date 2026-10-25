// ZIP-321 minimal parser (issue #5): one payment, amount, memo. Expected
// values are the ZIP's own worked examples, not recomputed by the parser.
import { describe, expect, it } from 'vitest';
import { parseZecAmount } from './units';
import { parseZip321 } from './zip321';

const SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const TRANSPARENT = 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU';
/** ZIP-321 worked example: base64url("This is a simple memo.") */
const SIMPLE_MEMO = 'VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg';

describe('parseZecAmount', () => {
  it('reads whole and fractional ZEC as zats', () => {
    expect(parseZecAmount('1')).toBe(100_000_000n);
    expect(parseZecAmount('50')).toBe(5_000_000_000n);
    expect(parseZecAmount('50.00')).toBe(5_000_000_000n);
    expect(parseZecAmount('050')).toBe(5_000_000_000n);
    expect(parseZecAmount('0.5')).toBe(50_000_000n);
    expect(parseZecAmount('00.500')).toBe(50_000_000n);
    expect(parseZecAmount('0.00000001')).toBe(1n);
    expect(parseZecAmount('21000000')).toBe(2_100_000_000_000_000n);
  });

  it('rejects amounts the ZIP rejects', () => {
    expect(parseZecAmount('')).toBeNull();
    expect(parseZecAmount('.5')).toBeNull();
    expect(parseZecAmount('50.')).toBeNull();
    expect(parseZecAmount('50,000')).toBeNull();
    expect(parseZecAmount('0.123456789')).toBeNull();
    expect(parseZecAmount('21000000.00000001')).toBeNull();
    expect(parseZecAmount('21000001')).toBeNull();
    expect(parseZecAmount('-1')).toBeNull();
    expect(parseZecAmount('1e2')).toBeNull();
  });
});

describe('parseZip321', () => {
  it('prefills address, amount, and memo from the ZIP single-payment example', () => {
    const uri = `zcash:${SAPLING}?amount=1&memo=${SIMPLE_MEMO}&message=Thank%20you%20for%20your%20purchase`;
    expect(parseZip321(uri, 'testnet')).toEqual({
      ok: true,
      address: SAPLING,
      kind: 'sapling',
      amountZats: 100_000_000n,
      memo: 'This is a simple memo.',
    });
  });

  it('accepts the address as a query parameter', () => {
    const uri = `zcash:?address=${SAPLING}&amount=0.5&memo=${SIMPLE_MEMO}`;
    expect(parseZip321(uri, 'testnet')).toMatchObject({
      ok: true,
      address: SAPLING,
      amountZats: 50_000_000n,
      memo: 'This is a simple memo.',
    });
  });

  it('accepts a bare zcash: address with no query', () => {
    expect(parseZip321(`zcash:${SAPLING}`, 'testnet')).toEqual({
      ok: true,
      address: SAPLING,
      kind: 'sapling',
      amountZats: null,
      memo: null,
    });
  });

  it('rejects a memo on a transparent address', () => {
    expect(parseZip321(`zcash:${TRANSPARENT}?amount=1&memo=${SIMPLE_MEMO}`, 'testnet')).toEqual({
      ok: false,
      error: 'memo-on-transparent',
    });
  });

  it('rejects a second payment', () => {
    const uri =
      `zcash:?address=${TRANSPARENT}&amount=123.456` +
      `&address.1=${SAPLING}&amount.1=0.789&memo.1=${SIMPLE_MEMO}`;
    expect(parseZip321(uri, 'testnet')).toEqual({ ok: false, error: 'multiple-payments' });
  });

  it('rejects required parameters this wallet does not understand', () => {
    expect(parseZip321(`zcash:${SAPLING}?req-asset=AAAA&amount=1`, 'testnet')).toEqual({
      ok: false,
      error: 'unsupported-required',
    });
  });

  it('rejects percent-encoding in an amount', () => {
    expect(parseZip321(`zcash:${TRANSPARENT}?amount=1%30`, 'testnet')).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('rejects a mainnet address while the wallet is on testnet', () => {
    expect(parseZip321('zcash:u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq?amount=1', 'testnet')).toEqual({
      ok: false,
      error: 'network-mismatch',
    });
  });

  it('rejects a duplicate amount', () => {
    expect(parseZip321(`zcash:${SAPLING}?amount=1&amount=2`, 'testnet')).toEqual({
      ok: false,
      error: 'invalid',
    });
  });

  it('does not treat a plain address as a URI', () => {
    expect(parseZip321(SAPLING, 'testnet')).toEqual({ ok: false, error: 'not-a-uri' });
  });
});
