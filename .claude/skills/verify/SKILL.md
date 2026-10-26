---
name: verify
description: Verify the Zcash browser wallet (this repo's React product UI at /, served by vite preview) by driving the real app in headless Chromium with playwright-core. Use when a change to onboarding, boot/persistence, network switching, balances/history, or storage leasing needs behavioral proof, or when docs/manual-verification.md items are being claimed.
---

# Verify: Zcash browser wallet

Self-custodial Zcash wallet running entirely in the browser: no backend of ours, keys never leave the browser, chain access via a third-party lightwalletd (lightd) gRPC-Web endpoint. There is no server-side app to poke — the ONLY honest verification is: build the product, serve it, drive it in a real Chromium with a throwaway profile, against the real chain.

The unit suites (`npm test`) and `npm run typecheck` prove module logic. They do NOT prove the app works: engine WASM, OPFS storage, blob workers under CSP, IndexedDB leasing, and live lightd sync only show up in the browser leg. That leg is what this skill scripts.

## Ground rules (repo-specific)

- **Product vs spike**: the product is `/` (`index.html` → `src/main.tsx` → `src/app/App.tsx`). `/spike.html` + `scripts/drill.mjs` + the `drill/HANG` toggle + `:8081` broadcaster proxy are ticket-#2 spike qualification plumbing — do not use them to claim product behavior.
- **Live chain is the chain of record.** Default endpoints (`src/wallet/policy.ts`): mainnet `https://zcash-mainnet.chainsafe.dev`, testnet `https://zcash-testnet.chainsafe.dev`. The SDK pins `@zcashlabs/zcash.js@0.1.0-rc.5`, whose codec tops out at Nu6.3 while the public testnet went NU7 (block 4,465,026). **Consequence, by design:** testnet create/restore surfaces `SYNC_REQUIRED` after one retry. An honest `SYNC_REQUIRED` on testnet is a PASS for error-handling legs and a hard precondition failure for anything needing scan/balance. Never weaken a journey to make it pass; record the reason in the feature's Gotchas.
- **Funds**: mainnet funds are not scripted. The Send form opens from a seed wallet (see `features/send.md`); reviewing and broadcasting still need spendable shielded funds and are operator-run. View-only/restore journeys against funded accounts need operator-supplied secrets and are listed as preconditions, not faked.
- **Never touch the user's browser or wallet.** Verification runs in a throwaway Playwright context (fresh profile per run). Recovery phrases a journey generates are throwaway by construction; still never print one into a committed file.
- **Do not kill a preview server you did not start.** Port 4173 may be owned by a human's long-running `npm run preview`. Launch on a run-specific port instead (see Launch).

## Launch

Prereqs once per machine: `npm install` (playwright-core ships as a devDep; the Chromium binary comes from `~/.cache/ms-playwright` — if absent, `npx playwright-core install chromium` is NOT wired here, report it and stop, or set `YAW_CHROME=/path/to/chrome`).

```bash
# 1. production build (also the typecheck gate; fail fast)
npm run build

# 2. serve the dist — run-SPECIFIC port; --strictPort means fail-fast, never drift
PORT=4317
npm run preview -- --port $PORT --strictPort --host 127.0.0.1 > /tmp/yaw-preview-$PORT.log 2>&1 &
echo $! > /tmp/yaw-preview-$PORT.pid
```

Ready means: `curl -fsS http://127.0.0.1:$PORT/ | grep -q 'Content-Security-Policy'` succeeds (vite preview prints `Local: http://127.0.0.1:$PORT/` within a second; the grep confirms our build, including the CSP meta with `script-src 'self' blob:` — without `blob:` the SDK's wallet worker dies with `RUNTIME_UNAVAILABLE`). "Process listening" is not ready; the page must answer with OUR html.

There are no migrations or seed data: an empty profile IS the welcome state. A wallet "exists" only in a browser profile's IndexedDB + OPFS, so each fresh Chromium context boots to `welcome`; persistence legs reload the SAME context.

Teardown: see Cleanup. Never `pkill`/`killall` node/chromium — kill only the PID in your pidfile and the browser handle you launched.

## Doctor

First thing to run whenever anything looks off (and it is what `.claude/skills/verify/scripts/run.mjs` prints at startup):

```bash
node .claude/skills/verify/scripts/doctor.mjs --port $PORT
```

Read-only. Answers, per check, PASS/FAIL + detail:

- `preview` — port owned by us: HTTP 200 at `127.0.0.1:$PORT` AND our PID in the pidfile is alive AND the served html contains the CSP meta. (A 200 from someone else's preview on 4173 fails the PID check — right answer: do not drive an instance you did not launch.)
- `build` — `dist/index.html` mtime is newer than `src/` and `index.html` newest files; stale build = rebuild before driving.
- `chrome` — Playwright Chromium resolvable (same discovery as the scripts: `YAW_CHROME` env wins, else newest `chromium-*` under `~/.cache/ms-playwright`).
- `lightd-mainnet` / `lightd-testnet` — real gRPC-Web `GetLatestBlock` (empty `Empty` request, body `00 00000000`, path `/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock`, header `content-type: application/grpc-web+proto`, `x-grpc-web: 1`) against each default endpoint; decodes and prints the block height from the protobuf `Block{height=2 varint}`. A green doctor here means the endpoints are alive; it does NOT promise the rc.5 codec accepts the tip (testnet: it won't — NU7).
- `drill-HANG` — warns if `drill/HANG` exists (spike hang-proxy left on makes S4 legs hang; not used by product legs but its file poisons drill runs).

Any FAIL: stop, fix that, re-run. Driving a half-healthy instance produces fake failures everywhere.

## Drive

Harness: `playwright-core` (pinned 1.58.2) + `chromium.launch({ executablePath, args: ['--no-sandbox', '--use-gl=swiftshader', '--disable-dev-shm-usage'] })`, headless. Chrome discovery is factored into the helper scripts; reuse `scripts/live.mjs`-style code only as reference — the maintained entrypoint is:

```bash
node .claude/skills/verify/scripts/run.mjs --port $PORT --feature create-wallet [--network mainnet|testnet]
```

`run.mjs` runs doctor, launches browser, drives ONE feature recipe from `features/<id>.md`, writes evidence to `.claude/skills/verify/evidence/<utc-stamp>-<feature>/`, prints the outcome line, exits 0 on pass / non-zero with the failed step name otherwise. To hand-drive or add a journey, use the same handles (all live in `src/app/App.tsx`; prefer ARIA labels and these exact strings):

- App root: `main.app` carries `data-network="mainnet|testnet"` — assert it, don't infer.
- Screens are mutually exclusive by aria-label: `[aria-label="welcome"]`, `[aria-label="wallet"]`, `[aria-label="storage busy"]`. Boot text while switching: "Loading your Wallet…".
- Welcome tabs: buttons `Create`, `Restore`, `View-only` (no aria; match accessible name).
- Create: button text `Create a new Wallet` → `[aria-label="backup gate"]` with `ol.phrase li` × 24 (strip leading "N " numbering from each li), 3 quiz inputs `[data-word-position="N"]` (type `words[N - 1]` into each), button `I saved my phrase`. No dismiss control — only the matching words exit. On `SYNC_REQUIRED` the gate hands off to `[aria-label="sync retry"]` (raw engine message in `.error`; buttons `Try again`, `Switch to Mainnet` on testnet only, `Back to my recovery phrase` which returns to the gate).
- Restore: `[aria-label="restore"]` — `textarea` (phrase), `input[type=password]` (passphrase), numeric `Account index`, checkbox `Full scan from genesis` (checked by default; uncheck reveals `Birthday height` input), button `Restore`. No custody radios and no vault-passphrase fields; the seed is stored encrypted on this device.
- View-only: `[aria-label="view-only import"]` — `textarea` labeled `Unified Full Viewing Key`, same birthday fields, button `Import`.
- Wallet screen: `[aria-label="wallet"]`; header h1 = wallet name + fingerprint chip (4-char lowercase base32; `View-only` chip when kind=viewonly); sync widget `[aria-label="sync"]`: label `Syncing wallet`/`Wallet synced`/`Sync failed`, overall percent (birthday→tip range, capped at 99 until `targetReached`) right-aligned, `div[role="progressbar"][aria-valuenow]`, detail `p.muted.sync-detail` = `scanned N / M[ · B blocks to go]` (or `· up to date`); balances list items `Transparent`/`Sapling`/`Ironwood`; `p.address[data-testid="receive-address"]`; Send button `disabled` with title "Send ships in the next milestone" (spend-capable) or the muted line "No spend authority — this Wallet is view-only."; history `ul[aria-label="history"]` or muted "No transactions yet.".
- Errors render in `.error` (single visible element per screen: welcome boot errors, gate phrase mismatch, the sync-retry screen, restore/import failures — engine codes like `SYNC_REQUIRED` arrive as text there).
- Network switch: header button `Switch to testnet`/`Switch to mainnet` — the old client must close and the OTHER network's registry row boot (with no wallet there: welcome). Watch `main.app` `data-network` flip.
- Errors are ground truth: capture `console.error`, `pageerror`, `weberror`, and worker `Runtime.exceptionThrown` via CDP (`context.newCDPSession(page)` + `Runtime.enable`) — dedicated workers are invisible to page console events, and CSP worker deaths show up nowhere else. The browser's automatic `/favicon.ico` 404 probe is NOT an app error; filter it.
- `page.on('request')`: zero third-party requests is a product invariant (ADR-0001: connect-src 'self' https: to the lightd endpoint you configured is expected and fine; anything else — analytics, CDNs — is a FAIL).

Timing that is real, not flake: first create opens WASM (~21 MB) + proving params (~50 MB) + a bounded `syncFresh` against lightd. Budget 60 s to the backup gate, 240 s for the wallet screen, and treat >30 s on a re-open as suspicious. `?network=mainnet|testnet` in the URL forces the boot network for a fresh profile (`networkFromQuery` in `src/wallet/app.ts`); default boot is testnet.

## Evidence

Destination: `.claude/skills/verify/evidence/<UTC-ISO>-<feature>/`. Nothing tracked: that directory carries its own `.gitignore` (`*` + `!.gitignore`) so proofs never enter git. Each run writes:

- `console.log` — the full driver transcript: every action + observed state + endpoint/height lines (side effects the DOM cannot show: lightd request URLs, error strings).
- `state-<step>.aria.yml` — `locator('body').ariaSnapshot()` after each mapped state transition (welcome, gate, after-open, final), not just the end screen.
- `final.png` — full-page screenshot (viewport 1280×1400; the wallet screen is long).
- `meta.json` — `{ command, port, network, endpoint, gitRev, outcome, failures[] }`.

Proof standards (non-negotiable):

- Exercise the real user path. The app service (`getApp()`) is a module singleton but NOT exposed on `window` — there are no internal setters or test-only endpoints to fall back on, and reaching for one is itself a finding.
- Capture the action and the resulting state, not just the final screen: aria snapshot after the click, after the gate confirm, after the wallet boots. Reload persistence means reload in the SAME context and observe the wallet screen again.
- Verify side effects alongside what's visible: for create, the SECOND tab must show `storage busy` (OPFS lease) and a reload must boot straight into the wallet (registry row + engine DB survived); for a wallet screen, the lightd traffic in `console.log` is part of the proof that it is live-synced, not decorative text.
- Honest failures pass honest legs: the testnet `SYNC_REQUIRED` leg PASSES by observing the `.error` element carry it (and nothing silent after) — record the observed string in `console.log`.
- Mocks only at production boundaries already isolated: the engine port (`src/wallet/engine/port.ts`) mocks exist for vitest; the browser leg must never stub the engine or the endpoint.
- Where a leg claims "nothing happens" (view-only can't mint/send; create writes no disk file outside the profile), prove it by observation: a view-only wallet shows "No spend authority — this Wallet is view-only." and no Send button, and `page.on('request')` shows zero requests to any non-endpoint host.

## Cleanup

`run.mjs` closes the browser it launched and leaves YOUR preview running on purpose (drive several features against one instance); when the session is done, kill the preview you started:

```bash
kill "$(cat /tmp/yaw-preview-$PORT.pid)" 2>/dev/null; rm -f /tmp/yaw-preview-$PORT.pid
# browser: only the playwright handle this run launched (run.mjs closes it)
```

- Kill ONLY the preview PID you started (pidfile), never by process name. The Playwright browser is `browser.close()`-owned by your script and dies with it.
- Fresh contexts leak nothing to the repo: profiles live under the run's `/tmp` browser dir. Throwaway phrases generated mid-run die with the profile; never write one to a tracked file.
- If a drill toggle (`drill/HANG`) was touched by an adjacent spike leg, `rm drill/HANG` — doctor warns if not.
- Evidence survives: cleanup removes processes and scratch state, NEVER `.claude/skills/verify/evidence/`. Proofs are the deliverable.

## Helpers

- `.claude/skills/verify/scripts/doctor.mjs` — the read-only instance check, one file, no deps beyond node. `node .../doctor.mjs --port 4317`.
- `.claude/skills/verify/scripts/run.mjs` — doctor gate → drive one feature → evidence; closes only its own browser (preview outlives it; kill via pidfile). `node .../run.mjs --port 4317 --feature create-wallet --network mainnet`. Exit 0 pass; exit 1 = doctor/refused; exit 2 = journey step failed (failed step + state dump + `failure-N.png` printed and in evidence).
- Both scripts use the repo's Chrome-discovery convention (`YAW_CHROME` env → newest `~/.cache/ms-playwright/chromium-*/chrome-linux{,64}/chrome`). Keep it that way so a playwright-core version bump can't strand a hardcoded path.

Read `features/README.md` for the maintained journey map before driving anything; a proof that skips a mapped entry point is incomplete. `docs/manual-verification.md` holds the live-qualification checklist this skill automates; tick items only with an evidence dir to point at.
