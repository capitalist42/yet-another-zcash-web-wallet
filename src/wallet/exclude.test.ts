// Exclude (issue #9): persisted per Wallet, counted beside balances, and
// checked against the Proposal the engine actually composed. The SDK has no
// forced-inputs API, so a plan that spends outside the selection stays on
// review until the user accepts those real inputs.
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createRegistry, idbRegistryStore, type Registry } from './registry';
import { createFakeEngine, type FakeEngine } from './engine/fake';
import { createWalletApp, type WalletApp } from './app';
import { DEFAULT_ENDPOINTS } from './policy';
import type { EngineProposal, NoteId } from './engine/port';
import { createVault, idbVaultStore } from './vault';

const SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';

const NOTE_A = { pool: 'sapling', txid: 'aa', outputIndex: 0 } as const;
const NOTE_B = { pool: 'sapling', txid: 'bb', outputIndex: 1 } as const;

const spending = (id: string, note: NoteId): EngineProposal => ({
  proposalId: id,
  operationId: `op-${id}`,
  totalFee: 1_000n,
  steps: [
    {
      expiryHeight: 50,
      fee: 1_000n,
      inputs: [{ pool: note.pool, value: 50_000_000n, note }],
      outputs: [{ kind: 'payment', pool: 'sapling', address: SAPLING, amount: 49_000_000n, memo: null }],
    },
  ],
});

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

const openSeed = async (): Promise<void> => {
  const created = await app.onCreate.generate();
  const done = await app.onCreate.confirmBackup(created.phrase);
  expect(done.ok).toBe(true);
};

const seedNotes = async (): Promise<string> => {
  await openSeed();
  const wallet = engine.lastWallet();
  const accountId = (await wallet.accounts())[0]!.id;
  wallet.setNotes(accountId, [
    { ...NOTE_A, value: 50_000_000n, spendState: 'unspent', locked: true },
    { ...NOTE_B, value: 80_000_000n, spendState: 'unspent', locked: false },
  ]);
  await app.onNotes.refresh();
  return accountId;
};

const fill = (): void => {
  app.onSend.open();
  app.onSend.setRecipient(SAPLING);
  app.onSend.setAmount('0.49');
};

describe('exclude persistence', () => {
  it('keeps an exclusion across reload and shows the count on the note row', async () => {
    await seedNotes();
    expect(app.notes.get()).toMatchObject([
      { id: NOTE_A, spendState: 'unspent', locked: true, excluded: false },
      { id: NOTE_B, spendState: 'unspent', locked: false, excluded: false },
    ]);

    await app.onNotes.exclude(NOTE_A);
    expect(app.excludedCount.get()).toBe(1);
    expect(app.notes.get().map((row) => row.excluded)).toEqual([true, false]);

    const id = app.walletInfo.get()?.id;
    expect(id).toBeTruthy();
    expect((await registry.get(id!))?.excludedNotes).toEqual([NOTE_A]);

    const reloadedEngine = createFakeEngine();
    reloadedEngine.queueWallet({
      accounts: [
        {
          id: 'acct-reloaded',
          notes: [
            { ...NOTE_A, value: 50_000_000n, spendState: 'unspent', locked: true },
            { ...NOTE_B, value: 80_000_000n, spendState: 'unspent', locked: false },
          ],
        },
      ],
    });
    const reloaded = createWalletApp({
      engine: reloadedEngine.engine,
      registry,
      vault: createVault(idbVaultStore()),
      endpoints: DEFAULT_ENDPOINTS,
      requestPersist: async () => true,
    });
    await reloaded.boot({ restoreLatest: true });
    expect(reloaded.excludedCount.get()).toBe(1);
    expect(reloaded.notes.get()).toMatchObject([
      { id: NOTE_A, spendState: 'unspent', locked: true, excluded: true },
      { id: NOTE_B, excluded: false },
    ]);
  });

  it('reset clears the count and the persisted set', async () => {
    await seedNotes();
    await app.onNotes.exclude(NOTE_A);
    await app.onNotes.exclude(NOTE_B);
    expect(app.excludedCount.get()).toBe(2);

    await app.onNotes.reset();
    expect(app.excludedCount.get()).toBe(0);
    expect(app.notes.get().every((row) => !row.excluded)).toBe(true);
    const id = app.walletInfo.get()?.id;
    expect((await registry.get(id!))?.excludedNotes).toEqual([]);
  });
});

describe('proposal input assertion', () => {
  it('sends when every input is inside the non-excluded selection', async () => {
    await seedNotes();
    await app.onNotes.exclude(NOTE_A);
    const wallet = engine.lastWallet();
    const plan = spending('prop-ok', NOTE_B);
    wallet.queueProposal(plan, 'bb-tx');
    fill();
    await app.onSend.review();
    expect(app.send.get()).toMatchObject({ phase: 'review', deviation: false, proposal: plan });
    await app.onSend.confirm();
    expect(wallet.sentProposalIds).toEqual(['prop-ok']);
  });

  it('refuses a proposal that spends an excluded note until those inputs are accepted', async () => {
    await seedNotes();
    await app.onNotes.exclude(NOTE_A);
    const wallet = engine.lastWallet();
    const plan = spending('prop-deviate', NOTE_A);
    wallet.queueProposal(plan, 'aa-tx');
    fill();
    await app.onSend.review();
    expect(app.send.get()).toMatchObject({
      phase: 'review',
      deviation: true,
      accepted: false,
      proposal: plan,
    });
    await app.onSend.confirm();
    expect(wallet.sentProposalIds).toEqual([]);
    expect(app.send.get().phase).toBe('review');

    app.onSend.acceptInputs();
    expect(app.send.get()).toMatchObject({ phase: 'review', deviation: true, accepted: true });
    await app.onSend.confirm();
    expect(wallet.sentProposalIds).toEqual(['prop-deviate']);
  });
});
