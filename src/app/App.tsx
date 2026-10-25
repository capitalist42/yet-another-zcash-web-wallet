// Product screens: boot states, welcome, onboarding (create + forced backup
// gate / restore / view-only import), and the wallet screen for issue #3/#4.
import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { getApp, startApp } from './wiring';
import type { ImportResult, RestoreBirthday } from '../wallet/app';
import type { EngineHistoryEntry, NetworkId } from '../wallet/engine/port';
import { formatZats } from '../wallet/units';

const app = getApp();

/** Onboarding failure text, keyed on the engine code (plan: UX builds on
 * ZcashError codes). RUNTIME_UNAVAILABLE here is the artifact loader refusing
 * bytes whose integrity pin mismatches — a tab open across a rebuild asks for
 * asset hashes the server no longer has, and only a reload pulls the new
 * bundle. Say so, or the user retries the same stale page forever. */
const errorText = (res: ImportResult, fallback: string): string =>
  res.code === 'RUNTIME_UNAVAILABLE'
    ? `${res.message ?? 'Engine runtime unavailable.'} Reload the page and try again.`
    : (res.message ?? res.code ?? fallback);

/** Shared birthday choice (full scan vs explicit height) — one shape for
 * Restore and View-only import (Zashi-compat import path). */
function BirthdayFields(props: {
  fullScan: boolean;
  height: string;
  onFullScan: (v: boolean) => void;
  onHeight: (v: string) => void;
}) {
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={props.fullScan}
          onChange={(e) => props.onFullScan(e.target.checked)}
        />{' '}
        Full scan from genesis
      </label>
      {!props.fullScan && (
        <label>
          Birthday height
          <input value={props.height} onChange={(e) => props.onHeight(e.target.value)} inputMode="numeric" />
        </label>
      )}
    </>
  );
}

const birthdayChoice = (fullScan: boolean, height: string): RestoreBirthday =>
  fullScan ? 'fullScan' : { kind: 'height', height: Number(height) };

/** Active network indicator. Testnet gets the warn border so a devnet
 * balance is never mistaken for mainnet money. */
function NetworkChip() {
  const network = useStore(app.network);
  return (
    <span className={network === 'testnet' ? 'chip warn' : 'chip'} data-testid="network-chip">
      {network === 'testnet' ? 'Testnet' : 'Mainnet'}
    </span>
  );
}

function SyncBar() {
  const sync = useStore(app.sync);
  if (sync === null) return <p className="muted">Sync: preparing…</p>;
  const scanned = sync.scanned === null ? '—' : sync.scanned.toLocaleString('en-US');
  const target = sync.target === null ? '—' : sync.target.toLocaleString('en-US');
  const known = sync.scanned !== null && sync.target !== null && sync.target > 0;
  const pct = known ? Math.min(100, Math.round((sync.scanned! / sync.target!) * 100)) : null;
  const label = sync.targetReached ? 'Wallet synced' : sync.activity === 'failed' ? 'Sync failed' : 'Syncing wallet';
  return (
    <div className="sync" aria-label="sync">
      <div className="row">
        <span>{label}</span>
        <span className="muted">{pct === null ? sync.activity : `${pct}%`}</span>
      </div>
      <div
        className="sync-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <div
          className={pct === null && sync.activity === 'running' ? 'sync-fill indeterminate' : 'sync-fill'}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <p className="muted">
        scanned {scanned} / {target}
        {sync.targetReached ? ' · up to date' : ''}
      </p>
    </div>
  );
}

function History() {
  const info = useStore(app.walletInfo);
  const sync = useStore(app.sync);
  const [entries, setEntries] = useState<readonly EngineHistoryEntry[]>([]);
  useEffect(() => {
    // refresh the visible slice whenever the wallet or scan state changes
    let live = true;
    app
      .history()
      .then((h) => {
        if (live) setEntries(h);
      })
      .catch(() => {
        if (live) setEntries([]);
      });
    return () => {
      live = false;
    };
  }, [info, sync]);
  if (entries.length === 0) return <p className="muted">No transactions yet.</p>;
  return (
    <ul className="history" aria-label="history">
      {entries.map((e) => (
        <li key={e.txid}>
          <span className="muted">{e.minedHeight === null ? 'pending' : `#${e.minedHeight}`}</span>{' '}
          <strong className={e.balanceDelta < 0n ? 'out' : 'in'}>
            {e.balanceDelta < 0n ? '' : '+'}
            {formatZats(e.balanceDelta)}
          </strong>{' '}
          <span className="muted">{e.pools.join('+')}</span>
        </li>
      ))}
    </ul>
  );
}

