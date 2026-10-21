// Product composition root: real engine + IndexedDB registry + app service.
// Created once per page load; StrictMode-safe via the module-level singleton.
import { createWalletApp, type WalletApp } from '../wallet/app';
import { createAdapterEngine } from '../wallet/engine/adapter';
import { createRegistry, idbRegistryStore } from '../wallet/registry';
import { DEFAULT_ENDPOINTS } from '../wallet/policy';

let instance: WalletApp | null = null;

export const getApp = (): WalletApp => {
  if (instance === null) {
    instance = createWalletApp({
      engine: createAdapterEngine(),
      registry: createRegistry(idbRegistryStore()),
      endpoints: DEFAULT_ENDPOINTS,
      // OPFS eviction guard, requested at Wallet creation (issue #3).
      requestPersist: async () => (await navigator.storage?.persist?.()) === true,
    });
  }
  return instance;
};

let bootStarted = false;

export const startApp = (): void => {
  if (bootStarted) return;
  bootStarted = true;
  void getApp().boot();
};
