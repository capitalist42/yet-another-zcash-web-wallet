# Zcash Browser Wallet — Implementation Plan (v2)

v2 = original plan sharpened by the 2026-10-19 grilling session. Vocabulary: [`CONTEXT.md`](./CONTEXT.md). Decisions recorded: ADR-0001 third-party default endpoint · ADR-0002 app-level seed vault · ADR-0003 one OPFS DB per Wallet · ADR-0004 auto-rotate Receive Address · ADR-0005 TransactionPolicy frozen at client creation · ADR-0006 observe-only payment recovery (`docs/adr/`).

## Context

Self-custodial Zcash wallet running entirely in the user's browser: no backend of ours, no tracking, no signup, spending keys never persisted outside an app-level Vault. Greenfield in `~/Projects/yet-another-zcash-web-wallet`.

**Product shape (settled):** the app manages many **Wallets** (a container per user secret; holds balances + note/UTXO inventory) per **Network**; each Wallet contains its **Accounts** (SDK-level; v1 UI operates on the Wallet's default account — account-switcher deferred). Exactly one open Wallet per Network; the other Network may be open concurrently. Startup opens the last-used Wallet per Network. Ledger hardware support = **v2, out of this plan**.

Verified facts this plan rests on (checked 2026-10-19; SDK facts verified against the published `@zcashlabs/zcash.js@0.1.0-rc.5` tarball):

- **Engine: `@zcashlabs/zcash.js@0.1.0-rc.5`** (npm `latest`, MIT; public repo `github.com/jp4g/zcash.js`; npm `repository` points at a private mirror — ship lockfile-pinned + `integrity`). Browser-native wallet runtime (accounts, UFVK import, unified addresses, lightwalletd gRPC-Web sync, proposals, PCZT build/prove/sign, submit, history, note/UTXO inventory), bundled local Sapling proving params (canonical SHA-256), OPFS storage, documented Vite support. Rejected: ChainSafe WebZjs (no published wallet npm, mandatory COOP/COEP), LeakIX, ZecScope, f3 SDK.
- **Chain endpoints (live, CORS-open, gRPC-Web)**: `https://zcash-mainnet.chainsafe.dev`, `https://zcash-testnet.chainsafe.dev` (ChainSafe's documented WebZjs proxies; intermittent 500s observed → user-configurable override + self-host docs). `zec.rocks` = native gRPC only, not browser-usable; never a default.
- **SDK shapes** (tarball-verified): `createWalletClient(endpoint, {network, storage:{kind:'browser-opfs', name}, transactionPolicy, recovery})`. `SecretInput = Uint8Array`. `accounts.create({mnemonic, passphrase?, name?})` returns memory-only UNATTACHED `MemorySigner` — the SDK never persists spend keys; DB holds viewing keys + history + chain state. `attachSigner/detachSigner/restoreSigner`; `accounts.import({mnemonic|viewingKey, accountIndex, birthday|'fullScan'})` (import REQUIRES explicit `accountIndex` + birthday). `accounts.remove({accountId, acknowledge:'deletes-local-history'})`. Every call rejects with `ZcashError {code, stage, retryable, recovery}` — build UX on those, never message strings.
- **Addresses**: `addresses.current()` is a read (docs: `null` on fresh account; **live rc.5**: `create()` already exposes index 0, so it is non-null after create — see §0 results); `next()` is a durable write that permanently advances the address chain (`ADDRESS_ALREADY_EXPOSED`, `DIVERSIFIER_EXHAUSTED` exist). `addresses.list()`/`at({index})` browse exposed addresses (`at()` also marks exposed).
- **TransactionPolicy is creation-time only** — `ExecuteOptions = {signer?}`; unknown keys rejected. Fields: `spendPools: NonEmpty<'transparent'|'sapling'|'ironwood'>`, `transparent: 'disallow'|'allow-owned'`, `changePool`, `feeRule:'zip317-standard'`, `expiry`, `lockExpiryBlocks`, `shieldingThreshold`, `freshness`. SDK shorthand default = Ironwood-only + `transparent:'disallow'` (unusable for shielding UX; see §2). `InventoryFilter.locked` filters operation-held input locks (`InventoryState.lock {operationId, expiresAtHeight}`) — NOT a user note-lock; no SDK note-lock API exists.
- **Send/recovery**: `send({proposal})` executes exactly the reviewed bytes ("never reselect/reprice/reprove on retry"); durable journal commits before dispatch. Failed/ambiguous submits live in `operations.list/get/resume/abandon`; `PaymentState {phase, steps[{txid, exactBytesSha256, attempts[{outcome:'started'|'acknowledged'|'rejected'|'unknown'}], inclusion, observation, expiry}]}`; `resume` = re-dispatch retained exact bytes. `getTransactionStatus({txid})` → `'notSeen'|'mempool'|'mined'|'offMainChain'|'unknown'`. Startup `RecoveryPolicy` is creation-time: `online {timeoutMs}` with `rebroadcast` omitted = observe-only; `wallet.recovery: RecoveryReport {operations, observation, observedOperations, deferredOperations, lastError}` produced once at creation; payment calls throw `RECOVERY_REQUIRED` until it completes.
- **Shield**: `shield(args)` = propose→finalize→broadcast with NO review window. Reviewable: `propose({kind:'shield', fromAddresses?, toPool?, threshold?})` then `send({proposal})`. `fromAddresses` = address-level (≤16), NOT per-UTXO; `threshold` = dust filter. `transparent:'disallow'` likely starves shielding's internal owned-transparent spend — UNVERIFIED: the funded matrix (spike §0, issue #15) must exercise `propose({kind:'shield'})` under both modes with confirmed t funds before §2 freezes the policy.
- **Sync**: `sync({target?})`, `watchSync()` → `AsyncIterable<SyncStatus>` (`activity`, `scan {tipHeight, fullyScannedHeight, maxScannedHeight, scanComplete}`, `target`, `targetReached`, `enhancement {actionable, delayed}`, `lastError`). No genesis-anchor prerequisite: plans ranges from local DB state. `freshness:'catch-up'` makes `propose` sync first instead of throwing `SYNC_REQUIRED`. Concurrent reads on one watch iterator → `RESOURCE_LIMIT`.
- **Derivation**: `AccountIndex` branded `zip32-account-index`; provenance `scheme:'zip32-and-bip44'`; native pins standard `zip32@0.2.1`. `create` chooses next seed-relative index. Zashi-restore compatibility (`import({mnemonic, accountIndex:0})` = Zashi account 0) is [INFERENCE] → the Zashi cross-check under Verification is REQUIRED before shipping restore-compat claims.
- **Storage plaintext at rest**, no encryption hook (SyncAccessHandle is synchronous → no WebCrypto interception). No `forget`/`deleteDatabase` API: delete = `close()` then recursive OPFS dir removal (handles are exclusive → only provable with one owner per DB → drives DB-per-Wallet, ADR-0003).
- BIP-39 generation NOT in SDK → app uses `@scure/bip39` (MIT, audited).
- **Browser baseline**: no COOP/COEP; secure context required (HTTPS/localhost, not `file://`); OPFS + dedicated workers + `AbortSignal.any`; one DB owner per storage name (`STORAGE_BUSY`). Vite `assetsInlineLimit: 0`; deploy all emitted assets (WASM 21 MB + workers + proving params).
## Approach

Vite + React + TypeScript SPA. Engine calls isolated behind `src/wallet/client.ts`. App-level layers the SDK doesn't provide: Wallet registry, Vault (seed custody), Exclude state, session/lock lifecycle.

### 0. Engine spike (first milestone, throwaway page)
zcash.js README: "complete live-browser send/receive round trip not yet qualified" (issue #165) → one `spike.html` before UI work. Gate checklist (testnet via chainsafe proxy):
1. create client → create wallet → `current()` null → `next()` mints → sync to tip.
2. **Policy experiment matrix**: client created with `spendPools:['sapling','ironwood'], transparent:'disallow'` → receive transparent (faucet) → `propose({kind:'shield'})` → does it fail (`NOTHING_TO_SHIELD`/policy) where `transparent:'allow-owned'` succeeds? Confirms the §2 frozen policy and whether direct transparent sends must also add `'transparent'` to `spendPools` (→ decides §5 Settings switch vs per-send toggle).
3. Reviewable shield via `propose→send`; send-with-memo to second wallet; `operations.list` after a deliberately killed submit → `resume` reconciles by `txid`/observation.
4. Restart survival: reload page mid-`watchSync` → recovery report sane → balances from DB without rescan.
If (1) or (3) fails: halt, re-evaluate engine (fallback below), don't build UI on sand.

**Results (2026-10-20; live mainnet drill, Playwright against `npm run preview`, harness `src/spike/` + `scripts/drill.mjs`).**
- Gate (1) **PASS**, one doc correction: `current()` on a fresh account is NOT null — `accounts.create` already exposes address index 0 (verified live, both fresh accounts). `next()` mints the next unified address (p2pkh+sapling+orchard receivers); sync reached tip. The fact bullet above ("null on fresh account") is what rc.5 docs claim; live behavior wins — §4 Receive must treat "current null" as an edge, not the startup state.
- Gate (2)/(3) funded legs **NOT RUN on mainnet**: no mainnet faucet exists and the bundled runtime rejects testnet (NU7 schedule > codec max Nu6.3 → `NETWORK_MISMATCH`) — so the §2 policy matrix (P1–P4) and the round-trip/submission legs (S3*, S4*) are DEFERRED to issue #15 (testnet funding path). The harness records these legs as explicit `SKIPPED`/`FAIL`, never PASS.
- Gate (4) **PASS** twice: (a) close + reload → account present, `signerAttached=false` (memory-only signer), balance + recovery report sane from OPFS, no rescan; (b) hard reload MID-SCAN (no close) → accounts, balance, and committed scan frontier (`maxScannedHeight`) survive; scan resumes from durable state, no rewind.
- Findings that change product code:
  - Checkpoint birthdays MUST go through `resolveBirthday({ light, firstScanHeight })`: the witness is the tree state at `firstScanHeight − 1`, and a hand-built birthday citing the state AT `firstScanHeight` dies natively as `INVALID_BIRTHDAY` surfaced as opaque `INVALID_ARGUMENT`.
  - `watchSync` publishes only on scan-revision changes; a fullScan from birthday 1 committed zero observable progress inside any sane window. UI sync progress must poll `getSyncStatus()` (answers while a scan runs) or accept revision-only ticks.
  - The persistent reload flag is `signerAttached=false`; `viewOnly` is set only by viewing-key imports — a mnemonic account stays `viewOnly=false` after reload (don't key "locked" UI on `viewOnly`).
  - `accounts.import` on an already-adopted account does NOT throw `ACCOUNT_COLLISION` in practice; the app must look up and adopt/restoreSigner rather than assume collision.
  - Tip race at open (chain advanced between tip read and `accounts.create`/first sync): surfaces as `SYNC_REQUIRED`/resync-guided; reopen + one retry clears it (drill `S1d`).
  - Testnet NU7 vs bundled codec Nu6.3 ⇒ SDK must learn NU7 (or endpoint pinned pre-NU7) before ANY funded matrix runs — gate for #15.

### 1. Scaffold
- Vite react-ts; pin `vite@8.2.2`, React 19, `@zcashlabs/zcash.js@0.1.0-rc.5`, `@scure/bip39@^1.2.1`.
- `vite.config.ts`: `assetsInlineLimit: 0`; `build.target:'esnext'`; no COOP/COEP.
- CSP `index.html`: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https: (ship with preset URLs; tightening = deploy-docs step for self-hosters); worker-src 'self' blob:`.
- Deploy docs: ship all `dist/` (no CDN); single-tab-per-DB warning.

### 2. Wallet service layer (`src/wallet/`)
- `registry.ts` (IndexedDB): Wallets per network `{id, name, fingerprint, kind:'seed'|'viewonly', lastUsed, policy overrides, excludedNotes}`; drives startup (open last-used per network), switcher, Forget. `navigator.storage.persist()` on create (OPFS eviction guard).
- `client.ts`: open/close one `WalletClient` per network; storage name `yaw-<network>-<id>`; endpoint from Settings (presets + free-text override); frozen policy (ADR-0005; read Settings before every create, including the first): `spendPools:['sapling','ironwood']`, plus `'transparent'` only when "Allow transparent sends" is on (default off); `transparent:'allow-owned'` always (SDK source: shielding spends owned transparent inputs; `disallow` starves them — live-funded confirmation of the both-modes matrix deferred to #15, see §0 results; direct sends stay behind the switch); `changePool:'ironwood'`; `expiry:{kind:'offset',blocks:5}`; `shieldingThreshold:10000n`; `freshness:{mode:'catch-up',maxLagBlocks:10,timeoutMs:30000}`; `recovery:{mode:'online',timeoutMs:15000}` (offline when the endpoint is unreachable). A policy change silently closes and reopens the client. Boot order: registry → open client → await `wallet.recovery` → balances from DB → `watchSync` → non-terminal ops light the Pending-Payment chip.
- `vault.ts`: WebCrypto envelope in IndexedDB — PBKDF2-SHA256 210k (user-chosen passphrase, random salt) → AES-GCM-256. Choices at create/restore: "Remember on this device (encrypted)" | "Never store". Unlock = decrypt → `restoreSigner` (SDK verifies phrase vs stored viewing key) → `attachSigner`; decrypted seed mirrored in `sessionStorage` with a persisted idle deadline. Unlock survives iff deadline-unexpired AND no Lock flag — that check runs on every boot and is the ONLY guarantee: browser session-restore can resurrect `sessionStorage` across tab/process death, so treat process kill as best-effort lifetime, never a security boundary. Lock (app-wide, both networks) = `detachSigner` + zeroize + clear mirrors + set Lock flag. Auto-lock 10 min inactivity (send attempts count as activity; sync watching doesn't); countdown chip; no hard cap. Never auto-decrypt at startup.
- `keys.ts`: `@scure/bip39` 24-word (256-bit `crypto.getRandomValues`); validate on import; zeroize phrase bytes (`fill(0)`) after use.
- State: `@nanostores/react@^1` fed by `watchSync`/`getSyncStatus`/`getBalance`/`getHistory`/`operations.list`.

### 3. Onboarding
- Welcome → Create (phrase, forced backup confirmation grid) | Restore (phrase + optional passphrase + `accountIndex` + birthday choice fullScan/height — Zashi-compat path) | View-only (UFVK import; no Vault, no Unlock machinery, Send hidden). Per-Wallet endpoint prefill from Settings default.
- Network toggle (Mainnet/Testnet), persistent chip; Wallet switcher (name + 4-char UFVK fingerprint); tour overlay (skip-able).
- Onboarding privacy sentence: "your lightwalletd provider can see your activity; choose your own in Settings" (ADR-0001).

### 4. Wallet screens
- **Receive**: shows Receive Address = `addresses.current()` (mint via `next()` only when null); auto-rotate: when sync observes an inbound transfer land on the displayed address → `next()` (ADR-0004; never rotate on self-change/shielding); Exposed Address list (`addresses.list`) with per-address received history; QR + copy + reveal-under-click.
- **Sync**: progress from `watchSync` (`fullyScannedHeight`/`maxScannedHeight` vs `target`, `targetReached`); manual resync; `STORAGE_BUSY` single-tab screen.
- **Balances**: transparent / shielded (sapling + ironwood) buckets, pending/available; "N excluded" count with one-tap reset; fiat omitted.
- **Send**: recipient (t/u/ZIP-321 minimal parse); t-recipient typed into a Wallet with transparent sends disabled → inline warning + link to Settings switch ("you have to explicitly enable it"); amount; memo (warn: rides in tx, encrypted to recipient); fee preview from `propose()`; confirm screen = proposal inputs/outputs/fee/expiry; `send({proposal})` executes exactly reviewed plan. Transparent inputs: never selected unless "Allow transparent sends" is enabled (§5); errors mapped from `ZcashError.recovery` (`reattach-signer` → Unlock prompt; `sync` → sync screen; `review-new-proposal` → rebuild proposal).
- **Shield**: propose→review→send (never bare `shield()`); address-checkbox list of transparent addresses (default all) + threshold input; `NOTHING_TO_SHIELD` handled.
- **Pending Payments**: global chip whenever any operation is non-terminal → detail: attempts, `txid`, chain `observation.state`, expiry; actions = Resume (`operations.resume`, exact bytes) and Abandon — Abandon labeled "Give up on this payment (funds return to your balance)", shown only when observation is `notSeen`/absent (never while mempool). Observe-only recovery (ADR-0006): automatic rebroadcast is deliberately not enabled, so every re-dispatch is a user-initiated Resume.
- **History**: paginated `getHistory`, per-tx detail (pool flows, own-output memo reveal, explorer link = explicit user click).
- **Coin control (notes)**: `listNotes`/`listUtxos` (+ `locked`/`spendState` columns as display-only truth about operation locks); Exclude = app-side persisted set; send composition excludes them, asserts proposal inputs == selection, on deviation shows actual proposal + explicit accept; per-send pool restriction not possible (creation-time policy) — document.

### 5. Settings & privacy
- Endpoints editor per network (presets + override + self-host docs); "Allow transparent sends" switch (policy reopen + warning); shielding threshold; expiry; Vault passphrase management; encrypted backup export/import (`.yaw` = same envelope); Forget Wallet = close + recursive OPFS delete + registry row + Vault entry; zero analytics/fetch beyond endpoint.
- Platform stance (ADR-0001 sibling): desktop browsers, Chromium-first; Firefox/Safari best-effort; mobile = read-only-ish, nothing promised; WebHID features = v2.

### 6. v2 backlog (recorded, NOT in this plan)
Ledger (DMK + signer-kit; `createCustomSigner` adapter; WebHID Chromium-gate; V6/`zcash_unstable` risk [INFERENCE]); account switcher UI; cross-pool sweeps; COOP/COEP + threading if proving perf demands; compact-blocks CDN optimization; endpoint picker at first run.

## Verification
1. `npm run dev` on 127.0.0.1; create Wallet; backup gate enforced; reload → locked → Unlock from Vault; reload within idle → still unlocked (session mirror); Lock → reload → locked despite mirror lifetime; unlock past the idle deadline (fake timestamp) → passphrase re-prompted even though the mirror still exists; restore after process kill → whatever session restore does, the deadline+flag check alone decides unlocked state.
2. Testnet e2e vs chainsafe proxy: create → sync → faucet → Shield (address checkboxes, threshold) → send w/ memo to Wallet B → history both sides. DevTools proof: OPTIONS preflight + `application/grpc-web-text+proto` 200 `grpc-status: 0`.
3. Auto-rotate: receive to displayed address → next inbound lands → displayed address advanced; old address visible in Exposed Address list; self-change did NOT rotate.
4. Failed-send drill: kill network during submit → chip lights → detail shows `outcome:'unknown'` + observation → network back → Resume → mined; Abandon path on an expired proposal (funds return).
5. Coin control: Exclude note A, select-to-send → executed tx spends only B (nullifiers on testnet); reload → exclusion persists + "1 excluded" chip.
6. Multi-Wallet: create 2 Wallets mainnet → switch → last-used reopens after reload; Forget deletes DB dir (verify via DevTools Application panel) and its Vault entry.
7. Mainnet sanity: 2026-birthday Wallet → sync → balances match Zashi for same seed; Zashi-restore cross-check (`import accountIndex:0`) — REQUIRED before any restore-compat claim.
8. Prod build: `vite preview`, all assets load, no COOP/COEP, second tab same DB → STORAGE_BUSY screen. Full session = zero third-party requests except endpoint (Lighthouse/obs).

## Assumptions & fallbacks
- ChainSafe proxies up; else Settings override + `README-selfhost.md` (`lightwalletd-rs --grpc-web`, Envoy/grpcwebproxy).
- rc.5 drift before 1.0: isolation behind `client.ts`, pin + `integrity`; provenance gap (private mirror, `zcashlabs` ≠ ECC) accepted; spike is the mitigation.
- Engine fallback if §0 fails: ChainSafe WebZjs rebuilt audited from `crates/` (proving params bundled ≈50 MiB→8 MB wasm, no fetch) — costs COOP/COEP + self-hosted grpc-web proxy; hence spike-first.
- `transparent:'allow-owned'` required-for-shielding rests on the SDK source (shield input selection), NOT yet on a live funded run; `'transparent'`-not-needed-in-`spendPools`-for-direct-sends is structurally UNTESTED (the frozen policy never lists `'transparent'`). Both legs run in the #15 funded matrix before §2 freezes (ADR-0005 consequence).
- Zashi derivation compat [INFERENCE]: the Zashi cross-check under Verification decides whether we ship the claim.
- Firefox/Safari: full software wallet works; no HW at all in v1.
- No COOP/COEP v1; isolation headers are a later isolated change if proving perf demands.
