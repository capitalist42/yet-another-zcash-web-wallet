// The progress bar's overall percent: work done = birthday → tip, not 0 → tip.
import { describe, expect, it } from 'vitest';
import { overallProgress } from './sync-progress';
import type { EngineSyncStatus } from './engine/port';

const status = (over: Partial<EngineSyncStatus> = {}): EngineSyncStatus => ({
  activity: 'running',
  scanned: null,
  target: null,
  targetReached: false,
  scanComplete: null,
  ...over,
});

describe('overallProgress', () => {
  it('measures the scan range from the birthday, not from genesis', () => {
    // Restored at 2,000,000; tip 3,000,000: at scan start the old formula
    // showed 67% with zero blocks scanned. The real answer is 0%.
    const atStart = overallProgress(status({ scanned: 2_000_000, target: 3_000_000 }), 2_000_000);
    expect(atStart.percent).toBe(0);
    expect(atStart.remaining).toBe(1_000_000);
    const half = overallProgress(status({ scanned: 2_500_000, target: 3_000_000 }), 2_000_000);
    expect(half.percent).toBe(50);
    expect(half.remaining).toBe(500_000);
  });

  it('floors to whole percents without rounding up ahead of the scan', () => {
    // span 1_000 (birthday 100_000 → tip 101_000): 99 blocks = 9.9% → 9.
    const p = overallProgress(status({ scanned: 100_099, target: 101_000 }), 100_000);
    expect(p.percent).toBe(9);
  });

  it('caps at 99 until targetReached: the tip moves, so never claim 100 early', () => {
    const caught = overallProgress(status({ scanned: 3_000_000, target: 3_000_000 }), 2_000_000);
    expect(caught.percent).toBe(99);
    expect(caught.done).toBe(false);
    const reached = overallProgress(status({ scanned: 3_000_000, target: 3_000_000, targetReached: true }), 2_000_000);
    expect(reached.percent).toBe(100);
    expect(reached.remaining).toBe(0);
  });

  it('is indeterminate while heights or the birthday are unknown', () => {
    for (const s of [
      status({ target: 3_000_000 }), // no scan frontier yet
      status({ scanned: 2_500_000 }), // no target yet
    ]) {
      const p = overallProgress(s, 2_000_000);
      expect(p.percent).toBeNull();
      expect(p.remaining).toBeNull();
    }
    // Mid-create: the account (and its birthday) does not exist yet.
    const noAccount = overallProgress(status({ scanned: 5, target: 10 }), null);
    expect(noAccount.percent).toBeNull();
  });

  it('shows an almost-full bar for a brand-new wallet caught up to its own birthday', () => {
    // Birthday == tip: the scan window is empty; only targetReached is pending.
    const p = overallProgress(status({ scanned: 3_000_000, target: 3_000_000 }), 3_000_000);
    expect(p.percent).toBe(99);
    expect(p.remaining).toBe(0);
  });

  it('carries failure through without pretending the scan is healthy', () => {
    const p = overallProgress(status({ activity: 'failed', scanned: 1_500_000, target: 3_000_000 }), 1_000_000);
    expect(p.failed).toBe(true);
    expect(p.percent).toBe(25);
    expect(p.remaining).toBe(1_500_000);
  });

  it('clamps a frontier ahead of a re-read target to zero remaining', () => {
    // The target can move backwards when the tip is re-read after a reorg.
    const p = overallProgress(status({ scanned: 3_000_005, target: 3_000_000 }), 2_000_000);
    expect(p.remaining).toBe(0);
    expect(p.percent).toBe(99);
  });
});
