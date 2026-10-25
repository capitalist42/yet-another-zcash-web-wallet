import { readFileSync, writeFileSync } from 'node:fs';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  createLightClient,
  createWalletClient,
  defineNetwork,
  getConsensusContext,
  resolveBirthday,
} from '@zcashlabs/zcash.js';
import { createGrpcWebByteTransport } from '/home/capitalist42/Projects/yet-another-zcash-web-wallet/node_modules/@zcashlabs/zcash.js/dist/src/clients/grpc-web.js';

const protocolRevision = 'lightwire:80575dbe59a9bf2e6b79e2391eb78679c453f1a0477292eb97ea3b58bb6c8b10:d8d0c8aaa5ceec7d5dcc188ef25b04011df2ec0254901620fce982fc13aeb32d';
const NU7 = 0x77190ad9;
const FAUCET = 'https://faucet.testnet.valargroup.dev/api';
const OUT = '/home/capitalist42/Projects/yet-another-zcash-web-wallet/testnet-faucet.local';

const network = await defineNetwork('testnet');
const web = createGrpcWebByteTransport('https://zcash-testnet.chainsafe.dev/', { timeoutMs: 60_000 });
const transport = {
  kind: 'custom-lightwallet',
  sourceId: 'chainsafe-testnet',
  protocolRevision,
  unary: (args) => web.unary(args),
  stream: (args) => web.stream(args),
};
const chainLight = await createLightClient({ network, transport });
const chainTip = await chainLight.getTip();
const chainInfo = await chainLight.getServerInfo();
const chainCtx = getConsensusContext({ network: chainLight.network, targetHeight: chainTip.height });
if (chainCtx.branchId !== NU7) throw new Error(`chainsafe branch ${chainCtx.branchId.toString(16)}`);
console.log('CHAINSAFE', JSON.stringify({
  server: chainInfo.version,
  vendor: chainInfo.vendor,
  tip: chainTip.height,
  branchId: chainCtx.branchId.toString(16).padStart(8, '0'),
}));

const statusRes = await fetch(`${FAUCET}/status`);
const status = await statusRes.json();
console.log('FAUCET_STATUS', statusRes.status, JSON.stringify({
  ready: status.ready,
  walletSynced: status.walletSynced,
  payout: status.payout,
  chainHeight: status.chainHeight,
}));
if (!status.ready || !status.walletSynced) throw new Error('faucet not ready');

const phrase = JSON.parse(readFileSync(OUT, 'utf8')).mnemonic;
if (!validateMnemonic(phrase, wordlist)) throw new Error('mnemonic invalid');
const mnemonic = new TextEncoder().encode(phrase);
const rocks = await createLightClient('https://testnet.zec.rocks:443', { network: 'testnet' });
const tip = await rocks.getTip();
const rocksCtx = getConsensusContext({ network: rocks.network, targetHeight: tip.height });
if (rocksCtx.branchId !== NU7) throw new Error(`zec.rocks branch ${rocksCtx.branchId.toString(16)}`);
console.log('ZEC_ROCKS', JSON.stringify({
  tip: tip.height,
  branchId: rocksCtx.branchId.toString(16).padStart(8, '0'),
}));
const birthday = await resolveBirthday({ light: rocks, firstScanHeight: tip.height });
const wallet = await createWalletClient('https://testnet.zec.rocks:443', {
  network: 'testnet',
  storage: { kind: 'memory' },
  recovery: { mode: 'offline' },
});
try {
  const imported = await wallet.accounts.import({ mnemonic, accountIndex: 0, birthday });
  const transparent = (await wallet.addresses.next({
    accountId: imported.account.id,
    request: { format: 'transparent' },
  })).address;
  const unified = (await wallet.addresses.next({
    accountId: imported.account.id,
    request: { format: 'unified', transparent: 'omit', sapling: 'require', ironwood: 'omit' },
  })).address;
  console.log('ADDRESSES', JSON.stringify({ transparent, unified }));
  if (!transparent.startsWith('tm')) throw new Error(`unexpected transparent prefix ${transparent.slice(0, 3)}`);
  if (!unified.startsWith('utest1')) throw new Error('unexpected unified prefix');
  // Faucet unshielded balance is 0, so a transparent payout is rejected.
  const payTo = unified;
  writeFileSync(OUT, `${JSON.stringify({
    network: 'testnet',
    mnemonic: phrase,
    transparent,
    unified,
    payTo,
  }, null, 2)}\n`, { mode: 0o600 });

  const claimRes = await fetch(`${FAUCET}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: payTo }),
  });
  let claim = await claimRes.json();
  console.log('CLAIM', claimRes.status, JSON.stringify(claim));
  if (claim.error) throw new Error(`claim refused: ${claim.message ?? claim.error}`);
  for (let i = 0; i < 24 && claim.status === 'queued'; i += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    claim = await (await fetch(`${FAUCET}/claim/${claim.id}`)).json();
    console.log('POLL', claim.status, claim.txid ?? '');
  }
  if (claim.status === 'failed') throw new Error(`claim failed: ${claim.message ?? claim.error ?? 'unknown'}`);
  if (claim.status !== 'sent') throw new Error(`claim still ${claim.status}: ${claim.message ?? ''}`);

  let balance = 0n;
  const accountId = imported.account.id;
  for (let i = 0; i < 20; i += 1) {
    const statusSync = await wallet.sync();
    const bal = await wallet.getBalance({ accountId });
    balance = bal.amounts?.total ?? 0n;
    console.log('SYNC', JSON.stringify({
      scanned: statusSync.scan?.maxScannedHeight ?? null,
      complete: statusSync.scan?.scanComplete ?? null,
      total: balance.toString(),
      ironwood: bal.amounts?.ironwood?.spendable?.toString?.() ?? null,
    }));
    if (balance > 0n) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }

  const record = {
    network: 'testnet',
    mnemonic: phrase,
    transparent,
    unified,
    faucet: claim,
    balanceZats: balance.toString(),
    chainsafe: {
      tip: chainTip.height,
      branchId: chainCtx.branchId.toString(16).padStart(8, '0'),
      server: chainInfo.version,
    },
  };
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log('SAVED', JSON.stringify({
    transparent,
    txid: claim.txid ?? null,
    balanceZats: balance.toString(),
    status: claim.status,
  }));
  if (balance <= 0n) process.exitCode = 2;
} finally {
  mnemonic.fill(0);
  await wallet.close();
}