function WalletScreen() {
  const info = useStore(app.walletInfo);
  const balances = useStore(app.balances);
  const address = useStore(app.address);
  const pending = useStore(app.pendingCount);
  const canSpend = useStore(app.canSpend);
  const endpoint = useStore(app.endpoint);
  const gatePending = useStore(app.backupPending);
  const creating = useStore(app.creating);
  if (info === null) return null;
  return (
    <section className="screen" aria-label="wallet">
      <header className="row">
        <h1>
          {info.name}{info.fingerprint !== '' && <span className="chip">{info.fingerprint}</span>}
          {info.kind === 'viewonly' && <span className="chip">View-only</span>}
          <NetworkChip />
          {/* ADR-0001: the endpoint operator is a party to your privacy. */}
          <span className="chip">{new URL(endpoint).host}</span>
        </h1>
        <button type="button" className="secondary" onClick={() => app.openSettings()}>
          Settings
        </button>
      </header>
      <SyncBar />
      {pending > 0 && <p className="chip warn">Pending Payments: {pending}</p>}
      <ul className="balances">
        <li>
          Transparent <strong>{formatZats(balances?.transparent ?? 0n)}</strong>
        </li>
        <li>
          Sapling <strong>{formatZats(balances?.sapling ?? 0n)}</strong>
        </li>
        <li>
          Ironwood <strong>{formatZats(balances?.ironwood ?? 0n)}</strong>
        </li>
      </ul>
      <div className="receive">
        <h2>Receive Address</h2>
        <p className="address" data-testid="receive-address">
          {address ?? (info.kind === 'viewonly'
            ? 'No current address — view-only Wallets cannot mint one.'
            : 'preparing…')}
        </p>
      </div>
      <div className="actions">
        {gatePending ? (
          <p className="muted">New wallet. The balance stays at zero until a payment arrives.</p>
        ) : canSpend ? (
          <button type="button" disabled title="Send ships in the next milestone">
            Send
          </button>
        ) : (
          <p className="muted">No spend authority — this Wallet is view-only.</p>
        )}
        {gatePending && !creating && (
          <button type="button" onClick={() => void app.onCreate.resume()}>
            Try again
          </button>
        )}
      </div>
      <div className="history-section">
        <h2>History</h2>
        <History />
      </div>
    </section>
  );
}

/** Distinct 1-based word positions the backup quiz asks for (sorted). */
const quizPositions = (count: number, length = 24): number[] => {
  const picked = new Set<number>();
  while (picked.size < count) picked.add(Math.floor(Math.random() * length) + 1);
  return [...picked].sort((a, b) => a - b);
};

