// Overall sync progress across the account's scan range.
//
// The scan work is birthday → target tip, NOT 0 → tip: a wallet restored at
// 2,000,000 of a 3,000,000 chain has 1,000,000 blocks to scan, so `scanned /
// target` (83% at scan start, 99% at 1% done) is never the real percent.
// This module is pure: one place for the clamp rules, directly unit-testable.
import type { EngineSyncStatus } from './engine/port';

export interface SyncProgress {
  /** Overall percent of the birthday→tip range, 0..100; null = not computable. */
  readonly percent: number | null;
  /** Blocks between the scan frontier and the target tip; null = unknown. */
  readonly remaining: number | null;
  readonly done: boolean;
  readonly failed: boolean;
}

/**
 * Percent of the scanned range, capped at 99 while the tip is unreached:
 * the chain grows, so an honest scan is never "100%" until `targetReached`
 * flips — that would flash 100 → 99 → 100 as the target height advances.
 * A null birthday (account not created yet, e.g. mid-create) stays
 * indeterminate rather than assuming a full scan.
 */
export const overallProgress = (s: EngineSyncStatus, birthday: number | null): SyncProgress => {
  const done = s.targetReached;
  const failed = s.activity === 'failed';
  if (done) return { percent: 100, remaining: 0, done, failed };
  if (s.scanned === null || s.target === null || birthday === null)
    return { percent: null, remaining: null, done, failed };
  const remaining = Math.max(0, s.target - s.scanned);
  const span = s.target - Math.max(1, birthday);
  // A brand-new wallet has an empty scan window (birthday ≈ tip): it is done
  // except for the final targetReached flip, so show an almost-full bar.
  if (span <= 0) return { percent: s.scanned >= s.target ? 99 : 0, remaining, done, failed };
  const pct = Math.floor(((s.scanned - Math.max(1, birthday)) / span) * 100);
  return { percent: Math.max(0, Math.min(99, pct)), remaining, done, failed };
};
