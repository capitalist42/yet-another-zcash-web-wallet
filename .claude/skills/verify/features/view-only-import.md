# Import a viewing key (view-only)

View-only import registers a Wallet from a Unified Full Viewing Key: the user sees history and balances but gets NO spend authority, and the app never mints from a key that cannot derive shielded spend paths.

## Sub-features

- `vo-invalid` a malformed key is rejected in-form with `.error`, staying on the View-only tab.
- `vo-open` a valid UFVK boots the wallet screen carrying a `View-only` chip.
- `vo-no-spend` instead of a Send button, the screen shows "No spend authority — this Wallet is view-only." (`guardSpend` reason `view-only`).
- `vo-receive` the Receive Address shows the account's current address (the app does not mint when the key lacks spend authority).

## How to get to it (user POV)

- Welcome screen → `View-only` tab → form `[aria-label="view-only import"]`, textarea labeled `Unified Full Viewing Key`, birthday fields, `Import`.
- Welcome state required (no wallet registered on the boot network), same rule as restore.

## Driving it with playwright-core

Preconditions:

- A valid mainnet UFVK belonging to a funded account is an OPERATOR precondition — `docs/manual-verification.md` lists the real-funded check as open; there is no scripted source of mainnet funds. Supply via `ZCASH_VERIFY_UFVK` env. On testnet the pinned NU7 fork can scan, so a `derive-testnet-address.mjs`-style UFVK imports and renders balances.
- Fresh context.

- **Invalid key.** Navigate `<base>/?network=mainnet`, click `View-only`, fill the key textarea with `uitestview...not-a-key`, click `Import`. `.error` renders; still on `[aria-label="view-only import"]`.
- **Valid UFVK.** Fill `ZCASH_VERIFY_UFVK`, choose birthday (full scan, or uncheck + height), click `Import`; race wallet screen vs `.error` (≤240 s). Wallet screen h1 shows name `view-only` + fingerprint chip + `View-only` chip.
- **No spend authority.** Assert NO enabled Send button: either `button "Send" [disabled]` is absent AND the muted line `No spend authority — this Wallet is view-only.` renders. Screenshot as proof.
- **Receive address honest.** `[data-testid="receive-address"]` shows an address (current one — the SDK cannot mint view-only) or an honest state; never an endless `preparing…`.
- **Read-only side effects.** Request log: only lightd + app origin; nothing broadcast (no Send path exists to click — the disabled/absent button is the proof).

Not implemented in run.mjs yet — hand-drive per SKILL.md *Drive* until added.

## Gotchas

- Without `ZCASH_VERIFY_UFVK` the valid-key leg CANNOT pass — report it as a skipped entry point with this unmet precondition, never as verified.
- A viewonly wallet's fingerprint derives from the raw UFVK string; comparing it to the seed wallet's chip (fingerprint of the same account's UFVK) should MATCH when the keys are the same account — useful cross-check when both exist.
- Import then reload boots into view-only again; the second-tab lease collision also applies (same OPFS file).
- On testnet the pinned NU7 fork scans, so import renders live balances like mainnet; a stuck `SYNC_REQUIRED` is a real fault.
