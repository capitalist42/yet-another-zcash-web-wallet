// BIP-39 phrase handling (SDK exposes none) + secret-byte hygiene.
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/** 24 words = 256 bits of entropy, crypto-strength RNG. */
export const generatePhrase = (): string => generateMnemonic(wordlist, 256);

export const validatePhrase = (phrase: string): boolean => validateMnemonic(phrase, wordlist);

/** Normalize user input to a single-spaced lowercase phrase, or throw. */
export const normalizePhrase = (phrase: string): string => {
  const joined = phrase.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0).join(' ');
  if (!validatePhrase(joined)) throw new Error('Invalid recovery phrase');
  return joined;
};

/**
 * SDK contract (docs/api/accounts-signers.md): the `mnemonic` secret input is
 * the UTF-8 phrase BYTES, not BIP-39 seed derivation output.
 */
export const phraseBytes = (phrase: string): Uint8Array => new TextEncoder().encode(phrase);

/** Overwrite every byte; caller retains no other copy. */
export const zeroize = (bytes: Uint8Array): void => {
  bytes.fill(0);
};