function CreateFlow() {
  const [phase, setPhase] = useState<'form' | 'backup'>('form');
  const [phrase, setPhrase] = useState('');
  const [quiz, setQuiz] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async (): Promise<void> => {
    const session = await app.onCreate.generate();
    setPhrase(session.phrase);
    setQuiz(quizPositions(3));
    setAnswers({});
    setPhase('backup');
  };
  // The confirmed phrase is already verified locally and by the service gate;
  // re-submitting it costs nothing — the phrase session stays in flight until
  // a wallet is created, so SYNC_REQUIRED is a pause, not a dead end.
  const submitPhrase = async (): Promise<void> => {
    setBusy(true);
    // A fresh attempt never keeps the previous attempt's message —
    // otherwise a stale .error element can outlive its cause.
    setError(null);
    try {
      const res = await app.onCreate.confirmBackup(phrase);
      if (res.ok) return; // the service flips the screen to the wallet
      // SYNC_REQUIRED also lands on the wallet page (zero balance, sync bar).
      // Only a rejection that never left this gate stays here.
      if (res.code !== 'SYNC_REQUIRED') setError(errorText(res, 'phrase mismatch'));
    } finally {
      setBusy(false);
    }
  };
  if (phase === 'form') {
    return (
      <button type="button" onClick={() => void start()}>
        Create a new Wallet
      </button>
    );
  }
  // Forced backup gate: no dismiss control; only the right words exit it.
  const words = phrase.split(' ');
  return (
    <section className="gate" aria-label="backup gate">
      <h2>Write down your Recovery Phrase</h2>
      <ol className="phrase">
        {words.map((w, i) => (
          <li key={i}>
            <span className="num">{i + 1}</span> {w}
          </li>
        ))}
      </ol>
      <p>Anyone with these words controls your funds. No one can reset them for you.</p>
      <p>To confirm you wrote them down, enter these 3 words from your phrase:</p>
      {quiz.map((pos) => (
        <label key={pos}>
          Word #{pos}
          <input
            data-word-position={pos}
            value={answers[pos] ?? ''}
            onChange={(e) => setAnswers({ ...answers, [pos]: e.target.value })}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      ))}
      {error !== null && <p className="error">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          // Spot-check locally (the words are on screen anyway); the service
          // gate below still receives — and re-verifies — the full phrase.
          if (quiz.some((pos) => (answers[pos] ?? '').trim().toLowerCase() !== words[pos - 1])) {
            setError("Those words don't match your phrase — check what you wrote down and try again.");
            return;
          }
          void submitPhrase();
        }}
      >
        {busy ? 'Creating…' : 'I saved my phrase'}
      </button>
    </section>
  );
}

function RestoreFlow() {
  const [phrase, setPhrase] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [accountIndex, setAccountIndex] = useState('0');
  const [fullScan, setFullScan] = useState(true);
  const [height, setHeight] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="form" aria-label="restore">
      <h2>Restore an existing Wallet</h2>
      <label>
        Recovery Phrase
        <textarea rows={3} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
      </label>
      <label>
        Passphrase (optional)
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
      </label>
      <label>
        Account index
        <input value={accountIndex} onChange={(e) => setAccountIndex(e.target.value)} inputMode="numeric" />
      </label>
      <BirthdayFields fullScan={fullScan} height={height} onFullScan={setFullScan} onHeight={setHeight} />
      {error !== null && <p className="error">{error}</p>}
      <button
        type="button"
        onClick={async () => {
          const res = await app.onRestore.restore({
            phrase,
            passphrase,
            accountIndex: Number(accountIndex),
            birthday: birthdayChoice(fullScan, height),
          });
          setError(res.ok ? null : errorText(res, 'restore failed'));
        }}
      >
        Restore
      </button>
    </section>
  );
}

function ViewOnlyFlow() {
  const [key, setKey] = useState('');
  const [fullScan, setFullScan] = useState(true);
  const [height, setHeight] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="form" aria-label="view-only import">
      <h2>Import a Viewing Key (view-only)</h2>
      <label>
        Unified Full Viewing Key
        <textarea rows={3} value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <BirthdayFields fullScan={fullScan} height={height} onFullScan={setFullScan} onHeight={setHeight} />
      {error !== null && <p className="error">{error}</p>}
      <button
        type="button"
        onClick={async () => {
          const res = await app.onViewOnly.import({ viewingKey: key, birthday: birthdayChoice(fullScan, height) });
          setError(res.ok ? null : errorText(res, 'import failed'));
        }}
      >
        Import
      </button>
    </section>
  );
}

