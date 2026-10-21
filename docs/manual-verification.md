# Manual verification checklist (issues #3/#4)

Automated CI covers typecheck, unit suites (engine-port fakes, fake-indexeddb
registry), and the production build. The items below need a real browser
and/or live chain and MUST be run before claiming the corresponding ACs:

## Live engine leg (scripts/live.mjs — real Chromium, preview build, CSP)
Qualification run 2026-10-21 (headless Chromium via `node scripts/live.mjs
<network>` against `npm run preview`):

- [x] **Mainnet create end-to-end**: welcome → Create → real signer generates
      the 24-word phrase → backup gate → engine open (WASM + OPFS + blob
      worker under CSP) → fresh-DB create against `zcash-mainnet.chainsafe.dev`
      → wallet screen with Receive Address, sync line, history. Two
      consecutive runs, zero console/page errors. Required one CSP fix
      (`script-src 'self' blob:` — Chromium treats the SDK's blob-URL wallet
      worker as script) and one flow fix (bounded `syncFresh` + single
      `SYNC_REQUIRED` retry: `accounts.create` rejects until local chain
      state is coherent).
- [x] **Testnet behaves as the NO-GO predicts**: open succeeds, the bounded
      freshness pass cannot follow the NU7 tip (rc.5 codec stops at Nu6_3),
      create surfaces `SYNC_REQUIRED` after the single retry — honest, no
      silent corruption. Remove this line when the SDK ships NU7 support.
- [ ] Restore from a funded seed and see real balances after scan (mainnet
      funds required; also the Zashi cross-check below).
- [ ] View-only import of a UFVK belonging to a funded mainnet account:
      history and balances render, Send remains unavailable, no mint.

## Zashi cross-check (issue #4 AC)
- [ ] Create in Zashi, restore the same phrase here (and vice versa):
      same account fingerprint and balances at the same birthday height.
      No funded testnet seed available while the NO-GO stands; redo on
      mainnet once the wallet is exposed there.

## Browser surface (can run today)
- [x] `npm run build && npm run preview` → root page: welcome screen renders,
      zero third-party requests (scripts/smoke.mjs asserts this headlessly).
- [x] Two tabs on the same wallet: second tab shows the storage-busy screen
      (scripts/live.mjs asserts this against the live build).
- [x] Reload persistence: create → reload → boots straight into the wallet
      (scripts/live.mjs).
- [ ] Network toggle: switch testnet↔mainnet; the old client closes, the new
      network's registry row boots.
