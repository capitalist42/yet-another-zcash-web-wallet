// Product screens: boot states, welcome, onboarding (create + forced backup
// gate / restore / view-only import), and the wallet screen for issue #3/#4.
import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { getApp, startApp } from './wiring';
import type { RestoreBirthday } from '../wallet/app';
import type { EngineHistoryEntry, NetworkId } from '../wallet/engine/port';
import { formatZats } from '../wallet/units';

const app = getApp();

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

function SyncBar() {
  const sync = useStore(app.sync);
  if (sync === null) return <p className="muted">Sync: preparing…</p>;
  const scanned = sync.scanned === null ? '—' : sync.scanned.toLocaleString('en-US');
  const target = sync.target === null ? '—' : sync.target.toLocaleString('en-US');
  return (
    <p className="muted">
      Sync: {sync.activity} · scanned {scanned} / {target}
      {sync.targetReached ? ' · up to date' : ''}
    </p>
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
  const network = useStore(app.network);
  if (info === null) return null;
  return (
    <section className="screen" aria-label="wallet">
      <header className="row">
        <h1>
          {info.name} <span className="chip">{info.fingerprint}</span>
          {info.kind === 'viewonly' && <span className="chip">View-only</span>}
          {/* ADR-0001: the endpoint operator is a party to your privacy. */}
          <span className="chip">{new URL(endpoint).host}</span>
        </h1>
        <button type="button" onClick={() => void app.setNetwork(network === 'testnet' ? 'mainnet' : 'testnet')}>
          Switch to {network === 'testnet' ? 'mainnet' : 'testnet'}
        </button>
      </header>
      <SyncBar />
      {pending > 0 && <p className="chip warn">Pending Payments: {pending}</p>}
      {balances === null ? (
        <p className="muted">Balances: waiting for first scan…</p>
      ) : (
        <ul className="balances">
          <li>
            Transparent <strong>{balances.transparent === null ? '—' : formatZats(balances.transparent)}</strong>
          </li>
          <li>
            Sapling <strong>{balances.sapling === null ? '—' : formatZats(balances.sapling)}</strong>
          </li>
          <li>
            Ironwood <strong>{balances.ironwood === null ? '—' : formatZats(balances.ironwood)}</strong>
          </li>
        </ul>
      )}
      <div className="receive">
        <h2>Receive Address</h2>
        <p className="address" data-testid="receive-address">
          {address ?? (info.kind === 'viewonly'
            ? 'No current address — view-only Wallets cannot mint one.'
            : 'preparing…')}
        </p>
      </div>
      <div className="actions">
        {canSpend ? (
          <button type="button" disabled title="Send ships in the next milestone">
            Send
          </button>
        ) : (
          <p className="muted">No spend authority — this Wallet is view-only.</p>
        )}
      </div>
      <div className="history-section">
        <h2>History</h2>
        <History />
      </div>
    </section>
  );
}

function CreateFlow() {
  const [phase, setPhase] = useState<'form' | 'backup'>('form');
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const start = async (): Promise<void> => {
    const session = await app.onCreate.generate();
    setPhrase(session.phrase);
    setPhase('backup');
  };
  if (phase === 'form') {
    return (
      <button type="button" onClick={() => void start()}>
        Create a new Wallet
      </button>
    );
  }
  // Forced backup gate: no dismiss control; only the matching phrase exits.
  return (
    <section className="gate" aria-label="backup gate">
      <h2>Write down your Recovery Phrase</h2>
      <ol className="phrase">
        {phrase.split(' ').map((w, i) => (
          <li key={i}>
            <span className="num">{i + 1}</span> {w}
          </li>
        ))}
      </ol>
      <p>Anyone with these words controls your funds. No one can reset them for you.</p>
      <label>
        Type all 24 words in order to confirm
        <textarea value={confirm} onChange={(e) => setConfirm(e.target.value)} rows={3} />
      </label>
      {error !== null && <p className="error">{error}</p>}
      <button
        type="button"
        onClick={async () => {
          // A fresh attempt never keeps the previous attempt's message —
          // otherwise a stale .error element can outlive its cause.
          setError(null);
          const res = await app.onCreate.confirmBackup(confirm);
          setError(res.ok ? null : (res.message ?? 'phrase mismatch'));
        }}
      >
        I saved my phrase
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
          setError(res.ok ? null : (res.message ?? res.code ?? 'restore failed'));
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
          setError(res.ok ? null : (res.message ?? res.code ?? 'import failed'));
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
      <h1>Zcash Wallet</h1>
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
      {screen === 'storage-busy' && (
        <section className="screen" aria-label="storage busy">
          <h1>Wallet storage is busy</h1>
          <p>Another tab already has this Wallet open. Close it there, then reload this tab.</p>
        </section>
      )}
    </main>
  );
}
