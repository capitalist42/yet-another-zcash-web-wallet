// Ticket #2 spike UI: step buttons + state panel + log. Throwaway; no product UI.
import { useCallback, useEffect, useRef, useState } from 'react';
import { dump, loadCtx, persistCtx, purgeSpikeDatabases, resetSession } from './core';
import type { Ctx, StepName, StepResult } from './core';
import {
  closeAll,
  openA,
  openB,
  step1a_createA,
  step1b_currentNull,
  step1c_nextMints,
  step1d_syncTip,
  stepP1_shieldDisallow,
  stepP2_shieldAllowOwned,
  stepP3_directTransparentSend,
  stepP4_shieldExecute,
  stepS3_shieldSend,
  stepS3b_memoSend,
  stepS3c_historyBoth,
  stepS4_submitUnknown,
  stepS4b_resumeMined,
  stepS5_reloadSane,
  stepS5b_armMidSync,
  stepS5b_resumeMidSync,
  step_faucetT,
} from './steps';

interface StepDef {
  name: StepName;
  label: string;
  run: (ctx: Ctx) => Promise<void>;
}

const HANG_ENDPOINT = 'http://127.0.0.1:8081';
const STEPS: StepDef[] = [
  { name: 'S1a-create-A', label: 'S1a open A(disallow)+create', run: (c) => step1a_createA(c, 'disallow') },
  { name: 'S1b-current-probe', label: 'S1b current() probe (fresh)', run: step1b_currentNull },
  { name: 'S1c-next-mints', label: 'S1c next() mints + t-address', run: step1c_nextMints },
  { name: 'S1d-sync-tip', label: 'S1d sync to tip', run: step1d_syncTip },
  { name: 'FAUCET-t', label: 'Faucet drip -> transparent', run: step_faucetT },
  { name: 'P1-shield-disallow', label: 'P1 shield() under disallow', run: async (c) => { await openA(c, 'disallow'); await stepP1_shieldDisallow(c); } },
  { name: 'P2-shield-allow-owned', label: 'P2 reopen allow-owned: proposals', run: stepP2_shieldAllowOwned },
  { name: 'P3-direct-transparent-send', label: 'P3 t-spend under disallow => reject', run: async (c) => { await openA(c, 'disallow'); await stepP3_directTransparentSend(c); } },
  { name: 'P4-shield-execute', label: 'P4 reviewed shield propose->send (mine)', run: async (c) => { await openA(c, 'allow-owned'); await stepP4_shieldExecute(c); } },
  {
    name: 'S3-shield-send',
    label: 'S3 open B + A->B shielded send',
    run: async (c) => {
      await openB(c);
      await stepS3_shieldSend(c);
    },
  },
  { name: 'S3b-memo-send', label: 'S3b memo round trip', run: stepS3b_memoSend },
  { name: 'S3c-history-both', label: 'S3c history both sides', run: stepS3c_historyBoth },
  {
    name: 'S4-submit-unknown',
    label: 'S4 send via hang proxy => UNKNOWN',
    run: async (c) => {
      await openA(c, 'allow-owned', HANG_ENDPOINT);
      await stepS4_submitUnknown(c);
    },
  },
  { name: 'S4b-resume-mined', label: 'S4b reopen normal + resume', run: async (c) => {
      await openA(c, 'allow-owned');
      await stepS4b_resumeMined(c);
    } },
  { name: 'S5-reload-sane', label: 'S5 reopen after reload', run: stepS5_reloadSane },
  // AC3 pair: arm opens C + fullScan import and starts the scan; then the
  // RAW RELOAD button (below) kills the tab mid-flight — NO closeAll, that
  // would be a clean shutdown and hide exactly what AC3 tests.
  { name: 'S5b-midsync-arm', label: 'S5b arm mid-scan (C fullScan)', run: stepS5b_armMidSync },
  { name: 'S5b-midsync-resume', label: 'S5b resume after mid-sync reload', run: stepS5b_resumeMidSync },
];

const badge = (r: StepResult | undefined): string => (r === undefined ? '·' : r.ok ? 'PASS' : 'FAIL');

export default function SpikeApp() {
  const ctxRef = useRef<Ctx | null>(null);
  if (ctxRef.current === null) ctxRef.current = loadCtx();
  const ctx = ctxRef.current;
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    const id = setInterval(refresh, 2_000);
    return () => clearInterval(id);
  }, [refresh]);

  const runStep = async (def: StepDef): Promise<void> => {
    setBusy(def.name);
    try {
      await def.run(ctx);
    } finally {
      persistCtx(ctx);
      setBusy(null);
      refresh();
    }
  };

  const download = (): void => {
    const blob = new Blob([dump(ctx)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yaw-spike-${new Date().toISOString()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ fontFamily: 'monospace', fontSize: 13, padding: 16, maxWidth: 1080 }}>
      <h1>YAW spike — engine qualification</h1>
      <p>
        {STEPS.map((def) => (
          <span key={def.name} style={{ marginRight: 8 }}>
            {badge(ctx.steps[def.name])} {def.name.split('-')[0]}{' '}
          </span>
        ))}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          {STEPS.map((def) => (
            <div key={def.name} style={{ marginBottom: 4 }}>
              <button disabled={busy !== null} onClick={() => void runStep(def)} style={{ width: 320, textAlign: 'left' }}>
                {badge(ctx.steps[def.name])} {def.label}
              </button>
              {busy === def.name ? <span> running…</span> : null}
              {ctx.steps[def.name] !== undefined ? (
                <div style={{ whiteSpace: 'pre-wrap', color: ctx.steps[def.name]!.ok ? '#0a0' : '#a00', marginLeft: 12 }}>
                  {ctx.steps[def.name]!.detail}
                </div>
              ) : null}
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <button onClick={download}>dump JSON</button>{' '}
            <button onClick={() => void closeAll(ctx).then(() => window.location.reload())}>close + reload</button>{' '}
            <button onClick={() => window.location.reload()} title="raw reload: kills the scan worker mid-flight (AC3 mid-sync reload); no clean close">
              reload mid-scan (kill)
            </button>{' '}
            <button
              onClick={() => void purgeSpikeDatabases().then(() => resetSession()).then(() => window.location.reload())}
              title="delete all yaw-spike-* OPFS dirs (fails loudly while a client holds the lease), clear session ctx, reload"
            >
              purge spike DBs
            </button>
          </div>
        </div>
        <div>
          <h3>identities</h3>
          <pre>
            {JSON.stringify(
              {
                accountA: ctx.accountA,
                accountB: ctx.accountB,
                unifiedA: ctx.unifiedA,
                transparentA: ctx.transparentA,
                unifiedB: ctx.unifiedB,
                lastOperationId: ctx.lastOperationId,
              },
              null,
              2,
            )}
          </pre>
          <h3>log</h3>
          <pre style={{ maxHeight: 480, overflow: 'auto' }}>{ctx.log.slice(-40).join('\n')}</pre>
        </div>
      </div>
    </div>
  );
}
