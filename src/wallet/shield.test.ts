// Shielding (issue #8): address-level selection composes the intent, the
// shared review screen gates the broadcast, and confirm() sends exactly the
// reviewed proposal id. Observed through the app service and the fake engine
// port — never markup, never the SDK's one-call shield().
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createRegistry, idbRegistryStore, type Registry } from './registry';
import { createFakeEngine, type FakeEngine, type FakeWallet } from './engine/fake';
import { createVault, idbVaultStore } from './vault';
import { createWalletApp, type WalletApp } from './app';
import { DEFAULT_ENDPOINTS } from './policy';

const A = 'u1fakeA-address';
const B = 'u1fakeB-address';

const U5000 = 5_000n;
const U20000 = 20_000n;
const U30000 = 30_000n;

let engine: FakeEngine;
let registry: Registry;
let app: WalletApp;

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { value: new IDBFactory(), writable: true, configurable: true });
  registry = createRegistry(idbRegistryStore());
  engine = createFakeEngine();
  app = createWalletApp({
    engine: engine.engine,
    registry,
    vault: createVault(idbVaultStore()),
    endpoints: DEFAULT_ENDPOINTS,
    requestPersist: async () => true,
  });
  app.network.set('testnet');
});

const openSeed = async (): Promise<string> => {
  const created = await app.onCreate.generate();
  const done = await app.onCreate.confirmBackup(created.phrase);
  expect(done.ok).toBe(true);
  return created.phrase;
};

/** Seed wallet with scripted transparent utxos, Shield form open. */
const openShieldWith = async (
  utxos: { address: string; value: bigint }[],
): Promise<FakeWallet> => {
  await openSeed();
  const wallet = engine.lastWallet();
  const account = (await wallet.accounts())[0]!;
  wallet.setUtxos(account.id, utxos);
  await app.onShield.open();
  return wallet;
};

const accountIdOf = (wallet: FakeWallet): Promise<string> =>
  wallet.accounts().then((accounts) => accounts[0]!.id);

/** Views carry bigint zats. The leak check still has to read every string. */
const viewJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));

describe('shield form', () => {
  it('opens with every address checked and the frozen default threshold', async () => {
    const wallet = await openShieldWith([
      { address: A, value: U20000 },
      { address: A, value: U5000 },
      { address: B, value: U30000 },
    ]);
    const view = app.shield.get();
    expect(view.phase).toBe('form');
    if (view.phase !== 'form') return;
    expect(view.draft.threshold).toBe('10000');
    expect(view.draft.ready).toBe(true);
    expect(view.draft.addresses).toEqual([
      { address: A, zats: U20000 + U5000, utxoCount: 2, checked: true },
      { address: B, zats: U30000, utxoCount: 1, checked: true },
    ]);
    // The checkbox list reads through the port; no proposal yet.
    expect(wallet.calls).toContain('listTransparentUtxos');
    expect(wallet.proposeShieldArgs).toHaveLength(0);
  });

  it('refuses to open while locked', async () => {
    await openSeed();
    app.lock();
    await app.onShield.open();
    expect(app.shield.get().phase).toBe('closed');
  });

  it('guards review against a spend key that locked mid-form', async () => {
    await openShieldWith([{ address: A, value: U20000 }]);
    app.lock();
    await app.onShield.review();
    expect(app.shield.get()).toMatchObject({ phase: 'form', notice: { kind: 'locked' } });
  });
});

