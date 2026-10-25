// Send (issue #5): proposal review, memo-warning condition, recovery routing.
// Observed through the app service and the fake engine port — not markup.
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createRegistry, idbRegistryStore, type Registry } from './registry';
import { createFakeEngine, type FakeEngine } from './engine/fake';
import { createWalletApp, type WalletApp } from './app';
import { DEFAULT_ENDPOINTS } from './policy';
import type { EngineProposal } from './engine/port';

const SAPLING =
  'ztestsapling10yy2ex5dcqkclhc7z7yrnjq2z6feyjad56ptwlfgmy77dmaqqrl9gyhprdx59qgmsnyfska2kez';
const TRANSPARENT = 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU';
const SIMPLE_MEMO = 'VGhpcyBpcyBhIHNpbXBsZSBtZW1vLg';

const REVIEWED: EngineProposal = {
  proposalId: 'prop-reviewed',
  operationId: 'op-reviewed',
  totalFee: 12_345n,
  steps: [
    {
      expiryHeight: 424_242,
      fee: 12_345n,
      inputs: [{ pool: 'sapling', value: 9_999n }],
      outputs: [
        { kind: 'payment', pool: 'sapling', address: SAPLING, amount: 100_000_000n, memo: 'hello' },
        { kind: 'change', pool: 'ironwood', address: null, amount: 4_000n, memo: null },
      ],
    },
  ],
};

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

const fill = (): void => {
  app.onSend.open();
  app.onSend.setRecipient(SAPLING);
  app.onSend.setAmount('1');
  app.onSend.setMemo('hello');
};

describe('send form', () => {
  it('warns that a memo rides on-chain only when one will be sent', async () => {
    await openSeed();
    app.onSend.open();
    app.onSend.setRecipient(SAPLING);
    app.onSend.setMemo('');
    expect(app.send.get()).toMatchObject({ phase: 'form', draft: { memoWarning: false } });
    app.onSend.setMemo('hello');
    expect(app.send.get()).toMatchObject({ phase: 'form', draft: { memoWarning: true, transparentBlocked: false } });
    app.onSend.setRecipient(TRANSPARENT);
    expect(app.send.get()).toMatchObject({
      phase: 'form',
      draft: { memoWarning: false, transparentBlocked: true },
    });
  });

  it('prefills recipient, amount, and memo from a ZIP-321 URI', async () => {
    await openSeed();
    app.onSend.open();
    app.onSend.setRecipient(
      `zcash:${SAPLING}?amount=1&memo=${SIMPLE_MEMO}&message=Thank%20you%20for%20your%20purchase`,
    );
    expect(app.send.get()).toMatchObject({
      phase: 'form',
      draft: {
        recipient: SAPLING,
        amount: '1',
        memo: 'This is a simple memo.',
        memoWarning: true,
      },
    });
  });

  it('does not propose a transparent recipient while transparent sends are off', async () => {
    await openSeed();
    app.onSend.open();
    app.onSend.setRecipient(TRANSPARENT);
    app.onSend.setAmount('1');
    await app.onSend.review();
    expect(app.send.get()).toMatchObject({ phase: 'form', notice: { kind: 'transparent-disabled' } });
    expect(engine.lastWallet().proposeArgs).toHaveLength(0);
  });
});

describe('proposal review', () => {
  it('shows the engine proposal and sends that proposal id exactly', async () => {
    await openSeed();
    const wallet = engine.lastWallet();
    wallet.queueProposal(REVIEWED, 'cafe');
    fill();
    await app.onSend.review();
    expect(app.send.get()).toMatchObject({ phase: 'review', proposal: REVIEWED });
    expect(wallet.proposeArgs).toMatchObject([{ to: SAPLING, amount: 100_000_000n, memo: 'hello' }]);
    await app.onSend.confirm();
    expect(wallet.sentProposalIds).toEqual(['prop-reviewed']);
    expect(wallet.proposeArgs).toHaveLength(1);
    expect(app.send.get()).toEqual({ phase: 'sent', txid: 'cafe' });
    expect(app.pendingCount.get()).toBe(1);
  });

  it('refuses a proposal that spends a transparent note', async () => {
    await openSeed();
    const wallet = engine.lastWallet();
    wallet.queueProposal({
      ...REVIEWED,
      proposalId: 'prop-t',
      operationId: 'op-t',
      steps: [
        {
          ...REVIEWED.steps[0]!,
          inputs: [{ pool: 'transparent', value: 9_999n }],
        },
      ],
    });
    fill();
    await app.onSend.review();
    expect(app.send.get()).toMatchObject({ phase: 'form', notice: { kind: 'transparent-input' } });
    expect(wallet.sentProposalIds).toEqual([]);
    expect(wallet.abandoned).toEqual(['op-t']);
  });

  it('releases the proposal when the form changes after review', async () => {
    await openSeed();
    const wallet = engine.lastWallet();
    wallet.queueProposal(REVIEWED);
    fill();
    await app.onSend.review();
    app.onSend.setAmount('2');
    expect(app.send.get()).toMatchObject({ phase: 'form' });
    await app.onSend.confirm();
    expect(wallet.sentProposalIds).toEqual([]);
    expect(wallet.abandoned).toEqual(['op-reviewed']);
  });
});

