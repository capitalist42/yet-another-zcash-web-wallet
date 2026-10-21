# Manual verification checklist (issues #3/#4)

Automated CI covers typecheck, unit suites (engine-port fakes, fake-indexeddb
registry), and the production build. The items below need a real browser
and/or live chain and MUST be run before claiming the corresponding ACs:

## Blocked by engine qualification (issue #2 verdict: testnet NO-GO)
- [ ] Create wallet end-to-end against a live endpoint; watch sync progress
      (scanned/target, targetReached) and balances appear. Testnet is blocked
      by the NU7 codec drift in `@zcashlabs/zcash.js@0.1.0-rc.5`; run against
      mainnet (`?network=mainnet`) until the SDK ships NU7 support.
- [ ] Restore from a funded seed and see real balances after scan.
- [ ] View-only import of a UFVK belonging to a funded account: history and
      balances render, Send remains unavailable.

## Zashi cross-check (issue #4 AC)
- [ ] Create in Zashi, restore the same phrase here (and vice versa):
      same account fingerprint and balances at the same birthday height.
      No funded testnet seed available while the NO-GO stands; redo on
      mainnet once the wallet is exposed there.

## Browser surface (can run today)
- [ ] `npm run build && npm run preview` → root page: welcome screen renders,
      zero third-party requests (scripts/smoke.mjs asserts this headlessly).
- [ ] Two tabs on the same wallet: second tab shows the storage-busy screen.
- [ ] Reload persistence: create → reload → boots straight into the wallet.
- [ ] Network toggle: switch testnet↔mainnet; the old client closes, the new
      network's registry row boots.