describe('shield intent composition', () => {
  it('sends the checked addresses and the threshold to the engine', async () => {
    const wallet = await openShieldWith([
      { address: A, value: U20000 },
      { address: B, value: U30000 },
    ]);
    app.onShield.toggle(B);
    await app.onShield.review();
    expect(wallet.proposeShieldArgs).toMatchObject([
      { accountId: await accountIdOf(wallet), fromAddresses: [A], threshold: 10_000n },
    ]);
  });

  it('keeps an unchecked address out of the proposal entirely', async () => {
    await openShieldWith([
      { address: A, value: U20000 },
      { address: B, value: U30000 },
      { address: B, value: U20000 },
    ]);
    app.onShield.toggle(B);
    await app.onShield.review();
    const view = app.shield.get();
    expect(view.phase).toBe('review');
    if (view.phase !== 'review') return;
    expect(view.proposal.steps[0]!.inputs.map((i) => i.value)).toEqual([U20000]);
    expect(view.proposal.totalFee).toBe(10_000n);
  });

  it('filters dust below the threshold and admits it once lowered', async () => {
    await openShieldWith([
      { address: A, value: U5000 },
      { address: A, value: U20000 },
    ]);
    // Default 10 000: the 5 000-zat dust note may not enter the proposal.
    await app.onShield.review();
    let view = app.shield.get();
    expect(view.phase).toBe('review');
    if (view.phase !== 'review') return;
    expect(view.proposal.steps[0]!.inputs.map((i) => i.value)).toEqual([U20000]);

    // Editing the threshold after review drops the proposal (form state).
    app.onShield.setThreshold('5000');
    expect(app.shield.get().phase).toBe('form');
    await app.onShield.review();
    view = app.shield.get();
    expect(view.phase).toBe('review');
    if (view.phase !== 'review') return;
    expect(view.proposal.steps[0]!.inputs.map((i) => i.value)).toEqual([U5000, U20000]);
  });

  it('rejects a non-integer threshold without asking the engine', async () => {
    const wallet = await openShieldWith([{ address: A, value: U20000 }]);
    app.onShield.setThreshold('1.5');
    await app.onShield.review();
    expect(app.shield.get()).toMatchObject({ phase: 'form', notice: { kind: 'invalid-threshold' } });
    app.onShield.setThreshold('abc');
    await app.onShield.review();
    expect(app.shield.get()).toMatchObject({ phase: 'form', notice: { kind: 'invalid-threshold' } });
    expect(wallet.proposeShieldArgs).toHaveLength(0);
  });

  it('caps a shield at 16 addresses', async () => {
    const utxos = Array.from({ length: 17 }, (_, i) => ({ address: `t1addr${i}`, value: U20000 }));
    const wallet = await openShieldWith(utxos);
    await app.onShield.review();
    expect(app.shield.get()).toMatchObject({ phase: 'form', notice: { kind: 'too-many-addresses' } });
    expect(wallet.proposeShieldArgs).toHaveLength(0);
    app.onShield.toggle('t1addr0');
    await app.onShield.review();
    const args = wallet.proposeShieldArgs[0];
    expect(args?.fromAddresses).toHaveLength(16);
    expect(args?.fromAddresses).not.toContain('t1addr0');
    expect(args?.threshold).toBe(10_000n);
  });

  it('does not call the engine with an empty selection', async () => {
    const wallet = await openShieldWith([{ address: A, value: U20000 }]);
    app.onShield.toggle(A);
    await app.onShield.review();
    expect(app.shield.get()).toMatchObject({ phase: 'form', notice: { kind: 'empty-selection' } });
    expect(wallet.proposeShieldArgs).toHaveLength(0);
  });
});

describe('shield review and broadcast', () => {
  it('shows the composed proposal and sends that proposal id exactly', async () => {
    const wallet = await openShieldWith([
      { address: A, value: U20000 },
      { address: B, value: U30000 },
    ]);
    await app.onShield.review();
    const view = app.shield.get();
    expect(view.phase).toBe('review');
    if (view.phase !== 'review') return;
    const proposalId = view.proposal.proposalId;
    // Nothing broadcast until the explicit accept.
    expect(wallet.sentProposalIds).toEqual([]);
    await app.onShield.confirm();
    expect(wallet.sentProposalIds).toEqual([proposalId]);
    const sent = app.shield.get();
    expect(sent.phase).toBe('sent');
    if (sent.phase !== 'sent') return;
    expect(sent.txid).toBe(`shieldtx-${proposalId}`);
    expect(wallet.operations.map((op) => op.operationId)).toContain(`op-send-${proposalId}`);
  });

  it('consumes accepted utxos: reopening lists what is left', async () => {
    const wallet = await openShieldWith([{ address: A, value: U20000 }]);
    await app.onShield.review();
    await app.onShield.confirm();
    await app.onShield.open();
    const view = app.shield.get();
    expect(view.phase).toBe('form');
    if (view.phase !== 'form') return;
    expect(view.draft.addresses).toEqual([]);
    expect(await wallet.listTransparentUtxos(await accountIdOf(wallet))).toEqual([]);
  });

  it('does not broadcast a reviewed shield once Lock has started', async () => {
    const wallet = await openShieldWith([{ address: A, value: U20000 }]);
    await app.onShield.review();
    const view = app.shield.get();
    if (view.phase !== 'review') throw new Error('expected review');
    const operationId = view.proposal.operationId;
    app.lock();
    await app.onShield.confirm();
    expect(wallet.sentProposalIds).toEqual([]);
    expect(wallet.abandoned).toContain(operationId);
    expect(app.shield.get()).toMatchObject({ phase: 'form', notice: { kind: 'locked' } });
  });

  it('releases the shield proposal when the draft changes', async () => {
    const wallet = await openShieldWith([{ address: A, value: U20000 }]);
    await app.onShield.review();
    const view = app.shield.get();
    if (view.phase !== 'review') throw new Error('expected review');
    const operationId = view.proposal.operationId;
    app.onShield.toggle(A);
    expect(app.shield.get().phase).toBe('form');
    await app.onShield.confirm();
    expect(wallet.sentProposalIds).toEqual([]);
    expect(wallet.abandoned).toContain(operationId);
  });
});

