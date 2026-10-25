// Shared fixtures for app-level suites (boot + receive): the sync-status
// builder and the deterministic store waiter. `row` stays local per suite —
// each file defaults its own network.
import type { EngineSyncStatus } from './engine/port';

export const syncAt = (scanned: number | null, target: number | null, reached = false): EngineSyncStatus => ({
  activity: 'running',
  scanned,
  target,
  targetReached: reached,
  scanComplete: reached ? true : null,
});

/** Resolve when a store next satisfies `pred` (deterministic, no timers). */
export const until = <T,>(store: { subscribe(fn: (v: T) => void): () => void }, pred: (v: T) => boolean): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const unsub = store.subscribe((v) => {
    if (!pred(v)) return;
    unsub();
    resolve();
  });
  return promise;
};