describe('send error recovery', () => {
  it('routes a sync recovery to the sync phase, not the raw message', async () => {
    await openSeed();
    const wallet = engine.lastWallet();
    wallet.failNextPropose({
      code: 'UNKNOWN',
      recovery: 'sync',
      message: 'RAW DUMP should not be the route',
    });
    fill();
    await app.onSend.review();
    const view = app.send.get();
    expect(view.phase).toBe('sync');
    expect(JSON.stringify(view)).not.toContain('RAW DUMP');
    expect(wallet.sentProposalIds).toEqual([]);
  });

  it('keeps the reviewed proposal across an unlock and then sends it', async () => {
    const phrase = await openSeed();
    const wallet = engine.lastWallet();
    wallet.queueProposal(REVIEWED, 'cafe');
    fill();
    await app.onSend.review();
    wallet.failNextSend({ code: 'SIGNER_REQUIRED', recovery: 'reattach-signer', message: 'attach me' });
    await app.onSend.confirm();
    expect(app.send.get().phase).toBe('unlock');
    expect(JSON.stringify(app.send.get())).not.toContain('attach me');
    await app.onSend.unlock(phrase);
    expect(app.send.get()).toMatchObject({ phase: 'review', proposal: { proposalId: 'prop-reviewed' } });
    await app.onSend.confirm();
    expect(wallet.sentProposalIds).toEqual(['prop-reviewed', 'prop-reviewed']);
    expect(wallet.attachArgs).toHaveLength(1);
    expect(app.send.get()).toEqual({ phase: 'sent', txid: 'cafe' });
  });

  it('drops the proposal on review-new-proposal so the next send is a new plan', async () => {
    await openSeed();
    const wallet = engine.lastWallet();
    wallet.queueProposal(REVIEWED);
    fill();
    await app.onSend.review();
    wallet.failNextSend({ code: 'UNKNOWN', recovery: 'review-new-proposal', message: 'rebuild me' });
    await app.onSend.confirm();
    expect(app.send.get().phase).toBe('form');
    expect(JSON.stringify(app.send.get())).not.toContain('rebuild me');
    expect(wallet.abandoned).toEqual(['op-reviewed']);
    await app.onSend.confirm();
    expect(wallet.sentProposalIds).toEqual(['prop-reviewed']);

    const next = { ...REVIEWED, proposalId: 'prop-next', operationId: 'op-next' };
    wallet.queueProposal(next, 'beef');
    await app.onSend.review();
    expect(app.send.get()).toMatchObject({ phase: 'review', proposal: { proposalId: 'prop-next' } });
    await app.onSend.confirm();
    expect(wallet.sentProposalIds).toEqual(['prop-reviewed', 'prop-next']);
    expect(wallet.proposeArgs).toHaveLength(2);
    expect(app.send.get()).toEqual({ phase: 'sent', txid: 'beef' });
  });

  it('does not propose again until the previous proposal is released', async () => {
    await openSeed();
    const wallet = engine.lastWallet();
    wallet.queueProposal(REVIEWED);
    fill();
    await app.onSend.review();
    expect(wallet.proposeArgs).toHaveLength(1);

    wallet.holdAbandon();
    wallet.queueProposal({ ...REVIEWED, proposalId: 'prop-2', operationId: 'op-2' });
    app.onSend.setAmount('2');
    const pending = app.onSend.review();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(wallet.proposeArgs).toHaveLength(1);
    expect(wallet.abandoned).toEqual([]);

    wallet.releaseAbandon();
    await pending;
    expect(wallet.abandoned).toEqual(['op-reviewed']);
    expect(wallet.proposeArgs).toHaveLength(2);
    expect(app.send.get()).toMatchObject({ phase: 'review', proposal: { proposalId: 'prop-2' } });
  });
});
