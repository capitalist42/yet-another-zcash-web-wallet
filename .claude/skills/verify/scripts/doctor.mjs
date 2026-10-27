#!/usr/bin/env node
// Read-only doctor for the verify skill: answers "is this instance worth
// driving?" — our preview on our port, fresh build, Chromium resolvable,
// both default lightd endpoints answering GetLatestBlock, no drill/HANG.
// Usage: node doctor.mjs --port 4317
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { findChrome, ENDPOINTS, lightdHeight } from './lib.mjs';

const port = Number(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? process.env.YAW_PORT ?? 4173);
const BASE = `http://127.0.0.1:${port}`;

const checks = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (e) {
    checks.push({ name, ok: false, detail: String(e).slice(0, 300) });
  }
};

await check('preview', async () => {
  const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3_000) }).catch((e) => {
    throw new Error(`no answer at ${BASE}: ${e.message}`);
  });
  const html = await res.text();
  if (res.status !== 200) throw new Error(`http ${res.status} at ${BASE}`);
  if (!html.includes('Content-Security-Policy')) throw new Error('served html lacks the CSP meta — not our build');
  const pidfile = `/tmp/yaw-preview-${port}.pid`;
  if (!existsSync(pidfile))
    throw new Error(`200 at ${BASE} but no pidfile ${pidfile} — instance not launched by a verify run; do not drive it`);
  const pid = Number(readFileSync(pidfile, 'utf8').trim());
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error(`pid ${pid} from ${pidfile} is dead`);
  }
  return `200 at ${BASE}, pid ${pid} alive, CSP present`;
});

await check('build', () => {
  const dist = 'dist/index.html';
  if (!existsSync(dist)) throw new Error('dist/index.html missing — run `npm run build`');
  const distM = statSync(dist).mtimeMs;
  const newestSrc = execFileSync('find', ['src', 'index.html', 'vite.config.ts', '-newer', dist, '-type', 'f'], {
    encoding: 'utf8',
  }).trim();
  if (newestSrc !== '') throw new Error(`sources newer than dist:\n${newestSrc}\nrun \`npm run build\``);
  return `dist newer than all of src/ (${new Date(distM).toISOString()})`;
});

await check('chrome', () => {
  const c = findChrome();
  if (c === undefined) throw new Error('no chromium: set YAW_CHROME or install a Playwright chromium');
  if (!existsSync(c)) throw new Error(`resolved chromium missing on disk: ${c}`);
  return c;
});

for (const [net, url] of Object.entries(ENDPOINTS)) {
  await check(`lightd-${net}`, async () => {
    const h = await lightdHeight(url);
    return `${url} @ height ${h.toLocaleString('en-US')}${
      net === 'testnet' && h > 4_465_026
        ? ' (NU7 — pinned fork selects the NU7 branch; testnet legs must reach the wallet screen)'
        : ''
    }`;
  });
}

await check('drill-HANG', () => {
  if (existsSync('drill/HANG')) throw new Error('drill/HANG exists — spike hang-proxy armed; rm drill/HANG before drill legs');
  return 'off';
});

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`);
const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? '\nall checks green — instance is worth driving' : `\n${failed.length} check(s) failed — fix before driving`);
process.exit(failed.length === 0 ? 0 : 1);