function WelcomeScreen() {
  const [tab, setTab] = useState<'create' | 'restore' | 'viewonly'>('create');
  const error = useStore(app.bootError);
  // Forced backup gate (#4): while a phrase awaits confirmation, the other
  // onboarding paths are visibly unavailable — the service refuses them too.
  const gatePending = useStore(app.backupPending);
  return (
    <section className="screen" aria-label="welcome">
      <header className="row">
        <h1>
          Zcash Wallet
          <NetworkChip />
        </h1>
        <button type="button" className="secondary" onClick={() => app.openSettings()}>
          Settings
        </button>
      </header>
      {/* ADR-0001: one-sentence onboarding disclosure. */}
      <p className="muted">Your lightwalletd provider can see your activity.</p>
      {error !== null && <p className="error">{error}</p>}
      <nav className="tabs">
        <button type="button" className={tab === 'create' ? 'on' : ''} onClick={() => setTab('create')}>
          Create
        </button>
        <button
          type="button"
          className={tab === 'restore' ? 'on' : ''}
          disabled={gatePending}
          title={gatePending ? 'Confirm your backup phrase first' : undefined}
          onClick={() => setTab('restore')}
        >
          Restore
        </button>
        <button
          type="button"
          className={tab === 'viewonly' ? 'on' : ''}
          disabled={gatePending}
          title={gatePending ? 'Confirm your backup phrase first' : undefined}
          onClick={() => setTab('viewonly')}
        >
          View-only
        </button>
      </nav>
      {tab === 'create' && <CreateFlow />}
      {tab === 'restore' && <RestoreFlow />}
      {tab === 'viewonly' && <ViewOnlyFlow />}
    </section>
  );
}


function SettingsScreen() {
  const network = useStore(app.network);
  const endpoint = useStore(app.endpoint);
  const walletInfo = useStore(app.walletInfo);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const choose = async (next: NetworkId): Promise<void> => {
    if (next === network) {
      app.closeSettings();
      return;
    }
    setBusy(true);
    try {
      await app.setNetwork(next);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (): Promise<void> => {
    setBusy(true);
    setRemoveError(null);
    try {
      const res = await app.removeWallet();
      if (!res.ok) setRemoveError(errorText(res, 'remove failed'));
      setConfirmRemove(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="screen" aria-label="settings">
      <header className="row">
        <h1>Settings</h1>
        <button type="button" className="secondary" disabled={busy} onClick={() => app.closeSettings()}>
          Back
        </button>
      </header>
      <h2>Network</h2>
      <p className="muted">Each network has its own wallets. Switching closes the one that is open.</p>
      <div className="choices" role="radiogroup" aria-label="Network">
        <button
          type="button"
          role="radio"
          aria-checked={network === 'mainnet'}
          className={network === 'mainnet' ? 'on' : ''}
          disabled={busy}
          onClick={() => void choose('mainnet')}
        >
          Mainnet
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={network === 'testnet'}
          className={network === 'testnet' ? 'on' : ''}
          disabled={busy}
          onClick={() => void choose('testnet')}
        >
          Testnet
        </button>
      </div>
      <p className="muted">
        Lightwalletd <span className="chip">{new URL(endpoint).host}</span>
      </p>
      {walletInfo !== null && (
        <>
          <h2>Remove Wallet</h2>
          <p className="muted">
            Erases “{walletInfo.name}” from this browser, including its transaction history. Funds are on
            the chain: only your backup phrase can restore this Wallet.
          </p>
          {confirmRemove ? (
            <div className="row">
              <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
                {busy ? 'Removing…' : 'Yes, erase this Wallet'}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="danger" disabled={busy} onClick={() => setConfirmRemove(true)}>
              Remove Wallet
            </button>
          )}
          {removeError !== null && <p className="error">{removeError}</p>}
        </>
      )}
    </section>
  );
}
export default function App() {
  useEffect(() => {
    startApp();
  }, []);
  const screen = useStore(app.screen);
  const network: NetworkId = useStore(app.network);
  return (
    <main className="app" data-network={network}>
      {screen === 'booting' && <p className="screen">Loading your Wallet…</p>}
      {screen === 'welcome' && <WelcomeScreen />}
      {screen === 'wallet' && <WalletScreen />}
      {screen === 'settings' && <SettingsScreen />}
      {screen === 'storage-busy' && (
        <section className="screen" aria-label="storage busy">
          <h1>Wallet storage is busy</h1>
          <p>Another tab already has this Wallet open. Close it there, then reload this tab.</p>
        </section>
      )}
    </main>
  );
}
