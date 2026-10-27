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
- [x] **Testnet create end-to-end (premise flipped 2026-10-27)**: the pinned
      SDK fork selects the NU7 consensus branch at activation, so testnet
      create opens, scans to tip and reaches the wallet screen like mainnet
      (`Wallet synced · up to date`, zero page errors, only the app host +
      `zcash-testnet.chainsafe.dev` contacted). Evidence:
      `.claude/skills/verify/evidence/2026-10-27T10-59-06-777Z-create-wallet`.
- [x] **Funded restore renders real balances on testnet**: restore of the
      funded seed (payout `d9e066d8…f26e7f`, confirmed block 4,539,727,
      1 009 637 zat) at birthday 4 539 720 scanned to tip and rendered
      `0.01009637` ironwood; a same-session reload with the endpoint delayed
      30 s painted the wallet screen (1 041 ms) and that balance (1 054 ms)
      before ANY endpoint response landed — boot serves balances from the
      local DB, sync starts after. Evidence:
      `.claude/skills/verify/evidence/2026-10-27T12-12-34Z-funded-restore-boot-order`.

- [ ] Restore from a funded seed and see real balances after scan (MAINNET
      funds required; also the Zashi cross-check below). Run via the
      operator leg: scripts/restore-viewonly.mjs (see its section). The
      testnet equivalent is green above.
- [ ] View-only import of a UFVK belonging to a funded mainnet account:
      history and balances render, Send remains unavailable, no mint.
      Same operator leg (leg 2 derives the UFVK offline from the phrase).

## Zashi cross-check (issue #4 AC)
- [ ] Create in Zashi, restore the same phrase here (and vice versa):
      same account fingerprint and balances at the same birthday height.
      A funded testnet seed now EXISTS (gitignored `testnet-faucet.local`;
      its restore + balance render is green above) — the cross-check itself
      still needs a Zashi run. Redo on mainnet once the wallet is exposed
      there.

## Browser surface (can run today)
- [x] `npm run build && npm run preview` → root page: welcome screen renders,
      zero third-party requests (scripts/smoke.mjs asserts this headlessly).
- [x] Two tabs on the same wallet: second tab shows the storage-busy screen
      (scripts/live.mjs asserts this against the live build).
- [x] Reload persistence: create → reload → boots straight into the wallet
      (scripts/live.mjs).
- [ ] Network toggle: switch testnet↔mainnet; the old client closes, the new
      network's registry row boots.

## Restore / view-only operator legs (scripts/restore-viewonly.mjs)
The two issue-#4 ACs that need operator secrets, driven through the product
UI in real Chromium (fresh profile per leg). The UFVK for leg 2 is derived
OFFLINE from the same phrase (pure key material — zero network calls):

    ZCASH_MNEMONIC="all 24 words" [ZCASH_PASSPHRASE=…] \
      ZCASH_EXPECT='{"birthdayHeight":N,"balances":{"transparent":"…","sapling":"…","ironwood":"…"}}' \
      node scripts/restore-viewonly.mjs [network]   # against npm run preview

`ZCASH_EXPECT` is the Zashi-side truth for that seed at that birthday — the
cross-check that gates the restore-compat claim (issue #4 AC2). The script
asserts: restore reaches the wallet screen, balances equal Zashi exactly,
the scan floor is ≥ the birthday height, and the view-only import of the
derived UFVK shows the same balances with the View-only chip and no
Send/Unlock affordances. Secrets come only from the environment and never
hit disk or logs.

Rehearsal (harness proof, NOT a compat claim): zero-funds abandon-vector
seed, mainnet, birthday = tip−20 → both legs green end to end on
2026-10-25 (scan floor 3 529 461 ≥ birthday; view-only chip, Send absent,
no Unlock, receive address, zero page errors). This exercises the script —
form fills, selectors, balance/scan assertions — without funds.

- [ ] Funded mainnet seed: both legs green vs Zashi (the required
      cross-check before any restore-compat claim ships).

## Forced backup gate (asserted by scripts/live.mjs on every run)
- [x] While a generated phrase awaits confirmation, the Restore/View-only
      tabs are disabled and the service refuses both paths (`GATE_PENDING`);
      a wrong phrase keeps the gate pending — no dismiss path exists.
      Qualified live on mainnet 2026-10-25 (real engine, wallet screen after
      the correct phrase, zero page errors).