describe('shield error handling', () => {
  it('explains NOTHING_TO_SHIELD in plain language instead of a silent no-op', async () => {
    await openShieldWith([{ address: A, value: U5000 }]);
    // Real path: default threshold filters the only utxo → engine rejects.
    await app.onShield.review();
    const view = app.shield.get();
    expect(view.phase).toBe('form');
    if (view.phase !== 'form') return;
    expect(view.notice).toEqual({ kind: 'nothing-to-shield' });
    expect(viewJson(view)).not.toContain('No eligible');
  });

  it('maps a scripted NOTHING_TO_SHIELD even though its recovery is correct-input', async () => {
    const wallet = await openShieldWith([{ address: A, value: U20000 }]);
    wallet.failNextProposeShield({
      code: 'NOTHING_TO_SHIELD',
      recovery: 'correct-input',
      message: 'engine wording must not leak',
    });
    await app.onShield.review();
    expect(app.shield.get()).toMatchObject({ phase: 'form', notice: { kind: 'nothing-to-shield' } });
    expect(viewJson(app.shield.get())).not.toContain('engine wording');
  });

  it('routes a sync recovery to the sync phase, not the raw message', async () => {
    const wallet = await openShieldWith([{ address: A, value: U20000 }]);
    wallet.failNextProposeShield({
      code: 'UNKNOWN',
      recovery: 'sync',
      message: 'RAW DUMP should not be the route',
    });
    await app.onShield.review();
    const view = app.shield.get();
    expect(view.phase).toBe('sync');
    expect(viewJson(view)).not.toContain('RAW DUMP');
    expect(wallet.sentProposalIds).toEqual([]);
  });

  it('keeps the reviewed proposal across an unlock and then sends it', async () => {
    const phrase = await openSeed();
    const wallet = engine.lastWallet();
    wallet.setUtxos(await accountIdOf(wallet), [{ address: A, value: U20000 }]);
    await app.onShield.open();
    await app.onShield.review();
    const view = app.shield.get();
    if (view.phase !== 'review') throw new Error('expected review');
    const proposalId = view.proposal.proposalId;
    wallet.failNextSend({ code: 'SIGNER_REQUIRED', recovery: 'reattach-signer', message: 'attach me' });
    await app.onShield.confirm();
    expect(app.shield.get().phase).toBe('unlock');
    expect(viewJson(app.shield.get())).not.toContain('attach me');
    await app.onShield.unlock(phrase);
    expect(app.shield.get()).toMatchObject({ phase: 'review', proposal: { proposalId } });
    await app.onShield.confirm();
    expect(wallet.sentProposalIds).toEqual([proposalId, proposalId]);
  });

  it('drops the proposal on review-new-proposal so the next shield is a new plan', async () => {
    await openShieldWith([{ address: A, value: U20000 }]);
    await app.onShield.review();
    const wallet = engine.lastWallet();
    const view = app.shield.get();
    if (view.phase !== 'review') throw new Error('expected review');
    const operationId = view.proposal.operationId;
    wallet.failNextSend({ code: 'UNKNOWN', recovery: 'review-new-proposal', message: 'rebuild me' });
    await app.onShield.confirm();
    expect(app.shield.get().phase).toBe('form');
    expect(viewJson(app.shield.get())).not.toContain('rebuild me');
    expect(wallet.abandoned).toContain(operationId);
    // The failed send was attempted; the plan is gone, so confirm again does not broadcast.
    expect(wallet.sentProposalIds).toEqual([view.proposal.proposalId]);
    await app.onShield.confirm();
    expect(wallet.sentProposalIds).toEqual([view.proposal.proposalId]);
  });
});

describe('shield and send share one proposal lock', () => {
  it('opening send abandons a held shield proposal', async () => {
    const wallet = await openShieldWith([{ address: A, value: U20000 }]);
    await app.onShield.review();
    const view = app.shield.get();
    if (view.phase !== 'review') throw new Error('expected review');
    await app.onSend.open();
    expect(wallet.abandoned).toContain(view.proposal.operationId);
    expect(app.shield.get().phase).toBe('closed');
    expect(app.send.get().phase).toBe('form');
    expect(wallet.sentProposalIds).toEqual([]);
  });

  it('opening the shield flow abandons a held send proposal', async () => {
    await openSeed();
    const wallet = engine.lastWallet();
    wallet.queueProposal(
      {
        proposalId: 'prop-reviewed',
        operationId: 'op-reviewed',
        totalFee: 10_000n,
        steps: [
          {
            expiryHeight: 1,
            fee: 10_000n,
            inputs: [{ pool: 'sapling', value: 110_000n }],
            outputs: [],
          },
        ],
      },
      'cafe',
    );
    app.onSend.open();
    app.onSend.setRecipient(
      'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez',
    );
    app.onSend.setAmount('1');
    await app.onSend.review();
    expect(app.send.get().phase).toBe('review');
    await app.onShield.open();
    expect(wallet.abandoned).toEqual(['op-reviewed']);
  });
});
