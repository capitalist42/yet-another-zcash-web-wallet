// Shared plumbing for the verify-skill scripts.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

// Chrome discovery: YAW_CHROME wins; otherwise the newest chromium-* under the
// Playwright cache (revision follows the installed playwright-core, so a
// version bump must not strand a hardcoded path). Same convention as
// scripts/live.mjs — keep them in sync.
export const findChrome = () => {
  if (process.env.YAW_CHROME) return process.env.YAW_CHROME;
  const cache = `${homedir()}/.cache/ms-playwright`;
  const revs = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const rev of revs) {
    for (const p of [`${cache}/${rev}/chrome-linux64/chrome`, `${cache}/${rev}/chrome-linux/chrome`]) {
      if (existsSync(p)) return p;
    }
  }
  return undefined;
};

export const LAUNCH_ARGS = ['--no-sandbox', '--use-gl=swiftshader', '--disable-dev-shm-usage'];

// Defaults from src/wallet/policy.ts — keep in sync if ADR-0001 endpoints change.
export const ENDPOINTS = {
  mainnet: 'https://zcash-mainnet.chainsafe.dev',
  testnet: 'https://zcash-testnet.chainsafe.dev',
};

// gRPC-Web GetLatestBlock with an empty Empty request (flags=0, length=0).
// Data frame payload: 0x08 <height:varint> 0x12 <hash:32B>; trailer frame
// must carry grpc-status: 0. (Same call the SDK makes; no app involvement.)
export const lightdHeight = async (endpoint, timeoutMs = 15_000) => {
  const res = await fetch(`${endpoint}/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: Buffer.from([0, 0, 0, 0, 0]),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`http ${res.status}`);
  let data = null;
  let trailer = '';
  for (let p = 0; p + 5 <= buf.length; ) {
    const flag = buf[p];
    const len = buf.readUInt32BE(p + 1);
    const body = buf.subarray(p + 5, p + 5 + len);
    if (flag === 0) data = body;
    else trailer += body.toString('latin1');
    p += 5 + len;
  }
  if (data === null) throw new Error(`no data frame; trailer: ${trailer.replace(/\r\n/g, ' ').slice(0, 120)}`);
  if (!trailer.includes('grpc-status: 0')) throw new Error(`trailer: ${trailer.replace(/\r\n/g, ' ').slice(0, 120)}`);
  if (data[0] !== 0x08) throw new Error(`unexpected payload head: ${data.subarray(0, 4).toString('hex')}`);
  let height = 0;
  let shift = 0;
  let q = 1;
  for (;;) {
    const b = data[q++];
    height += (b & 127) * 2 ** shift;
    if (!(b & 128)) break;
    shift += 7;
  }
  return height;
};
