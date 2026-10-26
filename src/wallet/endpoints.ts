// Public mainnet endpoints for wallet sync and transaction lookup.
// Lightwalletd list and block explorers are the servers published for mainnet.
// ChainSafe stays the default: it is the CORS-open gRPC-Web proxy this
// browser wallet can sync with (ADR-0001). The other lightwalletd servers
// are selectable; a failed open restores the previous one.
export interface EndpointPreset {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

export interface ExplorerPreset extends EndpointPreset {
  /** Path under `url` for one transaction, without a leading slash. */
  readonly txPath: string;
}

export const DEFAULT_LIGHTWALLETD_ID = 'chainsafe';
export const DEFAULT_EXPLORER_ID = 'zcashexplorer';

export const LIGHTWALLETD_PREF_KEY = 'yaw-mainnet-lightwalletd';
export const EXPLORER_PREF_KEY = 'yaw-mainnet-explorer';

/** Mainnet lightwalletd servers. ChainSafe is the browser default. */
export const MAINNET_LIGHTWALLETD_PRESETS: readonly EndpointPreset[] = [
  { id: 'chainsafe', label: 'ChainSafe', url: 'https://zcash-mainnet.chainsafe.dev' },
  { id: 'mainnet.lightwalletd.com', label: 'mainnet.lightwalletd.com', url: 'https://mainnet.lightwalletd.com:9067' },
  { id: 'lwd1.zcash-infra.com', label: 'lwd1.zcash-infra.com', url: 'https://lwd1.zcash-infra.com:9067' },
  { id: 'lwd2.zcash-infra.com', label: 'lwd2.zcash-infra.com', url: 'https://lwd2.zcash-infra.com:9067' },
  { id: 'lwd3.zcash-infra.com', label: 'lwd3.zcash-infra.com', url: 'https://lwd3.zcash-infra.com:9067' },
  { id: 'lwd4.zcash-infra.com', label: 'lwd4.zcash-infra.com', url: 'https://lwd4.zcash-infra.com:9067' },
  { id: 'lwd5.zcash-infra.com', label: 'lwd5.zcash-infra.com', url: 'https://lwd5.zcash-infra.com:9067' },
  { id: 'lwd6.zcash-infra.com', label: 'lwd6.zcash-infra.com', url: 'https://lwd6.zcash-infra.com:9067' },
  { id: 'lwd7.zcash-infra.com', label: 'lwd7.zcash-infra.com', url: 'https://lwd7.zcash-infra.com:9067' },
  { id: 'lwd8.zcash-infra.com', label: 'lwd8.zcash-infra.com', url: 'https://lwd8.zcash-infra.com:9067' },
];

/** Mainnet block explorers. A lookup is a user click, not a background fetch. */
export const MAINNET_EXPLORER_PRESETS: readonly ExplorerPreset[] = [
  { id: 'zcashexplorer', label: 'Zcash Explorer', url: 'https://mainnet.zcashexplorer.app/', txPath: 'transactions/' },
  { id: 'zcashblockexplorer', label: 'Zcash Block Explorer', url: 'https://zcashblockexplorer.com/', txPath: 'transactions/' },
  { id: 'blockchair', label: 'Blockchair', url: 'https://blockchair.com/zcash', txPath: 'transaction/' },
  { id: '3xpl', label: '3xpl', url: 'https://3xpl.com/zcash', txPath: 'transaction/' },
];

export const presetById = <T extends { readonly id: string }>(presets: readonly T[], id: string): T | null =>
  presets.find((preset) => preset.id === id) ?? null;

const readRawPref = (key: string): string | null => {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

export const writeEndpointPref = (key: string, id: string): void => {
  try {
    globalThis.localStorage?.setItem(key, id);
  } catch {
    // Private mode can reject storage; the in-memory choice still applies this tab.
  }
};

/** Saved preset id, or `fallback` when missing or not in the list. */
export const readPresetId = (key: string, presets: readonly { readonly id: string }[], fallback: string): string => {
  const id = readRawPref(key);
  return id !== null && presetById(presets, id) !== null ? id : fallback;
};

/** Saved mainnet lightwalletd URL, or null when the user has not chosen one. */
export const savedLightwalletdUrl = (): string | null => {
  const id = readRawPref(LIGHTWALLETD_PREF_KEY);
  if (id === null) return null;
  return presetById(MAINNET_LIGHTWALLETD_PRESETS, id)?.url ?? null;
};

export const transactionUrl = (preset: ExplorerPreset, txid: string): string => {
  const base = preset.url.endsWith('/') ? preset.url : `${preset.url}/`;
  return `${base}${preset.txPath}${encodeURIComponent(txid)}`;
};
