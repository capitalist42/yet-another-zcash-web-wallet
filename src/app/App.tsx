// Product screens: boot states, welcome, onboarding (create + forced backup
// gate / restore / view-only import), the wallet screen, and send (#3/#4/#5).
import { useEffect, useState } from 'react';
import { useStore } from '@nanostores/react';
import { getApp, startApp } from './wiring';
import type { ImportResult, RememberChoice, RestoreBirthday, SendNotice } from '../wallet/app';
import type { EngineHistoryEntry, EngineProposal, NetworkId } from '../wallet/engine/port';
import { formatZats } from '../wallet/units';
import { overallProgress } from '../wallet/sync-progress';

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
  const view = useStore(app.syncProgress);
  if (view === null) return <p className="muted">Sync: preparing…</p>;
  const p = overallProgress(view, view.birthday);
  const scanned = view.scanned === null ? '—' : view.scanned.toLocaleString('en-US');
  const target = view.target === null ? '—' : view.target.toLocaleString('en-US');
  const label = view.targetReached ? 'Wallet synced' : p.failed ? 'Sync failed' : 'Syncing wallet';
  const pctText = p.percent === null ? '—' : `${p.percent}%`;
  const valueText = p.done
    ? 'up to date'
    : p.percent === null
      ? view.activity
      : `${p.percent}% · ${p.remaining?.toLocaleString('en-US')} blocks to go`;
  const fill = p.failed ? 'sync-fill failed' : p.percent === null && view.activity === 'running' ? 'sync-fill indeterminate' : 'sync-fill';
  return (
    <div className="sync" aria-label="sync">
      <div className="row">
        <span>{label}</span>
        <span className="muted sync-pct">{pctText}</span>
      </div>
      <div
        className="sync-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p.percent ?? undefined}
        aria-valuetext={valueText}
      >
        <div
          className={fill}
          style={p.percent === null ? undefined : { width: `${p.percent}%` }}
        />
      </div>
      <p className="muted sync-detail">
        scanned {scanned} / {target}
        {p.done ? ' · up to date' : p.remaining !== null ? ` · ${p.remaining.toLocaleString('en-US')} blocks to go` : ''}
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

const noticeText = (notice: SendNotice): string | null => {
  if (notice === null) return null;
  switch (notice.kind) {
    case 'invalid-recipient':
      return 'Enter a unified, Sapling, or transparent address, or a zcash: payment URI.';
    case 'invalid-amount':
      return 'Enter an amount in ZEC, up to 8 decimal places.';
    case 'memo-too-long':
      return 'A memo can be at most 512 bytes.';
    case 'memo-on-transparent':
      return 'Transparent addresses cannot carry a memo.';
    case 'transparent-disabled':
      return 'Transparent recipients are off. Allow transparent sends is in Settings.';
    case 'transparent-input':
      return 'This plan would spend a transparent note. Those inputs stay excluded.';
    case 'network-mismatch':
      return 'That address is for the other network.';
    case 'unavailable':
      return 'This Wallet cannot send right now.';
    case 'view-only':
      return 'No spend authority — this Wallet is view-only.';
    case 'locked':
      // CONTEXT.md: Lock is the session-level loss of spend authority; the
      // Wallet stays open for viewing. Say what unlocks it.
      return 'This Wallet is locked. Unlock it to send.';
    case 'phrase':
      return 'Enter the 24-word recovery phrase for this Wallet.';
    case 'engine':
      return `The wallet refused the payment (${notice.code}).`;
  }
};

function ProposalTable(props: { proposal: EngineProposal }) {
  return (
    <>
      <p>
        Fee <strong data-testid="proposal-fee">{formatZats(props.proposal.totalFee)}</strong> ZEC
      </p>
      {props.proposal.steps.map((step, index) => (
        <div key={`${step.expiryHeight}-${index}`}>
          <p>
            Expiry <strong data-testid="proposal-expiry">{step.expiryHeight}</strong>
          </p>
          <h3>Inputs</h3>
          <ul className="history">
            {step.inputs.map((input, i) => (
              <li key={`${input.pool}-${i}`}>
                {input.pool} {formatZats(input.value)}
              </li>
            ))}
          </ul>
          <h3>Outputs</h3>
          <ul className="history">
            {step.outputs.map((output, i) => (
              <li key={`${output.kind}-${i}`}>
                {output.kind} {output.pool} {formatZats(output.amount)}
                {output.address !== null && <span className="address">{output.address}</span>}
                {output.memo !== null && output.memo !== '' && <span> memo: {output.memo}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function SendFlow() {
  const view = useStore(app.send);
  const [phrase, setPhrase] = useState('');
  if (view.phase === 'closed') return null;
  if (view.phase === 'sent') {
    return (
      <section className="form" aria-label="sent">
        <h2>Sent</h2>
        {view.txid !== null && <p className="address">{view.txid}</p>}
        <button type="button" onClick={() => void app.onSend.close()}>
          Done
        </button>
      </section>
    );
  }
  if (view.phase === 'sync') {
    return (
      <section className="form" aria-label="sync required">
        <h2>Sync</h2>
        <p>Sync this Wallet before sending.</p>
        <button type="button" className="secondary" onClick={() => app.onSend.backToForm()}>
          Back
        </button>
      </section>
    );
  }
  if (view.phase === 'unlock') {
    const text = noticeText(view.notice);
    return (
      <section className="form" aria-label="unlock">
        <h2>Unlock</h2>
        <p>Enter this Wallet&apos;s recovery phrase to send.</p>
        <label>
          Recovery Phrase
          <textarea rows={3} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        </label>
        {text !== null && <p className="error">{text}</p>}
        <div className="choices">
          <button type="button" onClick={() => void app.onSend.unlock(phrase)}>
            Unlock
          </button>
          <button type="button" className="secondary" onClick={() => app.onSend.backToForm()}>
            Back
          </button>
        </div>
      </section>
    );
  }
  if (view.phase === 'review') {
    const text = noticeText(view.notice);
    return (
      <section className="form" aria-label="proposal review">
        <h2>Review Proposal</h2>
        <ProposalTable proposal={view.proposal} />
        {text !== null && <p className="error">{text}</p>}
        <div className="choices">
          <button type="button" data-testid="confirm-send" onClick={() => void app.onSend.confirm()}>
            Send
          </button>
          <button type="button" className="secondary" onClick={() => app.onSend.edit()}>
            Back
          </button>
        </div>
      </section>
    );
  }
  const text = noticeText(view.notice);
  return (
    <section className="form" aria-label="send">
      <h2>Send</h2>
      <label>
        Recipient
        <textarea
          rows={2}
          value={view.draft.recipient}
          data-testid="send-recipient"
          onChange={(e) => app.onSend.setRecipient(e.target.value)}
        />
      </label>
      <label>
        Amount (ZEC)
        <input
          value={view.draft.amount}
          inputMode="decimal"
          data-testid="send-amount"
          onChange={(e) => app.onSend.setAmount(e.target.value)}
        />
      </label>
      <label>
        Memo
        <textarea
          rows={2}
          value={view.draft.memo}
          data-testid="send-memo"
          onChange={(e) => app.onSend.setMemo(e.target.value)}
        />
      </label>
      {view.draft.memoWarning && (
        <p className="warning" data-testid="memo-warning">
          This memo rides on-chain, encrypted to the recipient.
        </p>
      )}
      {view.draft.transparentBlocked && (
        <p className="warning">Transparent recipients are off. Allow transparent sends is in Settings.</p>
      )}
      {text !== null && <p className="error">{text}</p>}
      <div className="choices">
        <button type="button" onClick={() => void app.onSend.review()}>
          Review
        </button>
        <button type="button" className="secondary" onClick={() => void app.onSend.close()}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** Auto-Lock countdown chip (issue #6): visible only while unlocked. The
 * deadline is activity-based — a send attempt resets it, watching sync does
 * not — and there is no hard cap, so this is the only honest countdown. */
function AutoLockChip() {
  const autoLockInMs = useStore(app.autoLockInMs);
  if (autoLockInMs === null) return null;
  const minutes = Math.max(0, Math.ceil(autoLockInMs / 60_000));
  return (
    <span className="chip warn" data-testid="auto-lock-chip">
      Auto-Lock in ~{minutes} min
    </span>
  );
}

/** Unlock the open Wallet (issue #6). Remembered seeds present the Vault
 * passphrase field; Never-store seeds re-enter the recovery phrase. Both
 * attach the signer — neither ever auto-decrypts at startup. */
function UnlockPanel() {
  const hasVault = useStore(app.hasVault);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (passphrasePath: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = passphrasePath ? await app.unlock(secret) : await app.unlockWithPhrase(secret);
      if (!res.ok) setError(errorText(res, 'unlock failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="form" aria-label="unlock session">
      <h2>Wallet locked</h2>
      <p className="muted">
        Viewing continues. Spend authority returns only after Unlock — and lapses
        again after 10 idle minutes (Auto-Lock).
      </p>
      <label>
        {hasVault ? 'Vault passphrase' : 'Recovery Phrase'}
        {hasVault ? (
          <input
            type="password"
            value={secret}
            data-testid="unlock-secret"
            autoComplete="off"
            onChange={(e) => setSecret(e.target.value)}
          />
        ) : (
          <textarea
            rows={3}
            value={secret}
            data-testid="unlock-secret"
            onChange={(e) => setSecret(e.target.value)}
          />
        )}
      </label>
      {error !== null && <p className="error" data-testid="unlock-error">{error}</p>}
      <div className="choices">
        <button
          type="button"
          disabled={busy || secret.length === 0}
          data-testid="unlock-submit"
          onClick={() => void submit(hasVault)}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
    </section>
  );
}

function WalletScreen() {
  const info = useStore(app.walletInfo);
  const balances = useStore(app.balances);
  const address = useStore(app.address);
  const pending = useStore(app.pendingCount);
  const canSpend = useStore(app.canSpend);
  const unlocked = useStore(app.unlocked);
  const endpoint = useStore(app.endpoint);
  const gatePending = useStore(app.backupPending);
  const creating = useStore(app.creating);
  const send = useStore(app.send);
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
          <AutoLockChip />
        </h1>
        <div className="choices">
          {info.kind === 'seed' && unlocked && (
            // Lock is app-wide (issue #6): every open Wallet on both Networks
            // loses spend authority. The chip in the header tells the truth.
            <button
              type="button"
              className="secondary"
              data-testid="lock-button"
              onClick={() => void app.lock()}
            >
              Lock
            </button>
          )}
          <button type="button" className="secondary" onClick={() => app.openSettings()}>
            Settings
          </button>
        </div>
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
        ) : canSpend && send.phase === 'closed' ? (
          <button type="button" onClick={() => app.onSend.open()}>
            Send
          </button>
        ) : canSpend ? (
          <SendFlow />
        ) : info.kind === 'seed' ? (
          // A seed Wallet that is not unlocked is locked (issue #6): the
          // Unlock panel replaces Send; viewing above stays live.
          <UnlockPanel />
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

// Custody choice (ADR-0002, issue #6): the Remember/Never-store decision plus
// its Vault passphrase pair, shared verbatim by the create and restore flows.
// Distinct from a BIP39 passphrase — this one keys the local envelope.
const useCustody = (radioName: string) => {
  const [remember, setRemember] = useState(false);
  const [vaultPass, setVaultPass] = useState('');
  const [vaultPass2, setVaultPass2] = useState('');
  const fields = (
    <fieldset className="custody" aria-label="custody choice">
      <legend>Keep this Wallet unlocked on this device?</legend>
      <label>
        <input
          type="radio"
          name={radioName}
          checked={!remember}
          onChange={() => setRemember(false)}
          data-testid="custody-never"
        />
        Never store
      </label>
      <label>
        <input
          type="radio"
          name={radioName}
          checked={remember}
          onChange={() => setRemember(true)}
          data-testid="custody-remember"
        />
        Remember on this device (encrypted)
      </label>
      <p className="muted">
        {remember
          ? 'Your seed is stored encrypted (AES-GCM, key stretched 210k times) and unlocked with this passphrase until Auto-Lock. A wrong passphrase never yields the seed.'
          : 'Nothing about this seed is stored. You will re-enter the phrase when you want to send.'}
      </p>
      {remember && (
        <>
          <label>
            Vault passphrase
            <input
              type="password"
              value={vaultPass}
              onChange={(e) => setVaultPass(e.target.value)}
              data-testid="vault-pass"
              autoComplete="new-password"
            />
          </label>
          <label>
            Repeat passphrase
            <input
              type="password"
              value={vaultPass2}
              onChange={(e) => setVaultPass2(e.target.value)}
              data-testid="vault-pass2"
              autoComplete="new-password"
            />
          </label>
          <p className="muted">
            There is no recovery for this passphrase — losing it means restoring from the phrase.
          </p>
        </>
      )}
    </fieldset>
  );
  // Validation lives here, at the UI boundary: the service also refuses
  // Remember without a passphrase, but a local check keeps the user on the
  // form with a precise message.
  const validate = (): { choice: RememberChoice } | { error: string } => {
    if (remember && vaultPass.length === 0) {
      return { error: 'Choose a passphrase for the encrypted Vault (or pick Never store).' };
    }
    if (remember && vaultPass !== vaultPass2) {
      return { error: 'The two passphrases do not match.' };
    }
    return { choice: { remember, ...(remember ? { vaultPassphrase: vaultPass } : {}) } };
  };
  return { fields, validate };
};
function CreateFlow() {
  const [phase, setPhase] = useState<'form' | 'backup'>('form');
  const [phrase, setPhrase] = useState('');
  const [quiz, setQuiz] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const custody = useCustody('custody');
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
  const submitPhrase = async (choice: RememberChoice): Promise<void> => {
    setBusy(true);
    // A fresh attempt never keeps the previous attempt's message —
    // otherwise a stale .error element can outlive its cause.
    setError(null);
    try {
      const res = await app.onCreate.confirmBackup(phrase, choice);
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
      {custody.fields}
      {error !== null && <p className="error">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          const custodyResult = custody.validate();
          if ('error' in custodyResult) {
            setError(custodyResult.error);
            return;
          }
          // Spot-check locally (the words are on screen anyway); the service
          // gate below still receives — and re-verifies — the full phrase.
          if (quiz.some((pos) => (answers[pos] ?? '').trim().toLowerCase() !== words[pos - 1])) {
            setError("Those words don't match your phrase — check what you wrote down and try again.");
            return;
          }
          void submitPhrase(custodyResult.choice);
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
  const custody = useCustody('restore-custody');
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
      {custody.fields}
      {error !== null && <p className="error">{error}</p>}
      <button
        type="button"
        onClick={async () => {
          const custodyResult = custody.validate();
          if ('error' in custodyResult) {
            setError(custodyResult.error);
            return;
          }
          const choice = custodyResult.choice;
          const res = await app.onRestore.restore({
            phrase,
            passphrase,
            accountIndex: Number(accountIndex),
            birthday: birthdayChoice(fullScan, height),
            custody: choice,
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
