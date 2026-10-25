// Minimal ZIP-321 parser: one payment, optional amount and memo.
// Multi-payment URIs and `req-` parameters are rejected outright — this
// wallet builds a single payment and must not ignore a required extension.
// Checksums stay with the engine; this only classifies the address string.
import type { NetworkId } from './engine/port';
import { parseZecAmount } from './units';

export type AddressKind = 'transparent' | 'sapling' | 'unified';

export type Zip321Error =
  | 'not-a-uri'
  | 'invalid'
  | 'multiple-payments'
  | 'unsupported-required'
  | 'memo-on-transparent'
  | 'network-mismatch'
  | 'amount'
  | 'memo';

export type Zip321Result =
  | {
      readonly ok: true;
      readonly address: string;
      readonly kind: AddressKind;
      readonly amountZats: bigint | null;
      readonly memo: string | null;
    }
  | { readonly ok: false; readonly error: Zip321Error };

const BECH32 = /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

interface PrefixRule {
  readonly network: NetworkId;
  readonly kind: AddressKind;
  readonly prefix: string;
  readonly body: 'bech32' | 'base58';
}

const PREFIXES: readonly PrefixRule[] = [
  { network: 'testnet', kind: 'sapling', prefix: 'ztestsapling1', body: 'bech32' },
  { network: 'testnet', kind: 'unified', prefix: 'utest1', body: 'bech32' },
  { network: 'mainnet', kind: 'sapling', prefix: 'zs1', body: 'bech32' },
  { network: 'mainnet', kind: 'unified', prefix: 'u1', body: 'bech32' },
  { network: 'testnet', kind: 'transparent', prefix: 'tm', body: 'base58' },
  { network: 'testnet', kind: 'transparent', prefix: 't2', body: 'base58' },
  { network: 'mainnet', kind: 'transparent', prefix: 't1', body: 'base58' },
  { network: 'mainnet', kind: 'transparent', prefix: 't3', body: 'base58' },
];

export const classifyAddress = (
  address: string,
  network: NetworkId,
): { readonly ok: true; readonly kind: AddressKind; readonly network: NetworkId } | { readonly ok: false; readonly error: 'invalid' | 'network-mismatch' } => {
  const rule = PREFIXES.find((r) => address.startsWith(r.prefix));
  if (rule === undefined) return { ok: false, error: 'invalid' };
  const body = address.slice(rule.prefix.length);
  if (body.length < 20) return { ok: false, error: 'invalid' };
  const alphabet = rule.body === 'bech32' ? BECH32 : BASE58;
  if (!alphabet.test(body)) return { ok: false, error: 'invalid' };
  if (rule.network !== network) return { ok: false, error: 'network-mismatch' };
  return { ok: true, kind: rule.kind, network: rule.network };
};

const PARAM = /^(req-)?([A-Za-z][A-Za-z0-9+-]*?)(?:\.([1-9][0-9]{0,3}))?$/;
const AMOUNT_GRAMMAR = /^[0-9]+(\.[0-9]{1,8})?$/;

interface Slot {
  address?: string;
  amount?: string;
  memo?: string;
}

const decodeMemo = (value: string): string | null | 'bad' => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return 'bad';
  if (value.length === 0) return null;
  const pad = (4 - (value.length % 4)) % 4;
  try {
    const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    if (bytes.length > 512) return 'bad';
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    if (end === 0) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    return 'bad';
  }
};

export const parseZip321 = (uri: string, network: NetworkId): Zip321Result => {
  if (!uri.startsWith('zcash:')) return { ok: false, error: 'not-a-uri' };
  if (/\s/.test(uri)) return { ok: false, error: 'invalid' };
  const rest = uri.slice('zcash:'.length);
  if (rest.startsWith('/') || rest.length === 0) return { ok: false, error: 'invalid' };

  const q = rest.indexOf('?');
  const hier = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? '' : rest.slice(q + 1);
  if (hier !== '' && !/^[A-Za-z0-9]+$/.test(hier)) return { ok: false, error: 'invalid' };

  const slots = new Map<string, Slot>();
  const take = (index: string): Slot => {
    const existing = slots.get(index);
    if (existing !== undefined) return existing;
    const created: Slot = {};
    slots.set(index, created);
    return created;
  };

  if (query !== '') {
    for (const part of query.split('&')) {
      if (part === '') continue;
      const eq = part.indexOf('=');
      const rawName = eq === -1 ? part : part.slice(0, eq);
      const value = eq === -1 ? '' : part.slice(eq + 1);
      const match = PARAM.exec(rawName);
      if (match === null) return { ok: false, error: 'invalid' };
      const required = match[1] === 'req-';
      const name = match[2] ?? '';
      const index = match[3] ?? '';
      if (required) return { ok: false, error: 'unsupported-required' };
      const slot = take(index);
      if (name === 'address') {
        if (slot.address !== undefined || !/^[A-Za-z0-9]+$/.test(value) || value.length === 0) {
          return { ok: false, error: 'invalid' };
        }
        slot.address = value;
      } else if (name === 'amount') {
        if (slot.amount !== undefined) return { ok: false, error: 'invalid' };
        slot.amount = value;
      } else if (name === 'memo') {
        if (slot.memo !== undefined) return { ok: false, error: 'invalid' };
        slot.memo = value;
      }
      // label, message, and any other non-req parameter are ignored.
    }
  }

  if (hier !== '') {
    const primary = take('');
    if (primary.address !== undefined) return { ok: false, error: 'invalid' };
    primary.address = hier;
  }

  const addressed = [...slots.entries()].filter(([, s]) => s.address !== undefined);
  if (addressed.length === 0) return { ok: false, error: 'invalid' };
  if (addressed.length > 1) return { ok: false, error: 'multiple-payments' };
  for (const [, s] of slots) {
    if (s.address === undefined && (s.amount !== undefined || s.memo !== undefined)) {
      return { ok: false, error: 'invalid' };
    }
  }

  const payment = addressed[0]?.[1];
  if (payment?.address === undefined) return { ok: false, error: 'invalid' };
  const classified = classifyAddress(payment.address, network);
  if (!classified.ok) return classified;

  let amountZats: bigint | null = null;
  if (payment.amount !== undefined) {
    if (!AMOUNT_GRAMMAR.test(payment.amount)) return { ok: false, error: 'invalid' };
    const parsed = parseZecAmount(payment.amount);
    if (parsed === null) return { ok: false, error: 'amount' };
    amountZats = parsed;
  }

  let memo: string | null = null;
  if (payment.memo !== undefined) {
    const decoded = decodeMemo(payment.memo);
    if (decoded === 'bad') return { ok: false, error: 'memo' };
    memo = decoded;
  }
  if (memo !== null && classified.kind === 'transparent') {
    return { ok: false, error: 'memo-on-transparent' };
  }

  return { ok: true, address: payment.address, kind: classified.kind, amountZats, memo };
};
