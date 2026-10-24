// Wallet identity: 4 characters derived from the UFVK, shown everywhere
// beside the name so the user never acts on the wrong Wallet.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

const base32Chars = (bytes: Uint8Array, count: number): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out.slice(0, count);
};

/** Stable 4-char lowercase base32 of SHA-256(UFVK). */
export const fingerprintFromUfvk = async (ufvk: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ufvk));
  return base32Chars(new Uint8Array(digest), 4);
};
