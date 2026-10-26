import { describe, expect, it } from 'vitest';
import { fingerprintFromUfvk } from './fingerprint';
import { frozenPolicy, RECOVERY_POLICY, storageName, DEFAULT_ENDPOINTS } from './policy';
import { MAINNET_EXPLORER_PRESETS, MAINNET_LIGHTWALLETD_PRESETS, presetById, transactionUrl } from './endpoints';
import { formatZats } from './units';
import { generatePhrase, validatePhrase, phraseBytes, zeroize } from './keys';
import { isNonTerminal } from './engine/port';

describe('fingerprint', () => {
  it('derives a stable 4-char id from the UFVK', async () => {
    const a = await fingerprintFromUfvk('uview1abc');
    const b = await fingerprintFromUfvk('uview1abc');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z2-7]{4}$/);
  });
  it('differs for different UFVKs', async () => {
    const a = await fingerprintFromUfvk('uview1abc');
    const b = await fingerprintFromUfvk('uview1abd');
    expect(a).not.toBe(b);
  });
});

describe('frozen policy (ADR-0005)', () => {
  it('matches the spike-frozen values with transparent sends off', () => {
    const p = frozenPolicy(false);
    expect(p.spendPools).toEqual(['sapling', 'ironwood']);
    expect(p.transparent).toBe('allow-owned');
    expect(p.changePool).toBe('ironwood');
    expect(p.feeRule).toBe('zip317-standard');
    expect(p.expiry).toEqual({ kind: 'offset', blocks: 5 });
    expect(p.lockExpiryBlocks).toBe(20);
    expect(p.shieldingThreshold).toBe(10_000n);
    expect(p.freshness).toEqual({ mode: 'catch-up', maxLagBlocks: 10, timeoutMs: 30_000 });
  });
  it('adds transparent only to spendPools when the switch is on', () => {
    const p = frozenPolicy(true);
    expect(p.spendPools).toEqual(['transparent', 'sapling', 'ironwood']);
    // transparent handling NEVER flips from allow-owned (shielding needs owned spends)
    expect(p.transparent).toBe('allow-owned');
  });
  it('startup recovery is online observe-only (no rebroadcast, ADR-0006)', () => {
    expect(RECOVERY_POLICY).toEqual({ mode: 'online', timeoutMs: 15_000 });
    expect('rebroadcast' in RECOVERY_POLICY).toBe(false);
  });
});

describe('storage naming (ADR-0003)', () => {
  it('names one database per wallet+network', () => {
    expect(storageName('testnet', 'w1')).toBe('yaw-testnet-w1');
    expect(storageName('mainnet', 'w1')).toBe('yaw-mainnet-w1');
  });
});

describe('endpoints', () => {
  it('defaults to the CORS-open gRPC-Web proxies', () => {
    expect(DEFAULT_ENDPOINTS.mainnet).toContain('zcash-mainnet.chainsafe.dev');
    expect(DEFAULT_ENDPOINTS.testnet).toContain('zcash-testnet.chainsafe.dev');
  });
  it('lists the public mainnet lightwalletd servers, with ChainSafe kept as the browser default', () => {
    expect(MAINNET_LIGHTWALLETD_PRESETS[0]?.url).toBe(DEFAULT_ENDPOINTS.mainnet);
    const urls = MAINNET_LIGHTWALLETD_PRESETS.map((preset) => preset.url);
    expect(urls).toContain('https://mainnet.lightwalletd.com:9067');
    for (let n = 1; n <= 8; n += 1) expect(urls).toContain(`https://lwd${n}.zcash-infra.com:9067`);
  });
  it('lists the public mainnet block explorers', () => {
    expect(MAINNET_EXPLORER_PRESETS.map((preset) => preset.url)).toEqual([
      'https://mainnet.zcashexplorer.app/',
      'https://zcashblockexplorer.com/',
      'https://blockchair.com/zcash',
      'https://3xpl.com/zcash',
    ]);
  });
  it('builds a transaction lookup on the selected explorer', () => {
    const zcashExplorer = presetById(MAINNET_EXPLORER_PRESETS, 'zcashexplorer');
    const blockExplorer = presetById(MAINNET_EXPLORER_PRESETS, 'zcashblockexplorer');
    const blockchair = presetById(MAINNET_EXPLORER_PRESETS, 'blockchair');
    const threeXpl = presetById(MAINNET_EXPLORER_PRESETS, '3xpl');
    expect(zcashExplorer).not.toBeNull();
    expect(blockExplorer).not.toBeNull();
    expect(blockchair).not.toBeNull();
    expect(threeXpl).not.toBeNull();
    expect(transactionUrl(zcashExplorer!, 'abc')).toBe('https://mainnet.zcashexplorer.app/transactions/abc');
    expect(transactionUrl(blockExplorer!, 'abc')).toBe('https://zcashblockexplorer.com/transactions/abc');
    expect(transactionUrl(blockchair!, 'abc')).toBe('https://blockchair.com/zcash/transaction/abc');
    expect(transactionUrl(threeXpl!, 'abc')).toBe('https://3xpl.com/zcash/transaction/abc');
  });
});

describe('keys', () => {
  it('generates valid 24-word phrases', () => {
    const p = generatePhrase();
    expect(p.split(' ')).toHaveLength(24);
    expect(validatePhrase(p)).toBe(true);
  });
  it('rejects invalid phrases', () => {
    expect(validatePhrase('abandon abandon abandon')).toBe(false);
    expect(validatePhrase('not a real mnemonic at all')).toBe(false);
  });
  it('phraseBytes is UTF-8 phrase text, not BIP-39 seed', () => {
    const b = phraseBytes('abandon ability');
    expect(Array.from(b)).toEqual([97, 98, 97, 110, 100, 111, 110, 32, 97, 98, 105, 108, 105, 116, 121]);
  });
  it('zeroize clears bytes', () => {
    const b = phraseBytes('secret words');
    zeroize(b);
    expect(b.every((x) => x === 0)).toBe(true);
  });
});

describe('operation phases', () => {
  it('non-terminal phases light the Pending Payments chip', () => {
    for (const phase of ['proposed', 'awaitingAuthorization', 'building', 'ready', 'observing', 'needsAttention'] as const) {
      expect(isNonTerminal(phase)).toBe(true);
    }
    expect(isNonTerminal('complete')).toBe(false);
    expect(isNonTerminal('abandoned')).toBe(false);
  });
});

describe('formatZats', () => {
  it('renders zats as decimal ZEC without float error', () => {
    expect(formatZats(0n)).toBe('0');
    expect(formatZats(100_000_000n)).toBe('1');
    expect(formatZats(100_000_001n)).toBe('1.00000001');
    expect(formatZats(123_456_789_012_345_678n)).toBe('1234567890.12345678');
    expect(formatZats(-250_000_000n)).toBe('-2.5');
  });
});
