// Frozen TransactionPolicy (ADR-0005): supplied ONLY at client creation, never
// per-send. Values exactly as the ticket-#2 spike froze them; the single axis
// is the "Allow transparent sends" Settings switch (default off), which adds
// 'transparent' to spendPools ONLY — `transparent` itself stays 'allow-owned'
// forever, because shielding spends owned transparent inputs.
import type { NetworkId } from './engine/port';

export interface FrozenPolicy {
  readonly spendPools: readonly ('transparent' | 'sapling' | 'ironwood')[];
  /** ADR-0005: 'allow-owned' forever — 'disallow' starves shielding's owned
   * transparent spend and cannot ship; not a configurable axis. */
  readonly transparent: 'allow-owned';
  readonly changePool: 'sapling' | 'ironwood';
  readonly feeRule: 'zip317-standard';
  readonly confirmations: {
    readonly trusted: number;
    readonly untrusted: number;
    readonly allowZeroConfirmationShielding: boolean;
  };
  readonly expiry: { readonly kind: 'offset'; readonly blocks: number };
  readonly lockExpiryBlocks: number;
  readonly shieldingThreshold: bigint;
  readonly freshness: {
    readonly mode: 'catch-up';
    readonly maxLagBlocks: number;
    readonly timeoutMs: number;
  };
}

export const frozenPolicy = (allowTransparentSends: boolean): FrozenPolicy => ({
  spendPools: allowTransparentSends
    ? (['transparent', 'sapling', 'ironwood'] as const)
    : (['sapling', 'ironwood'] as const),
  transparent: 'allow-owned',
  changePool: 'ironwood',
  feeRule: 'zip317-standard',
  confirmations: { trusted: 1, untrusted: 1, allowZeroConfirmationShielding: false },
  expiry: { kind: 'offset', blocks: 5 },
  lockExpiryBlocks: 20,
  shieldingThreshold: 10_000n,
  freshness: { mode: 'catch-up', maxLagBlocks: 10, timeoutMs: 30_000 },
});

/**
 * Startup recovery (ADR-0006): observe-only. `rebroadcast` deliberately
 * omitted — automatic re-dispatch is rejected; every retry is a user Resume
 * on the Pending Payments surface (#10).
 */
export const RECOVERY_POLICY: { mode: 'online'; timeoutMs: number } = {
  mode: 'online',
  timeoutMs: 15_000,
};

/**
 * "Allow transparent sends" Settings switch (ADR-0005). The switch itself
 * lands in #12; until then every Client is opened with it off, and Send
 * refuses a transparent recipient on the same flag.
 */
export const ALLOW_TRANSPARENT_SENDS = false;

/** Per-network default endpoint. A saved mainnet choice in `endpoints.ts`
 * replaces `mainnet`. Free-text override lands in #12. */
export interface EndpointSettings {
  readonly mainnet: string;
  readonly testnet: string;
}

// ADR-0001: third-party CORS-open gRPC-Web proxies as defaults, disclosed.
export const DEFAULT_ENDPOINTS: EndpointSettings = {
  mainnet: 'https://zcash-mainnet.chainsafe.dev',
  testnet: 'https://zcash-testnet.chainsafe.dev',
};

/** Upper bound on endpoint latency for a pre-mutation freshness pass; NOT a
 * scan budget (create's SYNC_REQUIRED retry is the correctness mechanism). */
export const FRESHNESS_TIMEOUT_MS = 30_000;

/** One OPFS database per Wallet, per network (ADR-0003). */
export const storageName = (network: NetworkId, walletId: string): string => `yaw-${network}-${walletId}`;
